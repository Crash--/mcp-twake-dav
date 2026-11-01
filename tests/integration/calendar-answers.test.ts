/**
 * Tool answers against the real tsdav and a local DAV server with two calendars.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
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
const ical = (uid: string, start: string, summary = uid) =>
  `BEGIN:VCALENDAR\r\nVERSION:2.0\r\nBEGIN:VEVENT\r\nUID:${uid}\r\nDTSTAMP:20260101T000000Z\r\nDTSTART:${start}\r\nDURATION:PT1H\r\nSUMMARY:${summary}\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n`;
const isoBasic = (date: Date) => `${date.toISOString().slice(0, 19).replace(/[-:]/g, '')}Z`;

describe('calendar answers', () => {
  let dav: FakeDav;
  let client: Client;

  beforeAll(async () => {
    dav = await startFakeDav(['Perso', 'Pro']);
    const config = { DAV_URL: dav.url, DAV_AUTH_METHOD: 'basic', DAV_USERNAME: 'u', DAV_PASSWORD: 'p' } as Config;
    const clients = await createDualClients(config, logger);
    const server = createServer(
      new CalendarService(clients.caldav, logger, config),
      new AddressBookService(clients.carddav, logger),
      logger,
      undefined,
      undefined,
      'Europe/Paris',
    );
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
    dav.handler = () => null;
    dav.requests.length = 0;
  });

  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const result = await client.callTool({ name, arguments: args });
    return { isError: result.isError, text: (result as { content: Array<{ text: string }> }).content[0].text };
  };
  const reports = () => dav.requests.filter((r) => r.method === 'REPORT');

  describe('check_availability', () => {
    const freeBusy = (period?: string) => ({
      status: 200,
      headers: { 'content-type': 'text/calendar' },
      body: `BEGIN:VCALENDAR\r\nVERSION:2.0\r\nBEGIN:VFREEBUSY\r\n${period ? `FREEBUSY:${period}\r\n` : ''}END:VFREEBUSY\r\nEND:VCALENDAR\r\n`,
    });
    const range = { start: '2026-11-03T10:00:00Z', end: '2026-11-03T12:00:00Z' };

    it('reads every calendar and sees a meeting in the second one', async () => {
      dav.handler = (req) => {
        if (req.method !== 'REPORT') return null;
        return req.url.includes('/Pro/') ? freeBusy('20261103T100000Z/20261103T110000Z') : freeBusy();
      };
      const { text } = await call('check_availability', range);
      expect(reports()).toHaveLength(2);
      expect(text).toContain('1 busy period');
    });

    it('reads only the named calendar', async () => {
      dav.handler = (req) => (req.method === 'REPORT' ? freeBusy() : null);
      const { text } = await call('check_availability', { ...range, calendar: 'Pro' });
      expect(reports().map((r) => r.url)).toEqual(['/calendars/u1/Pro/']);
      expect(text).toContain('You are free');
    });

    it('falls back to events when a server has no free-busy-query', async () => {
      dav.handler = (req) => {
        if (req.method !== 'REPORT') return null;
        if (req.body.includes('free-busy-query')) return { status: 501 };
        return req.url.includes('/Pro/')
          ? calendarObjects([{ href: '/calendars/u1/Pro/a.ics', ical: ical('a', '20261103T100000Z') }])
          : calendarObjects([]);
      };
      expect((await call('check_availability', range)).text).toContain('1 busy period');
    });

    it('does not say free when one calendar fails', async () => {
      dav.handler = (req) => {
        if (req.method !== 'REPORT') return null;
        return req.url.includes('/Pro/') ? { status: 500 } : freeBusy();
      };
      const { isError, text } = await call('check_availability', range);
      expect(isError).toBe(true);
      expect(text).toContain('HTTP 500');
    });

    it.each([
      ['an unreadable object', 'not ical'],
      ['an invalid RRULE', ical('bad', '20261103T100000Z').replace('SUMMARY', 'RRULE:FREQ=NOPE\r\nSUMMARY')],
    ])('does not say free with %s on the fallback', async (_label, data) => {
      dav.handler = (req) => {
        if (req.method !== 'REPORT') return null;
        if (req.body.includes('free-busy-query')) return { status: 501 };
        return calendarObjects([{ href: '/calendars/u1/Perso/bad.ics', ical: data }]);
      };
      const { isError, text } = await call('check_availability', range);
      expect(isError).toBe(true);
      expect(text).not.toContain('You are free');
    });

    it('refuses natural language', async () => {
      const { isError, text } = await call('check_availability', { start: 'Thursday afternoon', end: 'Friday' });
      expect(isError).toBe(true);
      expect(text).toContain('ISO 8601');
    });
  });

  it('search_events finds a match beyond the first events of the range', async () => {
    const objects = Array.from({ length: 120 }, (_, i) => ({
      href: `/calendars/u1/Perso/e${i}.ics`,
      ical: ical(`e${i}`, isoBasic(new Date(Date.UTC(2026, 10, 3, 8, i))), i === 90 ? 'needle' : `other ${i}`),
    }));
    dav.handler = (req) => {
      if (req.method !== 'REPORT') return null;
      return req.url.includes('/Perso/') ? calendarObjects(objects) : calendarObjects([]);
    };
    const { text } = await call('search_events', { query: 'needle', start: '2026-11-03', end: '2026-11-03' });
    expect(text).toContain('UID: e90');
    expect(text).toContain('No more events');
  });

  it('get_next_event stops at the first window with an event', async () => {
    const soon = isoBasic(new Date(Date.now() + 3 * 86_400_000));
    dav.handler = (req) => {
      if (req.method !== 'REPORT') return null;
      return req.url.includes('/Perso/') && req.body.includes(`end="${soon.slice(0, 4)}`)
        ? calendarObjects([{ href: '/calendars/u1/Perso/n.ics', ical: ical('n', soon) }])
        : calendarObjects([]);
    };
    const { text } = await call('get_next_event');
    expect(text).toContain('UID: n');
    // First window of one day, then seven days: two calendars each, no wider.
    expect(reports().length).toBeLessThanOrEqual(4);
    const spans = reports().map((r) => /start="(\d+)T.*?end="(\d+)T/.exec(r.body)!);
    expect(spans.every((s) => Number(s[2]) - Number(s[1]) < 100)).toBe(true);
  });

  it.each(['get_events_in_range', 'search_events'])('%s refuses the old when, instead of ignoring it', async (name) => {
    const result = await client.callTool({ name, arguments: { query: 'x', when: 'next month' } });
    expect(result.isError).toBe(true);
    expect((result as { content: Array<{ text: string }> }).content[0].text).toContain('pass start and end');
  });

  it('get_next_event says how far it looked', async () => {
    dav.handler = (req) => (req.method === 'REPORT' ? calendarObjects([]) : null);
    expect((await call('get_next_event')).text).toBe('No upcoming events found in the next 365 days');
  });
});

describe('a calendar created after startup', () => {
  it('is seen within a minute', async () => {
    const dav = await startFakeDav(['Perso']);
    const config = { DAV_URL: dav.url, DAV_AUTH_METHOD: 'basic', DAV_USERNAME: 'u', DAV_PASSWORD: 'p' } as Config;
    const clients = await createDualClients(config, logger);
    const service = new CalendarService(clients.caldav, logger, config);
    const names = async () => (await service.listCalendars()).map((c) => c.displayName);
    expect(await names()).toEqual(['Perso']);

    dav.handler = (req) => {
      if (req.method !== 'PROPFIND' || req.url !== '/calendars/u1/') return null;
      const xml = (name: string) => `<d:response><d:href>/calendars/u1/${name}/</d:href><d:propstat><d:prop><d:displayname>${name}</d:displayname><d:resourcetype><d:collection/><c:calendar/></d:resourcetype><c:supported-calendar-component-set><c:comp name="VEVENT"/></c:supported-calendar-component-set><cs:getctag>1</cs:getctag></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>`;
      return { status: 207, headers: { 'content-type': 'application/xml' }, body: `<d:multistatus xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav" xmlns:cs="http://calendarserver.org/ns/">${xml('Perso')}${xml('New')}</d:multistatus>` };
    };
    expect(await names()).toEqual(['Perso']);
    const now = Date.now();
    const clock = vi.spyOn(Date, 'now').mockReturnValue(now + 61_000);
    expect(await names()).toEqual(['Perso', 'New']);
    clock.mockRestore();
    await dav.close();
  });
});
