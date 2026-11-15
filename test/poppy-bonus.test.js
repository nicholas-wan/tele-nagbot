// The Poppy bonus: @Dodgerblueee's chores score ×2 from 15 Nov 2026, when it
// went live, through Wed 30 Jun 2027 (nine months on from 1 Oct). Real SQLite
// behind the D1 shim for the boards and the recap.
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { it, expect, vi, beforeEach, afterEach, describe } from 'vitest';
import { POPPY_BONUS, pointsFor, bonusLine } from '../src/bonus.js';
import { choreStatsFrom, streakFrom, tallyText, outright, statsHtml } from '../src/stats.js';
import { sendWeeklyRecap } from '../src/cron.js';
import { d1 } from './d1.js';

const TZ = 'Asia/Singapore';
const HOUR = 3600000;
const DAY = 24 * HOUR;
const IN = POPPY_BONUS.from + HOUR;
const BEFORE = POPPY_BONUS.from - HOUR;
const AFTER = POPPY_BONUS.until + HOUR;
const WED = Date.parse('2026-11-25T12:00:00+08:00'); // mid-window
const SUN_8PM = Date.parse('2026-11-29T20:00:00+08:00'); // that week's recap
const rows = (list) => ({ results: list.map(([done_by, done_at]) => ({ done_by, done_at, reminder_id: 8, text: 'dishes' })) });
const stats = (list) => choreStatsFrom({ results: [{ n: 0 }] }, rows(list));

