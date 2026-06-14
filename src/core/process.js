import { access } from "node:fs/promises";
import path from "node:path";
import { constants } from "node:fs";
import { spawn } from "node:child_process";

/**
 * Read an env value by a case-insensitive key name.
 *
 * `process.env` is case-insensitive on win32, but a PLAIN-OBJECT env copy
 * (e.g. `{ ...process.env }`, or an env coming from a native Windows
 * cmd/powershell shell) may carry the key in a different case — e.g. `Path`
 * instead of `PATH`. Reading `env.PATH` directly would then miss it and
 * resolveExecutable would wrongly return null. This helper returns the value for
 * the first key matching `name` case-insensitively, preferring an EXACT-case
 * match (so behavior is unchanged when the uppercase key exists).
 *
 * @param {object} env   - environment object
 * @param {string} name  - canonical key name (e.g. "PATH", "PATHEXT")
 * @returns {string|undefined}
 */
export function getEnvCaseInsensitive(env, name) {
  if (!env || typeof env !== "object") return undefined;
  // Prefer the exact key first to keep existing behavior identical.
  if (Object.prototype.hasOwnProperty.call(env, name) && env[name] != null) {
    return env[name];
  }
  const lower = name.toLowerCase();
  for (const key of Object.keys(env)) {
    if (key.toLowerCase() === lower && env[key] != null) {
      return env[key];
    }
  }
  return undefined;
}

/**
 * Resolve a command name or path to an absolute executable path.
 * On Windows, walks PATHEXT extensions (e.g. .COM .EXE .BAT .CMD).
 * Returns null if nothing is found.
 *
 * @param {string} command  - bare name ("claude") or explicit path
 * @param {object} env      - environment variables (defaults to process.env)
 * @returns {Promise<string|null>}
 */
export async function resolveExecutable(command, env = process.env) {
  // Explicit path: check existence and return resolved form, or null if missing.
  if (command.includes("/") || command.includes("\\")) {
    try {
      await access(command, constants.X_OK);
    } catch {
      try {
        await access(command, constants.F_OK);
      } catch {
        // File does not exist or is inaccessible — return null instead of throwing.
        return null;
      }
    }
    return path.resolve(command);
  }

  // Read PATH / PATHEXT case-insensitively: a plain-object env copy (or a native
  // Windows shell env) may carry these keys as `Path`/`PathExt`, etc.
  const pathValue = getEnvCaseInsensitive(env, "PATH");
  const pathExtValue = getEnvCaseInsensitive(env, "PATHEXT");
  const pathEntries = String(pathValue || "").split(path.delimiter).filter(Boolean);
  const extensions =
    process.platform === "win32"
      ? String(pathExtValue || ".COM;.EXE;.BAT;.CMD").split(";")
      : [""];

  // On POSIX, a PATH candidate must be EXECUTABLE to be a real match: a
  // non-executable same-named file (e.g. a mode-0o644 stub) earlier in PATH must
  // be SKIPPED so a later, real executable is found instead of returning a path
  // that spawn() would then reject with EACCES (a false negative). On Windows the
  // execute bit is not modeled (X_OK behaves like F_OK), and executability is
  // expressed via PATHEXT, so existence (F_OK) is the correct match test there.
  const accessMode = process.platform === "win32" ? constants.F_OK : constants.X_OK;
  for (const dir of pathEntries) {
    for (const ext of extensions) {
      const candidate = path.join(
        dir,
        process.platform === "win32" ? `${command}${ext}` : command
      );
      try {
        await access(candidate, accessMode);
        return candidate;
      } catch {
        continue;
      }
    }
  }
  return null;
}

