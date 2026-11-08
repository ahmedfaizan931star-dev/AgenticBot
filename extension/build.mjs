import { build } from "esbuild";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(fileURLToPath(import.meta.url));
const dist = path.join(root, "dist");
const raw = process.env.APP_ORIGIN;

if (!raw) {
  console.error("APP_ORIGIN is required, e.g. APP_ORIGIN=https://your-app.vercel.app npm run build:extension");
  process.exit(1);
}
let origin;
try {
  const u = new URL(raw);
  origin = u.origin;
  const local = u.protocol === "http:" && (u.hostname === "localhost" || u.hostname === "127.0.0.1");
  if (u.protocol !== "https:" && !(local && process.env.ALLOW_LOCAL === "1")) throw new Error("APP_ORIGIN must be https (http://localhost only with ALLOW_LOCAL=1)");
  if (u.pathname !== "/" || u.search || u.hash) throw new Error("APP_ORIGIN must be an origin only, without a path");
} catch (e) {
  console.error(String(e.message ?? e));
  process.exit(1);
}

fs.rmSync(dist, { recursive: true, force: true });
fs.mkdirSync(dist, { recursive: true });

await build({
  entryPoints: ["background", "content", "approve", "popup"].map((n) => path.join(root, "src", `${n}.ts`)),
  outdir: dist,
  bundle: true,
  format: "iife",
  target: "chrome114",
  platform: "browser",
  define: { __APP_ORIGIN__: JSON.stringify(origin) },
  legalComments: "none",
  logLevel: "info",
});

for (const f of ["approve.html", "popup.html", "style.css"]) fs.copyFileSync(path.join(root, "src", f), path.join(dist, f));
const icons = path.join(root, "icons");
const hasIcons = fs.existsSync(icons);
if (hasIcons) fs.cpSync(icons, path.join(dist, "icons"), { recursive: true });

const pkg = JSON.parse(fs.readFileSync(path.join(root, "..", "package.json"), "utf8"));
const manifest = {
  manifest_version: 3,
  name: "Agent Hub Bridge",
  version: pkg.version,
  description: "Lets your Agent Hub assistant read and use your tabs, only after you approve each action.",
  minimum_chrome_version: "114",
  permissions: ["storage", "scripting"],
  optional_host_permissions: ["<all_urls>"],
  background: { service_worker: "background.js" },
  content_scripts: [{ matches: [`${origin}/*`], js: ["content.js"], run_at: "document_start" }],
  action: { default_popup: "popup.html", default_title: "Agent Hub" },
  ...(hasIcons ? { icons: { 16: "icons/16.png", 48: "icons/48.png", 128: "icons/128.png" } } : {}),
};
fs.writeFileSync(path.join(dist, "manifest.json"), JSON.stringify(manifest, null, 2));
console.log(`Extension built for ${origin} -> ${dist}`);