let sql, env, calls;
beforeEach(() => {
  sql = new DatabaseSync(':memory:');
  sql.exec(readFileSync(new URL('../schema.sql', import.meta.url), 'utf8'));
  sql.exec('INSERT INTO settings (chat_id) VALUES (1)');
  env = { BOT_TOKEN: 'test', ALLOWED_CHATS: '1', DB: d1(sql) };
  calls = [];
  vi.stubGlobal('fetch', vi.fn(async (url, init) => {
    calls.push({ url: String(url), body: JSON.parse(init.body) });
    return new Response(JSON.stringify({ ok: true, result: { message_id: 99 } }));
  }));
});
afterEach(() => { sql.close(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

const done = (by, at, n = 1) => {
  for (let i = 0; i < n; i++) {
    sql.prepare(`INSERT INTO firings (reminder_id, chat_id, reminder_text, fired_at, state, done_by, done_at, scored)
      VALUES (1, 1, 'dishes', ?, 'done', ?, ?, 1)`).run(at - i * 60000, by, at - i * 60000);
  }
};

describe('the window', () => {
  it('never doubles a chore done together, or a quick tap', () => {
    const shared = { done_by: '@nicholaswan & @Dodgerblueee', done_at: IN, reminder_id: 8 };
    expect(pointsFor(shared, '@Dodgerblueee')).toBe(1);
    expect(pointsFor({ done_by: '@Dodgerblueee', done_at: IN, reminder_id: 0 }, '@Dodgerblueee')).toBe(1);
    expect(pointsFor({ done_by: '@Dodgerblueee', done_at: IN, reminder_id: 8 }, '@Dodgerblueee')).toBe(2);
  });

  it('scores 1 for a row read without its reminder_id', () => {
    expect(pointsFor({ done_by: '@Dodgerblueee', done_at: IN }, '@Dodgerblueee')).toBe(1);
  });

  it('doubles only her chores, spelled as her username', () => {
    expect(pointsFor({ done_by: '@Dodgerblueee', done_at: IN, reminder_id: 8 }, '@Dodgerblueee')).toBe(2);
    // Exact: only her username starts with @, so another spelling is not her.
    expect(pointsFor({ done_by: '@dodgerblueee', done_at: IN, reminder_id: 8 }, '@dodgerblueee')).toBe(1);
    expect(pointsFor({ done_by: '@nicholaswan', done_at: IN, reminder_id: 8 }, '@nicholaswan')).toBe(1);
    expect(pointsFor({ done_by: '@Dodgerblueee', done_at: BEFORE, reminder_id: 8 }, '@Dodgerblueee')).toBe(1);
    expect(pointsFor({ done_by: '@Dodgerblueee', done_at: AFTER, reminder_id: 8 }, '@Dodgerblueee')).toBe(1);
  });

  it('runs from tonight, not back-dated, to the end of 30 Jun 2027, Singapore time', () => {
    expect(pointsFor({ done_by: '@Dodgerblueee', done_at: Date.parse('2026-10-01T09:00:00+08:00'), reminder_id: 8 }, '@Dodgerblueee')).toBe(1);
    expect(pointsFor({ done_by: '@Dodgerblueee', done_at: Date.parse('2026-11-15T19:00:00+08:00'), reminder_id: 8 }, '@Dodgerblueee')).toBe(1);
    expect(pointsFor({ done_by: '@Dodgerblueee', done_at: Date.parse('2026-11-15T21:00:00+08:00'), reminder_id: 8 }, '@Dodgerblueee')).toBe(2);
    expect(pointsFor({ done_by: '@Dodgerblueee', done_at: Date.parse('2027-06-30T23:59:00+08:00'), reminder_id: 8 }, '@Dodgerblueee')).toBe(2);
    expect(pointsFor({ done_by: '@Dodgerblueee', done_at: Date.parse('2027-07-01T00:01:00+08:00'), reminder_id: 8 }, '@Dodgerblueee')).toBe(1);
    // After the start, up to and including the end, as the boards' windows run.
    expect(pointsFor({ done_by: '@Dodgerblueee', done_at: POPPY_BONUS.from, reminder_id: 8 }, '@Dodgerblueee')).toBe(1);
    expect(pointsFor({ done_by: '@Dodgerblueee', done_at: POPPY_BONUS.until, reminder_id: 8 }, '@Dodgerblueee')).toBe(2);
  });

  it('says so on the weeks it touches, through its last day, in the past tense once over', () => {
    expect(bonusLine(BEFORE - 7 * DAY, BEFORE, TZ)).toBe(null);
    expect(bonusLine(POPPY_BONUS.until, AFTER, TZ)).toBe(null);
    expect(bonusLine(BEFORE, IN, TZ, { now: IN }))
      .toBe("🐾 <b>Poppy bonus</b>: chores @Dodgerblueee does alone count ×2 through Wed, Jun 30, 2027");
    expect(bonusLine(BEFORE, IN, TZ, { now: AFTER, html: false }))
      .toBe("🐾 Poppy bonus: chores @Dodgerblueee does alone counted ×2 through Wed, Jun 30, 2027");
  });
});

describe('the tally', () => {
  it('ranks by points, her share of a chore done together scoring 1', () => {
    const s = stats([['@nicholaswan', IN], ['@Dodgerblueee', IN], ['@nicholaswan & @Dodgerblueee', IN]]);
    expect(s.people.map(([who, items]) => [who, items.length, s.score.get(who)])).toEqual([
      ['@Dodgerblueee', 2, 3], ['@nicholaswan', 2, 2],
    ]);
    expect(s.boosted).toBe(true);
    expect(tallyText(s, '@nicholaswan', s.people[1][1])).toBe('2 pts · 2 ✅');
  });

  it('stays a plain ✅ count in a week nothing was doubled', () => {
    const s = stats([['@nicholaswan', BEFORE], ['@Dodgerblueee', BEFORE]]);
    expect(s.boosted).toBe(false);
    expect(tallyText(s, '@Dodgerblueee', s.people[0][1])).toBe('1 ✅');
  });

  it('puts the bigger ✅ count first on a tie in points, but crowns nobody outright', () => {
    const s = stats([['@nicholaswan', IN], ['@nicholaswan', IN], ['@Dodgerblueee', IN]]);
    expect(s.people[0][0]).toBe('@nicholaswan');
    expect(outright(s)).toBe(false);
    expect(outright(stats([['@Dodgerblueee', IN]]))).toBe(true);
  });

  it('counts the bonus in the winning streak', () => {
    vi.spyOn(Date, 'now').mockReturnValue(WED);
    const lastWeek = WED - 6 * DAY; // the Thursday before
    const past = [['@nicholaswan', lastWeek], ['@nicholaswan', lastWeek], ['@Dodgerblueee', lastWeek], ['@Dodgerblueee', lastWeek]]
      .map(([done_by, done_at]) => ({ done_by, done_at, reminder_id: 8 }));
    expect(streakFrom(past, TZ, '@Dodgerblueee')).toBe(1);
  });
});

describe('/stats', () => {
  it('shows the line and everyone in points on This week', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(WED);
    done('@Dodgerblueee', WED - HOUR, 3);
    done('@nicholaswan', WED - 2 * HOUR, 5);
    const html = await statsHtml(env, 1, TZ, 'week');
    expect(html).toContain("🐾 <b>Poppy bonus</b>: chores @Dodgerblueee does alone count ×2 through Wed, Jun 30, 2027");
    expect(html).toContain('🥇 <b>@Dodgerblueee</b> — 6 pts · 3 ✅');
    expect(html).toContain('🥈 <b>@nicholaswan</b> — 5 pts · 5 ✅');
  });

  it('keeps the 6-month log in ✅ counts and in their order', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(WED);
    done('@Dodgerblueee', WED - HOUR, 3);
    done('@nicholaswan', WED - 2 * HOUR, 5);
    const html = await statsHtml(env, 1, TZ, 'all');
    expect(html).not.toContain('pts');
    expect(html).not.toContain('Poppy');
    expect(html.indexOf('@nicholaswan</b> — 5 ✅')).toBeGreaterThan(-1);
    expect(html.indexOf('@nicholaswan')).toBeLessThan(html.indexOf('@Dodgerblueee'));
  });
});

describe('the Sunday recap', () => {
  const recap = async () => {
    vi.spyOn(Date, 'now').mockReturnValue(SUN_8PM);
    await sendWeeklyRecap(env, SUN_8PM, new Set(), [1]);
    return calls.filter((c) => c.url.endsWith('/sendMessage')).at(-1).body.text;
  };

  it('crowns by points and shows everyone in points', async () => {
    done('@Dodgerblueee', SUN_8PM - DAY, 3);
    done('@nicholaswan', SUN_8PM - DAY, 5);
    const text = await recap();
    expect(text).toContain("🐾 <b>Poppy bonus</b>: chores @Dodgerblueee does alone count ×2 through Wed, Jun 30, 2027");
    expect(text).toContain('🥇 @Dodgerblueee takes the week with 6 pts · 3 ✅!');
    expect(text).toContain('• @nicholaswan: 5 pts · 5 ✅');
  });

  it('calls a tie in points a tie, in points', async () => {
    done('@Dodgerblueee', SUN_8PM - DAY, 2);
    done('@nicholaswan', SUN_8PM - DAY, 4);
    expect(await recap()).toContain("It's a tie between @nicholaswan and @Dodgerblueee at 4 pts each");
  });

  it('keeps ✅ in a bonus week where nothing was doubled', async () => {
    const start = Date.parse('2026-11-15T20:00:00+08:00'); // the week it began, 15 min in
    done('@Dodgerblueee', POPPY_BONUS.from - HOUR, 2);
    done('@nicholaswan', POPPY_BONUS.from - HOUR, 2);
    vi.spyOn(Date, 'now').mockReturnValue(start);
    await sendWeeklyRecap(env, start, new Set(), [1]);
    const text = calls.filter((c) => c.url.endsWith('/sendMessage')).at(-1).body.text;
    expect(text).toContain('at 2 ✅ each');
  });
});
