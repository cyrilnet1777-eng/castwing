// ── Script AI / processing pipeline ──────────────────────────────────
// Claude API calls, PDF/FDX/text import, script review overlay,
// character merge, prompter line building.

import { S } from './state.js';
import { LINE_TYPE } from './constants.js';
import { showToast, escHtml, gaEvent, yieldToBrowser } from './utils.js';
import { t, detectTextLanguage } from './i18n.js';
import { extractPdfLines, parsePDFScript, mergeCharacterVariants, sanitizeCharacterNames, mergeLabelsWithText, buildNumberedText, parseFdxFile, parsePastedScript, isPdfDialogueRow, autoAssignVoiceByGender, normalizeScreenplayWhitespace } from './pdf-parse.js';
import { initVoiceCountrySelect, applyLocaleVoices, initVoiceGrid, VOICE_LOCALES } from './voices.js';
import { getUserData, isServerAdmin } from './plan-timer.js';
import { persistScriptSnapshotNow, saveToScriptHistory, cwIdbSet } from './idb.js';

// ── Module-level state (mirrors former globals) ─────────────────────
const SCRIPT_INPUT_LINES_PER_FRAME = 28;

// ── Loading overlay / progress ring ─────────────────────────────────

function setLoading(on, m) {
  const e = document.getElementById('loadingOverlay');
  const cb = document.getElementById('loadingCancelBtn');
  if (on) { document.getElementById('loadingMsg').textContent = m || 'Chargement\u2026'; e.classList.add('active'); }
  else { stopFakeProgress(); e.classList.remove('active'); if (cb) cb.classList.remove('active'); }
}

function showLoadingCancel() {
  const cb = document.getElementById('loadingCancelBtn');
  if (cb) { cb.textContent = t('cancelBtn'); cb.classList.add('active'); }
}

let _fakeProgressTimer = null, _fakeProgressPct = 0;
let _progressTarget = 0, _progressCurrent = 0, _progressAnimTimer = null;

function _updateRing(pct) {
  const fg = document.getElementById('ringFg');
  const label = document.getElementById('ringPct');
  if (!fg || !label) return;
  const circ = 2 * Math.PI * 28;
  fg.setAttribute('stroke-dashoffset', String(circ - (circ * pct / 100)));
  label.textContent = pct + '%';
}

function startFakeProgress() {
  stopFakeProgress();
  _fakeProgressPct = 0;
  const spinner = document.getElementById('loadingSpinner');
  const ring = document.getElementById('loadingRing');
  if (spinner) spinner.style.display = 'none';
  if (ring) ring.style.display = '';
  _updateRing(0);
  _fakeProgressTimer = setInterval(() => {
    if (_fakeProgressPct < 30) _fakeProgressPct += Math.random() * 4 + 2;
    else if (_fakeProgressPct < 90) _fakeProgressPct += Math.random() * 1.2 + .3;
    else _fakeProgressPct = Math.min(_fakeProgressPct + .1, 95);
    _updateRing(Math.floor(_fakeProgressPct));
  }, 400);
}

function stopFakeProgress() {
  if (_fakeProgressTimer) { clearInterval(_fakeProgressTimer); _fakeProgressTimer = null; }
  if (_progressAnimTimer) { clearInterval(_progressAnimTimer); _progressAnimTimer = null; }
  _progressCurrent = 0; _progressTarget = 0;
  _updateRing(100);
  const spinner = document.getElementById('loadingSpinner');
  const ring = document.getElementById('loadingRing');
  if (spinner) spinner.style.display = '';
  if (ring) ring.style.display = 'none';
  _fakeProgressPct = 0;
}

function _animateProgressTo(target) {
  _progressTarget = target;
  if (_progressAnimTimer) return;
  _progressAnimTimer = setInterval(function () {
    if (_progressCurrent < _progressTarget) {
      _progressCurrent = Math.min(_progressCurrent + 1, _progressTarget);
      _updateRing(_progressCurrent);
    }
    if (_progressCurrent >= _progressTarget) { clearInterval(_progressAnimTimer); _progressAnimTimer = null; }
  }, 50);
}

function setScriptReviewInteractive(enabled) {
  const ok = document.getElementById('scriptReviewValidateBtn');
  if (ok) ok.disabled = !enabled;
}

// ── Cancel parse ────────────────────────────────────────────────────

function cancelPdfParse() {
  S._pdfParseCancelled = true;
  if (S._pdfParseAbort) { S._pdfParseAbort.abort(); S._pdfParseAbort = null; }
  setLoading(false);
  showToast(t('analysisCancelled'), 2000);
}

// ── File type detection ─────────────────────────────────────────────

function isPdfUploadFile(file) {
  if (!file) return false;
  const name = String(file.name || '');
  const tp = String(file.type || '').toLowerCase().trim();
  if (/\.(pdf|fdx|txt)$/i.test(name)) return true;
  if (tp === 'application/pdf' || tp === 'application/x-pdf') return true;
  if (tp === 'text/plain' || tp === 'text/xml' || tp === 'application/xml') return true;
  if ((tp === 'application/octet-stream' || tp === 'binary/octet-stream') && /\.(pdf|fdx)$/i.test(name)) return true;
  if (!tp && /\.(pdf|fdx|txt)$/i.test(name)) return true;
  return false;
}

// ── Drag & Drop ─────────────────────────────────────────────────────

function initDragDrop(zoneId) {
  const zone = document.getElementById(zoneId); if (!zone || zone.dataset.dd) return; zone.dataset.dd = '1';
  const n = parseInt(zoneId.replace('uploadZone', ''));
  ['dragenter', 'dragover'].forEach(ev => zone.addEventListener(ev, e => { e.preventDefault(); e.stopPropagation(); zone.classList.add('dragover'); }));
  ['dragleave', 'drop'].forEach(ev => zone.addEventListener(ev, e => { e.preventDefault(); e.stopPropagation(); zone.classList.remove('dragover'); }));
  zone.addEventListener('drop', e => {
    const f = e.dataTransfer.files;
    if (!f || !f.length) { showToast('Seuls les PDF sont accept\u00e9s'); return; }
    const file = f[0];
    if (!isPdfUploadFile(file)) { showToast('Seuls les PDF sont accept\u00e9s'); return; }
    const _isLoggedIn = !!(S.cwServerSession.email || (S.userAccess.verified && S.userAccess.email));
    if (!_isLoggedIn) {
      S._pendingFileAfterAuth = { n, file };
      showToast(t('loginToStart') || 'Log in to start your tape', 3000);
      window.openAuthModal();
      return;
    }
    void processPDF(n, file);
  });
}

