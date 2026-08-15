// Latte & Mocha sticker set: created once via /makestickers, then a random
// sticker accompanies nags. file_ids are cached per isolate.

import { tg, recordSentMessage, RECEIPT_TTL_MS } from './tg.js';
import { STICKERS } from './stickers-data.js';

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

export async function sendCelebrationSticker(env, chatId, seed) {
  try {
    const name = await activeSetName(env, chatId);
    if (!name) return { cat: 'both' };
    const stickers = await setStickers(env, name);
    if (!stickers) return { cat: 'both' };
    const fav = stickers.filter((s) => CELEBRATION_UIDS.has(s.uid));
    const pool = fav.length ? fav : stickers;
    const pick = pool[Math.abs(seed) % pool.length];
    // Celebration stickers are pure décor — a couple of hours is plenty.
    await recordSentMessage(env, chatId, await tg(env, 'sendSticker', { chat_id: chatId, sticker: pick.id }),
      { ttlMs: RECEIPT_TTL_MS });
    const tag = await env.DB.prepare('SELECT cat FROM sticker_tags WHERE file_uid = ?')
      .bind(pick.uid).first();
    return { cat: (tag && tag.cat) || 'both' };
  } catch (e) {
    console.log(`sendCelebrationSticker failed: ${e}`);
    return { cat: 'both' };
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

// Sends a random Latte & Mocha sticker; silently does nothing if the set
// hasn't been created yet. Never throws.
async function activeSetName(env, chatId) {
  const row = await env.DB.prepare('SELECT sticker_set FROM settings WHERE chat_id = ?')
    .bind(chatId).first();
  return (row && row.sticker_set) || await stickerSetName(env);
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

  if (redo) {
    for (const s of set.result.stickers) {
      await env.DB.prepare('DELETE FROM sticker_tags WHERE file_uid = ?').bind(s.file_unique_id).run();
    }
  }

  const counts = { latte: 0, mocha: 0, both: 0, skipped: 0 };
  let processed = 0;
  let remaining = 0;
  for (const s of set.result.stickers) {
    const existing = await env.DB.prepare('SELECT cat FROM sticker_tags WHERE file_uid = ?')
      .bind(s.file_unique_id).first();
    if (existing) continue;
    if (s.is_animated || s.is_video) { counts.skipped++; continue; }
    if (processed >= 10) { remaining++; continue; }
    processed++;
    const cat = await classifySticker(env, s.file_id);
    if (!cat) { counts.skipped++; continue; }
    counts[cat]++;
    await env.DB.prepare('INSERT OR REPLACE INTO sticker_tags (file_uid, cat) VALUES (?, ?)')
      .bind(s.file_unique_id, cat).run();
  }
  return { ok: true, counts, processed, remaining };
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
  const entries = [];
  for (let i = 0; i < stickers.length; i++) {
    const tag = await env.DB.prepare('SELECT cat FROM sticker_tags WHERE file_uid = ?')
      .bind(stickers[i].uid).first();
    entries.push({ pos: i + 1, cat: tag ? tag.cat : null, fileId: stickers[i].id, uid: stickers[i].uid });
  }
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
    const sent = await tg(env, 'sendSticker', { chat_id: chatId, sticker: pick.id });
    // The nag lifecycle usually deletes this itself; the sweep is the backstop
    // for any path that loses track of it. Deleting twice is harmless.
    await recordSentMessage(env, chatId, sent);
    const tag = await env.DB.prepare('SELECT cat FROM sticker_tags WHERE file_uid = ?')
      .bind(pick.uid).first();
    return { cat: (tag && tag.cat) || 'both', messageId: sent.ok ? sent.result.message_id : null };
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
  return { ok: true };
}

// Validates a pack name (or t.me/addstickers/ link) and returns its set info.
export async function lookupPack(env, raw) {
  const name = raw.replace(/^https?:\/\/t\.me\/addstickers\//i, '').trim();
  if (!name || /[^A-Za-z0-9_]/.test(name)) return { ok: false, name };
  const set = await tg(env, 'getStickerSet', { name });
  return set.ok ? { ok: true, name, title: set.result.title, count: set.result.stickers.length } : { ok: false, name };
}
