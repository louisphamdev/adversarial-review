// Claude Code native host integration module.
//
// Returns the planned writes needed to enable the Claude Code SessionStart and
// Stop hooks. Exposes a planning function rather than writing files directly so
// the `install` command can operate in dry-run mode without touching the disk.
//
// Hook target: bin/adversarial-review.js hook --host claude-code --event <event>
//
// Claude Code hooks.json location (per-project): <cwd>/.claude/settings.json
// (hooks are embedded in the settings file as a "hooks" key). The installer
// must NOT clobber an existing settings.json (which may carry permissions, env,
// statusLine, mcpServers, other hooks). We therefore DEEP-MERGE our two hook
// entries into the existing object, preserving every other top-level key.

import path from "node:path";

// Marker substring every adversarial-review hook command carries. Used to
// detect (and strip / dedupe) our own entries idempotently.
const AR_HOOK_MARKER = "adversarial-review";

// Substring identifying a prior Python-era plugin hook command. When migrating
// a project we STRIP these so the project does not run both the old guard.py
// and our new native hook.
const LEGACY_GUARD_MARKER = "guard.py";

// Canonical invocation tail that EVERY adversarial-review hook command ends
// with: `... hook --host claude-code --event <event>`. Hook ownership is a
// SECURITY decision (doctor's health verdict + uninstall's "remove only our
// hooks" guarantee), so it MUST be matched on the exact canonical token
// sequence — never a loose substring. A loose `cmd.includes("--event stop")`
// is spoofable (e.g. `true # adversarial-review --event stop` neuters the gate
// while still matching) AND collides with distinct user hooks (`--event stop`
// is a substring of `--event stop-done`).
//
// We accept the leaf as OURS only when, after collapsing internal whitespace,
// the command ENDS WITH the exact canonical tail for the event AND the bin
// portion preceding it carries the package marker as a real path token (not as
// a comment). This anchors on structure we write, so a re-install dedupes its
// own prior entry while a neutered/decorated command (leading `true #`, `;`,
// `&&`, `|`, backticks before the invocation) fails the match.

/** Collapse runs of whitespace to single spaces and trim ends. */
function normalizeCommand(cmd) {
  return String(cmd).replace(/\s+/g, " ").trim();
}

