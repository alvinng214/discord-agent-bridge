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

/** Do not sleep longer than this on a single 429, even if retry_after is huge. */
export const RATE_LIMIT_WAIT_CAP_MS = 60_000;

/**
 * Discord HTTP bodies use `retry_after` in seconds. `@discordjs/rest` RateLimitError
 * uses `retryAfter` in milliseconds. Prefer the millisecond field when both are set.
 */
export function rateLimitDelayMs(err: unknown): number | undefined {
  if (!err || typeof err !== "object") return undefined;
  const record = err as {
    retryAfter?: unknown;
    retry_after?: unknown;
    rawError?: { retry_after?: unknown };
    data?: { retry_after?: unknown };
  };
  if (typeof record.retryAfter === "number" && Number.isFinite(record.retryAfter) && record.retryAfter > 0) {
    return Math.min(RATE_LIMIT_WAIT_CAP_MS, Math.ceil(record.retryAfter));
  }
  const seconds = [record.retry_after, record.rawError?.retry_after, record.data?.retry_after].find(
    (value): value is number => typeof value === "number" && Number.isFinite(value) && value > 0,
  );
  if (seconds === undefined) return undefined;
  return Math.min(RATE_LIMIT_WAIT_CAP_MS, Math.ceil(seconds * 1000));
}

/**
 * Bound how long we wait for `work`. `abort` runs if the timer wins.
 *
 * discord.js 14.16 does not forward an AbortSignal on the calls autofetch makes:
 * `ChannelManager.fetch` only accepts `{ allowUnknownGuild, cache, force }` and
 * `MessageManager._fetchMany` only forwards query options. Both call `rest.get`
 * without a signal, even though `@discordjs/rest` RequestData supports one.
 * Passing an AbortController here would not cancel those sockets, so the Discord
 * adapter does not pass `abort`. The race still unblocks the poll; the underlying
 * request runs until Discord or undici finishes.
 */
export async function withTimeout<T>(
  work: Promise<T>,
  timeoutMs: number,
  label: string,
  abort?: () => void,
): Promise<T> {
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
        timer = setTimeout(() => {
          try {
            abort?.();
          } catch {
            // Abort is best-effort; the timeout still rejects the wait.
          }
          reject(new AutofetchTimeoutError(label, timeoutMs));
        }, timeoutMs);
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
  /** Fired before each fetch attempt and before each backoff sleep. */
  onWait?: (kind: "fetch" | "sleep", waitMs: number) => void;
}): Promise<T> {
  const attempts = Math.max(1, Math.floor(opts.attempts));
  let last: unknown;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    if (opts.shouldAbort?.()) throw new AutofetchAbortedError();
    opts.onWait?.("fetch", opts.timeoutMs);
    try {
      return await withTimeout(opts.run(), opts.timeoutMs, opts.label);
    } catch (err) {
      last = err;
      if (err instanceof AutofetchAbortedError) throw err;
      if (opts.shouldAbort?.()) throw new AutofetchAbortedError();
      if (attempt >= attempts || !isTransientDiscordError(err)) throw err;
      const delayMs = rateLimitDelayMs(err) ?? retryDelayMs(attempt);
      const message = err instanceof Error ? err.message : String(err);
      opts.onRetry?.({ attempt, delayMs, message });
      opts.onWait?.("sleep", delayMs);
      await opts.sleep(delayMs);
      if (opts.shouldAbort?.()) throw new AutofetchAbortedError();
    }
  }
  throw last instanceof Error ? last : new Error(String(last));
}

/**
 * Extra time past an in-flight fetch timeout or retry sleep before that wait
 * counts as a hang. Transient errors that settle inside this window are progress.
 */
export const WATCHDOG_SLACK_MS = 1_000;

/**
 * Exit only when a fetch or retry sleep is in flight and has not reported
 * progress within its own budget. A finished timeout, DNS error, or 429 wait
 * is progress, so a multi-channel outage cannot trip this by simply being slow.
 */
export function decideWatchdog(input: {
  inFlight: boolean;
  idleMs: number;
  graceMs: number;
  resets: number;
}): "ok" | "reset" | "exit" {
  if (!input.inFlight) return "ok";
  if (input.idleMs <= input.graceMs) return "ok";
  if (input.resets <= 0) return "reset";
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
  /**
   * The fetched page is full and its oldest id is still newer than the cursor,
   * so messages between the cursor and that page were not returned.
   */
  gap: boolean;
}

