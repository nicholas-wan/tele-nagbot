import { describe, it, expect } from 'vitest';
import { nagLine } from '../src/nag-lines.js';
import { nagHtml } from '../src/nag.js';

describe('nag lines follow the chore', () => {
  it.each([
    ['clear poop', /poop/],
    ['shake neakasa', /Neakasa shaken/],
    ['wash neakasa', /Neakasa washed/],
    ['add litter', /litter sorted/],
    ['brush cattos teeth', /Teeth time/],
    ['clean cattos ears', /Ear-cleaning/],
    ['cut nails', /Nail-cutting/],
    ['nexgard vaccine', /flea and tick/],
    ['cat fountain', /fountain/],
    ['change cat water filter', /water filter/],
    ['change toothbrush head', /toothbrush head/],
    ['clean robovac', /robovac/],
    ['vacuum', /vacuum/],
    ['bedsheets', /bedsheets/],
    ['service aircons', /due a service/],
    ['on all aircon', /aircons on/],
    ['Town Council Bill', /bill paid/],
    ['wash plates', /dishes/],
    ['clearing dishwasher', /dishes/],
    ['login healthy365', /Healthy 365/],
  ])('%s', (chore, expected) => {
    expect(nagLine(chore, 0, 'latte')).toMatch(expected);
  });

  it('quotes a chore it does not recognise', () => {
    expect(nagLine('whitelist', 0, 'mocha')).toBe('Mrow! Mocha would like “whitelist” done 🐾');
    expect(nagLine('to check out infant care for poppy', 0, 'latte')).toContain('“check out infant care for poppy”');
  });

  it('does not match inside other words', () => {
    for (const chore of ['to bring uob credit card', 'buy tickets', 'carpark clearance']) {
      expect(nagLine(chore, 0, 'latte')).toContain('“');
    }
  });

  it('gets firmer with each re-nag, then stays on the last line', () => {
    const lines = [0, 1, 2, 3].map((n) => nagLine('clear poop', n, 'latte'));
    expect(new Set(lines).size).toBe(4);
    expect(nagLine('clear poop', 9, 'latte')).toBe(lines[3]);
  });

  it('agrees with whichever cat is on the sticker', () => {
    expect(nagLine('clear poop', 1, 'mocha')).toContain('Mocha is staring');
    expect(nagLine('clear poop', 1, 'both')).toContain('Latte &amp; Mocha are staring');
    expect(nagLine('service aircons', 0, 'latte')).toContain('Latte says');
    expect(nagLine('service aircons', 0, 'both')).toContain('Latte &amp; Mocha say the');
    expect(nagLine('clear poop', 3, 'both')).toContain('have noticed');
  });

  it('leaves no placeholder in any line, for any cat or nag', () => {
    for (const chore of ['clear poop', 'shake neakasa', 'service aircons', 'login healthy365', 'whitelist']) {
      for (const cat of ['latte', 'mocha', 'both', 'unknown']) {
        for (const n of [0, 1, 2, 3]) expect(nagLine(chore, n, cat)).not.toMatch(/[{}]|undefined/);
      }
    }
  });

  it('escapes a quoted chore and keeps it short', () => {
    expect(nagLine('<b>x</b> & {cat}', 0, 'latte')).toContain('&lt;b&gt;x&lt;/b&gt; &amp; {cat}');
    const long = nagLine('z'.repeat(200), 0, 'latte');
    expect(long).toContain('…');
    expect(long.length).toBeLessThan(90);
  });

  it('reaches the nag card', () => {
    const html = nagHtml({ text: 'clear poop', scored: 1 }, 1, 'latte');
    expect(html).toContain('Latte is staring at the litter box');
    expect(html).toContain('nag #2');
  });
});
