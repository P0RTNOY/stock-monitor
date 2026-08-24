from __future__ import annotations

import json
import threading
import unittest
from datetime import timedelta
from http.client import HTTPConnection

from analysis.api import APIInputError, analyze_payload, create_server
from analysis.contracts import AnalysisReport, AnalysisRequest
from analysis.engine import AnalysisEngine
from tests.analysis_helpers import START, make_bar


def _report(symbol: str, as_of, **_: object) -> AnalysisReport:
    bars = tuple(
        make_bar(index, close=100 + index, high=101 + index, low=99 + index)
        for index in range(220)
    )
    return AnalysisEngine(clock=lambda: START + timedelta(days=500)).analyze(
        AnalysisRequest(symbol, as_of),
        bars,
    )


class AnalysisPayloadTests(unittest.TestCase):
    def test_payload_normalizes_symbol_and_forwards_explicit_assumptions(self) -> None:
        captured = {}

        def analyzer(symbol, as_of, **kwargs):
            captured.update(symbol=symbol, as_of=as_of, **kwargs)
            return _report(symbol, as_of)

        response = analyze_payload(
            {
                "symbol": " aapl ",
                "accountRisk": 1000,
                "commissionPerUnit": 0,
                "expectedSlippagePerUnit": 0.05,
                "executionStopPrice": 190,
            },
            analyzer=analyzer,
            clock=lambda: START,
        )

        self.assertEqual(captured["symbol"], "AAPL")
        self.assertEqual(captured["account_risk"], 1000)
        self.assertEqual(captured["commission_per_unit"], 0)
        self.assertEqual(captured["expected_slippage_per_unit"], 0.05)
        self.assertEqual(captured["execution_stop_price"], 190)
        self.assertEqual(response["report"]["symbol"], "AAPL")

    def test_payload_rejects_unknown_invalid_and_non_finite_values(self) -> None:
        invalid_payloads = (
            {},
            {"symbol": "AAPL", "unexpected": 1},
            {"symbol": "../../etc/passwd"},
            {"symbol": "AAPL", "accountRisk": True},
            {"symbol": "AAPL", "commissionPerUnit": -1},
            {"symbol": "AAPL", "executionStopPrice": float("inf")},
        )
        for payload in invalid_payloads:
            with self.subTest(payload=payload), self.assertRaises(APIInputError):
                analyze_payload(payload, analyzer=_report, clock=lambda: START)


class AnalysisHTTPTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.server = create_server("127.0.0.1", 0, analyzer=_report)
        cls.thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.thread.start()
        cls.port = cls.server.server_address[1]

    @classmethod
    def tearDownClass(cls) -> None:
        cls.server.shutdown()
        cls.server.server_close()
        cls.thread.join(timeout=2)

    def request(
        self,
        method: str,
        path: str,
        body: bytes | None = None,
        content_type: str = "application/json",
    ) -> tuple[int, dict]:
        connection = HTTPConnection("127.0.0.1", self.port, timeout=5)
        headers = {"Content-Type": content_type} if body is not None else {}
        connection.request(method, path, body=body, headers=headers)
        response = connection.getresponse()
        payload = json.loads(response.read())
        connection.close()
        return response.status, payload

    def test_health_and_analysis_round_trip(self) -> None:
        health_status, health = self.request("GET", "/health")
        status, payload = self.request(
            "POST",
            "/v1/analyze",
            json.dumps({"symbol": "AAPL"}).encode(),
        )

        self.assertEqual(health_status, 200)
        self.assertEqual(health["service"], "northstar-analysis")
        self.assertEqual(status, 200)
        self.assertEqual(payload["report"]["symbol"], "AAPL")

    def test_http_boundary_rejects_bad_media_json_and_paths(self) -> None:
        cases = (
            ("GET", "/missing", None, "application/json", 404),
            ("POST", "/missing", b"{}", "application/json", 404),
            ("POST", "/v1/analyze", b"{}", "text/plain", 415),
            ("POST", "/v1/analyze", b"{", "application/json", 400),
            ("POST", "/v1/analyze", b"{}", "application/json", 422),
        )
        for method, path, body, content_type, expected in cases:
            with self.subTest(method=method, path=path):
                status, _ = self.request(method, path, body, content_type)
                self.assertEqual(status, expected)


if __name__ == "__main__":
    unittest.main()
