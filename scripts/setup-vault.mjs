#!/usr/bin/env node
/**
 * Idempotent Project Hub vault installer.
 *
 * Creates the vault skeleton (folders + notes + .obsidian config from
 * vault-template/), installs the Minimal theme and the community plugins,
 * and initialises git. Safe to re-run: existing files are never overwritten
 * (plugins and the theme are skipped when already installed).
 *
 * Usage:
 *   node scripts/setup-vault.mjs [vaultPath] [--update] [--from-tmp]
 *
 *   vaultPath  Vault to create/update. Defaults to $PH_VAULT or
 *              C:/Users/v-shilpal/Documents/Project Hub
 *   --update   Re-download the theme and plugins even when already present
 *   --from-tmp Reuse pre-downloaded release files in .tmp/ when they match the
 *              current release sizes (developer convenience, verifies first)
 */
import { copyFile, mkdir, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { createWriteStream } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const args = process.argv.slice(2);
const flags = new Set(args.filter((a) => a.startsWith("--")));
const positional = args.filter((a) => !a.startsWith("--"));
const UPDATE = flags.has("--update");
const FROM_TMP = flags.has("--from-tmp");

const VAULT = positional[0] ?? process.env.PH_VAULT ?? "C:/Users/v-shilpal/Documents/Project Hub";
const TEMPLATE = path.join(ROOT, "vault-template");

const MINIMAL_RELEASE = "9.0.2"; // 9.1.x requires Obsidian 1.14; the installed app is 1.13.7
const MINIMAL_THEME_DIR = ".obsidian/themes/Minimal";

/**
 * repo → expected plugin id → pinned release tag.
 * Pins keep setup reproducible: a new upstream release cannot break the vault
 * install, and bumping is a deliberate edit here.
 */
const PLUGINS = [
  ["obsidian-tasks-group/obsidian-tasks", "obsidian-tasks-plugin", "8.5.0"],
  ["edrickleong/obsidian-calendar-bases", "calendar-bases", "0.2.8"],
  ["vinzent03/obsidian-git", "obsidian-git", "2.41.1"],
  ["SebastianMC/obsidian-custom-sort", "custom-sort", "3.2.0"],
  ["kepano/obsidian-minimal-settings", "obsidian-minimal-settings", "9.0.0"],
  ["obsidian-community/obsidian-style-settings", "obsidian-style-settings", "1.0.9"],
];

const log = (msg) => console.log(`setup-vault: ${msg}`);
const warn = (msg) => console.warn(`setup-vault: WARNING ${msg}`);

async function exists(p) {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

async function downloadFromTag(url, dest) {
  const res = await fetch(url, { headers: { "User-Agent": "project-hub-setup" } });
  if (!res.ok) throw new Error(`GET ${url} -> HTTP ${res.status}`);
  await mkdir(path.dirname(dest), { recursive: true });
  const tmp = `${dest}.part`;
  const file = createWriteStream(tmp);
  for await (const chunk of res.body) file.write(chunk);
  await new Promise((resolve, reject) => file.end(resolve).on("error", reject));
  await rename(tmp, dest);
}

const download = downloadFromTag;

async function copyTemplate() {
  let copied = 0;
  let skipped = 0;
  const walk = async (dir, rel) => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const src = path.join(dir, entry.name);
      const destRel = path.join(rel, entry.name);
      const dest = path.join(VAULT, destRel);
      if (entry.isDirectory()) {
        await mkdir(dest, { recursive: true });
        await walk(src, destRel);
      } else if (!(await exists(dest))) {
        await copyFile(src, dest);
        copied++;
      } else {
        skipped++;
      }
    }
  };
  await walk(TEMPLATE, "");
  log(`template: ${copied} file(s) created, ${skipped} already present`);
  return copied;
}

