/**
 * AddressBook Service for CardDAV operations
 *
 * Purpose: Fetch address books and vCards with CTag-based caching and retry logic.
 * This service mirrors CalendarService for the CardDAV side, wrapping tsdav's
 * addressbook operations with caching and retry, implementing multi-addressbook
 * aggregation. Returns raw DAVVCard arrays -- transformation into ContactDTOs
 * happens in Phase 5's query layer.
 */

import { randomUUID } from 'node:crypto';
import type { Logger } from 'pino';
import type { DAVAddressBook, DAVVCard } from 'tsdav';
import ICAL from 'ical.js';
import { freshAuthHeaders, type DAVClientType } from './client.js';
import type { Config } from '../config/schema.js';
import { CollectionCache } from './cache.js';
import { hasPartialRead } from './dav-fetch.js';
import { davFetch } from './href-prefix.js';
import { withRetry } from './retry.js';
import { discoverAddressBooks } from './discovery.js';
import { ConflictError, DavHttpError, isDavUnsupported } from '../errors.js';
import { transformVCard } from '../transformers/contact.js';
import type { ContactDTO } from '../types/dtos.js';

/**
 * Get the display name of an address book, with fallback to URL segment
 *
 * @param ab - Address book object
 * @returns Display name or last URL segment
 */
function getAddressBookName(ab: DAVAddressBook): string {
  if (typeof ab.displayName === 'string' && ab.displayName.trim() !== '') {
    return ab.displayName;
  }
  // Extract last non-empty path segment from URL as fallback
  const segments = ab.url.replace(/\/+$/, '').split('/');
  const lastSegment = segments[segments.length - 1] || '';
  return lastSegment ? decodeURIComponent(lastSegment) : ab.url;
}

function textFilter(name: string, value: string, matchType = 'contains') {
  return {
    _attributes: { name },
    'text-match': { _attributes: { collation: 'i;unicode-casemap', 'match-type': matchType }, _text: value },
  };
}

/** Where the next page starts: an index in the list of address books and a position in that book. */
export interface ContactCursor {
  book: number;
  offset: number;
}

export interface ContactPage {
  vcards: DAVVCard[];
  nextCursor: ContactCursor | null;
}

type ReadBook = (book: DAVAddressBook, offset: number, count: number) => Promise<{ vcards: DAVVCard[]; hasMore: boolean }>;

async function walkBooks(books: DAVAddressBook[], limit: number, cursor: ContactCursor | undefined, read: ReadBook): Promise<ContactPage> {
  const vcards: DAVVCard[] = [];
  let offset = cursor?.offset ?? 0;
  for (let book = cursor?.book ?? 0; book < books.length; book++) {
    const page = await read(books[book], offset, limit - vcards.length);
    vcards.push(...page.vcards);
    if (page.hasMore) return { vcards, nextCursor: { book, offset: offset + page.vcards.length } };
    if (vcards.length === limit) {
      return { vcards, nextCursor: book + 1 < books.length ? { book: book + 1, offset: 0 } : null };
    }
    offset = 0;
  }
  return { vcards, nextCursor: null };
}

/**
 * AddressBook service with CTag-based caching and retry
 *
 * Provides methods to list address books and fetch contacts with automatic
 * caching based on CTag (collection entity tag). Multi-addressbook aggregation
 * supported via fetchAllContacts().
 */
export class AddressBookService {
  private readonly client: DAVClientType;
  private readonly logger: Logger;
  private readonly objectCache: CollectionCache<DAVVCard>;
  private addressBooks: DAVAddressBook[];
  private readonly config?: Config;
  private hasJsonApi: boolean | undefined = undefined;

  /**
   * Create a new AddressBookService
   *
   * @param client - CardDAV client instance (must have defaultAccountType: 'carddav')
   * @param logger - Pino logger for debug/info/error messages
   * @param config - Auth for the JSON API of the server, skipped without it
   */
  constructor(client: DAVClientType, logger: Logger, config?: Config) {
    this.client = client;
    this.logger = logger;
    this.config = config;
    this.objectCache = new CollectionCache<DAVVCard>(logger);
    this.addressBooks = [];
  }

