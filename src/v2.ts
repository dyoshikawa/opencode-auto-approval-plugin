import { createHash } from "node:crypto";

import type { Agent, Plugin } from "@opencode/plugin";

import {
  reviewerAgentDescription,
  reviewerAgentName,
  reviewerAgentPrompt,
  reviewerAllowedTools,
} from "./agent-reviewer.js";
import type { ModelReference } from "./config.js";
import { usesAgentReviewer, parsePluginConfiguration } from "./config.js";
import { conversationFromMessages, readConversation } from "./conversation.js";
import type { ReviewSessionClient } from "./reviewer.js";
import {
  createIntentTracker,
  createRootSessionResolver,
  parentIdentifier,
} from "./session-root.js";
import type { PluginDependencies } from "./shared.js";
import { reviewForApproval, reviewToolCallOrThrow } from "./shared.js";

/**
 * V2 plugin API (opencode 2.x, `@opencode/plugin`): a `setup(context)` entrypoint
 * that registers domain hooks. Permission requests are intercepted through the
 * `permission.evaluate` hook instead of the bus event, so an `allow` verdict
 * is returned in place rather than posted back through the SDK.
 */

const pluginID = "opencode-auto-approval-plugin";

type Context = Plugin.Context;

/** One reviewed invocation, not a session-wide or agent-wide approval. */
function grantKey(input: { sessionID: string; messageID: string; id: string }): string {
  return JSON.stringify([input.sessionID, input.messageID, input.id]);
}

function inputDigest(input: unknown): string {
  return createHash("sha256").update(JSON.stringify(input) ?? "undefined").digest("hex");
}

/** V2 model references use `id`; the plugin configuration keeps V1's `modelID`. */
function toModelRef(model: ModelReference): { providerID: string; id: string } {
  return { providerID: model.providerID, id: model.modelID };
}

function fromModelRef(
  model: { providerID: string; id: string } | undefined,
): ModelReference | undefined {
  return model ? { providerID: model.providerID, modelID: model.id } : undefined;
}

/** Everything denied except the read-only tools; last matching rule wins. */
const reviewerPermissions = [
  { action: "*", resource: "*", effect: "deny" as const },
  ...reviewerAllowedTools.map((tool) => ({
    action: tool,
    resource: "*",
    effect: "allow" as const,
  })),
];

export function createV2SessionClient(context: Context): ReviewSessionClient {
  return {
    create: async ({ model }) => {
      const session = await context.session.create({
        title: "Auto-approval review",
        agent: reviewerAgentName,
        // Repeated on the session so the agent staying read-only does not
        // depend on nothing else redefining it.
        permissions: [...reviewerPermissions],
        ...(model ? { model: toModelRef(model) } : {}),
      });
      return { sessionID: session.id };
    },
    prompt: async ({ sessionID, text }) => {
      await context.session.prompt({ sessionID, text });
      await context.session.wait({ sessionID });
      const messages = await context.session.context({ sessionID });
      // Only the final reply is the verdict; earlier turns may have explained
      // a tool call and would confuse the JSON extraction.
      const reply = messages.findLast((message) => message.type === "assistant");
      if (reply?.error) {
        throw new Error(`Reviewer session failed: ${reply.error.message}`);
      }
      return (reply?.content ?? [])
        .flatMap((part) => (part.type === "text" ? [part.text] : []))
        .join("\n");
    },
    abort: ({ sessionID }) => context.session.interrupt({ sessionID }),
  };
}

