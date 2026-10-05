// Sandbox tree and lane permission profiles (spec 3.1-A, A6, A7, section 10).
import path from 'node:path';
import fs from 'node:fs/promises';
import os from 'node:os';
import { runChild as defaultRunChild } from './proc.mjs';
import { safeGitArgs, listIntegrityPaths } from './integrity.mjs';
import { writeFileAtomic } from './fsx.mjs';
import { materialDiffPaths, containedPath, decodeGitPath } from './diff-paths.mjs';
import { isSecretPath } from './jev.mjs';

export { decodeGitPath };

export const PROFILE_STEPS = Object.freeze({ 'weak-find': 8, 'strong-find': 16, short: 4, probe: 2, bench: 16, canary: 10 });

const SECRET_RES = [
  /^\.env$/, /^\.env\..+/, /\.pem$/, /\.key$/, /\.p12$/, /\.pfx$/, /\.jks$/, /\.keystore$/, /\.ppk$/,
  /^id_rsa/, /^id_ed25519/, /^id_ecdsa/, /^id_dsa/, /^credentials\.json$/, /^\.npmrc$/, /^\.netrc$/,
  /^\.git-credentials$/, /^\.pypirc$/, /\.tfvars$/,
];

export const isSecretName = (base) => SECRET_RES.some((re) => re.test(String(base).toLowerCase()));

// The tree and the pack go to free providers, so they also apply the Jev path rule to every part.
export const isSecretRel = (rel) => isSecretName(path.posix.basename(String(rel).replace(/\\/g, '/'))) || isSecretPath(rel);

// A permission resource cannot escape these, so a run path that holds one disables the swarm.
export const hasGlobChars = (p) => /[*?[\]{}]/.test(String(p));

const fwd = (p) => String(p).replace(/\\/g, '/');

function materialPaths(material) {
  return material?.kind === 'diff' ? materialDiffPaths(material.text) : [];
}

export async function planSandbox({ repoRoot, material, runChild = defaultRunChild, hooksDir }) {
  const hooks = hooksDir || path.join(os.tmpdir(), 'ar-empty-hooks');
  await fs.mkdir(hooks, { recursive: true });
  const res = await runChild({ cmd: 'git', args: [...safeGitArgs(hooks), 'ls-files', '-c', '-z'], cwd: repoRoot });
  let listed = res.code === 0 ? res.stdout.split('\0').filter(Boolean) : null;
  if (!listed) {
    listed = (await listIntegrityPaths(repoRoot, { hooksDir: hooks, runChild })).filter((p) => !p.startsWith('.git/'));
  }
  // Only the material is untrusted: git ls-files never names a path outside the work tree.
  const trusted = new Set(listed);
  const all = [...new Set([...listed, ...materialPaths(material)])];
  const files = [];
  let bytes = 0;
  let skippedSecrets = 0;
  let skippedMissing = 0;
  let skippedReserved = 0;
  let skippedOutside = 0;
  for (const rel of all) {
    if (rel.split('/')[0].toLowerCase() === '.ar-review') { skippedReserved++; continue; }
    if (isSecretRel(rel)) { skippedSecrets++; continue; }
    let st;
    try {
      st = await fs.lstat(path.join(repoRoot, rel));
    } catch {
      skippedMissing++;
      continue;
    }
    if (!st.isFile()) { skippedMissing++; continue; }
    if (!trusted.has(rel) && !(await containedPath(repoRoot, rel))) { skippedOutside++; continue; }
    files.push(rel);
    bytes += st.size;
  }
  return { files, bytes, skippedSecrets, skippedMissing, skippedReserved, skippedOutside };
}

async function copyLimited(pairs, limit = 16) {
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(limit, pairs.length) }, async () => {
    while (i < pairs.length) {
      const [from, to] = pairs[i++];
      await fs.mkdir(path.dirname(to), { recursive: true });
      await fs.copyFile(from, to);
    }
  }));
}

