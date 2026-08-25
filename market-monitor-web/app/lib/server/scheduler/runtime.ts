import type { CoordinatorRuntime } from '../coordinator/service.ts';
import { SCHEDULER_INVOCATION_LEASE_MS } from './contract.ts';
import type { SchedulerLogger, SchedulerRuntime } from './types.ts';

const COORDINATOR_LEASE_MS = 5 * 60_000;

export function workerCoordinatorRuntime(
  clock: () => Date = () => new Date(),
  uuid: () => string = () => globalThis.crypto.randomUUID(),
): CoordinatorRuntime {
  return {
    now: () => clock().toISOString(),
    leaseExpiresAt: (acquiredAt) => new Date(Date.parse(acquiredAt) + COORDINATOR_LEASE_MS).toISOString(),
    durationMs: (startedAt, finishedAt) => Math.max(0, Date.parse(finishedAt) - Date.parse(startedAt)),
    id: (kind) => `${kind}_${uuid()}`,
  };
}

export function workerSchedulerRuntime(
  clock: () => Date = () => new Date(),
  uuid: () => string = () => globalThis.crypto.randomUUID(),
): SchedulerRuntime {
  return {
    now: () => clock().toISOString(),
    elapsedMs: (startedAt) => Math.max(0, clock().getTime() - Date.parse(startedAt)),
    durationMs: (startedAt, finishedAt) => Math.max(0, Date.parse(finishedAt) - Date.parse(startedAt)),
    leaseExpiresAt: (acquiredAt) => new Date(
      Date.parse(acquiredAt) + SCHEDULER_INVOCATION_LEASE_MS,
    ).toISOString(),
    id: (kind) => `${kind}_${uuid()}`,
  };
}

export const structuredSchedulerLogger: SchedulerLogger = {
  log(entry) {
    console.log(JSON.stringify(entry));
  },
};
