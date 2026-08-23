from __future__ import annotations

import unittest
from unittest.mock import patch

import news


class _Response:
    def __init__(self, payload: bytes) -> None:
        self.payload = payload

    def __enter__(self) -> _Response:
        return self

    def __exit__(self, *_args: object) -> None:
        return None

    def read(self) -> bytes:
        return self.payload


class NewsTests(unittest.TestCase):
    def test_rss_headlines_are_parsed_and_limited(self) -> None:
        payload = b"""<?xml version="1.0"?>
        <rss><channel>
          <item><title>First &amp; best</title><link>https://example.com/1</link>
            <source>Example</source><pubDate>Thu, 14 Aug 2026 10:30:00 GMT</pubDate></item>
          <item><title>Second</title><link>https://example.com/2</link>
            <source>Example</source><pubDate></pubDate></item>
        </channel></rss>"""

        with patch("news.urlopen", return_value=_Response(payload)):
            headlines = news.get_stock_headlines("AAPL", "Apple", limit=1)

        self.assertEqual(len(headlines), 1)
        self.assertEqual(headlines[0]["title"], "First & best")
        self.assertEqual(headlines[0]["source"], "Example")
        self.assertEqual(headlines[0]["published"], "2026-08-14 10:30")
        self.assertEqual(headlines[0]["link"], "https://example.com/1")

    def test_unsafe_headline_link_is_removed(self) -> None:
        payload = b"""<rss><channel><item><title>Headline</title>
        <link>javascript:alert(1)</link></item></channel></rss>"""

        with patch("news.urlopen", return_value=_Response(payload)):
            headlines = news.get_stock_headlines("AAPL")

        self.assertEqual(headlines[0]["link"], "")

    def test_network_and_xml_failures_log_without_sensitive_details(self) -> None:
        with patch("news.urlopen", side_effect=RuntimeError("private response")):
            with self.assertLogs("news", level="WARNING") as network_logs:
                self.assertEqual(news.get_stock_headlines("SECRET"), [])
        with patch("news.urlopen", return_value=_Response(b"not xml")):
            with self.assertLogs("news", level="WARNING") as parse_logs:
                self.assertEqual(news.get_stock_headlines("SECRET"), [])

        output = " ".join(network_logs.output + parse_logs.output)
        self.assertIn("RuntimeError", output)
        self.assertIn("ParseError", output)
        self.assertNotIn("private response", output)
        self.assertNotIn("SECRET", output)
        self.assertNotIn("not xml", output)


if __name__ == "__main__":
    unittest.main()
