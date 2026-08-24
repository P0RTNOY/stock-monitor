from __future__ import annotations

import argparse
import json
import logging
import re
from collections.abc import Callable
from datetime import date, datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from math import isfinite
from typing import Any
from urllib.parse import urlsplit

from analysis.contracts import AnalysisReport, ContractError
from analysis.engine import ENGINE_VERSION
from analysis.evaluation.contracts import EvaluationResult, ForecastTerms
from analysis.evaluation.service import evaluate_forecast_with_provider
from analysis.providers import ProviderError
from analysis.service import analyze_symbol


LOGGER = logging.getLogger(__name__)
MAX_REQUEST_BYTES = 4 * 1024
SYMBOL_PATTERN = re.compile(r"^[A-Z][A-Z0-9.-]{0,9}$")
REQUEST_FIELDS = {
    "symbol",
    "accountRisk",
    "commissionPerUnit",
    "expectedSlippagePerUnit",
    "executionStopPrice",
}
EVALUATION_REQUEST_FIELDS = {
    "forecast",
    "evaluation_cutoff",
    "ruleset_version",
}
FORECAST_REQUEST_FIELDS = {
    "forecast_id",
    "symbol",
    "direction",
    "activated_at",
    "activation_market_data_as_of",
    "activation_price",
    "currency",
    "evaluation_date",
    "target_price",
    "target_range",
    "invalidation_price",
    "adjustment_mode",
}
INSTANT_PATTERN = re.compile(
    r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})$"
)
DATE_PATTERN = re.compile(r"^\d{4}-\d{2}-\d{2}$")
CURRENCY_PATTERN = re.compile(r"^[A-Z]{3,12}$")
Analyzer = Callable[..., AnalysisReport]
EvaluationService = Callable[[ForecastTerms, datetime, str], EvaluationResult]


class APIInputError(ValueError):
    """A safe validation error that can be returned to the local client."""


def _optional_number(
    payload: dict[str, Any],
    field: str,
    *,
    positive: bool,
) -> float | None:
    value = payload.get(field)
    if value is None:
        return None
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise APIInputError(f"{field} must be a number or null")
    number = float(value)
    if not isfinite(number) or (number <= 0 if positive else number < 0):
        qualifier = "positive" if positive else "non-negative"
        raise APIInputError(f"{field} must be finite and {qualifier}")
    return number


def analyze_payload(
    payload: Any,
    *,
    analyzer: Analyzer = analyze_symbol,
    clock: Callable[[], datetime] | None = None,
) -> dict[str, Any]:
    if not isinstance(payload, dict):
        raise APIInputError("request body must be a JSON object")
    unknown = sorted(set(payload) - REQUEST_FIELDS)
    if unknown:
        raise APIInputError(f"unsupported request fields: {unknown}")

    raw_symbol = payload.get("symbol")
    symbol = raw_symbol.strip().upper() if isinstance(raw_symbol, str) else ""
    if not SYMBOL_PATTERN.fullmatch(symbol):
        raise APIInputError("symbol must be a valid ticker")

    now = (clock or (lambda: datetime.now(timezone.utc)))()
    if now.tzinfo is None or now.utcoffset() is None:
        raise RuntimeError("analysis API clock must return a timezone-aware timestamp")
    report = analyzer(
        symbol,
        now,
        account_risk=_optional_number(payload, "accountRisk", positive=True),
        commission_per_unit=_optional_number(
            payload,
            "commissionPerUnit",
            positive=False,
        ),
        expected_slippage_per_unit=_optional_number(
            payload,
            "expectedSlippagePerUnit",
            positive=False,
        ),
        execution_stop_price=_optional_number(
            payload,
            "executionStopPrice",
            positive=True,
        ),
    )
    return {"report": report.to_dict()}


def _exact_fields(
    payload: dict[str, Any],
    expected: set[str],
    label: str,
) -> None:
    missing = sorted(expected - set(payload))
    unknown = sorted(set(payload) - expected)
    if missing:
        raise APIInputError(f"missing {label} fields: {missing}")
    if unknown:
        raise APIInputError(f"unsupported {label} fields: {unknown}")


