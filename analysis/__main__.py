from __future__ import annotations

import argparse
import json
from datetime import datetime, timezone

from analysis.contracts import ContractError
from analysis.providers import ProviderError
from analysis.service import analyze_symbol


def _aware_timestamp(value: str) -> datetime:
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError as exc:
        raise argparse.ArgumentTypeError("use an ISO-8601 timestamp") from exc
    if parsed.tzinfo is None or parsed.utcoffset() is None:
        raise argparse.ArgumentTypeError("timestamp must include a UTC offset")
    return parsed


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Generate an explainable structure-and-level report; no trade recommendation is produced."
    )
    parser.add_argument("symbol", help="US-listed stock or ETF symbol")
    parser.add_argument(
        "--as-of",
        type=_aware_timestamp,
        default=datetime.now(timezone.utc),
        help="aware ISO-8601 cutoff; defaults to the current UTC time",
    )
    parser.add_argument(
        "--account-risk",
        type=float,
        default=None,
        help="optional hypothetical monetary risk budget",
    )
    parser.add_argument(
        "--commission-per-unit",
        type=float,
        default=None,
        help="explicit hypothetical commission cost per unit (zero is allowed)",
    )
    parser.add_argument(
        "--slippage-per-unit",
        type=float,
        default=None,
        help="explicit hypothetical expected slippage per unit (zero is allowed)",
    )
    parser.add_argument(
        "--execution-stop",
        type=float,
        default=None,
        help="optional execution-stop price assumption",
    )
    args = parser.parse_args()
    try:
        report = analyze_symbol(
            args.symbol,
            args.as_of,
            account_risk=args.account_risk,
            commission_per_unit=args.commission_per_unit,
            expected_slippage_per_unit=args.slippage_per_unit,
            execution_stop_price=args.execution_stop,
        )
    except (ContractError, ProviderError) as exc:
        parser.exit(2, f"Analysis unavailable: {exc}\n")
    print(
        json.dumps(
            report.to_dict(),
            ensure_ascii=False,
            indent=2,
            sort_keys=True,
            allow_nan=False,
        )
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
