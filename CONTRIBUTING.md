# Contributing to ANVIKSHA

Thanks for helping. This guide covers setup, the architecture in brief, and the most common contributions.

## Setup

```bash
python -m venv .venv
source .venv/bin/activate          # Windows: .venv\Scripts\activate
pip install -r requirements.txt pytest
pytest -q                          # offline, no API key needed
```

To try the UI, set `GROQ_API_KEY` and run `uvicorn app.server:app --reload`.

## Architecture in one minute

- **Agents** (`app/agents/`) are small classes, one per file. Each subclasses `Agent` (or `LLMAgent` if it calls a model), declares `name`, `title`, `description` and `outputs`, and implements `run(state) -> dict`, returning only the state keys it changes.
- **Dependencies are injected.** Agents receive an `LLM` (protocol in `app/llm.py`) or a `PaperSource` (protocol in `app/sources/__init__.py`) through their constructor. They never import a vendor SDK. This is what lets the tests use a fake model.
- **The registry** (`app/agents/__init__.py`, `default_pipeline`) lists agents in pipeline order. `app/graph.py` wires them into a LangGraph state machine automatically. An agent that also implements `Router` chooses its own next step (see `GateAgent`).
- **Prompts** live in `app/prompts/<name>.md` and use `$placeholders`. Agents render them with `self.generate("<name>", ...)`, which also streams tokens to the UI.
- **The UI** (`frontend/`) builds its pipeline view from `GET /api/agents`, so a new agent appears without frontend changes.

## Add an agent

1. Create `app/prompts/my_step.md`:

   ```markdown
   You are the Novelty Checker. Given the hypothesis below, list prior work it overlaps with.

   Hypothesis:
   $hypothesis
   ```

2. Create `app/agents/novelty.py`:

   ```python
   from app.agents.base import LLMAgent


   class NoveltyAgent(LLMAgent):
       name = "check_novelty"
       title = "Novelty"
       description = "Looks for earlier work that already covers the idea."
       outputs = ("novelty_notes",)

       def run(self, state):
           self.say("Checking whether this idea has been tried before")  # plain words, shown live
           notes = self.generate("my_step", hypothesis=state["hypothesis"], max_tokens=400)
           return {"novelty_notes": notes,
                   "messages": self.message("novelty_checked", {"notes": notes})}
   ```

3. Declare the new key in `ResearchState` (`app/state.py`): `novelty_notes: str`.
4. Insert `NoveltyAgent(llm)` into `default_pipeline` at the position where it should run.
5. Add a test in `tests/` using the fake LLM.

The UI shows the new agent's output as JSON by default. For a custom view, add a renderer to `VIEWS` in `frontend/app.js` keyed by the agent's `name`.

## Add a literature source

Implement the `PaperSource` protocol (a `name` attribute and `search(query, limit) -> list[Paper]`) in `app/sources/`, then pass it to `default_pipeline` in `app/server.py`.

## Use a different model provider

Implement the `LLM` protocol (`stream` and `complete_json`) in `app/llm.py` or a new module, and pass it to `default_pipeline` in `app/server.py`.

## Guidelines

- Keep each agent focused on one job.
- Status messages (`self.say`) are for non-experts: short, plain words, present tense.
- Never let the writer cite sources that were not retrieved.
- Run `pytest -q` before opening a pull request. CI runs it too.
- Keep pull requests small and describe what changed and why.

## Reporting issues

Open a GitHub issue with what you ran, what you expected, and what happened. Include the research question and the server log lines if a run failed. Never paste your API key.
