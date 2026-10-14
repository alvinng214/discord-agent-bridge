import {
  Client,
  Events,
  GatewayIntentBits,
  Partials,
  ChannelType,
  type Message,
  type OmitPartialGroupDMChannel,
} from "discord.js";
import type { AgentBackend, ReplyContext } from "../agent/backend.js";
import type { Config } from "../config.js";
import { evaluateAccess } from "./access.js";
import {
  AUTOFETCH_BATCH_LIMIT,
  AutofetchLoop,
  type PolledMessage,
} from "./autofetch.js";
import { autofetchStatePath, AutofetchStateStore } from "./autofetchState.js";
import { isConfirmationPing } from "./confirmationPing.js";
import { RateLimiter } from "./rateLimit.js";
import { sendSplitReply, withTyping } from "./reply.js";

export { isConfirmationPing, isSection9AnalystPage } from "./confirmationPing.js";

export function createDiscordClient(config: Config): Client {
  const intents: GatewayIntentBits[] = [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ];
  if (config.allowDms) {
    intents.push(GatewayIntentBits.DirectMessages);
  }

  return new Client({
    intents,
    partials: [Partials.Channel],
  });
}

function stripBotMention(content: string, botId: string): string {
  return content
    .replace(new RegExp(`<@!?${botId}>`, "g"), "")
    .replace(/\s+/g, " ")
    .trim();
}

/** Memory key: threads use their own id so history does not bleed into the parent. */
export function conversationKey(message: Message): string {
  const channel = message.channel;
  if ("isThread" in channel && typeof channel.isThread === "function" && channel.isThread()) {
    return `thread:${message.channelId}`;
  }
  return `channel:${message.channelId}`;
}

export function channelContext(message: Message): {
  channelName?: string;
  threadName?: string;
  channelTopic?: string | null;
  guildName?: string;
  parentChannelId?: string | null;
} {
  const guildName = message.guild?.name ?? undefined;
  const channel = message.channel;

  if ("isThread" in channel && typeof channel.isThread === "function" && channel.isThread()) {
    const parent = channel.parent;
    const parentName =
      parent && "name" in parent && typeof parent.name === "string" ? parent.name : undefined;
    const topic =
      parent && "topic" in parent && typeof parent.topic === "string" ? parent.topic : null;
    return {
      channelName: parentName ?? ("name" in channel ? channel.name : undefined),
      threadName: "name" in channel ? channel.name : undefined,
      channelTopic: topic,
      guildName,
      parentChannelId: channel.parentId ?? null,
    };
  }

  if ("name" in channel && typeof channel.name === "string") {
    const topic =
      "topic" in channel && typeof channel.topic === "string" ? channel.topic : null;
    return { channelName: channel.name, channelTopic: topic, guildName };
  }
  return { guildName };
}

/** Shared by the gateway handler and autofetch so a message is handled once. */
class TurnTracker {
  private readonly seen = new Set<string>();
  private consecutiveBotTurns = 0;

  constructor(private readonly maxBotTurns: number) {}

  /** Returns false if this Discord message was already handled. */
  remember(id: string): boolean {
    if (this.seen.has(id)) return false;
    this.seen.add(id);
    if (this.seen.size > 2000) {
      let dropped = 0;
      for (const key of this.seen) {
        this.seen.delete(key);
        if (++dropped >= 500) break;
      }
    }
    return true;
  }

  noteSelf(): void {
    this.consecutiveBotTurns = 0;
  }

  noteHuman(): void {
    this.consecutiveBotTurns = 0;
  }

  /** False when an unaddressed bot message exceeds DISCORD_MAX_BOT_TURNS. */
  consumeBotTurn(): boolean {
    if (this.consecutiveBotTurns >= this.maxBotTurns) return false;
    this.consecutiveBotTurns += 1;
    return true;
  }
}

export function attachMessageHandler(
  client: Client,
  config: Config,
  backend: AgentBackend,
  tracker: TurnTracker = new TurnTracker(config.maxBotTurns),
): void {
  const limiter = new RateLimiter(config.rateLimitPerUser, config.rateLimitWindowMs);

  client.on("messageCreate", async (message: OmitPartialGroupDMChannel<Message>) => {
    try {
      await handleMessage(client, config, backend, limiter, tracker, message);
    } catch (err) {
      console.error("[bridge] unhandled message error", err);
    }
  });
}

/**
 * Poll free-response channels so messages missed while the gateway was down
 * still reach the agent. DMs stay on the live connection. Blocked channels
 * are never polled. Opt-in via DISCORD_AUTOFETCH.
 * Returns a stop function; production keeps the timers for the process lifetime.
 */
