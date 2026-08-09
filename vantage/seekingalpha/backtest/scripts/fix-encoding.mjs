// Repairs mojibake: text that was UTF-8, got read as Windows-1252, and written back as UTF-8.
// Symptom: a middle dot renders as A-circumflex followed by the dot, an em dash as three garbage
// characters, and so on.
//
//   node scripts/fix-encoding.mjs           repair in place
//   node scripts/fix-encoding.mjs --check   report only, exit 1 if anything needs repair
//
// Why this exists: some editor or tool in this project's toolchain saves source files through a
// cp1252 round-trip. Each save stacks another layer, so the damage compounds -- this repo has been
// seen with four layers on a single character. Running this is idempotent; it only rewrites a file
// when it actually finds damage.
//
// IMPORTANT: this file contains no non-ASCII characters anywhere, deliberately. Every character it
// needs is written as a \u escape. An earlier version spelled its control-character range
// literally, that range was itself corrupted by the very bug this script repairs, and the regex
// silently degraded to one that matched an ordinary hyphen -- which would have stripped every
// hyphen in the codebase. Do not introduce literal non-ASCII here.
//
// If the damage keeps coming back, the writer is the problem, not the files: look for an editor
// whose encoding is set to Windows-1252 / ANSI instead of UTF-8.

import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const EXTENSIONS = new Set(['.ts', '.tsx', '.css', '.html', '.md', '.py', '.mjs']);
const SKIP = new Set(['node_modules', '.data', 'dist', 'dist_verify', 'dist_verify2', 'dist_verify3', 'input', 'benchmark', '__pycache__', '.git']);

// Windows-1252 assigns characters to byte positions where Latin-1 has controls. That table is what
// makes the round-trip lossy, and reversing it is what repairs the text.
const CP1252 = {
  0x80: 0x20AC, 0x82: 0x201A, 0x83: 0x0192, 0x84: 0x201E, 0x85: 0x2026, 0x86: 0x2020, 0x87: 0x2021,
  0x88: 0x02C6, 0x89: 0x2030, 0x8A: 0x0160, 0x8B: 0x2039, 0x8C: 0x0152, 0x8E: 0x017D, 0x91: 0x2018,
  0x92: 0x2019, 0x93: 0x201C, 0x94: 0x201D, 0x95: 0x2022, 0x96: 0x2013, 0x97: 0x2014, 0x98: 0x02DC,
  0x99: 0x2122, 0x9A: 0x0161, 0x9B: 0x203A, 0x9C: 0x0153, 0x9E: 0x017E, 0x9F: 0x0178,
};
const UNDEFINED_IN_CP1252 = new Set([0x81, 0x8D, 0x8F, 0x90, 0x9D]);

// One layer of damage: encode as UTF-8, then read those bytes back as cp1252.
const damageOnce = (text) => {
  const bytes = Buffer.from(text, 'utf8');
  let out = '';
  for (const byte of bytes) {
    if (byte < 0x80) out += String.fromCharCode(byte);
    else if (CP1252[byte] !== undefined) out += String.fromCharCode(CP1252[byte]);
    else if (UNDEFINED_IN_CP1252.has(byte)) return null;
    else out += String.fromCharCode(byte);
  }
  return out;
};

// Characters this codebase uses, plus all of Latin-1 supplement. For each, precompute how it looks
// after 1..4 layers of damage, then replace longest-match-first so deeper damage is undone before
// shallower damage that is a substring of it.
const buildPairs = () => {
  const chars = new Set([
    // Written as code points, never as literals - see the note at the top of this file.
    0x00B7, 0x2014, 0x2013, 0x00D7, 0x2265, 0x2264, 0x2026,
    0x201C, 0x201D, 0x2018, 0x2019, 0x2022, 0x00B0, 0x00B1,
    0x2192, 0x2190, 0x2248,
  ].map((code) => String.fromCharCode(code)));
  for (let code = 0xA0; code < 0x100; code += 1) chars.add(String.fromCharCode(code));

  const pairs = [];
  for (const char of chars) {
    let current = char;
    for (let depth = 0; depth < 4; depth += 1) {
      const next = damageOnce(current);
      if (next === null || next === current) break;
      current = next;
      pairs.push([current, char]);
    }
  }
  return pairs.sort((left, right) => right[0].length - left[0].length);
};

const PAIRS = buildPairs();
// C1 controls survive when the damage passed through a cp1252 byte with no character assigned.
// They are never legitimate in source.
const C1_CONTROLS = new RegExp(`[${String.fromCharCode(0x80)}-${String.fromCharCode(0x9F)}]`, 'g');
// A-tilde / A-circumflex / a-circumflex followed by another high character: the fingerprint of a
// layer this script could not fully undo.
const SUSPICIOUS = new RegExp(`[${[0xC3, 0xC2, 0xE2].map((c) => String.fromCharCode(c)).join('')}]` + `[${String.fromCharCode(0x80)}-${String.fromCharCode(0xFF)}${[0x2013, 0x2014, 0x201A, 0x201C, 0x201D, 0x20AC, 0x2122, 0x0161, 0x0192, 0x2026].map((c) => String.fromCharCode(c)).join('')}]`);

const walk = (dir) => {
  const found = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (SKIP.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) found.push(...walk(full));
    else if (EXTENSIONS.has(path.extname(entry.name))) found.push(full);
  }
  return found;
};

const checkOnly = process.argv.includes('--check');
let repaired = 0;
let stillDamaged = 0;

for (const file of walk(projectRoot)) {
  const original = readFileSync(file, 'utf8');
  let text = original;
  for (let pass = 0; pass < 5; pass += 1) {
    const before = text;
    for (const [damaged, clean] of PAIRS) {
      if (text.includes(damaged)) text = text.split(damaged).join(clean);
    }
    if (text === before) break;
  }
  text = text.replace(C1_CONTROLS, '');
  if (text === original) continue;

  const relative = path.relative(projectRoot, file);
  console.log(`${checkOnly ? 'would repair' : 'repaired'}: ${relative}`);
  if (!checkOnly) writeFileSync(file, text, 'utf8');
  repaired += 1;
  if (SUSPICIOUS.test(text)) {
    console.log('  ^ still contains suspicious sequences - inspect by hand');
    stillDamaged += 1;
  }
}

console.log(repaired === 0
  ? 'No mojibake found.'
  : `${repaired} file(s) ${checkOnly ? 'need repair' : 'repaired'}${stillDamaged ? `, ${stillDamaged} need manual review` : ''}.`);
process.exit(repaired > 0 && checkOnly ? 1 : 0);
