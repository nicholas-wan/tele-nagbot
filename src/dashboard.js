// The pinned dashboard: the chore-list card shared by /list and the pin, and
// the schedule/emoji text helpers everything renders chores with.

import { sendMessage, editMessage, deleteMessage, esc, pinMessage, unpinMessage } from './tg.js';
import { fmtLocal, fmtShort, fmtClock, fmtTime, localParts, DAY_NAMES } from './time.js';
import { isScored } from './household.js';

export function dashboardButtons() {
  return { inline_keyboard: [[{ text: '⚙️ Manage chores', callback_data: 'm:list' }]] };
}

// Best-guess emoji for a chore, by keyword. Falls back to a paw.
const CHORE_EMOJI = [
  [/nails?|trim|groom/i, '✂️'],
  [/vaccin|nexgard|flea|tick|deworm|jab|injection/i, '💉'],
  [/fountain|aquarium|tank/i, '💧'],
  [/wifi|internet|router|broadband|modem|myrepublic/i, '🌐'],
  [/dish|plate|dishwasher|bowl|cutlery/i, '🍽️'],
  [/poop|litter|litterbox|scoop/i, '💩'],
  [/trash|garbage|rubbish|bin\b/i, '🗑️'],
  [/laundry|clothes|fold|iron/i, '🧺'],
  [/plant|water the|garden|flower/i, '🪴'],
  [/vacuum|sweep|mop|clean|dust|scrub|wipe/i, '🧹'],
  [/rent|pay|bill|tax|insurance/i, '💸'],
  [/cook|dinner|lunch|breakfast|meal|oven|bake/i, '🍳'],
  [/groceries|grocery|shop|buy|market/i, '🛒'],
  [/feed|food|treat/i, '🍚'],
  [/cat|latte|mocha|vet/i, '🐱'],
  [/car|gas|fuel|tire|oil/i, '🚗'],
  [/bed|sheet|pillow|blanket/i, '🛏️'],
  [/gym|run|walk|exercise/i, '🏃'],
  [/call|phone|email|message/i, '📞'],
  [/doctor|dentist|meds|medicine|pill/i, '💊'],
];

export function choreEmoji(text) {
  // A chore typed with its own leading emoji is self-labeled — no second icon.
  if (/^\p{Extended_Pictographic}/u.test(text)) return '';
  for (const [re, emoji] of CHORE_EMOJI) if (re.test(text)) return emoji;
  return '📌';
}

export function describeSchedule(r) {
  const d = JSON.parse(r.schedule_detail);
  if (r.schedule_kind === 'daily') return `daily ${fmtTime(d.h, d.mi)}`;
  if (r.schedule_kind === 'weekly') {
    return `every ${d.days.map((i) => DAY_NAMES[i]).join(',')} ${fmtTime(d.h, d.mi)}`;
  }
  if (r.schedule_kind === 'monthly') return `on the ${d.dom} at ${fmtTime(d.h, d.mi)}`;
  if (r.schedule_kind === 'interval') {
    if (d.months) return `every ${d.months} month${d.months > 1 ? 's' : ''} at ${fmtTime(d.h, d.mi)}`;
    const w = d.days % 7 === 0 ? d.days / 7 : 0;
    return w ? `every ${w} week${w > 1 ? 's' : ''} at ${fmtTime(d.h, d.mi)}`
             : `every ${d.days} days at ${fmtTime(d.h, d.mi)}`;
  }
  return 'once';
}

// Schedule cadence without the time-of-day (list cards lead with the time).
function cadence(r) {
  const d = JSON.parse(r.schedule_detail);
  if (r.schedule_kind === 'daily') return 'daily';
  if (r.schedule_kind === 'weekly') return `every ${d.days.map((i) => DAY_NAMES[i]).join(',')}`;
  if (r.schedule_kind === 'monthly') return `on the ${d.dom}`;
  if (r.schedule_kind === 'interval') {
    if (d.months) return `every ${d.months} month${d.months > 1 ? 's' : ''}`;
    const w = d.days % 7 === 0 ? d.days / 7 : 0;
    return w ? `every ${w} week${w > 1 ? 's' : ''}` : `every ${d.days} days`;
  }
  return 'once';
}

// Hybrid countdown + absolute: "today 9:00 PM" / "tomorrow 9:00 AM" /
// "in 3 days · Fri 5:00 PM" / "in 13 days · Aug 24, 7:00 PM".
export function fmtWhen(ms, tz) {
  const time = fmtClock(ms, tz);
  const t = localParts(ms, tz);
  const n = localParts(Date.now(), tz);
  const days = Math.round((Date.UTC(t.y, t.mo - 1, t.d) - Date.UTC(n.y, n.mo - 1, n.d)) / 86400000);
  if (days <= 0) return `today ${time}`;
  if (days === 1) return `tomorrow ${time}`;
  const when = days < 7 ? `${DAY_NAMES[t.wd]} ${time}` : fmtShort(ms, tz);
  return `in ${days} days · ${when}`;
}

// Every management button carries the chore's own identity — name plus when —
// because the pinned board's text never changes while you navigate. Internal
// numbers stay out of labels; the name is the handle everywhere else too.
export function buttonText(r, tz = 'Asia/Singapore') {
  const when = r.paused ? 'paused'
    : r.next_fire_at ? fmtWhen(r.next_fire_at, tz)
    : 'nagging now';
  return clip(`${[choreEmoji(r.text), r.text].filter(Boolean).join(' ')} · ${when}`);
}

export function clip(text, max = 42) {
  const chars = [...text];
  return chars.length > max ? `${chars.slice(0, max - 1).join('')}…` : text;
}

