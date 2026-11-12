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
