// Custom user command backend adapter.
import path from 'node:path';
import { expandArgs } from '../proc.mjs';

export const name = 'custom';

export function build(call, ctx = {}) {
  const { callId, runDir, root, cwd, model } = call;
  // The caller names the prompt and schema files per round, so a later round reads its own files.
  const promptFile = call.promptFile || path.join(runDir, 'calls', `${callId}.prompt.txt`);
  const schemaFile = call.schemaFile || path.join(runDir, 'calls', `${callId}.schema.json`);
  // The caller names the out file per attempt, so a retry cannot read the first attempt's answer.
  const outFile = call.outFile || path.join(runDir, 'calls', `${callId}.out.json`);

  const template =
    ctx.command ||
    ctx.config?.backends?.custom?.command ||
    call.config?.backends?.custom?.command ||
    [];

  const hasOutFile =
    Array.isArray(template) &&
    template.some((arg) => String(arg).includes('{outFile}'));

  const expanded = expandArgs(template, {
    promptFile,
    schemaFile,
    outFile,
    root,
    cwd,
    model: model || '',
  });

  return {
    args: expanded,
    env: {},
    files: {},
    outFile: hasOutFile ? outFile : undefined,
  };
}

export function streaming() {
  return false;
}

export function extract({ stdout, outFileText } = {}) {
  if (outFileText != null && outFileText !== '') {
    return outFileText;
  }
  return stdout || '';
}
