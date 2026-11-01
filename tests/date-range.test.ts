import { describe, expect, it } from 'vitest';
import { parseNaturalDateRange } from '../src/tools/calendar/utils.js';

// Sunday 1 November 2026, 10:00 local time
const NOW = new Date(2026, 10, 1, 10, 0, 0);
const day = (iso: string) => {
  const d = new Date(iso);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};
const range = (expr: string) => {
  const r = parseNaturalDateRange(expr, NOW);
  return r ? [day(r.start), day(r.end)] : null;
};

describe('parseNaturalDateRange periods (weeks start on Monday)', () => {
  it('expands weeks to Monday-Sunday', () => {
    expect(range('next week')).toEqual(['2026-11-02', '2026-11-08']);
    expect(range('this week')).toEqual(['2026-10-26', '2026-11-01']);
    expect(range('last week')).toEqual(['2026-10-19', '2026-10-25']);
    expect(range('Next Week')).toEqual(['2026-11-02', '2026-11-08']);
  });

  it('expands months and weekends', () => {
    expect(range('next month')).toEqual(['2026-12-01', '2026-12-31']);
    expect(range('this month')).toEqual(['2026-11-01', '2026-11-30']);
    expect(range('next weekend')).toEqual(['2026-11-07', '2026-11-08']);
  });

  it('understands the French forms', () => {
    expect(range('la semaine prochaine')).toEqual(['2026-11-02', '2026-11-08']);
    expect(range('cette semaine')).toEqual(['2026-10-26', '2026-11-01']);
    expect(range('le mois prochain')).toEqual(['2026-12-01', '2026-12-31']);
  });

  it('keeps single days and explicit ranges as before', () => {
    expect(range('tomorrow')).toEqual(['2026-11-02', '2026-11-02']);
    expect(range('November 3 to November 5')).toEqual(['2026-11-03', '2026-11-05']);
    expect(range('gibberish')).toBeNull();
  });
});
