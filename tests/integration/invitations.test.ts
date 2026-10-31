/**
 * Invitations against the real tsdav: the attendee's copy in the calendar is what
 * is listed and answered, and the server is always asked.
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
import { calendarObjects, startFakeDav, type FakeDav, type DavRequest } from '../helpers/fake-dav.js';

const logger = pino({ level: 'silent' });
const ME = 'me@example.com';
const ical = (uid: string, attendees: string) =>
  `BEGIN:VCALENDAR\r\nVERSION:2.0\r\nBEGIN:VEVENT\r\nUID:${uid}\r\nDTSTAMP:20260101T000000Z\r\nDTSTART:20261103T100000Z\r\nDTEND:20261103T110000Z\r\nSUMMARY:${uid}\r\nORGANIZER;CN=Boss:mailto:boss@example.com\r\n${attendees}END:VEVENT\r\nEND:VCALENDAR\r\n`;
const attendee = (email: string, partstat: string) => `ATTENDEE;PARTSTAT=${partstat}:mailto:${email}\r\n`;
const XML = { 'content-type': 'application/xml' };

function addressSet(req: DavRequest) {
  return req.method === 'PROPFIND' && req.body.includes('calendar-user-address-set')
    ? {
        status: 207,
        headers: XML,
        body: `<d:multistatus xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav"><d:response><d:href>${req.url}</d:href><d:propstat><d:prop><c:calendar-user-address-set><d:href>mailto:${ME}</d:href><d:href>/principals/u1/</d:href></c:calendar-user-address-set></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response></d:multistatus>`,
      }
    : null;
}

describe('invitations', () => {
  let dav: FakeDav;
  let client: Client;

  beforeAll(async () => {
    dav = await startFakeDav();
    const config = { DAV_URL: dav.url, DAV_AUTH_METHOD: 'bearer', DAV_TOKEN: 't' } as Config;
    const clients = await createDualClients(config, logger);
    const server = createServer(new CalendarService(clients.caldav, logger, config), new AddressBookService(clients.carddav, logger), logger);
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

  it('asks the server and keeps only what this user has not answered', async () => {
    dav.handler = (req) => addressSet(req) ?? (req.method === 'REPORT'
      ? calendarObjects([
          { href: '/calendars/u1/Perso/a.ics', ical: ical('mine', attendee(ME, 'NEEDS-ACTION')) },
          { href: '/calendars/u1/Perso/b.ics', ical: ical('answered', attendee(ME, 'ACCEPTED') + attendee('x@example.com', 'NEEDS-ACTION')) },
          { href: '/calendars/u1/Perso/c.ics', ical: ical('organised', attendee('x@example.com', 'NEEDS-ACTION')) },
        ])
      : null);
    const { text } = await call('list_invitations');
    expect(text).toContain('UID: mine');
    expect(text).not.toContain('UID: answered');
    expect(text).not.toContain('UID: organised');
    const [report] = dav.requests.filter((r) => r.method === 'REPORT');
    expect(report.url).toBe('/calendars/u1/Perso/');
    expect(report.body).toContain('time-range');
    expect(report.body).toContain('NEEDS-ACTION');
    expect(report.body).toContain('calendar-query');
  });

  it('reports a failing query as an error, not as no invitation', async () => {
    dav.handler = (req) => addressSet(req) ?? (req.method === 'REPORT' ? { status: 500 } : null);
    const { isError, text } = await call('list_invitations');
    expect(isError).toBe(true);
    expect(text).toContain('HTTP 500');
  });

  it('says which range it read when there is no invitation', async () => {
    dav.handler = (req) => addressSet(req) ?? (req.method === 'REPORT' ? calendarObjects([]) : null);
    const { isError, text } = await call('list_invitations', { start: '2026-11-01T00:00:00Z', end: '2026-11-02T00:00:00Z' });
    expect(isError).toBeFalsy();
    expect(text).toContain('between 2026-11-01');
    expect(dav.requests.some((r) => r.method === 'REPORT')).toBe(true);
  });

  it('refuses a range above the maximum without asking', async () => {
    const { isError } = await call('list_invitations', { start: '2026-01-01T00:00:00Z', end: '2027-01-01T00:00:00Z' });
    expect(isError).toBe(true);
  });

  it('answers on the event in the calendar, with its ETag', async () => {
    const raw = ical('mine', attendee(ME, 'NEEDS-ACTION'));
    dav.handler = (req, res) => {
      if (req.method === 'GET') return { status: 404 };
      if (req.method === 'PUT') {
        res.setHeader('etag', '"new"');
        return { status: 204 };
      }
      return addressSet(req) ?? (req.method === 'REPORT' ? calendarObjects([{ href: '/calendars/u1/Perso/a.ics', ical: raw }]) : null);
    };
    const { isError, text } = await call('respond_to_invitation', { uid: 'mine', response: 'accept' });
    expect(isError).toBeFalsy();
    expect(text).toContain('accepted');
    const put = dav.requests.find((r) => r.method === 'PUT')!;
    expect(put.url).toBe('/calendars/u1/Perso/a.ics');
    expect(put.headers['if-match']).toContain('/calendars/u1/Perso/a.ics');
    expect(put.body.replace(/\r\n /g, '')).toContain('PARTSTAT=ACCEPTED');
  });

  it('refuses to answer an event this user is not invited to', async () => {
    dav.handler = (req) => {
      if (req.method === 'GET') return { status: 404 };
      return addressSet(req) ?? (req.method === 'REPORT' ? calendarObjects([{ href: '/calendars/u1/Perso/a.ics', ical: ical('other', attendee('x@example.com', 'NEEDS-ACTION')) }]) : null);
    };
    const { isError, text } = await call('respond_to_invitation', { uid: 'other', response: 'accept' });
    expect(isError).toBe(true);
    expect(text).toContain('not an attendee');
    expect(dav.requests.some((r) => r.method === 'PUT')).toBe(false);
  });
});

describe('invitations with several VEVENTs and delegated calendars', () => {
  let dav: FakeDav;
  let client: Client;

  beforeAll(async () => {
    dav = await startFakeDav(['Perso', 'Boss']);
    const config = { DAV_URL: dav.url, DAV_AUTH_METHOD: 'bearer', DAV_TOKEN: 't' } as Config;
    const clients = await createDualClients(config, logger);
    const server = createServer(new CalendarService(clients.caldav, logger, config), new AddressBookService(clients.carddav, logger), logger, undefined, undefined, 'Europe/Paris');
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

  const vevent = (...lines: string[]) => ['BEGIN:VEVENT', 'UID:s', 'DTSTAMP:20260101T000000Z', 'SUMMARY:series', 'ORGANIZER:mailto:boss@example.com', ...lines, 'END:VEVENT'];
  const object = (...vevents: string[][]) => ['BEGIN:VCALENDAR', 'VERSION:2.0', ...vevents.flat(), 'END:VCALENDAR', ''].join('\r\n');
  const me = (partstat: string) => `ATTENDEE;PARTSTAT=${partstat}:mailto:${ME}`;
  const master = (partstat: string, start = '20200101T100000Z') => vevent(`DTSTART:${start}`, 'DURATION:PT1H', 'RRULE:FREQ=DAILY', me(partstat));
  const exception = (partstat: string, ...lines: string[]) =>
    vevent('RECURRENCE-ID:20261105T100000Z', 'DTSTART:20261105T150000Z', 'DURATION:PT1H', 'SUMMARY:moved', me(partstat), ...lines);

  /** Serves `data` from the Perso calendar, and the owner of each calendar. */
  const serve = (data: string, delegated?: string) => {
    dav.handler = (req, res) => {
      const owner = addressSet(req);
      if (owner) return owner;
      if (req.method === 'PROPFIND' && req.body.includes('owner')) {
        const who = req.url.includes('/Boss/') ? '/principals/boss/' : '/principals/u1/';
        return { status: 207, headers: XML, body: `<d:multistatus xmlns:d="DAV:"><d:response><d:href>${req.url}</d:href><d:propstat><d:prop><d:owner><d:href>${who}</d:href></d:owner></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response></d:multistatus>` };
      }
      if (req.method === 'PUT') {
        res.setHeader('etag', '"new"');
        return { status: 204 };
      }
      if (req.method !== 'REPORT') return null;
      if (req.url.includes('/Boss/')) return calendarObjects(delegated ? [{ href: '/calendars/u1/Boss/copy.ics', ical: delegated }] : []);
      return calendarObjects([{ href: '/calendars/u1/Perso/a.ics', ical: data }]);
    };
  };
  const list = async (args: Record<string, unknown> = { start: '2026-11-01', end: '2026-11-30' }) =>
    ((await client.callTool({ name: 'list_invitations', arguments: args })).content as Array<{ text: string }>).map((c) => c.text).join('\n');
  const answer = async () => {
    const result = await client.callTool({ name: 'respond_to_invitation', arguments: { uid: 's', response: 'accept' } });
    return { isError: result.isError, text: (result.content as Array<{ text: string }>)[0].text };
  };

  describe('what the answer says about the organizer', () => {
    const plain = (...lines: string[]) => object(['BEGIN:VEVENT', 'UID:s', 'DTSTAMP:20260101T000000Z', 'SUMMARY:one', 'DTSTART:20261105T100000Z', 'DURATION:PT1H', me('NEEDS-ACTION'), ...lines, 'END:VEVENT']);

    it('says the server sends it on a plain invitation', async () => {
      serve(plain('ORGANIZER:mailto:boss@example.com'));
      expect((await answer()).text).toContain('the server sends it to the organizer.');
    });

    it('warns on a series with an exception', async () => {
      serve(object(master('NEEDS-ACTION'), exception('NEEDS-ACTION')));
      expect((await answer()).text).toContain('may not see it');
    });

    it('says nothing about an organizer when there is none', async () => {
      serve(plain());
      const { text } = await answer();
      expect(text).not.toMatch(/organizer/i);
      expect(text).toContain('saved on your copy');
    });

    it('says nothing about an organizer when it is the user', async () => {
      serve(plain(`ORGANIZER:mailto:${ME}`));
      expect((await answer()).text).not.toContain('sends it to the organizer');
    });
  });

  it('lists an invitation to a single occurrence, without its master', async () => {
    serve(object(exception('NEEDS-ACTION')));
    const text = await list();
    expect(text).toContain('(one occurrence of a series)');
  });

  it('lists an exception waiting when the series is answered', async () => {
    serve(object(master('ACCEPTED'), exception('NEEDS-ACTION')));
    const text = await list();
    expect(text).toContain('Pending invitations (1 in this page)');
    expect(text).toContain('(one occurrence of a series)');
  });

  it('does not list what was cancelled', async () => {
    serve(object(vevent('DTSTART:20261105T100000Z', 'DURATION:PT1H', 'STATUS:CANCELLED', me('NEEDS-ACTION'))));
    expect(await list()).toContain('No pending invitations');
  });

  it('shows a series at its next date in the range, not at its first', async () => {
    serve(object(master('NEEDS-ACTION')));
    const text = await list();
    expect(text).toContain('11/1/2026');
    expect(text).not.toContain('2020');
  });

  it('answers the series and the occurrences still waiting, not the others', async () => {
    const other = vevent('RECURRENCE-ID:20261106T100000Z', 'DTSTART:20261106T100000Z', 'DURATION:PT1H', me('DECLINED'));
    serve(object(master('NEEDS-ACTION'), exception('NEEDS-ACTION'), other));
    expect((await answer()).isError).toBeFalsy();
    const body = dav.requests.find((r) => r.method === 'PUT')!.body.replace(/\r\n /g, '');
    expect(body.match(/PARTSTAT=ACCEPTED/g)).toHaveLength(2);
    expect(body.match(/PARTSTAT=DECLINED/g)).toHaveLength(1);
    expect(body).not.toContain('NEEDS-ACTION');
  });

  it('answers an invitation to a single occurrence', async () => {
    serve(object(exception('NEEDS-ACTION')));
    expect((await answer()).isError).toBeFalsy();
    expect(dav.requests.find((r) => r.method === 'PUT')!.body.replace(/\r\n /g, '')).toContain('PARTSTAT=ACCEPTED');
  });

  it('answers on its own copy, never on the delegated one', async () => {
    serve(object(master('NEEDS-ACTION')), object(master('NEEDS-ACTION')));
    expect((await answer()).isError).toBeFalsy();
    expect(dav.requests.filter((r) => r.method === 'PUT').map((r) => r.url)).toEqual(['/calendars/u1/Perso/a.ics']);
    expect(dav.requests.filter((r) => r.method === 'REPORT').some((r) => r.url.includes('/Boss/'))).toBe(false);
  });

  it('does not list the copy of a delegated calendar', async () => {
    serve(object(master('ACCEPTED')), object(master('NEEDS-ACTION')));
    expect(await list()).toContain('No pending invitations');
  });

  it('reads dates in the user time zone', async () => {
    serve(object(vevent('DTSTART:20261105T100000Z', 'DURATION:PT1H', me('NEEDS-ACTION'))));
    expect(await list({ start: '2026-11-05', end: '2026-11-05' })).toContain('11:00:00 AM');
  });

  it('warns about an object it cannot read, since it may be an invitation', async () => {
    serve('not ical');
    const text = await list();
    expect(text).toContain('a.ics');
    expect(text).toContain('incomplete');
  });
});
