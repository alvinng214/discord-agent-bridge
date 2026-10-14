import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AUTOFETCH_EXIT_CODE,
  AutofetchLoop,
  decideWatchdog,
  isTransientDiscordError,
  retryDelayMs,
  selectAutofetchMessages,
  snowflakeGreater,
  type PolledMessage,
} from "./autofetch.js";
import { autofetchStatePath, AutofetchStateStore } from "./autofetchState.js";

const NOW = 1_700_000_000_000;

function msg(
  overrides: Partial<PolledMessage<string>> & Pick<PolledMessage<string>, "id" | "authorId">,
): PolledMessage<string> {
  return {
    channelId: "c1",
    username: overrides.authorId,
    createdTimestamp: NOW - 1_000,
    payload: overrides.id,
    ...overrides,
  };
}

describe("snowflakeGreater", () => {
  it("compares equal-length and shorter snowflakes", () => {
    expect(snowflakeGreater("100", "099")).toBe(true);
    expect(snowflakeGreater("99", "100")).toBe(false);
    expect(snowflakeGreater("100", "100")).toBe(false);
  });
});

describe("transient Discord errors", () => {
  it("recognizes DNS, connect timeout, TLS, and nested causes", () => {
    const dns = Object.assign(new Error("getaddrinfo EAI_AGAIN discord.com"), { code: "EAI_AGAIN" });
    expect(isTransientDiscordError(dns)).toBe(true);
    expect(isTransientDiscordError(new Error("Connect Timeout Error (discord.com:443, 10000ms)"))).toBe(
      true,
    );
    expect(isTransientDiscordError(new Error("tls: wrong version number"))).toBe(true);
    expect(isTransientDiscordError({ message: "fetch failed", cause: dns })).toBe(true);
  });

  it("does not retry ordinary Discord 4xx errors", () => {
    expect(isTransientDiscordError({ status: 403, message: "Missing Access", code: 50001 })).toBe(
      false,
    );
    expect(isTransientDiscordError({ status: 404, message: "Unknown Channel" })).toBe(false);
  });

  it("retries edge failures and our own fetch timeout", () => {
    expect(isTransientDiscordError({ status: 503, message: "upstream" })).toBe(true);
    expect(isTransientDiscordError({ name: "AutofetchTimeoutError", message: "timed out after 10ms" })).toBe(
      true,
    );
  });
});

describe("decideWatchdog", () => {
  it("resets once past 3 intervals, then exits", () => {
    expect(decideWatchdog(2_999, 1_000, 0)).toBe("ok");
    expect(decideWatchdog(3_000, 1_000, 0)).toBe("reset");
    expect(decideWatchdog(3_000, 1_000, 1)).toBe("exit");
  });
});

describe("retryDelayMs", () => {
  it("backs off and caps", () => {
    expect(retryDelayMs(1)).toBe(500);
    expect(retryDelayMs(2)).toBe(1_500);
    expect(retryDelayMs(3)).toBe(4_500);
    expect(retryDelayMs(4)).toBe(8_000);
  });
});

describe("selectAutofetchMessages", () => {
  const allowed = new Set(["gpt"]);

  it("uses selfFloor on first boot but still delivers in-lookback allowed bots", () => {
    const selected = selectAutofetchMessages({
      messages: [
        msg({ id: "150", authorId: "human" }),
        msg({ id: "160", authorId: "gpt" }),
        msg({ id: "170", authorId: "other-bot" }),
        msg({ id: "180", authorId: "self" }),
        msg({ id: "190", authorId: "human" }),
      ],
      selfUserId: "self",
      useSelfFloor: true,
      allowedBotIds: allowed,
      now: NOW,
      lookbackMs: 60_000,
    });
    expect(selected.deliver.map((m) => m.id)).toEqual(["160", "190"]);
    expect(selected.nextCursor).toBe("190");
  });

  it("does not recover an allowed bot older than lookback", () => {
    const selected = selectAutofetchMessages({
      messages: [
        msg({ id: "160", authorId: "gpt", createdTimestamp: NOW - 120_000 }),
        msg({ id: "180", authorId: "self" }),
      ],
      selfUserId: "self",
      useSelfFloor: true,
      allowedBotIds: allowed,
      now: NOW,
      lookbackMs: 60_000,
    });
    expect(selected.deliver).toEqual([]);
    expect(selected.nextCursor).toBe("180");
  });

  it("with a saved cursor, delivers humans and bots even when a newer self post exists", () => {
    const selected = selectAutofetchMessages({
      messages: [
        msg({ id: "100", authorId: "human" }),
        msg({ id: "150", authorId: "human" }),
        msg({ id: "160", authorId: "gpt" }),
        msg({ id: "180", authorId: "self" }),
      ],
      selfUserId: "self",
      lastProcessedId: "100",
      useSelfFloor: false,
      allowedBotIds: allowed,
      now: NOW,
      lookbackMs: 60_000,
    });
    expect(selected.deliver.map((m) => m.id)).toEqual(["150", "160", "180"]);
    expect(selected.nextCursor).toBe("180");
  });

  it("advances the cursor past stale messages without delivering them", () => {
    const selected = selectAutofetchMessages({
      messages: [msg({ id: "150", authorId: "human", createdTimestamp: NOW - 120_000 })],
      selfUserId: "self",
      lastProcessedId: "100",
      useSelfFloor: false,
      allowedBotIds: allowed,
      now: NOW,
      lookbackMs: 60_000,
    });
    expect(selected.deliver).toEqual([]);
    expect(selected.nextCursor).toBe("150");
  });
});

