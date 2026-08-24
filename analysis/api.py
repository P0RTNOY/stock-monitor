from __future__ import annotations

import argparse
import json
import logging
import re
from collections.abc import Callable
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from math import isfinite
from typing import Any
from urllib.parse import urlsplit

from analysis.contracts import AnalysisReport, ContractError
from analysis.engine import ENGINE_VERSION
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
Analyzer = Callable[..., AnalysisReport]


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


class AnalysisHTTPServer(ThreadingHTTPServer):
    daemon_threads = True

    def __init__(self, server_address: tuple[str, int], analyzer: Analyzer) -> None:
        self.analyzer = analyzer
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
        if urlsplit(self.path).path != "/v1/analyze":
            self._write_json(404, {"error": "Not found."})
            return
        if not self.headers.get("Content-Type", "").lower().startswith(
            "application/json"
        ):
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
            response = analyze_payload(payload, analyzer=self.server.analyzer)
        except (UnicodeDecodeError, json.JSONDecodeError):
            self._write_json(400, {"error": "Request body must be valid JSON."})
            return
        except APIInputError as exc:
            self._write_json(422, {"error": str(exc)})
            return
        except ContractError:
            self._write_json(422, {"error": "Analysis assumptions are invalid."})
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
) -> AnalysisHTTPServer:
    return AnalysisHTTPServer((host, port), analyzer)


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
