// Example `endpoints` config for backfill.js / sync.js.
// NurtureCloud's real URLs, pagination and response shapes are not known yet.
// Every value below is a placeholder; it is filled in after the endpoint-mapping
// session (discovery run / HAR). Copy to the real config and replace each TODO.
const TODO = "TODO: fill from discovery/HAR";

export const DEFAULTS = {
  leads: {
    url: TODO, // list endpoint, e.g. https://.../contacts
    pageParam: TODO, // query param holding the page number (or offset/cursor)
    perPageParam: TODO, // query param for page size
    perPage: 100,
    pageStart: 1,
    itemsPath: TODO, // path to the array in the response, e.g. "data.contacts"
    nextPath: TODO, // path to a next-page flag/cursor (use this OR totalPath)
    totalPath: TODO, // path to total record count
    updatedSinceParam: TODO // query param for delta sync (optional)
  },
  messages: {
    urlTemplate: TODO, // contains :id for the contact id
    itemsPath: TODO
  },
  calls: {
    urlTemplate: TODO,
    itemsPath: TODO
  }
};
