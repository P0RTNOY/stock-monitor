export function sanitizedForecastDiagnostic(error: unknown) {
  const type = error instanceof Error ? error.name : 'UnknownError';
  return { type };
}

export function logForecastDiagnostic(operation: string, error: unknown) {
  console.error(`forecast ${operation} failed`, sanitizedForecastDiagnostic(error));
}
