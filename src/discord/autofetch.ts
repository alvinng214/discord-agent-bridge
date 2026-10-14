import { AutofetchStateStore } from "./autofetchState.js";

/** Supervisor-friendly failure (EX_TEMPFAIL). The bash wrapper respawns on nonzero exit. */
export const AUTOFETCH_EXIT_CODE = 75;

export const AUTOFETCH_BATCH_LIMIT = 25;

const TRANSIENT_CODES = new Set([
  "EAI_AGAIN",
  "EAI_NONAME",
  "ENOTFOUND",
  "ECONNRESET",
  "ECONNREFUSED",
  "ECONNABORTED",
  "ETIMEDOUT",
  "EPIPE",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "EPROTO",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_SOCKET",
  "UND_ERR_CONNECT",
]);

export class AutofetchTimeoutError extends Error {
  readonly code = "AUTOFETCH_TIMEOUT";

  constructor(label: string, timeoutMs: number) {
    super(`autofetch ${label} timed out after ${timeoutMs}ms`);
    this.name = "AutofetchTimeoutError";
  }
}

export class AutofetchAbortedError extends Error {
  constructor() {
    super("autofetch tick aborted");
    this.name = "AutofetchAbortedError";
  }
}

/** Discord snowflakes are decimal strings. Longer means newer; same length is lexicographic. */
export function snowflakeGreater(a: string, b: string): boolean {
  if (a.length !== b.length) return a.length > b.length;
  return a > b;
}

export function effectiveAutofetchIntervalMs(configured: number): number {
  if (!Number.isFinite(configured) || configured < 5_000) return 5_000;
  return configured;
}

/**
 * DNS / connect / TLS blips seen on the box (EAI_AGAIN, Connect Timeout, wrong TLS version).
 * HTTP 408/429/5xx are included so a short Discord edge failure uses the same bounded budget.
 * Application 4xx errors are not transient.
 */
export function isTransientDiscordError(err: unknown, seen = new Set<unknown>()): boolean {
  if (err == null || seen.has(err)) return false;
  if (typeof err !== "object") {
    return transientText(String(err));
  }
  seen.add(err);
  const record = err as {
    code?: unknown;
    errno?: unknown;
    status?: unknown;
    message?: unknown;
    cause?: unknown;
    name?: unknown;
  };
  if (record.name === "AutofetchTimeoutError" || record.name === "AutofetchAbortedError") {
    return record.name === "AutofetchTimeoutError";
  }
  if (record.name === "TimeoutError" || record.name === "ConnectTimeoutError") return true;
  const code = typeof record.code === "string" ? record.code : "";
  if (TRANSIENT_CODES.has(code)) return true;
  const errno = typeof record.errno === "string" ? record.errno : "";
  if (TRANSIENT_CODES.has(errno)) return true;
  const status = typeof record.status === "number" ? record.status : undefined;
  if (status === 408 || status === 429 || (status !== undefined && status >= 500 && status <= 599)) {
    return true;
  }
  if (typeof record.message === "string" && transientText(record.message)) return true;
  if (record.cause !== undefined) return isTransientDiscordError(record.cause, seen);
  return false;
}

function transientText(text: string): boolean {
  return /EAI_AGAIN|getaddrinfo|ENOTFOUND|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EPROTO|Connect Timeout|socket hang up|wrong version|timed out after|fetch failed/i.test(
    text,
  );
}

/** Backoff after a failed attempt: 500ms, 1500ms, 4500ms, capped at 8s. */
export function retryDelayMs(failedAttempt: number): number {
  const n = Math.max(1, failedAttempt);
  return Math.min(8_000, 500 * 3 ** (n - 1));
}

