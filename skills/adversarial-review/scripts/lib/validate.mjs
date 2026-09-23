// Validation and structured output parsing for pipeline stages.

function allowsNull(schema) {
  if (!schema || typeof schema !== 'object') return false;
  if (schema.type === 'null') return true;
  if (Array.isArray(schema.type) && schema.type.includes('null')) return true;
  if (Array.isArray(schema.enum) && schema.enum.includes(null)) return true;
  if (Array.isArray(schema.anyOf) && schema.anyOf.some(allowsNull)) return true;
  if (Array.isArray(schema.oneOf) && schema.oneOf.some(allowsNull)) return true;
  return false;
}

function checkType(val, type) {
  switch (type) {
    case 'string':
      return typeof val === 'string';
    case 'number':
      return typeof val === 'number' && Number.isFinite(val);
    case 'integer':
      return typeof val === 'number' && Number.isInteger(val);
    case 'boolean':
      return typeof val === 'boolean';
    case 'null':
      return val === null;
    case 'object':
      return typeof val === 'object' && val !== null && !Array.isArray(val);
    case 'array':
      return Array.isArray(val);
    default:
      return true;
  }
}

function validateHelper(value, schema, path, errors) {
  if (!schema || typeof schema !== 'object') {
    return { ok: true, value };
  }

  if (Array.isArray(schema.anyOf)) {
    let matched = false;
    let matchedVal = undefined;
    for (const sub of schema.anyOf) {
      const subErrors = [];
      const subRes = validateHelper(value, sub, path, subErrors);
      if (subRes.ok && subErrors.length === 0) {
        matched = true;
        matchedVal = subRes.value;
        break;
      }
    }
    if (matched) {
      return { ok: true, value: matchedVal };
    }
    if (schema.anyOf.length === 2 && schema.anyOf.some((s) => s.type === 'null')) {
      const nonNullSchema = schema.anyOf.find((s) => s.type !== 'null');
      if (value !== null && nonNullSchema) {
        const subErrors = [];
        validateHelper(value, nonNullSchema, path, subErrors);
        if (subErrors.length > 0) {
          errors.push(...subErrors);
          return { ok: false };
        }
      }
    }
    errors.push(`${path || 'value'}: does not match any allowed schema in anyOf`);
    return { ok: false };
  }

  if (schema.type !== undefined) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    const match = types.some((t) => checkType(value, t));
    if (!match) {
      const actual = value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value;
      errors.push(`${path || 'value'}: expected ${types.join(' or ')}, got ${actual}`);
      return { ok: false };
    }
  }

  if (Array.isArray(schema.enum)) {
    if (!schema.enum.includes(value)) {
      errors.push(`${path || 'value'}: not in enum`);
      return { ok: false };
    }
  }

  if (schema.type === 'object' || schema.properties || schema.required) {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      if (schema.type === undefined) {
        const actual = value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value;
        errors.push(`${path || 'value'}: expected object, got ${actual}`);
      }
      return { ok: false };
    }

    const clean = {};

    if (Array.isArray(schema.required)) {
      for (const reqKey of schema.required) {
        if (!(reqKey in value) || value[reqKey] === undefined) {
          const reqPath = path ? `${path}.${reqKey}` : reqKey;
          errors.push(`${reqPath}: required property missing`);
        }
      }
    }

    if (schema.properties) {
      for (const [propKey, propSchema] of Object.entries(schema.properties)) {
        if (propKey in value && value[propKey] !== undefined) {
          const propPath = path ? `${path}.${propKey}` : propKey;
          const propRes = validateHelper(value[propKey], propSchema, propPath, errors);
          if (propRes.ok) {
            if (value[propKey] === null && allowsNull(propSchema)) {
              // null for a property whose schema allows null is dropped (absent == null)
            } else {
              clean[propKey] = propRes.value;
            }
          }
        }
      }
    }

    if (schema.additionalProperties !== false) {
      for (const k of Object.keys(value)) {
        if (!schema.properties || !(k in schema.properties)) {
          clean[k] = value[k];
        }
      }
    }

    return { ok: errors.length === 0, value: clean };
  }

  if (schema.type === 'array' || schema.items) {
    if (!Array.isArray(value)) {
      if (schema.type === undefined) {
        const actual = value === null ? 'null' : typeof value;
        errors.push(`${path || 'value'}: expected array, got ${actual}`);
      }
      return { ok: false };
    }

    const clean = [];
    if (schema.items) {
      for (let i = 0; i < value.length; i++) {
        const itemPath = `${path}[${i}]`;
        const itemRes = validateHelper(value[i], schema.items, itemPath, errors);
        if (itemRes.ok) {
          clean.push(itemRes.value);
        }
      }
    } else {
      for (const item of value) {
        clean.push(item);
      }
    }

    return { ok: errors.length === 0, value: clean };
  }

  return { ok: true, value };
}

// Validates value against schema, drops extra keys when additionalProperties:false, and drops nulls for nullable props.
export function validate(value, schema) {
  const errors = [];
  const res = validateHelper(value, schema, '', errors);
  if (errors.length > 0 || !res.ok) {
    return { ok: false, errors };
  }
  return { ok: true, value: res.value };
}

// Extracts the last fenced json block (or parses whole text) and validates it against schema.
export function parseStructured(text, schema) {
  if (typeof text !== 'string') {
    return { ok: false, error: 'Input must be a string' };
  }
  const re = /```+json[^\n\r]*\r?\n([\s\S]*?)\r?\n[\t ]*```+/gi;
  let matches = Array.from(text.matchAll(re));
  if (matches.length === 0) {
    const fallbackRe = /```+json[^\n\r]*\r?\n([\s\S]*?)```+/gi;
    matches = Array.from(text.matchAll(fallbackRe));
  }
  const raw = matches.length > 0 ? matches[matches.length - 1][1].trim() : text.trim();
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    return { ok: false, error: err.message };
  }
  const res = validate(parsed, schema);
  if (!res.ok) {
    return { ok: false, error: res.errors.join('; ') };
  }
  return { ok: true, value: res.value };
}
