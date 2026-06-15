import { describe, it, expect } from "vitest";
import { hslComponentsToHex } from "../monacoAppTheme";

describe("hslComponentsToHex", () => {
  it("converts space-separated HSL components to hex for Monaco", () => {
    expect(hslComponentsToHex("215 14% 17%")).toMatch(/^#[0-9a-f]{6}$/i);
    expect(hslComponentsToHex("0 0% 100%")).toBe("#ffffff");
    expect(hslComponentsToHex("0 0% 0%")).toBe("#000000");
  });

  it("passes through hex values", () => {
    expect(hslComponentsToHex("#1e1e1e")).toBe("#1e1e1e");
  });
});
