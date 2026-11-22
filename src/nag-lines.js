// What the cats say on a nag: a line about the chore itself, in whichever
// cat's voice the sticker shows, getting firmer with each re-nag. A chore no
// topic recognises is quoted by name, so no nag is ever a generic line.
//
// {cat} is the name, {is} / {has} / {s} agree with it, {chore} is the chore.
// Topics are tried in order, so the specific ones (washing the Neakasa) come
// before the general ones (litter). Patterns match whole words: "car" must not
// catch "credit card", nor "tick" catch "tickets".

import { esc } from './tg.js';

const CAT_WORD = '(?:cats?|cattos?|latte|mocha)';

const TOPICS = [
  [/\b(?:poop|scoop)\b/i, [
    'Mrow! {cat} would like the poop cleared 🐾',
    '{cat} {is} staring at the litter box, then at you 👀',
    '{cat} {is} holding it in protest. For now 😾',
    'The poop is still there. {cat} {has} noticed 🙀',
  ]],
  [/\bshake\b.*\b(?:neakasa|litter)\b/i, [
    'Mrow! {cat} would like the Neakasa shaken 🐾',
    '{cat} {is} eyeing the uneven litter 👀',
    '{cat} just pawed at the Neakasa. Still unshaken 😾',
    'The Neakasa has not shaken itself. {cat} {is} appalled 🙀',
  ]],
  [/\b(?:wash|clean|scrub)\b.*\b(?:neakasa|litter)\b/i, [
    'Mrow! {cat} would like the Neakasa washed 🐾',
    '{cat} sniffed the Neakasa and walked away 👀',
    '{cat} {is} considering the carpet instead 😾',
    'The Neakasa has not washed itself. {cat} {is} appalled 🙀',
  ]],
  [/\b(?:litter|neakasa)\b/i, [
    'Mrow! {cat} would like the litter sorted 🐾',
    '{cat} {is} inspecting the litter. It falls short 👀',
    '{cat} just dug at the litter and sighed 😾',
    'The litter has not sorted itself. {cat} {is} appalled 🙀',
  ]],
  [new RegExp(`\\b${CAT_WORD}\\b.*\\bteeth\\b`, 'i'), [
    'Mrow! Teeth time. {cat} {is} already hiding 🐾',
    '{cat} {is} clamping shut in advance 👀',
    '{cat} would still rather not. The teeth still need brushing 😾',
    'Those teeth have not brushed themselves. {cat} {is} smug about it 🙀',
  ]],
  [new RegExp(`\\b${CAT_WORD}\\b.*\\bears?\\b`, 'i'), [
    'Mrow! Ear-cleaning time for {cat} 🐾',
    '{cat} {is} flattening their ears in advance 👀',
    '{cat} {is} under the bed. The ears still need cleaning 😾',
    'Those ears have not cleaned themselves. {cat} {is} hoping you forgot 🙀',
  ]],
  [/\b(?:nails?|claws?)\b/i, [
    'Mrow! Nail-cutting time, says {cat} 🐾',
    '{cat} {is} eyeing the clippers 👀',
    '{cat} {is} still waiting. The clippers have not moved 😾',
    'The nails keep growing. {cat} {is} watching 🙀',
  ]],
  [/\b(?:nexgard|fleas?|ticks?)\b/i, [
    'Mrow! Time for the flea and tick dose, says {cat} 🐾',
    '{cat} {is} scratching pointedly 👀',
    '{cat} would like no fleas, thank you 😾',
    'Still no dose. {cat} {is} itching to discuss it 🙀',
  ]],
  [/\bwater filter\b/i, [
    'Mrow! {cat} would like a fresh water filter 🐾',
    '{cat} can taste the old filter 👀',
    '{cat} just pushed the water bowl away 😾',
    'The old filter is still in. {cat} {is} parched 🙀',
  ]],
  [/\bfountain\b/i, [
    'Mrow! {cat} would like the fountain seen to 🐾',
    '{cat} {is} staring into the fountain, unimpressed 👀',
    '{cat} just drank from the tap in protest 😾',
    'The fountain has not sorted itself. {cat} {is} parched 🙀',
  ]],
  [/\btooth ?brush\b/i, [
    'Mrow! Your toothbrush head is due a change, says {cat} 🐾',
    '{cat} {is} staring at that frayed toothbrush 👀',
    '{cat} just knocked the toothbrush into the sink 😾',
    'Same old brush head. {cat} {is} judging your teeth 🙀',
  ]],
  [/\b(?:robo ?vac|roomba|robot vacuum)\b/i, [
    'Mrow! {cat} would like the robovac cleaned 🐾',
    '{cat} {is} watching the robovac wheeze past 👀',
    '{cat} just sat in the robovac\'s path in protest 😾',
    'The robovac has not cleaned itself. Ironic, says {cat} 🙀',
  ]],
  [/\bvacuum\b/i, [
    'Mrow! {cat} left plenty of fur for the vacuum 🐾',
    '{cat} {is} shedding on the floor on purpose 👀',
    '{cat} just added another layer of fur 😾',
    'The floor has not vacuumed itself. {cat} {is} shedding harder 🙀',
  ]],
  [/\bbed ?sheets?\b/i, [
    'Mrow! {cat} would like fresh bedsheets 🐾',
    '{cat} {is} sitting on the old sheets 👀',
    '{cat} just added more fur to the bedsheets 😾',
    'The sheets have not changed themselves. {cat} {is} still on them 🙀',
  ]],
  [/\bservic\w*\b.*\baircons?\b|\baircons?\b.*\bservic/i, [
    'Mrow! {cat} say{s} the aircons are due a service 🐾',
    '{cat} {is} glaring at the aircon vents 👀',
    '{cat} can hear the aircon wheezing 😾',
    'The aircons have not serviced themselves. {cat} {is} unimpressed 🙀',
  ]],
  [/\bon\b.*\baircons?\b|\baircons?\b.*\bon\b/i, [
    'Mrow! {cat} would like the aircons on 🐾',
    '{cat} {is} sprawled out, overheating dramatically 👀',
    '{cat} {is} lying on the cool tiles in protest 😾',
    'The aircons have not turned themselves on. {cat} {is} melting 🙀',
  ]],
  [/\b(?:bills?|town council|rent)\b/i, [
    'Mrow! {cat} would like this bill paid 🐾',
    '{cat} {is} sitting on the bill, staring at you 👀',
    '{cat} just batted the bill off the desk 😾',
    'The bill has not paid itself. {cat} will not be covering it 🙀',
  ]],
  [/\b(?:dish(?:es)?|dishwasher|plates?)\b/i, [
    'Mrow! {cat} would like the dishes sorted 🐾',
    '{cat} {is} inspecting the dishes 👀',
    '{cat} just nudged a plate toward the edge 😾',
    'The dishes have not done themselves. {cat} {is} still watching 🙀',
  ]],
  [/\bhealthy ?365\b/i, [
    'Mrow! {cat} say{s} it is time to log in to Healthy 365 🐾',
    '{cat} {is} guarding your phone until you log in 👀',
    '{cat} just sat on your phone. Healthy 365 is still waiting 😾',
    'Still not logged in. {cat} {is} worried about your points 🙀',
  ]],
];

