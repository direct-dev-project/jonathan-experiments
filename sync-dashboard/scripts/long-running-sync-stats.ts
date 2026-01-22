/**
 * Long-Running Sync Test with Statistical Data Collection
 * 
 * Uses @direct.dev/client for Direct, raw fetch for reference (no caching).
 * Compares Direct vs reference node for drift, latency, and data consistency.
 * 
 * Tests:
 * - eth_blockNumber: block sync
 * - eth_getBalance: balance reads
 * - eth_call: Chainlink ETH/USD price feed
 * - Batch requests: ordering and performance
 * - Memory tracking: detect leaks over time
 */

import { makeDirectRPCClient } from "@direct.dev/client";
import { appendFileSync, existsSync, mkdirSync } from "fs";
import { dirname } from "path";

const PROJECT_ID = process.env.DIRECT_PROJECT_ID;
const PROJECT_TOKEN = process.env.DIRECT_PROJECT_TOKEN;

if (!PROJECT_ID || !PROJECT_TOKEN) {
  console.error("Error: DIRECT_PROJECT_ID and DIRECT_PROJECT_TOKEN must be set");
  process.exit(1);
}

const REFERENCE_RPC = "https://twilight-fragrant-sailboat.quiknode.pro/2d2793cc22ab621897fcfb2f365960f0ff2d8daf";
const DATA_FILE = process.env.DATA_FILE || "/tmp/e2e-sync-data.ndjson";
const MISMATCH_FILE = DATA_FILE.replace(/\.ndjson$/, "-mismatches.ndjson");
const RECOVERY_FILE = DATA_FILE.replace(/\.ndjson$/, "-recoveries.ndjson");
const ERROR_FILE = DATA_FILE.replace(/\.ndjson$/, "-errors.ndjson");

// Test addresses for eth_getBalance
const TEST_ADDRESSES = [
  "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2", // WETH
  "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48", // USDC
  "0xdAC17F958D2ee523a2206206994597C13D831ec7", // USDT
];

// Chainlink ETH/USD Price Feed on mainnet
const CHAINLINK_ETH_USD = "0x5f4eC3Df9cbd43714FE2740f5E3616155c5b8419";
const LATEST_ROUND_DATA_SELECTOR = "0xfeaf968c";

// Additional test address for batch
const VITALIK = "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045";

interface MismatchDump {
  timestamp: number;
  isoTime: string;
  mismatchId: string;
  block: number;
  type: "balance" | "call" | "batch";
  address: string;
  directValue: string;
  referenceValue: string;
}

interface RecoveryDump {
  timestamp: number;
  isoTime: string;
  mismatchId: string;
  block: number;
  type: "balance" | "call" | "batch";
  address: string;
  recovered: boolean;
  directValue: string;
  originalRefValue: string;
  retryRefValue: string | null;
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

let rpcId = 1;
let mismatchCounter = 0;

// Raw fetch for reference RPC - single request
async function refRpcCall(method: string, params?: unknown[]): Promise<{ result: unknown; error?: string }> {
  try {
    const response = await fetch(REFERENCE_RPC, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: rpcId++,
        method,
        params,
      }),
    });
    
    if (!response.ok) {
      return { result: null, error: `HTTP ${response.status}: ${response.statusText}` };
    }
    
    const json = await response.json();
    if (json.error) {
      return { result: null, error: json.error.message };
    }
    
    return { result: json.result };
  } catch (e) {
    return { result: null, error: e instanceof Error ? e.message : String(e) };
  }
}

