const START = "<<<ADVERSARIAL-REVIEW-VERDICT>>>";
const END = "<<<END>>>";
const START_LOWER = START.toLowerCase();
const MAX_OUTPUT_BYTES = 1024 * 1024;

// Severities that force verdict=fail, in normalized (NFKC + format-stripped +
// lowercased + trimmed) form. See normalizeSeverity / classifySeverity below.
const BLOCKING_SEVERITIES = new Set(["critical", "important"]);
// Severities that are recognized as explicitly NON-blocking. Any string severity
// that is neither blocking NOR recognized-non-blocking is treated as blocking
// (fail closed) so homoglyph / lookalike / garbage severities cannot evade the
// contradiction guard. See classifySeverity.
const NONBLOCKING_SEVERITIES = new Set(["minor", "advisory"]);

/**
 * FIX (finding 3): Normalize an untrusted severity string before comparison so
 * whitespace ("Critical "), case ("critical"), and zero-width / format / control
 * characters ("Crit​ical") cannot evade the forced-fail guard. NFKC also
 * folds compatibility lookalikes. Pure Unicode-script homoglyphs (e.g. Cyrillic
 * "Сritical") are NOT folded by NFKC; they are caught instead by the
 * fail-closed default in classifySeverity (unrecognized string => blocking).
 * @param {string} severity raw severity string from the parsed verdict
 * @returns {string} normalized severity token
 */
function normalizeSeverity(severity) {
  return severity
    .normalize("NFKC")
    .replace(/[\p{Cf}\p{Cc}]/gu, "")
    .trim()
    .toLowerCase();
}

/**
 * Classify a finding's severity. Non-string severities are ignored (return
 * "ignore") to preserve the type-guard contract (an array/object/number severity
 * is not a usable signal and must not force-fail). String severities are
 * normalized and classified fail-closed: recognized non-blocking => "nonblocking",
 * recognized blocking OR any unrecognized string => "blocking".
 * @param {unknown} severity the finding.severity value
 * @returns {"blocking"|"nonblocking"|"ignore"}
 */
function classifySeverity(severity) {
  if (typeof severity !== "string") return "ignore";
  const norm = normalizeSeverity(severity);
  if (BLOCKING_SEVERITIES.has(norm)) return "blocking";
  if (NONBLOCKING_SEVERITIES.has(norm)) return "nonblocking";
  // FIX (finding 3): unrecognized string severity (homoglyph, typo, garbage) is
  // treated as blocking so it cannot silently pass off a real Critical as benign.
  return "blocking";
}

/**
 * FIX (finding 1): JSON.parse silently keeps the LAST value for a duplicated key,
 * so a finding `{"severity":"Critical","severity":"Minor"}` collapses to "Minor"
 * and slips past the forced-fail net. Parse the body with a reviver that rejects
 * any object containing a duplicate key, by re-counting keys in the raw source.
 * The reviver alone cannot see duplicates (JSON.parse already collapsed them), so
 * we additionally scan structurally: parse once to validate syntax, then verify no
 * object literal in the source declares the same key twice.
 * @param {string} source raw JSON text
 * @returns {{ ok: true, value: unknown } | { ok: false, error: string }}
 */
function parseJsonRejectingDuplicateKeys(source) {
  let value;
  try {
    value = JSON.parse(source);
  } catch {
    return { ok: false, error: "invalid_verdict_json" };
  }
  if (hasDuplicateKeys(source)) {
    return { ok: false, error: "duplicate_json_key" };
  }
  return { ok: true, value };
}

/**
 * Scan raw JSON text for any object that declares the same member name twice.
 * Operates on a tokenizer that tracks string boundaries (so braces/keys inside
 * string values are not mistaken for structure) and a stack of per-object key
 * sets. Returns true on the first duplicate key found in any object scope.
 * @param {string} source raw JSON text (already validated as parseable)
 * @returns {boolean} true if any object contains a duplicate key
 */
