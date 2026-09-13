import type { ToolAccessOptions } from '../../shared/access-contracts.js';

const BUILTIN_TOOLS = ['WebSearch', 'WebFetch', 'ToolSearch'] as const;
const FERMI_PREFIX = 'mcp__fermi__';

function shellQuote(s: string): string {
  return "'" + s.replace(/'/g, "'\\''") + "'";
}

export function buildToolArguments(options: ToolAccessOptions): string[] {
  const { fermiUrl, nodeExecutable, hookFile } = options;

  const mcpConfig = {
    mcpServers: {
      fermi: {
        type: 'http',
        url: fermiUrl,
        name: 'fermi',
      },
    },
  };

  const settings = {
    permissions: {
      allow: [...BUILTIN_TOOLS],
    },
    hooks: {
      PreToolUse: [
        {
          matcher: '',
          hooks: [
            {
              type: 'command',
              command: `${shellQuote(nodeExecutable)} ${shellQuote(hookFile)}`,
            },
          ],
        },
      ],
    },
  };

  return [
    '--mcp-config', JSON.stringify(mcpConfig),
    '--strict-mcp-config',
    '--tools', BUILTIN_TOOLS.join(','),
    '--permission-mode', 'dontAsk',
    '--allowedTools', BUILTIN_TOOLS.join(','),
    '--settings', JSON.stringify(settings),
  ];
}

export function permissionHookSource(): string {
  const builtins = JSON.stringify([...BUILTIN_TOOLS]);
  return `'use strict';
const BUILTINS = new Set(${builtins});
const FERMI_PREFIX = ${JSON.stringify(FERMI_PREFIX)};
const MAX_INPUT = 65536;
let data = '', overflow = false;

function respond(decision, reason) {
  const r = { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: decision } };
  if (reason) r.hookSpecificOutput.permissionDecisionReason = reason;
  process.stdout.write(JSON.stringify(r));
}

process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => {
  if (overflow) return;
  data += chunk;
  if (data.length > MAX_INPUT) {
    overflow = true;
    respond('deny', 'Input exceeds size limit');
  }
});
process.stdin.on('end', () => {
  if (overflow) return;
  try {
    const input = JSON.parse(data);
    const toolName = input && typeof input === 'object' ? input.tool_name : undefined;
    if (typeof toolName !== 'string') {
      respond('deny', 'Tool not permitted: ' + String(toolName ?? 'unknown').slice(0, 100));
      return;
    }
    if (BUILTINS.has(toolName) || toolName.startsWith(FERMI_PREFIX)) {
      respond('allow');
    } else {
      respond('deny', 'Tool not permitted: ' + toolName.slice(0, 100));
    }
  } catch {
    respond('deny', 'Malformed hook input');
  }
});
`;
}
