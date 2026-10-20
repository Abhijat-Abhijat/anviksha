import arxiv

from app.sources import Paper

MAX_ABSTRACT_CHARS = 1800


class ArxivSource:
    name = "arXiv"

    def search(self, query: str, limit: int) -> list[Paper]:
        search = arxiv.Search(query=query, max_results=limit, sort_by=arxiv.SortCriterion.Relevance)
        return [
            {
                "title": " ".join(r.title.split()),
                "abstract": " ".join(r.summary.split())[:MAX_ABSTRACT_CHARS],
                "published": str(r.published.date()) if r.published else None,
                "url": r.entry_id.replace("http://", "https://", 1),
            }
            for r in arxiv.Client().results(search)
            if r.summary
        ]
