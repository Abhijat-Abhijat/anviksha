from app.agents.base import LLMAgent


class SummarizerAgent(LLMAgent):
    name = "summarize"
    title = "Summarize"
    description = "Reads each paper and condenses it to its method, data and contribution."
    outputs = ("summaries",)

    def run(self, state):
        papers = state.get("papers", [])
        summaries = []
        for i, paper in enumerate(papers, 1):
            self.say(f"Reading paper {i} of {len(papers)}: {paper['title']}")
            text = self.generate("summarize", abstract=paper["abstract"], max_tokens=220)
            summaries.append({"title": paper["title"], "summary": " ".join(text.split())})
        return {"summaries": summaries,
                "messages": self.message("summaries_ready", {"summaries": summaries})}
