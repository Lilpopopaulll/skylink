// UI sanity checks: file reads only (no browser). Guards the "no external resource" rule and the module graph.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PUBLIC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');
const read = (name) => fs.readFileSync(path.join(PUBLIC, name), 'utf8');
const files = fs.readdirSync(PUBLIC).filter((f) => fs.statSync(path.join(PUBLIC, f)).isFile());
const jsFiles = files.filter((f) => f.endsWith('.js'));

test('public/ has the expected files', () => {
  for (const f of ['index.html', 'style.css', 'app.js', 'map.js', 'charts.js']) assert.ok(files.includes(f), `${f} missing`);
});

test('no external resource in public/ (only the SVG namespace is tolerated)', () => {
  for (const f of files) {
    const text = read(f).replaceAll('http://www.w3.org/2000/svg', '');
    assert.doesNotMatch(text, /https?:\/\//i, `${f} references an absolute URL`);
    assert.doesNotMatch(text, /@import|url\(\s*['"]?\/\//i, `${f} pulls an external resource`);
  }
});

test('index.html declares the seven zones and loads the module', () => {
  const html = read('index.html');
  for (const id of ['topbar', 'map', 'cards', 'fleet-actions', 'inspector', 'events', 'incidents']) {
    assert.match(html, new RegExp(`id="${id}"`), `#${id} missing`);
  }
  assert.match(html, /<script type="module" src="\/app\.js">/);
});

test('app.js supports static mode and SSE', () => {
  const app = read('app.js');
  assert.match(app, /static/);
  assert.match(app, /EventSource/);
  assert.match(app, /dataset\.ready/);
});

test('every relative import and linked asset resolves to an existing file', () => {
  const importRe = /(?:import|export)\s+(?:[^'"()]*?\sfrom\s*)?['"]([^'"]+)['"]/g;
  for (const f of jsFiles) {
    for (const m of read(f).matchAll(importRe)) {
      const spec = m[1];
      if (!/^(\.{1,2}\/|\/)/.test(spec)) continue;
      const target = spec.startsWith('/') ? path.join(PUBLIC, spec) : path.resolve(PUBLIC, spec);
      assert.ok(fs.existsSync(target), `${f} imports missing file ${spec}`);
    }
  }
  const html = read('index.html');
  for (const m of html.matchAll(/(?:src|href)="(\/[^"]+)"/g)) {
    assert.ok(fs.existsSync(path.join(PUBLIC, m[1])), `index.html references missing ${m[1]}`);
  }
});
