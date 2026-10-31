import { describe, it, expect } from 'vitest';
import { checkWindow, paginateEvents, type EventCursor } from '../../src/tools/calendar/utils.js';
import type { EventDTO } from '../../src/types/dtos.js';

const event = (uid: string, start: string) =>
  ({ uid, url: `/${uid}.ics`, startDate: new Date(start), endDate: new Date(start) }) as EventDTO;

function walk(events: EventDTO[], limit: number): string[] {
  const seen: string[] = [];
  let cursor: EventCursor | undefined;
  for (let pages = 0; pages < 100; pages++) {
    const { page, nextCursor } = paginateEvents(events, limit, cursor);
    seen.push(...page.map((e) => e.uid));
    if (!nextCursor) return seen;
    cursor = nextCursor;
  }
  throw new Error('the walk does not end');
}

describe('paginateEvents', () => {
  it('walks simultaneous events without a hole or a duplicate, at any page size', () => {
    const events = [
      event('a', '2026-01-01T09:00:00Z'),
      ...Array.from({ length: 12 }, (_, i) => event(`same-${String(i).padStart(2, '0')}`, '2026-01-01T10:00:00Z')),
      event('z', '2026-01-02T09:00:00Z'),
    ];
    for (const limit of [1, 2, 5, 13, 14, 100]) {
      expect(walk(events, limit)).toEqual(events.map((e) => e.uid));
    }
  });

  it('counts the events of earlier pages in skip', () => {
    const events = Array.from({ length: 5 }, (_, i) => event(`e${i}`, '2026-01-01T10:00:00Z'));
    const first = paginateEvents(events, 2);
    expect(first.nextCursor).toEqual({ start: '2026-01-01T10:00:00.000Z', skip: 2 });
    expect(paginateEvents(events, 2, first.nextCursor!).nextCursor?.skip).toBe(4);
  });

  it('does not repeat a running event that started before the cursor', () => {
    const events = [event('running', '2026-01-01T08:00:00Z'), event('next', '2026-01-02T08:00:00Z')];
    const { page } = paginateEvents(events, 10, { start: '2026-01-02T08:00:00.000Z', skip: 0 });
    expect(page.map((e) => e.uid)).toEqual(['next']);
  });

  it('has no next cursor on an exact last page', () => {
    const events = [event('a', '2026-01-01T08:00:00Z'), event('b', '2026-01-02T08:00:00Z')];
    expect(paginateEvents(events, 2).nextCursor).toBeNull();
  });
});

describe('checkWindow', () => {
  it('accepts 92 days and refuses more', () => {
    expect(checkWindow({ start: '2026-01-01T00:00:00Z', end: '2026-04-03T00:00:00Z' })).toBeNull();
    expect(checkWindow({ start: '2026-01-01T00:00:00Z', end: '2026-04-03T00:00:01Z' })).toContain('92 days');
  });

  it('refuses a cursor outside the range', () => {
    const range = { start: '2026-01-01T00:00:00Z', end: '2026-02-01T00:00:00Z' };
    expect(checkWindow(range, { start: '2027-01-01T00:00:00Z', skip: 0 })).toContain('cursor');
  });
});