/**
 * Choose which fetched messages to hand to the agent.
 * With no saved cursor, the default (`seedOnly`) pins the cursor to the newest
 * id and delivers nothing. Opt-in backfill (`seedOnly: false` and no cursor)
 * hands off in-lookback messages except our own posts. A saved cursor delivers
 * anything newer than that id inside the lookback, including messages that sit
 * before a newer post of our own.
 */
export function selectAutofetchMessages<T>(input: {
  messages: PolledMessage<T>[];
  selfUserId: string;
  lastProcessedId?: string;
  seedOnly: boolean;
  now: number;
  lookbackMs: number;
  batchLimit?: number;
}): AutofetchSelection<T> {
  const ordered = [...input.messages].sort((a, b) => {
    if (a.id === b.id) return 0;
    return snowflakeGreater(a.id, b.id) ? 1 : -1;
  });
  const newestId = ordered.length > 0 ? ordered[ordered.length - 1]!.id : undefined;
  const oldestId = ordered.length > 0 ? ordered[0]!.id : undefined;
  const batchLimit = input.batchLimit ?? AUTOFETCH_BATCH_LIMIT;
  const gap = Boolean(
    input.lastProcessedId &&
      ordered.length >= batchLimit &&
      oldestId &&
      snowflakeGreater(oldestId, input.lastProcessedId),
  );

  if (!input.lastProcessedId && input.seedOnly) {
    return { deliver: [], nextCursor: newestId, newestId, gap: false };
  }

  const deliver: PolledMessage<T>[] = [];
  let cursor = input.lastProcessedId;
  const backfill = !input.lastProcessedId;
  for (const message of ordered) {
    if (cursor && !snowflakeGreater(message.id, cursor)) continue;
    const fresh = input.now - message.createdTimestamp <= input.lookbackMs;
    const skipOwnPost = backfill && message.authorId === input.selfUserId;
    if (fresh && !skipOwnPost) deliver.push(message);
    cursor = message.id;
  }

  const nextCursor = cursor !== undefined && cursor !== input.lastProcessedId ? cursor : undefined;
  return { deliver, nextCursor, newestId, gap };
}

export interface AutofetchLoopOptions<TChannel, TPayload> {
  channelIds: string[];
  intervalMs: number;
  lookbackMs: number;
  fetchTimeoutMs: number;
  fetchAttempts: number;
  /** When false (default), a channel with no cursor is seeded and not replayed. */
  backfill?: boolean;
  /** Log clean ok heartbeats on tick 1, every N ticks, and whenever the outcome changes. */
  heartbeatEvery?: number;
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
 * One autofetch poller.
 * Clean heartbeats log on the first tick, every `heartbeatEvery` ticks, and
 * whenever the outcome changes. Skipped ticks and ticks with errors always log.
 * Delivery is at-most-once: the cursor advances when a message is handed to the
 * handler, not when the agent finishes.
 * The watchdog exits only when an in-flight fetch or retry sleep outlives its
 * own budget. Transient Discord errors are progress and never exit the process.
 */
export class AutofetchLoop<TChannel, TPayload> {
  private running = false;
  private runningSince = 0;
  private generation = 0;
  private tickNo = 0;
  private inFlight = false;
  private lastProgressAt: number;
  private graceMs = 0;
  private watchdogResets = 0;
  private prepared = false;
  /** Corrupt state: seed every channel and do not backfill, even if backfill is on. */
  private forceSeed = false;
  private lastHeartbeatSignature: string | undefined;
  private readonly seededLogged = new Set<string>();
  private readonly gapLogged = new Set<string>();
  private timer: ReturnType<typeof setInterval> | undefined;
  private watch: ReturnType<typeof setInterval> | undefined;
  private readonly backfill: boolean;
  private readonly heartbeatEvery: number;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly exit: (code: number) => void;
  private readonly log: (line: string) => void;
  private readonly error: (line: string) => void;

