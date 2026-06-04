/**
 * Engine-internal emitter helpers.
 *
 * The public surface (`engine.on(...)`) is the consumer-facing read side
 * of these events. Internally, the engine calls `emit(name, payload)` at
 * the seams documented in ADR-011; this typed helper enforces shape.
 */

import type {
  EngineEventName,
  EngineEventPayload,
} from '../public/emitter.js';

export interface EmitFn {
  <N extends EngineEventName>(name: N, payload: EngineEventPayload<N>): void;
}

/** One subscriber entry kept by the engine's internal emitter. */
export interface Subscriber<N extends EngineEventName = EngineEventName> {
  readonly name: N;
  readonly cb: (payload: EngineEventPayload<N>) => void;
}
