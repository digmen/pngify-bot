import { spawn } from 'node:child_process';
import { readdir, stat } from 'node:fs/promises';
import path from 'node:path';

export interface RunOptions {
  /** Каталог задачи: единственное место, куда процессу можно писать. */
  jobDir: string;
  timeoutSec: number;
  /** true — запускать в bubblewrap без сети, с файловой системой только на чтение. */
  sandbox: boolean;
}

export class ConvertError extends Error {
  constructor(
    message: string,
    /** Текст для пользователя. */
    readonly userMessage: string,
  ) {
    super(message);
  }
}

/**
 * Запуск внешней программы для чужого файла. В песочнице: нет сети (файл не может
 * ничего скачать или отправить), всё, кроме каталога задачи, только на чтение,
 * свой /tmp, процесс умирает вместе с ботом. nice — чтобы VPN-боты на том же сервере не тормозили.
 */
export function run(cmd: string, args: string[], opts: RunOptions): Promise<string> {
  const dir = path.resolve(opts.jobDir);
  const env = { PATH: '/usr/bin:/bin', HOME: '/tmp', XDG_CACHE_HOME: '/tmp', LANG: 'C.UTF-8' };
  const full = opts.sandbox
    ? ['bwrap', '--unshare-net', '--unshare-pid', '--die-with-parent', '--new-session',
       '--ro-bind', '/', '/', '--tmpfs', '/tmp', '--bind', dir, dir,
       '--dev', '/dev', '--proc', '/proc', '--chdir', dir, '--', 'nice', '-n', '10', cmd, ...args]
    : ['nice', '-n', '10', cmd, ...args];

  return new Promise((resolve, reject) => {
    const child = spawn(full[0], full.slice(1), { cwd: dir, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    const keep = (b: Buffer) => { out = (out + b.toString()).slice(-4000); };
    child.stdout.on('data', keep);
    child.stderr.on('data', keep);
    const timer = setTimeout(() => child.kill('SIGKILL'), opts.timeoutSec * 1000);
    child.on('error', (e) => { clearTimeout(timer); reject(e); });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      if (signal === 'SIGKILL') {
        reject(new ConvertError(`${cmd}: таймаут ${opts.timeoutSec} с`, 'Файл слишком долго открывается. Попробуй файл поменьше или сохрани его в PDF.'));
      } else if (code !== 0) {
        reject(new ConvertError(`${cmd}: код ${code}: ${out.slice(-500)}`, 'Не получилось открыть файл. Возможно, он повреждён или защищён паролем.'));
      } else {
        resolve(out);
      }
    });
  });
}

/** Документ → PDF через LibreOffice. PDF возвращается как есть. */
export async function toPdf(input: string, opts: RunOptions): Promise<string> {
  if (input.toLowerCase().endsWith('.pdf')) return input;
  await run('soffice', [
    '-env:UserInstallation=file:///tmp/lo-profile',
    '--headless', '--norestore', '--nolockcheck', '--nodefault',
    '--convert-to', 'pdf', '--outdir', opts.jobDir, input,
  ], opts);
  const files = await readdir(opts.jobDir);
  const pdf = files.find((f) => f.toLowerCase().endsWith('.pdf'));
  if (!pdf) throw new ConvertError('soffice не создал PDF', 'Не получилось открыть файл. Возможно, он повреждён или в нём нет страниц.');
  return path.join(opts.jobDir, pdf);
}

export async function pageCount(pdf: string, opts: RunOptions): Promise<number> {
  const out = await run('pdfinfo', [pdf], { ...opts, timeoutSec: 30 });
  const m = /^Pages:\s+(\d+)/m.exec(out);
  if (!m) throw new ConvertError('pdfinfo без Pages', 'Не получилось прочитать страницы файла.');
  return Number(m[1]);
}

/** Одна страница → PNG. Возвращает путь к картинке. */
export async function renderPage(pdf: string, page: number, dpi: number, outBase: string, opts: RunOptions): Promise<string> {
  await run('pdftoppm', ['-png', '-r', String(dpi), '-f', String(page), '-l', String(page), '-singlefile', pdf, outBase], { ...opts, timeoutSec: 60 });
  const file = `${outBase}.png`;
  await stat(file);
  return file;
}

/**
 * ZIP без сжатия (PNG и так сжаты): быстро и не грузит процессор.
 * Через Python zipfile, а не утилиту zip: он ставит флаг UTF-8, и русские имена
 * читаются в Windows и macOS (у zip они ломались, проверено 12.11.2026).
 */
export async function makeZip(zipPath: string, files: string[], opts: RunOptions): Promise<string> {
  const script = 'import sys,zipfile,os\nwith zipfile.ZipFile(sys.argv[1],"w",zipfile.ZIP_STORED) as z:\n  [z.write(f,os.path.basename(f)) for f in sys.argv[2:]]';
  await run('python3', ['-I', '-c', script, zipPath, ...files], { ...opts, sandbox: false, timeoutSec: 120 });
  return zipPath;
}