// ── Claude API: parse screenplay file (multipart) ───────────────────

async function fetchParseScreenplayFile(file) {
  if (!S.cwServerSession.email) { throw new Error('AUTH_REQUIRED'); }
  var ac = new AbortController();
  S._pdfParseAbort = ac;
  try {
    var form = new FormData();
    form.append('file', file);
    var res = await fetch('/api/parse-screenplay', { method: 'POST', credentials: 'same-origin', body: form, signal: ac.signal });
    var data = await res.json().catch(function () { return {}; });
    if (!res.ok) { var msg = data.error || data.message || ('HTTP ' + res.status); throw new Error(typeof msg === 'string' ? msg : JSON.stringify(msg)); }
    var characters = Array.isArray(data.characters) ? data.characters : [];
    var lines = Array.isArray(data.lines) ? data.lines : [];
    if (!lines.length) throw new Error('Reponse serveur vide');
    return { characters: characters, lines: lines };
  } finally {
    if (S._pdfParseAbort === ac) S._pdfParseAbort = null;
  }
}

// ── Claude API: parse script text (JSON) ────────────────────────────

async function fetchClaudeParseScript(pdfText) {
  if (!S.cwServerSession.email) { throw new Error('AUTH_REQUIRED'); }
  var text = String(pdfText || '');
  if (text.trim().length < 8) throw new Error('Texte trop court');
  var ac = new AbortController();
  S._pdfParseAbort = ac;
  try {
    var res = await fetch('/api/claude-parse-script', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ pdfText: text }), signal: ac.signal });
    var data = await res.json().catch(function () { return {}; });
    if (!res.ok) { var msg = data.error || data.message || ('HTTP ' + res.status); throw new Error(typeof msg === 'string' ? msg : JSON.stringify(msg)); }
    if (data.success === false) throw new Error(String(data.error || 'Echec parse'));
    var characters = Array.isArray(data.characters) ? data.characters : [];
    var lines = Array.isArray(data.lines) ? data.lines : [];
    if (!lines.length) throw new Error('Reponse serveur vide');
    return { characters: characters, lines: lines };
  } finally {
    if (S._pdfParseAbort === ac) S._pdfParseAbort = null;
  }
}

// ── Map Claude parse result to pdfScript rows ───────────────────────

function mapClaudeScriptToPdfScript(parsed) {
  const lines = parsed.lines || [];
  const out = [];
  for (const item of lines) {
    const text = String(item.text || '').trim();
    if (!text) continue;
    const typ = String(item.type || 'action').toLowerCase();
    const character = item.character != null && String(item.character).trim() !== '' ? String(item.character).trim() : null;
    const spoken = item.isSpoken !== false;
    if (typ === 'dialogue' && character) {
      out.push({ kind: LINE_TYPE.DIALOGUE, char: character, line: text, isStageDirection: false, isSpoken: spoken, parenthetical: null });
      continue;
    }
    if (typ === 'slug') {
      out.push({ kind: LINE_TYPE.SLUG, char: '', line: text, isStageDirection: false, isSpoken: false, parenthetical: null });
      continue;
    }
    out.push({ kind: LINE_TYPE.ACTION, char: '', line: text, isStageDirection: true, isSpoken: false, parenthetical: null });
  }
  return window.mergeConsecutiveDialogues ? window.mergeConsecutiveDialogues(out) : out;
}

// ── Validate characters from Claude response ────────────────────────

function applyValidatedCharactersFromParsed(parsed) {
  const chars = [...(parsed.characters || [])].map(c => String(c || '').trim()).filter(Boolean);
  const extras = ['FANT\u00d4MAS', 'MAUD BELTHAM', 'GEORGES BELTHAM'];
  const normFn = window.normCharKeyForWhitelist || (s => String(s || '').toUpperCase().trim());
  for (const x of extras) {
    if (!chars.some(c => normFn(c) === normFn(x))) chars.push(x);
  }
  S.scriptValidatedCharKeys = new Set(chars.map(c => normFn(c)));
  try { if (typeof window !== 'undefined') window.__lastValidatedChars = chars.slice(); } catch (_e) {}
}

// ── Label script (server API) ───────────────────────────────────────

async function fetchLabelScript(numberedText) {
  if (!S.cwServerSession.email) { try { await window.fetchServerSession(); } catch (_e) {} }
  if (!S.cwServerSession.email && !(S.userAccess.verified && S.userAccess.email)) { throw new Error('AUTH_REQUIRED'); }
  var maxRetries = 3;
  for (var attempt = 0; attempt < maxRetries; attempt++) {
    var ac = new AbortController();
    S._pdfParseAbort = ac;
    try {
      var res = await fetch('/api/label-script', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ numberedText: numberedText }), signal: ac.signal });
      var data = await res.json().catch(function () { return {}; });
      if (res.status === 503 && attempt < maxRetries - 1) {
        await new Promise(function (r) { setTimeout(r, 2000 * (attempt + 1)); });
        continue;
      }
      if (!res.ok) { var msg = data.error || data.message || ('HTTP ' + res.status); throw new Error(typeof msg === 'string' ? msg : JSON.stringify(msg)); }
      if (data.success === false) throw new Error(String(data.error || 'Labeling failed'));
      return data;
    } catch (e) {
      if (e.name === 'AbortError') throw e;
      if (attempt < maxRetries - 1 && e.message && e.message.indexOf('Failed to fetch') !== -1) {
        await new Promise(function (r) { setTimeout(r, 2000 * (attempt + 1)); });
        continue;
      }
      throw e;
    } finally {
      if (S._pdfParseAbort === ac) S._pdfParseAbort = null;
    }
  }
}

// ── Extract + label pipeline (chunked) ──────────────────────────────

