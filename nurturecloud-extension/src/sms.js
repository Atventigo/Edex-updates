// Checks a draft before it goes into NurtureCloud's SMS box.
// Returns warnings; the agent still decides whether to send.
export function checkDraft(text, { requiredSmsPhrases = [], optOutPattern = "" } = {}) {
  const warnings = [];
  if (!text || !text.trim()) return ["Draft is empty."];
  for (const phrase of requiredSmsPhrases) {
    if (!text.toLowerCase().includes(phrase.toLowerCase())) warnings.push(`Doesn't name the sender ("${phrase}").`);
  }
  if (optOutPattern && !new RegExp(optOutPattern, "i").test(text)) warnings.push("No opt-out (e.g. \"Reply STOP to opt out\").");
  if (/\{\{?\s*\w+\s*\}?\}/.test(text)) warnings.push("Has an unfilled placeholder.");
  const segments = smsSegments(text);
  if (segments > 2) warnings.push(`Long message: ${segments} SMS segments.`);
  return warnings;
}

// GSM-7 messages split at 153 chars per part, UCS-2 (emoji, curly quotes) at 67.
export function smsSegments(text) {
  const gsm = /^[\n\r A-Za-z0-9@£$¥èéùìòÇØøÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ!"#¤%&'()*+,\-./:;<=>?¡ÄÖÑÜ§¿äöñüà^{}\\[~\]|€]*$/.test(text);
  const single = gsm ? 160 : 70;
  const part = gsm ? 153 : 67;
  return text.length <= single ? 1 : Math.ceil(text.length / part);
}
