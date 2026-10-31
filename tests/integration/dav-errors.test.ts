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
import { startFakeDav, type FakeDav } from '../helpers/fake-dav.js';

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

  it('reports a failing free-busy query instead of answering free', async () => {
    dav.handler = (req) => (req.method === 'REPORT' ? { status: 500 } : null);
    const result = await client.callTool({
      name: 'check_availability',
      arguments: { start: '2026-11-03T10:00:00Z', end: '2026-11-03T11:00:00Z' },
    });
    expect(result.isError).toBe(true);
    expect(text(result)).toContain('HTTP 500');
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
