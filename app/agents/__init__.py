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
from app.llm import LLM
from app.sources import PaperSource

__all__ = ["Agent", "LLMAgent", "Router", "default_pipeline"]


def default_pipeline(llm: LLM, source: PaperSource) -> list[Agent]:
    return [
        RetrievalAgent(source),
        SummarizerAgent(llm),
        GapFinderAgent(llm),
        HypothesisAgent(llm),
        CriticAgent(llm),
        VerifierAgent(llm),
        GateAgent(retry=HypothesisAgent.name, proceed=ExperimentAgent.name),
        ExperimentAgent(llm),
        WriterAgent(llm),
    ]
