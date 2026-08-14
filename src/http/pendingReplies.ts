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

interface PendingEntry {
  resolve: (text: string) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
  deliver?: (text: string) => Promise<void>;
}

/**
 * In-process waiters for Grok Bot agent callbacks keyed by correlationId.
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
      const timer = setTimeout(() => {
        this.pending.delete(correlationId);
        reject(new ReplyTimeoutError(correlationId));
      }, timeoutMs);
      this.pending.set(correlationId, { resolve, reject, timer, deliver });
    });
  }

  async complete(correlationId: string, text: string): Promise<boolean> {
    const entry = this.pending.get(correlationId);
    if (!entry) return false;
    clearTimeout(entry.timer);
    this.pending.delete(correlationId);
    try {
      if (entry.deliver) {
        await entry.deliver(text);
      }
      entry.resolve(text);
    } catch (err) {
      entry.reject(err instanceof Error ? err : new Error(String(err)));
    }
    return true;
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
}
