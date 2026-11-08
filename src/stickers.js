// Latte & Mocha sticker set: created once via /makestickers, then a random
// sticker accompanies nags. file_ids are cached per isolate.

import { tg, recordSentMessage, RECEIPT_TTL_MS } from './tg.js';

let cachedUsername = null;
const fileIdCache = new Map(); // set name -> [file_id]

async function botUsername(env) {
  if (!cachedUsername) {
    const me = await tg(env, 'getMe', {});
    if (me.ok) cachedUsername = me.result.username;
  }
  return cachedUsername;
}

export async function stickerSetName(env) {
  const username = await botUsername(env);
  return username ? `lattemocha_by_${username}` : null;
}

function b64ToBytes(b64) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

// Creates the set owned by userId (the person who ran /makestickers).
export async function createStickerSet(env, userId) {
  // The pack's images are a large module that only /makestickers needs, so it
  // is loaded here rather than with every isolate.
  const { STICKERS } = await import('./stickers-data.js');
  const name = await stickerSetName(env);
  if (!name) return { ok: false, description: 'could not resolve bot username' };

  // Set already exists: sync any newly embedded stickers into it.
  const existing = await tg(env, 'getStickerSet', { name });
  if (existing.ok) {
    const have = existing.result.stickers.length;
    let added = 0;
    for (let i = have; i < STICKERS.length; i++) {
      const s = STICKERS[i];
      const form = new FormData();
      form.append('user_id', String(userId));
      form.append('name', name);
      form.append('sticker', JSON.stringify({
        sticker: 'attach://file', format: 'static', emoji_list: [s.emoji],
      }));
      form.append('file', new Blob([b64ToBytes(s.b64)], { type: 'image/webp' }), 'file.webp');
      const res = await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN.trim()}/addStickerToSet`, {
        method: 'POST',
        body: form,
      });
      const data = await res.json();
      if (!data.ok) {
        console.log(`addStickerToSet failed: ${JSON.stringify(data)}`);
        return { ...data, name, added };
      }
      added++;
    }
    fileIdCache.delete(name); // refresh the random-pick cache
    return { ok: true, name, already: true, added };
  }

  const form = new FormData();
  form.append('user_id', String(userId));
  form.append('name', name);
  form.append('title', 'Latte & Mocha');
  form.append('sticker_format', 'static');
  form.append('stickers', JSON.stringify(
    STICKERS.map((s, i) => ({
      sticker: `attach://s${i}`,
      format: 'static',
      emoji_list: [s.emoji],
    }))
  ));
  STICKERS.forEach((s, i) => {
    form.append(`s${i}`, new Blob([b64ToBytes(s.b64)], { type: 'image/webp' }), `s${i}.webp`);
  });

  const res = await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN.trim()}/createNewStickerSet`, {
    method: 'POST',
    body: form,
  });
  const data = await res.json();
  if (!data.ok) console.log(`createNewStickerSet failed: ${JSON.stringify(data)}`);
  return data.ok ? { ok: true, name } : data;
}

// Wholesome stickers preferred for the "done" celebration (heart-eyes,
// tongue-out, cozy nap, snuggle). Falls back to any sticker in the pack.
const CELEBRATION_UIDS = new Set(['AgADxB8AAhaJwFc', 'AgADlh0AAqbNwVc', 'AgADIB4AA1nBVw', 'AgADQB4AAqSUwVc']);

// The celebration sticker for a Done, and which cat is on it, chosen without
// sending it: the receipt names the cat ("Latte purrs approvingly"), and once
// the choice is known the receipt and the sticker can go out together rather
// than one after the other. Null when there is no pack. Never throws.
export async function pickCelebration(env, chatId, seed) {
  try {
    const name = await activeSetName(env, chatId);
    if (!name) return null;
    const stickers = await setStickers(env, name);
    if (!stickers) return null;
    const fav = stickers.filter((s) => CELEBRATION_UIDS.has(s.uid));
    const pool = fav.length ? fav : stickers;
    const pick = pool[Math.abs(seed) % pool.length];
    return { ...pick, cat: await stickerCat(env, pick.uid) };
  } catch (e) {
    console.log(`pickCelebration failed: ${e}`);
    return null;
  }
}

// Celebration stickers are pure décor — a couple of hours is plenty.
export async function sendCelebration(env, chatId, pick) {
  try {
    await recordSentMessage(env, chatId, await tg(env, 'sendSticker', { chat_id: chatId, sticker: pick.id, disable_notification: true }),
      { ttlMs: RECEIPT_TTL_MS });
  } catch (e) {
    console.log(`sendCelebration failed: ${e}`);
  }
}

// Deletes the 1-based Nth sticker from the chat's ACTIVE pack (so positions
// match /tags). Telegram only allows this for packs the bot created.
export async function deleteSticker(env, chatId, index) {
  const name = await activeSetName(env, chatId);
  if (!name) return { ok: false, description: 'no active sticker pack' };
  const set = await tg(env, 'getStickerSet', { name });
  if (!set.ok) return set;
  const stickers = set.result.stickers;
  if (index < 1 || index > stickers.length) {
    return { ok: false, description: `the pack has ${stickers.length} stickers — pick 1 to ${stickers.length}` };
  }
  const res = await tg(env, 'deleteStickerFromSet', { sticker: stickers[index - 1].file_id });
  if (res.ok) fileIdCache.delete(name);
  return { ...res, remaining: stickers.length - 1 };
}

// The chat's pack and each sticker's cat change only through the sticker
// commands, yet every nag and every Done read them — so each isolate keeps
// them for a while, keyed by the database binding like the tz. A command in
// this isolate forgets what it changes at once; another isolate's copy is at
// most ten minutes stale, and all it can get wrong is which cat purrs.
const STICKER_TTL_MS = 10 * 60000;
const packCache = new WeakMap(); // DB -> chat id -> { name, at }
const catCache = new WeakMap(); // DB -> file uid -> { cat, at }

function cacheFor(store, env) {
  let map = store.get(env.DB);
  if (!map) store.set(env.DB, map = new Map());
  return map;
}

function fresh(map, key) {
  const hit = map.get(key);
  return hit && Date.now() - hit.at < STICKER_TTL_MS ? hit : null;
}

// For /usepack, which changes a chat's pack, and for the tagging commands.
export function forgetPack(env, chatId) {
  if (env.DB) cacheFor(packCache, env).delete(chatId);
}
function forgetCat(env, uid) {
  if (env.DB) cacheFor(catCache, env).delete(uid);
}

// Which cat is on a sticker, by its stable id; 'both' when untagged.
async function stickerCat(env, uid) {
  const cache = cacheFor(catCache, env);
  const hit = fresh(cache, uid);
  if (hit) return hit.cat;
  const tag = await env.DB.prepare('SELECT cat FROM sticker_tags WHERE file_uid = ?').bind(uid).first();
  const cat = (tag && tag.cat) || 'both';
  cache.set(uid, { cat, at: Date.now() });
  return cat;
}

// Sends a random Latte & Mocha sticker; silently does nothing if the set
// hasn't been created yet. Never throws.
async function activeSetName(env, chatId) {
  const cache = cacheFor(packCache, env);
  const hit = fresh(cache, chatId);
  if (hit) return hit.name;
  const row = await env.DB.prepare('SELECT sticker_set FROM settings WHERE chat_id = ?')
    .bind(chatId).first();
  const name = (row && row.sticker_set) || await stickerSetName(env);
  if (name) cache.set(chatId, { name, at: Date.now() });
  return name;
}

async function setStickers(env, name) {
  if (!fileIdCache.has(name)) {
    const set = await tg(env, 'getStickerSet', { name });
    if (!set.ok || !set.result.stickers.length) return null;
    fileIdCache.set(name, set.result.stickers.map((s) => ({ id: s.file_id, uid: s.file_unique_id })));
  }
  return fileIdCache.get(name);
}

// Auto-tags untagged stickers in the chat's active pack using a vision
// model. Processes up to 10 per run so a webhook invocation stays within
// its time budget; re-running continues where it left off.
export async function autoTagPack(env, chatId, { redo } = {}) {
  const name = await activeSetName(env, chatId);
  if (!name) return { ok: false, description: 'no active sticker pack' };
  fileIdCache.delete(name); // pick up pack edits
  const set = await tg(env, 'getStickerSet', { name });
  if (!set.ok) return { ok: false, description: 'could not load the active pack' };

  const stickers = set.result.stickers;
  if (redo && stickers.length) {
    await env.DB.batch(stickers.map((s) =>
      env.DB.prepare('DELETE FROM sticker_tags WHERE file_uid = ?').bind(s.file_unique_id)));
    for (const s of stickers) forgetCat(env, s.file_unique_id);
  }

  // Every tag the pack already has, in one read; then the untagged ones are
  // classified a few at a time (each is a file download and a vision model
  // call), and their tags written in one batch.
  const tagged = await tagsFor(env, stickers.map((s) => s.file_unique_id));
  const counts = { latte: 0, mocha: 0, both: 0, skipped: 0 };
  const todo = [];
  let remaining = 0;
  for (const s of stickers) {
    if (tagged.has(s.file_unique_id)) continue;
    if (s.is_animated || s.is_video) { counts.skipped++; continue; }
    if (todo.length >= 10) { remaining++; continue; }
    todo.push(s);
  }
  const found = [];
  for (let i = 0; i < todo.length; i += CLASSIFY_PARALLEL) {
    const group = todo.slice(i, i + CLASSIFY_PARALLEL);
    const cats = await Promise.all(group.map((s) => classifySticker(env, s.file_id)));
    group.forEach((s, j) => {
      if (!cats[j]) { counts.skipped++; return; }
      counts[cats[j]]++;
      found.push([s.file_unique_id, cats[j]]);
    });
  }
  if (found.length) {
    await env.DB.batch(found.map(([uid, cat]) =>
      env.DB.prepare('INSERT OR REPLACE INTO sticker_tags (file_uid, cat) VALUES (?, ?)').bind(uid, cat)));
    for (const [uid] of found) forgetCat(env, uid);
  }
  return { ok: true, counts, processed: todo.length, remaining };
}

// How many stickers /autotag classifies at once.
const CLASSIFY_PARALLEL = 4;

// The tags of the given stickers, one read: uid → cat.
async function tagsFor(env, uids) {
  if (!uids.length) return new Map();
  const { results } = await env.DB.prepare(
    `SELECT file_uid, cat FROM sticker_tags WHERE file_uid IN (${uids.map(() => '?').join(',')})`
  ).bind(...uids).all();
  return new Map((results || []).map((r) => [r.file_uid, r.cat]));
}

const CLASSIFY_PROMPT =
  'Look at this image of one or more cats. Choose exactly one option:\n' +
  'A = exactly one cat, and it has white fur with orange/black calico patches (a light-colored cat)\n' +
  'B = exactly one cat, and it is dark all over: brown/black mottled tortoiseshell fur with no white\n' +
  'C = two or more cats\n' +
  'Reply with only the single letter A, B, or C.';

function parseVerdict(answer) {
  const a = answer.toLowerCase();
  const letter = answer.match(/\b([abc])\b/i);
  if (letter) return { a: 'latte', b: 'mocha', c: 'both' }[letter[1].toLowerCase()];
  // Fallback: infer from a descriptive answer.
  if (/\btwo cats|both cats|2 cats\b/.test(a)) return 'both';
  if (/\bwhite|calico|light\b/.test(a)) return 'latte';
  if (/\btortoiseshell|tortie|dark|black|brown\b/.test(a)) return 'mocha';
  return null;
}

async function classifySticker(env, fileId) {
  try {
    const f = await tg(env, 'getFile', { file_id: fileId });
    if (!f.ok) return null;
    const res = await fetch(`https://api.telegram.org/file/bot${env.BOT_TOKEN.trim()}/${f.result.file_path}`);
    if (!res.ok) return null;
    const image = Array.from(new Uint8Array(await res.arrayBuffer()));
    // Llama 3.2 Vision first; LLaVA as fallback if the model is unavailable.
    for (const model of ['@cf/meta/llama-3.2-11b-vision-instruct', '@cf/llava-hf/llava-1.5-7b-hf']) {
      try {
        const ai = await env.AI.run(model, { image, prompt: CLASSIFY_PROMPT, max_tokens: 10 });
        const verdict = parseVerdict(String(ai.response || ai.description || ''));
        if (verdict) return verdict;
      } catch (e) {
        console.log(`${model} failed: ${e}`);
      }
    }
    return null;
  } catch (e) {
    console.log(`classifySticker failed: ${e}`);
    return null;
  }
}

