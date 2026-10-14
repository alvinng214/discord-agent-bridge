import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { effectiveAutofetchIntervalMs } from "./discord/autofetch.js";

export type AgentBackendKind = "openai" | "grok-bot";

export interface Config {
  discordToken: string;
  allowedRoles: string[];
  allowAllUsers: boolean;
  allowedUsers: string[];
  allowedGuilds: string[];
  allowDms: boolean;
  dmOnly: boolean;
  freeResponseChannels: string[];
  blockedChannels: string[];
  /** If non-empty, guild messages are allowed only in these channels or their threads. */
  allowedChannels: string[];
  /** Poll free-response channels for messages the gateway missed. Off unless DISCORD_AUTOFETCH=true. */
  autofetch: boolean;
  autofetchIntervalMs: number;
  autofetchLookbackMs: number;
  /** Absolute directory for per-bot autofetch cursor files. */
  autofetchStateDir: string;
  /** Per Discord REST call in the autofetch path. */
  autofetchFetchTimeoutMs: number;
  /** Total attempts per autofetch REST call, including the first try. */
  autofetchFetchAttempts: number;
  /**
   * When false (default), a channel with no saved cursor is seeded to the newest
   * message and nothing is delivered. Set true to replay the lookback once.
   */
  autofetchBackfill: boolean;
  /** Log clean autofetch heartbeats every N ticks (always on change, skip, or error). */
  heartbeatEvery: number;
  requireMention: boolean;
  /** Include the message being replied to in the agent prompt. Off unless DISCORD_INCLUDE_REPLY_CONTEXT=true. */
  includeReplyContext: boolean;
  allowedBotUsers: string[];
  /** Unaddressed bot-to-bot replies allowed before the bridge stops responding. */
  maxBotTurns: number;
  homeChannel: string | null;
  agentBackend: AgentBackendKind;
  apiBaseUrl: string | null;
  apiKey: string | null;
  model: string | null;
  systemPrompt: string;
  systemPromptFile: string;
  temperature: number;
  maxTokens: number;
  memoryMaxMessages: number;
  rateLimitPerUser: number;
  rateLimitWindowMs: number;
  braveApiKey: string | null;
  tavilyApiKey: string | null;
  grokBotGatewayUrl: string | null;
  grokBotToken: string | null;
  grokBotAgentId: string | null;
  grokBotTimeoutMs: number;
  bridgeHttpHost: string;
  bridgeHttpPort: number;
  bridgePublicUrl: string | null;
  bridgeReplyToken: string | null;
}

function parseBool(value: string | undefined, defaultValue: boolean): boolean {
  if (value === undefined || value.trim() === "") return defaultValue;
  const v = value.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(v)) return true;
  if (["0", "false", "no", "off"].includes(v)) return false;
  throw new Error(`Invalid boolean env value: ${value}`);
}

function parseCsvIds(value: string | undefined): string[] {
  if (!value || value.trim() === "") return [];
  return value
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

function parseNumber(value: string | undefined, defaultValue: number): number {
  if (value === undefined || value.trim() === "") return defaultValue;
  const n = Number(value);
  if (!Number.isFinite(n)) throw new Error(`Invalid number env value: ${value}`);
  return n;
}

function parsePositive(value: string | undefined, defaultValue: number, name: string): number {
  const n = parseNumber(value, defaultValue);
  if (n <= 0) throw new Error(`${name} must be a positive number`);
  return n;
}

function parseBoundedInt(
  value: string | undefined,
  defaultValue: number,
  min: number,
  max: number,
  name: string,
): number {
  const n = parseNumber(value, defaultValue);
  if (!Number.isInteger(n) || n < min || n > max) {
    throw new Error(`${name} must be an integer between ${min} and ${max}`);
  }
  return n;
}

/** Invalid or empty values fall back to 2 so a bad env does not take the bridge down. */
function parseMaxBotTurns(value: string | undefined): number {
  if (value === undefined || value.trim() === "") return 2;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1) return 2;
  return n;
}

