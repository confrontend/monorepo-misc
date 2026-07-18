#!/usr/bin/env node

const fs = require("fs");
const path = require("path");

const DEFAULT_INPUT = path.join("data", "job-pages-full.json");
const DEFAULT_OUTPUT = path.join("data", "job-shortlist.json");

const GREEN_PATTERNS = [
  "canada",
  "united states and canada",
  "us and canada",
  "u.s. and canada",
  "remote canada",
  "north america",
  "americas",
  "americas time zones",
  "global remote",
  "work from anywhere",
  "contractor",
  "independent contractor",
  "c2c",
  "b2b",
  "corp-to-corp",
  "employer of record",
  "eor",
  "deel",
  "remote.com",
  "rippling",
  "g-p",
  "globalization partners",
  "canadian payroll",
  "global payroll"
];

const RED_PATTERNS = [
  "us only",
  "u.s. only",
  "united states only",
  "must reside in the united states",
  "must be authorized to work in the united states",
  "authorized to work in the u.s.",
  "w-2 only",
  "w2 only",
  "no contractors",
  "no international candidates",
  "must be located in the us"
];

const ROLE_PATTERNS = [
  "senior",
  "frontend",
  "front-end",
  "full stack",
  "full-stack",
  "react",
  "typescript",
  "software engineer"
];

function loadJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function saveJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2));
}

function lower(value) {
  return String(value || "").toLowerCase();
}

function collectText(record) {
  return [
    record.title,
    record.snippet,
    record.pageTitle,
    record.fullText,
    record.url,
    record.finalUrl
  ].map(lower).join("\n");
}

function findMatches(text, patterns) {
  const matches = [];
  for (const pattern of patterns) {
    if (text.includes(pattern)) matches.push(pattern);
  }
  return matches;
}

function detectCompany(record) {
  const sources = [record.pageTitle, record.title, record.url].filter(Boolean).join(" ");
  const greenhouse = sources.match(/at\s+(.+?)(?:\s+\||\s+-|$)/i);
  if (greenhouse && greenhouse[1]) return greenhouse[1].trim();
  const lever = sources.match(/^(.+?)\s+-\s+Lever$/i);
  if (lever && lever[1]) return lever[1].trim();
  const dash = sources.match(/^(.+?)\s+-\s+(.+?)$/);
  if (dash && dash[2] && !/senior|engineer|developer|react|frontend|software/i.test(dash[2])) {
    return dash[2].trim();
  }
  return "";
}

function scoreLead(record, greenFlags, redFlags) {
  const text = collectText(record);
  const pageType = String(record.pageType || "").toLowerCase();
  let score = 5;
  const roleMatches = findMatches(text, ROLE_PATTERNS);

  if (greenFlags.some((flag) => /canada|united states and canada|us and canada|u\.s\. and canada|remote canada/.test(flag))) {
    score += 3;
  } else if (greenFlags.length) {
    score += 1;
  }

  if (greenFlags.some((flag) => /global remote|work from anywhere|north america|americas/.test(flag))) {
    score += 1;
  }

  if (greenFlags.some((flag) => /contractor|independent contractor|c2c|b2b|corp-to-corp|employer of record|eor|deel|remote\.com|rippling|g-p|globalization partners|global payroll|canadian payroll/.test(flag))) {
    score += 1;
  }

  score += Math.min(roleMatches.length, 2);

  if (redFlags.length) {
    score -= redFlags.some((flag) => /must reside in the united states|must be located in the us|united states only|us only|u\.s\. only/.test(flag)) ? 4 : 2;
  }

  if (/senior|frontend|front-end|full stack|full-stack|react|typescript|software engineer/.test(text)) {
    score += 1;
  }

  if (/staff|principal|lead/.test(text)) {
    score += 1;
  }

  if (pageType === "job_list") {
    score -= 2;
  } else if (pageType === "application_form") {
    score -= 1;
  } else if (pageType === "blocked") {
    score = 1;
  }

  return Math.max(1, Math.min(10, score));
}

