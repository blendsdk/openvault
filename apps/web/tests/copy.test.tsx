import { afterEach, describe, expect, it, vi } from "vitest";
import {
  copyCredential,
  resetCredentialCopyForTest,
  subscribeCredentialCopy,
} from "../src/components/credential-copy.js";

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  resetCredentialCopyForTest();
});

describe("credential clipboard", () => {
  it("should clear the clipboard after thirty seconds", async () => {
    vi.useFakeTimers();
    const writeText = vi.spyOn(navigator.clipboard, "writeText").mockResolvedValue(undefined);

    await copyCredential("join-token");
    expect(writeText).toHaveBeenCalledWith("join-token");

    await vi.advanceTimersByTimeAsync(30_000);
    expect(writeText).toHaveBeenLastCalledWith("");
  });

  it("should report a denied clear and keep the manual instruction visible", async () => {
    vi.useFakeTimers();
    const messages: string[] = [];
    subscribeCredentialCopy((result) => messages.push(result.message));
    vi.spyOn(navigator.clipboard, "writeText")
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error("denied"));

    await copyCredential("join-token");
    await vi.advanceTimersByTimeAsync(30_000);

    expect(messages).toContain("Copied token remains on the clipboard; clear it manually.");
  });

  it("should keep the previous timer when a new copy is denied", async () => {
    vi.useFakeTimers();
    const writeText = vi
      .spyOn(navigator.clipboard, "writeText")
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error("denied"))
      .mockResolvedValue(undefined);

    await copyCredential("first-token");
    await copyCredential("second-token");
    await vi.advanceTimersByTimeAsync(30_000);

    expect(writeText).toHaveBeenLastCalledWith("");
  });
});
