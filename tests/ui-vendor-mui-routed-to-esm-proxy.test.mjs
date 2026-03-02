import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("ui vendor routing for mui/emotion", () => {
  it("routes MUI/Emotion vendor requests through handleEsmProxy", () => {
    const source = readFileSync(resolve(process.cwd(), "ui-server.mjs"), "utf8");
    expect(source).toContain("Object.prototype.hasOwnProperty.call(ESM_CDN_FILES, name)");
    expect(source).toContain("await handleEsmProxy(req, res, esmUrl)");
  });
});

