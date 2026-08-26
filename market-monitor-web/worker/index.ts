import app from 'vinext/server/fetch-handler';
import { ensureDatabase } from '../db/index.ts';
import { trustedSchedulerScope } from '../app/lib/server/auth/system.ts';
import { AuthorizedSchedulerService } from '../app/lib/server/auth/system-services.ts';
import { profileIdFromScope } from '../app/lib/server/auth/enforcement.ts';
import {
  SCHEDULER_VERSION,
  SchedulerConfigurationError,
  parseSchedulerConfig,
  scheduledTimeFromEpoch,
  validateSchedulerProviderUrl,
} from '../app/lib/server/scheduler/contract.ts';
import { createForecastScheduler } from '../app/lib/server/scheduler/factory.ts';
import { structuredSchedulerLogger } from '../app/lib/server/scheduler/runtime.ts';
import { disabledScheduledInvocation } from '../app/lib/server/scheduler/service.ts';
import type { ScheduledInvocationReport } from '../app/lib/server/scheduler/types.ts';

export type NorthstarWorkerEnv = Cloudflare.Env & {
  NORTHSTAR_ENVIRONMENT?: string;
  NORTHSTAR_AUTH_MODE?: string;
  NORTHSTAR_SYSTEM_PROFILE_ID?: string;
  FORECAST_SCHEDULER_ENABLED?: string;
  FORECAST_SCHEDULER_ENVIRONMENT?: string;
  FORECAST_SCHEDULER_PAGE_SIZE?: string;
  FORECAST_SCHEDULER_MAX_PAGES?: string;
  FORECAST_SCHEDULER_MAX_ITEMS?: string;
  FORECAST_SCHEDULER_MAX_RUNTIME_MS?: string;
  FORECAST_SCHEDULER_MIN_REMAINING_MS?: string;
  FORECAST_SCHEDULER_VERSION?: string;
  FORECAST_COORDINATOR_VERSION?: string;
  ANALYSIS_API_URL?: string;
};

export type ScheduledConfigurationFailure = {
  schedulerVersion: typeof SCHEDULER_VERSION;
  state: 'configuration_error' | 'unexpected_error';
  errorCategory: 'invalid_configuration' | 'unexpected_scheduler_error';
  errorType: string;
};

function safeErrorType(error: unknown) {
  return error instanceof Error && /^[A-Za-z][A-Za-z0-9]{0,79}$/u.test(error.name)
    ? error.name : 'UnknownError';
}

export async function runScheduledEvent(
  controller: Pick<ScheduledController, 'scheduledTime' | 'cron'>,
  env: NorthstarWorkerEnv,
): Promise<ScheduledInvocationReport | ScheduledConfigurationFailure> {
  try {
    const scheduledTime = scheduledTimeFromEpoch(controller.scheduledTime);
    const config = parseSchedulerConfig({
      enabled: env.FORECAST_SCHEDULER_ENABLED,
      environment: env.FORECAST_SCHEDULER_ENVIRONMENT,
      pageSize: env.FORECAST_SCHEDULER_PAGE_SIZE,
      maxPages: env.FORECAST_SCHEDULER_MAX_PAGES,
      maxItems: env.FORECAST_SCHEDULER_MAX_ITEMS,
      maxRuntimeMs: env.FORECAST_SCHEDULER_MAX_RUNTIME_MS,
      minRemainingMs: env.FORECAST_SCHEDULER_MIN_REMAINING_MS,
      schedulerVersion: env.FORECAST_SCHEDULER_VERSION,
      coordinatorVersion: env.FORECAST_COORDINATOR_VERSION,
    });
    const scope = trustedSchedulerScope(env, config.schedulerVersion);
    const profileId = profileIdFromScope(scope, 'scheduler_coordinate');
    if (!config.enabled) {
      return disabledScheduledInvocation(
        { config, profileId, scheduledTime, scheduleExpression: controller.cron },
        structuredSchedulerLogger,
      );
    }
    const analysisApiUrl = validateSchedulerProviderUrl(env.ANALYSIS_API_URL, config.environment);
    if (!env.DB) throw new SchedulerConfigurationError('DB', 'Enabled scheduler D1 binding is required.');
    await ensureDatabase();
    return new AuthorizedSchedulerService(
      scope,
      createForecastScheduler({ d1: env.DB, analysisApiUrl }),
    ).run({
      config, scheduledTime, scheduleExpression: controller.cron,
    });
  } catch (error) {
    const configuration = error instanceof SchedulerConfigurationError;
    const result: ScheduledConfigurationFailure = {
      schedulerVersion: SCHEDULER_VERSION,
      state: configuration ? 'configuration_error' : 'unexpected_error',
      errorCategory: configuration ? 'invalid_configuration' : 'unexpected_scheduler_error',
      errorType: safeErrorType(error),
    };
    structuredSchedulerLogger.log({
      event: configuration ? 'forecast_schedule_configuration_invalid' : 'forecast_schedule_failed',
      schedulerVersion: SCHEDULER_VERSION,
      state: result.state,
      errorCategory: result.errorCategory,
      errorType: result.errorType,
    });
    return result;
  }
}

export default {
  fetch(request, env, ctx) {
    return app.fetch(request, env, ctx);
  },
  async scheduled(controller, env) {
    await runScheduledEvent(controller, env);
  },
} satisfies ExportedHandler<NorthstarWorkerEnv>;
