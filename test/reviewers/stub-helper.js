// Stub helper for reviewer adapter tests.
//
// Creates temporary Node.js stub scripts that simulate reviewer behavior:
// valid verdict, fail verdict, timeout, non-zero exit, malformed output.
// Stubs are invoked as: process.execPath [stubPath] [...args]
// so no shell injection is possible and no real codex/opencode is needed.

import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

const START = "<<<ADVERSARIAL-REVIEW-VERDICT>>>";
const END = "<<<END>>>";

/**
 * Build valid verdict JSON for a given job and verdict value.
 *
 * @param {object} job
 * @param {"pass"|"fail"} verdict
 * @returns {string}
 */
export function buildVerdictOutput(job, verdict = "pass") {
  const payload = {
    job_id: job.jobId,
    diff_hash: job.diffHash,
    payload_hash: job.payloadHash || "",
    reviewer: job.reviewer,
    level: job.level,
    verdict,
    coverage: {
      files_examined: job.changedFiles || [],
      dimensions_examined: job.requiredDimensions || [],
      limitations: [],
    },
    dimensions: Object.fromEntries((job.requiredDimensions || []).map((d) => [d, "clean"])),
    findings: verdict === "fail" ? [{ severity: "Minor", title: "style nit", location: "x.js:1", detail: "ok" }] : [],
  };
  return `${START}${JSON.stringify(payload)}${END}`;
}

/**
 * Create a temporary directory containing:
 *  - pass.mjs   — prints a valid pass verdict block and exits 0
 *  - fail.mjs   — prints a valid fail verdict block and exits 0
 *  - nonzero.mjs — prints nothing and exits 1
 *  - malformed.mjs — prints garbage and exits 0
 *  - sleep.mjs  — sleeps for a long time (for timeout tests)
 *  - version.mjs — prints "test-stub 1.0.0" and exits 0
 *  - diff.txt   — empty diff placeholder
 *
 * Returns { dir, paths: { pass, fail, nonzero, malformed, sleep, version, diff } }
 * and a cleanup() async function.
 *
 * @param {object} job  - the review job the stubs will echo in their verdict
 * @returns {Promise<{ dir: string, paths: object, cleanup: Function }>}
 */
export async function createStubs(job) {
  const dir = await mkdtemp(join(tmpdir(), "ar-stub-"));

  const verdictPass = buildVerdictOutput(job, "pass");
  const verdictFail = buildVerdictOutput(job, "fail");

  const passScript = `
process.stdout.write(${JSON.stringify(verdictPass)});
process.exit(0);
`;

  const failScript = `
process.stdout.write(${JSON.stringify(verdictFail)});
process.exit(0);
`;

  const nonzeroScript = `
process.exit(1);
`;

  const malformedScript = `
process.stdout.write("this is not a valid verdict block at all <<<ADVERSARIAL-REVIEW-VERDICT>>>oops no json<<<END>>>");
process.exit(0);
`;

  // Sleeps for 10 seconds — much longer than test timeouts (which use ~200ms).
  const sleepScript = `
setTimeout(() => { process.exit(0); }, 10000);
`;

  const versionScript = `
process.stdout.write("test-stub 1.0.0\\n");
process.exit(0);
`;

  const paths = {
    pass: join(dir, "pass.mjs"),
    fail: join(dir, "fail.mjs"),
    nonzero: join(dir, "nonzero.mjs"),
    malformed: join(dir, "malformed.mjs"),
    sleep: join(dir, "sleep.mjs"),
    version: join(dir, "version.mjs"),
    diff: join(dir, "diff.txt"),
  };

  await Promise.all([
    writeFile(paths.pass, passScript, "utf8"),
    writeFile(paths.fail, failScript, "utf8"),
    writeFile(paths.nonzero, nonzeroScript, "utf8"),
    writeFile(paths.malformed, malformedScript, "utf8"),
    writeFile(paths.sleep, sleepScript, "utf8"),
    writeFile(paths.version, versionScript, "utf8"),
    writeFile(paths.diff, "--- a/src/foo.js\n+++ b/src/foo.js\n@@ -1 +1 @@\n-old\n+new\n", "utf8"),
  ]);

  return {
    dir,
    paths,
    cleanup: () => rm(dir, { recursive: true, force: true }),
  };
}

/**
 * Build a minimal job descriptor that satisfies parseVerdict.
 *
 * @param {object} [overrides]
 * @returns {object}
 */
export function makeJob(overrides = {}) {
  return {
    jobId: "ar-test-job-001",
    diffHash: "abc123deadbeef00",
    payloadHash: "payload999",
    reviewer: "codex",
    level: "single",
    requiredDimensions: ["Correctness", "Security"],
    changedFiles: ["src/foo.js"],
    diffPath: "",  // filled in by individual tests
    ...overrides,
  };
}
