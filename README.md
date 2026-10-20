# ANVIKSHA

**Autonomous Multi-Agent Research Intelligence**

An AI research system that discovers gaps, formulates hypotheses, tests ideas, verifies evidence, challenges conclusions, and synthesizes scientific knowledge.

ANVIKSHA (from *ānvīkṣikī*, the classical Indian science of inquiry) takes a research question and runs a team of agents over it: it retrieves papers from arXiv, finds open problems, proposes a testable hypothesis, has it peer-reviewed and checked for fabrication, sends weak ideas back for another try, designs an experiment and writes the paper. Every step streams live, is explained in plain language, can be edited, and can be rerun on its own.

It runs on the [Groq](https://console.groq.com) free tier.

## How it works

```
retrieve → summarize → find_gaps → propose → critique → verify → decide
                                      ▲                            │
                                      └──── score below 0.80 ──────┤
                                                                   ▼
                                               design_experiment → write
```

| Agent | What it does |
| --- | --- |
| Retrieve | Searches arXiv for the most relevant papers |
| Summarize | Condenses each abstract to method, data and contribution |
| Gaps | Finds open questions the papers leave unanswered |
| Hypothesize | Turns the gaps into one testable hypothesis |
| Critique | Scores the hypothesis as a strict peer reviewer |
| Verify | Estimates the risk of unsupported or fabricated claims |
| Gate | Combines both scores (60/40). Approves, or sends the idea back (max 3 attempts) |
| Experiment | Designs dataset, metrics, baselines, procedure and compute |
| Paper | Writes the paper, citing only the retrieved sources |

In the UI you can edit the gaps or the hypothesis and press **Rerun from here** on any agent: that agent and everything after it run again, using your edits.

## Run locally

Requires Python 3.11 or newer and a free Groq API key from <https://console.groq.com/keys>.

```bash
git clone https://github.com/<you>/anviksha.git
cd anviksha
python -m venv .venv
source .venv/bin/activate          # Windows: .venv\Scripts\activate
pip install -r requirements.txt

export GROQ_API_KEY=gsk_...        # Windows PowerShell: $env:GROQ_API_KEY="gsk_..."
uvicorn app.server:app --reload
```

Open <http://localhost:8000>.

## Configuration

| Variable | Required | Default | Purpose |
| --- | --- | --- | --- |
| `GROQ_API_KEY` | yes | | Groq API key |
| `GROQ_MODEL` | no | `llama-3.3-70b-versatile` | Any Groq chat model id |
| `ANVIKSHA_ACCESS_KEY` | no | empty (open) | If set, the UI asks for this key before running. Use it on public deployments so strangers cannot spend your quota |
| `ANVIKSHA_PAPERS` | no | `5` | Papers retrieved per run |
| `ANVIKSHA_MAX_ATTEMPTS` | no | `3` | Hypothesis attempts before moving on |
| `ANVIKSHA_THRESHOLD` | no | `0.8` | Confidence needed to approve a hypothesis |

See [.env.example](.env.example).

### Free-tier limits

A full run makes roughly 12 to 20 model calls and uses about 15k tokens. Groq's free tier limits tokens per minute, so a run can pause briefly while the client waits and retries; this is automatic. If you hit limits often, set `GROQ_MODEL=llama-3.1-8b-instant` (higher limits, lower quality) or lower `ANVIKSHA_PAPERS`. Check your account's current limits at <https://console.groq.com/settings/limits>.

## Deploy (GitHub + Render, free)

The app is one FastAPI service that also serves the UI, so it deploys as a single web service.

1. Push this repository to GitHub.
2. In [Render](https://render.com), choose **New → Blueprint** and select the repository. Render reads [render.yaml](render.yaml).
3. When prompted, set `GROQ_API_KEY` and (recommended) `ANVIKSHA_ACCESS_KEY`.
4. Deploy. Every push to `main` redeploys automatically; GitHub Actions runs the tests on each push and pull request.

Render's free instances sleep after 15 minutes without traffic, so the first request after a pause takes about a minute.

Any host that runs a Python web process works the same way: install `requirements.txt` and start `uvicorn app.server:app --host 0.0.0.0 --port $PORT`.

## API

| Method | Path | Description |
| --- | --- | --- |
| `GET` | `/api/health` | Status, model, whether an access key is required |
| `GET` | `/api/agents` | Pipeline order and agent metadata (the UI builds itself from this) |
| `POST` | `/api/run` | Runs the pipeline and streams newline-delimited JSON events |

`POST /api/run` body: `{"topic": "...", "start": "retrieve", "state": {}}`. Set `start` to any agent name and pass the previous `state` to rerun from that agent. Send `X-Access-Key` if `ANVIKSHA_ACCESS_KEY` is set.

Stream events, one JSON object per line:

```json
{"type": "status", "node": "summarize", "text": "Reading paper 2 of 5: ..."}
{"type": "token",  "node": "write", "text": "The "}
{"type": "update", "node": "critique", "update": {"critic_score": 0.82, "...": "..."}}
{"type": "done"}
{"type": "error", "text": "..."}
```

## Project layout

```
app/
  agents/          one file per agent, plus base.py (contracts) and __init__.py (registry)
  prompts/         one Markdown prompt template per agent
  sources/         literature sources (arXiv); add more by implementing PaperSource
  llm.py           LLM protocol and the Groq implementation
  graph.py         builds the LangGraph state machine from the registry
  state.py         shared state schema
  config.py        environment settings
  server.py        FastAPI app: API + static UI
frontend/          plain HTML, CSS and JS, no build step
tests/             offline tests with a fake LLM (no API key needed)
```

## Contributing

Contributions are welcome: new agents, new literature sources, better prompts, UI improvements. See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

[MIT](LICENSE)

Generated papers are drafts. Check every claim against the cited sources before you rely on it.
