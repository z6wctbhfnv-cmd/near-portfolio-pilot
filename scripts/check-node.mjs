#!/usr/bin/env node
// Runs before `npm run setup | tour | test | dev`: says clearly which Node is needed instead of failing later.
const [major] = process.versions.node.split(".").map(Number);
if (major < 20) {
  console.error(`dolya needs Node 22 or 24 (found ${process.versions.node}).\nInstall one with:  nvm install 24 && nvm use 24`);
  process.exit(1);
}
if (major < 22) {
  console.warn(`Note: dolya is tested on Node 22 and 24; you have ${process.versions.node}. If something fails, run:  nvm install 24 && nvm use 24`);
}
