/**
 * Every DAV failure must reach the model as an error, never as an empty result.
 * Runs the real tsdav against a local server so its status handling is covered.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import pino from 'pino';
import { createDualClients } from '../../src/caldav/client.js';
import { CalendarService } from '../../src/caldav/calendar-service.js';
import { AddressBookService } from '../../src/caldav/addressbook-service.js';
import { createServer } from '../../src/server.js';
import type { Config } from '../../src/config/schema.js';
import { addressObjects, calendarObjects, startFakeDav, type FakeDav } from '../helpers/fake-dav.js';
import { runToolCall } from '../../src/caldav/dav-fetch.js';

const logger = pino({ level: 'silent' });

describe('DAV failures reach the model', () => {
  let dav: FakeDav;
  let client: Client;

  beforeAll(async () => {
    dav = await startFakeDav();
    const config = { DAV_URL: dav.url, DAV_AUTH_METHOD: 'basic', DAV_USERNAME: 'u', DAV_PASSWORD: 'p' } as Config;
    const clients = await createDualClients(config, logger);
    const server = createServer(
      new CalendarService(clients.caldav, logger, config),
      new AddressBookService(clients.carddav, logger),
      logger,
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

  afterEach(() => {
    vi.restoreAllMocks();
  });

  const text = (r: unknown) => (r as { content: Array<{ text: string }> }).content[0].text;

  async function freshContactTool() {
    const config = { DAV_URL: dav.url, DAV_AUTH_METHOD: 'basic', DAV_USERNAME: 'u', DAV_PASSWORD: 'p' } as Config;
    const clients = await createDualClients(config, logger);
    return {
      service: new AddressBookService(clients.carddav, logger),
      tool: async (service: AddressBookService) => (await service.fetchAllContacts()).map((v) => v.data).join(' '),
      callInToolContext: async (fn: () => Promise<string>) => {
        const result = await runToolCall(new AbortController().signal, async () => ({ content: [{ text: await fn() }] as unknown[] }));
        return { warning: (result.content.at(-1) as { text: string }).text };
      },
    };
  }

  it.each([401, 403, 413, 500])('reports HTTP %i on a calendar query as an error, once', async (status) => {
    dav.handler = (req) => (req.method === 'REPORT' ? { status } : null);
    const result = await client.callTool({ name: 'get_todays_schedule', arguments: {} });
    expect(result.isError).toBe(true);
    expect(text(result)).toContain(`HTTP ${status}`);
    expect(dav.requests.filter((r) => r.method === 'REPORT')).toHaveLength(1);
  });

  it('reports a failing multiget as an error', async () => {
    dav.handler = (req) => {
      if (req.method !== 'REPORT') return null;
      if (req.body.includes('calendar-multiget')) return { status: 413 };
      return {
        status: 207,
        headers: { 'content-type': 'application/xml' },
        body: '<d:multistatus xmlns:d="DAV:"><d:response><d:href>/calendars/u1/Perso/a.ics</d:href><d:propstat><d:prop><d:getetag>"a"</d:getetag></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response></d:multistatus>',
      };
    };
    const result = await client.callTool({ name: 'get_next_event', arguments: {} });
    expect(result.isError).toBe(true);
    expect(text(result)).toContain('HTTP 413');
  });

  it('retries 429 once the server allows it, then succeeds', async () => {
    let calls = 0;
    dav.handler = (req) => {
      if (req.method !== 'REPORT') return null;
      calls++;
      return calls === 1
        ? { status: 429, headers: { 'retry-after': '0' } }
        : { status: 207, headers: { 'content-type': 'application/xml' }, body: '<d:multistatus xmlns:d="DAV:"></d:multistatus>' };
    };
    const result = await client.callTool({ name: 'get_todays_schedule', arguments: {} });
    expect(calls).toBe(2);
    expect(result.isError).toBeFalsy();
  });

  it('gives up on a persistent 503 with an error', async () => {
    dav.handler = (req) => (req.method === 'REPORT' ? { status: 503, headers: { 'retry-after': '0' } } : null);
    const result = await client.callTool({ name: 'get_todays_schedule', arguments: {} });
    expect(result.isError).toBe(true);
    expect(text(result)).toContain('HTTP 503');
    expect(dav.requests.filter((r) => r.method === 'REPORT')).toHaveLength(3);
  }, 15000);

  it('treats an HTML page answered with 200 as an error', async () => {
    dav.handler = (req) =>
      req.method === 'REPORT' ? { status: 200, headers: { 'content-type': 'text/html' }, body: '<html>login</html>' } : null;
    const result = await client.callTool({ name: 'get_todays_schedule', arguments: {} });
    expect(result.isError).toBe(true);
    expect(text(result)).toContain('text/html');
  });

  it('reports a failing contact read as an error', async () => {
    dav.handler = (req) => (req.method === 'REPORT' ? { status: 401 } : null);
    const result = await client.callTool({ name: 'list_contacts', arguments: {} });
    expect(result.isError).toBe(true);
    expect(text(result)).toContain('HTTP 401');
  });

  it('reports an unknown calendar name as an error', async () => {
    const result = await client.callTool({ name: 'get_todays_schedule', arguments: { calendar: 'Nope' } });
    expect(result.isError).toBe(true);
    expect(text(result)).toContain('"Nope" not found');
  });

  const availability = { start: '2026-11-03T10:00:00Z', end: '2026-11-03T11:00:00Z' };
  const ical = 'BEGIN:VCALENDAR\r\nVERSION:2.0\r\nBEGIN:VEVENT\r\nUID:a\r\nDTSTAMP:20260101T000000Z\r\nDTSTART:20261103T100000Z\r\nDURATION:PT1H\r\nSUMMARY:a\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n';
  const objectHref = '/calendars/u1/Perso/a.ics';
  const eventsAnswer = (req: { body: string }) =>
    req.body.includes('calendar-multiget') || req.body.includes('calendar-data')
      ? calendarObjects([{ href: objectHref, ical }])
      : calendarObjects([{ href: objectHref, ical: '' }]);

  it('a failing free-busy query is an error even when events could be read', async () => {
    dav.handler = (req) => {
      if (req.method !== 'REPORT') return null;
      return req.body.includes('free-busy-query') ? { status: 500 } : eventsAnswer(req);
    };
    const result = await client.callTool({ name: 'check_availability', arguments: availability });
    expect(result.isError).toBe(true);
    expect(text(result)).toContain('HTTP 500');
    expect(dav.requests.filter((r) => r.method === 'REPORT')).toHaveLength(1);
  });

  it.each([405, 501])('a server answering %i on free-busy gets the fallback on events', async (status) => {
    dav.handler = (req) => {
      if (req.method !== 'REPORT') return null;
      return req.body.includes('free-busy-query') ? { status } : eventsAnswer(req);
    };
    const result = await client.callTool({ name: 'check_availability', arguments: availability });
    expect(result.isError).toBeFalsy();
    expect(text(result)).toContain('1 busy period');
  });

  it('an empty free-busy answer gets the fallback, not a raw message', async () => {
    dav.handler = (req) => {
      if (req.method !== 'REPORT') return null;
      return req.body.includes('free-busy-query') ? { status: 200, headers: { 'content-type': 'text/calendar' }, body: '' } : eventsAnswer(req);
    };
    const result = await client.callTool({ name: 'check_availability', arguments: availability });
    expect(text(result)).toContain('1 busy period');
  });

  describe('inside a 207', () => {
    const XML = { 'content-type': 'application/xml' };
    const multistatus = (inner: string) => ({
      status: 207,
      headers: XML,
      body: `<d:multistatus xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">${inner}</d:multistatus>`,
    });
    const collectionFailure = (status: number) =>
      multistatus(`<d:response><d:href>/calendars/u1/Perso/</d:href><d:status>HTTP/1.1 ${status} Oops</d:status></d:response>`);
    const objectDenied = (name: string) =>
      `<d:response><d:href>/calendars/u1/Perso/${name}.ics</d:href><d:propstat><d:prop><d:getetag/></d:prop><d:status>HTTP/1.1 403 Forbidden</d:status></d:propstat></d:response>`;
    const objectOk = (name: string, data = '') =>
      `<d:response><d:href>/calendars/u1/Perso/${name}.ics</d:href><d:propstat><d:prop><d:getetag>"e"</d:getetag>${data ? `<c:calendar-data>${data}</c:calendar-data>` : ''}</d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>`;

    it.each([500, 507])('a %i on the collection is an error', async (status) => {
      dav.handler = (req) => (req.method === 'REPORT' ? collectionFailure(status) : null);
      const result = await client.callTool({ name: 'get_todays_schedule', arguments: {} });
      expect(result.isError).toBe(true);
      expect(text(result)).toContain(`HTTP ${status}`);
    });

    it('every object refused, as esn-sabre does without rights, is an error', async () => {
      dav.handler = (req) => (req.method === 'REPORT' ? multistatus(objectDenied('a') + objectDenied('b')) : null);
      const result = await client.callTool({ name: 'get_next_event', arguments: {} });
      expect(result.isError).toBe(true);
      expect(text(result)).toContain('HTTP 403');
    });

    it('a free-busy 207 with an error does not say free', async () => {
      dav.handler = (req) => (req.method === 'REPORT' ? collectionFailure(500) : null);
      const result = await client.callTool({ name: 'check_availability', arguments: availability });
      expect(result.isError).toBe(true);
    });

    it('a carnet in error is not an empty address book', async () => {
      dav.handler = (req) =>
        req.method === 'REPORT'
          ? multistatus('<d:response><d:href>/addressbooks/u1/contacts/</d:href><d:status>HTTP/1.1 500 Oops</d:status></d:response>')
          : null;
      const result = await client.callTool({ name: 'search_contacts', arguments: { name: 'x' } });
      expect(result.isError).toBe(true);
    });

    it('names the object that failed next to the others', async () => {
      dav.handler = (req) => {
        if (req.method !== 'REPORT') return null;
        return multistatus(objectOk('a', ical) + objectDenied('b'));
      };
      const result = await client.callTool({ name: 'get_events_in_range', arguments: { when: '2026-11-03 to 2026-11-04' } });
      expect(result.isError).toBeFalsy();
      expect(text(result)).toContain('UID: a');
      const warning = (result.content as Array<{ text: string }>).at(-1)!.text;
      expect(warning).toContain('incomplete');
      expect(warning).toContain('b.ics');
    });

    it('does not mistake event text for a status', async () => {
      const tricky = ical.replace('SUMMARY:a', 'SUMMARY:HTTP/1.1 500 in the title');
      dav.handler = (req) => (req.method === 'REPORT' ? multistatus(objectOk('a', tricky)) : null);
      const result = await client.callTool({ name: 'get_events_in_range', arguments: { when: '2026-11-03 to 2026-11-04' } });
      expect(result.isError).toBeFalsy();
      expect(result.content as unknown[]).toHaveLength(1);
    });
  });

  it.each([
    ['a 204', { status: 204 }],
    ['an empty 207', { status: 207, headers: { 'content-type': 'application/xml' } }],
    ['XML without multistatus', { status: 200, headers: { 'content-type': 'application/xml' }, body: '<a/>' }],
    ['a truncated multistatus', { status: 207, headers: { 'content-type': 'application/xml' }, body: '<d:multistatus xmlns:d="DAV:"><d:response>' }],
    ['JSON', { status: 200, headers: { 'content-type': 'application/json' }, body: '{}' }],
  ])('%s on a REPORT is an error, sent once', async (_label, reply) => {
    dav.handler = (req) => (req.method === 'REPORT' ? reply : null);
    const result = await client.callTool({ name: 'get_todays_schedule', arguments: {} });
    expect(result.isError).toBe(true);
    expect(text(result)).toContain('The DAV server answered');
    expect(dav.requests.filter((r) => r.method === 'REPORT')).toHaveLength(1);
  });

  it('reports an unknown address book as an error', async () => {
    const result = await client.callTool({ name: 'list_contacts', arguments: { addressbook: 'Nope' } });
    expect(result.isError).toBe(true);
    expect(text(result)).toContain('"Nope" not found');
  });

  describe('contacts without a multiget', () => {
    const vcards = addressObjects([{ href: '/addressbooks/u1/contacts/c.vcf', vcard: 'BEGIN:VCARD\r\nVERSION:3.0\r\nUID:c\r\nFN:Alice\r\nEND:VCARD\r\n' }]);

    it.each([400, 403, 404, 405, 415, 501])('reads again without it on %i', async (status) => {
      const { service, tool } = await freshContactTool();
      dav.handler = (req) => {
        if (req.method !== 'REPORT') return null;
        return req.body.includes('addressbook-multiget') ? { status } : vcards;
      };
      expect(await tool(service)).toContain('Alice');
    });

    it('does not read again on 500', async () => {
      const { service, tool } = await freshContactTool();
      dav.handler = (req) => {
        if (req.method !== 'REPORT') return null;
        return req.body.includes('addressbook-multiget') ? { status: 500 } : vcards;
      };
      await expect(tool(service)).rejects.toThrow('HTTP 500');
    });

    it('names a contact missing from the multiget, and does not cache the partial read', async () => {
      const { service, tool, callInToolContext } = await freshContactTool();
      dav.handler = (req) => {
        if (req.method !== 'REPORT') return null;
        return req.body.includes('addressbook-multiget')
          ? vcards
          : addressObjects([
              { href: '/addressbooks/u1/contacts/c.vcf', vcard: 'x' },
              { href: '/addressbooks/u1/contacts/gone.vcf', vcard: 'x' },
            ]);
      };
      const result = await callInToolContext(() => tool(service));
      expect(result.warning).toContain('gone.vcf');
      dav.requests.length = 0;
      await tool(service);
      expect(dav.requests.some((r) => r.method === 'REPORT')).toBe(true);
    });
  });

  describe('findEventByUid', () => {
    const raw = (req: { body: string }) => calendarObjects(req.body.includes('calendar-data') ? [{ href: objectHref, ical }] : []);

    it('falls back on a server refusing the UID filter', async () => {
      dav.handler = (req) => {
        if (req.method === 'DELETE') return { status: 204 };
        if (req.method !== 'REPORT') return null;
        return req.body.includes('name="UID"') ? { status: 400 } : eventsAnswer(req);
      };
      const result = await client.callTool({ name: 'delete_event', arguments: { uid: 'a' } });
      expect(dav.requests.some((r) => r.method === 'DELETE')).toBe(true);
      expect(text(result)).not.toContain('not found with UID');
    });

    it('does not fall back on a server failing on it', async () => {
      dav.handler = (req) => {
        if (req.method !== 'REPORT') return null;
        return req.body.includes('name="UID"') ? { status: 500 } : raw(req);
      };
      const result = await client.callTool({ name: 'delete_event', arguments: { uid: 'a' } });
      expect(result.isError).toBe(true);
      expect(text(result)).toContain('HTTP 500');
      expect(dav.requests.filter((r) => r.method === 'REPORT')).toHaveLength(1);
    });
  });

  it('starts when a calendar refuses supported-report-set', async () => {
    const twoCalendars = await startFakeDav(['Perso', 'Restricted']);
    twoCalendars.handler = (req) =>
      req.method === 'PROPFIND' && req.body.includes('supported-report-set') && req.url.includes('Restricted') ? { status: 403 } : null;
    const config = { DAV_URL: twoCalendars.url, DAV_AUTH_METHOD: 'basic', DAV_USERNAME: 'u', DAV_PASSWORD: 'p' } as Config;
    const clients = await createDualClients(config, logger);
    const calendars = await new CalendarService(clients.caldav, logger, config).listCalendars();
    expect(calendars.map((c) => c.displayName)).toEqual(['Perso', 'Restricted']);
    await twoCalendars.close();
  });

  it('times out on a silent server', async () => {
    const realTimeout = AbortSignal.timeout.bind(AbortSignal);
    vi.spyOn(AbortSignal, 'timeout').mockImplementation(() => realTimeout(50));
    dav.handler = (req) => (req.method === 'REPORT' ? undefined : null);
    const result = await client.callTool({ name: 'get_todays_schedule', arguments: {} });
    expect(result.isError).toBe(true);
    expect(text(result)).toContain('did not answer');
    expect(dav.requests.filter((r) => r.method === 'REPORT')).toHaveLength(1);
  });

  it('closes the request when the client cancels the tool call', async () => {
    let closed: () => void;
    const socketClosed = new Promise<void>((resolve) => { closed = resolve; });
    let received: () => void;
    const requestReceived = new Promise<void>((resolve) => { received = resolve; });
    dav.handler = (req, res) => {
      if (req.method !== 'REPORT') return null;
      res.on('close', () => closed());
      received();
      return undefined;
    };
    const abort = new AbortController();
    const call = client.callTool({ name: 'get_todays_schedule', arguments: {} }, undefined, { signal: abort.signal });
    await requestReceived;
    abort.abort();
    await expect(call).rejects.toThrow();
    await socketClosed;
    expect(dav.requests.filter((r) => r.method === 'REPORT')).toHaveLength(1);
  });
});
