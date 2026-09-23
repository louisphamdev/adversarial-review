// OpenCode backend adapter.
export const name = 'opencode';

export function build(call, ctx = {}) {
  const { root, runDir, model, effort } = call;

  const modelArg = model
    ? ['-m', model.includes('#') || !effort ? model : `${model}#${effort}`]
    : [];

  const args = [
    'run',
    '--auto',
    '--agent',
    'adversarial-review-seat',
    ...modelArg,
  ];

  const normRoot = root ? root.replace(/\\/g, '/') : '';
  const normRunDir = runDir ? runDir.replace(/\\/g, '/') : '';

  const env = {
    OPENCODE_CONFIG_CONTENT: JSON.stringify({
      permission: {
        external_directory: {
          '*': 'deny',
          [`${normRoot}/**`]: 'allow',
          [`${normRunDir}/**`]: 'allow',
        },
      },
    }),
  };

  return {
    args,
    env,
    files: {},
  };
}

export function extract({ stdout, outFileText } = {}) {
  return stdout || '';
}
