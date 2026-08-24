"""Deterministic technical-analysis foundations.

The package intentionally contains no order execution or recommendation logic.
It turns normalized market data into explainable structure and level evidence.
"""

from analysis.contracts import AnalysisReport, AnalysisRequest, Bar
from analysis.engine import AnalysisEngine
from analysis.rulesets import Ruleset, load_ruleset
from analysis.service import analyze_symbol

__all__ = [
    "AnalysisEngine",
    "AnalysisReport",
    "AnalysisRequest",
    "Bar",
    "Ruleset",
    "analyze_symbol",
    "load_ruleset",
]
