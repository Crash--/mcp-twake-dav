/**
 * The guard must leave write responses to their callers, and a write without an
 * answer must neither be repeated nor presented as safe to repeat.
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
import { calendarObjects, startFakeDav, type FakeDav } from '../helpers/fake-dav.js';

const logger = pino({ level: 'silent' });
const ical = 'BEGIN:VCALENDAR\r\nVERSION:2.0\r\nBEGIN:VEVENT\r\nUID:a\r\nDTSTAMP:20260101T000000Z\r\nDTSTART:20261103T100000Z\r\nDURATION:PT1H\r\nSUMMARY:a\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n';

describe('DAV writes', () => {
  let dav: FakeDav;
  let client: Client;

  beforeAll(async () => {
    dav = await startFakeDav();
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

  afterEach(() => {
    vi.restoreAllMocks();
  });

  const call = async (name: string, args: Record<string, unknown>) => {
    const result = await client.callTool({ name, arguments: args });
    return { isError: result.isError, text: (result as { content: Array<{ text: string }> }).content[0].text };
  };
  const writes = () => dav.requests.filter((r) => r.method === 'PUT' || r.method === 'DELETE');
  const newEvent = { title: 'x', start: '2026-11-03T10:00:00Z', end: '2026-11-03T11:00:00Z' };
  const existing = (req: { method: string }) =>
    req.method === 'REPORT' ? calendarObjects([{ href: '/calendars/u1/Perso/a.ics', ical }]) : null;

  it('keeps a 412 on PUT as a conflict', async () => {
    dav.handler = (req) => (req.method === 'PUT' ? { status: 412 } : existing(req));
    const { isError, text } = await call('update_event', { uid: 'a', title: 'y' });
    expect(isError).toBe(true);
    expect(text).toContain('modified by another client');
    expect(writes()).toHaveLength(1);
  });

  it('keeps a 412 on DELETE as a conflict', async () => {
    dav.handler = (req) => (req.method === 'DELETE' ? { status: 412 } : existing(req));
    const { isError, text } = await call('delete_event', { uid: 'a' });
    expect(isError).toBe(true);
    expect(text).toContain('modified by another client');
    expect(writes()).toHaveLength(1);
  });

  it('does not repeat a write on 503', async () => {
    dav.handler = (req) => (req.method === 'PUT' ? { status: 503, headers: { 'retry-after': '0' } } : null);
    const { isError, text } = await call('create_event', newEvent);
    expect(isError).toBe(true);
    expect(text).toContain('503');
    expect(writes()).toHaveLength(1);
  });

  it.each([
    ['create_event', newEvent, 'PUT'],
    ['delete_event', { uid: 'a' }, 'DELETE'],
    ['create_contact', { name: 'x' }, 'PUT'],
  ] as const)('%s after a cut connection says the outcome is unknown, once', async (name, args, method) => {
    dav.handler = (req, res) => {
      if (req.method === method) {
        res.destroy();
        return undefined;
      }
      return existing(req);
    };
    const { isError, text } = await call(name, args);
    expect(isError).toBe(true);
    expect(text).toContain('may or may not have been applied');
    expect(text).not.toMatch(/try again/i);
    expect(writes()).toHaveLength(1);
  });

  it('create_event after a timeout says the outcome is unknown', async () => {
    const realTimeout = AbortSignal.timeout.bind(AbortSignal);
    vi.spyOn(AbortSignal, 'timeout').mockImplementation(() => realTimeout(50));
    dav.handler = (req) => (req.method === 'PUT' ? undefined : null);
    const { isError, text } = await call('create_event', newEvent);
    expect(isError).toBe(true);
    expect(text).toContain('may or may not have been applied');
    expect(text).not.toMatch(/try again|date range/i);
    expect(writes()).toHaveLength(1);
  });
});
