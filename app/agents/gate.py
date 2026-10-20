from app import config
from app.agents.base import Agent, Router

REVIEW_WEIGHT = 0.6
GROUNDING_WEIGHT = 0.4


def combined_confidence(critic_score: float, hallucination_risk: float) -> float:
    return round(critic_score * REVIEW_WEIGHT + (1 - hallucination_risk) * GROUNDING_WEIGHT, 3)


class GateAgent(Agent, Router):
    name = "decide"
    title = "Gate"
    description = "Combines the scores and either approves the idea or sends it back."
    outputs = ("confidence", "approved", "route")

    def __init__(self, retry: str, proceed: str,
                 threshold: float = config.THRESHOLD, max_attempts: int = config.MAX_ATTEMPTS):
        self.retry, self.proceed = retry, proceed
        self.routes = (retry, proceed)
        self.threshold, self.max_attempts = threshold, max_attempts

    def run(self, state):
        confidence = combined_confidence(state["critic_score"], state["hallucination_risk"])
        approved = confidence >= self.threshold
        out_of_attempts = state.get("attempts", 1) >= self.max_attempts
        route = self.proceed if approved or out_of_attempts else self.retry

        if approved:
            intent = "approved_hypothesis"
            self.say(f"Score {confidence:.2f} passes the bar of {self.threshold:.2f}. Idea approved")
        elif route == self.retry:
            intent = "retry_hypothesis"
            self.say(f"Score {confidence:.2f} is below {self.threshold:.2f}. Sending it back for a better idea")
        else:
            intent = "max_attempts_reached"
            self.say(f"Score {confidence:.2f} is still low after {self.max_attempts} tries. Moving on with the latest idea")

        return {"confidence": confidence, "approved": approved, "route": route,
                "messages": self.message(intent, {"hypothesis": state["hypothesis"], "next": route,
                                                  "threshold": self.threshold}, confidence)}

    def route(self, state):
        return state["route"]
