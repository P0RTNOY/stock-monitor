from __future__ import annotations

import json
from copy import deepcopy
from pathlib import Path
from typing import Any

from analysis.evaluation.contracts import EvaluationContractError


RULESET_VERSION = "forecast-evaluation-ruleset-v1"
EVALUATOR_VERSION = "forecast-evaluator-1.0.0"
_RULESET_PATH = (
    Path(__file__).resolve().parents[1]
    / "config"
    / "forecast-evaluation-ruleset-v1.json"
)


def load_evaluation_ruleset(
    version: str = RULESET_VERSION,
) -> dict[str, Any]:
    if version != RULESET_VERSION:
        raise EvaluationContractError(f"unknown evaluation ruleset: {version}")
    try:
        payload = json.loads(_RULESET_PATH.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise EvaluationContractError(
            "evaluation ruleset configuration is unavailable"
        ) from exc
    if not isinstance(payload, dict):
        raise EvaluationContractError("evaluation ruleset must be an object")
    expected = {
        "version": RULESET_VERSION,
        "evaluator_version": EVALUATOR_VERSION,
        "timeframe": "1d",
        "touch_mode": "inclusive_wick",
        "activation_cutoff": "max_activated_at_market_data_as_of",
        "bar_availability": "next_market_local_midnight",
        "fingerprint_cutoff": "decision_milestones_only",
        "same_bar_collision": "needs_review",
        "observation_path_coverage": "required_through_candidate_session",
        "neutral_policy": "needs_review",
        "split_policy": "needs_review",
        "incomplete_corporate_action_metadata_policy": "needs_review",
        "dividend_policy": "warning_only",
        "supported_adjustment_mode": "raw",
        "currency_policy": "verified_match_required",
        "target_range_entry": {
            "bullish": "lower_edge",
            "bearish": "upper_edge",
        },
        "expiry_precedence": [
            "same_bar_collision",
            "target_hit",
            "invalidated",
            "expired",
        ],
    }
    for key, value in expected.items():
        if payload.get(key) != value:
            raise EvaluationContractError(
                f"evaluation ruleset has an unsupported {key} value"
            )
    required_results = {
        "no_change",
        "target_hit",
        "invalidated",
        "expired",
        "needs_review",
    }
    if set(payload.get("result_kinds", ())) != required_results:
        raise EvaluationContractError(
            "evaluation ruleset result kinds are incomplete"
        )
    required_reasons = {
        "no_terminal_boundary_touched",
        "horizon_not_complete",
        "target_boundary_touched",
        "invalidation_boundary_touched",
        "horizon_complete_without_terminal_touch",
        "same_bar_target_invalidation_collision",
        "insufficient_observation_path_coverage",
        "insufficient_horizon_coverage",
        "corporate_action_price_discontinuity",
        "adjustment_mode_mismatch",
        "currency_mismatch",
        "currency_unverified",
        "neutral_policy_unsupported",
    }
    if set(payload.get("reason_codes", ())) != required_reasons:
        raise EvaluationContractError(
            "evaluation ruleset reason codes are incomplete"
        )
    return deepcopy(payload)
