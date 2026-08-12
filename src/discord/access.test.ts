import { describe, expect, it } from "vitest";
import { evaluateAccess } from "./access.js";

const baseConfig = {
  allowAllUsers: false,
  allowedUsers: ["u1"],
  allowedRoles: ["r1"],
  freeResponseChannels: ["free"],
  requireMention: true,
};

describe("evaluateAccess", () => {
  it("ignores bots and self", () => {
    expect(
      evaluateAccess(
        {
          authorId: "u1",
          authorRoleIds: [],
          channelId: "c",
          botMentioned: true,
          isBot: true,
          isSelf: false,
        },
        baseConfig,
      ).allowed,
    ).toBe(false);
  });

  it("allows listed users when mentioned", () => {
    const d = evaluateAccess(
      {
        authorId: "u1",
        authorRoleIds: [],
        channelId: "c",
        botMentioned: true,
        isBot: false,
        isSelf: false,
      },
      baseConfig,
    );
    expect(d).toEqual({ allowed: true });
  });

  it("allows users with allowed role", () => {
    const d = evaluateAccess(
      {
        authorId: "other",
        authorRoleIds: ["r1"],
        channelId: "c",
        botMentioned: true,
        isBot: false,
        isSelf: false,
      },
      baseConfig,
    );
    expect(d).toEqual({ allowed: true });
  });

  it("requires mention outside free channels", () => {
    const d = evaluateAccess(
      {
        authorId: "u1",
        authorRoleIds: [],
        channelId: "c",
        botMentioned: false,
        isBot: false,
        isSelf: false,
      },
      baseConfig,
    );
    expect(d.allowed).toBe(false);
    if (!d.allowed) expect(d.reason).toBe("mention_required");
  });

  it("skips mention in free-response channels", () => {
    const d = evaluateAccess(
      {
        authorId: "u1",
        authorRoleIds: [],
        channelId: "free",
        botMentioned: false,
        isBot: false,
        isSelf: false,
      },
      baseConfig,
    );
    expect(d).toEqual({ allowed: true });
  });

  it("fails closed when no allowlists and allow-all is false", () => {
    const d = evaluateAccess(
      {
        authorId: "u1",
        authorRoleIds: [],
        channelId: "c",
        botMentioned: true,
        isBot: false,
        isSelf: false,
      },
      { ...baseConfig, allowedUsers: [], allowedRoles: [] },
    );
    expect(d.allowed).toBe(false);
  });

  it("allow-all bypasses user/role lists", () => {
    const d = evaluateAccess(
      {
        authorId: "anyone",
        authorRoleIds: [],
        channelId: "c",
        botMentioned: true,
        isBot: false,
        isSelf: false,
      },
      { ...baseConfig, allowAllUsers: true, allowedUsers: [], allowedRoles: [] },
    );
    expect(d).toEqual({ allowed: true });
  });
});
