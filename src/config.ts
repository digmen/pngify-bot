export interface Config {
  token: string;
  ownerId: number | null;
  workDir: string;
  maxFileBytes: number;
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

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const token = env.BOT_TOKEN?.trim();
  if (!token) throw new Error('BOT_TOKEN не задан');
  const owner = Number.parseInt(env.OWNER_ID ?? '', 10);
  return {
    token,
    ownerId: Number.isFinite(owner) ? owner : null,
    workDir: env.WORK_DIR?.trim() || '/var/lib/pngify/jobs',
    // Обычный Bot API отдаёт боту файлы только до 20 МБ.
    maxFileBytes: int(env.MAX_FILE_MB, 20, 1, 20) * 1024 * 1024,
    maxPages: int(env.MAX_PAGES, 60, 1, 1000),
    ownerMaxPages: int(env.OWNER_MAX_PAGES, 500, 1, 5000),
    convertTimeoutSec: int(env.CONVERT_TIMEOUT_SEC, 120, 10, 900),
    sandbox: env.SANDBOX !== '0',
  };
}