export function createV2Plugin(dependencies: PluginDependencies): Plugin.Plugin {
  return {
    id: pluginID,
    setup: async (context) => {
      const configuration = parsePluginConfiguration({ options: context.options });
      const reviewer = dependencies.createReviewer({
        client: createV2SessionClient(context),
        configuration,
        directory: context.location.directory,
      });
      const intents = new Map<string, string>();
      const conversation = (sessionID: string) =>
        readConversation({
          configuration: configuration.conversation,
          latest: () => intents.get(sessionID),
          load: async () =>
            conversationFromMessages({
              messages: await context.session.context({ sessionID }),
              generation: "v2",
              sessionID,
              includeAssistant: configuration.conversation.includeAssistant,
            }),
        });
      // Subagent (child) sessions are prompted by the parent agent, not by the
      // person, so the person's intent is read from the root session.
      const tracker = createIntentTracker({
        rootSession: createRootSessionResolver(async (sessionID) =>
          parentIdentifier(await context.session.get({ sessionID })),
        ),
        conversation,
        conversationEnabled: configuration.conversation.enabled,
      });

      // `update` on an unknown ID registers a new agent; the branded ID/Name
      // types are plain strings at runtime. Only the agent reviewer needs one,
      // as the backend or as the decision backend's oversize fallback.
      if (usesAgentReviewer(configuration)) {
        await context.agent.transform((editor) => {
          editor.update(reviewerAgentName as unknown as Agent.ID, (agent) => {
            agent.name = reviewerAgentName as unknown as Agent.Name;
            agent.description = reviewerAgentDescription;
            agent.system = reviewerAgentPrompt;
            agent.mode = "subagent";
            agent.hidden = true;
            agent.permissions = [...reviewerPermissions];
          });
        });
      }

      // Both the session ID and the agent name identify the reviewer: the ID
      // is forgotten the moment a review ends, while an interrupted reviewer
      // session may still be winding down under its agent. The name only
      // counts when this plugin defined that agent as read-only; with a decision model an
      // agent of that name is someone else's and must be reviewed.
      const isReviewer = (event: { sessionID: string; agent?: string }): boolean =>
        (usesAgentReviewer(configuration) && event.agent === reviewerAgentName) ||
        reviewer.isReviewerSession({ sessionID: event.sessionID });

      await context.session.hook("prompt", (event) => {
        if (reviewer.isReviewerSession({ sessionID: event.sessionID })) return;
        if (event.metadata?.synthetic || event.metadata?.ignored) return;
        intents.set(event.sessionID, event.prompt.text);
        tracker.prompted(event.sessionID);
      });

      const sessionModel = async (sessionID: string): Promise<ModelReference | undefined> => {
        // Only the agent reviewer uses the session's model.
        if (!usesAgentReviewer(configuration)) return undefined;
        try {
          const session = await context.session.get({ sessionID });
          return fromModelRef(session.model);
        } catch {
          return undefined;
        }
      };

      if (configuration.mode === "on-ask") {
        await context.permission.hook("evaluate", async (event) => {
          if (event.effect !== "ask" || isReviewer(event)) return;

          const intent = await tracker.begin(event.sessionID);
          const decision = await reviewForApproval({
            reviewer,
            request: {
              source: "permission-request",
              sessionID: event.sessionID,
              action: event.action,
              resource: { resources: event.resources, metadata: event.metadata },
              ...(await intent.context()),
              model: await sessionModel(event.sessionID),
            },
          });
          if (decision === undefined || intent.changed()) return;
          event.effect = "allow";
          event.message = decision.reason;
        });
        return;
      }

      // Opt-in only. By default a native "ask" remains a mandatory human checkpoint.
      // V1 has no matching permission bridge and intentionally keeps its old semantics.
      const nativeGrants = new Map<
        string,
        {
          agent: string;
          tool: string;
          inputDigest: string;
          intent: Awaited<ReturnType<typeof tracker.begin>>;
          expiresAt: number;
        }
      >();
      const grantLifetimeMs = 45_000;

      if (configuration.allToolsNativeAsks === "review") {
        await context.permission.hook("evaluate", async (event) => {
          if (event.effect !== "ask" || event.source?.type !== "tool" || isReviewer(event)) return;
          const key = grantKey({
            sessionID: event.sessionID,
            messageID: event.source.messageID,
            id: event.source.id,
          });
          const grant = nativeGrants.get(key);
          if (!grant || grant.agent !== event.agent) return;
          if (Date.now() >= grant.expiresAt || grant.intent.changed()) {
            nativeGrants.delete(key);
            return;
          }

          if (event.action === grant.tool) {
            // The reviewer examined this tool's input. An unrelated permission
            // action cannot inherit this grant, even with the same call ID.
            event.effect = "allow";
            event.message = "Approved by auto-review for this tool invocation.";
            return;
          }

          // Resolve extra native asks separately using their ACTUAL resources.
          // Especially important for external_directory, where symlinks may
          // resolve outside the path visible in the reviewed tool input.
          const decision = await reviewForApproval({
            reviewer,
            request: {
              source: "permission-request",
              sessionID: event.sessionID,
              action: event.action,
              resource: { resources: event.resources, metadata: event.metadata },
              ...(await grant.intent.context()),
              model: await sessionModel(event.sessionID),
            },
          });
          if (grant.intent.changed()) {
            nativeGrants.delete(key);
            return;
          }
          if (decision === undefined) {
            // Fail closed on deny, escalate or reviewer failures, without
            // surprising the user with an interactive native prompt.
            event.effect = "deny";
            event.message = "Additional native permission was not approved by auto-review.";
            return;
          }
          event.effect = "allow";
          event.message = decision.reason;
        });

        await context.tool.hook("execute.after", (event) => {
          const key = grantKey(event);
          const grant = nativeGrants.get(key);
          nativeGrants.delete(key);
          // Other execute.before hooks may run after ours and change input.
          // This detects such mutations but cannot undo an already run tool.
          if (grant && grant.inputDigest !== inputDigest(event.input)) {
            throw new Error("Tool input changed after auto-review approval.");
          }
        });
      }

      await context.tool.hook("execute.before", async (event) => {
        if (isReviewer(event)) return;

        const key = grantKey(event);
        nativeGrants.delete(key);
        for (const [pending, grant] of nativeGrants) {
          if (Date.now() >= grant.expiresAt) nativeGrants.delete(pending);
        }
        const intent = await tracker.begin(event.sessionID);
        await reviewToolCallOrThrow({
          reviewer,
          request: {
            source: "tool-call",
            sessionID: event.sessionID,
            action: event.tool,
            resource: event.input,
            ...(await intent.context()),
            model: await sessionModel(event.sessionID),
          },
        });
        if (intent.changed()) {
          throw new Error("User intent changed during review; human review is required.");
        }
        if (configuration.allToolsNativeAsks === "review") {
          nativeGrants.set(key, {
            agent: event.agent,
            tool: event.tool,
            inputDigest: inputDigest(event.input),
            intent,
            expiresAt: Date.now() + grantLifetimeMs,
          });
        }
      });
    },
  };
}
