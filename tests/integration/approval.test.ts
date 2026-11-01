/**
 * Prior approval of every write: each write tool asks the user (MCP elicitation) with the exact action,
 * and writes nothing unless the user accepts.
 */
import { describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { ElicitRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import type { Logger } from 'pino';
import { createServer } from '../../src/server.js';
import type { CalendarService } from '../../src/caldav/calendar-service.js';
import type { AddressBookService } from '../../src/caldav/addressbook-service.js';
import { buildICalString } from '../../src/transformers/event-builder.js';
import { buildVCardString } from '../../src/transformers/contact-builder.js';
import { approvalMessage } from '../../src/approval.js';

const logger = { info() {}, debug() {}, warn() {}, error() {}, fatal() {}, trace() {}, child() { return logger; } } as unknown as Logger;

const start = new Date('2026-11-05T13:00:00Z');
const end = new Date('2026-11-05T14:00:00Z');
const eventRaw = buildICalString({ title: 'Point budget', start, end, timezone: 'Europe/Paris', organizer: { email: 'alice.martin@example.com', name: 'Alice MARTIN' }, attendees: [{ email: 'bob.durand@example.com', name: 'Bob DURAND' }] });
const event = {
  uid: 'ev-1', summary: 'Point budget', description: undefined, startDate: start, endDate: end, location: 'Salle 2', attendees: ['Bob DURAND'], attendeeDetails: [],
  timezone: 'Europe/Paris', status: undefined, isRecurring: false, allDay: false, recurrenceRule: undefined, url: 'https://dav.example.com/cal/ev-1.ics', etag: '"1"', _raw: eventRaw,
};
const contact = {
  uid: 'c-1', name: { formatted: 'Bob DURAND' }, emails: ['bob.durand@example.com'], phones: ['+33 1 23 45 67 89'], organization: 'Example', version: '4.0',
  url: 'https://dav.example.com/ab/c-1.vcf', etag: '"2"', _raw: buildVCardString({ name: 'Bob DURAND', email: 'bob.durand@example.com', phone: '+33 1 23 45 67 89', organization: 'Example' }),
};

function setup(opts: { answer?: 'accept' | 'decline' | 'cancel'; elicitation?: boolean; approval?: 'elicit' | 'client' } = {}) {
  const writes: string[] = [];
  const prompts: string[] = [];
  const calendarService = {
    listCalendars: async () => [],
    findEventByUid: async () => event,
    createEvent: async () => (writes.push('createEvent'), { url: 'https://dav.example.com/cal/new.ics', etag: '"n"' }),
    updateEvent: async () => (writes.push('updateEvent'), { url: event.url, etag: '"3"' }),
    deleteEvent: async () => void writes.push('deleteEvent'),
    listPendingInvitations: async () => [{ uid: 'inv-1', summary: 'Comité', organizer: { name: 'Bob DURAND', email: 'bob.durand@example.com' }, proposedStart: start, proposedEnd: end, userPartstat: 'NEEDS-ACTION', url: 'x', etag: 'y' }],
    respondToInvitation: async () => void writes.push('respondToInvitation'),
  } as unknown as CalendarService;
  const addressBookService = {
    listAddressBooks: async () => [],
    findContactByUid: async () => contact,
    createContact: async () => (writes.push('createContact'), { url: 'u', etag: 'e' }),
    updateContact: async () => (writes.push('updateContact'), { url: 'u', etag: 'e' }),
    deleteContact: async () => void writes.push('deleteContact'),
  } as unknown as AddressBookService;
  const server = createServer(calendarService, addressBookService, logger, undefined, undefined, 'Europe/Paris', {
    DAV_USERNAME: 'alice.martin@example.com',
    DAV_ORGANIZER_EMAIL: 'alice.martin@example.com',
    DAV_ORGANIZER_NAME: 'Alice MARTIN',
    DAV_APPROVAL: opts.approval ?? 'elicit',
    DAV_APPROVAL_TIMEOUT_MS: 2000,
    USER_LANGUAGE: 'fr',
  });
  const client = new Client({ name: 't', version: '0' }, { capabilities: opts.elicitation === false ? {} : { elicitation: { form: {} } } });
  if (opts.elicitation !== false) {
    client.setRequestHandler(ElicitRequestSchema, async (req) => {
      prompts.push(req.params.message);
      const action = opts.answer ?? 'accept';
      return action === 'accept' ? { action, content: {} } : { action };
    });
  }
  const ready = (async () => {
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await server.connect(st);
    await client.connect(ct);
  })();
  const call = async (name: string, args: Record<string, unknown>) => {
    await ready;
    const r = await client.callTool({ name, arguments: args });
    return { isError: Boolean(r.isError), text: (r.content as { text: string }[])[0].text };
  };
  return { call, writes, prompts };
}

const WRITES: [string, Record<string, unknown>, string][] = [
  ['create_event', { title: 'Point budget', start: '2026-11-05T14:00:00+01:00', end: '2026-11-05T15:00:00+01:00', attendees: [{ email: 'bob.durand@example.com', name: 'Bob DURAND' }] }, 'createEvent'],
  ['update_event', { uid: 'ev-1', title: 'Point budget Q1' }, 'updateEvent'],
  ['delete_event', { uid: 'ev-1' }, 'deleteEvent'],
  ['add_alarm', { uid: 'ev-1', trigger: '15 minutes' }, 'updateEvent'],
  ['remove_alarm', { uid: 'ev-1', alarmIndex: 'all' }, 'updateEvent'],
  ['respond_to_invitation', { uid: 'inv-1', response: 'accept' }, 'respondToInvitation'],
  ['create_contact', { name: 'Chloé PETIT', email: 'chloe.petit@example.com' }, 'createContact'],
  ['update_contact', { uid: 'c-1', phone: '+33 6 00 00 00 00' }, 'updateContact'],
  ['delete_contact', { uid: 'c-1' }, 'deleteContact'],
];

describe('prior approval of writes', () => {
  it.each(WRITES)('%s writes only after the user accepts', async (tool, args, write) => {
    const accepted = setup();
    const r = await accepted.call(tool, args);
    expect(r.isError, r.text).toBe(false);
    expect(accepted.prompts).toHaveLength(1);
    expect(accepted.prompts[0]).toMatch(/^Twake Calendar : .+\nEn tant que : Alice MARTIN \(votre compte\)\n/);
    expect(accepted.prompts[0]).toMatch(/Réf\. [0-9a-f]{6} · Acceptez/);
    expect(accepted.writes).toEqual([write]);

    for (const answer of ['decline', 'cancel'] as const) {
      const refused = setup({ answer });
      const n = await refused.call(tool, args);
      expect(n.text).toMatch(/^Not done: .*nothing was changed/);
      expect(refused.writes).toEqual([]);
    }
  });

  it('refuses to write when the client cannot ask, unless it confirms itself', async () => {
    const blind = setup({ elicitation: false });
    const r = await blind.call('delete_event', { uid: 'ev-1' });
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/cannot ask the user for approval/);
    expect(blind.writes).toEqual([]);
    const client = setup({ elicitation: false, approval: 'client' });
    expect((await client.call('delete_event', { uid: 'ev-1' })).isError).toBe(false);
    expect(client.writes).toEqual(['deleteEvent']);
  });

  it('shows the dates in the user time zone and who gets an e-mail', async () => {
    const t = setup();
    await t.call('create_event', WRITES[0][1]);
    expect(t.prompts[0]).toContain('Titre : Point budget');
    expect(t.prompts[0]).toContain('Quand : 2026-11-05 14:00 → 15:00 (Europe/Paris)');
    expect(t.prompts[0]).toContain('Invités : Bob DURAND <bob.durand@example.com> (ils reçoivent une invitation envoyée en votre nom)');
    await t.call('delete_event', { uid: 'ev-1' });
    expect(t.prompts[1]).toContain('Supprimer un événement (définitif)');
    expect(t.prompts[1]).toContain('Événement : Point budget · 2026-11-05 14:00 → 15:00 (Europe/Paris)');
    expect(t.prompts[1]).toContain("Prévenus : Bob DURAND (le serveur peut leur envoyer une annulation)");
    await t.call('update_contact', { uid: 'c-1', phone: '+33 6 00 00 00 00' });
    expect(t.prompts[2]).toContain('phone: +33 1 23 45 67 89 → +33 6 00 00 00 00');
    expect(new Set(t.prompts.map((p) => /Réf\. (\w+)/.exec(p)![1])).size).toBe(3);
  });

  it('never asks for read tools', async () => {
    const t = setup();
    await t.call('list_calendars', {});
    await t.call('list_addressbooks', {});
    expect(t.prompts).toEqual([]);
  });
});

describe('approvalMessage', () => {
  it('leaves out empty fields and writes English by default', () => {
    expect(approvalMessage({ action: 'add_alarm', details: [['event', 'Point budget'], ['reminder', '15 minutes'], ['location', undefined]] }, { language: 'en', as: 'alice@example.com' }, 'abc123')).toBe(
      'Twake Calendar: Add a reminder\nAs: alice@example.com (your account)\nEvent: Point budget\nReminder: 15 minutes\n\nRef. abc123 · Accept to do it now, refuse to cancel.',
    );
  });
});
