// The Poppy bonus: a temporary score multiplier for one person. Chores they
// finish inside the window count double on the weekly boards, the streak and
// the Sunday recap; the 6-month log and the rotation's fairness count stay
// plain. It lapses on its own; delete this file's uses any time after.

export const POPPY_BONUS = {
  name: 'Poppy bonus',
  who: '@Dodgerblueee', // roster spelling, compared case-insensitively
  multiplier: 2,
  from: Date.parse('2026-11-15T19:45:00+08:00'), // when it went live; not back-dated
  until: Date.parse('2027-07-01T00:00:00+08:00'), // nine months on from 1 Oct 2026: Wed 30 Jun 2027 is its last day
};

const isBonusPerson = (who) => String(who || '').toLowerCase() === POPPY_BONUS.who.toLowerCase();

// Points one person earns for one done chore.
export function pointsFor(who, doneAt) {
  return isBonusPerson(who) && doneAt > POPPY_BONUS.from && doneAt <= POPPY_BONUS.until
    ? POPPY_BONUS.multiplier : 1;
}

// Whether the bonus touches any of (since, until]: the boards show its line.
export const bonusLive = (since, until) => POPPY_BONUS.from < until && POPPY_BONUS.until > since;

// "@Dodgerblueee's chores count ×2 until Wed, Jun 30, 2027", in the
// past tense once the window has closed (a Last week tab still shows it).
export function bonusText(tz, now = Date.now()) {
  const last = new Date(POPPY_BONUS.until - 1)
    .toLocaleDateString('en-US', { timeZone: tz, weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });
  const over = now >= POPPY_BONUS.until;
  return `${POPPY_BONUS.who}'s chores ${over ? 'counted' : 'count'} ×${POPPY_BONUS.multiplier} ${over ? 'through' : 'until'} ${last}`;
}

export const bonusBanner = (tz, now = Date.now()) => `🐾 <b>${POPPY_BONUS.name}</b>: ${bonusText(tz, now)}`;
