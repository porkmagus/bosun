/**
 * agent-custom-tools.mjs — Persistent Custom Tool Library
 *
 * Inspired by Live-SWE-agent's self-evolving scaffold, this module lets agents
 * write and reuse executable helper scripts that persist across sessions.
 *
 * Storage layout:
 *   <workspace>/.bosun/tools/          workspace-scoped (higher priority)
 *   BOSUN_HOME/.bosun/tools/            global (shared across all workspaces)
 *
 * Index: .bosun/tools/index.json
 *
 * Supported script languages:
 *   .mjs  — Node.js ES module (fastest, no deps)
 *   .sh   — bash/sh shell script
 *   .py   — Python (requires python3 in PATH)
 *
 * Agent lifecycle:
 *   1. Before starting a task, load the tools context via getToolsPromptBlock()
 *      and inject into the agent system prompt.
 *   2. When an agent notices a repeated or complex subtask, create a tool via
 *      registerCustomTool() — the script is saved + indexed immediately.
 *   3. Invoke persisted tools via invokeCustomTool() within the same or future
 *      sessions. Usage stats are tracked automatically.
 *   4. High-value tools discovered across tasks can be promoted to global scope
 *      via promoteToGlobal() so all workspaces benefit.
 *
 * EXPORTS:
 *   TOOL_CATEGORIES              — canonical category list
 *   TOOL_DIR                     — relative dir within workspace/.bosun/
 *   listCustomTools(root, opts)  — query the tool index
 *   getCustomTool(root, id)      — fetch one tool entry + script text
 *   registerCustomTool(root, def)— save script + update index
 *   invokeCustomTool(root, id, args, opts) — run a tool, returns { stdout, stderr, exitCode }
 *   deleteCustomTool(root, id)   — remove tool + index entry
 *   promoteToGlobal(root, id)    — copy workspace tool to BOSUN_HOME global store
 *   recordToolUsage(root, id)    — increment usageCount + set lastUsed
 *   getToolsPromptBlock(root, opts) — formatted Markdown for agent context injection
 *   buildToolsContext(root, opts)— structured object for programmatic use
 */

import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { copyFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, extname, resolve } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

// ── Constants ─────────────────────────────────────────────────────────────────

export const TOOL_DIR = ".bosun/tools";
export const TOOL_INDEX = "index.json";

/**
 * Canonical tool categories. Agents should pick the closest match when
 * registering a new tool — this keeps the library discoverable.
 *
 * @type {Readonly<string[]>}
 */
export const TOOL_CATEGORIES = Object.freeze([
  "analysis",   // codebase inspection, pattern detection, metrics
  "testing",    // test generation, test runners, assertion helpers
  "git",        // git operations beyond basic commit/push
  "build",      // compile, bundle, transpile helpers
  "transform",  // code/data transformation, codemods, reformatting
  "search",     // grep helpers, semantic search, dependency tracing
  "validation", // lint, type-check, schema validation
  "utility",    // miscellaneous helpers that don't fit elsewhere
]);

const VALID_LANGS = Object.freeze(["mjs", "sh", "py"]);

const DEFAULT_TOOL_TIMEOUT_MS = 30_000;

// ── Helpers ───────────────────────────────────────────────────────────────────

function getBosunHome() {
  return (
    process.env.BOSUN_HOME ||
    process.env.BOSUN_DIR ||
    resolve(homedir(), ".bosun")
  );
}

function getToolStore(rootDir, { global: isGlobal = false } = {}) {
  const base = isGlobal
    ? resolve(getBosunHome(), "tools")
    : resolve(rootDir, TOOL_DIR);
  mkdirSync(base, { recursive: true });
  return base;
}

function getIndexPath(storeDir) {
  return resolve(storeDir, TOOL_INDEX);
}

