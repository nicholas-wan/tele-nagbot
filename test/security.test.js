import { describe, it, expect } from 'vitest';
import worker from '../src/index.js';
import { handleUpdate } from '../src/handlers.js';

describe('access controls', () => {
  it('fails closed when ALLOWED_CHATS is missing', async () => {
    const update = {
      message: { chat: { id: 123 }, from: { id: 1, first_name: 'Test' }, text: '/help' },
    };
    await expect(handleUpdate({}, update)).resolves.toBeUndefined();
  });

  it('rejects the old query-string setup authentication', async () => {
    const request = new Request('https://example.test/setup?key=old-secret');
    const response = await worker.fetch(request, {}, { waitUntil() {} });
    expect(response.status).toBe(405);
  });

  it('requires ADMIN_SECRET as a bearer token', async () => {
    const request = new Request('https://example.test/setup', { method: 'POST' });
    const response = await worker.fetch(request, { ADMIN_SECRET: 'admin-secret' }, { waitUntil() {} });
    expect(response.status).toBe(403);
  });

  it('accepts a matching admin bearer token', async () => {
    const request = new Request('https://example.test/setup', {
      method: 'POST', headers: { Authorization: 'Bearer admin-secret' },
    });
    const response = await worker.fetch(request, { ADMIN_SECRET: 'admin-secret' }, { waitUntil() {} });
    expect(response.status).toBe(500);
    expect(await response.text()).toMatch(/BOT_TOKEN/);
  });
});
