from app.agents.base import LLMAgent

SECTIONS = ("Dataset:", "Metrics:", "Baselines:", "Experimental Procedure:", "Estimated Compute:")
TRIES = 3


class ExperimentAgent(LLMAgent):
    name = "design_experiment"
    title = "Experiment"
    description = "Plans how to test the idea: data, measurements, comparisons and steps."
    outputs = ("experiment_plan",)

    def run(self, state):
        plan = ""
        for attempt in range(1, TRIES + 1):
            self.say("Planning an experiment to test the idea" if attempt == 1
                     else "The plan missed a section, rewriting it")
            plan = self.generate("experiment", hypothesis=state["hypothesis"], max_tokens=900)
            if all(s in plan for s in SECTIONS):
                break
        return {"experiment_plan": plan,
                "messages": self.message("experiment_designed", {"experiment_plan": plan})}
