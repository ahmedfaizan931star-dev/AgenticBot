// Replaced at build time by extension/build.mjs from the APP_ORIGIN environment variable.
declare const __APP_ORIGIN__: string;
export const APP_ORIGIN: string = __APP_ORIGIN__;
export const CHANNEL = "agent-hub";

export type PageAction = "ping" | "tool";
export type PageToExt = { action: PageAction; tool?: string; args?: Record<string, unknown> };
export type ExtReply = { ok: true; result: unknown } | { ok: false; error: string };

export type ApprovalKind = "read" | "open" | "navigate" | "click" | "type";
export type ApprovalDetails = {
  kind: ApprovalKind;
  origin?: string;
  title?: string;
  url?: string;
  to?: string;
  target?: string;
  text?: string;
  submit?: boolean;
};
export type Decision = "allow_once" | "allow_site" | "deny";

export type ElementInfo = { ref: number; tag: string; type?: string; label: string; href?: string };
export type PageSnapshot = { title: string; url: string; text: string; truncated: boolean; elements: ElementInfo[] };
export type ElementDescription = { found: boolean; tag?: string; type?: string; label?: string; href?: string; blocked?: boolean };