  constructor(private readonly opts: AutofetchLoopOptions<TChannel, TPayload>) {
    this.backfill = opts.backfill ?? false;
    this.heartbeatEvery = Math.max(1, Math.floor(opts.heartbeatEvery ?? 20));
    this.now = opts.now ?? (() => Date.now());
    this.sleep = opts.sleep ?? defaultSleep;
    this.exit = opts.exit ?? ((code) => process.exit(code));
    this.log = opts.log ?? ((line) => console.log(line));
    this.error = opts.error ?? ((line) => console.error(line));
    this.lastProgressAt = this.now();
    this.runningSince = this.lastProgressAt;
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
      `[bridge] autofetch every ${every}ms lookback=${this.opts.lookbackMs}ms timeout=${this.opts.fetchTimeoutMs}ms attempts=${this.opts.fetchAttempts} backfill=${this.backfill} heartbeatEvery=${this.heartbeatEvery} watchdog=hang-only state=${this.opts.statePath} channels=${this.opts.channelIds.join(",")}${suffix}`,
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
    const idle = this.now() - this.lastProgressAt;
    const decision = decideWatchdog({
      inFlight: this.inFlight && this.running,
      idleMs: idle,
      graceMs: this.graceMs,
      resets: this.watchdogResets,
    });
    if (decision === "ok") return undefined;
    if (decision === "reset") {
      this.watchdogResets = 1;
      this.generation += 1;
      this.running = false;
      this.inFlight = false;
      this.error(
        `[bridge] watchdog: in-flight fetch made no progress for ${idle}ms; reset in-flight state`,
      );
      return this.tick().catch((err) => {
        this.error(`[bridge] tick crashed ${errorText(err)}`);
      });
    }
    this.error(
      `[bridge] watchdog: still hung ${idle}ms after reset; exiting for supervisor respawn`,
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
          const seedOnly = !this.opts.state.has(id) && (this.forceSeed || !this.backfill);
          const selected = selectAutofetchMessages({
            messages,
            selfUserId: userId,
            lastProcessedId: last,
            seedOnly,
            now: this.now(),
            lookbackMs: this.opts.lookbackMs,
          });
          if (seedOnly && selected.nextCursor && !this.seededLogged.has(id)) {
            this.seededLogged.add(id);
            this.log(
              `[bridge] autofetch channel=${id} seeded cursor=${selected.nextCursor} (no backfill; delivering nothing)`,
            );
          }
          if (!seedOnly && !last && messages.length > 0) {
            this.log(
              `[bridge] autofetch channel=${id} backfill delivering in-lookback messages`,
            );
          }
          if (selected.gap && last && !this.gapLogged.has(`${id}:${last}`)) {
            this.gapLogged.add(`${id}:${last}`);
            this.error(
              `[bridge] autofetch channel=${id} gap exceeds ${AUTOFETCH_BATCH_LIMIT} messages since cursor ${last}; messages between the cursor and the fetched page were not seen`,
            );
          }
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
          // At-most-once: persist at hand-off. handleMessage is not awaited, so a
          // crash during agent generation will not fetch this message again.
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
        this.inFlight = false;
        this.watchdogResets = 0;
        const detail = parts.length > 0 ? ` ${parts.join(" ")}` : "";
        this.logHeartbeat(n, errors, fresh, elapsed, detail);
      }
    }
  }

  private logHeartbeat(tickNo: number, errors: number, fresh: number, elapsed: number, detail: string): void {
    const status = errors > 0 ? "error" : "ok";
    const signature = `${status}|${fresh}|${detail}`;
    const changed = signature !== this.lastHeartbeatSignature;
    this.lastHeartbeatSignature = signature;
    const every = this.heartbeatEvery;
    if (status === "error" || changed || tickNo === 1 || tickNo % every === 0) {
      this.log(
        `[bridge] heartbeat tick=${tickNo} ${status} ${elapsed}ms new=${fresh} errors=${errors}${detail}`,
      );
    }
  }

  private prepare(): void {
    if (this.prepared) return;
    this.prepared = true;
    const loaded = this.opts.state.load();
    if (!loaded.ok) {
      this.forceSeed = true;
      this.error(
        `[bridge] autofetch state ignored (${loaded.reason}); seeding cursors and not replaying`,
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
      onWait: (kind, waitMs) => {
        this.inFlight = true;
        this.lastProgressAt = this.now();
        this.graceMs = waitMs + WATCHDOG_SLACK_MS;
        void kind;
      },
      onRetry: (info) => {
        this.error(
          `[bridge] autofetch retry ${label} attempt=${info.attempt} in ${info.delayMs}ms: ${info.message}`,
        );
      },
    });
  }
}
