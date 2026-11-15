// The Poppy bonus: @Dodgerblueee's chores score ×2 from 15 Nov 2026, when it
// went live, through Wed 30 Jun 2027 (nine months on from 1 Oct).
import { it, expect, vi, afterEach } from 'vitest';
import { POPPY_BONUS, pointsFor, bonusLive, bonusBanner, bonusText } from '../src/bonus.js';
import { choreStatsFrom, streakFrom } from '../src/stats.js';

const IN = POPPY_BONUS.from + 3600000;
const BEFORE = POPPY_BONUS.from - 3600000;
const AFTER = POPPY_BONUS.until + 3600000;
const rows = (list) => ({ results: list.map(([done_by, done_at]) => ({ done_by, done_at, text: 'dishes' })) });

afterEach(() => vi.restoreAllMocks());

it('doubles only her chores, only inside the window, whatever the case', () => {
  expect(pointsFor('@Dodgerblueee', IN)).toBe(2);
  expect(pointsFor('@dodgerblueee', IN)).toBe(2);
  expect(pointsFor('@Dodgerblueee', BEFORE)).toBe(1);
  expect(pointsFor('@Dodgerblueee', AFTER)).toBe(1);
  expect(pointsFor('@nicholaswan', IN)).toBe(1);
});

it('ranks the board by points, counting her share of a chore done together', () => {
  const s = choreStatsFrom({ results: [{ n: 0 }] }, rows([
    ['@nicholaswan', IN], ['@nicholaswan', IN], ['@nicholaswan', IN],
    ['@Dodgerblueee', IN], ['@nicholaswan & @Dodgerblueee', IN],
  ]));
  expect(s.people.map(([who, items]) => [who, items.length, s.score.get(who)])).toEqual([
    ['@nicholaswan', 4, 4],
    ['@Dodgerblueee', 2, 4],
  ]);
  // A tie on points goes to the bigger ✅ count, as before.
  expect(s.people[0][0]).toBe('@nicholaswan');
  const s2 = choreStatsFrom({ results: [{ n: 0 }] }, rows([
    ['@nicholaswan', IN], ['@nicholaswan', IN], ['@nicholaswan', IN], ['@Dodgerblueee', IN], ['@Dodgerblueee', IN],
  ]));
  expect(s2.people[0][0]).toBe('@Dodgerblueee');
  expect(s2.score.get('@Dodgerblueee')).toBe(4);
});

it('counts the bonus in the winning streak', () => {
  vi.spyOn(Date, 'now').mockReturnValue(Date.parse('2026-11-25T12:00:00+08:00')); // Wed
  const lastWeek = Date.parse('2026-11-19T12:00:00+08:00'); // the Thursday before
  const past = [['@nicholaswan', lastWeek], ['@nicholaswan', lastWeek], ['@Dodgerblueee', lastWeek], ['@Dodgerblueee', lastWeek]]
    .map(([done_by, done_at]) => ({ done_by, done_at }));
  expect(streakFrom(past, 'Asia/Singapore', '@Dodgerblueee')).toBe(1);
});

it('runs from tonight, not back-dated, to the end of 30 Jun 2027, Singapore time', () => {
  expect(pointsFor('@Dodgerblueee', Date.parse('2026-10-01T09:00:00+08:00'))).toBe(1);
  expect(pointsFor('@Dodgerblueee', Date.parse('2026-11-15T19:00:00+08:00'))).toBe(1);
  expect(pointsFor('@Dodgerblueee', Date.parse('2026-11-15T21:00:00+08:00'))).toBe(2);
  expect(pointsFor('@Dodgerblueee', Date.parse('2027-06-30T23:59:00+08:00'))).toBe(2);
  expect(pointsFor('@Dodgerblueee', Date.parse('2027-07-01T00:01:00+08:00'))).toBe(1);
});

it('says when it ends, in the past tense once it has, and only on weeks it touches', () => {
  expect(bonusBanner('Asia/Singapore', IN)).toBe('🐾 <b>Poppy bonus</b>: @Dodgerblueee\'s chores count ×2 until Wed, Jun 30, 2027');
  expect(bonusText('Asia/Singapore', AFTER)).toBe('@Dodgerblueee\'s chores counted ×2 through Wed, Jun 30, 2027');
  expect(bonusLive(POPPY_BONUS.from - 7 * 86400000, BEFORE)).toBe(false);
  expect(bonusLive(BEFORE, IN)).toBe(true);
  expect(bonusLive(POPPY_BONUS.until, AFTER)).toBe(false);
});
