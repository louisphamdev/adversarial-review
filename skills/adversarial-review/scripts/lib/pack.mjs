// Context pack for a seat prompt (spec 3.1-A, A9 and section 10 G2-1).
import path from 'node:path';
import fs from 'node:fs/promises';
import { runChild as defaultRunChild } from './proc.mjs';
import { isSecretRel } from './sandbox.mjs';
import { materialDiffPaths, containedPath } from './diff-paths.mjs';
import { safeGitArgs } from './integrity.mjs';

const KEYWORDS = new Set(['if', 'for', 'while', 'switch', 'catch', 'return', 'function', 'class', 'new', 'else', 'try']);
const DEF_RES = [/function\s+([A-Za-z_$][\w$]*)/, /^\s*([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*\{/, /class\s+([A-Za-z_$][\w$]*)/, /def\s+([A-Za-z_]\w*)/, /const\s+([A-Za-z_$][\w$]*)\s*=/];

export function definedNames(diffText) {
  const names = new Set();
  for (const line of String(diffText).split('\n')) {
    if (!/^[+-]/.test(line) || /^(\+\+\+|---)/.test(line)) continue;
    const body = line.slice(1);
    for (const re of DEF_RES) {
      const m = body.match(re);
      if (m && m[1].length >= 3 && !KEYWORDS.has(m[1])) names.add(m[1]);
    }
  }
  return [...names];
}

export async function buildContextPack({ material, treeDir, repoRoot, packChars = 60000, runChild = defaultRunChild }) {
  const sections = [];
  let used = 0, skippedSecrets = 0;
  // `sections.join('\n')` adds one separator per later section, so the budget must count it.
  // Without it the written file is longer than `packChars`, which is the one hard guarantee here.
  const add = (header, body) => {
    const block = `=== ${header} ===\n${body}\n`;
    const sep = sections.length ? 1 : 0;
    if (used + sep + block.length > packChars) return false;
    sections.push(block); used += sep + block.length; return true;
  };
  const readTree = async (rel) => {
    if (isSecretRel(rel)) { skippedSecrets++; return null; }
    const real = await containedPath(treeDir, rel);
    if (!real) return null;
    try { return await fs.readFile(real, 'utf8'); } catch { return null; }
  };

  add(material.kind === 'diff' ? '.ar-review/material.diff' : 'material', String(material.text || '').slice(0, packChars - 64));

  if (material.kind === 'diff') {
    const files = [];
    for (const rel of materialDiffPaths(material.text)) {
      const text = await readTree(rel);
      if (text != null) files.push({ rel, text });
    }
    files.sort((a, b) => a.text.length - b.text.length);
    for (const f of files) add(`${f.rel} (full file)`, f.text);
    const hooks = path.join(path.dirname(treeDir), 'empty-hooks');
    await fs.mkdir(hooks, { recursive: true });
    for (const name of definedNames(material.text)) {
      const res = await runChild({ cmd: 'git', args: [...safeGitArgs(hooks), 'grep', '-n', '-w', '-I', '--no-color', '-e', name], cwd: repoRoot, timeoutMs: 10000 });
      if (res.code !== 0 || res.timedOut) continue;
      const hits = [];
      for (const line of res.stdout.split('\n').filter(Boolean).slice(0, 20)) {
        const rel = line.split(':')[0];
        if (isSecretRel(rel)) { skippedSecrets++; continue; }
        hits.push(line.slice(0, 400));
      }
      if (hits.length && !add(`callers of ${name}`, hits.join('\n'))) break;
    }
  } else if (material.kind === 'dir') {
    // Directory material: file list, then text, smallest first, from the tree only.
    const walk = async (rel = '') => (await fs.readdir(path.join(treeDir, rel), { withFileTypes: true })).flatMap((e) => (e.name === '.ar-review' ? [] : [{ e, r: rel ? `${rel}/${e.name}` : e.name }]));
    const list = [];
    const stack = [''];
    while (stack.length) for (const { e, r } of await walk(stack.pop())) (e.isDirectory() ? stack.push(r) : list.push(r));
    add('file list', list.join('\n'));
    const texts = [];
    for (const rel of list) { const t = await readTree(rel); if (t != null) texts.push({ rel, t }); }
    texts.sort((a, b) => a.t.length - b.t.length);
    for (const { rel, t } of texts) add(rel, t);
  }

  const out = path.join(treeDir, '.ar-review', 'pack.txt');
  await fs.mkdir(path.dirname(out), { recursive: true });
  const text = sections.join('\n');
  await fs.writeFile(out, text);
  return { path: out, chars: text.length, sections: sections.length, skippedSecrets };
}
