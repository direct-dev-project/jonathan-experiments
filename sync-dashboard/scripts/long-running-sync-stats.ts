/**
 * Long-running E2E Sync Statistics Test
 * 
 * Compares Direct vs reference node for:
 * - Block sync (drift)
 * - Read latency
 * - Data consistency (reads match)
 * 
 * Outputs NDJSON to DATA_FILE env var or /tmp/e2e-sync-data.ndjson
 */

import { createPublicClient, http, type PublicClient } from "viem";
import { mainnet } from "viem/chains";
import { appendFileSync, existsSync, mkdirSync } from "fs";
import { dirname } from "path";

const DIRECT_RPC = `https://rpc.direct.dev/v2/${process.env.DIRECT_PROJECT_ID}?token=${process.env.DIRECT_PROJECT_TOKEN}`;
const REFERENCE_RPC = "https://eth.llamarpc.com";

const DATA_FILE = process.env.DATA_FILE || "/tmp/e2e-sync-data.ndjson";
const MISMATCH_FILE = DATA_FILE.replace(/\.ndjson$/, "-mismatches.ndjson");

// Test addresses for read comparison
const TEST_ADDRESSES = [
  "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2", // WETH
  "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48", // USDC
  "0xdAC17F958D2ee523a2206206994597C13D831ec7", // USDT
] as const;

interface SyncDataPoint {
  timestamp: number;
  isoTime: string;
  directBlock: number;
  referenceBlock: number;
  drift: number;
  directLatencyMs: number;
  referenceLatencyMs: number;
  readsMatched: boolean;
  readCount: number;
  directBlockDeltaMs: number | null;
  refBlockDeltaMs: number | null;
  directBlockJump: number;
  refBlockJump: number;
}

interface MismatchDump {
  timestamp: number;
  isoTime: string;
  block: number;
  address: string;
  directValue: string | null;
  referenceValue: string | null;
  directError?: string;
  referenceError?: string;
}

function ensureDir(filePath: string) {
  const dir = dirname(filePath);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
}

function appendData(file: string, data: object) {
  ensureDir(file);
  appendFileSync(file, JSON.stringify(data) + "\n");
}

async function createClients(): Promise<{
  direct: PublicClient;
  reference: PublicClient;
}> {
  const direct = createPublicClient({
    chain: mainnet,
    transport: http(DIRECT_RPC),
  });

  const reference = createPublicClient({
    chain: mainnet,
    transport: http(REFERENCE_RPC),
  });

  return { direct, reference };
}

async function measureLatency<T>(
  fn: () => Promise<T>
): Promise<{ result: T; latencyMs: number }> {
  const start = performance.now();
  const result = await fn();
  const latencyMs = performance.now() - start;
  return { result, latencyMs };
}

async function getBalanceWithError(
  client: PublicClient,
  address: `0x${string}`,
  blockNumber: bigint
): Promise<{ balance: string | null; error?: string }> {
  try {
    const balance = await client.getBalance({ address, blockNumber });
    return { balance: balance.toString() };
  } catch (e) {
    return { balance: null, error: e instanceof Error ? e.message : String(e) };
  }
}

async function compareReads(
  direct: PublicClient,
  reference: PublicClient,
  blockNumber: bigint
): Promise<{ matched: boolean; count: number; mismatches: MismatchDump[] }> {
  const mismatches: MismatchDump[] = [];
  let matchCount = 0;

  for (const address of TEST_ADDRESSES) {
    const [directResult, refResult] = await Promise.all([
      getBalanceWithError(direct, address, blockNumber),
      getBalanceWithError(reference, address, blockNumber),
    ]);

    if (directResult.balance === refResult.balance && !directResult.error && !refResult.error) {
      matchCount++;
    } else {
      // Dump mismatch details
      const mismatch: MismatchDump = {
        timestamp: Date.now(),
        isoTime: new Date().toISOString(),
        block: Number(blockNumber),
        address,
        directValue: directResult.balance,
        referenceValue: refResult.balance,
      };
      if (directResult.error) mismatch.directError = directResult.error;
      if (refResult.error) mismatch.referenceError = refResult.error;
      
      mismatches.push(mismatch);
      
      // Log to console immediately
      console.error(`\n⚠️  MISMATCH at block ${blockNumber} for ${address}:`);
      console.error(`   Direct:    ${directResult.balance ?? `ERROR: ${directResult.error}`}`);
      console.error(`   Reference: ${refResult.balance ?? `ERROR: ${refResult.error}`}`);
    }
  }

  return {
    matched: mismatches.length === 0,
    count: TEST_ADDRESSES.length,
    mismatches,
  };
}

