// Downloads the LatteMocha2 sticker pack (the one /usepack set) into .claude/stickers/.
// Run with the bot token in the environment; the token is never printed or saved.
//   $env:BOT_TOKEN = '<token>'; node .claude/get-sticker-pack.cjs
const fs = require('fs');
const path = require('path');
// Pasted tokens often carry quotes, spaces, a line break or a "bot" prefix; keep only the token itself.
const raw = String(process.env.BOT_TOKEN || '');
const token = (raw.match(/\d{6,12}:[A-Za-z0-9_-]{30,}/) || [''])[0];
if (!token) {
  // Describe the shape only: counts, plus the codes of any characters a token never contains.
  const odd = [...raw].filter((c) => !/[A-Za-z0-9_:-]/.test(c)).map((c) => `U+${c.codePointAt(0).toString(16).toUpperCase().padStart(4, '0')}`);
  const colon = raw.indexOf(':');
  console.error(`That does not look like a bot token: ${raw.length} characters, ${colon < 0 ? 'no colon' : `${raw.slice(0, colon).replace(/\D/g, '').length} digits before the colon, ${raw.length - colon - 1} characters after it`}, other characters: ${odd.join(' ') || 'none'}.`);
  console.error('It should look like 123456789:AA... (about 46 characters), from @BotFather > /mybots > your bot > API Token.');
  process.exit(1);
}
const pack = process.argv[2] || 'LatteMocha2';
const out = path.join(__dirname, 'stickers');
const api = async (method, params) => {
  const res = await fetch(`https://api.telegram.org/bot${token}/${method}?${new URLSearchParams(params)}`);
  const data = await res.json();
  if (!data.ok) throw new Error(`${method}: ${data.description}`);
  return data.result;
};
(async () => {
  const me = await api('getMe', {}).catch(() => null);
  if (!me) throw new Error('Telegram did not accept that token. Copy it again from @BotFather (API Token) and paste only the token.');
  console.log(`Token works for @${me.username}.`);
  fs.mkdirSync(out, { recursive: true });
  const set = await api('getStickerSet', { name: pack }).catch((e) => {
    throw new Error(`${e.message}. The pack "${pack}" was not found; open it in Telegram and check its link name (t.me/addstickers/<name>).`);
  });
  const index = [];
  for (const [i, s] of set.stickers.entries()) {
    const file = await api('getFile', { file_id: s.file_id });
    const ext = path.extname(file.file_path) || (s.is_video ? '.webm' : s.is_animated ? '.tgs' : '.webp');
    const name = `${String(i).padStart(2, '0')}-${s.file_unique_id}${ext}`;
    const res = await fetch(`https://api.telegram.org/file/bot${token}/${file.file_path}`);
    fs.writeFileSync(path.join(out, name), Buffer.from(await res.arrayBuffer()));
    index.push({ name, emoji: s.emoji, uid: s.file_unique_id, animated: !!s.is_animated, video: !!s.is_video });
  }
  fs.writeFileSync(path.join(out, 'index.json'), JSON.stringify({ title: set.title, stickers: index }, null, 2));
  console.log(`Saved ${index.length} stickers from "${set.title}" to ${out}`);
})().catch((e) => { console.error(e.message.replace(token, '<token>')); process.exit(1); });
