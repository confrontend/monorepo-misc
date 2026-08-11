#!/usr/bin/env node
import path from 'node:path';
import { openDatabase } from '../db/client.js';
import { readDatabaseStats } from '../db/stats.js';
import { importDuneFile } from '../dune/importer.js';

const usage = (): never => {
  console.error(`Usage:
  crypto-research import-dune <file> [--db <sqlite-file>]
  crypto-research db-stats [--db <sqlite-file>]`);
  process.exit(1);
};

const argumentsList = process.argv.slice(2);
const command = argumentsList.shift();
const dbFlagIndex = argumentsList.indexOf('--db');
let databasePath: string | undefined;
if (dbFlagIndex >= 0) {
  databasePath = argumentsList[dbFlagIndex + 1];
  if (!databasePath) usage();
  argumentsList.splice(dbFlagIndex, 2);
}

if (!command) usage();
const database = openDatabase(databasePath);

try {
  if (command === 'import-dune') {
    const file = argumentsList[0];
    if (!file || argumentsList.length !== 1) usage();
    const summary = importDuneFile(database, path.resolve(file));
    console.log(JSON.stringify(summary, null, 2));
  } else if (command === 'db-stats') {
    if (argumentsList.length !== 0) usage();
    console.log(JSON.stringify(readDatabaseStats(database), null, 2));
  } else {
    usage();
  }
} finally {
  database.close();
}