function loadSystemPrompt(filePath: string): string {
  const absolute = resolve(process.cwd(), filePath);
  try {
    return readFileSync(absolute, "utf8").trim();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`Failed to read SYSTEM_PROMPT_FILE (${filePath}): ${message}`);
  }
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const discordToken = env.DISCORD_BOT_TOKEN?.trim();
  if (!discordToken) {
    throw new Error("DISCORD_BOT_TOKEN is required");
  }

  const agentBackendRaw = (env.AGENT_BACKEND?.trim() || "openai").toLowerCase();
  if (agentBackendRaw !== "openai" && agentBackendRaw !== "grok-bot") {
    throw new Error(`AGENT_BACKEND must be "openai" or "grok-bot", got: ${agentBackendRaw}`);
  }
  const agentBackend = agentBackendRaw as AgentBackendKind;

  const systemPromptFile = env.SYSTEM_PROMPT_FILE?.trim() || "SOUL.md";
  let systemPrompt = loadSystemPrompt(systemPromptFile);

  const apiBaseUrl = env.API_BASE_URL?.trim() || null;
  const apiKey = env.API_KEY?.trim() || null;
  const model = env.MODEL?.trim() || null;

  // Keep identity truthful: many models default to "I'm ChatGPT" when asked.
  if (model) {
    systemPrompt = `${systemPrompt}

## Runtime identity
- You are served through an OpenAI-compatible API as model \`${model}\`.
- When asked which model/product you are, answer with that model id (e.g. Grok via OpenRouter if the id is under \`x-ai/\`).
- Do not claim to be ChatGPT, OpenAI, Claude, or any other vendor unless the model id actually is that product.`;
  }

  const grokBotGatewayUrl = env.GROK_BOT_GATEWAY_URL?.trim() || null;
  const grokBotToken = env.GROK_BOT_TOKEN?.trim() || null;
  const grokBotAgentId = env.GROK_BOT_AGENT_ID?.trim() || null;
  const grokBotTimeoutMs = parseNumber(env.GROK_BOT_TIMEOUT_MS, 120_000);
  const bridgeHttpHost = env.BRIDGE_HTTP_HOST?.trim() || "0.0.0.0";
  const bridgeHttpPort = parseNumber(env.BRIDGE_HTTP_PORT, 8788);
  const bridgePublicUrl = env.BRIDGE_PUBLIC_URL?.trim() || null;
  const bridgeReplyToken = env.BRIDGE_REPLY_TOKEN?.trim() || null;

  if (agentBackend === "openai") {
    if (!apiBaseUrl) throw new Error("API_BASE_URL is required when AGENT_BACKEND=openai");
    if (!apiKey) throw new Error("API_KEY is required when AGENT_BACKEND=openai");
    if (!model) throw new Error("MODEL is required when AGENT_BACKEND=openai");
  }

  if (agentBackend === "grok-bot") {
    if (!grokBotGatewayUrl) {
      throw new Error("GROK_BOT_GATEWAY_URL is required when AGENT_BACKEND=grok-bot");
    }
    if (!grokBotToken) {
      throw new Error("GROK_BOT_TOKEN is required when AGENT_BACKEND=grok-bot");
    }
    if (!grokBotAgentId) {
      throw new Error("GROK_BOT_AGENT_ID is required when AGENT_BACKEND=grok-bot");
    }
    if (!bridgePublicUrl) {
      throw new Error("BRIDGE_PUBLIC_URL is required when AGENT_BACKEND=grok-bot");
    }
    if (!bridgeReplyToken) {
      throw new Error("BRIDGE_REPLY_TOKEN is required when AGENT_BACKEND=grok-bot");
    }
    if (grokBotTimeoutMs <= 0) {
      throw new Error("GROK_BOT_TIMEOUT_MS must be a positive number");
    }
    if (!Number.isInteger(bridgeHttpPort) || bridgeHttpPort < 1 || bridgeHttpPort > 65535) {
      throw new Error("BRIDGE_HTTP_PORT must be an integer between 1 and 65535");
    }
  }

  const allowDms = parseBool(env.DISCORD_ALLOW_DMS, false);
  const dmOnly = parseBool(env.DISCORD_DM_ONLY, false);
  if (dmOnly && !allowDms) {
    throw new Error("DISCORD_DM_ONLY=true requires DISCORD_ALLOW_DMS=true");
  }

  return {
    discordToken,
    allowedRoles: parseCsvIds(env.DISCORD_ALLOWED_ROLES),
    allowAllUsers: parseBool(env.DISCORD_ALLOW_ALL_USERS, false),
    allowedUsers: parseCsvIds(env.DISCORD_ALLOWED_USERS),
    allowedGuilds: parseCsvIds(env.DISCORD_ALLOWED_GUILDS),
    allowDms,
    dmOnly,
    freeResponseChannels: parseCsvIds(env.DISCORD_FREE_RESPONSE_CHANNELS),
    blockedChannels: parseCsvIds(env.DISCORD_BLOCKED_CHANNELS),
    allowedChannels: parseCsvIds(env.DISCORD_ALLOWED_CHANNELS),
    autofetch: parseBool(env.DISCORD_AUTOFETCH, false),
    autofetchIntervalMs: effectiveAutofetchIntervalMs(
      parsePositive(env.DISCORD_AUTOFETCH_INTERVAL_MS, 15_000, "DISCORD_AUTOFETCH_INTERVAL_MS"),
    ),
    autofetchLookbackMs: parsePositive(
      env.DISCORD_AUTOFETCH_LOOKBACK_MS,
      2 * 60 * 60 * 1000,
      "DISCORD_AUTOFETCH_LOOKBACK_MS",
    ),
    autofetchStateDir: resolve(process.cwd(), env.DISCORD_AUTOFETCH_STATE_DIR?.trim() || "run"),
    autofetchFetchTimeoutMs: parseBoundedInt(
      env.DISCORD_AUTOFETCH_FETCH_TIMEOUT_MS,
      10_000,
      1_000,
      60_000,
      "DISCORD_AUTOFETCH_FETCH_TIMEOUT_MS",
    ),
    autofetchFetchAttempts: parseBoundedInt(
      env.DISCORD_AUTOFETCH_FETCH_ATTEMPTS,
      3,
      1,
      5,
      "DISCORD_AUTOFETCH_FETCH_ATTEMPTS",
    ),
    autofetchBackfill: parseBool(env.DISCORD_AUTOFETCH_BACKFILL, false),
    heartbeatEvery: parseBoundedInt(env.DISCORD_HEARTBEAT_EVERY, 20, 1, 10_000, "DISCORD_HEARTBEAT_EVERY"),
    requireMention: parseBool(env.DISCORD_REQUIRE_MENTION, true),
    includeReplyContext: parseBool(env.DISCORD_INCLUDE_REPLY_CONTEXT, false),
    allowedBotUsers: parseCsvIds(env.DISCORD_ALLOWED_BOTS),
    maxBotTurns: parseMaxBotTurns(env.DISCORD_MAX_BOT_TURNS),
    homeChannel: env.DISCORD_HOME_CHANNEL?.trim() || null,
    agentBackend,
    apiBaseUrl,
    apiKey,
    model,
    systemPrompt,
    systemPromptFile,
    temperature: parseNumber(env.TEMPERATURE, 0.7),
    maxTokens: parseNumber(env.MAX_TOKENS, 1024),
    memoryMaxMessages: parseNumber(env.MEMORY_MAX_MESSAGES, 20),
    rateLimitPerUser: parseNumber(env.RATE_LIMIT_PER_USER, 5),
    rateLimitWindowMs: parseNumber(env.RATE_LIMIT_WINDOW_MS, 60_000),
    braveApiKey: env.BRAVE_API_KEY?.trim() || null,
    tavilyApiKey: env.TAVILY_API_KEY?.trim() || null,
    grokBotGatewayUrl,
    grokBotToken,
    grokBotAgentId,
    grokBotTimeoutMs,
    bridgeHttpHost,
    bridgeHttpPort,
    bridgePublicUrl,
    bridgeReplyToken,
  };
}
