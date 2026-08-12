export interface AccessInput {
  authorId: string;
  authorRoleIds: string[];
  channelId: string;
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
  requireMention: boolean;
}

export type AccessDecision =
  | { allowed: true }
  | { allowed: false; reason: string };

/**
 * Team/personal gate: bots/self ignored; user/role allowlists fail closed;
 * optional guild allowlist and DM / DM-only modes;
 * mention required in guilds unless free-response channel or REQUIRE_MENTION=false.
 * DMs never require an @mention.
 */
export function evaluateAccess(input: AccessInput, config: AccessConfig): AccessDecision {
  if (input.isBot || input.isSelf) {
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

  if (!config.allowAllUsers) {
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
    const freeChannel = config.freeResponseChannels.includes(input.channelId);
    const mentionRequired = config.requireMention && !freeChannel;
    if (mentionRequired && !input.botMentioned) {
      return { allowed: false, reason: "mention_required" };
    }
  }

  return { allowed: true };
}
