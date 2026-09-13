const harnessAuthentication = new Set([
  'CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_API_KEY',
]);

export function harnessEnvironmentOverrides(source: Record<string, string | undefined> = process.env) {
  const overrides: Record<string, undefined> = { CLAUDECODE: undefined };
  for (const key of Object.keys(source)) {
    if (/KEY|TOKEN|SECRET|PASSWORD|COOKIE|^WAVE_/i.test(key) && !harnessAuthentication.has(key)) {
      overrides[key] = undefined;
    }
  }
  return overrides;
}
