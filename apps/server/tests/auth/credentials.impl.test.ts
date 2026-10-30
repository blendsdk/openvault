import { describe, expect, it } from "vitest";
import { CredentialsRepository, type QueryDatabase } from "../../src/auth/credentials.js";

interface Query {
  readonly sql: string;
  readonly params: Record<string, unknown> | undefined;
}

/** Records queries and returns an empty result set. */
class RecordingDatabase implements QueryDatabase {
  public readonly queries: Query[] = [];

  public async executeQuery<T>(
    sql: string,
    params?: Record<string, unknown>,
  ): Promise<{ readonly records: readonly T[] }> {
    this.queries.push({ sql, params });
    return { records: [] };
  }
}

describe("CredentialsRepository SQL shape", () => {
  it("should look up a local credential by lowercased email", async () => {
    const database = new RecordingDatabase();
    const repository = new CredentialsRepository(database);

    await expect(repository.findByIdentifier("alice@example.test")).resolves.toBeUndefined();

    const query = database.queries[0];
    expect(query?.sql).toContain("lower(p.email) = :identifier");
    expect(query?.sql).toContain("JOIN local_credentials");
    expect(query?.params).toEqual({ identifier: "alice@example.test" });
  });

  it("should use one atomic failure update with the rolling window and lock threshold", async () => {
    const database = new RecordingDatabase();
    const repository = new CredentialsRepository(database);

    await expect(repository.recordFailure("principal-1")).resolves.toEqual({
      failedCount: 0,
      lockedUntil: null,
    });

    const sql = database.queries[0]?.sql ?? "";
    expect(sql).toContain("UPDATE local_credentials");
    expect(sql).toContain("interval '15 minutes'");
    expect(sql).toContain("failed_count + 1");
    expect(sql).toContain(">= 5");
    expect(sql).toContain("RETURNING failed_count, locked_until");
    expect(database.queries[0]?.params).toEqual({ principalId: "principal-1" });
  });

  it("should reset the counter on success", async () => {
    const database = new RecordingDatabase();
    const repository = new CredentialsRepository(database);

    await repository.recordSuccess("principal-1");

    const sql = database.queries[0]?.sql ?? "";
    expect(sql).toContain("failed_count = 0");
    expect(sql).toContain("locked_until = NULL");
  });

  it("should store the new hash and clear the forced-change flag", async () => {
    const database = new RecordingDatabase();
    const repository = new CredentialsRepository(database);

    await repository.changePassword("principal-1", "$argon2id$v=19$m=65536,t=3,p=1$x$y");

    const query = database.queries[0];
    expect(query?.sql).toContain("password_hash = :passwordHash");
    expect(query?.sql).toContain("must_change = false");
    expect(query?.params).toEqual({
      principalId: "principal-1",
      passwordHash: "$argon2id$v=19$m=65536,t=3,p=1$x$y",
    });
  });
});
