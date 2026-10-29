import { describe, it, expect } from 'vitest';
import ICAL from 'ical.js';
import { buildICalString, updateICalString } from '../../src/transformers/event-builder.js';

const vevent = (ics: string) => new ICAL.Component(ICAL.parse(ics)).getFirstSubcomponent('vevent')!;

describe('buildICalString with attendees', () => {
  it('adds ORGANIZER and ATTENDEEs (organizer ACCEPTED, others NEEDS-ACTION + RSVP), deduplicated', () => {
    const ics = buildICalString({
      title: 'Point', start: '2027-01-15T09:00:00Z', end: '2027-01-15T10:00:00Z',
      organizer: { email: 'mm@example.com', name: 'M-M' },
      attendees: [{ email: 'gl@example.com', name: 'Gilles' }, { email: 'GL@example.com' }, { email: 'mm@example.com' }],
    });
    const v = vevent(ics);
    expect(v.getFirstPropertyValue('organizer')).toBe('mailto:mm@example.com');
    const att = v.getAllProperties('attendee');
    expect(att.map((a) => a.getFirstValue())).toEqual(['mailto:mm@example.com', 'mailto:gl@example.com']);
    expect(att[0].getParameter('partstat')).toBe('ACCEPTED');
    expect(att[1].getParameter('partstat')).toBe('NEEDS-ACTION');
    expect(att[1].getParameter('rsvp')).toBe('TRUE');
    expect(att[1].getParameter('cn')).toBe('Gilles');
  });

  it('refuses attendees without organizer', () => {
    expect(() => buildICalString({ title: 'x', start: '2027-01-15T09:00:00Z', end: '2027-01-15T10:00:00Z',
      attendees: [{ email: 'a@b.c' }] })).toThrow(/organizer/);
  });

  it('adds no scheduling properties without attendees', () => {
    const v = vevent(buildICalString({ title: 'x', start: '2027-01-15T09:00:00Z', end: '2027-01-15T10:00:00Z' }));
    expect(v.getFirstProperty('organizer')).toBeNull();
    expect(v.getAllProperties('attendee')).toHaveLength(0);
  });
});

describe('updateICalString dates', () => {
  const raw = [
    'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//t//EN',
    'BEGIN:VEVENT', 'UID:u1', 'DTSTAMP:20260101T000000Z',
    'DTSTART;TZID=Romance Standard Time:20270115T100000',
    'DTEND;TZID=Romance Standard Time:20270115T110000',
    'SUMMARY:Test', 'END:VEVENT', 'END:VCALENDAR', '',
  ].join('\r\n');

  it('writes UTC and drops a TZID that would contradict it', () => {
    const out = updateICalString(raw, { start: new Date('2027-01-15T13:00:00Z'), end: new Date('2027-01-15T14:00:00Z') });
    expect(out).toMatch(/DTSTART:20270115T130000Z/);
    expect(out).toMatch(/DTEND:20270115T140000Z/);
    expect(out).not.toMatch(/TZID/);
  });

  it('keeps all-day events as DATE', () => {
    const allDay = raw.replace(/DTSTART;TZID=[^:]+:\d+T\d+/, 'DTSTART;VALUE=DATE:20270115').replace(/DTEND;TZID=[^:]+:\d+T\d+/, 'DTEND;VALUE=DATE:20270116');
    const out = updateICalString(allDay, { start: new Date(2027, 0, 20, 12), end: new Date(2027, 0, 21, 12) });
    expect(out).toMatch(/DTSTART;VALUE=DATE:20270120/);
    expect(out).toMatch(/DTEND;VALUE=DATE:20270121/);
  });
});
