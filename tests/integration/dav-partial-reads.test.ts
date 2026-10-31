/**
 * A calendar without read rights and objects the server left out: the rest of the
 * result comes back, and the model is told what is missing.
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
import { addressObjects, calendarObjects, startFakeDav, type DavRequest, type FakeDav } from '../helpers/fake-dav.js';

const logger = pino({ level: 'silent' });
const XML = { 'content-type': 'application/xml' };
const multistatus = (inner: string) => ({
  status: 207,
  headers: XML,
  body: `<d:multistatus xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">${inner}</d:multistatus>`,
});
// What esn-sabre answers on a calendar this account cannot read.
const refused = multistatus(
  '<d:response><d:href>/calendars/u1/Shared/x.ics</d:href><d:propstat><d:prop><d:getetag/></d:prop><d:status>HTTP/1.1 403 Forbidden</d:status></d:propstat></d:response>'
);
// Starting now is today in the time zone of any machine.
const now = `${new Date().toISOString().slice(0, 19).replace(/[-:]/g, '')}Z`;
const ical = `BEGIN:VCALENDAR\r\nVERSION:2.0\r\nBEGIN:VEVENT\r\nUID:a\r\nDTSTAMP:20260101T000000Z\r\nDTSTART:${now}\r\nDURATION:PT1H\r\nSUMMARY:a\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n`;
const readable = (req: DavRequest) =>
  req.body.includes('calendar-multiget') || req.body.includes('calendar-data')
    ? calendarObjects([{ href: '/calendars/u1/Perso/a.ics', ical }])
    : multistatus('<d:response><d:href>/calendars/u1/Perso/a.ics</d:href><d:propstat><d:prop><d:getetag>"a"</d:getetag></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>');

describe('partial reads', () => {
  let dav: FakeDav;
  let client: Client;

  beforeAll(async () => {
    dav = await startFakeDav(['Perso', 'Shared']);
    const config = { DAV_URL: dav.url, DAV_AUTH_METHOD: 'basic', DAV_USERNAME: 'u', DAV_PASSWORD: 'p' } as Config;
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
    return { isError: result.isError, text: (result.content as Array<{ text: string }>).map((c) => c.text).join('\n') };
  };

  it('reads the other calendars and names the one without rights', async () => {
    dav.handler = (req) => {
      if (req.method !== 'REPORT') return null;
      return req.url.includes('/Shared/') ? refused : readable(req);
    };
    const { isError, text } = await call('get_todays_schedule');
    expect(isError).toBeFalsy();
    expect(text).toContain('UID: a');
    expect(text).toContain('incomplete');
    expect(text).toContain('"Shared"');
    expect(text).not.toMatch(/token|password/i);
  });

  it('is an error when no calendar can be read, without blaming the token', async () => {
    dav.handler = (req) => (req.method === 'REPORT' ? refused : null);
    const { isError, text } = await call('get_todays_schedule');
    expect(isError).toBe(true);
    expect(text).toContain('HTTP 403');
    expect(text).not.toMatch(/token|password/i);
  });

  it('is an error when the named calendar cannot be read', async () => {
    dav.handler = (req) => (req.method === 'REPORT' ? refused : null);
    const { isError, text } = await call('get_todays_schedule', { calendar: 'Shared' });
    expect(isError).toBe(true);
    expect(text).toContain('"Shared"');
  });

  it('check_availability names the only calendar when it refuses', async () => {
    dav.handler = (req) => {
      if (req.method !== 'REPORT') return null;
      return req.body.includes('free-busy-query') ? { status: 403 } : refused;
    };
    const { isError, text } = await call('check_availability', { start: '2020-01-01T00:00:00Z', end: '2020-01-02T00:00:00Z', calendar: 'Shared' });
    expect(isError).toBe(true);
    expect(text).toContain('"Shared"');
  });

  it('check_availability does not say free when a calendar cannot be read', async () => {
    dav.handler = (req) => {
      if (req.method !== 'REPORT') return null;
      if (req.body.includes('free-busy-query')) return req.url.includes('/Shared/') ? { status: 403 } : { status: 501 };
      return req.url.includes('/Shared/') ? refused : readable(req);
    };
    const { isError, text } = await call('check_availability', { start: '2020-01-01T00:00:00Z', end: '2020-01-02T00:00:00Z' });
    expect(isError).toBe(true);
    expect(text).not.toContain('You are free');
    expect(text).toContain('unknown');
  });

  it('an object left out of a multiget is a warning, not an invented 404', async () => {
    const vcard = 'BEGIN:VCARD\r\nVERSION:3.0\r\nUID:a\r\nFN:Alice\r\nEND:VCARD\r\n';
    dav.handler = (req) => {
      if (req.method !== 'REPORT') return null;
      return req.body.includes('addressbook-multiget')
        ? addressObjects([{ href: '/addressbooks/u1/contacts/a.vcf', vcard }])
        : addressObjects([{ href: '/addressbooks/u1/contacts/a.vcf', vcard: 'x' }, { href: '/addressbooks/u1/contacts/gone.vcf', vcard: 'x' }]);
    };
    const { isError, text } = await call('list_contacts');
    expect(isError).toBeFalsy();
    expect(text).toContain('Alice');
    expect(text).toContain('did not return 1 object');
    expect(text).toContain('gone.vcf');
    expect(text).not.toContain('HTTP 404');
  });

  it('an unknown property in a propstat is no failure when the data came back', async () => {
    dav.handler = (req) =>
      req.method === 'REPORT'
        ? multistatus(`<d:response><d:href>/calendars/u1/Perso/a.ics</d:href><d:propstat><d:prop><d:getetag>"a"</d:getetag><c:calendar-data>${ical}</c:calendar-data></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat><d:propstat><d:prop><d:other/></d:prop><d:status>HTTP/1.1 404 Not Found</d:status></d:propstat></d:response>`)
        : null;
    const { text } = await call('get_todays_schedule');
    expect(text).toContain('UID: a');
    expect(text).not.toContain('incomplete');
  });

  it('a refused calendar-data is a failure even when the etag came back', async () => {
    dav.handler = (req) =>
      req.method === 'REPORT'
        ? multistatus('<d:response><d:href>/calendars/u1/Perso/a.ics</d:href><d:propstat><d:prop><d:getetag>"a"</d:getetag></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat><d:propstat><d:prop><c:calendar-data/></d:prop><d:status>HTTP/1.1 500 Oops</d:status></d:propstat></d:response>')
        : null;
    const { isError } = await call('get_todays_schedule', { calendar: 'Perso' });
    expect(isError).toBe(true);
  });

  it.each([
    ['a status', '<d:status>HTTP/1.1 500 Oops</d:status>'],
    ['a closing tag', '</c:calendar-data></d:prop></d:propstat></d:response><d:response><d:href>x</d:href><d:status>HTTP/1.1 500 Oops</d:status></d:response>'],
  ])('does not read %s in a CDATA as a failure', async (_label, text) => {
    const tricky = ical.replace('SUMMARY:a', `SUMMARY:${text}`);
    dav.handler = (req) =>
      req.method === 'REPORT'
        ? multistatus(`<d:response><d:href>/calendars/u1/Perso/a.ics</d:href><d:propstat><d:prop><d:getetag>"a"</d:getetag><c:calendar-data><![CDATA[${tricky}]]></c:calendar-data></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>`)
        : null;
    const result = await call('get_todays_schedule', { calendar: 'Perso' });
    expect(result.isError).toBeFalsy();
    expect(result.text).not.toContain('incomplete');
  });
});
