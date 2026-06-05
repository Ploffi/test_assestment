import type { Clock, Timer } from '../public/index.js';

export interface CancellationScopeOptions {
  clock: Clock;
  timeoutMs: number;
  signal?: AbortSignal;
  timeoutReason?: Error;
}

export class CancellationScope {
  private readonly controller = new AbortController();
  private readonly watchdog: Timer;
  private readonly userSignal?: AbortSignal;
  private userAbortHandler: (() => void) | null = null;

  constructor(opts: CancellationScopeOptions) {
    this.userSignal = opts.signal;
    this.watchdog = opts.clock.setTimeout(() => {
      this.abort(opts.timeoutReason ?? new Error('evaluation timeout'));
    }, opts.timeoutMs);

    if (!this.userSignal) return;
    if (this.userSignal.aborted) {
      this.abort(this.userSignal.reason);
      return;
    }
    this.userAbortHandler = () => {
      this.abort(this.userSignal?.reason);
    };
    this.userSignal.addEventListener('abort', this.userAbortHandler);
  }

  get signal(): AbortSignal {
    return this.controller.signal;
  }

  abort(reason?: unknown): void {
    try {
      this.controller.abort(reason);
    } catch { /* abort is best-effort during shutdown */ }
  }

  async run<T>(work: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const abortPromise = new Promise<never>((_, reject) => {
      if (this.signal.aborted) {
        reject(new Error('aborted'));
        return;
      }
      this.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
    });
    abortPromise.catch(() => {});

    const mainPromise = work(this.signal);
    mainPromise.catch(() => {});

    return Promise.race([mainPromise, abortPromise]);
  }

  dispose(): void {
    this.watchdog.cancel();
    if (this.userSignal && this.userAbortHandler) {
      this.userSignal.removeEventListener('abort', this.userAbortHandler);
      this.userAbortHandler = null;
    }
  }
}

export function throwIfAborted(signal: AbortSignal): void {
  if (!signal.aborted) return;
  const reason = signal.reason;
  throw reason instanceof Error ? reason : new Error('aborted');
}
