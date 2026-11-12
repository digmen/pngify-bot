/**
 * Карточка файла — HTML-виджет Telegram (sendWidget, Bot API 10.4).
 * Код карточки неизменен после отправки, меняется только состояние (chat_data),
 * его пишет бот через editMessageWidgetData. Пределы Telegram: HTML до 32768 байт
 * и до 4096 байт после zlib 9 (проверяет widget.test.ts), состояние до 1024 байт.
 * Сети в виджете нет: картинки в карточку не кладём, они приходят отдельными файлами.
 */

export type Stage = 'ask' | 'queue' | 'load' | 'conv' | 'render' | 'stream' | 'pack' | 'send' | 'done' | 'err' | 'gone';
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
  load: 'Скачиваю файл',
  conv: 'Открываю документ',
  render: 'Рисую страницы',
  stream: 'Рисую и отправляю',
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
    case 'stream': return `Рисую и отправляю${pages}`;
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

/**
 * Процент для полосы прогресса или null, если конец заранее не известен (очередь, скачивание,
 * открытие документа, отправка архива): тогда полоска «бежит». Рисование 10–80%, упаковка 85%, отправка до 100%.
 */
export function progress(st: CardState): number | null {
  const frac = st.p ? Math.min(1, (st.i ?? 0) / st.p) : 0;
  switch (st.s) {
    case 'render': return Math.round(10 + 70 * frac);
    // «Картинками»: страница рисуется и сразу уходит, поэтому одна полоска на обе работы.
    case 'stream': return Math.round(10 + 90 * frac);
    case 'pack': return 85;
    case 'send': return st.m === 'zip' ? null : Math.round(85 + 15 * frac);
    case 'done': return 100;
    case 'queue': case 'load': case 'conv': return null;
    default: return 0;
  }
}

/** Полоска для текстовой карточки: «▰▰▰▰▱▱▱▱▱▱ 40%». */
export function textBar(st: CardState): string {
  const pct = progress(st);
  if (pct === null) return '▰▱▰▱▰▱▰▱▰▱';
  const full = Math.floor(pct / 10); // вниз: полоска не обгоняет реальный ход
  return `${'▰'.repeat(full)}${'▱'.repeat(10 - full)} ${pct}%`;
}

