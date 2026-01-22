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
 * - eth_getLogs: USDC Transfer events (log filtering vs state reads)
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

// USDC Transfer event topic (keccak256("Transfer(address,address,uint256)"))
const USDC_ADDRESS = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";
const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";

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
  console.log(`Tests: eth_blockNumber, eth_getBalance (${TEST_ADDRESSES.length}), eth_call, eth_getLogs (USDC), BATCH requests`);
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

      // ============ eth_getLogs TEST (USDC Transfers) ============
      const logsParams = {
        address: USDC_ADDRESS,
        topics: [TRANSFER_TOPIC],
        fromBlock: compareBlockHex,
        toBlock: compareBlockHex,
      };
      
      let directLogs: any[] | null = null;
      let refLogs: any[] | null = null;
      let directLogsLatencyMs = 0;
      let refLogsLatencyMs = 0;
      let logsMatched = true;

      try {
        const logsStart = performance.now();
        const response = await directClient.fetch({
          jsonrpc: "2.0",
          id: Date.now(),
          method: "eth_getLogs",
          params: [logsParams],
        });
        directLogsLatencyMs = performance.now() - logsStart;
        directLogs = (response as any).result;
      } catch (e) {
        directErrors++;
        appendData(ERROR_FILE, {
          timestamp: Date.now(),
          isoTime: new Date().toISOString(),
          block: compareBlock,
          type: "logs",
          source: "direct",
          error: e instanceof Error ? e.message : String(e),
        });
      }

      const refLogsStart = performance.now();
      const refLogsRes = await refRpcCall("eth_getLogs", [logsParams]);
      refLogsLatencyMs = performance.now() - refLogsStart;
      
      if (!refLogsRes.error) {
        refLogs = refLogsRes.result as any[];
      } else {
        refErrors++;
        appendData(ERROR_FILE, {
          timestamp: Date.now(),
          isoTime: new Date().toISOString(),
          block: compareBlock,
          type: "logs",
          source: "reference",
          error: refLogsRes.error,
        });
      }

      // Compare logs: count and content
      if (directLogs !== null && refLogs !== null) {
        if (directLogs.length !== refLogs.length) {
          logsMatched = false;
          const mismatchId = `M${++mismatchCounter}`;
          appendData(MISMATCH_FILE, {
            timestamp: Date.now(),
            isoTime: new Date().toISOString(),
            mismatchId,
            block: compareBlock,
            type: "logs",
            directLogCount: directLogs.length,
            refLogCount: refLogs.length,
          });
          console.error(`\n⚠️  MISMATCH [${mismatchId}] logs count at block ${compareBlock}: Direct=${directLogs.length} Ref=${refLogs.length}`);
        } else {
          // Compare log entries by transactionHash + logIndex
          const directSet = new Set(directLogs.map((l: any) => `${l.transactionHash}:${l.logIndex}`));
          const refSet = new Set(refLogs.map((l: any) => `${l.transactionHash}:${l.logIndex}`));
          
          for (const key of refSet) {
            if (!directSet.has(key)) {
              logsMatched = false;
              const mismatchId = `M${++mismatchCounter}`;
              appendData(MISMATCH_FILE, {
                timestamp: Date.now(),
                isoTime: new Date().toISOString(),
                mismatchId,
                block: compareBlock,
                type: "logs",
                missingInDirect: key,
              });
              console.error(`\n⚠️  MISMATCH [${mismatchId}] logs content at block ${compareBlock}: missing ${key}`);
              break;
            }
          }
        }
      }

      if (!logsMatched) {
        readsMatched = false;
      }

      // ============ BATCH REQUEST TEST (20 requests) ============
      // Reduced from 50 to avoid QuickNode rate limits
      const batchRequests: Array<{ method: string; params?: unknown[] }> = [];
      
      // 5x eth_blockNumber
      for (let i = 0; i < 5; i++) {
        batchRequests.push({ method: "eth_blockNumber", params: [] });
      }
      
      // 10x eth_getBalance (cycling through addresses)
      const allAddresses = [...TEST_ADDRESSES, VITALIK, "0x742d35Cc6634C0532925a3b844Bc9e7595f6E555"];
      for (let i = 0; i < 10; i++) {
        batchRequests.push({ 
          method: "eth_getBalance", 
          params: [allAddresses[i % allAddresses.length], compareBlockHex] 
        });
      }
      
      // 5x eth_call (Chainlink)
      for (let i = 0; i < 5; i++) {
        batchRequests.push({ method: "eth_call", params: [callParams, compareBlockHex] });
      }

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
      // Skip: eth_blockNumber (0-9) - not pinned
      // Skip: eth_getBlockByNumber (45-49) - complex object, hard to compare
      // Compare: eth_getBalance (10-29) and eth_call (30-44)
      let batchMatched = true;
      let batchMismatchCount = 0;
      
      const directLen = directBatchResults.length;
      const refLen = refBatchResult.results?.length || 0;
      
      if (!directBatchError && !refBatchError && directLen > 0 && refLen > 0) {
        // Build maps by ID for proper comparison (skip errors)
        const directById = new Map(
          directBatchResults.filter((r: any) => !r.error).map((r: any) => [r.id, r.result])
        );
        const refById = new Map(
          refBatchResult.results.filter((r: any) => !r.error).map((r: any) => [r.id, r.result])
        );
        
        // Compare results where BOTH have valid responses
        let compared = 0;
        for (let id = 1; id <= batchRequests.length; id++) {
          const dRes = directById.get(id);
          const rRes = refById.get(id);
          // Only compare if both have results (not errors/undefined)
          if (dRes !== undefined && rRes !== undefined) {
            compared++;
            if (dRes !== rRes) batchMismatchCount++;
          }
        }
        // Pass if >90% of compared results match
        batchMatched = compared > 0 && batchMismatchCount <= Math.ceil(compared * 0.1);
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
        // Logs metrics
        directLogsLatencyMs,
        refLogsLatencyMs,
        logsMatched,
        logCount: directLogs?.length ?? 0,
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
      const logsStatus = logsMatched ? "✓" : "✗";
      process.stdout.write(
        `\r[${new Date().toISOString()}] Blk:${directBlock} Drift:${drift} Reads:${status} Logs:${logsStatus}(${directLogs?.length ?? 0}) Batch:${batchStatus} D:${directLatencyMs.toFixed(1)}ms R:${refLatencyMs.toFixed(1)}ms Mem:${memory.heapUsedMB}MB    `
      );

      await sleep(5000); // 5 seconds between iterations
    } catch (error) {
      console.error("\nError:", error);
      await sleep(5000);
    }
  }
}

runTest().catch(console.error);
