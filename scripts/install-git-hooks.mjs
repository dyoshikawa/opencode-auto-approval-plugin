// Installs the Vite+ pre-commit hook (`vp config`) from `prepare`, but only
// when this package is the root of its own Git checkout.
//
// `prepare` also runs when someone installs the package from Git, and
// `vp config` walks up to the nearest `.git`: run from a copy inside another
// project (for example `node_modules/opencode-auto-approval-plugin`), it would
// point that project's `core.hooksPath` at this package's hooks. Outside a Git
// checkout, or when Git is missing, there is nothing to install.
import { execFileSync, spawnSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

const packageRoot = realpathSync(fileURLToPath(new URL("..", import.meta.url)));

const gitRoot = () => {
  try {
    const output = execFileSync("git", ["rev-parse", "--show-toplevel"], {
      cwd: packageRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    return realpathSync(output.trim());
  } catch {
    return undefined;
  }
};

if (gitRoot() === packageRoot) {
  const result = spawnSync("vp", ["config", "--no-agent"], {
    cwd: packageRoot,
    stdio: "inherit",
    // `vp` is a `.cmd` shim on Windows, which only a shell can run.
    shell: process.platform === "win32",
  });
  process.exitCode = result.status ?? 1;
}
