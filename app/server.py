import json
import logging
import os
import secrets
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

AGENTS = default_pipeline(GroqLLM(), ArxivSource())
NAMES = [a.name for a in AGENTS]
graph_from = cache(lambda entry: build_graph(AGENTS, entry))  # one compiled graph per entry node

app = FastAPI(title="ANVIKSHA", version="2.0.0")


class RunRequest(BaseModel):
    topic: str = Field(min_length=3, max_length=200)
    # Rerun support: start at any agent, seeded with the state of an earlier run
    # (possibly edited by the user, e.g. a rewritten hypothesis).
    start: str = NAMES[0]
    state: dict = Field(default_factory=dict)


@app.get("/api/health")
def health():
    return {"status": "ok", "model": config.GROQ_MODEL, "groq_configured": bool(os.getenv("GROQ_API_KEY")),
            "key_required": bool(config.ACCESS_KEY)}


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

    topic = " ".join(req.topic.split())
    seed = {**req.state, "topic": topic, "messages": []}
    for agent in AGENTS[NAMES.index(req.start):]:   # outputs from here on get recomputed
        for key in agent.outputs:
            seed.pop(key, None)
    log.info("Run from %s: %s", req.start, topic)

    def events():
        # NDJSON, one event per line:
        #   {"type": "status"|"token"|"reset", "node", "text"}  live narration and streamed text
        #   {"type": "update", "node", "update"}                an agent finished
        #   {"type": "done"} | {"type": "error", "text"}
        try:
            for mode, chunk in graph_from(req.start).stream(seed, stream_mode=["updates", "custom"]):
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
