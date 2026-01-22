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
 * 
 * Metrics:
 * - Mismatches: Both succeeded but values differ (retry after 5s to check for ref hiccups)
 * - Direct errors: Direct failed to return a result
 * - Reference errors: Reference failed to return a result
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
// latestRoundData() selector
const LATEST_ROUND_DATA_SELECTOR = "0xfeaf968c";

interface MismatchDump {
  timestamp: number;
  isoTime: string;
  mismatchId: string;
  block: number;
  type: "balance" | "call";
  address: string;
  directValue: string;
  referenceValue: string;
}

interface RecoveryDump {
  timestamp: number;
  isoTime: string;
  mismatchId: string;
  block: number;
  type: "balance" | "call";
  address: string;
  recovered: boolean;
  directValue: string;
  originalRefValue: string;
  retryRefValue: string | null;
}

interface ErrorDump {
  timestamp: number;
  isoTime: string;
  block: number;
  type: "balance" | "call";
  address: string;
  source: "direct" | "reference";
  error: string;
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

// Raw fetch for reference RPC (no caching)
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

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Schedule a non-blocking retry for mismatch verification
function scheduleRetry(
  mismatchId: string,
  block: number,
  type: "balance" | "call",
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

async function runTest() {
  console.log("Starting long-running sync test...");
  console.log(`Direct: @direct.dev/client`);
  console.log(`Reference: raw fetch to ${REFERENCE_RPC.split('/')[2]}`);
  console.log(`Data file: ${DATA_FILE}`);
  console.log(`Mismatch file: ${MISMATCH_FILE}`);
  console.log(`Recovery file: ${RECOVERY_FILE}`);
  console.log(`Error file: ${ERROR_FILE}`);
  console.log(`Tests: eth_blockNumber, eth_getBalance (${TEST_ADDRESSES.length}), eth_call (Chainlink ETH/USD)`);
  console.log("");

  // Create Direct client using the SDK
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

      // Get block numbers with latency measurement
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

      // Compare reads at the lower block number
      const compareBlock = Math.min(directBlock, refBlock);
      const compareBlockHex = "0x" + compareBlock.toString(16);
      
      let readsMatched = true;
      let directErrors = 0;
      let refErrors = 0;

      // Test eth_getBalance
      for (const address of TEST_ADDRESSES) {
        let directBalance: string | null = null;
        let refBalance: string | null = null;
        let directError: string | undefined;
        let refError: string | undefined;

        try {
          const response = await directClient.fetch({
            jsonrpc: "2.0",
            id: Date.now(),
            method: "eth_getBalance",
            params: [address, compareBlockHex],
          });
          directBalance = String(BigInt((response as any).result));
        } catch (e) {
          directError = e instanceof Error ? e.message : String(e);
          directErrors++;
          appendData(ERROR_FILE, {
            timestamp: Date.now(),
            isoTime: new Date().toISOString(),
            block: compareBlock,
            type: "balance",
            address,
            source: "direct",
            error: directError,
          });
        }

        const refResult = await refRpcCall("eth_getBalance", [address, compareBlockHex]);
        if (refResult.error) {
          refError = refResult.error;
          refErrors++;
          appendData(ERROR_FILE, {
            timestamp: Date.now(),
            isoTime: new Date().toISOString(),
            block: compareBlock,
            type: "balance",
            address,
            source: "reference",
            error: refError,
          });
        } else {
          refBalance = String(BigInt(refResult.result as string));
        }

        // Only count as mismatch if BOTH succeeded but values differ
        if (directBalance !== null && refBalance !== null && directBalance !== refBalance) {
          readsMatched = false;
          const mismatchId = `M${++mismatchCounter}`;
          
          const mismatch: MismatchDump = {
            timestamp: Date.now(),
            isoTime: new Date().toISOString(),
            mismatchId,
            block: compareBlock,
            type: "balance",
            address,
            directValue: directBalance,
            referenceValue: refBalance,
          };
          
          appendData(MISMATCH_FILE, mismatch);
          
          console.error(`\n⚠️  MISMATCH [${mismatchId}] (balance) at block ${compareBlock} for ${address}`);
          console.error(`   Direct:    ${directBalance}`);
          console.error(`   Reference: ${refBalance}`);
          
          // Schedule non-blocking retry
          const capturedBlockHex = compareBlockHex;
          const capturedAddress = address;
          const capturedRefBalance = refBalance;
          scheduleRetry(
            mismatchId,
            compareBlock,
            "balance",
            address,
            directBalance,
            capturedRefBalance,
            async () => {
              const result = await refRpcCall("eth_getBalance", [capturedAddress, capturedBlockHex]);
              if (result.error) return null;
              return String(BigInt(result.result as string));
            }
          );
        }
      }

      // Test eth_call (Chainlink ETH/USD latestRoundData)
      {
        let directCallResult: string | null = null;
        let refCallResult: string | null = null;
        let directError: string | undefined;
        let refError: string | undefined;

        const callParams = {
          to: CHAINLINK_ETH_USD,
          data: LATEST_ROUND_DATA_SELECTOR,
        };

        try {
          const response = await directClient.fetch({
            jsonrpc: "2.0",
            id: Date.now(),
            method: "eth_call",
            params: [callParams, compareBlockHex],
          });
          directCallResult = (response as any).result;
        } catch (e) {
          directError = e instanceof Error ? e.message : String(e);
          directErrors++;
          appendData(ERROR_FILE, {
            timestamp: Date.now(),
            isoTime: new Date().toISOString(),
            block: compareBlock,
            type: "call",
            address: CHAINLINK_ETH_USD,
            source: "direct",
            error: directError,
          });
        }

        const refResult = await refRpcCall("eth_call", [callParams, compareBlockHex]);
        if (refResult.error) {
          refError = refResult.error;
          refErrors++;
          appendData(ERROR_FILE, {
            timestamp: Date.now(),
            isoTime: new Date().toISOString(),
            block: compareBlock,
            type: "call",
            address: CHAINLINK_ETH_USD,
            source: "reference",
            error: refError,
          });
        } else {
          refCallResult = refResult.result as string;
        }

        // Only count as mismatch if BOTH succeeded but values differ
        if (directCallResult !== null && refCallResult !== null && directCallResult !== refCallResult) {
          readsMatched = false;
          const mismatchId = `M${++mismatchCounter}`;
          
          const mismatch: MismatchDump = {
            timestamp: Date.now(),
            isoTime: new Date().toISOString(),
            mismatchId,
            block: compareBlock,
            type: "call",
            address: CHAINLINK_ETH_USD,
            directValue: directCallResult,
            referenceValue: refCallResult,
          };
          
          appendData(MISMATCH_FILE, mismatch);
          
          console.error(`\n⚠️  MISMATCH [${mismatchId}] (eth_call) at block ${compareBlock} for Chainlink ETH/USD`);
          console.error(`   Direct:    ${directCallResult.slice(0, 66)}...`);
          console.error(`   Reference: ${refCallResult.slice(0, 66)}...`);
          
          // Schedule non-blocking retry
          const capturedBlockHex = compareBlockHex;
          const capturedCallParams = { ...callParams };
          const capturedRefResult = refCallResult;
          scheduleRetry(
            mismatchId,
            compareBlock,
            "call",
            CHAINLINK_ETH_USD,
            directCallResult,
            capturedRefResult,
            async () => {
              const result = await refRpcCall("eth_call", [capturedCallParams, capturedBlockHex]);
              if (result.error) return null;
              return result.result as string;
            }
          );
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
        directLatencyMs,
        referenceLatencyMs: refLatencyMs,
        readsMatched,
        readCount: TEST_ADDRESSES.length + 1, // +1 for eth_call
        directErrors,
        refErrors,
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
      const errorInfo = (directErrors || refErrors) ? ` | Errs: D${directErrors}/R${refErrors}` : "";
      process.stdout.write(
        `\r[${new Date().toISOString()}] Direct: ${directBlock} | Ref: ${refBlock} | Drift: ${drift} | Reads: ${status}${errorInfo} | Direct: ${directLatencyMs.toFixed(2)}ms | Ref: ${refLatencyMs.toFixed(2)}ms    `
      );

      await new Promise((resolve) => setTimeout(resolve, 500));
    } catch (error) {
      console.error("\nError during test iteration:", error);
      await new Promise((resolve) => setTimeout(resolve, 5000));
    }
  }
}

runTest().catch(console.error);
