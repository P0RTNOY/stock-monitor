import { D1CoordinatorRepository } from '../coordinator/repository.ts';
import { ForecastCoordinatorService } from '../coordinator/service.ts';
import { evaluateWithPython } from '../evaluation/client.ts';
import { D1EvaluationRepository } from '../evaluation/repository.ts';
import { ForecastEvaluationService } from '../evaluation/service.ts';
import { D1ForecastRepository } from '../forecasts/repository.ts';
import { D1SchedulerRepository } from './repository.ts';
import { ForecastSchedulerService } from './service.ts';
import {
  structuredSchedulerLogger,
  workerCoordinatorRuntime,
  workerSchedulerRuntime,
} from './runtime.ts';
import type { SchedulerLogger } from './types.ts';

export function createForecastScheduler(input: {
  d1: D1Database;
  analysisApiUrl: string;
  clock?: () => Date;
  uuid?: () => string;
  logger?: SchedulerLogger;
  hasAuthority?: () => boolean;
}) {
  const forecasts = new D1ForecastRepository(input.d1);
  const evaluator = new ForecastEvaluationService(
    forecasts,
    new D1EvaluationRepository(input.d1),
    (request) => evaluateWithPython(
      request, fetch, AbortSignal.timeout(30_000), input.analysisApiUrl,
    ),
    input.clock,
  );
  const coordinator = new ForecastCoordinatorService(
    new D1CoordinatorRepository(input.d1),
    forecasts,
    evaluator,
    workerCoordinatorRuntime(input.clock, input.uuid),
  );
  return new ForecastSchedulerService(
    new D1SchedulerRepository(input.d1),
    coordinator,
    workerSchedulerRuntime(input.clock, input.uuid),
    input.logger ?? structuredSchedulerLogger,
    input.hasAuthority,
  );
}
