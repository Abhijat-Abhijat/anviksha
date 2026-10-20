"""LLM abstraction. Agents depend on the `LLM` protocol, never on a vendor SDK."""
import json
from collections.abc import Iterator
from typing import Protocol

from app import config


class LLM(Protocol):
    def stream(self, prompt: str, *, max_tokens: int = 1024, temperature: float = 0.2) -> Iterator[str]:
        """Yield the completion piece by piece."""

    def complete_json(self, prompt: str, *, max_tokens: int = 300) -> dict:
        """Return the completion parsed as a JSON object."""


class GroqLLM:
    def __init__(self, model: str = config.GROQ_MODEL, max_retries: int = 5):
        self.model = model
        self.max_retries = max_retries
        self._client = None

    @property
    def client(self):
        # Lazy, so the app imports without GROQ_API_KEY. The SDK backs off and
        # honours retry-after on 429s, which the free tier hits easily.
        if self._client is None:
            from groq import Groq
            self._client = Groq(max_retries=self.max_retries)
        return self._client

    def _create(self, prompt: str, **kwargs):
        return self.client.chat.completions.create(
            model=self.model, messages=[{"role": "user", "content": prompt}], **kwargs)

    def stream(self, prompt, *, max_tokens=1024, temperature=0.2):
        for chunk in self._create(prompt, max_tokens=max_tokens, temperature=temperature, stream=True):
            if chunk.choices and (piece := chunk.choices[0].delta.content):
                yield piece

    def complete_json(self, prompt, *, max_tokens=300):
        r = self._create(prompt, max_tokens=max_tokens, temperature=0.1,
                         response_format={"type": "json_object"})
        return json.loads(r.choices[0].message.content or "{}")
