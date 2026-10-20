from app.agents.base import LLMAgent, clamp, log

FALLBACK_RISK = 0.7  # assume fairly risky when the check itself fails


class VerifierAgent(LLMAgent):
    name = "verify"
    title = "Verify"
    description = "Checks the idea is backed by the papers rather than made up."
    outputs = ("hallucination_risk",)
    tier = "fast"

    def run(self, state):
        self.say("Checking the idea is backed by the papers, not made up")
        evidence = " | ".join(s["title"] for s in state.get("summaries", [])) or "none"
        try:
            r = self.generate_json("verify", topic=state["topic"], hypothesis=state["hypothesis"],
                                   evidence=evidence, max_tokens=60)
            risk = clamp(r["risk"])
        except (ValueError, KeyError, TypeError):
            log.exception("Verifier returned an unusable answer")
            risk = FALLBACK_RISK
        self.say(f"Risk of made-up claims: {risk:.2f} (lower is better)")
        return {"hallucination_risk": risk,
                "messages": self.message("hallucination_checked", {"risk": risk}, round(1 - risk, 3))}