// Raw fetch for reference RPC - batch request
async function refRpcBatch(requests: Array<{ method: string; params?: unknown[] }>): Promise<{ results: Array<{ id: number; result?: unknown; error?: string }>; error?: string }> {
  try {
    const batch = requests.map((req, i) => ({
      jsonrpc: "2.0",
      id: i + 1,
      method: req.method,
      params: req.params,
    }));

    const response = await fetch(REFERENCE_RPC, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(batch),
    });
    
    if (!response.ok) {
      return { results: [], error: `HTTP ${response.status}: ${response.statusText}` };
    }
    
    const json = await response.json();
    return { results: json };
  } catch (e) {
    return { results: [], error: e instanceof Error ? e.message : String(e) };
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function scheduleRetry(
  mismatchId: string,
  block: number,
  type: "balance" | "call" | "batch",
  address: string,
  directValue: string,
  originalRefValue: string,
  retryFn: () => Promise<string | null>
) {
  sleep(5000).then(async () => {
    let retryRefValue: string | null = null;
    let recovered = false;
    
    try {
      retryRefValue = await retryFn();
      recovered = directValue === retryRefValue;
    } catch (e) {
      // Retry failed
    }

    const recovery: RecoveryDump = {
      timestamp: Date.now(),
      isoTime: new Date().toISOString(),
      mismatchId,
      block,
      type,
      address,
      recovered,
      directValue,
      originalRefValue,
      retryRefValue,
    };
    
    appendData(RECOVERY_FILE, recovery);
    
    if (recovered) {
      console.error(`\n✅ RECOVERY [${mismatchId}]: ${type} at block ${block} - reference hiccup confirmed`);
    } else {
      console.error(`\n❌ PERSISTENT [${mismatchId}]: ${type} at block ${block} - mismatch still present after retry`);
    }
  });
}

function getMemoryUsage() {
  const mem = process.memoryUsage();
  return {
    heapUsedMB: Math.round(mem.heapUsed / 1024 / 1024 * 100) / 100,
    heapTotalMB: Math.round(mem.heapTotal / 1024 / 1024 * 100) / 100,
    rssMB: Math.round(mem.rss / 1024 / 1024 * 100) / 100,
    externalMB: Math.round(mem.external / 1024 / 1024 * 100) / 100,
  };
}

async function runTest() {
  console.log("Starting long-running sync test...");
  console.log(`Direct: @direct.dev/client`);
  console.log(`Reference: raw fetch to ${REFERENCE_RPC.split('/')[2]}`);
  console.log(`Data file: ${DATA_FILE}`);
  console.log(`Tests: eth_blockNumber, eth_getBalance (${TEST_ADDRESSES.length}), eth_call, BATCH requests`);
  console.log(`Memory tracking: enabled`);
  console.log("");

  const directClient = makeDirectRPCClient({
    projectId: PROJECT_ID!,
    projectToken: PROJECT_TOKEN!,
    networkId: "ethereum",
  });

  let lastDirectBlock: number | null = null;
  let lastRefBlock: number | null = null;
  let lastDirectTime: number | null = null;
  let lastRefTime: number | null = null;

  while (true) {
    try {
      const now = Date.now();
      const memory = getMemoryUsage();

      // Get block numbers
      const directStart = performance.now();
      const directBlockResponse = await directClient.fetch({ jsonrpc: "2.0", id: 1, method: "eth_blockNumber" });
      const directLatencyMs = performance.now() - directStart;
      const directBlock = Number((directBlockResponse as any).result);

      const refStart = performance.now();
      const refBlockResult = await refRpcCall("eth_blockNumber");
      const refLatencyMs = performance.now() - refStart;
      
      if (refBlockResult.error) {
        console.error(`\n⚠️  Reference eth_blockNumber error: ${refBlockResult.error}`);
        await sleep(5000);
        continue;
      }
      
      const refBlock = Number(refBlockResult.result);
      const drift = directBlock - refBlock;
      const compareBlock = Math.min(directBlock, refBlock);
      const compareBlockHex = "0x" + compareBlock.toString(16);
      
      let readsMatched = true;
      let directErrors = 0;
      let refErrors = 0;

      // ============ INDIVIDUAL REQUESTS ============
      for (const address of TEST_ADDRESSES) {
        let directBalance: string | null = null;
        let refBalance: string | null = null;

        try {
          const response = await directClient.fetch({
            jsonrpc: "2.0",
            id: Date.now(),
            method: "eth_getBalance",
            params: [address, compareBlockHex],
          });
          directBalance = String(BigInt((response as any).result));
        } catch (e) {
          directErrors++;
          appendData(ERROR_FILE, {
            timestamp: Date.now(),
            isoTime: new Date().toISOString(),
            block: compareBlock,
            type: "balance",
            address,
            source: "direct",
            error: e instanceof Error ? e.message : String(e),
          });
        }

        const refResult = await refRpcCall("eth_getBalance", [address, compareBlockHex]);
        if (refResult.error) {
          refErrors++;
          appendData(ERROR_FILE, {
            timestamp: Date.now(),
            isoTime: new Date().toISOString(),
            block: compareBlock,
            type: "balance",
            address,
            source: "reference",
            error: refResult.error,
          });
        } else {
          refBalance = String(BigInt(refResult.result as string));
        }

        if (directBalance !== null && refBalance !== null && directBalance !== refBalance) {
          readsMatched = false;
          const mismatchId = `M${++mismatchCounter}`;
          appendData(MISMATCH_FILE, {
            timestamp: Date.now(),
            isoTime: new Date().toISOString(),
            mismatchId,
            block: compareBlock,
            type: "balance",
            address,
            directValue: directBalance,
            referenceValue: refBalance,
          });
          console.error(`\n⚠️  MISMATCH [${mismatchId}] balance at block ${compareBlock}`);
        }
      }

      // eth_call test
      const callParams = { to: CHAINLINK_ETH_USD, data: LATEST_ROUND_DATA_SELECTOR };
      let directCallResult: string | null = null;
      let refCallResult: string | null = null;

      try {
        const response = await directClient.fetch({
          jsonrpc: "2.0",
          id: Date.now(),
          method: "eth_call",
          params: [callParams, compareBlockHex],
        });
        directCallResult = (response as any).result;
      } catch (e) {
        directErrors++;
      }

      const refCallRes = await refRpcCall("eth_call", [callParams, compareBlockHex]);
      if (!refCallRes.error) {
        refCallResult = refCallRes.result as string;
      } else {
        refErrors++;
      }

      if (directCallResult && refCallResult && directCallResult !== refCallResult) {
        readsMatched = false;
      }

      // ============ BATCH REQUEST TEST ============
      // Build batch: 5 requests with known IDs
      const batchRequests = [
        { method: "eth_blockNumber", params: [] },
        { method: "eth_getBalance", params: [TEST_ADDRESSES[0], compareBlockHex] },
        { method: "eth_getBalance", params: [VITALIK, compareBlockHex] },
        { method: "eth_call", params: [callParams, compareBlockHex] },
        { method: "eth_getBalance", params: [TEST_ADDRESSES[1], compareBlockHex] },
      ];

      // Direct batch
      const directBatchStart = performance.now();
      let directBatchResults: any[] = [];
      let directBatchOrdered = true;
      let directBatchError = false;
      
      try {
        const batchPayload = batchRequests.map((req, i) => ({
          jsonrpc: "2.0",
          id: i + 1,
          method: req.method,
          params: req.params,
        }));
        
        const batchResponse = await directClient.fetch(batchPayload as any);
        directBatchResults = Array.isArray(batchResponse) ? batchResponse : [batchResponse];
        
        // Check ordering: response[i].id should equal i+1
        for (let i = 0; i < directBatchResults.length; i++) {
          if (directBatchResults[i]?.id !== i + 1) {
            directBatchOrdered = false;
            break;
          }
        }
      } catch (e) {
        directBatchError = true;
        directErrors++;
      }
      const directBatchLatencyMs = performance.now() - directBatchStart;

      // Reference batch
      const refBatchStart = performance.now();
      const refBatchResult = await refRpcBatch(batchRequests);
      const refBatchLatencyMs = performance.now() - refBatchStart;
      
      let refBatchOrdered = true;
      let refBatchError = !!refBatchResult.error;
      
      if (!refBatchError && refBatchResult.results.length > 0) {
        for (let i = 0; i < refBatchResult.results.length; i++) {
          if (refBatchResult.results[i]?.id !== i + 1) {
            refBatchOrdered = false;
            break;
          }
        }
      }

      // Batch comparison - check if results match
      let batchMatched = true;
      if (!directBatchError && !refBatchError && directBatchResults.length === refBatchResult.results.length) {
        for (let i = 0; i < directBatchResults.length; i++) {
          const dRes = directBatchResults[i]?.result;
          const rRes = refBatchResult.results[i]?.result;
          if (dRes !== rRes) {
            batchMatched = false;
            break;
          }
        }
      } else if (directBatchError || refBatchError) {
        batchMatched = true; // Don't count errors as mismatches
      } else {
        batchMatched = false;
      }

      if (!batchMatched && !directBatchError && !refBatchError) {
        readsMatched = false;
      }

      // Calculate batch speedup (vs sequential)
      // Estimate sequential time as 5x single request average
      const avgSingleLatency = (directLatencyMs + refLatencyMs) / 2;
      const estimatedSequentialMs = avgSingleLatency * 5;
      const batchSpeedup = estimatedSequentialMs / directBatchLatencyMs;

      // Block deltas
      let directBlockDeltaMs: number | null = null;
      let refBlockDeltaMs: number | null = null;
      let directBlockJump = 0;
      let refBlockJump = 0;

      if (lastDirectBlock !== null && lastDirectTime !== null) {
        directBlockJump = directBlock - lastDirectBlock;
        if (directBlockJump > 0) directBlockDeltaMs = now - lastDirectTime;
      }
      if (lastRefBlock !== null && lastRefTime !== null) {
        refBlockJump = refBlock - lastRefBlock;
        if (refBlockJump > 0) refBlockDeltaMs = now - lastRefTime;
      }

      const dataPoint = {
        timestamp: now,
        isoTime: new Date(now).toISOString(),
        directBlock,
        referenceBlock: refBlock,
        drift,
        directLatencyMs,
        referenceLatencyMs: refLatencyMs,
        readsMatched,
        readCount: TEST_ADDRESSES.length + 1,
        directErrors,
        refErrors,
        // Batch metrics
        batchSize: batchRequests.length,
        directBatchLatencyMs,
        refBatchLatencyMs,
        directBatchOrdered,
        refBatchOrdered,
        batchMatched,
        batchSpeedup: Math.round(batchSpeedup * 100) / 100,
        // Memory metrics
        ...memory,
        // Block deltas
        directBlockDeltaMs,
        refBlockDeltaMs,
        directBlockJump,
        refBlockJump,
      };

      appendData(DATA_FILE, dataPoint);

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
      const batchStatus = directBatchOrdered && batchMatched ? "✓" : "✗";
      process.stdout.write(
        `\r[${new Date().toISOString()}] Blk:${directBlock} Drift:${drift} Reads:${status} Batch:${batchStatus} D:${directLatencyMs.toFixed(1)}ms R:${refLatencyMs.toFixed(1)}ms Mem:${memory.heapUsedMB}MB    `
      );

      await sleep(500);
    } catch (error) {
      console.error("\nError:", error);
      await sleep(5000);
    }
  }
}

runTest().catch(console.error);
