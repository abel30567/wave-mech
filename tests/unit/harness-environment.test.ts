import { describe, expect, it } from 'vitest';
import { harnessEnvironmentOverrides } from '../../src/server/harness-environment.js';

describe('voice harness environment', () => {
  it('uses native Claude login rather than inherited proxy routing or API credentials', () => {
    const source = {
      HOME: '/home/voice', PATH: '/bin',
      ANTHROPIC_BASE_URL: 'http://localhost:8317', ANTHROPIC_AUTH_TOKEN: 'proxy-auth-fixture',
      ANTHROPIC_API_KEY: 'api-key-fixture', ANTHROPIC_MODEL: 'gpt-6-astra',
      ANTHROPIC_DEFAULT_OPUS_MODEL: 'gpt-6-astra', ANTHROPIC_DEFAULT_SONNET_MODEL: 'gpt-6-astra',
      ANTHROPIC_DEFAULT_HAIKU_MODEL: 'gpt-6-astra', ANTHROPIC_SMALL_FAST_MODEL: 'other-model',
      ANTHROPIC_SMALL_FAST_MODEL_AWS_REGION: 'us-east-1', ANTHROPIC_PROFILE: 'proxy-profile',
      CLAUDECODE: 'nested-session',
    };
    const child = { ...source, ...harnessEnvironmentOverrides(source) };
    for (const key of Object.keys(source).filter(key => key.startsWith('ANTHROPIC_'))) {
      expect(child[key as keyof typeof child], key).toBeUndefined();
    }
    expect(child.CLAUDECODE).toBeUndefined();
    expect(child.HOME).toBe(source.HOME);
    expect(child.PATH).toBe(source.PATH);
    expect(source.ANTHROPIC_MODEL).toBe('gpt-6-astra');
    expect(source.ANTHROPIC_AUTH_TOKEN).toBe('proxy-auth-fixture');
  });

  it.each([
    'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX', 'CLAUDE_CODE_USE_FOUNDRY',
    'CLAUDE_CODE_SUBAGENT_MODEL', 'CLAUDE_CODE_CUSTOM_OAUTH_URL',
    'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'all_proxy',
  ])('does not inherit %s into the direct Anthropic subprocess', key => {
    const source = { [key]: 'inherited-override' };
    expect(harnessEnvironmentOverrides(source)[key]).toBeUndefined();
    expect(harnessEnvironmentOverrides(source)).toHaveProperty(key);
  });

  it('preserves supported Claude OAuth without copying application credentials', () => {
    const source = {
      CLAUDE_CODE_OAUTH_TOKEN: 'existing-oauth-fixture', ELEVENLABS_API_KEY: 'speech-secret-fixture',
      WAVE_ELEVENLABS_KEY_FILE: '/private/speech.key', WAVE_SPEECH_TOKEN_AUTH: 'broker-secret-fixture',
      INTEGRAND_LINEAR_API_KEY: 'tracking-secret-fixture',
    };
    const child = { ...source, ...harnessEnvironmentOverrides(source) };
    expect(child.CLAUDE_CODE_OAUTH_TOKEN).toBe(source.CLAUDE_CODE_OAUTH_TOKEN);
    expect(child.ELEVENLABS_API_KEY).toBeUndefined();
    expect(child.WAVE_ELEVENLABS_KEY_FILE).toBeUndefined();
    expect(child.WAVE_SPEECH_TOKEN_AUTH).toBeUndefined();
    expect(child.INTEGRAND_LINEAR_API_KEY).toBeUndefined();
  });
});
