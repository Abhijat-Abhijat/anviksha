import re

from app.agents.base import LLMAgent

MIN_GAPS = 3
TRIES = 3


def parse_numbered(text: str) -> list[str]:
    return [m.group(1).strip() for m in re.finditer(r"^\s*\d+[.)]\s+(.+)$", text, re.M)]


class GapFinderAgent(LLMAgent):
    name = "find_gaps"
    title = "Gaps"
    description = "Finds open questions the papers leave unanswered."
    outputs = ("gaps",)

    def run(self, state):
        corpus = "\n\n".join(f"Paper: {s['title']}\nSummary: {s['summary']}" for s in state.get("summaries", []))
        gaps = []
        for attempt in range(1, TRIES + 1):
            self.say("Looking for questions these papers leave unanswered" if attempt == 1
                     else "That list was too thin, looking again")
            gaps = parse_numbered(self.generate(
                "gaps", topic=state["topic"], max_tokens=500,
                corpus=corpus or "(No papers were retrieved; reason from established domain knowledge.)"))
            if len(gaps) >= MIN_GAPS:
                break
        gaps = gaps or ["No distinct research gaps could be identified."]
        self.say(f"Found {len(gaps)} open questions")
        return {"gaps": gaps, "messages": self.message("gaps_identified", {"gaps": gaps})}
