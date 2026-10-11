"""Modal app: thin backend for the follow-up assistant extension.

Deploy:  modal deploy backend/app.py
Routes:  POST /draft, POST /vault-events  (both require X-Extension-Key)

Only call_claude() and call_vaultre() touch the outside world. The service is
stateless: it stores nothing and sends no messages.
"""
import hmac
import logging
import os

import modal

log = logging.getLogger("fua-backend")

# Model id from the claude-api skill (current default model).
# Note: this model rejects non-default temperature/top_p/top_k with a 400, so we
# control output variability via output_config effort ("low") instead.
CLAUDE_MODEL = "claude-opus-5-5"
VAULTRE_BASE = "https://ap-southeast-2.api.vaultre.com.au/api/v1.3/"

# Origins allowed to call us from a browser: the extension and NurtureCloud.
# Override with ALLOWED_ORIGIN_REGEX if the extension id/NurtureCloud host differ.
DEFAULT_ORIGIN_REGEX = (
    r"^(chrome-extension://[a-p]{32}|moz-extension://[0-9a-f-]+"
    r"|https://([a-z0-9-]+\.)*nurturecloud\.[a-z.]+)$"
)

image = (
    modal.Image.debian_slim(python_version="3.12")
    .pip_install("anthropic>=1.0.0,<2", "fastapi==0.115.6", "httpx==0.28.1")
    .add_local_python_source("core")
)

app = modal.App("follow-up-assistant-backend", image=image)

# One Modal secret holding ANTHROPIC_API_KEY, VAULTRE_API_KEY, VAULTRE_TOKEN,
# EXTENSION_KEY (see README).
secrets = [modal.Secret.from_name("fua-backend")]


# ------------------------------------------------------------------ outside world

def call_claude(prompt: str) -> str:
    """Ask Claude to write the SMS + opener. Returns raw text."""
    import anthropic

    client = anthropic.Anthropic(api_key=os.environ["ANTHROPIC_API_KEY"])
    resp = client.messages.create(
        model=CLAUDE_MODEL,
        max_tokens=2048,  # headroom for adaptive thinking + a short answer
        output_config={"effort": "low"},
        messages=[{"role": "user", "content": prompt}],
    )
    if resp.stop_reason == "refusal":
        raise RuntimeError("model declined to draft")
    return "".join(b.text for b in resp.content if getattr(b, "type", "") == "text")


def call_vaultre(params: dict):
    """Search VaultRE properties. Returns parsed JSON, or None on HTTP 429."""
    import httpx

    headers = {
        "X-Api-Key": os.environ["VAULTRE_API_KEY"],
        "Authorization": f"Bearer {os.environ['VAULTRE_TOKEN']}",
        "Accept": "application/json",
    }
    # verify against VaultRE swagger: endpoint path and query parameter names
    # (suburb / street / pagesize / sortby) are a best guess.
    url = VAULTRE_BASE + "properties/residential/sale"
    r = httpx.get(url, params=params, headers=headers, timeout=15.0)
    if r.status_code == 429:
        log.warning("VaultRE rate limited (429); returning no events")
        return None
    r.raise_for_status()
    return r.json()


# ------------------------------------------------------------------ web app

def make_web_app():
    from fastapi import Depends, FastAPI, Header, HTTPException
    from fastapi.middleware.cors import CORSMiddleware
    from pydantic import BaseModel

    import core

    class Lead(BaseModel):
        firstName: str = ""
        suburb: str = ""
        stage: str = ""
        lastContactSummary: str = ""

    class DraftReq(BaseModel):
        lead: Lead
        reason: str
        context: dict | str | None = None

    class VaultReq(BaseModel):
        suburb: str = ""
        street: str = ""
        contactAddress: str = ""

    def require_key(x_extension_key: str | None = Header(default=None)):
        expected = os.environ.get("EXTENSION_KEY", "")
        if not expected or not x_extension_key or not hmac.compare_digest(
            x_extension_key.encode(), expected.encode()
        ):
            raise HTTPException(status_code=401, detail="unauthorized")

    web = FastAPI(title="follow-up-assistant-backend")
    web.add_middleware(
        CORSMiddleware,
        allow_origin_regex=os.environ.get("ALLOWED_ORIGIN_REGEX", DEFAULT_ORIGIN_REGEX),
        allow_methods=["POST", "OPTIONS"],
        allow_headers=["Content-Type", "X-Extension-Key"],
    )

    @web.post("/draft", dependencies=[Depends(require_key)])
    def draft(req: DraftReq):
        prompt = core.build_draft_prompt(req.lead.model_dump(), req.reason, req.context)
        try:
            raw = call_claude(prompt)
        except Exception:
            log.exception("claude call failed")
            raise HTTPException(status_code=502, detail="draft unavailable")
        sms, opener = core.parse_draft_response(raw)
        return {"sms": core.enforce_sms_constraints(sms), "talkingPoint": opener}

    @web.post("/vault-events", dependencies=[Depends(require_key)])
    def vault_events(req: VaultReq):
        params = {"pagesize": 20, "sortby": "modified", "sortorder": "desc"}
        if req.suburb:
            params["suburb"] = req.suburb
        if req.street:
            params["street"] = req.street
        try:
            raw = call_vaultre(params)
        except Exception:
            log.exception("vaultre call failed")
            raise HTTPException(status_code=502, detail="vaultre unavailable")
        if raw is None:  # 429
            return {"events": []}
        return {"events": core.normalise_vault_events(raw)}

    return web


@app.function(secrets=secrets, min_containers=0)
@modal.asgi_app()
def api():
    return make_web_app()
