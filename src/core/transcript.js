// Transcript parser and skip detection.
// Ports the Python functions from hooks/guard.py:
//   - ts_key         -> tsKey
//   - iter_tool_uses -> iterToolUses (inline)
//   - completed_tool_ids -> completedToolIds (inline in collectReviewOutputs)
//   - scan_keys      -> scanKeys (edit evidence only)
//   - is_subagent    -> isSubagentTranscript
//   - last_user_text -> lastUserText
//   - wants_skip     -> wantsSkip

import path from "node:path";
import { realpathSync } from "node:fs";
import { isUnderSkipDir } from "./diff.js";

const EDIT_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);

/**
 * Whether an edit target sits inside a skip dir (a dependency/cache tree or a
 * coding-agent working/state/memory directory such as `.claude` / `.opencode`).
 * Such an edit is NOT a change to the reviewable project, so it must not count as
 * edit evidence (otherwise constant agent-memory churn would surface as a change
 * the gate reacts to every Stop). Mirrors the diff scope, which excludes the same
 * dirs from `changedFiles`. The path is made workspace-relative + POSIX-normalized
 * so `isUnderSkipDir`'s segment check sees the real parent directories.
 */
function editUnderSkipDir(cwd, filePath) {
  let rel;
  try {
    rel = cwd ? path.relative(cwd, path.resolve(cwd, filePath)) : filePath;
  } catch {
    rel = filePath;
  }
  return isUnderSkipDir(String(rel).replace(/\\/g, "/"));
}

/**
 * Whether an edit tool's file_path is WITHIN the workspace root `cwd`. Edits to files
 * OUTSIDE cwd — e.g. a temporary scratch script the agent wrote to /tmp or a sibling
 * directory — are NOT changes to THIS workspace, so they must not count as "edit
 * evidence". Otherwise the gate sees an edit in the transcript but an empty cwd-scoped
 * diff and FAIL-CLOSED blocks (the "it blocks on files outside the repo" complaint),
 * even though nothing reviewable in the workspace changed. Absolute paths are compared
 * directly; a relative path is resolved against cwd. When cwd is not provided the check
 * is a no-op (count every edit, preserving the prior behavior).
 *
 * @param {string|undefined} cwd
 * @param {string} filePath
 * @returns {boolean}
 */
function editPathInCwd(cwd, filePath) {
  if (!cwd) return true;
  try {
    const abs = path.resolve(cwd, filePath);
    // Containment is checked against BOTH the literal cwd AND its realpath. When cwd is a
    // symlink/junction to the real workspace and the host records the edit via the REAL
    // absolute path (or vice versa), a single-root check would mis-classify a genuine
    // in-workspace edit as OUTSIDE and DROP it — a fail-open if the diff also missed it.
    // (audit / GPT-5.5: symlinked workspace root.)
    const roots = new Set([path.resolve(cwd)]);
    try {
      roots.add(realpathSync(path.resolve(cwd)));
    } catch {
      /* cwd may be unresolvable (race/permission): the literal root still applies */
    }
    for (const root of roots) {
      if (abs === root) return true;
      const rel = path.relative(root, abs);
      if (rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel)) return true;
    }
    return false;
  } catch {
    return true; // on a path-resolution error, be permissive (fail toward review)
  }
}
const REVIEW_TOOLS = new Set(["Task", "Agent"]);

// ---- Escape-hatch detection (ported from guard.py) --------------------------
// Tight allow-list of fillers between "skip" and the object; Vietnamese variants
// are included (bỏ qua review, khỏi review, etc.). A negation guard rejects
// "don't skip the review" etc.  A trailing-NOUN guard rejects "skip the debate
// club" etc. — only sentence-end, punctuation, newline, or a function-word
// continuation are accepted.
// Note: the `g` flag is required so that re.exec() advances lastIndex on each
// call inside wantsSkip's while loop. Without `g`, exec() returns the same
// match every time, causing an infinite loop.
const SKIP_RE = new RegExp(
  "(?:" +
    // English: skip[ping] <optional fillers> <object>
    "\\bskip(?:ping)?\\s+(?:this\\s+|that\\s+|the\\s+|an?\\s+|adversarial\\s+|code\\s+|multi-agent\\s+)*(?:review|debate|panel)" +
    // Vietnamese: bỏ [qua] <object>  or  khỏi <object>
    "|\\bb[oỏ]\\s+(?:qua\\s+)?(?:review|debate)" +
    "|\\bkh[oỏ]i\\s+(?:review|debate)" +
  ")\\b" +
  // Boundary: sentence-end / punctuation, OR a function-word / adverb continuation.
  "(?=\\s*(?:[.,!?;:)\\]\\n]|$)" +
    "|\\s+(?:please|thanks?|now|today|just|then|so|and|or|since|because" +
    "|for|this|that|too|also|entirely|altogether|finally|asap|ok(?:ay)?)\\b)",
  "gi",
);

