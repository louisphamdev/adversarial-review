// Containment of a file path that a seat cited. The path is untrusted text, so every text check
// runs first; realpath touches the filesystem only after they pass.
import { realpath } from 'node:fs/promises';
import path from 'node:path';
import { canonicalPath, isInside } from './paths.mjs';

const DEVICE = /^(con|prn|aux|nul|conin\$|conout\$|com[1-9]|lpt[1-9])(\..*)?$/i;

const refuse = (fileRaw, outOfRoot) => ({ file: null, fileRaw, outOfRoot, exists: false });

// Text-only part of G2-5. A refused value gives null; an accepted value is returned trimmed.
function textCheck(text) {
  const fileRaw = text == null ? '' : String(text);
  const s = fileRaw.trim();
  // An empty citation is a missing field, not an escape attempt.
  if (s === '') return { fileRaw, s, bad: true, outOfRoot: false };
  const segments = s.split(/[\\/]+/);
  const bad =
    s.startsWith('/') ||
    s.startsWith('\\') ||
    s.includes(':') ||
    segments.some((seg) => seg === '.' || seg === '..' || /[. ]$/.test(seg) || DEVICE.test(seg));
  return { fileRaw, s, bad, outOfRoot: bad };
}

// Contains a seat-cited path inside root. Without a root only the text checks run.
export async function containFile(text, root) {
  const t = textCheck(text);
  if (t.bad) return refuse(t.fileRaw, t.outOfRoot);
  if (!root) return { file: t.s, fileRaw: t.fileRaw, outOfRoot: false, exists: false };

  let real;
  let realRoot;
  try {
    realRoot = await realpath(root);
    real = await realpath(path.join(root, t.s));
  } catch (err) {
    // Only a missing target keeps the path. Any other failure is treated as an escape.
    if (err && err.code === 'ENOENT' && realRoot !== undefined) {
      return { file: t.s, fileRaw: t.fileRaw, outOfRoot: false, exists: false };
    }
    return refuse(t.fileRaw, true);
  }
  // isInside answers true for the root itself, and the root is not a file to open.
  if (canonicalPath(real) === canonicalPath(realRoot)) return refuse(t.fileRaw, true);
  if (!isInside(real, realRoot)) return refuse(t.fileRaw, true);
  return { file: t.s, fileRaw: t.fileRaw, outOfRoot: false, exists: true };
}

const cut = (v) => String(v ?? '').slice(0, 200);

// Event shape of one finding: short text, a contained path, and the seat-cited line.
export async function findingEvent(f, root) {
  const c = await containFile(f.file, root);
  return {
    id: f.id,
    severity: f.severity,
    title: cut(f.title),
    file: c.file,
    fileRaw: cut(c.fileRaw),
    outOfRoot: c.outOfRoot,
    line: f.line ?? null,
  };
}
