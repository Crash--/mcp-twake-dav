/**
 * Load on the production CalDAV/CardDAV server: a tool must not read whole collections when the
 * server can answer the question itself. Runs the real tsdav against a local server that records
 * every request.
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
import { addressObjects, calendarObjects, startFakeDav, type FakeDav } from '../helpers/fake-dav.js';

const logger = pino({ level: 'silent' });
const vcard = (uid: string, fn: string, org = 'Example') =>
  `BEGIN:VCARD\r\nVERSION:3.0\r\nUID:${uid}\r\nFN:${fn}\r\nN:${fn.split(' ').reverse().join(';')};;;\r\nORG:${org}\r\nEMAIL:${uid}@example.com\r\nEND:VCARD\r\n`;

describe('load on the DAV server', () => {
  let dav: FakeDav;
  let client: Client;
  const reports = () => dav.requests.filter((r) => r.method === 'REPORT');
  const text = (r: unknown) => (r as { content: { text: string }[] }).content[0].text;

  beforeAll(async () => {
    dav = await startFakeDav(['Perso', 'Shared']);
    const config = { DAV_URL: dav.url, DAV_AUTH_METHOD: 'basic', DAV_USERNAME: 'u', DAV_PASSWORD: 'p', DAV_ORGANIZER_EMAIL: 'alice.martin@example.com' } as Config;
    const clients = await createDualClients(config, logger);
    const server = createServer(new CalendarService(clients.caldav, logger, config), new AddressBookService(clients.carddav, logger), logger, undefined, undefined, undefined, {
      DAV_APPROVAL: 'client',
      DAV_ORGANIZER_EMAIL: 'alice.martin@example.com',
    });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await server.connect(st);
    client = new Client({ name: 'test', version: '1' }, { capabilities: {} });
    await client.connect(ct);
  });

  afterAll(async () => {
    await client.close();
    await dav.close();
  });

  beforeEach(() => {
    dav.requests.length = 0;
    dav.handler = () => null;
  });

  describe('an event looked up by UID', () => {
    it('an unknown UID costs one filtered query per calendar, never a full read', async () => {
      dav.handler = (req) => (req.method === 'REPORT' ? calendarObjects([]) : null);
      const r = await client.callTool({ name: 'delete_event', arguments: { uid: 'missing' } });
      expect(text(r)).toMatch(/not found with UID/);
      expect(reports().length).toBeGreaterThan(0);
      for (const q of reports()) expect(q.body).toContain('name="UID"');
    });

    it('stops at the calendar that has it', async () => {
      const ical = 'BEGIN:VCALENDAR\r\nVERSION:2.0\r\nBEGIN:VEVENT\r\nUID:a\r\nDTSTART:20261105T100000Z\r\nDTEND:20261105T110000Z\r\nSUMMARY:Point\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n';
      dav.handler = (req) => {
        if (req.method === 'DELETE') return { status: 204 };
        if (req.method !== 'REPORT') return null;
        return calendarObjects(req.url.includes('/Perso/') ? [{ href: `${req.url}a.ics`, ical }] : []);
      };
      await client.callTool({ name: 'delete_event', arguments: { uid: 'a' } });
      expect(reports()).toHaveLength(1);
      expect(dav.requests.some((r) => r.method === 'DELETE')).toBe(true);
    });
  });

  describe('contacts', () => {
    const book = [vcard('c1', 'Bob DURAND'), vcard('c2', 'Alice MARTIN', 'LINAGORA'), vcard('c3', 'Chloé PETIT')];

    it('search_contacts asks the server for the name instead of reading every contact', async () => {
      dav.handler = (req) => {
        if (req.method !== 'REPORT') return null;
        const wanted = /<card:text-match[^>]*>([^<]+)</.exec(req.body)?.[1]?.toLowerCase();
        return addressObjects(book.filter((v) => !wanted || v.toLowerCase().includes(wanted)).map((v, i) => ({ href: `${req.url}${i}.vcf`, vcard: v })));
      };
      const r = await client.callTool({ name: 'search_contacts', arguments: { name: 'durand' } });
      expect(text(r)).toContain('Bob DURAND');
      expect(text(r)).not.toContain('Alice MARTIN');
      expect(reports()).toHaveLength(1);
      expect(reports()[0].body).toMatch(/name="FN"/);
      expect(reports()[0].body).toMatch(/match-type="contains"/);
      expect(reports()[0].body).toMatch(/>durand</);
    });

    it('filters on the organization on the server when there is no name, and on both locally', async () => {
      dav.handler = (req) => {
        if (req.method !== 'REPORT') return null;
        const wanted = /<card:text-match[^>]*>([^<]+)</.exec(req.body)?.[1]?.toLowerCase();
        return addressObjects(book.filter((v) => !wanted || v.toLowerCase().includes(wanted)).map((v, i) => ({ href: `${req.url}${i}.vcf`, vcard: v })));
      };
      const byOrg = await client.callTool({ name: 'search_contacts', arguments: { organization: 'linagora' } });
      expect(text(byOrg)).toContain('Alice MARTIN');
      expect(reports()[0].body).toMatch(/name="ORG"/);
      const both = await client.callTool({ name: 'search_contacts', arguments: { name: 'alice', organization: 'nowhere' } });
      expect(text(both)).toMatch(/No contacts found/);
    });

    it('a name containing XML characters is escaped in the query', async () => {
      dav.handler = (req) => (req.method === 'REPORT' ? addressObjects([]) : null);
      await client.callTool({ name: 'search_contacts', arguments: { name: 'a<b&c' } });
      expect(reports()[0].body).toContain('a&lt;b&amp;c');
    });
  });

  describe('invitations', () => {
    const invite = (partstat: string) =>
      'BEGIN:VCALENDAR\r\nVERSION:2.0\r\nBEGIN:VEVENT\r\nUID:inv-1\r\nDTSTART:20261110T090000Z\r\nDTEND:20261110T100000Z\r\nSUMMARY:Comité\r\n' +
      'ORGANIZER;CN=Bob DURAND:mailto:bob.durand@example.com\r\n' +
      `ATTENDEE;CN=Alice MARTIN;PARTSTAT=${partstat}:mailto:alice.martin@example.com\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n`;

    it('list_invitations asks the calendars for my pending answers in a bounded range, not the scheduling inbox', async () => {
      dav.handler = (req) => (req.method === 'REPORT' ? calendarObjects(req.url.includes('/Perso/') ? [{ href: `${req.url}inv-1.ics`, ical: invite('NEEDS-ACTION') }] : []) : null);
      const r = await client.callTool({ name: 'list_invitations', arguments: {} });
      expect(text(r)).toContain('Comité');
      expect(text(r)).toContain('inv-1');
      expect(reports().length).toBeGreaterThan(0);
      for (const q of reports()) {
        expect(q.url).toMatch(/\/calendars\/u1\/(Perso|Shared)\/$/);
        expect(q.body).toContain('time-range');
        expect(q.body).toContain('NEEDS-ACTION');
        expect(q.body).toContain('mailto:alice.martin@example.com');
      }
    });

    it('list_invitations keeps only the events where I still have to answer', async () => {
      dav.handler = (req) => (req.method === 'REPORT' ? calendarObjects([{ href: `${req.url}inv-1.ics`, ical: invite('ACCEPTED') }]) : null);
      expect(text(await client.callTool({ name: 'list_invitations', arguments: {} }))).toMatch(/No pending invitations/);
    });

    it('respond_to_invitation updates my answer on the event of my calendar, found by its UID', async () => {
      let put = '';
      dav.handler = (req) => {
        if (req.method === 'PUT') {
          put = `${req.url}\n${req.body}`;
          return { status: 204 };
        }
        if (req.method !== 'REPORT') return null;
        return calendarObjects(req.url.includes('/Perso/') && req.body.includes('name="UID"') ? [{ href: `${req.url}inv-1.ics`, ical: invite('NEEDS-ACTION') }] : []);
      };
      const r = await client.callTool({ name: 'respond_to_invitation', arguments: { uid: 'inv-1', response: 'accept' } });
      expect(r.isError).toBeFalsy();
      expect(put).toMatch(/^\/calendars\/u1\/Perso\/inv-1\.ics/);
      expect(put).toMatch(/PARTSTAT=ACCEPTED[^\r\n]*mailto:alice\.martin@example\.com/);
      for (const q of reports()) expect(q.body).toContain('name="UID"');
    });

    it('respond_to_invitation refuses an event I am not invited to', async () => {
      const other = invite('NEEDS-ACTION').replace(/alice\.martin/g, 'chloe.petit');
      dav.handler = (req) => (req.method === 'REPORT' ? calendarObjects(req.url.includes('/Perso/') ? [{ href: `${req.url}inv-1.ics`, ical: other }] : []) : null);
      const r = await client.callTool({ name: 'respond_to_invitation', arguments: { uid: 'inv-1', response: 'accept' } });
      expect(r.isError).toBe(true);
      expect(dav.requests.some((q) => q.method === 'PUT')).toBe(false);
    });
  });
});
