import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("ui-server esm proxy rewrite guards", () => {
  it("rewrites esm.sh absolute import specifiers and guards dynamic require payloads", () => {
    const source = readFileSync(resolve(process.cwd(), "ui-server.mjs"), "utf8");
    expect(source).toContain("function normalizeEsmProxyBody");
    expect(source).toContain("https://esm.sh/");
    expect(source).toContain("function hasUnsupportedCjsRuntime");
    expect(source).toContain("Dynamic require of \"react\"");
  });
});

