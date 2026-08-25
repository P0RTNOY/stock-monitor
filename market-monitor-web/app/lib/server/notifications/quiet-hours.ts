import { Temporal } from '@js-temporal/polyfill';
import { NOTIFICATION_QUIET_HOURS_POLICY_VERSION } from './contract.ts';
import {
  isCanonicalNotificationInstant,
  isNotificationLocalTime,
  isValidIanaTimeZone,
  type NotificationQuietHoursPreference,
} from './preference.ts';

export type QuietHoursWarning =
  | 'ambiguous_start_used_earlier'
  | 'ambiguous_end_used_later'
  | 'nonexistent_start_shifted_forward'
  | 'nonexistent_end_shifted_forward';

export type QuietHoursInvalidReason =
  | 'unsupported_policy_version'
  | 'invalid_current_instant'
  | 'invalid_timezone'
  | 'invalid_configuration'
  | 'unresolvable_local_time';

export type QuietHoursResult = {
  policyVersion: typeof NOTIFICATION_QUIET_HOURS_POLICY_VERSION;
  valid: true;
  deliveryAllowed: true;
  inQuietHours: false;
  reason: 'not_configured' | 'outside_quiet_hours';
  earliestAllowedAt: string;
  warnings: QuietHoursWarning[];
} | {
  policyVersion: typeof NOTIFICATION_QUIET_HOURS_POLICY_VERSION;
  valid: true;
  deliveryAllowed: false;
  inQuietHours: true;
  reason: 'inside_quiet_hours';
  earliestAllowedAt: string;
  warnings: QuietHoursWarning[];
} | {
  policyVersion: typeof NOTIFICATION_QUIET_HOURS_POLICY_VERSION;
  valid: false;
  deliveryAllowed: false;
  inQuietHours: false;
  reason: QuietHoursInvalidReason;
  earliestAllowedAt: null;
  warnings: QuietHoursWarning[];
};

export type QuietHoursInput = {
  currentInstant: string;
  timeZone: string;
  quietHours: NotificationQuietHoursPreference | null;
  policyVersion: string;
};

type BoundaryRole = 'start' | 'end';

type ResolvedBoundary = {
  instant: Temporal.Instant;
  warning: QuietHoursWarning | null;
};

function canonicalInstant(instant: Temporal.Instant) {
  return instant.toString({ smallestUnit: 'millisecond' });
}

function invalid(reason: QuietHoursInvalidReason): QuietHoursResult {
  return {
    policyVersion: NOTIFICATION_QUIET_HOURS_POLICY_VERSION,
    valid: false,
    deliveryAllowed: false,
    inQuietHours: false,
    reason,
    earliestAllowedAt: null,
    warnings: [],
  };
}

function validConfiguration(value: unknown): value is NotificationQuietHoursPreference {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  const keys = Object.keys(row).sort();
  return keys.length === 2 && keys[0] === 'end' && keys[1] === 'start'
    && isNotificationLocalTime(row.start) && isNotificationLocalTime(row.end)
    && row.start !== row.end;
}

function localTime(value: string) {
  const [hour, minute] = value.split(':').map(Number);
  return new Temporal.PlainTime(hour, minute);
}

function zonedDateTime(
  dateTime: Temporal.PlainDateTime,
  timeZone: string,
  disambiguation: 'earlier' | 'later',
) {
  return Temporal.ZonedDateTime.from({
    timeZone,
    year: dateTime.year,
    month: dateTime.month,
    day: dateTime.day,
    hour: dateTime.hour,
    minute: dateTime.minute,
    second: 0,
    millisecond: 0,
    microsecond: 0,
    nanosecond: 0,
  }, { disambiguation });
}

