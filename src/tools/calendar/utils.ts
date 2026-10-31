/**
 * Shared calendar query utilities
 *
 * Purpose: Provides date parsing, event formatting, filtering, and recurrence expansion
 * utilities used by all Phase 4 calendar MCP tools.
 *
 * Key capabilities:
 * - Natural language date parsing (chrono-node)
 * - Event formatting for LLM-optimized output
 * - Keyword and attendee search filtering
 * - Recurrence expansion integration with Phase 2 transformers
 */

import ICAL from 'ical.js';
import { z } from 'zod';
import type { Logger } from 'pino';
import type { DAVCalendarObject } from 'tsdav';
import type { CalendarService, TimeRange } from '../../caldav/calendar-service.js';
import type { EventDTO, FreeBusyPeriod } from '../../types/dtos.js';
import { addReadWarning } from '../../caldav/dav-fetch.js';
import { transformCalendarObject } from '../../transformers/event.js';
import { expandRecurringEvent } from '../../transformers/recurrence.js';

const DAY_MS = 86_400_000;

/** The wall clock of `timeZone` at `instant`, as if it were UTC. */
function wallClockMs(instant: number, timeZone?: string): number {
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
function wallClockToInstant(wallClock: number, timeZone?: string): number {
  const offset = (instant: number) => wallClockMs(instant, timeZone) - Math.floor(instant / 1000) * 1000;
  return wallClock - offset(wallClock - offset(wallClock));
}

const ISO_INPUT = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?)?$/;

/**
 * Read an ISO 8601 date. Without an offset it is a wall clock of `timeZone`. A
 * date alone means the start of that day, or the end of it when `asEnd` is set.
 *
 * @returns Milliseconds since the epoch, or null if the value is not a valid date
 */
function parseIsoInput(value: string, timeZone: string | undefined, asEnd: boolean): number | null {
  const match = ISO_INPUT.exec(value);
  if (!match) return null;
  const [, year, month, day, hour, minute, second, offset] = match;
  const wallClock = Date.UTC(+year, +month - 1, +day, +(hour ?? 0), +(minute ?? 0), +(second ?? 0));
  // Date.UTC rolls February 31 over to March.
  if (new Date(wallClock).getUTCDate() !== +day) return null;
  if (offset) {
    const instant = Date.parse(value);
    return Number.isNaN(instant) ? null : instant;
  }
  return wallClockToInstant(hour === undefined && asEnd ? wallClock + DAY_MS : wallClock, timeZone);
}

/** Today in `timeZone`, from its first instant to the first instant of tomorrow. */
export function todayRange(timeZone?: string): TimeRange {
  const midnight = Math.floor(wallClockMs(Date.now(), timeZone) / DAY_MS) * DAY_MS;
  return {
    start: new Date(wallClockToInstant(midnight, timeZone)).toISOString(),
    end: new Date(wallClockToInstant(midnight + DAY_MS, timeZone)).toISOString(),
  };
}

export const ISO_DATE_HELP =
  'ISO 8601: 2026-11-03, 2026-11-03T14:00, or with an offset such as 2026-11-03T14:00:00Z. Without an offset, the user time zone applies.';

/**
 * Turn the `start` and `end` of a tool call into a time range. A missing end is
 * `start` plus the default window, a missing start is now.
 *
 * @returns The range, or the problem to report to the model
 */
export function parseDateRange(
  start: string | undefined,
  end: string | undefined,
  defaultDays: number,
  timeZone?: string,
): TimeRange | { problem: string } {
  const startMs = start === undefined ? Date.now() : parseIsoInput(start, timeZone, false);
  if (startMs === null) return { problem: `Could not read the start date "${start}". Use ${ISO_DATE_HELP}` };
  const endMs = end === undefined ? startMs + defaultDays * DAY_MS : parseIsoInput(end, timeZone, true);
  if (endMs === null) return { problem: `Could not read the end date "${end}". Use ${ISO_DATE_HELP}` };
  return { start: new Date(startMs).toISOString(), end: new Date(endMs).toISOString() };
}

