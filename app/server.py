import json
import logging
import os
import secrets
import time
from functools import cache
from pathlib import Path

from fastapi import FastAPI, Header, HTTPException
from fastapi.responses import StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from app import config
from app.agents import default_pipeline
from app.graph import build_graph
from app.llm import GroqLLM
from app.sources.arxiv_source import ArxivSource

logging.basicConfig(level=logging.INFO, format="%(asctime)s | %(levelname)s | %(message)s")
log = logging.getLogger("anviksha")

FRONTEND = Path(__file__).resolve().parent.parent / "frontend"
MAX_STATE_BYTES = 300_000

SOURCE = ArxivSource()
MODEL_LIST_TTL = 600  # seconds
AUTO = "auto"         # model choice meaning "best model per task tier"

_models = {"at": 0.0, "ids": []}


def available_models() -> list[str]:
    if time.time() - _models["at"] > MODEL_LIST_TTL:
        try:
            _models["ids"] = GroqLLM().list_models()
            _models["at"] = time.time()
        except Exception:
            log.exception("Could not list Groq models")
    return _models["ids"] or [config.GROQ_MODEL]


def tier_models() -> dict[str, str]:
    """Auto mode: configured model per tier, falling back to GROQ_MODEL if Groq no longer offers it."""
    ids = available_models()
    return {tier: model if model in ids else config.GROQ_MODEL for tier, model in config.MODEL_TIERS.items()}


@cache
def groq(model: str) -> GroqLLM:  # one client per model id
    return GroqLLM(model)


def resolve(choice: str) -> tuple[tuple[str, str], ...]:
    """Tier -> model mapping for a dropdown choice, hashable so graphs can be cached by it."""
    tiers = tier_models() if choice == AUTO else {t: choice for t in config.MODEL_TIERS}
    return tuple(sorted(tiers.items()))


@cache
def graph_for(tiers: tuple[tuple[str, str], ...], entry: str):  # one compiled graph per (models, entry)
    mapping = dict(tiers)
    return build_graph(default_pipeline(lambda tier: groq(mapping[tier]), SOURCE), entry)


AGENTS = default_pipeline(lambda tier: groq(config.GROQ_MODEL), SOURCE)  # metadata; same for every model
NAMES = [a.name for a in AGENTS]

app = FastAPI(title="ANVIKSHA", version="2.0.0")


class RunRequest(BaseModel):
    topic: str = Field(min_length=3, max_length=200)
    # Rerun support: start at any agent, seeded with the state of an earlier run
    # (possibly edited by the user, e.g. a rewritten hypothesis).
    start: str = NAMES[0]
    state: dict = Field(default_factory=dict)
    model: str = AUTO  # "auto" or one Groq model id used for every step


@app.get("/api/health")
def health():
    return {"status": "ok", "model": config.GROQ_MODEL, "groq_configured": bool(os.getenv("GROQ_API_KEY")),
            "key_required": bool(config.ACCESS_KEY)}


@app.get("/api/models")
def models():
    return {"default": AUTO, "models": available_models(), "tiers": tier_models()}


@app.get("/api/agents")
def agents():
    return {"agents": [a.describe() for a in AGENTS],
            "max_attempts": config.MAX_ATTEMPTS, "threshold": config.THRESHOLD}


@app.post("/api/run")
def run(req: RunRequest, x_access_key: str = Header("")):
    # Public deployments share one Groq key; the optional access key stops
    # strangers from burning the free-tier quota.
    if config.ACCESS_KEY and not secrets.compare_digest(x_access_key, config.ACCESS_KEY):
        raise HTTPException(401, "Access key is missing or wrong.")
    if not os.getenv("GROQ_API_KEY"):
        raise HTTPException(503, "The server has no GROQ_API_KEY configured.")
    if req.start not in NAMES:
        raise HTTPException(422, f"Unknown agent '{req.start}'.")
    if len(json.dumps(req.state)) > MAX_STATE_BYTES:
        raise HTTPException(413, "Saved state is too large.")
    if req.model != AUTO and req.model not in available_models():
        raise HTTPException(422, f"Model '{req.model}' is not available. Pick another model from the list.")

    topic = " ".join(req.topic.split())
    seed = {**req.state, "topic": topic, "messages": []}
    for agent in AGENTS[NAMES.index(req.start):]:   # outputs from here on get recomputed
        for key in agent.outputs:
            seed.pop(key, None)
    log.info("Run from %s with %s: %s", req.start, req.model, topic)

    def events():
        # NDJSON, one event per line:
        #   {"type": "status"|"token"|"reset", "node", "text"}  live narration and streamed text
        #   {"type": "update", "node", "update"}                an agent finished
        #   {"type": "done"} | {"type": "error", "text"}
        try:
            for mode, chunk in graph_for(resolve(req.model), req.start).stream(seed, stream_mode=["updates", "custom"]):
                if mode == "custom":
                    yield json.dumps(chunk) + "\n"
                else:
                    for node, update in chunk.items():
                        yield json.dumps({"type": "update", "node": node, "update": update}) + "\n"
            yield json.dumps({"type": "done"}) + "\n"
        except Exception as e:
            log.exception("Run failed")
            yield json.dumps({"type": "error", "text": f"{type(e).__name__}: {e}"}) + "\n"

    return StreamingResponse(events(), media_type="application/x-ndjson",
                             headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})


app.mount("/", StaticFiles(directory=FRONTEND, html=True), name="frontend")
