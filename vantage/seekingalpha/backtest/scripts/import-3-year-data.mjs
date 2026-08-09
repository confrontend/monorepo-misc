// Replaced by the in-app importer. Kept as a signpost rather than deleted so that anyone who
// finds a reference to `npm run import:3-year` in an old note lands here instead of on a missing
// file.
//
// What changed:
//   - Ingestion now lives in server/db/ingest.ts and is driven by the Data tab's Import button.
//   - Files are recognised by their contents, not by a `_historical_prices_` substring in the
//     filename, so renaming or moving a file no longer makes it invisible.
//   - One folder, input/, scanned recursively — including the benchmark files, which used to sit
//     in their own directory and be loaded by a completely separate code path.
//   - No verbatim JSON copy per row. That is what took the old database to 640 MB; the current one
//     holds the same data in about 60 MB and records only which file each row came from.
//
// To import data: run `npm run dev`, open the Data tab, press Import.

console.error(
  'This script has been replaced by the Data tab in the app.\n'
  + 'Run `npm run dev`, open the Data tab, and press Import.\n',
);
process.exit(1);
