/**
 * MCP tool: list_contacts (CON-03)
 *
 * List all contacts from all address books with truncation protection.
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
  formatContactSummary,
} from './utils.js';

/**
 * Register the list_contacts tool
 *
 * @param server - MCP server instance
 * @param addressBookService - AddressBook service for fetching contacts
 * @param logger - Pino logger
 */
export function registerListContactsTool(
  server: McpServer,
  addressBookService: AddressBookService,
  logger: Logger,
  defaultAddressBook?: string,
): void {
  server.tool(
    'list_contacts',
    'List contacts from address books, one page at a time. Shows a summary of each contact (name, email, organization). When the response has a nextCursor, more contacts remain. Use search_contacts to find a specific contact. Optionally filter by address book name.',
    {
      ...contactPageParams,
      addressbook: z.string().optional().describe(
        'Address book name to list from. Use "all" to list from all address books. ' +
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
        logger.debug('list_contacts called');

        const { vcards, nextCursor } = await addressBookService.listContactsPage(
          resolveAddressBookName(params.addressbook, defaultAddressBook),
          params.limit ?? DEFAULT_CONTACT_LIMIT,
          params.cursor,
        );
        const contacts = toContacts(vcards, logger);

        if (contacts.length === 0) {
          logger.info('No contacts found');
          return {
            content: [
              {
                type: 'text' as const,
                text: 'No contacts found in any address book',
              },
            ],
          };
        }

        // Format as single-line summaries
        const formattedContacts = contacts
          .map((contact) => formatContactSummary(contact))
          .join('\n');

        const result = `Contacts (${contacts.length} in this page):\n\n${formattedContacts}${formatContactFooter(nextCursor)}`;

        logger.info({ displayed: contacts.length, more: !!nextCursor }, 'Contacts listed');

        return {
          content: [
            {
              type: 'text' as const,
              text: result,
            },
          ],
        };
      } catch (err) {
        logger.error({ err }, 'Error in list_contacts');
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
