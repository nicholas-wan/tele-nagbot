import { afterEach, describe, expect, it, vi } from 'vitest';
import worker from '../src/index.js';

// The Bot API accepts one method call as the webhook's own HTTP response
// ("Making requests when getting updates"). The API is served from Amsterdam,
// which is also where Telegram's webhooks land this Worker, so the toast
// riding the response is the difference between an instant tap and one that
// pays a needless round trip.
describe('webhook answers', () => {
  afterEach(() => vi.unstubAllGlobals());

  const env = (extra = {}) => ({
    BOT_TOKEN: 'test-token',
    WEBHOOK_SECRET: 'hook-secret',
    ALLOWED_CHATS: '-123456789',
    DB: {
      prepare() {
        return { bind() { return {
          async first() { return null; },
          async all() { return { results: [] }; },
          async run() { return { meta: { changes: 0 } }; },
        }; } };
      },
    },
    ...extra,
  });
  const webhookRequest = (update) => new Request('https://worker.example/webhook', {
    method: 'POST',
    headers: { 'X-Telegram-Bot-Api-Secret-Token': 'hook-secret' },
    body: JSON.stringify(update),
  });

  it('sends the tap answer back on the webhook response itself', async () => {
    const requests = [];
    vi.stubGlobal('fetch', vi.fn(async (url, init) => {
      requests.push({ url: String(url), body: JSON.parse(init.body) });
      return new Response(JSON.stringify({ ok: true, result: {} }), {
        headers: { 'Content-Type': 'application/json' },
      });
    }));
    const tasks = [];
    // The ✅ OK dismiss is the simplest full path: delete the message, answer.
    const response = await worker.fetch(webhookRequest({
      callback_query: {
        id: 'callback-1', data: 'ok',
        from: { id: 7, first_name: 'Nick' },
        message: { message_id: 55, chat: { id: -123456789 } },
      },
    }), env(), { waitUntil: (task) => tasks.push(task) });
    expect(response.headers.get('Content-Type')).toBe('application/json');
    const body = JSON.parse(await response.text());
    expect(body.method).toBe('answerCallbackQuery');
    expect(body.callback_query_id).toBe('callback-1');
    await Promise.all(tasks);
    // The dismissal itself still travelled over HTTPS after the response...
    expect(requests.some((request) => request.url.endsWith('/deleteMessage'))).toBe(true);
    // ...but the answer did not: it rode the webhook response instead.
    expect(requests.some((request) => request.url.endsWith('/answerCallbackQuery')))
      .toBe(false);
  });

  it('answers a thrown handler with an apology instead of a spinner', async () => {
    const logged = [];
    vi.spyOn(console, 'log').mockImplementation((line) => logged.push(line));
    vi.stubGlobal('fetch', vi.fn(async () => new Response(
      JSON.stringify({ ok: true, result: {} }),
      { headers: { 'Content-Type': 'application/json' } }
    )));
    const tasks = [];
    // x:<id> reads the firing before anything else, so a dead DB throws early
    // and before any answer — the apology must still reach the tapper, and it
    // does so on the webhook response, the arm being still in place.
    const response = await worker.fetch(webhookRequest({
      callback_query: {
        id: 'callback-2', data: 'x:1',
        from: { id: 7, first_name: 'Nick' },
        message: { message_id: 55, chat: { id: -123456789 } },
      },
    }), env({ DB: { prepare() { throw new Error('D1 is down'); } } }),
    { waitUntil: (task) => tasks.push(task) });
    const body = JSON.parse(await response.text());
    expect(body.method).toBe('answerCallbackQuery');
    expect(body.text).toContain('Something went wrong');
    await Promise.all(tasks);
    expect(logged.join('\n')).toContain('update failed');
    vi.restoreAllMocks();
  });

  it('keeps answering message updates with a plain ok', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(
      JSON.stringify({ ok: true, result: { message_id: 1 } }),
      { headers: { 'Content-Type': 'application/json' } }
    )));
    const tasks = [];
    const response = await worker.fetch(webhookRequest({
      message: {
        message_id: 5,
        chat: { id: -123456789 },
        from: { id: 7, first_name: 'Nick' },
        text: '/help',
      },
    }), env(), { waitUntil: (task) => tasks.push(task) });
    expect(await response.text()).toBe('ok');
    await Promise.all(tasks);
  });

  it('releases the webhook promptly when a callback never answers', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(
      JSON.stringify({ ok: true, result: {} }),
      { headers: { 'Content-Type': 'application/json' } }
    )));
    const tasks = [];
    // A chat outside ALLOWED_CHATS is dropped without an answer; the response
    // must come from handling ending, not from the 2s timeout.
    const started = Date.now();
    const response = await worker.fetch(webhookRequest({
      callback_query: {
        id: 'callback-3', data: 'ok',
        from: { id: 7, first_name: 'Nick' },
        message: { message_id: 55, chat: { id: -999 } },
      },
    }), env(), { waitUntil: (task) => tasks.push(task) });
    expect(await response.text()).toBe('ok');
    expect(Date.now() - started).toBeLessThan(1500);
    await Promise.all(tasks);
  });
});
