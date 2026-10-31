/**
 * MCP tool: search_events (CAL-04)
 *
 * Search calendar events by keyword in title/description or by attendee name.
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
  searchEventsByKeyword,
  searchEventsByAttendee,
  resolveCalendarEvents,
  paginationParams,
  checkWindow,
  pageWindow,
  paginateEvents,
  formatPageFooter,
  MAX_WINDOW_DAYS,
} from './utils.js';

/**
 * Register the search_events tool
 *
 * @param server - MCP server instance
 * @param calendarService - Calendar service for fetching events
 * @param logger - Pino logger
 */
export function registerSearchEventsTool(
  server: McpServer,
  calendarService: CalendarService,
  logger: Logger,
  defaultCalendar?: string,
  userTimezone?: string,
): void {
  server.tool(
    'search_events',
    `Search calendar events by keyword in title/description or by attendee name. Searches the next 30 days by default, ${MAX_WINDOW_DAYS} days at most, one page at a time. When the response has a nextCursor, more matches remain. Optionally filter by calendar name.`,
    {
      query: z.string().optional().describe('Keyword to search in event titles and descriptions'),
      attendee: z.string().optional().describe('Attendee name to filter by'),
      start: z.string().optional().describe(`Start of the range to search, defaults to now. ${ISO_DATE_HELP}`),
      end: z.string().optional().describe('End of the range to search, a date alone includes that whole day. Defaults to 30 days after the start.'),
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
        logger.debug({ params }, 'search_events called');

        // Require at least one of query or attendee
        if (!params.query && !params.attendee) {
          logger.warn('search_events called without query or attendee');
          return {
            content: [
              {
                type: 'text' as const,
                text: 'Please provide a search query or attendee name',
              },
            ],
            isError: true,
          };
        }

        const timeRange = parseDateRange(params.start, params.end, 30, userTimezone);
        if ('problem' in timeRange) {
          return { content: [{ type: 'text' as const, text: timeRange.problem }], isError: true };
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
        let events = getEventsWithRecurrenceExpansion(rawEvents, timeRange, logger);

        // Apply keyword filter if query provided
        if (params.query) {
          events = searchEventsByKeyword(events, params.query);
        }

        // Apply attendee filter if attendee provided
        if (params.attendee) {
          events = searchEventsByAttendee(events, params.attendee);
        }

        // Cut after the filters: a match can be anywhere in the window.
        const { page, nextCursor } = paginateEvents(events, params.limit, params.cursor);
        events = page;

        if (events.length === 0) {
          const searchDescription = params.query
            ? params.attendee
              ? `keyword "${params.query}" and attendee "${params.attendee}"`
              : `keyword "${params.query}"`
            : `attendee "${params.attendee}"`;

          logger.info({ query: params.query, attendee: params.attendee }, 'No events found matching search');
          return {
            content: [
              {
                type: 'text' as const,
                text: `No events found matching ${searchDescription}`,
              },
            ],
          };
        }

        // Format all events
        const formattedEvents = events.map((event) => formatEvent(event, userTimezone)).join('\n\n');

        const searchDescription = params.query
          ? params.attendee
            ? `keyword "${params.query}" and attendee "${params.attendee}"`
            : `keyword "${params.query}"`
          : `attendee "${params.attendee}"`;

        const result = `Found ${events.length} event${events.length === 1 ? '' : 's'} matching ${searchDescription} in this page:\n\n${formattedEvents}${formatPageFooter(nextCursor)}`;

        logger.info({ query: params.query, attendee: params.attendee, count: events.length }, 'Search completed');

        return {
          content: [
            {
              type: 'text' as const,
              text: result,
            },
          ],
        };
      } catch (err) {
        logger.error({ err }, 'Error in search_events');
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
