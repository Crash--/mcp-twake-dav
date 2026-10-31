/**
 * UID lookup against the real tsdav: the JSON API of esn-sabre when the server
 * has it, a bounded calendar-query otherwise, and never a read of whole calendars.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import pino from 'pino';
import { createDualClients, type DAVClientType } from '../../src/caldav/client.js';
import { CalendarService } from '../../src/caldav/calendar-service.js';
import type { Config } from '../../src/config/schema.js';
import { startFakeDav, type FakeDav } from '../helpers/fake-dav.js';

const logger = pino({ level: 'silent' });
const JSON_HEADERS = { 'content-type': 'application/json' };
const jcal = (uid: string) => ['vcalendar', [['version', {}, 'text', '2.0']], [
  ['vevent', [
    ['uid', {}, 'text', uid],
    ['dtstart', {}, 'date-time', '2026-11-03T10:00:00Z'],
    ['dtend', {}, 'date-time', '2026-11-03T11:00:00Z'],
    ['summary', {}, 'text', 'Found'],
  ], []],
]];
const found = (uid: string, calendar = 'Perso') => ({
  status: 200,
  headers: JSON_HEADERS,
  body: JSON.stringify({ _embedded: { 'dav:item': [{ _links: { self: { href: `/calendars/u1/${calendar}/x.ics` } }, etag: '"e1"', data: jcal(uid) }] } }),
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
  const twake = (onUid: () => { status: number; headers?: Record<string, string>; body?: string }) => {
    dav.handler = (req) => {
      if (req.url !== '/calendars/u1.json') return req.method === 'REPORT' ? { status: 500 } : null;
      return req.method === 'GET' ? { status: 200, headers: JSON_HEADERS, body: '{}' } : onUid();
    };
  };
  const reports = () => dav.requests.filter((r) => r.method === 'REPORT');

  it('finds an event through the JSON API, with its URL and ETag', async () => {
    twake(() => found('a'));
    const event = await service().findEventByUid('a');
    expect(event?.url).toBe(`${dav.url}calendars/u1/Perso/x.ics`);
    expect(event?.etag).toBe('"e1"');
    expect(event?.summary).toBe('Found');
  });

  it('answers an unknown UID in one request on the JSON API', async () => {
    twake(() => ({ status: 404 }));
    const calendars = service();
    await expect(calendars.findEventByUid('absent')).resolves.toBeNull();
    expect(reports()).toHaveLength(1);

    await calendars.findEventByUid('absent-2');
    expect(dav.requests.filter((r) => r.method === 'GET')).toHaveLength(1);
  });

  it('ignores a match in another calendar than the one asked', async () => {
    twake(() => found('a', 'Pro'));
    await expect(service().findEventByUid('a', 'Perso')).resolves.toBeNull();
  });

  it('reports a failing JSON API as an error', async () => {
    twake(() => ({ status: 500 }));
    await expect(service().findEventByUid('a')).rejects.toThrow('HTTP 500');
  });

  it('reports a failing probe as an error', async () => {
    dav.handler = (req) => (req.method === 'GET' ? { status: 401 } : null);
    await expect(service().findEventByUid('a')).rejects.toThrow('HTTP 401');
  });

  it('uses a bounded UID query on another server, in every calendar', async () => {
    dav.handler = (req) => {
      if (req.method === 'GET') return { status: 404 };
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

  it('refuses an unknown calendar name', async () => {
    await expect(service().findEventByUid('a', 'Nope')).rejects.toThrow('"Nope" not found');
  });
});
