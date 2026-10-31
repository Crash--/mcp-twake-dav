/**
 * CalDAV calendar service with caching and retry
 *
 * Purpose: Implements requirements CAL-05 (list calendars) and CAL-06 (multi-calendar query)
 * by wrapping tsdav's calendar operations with CTag-based caching (INF-04) and retry logic.
 *
 * Returns raw DAVCalendarObject arrays -- transformation into EventDTOs happens in Phase 4.
 */

import type { Logger } from 'pino';
import { getCommandAuth, refreshCommandHeaders } from './client.js';
import type { DAVCalendar, DAVCalendarObject } from 'tsdav';
import type { DAVClientType } from './client.js';
import type { Config } from '../config/schema.js';
import { CollectionCache } from './cache.js';
import { withRetry } from './retry.js';
import { discoverCalendars } from './discovery.js';
import { randomUUID } from 'node:crypto';
import { ConflictError, DavHttpError } from '../errors.js';
import { addReadWarning, answersJson, hasPartialRead } from './dav-fetch.js';
import { davFetch } from './href-prefix.js';
import { transformCalendarObject } from '../transformers/event.js';
import { transformInvitation, type InboxResponse } from '../transformers/invitation.js';
import { updateAttendeePartstat } from '../transformers/event-builder.js';
import type { EventDTO, InvitationDTO } from '../types/dtos.js';

const DAY_MS = 86_400_000;
const CALENDAR_LIST_TTL_MS = 60_000;
const UID_SEARCH_YEARS = 2;
const YEAR_MS = 365 * DAY_MS;

/**
 * ISO 8601 time range for server-side calendar filtering
 */
export interface TimeRange {
  /** Start time in ISO 8601 format (e.g., "2024-01-01T00:00:00Z") */
  start: string;
  /** End time in ISO 8601 format (e.g., "2024-12-31T23:59:59Z") */
  end: string;
}

/**
 * CalDAV calendar service with CTag-based caching
 *
 * Provides methods to:
 * - List all calendars for the authenticated user (CAL-05)
 * - Fetch events from a single calendar with optional time-range filtering
 * - Fetch events from ALL calendars (CAL-06 multi-calendar aggregation)
 *
 * CTag-based caching:
 * - Full fetches (no timeRange) are cached by calendar URL + CTag
 * - Time-range queries bypass cache (server filters differently)
 * - Uses tsdav's isCollectionDirty for server-side CTag comparison
 *
 * Retry logic:
 * - All tsdav calls wrapped in withRetry() for network resilience
 */
export class CalendarService {
  private readonly client: DAVClientType;
  private readonly logger: Logger;
  private readonly config: Config;
  private readonly objectCache: CollectionCache<DAVCalendarObject>;
  private calendars: DAVCalendar[] = [];
  private calendarsListedAt = 0;
  private userEmails: string[] | undefined = undefined;
  private hasJsonApi: boolean | undefined = undefined;

  /**
   * Create a new CalendarService
   *
   * @param client - CalDAV client instance (defaultAccountType: 'caldav')
   * @param logger - Pino logger for info/debug/error messages
   * @param config - Validated configuration for auth header reconstruction
   */
  constructor(client: DAVClientType, logger: Logger, config: Config) {
    this.client = client;
    this.logger = logger;
    this.config = config;
    this.objectCache = new CollectionCache<DAVCalendarObject>(logger);
  }

  /**
   * Build authentication headers matching the configured auth method.
   *
   * Used to inject auth into standalone tsdav functions (e.g., freeBusyQuery)
   * that don't use the client's built-in auth.
   *
   * @returns Record with the appropriate authorization header
   */
  getAuthHeaders(): Record<string, string> {
    if (this.config.DAV_AUTH_METHOD === 'command') {
      // Shared mutable object, kept fresh by the client proxy (see caldav/client.ts)
      return getCommandAuth(this.config).headers;
    }
    if (this.config.DAV_AUTH_METHOD === 'bearer') {
      return { authorization: `Bearer ${this.config.DAV_TOKEN}` };
    }
    if (this.config.DAV_AUTH_METHOD === 'esntoken') {
      return { ESNToken: this.config.DAV_TOKEN! };
    }
    const basicToken = Buffer.from(
      `${this.config.DAV_USERNAME}:${this.config.DAV_PASSWORD}`
    ).toString('base64');
    return { authorization: `Basic ${basicToken}` };
  }

