// The decision sift: one focused Jev request per finding, scoped to the reviewed material.
import fs from 'node:fs/promises';
import path from 'node:path';
import { askJev, resolveJevTarget, mapLimit, capText, appendJevLog, isSecretPath, findKey, JEV_STATE_CAP } from './jev.mjs';

export { findKey, DEFAULT_URL, DEFAULT_MODEL, TYPESAFE_API_URL, TYPESAFE_DEFAULT_MODEL } from './jev.mjs';

const EXCERPT_CAP = 3000;
const MARGIN = 6;
const MAX_FILE_BYTES = 2 * 1024 * 1024;
const slash = (p) => String(p ?? '').replace(/\\/g, '/').replace(/^([A-Za-z]):/, (_, d) => `${d.toLowerCase()}:`);

// Clusters findings by file/line or claim to detect duplicate issues across seats.
export function clusterFindings(findings = [], rows = []) {
  if (!Array.isArray(findings) || findings.length === 0) return [];
  const rowMap = new Map((rows || []).map((r) => [r.id, r]));

  const groups = new Map();
  for (const f of findings) {
    const file = f.file || (f.evidence ? f.evidence.split(':')[0].trim() : '') || 'unknown';
    let line = f.line != null ? String(f.line) : '';
    if (!line && f.evidence && f.evidence.includes(':')) {
      const match = f.evidence.match(/:(\d+)/);
      if (match) line = match[1];
    }
    const claimSnippet = (f.claim || f.title || '').slice(0, 30).toLowerCase().trim();
    const key = file !== 'unknown' && line ? `${file}:${line}` : `${file}#${claimSnippet}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(f);
  }

  const clusters = [];
  for (const [key, group] of groups.entries()) {
    if (group.length > 1) {
      const sorted = [...group].sort((a, b) => {
        const ra = rowMap.get(a.id);
        const rb = rowMap.get(b.id);
        const scoreA = (ra?.severity ?? 0) * 10 + (ra?.confidence ?? 0);
        const scoreB = (rb?.severity ?? 0) * 10 + (rb?.confidence ?? 0);
        return scoreB - scoreA;
      });
      clusters.push({
        key,
        canonical: sorted[0].id,
        duplicates: sorted.slice(1).map((f) => f.id),
        count: group.length,
      });
    }
  }
  return clusters;
}

// The excerpt scope: the only files whose lines may leave the machine (spec B8).
export async function materialScopeOf(request = {}, runChild) {
  const root = slash(request.repoRoot || '');
  const join = (base, rel) => slash(path.posix.join(slash(base), slash(rel)));
  const kind = request.materialKind || request.material?.kind;
  const scope = { files: [], runMaterial: request.materialPath ? slash(request.materialPath) : null };
  if (kind === 'diff') {
    const text = String(request.material?.text ?? '');
    const untracked = text.match(/^# Untracked files[^\n]*\n([\s\S]*?)(?:\n\n|$)/m);
    if (untracked) for (const l of untracked[1].split('\n').map((s) => s.trim()).filter(Boolean)) scope.files.push(join(root, l));
    for (const m of text.matchAll(/^diff --git a\/.* b\/(.*)$/gm)) scope.files.push(join(root, m[1]));
  } else if (kind === 'file') {
    const t = request.material?.targetPath || request.target;
    if (t) scope.files.push(slash(t));
  } else if (kind === 'dir' || kind === 'directory') {
    // Fail closed: outside git, or when git fails, the scope stays empty.
    const dir = slash(request.material?.path || request.target || root);
    if (typeof runChild === 'function') {
      const r = await runChild({ cmd: 'git', args: ['-c', 'core.quotepath=false', 'ls-files', '-z', '--cached', '--others', '--exclude-standard'], cwd: dir });
      if (r.code === 0) for (const rel of r.stdout.split('\0').filter(Boolean)) scope.files.push(join(dir, rel));
    }
  }
  scope.files = [...new Set(scope.files)];
  return scope;
}

function citedLines(f, base) {
  const nums = [];
  for (const m of String(f.line ?? '').matchAll(/(\d+)(?:\s*-\s*(\d+))?/g)) nums.push([Number(m[1]), Number(m[2] ?? m[1])]);
  for (const m of String(f.evidence ?? '').matchAll(/([\w.\-/\\]+):(\d+)(?:-(\d+))?/g)) {
    if (path.basename(slash(m[1])) === base) nums.push([Number(m[2]), Number(m[3] ?? m[2])]);
  }
  return nums;
}

export async function buildExcerpt(finding = {}, { scope = { files: [], runMaterial: null }, repoRoot = '', runDir = '' } = {}) {
  if (!finding.file) return { text: '', action: 'missing' };
  const rel = slash(finding.file);
  const base = path.posix.basename(rel);
  // 1. Resolve the cited path.
  const cited = (base === 'material.txt' || base === 'material.diff') && scope.runMaterial
    ? scope.runMaterial
    : slash(path.resolve(repoRoot || '.', rel));
  // 2. Secret patterns on every segment of the cited path, case-insensitive.
  if (isSecretPath(rel) || isSecretPath(cited)) return { text: '', action: 'secret_path' };
  // 3. lstat, realpath, and the secret patterns again on the realpath.
  let st;
  let real;
  try {
    st = await fs.lstat(cited);
    real = slash(await fs.realpath(cited));
  } catch {
    return { text: '', action: 'missing' };
  }
  if (isSecretPath(real)) return { text: '', action: 'secret_path' };
  const roots = [];
  const viaRoot = [];
  for (const r of [repoRoot, runDir]) {
    if (!r) continue;
    try {
      const realRoot = slash(await fs.realpath(r)).replace(/\/$/, '');
      roots.push(realRoot);
      if (real.startsWith(`${realRoot}/`)) viaRoot.push(slash(path.posix.join(slash(r), real.slice(realRoot.length + 1))));
    } catch {
      // A missing root cannot contain the file.
    }
  }
  // 4. Root containment of the realpath. It comes first: a temp directory under a link (macOS /var)
  // or an 8.3 name (Windows) makes the realpath differ, and the scope check would hide the reason.
  if (!roots.some((r) => real === r || real.startsWith(`${r}/`))) return { text: '', action: 'outside_root' };
  // 5. Scope membership: the cited path, or, when a link sits anywhere on the path, its realpath.
  const inScope = (p) => p === scope.runMaterial || scope.files.includes(p);
  const linked = st.isSymbolicLink() || !viaRoot.concat(real).includes(cited);
  if (linked ? !(inScope(real) || viaRoot.some(inScope)) : !inScope(cited)) return { text: '', action: 'not_in_material' };
  // 6. Size, then 7. read the realpath that was tested.
  const rst = await fs.stat(real);
  if (rst.size > MAX_FILE_BYTES) return { text: '', action: 'too_large' };
  const lines = (await fs.readFile(real, 'utf8')).split(/\r?\n/);
  const keep = new Set();
  for (const [a, b] of citedLines(finding, base)) {
    for (let i = Math.max(1, a - MARGIN); i <= Math.min(lines.length, b + MARGIN); i++) keep.add(i);
  }
  let out = '';
  let prev = 0;
  for (const i of [...keep].sort((x, y) => x - y)) {
    const line = `${i}: ${lines[i - 1]}\n`;
    if (out.length + line.length > EXCERPT_CAP) {
      out += '...(cut)\n';
      break;
    }
    if (prev && i !== prev + 1) out += '...\n';
    out += line;
    prev = i;
  }
  return { text: out, action: 'asked' };
}

export function buildSiftState({ stage = 'code', finding = {}, excerpt = '', challenges = '' }) {
  const head = `REVIEW STAGE: ${stage} review. The MATERIAL EXCERPT is the only part of the reviewed material shown here.`;
  const fields = {
    title: String(finding.title ?? ''),
    detail: String(finding.detail ?? ''),
    evidence: String(finding.evidence ?? ''),
    doneWhen: String(finding.doneWhen ?? ''),
  };
  let ex = String(excerpt ?? '');
  let ch = String(challenges ?? '');
  const render = () =>
    [
      head,
      `FINDING (claimed severity ${finding.severity ?? 'unknown'}, raised by the ${finding.seat ?? 'unknown'} reviewer)\nTitle: ${fields.title}\nDetail: ${fields.detail}\nEvidence cited: ${fields.evidence}\nFixed when: ${fields.doneWhen}`,
      `MATERIAL EXCERPT\n${ex || '(no excerpt)'}`,
      ch ? `CHALLENGES AND OWNER ANSWER\n${ch}` : '',
    ].filter(Boolean).join('\n\n');
  let state = render();
  let cut = false;
  if (state.length > JEV_STATE_CAP) { cut = true; ex = capText(ex, 1000); state = render(); }
  if (state.length > JEV_STATE_CAP) { ch = capText(ch, 1000); state = render(); }
  if (state.length > JEV_STATE_CAP) { fields.detail = capText(fields.detail, 500); state = render(); }
  if (state.length > JEV_STATE_CAP) {
    for (const k of Object.keys(fields)) fields[k] = capText(fields[k], 900);
    state = render();
  }
  if (state.length > JEV_STATE_CAP) state = capText(state, JEV_STATE_CAP);
  return { state, cut };
}

export function SIFT_QUESTIONS(disputed) {
  const q = {
    grounded: {
      type: 'choice',
      instructions: 'Does the MATERIAL EXCERPT contain the text or code that the evidence quotes or cites?',
      criteria: { yes: 'the cited text is in the excerpt', partly: 'some of it is in the excerpt, some is not shown', no: 'the excerpt does not contain it, or contradicts the quote' },
    },
    happens: {
      type: 'choice',
      instructions: 'Read the excerpt as written. Does the failure described in the FINDING actually occur?',
      criteria: { happens: 'a realistic input, caller, or reader triggers the described failure', unclear: 'the excerpt alone cannot show whether it occurs', does_not: 'the excerpt shows it cannot occur or is already handled' },
    },
    impact: {
      type: 'score',
      instructions: 'If the failure occurs, how bad is the consequence for the user of this software?',
      criteria: ['wording, naming, or taste only', 'wrong only in a rare corner case', 'wrong in normal use, a security hole, or data loss'],
    },
  };
  if (disputed) {
    q.survives = {
      type: 'choice',
      instructions: 'Weigh the CHALLENGES against the OWNER ANSWER. Does the finding survive?',
      criteria: { survives: 'the owner answer meets every challenge and the defect remains', falls: 'the owner withdrew, or a challenge shows the claim is wrong, unreachable, or out of scope' },
    };
  }
  return q;
}

const P = (row, q, label) => row?.p?.[q]?.[label] ?? 0;

export function readingOrderOf(rows = []) {
  const used = rows.filter((r) => r.status === 'used');
  const doubt = (r) => Math.max(P(r, 'happens', 'does_not'), P(r, 'survives', 'falls'));
  const first = used.filter((r) => doubt(r) >= 0.5).sort((a, b) => doubt(b) - doubt(a));
  const rest = used.filter((r) => doubt(r) < 0.5).sort((a, b) => P(a, 'grounded', 'yes') - P(b, 'grounded', 'yes'));
  return [...first, ...rest].map((r) => r.id);
}

export async function siftFindings({ findings, rebuttals = [], scope = { files: [], runMaterial: null }, repoRoot = '', runDir = '', stage = 'code', config = {}, env = process.env, fetch: f = globalThis.fetch, signal } = {}) {
  try {
    const siftCfg = config?.sift && typeof config.sift === 'object' ? config.sift : {};
    if (siftCfg.enabled === false) return { status: 'skipped', reason: 'disabled', rows: [], readingOrder: [] };
    const key = await findKey(siftCfg, env);
    if (!key) return { status: 'skipped', reason: 'no-key', rows: [], readingOrder: [] };
    if (!Array.isArray(findings) || findings.length === 0) return { status: 'skipped', reason: 'no-findings', rows: [], readingOrder: [] };

    const { url, model } = resolveJevTarget(siftCfg, env);
    const limit = Number.isInteger(siftCfg.concurrency) ? siftCfg.concurrency : 8;
    const deadline = typeof siftCfg.timeoutMs === 'number' ? siftCfg.timeoutMs : 60000;
    const overall = new AbortController();
    const onAbort = () => overall.abort();
    if (signal?.aborted) overall.abort();
    else if (signal) signal.addEventListener('abort', onAbort, { once: true });
    const timer = setTimeout(() => overall.abort(), deadline);
    try {
      const rebById = new Map(rebuttals.map((r) => [r.id, r]));
      const rows = await mapLimit(findings, limit, async (fnd) => {
        const reb = rebById.get(fnd.id);
        const ex = await buildExcerpt(fnd, { scope, repoRoot, runDir }).catch(() => ({ text: '', action: 'missing' }));
        if (ex.action !== 'asked') await appendJevLog(runDir, { purpose: 'sift', id: fnd.id, action: ex.action, ms: null, stateChars: 0 });
        const challenges = reb
          ? `${(reb.challengers || []).map((c) => `- ${c.seat}: ${c.reason}`).join('\n')}\nOWNER ANSWER (stands firm: ${reb.standsFirm})\n${reb.rebuttal ?? ''}`
          : '';
        const { state, cut } = buildSiftState({ stage, finding: fnd, excerpt: ex.text, challenges });
        if (overall.signal.aborted) return { id: fnd.id, seat: fnd.seat, status: 'failed', reason: 'timeout', p: null };
        const r = await askJev({ url, model, key, state, questions: SIFT_QUESTIONS(Boolean(reb)), fetch: f, signal: overall.signal, timeoutMs: deadline });
        await appendJevLog(runDir, { purpose: 'sift', id: fnd.id, action: r.ok ? (cut ? 'cut' : 'asked') : 'failed', ms: r.ms ?? null, stateChars: state.length });
        if (!r.ok) return { id: fnd.id, seat: fnd.seat, status: 'failed', reason: r.reason, p: null };
        const a = r.answers;
        return {
          id: fnd.id,
          seat: fnd.seat,
          status: 'used',
          grounded: a.grounded?.choice ?? null,
          happens: a.happens?.choice ?? null,
          impact: typeof a.impact?.score === 'number' ? Number(a.impact.score.toFixed(2)) : null,
          survives: a.survives?.choice ?? null,
          p: { grounded: a.grounded?.probabilities ?? null, happens: a.happens?.probabilities ?? null, impact: a.impact?.probabilities ?? null, survives: a.survives?.probabilities ?? null },
        };
      });
      if (rows.every((r) => r.status === 'failed')) return { status: 'skipped', reason: 'all-failed', rows, readingOrder: [] };
      const clusterRows = rows.map((r) => ({ id: r.id, severity: r.impact ?? 0, confidence: P(r, 'happens', 'happens') }));
      return { status: 'used', rows, readingOrder: readingOrderOf(rows), clusters: clusterFindings(findings, clusterRows), model };
    } finally {
      clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', onAbort);
    }
  } catch {
    return { status: 'skipped', reason: 'failed', rows: [], readingOrder: [] };
  }
}

export function compareSift(sift, ruling, findings = []) {
  if (!sift || sift.status !== 'used' || !Array.isArray(sift.rows) || !ruling) return { disagreements: [] };
  const kept = new Set((ruling.closingList || []).flatMap((c) => c?.sources || []));
  for (const a of ruling.advisory || []) for (const f of findings) if (new RegExp(`\\b${String(f.id).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(a)) kept.add(f.id);
  const out = [];
  for (const r of sift.rows) {
    if (r.status !== 'used') continue;
    const doubt = Math.max(P(r, 'happens', 'does_not'), P(r, 'survives', 'falls'));
    if (kept.has(r.id) && doubt >= 0.8) out.push({ id: r.id, type: 'judge-kept-falls', p: doubt });
    if (!kept.has(r.id) && P(r, 'happens', 'happens') >= 0.8 && (r.impact ?? 0) >= 1.5) out.push({ id: r.id, type: 'judge-dropped-real', p: P(r, 'happens', 'happens') });
  }
  return { disagreements: out };
}