const NEG_RE = new RegExp(
  "\\b(?:not|never|dont|doesnt|didnt|wont|cant|cannot|isnt|arent|aint|nor|without" +
    "|refrain|avoid|forbid|forbidden|prohibit|prohibited|decline|refuse|refusing" +
    "|hold\\s+off|rather\\s+not" +
    "|no\\s+(?:need|reason|way|account|means|event|circumstances)" +
    "|kh[ôo]ng|đừng|dừng|chớ|chẳng|chưa|chả)\\b",
  "i",
);

// Matches individual words (letters only, no digits, no underscore).
const WORD_RE = /[^\W\d_]+/gu;
const NEG_WINDOW_WORDS = 8;

// "? no" / "? nope" trailing negation after the skip phrase.
const TRAILING_NO_RE = /\s*\?\s*(?:absolutely\s+|certainly\s+|definitely\s+)?(?:no|nope|nah|not|never)\b/i;

// Self-disarm defense (layer 2): the gate's own block message contains the phrase
// "skip the review"; never let the gate's echo be read as a user skip request.
const HOOK_ECHO_RE =
  /stop hook feedback|has NOT passed an adversarial review|this gate (?:stands down|recognises)/i;

// ---- parseJsonl -------------------------------------------------------------

/**
 * Split a JSONL text into an array of parsed objects.
 * Lines that fail to parse are silently dropped (tolerant mode).
 *
 * @param {string} text
 * @returns {object[]}
 */
export function parseJsonl(text) {
  return String(text)
    .split(/\r?\n/)
    .filter(Boolean)
    .flatMap((line) => {
      try {
        return [JSON.parse(line)];
      } catch {
        return [];
      }
    });
}

// ---- tsKey ------------------------------------------------------------------

/**
 * Convert an ISO-8601 timestamp string to a comparable epoch float (seconds).
 * Handles the trailing-Z form and any UTC-offset form supported by Date.parse.
 * Returns 0 for any unparseable or missing value — treated as "oldest".
 *
 * Mirrors Python's ts_key() in guard.py (datetime.fromisoformat + .timestamp()).
 *
 * @param {unknown} s
 * @returns {number}
 */
export function tsKey(s) {
  if (typeof s !== "string" || !s) return 0;
  const t = s.trim();
  // Date.parse handles ISO-8601 with Z or offsets natively in Node.js / V8.
  // fromisoformat in Python 3.11+ also handles these forms — equivalent.
  const ms = Date.parse(t);
  if (Number.isNaN(ms)) return 0;
  return ms / 1000; // epoch seconds, matching Python .timestamp()
}

// ---- scanKeys ---------------------------------------------------------------

/**
 * Scan JSONL transcript entries for edit evidence: the timestamp of the most
 * recent edit tool-use and the set of file paths touched by edit tools.
 *
 * Edit tools: Edit, Write, MultiEdit, NotebookEdit.
 *
 * Review-task detection is intentionally NOT done here. Acceptance of a prior
 * review is verdict-based (collectReviewOutputs + parseVerdict in gate.js), so
 * the old sentinel-matched lastReviewKey/lastDebateKey ordering keys have been
 * removed — no production caller consumed them.
 *
 * @param {object[]} entries  Parsed transcript entries
 * @returns {{ lastEditKey: number, editedPaths: Set<string> }}
 */
