import { clickElement, describeElement, extractPage, typeIntoElement } from "./injected";
import { APP_ORIGIN, type ApprovalDetails, type Decision, type ExtReply, type PageToExt } from "./shared";

const VERSION = chrome.runtime.getManifest().version;
const APPROVAL_TIMEOUT_MS = 120_000;
const MAX_TABS = 50;

type Pending = { details: ApprovalDetails; resolve: (d: Decision) => void; windowId?: number };
const pending = new Map<string, Pending>();

const isHttp = (u?: string) => !!u && /^https?:\/\//i.test(u);
const originOf = (u: string) => new URL(u).origin;

async function isEnabled(): Promise<boolean> {
  const { enabled } = await chrome.storage.local.get("enabled");
  return enabled === true;
}
async function hasTabAccess(): Promise<boolean> {
  return chrome.permissions.contains({ origins: ["<all_urls>"] });
}
async function approvedOrigins(): Promise<string[]> {
  const { readOrigins } = await chrome.storage.session.get("readOrigins");
  return Array.isArray(readOrigins) ? (readOrigins as string[]) : [];
}
async function approveOrigin(origin: string) {
  const list = await approvedOrigins();
  if (!list.includes(origin)) await chrome.storage.session.set({ readOrigins: [...list, origin] });
}

async function askUser(details: ApprovalDetails): Promise<Decision> {
  const rid = crypto.randomUUID();
  return new Promise<Decision>((resolve) => {
    const entry: Pending = { details, resolve };
    pending.set(rid, entry);
    const done = (d: Decision) => {
      if (!pending.has(rid)) return;
      pending.delete(rid);
      resolve(d);
    };
    entry.resolve = done;
    setTimeout(() => done("deny"), APPROVAL_TIMEOUT_MS);
    chrome.windows
      .create({ url: chrome.runtime.getURL(`approve.html?rid=${rid}`), type: "popup", width: 440, height: 580, focused: true })
      .then((w) => {
        entry.windowId = w?.id;
      })
      .catch(() => done("deny"));
  });
}

chrome.windows.onRemoved.addListener((windowId) => {
  for (const [, p] of pending) if (p.windowId === windowId) p.resolve("deny");
});

async function getHttpTab(tabId: unknown) {
  if (typeof tabId !== "number") throw new Error("Invalid tab id");
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  if (!tab || !isHttp(tab.url)) throw new Error("That tab is not available or is not a normal web page.");
  return tab;
}

