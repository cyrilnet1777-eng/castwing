#!/usr/bin/env node
// ── i18n completeness check ──────────────────────────────────────────
// Pass 1: flags hardcoded user-facing string literals in showToast()/
//         showOverlay() calls (escape hatch: trailing `// i18n-ok`).
// Pass 2: loads js/i18n.js, builds the union of all translation keys,
//         verifies every t('key') used in code exists, that every key
//         defines fr+en, and prints a per-language coverage table.
//
// Modes:
//   node scripts/check-i18n.js            → report only (exit 0)
//   node scripts/check-i18n.js --enforce  → exit 1 on violations
//
// Zero dependencies. Node 18+.

import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const JS_DIR = join(ROOT, 'js');
const ENFORCE = process.argv.includes('--enforce');

const violations = [];
const warnings = [];

// ── Pass 1: hardcoded toast/overlay literals ─────────────────────────

const files = readdirSync(JS_DIR).filter(f => f.endsWith('.js'));
const LITERAL_RX = /show(Toast|Overlay)\(\s*(['"`])(?!\s*\+)/;

for (const f of files) {
  const lines = readFileSync(join(JS_DIR, f), 'utf8').split('\n');
  lines.forEach((line, i) => {
    if (line.includes('i18n-ok')) return;
    if (line.includes('function showToast') || line.includes('function showOverlay')) return;
    const m = line.match(LITERAL_RX);
    if (!m) return;
    // template literal that immediately interpolates t() is fine
    const after = line.slice(line.indexOf(m[0]) + m[0].length - 1);
    if (after.startsWith('`${t(')) return;
    violations.push(`literal-toast  ${f}:${i + 1}  ${line.trim().slice(0, 100)}`);
  });
}

// ── Pass 2: key coverage ─────────────────────────────────────────────

// Stub the browser globals i18n.js's import chain touches at module level
function stub(name, value) {
  try { if (globalThis[name] === undefined) globalThis[name] = value; } catch (_e) { /* getter-only (e.g. navigator) */ }
}
stub('window', { addEventListener() {}, matchMedia: () => ({ matches: false }) });
stub('document', { getElementById: () => null, querySelectorAll: () => [], addEventListener() {}, createElement: () => ({ style: {}, setAttribute() {}, appendChild() {} }), body: { appendChild() {} } });
stub('localStorage', { getItem: () => null, setItem() {}, removeItem() {} });

let i18n;
try {
  i18n = await import(pathToFileURL(join(JS_DIR, 'i18n.js')).href);
} catch (e) {
  console.error('check-i18n: failed to import js/i18n.js:', e.message);
  process.exit(ENFORCE ? 1 : 0);
}

const UI_I18N = i18n.UI_I18N || {};
const UI_EXTRA = i18n.UI_EXTRA_I18N || {};
const FALLBACK = i18n.UI_FALLBACK_TRANSLATIONS || {};
const LANGS = (i18n.UI_LANGUAGES || []).map(l => l.id);

// Union of all keys across packs + fallback rows
const allKeys = new Set();
for (const pack of Object.values(UI_I18N)) Object.keys(pack || {}).forEach(k => allKeys.add(k));
for (const pack of Object.values(UI_EXTRA)) Object.keys(pack || {}).forEach(k => allKeys.add(k));
Object.keys(FALLBACK).forEach(k => allKeys.add(k));

// Every t('key') used in code must exist
const T_RX = /\bt\(\s*'([A-Za-z0-9_]+)'/g;
for (const f of files) {
  const src = readFileSync(join(JS_DIR, f), 'utf8');
  let m;
  while ((m = T_RX.exec(src)) !== null) {
    if (!allKeys.has(m[1])) violations.push(`missing-key    ${f}: t('${m[1]}') is not defined in any language pack`);
  }
}

// Every key must at least have fr and en somewhere
function resolvable(key, lang) {
  if (UI_I18N[lang] && UI_I18N[lang][key] !== undefined) return true;
  if (UI_EXTRA[lang] && UI_EXTRA[lang][key] !== undefined) return true;
  if (FALLBACK[key] && FALLBACK[key][lang] !== undefined) return true;
  return false;
}
for (const key of allKeys) {
  for (const lang of ['fr', 'en']) {
    if (!resolvable(key, lang)) violations.push(`missing-core   key '${key}' has no ${lang} translation`);
  }
}

// Per-language coverage table (warnings only — non-fr/en gaps fall back to en)
console.log('\n── Per-language coverage (union of ' + allKeys.size + ' keys) ──');
for (const lang of LANGS) {
  let covered = 0;
  const missing = [];
  for (const key of allKeys) {
    if (resolvable(key, lang)) covered++;
    else missing.push(key);
  }
  const pct = Math.round(covered / allKeys.size * 100);
  console.log(`  ${lang.padEnd(4)} ${String(pct).padStart(3)}%  (${covered}/${allKeys.size})`);
  if (missing.length && lang !== 'fr' && lang !== 'en') {
    warnings.push(`coverage ${lang}: ${missing.length} keys fall back to English`);
  }
}

// ── Report ───────────────────────────────────────────────────────────

if (warnings.length) {
  console.log('\n── Warnings (English fallback, non-blocking) ──');
  for (const w of warnings) console.log('  ⚠ ' + w);
}
if (violations.length) {
  console.log('\n── Violations ──');
  for (const v of violations) console.log('  ✗ ' + v);
  console.log(`\n${violations.length} violation(s)${ENFORCE ? ' — failing build' : ' (report mode, not failing)'}`);
  process.exit(ENFORCE ? 1 : 0);
}
console.log('\n✓ No i18n violations');
