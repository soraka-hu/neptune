from __future__ import annotations

from math import ceil
from typing import Any, Sequence


MAX_PAGE_SIZE = 200
DEFAULT_PAGE_SIZE = 20


def apply_order(items: Sequence[Any], order: str) -> list[Any]:
    if order not in {"asc", "desc"}:
        raise ValueError("order must be asc or desc")
    rows = list(items)
    if order == "desc":
        rows.reverse()
    return rows


def build_list_payload(items: Sequence[Any], *, page: int | None = None, page_size: int | None = None) -> dict[str, Any]:
    rows = list(items)
    total = len(rows)
    if page is None and page_size is None:
        return {"items": rows, "total": total}

    resolved_page = page or 1
    resolved_page_size = min(page_size or DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE)
    start = (resolved_page - 1) * resolved_page_size
    end = start + resolved_page_size
    total_pages = max(1, ceil(total / resolved_page_size))

    return {
        "items": rows[start:end],
        "total": total,
        "page": resolved_page,
        "pageSize": resolved_page_size,
        "totalPages": total_pages,
    }
