import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULTS } from '../skills/adversarial-review/scripts/lib/config.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');

const skillPath = path.join(rootDir, 'skills', 'adversarial-review', 'SKILL.md');
const tableRulesPath = path.join(rootDir, 'skills', 'adversarial-review', 'references', 'table-rules.md');
const liveTablePath = path.join(rootDir, 'skills', 'adversarial-review', 'references', 'live-table.md');
const configDocPath = path.join(rootDir, 'skills', 'adversarial-review', 'references', 'configuration.md');
const readmePath = path.join(rootDir, 'README.md');
const changelogPath = path.join(rootDir, 'CHANGELOG.md');
const contributingPath = path.join(rootDir, 'CONTRIBUTING.md');
const securityPath = path.join(rootDir, 'SECURITY.md');
const pluginPath = path.join(rootDir, '.claude-plugin', 'plugin.json');
const marketplacePath = path.join(rootDir, '.claude-plugin', 'marketplace.json');

test('docs and plugin tests', async (t) => {
  await t.test('SKILL.md frontmatter and body requirements', () => {
    assert.ok(fs.existsSync(skillPath), 'SKILL.md must exist');
    const content = fs.readFileSync(skillPath, 'utf8');
    const lines = content.split('\n');

    // First lines must be frontmatter with name and description
    assert.equal(lines[0].trim(), '---', 'First line must be frontmatter delimiter');
    assert.equal(lines[1].trim(), 'name: adversarial-review', 'Second line must define name: adversarial-review');
    assert.ok(lines[2].startsWith('description:'), 'Third line must start description:');

    // Check frontmatter closing
    const secondDelim = lines.indexOf('---', 1);
    assert.ok(secondDelim > 2, 'Frontmatter must close with ---');
    const frontmatter = lines.slice(1, secondDelim).join('\n');

    // Triggers and usages in description
    assert.match(frontmatter, /spec/);
    assert.match(frontmatter, /plan/);
    assert.match(frontmatter, /code/);
    assert.match(frontmatter, /debug/);
    assert.match(frontmatter, /roundtable/);
    assert.match(frontmatter, /adversarial review/);
    assert.match(frontmatter, /bàn tròn/);
    assert.match(frontmatter, /review đối kháng/);
    assert.match(frontmatter, /one-line/);

    // Body content checks
    const body = lines.slice(secondDelim + 1).join('\n');
    assert.match(body, /when to convene/i);
    assert.match(body, /recommend/);
    assert.match(body, /node\s+["']<skill-dir>\/scripts\/adversarial-review\.mjs["']\s+run/);
    assert.match(body, /--backend/);
    assert.match(body, /result\.json/);
    assert.match(body, /gateVerdict/);
    assert.match(body, /closing list/i);
    assert.match(body, /gaps/i);
    assert.match(body, /patch-review/i);
    assert.match(body, /verify/i);
    assert.match(body, /references\/live-table\.md/);
    assert.match(body, /never fix before the ruling/i);
  });

  await t.test('live-table.md names stages in order and required fields', () => {
    assert.ok(fs.existsSync(liveTablePath), 'live-table.md must exist');
    const content = fs.readFileSync(liveTablePath, 'utf8');

    const stages = ['FIND', 'TABLE', 'DISPUTE', 'LAST CALL', 'RULING', 'PATCH REVIEW', 'VERIFY'];
    let lastIdx = -1;
    for (const stage of stages) {
      const idx = content.indexOf(stage);
      assert.ok(idx !== -1, `live-table.md must name stage ${stage}`);
      assert.ok(idx > lastIdx, `Stage ${stage} must appear in order after previous stage`);
      lastIdx = idx;
    }

    assert.match(content, /doneWhen|Done when/);
    assert.match(content, /severity|Severity/);
    assert.match(content, /evidence|Evidence/);
    assert.match(content, /~\/\.adversarial-review\/memory\//);
  });

  await t.test('table-rules.md ports rules and replaces host mechanics', () => {
    assert.ok(fs.existsSync(tableRulesPath), 'table-rules.md must exist');
    const content = fs.readFileSync(tableRulesPath, 'utf8');

    assert.match(content, /your host's way to report/i);
    assert.equal(content.includes('SendMessage'), false, 'table-rules.md must not include SendMessage');
    assert.match(content, /FIND/);
    assert.match(content, /TABLE/);
    assert.match(content, /DISPUTE/);
    assert.match(content, /LAST CALL/);
    assert.match(content, /PATCH REVIEW/);
    assert.match(content, /VERIFY/);
  });

  await t.test('configuration.md documents every key in DEFAULTS', () => {
    assert.ok(fs.existsSync(configDocPath), 'configuration.md must exist');
    const content = fs.readFileSync(configDocPath, 'utf8');

    function checkKeys(obj, prefix = '') {
      for (const [k, v] of Object.entries(obj)) {
        assert.ok(
          content.includes(k),
          `configuration.md must document config key "${prefix}${k}"`
        );
        if (v && typeof v === 'object' && !Array.isArray(v) && Object.keys(v).length > 0) {
          checkKeys(v, `${prefix}${k}.`);
        }
      }
    }

    checkKeys(DEFAULTS);
    assert.ok(content.includes('requirementsFile'), 'configuration.md must document project requirementsFile');
    assert.ok(content.includes('seats'), 'configuration.md must document project seats');
  });

  await t.test('.claude-plugin manifests are valid and plugin.json has no hooks', () => {
    assert.ok(fs.existsSync(pluginPath), 'plugin.json must exist');
    const plugin = JSON.parse(fs.readFileSync(pluginPath, 'utf8'));
    assert.equal(plugin.name, 'adversarial-review');
    assert.equal(plugin.version, JSON.parse(fs.readFileSync('package.json', 'utf8')).version);
    assert.equal(plugin.hooks, undefined, 'plugin.json must have no hooks');

    assert.ok(fs.existsSync(marketplacePath), 'marketplace.json must exist');
    const marketplace = JSON.parse(fs.readFileSync(marketplacePath, 'utf8'));
    assert.equal(marketplace.name, 'adversarial-review');
    assert.ok(Array.isArray(marketplace.plugins), 'marketplace.json must contain plugins array');
    const item = marketplace.plugins.find((p) => p.name === 'adversarial-review');
    assert.ok(item, 'marketplace.json must list adversarial-review plugin');
  });

  await t.test('README.md has no machine-specific data and documents v3', () => {
    assert.ok(fs.existsSync(readmePath), 'README.md must exist');
    const content = fs.readFileSync(readmePath, 'utf8');

    assert.equal(content.includes('/opt/hermes'), false, 'README.md must not contain /opt/hermes');
    assert.equal(content.includes('intact'), false, 'README.md must not contain intact');
    assert.equal(content.includes('INTACT_'), false, 'README.md must not contain INTACT_');

    assert.match(content, /adversarial-review/);
    assert.match(content, /roundtable/i);
    assert.match(content, /install/i);
    assert.match(content, /run/i);
  });

  await t.test('CHANGELOG.md has 3.0.0 entry with CAUTION first', () => {
    assert.ok(fs.existsSync(changelogPath), 'CHANGELOG.md must exist');
    const content = fs.readFileSync(changelogPath, 'utf8');

    assert.match(content, /## \[3\.0\.0\]/);
    const entryIndex = content.indexOf('## [3.0.0]');
    const afterEntry = content.slice(entryIndex);
    const firstLines = afterEntry.split('\n').slice(1, 10).join('\n');
    assert.match(firstLines, /CAUTION/i, '3.0.0 entry must have CAUTION first');
    assert.match(firstLines, /uninstall --v2-hooks/);
  });

  await t.test('CONTRIBUTING.md and SECURITY.md are updated for v3', () => {
    assert.ok(fs.existsSync(contributingPath), 'CONTRIBUTING.md must exist');
    const contContent = fs.readFileSync(contributingPath, 'utf8');
    assert.match(contContent, /adversarial-review/);

    assert.ok(fs.existsSync(securityPath), 'SECURITY.md must exist');
    const secContent = fs.readFileSync(securityPath, 'utf8');
    assert.match(secContent, /3\./, 'SECURITY.md must support version 3.x');
  });

  await t.test('ASD-STE100 and clean styling rules across owned markdown docs', () => {
    const docFiles = [
      skillPath,
      tableRulesPath,
      liveTablePath,
      configDocPath,
      readmePath,
      contributingPath,
      securityPath,
    ];

    const forbiddenModals = [
      /\bshould\b/i,
      /\bwould\b/i,
      /\bmay\b/i,
      /\bmight\b/i,
      /\bcould\b/i,
    ];

    const forbiddenSlop = [
      /\bleverage\b/i,
      /\butilize\b/i,
      /\bseamlessly\b/i,
      /\brobust\b/i,
      /\bpowerful\b/i,
      /\bsimply\b/i,
      /\bjust\b/i,
      /\beasily\b/i,
      /\be\.g\.\b/i,
      /\bi\.e\.\b/i,
      /\betc\.\b/i,
    ];

    const forbiddenVerbs = [
      /\bensure\b/i,
      /\bensures\b/i,
      /\bensuring\b/i,
      /\bvalidate\b/i,
      /\bvalidates\b/i,
      /\bvalidating\b/i,
      /\bconfirm\b/i,
      /\bconfirms\b/i,
      /\bconfirming\b/i,
      /\bcheck\b/,
      /\bchecks\b/,
      /\bchecking\b/,
      /\bverify\b/,
      /\bverifies\b/,
      /\bverifying\b/,
    ];

    // Contractions pattern: don't, won't, can't, it's, etc.
    const contractionPattern = /\b(?:\w+(?:n't|'ve|'re|'ll|'d)|it's|that's|what's|there's|here's|who's|let's)\b/i;

    for (const file of docFiles) {
      if (!fs.existsSync(file)) continue;
      const text = fs.readFileSync(file, 'utf8');

      // Strip code blocks and inline code for style analysis
      const noCodeBlocks = text.replace(/```[\s\S]*?```/g, '');
      const proseOnly = noCodeBlocks.replace(/`[^`\n]+`/g, '');

      // Check no machine specific data
      assert.equal(text.includes('/opt/hermes'), false, `${file} must not contain /opt/hermes`);
      assert.equal(text.includes('intact'), false, `${file} must not contain intact`);
      assert.equal(text.includes('INTACT_'), false, `${file} must not contain INTACT_`);

      // Check no semicolons in prose
      assert.equal(proseOnly.includes(';'), false, `${file} must not contain semicolons in prose`);

      // Check no contractions in prose
      const contrMatch = proseOnly.match(contractionPattern);
      assert.equal(contrMatch, null, `${file} contains contraction: "${contrMatch?.[0]}"`);

      // Check forbidden modals in prose
      for (const re of forbiddenModals) {
        const m = proseOnly.match(re);
        assert.equal(m, null, `${file} contains forbidden modal: "${m?.[0]}"`);
      }

      // Check forbidden slop in prose
      for (const re of forbiddenSlop) {
        const m = proseOnly.match(re);
        assert.equal(m, null, `${file} contains forbidden slop word: "${m?.[0]}"`);
      }

      // Check forbidden verbs in prose (prefer "make sure")
      for (const re of forbiddenVerbs) {
        const m = proseOnly.match(re);
        assert.equal(m, null, `${file} contains forbidden verb: "${m?.[0]}", use "make sure"`);
      }
    }

    // Also check CHANGELOG 3.0.0 entry
    if (fs.existsSync(changelogPath)) {
      const changelogText = fs.readFileSync(changelogPath, 'utf8');
      const entryIdx = changelogText.indexOf('## [3.0.0]');
      if (entryIdx !== -1) {
        const nextEntryIdx = changelogText.indexOf('## [2.', entryIdx);
        const entry300 = nextEntryIdx !== -1 ? changelogText.slice(entryIdx, nextEntryIdx) : changelogText.slice(entryIdx);
        const prose300 = entry300.replace(/```[\s\S]*?```/g, '').replace(/`[^`\n]+`/g, '');

        assert.equal(entry300.includes('/opt/hermes'), false, 'CHANGELOG 3.0.0 must not contain /opt/hermes');
        assert.equal(entry300.includes('intact'), false, 'CHANGELOG 3.0.0 must not contain intact');
        assert.equal(entry300.includes('INTACT_'), false, 'CHANGELOG 3.0.0 must not contain INTACT_');
        assert.equal(prose300.includes(';'), false, 'CHANGELOG 3.0.0 must not contain semicolons in prose');

        const contrMatch = prose300.match(contractionPattern);
        assert.equal(contrMatch, null, `CHANGELOG 3.0.0 contains contraction: "${contrMatch?.[0]}"`);

        for (const re of forbiddenModals) {
          const m = prose300.match(re);
          assert.equal(m, null, `CHANGELOG 3.0.0 contains forbidden modal: "${m?.[0]}"`);
        }
        for (const re of forbiddenSlop) {
          const m = prose300.match(re);
          assert.equal(m, null, `CHANGELOG 3.0.0 contains forbidden slop word: "${m?.[0]}"`);
        }
      }
    }

    // Check sentence lengths across all prose
    for (const file of docFiles) {
      if (!fs.existsSync(file)) continue;
      const text = fs.readFileSync(file, 'utf8');
      const noCode = text.replace(/```[\s\S]*?```/g, '').replace(/`[^`\n]+`/g, '');
      const lines = noCode.split('\n');

      for (const line of lines) {
        const trimmed = line.trim();
        // Skip headings, table rows, horizontal rules, empty lines
        if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith('|') || trimmed.startsWith('---')) {
          continue;
        }

        // Split line into sentences
        const sentences = trimmed.split(/(?<=[.?!])\s+/);
        for (const s of sentences) {
          const words = s.trim().split(/\s+/).filter(Boolean);
          if (words.length === 0) continue;
          // Procedural steps (starting with number or bullet) max 20 words; descriptions max 25 words
          const isProcedure = /^(\d+\.|\*|-)\s+/.test(trimmed);
          const maxWords = isProcedure ? 20 : 25;
          assert.ok(
            words.length <= maxWords,
            `${path.basename(file)} sentence exceeds max ${maxWords} words (${words.length}): "${s}"`
          );
        }
      }
    }
  });
});

test('docs name the published npm package, never the bare name of another owner', async () => {
  const { readFileSync, readdirSync } = await import('node:fs');
  const files = ['README.md', 'skills/adversarial-review/SKILL.md', 'CHANGELOG.md',
    ...readdirSync('skills/adversarial-review/references').map((f) => `skills/adversarial-review/references/${f}`)];
  for (const f of files) {
    const text = readFileSync(f, 'utf8');
    // `adversarial-review` on npm belongs to another owner; npx would run their code.
    assert.equal(/npx\s+(-y\s+)?adversarial-review(?![-\w])/.test(text), false, `${f} runs npx on the bare name`);
  }
  const readme = readFileSync('README.md', 'utf8');
  assert.match(readme, /npm install -g adversarial-review-gate/);
  // The warning must name the npx form, not forbid the installed command itself.
  assert.equal(/Do not run `adversarial-review`/.test(readme), false);
  assert.match(readme, /npmjs\.com\/package\/adversarial-review-gate/);
});
