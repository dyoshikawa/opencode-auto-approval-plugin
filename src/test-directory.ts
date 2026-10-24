import { randomUUID } from "node:crypto";
import { mkdirSync, realpathSync } from "node:fs";
import { join } from "node:path";

/**
 * A fresh project directory under ./tmp/tests/projects for a test, symlinks
 * resolved (macOS's tmp dirs are symlinked). The caller removes it.
 */
export function testProjectDirectory(): string {
  const path = join(process.cwd(), "tmp", "tests", "projects", randomUUID());
  mkdirSync(path, { recursive: true });
  return realpathSync(path);
}
