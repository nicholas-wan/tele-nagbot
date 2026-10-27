// Who is behind a Mini App request (the same check squashbot makes). Telegram
// signs the launch data it hands
// the page with a key only it and this bot know, so a valid signature is proof
// of the user it names — the page itself, and anything it sends, is not.
// https://core.telegram.org/bots/webapps#validating-data-received-via-the-mini-app

// A sheet left open overnight still works the next morning; one launched last
// week does not.
export const INIT_DATA_MAX_AGE_MS = 24 * 60 * 60 * 1000;

const encoder = new TextEncoder();

async function hmac(key, message) {
  const imported = await crypto.subtle.importKey(
    'raw', typeof key === 'string' ? encoder.encode(key) : key,
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
  );
  return new Uint8Array(await crypto.subtle.sign('HMAC', imported, encoder.encode(message)));
}

const hex = (bytes) => [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');

// Both sides are hex of a fixed length, so comparing every character, rather
// than stopping at the first mismatch, leaves timing nothing to say.
function sameHex(a, b) {
  if (a.length !== b.length) return false;
  let difference = 0;
  for (let index = 0; index < a.length; index += 1) {
    difference |= a.charCodeAt(index) ^ b.charCodeAt(index);
  }
  return difference === 0;
}

// The data-check-string is every field except hash, sorted by key, one
// key=value per line. Exported for the tests, which sign their own fixtures.
export async function signInitData(botToken, fields) {
  const check = Object.keys(fields).filter((key) => key !== 'hash').sort()
    .map((key) => `${key}=${fields[key]}`).join('\n');
  const secret = await hmac('WebAppData', botToken.trim());
  return hex(await hmac(secret, check));
}

// Returns { user, startParam } for launch data Telegram signed within the last
// day, and null for anything else: unsigned, tampered, stale, or missing the
// user it is supposed to vouch for.
export async function verifyInitData(env, raw, now = Date.now()) {
  if (!env.BOT_TOKEN || !raw) return null;
  const params = new URLSearchParams(raw);
  const hash = params.get('hash');
  if (!hash) return null;
  const fields = Object.fromEntries(params);
  if (!sameHex(await signInitData(env.BOT_TOKEN, fields), hash.toLowerCase())) return null;
  const authDate = Number(fields.auth_date) * 1000;
  if (!authDate || now - authDate > INIT_DATA_MAX_AGE_MS) return null;
  let user;
  try {
    user = JSON.parse(fields.user || 'null');
  } catch {
    return null;
  }
  if (!user || !user.id) return null;
  return { user, startParam: fields.start_param || '' };
}
