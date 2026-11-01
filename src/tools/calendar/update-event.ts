/**
 * MCP tool: update_event (CALW-02)
 *
 * Updates an existing calendar event by its UID. Modifies only the specified fields
 * while preserving all other properties (alarms, attendees, custom fields).
 */

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Logger } from 'pino';
import type { CalendarService } from '../../caldav/calendar-service.js';
import { ConflictError } from '../../errors.js';
import { getMasterVevent, updateICalString, createExceptionVevent } from '../../transformers/event-builder.js';
import { parseWriteDate } from './utils.js';
import ICAL from 'ical.js';


/** True when the event is a recurring series or an occurrence of one. */
function isRecurringResource(event: { isRecurring: boolean; _raw: string }): boolean {
  return event.isRecurring || /^(RRULE|RDATE|RECURRENCE-ID)[:;]/m.test(event._raw);
}

/**
 * Register the update_event tool
 *
 * @param server - MCP server instance
 * @param calendarService - Calendar service for updating events
 * @param logger - Pino logger
 * @param defaultCalendar - Optional default calendar name from config
 */
export function registerUpdateEventTool(
  server: McpServer,
  calendarService: CalendarService,
  logger: Logger,
  defaultCalendar?: string,
  recurringWrites = true,
  userTimezone?: string,
): void {
  server.tool(
    'update_event',
    'Update an existing calendar event by UID. Modifies only the specified fields while preserving all other properties (alarms, attendees, custom fields). For recurring events, you can modify a single occurrence by specifying instanceDate. IMPORTANT: For recurring events, ask the user "Do you want to update this occurrence only, or all events in the series?" before proceeding. Confirm with the user before proceeding. Show the user what will change and ask them to confirm before updating.',
    {
      uid: z.string().describe('The UID of the event to update. Use search_events or get_todays_schedule to find event UIDs.'),
      title: z.string().optional().describe('New event title/summary'),
      start: z.string().optional().describe('New start date/time. Supports natural language (e.g., "tomorrow at 3pm") or ISO 8601 format.'),
      end: z.string().optional().describe('New end date/time. Supports natural language or ISO 8601 format.'),
      description: z.string().optional().describe('New event description'),
      location: z.string().optional().describe('New event location'),
      calendar: z.string().optional().describe(
        'Calendar name to search in. Use "all" to search all calendars. ' +
        (defaultCalendar ? `Defaults to "${defaultCalendar}".` : 'Defaults to all calendars.')
      ),
      instanceDate: z.string().optional().describe(
        'For recurring events only: the specific occurrence date to modify (e.g., "2026-02-05", "Tuesday"). ' +
        'When provided, only that occurrence is changed (creates exception). ' +
        'When omitted, the ENTIRE recurring series is modified.'
      ),
    },
    {
      readOnlyHint: false,
      destructiveHint: true,
      openWorldHint: true,
    },
    async (params) => {
      try {
        logger.debug({ params }, 'update_event called');

        // Check that at least one field to update is provided
        if (
          params.title === undefined &&
          params.start === undefined &&
          params.end === undefined &&
          params.description === undefined &&
          params.location === undefined
        ) {
          return {
            content: [
              {
                type: 'text' as const,
                text: 'No changes specified. Provide at least one field to update (title, start, end, description, location).',
              },
            ],
            isError: true,
          };
        }

        // Resolve target calendar
        const resolvedCalendar = params.calendar === 'all'
          ? undefined
          : (params.calendar || defaultCalendar || undefined);

        // Find event by UID
        const event = await calendarService.findEventByUid(params.uid, resolvedCalendar);
        if (!event) {
          return {
            content: [
              {
                type: 'text' as const,
                text: `Event not found with UID: ${params.uid}`,
              },
            ],
            isError: true,
          };
        }

        // Recurring events are out of scope when DAV_RECURRING_WRITES=false
        if (!recurringWrites && (params.instanceDate !== undefined || isRecurringResource(event))) {
          return {
            content: [
              {
                type: 'text' as const,
                text: `Cannot modify "${event.summary}": recurring events and their occurrences are not supported by this server configuration (DAV_RECURRING_WRITES=false). Ask the user to do it in the Twake Calendar web app.`,
              },
            ],
            isError: true,
          };
        }

        // Parse date updates if provided
        let newStartDate: Date | undefined;
        let newEndDate: Date | undefined;

        if (params.start !== undefined) {
          newStartDate = parseWriteDate(params.start, userTimezone) ?? undefined;
          if (!newStartDate) {
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

        if (params.end !== undefined) {
          newEndDate = parseWriteDate(params.end, userTimezone) ?? undefined;
          if (!newEndDate) {
            return {
              content: [
                {
                  type: 'text' as const,
                  text: `Could not parse end date: "${params.end}". Please use natural language (e.g., "tomorrow at 2pm") or ISO 8601 format.`,
                },
              ],
              isError: true,
            };
          }
        }

        // Validate: if start is updated but end is not, check that new start is not after existing end
        if (newStartDate !== undefined && newEndDate === undefined) {
          if (newStartDate > event.endDate) {
            return {
              content: [
                {
                  type: 'text' as const,
                  text: `New start time is after the existing end time. Please also update the end time.`,
                },
              ],
              isError: true,
            };
          }
        }

        // Validate: if both start and end are updated, check that end is after start
        if (newStartDate !== undefined && newEndDate !== undefined) {
          if (newEndDate <= newStartDate) {
            return {
              content: [
                {
                  type: 'text' as const,
                  text: `End date must be after start date. Start: ${newStartDate.toLocaleString()}, End: ${newEndDate.toLocaleString()}`,
                },
              ],
              isError: true,
            };
          }
        }

        // Handle single instance modification for recurring events
        if (params.instanceDate !== undefined) {
          // Validate event is recurring
          if (!event.isRecurring) {
            return {
              content: [{
                type: 'text' as const,
                text: `Cannot use instanceDate on non-recurring event. This event does not repeat.`,
              }],
              isError: true,
            };
          }

          const parsedInstanceDate = parseWriteDate(params.instanceDate, userTimezone);
          if (!parsedInstanceDate) {
            return {
              content: [{
                type: 'text' as const,
                text: `Could not parse instanceDate: "${params.instanceDate}". Use natural language (e.g., "Tuesday", "next Friday") or ISO 8601 format.`,
              }],
              isError: true,
            };
          }

          // Build changes object for exception
          const exceptionChanges: {
            title?: string;
            start?: Date;
            end?: Date;
            description?: string;
            location?: string;
          } = {};

          if (params.title !== undefined) {
            exceptionChanges.title = params.title;
          }
          if (newStartDate !== undefined) {
            exceptionChanges.start = newStartDate;
          }
          if (newEndDate !== undefined) {
            exceptionChanges.end = newEndDate;
          }
          if (params.description !== undefined) {
            exceptionChanges.description = params.description;
          }
          if (params.location !== undefined) {
            exceptionChanges.location = params.location;
          }

          // Create exception VEVENT (cloneAlarms defaults to true - RINST-03)
          const updatedICalString = createExceptionVevent(
            event._raw,
            parsedInstanceDate,
            exceptionChanges
            // cloneAlarms: true is the default - preserves VALARMs from master
          );

          // VALARM verification (RINST-03 defensive check)
          const jCalData = ICAL.parse(updatedICalString);
          const comp = new ICAL.Component(jCalData);
          const vevents = comp.getAllSubcomponents('vevent');

          // Find master and exception
          const masterVevent = vevents.find(v => !v.getFirstProperty('recurrence-id'));
          const exceptionVevent = vevents.find(v => v.getFirstProperty('recurrence-id'));

          if (masterVevent && exceptionVevent) {
            const masterAlarmCount = masterVevent.getAllSubcomponents('valarm').length;
            const exceptionAlarmCount = exceptionVevent.getAllSubcomponents('valarm').length;
            if (masterAlarmCount > 0 && exceptionAlarmCount !== masterAlarmCount) {
              logger.warn(
                { masterAlarmCount, exceptionAlarmCount },
                'VALARM count mismatch - alarms may not have been cloned correctly'
              );
            }
          }

          // Check for attendees and prepare warning
          let attendeeWarning = '';
          if (event.attendees.length > 0) {
            const attendeeList = event.attendees.join(', ');
            attendeeWarning = `\n\nNote: This event has attendees (${attendeeList}). The server may send update notifications.`;
          }

          // Update event with exception added
          await calendarService.updateEvent(event.url, updatedICalString, event.etag!);

          // Build list of changed fields for response
          const changedFields: string[] = [];
          if (params.title !== undefined) {
            changedFields.push(`title: "${params.title}"`);
          }
          if (params.start !== undefined) {
            changedFields.push(`start: ${newStartDate!.toLocaleString()}`);
          }
          if (params.end !== undefined) {
            changedFields.push(`end: ${newEndDate!.toLocaleString()}`);
          }
          if (params.description !== undefined) {
            changedFields.push(`description: "${params.description}"`);
          }
          if (params.location !== undefined) {
            changedFields.push(`location: "${params.location}"`);
          }

          logger.info(
            { uid: params.uid, instanceDate: parsedInstanceDate.toISOString(), changes: changedFields },
            'Single occurrence modified (exception created)'
          );

          return {
            content: [{
              type: 'text' as const,
              text: `Occurrence modified: ${event.summary} on ${parsedInstanceDate.toLocaleDateString()}\nChanges: ${changedFields.join(', ')}\n\nOnly this occurrence was updated; the rest of the series is unchanged.${attendeeWarning}`,
            }],
          };
        }

        // RRULE safety check: store original RRULE if event is recurring
        let originalRrule: string | undefined;
        if (event.isRecurring) {
          originalRrule = event.recurrenceRule;
        }

        // Build UpdateEventInput object
        const changes: {
          title?: string;
          start?: Date;
          end?: Date;
          description?: string;
          location?: string;
        } = {};

        if (params.title !== undefined) {
          changes.title = params.title;
        }
        if (newStartDate !== undefined) {
          changes.start = newStartDate;
        }
        if (newEndDate !== undefined) {
          changes.end = newEndDate;
        }
        if (params.description !== undefined) {
          changes.description = params.description;
        }
        if (params.location !== undefined) {
          changes.location = params.location;
        }

        // Apply parse-modify-serialize on _raw
        const updatedICalString = updateICalString(event._raw, changes);

        // RRULE verification: if event was recurring, verify RRULE is preserved
        if (event.isRecurring) {
          const jCalData = ICAL.parse(updatedICalString);
          const comp = new ICAL.Component(jCalData);
          const vevent = getMasterVevent(comp);

          if (!vevent) {
            throw new Error('VEVENT component missing after update. This is a bug -- please report it.');
          }

          const rruleProp = vevent.getFirstProperty('rrule');
          if (!rruleProp) {
            throw new Error('RRULE was lost during update. This is a bug -- please report it.');
          }
        }

        // Check for attendees and prepare warning
        let attendeeWarning = '';
        if (event.attendees.length > 0) {
          const attendeeList = event.attendees.join(', ');
          attendeeWarning = `\n\nNote: This event has attendees (${attendeeList}). The server may send update notifications to all attendees.`;
        }

        // Update event using etag for optimistic concurrency
        await calendarService.updateEvent(event.url, updatedICalString, event.etag!);

        // Build list of changed fields for response
        const changedFields: string[] = [];
        if (params.title !== undefined) {
          changedFields.push(`title: "${params.title}"`);
        }
        if (params.start !== undefined) {
          changedFields.push(`start: ${newStartDate!.toLocaleString()}`);
        }
        if (params.end !== undefined) {
          changedFields.push(`end: ${newEndDate!.toLocaleString()}`);
        }
        if (params.description !== undefined) {
          changedFields.push(`description: "${params.description}"`);
        }
        if (params.location !== undefined) {
          changedFields.push(`location: "${params.location}"`);
        }

        const responseText = `Event updated successfully: ${event.summary}\nChanges: ${changedFields.join(', ')}${attendeeWarning}`;

        logger.info({ uid: params.uid, url: event.url }, 'Event updated successfully');

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
          logger.warn({ uid: params.uid }, 'Conflict during update');
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
        logger.error({ err }, 'Error in update_event');
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
