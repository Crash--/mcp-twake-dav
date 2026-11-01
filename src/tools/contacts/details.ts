/**
 * MCP tool: get_contact_details (CON-02)
 *
 * Get full details for a specific contact by name.
 */

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Logger } from 'pino';
import type { AddressBookService } from '../../caldav/addressbook-service.js';
import {
  contactPageParams,
  resolveAddressBookName,
  toContacts,
  formatContactFooter,
  DEFAULT_CONTACT_LIMIT,
  formatContact,
} from './utils.js';

/**
 * Register the get_contact_details tool
 *
 * @param server - MCP server instance
 * @param addressBookService - AddressBook service for fetching contacts
 * @param logger - Pino logger
 */
export function registerGetContactDetailsTool(
  server: McpServer,
  addressBookService: AddressBookService,
  logger: Logger,
  defaultAddressBook?: string,
): void {
  server.tool(
    'get_contact_details',
    'Get full details for a specific contact by name, one page of matches at a time. Returns detailed contact information including all email addresses, phone numbers, and organization. When the response has a nextCursor, more contacts match. Optionally filter by address book.',
    {
      name: z.string().describe('Contact name to look up (case-insensitive, partial match)'),
      ...contactPageParams,
      addressbook: z.string().optional().describe(
        'Address book name to search in. Use "all" to search all address books. ' +
        (defaultAddressBook ? `Defaults to "${defaultAddressBook}".` : 'Defaults to all address books.')
      ),
    },
    {
      readOnlyHint: true,
      destructiveHint: false,
      openWorldHint: true,
    },
    async (params) => {
      try {
        logger.debug({ params }, 'get_contact_details called');

        const { vcards, nextCursor } = await addressBookService.searchContactsPage(
          resolveAddressBookName(params.addressbook, defaultAddressBook),
          { name: params.name },
          params.limit ?? DEFAULT_CONTACT_LIMIT,
          params.cursor,
        );
        const matchingContacts = toContacts(vcards, logger);

        if (matchingContacts.length === 0) {
          logger.info({ name: params.name }, 'No contact found');
          return {
            content: [
              {
                type: 'text' as const,
                text: `No contact found matching "${params.name}"`,
              },
            ],
          };
        }

        // Format all matches (let user disambiguate if multiple)
        const formattedContacts = matchingContacts
          .map((contact) => formatContact(contact))
          .join('\n\n');

        const result = matchingContacts.length === 1 && !nextCursor
          ? `Contact details for ${matchingContacts[0].name.formatted || [matchingContacts[0].name.given, matchingContacts[0].name.family].filter(Boolean).join(' ') || '(No name)'}:\n\n${formattedContacts}`
          : `Found ${matchingContacts.length} contacts matching "${params.name}" in this page:\n\n${formattedContacts}${formatContactFooter(nextCursor)}`;

        logger.info({ name: params.name, count: matchingContacts.length }, 'Contact details retrieved');

        return {
          content: [
            {
              type: 'text' as const,
              text: result,
            },
          ],
        };
      } catch (err) {
        logger.error({ err }, 'Error in get_contact_details');
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
