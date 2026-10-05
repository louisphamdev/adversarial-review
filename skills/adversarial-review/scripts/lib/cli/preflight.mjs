// CLI preflight command: resolve a run once, write the decision bundle, and record the answers.
// It starts no seat and writes only its own bundle file.
import path from 'node:path';
import fs from 'node:fs/promises';
import crypto from 'node:crypto';
import { resolveRunPlan } from '../runplan.mjs';
import { buildBundle, applyAnswers, verifyBundle } from '../bundle.mjs';
import { COMMAND_OPTIONS } from './args.mjs';
import { stateDir } from '../paths.mjs';
import { ConfigError } from '../errors.mjs';

// The run flags a bundle records: what `run` would have been given, nothing that only steers preflight.
const RUN_FLAG_KEYS = Object.keys(COMMAND_OPTIONS.run).filter((k) => !['resume', 'detach', 'json', 'from-preflight'].includes(k));

function runFlagsOf(flags) {
  const out = {};
  for (const k of RUN_FLAG_KEYS) if (flags[k] !== undefined) out[k] = flags[k];
  return out;
}

function stamp(ms = Date.now()) {
  return new Date(ms).toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
}

// A bundle is never overwritten: `--out` must be a new path, and the default name gets a suffix.
async function writeBundle(bundle, out, env) {
  const text = JSON.stringify(bundle, null, 2) + '\n';
  if (out) {
    try {
      await fs.writeFile(out, text, { flag: 'wx' });
    } catch (err) {
      if (err && err.code === 'EEXIST') throw new ConfigError(`--out already exists: ${out}`);
      throw err;
    }
    return path.resolve(out);
  }
  const dir = path.join(stateDir(env), 'preflight');
  await fs.mkdir(dir, { recursive: true });
  const base = `${stamp()}-${bundle.bundleHash.slice(0, 8)}`;
  for (let i = 0; ; i++) {
    const file = path.join(dir, i === 0 ? `${base}.json` : `${base}-${crypto.randomBytes(2).toString('hex')}.json`);
    try {
      await fs.writeFile(file, text, { flag: 'wx' });
      return file;
    } catch (err) {
      if (!(err && err.code === 'EEXIST') || i >= 5) throw err;
    }
  }
}

// `id=value`, exactly one `=`, both sides non-empty.
function parseAnswers(list) {
  const answers = {};
  for (const raw of [].concat(list || [])) {
    const parts = String(raw).split('=');
    if (parts.length !== 2 || !parts[0] || !parts[1]) {
      throw new ConfigError(`--answer must be <id>=<value>: ${JSON.stringify(raw)}`);
    }
    if (Object.hasOwn(answers, parts[0])) throw new ConfigError(`--answer ${parts[0]} is given twice`);
    answers[parts[0]] = parts[1];
  }
  return answers;
}

async function readBundle(file) {
  let bundle;
  try {
    bundle = JSON.parse(await fs.readFile(file, 'utf8'));
  } catch (err) {
    throw new ConfigError(`cannot read bundle ${file}: ${err.message}`);
  }
  verifyBundle(bundle);
  return bundle;
}

/**
 * `preflight [run flags] [--out f] [--json]` or
 * `preflight --answer-bundle f --answer id=value ... [--out f] [--json]`.
 */
export async function preflightCommand(
  flags = {},
  positionals = [],
  { env = process.env, cwd = process.cwd(), stdout = process.stdout, stderr = process.stderr } = {}
) {
  try {
    const out = flags.out ? path.resolve(cwd, flags.out) : null;
    let bundle;
    const answerBundle = flags['answer-bundle'] || flags.answerBundle;
    if (answerBundle) {
      const answers = parseAnswers(flags.answer);
      bundle = applyAnswers(await readBundle(path.resolve(cwd, answerBundle)), answers);
    } else {
      if (flags.answer) throw new ConfigError('--answer needs --answer-bundle');
      const runFlags = runFlagsOf(flags);
      const plan = await resolveRunPlan(runFlags, { env, cwd, stderr });
      bundle = buildBundle(plan, runFlags, { config: plan.config });
    }
    const file = await writeBundle(bundle, out, env);
    if (flags.json) stdout.write(JSON.stringify({ path: file, bundle }, null, 2) + '\n');
    else stdout.write(`${file}\n`);
    return 0;
  } catch (err) {
    if (err instanceof ConfigError) {
      stderr.write(`Error: ${err.message}\n`);
      return 2;
    }
    throw err;
  }
}

export { readBundle };
