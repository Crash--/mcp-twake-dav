/**
 * Object reads that keep what the server gave.
 *
 * tsdav's fetchCalendarObjects and fetchVCards throw as soon as one object failed or
 * has no data. The guard in dav-fetch.ts has already named the failed ones next to
 * the result. One query with the data: its answer is the whole list, so there is no
 * list of hrefs to send back, which a large range gets refused with a 413 for.
 */

import type { DAVCalendarObject, DAVVCard } from 'tsdav';
import type { DAVClientType } from './client.js';
import { addReadWarning } from './dav-fetch.js';

type Answers = Awaited<ReturnType<DAVClientType['calendarQuery']>>;

const readable = (answers: Answers, collection: string, property: 'calendarData' | 'addressData') => {
  const base = collection.endsWith('/') ? collection : `${collection}/`;
  return answers.flatMap((res) => {
    const url = new URL(res.href ?? '', base).href;
    if (url === base) return [];
    const data = res.props?.[property]?._cdata ?? res.props?.[property];
    if (typeof data !== 'string' || !data) {
      addReadWarning(`The server returned no data for the object ${url.split('/').pop()}.`);
      return [];
    }
    const etag = res.props?.getetag;
    return [{
      url,
      etag: typeof etag === 'string' || typeof etag === 'number' ? String(etag) : etag?._cdata ?? etag?._text,
      data,
    }];
  });
};

/** Text match for an addressbook-query, case-insensitive, `contains` (RFC 6352 10.5.4). */
export function vcardTextFilter(properties: string[], text: string): unknown {
  return {
    _attributes: { test: 'anyof' },
    'prop-filter': properties.map((name) => ({
      _attributes: { name },
      'text-match': { _attributes: { collation: 'i;unicode-casemap', 'match-type': 'contains' }, _text: text },
    })),
  };
}

/** The vCards of one address book that the server matched with `filters`. */
export async function queryVCards(client: DAVClientType, url: string, filters: unknown): Promise<DAVVCard[]> {
  const props = { 'd:getetag': {}, 'card:address-data': {} };
  const answers = await client.addressBookQuery({ url, props, filters: filters as never, depth: '1' });
  return readable(answers, url, 'addressData');
}

export function keepPartialReads(client: DAVClientType): DAVClientType {
  const fetchCalendarObjects = async (params: {
    calendar: { url: string };
    filters?: unknown;
    timeRange?: { start: string; end: string };
  }): Promise<DAVCalendarObject[]> => {
    const { calendar: { url }, timeRange } = params;
    const icalTime = (iso: string) => `${new Date(iso).toISOString().slice(0, 19).replace(/[-:.]/g, '')}Z`;
    const filters = (params.filters ?? {
      'comp-filter': {
        _attributes: { name: 'VCALENDAR' },
        'comp-filter': {
          _attributes: { name: 'VEVENT' },
          ...(timeRange ? { 'time-range': { _attributes: { start: icalTime(timeRange.start), end: icalTime(timeRange.end) } } } : {}),
        },
      },
    }) as Parameters<DAVClientType['calendarQuery']>[0]['filters'];
    const props = { 'd:getetag': {}, 'c:calendar-data': {} };
    return readable(await client.calendarQuery({ url, props, filters, depth: '1' }), url, 'calendarData');
  };

  const fetchVCards = async ({ addressBook: { url } }: { addressBook: { url: string } }): Promise<DAVVCard[]> => {
    const props = { 'd:getetag': {}, 'card:address-data': {} };
    return readable(await client.addressBookQuery({ url, props, depth: '1' }), url, 'addressData');
  };

  return { ...client, fetchCalendarObjects, fetchVCards } as unknown as DAVClientType;
}
