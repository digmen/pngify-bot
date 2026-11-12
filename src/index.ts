import { copyFile, link, mkdir, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { Bot, InputFile, InputMediaBuilder, type Api } from 'grammy';
import { loadConfig } from './config.js';
import { SUPPORTED_HINT, detectKind, humanSize, pngName, safeBaseName } from './formats.js';
import { ConvertError, makeZip, pageCount, renderPage, toPdf, type RunOptions } from './convert.js';
import { SerialQueue } from './queue.js';
import { answerWidgetQuery, sendCard, type Card } from './cards.js';
import { dpiOf, parseGo, type CardState, type Mode } from './widget.js';

try { process.loadEnvFile(); } catch { /* .env не обязателен: на сервере переменные даёт systemd */ }
const cfg = loadConfig();
const bot = new Bot(cfg.token, { client: { apiRoot: cfg.apiRoot } });
const queue = new SerialQueue();

/** Файл, присланный пользователем. Скачивается только когда дошла очередь, до этого на диске ничего нет. */
interface Job {
  id: string;
  userId: number;
  chatId: number;
  fileId: string;
  fileName: string;
  ext: string;
  size: number;
  card: Card;
  state: CardState;
  createdAt: number;
  started: boolean;
}

const JOB_TTL_MS = 24 * 3600_000;
// Облачный Bot API принимает от бота файлы до 50 МБ, свой сервер — до 2000 МБ.
const UPLOAD_MAX_BYTES = (cfg.localApi ? 2000 : 49) * 1024 * 1024;
const mbOf = (bytes: number) => Math.round(bytes / 1024 / 1024);
const jobsByMessage = new Map<string, Job>();
const lastJobOfUser = new Map<number, Job>();
const stats = { files: 0, done: 0, errors: 0, pages: 0, since: new Date().toISOString() };

const key = (chatId: number, messageId: number) => `${chatId}:${messageId}`;
const isOwner = (userId: number | undefined) => cfg.ownerId !== null && userId === cfg.ownerId;

function setState(job: Job, patch: Partial<CardState>): void {
  job.state = { ...job.state, ...patch };
  job.card.update(job.state);
}

// Старые карточки забываем раз в час: файлов на диске у них нет, держим только ссылку Telegram.
setInterval(() => {
  const now = Date.now();
  for (const [k, job] of jobsByMessage) {
    if (!job.started && now - job.createdAt > JOB_TTL_MS) {
      jobsByMessage.delete(k);
      if (lastJobOfUser.get(job.userId) === job) lastJobOfUser.delete(job.userId);
    }
  }
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
  await ctx.reply(
    `С ${stats.since.slice(0, 16).replace('T', ' ')} UTC:\nфайлов ${stats.files}, готово ${stats.done}, ошибок ${stats.errors}, страниц ${stats.pages}\nв очереди сейчас ${queue.size}`,
  );
});

bot.on('message:document', async (ctx) => {
  const doc = ctx.message.document;
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
  const job: Job = {
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
  };
  jobsByMessage.set(key(card.chatId, card.messageId), job);
  lastJobOfUser.set(job.userId, job);
});

bot.on(['message:photo', 'message:video'], (ctx) => ctx.reply('Пришли документ файлом (скрепка → Файл), а не фото или видео.'));

/** Запуск задачи по выбору пользователя. Возвращает ответ для карточки. */
function start(job: Job | undefined, mode: Mode, h: 0 | 1): 'ok' | 'gone' | 'busy' {
  if (!job) return 'gone';
  if (job.started) return 'busy';
  job.started = true;
  setState(job, { s: 'queue', m: mode, h });
  queue.push({
    id: job.id,
    onPosition: (q) => setState(job, { s: 'queue', q }),
    run: () => processJob(job, mode, h),
  });
  return 'ok';
}

for (const [cmd, mode] of [['png', 'png'], ['zip', 'zip']] as const) {
  bot.command(cmd, async (ctx) => {
    const job = ctx.from ? lastJobOfUser.get(ctx.from.id) : undefined;
    const res = start(job, mode, 0);
    if (res === 'gone') await ctx.reply('Сначала пришли файл.');
    if (res === 'busy') await ctx.reply('Этот файл уже в работе. Пришли его ещё раз, если нужен другой вариант.');
  });
}

// Кнопки текстовой карточки (клиенты без виджетов).
bot.on('callback_query:data', async (ctx) => {
  const go = parseGo(ctx.callbackQuery.data);
  const msg = ctx.callbackQuery.message;
  if (!go || !msg) return ctx.answerCallbackQuery();
  const res = start(jobsByMessage.get(key(msg.chat.id, msg.message_id)), go.mode, go.h);
  await ctx.answerCallbackQuery(res === 'gone' ? { text: 'Файл устарел, пришли его ещё раз' } : undefined);
});

// Запросы из виджета: update.widget_query (Bot API 10.4). У grammY пока нет типа — читаем вручную.
bot.use(async (ctx, next) => {
  const q = (ctx.update as { widget_query?: { id: string; data: string; from: { id: number }; chat?: { id: number }; message_id?: number } }).widget_query;
  if (!q) return next();
  const go = parseGo(q.data);
  const job = q.chat && q.message_id ? jobsByMessage.get(key(q.chat.id, q.message_id)) : undefined;
  const res = go && job && job.userId === q.from.id ? start(job, go.mode, go.h) : 'gone';
  await answerWidgetQuery(ctx.api, q.id, res);
});

async function download(api: Api, job: Job, dir: string): Promise<string> {
  const file = await api.getFile(job.fileId);
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
  const res = await fetch(`https://api.telegram.org/file/bot${cfg.token}/${file.file_path}`);
  if (!res.ok) throw new ConvertError(`скачивание: ${res.status}`, 'Не получилось скачать файл. Пришли его ещё раз.');
  await writeFile(input, Buffer.from(await res.arrayBuffer()));
  return input;
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

async function processJob(job: Job, mode: Mode, h: 0 | 1): Promise<void> {
  const t0 = Date.now();
  const dir = path.join(cfg.workDir, job.id);
  const opts: RunOptions = { jobDir: dir, timeoutSec: cfg.convertTimeoutSec, sandbox: cfg.sandbox };
  try {
    await mkdir(dir, { recursive: true, mode: 0o700 });
    setState(job, { s: 'conv', q: undefined });
    const input = await download(bot.api, job, dir);
    const pdf = await toPdf(input, opts);
    const total = await pageCount(pdf, opts);
    const limit = isOwner(job.userId) ? cfg.ownerMaxPages : cfg.maxPages;
    if (total === 0) throw new ConvertError('0 страниц', 'В файле нет страниц.');
    if (total > limit) throw new ConvertError(`${total} > ${limit}`, `В файле ${total} страниц, а можно до ${limit}. Раздели файл на части.`);

    const base = safeBaseName(job.fileName);
    const files: string[] = [];
    const names: string[] = [];
    setState(job, { s: 'render', p: total, i: 0 });
    for (let page = 1; page <= total; page++) {
      const name = pngName(base, page, total);
      files.push(await renderPage(pdf, page, dpiOf(h), path.join(dir, `p${page}`), opts));
      names.push(name);
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
        setState(job, { i: total });
      } else {
        await bot.api.sendMessage(job.chatId, `Архив вышел больше ${mbOf(UPLOAD_MAX_BYTES)} МБ — Telegram такой не пропустит. Шлю картинками.`);
        setState(job, { s: 'send', i: 0 });
        await sendPngs(job, files, names);
      }
    } else {
      setState(job, { s: 'send', i: 0 });
      await sendPngs(job, files, names);
    }
    stats.done++;
    stats.pages += total;
    setState(job, { s: 'done', i: total, t: Math.max(1, Math.round((Date.now() - t0) / 1000)) });
  } catch (e) {
    stats.errors++;
    const userMessage = e instanceof ConvertError ? e.userMessage : 'Что-то пошло не так. Попробуй ещё раз.';
    console.error(`[job ${job.id}] ${job.ext} ${job.size}B: ${e instanceof Error ? e.message : String(e)}`.replaceAll(cfg.token, '<token>'));
    setState(job, { s: 'err', e: userMessage });
  } finally {
    await rm(dir, { recursive: true, force: true });
    jobsByMessage.delete(key(job.card.chatId, job.card.messageId));
    if (lastJobOfUser.get(job.userId) === job) lastJobOfUser.delete(job.userId);
  }
}

bot.catch((err) => console.error(`[bot] ${String(err.error).replaceAll(cfg.token, '<token>').slice(0, 300)}`));

async function main(): Promise<void> {
  // Остатки прошлого запуска (бот упал посреди задачи) — чистим.
  await mkdir(cfg.workDir, { recursive: true, mode: 0o700 });
  for (const d of await readdir(cfg.workDir)) await rm(path.join(cfg.workDir, d), { recursive: true, force: true });
  await bot.api.setMyCommands([
    { command: 'start', description: 'Что умеет бот' },
    { command: 'png', description: 'Последний файл — картинками' },
    { command: 'zip', description: 'Последний файл — ZIP-архивом' },
  ]);
  await bot.start({
    allowed_updates: ['message', 'callback_query', 'widget_query'] as never,
    onStart: (me) => console.log(`[bot] @${me.username} запущен, песочница: ${cfg.sandbox ? 'да' : 'нет'}, Bot API: ${cfg.localApi ? 'свой сервер' : 'облачный'}`),
  });
}

for (const sig of ['SIGINT', 'SIGTERM'] as const) process.once(sig, () => void bot.stop());
void main();
