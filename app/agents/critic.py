from app.agents.base import LLMAgent, clamp, log


class CriticAgent(LLMAgent):
    name = "critique"
    title = "Critique"
    description = "Acts as a strict reviewer: is the idea new, specific and testable?"
    outputs = ("critic_score", "critic_reason")

    def run(self, state):
        self.say("A strict reviewer is checking whether the idea is new and testable")
        try:
            r = self.generate_json("critique", topic=state["topic"], hypothesis=state["hypothesis"], max_tokens=200)
            score, reason = clamp(r["score"]), str(r.get("reason", "")).strip()
        except (ValueError, KeyError, TypeError):
            log.exception("Critic returned an unusable answer")
            score, reason = 0.5, "The reviewer's answer could not be read, so a neutral score was used."
        self.say(f"Reviewer score: {score:.2f} out of 1")
        return {"critic_score": score, "critic_reason": reason,
                "messages": self.message("critique_complete", {"score": score, "reason": reason}, score)}
