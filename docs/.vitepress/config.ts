import { defineConfig } from "vitepress";

const guide = [
  { text: "Getting started", link: "/guide/getting-started" },
  { text: "Install", link: "/guide/install" },
  { text: "Docker Compose", link: "/guide/docker-compose" },
  { text: "Agent", link: "/guide/agent" },
  { text: "CLI", link: "/guide/cli" },
  { text: "Authentication", link: "/guide/authentication" },
  { text: "RBAC", link: "/guide/rbac" },
  { text: "Certificates", link: "/guide/certificates" },
  { text: "Audit", link: "/guide/audit" },
  { text: "Backup and restore", link: "/guide/backup-restore" },
  { text: "Rotation", link: "/guide/rotation" },
  { text: "Troubleshooting", link: "/guide/troubleshooting" },
];

const reference = [
  { text: "API", link: "/reference/api" },
  { text: "CLI reference", link: "/reference/cli" },
  { text: "Configuration", link: "/reference/configuration" },
  { text: "Roles and actions", link: "/reference/roles" },
];

const architecture = [
  { text: "Overview", link: "/architecture/overview" },
  { text: "Cryptography", link: "/architecture/crypto" },
  { text: "Identity", link: "/architecture/identity" },
  { text: "Agent delivery", link: "/architecture/agent-delivery" },
  { text: "Decisions", link: "/architecture/decisions" },
];

const security = [
  { text: "Threat model", link: "/security/threat-model" },
  { text: "Known limitations", link: "/security/limitations" },
  { text: "Hardening checklist", link: "/security/hardening" },
  { text: "Reporting a vulnerability", link: "/security/reporting" },
];

export default defineConfig({
  title: "OpenVault",
  description: "Self-hosted secret and certificate store for Docker Compose projects.",
  base: "/openvault/",
  cleanUrls: true,
  lastUpdated: true,
  sitemap: {
    hostname: "https://blendsdk.github.io/openvault/",
  },
  themeConfig: {
    nav: [
      { text: "Guide", link: "/guide/getting-started" },
      { text: "Reference", link: "/reference/api" },
      { text: "Architecture", link: "/architecture/overview" },
      { text: "Security", link: "/security/threat-model" },
    ],
    sidebar: [
      { text: "Guide", items: guide },
      { text: "Reference", items: reference },
      { text: "Architecture", items: architecture },
      { text: "Security", items: security },
      {
        text: "Project",
        items: [
          { text: "Contributing", link: "/contributing" },
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
