"""Prompt templates live as Markdown files next to this module.

Placeholders use `$name` (string.Template), so JSON braces need no escaping.
A missing placeholder value raises KeyError instead of silently sending a broken prompt.
"""
from functools import cache
from pathlib import Path
from string import Template

PROMPT_DIR = Path(__file__).parent


@cache
def _template(name: str) -> Template:
    return Template((PROMPT_DIR / f"{name}.md").read_text(encoding="utf-8"))


def render(name: str, **values) -> str:
    return _template(name).substitute(**values).strip()
