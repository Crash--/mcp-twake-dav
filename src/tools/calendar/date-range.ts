/**
 * MCP tool: get_events_in_range (CAL-03)
 *
 * Get calendar events for a date range using natural language parsing.
 */

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Logger } from 'pino';
import type { CalendarService } from '../../caldav/calendar-service.js';
import {
  getEventsWithRecurrenceExpansion,
  formatEvent,
  parseNaturalDateRange,
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
    `Get calendar events for a date range, sorted by start, one page at a time. Without dates, covers the next ${DEFAULT_WINDOW_DAYS} days; a range covers ${MAX_WINDOW_DAYS} days at most. When the response has a nextCursor, more events remain. Optionally filter by calendar name.`,
    {
      when: z.string().optional().describe(`Date range expression: \'tomorrow\', \'January 15 to January 20\', etc. Defaults to the next ${DEFAULT_WINDOW_DAYS} days.`),
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

        // Parse natural language date expression
        const now = Date.now();
        const timeRange = params.when
          ? parseNaturalDateRange(params.when)
          : { start: new Date(now).toISOString(), end: new Date(now + DEFAULT_WINDOW_DAYS * 86_400_000).toISOString() };
        const label = params.when ?? `the next ${DEFAULT_WINDOW_DAYS} days`;

        if (!timeRange) {
          logger.warn({ when: params.when }, 'Could not parse date range');
          return {
            content: [
              {
                type: 'text' as const,
                text: `Could not understand the date range: '${params.when}'. Try 'this week', 'next month', 'tomorrow', or a specific date.`,
              },
            ],
            isError: true,
          };
        }

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
        const expanded = getEventsWithRecurrenceExpansion(rawEvents, timeRange, logger);
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
