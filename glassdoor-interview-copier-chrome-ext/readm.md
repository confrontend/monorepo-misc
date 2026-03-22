# Glassdoor Interview Copier Extension

## 🎯 **What it does**
Scrapes Glassdoor interview questions & answers into a single text file that **appends across pages**. Auto-detects company name for filename.

## 🚀 **Quick Start**
1. Save all 4 files (`manifest.json`, `popup.html`, `popup.js`, `content.js`) in a folder
2. Chrome → `chrome://extensions/` → **Developer mode** → **Load unpacked** → Select folder
3. Visit Glassdoor interview page → Click extension icon

## 📋 **How to Use**
```
1. [Page 1] Click "📋 Copy Current Page" (sets up Hootsuite.txt)
2. Click "➡️ Next Page" 
3. [Page 2] Click "📋 Copy Current Page" (APPENDS to same file)
4. Repeat 2-3 until done!
```

| Button | Action |
|--------|---------|
| **📋 Copy** | Grabs questions → Appends → Downloads updated file |
| **➡️ Next** | Clicks Glassdoor's next page button |
| **🗑️ New File** | Clears memory (start fresh file) |

## ✨ **Features**
- ✅ **Auto filename**: `Hootsuite.txt` (from page title)
- ✅ **True append**: One file grows across all pages
- ✅ **Smart extraction**: Finds questions even on dynamic pages
- ✅ **Status bar**: Shows copy success + total file size
- ✅ **Current page display**: Always shows what page you're on
- ✅ **Persistent storage**: Survives browser restart

## 🛠 **Files Structure**
```
glassdoor-copier/
├── manifest.json     (permissions + content script)
├── popup.html        (UI with status bar)
├── popup.js          (append logic + storage)
└── content.js        (Glassdoor page scraper)
```

## 🔍 **Works on**
```
https://www.glassdoor.com/Interview/[Company]-*-Interview-Questions-*.htm
✅ Hootsuite, Google, Amazon, etc. interview pages
```

## ⚠️ **Troubleshooting**
```
❌ "No content found" → F12 Console → Check logs
❌ Next page fails → Console shows all pagination buttons
❌ Wrong filename → Edit input field before copying
```

## 📝 **Sample Output**
```
=== Hootsuite - 2026-03-22T22:35:00Z ===

Q1: Question 1 - For the systems design, they wanted you to design an alerting system...
Q2: Question 2 - How many years of experience...

--- Page End ---

Q3: Question 1 - Why did I want to work at Hootsuite...
```

**Built for Glassdoor interview scraping. No affiliation with Glassdoor.** 🚀