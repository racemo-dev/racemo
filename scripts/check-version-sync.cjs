#!/usr/bin/env node
// Verify version consistency across package.json, src-tauri/Cargo.toml, src-tauri/tauri.conf.json.
// Exits non-zero on mismatch so CI can gate releases.

const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");

function read(p) {
  return fs.readFileSync(path.join(ROOT, p), "utf8");
}

const pkg = JSON.parse(read("package.json")).version;

const cargoToml = read("src-tauri/Cargo.toml");
const cargoMatch = cargoToml.match(/^version\s*=\s*"([^"]+)"/m);
const cargo = cargoMatch ? cargoMatch[1] : null;

const tauri = JSON.parse(read("src-tauri/tauri.conf.json")).version;

const sources = {
  "package.json": pkg,
  "src-tauri/Cargo.toml": cargo,
  "src-tauri/tauri.conf.json": tauri,
};

const values = Object.values(sources);
const allMatch = values.every((v) => v && v === values[0]);

if (!allMatch) {
  console.error("Version mismatch across release manifests:");
  for (const [file, v] of Object.entries(sources)) {
    console.error(`  ${file}: ${v ?? "<missing>"}`);
  }
  console.error("\nRun `node scripts/bump-version.cjs <new-version>` to sync.");
  process.exit(1);
}

console.log(`OK: all manifests report version ${values[0]}`);
