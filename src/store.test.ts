import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { JobStore, recoveryAction, type SavedJob } from './store.js';

const job = (over: Partial<SavedJob> = {}): SavedJob => ({
  id: 'a1', userId: 1, chatId: 1, messageId: 10, cardKind: 'widget', fileId: 'F', fileName: 'x.pptx', ext: 'pptx',
  size: 100, state: { s: 'ask', n: 'x.pptx', x: 'pptx', z: '1 КБ' }, createdAt: 1000, started: false, crashes: 0, ...over,
});
const DAY = 24 * 3600_000;

test('после запуска: нетронутые карточки живут, старые забываются', () => {
  assert.equal(recoveryAction(job(), 2000, DAY), 'keep');
  assert.equal(recoveryAction(job(), 1000 + DAY + 1, DAY), 'drop');
});

test('начатая задача продолжается; после штатной остановки падение не считается', () => {
  assert.equal(recoveryAction(job({ started: true, mode: 'png', running: true }), 2000, DAY), 'resume');
  assert.equal(recoveryAction(job({ started: true, mode: 'png', running: true, crashes: 1, interrupted: true }), 2000, DAY), 'resume');
  assert.equal(recoveryAction(job({ started: true, mode: 'zip', crashes: 1 }), 2000, DAY), 'resume'); // ждала в очереди — не её вина
});

test('файл, который дважды уронил бота, больше не берём', () => {
  assert.equal(recoveryAction(job({ started: true, mode: 'png', running: true, crashes: 1 }), 2000, DAY), 'fail');
});

test('сохранение на диск и чтение назад; битый файл не мешает запуску', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'pngify-'));
  const file = path.join(dir, 'data', 'jobs.json');
  const list = [job(), job({ id: 'b2', messageId: 11 })];
  const store = new JobStore(file, () => list);
  await store.saveNow();
  assert.deepEqual(await new JobStore(file, () => []).load(), list);
  await writeFile(file, '{обрывок');
  assert.deepEqual(await new JobStore(file, () => []).load(), []);
  await writeFile(file, JSON.stringify([{ id: 1 }, job()]));
  assert.equal((await new JobStore(file, () => []).load()).length, 1, 'кривые записи отброшены');
  assert.ok((await readFile(file, 'utf8')).length > 0);
});
