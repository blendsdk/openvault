import type { Logger } from "blendsdk/webafx";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  type CliMaintenanceRepository,
  CliSessionMaintenanceService,
} from "../../src/auth/cli-maintenance.js";

class FakeRepository implements CliMaintenanceRepository {
  public calls = 0;
  public result = 0;
  public failure: Error | undefined;

  public async cleanup(): Promise<number> {
    this.calls += 1;
    if (this.failure !== undefined) {
      throw this.failure;
    }
    return this.result;
  }
}

function logger(errors: string[]): Logger {
  return {
    info: async () => undefined,
    error: async (message) => {
      errors.push(message);
    },
    warn: async () => undefined,
    debug: async () => undefined,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("CLI session maintenance", () => {
  it("should run one bounded cleanup and return its count", async () => {
    const repository = new FakeRepository();
    repository.result = 7;
    const service = new CliSessionMaintenanceService({
      repository,
      logger: logger([]),
    });

    await expect(service.runOnce()).resolves.toBe(7);
    expect(repository.calls).toBe(1);
  });

  it("should log an initial cleanup failure without rejecting start", async () => {
    const repository = new FakeRepository();
    repository.failure = new Error("database unavailable");
    const errors: string[] = [];
    const interval = vi.spyOn(globalThis, "setInterval");
    const service = new CliSessionMaintenanceService({
      repository,
      logger: logger(errors),
      intervalMs: 1_000,
    });

    await expect(service.start()).resolves.toBeUndefined();
    expect(errors).toEqual(["CLI session cleanup failed"]);
    expect(interval).toHaveBeenCalledTimes(1);
    service.stop();
  });

  it("should not duplicate timers or cleanup when start is called twice", async () => {
    const repository = new FakeRepository();
    const interval = vi.spyOn(globalThis, "setInterval");
    const service = new CliSessionMaintenanceService({
      repository,
      logger: logger([]),
      intervalMs: 1_000,
    });

    await service.start();
    await service.start();

    expect(repository.calls).toBe(1);
    expect(interval).toHaveBeenCalledTimes(1);
    service.stop();
  });

  it("should run the scheduled callback and retry after a failure", async () => {
    const repository = new FakeRepository();
    const errors: string[] = [];
    const interval = vi.spyOn(globalThis, "setInterval");
    const service = new CliSessionMaintenanceService({
      repository,
      logger: logger(errors),
      intervalMs: 1_000,
    });

    await service.start();
    const callback = interval.mock.calls[0]?.[0];
    if (typeof callback !== "function") {
      throw new Error("expected a scheduled callback");
    }
    repository.failure = new Error("temporary failure");
    callback();
    await vi.waitFor(() => {
      expect(errors).toHaveLength(1);
    });

    repository.failure = undefined;
    repository.result = 1;
    callback();
    await vi.waitFor(() => {
      expect(repository.calls).toBe(3);
    });
    service.stop();
  });

  it("should make stop idempotent and allow a later restart", async () => {
    const repository = new FakeRepository();
    const clear = vi.spyOn(globalThis, "clearInterval");
    const service = new CliSessionMaintenanceService({
      repository,
      logger: logger([]),
      intervalMs: 1_000,
    });

    await service.start();
    service.stop();
    service.stop();
    expect(clear).toHaveBeenCalledTimes(1);

    await service.start();
    expect(repository.calls).toBe(2);
    service.stop();
  });
});
