import { newUlid } from "@openvault/core";
import type { PostgreSQLDatabase } from "blendsdk/postgresql";
import type { SecretService } from "../../../src/secrets/service.js";

/** Seeds one secret and replaces its current version with a version at a chosen time. */
export async function createSecretAt(
  database: PostgreSQLDatabase,
  service: SecretService,
  actorId: string,
  project: string,
  name: string,
  createdAt: string,
  createdBy: string,
): Promise<void> {
  await service.create(
    actorId,
    project,
    { name, value: "rotation-value", encoding: "utf8", contentType: "text/plain", tags: {} },
    { requestId: `create-${name}` },
  );
  const found = await database.executeQuery<{ readonly id: string }>(
    "SELECT id FROM secrets WHERE name = :name AND project_id = (SELECT id FROM projects WHERE name = :project)",
    { name, project },
  );
  const secretId = found.records[0]?.id;
  if (secretId === undefined) {
    throw new Error(`Secret ${name} was not created`);
  }
  const versionId = newUlid();
  await database.executeQuery(
    `INSERT INTO secret_versions
       (id, secret_id, ciphertext, nonce, tag, wrapped_dek, wrap_nonce, wrap_tag,
        kek_id, created_by, created_at)
     VALUES
       (:id, :secretId, :ciphertext, :nonce, :tag, :wrappedDek, :wrapNonce, :wrapTag,
        'kek-1', :createdBy, :createdAt)`,
    {
      id: versionId,
      secretId,
      ciphertext: Buffer.from("rotation-fixture"),
      nonce: Buffer.alloc(12, 1),
      tag: Buffer.alloc(16, 2),
      wrappedDek: Buffer.alloc(32, 3),
      wrapNonce: Buffer.alloc(12, 4),
      wrapTag: Buffer.alloc(16, 5),
      createdBy,
      createdAt,
    },
  );
  await database.executeQuery(
    "UPDATE secrets SET current_version_id = :versionId WHERE id = :secretId",
    { versionId, secretId },
  );
}

/** Adds a new current version at a chosen time to an existing secret. */
export async function replaceVersionAt(
  database: PostgreSQLDatabase,
  name: string,
  createdAt: string,
  createdBy: string,
): Promise<void> {
  const found = await database.executeQuery<{ readonly id: string }>(
    "SELECT id FROM secrets WHERE name = :name",
    { name },
  );
  const secretId = found.records[0]?.id;
  if (secretId === undefined) {
    throw new Error(`Secret ${name} was not found`);
  }
  const versionId = newUlid();
  await database.executeQuery(
    `INSERT INTO secret_versions
       (id, secret_id, ciphertext, nonce, tag, wrapped_dek, wrap_nonce, wrap_tag,
        kek_id, created_by, created_at)
     VALUES
       (:id, :secretId, :ciphertext, :nonce, :tag, :wrappedDek, :wrapNonce, :wrapTag,
        'kek-1', :createdBy, :createdAt)`,
    {
      id: versionId,
      secretId,
      ciphertext: Buffer.from("rotation-fixture"),
      nonce: Buffer.alloc(12, 1),
      tag: Buffer.alloc(16, 2),
      wrappedDek: Buffer.alloc(32, 3),
      wrapNonce: Buffer.alloc(12, 4),
      wrapTag: Buffer.alloc(16, 5),
      createdBy,
      createdAt,
    },
  );
  await database.executeQuery(
    "UPDATE secrets SET current_version_id = :versionId WHERE id = :secretId",
    { versionId, secretId },
  );
}

/** Sets one rotation interval through the public metadata path. */
export async function setRotationPolicy(
  service: SecretService,
  actorId: string,
  project: string,
  name: string,
  days: number | null,
): Promise<void> {
  await service.updateMetadata(actorId, project, name, { rotationIntervalDays: days });
}
