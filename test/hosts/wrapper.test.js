import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { wrapperInstructions } from "../../src/hosts/wrapper.js";

describe("wrapper host: bin quoting in printed launch command", () => {
  // -------------------------------------------------------------------------
  // ROUND-5 multi-token binPath (broken launch command): the installer's DEFAULT
  // fallback bin is the COMPOSITE invocation `npx adversarial-review-gate`.
  // Wrapping the WHOLE composite in one pair of quotes
  // (`"npx adversarial-review-gate" run ...`) makes the shell try to run a
  // literal (space-containing) executable name → the wrapper never launches and
  // the review gate is skipped. The launcher must stay a SEPARATE bare token.
  // -------------------------------------------------------------------------
  it("does NOT wrap the composite 'npx adversarial-review-gate' default in one quoted token", () => {
    const { wrapperCommand } = wrapperInstructions({
      host: "codex",
      reviewer: "opencode",
      binPath: "npx adversarial-review-gate",
    });
    assert.equal(
      wrapperCommand,
      "npx adversarial-review-gate run --host codex -- codex <your-command>"
    );
    assert.ok(
      !wrapperCommand.startsWith('"npx adversarial-review-gate"'),
      `composite bin must not be wrapped as one quoted token, got: ${wrapperCommand}`
    );
  });

  it("leaves a bare single-name bin unquoted", () => {
    const { wrapperCommand } = wrapperInstructions({
      host: "codex",
      binPath: "adversarial-review-gate",
    });
    assert.equal(
      wrapperCommand,
      "adversarial-review-gate run --host codex -- codex <your-command>"
    );
  });

  it("wraps a SINGLE spaced executable path as one quoted token", () => {
    const binSpace = "C:\\Users\\John Doe\\AppData\\Roaming\\npm\\bin\\adversarial-review.js";
    const { wrapperCommand } = wrapperInstructions({
      host: "codex",
      binPath: binSpace,
    });
    assert.ok(
      wrapperCommand.startsWith(`"${binSpace}" run --host codex`),
      `single spaced path must be one quoted token, got: ${wrapperCommand}`
    );
  });

  it("keeps the launcher bare and quotes only the spaced path of a composite 'node <path>'", () => {
    const binNode = 'node "C:\\Program Files\\adversarial-review\\bin\\adversarial-review.js"';
    const { wrapperCommand } = wrapperInstructions({
      host: "codex",
      binPath: binNode,
    });
    assert.ok(
      wrapperCommand.startsWith(
        'node "C:\\Program Files\\adversarial-review\\bin\\adversarial-review.js" run --host codex'
      ),
      `composite node path must keep launcher bare + path quoted, got: ${wrapperCommand}`
    );
  });

  it("falls back to the default npx invocation when no binPath is given (runnable)", () => {
    const { wrapperCommand } = wrapperInstructions({ host: "codex" });
    assert.equal(
      wrapperCommand,
      "npx adversarial-review-gate run --host codex -- codex <your-command>"
    );
  });

  it("still emits enforcement + residual-risk metadata", () => {
    const r = wrapperInstructions({ host: "opencode", reviewer: "codex" });
    assert.equal(r.host, "opencode");
    assert.equal(r.enforcement, "wrapper-enforced");
    assert.match(r.residualRisk, /Wrapper enforcement depends on/);
    assert.match(r.residualRisk, /reviewer: codex/);
  });
});
