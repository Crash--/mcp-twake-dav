/**
 * UID lookup against the real tsdav: the JSON API of esn-sabre when the server
 * has it, a bounded calendar-query otherwise, and never a read of whole calendars.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import pino from 'pino';
import { createDualClients, type DAVClientType } from '../../src/caldav/client.js';
import { CalendarService } from '../../src/caldav/calendar-service.js';
import type { Config } from '../../src/config/schema.js';
import { calendarObjects, startFakeDav, type DavRequest, type DavReply, type FakeDav } from '../helpers/fake-dav.js';

const logger = pino({ level: 'silent' });
const JSON_HEADERS = { 'content-type': 'application/json' };
// An unescaped comma: sabre cuts this text in its JSON answer, so only the raw object is whole.
const raw = (uid: string) => `BEGIN:VCALENDAR\r\nVERSION:2.0\r\nBEGIN:VEVENT\r\nUID:${uid}\r\nDTSTAMP:20260101T000000Z\r\nDTSTART:20261103T100000Z\r\nDTEND:20261103T110000Z\r\nSUMMARY:Found\r\nDESCRIPTION:First part, second part\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n`;
const found = (href: string): DavReply => ({
  status: 200,
  headers: JSON_HEADERS,
  body: JSON.stringify({ _embedded: { 'dav:item': [{ _links: { self: { href } }, etag: '"json"', data: ['vcalendar', [], [['vevent', [['uid', {}, 'text', 'cut']], []]]] }] } }),
});

describe('findEventByUid', () => {
  let dav: FakeDav;
  let client: DAVClientType;
  let config: Config;

  beforeAll(async () => {
    dav = await startFakeDav(['Perso', 'Pro']);
    config = { DAV_URL: dav.url, DAV_AUTH_METHOD: 'basic', DAV_USERNAME: 'u', DAV_PASSWORD: 'p' } as Config;
    client = (await createDualClients(config, logger)).caldav;
  });

  afterAll(async () => {
    await dav.close();
  });

  beforeEach(() => {
    dav.handler = () => null;
    dav.requests.length = 0;
  });

  const service = () => new CalendarService(client, logger, config);
  const reports = () => dav.requests.filter((r) => r.method === 'REPORT');

  /** A Twake home: `onUid` answers the JSON lookup, `objects` the GET, `queries` the calendar queries by path. */
  const twake = (onUid: () => DavReply, objects: Record<string, string> = {}, queries: (req: DavRequest) => DavReply = () => calendarObjects([])) => {
    dav.handler = (req) => {
      if (req.url === '/calendars/u1.json') {
        return req.method === 'GET' ? { status: 200, headers: JSON_HEADERS, body: '{}' } : onUid();
      }
      if (req.method === 'GET') {
        const body = objects[req.url];
        return body ? { status: 200, headers: { 'content-type': 'text/calendar', etag: '"raw"' }, body } : { status: 404 };
      }
      return req.method === 'REPORT' ? queries(req) : null;
    };
  };

  it('finds an event through the JSON API, then reads the object as stored', async () => {
    twake(() => found('/calendars/u1/Perso/x.ics'), { '/calendars/u1/Perso/x.ics': raw('a') });
    const event = await service().findEventByUid('a');
    expect(event?.url).toBe(`${dav.url}calendars/u1/Perso/x.ics`);
    expect(event?.etag).toBe('"raw"');
    expect(event?._raw).toContain('First part, second part');
  });

  it('accepts a colon in the name of the object', async () => {
    twake(() => found('/calendars/u1/Perso/urn:uuid:abc.ics'), { '/calendars/u1/Perso/urn:uuid:abc.ics': raw('a') });
    const event = await service().findEventByUid('a');
    expect(event?.url).toBe(`${dav.url}calendars/u1/Perso/urn:uuid:abc.ics`);
  });

  it('answers an unknown UID in one request on the JSON API', async () => {
    twake(() => ({ status: 404 }));
    const calendars = service();
    await expect(calendars.findEventByUid('absent')).resolves.toBeNull();
    expect(reports()).toHaveLength(1);

    await calendars.findEventByUid('absent-2');
    expect(dav.requests.filter((r) => r.method === 'GET')).toHaveLength(1);
  });

  it('finds the copy in the calendar asked, when the server names another one', async () => {
    twake(() => found('/calendars/u1/Pro/other.ics'), {}, (req) =>
      req.url === '/calendars/u1/Perso/' ? calendarObjects([{ href: '/calendars/u1/Perso/mine.ics', ical: raw('dup') }]) : calendarObjects([])
    );
    const event = await service().findEventByUid('dup', 'Perso');
    expect(event?.url).toBe(`${dav.url}calendars/u1/Perso/mine.ics`);
    expect(reports().at(-1)?.body).not.toContain('time-range');
  });

  it('says not found when the calendar asked holds no copy', async () => {
    twake(() => found('/calendars/u1/Pro/other.ics'));
    await expect(service().findEventByUid('dup', 'Perso')).resolves.toBeNull();
  });

  it('does not choose between two copies without a calendar name', async () => {
    twake(
      () => found('/calendars/u1/Perso/a.ics'),
      { '/calendars/u1/Perso/a.ics': raw('dup') },
      (req) => (req.url === '/calendars/u1/Pro/' ? calendarObjects([{ href: '/calendars/u1/Pro/b.ics', ical: raw('dup') }]) : calendarObjects([])),
    );
    await expect(service().findEventByUid('dup')).rejects.toThrow(/several calendars: "Perso", "Pro"/);
  });

  it('asks the other calendars only when the UID exists', async () => {
    twake(() => found('/calendars/u1/Perso/a.ics'), { '/calendars/u1/Perso/a.ics': raw('a') });
    await expect(service().findEventByUid('a')).resolves.toMatchObject({ uid: 'a' });
    expect(reports().map((r) => r.url)).toEqual(['/calendars/u1.json', '/calendars/u1/Pro/']);
  });

  it('reports a failing JSON API as an error', async () => {
    twake(() => ({ status: 500 }));
    await expect(service().findEventByUid('a')).rejects.toThrow('HTTP 500');
  });

  it('reports a failing read of the object as an error', async () => {
    dav.handler = (req) => {
      if (req.url === '/calendars/u1.json') {
        return req.method === 'GET' ? { status: 200, headers: JSON_HEADERS, body: '{}' } : found('/calendars/u1/Perso/x.ics');
      }
      return req.method === 'GET' ? { status: 500 } : null;
    };
    await expect(service().findEventByUid('a')).rejects.toThrow('HTTP 500');
  });

  it.each([
    ['an HTML page', { status: 200, headers: { 'content-type': 'text/html' }, body: '<html>login</html>' }],
    ['an empty body', { status: 200, headers: { 'content-type': 'text/calendar' } }],
    ['text that is no event', { status: 200, headers: { 'content-type': 'text/calendar' }, body: 'not ical' }],
  ])('reports %s on the read of the object, not "not found"', async (_label, reply) => {
    dav.handler = (req) => {
      if (req.url === '/calendars/u1.json') {
        return req.method === 'GET' ? { status: 200, headers: JSON_HEADERS, body: '{}' } : found('/calendars/u1/Perso/x.ics');
      }
      return req.method === 'GET' ? reply : null;
    };
    await expect(service().findEventByUid('a')).rejects.toThrow('The DAV server answered');
  });

  it.each([401, 403, 429, 500])('a probe in %i is an error, and the API is asked again next time', async (status) => {
    let fail = true;
    dav.handler = (req) => {
      if (req.url !== '/calendars/u1.json') return null;
      if (req.method === 'REPORT') return { status: 404 };
      return fail ? { status, headers: { 'retry-after': '0' } } : { status: 200, headers: JSON_HEADERS, body: '{}' };
    };
    const calendars = service();
    await expect(calendars.findEventByUid('a')).rejects.toThrow(`HTTP ${status}`);
    fail = false;
    await expect(calendars.findEventByUid('a')).resolves.toBeNull();
  }, 15000);

  it.each([
    ['a 404', { status: 404 }],
    ['an HTML page', { status: 200, headers: { 'content-type': 'text/html' }, body: '<html/>' }],
  ])('%s on the probe means another server, with a bounded UID query in every calendar', async (_label, probe) => {
    dav.handler = (req) => {
      if (req.method === 'GET') return probe;
      return req.method === 'REPORT'
        ? { status: 207, headers: { 'content-type': 'application/xml' }, body: '<d:multistatus xmlns:d="DAV:"></d:multistatus>' }
        : null;
    };
    await expect(service().findEventByUid('absent')).rejects.toThrow('within 2 years');
    expect(reports().map((r) => r.url)).toEqual(['/calendars/u1/Perso/', '/calendars/u1/Pro/']);
    for (const report of reports()) {
      expect(report.body).toContain('name="UID"');
      expect(report.body).toContain('time-range');
    }
  });

  it('refuses two copies on another server too', async () => {
    dav.handler = (req) => {
      if (req.method === 'GET') return { status: 404 };
      return req.method === 'REPORT' ? calendarObjects([{ href: `${req.url}a.ics`, ical: raw('dup') }]) : null;
    };
    await expect(service().findEventByUid('dup')).rejects.toThrow('several calendars');
  });

  it('refuses an unknown calendar name', async () => {
    await expect(service().findEventByUid('a', 'Nope')).rejects.toThrow('"Nope" not found');
  });
});