  /**
   * List all address books (lazy initialization)
   *
   * Discovers address books on first call, then caches the list.
   * Use refreshAddressBooks() to force re-discovery.
   *
   * @returns Array of DAVAddressBook objects
   */
  async listAddressBooks(): Promise<DAVAddressBook[]> {
    // Lazy initialization: only discover if not already loaded
    if (this.addressBooks.length > 0) {
      return this.addressBooks;
    }

    // Discover with retry
    this.addressBooks = await withRetry(
      () => discoverAddressBooks(this.client, this.logger),
      this.logger
    );

    return this.addressBooks;
  }

  /**
   * Force re-discovery of address books
   *
   * Bypasses lazy cache and re-discovers from server. Clears object cache
   * since collection URLs may have changed.
   *
   * @returns Array of DAVAddressBook objects
   */
  async refreshAddressBooks(): Promise<DAVAddressBook[]> {
    // Always re-discover (bypass lazy cache)
    this.addressBooks = await withRetry(
      () => discoverAddressBooks(this.client, this.logger),
      this.logger
    );

    // Clear object cache since collections may have changed
    this.objectCache.clear();

    return this.addressBooks;
  }

  /**
   * Fetch contacts from a single address book
   *
   * Uses CTag-based caching to avoid unnecessary re-fetches. Falls back to
   * useMultiGet=false if initial fetch returns empty (SabreDAV compatibility).
   *
   * @param addressBook - Address book to fetch contacts from
   * @returns Array of DAVVCard objects (url, etag, data fields)
   */
  async fetchContacts(addressBook: DAVAddressBook): Promise<DAVVCard[]> {
    // Check if cached objects are fresh using CTag
    if (addressBook.ctag && this.objectCache.isFresh(addressBook.url, addressBook.ctag)) {
      this.logger.debug({ url: addressBook.url }, 'Using cached address book contacts (CTag match)');
      return this.objectCache.get(addressBook.url)!.objects;
    }

    // If cached entry exists, use isCollectionDirty to check server
    const cached = this.objectCache.get(addressBook.url);
    if (cached) {
      const { isDirty, newCtag } = await withRetry(
        () => this.client.isCollectionDirty({ collection: { ...addressBook, ctag: cached.ctag } }),
        this.logger
      );

      if (!isDirty) {
        this.logger.debug({ url: addressBook.url }, 'Address book unchanged (CTag match via server check)');
        return cached.objects;
      }

      this.logger.info(
        { url: addressBook.url, oldCtag: cached.ctag, newCtag },
        'Address book changed, re-fetching'
      );
    }

    // IMPORTANT FALLBACK (Research Pitfall 5): If vcards is empty or the server refuses, retry without multiGet
    // Some SabreDAV configurations don't support addressbook-multiget REPORT
    let vcards: DAVVCard[] = [];
    try {
      vcards = await withRetry(
        () => this.client.fetchVCards({ addressBook }),
        this.logger
      );
    } catch (err) {
      if (!isDavUnsupported(err)) throw err;
    }
    if (vcards.length === 0) {
      this.logger.info({ url: addressBook.url }, 'fetchVCards returned nothing, retrying without multiGet');
      vcards = await withRetry(
        () => this.client.fetchVCards({ addressBook, useMultiGet: false }),
        this.logger
      );
    }

    // Update cache
    if (!hasPartialRead()) this.objectCache.set(addressBook.url, addressBook.ctag ?? '', vcards);

    this.logger.info({ url: addressBook.url, count: vcards.length }, 'Fetched address book contacts');

    return vcards;
  }

