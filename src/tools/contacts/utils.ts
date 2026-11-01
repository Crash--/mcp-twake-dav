/**
 * Shared contact query utilities
 *
 * Purpose: Provides search, formatting, and data-fetching utilities used by all
 * Phase 5 contact MCP tools.
 *
 * Key capabilities:
 * - Contact formatting for LLM-optimized output
 * - Pages across address books
 */

import { z } from 'zod';
import type { Logger } from 'pino';
import type { DAVVCard } from 'tsdav';
import type { ContactDTO } from '../../types/dtos.js';
import type { ContactCursor } from '../../caldav/addressbook-service.js';
import { transformVCard } from '../../transformers/contact.js';

/**
 * Format contact as concise multi-line text for LLM consumption
 *
 * Prioritizes most useful fields: name, emails, phones, organization.
 * Omits internal metadata (url, etag, _raw, version, uid) for token efficiency.
 *
 * Example output:
 * Marie Dupont
 *   Email: marie.dupont@example.com
 *   Phone: +33 1 23 45 67 89
 *   Organization: LINAGORA
 *
 * @param contact - ContactDTO to format
 * @returns Multi-line formatted contact string
 */
export function formatContact(contact: ContactDTO): string {
  const lines: string[] = [];

  // Line 1: Name (prefer formatted name, fall back to "given family")
  const displayName = contact.name.formatted
    || [contact.name.given, contact.name.family].filter(Boolean).join(' ')
    || '(No name)';
  lines.push(displayName);

  // Line 2: UID (needed for update_contact/delete_contact)
  lines.push(`  UID: ${contact.uid}`);

  // Line 3+: Emails (indented)
  if (contact.emails.length > 0) {
    contact.emails.forEach(email => {
      lines.push(`  Email: ${email}`);
    });
  }

  // Phones (indented)
  if (contact.phones.length > 0) {
    contact.phones.forEach(phone => {
      lines.push(`  Phone: ${phone}`);
    });
  }

  // Organization (indented, if present)
  if (contact.organization) {
    lines.push(`  Organization: ${contact.organization}`);
  }

  return lines.join('\n');
}

/**
 * Format contact as single-line summary (for list views)
 *
 * Example: "Marie Dupont <marie.dupont@example.com> - LINAGORA"
 *
 * @param contact - ContactDTO to format
 * @returns Single-line contact summary
 */
export function formatContactSummary(contact: ContactDTO): string {
  const name = contact.name.formatted
    || [contact.name.given, contact.name.family].filter(Boolean).join(' ')
    || '(No name)';

  const email = contact.emails.length > 0 ? ` <${contact.emails[0]}>` : '';
  const org = contact.organization ? ` - ${contact.organization}` : '';

  return `${name}${email}${org}`;
}

export const DEFAULT_CONTACT_LIMIT = 30;

export const contactPageParams = {
  limit: z.number().int().min(1).max(100).optional().describe(
    `Maximum number of contacts to return (default ${DEFAULT_CONTACT_LIMIT}, maximum 100).`
  ),
  cursor: z.object({
    book: z.number().int().min(0),
    offset: z.number().int().min(0),
    version: z.string().optional(),
  }).optional().describe('The nextCursor of the previous response. Repeat the same filters with it.'),
};

/**
 * Which address book to read. "all" and no default mean every address book.
 *
 * @returns The address book name, or undefined for all of them
 */
export function resolveAddressBookName(
  addressbookParam: string | undefined,
  defaultAddressBook: string | undefined,
): string | undefined {
  return addressbookParam === 'all' ? undefined : (addressbookParam || defaultAddressBook);
}

export function toContacts(vcards: DAVVCard[], logger: Logger): ContactDTO[] {
  return vcards
    .map(vcard => transformVCard(vcard as any, logger))
    .filter((contact): contact is ContactDTO => contact !== null);
}

/** The last lines of a page: the model must never read a page as the whole result. */
export function formatContactFooter(nextCursor: ContactCursor | null): string {
  return nextCursor
    ? `\n\nMore contacts remain. To continue, call again with the same filters and pass this value as cursor:\nnextCursor: ${JSON.stringify(nextCursor)}`
    : '\n\nNo more contacts.';
}
