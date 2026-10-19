import type { Plugin } from "@opencode-ai/plugin";

import {
  reviewerAgentDescription,
  reviewerAgentName,
  reviewerAgentPrompt,
  reviewerAllowedTools,
} from "./agent-reviewer.js";
import type { ModelReference } from "./config.js";
import { usesAgentReviewer, parsePluginConfiguration } from "./config.js";
import {
  conversationFromMessages,
  HISTORY_MESSAGE_LIMIT,
  readConversation,
} from "./conversation.js";
import type { ReviewSessionClient } from "./reviewer.js";
import { createRootSessionResolver, unknownRootContext } from "./session-root.js";
import type { PluginDependencies } from "./shared.js";
import { isRecord, reviewForApproval, reviewToolCallOrThrow, textFromParts } from "./shared.js";

/**
 * V1 plugin API (opencode 1.x, `@opencode-ai/plugin`): a `server()` entrypoint
 * that returns a hooks object and talks to opencode through the SDK client.
 */

type PermissionRequest = {
  id: string;
  sessionID: string;
  permission?: unknown;
  patterns?: string[];
  type?: unknown;
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
    get?(input: { path: { id: string }; query: { directory: string } }): Promise<unknown>;
    messages?(input: {
      path: { id: string };
      query: { directory: string; limit: number };
    }): Promise<unknown>;
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
  // The V1 SDK picks the model per prompt, so remember the session's choice.
  const models = new Map<string, ModelReference>();
  return {
    create: async ({ model }) => {
      const session = await input.client.session.create({ query });
      const sessionID = sessionIdentifier(session);
      if (model) models.set(sessionID, model);
      return { sessionID };
    },
    prompt: async ({ sessionID, text }) => {
      const model = models.get(sessionID);
      models.delete(sessionID);
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
    abort: ({ sessionID }) => {
      models.delete(sessionID);
      return input.client.session.abort?.({ path: { id: sessionID }, query }) ?? Promise.resolve();
    },
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
    const configuration = parsePluginConfiguration({ options });
    const reviewer = dependencies.createReviewer({
      client: createV1SessionClient({
        client: context.client as unknown as SdkClient,
        directory: context.directory,
      }),
      configuration,
      directory: context.directory,
    });
    const models = new Map<string, ModelReference>();
    const intents = new Map<string, string>();
    const revisions = new Map<string, number>();
    const conversation = (sessionID: string) =>
      readConversation({
        configuration: configuration.conversation,
        latest: () => intents.get(sessionID),
        load: async () => {
          const client = context.client as unknown as SdkClient;
          if (!client.session?.messages) throw new Error("Session history is unavailable.");
          return conversationFromMessages({
            messages: await client.session.messages({
              path: { id: sessionID },
              query: { directory: context.directory, limit: HISTORY_MESSAGE_LIMIT },
            }),
            generation: "v1",
            sessionID,
            includeAssistant: configuration.conversation.includeAssistant,
          });
        },
      });
    // Subagent (child) sessions are prompted by the parent agent, not by the
    // person, so the person's intent is read from the root session.
    const rootSession = createRootSessionResolver(async (sessionID) => {
      const client = context.client as unknown as SdkClient;
      if (!client.session?.get) throw new Error("Session lookup is unavailable.");
      return parentIdentifier(
        await client.session.get({
          path: { id: sessionID },
          query: { directory: context.directory },
        }),
      );
    });
    const reviewContext = async (sessionID: string) => {
      const root = await rootSession(sessionID);
      if (root === undefined) {
        return {
          revision: () => revisions.get(sessionID),
          context: async () => unknownRootContext(configuration.conversation.enabled),
        };
      }
      return { revision: () => revisions.get(root), context: () => conversation(root) };
    };

    return {
      config: async (config) => {
        // Only the agent reviewer, as the backend or the decision backend's
        // oversize fallback, needs the reviewer agent.
        if (!usesAgentReviewer(configuration)) return;
        config.agent ??= {};
        config.agent[reviewerAgentName] = reviewerAgentConfig();
      },
      "chat.message": (event, output) => {
        // The reviewer's own prompts carry no user intent worth keeping.
        if (reviewer.isReviewerSession({ sessionID: event.sessionID })) return Promise.resolve();
        if (event.model) models.set(event.sessionID, event.model);
        intents.set(
          event.sessionID,
          textFromParts({ parts: output.parts, skipSyntheticOrIgnored: true }),
        );
        revisions.set(event.sessionID, (revisions.get(event.sessionID) ?? 0) + 1);
        return Promise.resolve();
      },
      "chat.params": (event) => {
        if (reviewer.isReviewerSession({ sessionID: event.sessionID })) return Promise.resolve();
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
        // A malformed modern action must not fall back to an unrelated legacy action.
        const action = request.permission !== undefined ? request.permission : request.type;
        if (typeof action !== "string" || action.trim().length === 0) return;

        const intent = await reviewContext(request.sessionID);
        const revision = intent.revision();
        const decision = await reviewForApproval({
          reviewer,
          request: {
            source: "permission-request",
            sessionID: request.sessionID,
            action,
            resource: { pattern: request.patterns ?? request.pattern, metadata: request.metadata },
            ...(await intent.context()),
            model: models.get(request.sessionID),
          },
        });
        if (decision === undefined || intent.revision() !== revision) return;

        try {
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

        const intent = await reviewContext(event.sessionID);
        const revision = intent.revision();
        await reviewToolCallOrThrow({
          reviewer,
          request: {
            source: "tool-call",
            sessionID: event.sessionID,
            action: event.tool,
            resource: output.args,
            ...(await intent.context()),
            model: models.get(event.sessionID),
          },
        });
        if (intent.revision() !== revision) {
          throw new Error("User intent changed during review; human review is required.");
        }
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

/** The session's `parentID`, or `undefined` for a root session. */
function parentIdentifier(input: unknown): string | undefined {
  const session = isRecord(input) && isRecord(input.data) ? input.data : input;
  if (!isRecord(session) || typeof session.id !== "string") {
    throw new Error("OpenCode SDK did not return the session.");
  }
  if (session.parentID === undefined || session.parentID === null) return undefined;
  if (typeof session.parentID !== "string") throw new Error("Session parentID is malformed.");
  return session.parentID;
}

function responseText(input: unknown): string {
  const response = isRecord(input) && "data" in input ? input.data : input;
  if (!isRecord(response) || !Array.isArray(response.parts)) {
    throw new Error("OpenCode SDK did not return reviewer message parts.");
  }
  return textFromParts({ parts: response.parts });
}
