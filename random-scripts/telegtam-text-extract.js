// extract.js
// Usage: node extract.js input.json output.txt
const fs = require('fs');

const [,, inFile = 'result.json', outFile = 'telegram-outpu.txt'] = process.argv;

function normalize(s) {
  return s
    .normalize('NFC')           // Unicode normalize
    .replace(/\r?\n+/g, ' ')    // newlines -> space
    .replace(/\s+/g, ' ')       // collapse spaces
    .trim();
}

function isUrl(str) {
  return /https?:\/\/\S+/i.test(str);
}

function extractTextField(text) {
  if (!text) return [];
  if (typeof text === 'string') return [text];
  if (Array.isArray(text)) {
    return text.flatMap(part => {
      if (typeof part === 'string') return [part];
      if (part && typeof part === 'object') {
        // Skip explicit link entities to minimize size
        if (part.type === 'link') return [];
        // Otherwise, prefer the textual content
        return part.text ? [part.text] : [];
      }
      return [];
    });
  }
  return [];
}

try {
  const raw = fs.readFileSync(inFile, 'utf8');
  const data = JSON.parse(raw);

  const uniq = new Set();

  for (const msg of (data.messages || [])) {
    const pieces = extractTextField(msg.text);
    for (let t of pieces) {
      // Drop standalone URLs and empty bits
      if (!t || isUrl(t)) continue;

      const n = normalize(t);
      if (n) uniq.add(n);
    }
  }

  // Write one unique line per entry
  fs.writeFileSync(outFile, Array.from(uniq).join('\n'), 'utf8');
  console.log(`Wrote ${uniq.size} unique lines to ${outFile}`);
} catch (e) {
  console.error('Failed:', e.message);
  process.exit(1);
}