async function runTest() {
  console.log("Starting long-running sync statistics test...");
  console.log(`Direct RPC: ${DIRECT_RPC.replace(/token=.*/, "token=***")}`);
  console.log(`Reference RPC: ${REFERENCE_RPC}`);
  console.log(`Data file: ${DATA_FILE}`);
  console.log(`Mismatch file: ${MISMATCH_FILE}`);
  console.log("");

  const { direct, reference } = await createClients();

  let lastDirectBlock: number | null = null;
  let lastRefBlock: number | null = null;
  let lastDirectTime: number | null = null;
  let lastRefTime: number | null = null;

  while (true) {
    try {
      const now = Date.now();

      // Get block numbers with latency measurement
      const [directBlockResult, refBlockResult] = await Promise.all([
        measureLatency(() => direct.getBlockNumber()),
        measureLatency(() => reference.getBlockNumber()),
      ]);

      const directBlock = Number(directBlockResult.result);
      const refBlock = Number(refBlockResult.result);
      const drift = directBlock - refBlock;

      // Compare reads at the lower block number (both should have it)
      const compareBlock = BigInt(Math.min(directBlock, refBlock));
      const readComparison = await compareReads(direct, reference, compareBlock);

      // Dump any mismatches to separate file
      for (const mismatch of readComparison.mismatches) {
        appendData(MISMATCH_FILE, mismatch);
      }

      // Calculate block deltas
      let directBlockDeltaMs: number | null = null;
      let refBlockDeltaMs: number | null = null;
      let directBlockJump = 0;
      let refBlockJump = 0;

      if (lastDirectBlock !== null && lastDirectTime !== null) {
        directBlockJump = directBlock - lastDirectBlock;
        if (directBlockJump > 0) {
          directBlockDeltaMs = now - lastDirectTime;
        }
      }

      if (lastRefBlock !== null && lastRefTime !== null) {
        refBlockJump = refBlock - lastRefBlock;
        if (refBlockJump > 0) {
          refBlockDeltaMs = now - lastRefTime;
        }
      }

      const dataPoint: SyncDataPoint = {
        timestamp: now,
        isoTime: new Date(now).toISOString(),
        directBlock,
        referenceBlock: refBlock,
        drift,
        directLatencyMs: directBlockResult.latencyMs,
        referenceLatencyMs: refBlockResult.latencyMs,
        readsMatched: readComparison.matched,
        readCount: readComparison.count,
        directBlockDeltaMs,
        refBlockDeltaMs,
        directBlockJump,
        refBlockJump,
      };

      appendData(DATA_FILE, dataPoint);

      // Update last values
      if (directBlock !== lastDirectBlock) {
        lastDirectBlock = directBlock;
        lastDirectTime = now;
      }
      if (refBlock !== lastRefBlock) {
        lastRefBlock = refBlock;
        lastRefTime = now;
      }

      // Status output
      const status = readComparison.matched ? "✓" : "✗";
      process.stdout.write(
        `\r[${new Date().toISOString()}] Direct: ${directBlock} | Ref: ${refBlock} | Drift: ${drift} | Reads: ${status} | Direct: ${directBlockResult.latencyMs.toFixed(2)}ms | Ref: ${refBlockResult.latencyMs.toFixed(2)}ms    `
      );

      // Wait before next iteration
      await new Promise((resolve) => setTimeout(resolve, 500));
    } catch (error) {
      console.error("\nError during test iteration:", error);
      await new Promise((resolve) => setTimeout(resolve, 5000));
    }
  }
}

runTest().catch(console.error);
