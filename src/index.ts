import { AgentReviewer } from "./agent-reviewer.js";
import { ChatReviewer } from "./chat-reviewer.js";
import { DecisionReviewer } from "./decision-reviewer.js";
import { OversizeFallbackReviewer } from "./fallback-reviewer.js";
import type { PluginDependencies } from "./shared.js";
import { fileUsageRecorder, projectID, usageLogPath } from "./usage.js";
import { createV1Plugin } from "./v1.js";
import { createV2Plugin } from "./v2.js";

const defaultDependencies: PluginDependencies = {
  createReviewer: (input) => {
    const { reviewer } = input.configuration;
    // Reviews in an OpenCode session already count in `opencode stats`; the
    // HTTP backends are logged for this package's `stats`.
    const usage = reviewer.recordUsage
      ? {
          recordUsage: fileUsageRecorder({ path: usageLogPath() }),
          project: projectID({ directory: input.directory }),
        }
      : {};
    const agent = () => new AgentReviewer(input);
    const chat = () => new ChatReviewer({ configuration: input.configuration, ...usage });
    switch (reviewer.backend) {
      case "agent":
        return new OversizeFallbackReviewer({ primary: agent() });
      case "chat":
        return new OversizeFallbackReviewer({ primary: chat() });
      case "decision": {
        const onOversize = reviewer.decision?.onOversize ?? "escalate";
        return new OversizeFallbackReviewer({
          primary: new DecisionReviewer({ configuration: input.configuration, ...usage }),
          ...(onOversize === "agent" ? { fallback: agent() } : {}),
          ...(onOversize === "chat" ? { fallback: chat() } : {}),
        });
      }
    }
  },
};

/**
 * One package, both plugin API generations: opencode 2.x loads the V2
 * `id` + `setup` definition, while opencode 1.18.29+ calls `server()`.
 * `Plugin.define()` from `@opencode/plugin` is an identity function, so the
 * definition is spelled out here to keep the package free of runtime imports.
 */
export function createAutoApprovalPlugin(
  input: {
    dependencies?: Partial<PluginDependencies>;
  } = {},
) {
  const dependencies = { ...defaultDependencies, ...input.dependencies };
  return {
    ...createV2Plugin(dependencies),
    server: createV1Plugin(dependencies),
  };
}

export default createAutoApprovalPlugin();
