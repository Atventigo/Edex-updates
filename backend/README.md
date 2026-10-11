# Follow-up assistant backend

A small, stateless service for the browser extension. It does two things the browser can't do safely:

1. `POST /draft` asks the Claude API to **write** (never send) a suggested SMS plus a one-line call opener.
2. `POST /vault-events` reads recent listings/sales from the VaultRE REST API.

It stores no data and sends no messages. Both routes require the header `X-Extension-Key`.

## Files

- `core.py` - pure helpers (prompt building, SMS rules, VaultRE mapping). Standard library only.
- `app.py` - the Modal app. `call_claude` and `call_vaultre` are the only functions that touch the network.
- `mock.py` - offline fake of the same routes, no keys needed.
- `tests/test_core.py` - pure unit tests.

## You must supply your own keys

The human owner has to provide:

- an **Anthropic API key** (console.anthropic.com),
- a **VaultRE integrator API key** and an **agency token** (issued by VaultRE for your agency),
- an **extension key**: any long random string you invent, also configured in the extension.

Nothing in this repo contains or provisions these.

## Deploy to Modal

```
pip install modal && modal setup
modal secret create fua-backend \
  ANTHROPIC_API_KEY=sk-ant-... \
  VAULTRE_API_KEY=... \
  VAULTRE_TOKEN=... \
  EXTENSION_KEY=$(openssl rand -hex 24)
modal deploy backend/app.py
```

The four values live in one Modal secret named `fua-backend` (the name used in `app.py`). Optionally add `ALLOWED_ORIGIN_REGEX` to the same secret to override the CORS origins (default: any `chrome-extension://<id>`, `moz-extension://`, and `https://*.nurturecloud.*`).

Modal prints a URL like `https://<workspace>--follow-up-assistant-backend-api.modal.run`. The endpoints are:

- `POST <url>/draft`
- `POST <url>/vault-events`

Example:

```
curl -X POST "$URL/draft" -H "X-Extension-Key: $KEY" -H "Content-Type: application/json" \
  -d '{"lead":{"firstName":"Priya","suburb":"Paddington","stage":"seller","lastContactSummary":"asked about appraisal"},"reason":"a home sold on her street"}'
```

## Run the mock locally (no keys)

```
pip install fastapi uvicorn
cd backend && uvicorn mock:app --port 8787
```

Same routes at `http://127.0.0.1:8787`, fake responses, no auth, CORS open. The mock still passes drafts through `core.enforce_sms_constraints`.

## Tests

```
python3 -m pytest backend/tests/ -q      # or: python3 backend/tests/test_core.py
```

## Notes

- Model: `claude-opus-5-5`. This model rejects `temperature`/`top_p`/`top_k`, so none is sent; output is kept short with `output_config.effort = "low"`.
- The VaultRE path and query parameters in `call_vaultre` are a best guess; check them against the VaultRE swagger before relying on them. VaultRE limits: 10 req/s, 10k/day. A 429 returns `{"events": []}`.
