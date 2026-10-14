export interface AccessInput {
  authorId: string;
  authorRoleIds: string[];
  channelId: string;
  /** Parent channel id when message is in a thread. */
  parentChannelId?: string | null;
  guildId: string | null;
  isDm: boolean;
  botMentioned: boolean;
  isBot: boolean;
  isSelf: boolean;
}

export interface AccessConfig {
  allowAllUsers: boolean;
  allowedUsers: string[];
  allowedRoles: string[];
  allowedGuilds: string[];
  allowDms: boolean;
  dmOnly: boolean;
  freeResponseChannels: string[];
  /** Channel ids this agent must never read, including threads under them. */
  blockedChannels: string[];
  /** If non-empty, guild messages are allowed only in these channels or their threads. DMs are unaffected. */
  allowedChannels: string[];
  requireMention: boolean;
  /** Bot user ids that may message us. Every other bot is still ignored. */
  allowedBotUsers: string[];
}

export type AccessDecision =
  | { allowed: true }
  | { allowed: false; reason: string };

/**
 * Team/personal gate: self and non-allowed bots ignored; user/role allowlists fail closed
 * for humans and for bot DMs. In guilds, a bot listed in DISCORD_ALLOWED_BOTS skips the
 * human user/role allowlist.
 * Optional guild, channel, and DM / DM-only modes still apply to everyone;
 * mention required in guilds unless free-response channel or REQUIRE_MENTION=false.
 * DMs never require an @mention.
 */
export function evaluateAccess(input: AccessInput, config: AccessConfig): AccessDecision {
  const blocked =
    config.blockedChannels.includes(input.channelId) ||
    (!!input.parentChannelId && config.blockedChannels.includes(input.parentChannelId));
  if (blocked) {
    return { allowed: false, reason: "channel_blocked" };
  }

  if (!input.isDm && config.allowedChannels.length > 0) {
    const channelOk =
      config.allowedChannels.includes(input.channelId) ||
      (!!input.parentChannelId && config.allowedChannels.includes(input.parentChannelId));
    if (!channelOk) {
      return { allowed: false, reason: "channel_not_allowed" };
    }
  }

  const allowedBot =
    input.isBot && !input.isSelf && config.allowedBotUsers.includes(input.authorId);
  if (input.isSelf || (input.isBot && !allowedBot)) {
    return { allowed: false, reason: "ignore_bot_or_self" };
  }

  if (input.isDm) {
    if (!config.allowDms) {
      return { allowed: false, reason: "dms_disabled" };
    }
  } else {
    if (config.dmOnly) {
      return { allowed: false, reason: "dm_only" };
    }
    if (
      config.allowedGuilds.length > 0 &&
      (!input.guildId || !config.allowedGuilds.includes(input.guildId))
    ) {
      return { allowed: false, reason: "guild_not_allowed" };
    }
  }

  // Guild messages from listed bots skip the human user/role allowlist.
  // DMs from those bots still require the user allowlist.
  if (!config.allowAllUsers && (!allowedBot || input.isDm)) {
    const userOk = config.allowedUsers.includes(input.authorId);
    const roleOk =
      !input.isDm &&
      config.allowedRoles.length > 0 &&
      input.authorRoleIds.some((id) => config.allowedRoles.includes(id));

    if (config.allowedUsers.length === 0 && config.allowedRoles.length === 0) {
      return { allowed: false, reason: "no_allowlists_configured" };
    }

    // DMs: user allowlist only (roles do not apply).
    if (input.isDm) {
      if (config.allowedUsers.length === 0) {
        // Roles alone cannot authorize a DM; require users or allow-all.
        return { allowed: false, reason: "no_user_allowlist_for_dm" };
      }
      if (!userOk) {
        return { allowed: false, reason: "user_not_allowed" };
      }
    } else if (!userOk && !roleOk) {
      return { allowed: false, reason: "user_not_allowed" };
    }
  }

  if (!input.isDm) {
    const freeChannel =
      config.freeResponseChannels.includes(input.channelId) ||
      (!!input.parentChannelId &&
        config.freeResponseChannels.includes(input.parentChannelId));
    const mentionRequired = config.requireMention && !freeChannel;
    if (mentionRequired && !input.botMentioned) {
      return { allowed: false, reason: "mention_required" };
    }
  }

  return { allowed: true };
}
