from __future__ import annotations

import json
import threading
import unittest
from datetime import date, datetime, time, timedelta, timezone
from http.client import HTTPConnection
from unittest.mock import MagicMock, patch
from zoneinfo import ZoneInfo

import pandas as pd

import finance
from analysis.api import APIInputError, evaluate_payload, create_server
from analysis.contracts import Bar, ContractError
from analysis.evaluation import (
    CoverageProof,
    EvaluationInput,
    ForecastTerms,
    RULESET_VERSION,
    evaluate_forecast,
)
from analysis.evaluation.service import evaluate_forecast_with_provider
from analysis.providers import (
    EvaluationMarketData,
    ProviderError,
    YahooEvaluationProvider,
)


NY = ZoneInfo("America/New_York")


def instant(value: str) -> datetime:
    return datetime.fromisoformat(value.replace("Z", "+00:00"))


def frame(*dates: str) -> pd.DataFrame:
    return pd.DataFrame(
        {
            "Timestamp": pd.to_datetime(dates),
            "Open": [100.0] * len(dates),
            "High": [105.0] * len(dates),
            "Low": [95.0] * len(dates),
            "Close": [101.0] * len(dates),
            "Volume": [1_000.0] * len(dates),
            "Dividends": [0.0] * len(dates),
            "Stock Splits": [0.0] * len(dates),
        }
    )


def terms(**changes) -> ForecastTerms:
    values = {
        "forecast_id": 41,
        "symbol": "AAPL",
        "direction": "bullish",
        "activated_at": instant("2025-01-05T12:00:00Z"),
        "activation_market_data_as_of": instant("2025-01-05T12:00:00Z"),
        "activation_price": 100.0,
        "currency": "USD",
        "evaluation_date": date(2025, 1, 7),
        "target_price": 110.0,
        "target_range": None,
        "invalidation_price": 90.0,
        "adjustment_mode": "raw",
    }
    values.update(changes)
    return ForecastTerms(**values)


def bar(market_date: date) -> Bar:
    return Bar(
        symbol="AAPL",
        timeframe="1d",
        timestamp=datetime.combine(market_date, time.min, tzinfo=NY),
        completed_at=datetime.combine(
            market_date + timedelta(days=1), time.min, tzinfo=NY
        ),
        timezone="America/New_York",
        open=100,
        high=105,
        low=95,
        close=101,
        volume=1_000,
        is_complete=True,
        adjustment_mode="raw",
        provider="fixture-yahoo",
    )


def request_payload(**forecast_changes):
    forecast = {
        "forecast_id": 41,
        "symbol": "AAPL",
        "direction": "bullish",
        "activated_at": "2025-01-05T12:00:00Z",
        "activation_market_data_as_of": "2025-01-05T12:00:00Z",
        "activation_price": 100.0,
        "currency": "USD",
        "evaluation_date": "2025-01-07",
        "target_price": 110.0,
        "target_range": None,
        "invalidation_price": 90.0,
        "adjustment_mode": "raw",
    }
    forecast.update(forecast_changes)
    return {
        "forecast": forecast,
        "evaluation_cutoff": "2025-01-09T05:00:00Z",
        "ruleset_version": RULESET_VERSION,
    }