export function startAutofetch(
  client: Client,
  config: Config,
  backend: AgentBackend,
  tracker: TurnTracker = new TurnTracker(config.maxBotTurns),
): () => void {
  if (!config.autofetch) return () => undefined;
  const channels = config.freeResponseChannels.filter((id) => !config.blockedChannels.includes(id));
  if (channels.length === 0) {
    console.log("[bridge] autofetch enabled but no free-response channels to poll");
    return () => undefined;
  }
  const userId = client.user?.id;
  if (!userId) {
    console.error("[bridge] autofetch skipped: discord client not ready");
    return () => undefined;
  }

  const limiter = new RateLimiter(config.rateLimitPerUser, config.rateLimitWindowMs);
  const statePath = autofetchStatePath(config.autofetchStateDir, userId);
  const loop = new AutofetchLoop<PollableChannel, Message>({
    channelIds: channels,
    intervalMs: config.autofetchIntervalMs,
    lookbackMs: config.autofetchLookbackMs,
    fetchTimeoutMs: config.autofetchFetchTimeoutMs,
    fetchAttempts: config.autofetchFetchAttempts,
    backfill: config.autofetchBackfill,
    heartbeatEvery: config.heartbeatEvery,
    state: new AutofetchStateStore(statePath),
    statePath,
    userId: () => client.user?.id ?? null,
    fetchChannel: (id) => fetchPollableChannel(client, id),
    fetchMessages: (channel) => fetchPolledMessages(channel),
    deliver: (message) => {
      void handleMessage(client, config, backend, limiter, tracker, message.payload, "autofetch").catch(
        (err) => {
          console.error(
            "[bridge] autofetch handleMessage error",
            message.id,
            err instanceof Error ? err.message : err,
          );
        },
      );
    },
    bannerSuffix: `maxBotTurns=${config.maxBotTurns}`,
  });
  loop.start();
  return () => loop.stop();
}

interface PollableChannel {
  messages: {
    fetch(query: { limit: number; cache?: boolean }): Promise<ReadonlyMap<string, Message>>;
  };
}

// discord.js 14.16 ChannelManager.fetch / MessageManager.fetch do not accept an
// AbortSignal (they call rest.get without one). withTimeout cannot cancel these
// sockets; it only stops the poll from waiting. See withTimeout in autofetch.ts.

async function fetchPollableChannel(client: Client, id: string): Promise<PollableChannel | null> {
  const channel = await client.channels.fetch(id);
  if (!channel || !channel.isTextBased() || channel.isDMBased()) return null;
  return channel;
}

async function fetchPolledMessages(channel: PollableChannel): Promise<PolledMessage<Message>[]> {
  const batch = await channel.messages.fetch({ limit: AUTOFETCH_BATCH_LIMIT, cache: false });
  const messages: PolledMessage<Message>[] = [];
  for (const message of batch.values()) {
    if (!message.author) continue;
    messages.push({
      id: message.id,
      channelId: message.channelId,
      authorId: message.author.id,
      username: message.author.username,
      createdTimestamp: message.createdTimestamp,
      payload: message,
    });
  }
  return messages;
}

const REPLY_CONTEXT_MAX_CHARS = 3000;

async function fetchReplyContext(message: Message): Promise<ReplyContext | undefined> {
  if (!message.reference?.messageId) return undefined;
  try {
    const ref = await message.fetchReference();
    const parts: string[] = [];
    if (ref.content?.trim()) parts.push(ref.content.trim());
    for (const embed of ref.embeds ?? []) {
      const bits = [
        embed.title,
        embed.description,
        ...(embed.fields ?? []).map((field) => `${field.name}: ${field.value}`),
      ].filter((bit): bit is string => typeof bit === "string" && bit.trim().length > 0);
      if (bits.length) parts.push(bits.join("\n"));
    }
    const attachments = [...(ref.attachments?.values() ?? [])].map(
      (attachment) => `[attachment: ${attachment.name ?? "file"}]`,
    );
    if (attachments.length) parts.push(attachments.join(" "));
    let content = parts.join("\n\n");
    if (content.length > REPLY_CONTEXT_MAX_CHARS) {
      content = `${content.slice(0, REPLY_CONTEXT_MAX_CHARS)}\n[truncated]`;
    }
    return {
      authorDisplayName: ref.member?.displayName ?? ref.author?.username ?? "unknown",
      isBot: Boolean(ref.author?.bot),
      createdAt: ref.createdAt.toISOString(),
      content,
    };
  } catch (err) {
    console.error(
      "[bridge] could not fetch replied-to message",
      err instanceof Error ? err.message : err,
    );
    return undefined;
  }
}

