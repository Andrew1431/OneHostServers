import type { ServerState } from './types.ts';

/**
 * Lifecycle events that drive state transitions. The control plane never
 * mutates state by hand — it asks `nextState` and trusts the guard.
 */
export type LifecycleEvent =
  | 'start' // user requested boot
  | 'started' // provider confirmed RUNNING
  | 'stop' // user/idle-agent requested shutdown
  | 'stopped' // provider confirmed STOPPED
  | 'fail' // any operation failed
  | 'reset'; // operator cleared an ERROR

const TRANSITIONS: Record<ServerState, Partial<Record<LifecycleEvent, ServerState>>> = {
  STOPPED: { start: 'STARTING' },
  STARTING: { started: 'RUNNING', fail: 'ERROR' },
  RUNNING: { stop: 'STOPPING' },
  STOPPING: { stopped: 'STOPPED', fail: 'ERROR' },
  ERROR: { reset: 'STOPPED' },
};

export class InvalidTransitionError extends Error {
  constructor(
    readonly from: ServerState,
    readonly event: LifecycleEvent,
  ) {
    super(`Invalid transition: cannot '${event}' from '${from}'`);
    this.name = 'InvalidTransitionError';
  }
}

/** Pure transition guard. Throws on illegal moves so callers can't desync. */
export function nextState(from: ServerState, event: LifecycleEvent): ServerState {
  const to = TRANSITIONS[from][event];
  if (to === undefined) throw new InvalidTransitionError(from, event);
  return to;
}

export function canTransition(from: ServerState, event: LifecycleEvent): boolean {
  return TRANSITIONS[from][event] !== undefined;
}
