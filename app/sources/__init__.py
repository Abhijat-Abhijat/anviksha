"""Literature sources. Agents depend on `PaperSource`; add a new backend by implementing it."""
from typing import Protocol, TypedDict


class Paper(TypedDict):
    title: str
    abstract: str
    published: str | None
    url: str


class PaperSource(Protocol):
    name: str

    def search(self, query: str, limit: int) -> list[Paper]: ...
