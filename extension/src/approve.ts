import type { ApprovalDetails, Decision } from "./shared";

const rid = new URLSearchParams(location.search).get("rid") ?? "";
const $ = (id: string) => document.getElementById(id) as HTMLElement;

function row(label: string, value?: string) {
  if (!value) return;
  const wrap = document.createElement("div");
  wrap.className = "row";
  const l = document.createElement("span");
  l.className = "label";
  l.textContent = label;
  const v = document.createElement("div");
  v.className = "value";
  v.textContent = value;
  wrap.append(l, v);
  $("details").append(wrap);
}

function decide(decision: Decision) {
  void chrome.runtime.sendMessage({ kind: "approval-decision", rid, decision }).finally(() => window.close());
}

async function init() {
  const d = (await chrome.runtime.sendMessage({ kind: "get-approval", rid })) as ApprovalDetails | null;
  if (!d) {
    $("title").textContent = "This request has expired";
    $("allow").setAttribute("hidden", "");
    $("site").setAttribute("hidden", "");
    return;
  }
  const titles = {
    read: "Let the agent read this page?",
    open: "Open a new tab?",
    navigate: "Send this tab to a new address?",
    click: "Click this on the page?",
    type: "Type this into the page?",
  } as const;
  $("title").textContent = titles[d.kind];
  if (d.kind === "read") {
    row("Site", d.origin);
    row("Page", d.title);
    $("site").removeAttribute("hidden");
  } else if (d.kind === "open") {
    row("Opens", d.to);
  } else if (d.kind === "navigate") {
    row("Tab", d.title);
    row("From", d.url);
    row("To", d.to);
  } else {
    row("Page", d.title);
    row("Address", d.url);
    row("Element", d.target);
    if (d.kind === "type") {
      row("Text", d.text);
      if (d.submit) row("Then", "Press Enter / submit the form");
    }
  }
  $("allow").removeAttribute("hidden");
  setTimeout(() => ($("allow") as HTMLButtonElement).removeAttribute("disabled"), 700);
}

$("allow").addEventListener("click", () => decide("allow_once"));
$("site").addEventListener("click", () => decide("allow_site"));
$("deny").addEventListener("click", () => decide("deny"));
void init();
