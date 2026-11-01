/**
 * MCP tool: get_events_in_range (CAL-03)
 *
 * Get calendar events for a date range, one page at a time.
 */

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Logger } from 'pino';
import type { CalendarService } from '../../caldav/calendar-service.js';
import {
  getEventsWithRecurrenceExpansion,
  formatEvent,
  parseDateRange,
  ISO_DATE_HELP,
  resolveCalendarEvents,
  paginationParams,
  checkWindow,
  pageWindow,
  paginateEvents,
  formatPageFooter,
  DEFAULT_WINDOW_DAYS,
  MAX_WINDOW_DAYS,
} from './utils.js';

/**
 * Register the get_events_in_range tool
 *
 * @param server - MCP server instance
 * @param calendarService - Calendar service for fetching events
 * @param logger - Pino logger
 */
export function registerDateRangeTool(
  server: McpServer,
  calendarService: CalendarService,
  logger: Logger,
  defaultCalendar?: string,
  userTimezone?: string,
): void {
  server.tool(
    'get_events_in_range',
    `Get the calendar events overlapping a date range, sorted by start, one page at a time. Without dates, covers the next ${DEFAULT_WINDOW_DAYS} days; a range covers ${MAX_WINDOW_DAYS} days at most, and an event crossing the boundary of two ranges appears in both. When the response has a nextCursor, more events remain. Optionally filter by calendar name.`,
    {
      start: z.string().optional().describe(`Start of the range, defaults to now. ${ISO_DATE_HELP}`),
      end: z.string().optional().describe(`End of the range, a date alone includes that whole day. Defaults to ${DEFAULT_WINDOW_DAYS} days after the start.`),
      ...paginationParams,
      calendar: z.string().optional().describe(
        'Calendar name to search in. Use "all" to search all calendars. ' +
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
        logger.debug({ params }, 'get_events_in_range called');

        const timeRange = parseDateRange(params.start, params.end, DEFAULT_WINDOW_DAYS, userTimezone);
        if ('problem' in timeRange) {
          return { content: [{ type: 'text' as const, text: timeRange.problem }], isError: true };
        }
        const label = `${timeRange.start} to ${timeRange.end}`;

        const windowProblem = checkWindow(timeRange, params.cursor);
        if (windowProblem) {
          return { content: [{ type: 'text' as const, text: windowProblem }], isError: true };
        }

        // Fetch events based on calendar param / default / all
        const queryWindow = pageWindow(timeRange, params.cursor);
        const rawEvents = await resolveCalendarEvents(
          calendarService, params.calendar, defaultCalendar, queryWindow
        );

        // Transform and expand recurring events
        // Over the whole range: an occurrence moved after the cursor comes from before it.
        const expanded = getEventsWithRecurrenceExpansion(rawEvents, timeRange, logger, userTimezone);
        const { page: events, nextCursor } = paginateEvents(expanded, params.limit, params.cursor);

        if (events.length === 0) {
          logger.info({ when: label }, 'No events found for date range');
          return {
            content: [
              {
                type: 'text' as const,
                text: `No events found for ${label}`,
              },
            ],
          };
        }

        // Format all events
        const formattedEvents = events.map((event) => formatEvent(event, userTimezone)).join('\n\n');
        const result = `Events for ${label} (${events.length} in this page):\n\n${formattedEvents}${formatPageFooter(nextCursor)}`;

        logger.info({ when: label, count: events.length }, 'Events retrieved for date range');

        return {
          content: [
            {
              type: 'text' as const,
              text: result,
            },
          ],
        };
      } catch (err) {
        logger.error({ err }, 'Error in get_events_in_range');
        return {
          content: [
            {
              type: 'text' as const,
              text: `Error: ${err instanceof Error ? err.message : String(err)}`,
            },
          ],
          isError: true,
        };
      }
    }
  );
}