/**
 * Format event time as human-readable string
 *
 * Example: "Mon Jan 30, 2:00 PM - 3:00 PM (Europe/Paris)"
 *
 * @param event - EventDTO with startDate, endDate, timezone
 * @param userTimezone - Optional user timezone for display (e.g., "Europe/Paris")
 * @returns Formatted time string
 */
export function formatEventTime(event: EventDTO, userTimezone?: string): string {
  // Use user timezone if provided, otherwise use system default
  const displayTimezone = userTimezone || Intl.DateTimeFormat().resolvedOptions().timeZone;

  const options: Intl.DateTimeFormatOptions = {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    timeZone: displayTimezone,
  };

  const startStr = event.startDate.toLocaleString('en-US', options);
  const endTime = event.endDate.toLocaleString('en-US', {
    hour: 'numeric',
    minute: '2-digit',
    timeZone: displayTimezone,
  });

  // Show the display timezone in parentheses
  const timezoneStr = ` (${displayTimezone})`;

  return `${startStr} - ${endTime}${timezoneStr}`;
}

// limit counts events: without this, 100 events of 200 attendees are 925 000 characters.
const MAX_ATTENDEES_SHOWN = 10;

function omittedAttendees(total: number): string {
  return total > MAX_ATTENDEES_SHOWN ? `, and ${total - MAX_ATTENDEES_SHOWN} more not shown (${total} in total)` : '';
}

/**
 * Format event as concise multi-line text for LLM consumption
 *
 * Example:
 * Team Standup
 *   Mon Jan 30, 9:00 AM - 9:30 AM (Europe/Paris)
 *   at Conference Room A
 *   Attendees: Pierre Dupont, Marie Martin
 *
 * @param event - EventDTO to format
 * @param userTimezone - Optional user timezone for display (e.g., "Europe/Paris")
 * @returns Multi-line formatted event string
 */
export function formatEvent(event: EventDTO, userTimezone?: string): string {
  const lines: string[] = [];

  // Line 1: Summary (with status indicator if cancelled)
  if (event.status === 'CANCELLED') {
    lines.push(`${event.summary} [CANCELLED]`);
  } else if (event.status === 'TENTATIVE') {
    lines.push(`${event.summary} [TENTATIVE]`);
  } else {
    lines.push(event.summary);
  }

  // Line 2: UID (needed for update_event/delete_event)
  lines.push(`  UID: ${event.uid}`);

  // Line 3: Status (if not confirmed/undefined)
  if (event.status && event.status !== 'CONFIRMED') {
    lines.push(`  Status: ${event.status}`);
  }

  // Line 3: Time (indented)
  lines.push(`  ${formatEventTime(event, userTimezone)}`);

  // Line 4: Location (if present, indented)
  if (event.location) {
    lines.push(`  at ${event.location}`);
  }

  // Line 5: Attendees with participation status (if present, indented)
  if (event.attendeeDetails && event.attendeeDetails.length > 0) {
    const attendeesList = event.attendeeDetails
      .slice(0, MAX_ATTENDEES_SHOWN)
      .map((a) => {
        // Format partstat for display (e.g., NEEDS-ACTION -> needs-action)
        const status = a.partstat.toLowerCase().replace(/-/g, '-');
        // Include email for easy contact (format: Name <email> (status))
        return `${a.name} <${a.email}> (${status})`;
      })
      .join(', ');
    lines.push(`  Attendees: ${attendeesList}${omittedAttendees(event.attendeeDetails.length)}`);
  } else if (event.attendees.length > 0) {
    // Fallback to simple attendee list if no details available
    lines.push(`  Attendees: ${event.attendees.slice(0, MAX_ATTENDEES_SHOWN).join(', ')}${omittedAttendees(event.attendees.length)}`);
  }

  return lines.join('\n');
}

/**
 * Search events by keyword (case-insensitive)
 *
 * Matches against summary and description fields.
 *
 * @param events - Array of EventDTOs to search
 * @param keyword - Search keyword
 * @returns Filtered array of matching events
 */
export function searchEventsByKeyword(events: EventDTO[], keyword: string): EventDTO[] {
  const lowerKeyword = keyword.toLowerCase();

  return events.filter((event) => {
    const summaryMatch = event.summary.toLowerCase().includes(lowerKeyword);
    const descriptionMatch = event.description?.toLowerCase().includes(lowerKeyword) ?? false;
    return summaryMatch || descriptionMatch;
  });
}

