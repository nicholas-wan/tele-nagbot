import { describe, it, expect } from 'vitest';
import { parseRemind, ParseError, NoTimeError } from '../src/parse.js';
import { localParts } from '../src/time.js';

const TZ = 'Asia/Singapore';
// Monday 2026-08-10 12:00 SGT.
const NOW = Date.UTC(2026, 7, 10, 4, 0, 0);

const parse = (args) => parseRemind(args, args, [], NOW, TZ);
const local = (ms) => localParts(ms, TZ);

describe('time of day', () => {
  it('parses 7.30pm as 19:30', () => {
    const r = parse('dinner 7.30pm');
    expect(r.detail).toMatchObject({ h: 19, mi: 30 });
    expect(r.text).toBe('dinner');
  });

  it('rejects an out-of-range 12h hour instead of wrapping it', () => {
    expect(() => parse('dinner 7 30pm')).toThrow(ParseError); // "30pm"
  });

  it('rejects out-of-range minutes', () => {
    expect(() => parse('x 7:99pm')).toThrow(ParseError);
    expect(() => parse('x 25:00')).toThrow(ParseError);
  });

  it('still parses plain forms', () => {
    expect(parse('x 7pm').detail).toMatchObject({ h: 19, mi: 0 });
    expect(parse('x 9:30am').detail).toMatchObject({ h: 9, mi: 30 });
    expect(parse('x at 19:00').detail).toMatchObject({ h: 19, mi: 0 });
  });
});

describe('schedule tokens vs chore text', () => {
  it('keeps a mid-text weekday word as text', () => {
    const r = parse('buy sun hat 5pm');
    expect(r.text).toBe('buy sun hat');
    expect(local(r.firstFireAt)).toMatchObject({ y: 2026, mo: 8, d: 10, h: 17 });
  });

  it('treats a trailing weekday as a date', () => {
    const r = parse('trash sun 7pm');
    expect(r.text).toBe('trash');
    expect(local(r.firstFireAt)).toMatchObject({ d: 16, wd: 0, h: 19 });
  });

  it('treats "on <day>" as a date anywhere', () => {
    const r = parse('groceries on fri 5pm');
    expect(r.text).toBe('groceries');
    expect(local(r.firstFireAt)).toMatchObject({ d: 14, wd: 5 });
  });

  it('keeps "on the 2nd floor" as text', () => {
    const r = parse('view flat on the 2nd floor 5pm');
    expect(r.kind).toBe('once');
    expect(r.text).toBe('view flat on the 2nd floor');
  });

  it('parses "on the 1st" (and "at" after it) as monthly', () => {
    expect(parse('pay rent on the 1st 10am')).toMatchObject({ kind: 'monthly', detail: { dom: 1 } });
    expect(parse('pay rent on the 1st at 10am')).toMatchObject({ kind: 'monthly', detail: { dom: 1 } });
    expect(parse('pay rent monthly on the 3rd 9am')).toMatchObject({ kind: 'monthly', detail: { dom: 3 } });
  });

  it('starts "tomorrow ... daily" tomorrow with clean text', () => {
    const r = parse('trash tomorrow 7pm daily');
    expect(r.kind).toBe('daily');
    expect(r.text).toBe('trash');
    expect(local(r.firstFireAt)).toMatchObject({ d: 11, h: 19 });
  });
});

describe('assignee', () => {
  it('does not treat an email domain as an assignee', () => {
    const r = parse('email bob@work.com 5pm');
    expect(r.assigneeName).toBeNull();
    expect(r.text).toBe('email bob@work.com');
  });

  it('picks up a standalone @mention', () => {
    const r = parse('@jane dishes 8pm');
    expect(r.assigneeName).toBe('@jane');
    expect(r.text).toBe('dishes');
  });
});

describe('other forms', () => {
  it('relative and immediate one-offs', () => {
    expect(parse('check oven in 20m').firstFireAt).toBe(NOW + 20 * 60000);
    expect(parse('dishes now').firstFireAt).toBe(NOW);
  });

  it('nag override', () => {
    expect(parse('trash 7pm nag:10m').nagIntervals).toEqual([10]);
  });

  it('weekly multi-day', () => {
    expect(parse('plants every mon,thu 8am')).toMatchObject({ kind: 'weekly', detail: { days: [1, 4] } });
  });

  it('every N weeks becomes an N*7-day interval', () => {
    const r = parse('cat fountain every 2 weeks 7pm');
    expect(r).toMatchObject({ kind: 'interval', detail: { days: 14 } });
    expect(r.text).toBe('cat fountain');
    expect(parse('filters every 1 week 9am')).toMatchObject({ kind: 'interval', detail: { days: 7 } });
  });

  it('missing time raises the wizard with the partial intact', () => {
    try {
      parse('take out trash daily');
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(NoTimeError);
      expect(e.partial).toMatchObject({ text: 'take out trash', kind: 'daily' });
    }
  });

  it('past time today errors', () => {
    expect(() => parse('x today 9am')).toThrow(ParseError); // it is 12:00
  });
});