  /**
   * Fetch contacts from a single address book identified by display name (case-insensitive)
   *
   * Looks up the address book by displayName among all discovered address books.
   *
   * @param name - Address book display name to match (case-insensitive)
   * @returns Array of DAVVCard from the matched address book
   * @throws Error if no address book has this name
   */
  async fetchContactsByAddressBookName(name: string): Promise<DAVVCard[]> {
    await this.listAddressBooks();
    const match = this.addressBooks.find(
      (ab) => getAddressBookName(ab).toLowerCase() === name.toLowerCase()
    );
    if (!match) {
      throw new Error(`Address book "${name}" not found.\n\nFix: Use list_addressbooks to see the available names.`);
    }
    return this.fetchContacts(match);
  }

  /**
   * Fetch contacts from ALL address books
   *
   * Aggregates contacts across all address books using parallel fetches.
   * Each address book uses its own CTag-based caching.
   *
   * @returns Flattened array of all DAVVCard objects
   */
  async fetchAllContacts(): Promise<DAVVCard[]> {
    // Ensure address books are loaded
    await this.listAddressBooks();

    // Fetch contacts from all address books in parallel
    const results = await Promise.all(
      this.addressBooks.map(ab => this.fetchContacts(ab))
    );

    // Flatten results
    const flattened = results.flat();

    this.logger.info(
      { addressBookCount: this.addressBooks.length, totalContacts: flattened.length },
      'Fetched contacts from all address books'
    );

    return flattened;
  }

  /**
   * Create a new contact in an address book
   *
   * Uses optimistic concurrency with If-None-Match: * to ensure no duplicate UID.
   * Invalidates cache after successful creation.
   *
   * @param vCardString - Complete vCard text (must include UID property)
   * @param addressBookName - Optional address book display name (case-insensitive)
   * @returns Object with created contact URL and ETag
   * @throws ConflictError if contact with same UID already exists (HTTP 412)
   * @throws Error if address book not found or creation fails
   */
  async createContact(
    vCardString: string,
    addressBookName?: string
  ): Promise<{ url: string; etag: string | undefined }> {
    // Resolve target address book
    let targetAddressBook: DAVAddressBook;
    if (addressBookName) {
      // Find by display name or URL segment (case-insensitive)
      await this.listAddressBooks();
      const match = this.addressBooks.find(
        (ab) => getAddressBookName(ab).toLowerCase() === addressBookName.toLowerCase()
      );
      if (!match) {
        throw new Error(`Address book "${addressBookName}" not found`);
      }
      targetAddressBook = match;
    } else {
      // Use first available address book
      const books = await this.listAddressBooks();
      targetAddressBook = books[0];
    }

    // Generate unique filename
    const filename = `${randomUUID()}.vcf`;

    // No retry: after a cut, the first write may have been applied and a second turns that into a failure.
    const response = await this.client.createVCard({
      addressBook: targetAddressBook,
      vCardString,
      filename,
    });

    // Check response status
    if (!response.ok) {
      if (response.status === 412) {
        throw new ConflictError(
          'contact',
          'A contact with this UID already exists. Use a different UID or update the existing contact.'
        );
      }
      throw new Error(`Failed to create contact: HTTP ${response.status}`);
    }

    // Extract ETag from response headers
    const etag = response.headers?.get('etag') ?? undefined;

    // Invalidate collection cache
    this.objectCache.invalidate(targetAddressBook.url);

    // Build result URL
    const url = new URL(filename, targetAddressBook.url).href;

    this.logger.info({ url, etag }, 'Created contact');

    return { url, etag };
  }

  /**
   * Update an existing contact
   *
   * Uses optimistic concurrency with If-Match: <etag> to prevent overwriting changes.
   * Invalidates cache after successful update.
   *
   * @param url - Contact URL (from ContactDTO.url)
   * @param vCardString - Complete updated vCard text
   * @param etag - Current ETag for optimistic concurrency
   * @returns Object with new ETag
   * @throws ConflictError if contact was modified by another client (HTTP 412)
   * @throws Error if update fails
   */
  async updateContact(
    url: string,
    vCardString: string,
    etag: string
  ): Promise<{ etag: string | undefined }> {
    // No retry: see createContact
    const response = await this.client.updateVCard({
      vCard: { url, data: vCardString, etag },
    });

    // Check response status
    if (!response.ok) {
      if (response.status === 412) {
        throw new ConflictError('contact');
      }
      throw new Error(`Failed to update contact: HTTP ${response.status}`);
    }

    // Extract new ETag from response headers
    const newEtag = response.headers?.get('etag') ?? undefined;

    // Invalidate collection cache (extract collection URL from contact URL)
    const collectionUrl = url.substring(0, url.lastIndexOf('/') + 1);
    this.objectCache.invalidate(collectionUrl);

    this.logger.info({ url, oldEtag: etag, newEtag }, 'Updated contact');

    return { etag: newEtag };
  }

