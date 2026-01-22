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

const REFERENCE_RPC = "https://eth.llamarpc.com";
const DATA_FILE = process.env.DATA_FILE || "/tmp/e2e-sync-data.ndjson";
const MISMATCH_FILE = DATA_FILE.replace(/\.ndjson$/, "-mismatches.ndjson");

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
  block: number;
  type: "balance" | "call";
  address: string;
  directValue: string | null;
  referenceValue: string | null;
  directError?: string;
  referenceError?: string;
  retriedAfter5s?: boolean;
  retryMatched?: boolean;
  retryReferenceValue?: string | null;
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

// Raw fetch for reference RPC (no caching)
async function refRpcCall(method: string, params?: unknown[]): Promise<unknown> {
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
    throw new Error(`HTTP ${response.status}: ${response.statusText}`);
  }
  
  const json = await response.json();
  if (json.error) {
    throw new Error(json.error.message);
  }
  
  return json.result;
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function runTest() {
  console.log("Starting long-running sync test...");
  console.log(`Direct: @direct.dev/client`);
  console.log(`Reference: raw fetch to ${REFERENCE_RPC}`);
  console.log(`Data file: ${DATA_FILE}`);
  console.log(`Mismatch file: ${MISMATCH_FILE}`);
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
      const refBlockHex = await refRpcCall("eth_blockNumber");
      const refLatencyMs = performance.now() - refStart;
      const refBlock = Number(refBlockHex);

      const drift = directBlock - refBlock;

      // Compare reads at the lower block number
      const compareBlock = Math.min(directBlock, refBlock);
      const compareBlockHex = "0x" + compareBlock.toString(16);
      
      let readsMatched = true;
      const mismatches: MismatchDump[] = [];

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
        }

        try {
          const result = await refRpcCall("eth_getBalance", [address, compareBlockHex]);
          refBalance = String(BigInt(result as string));
        } catch (e) {
          refError = e instanceof Error ? e.message : String(e);
        }

        if (directBalance !== refBalance || directError || refError) {
          readsMatched = false;
          
          // Retry reference after 5 seconds to check if mismatch persists
          console.error(`\n⚠️  MISMATCH (balance) at block ${compareBlock} for ${address} - retrying reference in 5s...`);
          await sleep(5000);
          
          let retryRefBalance: string | null = null;
          let retryMatched = false;
          try {
            const retryResult = await refRpcCall("eth_getBalance", [address, compareBlockHex]);
            retryRefBalance = String(BigInt(retryResult as string));
            retryMatched = directBalance === retryRefBalance;
          } catch (e) {
            // Retry also failed
          }

          const mismatch: MismatchDump = {
            timestamp: Date.now(),
            isoTime: new Date().toISOString(),
            block: compareBlock,
            type: "balance",
            address,
            directValue: directBalance,
            referenceValue: refBalance,
            retriedAfter5s: true,
            retryMatched,
            retryReferenceValue: retryRefBalance,
          };
          if (directError) mismatch.directError = directError;
          if (refError) mismatch.referenceError = refError;
          
          mismatches.push(mismatch);
          appendData(MISMATCH_FILE, mismatch);
          
          console.error(`   Direct:    ${directBalance ?? `ERROR: ${directError}`}`);
          console.error(`   Reference: ${refBalance ?? `ERROR: ${refError}`}`);
          console.error(`   Retry:     ${retryRefBalance ?? "failed"} (${retryMatched ? "NOW MATCHES - ref hiccup" : "STILL MISMATCHED"})`);
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
        }

        try {
          const result = await refRpcCall("eth_call", [callParams, compareBlockHex]);
          refCallResult = result as string;
        } catch (e) {
          refError = e instanceof Error ? e.message : String(e);
        }

        if (directCallResult !== refCallResult || directError || refError) {
          readsMatched = false;
          
          // Retry reference after 5 seconds
          console.error(`\n⚠️  MISMATCH (eth_call) at block ${compareBlock} for Chainlink ETH/USD - retrying reference in 5s...`);
          await sleep(5000);
          
          let retryRefResult: string | null = null;
          let retryMatched = false;
          try {
            retryRefResult = await refRpcCall("eth_call", [callParams, compareBlockHex]) as string;
            retryMatched = directCallResult === retryRefResult;
          } catch (e) {
            // Retry failed
          }

          const mismatch: MismatchDump = {
            timestamp: Date.now(),
            isoTime: new Date().toISOString(),
            block: compareBlock,
            type: "call",
            address: CHAINLINK_ETH_USD,
            directValue: directCallResult,
            referenceValue: refCallResult,
            retriedAfter5s: true,
            retryMatched,
            retryReferenceValue: retryRefResult,
          };
          if (directError) mismatch.directError = directError;
          if (refError) mismatch.referenceError = refError;
          
          mismatches.push(mismatch);
          appendData(MISMATCH_FILE, mismatch);
          
          console.error(`   Direct:    ${directCallResult?.slice(0, 66) ?? `ERROR: ${directError}`}...`);
          console.error(`   Reference: ${refCallResult?.slice(0, 66) ?? `ERROR: ${refError}`}...`);
          console.error(`   Retry:     ${retryMatched ? "NOW MATCHES - ref hiccup" : "STILL MISMATCHED"}`);
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
        `\r[${new Date().toISOString()}] Direct: ${directBlock} | Ref: ${refBlock} | Drift: ${drift} | Reads: ${status} | Direct: ${directLatencyMs.toFixed(2)}ms | Ref: ${refLatencyMs.toFixed(2)}ms    `
      );

      await new Promise((resolve) => setTimeout(resolve, 500));
    } catch (error) {
      console.error("\nError during test iteration:", error);
      await new Promise((resolve) => setTimeout(resolve, 5000));
    }
  }
}

runTest().catch(console.error);
