# Spec: Advisory review gate (v2.3.0)

Date: 2026-06-21
Status: Approved (pending implementation)

## Mục tiêu

Chuyển `adversarial-review-gate` từ mô hình **fail-closed block** (bắt buộc
self-review khi có thay đổi code) sang mô hình **advisory** "hài hòa": gate
*gợi ý* các file nên review kèm lý do, và **coding agent tự quyết định** review
hay skip nếu thay đổi tầm thường. Giữ nguyên đảm bảo an toàn cốt lõi: secret
vẫn bị chặn cứng.

## Quyết định thiết kế (đã chốt với người dùng)

1. **Mức gate**: advisory hoàn toàn cho nhánh self-review, áp dụng **mọi mode**
   (soft / enforced / strict-ci).
2. **Cơ chế**: *block mềm cho agent tự quyết* — gate vẫn trả `decision:block`
   (để Claude Code cho agent thêm một lượt hành động), nhưng reason được viết
   lại thành lời gợi ý: liệt kê file + lý do, nói rõ "bạn tự quyết: chạy
   self-review nếu thấy đáng, hoặc tuyên bố skip nếu thay đổi tầm thường".
   Thêm **phát hiện agent-skip** để agent tự dừng được.
3. **Secret**: phát hiện secret/sensitive-path thật vẫn **chặn cứng** mọi mode.
4. **Thông điệp gợi ý**: liệt kê từng file reviewable kèm lý do (code /
   nhạy cảm / manifest), kèm mức đề xuất (single/debate) và vì sao.

## Hợp đồng gate mới

| Tình huống | Cũ | Mới |
|---|---|---|
| Không thay đổi / docs-only / level none | allow im lặng | giữ nguyên |
| Có thay đổi code, **chưa** review | `block` cứng | **soft block** (gợi ý file+lý do, agent tự quyết) |
| Agent tuyên bố skip (sau lần sửa cuối) | — | **allow** (`agent_skipped`) |
| Đã review hợp lệ (verdict khớp diff hiện tại) | allow im lặng | giữ nguyên |
| Secret / sensitive path thật | block mọi mode | **giữ block cứng** |
| Giới hạn vận hành (repo hỏng, diff truncate, unmappable) | block ở enforced | **advisory-allow** mọi mode |
| Nhánh external reviewer (opt-in) | enforce | **giữ nguyên** (opt-in = chấp nhận enforce) |

### "Logic cache" (theo yêu cầu người dùng)

Giữ **nguyên vẹn** logic phát hiện thay đổi + freshness:
`buildReviewDiff` (diffHash), `selfReviewSatisfied`, `cachedVerdictHonored`,
`reviewCacheKey`. Đây chính là thứ phân biệt *"đã review → im lặng"* vs
*"chưa review → gợi ý"*. Không làm yếu; chỉ đổi đầu ra từ `block` sang
`soft block / advisory`.

## Thay đổi cụ thể

### `src/core/transcript.js`
- Thêm `agentWantsSkip(entries, lastEditKey)`: quét message của **assistant**
  xuất hiện **sau** `lastEditKey`, tìm marker skip có chủ đích để tránh
  dương tính giả. Marker: dòng bắt đầu bằng `[adversarial-review:skip]`
  (kèm lý do tùy chọn). Freshness: chỉ tính marker sau lần sửa cuối.

### `src/core/gate.js`
- `selfReviewBlockReason(level, job)` → viết lại thành thông điệp gợi ý
  (advisory) liệt kê file + lý do + mức + cách skip. (Đổi tên nội bộ thành
  `reviewSuggestionReason` cho rõ nghĩa; vẫn trả qua `block(...)` để giữ cơ
  chế "agent thêm một lượt".)
- Thêm helper `describeReviewableFiles(changedFiles, config, diffStats, level)`
  sinh danh sách `file — lý do`.
- Trước khi `emitSelfReviewBlock`, kiểm tra `agentWantsSkip`; nếu có →
  `allow({ reason: "agent_skipped", level })`.
- Hạ các nhánh giới hạn vận hành (`diff===null`, `diffUnbuildable`,
  `gitOutputTruncated`, `truncatedReviewablePaths`, `hasUnmappableTruncation`)
  xuống **advisory-allow mọi mode** (bỏ rẽ nhánh `enforced ? block : advisory`,
  luôn lấy nhánh advisory). Secret giữ `block`.
- Nhánh external reviewer (`reviewerRunner`, privacy gate, FAIL verdict,
  deferred checks): **giữ nguyên** — chỉ chạy khi opt-in.

### `package.json`
- `version`: `2.2.9` → `2.3.0` (minor: behavior change).

### Tài liệu
- `CHANGELOG.md`: mục 2.3.0 mô tả chuyển sang advisory.
- `README.md`: cập nhật phần mô tả hành vi gate + bảng mode + Residual Risks.
- `src/prompts/adversarial-review-orchestrator.md` và
  `skills/adversarial-review-setup/SKILL.md`: cập nhật câu chữ "bắt buộc" →
  "gợi ý/agent tự quyết" nếu có.

### Test
- `test/core/gate.test.js`: cập nhật kỳ vọng (self-review path → soft block với
  câu chữ mới; enforced operational → advisory); thêm test cho `agentWantsSkip`
  (allow), cho danh sách file+lý do, và cho secret vẫn block.
- `test/cli/hook.test.js`: cập nhật mapping nếu cần.
- Thêm test `agentWantsSkip` ở `test/core` (freshness: marker trước lần sửa
  cuối không tính).

## Tiêu chí hoàn thành

- `npm test` xanh.
- `npm run pack:dry-run` sạch.
- Hành vi: thay đổi code chưa review → gate gợi ý file+lý do; agent chạy
  self-review hoặc tuyên bố skip đều dừng được; secret vẫn chặn.
- Publish `2.3.0` lên npm bằng token người dùng cung cấp.

## Ngoài phạm vi (YAGNI)

- Không đổi nhánh external reviewer.
- Không đổi cấu trúc state/cache trên đĩa.
- Không thêm mode mới.

## Ghi chú git

Người dùng có quy tắc: **không tự ý commit/branch** khi chưa được yêu cầu.
Spec này được ghi ra file nhưng KHÔNG commit trừ khi người dùng yêu cầu.
