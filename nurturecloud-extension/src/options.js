import { DEFAULTS } from "./config.js";

const LIST_FIELDS = ["captureUrlPatterns", "ignoreUrlPatterns", "smsBoxSelectors", "requiredSmsPhrases"];
const TEXT_FIELDS = ["mode", "backendUrl", "backendKey", "contactUrlPattern"];
const $ = (id) => document.getElementById(id);

async function load() {
  const { config = {} } = await chrome.storage.local.get("config");
  const c = { ...DEFAULTS, ...config };
  for (const f of TEXT_FIELDS) $(f).value = c[f];
  for (const f of LIST_FIELDS) $(f).value = c[f].join("\n");
  showEndpoints();
}

async function save() {
  const config = {};
  for (const f of TEXT_FIELDS) config[f] = $(f).value.trim();
  for (const f of LIST_FIELDS) config[f] = $(f).value.split("\n").map((s) => s.trim()).filter(Boolean);
  if (config.backendUrl) {
    const origin = new URL(config.backendUrl).origin + "/*";
    const granted = await chrome.permissions.request({ origins: [origin] });
    if (!granted) return ($("saved").textContent = " Backend permission denied.");
  }
  await chrome.storage.local.set({ config });
  $("saved").textContent = " Saved. Reload NurtureCloud tabs to apply.";
}

async function showEndpoints() {
  const endpoints = await chrome.runtime.sendMessage({ type: "getEndpoints" });
  $("endpoints").textContent = JSON.stringify(endpoints, null, 2);
  return endpoints;
}

$("save").addEventListener("click", save);
$("refresh").addEventListener("click", showEndpoints);
$("clear").addEventListener("click", async () => {
  await chrome.runtime.sendMessage({ type: "clearEndpoints" });
  showEndpoints();
});
$("export").addEventListener("click", async () => {
  const blob = new Blob([JSON.stringify(await showEndpoints(), null, 2)], { type: "application/json" });
  const a = Object.assign(document.createElement("a"), { href: URL.createObjectURL(blob), download: "nurturecloud-endpoints.json" });
  a.click();
});
load();
