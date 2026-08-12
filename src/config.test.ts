import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadConfig } from "./config.js";

const tmpDir = join(process.cwd(), ".tmp-test-config");

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

function writeSoul(content = "You are a test soul."): string {
  mkdirSync(tmpDir, { recursive: true });
  const path = join(tmpDir, "SOUL.md");
  writeFileSync(path, content, "utf8");
  return path;
}

describe("loadConfig", () => {
  it("loads required openai settings and defaults", () => {
    const soul = writeSoul();
    const cfg = loadConfig({
      DISCORD_BOT_TOKEN: "tok",
      AGENT_BACKEND: "openai",
      API_BASE_URL: "https://api.example.com/v1",
      API_KEY: "key",
      MODEL: "m",
      SYSTEM_PROMPT_FILE: soul,
      DISCORD_ALLOWED_USERS: "111, 222",
      DISCORD_ALLOWED_ROLES: "r1",
      DISCORD_FREE_RESPONSE_CHANNELS: "c1,c2",
    });

    expect(cfg.discordToken).toBe("tok");
    expect(cfg.allowedUsers).toEqual(["111", "222"]);
    expect(cfg.allowedRoles).toEqual(["r1"]);
    expect(cfg.freeResponseChannels).toEqual(["c1", "c2"]);
    expect(cfg.requireMention).toBe(true);
    expect(cfg.allowAllUsers).toBe(false);
    expect(cfg.systemPrompt).toBe("You are a test soul.");
    expect(cfg.temperature).toBe(0.7);
    expect(cfg.maxTokens).toBe(1024);
  });

  it("fails closed without DISCORD_BOT_TOKEN", () => {
    const soul = writeSoul();
    expect(() =>
      loadConfig({
        SYSTEM_PROMPT_FILE: soul,
        API_BASE_URL: "https://x",
        API_KEY: "k",
        MODEL: "m",
      }),
    ).toThrow(/DISCORD_BOT_TOKEN/);
  });

  it("requires API settings for openai backend", () => {
    const soul = writeSoul();
    expect(() =>
      loadConfig({
        DISCORD_BOT_TOKEN: "tok",
        SYSTEM_PROMPT_FILE: soul,
        AGENT_BACKEND: "openai",
      }),
    ).toThrow(/API_BASE_URL/);
  });

  it("allows grok-bot backend without API settings", () => {
    const soul = writeSoul();
    const cfg = loadConfig({
      DISCORD_BOT_TOKEN: "tok",
      SYSTEM_PROMPT_FILE: soul,
      AGENT_BACKEND: "grok-bot",
      DISCORD_ALLOW_ALL_USERS: "true",
    });
    expect(cfg.agentBackend).toBe("grok-bot");
    expect(cfg.allowAllUsers).toBe(true);
    expect(cfg.allowDms).toBe(false);
    expect(cfg.dmOnly).toBe(false);
    expect(cfg.allowedGuilds).toEqual([]);
  });

  it("requires ALLOW_DMS when DM_ONLY is set", () => {
    const soul = writeSoul();
    expect(() =>
      loadConfig({
        DISCORD_BOT_TOKEN: "tok",
        SYSTEM_PROMPT_FILE: soul,
        AGENT_BACKEND: "grok-bot",
        DISCORD_DM_ONLY: "true",
        DISCORD_ALLOW_DMS: "false",
      }),
    ).toThrow(/DISCORD_DM_ONLY/);
  });

  it("parses guild allowlist and DM flags", () => {
    const soul = writeSoul();
    const cfg = loadConfig({
      DISCORD_BOT_TOKEN: "tok",
      SYSTEM_PROMPT_FILE: soul,
      AGENT_BACKEND: "grok-bot",
      DISCORD_ALLOW_ALL_USERS: "true",
      DISCORD_ALLOWED_GUILDS: "g1, g2",
      DISCORD_ALLOW_DMS: "true",
      DISCORD_DM_ONLY: "true",
    });
    expect(cfg.allowedGuilds).toEqual(["g1", "g2"]);
    expect(cfg.allowDms).toBe(true);
    expect(cfg.dmOnly).toBe(true);
  });
});