/**
 * Search events by attendee name (case-insensitive partial match)
 *
 * @param events - Array of EventDTOs to search
 * @param name - Attendee name to search for
 * @returns Filtered array of events with matching attendee
 */
export function searchEventsByAttendee(events: EventDTO[], name: string): EventDTO[] {
  const lowerName = name.toLowerCase();

  return events.filter((event) => {
    return event.attendees.some((attendee) =>
      attendee.toLowerCase().includes(lowerName)
    );
  });
}

/**
 * Get events with recurrence expansion
 *
 * Transforms raw DAVCalendarObject array into EventDTOs, expanding recurring events
 * into individual occurrences within the specified time range.
 *
 * Process:
 * 1. Transform each DAVCalendarObject to EventDTO using Phase 2 transformer
 * 2. For recurring events: parse _raw iCalendar and expand with Phase 2 recurrence expander
 * 3. For non-recurring events: filter by time range
 * 4. Sort by startDate, then UID and URL so that pages stay stable
 *
 * @param rawEvents - Array of DAVCalendarObject from CalendarService
 * @param timeRange - ISO 8601 time range for filtering/expansion
 * @param logger - Pino logger for error/debug output
 * @param maxPerSeries - Occurrences to keep per recurring event. A page needs at most skip + limit + 1.
 * @returns Sorted array of EventDTOs
 */