  /**
   * Delete a contact
   *
   * Uses optimistic concurrency with If-Match: <etag> to prevent deleting modified contact.
   * If etag not provided, fetches fresh etag from server first.
   * Invalidates cache after successful deletion.
   *
   * @param url - Contact URL (from ContactDTO.url)
   * @param etag - Optional ETag for optimistic concurrency (fetched if missing)
   * @throws ConflictError if contact was modified by another client (HTTP 412)
   * @throws Error if contact not found or deletion fails
   */
  async deleteContact(url: string, etag?: string): Promise<void> {
    // If etag not provided, fetch fresh etag
    let resolvedEtag = etag;
    if (!resolvedEtag) {
      // Extract collection URL from contact URL
      const collectionUrl = url.substring(0, url.lastIndexOf('/') + 1);

      // Fetch all vCards from the collection
      const vcards = await withRetry(
        () => this.client.fetchVCards({
          addressBook: { url: collectionUrl } as DAVAddressBook,
        }),
        this.logger
      );

      // Find the matching contact
      const match = vcards.find((v) => v.url === url);
      if (!match || !match.etag) {
        throw new Error('Cannot delete: contact not found or ETag unavailable');
      }

      resolvedEtag = match.etag;
    }

    // No retry: see createContact
    const response = await this.client.deleteVCard({
      vCard: { url, etag: resolvedEtag },
    });

    // Check response status
    if (!response.ok) {
      if (response.status === 412) {
        throw new ConflictError('contact');
      }
      throw new Error(`Failed to delete contact: HTTP ${response.status}`);
    }

    // Invalidate collection cache
    const collectionUrl = url.substring(0, url.lastIndexOf('/') + 1);
    this.objectCache.invalidate(collectionUrl);

    this.logger.info({ url }, 'Deleted contact');
  }

  /**
   * Find a contact by UID across address books
   *
   * Searches for a contact with the specified UID in all address books (or specific one if provided).
   * Returns full ContactDTO with _raw, etag, and url fields.
   *
   * @param uid - Contact UID to search for
   * @param addressBookName - Optional address book display name to limit search
   * @returns ContactDTO if found, null otherwise
   */
  async findContactByUid(uid: string, addressBookName?: string): Promise<ContactDTO | null> {
    const filter = { 'prop-filter': textFilter('UID', uid, 'equals') };
    for (const addressBook of await this.resolveAddressBooks(addressBookName)) {
      for (const vcard of await this.queryAddressBook(addressBook, filter, 1)) {
        const contactDTO = transformVCard(vcard as { url: string; etag?: string; data: string }, this.logger);
        if (contactDTO && contactDTO.uid === uid) {
          this.logger.debug({ uid, url: contactDTO.url }, 'Found contact by UID');
          return contactDTO;
        }
      }
    }

    this.logger.debug({ uid }, 'Contact not found by UID');
    return null;
  }

  /**
   * One page of an address book, or of all of them.
   *
   * On Twake the server pages through its JSON API. On other servers the first
   * call reads the book once and later pages come from the CTag cache.
   */
  async listContactsPage(addressBookName: string | undefined, limit: number, cursor?: ContactCursor): Promise<ContactPage> {
    const books = await this.resolveAddressBooks(addressBookName);
    return walkBooks(books, limit, cursor, async (book, offset, count) => {
      const page = await this.readJsonPage(book, offset, count);
      if (page) return page;
      const all = await this.fetchContacts(book);
      return { vcards: all.slice(offset, offset + count), hasMore: all.length > offset + count };
    });
  }

