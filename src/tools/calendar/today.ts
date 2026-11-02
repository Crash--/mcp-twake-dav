/**
 * MCP tool: get_todays_schedule (CAL-02)
 *
 * Returns all events scheduled for today, sorted by time.
 */

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Logger } from 'pino';
import type { CalendarService } from '../../caldav/calendar-service.js';
import {
  getEventsWithRecurrenceExpansion,
  formatEvent,
  getStartOfDay,
  getEndOfDay,
  resolveCalendarEvents,
  paginationParams,
  checkWindow,
  pageWindow,
  paginateEvents,
  formatPageFooter,
} from './utils.js';

/**
 * Register the get_todays_schedule tool
 *
 * @param server - MCP server instance
 * @param calendarService - Calendar service for fetching events
 * @param logger - Pino logger
 */
export function registerTodaysScheduleTool(
  server: McpServer,
  calendarService: CalendarService,
  logger: Logger,
  defaultCalendar?: string,
  userTimezone?: string,
): void {
  server.tool(
    'get_todays_schedule',
    'Get the events scheduled for today, sorted by time, one page at a time. When the response has a nextCursor, more events remain. Optionally filter by calendar name, or use "all" to search all calendars.',
    {
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
        logger.debug('get_todays_schedule called');

        // Create time range: start of today to end of today
        const now = new Date();
        const startOfDay = getStartOfDay(now);
        const endOfDay = getEndOfDay(now);

        const timeRange = {
          start: startOfDay.toISOString(),
          end: endOfDay.toISOString(),
        };

        const windowProblem = checkWindow(timeRange, params.cursor);
        if (windowProblem) {
          return { content: [{ type: 'text' as const, text: windowProblem }], isError: true };
        }

        // Fetch events based on calendar param / default / all
        const rawEvents = await resolveCalendarEvents(
          calendarService, params.calendar, defaultCalendar, pageWindow(timeRange, params.cursor)
        );

        // Transform and expand recurring events
        // Over the whole range: an occurrence moved after the cursor comes from before it.
        const expanded = getEventsWithRecurrenceExpansion(rawEvents, timeRange, logger);
        const { page: events, nextCursor, more } = paginateEvents(expanded, params.limit, params.cursor);

        if (events.length === 0) {
          logger.info('No events scheduled for today');
          return {
            content: [
              {
                type: 'text' as const,
                text: 'No events scheduled for today',
              },
            ],
          };
        }

        // Format all events
        const formattedEvents = events.map((event) => formatEvent(event, userTimezone)).join('\n\n');
        const result = `Today's schedule (${events.length} event${events.length === 1 ? '' : 's'} in this page):\n\n${formattedEvents}${formatPageFooter(nextCursor, more)}`;

        logger.info({ count: events.length }, 'Today\'s schedule retrieved');

        return {
          content: [
            {
              type: 'text' as const,
              text: result,
            },
          ],
        };
      } catch (err) {
        logger.error({ err }, 'Error in get_todays_schedule');
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
