from app.agents.base import LLMAgent


class WriterAgent(LLMAgent):
    name = "write"
    title = "Paper"
    description = "Writes everything up as a paper, citing only the papers found."
    outputs = ("final_paper",)

    def run(self, state):
        self.say("Writing the paper")
        papers = state.get("papers", [])
        sources = "\n".join(f"[{i}] {p['title']} ({p.get('published') or 'n.d.'}) {p['url']}"
                            for i, p in enumerate(papers, 1))
        paper = self.generate(
            "paper", topic=state["topic"], hypothesis=state["hypothesis"],
            gaps="\n".join(f"- {g}" for g in state.get("gaps", [])),
            experiment_plan=state.get("experiment_plan", ""),
            sources=sources or "(none retrieved)", max_tokens=2500)
        self.say(f"Done. The paper is {len(paper.split())} words")
        return {"final_paper": paper,
                "messages": self.message("paper_complete", {"words": len(paper.split())})}
