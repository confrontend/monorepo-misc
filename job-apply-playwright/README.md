# Job Lead Collection Tool

This project supports a manual workflow for collecting recent remote software job leads from Google search results, fetching the full job pages locally, and screening them for Canada-friendly opportunities.

## What it does

- One bookmarklet handles collect, export JSON, and clear actions.
- A local Playwright script opens each job URL and extracts page text.
- A filter script scores each lead for Canada feasibility.

## Files

- `bookmarklets/collect-google-results.bookmarklet.js` for the browser bookmark URL
- `scripts/fetch-job-pages.js`
- `scripts/filter-canada-jobs.js`
- `data/.gitkeep`

## Workflow

### 1. Run your Google search manually

Use Google in your browser with the search queries you already prefer. For example:

https://www.google.com/search?q=(site%3Ajobs.lever.co%20OR%20site%3Aboards.greenhouse.io%20OR%20site%3Ajobs.ashbyhq.com%20OR%20site%3Aashbyhq.com)%20(%22Senior%20Frontend%20Engineer%22%20OR%20%22Senior%20React%20Engineer%22%20OR%20%22Frontend%20Platform%20Engineer%22%20OR%20%22Senior%20Software%20Engineer%22)%20(%22Canada%22%20OR%20%22US%20and%20Canada%22%20OR%20%22United%20States%20and%20Canada%22%20OR%20%22North%20America%22%20OR%20%22Americas%20time%20zones%22)%20(%22Remote%22%20OR%20%22Contract%22%20OR%20%22EOR%22%20OR%20%22Deel%22)&tbs=qdr:d

### 2. Use the bookmarklet

Create one bookmark from the contents of `bookmarklets/collect-google-results.bookmarklet.js`, then run it on the Google results page.

The bookmarklet will:

1. Collect visible Google results if you are on a results page.
2. Export the current saved results as JSON.

It stores records in `localStorage` under the key `google_job_results_v1` and downloads files named like `google-job-results-YYYY-MM-DD.json`.

### 3. Fetch full job pages locally

Install dependencies first:

```bash
npm install
npx playwright install chromium
```

Then run:

```bash
npm run fetch -- data/*.json data/job-pages-full.json
```

This uses Playwright Chromium to open each URL and extract page text.

You can pass one or more Google export JSON files before the output file. The last argument is treated as the output path.

If Playwright's bundled Chromium fails to launch on Linux because of missing system libraries, set `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH` to a local Chrome or Chromium binary and run the same command again.
If you are running inside WSL on Windows, use a Linux browser installed inside WSL. A Windows browser under `/mnt/c/Program Files/...` will not work with Playwright from WSL.

The fetch output now includes `pageType` and marks Cloudflare/security checks as `blocked`.
Blocked fetches are also written to `data/job-pages-blocked.json`.
Known blocked aggregators such as Indeed, SimplyHired, Eluta, Workopolis, JobLeads, Jooble, ZipRecruiter, and Glassdoor are skipped before fetch.

### 4. Filter for Canada-feasible leads

```bash
npm run filter
```

By default this reads `data/job-pages-full.json` and writes `data/job-shortlist.json`.
Blocked pages are ignored by default.

## Bookmarklet creation

Copy the contents of `bookmarklets/collect-google-results.bookmarklet.js` into a browser bookmark URL field. That single bookmarklet contains the full collect/export/clear workflow.

## Output files

- `data/job-pages-full.json`
- `data/job-pages-blocked.json`
- `data/job-shortlist.json`

The Google bookmarklet also repairs stale `collectedAt` values when it re-exports saved results.

## Rules used by the filter

The filter looks for:

- Green flags such as `Canada`, `North America`, `Americas`, `global remote`, `contractor`, `EOR`, `Deel`, and `global payroll`
- Red flags such as `US only`, `must reside in the United States`, and `no international candidates`

It assigns:

- `canadaFeasibility`
- `leadScore`
- `verdict`

## Limitations

- Google snippets are not full job descriptions.
- Playwright fetches may fail on some pages, especially if a site blocks automation or requires interaction.
- Google `after:` filtering is helpful but not perfect.
- This tool is for research and shortlist building, not auto-apply.
