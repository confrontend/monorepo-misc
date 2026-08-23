import { Pool } from 'pg';
import { Queue, type JobsOptions } from 'bullmq';

export type HistoricalJobPayload = {
  from: string;
  to: string;
  signalTypes: string[];
};

const redisConnection = {
  host: process.env.REDIS_HOST ?? '127.0.0.1',
  port: Number(process.env.REDIS_PORT ?? 63791),
};

export const productionPostgres = new Pool({
  connectionString: process.env.POSTGRES_URL ?? 'postgres://unusualwhales:unusualwhales-local-only@127.0.0.1:54329/unusualwhales',
  max: Number(process.env.POSTGRES_POOL_SIZE ?? 8),
  idleTimeoutMillis: 30_000,
});

export const historicalQueue = new Queue<HistoricalJobPayload>('unusual-whales-historical', {
  connection: redisConnection,
  defaultJobOptions: {
    attempts: 3,
    backoff: { type: 'exponential', delay: 5_000 },
    removeOnComplete: 100,
    removeOnFail: 100,
  },
});

export const enqueueHistoricalJob = async (payload: HistoricalJobPayload, options: JobsOptions = {}) =>
  historicalQueue.add('historical-backfill', payload, { jobId: `historical:${payload.from}:${payload.to}:${payload.signalTypes.slice().sort().join(',')}`, ...options });

export const closeProductionQueue = async () => {
  await historicalQueue.close();
  await productionPostgres.end();
};
