"""Pure helpers for the follow-up assistant backend.

Standard library only. NO network, NO SDK calls, NO secrets. Everything here is
deterministic so it can be unit-tested offline and shared by app.py and mock.py.
"""
import json
import math
import re

SMS_LIMIT = 160
OPT_OUT = "Reply STOP to opt out"

# GSM 03.38 basic character set (single septet each).
_GSM_BASIC = set(
    "@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !\"#¤%&'()*+,-./0123456789:;<=>?"
    "¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà"
)
# Extension table characters cost two septets (escape + char).
_GSM_EXT = set("^{}\\[~]|€\f")

_REPLACEMENTS = {
    "‘": "'", "’": "'", "‚": "'", "“": '"', "”": '"',
    "–": "-", "—": "-", "−": "-", "…": "...",
    " ": " ", " ": " ", "​": "",
}

_OPT_OUT_RE = re.compile(
    r"\(?\b(?:reply|text|txt|send)\s+stop(?:\s+(?:to|2)\s+(?:opt[\s-]*out|unsubscribe|cancel|end))?\)?[.!]?",
    re.IGNORECASE,
)
_HAS_OPT_OUT_RE = re.compile(r"\bstop\b|opt[\s-]*out|unsubscribe", re.IGNORECASE)


def _gsm_clean(text: str) -> str:
    """Map common punctuation to ASCII and drop anything outside basic GSM."""
    out = []
    for ch in text:
        ch = _REPLACEMENTS.get(ch, ch)
        for c in ch:
            if c in _GSM_BASIC:
                out.append(c)
    return "".join(out)


def _collapse(text: str) -> str:
    return re.sub(r"\s+", " ", text).strip()


def enforce_sms_constraints(text: str) -> str:
    """Return an SMS that is GSM-only, single-line, <=160 chars, with an opt-out."""
    body = _collapse(_gsm_clean(text or ""))
    # Remove any existing opt-out phrasing, then re-append the canonical one so it
    # always survives trimming.
    body = _collapse(_OPT_OUT_RE.sub("", body))
    suffix = OPT_OUT
    room = SMS_LIMIT - len(suffix) - 1  # 1 for the joining space
    if len(body) > room:
        cut = body[:room]
        # Prefer cutting at a word boundary if one is reasonably close.
        space = cut.rfind(" ")
        if space >= room - 25:
            cut = cut[:space]
        body = cut.rstrip(" ,;:-")
    result = f"{body} {suffix}".strip()
    return result[:SMS_LIMIT]


def _is_gsm(text: str) -> bool:
    return all(c in _GSM_BASIC or c in _GSM_EXT for c in text)


def segment_count(text: str) -> int:
    """Number of SMS segments. 160/153 for GSM, 70/67 for unicode."""
    if not text:
        return 0
    if _is_gsm(text):
        length = sum(2 if c in _GSM_EXT else 1 for c in text)
        return 1 if length <= 160 else math.ceil(length / 153)
    length = len(text.encode("utf-16-le")) // 2  # UTF-16 code units
    return 1 if length <= 70 else math.ceil(length / 67)


def build_draft_prompt(lead, reason, context=None) -> str:
    """Build the instruction prompt asking Claude to WRITE (not send) one SMS."""
    lead = lead or {}
    first = (lead.get("firstName") or "").strip() or "there"
    suburb = (lead.get("suburb") or "").strip() or "their area"
    stage = (lead.get("stage") or "").strip() or "unknown"
    last = (lead.get("lastContactSummary") or "").strip() or "no previous contact recorded"
    agent = ""
    extra = ""
    if isinstance(context, dict):
        agent = str(context.get("agentName") or "").strip()
        rest = {k: v for k, v in context.items() if k != "agentName"}
        if rest:
            extra = json.dumps(rest, ensure_ascii=True, sort_keys=True)
    elif context:
        extra = str(context).strip()
    sender = agent or "the agent"
    lines = [
        "You are helping a real-estate agent follow up with a lead. "
        "Write ONE suggested SMS for the agent to review. It will not be sent automatically.",
        "",
        "Lead details:",
        f"- First name: {first}",
        f"- Suburb: {suburb}",
        f"- Pipeline stage: {stage}",
        f"- Last contact: {last}",
        f"- Reason for reaching out now: {reason}",
    ]
    if extra:
        lines.append(f"- Extra context: {extra}")
    lines += [
        "",
        "SMS rules:",
        "- Friendly, natural, specific to the lead; no hard sell.",
        "- Plain GSM characters only. No emoji, no smart quotes, no line breaks.",
        "- Maximum 160 characters INCLUDING the opt-out line.",
        f"- Start with the first name, name the sender ({sender}), and end with: {OPT_OUT}",
        "- Do not invent prices, sales or facts that are not given above.",
        "- The reason and stage are internal notes. Never quote them or use CRM words "
        "like lead, pipeline, stage, score, priority or 'never contacted'. Write what a "
        "person would actually text, e.g. mention the nearby sale, not that they are a lead.",
        "",
        "Also write a one-line talking point the agent can use to open a phone call.",
        "",
        "Reply in EXACTLY this format and nothing else:",
        "SMS: <the sms text>",
        "OPENER: <one-line call opener>",
    ]
    return "\n".join(lines)


