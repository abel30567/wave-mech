import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildToolArguments, permissionHookSource } from './access-policy.js';

function argValue(args: string[], flag: string): string | undefined {
  const idx = args.indexOf(flag);
  if (idx < 0 || idx + 1 >= args.length) return undefined;
  return args[idx + 1];
}

function hasFlag(args: string[], flag: string): boolean {
  return args.includes(flag);
}

function parseJsonArg(args: string[], flag: string): unknown {
  const raw = argValue(args, flag);
  if (raw === undefined) throw new Error(`Missing ${flag}`);
  return JSON.parse(raw);
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

const BASE_OPTS = {
  fermiUrl: 'https://fermi.example.com',
  nodeExecutable: '/usr/bin/node',
  hookFile: '/tmp/hook.mjs',
};

describe('buildToolArguments argv-level structure', () => {
  it('emits --mcp-config with type:http fermi server at provided URL', () => {
    const args = buildToolArguments(BASE_OPTS);
    const cfg = parseJsonArg(args, '--mcp-config') as { mcpServers: Record<string, unknown> };
    const fermi = cfg.mcpServers.fermi as { type: string; url: string; name: string };
    expect(fermi.type).toBe('http');
    expect(fermi.url).toBe('https://fermi.example.com');
    expect(fermi.name).toBe('fermi');
  });

  it('emits --strict-mcp-config flag', () => {
    const args = buildToolArguments(BASE_OPTS);
    expect(hasFlag(args, '--strict-mcp-config')).toBe(true);
  });

  it('emits --tools with WebSearch,WebFetch,ToolSearch', () => {
    const args = buildToolArguments(BASE_OPTS);
    const tools = argValue(args, '--tools');
    expect(tools).toBe('WebSearch,WebFetch,ToolSearch');
  });

  it('emits --permission-mode dontAsk', () => {
    const args = buildToolArguments(BASE_OPTS);
    expect(argValue(args, '--permission-mode')).toBe('dontAsk');
  });

  it('emits --allowedTools with builtins and MCP read tools', () => {
    const args = buildToolArguments(BASE_OPTS);
    const allowed = argValue(args, '--allowedTools')!.split(',');
    expect(allowed).toContain('WebSearch');
    expect(allowed).toContain('WebFetch');
    expect(allowed).toContain('ToolSearch');
    expect(allowed).toContain('mcp__fermi__memory_recall');
    expect(allowed).toContain('mcp__fermi__skill_search');
    expect(allowed).toContain('mcp__fermi__skill_load');
  });

  it('emits --disallowedTools with sensitive tools', () => {
    const args = buildToolArguments(BASE_OPTS);
    const denied = argValue(args, '--disallowedTools')!.split(',');
    expect(denied).toContain('mcp__fermi__secret_resolve');
    expect(denied).toContain('mcp__fermi__skill_set');
    expect(denied).toContain('mcp__fermi__execute');
  });

  it('does NOT put mcpServers inside --settings', () => {
    const args = buildToolArguments(BASE_OPTS);
    const settings = parseJsonArg(args, '--settings') as Record<string, unknown>;
    expect(settings).not.toHaveProperty('mcpServers');
  });

  it('--settings contains PreToolUse hook and permissions', () => {
    const args = buildToolArguments(BASE_OPTS);
    const settings = parseJsonArg(args, '--settings') as {
      permissions: { allow: string[]; deny: string[] };
      hooks: { PreToolUse: Array<{ hooks: Array<{ type: string; command: string }> }> };
    };
    expect(settings.permissions.allow).toContain('WebSearch');
    expect(settings.permissions.deny).toContain('mcp__fermi__secret_resolve');
    expect(settings.hooks.PreToolUse[0].hooks[0].type).toBe('command');
  });

  it('--settings hook command references the provided node and hook paths', () => {
    const args = buildToolArguments(BASE_OPTS);
    const settings = parseJsonArg(args, '--settings') as {
      hooks: { PreToolUse: Array<{ hooks: Array<{ command: string }> }> };
    };
    const cmd = settings.hooks.PreToolUse[0].hooks[0].command;
    expect(cmd).toContain('/usr/bin/node');
    expect(cmd).toContain('/tmp/hook.mjs');
  });

  it('safely quotes paths with spaces and single quotes', () => {
    const args = buildToolArguments({
      fermiUrl: 'https://f',
      nodeExecutable: "/path with spaces/node's copy/node",
      hookFile: "/tmp/it's a hook.mjs",
    });
    const settings = parseJsonArg(args, '--settings') as {
      hooks: { PreToolUse: Array<{ hooks: Array<{ command: string }> }> };
    };
    const cmd = settings.hooks.PreToolUse[0].hooks[0].command;
    expect(cmd).toContain("'/path with spaces/node'\\''s copy/node'");
    expect(cmd).toContain("'/tmp/it'\\''s a hook.mjs'");
  });

  it('does not interpolate tool input into shell command', () => {
    const args = buildToolArguments(BASE_OPTS);
    const settings = parseJsonArg(args, '--settings') as {
      hooks: { PreToolUse: Array<{ hooks: Array<{ command: string }> }> };
    };
    const cmd = settings.hooks.PreToolUse[0].hooks[0].command;
    expect(cmd).not.toContain('$');
    expect(cmd).not.toContain('`');
  });

  it('does not include Write, Edit, Bash, or shell tools in allowed list', () => {
    const args = buildToolArguments(BASE_OPTS);
    const allowed = argValue(args, '--allowedTools')!.split(',');
    const tools = argValue(args, '--tools')!.split(',');
    for (const dangerous of ['Write', 'Edit', 'Bash', 'shell']) {
      expect(allowed).not.toContain(dangerous);
      expect(tools).not.toContain(dangerous);
    }
  });

  it('--mcp-config does not register any server other than fermi', () => {
    const args = buildToolArguments(BASE_OPTS);
    const cfg = parseJsonArg(args, '--mcp-config') as { mcpServers: Record<string, unknown> };
    expect(Object.keys(cfg.mcpServers)).toEqual(['fermi']);
  });

  it('all --mcp-config, --settings args are valid JSON strings', () => {
    const args = buildToolArguments(BASE_OPTS);
    expect(() => JSON.parse(argValue(args, '--mcp-config')!)).not.toThrow();
    expect(() => JSON.parse(argValue(args, '--settings')!)).not.toThrow();
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

  it('denies Write tool', async () => {
    const { stdout } = await runHook(
      JSON.stringify({ tool_name: 'Write', tool_input: {} }),
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

  it('denies mcp__fermi__execute', async () => {
    const { stdout } = await runHook(
      JSON.stringify({ tool_name: 'mcp__fermi__execute', tool_input: {} }),
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

  it('exits cleanly with code 0', async () => {
    const { code } = await runHook(JSON.stringify({ tool_name: 'WebSearch', tool_input: {} }));
    expect(code).toBe(0);
  });
});

describe('hook subprocess invoked via settings command', () => {
  it('can be launched via the shell command from settings', async () => {
    const args = buildToolArguments({
      fermiUrl: 'https://fermi.example.com',
      nodeExecutable: process.execPath,
      hookFile: hookPath,
    });
    const settings = parseJsonArg(args, '--settings') as {
      hooks: { PreToolUse: Array<{ hooks: Array<{ command: string }> }> };
    };
    const cmd = settings.hooks.PreToolUse[0].hooks[0].command;

    const result = await new Promise<{ code: number; stdout: string }>((resolve, reject) => {
      const proc = spawn('sh', ['-c', cmd], { stdio: ['pipe', 'pipe', 'pipe'] });
      let stdout = '';
      proc.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
      proc.on('close', (code) => resolve({ code: code ?? 1, stdout }));
      proc.on('error', reject);
      proc.stdin.write(JSON.stringify({ tool_name: 'WebSearch', tool_input: {} }));
      proc.stdin.end();
    });

    const output = JSON.parse(result.stdout);
    expect(output.hookSpecificOutput.permissionDecision).toBe('allow');
  });

  it('denies dangerous tools when invoked via settings command', async () => {
    const args = buildToolArguments({
      fermiUrl: 'https://fermi.example.com',
      nodeExecutable: process.execPath,
      hookFile: hookPath,
    });
    const settings = parseJsonArg(args, '--settings') as {
      hooks: { PreToolUse: Array<{ hooks: Array<{ command: string }> }> };
    };
    const cmd = settings.hooks.PreToolUse[0].hooks[0].command;

    const result = await new Promise<{ code: number; stdout: string }>((resolve, reject) => {
      const proc = spawn('sh', ['-c', cmd], { stdio: ['pipe', 'pipe', 'pipe'] });
      let stdout = '';
      proc.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
      proc.on('close', (code) => resolve({ code: code ?? 1, stdout }));
      proc.on('error', reject);
      proc.stdin.write(JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'rm -rf /' } }));
      proc.stdin.end();
    });

    const output = JSON.parse(result.stdout);
    expect(output.hookSpecificOutput.permissionDecision).toBe('deny');
  });

  it('handles paths with special characters via settings command', async () => {
    const specialDir = mkdtempSync(join(tmpdir(), "hook test's dir-"));
    const specialPath = join(specialDir, 'hook.mjs');
    writeFileSync(specialPath, permissionHookSource());

    try {
      const args = buildToolArguments({
        fermiUrl: 'https://fermi.example.com',
        nodeExecutable: process.execPath,
        hookFile: specialPath,
      });
      const settings = parseJsonArg(args, '--settings') as {
        hooks: { PreToolUse: Array<{ hooks: Array<{ command: string }> }> };
      };
      const cmd = settings.hooks.PreToolUse[0].hooks[0].command;

      const result = await new Promise<{ code: number; stdout: string }>((resolve, reject) => {
        const proc = spawn('sh', ['-c', cmd], { stdio: ['pipe', 'pipe', 'pipe'] });
        let stdout = '';
        proc.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
        proc.on('close', (code) => resolve({ code: code ?? 1, stdout }));
        proc.on('error', reject);
        proc.stdin.write(JSON.stringify({ tool_name: 'ToolSearch', tool_input: {} }));
        proc.stdin.end();
      });

      const output = JSON.parse(result.stdout);
      expect(output.hookSpecificOutput.permissionDecision).toBe('allow');
    } finally {
      rmSync(specialDir, { recursive: true, force: true });
    }
  });
});
