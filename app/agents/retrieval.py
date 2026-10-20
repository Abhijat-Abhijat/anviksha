from app import config
from app.agents.base import Agent, log
from app.sources import PaperSource


class RetrievalAgent(Agent):
    name = "retrieve"
    title = "Retrieve"
    description = "Searches published research for the most relevant papers."
    outputs = ("papers",)

    def __init__(self, source: PaperSource, limit: int = config.N_PAPERS):
        self.source = source
        self.limit = limit

    def run(self, state):
        self.say(f"Searching {self.source.name} for papers about “{state['topic']}”")
        try:
            papers = self.source.search(state["topic"], self.limit)
        except Exception:
            log.exception("%s search failed", self.source.name)
            papers = []
        self.say(f"Found {len(papers)} papers" if papers else "No papers found, continuing from general knowledge")
        return {"papers": papers,
                "messages": self.message("papers_retrieved", {"titles": [p["title"] for p in papers]})}