async function installMinimal() {
  const dest = path.join(VAULT, MINIMAL_THEME_DIR);
  const base = `https://github.com/kepano/obsidian-minimal/releases/download/${MINIMAL_RELEASE}`;
  await mkdir(dest, { recursive: true });
  const manifestPath = path.join(dest, "manifest.json");
  if (UPDATE || !(await exists(manifestPath))) {
    await download(`${base}/manifest.json`, manifestPath);
    log(`Minimal ${MINIMAL_RELEASE}: manifest written`);
  }
  const themePath = path.join(dest, "theme.css");
  if (UPDATE || !(await exists(themePath))) {
    const tmpCopy = path.join(ROOT, ".tmp", "minimal-theme.css");
    if (FROM_TMP && (await exists(tmpCopy))) {
      const releaseSize = 264778; // theme.css in the 9.0.2 release
      if ((await stat(tmpCopy)).size === releaseSize) {
        await copyFile(tmpCopy, themePath);
        log(`Minimal ${MINIMAL_RELEASE}: theme.css reused from .tmp/ (verified size)`);
        return;
      }
    }
    await download(`${base}/theme.css`, themePath);
    log(`Minimal ${MINIMAL_RELEASE}: theme.css downloaded`);
  }
}

async function installPlugin(repo, id, tag) {
  const dest = path.join(VAULT, ".obsidian", "plugins", id);
  const manifestPath = path.join(dest, "manifest.json");
  if (!UPDATE && (await exists(manifestPath))) {
    log(`${id}: already installed, skipping (--update to refresh)`);
    return;
  }
  const base = `https://github.com/${repo}/releases/download/${tag}`;
  try {
    // Download the pinned manifest first and verify the id before writing anything else.
    await mkdir(dest, { recursive: true });
    const manifestRes = await fetch(`${base}/manifest.json`, {
      headers: { "User-Agent": "project-hub-setup" },
    });
    if (!manifestRes.ok) throw new Error(`manifest asset for tag ${tag} -> HTTP ${manifestRes.status}`);
    const manifest = JSON.parse(await manifestRes.text());
    if (manifest.id !== id) throw new Error(`manifest id "${manifest.id}" != expected "${id}"`);
    await download(`${base}/main.js`, path.join(dest, "main.js"));
    try {
      await download(`${base}/styles.css`, path.join(dest, "styles.css"));
    } catch (e) {
      if (UPDATE) await rm(path.join(dest, "styles.css"), { force: true });
      log(`${id}: no styles.css in ${tag} (${e.message})`);
    }
    await writeFile(manifestPath, JSON.stringify(manifest, null, 2));
    log(`${id}: installed v${manifest.version} from pinned tag ${tag}`);
  } catch (e) {
    warn(`${id}: ${e.message}`);
    return false;
  }
  return true;
}

async function gitInit() {
  const gitDir = path.join(VAULT, ".git");
  if (await exists(gitDir)) {
    log("git: repository already initialised");
    return;
  }
  try {
    execFileSync("git", ["init"], { cwd: VAULT, stdio: "ignore" });
    const name = execFileSync("git", ["config", "user.name"], { cwd: VAULT, encoding: "utf8" }).trim();
    const email = execFileSync("git", ["config", "user.email"], { cwd: VAULT, encoding: "utf8" }).trim();
    log(`git: initialised (user: ${name} <${email}>)`);
  } catch (e) {
    warn(`git init failed (${e.message}). Initialise the vault repository manually.`);
  }
}

async function main() {
  log(`vault: ${VAULT}`);
  await mkdir(VAULT, { recursive: true });
  for (const dir of ["Bases", "Work Items", "Projects", "Sprints", "People", "Meetings", "Templates", "Daily", "Inbox", "Attachments"]) {
    await mkdir(path.join(VAULT, dir), { recursive: true });
  }
  await copyTemplate();
  await installMinimal();
  const failed = [];
  for (const [repo, id, tag] of PLUGINS) if ((await installPlugin(repo, id, tag)) === false) failed.push(id);
  await gitInit();
  if (failed.length) {
    console.error(`setup-vault: FAILED to install: ${failed.join(", ")}`);
    process.exit(1);
  }
  log("done");
}

await main();
