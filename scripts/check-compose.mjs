#!/usr/bin/env node
/**
 * Checks the reference Compose stack against the RD-13 deployment contract.
 *
 * The check is deliberately structural: it does not start containers. It
 * catches the common regressions that would quietly widen the deployment
 * surface, such as a published admin port, a writable root filesystem, a
 * missing capability drop, or a plaintext database password.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parse, parseDocument } from "yaml";

const path = fileURLToPath(new URL("../deploy/compose/compose.yaml", import.meta.url));
const reviewPath = fileURLToPath(new URL("../deploy/compose/compose.review.yaml", import.meta.url));

/** Collects one contract failure. */
function check(condition, message, failures) {
  if (!condition) {
    failures.push(message);
  }
}

/** Returns the service map. */
function services(document) {
  return document?.services ?? {};
}

/** Returns true when a service joins a network in either Compose syntax. */
function hasNetwork(service, name) {
  return Array.isArray(service?.networks)
    ? service.networks.includes(name)
    : service?.networks?.[name] !== undefined;
}

/** Checks one parsed Compose document. */
export function validateCompose(document) {
  const failures = [];
  const all = services(document);
  const required = ["proxy", "openvault-init", "openvault-roles", "openvaultd", "web", "postgres"];
  for (const name of required) {
    check(all[name] !== undefined, `missing service: ${name}`, failures);
  }

  for (const [name, service] of Object.entries(all)) {
    check(service.read_only === true, `${name}: read_only must be true`, failures);
    check(
      Array.isArray(service.cap_drop) && service.cap_drop.includes("ALL"),
      `${name}: cap_drop must include ALL`,
      failures,
    );
    check(
      Array.isArray(service.security_opt) &&
        service.security_opt.includes("no-new-privileges:true"),
      `${name}: security_opt must include no-new-privileges:true`,
      failures,
    );
    check(
      service.logging?.options?.["max-size"] !== undefined &&
        service.logging?.options?.["max-file"] !== undefined,
      `${name}: json-file log rotation is required`,
      failures,
    );
    check(
      service.deploy?.resources?.limits !== undefined,
      `${name}: resource limits required`,
      failures,
    );
    for (const volume of service.volumes ?? []) {
      const source = typeof volume === "string" ? volume : volume?.source;
      check(
        typeof source !== "string" || !source.includes("docker.sock"),
        `${name}: the Docker socket must not be mounted`,
        failures,
      );
    }
    const user = service.user;
    const uid = typeof user === "string" ? Number(user.split(":")[0]) : Number.NaN;
    check(
      typeof user === "string" && Number.isInteger(uid) && uid > 0,
      `${name}: must run as a non-root user`,
      failures,
    );
    const addedCapabilities = service.cap_add ?? [];
    check(
      addedCapabilities.every((capability) => capability === "NET_BIND_SERVICE"),
      `${name}: only NET_BIND_SERVICE may be added`,
      failures,
    );
    check(
      name === "proxy" || addedCapabilities.length === 0,
      `${name}: must not add capabilities`,
      failures,
    );
  }

  for (const [name, service] of Object.entries(all)) {
    const ports = service.ports ?? [];
    if (name === "proxy") {
      check(
        ports.length === 1 && String(ports[0]).endsWith(":443"),
        "proxy: only port 443 may be published",
        failures,
      );
    } else {
      check(ports.length === 0, `${name}: must not publish a host port`, failures);
    }
  }
  check(hasNetwork(all.proxy, "admin_net"), "proxy: admin_net required", failures);
  check(hasNetwork(all.openvaultd, "admin_net"), "openvaultd: admin_net required", failures);
  check(hasNetwork(all.openvaultd, "vault_net"), "openvaultd: vault_net required", failures);
  check(hasNetwork(all.openvaultd, "db_net"), "openvaultd: db_net required", failures);
  check(!hasNetwork(all.openvaultd, "edge_net"), "openvaultd: must not join edge_net", failures);
  check(hasNetwork(all.web, "web_net"), "web: web_net required", failures);
  check(hasNetwork(all.postgres, "db_net"), "postgres: db_net required", failures);
  check(!hasNetwork(all.postgres, "edge_net"), "postgres: must not join edge_net", failures);

  for (const name of ["admin_net", "web_net", "vault_net", "db_net"]) {
    check(
      document?.networks?.[name]?.internal === true,
      `network ${name}: must be internal`,
      failures,
    );
  }

  const postgresEnvironment = all.postgres?.environment ?? {};
  check(
    postgresEnvironment.POSTGRES_PASSWORD === undefined,
    "postgres: POSTGRES_PASSWORD must not be set directly",
    failures,
  );
  check(
    postgresEnvironment.POSTGRES_PASSWORD_FILE === "/run/secrets/postgres_password",
    "postgres: POSTGRES_PASSWORD_FILE required",
    failures,
  );
  check(
    Array.isArray(all.postgres?.secrets) && all.postgres.secrets.includes("postgres_password"),
    "postgres: postgres_password secret required",
    failures,
  );
  check(all.postgres?.healthcheck !== undefined, "postgres: healthcheck required", failures);

  const apiEnvironment = all.openvaultd?.environment ?? {};
  for (const name of ["OPENVAULT_DB_URL_FILE", "OPENVAULT_PURGE_DB_URL_FILE"]) {
    check(
      typeof apiEnvironment[name] === "string" && apiEnvironment[name].startsWith("/run/secrets/"),
      `openvaultd: ${name} must reference a Docker secret`,
      failures,
    );
  }
  check(
    apiEnvironment.OPENVAULT_DB_URL === undefined,
    "openvaultd: plaintext DB URL must not be set",
    failures,
  );
  check(
    apiEnvironment.OPENVAULT_MIGRATION_DB_URL === undefined &&
      apiEnvironment.OPENVAULT_MIGRATION_DB_URL_FILE === undefined,
    "openvaultd: must not receive the migrator URL",
    failures,
  );
  check(
    String(apiEnvironment.OPENVAULT_RUN_MIGRATIONS) === "false",
    "openvaultd: startup migrations must be disabled after the init job",
    failures,
  );
  check(
    !(all.openvaultd?.secrets ?? []).includes("db_migrator_url"),
    "openvaultd: must not mount the migrator secret",
    failures,
  );
  check(
    all.openvaultd?.depends_on?.["openvault-roles"]?.condition === "service_completed_successfully",
    "openvaultd: must wait for role grants",
    failures,
  );

  const images = Object.entries(all).map(([name, service]) => [name, String(service.image ?? "")]);
  for (const [name, image] of images) {
    check(
      image.includes("@sha256:") || image.startsWith("${OPENVAULT_"),
      `${name}: image must be digest-pinned or an explicit release variable`,
      failures,
    );
  }

  return failures;
}

