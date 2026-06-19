import { describe, it, expect } from 'vitest';
import { nextState, canTransition, InvalidTransitionError } from './state.ts';

// Smoke test proving the runner + workspace resolution work end-to-end. The full
// transition-matrix coverage lands in WP1.
describe('nextState', () => {
  it('advances STOPPED through a start', () => {
    expect(nextState('STOPPED', 'start')).toBe('STARTING');
  });

  it('rejects an illegal transition', () => {
    expect(() => nextState('STOPPED', 'stopped')).toThrow(InvalidTransitionError);
    expect(canTransition('STOPPED', 'stopped')).toBe(false);
  });
});