def _instant(value: Any, field: str) -> datetime:
    if not isinstance(value, str) or not INSTANT_PATTERN.fullmatch(value):
        raise APIInputError(f"{field} must be an ISO 8601 timestamp with an offset")
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError as exc:
        raise APIInputError(f"{field} must be a valid timestamp") from exc
    if parsed.tzinfo is None or parsed.utcoffset() is None:
        raise APIInputError(f"{field} must be timezone-aware")
    return parsed


def _date(value: Any, field: str) -> date:
    if not isinstance(value, str) or not DATE_PATTERN.fullmatch(value):
        raise APIInputError(f"{field} must use YYYY-MM-DD")
    try:
        parsed = date.fromisoformat(value)
    except ValueError as exc:
        raise APIInputError(f"{field} must be a valid calendar date") from exc
    if parsed.isoformat() != value:
        raise APIInputError(f"{field} must be a valid calendar date")
    return parsed


def _number(value: Any, field: str, *, nullable: bool) -> float | None:
    if nullable and value is None:
        return None
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise APIInputError(f"{field} must be a number{' or null' if nullable else ''}")
    number = float(value)
    if not isfinite(number):
        raise APIInputError(f"{field} must be finite")
    return number


def _forecast_terms(payload: Any) -> ForecastTerms:
    if not isinstance(payload, dict):
        raise APIInputError("forecast must be a JSON object")
    _exact_fields(payload, FORECAST_REQUEST_FIELDS, "forecast")

    forecast_id = payload["forecast_id"]
    if isinstance(forecast_id, bool) or not isinstance(forecast_id, int):
        raise APIInputError("forecast_id must be a positive integer")
    symbol = payload["symbol"]
    if not isinstance(symbol, str) or not SYMBOL_PATTERN.fullmatch(symbol):
        raise APIInputError("symbol must be an uppercase ticker")
    direction = payload["direction"]
    if not isinstance(direction, str) or direction not in {
        "bullish",
        "bearish",
        "neutral",
    }:
        raise APIInputError("direction is unsupported")
    currency = payload["currency"]
    if not isinstance(currency, str) or not CURRENCY_PATTERN.fullmatch(currency):
        raise APIInputError("currency must be an uppercase currency code")
    adjustment_mode = payload["adjustment_mode"]
    if adjustment_mode != "raw":
        raise APIInputError("adjustment_mode must be raw")

    raw_range = payload["target_range"]
    target_range = None
    if raw_range is not None:
        if not isinstance(raw_range, list) or len(raw_range) != 2:
            raise APIInputError("target_range must contain exactly two prices or null")
        target_range = (
            _number(raw_range[0], "target_range[0]", nullable=False),
            _number(raw_range[1], "target_range[1]", nullable=False),
        )

    return ForecastTerms(
        forecast_id=forecast_id,
        symbol=symbol,
        direction=direction,
        activated_at=_instant(payload["activated_at"], "activated_at"),
        activation_market_data_as_of=_instant(
            payload["activation_market_data_as_of"],
            "activation_market_data_as_of",
        ),
        activation_price=_number(
            payload["activation_price"], "activation_price", nullable=False
        ),
        currency=currency,
        evaluation_date=_date(payload["evaluation_date"], "evaluation_date"),
        target_price=_number(payload["target_price"], "target_price", nullable=True),
        target_range=target_range,
        invalidation_price=_number(
            payload["invalidation_price"], "invalidation_price", nullable=True
        ),
        adjustment_mode=adjustment_mode,
    )


def evaluate_payload(
    payload: Any,
    *,
    evaluation_service: EvaluationService = evaluate_forecast_with_provider,
) -> dict[str, Any]:
    if not isinstance(payload, dict):
        raise APIInputError("request body must be a JSON object")
    _exact_fields(payload, EVALUATION_REQUEST_FIELDS, "request")
    ruleset_version = payload["ruleset_version"]
    if (
        not isinstance(ruleset_version, str)
        or not ruleset_version
        or len(ruleset_version) > 100
    ):
        raise APIInputError("ruleset_version must be a non-empty string")
    result = evaluation_service(
        _forecast_terms(payload["forecast"]),
        _instant(payload["evaluation_cutoff"], "evaluation_cutoff"),
        ruleset_version,
    )
    if not isinstance(result, EvaluationResult):
        raise RuntimeError("evaluation service returned an invalid result")
    return {"result": result.to_dict()}


