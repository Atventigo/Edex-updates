"""Pure tests for backend/core.py. Run with pytest or `python3 backend/tests/test_core.py`."""
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))

import core  # noqa: E402


def test_emoji_stripped():
    out = core.enforce_sms_constraints("Hi Sam \U0001F600 great news \U0001F3E1 about your street")
    assert all(ord(c) < 128 for c in out)
    assert "\U0001F600" not in out and "\U0001F3E1" not in out
    assert "  " not in out


def test_opt_out_appended_when_absent():
    out = core.enforce_sms_constraints("Hi Sam, a home sold near you.")
    assert out.endswith("Reply STOP to opt out")
    assert len(out) <= 160


def test_opt_out_not_duplicated():
    out = core.enforce_sms_constraints("Hi Sam, hello. Reply STOP to opt out")
    assert out.lower().count("stop") == 1


def test_long_input_trimmed():
    out = core.enforce_sms_constraints("x" * 170)
    assert len(out) <= 160
    assert out.endswith("Reply STOP to opt out")


def test_segment_count():
    assert core.segment_count("a" * 160) == 1
    assert core.segment_count("a" * 161) == 2
    assert core.segment_count("a" * 306) == 2
    assert core.segment_count("café " * 10) == 1
    assert core.segment_count("你" * 70) == 1
    assert core.segment_count("你" * 71) == 2
    assert core.segment_count("") == 0


def test_build_draft_prompt_contains_fields():
    p = core.build_draft_prompt(
        {"firstName": "Priya", "suburb": "Paddington", "stage": "seller", "lastContactSummary": "asked about appraisal"},
        "a home sold on her street",
        {"agentName": "Dan"},
    )
    assert "Priya" in p and "Paddington" in p and "a home sold on her street" in p
    assert "Dan" in p and "Reply STOP to opt out" in p


def test_parse_draft_response():
    sms, opener = core.parse_draft_response("SMS: Hi A. Reply STOP to opt out\nOPENER: Hi A, it's Dan.")
    assert sms.startswith("Hi A") and opener == "Hi A, it's Dan."


def test_normalise_vault_events_sample():
    raw = {
        "items": [
            {"address": {"displayAddress": "12 Smith St, Paddington QLD 4064"}, "status": "Current",
             "listedDate": "2026-10-01T00:00:00", "price": 1250000},
            {"address": {"streetNumber": "8", "street": "Smith St", "suburb": "Paddington"},
             "status": "Sold", "soldDate": "2026-10-05T10:00:00", "soldPrice": "$1,190,000"},
        ]
    }
    ev = core.normalise_vault_events(raw)
    assert ev[0] == {"type": "listed", "address": "12 Smith St, Paddington QLD 4064", "date": "2026-10-01", "price": 1250000}
    assert ev[1]["type"] == "sold" and ev[1]["date"] == "2026-10-05" and ev[1]["price"] == 1190000
    assert ev[1]["address"] == "8 Smith St Paddington"


def test_normalise_vault_events_tolerates_missing():
    assert core.normalise_vault_events({}) == []
    assert core.normalise_vault_events("not json") == []
    assert core.normalise_vault_events('{"items":[{"foo":1},{"address":{"displayAddress":"1 A St"}}]}') == [
        {"type": "listed", "address": "1 A St", "date": None}
    ]


if __name__ == "__main__":
    tests = [(n, f) for n, f in sorted(globals().items()) if n.startswith("test_") and callable(f)]
    for name, fn in tests:
        fn()
        print("ok", name)
    print(f"{len(tests)} passed")
