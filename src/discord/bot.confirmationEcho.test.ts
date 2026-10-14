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
    reply: () => Promise.resolve(),
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

describe("confirmation-echo filter", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("delivers an allowed bot @-mention that says Confirmed", async () => {
    const logs: string[] = [];
    vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      logs.push(args.map(String).join(" "));
    });
    const generate = vi.fn(async () => ({ text: "ack", delivered: true }));
    const backend: AgentBackend = { name: "test", generate };
    const client = fakeClient();
    attachMessageHandler(client, bridgeConfig(), backend);

    await dispatch(
      client,
      botMessage({
        id: "m-round8",
        username: "GPT",
        mentioned: true,
        content: `<@${SELF_ID}> Confirmed: all three mains are clean`,
      }),
    );

    expect(generate).toHaveBeenCalledOnce();
    expect(generate).toHaveBeenCalledWith(
      expect.objectContaining({
        content: expect.stringContaining("Confirmed: all three mains"),
      }),
    );
    expect(logs.some((line) => line.includes("confirmation-echo filter dropped"))).toBe(false);
  });

  it("drops an unmentioned bot confirmed echo and logs it", async () => {
    const logs: string[] = [];
    vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      logs.push(args.map(String).join(" "));
    });
    const generate = vi.fn(async () => ({ text: "ack", delivered: true }));
    const backend: AgentBackend = { name: "test", generate };
    const client = fakeClient();
    attachMessageHandler(client, bridgeConfig(), backend);

    await dispatch(
      client,
      botMessage({
        id: "m-echo",
        username: "GPT",
        mentioned: false,
        content: "confirmed, stopping",
      }),
    );

    expect(generate).not.toHaveBeenCalled();
    expect(logs).toContain(
      "[bridge] confirmation-echo filter dropped message=m-echo from=GPT",
    );
  });
});
