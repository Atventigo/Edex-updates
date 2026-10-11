// The decision layer: who to call today, and what to say to one contact.
// No chrome.* APIs here; the store and backend are injected so this can be
// tested with fakes. background.js wires in the real ones.
import { scoreLead, rankLeads, dailyCallList } from "./scoring/score.js";

// VaultRE events are cached per suburb so bulk ranking doesn't hammer the backend.
export const VAULT_TTL_MS = 6 * 60 * 60 * 1000;
const vaultKey = (suburb) => `vault:${(suburb || "").toLowerCase()}`;

export async function vaultEventsFor(lead, { store, backend, nowMs = Date.now() }) {
  if (!lead?.suburb) return [];
  const key = vaultKey(lead.suburb);
  const cached = await store.getMeta(key);
  if (cached && nowMs - cached.at < VAULT_TTL_MS) return cached.events;
  if (!backend) return cached?.events || [];
  try {
    const { events } = await backend("/vault-events", { suburb: lead.suburb, street: lead.street, contactAddress: lead.address });
    await store.setMeta(key, { at: nowMs, events: events || [] });
    return events || [];
  } catch (e) {
    console.warn("[fua] vault-events failed:", e.message);
    return cached?.events || [];
  }
}

export function lastContactSummary(lead, messages) {
  if (!lead?.lastContactedAt) return "No prior contact on record.";
  const when = new Date(lead.lastContactedAt).toLocaleDateString("en-AU");
  const replied = lead.lastInboundAt && lead.lastInboundAt > lead.lastContactedAt;
  const recent = (messages || []).slice(-1)[0];
  const tail = recent?.bodyPreview ? ` Last message: "${recent.bodyPreview}".` : "";
  return `Last contacted ${when} by ${lead.lastContactChannel || "unknown"}.${replied ? " They have since replied and are awaiting a response." : ""}${tail}`;
}

export async function suggest(contactId, { store, backend, config, now = new Date() }) {
  const lead = await store.getLead(contactId);
  if (!lead) return { ok: false, error: "This contact hasn't been synced yet. Run a backfill or sync first." };
  const messages = await store.getMessages(contactId);
  const events = await vaultEventsFor(lead, { store, backend, nowMs: now.getTime() });
  const score = scoreLead(lead, messages, events, now);
  await store.saveScores([score]);

  let sms = "";
  let talkingPoint = "";
  if (backend) {
    try {
      const draft = await backend("/draft", {
        lead: { firstName: lead.firstName, suburb: lead.suburb, stage: lead.stage, lastContactSummary: lastContactSummary(lead, messages) },
        reason: score.reasons.join(" "),
        context: { agentName: config.agentName, suggestedChannel: score.suggestedChannel }
      });
      sms = draft.sms || "";
      talkingPoint = draft.talkingPoint || "";
    } catch (e) {
      talkingPoint = `(Draft unavailable: ${e.message})`;
    }
  }

  return {
    ok: true,
    suggestion: {
      contactName: lead.name || lead.firstName || contactId,
      lastContacted: lastContactSummary(lead, messages),
      nextAction: `${score.bucket.replace("_", " ")} · ${score.suggestedChannel}`,
      talkingPoint: talkingPoint || score.reasons[0] || "",
      smsDraft: sms,
      reason: score.reasons.join(" · "),
      priority: score.priority
    }
  };
}

// Score everyone with cached VaultRE events (no backend calls), rank, take the top.
export async function buildCallList({ store, config, now = new Date() }) {
  const leads = await store.allLeads();
  if (!leads.length) return { ok: true, leads: [], total: 0, note: "No leads synced yet. Use Backfill all." };
  const scored = [];
  for (const lead of leads) {
    const messages = await store.getMessages(lead.id);
    const cached = await store.getMeta(vaultKey(lead.suburb));
    scored.push({ ...scoreLead(lead, messages, cached?.events || [], now), name: lead.name || lead.firstName || lead.id });
  }
  await store.saveScores(scored);
  return { ok: true, leads: dailyCallList(rankLeads(scored), config.callListLimit), total: leads.length };
}
