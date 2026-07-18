#!/usr/bin/env node

const { detectPageType } = require("./fetch-job-pages");

const cases = [
  {
    name: "ashby job page",
    input: {
      url: "https://jobs.ashbyhq.com/found/123",
      pageTitle: "Senior Software Engineer (Full-Stack)",
      fullText: [
        "Overview",
        "Application",
        "About the role",
        "What you'll do",
        "Apply for this Job"
      ].join("\n")
    },
    expected: "job"
  },
  {
    name: "application only",
    input: {
      url: "https://jobs.ashbyhq.com/found/123/application",
      pageTitle: "Senior Software Engineer (Full-Stack)",
      fullText: [
        "Upload your resume",
        "Full name",
        "Email",
        "Submit Application"
      ].join("\n")
    },
    expected: "application_form"
  },
  {
    name: "cloudflare page",
    input: {
      url: "https://www.coinbase.com/careers/positions/7701645",
      pageTitle: "Just a moment...",
      fullText: [
        "Performing security verification",
        "This website uses a security service to protect against malicious bots.",
        "Cloudflare"
      ].join("\n")
    },
    expected: "blocked"
  },
  {
    name: "job board",
    input: {
      url: "https://jobs.ashbyhq.com/sardine",
      pageTitle: "Sardine Jobs",
      fullText: [
        "Open Positions (4)",
        "All Departments",
        "All Locations",
        "Filters:",
        "Engineering",
        "Senior Software Engineer - AI Experiences"
      ].join("\n")
    },
    expected: "job_list"
  }
];

let failed = 0;

for (const testCase of cases) {
  const actual = detectPageType(testCase.input);
  if (actual !== testCase.expected) {
    failed += 1;
    console.error(`${testCase.name}: expected ${testCase.expected}, got ${actual}`);
  } else {
    console.log(`${testCase.name}: ${actual}`);
  }
}

if (failed) {
  process.exit(1);
}