  /**
   * Auth headers for a standalone tsdav call, which does not go through the
   * client proxy that refreshes the command token.
   */
  async getFreshAuthHeaders(): Promise<Record<string, string>> {
    if (this.config.DAV_AUTH_METHOD === 'command') {
      return refreshCommandHeaders(this.config);
    }
    return this.getAuthHeaders();
  }

  /**
   * List all calendars for the authenticated user (CAL-05)
   *
   * Keeps the list for a minute: a calendar created after startup could otherwise
   * hold a meeting that check_availability never sees.
   *
   * @returns Array of DAVCalendar objects with url, displayName, ctag, etc.
   * @throws Error if discovery fails after retries
   */
  async listCalendars(): Promise<DAVCalendar[]> {
    const stale = this.calendarsListedAt > 0 && Date.now() - this.calendarsListedAt >= CALENDAR_LIST_TTL_MS;
    if (this.calendars.length > 0 && !stale) {
      this.logger.debug('Returning cached calendar list');
      return this.calendars;
    }

    // Discover calendars with retry
    this.calendars = await withRetry(
      () => discoverCalendars(this.client, this.logger),
      this.logger
    );
    this.calendarsListedAt = Date.now();

    return this.calendars;
  }

  /**
   * Force re-discovery of calendars (bypasses lazy cache)
   *
   * Use when calendar list may have changed on server.
   * Clears object cache since calendars may have been added/removed.
   *
   * @returns Array of DAVCalendar objects
   * @throws Error if discovery fails after retries
   */
  async refreshCalendars(): Promise<DAVCalendar[]> {
    this.logger.info('Refreshing calendar list');

    // Re-discover calendars with retry
    this.calendars = await withRetry(
      () => discoverCalendars(this.client, this.logger),
      this.logger
    );

    // Clear object cache since calendars may have changed
    this.objectCache.clear();

    return this.calendars;
  }

  /**
   * Fetch calendar objects (events) from a single calendar
   *
   * CTag-based caching strategy:
   * - If timeRange provided: always fetch from server (cache stores unfiltered data)
   * - If no timeRange and CTag matches: return cached objects
   * - If no timeRange and cached entry exists: use isCollectionDirty for server check
   * - Otherwise: fetch from server and cache (if no timeRange)
   *
   * @param calendar - DAVCalendar object with url and optional ctag
   * @param timeRange - Optional ISO 8601 time range for server-side filtering
   * @returns Array of DAVCalendarObject with url, etag, and data fields
   * @throws Error if fetch fails after retries
   */
  async fetchEvents(calendar: DAVCalendar, timeRange?: TimeRange): Promise<DAVCalendarObject[]> {
    // Time-range queries bypass cache (server filters differently)
    if (timeRange) {
      this.logger.debug({ url: calendar.url }, 'Skipping cache for time-range query');

      const objects = await this.queryTimeRange(calendar, timeRange);

      this.logger.info(
        { url: calendar.url, count: objects.length, timeRange },
        'Fetched calendar objects with time range'
      );

      return objects;
    }

    // Check if cached objects are fresh using CTag
    if (calendar.ctag && this.objectCache.isFresh(calendar.url, calendar.ctag)) {
      this.logger.debug({ url: calendar.url }, 'Using cached calendar objects (CTag match)');
      return this.objectCache.get(calendar.url)!.objects;
    }

    // If we have a cached entry, use isCollectionDirty for server-side CTag check
    const cached = this.objectCache.get(calendar.url);
    if (cached) {
      const { isDirty, newCtag } = await withRetry(
        () => this.client.isCollectionDirty({ collection: { ...calendar, ctag: cached.ctag } }),
        this.logger
      );

      if (!isDirty) {
        this.logger.debug({ url: calendar.url }, 'Calendar unchanged (CTag match via server check)');
        return cached.objects;
      }

      this.logger.info(
        { url: calendar.url, oldCtag: cached.ctag, newCtag },
        'Calendar changed, re-fetching'
      );
    }

    // Fetch from server
    const objects = await withRetry(
      () => this.client.fetchCalendarObjects({ calendar }),
      this.logger
    );

    // Cache the results (only for full fetches, not time-range queries)
    if (!hasPartialRead()) this.objectCache.set(calendar.url, calendar.ctag ?? '', objects);

    this.logger.info(
      { url: calendar.url, count: objects.length, cached: true },
      'Fetched calendar objects'
    );

    return objects;
  }

