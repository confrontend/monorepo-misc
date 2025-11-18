const fs = require("fs");
const { JSDOM } = require("jsdom");

// Read the HTML file
const html = fs.readFileSync("sample.html", "utf8");

// Parse with jsdom
const dom = new JSDOM(html);
const h4s = dom.window.document.querySelectorAll("h4");

// Collect and filter sequential duplicates
let lastText = null;
h4s.forEach(h4 => {
  const text = h4.textContent.trim();
  if (text && text !== lastText) {
    console.log(text);
    lastText = text;
  }
});
