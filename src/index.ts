import { AgentReviewer } from "./agent-reviewer.js";
import { DecisionReviewer } from "./decision-reviewer.js";
import type { PluginDependencies } from "./shared.js";
import { fileUsageRecorder, projectID, usageLogPath } from "./usage.js";
import { createV1Plugin } from "./v1.js";
import { createV2Plugin } from "./v2.js";

const defaultDependencies: PluginDependencies = {
  createReviewer: (input) =>
    input.configuration.reviewer.backend === "decision"
      ? new DecisionReviewer({
          configuration: input.configuration,
          // Reviews in an opencode session already count in `opencode stats`;
          // decision model calls are logged for this package's `stats`.
          ...(input.configuration.reviewer.recordUsage
            ? {
                recordUsage: fileUsageRecorder({ path: usageLogPath() }),
                project: projectID({ directory: input.directory }),
              }
            : {}),
        })
      : new AgentReviewer(input),
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
