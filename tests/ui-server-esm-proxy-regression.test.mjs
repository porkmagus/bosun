import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("ui-server esm proxy targets", () => {
  it("uses a working MUI CDN URL", () => {
    const source = readFileSync(resolve(process.cwd(), "ui-server.mjs"), "utf8");
    expect(source).toContain("@mui/material@5.15.20?target=es2022&external=react,react-dom,react/jsx-runtime");
    expect(source).not.toContain("@mui/material@5?bundle&external=react,react-dom,react/jsx-runtime");
  });

  it("versions esm cache files by CDN URL hash", () => {
    const source = readFileSync(resolve(process.cwd(), "ui-server.mjs"), "utf8");
    expect(source).toContain("function getEsmCachePath");
    expect(source).toContain('createHash("sha256")');
    expect(source).toContain("const cachePath = getEsmCachePath(name, cdnUrl)");
  });
});
