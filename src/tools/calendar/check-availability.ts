/**
 * MCP tool: check_availability (ADV-01)
 *
 * Checks calendar availability for a time range using dual-path approach:
 * 1. Server-side free-busy-query REPORT (RFC 4791 s7.10)
 * 2. Client-side fallback: fetch events, filter TRANSPARENT, merge busy periods
 */

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Logger } from 'pino';
import type { CalendarService } from '../../caldav/calendar-service.js';
import { freeBusyQuery } from 'tsdav';
import { davFetch } from '../../caldav/href-prefix.js';
import ICAL from 'ical.js';
import {
  getEventsWithRecurrenceExpansion,
  computeBusyPeriods,
  checkWindow,
  mergeBusyPeriods,
  parseDateRange,
  ISO_DATE_HELP,
} from './utils.js';
import type { FreeBusyPeriod } from '../../types/dtos.js';
import { isDavUnsupported } from '../../errors.js';
import { hasPartialRead } from '../../caldav/dav-fetch.js';

/**
 * Format free/busy response for the user
 *
 * @param periods - Array of busy periods to display
 * @param queryStart - Start of the queried time range
 * @param queryEnd - End of the queried time range
 * @param userTimezone - Optional user timezone for display
 * @returns MCP tool response content
 */
function formatFreeBusyResponse(
  periods: FreeBusyPeriod[],
  queryStart: Date,
  queryEnd: Date,
  userTimezone?: string,
) {
  const displayTimezone = userTimezone || Intl.DateTimeFormat().resolvedOptions().timeZone;
  const tzOptions = { timeZone: displayTimezone };

  if (periods.length === 0) {
    return {
      content: [{
        type: 'text' as const,
        text: `You are free from ${queryStart.toLocaleString('en-US', tzOptions)} to ${queryEnd.toLocaleString('en-US', tzOptions)} (${displayTimezone}). No busy periods found.`,
      }],
    };
  }

  const periodLines = periods.map((p, i) => {
    const startStr = p.start.toLocaleString('en-US', {
      weekday: 'short', month: 'short', day: 'numeric',
      hour: 'numeric', minute: '2-digit',
      timeZone: displayTimezone,
    });
    const endStr = p.end.toLocaleString('en-US', {
      hour: 'numeric', minute: '2-digit',
      timeZone: displayTimezone,
    });
    return `${i + 1}. ${startStr} - ${endStr}`;
  });

  const text = [
    `Busy periods from ${queryStart.toLocaleString('en-US', tzOptions)} to ${queryEnd.toLocaleString('en-US', tzOptions)} (${displayTimezone}):`,
    '',
    ...periodLines,
    '',
    `${periods.length} busy period(s) found.`,
  ].join('\n');

  return {
    content: [{
      type: 'text' as const,
      text,
    }],
  };
}

const FREE_BUSY_CONCURRENCY = 5;

/**
 * Busy periods of one calendar from the server.
 *
 * @returns The periods, or null if this server does not offer a usable free-busy-query
 * @throws DavHttpError when the server fails: that must surface, not trigger a second round of requests
 */
async function queryCalendarBusy(
  calendarService: CalendarService,
  url: string,
  timeRange: { start: string; end: string },
  logger: Logger,
): Promise<FreeBusyPeriod[] | null> {
  try {
    const response = await freeBusyQuery({ url, timeRange, headers: await calendarService.getFreshAuthHeaders(), fetch: davFetch() });
    const icalData = response?.props?.calendarData?._value
      || response?.props?.calendarData?.value
      || response?.raw;
    if (typeof icalData !== 'string') return null;

    const vfreebusy = new ICAL.Component(ICAL.parse(icalData)).getFirstSubcomponent('vfreebusy');
    if (!vfreebusy) return null;

    const periods: FreeBusyPeriod[] = [];
    for (const prop of vfreebusy.getAllProperties('freebusy')) {
      const period = prop.getFirstValue() as { start?: ICAL.Time; end?: ICAL.Time } | null;
      const type = String(prop.getParameter('fbtype') || 'BUSY');
      if (period?.start && period?.end && type.toUpperCase() !== 'FREE') {
        periods.push({ start: period.start.toJSDate(), end: period.end.toJSDate(), type });
      }
    }
    return periods;
  } catch (err) {
    if (!isDavUnsupported(err) && !(err instanceof ICAL.parse.ParserError)) throw err;
    logger.info({ err, url }, 'Server-side free-busy-query unavailable, using client-side fallback');
    return null;
  }
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
    'Check availability across all calendars, or one if named, for a time range of 92 days at most. Returns busy periods or confirms availability.',
    {
      start: z.string().describe(`Start of time range. ${ISO_DATE_HELP}`),
      end: z.string().describe('End of time range, a date alone includes that whole day.'),
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

        const timeRange = parseDateRange(params.start, params.end, 0, userTimezone);
        if ('problem' in timeRange) {
          return { content: [{ type: 'text' as const, text: timeRange.problem }], isError: true };
        }
        const windowProblem = checkWindow(timeRange);
        if (windowProblem) {
          return { content: [{ type: 'text' as const, text: windowProblem }], isError: true };
        }
        const startDate = new Date(timeRange.start);
        const endDate = new Date(timeRange.end);

        const calendars = await calendarService.listCalendars();
        const resolvedCalendar = params.calendar === 'all'
          ? undefined
          : (params.calendar || defaultCalendar);
        const targets = resolvedCalendar
          ? calendars.filter(c => String(c.displayName || '').toLowerCase() === resolvedCalendar.toLowerCase())
          : calendars;
        if (targets.length === 0) {
          return {
            content: [{
              type: 'text' as const,
              text: resolvedCalendar
                ? `Calendar "${resolvedCalendar}" not found.\n\nFix: Use list_calendars to see the available names.`
                : 'No calendars available, so availability is unknown.',
            }],
            isError: true,
          };
        }

        // --- Path 1: Server-side free-busy-query, one per calendar ---
        const perCalendar: Array<FreeBusyPeriod[] | null> = [];
        for (let i = 0; i < targets.length; i += FREE_BUSY_CONCURRENCY) {
          perCalendar.push(...await Promise.all(
            targets.slice(i, i + FREE_BUSY_CONCURRENCY).map((calendar) =>
              queryCalendarBusy(calendarService, calendar.url, timeRange, logger)
            )
          ));
        }
        if (perCalendar.every((periods) => periods !== null)) {
          const merged = mergeBusyPeriods(perCalendar.flatMap((periods) => periods ?? []));
          logger.info({ periods: merged.length, calendars: targets.length }, 'Server-side free-busy-query succeeded');
          return formatFreeBusyResponse(merged, startDate, endDate, userTimezone);
        }

        // --- Path 2: Client-side fallback ---
        const rawEvents = await calendarService.fetchEventsFrom(targets, timeRange);
        const events = getEventsWithRecurrenceExpansion(rawEvents, timeRange, logger);
        const busyPeriods = computeBusyPeriods(events, logger);
        // Anything not read could be what makes this time busy.
        if (hasPartialRead()) {
          return {
            content: [{
              type: 'text' as const,
              text: 'Availability is unknown: some events could not be read, so this time cannot be called free.',
            }],
            isError: true,
          };
        }
        return formatFreeBusyResponse(busyPeriods, startDate, endDate, userTimezone);
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
