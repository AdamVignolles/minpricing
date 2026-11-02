import { z } from "alepha";
import { $entity, db } from "alepha/orm";

import { MAX_KEPT_BYTES } from "../services/appFiles.ts";

/**
 * The app's own files under `appDir()` (agent configs, their changelogs,
 * `data/agents` reports and logs, the publish pause), kept in SQLite so
 * that the database alone — what Bay backs up to S3 — is enough to bring
 * the app back. `AppFilesService` keeps the two in step; the files stay
 * the working copy the code and the agents' scripts read.
 */
export const appFileEntity = $entity({
  name: "app_files",
  schema: z.object({
    /** Relative to `appDir()`, with forward slashes. */
    id: db.primaryKey(z.text({ maxLength: 300 })),
    /** Exactly as on disk: not trimmed (a `.jsonl` ends with a newline). */
    content: z.text({ maxLength: MAX_KEPT_BYTES, trim: false }),
    size: z.number().int().min(0),
    /** The file's modification time (ms) when it was stored. */
    mtimeMs: z.number().int().min(0),
    updatedAt: db.updatedAt(),
  }),
});
