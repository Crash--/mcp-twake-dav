/**
 * check_availability: all-day events (holidays, trade shows, custody weekends) are markers,
 * not busy time, and must never hide the timed events of the following days.
 */
import { describe, it, expect, vi } from 'vitest';
import type { Logger } from 'pino';
import type { DAVCalendarObject } from 'tsdav';
import { computeBusyPeriods, formatEventTime, getEventsWithRecurrenceExpansion } from '../../src/tools/calendar/utils.js';
import { buildAvailabilityText } from '../../src/tools/calendar/check-availability.js';

const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } as unknown as Logger;

const ics = (vevent: string) => `BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//Test//EN\r\nBEGIN:VEVENT\r\n${vevent.trim().split('\n').map((l) => l.trim()).join('\r\n')}\r\nEND:VEVENT\r\nEND:VCALENDAR`;
const obj = (name: string, vevent: string): DAVCalendarObject => ({ url: `https://dav.example.com/cal/${name}.ics`, etag: '"1"', data: ics(vevent) });

// Every other Thursday, all day from Thursday to Monday (exclusive): the real shape of a custody marker
const CUSTODY = obj('custody', `
  UID:custody@example.com
  SUMMARY:Children
  DTSTART;VALUE=DATE:20201001
  DTEND;VALUE=DATE:20201005
  RRULE:FREQ=WEEKLY;INTERVAL=2;BYDAY=TH
`);
const HOLIDAY = obj('holiday', `
  UID:holiday@example.com
  SUMMARY:Public holiday
  DTSTART;VALUE=DATE:20261111
  DTEND;VALUE=DATE:20261112
`);
const WED = obj('wed', `
  UID:wed@example.com
  SUMMARY:Wednesday meeting
  DTSTART:20261104T090000Z
  DTEND:20261104T100000Z
`);
const FRI = obj('fri', `
  UID:fri@example.com
  SUMMARY:Friday meeting
  DTSTART:20261106T140000Z
  DTEND:20261106T150000Z
`);
const DAILY = obj('daily', `
  UID:daily@example.com
  SUMMARY:Daily stand-up
  DTSTART:20261026T083000Z
  DTEND:20261026T100000Z
  RRULE:FREQ=DAILY
`);

const range = { start: '2026-11-04T07:00:00Z', end: '2026-11-06T18:00:00Z' };
const local = (y: number, m: number, d: number) => new Date(y, m - 1, d).getTime();

describe('all-day events in the event model', () => {
  it('flags all-day occurrences of a recurring series and keeps their real span', () => {
    const events = getEventsWithRecurrenceExpansion([CUSTODY], range, logger);
    expect(events).toHaveLength(1);
    expect(events[0].allDay).toBe(true);
    expect(events[0].startDate.getTime()).toBe(local(2026, 11, 5));
    expect(events[0].endDate.getTime()).toBe(local(2026, 11, 9));
  });

  it('flags timed events as not all-day', () => {
    expect(getEventsWithRecurrenceExpansion([WED], range, logger)[0].allDay).toBe(false);
  });

  it('keeps an occurrence that started before the range but overlaps it, drops one that ended before', () => {
    const fromNine = { start: '2026-11-04T09:00:00Z', end: '2026-11-04T18:00:00Z' };
    const events = getEventsWithRecurrenceExpansion([DAILY], fromNine, logger);
    expect(events.map((e) => e.startDate.toISOString())).toEqual(['2026-11-04T08:30:00.000Z']);
    const fromTen = { start: '2026-11-04T10:00:00Z', end: '2026-11-04T18:00:00Z' };
    expect(getEventsWithRecurrenceExpansion([DAILY], fromTen, logger)).toEqual([]);
  });

  it('shows all-day events as dates, with their last day', () => {
    const [custody] = getEventsWithRecurrenceExpansion([CUSTODY], range, logger);
    expect(formatEventTime(custody, 'UTC')).toBe('Thu, Nov 5 – Sun, Nov 8 (all day)');
    const [holiday] = getEventsWithRecurrenceExpansion([HOLIDAY], { start: '2026-11-11T00:00:00Z', end: '2026-11-12T00:00:00Z' }, logger);
    expect(formatEventTime(holiday, 'UTC')).toBe('Wed, Nov 11 (all day)');
  });
});

describe('computeBusyPeriods', () => {
  const events = getEventsWithRecurrenceExpansion([CUSTODY, WED, FRI], range, logger);

  it('ignores all-day events by default', () => {
    expect(computeBusyPeriods(events, logger).map((p) => p.start.toISOString())).toEqual([
      '2026-11-04T09:00:00.000Z',
      '2026-11-06T14:00:00.000Z',
    ]);
  });

  it('counts them when asked', () => {
    const periods = computeBusyPeriods(events, logger, { allDayBusy: true });
    expect(periods.some((p) => p.start.getTime() === local(2026, 11, 5))).toBe(true);
  });
});

describe('buildAvailabilityText', () => {
  const events = getEventsWithRecurrenceExpansion([CUSTODY, WED, FRI], range, logger);
  const start = new Date(range.start);
  const end = new Date(range.end);

  it('lists the timed busy periods of every day and the all-day events apart', () => {
    const text = buildAvailabilityText(events, start, end, 'UTC', { allDayBusy: false });
    expect(text).toContain('1. Wed, Nov 4, 9:00 AM - 10:00 AM');
    expect(text).toContain('2. Fri, Nov 6, 2:00 PM - 3:00 PM');
    expect(text).toMatch(/All-day events \(not counted as busy[^)]*\):\n- Thu, Nov 5 – Sun, Nov 8: Children/);
  });

  it('clips periods to the range and dates the end of a period that ends on another day', () => {
    const text = buildAvailabilityText(events, start, end, 'UTC', { allDayBusy: true });
    // the marker starts at local midnight of Nov 5 (shown in UTC here) and is clipped at the range end
    const startUtc = new Date(2026, 10, 5).toLocaleString('en-US', { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: 'UTC' });
    expect(text).toContain(`${startUtc} - Fri, Nov 6, 6:00 PM`);
    expect(text).not.toContain('Nov 9');
  });

  it('says when the range is free, still mentioning all-day events', () => {
    const quiet = getEventsWithRecurrenceExpansion([HOLIDAY], { start: '2026-11-11T07:00:00Z', end: '2026-11-11T18:00:00Z' }, logger);
    const text = buildAvailabilityText(quiet, new Date('2026-11-11T07:00:00Z'), new Date('2026-11-11T18:00:00Z'), 'UTC', { allDayBusy: false });
    expect(text).toMatch(/No busy periods/);
    expect(text).toContain('- Wed, Nov 11: Public holiday');
  });
});
