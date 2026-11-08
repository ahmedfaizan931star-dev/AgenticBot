import { describe, expect, it } from "vitest";
import { validateBrowserCall } from "@/lib/agent/tools";

describe("validateBrowserCall", () => {
  it("accepts valid calls", () => {
    expect(validateBrowserCall("browser_list_tabs", {}).ok).toBe(true);
    expect(validateBrowserCall("browser_click", { tabId: 3, ref: 7 }).ok).toBe(true);
    expect(validateBrowserCall("browser_open_tab", { url: "https://example.com" }).ok).toBe(true);
  });
  it("rejects unknown tools, extra fields and bad types", () => {
    expect(validateBrowserCall("browser_exec", {}).ok).toBe(false);
    expect(validateBrowserCall("browser_list_tabs", { x: 1 }).ok).toBe(false);
    expect(validateBrowserCall("browser_click", { tabId: "3", ref: 7 }).ok).toBe(false);
    expect(validateBrowserCall("browser_type", { tabId: 1, ref: 1, text: "x".repeat(2001) }).ok).toBe(false);
  });
  it("blocks non-http URLs", () => {
    expect(validateBrowserCall("browser_open_tab", { url: "javascript:alert(1)" }).ok).toBe(false);
    expect(validateBrowserCall("browser_navigate", { tabId: 1, url: "file:///etc/passwd" }).ok).toBe(false);
  });
});