async function parseViaExtractAndLabel(file) {
  console.log('Extracting text from PDF...');
  var lines = await extractPdfLines(file);
  var fullBody = JSON.stringify({ numberedText: buildNumberedText(lines) });
  console.log('Extracted ' + lines.length + ' lines (body ~' + Math.round(fullBody.length / 1024) + 'KB / ' + fullBody.length + ' bytes), sending for labeling...');
  if (!lines.length) throw new Error('Could not extract text from PDF');
  var MAX_LINES = 80;
  var chunks = [];
  for (var start = 0; start < lines.length; start += MAX_LINES) {
    var end = Math.min(start + MAX_LINES, lines.length);
    var chunkLines = lines.slice(start, end);
    var chunkNumbered = chunkLines.map(function (l, i) { return (start + i + 1) + ': ' + l; }).join('\n');
    chunks.push(chunkNumbered);
  }
  console.log('Labeling ' + chunks.length + ' chunks (2 at a time)...');
  if (_fakeProgressTimer) { clearInterval(_fakeProgressTimer); _fakeProgressTimer = null; }
  _progressCurrent = 5; _updateRing(5);
  var allLabels = [];
  var allChars = [];
  var CONCURRENT = 2;
  var chunksCompleted = 0;
  for (var ci = 0; ci < chunks.length; ci += CONCURRENT) {
    if (S._pdfParseCancelled) throw new Error('Cancelled');
    var batch = chunks.slice(ci, ci + CONCURRENT);
    var results = await Promise.all(batch.map(function (c) { return fetchLabelScript(c); }));
    for (var i = 0; i < results.length; i++) {
      var labs = Array.isArray(results[i].labels) ? results[i].labels : [];
      allLabels = allLabels.concat(labs);
      var chars = Array.isArray(results[i].characters) ? results[i].characters : [];
      chars.forEach(function (c) { if (allChars.indexOf(c) === -1) allChars.push(c); });
    }
    chunksCompleted += batch.length;
    _animateProgressTo(Math.min(95, Math.floor(5 + 90 * chunksCompleted / chunks.length)));
  }
  return mergeLabelsWithText(lines, { characters: allChars, labels: allLabels });
}

// ── Debug mirror ────────────────────────────────────────────────────

function syncPdfScriptDebugMirror() {
  try {
    window.pdfScript = Array.isArray(S.pdfScript) ? S.pdfScript : [];
  } catch (_e) {}
}

// ── Async whitespace normalisation (yields for large texts) ─────────

