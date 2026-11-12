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
