/**
 * Where the app keeps its local files (Dealabs session, `config/*.json`,
 * `data/agents`). On Bay the process starts in the release folder, which
 * a new deploy replaces: Bay's `APP_FILES_DIR` is the folder that stays.
 * Locally it is the project root.
 */
export function appDir(): string {
  return process.env.APP_FILES_DIR || process.cwd();
}