async function normalizeScreenplayWhitespaceAsync(text) {
  if (String(text || '').length < 100000) return normalizeScreenplayWhitespace(text);
  const t_ = String(text || '').replace(/\u00A0/g, ' ').replace(/\r\n?/g, '\n');
  const lines = t_.split('\n');
  const out = [];
  let blank = 0;
  for (let i = 0; i < lines.length; i++) {
    if (i > 0 && i % 5000 === 0) {
      await yieldToBrowser();
      if (S._pdfParseCancelled) break;
    }
    const line = lines[i];
    const x = line.replace(/[ \t]+$/, '');
    if (!x.trim()) { if (blank < 1) out.push(''); blank++; continue; }
    blank = 0;
    out.push(x.trim());
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

// ── Progressive textarea fill ───────────────────────────────────────

async function fillScriptInputProgressive(n, fullNorm) {
  const ta = document.getElementById('scriptInput' + n);
  if (!ta) return;
  const lines = fullNorm.split('\n');
  if (lines.length <= SCRIPT_INPUT_LINES_PER_FRAME * 4 && fullNorm.length < 36000) {
    ta.value = fullNorm;
    return;
  }
  ta.value = '';
  let acc = '';
  for (let i = 0; i < lines.length; i += SCRIPT_INPUT_LINES_PER_FRAME) {
    if (i > 0) await yieldToBrowser();
    if (S._pdfParseCancelled) return;
    const chunk = lines.slice(i, i + SCRIPT_INPUT_LINES_PER_FRAME);
    acc += (acc ? '\n' : '') + chunk.join('\n');
    ta.value = acc;
  }
}

// ── Main PDF processing entry point ─────────────────────────────────

async function processPDF(n, file) {
  S.currentScriptName = file.name || 'PDF';
  S.takeNumber = 0;
  S._pdfParseCancelled = false;
  try { if (typeof window !== 'undefined') window.__parserDebugLogs = []; } catch (_e) {}
  setLoading(true, t('analyzingScript'));
  showLoadingCancel();
  startFakeProgress();
  try {
    S.scriptValidatedCharKeys = null;
    if (S._pdfParseCancelled) return;
    var parsed = await parseViaExtractAndLabel(file);
    S.scriptRawText = (parsed.lines || []).map(l => String(l.text || '').trim()).filter(Boolean).join('\n');
    S.pdfScript = mergeCharacterVariants(mapClaudeScriptToPdfScript(parsed));
    applyValidatedCharactersFromParsed(parsed);
    const detectedLang = detectTextLanguage(S.scriptRawText);
    if (!S.pdfScript || !S.pdfScript.length) {
      S.pdfScript = [];
      syncPdfScriptDebugMirror();
      showToast(t('analysisEmpty'), 5000);
      finishPdfSetupUi(n, S.scriptRawText, typeof window !== 'undefined' && window.__lastValidatedChars ? window.__lastValidatedChars : [], detectedLang);
      void fillScriptInputProgressive(n, S.scriptRawText);
      return;
    }
    syncPdfScriptDebugMirror();
    if (detectedLang && VOICE_LOCALES.some(l => l.id === detectedLang)) {
      S.lockedVoiceLocale = detectedLang;
      applyLocaleVoices(detectedLang, false);
      initVoiceCountrySelect();
      initVoiceGrid();
    }
    finishPdfSetupUi(n, S.scriptRawText, typeof window !== 'undefined' && window.__lastValidatedChars ? window.__lastValidatedChars : [], detectedLang);
    void fillScriptInputProgressive(n, S.scriptRawText);
  } catch (e) {
    console.error('PDF parse error:', e);
    if (e && e.message === 'AUTH_REQUIRED') { showToast(t('loginRequired'), 5000); return; }
    showToast(t('analysisFailed') + ': ' + (e && e.message ? e.message : 'check ANTHROPIC_API_KEY'), 6500);
    S.pdfScript = [];
    syncPdfScriptDebugMirror();
  }
  setLoading(false);
}

// ── File input handler (PDF / FDX / TXT) ────────────────────────────

async function handlePDFInput(n, input) {
  const f = input.files[0]; if (!f) return;
  // Auth gate: ensure session is loaded, then require login before analyzing
  if (!S.cwServerSession.email) { try { await window.fetchServerSession(); } catch (_e) {} }
  const _isLoggedIn = !!(S.cwServerSession.email || (S.userAccess.verified && S.userAccess.email));
  if (!_isLoggedIn) {
    S._pendingFileAfterAuth = { n, file: f };
    showToast(t('loginToStart') || 'Log in to start your tape', 3000);
    window.openAuthModal();
    input.value = '';
    return;
  }
  gaEvent('import_script', { method: 'file', file_type: f.name.split('.').pop() });
  if (!isPdfUploadFile(f)) { showToast('Unsupported file format', 4000); input.value = ''; return; }
  const name = String(f.name || '').toLowerCase();
  if (name.endsWith('.fdx')) {
    try {
      const text = await f.text();
      const parsed = parseFdxFile(text);
      if (!parsed.lines.length) { showToast('No dialogue found in FDX file'); return; }
      S.scriptRawText = parsed.lines.map(l => l.character ? (l.character + ': ' + l.text) : l.text).join('\n');
      S.pdfScript = parsed.lines.map(l => ({
        kind: l.type === 'dialogue' ? 'dialogue' : (l.type === 'slug' ? 'slug' : 'action'),
        char: l.character || '', line: l.text, isStageDirection: l.type !== 'dialogue', isSpoken: l.type === 'dialogue', parenthetical: null
      }));
      S.pdfScript = mergeCharacterVariants(S.pdfScript);
      applyValidatedCharactersFromParsed(parsed);
      const detectedLang = detectTextLanguage(S.scriptRawText);
      S.currentScriptName = f.name;
      finishPdfSetupUi(n, S.scriptRawText, parsed.characters, detectedLang);
    } catch (e) { showToast('Error reading FDX: ' + e.message); }
    return;
  }
  if (name.endsWith('.txt')) {
    try {
      const text = await f.text();
      const si = document.getElementById('scriptInput' + n);
      if (si) { si.value = text; si.style.display = 'block'; }
      S.currentScriptName = f.name;
      processTextImport(n);
    } catch (e) { showToast('Error reading file'); }
    return;
  }
  await processPDF(n, f);
}

// ── Open file picker ────────────────────────────────────────────────

function openPdfPicker(n) {
  const el = document.getElementById('pdfInput' + n);
  if (el) el.value = '';
  if (el) el.click();
}

// ── New script reset ────────────────────────────────────────────────

async function newScriptReset(n) {
  const { clearScriptCache } = await import('./idb.js');
  await clearScriptCache();
  clearPDF(n);
}

// ── Script review overlay ───────────────────────────────────────────

function estimateParseConfidence(rows) {
  if (!rows || !rows.length) return 0;
  const d = rows.filter(r => r && r.kind === LINE_TYPE.DIALOGUE).length;
  const a = rows.filter(r => r && r.kind === LINE_TYPE.ACTION).length;
  const ratio = d / Math.max(1, d + a);
  return Math.round(55 + Math.min(40, ratio * 45));
}

function normalizeReviewBlockText(t_) {
  return String(t_ || '').replace(/\u00A0/g, ' ').replace(/\s+/g, ' ').trim();
}

function deepClonePdfScript(arr) {
  try {
    if (typeof structuredClone === 'function') return structuredClone(Array.isArray(arr) ? arr : []);
  } catch (_e) {}
  try { return JSON.parse(JSON.stringify(Array.isArray(arr) ? arr : [])); } catch (_e) {
    return (Array.isArray(arr) ? arr : []).map(r => (r && typeof r === 'object' ? { ...r } : r));
  }
}

function isPdfScriptValidationBroken(next, snap) {
  if (!next || !next.length) return true;
  const anyLine = next.some(r => r && String(r.line || '').trim().length > 0);
  if (!anyLine) return true;
  const dialNext = next.filter(r => r && r.kind === LINE_TYPE.DIALOGUE).length;
  const dialSnap = (snap || []).filter(r => r && r.kind === LINE_TYPE.DIALOGUE).length;
  if (dialSnap >= 4 && dialNext === 0) return true;
  return false;
}

function buildScriptReviewRowEl(row, idx) {
  const wrap = document.createElement('div');
  wrap.className = 'sr-row' + (row.kind === LINE_TYPE.SLUG ? ' slug' : '');
  wrap.dataset.idx = String(idx);
  const sel = document.createElement('select'); sel.className = 'sr-kind';
  [['slug', 'Slug'], ['dialogue', 'R\u00e9plique'], ['action', 'Action']].forEach(([v, l]) => { const o = document.createElement('option'); o.value = v; o.textContent = l; if ((row.kind || '') === v) o.selected = true; sel.appendChild(o); });
  const mid = document.createElement('div'); mid.style.gridColumn = '2'; mid.style.display = 'flex'; mid.style.flexDirection = 'column'; mid.style.gap = '4px';
  const inp = document.createElement('input'); inp.className = 'sr-char'; inp.placeholder = 'Personnage'; inp.value = (row.kind === LINE_TYPE.DIALOGUE && (row.char || '')) ? row.char : ''; inp.toggleAttribute('disabled', row.kind !== LINE_TYPE.DIALOGUE);
  const ta = document.createElement('textarea'); ta.className = 'sr-text'; ta.rows = row.line && row.line.length > 90 ? 3 : 2; ta.value = row.line || '';
  mid.appendChild(inp); mid.appendChild(ta);
  const tools = document.createElement('div'); tools.className = 'sr-tools';
  const flag = document.createElement('label'); flag.className = 'sr-flag';
  const cb = document.createElement('input'); cb.type = 'checkbox'; cb.className = 'sr-stage'; cb.checked = !!(row.isStageDirection || row.kind === LINE_TYPE.ACTION);
  flag.appendChild(cb); flag.appendChild(document.createTextNode(' Didascalie'));
  const mergeBtn = document.createElement('button'); mergeBtn.type = 'button'; mergeBtn.textContent = '\u2193 Fusionner'; mergeBtn.onclick = () => scriptReviewMergeDown(wrap);
  tools.appendChild(flag); tools.appendChild(mergeBtn);
  wrap.appendChild(sel); wrap.appendChild(mid); wrap.appendChild(tools);
  sel.addEventListener('change', () => {
    const isD = sel.value === 'dialogue';
    inp.disabled = !isD;
    if (!isD) inp.value = '';
  });
  return wrap;
}

function pdfScriptToReviewHtml(script) {
  const frag = document.createDocumentFragment();
  if (!script || !script.length) {
    const d = document.createElement('div'); d.className = 'sr-row'; d.innerHTML = '<span class="sr-kind">\u2014</span><textarea class="sr-text" placeholder="' + escHtml(t('pasteScriptLabel')) + '"></textarea><span></span>'; frag.appendChild(d); return frag;
  }
  script.forEach((row, idx) => frag.appendChild(buildScriptReviewRowEl(row, idx)));
  return frag;
}

function collectPdfScriptFromReviewDom() {
  const wrap = document.getElementById('scriptReviewList');
  if (!wrap) return [];
  const rows = wrap.querySelectorAll('.sr-row');
  const out = [];
  try {
    rows.forEach(row => {
      if (!row) return;
      const sel = row.querySelector?.('.sr-kind');
      const kind = (sel && sel.value) || 'action';
      const charEl = row.querySelector?.('.sr-char');
      const textEl = row.querySelector?.('.sr-text');
      const stageEl = row.querySelector?.('.sr-stage');
      const char_ = (charEl && charEl.value || '').trim();
      const text = normalizeReviewBlockText(textEl && textEl.value);
      const stage = !!(stageEl && stageEl.checked);
      if (!text) return;
      if (kind === 'slug') out.push({ kind: 'slug', char: '', line: text, isStageDirection: false, isSpoken: false, parenthetical: null });
      else if (kind === 'action' || stage) out.push({ kind: 'action', char: '', line: text, isStageDirection: true, isSpoken: false, parenthetical: null });
      else out.push({ kind: 'dialogue', char: char_ || '?', line: text, isStageDirection: false, isSpoken: true, parenthetical: null });
    });
  } catch (e) {
    console.warn('[review] collectPdfScriptFromReviewDom', e);
    throw e;
  }
  const mergeFn = window.mergeConsecutiveDialogues || (x => x);
  return mergeFn(out);
}

function scriptReviewMergeDown(rowEl) {
  const list = document.getElementById('scriptReviewList');
  const prevScroll = list ? list.scrollTop : 0;
  const next = rowEl && rowEl.nextElementSibling;
  if (!next || !next.classList.contains('sr-row')) return;
  const ta = rowEl.querySelector('.sr-text');
  const nta = next.querySelector('.sr-text');
  if (ta && nta) { ta.value = normalizeReviewBlockText(ta.value + ' ' + nta.value); ta.rows = Math.min(12, Math.max(2, Math.ceil(ta.value.length / 55))); }
  next.remove();
  rowEl.classList.remove('sr-auto-accepted');
  if (list) requestAnimationFrame(() => { list.scrollTop = Math.min(prevScroll, Math.max(0, list.scrollHeight - list.clientHeight)); });
}

function openOptionalScriptReview(n) {
  const ta = document.getElementById('scriptInput' + n);
  const norm = normalizeScreenplayWhitespace((ta && ta.value) || S.scriptRawText || '');
  const detectedLang = detectTextLanguage(norm);
  openScriptReviewOverlay(n, norm || '', (typeof window !== 'undefined' && Array.isArray(window.__lastValidatedChars) ? window.__lastValidatedChars : []), detectedLang, estimateParseConfidence(S.pdfScript));
}

function openScriptReviewOverlay(n, normText, validChars, detectedLang, confidence) {
  setLoading(false);
  const ov = document.getElementById('scriptReviewOverlay');
  const list = document.getElementById('scriptReviewList');
  const meta = document.getElementById('scriptReviewMeta');
  if (!ov || !list) return;
  ov.classList.remove('sr-focus-mode');
  S._scriptReviewCtx = { n, rawNorm: normText, validChars: validChars || [], detectedLang: detectedLang || '' };
  list.innerHTML = '';
  list.appendChild(pdfScriptToReviewHtml(S.pdfScript));
  if (meta) {
    const d = (S.pdfScript || []).filter(r => r && r.kind === LINE_TYPE.DIALOGUE).length;
    meta.textContent = (typeof confidence === 'number' && confidence > 0 ? '~' + confidence + '% \u00b7 ' : '') + d + ' dialogues \u00b7 ' + (S.pdfScript || []).length + ' lines';
  }
  ov.classList.add('active');
  ov.setAttribute('aria-hidden', 'false');
  setScriptReviewInteractive(true);
}

function closeScriptReview(applyEdits) {
  const ov = document.getElementById('scriptReviewOverlay');
  if (!ov) return;
  if (!applyEdits) {
    S._bgRefinementToken++;
  }
  if (applyEdits) {
    const reviewSnapshot = deepClonePdfScript(S.pdfScript);
    let collected = [];
    try {
      collected = collectPdfScriptFromReviewDom();
    } catch (err) {
      console.warn('[review] collect failed', err);
      showToast('Form read error \u2014 try again', 3800);
      return;
    }
    const sanitizeDVA = window.sanitizeDialogueVsAction || (x => x);
    const mergeFn = window.mergeConsecutiveDialogues || (x => x);
    const merged = collected && collected.length
      ? mergeFn(sanitizeDVA(mergeCharacterVariants(sanitizeCharacterNames(collected))))
      : [];
    if (isPdfScriptValidationBroken(merged, reviewSnapshot)) {
      S.pdfScript = reviewSnapshot;
      syncPdfScriptDebugMirror();
      showToast('R\u00e9sultat invalide \u2014 script restaur\u00e9', 4200);
      return;
    }
    S.pdfScript = merged;
    syncPdfScriptDebugMirror();
  }
  ov.classList.remove('active', 'sr-focus-mode');
  ov.setAttribute('aria-hidden', 'true');
  const ctx = S._scriptReviewCtx; if (!ctx) return;
  finishPdfSetupUi(ctx.n, ctx.rawNorm, ctx.validChars, ctx.detectedLang);
  S._scriptReviewCtx = null;
}

// ── AI character merge (calls /api/merge-characters) ────────────────

async function aiMergeCharacters(n) {
  const chars = getChars(); if (chars.length < 3) return;
  function removeAccents(s) { return s.normalize('NFD').replace(/[\u0300-\u036f]/g, ''); }
  function editDist(a, b) { a = a.toUpperCase(); b = b.toUpperCase(); if (a === b) return 0; const m = a.length, nn = b.length; const d = Array.from({ length: m + 1 }, (_, i) => i); for (let j = 1; j <= nn; j++) { let prev = d[0]; d[0] = j; for (let i = 1; i <= m; i++) { const tmp = d[i]; d[i] = a[i - 1] === b[j - 1] ? prev : 1 + Math.min(prev, d[i], d[i - 1]); prev = tmp; } } return d[m]; }
  const STOP_WORDS = new Set(['LE', 'LA', 'LES', 'DE', 'DU', 'DES', 'UN', 'UNE', 'L', 'D', 'A', 'AU', 'AUX']);
  function sigWords(s) { return removeAccents(s).toUpperCase().split(/\s+/).filter(w => !STOP_WORDS.has(w) && w.length > 1); }
  function sharesSigWord(a, b) { const wa = sigWords(a), wb = sigWords(b); return wa.some(w => wb.includes(w)); }
  const candidates = [];
  for (let i = 0; i < chars.length; i++) {
    for (let j = i + 1; j < chars.length; j++) {
      const a = removeAccents(chars[i].char), b = removeAccents(chars[j].char);
      const dist = editDist(a, b);
      const shorter = Math.min(a.length, b.length);
      const isCandidate = dist <= 2
        || (shorter >= 4 && (a.includes(b) || b.includes(a)))
        || (sharesSigWord(chars[i].char, chars[j].char) && (a.length >= 4 || b.length >= 4));
      if (isCandidate) {
        candidates.push([chars[i].char, chars[j].char, chars[i].count, chars[j].count]);
      }
    }
  }
  if (!candidates.length) return;
  console.info('[aiMerge] asking AI about', candidates.length, 'candidate pairs');
  try {
    const res = await fetch('/api/merge-characters', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ candidates }) });
    const data = await res.json();
    if (!data.merges || !data.merges.length) return;
    const renameMap = {};
    for (const m of data.merges) {
      if (!m.same) continue;
      const pair = candidates[m.pair - 1]; if (!pair) continue;
      const canonical = m.canonical || pair[0];
      const other = canonical === pair[0] ? pair[1] : pair[0];
      renameMap[other] = canonical;
    }
    if (!Object.keys(renameMap).length) return;
    let merged = 0;
    S.pdfScript = S.pdfScript.map(row => {
      if (!row || row.kind !== 'dialogue' || !row.char || !renameMap[row.char]) return row;
      merged++;
      return Object.assign({}, row, { char: renameMap[row.char] });
    });
    console.info('[aiMerge] merged ' + merged + ' lines, renames:', renameMap);
    syncPdfScriptDebugMirror();
    renderChars(n, getChars());
    showToast('Merged ' + Object.keys(renameMap).length + ' character variants', 3000);
  } catch (e) { console.warn('[aiMerge] failed', e); }
}

