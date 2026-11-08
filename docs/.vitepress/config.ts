import { defineConfig } from "vitepress";

const guide = [
  { text: "Getting started", link: "/guide/getting-started" },
  { text: "Install", link: "/guide/install" },
  { text: "Versioning", link: "/guide/versioning" },
  { text: "Review the app", link: "/guide/review" },
  { text: "Docker Compose", link: "/guide/docker-compose" },
  { text: "Agent", link: "/guide/agent" },
  { text: "Environment variables", link: "/guide/environment-variables" },
  { text: "Web UI", link: "/guide/web-ui" },
  { text: "CLI", link: "/guide/cli" },
  { text: "Authentication", link: "/guide/authentication" },
  { text: "RBAC", link: "/guide/rbac" },
  { text: "Projects and secrets", link: "/guide/secrets" },
  { text: "Certificates", link: "/guide/certificates" },
  { text: "Audit", link: "/guide/audit" },
  { text: "Backup and restore", link: "/guide/backup-restore" },
  { text: "Operations", link: "/guide/operations" },
  { text: "Rotation", link: "/guide/rotation" },
  { text: "Troubleshooting", link: "/guide/troubleshooting" },
];

const tutorials = [
  { text: "Tutorials", link: "/tutorials/" },
  { text: "Your first secret", link: "/tutorials/first-secret" },
  { text: "Deliver to a Compose service", link: "/tutorials/compose-agent" },
  { text: "Backup and restore drill", link: "/tutorials/backup-restore-drill" },
];

const reference = [
  { text: "API", link: "/reference/api" },
  { text: "CLI reference", link: "/reference/cli" },
  { text: "Configuration", link: "/reference/configuration" },
  { text: "Roles and actions", link: "/reference/roles" },
];

const architecture = [{ text: "How it works", link: "/architecture/overview" }];

const security = [
  { text: "Security overview", link: "/security/" },
  { text: "Known limitations", link: "/security/known-limitations" },
  { text: "Hardening checklist", link: "/security/hardening" },
  { text: "Incident response", link: "/security/incident-response" },
  { text: "Reporting a vulnerability", link: "/security/reporting" },
];

const base = "/openvault/";

export default defineConfig({
  title: "OpenVault",
  description: "Self-hosted secret and certificate store for Docker Compose projects.",
  base,
  cleanUrls: true,
  lastUpdated: true,
  // Implementation notes and security-assurance records stay in the repository
  // for maintainers. They are not part of the reader-facing documentation.
  srcExclude: [
    "architecture/crypto.md",
    "architecture/identity.md",
    "architecture/agent-delivery.md",
    "architecture/decisions.md",
    "security/threat-model.md",
    "security/evidence-matrix.md",
    "security/claims.md",
    "security/review-gates.md",
    "security/release-process.md",
    "security/release-evidence.md",
    "security/external-review.md",
    "security/limitations.md",
    "contributing.md",
  ],
  head: [["link", { rel: "icon", type: "image/svg+xml", href: `${base}logo.svg` }]],
  sitemap: {
    hostname: "https://blendsdk.github.io/openvault/",
  },
  themeConfig: {
    logo: "/logo.svg",
    nav: [
      { text: "Guide", link: "/guide/getting-started" },
      { text: "Tutorials", link: "/tutorials/" },
      { text: "Reference", link: "/reference/api" },
      { text: "How it works", link: "/architecture/overview" },
      { text: "Security", link: "/security/" },
    ],
    sidebar: [
      { text: "Guide", items: guide },
      { text: "Tutorials", items: tutorials },
      { text: "Reference", items: reference },
      { text: "How it works", items: architecture },
      { text: "Security", items: security },
      {
        text: "Project",
        items: [
          {
            text: "Contributing",
            link: "https://github.com/blendsdk/openvault/blob/main/CONTRIBUTING.md",
          },
          { text: "Changelog", link: "/changelog" },
        ],
      },
    ],
    search: {
      provider: "local",
    },
    editLink: {
      pattern: "https://github.com/blendsdk/openvault/edit/main/docs/:path",
      text: "Edit this page on GitHub",
    },
    socialLinks: [{ icon: "github", link: "https://github.com/blendsdk/openvault" }],
    footer: {
      message: "Released under the Apache-2.0 License",
      copyright: "Copyright © 2026 OpenVault contributors",
    },
    outline: {
      level: [2, 3],
      label: "On this page",
    },
  },
});
