// Review stages, and the per-stage prompt rules (kind, hunt lines, evidence) that the
// claude-agent seat render emits.
export const REVIEW_STAGES = ['spec', 'plan', 'code', 'debug'];

// `code` comes first because the no-stage fallback rule tells a seat to use the code rules.
// Derived from REVIEW_STAGES, so a new stage cannot be left out of the render.
export const RENDER_ORDER = Object.freeze(['code', ...REVIEW_STAGES.filter((st) => st !== 'code')]);

export const STAGE_BLOCKS = Object.freeze(Object.assign(Object.create(null), {
  spec: {
    kind: 'The material is a design document. Review the document text, not code.',
    hunt: [
      'Verify that each stated requirement has a section that meets it.',
      'Verify that two sections that describe one interface describe it the same way.',
      'Report each term that the document uses and does not define.',
      'Report each operation that has no stated behavior on failure.',
    ],
    evidence: 'Evidence is a quote from the material plus the requirement it fails. `doneWhen` is the rewritten sentence.',
  },
  plan: {
    kind: 'The material is an implementation plan. Review the plan text, not code.',
    hunt: [
      'Verify that each task comes after every task that it depends on.',
      'Report each task that changes data or config and has no rollback step.',
      'Report each task that has no test.',
      'Report each pair of tasks that edit the same file with no stated order.',
    ],
    evidence: 'Evidence is the task text it fails. `doneWhen` is about the plan text, for example "task 4 lists the rollback step".',
  },
  code: {
    kind: 'The material is source code or a diff of source code.',
    hunt: [],
    evidence: 'Evidence is `file:line` you actually read. `doneWhen` names the changed behavior.',
  },
  debug: {
    kind: 'The material is a failure and the code around it.',
    hunt: ['A finding is a theory of the cause.', 'Evidence states what your theory predicts that the other theories do not predict.'],
    evidence: '`doneWhen` is the check that confirms or rejects your theory.',
  },
}));

export function stageBlockText(stage) {
  const b = STAGE_BLOCKS[stage];
  return [b.kind, ...b.hunt, b.evidence].join('\n');
}