// ── Finish PDF setup UI ─────────────────────────────────────────────

function finishPdfSetupUi(n, rawText, validChars, detectedLang) {
  syncPdfScriptDebugMirror();
  S.selectedChar = null; S.soloPartnerMode = 'all'; S.soloPartnerChar = null;
  const chars = getChars();
  document.getElementById('uploadZone' + n).style.display = 'none';
  document.getElementById('uploadOk' + n).style.display = 'flex';
  const fname = document.getElementById('fileName' + n); if (fname) fname.textContent = S.currentScriptName || 'Script';
  if (S.pdfScript.length > 0 && chars.length > 0) {
    renderChars(n, chars);
    document.getElementById('charSection' + n).style.display = 'block';
    setTimeout(() => aiMergeCharacters(n), 500);
    document.getElementById('setupStatus' + n).textContent = S.pdfScript.length + ' lines \u00b7 ' + (S.pdfScript.filter(r => r && r.kind === LINE_TYPE.DIALOGUE).length) + ' dialogues';
    const orb = document.getElementById('optionalReviewBtn' + n);
    if (orb) orb.style.display = 'block';
    if (detectedLang && VOICE_LOCALES.some(l => l.id === detectedLang)) { S.lockedVoiceLocale = detectedLang; applyLocaleVoices(detectedLang, false); initVoiceCountrySelect(); initVoiceGrid(); }
    if (n === 1) showToast(chars.length + ' roles found \u2014 ' + t('myCharacterLabel'), 4200);
    persistScriptSnapshotNow();
    saveToScriptHistory();
  } else {
    S.pdfScript = [];
    syncPdfScriptDebugMirror();
    document.getElementById('charSection' + n).style.display = 'none';
    document.getElementById('scriptInput' + n).value = rawText || '';
    document.getElementById('setupStatus' + n).textContent = t('pdfImportedRaw');
    const orb0 = document.getElementById('optionalReviewBtn' + n);
    if (orb0) orb0.style.display = 'none';
    if (detectedLang && VOICE_LOCALES.some(l => l.id === detectedLang)) { S.lockedVoiceLocale = detectedLang; applyLocaleVoices(detectedLang, false); initVoiceCountrySelect(); initVoiceGrid(); }
    showToast('Peu de dialogue d\u00e9tect\u00e9 \u2014 v\u00e9rifie ou colle un autre fichier', 4500);
  }
}

