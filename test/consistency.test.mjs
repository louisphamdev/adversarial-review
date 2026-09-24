// Every surface that names the package must agree. Each fact below was once shipped wrong
// because one file changed and the others did not.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { ENGINE_VERSION } from '../skills/adversarial-review/scripts/lib/version.mjs';

const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
const plugin = JSON.parse(readFileSync('.claude-plugin/plugin.json', 'utf8'));
const market = JSON.parse(readFileSync('.claude-plugin/marketplace.json', 'utf8'));
const read = (f) => readFileSync(f, 'utf8');
const docs = ['README.md', 'CONTRIBUTING.md', 'SECURITY.md', 'CHANGELOG.md', 'skills/adversarial-review/SKILL.md',
  ...readdirSync('skills/adversarial-review/references').map((f) => `skills/adversarial-review/references/${f}`)];

test('one version everywhere', () => {
  assert.equal(ENGINE_VERSION, pkg.version, 'version.mjs ENGINE_VERSION');
  assert.equal(plugin.version, pkg.version, '.claude-plugin/plugin.json version');
  const top = read('CHANGELOG.md').match(/^## \[(\d+\.\d+\.\d+)\]/m)[1];
  assert.equal(top, pkg.version, 'top CHANGELOG entry');
});

test('one description for npm and the Claude Code plugin', () => {
  assert.equal(plugin.description, pkg.description);
  const entry = market.plugins.find((p) => p.name === plugin.name);
  assert.ok(entry, 'marketplace lists the plugin by the same name');
  assert.equal(entry.description, pkg.description);
});

test('every `npm run <script>` in the docs exists in package.json', () => {
  for (const f of docs) {
    for (const m of read(f).matchAll(/npm run ([\w:-]+)/g)) {
      assert.ok(pkg.scripts[m[1]], `${f} names npm run ${m[1]}, which package.json does not define`);
    }
  }
});

test('the README names both registries and the command the package installs', () => {
  const readme = read('README.md');
  const bin = Object.keys(pkg.bin)[0];
  assert.match(readme, new RegExp(`npm install -g ${pkg.name}`));
  assert.match(readme, new RegExp(`npx ${pkg.name}`));
  assert.ok(readme.includes(`@louisphamdev/${pkg.name}`), 'GitHub Packages name');
  assert.ok(readme.includes(`\`${bin}\``), 'installed command name');
  const wf = read('.github/workflows/publish-github-packages.yml');
  assert.ok(wf.includes(`name=@louisphamdev/${pkg.name}`), 'workflow publishes the name the README gives');
});

test('repository links point at this repository', () => {
  assert.match(pkg.repository.url, /github\.com\/louisphamdev\/adversarial-review\.git$/);
  assert.match(pkg.bugs, /louisphamdev\/adversarial-review\/issues$/);
});