def parse_draft_response(text: str):
    """Split Claude's 'SMS: ... / OPENER: ...' reply into (sms, opener)."""
    text = text or ""
    m_sms = re.search(r"^\s*SMS:\s*(.*?)\s*(?=^\s*OPENER:|\Z)", text, re.S | re.M | re.I)
    m_op = re.search(r"^\s*OPENER:\s*(.*)\Z", text, re.S | re.M | re.I)
    sms = m_sms.group(1) if m_sms else text
    opener = _collapse(m_op.group(1)) if m_op else ""
    return sms, opener


# ---------------------------------------------------------------- VaultRE

def _get(d, *path):
    cur = d
    for p in path:
        if not isinstance(cur, dict):
            return None
        cur = cur.get(p)
    return cur


def _first(d, *paths):
    for p in paths:
        v = _get(d, *p) if isinstance(p, tuple) else _get(d, p)
        if v not in (None, "", []):
            return v
    return None


def _address_of(item: dict):
    disp = _first(item, ("address", "displayAddress"), "displayAddress", ("address", "full"), "address")
    if isinstance(disp, str) and disp.strip():
        return _collapse(disp)
    a = item.get("address") if isinstance(item.get("address"), dict) else item
    parts = [
        _first(a, "unitNumber", "unit"),
        _first(a, "streetNumber", "street_number"),
        _first(a, "street", "streetName"),
        _first(a, "suburb"),
        _first(a, "state"),
        _first(a, "postcode"),
    ]
    joined = " ".join(str(p) for p in parts if p not in (None, ""))
    return _collapse(joined) or None


def _date_of(value):
    if isinstance(value, str) and re.match(r"\d{4}-\d{2}-\d{2}", value):
        return value[:10]
    return None


def _price_of(value):
    if isinstance(value, bool):
        return None
    if isinstance(value, (int, float)):
        return int(value) if value > 0 else None
    if isinstance(value, str):
        digits = re.sub(r"[^\d.]", "", value.split("-")[0])
        try:
            n = float(digits)
            return int(n) if n > 0 else None
        except ValueError:
            return None
    return None


def normalise_vault_events(raw_json) -> list:
    """Map a VaultRE property-search payload to [{type,address,date,price?}].

    Accepts a JSON string, a dict ({"items":[...]}) or a bare list. Tolerant of
    missing fields; items with no usable address are skipped.
    """
    data = raw_json
    if isinstance(raw_json, (str, bytes)):
        try:
            data = json.loads(raw_json)
        except ValueError:
            return []
    if isinstance(data, dict):
        items = _first(data, "items", "results", "data", "properties") or []
    else:
        items = data
    if not isinstance(items, list):
        return []
    events = []
    for item in items:
        if not isinstance(item, dict):
            continue
        address = _address_of(item)
        if not address:
            continue
        status = str(_first(item, "status", "saleStatus", ("saleLifeId",)) or "").lower()
        sold_date = _date_of(_first(item, "soldDate", "dateSold", ("sale", "soldDate")))
        is_sold = "sold" in status or bool(sold_date)
        if is_sold:
            date = sold_date or _date_of(_first(item, "modified", "updated", "listedDate"))
            price = _price_of(_first(item, "soldPrice", "salePrice", ("sale", "soldPrice"), "price"))
        else:
            date = _date_of(_first(item, "listedDate", "dateListed", "authorityStart", "created", "modified"))
            price = _price_of(_first(item, "price", "displayPrice", "searchPrice", "listPrice"))
        ev = {"type": "sold" if is_sold else "listed", "address": address, "date": date}
        if price is not None:
            ev["price"] = price
        events.append(ev)
    return events
