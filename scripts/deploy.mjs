#!/usr/bin/env node
/**
 * Copies the built plugin (main.js, manifest.json, styles.css) from the repo
 * root into the vault's plugin folder. The build is produced by `npm run build`.
 *
 * The plugin's data.json (user settings) is never touched, and other files in
 * the destination (e.g. ado-state.json) are left alone.
 *
 * Usage:
 *   node scripts/deploy.mjs [vaultPath]
 *   vaultPath defaults to $PH_VAULT or C:/Users/v-shilpal/Documents/Project Hub
 */
import { copyFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const vault = process.argv[2] ?? process.env.PH_VAULT ?? "C:/Users/v-shilpal/Documents/Project Hub";
const dest = path.join(vault, ".obsidian", "plugins", "project-hub");

const REQUIRED = ["main.js", "manifest.json"];
const OPTIONAL = ["styles.css"];

let failed = false;
for (const file of REQUIRED) {
  if (!existsSync(path.join(ROOT, file))) {
    console.error(`deploy: missing ${file} — run "npm run build" first`);
    failed = true;
  }
}
if (failed) process.exit(1);
for (const file of OPTIONAL) {
  if (!existsSync(path.join(ROOT, file))) console.warn(`deploy: ${file} not built yet, skipping`);
}

await mkdir(dest, { recursive: true });
for (const file of [...REQUIRED, ...OPTIONAL]) {
  const src = path.join(ROOT, file);
  if (!existsSync(src)) continue;
  await copyFile(src, path.join(dest, file));
  console.log(`deploy: ${file} -> ${path.join(dest, file)}`);
}
