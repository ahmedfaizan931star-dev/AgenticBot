import { beforeEach, describe, expect, it, vi } from "vitest";

const rpc = vi.fn();
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => ({ rpc }) }));

import { InsufficientCreditsError, refund, spend } from "@/lib/credits";
import { allow } from "@/lib/ratelimit";

beforeEach(() => rpc.mockReset());

describe("credits", () => {
  it("returns the new balance after spending", async () => {
    rpc.mockResolvedValue({ data: 41, error: null });
    expect(await spend("u", 1, "chat", "ref1")).toBe(41);
    expect(rpc).toHaveBeenCalledWith("spend_credits", { p_user: "u", p_amount: 1, p_reason: "chat", p_ref: "ref1" });
  });
  it("throws InsufficientCreditsError when the database refuses", async () => {
    rpc.mockResolvedValue({ data: null, error: { message: "insufficient_credits" } });
    await expect(spend("u", 5, "x", "r")).rejects.toBeInstanceOf(InsufficientCreditsError);
  });
  it("does not mask other database errors as 'no credits'", async () => {
    rpc.mockResolvedValue({ data: null, error: { message: "connection reset" } });
    await expect(spend("u", 1, "x", "r")).rejects.not.toBeInstanceOf(InsufficientCreditsError);
  });
  it("refund never throws", async () => {
    rpc.mockResolvedValue({ data: null, error: { message: "x" } });
    expect(await refund("u", "r")).toBeNull();
  });
});

describe("rate limit", () => {
  it("allows when under the limit, blocks when over, and fails closed on errors", async () => {
    rpc.mockResolvedValueOnce({ data: true, error: null });
    expect(await allow("k", 5, 60)).toBe(true);
    rpc.mockResolvedValueOnce({ data: false, error: null });
    expect(await allow("k", 5, 60)).toBe(false);
    rpc.mockResolvedValueOnce({ data: null, error: { message: "down" } });
    expect(await allow("k", 5, 60)).toBe(false);
  });
});
