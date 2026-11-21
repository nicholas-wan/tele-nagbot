// Private sends in the Bot API 10.3 shape, which moved receiver_user_id and
// callback_query_id into ephemeral_message_parameters. Edits and deletes of an
// ephemeral message keep receiver_user_id at the top level.
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { deleteEphemeral, editEphemeral, replyCtx, sendDocument, sendPrivate } from '../src/tg.js';

let bodies;
const env = { BOT_TOKEN: 'test' };

beforeEach(() => {
  bodies = [];
  vi.stubGlobal('fetch', vi.fn(async (url, init) => {
    bodies.push(init.body);
    return new Response(JSON.stringify({ ok: true, result: { message_id: 0, ephemeral_message_id: 7 } }));
  }));
});
afterEach(() => vi.unstubAllGlobals());

it('sends a private message with both ids inside the parameters', async () => {
  await sendPrivate(env, replyCtx(env, -1, 2, { callbackQueryId: 'tap-1' }), 'hello');
  const body = JSON.parse(bodies[0]);
  expect(body.ephemeral_message_parameters).toEqual({ receiver_user_id: 2, callback_query_id: 'tap-1' });
  expect(body).not.toHaveProperty('receiver_user_id');
  expect(body).not.toHaveProperty('callback_query_id');
  expect(body.chat_id).toBe(-1);
});

it('spends the tap id on one send only', async () => {
  const ctx = replyCtx(env, -1, 2, { callbackQueryId: 'tap-1' });
  await sendPrivate(env, ctx, 'first');
  await sendPrivate(env, ctx, 'second');
  expect(JSON.parse(bodies[1]).ephemeral_message_parameters).toEqual({ receiver_user_id: 2 });
});

it('sends a private file with the parameters as JSON', async () => {
  await sendDocument(env, replyCtx(env, -1, 2), 'a.ics', 'BEGIN:VCALENDAR');
  expect(JSON.parse(bodies[0].get('ephemeral_message_parameters'))).toEqual({ receiver_user_id: 2 });
  expect(bodies[0].get('receiver_user_id')).toBeNull();
});

it('keeps the receiver at the top level for edits and deletes', async () => {
  const ctx = replyCtx(env, -1, 2);
  await editEphemeral(env, ctx, 7, 'edited');
  await deleteEphemeral(env, ctx, 7);
  for (const raw of bodies) {
    const body = JSON.parse(raw);
    expect(body.receiver_user_id).toBe(2);
    expect(body).not.toHaveProperty('ephemeral_message_parameters');
  }
});
