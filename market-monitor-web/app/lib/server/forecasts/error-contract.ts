import { ForecastServiceError } from './service.ts';
import { ForecastValidationError } from './validation.ts';

export function forecastErrorContract(error: unknown) {
  if (error instanceof ForecastServiceError) {
    return {
      status: error.status,
      body: {
        error: error.message,
        code: error.code,
        ...(Object.keys(error.fieldErrors).length ? { fieldErrors: error.fieldErrors } : {}),
      },
      report: false,
    };
  }
  if (error instanceof ForecastValidationError) {
    return {
      status: 400,
      body: {
        error: error.message,
        code: 'validation_error',
        ...(Object.keys(error.fieldErrors).length ? { fieldErrors: error.fieldErrors } : {}),
      },
      report: false,
    };
  }
  return {
    status: 500,
    body: { error: 'The forecast request could not be completed.', code: 'internal_error' },
    report: true,
  };
}
