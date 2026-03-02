import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

describe("voice tool capability injection regressions", () => {
  it("injects runtime tool capability prompt into /api/voice/token instructions", () => {
    const source = readFileSync(resolve(process.cwd(), "ui-server.mjs"), "utf8");
    expect(source).toContain("buildVoiceToolCapabilityPrompt");
    expect(source).toContain("voiceToolCapabilityPrompt: capabilityPrompt");
    expect(source).toContain("tokenData.instructions = [voiceCfg.instructions || \"\", capabilityPrompt]");
  });

  it("keeps voice built-in tool id mapping aligned to runtime tools", () => {
    const source = readFileSync(resolve(process.cwd(), "ui-server.mjs"), "utf8");
    expect(source).toContain('"run-command": ["run_command", "run_workspace_command"]');
    expect(source).toContain('"delegate-task": ["delegate_to_agent", "ask_agent_context", "poll_background_session"]');
    expect(source).toContain('"vision-analysis": ["query_live_view"]');
  });

  it("preserves voice-agent context fields in session-scoped instructions", () => {
    const source = readFileSync(resolve(process.cwd(), "voice-relay.mjs"), "utf8");
    expect(source).toContain("voiceToolCapabilityPrompt");
    expect(source).toContain("voiceAgentInstructions");
    expect(source).toContain("Active voice agent id:");
  });
});
