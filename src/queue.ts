/**
 * Очередь «по одной». LibreOffice тяжёлый, а сервер общий с VPN-ботами,
 * поэтому одновременно конвертируется ровно один файл.
 */
export interface QueueTask {
  id: string;
  run: () => Promise<void>;
  /** Позиция среди ждущих: 1 — следующий. Зовётся при постановке и каждый раз, когда очередь сдвинулась. */
  onPosition?: (position: number) => void;
}

export class SerialQueue {
  private waiting: QueueTask[] = [];
  private running = false;

  get size(): number {
    return this.waiting.length + (this.running ? 1 : 0);
  }

  has(id: string): boolean {
    return this.waiting.some((t) => t.id === id);
  }

  push(task: QueueTask): number {
    this.waiting.push(task);
    const position = this.waiting.length + (this.running ? 0 : -1);
    if (position > 0) task.onPosition?.(position);
    void this.pump();
    return position;
  }

  private async pump(): Promise<void> {
    if (this.running) return;
    const task = this.waiting.shift();
    if (!task) return;
    this.running = true;
    this.waiting.forEach((t, i) => t.onPosition?.(i + 1));
    try {
      await task.run();
    } catch {
      // Задача сама сообщает об ошибке пользователю; очередь не должна вставать.
    } finally {
      this.running = false;
      void this.pump();
    }
  }
}
