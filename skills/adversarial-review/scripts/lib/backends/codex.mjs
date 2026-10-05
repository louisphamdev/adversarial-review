// OpenAI Codex CLI backend adapter.
import path from 'node:path';
import { strictify } from '../schemas.mjs';

export const name = 'codex';

export function build(call, ctx = {}) {
  const { callId, runDir, cwd, model, effort, schema } = call;
  // The caller names the schema file per round, so a later round reads its own file.
  const schemaFile = call.schemaFile || path.join(runDir, 'calls', `${callId}.schema.json`);
  // The caller names the out file per attempt, so a retry cannot read the first attempt's answer.
  const outFile = call.outFile || path.join(runDir, 'calls', `${callId}.out.json`);

  const args = [
    'exec',
    '--sandbox',
    'read-only',
    '--ask-for-approval',
    'never',
    '--ephemeral',
    '--skip-git-repo-check',
    '-c',
    'mcp_servers={}',
    '-C',
    cwd,
    '--output-schema',
    schemaFile,
    '-o',
    outFile,
    ...(model ? ['-m', model] : []),
    ...(effort ? ['-c', `model_reasoning_effort=${effort}`] : []),
    '-',
  ];

  return {
    args,
    env: {},
    files: {
      [schemaFile]: JSON.stringify(strictify(schema), null, 2),
    },
    outFile,
  };
}

export function streaming() {
  return false;
}

export function extract({ stdout, outFileText } = {}) {
  return outFileText != null && outFileText !== '' ? outFileText : (stdout || '');
}
