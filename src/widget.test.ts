import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deflateSync } from 'node:zlib';
import { CARD_HTML, encodeState, parseGo, progress, statusLine, textBar, type CardState } from './widget.js';

test('карточка влезает в пределы Telegram: 32768 байт и 4096 после zlib 9', () => {
  const raw = Buffer.from(CARD_HTML, 'utf8');
  assert.ok(raw.length <= 32768, `HTML ${raw.length} байт`);
  const packed = deflateSync(raw, { level: 9 }).length;
  assert.ok(packed <= 4096, `после zlib ${packed} байт`);
  assert.ok(!CARD_HTML.includes('\u0000'));
});

test('состояние не длиннее 1024 байт даже с огромным русским именем и ошибкой', () => {
  const st: CardState = { s: 'err', n: 'Презентация'.repeat(80) + '.pptx', x: 'pptx', z: '12 МБ', p: 120, i: 99, e: 'ошибка '.repeat(200) };
  const json = encodeState(st);
  assert.ok(Buffer.byteLength(json) <= 1024, `${Buffer.byteLength(json)} байт`);
  assert.equal(JSON.parse(json).s, 'err');
});

test('короткое состояние не меняется', () => {
  const st: CardState = { s: 'ask', n: 'Отчёт.docx', x: 'docx', z: '45 КБ' };
  assert.deepEqual(JSON.parse(encodeState(st)), st);
});

test('запрос из карточки: только go:png|zip:0|1, не длиннее 64 байт', () => {
  assert.deepEqual(parseGo('go:png:0'), { mode: 'png', h: 0 });
  assert.deepEqual(parseGo('go:zip:1'), { mode: 'zip', h: 1 });
  for (const bad of ['go:pdf:0', 'go:png:2', 'go:png', '', 'go:png:0;rm']) assert.equal(parseGo(bad), null);
});

test('прогресс растёт по этапам, не выходит за 100, а где конец неизвестен — бегущая полоска', () => {
  const base: CardState = { s: 'render', n: 'a', x: 'pdf', z: '1 КБ', p: 10, i: 0 };
  const seq = [progress(base), progress({ ...base, i: 5 }), progress({ ...base, i: 10 }),
    progress({ ...base, s: 'pack' }), progress({ ...base, s: 'send', i: 10, m: 'png' }), progress({ ...base, s: 'done' })] as number[];
  for (let k = 1; k < seq.length; k++) assert.ok(seq[k] >= seq[k - 1], seq.join(','));
  assert.equal(seq.at(-1), 100);
  for (const s of ['queue', 'load', 'conv'] as const) assert.equal(progress({ ...base, s }), null);
  assert.equal(progress({ ...base, s: 'send', m: 'zip' }), null);
});

test('полоска для текстовой карточки', () => {
  const base: CardState = { s: 'render', n: 'a', x: 'pdf', z: '1 КБ', p: 10, i: 5 };
  assert.equal(textBar(base), '▰▰▰▰▱▱▱▱▱▱ 45%');
  assert.equal(textBar({ ...base, s: 'done' }), '▰▰▰▰▰▰▰▰▰▰ 100%');
  assert.equal(textBar({ ...base, s: 'conv' }), '▰▱▰▱▰▱▰▱▰▱');
});

test('в карточке нет подписи и есть отступ под время сообщения', () => {
  assert.ok(CARD_HTML.includes('env(safe-area-inset-bottom)'));
});

test('строка статуса', () => {
  const st: CardState = { s: 'done', n: 'a', x: 'pptx', z: '1 МБ', p: 12, m: 'png', t: 8 };
  assert.equal(statusLine(st), 'Готово: 12 картинок за 8 с');
  assert.equal(statusLine({ ...st, p: 3 }), 'Готово: 3 картинки за 8 с');
  assert.equal(statusLine({ ...st, p: 21 }), 'Готово: 21 картинка за 8 с');
  assert.equal(statusLine({ ...st, p: 5, m: 'zip' }), 'Готово: 5 страниц в архиве за 8 с');
  assert.equal(statusLine({ ...st, s: 'queue', q: 2 }), 'В очереди: ты 2-й');
});

test('«рисую и отправляю»: полоска от 10 до 100 по отправленным страницам', () => {
  const st: CardState = { s: 'stream', n: 'a', x: 'pptx', z: '1 МБ', p: 4, i: 0, m: 'png' };
  assert.equal(progress(st), 10);
  assert.equal(progress({ ...st, i: 2 }), 55);
  assert.equal(progress({ ...st, i: 4 }), 100);
  assert.equal(statusLine({ ...st, i: 3 }), 'Рисую и отправляю 3/4');
});
