import { spawn } from "node:child_process";

// Hard cap on accumulated stdout. A pathological git diff (e.g. a huge generated
// file) could otherwise grow stdout without bound and OOM the process. When the
// cap is exceeded we kill the child and resolve with what we have plus a
// `truncated` flag so callers can flag a coverage limitation instead of silently
// dropping output.
const MAX_STDOUT_BYTES = 64 * 1024 * 1024;

// Spawn a git subprocess and resolve with its exit code and captured output.
// Never rejects; an exec error (e.g. git missing) resolves with code 127 so
// callers can branch on `result.code` uniformly. The resolved object always
// carries a `truncated` field (falsy for normal-size output).
export async function git(args, cwd, options = {}) {
  return new Promise((resolve) => {
    const child = spawn("git", args, { cwd, shell: false, windowsHide: true });
    const stdoutChunks = [];
    let stdoutBytes = 0;
    let stderr = "";
    let truncated = false;
    let settled = false;

    const finish = (result) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };

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
          stderr,
          truncated: true,
        });
        return;
      }
      stdoutChunks.push(buf);
      stdoutBytes += buf.length;
    });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", (error) =>
      finish({ code: 127, stdout: Buffer.concat(stdoutChunks).toString("utf8"), stderr: String(error), truncated })
    );
    child.on("close", (code) =>
      finish({ code, stdout: Buffer.concat(stdoutChunks).toString("utf8"), stderr, truncated })
    );
  });
}

// Return true if `cwd` is inside a git working tree.
export async function isGitRepo(cwd) {
  const result = await git(["rev-parse", "--git-dir"], cwd);
  return result.code === 0;
}
