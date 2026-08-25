import assert from 'node:assert/strict';
import test from 'node:test';
import { COORDINATOR_VERSION } from './server/coordinator/contract.ts';
import {
  SCHEDULER_HARD_MAX_ITEMS,
  SCHEDULER_HARD_MAX_PAGES,
  SCHEDULER_HARD_MAX_RUNTIME_MS,
  SCHEDULER_MAX_PAGE_SIZE,
  SCHEDULER_VERSION,
  SchedulerConfigurationError,
  parseSchedulerConfig,
  scheduleOccurrenceKey,
  schedulePageRunKey,
  scheduledTimeFromEpoch,
  schedulerConfigFingerprint,
  validateSchedulerProviderUrl,
} from './server/scheduler/contract.ts';

const instant = '2026-08-25T06:30:00.000Z';

test('scheduler defaults to disabled with conservative bounded values', () => {
  const config = parseSchedulerConfig({});
  assert.equal(config.enabled, false);
  assert.equal(config.environment, 'local');
  assert.equal(config.schedulerVersion, SCHEDULER_VERSION);
  assert.equal(config.coordinatorVersion, COORDINATOR_VERSION);
  assert.ok(config.pageSize <= SCHEDULER_MAX_PAGE_SIZE);
  assert.ok(config.maxPages <= SCHEDULER_HARD_MAX_PAGES);
  assert.ok(config.maxItems <= SCHEDULER_HARD_MAX_ITEMS);
  assert.ok(config.maxRuntimeMs <= SCHEDULER_HARD_MAX_RUNTIME_MS);
  assert.ok(config.minRemainingMs < config.maxRuntimeMs);
});

test('scheduler configuration rejects malformed, unknown, excessive, and contradictory values', () => {
  for (const raw of [
    { enabled: 'TRUE' }, { enabled: 1 }, { environment: 'dev' },
    { pageSize: 0 }, { pageSize: -1 }, { pageSize: 1.5 }, { pageSize: ' 2' },
    { pageSize: SCHEDULER_MAX_PAGE_SIZE + 1 }, { maxPages: SCHEDULER_HARD_MAX_PAGES + 1 },
    { maxItems: SCHEDULER_HARD_MAX_ITEMS + 1 },
    { maxRuntimeMs: SCHEDULER_HARD_MAX_RUNTIME_MS + 1 },
    { maxRuntimeMs: 1_000, minRemainingMs: 1_000 },
    { schedulerVersion: 'future' }, { coordinatorVersion: 'future' },
    { maxItem: 3 },
  ]) assert.throws(() => parseSchedulerConfig(raw as never), SchedulerConfigurationError);
});

test('occurrence identity is deterministic, versioned, and bound to trusted dimensions', async () => {
  const first = await scheduleOccurrenceKey(1, 'production', '30 6 * * *', instant);
  assert.equal(first, await scheduleOccurrenceKey(1, 'production', '30 6 * * *', instant));
  assert.match(first, /^fsched1:[a-f0-9]{64}$/u);
  assert.notEqual(first, await scheduleOccurrenceKey(1, 'production', '30 6 * * *', '2026-08-26T06:30:00.000Z'));
  assert.notEqual(first, await scheduleOccurrenceKey(1, 'staging', '30 6 * * *', instant));
  assert.notEqual(first, await scheduleOccurrenceKey(2, 'production', '30 6 * * *', instant));
  assert.notEqual(first, await scheduleOccurrenceKey(1, 'production', '0 7 * * *', instant));
});

test('occurrence identity and cutoff are timezone independent', async () => {
  const epoch = Date.UTC(2026, 7, 25, 6, 30, 0, 0);
  assert.equal(scheduledTimeFromEpoch(epoch), instant);
  const before = process.env.TZ;
  process.env.TZ = 'Pacific/Honolulu';
  const west = await scheduleOccurrenceKey(1, 'local', '30 6 * * *', scheduledTimeFromEpoch(epoch));
  process.env.TZ = 'Asia/Jerusalem';
  const east = await scheduleOccurrenceKey(1, 'local', '30 6 * * *', scheduledTimeFromEpoch(epoch));
  if (before === undefined) delete process.env.TZ; else process.env.TZ = before;
  assert.equal(west, east);
});

test('scheduled event time rejects invalid epoch and JavaScript TimeClip edges', () => {
  for (const value of [-1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER, 8_640_000_000_000_001]) {
    assert.throws(() => scheduledTimeFromEpoch(value), SchedulerConfigurationError);
  }
});

test('page keys preserve occurrence identity and enforce page bounds', async () => {
  const occurrence = await scheduleOccurrenceKey(1, 'local', '30 6 * * *', instant);
  assert.equal(schedulePageRunKey(occurrence, 1), `${occurrence}:page:1`);
  assert.throws(() => schedulePageRunKey(occurrence, 0), SchedulerConfigurationError);
  assert.throws(() => schedulePageRunKey(occurrence, SCHEDULER_HARD_MAX_PAGES + 1), SchedulerConfigurationError);
});

test('config fingerprint is stable but changes with operational bounds and environment', async () => {
  const config = parseSchedulerConfig({ enabled: true });
  assert.equal(await schedulerConfigFingerprint(config), await schedulerConfigFingerprint(config));
  assert.notEqual(
    await schedulerConfigFingerprint(config),
    await schedulerConfigFingerprint(parseSchedulerConfig({ enabled: true, maxItems: config.maxItems + 1 })),
  );
  assert.notEqual(
    await schedulerConfigFingerprint(config),
    await schedulerConfigFingerprint(parseSchedulerConfig({ enabled: true, environment: 'preview' })),
  );
});

test('enabled provider URL validation permits explicit local HTTP and requires safe HTTPS remotely', () => {
  assert.equal(validateSchedulerProviderUrl('http://127.0.0.1:8502', 'local'), 'http://127.0.0.1:8502');
  assert.equal(validateSchedulerProviderUrl('https://analysis.example.test/', 'production'), 'https://analysis.example.test');
  for (const value of [undefined, '', 'http://analysis.example.test', 'https://user:pass@example.test',
    'https://example.test/?token=secret', 'https://127.0.0.1']) {
    assert.throws(() => validateSchedulerProviderUrl(value, 'production'), SchedulerConfigurationError);
  }
});
