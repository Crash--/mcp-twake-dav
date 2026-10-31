/**
 * Timezone registration utilities for iCalendar parsing
 *
 * CRITICAL: VTIMEZONE components MUST be registered with ical.js BEFORE parsing events
 * to prevent DST-related time conversion errors (see 02-RESEARCH.md Pitfall 3).
 */

import ICAL from 'ical.js';
import type { Logger } from 'pino';

/**
 * Register all VTIMEZONE components from an iCalendar component
 *
 * Extracts VTIMEZONE subcomponents and registers them with ICAL.TimezoneService
 * so that event date/time parsing uses correct timezone data.
 *
 * @param comp - Parsed iCalendar component (from ICAL.Component)
 * @param logger - Pino logger for debug output
 */
export function registerTimezones(comp: ICAL.Component, logger: Logger): void {
  const vtimezones = comp.getAllSubcomponents('vtimezone');

  if (vtimezones.length === 0) {
    logger.debug('No VTIMEZONE components found in iCalendar data');
    return;
  }

  for (const vtz of vtimezones) {
    try {
      const timezone = new ICAL.Timezone(vtz);
      ICAL.TimezoneService.register(timezone);
    } catch (err) {
      // Log but don't throw - timezone registration failure shouldn't block event parsing
      logger.warn({ err, tzid: vtz.getFirstPropertyValue('tzid') }, 'Failed to register timezone');
    }
  }

  logger.debug({ count: vtimezones.length }, 'Registered VTIMEZONE components');
}

const DAY_MS = 86_400_000;

/** The wall clock of `timeZone` at `instant`, as if it were UTC. */
export function wallClockMs(instant: number, timeZone?: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: 'numeric',
    minute: 'numeric',
    second: 'numeric',
  }).formatToParts(instant);
  const part = (type: string) => Number(parts.find((p) => p.type === type)!.value);
  return Date.UTC(part('year'), part('month') - 1, part('day'), part('hour'), part('minute'), part('second'));
}

/** The instant at which `timeZone` shows this wall clock. */
export function wallClockToInstant(wallClock: number, timeZone?: string): number {
  const offset = (instant: number) => wallClockMs(instant, timeZone) - Math.floor(instant / 1000) * 1000;
  return wallClock - offset(wallClock - offset(wallClock));
}

/**
 * The instant of an iCalendar time. A date or a time without a zone has no instant
 * of its own: it is read in the time zone of the user, not of the process.
 */
export function icalTimeToDate(time: ICAL.Time, timeZone?: string): Date {
  if (!time.isDate && time.zone?.tzid !== 'floating') return time.toJSDate();
  const wallClock = Date.UTC(time.year, time.month - 1, time.day, time.hour, time.minute, time.second);
  return new Date(wallClockToInstant(wallClock, timeZone));
}

/** The end of an all-day occurrence: whole days later on the wall clock, which may not be 24 hours each. */
export function addWallClockDays(start: Date, days: number, timeZone?: string): Date {
  return new Date(wallClockToInstant(wallClockMs(start.getTime(), timeZone) + days * DAY_MS, timeZone));
}
