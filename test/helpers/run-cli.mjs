// Spawns the real CLI in its own process. A test that calls main() in process shares the
// module state of the test runner, so a signal handler or a tracked child leaks between cases.
import { spawn } from 'node:child_process';
import path from 'node:path';

export const CLI_PATH = path.resolve('skills/adversarial-review/scripts/adversarial-review.mjs');

export function runCli(args = [], { env = process.env, cwd = process.cwd(), timeoutMs = 120000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI_PATH, ...args], { cwd, env, windowsHide: true });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`runCli timed out after ${timeoutMs}ms: ${args.join(' ')}\n${stderr}`));
    }, timeoutMs);
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}
