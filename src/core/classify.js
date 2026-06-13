// File classification: determines whether a changed file is reviewable,
// sensitive, or docs-only. Used by the gate to decide which files to send
// to external reviewers and which require extra scrutiny.

const CODE_EXTS = new Set([
  ".py", ".pyi", ".js", ".jsx", ".mjs", ".cjs", ".ts", ".tsx", ".go", ".rs",
  ".c", ".h", ".cc", ".cpp", ".hpp", ".cs", ".java", ".kt", ".kts", ".rb",
  ".php", ".swift", ".scala", ".sh", ".bash", ".zsh", ".sql", ".vue",
  ".svelte", ".dart", ".lua", ".ex", ".exs", ".clj", ".erl", ".pl", ".r",
  ".jl", ".groovy", ".gradle", ".tf", ".yaml", ".yml", ".json", ".toml",
  // Windows scripts
  ".bat", ".cmd", ".ps1", ".psm1",
  // Terraform/HCL variable and config files
  ".tfvars", ".hcl",
  // Jupyter notebooks — committed executable code
  ".ipynb",
]);

const DOC_EXTS = new Set([".md", ".txt", ".rst", ".adoc"]);

// Matches sensitive path segments. Includes SSH/TLS key file names and
// extensions so that private-key files are classified sensitive=true.
const SENSITIVE_RE = /auth|login|password|passwd|secret|credential|token|crypto|payment|billing|migration|\.env|security|permission|access[_-]?control|deploy|infra|terraform|k8s|kube|dockerfile|workflow|github\/workflows|id_rsa|id_dsa|id_ecdsa|id_ed25519|\.pem|\.pfx|\.p12|\.key|\.keystore|\.jks/i;

// Exact lowercase base-name matches for well-known build/manifest/lockfiles.
// IMPORTANT: `base` is derived from the lowercased file path, so every entry
// here MUST be lowercase — a capitalised entry would be dead code.
const REVIEWABLE_NAMES = new Set([
  "package.json", "package-lock.json", "pnpm-lock.yaml", "yarn.lock",
  // Dockerfile — lowercase because `base` is always lowercased
  "dockerfile", "docker-compose.yml", "compose.yml", "tsconfig.json",
  // Build automation
  "makefile", "gnumakefile", "justfile", "rakefile",
  // Ruby / Bundler
  "gemfile", "gemfile.lock",
  // Rust / Cargo
  "cargo.toml", "cargo.lock",
  // Go modules
  "go.mod", "go.sum",
  // Python packaging
  "poetry.lock", "pyproject.toml", "requirements.txt",
  // PHP / Composer
  "composer.json", "composer.lock",
]);

/**
 * Classify a file path into reviewable/sensitive/docsOnly categories.
 *
 * @param {string} filePath - The path to classify (may use backslashes on Windows).
 * @param {object} [config={}] - Optional merged config with sensitivity overrides.
 * @returns {{ reviewable: boolean, sensitive: boolean, docsOnly: boolean, ext: string, base: string }}
 */
export function classifyPath(filePath, config = {}) {
  // Normalize Windows backslashes so SENSITIVE_RE and path logic work uniformly.
  // Trim surrounding whitespace so a stray leading/trailing space (e.g. a path
  // like "weird.js ") does not corrupt the extension and silently drop reviewable
  // status. SENSITIVE_RE is evaluated against the trimmed, slash-normalized form.
  const normalized = filePath.replace(/\\/g, "/").trim();
  const lower = normalized.toLowerCase();
  // Compute the final path segment, then strip a trailing run of dots, whitespace,
  // and Unicode format/control chars before extracting the extension. JS `.trim()`
  // and `\s` do NOT match zero-width / format characters (U+200B ZWSP, U+200C ZWNJ,
  // U+200D ZWJ, U+FEFF, U+0085 NEL, U+180E, ...). Left unstripped, a file named
  // "payload.js<ZWSP>" keeps the invisible char in its ext (".js<ZWSP>"), so it is
  // NOT recognized as code and silently drops out of review — a fail-OPEN bypass.
  // We NFKC-normalize and strip the full Unicode format/control/whitespace set so
  // the real extension is recovered and the file fails CLOSED (reviewable).
  const rawBase = lower.split("/").at(-1).normalize("NFKC");
  // Strip a trailing run of dots/whitespace/format/control chars from the segment.
  // \p{Cf} (format) covers ZWSP/ZWNJ/ZWJ/BOM/MVS, \p{Cc} (control) covers NEL, and
  // \s covers ordinary whitespace — together they catch the invisible characters
  // JS `.trim()` and `\s` alone miss, so the real extension is always recovered.
  const trailingJunk = /[.\s\p{Cf}\p{Cc}]+$/gu;
  const base = rawBase.replace(trailingJunk, "");
  // Derive the extension from the stem AFTER dropping a single LEADING dot, so a
  // leading-dot-only dotfile (".npmrc", ".bashrc", ".gitconfig") yields ext="" and
  // hits the ambiguous->reviewable fail-closed default rather than producing a
  // bogus non-empty unknown ext (".npmrc") that silently slips through unreviewed.
  // A name with an interior dot (".eslintrc.json", "a.b.npmrc") still resolves its
  // real trailing extension correctly.
  const stem = base.startsWith(".") ? base.slice(1) : base;
  const ext = stem.includes(".") ? `.${stem.split(".").at(-1)}` : "";
  const extraExts = new Set(config.sensitivity?.extraCodeExts || []);
  const extraSensitive = (config.sensitivity?.extraSensitive || []).map(String);
  const sensitive = SENSITIVE_RE.test(normalized) || extraSensitive.some((part) => normalized.includes(part));
  // Fail CLOSED on ambiguity. A file is treated as docs-only ONLY when it carries a
  // genuine known docs extension (.md/.txt/.rst/.adoc). EVERYTHING ELSE that has
  // content — a known code ext, an UNKNOWN non-empty ext (.config/.bak/.so/.wasm/
  // a Unicode-cloaked ext), an extensionless/dotfile path, or a recognized
  // build/manifest name — defaults to REVIEWABLE so it is reviewed rather than
  // silently dropped (which would make the gate return level_none and ALLOW
  // unreviewed code in enforced mode).
  const isDoc = DOC_EXTS.has(ext);
  const reviewable =
    sensitive ||
    REVIEWABLE_NAMES.has(base) ||
    (base.length > 0 && !isDoc);
  const docsOnly = isDoc && !sensitive && !reviewable;
  return { reviewable, sensitive, docsOnly, ext, base };
}
