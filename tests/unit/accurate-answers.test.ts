import { describe, it, expect, vi, afterEach } from 'vitest';
import pino from 'pino';
import type { DAVCalendarObject } from 'tsdav';
import { formatEventTime, getEventsWithRecurrenceExpansion, parseDateRange, parseWriteDate, todayRange } from '../../src/tools/calendar/utils.js';

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

describe('dates without a zone', () => {
  const allDay = object('day', 'DTSTART;VALUE=DATE:20261103', 'DTEND;VALUE=DATE:20261104');
  const parisDay = (date: string) => parseDateRange(date, date, 7, PARIS) as { start: string; end: string };

  it.each(['Europe/Paris', 'America/New_York', 'Asia/Tokyo'])('an all-day event is on one day in %s, whatever the process', (zone) => {
    const day = (date: string) => parseDateRange(date, date, 7, zone) as { start: string; end: string };
    const on = (date: string) => getEventsWithRecurrenceExpansion([allDay], day(date), logger, zone).length;
    expect([on('2026-11-02'), on('2026-11-03'), on('2026-11-04')]).toEqual([0, 1, 0]);
  });

  it('shows an all-day event as such', () => {
    const [event] = getEventsWithRecurrenceExpansion([allDay], parisDay('2026-11-03'), logger, PARIS);
    expect(formatEventTime(event, PARIS)).toBe('Tue, Nov 3 (all day)');
  });

  it('shows the last day of an all-day event of several days', () => {
    const long = object('long', 'DTSTART;VALUE=DATE:20261103', 'DTEND;VALUE=DATE:20261106');
    const [event] = getEventsWithRecurrenceExpansion([long], parisDay('2026-11-04'), logger, PARIS);
    expect(formatEventTime(event, PARIS)).toBe('Tue, Nov 3 - Thu, Nov 5 (all day)');
  });

  it('keeps an all-day occurrence to its day across a 25 hour day', () => {
    const series = object('s', 'DTSTART;VALUE=DATE:20261024', 'DTEND;VALUE=DATE:20261025', 'RRULE:FREQ=DAILY');
    const on = (date: string) => getEventsWithRecurrenceExpansion([series], parisDay(date), logger, PARIS);
    // The clock goes back on 2026-10-25 in Paris.
    expect(on('2026-10-25').map((e) => e.startDate.toISOString())).toEqual(['2026-10-24T22:00:00.000Z']);
    expect(on('2026-10-26').map((e) => e.startDate.toISOString())).toEqual(['2026-10-25T23:00:00.000Z']);
  });

  it('reads a floating time in the user time zone', () => {
    const floating = object('f', 'DTSTART:20261103T090000', 'DTEND:20261103T100000');
    const [event] = getEventsWithRecurrenceExpansion([floating], parisDay('2026-11-03'), logger, PARIS);
    expect(event.startDate.toISOString()).toBe('2026-11-03T08:00:00.000Z');
  });

  it('shows the end date of an event of several days', () => {
    const conf = object('conf', 'DTSTART:20261101T090000Z', 'DTEND:20261105T170000Z');
    const [event] = getEventsWithRecurrenceExpansion([conf], parisDay('2026-11-03'), logger, PARIS);
    expect(formatEventTime(event, PARIS)).toBe('Sun, Nov 1, 10:00 AM - Thu, Nov 5, 6:00 PM (Europe/Paris)');
  });
});

describe('winter time', () => {
  it('a date alone ends at the right instant on the 25 hour day', () => {
    expect(parseDateRange('2026-10-25', '2026-10-25', 7, PARIS)).toEqual({
      start: '2026-10-24T22:00:00.000Z',
      end: '2026-10-25T23:00:00.000Z',
    });
  });

  it('a wall clock in winter takes the winter offset', () => {
    expect(parseDateRange('2026-12-01T09:00', '2026-12-01T10:00', 7, PARIS)).toEqual({
      start: '2026-12-01T08:00:00.000Z',
      end: '2026-12-01T09:00:00.000Z',
    });
  });

  it('today is 25 hours on the day the clock goes back', () => {
    vi.useFakeTimers({ now: new Date('2026-10-25T12:00:00Z') });
    expect(todayRange(PARIS)).toEqual({ start: '2026-10-24T22:00:00.000Z', end: '2026-10-25T23:00:00.000Z' });
    vi.useRealTimers();
  });
});

