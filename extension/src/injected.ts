// These functions are serialized and run inside web pages via chrome.scripting.executeScript.
// They must stay self-contained: no imports or references to outer scope.
import type { ElementDescription, PageSnapshot } from "./shared";

export function extractPage(maxChars: number): PageSnapshot {
  const selector = 'a[href],button,input,select,textarea,[role="button"],[role="link"],[role="tab"],[contenteditable="true"]';
  document.querySelectorAll("[data-agent-ref]").forEach((e) => e.removeAttribute("data-agent-ref"));
  const elements: PageSnapshot["elements"] = [];
  let n = 0;
  for (const el of Array.from(document.querySelectorAll<HTMLElement>(selector))) {
    if (n >= 80) break;
    const rect = el.getBoundingClientRect();
    const style = getComputedStyle(el);
    if (rect.width < 2 || rect.height < 2 || style.visibility === "hidden" || style.display === "none") continue;
    const input = el as HTMLInputElement;
    if (input.type === "hidden") continue;
    const raw =
      el.getAttribute("aria-label") ||
      el.innerText ||
      input.placeholder ||
      (input.type === "submit" || input.type === "button" ? input.value : "") ||
      el.getAttribute("title") ||
      input.name ||
      "";
    el.setAttribute("data-agent-ref", String(n));
    const anchor = el as HTMLAnchorElement;
    elements.push({
      ref: n,
      tag: el.tagName.toLowerCase(),
      type: input.type || undefined,
      label: raw.replace(/\s+/g, " ").trim().slice(0, 80),
      href: anchor.href ? String(anchor.href).slice(0, 200) : undefined,
    });
    n++;
  }
  const text = (document.body ? document.body.innerText : "").replace(/\n{3,}/g, "\n\n").trim();
  return { title: document.title, url: location.href, text: text.slice(0, maxChars), truncated: text.length > maxChars, elements };
}

export function describeElement(ref: number): ElementDescription {
  const el = document.querySelector<HTMLElement>('[data-agent-ref="' + ref + '"]');
  if (!el) return { found: false };
  const input = el as HTMLInputElement;
  const hint = [input.name, input.id, input.getAttribute("autocomplete"), input.getAttribute("aria-label")].join(" ").toLowerCase();
  const blocked =
    input.type === "password" || /(cc-|one-time-code|current-password|new-password|\bcvv\b|\bcvc\b|\botp\b|\bssn\b|card.?number)/.test(hint);
  const anchor = el as HTMLAnchorElement;
  return {
    found: true,
    tag: el.tagName.toLowerCase(),
    type: input.type || undefined,
    label: (el.getAttribute("aria-label") || el.innerText || input.placeholder || input.name || "").replace(/\s+/g, " ").trim().slice(0, 80),
    href: anchor.href ? String(anchor.href).slice(0, 200) : undefined,
    blocked,
  };
}

export function clickElement(ref: number): boolean {
  const el = document.querySelector<HTMLElement>('[data-agent-ref="' + ref + '"]');
  if (!el) return false;
  el.scrollIntoView({ block: "center" });
  el.click();
  return true;
}

export function typeIntoElement(ref: number, text: string, submit: boolean): boolean {
  const el = document.querySelector<HTMLElement>('[data-agent-ref="' + ref + '"]');
  if (!el) return false;
  const input = el as HTMLInputElement;
  const hint = [input.name, input.id, input.getAttribute("autocomplete")].join(" ").toLowerCase();
  if (input.type === "password" || /(cc-|one-time-code|current-password|new-password|\bcvv\b|\bcvc\b|\botp\b)/.test(hint)) return false;
  el.focus();
  if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
    const proto = el instanceof HTMLInputElement ? HTMLInputElement.prototype : HTMLTextAreaElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
    if (setter) setter.call(el, text);
    else el.value = text;
  } else {
    el.textContent = text;
  }
  el.dispatchEvent(new Event("input", { bubbles: true }));
  el.dispatchEvent(new Event("change", { bubbles: true }));
  if (submit) {
    const form = el.closest("form");
    if (form) form.requestSubmit();
    else {
      el.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", code: "Enter", bubbles: true }));
      el.dispatchEvent(new KeyboardEvent("keyup", { key: "Enter", code: "Enter", bubbles: true }));
    }
  }
  return true;
}
