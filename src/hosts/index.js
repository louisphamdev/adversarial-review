// Host capability registry.
//
// Each entry describes how a host integrates with the gate:
//   enforcement:          "native-enforced"  - the host has a native Stop hook
//                                              that the gate can attach to;
//                         "wrapper-enforced" - the gate is invoked via a
//                                              wrapper command (npx adversarial-
//                                              review run --host <h> -- <cmd>).
//   supportsBaseline:     true when the host exposes SessionStart / session-
//                         open lifecycle hooks where we can capture a baseline.
//   supportsSelfReview:   true when the host's own agent can act as reviewer
//                         (native self-review).
//   supportsNativeBlock:  true when the gate can hard-block the host from
//                         completing an action via a native protocol return
//                         (e.g. Claude Code Stop hook {"decision":"block"}).
//   supportsExternalReview: true when an external reviewer process (codex,
//                           opencode, custom) can be used for this host.

export const HOSTS = {
  "claude-code": {
    id: "claude-code",
    enforcement: "native-enforced",
    supportsBaseline: false,
    supportsSelfReview: true,
    supportsNativeBlock: true,
    supportsExternalReview: true,
  },
  "codex": {
    id: "codex",
    enforcement: "wrapper-enforced",
    supportsBaseline: true,
    supportsSelfReview: true,
    supportsNativeBlock: false,
    supportsExternalReview: true,
  },
  "opencode": {
    id: "opencode",
    enforcement: "wrapper-enforced",
    supportsBaseline: true,
    supportsSelfReview: true,
    supportsNativeBlock: false,
    supportsExternalReview: true,
  },
  "github-copilot-cli": {
    id: "github-copilot-cli",
    enforcement: "wrapper-enforced",
    supportsBaseline: true,
    supportsSelfReview: false,
    supportsNativeBlock: false,
    supportsExternalReview: false,
  },
  "antigravity": {
    id: "antigravity",
    enforcement: "wrapper-enforced",
    supportsBaseline: true,
    supportsSelfReview: false,
    supportsNativeBlock: false,
    supportsExternalReview: false,
  },
};
