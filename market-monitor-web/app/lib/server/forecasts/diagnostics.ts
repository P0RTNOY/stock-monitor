export function sanitizedForecastDiagnostic(error: unknown) {
  const type = error instanceof Error ? error.name : 'UnknownError';
  const rawMessage = error instanceof Error && error.message ? error.message : 'Unknown failure';
  const message = rawMessage
    .replace(/https?:\/\/\S+/gi, '[url]')
    .replace(/\bBearer\s+\S+/gi, 'Bearer [redacted]')
    .replace(/\bsk-[A-Za-z0-9_-]+/g, '[redacted-key]')
    .replace(/\b(api[_-]?key|token|secret|password)\s*[=:]\s*[^\s,;]+/gi, '$1=[redacted]')
    .slice(0, 160);
  return { type, message };
}

export function logForecastDiagnostic(operation: string, error: unknown) {
  console.error(`forecast ${operation} failed`, sanitizedForecastDiagnostic(error));
}
