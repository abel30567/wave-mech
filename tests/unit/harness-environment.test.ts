import { describe, expect, it } from 'vitest';
import { harnessEnvironmentOverrides } from '../../src/server/harness-environment.js';

describe('voice harness environment', () => {
  it('preserves existing CLI authentication and routing without copying speech credentials', () => {
    const source = {
      PATH: '/bin', ANTHROPIC_BASE_URL: 'http://localhost:1234', ANTHROPIC_AUTH_TOKEN: 'harness-auth-fixture',
      ANTHROPIC_MODEL: 'configured-model', ANTHROPIC_PROFILE: 'existing-profile',
      CLAUDE_CODE_OAUTH_TOKEN: 'existing-oauth-fixture', ELEVENLABS_API_KEY: 'speech-secret-fixture',
      WAVE_ELEVENLABS_KEY_FILE: '/private/speech.key', WAVE_SPEECH_TOKEN_AUTH: 'broker-secret-fixture',
      INTEGRAND_LINEAR_API_KEY: 'tracking-secret-fixture', CLAUDECODE: 'nested-session',
    };
    const child = { ...source, ...harnessEnvironmentOverrides(source) };
    expect(child.ANTHROPIC_AUTH_TOKEN).toBe(source.ANTHROPIC_AUTH_TOKEN);
    expect(child.ANTHROPIC_BASE_URL).toBe(source.ANTHROPIC_BASE_URL);
    expect(child.ANTHROPIC_PROFILE).toBe(source.ANTHROPIC_PROFILE);
    expect(child.CLAUDE_CODE_OAUTH_TOKEN).toBe(source.CLAUDE_CODE_OAUTH_TOKEN);
    expect(child.ELEVENLABS_API_KEY).toBeUndefined();
    expect(child.WAVE_ELEVENLABS_KEY_FILE).toBeUndefined();
    expect(child.WAVE_SPEECH_TOKEN_AUTH).toBeUndefined();
    expect(child.INTEGRAND_LINEAR_API_KEY).toBeUndefined();
    expect(child.CLAUDECODE).toBeUndefined();
  });
});
