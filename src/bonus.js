// The Poppy bonus: a temporary score multiplier for one person. Chores they
// finish inside the window count double on the leaderboard, the streak and the
// Sunday recap; the 6-month log and the rotation's fairness count stay plain.
// Delete this file's use (or let the window lapse) to end it.

export const POPPY_BONUS = {
  name: 'Poppy bonus',
  who: '@Dodgerblueee', // roster spelling, compared case-insensitively
  multiplier: 2,
  from: Date.parse('2026-11-15T19:45:00+08:00'),
  until: Date.parse('2026-11-23T00:00:00+08:00'), // Monday's reset after next
};

const isBonusPerson = (who) => String(who || '').toLowerCase() === POPPY_BONUS.who.toLowerCase();

// Points one person earns for one done chore.
export function pointsFor(who, doneAt) {
  return isBonusPerson(who) && doneAt > POPPY_BONUS.from && doneAt <= POPPY_BONUS.until
    ? POPPY_BONUS.multiplier : 1;
}

// Whether the bonus touches any of (since, until]: the boards show its banner.
export const bonusLive = (since, until) => POPPY_BONUS.from < until && POPPY_BONUS.until > since;

// The boards' one-line explanation, for any view the window overlaps.
export const bonusBanner = (tz) => `🐾 <b>${POPPY_BONUS.name}</b>: ${POPPY_BONUS.who}'s chores count ×${POPPY_BONUS.multiplier} until ${
  new Date(POPPY_BONUS.until - 1).toLocaleDateString('en-US', { timeZone: tz, weekday: 'short', month: 'short', day: 'numeric' })}`;

export { isBonusPerson };
