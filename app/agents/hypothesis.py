from app import config
from app.agents.base import LLMAgent
from app.prompts import render


class HypothesisAgent(LLMAgent):
    name = "propose"
    title = "Hypothesize"
    description = "Turns the open questions into one idea that can be tested."
    outputs = ("hypothesis", "attempts")

    def run(self, state):
        attempt = state.get("attempts", 0) + 1
        feedback = ""
        if attempt > 1 and state.get("hypothesis"):
            self.say(f"The last idea scored too low, trying a better one (attempt {attempt} of {config.MAX_ATTEMPTS})")
            feedback = render("hypothesis_feedback", confidence=f"{state.get('confidence', 0):.2f}",
                              threshold=f"{config.THRESHOLD:.2f}", previous=state["hypothesis"],
                              reason=state.get("critic_reason", ""))
        else:
            self.say("Coming up with an idea that can be tested")
        text = self.generate("hypothesis", topic=state["topic"], feedback=feedback,
                             gaps="\n".join(f"- {g}" for g in state.get("gaps", [])),
                             max_tokens=160, temperature=0.7)
        hypothesis = " ".join(text.split()).strip('"')
        return {"hypothesis": hypothesis, "attempts": attempt,
                "messages": self.message("hypothesis_proposed", {"hypothesis": hypothesis, "attempt": attempt})}
