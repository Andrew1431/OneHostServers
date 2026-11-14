import { describe, it, expect } from 'vitest';
import { parsePushBody, parsePushEnvelope, type Job } from './index.ts';

function envelope(job: Job): string {
  const data = Buffer.from(JSON.stringify(job)).toString('base64');
  return JSON.stringify({ message: { data } });
}

describe('parsePushBody', () => {
  it('decodes a base64 push envelope into a Job', () => {
    const job: Job = { kind: 'start', id: 'mc', interactionToken: 'tok' };
    expect(parsePushBody(envelope(job))).toEqual(job);
  });

  it('decodes a tokenless job (e.g. sweep)', () => {
    const job: Job = { kind: 'sweep' };
    expect(parsePushBody(envelope(job))).toEqual(job);
  });

  it('throws when message.data is missing', () => {
    expect(() => parsePushBody(JSON.stringify({ message: {} }))).toThrow(
      /message\.data/,
    );
  });

  it('throws when message is missing entirely', () => {
    expect(() => parsePushBody(JSON.stringify({}))).toThrow(/message\.data/);
  });

  it('throws when message.data is not a string', () => {
    expect(() => parsePushBody(JSON.stringify({ message: { data: 42 } }))).toThrow(
      /message\.data/,
    );
  });

  it('throws on invalid JSON outer body', () => {
    expect(() => parsePushBody('not json')).toThrow();
  });

  it('throws when the decoded data is not valid JSON', () => {
    const data = Buffer.from('not json').toString('base64');
    expect(() => parsePushBody(JSON.stringify({ message: { data } }))).toThrow();
  });
});

describe('parsePushEnvelope', () => {
  const data = Buffer.from(JSON.stringify({ kind: 'stop', id: 'mc' })).toString('base64');

  it('surfaces the Pub/Sub messageId (stable across redeliveries)', () => {
    expect(parsePushEnvelope(JSON.stringify({ message: { data, messageId: '123' } }))).toEqual({
      job: { kind: 'stop', id: 'mc' },
      messageId: '123',
    });
  });

  it('accepts the snake_case message_id alias', () => {
    expect(parsePushEnvelope(JSON.stringify({ message: { data, message_id: '456' } })).messageId).toBe('456');
  });

  it('omits messageId when the envelope has none', () => {
    expect(parsePushEnvelope(JSON.stringify({ message: { data } }))).toEqual({ job: { kind: 'stop', id: 'mc' } });
  });
});
