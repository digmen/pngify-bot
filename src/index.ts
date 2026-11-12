import { copyFile, link, mkdir, open, readdir, rename, rm, stat, statfs, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { Bot, GrammyError, HttpError, InputFile, InputMediaBuilder, type Api } from 'grammy';
import { autoRetry } from '@grammyjs/auto-retry';
import { loadConfig } from './config.js';
import { KIND_LABEL, SUPPORTED_HINT, checkSignature, detectKind, humanSize, pngName, safeBaseName } from './formats.js';
import { ConvertError, makeZip, pageCount, renderPage, toPdf, type RunOptions } from './convert.js';
import { SerialQueue } from './queue.js';
import { answerWidgetQuery, describeError, restoreCard, sendCard, type Card } from './cards.js';
import { JobStore, recoveryAction, type SavedJob } from './store.js';
import { dpiOf, parseGo, type CardState, type Mode } from './widget.js';

try { process.loadEnvFile(); } catch { /* .env не обязателен: на сервере переменные даёт systemd */ }
const cfg = loadConfig();
const hideToken = (text: string) => text.replaceAll(cfg.token, '<token>');
const log = (msg: string) => console.error(hideToken(msg));

// Большой файл через свой сервер Bot API качается и отправляется долго — ждём до 15 минут на запрос.
const bot = new Bot(cfg.token, { client: { apiRoot: cfg.apiRoot, timeoutSeconds: 900 } });
// 429 «подожди N секунд» и сбои 5xx Telegram повторяем сами, а не показываем пользователю ошибку.
bot.api.config.use(autoRetry({ maxRetryAttempts: 3, maxDelaySeconds: 60, rethrowInternalServerErrors: false }));
const queue = new SerialQueue();

/** Файл, присланный пользователем. Документ скачивается только когда дошла очередь. */
interface Job extends Omit<SavedJob, 'cardKind' | 'messageId'> {
  card: Card;
}

const JOB_TTL_MS = 7 * 24 * 3600_000; // кнопки карточки работают неделю
const MAX_ACTIVE_PER_USER = 3; // в очереди и в работе одновременно
const MAX_QUEUE = 50;
const MAX_FILES_PER_MINUTE = 15;
// Облачный Bot API принимает от бота файлы до 50 МБ, свой сервер — до 2000 МБ.
const UPLOAD_MAX_BYTES = (cfg.localApi ? 2000 : 49) * 1024 * 1024;
const MIN_FREE_DISK = 2 * 1024 * 1024 * 1024; // сервер общий: оставляем минимум 2 ГБ другим
const mbOf = (bytes: number) => Math.round(bytes / 1024 / 1024);

const jobs = new Map<string, Job>(); // ключ — chatId:messageId карточки
const lastJobOfUser = new Map<number, Job>();
const recentFiles = new Map<number, number[]>();
const stats = { files: 0, done: 0, errors: 0, pages: 0, since: new Date().toISOString() };
let stopping = false;

const key = (chatId: number, messageId: number) => `${chatId}:${messageId}`;
const isOwner = (userId: number | undefined) => cfg.ownerId !== null && userId === cfg.ownerId;

const store = new JobStore(path.join(cfg.dataDir, 'jobs.json'), () =>
  [...jobs.values()].map(({ card, ...j }) => ({ ...j, cardKind: card.kind, messageId: card.messageId, interrupted: stopping })),
);

function remember(job: Job): void {
  jobs.set(key(job.chatId, job.card.messageId), job);
  lastJobOfUser.set(job.userId, job);
  store.save();
}

function forget(job: Job): void {
  jobs.delete(key(job.chatId, job.card.messageId));
  if (lastJobOfUser.get(job.userId) === job) lastJobOfUser.delete(job.userId);
  store.save();
}

function setState(job: Job, patch: Partial<CardState>): void {
  job.state = { ...job.state, ...patch };
  job.card.update(job.state);
  if (patch.s) store.save();
}

/** Слишком много файлов подряд от одного человека — защита сервера от спама. */
function floodCheck(userId: number): boolean {
  if (isOwner(userId)) return true;
  const now = Date.now();
  const list = (recentFiles.get(userId) ?? []).filter((t) => now - t < 60_000);
  list.push(now);
  recentFiles.set(userId, list);
  return list.length <= MAX_FILES_PER_MINUTE;
}

// Раз в час: забываем карточки старше недели и ленты антиспама.
setInterval(() => {
  const now = Date.now();
  for (const job of jobs.values()) if (!job.started && now - job.createdAt > JOB_TTL_MS) forget(job);
  for (const [u, list] of recentFiles) if (!list.some((t) => now - t < 60_000)) recentFiles.delete(u);
}, 3600_000).unref();

const HELP = [
  'Пришли файл — верну каждую страницу или слайд отдельной PNG-картинкой.',
  '',
  `Форматы: ${SUPPORTED_HINT}.`,
  `До ${mbOf(cfg.maxFileBytes)} МБ и ${cfg.maxPages} страниц.`,
  '',
  'В карточке файла выбери качество и как прислать: картинками или одним ZIP.',
  'Если карточка не открылась — команды /png и /zip для последнего файла.',
  'Файлы удаляются с сервера сразу после отправки.',
].join('\n');

bot.command(['start', 'help'], (ctx) => ctx.reply(HELP));

bot.command('stats', async (ctx) => {
  if (!isOwner(ctx.from?.id)) return;
  const disk = await statfs(cfg.workDir).then((s) => `${mbOf(s.bavail * s.bsize)} МБ`).catch(() => '?');
  await ctx.reply(
    `С ${stats.since.slice(0, 16).replace('T', ' ')} UTC:\nфайлов ${stats.files}, готово ${stats.done}, ошибок ${stats.errors}, страниц ${stats.pages}\n`
      + `в очереди ${queue.size}, карточек в памяти ${jobs.size}\nсвободно на диске ${disk}, память бота ${mbOf(process.memoryUsage().rss)} МБ`,
  );
});

bot.on('message:document', async (ctx) => {
  const doc = ctx.message.document;
  if (!floodCheck(ctx.from.id)) {
    if ((recentFiles.get(ctx.from.id)?.length ?? 0) === MAX_FILES_PER_MINUTE + 1) await ctx.reply('Слишком много файлов за минуту. Подожди немного.');
    return;
  }
  const detected = detectKind(doc.file_name);
  if (!detected) {
    await ctx.reply(`Этот формат не умею. Подойдут: ${SUPPORTED_HINT}.`);
    return;
  }
  const maxBytes = isOwner(ctx.from.id) ? cfg.ownerMaxFileBytes : cfg.maxFileBytes;
  if ((doc.file_size ?? 0) > maxBytes) {
    await ctx.reply(`Файл больше ${mbOf(maxBytes)} МБ — такой не возьму. Сожми его или раздели на части.`);
    return;
  }
  stats.files++;
  const state: CardState = { s: 'ask', n: doc.file_name ?? 'файл', x: detected.ext, z: humanSize(doc.file_size ?? 0) };
  const card = await sendCard(ctx.api, ctx.chat.id, state);
  remember({
    id: randomBytes(6).toString('hex'),
    userId: ctx.from.id,
    chatId: ctx.chat.id,
    fileId: doc.file_id,
    fileName: doc.file_name ?? `file.${detected.ext}`,
    ext: detected.ext,
    size: doc.file_size ?? 0,
    card,
    state,
    createdAt: Date.now(),
    started: false,
    crashes: 0,
  });
});

bot.on(['message:photo', 'message:video'], (ctx) => ctx.reply('Пришли документ файлом (скрепка → Файл), а не фото или видео.'));
// Обычный текст — подсказка. Команды пропускаем дальше: их обработчики ниже по файлу.
bot.on('message:text', async (ctx, next) => {
  if (ctx.message.text.startsWith('/')) return next();
  await ctx.reply('Пришли файл — презентацию, документ, таблицу или PDF.');
});

type StartResult = 'ok' | 'gone' | 'busy' | 'many' | 'full';

function enqueue(job: Job): void {
  queue.push({
    id: job.id,
    onPosition: (q) => setState(job, { s: 'queue', q }),
    run: () => processJob(job),
  });
}

/** Запуск задачи по выбору пользователя. Возвращает ответ для карточки. */
function start(job: Job | undefined, mode: Mode, h: 0 | 1): StartResult {
  if (!job) return 'gone';
  if (job.started) return 'busy';
  if (stopping) return 'full';
  if (queue.size >= MAX_QUEUE) return 'full';
  const active = [...jobs.values()].filter((j) => j.userId === job.userId && j.started).length;
  if (!isOwner(job.userId) && active >= MAX_ACTIVE_PER_USER) return 'many';
  job.started = true;
  job.mode = mode;
  job.h = h;
  setState(job, { s: 'queue', m: mode, h });
  enqueue(job);
  return 'ok';
}

const START_REPLY: Record<Exclude<StartResult, 'ok'>, string> = {
  gone: 'Файл устарел, пришли его ещё раз.',
  busy: 'Этот файл уже в работе. Пришли его ещё раз, если нужен другой вариант.',
  many: 'Дождись, пока закончатся прошлые файлы.',
  full: 'Очередь переполнена, попробуй через минуту.',
};

for (const [cmd, mode] of [['png', 'png'], ['zip', 'zip']] as const) {
  bot.command(cmd, async (ctx) => {
    const job = ctx.from ? lastJobOfUser.get(ctx.from.id) : undefined;
    if (!job) return void (await ctx.reply('Сначала пришли файл.'));
    const res = start(job, mode, 0);
    if (res !== 'ok') await ctx.reply(START_REPLY[res]);
  });
}

// Кнопки текстовой карточки (клиенты без виджетов).
bot.on('callback_query:data', async (ctx) => {
  const go = parseGo(ctx.callbackQuery.data);
  const msg = ctx.callbackQuery.message;
  if (!go || !msg) return ctx.answerCallbackQuery();
  const job = jobs.get(key(msg.chat.id, msg.message_id));
  const res = job && job.userId === ctx.from.id ? start(job, go.mode, go.h) : 'gone';
  await ctx.answerCallbackQuery(res === 'ok' ? undefined : { text: START_REPLY[res] });
});

// Запросы из виджета: update.widget_query (Bot API 10.4). У grammY пока нет типа — читаем вручную.
bot.use(async (ctx, next) => {
  const q = (ctx.update as { widget_query?: { id: string; data: string; from: { id: number }; chat?: { id: number }; message_id?: number } }).widget_query;
  if (!q) return next();
  const go = parseGo(q.data);
  const job = q.chat && q.message_id ? jobs.get(key(q.chat.id, q.message_id)) : undefined;
  const res = go && job && job.userId === q.from.id ? start(job, go.mode, go.h) : 'gone';
  await answerWidgetQuery(ctx.api, q.id, res);
});

/** Хватит ли места на диске под файл и картинки, не задев соседей по серверу. */
async function checkDisk(size: number): Promise<void> {
  const s = await statfs(cfg.workDir);
  if (s.bavail * s.bsize < MIN_FREE_DISK + size * 4) {
    throw new ConvertError(`мало места: ${mbOf(s.bavail * s.bsize)} МБ`, 'Сервер сейчас занят. Попробуй через несколько минут.');
  }
}

async function download(api: Api, job: Job, dir: string): Promise<string> {
  let file;
  try {
    file = await api.getFile(job.fileId);
  } catch (e) {
    throw new ConvertError(`getFile: ${describeError(e)}`, 'Telegram не отдал файл. Пришли его ещё раз.');
  }
  if (!file.file_path) throw new ConvertError('нет file_path', 'Telegram не отдал файл. Пришли его ещё раз.');
  const input = path.join(dir, `input.${job.ext}`);
  if (cfg.localApi) {
    // Свой сервер Bot API уже положил файл на диск и вернул путь внутри своего контейнера.
    // Забираем файл себе (перемещением): у сервера копия не остаётся.
    if (!file.file_path.startsWith(`${cfg.botapiDirContainer}/`)) throw new ConvertError(`чужой путь: ${file.file_path}`, 'Telegram не отдал файл. Пришли его ещё раз.');
    const hostPath = path.join(cfg.botapiDirHost, file.file_path.slice(cfg.botapiDirContainer.length));
    if (!path.resolve(hostPath).startsWith(`${path.resolve(cfg.botapiDirHost)}/`)) throw new ConvertError(`путь вне каталога: ${hostPath}`, 'Telegram не отдал файл. Пришли его ещё раз.');
    try {
      await rename(hostPath, input);
    } catch {
      await copyFile(hostPath, input);
      await rm(hostPath, { force: true });
    }
    return input;
  }
  const res = await fetch(`${cfg.apiRoot}/file/bot${cfg.token}/${file.file_path}`, { signal: AbortSignal.timeout(300_000) });
  if (!res.ok) throw new ConvertError(`скачивание: ${res.status}`, 'Не получилось скачать файл. Пришли его ещё раз.');
  await writeFile(input, Buffer.from(await res.arrayBuffer()));
  return input;
}

/** Файл — то, чем назван? Иначе LibreOffice откроет мусор как текст. */
async function verifyFile(job: Job, input: string): Promise<void> {
  const fh = await open(input, 'r');
  try {
    const { buffer, bytesRead } = await fh.read(Buffer.alloc(4096), 0, 4096, 0);
    const res = checkSignature(job.ext, buffer.subarray(0, bytesRead));
    const kind = detectKind(job.fileName)?.kind;
    if (res === 'encrypted') throw new ConvertError('под паролем', 'Файл защищён паролем. Сними пароль и пришли снова.');
    if (res === 'mismatch') throw new ConvertError(`подпись не ${job.ext}`, `Файл повреждён или это не ${kind ? KIND_LABEL[kind].toLowerCase() : 'документ'} .${job.ext}.`);
  } finally {
    await fh.close();
  }
}

async function sendPngs(job: Job, files: string[], names: string[]): Promise<void> {
  for (let i = 0; i < files.length; i += 10) {
    const chunk = files.slice(i, i + 10);
    if (chunk.length === 1) {
      await bot.api.sendDocument(job.chatId, new InputFile(chunk[0], names[i]));
    } else {
      await bot.api.sendMediaGroup(job.chatId, chunk.map((f, j) => InputMediaBuilder.document(new InputFile(f, names[i + j]))));
    }
    setState(job, { s: 'send', i: Math.min(i + 10, files.length) });
  }
}

/** Понятный человеку текст для любой ошибки. Подробности — только в журнал. */
function userMessageOf(e: unknown): string {
  if (e instanceof ConvertError) return e.userMessage;
  if (e instanceof GrammyError) {
    if (e.error_code === 413 || /too big|too large/i.test(e.description)) return 'Готовый файл слишком большой для Telegram. Выбери «Картинками» или обычное качество.';
    if (e.error_code === 400 && /file/i.test(e.description)) return 'Telegram не принял файл. Попробуй ещё раз.';
    return 'Telegram не принял ответ. Попробуй ещё раз через минуту.';
  }
  if (e instanceof HttpError) return 'Связь с Telegram оборвалась. Попробуй ещё раз через минуту.';
  return 'Что-то пошло не так. Попробуй ещё раз.';
}

async function processJob(job: Job): Promise<void> {
  if (stopping) return; // при остановке задача останется в jobs.json и продолжится после запуска
  const mode = job.mode ?? 'png';
  const h = job.h ?? 0;
  const t0 = Date.now();
  const dir = path.join(cfg.workDir, job.id);
  const opts: RunOptions = { jobDir: dir, timeoutSec: cfg.convertTimeoutSec, sandbox: cfg.sandbox };
  job.running = true;
  await store.saveNow(); // если бот упадёт на этом файле, после запуска будет видно, что упал именно он
  try {
    await checkDisk(job.size);
    await rm(dir, { recursive: true, force: true });
    await mkdir(dir, { recursive: true, mode: 0o700 });
    setState(job, { s: 'load', q: undefined });
    const input = await download(bot.api, job, dir);
    await verifyFile(job, input);
    setState(job, { s: 'conv' });
    const pdf = await toPdf(input, opts);
    await rm(input, { force: true }); // исходник больше не нужен — место освобождаем сразу
    const total = await pageCount(pdf, opts);
    const limit = isOwner(job.userId) ? cfg.ownerMaxPages : cfg.maxPages;
    if (total === 0) throw new ConvertError('0 страниц', 'В файле нет страниц.');
    if (total > limit) throw new ConvertError(`${total} > ${limit}`, `В файле ${total} страниц, а можно до ${limit}. Раздели файл на части.`);

    const base = safeBaseName(job.fileName);
    const files: string[] = [];
    const names: string[] = [];
    setState(job, { s: 'render', p: total, i: 0 });
    for (let page = 1; page <= total; page++) {
      if (stopping) throw new Error('остановка бота');
      files.push(await renderPage(pdf, page, dpiOf(h), path.join(dir, `p${page}`), opts));
      names.push(pngName(base, page, total));
      setState(job, { i: page });
    }

    if (mode === 'zip') {
      setState(job, { s: 'pack' });
      // В архиве — понятные имена («Отчёт-01.png»), а не p1.png: жёсткие ссылки в отдельной папке, без копирования.
      const named = path.join(dir, 'out');
      await mkdir(named);
      const namedFiles = await Promise.all(files.map(async (f, k) => { const p = path.join(named, names[k]); await link(f, p); return p; }));
      const zip = await makeZip(path.join(dir, `${base}.zip`), namedFiles, opts);
      if ((await stat(zip)).size <= UPLOAD_MAX_BYTES) {
        setState(job, { s: 'send', i: 0 });
        await bot.api.sendDocument(job.chatId, new InputFile(zip, `${base}.zip`));
      } else {
        await bot.api.sendMessage(job.chatId, `Архив вышел больше ${mbOf(UPLOAD_MAX_BYTES)} МБ — Telegram такой не пропустит. Шлю картинками.`);
        setState(job, { s: 'send', i: 0, m: 'png' });
        await sendPngs(job, files, names);
      }
    } else {
      setState(job, { s: 'send', i: 0 });
      await sendPngs(job, files, names);
    }
    stats.done++;
    stats.pages += total;
    setState(job, { s: 'done', i: total, t: Math.max(1, Math.round((Date.now() - t0) / 1000)) });
    forget(job);
  } catch (e) {
    if (stopping) {
      log(`[job ${job.id}] прервана остановкой бота, продолжится после запуска`);
      job.running = false;
      return;
    }
    stats.errors++;
    log(`[job ${job.id}] ${job.ext} ${job.size}B: ${describeError(e)}`);
    if (!(e instanceof GrammyError && e.error_code === 403)) setState(job, { s: 'err', e: userMessageOf(e) });
    forget(job);
  } finally {
    job.running = false;
    await rm(dir, { recursive: true, force: true }).catch((e) => log(`[job ${job.id}] не удалил папку: ${String(e)}`));
  }
}

bot.catch((err) => {
  const e = err.error;
  const where = err.ctx?.update?.update_id ?? '?';
  if (e instanceof GrammyError) log(`[bot] Telegram отказал (update ${where}): ${e.error_code} ${e.description}`);
  else if (e instanceof HttpError) log(`[bot] нет связи с Telegram (update ${where}): ${String(e.error ?? e)}`);
  else log(`[bot] ошибка в обработчике (update ${where}): ${e instanceof Error ? e.stack ?? e.message : String(e)}`);
});

/** После запуска: вернуть карточки и доделать начатое. */
async function recover(): Promise<void> {
  const saved = await store.load();
  const now = Date.now();
  let resumed = 0;
  for (const s of saved) {
    const action = recoveryAction(s, now, JOB_TTL_MS);
    if (action === 'drop') continue;
    const { cardKind, messageId, interrupted, ...rest } = s;
    const job: Job = { ...rest, card: restoreCard(bot.api, cardKind, s.chatId, messageId) };
    if (s.running && !interrupted) job.crashes++;
    job.running = false;
    if (action === 'fail') {
      job.state = { ...job.state, s: 'err', e: 'Этот файл не получается обработать. Сохрани его в PDF и пришли снова.' };
      job.card.update(job.state);
      log(`[recover] ${s.id}: падал ${job.crashes} раз, больше не берём`);
      continue;
    }
    jobs.set(key(job.chatId, messageId), job);
    lastJobOfUser.set(job.userId, job);
    if (action === 'resume') {
      setState(job, { s: 'queue' });
      enqueue(job);
      resumed++;
    }
  }
  await store.saveNow();
  if (saved.length) log(`[recover] карточек ${jobs.size}, продолжено задач ${resumed}`);
}

async function main(): Promise<void> {
  // Остатки прошлого запуска (бот упал посреди задачи) — чистим.
  await mkdir(cfg.workDir, { recursive: true, mode: 0o700 });
  for (const d of await readdir(cfg.workDir)) await rm(path.join(cfg.workDir, d), { recursive: true, force: true });
  await recover();
  await bot.api.setMyCommands([
    { command: 'start', description: 'Что умеет бот' },
    { command: 'png', description: 'Последний файл — картинками' },
    { command: 'zip', description: 'Последний файл — ZIP-архивом' },
  ]).catch((e) => log(`[bot] команды не обновились: ${describeError(e)}`));
  await bot.start({
    allowed_updates: ['message', 'callback_query', 'widget_query'] as never,
    onStart: (me) => log(`[bot] @${me.username} запущен, песочница: ${cfg.sandbox ? 'да' : 'нет'}, Bot API: ${cfg.localApi ? 'свой сервер' : 'облачный'}`),
  });
}

/** Штатная остановка (выкладка): дописать карточки и сохранить задачи, чтобы продолжить после запуска. */
async function shutdown(sig: string): Promise<void> {
  if (stopping) return;
  stopping = true;
  log(`[bot] ${sig}: останавливаюсь`);
  const force = setTimeout(() => process.exit(0), 20_000);
  force.unref();
  await bot.stop().catch(() => undefined);
  await Promise.all([...jobs.values()].map((j) => j.card.flush())).catch(() => undefined);
  await store.saveNow();
  process.exit(0);
}

for (const sig of ['SIGINT', 'SIGTERM'] as const) process.once(sig, () => void shutdown(sig));

// Последняя сетка. Отклонённый промис без обработчика — пишем и живём дальше.
process.on('unhandledRejection', (reason) => log(`[process] необработанный отказ: ${reason instanceof Error ? reason.stack ?? reason.message : String(reason)}`));
// Непойманное исключение — состояние процесса неизвестно: сохраняем задачи и выходим,
// systemd перезапустит бота через 5 с, а начатые задачи продолжатся из jobs.json.
process.on('uncaughtException', (err) => {
  log(`[process] непойманное исключение: ${err.stack ?? err.message}`);
  void store.saveNow().finally(() => process.exit(1));
});

main().catch((e) => {
  log(`[bot] запуск не удался: ${describeError(e)}`);
  process.exit(1);
});
