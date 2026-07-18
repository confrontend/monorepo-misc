#!/usr/bin/env node

const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");
const { chromium } = require("playwright");

const DEFAULT_INPUT = path.join("data", "google-job-results.json");
const DEFAULT_OUTPUT = path.join("data", "job-pages-full.json");
const DEFAULT_BLOCKED_OUTPUT = path.join("data", "job-pages-blocked.json");
const SKIP_HOST_PATTERNS = [
  "simplyhired.ca",
  "jobleads.com",
  "eluta.ca",
  "indeed.ca",
  "indeed.com",
  "workopolis.com",
  "ca.jooble.org",
  "jooble.org",
  "ziprecruiter.com",
  "glassdoor.com"
];

function normalizeUrl(rawUrl) {
  try {
    const url = new URL(rawUrl);
    url.hash = "";
    [
      "utm_source",
      "utm_medium",
      "utm_campaign",
      "utm_term",
      "utm_content",
      "ref",
      "referrer",
      "source",
      "gh_src",
      "gh_jid"
    ].forEach((key) => url.searchParams.delete(key));
    return url.toString();
  } catch (err) {
    return String(rawUrl || "");
  }
}

function cleanText(text) {
  return String(text || "")
    .replace(/\u00a0/g, " ")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function randomDelayMs() {
  return 2000 + Math.floor(Math.random() * 3000);
}

function loadJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function saveJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2));
}

function makeRecordKey(record) {
  return normalizeUrl(record.url || record.finalUrl || "");
}

function parseCliArgs(argv) {
  if (argv.length === 0) {
    return {
      inputPaths: [path.resolve(DEFAULT_INPUT)],
      outputPath: path.resolve(DEFAULT_OUTPUT)
    };
  }

  if (argv.length === 1) {
    return {
      inputPaths: [path.resolve(argv[0])],
      outputPath: path.resolve(DEFAULT_OUTPUT)
    };
  }

  return {
    inputPaths: argv.slice(0, -1).map((inputPath) => path.resolve(inputPath)),
    outputPath: path.resolve(argv[argv.length - 1])
  };
}

function dedupeRecords(records) {
  const seen = new Set();
  const result = [];
  for (const record of records) {
    const key = normalizeUrl(normalizeTargetUrl(record.url || record.finalUrl || ""));
    if (!key || seen.has(key)) continue;
    seen.add(key);
    result.push(record);
  }
  return result;
}

function normalizeTargetUrl(rawUrl) {
  const normalized = normalizeUrl(rawUrl);
  if (!normalized) return "";
  try {
    const url = new URL(normalized);
    if (/\/application\/?$/.test(url.pathname)) {
      url.pathname = url.pathname.replace(/\/application\/?$/, "");
    }
    return url.toString();
  } catch (err) {
    return normalized;
  }
}

function shouldSkipFetch(targetUrl) {
  if (!targetUrl) return false;
  try {
    const url = new URL(targetUrl);
    const host = url.hostname.toLowerCase();
    return SKIP_HOST_PATTERNS.some((pattern) => host === pattern || host.endsWith(`.${pattern}`) || host.includes(pattern));
  } catch (err) {
    return false;
  }
}

function makeSkippedRecord(record, targetUrl) {
  const now = new Date().toISOString();
  return {
    source: record.source || "google",
    title: record.title || "",
    url: targetUrl || record.url || "",
    originalUrl: record.url || "",
    pageType: "blocked",
    snippet: record.snippet || "",
    query: record.query || "",
    collectedAt: record.collectedAt || "",
    finalUrl: targetUrl || record.url || "",
    pageTitle: "Skipped blocked domain",
    fullText: "",
    fetchedAt: now,
    fetchStatus: "blocked",
    error: "Skipped known blocked domain"
  };
}

function resolveExecutableFromPath(command) {
  if (!command) return "";
  const unquoted = String(command).replace(/^"(.*)"$/, "$1");
  if (path.isAbsolute(unquoted) && fs.existsSync(unquoted)) {
    return unquoted;
  }

  const lookupCommand = process.platform === "win32" ? "where" : "which";
  const lookup = spawnSync(lookupCommand, [unquoted], { encoding: "utf8" });
  if (lookup.status === 0) {
    const found = String(lookup.stdout || "")
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find(Boolean);
    if (found) {
      return found;
    }
  }

  return "";
}

function resolveBrowserExecutablePath() {
  const envCandidates = [
    process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
    process.env.PLAYWRIGHT_BROWSER_EXECUTABLE_PATH,
    process.env.BROWSER_PATH
  ];

  for (const candidate of envCandidates) {
    const resolved = resolveExecutableFromPath(candidate);
    if (resolved) return resolved;
  }

  const commonCandidates = process.platform === "win32"
    ? [
        "chrome.exe",
        "chromium.exe",
        "msedge.exe"
      ]
    : [
        "google-chrome",
        "google-chrome-stable",
        "chromium",
        "chromium-browser",
        "chrome",
        "microsoft-edge"
      ];

  for (const candidate of commonCandidates) {
    const resolved = resolveExecutableFromPath(candidate);
    if (resolved) return resolved;
  }

  return "";
}

