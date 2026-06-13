import { createHash } from "node:crypto";

export function sha256(text) {
  return createHash("sha256").update(String(text), "utf8").digest("hex");
}

export function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export function reviewCacheKey(parts) {
  return sha256(stableJson({
    diffHash: parts.diffHash,
    configHash: parts.configHash,
    promptHash: parts.promptHash,
    reviewerId: parts.reviewerId,
    reviewerVersion: parts.reviewerVersion,
    model: parts.model || "",
    level: parts.level,
    toolVersion: parts.toolVersion,
    privacyMode: parts.privacyMode,
  }));
}
