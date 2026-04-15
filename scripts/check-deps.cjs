const fs = require("fs");
const path = require("path");

const required = [
  "node_modules/vite/package.json",
  "node_modules/@types/node/package.json",
];

const missing = required.filter((p) => !fs.existsSync(path.resolve(p)));

if (missing.length) {
  console.error(
    "\nDependencies are not installed.\nRun this from the repository root:\n\n  npm ci\n"
  );
  process.exit(1);
}
