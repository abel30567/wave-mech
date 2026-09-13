import type { SpeechTokenKind } from '../shared/contracts.js';

export function createElevenLabsTokenProvider(apiKey: string) {
  if (!apiKey.trim()) throw new Error('A server-side ElevenLabs key is required.');
  return async (kind: SpeechTokenKind): Promise<string> => {
    if (kind !== 'realtime_scribe' && kind !== 'tts_websocket') throw new Error('Unsupported speech token type.');
    let status: number | undefined;
    try {
      const response = await fetch(`https://api.elevenlabs.io/v1/single-use-token/${kind}`, {
        method: 'POST',
        headers: { 'xi-api-key': apiKey },
        redirect: 'error',
        signal: AbortSignal.timeout(10000),
      });
      status = response.status;
      if (!response.ok) throw new Error('Token request rejected.');
      const result: unknown = await response.json();
      const token = result && typeof result === 'object' ? (result as { token?: unknown }).token : undefined;
      if (typeof token !== 'string' || !token || token.length > 16384) throw new Error('Invalid speech token.');
      return token;
    } catch {
      throw new Error(`ElevenLabs speech token request failed${status ? ` (${status})` : ''}. Check server credentials, permissions and quota.`);
    }
  };
}

export interface BrokerConfiguration {
  urlTemplate: string;
  authorization?: string;
}

// Adapter contract: POST a configured URL containing {type}; receive { token }.
// This does not assume that Fermi exposes a particular broker route. Its operator
// must confirm this contract and configure the URL/authentication server-side.
export function createBrokerTokenProvider(configuration: BrokerConfiguration) {
  if (!configuration.urlTemplate.includes('{type}')) {
    throw new Error('Speech broker URL must include the {type} placeholder.');
  }
  return async (kind: SpeechTokenKind): Promise<string> => {
    const url = new URL(configuration.urlTemplate.replace('{type}', kind));
    const local = ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname);
    if (url.username || url.password || (url.protocol !== 'https:' && !(local && url.protocol === 'http:'))) {
      throw new Error('Speech broker requires HTTPS or local HTTP without URL credentials.');
    }
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: configuration.authorization ? { Authorization: configuration.authorization } : {},
        redirect: 'error',
        signal: AbortSignal.timeout(10000),
      });
      if (!response.ok) throw new Error('Broker request rejected.');
      const result: unknown = await response.json();
      const token = result && typeof result === 'object' ? (result as { token?: unknown }).token : undefined;
      if (typeof token !== 'string' || !token || token.length > 16384) throw new Error('Invalid broker token.');
      return token;
    } catch {
      // Underlying fetch/provider errors may contain authenticated URLs or data.
      throw new Error('Speech token broker unavailable. Check its URL, authentication and response contract.');
    }
  };
}
