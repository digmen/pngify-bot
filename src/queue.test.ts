import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SerialQueue } from './queue.js';

const tick = () => new Promise<void>((r) => setTimeout(r, 5));

test('по одной задаче за раз, в порядке постановки, ошибка не останавливает очередь', async () => {
  const q = new SerialQueue();
  const log: string[] = [];
  let active = 0;
  const task = (id: string, fail = false) => ({
    id,
    run: async () => {
      active++;
      assert.equal(active, 1, 'одновременно больше одной');
      log.push(`start ${id}`);
      await tick();
      active--;
      if (fail) throw new Error('boom');
    },
  });
  q.push(task('a'));
  q.push(task('b', true));
  q.push(task('c'));
  await new Promise((r) => setTimeout(r, 60));
  assert.deepEqual(log, ['start a', 'start b', 'start c']);
  assert.equal(q.size, 0);
});

test('позиции в очереди сдвигаются', async () => {
  const q = new SerialQueue();
  const pos: Record<string, number[]> = { b: [], c: [] };
  q.push({ id: 'a', run: tick });
  q.push({ id: 'b', run: tick, onPosition: (p) => pos.b.push(p) });
  q.push({ id: 'c', run: tick, onPosition: (p) => pos.c.push(p) });
  await new Promise((r) => setTimeout(r, 60));
  assert.deepEqual(pos.b, [1]);
  assert.deepEqual(pos.c, [2, 1]);
});
