/**
 * Contact tools against the real tsdav: bounded output, server-side filters and pages.
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
import { addressObjects, startFakeDav, type FakeDav } from '../helpers/fake-dav.js';

const logger = pino({ level: 'silent' });
const vcard = (i: number) => `BEGIN:VCARD\r\nVERSION:3.0\r\nUID:c${i}\r\nFN:Person ${i}\r\nEND:VCARD\r\n`;
const objects = (n: number) => Array.from({ length: n }, (_, i) => ({ href: `/addressbooks/u1/contacts/c${i}.vcf`, vcard: vcard(i) }));

describe('contact pages', () => {
  let dav: FakeDav;
  let client: Client;
  let service: AddressBookService;

  const start = async () => {
    const config = { DAV_URL: dav.url, DAV_AUTH_METHOD: 'basic', DAV_USERNAME: 'u', DAV_PASSWORD: 'p' } as Config;
    const clients = await createDualClients(config, logger);
    service = new AddressBookService(clients.carddav, logger, config);
    const server = createServer(new CalendarService(clients.caldav, logger, config), service, logger);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    client = new Client({ name: 'test', version: '1' }, { capabilities: {} });
    await client.connect(clientTransport);
  };

  beforeAll(async () => {
    dav = await startFakeDav();
  });

  afterAll(async () => {
    await dav.close();
  });

  beforeEach(async () => {
    dav.handler = () => null;
    await start();
    dav.requests.length = 0;
  });

  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const result = await client.callTool({ name, arguments: args });
    return { isError: result.isError, text: (result as { content: Array<{ text: string }> }).content[0].text };
  };
  const nextCursor = (text: string) => JSON.parse(/nextCursor: (\{.*\})/.exec(text)![1]);

  it('search_contacts sends its filter and a limit, and bounds its output', async () => {
    dav.handler = (req) => (req.method === 'REPORT' ? addressObjects(objects(200)) : null);
    const { text } = await call('search_contacts', { name: 'Person' });
    expect(text.match(/UID: /g)).toHaveLength(30);
    expect(text).toContain('More contacts remain');
    const [report] = dav.requests.filter((r) => r.method === 'REPORT');
    expect(report.body).toContain('Person');
    expect(report.body).toContain('nresults');
    expect(report.body).toContain('31');
  });

  it('search_contacts walks without a hole or a duplicate', async () => {
    dav.handler = (req) => {
      if (req.method !== 'REPORT') return null;
      return addressObjects(objects(Math.min(75, Number(/nresults[^>]*>(\d+)</.exec(req.body)![1]))));
    };
    const seen: string[] = [];
    let cursor;
    for (let page = 0; page < 10; page++) {
      const { text } = await call('search_contacts', { name: 'Person', ...(cursor ? { cursor } : {}) });
      seen.push(...[...text.matchAll(/UID: (\S+)/g)].map((m) => m[1]));
      if (!text.includes('nextCursor')) break;
      cursor = nextCursor(text);
    }
    expect(seen).toEqual(objects(75).map((_, i) => `c${i}`));
  });

  it('list_contacts reads a server without a JSON API once, then pages from the cache', async () => {
    dav.handler = (req) => {
      if (req.method === 'GET') return { status: 404 };
      if (req.method !== 'REPORT') return null;
      return addressObjects(objects(40));
    };
    const first = await call('list_contacts');
    expect(first.text).toContain('Contacts (30 in this page)');
    const reads = dav.requests.filter((r) => r.method === 'REPORT').length;
    const second = await call('list_contacts', { cursor: nextCursor(first.text) });
    expect(second.text).toContain('Contacts (10 in this page)');
    expect(second.text).toContain('No more contacts');
    expect(dav.requests.filter((r) => r.method === 'REPORT')).toHaveLength(reads);
  });

  it('list_contacts pages on the server when it has the JSON API', async () => {
    dav.handler = (req) => {
      if (req.method === 'REPORT') return { status: 500 };
      if (req.method !== 'GET') return null;
      const url = new URL(req.url, dav.url);
      const items = objects(50)
        .slice(Number(url.searchParams.get('offset')), Number(url.searchParams.get('offset')) + Number(url.searchParams.get('limit')))
        .map((o, i) => ({
          _links: { self: { href: o.href } },
          etag: '"e"',
          data: ['vcard', [['version', {}, 'text', '3.0'], ['uid', {}, 'text', o.href.split('/').pop()!.replace('.vcf', '')], ['fn', {}, 'text', `Person ${i}`]]],
        }));
      return { status: 200, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ _embedded: { 'dav:item': items } }) };
    };
    const first = await call('list_contacts', { limit: 20 });
    expect(first.isError).toBeFalsy();
    expect(nextCursor(first.text)).toEqual({ book: 0, offset: 20 });
    expect(dav.requests.filter((r) => r.method === 'REPORT')).toHaveLength(0);
    expect(dav.requests.find((r) => r.method === 'GET')?.url).toContain('.json?limit=21&offset=0');
  });

  it('reports a failing contact search as an error, not as no contact', async () => {
    dav.handler = (req) => (req.method === 'REPORT' ? { status: 500 } : null);
    const { isError, text } = await call('search_contacts', { name: 'x' });
    expect(isError).toBe(true);
    expect(text).toContain('HTTP 500');
  });

  it('finds a contact by UID without reading the address book', async () => {
    dav.handler = (req) => (req.method === 'REPORT' ? addressObjects(objects(1)) : null);
    await expect(service.findContactByUid('c0')).resolves.toMatchObject({ uid: 'c0' });
    const reports = dav.requests.filter((r) => r.method === 'REPORT');
    expect(reports).toHaveLength(1);
    expect(reports[0].body).toContain('name="UID"');
  });

  it('refuses an unknown address book', async () => {
    const { isError, text } = await call('list_contacts', { addressbook: 'Nope' });
    expect(isError).toBe(true);
    expect(text).toContain('"Nope" not found');
  });
});
