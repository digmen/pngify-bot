import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { CardKind } from './cards.js';
import type { CardState, Mode } from './widget.js';

/**
 * Задачи на диске, чтобы перезапуск или падение бота ничего не теряли:
 * карточки, где ещё не нажали кнопку, остаются рабочими, а начатые задачи
 * ставятся в очередь заново. Хранятся только ссылки Telegram на файлы (file_id),
 * сами документы на диск до начала работы не попадают.
 */
export interface SavedJob {
  id: string;
  userId: number;
  chatId: number;
  messageId: number;
  cardKind: CardKind;
  fileId: string;
  fileName: string;
  ext: string;
  size: number;
  state: CardState;
  createdAt: number;
  started: boolean;
  mode?: Mode;
  h?: 0 | 1;
  /** Сколько раз задача начиналась и не закончилась из-за падения бота. */
  crashes: number;
  /** Задача шла прямо сейчас (не просто ждала в очереди). */
  running?: boolean;
  /** true — бот останавливали штатно (выкладка), это не падение. */
  interrupted?: boolean;
}

export class JobStore {
  private timer: NodeJS.Timeout | null = null;
  private writing: Promise<void> = Promise.resolve();

  constructor(private file: string, private snapshot: () => SavedJob[]) {}

  async load(): Promise<SavedJob[]> {
    try {
      const data = JSON.parse(await readFile(this.file, 'utf8')) as unknown;
      return Array.isArray(data) ? (data as SavedJob[]).filter(isValid) : [];
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') console.error(`[store] не прочитал ${this.file}, начинаю с пустого: ${String(e)}`);
      return [];
    }
  }

  /** Сохранить чуть позже: десяток изменений подряд — одна запись на диск. */
  save(): void {
    if (this.timer) return;
    this.timer = setTimeout(() => { this.timer = null; void this.saveNow(); }, 500);
  }

  /** Сохранить сразу: временный файл и переименование, чтобы при сбое не остался обрывок JSON. */
  async saveNow(): Promise<void> {
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    const json = JSON.stringify(this.snapshot());
    this.writing = this.writing.then(async () => {
      await mkdir(path.dirname(this.file), { recursive: true, mode: 0o700 });
      const tmp = `${this.file}.tmp`;
      await writeFile(tmp, json, { mode: 0o600 });
      await rename(tmp, this.file);
    }).catch((e) => console.error(`[store] не сохранил задачи: ${String(e)}`));
    await this.writing;
  }
}

function isValid(j: unknown): j is SavedJob {
  const x = j as SavedJob;
  return !!x && typeof x.id === 'string' && typeof x.chatId === 'number' && typeof x.messageId === 'number'
    && typeof x.fileId === 'string' && typeof x.ext === 'string' && !!x.state && typeof x.state.s === 'string';
}

export const MAX_CRASHES = 2;

/** Что делать с задачей после запуска бота. */
export function recoveryAction(j: SavedJob, now: number, ttlMs: number): 'keep' | 'resume' | 'fail' | 'drop' {
  if (!j.started) return now - j.createdAt > ttlMs ? 'drop' : 'keep';
  if (!j.mode) return 'drop';
  const crashes = j.crashes + (j.running && !j.interrupted ? 1 : 0);
  return crashes >= MAX_CRASHES ? 'fail' : 'resume';
}
