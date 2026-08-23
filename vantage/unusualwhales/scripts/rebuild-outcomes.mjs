import { createDatabase } from '../dist/src/db/client.js';
import { refreshOutcomes } from '../dist/src/research/outcomes.js';

const databasePath = process.env.UNUSUAL_WHALES_DB_PATH ?? new URL('../.data/unusual-whales.sqlite', import.meta.url).pathname.replace(/^\/(\w):/, '$1:');
const database = createDatabase(databasePath);
const startedAt = new Date().toISOString();
console.log(`outcome rebuild started ${startedAt}`);
try {
  const rows = refreshOutcomes(database, new Date(), ({ completed, total }) => {
    if (completed === total || completed % 10_000 === 0) {
      process.stdout.write(`\routcomes: ${completed}/${total}`);
    }
  });
  process.stdout.write('\n');
  console.log(`outcome rebuild completed rows=${rows} at ${new Date().toISOString()}`);
} catch (error) {
  console.error(error instanceof Error ? error.stack ?? error.message : error);
  process.exitCode = 1;
} finally {
  database.close();
}
