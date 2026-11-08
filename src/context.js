// What nearly every piece of work in a chat reads before it can say anything —
// the timezone, the sticker pack and which cat is on each sticker — cached per
// isolate, and refreshed by riding in the first batch an entry point sends
// anyway (the webhook's intake, the Mini App's gate) when the copy is stale.
// A read that would have been a round trip of its own, often in front of a
// card edit or a typed command's reply, then costs nothing.

import { tzReads } from './household.js';
import { stickerReads } from './stickers.js';

export function chatReads(env, chatId) {
  const parts = [tzReads(env, chatId), stickerReads(env, chatId)];
  return {
    statements: parts.flatMap((p) => p.statements),
    // The answers to `statements`, in order. Never throws: a cache that was
    // not primed is simply read again when it is needed.
    prime(results) {
      try {
        let at = 0;
        for (const p of parts) {
          p.prime(results.slice(at, at + p.statements.length));
          at += p.statements.length;
        }
      } catch (e) {
        console.log(`priming the chat's cached reads failed: ${e}`);
      }
    },
  };
}