function guessWaitTime(url) {
  const value = String(url || "").toLowerCase();
  if (value.includes("workday")) return 5000;
  if (value.includes("greenhouse")) return 2500;
  if (value.includes("lever")) return 2500;
  if (value.includes("ashby")) return 2500;
  return 1500;
}

function isBlockedPage(pageTitle, fullText) {
  const text = `${pageTitle || ""}\n${fullText || ""}`.toLowerCase();
  return [
    "performing security verification",
    "verify you are not a bot",
    "cloudflare",
    "just a moment",
    "access denied",
    "captcha"
  ].some((phrase) => text.includes(phrase));
}

const JOB_DESCRIPTION_SIGNALS = [
  "about the role",
  "about this role",
  "what you'll do",
  "what you’ll do",
  "what we're looking for",
  "what we’re looking for",
  "responsibilities",
  "requirements",
  "minimum requirements",
  "qualifications",
  "you should apply if",
  "in this role",
  "tech stack",
  "our tech stack",
  "compensation",
  "benefits",
  "location",
  "employment type",
  "department"
];

const APPLICATION_FORM_SIGNALS = [
  "upload your resume",
  "submit application",
  "linkedin profile",
  "full name",
  "email",
  "phone",
  "autofill from resume",
  "apply now"
];

const JOB_LIST_SIGNALS = [
  "open positions",
  "all departments",
  "all locations",
  "filters:",
  "reset filters",
  "department",
  "location type",
  "employment type"
];

function normalizeText(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/\u00a0/g, " ")
    .replace(/[ \t]+/g, " ");
}

function countSignals(text, signals) {
  let count = 0;
  for (const signal of signals) {
    if (text.includes(signal)) count += 1;
  }
  return count;
}

function detectPageType({ url, pageTitle, fullText }) {
  const normalizedUrl = String(url || "").toLowerCase();
  const text = normalizeText(`${pageTitle || ""}\n${fullText || ""}`);

  if (isBlockedPage(pageTitle, fullText)) {
    return "blocked";
  }

  const jobDescriptionScore = countSignals(text, JOB_DESCRIPTION_SIGNALS);
  const applicationScore = countSignals(text, APPLICATION_FORM_SIGNALS);
  const jobListScore = countSignals(text, JOB_LIST_SIGNALS);
  const hasMultipleJobRows = /open positions\s*\(\d+\)/i.test(text) || /remote - (canada|us|remote)\b/i.test(text);

  if (jobListScore >= 2 && hasMultipleJobRows) {
    return "job_list";
  }

  if (jobDescriptionScore >= 2) {
    return "job";
  }

  if (jobListScore >= 2) {
    return "job_list";
  }

  if (applicationScore >= 2 && jobDescriptionScore < 2) {
    return "application_form";
  }

  if (normalizedUrl.endsWith("/application") && jobDescriptionScore < 2) {
    return "application_form";
  }

  if (applicationScore > 0 && jobDescriptionScore < 1) {
    return "application_form";
  }

  return "unknown";
}

function inferPageType(targetUrl, pageTitle, fullText) {
  return detectPageType({ url: targetUrl, pageTitle, fullText });
}

function upsertRecord(collection, indexByUrl, record) {
  const key = makeRecordKey(record);
  if (!key) return;
  const existingIndex = indexByUrl.get(key);
  if (typeof existingIndex === "number") {
    collection[existingIndex] = record;
    return;
  }
  collection.push(record);
  indexByUrl.set(key, collection.length - 1);
}

function removeRecord(collection, indexByUrl, key) {
  const existingIndex = indexByUrl.get(key);
  if (typeof existingIndex !== "number") return;

  collection.splice(existingIndex, 1);
  indexByUrl.delete(key);

  for (const [otherKey, otherIndex] of indexByUrl.entries()) {
    if (otherIndex > existingIndex) {
      indexByUrl.set(otherKey, otherIndex - 1);
    }
  }
}

async function fetchPage(browser, record) {
  const context = await browser.newContext({
    viewport: { width: 1440, height: 1800 }
  });
  const page = await context.newPage();
  const targetUrl = normalizeTargetUrl(record.url || record.finalUrl || "");
  const result = {
    source: record.source || "google",
    title: record.title || "",
    url: targetUrl || record.url || "",
    originalUrl: record.url || "",
    pageType: "job",
    snippet: record.snippet || "",
    query: record.query || "",
    collectedAt: record.collectedAt || "",
    finalUrl: "",
    pageTitle: "",
    fullText: "",
    fetchedAt: new Date().toISOString(),
    fetchStatus: "failed"
  };

  try {
    await page.goto(targetUrl, { waitUntil: "domcontentloaded", timeout: 45000 });
    await sleep(guessWaitTime(targetUrl));
    await page.waitForLoadState("networkidle", { timeout: 8000 }).catch(() => {});
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight)).catch(() => {});
    await sleep(500);

    result.finalUrl = page.url();
    result.pageTitle = cleanText(await page.title().catch(() => ""));
    result.fullText = cleanText(
      await page.evaluate(() => document.body ? document.body.innerText : "").catch(() => "")
    );
    result.pageType = inferPageType(targetUrl, result.pageTitle, result.fullText);
    result.fetchStatus = result.pageType === "blocked" ? "blocked" : "ok";
  } catch (err) {
    result.error = String(err && err.message ? err.message : err);
  } finally {
    await page.close().catch(() => {});
    await context.close().catch(() => {});
  }

  return result;
}