export function scanKeys(entries, cwd) {
  let lastEditKey = 0;
  const editedPaths = new Set();

  for (const e of entries) {
    const key = tsKey(e?.timestamp);
    const msg = e?.message;
    if (!msg || typeof msg !== "object") continue;
    const content = msg.content;
    if (!Array.isArray(content)) continue;

    for (const blk of content) {
      if (!blk || typeof blk !== "object" || blk.type !== "tool_use") continue;
      const name = blk.name || "";
      const inp = blk.input || {};

      if (EDIT_TOOLS.has(name) && inp && typeof inp === "object") {
        for (const k of ["file_path", "notebook_path"]) {
          const p = inp[k];
          // Only count an edit whose target is WITHIN the workspace: an edit to a file
          // OUTSIDE cwd (a temp scratch script) is not a change to this workspace and
          // must not become "edit evidence" that fail-closed-blocks against an empty
          // cwd-scoped diff. lastEditKey is bumped only for in-scope edits too.
          // ALSO exclude edits inside a skip dir (dependency/cache trees and
          // coding-agent working/state/memory dirs like `.claude`/`.opencode`): they
          // are not reviewable project changes, so they must not become edit evidence —
          // consistent with the diff scope, which drops the same paths.
          if (typeof p === "string" && p && editPathInCwd(cwd, p) && !editUnderSkipDir(cwd, p)) {
            editedPaths.add(p);
            if (key > lastEditKey) lastEditKey = key;
          }
        }
      }
    }
  }

  return { lastEditKey, editedPaths };
}

// ---- collectReviewOutputs ---------------------------------------------------

/**
 * Extract the plain-text payload of a `tool_result` content block.
 *
 * Anthropic transcripts encode tool_result content either as a bare string or
 * as an array of blocks (commonly `{ type: "text", text: "..." }`). We
 * concatenate all text-bearing parts so a verdict block embedded anywhere in
 * the subagent's final output can be parsed.
 *
 * @param {unknown} content
 * @returns {string}
 */
function toolResultText(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    const parts = [];
    for (const blk of content) {
      if (typeof blk === "string") {
        parts.push(blk);
      } else if (blk && typeof blk === "object") {
        if (typeof blk.text === "string") parts.push(blk.text);
        else if (typeof blk.content === "string") parts.push(blk.content);
      }
    }
    return parts.join("\n");
  }
  return "";
}

/**
 * Collect the final OUTPUT text of every review Task/Agent tool-use that
 * COMPLETED (has a matching tool_result) strictly after `afterKey`.
 *
 * Unlike `scanKeys`, this does NOT gate on a sentinel substring — acceptance is
 * decided by the caller via `parseVerdict`. A sentinel may still be used by the
 * caller as a cheap pre-filter, but it must never be the basis for acceptance.
 *
 * Ordering: the review's timestamp (when its tool_use was issued) must be
 * strictly greater than `afterKey` (the last edit). This mirrors the
 * "completed after the last edit" requirement so a stale, pre-edit review can
 * never satisfy the current change.
 *
 * @param {object[]} entries  Parsed transcript entries
 * @param {number} afterKey   Epoch-seconds lower bound (typically lastEditKey)
 * @returns {string[]} output text strings, in transcript order
 */
export function collectReviewOutputs(entries, afterKey = 0) {
  // Map tool_use_id -> concatenated tool_result output text (completed calls).
  const outputs = new Map();
  for (const e of entries) {
    const msg = e?.message;
    if (!msg || typeof msg !== "object") continue;
    const content = msg.content;
    if (!Array.isArray(content)) continue;
    for (const blk of content) {
      if (blk && typeof blk === "object" && blk.type === "tool_result") {
        const tid = blk.tool_use_id;
        if (tid) outputs.set(tid, toolResultText(blk.content));
      }
    }
  }

  const results = [];
  for (const e of entries) {
    const key = tsKey(e?.timestamp);
    const msg = e?.message;
    if (!msg || typeof msg !== "object") continue;
    const content = msg.content;
    if (!Array.isArray(content)) continue;
    for (const blk of content) {
      if (!blk || typeof blk !== "object" || blk.type !== "tool_use") continue;
      const name = blk.name || "";
      const tid = blk.id || "";
      if (!REVIEW_TOOLS.has(name)) continue;
      if (!outputs.has(tid)) continue; // not completed
      if (key <= afterKey) continue; // not strictly after the last edit
      results.push(outputs.get(tid));
    }
  }
  return results;
}

// ---- isSubagentTranscript ---------------------------------------------------

