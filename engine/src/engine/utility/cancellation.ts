import type { Clock, Timer } from '../../public/index.js';

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
    throwIfAborted(this.signal);

    let onAbort: (() => void) | null = null;
    const abortPromise = new Promise<never>((_, reject) => {
      onAbort = () => reject(signalAbortError(this.signal));
      this.signal.addEventListener('abort', onAbort, { once: true });
    });
    abortPromise.catch(() => {});

    let mainPromise: Promise<T>;
    try {
      mainPromise = Promise.resolve(work(this.signal));
    } catch (err) {
      mainPromise = Promise.reject(err);
    }
    mainPromise.catch(() => {});

    try {
      return await Promise.race([mainPromise, abortPromise]);
    } finally {
      if (onAbort) this.signal.removeEventListener('abort', onAbort);
    }
  }

  dispose(): void {
    this.watchdog.cancel();
    if (this.userSignal && this.userAbortHandler) {
      this.userSignal.removeEventListener('abort', this.userAbortHandler);
      this.userAbortHandler = null;
    }
  }
}

function signalAbortError(signal: AbortSignal): Error {
  const reason = signal.reason;
  return reason instanceof Error ? reason : new Error('aborted');
}

export function throwIfAborted(signal: AbortSignal): void {
  if (!signal.aborted) return;
  throw signalAbortError(signal);
}
