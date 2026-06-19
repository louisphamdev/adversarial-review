import { spawn } from "node:child_process";

// Hard cap on accumulated stdout. A pathological git diff (e.g. a huge generated
// file) could otherwise grow stdout without bound and OOM the process. When the
// cap is exceeded we kill the child and resolve with what we have plus a
// `truncated` flag so callers can flag a coverage limitation instead of silently
// dropping output.
const MAX_STDOUT_BYTES = 64 * 1024 * 1024;

// Same byte ceiling applied to accumulated stderr. Git can emit unbounded
// stderr (e.g. progress/warning floods, or a deliberately noisy hook), which
// would otherwise grow the stderr string without limit and OOM the process
// while stdout is already capped. Past the cap we stop appending; what we
// keep is enough for diagnostics.
const MAX_STDERR_BYTES = 64 * 1024 * 1024;

// Force `core.quotePath=false` on every git invocation so non-ASCII paths
// (e.g. café.js, 日本.js) come through as raw UTF-8 instead of git's default
// C-style octal-escaped, double-quoted form ("caf\303\251.js"). Without this,
// downstream path parsing in diff.js mangles such paths and mis-classifies
// real code files as non-reviewable. Prepended (not appended) so it applies to
// the git subcommand that follows.
const GIT_GLOBAL_ARGS = ["-c", "core.quotePath=false"];

// Spawn a git subprocess and resolve with its exit code and captured output.
// Never rejects; an exec error (e.g. git missing) resolves with code 127 so
// callers can branch on `result.code` uniformly. The resolved object always
// carries a `truncated` field (falsy for normal-size output).
export async function git(args, cwd, options = {}) {
  return new Promise((resolve) => {
    const child = spawn("git", [...GIT_GLOBAL_ARGS, ...args], {
      cwd,
      shell: false,
      windowsHide: true,
    });
    const stdoutChunks = [];
    let stdoutBytes = 0;
    const stderrChunks = [];
    let stderrBytes = 0;
    let truncated = false;
    let settled = false;

    const finish = (result) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };

    // Decode whatever stderr we captured (bounded by MAX_STDERR_BYTES).
    const stderrString = () => Buffer.concat(stderrChunks).toString("utf8");

    child.stdout.on("data", (chunk) => {
      if (truncated) return;
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      if (stdoutBytes + buf.length > MAX_STDOUT_BYTES) {
        // Keep only up to the cap, then stop the child to bound memory.
        const remaining = MAX_STDOUT_BYTES - stdoutBytes;
        if (remaining > 0) {
          stdoutChunks.push(buf.subarray(0, remaining));
          stdoutBytes += remaining;
        }
        truncated = true;
        try { child.kill(); } catch { /* already gone */ }
        finish({
          code: null,
          stdout: Buffer.concat(stdoutChunks).toString("utf8"),
          stderr: stderrString(),
          truncated: true,
        });
        return;
      }
      stdoutChunks.push(buf);
      stdoutBytes += buf.length;
    });
    child.stderr.on("data", (chunk) => {
      // Cap stderr with the same byte ceiling as stdout so a pathological git
      // process cannot grow the buffer without bound. Past the cap we drop the
      // tail (kept bytes are sufficient for diagnostics).
      if (stderrBytes >= MAX_STDERR_BYTES) return;
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      const remaining = MAX_STDERR_BYTES - stderrBytes;
      const slice = buf.length > remaining ? buf.subarray(0, remaining) : buf;
      stderrChunks.push(slice);
      stderrBytes += slice.length;
    });
    child.on("error", (error) =>
      finish({ code: 127, stdout: Buffer.concat(stdoutChunks).toString("utf8"), stderr: String(error), truncated })
    );
    child.on("close", (code) =>
      finish({ code, stdout: Buffer.concat(stdoutChunks).toString("utf8"), stderr: stderrString(), truncated })
    );
  });
}

// Run a Git command whose stdout is a NUL-delimited record stream and count
// records without retaining path names in memory. Used only for diagnostics.
export async function gitCountNulRecords(args, cwd) {
  return new Promise((resolve) => {
    const child = spawn("git", [...GIT_GLOBAL_ARGS, ...args], {
      cwd,
      shell: false,
      windowsHide: true,
    });
    const stderrChunks = [];
    let stderrBytes = 0;
    let count = 0;
    let settled = false;

    const finish = (result) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };
    const stderrString = () => Buffer.concat(stderrChunks).toString("utf8");

    child.stdout.on("data", (chunk) => {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      for (const byte of buf) {
        if (byte === 0) count += 1;
      }
    });
    child.stderr.on("data", (chunk) => {
      if (stderrBytes >= MAX_STDERR_BYTES) return;
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      const remaining = MAX_STDERR_BYTES - stderrBytes;
      const slice = buf.length > remaining ? buf.subarray(0, remaining) : buf;
      stderrChunks.push(slice);
      stderrBytes += slice.length;
    });
    child.on("error", (error) =>
      finish({ code: 127, count, stderr: String(error) })
    );
    child.on("close", (code) =>
      finish({ code, count, stderr: stderrString() })
    );
  });
}

// Return true if `cwd` is inside a git working tree.
export async function isGitRepo(cwd) {
  const result = await git(["rev-parse", "--git-dir"], cwd);
  return result.code === 0;
}
