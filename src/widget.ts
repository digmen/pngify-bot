/**
 * Карточка файла — HTML-виджет Telegram (sendWidget, Bot API 10.4).
 * Код карточки неизменен после отправки, меняется только состояние (chat_data),
 * его пишет бот через editMessageWidgetData. Пределы Telegram: HTML до 32768 байт
 * и до 4096 байт после zlib 9 (проверяет widget.test.ts), состояние до 1024 байт.
 * Сети в виджете нет: картинки в карточку не кладём, они приходят отдельными файлами.
 */

export type Stage = 'ask' | 'queue' | 'conv' | 'render' | 'pack' | 'send' | 'done' | 'err' | 'gone';
export type Mode = 'png' | 'zip';

export interface CardState {
  s: Stage;
  /** Имя файла. */
  n: string;
  /** Расширение — значок карточки. */
  x: string;
  /** Размер, человеческим текстом. */
  z: string;
  /** Страниц всего (0 — ещё не знаем). */
  p?: number;
  /** Сколько готово (нарисовано или отправлено). */
  i?: number;
  /** Место в очереди. */
  q?: number;
  m?: Mode;
  /** 1 — «чёткое» качество. */
  h?: 0 | 1;
  /** Текст ошибки. */
  e?: string;
  /** Секунд на всю работу. */
  t?: number;
}

const MAX_STATE_BYTES = 1024;

/** JSON состояния, гарантированно не длиннее 1024 байт: при нужде укорачивает имя и ошибку. */
export function encodeState(state: CardState): string {
  const st = { ...state };
  let json = JSON.stringify(st);
  for (let len = 60; Buffer.byteLength(json) > MAX_STATE_BYTES && len >= 0; len -= 10) {
    st.n = st.n.length > len ? `${st.n.slice(0, Math.max(len - 1, 0))}…` : st.n;
    if (st.e && st.e.length > len * 2) st.e = `${st.e.slice(0, len * 2)}…`;
    json = JSON.stringify(st);
  }
  return json;
}

export const QUALITY_DPI = { normal: 150, sharp: 300 } as const;

export function dpiOf(h: 0 | 1 | undefined): number {
  return h ? QUALITY_DPI.sharp : QUALITY_DPI.normal;
}

/** Данные запроса из карточки/кнопки: «go:png:0», «go:zip:1». Не больше 64 байт. */
export function parseGo(data: string): { mode: Mode; h: 0 | 1 } | null {
  const m = /^go:(png|zip):([01])$/.exec(data);
  return m ? { mode: m[1] as Mode, h: m[2] === '1' ? 1 : 0 } : null;
}

/** 1 картинка, 2 картинки, 5 картинок. */
export function plural(n: number, one: string, few: string, many: string): string {
  const a = Math.abs(n) % 100, b = a % 10;
  if (a > 10 && a < 20) return many;
  if (b === 1) return one;
  if (b >= 2 && b <= 4) return few;
  return many;
}

const STAGE_TEXT: Record<Stage, string> = {
  ask: 'Выбери, как прислать',
  queue: 'В очереди',
  conv: 'Открываю документ',
  render: 'Рисую страницы',
  pack: 'Упаковываю ZIP',
  send: 'Отправляю',
  done: 'Готово',
  err: 'Ошибка',
  gone: 'Файл устарел, пришли его ещё раз',
};

/** Строка статуса для подписи и для текстовой карточки (клиенты без виджетов). */
export function statusLine(st: CardState): string {
  const pages = st.p ? ` ${st.i ?? 0}/${st.p}` : '';
  switch (st.s) {
    case 'queue': return st.q ? `В очереди: ты ${st.q}-й` : 'В очереди';
    case 'render': return `Рисую страницы${pages}`;
    case 'send': return `Отправляю${pages}`;
    case 'done': {
      const n = st.p ?? 0;
      const what = st.m === 'zip' ? `${plural(n, 'страница', 'страницы', 'страниц')} в архиве` : plural(n, 'картинка', 'картинки', 'картинок');
      return `Готово: ${n} ${what}${st.t ? ` за ${st.t} с` : ''}`;
    }
    case 'err': return `Ошибка: ${st.e ?? 'что-то пошло не так'}`;
    default: return STAGE_TEXT[st.s];
  }
}

export function caption(st: CardState): string {
  return `${st.n} — ${statusLine(st)}`;
}

/** Процент для полосы прогресса: открытие ~10%, рисование до 80%, упаковка 85%, отправка до 100%. */
export function progress(st: CardState): number {
  const frac = st.p ? Math.min(1, (st.i ?? 0) / st.p) : 0;
  switch (st.s) {
    case 'conv': return 8;
    case 'render': return Math.round(10 + 70 * frac);
    case 'pack': return 85;
    case 'send': return Math.round(85 + 15 * frac);
    case 'done': return 100;
    default: return 0;
  }
}

