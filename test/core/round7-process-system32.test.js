// ROUND7 regression (GPT-5.5-xhigh): spawnResolved wrapped Windows .cmd/.bat targets
// via a BARE "cmd.exe", which CreateProcess resolves from the untrusted repo cwd first
// (repo-local cmd.exe RCE). forceKill likewise used a bare "taskkill". Both now anchor
// to an ABSOLUTE %SystemRoot%\System32 path via system32Path().

import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { system32Path } from "../../src/core/process.js";

test("system32Path anchors to a System32 path for the requested executable", () => {
  const p = system32Path("cmd.exe");
  const norm = p.replace(/\\/g, "/").toLowerCase();
  assert.ok(norm.includes("/system32/"), `${p} must live under System32`);
  assert.ok(norm.endsWith("/cmd.exe"), `${p} must end with the requested exe`);
});

test("system32Path is an absolute path on win32", () => {
  const p = system32Path("taskkill.exe");
  if (process.platform === "win32") {
    assert.ok(path.isAbsolute(p), `${p} must be absolute on win32`);
  }
  // On any platform the System32 anchoring (not a bare name) is what closes the hole.
  assert.ok(p.toLowerCase().replace(/\\/g, "/").includes("system32/taskkill.exe"));
});
