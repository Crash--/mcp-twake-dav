import { describe, it, expect } from 'vitest';
import pino from 'pino';
import { computeBusyPeriods, getEventsWithRecurrenceExpansion } from '../../src/tools/calendar/utils.js';

const logger = pino({ level: 'silent' });

const VTZ = [
  'BEGIN:VTIMEZONE', 'TZID:Europe/Paris',
  'BEGIN:DAYLIGHT', 'TZOFFSETFROM:+0100', 'TZOFFSETTO:+0200', 'TZNAME:CEST', 'DTSTART:19700329T020000', 'RRULE:FREQ=YEARLY;BYDAY=-1SU;BYMONTH=3', 'END:DAYLIGHT',
  'BEGIN:STANDARD', 'TZOFFSETFROM:+0200', 'TZOFFSETTO:+0100', 'TZNAME:CET', 'DTSTART:19701025T030000', 'RRULE:FREQ=YEARLY;BYDAY=-1SU;BYMONTH=10', 'END:STANDARD',
  'END:VTIMEZONE',
];
const master = ['BEGIN:VEVENT', 'UID:s', 'DTSTAMP:20260101T000000Z', 'SUMMARY:series', 'DTSTART;TZID=Europe/Paris:20261102T090000', 'DTEND;TZID=Europe/Paris:20261102T100000', 'RRULE:FREQ=DAILY', 'END:VEVENT'];
const exception = (day: string, ...lines: string[]) => ['BEGIN:VEVENT', 'UID:s', 'DTSTAMP:20260101T000000Z', `RECURRENCE-ID;TZID=Europe/Paris:${day}T090000`, ...lines, 'END:VEVENT'];
const at = (day: string, hour: string) => [`DTSTART;TZID=Europe/Paris:${day}T${hour}0000`, `DTEND;TZID=Europe/Paris:${day}T${hour}3000`];
const object = (...vevents: string[][]) => ({
  url: 'https://dav.example.com/cal/s.ics',
  etag: 'e',
  data: ['BEGIN:VCALENDAR', 'VERSION:2.0', ...VTZ, ...vevents.flat(), 'END:VCALENDAR', ''].join('\r\n'),
});
const range = (day: string) => {
  const start = new Date(`${day}T00:00:00+01:00`);
  return { start: start.toISOString(), end: new Date(start.getTime() + 86_400_000).toISOString() };
};
const on = (day: string, ...vevents: string[][]) =>
  getEventsWithRecurrenceExpansion([object(...vevents)], range(day), logger)
    .map((e) => `${e.summary} ${e.startDate.toISOString()}`);

describe('exceptions of a series with RECURRENCE-ID;TZID', () => {
  it('drops a cancelled occurrence', () => {
    expect(on('2026-11-03', master, exception('20261103', 'SUMMARY:gone', ...at('20261103', '09'), 'STATUS:CANCELLED'))).toEqual([]);
  });

  it('shows an occurrence moved the same day at its new time and title', () => {
    expect(on('2026-11-03', master, exception('20261103', 'SUMMARY:moved', ...at('20261103', '15'))))
      .toEqual(['moved 2026-11-03T14:00:00.000Z']);
  });

  it('moves an occurrence to another day, and only there', () => {
    const moved = exception('20261103', 'SUMMARY:moved', ...at('20261110', '15'));
    expect(on('2026-11-03', master, moved)).toEqual([]);
    expect(on('2026-11-10', master, moved)).toEqual(['series 2026-11-10T08:00:00.000Z', 'moved 2026-11-10T14:00:00.000Z']);
  });

  it('matches an exception whose RECURRENCE-ID is in UTC', () => {
    const utc = ['BEGIN:VEVENT', 'UID:s', 'DTSTAMP:20260101T000000Z', 'RECURRENCE-ID:20261103T080000Z', 'SUMMARY:moved', ...at('20261103', '15'), 'END:VEVENT'];
    expect(on('2026-11-03', master, utc)).toEqual(['moved 2026-11-03T14:00:00.000Z']);
  });

  it('keeps the series when an exception comes before the master', () => {
    const moved = exception('20261103', 'SUMMARY:moved', ...at('20261103', '15'));
    expect(on('2026-11-04', moved, master)).toEqual(['series 2026-11-04T08:00:00.000Z']);
    expect(on('2026-11-03', moved, master)).toEqual(['moved 2026-11-03T14:00:00.000Z']);
  });

  it('shows each occurrence received without a master', () => {
    const first = exception('20261103', 'SUMMARY:invited', ...at('20261103', '09'));
    const second = exception('20261104', 'SUMMARY:again', ...at('20261104', '09'));
    expect(on('2026-11-03', first, second)).toEqual(['invited 2026-11-03T08:00:00.000Z']);
    expect(on('2026-11-04', first, second)).toEqual(['again 2026-11-04T08:00:00.000Z']);
  });

  it('counts a moved occurrence as busy at its new time, not at the old one', () => {
    const moved = exception('20261103', 'SUMMARY:moved', ...at('20261103', '15'));
    const events = getEventsWithRecurrenceExpansion([object(master, moved)], range('2026-11-03'), logger);
    expect(computeBusyPeriods(events, logger).map((p) => p.start.toISOString())).toEqual(['2026-11-03T14:00:00.000Z']);
  });
});