// ── Imported script pipeline (text -> Claude -> pdfScript) ──────────

async function runImportedScriptPipeline(n, normText, displayName) {
  S._fastFullParseToken++;
  S.currentScriptName = displayName || S.currentScriptName || 'Script';
  S.scriptValidatedCharKeys = null;
  const workingNorm = String(normText || '');
  S.scriptRawText = workingNorm;
  setLoading(true, t('analyzingScript'));
  let parsed;
  try {
    parsed = await fetchClaudeParseScript(workingNorm);
  } catch (e) {
    console.error(e);
    showToast(String(e.message || e || t('analysisFailed')), 5000);
    S.pdfScript = [];
    syncPdfScriptDebugMirror();
    setLoading(false);
    finishPdfSetupUi(n, workingNorm, [], detectTextLanguage(workingNorm));
    return;
  }
  setLoading(false);
  S.pdfScript = mergeCharacterVariants(mapClaudeScriptToPdfScript(parsed));
  applyValidatedCharactersFromParsed(parsed);
  const validatedCharacters = typeof window !== 'undefined' && Array.isArray(window.__lastValidatedChars) ? window.__lastValidatedChars.slice() : [];
  const detectedLang = detectTextLanguage(workingNorm);
  if (!S.pdfScript || !S.pdfScript.length) {
    S.pdfScript = [];
    syncPdfScriptDebugMirror();
  } else {
    syncPdfScriptDebugMirror();
  }
  if (detectedLang && VOICE_LOCALES.some(l => l.id === detectedLang)) {
    S.lockedVoiceLocale = detectedLang;
    applyLocaleVoices(detectedLang, false);
    initVoiceCountrySelect();
    initVoiceGrid();
  }
  finishPdfSetupUi(n, workingNorm, validatedCharacters, detectedLang);
}

// ── Text import (paste) ─────────────────────────────────────────────

async function processTextImport(n) {
  gaEvent('import_script', { method: 'paste' });
  const raw = document.getElementById('scriptInput' + n).value;
  S.scriptRawText = raw;
  const norm = await normalizeScreenplayWhitespaceAsync(raw);
  if (norm.length < 24) { showToast('Colle au moins quelques lignes de sc\u00e9nario', 3500); return; }
  S.takeNumber = 0;
  S.currentScriptName = 'Texte coll\u00e9';
  try {
    await runImportedScriptPipeline(n, norm, 'Texte coll\u00e9');
    void fillScriptInputProgressive(n, S.scriptRawText || norm);
  } catch (e) {
    console.error(e);
    showToast('Text import error', 4000);
  }
}

