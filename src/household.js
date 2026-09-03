// Who is in this household: chat settings, member tracking, display names,
// and the combined-credit format the roster and leaderboard share.

export async function getTz(env, chatId) {
  const row = await env.DB.prepare('SELECT tz FROM settings WHERE chat_id = ?').bind(chatId).first();
  return row ? row.tz : 'Asia/Singapore';
}

export function senderName(from) {
  return from.username ? `@${from.username}` : from.first_name || 'someone';
}

// /chore and /remind differ only in whether they score. Done together stays on
// both: it records who actually did the thing, which matters even when no
// points ride on it — dropping it once cost a reminder its shared credit.
export const isScored = (row) => (row && row.scored != null ? Boolean(row.scored) : true);

// Combined credits join names with this separator, in firings.done_by.
export const CREDIT_SEP = ' & ';

// Everyone the cats have actually seen in this chat, spelled exactly the way
// senderName spells them. Built from `members` — which rememberMember keeps
// fresh on every update, bots excluded — and not from past credits: a mistyped
// "done with brian" used to mint a permanent phantom housemate who then drew
// rotations and rode along on every later shared credit.
export async function householdRoster(env, chatId) {
  const { results } = await env.DB.prepare(
    'SELECT username, first_name FROM members WHERE chat_id = ?'
  ).bind(chatId).all();
  const set = new Set();
  for (const r of results || []) {
    const name = String(r.username ? `@${r.username}` : (r.first_name || '')).trim();
    if (name) set.add(name);
  }
  return set;
}

// "jane" typed by hand matches the roster's "@jane" spelling.
export function canonName(roster, name) {
  const norm = (s) => String(s).replace(/^@/, '').toLowerCase();
  for (const r of roster) if (norm(r) === norm(name)) return r;
  return name;
}

// Combined credit: the actor first, then the given others, deduped.
export function creditTogether(by, others) {
  const seen = new Set([by]);
  for (const o of others) seen.add(o);
  return [...seen].join(CREDIT_SEP);
}

// Group members the bot has seen; source of DM routing for assigned nags.
export async function rememberMember(env, chatId, from) {
  await env.DB.prepare(
    `INSERT INTO members (chat_id, user_id, username, first_name, last_seen) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(chat_id, user_id) DO UPDATE SET username = excluded.username,
       first_name = excluded.first_name, last_seen = excluded.last_seen`
  ).bind(chatId, from.id, from.username || null, from.first_name || null, Date.now()).run();
}

export async function isMember(env, userId) {
  const row = await env.DB.prepare('SELECT 1 AS x FROM members WHERE user_id = ?').bind(userId).first();
  return Boolean(row);
}