export function getEventsWithRecurrenceExpansion(
  rawEvents: DAVCalendarObject[],
  timeRange: TimeRange,
  logger: Logger,
): EventDTO[] {
  const startDate = new Date(timeRange.start);
  const endDate = new Date(timeRange.end);
  const allEvents: EventDTO[] = [];

  for (const rawEvent of rawEvents) {
    // Transform to EventDTO
    const eventDTO = transformCalendarObject(rawEvent, logger);
    if (!eventDTO) {
      // Transformation failed (logged by transformer)
      addReadWarning(`The event ${rawEvent.url.split('/').pop()} could not be read.`);
      continue;
    }

    // Skip cancelled events (both recurring and non-recurring)
    if (eventDTO.status === 'CANCELLED') {
      logger.debug({ uid: eventDTO.uid, summary: eventDTO.summary }, 'Skipping cancelled event');
      continue;
    }

    // Handle recurring events
    if (eventDTO.isRecurring) {
      try {
        // Parse _raw iCalendar to get VEVENT component
        const jCalData = ICAL.parse(eventDTO._raw);
        const comp = new ICAL.Component(jCalData);
        const vevent = comp.getFirstSubcomponent('vevent');

        if (!vevent) {
          logger.warn({ uid: eventDTO.uid }, 'Recurring event missing VEVENT component');
          continue;
        }

        // Collect all VEVENT exceptions (those with RECURRENCE-ID)
        // This handles cancelled instances (STATUS=CANCELLED) that use RECURRENCE-ID instead of EXDATE
        const allVevents = comp.getAllSubcomponents('vevent');
        const exceptions = allVevents.filter(
          (v: ICAL.Component) => v.hasProperty('recurrence-id')
        );

        // Create ICAL.Event with explicit exceptions
        const icalEvent = new ICAL.Event(vevent, { exceptions });

        // Calculate event duration for occurrence generation
        const duration = eventDTO.endDate.getTime() - eventDTO.startDate.getTime();

        // Expand recurring event with time range boundaries
        const occurrences = expandRecurringEvent(vevent, {
          maxOccurrences: MAX_OCCURRENCES_PER_SERIES,
          maxDate: endDate,
          startDate: startDate,
          lookbackMs: Math.max(duration - 1, 0),
        });
        if (occurrences.length >= MAX_OCCURRENCES_PER_SERIES) {
          addReadWarning(`The series ${eventDTO.uid} has more than ${MAX_OCCURRENCES_PER_SERIES} occurrences in this range, and the later ones are not shown. Ask for a shorter range.`);
        }
        const occurrenceTimes = new Set(occurrences.map((date) => date.getTime()));
        const overlaps = (start: Date, end: Date) =>
          start < endDate && (end > startDate || start >= startDate);

        // Create EventDTO for each occurrence (preserving original fields, updating dates)
        for (const occurrenceDate of occurrences) {
          if (occurrenceDate >= endDate) continue;

          // Check if this occurrence has an exception (RECURRENCE-ID)
          // This handles cancelled instances that use RECURRENCE-ID + STATUS=CANCELLED
          // IMPORTANT: Use 'true' to create UTC time, matching the RECURRENCE-ID format
          const occurrenceTime = ICAL.Time.fromJSDate(occurrenceDate, true);
          const details = icalEvent.getOccurrenceDetails(occurrenceTime);

          // If this occurrence has an exception, check if it's cancelled
          if (details.item !== icalEvent) {
            // This occurrence has a RECURRENCE-ID exception
            const exceptionVevent = details.item.component;
            const exceptionStatus = exceptionVevent.getFirstPropertyValue('status');
            if (exceptionStatus && String(exceptionStatus).toUpperCase() === 'CANCELLED') {
              // Skip cancelled instances
              logger.debug(
                { uid: eventDTO.uid, date: occurrenceDate.toISOString() },
                'Skipping cancelled recurring instance (RECURRENCE-ID + STATUS=CANCELLED)'
              );
              continue;
            }

            // For non-cancelled exceptions, use the exception's dates and summary
            const exceptionEvent = details.item;
            // A moved occurrence belongs to the window of its new date.
            if (!overlaps(details.startDate.toJSDate(), details.endDate.toJSDate())) continue;
            allEvents.push({
              ...eventDTO,
              summary: exceptionEvent.summary || eventDTO.summary,
              description: exceptionEvent.description || eventDTO.description,
              location: exceptionEvent.location || eventDTO.location,
              startDate: details.startDate.toJSDate(),
              endDate: details.endDate.toJSDate(),
              status: exceptionStatus ? String(exceptionStatus).toUpperCase() : eventDTO.status,
            });
          } else {
            // Normal occurrence (no exception)
            const occurrenceEnd = new Date(occurrenceDate.getTime() + duration);

            allEvents.push({
              ...eventDTO,
              startDate: occurrenceDate,
              endDate: occurrenceEnd,
              // Keep other fields (summary, location, attendees, etc.) from original
            });
          }
        }

        // An occurrence moved here from another window: the loop above never met its original date.
        for (const exception of exceptions) {
          const moved = new ICAL.Event(exception);
          const status = exception.getFirstPropertyValue('status');
          if (
            !moved.recurrenceId
            || occurrenceTimes.has(moved.recurrenceId.toJSDate().getTime())
            || (status && String(status).toUpperCase() === 'CANCELLED')
            || !overlaps(moved.startDate.toJSDate(), moved.endDate.toJSDate())
          ) continue;
          allEvents.push({
            ...eventDTO,
            summary: moved.summary || eventDTO.summary,
            description: moved.description || eventDTO.description,
            location: moved.location || eventDTO.location,
            startDate: moved.startDate.toJSDate(),
            endDate: moved.endDate.toJSDate(),
          });
        }
      } catch (err) {
        logger.error(
          { err, uid: eventDTO.uid },
          'Failed to expand recurring event'
        );
        // Skip this recurring event if expansion fails, and say so
        addReadWarning(`The recurring event ${eventDTO.uid} could not be expanded.`);
      }
    } else {
      // Non-recurring event: include if it overlaps the time range, as the server's time-range does
      const overlapsRange = eventDTO.startDate < endDate
        && (eventDTO.endDate > startDate || eventDTO.startDate >= startDate);
      if (overlapsRange) {
        allEvents.push(eventDTO);
      }
    }
  }

  allEvents.sort((a, b) =>
    a.startDate.getTime() - b.startDate.getTime()
    || a.uid.localeCompare(b.uid)
    || a.url.localeCompare(b.url)
  );

  return allEvents;
}

export const DEFAULT_EVENT_LIMIT = 50;
export const MAX_EVENT_LIMIT = 100;
export const DEFAULT_WINDOW_DAYS = 7;
export const MAX_WINDOW_DAYS = 92;
const MAX_CURSOR_SKIP = 10_000;
// shortcut: a series above this in one range is cut with a warning, raise it if a real calendar needs it
const MAX_OCCURRENCES_PER_SERIES = 10_000;

