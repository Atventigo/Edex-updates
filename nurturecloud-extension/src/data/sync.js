// Daily delta sync: pull leads updated since the last cursor, refresh their
// history, upsert, and return the newest updatedAt seen (store it via setMeta).
// Extra optional args beyond ARCHITECTURE.md: throttleMs, signal, store, sleep.
import * as realStore from "./store.js";
import { enrichLead, fetchHistory, isSet, makeRequester, mapLead, sleep, walkPages } from "./backfill.js";

export async function runDelta({
  endpoints,
  authHeaders = {},
  fetchJson,
  since,
  throttleMs = 1000,
  signal,
  store = realStore,
  sleep: sleepFn = sleep
}) {
  const request = makeRequester({ fetchJson, authHeaders, throttleMs, signal, sleep: sleepFn });
  const param = endpoints.leads.updatedSinceParam;
  const extra = since && isSet(param) ? { [param]: since } : {};
  let newest = since ?? null;
  for await (const { items } of walkPages(endpoints.leads, request, extra)) {
    for (const raw of items) {
      const lead = mapLead(raw);
      // Endpoint may ignore the filter; skip records at or before the cursor.
      if (since && lead.updatedAt && lead.updatedAt <= since) continue;
      const msgs = await fetchHistory(endpoints, lead.id, request);
      await store.upsertMessages(msgs);
      await store.upsertLeads([enrichLead(lead, msgs)]);
      if (lead.updatedAt && (!newest || lead.updatedAt > newest)) newest = lead.updatedAt;
    }
  }
  return newest;
}
