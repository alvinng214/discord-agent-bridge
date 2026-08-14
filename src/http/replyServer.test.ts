import { afterEach, describe, expect, it } from "vitest";
import { PendingReplyStore, ReplyTimeoutError } from "./pendingReplies.js";
import { startReplyServer, type StartedReplyServer } from "./replyServer.js";

const TOKEN = "test-reply-token";

async function listen(
  pending: PendingReplyStore,
  replyToken: string | null = TOKEN,
): Promise<StartedReplyServer> {
  return startReplyServer({
    host: "127.0.0.1",
    port: 0,
    replyToken,
    pending,
  });
}

async function postReply(
  server: StartedReplyServer,
  opts: {
    token?: string | null;
    body?: unknown;
    raw?: string;
    headers?: Record<string, string>;
  } = {},
): Promise<{ status: number; json: Record<string, unknown> }> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...opts.headers,
  };
  if (opts.token !== null) {
    headers.Authorization = `Bearer ${opts.token ?? TOKEN}`;
  }
  const res = await fetch(`http://127.0.0.1:${server.port}/internal/reply`, {
    method: "POST",
    headers,
    body: opts.raw ?? JSON.stringify(opts.body ?? {}),
  });
  return { status: res.status, json: (await res.json()) as Record<string, unknown> };
}

describe("POST /internal/reply", () => {
  const servers: StartedReplyServer[] = [];

  afterEach(async () => {
    while (servers.length > 0) {
      const server = servers.pop();
      await server?.close();
    }
  });

  it("returns 401 when the bearer token is missing", async () => {
    const pending = new PendingReplyStore();
    const server = await listen(pending);
    servers.push(server);

    const res = await postReply(server, { token: null, body: { correlationId: "c", text: "hi" } });
    expect(res.status).toBe(401);
    expect(res.json.error).toBe("unauthorized");
  });

  it("returns 401 when the bearer token is wrong", async () => {
    const pending = new PendingReplyStore();
    const server = await listen(pending);
    servers.push(server);

    const res = await postReply(server, {
      token: "wrong-token",
      body: { correlationId: "c", text: "hi" },
    });
    expect(res.status).toBe(401);
    expect(res.json.error).toBe("unauthorized");
  });

  it("returns 401 when the server token is unset (fail closed)", async () => {
    const pending = new PendingReplyStore();
    const server = await listen(pending, null);
    servers.push(server);

    const res = await postReply(server, {
      token: "anything",
      body: { correlationId: "c", text: "hi" },
    });
    expect(res.status).toBe(401);
  });

  it("returns 400 when required fields are missing", async () => {
    const pending = new PendingReplyStore();
    const server = await listen(pending);
    servers.push(server);

    const missingId = await postReply(server, { body: { text: "hi" } });
    expect(missingId.status).toBe(400);

    const missingText = await postReply(server, { body: { correlationId: "c1" } });
    expect(missingText.status).toBe(400);

    const empty = await postReply(server, { body: { correlationId: "  ", text: "  " } });
    expect(empty.status).toBe(400);
  });

  it("returns 404 for an unknown correlationId", async () => {
    const pending = new PendingReplyStore();
    const server = await listen(pending);
    servers.push(server);

    const res = await postReply(server, {
      body: { correlationId: "missing", text: "hello" },
    });
    expect(res.status).toBe(404);
    expect(res.json.error).toBe("unknown_correlation_id");
  });

  it("returns 404 for an expired correlationId", async () => {
    const pending = new PendingReplyStore();
    const server = await listen(pending);
    servers.push(server);

    const waiter = pending.register("expired", 20);
    await expect(waiter).rejects.toBeInstanceOf(ReplyTimeoutError);

    const res = await postReply(server, {
      body: { correlationId: "expired", text: "too late" },
    });
    expect(res.status).toBe(404);
  });

  it("resolves a pending generate waiter on a valid reply", async () => {
    const pending = new PendingReplyStore();
    const server = await listen(pending);
    servers.push(server);

    const waiter = pending.register("corr-1", 5_000);
    const res = await postReply(server, {
      body: { correlationId: "corr-1", text: "Pots are in houses and trader inventories." },
    });

    expect(res.status).toBe(200);
    expect(res.json.ok).toBe(true);
    await expect(waiter).resolves.toBe("Pots are in houses and trader inventories.");
    expect(pending.has("corr-1")).toBe(false);
  });

  it("keeps the pending entry when Discord delivery fails so a later retry can complete", async () => {
    const pending = new PendingReplyStore();
    const server = await listen(pending);
    servers.push(server);

    let attempts = 0;
    const waiter = pending.register("corr-retry", 5_000, async () => {
      attempts += 1;
      if (attempts === 1) throw new Error("discord 502");
    });

    const first = await postReply(server, {
      body: { correlationId: "corr-retry", text: "hello from Discord" },
    });
    expect(first.status).toBe(503);
    expect(first.json.error).toBe("delivery_failed");
    expect(pending.has("corr-retry")).toBe(true);

    let settled = false;
    void waiter.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(settled).toBe(false);

    const second = await postReply(server, {
      body: { correlationId: "corr-retry", text: "hello from Discord" },
    });
    expect(second.status).toBe(200);
    expect(second.json.ok).toBe(true);
    await expect(waiter).resolves.toBe("hello from Discord");
    expect(attempts).toBe(2);
    expect(pending.has("corr-retry")).toBe(false);
  });
});