  /**
   * One calendar-query that returns the objects directly: no list of hrefs to
   * send back in a multiget, so the request body stays small at any density.
   *
   * @throws DavHttpError when the server still refuses a window narrower than a day
   */
  private async queryTimeRange(calendar: DAVCalendar, timeRange: TimeRange): Promise<DAVCalendarObject[]> {
    const icalTime = (iso: string) => `${new Date(iso).toISOString().slice(0, 19).replace(/[-:]/g, '')}Z`;
    try {
      const responses = await withRetry(
        () => this.client.calendarQuery({
          url: calendar.url,
          depth: '1',
          props: { 'd:getetag': {}, 'c:calendar-data': {} },
          filters: {
            'comp-filter': {
              _attributes: { name: 'VCALENDAR' },
              'comp-filter': {
                _attributes: { name: 'VEVENT' },
                'time-range': { _attributes: { start: icalTime(timeRange.start), end: icalTime(timeRange.end) } },
              },
            },
          },
        }),
        this.logger
      );
      return responses.flatMap((res) => {
        if (!res.href) return [];
        const data = res.props?.calendarData?._cdata ?? res.props?.calendarData;
        if (!res.ok || !data) {
          addReadWarning(`The server returned no data for the object ${res.href.split('/').pop()}.`);
          return [];
        }
        return [{ url: new URL(res.href, calendar.url).href, etag: res.props?.getetag, data }];
      });
    } catch (err) {
      const start = Date.parse(timeRange.start);
      const end = Date.parse(timeRange.end);
      if (!(err instanceof DavHttpError) || err.status !== 413 || end - start <= DAY_MS) throw err;

      const middle = new Date((start + end) / 2).toISOString();
      this.logger.info({ url: calendar.url, timeRange }, 'Window too large for the server, splitting it');
      const halves = [
        ...(await this.queryTimeRange(calendar, { start: timeRange.start, end: middle })),
        ...(await this.queryTimeRange(calendar, { start: middle, end: timeRange.end })),
      ];
      // An event crossing the middle is in both halves.
      return [...new Map(halves.map((obj) => [obj.url, obj])).values()];
    }
  }

  /**
   * Fetch events from a single calendar identified by display name (case-insensitive)
   *
   * Looks up the calendar by displayName among all discovered calendars.
   *
   * @param name - Calendar display name to match (case-insensitive)
   * @param timeRange - Optional ISO 8601 time range for server-side filtering
   * @returns Array of DAVCalendarObject from the matched calendar
   * @throws Error if no calendar has this name
   */
  async fetchEventsByCalendarName(name: string, timeRange?: TimeRange): Promise<DAVCalendarObject[]> {
    await this.listCalendars();
    const match = this.calendars.find(
      (cal) => (String(cal.displayName || '')).toLowerCase() === name.toLowerCase()
    );
    if (!match) {
      throw new Error(`Calendar "${name}" not found.\n\nFix: Use list_calendars to see the available names.`);
    }
    return this.fetchEventsFrom([match], timeRange);
  }

