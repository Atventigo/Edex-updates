// Lead scoring: who should an agent contact today, and how?
// Philosophy: additive, explainable points. Each rule that fires adds a weight
// and a human-readable reason; buckets come from the strongest signal, not
// from the number alone. "Too soon" and do-not-contact are hard gates.
// Pure and deterministic: all time comes from the `now` argument.

// --- Weights (points added to priority, clamped to 0..100) ---
export const W_AWAITING_REPLY = 55;   // they replied, we haven't answered
export const W_NEVER_SELLER = 50;     // never contacted, seller/vendor stage
export const W_NEVER_BUYER = 25;      // never contacted, buyer stage
export const W_NEVER_OTHER = 15;      // never contacted, any other stage
export const W_VAULT_EVENT = 25;      // listing/sale on their street, recent
export const W_WARM_SILENT = 35;      // responded before, silent 30-90 days
export const W_WARM_LAPSED = 15;      // responded before, silent > 90 days
export const W_COLD_SILENT = 5;       // never responded, silent > 90 days
export const W_ROUTINE = 10;          // contacted 2-30 days ago, no action due
export const W_SELLER_STAGE = 10;     // seller stage bonus on nurture rules

// --- Thresholds ---
export const TOO_SOON_DAYS = 2;
export const VAULT_WINDOW_DAYS = 14;
export const WARM_SILENT_MIN_DAYS = 30;
export const WARM_SILENT_MAX_DAYS = 90;
export const CALL_TODAY_THRESHOLD = 60;   // nurture promoted to call_today at/above this
export const CALL_CHANNEL_THRESHOLD = 45; // warm-silent leads at/above this suggest a call
export const COLD_SKIP_ATTEMPTS = 4;      // cold lead with this many attempts -> skip

const DAY = 86400000;

const ts = (v) => {
  if (v == null || v === "") return null;
  const t = new Date(v).getTime();
  return Number.isNaN(t) ? null : t;
};
const iso = (t) => new Date(t).toISOString();
const clamp = (n) => Math.max(0, Math.min(100, Math.round(n)));
const maxOf = (...xs) => {
  const ok = xs.filter((x) => x != null);
  return ok.length ? Math.max(...ok) : null;
};
const isSeller = (stage) => /seller|vendor/i.test(stage || "");
const isBuyer = (stage) => /buyer|purchaser/i.test(stage || "");

const SUFFIXES = {
  st: "street", street: "street", rd: "road", road: "road", ave: "avenue", av: "avenue",
  avenue: "avenue", dr: "drive", drive: "drive", ct: "court", court: "court", pl: "place",
  place: "place", ln: "lane", lane: "lane", cres: "crescent", crescent: "crescent",
  blvd: "boulevard", boulevard: "boulevard", tce: "terrace", terrace: "terrace",
  pde: "parade", parade: "parade", hwy: "highway", highway: "highway", cl: "close", close: "close",
};

// "12/34 Smith St, Newtown" -> "smith street"
export function normalizeStreet(text) {
  if (!text) return "";
  let s = String(text).split(",")[0].toLowerCase().replace(/[.]/g, " ").trim();
  s = s.replace(/^(unit|apt|apartment|lot)?\s*[\d/]+[a-z]?\s+/, "");
  const words = s.split(/\s+/).filter(Boolean).map((w) => SUFFIXES[w] || w);
  return words.join(" ");
}

const leadStreet = (lead) => normalizeStreet(lead.street || lead.address);

// Latest contact timestamps, from the lead fields and the message log.
function timeline(lead, messages) {
  const out = messages.filter((m) => m.direction === "out").map((m) => ts(m.at));
  const inn = messages.filter((m) => m.direction === "in").map((m) => ts(m.at));
  return {
    lastOut: maxOf(ts(lead.lastContactedAt), ...out),
    lastIn: maxOf(ts(lead.lastInboundAt), ...inn),
    hasInbound: inn.some((t) => t != null),
  };
}

// Closest listed/sold event on the lead's street within the window.
function findVaultEvent(lead, vaultEvents, nowMs) {
  const street = leadStreet(lead);
  if (!street) return null;
  let best = null;
  for (const ev of vaultEvents || []) {
    if (ev.type !== "listed" && ev.type !== "sold") continue;
    const t = ts(ev.date);
    if (t == null || normalizeStreet(ev.address) !== street) continue;
    const gap = Math.abs(nowMs - t);
    if (gap > VAULT_WINDOW_DAYS * DAY) continue;
    if (!best || gap < best.gap) best = { ev, gap, t };
  }
  return best;
}

function ago(nowMs, t) {
  const d = Math.round((nowMs - t) / DAY);
  if (d === 0) return "today";
  return d > 0 ? `${d} day${d === 1 ? "" : "s"} ago` : `in ${-d} day${d === -1 ? "" : "s"}`;
}

