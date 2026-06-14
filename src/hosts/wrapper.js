// Wrapper host integration module.
//
// Wrapper-enforced hosts cannot install native hooks; enforcement depends on
// the user invoking the tool via an `adversarial-review run` wrapper command.
// This module returns printable instructions (no file writes) that the
// installer presents to the user.

// Shell metacharacters whose presence in an UNQUOTED token would let the shell
// re-interpret the printed wrapper command. A token carrying any of these (or
// whitespace) is double-quoted so the printed command is copy-pasteable and the
// path/arg does not shell-split. Mirrors SHELL_META_RE in src/hosts/claude-code.js.
const SHELL_META_RE = /[#;&|`$(){}<>]|&&|\|\|/;

// Command-substitution metacharacters ($ / backtick): unlike other metachars
// these STILL EXPAND inside double quotes on POSIX, so the printed wrapper
// command would execute attacker code (or fail to launch) when the user pastes
// it into a shell. A bin path is never meant to carry them. Reject (fail closed)
// rather than emit an injectable command. Mirrors claude-code.js.
const COMMAND_SUBST_RE = /[$`]/;

// Characters that force a token to be DOUBLE-QUOTED when emitted (a superset of
// SHELL_META_RE plus whitespace). A BARE token carrying a single quote (') or a glob
// char (* ? [ ]) reaches a POSIX shell unquoted and breaks the printed wrapper
// command: the ' opens an unterminated quoted string (the command fails to parse), an
// unquoted glob expands to a different / missing executable — either way the user's
// pasted wrapper does not launch and the review gate is skipped. All are INERT inside
// double quotes on POSIX (and literal under cmd.exe). $ and backtick are rejected
// outright by assertNoCommandSubstitution. Mirrors claude-code.js. (audit ROUND7)
const QUOTE_TRIGGER_RE = /[\s#;&|`$(){}<>'*?[\]]/;

/** Throw when `bin` contains a `$` or backtick (POSIX command substitution). */
function assertNoCommandSubstitution(bin) {
  if (COMMAND_SUBST_RE.test(bin)) {
    throw new Error(
      `adversarial-review: refusing to build a wrapper command from a bin path ` +
        `containing a '$' or backtick (POSIX command-substitution metacharacter): ${bin}`
    );
  }
}

/**
 * Whether a bin string is a COMPOSITE invocation (a bare launcher word followed
 * by argument tokens, e.g. `npx adversarial-review-gate` or
 * `node "C:\Program Files\...\ar.js"`) vs. a SINGLE executable path that merely
 * contains spaces (e.g. `C:\Users\John Doe\...\ar.js`).
 *
 * The first whitespace-delimited token decides: a composite begins with a bare
 * launcher word (no path separator, no drive-letter prefix, no metachar); a
 * single spaced path begins with a path fragment (`C:\Users\John`).
 *
 * @param {string} bin
 * @returns {boolean}
 */
function looksLikeComposite(bin) {
  const m = /\s/.exec(bin);
  if (!m) return false;
  const firstToken = bin.slice(0, m.index);
  if (/[\\/]/.test(firstToken)) return false; // path separator
  if (/^[A-Za-z]:/.test(firstToken)) return false; // drive-letter prefix
  if (SHELL_META_RE.test(firstToken)) return false;
  return firstToken.length > 0;
}

/** Split a composite invocation into tokens, honoring pre-quoted spans. */
function tokenizeBin(bin) {
  const tokens = [];
  let cur = "";
  let inQuote = false;
  let started = false;
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

/** Double-quote a single token if it has whitespace, a shell metachar, or a quote/glob. */
function quoteToken(token) {
  if (!QUOTE_TRIGGER_RE.test(token)) return token;
  return `"${token.replace(/"/g, '\\"')}"`;
}

/**
 * Shell-quote a bin invocation for a printable wrapper command.
 *
 * FINDING (fail-open / broken launch command): wrapping the ENTIRE binPath in one
 * pair of quotes is correct ONLY for a single executable path. For a COMPOSITE
 * invocation (`npx adversarial-review-gate` — the installer's DEFAULT fallback —
 * or `node "C:\Program Files\...\ar.js"`), wrapping the whole string yields
 * `"npx adversarial-review-gate" run ...`, which the shell tries to run as a
 * literal (space-containing) executable name → the wrapper fails to launch and the
 * review gate is skipped. We therefore TOKENIZE a composite and quote each token
 * independently (leaving the bare launcher unquoted, quoting only the path arg).
 * A single spaced path stays wrapped as one token.
 *
 * @param {string} bin
 * @returns {string}
 */
function quoteBin(bin) {
  // Reject command-substitution metacharacters first (fail closed): see above.
  assertNoCommandSubstitution(bin);
  if (!QUOTE_TRIGGER_RE.test(bin)) return bin;
  if (looksLikeComposite(bin)) {
    return tokenizeBin(bin).map(quoteToken).join(" ");
  }
  return `"${String(bin).replace(/"/g, '\\"')}"`;
}

/**
 * Return the wrapper invocation string and residual-risk note for a host.
 *
 * No file writes occur — wrapper hosts require the user to change their own
 * launch command.  The returned object is printable by the installer.
 *
 * @param {object} options
 * @param {string} options.host        - host id (e.g. "codex", "opencode")
 * @param {string} [options.reviewer]  - reviewer id (may be "none")
 * @param {string} [options.binPath]   - resolved path to adversarial-review binary
 * @returns {{ host: string, wrapperCommand: string, enforcement: string, residualRisk: string }}
 */
export function wrapperInstructions({ host, reviewer, binPath }) {
  // Quote the binPath so the printed wrapper command is copy-pasteable and does
  // not shell-split mid-path. quoteBin() handles BOTH a single spaced path
  // (`C:\Program Files\..` → one quoted token) AND a composite invocation
  // (`npx adversarial-review-gate` → bare launcher + bare arg, NOT one bogus
  // quoted token) so the default fallback prints a runnable command.
  const bin = binPath ? quoteBin(String(binPath)) : "npx adversarial-review-gate";
  const reviewerNote = reviewer && reviewer !== "none" ? ` (reviewer: ${reviewer})` : "";

  // Build a representative wrapper command.  The user substitutes their actual
  // subcommand in place of the placeholder.
  const wrapperCommand = `${bin} run --host ${host} -- ${host} <your-command>`;

  return {
    host,
    wrapperCommand,
    enforcement: "wrapper-enforced",
    residualRisk:
      `Wrapper enforcement depends on the user always invoking ${host} through ` +
      `adversarial-review run. Bypassing the wrapper skips the review gate entirely. ` +
      `Native enforcement is not available for this host${reviewerNote}.`,
  };
}
