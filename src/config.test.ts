import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from './config.js';

const MB = 1024 * 1024;

test('облачный Bot API: файл не больше 20 МБ, что бы ни написали в настройках', () => {
  const c = loadConfig({ BOT_TOKEN: 't', MAX_FILE_MB: '500', OWNER_MAX_FILE_MB: '2000' });
  assert.equal(c.localApi, false);
  assert.equal(c.maxFileBytes, 20 * MB);
  assert.equal(c.ownerMaxFileBytes, 20 * MB);
});

test('свой сервер Bot API: по умолчанию 200 МБ всем и 2000 МБ владельцу, выше 2000 нельзя', () => {
  const c = loadConfig({ BOT_TOKEN: 't', BOT_API_ROOT: 'http://127.0.0.1:8083/' });
  assert.equal(c.localApi, true);
  assert.equal(c.apiRoot, 'http://127.0.0.1:8083');
  assert.equal(c.maxFileBytes, 200 * MB);
  assert.equal(c.ownerMaxFileBytes, 2000 * MB);
  assert.equal(loadConfig({ BOT_TOKEN: 't', BOT_API_ROOT: 'http://x', MAX_FILE_MB: '9999' }).maxFileBytes, 2000 * MB);
});

test('без токена не стартуем', () => {
  assert.throws(() => loadConfig({}), /BOT_TOKEN/);
});
