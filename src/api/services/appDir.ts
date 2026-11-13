/**
 * Where the app keeps its local files (Dealabs session, `config/*.json`,
 * `data/agents`). On Bay the process starts in the release folder, which
 * a new deploy replaces: the folder that stays is `APP_FILES_DIR` on the
 * older process-based Bay, `DATA_DIR` (the instance's mounted data folder,
 * beside `app.db`) on the container-based Bay. Locally it is the project
 * root.
 */
export function appDir(): string {
  return process.env.APP_FILES_DIR || process.env.DATA_DIR || process.cwd();
}