/**
 * Return true ONLY when this Stop event authoritatively belongs to a Claude Code
 * subagent (so it must NOT be gated, to avoid serializing parallel pipelines).
 *
 * SECURITY (fail-closed). The previous implementation skipped the whole gate
 * whenever the UNTRUSTED host payload happened to carry a `g-`-prefixed
 * session_id, a transcript_path under `/subagents/`, or a basename starting with
 * `agent-`. Every one of those fields is attacker-influencable (the session_id
 * and the transcript_path are supplied in the Stop-hook stdin payload / derived
 * from repo-adjacent state), so a malicious repo could disable the gate by
 * naming its transcript `.../subagents/x` or `agent-x.jsonl`. That is fail-OPEN
 * of a security gate.
 *
 * The only AUTHORITATIVE subagent signal — set by Claude Code itself, not by
 * repo content — is the hook event name: a genuine subagent Stop arrives as
 * `hook_event_name === "SubagentStop"`. We therefore gate the skip on that
 * signal alone. The path/session-id heuristics are kept ONLY as a corroborating
 * factor: they may NARROW a SubagentStop, never WIDEN a plain Stop into a skip.
 * When the event is ambiguous (no explicit SubagentStop), we default to
 * REVIEWING (return false) so the gate stays armed.
 *
 * Note: adversarial-review registers ONLY the SessionStart and Stop hooks (never
 * SubagentStop), so under normal operation this returns false and the main-agent
 * Stop is always gated. The SubagentStop branch exists for the Claude Code
 * frontmatter quirk where a Stop hook declared inside a subagent fires with
 * `hook_event_name === "SubagentStop"`.
 *
 * Works on Windows paths (backslashes are normalised first).
 *
 * @param {string} transcriptPath
 * @param {string} [sessionId=""]
 * @param {string} [hookEventName=""] - AUTHORITATIVE Claude Code event name
 *   ("Stop" | "SubagentStop"). Only "SubagentStop" can skip the gate.
 * @returns {boolean}
 */
export function isSubagentTranscript(transcriptPath, sessionId = "", hookEventName = "") {
  // Authoritative, host-set signal is REQUIRED to skip the gate. Anything else
  // (a plain "Stop", an empty/unknown event) keeps the gate armed (fail-closed).
  if (String(hookEventName) !== "SubagentStop") return false;

  // We have a genuine SubagentStop. The untrusted path/session-id heuristics may
  // still be consulted as a sanity corroboration, but since the event itself is
  // authoritative we honour the subagent skip regardless of their value.
  return true;
}

// ---- lastUserText -----------------------------------------------------------

/**
 * Return the text of the most recent GENUINE human prompt from the transcript.
 *
 * Excludes:
 *  - assistant turns
 *  - isMeta / synthetic injections (skill notices, system reminders, hook feedback)
 *  - entries whose content consists entirely of tool_result blocks
 *
 * This is layer 1 of the self-disarm defense; HOOK_ECHO_RE is layer 2.
 *
 * Mirrors Python's last_user_text() in guard.py.
 *
 * @param {object[]} entries
 * @returns {string}
 */
export function lastUserText(entries) {
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i];
    if (e?.type !== "user" || e?.isMeta) continue;
    const msg = e?.message;
    if (!msg || typeof msg !== "object") continue;
    const content = msg.content;
    if (typeof content === "string") {
      if (content.trim()) return content;
      continue;
    }
    if (Array.isArray(content)) {
      // Skip entries that are purely tool_result blocks (no genuine user text).
      if (content.some((b) => b && typeof b === "object" && b.type === "tool_result")) {
        continue;
      }
      const texts = content
        .filter((b) => b && typeof b === "object" && b.type === "text")
        .map((b) => b.text || "");
      const joined = texts.filter(Boolean).join(" ").trim();
      if (joined) return joined;
    }
  }
  return "";
}

// ---- wantsSkip --------------------------------------------------------------

/**
 * Return true only if the text is a GENUINE request to skip the review.
 *
 * A skip phrase preceded (within NEG_WINDOW_WORDS words) by a negation cue
 * does NOT count. A trailing-noun that extends the object phrase does NOT count.
 * The gate's own echoed block reason does NOT count (HOOK_ECHO_RE defense).
 *
 * Errs toward review when ambiguous: a false-negative costs only an extra review,
 * whereas a wrong match would silently disarm a safety gate.
 *
 * Mirrors Python's wants_skip() in guard.py.
 *
 * @param {string} text
 * @returns {boolean}
 */
