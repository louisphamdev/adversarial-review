// Transcript parser and skip detection.
// Ports the Python functions from hooks/guard.py:
//   - ts_key         -> tsKey
//   - iter_tool_uses -> iterToolUses (inline)
//   - completed_tool_ids -> completedToolIds (inline in collectReviewOutputs)
//   - scan_keys      -> scanKeys (edit evidence only)
//   - is_subagent    -> isSubagentTranscript
//   - last_user_text -> lastUserText
//   - wants_skip     -> wantsSkip

const EDIT_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);
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
export function scanKeys(entries) {
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

      if (EDIT_TOOLS.has(name)) {
        if (key > lastEditKey) lastEditKey = key;
        if (inp && typeof inp === "object") {
          for (const k of ["file_path", "notebook_path"]) {
            const p = inp[k];
            if (typeof p === "string" && p) editedPaths.add(p);
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
 * Return true when the transcript belongs to a workflow-spawned subagent that
 * should NOT be gated (to avoid serializing parallel pipelines).
 *
 * Mirrors the Python check in guard.py main():
 *   session_id.startswith("g-")  OR
 *   "/subagents/" in tp          OR
 *   basename(tp).startswith("agent-")
 *
 * Works on Windows paths (backslashes are normalised first).
 *
 * @param {string} transcriptPath
 * @param {string} [sessionId=""]
 * @returns {boolean}
 */
export function isSubagentTranscript(transcriptPath, sessionId = "") {
  const normalized = String(transcriptPath || "").replace(/\\/g, "/");
  const base = normalized.split("/").at(-1) || "";
  return (
    String(sessionId).startsWith("g-") ||
    normalized.includes("/subagents/") ||
    base.startsWith("agent-")
  );
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