const BY_NAME = [
  'Mrow! {cat} would like “{chore}” done 🐾',
  '{cat} {is} staring at you about “{chore}” 👀',
  '{cat} just knocked a pen off the desk over “{chore}” 😾',
  '“{chore}” has not done itself. {cat} {is} now sitting on it 🙀',
];

const VOICES = {
  latte: { cat: 'Latte', is: 'is', has: 'has', s: 's' },
  mocha: { cat: 'Mocha', is: 'is', has: 'has', s: 's' },
  both: { cat: 'Latte &amp; Mocha', is: 'are', has: 'have', s: '' },
};

const NAME_MAX = 40;

// The chore as a line quotes it: "to check the post" reads "check the post",
// and a long one is cut, since the card's title already has it in full.
function choreName(text) {
  const name = String(text || 'this chore').replace(/\s+/g, ' ').trim().replace(/^to\s+(?=\S)/i, '');
  const chars = Array.from(name);
  return esc(chars.length > NAME_MAX ? `${chars.slice(0, NAME_MAX - 1).join('').trimEnd()}…` : name);
}

export function nagLine(text, nagCount, cat = 'both') {
  const topic = TOPICS.find(([re]) => re.test(String(text || '')));
  const lines = topic ? topic[1] : BY_NAME;
  const line = lines[Math.min(Math.max(nagCount || 0, 0), lines.length - 1)];
  const voice = VOICES[cat] || VOICES.both;
  // One pass, so a chore that contains "{cat}" stays as typed.
  return line.replace(/\{(cat|is|has|s|chore)\}/g, (_, key) => (key === 'chore' ? choreName(text) : voice[key]));
}
