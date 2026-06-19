import { describe, it, expect } from 'vitest';
import { nextState, canTransition, InvalidTransitionError } from './state.ts';
import type { ServerState } from './types.ts';
import type { LifecycleEvent } from './state.ts';

const STATES: ServerState[] = ['STOPPED', 'STARTING', 'RUNNING', 'STOPPING', 'ERROR'];
const EVENTS: LifecycleEvent[] = ['start', 'started', 'stop', 'stopped', 'fail', 'reset'];

// The single source of truth for the matrix, mirrored from state.ts. If this drifts
// from the implementation the tests below fail, which is the point.
const VALID: Partial<Record<ServerState, Partial<Record<LifecycleEvent, ServerState>>>> = {
  STOPPED: { start: 'STARTING' },
  STARTING: { started: 'RUNNING', fail: 'ERROR' },
  RUNNING: { stop: 'STOPPING' },
  STOPPING: { stopped: 'STOPPED', fail: 'ERROR' },
  ERROR: { reset: 'STOPPED' },
};

describe('nextState — full transition matrix', () => {
  for (const from of STATES) {
    for (const event of EVENTS) {
      const expected = VALID[from]?.[event];
      if (expected !== undefined) {
        it(`${from} --${event}--> ${expected}`, () => {
          expect(nextState(from, event)).toBe(expected);
        });
      } else {
        it(`${from} --${event}--> throws InvalidTransitionError`, () => {
          expect(() => nextState(from, event)).toThrow(InvalidTransitionError);
        });
      }
    }
  }
});

describe('canTransition agrees with nextState for every pair', () => {
  for (const from of STATES) {
    for (const event of EVENTS) {
      it(`${from} / ${event}`, () => {
        const allowed = canTransition(from, event);
        if (allowed) {
          expect(() => nextState(from, event)).not.toThrow();
        } else {
          expect(() => nextState(from, event)).toThrow(InvalidTransitionError);
        }
      });
    }
  }
});

describe('InvalidTransitionError', () => {
  it('carries from + event and a helpful message', () => {
    let err: unknown;
    try {
      nextState('STOPPED', 'stopped');
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(InvalidTransitionError);
    const ite = err as InvalidTransitionError;
    expect(ite.from).toBe('STOPPED');
    expect(ite.event).toBe('stopped');
    expect(ite.name).toBe('InvalidTransitionError');
    expect(ite.message).toContain("cannot 'stopped' from 'STOPPED'");
  });
});