async function main() {
  const { inputPaths, outputPath } = parseCliArgs(process.argv.slice(2));
  const blockedOutputPath = path.join(path.dirname(outputPath), path.basename(DEFAULT_BLOCKED_OUTPUT));

  const input = [];
  for (const inputPath of inputPaths) {
    if (!fs.existsSync(inputPath)) {
      throw new Error(`Input file not found: ${inputPath}`);
    }

    const records = loadJson(inputPath);
    if (!Array.isArray(records)) {
      throw new Error(`Input JSON must be an array of Google result records: ${inputPath}`);
    }

    input.push(...records);
  }

  const existing = fs.existsSync(outputPath) ? loadJson(outputPath) : [];
  const output = Array.isArray(existing) ? existing : [];
  const existingBlocked = fs.existsSync(blockedOutputPath) ? loadJson(blockedOutputPath) : [];
  const blockedOutput = Array.isArray(existingBlocked) ? existingBlocked : [];
  const indexByUrl = new Map();
  output.forEach((item, index) => {
    const key = normalizeUrl(item.url || item.finalUrl || "");
    if (key) indexByUrl.set(key, index);
  });
  const blockedIndexByUrl = new Map();
  blockedOutput.forEach((item, index) => {
    const key = normalizeUrl(item.url || item.finalUrl || "");
    if (key) blockedIndexByUrl.set(key, index);
  });
  const records = dedupeRecords(input);
  const browserExecutablePath = resolveBrowserExecutablePath();
  const launchOptions = { headless: true };

  if (browserExecutablePath) {
    launchOptions.executablePath = browserExecutablePath;
    console.log(`Using browser executable: ${browserExecutablePath}`);
  } else {
    if (process.platform === "linux") {
      console.log(
        "No local Linux browser found; using Playwright-managed Chromium."
      );
    } else {
      console.log("Using Playwright-managed Chromium.");
    }
  }

  console.log(`Loaded ${inputPaths.length} input file(s) with ${input.length} record(s).`);
  console.log(`Launching browser for ${records.length} unique job URLs...`);

  let browser;
  try {
    browser = await chromium.launch(launchOptions);
  } catch (err) {
    throw new Error(
      [
        "Failed to launch a browser for page fetching.",
        "If you are running in WSL, use a Linux browser binary inside WSL, not a Windows .exe under /mnt/c.",
        "If Playwright's bundled Chromium is missing Linux libraries, install a local Linux Chrome/Chromium browser or set PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH to that Linux binary.",
        `Original error: ${String(err && err.message ? err.message : err)}`
      ].join(" ")
    );
  }
  console.log("Browser launched.");

  try {
    for (let index = 0; index < records.length; index += 1) {
      const record = records[index];
      const targetUrl = normalizeTargetUrl(record.url || record.finalUrl || "");
      const key = normalizeUrl(targetUrl);
      if (!key) continue;
      if (shouldSkipFetch(targetUrl)) {
        const skipped = makeSkippedRecord(record, targetUrl);
        removeRecord(output, indexByUrl, key);
        upsertRecord(blockedOutput, blockedIndexByUrl, skipped);
        saveJson(outputPath, output);
        saveJson(blockedOutputPath, blockedOutput);
        console.log(`[${index + 1}/${records.length}] Skipped blocked domain: ${record.title || targetUrl}`);
        continue;
      }
      const existingIndex = indexByUrl.get(key);
      if (
        typeof existingIndex === "number" &&
        output[existingIndex] &&
        output[existingIndex].fetchStatus === "ok"
      ) {
        console.log(`[${index + 1}/${records.length}] Skipping already fetched: ${record.title || targetUrl}`);
        continue;
      }
      console.log(`[${index + 1}/${records.length}] Fetching: ${record.title || targetUrl}`);
      const fetched = await fetchPage(browser, record);
      if (fetched.fetchStatus === "blocked") {
        removeRecord(output, indexByUrl, key);
        upsertRecord(blockedOutput, blockedIndexByUrl, fetched);
      } else {
        removeRecord(blockedOutput, blockedIndexByUrl, key);
        upsertRecord(output, indexByUrl, fetched);
      }
      saveJson(outputPath, output);
      saveJson(blockedOutputPath, blockedOutput);
      console.log(`[${index + 1}/${records.length}] Saved: ${outputPath}`);
      await sleep(randomDelayMs());
    }
  } finally {
    await browser.close();
    console.log("Browser closed.");
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}

module.exports = {
  detectPageType,
  inferPageType,
  normalizeTargetUrl,
  isBlockedPage
};
