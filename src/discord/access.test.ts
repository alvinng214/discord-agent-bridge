import { describe, expect, it } from "vitest";
import { evaluateAccess, type AccessConfig, type AccessInput } from "./access.js";

const baseConfig: AccessConfig = {
  allowAllUsers: false,
  allowedUsers: ["u1"],
  allowedRoles: ["r1"],
  allowedGuilds: [],
  allowDms: false,
  dmOnly: false,
  freeResponseChannels: ["free"],
  blockedChannels: [],
  allowedChannels: [],
  requireMention: true,
  allowedBotUsers: ["bot-ok"],
};

function guildInput(overrides: Partial<AccessInput> = {}): AccessInput {
  return {
    authorId: "u1",
    authorRoleIds: [],
    channelId: "c",
    guildId: "g1",
    isDm: false,
    botMentioned: true,
    isBot: false,
    isSelf: false,
    ...overrides,
  };
}

describe("evaluateAccess", () => {
  it("ignores bots and self", () => {
    expect(evaluateAccess(guildInput({ isBot: true }), baseConfig).allowed).toBe(false);
    expect(evaluateAccess(guildInput({ isSelf: true }), baseConfig).allowed).toBe(false);
  });

  it("allows a listed bot that is not on the user allowlist", () => {
    expect(
      evaluateAccess(
        guildInput({
          isBot: true,
          authorId: "bot-ok",
          channelId: "free",
          botMentioned: false,
        }),
        baseConfig,
      ),
    ).toEqual({ allowed: true });
  });

  it("allows listed users when mentioned", () => {
    expect(evaluateAccess(guildInput(), baseConfig)).toEqual({ allowed: true });
  });

  it("allows users with allowed role", () => {
    expect(
      evaluateAccess(guildInput({ authorId: "other", authorRoleIds: ["r1"] }), baseConfig),
    ).toEqual({ allowed: true });
  });

  it("requires mention outside free channels", () => {
    const d = evaluateAccess(guildInput({ botMentioned: false }), baseConfig);
    expect(d.allowed).toBe(false);
    if (!d.allowed) expect(d.reason).toBe("mention_required");
  });

  it("skips mention in free-response channels", () => {
    expect(
      evaluateAccess(guildInput({ channelId: "free", botMentioned: false }), baseConfig),
    ).toEqual({ allowed: true });
  });

  it("fails closed when no allowlists and allow-all is false", () => {
    const d = evaluateAccess(guildInput(), {
      ...baseConfig,
      allowedUsers: [],
      allowedRoles: [],
    });
    expect(d.allowed).toBe(false);
  });

  it("allow-all bypasses user/role lists", () => {
    expect(
      evaluateAccess(guildInput({ authorId: "anyone" }), {
        ...baseConfig,
        allowAllUsers: true,
        allowedUsers: [],
        allowedRoles: [],
      }),
    ).toEqual({ allowed: true });
  });

  it("rejects guilds not on the allowlist", () => {
    const d = evaluateAccess(guildInput({ guildId: "other" }), {
      ...baseConfig,
      allowedGuilds: ["g1"],
    });
    expect(d.allowed).toBe(false);
    if (!d.allowed) expect(d.reason).toBe("guild_not_allowed");
  });

  it("allows listed guilds", () => {
    expect(
      evaluateAccess(guildInput({ guildId: "g1" }), {
        ...baseConfig,
        allowedGuilds: ["g1"],
      }),
    ).toEqual({ allowed: true });
  });

  it("rejects DMs when disabled", () => {
    const d = evaluateAccess(
      guildInput({ isDm: true, guildId: null, botMentioned: false }),
      baseConfig,
    );
    expect(d.allowed).toBe(false);
    if (!d.allowed) expect(d.reason).toBe("dms_disabled");
  });

  it("allows DMs for allowlisted users without mention", () => {
    expect(
      evaluateAccess(guildInput({ isDm: true, guildId: null, botMentioned: false }), {
        ...baseConfig,
        allowDms: true,
      }),
    ).toEqual({ allowed: true });
  });

  it("dm-only rejects guild messages", () => {
    const d = evaluateAccess(guildInput(), {
      ...baseConfig,
      allowDms: true,
      dmOnly: true,
    });
    expect(d.allowed).toBe(false);
    if (!d.allowed) expect(d.reason).toBe("dm_only");
  });

  it("rejects DMs when only roles are configured", () => {
    const d = evaluateAccess(
      guildInput({ isDm: true, guildId: null, authorId: "anyone", botMentioned: false }),
      {
        ...baseConfig,
        allowDms: true,
        allowedUsers: [],
        allowedRoles: ["r1"],
      },
    );
    expect(d.allowed).toBe(false);
    if (!d.allowed) expect(d.reason).toBe("no_user_allowlist_for_dm");
  });

  it("allows threads under a free-response parent without mention", () => {
    expect(
      evaluateAccess(
        guildInput({
          channelId: "thread-1",
          parentChannelId: "free",
          botMentioned: false,
        }),
        baseConfig,
      ),
    ).toEqual({ allowed: true });
  });

  it("blocks a channel and threads under it even when mentioned", () => {
    const cfg = { ...baseConfig, blockedChannels: ["g1", "g2"] };
    expect(evaluateAccess(guildInput({ channelId: "g1" }), cfg)).toEqual({
      allowed: false,
      reason: "channel_blocked",
    });
    expect(evaluateAccess(guildInput({ channelId: "thread", parentChannelId: "g2" }), cfg)).toEqual({
      allowed: false,
      reason: "channel_blocked",
    });
    expect(evaluateAccess(guildInput({ channelId: "g3" }), cfg).allowed).toBe(true);
  });

  it("allows only listed guild channels when allowedChannels is set", () => {
    const cfg = { ...baseConfig, allowedChannels: ["only"], requireMention: false };
    expect(evaluateAccess(guildInput({ channelId: "only", botMentioned: false }), cfg)).toEqual({
      allowed: true,
    });
    const denied = evaluateAccess(guildInput({ channelId: "other", botMentioned: true }), cfg);
    expect(denied.allowed).toBe(false);
    if (!denied.allowed) expect(denied.reason).toBe("channel_not_allowed");
  });

  it("does not apply allowedChannels to DMs", () => {
    const cfg = { ...baseConfig, allowedChannels: ["only"], allowDms: true };
    expect(
      evaluateAccess(
        guildInput({ isDm: true, channelId: "dm", guildId: null, botMentioned: false }),
        cfg,
      ),
    ).toEqual({ allowed: true });
  });
});
