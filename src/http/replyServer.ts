import { createHash, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { AgentCallbackError, type PendingReplyStore } from "./pendingReplies.js";

export interface ReplyServerOptions {
  host: string;
  port: number;
  /** Fail closed when unset or empty — every request is 401. */
  replyToken: string | null;
  pending: PendingReplyStore;
}

export interface StartedReplyServer {
  host: string;
  port: number;
  close(): Promise<void>;
}

const MAX_BODY_BYTES = 1_000_000;

interface ReplyBody {
  correlationId?: unknown;
  text?: unknown;
  error?: unknown;
}

function sendJson(res: ServerResponse, status: number, body: Record<string, unknown>): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(payload),
  });
  res.end(payload);
}

function headerValue(req: IncomingMessage, name: string): string | undefined {
  const raw = req.headers[name];
  if (Array.isArray(raw)) return raw[0];
  return raw;
}

function extractBearer(header: string | undefined): string | null {
  if (!header) return null;
  const match = header.match(/^Bearer\s+(\S+)\s*$/i);
  return match?.[1] ?? null;
}

function tokenMatches(provided: string, expected: string): boolean {
  const a = createHash("sha256").update(provided).digest();
  const b = createHash("sha256").update(expected).digest();
  return timingSafeEqual(a, b);
}

function authorize(req: IncomingMessage, expected: string | null): boolean {
  if (!expected) return false;
  const provided = extractBearer(headerValue(req, "authorization"));
  if (!provided) return false;
  return tokenMatches(provided, expected);
}

function readBody(req: IncomingMessage, maxBytes: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > maxBytes) {
        req.destroy();
        reject(new Error("payload_too_large"));
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== "";
}

async function handleReply(
  req: IncomingMessage,
  res: ServerResponse,
  opts: ReplyServerOptions,
): Promise<void> {
  if (req.method !== "POST") {
    sendJson(res, 405, { error: "method_not_allowed" });
    return;
  }

  if (!authorize(req, opts.replyToken)) {
    sendJson(res, 401, { error: "unauthorized" });
    return;
  }

  let raw: string;
  try {
    raw = await readBody(req, MAX_BODY_BYTES);
  } catch {
    sendJson(res, 400, { error: "invalid_body" });
    return;
  }

  let parsed: ReplyBody;
  try {
    parsed = JSON.parse(raw) as ReplyBody;
  } catch {
    sendJson(res, 400, { error: "invalid_body" });
    return;
  }

  if (!isNonEmptyString(parsed.correlationId)) {
    sendJson(res, 400, { error: "invalid_body" });
    return;
  }

  const correlationId = parsed.correlationId.trim();
  const text = typeof parsed.text === "string" ? parsed.text : "";
  const errorMessage = isNonEmptyString(parsed.error) ? parsed.error.trim() : null;

  if (!text.trim() && !errorMessage) {
    sendJson(res, 400, { error: "invalid_body" });
    return;
  }

  if (!opts.pending.has(correlationId)) {
    sendJson(res, 404, { error: "unknown_correlation_id" });
    return;
  }

  if (errorMessage && !text.trim()) {
    opts.pending.fail(correlationId, new AgentCallbackError(errorMessage));
    sendJson(res, 200, { ok: true });
    return;
  }

  const result = await opts.pending.complete(correlationId, text);
  if (result === "missing") {
    sendJson(res, 404, { error: "unknown_correlation_id" });
    return;
  }
  if (result === "delivery_failed") {
    sendJson(res, 503, { error: "delivery_failed" });
    return;
  }

  sendJson(res, 200, { ok: true });
}

export async function startReplyServer(opts: ReplyServerOptions): Promise<StartedReplyServer> {
  const server: Server = createServer((req, res) => {
    const url = req.url?.split("?")[0] ?? "";
    if (url !== "/internal/reply") {
      sendJson(res, 404, { error: "not_found" });
      return;
    }
    void handleReply(req, res, opts).catch(() => {
      if (!res.headersSent) {
        sendJson(res, 500, { error: "internal_error" });
      }
    });
  });

  await new Promise<void>((resolve, reject) => {
    const onError = (err: Error) => reject(err);
    server.once("error", onError);
    server.listen(opts.port, opts.host, () => {
      server.off("error", onError);
      resolve();
    });
  });

  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : opts.port;

  return {
    host: opts.host,
    port,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}
