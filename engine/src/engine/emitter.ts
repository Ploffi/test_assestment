import type {
  EngineEventName,
  EngineEventPayload,
} from '../public/emitter.js';

export type EngineEmit = <N extends EngineEventName>(
  eventName: N,
  payload: EngineEventPayload<N>,
) => void;

export class EngineEmitter {
  private subs: Map<string, Set<(p: any) => void>> = new Map();

  on<N extends EngineEventName>(eventName: N, cb: (p: EngineEventPayload<N>) => void): void {
    let set = this.subs.get(eventName as string);
    if (!set) {
      set = new Set();
      this.subs.set(eventName as string, set);
    }
    set.add(cb as (p: any) => void);
  }

  off<N extends EngineEventName>(eventName: N, cb: (p: EngineEventPayload<N>) => void): void {
    this.subs.get(eventName as string)?.delete(cb as (p: any) => void);
  }

  emit<N extends EngineEventName>(eventName: N, payload: EngineEventPayload<N>): void {
    const set = this.subs.get(eventName as string);
    if (!set) return;
    for (const cb of set) {
      try { cb(payload); } catch { /* ignore subscriber failures */ }
    }
  }
}
