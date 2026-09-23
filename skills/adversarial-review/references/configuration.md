# Configuration Reference

This document describes every config key for adversarial-review v3.

## Config Layers

The engine reads configuration from four layers.
Each higher layer overrides lower layers.

1. Built-in defaults.
2. User config at `<state>/config.json`.
3. Project config at `<repo>/.adversarial-review/config.json`.
4. CLI flags.

Both config files must contain `"version": 3`.
The engine ignores files without `"version": 3` and prints a warning.

## Trust Boundary

A repository can contain hostile files.
Project config can only make a review stricter.
Project config can set only three keys: `seats`, `budget`, and `requirementsFile`.
The engine ignores every other key in a project config.

## Keys and Defaults

### version

Default: `3`
Settable by: user config, project config.
The config file schema version.
Both user config and project config must set this value to `3`.

### hostBackend

Default: `null`
Settable by: user config, `--backend` flag.
The backend that hosts the run.
When `null`, the engine selects an available backend on PATH.
Allowed values include `claude`, `codex`, `opencode`, `gemini`, and `custom`.

### route

Default: `"auto"`
Settable by: user config, `--route` flag.
The execution route for seats.
Allowed values are `"auto"`, `"spawn"`, and `"swarm"`.

### routeAsk

Default: `true`
Settable by: user config.
Controls user confirmation for the recommend command.
If `true`, the host asks the user before choosing a swarm route.
If `false`, the host accepts the recommendation without asking.

### swarm

Settable by: user config.
Configures swarm execution parameters.

#### swarm.backend

Default: `"opencode"`
Settable by: user config.
The backend used for swarm execution.

#### swarm.allowFree

Default: `false`
Settable by: user config.
Allows free models during route selection.
Free models can train provider models on prompt contents.

#### swarm.wideFiles

Default: `30`
Settable by: user config.
File count threshold for route decisions.
If file count exceeds this number, the engine chooses swarm.

#### swarm.wideLines

Default: `5000`
Settable by: user config.
Line count threshold for route decisions.
If line count exceeds this number, the engine chooses swarm.

### stages

Default: `{}`
Settable by: user config.
Per-stage overrides for model and effort settings.
Stages include `find`, `table`, `dispute`, `lastcall`, and `ruling`.
For each stage, you can set `model` and `effort`.

### backends

Default: `{}`
Settable by: user config.
Custom backend options and candidate model lists.
Keys match backend names such as `codex`, `gemini`, or `custom`.

### maxParallel

Default: `4`
Settable by: user config.
Maximum parallel seat processes allowed during execution.

### budget

Default: `20`
Settable by: user config, project config, `--budget` flag.
The tool call budget for FIND seats.
Project config can only raise this value up to 200.

### timeouts

Settable by: user config.
Execution timeouts in milliseconds for seat calls.

#### timeouts.find

Default: `1200000` (20 minutes)
Settable by: user config.
Timeout in milliseconds for the FIND stage.

#### timeouts.ruling

Default: `900000` (15 minutes)
Settable by: user config.
Timeout in milliseconds for the RULING stage.

#### timeouts.other

Default: `600000` (10 minutes)
Settable by: user config.
Timeout in milliseconds for other stages.

### quota

Settable by: user config.
Configuration for quota measurement.

#### quota.source

Default: `null`
Settable by: user config.
The source for quota readings.
Values are `claude-oauth`, `command`, or `none`.
Defaults to `claude-oauth` when hostBackend is `claude`.

#### quota.threshold

Default: `80`
Settable by: user config.
Percent threshold that triggers route recommendations.

#### quota.command

Default: `null`
Settable by: user config.
Custom command to read quota percent.
The command must output a number or JSON with a percent field.

### sift

Settable by: user config.
Configuration for the Jev decision sift buffer.

#### sift.enabled

Default: `true`
Settable by: user config.
Enables the sift stage before RULING.

#### sift.url

Default: `"https://openrouter.ai/api/alpha/decisions"`
Settable by: user config.
The HTTP endpoint for the decision service.

#### sift.model

Default: `"typesafe/jev-1.13"`
Settable by: user config.
The model identifier for the decision sift.

#### sift.apiKeyEnv

Default: `"JEV_API_KEY"`
Settable by: user config.
The environment variable holding the API key.

#### sift.keyFile

Default: `null`
Settable by: user config.
Path to a file holding the API key.

#### sift.lowConfidence

Default: `0.6`
Settable by: user config.
Confidence cutoff below which findings receive extra review.

#### sift.timeoutMs

Default: `60000` (60 seconds)
Settable by: user config.
Timeout in milliseconds for HTTP calls to the sift service.

### catalog

Settable by: user config.
Controls model discovery and benchmarking.

#### catalog.maxAgeDays

Default: `7`
Settable by: user config.
Maximum age in days for cached benchmark scores.

#### catalog.probeLimit

Default: `6`
Settable by: user config.
Maximum candidate models to probe per run.

## Project Config Keys

Project config files can set only these keys:

### seats

Default: none
Settable by: project config, `--seats` flag.
Additional seats for the stage.
This setting adds seats to the default set.
It will never remove a default seat.

### requirementsFile

Default: none
Settable by: project config, `--requirements-file` flag.
Path to a repository requirements file.
The file must live inside the repository root.
The file must be tracked by git.
The file size must not exceed 64 KB.
The path must not contain hidden directory segments.