// Lists tag status for every sticker in the chat's active pack, in pack order.
export async function listTags(env, chatId) {
  const name = await activeSetName(env, chatId);
  if (!name) return { ok: false, description: 'no active sticker pack' };
  fileIdCache.delete(name);
  const stickers = await setStickers(env, name);
  if (!stickers) return { ok: false, description: 'could not load the active pack' };
  const tags = await tagsFor(env, stickers.map((s) => s.uid));
  const entries = stickers.map((s, i) => ({ pos: i + 1, cat: tags.get(s.uid) ?? null, fileId: s.id, uid: s.uid }));
  return { ok: true, name, entries };
}
// Returns which cat is on the sent sticker plus its message id so it can be
// cleaned up on re-nag/completion. Never throws.
export async function sendRandomSticker(env, chatId, seed) {
  try {
    const name = await activeSetName(env, chatId);
    if (!name) return { cat: 'both', messageId: null };
    const stickers = await setStickers(env, name);
    if (!stickers) return { cat: 'both', messageId: null };
    const pick = stickers[Math.abs(seed) % stickers.length];
    // The nag lifecycle usually deletes this itself; the sweep is the backstop
    // for any path that loses track of it. Deleting twice is harmless.
    const [sent, cat] = await Promise.all([
      tg(env, 'sendSticker', { chat_id: chatId, sticker: pick.id, disable_notification: true })
        .then((res) => recordSentMessage(env, chatId, res)),
      stickerCat(env, pick.uid),
    ]);
    return { cat, messageId: sent.ok ? sent.result.message_id : null };
  } catch (e) {
    console.log(`sendRandomSticker failed: ${e}`);
    return { cat: 'both', messageId: null };
  }
}

