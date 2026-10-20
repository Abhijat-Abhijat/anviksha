import operator
from typing import Annotated, TypedDict


class ResearchState(TypedDict, total=False):
    """Shared blackboard. A new agent that writes a new key must declare it here."""
    topic: str
    papers: list[dict]
    summaries: list[dict]
    gaps: list[str]
    hypothesis: str
    attempts: int
    critic_score: float
    critic_reason: str
    hallucination_risk: float
    confidence: float
    approved: bool
    route: str
    experiment_plan: str
    final_paper: str
    # Each agent returns only its new messages; LangGraph concatenates them.
    messages: Annotated[list[dict], operator.add]
