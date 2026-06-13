// Secret scanner: detects likely credentials in diff text and flags sensitive
// file paths. Used by the gate to block sending secrets to external reviewers.

const SECRET_PATTERNS = [
  // Matches PEM-format private key headers, including ECDSA and DSA variants.
  /-----BEGIN (?:RSA |EC |ECDSA |DSA |OPENSSH |PGP )?PRIVATE KEY-----/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\bghp_[A-Za-z0-9_]{30,}\b/,
  /\bsk-[A-Za-z0-9_-]{20,}\b/,
  /\b(?:api[_-]?key|secret|token|password)\s*[:=]\s*["']?[A-Za-z0-9_./+=-]{12,}/i,
];

// Matches file paths that are inherently sensitive: .env files, credential/
// secret/private-key names, SSH key file names, and common key/cert extensions.
const SENSITIVE_PATH_RE =
  /(^|[\\/])\.env(\.|$)|credential|secret|private[-_]?key|id_rsa|id_dsa|id_ecdsa|id_ed25519|\.pem|\.pfx|\.p12|\.key|\.keystore|\.jks/i;

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
