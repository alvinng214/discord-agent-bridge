import { describe, expect, it } from "vitest";
import { ConversationMemory } from "./memory.js";

describe("ConversationMemory", () => {
  it("caps history length by dropping oldest", () => {
    const mem = new ConversationMemory(2);
    mem.append("c", { role: "user", content: "1" });
    mem.append("c", { role: "assistant", content: "2" });
    mem.append("c", { role: "user", content: "3" });
    expect(mem.get("c").map((m) => m.content)).toEqual(["2", "3"]);
  });
});