export function wantsSkip(text) {
  if (!text || HOOK_ECHO_RE.test(text)) return false; // layer-2 self-disarm defense

  // Normalize BOTH curly apostrophes (U+2018 left, U+2019 right) to a straight
  // apostrophe. Mirrors Python: text.replace("‘","’").replace("’","’").
  // The original regex had all three chars as U+2019 (a no-op); this is the fix.
  const norm = text.replace(/[‘’]/g, "'");

  // Create a fresh regex instance so that lastIndex starts at 0 and we can
  // iterate over all matches. (SKIP_RE has the `g` flag, so exec() advances
  // lastIndex; using a fresh instance avoids cross-call state leakage.)
  const re = new RegExp(SKIP_RE.source, SKIP_RE.flags);
  let match;
  while ((match = re.exec(norm)) !== null) {
    // Check for trailing negation ("? no", "? never", etc.)
    if (TRAILING_NO_RE.test(norm.slice(match.index + match[0].length))) continue;

    // Extract the window of words before the match for negation detection.
    // Strip STRAIGHT apostrophe (U+0027) so contractions collapse:
    // "don’t" → "dont", which NEG_RE matches. The curly apostrophes were
    // already normalized to straight on line 276, so this single replace
    // covers all variants. Mirrors Python: pre.replace("’", "").
    const pre = norm.slice(0, match.index).replace(/'/g, "");
    const words = [...pre.toLowerCase().matchAll(WORD_RE)].map((m) => m[0]);
    const window = words.slice(-NEG_WINDOW_WORDS).join(" ");
    if (!NEG_RE.test(window)) return true;
  }
  return false;
}

// ---- agentWantsSkip ---------------------------------------------------------

// The explicit, deliberate marker a coding agent emits in its OWN reply to
// decline adversarial review for a trivial change (the advisory gate's
// agent-discretion escape). A bracketed token — never a bare word — so it can
// not be matched by accident, and the gate's advisory reason instructs the agent
// to write it. Only an ASSISTANT turn counts: the gate's own reason (which
// CONTAINS this token as an instruction) arrives as hook feedback on a non-
// assistant turn, so the gate can never read its own echo as an agent skip.
//
// LINE-ANCHORED (multiline): the marker must START a line (the gate tells the
// agent to "end your reply with a line [adversarial-review:skip] <reason>"). This
// avoids a false skip when the agent merely MENTIONS the marker inline while
// explaining its reasoning (e.g. "I could write [adversarial-review:skip] but
// I'll review instead").
const SKIP_MARKER_RE = /^\s*\[adversarial-review:skip\]/im;

/**
 * Return true when the coding AGENT itself declared a skip — by emitting
 * SKIP_MARKER_RE in an assistant turn strictly AFTER `afterKey` (typically
 * lastEditKey). This is the advisory gate's agent-discretion escape: the agent
 * may decline review for a change it judges trivial. The `afterKey` freshness
 * bound means a skip declared BEFORE the most recent edit does not carry over —
 * editing again after a skip re-opens the review suggestion.
 *
 * Unlike `wantsSkip` (which reads the USER's prompt), this reads only ASSISTANT
 * turns, so it is immune to the gate echoing the skip instruction back as hook
 * feedback. When `afterKey` is 0 (no transcript edit evidence) any assistant
 * marker counts, which is correct: an explicit agent skip is honored.
 *
 * @param {object[]} entries
 * @param {number} [afterKey=0]
 * @returns {boolean}
 */
export function agentWantsSkip(entries, afterKey = 0) {
  for (const e of entries) {
    if (e?.type !== "assistant") continue;
    const key = tsKey(e?.timestamp);
    if (key <= afterKey) continue;
    const msg = e?.message;
    if (!msg || typeof msg !== "object") continue;
    const content = msg.content;
    let text = "";
    if (typeof content === "string") {
      text = content;
    } else if (Array.isArray(content)) {
      text = content
        .filter((b) => b && typeof b === "object" && b.type === "text")
        .map((b) => b.text || "")
        .join("\n");
    }
    if (text && SKIP_MARKER_RE.test(text)) return true;
  }
  return false;
}
