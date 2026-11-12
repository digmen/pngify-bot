export type Kind = 'slides' | 'text' | 'sheet' | 'drawing' | 'pdf';

const EXT: Record<string, Kind> = {
  pptx: 'slides', ppt: 'slides', pps: 'slides', ppsx: 'slides', pptm: 'slides', odp: 'slides', key: 'slides',
  docx: 'text', doc: 'text', docm: 'text', odt: 'text', rtf: 'text', txt: 'text', pages: 'text',
  xlsx: 'sheet', xls: 'sheet', xlsm: 'sheet', ods: 'sheet', csv: 'sheet', numbers: 'sheet',
  odg: 'drawing', vsd: 'drawing', vsdx: 'drawing',
  pdf: 'pdf',
};

export const KIND_LABEL: Record<Kind, string> = {
  slides: 'Презентация',
  text: 'Документ',
  sheet: 'Таблица',
  drawing: 'Схема',
  pdf: 'PDF',
};

export const SUPPORTED_HINT = 'PowerPoint, Word, Excel, PDF, OpenDocument, RTF, TXT, Keynote, Pages, Visio';

export interface Detected {
  ext: string;
  kind: Kind;
}

/** Тип файла по имени. Возвращает null, если формат не поддерживаем. */
export function detectKind(fileName: string | undefined): Detected | null {
  if (!fileName) return null;
  const m = /\.([a-z0-9]{1,8})$/i.exec(fileName.trim());
  if (!m) return null;
  const ext = m[1].toLowerCase();
  const kind = EXT[ext];
  return kind ? { ext, kind } : null;
}

/** Имя для выходных картинок: без расширения, без опасных символов, не длиннее 40 символов. */
export function safeBaseName(fileName: string | undefined): string {
  const noExt = (fileName ?? '').replace(/\.[^.]*$/, '');
  const clean = noExt
    .normalize('NFC')
    .replace(/[^\p{L}\p{N} _-]+/gu, ' ')
    .trim()
    .replace(/\s+/g, '_')
    .slice(0, 40)
    .replace(/^[_-]+|[_-]+$/g, '');
  return clean || 'page';
}

/** «Отчёт-03.png»: номер с нулями, чтобы в папке файлы шли по порядку. */
export function pngName(base: string, index: number, total: number): string {
  const width = String(Math.max(total, 1)).length;
  return `${base}-${String(index).padStart(width, '0')}.png`;
}

export function humanSize(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} КБ`;
  return `${(bytes / 1024 / 1024).toFixed(1).replace('.0', '')} МБ`;
}

/** Какой «контейнер» должен быть внутри файла с таким расширением. */
const CONTAINER: Record<string, 'zip' | 'ole' | 'pdf' | 'rtf' | 'text'> = {
  pptx: 'zip', ppsx: 'zip', pptm: 'zip', docx: 'zip', docm: 'zip', xlsx: 'zip', xlsm: 'zip', vsdx: 'zip',
  odp: 'zip', odt: 'zip', ods: 'zip', odg: 'zip', key: 'zip', pages: 'zip', numbers: 'zip',
  ppt: 'ole', pps: 'ole', doc: 'ole', xls: 'ole', vsd: 'ole',
  pdf: 'pdf', rtf: 'rtf', txt: 'text', csv: 'text',
};

const OLE = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);

export type SignatureCheck = 'ok' | 'encrypted' | 'mismatch';

/**
 * Проверка по первым байтам, что файл — то, чем назван. Без неё LibreOffice открывает мусор
 * как текст и присылает страницы абракадабры. Документ Office под паролем — это OLE-контейнер
 * вместо ZIP: так и отличаем «защищён паролем» от «повреждён».
 * Старые .doc/.xls иногда бывают на самом деле RTF или HTML — их пропускаем, LibreOffice разберётся.
 */
export function checkSignature(ext: string, head: Buffer): SignatureCheck {
  const kind = CONTAINER[ext];
  if (!kind) return 'ok';
  const isZip = head.length >= 4 && head[0] === 0x50 && head[1] === 0x4b && (head[2] === 0x03 || head[2] === 0x05);
  const isOle = head.length >= 8 && head.subarray(0, 8).equals(OLE);
  const ascii = head.subarray(0, 16).toString('latin1');
  switch (kind) {
    case 'zip': return isZip ? 'ok' : isOle && ['pptx', 'ppsx', 'pptm', 'docx', 'docm', 'xlsx', 'xlsm'].includes(ext) ? 'encrypted' : 'mismatch';
    case 'ole': return isOle || isZip || /^\s*(\{\\rtf|<)/i.test(ascii) ? 'ok' : 'mismatch';
    case 'pdf': return head.subarray(0, 1024).includes('%PDF-') ? 'ok' : 'mismatch';
    case 'rtf': return /^\s*\{\\rtf/.test(ascii) ? 'ok' : 'mismatch';
    case 'text': return looksLikeText(head) ? 'ok' : 'mismatch';
  }
}

/** Текст: нет нулевых байтов и почти нет управляющих символов (UTF-8, cp1251 — всё годится). */
function looksLikeText(head: Buffer): boolean {
  if (head.length === 0) return true;
  let bad = 0;
  for (const b of head) {
    if (b === 0) return false;
    if (b < 0x09 || (b > 0x0d && b < 0x20)) bad++;
  }
  return bad / head.length < 0.02;
}
