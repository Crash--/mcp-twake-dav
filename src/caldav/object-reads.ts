/**
 * Object reads that keep what the server gave.
 *
 * tsdav's fetchCalendarObjects and fetchVCards throw as soon as one object failed or
 * went missing. The guard in dav-fetch.ts has already named those objects next to
 * the result, so these two ask the same requests and return the rest.
 */

import type { DAVCalendarObject, DAVVCard } from 'tsdav';
import type { DAVClientType } from './client.js';

type Answers = Awaited<ReturnType<DAVClientType['calendarQuery']>>;

const objectUrl = (href: string, collection: string) =>
  new URL(href, collection.endsWith('/') ? collection : `${collection}/`).href;

const pathsOf = (listed: Answers, collection: string, keep: (url: string) => boolean = Boolean) =>
  listed.flatMap((res) => {
    const url = res.href ? objectUrl(res.href, collection) : '';
    if (!url || !keep(url)) return [];
    const { pathname, search } = new URL(url);
    return [`${pathname}${search}`];
  });

const readable = (answers: Answers, collection: string, property: 'calendarData' | 'addressData') =>
  answers.flatMap((res) => {
    if (!res.ok || !res.href) return [];
    const data = res.props?.[property];
    const etag = res.props?.getetag;
    return [{
      url: objectUrl(res.href, collection),
      etag: typeof etag === 'string' || typeof etag === 'number' ? String(etag) : etag?._cdata ?? etag?._text,
      data: data?._cdata ?? data,
    }];
  });

export function keepPartialReads(client: DAVClientType): DAVClientType {
  const fetchCalendarObjects = async (params: {
    calendar: { url: string };
    filters?: unknown;
    timeRange?: { start: string; end: string };
    useMultiGet?: boolean;
  }): Promise<DAVCalendarObject[]> => {
    const { calendar: { url }, timeRange, useMultiGet = true } = params;
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
    if (!useMultiGet) {
      return readable(await client.calendarQuery({ url, props, filters, depth: '1' }), url, 'calendarData');
    }
    const listed = await client.calendarQuery({ url, props: { 'd:getetag': {} }, filters, depth: '1' });
    const objectUrls = pathsOf(listed, url, (u) => u.includes('.ics'));
    if (objectUrls.length === 0) return [];
    return readable(await client.calendarMultiGet({ url, props, objectUrls, depth: '1' }), url, 'calendarData');
  };

  const fetchVCards = async (params: { addressBook: { url: string }; useMultiGet?: boolean }): Promise<DAVVCard[]> => {
    const { addressBook: { url }, useMultiGet = true } = params;
    const props = { 'd:getetag': {}, 'card:address-data': {} };
    if (!useMultiGet) {
      return readable(await client.addressBookQuery({ url, props, depth: '1' }), url, 'addressData');
    }
    const listed = await client.addressBookQuery({ url, props: { 'd:getetag': {} }, depth: '1' });
    const objectUrls = pathsOf(listed, url);
    if (objectUrls.length === 0) return [];
    return readable(await client.addressBookMultiGet({ url, props, objectUrls, depth: '1' }), url, 'addressData');
  };

  return { ...client, fetchCalendarObjects, fetchVCards } as unknown as DAVClientType;
}
