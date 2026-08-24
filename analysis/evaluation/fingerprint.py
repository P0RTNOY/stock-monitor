from __future__ import annotations

import hashlib
import json
from dataclasses import asdict
from datetime import date, datetime, timezone
from typing import Any

from analysis.contracts import Bar
from analysis.evaluation.contracts import ForecastTerms


def _canonical(value: Any) -> Any:
    if isinstance(value, datetime):
        utc_value = value.astimezone(timezone.utc)
        return utc_value.isoformat(timespec="microseconds").replace("+00:00", "Z")
    if isinstance(value, date):
        return value.isoformat()
    if isinstance(value, dict):
        return {str(key): _canonical(item) for key, item in value.items()}
    if isinstance(value, (tuple, list)):
        return [_canonical(item) for item in value]
    return value


def fingerprint_payload(
    forecast: ForecastTerms,
    eligible_observations: tuple[Bar, ...],
    coverage_state: dict[str, Any],
    ruleset_version: str,
) -> dict[str, Any]:
    return _canonical(
        {
            "forecast": asdict(forecast),
            "eligible_observations": [
                asdict(bar) for bar in eligible_observations
            ],
            "cutoff_milestone": {
                "eligible_completed_at_max": (
                    eligible_observations[-1].completed_at
                    if eligible_observations
                    else forecast.activation_cutoff
                ),
                "horizon_reviewable": coverage_state["horizon_reviewable"],
                "available_expected_sessions": coverage_state[
                    "available_expected_sessions"
                ],
                "missing_available_sessions": coverage_state[
                    "missing_available_sessions"
                ],
            },
            "coverage": {
                "calendar_id": coverage_state["calendar_id"],
                "calendar_version": coverage_state["calendar_version"],
                "calendar_supported": coverage_state["calendar_supported"],
                "market_timezone": coverage_state["market_timezone"],
                "expected_sessions": coverage_state["expected_sessions"],
                "final_expected_session": coverage_state[
                    "final_expected_session"
                ],
                "horizon_available_at": coverage_state[
                    "horizon_available_at"
                ],
                "provider_complete": coverage_state["provider_complete"],
                "observed_currency": coverage_state["observed_currency"],
            },
            "ruleset_version": ruleset_version,
        }
    )


def input_fingerprint(
    forecast: ForecastTerms,
    eligible_observations: tuple[Bar, ...],
    coverage_state: dict[str, Any],
    ruleset_version: str,
) -> str:
    encoded = json.dumps(
        fingerprint_payload(
            forecast,
            eligible_observations,
            coverage_state,
            ruleset_version,
        ),
        ensure_ascii=False,
        allow_nan=False,
        sort_keys=True,
        separators=(",", ":"),
    ).encode("utf-8")
    return hashlib.sha256(encoded).hexdigest()