  /**
   * Fetch events from ALL calendars (CAL-06 multi-calendar aggregation)
   *
   * Fetches events from all calendars in parallel, then flattens results.
   * Each calendar uses its own CTag-based caching strategy.
   *
   * @param timeRange - Optional ISO 8601 time range for server-side filtering
   * @returns Flattened array of DAVCalendarObject from all calendars
   * @throws Error if any calendar fetch fails after retries
   */
  async fetchAllEvents(timeRange?: TimeRange): Promise<DAVCalendarObject[]> {
    // Ensure calendars are loaded
    await this.listCalendars();

    const flattened = await this.fetchEventsFrom(this.calendars, timeRange);

    this.logger.info(
      { calendarCount: this.calendars.length, totalObjects: flattened.length },
      'Fetched events from all calendars'
    );

    return flattened;
  }

  /**
   * Fetch events from these calendars in parallel. One without read rights must not
   * hide the others: it is named next to the result, and in the error if all refuse.
   */
  async fetchEventsFrom(calendars: DAVCalendar[], timeRange?: TimeRange): Promise<DAVCalendarObject[]> {
    const refused: string[] = [];
    const results = await Promise.all(
      calendars.map(async (cal) => {
        try {
          return await this.fetchEvents(cal, timeRange);
        } catch (err) {
          if (!(err instanceof DavHttpError) || err.status !== 403) throw err;
          refused.push(`"${String(cal.displayName || cal.url)}"`);
          return [];
        }
      })
    );
    if (refused.length === calendars.length && refused.length > 0) {
      throw new DavHttpError(403, null, `on the calendar ${refused.join(', ')}`);
    }
    for (const name of refused) {
      addReadWarning(`The calendar ${name} could not be read: this account has no read access to it (HTTP 403).`);
    }
    return results.flat();
  }

  /**
   * Create a new calendar event
   *
   * @param iCalString - Complete iCalendar string to create
   * @param calendarName - Optional calendar display name (case-insensitive), defaults to first calendar
   * @returns Object with url and etag of the created event
   * @throws ConflictError if 412 response (event with this UID already exists)
   * @throws Error if calendar not found or creation fails
   */
  async createEvent(
    iCalString: string,
    calendarName?: string
  ): Promise<{ url: string; etag: string | undefined }> {
    // Resolve target calendar
    await this.listCalendars();
    let targetCalendar: DAVCalendar;

    if (calendarName) {
      const match = this.calendars.find(
        (cal) => String(cal.displayName || '').toLowerCase() === calendarName.toLowerCase()
      );
      if (!match) {
        throw new Error(`Calendar "${calendarName}" not found`);
      }
      targetCalendar = match;
    } else {
      targetCalendar = this.calendars[0];
    }

    // Generate filename
    const filename = `${randomUUID()}.ics`;

    // No retry: after a cut, the first write may have been applied and a second turns that into a failure.
    const response = await this.client.createCalendarObject({
      calendar: targetCalendar,
      iCalString,
      filename,
    });

    // Check response
    if (!response.ok) {
      if (response.status === 412) {
        throw new ConflictError(
          'event',
          'An event with this UID already exists. Use a different UID or update the existing event.'
        );
      }
      throw new Error(`Failed to create event: HTTP ${response.status}`);
    }

    // Extract etag from response headers
    const etag = response.headers?.get('etag') ?? undefined;

    // Invalidate cache for the calendar
    this.objectCache.invalidate(targetCalendar.url);

    // Build result URL
    const resultUrl = new URL(filename, targetCalendar.url).href;

    this.logger.info({ url: resultUrl, calendar: targetCalendar.url }, 'Created calendar event');

    return { url: resultUrl, etag };
  }

