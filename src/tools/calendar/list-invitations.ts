/**
 * MCP tool: list_invitations (INV-01)
 *
 * Lists pending calendar invitations awaiting user response (PARTSTAT=NEEDS-ACTION).
 * Shows organizer, event title, proposed time, and location.
 */

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Logger } from 'pino';
import type { CalendarService } from '../../caldav/calendar-service.js';
import { checkWindow, parseDateRange, DEFAULT_WINDOW_DAYS, ISO_DATE_HELP, MAX_WINDOW_DAYS } from './utils.js';

/**
 * Register the list_invitations tool
 *
 * @param server - MCP server instance
 * @param calendarService - Calendar service for querying invitations
 * @param logger - Pino logger
 * @param userTimezone - Optional user timezone for date formatting
 */
export function registerListInvitationsTool(
  server: McpServer,
  calendarService: CalendarService,
  logger: Logger,
  userTimezone?: string,
): void {
  server.tool(
    'list_invitations',
    `List pending calendar invitations awaiting your response, for events in a date range (the next ${DEFAULT_WINDOW_DAYS} days by default, ${MAX_WINDOW_DAYS} days at most). Shows organizer, event title, proposed time, and location for each invitation that needs a response (PARTSTAT=NEEDS-ACTION). When the response has a nextOffset, more invitations remain. After listing, ask the user: "Would you like to accept or decline any of these?"`,
    {
      start: z.string().optional().describe(`Start of the range, defaults to now. ${ISO_DATE_HELP}`),
      end: z.string().optional().describe(`End of the range, a date alone includes that whole day. Defaults to ${DEFAULT_WINDOW_DAYS} days after the start.`),
      limit: z.number().int().min(1).max(100).optional().describe('Maximum number of invitations to return (default 30, maximum 100).'),
      offset: z.number().int().min(0).optional().describe('The nextOffset of the previous response. Repeat the same dates with it.'),
    },
    {
      readOnlyHint: true,
      destructiveHint: false,
      openWorldHint: true,
    },
    async (params) => {
      try {
        logger.debug({ params }, 'list_invitations called');

        const timeRange = parseDateRange(params.start, params.end, DEFAULT_WINDOW_DAYS, userTimezone);
        if ('problem' in timeRange) {
          return { content: [{ type: 'text' as const, text: timeRange.problem }], isError: true };
        }
        const windowProblem = checkWindow(timeRange);
        if (windowProblem) {
          return { content: [{ type: 'text' as const, text: windowProblem }], isError: true };
        }

        // Query pending invitations
        const pending = await calendarService.listPendingInvitations(timeRange, userTimezone);
        const limit = params.limit ?? 30;
        const offset = params.offset ?? 0;
        const invitations = pending.slice(offset, offset + limit);
        const nextOffset = pending.length > offset + limit ? offset + limit : null;

        if (invitations.length === 0) {
          logger.info('No pending invitations found');
          return {
            content: [{
              type: 'text' as const,
              text: `No pending invitations between ${timeRange.start} and ${timeRange.end}.`,
            }],
          };
        }

        // Format invitations for display
        const displayTimezone = userTimezone || Intl.DateTimeFormat().resolvedOptions().timeZone;
        const formatted = invitations.map((inv) => {
          const startStr = inv.proposedStart.toLocaleString('en-US', { timeZone: displayTimezone });
          const endStr = inv.proposedEnd.toLocaleString('en-US', { timeZone: displayTimezone });
          const location = inv.location ? `\n  Location: ${inv.location}` : '';

          return `- ${inv.summary}${inv.isOccurrence ? ' (one occurrence of a series)' : ''}
  Organizer: ${inv.organizer.name} <${inv.organizer.email}>
  When: ${startStr} - ${endStr}${location}
  UID: ${inv.uid}`;
        }).join('\n\n');

        const footer = nextOffset === null
          ? '\n\nNo more invitations in this range.'
          : `\n\nMore invitations remain. To continue, call again with the same dates and:\nnextOffset: ${nextOffset}`;
        const result = `Pending invitations (${invitations.length} in this page):\n\n${formatted}${footer}`;

        logger.info({ count: invitations.length }, 'Listed pending invitations');

        return {
          content: [{
            type: 'text' as const,
            text: result,
          }],
        };
      } catch (err) {
        logger.error({ err }, 'Error in list_invitations');
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
