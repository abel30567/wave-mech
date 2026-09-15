export function harnessEnvironmentOverrides(source: Record<string, string | undefined> = process.env) {
  const overrides: Record<string, undefined> = { CLAUDECODE: undefined };
  for (const key of Object.keys(source)) {
    // Like the Fermi daemon, use native Claude login and first-party inference,
    // not a coding shell's proxy credentials, model aliases, or provider switches.
    const routing = /^ANTHROPIC_|^CLAUDE_CODE_(USE_|SUBAGENT_MODEL$|CUSTOM_OAUTH_URL$)|^(HTTP|HTTPS|ALL)_PROXY$/i.test(key);
    const secret = /KEY|TOKEN|SECRET|PASSWORD|COOKIE|^WAVE_/i.test(key) && key !== 'CLAUDE_CODE_OAUTH_TOKEN';
    if (routing || secret) overrides[key] = undefined;
  }
  return overrides;
}
