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
import { errorMessage } from "./shared.js";

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

export function createV2SessionClient(context: Context): ReviewSessionClient {
  return {
    create: async ({ model }) => {
      const session = await context.session.create({
        title: "Auto-approval review",
        agent: reviewerAgentName,
        ...(model ? { model: toModelRef(model) } : {}),
      });
      return { sessionID: session.id };
    },
    prompt: async ({ sessionID, text }) => {
      await context.session.prompt({ sessionID, text });
      await context.session.wait({ sessionID });
      const messages = await context.session.context({ sessionID });
      return messages
        .flatMap((message) => (message.type === "assistant" ? [message] : []))
        .flatMap((message) => message.content)
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
      const configuration = parsePluginConfiguration(context.options);
      const reviewer = dependencies.createReviewer({
        client: createV2SessionClient(context),
        configuration,
      });
      const intents = new Map<string, string>();

      // `update` on an unknown ID registers a new agent; the branded ID/Name
      // types are plain strings at runtime.
      await context.agent.transform((editor) => {
        editor.update(reviewerAgentName as unknown as Agent.ID, (agent) => {
          agent.name = reviewerAgentName as unknown as Agent.Name;
          agent.description = reviewerAgentDescription;
          agent.system = reviewerAgentPrompt;
          agent.mode = "subagent";
          agent.hidden = true;
          agent.permissions = [
            { action: "*", resource: "*", effect: "deny" },
            ...reviewerAllowedTools.map((tool) => ({
              action: tool,
              resource: "*",
              effect: "allow" as const,
            })),
          ];
        });
      });

      await context.session.hook("prompt", (event) => {
        intents.set(event.sessionID, event.prompt.text);
      });

      const sessionModel = async (sessionID: string): Promise<ModelReference | undefined> => {
        try {
          const session = await context.session.get({ sessionID });
          return fromModelRef(session.model);
        } catch {
          return undefined;
        }
      };

      if (configuration.mode === "on-ask") {
        await context.permission.hook("evaluate", async (event) => {
          if (event.effect !== "ask") return;
          if (reviewer.isReviewerSession({ sessionID: event.sessionID })) return;

          try {
            const decision = await reviewer.review({
              source: "permission-request",
              sessionID: event.sessionID,
              action: event.action,
              resource: { resources: event.resources, metadata: event.metadata },
              userIntent: intents.get(event.sessionID),
              model: await sessionModel(event.sessionID),
            });
            if (decision.verdict !== "allow") return;
            event.effect = "allow";
            event.message = decision.reason;
          } catch {
            // Fail closed: leave the request for the human permission prompt.
          }
        });
        return;
      }

      await context.tool.hook("execute.before", async (event) => {
        if (reviewer.isReviewerSession({ sessionID: event.sessionID })) return;

        let decision;
        try {
          decision = await reviewer.review({
            source: "tool-call",
            sessionID: event.sessionID,
            action: event.tool,
            resource: event.input,
            userIntent: intents.get(event.sessionID),
            model: await sessionModel(event.sessionID),
          });
        } catch (error) {
          throw new Error(
            `Auto-approval reviewer failed; human review is required. ${errorMessage(error)}`,
            { cause: error },
          );
        }

        if (decision.verdict === "allow") return;
        const outcome = decision.verdict === "deny" ? "denied" : "requires human review";
        throw new Error(`Auto-approval reviewer ${outcome}: ${decision.reason}`);
      });
    },
  };
}
