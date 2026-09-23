// Gemini CLI backend adapter.
import path from 'node:path';

export const name = 'gemini';

export function build(call, ctx = {}) {
  const { root, runDir, model } = call;
  const settingsFile = path.join(runDir, 'gemini-settings.json');

  const args = [
    '--approval-mode',
    'default',
    '--output-format',
    'json',
    '--include-directories',
    `${root},${runDir}`,
    ...(model ? ['-m', model] : []),
  ];

  const env = {
    GEMINI_CLI_SYSTEM_SETTINGS_PATH: settingsFile,
  };

  const files = {
    [settingsFile]: JSON.stringify(
      {
        tools: {
          core: ['read_file', 'read_many_files', 'glob', 'search_file_content', 'list_directory'],
        },
        mcpServers: {},
      },
      null,
      2
    ),
  };

  return {
    args,
    env,
    files,
  };
}

export function extract({ stdout, outFileText } = {}) {
  if (typeof stdout !== 'string') return '';
  try {
    const parsed = JSON.parse(stdout);
    if (parsed && typeof parsed === 'object' && parsed.response !== undefined) {
      return typeof parsed.response === 'string'
        ? parsed.response
        : JSON.stringify(parsed.response);
    }
  } catch {
    // Return stdout directly on parse error so fenced blocks can be extracted.
  }
  return stdout;
}
