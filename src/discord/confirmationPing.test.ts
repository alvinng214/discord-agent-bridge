import { describe, expect, it } from "vitest";
import { isConfirmationPing, isSection9AnalystPage } from "./confirmationPing.js";

describe("isConfirmationPing", () => {
  it("drops confirmation and probe echoes", () => {
    expect(isConfirmationPing("confirmed, stopping")).toBe(true);
    expect(isConfirmationPing("ping-pong")).toBe(true);
    expect(isConfirmationPing("applied universally")).toBe(true);
  });

  it("does not treat a Section 9 analyst page as a ping", () => {
    const page = "Section 9 earnings transcript analyst loop update";
    expect(isSection9AnalystPage(page)).toBe(true);
    expect(isConfirmationPing(page)).toBe(false);
  });

  it("lets a bridge probe request through", () => {
    expect(isConfirmationPing("Reply exactly: bridge probe ok")).toBe(false);
  });
});
