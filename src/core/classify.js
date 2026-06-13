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
  const normalized = filePath.replace(/\\/g, "/");
  const lower = normalized.toLowerCase();
  const base = lower.split("/").at(-1);
  const ext = base.includes(".") ? `.${base.split(".").at(-1)}` : "";
  const extraExts = new Set(config.sensitivity?.extraCodeExts || []);
  const extraSensitive = (config.sensitivity?.extraSensitive || []).map(String);
  const sensitive = SENSITIVE_RE.test(normalized) || extraSensitive.some((part) => normalized.includes(part));
  const reviewable = sensitive || CODE_EXTS.has(ext) || extraExts.has(ext) || REVIEWABLE_NAMES.has(base);
  const docsOnly = DOC_EXTS.has(ext) && !sensitive && !reviewable;
  return { reviewable, sensitive, docsOnly, ext, base };
}
