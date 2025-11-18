// split.js
// Usage: node split.js input.txt

const fs = require('fs');
const path = require('path');

const [,, inFile = 'result.txt'] = process.argv;
const outDir = 'chunks';

if (!fs.existsSync(outDir)) {
  fs.mkdirSync(outDir);
}

const text = fs.readFileSync(inFile, 'utf8');
const lines = text.split(/\r?\n/);

const chunkSize = Math.ceil(lines.length / 10);

for (let i = 0; i < 10; i++) {
  const start = i * chunkSize;
  const end = start + chunkSize;
  const chunk = lines.slice(start, end).join('\n');
  const outPath = path.join(outDir, `part${i + 1}.txt`);
  fs.writeFileSync(outPath, chunk, 'utf8');
  console.log(`Created: ${outPath}`);
}
