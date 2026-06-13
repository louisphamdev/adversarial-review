// Transcript parser and skip detection tests.
// Ports relevant cases from tests/test_guard.py (TestEscapeHatch, TestScanKeys)
// plus additional Node-specific cases (Windows paths, isSubagentTranscript).

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  parseJsonl,
  tsKey,
  scanKeys,
  collectReviewOutputs,
  isSubagentTranscript,
  lastUserText,
  wantsSkip,
} from "../../src/core/transcript.js";

// ---------------------------------------------------------------------------
// Helpers (mirror guard.py _harness helpers inline for clarity)
// ---------------------------------------------------------------------------

const TS0 = "2026-06-11T10:00:00Z";
const TS1 = "2026-06-11T10:01:00Z";
const TS2 = "2026-06-11T10:02:00Z";

/** Build a minimal transcript entry representing an Edit tool call. */
function makeEditEntry(timestamp, filePath, toolName = "Edit") {
  return {
    type: "assistant",
    timestamp,
    message: {
      role: "assistant",
      content: [
        {
          type: "tool_use",
          id: `tool-${timestamp}-${toolName}`,
          name: toolName,
          input: { file_path: filePath },
        },
      ],
    },
  };
}

/** Build a user text entry (genuine message, not isMeta). */
function makeUserText(timestamp, text) {
  return {
    type: "user",
    timestamp,
    message: {
      role: "user",
      content: text,
    },
  };
}

// ---------------------------------------------------------------------------
// parseJsonl
// ---------------------------------------------------------------------------

describe("parseJsonl", () => {
  it("parses valid JSONL lines into objects", () => {
    const text = '{"a":1}\n{"b":2}\n';
    const result = parseJsonl(text);
    assert.deepEqual(result, [{ a: 1 }, { b: 2 }]);
  });

  it("drops bad lines silently (tolerant mode)", () => {
    const text = '{"a":1}\nbad json\n{"c":3}';
    const result = parseJsonl(text);
    assert.deepEqual(result, [{ a: 1 }, { c: 3 }]);
  });

  it("handles Windows-style CRLF line endings", () => {
    const text = '{"a":1}\r\n{"b":2}\r\n';
    const result = parseJsonl(text);
    assert.deepEqual(result, [{ a: 1 }, { b: 2 }]);
  });

  it("returns empty array for empty string", () => {
    assert.deepEqual(parseJsonl(""), []);
  });

  it("coerces non-string input via String() — String(null)='null' is valid JSON", () => {
    // String(null) === "null", which is valid JSON (the null literal).
    // The plan spec says "tolerant: bad lines dropped" — valid lines are kept.
    assert.deepEqual(parseJsonl(null), [null]);
  });
});

// ---------------------------------------------------------------------------
// tsKey
// ---------------------------------------------------------------------------

describe("tsKey", () => {
  it("parses a UTC Z timestamp to epoch seconds", () => {
    const k = tsKey("2026-06-11T10:00:00Z");
    assert.ok(k > 0, "should return a positive epoch value");
    assert.ok(typeof k === "number");
  });

  it("parses an offset timestamp", () => {
    const k = tsKey("2026-06-11T10:00:00+07:00");
    assert.ok(k > 0);
  });

  it("returns 0 for an invalid timestamp", () => {
    assert.equal(tsKey("not-a-date"), 0);
  });

  it("returns 0 for null", () => {
    assert.equal(tsKey(null), 0);
  });

  it("returns 0 for empty string", () => {
    assert.equal(tsKey(""), 0);
  });

  it("earlier timestamps sort less than later ones", () => {
    assert.ok(tsKey(TS0) < tsKey(TS1));
    assert.ok(tsKey(TS1) < tsKey(TS2));
  });
});

// ---------------------------------------------------------------------------
// scanKeys — edit detection
// ---------------------------------------------------------------------------