export const CARD_HTML = String.raw`<style>
body{margin:0;padding:12px 12px calc(12px + env(safe-area-inset-bottom))}
.h{display:flex;gap:10px;align-items:center}
.i{flex:none;width:40px;height:40px;border-radius:11px;background:var(--tg-theme-button-color);color:var(--tg-theme-button-text-color);display:flex;align-items:center;justify-content:center;font:700 11px system-ui,sans-serif}
.w{min-width:0}
.n{font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.m{color:var(--tg-theme-hint-color);font-size:.85em}
.g{display:flex;margin:12px 0 8px;background:var(--tg-theme-secondary-bg-color);border-radius:9px;padding:2px}
.g button{flex:1;background:none;color:var(--tg-theme-text-color);border-radius:7px;padding:6px;font-size:.9em}
.g .on{background:var(--tg-theme-bg-color);font-weight:600}
.r{display:flex;gap:8px}.r button{flex:1}
.t{display:flex;justify-content:space-between;align-items:baseline;margin-top:14px;font-size:.92em}
.t b{font-variant-numeric:tabular-nums}
.b{position:relative;height:10px;border-radius:5px;background:var(--tg-theme-secondary-bg-color);margin:7px 0 6px;overflow:hidden}
.b i{position:absolute;left:0;top:0;bottom:0;border-radius:5px;background:var(--tg-theme-button-color);transition:width .5s ease}
.b.u i{width:35%;animation:k 1.3s ease-in-out infinite}
@keyframes k{from{transform:translateX(-110%)}to{transform:translateX(300%)}}
@media (prefers-reduced-motion:reduce){.b.u i{animation:none;left:32%}}
.ok{color:var(--tg-theme-accent-text-color);font-weight:600}
.er{color:var(--tg-theme-destructive-text-color);margin-top:12px}
</style>
<div class="h"><div class="i" id="x"></div><div class="w"><div class="n" id="n"></div><div class="m" id="m"></div></div></div>
<div id="b"></div>
<script>
var W=window.TelegramWidget||{},B=document.getElementById('b'),hq=0,busy=0,note='';
var NOTE={gone:'Файл устарел, пришли его ещё раз',busy:'Этот файл уже в работе',many:'Дождись, пока закончатся прошлые файлы',full:'Очередь переполнена, попробуй через минуту'};
try{hq=+localStorage.getItem('hq')||0}catch(e){}
function S(){try{return JSON.parse(W.chatData)||{}}catch(e){return{}}}
function el(t,c,x,p){var e=document.createElement(t);if(c)e.className=c;if(x!=null)e.textContent=x;(p||B).appendChild(e);return e}
function pl(n,a,b,c){var x=n%100,y=x%10;return x>10&&x<20?c:y==1?a:y>1&&y<5?b:c}
function go(m){if(busy)return;busy=1;note='Отправляю…';R();
W.request('go:'+m+':'+hq).then(function(a){busy=0;note=NOTE[a&&a.result]||'';R()},
function(e){busy=0;note=e&&e.code==='RATE_LIMITED'?'Слишком часто, подожди пару секунд':'Не вышло'+(e&&e.code?' ('+e.code+')':'')+', нажми ещё раз';R()})}
function bar(pc,lab,sub){var t=el('div','t');el('span','',lab,t);el('b','',pc==null?'':pc+'%',t);
var b=el('div','b'+(pc==null?' u':''));el('i','',null,b).style.width=pc==null?'':pc+'%';if(sub)el('div','m',sub)}
function R(){var s=S(),st=s.s||'ask',p=s.p||0,k=s.i||0,f=p?Math.min(1,k/p):0,q=s.h?'чёткое':'';
document.getElementById('x').textContent=(s.x||'file').slice(0,4).toUpperCase();
document.getElementById('n').textContent=s.n||'Файл';
document.getElementById('m').textContent=[s.z,p?p+' стр.':''].filter(Boolean).join(' · ');
B.textContent='';
if(st==='ask'){var g=el('div','g');['Обычное','Чёткое'].forEach(function(t,j){var b=el('button',hq===j?'on':'',t,g);b.onclick=function(){hq=j;try{localStorage.setItem('hq',j)}catch(e){}R()}});
var r=el('div','r');[['Картинками','png'],['ZIP-архивом','zip']].forEach(function(a){var b=el('button','',a[0],r);b.disabled=!!busy;b.onclick=function(){go(a[1])}});
if(note)el('div','m',note).style.marginTop='8px';return}
if(st==='err'||st==='gone'){el('div','er',st==='gone'?NOTE.gone:(s.e||'Что-то пошло не так'));return}
if(st==='done'){bar(100,'✓ Готово',(p?p+' '+(s.m==='zip'?pl(p,'страница','страницы','страниц')+' в архиве':pl(p,'картинка','картинки','картинок')):'')+(s.t?' · за '+s.t+' с':''));B.querySelector('.t span').className='ok';return}
var L={queue:'В очереди'+(s.q?' · ты '+s.q+'-й':''),load:'Скачиваю файл',conv:'Открываю документ',render:'Рисую страницы',stream:'Рисую и отправляю',pack:'Упаковываю ZIP',send:s.m==='zip'?'Отправляю архив':'Отправляю картинки'};
var pc={render:Math.round(10+70*f),stream:Math.round(10+90*f),pack:85,send:s.m==='zip'?null:Math.round(85+15*f)}[st];
bar(pc==null?null:pc,L[st]||'',[(st==='render'||st==='stream'||st==='send'&&s.m!=='zip')&&p?k+' из '+p:'',q].filter(Boolean).join(' · '))}
if(W.onEvent)W.onEvent('chatDataChanged',R);R();if(W.ready)W.ready();
</script>`;
