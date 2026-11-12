import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detectKind, humanSize, pngName, safeBaseName } from './formats.js';

test('форматы по расширению, без учёта регистра', () => {
  assert.deepEqual(detectKind('Доклад.PPTX'), { ext: 'pptx', kind: 'slides' });
  assert.equal(detectKind('отчёт.docx')?.kind, 'text');
  assert.equal(detectKind('book.xlsx')?.kind, 'sheet');
  assert.equal(detectKind('scan.pdf')?.kind, 'pdf');
  for (const bad of ['virus.exe', 'archive.zip', 'noext', '', undefined, 'photo.jpg']) assert.equal(detectKind(bad), null);
});

test('безопасное имя: без пути, спецсимволов и не длиннее 40', () => {
  assert.equal(safeBaseName('../../etc/passwd.pptx'), 'etc_passwd');
  assert.equal(safeBaseName('Годовой отчёт (финал) v2.docx'), 'Годовой_отчёт_финал_v2');
  assert.equal(safeBaseName('.pptx'), 'page');
  assert.ok(safeBaseName('а'.repeat(100) + '.pdf').length <= 40);
});

test('номера страниц с нулями, чтобы шли по порядку', () => {
  assert.equal(pngName('Отчёт', 3, 12), 'Отчёт-03.png');
  assert.equal(pngName('x', 7, 7), 'x-7.png');
  assert.equal(pngName('x', 1, 120), 'x-001.png');
});

test('размер', () => {
  assert.equal(humanSize(500), '1 КБ');
  assert.equal(humanSize(45 * 1024), '45 КБ');
  assert.equal(humanSize(3 * 1024 * 1024), '3 МБ');
  assert.equal(humanSize(2.5 * 1024 * 1024), '2.5 МБ');
});

test('подпись файла: настоящий, под паролем, мусор', async () => {
  const { checkSignature } = await import('./formats.js');
  const zip = Buffer.from([0x50, 0x4b, 0x03, 0x04, 1, 2, 3, 4]);
  const ole = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0]);
  const junk = Buffer.from([0x13, 0x00, 0xff, 0x8a, 0x02, 0x7f, 0x00, 0x11]);
  assert.equal(checkSignature('pptx', zip), 'ok');
  assert.equal(checkSignature('docx', ole), 'encrypted');
  assert.equal(checkSignature('docx', junk), 'mismatch');
  assert.equal(checkSignature('ppt', ole), 'ok');
  assert.equal(checkSignature('doc', Buffer.from('{\\rtf1\\ansi')), 'ok');
  assert.equal(checkSignature('ppt', junk), 'mismatch');
  assert.equal(checkSignature('pdf', Buffer.from('%PDF-1.7\n')), 'ok');
  assert.equal(checkSignature('pdf', junk), 'mismatch');
  assert.equal(checkSignature('txt', Buffer.from('Привет, мир\nстрока 2')), 'ok');
  assert.equal(checkSignature('csv', junk), 'mismatch');
  assert.equal(checkSignature('odt', zip), 'ok');
});
