/**
 * Long-Running Sync Test with Statistical Data Collection
 * 
 * Uses @direct.dev/client directly (not viem wrapper)
 * Compares Direct vs reference node for drift, latency, and data consistency.
 */

import { makeDirectRPCClient } from "@direct.dev/client";
import { createPublicClient, http } from "viem";
import { mainnet } from "viem/chains";
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

const TEST_ADDRESSES = [
  "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2", // WETH
  "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48", // USDC
  "0xdAC17F958D2ee523a2206206994597C13D831ec7", // USDT
];

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

async function runTest() {
  console.log("Starting long-running sync test (using @direct.dev/client)...");
  console.log(`Project ID: ${PROJECT_ID}`);
  console.log(`Reference RPC: ${REFERENCE_RPC}`);
  console.log(`Data file: ${DATA_FILE}`);
  console.log(`Mismatch file: ${MISMATCH_FILE}`);
  console.log("");

  // Create Direct client using the SDK directly
  const directClient = makeDirectRPCClient({
    projectId: PROJECT_ID!,
    projectToken: PROJECT_TOKEN!,
    networkId: "ethereum",
  });

  // Create reference client using vanilla viem
  const referenceClient = createPublicClient({
    chain: mainnet,
    transport: http(REFERENCE_RPC),
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
      const refBlockBigInt = await referenceClient.getBlockNumber();
      const refLatencyMs = performance.now() - refStart;
      const refBlock = Number(refBlockBigInt);

      const drift = directBlock - refBlock;

      // Compare reads at the lower block number
      const compareBlock = Math.min(directBlock, refBlock);
      const compareBlockHex = "0x" + compareBlock.toString(16);
      
      let readsMatched = true;
      const mismatches: MismatchDump[] = [];

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
          const result = await referenceClient.getBalance({
            address: address as `0x${string}`,
            blockNumber: BigInt(compareBlock),
          });
          refBalance = result.toString();
        } catch (e) {
          refError = e instanceof Error ? e.message : String(e);
        }

        if (directBalance !== refBalance || directError || refError) {
          readsMatched = false;
          const mismatch: MismatchDump = {
            timestamp: Date.now(),
            isoTime: new Date().toISOString(),
            block: compareBlock,
            address,
            directValue: directBalance,
            referenceValue: refBalance,
          };
          if (directError) mismatch.directError = directError;
          if (refError) mismatch.referenceError = refError;
          
          mismatches.push(mismatch);
          appendData(MISMATCH_FILE, mismatch);
          
          console.error(`\n⚠️  MISMATCH at block ${compareBlock} for ${address}:`);
          console.error(`   Direct:    ${directBalance ?? `ERROR: ${directError}`}`);
          console.error(`   Reference: ${refBalance ?? `ERROR: ${refError}`}`);
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