// Records which cat is on the 1-based Nth sticker of the chat's active pack.
export async function tagSticker(env, chatId, index, cat) {
  const name = await activeSetName(env, chatId);
  if (!name) return { ok: false, description: 'no active sticker pack' };
  fileIdCache.delete(name); // pick up pack edits before resolving positions
  const stickers = await setStickers(env, name);
  if (!stickers) return { ok: false, description: 'could not load the active pack' };
  if (index < 1 || index > stickers.length) {
    return { ok: false, description: `the pack has ${stickers.length} stickers — pick 1 to ${stickers.length}` };
  }
  await env.DB.prepare('INSERT OR REPLACE INTO sticker_tags (file_uid, cat) VALUES (?, ?)')
    .bind(stickers[index - 1].uid, cat).run();
  forgetCat(env, stickers[index - 1].uid);
  return { ok: true };
}

// Validates a pack name (or t.me/addstickers/ link) and returns its set info.
export async function lookupPack(env, raw) {
  const name = raw.replace(/^https?:\/\/t\.me\/addstickers\//i, '').trim();
  if (!name || /[^A-Za-z0-9_]/.test(name)) return { ok: false, name };
  const set = await tg(env, 'getStickerSet', { name });
  return set.ok ? { ok: true, name, title: set.result.title, count: set.result.stickers.length } : { ok: false, name };
}
