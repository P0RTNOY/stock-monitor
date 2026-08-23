from __future__ import annotations

import html
import logging
import xml.etree.ElementTree as ET
from email.utils import parsedate_to_datetime
from urllib.parse import quote_plus, urlparse
from urllib.request import Request, urlopen


LOGGER = logging.getLogger(__name__)


def _log_external_failure(operation: str, error: Exception) -> None:
    LOGGER.warning("%s failed (%s)", operation, type(error).__name__)


def get_stock_headlines(symbol: str, company_name: str = "", limit: int = 5) -> list[dict[str, str]]:
    query = f"{company_name or symbol} stock"
    url = (
        "https://news.google.com/rss/search?"
        f"q={quote_plus(query)}&hl=en-US&gl=US&ceid=US:en"
    )
    request = Request(url, headers={"User-Agent": "stock-forecast-journal/1.0"})

    try:
        with urlopen(request, timeout=8) as response:
            payload = response.read()
    except Exception as exc:
        _log_external_failure("Headline lookup", exc)
        return []

    try:
        root = ET.fromstring(payload)
    except ET.ParseError as exc:
        _log_external_failure("Headline parsing", exc)
        return []

    headlines: list[dict[str, str]] = []
    for item in root.findall("./channel/item")[:limit]:
        title = html.unescape(item.findtext("title", default="")).strip()
        link = item.findtext("link", default="").strip()
        if urlparse(link).scheme not in {"http", "https"}:
            link = ""
        source = item.findtext("source", default="").strip()
        published = _format_published(item.findtext("pubDate", default=""))

        if not title:
            continue

        headlines.append(
            {
                "title": title,
                "source": source,
                "published": published,
                "link": link,
            }
        )

    return headlines


def _format_published(pub_date: str) -> str:
    if not pub_date:
        return ""

    try:
        parsed = parsedate_to_datetime(pub_date)
    except (TypeError, ValueError):
        return pub_date

    return parsed.strftime("%Y-%m-%d %H:%M")
