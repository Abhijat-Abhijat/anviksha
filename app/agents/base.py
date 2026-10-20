"""Agent contracts.

Every pipeline step is an `Agent`: a callable LangGraph node with metadata the UI reads.
- `LLMAgent` adds an injected `LLM` (dependency inversion: no vendor SDK in agents).
- `Router` is for agents that choose the next node instead of following the default order.
"""
import logging
import time
from abc import ABC, abstractmethod
from typing import ClassVar

from app.llm import LLM
from app.prompts import render

log = logging.getLogger("anviksha")


def _writer():
    """LangGraph's custom-stream writer, or a no-op outside a streaming run."""
    try:
        from langgraph.config import get_stream_writer
        return get_stream_writer()
    except Exception:
        return lambda _event: None


class Agent(ABC):
    name: ClassVar[str]                     # unique graph node id, e.g. "critique"
    title: ClassVar[str]                    # short UI label, e.g. "Critique"
    description: ClassVar[str]              # one plain sentence for the UI
    outputs: ClassVar[tuple[str, ...]] = ()  # state keys this agent writes (cleared on rerun)

    @abstractmethod
    def run(self, state: dict) -> dict:
        """Read what you need from `state`, return only the keys you change."""

    def __call__(self, state: dict) -> dict:
        start = time.perf_counter()
        update = self.run(state)
        log.info("%s finished in %.1fs", self.name, time.perf_counter() - start)
        return update

    # -- helpers for subclasses

    def say(self, text: str) -> None:
        """Tell the user, in plain words, what this agent is doing right now."""
        _writer()({"type": "status", "node": self.name, "text": text})

    def message(self, intent: str, payload: dict, confidence: float | None = None) -> list[dict]:
        """Audit-log entry. Return it under the "messages" key of your update."""
        return [{"agent": self.title, "intent": intent, "payload": payload, "confidence": confidence}]

    def describe(self) -> dict:
        return {"name": self.name, "title": self.title, "description": self.description,
                "outputs": list(self.outputs)}


class LLMAgent(Agent, ABC):
    def __init__(self, llm: LLM):
        self.llm = llm

    def generate(self, template: str, *, max_tokens: int = 1024, temperature: float = 0.2, **values) -> str:
        """Render a prompt and stream the answer to the UI token by token."""
        emit = _writer()
        emit({"type": "reset", "node": self.name})
        parts = []
        for piece in self.llm.stream(render(template, **values), max_tokens=max_tokens, temperature=temperature):
            parts.append(piece)
            emit({"type": "token", "node": self.name, "text": piece})
        return "".join(parts).strip()

    def generate_json(self, template: str, *, max_tokens: int = 300, **values) -> dict:
        return self.llm.complete_json(render(template, **values), max_tokens=max_tokens)


class Router(ABC):
    """Mixin for agents that pick the next node. `routes` lists every node `route` may return."""
    routes: tuple[str, ...]

    @abstractmethod
    def route(self, state: dict) -> str: ...


def clamp(x: float) -> float:
    return max(0.0, min(1.0, float(x)))
