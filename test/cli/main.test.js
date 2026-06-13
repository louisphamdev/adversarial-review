import test from "node:test";
import assert from "node:assert/strict";
import { helpText } from "../../src/cli/main.js";

test("help text lists primary commands", () => {
  const text = helpText();
  for (const command of ["install", "check", "hook", "run", "doctor"]) {
    assert.match(text, new RegExp(`\\b${command}\\b`));
  }
});
