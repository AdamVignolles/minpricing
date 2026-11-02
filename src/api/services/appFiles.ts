/**
 * Which files under `appDir()` are the app's own state, kept in SQLite by
 * `AppFilesService`. Left out on purpose: the Dealabs session and every
 * hidden file or folder (a secret, browser profiles, `HOME`), SQLite files
 * (backed up as databases already), and anything over `MAX_KEPT_BYTES`.
 */
export const KEPT_ROOTS = ["config", "data/agents", "docs"] as const;

export const PAUSE_FILE = ".publish-pause.json";

export const MAX_KEPT_BYTES = 5 * 1024 * 1024;

const DATABASE = /\.(db|sqlite3?)(-wal|-shm|-journal)?$/i;

export function isKeptFile(path: string): boolean {
  if (path === PAUSE_FILE) return true;
  const parts = path.split("/");
  if (parts.some((part) => !part || part.startsWith(".") || part === "..")) {
    return false;
  }
  if (DATABASE.test(path)) return false;
  if (parts[0] === "config") return parts.length === 2;
  if (parts[0] === "docs") {
    return parts.length === 2 && parts[1].endsWith("-changelog.md");
  }
  return parts[0] === "data" && parts[1] === "agents" && parts.length > 2;
}
