/**
 * Whole walks through the tools, with a server whose time-range follows known
 * events: every occurrence once, on get_events_in_range, search_events and
 * get_todays_schedule, with exceptions in the series.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import pino from 'pino';
import { createDualClients } from '../../src/caldav/client.js';
import { CalendarService } from '../../src/caldav/calendar-service.js';
import { AddressBookService } from '../../src/caldav/addressbook-service.js';
import { createServer } from '../../src/server.js';
import type { Config } from '../../src/config/schema.js';
import { calendarObjects, startFakeDav, type FakeDav } from '../helpers/fake-dav.js';

const logger = pino({ level: 'silent' });
const basic = (t: number) => `${new Date(t).toISOString().slice(0, 19).replace(/[-:]/g, '')}Z`;
const DAY = 86_400_000;
const T0 = Date.UTC(2026, 10, 1, 10);

const master = (days: number) => ['BEGIN:VEVENT', 'UID:s', 'DTSTAMP:20260101T000000Z', 'SUMMARY:keyword s', `DTSTART:${basic(T0)}`, `DTEND:${basic(T0 + 3_600_000)}`, `RRULE:FREQ=DAILY;COUNT=${days}`, 'END:VEVENT'];
const exception = (day: number, ...lines: string[]) => ['BEGIN:VEVENT', 'UID:s', 'DTSTAMP:20260101T000000Z', 'SUMMARY:keyword s', `RECURRENCE-ID:${basic(T0 + day * DAY)}`, ...lines, 'END:VEVENT'];
const moved = (day: number, to: number) => exception(day, `DTSTART:${basic(T0 + to * DAY)}`, `DTEND:${basic(T0 + to * DAY + 3_600_000)}`);
const cancelled = (day: number) => exception(day, `DTSTART:${basic(T0 + day * DAY)}`, `DTEND:${basic(T0 + day * DAY + 3_600_000)}`, 'STATUS:CANCELLED');
const ical = (...vevents: string[][]) => ['BEGIN:VCALENDAR', 'VERSION:2.0', ...vevents.flat(), 'END:VCALENDAR', ''].join('\r\n');

describe('walks', () => {
  let dav: FakeDav;
  let client: Client;

  beforeAll(async () => {
    dav = await startFakeDav();
    const config = { DAV_URL: dav.url, DAV_AUTH_METHOD: 'basic', DAV_USERNAME: 'u', DAV_PASSWORD: 'p' } as Config;
    const clients = await createDualClients(config, logger);
    const server = createServer(new CalendarService(clients.caldav, logger, config), new AddressBookService(clients.carddav, logger), logger, undefined, undefined, 'UTC');
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    client = new Client({ name: 'test', version: '1' }, { capabilities: {} });
    await client.connect(clientTransport);
  });

  afterAll(async () => {
    await client.close();
    await dav.close();
  });

  beforeEach(() => {
    dav.requests.length = 0;
  });

  const serve = (...objects: string[]) => {
    dav.handler = (req) =>
      req.method === 'REPORT'
        ? calendarObjects(objects.map((data, i) => ({ href: `/calendars/u1/Perso/o${i}.ics`, ical: data })))
        : null;
  };
  /**
   * Answers like sabre: follows the time-range of the query, leaves out an event of no
   * duration at its exact start, and returns the objects in another order at each call.
   */
  const serveLikeSabre = (events: Array<{ uid: string; start: number; minutes: number }>) => {
    let calls = 0;
    const when = (text: string) => Date.UTC(+text.slice(0, 4), +text.slice(4, 6) - 1, +text.slice(6, 8), +text.slice(9, 11), +text.slice(11, 13), +text.slice(13, 15));
    dav.handler = (req) => {
      if (req.method !== 'REPORT') return null;
      const [, from, to] = /start="(\w+)" end="(\w+)"/.exec(req.body)!;
      calls++;
      return calendarObjects(events
        .filter((e) => {
          const end = e.start + e.minutes * 60_000;
          return e.start < when(to) && end > when(from);
        })
        .sort((a, b) => ((a.uid.charCodeAt(a.uid.length - 1) * calls) % 7) - ((b.uid.charCodeAt(b.uid.length - 1) * calls) % 7))
        .map((e) => ({
          href: `/calendars/u1/Perso/${e.uid}.ics`,
          ical: ical(['BEGIN:VEVENT', `UID:${e.uid}`, 'DTSTAMP:20260101T000000Z', `SUMMARY:${e.uid}`, `DTSTART:${basic(e.start)}`, ...(e.minutes ? [`DTEND:${basic(e.start + e.minutes * 60_000)}`] : []), 'END:VEVENT']),
        })));
    };
  };
  const textOf = (r: unknown) => (r as { content: Array<{ text: string }> }).content.map((c) => c.text).join('\n');

  /** Every "UID, date" line of a whole walk. */
  async function walk(name: string, args: Record<string, unknown>): Promise<string[]> {
    const seen: string[] = [];
    let cursor: unknown;
    for (let pages = 0; pages < 200; pages++) {
      const result = await client.callTool({ name, arguments: { ...args, ...(cursor ? { cursor } : {}) } });
      const text = textOf(result);
      expect(result.isError, text).toBeFalsy();
      seen.push(...[...text.matchAll(/UID: (\S+)\n\s+(.*)/g)].map((m) => `${m[1]} ${m[2]}`));
      const next = /nextCursor: (\{.*\})/.exec(text);
      if (!next) return seen;
      cursor = JSON.parse(next[1]);
    }
    throw new Error('the walk does not end');
  }
  const range = { when: '2026-11-01 to 2027-01-29' };
  const days = (seen: string[]) => new Set(seen).size;

  describe('against a server that follows the time-range', () => {
    const uids = (seen: string[]) => seen.map((s) => s.split(' ')[0]).sort();

    it.each([1, 2, 3, 7, 100])('walks events of no duration, at limit %i', async (limit) => {
      const events = Array.from({ length: 10 }, (_, i) => ({ uid: `z${i}`, start: T0 + i * 3_600_000, minutes: 0 }));
      serveLikeSabre(events);
      const seen = await walk('get_events_in_range', { ...range, limit });
      expect(uids(seen)).toEqual(events.map((e) => e.uid));
    });

    it('finds an event of no duration at the exact start of the range', async () => {
      serveLikeSabre([{ uid: 'z', start: new Date(2026, 10, 1).getTime(), minutes: 0 }]);
      const seen = await walk('get_events_in_range', { when: '2026-11-01 to 2026-11-02' });
      expect(uids(seen)).toEqual(['z']);
    });

    it.each([1, 2, 3])('keeps a meeting at the same start as an event of no duration, at limit %i', async (limit) => {
      serveLikeSabre([
        { uid: 'a', start: T0, minutes: 30 },
        { uid: 'b', start: T0 + 3_600_000, minutes: 0 },
        { uid: 'c', start: T0 + 3_600_000, minutes: 30 },
        { uid: 'd', start: T0 + 7_200_000, minutes: 30 },
      ]);
      const seen = await walk('get_events_in_range', { ...range, limit });
      expect(uids(seen)).toEqual(['a', 'b', 'c', 'd']);
    });

    it.each([1, 7])('walks simultaneous events the server returns in any order, at limit %i', async (limit) => {
      const events = Array.from({ length: 40 }, (_, i) => ({ uid: `s${String(i).padStart(2, '0')}`, start: T0, minutes: 30 }));
      serveLikeSabre(events);
      const seen = await walk('get_events_in_range', { ...range, limit });
      expect(uids(seen)).toEqual(events.map((e) => e.uid));
    });
  });

  it('warns when the event a cursor had counted is gone, and the next one with it', async () => {
    serve(ical(['BEGIN:VEVENT', 'UID:b', 'DTSTAMP:20260101T000000Z', 'SUMMARY:b', `DTSTART:${basic(T0)}`, `DTEND:${basic(T0 + 1000)}`, 'END:VEVENT']));
    const text = textOf(await client.callTool({ name: 'get_events_in_range', arguments: { ...range, cursor: { start: new Date(T0).toISOString(), skip: 1 } } }));
    expect(text).toContain('calendar changed');
    expect(text).not.toContain('No more events');
  });

  it('a page after the last event says there is no more', async () => {
    serve(ical(master(2)));
    const text = textOf(await client.callTool({ name: 'get_events_in_range', arguments: { ...range, cursor: { start: new Date(T0 + 30 * DAY).toISOString(), skip: 0 } } }));
    expect(text).toContain('No more events in this range.');
    expect(text).not.toContain('No events found');
  });

  describe('a series around the ceiling of 10 000 occurrences', () => {
    const minutely = (rule: string) => ical(['BEGIN:VEVENT', 'UID:busy', 'DTSTAMP:20260101T000000Z', 'SUMMARY:busy', `DTSTART:${basic(T0)}`, `DTEND:${basic(T0 + 1000)}`, `RRULE:FREQ=MINUTELY${rule}`, 'END:VEVENT']);

    it('says nothing at exactly 10 000', async () => {
      serve(minutely(';COUNT=10000'));
      const text = textOf(await client.callTool({ name: 'get_events_in_range', arguments: { ...range, limit: 1 } }));
      expect(text).not.toContain('incomplete');
    });

    it('warns above it, and the last page does not say that nothing remains', async () => {
      serve(minutely(''));
      const first = textOf(await client.callTool({ name: 'get_events_in_range', arguments: { ...range, limit: 1 } }));
      expect(first).toContain('more than 10000 occurrences');
      const last = textOf(await client.callTool({ name: 'get_events_in_range', arguments: { ...range, limit: 1, cursor: { start: new Date(T0 + 9_999 * 60_000).toISOString(), skip: 0 } } }));
      expect(last).not.toContain('No more events');
      expect(last).toContain('End of this page');
    });

    it('get_next_event gives an exact answer without calling it incomplete', async () => {
      const start = Date.now() + DAY;
      serve(ical(['BEGIN:VEVENT', 'UID:busy', 'DTSTAMP:20260101T000000Z', 'SUMMARY:busy', `DTSTART:${basic(start)}`, `DTEND:${basic(start + 1000)}`, 'RRULE:FREQ=MINUTELY', 'END:VEVENT']));
      const text = textOf(await client.callTool({ name: 'get_next_event', arguments: {} }));
      expect(text).toContain('UID: busy');
      expect(text).not.toContain('incomplete');
    });
  });

  it.each([1, 2, 7, 50])('a series of 90 days with a cancelled day gives 89, at limit %i', async (limit) => {
    serve(ical(master(90), cancelled(10)));
    const seen = await walk('get_events_in_range', { ...range, limit });
    expect(seen).toHaveLength(89);
    expect(days(seen)).toBe(89);
  });

  it('the default limit does not stop a series with a cancelled day', async () => {
    serve(ical(master(90), cancelled(10)));
    const seen = await walk('get_events_in_range', range);
    expect(seen).toHaveLength(89);
  });

  it.each([1, 2, 3])('finds an occurrence moved after the cursor, at limit %i', async (limit) => {
    serve(ical(master(10), moved(0, 7)));
    const seen = await walk('get_events_in_range', { ...range, limit });
    expect(seen).toHaveLength(10);
  });

  it('finds an occurrence moved forward', async () => {
    serve(ical(master(25), moved(19, 1)));
    const seen = await walk('get_events_in_range', { ...range, limit: 2 });
    expect(seen).toHaveLength(25);
  });

  it('an occurrence moved outside the range does not break the walk', async () => {
    const inside = ical(master(5), moved(1, 200), moved(2, -30));
    serve(inside);
    const seen = await walk('get_events_in_range', { ...range, limit: 1 });
    expect(seen).toHaveLength(3);
  });

  it.each([1, 3, 100])('search_events walks without a hole, at limit %i', async (limit) => {
    serve(ical(master(30), cancelled(4), moved(0, 40)));
    const seen = await walk('search_events', { query: 'keyword', ...range, limit });
    expect(seen).toHaveLength(29);
    expect(days(seen)).toBe(29);
  });

  it('search_events cuts after the filter and says what remains', async () => {
    serve(ical(master(10)), ical(['BEGIN:VEVENT', 'UID:other', 'DTSTAMP:20260101T000000Z', 'SUMMARY:nothing', `DTSTART:${basic(T0)}`, `DTEND:${basic(T0 + 1000)}`, 'END:VEVENT']));
    const first = textOf(await client.callTool({ name: 'search_events', arguments: { query: 'keyword', ...range, limit: 4 } }));
    expect(first.match(/UID: s/g)).toHaveLength(4);
    expect(first).not.toContain('UID: other');
    expect(first).toContain('6 more events remain');
  });

  it('search_events says it read 30 days without dates', async () => {
    const { tools } = await client.listTools();
    expect(tools.find((t) => t.name === 'search_events')?.description).toContain('next 30 days');
  });

  it('get_todays_schedule pages through a dense day', async () => {
    const now = Date.now();
    const start = now - (now % DAY) + 3_600_000;
    const event = (i: number) => ical(['BEGIN:VEVENT', `UID:e${i}`, 'DTSTAMP:20260101T000000Z', `SUMMARY:e${i}`, `DTSTART:${basic(start)}`, `DTEND:${basic(start + 60_000)}`, 'END:VEVENT']);
    serve(...Array.from({ length: 12 }, (_, i) => event(i)));
    const seen = await walk('get_todays_schedule', { limit: 5 });
    expect(new Set(seen.map((s) => s.split(' ')[0])).size).toBe(12);
    expect(seen).toHaveLength(12);
  });

  it('get_next_event gives the occurrence after a cancelled one', async () => {
    const start = Date.now() + DAY;
    const day = basic(start);
    const series = ical(
      ['BEGIN:VEVENT', 'UID:s', 'DTSTAMP:20260101T000000Z', 'SUMMARY:s', `DTSTART:${day}`, `DTEND:${basic(start + 3_600_000)}`, 'RRULE:FREQ=DAILY', 'END:VEVENT'],
      ['BEGIN:VEVENT', 'UID:s', 'DTSTAMP:20260101T000000Z', 'SUMMARY:s', `RECURRENCE-ID:${day}`, `DTSTART:${day}`, `DTEND:${basic(start + 3_600_000)}`, 'STATUS:CANCELLED', 'END:VEVENT'],
    );
    serve(series);
    const text = textOf(await client.callTool({ name: 'get_next_event', arguments: {} }));
    const expected = new Date(start + DAY).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' });
    expect(text).toContain(expected);
  });

  it.each([1, 2])('walks events already running at the start of the range, at limit %i', async (limit) => {
    const running = (uid: string, hours: number) => ical(['BEGIN:VEVENT', `UID:${uid}`, 'DTSTAMP:20260101T000000Z', `SUMMARY:${uid}`, `DTSTART:${basic(T0 - hours * 3_600_000)}`, `DTEND:${basic(T0 + 3_600_000)}`, 'END:VEVENT']);
    serve(running('a', 72), running('b', 48), running('c', 24));
    const seen = await walk('get_events_in_range', { when: '2026-11-01 to 2026-11-02', limit });
    expect(seen).toHaveLength(3);
  });

  it.each([
    ['get_events_in_range', { when: '2015-01-01 to 2020-01-01' }],
    ['search_events', { query: 'keyword', when: '2015-01-01 to 2020-01-01' }],
    ['check_availability', { start: '2015-01-01T00:00:00Z', end: '2020-01-01T00:00:00Z' }],
  ])('%s refuses a range above 92 days, without a request', async (name, args) => {
    const result = await client.callTool({ name, arguments: args });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('92 days');
    expect(dav.requests.some((r) => r.method === 'REPORT')).toBe(false);
  });

  it('refuses nextCursor as an argument, instead of giving page 1 again', async () => {
    await expect(client.callTool({ name: 'get_events_in_range', arguments: { ...range, nextCursor: { start: '2026-11-02T10:00:00Z', skip: 0 } } }))
      .resolves.toMatchObject({ isError: true });
  });

  it('refuses an enormous skip', async () => {
    const result = await client.callTool({ name: 'get_events_in_range', arguments: { ...range, cursor: { start: '2026-11-02T10:00:00Z', skip: 1e9 } } });
    expect(result.isError).toBe(true);
  });

  it('warns when a cursor skips more events than exist at its date', async () => {
    serve(ical(master(5)));
    const text = textOf(await client.callTool({ name: 'get_events_in_range', arguments: { ...range, cursor: { start: new Date(T0 + DAY).toISOString(), skip: 5 } } }));
    expect(text).toContain('calendar changed');
  });

  it('says a cursor is outside the range, with the case of a call without dates', async () => {
    const text = textOf(await client.callTool({ name: 'get_events_in_range', arguments: { ...range, cursor: { start: '2030-01-01T00:00:00Z', skip: 0 } } }));
    expect(text).toContain('without the cursor');
  });

  it('applies the default and maximum limit', async () => {
    serve(ical(master(90)));
    const byDefault = textOf(await client.callTool({ name: 'get_events_in_range', arguments: range }));
    expect(byDefault.match(/UID: /g)).toHaveLength(50);
    const atMax = await client.callTool({ name: 'get_events_in_range', arguments: { ...range, limit: 101 } });
    expect(atMax.isError).toBe(true);
  });
});
