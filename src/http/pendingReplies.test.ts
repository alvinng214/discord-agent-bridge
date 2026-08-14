import { describe, expect, it } from "vitest";
import { PendingReplyStore } from "./pendingReplies.js";

describe("PendingReplyStore.complete", () => {
  it("does not resolve generate() when delivery fails, and a later retry can succeed", async () => {
    const pending = new PendingReplyStore();
    let attempts = 0;
    const waiter = pending.register("id-1", 5_000, async () => {
      attempts += 1;
      if (attempts === 1) throw new Error("transient discord error");
    });

    await expect(pending.complete("id-1", "retry me")).resolves.toBe("delivery_failed");
    expect(pending.has("id-1")).toBe(true);

    let settled = false;
    void waiter.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(settled).toBe(false);

    await expect(pending.complete("id-1", "retry me")).resolves.toBe("ok");
    await expect(waiter).resolves.toBe("retry me");
    expect(attempts).toBe(2);
    expect(pending.has("id-1")).toBe(false);
  });
});
