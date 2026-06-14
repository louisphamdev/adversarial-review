// Secret scanner: detects likely credentials in diff text and flags sensitive
// file paths. Used by the gate to block sending secrets to external reviewers.

const SECRET_PATTERNS = [
  // Matches PEM-format private key headers for any key type. The generic
  // [A-Z0-9 ]+ prefix group covers RSA/EC/ECDSA/DSA/OPENSSH/PGP plus the
  // ED25519 and ENCRYPTED (PKCS#8) variants and the bare header.
  /-----BEGIN (?:[A-Z0-9 ]+ )?PRIVATE KEY-----/,
  // AWS access key IDs: AKIA (long-lived IAM) and ASIA (STS TEMPORARY credentials).
  // Matching only AKIA let an ASIA-prefixed temporary key slip past the scanner.
  // (audit ROUND7 / GPT-5.5)
  /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/,
  // GitHub tokens: classic personal/OAuth/server/user/refresh (gh[psoru]_) and
  // the fine-grained personal access token (github_pat_...). Fine-grained PATs
  // contain a `_` separator so they are matched as their own pattern.
  /\bgh[psoru]_[A-Za-z0-9_]{30,}\b/,
  /\bgithub_pat_[A-Za-z0-9_]{20,}/,
  // GitLab personal access tokens.
  /\bglpat-[A-Za-z0-9_-]{20,}/,
  /\bsk-[A-Za-z0-9_-]{20,}\b/,
  // Generic credential assignment. The optional closing quote before the
  // separator catches quoted JSON/YAML keys (`"password": "value"`); a real
  // value (>=12 chars) after the `:`/`=` is required so a bare keyword with no
  // value (e.g. "reset your password") is not flagged.
  //
  // The value charset is broadened to any non-whitespace, non-quote run
  // (`[^\s"']`) so realistic secrets containing special characters
  // (`!@#$%^&*` etc., e.g. `Bearer abc!def...` or `p@ss!w0rd#value`) are caught
  // instead of being truncated at the first special char. Stopping at
  // whitespace/quote still requires a single contiguous token of real value
  // material (>=12 chars), so a bare keyword with no value stays unflagged and
  // false positives do not explode.
  //
  // NO leading `\b`: `_` is a word char, so `\bpassword` would NOT match inside a
  // PREFIXED env-var name like `DB_PASSWORD` / `MY_TOKEN` / `APP_SECRET` (the most
  // common credential form). Matching the keyword regardless of the preceding
  // char still requires the assignment + 12+ char value, so prefixed secrets are
  // caught without exploding false positives.
  /(?:api[_-]?key|apikey|secret|token|password|passwd|authorization|aws_secret_access_key)["']?\s*[:=]\s*(?:Bearer\s+)?["']?[^\s"']{12,}/i,
];

// Matches file paths that are inherently sensitive: .env files, credential/
// secret/private-key names, SSH key file names, and common key/cert extensions.
//
// The `.env` branch matches any path segment that STARTS with `.env`, covering
// `.env`, `.env.local`, `.env.production` (the original `.` / end-of-segment
// cases) plus `.envrc` (direnv), `.env-local` and any other `.env*` suffix.
// `[^\\/]*` runs only to the next path separator so it stays scoped to a single
// filename segment. We deliberately do NOT match a bare `env` (no leading dot)
// since `env/` directories and the word "env" are extremely common (false
// positives), so only the `.env`-prefixed forms are treated as sensitive.
const SENSITIVE_PATH_RE =
  /(^|[\\/])\.env[^\\/]*|credential|secret|private[-_]?key|id_rsa|id_dsa|id_ecdsa|id_ed25519|\.pem|\.pfx|\.p12|\.key|\.keystore|\.jks/i;

/**
 * Scan diff text and file paths for potential secrets or sensitive material.
 *
 * @param {string|*} text - Raw diff or file content to scan. Non-string values
 *   are coerced to string; null/undefined become an empty string.
 * @param {string[]|null|undefined} [paths=[]] - File paths included in the
 *   change set. null or undefined are treated as an empty array.
 * @returns {Array<{ type: "sensitive_path", path: string } | { type: "secret_pattern", sample: string }>}
 */
export function scanSecrets(text, paths = []) {
  // Guard against non-string text (null, undefined, numbers, etc.).
  const body = typeof text === "string" ? text : String(text ?? "");
  // Guard against null/undefined paths — only iterate an actual array.
  const list = Array.isArray(paths) ? paths : [];

  const findings = [];
  // Flag paths that are inherently sensitive regardless of content.
  for (const filePath of list) {
    if (SENSITIVE_PATH_RE.test(filePath)) {
      findings.push({ type: "sensitive_path", path: filePath });
    }
  }
  // Scan text for known secret shapes.
  for (const pattern of SECRET_PATTERNS) {
    const match = pattern.exec(body);
    if (match) findings.push({ type: "secret_pattern", sample: match[0].slice(0, 12) });
  }
  return findings;
}