export async function createSandbox({ repoRoot, runDir, material, config = {}, runChild }) {
  const treeDir = path.join(runDir, 'sandbox', 'tree');
  const plan = await planSandbox({ repoRoot, material, runChild, hooksDir: path.join(runDir, 'empty-hooks') });
  const maxFiles = config.sandbox?.maxFiles ?? 20000;
  const maxBytes = config.sandbox?.maxBytes ?? 524288000;
  const base = {
    treeDir,
    fileCount: plan.files.length,
    bytes: plan.bytes,
    skippedSecrets: plan.skippedSecrets,
    skippedMissing: plan.skippedMissing,
    skippedOutside: plan.skippedOutside,
  };
  // The caps are read from the listing, before the first copy: a partial tree gives a false view.
  if (plan.files.length > maxFiles || plan.bytes > maxBytes) {
    return { ...base, overCap: { files: plan.files.length, bytes: plan.bytes } };
  }
  await fs.rm(treeDir, { recursive: true, force: true });
  await fs.mkdir(treeDir, { recursive: true });
  await copyLimited(plan.files.map((rel) => [path.join(repoRoot, rel), path.join(treeDir, rel)]));
  await fs.mkdir(path.join(treeDir, '.ar-review'), { recursive: true });
  if (material?.kind === 'diff') {
    await fs.writeFile(path.join(treeDir, '.ar-review', 'material.diff'), String(material.text || ''));
  }
  return { ...base, overCap: null };
}

// The last matching rule wins, so the order of this list is the read-only boundary itself.
// Rule 4 exists only to keep the `shell` tool in the list, which the free tier requires.
function rules(treeDir) {
  const t = `${fwd(treeDir)}/*`;
  return [
    { action: '*', resource: '*', effect: 'deny' },
    { action: 'read', resource: t, effect: 'allow' },
    { action: 'glob', resource: '*', effect: 'allow' },
    { action: 'grep', resource: '*', effect: 'allow' },
    { action: 'external_directory', resource: t, effect: 'allow' },
    { action: 'shell', resource: 'git --version', effect: 'allow' },
    ...['edit', 'subagent', 'question', 'webfetch', 'websearch', 'execute'].map((a) => ({ action: a, resource: '*', effect: 'deny' })),
  ];
}

// A zen lane runs `--standalone` with this XDG home, so this file is the only config it reads.
// The keys `instructions`, `mcp`, `plugin`, and `provider` are absent on purpose: the user's own
// `mcp` block starts one full set of MCP servers per lane directory and outlives the lane.
export async function writeProfileConfig({ runDir, profileKey, treeDir, steps }) {
  const cwd = path.join(runDir, 'sandbox', 'profiles', profileKey);
  const xdgHome = path.join(runDir, 'sandbox', 'xdg', profileKey, 'zen');
  await fs.mkdir(cwd, { recursive: true });
  await fs.mkdir(path.join(xdgHome, 'opencode'), { recursive: true });
  const cfg = { $schema: 'https://opencode.ai/config.json', agents: { build: { steps, permissions: rules(treeDir) } } };
  await writeFileAtomic(path.join(xdgHome, 'opencode', 'opencode.json'), JSON.stringify(cfg, null, 2));
  return { cwd, xdgHome };
}

// The provider block holds a key: it lives only under sandbox/xdg, which removeSandbox always deletes.
export async function writeNamedConfig({ runDir, profileKey, provider, providerBlock, treeDir, steps }) {
  const xdgHome = path.join(runDir, 'sandbox', 'xdg', profileKey, provider);
  await fs.mkdir(path.join(xdgHome, 'opencode'), { recursive: true });
  const cfg = {
    $schema: 'https://opencode.ai/config.json',
    provider: { [provider]: providerBlock },
    agents: { 'ar-seat': { mode: 'primary', steps, permissions: rules(treeDir) } },
  };
  await fs.writeFile(path.join(xdgHome, 'opencode', 'opencode.json'), JSON.stringify(cfg), { mode: 0o600 });
  return { xdgHome };
}

// The opencode service can hold a cwd handle for a moment after a lane ends.
async function rmRetry(p) {
  for (let i = 0; i < 3; i++) {
    try {
      await fs.rm(p, { recursive: true, force: true });
      return true;
    } catch {
      await new Promise((r) => setTimeout(r, 500));
    }
  }
  return false;
}

export async function removeSandbox(runDir, { keep = false, log = () => {} } = {}) {
  const sb = path.join(runDir, 'sandbox');
  if (!(await rmRetry(path.join(sb, 'xdg')))) log(`could not delete ${path.join(sb, 'xdg')}`);
  if (keep) return;
  if (!(await rmRetry(sb))) log(`could not delete ${sb}`);
}