// Renders the chore-card list shared by /list and the pinned dashboard.
// Null when there are no chores at all.
export async function choreListHtml(env, chatId, tz) {
  const { results } = await env.DB.prepare(
    'SELECT * FROM reminders WHERE chat_id = ? ORDER BY id'
  ).bind(chatId).all();
  if (!results.length) return null;
  const st = await env.DB.prepare('SELECT paused_until FROM settings WHERE chat_id = ?').bind(chatId).first();
  const nagging = new Set((await env.DB.prepare(
    "SELECT reminder_id FROM firings WHERE chat_id = ? AND state = 'nagging'"
  ).bind(chatId).all()).results.map((f) => f.reminder_id));
  const lines = ['🐾 <b>Chores</b>'];
  if (st && st.paused_until && st.paused_until > Date.now()) {
    lines.push(`✈️ All paused until ${fmtLocal(st.paused_until, tz)} — /resume all to wake the cats.`);
  }
  // Nagging first, then upcoming soonest-first, paused last.
  const rank = (r) => r.paused ? 2 : (nagging.has(r.id) || !r.next_fire_at) ? 0 : 1;
  results.sort((a, b) => rank(a) - rank(b)
    || (a.next_fire_at || 0) - (b.next_fire_at || 0)
    || a.display_num - b.display_num);
  // Two short lines per chore — when, then what — so nothing wraps on a phone
  // (squashbot's board layout). "once" says nothing a missing cadence doesn't.
  for (const r of results) {
    const rot = r.schedule_detail.includes('"rotate"') ? ' 🔄' : '';
    const who = r.assignee_name ? ` · ${esc(r.assignee_name)}` : '';
    const lead = r.paused ? '⏸️ paused'
      : nagging.has(r.id) || !r.next_fire_at ? '🔔 nagging now'
      : fmtWhen(r.next_fire_at, tz);
    const each = cadence(r);
    lines.push('');
    lines.push(lead);
    // Chores are the default here; a reminder is the thing worth flagging,
    // since it looks identical but never reaches the leaderboard.
    const kind = isScored(r) ? '' : ' · <i>reminder</i>';
    lines.push(`${[choreEmoji(r.text), `<b>${esc(r.text)}</b>`].filter(Boolean).join(' ')}${rot}${who}` +
      (each === 'once' ? '' : ` · <i>${each}</i>`) + kind);
  }
  return lines.join('\n');
}

// The ways Telegram says "that message no longer exists / can never be
// edited". Everything else an edit can fail with is worth retrying next time
// rather than replacing the board over.
const GONE = /message to edit not found|message to be edited not found|MESSAGE_ID_INVALID|message can['’]?t be edited|message identifier is not specified/i;

function messageIsGone(description) {
  return GONE.test(String(description || ''));
}

// One pinned message per chat, silently edited in place: the full chore list
// (nagging marked 🔔, paused included). Created on first need, unpinned and
// removed only when the chore list is empty.
export async function updateDashboard(env, chatId) {
  try {
    const row = await env.DB.prepare(
      'SELECT dashboard_msg_id, tz FROM settings WHERE chat_id = ?'
    ).bind(chatId).first();
    const msgId = row && row.dashboard_msg_id;
    const tz = (row && row.tz) || 'Asia/Singapore';
    let html = await choreListHtml(env, chatId, tz);

    if (!html) {
      if (msgId) {
        await unpinMessage(env, chatId, msgId);
        await deleteMessage(env, chatId, msgId);
        await env.DB.prepare('UPDATE settings SET dashboard_msg_id = NULL WHERE chat_id = ?').bind(chatId).run();
      }
      return;
    }
    // A pin is a single message; past the 4096 cap, trim on a line boundary.
    if (html.length > 4000) {
      html = html.slice(0, html.lastIndexOf('\n', 3980)) + '\n… more — /list';
    }

    if (msgId) {
      const res = await editMessage(env, chatId, msgId, html, dashboardButtons());
      if (res.ok || String(res.description || '').includes('not modified')) return;
      // Only a board that is genuinely gone earns a replacement. Anything else
      // — a network blip, a 429 that outlived tg()'s one retry, any other
      // Telegram error — is transient, and recreating on it pins a second
      // board beside the first every time it happens.
      if (!messageIsGone(res.description)) {
        console.log(`dashboard edit failed for chat ${chatId}: ${res.description || 'unknown'} ` +
          '— keeping the existing board');
        return;
      }
      // Message was deleted by hand — fall through and recreate it.
    }
    // keep: the pinned dashboard is the one message the daily sweep spares.
    const sent = await sendMessage(env, chatId, html, dashboardButtons(), { silent: true, keep: true });
    if (sent.ok) {
      // A board that exists but isn't pinned is worse than a missing one: it
      // scrolls away and nobody notices it stopped being the board. Say so
      // loudly rather than failing silently.
      const pinned = await pinMessage(env, chatId, sent.result.message_id);
      if (!pinned.ok) {
        console.log(`dashboard pin FAILED for chat ${chatId}: ${pinned.description || 'unknown'} ` +
          '— bot needs the Pin Messages admin right');
      }
      await env.DB.prepare(
        'INSERT INTO settings (chat_id, dashboard_msg_id) VALUES (?, ?) ON CONFLICT(chat_id) DO UPDATE SET dashboard_msg_id = excluded.dashboard_msg_id'
      ).bind(chatId, sent.result.message_id).run();
    } else {
      console.log(`dashboard send failed for chat ${chatId}: ${sent.description || 'unknown'}`);
    }
  } catch (e) {
    console.log(`updateDashboard failed: ${e}`);
  }
}