  /**
   * Update an existing calendar event
   *
   * @param url - Full URL of the event to update
   * @param iCalString - Updated iCalendar string
   * @param etag - Current ETag for optimistic concurrency control
   * @returns Object with new etag
   * @throws ConflictError if 412 response (event modified by another client)
   * @throws Error if update fails
   */
  async updateEvent(
    url: string,
    iCalString: string,
    etag: string
  ): Promise<{ etag: string | undefined }> {
    // No retry: see createEvent
    const response = await this.client.updateCalendarObject({
      calendarObject: {
        url,
        data: iCalString,
        etag,
      },
    });

    // Check response
    if (!response.ok) {
      if (response.status === 412) {
        throw new ConflictError('event');
      }
      throw new Error(`Failed to update event: HTTP ${response.status}`);
    }

    // Extract new etag from response headers
    const newEtag = response.headers?.get('etag') ?? undefined;

    // Invalidate cache for the collection
    const collectionUrl = url.substring(0, url.lastIndexOf('/') + 1);
    this.objectCache.invalidate(collectionUrl);

    this.logger.info({ url, collectionUrl }, 'Updated calendar event');

    return { etag: newEtag };
  }

  /**
   * Delete a calendar event
   *
   * @param url - Full URL of the event to delete
   * @param etag - Optional ETag for optimistic concurrency control (fetched if missing)
   * @throws ConflictError if 412 response (event modified by another client)
   * @throws Error if event not found or deletion fails
   */
  async deleteEvent(url: string, etag?: string): Promise<void> {
    let resolvedEtag = etag;

    // If etag is missing, fetch fresh etag
    if (!resolvedEtag) {
      this.logger.debug({ url }, 'ETag missing, fetching fresh ETag for delete');

      // Extract collection URL
      const collectionUrl = url.substring(0, url.lastIndexOf('/') + 1);

      // Fetch all objects in the collection
      const objects = await withRetry(
        () => this.client.fetchCalendarObjects({
          calendar: { url: collectionUrl } as DAVCalendar,
        }),
        this.logger
      );

      // Find the matching object
      const matchingObject = objects.find((obj) => obj.url === url);
      if (!matchingObject || !matchingObject.etag) {
        throw new Error('Cannot delete: event not found or ETag unavailable');
      }

      resolvedEtag = matchingObject.etag;
    }

    // No retry: see createEvent
    const response = await this.client.deleteCalendarObject({
      calendarObject: {
        url,
        etag: resolvedEtag!,
      },
    });

    // Check response
    if (!response.ok) {
      if (response.status === 412) {
        throw new ConflictError('event');
      }
      throw new Error(`Failed to delete event: HTTP ${response.status}`);
    }

    // Invalidate cache for the collection
    const collectionUrl = url.substring(0, url.lastIndexOf('/') + 1);
    this.objectCache.invalidate(collectionUrl);

    this.logger.info({ url, collectionUrl }, 'Deleted calendar event');
  }

