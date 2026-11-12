import type { Api } from 'grammy';
import { CARD_HTML, caption, encodeState, statusLine, type CardState } from './widget.js';

/**
 * Карточка задачи в чате. Два вида с одним интерфейсом:
 *  - WidgetCard — живой виджет (sendWidget), кнопки внутри карточки;
 *  - TextCard — обычное сообщение с кнопками, если виджет не приняли.
 * Обновления карточки сжимаются: не чаще раза в 1,5 с, конечные состояния — сразу.
 */
export interface Card {
  readonly kind: 'widget' | 'text';
  readonly chatId: number;
  readonly messageId: number;
  update(state: CardState): void;
}

type Raw = Record<string, (payload: Record<string, unknown>) => Promise<unknown>>;

const MIN_GAP_MS = 1500;
const FINAL = new Set(['done', 'err', 'gone', 'ask']);

abstract class Throttled {
  private last = 0;
  private pending: CardState | null = null;
  private timer: NodeJS.Timeout | null = null;
  private chain: Promise<void> = Promise.resolve();

  update(state: CardState): void {
    this.pending = state;
    const wait = FINAL.has(state.s) ? 0 : Math.max(0, this.last + MIN_GAP_MS - Date.now());
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => this.flush(), wait);
  }

  private flush(): void {
    this.timer = null;
    const st = this.pending;
    this.pending = null;
    if (!st) return;
    this.last = Date.now();
    this.chain = this.chain.then(() => this.apply(st)).catch((e) => {
      const d = String((e as { description?: string }).description ?? e);
      if (!d.includes('not modified')) console.error(`[card] обновление не прошло: ${d.slice(0, 200)}`);
    });
  }

  protected abstract apply(state: CardState): Promise<void>;
}

class WidgetCard extends Throttled implements Card {
  readonly kind = 'widget' as const;
  constructor(private raw: Raw, readonly chatId: number, readonly messageId: number) { super(); }

  protected async apply(state: CardState): Promise<void> {
    await this.raw.editMessageWidgetData({ chat_id: this.chatId, message_id: this.messageId, chat_data: encodeState(state) });
    // Подпись видна в списке чатов и в клиентах без виджетов. Её меняем только на конечных состояниях,
    // чтобы не тратить лимит запросов на каждую страницу.
    if (FINAL.has(state.s)) {
      await this.raw.editMessageCaption({ chat_id: this.chatId, message_id: this.messageId, caption: caption(state) });
    }
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
  return `📄 ${state.n} (${state.z}${state.p ? `, ${state.p} стр.` : ''})\n${statusLine(state)}`;
}

class TextCard extends Throttled implements Card {
  readonly kind = 'text' as const;
  constructor(private api: Api, readonly chatId: number, readonly messageId: number) { super(); }

  protected async apply(state: CardState): Promise<void> {
    await this.api.editMessageText(this.chatId, this.messageId, text(state), { reply_markup: keyboard(state) });
  }
}

/** Отправить карточку: сначала виджетом, при отказе — текстом. */
export async function sendCard(api: Api, chatId: number, state: CardState): Promise<Card> {
  const raw = api.raw as unknown as Raw;
  try {
    const msg = (await raw.sendWidget({
      chat_id: chatId,
      html: CARD_HTML,
      chat_data: encodeState(state),
      caption: caption(state),
      allow_queries: true,
    })) as { message_id: number };
    return new WidgetCard(raw, chatId, msg.message_id);
  } catch (e) {
    const d = String((e as { description?: string }).description ?? e);
    console.error(`[card] виджет не принят, шлю текстом: ${d.slice(0, 200)}`);
    const msg = await api.sendMessage(chatId, text(state), { reply_markup: keyboard(state) });
    return new TextCard(api, chatId, msg.message_id);
  }
}

export async function answerWidgetQuery(api: Api, id: string, data: string): Promise<void> {
  const raw = api.raw as unknown as Raw;
  await raw.answerWidgetQuery({ widget_query_id: id, data }).catch(() => undefined);
}