export function scoreLead(lead, messages = [], vaultEvents = [], now = new Date()) {
  const nowMs = new Date(now).getTime();
  const result = (priority, bucket, reasons, suggestedChannel, nextActionAt) => ({
    contactId: lead.id,
    priority: clamp(priority), bucket, reasons, suggestedChannel,
    nextActionAt: nextActionAt == null ? null : iso(nextActionAt),
  });

  if (lead.doNotContact) {
    return result(0, "skip", ["Marked do not contact"], "sms", null);
  }

  const { lastOut, lastIn, hasInbound } = timeline(lead, messages || []);
  const reasons = [];
  let priority = 0;
  let bucket = "nurture";
  let call = false;
  let nextAt = nowMs;

  const awaiting = lastIn != null && (lastOut == null || lastIn > lastOut);
  const warm = Boolean(lead.responded) || lastIn != null || hasInbound;

  // Hard gate: too soon, unless they replied and are waiting on us.
  if (lastOut != null && !awaiting && nowMs - lastOut < TOO_SOON_DAYS * DAY) {
    return result(0, "skip", ["Contacted recently (too soon)"], "sms", lastOut + TOO_SOON_DAYS * DAY);
  }

  const vault = findVaultEvent(lead, vaultEvents, nowMs);
  let silentDays = null;

  if (awaiting) {
    priority += W_AWAITING_REPLY;
    bucket = "call_today";
    call = true;
    reasons.push(`Replied ${ago(nowMs, lastIn)} and we haven't answered`);
  } else if (lastOut == null) {
    if (isSeller(lead.stage)) {
      priority += W_NEVER_SELLER;
      bucket = "call_today";
      call = true;
      reasons.push("Never contacted seller lead");
    } else if (isBuyer(lead.stage)) {
      priority += W_NEVER_BUYER;
      reasons.push("Never contacted buyer lead");
    } else {
      priority += W_NEVER_OTHER;
      reasons.push("Never contacted");
    }
  } else {
    const lastTouch = maxOf(lastOut, lastIn);
    silentDays = Math.floor((nowMs - lastTouch) / DAY);
    const sellerBonus = isSeller(lead.stage) ? W_SELLER_STAGE : 0;
    if (warm && silentDays >= WARM_SILENT_MIN_DAYS && silentDays <= WARM_SILENT_MAX_DAYS) {
      priority += W_WARM_SILENT + sellerBonus;
      reasons.push(`Warm lead silent for ${silentDays} days`);
      if (sellerBonus) reasons.push("Seller stage");
    } else if (silentDays > WARM_SILENT_MAX_DAYS) {
      if (warm) {
        priority += W_WARM_LAPSED + sellerBonus;
        reasons.push(`Warm lead lapsed (${silentDays} days silent)`);
      } else if ((lead.smsCount || 0) + (lead.callCount || 0) >= COLD_SKIP_ATTEMPTS) {
        reasons.push(`No response after ${(lead.smsCount || 0) + (lead.callCount || 0)} attempts, ${silentDays} days silent`);
        bucket = "skip";
        nextAt = null;
      } else {
        priority += W_COLD_SILENT;
        reasons.push(`Never responded, ${silentDays} days silent`);
        nextAt = nowMs + 30 * DAY;
      }
    } else {
      priority += W_ROUTINE;
      reasons.push(`Contacted ${silentDays} days ago, no action due yet`);
      nextAt = lastTouch + WARM_SILENT_MIN_DAYS * DAY;
    }
  }

  if (vault && bucket !== "skip") {
    const label = vault.ev.type === "sold" ? "Sold" : "Listed";
    priority += W_VAULT_EVENT;
    call = true;
    nextAt = nowMs;
    reasons.push(`${label} on their street: ${vault.ev.address} (${ago(nowMs, vault.t)})`);
    if (bucket === "nurture" && priority >= CALL_TODAY_THRESHOLD) bucket = "call_today";
  }

  if (bucket === "nurture" && warm && silentDays != null && silentDays >= WARM_SILENT_MIN_DAYS
      && silentDays <= WARM_SILENT_MAX_DAYS && priority >= CALL_CHANNEL_THRESHOLD) {
    call = true; // nurture, but leaning call
  }

  return result(priority, bucket, reasons, call ? "call" : "sms", nextAt);
}

const byNext = (a, b) => {
  if (a.nextActionAt === b.nextActionAt) return 0;
  if (a.nextActionAt == null) return 1;
  if (b.nextActionAt == null) return -1;
  return a.nextActionAt < b.nextActionAt ? -1 : 1;
};

// Priority desc, then earliest nextActionAt (null last), then contactId.
export function rankLeads(scored) {
  return [...scored].sort((a, b) =>
    b.priority - a.priority
    || byNext(a, b)
    || String(a.contactId ?? "").localeCompare(String(b.contactId ?? "")));
}

export function dailyCallList(scored, limit) {
  const list = rankLeads(scored).filter((s) => s.bucket === "call_today");
  return Number.isFinite(limit) ? list.slice(0, Math.max(0, limit)) : list;
}