  /**
   * Find an event by UID across all calendars or a specific calendar
   *
   * @param uid - The UID of the event to find
   * @param calendarName - Optional calendar display name to search in (case-insensitive)
   * @returns EventDTO with full data including _raw, etag, url, or null if not found
   */
  async findEventByUid(uid: string, calendarName?: string): Promise<EventDTO | null> {
    await this.listCalendars();
    const targets = calendarName
      ? this.calendars.filter(
          (cal) => String(cal.displayName || '').toLowerCase() === calendarName.toLowerCase()
        )
      : this.calendars;
    if (targets.length === 0) {
      throw new Error(`Calendar "${calendarName ?? ''}" not found.\n\nFix: Use list_calendars to see the available names.`);
    }

    let copies = await this.findByUidOnJsonApi(uid, targets);
    const onJsonApi = copies !== undefined;
    if (!copies) {
      // Standard path: calendar-query with a UID prop-filter, bounded in time because
      // a server may parse every object of the calendar to answer it.
      const icalTime = (ms: number) => `${new Date(ms).toISOString().slice(0, 19).replace(/[-:]/g, '')}Z`;
      const now = Date.now();
      const timeRange = {
        start: icalTime(now - UID_SEARCH_YEARS * YEAR_MS),
        end: icalTime(now + UID_SEARCH_YEARS * YEAR_MS),
      };
      copies = [];
      for (const calendar of targets) {
        copies.push(...await this.queryUid(calendar, uid, timeRange));
      }
    }

    if (copies.length > 1) {
      const names = copies.map((copy) =>
        `"${String(targets.find((cal) => copy.url.startsWith(cal.url))?.displayName ?? copy.url)}"`
      );
      throw new Error(
        `The UID ${uid} is in several calendars: ${names.join(', ')}.\n\nFix: Name the calendar to use with the calendar parameter.`
      );
    }
    if (copies.length === 1) return copies[0];
    if (onJsonApi) return null;

    throw new Error(
      `Event not found with UID: ${uid} within ${UID_SEARCH_YEARS} years of today.\n\nFix: Find the event with get_events_in_range or search_events to get its UID. An older event must be changed in the calendar application.`
    );
  }

  /**
   * Look a UID up through the JSON API of esn-sabre (Twake Calendar): it reads the
   * uid index, so an unknown UID costs one small request whatever the calendar size.
   *
   * @returns The copies in `targets`, or undefined if this server has no JSON API
   */
  private async findByUidOnJsonApi(uid: string, targets: DAVCalendar[]): Promise<EventDTO[] | undefined> {
    const homeUrl = `${new URL('..', targets[0].url).href.replace(/\/$/, '')}.json`;
    const request = async (method: string, body?: string) =>
      davFetch()(homeUrl, {
        method,
        body,
        headers: {
          ...(await this.getFreshAuthHeaders()),
          accept: 'application/json',
          ...(body ? { 'content-type': 'application/json' } : {}),
        },
      });

    if (this.hasJsonApi === undefined) {
      // A 404 on the UID below is only conclusive on a server known to have this API.
      this.hasJsonApi = await withRetry(async () => answersJson(await request('GET')), this.logger);
    }
    if (!this.hasJsonApi) return undefined;

    let text: string;
    try {
      const response = await withRetry(() => request('REPORT', JSON.stringify({ uid })), this.logger);
      text = await response.text();
    } catch (err) {
      if (err instanceof DavHttpError && err.status === 404) return [];
      throw err;
    }

    // The server gives one copy at most, of its own choice: it says the UID exists, not
    // where all its copies are. The other calendars are asked by a query, without a date.
    const items: Array<{ _links?: { self?: { href?: string } } }> = JSON.parse(text)._embedded?.['dav:item'] ?? [];
    const href = items.find((item) => item._links?.self?.href)?._links?.self?.href;
    if (!href) return [];
    const segments = href.split('/');
    const filename = segments.pop() as string;
    const calendarPath = `${segments.join('/')}/`;
    const hit = targets.find((cal) => new URL(cal.url).pathname.endsWith(calendarPath));

    const copies: EventDTO[] = [];
    if (hit) {
      const copy = await this.readRawEvent(hit, filename, uid);
      if (copy) copies.push(copy);
    }
    for (const calendar of targets) {
      if (calendar !== hit) copies.push(...await this.queryUid(calendar, uid));
    }
    return copies;
  }

