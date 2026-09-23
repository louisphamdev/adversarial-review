// Claude Code backend adapter.
export const name = 'claude';

export function build(call, ctx = {}) {
  const { root, runDir, model, effort, schema } = call;
  const isCmdShim = Boolean(ctx.isCmdShim);

  const args = [
    '-p',
    '--restricted',
    '--safe-mode',
    '--strict-mcp-config',
    '--tools',
    'Read',
    'Grep',
    'Glob',
    '--allowedTools',
    'Read',
    'Grep',
    'Glob',
    '--permission-mode',
    'dontAsk',
    '--add-dir',
    root,
    '--add-dir',
    runDir,
    '--output-format',
    'json',
    ...(model ? ['--model', model] : []),
    ...(effort ? ['--effort', effort] : []),
    ...(isCmdShim ? [] : ['--json-schema', JSON.stringify(schema)]),
  ];

  return {
    args,
    env: {},
    files: {},
  };
}

export function extract({ stdout, outFileText } = {}) {
  if (typeof stdout !== 'string') return '';
  try {
    const parsed = JSON.parse(stdout);
    if (parsed && typeof parsed === 'object') {
      if (parsed.structured_output !== undefined) {
        return typeof parsed.structured_output === 'string'
          ? parsed.structured_output
          : JSON.stringify(parsed.structured_output);
      }
      if (parsed.result !== undefined) {
        return typeof parsed.result === 'string'
          ? parsed.result
          : JSON.stringify(parsed.result);
      }
    }
  } catch {
    // Return stdout directly on parse error so fenced blocks can be extracted.
  }
  return stdout;
}
