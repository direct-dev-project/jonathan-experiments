/**
 * Long-Running Sync Test with Statistical Data Collection
 * 
 * Dependency-free: uses raw fetch to Direct RPC and reference node.
 * Compares Direct vs reference for drift, latency, and data consistency.
 * 
 * Usage:
 *   DIRECT_PROJECT_ID=xxx DIRECT_PROJECT_TOKEN=yyy npx tsx scripts/long-running-sync-stats.ts
 */

import { appendFileSync, existsSync, mkdirSync } from "fs";
import { dirname } from "path";

const PROJECT_ID = process.env.DIRECT_PROJECT_ID;
const PROJECT_TOKEN = process.env.DIRECT_PROJECT_TOKEN;

if (!PROJECT_ID || !PROJECT_TOKEN) {
  console.error("Error: DIRECT_PROJECT_ID and DIRECT_PROJECT_TOKEN must be set");
  process.exit(1);
}

// Direct RPC endpoint (id.token format)
const DIRECT_RPC = `https://rpc.direct.dev/v1/${PROJECT_ID}.${PROJECT_TOKEN}/ethereum`;
const REFERENCE_RPC = "https://eth.llamarpc.com";

const DATA_FILE = process.env.DATA_FILE || "/tmp/e2e-sync-data.ndjson";
const MISMATCH_FILE = DATA_FILE.replace(/\.ndjson$/, "-mismatches.ndjson");

const TEST_ADDRESSES = [
  "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2", // WETH
  "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48", // USDC
  "0xdAC17F958D2ee523a2206206994597C13D831ec7", // USDT
];

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id: number;
  method: string;
  params?: unknown[];
}

interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: number;
  result?: unknown;
  error?: { code: number; message: string };
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

let requestId = 1;

async function rpcCall(url: string, method: string, params?: unknown[]): Promise<JsonRpcResponse> {
  const request: JsonRpcRequest = {
    jsonrpc: "2.0",
    id: requestId++,
    method,
    params,
  };

  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(request),
  });

  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${response.statusText}`);
  }

  return response.json();
}

async function getBlockNumber(url: string): Promise<{ block: number; latencyMs: number }> {
  const start = performance.now();
  const response = await rpcCall(url, "eth_blockNumber");
  const latencyMs = performance.now() - start;
  
  if (response.error) {
    throw new Error(response.error.message);
  }
  
  return { block: Number(response.result), latencyMs };
}

async function getBalance(url: string, address: string, blockHex: string): Promise<{ balance: string | null; error?: string }> {
  try {
    const response = await rpcCall(url, "eth_getBalance", [address, blockHex]);
    if (response.error) {
      return { balance: null, error: response.error.message };
    }
    return { balance: String(BigInt(response.result as string)) };
  } catch (e) {
    return { balance: null, error: e instanceof Error ? e.message : String(e) };
  }
}

async function runTest() {
  console.log("Starting long-running sync test (dependency-free)...");
  console.log(`Direct RPC: ${DIRECT_RPC.replace(PROJECT_TOKEN!, "***")}`);
  console.log(`Reference RPC: ${REFERENCE_RPC}`);
  console.log(`Data file: ${DATA_FILE}`);
  console.log(`Mismatch file: ${MISMATCH_FILE}`);
  console.log("");

  let lastDirectBlock: number | null = null;
  let lastRefBlock: number | null = null;
  let lastDirectTime: number | null = null;
  let lastRefTime: number | null = null;

  while (true) {
    try {
      const now = Date.now();

      // Get block numbers with latency measurement
      const [directResult, refResult] = await Promise.all([
        getBlockNumber(DIRECT_RPC),
        getBlockNumber(REFERENCE_RPC),
      ]);

      const directBlock = directResult.block;
      const refBlock = refResult.block;
      const drift = directBlock - refBlock;

      // Compare reads at the lower block number
      const compareBlock = Math.min(directBlock, refBlock);
      const compareBlockHex = "0x" + compareBlock.toString(16);
      
      let readsMatched = true;
      const mismatches: MismatchDump[] = [];

      for (const address of TEST_ADDRESSES) {
        const [directBalance, refBalance] = await Promise.all([
          getBalance(DIRECT_RPC, address, compareBlockHex),
          getBalance(REFERENCE_RPC, address, compareBlockHex),
        ]);

        if (directBalance.balance !== refBalance.balance || directBalance.error || refBalance.error) {
          readsMatched = false;
          const mismatch: MismatchDump = {
            timestamp: Date.now(),
            isoTime: new Date().toISOString(),
            block: compareBlock,
            address,
            directValue: directBalance.balance,
            referenceValue: refBalance.balance,
          };
          if (directBalance.error) mismatch.directError = directBalance.error;
          if (refBalance.error) mismatch.referenceError = refBalance.error;
          
          mismatches.push(mismatch);
          appendData(MISMATCH_FILE, mismatch);
          
          console.error(`\n⚠️  MISMATCH at block ${compareBlock} for ${address}:`);
          console.error(`   Direct:    ${directBalance.balance ?? `ERROR: ${directBalance.error}`}`);
          console.error(`   Reference: ${refBalance.balance ?? `ERROR: ${refBalance.error}`}`);
        }
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

      const dataPoint = {
        timestamp: now,
        isoTime: new Date(now).toISOString(),
        directBlock,
        referenceBlock: refBlock,
        drift,
        directLatencyMs: directResult.latencyMs,
        referenceLatencyMs: refResult.latencyMs,
        readsMatched,
        readCount: TEST_ADDRESSES.length,
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
      const status = readsMatched ? "✓" : "✗";
      process.stdout.write(
        `\r[${new Date().toISOString()}] Direct: ${directBlock} | Ref: ${refBlock} | Drift: ${drift} | Reads: ${status} | Direct: ${directResult.latencyMs.toFixed(2)}ms | Ref: ${refResult.latencyMs.toFixed(2)}ms    `
      );

      await new Promise((resolve) => setTimeout(resolve, 500));
    } catch (error) {
      console.error("\nError during test iteration:", error);
      await new Promise((resolve) => setTimeout(resolve, 5000));
    }
  }
}

runTest().catch(console.error);
