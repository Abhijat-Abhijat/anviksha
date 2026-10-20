"""Agent registry. The list order is the default pipeline order.

To add an agent: write a class in its own module (see CONTRIBUTING.md) and insert it here.
"""
from app.agents.base import Agent, LLMAgent, Router
from app.agents.critic import CriticAgent
from app.agents.experiment import ExperimentAgent
from app.agents.gap_finder import GapFinderAgent
from app.agents.gate import GateAgent
from app.agents.hypothesis import HypothesisAgent
from app.agents.retrieval import RetrievalAgent
from app.agents.summarizer import SummarizerAgent
from app.agents.verifier import VerifierAgent
from app.agents.writer import WriterAgent
from collections.abc import Callable

from app.llm import LLM
from app.sources import PaperSource

__all__ = ["Agent", "LLMAgent", "Router", "default_pipeline"]


def default_pipeline(llm_for: Callable[[str], LLM], source: PaperSource) -> list[Agent]:
    """`llm_for(tier)` returns the model for a tier, so each agent gets the model suited to its task."""
    def make(cls: type[LLMAgent]) -> LLMAgent:
        return cls(llm_for(cls.tier))

    return [
        RetrievalAgent(source),
        make(SummarizerAgent),
        make(GapFinderAgent),
        make(HypothesisAgent),
        make(CriticAgent),
        make(VerifierAgent),
        GateAgent(retry=HypothesisAgent.name, proceed=ExperimentAgent.name),
        make(ExperimentAgent),
        make(WriterAgent),
    ]
