const START = "<<<ADVERSARIAL-REVIEW-VERDICT>>>";
const END = "<<<END>>>";
const MAX_OUTPUT_BYTES = 1024 * 1024;

export function parseVerdict(output, job, options = {}) {
  // FIX 3: compute text once to avoid TOCTOU gap with non-idempotent toString objects
  const text = String(output);

  if (Buffer.byteLength(text, "utf8") > (options.maxBytes || MAX_OUTPUT_BYTES)) {
    return { ok: false, error: "verdict_output_too_large" };
  }

  const start = text.indexOf(START);
  if (start < 0) return { ok: false, error: "missing_verdict_start" };

  // FIX 1: reject inputs that contain more than one verdict block (prompt-injection defence)
  if (text.indexOf(START) !== text.lastIndexOf(START)) {
    return { ok: false, error: "multiple_verdict_blocks" };
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

  let parsed;
  try {
    parsed = JSON.parse(body);
  } catch {
    return { ok: false, error: "invalid_verdict_json" };
  }
  return validateVerdict(parsed, job);
}

export function validateVerdict(parsed, job) {
  if (!parsed || typeof parsed !== "object") return { ok: false, error: "verdict_not_object" };
  if (parsed.job_id !== job.jobId) return { ok: false, error: "job_id_mismatch" };
  if (parsed.diff_hash !== job.diffHash) return { ok: false, error: "diff_hash_mismatch" };
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
    if (!(dimension in dimensions)) return { ok: false, error: `missing_dimension:${dimension}` };
  }
  // FIX 2: require severity to be a string so array/object/number values cannot
  // bypass the forced-fail by accidentally matching via type coercion
  const forcedFail = parsed.findings.some(
    (finding) =>
      finding &&
      typeof finding.severity === "string" &&
      ["Critical", "Important"].includes(finding.severity)
  );
  const verdict = forcedFail ? "fail" : parsed.verdict;
  return { ok: true, verdict: { ...parsed, verdict } };
}