describe("AutofetchStateStore", () => {
  const dirs: string[] = [];

  afterEach(() => {
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
    dirs.length = 0;
  });

  function tempDir(): string {
    const dir = mkdtempSync(join(tmpdir(), "autofetch-state-"));
    dirs.push(dir);
    return dir;
  }

  it("round-trips cursors per bot user id", () => {
    const dir = tempDir();
    const first = new AutofetchStateStore(autofetchStatePath(dir, "bot/1"));
    expect(first.load().ok).toBe(true);
    expect(first.has("c1")).toBe(false);
    expect(first.set("c1", "190")).toBe(true);

    const reloaded = new AutofetchStateStore(autofetchStatePath(dir, "bot/1"));
    expect(reloaded.load().ok).toBe(true);
    expect(reloaded.get("c1")).toBe("190");

    const other = new AutofetchStateStore(autofetchStatePath(dir, "bot2"));
    expect(other.load().ok).toBe(true);
    expect(other.has("c1")).toBe(false);
    expect(autofetchStatePath(dir, "bot/1")).not.toBe(autofetchStatePath(dir, "bot2"));
  });

  it("ignores a corrupt file so the bridge can boot", () => {
    const dir = tempDir();
    const path = autofetchStatePath(dir, "bot1");
    writeFileSync(path, "{not json", "utf8");
    const store = new AutofetchStateStore(path);
    const loaded = store.load();
    expect(loaded.ok).toBe(false);
    expect(store.has("c1")).toBe(false);
    expect(store.set("c1", "5")).toBe(true);
    const again = new AutofetchStateStore(path);
    expect(again.load().ok).toBe(true);
    expect(again.get("c1")).toBe("5");
  });
});

