const fs = require("fs");
const path = require("path");
const { JSDOM } = require("jsdom");

const inputFolder = "./htmls";
const outputFile = "output.txt";

// 1. Clear the output file or create it if it doesn't exist
fs.writeFileSync(outputFile, "");

// 2. Read all files in the directory
const files = fs.readdirSync(inputFolder);

files.forEach((file) => {
  // Only process .html files
  if (path.extname(file).toLowerCase() === ".html") {
    console.log(`Processing: ${file}...`);
    
    const filePath = path.join(inputFolder, file);
    const html = fs.readFileSync(filePath, "utf8");

    // Parse with jsdom
    const dom = new JSDOM(html);
    const h4s = dom.window.document.querySelectorAll("h4");

    // Add a header in the txt file to identify which file the text came from
    fs.appendFileSync(outputFile, `--- Results from ${file} ---\n`);

    // Collect and filter sequential duplicates
    let lastText = null;
    h4s.forEach((h4) => {
      const text = h4.textContent.trim();
      if (text && text !== lastText) {
        // Write to file instead of just console.log
        fs.appendFileSync(outputFile, text + "\n");
        lastText = text;
      }
    });

    // Add a newline for spacing between files
    fs.appendFileSync(outputFile, "\n");
  }
});

console.log(`Done! Results saved to ${outputFile}`);