function safeReadIndex(storeDir) {
  const idx = getIndexPath(storeDir);
  if (!existsSync(idx)) return [];
  try {
    const parsed = JSON.parse(readFileSync(idx, "utf8"));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function saveIndex(storeDir, entries) {
  writeFileSync(
    getIndexPath(storeDir),
    JSON.stringify(entries, null, 2) + "\n",
    "utf8",
  );
}

function nowISO() {
  return new Date().toISOString();
}

function slugify(name) {
  return String(name || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 60);
}

function scriptPath(storeDir, id, lang) {
  return resolve(storeDir, `${id}.${lang}`);
}

// ── Types ─────────────────────────────────────────────────────────────────────

/**
 * @typedef {Object} CustomToolEntry
 * @property {string}   id           - unique slug (auto-derived from title if not given)
 * @property {string}   title        - short human-readable name
 * @property {string}   description  - one-line summary of what the tool does
 * @property {string[]} tags         - free-form search tags
 * @property {string}   category     - one of TOOL_CATEGORIES
 * @property {"mjs"|"sh"|"py"} lang  - script language / file extension
 * @property {string}   createdBy    - agentId or "manual"
 * @property {string}   [taskId]     - task that originated the tool
 * @property {string}   createdAt    - ISO timestamp
 * @property {string}   updatedAt    - ISO timestamp
 * @property {number}   usageCount   - number of times invoked
 * @property {string}   [lastUsed]   - ISO timestamp of last invocation
 * @property {"workspace"|"global"} scope
 */

// ── Core API ──────────────────────────────────────────────────────────────────

/**
 * List tools from workspace (and optionally merged with global).
 *
 * @param {string} rootDir
 * @param {{ category?: string, tags?: string[], scope?: 'workspace'|'global'|'all', search?: string, includeGlobal?: boolean }} [opts]
 * @returns {CustomToolEntry[]}
 */
export function listCustomTools(rootDir, opts = {}) {
  const {
    category,
    tags = [],
    scope = "all",
    search,
    includeGlobal = true,
  } = opts;

  let entries = [];

  // Workspace tools
  if (scope !== "global") {
    const wsStore = getToolStore(rootDir, { global: false });
    const wsEntries = safeReadIndex(wsStore).map((e) => ({
      ...e,
      scope: "workspace",
    }));
    entries = entries.concat(wsEntries);
  }

  // Global tools (merged in, workspace takes precedence by id)
  if (includeGlobal && scope !== "workspace") {
    const globalStore = getToolStore(rootDir, { global: true });
    const globalEntries = safeReadIndex(globalStore).map((e) => ({
      ...e,
      scope: "global",
    }));
    const wsIds = new Set(entries.map((e) => e.id));
    for (const ge of globalEntries) {
      if (!wsIds.has(ge.id)) entries.push(ge);
    }
  }

  // Filters
  if (category) {
    entries = entries.filter((e) => e.category === category);
  }
  if (tags.length > 0) {
    entries = entries.filter((e) =>
      tags.some((t) => (e.tags || []).includes(t)),
    );
  }
  if (search) {
    const q = search.toLowerCase();
    entries = entries.filter(
      (e) =>
        e.id.includes(q) ||
        e.title.toLowerCase().includes(q) ||
        e.description.toLowerCase().includes(q) ||
        (e.tags || []).some((t) => t.includes(q)),
    );
  }

  return entries.sort((a, b) => b.usageCount - a.usageCount);
}

/**
 * Get a specific tool entry and its script content.
 *
 * @param {string} rootDir
 * @param {string} toolId
 * @returns {{ entry: CustomToolEntry, script: string }|null}
 */
export function getCustomTool(rootDir, toolId) {
  // Workspace-scoped takes precedence
  for (const isGlobal of [false, true]) {
    const storeDir = getToolStore(rootDir, { global: isGlobal });
    const index = safeReadIndex(storeDir);
    const entry = index.find((e) => e.id === toolId);
    if (!entry) continue;

    const sPath = scriptPath(storeDir, entry.id, entry.lang);
    if (!existsSync(sPath)) continue;

    return {
      entry: { ...entry, scope: isGlobal ? "global" : "workspace" },
      script: readFileSync(sPath, "utf8"),
    };
  }
  return null;
}

/**
 * Register (create or update) a custom tool.
 * Saves the script file and updates index.json.
 *
 * @param {string} rootDir
 * @param {{ id?: string, title: string, description: string, tags?: string[], category: string, lang: 'mjs'|'sh'|'py', script: string, createdBy?: string, taskId?: string, global?: boolean }} def
 * @returns {CustomToolEntry}
 */
export function registerCustomTool(rootDir, def) {
  const {
    title,
    description,
    tags = [],
    category,
    lang,
    script,
    createdBy = "agent",
    taskId,
    global: isGlobal = false,
  } = def;

  if (!title || typeof title !== "string") {
    throw new TypeError("registerCustomTool: title is required");
  }
  if (!script || typeof script !== "string") {
    throw new TypeError("registerCustomTool: script is required");
  }
  if (!TOOL_CATEGORIES.includes(category)) {
    throw new RangeError(
      `registerCustomTool: invalid category "${category}". Must be one of: ${TOOL_CATEGORIES.join(", ")}`,
    );
  }
  if (!VALID_LANGS.includes(lang)) {
    throw new RangeError(
      `registerCustomTool: invalid lang "${lang}". Must be one of: ${VALID_LANGS.join(", ")}`,
    );
  }

  const storeDir = getToolStore(rootDir, { global: isGlobal });
  const index = safeReadIndex(storeDir);

  const id = def.id || slugify(title) || `tool-${Date.now()}`;
  const existingIdx = index.findIndex((e) => e.id === id);
  const now = nowISO();

  /** @type {CustomToolEntry} */
  const entry = {
    id,
    title,
    description: description || "",
    tags: Array.from(new Set(tags.map((t) => String(t).toLowerCase()))),
    category,
    lang,
    createdBy,
    ...(taskId ? { taskId } : {}),
    createdAt: existingIdx >= 0 ? index[existingIdx].createdAt : now,
    updatedAt: now,
    usageCount: existingIdx >= 0 ? index[existingIdx].usageCount ?? 0 : 0,
    ...(existingIdx >= 0 && index[existingIdx].lastUsed
      ? { lastUsed: index[existingIdx].lastUsed }
      : {}),
    scope: isGlobal ? "global" : "workspace",
  };

  // Write script file
  const sPath = scriptPath(storeDir, id, lang);
  writeFileSync(sPath, script, "utf8");
  if (lang === "sh" && process.platform !== "win32") {
    try {
      chmodSync(sPath, 0o755);
    } catch {
      /* best-effort on unsupported filesystems */
    }
  }

  // Update index
  if (existingIdx >= 0) {
    index[existingIdx] = entry;
  } else {
    index.push(entry);
  }
  saveIndex(storeDir, index);

  return entry;
}

/**
 * Invoke a custom tool by ID.
 *
 * @param {string} rootDir
 * @param {string} toolId
 * @param {string[]} [args]       - CLI arguments passed to the script
 * @param {{ timeout?: number, cwd?: string, env?: Record<string,string> }} [opts]
 * @returns {Promise<{ stdout: string, stderr: string, exitCode: number }>}
 */
export async function invokeCustomTool(rootDir, toolId, args = [], opts = {}) {
  const result = getCustomTool(rootDir, toolId);
  if (!result) {
    throw new Error(`invokeCustomTool: tool "${toolId}" not found`);
  }

  const { entry } = result;
  const isGlobal = entry.scope === "global";
  const storeDir = getToolStore(rootDir, { global: isGlobal });
  const sPath = scriptPath(storeDir, entry.id, entry.lang);

  const timeout = opts.timeout ?? DEFAULT_TOOL_TIMEOUT_MS;
  const cwd = opts.cwd ?? rootDir;
  const env = { ...process.env, ...opts.env };

  let cmd, cmdArgs;
  switch (entry.lang) {
    case "mjs":
      cmd = process.execPath; // use same node binary
      cmdArgs = [sPath, ...args];
      break;
    case "sh":
      cmd = process.platform === "win32" ? "bash" : "/bin/sh";
      cmdArgs = [sPath, ...args];
      break;
    case "py":
      cmd = "python3";
      cmdArgs = [sPath, ...args];
      break;
    default:
      throw new Error(`invokeCustomTool: unsupported lang "${entry.lang}"`);
  }

  let stdout = "";
  let stderr = "";
  let exitCode = 0;

  try {
    const out = await execFileAsync(cmd, cmdArgs, {
      cwd,
      env,
      timeout,
      maxBuffer: 10 * 1024 * 1024, // 10 MB
    });
    stdout = out.stdout;
    stderr = out.stderr;
  } catch (err) {
    stdout = err.stdout || "";
    stderr = err.stderr || err.message || "";
    exitCode = err.code ?? 1;
  }

  // Record usage non-blocking
  recordToolUsage(rootDir, toolId).catch(() => {});

  return { stdout, stderr, exitCode };
}

/**
 * Increment usageCount and update lastUsed for a tool.
 *
 * @param {string} rootDir
 * @param {string} toolId
 * @returns {Promise<void>}
 */
export async function recordToolUsage(rootDir, toolId) {
  for (const isGlobal of [false, true]) {
    const storeDir = getToolStore(rootDir, { global: isGlobal });
    const index = safeReadIndex(storeDir);
    const idx = index.findIndex((e) => e.id === toolId);
    if (idx < 0) continue;
    index[idx].usageCount = (index[idx].usageCount ?? 0) + 1;
    index[idx].lastUsed = nowISO();
    saveIndex(storeDir, index);
    return;
  }
}

/**
 * Delete a custom tool (removes script + index entry).
 *
 * @param {string} rootDir
 * @param {string} toolId
 * @param {{ global?: boolean }} [opts]
 * @returns {boolean} true if the tool was found and removed
 */
export function deleteCustomTool(rootDir, toolId, { global: isGlobal = false } = {}) {
  const storeDir = getToolStore(rootDir, { global: isGlobal });
  const index = safeReadIndex(storeDir);
  const idx = index.findIndex((e) => e.id === toolId);
  if (idx < 0) return false;

  const entry = index[idx];
  const sPath = scriptPath(storeDir, entry.id, entry.lang);
  if (existsSync(sPath)) {
    try {
      rmSync(sPath);
    } catch {
      /* best effort */
    }
  }

  index.splice(idx, 1);
  saveIndex(storeDir, index);
  return true;
}

/**
 * Promote a workspace-scoped tool to the global store.
 * This makes the tool available across all workspaces on this machine.
 *
 * @param {string} rootDir
 * @param {string} toolId
 * @returns {Promise<CustomToolEntry>} the entry as it now exists in global scope
 */
export async function promoteToGlobal(rootDir, toolId) {
  const wsStore = getToolStore(rootDir, { global: false });
  const wsIndex = safeReadIndex(wsStore);
  const wsEntry = wsIndex.find((e) => e.id === toolId);
  if (!wsEntry) {
    throw new Error(
      `promoteToGlobal: workspace tool "${toolId}" not found`,
    );
  }

  const srcPath = scriptPath(wsStore, wsEntry.id, wsEntry.lang);
  if (!existsSync(srcPath)) {
    throw new Error(
      `promoteToGlobal: script file for "${toolId}" missing`,
    );
  }

  const globalStore = getToolStore(rootDir, { global: true });
  const globalIndex = safeReadIndex(globalStore);

  // Copy script
  const destPath = scriptPath(globalStore, wsEntry.id, wsEntry.lang);
  await copyFile(srcPath, destPath);

  // Upsert in global index
  const globalEntry = { ...wsEntry, scope: "global", updatedAt: nowISO() };
  const existingIdx = globalIndex.findIndex((e) => e.id === toolId);
  if (existingIdx >= 0) {
    globalIndex[existingIdx] = globalEntry;
  } else {
    globalIndex.push(globalEntry);
  }
  saveIndex(globalStore, globalIndex);

  return globalEntry;
}

// ── Agent Context Integration ─────────────────────────────────────────────────

/**
 * Returns a Markdown block listing available custom tools.
 * Inject this into the agent system prompt so agents know what's available
 * and reflect on whether to create new tools.
 *
 * @param {string} rootDir
 * @param {{ limit?: number, category?: string, tags?: string[], emitReflectHint?: boolean }} [opts]
 * @returns {string}
 */
export function getToolsPromptBlock(rootDir, opts = {}) {
  const { limit = 12, category, tags, emitReflectHint = true } = opts;
  const tools = listCustomTools(rootDir, { category, tags }).slice(0, limit);

  const lines = [
    "## Custom Tools Library",
    "",
    "The following reusable helper scripts are available in `.bosun/tools/`.",
    "Run them via `node <tool>.mjs`, `bash <tool>.sh`, or `python3 <tool>.py`.",
    "",
  ];

  if (tools.length === 0) {
    lines.push("_(No custom tools registered yet.)_");
  } else {
    // Group by category
    /** @type {Map<string, CustomToolEntry[]>} */
    const byCategory = new Map();
    for (const t of tools) {
      const cat = t.category ?? "utility";
      if (!byCategory.has(cat)) byCategory.set(cat, []);
      byCategory.get(cat).push(t);
    }

    for (const [cat, entries] of byCategory) {
      lines.push(`### ${cat}`);
      for (const e of entries) {
        const scopeTag = e.scope === "global" ? " *(global)*" : "";
        const usageTag =
          e.usageCount > 0 ? ` — used ${e.usageCount}×` : "";
        lines.push(`- **${e.id}.${e.lang}** — ${e.description}${scopeTag}${usageTag}`);
        if (e.tags?.length > 0) {
          lines.push(`  Tags: \`${e.tags.join("`, `")}\``);
        }
      }
      lines.push("");
    }
  }

  if (emitReflectHint) {
    lines.push(
      "---",
      "",
      "**Reflect:** Before writing repetitive inline code, check if an existing",
      "custom tool covers the need. If you encounter a pattern that future agents",
      "(or yourself on retry) would benefit from having as a persistent script,",
      "save it to `.bosun/tools/` and register it via the Bosun SDK so the whole",
      "team benefits. Good candidates: analysis helpers, test generators, codemods,",
      "build/lint wrappers that differ from what `npm run *` provides.",
      "",
    );
  }

  return lines.join("\n");
}

/**
 * Return a structured context object for programmatic consumption
 * (e.g., UI display, analytics, or downstream processing).
 *
 * @param {string} rootDir
 * @param {{ limit?: number }} [opts]
 * @returns {{ tools: CustomToolEntry[], categories: Record<string, number>, totalGlobal: number, totalWorkspace: number }}
 */
export function buildToolsContext(rootDir, opts = {}) {
  const { limit = 50 } = opts;
  const allTools = listCustomTools(rootDir, { includeGlobal: true });
  const tools = allTools.slice(0, limit);

  const categories = {};
  let totalGlobal = 0;
  let totalWorkspace = 0;
  for (const t of allTools) {
    categories[t.category] = (categories[t.category] ?? 0) + 1;
    if (t.scope === "global") totalGlobal++;
    else totalWorkspace++;
  }

  return { tools, categories, totalGlobal, totalWorkspace };
}
