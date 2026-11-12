export interface Config {
  token: string;
  ownerId: number | null;
  workDir: string;
  /** Где лежит список задач (jobs.json), чтобы переживать перезапуск. */
  dataDir: string;
  maxFileBytes: number;
  ownerMaxFileBytes: number;
  /** Адрес Bot API. Свой сервер (--local) снимает предел 20 МБ: файлы до 2 ГБ. */
  apiRoot: string;
  /** true — свой сервер Bot API: файлы лежат на диске, а не скачиваются по ссылке. */
  localApi: boolean;
  /** Куда свой сервер кладёт файлы: путь внутри контейнера и тот же каталог на сервере. */
  botapiDirContainer: string;
  botapiDirHost: string;
  maxPages: number;
  ownerMaxPages: number;
  convertTimeoutSec: number;
  sandbox: boolean;
}

function int(value: string | undefined, fallback: number, min: number, max: number): number {
  const n = Number.parseInt(value ?? '', 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

export const CLOUD_API = 'https://api.telegram.org';

/** Предел размера файла в байтах. Облачный Bot API скачивает боту не больше 20 МБ, свой сервер — до 2000 МБ. */
function mb(value: string | undefined, fallback: number, local: boolean): number {
  const cap = local ? 2000 : 20;
  return int(value, Math.min(fallback, cap), 1, cap) * 1024 * 1024;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const token = env.BOT_TOKEN?.trim();
  if (!token) throw new Error('BOT_TOKEN не задан');
  const owner = Number.parseInt(env.OWNER_ID ?? '', 10);
  const apiRoot = (env.BOT_API_ROOT?.trim() || CLOUD_API).replace(/\/+$/, '');
  const local = apiRoot !== CLOUD_API;
  return {
    token,
    ownerId: Number.isFinite(owner) ? owner : null,
    workDir: env.WORK_DIR?.trim() || '/var/lib/pngify/jobs',
    dataDir: env.DATA_DIR?.trim() || '/var/lib/pngify/data',
    maxFileBytes: mb(env.MAX_FILE_MB, 200, local),
    ownerMaxFileBytes: mb(env.OWNER_MAX_FILE_MB, 2000, local),
    apiRoot,
    localApi: local,
    botapiDirContainer: env.BOTAPI_DIR_CONTAINER?.trim() || '/var/lib/telegram-bot-api',
    botapiDirHost: env.BOTAPI_DIR_HOST?.trim() || '/var/lib/pngify/botapi',
    maxPages: int(env.MAX_PAGES, 60, 1, 1000),
    ownerMaxPages: int(env.OWNER_MAX_PAGES, 500, 1, 5000),
    convertTimeoutSec: int(env.CONVERT_TIMEOUT_SEC, 120, 10, 900),
    sandbox: env.SANDBOX !== '0',
  };
}