describe("scanKeys - edit detection", () => {
  it("records the last Edit tool timestamp as lastEditKey", () => {
    const entries = [makeEditEntry(TS0, "/x/a.py", "Edit")];
    const { lastEditKey, editedPaths } = scanKeys(entries);
    assert.ok(lastEditKey > 0);
    assert.ok(editedPaths.has("/x/a.py"));
  });

  it("recognises Write as an edit tool", () => {
    const entries = [makeEditEntry(TS0, "/x/b.py", "Write")];
    const { lastEditKey, editedPaths } = scanKeys(entries);
    assert.ok(lastEditKey > 0);
    assert.ok(editedPaths.has("/x/b.py"));
  });

  it("recognises MultiEdit as an edit tool", () => {
    const entries = [makeEditEntry(TS0, "/x/c.py", "MultiEdit")];
    const { lastEditKey } = scanKeys(entries);
    assert.ok(lastEditKey > 0);
  });

  it("recognises NotebookEdit as an edit tool (notebook_path field)", () => {
    const entry = {
      type: "assistant",
      timestamp: TS0,
      message: {
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "nb-tool",
            name: "NotebookEdit",
            input: { notebook_path: "/x/analysis.ipynb" },
          },
        ],
      },
    };
    const { lastEditKey, editedPaths } = scanKeys([entry]);
    assert.ok(lastEditKey > 0);
    assert.ok(editedPaths.has("/x/analysis.ipynb"));
  });

  it("picks the LATEST edit key when multiple edits exist", () => {
    const entries = [
      makeEditEntry(TS0, "/x/a.py", "Edit"),
      makeEditEntry(TS2, "/x/b.py", "Write"),
    ];
    const { lastEditKey } = scanKeys(entries);
    assert.equal(lastEditKey, tsKey(TS2));
  });

  it("returns lastEditKey 0 when there are no edit entries", () => {
    const { lastEditKey } = scanKeys([]);
    assert.equal(lastEditKey, 0);
  });

  it("collects all edited paths from multiple entries", () => {
    const entries = [
      makeEditEntry(TS0, "/x/a.py", "Edit"),
      makeEditEntry(TS1, "/x/b.py", "Write"),
    ];
    const { editedPaths } = scanKeys(entries);
    assert.ok(editedPaths.has("/x/a.py"));
    assert.ok(editedPaths.has("/x/b.py"));
  });
});

// ---------------------------------------------------------------------------
// scanKeys — edit-only robustness (review-detection ordering keys were removed;
// acceptance of a prior review is verdict-based, see collectReviewOutputs)
// ---------------------------------------------------------------------------

/** Build a completed (non-edit) Task tool_use + tool_result pair. */
function makeTaskEntries(timestamp, toolId) {
  return [
    {
      type: "assistant",
      timestamp,
      message: {
        role: "assistant",
        content: [{ type: "tool_use", id: toolId, name: "Task", input: { prompt: "x" } }],
      },
    },
    {
      type: "user",
      timestamp,
      message: {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: toolId, content: "done" }],
      },
    },
  ];
}

describe("scanKeys - edit-only robustness", () => {
  it("invalid timestamps default to 0 and do not crash", () => {
    const entries = [
      makeEditEntry("not-a-timestamp", "/x/a.py"),
      ...makeTaskEntries("also-bad", "t1"),
    ];
    const { lastEditKey } = scanKeys(entries);
    assert.equal(lastEditKey, 0); // bad timestamp, but no throw
  });

  it("returns empty editedPaths when no edit tools were used", () => {
    const entries = [...makeTaskEntries(TS0, "t1")];
    const { editedPaths, lastEditKey } = scanKeys(entries);
    assert.equal(editedPaths.size, 0);
    assert.equal(lastEditKey, 0); // a Task is not an edit
  });
});

// ---------------------------------------------------------------------------
// collectReviewOutputs — final OUTPUT text of completed reviews after a key
// ---------------------------------------------------------------------------

