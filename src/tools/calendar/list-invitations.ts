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

const DAY_MS = 86_400_000;
const DEFAULT_WINDOW_DAYS = 7;
const MAX_WINDOW_DAYS = 92;

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
      start: z.string().datetime({ offset: true }).optional().describe('Start of the range, ISO 8601 with an offset. Defaults to now.'),
      end: z.string().datetime({ offset: true }).optional().describe(`End of the range, ISO 8601 with an offset. Defaults to ${DEFAULT_WINDOW_DAYS} days after the start.`),
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

        const startMs = params.start ? Date.parse(params.start) : Date.now();
        const endMs = params.end ? Date.parse(params.end) : startMs + DEFAULT_WINDOW_DAYS * DAY_MS;
        if (endMs <= startMs || endMs - startMs > MAX_WINDOW_DAYS * DAY_MS) {
          return {
            content: [{
              type: 'text' as const,
              text: `The end of the date range must be after its start, ${MAX_WINDOW_DAYS} days at most. Ask for the following days in another call.`,
            }],
            isError: true,
          };
        }

        // Query pending invitations
        const pending = await calendarService.listPendingInvitations({
          start: new Date(startMs).toISOString(),
          end: new Date(endMs).toISOString(),
        });
        const limit = params.limit ?? 30;
        const offset = params.offset ?? 0;
        const invitations = pending.slice(offset, offset + limit);
        const nextOffset = pending.length > offset + limit ? offset + limit : null;

        if (invitations.length === 0) {
          logger.info('No pending invitations found');
          return {
            content: [{
              type: 'text' as const,
              text: `No pending invitations between ${new Date(startMs).toISOString()} and ${new Date(endMs).toISOString()}.`,
            }],
          };
        }

        // Format invitations for display
        const displayTimezone = userTimezone || Intl.DateTimeFormat().resolvedOptions().timeZone;
        const formatted = invitations.map((inv) => {
          const startStr = inv.proposedStart.toLocaleString('en-US', { timeZone: displayTimezone });
          const endStr = inv.proposedEnd.toLocaleString('en-US', { timeZone: displayTimezone });
          const location = inv.location ? `\n  Location: ${inv.location}` : '';

          return `- ${inv.summary}
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
