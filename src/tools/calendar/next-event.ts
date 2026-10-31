/**
 * MCP tool: get_next_event (CAL-01)
 *
 * Returns the next upcoming calendar event from all calendars.
 */

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Logger } from 'pino';
import type { CalendarService } from '../../caldav/calendar-service.js';
import {
  getEventsWithRecurrenceExpansion,
  formatEvent,
  resolveCalendarEvents,
} from './utils.js';
import type { EventDTO } from '../../types/dtos.js';

const SEARCH_HORIZONS_DAYS = [1, 7, 30, 92, 183, 274, 365];

/**
 * Register the get_next_event tool
 *
 * @param server - MCP server instance
 * @param calendarService - Calendar service for fetching events
 * @param logger - Pino logger
 */
export function registerNextEventTool(
  server: McpServer,
  calendarService: CalendarService,
  logger: Logger,
  defaultCalendar?: string,
  userTimezone?: string,
): void {
  server.tool(
    'get_next_event',
    'Get the next upcoming calendar event. Returns the soonest event. Optionally filter by calendar name, or use "all" to search all calendars.',
    {
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
        logger.debug({ params }, 'get_next_event called');

        // Widen the search step by step, so that a busy calendar answers from its next day.
        const now = Date.now();
        let nextEvent: EventDTO | undefined;
        let from = now;
        for (const days of SEARCH_HORIZONS_DAYS) {
          const until = now + days * 86_400_000;
          const timeRange = { start: new Date(from).toISOString(), end: new Date(until).toISOString() };
          const rawEvents = await resolveCalendarEvents(
            calendarService, params.calendar, defaultCalendar, timeRange
          );
          const events = getEventsWithRecurrenceExpansion(rawEvents, timeRange, logger);
          // An event already running overlaps the range but is not upcoming.
          nextEvent = events.find((event) => event.startDate.getTime() >= from);
          if (nextEvent) break;
          from = until;
        }

        if (!nextEvent) {
          logger.info('No upcoming events found');
          return {
            content: [
              {
                type: 'text' as const,
                text: `No upcoming events found in the next ${SEARCH_HORIZONS_DAYS.at(-1)} days`,
              },
            ],
          };
        }

        const formattedEvent = formatEvent(nextEvent, userTimezone);
        logger.info({ uid: nextEvent.uid }, 'Next event found');

        return {
          content: [
            {
              type: 'text' as const,
              text: formattedEvent,
            },
          ],
        };
      } catch (err) {
        logger.error({ err }, 'Error in get_next_event');
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