function resolveBoundary(
  date: Temporal.PlainDate,
  time: string,
  timeZone: string,
  role: BoundaryRole,
): ResolvedBoundary {
  const requested = date.toPlainDateTime(localTime(time));
  const earlier = zonedDateTime(requested, timeZone, 'earlier');
  const later = zonedDateTime(requested, timeZone, 'later');
  if (Temporal.Instant.compare(earlier.toInstant(), later.toInstant()) === 0) {
    return { instant: earlier.toInstant(), warning: null };
  }

  const earlierMatches = earlier.toPlainDateTime().equals(requested);
  const laterMatches = later.toPlainDateTime().equals(requested);
  if (earlierMatches && laterMatches) {
    return role === 'start'
      ? { instant: earlier.toInstant(), warning: 'ambiguous_start_used_earlier' }
      : { instant: later.toInstant(), warning: 'ambiguous_end_used_later' };
  }
  if (!earlierMatches && !laterMatches) {
    return {
      instant: later.toInstant(),
      warning: role === 'start'
        ? 'nonexistent_start_shifted_forward'
        : 'nonexistent_end_shifted_forward',
    };
  }
  throw new RangeError('Temporal returned an inconsistent local-time disambiguation.');
}

function intervalFor(
  anchor: Temporal.PlainDate,
  configuration: NotificationQuietHoursPreference,
  timeZone: string,
) {
  const overnight = configuration.start > configuration.end;
  const endDate = overnight ? anchor.add({ days: 1 }) : anchor;
  const start = resolveBoundary(anchor, configuration.start, timeZone, 'start');
  const end = resolveBoundary(endDate, configuration.end, timeZone, 'end');
  if (Temporal.Instant.compare(end.instant, start.instant) <= 0) {
    throw new RangeError('Quiet-hours interval does not advance in time.');
  }
  return { start, end };
}

/**
 * Evaluates quiet hours against explicit instants. Local boundaries are
 * start-inclusive and end-exclusive. Ambiguous starts use the earlier
 * occurrence, ambiguous ends the later occurrence, and gaps shift forward.
 */
export function evaluateQuietHours(input: QuietHoursInput): QuietHoursResult {
  if (input.policyVersion !== NOTIFICATION_QUIET_HOURS_POLICY_VERSION) {
    return invalid('unsupported_policy_version');
  }
  if (!isCanonicalNotificationInstant(input.currentInstant)) return invalid('invalid_current_instant');
  if (!isValidIanaTimeZone(input.timeZone)) return invalid('invalid_timezone');
  if (input.quietHours === null) {
    return {
      policyVersion: NOTIFICATION_QUIET_HOURS_POLICY_VERSION,
      valid: true,
      deliveryAllowed: true,
      inQuietHours: false,
      reason: 'not_configured',
      earliestAllowedAt: input.currentInstant,
      warnings: [],
    };
  }
  if (!validConfiguration(input.quietHours)) {
    return invalid('invalid_configuration');
  }

  try {
    const now = Temporal.Instant.from(input.currentInstant);
    const localDate = now.toZonedDateTimeISO(input.timeZone).toPlainDate();
    const intervals = [
      intervalFor(localDate.subtract({ days: 1 }), input.quietHours, input.timeZone),
      intervalFor(localDate, input.quietHours, input.timeZone),
    ];
    const containing = intervals.filter((interval) => (
      Temporal.Instant.compare(interval.start.instant, now) <= 0
      && Temporal.Instant.compare(now, interval.end.instant) < 0
    ));
    if (containing.length === 0) {
      return {
        policyVersion: NOTIFICATION_QUIET_HOURS_POLICY_VERSION,
        valid: true,
        deliveryAllowed: true,
        inQuietHours: false,
        reason: 'outside_quiet_hours',
        earliestAllowedAt: input.currentInstant,
        warnings: [],
      };
    }

    const latestEnd = containing.reduce((latest, interval) => (
      Temporal.Instant.compare(interval.end.instant, latest.end.instant) > 0 ? interval : latest
    ));
    const warnings = [...new Set(containing.flatMap((interval) => (
      [interval.start.warning, interval.end.warning].filter((warning): warning is QuietHoursWarning => warning !== null)
    )))];
    return {
      policyVersion: NOTIFICATION_QUIET_HOURS_POLICY_VERSION,
      valid: true,
      deliveryAllowed: false,
      inQuietHours: true,
      reason: 'inside_quiet_hours',
      earliestAllowedAt: canonicalInstant(latestEnd.end.instant),
      warnings,
    };
  } catch {
    return invalid('unresolvable_local_time');
  }
}
