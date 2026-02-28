const fs = require("fs");
const path = require("path");
const { convert } = require("html-to-text");

const inputFolder = "./htmls";

// 1. Check if the folder exists
if (!fs.existsSync(inputFolder)) {
  console.error("Error: 'html' folder not found.");
  process.exit(1);
}

// 2. Read all files in the directory
const files = fs.readdirSync(inputFolder);

files.forEach((file) => {
  // Only process .html files
  if (path.extname(file).toLowerCase() === ".html") {
    const filePath = path.join(inputFolder, file);
    const htmlContent = fs.readFileSync(filePath, "utf8");

    // 3. Convert HTML to formatted text
    const text = convert(htmlContent, {
      wordwrap: 130,
      selectors: [
        { selector: "a", options: { ignoreHref: true } }, // Don't show URL links
        { selector: "img", format: "skip" }              // Skip images
      ]
    });

    // 4. Save to a new .txt file (e.g., sample.html -> sample.txt)
    const outputFileName = file.replace(/\.html$/i, ".txt");
    const outputPath = path.join(inputFolder, outputFileName);
    
    fs.writeFileSync(outputPath, text);
    console.log(`Converted: ${file} -> ${outputFileName}`);
  }
});

console.log("\nAll conversions complete!");