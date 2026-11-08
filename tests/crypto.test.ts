import { randomBytes } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { decrypt, encrypt } from "@/lib/crypto";

beforeEach(() => vi.stubEnv("CONNECTOR_ENCRYPTION_KEY", randomBytes(32).toString("base64")));
afterEach(() => vi.unstubAllEnvs());

describe("token encryption", () => {
  it("round-trips and never repeats ciphertext", () => {
    const a = encrypt("ghp_secret_token");
    expect(decrypt(a)).toBe("ghp_secret_token");
    expect(a).not.toContain("ghp_secret_token");
    expect(encrypt("ghp_secret_token")).not.toBe(a);
  });
  it("detects tampering", () => {
    const parts = encrypt("hello").split(".");
    parts[3] = Buffer.from("tampered!").toString("base64url");
    expect(() => decrypt(parts.join("."))).toThrow();
  });
  it("cannot be decrypted with another key", () => {
    const c = encrypt("hello");
    vi.stubEnv("CONNECTOR_ENCRYPTION_KEY", randomBytes(32).toString("base64"));
    expect(() => decrypt(c)).toThrow();
  });
  it("refuses a missing or short key", () => {
    vi.stubEnv("CONNECTOR_ENCRYPTION_KEY", "");
    expect(() => encrypt("x")).toThrow(/Missing/);
    vi.stubEnv("CONNECTOR_ENCRYPTION_KEY", Buffer.from("short").toString("base64"));
    expect(() => encrypt("x")).toThrow(/32 bytes/);
  });
});
