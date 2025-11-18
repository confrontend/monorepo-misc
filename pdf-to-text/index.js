const Tesseract = require('tesseract.js');
const fs = require('fs');

Tesseract.recognize('table-image.png', 'eng').then(({ data: { text } }) => {
  fs.writeFileSync('raw-output.txt', text);
  console.log('Raw text saved.');
});