describe("collectReviewOutputs", () => {
  // Build a completed review Task whose tool_result content is `output`.
  function reviewWithOutput(timestamp, toolId, output) {
    return [
      {
        type: "assistant",
        timestamp,
        message: {
          role: "assistant",
          content: [{ type: "tool_use", id: toolId, name: "Task", input: { prompt: "x" } }],
        },
      },
      {
        type: "user",
        timestamp,
        message: {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: toolId, content: output }],
        },
      },
    ];
  }

  it("returns the OUTPUT text of a review completed after the key", () => {
    const entries = [
      makeEditEntry(TS0, "/x/a.py"),
      ...reviewWithOutput(TS1, "t1", "VERDICT OUTPUT"),
    ];
    const outputs = collectReviewOutputs(entries, tsKey(TS0));
    assert.deepEqual(outputs, ["VERDICT OUTPUT"]);
  });

  it("ignores reviews completed at or before the key (stale)", () => {
    const entries = [
      ...reviewWithOutput(TS0, "t0", "stale output"),
      makeEditEntry(TS1, "/x/a.py"),
    ];
    const outputs = collectReviewOutputs(entries, tsKey(TS1));
    assert.deepEqual(outputs, []);
  });

  it("ignores incomplete reviews (no tool_result)", () => {
    const entries = [
      makeEditEntry(TS0, "/x/a.py"),
      {
        type: "assistant",
        timestamp: TS1,
        message: {
          role: "assistant",
          content: [{ type: "tool_use", id: "t1", name: "Task", input: { prompt: "x" } }],
        },
      },
    ];
    const outputs = collectReviewOutputs(entries, tsKey(TS0));
    assert.deepEqual(outputs, []);
  });

  it("concatenates text blocks in array-form tool_result content", () => {
    const entries = [
      makeEditEntry(TS0, "/x/a.py"),
      {
        type: "assistant",
        timestamp: TS1,
        message: {
          role: "assistant",
          content: [{ type: "tool_use", id: "t1", name: "Task", input: { prompt: "x" } }],
        },
      },
      {
        type: "user",
        timestamp: TS1,
        message: {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "t1",
              content: [
                { type: "text", text: "line1" },
                { type: "text", text: "line2" },
              ],
            },
          ],
        },
      },
    ];
    const outputs = collectReviewOutputs(entries, tsKey(TS0));
    assert.deepEqual(outputs, ["line1\nline2"]);
  });

  it("returns [] when there are no reviews", () => {
    const entries = [makeEditEntry(TS0, "/x/a.py")];
    assert.deepEqual(collectReviewOutputs(entries, 0), []);
  });
});

// ---------------------------------------------------------------------------
// isSubagentTranscript (Windows path + g- sessionId cases)
// ---------------------------------------------------------------------------

describe("isSubagentTranscript", () => {
  it("returns true for a Windows backslash subagents path", () => {
    // Windows path with \subagents\ — normalized to /subagents/ internally.
    assert.equal(
      isSubagentTranscript("C:\\Users\\foo\\.claude\\projects\\proj\\subagents\\abc.jsonl"),
      true,
    );
  });

  it("returns true for a forward-slash subagents path", () => {
    assert.equal(
      isSubagentTranscript("/home/foo/.claude/projects/proj/subagents/abc.jsonl"),
      true,
    );
  });

  it("returns true for an agent- basename", () => {
    assert.equal(
      isSubagentTranscript("/some/path/agent-01234567.jsonl"),
      true,
    );
  });

  it("returns true for a g- session id regardless of path", () => {
    assert.equal(
      isSubagentTranscript("/normal/path/session.jsonl", "g-abc123"),
      true,
    );
  });

  it("returns false for a normal main-session transcript path", () => {
    assert.equal(
      isSubagentTranscript("/home/foo/.claude/projects/proj/main-session.jsonl", "abc123"),
      false,
    );
  });

  it("returns false when sessionId is empty and path is normal", () => {
    assert.equal(isSubagentTranscript("/home/foo/session.jsonl", ""), false);
  });

  it("handles empty transcriptPath without throwing", () => {
    assert.equal(isSubagentTranscript("", "normal-id"), false);
  });

  it("handles null transcriptPath without throwing", () => {
    assert.equal(isSubagentTranscript(null, ""), false);
  });
});

// ---------------------------------------------------------------------------
// lastUserText
// ---------------------------------------------------------------------------

describe("lastUserText", () => {
  it("returns the last user string-content entry", () => {
    const entries = [
      makeUserText(TS0, "hello"),
      makeUserText(TS1, "world"),
    ];
    assert.equal(lastUserText(entries), "world");
  });

  it("skips assistant entries", () => {
    const entries = [
      makeUserText(TS0, "my message"),
      { type: "assistant", timestamp: TS1, message: { content: "ai reply" } },
    ];
    assert.equal(lastUserText(entries), "my message");
  });

  it("skips isMeta entries", () => {
    const entries = [
      makeUserText(TS0, "real message"),
      {
        type: "user",
        isMeta: true,
        timestamp: TS1,
        message: { content: "system injection" },
      },
    ];
    assert.equal(lastUserText(entries), "real message");
  });

  it("skips entries whose content is purely tool_result blocks", () => {
    const entries = [
      makeUserText(TS0, "genuine question"),
      {
        type: "user",
        timestamp: TS1,
        message: {
          content: [{ type: "tool_result", tool_use_id: "x", content: "output" }],
        },
      },
    ];
    assert.equal(lastUserText(entries), "genuine question");
  });

  it("returns text from a content-array with text blocks", () => {
    const entries = [
      {
        type: "user",
        timestamp: TS0,
        message: {
          content: [{ type: "text", text: "hello from array" }],
        },
      },
    ];
    assert.equal(lastUserText(entries), "hello from array");
  });

  it("returns empty string when no genuine user entry exists", () => {
    assert.equal(lastUserText([]), "");
  });
});

