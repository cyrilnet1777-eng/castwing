// ── PDF / Script Parsing ─────────────────────────────────────────────
// Extracted from index.html — all screenplay parsing, labeling merge,
// FDX import, pasted-text parsing, character name heuristics, gender
// detection, and related helpers.

import { S } from './state.js';
import {
  LINE_TYPE, PARSER_DEBUG,
  BLOCKED_SCREENPLAY_TOKENS, FALSE_POSITIVE_CUE_PATTERNS,
  _MALE_NAMES, _FEMALE_NAMES,
} from './constants.js';
import { yieldToBrowser } from './utils.js';
import { t, detectTextLanguage } from './i18n.js';

/* ═══════════════════════════════════════════════════════════════════════
   Tiny internal helpers (not exported)
   ═══════════════════════════════════════════════════════════════════════ */

/** NFD-strip accents for gender lookup */
const _nfd = s => s.normalize('NFD').replace(/[\u0300-\u036f]/g, '');

const _SCENE_HEAD = /^(INT\.|EXT\.|INT\ |EXT\ |SCÈNE|SCENE|SÉQUENCE|SEQUENCE|CARTON|FONDU|NOIR)/i;
const _PAGE_LINE  = /^\d{1,4}\s*\.?\s*$/;

/* ═══════════════════════════════════════════════════════════════════════
   Low-level text / name normalisation
   ═══════════════════════════════════════════════════════════════════════ */