  /**
   * The object as the server stores it. The JSON API goes through a parser that cuts a
   * text with an unescaped comma, and what we read here is written back on an update.
   */
  private async readRawEvent(calendar: DAVCalendar, filename: string, uid: string): Promise<EventDTO | null> {
    // A relative URL with a colon in its first segment would read as a scheme.
    const url = new URL(`./${filename}`, calendar.url).href;
    const response = await withRetry(async () => {
      const answer = await davFetch()(url, { method: 'GET', headers: { ...(await this.getFreshAuthHeaders()), accept: 'text/calendar' } });
      if (answer.status >= 400 && answer.status !== 404) throw new DavHttpError(answer.status, answer.headers.get('retry-after'));
      return answer;
    }, this.logger);
    if (response.status === 404) return null;
    const contentType = response.headers.get('content-type') ?? '';
    const data = await response.text();
    // The server said this object exists: anything but the object is a failed read, not "not found".
    if (!/calendar/i.test(contentType) || !data) {
      throw new DavHttpError(response.status, null, `unexpected answer for the event, content type "${contentType}"`);
    }
    const eventDTO = transformCalendarObject({ url, etag: response.headers.get('etag') ?? undefined, data }, this.logger);
    if (eventDTO?.uid !== uid) {
      throw new DavHttpError(response.status, null, 'the object read is not the event asked for');
    }
    return eventDTO;
  }

  /** Query one calendar for a UID (RFC 4791 9.7.5), within `timeRange` if given. */
  private async queryUid(calendar: DAVCalendar, uid: string, timeRange?: { start: string; end: string }): Promise<EventDTO[]> {
    const filters = [
      {
        'comp-filter': {
          _attributes: { name: 'VCALENDAR' },
          'comp-filter': {
            _attributes: { name: 'VEVENT' },
            ...(timeRange ? { 'time-range': { _attributes: timeRange } } : {}),
            'prop-filter': {
              _attributes: { name: 'UID' },
              'text-match': { _attributes: { collation: 'i;octet' }, _text: uid },
            },
          },
        },
      },
    ];
    const objects = await withRetry(
      () => this.client.fetchCalendarObjects({ calendar, filters, useMultiGet: false } as any),
      this.logger
    );
    return objects.flatMap((obj) => {
      const eventDTO = obj.data ? transformCalendarObject(obj, this.logger) : null;
      // esn-sabre ignores this filter next to a time-range: the check on the client is what counts.
      return eventDTO?.uid === uid ? [eventDTO] : [];
    });
  }

  /**
   * The email addresses the server knows this user by (RFC 6638), which is what
   * ATTENDEE holds. Configuration is no substitute: a login is not always an address.
   *
   * @throws Error if the server gives none: without them, no invitation can be recognised
   */
  async getUserEmails(): Promise<string[]> {
    if (this.userEmails) return this.userEmails;

    const account = await withRetry(
      () => this.client.createAccount({ account: { accountType: 'caldav' } as never }),
      this.logger
    );
    const [principal] = await withRetry(
      () => this.client.propfind({
        url: account.principalUrl as string,
        depth: '0',
        props: { 'c:calendar-user-address-set': {} },
      }),
      this.logger
    );
    const hrefs = [principal?.props?.calendarUserAddressSet?.href ?? []].flat() as string[];
    const emails = hrefs
      .filter((href) => /^mailto:/i.test(href))
      .map((href) => href.replace(/^mailto:/i, '').toLowerCase());
    if (emails.length === 0) {
      throw new Error('The server does not give the address of this user, so invitations cannot be checked.');
    }
    this.userEmails = emails;
    return emails;
  }

