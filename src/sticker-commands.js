// One-time sticker setup and tag maintenance commands. The runtime sticker
// behavior (random nag stickers, celebration picks) lives in stickers.js.

import { tg, sendPrivate, esc, recordSentMessage } from './tg.js';
import { ParseError } from './parse.js';
import { createStickerSet, deleteSticker, lookupPack, tagSticker, autoTagPack, listTags } from './stickers.js';

export async function cmdMakeStickers(env, ctx, msg) {
  const res = await createStickerSet(env, msg.from.id);
  if (res.ok) {
    const link = `https://t.me/addstickers/${res.name}`;
    await sendPrivate(env, ctx, res.already
      ? (res.added
          ? `🐾 Added ${res.added} new sticker${res.added > 1 ? 's' : ''} to <a href="${link}">Latte &amp; Mocha</a>.`
          : `🐾 The pack already exists and is up to date: <a href="${link}">Latte &amp; Mocha</a>`)
      : `🎉 Sticker pack created: <a href="${link}">Latte &amp; Mocha</a>\n` +
        'Random cat stickers now accompany every nag. Tap the link to add them to your own sticker keyboard too!');
  } else {
    await sendPrivate(env, ctx, `😿 Telegram refused: ${esc(res.description || 'unknown error')}`);
  }
}

export async function cmdDelSticker(env, ctx, args) {
  const index = parseInt(args, 10);
  if (!index) throw new ParseError('Which one? e.g. /delsticker 3 (position in the pack, per /tags).');
  const res = await deleteSticker(env, ctx.chatId, index);
  if (res.ok) {
    await sendPrivate(env, ctx, `🗑️ Sticker ${index} removed — ${res.remaining} left in the pack.`);
  } else {
    await sendPrivate(env, ctx,
      `😿 ${esc(res.description || 'Telegram refused.')}\n` +
      'Note: only packs created by this bot can be edited here — packs made via @Stickers are edited there.');
  }
}

export async function cmdTagSticker(env, ctx, args) {
  const m = args.trim().match(/^#?(\d+)\s+(latte|mocha|both)$/i);
  if (!m) throw new ParseError('Usage: /tagsticker 3 latte (or mocha, or both) — position in the active pack.');
  const res = await tagSticker(env, ctx.chatId, +m[1], m[2].toLowerCase());
  if (!res.ok) return sendPrivate(env, ctx, `😿 ${esc(res.description)}`);
  const label = m[2].toLowerCase() === 'both' ? 'Latte &amp; Mocha' : m[2][0].toUpperCase() + m[2].slice(1).toLowerCase();
  await sendPrivate(env, ctx, `🏷️ Sticker ${+m[1]} is ${label}. The nag lines will match.`);
}

export async function cmdAutoTag(env, ctx, args = '') {
  const redo = /\bredo\b/i.test(args);
  await sendPrivate(env, ctx, redo
    ? '🔎 Wiping old tags — the cats are re-inspecting the pack…'
    : '🔎 The cats are inspecting the sticker pack…');
  const res = await autoTagPack(env, ctx.chatId, { redo });
  if (!res.ok) return sendPrivate(env, ctx, `😿 ${esc(res.description)}`);
  const c = res.counts;
  if (!res.processed && !c.skipped) {
    return sendPrivate(env, ctx, '🏷️ Everything in the pack is already tagged.');
  }
  let msg = `🤖 Tagged ${res.processed} sticker${res.processed === 1 ? '' : 's'}: ` +
    `${c.latte} Latte, ${c.mocha} Mocha, ${c.both} both` +
    (c.skipped ? `, ${c.skipped} skipped` : '') + '.';
  if (res.remaining) msg += `\n${res.remaining} to go — run /autotag again.`;
  msg += '\nFix any misses with /tagsticker N latte (position in the pack).';
  await sendPrivate(env, ctx, msg);
}

const CAT_LABEL = { latte: 'Latte 🥛', mocha: 'Mocha 🍫', both: 'Latte &amp; Mocha 🐈🐈' };

export async function cmdTags(env, ctx, args) {
  const chatId = ctx.chatId;
  const res = await listTags(env, chatId);
  if (!res.ok) return sendPrivate(env, ctx, `😿 ${esc(res.description)}`);
  const n = parseInt(args, 10);
  if (n) {
    const e = res.entries.find((x) => x.pos === n);
    if (!e) throw new ParseError(`The pack has ${res.entries.length} stickers — pick 1 to ${res.entries.length}.`);
    // A sticker cannot be sent ephemerally with a caption attached, so the
    // preview itself is public; the label that follows is not.
    await recordSentMessage(env, chatId, await tg(env, 'sendSticker', { chat_id: chatId, sticker: e.fileId }));
    return sendPrivate(env, ctx,
      `☝️ Sticker ${n}: ${e.cat ? CAT_LABEL[e.cat] : 'untagged'} — change with /tagsticker ${n} latte|mocha|both`);
  }
  const lines = res.entries.map((e) => `${e.pos}. ${e.cat ? CAT_LABEL[e.cat] : '—'}`);
  await sendPrivate(env, ctx,
    `🏷️ <b>${esc(res.name)}</b> (order as shown in the pack)\n${lines.join('\n')}\n` +
    'Peek at one with /tags N · fix with /tagsticker N latte');
}

export async function cmdUsePack(env, ctx, args) {
  const chatId = ctx.chatId;
  const raw = args.trim();
  if (!raw) {
    const row = await env.DB.prepare('SELECT sticker_set FROM settings WHERE chat_id = ?').bind(chatId).first();
    return sendPrivate(env, ctx,
      `Current nag stickers: <code>${esc((row && row.sticker_set) || 'Latte & Mocha (default)')}</code>\n` +
      'Switch with /usepack &lt;pack link or name&gt; — get the link by tapping any sticker → the pack name → share.\n' +
      'Back to the cats: /usepack reset');
  }
  if (raw.toLowerCase() === 'reset') {
    await env.DB.prepare(
      'INSERT INTO settings (chat_id, sticker_set) VALUES (?, NULL) ON CONFLICT(chat_id) DO UPDATE SET sticker_set = NULL'
    ).bind(chatId).run();
    return sendPrivate(env, ctx, '🐾 Back to the Latte &amp; Mocha pack.');
  }
  const pack = await lookupPack(env, raw);
  if (!pack.ok) {
    throw new ParseError(`Couldn't find a sticker pack called "${pack.name || raw}". Paste the t.me/addstickers/... link.`);
  }
  await env.DB.prepare(
    'INSERT INTO settings (chat_id, sticker_set) VALUES (?, ?) ON CONFLICT(chat_id) DO UPDATE SET sticker_set = excluded.sticker_set'
  ).bind(chatId, pack.name).run();
  await sendPrivate(env, ctx,
    `🐾 Nag stickers switched to <b>${esc(pack.title)}</b> (${pack.count} stickers).`);
}
