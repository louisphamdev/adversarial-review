// JSON schemas for structured model output in each pipeline stage.

export const FINDINGS = {
  type: 'object',
  additionalProperties: false,
  properties: {
    findings: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          title: { type: 'string' },
          file: { type: 'string' },
          line: { type: 'string' },
          severity: { type: 'string', enum: ['critical', 'important', 'minor', 'advisory'] },
          detail: { type: 'string' },
          evidence: { type: 'string' },
          doneWhen: { type: 'string' },
        },
        required: ['title', 'severity', 'detail', 'evidence', 'doneWhen'],
      },
    },
    notRead: { type: 'array', items: { type: 'string' }, description: 'What you could not read or check' },
  },
  required: ['findings'],
};

export const TABLE = {
  type: 'object',
  additionalProperties: false,
  properties: {
    positions: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        // reason declared before position so the seat reasons before taking a stand
        properties: {
          id: { type: 'string' },
          reason: { type: 'string' },
          position: { type: 'string', enum: ['dispute', 'support', 'pass'] },
        },
        required: ['id', 'reason', 'position'],
      },
    },
    missedBetweenLenses: { type: 'array', items: { type: 'string' } },
    fixRisks: { type: 'array', items: { type: 'string' } },
  },
  required: ['positions'],
};

export const REBUTTAL = {
  type: 'object',
  additionalProperties: false,
  // rebuttal declared before standsFirm
  properties: {
    id: { type: 'string' },
    rebuttal: { type: 'string' },
    standsFirm: { type: 'boolean' },
  },
  required: ['id', 'rebuttal', 'standsFirm'],
};

export const LASTCALL = {
  type: 'object',
  additionalProperties: false,
  properties: {
    notYetSaid: { type: 'array', items: { type: 'string' } },
  },
  required: ['notYetSaid'],
};

export const RULING = {
  type: 'object',
  additionalProperties: false,
  properties: {
    verdict: { type: 'string', enum: ['blocked', 'pass-with-items', 'pass'] },
    closingList: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          n: { type: 'number' },
          item: { type: 'string' },
          where: { type: 'string' },
          severity: { type: 'string', enum: ['critical', 'important', 'minor'] },
          doneWhen: { type: 'string' },
          why: { type: 'string' },
          sources: { type: 'array', items: { type: 'string' } },
        },
        required: ['n', 'item', 'severity', 'doneWhen', 'sources'],
      },
    },
    advisory: { type: 'array', items: { type: 'string' } },
    frozenScope: { type: 'array', items: { type: 'string' } },
    coverage: { type: 'string', description: 'Which lenses had no seat, and what nobody read' },
  },
  required: ['verdict', 'closingList', 'coverage'],
};

export const PATCH_SEAT = {
  type: 'object',
  additionalProperties: false,
  properties: {
    items: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          id: { type: 'string' },
          reason: { type: 'string' },
          plan: { type: 'string', enum: ['sound', 'breaks-my-lens', 'collides', 'oversized'] },
          collidesWith: { type: 'string' },
        },
        required: ['id', 'reason', 'plan'],
      },
    },
  },
  required: ['items'],
};

export const PATCH_JUDGE = {
  type: 'object',
  additionalProperties: false,
  properties: {
    reasons: { type: 'array', items: { type: 'string' } },
    decision: { type: 'string', enum: ['APPLY', 'REVISE'] },
    revise: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          item: { type: 'string' },
          doneWhen: { type: 'string' },
        },
        required: ['item', 'doneWhen'],
      },
    },
  },
  required: ['reasons', 'decision', 'revise'],
};

export const VERIFY_SEAT = {
  type: 'object',
  additionalProperties: false,
  properties: {
    items: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          id: { type: 'string' },
          evidence: { type: 'string' },
          status: { type: 'string', enum: ['met', 'not-met'] },
        },
        required: ['id', 'evidence', 'status'],
      },
    },
    newInDiff: { type: 'array', items: { type: 'string' } },
  },
  required: ['items', 'newInDiff'],
};

export const VERIFY_JUDGE = {
  type: 'object',
  additionalProperties: false,
  properties: {
    reasons: { type: 'array', items: { type: 'string' } },
    verdict: { type: 'string', enum: ['PASS', 'BLOCK'] },
    open: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          item: { type: 'string' },
          why: { type: 'string' },
        },
        required: ['item', 'why'],
      },
    },
  },
  required: ['reasons', 'verdict', 'open'],
};

export const PROBE = {
  type: 'object',
  additionalProperties: false,
  properties: {
    ok: { type: 'boolean' },
  },
  required: ['ok'],
};

// Transforms schema for strict mode: all properties required, optional properties become anyOf [orig, null].
export function strictify(schema) {
  const copy = structuredClone(schema);

  function transform(node) {
    if (!node || typeof node !== 'object') return node;

    if (node.type === 'object' || node.properties) {
      node.additionalProperties = false;
      if (node.properties) {
        const origRequired = new Set(Array.isArray(node.required) ? node.required : []);
        const allKeys = Object.keys(node.properties);
        node.required = allKeys;
        for (const key of allKeys) {
          const origProp = transform(node.properties[key]);
          if (!origRequired.has(key)) {
            node.properties[key] = {
              anyOf: [origProp, { type: 'null' }],
            };
          } else {
            node.properties[key] = origProp;
          }
        }
      } else if (!Array.isArray(node.required)) {
        node.required = [];
      }
    }

    if (node.items) {
      if (Array.isArray(node.items)) {
        node.items = node.items.map(transform);
      } else {
        node.items = transform(node.items);
      }
    }

    if (Array.isArray(node.anyOf)) {
      node.anyOf = node.anyOf.map(transform);
    }
    if (Array.isArray(node.oneOf)) {
      node.oneOf = node.oneOf.map(transform);
    }
    if (Array.isArray(node.allOf)) {
      node.allOf = node.allOf.map(transform);
    }

    return node;
  }

  return transform(copy);
}
