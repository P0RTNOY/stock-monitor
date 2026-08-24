import type { TechnicalAnalysisReport } from './types';

const REPORT_STATUSES = new Set(['no_setup', 'scenario_detected', 'insufficient_data']);

export function isTechnicalAnalysisReport(
  value: unknown,
  expectedSymbol: string,
): value is TechnicalAnalysisReport {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const report = value as Record<string, unknown>;
  return report.symbol === expectedSymbol
    && typeof report.status === 'string'
    && REPORT_STATUSES.has(report.status)
    && typeof report.summary === 'string'
    && typeof report.generated_at === 'string'
    && Number.isFinite(Date.parse(report.generated_at))
    && Boolean(report.timeframes)
    && typeof report.timeframes === 'object'
    && !Array.isArray(report.timeframes)
    && Array.isArray(report.scenarios)
    && Array.isArray(report.evidence)
    && Array.isArray(report.warnings);
}
