// Fake leads for testing the sidebar before NurtureCloud's endpoints are mapped.
// Every id starts with "demo-" and every name ends in "(demo)" so they can't be
// mistaken for real contacts. Phone numbers are the reserved 0491 570 xxx range.
const daysAgo = (n) => new Date(Date.now() - n * 86400000).toISOString();

export function demoData() {
  const leads = [
    { id: "demo-1", firstName: "Ben", name: "Ben Carter (demo)", phone: "+61491570110", stage: "seller", suburb: "Ashgrove", street: "Jubilee Tce", lastContactedAt: daysAgo(10), lastContactChannel: "sms", lastInboundAt: daysAgo(8), responded: true, smsCount: 1, callCount: 0 },
    { id: "demo-2", firstName: "Alice", name: "Alice Nguyen (demo)", phone: "+61491570111", stage: "seller", suburb: "Paddington", street: "Latrobe Tce" },
    { id: "demo-3", firstName: "Priya", name: "Priya Shah (demo)", phone: "+61491570112", stage: "seller", suburb: "Bardon", street: "Boundary Rd", lastContactedAt: daysAgo(45), lastContactChannel: "call", responded: true, smsCount: 2, callCount: 1 },
    { id: "demo-4", firstName: "Tom", name: "Tom Walsh (demo)", phone: "+61491570113", stage: "buyer", suburb: "Toowong", street: "High St" },
    { id: "demo-5", firstName: "Cara", name: "Cara Lee (demo)", phone: "+61491570114", stage: "seller", suburb: "Milton", street: "Park Rd", lastContactedAt: daysAgo(1), lastContactChannel: "sms", smsCount: 3 },
    { id: "demo-6", firstName: "Dan", name: "Dan Ross (demo)", phone: "+61491570115", stage: "seller", suburb: "Red Hill", street: "Musgrave Rd", doNotContact: true },
    { id: "demo-7", firstName: "Mia", name: "Mia Brown (demo)", phone: "+61491570116", stage: "lead", suburb: "Kelvin Grove", street: "Kelvin Grove Rd", lastContactedAt: daysAgo(120), lastContactChannel: "sms", smsCount: 5 }
  ].map((l) => ({ owner: "Jas", tags: ["demo"], callCount: 0, smsCount: 0, responded: false, doNotContact: false, lastContactedAt: null, lastInboundAt: null, lastContactChannel: null, address: `${l.street}, ${l.suburb}`, updatedAt: new Date().toISOString(), ...l }));

  const messages = [
    { id: "sms:demo-m1", contactId: "demo-1", direction: "out", channel: "sms", at: daysAgo(10), segments: 1, bodyPreview: "Hi Ben, Jas from Ray White. Thinking of selling this year?" },
    { id: "sms:demo-m2", contactId: "demo-1", direction: "in", channel: "sms", at: daysAgo(8), segments: 1, bodyPreview: "Maybe. What would ours be worth?" },
    { id: "sms:demo-m3", contactId: "demo-5", direction: "out", channel: "sms", at: daysAgo(1), segments: 1, bodyPreview: "Hi Cara, Jas here, just checking in." }
  ];

  // Cached VaultRE event so the street-sale boost shows up without a backend.
  const vault = { key: "vault:paddington", value: { at: Date.now(), events: [{ type: "sold", address: "8 Latrobe Tce, Paddington", date: daysAgo(4).slice(0, 10), price: 1190000 }] } };

  return { leads, messages, vault };
}