export function normalizeScriptLine(line) {
  return String(line || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[\u2010-\u2015\u2212]/g, '-')
    .replace(/\u00A0/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toUpperCase();
}

export function parserDebugLog() {
  if (!PARSER_DEBUG) return;
  try {
    console.log.apply(console, arguments);
    if (typeof window !== 'undefined') {
      if (!Array.isArray(window.__parserDebugLogs)) window.__parserDebugLogs = [];
      const row = { ts: Date.now(), args: Array.from(arguments) };
      window.__parserDebugLogs.push(row);
      if (window.__parserDebugLogs.length > 4000) window.__parserDebugLogs = window.__parserDebugLogs.slice(-2500);
    }
  } catch (_e) {}
}

export function syncPdfScriptDebugMirror() {
  try {
    window.pdfScript = Array.isArray(S.pdfScript) ? S.pdfScript : [];
  } catch (_e) {}
}

/* ═══════════════════════════════════════════════════════════════════════
   LINE_TYPE helpers
   ═══════════════════════════════════════════════════════════════════════ */

/** Aligned on LINE_TYPE.DIALOGUE — tolerates old caches / derived strings */
export function isPdfDialogueRow(s) {
  if (!s) return false;
  const k = s.kind;
  return k === LINE_TYPE.DIALOGUE || (typeof k === 'string' && k.toLowerCase() === 'dialogue');
}

/* ═══════════════════════════════════════════════════════════════════════
   Pasted-text parser
   ═══════════════════════════════════════════════════════════════════════ */

export function parsePastedScript(raw) {
  const lines = String(raw || '').split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  const entries = [];
  for (const line of lines) {
    if (/^\(.*\)$/.test(line) || /^\[.*\]$/.test(line)) {
      entries.push({ type: 'stage_direction', text: line.replace(/^[\(\[]|[\)\]]$/g, '').trim() });
      continue;
    }
    const m = line.match(/^([A-ZÀ-ÖØ-Ý0-9 _''.\-]{2,})\s*:\s*(.+)$/);
    if (m) {
      entries.push({ type: 'dialogue', speaker: m[1].trim(), text: m[2].trim() });
      continue;
    }
    entries.push({ type: 'narration', text: line });
  }
  return entries;
}

export function hasPastedDialogueStructure(text) {
  const lines = String(text || '').split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  return lines.some(l => /^[A-ZÀ-ÖØ-Ý0-9 _''.\-]{2,}\s*:\s*.+$/.test(l));
}

/* ═══════════════════════════════════════════════════════════════════════
   FDX (Final Draft) parser
   ═══════════════════════════════════════════════════════════════════════ */

export function parseFdxFile(xmlText) {
  const parser = new DOMParser();
  const doc = parser.parseFromString(xmlText, 'text/xml');
  const paragraphs = doc.querySelectorAll('Paragraph');
  const lines = []; const characters = new Set();
  let currentChar = '';
  paragraphs.forEach(p => {
    const type = (p.getAttribute('Type') || '').trim();
    const text = Array.from(p.querySelectorAll('Text')).map(t => t.textContent || '').join('').trim();
    if (!text) return;
    if (type === 'Character') { currentChar = text.replace(/\s*\(.*\)$/, '').trim(); characters.add(currentChar); }
    else if (type === 'Dialogue' && currentChar) { lines.push({ character: currentChar, text, type: 'dialogue' }); }
    else if (type === 'Action' || type === 'Scene Heading' || type === 'General') { lines.push({ text, type: type === 'Scene Heading' ? 'slug' : 'action' }); }
  });
  return { characters: Array.from(characters), lines };
}

/* ═══════════════════════════════════════════════════════════════════════
   Character name cleaning / validation
   ═══════════════════════════════════════════════════════════════════════ */

export function cleanCharacterName(raw) {
  if (!raw) return '';
  let name = String(raw || '').replace(/\u00A0/g, ' ').trim();
  name = name.replace(/\s*\(\s*CONT['''\/]?\s*D\s*[\)\*xX]?\s*[\*xX]*\s*$/i, '').trim();
  name = name.replace(/\s*\(\s*SUITE\s*[\)\*xX]?\s*[\*xX]*\s*$/i, '').trim();
  name = name.replace(/\s*\(\s*[O0]\s*[\.\-\/]?\s*S\s*[\.\-]?\s*[\)\*xX]?\s*[\*xX]*\s*$/i, '').trim();
  name = name.replace(/\s*\(\s*[VY]\s*[\.\-]?\s*[O0]\s*[\.\-]?\s*[\)\*xX]?\s*[\*xX]*\s*$/i, '').trim();
  name = name.replace(/\s*\(\s*OFF\s*[\)\*xX]?\s*[\*xX]*\s*$/i, '').trim();
  name = name.replace(/\s*\(\s*O\.?\s*C\.?\s*[\)\*xX]?\s*[\*xX]*\s*$/i, '').trim();
  name = name.replace(/\s*[\*xXkJijld¢]+\s*$/g, '').trim();
  name = name.replace(/[^A-Za-zÀ-ÖØ-öø-ÿ\s'.\-]+$/g, '').trim();
  name = name.replace(/[.\-\s]+$/g, '').trim();
  if (/^(?:[A-ZÀ-Þ]\s){2,}[A-ZÀ-Þ]$/i.test(name)) {
    name = name.replace(/\s/g, '');
  }
  const halves = name.split(/\s{2,}/);
  if (halves.length === 2 && normalizeScriptLine(halves[0]) === normalizeScriptLine(halves[1])) {
    name = halves[0].trim();
  }
  if (name.length > 4) {
    const half = Math.floor(name.length / 2);
    const a = name.slice(0, half).trim(), b = name.slice(half).trim();
    if (a && b && normalizeScriptLine(a) === normalizeScriptLine(b)) name = a;
  }
  return name.trim().toUpperCase();
}

export function isLikelyCharacterName(candidate) {
  const cleaned = cleanCharacterName(candidate);
  const key = normalizeScriptLine(cleaned);
  const reject = reason => { parserDebugLog('[parser][isLikelyCharacterName][reject]', { candidate, cleaned, key, reason }); return false; };
  const accept = () => { parserDebugLog('[parser][isLikelyCharacterName][accept]', { candidate, cleaned, key }); return true; };
  if (!key) return reject('empty');
  if (/^\s*[\(\[]/.test(String(candidate || ''))) return reject('starts_with_parenthetical');
  if (/\d/.test(key)) return reject('contains_digit');
  const words = key.split(/\s+/).filter(Boolean);
  if (!words.length || words.length > 4) return reject('bad_word_count');
  if (key.length < 3 || key.length > 25) return reject('bad_length');
  if (BLOCKED_SCREENPLAY_TOKENS.has(key)) return reject('blocked_token_exact');
  if (words.some(w => BLOCKED_SCREENPLAY_TOKENS.has(w) && words.length === 1)) return reject('blocked_single_word');
  if (key.startsWith('PINK REV')) return reject('pink_rev_header');
  if (key === 'SALVATOR SIDES') return reject('document_title');
  if (words.includes('REV') || words.includes('SIDES')) return reject('header_title_word');
  const frElisionRx = /^(?:L|D|N|S|C|J|M|T|QU|QUELQU|LORSQU|PUISQU|JUSQU|QUOIQU|AUJOURD)['']/i;
  if (frElisionRx.test(key)) return reject('french_elision');
  if (words.length === 1 && key.length <= 3) return reject('too_short_single_word');
  if (key.startsWith("L'ART") || key.startsWith('L ART DU CRIME')) return reject('known_bad_series_title');
  return accept();
}

/* ═══════════════════════════════════════════════════════════════════════
   Stage direction / slug detection
   ═══════════════════════════════════════════════════════════════════════ */

export function isLikelyStageDirectionLine(line) {
  const key = normalizeScriptLine(line);
  if (!key) return true;
  if (/^\(?\s*(?:INT|EXT|EST|INT\.|EXT\.|SCENE|SCÈNE|SEQUENCE|SÉQUENCE|CUT TO|CUT|FADE|FADE IN|FADE OUT|FONDU|MUSIQUE|MUSIC|SFX|FX|TRANSITION|ACTE|ACT|EPISODE|ÉPISODE|RETOUR|NOIR|FONDU AU NOIR|RETOUR PRÉSENT|RETOUR PRESENT|MATCH CUT|SMASH CUT|JUMP CUT|HARD CUT|INTERCUT|DISSOLVE|CONTINUED|CONTINUOUS|MORE)\s*$/i.test(key)) return true;
  if (/^(?:\(|\[).+(?:\)|\])$/.test(String(line || '').trim())) return true;
  if (/^[-–—]\s*/.test(String(line || '').trim())) return true;
  return false;
}

function isLikelyStageDirectionContent(text) {
  const t = String(text || '').trim();
  if (!t || t.length < 8) return false;
  if (/\bpas\s+de\s+dialogue\b/i.test(t)) return true;
  if (/^pas de dialogue/i.test(t)) return true;
  if (/^(il|elle|ils|elles|on|une?\s+\w+)\s+(entre|sort|pose|prend|regarde|se\s+|s['']|ouvre|ferme|va|vient|arrive|part|monte|descend|marche|court|dort|pleure|rit|embrasse|frappe)/i.test(t)) return true;
  if (/^(?:[A-Z][a-z]+(?:\s+[A-Z][a-z]+){0,3}|[A-Z][A-Z]+(?:\s+[A-Z][A-Z]+){0,3})\s+(stands|walks|moves|turns|looks|stares|leans|steps|runs|sits|stands|enters|exits|opens|closes|grabs|takes|puts|pulls|pushes|smiles|laughs|cries|nods|shakes|whispers|shouts)\b/i.test(t)) return true;
  if (/\b(silhouette|arrière[\s-]plan|hors[\s-]champ|panoramique|travelling|gros\s+plan|plan\s+(large|moyen|serré|rapproché)|caméra|contre[\s-]champ|fondu|en\s+off|voice[\s-]over|voix[\s-]off)\b/i.test(t)) return true;
  if (/\b(voice\s*over|v\.o\.|o\.s\.|off\s*screen)\b/i.test(t)) return true;
  if (/\b(stands\s+in\s+front\s+of|in\s+the\s+background|in\s+the\s+distance|we\s+see|we\s+hear)\b/i.test(t)) return true;
  if (/\b(entre\s+dans|sort\s+de|se\s+tourne|se\s+lève|se\s+dirige|se\s+retourne|s['']approche|s['']éloigne|s['']assoit|s['']en\s+va|se\s+précipite)\b/i.test(t)) return true;
  if (/\.\s+(?:Il|Elle|Ils|Elles|On|Une?\s)\s/i.test(t)) return true;
  return false;
}

/* ═══════════════════════════════════════════════════════════════════════
   Speaker cue heuristics
   ═══════════════════════════════════════════════════════════════════════ */

export function splitSpeakerInlineLine(line) {
  const txt = String(line || '').trim();
  const m = txt.match(/^([^:：]{2,80})\s*[:：]\s*(.+)$/);
  if (!m) return null;
  return { speaker: m[1].trim(), content: m[2].trim() };
}

function isSpeakerCueCase(name) {
  const n = String(name || '').trim();
  if (!n) return false;
  const hasLatinCase = /[A-Za-zÀ-ÖØ-öø-ÿ]/.test(n);
  if (hasLatinCase) {
    const letters = n.replace(/[^A-Za-zÀ-ÖØ-öø-ÿ]/g, '');
    if (!letters.length) return true;
    const upperLetters = (n.match(/[A-ZÀ-ÖØ-Þ]/g) || []).length;
    const ratio = upperLetters / letters.length;
    return ratio >= 0.8;
  }
  return true;
}

function isCharacterCueLine(trimmed, nextLine) {
  const t = String(trimmed || '').trim();
  if (!t) return false;
  if (t.length > 40) return false;
  const letters = t.replace(/[^a-zA-ZÀ-ÿ]/g, '');
  if (letters.length === 0) return false;
  const uppers = t.replace(/[^A-ZÀ-Ÿ]/g, '');
  if (uppers.length / letters.length < 0.8) return false;
  if (/\b(EST|ÉTAIT|SERA|AVAIT|AURA|FAIT|FAISAIT|DIT|DISAIT|VA|ALLAIT|ENTRE|SORT|REGARDE|PARLE)\b/.test(t)) return false;
  if (/^(INT|EXT|FADE|CUT|DISSOLVE)\b/i.test(t)) return false;
  if (t.endsWith(':')) return true;
  const next = nextLine != null ? String(nextLine).trim() : '';
  if (!next) return false;
  if (/^[A-ZÀ-Ÿ][A-ZÀ-Ÿ\s'.-]+(\s*\([^)]+\))?$/.test(t)) return true;
  return false;
}

function isLikelySlugLine(line) {
  const t = normalizeScriptLine(line);
  if (!t) return false;
  return /^(INT[\.\s\/]|EXT[\.\s\/]|INT\/EXT[\.\s\/]|SCENE\b|SCÈNE\b)/i.test(t);
}

function isClearlyDialogueEnd(line) {
  const t = String(line || '').trim();
  if (!t) return false;
  if (/[.!?…]['")\]]?\s*$/.test(t)) return true;
  if (/^\*+$/.test(t)) return true;
  return false;
}

export function isLikelySpeakerCue(name, nextLine, opts) {
  const n = String(name || '').trim();
  const reject = reason => { parserDebugLog('[parser][isLikelySpeakerCue][reject]', { name: n, nextLine, inline: !!(opts && opts.inline), reason }); return false; };
  const accept = () => { parserDebugLog('[parser][isLikelySpeakerCue][accept]', { name: n, nextLine, inline: !!(opts && opts.inline) }); return true; };
  if (!n) return reject('empty_name');
  const cueKey = normalizeScriptLine(n);
  if (FALSE_POSITIVE_CUE_PATTERNS.some(rx => rx.test(cueKey))) return reject('blocked_false_positive_phrase');
  if (cueKey.split(/\s+/).filter(Boolean).length > 3) return reject('too_many_words_for_cue');
  if (!(opts && opts.inline)) {
    const prevLine = String(opts && opts.prevLine || '').trim();
    const prevLooksLikeCue = isCharacterCueLine(cleanCharacterName(prevLine), nextLine);
    const prevEndsBlock = isClearlyDialogueEnd(prevLine);
    const prevIsSlug = isLikelySlugLine(prevLine);
    const prevIsAction = isLikelyStageDirectionLine(prevLine);
    if (prevLine && !prevEndsBlock && !prevIsSlug && !prevIsAction && !prevLooksLikeCue) {
      return reject('not_isolated_line');
    }
  }
  if (/[.!?]/.test(n)) {
    const bare = n.replace(/[.!?]+$/g, '').trim();
    const letters = bare.replace(/[^A-Za-zÀ-ÖØ-öø-ÿ]/g, '');
    const upper = (bare.match(/[A-ZÀ-ÖØ-Þ]/g) || []).length;
    const ratio = letters.length ? upper / letters.length : 0;
    const shortCueLike = bare.length <= 15 && ratio >= 0.8 && !/\s{2,}/.test(bare);
    if (!shortCueLike) return reject('contains_sentence_punctuation');
  }
  if (!isLikelyCharacterName(n)) return reject('not_likely_character_name');
  if (!isSpeakerCueCase(n)) return reject('cue_case_ratio_below_threshold');
  if (!(opts && opts.inline) && !isCharacterCueLine(n, nextLine)) return reject('not_character_cue_line');
  const words = n.split(/\s+/).filter(Boolean);
  if (words.length === 1) {
    const w = n.toUpperCase();
    if (w.length <= 4 && w !== n) return reject('short_single_word_not_upper');
  }
  return accept();
}

function nextNonEmptyLine(lines, idx) {
  for (let j = idx + 1; j < lines.length; j++) {
    const n = String(lines[j] || '').trim();
    if (n) return n;
  }
  return '';
}

function prevNonEmptyLine(lines, idx) {
  for (let j = idx - 1; j >= 0; j--) {
    const p = String(lines[j] || '').trim();
    if (p) return p;
  }
  return '';
}

/* ═══════════════════════════════════════════════════════════════════════
   Slug / scene heading detection
   ═══════════════════════════════════════════════════════════════════════ */

export function isSlugOrSceneHeadingLine(line) {
  const l = String(line || '').trim();
  if (!l) return false;
  if (/^\d+$/.test(l) && l.length >= 3) return true;
  if (/^\d+\s+[A-ZÀ-Ö]/.test(l)) return true;
  if (_PAGE_LINE.test(l)) return false;
  if (/^(?:\d{1,3}[A-Za-z]?\s*\.\s*)(?:INT\.?|EXT\.?|INT\/EXT|INT\/|EXT\/|I\/E\.?)\b/i.test(l)) return true;
  if (/^(?:\d{1,3}[A-Za-z]?\s+)(?:INT\.|EXT\.|INT\/|EXT\/|I\/E\.)\b/i.test(l)) return true;
  if (/^(?:\d{1,3}[A-Za-z]?\s*\.\s*)(?:INTÉRIEUR|EXTÉRIEUR|INTERIOR|EXTERIOR)\b/i.test(l)) return true;
  if (/^(?:INT\.?|EXT\.?|INT\/EXT|INT\/|EXT\/|I\/E\.?)\b/i.test(l)) return true;
  if (/^(?:INTÉRIEUR|EXTÉRIEUR|INTERIOR|EXTERIOR)\b/i.test(l)) return true;
  if (/^(?:SCÈNE|SCENE|SÉQUENCE|SEQUENCE)\b/i.test(l)) return true;
  if (/^(?:CARTON|FONDU|NOIR|TRANSITION|FLASHBACK)\b/i.test(l)) return true;
  if (/^(?:FADE\s+IN|FADE\s+OUT)\b/i.test(l)) return true;
  if (_SCENE_HEAD.test(l)) return true;
  return false;
}

/* ═══════════════════════════════════════════════════════════════════════
   Dialogue-append helpers (used by parsePDFScript)
   ═══════════════════════════════════════════════════════════════════════ */

function shouldMergeDialogueContinuation(prevLine, newLine) {
  const p = String(prevLine || '').trim();
  const n = String(newLine || '').trim();
  if (!p || !n) return false;
  if (/[-–—]\s*$/.test(p)) return true;
  if (/[.!?…]['"]?\s*$/.test(p)) {
    if (n.length <= 80 && p.length <= 80) return true;
    return false;
  }
  if (/^[a-zà-öø-ÿ]/.test(n)) return true;
  if (n.length <= 80 && p.length <= 80) return true;
  return false;
}

function pdfAppendLine(res, entry) {
  if (!entry || !entry.line) return;
  const normalizedLine = String(entry.line || '').replace(/\s+/g, ' ').trim();
  if (!normalizedLine) return;
  const last = res[res.length - 1];
  if (entry.kind === LINE_TYPE.DIALOGUE && last && last.kind === LINE_TYPE.DIALOGUE && last.char === entry.char && !last.isStageDirection && !entry.isStageDirection && shouldMergeDialogueContinuation(last.line, normalizedLine)) {
    last.line = (last.line.replace(/[-–—]\s*$/, '') + ' ' + normalizedLine).replace(/\s+/g, ' ').trim();
    return;
  }
  res.push({
    kind: entry.kind || LINE_TYPE.DIALOGUE,
    char: entry.char || '',
    line: normalizedLine,
    isStageDirection: !!entry.isStageDirection,
    isSpoken: entry.isSpoken === true,
    parenthetical: entry.parenthetical ? String(entry.parenthetical).trim() : null,
  });
}

function pdfAppendDialogue(res, char, line, isStage, parenthetical) {
  pdfAppendLine(res, {
    kind: LINE_TYPE.DIALOGUE,
    char,
    line,
    isStageDirection: !!isStage,
    isSpoken: !isStage,
    parenthetical: parenthetical || null,
  });
}

function pdfAppendContext(res, kind, line) {
  pdfAppendLine(res, {
    kind,
    char: '',
    line,
    isStageDirection: kind === LINE_TYPE.ACTION,
    isSpoken: false,
    parenthetical: null,
  });
}

/* ═══════════════════════════════════════════════════════════════════════
   Rescue parser — tries inline "SPEAKER: text" when main parser finds
   fewer than 2 speakers
   ═══════════════════════════════════════════════════════════════════════ */

function rescueMultiSpeakerFromLines(lines, suspectNameWatermarks) {
  const out = [];
  let cur = null;
  const isBlocked = s => suspectNameWatermarks.has(normalizeScriptLine(s));
  for (let i = 0; i < lines.length; i++) {
    const l = String(lines[i] || '').trim().replace(/^[\u2022•*\-–—]\s*/, '').replace(/\s{2,}/g, ' ');
    if (!l) { cur = null; continue; }
    if (isLikelyStageDirectionLine(l)) continue;
    const inline = splitSpeakerInlineLine(l);
    if (inline) {
      const cleanSp = cleanCharacterName(inline.speaker);
      if (isLikelySpeakerCue(cleanSp, undefined, { inline: true }) && !isBlocked(cleanSp)) {
        cur = cleanSp;
        if (inline.content && !isLikelyStageDirectionLine(inline.content)) out.push({ char: cur, line: inline.content.trim() });
        continue;
      }
    }
    const maybeSpeaker = cleanCharacterName(l.replace(/\s*[:：–—]+\s*$/, '').trim());
    let next = '';
    for (let j = i + 1; j < lines.length; j++) {
      next = String(lines[j] || '').trim().replace(/\s{2,}/g, ' ');
      if (next) break;
    }
    const prev = prevNonEmptyLine(lines, i);
    const speakerCueOk = isLikelySpeakerCue(maybeSpeaker, next, { prevLine: prev });
    const blocked = isBlocked(maybeSpeaker);
    if (PARSER_DEBUG) {
      parserDebugLog('[parser][rescueMultiSpeakerFromLines][candidate]', {
        line: l,
        maybeSpeaker,
        next,
        speakerCueOk,
        blocked,
      });
    }
    if (speakerCueOk && !blocked) {
      let next2 = '';
      for (let j = i + 2; j < lines.length; j++) {
        next2 = String(lines[j] || '').trim().replace(/\s{2,}/g, ' ');
        if (next2) break;
      }
      const nextCueRaw = next.replace(/\s*[:：–—]+\s*$/, '').trim();
      const nextCueCandidate = cleanCharacterName(nextCueRaw);
      const earlyHyphen = /^[A-Za-zÀ-ÖØ-öø-ÿ]{0,2}\s*-\s*/.test(nextCueRaw) || /^[A-Za-zÀ-ÖØ-öø-ÿ]-/.test(nextCueRaw);
      const sentencePunctuation = /[?!.]/.test(nextCueRaw);
      const tooManyWords = nextCueRaw.split(/\s+/).filter(Boolean).length > 3;
      const nextLooksLikeCue = !!next && !earlyHyphen && !sentencePunctuation && !tooManyWords && isLikelySpeakerCue(nextCueCandidate, next2, { prevLine: l });
      const nextIsUsableDialogue = !!next && !nextLooksLikeCue && !/^\s*[\(\[]/.test(next);
      if (nextIsUsableDialogue) {
        parserDebugLog('[parser][rescueMultiSpeakerFromLines][accept]', { maybeSpeaker, next });
        cur = maybeSpeaker;
        continue;
      }
      parserDebugLog('[parser][rescueMultiSpeakerFromLines][reject]', { maybeSpeaker, reason: 'next_line_not_dialogue', next, nextLooksLikeCue, earlyHyphen, sentencePunctuation, tooManyWords });
    } else {
      parserDebugLog('[parser][rescueMultiSpeakerFromLines][reject]', { maybeSpeaker, reason: blocked ? 'blocked_name' : 'not_speaker_cue' });
    }
    if (cur && l.length > 1 && !/^\s*[\(\[]/.test(l) && !splitSpeakerInlineLine(l)) out.push({ char: cur, line: l });
  }
  return out;
}

/* ═══════════════════════════════════════════════════════════════════════
   Watermark / noise stripping
   ═══════════════════════════════════════════════════════════════════════ */

function looksLikeWatermarkLine(line) {
  const l = String(line || '').trim();
  if (!l) return false;
  if (l.length < 3 || l.length > 72) return false;
  if (/[.:;!?]/.test(l)) return false;
  const letters = (l.match(/[A-Za-zÀ-ÖØ-öø-ÿ]/g) || []).length;
  const specials = (l.match(/[_\-]/g) || []).length;
  if (letters < 3) return false;
  if (!/^[A-Za-zÀ-ÖØ-öø-ÿ\s''._-]+$/.test(l)) return false;
  const compact = l.replace(/[^A-Za-zÀ-ÖØ-öø-ÿ]/g, '');
  if (!compact) return false;
  const upperRatio = (compact.match(/[A-ZÀ-ÖØ-Þ]/g) || []).length / compact.length;
  return upperRatio > 0.65 || specials >= 2;
}

function guessWatermarkNameKeysFromFileName(fileName) {
  const base = String(fileName || '').replace(/\.[^.]+$/, '');
  if (!base) return new Set();
  const keys = new Set();
  const chunks = base.split(/[_-]+/).map(v => v.trim()).filter(Boolean);
  chunks.forEach((chunk, idx) => {
    if (idx === 0) return;
    if (chunk.length < 3) return;
    const k = normalizeScriptLine(chunk);
    if (k.split(/\s+/).length >= 2) keys.add(k);
  });
  const tail = base.match(/[_\s-]+([A-Za-zÀ-ÖØ-öø-ÿ][A-Za-zÀ-ÖØ-öø-ÿ\s.''-]{2,})$/u);
  if (tail) {
    const k = normalizeScriptLine(tail[1]);
    if (k) keys.add(k);
  }
  return keys;
}

export function stripPdfWatermarkNoise(text, pageCount, fileName) {
  const lines = String(text || '').split('\n').map(l => l.replace(/\u00A0/g, ' ').trim());
  const freq = new Map();
  const prefixFreq = new Map();
  for (const line of lines) {
    if (!line) continue;
    const key = normalizeScriptLine(line);
    if (!key) continue;
    freq.set(key, (freq.get(key) || 0) + 1);
    const pm = line.match(/^([^:：]{2,80})\s*[:：]\s*(.+)$/);
    if (pm) {
      const pKey = normalizeScriptLine(pm[1]);
      if (pKey) prefixFreq.set(pKey, (prefixFreq.get(pKey) || 0) + 1);
    }
  }
  const pages = Math.max(1, Number(pageCount) || 1);
  const repeatThreshold = Math.max(2, Math.ceil(pages * 0.20));
  const strongRepeatThreshold = Math.max(3, Math.ceil(pages * 0.40));
  const fileNameKeys = guessWatermarkNameKeysFromFileName(fileName);
  const screenplayTokens = new Set(['CUT', 'FADE', 'DISSOLVE', 'SPLIT', 'MATCH', 'INTERMISSION', 'FIN', 'END', 'NOIR', 'BLACK', 'TITLE', 'CREDITS', 'MONTAGE']);
  const noise = new Set();
  const noisyPrefixes = new Set();
  for (const [pKey, count] of prefixFreq.entries()) {
    const words = pKey.split(/\s+/).filter(Boolean).length;
    const canBeTitle = words >= 2 && pKey.length >= 14;
    if (canBeTitle && count >= Math.max(4, Math.ceil(pages * 0.45))) noisyPrefixes.add(pKey);
  }
  const speakerCues = new Set();
  const capsNameRx = /^[A-ZÀ-ÖØ-Þ]+(?:\s+[A-ZÀ-ÖØ-Þ]+){0,4}$/;
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (!l) continue;
    const key = normalizeScriptLine(l);
    if (!key || !capsNameRx.test(key)) continue;
    if (screenplayTokens.has(key)) continue;
    if (!isLikelyCharacterName(key)) continue;
    for (let j = i + 1; j < lines.length; j++) {
      const next = lines[j];
      if (!next) continue;
      if (next !== next.toUpperCase() || /^\(/.test(next)) {
        speakerCues.add(key);
      }
      break;
    }
  }
  for (const [key, count] of freq.entries()) {
    if (!key) continue;
    if (speakerCues.has(key)) continue;
    if (fileNameKeys.size && fileNameKeys.has(key) && count >= 2) noise.add(key);
    if (count < strongRepeatThreshold) continue;
    if (screenplayTokens.has(key)) continue;
    const wordCount = key.split(/\s+/).filter(Boolean).length;
    const looksLikeNameWatermark = wordCount >= 2 && key.length <= 72 && !/[.:;!?]/.test(key);
    if (looksLikeWatermarkLine(key) && looksLikeNameWatermark) noise.add(key);
    if (count >= repeatThreshold && looksLikeNameWatermark && key.length <= 48) noise.add(key);
    if (count >= 2 && capsNameRx.test(key) && !isLikelyCharacterName(key)) noise.add(key);
  }
  const cleaned = [];
  let prev = '';
  for (const line of lines) {
    if (!line) {
      cleaned.push('');
      prev = '';
      continue;
    }
    let candidate = line;
    const pm = line.match(/^([^:：]{2,80})\s*[:：]\s*(.+)$/);
    if (pm && noisyPrefixes.has(normalizeScriptLine(pm[1]))) {
      candidate = pm[2].trim();
      if (!candidate) continue;
    }
    const key = normalizeScriptLine(candidate);
    if (noise.has(key)) continue;
    if (key === prev && looksLikeWatermarkLine(candidate)) continue;
    if (/--\s*\d+\s*(?:of|sur|de|von|di)\s*\d+\s*--/i.test(candidate)) continue;
    if (/\bPink\s+Rev\.\s*\([^\)]+\)/i.test(candidate)) continue;
    if (/^\s*Pink\s+Rev\b/i.test(candidate)) continue;
    if (/\bSCENE\s+\d+\b/i.test(candidate)) continue;
    if (/\bSTART\b\s*[—\-]*>/i.test(candidate)) continue;
    if (/<\s*[—\-]*\bEND\b/i.test(candidate)) continue;
    if (/^\*+$/.test(candidate) || candidate === '*') continue;
    if (/^\d{1,4}\s*\.$/.test(candidate)) continue;
    if (/^SALVATOR\s+SIDES\b/i.test(candidate)) continue;
    if (/^PINK\s+REV\b/i.test(key)) continue;
    cleaned.push(candidate);
    prev = key;
  }
  return cleaned.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

/* ═══════════════════════════════════════════════════════════════════════
   pdf.js loader & text extraction
   ═══════════════════════════════════════════════════════════════════════ */

export async function loadPdfJs() {
  if (typeof pdfjsLib !== 'undefined') return;
  await new Promise(function (resolve, reject) {
    var s = document.createElement('script');
    s.src = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js';
    s.onload = resolve; s.onerror = reject; document.head.appendChild(s);
  });
  try { pdfjsLib.GlobalWorkerOptions.workerSrc = ''; } catch (e) {}
}

export async function extractPdfLines(file) {
  await loadPdfJs();
  var buf = await file.arrayBuffer();
  var pdf = await pdfjsLib.getDocument({ data: new Uint8Array(buf) }).promise;
  var allLines = [];
  for (var i = 1; i <= pdf.numPages; i++) {
    if (S._pdfParseCancelled) break;
    var page = await pdf.getPage(i);
    var tc = await page.getTextContent();
    var items = (tc.items || []).filter(function (it) { return it.str && it.str.trim(); });
    if (!items.length) continue;
    // Group text items by Y position (transform[5]) to reconstruct lines
    var yThreshold = 3;
    var rows = [];
    var curRow = [items[0]];
    var curY = items[0].transform ? items[0].transform[5] : 0;
    for (var j = 1; j < items.length; j++) {
      var itemY = items[j].transform ? items[j].transform[5] : 0;
      if (Math.abs(itemY - curY) <= yThreshold) {
        curRow.push(items[j]);
      } else {
        rows.push(curRow);
        curRow = [items[j]];
        curY = itemY;
      }
    }
    rows.push(curRow);
    for (var r = 0; r < rows.length; r++) {
      // Sort items in row by X position (transform[4]) for correct reading order
      rows[r].sort(function (a, b) { return (a.transform ? a.transform[4] : 0) - (b.transform ? b.transform[4] : 0); });
      // Join items: add space only when there's a real gap between items (not individual chars)
      var parts = rows[r];
      var lineText = '';
      for (var p = 0; p < parts.length; p++) {
        if (p === 0) { lineText = parts[p].str; continue; }
        var prevEnd = (parts[p - 1].transform ? parts[p - 1].transform[4] : 0) + (parts[p - 1].width || 0);
        var curStart = parts[p].transform ? parts[p].transform[4] : 0;
        var fontSize = parts[p].transform ? Math.abs(parts[p].transform[0]) : 12;
        var gap = curStart - prevEnd;
        // If gap > 30% of font size, insert space; otherwise concatenate directly
        if (gap > fontSize * 0.3) lineText += ' ' + parts[p].str;
        else lineText += parts[p].str;
      }
      lineText = lineText.replace(/\s+/g, ' ').trim();
      if (lineText) allLines.push(lineText);
    }
  }
  try { if (pdf && typeof pdf.destroy === 'function') pdf.destroy(); } catch (e) {}
  return allLines;
}

/* ═══════════════════════════════════════════════════════════════════════
   Label-merge helpers (server-side labeling round-trip)
   ═══════════════════════════════════════════════════════════════════════ */

export function buildNumberedText(lines) {
  return lines.map(function (l, i) { return (i + 1) + ': ' + l; }).join('\n');
}

export function mergeLabelsWithText(lines, labelData) {
  var labels = Array.isArray(labelData.labels) ? labelData.labels : [];
  var characters = Array.isArray(labelData.characters) ? labelData.characters : [];
  var labelMap = {};
  for (var i = 0; i < labels.length; i++) {
    var entry = labels[i];
    if (Array.isArray(entry) && entry.length >= 2) { labelMap[entry[0]] = entry; }
  }
  var merged = [];
  var pendingCue = null;
  for (var idx = 0; idx < lines.length; idx++) {
    var lineNum = idx + 1;
    var text = lines[idx];
    var label = labelMap[lineNum];
    var type = label ? String(label[1] || 'action') : 'action';
    var character = label && label[2] ? String(label[2]) : null;
    if (type === 'character_cue') { pendingCue = character || text.trim(); continue; }
    if (type === 'dialogue') {
      var speaker = character || pendingCue || null;
      var cleanText = text.replace(/^\s*\([^)]*\)\s*/, '').trim();
      if (!cleanText) { pendingCue = null; continue; }
      merged.push({ character: speaker, text: cleanText, type: 'dialogue' });
      pendingCue = null;
    } else if (type === 'slug') {
      merged.push({ character: null, text: text, type: 'slug' });
      pendingCue = null;
    } else {
      merged.push({ character: null, text: text, type: 'action' });
      pendingCue = null;
    }
  }
  return { characters: characters, lines: merged };
}

/* ═══════════════════════════════════════════════════════════════════════
   Speaker regex builder (Unicode-aware with fallback)
   ═══════════════════════════════════════════════════════════════════════ */

function buildSpeakerRegexes() {
  try {
    const name = '([\\p{L}][\\p{L}\\s\\-\\.\\\'’]{0,40})';
    return {
      charInlineRx: new RegExp('^' + name + '\\s*(?:\\([^)]*\\)\\s*)*[:–—]\\s*(.+)$', 'u'),
      charDashOnlyRx: new RegExp('^' + name + '\\s*(?:\\([^)]*\\)\\s*)*[:–—]\\s*$', 'u'),
      charAloneRx: new RegExp('^' + name + '\\s*(?:\\([^)]*\\)\\s*)*:?\\s*$', 'u'),
    };
  } catch (_err) {
    const UP = 'A-Za-zÀ-ÖØ-öø-ÿ';
    const name = '([' + UP + '][' + UP + '\\s\\-\\.\\\'’]{0,40})';
    return {
      charInlineRx: new RegExp('^' + name + '\\s*(?:\\([^)]*\\)\\s*)*[:–—]\\s*(.+)$'),
      charDashOnlyRx: new RegExp('^' + name + '\\s*(?:\\([^)]*\\)\\s*)*[:–—]\\s*$'),
      charAloneRx: new RegExp('^' + name + '\\s*(?:\\([^)]*\\)\\s*)*:?\\s*$'),
    };
  }
}

/* ═══════════════════════════════════════════════════════════════════════
   Main heuristic PDF parser (~400 lines)
   ═══════════════════════════════════════════════════════════════════════ */

export function parsePDFScript(text) {
  text = (text || '').normalize('NFC').replace(/\u00A0/g, ' ');
  const lines = text.split('\n'), res = [];
  const nameFreq = new Map();
  const capsRx = /^[A-ZÀ-ÖØ-Þ]+(?:\s+[A-ZÀ-ÖØ-Þ]+){0,4}$/;
  const speakerFollowed = new Set();
  lines.forEach((raw, idx) => {
    const cleaned = cleanCharacterName(raw.trim());
    const key = normalizeScriptLine(cleaned);
    if (!key) return;
    if (capsRx.test(key) && isLikelyCharacterName(cleaned)) {
      nameFreq.set(key, (nameFreq.get(key) || 0) + 1);
      for (let j = idx + 1; j < lines.length; j++) {
        const nxt = String(lines[j] || '').trim();
        if (!nxt) continue;
        if (nxt !== nxt.toUpperCase() || /^\(/.test(nxt)) speakerFollowed.add(key);
        break;
      }
    }
  });
  const suspectNameWatermarks = new Set(
    [...nameFreq.entries()]
      .filter(([k, count]) => count >= 2 && !speakerFollowed.has(k))
      .map(([k]) => k)
  );
  const { charInlineRx, charDashOnlyRx, charAloneRx } = buildSpeakerRegexes();
  const didasRx = /^\s*[\(\[].+[\)\]]\s*$/;
  const sceneRx = /^(INT[\.\s\/]|EXT[\.\s\/]|SÉQUENCE\b|SEQUENCE\b|TRANSITION\b|FONDU\b|FADE\b|FADE IN\b|FADE OUT\b|CUT\b|CUT TO\b|MATCH CUT\b|SMASH CUT\b|JUMP CUT\b|HARD CUT\b|INTERCUT\b|DISSOLVE\b|NOIR\b|SCÈNE\b|SCENE\b|ACTE\b|ACT\b|EPISODE\b|ÉPISODE\b|CONTINUED\b|CONTINUOUS\b|MORE\b)/i;
  const pageRx = /^\d{1,4}\s*\.?\s*$/;
  let cur = null;
  let pendingParenthetical = null;
  for (let idx = 0; idx < lines.length; idx++) {
    const raw = lines[idx];
    const l = raw.trim().replace(/^[\u2022•*\-–—]\s*/, '').replace(/\s{2,}/g, ' ');
    if (!l) { cur = null; pendingParenthetical = null; continue; }
    const nextPeek = nextNonEmptyLine(lines, idx);
    const prevPeek = prevNonEmptyLine(lines, idx);
    if (pageRx.test(l) && !isSlugOrSceneHeadingLine(l)) continue;
    if (isSlugOrSceneHeadingLine(l) || sceneRx.test(l)) {
      pdfAppendContext(res, LINE_TYPE.SLUG, l);
      cur = null;
      pendingParenthetical = null;
      continue;
    }
    if (didasRx.test(l)) {
      const inner = l.replace(/^\s*[\(\[]|[\)\]]\s*$/g, '').trim();
      if (cur) {
        pendingParenthetical = inner || null;
      } else if (inner) {
        pdfAppendContext(res, LINE_TYPE.ACTION, inner);
      }
      continue;
    }
    if (isLikelyStageDirectionLine(l)) {
      pdfAppendContext(res, LINE_TYPE.ACTION, l);
      cur = null;
      pendingParenthetical = null;
      continue;
    }
    const inline = splitSpeakerInlineLine(l);
    if (inline) {
      const cleanSpeaker = cleanCharacterName(inline.speaker);
      if (isLikelySpeakerCue(cleanSpeaker, undefined, { inline: true, prevLine: prevPeek }) && !suspectNameWatermarks.has(normalizeScriptLine(cleanSpeaker))) {
        cur = cleanSpeaker;
        if (inline.content && !isLikelyStageDirectionContent(inline.content)) pdfAppendDialogue(res, cur, inline.content, false, pendingParenthetical);
        pendingParenthetical = null;
        continue;
      }
    }
    const normalized = normalizeScriptLine(l);
    if (suspectNameWatermarks.has(normalized)) { cur = null; pendingParenthetical = null; continue; }
    let m = charInlineRx.exec(l);
    if (m) {
      const name = cleanCharacterName(m[1].trim());
      const dial = m[2].trim();
      if (name.length >= 2 && isLikelySpeakerCue(name, nextPeek, { prevLine: prevPeek }) && !suspectNameWatermarks.has(normalizeScriptLine(name))) {
        cur = name;
        if (!isLikelyStageDirectionContent(dial)) pdfAppendDialogue(res, cur, dial, false, pendingParenthetical);
        pendingParenthetical = null;
        continue;
      }
    }
    m = charDashOnlyRx.exec(l);
    if (m) {
      const name = cleanCharacterName(m[1].trim());
      if (name.length >= 2 && isLikelySpeakerCue(name, nextPeek, { prevLine: prevPeek }) && !suspectNameWatermarks.has(normalizeScriptLine(name))) { cur = name; pendingParenthetical = null; continue; }
    }
    m = charAloneRx.exec(l);
    if (m) {
      const name = cleanCharacterName(m[1].trim());
      if (name.length >= 2 && isLikelySpeakerCue(name, nextPeek, { prevLine: prevPeek }) && !suspectNameWatermarks.has(normalizeScriptLine(name))) { cur = name; pendingParenthetical = null; continue; }
    }
    if (cur && l.length > 1 && !/^\s*[\(\[]/.test(l) && !isLikelyStageDirectionContent(l)) {
      pdfAppendDialogue(res, cur, l, false, pendingParenthetical);
      pendingParenthetical = null;
      continue;
    }
    pdfAppendContext(res, LINE_TYPE.ACTION, l);
    cur = null;
    pendingParenthetical = null;
  }
  const dialogueOnly = res.filter(v => v && v.kind === LINE_TYPE.DIALOGUE);
  const uniqPrimary = new Set(dialogueOnly.map(v => v.char)).size;
  const rescued = rescueMultiSpeakerFromLines(lines, suspectNameWatermarks);
  const uniqRescued = new Set(rescued.map(v => v.char)).size;
  if ((uniqPrimary < 2 && uniqRescued >= 2 && rescued.length >= 2) || (uniqRescued > uniqPrimary && rescued.length >= Math.max(4, dialogueOnly.length))) {
    return rescued.map(entry => ({ kind: LINE_TYPE.DIALOGUE, char: entry.char, line: entry.line, isStageDirection: false, isSpoken: true, parenthetical: null }));
  }
  if (dialogueOnly.length) {
    const counts = {};
    dialogueOnly.forEach(r => { counts[r.char] = (counts[r.char] || 0) + 1; });
    const sorted = Object.entries(counts).sort((a, b) => b[1] - a[1]);
    const dominant = sorted[0];
    if (dominant && dominant[1] >= Math.max(8, Math.floor(dialogueOnly.length * 0.6))) {
      const dominantChar = dominant[0];
      const dominantWords = dominantChar.split(/\s+/).filter(Boolean).length;
      const dominantLen = dominantChar.length;
      if (dominantWords >= 2 && dominantLen >= 14) {
        const alt = [];
        let curAlt = '';
        const dominantNorm = normalizeScriptLine(dominantChar);
        const speakerInlineRx = new RegExp('^([A-ZÀÂÄÆÇÉÈÊËÎÏÔÖŒÙÛÜŸÑ][A-ZÀÂÄÆÇÉÈÊËÎÏÔÖŒÙÛÜŸÑ\\s\\-\\.\\\'’]{1,40})\\s*[:–—\\.]\\s*(.+)$');
        for (const raw of lines) {
          const l = raw.trim().replace(/\s{2,}/g, ' ');
          if (!l) continue;
          const split = l.match(/^([^:：]{2,80})\s*[:：]\s*(.+)$/);
          if (!split) continue;
          if (normalizeScriptLine(split[1]) !== dominantNorm) continue;
          let content = split[2].trim();
          if (!content) continue;
          const m = speakerInlineRx.exec(content);
          if (m) {
            const nm = cleanCharacterName(m[1].trim());
            const words = nm.split(/\s+/).filter(Boolean).length;
            if (nm === nm.toUpperCase() && words <= 4 && isLikelyCharacterName(nm)) {
              curAlt = nm;
              content = m[2].trim();
            }
          }
          if (curAlt && content) alt.push({ kind: LINE_TYPE.DIALOGUE, char: curAlt, line: content, isStageDirection: false, isSpoken: true, parenthetical: null });
        }
        const uniq = new Set(alt.map(v => v.char)).size;
        if (alt.length >= 4 && uniq >= 2) return alt;
      }
    }
  }
  const nameMap = new Map();
  for (const entry of dialogueOnly) {
    const norm = normalizeScriptLine(entry.char);
    if (!nameMap.has(norm)) nameMap.set(norm, entry.char);
    entry.char = nameMap.get(norm);
  }
  return res;
}

/* ═══════════════════════════════════════════════════════════════════════
   Character whitelist / validated-chars helper
   ═══════════════════════════════════════════════════════════════════════ */

export function normCharKeyForWhitelist(s) {
  try {
    const t = String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/’/g, "'");
    return t.toUpperCase().trim().replace(/\s+/g, ' ');
  } catch (_e) {
    return String(s || '').toUpperCase().trim();
  }
}

/* ═══════════════════════════════════════════════════════════════════════
   Post-parse sanitisation & merging
   ═══════════════════════════════════════════════════════════════════════ */

export function sanitizeCharacterNames(script) {
  const ALWAYS_BAD = new Set(['OUI', 'NON', 'MINUTES', 'ABSOLUMENT', 'ÉCRAN', 'CONTINUED', 'CONT', "CONT'D", 'CUT', 'FADE', 'MORE', 'YES', 'NO', 'NOT', 'MERDE', 'VERNIS', 'LABO', 'LOUVRE', 'POURQUOI', 'PUTAIN', 'BRAVO', 'FINALEMENT', 'ABSENTE', 'SCANDALISÉE', 'CINGLÉS', 'MONSIEUR', 'MADAME', 'STOP', 'SILENCE', 'ATTENTION', 'PARDON', 'MERCI', 'VOILÀ', 'ALLEZ', 'ENFIN', 'EXACTEMENT', 'ÉVIDEMMENT', 'PARFAIT', 'SUPER', 'GENIAL', 'GÉNIAL', 'HORRIBLE', 'IMPOSSIBLE', 'INCROYABLE', 'JAMAIS', 'TOUJOURS', 'MAINTENANT', 'ENSEMBLE', 'DEHORS', 'DEDANS', 'DESSUS', 'DESSOUS', 'DEVANT', 'DERRIÈRE', 'PARTOUT', 'AILLEURS', 'SOUDAIN', 'BREF', 'HÉLAS', 'TANT PIS', 'TANT MIEUX', 'SIDES', 'DRAFT', 'REVISION']);
  const PRONOUNS = new Set(['JE', 'TU', 'IL', 'ELLE', 'ON', 'NOUS', 'VOUS', 'ILS', 'ELLES', 'SE', 'TE', 'ME', 'MON', 'TON', 'SON', 'MA', 'TA', 'SA', 'MES', 'TES', 'SES', 'CE', 'CET', 'CETTE', 'CES', 'LE', 'LA', 'LES', 'UN', 'UNE', 'DES', 'DU', 'DE', 'AU', 'AUX', 'EN', 'Y', 'QUI', 'QUE', 'QUOI', 'DONT', 'OÙ']);
  const L_PATTERN = /L[''’]/i;
  const charCounts = {};
  for (const row of script) {
    if (!row || row.kind !== 'dialogue' || !row.char) continue;
    charCounts[row.char] = (charCounts[row.char] || 0) + 1;
  }
  const bad = new Set();
  for (const name of Object.keys(charCounts)) {
    const trimmed = name.trim();
    if (S.scriptValidatedCharKeys && S.scriptValidatedCharKeys.has(normCharKeyForWhitelist(trimmed))) continue;
    const words = trimmed.split(/\s+/);
    if (ALWAYS_BAD.has(trimmed.toUpperCase())) { bad.add(name); continue; }
    if (words.length > 5) { bad.add(name); continue; }
    if (/^\d+$/.test(trimmed) || trimmed.length <= 1) { bad.add(name); continue; }
    if (words.length === 1 && PRONOUNS.has(trimmed.toUpperCase())) { bad.add(name); continue; }
    if (words.length >= 2 && words.every(w => PRONOUNS.has(w.toUpperCase()))) { bad.add(name); continue; }
    if (words.length === 1 && L_PATTERN.test(trimmed)) { bad.add(name); continue; }
    if (words.length === 1 && charCounts[name] < 2) { bad.add(name); continue; }
  }
  const kept = Object.keys(charCounts).filter(n => !bad.has(n));
  try { if (typeof localStorage !== 'undefined' && localStorage.getItem('cw_parse_debug') === '1') { console.info('[parse] characters kept:', kept.map(n => n + ' (' + charCounts[n] + ')')); if (bad.size > 0) console.warn('[parse] characters rejected:', Array.from(bad).map(n => n + ' (' + charCounts[n] + ')')); } } catch (_e) {}
  return script.map(row => {
    if (!row || row.kind !== 'dialogue' || !bad.has(row.char)) return row;
    return { kind: 'action', char: '', line: row.line, isStageDirection: true, isSpoken: false, parenthetical: null };
  });
}

export function mergeCharacterVariants(script) {
  const SUFFIXES = /\s*\(CONT'?D\)|\s*\(CONTINUED\)|\s*\(V\.O\.\)|\s*\(O\.S\.\)|\s*\(O\.C\.\)|\s+OFF$/i;
  function stripSuffix(n) { return n.replace(SUFFIXES, '').trim(); }
  function removeAccents(s) { return s.normalize('NFD').replace(/[\u0300-\u036f]/g, ''); }
  function normKey(n) { return removeAccents(stripSuffix(n)).toUpperCase().trim(); }
  // Pass 1: deterministic suffix stripping and accent merging
  const groups = {};
  const charCounts = {};
  for (const row of script) {
    if (!row || row.kind !== 'dialogue' || !row.char) continue;
    charCounts[row.char] = (charCounts[row.char] || 0) + 1;
  }
  for (const name of Object.keys(charCounts)) {
    const stripped = stripSuffix(name);
    const key = normKey(name);
    if (!groups[key]) groups[key] = { names: {}, total: 0 };
    groups[key].names[stripped] = (groups[key].names[stripped] || 0) + charCounts[name];
    groups[key].total += charCounts[name];
  }
  // Handle compound names like GEORGES/GURN
  const compoundSplits = {};
  for (const name of Object.keys(charCounts)) {
    const stripped = stripSuffix(name);
    if (stripped.includes('/')) {
      const parts = stripped.split('/').map(p => p.trim()).filter(Boolean);
      if (parts.length >= 2) {
        compoundSplits[name] = parts;
        for (const part of parts) {
          const pk = removeAccents(part).toUpperCase();
          if (!groups[pk]) groups[pk] = { names: {}, total: 0 };
          groups[pk].names[part] = (groups[pk].names[part] || 0) + charCounts[name];
          groups[pk].total += charCounts[name];
        }
      }
    }
  }
  // Build rename map: every variant -> canonical name (most-used variant in group)
  const renameMap = {};
  for (const key of Object.keys(groups)) {
    const g = groups[key];
    const canonical = Object.entries(g.names).sort((a, b) => b[1] - a[1])[0][0];
    for (const variant of Object.keys(charCounts)) {
      if (normKey(variant) === key && variant !== canonical) {
        renameMap[variant] = canonical;
      }
    }
  }
  // For compounds, map the compound to the first part
  for (const [compound, parts] of Object.entries(compoundSplits)) {
    renameMap[compound] = parts[0];
  }
  if (Object.keys(renameMap).length === 0) return script;
  let merged = 0;
  const result = script.map(row => {
    if (!row || row.kind !== 'dialogue' || !row.char || !renameMap[row.char]) return row;
    merged++;
    return Object.assign({}, row, { char: renameMap[row.char] });
  });
  console.info('[mergeCharacterVariants] merged ' + merged + ' lines, renames:', renameMap);
  return result;
}

export function sanitizeDialogueVsAction(script) {
  let reclassed = 0;
  const res = script.map(row => {
    if (!row || row.kind !== 'dialogue' || !row.line) return row;
    if (row.char && row.isSpoken) return row;
    if (!row.char) {
      reclassed++;
      return { kind: 'action', char: '', line: row.line, isStageDirection: true, isSpoken: false, parenthetical: null };
    }
    return row;
  });
  try { if (reclassed > 0 && typeof localStorage !== 'undefined' && localStorage.getItem('cw_parse_debug') === '1') console.info('[parse] sanitizeDialogueVsAction reclassed', reclassed, 'dialogue(s) → action'); } catch (_e) {}
  return res;
}

function mergeConfidenceScores(a, b) {
  const x = typeof a === 'number' && !Number.isNaN(a) ? Math.max(0, Math.min(1, a)) : 0.55;
  const y = typeof b === 'number' && !Number.isNaN(b) ? Math.max(0, Math.min(1, b)) : 0.55;
  return Math.round(Math.min(1, Math.max(x, y) * 0.93 + 0.06) * 1000) / 1000;
}

export function mergeConsecutiveDialogues(script) {
  if (!script || !script.length) return script;
  const out = [];
  for (const row of script) {
    if (!row) { continue; }
    const prev = out[out.length - 1];
    if (row.kind === LINE_TYPE.DIALOGUE && prev && prev.kind === LINE_TYPE.DIALOGUE && prev.char === row.char && !prev.isStageDirection && !row.isStageDirection) {
      prev.line = (prev.line.replace(/[-–—]\s*$/, '') + ' ' + row.line).replace(/\s+/g, ' ').trim();
      if (typeof prev.confidence === 'number' || typeof row.confidence === 'number') {
        prev.confidence = mergeConfidenceScores(prev.confidence, row.confidence);
      }
    } else {
      out.push({ ...row });
    }
  }
  const merged = script.length - out.length;
  try { if (merged > 0 && typeof localStorage !== 'undefined' && localStorage.getItem('cw_parse_debug') === '1') console.info('[parse] mergeConsecutiveDialogues merged', merged, 'continuation line(s)'); } catch (_e) {}
  return out;
}

/* ═══════════════════════════════════════════════════════════════════════
   Whitespace normalisation
   ═══════════════════════════════════════════════════════════════════════ */

export function normalizeScreenplayWhitespace(text) {
  const t = String(text || '').replace(/\u00A0/g, ' ').replace(/\r\n?/g, '\n');
  const lines = t.split('\n');
  const out = [];
  let blank = 0;
  for (const line of lines) {
    const x = line.replace(/[ \t]+$/, '');
    if (!x.trim()) { if (blank < 1) out.push(''); blank++; continue; }
    blank = 0;
    out.push(x.trim());
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

/** Identical normalisation, with yields on very large texts (avoids long freeze) */
export async function normalizeScreenplayWhitespaceAsync(text) {
  if (String(text || '').length < 100000) return normalizeScreenplayWhitespace(text);
  const t = String(text || '').replace(/\u00A0/g, ' ').replace(/\r\n?/g, '\n');
  const lines = t.split('\n');
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

/* ═══════════════════════════════════════════════════════════════════════
   Claude-labeled script → pdfScript mapping
   ═══════════════════════════════════════════════════════════════════════ */

export function mapClaudeScriptToPdfScript(parsed) {
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
  return mergeConsecutiveDialogues(out);
}

export function applyValidatedCharactersFromParsed(parsed) {
  const chars = [...(parsed.characters || [])].map(c => String(c || '').trim()).filter(Boolean);
  const extras = ['FANTÔMAS', 'MAUD BELTHAM', 'GEORGES BELTHAM'];
  for (const x of extras) {
    if (!chars.some(c => normCharKeyForWhitelist(c) === normCharKeyForWhitelist(x))) chars.push(x);
  }
  S.scriptValidatedCharKeys = new Set(chars.map(c => normCharKeyForWhitelist(c)));
  try { if (typeof window !== 'undefined') window.__lastValidatedChars = chars.slice(); } catch (_e) {}
}

/* ═══════════════════════════════════════════════════════════════════════
   Character list helper
   ═══════════════════════════════════════════════════════════════════════ */

export function getChars() {
  const c = {};
  for (const row of S.pdfScript) {
    if (!row || row.kind !== LINE_TYPE.DIALOGUE || !row.char) continue;
    c[row.char] = (c[row.char] || 0) + 1;
  }
  return Object.entries(c).sort((a, b) => b[1] - a[1]).map(([char, count]) => ({ char, count }));
}

/* ═══════════════════════════════════════════════════════════════════════
   Gender-based voice auto-assignment
   ═══════════════════════════════════════════════════════════════════════ */

export function detectGenderFromName(charName) {
  if (!charName) return '';
  const norm = _nfd(charName.toLowerCase());
  const parts = norm.split(/[\s\-_.']+/);
  for (const p of parts) { if (_MALE_NAMES.has(p)) return 'male'; if (_FEMALE_NAMES.has(p)) return 'female'; }
  return '';
}

export function autoAssignVoiceByGender() {
  if (!S.pdfScript.length || !S.selectedChar) return;
  const partnerChars = [...new Set(S.pdfScript.filter(s => s && s.kind === LINE_TYPE.DIALOGUE && s.char && s.char !== S.selectedChar).map(s => s.char))];
  if (partnerChars.length !== 1) { console.info('[Voice] skip auto-assign: ' + partnerChars.length + ' partner chars'); return; }
  const gender = detectGenderFromName(partnerChars[0]);
  console.info('[Voice] detectGender("' + partnerChars[0] + '") →', gender || 'unknown');
  if (!gender) return;
  const match = S.VOICE_PRESETS.find(v => v.gender === gender && !v.id.includes('sadie'));
  if (match) {
    S.selectedVoice = match;
    console.info('[Voice] auto-assigned', match.label, '(' + match.id + ') for partner', partnerChars[0]);
  }
}