function determineFeasibility(record, greenFlags, redFlags, text) {
  if (String(record.fetchStatus || "").toLowerCase() === "blocked" || String(record.pageType || "").toLowerCase() === "blocked") {
    return "blocked";
  }

  const strongNo = redFlags.some((flag) =>
    /must reside in the united states|must be located in the us|united states only|us only|u\.s\. only/.test(flag)
  );

  const hasCanadaSignal = greenFlags.some((flag) => /canada|united states and canada|us and canada|u\.s\. and canada|remote canada/.test(flag));
  const hasRemoteSignal = greenFlags.some((flag) => /global remote|work from anywhere|north america|americas|contractor|independent contractor|c2c|b2b|corp-to-corp|employer of record|eor|deel|remote\.com|rippling|g-p|globalization partners|canadian payroll|global payroll/.test(flag));

  if (strongNo && !hasCanadaSignal) return "no";
  if (strongNo) return "likely_no";
  if (hasCanadaSignal && !redFlags.length) return "clear_yes";
  if (hasRemoteSignal && !redFlags.length) return "likely_yes";
  if (hasCanadaSignal || hasRemoteSignal) return "unclear";
  return redFlags.length ? "likely_no" : "unclear";
}

function determineVerdict(canadaFeasibility, leadScore) {
  if (canadaFeasibility === "blocked") return "skip";
  if (canadaFeasibility === "clear_yes" && leadScore >= 7) return "apply";
  if (canadaFeasibility === "likely_yes" && leadScore >= 5) return "maybe";
  if (canadaFeasibility === "unclear" && leadScore >= 6) return "maybe";
  return "skip";
}

function reasonFor(record, canadaFeasibility, greenFlags, redFlags, leadScore) {
  const pieces = [];
  if (record.pageType) pieces.push(`type=${record.pageType}`);
  if (record.fetchStatus) pieces.push(`status=${record.fetchStatus}`);
  if (greenFlags.length) pieces.push(`green: ${greenFlags.slice(0, 3).join(", ")}`);
  if (redFlags.length) pieces.push(`red: ${redFlags.slice(0, 3).join(", ")}`);
  pieces.push(`feasibility=${canadaFeasibility}`);
  pieces.push(`score=${leadScore}`);
  if (record.pageTitle) pieces.push(`page=${record.pageTitle}`);
  return pieces.join(" | ");
}

function main() {
  const inputPath = path.resolve(process.argv[2] || DEFAULT_INPUT);
  const outputPath = path.resolve(process.argv[3] || DEFAULT_OUTPUT);

  if (!fs.existsSync(inputPath)) {
    throw new Error(`Input file not found: ${inputPath}`);
  }

  const input = loadJson(inputPath);
  if (!Array.isArray(input)) {
    throw new Error("Input JSON must be an array of fetched job page records.");
  }

  const shortlist = input
    .filter((record) => String(record.fetchStatus || "").toLowerCase() !== "blocked" && String(record.pageType || "").toLowerCase() !== "blocked")
    .map((record) => {
    const text = collectText(record);
    const greenFlags = findMatches(text, GREEN_PATTERNS);
    const redFlags = findMatches(text, RED_PATTERNS);
    const canadaFeasibility = determineFeasibility(record, greenFlags, redFlags, text);
    const leadScore = scoreLead(record, greenFlags, redFlags);
    const verdict = determineVerdict(canadaFeasibility, leadScore);

    return {
      leadScore,
      verdict,
      canadaFeasibility,
      blocked: false,
      pageType: record.pageType || "",
      fetchStatus: record.fetchStatus || "",
      title: record.title || "",
      company: detectCompany(record),
      url: record.url || "",
      finalUrl: record.finalUrl || "",
      matchedGreenFlags: greenFlags,
      matchedRedFlags: redFlags,
      reason: reasonFor(record, canadaFeasibility, greenFlags, redFlags, leadScore),
      query: record.query || "",
      collectedAt: record.collectedAt || "",
      fetchedAt: record.fetchedAt || "",
      source: record.source || "",
      snippet: record.snippet || "",
      pageTitle: record.pageTitle || "",
      fullText: record.fullText || ""
    };
  });

  saveJson(outputPath, shortlist);
}

main();
