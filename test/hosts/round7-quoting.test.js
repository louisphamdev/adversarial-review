// ROUND7 regression (GPT-5.5-xhigh): the hook/wrapper command quoting only escaped
// whitespace + SHELL_META_RE, leaving a BARE single quote (') or glob char (* ? [ ]) in
// a binPath. Under a POSIX shell the bare ' opens an unterminated quoted string (the
// Stop-hook command fails to parse → no {"decision":"block"} → fail-OPEN) and a bare
// glob expands to a different/missing executable (same fail-open). These must now be
// double-quoted (they are inert inside double quotes). $ and backtick must STILL be
// rejected outright (they expand inside double quotes).

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mergeClaudeCodeSettings } from "../../src/hosts/claude-code.js";
import { wrapperInstructions } from "../../src/hosts/wrapper.js";

function stopCmd(binPath) {
  const merged = mergeClaudeCodeSettings({}, binPath);
  return merged.hooks.Stop[0].hooks[0].command;
}
function wrapperCmd(binPath) {
  return wrapperInstructions({ host: "codex", binPath }).wrapperCommand;
}

describe("ROUND7 claude-code hook quoting", () => {
  it("double-quotes a binPath containing an apostrophe", () => {
    const cmd = stopCmd("/tmp/O'Brien/adversarial-review-gate");
    assert.ok(cmd.startsWith('"/tmp/O\'Brien/adversarial-review-gate"'), cmd);
  });

  it("double-quotes a binPath containing a glob character", () => {
    const cmd = stopCmd("/tmp/ar*/adversarial-review-gate");
    assert.ok(cmd.startsWith('"/tmp/ar*/adversarial-review-gate"'), cmd);
  });

  it("double-quotes a binPath containing a bracket glob", () => {
    const cmd = stopCmd("/tmp/ar[1]/adversarial-review-gate");
    assert.ok(cmd.startsWith('"/tmp/ar[1]/adversarial-review-gate"'), cmd);
  });

  it("still REJECTS a binPath with command substitution ($)", () => {
    assert.throws(() => stopCmd("/tmp/$(touch pwned)/adversarial-review-gate"), /\$|backtick|substitution/i);
  });

  it("still REJECTS a binPath with a backtick", () => {
    assert.throws(() => stopCmd("/tmp/`id`/adversarial-review-gate"), /backtick|substitution|\$/i);
  });
});

describe("ROUND7 wrapper command quoting", () => {
  it("double-quotes a binPath containing an apostrophe", () => {
    const cmd = wrapperCmd("/tmp/O'Brien/adversarial-review-gate");
    assert.ok(cmd.startsWith('"/tmp/O\'Brien/adversarial-review-gate"'), cmd);
  });

  it("double-quotes a binPath containing a glob character", () => {
    const cmd = wrapperCmd("/tmp/ar*/adversarial-review-gate");
    assert.ok(cmd.startsWith('"/tmp/ar*/adversarial-review-gate"'), cmd);
  });

  it("still REJECTS a binPath with command substitution", () => {
    assert.throws(() => wrapperCmd("/tmp/$(touch pwned)/adversarial-review-gate"), /\$|backtick|substitution/i);
  });
});