/** Escape a string for safe interpolation into a RegExp source. */
function escapeRegExp(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Shell metacharacters that would let an attacker wrap/neuter our invocation
// while keeping the canonical tail intact (e.g. `true # <bin> ... --event stop`
// or `<bin> ... --event stop; rm -rf /`). Any of these in the UNQUOTED part of a
// leaf command disqualifies it from being treated as OURS. (Metachars that occur
// only INSIDE the double-quoted bin token — e.g. `C:\Program Files (x86)\...` —
// are inert to the shell and are explicitly allowed; see isOurBinPrefix.)
const SHELL_META_RE = /[#;&|`$(){}<>]|&&|\|\|/;

// Command-substitution metacharacters. Unlike the other shell metachars, `$` and
// backtick are NOT neutralized by DOUBLE quotes: in POSIX shells `$VAR`, `$(...)`
// and `` `...` `` STILL EXPAND inside double quotes. The bin path/command is
// computed at INSTALL time from a path on disk and is never meant to carry shell
// command substitution, so a `$`/backtick in it is either a broken install input
// or an attacker trying to smuggle code into the hook command (which the host
// later runs through a POSIX shell — the substitution could even change the
// executable path so no block JSON is emitted: a fail-OPEN bypass). We therefore
// REJECT it (fail CLOSED) rather than attempt a cross-platform-safe quoting that
// would also have to survive cmd.exe. (Single-quoting on POSIX would help, but the
// emitted command string is platform-agnostic and runs under cmd.exe on Windows
// too, where single quotes are literal — so a hard REJECT is the clean choice.)
const COMMAND_SUBST_RE = /[$`]/;

// Characters that force a token to be DOUBLE-QUOTED when emitted (a superset of
// SHELL_META_RE plus whitespace). Beyond the shell metacharacters, a BARE token
// carrying a single quote (') or a glob char (* ? [ ]) reaches the host's POSIX
// shell unquoted and breaks the gate OPEN: the ' opens an unterminated quoted
// string (the Stop-hook command fails to parse → no {"decision":"block"} is emitted
// → the change is ALLOWED), and an unquoted glob expands to a different / missing
// executable (same fail-open). All of these are INERT inside double quotes on POSIX
// (and literal under cmd.exe), so quoting closes the hole. $ and backtick are NOT
// relied on here — they EXPAND inside double quotes and are rejected outright by
// assertNoCommandSubstitution before any quoting. (audit ROUND7 / GPT-5.5)
const QUOTE_TRIGGER_RE = /[\s#;&|`$(){}<>'*?[\]]/;

/**
 * Reject a bin invocation that contains POSIX command-substitution metacharacters
 * (`$` or backtick). These expand even inside double quotes, so there is no safe
 * cross-platform way to embed them in the platform-agnostic hook command string;
 * we fail CLOSED with a clear error rather than emit a command that could execute
 * attacker-controlled shell code (or fail open) when the host runs it.
 *
 * @param {string} bin
 * @throws {Error} when `bin` contains `$` or a backtick
 */
function assertNoCommandSubstitution(bin) {
  if (COMMAND_SUBST_RE.test(bin)) {
    throw new Error(
      `adversarial-review: refusing to build a hook command from a bin path ` +
        `containing a '$' or backtick (POSIX command-substitution metacharacter, ` +
        `which is NOT neutralized by double quotes): ${bin}`
    );
  }
}

/**
 * Whether a bin string is a COMPOSITE invocation (a launcher token followed by
 * one or more argument tokens, e.g. `npx adversarial-review-gate` or
 * `node "C:\Program Files\...\ar.js"`) versus a SINGLE executable path that may
 * merely contain spaces (e.g. `C:\Users\John Doe\...\ar.js`).
 *
 * The discriminator is the FIRST whitespace-delimited token: a composite
 * invocation begins with a bare LAUNCHER WORD — a PATH-resolved command name
 * (`npx`, `node`, ...) that carries NO path separator and NO drive-letter prefix.
 * A single spaced path instead begins with a path fragment (`C:\Users\John`,
 * `/opt/my dir/...`) whose first token already contains a separator/drive, so
 * the whole string must be treated as ONE path token (and quoted as a unit).
 *
 * This is the line the round-2 single-path test encodes (`C:\Users\John Doe\..`
 * → one quoted token) while letting the real installer inputs
 * (`npx adversarial-review-gate`) be recognized as a launcher + arg so the
 * launcher is NOT swallowed into a single bogus `"npx adversarial-review-gate"`
 * token that the shell would look up as a literal (space-containing) executable
 * name → fail-open (FINDING: multi-token binPath quoting).
 *
 * @param {string} bin
 * @returns {boolean}
 */
function looksLikeComposite(bin) {
  // Find the first whitespace run; if none, it is a single token.
  const m = /\s/.exec(bin);
  if (!m) return false;
  const firstToken = bin.slice(0, m.index);
  // A launcher word: no path separator, no drive-letter prefix, no metachars.
  // (A leading absolute interpreter path like `C:\Program Files\nodejs\node.exe`
  // is itself a spaced path and is handled by the single-path branch.)
  if (/[\\/]/.test(firstToken)) return false; // has a path separator
  if (/^[A-Za-z]:/.test(firstToken)) return false; // drive-letter prefix
  if (SHELL_META_RE.test(firstToken)) return false;
  return firstToken.length > 0;
}

/**
 * Split a composite bin invocation into argv tokens, honoring any double-quoted
 * spans the caller already supplied (so a pre-quoted path arg
 * `node "C:\Program Files\ar.js"` yields exactly `["node", "C:\\Program
 * Files\\ar.js"]` rather than splitting the path at its space). Backslash-escaped
 * quotes inside a quoted span are preserved as a literal `"`.
 *
 * @param {string} bin
 * @returns {string[]}
 */
function tokenizeBin(bin) {
  const tokens = [];
  let cur = "";
  let inQuote = false;
  let started = false; // whether `cur` holds an in-progress token
  for (let i = 0; i < bin.length; i++) {
    const ch = bin[i];
    if (inQuote) {
      if (ch === "\\" && bin[i + 1] === '"') {
        cur += '"';
        i++;
      } else if (ch === '"') {
        inQuote = false;
      } else {
        cur += ch;
      }
    } else if (ch === '"') {
      inQuote = true;
      started = true;
    } else if (/\s/.test(ch)) {
      if (started) {
        tokens.push(cur);
        cur = "";
        started = false;
      }
    } else {
      cur += ch;
      started = true;
    }
  }
  if (started) tokens.push(cur);
  return tokens;
}

/** Quote a SINGLE token if it contains whitespace, a shell metachar, or a quote/glob. */
function quoteToken(token) {
  if (!QUOTE_TRIGGER_RE.test(token)) return token;
  return `"${token.replace(/"/g, '\\"')}"`;
}

/**
 * Shell-quote a bin invocation for embedding in a `type: command` hook string.
 *
 * FINDING 1 (fail-open): an unquoted bin path containing a space (extremely
 * common on Windows, e.g. `C:\Users\John Doe\...`) is split by the shell at the
 * space — the first fragment is run as the executable, fails, no block JSON is
 * emitted, and Claude Code ALLOWS the change: a silent gate bypass.
 *
 * MULTI-TOKEN FINDING (fail-open): wrapping the ENTIRE bin in one pair of quotes
 * is correct ONLY when the bin is a single executable path. For a COMPOSITE
 * invocation (`npx adversarial-review-gate` — the installer's DEFAULT fallback —
 * or `node "C:\Program Files\...\ar.js"`), wrapping the whole string makes the
 * shell look up a literal executable named `npx adversarial-review-gate` (with
 * the embedded space), which does not exist → the hook errors → no block JSON →
 * the Stop gate ALLOWS the change (silent bypass). We therefore TOKENIZE a
 * composite invocation and quote each token independently (quoting only the
 * tokens that actually need it — typically just the path argument), leaving the
 * bare launcher word unquoted. A single executable path (one token, or a spaced
 * path whose first token is already path-like) is still wrapped as a unit.
 *
 * The output is always one of the shapes isOurBinPrefix() recognizes (a single
 * quoted token, a metachar-free bare invocation, or a composite of bare/quoted
 * tokens), so a command this produces round-trips through ownership detection and
 * re-install stays idempotent (FINDING 2) even when the bin path carries
 * `(`/`)`/space.
 *
 * @param {string} bin
 * @returns {string}
 */
function quoteBin(bin) {
  // Reject command-substitution metacharacters ($ / backtick) FIRST: they expand
  // even inside double quotes on POSIX, so no quoting can make them safe in the
  // platform-agnostic hook command — fail closed at the source. (round 6)
  assertNoCommandSubstitution(bin);
  // Already needs no quoting: no whitespace, shell metachar, or quote/glob char.
  if (!QUOTE_TRIGGER_RE.test(bin)) return bin;
  // Composite invocation (launcher + args): quote each token independently so the
  // launcher word is not swallowed into a single bogus quoted executable name.
  if (looksLikeComposite(bin)) {
    return tokenizeBin(bin).map(quoteToken).join(" ");
  }
  // Single executable path that contains a space / metachar: wrap as one token.
  return `"${bin.replace(/"/g, '\\"')}"`;
}

/**
 * Build the canonical hook command string for an event:
 * `<bin> hook --host claude-code --event <event>` with `<bin>` shell-quoted via
 * quoteBin(). Single source of truth so buildHookConfig() and isOurHookLeaf()
 * cannot drift (the command we WRITE must always be one we RECOGNIZE).
 *
 * @param {string} bin   - resolved gate invocation
 * @param {string} event - "session-start" | "stop"
 * @returns {string}
 */
function buildHookCommand(bin, event) {
  return `${quoteBin(bin)} hook --host claude-code --event ${event}`;
}

// A fully double-quoted bin token: an opening quote, a run of non-quote chars or
// backslash-escaped quotes, and a closing quote — nothing else. This is exactly
// the shape quoteBin() emits, so metachars that appear ONLY inside it (a literal
// `(x86)` in a path) are inert to the shell yet still recognized as ours.
const QUOTED_BIN_RE = /^"(?:[^"\\]|\\.)*"$/;

/**
 * Whether the portion of a command preceding the canonical tail is one of OUR
 * bin invocations — and NOT an attacker wrapper. Accepted shapes:
 *   (a) a single fully double-quoted token (`"C:\Program Files (x86)\...\ar.js"`),
 *       which neutralizes any interior metachar, OR
 *   (b) a bare, metachar-FREE invocation (`adversarial-review-gate`,
 *       `npx adversarial-review-gate`), OR
 *   (c) a COMPOSITE of bare metachar-free words and fully double-quoted tokens
 *       (`node "C:\Program Files\...\ar.js"`), which is exactly what quoteBin()
 *       emits for a launcher + spaced-path argument.
 * In every shape the prefix MUST carry the package marker (in a bare word or
 * inside a quoted token). A wrapper such as `true # adversarial-review` or
 * `"foo"; bar` fails all shapes (the `;`/`#` is an UNQUOTED metachar, so the
 * out-of-quote remainder is not metachar-free), so the gate cannot be neutered
 * while still matching.
 *
 * @param {string} prefix - normalized command text before ` <tail>` (trimmed)
 * @returns {boolean}
 */
function isOurBinPrefix(prefix) {
  if (!prefix) return false; // `cmd === tail` (no bin) is not one of ours
  if (QUOTED_BIN_RE.test(prefix)) {
    // Quoted token: the marker must appear inside the quotes (interior metachars
    // are inert). Strip the surrounding quotes and unescape for the marker check.
    const inner = prefix.slice(1, -1).replace(/\\"/g, '"');
    return inner.includes(AR_HOOK_MARKER);
  }
  // Composite/bare shape: split into tokens honoring quotes, then require EVERY
  // token to be either a PURE double-quoted span (metachars inert) or a bare
  // metachar-free word, with the marker present in at least one token.
  // Concatenating tokens and re-scanning (the old single-string check) is unsafe:
  // an injected `"foo"; bar` has its `;` OUTSIDE the quote. Tokenization with a
  // per-token "pure-quoted vs. bare" flag catches it — `"foo";` is a MIXED token
  // (quoted span + bare `;`), so it is scrutinized as bare and the `;` rejects.
  const tokens = tokenizeBinForOwnership(prefix);
  if (!tokens) return false; // unbalanced quotes / unparseable → not ours
  let sawMarker = false;
  for (const t of tokens) {
    if (t.pureQuoted) {
      // Entire token is a single quoted span: interior metachars are inert.
      if (t.value.includes(AR_HOOK_MARKER)) sawMarker = true;
    } else {
      // A bare token (or a token that MIXES bare chars with a quoted span) must
      // be free of shell metacharacters to be inert to the shell. t.value holds
      // the post-unquote content, so an injected `;`/`#`/etc. is caught here.
      if (SHELL_META_RE.test(t.value)) return false;
      if (t.value.includes(AR_HOOK_MARKER)) sawMarker = true;
    }
  }
  return sawMarker;
}

/**
 * Tokenize a normalized bin prefix into `{ value, pureQuoted }` tokens, honoring
 * double-quoted spans. `value` is the post-unquote content. `pureQuoted` is true
 * ONLY when the ENTIRE token is a single quoted span with NO bare characters
 * around or between quoted spans — i.e. a token whose metachars are genuinely
 * inert to the shell. A token that mixes a quoted span with bare characters
 * (`"x";rm` → value `x;rm`) is NOT pureQuoted, so the caller scrutinizes it as
 * bare and the injected `;` is rejected. Returns null on an unbalanced quote (an
 * attacker who opens a quote that never closes must NOT be accepted). Single-
 * space separated input is assumed (the caller normalizes whitespace first).
 *
 * @param {string} prefix
 * @returns {Array<{value:string, pureQuoted:boolean}>|null}
 */
function tokenizeBinForOwnership(prefix) {
  const tokens = [];
  let cur = "";
  let started = false;
  let hadQuoted = false; // token contained at least one quoted span
  let hadBare = false; // token contained at least one bare (non-quoted) char
  let i = 0;
  const flush = () => {
    tokens.push({ value: cur, pureQuoted: hadQuoted && !hadBare });
    cur = "";
    started = false;
    hadQuoted = false;
    hadBare = false;
  };
  while (i < prefix.length) {
    const ch = prefix[i];
    if (ch === '"') {
      // Consume a quoted span (allowing \" escapes) into the current token.
      hadQuoted = true;
      started = true;
      i++;
      let closed = false;
      while (i < prefix.length) {
        const c = prefix[i];
        if (c === "\\" && prefix[i + 1] === '"') {
          cur += '"';
          i += 2;
        } else if (c === '"') {
          closed = true;
          i++;
          break;
        } else {
          cur += c;
          i++;
        }
      }
      if (!closed) return null; // unbalanced quote → reject
    } else if (/\s/.test(ch)) {
      if (started) flush();
      i++;
    } else {
      cur += ch;
      started = true;
      hadBare = true;
      i++;
    }
  }
  if (started) flush();
  return tokens;
}

/**
 * Whether a single hook leaf object is one of OUR adversarial-review hooks for
 * the given event ("session-start" | "stop").
 *
 * STRICT canonical match (security-critical — used by doctor's registration
 * verdict, install dedupe, AND uninstall removal). A leaf is ours only when its
 * whitespace-normalized command:
 *   1. ENDS WITH the exact canonical tail `hook --host claude-code --event <event>`
 *      as a whole-token suffix, and
 *   2. the bin prefix before that tail passes isOurBinPrefix (a single quoted
 *      token OR a metachar-free invocation, carrying the package marker).
 *
 * This rejects a spoofed `true # adversarial-review --event stop`, refuses to
 * treat `--event stop` as covering `--event stop-done`, still matches every
 * command buildHookCommand() emits (so re-install stays idempotent even when the
 * bin path contains spaces or `(x86)`-style metachars — FINDINGS 1 & 2).
 *
 * @param {object} leaf  - { type, command, ... }
 * @param {string} event - "session-start" | "stop"
 * @returns {boolean}
 */
function isOurHookLeaf(leaf, event) {
  if (!leaf || typeof leaf.command !== "string") return false;
  // Claude Code only EXECUTES `type:"command"` hooks. A leaf that carries our exact
  // canonical command string under a non-command type (e.g. `type:"prompt"`) does NOT
  // actually run the gate, so it must NOT be counted as registered — otherwise doctor
  // (and the plugin-gate detector that reuses this matcher) would report a FALSE
  // "enforced" on a gate that never fires. (audit ROUND7 / GPT-5.5-xhigh, doctor-plugin)
  if (leaf.type !== "command") return false;
  const cmd = normalizeCommand(leaf.command);
  const tail = `hook --host claude-code --event ${event}`;
  if (cmd !== tail && !cmd.endsWith(` ${tail}`)) return false;
  // The portion before the canonical tail is the bin invocation and MUST be one
  // of our recognized shapes (quoted token or metachar-free), marker-bearing.
  const prefix = cmd.slice(0, cmd.length - tail.length).trim();
  return isOurBinPrefix(prefix);
}

/**
 * Build the hook configuration object for Claude Code.
 *
 * Mirrors src/integrations/claude-code/hooks.json: the Stop hook gets a 300s
 * timeout (a real review easily exceeds Claude Code's ~60s default and would be
 * killed mid-flight), the SessionStart baseline hook gets 60s, and both carry a
 * statusMessage so the user sees what is running.
 *
 * @param {string} binPath  - command used to invoke the gate
 * @returns {object}  hook config JSON object ({ hooks: { SessionStart, Stop } })
 */
function buildHookConfig(binPath) {
  const bin = binPath || "npx adversarial-review-gate";
  return {
    hooks: {
      SessionStart: [
        {
          hooks: [
            {
              type: "command",
              command: buildHookCommand(bin, "session-start"),
              statusMessage: "Adversarial review baseline",
              timeout: 60,
            },
          ],
        },
      ],
      Stop: [
        {
          hooks: [
            {
              type: "command",
              command: buildHookCommand(bin, "stop"),
              statusMessage: "Adversarial review gate",
              timeout: 300,
            },
          ],
        },
      ],
    },
  };
}

// The legacy Python plugin invoked a script whose FILENAME is exactly `guard.py`
// (e.g. `python ${CLAUDE_PLUGIN_ROOT}/hooks/guard.py` or `python guard.py
// --event stop`). We match that basename at a path/word boundary so an unrelated
// user script with a DIFFERENT filename that merely ends in the same substring
// (`my-guard.py`, `safeguard.py`) is NOT mistaken for ours. The boundary before
// the basename is start-of-string, whitespace, or a path separator (`/` or `\`);
// the boundary after `.py` is end-of-string, whitespace, or any non-name char.
const LEGACY_GUARD_RE = new RegExp(
  `(?:^|[\\s/\\\\])${LEGACY_GUARD_MARKER.replace(/[.]/g, "\\$&")}(?![\\w.])`
);

/**
 * Whether a hook leaf is a legacy Python-era adversarial-review guard.py command
 * (to be stripped on migration).
 *
 * FINDING 3: a bare `command.includes("guard.py")` is over-broad — it strips ANY
 * user hook whose command merely contains the substring `guard.py` (an unrelated
 * `my-guard.py` lint script, `safeguard.py`, a comment), silently deleting user
 * configuration. We instead match `guard.py` as a whole PATH BASENAME (bounded by
 * a path separator / whitespace / start, and by a non-name char / end), which is
 * exactly how the legacy plugin's script was invoked while still excluding the
 * `*-guard.py` family of unrelated user scripts.
 *
 * @param {object} leaf
 * @returns {boolean}
 */
function isLegacyGuardLeaf(leaf) {
  if (!leaf || typeof leaf.command !== "string") return false;
  return LEGACY_GUARD_RE.test(leaf.command);
}

/**
 * Filter a Claude Code hook-group array for one event, removing any leaf that is
 * either (a) a prior adversarial-review entry for this event (so re-install is
 * idempotent — no duplicates) or (b) a legacy guard.py entry (so a migrated
 * project never runs both). Empty groups are dropped.
 *
 * @param {Array} groups - existing hook groups for a single event
 * @param {string} event - "session-start" | "stop"
 * @returns {Array}      - cleaned groups (new array; never mutates input)
 */
function stripOurAndLegacy(groups, event) {
  if (!Array.isArray(groups)) return [];
  const cleaned = [];
  for (const group of groups) {
    if (!group || typeof group !== "object") continue;
    const leaves = Array.isArray(group.hooks) ? group.hooks : [];
    const keptLeaves = leaves.filter(
      (leaf) => !isOurHookLeaf(leaf, event) && !isLegacyGuardLeaf(leaf)
    );
    // Drop a group that became empty after stripping; otherwise keep it with the
    // surviving leaves (preserving any matcher/other keys on the group object).
    if (keptLeaves.length > 0) {
      cleaned.push({ ...group, hooks: keptLeaves });
    } else if (!leaves.length && Object.keys(group).length) {
      // A group with no hooks array but other keys — preserve as-is.
      cleaned.push(group);
    }
  }
  return cleaned;
}

/**
 * Deep-merge our Claude Code hooks into an existing settings.json object.
 *
 * Preserves EVERY existing top-level key (permissions, env, statusLine,
 * mcpServers, unrelated hooks, ...). Within hooks.SessionStart / hooks.Stop it
 * APPENDS our hook group only after stripping any prior adversarial-review entry
 * for the same event (idempotent) and any legacy guard.py entry (migration).
 *
 * Never mutates the input object.
 *
 * @param {object} existing  - parsed existing settings.json (or {})
 * @param {string} binPath   - command used to invoke the gate
 * @returns {object}         - merged settings object to write
 */
export function mergeClaudeCodeSettings(existing, binPath) {
  const base =
    existing && typeof existing === "object" && !Array.isArray(existing) ? existing : {};
  const ourConfig = buildHookConfig(binPath);

  // Shallow-clone the top level so unrelated keys are preserved untouched.
  const merged = { ...base };

  const existingHooks =
    base.hooks && typeof base.hooks === "object" && !Array.isArray(base.hooks)
      ? base.hooks
      : {};
  const mergedHooks = { ...existingHooks };

  for (const event of ["SessionStart", "Stop"]) {
    const eventKey = event === "SessionStart" ? "session-start" : "stop";
    const cleaned = stripOurAndLegacy(existingHooks[event], eventKey);
    // Append our freshly-built group for this event.
    mergedHooks[event] = [...cleaned, ...ourConfig.hooks[event]];
  }

  merged.hooks = mergedHooks;
  return merged;
}

/**
 * Remove ONLY our adversarial-review hook entries (both events) from an existing
 * settings object. Used by the `uninstall` command. Preserves every other
 * top-level key and any non-AR hooks. Idempotent (no-op when none present).
 *
 * @param {object} existing - parsed existing settings.json (or {})
 * @returns {object}        - settings object with our hooks removed
 */
export function removeClaudeCodeHooks(existing) {
  const base =
    existing && typeof existing === "object" && !Array.isArray(existing) ? existing : {};
  const merged = { ...base };

  const existingHooks =
    base.hooks && typeof base.hooks === "object" && !Array.isArray(base.hooks)
      ? base.hooks
      : null;
  if (!existingHooks) return merged;

  const mergedHooks = { ...existingHooks };
  for (const event of ["SessionStart", "Stop"]) {
    const eventKey = event === "SessionStart" ? "session-start" : "stop";
    // Strip our entries but DO NOT strip legacy guard.py here — uninstall removes
    // only what WE installed.
    const groups = Array.isArray(existingHooks[event]) ? existingHooks[event] : [];
    const cleaned = [];
    for (const group of groups) {
      if (!group || typeof group !== "object") continue;
      const leaves = Array.isArray(group.hooks) ? group.hooks : [];
      const keptLeaves = leaves.filter((leaf) => !isOurHookLeaf(leaf, eventKey));
      if (keptLeaves.length > 0) {
        cleaned.push({ ...group, hooks: keptLeaves });
      } else if (!leaves.length && Object.keys(group).length) {
        cleaned.push(group);
      }
    }
    if (cleaned.length > 0) {
      mergedHooks[event] = cleaned;
    } else {
      delete mergedHooks[event];
    }
  }

  if (Object.keys(mergedHooks).length > 0) {
    merged.hooks = mergedHooks;
  } else {
    delete merged.hooks;
  }
  return merged;
}

/**
 * Whether our SessionStart + Stop hooks are BOTH present in a settings object.
 * Used by `doctor` to report registration status.
 *
 * @param {object} existing - parsed settings.json (or {})
 * @returns {{ sessionStart: boolean, stop: boolean }}
 */
export function detectClaudeCodeHooks(existing) {
  const base =
    existing && typeof existing === "object" && !Array.isArray(existing) ? existing : {};
  const hooks =
    base.hooks && typeof base.hooks === "object" && !Array.isArray(base.hooks)
      ? base.hooks
      : {};

  const hasEvent = (event, key) => {
    const groups = Array.isArray(hooks[event]) ? hooks[event] : [];
    return groups.some(
      (group) =>
        group &&
        Array.isArray(group.hooks) &&
        group.hooks.some((leaf) => isOurHookLeaf(leaf, key))
    );
  };

  return {
    sessionStart: hasEvent("SessionStart", "session-start"),
    stop: hasEvent("Stop", "stop"),
  };
}

/**
 * Whether a leaf command LOOKS LIKE an adversarial-review hook for `event`
 * (carries the package marker + an `--event <event>` reference) but FAILS the
 * strict canonical match — i.e. it is present-but-tampered/neutered (e.g.
 * `true # adversarial-review hook ... --event stop`). Used by `doctor` to warn
 * rather than silently report the gate as healthy.
 *
 * @param {object} leaf
 * @param {string} event - "session-start" | "stop"
 * @returns {boolean}
 */
function isTamperedHookLeaf(leaf, event) {
  if (!leaf || typeof leaf.command !== "string") return false;
  const cmd = normalizeCommand(leaf.command);
  // FINDING 4: `cmd.includes("--event stop")` also matches a DISTINCT user event
  // like `--event stop-done` (stop ⊂ stop-done), so doctor spuriously flagged an
  // unrelated third-party hook as our tampered Stop hook. Match the event as a
  // whole token (word boundary after the event name) so `stop` never covers
  // `stop-done`/`stop-report`.
  const eventTokenRe = new RegExp(`--event\\s+${escapeRegExp(event)}(?![\\w-])`);
  const looksLikeOurs = cmd.includes(AR_HOOK_MARKER) && eventTokenRe.test(cmd);
  return looksLikeOurs && !isOurHookLeaf(leaf, event);
}

/**
 * Detect present-but-non-canonical (tampered/neutered) adversarial-review hooks
 * in a settings object. A configured Stop/SessionStart leaf that carries our
 * marker but does NOT match the exact canonical command is a SECURITY signal:
 * the gate may have been disarmed while still appearing installed.
 *
 * @param {object} existing - parsed settings.json (or {})
 * @returns {{ sessionStart: boolean, stop: boolean }}
 */
export function detectTamperedClaudeCodeHooks(existing) {
  const base =
    existing && typeof existing === "object" && !Array.isArray(existing) ? existing : {};
  const hooks =
    base.hooks && typeof base.hooks === "object" && !Array.isArray(base.hooks)
      ? base.hooks
      : {};

  const hasTampered = (event, key) => {
    const groups = Array.isArray(hooks[event]) ? hooks[event] : [];
    return groups.some(
      (group) =>
        group &&
        Array.isArray(group.hooks) &&
        group.hooks.some((leaf) => isTamperedHookLeaf(leaf, key))
    );
  };

  return {
    sessionStart: hasTampered("SessionStart", "session-start"),
    stop: hasTampered("Stop", "stop"),
  };
}

/**
 * Resolve the Claude Code settings.json path for a given base directory.
 *
 * @param {string} baseDir - project root (project scope) or home (user scope)
 * @returns {string}
 */
export function claudeCodeSettingsPath(baseDir) {
  return path.join(baseDir, ".claude", "settings.json");
}

/**
 * Return the list of planned writes to enable the Claude Code native hooks.
 *
 * This DEEP-MERGES our two hook entries into the existing settings.json object
 * (passed in by the caller, which owns IO) so unrelated keys are preserved and
 * re-install is idempotent. The function never writes anything — it is pure so
 * callers (including dry-run) can inspect planned writes first.
 *
 * @param {object} options
 * @param {string} options.baseDir          - base dir whose .claude/ we target
 *                                             (cwd for project, home for user)
 * @param {string} [options.binPath]         - resolved gate command
 * @param {object} [options.existingSettings] - parsed existing settings.json ({})
 * @returns {Array<{path: string, content: string, note: string}>}
 */
export function plannedClaudeCodeWrites({ baseDir, binPath, existingSettings = {} }) {
  const merged = mergeClaudeCodeSettings(existingSettings, binPath);
  const settingsPath = claudeCodeSettingsPath(baseDir);

  return [
    {
      path: settingsPath,
      content: JSON.stringify(merged, null, 2),
      note: "Claude Code native hooks (SessionStart + Stop) — merged into settings.json",
    },
  ];
}
