export {
  type ClientIdentity,
  VaultClient,
  VaultClientError,
  type VaultClientOptions,
  type VaultErrorKind,
} from "./client.js";
export { type AgentConfig, loadAgentConfig } from "./config.js";
export {
  type DeliveredEntry,
  type DeliveredEntryStatus,
  Delivery,
  type DeliveryOptions,
  type DeliverySnapshot,
  DeliveryTerminalError,
} from "./delivery.js";
export {
  AgentError,
  type AgentErrorCode,
  agentErrorCode,
  agentErrorMessage,
} from "./errors.js";
export {
  consumerMetadata,
  type GeneratedKeyMaterial,
  generateKeyMaterial,
  type JoinAgentOptions,
  joinAgent,
  storedIdentity,
} from "./join.js";
export {
  type AgentLogger,
  createAgentLogger,
  type LogFields,
  silentAgentLogger,
} from "./logger.js";
export {
  type AgentManifest,
  loadAgentManifest,
  type ManifestEntry,
  type ManifestEnvTarget,
  type ManifestFileTarget,
  type ManifestMode,
} from "./manifest.js";
export {
  certificateSerial,
  isNewerCertificate,
  type RenewalOptions,
  type RenewalOutcome,
  RenewalTerminalError,
  renewalAt,
  renewalDue,
  renewOnce,
} from "./renewal.js";
export { AgentRunner, type AgentRunnerOptions } from "./runner.js";
export { type LocalSocketHandle, type LocalSocketOptions, startLocalSocket } from "./socket.js";
export {
  AgentStateStore,
  certificateWindow,
  type ManagedFiles,
  type PendingRenewal,
  type StoredIdentity,
} from "./state.js";
export {
  type HealthOptions,
  type HealthState,
  type RenewalStatus,
  readHealth,
  readStatus,
  type StatusDocument,
  type StatusEntry,
  StatusWriter,
} from "./status.js";
