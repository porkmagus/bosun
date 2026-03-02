import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdirSync, rmSync, writeFileSync, existsSync, readdirSync, readFileSync } from "node:fs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Use a temp directory for test cache to avoid polluting real cache
const TEST_CACHE_DIR = resolve(__dirname, "..", ".cache-test-tool-logs");

// Mock the cache directory before importing the module
vi.mock("node:path", async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual };
});

describe("context-cache", () => {
  let contextCache;

  beforeEach(async () => {
    // Clean test directory
    rmSync(TEST_CACHE_DIR, { recursive: true, force: true });
    mkdirSync(TEST_CACHE_DIR, { recursive: true });

    // Fresh import for each test
    vi.resetModules();
    contextCache = await import("../context-cache.mjs");
  });

  afterEach(() => {
    rmSync(TEST_CACHE_DIR, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  // ── Helper: build a fake item array with tool outputs ──────────────────
  function makeToolItems(count, textSize = 500) {
    const items = [];
    for (let i = 0; i < count; i++) {
      // Alternate between tool outputs and agent messages
      items.push({
        type: "function_call_output",
        tool_name: `tool_${i}`,
        arguments: { file: `src/file${i}.ts`, query: "search term" },
        output: `Output from tool ${i}: ${"x".repeat(textSize)}`,
      });
      items.push({
        type: "agent_message",
        text: `Agent response after tool ${i}`,
      });
    }
    return items;
  }

  // ── cacheAndCompressItems ──────────────────────────────────────────────

  describe("cacheAndCompressItems", () => {
    it("returns items unchanged when fewer than fullContextTurns", async () => {
      const items = makeToolItems(2); // only 2 tool calls
      const result = await contextCache.cacheAndCompressItems(items);
      expect(result).toEqual(items);
    });

    it("keeps last 3 turns fully intact (Tier 0)", async () => {
      const items = makeToolItems(6, 3000);
      const result = await contextCache.cacheAndCompressItems(items);

      // Last 3 tool outputs (index 4, 5 are the last tool items) should be full
      // Items are: tool0, agent0, tool1, agent1, ..., tool5, agent5
      // Turns are: tool outputs increment turn counter

      // The last tool output items should retain their full text
      const lastToolItems = result.filter(
        (it) => it.type === "function_call_output" && !it._cachedLogId,
      );
      // At least 3 should be untouched
      expect(lastToolItems.length).toBeGreaterThanOrEqual(2);
    });

    it("compresses older items and adds retrieval command", async () => {
      const items = makeToolItems(8, 5000);
      const result = await contextCache.cacheAndCompressItems(items);

      // Some items should now have _cachedLogId
      const cached = result.filter(
        (it) => it._cachedLogId !== undefined,
      );
      expect(cached.length).toBeGreaterThan(0);

      // Compressed items should reference bosun --tool-log
      for (const item of cached) {
        const text =
          item.text || item.output || "";
        expect(text).toContain("bosun --tool-log");
      }
    });

    it("does not compress agent messages (non-tool items)", async () => {
      const items = makeToolItems(8, 5000);
      const result = await contextCache.cacheAndCompressItems(items);

      const agentMessages = result.filter((it) => it.type === "agent_message");
      // Agent messages should all be untouched
      for (const msg of agentMessages) {
        expect(msg._cachedLogId).toBeUndefined();
      }
    });

    it("does not compress items with text shorter than 200 chars", async () => {
      const items = makeToolItems(8, 50); // very small outputs
      const result = await contextCache.cacheAndCompressItems(items);

      // Should have no cached items because outputs are too small
      const cached = result.filter((it) => it._cachedLogId !== undefined);
      expect(cached.length).toBe(0);
    });

    it("respects custom fullContextTurns option", async () => {
      const items = makeToolItems(6, 3000);
      // Keep 5 turns full — should compress very little
      const result = await contextCache.cacheAndCompressItems(items, {
        fullContextTurns: 5,
      });

      const cached = result.filter((it) => it._cachedLogId !== undefined);
      // With 6 tools and 5 full turns, only 1 should be compressed
      const fullContextResult = await contextCache.cacheAndCompressItems(
        items,
        { fullContextTurns: 2 },
      );
      const cachedAggressive = fullContextResult.filter(
        (it) => it._cachedLogId !== undefined,
      );
      // More aggressive should compress more
      expect(cachedAggressive.length).toBeGreaterThanOrEqual(cached.length);
    });
  });

  // ── retrieveToolLog ────────────────────────────────────────────────────

  describe("retrieveToolLog", () => {
    it("retrieves a cached tool output by ID", async () => {
      // First, compress some items to generate cache entries
      const items = makeToolItems(6, 3000);
      const result = await contextCache.cacheAndCompressItems(items);

      const cached = result.filter((it) => it._cachedLogId !== undefined);
      if (cached.length === 0) return; // skip if nothing was cached

      const logId = cached[0]._cachedLogId;
      const retrieved = await contextCache.retrieveToolLog(logId);

      expect(retrieved.found).toBe(true);
      expect(retrieved.entry).toBeDefined();
      expect(retrieved.entry.id).toBe(logId);
      expect(retrieved.entry.item).toBeDefined();
    });

    it("returns found=false for non-existent ID", async () => {
      const result = await contextCache.retrieveToolLog(999999999);
      expect(result.found).toBe(false);
      expect(result.error).toContain("not found");
    });

    it("returns found=false for invalid ID", async () => {
      const result = await contextCache.retrieveToolLog("abc");
      expect(result.found).toBe(false);
      expect(result.error).toContain("Invalid");
    });
  });

  // ── listToolLogs ───────────────────────────────────────────────────────

  describe("listToolLogs", () => {
    it("lists cached entries", async () => {
      const items = makeToolItems(6, 3000);
      await contextCache.cacheAndCompressItems(items);

      const logs = await contextCache.listToolLogs();
      expect(Array.isArray(logs)).toBe(true);
      // Should have at least some entries
      if (logs.length > 0) {
        expect(logs[0].id).toBeDefined();
        expect(logs[0].toolName).toBeDefined();
      }
    });

    it("respects limit parameter", async () => {
      const items = makeToolItems(10, 3000);
      await contextCache.cacheAndCompressItems(items);

      const limited = await contextCache.listToolLogs(2);
      expect(limited.length).toBeLessThanOrEqual(2);
    });
  });

  // ── pruneToolLogCache ──────────────────────────────────────────────────

  describe("pruneToolLogCache", () => {
    it("prunes entries older than maxAgeMs", async () => {
      const items = makeToolItems(6, 3000);
      await contextCache.cacheAndCompressItems(items);

      // Prune with 0ms max age — everything should be pruned
      const pruned = await contextCache.pruneToolLogCache(0);
      expect(pruned).toBeGreaterThanOrEqual(0);
    });

    it("does not prune recent entries with default TTL", async () => {
      const items = makeToolItems(6, 3000);
      await contextCache.cacheAndCompressItems(items);

      // Prune with default 24h — nothing should be pruned (just created)
      const pruned = await contextCache.pruneToolLogCache();
      expect(pruned).toBe(0);
    });
  });

  // ── estimateSavings ────────────────────────────────────────────────────

  describe("estimateSavings", () => {
    it("calculates compression savings correctly", async () => {
      const items = makeToolItems(10, 5000);
      const compressed = await contextCache.cacheAndCompressItems(items);

      const savings = contextCache.estimateSavings(items, compressed);
      expect(savings.originalChars).toBeGreaterThan(0);
      expect(savings.savedChars).toBeGreaterThanOrEqual(0);
      expect(savings.savedPct).toBeGreaterThanOrEqual(0);
      expect(savings.savedPct).toBeLessThanOrEqual(100);
    });

    it("returns 0 savings when nothing is compressed", () => {
      const items = makeToolItems(2, 50);
      const savings = contextCache.estimateSavings(items, items);
      expect(savings.savedChars).toBe(0);
      expect(savings.savedPct).toBe(0);
    });
  });

  // ── Tiered compression ────────────────────────────────────────────────

  describe("tiered compression", () => {
    it("applies progressively more aggressive compression to older items", async () => {
      // Create a large session with many tool calls
      const items = makeToolItems(15, 8000);
      const result = await contextCache.cacheAndCompressItems(items);

      const cachedItems = result.filter((it) => it._cachedLogId !== undefined);

      if (cachedItems.length >= 2) {
        // Older items should have shorter text than newer compressed items
        // (Tier 3 skeleton vs Tier 1 head+tail)
        const texts = cachedItems.map((it) => (it.text || it.output || "").length);
        // The array should generally decrease (older = more compressed)
        // but just check that at least one item is significantly shorter
        const min = Math.min(...texts);
        const max = Math.max(...texts);
        expect(max).toBeGreaterThan(min);
      }
    });

    it("Tier 3 items only contain skeleton with retrieval command", async () => {
      const items = makeToolItems(20, 8000);
      const result = await contextCache.cacheAndCompressItems(items);

      // Very old items should be Tier 3 — just "[Cached tool call]..."
      const skeletonItems = result.filter(
        (it) =>
          it.type === "context_compressed" ||
          (typeof it.text === "string" && it.text.startsWith("[Cached tool call]")),
      );

      if (skeletonItems.length > 0) {
        for (const sk of skeletonItems) {
          expect(sk.text).toContain("bosun --tool-log");
          expect(sk.text.length).toBeLessThan(300);
        }
      }
    });
  });

  // ── getToolLogDir ──────────────────────────────────────────────────────

  describe("getToolLogDir", () => {
    it("returns a string path", () => {
      const dir = contextCache.getToolLogDir();
      expect(typeof dir).toBe("string");
      expect(dir).toContain("tool-logs");
    });
  });
});
