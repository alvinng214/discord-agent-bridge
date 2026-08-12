export interface AccessInput {
  authorId: string;
  authorRoleIds: string[];
  channelId: string;
  botMentioned: boolean;
  isBot: boolean;
  isSelf: boolean;
}

export interface AccessConfig {
  allowAllUsers: boolean;
  allowedUsers: string[];
  allowedRoles: string[];
  freeResponseChannels: string[];
  requireMention: boolean;
}

export type AccessDecision =
  | { allowed: true }
  | { allowed: false; reason: string };

/**
 * Hermes-like gate: bots/self ignored; user/role allowlists fail closed;
 * mention required unless free-response channel or REQUIRE_MENTION=false.
 */
export function evaluateAccess(input: AccessInput, config: AccessConfig): AccessDecision {
  if (input.isBot || input.isSelf) {
    return { allowed: false, reason: "ignore_bot_or_self" };
  }

  if (!config.allowAllUsers) {
    const userOk = config.allowedUsers.includes(input.authorId);
    const roleOk =
      config.allowedRoles.length > 0 &&
      input.authorRoleIds.some((id) => config.allowedRoles.includes(id));

    if (config.allowedUsers.length === 0 && config.allowedRoles.length === 0) {
      return { allowed: false, reason: "no_allowlists_configured" };
    }

    if (!userOk && !roleOk) {
      return { allowed: false, reason: "user_not_allowed" };
    }
  }

  const freeChannel = config.freeResponseChannels.includes(input.channelId);
  const mentionRequired = config.requireMention && !freeChannel;
  if (mentionRequired && !input.botMentioned) {
    return { allowed: false, reason: "mention_required" };
  }

  return { allowed: true };
}