async function handleTool(tool: string, args: Record<string, unknown>): Promise<unknown> {
  if (!(await isEnabled())) throw new Error("Agent control is turned off. Open the extension icon and turn it on.");
  if (!(await hasTabAccess())) throw new Error("Tab access has not been granted. Open the extension icon and tap Grant tab access.");

  switch (tool) {
    case "browser_list_tabs": {
      const tabs = await chrome.tabs.query({});
      return tabs
        .filter((t) => isHttp(t.url) && typeof t.id === "number")
        .slice(0, MAX_TABS)
        .map((t) => ({ id: t.id, title: (t.title ?? "").slice(0, 120), url: (t.url ?? "").slice(0, 200), active: !!t.active }));
    }
    case "browser_read_tab": {
      const tab = await getHttpTab(args.tabId);
      const origin = originOf(tab.url!);
      if (!(await approvedOrigins()).includes(origin)) {
        const d = await askUser({ kind: "read", origin, title: tab.title, url: tab.url });
        if (d === "deny") throw new Error("The user denied access to this site.");
        if (d === "allow_site") await approveOrigin(origin);
      }
      const max = typeof args.maxChars === "number" ? Math.min(Math.max(args.maxChars, 500), 20000) : 8000;
      const [res] = await chrome.scripting.executeScript({ target: { tabId: tab.id! }, func: extractPage, args: [max] });
      return res?.result ?? { error: "No content" };
    }
    case "browser_open_tab": {
      const url = String(args.url ?? "");
      if (!isHttp(url)) throw new Error("Only http(s) links can be opened.");
      if ((await askUser({ kind: "open", to: url })) === "deny") throw new Error("The user denied this action.");
      const tab = await chrome.tabs.create({ url, active: true });
      return { tabId: tab.id, url };
    }
    case "browser_navigate": {
      const tab = await getHttpTab(args.tabId);
      const url = String(args.url ?? "");
      if (!isHttp(url)) throw new Error("Only http(s) links can be opened.");
      if ((await askUser({ kind: "navigate", title: tab.title, url: tab.url, to: url })) === "deny") throw new Error("The user denied this action.");
      await chrome.tabs.update(tab.id!, { url });
      return { tabId: tab.id, url };
    }
    case "browser_click":
    case "browser_type": {
      const tab = await getHttpTab(args.tabId);
      const ref = args.ref;
      if (typeof ref !== "number") throw new Error("Invalid element ref");
      const [d] = await chrome.scripting.executeScript({ target: { tabId: tab.id! }, func: describeElement, args: [ref] });
      const el = d?.result;
      if (!el?.found) throw new Error("Element not found. Read the tab again to get fresh refs.");
      const target = `${el.tag ?? "element"}${el.label ? ` “${el.label}”` : ""}${el.href ? ` → ${el.href}` : ""}`;
      if (tool === "browser_click") {
        if ((await askUser({ kind: "click", title: tab.title, url: tab.url, target })) === "deny") throw new Error("The user denied this action.");
        const [r] = await chrome.scripting.executeScript({ target: { tabId: tab.id! }, func: clickElement, args: [ref] });
        return { clicked: r?.result === true };
      }
      if (el.blocked) throw new Error("Typing into password, card or one-time-code fields is not allowed.");
      const text = String(args.text ?? "").slice(0, 2000);
      const submit = args.submit === true;
      if ((await askUser({ kind: "type", title: tab.title, url: tab.url, target, text, submit })) === "deny") throw new Error("The user denied this action.");
      const [r] = await chrome.scripting.executeScript({ target: { tabId: tab.id! }, func: typeIntoElement, args: [ref, text, submit] });
      return { typed: r?.result === true };
    }
    default:
      throw new Error("Unknown tool");
  }
}

async function handlePage(payload: PageToExt): Promise<ExtReply> {
  try {
    if (payload.action === "ping") {
      return { ok: true, result: { version: VERSION, enabled: await isEnabled(), tabAccess: await hasTabAccess() } };
    }
    if (payload.action === "tool" && typeof payload.tool === "string") {
      return { ok: true, result: await handleTool(payload.tool, payload.args ?? {}) };
    }
    return { ok: false, error: "Bad request" };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Failed" };
  }
}

const fromAppPage = (s: chrome.runtime.MessageSender) =>
  s.id === chrome.runtime.id && s.frameId === 0 && typeof s.url === "string" && (s.url === APP_ORIGIN || s.url.startsWith(APP_ORIGIN + "/"));
const fromExtensionPage = (s: chrome.runtime.MessageSender, page: string) =>
  s.id === chrome.runtime.id && typeof s.url === "string" && s.url.startsWith(chrome.runtime.getURL(page));

chrome.runtime.onMessage.addListener((msg: unknown, sender, sendResponse) => {
  const m = msg as { kind?: string; payload?: PageToExt; rid?: string; decision?: Decision } | null;
  if (!m || typeof m.kind !== "string") return false;

  if (m.kind === "page-request" && m.payload && fromAppPage(sender)) {
    void handlePage(m.payload).then(sendResponse);
    return true;
  }
  if (m.kind === "get-approval" && fromExtensionPage(sender, "approve.html")) {
    sendResponse(m.rid ? (pending.get(m.rid)?.details ?? null) : null);
    return false;
  }
  if (m.kind === "approval-decision" && fromExtensionPage(sender, "approve.html") && m.rid) {
    const p = pending.get(m.rid);
    if (p) {
      const allowed: Decision[] = p.details.kind === "read" ? ["allow_once", "allow_site", "deny"] : ["allow_once", "deny"];
      p.resolve(m.decision && allowed.includes(m.decision) ? m.decision : "deny");
    }
    sendResponse(true);
    return false;
  }
  return false;
});