function hasDuplicateKeys(source) {
  // Stack of Sets, one per currently-open object. Arrays push `null` so the
  // key-tracking only applies to object scopes.
  const stack = [];
  let i = 0;
  const n = source.length;
  // FIX (finding: duplicate-key scanner can block the event loop on large
  // under-limit JSON): SKIP over a JSON string starting at the opening quote at
  // index `start` WITHOUT rebuilding it character-by-character. The old readString
  // did `s += ch` for every character of every string (incl. multi-hundred-KiB
  // finding detail values), which is quadratic-ish and burned avoidable CPU
  // synchronously in the gate process. Skipping is linear with no concatenation,
  // and the (small) key value is decoded lazily only when the string is actually a
  // key (see decodeStringValue below).
  // Returns the index AFTER the closing quote (or n if unterminated).
  const skipString = (start) => {
    let j = start + 1;
    while (j < n) {
      const ch = source[j];
      if (ch === "\\") {
        // A backslash escapes the next char; \u takes four more hex digits. We do
        // not need to decode here — just step past the escape so an escaped quote
        // does not terminate the string early.
        j += source[j + 1] === "u" ? 6 : 2;
        continue;
      }
      if (ch === '"') return j + 1;
      j += 1;
    }
    return n;
  };
  // Decode a JSON string in [start, end) (quotes inclusive) to its logical value.
  // Only ever called for OBJECT KEYS, which are short, so the per-char build here
  // is bounded by key length, not by arbitrary string-value length.
  const decodeStringValue = (start, end) => {
    let s = "";
    let j = start + 1;
    const stop = end - 1; // index of the closing quote
    while (j < stop) {
      const ch = source[j];
      if (ch === "\\") {
        const next = source[j + 1];
        switch (next) {
          case '"': s += '"'; break;
          case "\\": s += "\\"; break;
          case "/": s += "/"; break;
          case "b": s += "\b"; break;
          case "f": s += "\f"; break;
          case "n": s += "\n"; break;
          case "r": s += "\r"; break;
          case "t": s += "\t"; break;
          case "u": {
            s += String.fromCharCode(parseInt(source.slice(j + 2, j + 6), 16));
            j += 6;
            continue;
          }
          default: s += next;
        }
        j += 2;
        continue;
      }
      s += ch;
      j += 1;
    }
    return s;
  };
  while (i < n) {
    const ch = source[i];
    if (ch === '"') {
      const end = skipString(i);
      // Determine if this string is an object key: the next significant char is ':'.
      let k = end;
      while (k < n && /\s/.test(source[k])) k += 1;
      const isKey =
        source[k] === ":" && stack.length > 0 && stack[stack.length - 1] instanceof Set;
      if (isKey) {
        const keys = stack[stack.length - 1];
        const value = decodeStringValue(i, end);
        if (keys.has(value)) return true;
        keys.add(value);
      }
      i = end;
      continue;
    }
    if (ch === "{") {
      stack.push(new Set());
    } else if (ch === "[") {
      stack.push(null);
    } else if (ch === "}" || ch === "]") {
      stack.pop();
    }
    i += 1;
  }
  return false;
}

/**
 * FIX (finding: verdict inside a code fence): determine whether the START marker
 * at index `markerStart` sits INSIDE an open markdown code fence. An
 * attacker-controlled diff can embed a fenced fake PASS block; if the reviewer
 * quotes that fenced content and emits no later real block, the single forged
 * block must NOT be accepted. The contract requires the verdict block to be
 * top-level (not wrapped in a code fence).
 *
 * We scan only the prefix BEFORE the marker, line by line, toggling a fence flag
 * on each fence-delimiter line (``` or ~~~, optionally indented / with an info
 * string). If the fence is still open when we reach the marker line, the marker
 * is fenced. The marker's own line is also treated as fenced when a fence opener
 * sits on that line before the marker (e.g. "```<<<START>>>"). Fail closed: an
 * ambiguous/odd fence count leaves the marker fenced.
 * @param {string} text full reviewer output
 * @param {number} markerStart index of the START marker
 * @returns {boolean} true if the START marker is inside an open code fence
 */