class YahooEvaluationProviderTests(unittest.TestCase):
    def test_fetches_a_bounded_range_and_maps_explicit_nasdaq_metadata(self) -> None:
        captured = {}

        def loader(symbol, start, end, interval):
            captured.update(
                symbol=symbol,
                start=start,
                end=end,
                interval=interval,
            )
            return frame("2025-01-06", "2025-01-07"), {
                "exchangeName": "NMS",
                "exchangeTimezoneName": "America/New_York",
                "currency": "USD",
            }

        result = YahooEvaluationProvider(loader).fetch_completed_observations(
            "AAPL",
            instant("2025-01-05T12:00:00Z"),
            date(2025, 1, 7),
            instant("2025-01-09T05:00:00Z"),
        )

        self.assertEqual(captured["interval"], "1d")
        self.assertEqual(captured["start"], date(2024, 12, 26))
        self.assertEqual(captured["end"], date(2025, 1, 9))
        self.assertEqual(result.calendar_id, "XNAS")
        self.assertEqual(result.currency, "USD")
        self.assertEqual(len(result.observations), 2)
        self.assertTrue(all(item.is_complete for item in result.observations))

    def test_unknown_exchange_remains_explicitly_unsupported(self) -> None:
        provider = YahooEvaluationProvider(
            lambda *_: (
                frame("2025-01-06"),
                {
                    "exchangeName": "MYSTERY",
                    "exchangeTimezoneName": "Europe/London",
                    "currency": "USD",
                },
            )
        )
        result = provider.fetch_completed_observations(
            "AAPL",
            instant("2025-01-05T12:00:00Z"),
            date(2025, 1, 7),
            instant("2025-01-09T05:00:00Z"),
        )
        self.assertEqual(result.calendar_id, "YAHOO:MYSTERY")
        self.assertNotEqual(result.calendar_id, "XNYS")
        self.assertEqual(result.market_timezone, "Europe/London")

    def test_missing_currency_is_preserved_as_unverified_metadata(self) -> None:
        provider = YahooEvaluationProvider(
            lambda *_: (
                frame("2025-01-06"),
                {
                    "exchangeName": "NMS",
                    "exchangeTimezoneName": "America/New_York",
                },
            )
        )
        result = provider.fetch_completed_observations(
            "AAPL",
            instant("2025-01-05T12:00:00Z"),
            date(2025, 1, 7),
            instant("2025-01-09T05:00:00Z"),
        )
        self.assertIsNone(result.currency)

    def test_empty_malformed_metadata_and_malformed_bars_fail_closed(self) -> None:
        cases = (
            lambda *_: (pd.DataFrame(), {}),
            lambda *_: (frame("2025-01-06"), {"exchangeName": "NMS"}),
            lambda *_: (
                frame("2025-01-06"),
                {
                    "exchangeName": "NMS",
                    "exchangeTimezoneName": "America/New_York",
                    "currency": 123,
                },
            ),
            lambda *_: (
                frame("2025-01-06").assign(High=90.0),
                {
                    "exchangeName": "NMS",
                    "exchangeTimezoneName": "America/New_York",
                    "currency": "USD",
                },
            ),
        )
        for loader in cases:
            with self.subTest(loader=loader), self.assertRaises(ProviderError):
                YahooEvaluationProvider(loader).fetch_completed_observations(
                    "AAPL",
                    instant("2025-01-05T12:00:00Z"),
                    date(2025, 1, 7),
                    instant("2025-01-09T05:00:00Z"),
                )

    def test_history_window_is_bounded_before_network_access(self) -> None:
        loader = MagicMock()
        with self.assertRaisesRegex(ContractError, "bounded"):
            YahooEvaluationProvider(loader).fetch_completed_observations(
                "AAPL",
                instant("2020-01-01T00:00:00Z"),
                date(2025, 1, 7),
                instant("2025-01-09T05:00:00Z"),
            )
        loader.assert_not_called()

    def test_finance_adapter_forwards_explicit_timeout_and_raw_settings(self) -> None:
        ticker = MagicMock()
        ticker.history.return_value = frame("2025-01-06").set_index("Timestamp")
        ticker.history.return_value.index.name = "Date"
        ticker.get_history_metadata.return_value = {
            "exchangeName": "NMS",
            "exchangeTimezoneName": "America/New_York",
            "currency": "USD",
        }
        with patch("finance.yf.Ticker", return_value=ticker):
            loaded, metadata = finance.get_ohlcv_history_range_with_metadata(
                "AAPL",
                date(2025, 1, 1),
                date(2025, 1, 8),
                timeout=7,
            )
        self.assertFalse(loaded.empty)
        self.assertEqual(metadata["exchangeName"], "NMS")
        ticker.history.assert_called_once_with(
            start="2025-01-01",
            end="2025-01-08",
            interval="1d",
            auto_adjust=False,
            back_adjust=False,
            actions=True,
            repair=False,
            keepna=True,
            prepost=False,
            rounding=False,
            timeout=7,
        )


