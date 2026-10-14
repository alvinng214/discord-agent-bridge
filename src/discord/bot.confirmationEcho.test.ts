import { EventEmitter } from "node:events";
import { ChannelType, type Client, type Message } from "discord.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentBackend } from "../agent/backend.js";
import type { Config } from "../config.js";
import { attachMessageHandler } from "./bot.js";

const SELF_ID = "111";
const GPT_ID = "222";

function bridgeConfig(): Config {
  return {
    discordToken: "test-token",
    allowedRoles: [],
    allowAllUsers: false,
    allowedUsers: [],
    allowedGuilds: [],
    allowDms: false,
    dmOnly: false,
    freeResponseChannels: ["free"],
    blockedChannels: [],
    allowedChannels: [],
    autofetch: false,
    autofetchIntervalMs: 15_000,
    autofetchLookbackMs: 7_200_000,
    autofetchStateDir: "run",
    autofetchFetchTimeoutMs: 10_000,
    autofetchFetchAttempts: 3,
    autofetchBackfill: false,
    heartbeatEvery: 20,
    requireMention: true,
    includeReplyContext: false,
    allowedBotUsers: [GPT_ID],
    maxBotTurns: 2,
    homeChannel: null,
    agentBackend: "openai",
    apiBaseUrl: null,
    apiKey: null,
    model: null,
    systemPrompt: "",
    systemPromptFile: "SOUL.md",
    temperature: 0.7,
    maxTokens: 1024,
    memoryMaxMessages: 20,
    rateLimitPerUser: 10,
    rateLimitWindowMs: 60_000,
    braveApiKey: null,
    tavilyApiKey: null,
    grokBotGatewayUrl: null,
    grokBotToken: null,
    grokBotAgentId: null,
    grokBotTimeoutMs: 120_000,
    bridgeHttpHost: "0.0.0.0",
    bridgeHttpPort: 8788,
    bridgePublicUrl: null,
    bridgeReplyToken: null,
  };
}

function fakeClient(): Client {
  const emitter = new EventEmitter();
  return Object.assign(emitter, { user: { id: SELF_ID } }) as unknown as Client;
}

function botMessage(partial: {
  id: string;
  content: string;
  username: string;
  mentioned: boolean;
  reply?: (...args: unknown[]) => Promise<unknown>;
}): Message {
  return {
    id: partial.id,
    content: partial.content,
    channelId: "free",
    guildId: "g1",
    guild: { name: "Audit" },
    author: { id: GPT_ID, username: partial.username, bot: true },
    member: null,
    reference: null,
    channel: {
      type: ChannelType.GuildText,
      isThread: () => false,
      name: "round-table",
      topic: null,
      sendTyping: () => Promise.resolve(),
      send: () => Promise.resolve(),
    },
    mentions: {
      users: {
        has: (id: string) => partial.mentioned && id === SELF_ID,
      },
    },
    reply: partial.reply ?? (() => Promise.resolve()),
  } as unknown as Message;
}

async function dispatch(client: Client, message: Message): Promise<void> {
  const listeners = (client as unknown as EventEmitter).listeners("messageCreate");
  await Promise.all(
    listeners.map((listener) =>
      Promise.resolve((listener as (incoming: Message) => unknown)(message)),
    ),
  );
}

describe("allowed bot delivery", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("delivers an allowed bot message containing Confirmed with no mention", async () => {
    const generate = vi.fn(async () => ({ text: "ack", delivered: true }));
    const backend: AgentBackend = { name: "test", generate };
    const client = fakeClient();
    attachMessageHandler(client, bridgeConfig(), backend);

    await dispatch(
      client,
      botMessage({
        id: "m-round8",
        username: "GPT",
        mentioned: false,
        content: "Confirmed: all three mains are clean",
      }),
    );

    expect(generate).toHaveBeenCalledOnce();
    expect(generate).toHaveBeenCalledWith(
      expect.objectContaining({
        content: expect.stringContaining("Confirmed: all three mains"),
      }),
    );
  });

  it("delivers an allowed bot after many consecutive bot turns", async () => {
    const generate = vi.fn(async () => ({ text: "ack", delivered: true }));
    const backend: AgentBackend = { name: "test", generate };
    const client = fakeClient();
    attachMessageHandler(client, bridgeConfig(), backend);

    const turns = 5;
    for (let n = 1; n <= turns; n++) {
      await dispatch(
        client,
        botMessage({
          id: `m-turn-${n}`,
          username: "GPT",
          mentioned: false,
          content: `bot turn ${n}`,
        }),
      );
    }

    expect(generate).toHaveBeenCalledTimes(turns);
    expect(generate).toHaveBeenLastCalledWith(
      expect.objectContaining({ content: `bot turn ${turns}` }),
    );
  });

  it("logs instead of replying when an allowed bot is rate limited", async () => {
    const generate = vi.fn(async () => ({ text: "ack", delivered: true }));
    const backend: AgentBackend = { name: "test", generate };
    const client = fakeClient();
    const config = { ...bridgeConfig(), rateLimitPerUser: 1 };
    attachMessageHandler(client, config, backend);
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const reply = vi.fn(async () => undefined);

    for (const id of ["rl-1", "rl-2"]) {
      await dispatch(client, botMessage({ id, username: "GPT", mentioned: false, content: `msg ${id}`, reply }));
    }

    expect(generate).toHaveBeenCalledOnce();
    expect(reply).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith(expect.stringContaining("rate limited message=rl-2"));
  });

  it("logs instead of replying when an allowed bot sends empty content", async () => {
    const generate = vi.fn(async () => ({ text: "ack", delivered: true }));
    const backend: AgentBackend = { name: "test", generate };
    const client = fakeClient();
    attachMessageHandler(client, bridgeConfig(), backend);
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const reply = vi.fn(async () => undefined);

    await dispatch(
      client,
      botMessage({ id: "empty-1", username: "GPT", mentioned: true, content: `<@${SELF_ID}>`, reply }),
    );

    expect(generate).not.toHaveBeenCalled();
    expect(reply).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith(expect.stringContaining("empty content from bot message=empty-1"));
  });
});
