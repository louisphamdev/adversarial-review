// Custom user command backend adapter.
import path from 'node:path';
import { expandArgs } from '../proc.mjs';

export const name = 'custom';

export function build(call, ctx = {}) {
  const { callId, runDir, root, cwd, model } = call;
  const promptFile = path.join(runDir, 'calls', `${callId}.prompt.txt`);
  const schemaFile = path.join(runDir, 'calls', `${callId}.schema.json`);
  const outFile = path.join(runDir, 'calls', `${callId}.out.json`);

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

export function extract({ stdout, outFileText } = {}) {
  if (outFileText != null && outFileText !== '') {
    return outFileText;
  }
  return stdout || '';
}
