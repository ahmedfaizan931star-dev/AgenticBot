import { APP_ORIGIN } from "./shared";

const $ = (id: string) => document.getElementById(id) as HTMLElement;
const toggle = $("enabled") as HTMLInputElement;

async function render() {
  const { enabled } = await chrome.storage.local.get("enabled");
  toggle.checked = enabled === true;
  const access = await chrome.permissions.contains({ origins: ["<all_urls>"] });
  $("access").textContent = access ? "Tab access: granted" : "Tab access: not granted";
  $("grant").toggleAttribute("hidden", access);
  const { readOrigins } = await chrome.storage.session.get("readOrigins");
  const sites = Array.isArray(readOrigins) ? (readOrigins as string[]) : [];
  $("sites").textContent = sites.length ? sites.join("\n") : "No sites approved in this session.";
  $("clear").toggleAttribute("hidden", sites.length === 0);
}

toggle.addEventListener("change", () => void chrome.storage.local.set({ enabled: toggle.checked }));
$("grant").addEventListener("click", () => {
  void chrome.permissions.request({ origins: ["<all_urls>"] }).then(render);
});
$("revoke").addEventListener("click", () => {
  void chrome.permissions.remove({ origins: ["<all_urls>"] }).then(render);
});
$("clear").addEventListener("click", () => void chrome.storage.session.remove("readOrigins").then(render));
$("open").addEventListener("click", () => void chrome.tabs.create({ url: APP_ORIGIN + "/chat" }));
$("origin").textContent = APP_ORIGIN;
void render();
