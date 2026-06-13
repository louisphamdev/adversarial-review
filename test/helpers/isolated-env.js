// Shared test helper: build a HERMETIC environment for CLI/gate tests.
//
// ROOT BUG this guards against: any test that invokes a CLI command (`check`,
// `run`, `hook`, `doctor`, `install`) or otherwise reaches `loadEffectiveConfig`
// / `resolveStateDir` will, by default, read the developer's REAL
// `~/.adversarial-review/config.json` and `policy.json`. `loadEffectiveConfig`
// resolves the user-level base via `homeDir(env)`, which falls back to
// `os.homedir()` whenever the injected env carries no
// `ADVERSARIAL_REVIEW_HOME` / `HOME` / `USERPROFILE`. A machine-wide config that
// enforces an external reviewer (e.g. opencode) would then make those tests
// invoke the REAL reviewer and hang/fail.
//
// Every test that exercises those paths MUST therefore inject an env whose
// `ADVERSARIAL_REVIEW_HOME` points at a fresh, EMPTY per-test temp dir so the
// loader reads an empty/controlled user-level config — never the real home.
//
// Usage:
//   import { makeIsolatedEnv } from "../helpers/isolated-env.js";
//   const { env, home, stateDir, cleanup } = await makeIsolatedEnv();
//   try { ...use env... } finally { await cleanup(); }

import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

/**
 * Create a fresh per-test isolated environment.
 *
 * Returns an `env` object that:
 *   - inherits `process.env` (so PATH/PATHEXT and friends still resolve `node`);
 *   - overrides `ADVERSARIAL_REVIEW_HOME` to a fresh EMPTY temp dir so the config
 *     loader reads an empty user-level config (never the real `~`);
 *   - also overrides `HOME` and `USERPROFILE` to the SAME temp dir so any code
 *     path that bypasses `ADVERSARIAL_REVIEW_HOME` still lands in the isolated
 *     home, never the developer's real home;
 *   - overrides `ADVERSARIAL_REVIEW_STATE_DIR` to a fresh per-test state dir.
 *
 * @param {object} [extra]  - additional env entries merged LAST (win over defaults)
 * @returns {Promise<{ env: object, home: string, stateDir: string, cleanup: () => Promise<void> }>}
 */
export async function makeIsolatedEnv(extra = {}) {
  const home = await mkdtemp(join(tmpdir(), "ar-iso-home-"));
  const stateDir = join(home, "state");
  await mkdir(stateDir, { recursive: true });

  const env = {
    ...process.env,
    // Redirect the user-level config base away from the real home.
    ADVERSARIAL_REVIEW_HOME: home,
    HOME: home,
    USERPROFILE: home,
    // Keep session state out of the user-level default path too.
    ADVERSARIAL_REVIEW_STATE_DIR: stateDir,
    ...extra,
  };

  return {
    env,
    home,
    stateDir,
    cleanup: () => rm(home, { recursive: true, force: true }),
  };
}