  /**
   * List pending invitations
   *
   * A server delivers an invitation into the calendar of the attendee, with
   * PARTSTAT=NEEDS-ACTION (RFC 6638): that is what we query, bounded by date. The
   * scheduling inbox only holds the iTIP messages, which cannot be answered.
   *
   * @param timeRange - Time range of the proposed events
   * @returns Pending invitations, sorted by proposed start
   */
  async listPendingInvitations(timeRange: TimeRange): Promise<InvitationDTO[]> {
    const userEmails = await this.getUserEmails();
    const calendars = await this.listCalendars();
    const icalTime = (iso: string) => `${new Date(iso).toISOString().slice(0, 19).replace(/[-:]/g, '')}Z`;

    const invitations: InvitationDTO[] = [];
    for (const calendar of calendars) {
      const responses = await withRetry(
        () => this.client.calendarQuery({
          url: calendar.url,
          depth: '1',
          props: { 'd:getetag': {}, 'c:calendar-data': {} },
          filters: {
            'comp-filter': {
              _attributes: { name: 'VCALENDAR' },
              'comp-filter': {
                _attributes: { name: 'VEVENT' },
                'time-range': { _attributes: { start: icalTime(timeRange.start), end: icalTime(timeRange.end) } },
                'prop-filter': {
                  _attributes: { name: 'ATTENDEE' },
                  'param-filter': {
                    _attributes: { name: 'PARTSTAT' },
                    'text-match': { _attributes: { collation: 'i;ascii-casemap' }, _text: 'NEEDS-ACTION' },
                  },
                },
              },
            },
          },
        }),
        this.logger
      );

      for (const resp of responses) {
        if (!resp.ok) throw new DavHttpError(resp.status);
        const calendarData = resp.props?.calendarData?._cdata ?? resp.props?.calendarData;
        if (!resp.href || !calendarData) continue;
        const inboxResp: InboxResponse = {
          href: new URL(resp.href, calendar.url).href,
          props: { getetag: resp.props?.getetag as string | undefined, calendarData },
        };
        const invitation = transformInvitation(inboxResp, userEmails, this.logger);
        // The filter also matches events where only another attendee has not answered.
        if (invitation?.userPartstat.toUpperCase() === 'NEEDS-ACTION') invitations.push(invitation);
      }
    }

    invitations.sort((a, b) => a.proposedStart.getTime() - b.proposedStart.getTime());
    this.logger.info({ count: invitations.length }, 'Found pending invitations');
    return invitations;
  }

  /**
   * Respond to a calendar invitation by updating PARTSTAT
   *
   * Uses RFC 6638 implicit scheduling: PUT the updated iCalendar to the event in
   * the calendar and the server automatically sends iTIP REPLY to organizer.
   *
   * @param uid - UID of the invitation
   * @param response - Participation response (ACCEPTED, DECLINED, TENTATIVE)
   * @returns The event answered
   * @throws ConflictError if invitation was modified (412)
   * @throws Error if there is no such event, or this user is not one of its attendees
   */
  async respondToInvitation(
    uid: string,
    response: 'ACCEPTED' | 'DECLINED' | 'TENTATIVE',
  ): Promise<InvitationDTO> {
    const event = await this.findEventByUid(uid);
    if (!event) {
      throw new Error(`Invitation not found with UID: ${uid}\n\nFix: Use list_invitations to see pending invitations and their UIDs.`);
    }
    const userEmails = await this.getUserEmails();
    const invitation = transformInvitation(
      { href: event.url, props: { getetag: event.etag, calendarData: event._raw } },
      userEmails,
      this.logger,
    );
    if (!invitation || !invitation.userPartstat) {
      throw new Error(`You are not an attendee of the event with UID: ${uid}.`);
    }
    const invitationUrl = invitation.url;
    const etag = invitation.etag;
    const attendeeEmail = invitation.attendeeEmail as string;

    this.logger.debug(
      { url: invitationUrl, response, attendeeEmail },
      'Responding to invitation'
    );

    // Update PARTSTAT in iCalendar using helper function
    const updatedIcal = updateAttendeePartstat(event._raw, attendeeEmail, response);

    // PUT to the event with its ETag for optimistic concurrency. No retry: see createEvent
    const httpResponse = await this.client.updateCalendarObject({
      calendarObject: {
        url: invitationUrl,
        data: updatedIcal,
        etag,
      },
    });

    // Check response status
    if (!httpResponse.ok) {
      if (httpResponse.status === 412) {
        throw new ConflictError('invitation');
      }
      throw new Error(`Failed to respond to invitation: HTTP ${httpResponse.status}`);
    }

    this.logger.info(
      { url: invitationUrl, response },
      'Successfully responded to invitation'
    );
    return invitation;
  }
}
