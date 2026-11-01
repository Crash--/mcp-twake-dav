/**
 * MCP tool: check_availability (ADV-01)
 *
 * Computes busy periods from the events themselves (recurrences expanded, TRANSPARENT and
 * CANCELLED events ignored). All-day events (holidays, trade shows, custody days…) are listed
 * apart and do not block time unless all_day_busy is set: a server-side free-busy-query cannot
 * tell them from meetings, so one multi-day marker made whole days look busy and hid the
 * meetings of the following days.
 */

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Logger } from 'pino';
import type { CalendarService } from '../../caldav/calendar-service.js';
import * as chrono from 'chrono-node';
import {
  resolveCalendarEvents,
  getEventsWithRecurrenceExpansion,
  computeBusyPeriods,
  formatAllDaySpan,
} from './utils.js';
import type { EventDTO } from '../../types/dtos.js';

/** Availability answer for [queryStart, queryEnd): busy periods clipped to the range, then all-day events. */
export function buildAvailabilityText(
  events: EventDTO[],
  queryStart: Date,
  queryEnd: Date,
  displayTimezone: string,
  options: { allDayBusy: boolean },
  logger?: Logger,
): string {
  const silent = { debug() {}, info() {}, warn() {}, error() {} } as unknown as Logger;
  const periods = computeBusyPeriods(events, logger ?? silent, { allDayBusy: options.allDayBusy })
    .map((p) => ({ start: p.start < queryStart ? queryStart : p.start, end: p.end > queryEnd ? queryEnd : p.end }))
    .filter((p) => p.end > p.start);

  const day = (d: Date) => d.toLocaleDateString('en-US', { timeZone: displayTimezone });
  const dateTime = (d: Date) =>
    d.toLocaleString('en-US', { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: displayTimezone });
  const time = (d: Date) => d.toLocaleString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: displayTimezone });
  const rangeStr = `${queryStart.toLocaleString('en-US', { timeZone: displayTimezone })} to ${queryEnd.toLocaleString('en-US', { timeZone: displayTimezone })} (${displayTimezone})`;

  const lines: string[] = [];
  if (periods.length === 0) {
    lines.push(`You are free from ${rangeStr}. No busy periods found.`);
  } else {
    lines.push(`Busy periods from ${rangeStr}:`, '');
    periods.forEach((p, i) => {
      const end = day(p.end) === day(p.start) ? time(p.end) : dateTime(p.end);
      lines.push(`${i + 1}. ${dateTime(p.start)} - ${end}`);
    });
    lines.push('', `${periods.length} busy period(s) found.`);
  }

  const allDay = events.filter((e) => e.allDay && e.status !== 'CANCELLED');
  if (allDay.length) {
    lines.push(
      '',
      options.allDayBusy
        ? 'All-day events (counted as busy above):'
        : 'All-day events (not counted as busy; check them, e.g. a holiday or a day off may still rule out a slot):',
      ...allDay.map((e) => `- ${formatAllDaySpan(e.startDate, e.endDate)}: ${e.summary}`),
    );
  }
  return lines.join('\n');
}

function parseWhen(value: string): Date | null {
  const d = chrono.parseDate(value) ?? new Date(value);
  return isNaN(d.getTime()) ? null : d;
}

/**
 * Register the check_availability tool
 *
 * @param server - MCP server instance
 * @param calendarService - Calendar service for fetching events
 * @param logger - Pino logger
 * @param defaultCalendar - Optional default calendar name from config
 */
export function registerCheckAvailabilityTool(
  server: McpServer,
  calendarService: CalendarService,
  logger: Logger,
  defaultCalendar?: string,
  userTimezone?: string,
): void {
  server.tool(
    'check_availability',
    'Check calendar availability for a time range. Returns the busy periods (recurring events expanded, transparent and cancelled events ignored) and lists all-day events (holidays, trade shows, days off) separately: they do not count as busy unless all_day_busy is true. Supports natural language dates (e.g., "Thursday afternoon", "tomorrow at 9am") or ISO 8601.',
    {
      start: z.string().describe(
        'Start of time range. Supports natural language (e.g., "Thursday afternoon", "tomorrow at 9am") or ISO 8601.'
      ),
      end: z.string().describe(
        'End of time range. Supports natural language or ISO 8601.'
      ),
      all_day_busy: z.boolean().optional().describe(
        'Count all-day events as busy for their whole days (default false: they are listed apart).'
      ),
      calendar: z.string().optional().describe(
        'Calendar name to check. Use "all" to check all calendars. ' +
        (defaultCalendar ? `Defaults to "${defaultCalendar}".` : 'Defaults to all calendars.')
      ),
    },
    {
      readOnlyHint: true,
      destructiveHint: false,
      openWorldHint: true,
    },
    async (params) => {
      try {
        logger.debug({ params }, 'check_availability called');

        const startDate = parseWhen(params.start);
        if (!startDate) {
          return {
            content: [{ type: 'text' as const, text: `Could not parse start date: "${params.start}". Please use natural language (e.g., "tomorrow at 9am") or ISO 8601 format.` }],
            isError: true,
          };
        }
        const endDate = parseWhen(params.end);
        if (!endDate) {
          return {
            content: [{ type: 'text' as const, text: `Could not parse end date: "${params.end}". Please use natural language (e.g., "Friday at 5pm") or ISO 8601 format.` }],
            isError: true,
          };
        }
        if (endDate <= startDate) {
          return {
            content: [{ type: 'text' as const, text: `End date must be after start date. Start: ${startDate.toLocaleString()}, End: ${endDate.toLocaleString()}` }],
            isError: true,
          };
        }

        const timeRange = { start: startDate.toISOString(), end: endDate.toISOString() };
        const rawEvents = await resolveCalendarEvents(calendarService, params.calendar, defaultCalendar, timeRange);
        // every event counts: a truncated list would report busy slots as free
        const events = getEventsWithRecurrenceExpansion(rawEvents, timeRange, logger, Number.POSITIVE_INFINITY);
        const displayTimezone = userTimezone || Intl.DateTimeFormat().resolvedOptions().timeZone;
        const text = buildAvailabilityText(events, startDate, endDate, displayTimezone, { allDayBusy: params.all_day_busy ?? false }, logger);
        return { content: [{ type: 'text' as const, text }] };
      } catch (err) {
        logger.error({ err }, 'Error in check_availability');
        return {
          content: [{
            type: 'text' as const,
            text: `Error: ${err instanceof Error ? err.message : String(err)}`,
          }],
          isError: true,
        };
      }
    }
  );
}
