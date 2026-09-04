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
  return (await householdNames(env, chatId)).roster;
}

// The spelling of a name with nothing that distinguishes one from another:
// case and a leading '@' are how people type, not who they are.
const norm = (s) => String(s).replace(/^@/, '').trim().toLowerCase();

const displayName = (r) => String(r.username ? `@${r.username}` : (r.first_name || '')).trim();

// The roster plus every other spelling its members answer to. Someone the
// roster spells "@janedoe" is still "Jane" to whoever types "done with Jane",
// so her first name maps to her canonical spelling. A first name two members
// share maps to nobody: crediting a coin-flip housemate is worse than saying
// the name wasn't recognised.
export async function householdNames(env, chatId) {
  const { results } = await env.DB.prepare(
    'SELECT username, first_name FROM members WHERE chat_id = ?'
  ).bind(chatId).all();
  const roster = new Set();
  const aliases = new Map();
  const shared = new Set();
  for (const r of results || []) {
    const name = displayName(r);
    if (!name) continue;
    roster.add(name);
    const first = norm(r.first_name || '');
    if (!first || first === norm(name)) continue;
    if (aliases.has(first) && aliases.get(first) !== name) shared.add(first);
    aliases.set(first, name);
  }
  // An ambiguous alias resolves to nobody rather than to whoever was read last.
  for (const key of shared) aliases.delete(key);
  return { roster, aliases };
}

// "jane" typed by hand matches the roster's "@jane" spelling; given the alias
// map from householdNames it also matches "@janedoe", whose first name is Jane.
// A name nobody answers to comes back unchanged, so callers can tell the
// difference with roster.has().
export function canonName(roster, name, aliases = null) {
  for (const r of roster) if (norm(r) === norm(name)) return r;
  const alias = aliases && aliases.get(norm(name));
  return alias || name;
}

// Combined credit: the actor first, then the given others, deduped.
export function creditTogether(by, others) {
  const seen = new Set([by]);
  for (const o of others) seen.add(o);
  return [...seen].join(CREDIT_SEP);
}

// Group members the bot has seen. Their ids are what an ephemeral (in-group
// private) nag is addressed to, and their names are the household roster.
export async function rememberMember(env, chatId, from) {
  await env.DB.prepare(
    `INSERT INTO members (chat_id, user_id, username, first_name, last_seen) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(chat_id, user_id) DO UPDATE SET username = excluded.username,
       first_name = excluded.first_name, last_seen = excluded.last_seen`
  ).bind(chatId, from.id, from.username || null, from.first_name || null, Date.now()).run();
}

// Someone who left the chat is not in the household any more. Nothing used to
// remove them, so a departed housemate kept drawing rotations and riding along
// on every "done together" forever.
export async function forgetMember(env, chatId, userId) {
  await env.DB.prepare('DELETE FROM members WHERE chat_id = ? AND user_id = ?')
    .bind(chatId, userId).run();
}

export async function isMember(env, userId) {
  const row = await env.DB.prepare('SELECT 1 AS x FROM members WHERE user_id = ?').bind(userId).first();
  return Boolean(row);
}
