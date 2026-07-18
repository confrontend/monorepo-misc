// cd .\random-scripts\split-long-text\
// Usage: node split.js input.txt

const fs = require('fs');
const path = require('path');
const prefix = 'abb_' // --------> Change this for output name customization

const [,, inFile = 'messagesCopy.json.txt'] = process.argv;
const outDir = 'chunks';

if (!fs.existsSync(outDir)) {
  fs.mkdirSync(outDir);
}

const text = fs.readFileSync(inFile, 'utf8');
const lines = text.split(/\r?\n/);

const chunkSize = Math.ceil(lines.length / 20);

for (let i = 0; i < 20; i++) {
  const start = i * chunkSize;
  const end = start + chunkSize;
  const chunk = lines.slice(start, end).join('\n');
  const outPath = path.join(outDir, `${prefix}part${i + 1}.txt`);
  fs.writeFileSync(outPath, chunk, 'utf8');
  console.log(`Created: ${outPath}`);
}
