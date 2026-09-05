import assert from 'node:assert/strict';
import test from 'node:test';
import { parseSplTokenSwap } from '../src/solana/swapParser.js';
import { SolanaRpcClient } from '../src/solana/rpcClient.js';

const TOKEN = 'TokenMint';
const WSOL = 'So11111111111111111111111111111111111111112';

test('parses token/WSOL balance deltas using raw amounts and decimals', () => {
  const result = parseSplTokenSwap({ slot: 42, blockTime: 100, meta: {
    preTokenBalances: [
      { accountIndex: 1, mint: TOKEN, uiTokenAmount: { amount: '0', decimals: 6 } },
      { accountIndex: 2, mint: WSOL, uiTokenAmount: { amount: '500000000', decimals: 9 } },
    ],
    postTokenBalances: [
      { accountIndex: 1, mint: TOKEN, uiTokenAmount: { amount: '1000000', decimals: 6 } },
      { accountIndex: 2, mint: WSOL, uiTokenAmount: { amount: '0', decimals: 9 } },
    ],
  } }, TOKEN, 90, 'sig');
  assert.equal(result?.direction, 'buy');
  assert.equal(result?.tokenAmount, 1);
  assert.equal(result?.quoteAmount, 0.5);
  assert.equal(result?.priceInQuote, 0.5);
  assert.equal(result?.quoteMint, 'SOL');
});

test('rejects failed or quote-less transactions instead of guessing', () => {
  assert.equal(parseSplTokenSwap({ meta: { err: { custom: 1 } } }, TOKEN, 0), null);
  assert.equal(parseSplTokenSwap({ meta: { preTokenBalances: [], postTokenBalances: [] } }, TOKEN, 0), null);
});

test('RPC client caches transactions and uses the configured provider URL', async () => {
  let calls = 0;
  const client = new SolanaRpcClient({ url: 'https://example.invalid', maxConcurrent: 1, transport: async (url, init) => {
    calls += 1;
    assert.equal(url, 'https://example.invalid');
    const body = JSON.parse(String(init.body)) as { method: string };
    assert.equal(body.method, 'getTransaction');
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { slot: 1, blockTime: 2 } }), { status: 200 });
  }});
  await client.getTransaction('same');
  await client.getTransaction('same');
  assert.equal(calls, 1);
  assert.deepEqual(client.cacheStats, { transactions: 1, blocks: 0, blockTimes: 0 });
});

test('delayed lookup uses bounded binary slot search and block telemetry', async () => {
  const calls: string[] = [];
  const slots = Array.from({ length: 41 }, (_, index) => 1_000 + index);
  const rpc = new SolanaRpcClient({ transport: async (_url, init) => {
    const body = JSON.parse(String(init.body)) as { method: string; params: unknown[] };
    calls.push(body.method);
    if (body.method === 'getTransaction') return new Response(JSON.stringify({ result: { slot: 1_000, blockTime: 100 } }));
    if (body.method === 'getBlocks') return new Response(JSON.stringify({ result: slots }));
    if (body.method === 'getBlockTime') {
      const slot = Number(body.params[0]);
      return new Response(JSON.stringify({ result: 100 + (slot - 1_000) }));
    }
    return new Response(JSON.stringify({ result: { blockTime: 100, transactions: [] } }));
  }});
  const result = await new (await import('../src/solana/delayedPriceProvider.js')).SolanaDelayedPriceProvider(rpc).findDelayedPrice({
    originalSignature: 'original', tokenMint: TOKEN, copyDelaySeconds: 10, maxWindowSeconds: 30,
  });
  assert.equal(result.ok, false);
  assert.ok((result.rpcStats?.getBlockTimeCalls ?? 99) <= 8);
  assert.ok((result.rpcStats?.blocksInspected ?? 0) <= 20);
  assert.equal(result.rpcStats?.getBlocksCalls, 1);
  assert.ok(calls.filter((method) => method === 'getBlockTime').length <= 8);
});
