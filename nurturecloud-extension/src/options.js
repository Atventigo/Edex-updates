import { DEFAULTS } from "./config.js";
import { DEFAULTS as EXAMPLE_ENDPOINTS } from "./data/endpoints.example.js";

const LIST_FIELDS = ["captureUrlPatterns", "ignoreUrlPatterns", "smsBoxSelectors", "requiredSmsPhrases"];
const TEXT_FIELDS = ["mode", "agentName", "backendUrl", "backendKey", "contactUrlPattern"];
const NUM_FIELDS = ["callListLimit"];
const $ = (id) => document.getElementById(id);

async function load() {
  const { config = {} } = await chrome.storage.local.get("config");
  const c = { ...DEFAULTS, ...config };
  for (const f of TEXT_FIELDS) $(f).value = c[f];
  for (const f of NUM_FIELDS) $(f).value = c[f];
  for (const f of LIST_FIELDS) $(f).value = c[f].join("\n");
  $("endpointsConfig").value = JSON.stringify(c.endpoints || EXAMPLE_ENDPOINTS, null, 2);
  showEndpoints();
}

async function save() {
  const config = {};
  for (const f of TEXT_FIELDS) config[f] = $(f).value.trim();
  for (const f of NUM_FIELDS) config[f] = Number($(f).value) || DEFAULTS[f];
  for (const f of LIST_FIELDS) config[f] = $(f).value.split("\n").map((s) => s.trim()).filter(Boolean);
  try {
    config.endpoints = JSON.parse($("endpointsConfig").value || "null");
  } catch (e) {
    return ($("saved").textContent = ` Endpoints JSON is invalid: ${e.message}`);
  }
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