function startMarkerIsFenced(text, markerStart) {
  // Fence delimiter: a line whose first non-space content is ``` or ~~~ (3+).
  const FENCE = /^[ \t]*(`{3,}|~{3,})/;
  const prefix = text.slice(0, markerStart);
  let open = false;
  // Walk full lines in the prefix. The final (partial) segment is the text on the
  // marker's own line that precedes the marker.
  const segments = prefix.split("\n");
  for (let i = 0; i < segments.length - 1; i += 1) {
    if (FENCE.test(segments[i])) open = !open;
  }
  // A fence opener on the marker's own line, before the marker, also fences it.
  const lastSegment = segments[segments.length - 1];
  if (FENCE.test(lastSegment)) open = !open;
  return open;
}

// Count non-overlapping occurrences of `needle` in `haystack`. Used to detect
// multiple verdict-block markers case-insensitively (both operands lowercased).
function countOccurrences(haystack, needle) {
  if (!needle) return 0;
  let count = 0;
  let from = 0;
  for (;;) {
    const idx = haystack.indexOf(needle, from);
    if (idx < 0) break;
    count += 1;
    from = idx + needle.length;
  }
  return count;
}

export function parseVerdict(output, job, options = {}) {
  // FIX 3: compute text once to avoid TOCTOU gap with non-idempotent toString objects
  const text = String(output);

  if (Buffer.byteLength(text, "utf8") > (options.maxBytes || MAX_OUTPUT_BYTES)) {
    return { ok: false, error: "verdict_output_too_large" };
  }

  const start = text.indexOf(START);
  if (start < 0) return { ok: false, error: "missing_verdict_start" };

  // FIX 1: reject inputs that contain more than one verdict block (prompt-injection defence).
  // Detect markers case-INSENSITIVELY: a SECOND verdict block authored with a
  // different-case START marker (e.g. <<<adversarial-review-verdict>>>) must not
  // slip past an exact-case indexOf/lastIndexOf check. A second verdict block
  // always carries its own START sentinel, so 2+ START markers is the rejection
  // signal. END markers are NOT counted here: the trailing-content relaxation
  // (prose, and even a stray END, after the first block's END) must be preserved.
  // This runs BEFORE the code-fence check so a two-block input (one fenced fake +
  // one real) is still reported as multiple_verdict_blocks.
  const lower = text.toLowerCase();
  if (countOccurrences(lower, START_LOWER) > 1) {
    return { ok: false, error: "multiple_verdict_blocks" };
  }

  // FIX (finding: verdict inside a code fence): the authoritative verdict block must
  // be top-level. A single forged PASS block wrapped in a ``` / ~~~ markdown fence
  // (e.g. quoted from an untrusted diff) must NOT be accepted, even when it is the
  // only block present (so the multiple_verdict_blocks guard above does not fire).
  if (startMarkerIsFenced(text, start)) {
    return { ok: false, error: "verdict_in_code_fence" };
  }

  const end = text.indexOf(END, start + START.length);
  if (end < 0) return { ok: false, error: "missing_verdict_end" };
  // Trailing content after the verdict block's <<<END>>> is intentionally ignored.
  // Real LLM reviewers intermittently append a sign-off / extra prose after the
  // verdict block; rejecting it made the gate unusable. Injection safety is preserved
  // by the single-START requirement above: a second verdict block (the only injection
  // vector that matters) is already rejected as multiple_verdict_blocks, so trailing
  // non-START text is harmless.
  const body = text.slice(start + START.length, end).trim();

  // FIX 1 (defense-in-depth): reject nested sentinel tokens inside the extracted body
  if (body.includes(START) || body.includes(END)) {
    return { ok: false, error: "nested_verdict_block" };
  }

  // FIX (finding 1): reject duplicate JSON keys so a finding cannot downgrade its
  // own severity (e.g. {"severity":"Critical","severity":"Minor"}) past the
  // forced-fail net via JSON.parse's last-wins duplicate-key behaviour.
  const parseResult = parseJsonRejectingDuplicateKeys(body);
  if (!parseResult.ok) return parseResult;
  return validateVerdict(parseResult.value, job);
}

export function validateVerdict(parsed, job) {
  if (!parsed || typeof parsed !== "object") return { ok: false, error: "verdict_not_object" };
  if (parsed.job_id !== job.jobId) return { ok: false, error: "job_id_mismatch" };
  if (parsed.diff_hash !== job.diffHash) return { ok: false, error: "diff_hash_mismatch" };
  // FIX (finding: payload_hash is not validated): bind the verdict to the FULL
  // review payload, not just the diff. payload_hash must echo the exact payload the
  // gate built. When the job carries a payloadHash, a missing/wrong/empty
  // payload_hash is rejected here so EVERY caller (parseVerdict, the gate's external
  // path in ALL modes, and the native self path) fails closed on a mismatch — the
  // gate's own enforced-only deferred check previously left the external SOFT path
  // (and any caller bypassing it) accepting a forged payload_hash. The guard is
  // skipped only when the job does not bind a payloadHash (so verdict-only callers
  // that never compute a payload remain valid).
  if (job.payloadHash != null && parsed.payload_hash !== job.payloadHash) {
    return { ok: false, error: "payload_hash_mismatch" };
  }
  if (parsed.reviewer !== job.reviewer) return { ok: false, error: "reviewer_mismatch" };
  if (parsed.level !== job.level) return { ok: false, error: "level_mismatch" };
  if (!["pass", "fail"].includes(parsed.verdict)) return { ok: false, error: "invalid_verdict_value" };
  if (!Array.isArray(parsed.findings)) parsed.findings = [];
  if (!parsed.coverage || typeof parsed.coverage !== "object") {
    return { ok: false, error: "missing_coverage" };
  }
  const required = job.requiredDimensions || [];
  const dimensions = parsed.dimensions || {};
  for (const dimension of required) {
    // FIX (finding 2): use hasOwnProperty so proto-named required dimensions
    // (e.g. "constructor"/"toString") cannot be satisfied via the prototype chain
    // when the reviewer produced no such own property.
    if (!Object.prototype.hasOwnProperty.call(dimensions, dimension)) {
      return { ok: false, error: `missing_dimension:${dimension}` };
    }
  }
  // FIX 2 + FIX (finding 3): non-string severities are ignored (so a malformed
  // array/object/number severity cannot itself force-fail), but every STRING
  // severity is normalized and classified fail-closed: recognized blocking
  // (Critical/Important, incl. whitespace/case/zero-width variants) AND any
  // unrecognized string (homoglyph/typo/garbage) force the verdict to fail.
  const forcedFail = parsed.findings.some(
    (finding) => finding && classifySeverity(finding.severity) === "blocking"
  );
  const verdict = forcedFail ? "fail" : parsed.verdict;
  return { ok: true, verdict: { ...parsed, verdict } };
}
