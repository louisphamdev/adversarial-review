import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { reviewerMappingFor, buildHostRouting } from "../../src/cli/host-map.js";

describe("reviewerMappingFor", () => {
  it("honors an explicit external reviewer for a native host (claude-code -> opencode)", () => {
    const config = { hosts: { "claude-code": { reviewer: "opencode" } } };
    assert.equal(reviewerMappingFor("claude-code", config), "opencode");
  });

  it("defaults a native host to native self-review when unconfigured", () => {
    assert.equal(reviewerMappingFor("claude-code", {}), "none");
  });

  it("honors an explicit 'none' for a native host", () => {
    const config = { hosts: { "claude-code": { reviewer: "none" } } };
    assert.equal(reviewerMappingFor("claude-code", config), "none");
  });

  it("honors an explicit reviewer for a wrapper host (codex -> opencode)", () => {
    const config = { hosts: { codex: { reviewer: "opencode" } } };
    assert.equal(reviewerMappingFor("codex", config), "opencode");
  });

  it("maps a wrapper host id naming a known reviewer to itself", () => {
    assert.equal(reviewerMappingFor("codex", {}), "codex");
  });
});

describe("buildHostRouting", () => {
  it("builds a real reviewerRunner when a native host is mapped to an external reviewer", () => {
    const config = { hosts: { "claude-code": { reviewer: "opencode" } } };
    const env = {};
    const { hostDescriptor, reviewerRunner } = buildHostRouting("claude-code", config, env);
    assert.equal(hostDescriptor.id, "claude-code");
    assert.equal(hostDescriptor.reviewerMapping, "opencode");
    assert.notEqual(reviewerRunner, null);
    assert.equal(typeof reviewerRunner, "function");
  });

  it("yields a null reviewerRunner for native self-review", () => {
    const { hostDescriptor, reviewerRunner } = buildHostRouting("claude-code", {}, {});
    assert.equal(hostDescriptor.reviewerMapping, "none");
    assert.equal(reviewerRunner, null);
  });
});
