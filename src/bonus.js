// The Poppy bonus: a temporary score multiplier for one person. Chores they
// finish alone inside the window count double on the weekly boards, the
// streak and the Sunday recap. Chores done together and quick taps from the
// pinned pad never do. The 6-month log and the rotation's fairness count stay
// plain. It lapses on its own; delete this file's uses any time after.

import { CREDIT_SEP, QUICK_TAP_ID } from './household.js';

export const POPPY_BONUS = {
  name: 'Poppy bonus',
  // The roster spelling, compared case-insensitively. firings.done_by keeps
  // names, not user ids, so a change of Telegram username ends the bonus.
  who: '@Dodgerblueee',
  multiplier: 2,
  from: Date.parse('2026-11-15T19:45:00+08:00'), // when it went live; not back-dated
  until: Date.parse('2027-07-01T00:00:00+08:00'), // nine months on from 1 Oct 2026: Wed 30 Jun 2027 is its last day
};

const isBonusPerson = (who) => String(who || '').toLowerCase() === POPPY_BONUS.who.toLowerCase();

// Points `who` earns for one done firing row ({ done_by, done_at,
// reminder_id }): doubled only for a chore she did alone, after the start, up
// to and including the end, as the boards' own windows run. A row read
// without its reminder_id scores 1: a query that forgot the column must not
// double every quick tap.
export function pointsFor(row, who) {
  const alone = !String(row.done_by || '').includes(CREDIT_SEP);
  const chore = row.reminder_id != null && row.reminder_id !== QUICK_TAP_ID;
  return alone && chore && isBonusPerson(who) && row.done_at > POPPY_BONUS.from && row.done_at <= POPPY_BONUS.until
    ? POPPY_BONUS.multiplier : 1;
}

// The boards' one line about it, or null for a week (since, until] it does
// not touch: "🐾 Poppy bonus: chores @Dodgerblueee does alone count ×2 through
// Wed, Jun 30, 2027", in the past tense once it has ended (a Last week tab still shows
// it). Bold in Telegram's HTML, plain for the Mini App.
export function bonusLine(since, until, tz, { html = true, now = Date.now() } = {}) {
  if (!(POPPY_BONUS.from < until && POPPY_BONUS.until > since)) return null;
  const last = new Date(POPPY_BONUS.until - 1)
    .toLocaleDateString('en-US', { timeZone: tz, weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });
  const name = html ? `<b>${POPPY_BONUS.name}</b>` : POPPY_BONUS.name;
  const verb = now >= POPPY_BONUS.until ? 'counted' : 'count';
  return `🐾 ${name}: chores ${POPPY_BONUS.who} does alone ${verb} ×${POPPY_BONUS.multiplier} through ${last}`;
}
