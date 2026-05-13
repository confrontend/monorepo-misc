# LinkedIn Job Saver Bookmarklet

A browser bookmarklet that extracts job descriptions from LinkedIn search results, saves them to your browser's local storage, and automatically navigates to the next job in the list. This project includes a Node.js build script to easily minify the readable code for browser use.

## How to Build (Minify)

Write or paste your expanded, readable JavaScript into a file named `bookleet.js` in the root directory.
*⚠️ **Important**: Ensure your code inside `bookleet.js` does **not** start with the `javascript:` prefix, or the minifier will throw an error.*

To generate the minified code, run:

```bash
npm run mini

```

This will output a highly compressed version of your code into a new file called `bookleet.min.js`.

## How to Install the Bookmarklet in your Browser

1. Open the newly generated `bookleet.min.js` file and copy all the text.
2. Add `javascript:` to the very beginning of the copied text.
*(Example: `javascript:(async()=>{const e=...`)
3. Open your browser's Bookmark Manager.
4. Create a new bookmark (Name it "Job Saver" or similar).
5. Paste the final string into the **URL** field and save.

## Usage

1. Go to the LinkedIn Jobs search page.
2. Click on the bookmarklet in your bookmarks bar.
3. A "Job Memory" panel will appear in the bottom right corner.
4. Click **"Copy & Next ⏭"** to save the current job description and automatically move to the next job in the list.
5. Use **"Copy All Saved Jobs"** to copy everything to your clipboard separated by dividers.