// ---------------------------------------------------------------------------
// wantsSkip — positive cases (port of TestEscapeHatch.test_positive_skip_phrases)
// ---------------------------------------------------------------------------

describe("wantsSkip - positive (genuine skip requests)", () => {
  it("'skip the review please' → true", () => {
    assert.equal(wantsSkip("skip the review please"), true);
  });

  it("'please skip the debate' → true", () => {
    assert.equal(wantsSkip("please skip the debate"), true);
  });

  it("'skip the panel' → true", () => {
    assert.equal(wantsSkip("skip the panel"), true);
  });

  // Port of test_continuations_and_boundaries_match
  it("'skip the review and ship it' → true", () => {
    assert.equal(wantsSkip("skip the review and ship it"), true);
  });

  it("'skip the review thanks' → true", () => {
    assert.equal(wantsSkip("skip the review thanks"), true);
  });

  it("'skip the review today' → true", () => {
    assert.equal(wantsSkip("skip the review today"), true);
  });

  it("'skip the debate for now' → true", () => {
    assert.equal(wantsSkip("skip the debate for now"), true);
  });

  it("'please just skip the panel.' → true", () => {
    assert.equal(wantsSkip("please just skip the panel."), true);
  });

  it("skip with newline continuation → true", () => {
    assert.equal(wantsSkip("skip the review\nthanks, that's all"), true);
  });

  // Vietnamese skip phrases (port of test_continuations_and_boundaries_match Vietnamese branch)
  it("'bỏ qua review' → true (Vietnamese genuine skip)", () => {
    assert.equal(wantsSkip("bỏ qua review"), true);
  });

  it("'bo qua review' → true (ASCII Vietnamese)", () => {
    assert.equal(wantsSkip("bo qua review"), true);
  });
});

// ---------------------------------------------------------------------------
// wantsSkip — negation cases (port of TestEscapeHatch.test_negation_does_not_disarm)
// ---------------------------------------------------------------------------

describe("wantsSkip - negation window (NOT a skip request)", () => {
  it("'do not skip the review' → false", () => {
    assert.equal(wantsSkip("do not skip the review"), false);
  });

  it("'without skipping the review' → false", () => {
    assert.equal(wantsSkip("without skipping the review"), false);
  });

  it("'never skip the debate' → false", () => {
    assert.equal(wantsSkip("never skip the debate"), false);
  });
});

// ---------------------------------------------------------------------------
// wantsSkip — trailing noun guard (port of TestEscapeHatch.test_no_overmatch_trailing_noun)
// ---------------------------------------------------------------------------

describe("wantsSkip - trailing noun guard (NOT a skip request)", () => {
  it("'skip the review meeting' → false (trailing noun 'meeting')", () => {
    assert.equal(wantsSkip("skip the review meeting"), false);
  });

  it("'skip the debate club tonight' → false", () => {
    assert.equal(wantsSkip("skip the debate club tonight"), false);
  });

  it("'skip the panel discussion about lunch' → false", () => {
    assert.equal(wantsSkip("skip the panel discussion about lunch"), false);
  });

  // Vietnamese trailing-noun guards
  it("'bo qua review club' → false (trailing noun 'club')", () => {
    assert.equal(wantsSkip("bo qua review club"), false);
  });

  it("'toi muon bo qua review buoi hop' → false (trailing noun 'buoi hop')", () => {
    assert.equal(wantsSkip("toi muon bo qua review buoi hop"), false);
  });
});

// ---------------------------------------------------------------------------
// wantsSkip — hook-echo self-disarm defense
// (port of TestEscapeHatch.test_self_disarm_on_own_reason)
// ---------------------------------------------------------------------------

