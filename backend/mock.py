"""Offline mock of the backend: same routes, fake data, no config or keys.

Run:  uvicorn backend.mock:app --port 8787   (from the repo root)
  or: cd backend && uvicorn mock:app --port 8787
"""
import datetime

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

try:
    from . import core  # type: ignore
except ImportError:  # run as a plain script/module from backend/
    import core  # type: ignore


class Lead(BaseModel):
    firstName: str = ""
    suburb: str = ""
    stage: str = ""
    lastContactSummary: str = ""


class DraftReq(BaseModel):
    lead: Lead
    reason: str = ""
    context: dict | str | None = None


class VaultReq(BaseModel):
    suburb: str = ""
    street: str = ""
    contactAddress: str = ""


app = FastAPI(title="follow-up-assistant mock")
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])


@app.post("/draft")
def draft(req: DraftReq):
    name = req.lead.firstName or "there"
    suburb = req.lead.suburb or "your area"
    agent = req.context.get("agentName") if isinstance(req.context, dict) else None
    agent = agent or "Sam"
    text = (
        f"Hi {name}, it's {agent}. Quick note on {suburb}: {req.reason or 'checking in'}. "
        "Happy to chat if useful."
    )
    return {
        "sms": core.enforce_sms_constraints(text),
        "talkingPoint": f"Hi {name}, it's {agent} - I wanted to touch base about {suburb}.",
    }


@app.post("/vault-events")
def vault_events(req: VaultReq):
    today = datetime.date.today()
    street = req.street or "Example St"
    suburb = req.suburb or "Exampleville"
    events = [
        {"type": "listed", "address": f"12 {street}, {suburb}",
         "date": (today - datetime.timedelta(days=3)).isoformat(), "price": 1250000},
        {"type": "sold", "address": f"8 {street}, {suburb}",
         "date": (today - datetime.timedelta(days=9)).isoformat(), "price": 1190000},
    ]
    return {"events": events[: 1 + (len(street) % 2)]}


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host="127.0.0.1", port=8787)
