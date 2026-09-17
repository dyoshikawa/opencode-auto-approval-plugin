import type { Plugin } from "@opencode-ai/plugin";

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
import { errorMessage, isRecord, textFromParts } from "./shared.js";

/**
 * V1 plugin API (opencode 1.x, `@opencode-ai/plugin`): a `server()` entrypoint
 * that returns a hooks object and talks to opencode through the SDK client.
 */

type PermissionRequest = {
  id: string;
  sessionID: string;
  type: string;
  pattern?: string | string[];
  metadata?: Record<string, unknown>;
};

// opencode renamed the permission bus event from "permission.updated" to
// "permission.asked" in 1.18.x. Accept both names so the plugin keeps working
// across opencode versions.
const PERMISSION_ASK_EVENT_TYPES = new Set(["permission.updated", "permission.asked"]);

const reviewerTools = Object.fromEntries(reviewerAllowedTools.map((tool) => [tool, true]));

type SdkClient = {
  session: {
    create(input: { query: { directory: string } }): Promise<unknown>;
    prompt(input: {
      path: { id: string };
      query: { directory: string };
      body: {
        agent: string;
        model?: ModelReference;
        parts: Array<{ type: "text"; text: string }>;
        tools: Record<string, boolean>;
      };
    }): Promise<unknown>;
    abort?(input: { path: { id: string }; query: { directory: string } }): Promise<unknown>;
  };
};

export function createV1SessionClient(input: {
  client: SdkClient;
  directory: string;
}): ReviewSessionClient {
  const query = { directory: input.directory };
  return {
    create: async () => {
      const session = await input.client.session.create({ query });
      return { sessionID: sessionIdentifier(session) };
    },
    prompt: async ({ sessionID, model, text }) => {
      const response = await input.client.session.prompt({
        path: { id: sessionID },
        query,
        body: {
          agent: reviewerAgentName,
          ...(model ? { model } : {}),
          parts: [{ type: "text", text }],
          tools: reviewerTools,
        },
      });
      return responseText(response);
    },
    abort: ({ sessionID }) =>
      input.client.session.abort?.({ path: { id: sessionID }, query }) ?? Promise.resolve(),
  };
}

export function reviewerAgentConfig(): Record<string, unknown> {
  return {
    description: reviewerAgentDescription,
    mode: "subagent",
    prompt: reviewerAgentPrompt,
    tools: reviewerTools,
    permission: {
      "*": "deny",
      ...Object.fromEntries(reviewerAllowedTools.map((tool) => [tool, "allow"])),
      edit: "deny",
      bash: "deny",
      task: "deny",
      skill: "deny",
      webfetch: "deny",
      websearch: "deny",
      question: "deny",
      external_directory: "deny",
    },
  };
}

export function createV1Plugin(dependencies: PluginDependencies): Plugin {
  return async (context, options = {}) => {
    const configuration = parsePluginConfiguration(options);
    const reviewer = dependencies.createReviewer({
      client: createV1SessionClient({
        client: context.client as unknown as SdkClient,
        directory: context.directory,
      }),
      configuration,
    });
    const models = new Map<string, ModelReference>();
    const intents = new Map<string, string>();

    return {
      config: async (config) => {
        config.agent ??= {};
        config.agent[reviewerAgentName] = reviewerAgentConfig();
      },
      "chat.message": (event, output) => {
        if (event.model) models.set(event.sessionID, event.model);
        intents.set(event.sessionID, textFromParts(output.parts));
        return Promise.resolve();
      },
      "chat.params": (event) => {
        models.set(event.sessionID, {
          providerID: event.model.providerID,
          modelID: event.model.id,
        });
        return Promise.resolve();
      },
      event: async ({ event }) => {
        if (configuration.mode !== "on-ask" || !PERMISSION_ASK_EVENT_TYPES.has(event.type)) return;

        const request = event.properties as PermissionRequest;
        if (reviewer.isReviewerSession({ sessionID: request.sessionID })) return;

        try {
          const decision = await reviewer.review({
            source: "permission-request",
            sessionID: request.sessionID,
            action: request.type,
            resource: { pattern: request.pattern, metadata: request.metadata },
            userIntent: intents.get(request.sessionID),
            model: models.get(request.sessionID),
          });
          if (decision.verdict !== "allow") return;
          await context.client.postSessionIdPermissionsPermissionId({
            path: { id: request.sessionID, permissionID: request.id },
            query: { directory: context.directory },
            body: { response: "once" },
          });
        } catch {
          // Fail closed: preserve the original human permission prompt.
        }
      },
      "tool.execute.before": async (event, output) => {
        if (
          configuration.mode !== "all-tools" ||
          reviewer.isReviewerSession({ sessionID: event.sessionID })
        )
          return;

        let decision;
        try {
          decision = await reviewer.review({
            source: "tool-call",
            sessionID: event.sessionID,
            action: event.tool,
            resource: output.args,
            userIntent: intents.get(event.sessionID),
            model: models.get(event.sessionID),
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
      },
    };
  };
}

function sessionIdentifier(input: unknown): string {
  if (isRecord(input) && typeof input.id === "string") return input.id;
  if (isRecord(input) && isRecord(input.data) && typeof input.data.id === "string") {
    return input.data.id;
  }
  throw new Error("OpenCode SDK did not return a reviewer session ID.");
}

function responseText(input: unknown): string {
  const response = isRecord(input) && "data" in input ? input.data : input;
  if (!isRecord(response) || !Array.isArray(response.parts)) {
    throw new Error("OpenCode SDK did not return reviewer message parts.");
  }
  return textFromParts(response.parts);
}
