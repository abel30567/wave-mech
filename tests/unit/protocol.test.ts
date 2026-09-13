import { describe, expect, it } from 'vitest';
import { parseClientMessage } from '../../src/shared/protocol.js';

describe('browser command boundary', () => {
  it('accepts manual controls and normalizes text without executing it', () => {
    expect(parseClientMessage({ type: 'finish' })).toEqual({ type: 'finish' });
    expect(parseClientMessage({ type: 'text', text: '  hello; rm -rf /  ' })).toEqual({
      type: 'text', text: 'hello; rm -rf /',
    });
  });

  it.each([null, [], 'start', { type: 'exec' }, { type: 'text', text: '' },
    { type: 'text', text: 4 }, { type: 'text', text: 'x'.repeat(12001) },
    { type: 'start', command: 'anything' },
  ])('rejects malformed or unrecognized messages: %j', (value) => {
    expect(() => parseClientMessage(value)).toThrow();
  });
});