describe('exceptions of a series with a TZID', () => {
  const VTZ = [
    'BEGIN:VTIMEZONE', 'TZID:Europe/Paris',
    'BEGIN:DAYLIGHT', 'TZOFFSETFROM:+0100', 'TZOFFSETTO:+0200', 'TZNAME:CEST', 'DTSTART:19700329T020000', 'RRULE:FREQ=YEARLY;BYDAY=-1SU;BYMONTH=3', 'END:DAYLIGHT',
    'BEGIN:STANDARD', 'TZOFFSETFROM:+0200', 'TZOFFSETTO:+0100', 'TZNAME:CET', 'DTSTART:19701025T030000', 'RRULE:FREQ=YEARLY;BYDAY=-1SU;BYMONTH=10', 'END:STANDARD',
    'END:VTIMEZONE',
  ];
  const master = ['BEGIN:VEVENT', 'UID:s', 'DTSTAMP:20260101T000000Z', 'SUMMARY:series', 'DTSTART;TZID=Europe/Paris:20261102T090000', 'DTEND;TZID=Europe/Paris:20261102T100000', 'RRULE:FREQ=DAILY', 'END:VEVENT'];
  const exception = (...lines: string[]) => ['BEGIN:VEVENT', 'UID:s', 'DTSTAMP:20260101T000000Z', 'RECURRENCE-ID;TZID=Europe/Paris:20261103T090000', ...lines, 'END:VEVENT'];
  const object = (...vevents: string[][]) => ({
    url: 'https://dav.example.com/cal/s.ics',
    etag: 'e',
    data: ['BEGIN:VCALENDAR', 'VERSION:2.0', ...VTZ, ...vevents.flat(), 'END:VCALENDAR', ''].join('\r\n'),
  });
  const parisDay = (date: string) => parseDateRange(date, date, 7, PARIS) as { start: string; end: string };
  const on = (date: string, ...vevents: string[][]) =>
    getEventsWithRecurrenceExpansion([object(...vevents)], parisDay(date), logger, PARIS)
      .map((e) => `${e.summary} ${e.startDate.toISOString()}`);

  it('drops a cancelled occurrence', () => {
    expect(on('2026-11-03', master, exception('SUMMARY:gone', 'DTSTART;TZID=Europe/Paris:20261103T090000', 'DTEND;TZID=Europe/Paris:20261103T100000', 'STATUS:CANCELLED'))).toEqual([]);
  });

  it('shows an occurrence moved the same day at its new time and title', () => {
    expect(on('2026-11-03', master, exception('SUMMARY:moved', 'DTSTART;TZID=Europe/Paris:20261103T150000', 'DTEND;TZID=Europe/Paris:20261103T160000')))
      .toEqual(['moved 2026-11-03T14:00:00.000Z']);
  });

  it('moves an occurrence to another day, and only there', () => {
    const moved = exception('SUMMARY:moved', 'DTSTART;TZID=Europe/Paris:20261110T150000', 'DTEND;TZID=Europe/Paris:20261110T160000');
    expect(on('2026-11-03', master, moved)).toEqual([]);
    expect(on('2026-11-10', master, moved)).toEqual(['series 2026-11-10T08:00:00.000Z', 'moved 2026-11-10T14:00:00.000Z']);
  });

  it('keeps the series when an exception comes before the master', () => {
    const moved = exception('SUMMARY:moved', 'DTSTART;TZID=Europe/Paris:20261103T150000', 'DTEND;TZID=Europe/Paris:20261103T160000');
    expect(on('2026-11-04', moved, master)).toEqual(['series 2026-11-04T08:00:00.000Z']);
  });

  it('shows an occurrence received without its master', () => {
    const alone = exception('SUMMARY:invited', 'DTSTART;TZID=Europe/Paris:20261103T090000', 'DTEND;TZID=Europe/Paris:20261103T100000');
    expect(on('2026-11-03', alone)).toEqual(['invited 2026-11-03T08:00:00.000Z']);
  });

  it('stays at the same local hour across the change to winter time', () => {
    expect(on('2026-11-02', master)).toEqual(['series 2026-11-02T08:00:00.000Z']);
    const summer = ['BEGIN:VEVENT', 'UID:s', 'DTSTAMP:20260101T000000Z', 'SUMMARY:series', 'DTSTART;TZID=Europe/Paris:20261020T090000', 'DTEND;TZID=Europe/Paris:20261020T100000', 'RRULE:FREQ=DAILY', 'END:VEVENT'];
    expect(on('2026-10-24', summer)).toEqual(['series 2026-10-24T07:00:00.000Z']);
    expect(on('2026-10-26', summer)).toEqual(['series 2026-10-26T08:00:00.000Z']);
  });
});

describe('impossible dates', () => {
  it.each(['2026-13-01', '2026-11-03T14:99', '2026-11-03T25:00', '2026-11-03T14:00:61', '0099-01-01'])('refuses %s', (value) => {
    expect(parseDateRange(value, undefined, 7, PARIS)).toHaveProperty('problem');
  });
});

describe('dates given to the write tools', () => {
  afterEach(() => { vi.useRealTimers(); });

  it.each([
    ['2026-11-03T14:00', '2026-11-03T13:00:00.000Z'],
    ['2026-07-03T14:00:00', '2026-07-03T12:00:00.000Z'],
    ['2026-11-03T14:00:00Z', '2026-11-03T14:00:00.000Z'],
    ['2026-11-03T14:00:00+05:00', '2026-11-03T09:00:00.000Z'],
  ])('reads %s in the user time zone unless it has an offset', (text, instant) => {
    vi.useFakeTimers({ now: new Date('2026-10-31T12:00:00Z') });
    expect(parseWriteDate(text, PARIS)?.toISOString()).toBe(instant);
  });

  it('reads natural language on the day of the user, across a clock change', () => {
    // Late evening in New York is already tomorrow in Paris, and Paris is still on summer time.
    vi.useFakeTimers({ now: new Date('2026-10-24T23:30:00Z') });
    expect(parseWriteDate('tomorrow at 2pm', PARIS)?.toISOString()).toBe('2026-10-26T13:00:00.000Z');
  });

  it('matches the reading of check_availability', () => {
    const range = parseDateRange('2026-11-03T14:00', '2026-11-03T15:00', 7, PARIS) as { start: string };
    expect(parseWriteDate('2026-11-03T14:00', PARIS)?.toISOString()).toBe(range.start);
  });

  it('gives null on what it cannot read', () => {
    expect(parseWriteDate('whenever', PARIS)).toBeNull();
  });
});
