// Multi-layer configuration loader and model validator.
import fs from 'node:fs';
import path from 'node:path';
import { stateDir, isInside } from './paths.mjs';
import { ConfigError } from './errors.mjs';

// Regex for allowed model identifiers: vendor/model name and optional #variant.
export const MODEL_RE = /^[A-Za-z0-9][A-Za-z0-9._/:@-]*(#[A-Za-z0-9]+)?$/;

// Validates model name syntax to avoid flag injection.
export function isValidModel(s) {
  return typeof s === 'string' && MODEL_RE.test(s);
}

// Built-in defaults for adversarial review v3.
export const DEFAULTS = Object.freeze({
  version: 3,
  hostBackend: null,
  route: 'auto',
  routeAsk: true,
  swarm: Object.freeze({
    backend: 'opencode',
    allowFree: false,
    wideFiles: 30,
    wideLines: 5000,
  }),
  stages: Object.freeze({}),
  backends: Object.freeze({}),
  maxParallel: 4,
  budget: 20,
  timeouts: Object.freeze({
    find: 1200000,
    ruling: 900000,
    other: 600000,
  }),
  quota: Object.freeze({
    source: null,
    threshold: 80,
    command: null,
  }),
  sift: Object.freeze({
    enabled: true,
    url: 'https://openrouter.ai/api/alpha/decisions',
    model: 'typesafe/jev-1.13',
    apiKeyEnv: 'JEV_API_KEY',
    keyFile: null,
    lowConfidence: 0.6,
    timeoutMs: 60000,
  }),
  catalog: Object.freeze({
    maxAgeDays: 7,
    probeLimit: 6,
  }),
});

// Merges defaults, user config, project config, and flags.
export function loadConfig({ env = process.env, repoRoot, flags = {}, stderr } = {}) {
  const config = structuredClone(DEFAULTS);
  const warnings = [];

  // Layer 2: user config (<state>/config.json)
  const state = stateDir(env);
  const userConfigFile = path.join(state, 'config.json');
  let userRaw = null;
  try {
    userRaw = fs.readFileSync(userConfigFile, 'utf8');
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }

  if (userRaw !== null) {
    let userJson;
    try {
      userJson = JSON.parse(userRaw);
    } catch (err) {
      throw new ConfigError(`Invalid JSON in user config file "${userConfigFile}": ${err.message}`);
    }

    if (!userJson || typeof userJson !== 'object' || Array.isArray(userJson) || userJson.version !== 3) {
      warnings.push(`user config file "${userConfigFile}" ignored: missing version: 3`);
    } else {
      if (userJson.hostBackend !== undefined) config.hostBackend = userJson.hostBackend;
      if (userJson.route !== undefined) config.route = userJson.route;
      if (userJson.routeAsk !== undefined) config.routeAsk = Boolean(userJson.routeAsk);
      if (typeof userJson.maxParallel === 'number') config.maxParallel = userJson.maxParallel;
      if (typeof userJson.budget === 'number') config.budget = userJson.budget;

      if (userJson.swarm && typeof userJson.swarm === 'object' && !Array.isArray(userJson.swarm)) {
        config.swarm = { ...config.swarm, ...userJson.swarm };
      }
      if (userJson.timeouts && typeof userJson.timeouts === 'object' && !Array.isArray(userJson.timeouts)) {
        config.timeouts = { ...config.timeouts, ...userJson.timeouts };
      }
      if (userJson.quota && typeof userJson.quota === 'object' && !Array.isArray(userJson.quota)) {
        config.quota = { ...config.quota, ...userJson.quota };
      }
      if (userJson.sift && typeof userJson.sift === 'object' && !Array.isArray(userJson.sift)) {
        config.sift = { ...config.sift, ...userJson.sift };
      }
      if (userJson.catalog && typeof userJson.catalog === 'object' && !Array.isArray(userJson.catalog)) {
        config.catalog = { ...config.catalog, ...userJson.catalog };
      }
      if (userJson.stages && typeof userJson.stages === 'object' && !Array.isArray(userJson.stages)) {
        config.stages = { ...userJson.stages };
      }
      if (userJson.backends && typeof userJson.backends === 'object' && !Array.isArray(userJson.backends)) {
        config.backends = { ...userJson.backends };
      }
    }
  }

  // Layer 3: project config (<repoRoot>/.adversarial-review/config.json)
  if (repoRoot) {
    const projectConfigFile = path.join(repoRoot, '.adversarial-review', 'config.json');
    let projectRaw = null;
    try {
      projectRaw = fs.readFileSync(projectConfigFile, 'utf8');
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
    }

    if (projectRaw !== null) {
      if (!isInside(projectConfigFile, repoRoot)) {
        warnings.push(`project config file "${projectConfigFile}" ignored: resolves outside repository root`);
      } else {
        let projectJson;
        try {
          projectJson = JSON.parse(projectRaw);
        } catch {
          warnings.push(`project config file "${projectConfigFile}" ignored: invalid JSON`);
        }

        if (projectJson && typeof projectJson === 'object' && !Array.isArray(projectJson)) {
          if (projectJson.version !== 3) {
            warnings.push(`project config file "${projectConfigFile}" ignored: missing version: 3`);
          } else {
            if (Array.isArray(projectJson.seats)) {
              config.projectSeats = projectJson.seats.filter((s) => typeof s === 'string');
            }
            if (typeof projectJson.budget === 'number') {
              config.budget = Math.min(200, Math.max(config.budget, projectJson.budget));
            }
            if (typeof projectJson.requirementsFile === 'string') {
              const reqPath = path.resolve(repoRoot, projectJson.requirementsFile);
              if (isInside(reqPath, repoRoot)) {
                config.requirementsFile = projectJson.requirementsFile;
              } else {
                warnings.push(
                  `project config requirementsFile "${projectJson.requirementsFile}" ignored: resolves outside repository root`
                );
              }
            }
            for (const key of Object.keys(projectJson)) {
              if (key !== 'version' && key !== 'seats' && key !== 'budget' && key !== 'requirementsFile') {
                warnings.push(`project config key "${key}" ignored`);
              }
            }
          }
        }
      }
    }
  }

  // Layer 4: CLI flags win last
  if (flags) {
    if (flags.route !== undefined && flags.route !== null) config.route = flags.route;
    if (flags.backend !== undefined && flags.backend !== null) config.hostBackend = flags.backend;
    if (flags.budget !== undefined && flags.budget !== null) config.budget = Number(flags.budget);
  }

  // Validate all configured model strings
  for (const [stgName, stgVal] of Object.entries(config.stages || {})) {
    if (stgVal && typeof stgVal === 'object' && stgVal.model != null) {
      if (!isValidModel(stgVal.model)) {
        throw new ConfigError(`Invalid model in stages.${stgName}.model: "${stgVal.model}"`);
      }
    }
  }

  for (const [bkName, bkVal] of Object.entries(config.backends || {})) {
    if (bkVal && typeof bkVal === 'object') {
      if (Array.isArray(bkVal.models)) {
        for (const m of bkVal.models) {
          if (!isValidModel(m)) {
            throw new ConfigError(`Invalid model in backends.${bkName}.models: "${m}"`);
          }
        }
      }
      if (bkVal.model != null && !isValidModel(bkVal.model)) {
        throw new ConfigError(`Invalid model in backends.${bkName}.model: "${bkVal.model}"`);
      }
    }
  }

  if (flags) {
    if (flags.model != null && !isValidModel(flags.model)) {
      throw new ConfigError(`Invalid model in flags.model: "${flags.model}"`);
    }
    for (const [k, v] of Object.entries(flags)) {
      if (k !== 'model' && (k.endsWith('Model') || k.endsWith('model')) && typeof v === 'string') {
        if (!isValidModel(v)) {
          throw new ConfigError(`Invalid model in flags.${k}: "${v}"`);
        }
      }
    }
  }

  if (config.sift && config.sift.model != null && !isValidModel(config.sift.model)) {
    throw new ConfigError(`Invalid model in sift.model: "${config.sift.model}"`);
  }

  if (stderr && typeof stderr.write === 'function') {
    for (const w of warnings) {
      stderr.write(`${w}\n`);
    }
  }

  return { config, warnings };
}