  /**
   * One page of the contacts matching a search, filtered by the server.
   *
   * RFC 6352 limits a query to its first results and has no offset: each page asks for everything up to its end.
   */
  async searchContactsPage(
    addressBookName: string | undefined,
    search: { name?: string; organization?: string },
    limit: number,
    cursor?: ContactCursor,
  ): Promise<ContactPage> {
    const books = await this.resolveAddressBooks(addressBookName);
    const filter = search.name && search.organization
      ? { _attributes: { test: 'allof' }, 'prop-filter': [textFilter('FN', search.name), textFilter('ORG', search.organization)] }
      : search.name
      ? { _attributes: { test: 'anyof' }, 'prop-filter': [textFilter('FN', search.name), textFilter('N', search.name)] }
      : { 'prop-filter': textFilter('ORG', search.organization as string) };
    return walkBooks(books, limit, cursor, async (book, offset, count) => {
      const matches = await this.queryAddressBook(book, filter, offset + count + 1);
      return { vcards: matches.slice(offset, offset + count), hasMore: matches.length > offset + count };
    });
  }

  private async resolveAddressBooks(addressBookName?: string): Promise<DAVAddressBook[]> {
    const books = await this.listAddressBooks();
    if (!addressBookName) return books;
    const match = books.find((ab) => getAddressBookName(ab).toLowerCase() === addressBookName.toLowerCase());
    if (!match) {
      throw new Error(`Address book "${addressBookName}" not found.\n\nFix: Use list_addressbooks to see the available names.`);
    }
    return [match];
  }

  private async queryAddressBook(addressBook: DAVAddressBook, filter: object, maxResults: number): Promise<DAVVCard[]> {
    const responses = await withRetry(
      () => this.client.collectionQuery({
        url: addressBook.url,
        depth: '1',
        defaultNamespace: 'card' as never,
        body: {
          'addressbook-query': {
            _attributes: { 'xmlns:card': 'urn:ietf:params:xml:ns:carddav', 'xmlns:d': 'DAV:' },
            'd:prop': { 'd:getetag': {}, 'card:address-data': {} },
            filter,
            limit: { nresults: { _text: String(maxResults) } },
          },
        },
      }),
      this.logger
    );
    return responses.flatMap((res) => {
      if (!res.ok) throw new DavHttpError(res.status);
      const data = res.props?.addressData?._cdata ?? res.props?.addressData;
      return res.href && data
        ? [{ url: new URL(res.href, addressBook.url).href, etag: res.props?.getetag, data }]
        : [];
    });
  }

  /** @returns The page, or null if this server has no JSON API */
  private async readJsonPage(addressBook: DAVAddressBook, offset: number, count: number): Promise<{ vcards: DAVVCard[]; hasMore: boolean } | null> {
    if (!this.config || this.hasJsonApi === false) return null;
    const config = this.config;
    const url = `${addressBook.url.replace(/\/$/, '')}.json?limit=${count + 1}&offset=${offset}&sort=fn`;
    const response = await withRetry(
      async () => davFetch()(url, { method: 'GET', headers: { ...(await freshAuthHeaders(config)), accept: 'application/json' } }),
      this.logger
    );
    if (response.status === 401 || response.status >= 500) throw new DavHttpError(response.status);
    if (!response.ok || !/json/i.test(response.headers.get('content-type') ?? '')) {
      this.hasJsonApi = false;
      return null;
    }

    const items: Array<{ _links?: { self?: { href?: string } }; etag?: string; data?: unknown[] }> =
      JSON.parse(await response.text())._embedded?.['dav:item'] ?? [];
    const vcards = items.flatMap((item) => {
      const filename = item._links?.self?.href?.split('/').pop();
      return filename && item.data
        ? [{ url: new URL(filename, addressBook.url).href, etag: item.etag, data: new ICAL.Component(item.data).toString() }]
        : [];
    });
    return { vcards: vcards.slice(0, count), hasMore: items.length > count };
  }
}
