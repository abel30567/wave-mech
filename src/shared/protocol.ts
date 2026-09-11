import type { ClientMessage } from './contracts.js';

const controls = new Set(['start', 'record', 'finish', 'playback_done', 'end']);

export function parseClientMessage(value: unknown): ClientMessage {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Expected a voice session command.');
  }
  const command = value as Record<string, unknown>;
  const allowedKeys = command.type === 'text' ? ['type', 'text'] : ['type'];
  if (Object.keys(command).some((key) => !allowedKeys.includes(key))) {
    throw new Error('Unexpected command fields.');
  }
  if (command.type === 'text') {
    if (typeof command.text !== 'string' || !command.text.trim() || command.text.length > 12000) {
      throw new Error('Enter between 1 and 12000 characters.');
    }
    return { type: 'text', text: command.text.trim() };
  }
  if (typeof command.type === 'string' && controls.has(command.type)) {
    return { type: command.type } as ClientMessage;
  }
  throw new Error('Unknown voice session command.');
}