/** Where the next page starts: the start of its first event, and how many events at that exact start were already returned. */
export interface EventCursor {
  start: string;
  skip: number;
}

export const paginationParams = {
  limit: z.number().int().min(1).max(MAX_EVENT_LIMIT).optional().describe(
    `Maximum number of events to return (default ${DEFAULT_EVENT_LIMIT}, maximum ${MAX_EVENT_LIMIT}).`
  ),
  cursor: z.object({
    start: z.string().datetime({ offset: true }),
    skip: z.number().int().min(0).max(MAX_CURSOR_SKIP),
  }).optional().describe('The value of nextCursor in the previous response. Repeat the same dates and filters with it.'),
  // A model may repeat the name it read in the response: the schema would drop it and page 1 would come back.
  nextCursor: z.never({ error: 'Pass the value of nextCursor as the cursor parameter.' }).optional().describe('Not a parameter: pass the value of nextCursor as cursor.'),
};

/**
 * Check a window against the maximum, so that a wide range is an instruction to page rather than a huge download.
 *
 * @returns The problem to report, or null if the window is acceptable
 */
export function checkWindow(timeRange: TimeRange, cursor?: EventCursor): string | null {
  const start = Date.parse(timeRange.start);
  const end = Date.parse(timeRange.end);
  if (end <= start) {
    return 'The end of the date range must be after its start.';
  }
  // In calendar days: 92 of them hold 92 days and one hour across the change to winter time.
  if (end - start > MAX_WINDOW_DAYS * 86_400_000 + 3_600_000) {
    return `The date range is longer than ${MAX_WINDOW_DAYS} days. Ask for ${MAX_WINDOW_DAYS} days at most, then for the following days in another call.`;
  }
  // No lower bound: an event already running at the start of the range sorts first, and can be the next one.
  if (cursor && Date.parse(cursor.start) >= end) {
    return 'The cursor is outside the date range. Repeat the dates of the call that returned it. A call without dates follows the clock, so its range may have moved: start again without the cursor.';
  }
  return null;
}

/** The query window of a page: earlier events of the range were returned by earlier pages. */
export function pageWindow(timeRange: TimeRange, cursor?: EventCursor): TimeRange {
  return cursor ? { start: cursor.start, end: timeRange.end } : timeRange;
}

/**
 * Cut sorted events into one page.
 *
 * The server also returns events that started before the cursor and are still
 * running: earlier pages returned them, so they are dropped here.
 */
export function paginateEvents(
  events: EventDTO[],
  limit: number = DEFAULT_EVENT_LIMIT,
  cursor?: EventCursor,
): { page: EventDTO[]; nextCursor: EventCursor | null } {
  const from = cursor ? Date.parse(cursor.start) : -Infinity;
  const skip = cursor?.skip ?? 0;
  if (skip > events.filter((event) => event.startDate.getTime() === from).length) {
    addReadWarning('The cursor skips more events than start at its date: the calendar changed since the previous page, so some events may be missing. Start again without the cursor to be sure.');
  }
  const remaining = events
    .filter((event) => event.startDate.getTime() >= from)
    .filter((event, index) => !(index < skip && event.startDate.getTime() === from));

  const page = remaining.slice(0, limit);
  const next = remaining[limit];
  if (!next) return { page, nextCursor: null };

  const nextStart = next.startDate.getTime();
  const alreadyReturned = page.filter((event) => event.startDate.getTime() === nextStart).length;
  return {
    page,
    nextCursor: {
      start: next.startDate.toISOString(),
      skip: alreadyReturned + (nextStart === from ? skip : 0),
    },
  };
}

/** The last lines of a page: the model must never read a page as the whole result. */
export function formatPageFooter(nextCursor: EventCursor | null): string {
  return nextCursor
    ? `\n\nMore events remain. To continue, call again with the same dates and pass this value as cursor:\nnextCursor: ${JSON.stringify(nextCursor)}`
    : '\n\nNo more events in this range.';
}

