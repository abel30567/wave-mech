import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildToolArguments, permissionHookSource } from './access-policy.js';

function parseSettings(args: string[]) {
  const idx = args.indexOf('--settings');
  return JSON.parse(args[idx + 1]);
}

let hookDir: string;
let hookPath: string;

beforeAll(() => {
  hookDir = mkdtempSync(join(tmpdir(), 'hook-test-'));
  hookPath = join(hookDir, 'hook.mjs');
  writeFileSync(hookPath, permissionHookSource());
});

afterAll(() => {
  rmSync(hookDir, { recursive: true, force: true });
});

function runHook(input: string): Promise<{ code: number; stdout: string }> {
  return new Promise((resolve, reject) => {
    const proc = spawn(process.execPath, [hookPath], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    proc.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    proc.on('close', (code) => resolve({ code: code ?? 1, stdout }));
    proc.on('error', reject);
    proc.stdin.write(input);
    proc.stdin.end();
  });
}

describe('buildToolArguments', () => {
  const opts = {
    fermiUrl: 'https://fermi.example.com',
    nodeExecutable: '/usr/bin/node',
    hookFile: '/tmp/hook.mjs',
  };

  it('returns --settings with valid JSON', () => {
    const args = buildToolArguments(opts);
    expect(args[0]).toBe('--settings');
    expect(() => JSON.parse(args[1])).not.toThrow();
  });

  it('configures fermi MCP server at provided URL', () => {
    const s = parseSettings(buildToolArguments(opts));
    expect(s.mcpServers.fermi.url).toBe('https://fermi.example.com');
  });

  it('preapproves only the specified tool whitelist', () => {
    const s = parseSettings(buildToolArguments(opts));
    expect(s.permissions.allow).toEqual([
      'WebSearch',
      'WebFetch',
      'ToolSearch',
      'mcp__fermi__memory_recall',
      'mcp__fermi__skill_search',
      'mcp__fermi__skill_load',
    ]);
  });

  it('explicitly denies sensitive tools', () => {
    const s = parseSettings(buildToolArguments(opts));
    expect(s.permissions.deny).toContain('mcp__fermi__secret_resolve');
    expect(s.permissions.deny).toContain('mcp__fermi__skill_set');
    expect(s.permissions.deny).toContain('mcp__fermi__execute');
  });

  it('configures a PreToolUse command hook', () => {
    const s = parseSettings(buildToolArguments(opts));
    const hook = s.hooks.PreToolUse[0].hooks[0];
    expect(hook.type).toBe('command');
    expect(hook.command).toContain('/usr/bin/node');
    expect(hook.command).toContain('/tmp/hook.mjs');
  });

  it('safely quotes paths with spaces and single quotes', () => {
    const args = buildToolArguments({
      fermiUrl: 'https://f',
      nodeExecutable: "/path with spaces/node's copy/node",
      hookFile: "/tmp/it's a hook.mjs",
    });
    const s = parseSettings(args);
    const cmd: string = s.hooks.PreToolUse[0].hooks[0].command;
    expect(cmd).toContain("'/path with spaces/node'\\''s copy/node'");
    expect(cmd).toContain("'/tmp/it'\\''s a hook.mjs'");
  });

  it('does not interpolate tool input into shell command', () => {
    const args = buildToolArguments({
      fermiUrl: 'https://f',
      nodeExecutable: '/usr/bin/node',
      hookFile: '/tmp/hook.mjs',
    });
    const s = parseSettings(args);
    const cmd: string = s.hooks.PreToolUse[0].hooks[0].command;
    expect(cmd).not.toContain('$');
    expect(cmd).not.toContain('`');
  });
});

describe('permissionHookSource subprocess', () => {
  it('allows WebSearch', async () => {
    const { stdout } = await runHook(JSON.stringify({ tool_name: 'WebSearch', tool_input: {} }));
    const output = JSON.parse(stdout);
    expect(output.hookSpecificOutput.hookEventName).toBe('PreToolUse');
    expect(output.hookSpecificOutput.permissionDecision).toBe('allow');
  });

  it('allows WebFetch', async () => {
    const { stdout } = await runHook(JSON.stringify({ tool_name: 'WebFetch', tool_input: {} }));
    expect(JSON.parse(stdout).hookSpecificOutput.permissionDecision).toBe('allow');
  });

  it('allows ToolSearch', async () => {
    const { stdout } = await runHook(JSON.stringify({ tool_name: 'ToolSearch', tool_input: {} }));
    expect(JSON.parse(stdout).hookSpecificOutput.permissionDecision).toBe('allow');
  });

  it('allows mcp__fermi__memory_recall', async () => {
    const { stdout } = await runHook(
      JSON.stringify({ tool_name: 'mcp__fermi__memory_recall', tool_input: {} }),
    );
    expect(JSON.parse(stdout).hookSpecificOutput.permissionDecision).toBe('allow');
  });

  it('allows mcp__fermi__skill_search', async () => {
    const { stdout } = await runHook(
      JSON.stringify({ tool_name: 'mcp__fermi__skill_search', tool_input: {} }),
    );
    expect(JSON.parse(stdout).hookSpecificOutput.permissionDecision).toBe('allow');
  });

  it('allows mcp__fermi__skill_load', async () => {
    const { stdout } = await runHook(
      JSON.stringify({ tool_name: 'mcp__fermi__skill_load', tool_input: {} }),
    );
    expect(JSON.parse(stdout).hookSpecificOutput.permissionDecision).toBe('allow');
  });

  it('denies Bash tool', async () => {
    const { stdout } = await runHook(
      JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'ls' } }),
    );
    const output = JSON.parse(stdout);
    expect(output.hookSpecificOutput.permissionDecision).toBe('deny');
    expect(output.hookSpecificOutput.permissionDecisionReason).toContain('Bash');
  });

  it('denies Edit tool', async () => {
    const { stdout } = await runHook(
      JSON.stringify({ tool_name: 'Edit', tool_input: {} }),
    );
    expect(JSON.parse(stdout).hookSpecificOutput.permissionDecision).toBe('deny');
  });

  it('denies mcp__fermi__secret_resolve', async () => {
    const { stdout } = await runHook(
      JSON.stringify({ tool_name: 'mcp__fermi__secret_resolve', tool_input: {} }),
    );
    expect(JSON.parse(stdout).hookSpecificOutput.permissionDecision).toBe('deny');
  });

  it('denies mcp__fermi__skill_set', async () => {
    const { stdout } = await runHook(
      JSON.stringify({ tool_name: 'mcp__fermi__skill_set', tool_input: {} }),
    );
    expect(JSON.parse(stdout).hookSpecificOutput.permissionDecision).toBe('deny');
  });

  it('denies unknown tools', async () => {
    const { stdout } = await runHook(
      JSON.stringify({ tool_name: 'SomethingNew', tool_input: {} }),
    );
    expect(JSON.parse(stdout).hookSpecificOutput.permissionDecision).toBe('deny');
  });

  it('denies on malformed JSON', async () => {
    const { stdout } = await runHook('this is not json');
    const output = JSON.parse(stdout);
    expect(output.hookSpecificOutput.permissionDecision).toBe('deny');
    expect(output.hookSpecificOutput.permissionDecisionReason).toContain('Malformed');
  });

  it('denies on oversized input', async () => {
    const { stdout } = await runHook('x'.repeat(70000));
    const output = JSON.parse(stdout);
    expect(output.hookSpecificOutput.permissionDecision).toBe('deny');
    expect(output.hookSpecificOutput.permissionDecisionReason).toContain('size limit');
  });

  it('denies when tool_name is missing', async () => {
    const { stdout } = await runHook(JSON.stringify({ tool_input: {} }));
    const output = JSON.parse(stdout);
    expect(output.hookSpecificOutput.permissionDecision).toBe('deny');
    expect(output.hookSpecificOutput.permissionDecisionReason).toContain('unknown');
  });

  it('denies when input is null', async () => {
    const { stdout } = await runHook('null');
    expect(JSON.parse(stdout).hookSpecificOutput.permissionDecision).toBe('deny');
  });

  it('denies when input is an array', async () => {
    const { stdout } = await runHook('[]');
    expect(JSON.parse(stdout).hookSpecificOutput.permissionDecision).toBe('deny');
  });

  it('denies on empty stdin', async () => {
    const { stdout } = await runHook('');
    const output = JSON.parse(stdout);
    expect(output.hookSpecificOutput.permissionDecision).toBe('deny');
    expect(output.hookSpecificOutput.permissionDecisionReason).toContain('Malformed');
  });

  it('truncates long tool names in reason', async () => {
    const longName = 'A'.repeat(200);
    const { stdout } = await runHook(JSON.stringify({ tool_name: longName, tool_input: {} }));
    const output = JSON.parse(stdout);
    expect(output.hookSpecificOutput.permissionDecision).toBe('deny');
    expect(output.hookSpecificOutput.permissionDecisionReason.length).toBeLessThan(200);
  });
});
