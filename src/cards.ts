import { GrammyError, type Api } from 'grammy';
import { CARD_HTML, encodeState, statusLine, textBar, type CardState } from './widget.js';

/**
 * Карточка задачи в чате. Два вида с одним интерфейсом:
 *  - WidgetCard — живой виджет (sendWidget), кнопки и полоска прогресса внутри карточки, без подписи снизу;
 *  - TextCard — обычное сообщение с кнопками, если виджет не приняли.
 * Обновления карточки сжимаются: не чаще раза в 1,5 с, конечные состояния — сразу.
 * Ошибка обновления никогда не роняет задачу: карточка — витрина, а не часть работы.
 */
export type CardKind = 'widget' | 'text';

export interface Card {
  readonly kind: CardKind;
  readonly chatId: number;
  readonly messageId: number;
  update(state: CardState): void;
  /** Дождаться, пока уйдут все обновления (перед остановкой бота). */
  flush(): Promise<void>;
}

type Raw = Record<string, (payload: Record<string, unknown>) => Promise<unknown>>;

const MIN_GAP_MS = 1500;
const FINAL = new Set(['done', 'err', 'gone', 'ask']);

export function describeError(e: unknown): string {
  if (e instanceof GrammyError) return `${e.error_code} ${e.description}`;
  return e instanceof Error ? e.message : String(e);
}

abstract class Throttled {
  private last = 0;
  private pending: CardState | null = null;
  private timer: NodeJS.Timeout | null = null;
  private chain: Promise<void> = Promise.resolve();
  /** Пользователь заблокировал бота или удалил карточку — дальше не пытаемся. */
  private dead = false;

  update(state: CardState): void {
    if (this.dead) return;
    this.pending = state;
    const wait = FINAL.has(state.s) ? 0 : Math.max(0, this.last + MIN_GAP_MS - Date.now());
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => this.send(), wait);
  }

  async flush(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer);
      this.send();
    }
    await this.chain;
  }

  private send(): void {
    this.timer = null;
    const st = this.pending;
    this.pending = null;
    if (!st || this.dead) return;
    this.last = Date.now();
    this.chain = this.chain
      .then(() => this.apply(st))
      .catch((e) => {
        const d = describeError(e);
        if (d.includes('not modified')) return;
        if (e instanceof GrammyError && (e.error_code === 403 || d.includes('message to edit not found'))) this.dead = true;
        console.error(`[card] обновление не прошло: ${d.slice(0, 200)}`);
      });
  }

  protected abstract apply(state: CardState): Promise<void>;
}

class WidgetCard extends Throttled implements Card {
  readonly kind = 'widget' as const;
  constructor(private raw: Raw, readonly chatId: number, readonly messageId: number) { super(); }

  protected async apply(state: CardState): Promise<void> {
    await this.raw.editMessageWidgetData({ chat_id: this.chatId, message_id: this.messageId, chat_data: encodeState(state) });
  }
}

function keyboard(state: CardState) {
  if (state.s !== 'ask') return undefined;
  return {
    inline_keyboard: [
      [{ text: 'Картинками', callback_data: 'go:png:0' }, { text: 'ZIP-архивом', callback_data: 'go:zip:0' }],
      [{ text: 'Чёткие картинками', callback_data: 'go:png:1' }, { text: 'Чёткий ZIP', callback_data: 'go:zip:1' }],
    ],
  };
}

function text(state: CardState): string {
  const head = `📄 ${state.n} (${state.z}${state.p ? `, ${state.p} стр.` : ''})`;
  const showBar = !['ask', 'err', 'gone'].includes(state.s);
  return `${head}\n${showBar ? `${textBar(state)}\n` : ''}${statusLine(state)}`;
}

class TextCard extends Throttled implements Card {
  readonly kind = 'text' as const;
  constructor(private api: Api, readonly chatId: number, readonly messageId: number) { super(); }

  protected async apply(state: CardState): Promise<void> {
    await this.api.editMessageText(this.chatId, this.messageId, text(state), { reply_markup: keyboard(state) });
  }
}

/** Карточка уже отправленного сообщения — после перезапуска бота. */
export function restoreCard(api: Api, kind: CardKind, chatId: number, messageId: number): Card {
  return kind === 'widget'
    ? new WidgetCard(api.raw as unknown as Raw, chatId, messageId)
    : new TextCard(api, chatId, messageId);
}

/**
 * Отправить карточку: сначала виджетом (без подписи — только карточка), при отказе — текстом.
 * 403 (бот заблокирован) не переводим в текст: он не пройдёт тоже.
 */
export async function sendCard(api: Api, chatId: number, state: CardState): Promise<Card> {
  const raw = api.raw as unknown as Raw;
  try {
    const msg = (await raw.sendWidget({
      chat_id: chatId,
      html: CARD_HTML,
      chat_data: encodeState(state),
      allow_queries: true,
    })) as { message_id: number };
    return new WidgetCard(raw, chatId, msg.message_id);
  } catch (e) {
    if (e instanceof GrammyError && e.error_code === 403) throw e;
    console.error(`[card] виджет не принят, шлю текстом: ${describeError(e).slice(0, 200)}`);
    const msg = await api.sendMessage(chatId, text(state), { reply_markup: keyboard(state) });
    return new TextCard(api, chatId, msg.message_id);
  }
}

/** Ответ виджету. Не дольше 15 с после запроса, иначе Telegram его не примет — ошибку просто пишем в журнал. */
export async function answerWidgetQuery(api: Api, id: string, data: string): Promise<void> {
  const raw = api.raw as unknown as Raw;
  await raw.answerWidgetQuery({ widget_query_id: id, data }).catch((e) => console.error(`[widget] ответ не ушёл: ${describeError(e).slice(0, 200)}`));
}