/**
 * Resolve which calendar(s) to query based on the calendar parameter and default setting
 *
 * Resolution order:
 * 1. calendarParam provided and != "all" -> fetch from that specific calendar
 * 2. calendarParam === "all" -> fetch from all calendars
 * 3. calendarParam absent + defaultCalendar set -> fetch from default calendar
 * 4. calendarParam absent + no default -> fetch from all calendars
 *
 * @param calendarService - Calendar service instance
 * @param calendarParam - Optional calendar name from tool parameter
 * @param defaultCalendar - Optional default calendar name from config
 * @param timeRange - Time range for the query
 * @returns Array of DAVCalendarObject from resolved calendar(s)
 */
export async function resolveCalendarEvents(
  calendarService: CalendarService,
  calendarParam: string | undefined,
  defaultCalendar: string | undefined,
  timeRange: TimeRange,
): Promise<DAVCalendarObject[]> {
  // When a default calendar is configured, use it unless the user explicitly
  // provides a different calendar name.  The LLM often sends "all" by default
  // which would bypass the user's configured filter — ignore "all" when a
  // default is set so only the user's own calendar is queried.
  const target = calendarParam === 'all'
    ? (defaultCalendar || undefined)
    : (calendarParam || defaultCalendar);
  if (target) {
    return calendarService.fetchEventsByCalendarName(target, timeRange);
  }
  return calendarService.fetchAllEvents(timeRange);
}

/**
 * Merge overlapping busy periods into non-overlapping intervals
 *
 * Sorts periods by start time, then merges any that overlap or are adjacent.
 * All merged periods get type 'BUSY'.
 *
 * @param periods - Array of FreeBusyPeriod to merge
 * @returns Merged array with no overlapping periods
 */
export function mergeBusyPeriods(periods: FreeBusyPeriod[]): FreeBusyPeriod[] {
  if (periods.length === 0) {
    return [];
  }

  // Sort by start time ascending
  const sorted = [...periods].sort(
    (a, b) => a.start.getTime() - b.start.getTime()
  );

  const merged: FreeBusyPeriod[] = [{ ...sorted[0], type: 'BUSY' }];

  for (let i = 1; i < sorted.length; i++) {
    const current = sorted[i];
    const lastMerged = merged[merged.length - 1];

    if (lastMerged.end >= current.start) {
      // Overlapping or adjacent: extend end to max
      lastMerged.end = new Date(
        Math.max(lastMerged.end.getTime(), current.end.getTime())
      );
    } else {
      // No overlap: push as new period
      merged.push({ ...current, type: 'BUSY' });
    }
  }

  return merged;
}

/**
 * Compute busy periods from a list of events
 *
 * Parses each event's raw iCalendar data to check the TRANSP property.
 * Events with TRANSP=TRANSPARENT are skipped (they don't block time).
 * Remaining events are converted to FreeBusyPeriod and merged.
 *
 * @param events - Array of EventDTO with _raw iCalendar data
 * @param logger - Logger for debug/error output
 * @returns Merged array of busy periods
 */
export function computeBusyPeriods(events: EventDTO[], logger: Logger): FreeBusyPeriod[] {
  const periods: FreeBusyPeriod[] = [];

  for (const event of events) {
    try {
      const jcalData = ICAL.parse(event._raw);
      const comp = new ICAL.Component(jcalData);
      const vevent = comp.getFirstSubcomponent('vevent');

      if (!vevent) {
        continue;
      }

      // Skip cancelled events — they don't block time
      if (event.status === 'CANCELLED') {
        logger.debug({ uid: event.uid }, 'Skipping CANCELLED event for busy period');
        continue;
      }

      // Check transparency: TRANSPARENT events don't block time
      const transp = vevent.getFirstPropertyValue('transp');
      if (transp && String(transp).toUpperCase() === 'TRANSPARENT') {
        logger.debug({ uid: event.uid }, 'Skipping TRANSPARENT event');
        continue;
      }

      periods.push({
        start: event.startDate,
        end: event.endDate,
        type: 'BUSY',
      });
    } catch (err) {
      logger.debug({ err, uid: event.uid }, 'Failed to parse event for busy period computation');
    }
  }

  return mergeBusyPeriods(periods);
}
