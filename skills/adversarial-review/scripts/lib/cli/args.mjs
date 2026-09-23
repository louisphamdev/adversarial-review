// Strict CLI argument parsing with node:util parseArgs (§18.1).
import { parseArgs as utilParseArgs } from 'node:util';
import { ConfigError } from '../errors.mjs';

function toCamelCase(str) {
  return str.replace(/-([a-z0-9])/g, (_, c) => c.toUpperCase());
}

export const COMMAND_OPTIONS = {
  run: {
    target: { type: 'string' },
    base: { type: 'string' },
    stage: { type: 'string' },
    seats: { type: 'string' },
    'requirements-file': { type: 'string' },
    backend: { type: 'string' },
    route: { type: 'string' },
    'allow-gaps': { type: 'boolean' },
    until: { type: 'string' },
    detach: { type: 'boolean' },
    resume: { type: 'string' },
    'allow-drift': { type: 'boolean' },
    json: { type: 'boolean' },
    budget: { type: 'string' },
    model: { type: 'string' },
  },
  status: {
    latest: { type: 'boolean' },
    json: { type: 'boolean' },
  },
  'patch-review': {
    plan: { type: 'string' },
    json: { type: 'boolean' },
  },
  verify: {
    base: { type: 'string' },
    json: { type: 'boolean' },
  },
  sift: {
    material: { type: 'string' },
    findings: { type: 'string' },
    out: { type: 'string' },
  },
  recommend: {
    target: { type: 'string' },
    json: { type: 'boolean' },
  },
  quota: {
    gate: { type: 'string' },
    json: { type: 'boolean' },
  },
  models: {
    backend: { type: 'string' },
    model: { type: 'string' },
    limit: { type: 'string' },
    json: { type: 'boolean' },
  },
  hook: {
    host: { type: 'string' },
    event: { type: 'string' },
  },
  doctor: {
    probe: { type: 'boolean' },
  },
  install: {
    host: { type: 'string' },
    project: { type: 'boolean' },
    'dry-run': { type: 'boolean' },
    force: { type: 'boolean' },
    adopt: { type: 'boolean' },
    'quota-hook': { type: 'boolean' },
  },
  uninstall: {
    host: { type: 'string' },
    project: { type: 'boolean' },
    'v2-hooks': { type: 'boolean' },
    global: { type: 'boolean' },
  },
};

export function parseArgs(argv = [], spec) {
  if (!Array.isArray(argv)) {
    throw new ConfigError('argv must be an array of strings');
  }

  if (argv.length === 0) {
    return { command: 'help', flags: {}, positionals: [] };
  }

  const first = argv[0];
  if (first === '--version' || first === '-v') {
    return { command: 'version', flags: {}, positionals: [] };
  }
  if (first === '--help' || first === '-h' || first === 'help') {
    return { command: 'help', flags: {}, positionals: argv.slice(1) };
  }

  let command = null;
  let remaining = argv;

  if (!first.startsWith('-')) {
    command = first;
    remaining = argv.slice(1);
  }

  let options = {};
  let allowPositionals = true;

  if (spec && typeof spec === 'object') {
    if (spec.options) {
      options = spec.options;
      if (spec.allowPositionals !== undefined) {
        allowPositionals = Boolean(spec.allowPositionals);
      }
    } else if (command && spec[command]?.options) {
      options = spec[command].options;
      if (spec[command].allowPositionals !== undefined) {
        allowPositionals = Boolean(spec[command].allowPositionals);
      }
    }
  } else if (command && COMMAND_OPTIONS[command]) {
    options = COMMAND_OPTIONS[command];
  }

  let parsed;
  try {
    parsed = utilParseArgs({
      args: remaining,
      options,
      strict: true,
      allowPositionals,
    });
  } catch (err) {
    throw new ConfigError(err.message);
  }

  const flags = {};
  for (const [key, val] of Object.entries(parsed.values || {})) {
    flags[key] = val;
    const camel = toCamelCase(key);
    if (camel !== key) {
      flags[camel] = val;
    }
  }

  return {
    command,
    flags,
    positionals: parsed.positionals || [],
  };
}