/**
 * Checks the local review overlay.
 *
 * The overlay exists to expose the UI on loopback without weakening the base
 * deployment contract. It must not introduce a second published port, a
 * non-loopback bind, or a privileged service.
 *
 * @param document - The parsed review overlay.
 * @returns One message per contract failure.
 */
export function validateReviewCompose(document) {
  const failures = [];
  const all = services(document);
  for (const [name, service] of Object.entries(all)) {
    check(service.privileged !== true, `${name}: review overlay must not be privileged`, failures);
    const ports = service.ports ?? [];
    if (name !== "proxy") {
      check(ports.length === 0, `${name}: review overlay must not publish a port`, failures);
      continue;
    }
    check(ports.length === 1, "proxy: review overlay must publish exactly one port", failures);
    const port = String(ports[0] ?? "");
    check(port.startsWith("127.0.0.1:"), "proxy: review port must bind loopback only", failures);
    check(port.endsWith(":443"), "proxy: review port must target 443", failures);
  }
  return failures;
}

/** Runs the contract and an in-memory negative-control self test. */
function main() {
  const source = readFileSync(path, "utf8");
  const document = parse(source, { merge: true });
  const failures = validateCompose(document);
  const reviewSource = readFileSync(reviewPath, "utf8");
  const reviewDocument = parseDocument(reviewSource, { merge: true }).toJS();
  failures.push(...validateReviewCompose(reviewDocument));
  if (process.argv.includes("--self-test")) {
    const broken = structuredClone(document);
    delete broken.services.openvaultd.read_only;
    broken.services.openvaultd.ports = ["8443:8443"];
    broken.services.openvaultd.user = "0:10001";
    broken.services.openvaultd.cap_add = ["SYS_ADMIN"];
    broken.services.openvaultd.image = "ghcr.io/example/mutable:latest";
    broken.services.postgres.environment.POSTGRES_PASSWORD = "plaintext";
    const negative = validateCompose(broken);
    for (const expected of [
      "openvaultd: read_only",
      "openvaultd: must not publish",
      "openvaultd: must run as a non-root user",
      "openvaultd: only NET_BIND_SERVICE may be added",
      "openvaultd: image must be digest-pinned",
      "POSTGRES_PASSWORD",
    ]) {
      if (!negative.some((entry) => entry.includes(expected))) {
        failures.push(`self-test did not catch: ${expected}`);
      }
    }
    const brokenReview = structuredClone(reviewDocument);
    brokenReview.services.proxy.ports = ["0.0.0.0:8443:443"];
    brokenReview.services.openvaultd = {
      ...structuredClone(document.services.openvaultd),
      ports: ["8443:8443"],
    };
    const negativeReview = validateReviewCompose(brokenReview);
    for (const expected of [
      "proxy: review port must bind loopback only",
      "openvaultd: review overlay must not publish a port",
    ]) {
      if (!negativeReview.some((entry) => entry.includes(expected))) {
        failures.push(`review self-test did not catch: ${expected}`);
      }
    }
  }
  if (failures.length > 0) {
    for (const failure of failures) {
      process.stderr.write(`compose contract: ${failure}\n`);
    }
    process.exitCode = 1;
    return;
  }
  process.stdout.write("COMPOSE CONTRACT OK\n");
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main();
}
