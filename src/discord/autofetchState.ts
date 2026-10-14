import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export interface AutofetchCursorFile {
  version: 1;
  channels: Record<string, string>;
}

export type AutofetchStateLoad =
  | { ok: true }
  | { ok: false; reason: string };

/** One file per bot user id so Grok1–Grok10 can share a working directory. */
export function autofetchStatePath(stateDir: string, botUserId: string): string {
  const safe = botUserId.replace(/[^A-Za-z0-9._-]/g, "_") || "unknown";
  return join(stateDir, `autofetch-state.${safe}.json`);
}

/**
 * Durable last-processed Discord snowflake per channel.
 * Writes are atomic (temp file + rename). A missing file and a corrupt file
 * both start with no cursors. The poller seeds those channels to the newest
 * id and does not replay; a corrupt file is never treated as a backfill.
 */
export class AutofetchStateStore {
  private channels: Record<string, string> = {};
  private loaded = false;

  constructor(private readonly filePath: string) {}

  get path(): string {
    return this.filePath;
  }

  load(): AutofetchStateLoad {
    if (this.loaded) return { ok: true };
    this.loaded = true;
    try {
      const raw = readFileSync(this.filePath, "utf8");
      const parsed: unknown = JSON.parse(raw);
      if (!isCursorFile(parsed)) {
        this.channels = {};
        return { ok: false, reason: `invalid autofetch state file ${this.filePath}` };
      }
      const channels: Record<string, string> = {};
      for (const [key, value] of Object.entries(parsed.channels)) {
        if (key === "__proto__" || key === "constructor" || key === "prototype") continue;
        if (typeof value === "string" && value.trim()) channels[key] = value.trim();
      }
      this.channels = channels;
      return { ok: true };
    } catch (err) {
      this.channels = {};
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "ENOENT") return { ok: true };
      const reason = err instanceof Error ? err.message : String(err);
      return { ok: false, reason };
    }
  }

  has(channelId: string): boolean {
    return Object.prototype.hasOwnProperty.call(this.channels, channelId);
  }

  get(channelId: string): string | undefined {
    return this.channels[channelId];
  }

  /** Remember the cursor in memory and flush it. False when the flush failed. */
  set(channelId: string, messageId: string): boolean {
    this.loaded = true;
    this.channels[channelId] = messageId;
    try {
      this.flush();
      return true;
    } catch {
      return false;
    }
  }

  snapshot(): Record<string, string> {
    return { ...this.channels };
  }

  private flush(): void {
    const body: AutofetchCursorFile = { version: 1, channels: this.channels };
    mkdirSync(dirname(this.filePath), { recursive: true });
    const tmp = `${this.filePath}.${process.pid}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(body)}\n`, "utf8");
    renameSync(tmp, this.filePath);
  }
}

function isCursorFile(value: unknown): value is AutofetchCursorFile {
  if (!value || typeof value !== "object") return false;
  const record = value as { version?: unknown; channels?: unknown };
  return record.version === 1 && !!record.channels && typeof record.channels === "object";
}
