import { createDatabase } from '../db/client.js';
import { syncRecentCallSweeps } from '../providers/unusualwhales-ingest.js';

const database = createDatabase();
try {
  const summary = await syncRecentCallSweeps(database);
  console.log(JSON.stringify(summary));
} finally {
  database.close();
}