describe("wantsSkip - hook echo defense", () => {
  it("the gate's own single-review block reason does NOT self-disarm", () => {
    // The block reason produced by guard.py (level 1) contains the phrase
    // "skip the review" inside the escape-hatch note. HOOK_ECHO_RE must catch it.
    const blockReason =
      "Code was modified this turn but has NOT passed an adversarial review. " +
      "Before finishing, dispatch an ADVERSARIAL code reviewer... " +
      "The reviewer's prompt MUST contain the exact token 'adversarial-review-gate' " +
      "and run to completion... " +
      "Escape hatch: if the user's latest message tells you to skip the review, " +
      "this gate stands down.";
    assert.equal(wantsSkip(blockReason), false);
  });

  it("the gate's own debate block reason does NOT self-disarm", () => {
    const blockReason =
      "Code was modified this turn and the change is HIGH-STAKES... " +
      "token 'adversarial-review-gate'... " +
      "token 'adversarial-debate-gate' and run to completion — that is how this gate recognises a real debate. " +
      "Escape hatch: if the user's latest message tells you to skip the debate, " +
      "this gate stands down.";
    assert.equal(wantsSkip(blockReason), false);
  });

  it("a hook-echo phrase triggers HOOK_ECHO_RE regardless of skip content", () => {
    // Any text that matches HOOK_ECHO_RE must return false even if it contains
    // a skip phrase — layer-2 defense.
    assert.equal(
      wantsSkip("stop hook feedback: skip the review please"),
      false,
    );
  });

  it("a text with hook feedback signal does NOT disarm", () => {
    assert.equal(
      wantsSkip(
        "has NOT passed an adversarial review — skip the review please",
      ),
      false,
    );
  });
});

// ---------------------------------------------------------------------------
// wantsSkip — apostrophe-normalization regression (gate-bypass fix)
//
// Before the fix, the replace regex was a no-op (all three chars were U+2019),
// so straight apostrophes in contractions like "don't" were NOT normalized.
// WORD_RE split "don't" into ["don", "t"], WORD_RE missed "dont", and NEG_RE
// failed to fire — causing wantsSkip to wrongly return true (gate disarmed).
// After the fix both U+2018 and U+2019 are mapped to a straight apostrophe,
// so contractions collapse ("don't" → "dont") and NEG_RE fires correctly.
// ---------------------------------------------------------------------------

describe("wantsSkip - apostrophe contraction negation (regression: gate-bypass fix)", () => {
  // Straight-apostrophe contractions — the real-world input users type.
  it("\"don't skip the review\" (straight apostrophe) → false", () => {
    assert.equal(wantsSkip("don't skip the review"), false);
  });

  it("\"doesn't skip the review\" → false", () => {
    assert.equal(wantsSkip("doesn't skip the review"), false);
  });

  it("\"won't skip the debate\" → false", () => {
    assert.equal(wantsSkip("won't skip the debate"), false);
  });

  it("\"can't skip the review\" → false", () => {
    assert.equal(wantsSkip("can't skip the review"), false);
  });

  it("\"we don't want to skip the debate\" → false", () => {
    assert.equal(wantsSkip("we don't want to skip the debate"), false);
  });

  // Confirm genuine-skip path is still detected (no regression).
  it("\"skip the review please\" → true (genuine skip still detected)", () => {
    assert.equal(wantsSkip("skip the review please"), true);
  });

  it("\"please skip the debate\" → true (genuine skip still detected)", () => {
    assert.equal(wantsSkip("please skip the debate"), true);
  });

  // No-apostrophe negation baseline (was already working before fix).
  it("\"do not skip the review\" (no apostrophe) → false", () => {
    assert.equal(wantsSkip("do not skip the review"), false);
  });

  // Curly-apostrophe variant U+2019 — also normalized by the fix.
  it("“don’t skip the review” (curly U+2019) → false", () => {
    assert.equal(wantsSkip("don’t skip the review"), false);
  });
});

// ---------------------------------------------------------------------------
// wantsSkip — edge cases
// ---------------------------------------------------------------------------

describe("wantsSkip - edge cases", () => {
  it("empty string → false", () => {
    assert.equal(wantsSkip(""), false);
  });

  it("null → false", () => {
    assert.equal(wantsSkip(null), false);
  });

  it("unrelated text → false", () => {
    assert.equal(wantsSkip("deploy the new feature and run tests"), false);
  });

  it("case-insensitive: SKIP THE REVIEW → true", () => {
    assert.equal(wantsSkip("SKIP THE REVIEW please"), true);
  });

  it("'skip the debate' directly → true (level-2 vocabulary)", () => {
    // Mirrors test_skip_debate_vocab_stands_down
    assert.equal(wantsSkip("skip the debate"), true);
  });
});
