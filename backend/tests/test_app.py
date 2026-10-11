"""Offline tests of the real FastAPI app built by app.make_web_app().

The Claude and VaultRE calls are replaced with fakes, so nothing leaves the
machine. Needs the packages in requirements.txt; skips cleanly without them.
Run: python3 backend/tests/test_app.py   (or via pytest)
"""
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

try:
    from fastapi.testclient import TestClient
    import app
except ImportError as e:  # pragma: no cover
    print(f"skipped: {e}")
    sys.exit(0)

KEY = "test-key"
os.environ["EXTENSION_KEY"] = KEY
H = {"X-Extension-Key": KEY}


def client(claude=None, vault=None):
    app.call_claude = claude or (lambda prompt: "SMS: Hi Sam, it's Jas from Ray White. A home near you just sold - keen to hear what it means for yours? Reply STOP to opt out\nOPENER: Hi Sam, Jas here about the sale on your street.")
    app.call_vaultre = vault or (lambda params: {"items": []})
    return TestClient(app.make_web_app())


def test_rejects_missing_key():
    r = client().post("/draft", json={"lead": {"firstName": "Sam"}, "reason": "x"})
    assert r.status_code == 401


def test_rejects_wrong_key():
    r = client().post("/draft", json={"lead": {}, "reason": "x"}, headers={"X-Extension-Key": "nope"})
    assert r.status_code == 401


def test_draft_returns_constrained_sms():
    r = client().post("/draft", headers=H, json={"lead": {"firstName": "Sam", "suburb": "Paddington", "stage": "seller", "lastContactSummary": ""}, "reason": "Recent sale nearby", "context": {"agentName": "Jas"}})
    assert r.status_code == 200, r.text
    body = r.json()
    assert len(body["sms"]) <= 160
    assert body["sms"].endswith("Reply STOP to opt out")
    assert body["talkingPoint"]


def test_draft_overlong_model_output_is_trimmed():
    long = "SMS: " + "Hi Sam " * 60 + "\nOPENER: hello"
    r = client(claude=lambda p: long).post("/draft", headers=H, json={"lead": {"firstName": "Sam"}, "reason": "x"})
    assert r.status_code == 200
    assert len(r.json()["sms"]) <= 160
    assert "STOP" in r.json()["sms"]


def test_draft_claude_failure_is_502():
    def boom(prompt):
        raise RuntimeError("down")
    r = client(claude=boom).post("/draft", headers=H, json={"lead": {"firstName": "Sam"}, "reason": "x"})
    assert r.status_code == 502


def test_prompt_forbids_crm_jargon():
    seen = {}
    def capture(prompt):
        seen["p"] = prompt
        return "SMS: Hi Sam. Reply STOP to opt out\nOPENER: hi"
    client(claude=capture).post("/draft", headers=H, json={"lead": {"firstName": "Sam"}, "reason": "Seller lead, never contacted"})
    assert "Never quote them" in seen["p"]


def test_vault_rate_limit_returns_empty():
    r = client(vault=lambda params: None).post("/vault-events", headers=H, json={"suburb": "Paddington"})
    assert r.status_code == 200
    assert r.json() == {"events": []}


def test_vault_passes_suburb_and_street():
    seen = {}
    def capture(params):
        seen.update(params)
        return {"items": []}
    client(vault=capture).post("/vault-events", headers=H, json={"suburb": "Paddington", "street": "Latrobe Tce"})
    assert seen["suburb"] == "Paddington" and seen["street"] == "Latrobe Tce"


def test_cors_preflight_from_extension():
    r = client().options("/draft", headers={"Origin": "chrome-extension://abcdefghijklmnopabcdefghijklmnop", "Access-Control-Request-Method": "POST", "Access-Control-Request-Headers": "content-type,x-extension-key"})
    assert r.status_code == 200
    assert r.headers.get("access-control-allow-origin") == "chrome-extension://abcdefghijklmnopabcdefghijklmnop"


def test_cors_rejects_random_site():
    r = client().options("/draft", headers={"Origin": "https://evil.example", "Access-Control-Request-Method": "POST"})
    assert r.headers.get("access-control-allow-origin") is None


if __name__ == "__main__":
    tests = [v for k, v in sorted(globals().items()) if k.startswith("test_")]
    for t in tests:
        t()
        print("ok", t.__name__)
    print(f"{len(tests)} passed")