class EvaluationServiceTests(unittest.TestCase):
    def test_builds_coverage_and_injects_the_exact_cutoff_into_pure_evaluator(self) -> None:
        observations = (bar(date(2025, 1, 6)), bar(date(2025, 1, 7)))
        provider = MagicMock()
        provider.fetch_completed_observations.return_value = EvaluationMarketData(
            observations=observations,
            calendar_id="XNAS",
            market_timezone="America/New_York",
            currency="USD",
            exchange="NMS",
        )
        captured = {}

        def pure(evaluation: EvaluationInput):
            captured["input"] = evaluation
            return evaluate_forecast(evaluation)

        cutoff = instant("2025-01-08T05:00:00Z")
        result = evaluate_forecast_with_provider(
            terms(),
            cutoff,
            RULESET_VERSION,
            provider=provider,
            evaluator=pure,
        )
        self.assertEqual(captured["input"].cutoff, cutoff)
        self.assertEqual(captured["input"].coverage.calendar_id, "XNAS")
        self.assertEqual(result.kind, "expired")

    def test_unknown_exchange_produces_reviewable_unsupported_coverage(self) -> None:
        provider = MagicMock()
        provider.fetch_completed_observations.return_value = EvaluationMarketData(
            observations=(bar(date(2025, 1, 6)),),
            calendar_id="YAHOO:MYSTERY",
            market_timezone="America/New_York",
            currency="USD",
            exchange="MYSTERY",
        )
        result = evaluate_forecast_with_provider(
            terms(),
            instant("2025-01-09T05:00:00Z"),
            RULESET_VERSION,
            provider=provider,
        )
        self.assertEqual(result.kind, "needs_review")
        self.assertFalse(result.evidence.coverage_findings["calendar_supported"])

    def test_currency_mismatch_and_missing_currency_are_durable_review_results(
        self,
    ) -> None:
        for observed_currency, expected_reason in (
            ("EUR", "currency_mismatch"),
            (None, "currency_unverified"),
        ):
            with self.subTest(observed_currency=observed_currency):
                provider = MagicMock()
                provider.fetch_completed_observations.return_value = (
                    EvaluationMarketData(
                        observations=(bar(date(2025, 1, 6)),),
                        calendar_id="XNAS",
                        market_timezone="America/New_York",
                        currency=observed_currency,
                        exchange="NMS",
                    )
                )
                result = evaluate_forecast_with_provider(
                    terms(),
                    instant("2025-01-09T05:00:00Z"),
                    RULESET_VERSION,
                    provider=provider,
                )
                self.assertEqual(
                    (result.kind, result.reason_code),
                    ("needs_review", expected_reason),
                )
                self.assertEqual(
                    result.evidence.coverage_findings["observed_currency"],
                    observed_currency,
                )

    def test_missing_yahoo_action_columns_force_review_instead_of_scoring(
        self,
    ) -> None:
        ticker = MagicMock()
        ticker.history.return_value = pd.DataFrame(
            {
                "Open": [100.0, 101.0],
                "High": [105.0, 111.0],
                "Low": [95.0, 99.0],
                "Close": [101.0, 109.0],
                "Volume": [1_000.0, 1_100.0],
            },
            index=pd.DatetimeIndex(
                ["2025-01-06", "2025-01-07"], name="Date"
            ),
        )
        ticker.get_history_metadata.return_value = {
            "exchangeName": "NMS",
            "exchangeTimezoneName": "America/New_York",
            "currency": "USD",
        }
        with patch("finance.yf.Ticker", return_value=ticker):
            result = evaluate_forecast_with_provider(
                terms(),
                instant("2025-01-08T05:00:00Z"),
                RULESET_VERSION,
                provider=YahooEvaluationProvider(),
            )

        self.assertEqual(
            (result.kind, result.reason_code),
            ("needs_review", "corporate_action_price_discontinuity"),
        )
        self.assertEqual(
            result.evidence.triggering_observation.corporate_action_flags,
            ("corporate_action_metadata_incomplete",),
        )

    def test_long_forecast_horizon_can_resolve_from_a_short_bounded_window(
        self,
    ) -> None:
        captured = {}

        def loader(symbol, start, end, interval):
            captured.update(start=start, end=end, interval=interval)
            return frame("2025-01-06").assign(High=110.0, Close=109.0), {
                "exchangeName": "NMS",
                "exchangeTimezoneName": "America/New_York",
                "currency": "USD",
            }

        result = evaluate_forecast_with_provider(
            terms(evaluation_date=date(2030, 1, 7)),
            instant("2025-01-07T05:00:00Z"),
            RULESET_VERSION,
            provider=YahooEvaluationProvider(loader),
        )

        self.assertEqual((result.kind, result.reason_code), (
            "target_hit",
            "target_boundary_touched",
        ))
        self.assertEqual(captured["start"], date(2024, 12, 26))
        self.assertEqual(captured["end"], date(2025, 1, 9))
        self.assertEqual(captured["interval"], "1d")


