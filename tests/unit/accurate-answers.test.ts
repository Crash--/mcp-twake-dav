import { describe, it, expect, vi, afterEach } from 'vitest';
import pino from 'pino';
import type { DAVCalendarObject } from 'tsdav';
import { getEventsWithRecurrenceExpansion, parseDateRange, todayRange } from '../../src/tools/calendar/utils.js';

const logger = pino({ level: 'silent' });
const PARIS = 'Europe/Paris';

const object = (uid: string, ...lines: string[]): DAVCalendarObject => ({
  url: `https://dav.example.com/cal/${uid}.ics`,
  etag: 'e',
  data: ['BEGIN:VCALENDAR', 'VERSION:2.0', 'BEGIN:VEVENT', `UID:${uid}`, 'DTSTAMP:20260101T000000Z', `SUMMARY:${uid}`, ...lines, 'END:VEVENT', 'END:VCALENDAR', ''].join('\r\n'),
});

describe('parseDateRange', () => {
  it('reads a date alone as whole days of the user time zone', () => {
    expect(parseDateRange('2026-11-03', '2026-11-03', 7, PARIS)).toEqual({
      start: '2026-11-02T23:00:00.000Z',
      end: '2026-11-03T23:00:00.000Z',
    });
  });

  it('follows daylight saving time', () => {
    expect(parseDateRange('2026-07-01T09:00', '2026-07-01T10:00', 7, PARIS)).toEqual({
      start: '2026-07-01T07:00:00.000Z',
      end: '2026-07-01T08:00:00.000Z',
    });
  });

  it('respects an explicit offset', () => {
    expect(parseDateRange('2026-07-01T09:00:00+02:00', '2026-07-01T10:00:00Z', 7, PARIS)).toEqual({
      start: '2026-07-01T07:00:00.000Z',
      end: '2026-07-01T10:00:00.000Z',
    });
  });

  it('defaults the end to the window after the start', () => {
    expect(parseDateRange('2026-11-03T00:00:00Z', undefined, 7)).toEqual({
      start: '2026-11-03T00:00:00.000Z',
      end: '2026-11-10T00:00:00.000Z',
    });
  });

  it.each(['this week', 'next month', '2026-02-31', '03/11/2026'])('refuses "%s"', (value) => {
    expect(parseDateRange(value, undefined, 7, PARIS)).toHaveProperty('problem');
  });
});

describe('todayRange', () => {
  afterEach(() => { vi.useRealTimers(); });

  it('is the day of the user time zone, not of the process', () => {
    vi.useFakeTimers({ now: new Date('2026-11-03T23:30:00Z') });
    expect(todayRange(PARIS)).toEqual({ start: '2026-11-03T23:00:00.000Z', end: '2026-11-04T23:00:00.000Z' });
    expect(todayRange('America/New_York')).toEqual({ start: '2026-11-03T05:00:00.000Z', end: '2026-11-04T05:00:00.000Z' });
  });
});

describe('events overlapping the range', () => {
  const today = { start: '2026-11-03T00:00:00Z', end: '2026-11-04T00:00:00Z' };
  const uids = (objects: DAVCalendarObject[], range = today) =>
    getEventsWithRecurrenceExpansion(objects, range, logger).map((e) => e.uid);

  it('includes a conference that started two days ago', () => {
    expect(uids([object('conf', 'DTSTART:20261101T090000Z', 'DTEND:20261105T170000Z')])).toEqual(['conf']);
  });

  it('excludes an event that ends when the range starts', () => {
    expect(uids([object('before', 'DTSTART:20261102T230000Z', 'DTEND:20261103T000000Z')])).toEqual([]);
  });

  it('includes a running occurrence of a series', () => {
    const series = object('night', 'DTSTART:20261001T220000Z', 'DTEND:20261002T020000Z', 'RRULE:FREQ=DAILY');
    const starts = getEventsWithRecurrenceExpansion([series], today, logger).map((e) => e.startDate.toISOString());
    expect(starts).toEqual(['2026-11-02T22:00:00.000Z', '2026-11-03T22:00:00.000Z']);
  });

  it('moves an occurrence to the window of its new date', () => {
    const data = [
      'BEGIN:VCALENDAR', 'VERSION:2.0',
      'BEGIN:VEVENT', 'UID:s', 'DTSTAMP:20260101T000000Z', 'SUMMARY:s', 'DTSTART:20261031T100000Z', 'DTEND:20261031T110000Z', 'RRULE:FREQ=WEEKLY', 'END:VEVENT',
      'BEGIN:VEVENT', 'UID:s', 'DTSTAMP:20260101T000000Z', 'SUMMARY:moved', 'RECURRENCE-ID:20261031T100000Z', 'DTSTART:20261103T100000Z', 'DTEND:20261103T110000Z', 'END:VEVENT',
      'END:VCALENDAR', '',
    ].join('\r\n');
    const series = { url: 'https://dav.example.com/cal/s.ics', etag: 'e', data };

    const inNewWindow = getEventsWithRecurrenceExpansion([series], today, logger);
    expect(inNewWindow.map((e) => e.summary)).toEqual(['moved']);

    const oldWindow = { start: '2026-10-31T00:00:00Z', end: '2026-11-01T00:00:00Z' };
    expect(getEventsWithRecurrenceExpansion([series], oldWindow, logger)).toEqual([]);
  });
});