export async function withTimeout<T>(work: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  // If the timeout wins the race, a later rejection of `work` must not surface as unhandled.
  const pending = work.then(
    (value) => value,
    (err: unknown) => {
      throw err;
    },
  );
  void pending.catch(() => undefined);
  try {
    return await Promise.race([
      pending,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new AutofetchTimeoutError(label, timeoutMs)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export async function retryTransient<T>(opts: {
  label: string;
  attempts: number;
  timeoutMs: number;
  run: () => Promise<T>;
  sleep: (ms: number) => Promise<void>;
  shouldAbort?: () => boolean;
  onRetry?: (info: { attempt: number; delayMs: number; message: string }) => void;
}): Promise<T> {
  const attempts = Math.max(1, Math.floor(opts.attempts));
  let last: unknown;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    if (opts.shouldAbort?.()) throw new AutofetchAbortedError();
    try {
      return await withTimeout(opts.run(), opts.timeoutMs, opts.label);
    } catch (err) {
      last = err;
      if (err instanceof AutofetchAbortedError) throw err;
      if (opts.shouldAbort?.()) throw new AutofetchAbortedError();
      if (attempt >= attempts || !isTransientDiscordError(err)) throw err;
      const delayMs = retryDelayMs(attempt);
      const message = err instanceof Error ? err.message : String(err);
      opts.onRetry?.({ attempt, delayMs, message });
      await opts.sleep(delayMs);
      if (opts.shouldAbort?.()) throw new AutofetchAbortedError();
    }
  }
  throw last instanceof Error ? last : new Error(String(last));
}

export function decideWatchdog(
  idleMs: number,
  intervalMs: number,
  resets: number,
): "ok" | "reset" | "exit" {
  if (idleMs < intervalMs * 3) return "ok";
  if (resets <= 0) return "reset";
  return "exit";
}

export interface PolledMessage<T> {
  id: string;
  channelId: string;
  authorId: string;
  username: string;
  createdTimestamp: number;
  payload: T;
}

export interface AutofetchSelection<T> {
  deliver: PolledMessage<T>[];
  /** Set when the cursor should move. Undefined when nothing new was considered. */
  nextCursor?: string;
  newestId?: string;
}

/**
 * Choose which fetched messages to hand to the agent.
 * A saved cursor wins over selfFloor so a restart still delivers in-lookback
 * humans and allowed bots that arrived after the last processed id, even when
 * our own later post is newer. selfFloor is only the first-boot fallback, and
 * even then in-lookback allowed-bot messages are delivered.
 */
export function selectAutofetchMessages<T>(input: {
  messages: PolledMessage<T>[];
  selfUserId: string;
  lastProcessedId?: string;
  useSelfFloor: boolean;
  allowedBotIds: ReadonlySet<string>;
  now: number;
  lookbackMs: number;
}): AutofetchSelection<T> {
  const ordered = [...input.messages].sort((a, b) => {
    if (a.id === b.id) return 0;
    return snowflakeGreater(a.id, b.id) ? 1 : -1;
  });
  let selfFloor: string | undefined;
  if (input.useSelfFloor) {
    for (const message of ordered) {
      if (message.authorId === input.selfUserId) selfFloor = message.id;
    }
  }

  const deliver: PolledMessage<T>[] = [];
  let cursor = input.lastProcessedId;
  for (const message of ordered) {
    if (cursor && !snowflakeGreater(message.id, cursor)) continue;
    const fresh = input.now - message.createdTimestamp <= input.lookbackMs;
    if (selfFloor && !snowflakeGreater(message.id, selfFloor)) {
      const recoverUnreadBot =
        fresh &&
        message.authorId !== input.selfUserId &&
        input.allowedBotIds.has(message.authorId);
      if (!recoverUnreadBot) {
        cursor = message.id;
        continue;
      }
    }
    if (!fresh) {
      cursor = message.id;
      continue;
    }
    deliver.push(message);
    cursor = message.id;
  }

  const newestId = ordered.length > 0 ? ordered[ordered.length - 1]!.id : undefined;
  const nextCursor = cursor !== undefined && cursor !== input.lastProcessedId ? cursor : undefined;
  return { deliver, nextCursor, newestId };
}

export interface AutofetchLoopOptions<TChannel, TPayload> {
  channelIds: string[];
  intervalMs: number;
  lookbackMs: number;
  fetchTimeoutMs: number;
  fetchAttempts: number;
  allowedBotIds: readonly string[];
  state: AutofetchStateStore;
  statePath: string;
  userId: () => string | null;
  fetchChannel: (channelId: string) => Promise<TChannel | null>;
  fetchMessages: (channel: TChannel) => Promise<PolledMessage<TPayload>[]>;
  deliver: (message: PolledMessage<TPayload>) => void;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  exit?: (code: number) => void;
  log?: (line: string) => void;
  error?: (line: string) => void;
  bannerSuffix?: string;
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/**
 * One autofetch poller. Each tick logs a heartbeat (`ok` or `skipped: <reason>`).
 * Fetches have their own timeout and a bounded retry on transient Discord errors.
 * If no tick completes within 3× the interval, in-flight state is reset once;
 * if the next window also fails to finish, the process exits nonzero.
 */
export class AutofetchLoop<TChannel, TPayload> {
  private running = false;
  private runningSince = 0;
  private generation = 0;
  private tickNo = 0;
  private lastTickDoneAt: number;
  private watchdogResets = 0;
  private prepared = false;
  private timer: ReturnType<typeof setInterval> | undefined;
  private watch: ReturnType<typeof setInterval> | undefined;
  private readonly allowedBotIds: ReadonlySet<string>;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly exit: (code: number) => void;
  private readonly log: (line: string) => void;
  private readonly error: (line: string) => void;

  constructor(private readonly opts: AutofetchLoopOptions<TChannel, TPayload>) {
    this.allowedBotIds = new Set(opts.allowedBotIds);
    this.now = opts.now ?? (() => Date.now());
    this.sleep = opts.sleep ?? defaultSleep;
    this.exit = opts.exit ?? ((code) => process.exit(code));
    this.log = opts.log ?? ((line) => console.log(line));
    this.error = opts.error ?? ((line) => console.error(line));
    this.lastTickDoneAt = this.now();
    this.runningSince = this.lastTickDoneAt;
  }

  start(): void {
    this.prepare();
    const every = this.opts.intervalMs;
    this.timer = setInterval(() => {
      void this.tick().catch((err) => this.error(`[bridge] tick crashed ${errorText(err)}`));
    }, every);
    this.watch = setInterval(() => {
      void this.checkWatchdog();
    }, every);
    void this.tick().catch((err) => this.error(`[bridge] tick crashed ${errorText(err)}`));
    const suffix = this.opts.bannerSuffix ? ` ${this.opts.bannerSuffix}` : "";
    this.log(
      `[bridge] autofetch every ${every}ms lookback=${this.opts.lookbackMs}ms timeout=${this.opts.fetchTimeoutMs}ms attempts=${this.opts.fetchAttempts} watchdog=${every * 3}ms state=${this.opts.statePath} channels=${this.opts.channelIds.join(",")}${suffix}`,
    );
  }

  stop(): void {
    this.generation += 1;
    this.running = false;
    if (this.timer) clearInterval(this.timer);
    if (this.watch) clearInterval(this.watch);
    this.timer = undefined;
    this.watch = undefined;
  }

  /** Returns the reset tick when one was started, so tests can await it. */
  checkWatchdog(): Promise<void> | undefined {
    const idle = this.now() - this.lastTickDoneAt;
    const decision = decideWatchdog(idle, this.opts.intervalMs, this.watchdogResets);
    if (decision === "ok") return undefined;
    if (decision === "reset") {
      this.watchdogResets = 1;
      this.generation += 1;
      this.running = false;
      this.lastTickDoneAt = this.now();
      this.error(`[bridge] watchdog: no tick completed for ${idle}ms; reset in-flight state`);
      return this.tick().catch((err) => {
        this.error(`[bridge] tick crashed ${errorText(err)}`);
      });
    }
    this.error(
      `[bridge] watchdog: still stuck ${idle}ms after reset; exiting for supervisor respawn`,
    );
    this.exit(AUTOFETCH_EXIT_CODE);
    return undefined;
  }

  async tick(): Promise<void> {
    this.prepare();
    const n = ++this.tickNo;
    if (this.running) {
      this.log(
        `[bridge] heartbeat tick=${n} skipped: previous tick in flight for ${this.now() - this.runningSince}ms`,
      );
      return;
    }
    const userId = this.opts.userId();
    if (!userId) {
      this.log(`[bridge] heartbeat tick=${n} skipped: discord client not ready`);
      this.lastTickDoneAt = this.now();
      return;
    }

    this.running = true;
    this.runningSince = this.now();
    const myGen = this.generation;
    let fresh = 0;
    let errors = 0;
    const parts: string[] = [];

    try {
      for (const id of this.opts.channelIds) {
        if (this.generation !== myGen) return;
        try {
          const channel = await this.attempt(`channels.fetch(${id})`, myGen, () =>
            this.opts.fetchChannel(id),
          );
          if (this.generation !== myGen) return;
          if (!channel) {
            parts.push(`${id}:unavailable`);
            continue;
          }
          const messages = await this.attempt(`messages.fetch(${id})`, myGen, () =>
            this.opts.fetchMessages(channel),
          );
          if (this.generation !== myGen) return;

          const last = this.opts.state.get(id);
          const useSelfFloor = !this.opts.state.has(id);
          if (useSelfFloor && messages.length > 0) {
            this.log(
              `[bridge] autofetch channel=${id} catch-up without saved cursor; selfFloor fallback, delivering in-lookback allowed bots`,
            );
          }
          const selected = selectAutofetchMessages({
            messages,
            selfUserId: userId,
            lastProcessedId: last,
            useSelfFloor,
            allowedBotIds: this.allowedBotIds,
            now: this.now(),
            lookbackMs: this.opts.lookbackMs,
          });
          parts.push(`${id}:newest=${selected.newestId ?? "none"},last=${last ?? "none"}`);
          for (const message of selected.deliver) {
            fresh += 1;
            this.log(
              `[bridge] autofetch channel=${message.channelId} message=${message.id} from=${message.username}`,
            );
            try {
              this.opts.deliver(message);
            } catch (err) {
              errors += 1;
              this.error(`[bridge] autofetch deliver error ${message.id} ${errorText(err)}`);
            }
          }
          if (selected.nextCursor) {
            if (!this.opts.state.set(id, selected.nextCursor)) {
              errors += 1;
              this.error(`[bridge] autofetch state write failed channel=${id}`);
            }
          }
        } catch (err) {
          if (err instanceof AutofetchAbortedError || this.generation !== myGen) return;
          errors += 1;
          parts.push(`${id}:error`);
          this.error(`[bridge] autofetch error channel=${id} ${errorText(err)}`);
        }
      }
    } finally {
      if (myGen !== this.generation) {
        this.log(`[bridge] heartbeat tick=${n} skipped: superseded by watchdog`);
      } else {
        const elapsed = this.now() - this.runningSince;
        this.running = false;
        this.lastTickDoneAt = this.now();
        this.watchdogResets = 0;
        const detail = parts.length > 0 ? ` ${parts.join(" ")}` : "";
        this.log(
          `[bridge] heartbeat tick=${n} ok ${elapsed}ms new=${fresh} errors=${errors}${detail}`,
        );
      }
    }
  }

  private prepare(): void {
    if (this.prepared) return;
    this.prepared = true;
    const loaded = this.opts.state.load();
    if (!loaded.ok) {
      this.error(
        `[bridge] autofetch state ignored (${loaded.reason}); selfFloor fallback until a cursor is saved`,
      );
    }
  }

  private attempt<T>(label: string, myGen: number, run: () => Promise<T>): Promise<T> {
    return retryTransient({
      label,
      attempts: this.opts.fetchAttempts,
      timeoutMs: this.opts.fetchTimeoutMs,
      run,
      sleep: this.sleep,
      shouldAbort: () => this.generation !== myGen,
      onRetry: (info) => {
        this.error(
          `[bridge] autofetch retry ${label} attempt=${info.attempt} in ${info.delayMs}ms: ${info.message}`,
        );
      },
    });
  }
}