class AnalysisHTTPServer(ThreadingHTTPServer):
    daemon_threads = True

    def __init__(
        self,
        server_address: tuple[str, int],
        analyzer: Analyzer,
        evaluator: EvaluationService,
    ) -> None:
        self.analyzer = analyzer
        self.evaluator = evaluator
        super().__init__(server_address, AnalysisRequestHandler)


class AnalysisRequestHandler(BaseHTTPRequestHandler):
    server: AnalysisHTTPServer
    protocol_version = "HTTP/1.1"

    def _write_json(self, status: int, payload: dict[str, Any]) -> None:
        body = json.dumps(
            payload,
            ensure_ascii=False,
            separators=(",", ":"),
            allow_nan=False,
        ).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self) -> None:  # noqa: N802 - stdlib handler API
        if urlsplit(self.path).path != "/health":
            self._write_json(404, {"error": "Not found."})
            return
        self._write_json(
            200,
            {
                "status": "ok",
                "service": "northstar-analysis",
                "engineVersion": ENGINE_VERSION,
            },
        )

    def do_POST(self) -> None:  # noqa: N802 - stdlib handler API
        path = urlsplit(self.path).path
        if path not in {"/v1/analyze", "/v1/evaluate"}:
            self._write_json(404, {"error": "Not found."})
            return
        media_type = self.headers.get("Content-Type", "").split(";", 1)[0]
        if media_type.strip().lower() != "application/json":
            self._write_json(415, {"error": "Content-Type must be application/json."})
            return
        try:
            content_length = int(self.headers.get("Content-Length", ""))
        except ValueError:
            self._write_json(400, {"error": "A valid Content-Length is required."})
            return
        if content_length <= 0 or content_length > MAX_REQUEST_BYTES:
            self._write_json(413, {"error": "Request body is empty or too large."})
            return

        try:
            payload = json.loads(self.rfile.read(content_length).decode("utf-8"))
            response = (
                analyze_payload(payload, analyzer=self.server.analyzer)
                if path == "/v1/analyze"
                else evaluate_payload(
                    payload,
                    evaluation_service=self.server.evaluator,
                )
            )
        except (UnicodeDecodeError, json.JSONDecodeError):
            self._write_json(400, {"error": "Request body must be valid JSON."})
            return
        except APIInputError as exc:
            self._write_json(422, {"error": str(exc)})
            return
        except ContractError:
            message = (
                "Analysis assumptions are invalid."
                if path == "/v1/analyze"
                else "Forecast evaluation input is invalid."
            )
            self._write_json(422, {"error": message})
            return
        except ProviderError:
            self._write_json(503, {"error": "Completed market data is unavailable."})
            return
        except Exception as exc:  # pragma: no cover - defensive boundary
            LOGGER.warning("analysis API failed (%s)", type(exc).__name__)
            self._write_json(500, {"error": "Analysis is temporarily unavailable."})
            return
        self._write_json(200, response)

    def log_message(self, format: str, *args: object) -> None:
        LOGGER.info("analysis API request from %s", self.client_address[0])


def create_server(
    host: str = "127.0.0.1",
    port: int = 8502,
    *,
    analyzer: Analyzer = analyze_symbol,
    evaluator: EvaluationService = evaluate_forecast_with_provider,
) -> AnalysisHTTPServer:
    return AnalysisHTTPServer((host, port), analyzer, evaluator)


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Serve the local Northstar technical-analysis API."
    )
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8502)
    args = parser.parse_args()
    if not 1 <= args.port <= 65535:
        parser.error("port must be between 1 and 65535")

    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(message)s")
    server = create_server(args.host, args.port)
    LOGGER.info("Northstar analysis API listening on http://%s:%s", args.host, args.port)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
