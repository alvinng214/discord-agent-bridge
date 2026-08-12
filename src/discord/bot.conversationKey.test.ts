import { describe, expect, it } from "vitest";
import { conversationKey } from "./bot.js";
import type { Message } from "discord.js";

function fakeMessage(partial: {
  channelId: string;
  isThread: boolean;
}): Message {
  return {
    channelId: partial.channelId,
    channel: {
      isThread: () => partial.isThread,
      name: partial.isThread ? "thread-title" : "7dtd",
    },
  } as unknown as Message;
}

describe("conversationKey", () => {
  it("scopes memory to the thread id", () => {
    expect(conversationKey(fakeMessage({ channelId: "t1", isThread: true }))).toBe(
      "thread:t1",
    );
  });

  it("scopes memory to the channel id outside threads", () => {
    expect(conversationKey(fakeMessage({ channelId: "c1", isThread: false }))).toBe(
      "channel:c1",
    );
  });

  it("does not reuse the parent channel key for a thread", () => {
    const parent = conversationKey(fakeMessage({ channelId: "parent", isThread: false }));
    const thread = conversationKey(fakeMessage({ channelId: "child", isThread: true }));
    expect(thread).not.toBe(parent);
    expect(thread).not.toContain("parent");
  });
});
