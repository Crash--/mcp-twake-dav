/**
 * MCP tool: create_event (CALW-01)
 *
 * Creates a new calendar event with natural language date parsing support.
 */

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Logger } from 'pino';
import type { CalendarService } from '../../caldav/calendar-service.js';
import { ConflictError } from '../../errors.js';
import { buildICalString } from '../../transformers/event-builder.js';
import * as chrono from 'chrono-node';
import { approverFor } from '../../approval.js';

/**
 * Register the create_event tool
 *
 * @param server - MCP server instance
 * @param calendarService - Calendar service for creating events
 * @param logger - Pino logger
 * @param defaultCalendar - Optional default calendar name from config
 */
export function registerCreateEventTool(
  server: McpServer,
  calendarService: CalendarService,
  logger: Logger,
  defaultCalendar?: string,
  userTimezone?: string,
  organizer?: { email: string; name?: string },
): void {
  server.tool(
    'create_event',
    'Create a new calendar event. Supports natural language dates (e.g., \'tomorrow at 2pm\', \'next Monday\'). ' +
    'IMPORTANT: if the user did not say who should attend, ASK who to invite before calling this tool (no answer or "nobody" means no attendees). ' +
    'Resolve names to email addresses with search_contacts and never guess an address. ' +
    'Attendees receive an invitation email sent by the calendar server on behalf of the organizer, so summarize the event (title, start, end, location, attendees with emails) and ask the user to confirm before creating.',
    {
      title: z.string().describe('Event title/summary'),
      start: z.string().describe('Start date/time. Supports natural language (e.g., "tomorrow at 2pm", "next Monday at 10am") or ISO 8601 format.'),
      end: z.string().describe('End date/time. Supports natural language or ISO 8601 format. If not specified as a time, defaults to 1 hour after start.'),
      description: z.string().optional().describe('Event description'),
      location: z.string().optional().describe('Event location'),
      calendar: z.string().optional().describe(
        'Calendar name to create the event in. ' +
        (defaultCalendar ? `Defaults to "${defaultCalendar}".` : 'Defaults to first calendar.')
      ),
      allDay: z.boolean().optional().describe('If true, creates an all-day event (DATE format instead of DATE-TIME)'),
      recurrence: z.string().optional().describe('RRULE recurrence string (e.g., "FREQ=WEEKLY;BYDAY=MO", "FREQ=DAILY;COUNT=5")'),
      attendees: z
        .array(
          z.object({
            email: z.string().email().describe('Attendee email address'),
            name: z.string().optional().describe('Attendee display name'),
          })
        )
        .optional()
        .describe('People to invite. They will receive an invitation email. Omit for an event without attendees.'),
    },
    {
      readOnlyHint: false,
      destructiveHint: false,
      openWorldHint: true,
    },
    async (params) => {
      try {
        logger.debug({ params }, 'create_event called');

        // Parse start date - try chrono-node first, then fallback to Date constructor
        let startDate = chrono.parseDate(params.start);
        if (!startDate) {
          startDate = new Date(params.start);
          if (isNaN(startDate.getTime())) {
            return {
              content: [
                {
                  type: 'text' as const,
                  text: `Could not parse start date: "${params.start}". Please use natural language (e.g., "tomorrow at 2pm") or ISO 8601 format.`,
                },
              ],
              isError: true,
            };
          }
        }

        // Parse end date - try chrono-node first, then fallback to Date constructor
        let endDate = chrono.parseDate(params.end);
        if (!endDate) {
          endDate = new Date(params.end);
          if (isNaN(endDate.getTime())) {
            // If end date is invalid, default to 1 hour after start
            endDate = new Date(startDate.getTime() + 60 * 60 * 1000);
            logger.debug({ start: startDate, end: endDate }, 'End date invalid, defaulting to 1 hour after start');
          }
        }

        // Validate: end must be after start
        if (endDate <= startDate) {
          const displayTz = userTimezone || Intl.DateTimeFormat().resolvedOptions().timeZone;
          return {
            content: [
              {
                type: 'text' as const,
                text: `End date must be after start date. Start: ${startDate.toLocaleString('en-US', { timeZone: displayTz })}, End: ${endDate.toLocaleString('en-US', { timeZone: displayTz })}`,
              },
            ],
            isError: true,
          };
        }

        // Attendees require a configured organizer
        const attendees = params.attendees ?? [];
        if (attendees.length > 0 && !organizer) {
          return {
            content: [
              {
                type: 'text' as const,
                text: 'Cannot invite attendees: no organizer configured. Set DAV_ORGANIZER_EMAIL (and optionally DAV_ORGANIZER_NAME).',
              },
            ],
            isError: true,
          };
        }

        // Resolve target calendar
        const resolvedCalendar = params.calendar || defaultCalendar;

        // Build iCalendar string with timezone
        const iCalString = buildICalString({
          title: params.title,
          start: startDate,
          end: endDate,
          description: params.description,
          location: params.location,
          allDay: params.allDay,
          recurrence: params.recurrence,
          timezone: userTimezone,
          organizer,
          attendees,
        });

        const refused = await approverFor(server).gate({
          action: 'create_event',
          details: [
            ['calendar', resolvedCalendar],
            ['title', params.title],
            ['when', approverFor(server).span(startDate, endDate, Boolean(params.allDay))],
            ['location', params.location],
            ['description', params.description],
            ['recurrence', params.recurrence],
            ['attendees', approverFor(server).notified(attendees.map((a) => (a.name ? `${a.name} <${a.email}>` : a.email)), 'invitation_sent')],
          ],
        });
        if (refused) return refused;
        // Create event
        const result = await calendarService.createEvent(iCalString, resolvedCalendar);

        // Format success response with user timezone
        const displayTimezone = userTimezone || Intl.DateTimeFormat().resolvedOptions().timeZone;
        const tzOptions: Intl.DateTimeFormatOptions = { timeZone: displayTimezone };

        const calendarText = resolvedCalendar ? ` in calendar "${resolvedCalendar}"` : '';
        const locationText = params.location ? `\nLocation: ${params.location}` : '';
        const descriptionText = params.description ? `\nDescription: ${params.description}` : '';
        const recurrenceText = params.recurrence ? `\nRecurrence: ${params.recurrence}` : '';
        const attendeesText = attendees.length > 0
          ? `\nAttendees (invitation sent by the server): ${attendees.map((a) => (a.name ? `${a.name} <${a.email}>` : a.email)).join(', ')}`
          : '';

        const responseText = [
          `Event created successfully${calendarText}:`,
          `Title: ${params.title}`,
          `Start: ${startDate.toLocaleString('en-US', tzOptions)} (${displayTimezone})`,
          `End: ${endDate.toLocaleString('en-US', tzOptions)}`,
          locationText,
          descriptionText,
          recurrenceText,
          attendeesText,
          `\nEvent URL: ${result.url}`,
        ]
          .filter(line => line !== '')
          .join('\n');

        logger.info({ url: result.url, calendar: resolvedCalendar }, 'Event created successfully');

        return {
          content: [
            {
              type: 'text' as const,
              text: responseText,
            },
          ],
        };
      } catch (err) {
        // Handle ConflictError specifically
        if (err instanceof ConflictError) {
          logger.warn({ title: params.title }, 'Conflict during create');
          return {
            content: [
              {
                type: 'text' as const,
                text: err.message,
              },
            ],
            isError: true,
          };
        }

        // Handle all other errors
        logger.error({ err }, 'Error in create_event');
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
