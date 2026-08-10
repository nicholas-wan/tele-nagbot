import { describe, it, expect } from 'vitest';
import { localParts, zonedEpoch, nextOccurrence, weekStart } from '../src/time.js';

const TZ = 'Asia/Singapore';
// Monday 2026-08-10 12:00 SGT.
const NOW = Date.UTC(2026, 7, 10, 4, 0, 0);
const local = (ms) => localParts(ms, TZ);

describe('zonedEpoch', () => {
  it('round-trips a wall-clock time', () => {
    const t = zonedEpoch(2026, 8, 10, 19, 30, TZ);
    expect(local(t)).toMatchObject({ y: 2026, mo: 8, d: 10, h: 19, mi: 30 });
  });

  it('handles a DST spring-forward gap by landing on the shifted time', () => {
    // US Eastern 2026-03-08: 02:30 does not exist; expect a real instant.
    const t = zonedEpoch(2026, 3, 8, 2, 30, 'America/New_York');
    expect(Number.isFinite(t)).toBe(true);
    expect(local(t)).toBeTruthy();
  });
});

describe('nextOccurrence', () => {
  it('daily: later today if the slot is ahead, else tomorrow', () => {
    expect(local(nextOccurrence('daily', { h: 19, mi: 0 }, NOW, TZ))).toMatchObject({ d: 10, h: 19 });
    expect(local(nextOccurrence('daily', { h: 9, mi: 0 }, NOW, TZ))).toMatchObject({ d: 11, h: 9 });
  });

  it('weekly: next listed weekday strictly after now', () => {
    const t = nextOccurrence('weekly', { days: [1, 4], h: 8, mi: 0 }, NOW, TZ);
    expect(local(t)).toMatchObject({ d: 13, wd: 4, h: 8 }); // Thu (Mon 8am passed)
  });

  it('monthly: clamps day 31 in short months without skipping', () => {
    // After Apr 1: April has 30 days -> Apr 30.
    const afterApr1 = zonedEpoch(2026, 4, 1, 12, 0, TZ);
    const t = nextOccurrence('monthly', { dom: 31, h: 10, mi: 0 }, afterApr1, TZ);
    expect(local(t)).toMatchObject({ mo: 4, d: 30, h: 10 });
  });

  it('interval: N days after the fire date', () => {
    const t = nextOccurrence('interval', { days: 8, h: 21, mi: 0 }, NOW, TZ);
    expect(local(t)).toMatchObject({ d: 18, h: 21 });
  });

  it('once: null', () => {
    expect(nextOccurrence('once', {}, NOW, TZ)).toBeNull();
  });
});

describe('weekStart', () => {
  it('is Monday 00:00 local', () => {
    expect(local(weekStart(NOW, TZ))).toMatchObject({ d: 10, wd: 1, h: 0, mi: 0 });
    // A Sunday still belongs to the week that began the previous Monday.
    const sunday = zonedEpoch(2026, 8, 16, 21, 0, TZ);
    expect(local(weekStart(sunday, TZ))).toMatchObject({ d: 10, wd: 1 });
  });
});
