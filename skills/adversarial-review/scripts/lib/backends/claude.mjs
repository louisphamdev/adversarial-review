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
    // Stream mode writes a line per event instead of one chunk at exit, so a stalled seat is
    // visible while it runs. `--verbose` is what makes `stream-json` emit those lines.
    '--output-format',
    'stream-json',
    '--verbose',
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

export function streaming() {
  return true;
}

function asText(value) {
  return typeof value === 'string' ? value : JSON.stringify(value);
}

/**
 * A usable answer on a `result` line is a `structured_output` that is not null and not the empty
 * string, or a non-empty `result` string. An empty one means the seat produced no answer there,
 * so the caller must keep looking (spec G2-6).
 *
 * @param {object} line
 * @returns {string|null}
 */
function answerOfResultLine(line) {
  const structured = line.structured_output;
  if (structured !== undefined && structured !== null && structured !== '') {
    return asText(structured);
  }
  if (typeof line.result === 'string' && line.result !== '') return line.result;
  return null;
}

export function extract({ stdout, outFileText } = {}) {
  if (typeof stdout !== 'string') return '';

  // `--output-format json` wrote one object with no `type`. Keep reading it, so a run that
  // resumes over a log from the old mode still finds its answer.
  try {
    const parsed = JSON.parse(stdout);
    const isPlainObject = parsed && typeof parsed === 'object' && !Array.isArray(parsed);
    // A `type` means this is one stream line, not the old envelope, so the line reader owns it.
    if (isPlainObject && parsed.type === undefined) {
      if (parsed.structured_output !== undefined) return asText(parsed.structured_output);
      if (parsed.result !== undefined) return asText(parsed.result);
    }
  } catch {
    // A stream of several lines is not one JSON object. Fall through to the line reader.
  }

  let result = null;
  let lastText = null;
  for (const line of stdout.split(/\r?\n/)) {
    let o;
    try {
      o = JSON.parse(line);
    } catch {
      continue;
    }
    if (!o || typeof o !== 'object') continue;
    if (o.type === 'result') result = o;
    if (o.type === 'assistant' && Array.isArray(o.message?.content)) {
      for (const c of o.message.content) {
        if (c?.type === 'text' && typeof c.text === 'string') lastText = c.text;
      }
    }
  }

  if (result) {
    const answer = answerOfResultLine(result);
    if (answer !== null) return answer;
  }
  if (lastText !== null) return lastText;
  return stdout;
}
