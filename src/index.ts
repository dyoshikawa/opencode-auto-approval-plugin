import type { Plugin, PluginOptions } from "@opencode-ai/plugin";

import { parsePluginConfiguration, type ModelReference } from "./config.js";
import { Reviewer, reviewerAgent, type ReviewSessionClient } from "./reviewer.js";

type PermissionRequest = {
  id: string;
  sessionID: string;
  type: string;
  pattern?: string | string[];
  metadata?: Record<string, unknown>;
};

type AutoApprovalPluginDependencies = {
  createReviewer(input: {
    client: ReviewSessionClient;
    directory: string;
    options: PluginOptions;
  }): Reviewer;
};

const defaultDependencies: AutoApprovalPluginDependencies = {
  createReviewer: (input) =>
    new Reviewer({
      client: input.client,
      directory: input.directory,
      configuration: parsePluginConfiguration(input.options),
    }),
};

// opencode renamed the permission bus event from "permission.updated" to
// "permission.asked" in 1.18.x. Accept both names so the plugin keeps working
// across opencode versions.
const PERMISSION_ASK_EVENT_TYPES = new Set(["permission.updated", "permission.asked"]);

export function createAutoApprovalPlugin(
  input: {
    dependencies?: Partial<AutoApprovalPluginDependencies>;
  } = {},
): Plugin {
  const dependencies = { ...defaultDependencies, ...input.dependencies };

  return async (context, options = {}) => {
    const reviewer = dependencies.createReviewer({
      client: context.client as unknown as ReviewSessionClient,
      directory: context.directory,
      options,
    });
    const configuration = parsePluginConfiguration(options);
    const models = new Map<string, ModelReference>();
    const intents = new Map<string, string>();

    return {
      config: async (config) => {
        config.agent ??= {};
        config.agent["auto-approval-reviewer"] = reviewerAgent();
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

function textFromParts(parts: unknown[]): string {
  return parts
    .flatMap((part) => (isRecord(part) && typeof part.text === "string" ? [part.text] : []))
    .join("\n");
}

function errorMessage(input: unknown): string {
  return input instanceof Error ? input.message : String(input);
}

function isRecord(input: unknown): input is Record<string, unknown> {
  return typeof input === "object" && input !== null;
}

export default createAutoApprovalPlugin();
