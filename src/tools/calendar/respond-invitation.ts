/**
 * MCP tool: respond_to_invitation (INV-02, INV-03, INV-04)
 *
 * Respond to a calendar invitation by updating participation status.
 * Supports accept, decline, and tentative responses.
 */

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Logger } from 'pino';
import type { CalendarService } from '../../caldav/calendar-service.js';
import { ConflictError } from '../../errors.js';
import type { InvitationDTO } from '../../types/dtos.js';

/**
 * Register the respond_to_invitation tool
 *
 * @param server - MCP server instance
 * @param calendarService - Calendar service for responding to invitations
 * @param logger - Pino logger
 */
export function registerRespondInvitationTool(
  server: McpServer,
  calendarService: CalendarService,
  logger: Logger,
  userTimezone?: string,
): void {
  server.tool(
    'respond_to_invitation',
    'Respond to a calendar invitation by updating your participation status. ' +
    'IMPORTANT: Always confirm with the user before responding. ' +
    'Show them the invitation details (organizer, title, time) and ask: ' +
    '"Do you want to accept/decline/mark tentative for this invitation?"',
    {
      uid: z.string().describe('The UID of the invitation to respond to. Use list_invitations to find UIDs.'),
      response: z.enum(['accept', 'decline', 'tentative']).describe(
        'Your response: "accept" confirms attendance, "decline" refuses, "tentative" indicates uncertainty'
      ),
    },
    {
      readOnlyHint: false,
      destructiveHint: true,
      openWorldHint: true,
    },
    async (params) => {
      try {
        logger.debug({ params }, 'respond_to_invitation called');

        // Map response to PARTSTAT value
        const partstatMap: Record<string, 'ACCEPTED' | 'DECLINED' | 'TENTATIVE'> = {
          accept: 'ACCEPTED',
          decline: 'DECLINED',
          tentative: 'TENTATIVE',
        };
        const partstat = partstatMap[params.response];

        // Respond to invitation
        const invitation = await calendarService.respondToInvitation(params.uid, partstat, userTimezone);

        // Build response message
        const responseText = buildResponseMessage(invitation, params.response, partstat, userTimezone);

        logger.info(
          { uid: params.uid, response: partstat },
          'Successfully responded to invitation'
        );

        return {
          content: [{
            type: 'text' as const,
            text: responseText,
          }],
        };
      } catch (err) {
        // Handle ConflictError specifically
        if (err instanceof ConflictError) {
          logger.warn({ uid: params.uid }, 'Conflict during invitation response');
          return {
            content: [{
              type: 'text' as const,
              text: 'This invitation was modified while you were responding. The organizer may have updated the event. Please check list_invitations again and retry.',
            }],
            isError: true,
          };
        }

        // Handle other errors
        logger.error({ err }, 'Error in respond_to_invitation');
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

/**
 * Build a user-friendly response message
 */
function buildResponseMessage(
  invitation: InvitationDTO,
  response: string,
  partstat: string,
  userTimezone?: string,
): string {
  const actionVerb: Record<string, string> = {
    accept: 'accepted',
    decline: 'declined',
    tentative: 'marked as tentative',
  };
  const action = actionVerb[response] || response;

  const startStr = invitation.proposedStart.toLocaleString('en-US', { timeZone: userTimezone });
  const endStr = invitation.proposedEnd.toLocaleString('en-US', { timeZone: userTimezone });

  const { organizer, userIsOrganizer, hasExceptions } = invitation;
  const notice = !organizer.email || userIsOrganizer
    ? 'Your response is saved on your copy of the event.'
    : hasExceptions
    ? 'Your response is saved on your copy of the event. The server sends it to the organizer, who may not see it on the occurrences changed in this series.'
    : 'Your response is saved on your copy of the event, and the server sends it to the organizer.';

  return `Invitation ${action}!\n\n` +
    `Event: ${invitation.summary}\n` +
    (organizer.email ? `Organizer: ${organizer.name} <${organizer.email}>\n` : '') +
    `When: ${startStr} - ${endStr}\n` +
    `Your status: ${partstat}\n\n` +
    notice;
}