// ── Character helpers ───────────────────────────────────────────────

function getChars() {
  const c = {};
  for (const row of S.pdfScript) { if (!row || row.kind !== LINE_TYPE.DIALOGUE || !row.char) continue; c[row.char] = (c[row.char] || 0) + 1; }
  return Object.entries(c).sort((a, b) => b[1] - a[1]).map(([char, count]) => ({ char, count }));
}

function pickDefaultRehearsalCharacter() {
  const chars = getChars();
  return chars && chars.length ? chars[0].char : null;
}

// ── Render character grid ───────────────────────────────────────────

function renderChars(n, chars) {
  const g = document.getElementById('charGrid' + n); g.innerHTML = '';
  chars.forEach(({ char, count }) => {
    const el = document.createElement('div'); el.className = 'char-item';
    el.innerHTML = `${escHtml(char)}<span class="cc">(${count})</span>`;
    el.onclick = () => {
      S.selectedChar = char; S.soloPartnerMode = 'all'; S.soloPartnerChar = null;
      g.querySelectorAll('.char-item').forEach(c => c.classList.remove('selected')); el.classList.add('selected');
      showToast(char);
      if (n === 1) renderPartnerAssignment(1);
      const cb = document.getElementById('importContinueBtn'); if (cb) cb.style.display = 'block';
    };
    g.appendChild(el);
  });
  if (n === 1) renderPartnerAssignment(1);
}

// ── Partner assignment grid ─────────────────────────────────────────

function renderPartnerAssignment(n) {
  if (n !== 1) return;
  const wrap = document.getElementById('partnerAssignWrap1');
  const grid = document.getElementById('partnerCharGrid1');
  const hint = document.getElementById('partnerAssignHint1');
  if (!wrap || !grid || !hint) return;
  if (!S.pdfScript.length || !S.selectedChar) { wrap.style.display = 'none'; return; }
  const otherChars = [...new Set(S.pdfScript.filter(s => s && s.kind === LINE_TYPE.DIALOGUE && s.char).map(s => s.char))].filter(c => c !== S.selectedChar);
  wrap.style.display = 'block';
  grid.innerHTML = '';
  const allEl = document.createElement('div');
  allEl.className = 'char-item partner-all-chip' + (S.soloPartnerMode === 'all' ? ' selected' : '');
  allEl.textContent = t('partnerAllOthersBtn');
  allEl.onclick = () => { S.soloPartnerMode = 'all'; S.soloPartnerChar = null; renderPartnerAssignment(1); };
  grid.appendChild(allEl);
  otherChars.forEach(ch => {
    const el = document.createElement('div');
    el.className = 'char-item' + (S.soloPartnerMode === 'single' && S.soloPartnerChar === ch ? ' selected' : '');
    const cnt = S.pdfScript.filter(s => s && s.kind === LINE_TYPE.DIALOGUE && s.char === ch).length;
    el.innerHTML = `${escHtml(ch)}<span class="cc">(${cnt})</span>`;
    el.onclick = () => { S.soloPartnerMode = 'single'; S.soloPartnerChar = ch; renderPartnerAssignment(1); };
    grid.appendChild(el);
  });
  hint.textContent = S.soloPartnerMode === 'all' ? t('partnerHintAll') : t('partnerHintDuo');
}

// ── Clear PDF / reset ───────────────────────────────────────────────

function clearPDF(n) {
  const cwSessionStateClearFn = window.cwSessionStateClear || (() => {});
  const clearPersistedFn = window.clearPersistedScriptMemory || (async () => {});
  const renderHistFn = window.renderScriptHistory || (() => {});
  window.__cwSessionActive = false;
  cwSessionStateClearFn('clearPDF');
  S.pdfScript = []; S.scriptRawText = ''; S._bgRefinementToken++; S._fastFullParseToken++;
  syncPdfScriptDebugMirror();
  clearPersistedFn().catch(() => {});
  S.selectedChar = null; S.soloPartnerMode = 'all'; S.soloPartnerChar = null; S.lockedVoiceLocale = '';
  initVoiceCountrySelect();
  document.getElementById('uploadZone' + n).style.display = 'block';
  document.getElementById('uploadOk' + n).style.display = 'none';
  document.getElementById('charSection' + n).style.display = 'none';
  if (n === 1) { const w = document.getElementById('partnerAssignWrap1'); if (w) w.style.display = 'none'; }
  document.getElementById('setupStatus' + n).textContent = '';
  document.getElementById('pdfInput' + n).value = '';
  const orb = document.getElementById('optionalReviewBtn' + n); if (orb) orb.style.display = 'none';
  const ta = document.getElementById('scriptInput' + n); if (ta) ta.value = '';
  const cb = document.getElementById('importContinueBtn'); if (cb) cb.style.display = 'none';
  renderHistFn();
}

// ── Prompter: build lines ───────────────────────────────────────────

