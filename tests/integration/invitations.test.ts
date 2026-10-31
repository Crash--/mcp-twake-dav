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
