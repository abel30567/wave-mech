import type { ToolAccessOptions } from '../../shared/access-contracts.js';

const BUILTIN_TOOLS = ['WebSearch', 'WebFetch', 'ToolSearch'] as const;

const MCP_ALLOWED_TOOLS = [
  'mcp__fermi__memory_recall',
  'mcp__fermi__skill_search',
  'mcp__fermi__skill_load',
] as const;

const ALLOWED_TOOLS: readonly string[] = [...BUILTIN_TOOLS, ...MCP_ALLOWED_TOOLS];

const DENIED_TOOLS = [
  'mcp__fermi__secret_resolve',
  'mcp__fermi__skill_set',
  'mcp__fermi__execute',
];

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
      allow: [...ALLOWED_TOOLS],
      deny: [...DENIED_TOOLS],
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
    '--allowedTools', ALLOWED_TOOLS.join(','),
    '--disallowedTools', DENIED_TOOLS.join(','),
    '--settings', JSON.stringify(settings),
  ];
}

export function permissionHookSource(): string {
  const whitelist = JSON.stringify(ALLOWED_TOOLS);
  return `'use strict';
const WHITELIST = new Set(${whitelist});
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
    if (typeof toolName === 'string' && WHITELIST.has(toolName)) {
      respond('allow');
    } else {
      respond('deny', 'Tool not permitted: ' + String(toolName ?? 'unknown').slice(0, 100));
    }
  } catch {
    respond('deny', 'Malformed hook input');
  }
});
`;
}
