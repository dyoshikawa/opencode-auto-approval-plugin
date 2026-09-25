import type { Agent, Plugin } from "@opencode/plugin";

import type { ModelReference } from "./config.js";
import { parsePluginConfiguration } from "./config.js";
import type { ReviewSessionClient } from "./reviewer.js";
import {
  reviewerAgentDescription,
  reviewerAgentName,
  reviewerAgentPrompt,
  reviewerAllowedTools,
} from "./reviewer.js";
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
      });
      const intents = new Map<string, string>();

      // `update` on an unknown ID registers a new agent; the branded ID/Name
      // types are plain strings at runtime. The Jev backend needs no agent.
      if (configuration.reviewer.backend === "opencode") {
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
      // counts when this plugin defined that agent as read-only; under Jev an
      // agent of that name is someone else's and must be reviewed.
      const isReviewer = (event: { sessionID: string; agent?: string }): boolean =>
        (configuration.reviewer.backend === "opencode" && event.agent === reviewerAgentName) ||
        reviewer.isReviewerSession({ sessionID: event.sessionID });

      await context.session.hook("prompt", (event) => {
        if (reviewer.isReviewerSession({ sessionID: event.sessionID })) return;
        intents.set(event.sessionID, event.prompt.text);
      });

      const sessionModel = async (sessionID: string): Promise<ModelReference | undefined> => {
        // Only the opencode backend reviews with the session's model.
        if (configuration.reviewer.backend !== "opencode") return undefined;
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

          const decision = await reviewForApproval({
            reviewer,
            request: {
              source: "permission-request",
              sessionID: event.sessionID,
              action: event.action,
              resource: { resources: event.resources, metadata: event.metadata },
              userIntent: intents.get(event.sessionID),
              model: await sessionModel(event.sessionID),
            },
          });
          if (decision === undefined) return;
          event.effect = "allow";
          event.message = decision.reason;
        });
        return;
      }

      await context.tool.hook("execute.before", async (event) => {
        if (isReviewer(event)) return;

        await reviewToolCallOrThrow({
          reviewer,
          request: {
            source: "tool-call",
            sessionID: event.sessionID,
            action: event.tool,
            resource: event.input,
            userIntent: intents.get(event.sessionID),
            model: await sessionModel(event.sessionID),
          },
        });
      });
    },
  };
}