// Characters that cmd.exe treats as metacharacters when it re-parses the
// trailing arguments of `cmd.exe /c <batch> <args...>`. An argument containing
// any of these can break out of the intended command and execute attacker code,
// so batch-wrapped invocations MUST reject args matching this pattern.
const CMD_METACHAR_RE = /[&|<>^"%()\r\n]/;

/**
 * Spawn a RESOLVED executable path with shell:false.
 *
 * On Windows, `.cmd` and `.bat` files cannot be spawned directly with
 * shell:false — they must be invoked via `cmd.exe /c <path> [args...]`.
 * This function handles that transparently so callers never need to
 * special-case Windows batch wrappers.
 *
 * SECURITY: when wrapping a `.cmd`/`.bat` target, cmd.exe re-parses the trailing
 * arguments, so an argument containing cmd metacharacters
 * (`& | < > ^ " % ( )`, CR/LF) would execute attacker-controlled commands. This
 * function FAILS CLOSED: if any arg passed to a batch wrapper matches a cmd
 * metacharacter it THROWS `unsafe_batch_argument` BEFORE spawning. Callers must
 * therefore never hand free-text (prompts, briefs, repo content) directly as a
 * batch argument — pass such data via a temp file path or the child's stdin.
 * Non-batch (`.exe`/direct) targets are spawned via CreateProcess with no shell
 * and are unaffected by this check.
 *
 * PROCESS GROUP (POSIX): the child is spawned with `detached: true` so it becomes
 * the leader of a NEW process group (its pid == its pgid). A reviewer that forks a
 * descendant — or whose shell wrapper backgrounds a process — then lives in that
 * group, so forceKill can signal the WHOLE group (`process.kill(-child.pid, ...)`)
 * and no orphaned descendant survives the watchdog still holding the gate's
 * ambient permissions. detached does NOT change stdio (the adapters' piped
 * stdin/stdout/stderr is preserved) and we deliberately do NOT call child.unref()
 * — the gate awaits the child, so the parent must stay attached. On Windows
 * detached is NOT set: forceKill already does a `taskkill /F /T` TREE kill there,
 * and a detached child with inherited stdio could spawn a new console window, so
 * Windows behavior is left exactly as before.
 *
 * @param {string}   resolvedPath  - absolute path returned by resolveExecutable
 * @param {string[]} args
 * @param {object}   options       - { cwd, env, stdio }
 * @returns {import("node:child_process").ChildProcess}
 * @throws {Error} "unsafe_batch_argument" when a batch wrapper would receive a
 *                 cmd-metacharacter argument.
 */
export function spawnResolved(resolvedPath, args, options = {}) {
  let command = resolvedPath;
  let finalArgs = args;

  if (process.platform === "win32") {
    const lower = resolvedPath.toLowerCase();
    if (lower.endsWith(".cmd") || lower.endsWith(".bat")) {
      // Defense-in-depth (Layer B): reject any cmd-metacharacter argument BEFORE
      // spawning. cmd.exe /c re-parses these args, so this prevents the trailing
      // arguments from breaking out into attacker-controlled commands.
      for (const arg of args) {
        if (CMD_METACHAR_RE.test(String(arg))) {
          throw new Error("unsafe_batch_argument");
        }
      }
      // Wrap batch files with cmd.exe /c to avoid EINVAL with shell:false.
      command = "cmd.exe";
      finalArgs = ["/c", resolvedPath, ...args];
    }
  }

  return spawn(command, finalArgs, {
    cwd: options.cwd,
    env: options.env,
    shell: false,
    stdio: options.stdio || ["ignore", "pipe", "pipe"],
    windowsHide: true,
    // POSIX only: new process group/session so a forked descendant is killable as
    // a group (see forceKill). Never on Windows (taskkill /F /T already tree-kills,
    // and a detached console would change inherited-stdio behavior). We do NOT
    // unref() — the gate awaits this child.
    detached: process.platform !== "win32",
  });
}

// ---------------------------------------------------------------------------
// Custom-reviewer argument template validation
// ---------------------------------------------------------------------------

/** Placeholders that a custom reviewer's args array may use. */
export const ALLOWED_PLACEHOLDERS = new Set(["cwd", "diffPath", "briefPath", "jobPath"]);

/**
 * Expand `{placeholder}` tokens in a reviewer args array.
 * Throws if an unknown placeholder is encountered (injection guard).
 *
 * @param {string[]} args   - template args from reviewer config
 * @param {object}   values - map of placeholder → value
 * @returns {string[]}
 */
export function expandArgs(args, values) {
  return args.map((arg) =>
    String(arg).replace(/\{([^}]+)\}/g, (_m, name) => {
      if (!ALLOWED_PLACEHOLDERS.has(name)) {
        throw new Error(`Unknown custom reviewer placeholder: ${name}`);
      }
      return values[name] || "";
    })
  );
}
