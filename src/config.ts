import { readFileSync } from "node:fs";
import { resolve } from "node:path";

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
  requireMention: boolean;
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
  const systemPrompt = loadSystemPrompt(systemPromptFile);

  const apiBaseUrl = env.API_BASE_URL?.trim() || null;
  const apiKey = env.API_KEY?.trim() || null;
  const model = env.MODEL?.trim() || null;

  if (agentBackend === "openai") {
    if (!apiBaseUrl) throw new Error("API_BASE_URL is required when AGENT_BACKEND=openai");
    if (!apiKey) throw new Error("API_KEY is required when AGENT_BACKEND=openai");
    if (!model) throw new Error("MODEL is required when AGENT_BACKEND=openai");
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
    requireMention: parseBool(env.DISCORD_REQUIRE_MENTION, true),
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
  };
}
