from __future__ import annotations

from math import ceil
from typing import TypeVar

T = TypeVar("T")

DEFAULT_PAGE = 1
DEFAULT_PAGE_SIZE = 20
MAX_PAGE_SIZE = 200


def normalize_pagination(page: int | None, page_size: int | None) -> tuple[int, int] | None:
    if page is None and page_size is None:
        return None
    resolved_page = page if page is not None else DEFAULT_PAGE
    resolved_page_size = page_size if page_size is not None else DEFAULT_PAGE_SIZE
    if resolved_page < 1:
        raise ValueError("page must be >= 1")
    if resolved_page_size < 1:
        raise ValueError("pageSize must be >= 1")
    if resolved_page_size > MAX_PAGE_SIZE:
        raise ValueError(f"pageSize must be <= {MAX_PAGE_SIZE}")
    return resolved_page, resolved_page_size


def normalize_order(order: str | None) -> str:
    if order in (None, "", "asc"):
        return "asc"
    if order == "desc":
        return "desc"
    raise ValueError("order must be one of: asc, desc")


def apply_order(items: list[T], order: str) -> list[T]:
    if order == "desc":
        return list(reversed(items))
    return items


def paginate_items(items: list[T], page: int, page_size: int) -> list[T]:
    start = (page - 1) * page_size
    end = start + page_size
    return items[start:end]


def build_list_payload(
    items: list[T],
    total: int,
    *,
    page: int | None = None,
    page_size: int | None = None,
) -> dict:
    payload: dict[str, int | list[T]] = {
        "items": items,
        "total": total,
    }
    if page is not None and page_size is not None:
        total_pages = max(1, ceil(total / page_size)) if total > 0 else 1
        payload["page"] = page
        payload["pageSize"] = page_size
        payload["totalPages"] = total_pages
    return payload