class EvaluationPayloadTests(unittest.TestCase):
    def test_strict_payload_returns_only_the_serialized_result(self) -> None:
        captured = {}

        def service(forecast, cutoff, ruleset):
            captured.update(forecast=forecast, cutoff=cutoff, ruleset=ruleset)
            coverage = CoverageProof(
                calendar_id="UNKNOWN",
                calendar_version="test-1",
                market_timezone="America/New_York",
                expected_sessions=(),
                final_expected_session=None,
                horizon_available_at=instant("2025-01-08T00:00:00Z"),
                calendar_supported=False,
            )
            return evaluate_forecast(
                EvaluationInput(
                    forecast,
                    (bar(date(2025, 1, 6)),),
                    cutoff,
                    coverage,
                    ruleset,
                )
            )

        response = evaluate_payload(request_payload(), evaluation_service=service)
        self.assertEqual(set(response), {"result"})
        self.assertEqual(response["result"]["forecast_id"], 41)
        self.assertEqual(response["result"]["reason_code"], "currency_unverified")
        self.assertEqual(captured["forecast"].symbol, "AAPL")
        self.assertEqual(captured["cutoff"], instant("2025-01-09T05:00:00Z"))

    def test_rejects_unknown_missing_noncanonical_and_invalid_domain_fields(self) -> None:
        payloads = []
        extra = request_payload()
        extra["browser_ohlc"] = []
        payloads.append(extra)
        missing = request_payload()
        del missing["forecast"]["currency"]
        payloads.append(missing)
        payloads.append(request_payload(symbol=" aapl "))
        payloads.append(request_payload(direction=[]))
        payloads.append(request_payload(activated_at="2025-01-05T12:00:00"))
        payloads.append(request_payload(target_price=99.0))
        payloads.append(request_payload(target_range=[100.0, 101.0, 102.0]))
        for payload in payloads:
            with self.subTest(payload=payload), self.assertRaises(
                (APIInputError, ContractError)
            ):
                evaluate_payload(payload, evaluation_service=MagicMock())


class EvaluationLoopbackTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        def service(forecast, cutoff, ruleset):
            coverage = CoverageProof(
                calendar_id="UNKNOWN",
                calendar_version="test-1",
                market_timezone="America/New_York",
                expected_sessions=(),
                final_expected_session=None,
                horizon_available_at=instant("2025-01-08T00:00:00Z"),
                calendar_supported=False,
            )
            return evaluate_forecast(
                EvaluationInput(
                    forecast,
                    (bar(date(2025, 1, 6)),),
                    cutoff,
                    coverage,
                    ruleset,
                )
            )

        cls.server = create_server("127.0.0.1", 0, evaluator=service)
        cls.thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.thread.start()
        cls.port = cls.server.server_address[1]

    @classmethod
    def tearDownClass(cls) -> None:
        cls.server.shutdown()
        cls.server.server_close()
        cls.thread.join(timeout=2)

    def request(self, payload: object) -> tuple[int, dict]:
        connection = HTTPConnection("127.0.0.1", self.port, timeout=5)
        connection.request(
            "POST",
            "/v1/evaluate",
            body=json.dumps(payload).encode(),
            headers={"Content-Type": "application/json"},
        )
        response = connection.getresponse()
        decoded = json.loads(response.read())
        connection.close()
        return response.status, decoded

    def test_evaluation_round_trip_has_exact_result_envelope(self) -> None:
        status, payload = self.request(request_payload())
        self.assertEqual(status, 200)
        self.assertEqual(set(payload), {"result"})
        self.assertEqual(payload["result"]["forecast_id"], 41)
        self.assertEqual(payload["result"]["reason_code"], "currency_unverified")

    def test_domain_invalid_request_is_422(self) -> None:
        status, payload = self.request(request_payload(target_price=99.0))
        self.assertEqual(status, 422)
        self.assertEqual(payload, {"error": "Forecast evaluation input is invalid."})

    def test_oversized_request_is_rejected_before_evaluation(self) -> None:
        status, _ = self.request({"padding": "x" * 5_000})
        self.assertEqual(status, 413)


class EvaluationProviderFailureLoopbackTest(unittest.TestCase):
    def test_provider_failure_is_503_without_a_fake_result(self) -> None:
        def unavailable(*_):
            raise ProviderError("private upstream payload")

        server = create_server("127.0.0.1", 0, evaluator=unavailable)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            connection = HTTPConnection(
                "127.0.0.1", server.server_address[1], timeout=5
            )
            connection.request(
                "POST",
                "/v1/evaluate",
                body=json.dumps(request_payload()).encode(),
                headers={"Content-Type": "application/json"},
            )
            response = connection.getresponse()
            payload = json.loads(response.read())
            connection.close()
            self.assertEqual(response.status, 503)
            self.assertEqual(payload, {"error": "Completed market data is unavailable."})
            self.assertNotIn("result", payload)
            self.assertNotIn("private", json.dumps(payload))
        finally:
            server.shutdown()
            server.server_close()
            thread.join(timeout=2)


if __name__ == "__main__":
    unittest.main()