async function handleMessage(
  client: Client,
  config: Config,
  backend: AgentBackend,
  limiter: RateLimiter,
  tracker: TurnTracker,
  message: Message,
  source: "gateway" | "autofetch" = "gateway",
): Promise<void> {
  if (!client.user) return;
  if (!tracker.remember(message.id)) return;
  if (message.author.id !== client.user.id) {
    console.log(
      `[bridge] ${source} received message=${message.id} channel=${message.channelId} from=${message.author.username}(${message.author.id}) bot=${message.author.bot}`,
    );
  }

  const isDm = message.channel.type === ChannelType.DM || message.guild === null;

  const botMentioned = message.mentions.users.has(client.user.id);
  const authorRoleIds = message.member?.roles.cache.map((role) => role.id) ?? [];

  const ctx = channelContext(message);

  const access = evaluateAccess(
    {
      authorId: message.author.id,
      authorRoleIds,
      channelId: message.channelId,
      parentChannelId: ctx.parentChannelId,
      guildId: message.guildId,
      isDm,
      botMentioned,
      isBot: message.author.bot,
      isSelf: message.author.id === client.user.id,
    },
    {
      allowAllUsers: config.allowAllUsers,
      allowedUsers: config.allowedUsers,
      allowedRoles: config.allowedRoles,
      allowedGuilds: config.allowedGuilds,
      allowDms: config.allowDms,
      dmOnly: config.dmOnly,
      freeResponseChannels: config.freeResponseChannels,
      blockedChannels: config.blockedChannels,
      allowedChannels: config.allowedChannels,
      requireMention: config.requireMention,
      allowedBotUsers: config.allowedBotUsers,
    },
  );

  // Our own posts mean we answered: reset the bot-to-bot turn budget.
  if (message.author.id === client.user.id) {
    tracker.noteSelf();
  }

  if (!access.allowed) {
    if (message.author.id !== client.user.id) {
      console.log(`[bridge] access denied message=${message.id} reason=${access.reason}`);
    }
    return;
  }

  if (!limiter.tryConsume(message.author.id)) {
    await message.reply({
      content: "You're sending messages too quickly — try again in a minute.",
      allowedMentions: { repliedUser: false },
    });
    return;
  }

  const content = stripBotMention(message.content, client.user.id);
  if (message.author.bot && isConfirmationPing(content)) return;
  if (message.author.bot) {
    // An allowed bot that explicitly @-mentions us is always delivered;
    // the turn cap only limits unaddressed bot chatter.
    if (!botMentioned && !tracker.consumeBotTurn()) {
      console.log(
        `[bridge] bot-turn cap dropped message=${message.id} from=${message.author.username}`,
      );
      return;
    }
  } else {
    tracker.noteHuman();
  }
  if (!content) {
    await message.reply({
      content: isDm
        ? "Send me a message with what you need help with."
        : "Mention me with a question (or say something in a free-response channel).",
      allowedMentions: { repliedUser: false },
    });
    return;
  }

  const replyTo = config.includeReplyContext ? await fetchReplyContext(message) : undefined;

  try {
    const result = await withTyping(message, () =>
      backend.generate({
        conversationKey: conversationKey(message),
        authorDisplayName: message.member?.displayName ?? message.author.username,
        content,
        channelName: ctx.channelName,
        threadName: ctx.threadName,
        channelTopic: ctx.channelTopic,
        guildName: ctx.guildName,
        deliverReply: (text) => sendSplitReply(message, text),
        replyTo,
      }),
    );
    if (!result.delivered) {
      await sendSplitReply(message, result.text);
    }
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    console.error("[bridge] agent error:", detail);
    await message.reply({
      content: "Sorry — I hit an error generating a reply. Try again shortly.",
      allowedMentions: { repliedUser: false },
    });
  }
}

export async function startBot(config: Config, backend: AgentBackend): Promise<Client> {
  const client = createDiscordClient(config);
  const tracker = new TurnTracker(config.maxBotTurns);
  attachMessageHandler(client, config, backend, tracker);

  client.once(Events.ClientReady, () => {
    console.log(`[bridge] logged in as ${client.user?.tag} (backend=${backend.name})`);
    startAutofetch(client, config, backend, tracker);
    if (config.homeChannel) {
      console.log(`[bridge] home channel configured: ${config.homeChannel}`);
    }
    if (config.allowDms) {
      console.log(`[bridge] DMs enabled${config.dmOnly ? " (DM-only mode)" : ""}`);
    }
    if (config.blockedChannels.length > 0) {
      console.log(`[bridge] blocked channels: ${config.blockedChannels.join(",")}`);
    }
    if (config.allowedChannels.length > 0) {
      console.log(`[bridge] allowed channels: ${config.allowedChannels.join(",")}`);
    }
  });

  await client.login(config.discordToken);
  return client;
}
