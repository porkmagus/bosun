import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  TOOL_CATEGORIES,
  TOOL_DIR,
  buildToolsContext,
  deleteCustomTool,
  getCustomTool,
  getToolsPromptBlock,
  invokeCustomTool,
  listCustomTools,
  promoteToGlobal,
  recordToolUsage,
  registerCustomTool,
} from "../agent-custom-tools.mjs";

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------
let tmpRoot;

beforeEach(() => {
  tmpRoot = join(tmpdir(), `bosun-ctool-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(tmpRoot, { recursive: true });
});

afterEach(() => {
  try {
    rmSync(tmpRoot, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
});

function makeTool(overrides = {}) {
  return {
    title: "Test analysis helper",
    description: "A test tool for analysis",
    category: "analysis",
    lang: "mjs",
    tags: ["test", "analysis"],
    script: `#!/usr/bin/env node\nconsole.log("hello from tool");`,
    createdBy: "test-agent",
    taskId: "task-001",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------
describe("TOOL_CATEGORIES", () => {
  it("is frozen", () => {
    expect(Object.isFrozen(TOOL_CATEGORIES)).toBe(true);
  });

  it("contains all expected categories", () => {
    for (const cat of [
      "analysis", "testing", "git", "build",
      "transform", "search", "validation", "utility",
    ]) {
      expect(TOOL_CATEGORIES).toContain(cat);
    }
  });
});

describe("TOOL_DIR", () => {
  it("is the expected relative path", () => {
    expect(TOOL_DIR).toBe(".bosun/tools");
  });
});

// ---------------------------------------------------------------------------
// registerCustomTool
// ---------------------------------------------------------------------------
describe("registerCustomTool", () => {
  it("writes script file and index entry", () => {
    const entry = registerCustomTool(tmpRoot, makeTool());
    expect(entry.id).toBeTruthy();
    expect(entry.title).toBe("Test analysis helper");
    expect(entry.category).toBe("analysis");
    expect(entry.lang).toBe("mjs");
    expect(entry.usageCount).toBe(0);
    expect(entry.createdAt).toBeTruthy();
  });

  it("derives id from title if not provided", () => {
    const entry = registerCustomTool(tmpRoot, makeTool({ title: "My Cool Tool!!!" }));
    expect(entry.id).toBe("my-cool-tool");
  });

  it("uses explicit id when provided", () => {
    const entry = registerCustomTool(tmpRoot, makeTool({ id: "explicit-id" }));
    expect(entry.id).toBe("explicit-id");
  });

  it("persists script to disk (readable via getCustomTool)", () => {
    registerCustomTool(tmpRoot, makeTool({ id: "my-tool" }));
    const result = getCustomTool(tmpRoot, "my-tool");
    expect(result).not.toBeNull();
    expect(result.script).toContain("hello from tool");
    expect(result.entry.id).toBe("my-tool");
  });

  it("updates an existing tool when called with same id", () => {
    registerCustomTool(tmpRoot, makeTool({ id: "dup-tool" }));
    const updated = registerCustomTool(
      tmpRoot,
      makeTool({
        id: "dup-tool",
        description: "Updated description",
        script: `console.log("v2");`,
      }),
    );
    expect(updated.description).toBe("Updated description");

    const result = getCustomTool(tmpRoot, "dup-tool");
    expect(result.script).toContain("v2");

    // Still only one entry in the index
    const all = listCustomTools(tmpRoot, { includeGlobal: false });
    expect(all.filter((e) => e.id === "dup-tool")).toHaveLength(1);
  });

  it("throws TypeError when title is missing", () => {
    expect(() =>
      registerCustomTool(tmpRoot, { ...makeTool(), title: "" }),
    ).toThrow(TypeError);
  });

  it("throws TypeError when script is missing", () => {
    expect(() =>
      registerCustomTool(tmpRoot, { ...makeTool(), script: "" }),
    ).toThrow(TypeError);
  });

  it("throws RangeError for invalid category", () => {
    expect(() =>
      registerCustomTool(tmpRoot, makeTool({ category: "unknown-cat" })),
    ).toThrow(RangeError);
  });

  it("throws RangeError for invalid lang", () => {
    expect(() =>
      registerCustomTool(tmpRoot, makeTool({ lang: "tsx" })),
    ).toThrow(RangeError);
  });

  it("normalises tags to lowercase and deduplicates", () => {
    const entry = registerCustomTool(
      tmpRoot,
      makeTool({ tags: ["ANALYSIS", "analysis", "TEST"] }),
    );
    expect(entry.tags).toEqual(expect.arrayContaining(["analysis", "test"]));
    expect(entry.tags.filter((t) => t === "analysis")).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// getCustomTool
// ---------------------------------------------------------------------------
describe("getCustomTool", () => {
  it("returns null for non-existent tool", () => {
    expect(getCustomTool(tmpRoot, "does-not-exist")).toBeNull();
  });

  it("returns entry and script for existing tool", () => {
    registerCustomTool(tmpRoot, makeTool({ id: "found-tool" }));
    const result = getCustomTool(tmpRoot, "found-tool");
    expect(result).not.toBeNull();
    expect(result.entry.id).toBe("found-tool");
    expect(typeof result.script).toBe("string");
  });
});

// ---------------------------------------------------------------------------
// listCustomTools
// ---------------------------------------------------------------------------
describe("listCustomTools", () => {
  beforeEach(() => {
    registerCustomTool(tmpRoot, makeTool({ id: "t1", title: "T1", category: "analysis", tags: ["a"] }));
    registerCustomTool(tmpRoot, makeTool({ id: "t2", title: "T2", category: "testing", tags: ["b"] }));
    registerCustomTool(tmpRoot, makeTool({ id: "t3", title: "T3", category: "git", tags: ["a", "c"] }));
  });

  it("returns all workspace tools", () => {
    const tools = listCustomTools(tmpRoot, { includeGlobal: false });
    expect(tools.map((t) => t.id)).toEqual(
      expect.arrayContaining(["t1", "t2", "t3"]),
    );
  });

  it("filters by category", () => {
    const tools = listCustomTools(tmpRoot, { category: "analysis", includeGlobal: false });
    expect(tools.map((t) => t.id)).toEqual(["t1"]);
  });

  it("filters by tags (OR match)", () => {
    const tools = listCustomTools(tmpRoot, { tags: ["a"], includeGlobal: false });
    const ids = tools.map((t) => t.id);
    expect(ids).toContain("t1");
    expect(ids).toContain("t3");
    expect(ids).not.toContain("t2");
  });

  it("filters by search string in title", () => {
    const tools = listCustomTools(tmpRoot, { search: "t2", includeGlobal: false });
    expect(tools.map((t) => t.id)).toContain("t2");
  });

  it("returns workspace tools sorted by usageCount descending", async () => {
    await recordToolUsage(tmpRoot, "t3");
    await recordToolUsage(tmpRoot, "t3");
    await recordToolUsage(tmpRoot, "t1");

    const tools = listCustomTools(tmpRoot, { includeGlobal: false });
    expect(tools[0].id).toBe("t3");
    expect(tools[1].id).toBe("t1");
  });

  it("marks scope as 'workspace'", () => {
    const tools = listCustomTools(tmpRoot, { includeGlobal: false });
    expect(tools.every((t) => t.scope === "workspace")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// deleteCustomTool
// ---------------------------------------------------------------------------
describe("deleteCustomTool", () => {
  it("removes tool from index and returns true", () => {
    registerCustomTool(tmpRoot, makeTool({ id: "del-tool" }));
    const result = deleteCustomTool(tmpRoot, "del-tool");
    expect(result).toBe(true);
    expect(getCustomTool(tmpRoot, "del-tool")).toBeNull();
  });

  it("returns false for non-existent tool", () => {
    const result = deleteCustomTool(tmpRoot, "ghost-tool");
    expect(result).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// recordToolUsage
// ---------------------------------------------------------------------------
describe("recordToolUsage", () => {
  it("increments usageCount", async () => {
    registerCustomTool(tmpRoot, makeTool({ id: "counted-tool" }));
    await recordToolUsage(tmpRoot, "counted-tool");
    await recordToolUsage(tmpRoot, "counted-tool");

    const result = getCustomTool(tmpRoot, "counted-tool");
    expect(result.entry.usageCount).toBe(2);
    expect(result.entry.lastUsed).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// promoteToGlobal
// ---------------------------------------------------------------------------
describe("promoteToGlobal", () => {
  it("throws when tool does not exist in workspace", async () => {
    await expect(promoteToGlobal(tmpRoot, "no-such-tool")).rejects.toThrow();
  });

  it("copies tool to global store", async () => {
    // Override BOSUN_HOME to use a temp dir so we don't pollute the real home
    const fakeHome = join(tmpRoot, "fake-bosun-home");
    mkdirSync(fakeHome, { recursive: true });
    const origHome = process.env.BOSUN_HOME;
    process.env.BOSUN_HOME = fakeHome;

    try {
      registerCustomTool(tmpRoot, makeTool({ id: "promote-me" }));
      const globalEntry = await promoteToGlobal(tmpRoot, "promote-me");
      expect(globalEntry.scope).toBe("global");

      // Should be discoverable via listCustomTools with global scope
      const globals = listCustomTools(tmpRoot, { scope: "global" });
      expect(globals.map((t) => t.id)).toContain("promote-me");
    } finally {
      if (origHome == null) delete process.env.BOSUN_HOME;
      else process.env.BOSUN_HOME = origHome;
    }
  });
});

// ---------------------------------------------------------------------------
// getToolsPromptBlock
// ---------------------------------------------------------------------------
describe("getToolsPromptBlock", () => {
  it("returns '_(No custom tools registered yet.)_' when empty", () => {
    const block = getToolsPromptBlock(tmpRoot);
    expect(block).toContain("No custom tools registered yet");
  });

  it("includes tool id and description when tools exist", () => {
    registerCustomTool(tmpRoot, makeTool({ id: "search-helper", description: "Scans imports" }));
    const block = getToolsPromptBlock(tmpRoot);
    expect(block).toContain("search-helper.mjs");
    expect(block).toContain("Scans imports");
  });

  it("includes reflect hint by default", () => {
    const block = getToolsPromptBlock(tmpRoot);
    expect(block).toContain("Reflect:");
  });

  it("omits reflect hint when emitReflectHint=false", () => {
    const block = getToolsPromptBlock(tmpRoot, { emitReflectHint: false });
    expect(block).not.toContain("Reflect:");
  });

  it("groups tools by category", () => {
    registerCustomTool(tmpRoot, makeTool({ id: "a1", category: "analysis" }));
    registerCustomTool(tmpRoot, makeTool({ id: "g1", category: "git", title: "git helper", description: "helps git" }));
    const block = getToolsPromptBlock(tmpRoot);
    expect(block).toContain("### analysis");
    expect(block).toContain("### git");
  });
});

// ---------------------------------------------------------------------------
// buildToolsContext
// ---------------------------------------------------------------------------
describe("buildToolsContext", () => {
  it("returns zero counts when no tools exist", () => {
    const ctx = buildToolsContext(tmpRoot);
    expect(ctx.totalWorkspace).toBe(0);
    expect(ctx.totalGlobal).toBe(0);
    expect(ctx.tools).toHaveLength(0);
    expect(ctx.categories).toEqual({});
  });

  it("counts tools by category correctly", () => {
    registerCustomTool(tmpRoot, makeTool({ id: "c1", category: "analysis" }));
    registerCustomTool(tmpRoot, makeTool({ id: "c2", category: "analysis", title: "A2", description: "d2" }));
    registerCustomTool(tmpRoot, makeTool({ id: "c3", category: "testing", title: "T1", description: "d3" }));

    const ctx = buildToolsContext(tmpRoot);
    expect(ctx.totalWorkspace).toBe(3);
    expect(ctx.categories.analysis).toBe(2);
    expect(ctx.categories.testing).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// invokeCustomTool (integration — runs real Node.js subprocess)
// ---------------------------------------------------------------------------
describe("invokeCustomTool", () => {
  it("runs an mjs tool and captures stdout", async () => {
    registerCustomTool(
      tmpRoot,
      makeTool({
        id: "echo-tool",
        script: `console.log("tool-output-ok");`,
        lang: "mjs",
      }),
    );

    const result = await invokeCustomTool(tmpRoot, "echo-tool", [], {
      timeout: 10000,
    });
    expect(result.stdout.trim()).toBe("tool-output-ok");
    expect(result.exitCode).toBe(0);
  });

  it("captures non-zero exit code and stderr", async () => {
    registerCustomTool(
      tmpRoot,
      makeTool({
        id: "fail-tool",
        script: `process.stderr.write("oops\\n"); process.exit(1);`,
        lang: "mjs",
      }),
    );

    const result = await invokeCustomTool(tmpRoot, "fail-tool", [], {
      timeout: 10000,
    });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("oops");
  });

  it("throws when tool does not exist", async () => {
    await expect(
      invokeCustomTool(tmpRoot, "phantom-tool", []),
    ).rejects.toThrow();
  });

  it("increments usageCount after invocation", async () => {
    registerCustomTool(
      tmpRoot,
      makeTool({ id: "usage-track-tool", script: `process.exit(0);` }),
    );

    await invokeCustomTool(tmpRoot, "usage-track-tool", [], { timeout: 5000 });
    // Wait a tick for the async recordToolUsage fire-and-forget
    await new Promise((r) => setTimeout(r, 50));

    const after = getCustomTool(tmpRoot, "usage-track-tool");
    expect(after.entry.usageCount).toBe(1);
  });
});
