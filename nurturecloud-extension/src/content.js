// Isolated-world content script: relays captures to the service worker and
// draws the follow-up sidebar. It can fill NurtureCloud's SMS box but never
// presses send.
(() => {
  const TAG = "fua-capture";

  window.addEventListener("message", (event) => {
    if (event.source !== window || event.data?.tag !== TAG) return;
    const { url, method, status, body } = event.data;
    chrome.runtime.sendMessage({ type: "capture", url, method, status, body }).catch(() => {});
  });

  let config;
  let currentContactId;
  let root;

  const ready = async () => {
    config = await chrome.runtime.sendMessage({ type: "getConfig" });
    buildSidebar();
    watchUrl();
  };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", ready);
  else ready();

  function contactIdFromUrl() {
    try {
      const match = location.href.match(new RegExp(config.contactUrlPattern));
      return match ? match[1] : null;
    } catch {
      return null;
    }
  }

  // NurtureCloud is a single-page app, so watch for client-side navigation.
  function watchUrl() {
    let last = "";
    const check = () => {
      if (location.href === last) return;
      last = location.href;
      const id = contactIdFromUrl();
      if (id !== currentContactId) {
        currentContactId = id;
        refresh();
      }
    };
    setInterval(check, 750);
    check();
  }

  function buildSidebar() {
    const host = document.createElement("div");
    host.id = "fua-sidebar-host";
    document.documentElement.appendChild(host);
    root = host.attachShadow({ mode: "closed" });
    root.innerHTML = `
      <style>
        :host { all: initial; }
        .panel { position: fixed; top: 80px; right: 0; width: 320px; max-height: calc(100vh - 100px);
          overflow: auto; z-index: 2147483646; font: 13px/1.45 system-ui, sans-serif; color: #1d1d1f;
          background: #fff; border: 1px solid #d0d0d6; border-right: 0; border-radius: 10px 0 0 10px;
          box-shadow: 0 6px 24px rgba(0,0,0,.12); }
        .panel.collapsed .body { display: none; }
        header { display: flex; align-items: center; justify-content: space-between; padding: 10px 12px;
          background: #ffe600; border-radius: 10px 0 0 0; font-weight: 600; cursor: pointer; }
        .body { padding: 12px; }
        .label { font-size: 11px; text-transform: uppercase; letter-spacing: .04em; color: #6e6e73; margin-top: 10px; }
        .value { margin-top: 2px; }
        textarea { width: 100%; box-sizing: border-box; min-height: 110px; margin-top: 4px; font: inherit;
          padding: 8px; border: 1px solid #c7c7cc; border-radius: 6px; resize: vertical; }
        .warn { color: #a05a00; background: #fff4e0; border-radius: 6px; padding: 6px 8px; margin-top: 6px; }
        .warn:empty { display: none; }
        .row { display: flex; gap: 6px; margin-top: 8px; }
        button { flex: 1; font: inherit; padding: 7px 8px; border-radius: 6px; border: 1px solid #c7c7cc;
          background: #f5f5f7; cursor: pointer; }
        button.primary { background: #1d1d1f; color: #fff; border-color: #1d1d1f; }
        .muted { color: #6e6e73; }
        .status { margin-top: 8px; font-size: 12px; }
      </style>
      <div class="panel">
        <header><span>Follow-up</span><span class="muted" id="mode"></span></header>
        <div class="body">
          <div id="empty" class="muted">Open a contact to see a suggestion.</div>
          <div id="content" hidden>
            <div class="label">Contact</div><div class="value" id="name"></div>
            <div class="label">Last contacted</div><div class="value" id="last"></div>
            <div class="label">Next action</div><div class="value" id="action"></div>
            <div class="label">Talking point</div><div class="value" id="talk"></div>
            <div class="label">SMS draft</div>
            <textarea id="draft"></textarea>
            <div class="warn" id="warnings"></div>
            <div class="row">
              <button id="regen">New draft</button>
              <button class="primary" id="fill">Put in SMS box</button>
            </div>
            <div class="status muted" id="status"></div>
          </div>
        </div>
      </div>`;
    const $ = (id) => root.getElementById(id);
    root.querySelector("header").addEventListener("click", () => root.querySelector(".panel").classList.toggle("collapsed"));
    $("mode").textContent = config.mode;
    $("draft").addEventListener("input", () => showWarnings($("draft").value));
    $("regen").addEventListener("click", () => refresh(true));
    $("fill").addEventListener("click", fillSmsBox);
  }

  async function refresh(regenerate = false) {
    if (!root) return;
    const $ = (id) => root.getElementById(id);
    $("empty").hidden = !!currentContactId;
    $("content").hidden = !currentContactId;
    if (!currentContactId) return;
    $("status").textContent = "Loading…";
    const res = await chrome.runtime.sendMessage({ type: "suggest", contactId: currentContactId, regenerate, pageUrl: location.href });
    if (!res?.ok) {
      $("status").textContent = res?.error || "No suggestion available.";
      return;
    }
    const s = res.suggestion;
    $("name").textContent = s.contactName || "—";
    $("last").textContent = s.lastContacted || "No contact on record";
    $("action").textContent = s.nextAction || "—";
    $("talk").textContent = s.talkingPoint || "—";
    $("draft").value = s.smsDraft || "";
    showWarnings($("draft").value);
    $("status").textContent = s.reason ? `Why: ${s.reason}` : "";
  }

  async function showWarnings(text) {
    const warnings = await chrome.runtime.sendMessage({ type: "checkDraft", text });
    root.getElementById("warnings").textContent = (warnings || []).join(" ");
  }

  function findSmsBox() {
    for (const selector of config.smsBoxSelectors) {
      const el = [...document.querySelectorAll(selector)].find((e) => e.offsetParent !== null && !e.disabled && !e.readOnly);
      if (el) return el;
    }
    return null;
  }

  // Fills the box the way typing would, so NurtureCloud's own UI picks it up.
  // Sending stays with the agent.
  function fillSmsBox() {
    const status = root.getElementById("status");
    const text = root.getElementById("draft").value;
    const box = findSmsBox();
    if (!box) {
      status.textContent = "Open NurtureCloud's SMS window first, then try again.";
      return;
    }
    box.focus();
    if (box.isContentEditable) {
      document.execCommand("selectAll", false);
      document.execCommand("insertText", false, text);
    } else {
      const proto = box instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(proto, "value").set.call(box, text);
      box.dispatchEvent(new Event("input", { bubbles: true }));
      box.dispatchEvent(new Event("change", { bubbles: true }));
    }
    status.textContent = "Draft placed. Check it, then press NurtureCloud's Send.";
    chrome.runtime.sendMessage({ type: "drafted", contactId: currentContactId }).catch(() => {});
  }
})();