export const CARD_HTML = String.raw`<style>
body{margin:0;padding:10px 12px 12px}
.h{display:flex;gap:10px;align-items:center}
.i{flex:none;width:38px;height:38px;border-radius:10px;background:var(--tg-theme-button-color);color:var(--tg-theme-button-text-color);display:flex;align-items:center;justify-content:center;font:700 11px system-ui,sans-serif}
.w{min-width:0}
.n{font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.m{color:var(--tg-theme-hint-color);font-size:.85em}
.g{display:flex;margin:12px 0 8px;background:var(--tg-theme-secondary-bg-color);border-radius:9px;padding:2px}
.g button{flex:1;background:none;color:var(--tg-theme-text-color);border-radius:7px;padding:6px;font-size:.9em}
.g .on{background:var(--tg-theme-bg-color);font-weight:600}
.r{display:flex;gap:8px}.r button{flex:1}
.b{height:6px;border-radius:3px;background:var(--tg-theme-secondary-bg-color);margin:12px 0 6px;overflow:hidden}
.b i{display:block;height:100%;background:var(--tg-theme-button-color);transition:width .4s}
.ok{color:var(--tg-theme-accent-text-color);font-weight:600}
.er{color:var(--tg-theme-destructive-text-color)}
</style>
<div class="h"><div class="i" id="x"></div><div class="w"><div class="n" id="n"></div><div class="m" id="m"></div></div></div>
<div id="b"></div>
<script>
var W=window.TelegramWidget||{},B=document.getElementById('b'),hq=0,busy=0,note='';
try{hq=+localStorage.getItem('hq')||0}catch(e){}
function S(){try{return JSON.parse(W.chatData)||{}}catch(e){return{}}}
function el(t,c,x){var e=document.createElement(t);if(c)e.className=c;if(x!=null)e.textContent=x;B.appendChild(e);return e}
function go(m){if(busy)return;busy=1;note='Отправляю…';R();
W.request('go:'+m+':'+hq).then(function(a){busy=0;note=a&&a.result==='gone'?'Файл устарел, пришли его ещё раз':'';R()},
function(e){busy=0;note=e&&e.code==='RATE_LIMITED'?'Слишком часто, подожди пару секунд':'Не вышло'+(e&&e.code?' ('+e.code+')':'')+', нажми ещё раз';R()})}
function R(){var s=S(),st=s.s||'ask',p=s.p||0,k=s.i||0;
document.getElementById('x').textContent=(s.x||'file').slice(0,4).toUpperCase();
document.getElementById('n').textContent=s.n||'Файл';
document.getElementById('m').textContent=[s.z,p?p+' стр.':''].filter(Boolean).join(' · ');
B.textContent='';
if(st==='ask'){var g=el('div','g');['Обычное','Чёткое'].forEach(function(t,j){var b=document.createElement('button');b.textContent=t;if(hq===j)b.className='on';b.onclick=function(){hq=j;try{localStorage.setItem('hq',j)}catch(e){}R()};g.appendChild(b)});
var r=el('div','r');[['Картинками','png'],['ZIP-архивом','zip']].forEach(function(a){var b=document.createElement('button');b.textContent=a[0];b.disabled=!!busy;b.onclick=function(){go(a[1])};r.appendChild(b)});
if(note)el('div','m',note).style.marginTop='6px';return}
function pl(n,a,b,c){var x=n%100,y=x%10;return x>10&&x<20?c:y==1?a:y>1&&y<5?b:c}
var f=p?Math.min(1,k/p):0,pc={conv:8,render:10+70*f,pack:85,send:85+15*f,done:100}[st]||0;
if(st==='done'){el('div','ok',(p?'Готово: '+p+' '+(s.m==='zip'?pl(p,'страница','страницы','страниц')+' в архиве':pl(p,'картинка','картинки','картинок')):'Готово')+(s.t?' за '+s.t+' с':'')).style.marginTop='10px';return}
if(st==='err'||st==='gone'){el('div','er',st==='gone'?'Файл устарел, пришли его ещё раз':(s.e||'Что-то пошло не так')).style.marginTop='10px';return}
el('div','b').appendChild(document.createElement('i')).style.width=Math.round(pc)+'%';
var L={queue:'В очереди'+(s.q?': ты '+s.q+'-й':''),conv:'Открываю документ…',render:'Рисую страницы',pack:'Упаковываю ZIP…',send:'Отправляю'};
el('div','m',(L[st]||'')+((st==='render'||st==='send')&&p?' '+k+' из '+p:'')+(s.h?' · чёткое':''))}
if(W.onEvent)W.onEvent('chatDataChanged',R);R();if(W.ready)W.ready();
</script>`;