function buildLines(n) {
  const _dials = S.pdfScript.filter(isPdfDialogueRow);
  const _acts = S.pdfScript.filter(s => s.kind === LINE_TYPE.ACTION || s.kind === 'action');
  const _slugs = S.pdfScript.filter(s => s.kind === LINE_TYPE.SLUG || s.kind === 'slug');
  console.info('[buildLines] total=' + S.pdfScript.length + ' dialogues=' + _dials.length + ' actions=' + _acts.length + ' slugs=' + _slugs.length + ' selectedChar=' + S.selectedChar);
  if (_dials.length > 0) console.info('[buildLines] first3dialogues=' + _dials.slice(0, 3).map(s => s.char + ': ' + s.line.slice(0, 40)).join(' / '));
  else console.warn('[buildLines] ZERO DIALOGUES \u2014 all lines are action/context, AI will never speak');
  if (S.pdfScript.length > 0 && S.selectedChar) {
    let rows = S.pdfScript;
    const selNorm = (S.selectedChar || '').toUpperCase().trim();
    if (n === 1 && S.soloPartnerMode === 'single' && S.soloPartnerChar) {
      const keepNorm = new Set([selNorm, (S.soloPartnerChar || '').toUpperCase().trim()]);
      rows = S.pdfScript.filter(s => !isPdfDialogueRow(s) || keepNorm.has((s.char || '').toUpperCase().trim()));
    }
    const _result = rows.map(s => {
      const isDial = isPdfDialogueRow(s);
      const isActor = isDial && (s.char || '').toUpperCase().trim() === selNorm;
      const spoken = isDial && (s.isSpoken !== false);
      return { text: s.line, type: isDial ? (isActor ? 'actor' : 'partner') : 'context', char: s.char || '', kind: isDial ? (s.kind || LINE_TYPE.DIALOGUE) : (s.kind || LINE_TYPE.ACTION), isStageDirection: !!s.isStageDirection, isSpoken: spoken, parenthetical: s.parenthetical || null };
    });
    const _a = _result.filter(r => r.type === 'actor').length; const _p = _result.filter(r => r.type === 'partner').length; const _c = _result.filter(r => r.type === 'context').length; const _sp = _result.filter(r => r.isSpoken).length;
    console.info('[buildLines] OUTPUT actors=' + _a + ' partners=' + _p + ' context=' + _c + ' spoken=' + _sp + ' firstSpokenIdx=' + _result.findIndex(r => r.isSpoken));
    return _result;
  }
  if (S.pdfScript.length > 0) return S.pdfScript.map(s => { const isDial = isPdfDialogueRow(s); const spoken = isDial && (s.isSpoken !== false); return { text: isDial && s.char ? (s.char + ': ' + s.line) : s.line, type: isDial ? 'actor' : 'context', char: s.char || '', kind: isDial ? (s.kind || LINE_TYPE.DIALOGUE) : (s.kind || LINE_TYPE.ACTION), isStageDirection: !!s.isStageDirection, isSpoken: spoken, parenthetical: s.parenthetical || null }; });
  const rawText = document.getElementById('scriptInput' + n).value; if (!rawText || !rawText.trim()) return [];
  const simpleRx = /^(PARTENAIRE|PARTNER|P|MOI|ME|ACTEUR|ACTOR|A)\s*:/i;
  const rawLines = rawText.split('\n').filter(l => l.trim());
  const hasSimple = rawLines.some(l => simpleRx.test(l.trim()));
  if (hasSimple) {
    return rawLines.map(l => { const tr = l.trim(); const isP = /^(PARTENAIRE|PARTNER|P)\s*:/i.test(tr); const clean = simpleRx.test(tr) ? tr.replace(/^[^:]+:\s*/, '') : tr; return { text: clean, type: isP ? 'partner' : 'actor' }; });
  }
  const hasPastedFn = window.hasPastedDialogueStructure || (() => false);
  if (hasPastedFn(rawText)) {
    const parsed = parsePastedScript(rawText);
    const speakers = [...new Set(parsed.filter(e => e.type === 'dialogue').map(e => e.speaker.toUpperCase()))];
    if (speakers.length >= 2) {
      const actorSpeaker = S.selectedChar ? S.selectedChar.toUpperCase() : (speakers[0] || '');
      return parsed.filter(e => e.type === 'dialogue').map(e => ({ text: e.text, type: e.speaker.toUpperCase() === actorSpeaker ? 'actor' : 'partner', char: e.speaker }));
    }
    return parsed.filter(e => e.type !== 'stage_direction').map(e => ({ text: e.text, type: 'partner', char: e.speaker || '' }));
  }
  return rawLines.map(l => ({ text: l.trim(), type: 'partner' }));
}

// ── Group consecutive dialogue lines ────────────────────────────────

function normalizeCharacterNameForGroup(rawName) {
  const normFn = window.normalizeScriptLine || (s => String(s || '').toUpperCase().trim());
  const cleanFn = window.cleanCharacterName || (s => String(s || '').trim());
  return normFn(cleanFn(String(rawName || '')));
}

function groupConsecutiveLines(scriptLines) {
  if (!scriptLines || !scriptLines.length) return [];
  const grouped = [];
  let cur = null;
  for (let i = 0; i < scriptLines.length; i++) {
    const line = scriptLines[i];
    if (!line || line.kind !== LINE_TYPE.DIALOGUE) {
      if (cur) { grouped.push(cur); cur = null; }
      grouped.push({ kind: line && line.kind ? line.kind : LINE_TYPE.ACTION, text: line && line.text ? line.text : '', originalIndex: i, isStageDirection: !!(line && line.isStageDirection) });
      continue;
    }
    const norm = normalizeCharacterNameForGroup(line.char);
    if (cur && normalizeCharacterNameForGroup(cur.character) === norm) {
      cur.segments.push({ text: line.text, originalIndex: i, isStageDirection: !!line.isStageDirection, parenthetical: line.parenthetical || null });
    } else {
      if (cur) grouped.push(cur);
      cur = { kind: LINE_TYPE.DIALOGUE, character: line.char || '', segments: [{ text: line.text, originalIndex: i, isStageDirection: !!line.isStageDirection, parenthetical: line.parenthetical || null }] };
    }
  }
  if (cur) grouped.push(cur);
  return grouped;
}

// ── Exports ─────────────────────────────────────────────────────────

export {
  // Loading overlay
  setLoading,
  showLoadingCancel,
  startFakeProgress,
  stopFakeProgress,
  _updateRing,
  _animateProgressTo,
  cancelPdfParse,
  setScriptReviewInteractive,

  // File helpers
  isPdfUploadFile,
  initDragDrop,

  // Claude API calls
  fetchParseScreenplayFile,
  fetchClaudeParseScript,
  mapClaudeScriptToPdfScript,
  applyValidatedCharactersFromParsed,
  fetchLabelScript,
  parseViaExtractAndLabel,

  // Debug / normalise
  syncPdfScriptDebugMirror,
  normalizeScreenplayWhitespaceAsync,
  fillScriptInputProgressive,

  // Main entry points
  processPDF,
  handlePDFInput,
  openPdfPicker,
  newScriptReset,
  processTextImport,
  runImportedScriptPipeline,

  // Script review overlay
  estimateParseConfidence,
  normalizeReviewBlockText,
  deepClonePdfScript,
  isPdfScriptValidationBroken,
  buildScriptReviewRowEl,
  pdfScriptToReviewHtml,
  collectPdfScriptFromReviewDom,
  scriptReviewMergeDown,
  openOptionalScriptReview,
  openScriptReviewOverlay,
  closeScriptReview,

  // Character merge / helpers
  aiMergeCharacters,
  finishPdfSetupUi,
  getChars,
  pickDefaultRehearsalCharacter,
  renderChars,
  renderPartnerAssignment,

  // Clear / reset
  clearPDF,

  // Prompter
  buildLines,
  normalizeCharacterNameForGroup,
  groupConsecutiveLines,
};
