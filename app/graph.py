from collections.abc import Sequence

from langgraph.graph import END, StateGraph

from app.agents import Agent, Router
from app.state import ResearchState


def build_graph(agents: Sequence[Agent], entry: str | None = None):
    """Wire agents in list order. Routers pick their own next node.

    `entry` starts the run mid-pipeline, which is how "rerun from this agent" works.
    """
    names = [a.name for a in agents]
    if len(set(names)) != len(names):
        raise ValueError(f"Duplicate agent names: {names}")

    g = StateGraph(ResearchState)
    for agent in agents:
        g.add_node(agent.name, agent)
    g.set_entry_point(entry or names[0])
    for agent, following in zip(agents, [*names[1:], END]):
        if isinstance(agent, Router):
            g.add_conditional_edges(agent.name, agent.route, list(agent.routes))
        else:
            g.add_edge(agent.name, following)
    return g.compile()
