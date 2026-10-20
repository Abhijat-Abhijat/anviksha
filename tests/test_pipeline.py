"""Offline tests: a fake LLM and paper source drive the real graph. No network, no API key."""
from app.agents import default_pipeline
from app.agents.gap_finder import parse_numbered
from app.agents.gate import combined_confidence
from app.graph import build_graph


class FakeSource:
    name = "fake"

    def search(self, query, limit):
        return [{"title": f"Paper {i}", "abstract": "We study things.", "published": "2024-01-01",
                 "url": f"https://arxiv.org/abs/{i}"} for i in range(limit)]


class FakeLLM:
    def __init__(self, critic_scores):
        self.critic_scores = list(critic_scores)

    def stream(self, prompt, *, max_tokens=1024, temperature=0.2):
        if "numbered list" in prompt:
            text = "1. Gap one.\n2. Gap two.\n3. Gap three."
        elif "Hypothesis agent" in prompt:
            text = "Increasing X improves Y accuracy by 5%."
        elif "Dataset:" in prompt:
            text = "Dataset:\n-\nMetrics:\n-\nBaselines:\n-\nExperimental Procedure:\n-\nEstimated Compute:\n-"
        else:
            text = "A short generated text for testing."
        for word in text.split(" "):  # stream pieces like a real model
            yield word + " "

    def complete_json(self, prompt, *, max_tokens=300):
        if '"score"' in prompt:
            return {"score": self.critic_scores.pop(0), "reason": "Fine."}
        return {"risk": 0.1}


def run(llm, entry=None, seed=None):
    graph = build_graph(default_pipeline(llm, FakeSource()), entry)
    events, state = [], {}
    for mode, chunk in graph.stream(seed or {"topic": "test", "messages": []}, stream_mode=["updates", "custom"]):
        if mode == "custom":
            events.append(chunk)
        else:
            for update in chunk.values():
                state.update({k: v for k, v in update.items() if k != "messages"})
    return state, events


def test_retry_loop_then_approve():
    # attempt 1: 0.3*0.6 + 0.9*0.4 = 0.54 (rejected); attempt 2: 0.95*0.6 + 0.36 = 0.93 (approved)
    state, events = run(FakeLLM([0.3, 0.95]))
    assert state["attempts"] == 2
    assert state["approved"] is True
    assert state["final_paper"]
    assert any(e["type"] == "status" for e in events)
    assert any(e["type"] == "token" and e["node"] == "write" for e in events)


def test_gives_up_after_max_attempts():
    state, _ = run(FakeLLM([0.1, 0.1, 0.1]))
    assert state["attempts"] == 3
    assert state["approved"] is False
    assert state["final_paper"]


def test_rerun_from_critique_uses_edited_hypothesis():
    seed = {"topic": "test", "messages": [], "hypothesis": "My own idea improves accuracy.", "attempts": 1,
            "summaries": [], "papers": []}
    state, _ = run(FakeLLM([0.99]), entry="critique", seed=seed)
    assert state["approved"] is True
    assert state["final_paper"]


def test_helpers():
    assert parse_numbered("intro\n1. a\n2) b\n  3. c") == ["a", "b", "c"]
    assert combined_confidence(1.0, 0.0) == 1.0
