#!/usr/bin/env node
const { spawn } = require("node:child_process");
const path = require("node:path");

const root = path.join(__dirname, "..");
const loader = path.join(root, "node_modules", "tsx", "dist", "loader.mjs");
const child = spawn(
  process.execPath,
  ["--import", loader, path.join(root, "src", "cli.ts"), ...process.argv.slice(2)],
  { stdio: "inherit" },
);

child.on("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code === null ? 1 : code);
});
