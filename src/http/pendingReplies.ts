export class ReplyTimeoutError extends Error {
  readonly correlationId: string;

  constructor(correlationId: string) {
    super("Grok Bot timed out waiting for a reply. Try again shortly.");
    this.name = "ReplyTimeoutError";
    this.correlationId = correlationId;
  }
}

export class AgentCallbackError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AgentCallbackError";
  }
}

export type CompleteResult = "missing" | "ok" | "delivery_failed";

interface PendingEntry {
  resolve: (text: string) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
  deadlineMs: number;
  deliver?: (text: string) => Promise<void>;
  delivering: boolean;
}

/**
 * In-process waiters for Grok Bot agent callbacks keyed by correlationId.
 * Entries stay registered until Discord delivery succeeds (or the waiter times out / is failed).
 */
export class PendingReplyStore {
  private readonly pending = new Map<string, PendingEntry>();

  register(
    correlationId: string,
    timeoutMs: number,
    deliver?: (text: string) => Promise<void>,
  ): Promise<string> {
    if (this.pending.has(correlationId)) {
      return Promise.reject(new Error("Duplicate correlationId"));
    }

    return new Promise<string>((resolve, reject) => {
      const entry = {
        resolve,
        reject,
        deadlineMs: Date.now() + timeoutMs,
        deliver,
        delivering: false,
      } as PendingEntry;
      this.pending.set(correlationId, entry);
      this.armTimeout(correlationId, entry);
    });
  }

  async complete(correlationId: string, text: string): Promise<CompleteResult> {
    const entry = this.pending.get(correlationId);
    if (!entry) return "missing";
    if (entry.delivering) return "delivery_failed";

    entry.delivering = true;
    clearTimeout(entry.timer);

    try {
      if (entry.deliver) {
        await entry.deliver(text);
      }
      this.pending.delete(correlationId);
      entry.resolve(text);
      return "ok";
    } catch {
      entry.delivering = false;
      if (!this.pending.has(correlationId)) {
        return "missing";
      }
      this.armTimeout(correlationId, entry);
      return "delivery_failed";
    }
  }

  fail(correlationId: string, error: Error): boolean {
    const entry = this.pending.get(correlationId);
    if (!entry) return false;
    clearTimeout(entry.timer);
    this.pending.delete(correlationId);
    entry.reject(error);
    return true;
  }

  has(correlationId: string): boolean {
    return this.pending.has(correlationId);
  }

  get size(): number {
    return this.pending.size;
  }

  private armTimeout(correlationId: string, entry: PendingEntry): void {
    const remaining = entry.deadlineMs - Date.now();
    if (remaining <= 0) {
      this.pending.delete(correlationId);
      entry.reject(new ReplyTimeoutError(correlationId));
      return;
    }
    entry.timer = setTimeout(() => {
      this.pending.delete(correlationId);
      entry.reject(new ReplyTimeoutError(correlationId));
    }, remaining);
  }
}