describe("AutofetchLoop", () => {
  const dirs: string[] = [];
  const stops: Array<() => void> = [];

  afterEach(() => {
    for (const stop of stops) stop();
    stops.length = 0;
    vi.clearAllTimers();
    vi.useRealTimers();
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
    dirs.length = 0;
  });

  interface Harness {
    loop: AutofetchLoop<{ id: string }, string>;
    logs: string[];
    errors: string[];
    exits: number[];
    delivered: string[];
    state: AutofetchStateStore;
    advance: (ms: number) => void;
  }

  function harness(overrides: {
    messages?: PolledMessage<string>[];
    fetchChannel?: () => Promise<{ id: string } | null>;
    fetchAttempts?: number;
    fetchTimeoutMs?: number;
    userId?: () => string | null;
    sleep?: (ms: number) => Promise<void>;
    channelIds?: string[];
  } = {}): Harness {
    const dir = mkdtempSync(join(tmpdir(), "autofetch-loop-"));
    dirs.push(dir);
    const state = new AutofetchStateStore(autofetchStatePath(dir, "bot1"));
    const logs: string[] = [];
    const errors: string[] = [];
    const exits: number[] = [];
    const delivered: string[] = [];
    let clock = NOW;
    const messages = overrides.messages ?? [];
    const loop = new AutofetchLoop<{ id: string }, string>({
      channelIds: overrides.channelIds ?? ["c1"],
      intervalMs: 1_000,
      lookbackMs: 60_000,
      fetchTimeoutMs: overrides.fetchTimeoutMs ?? 5_000,
      fetchAttempts: overrides.fetchAttempts ?? 3,
      allowedBotIds: ["gpt"],
      state,
      statePath: state.path,
      userId: overrides.userId ?? (() => "self"),
      fetchChannel: overrides.fetchChannel ?? (async () => ({ id: "c1" })),
      fetchMessages: async () => messages,
      deliver: (message) => {
        delivered.push(message.id);
      },
      now: () => clock,
      sleep: overrides.sleep ?? (async () => undefined),
      exit: (code) => {
        exits.push(code);
      },
      log: (line) => logs.push(line),
      error: (line) => errors.push(line),
    });
    stops.push(() => loop.stop());
    return {
      loop,
      logs,
      errors,
      exits,
      delivered,
      state,
      advance: (ms) => {
        clock += ms;
      },
    };
  }

  it("logs an ok heartbeat and persists the cursor", async () => {
    const h = harness({
      messages: [
        msg({ id: "150", authorId: "human" }),
        msg({ id: "160", authorId: "gpt" }),
        msg({ id: "180", authorId: "self" }),
      ],
    });
    await h.loop.tick();
    expect(h.delivered).toEqual(["160"]);
    expect(h.state.get("c1")).toBe("180");
    expect(h.logs.some((line) => /heartbeat tick=1 ok /.test(line) && line.includes("errors=0"))).toBe(
      true,
    );
  });

  it("uses the saved cursor across a new process instead of selfFloor", async () => {
    const first = harness({
      messages: [
        msg({ id: "150", authorId: "human" }),
        msg({ id: "180", authorId: "self" }),
      ],
    });
    await first.loop.tick();
    expect(first.delivered).toEqual([]);
    expect(first.state.get("c1")).toBe("180");

    const second = harness({
      messages: [
        msg({ id: "150", authorId: "human" }),
        msg({ id: "170", authorId: "human" }),
        msg({ id: "180", authorId: "self" }),
        msg({ id: "200", authorId: "self" }),
      ],
    });
    // Same directory is a new store; copy the cursor file by reusing the first path.
    const reloaded = new AutofetchStateStore(first.state.path);
    expect(reloaded.load().ok).toBe(true);
    expect(reloaded.get("c1")).toBe("180");

    const dirMessages = [
      msg({ id: "150", authorId: "human" }),
      msg({ id: "190", authorId: "human" }),
      msg({ id: "200", authorId: "self" }),
    ];
    const restarted = new AutofetchLoop<{ id: string }, string>({
      channelIds: ["c1"],
      intervalMs: 1_000,
      lookbackMs: 60_000,
      fetchTimeoutMs: 5_000,
      fetchAttempts: 1,
      allowedBotIds: ["gpt"],
      state: reloaded,
      statePath: reloaded.path,
      userId: () => "self",
      fetchChannel: async () => ({ id: "c1" }),
      fetchMessages: async () => dirMessages,
      deliver: (message) => second.delivered.push(message.id),
      now: () => NOW,
      sleep: async () => undefined,
      exit: () => undefined,
      log: (line) => second.logs.push(line),
      error: (line) => second.errors.push(line),
    });
    stops.push(() => restarted.stop());
    await restarted.tick();
    expect(second.delivered).toEqual(["190", "200"]);
    expect(reloaded.get("c1")).toBe("200");
  });

  it("retries transient DNS errors with backoff, then delivers", async () => {
    const delays: number[] = [];
    let calls = 0;
    const h = harness({
      messages: [msg({ id: "300", authorId: "human" })],
      fetchAttempts: 3,
      sleep: async (ms) => {
        delays.push(ms);
      },
      fetchChannel: async () => {
        calls += 1;
        if (calls < 3) {
          throw Object.assign(new Error("getaddrinfo EAI_AGAIN discord.com"), { code: "EAI_AGAIN" });
        }
        return { id: "c1" };
      },
    });
    await h.loop.tick();
    expect(calls).toBe(3);
    expect(delays).toEqual([500, 1_500]);
    expect(h.delivered).toEqual(["300"]);
    expect(h.errors.filter((line) => line.includes("autofetch retry"))).toHaveLength(2);
    expect(h.logs.some((line) => line.includes("heartbeat tick=1 ok") && line.includes("errors=0"))).toBe(
      true,
    );
  });

  it("does not retry a non-transient Discord error", async () => {
    let calls = 0;
    const h = harness({
      fetchAttempts: 3,
      fetchChannel: async () => {
        calls += 1;
        throw Object.assign(new Error("Missing Access"), { status: 403, code: 50001 });
      },
    });
    await h.loop.tick();
    expect(calls).toBe(1);
    expect(h.delivered).toEqual([]);
    expect(h.state.has("c1")).toBe(false);
    expect(h.logs.some((line) => line.includes("heartbeat tick=1 ok") && line.includes("errors=1"))).toBe(
      true,
    );
  });

  it("times out a hung fetch and tries again", async () => {
    let calls = 0;
    const h = harness({
      fetchTimeoutMs: 20,
      fetchAttempts: 2,
      messages: [msg({ id: "300", authorId: "human" })],
      fetchChannel: () => {
        calls += 1;
        if (calls === 1) return new Promise(() => undefined);
        return Promise.resolve({ id: "c1" });
      },
    });
    await h.loop.tick();
    expect(calls).toBe(2);
    expect(h.delivered).toEqual(["300"]);
    expect(h.errors.some((line) => line.includes("timed out after 20ms"))).toBe(true);
  });

  it("logs skipped while a tick is in flight and does not treat that as progress", async () => {
    let release: (channel: { id: string }) => void = () => undefined;
    const gate = new Promise<{ id: string }>((resolve) => {
      release = resolve;
    });
    const h = harness({ fetchChannel: () => gate });
    const first = h.loop.tick();
    await h.loop.tick();
    expect(h.logs.some((line) => line.includes("skipped: previous tick in flight"))).toBe(true);
    release({ id: "c1" });
    await first;
    expect(h.logs.some((line) => line.includes("heartbeat tick=1 ok"))).toBe(true);
  });

  it("logs skipped when the Discord session is down", async () => {
    const h = harness({ userId: () => null });
    await h.loop.tick();
    expect(h.logs.some((line) => line.includes("skipped: discord client not ready"))).toBe(true);
  });

  it("resets a stuck tick once, then exits if the next window also stalls", async () => {
    vi.useFakeTimers();
    const h = harness({
      fetchTimeoutMs: 60_000,
      fetchChannel: () => new Promise(() => undefined),
    });
    void h.loop.tick();
    await Promise.resolve();
    expect(h.logs.some((line) => line.includes("skipped: previous tick in flight"))).toBe(false);
    await h.loop.tick();
    expect(h.logs.some((line) => line.includes("skipped: previous tick in flight"))).toBe(true);

    h.advance(3_000);
    const resetTick = h.loop.checkWatchdog();
    expect(h.exits).toEqual([]);
    expect(h.errors.some((line) => line.includes("reset in-flight state"))).toBe(true);

    h.advance(3_000);
    h.loop.checkWatchdog();
    expect(h.exits).toEqual([AUTOFETCH_EXIT_CODE]);
    expect(h.errors.some((line) => line.includes("exiting for supervisor respawn"))).toBe(true);
    void resetTick;
  });

  it("clears the watchdog strike after a tick completes", async () => {
    vi.useFakeTimers();
    let hang = true;
    const h = harness({
      fetchTimeoutMs: 60_000,
      fetchChannel: () => (hang ? new Promise(() => undefined) : Promise.resolve({ id: "c1" })),
    });
    void h.loop.tick();
    await Promise.resolve();
    h.advance(3_000);
    hang = false;
    await h.loop.checkWatchdog();
    expect(h.exits).toEqual([]);
    expect(h.logs.some((line) => line.includes(" ok "))).toBe(true);

    hang = true;
    void h.loop.tick();
    await Promise.resolve();
    h.advance(3_000);
    h.loop.checkWatchdog();
    expect(h.exits).toEqual([]);
    expect(h.errors.filter((line) => line.includes("reset in-flight state"))).toHaveLength(2);

    h.advance(3_000);
    h.loop.checkWatchdog();
    expect(h.exits).toEqual([AUTOFETCH_EXIT_CODE]);
  });

  it("keeps going when one channel fails and still cursors the other", async () => {
    let channelCalls = 0;
    const h = harness({
      channelIds: ["bad", "c1"],
      messages: [msg({ id: "300", authorId: "human", channelId: "c1" })],
      fetchAttempts: 1,
      fetchChannel: async (/* id inferred */) => {
        channelCalls += 1;
        if (channelCalls === 1) {
          throw Object.assign(new Error("getaddrinfo EAI_AGAIN discord.com"), { code: "EAI_AGAIN" });
        }
        return { id: "c1" };
      },
    });
    await h.loop.tick();
    expect(h.state.has("bad")).toBe(false);
    expect(h.state.get("c1")).toBe("300");
    expect(h.delivered).toEqual(["300"]);
    expect(h.logs.some((line) => line.includes("errors=1") && line.includes("bad:error"))).toBe(true);
  });

  it("marks a missing channel unavailable without retrying", async () => {
    let calls = 0;
    const h = harness({
      fetchChannel: async () => {
        calls += 1;
        return null;
      },
    });
    await h.loop.tick();
    expect(calls).toBe(1);
    expect(h.logs.some((line) => line.includes("c1:unavailable") && line.includes("errors=0"))).toBe(true);
  });
});
