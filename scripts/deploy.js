#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const os = require('os');

const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf-8'));
const version = pkg.version;
const name = `${pkg.publisher}.${pkg.name}-${version}`;
const extDir = path.join(os.homedir(), '.cursor', 'extensions', name);
const srcRoot = path.join(__dirname, '..');

// remove ALL old versions (including current to force clean copy)
const extParent = path.join(os.homedir(), '.cursor', 'extensions');
for (const entry of fs.readdirSync(extParent)) {
  if (entry.startsWith(`${pkg.publisher}.${pkg.name}-`)) {
    const old = path.join(extParent, entry);
    fs.rmSync(old, { recursive: true, force: true });
    console.log(`  removed: ${entry}`);
  }
}

// create fresh target dirs
fs.mkdirSync(path.join(extDir, 'dist'), { recursive: true });
fs.mkdirSync(path.join(extDir, 'media'), { recursive: true });

const filesToCopy = [
  ['dist/extension.js', 'dist/extension.js'],
  ['dist/webview.js', 'dist/webview.js'],
  ['dist/webview.css', 'dist/webview.css'],
  ['dist/mcp-server.mjs', 'dist/mcp-server.mjs'],
  ['package.json', 'package.json'],
  ['media/icon.svg', 'media/icon.svg'],
];

for (const [src, dst] of filesToCopy) {
  const srcPath = path.join(srcRoot, src);
  const dstPath = path.join(extDir, dst);
  if (fs.existsSync(srcPath)) {
    fs.copyFileSync(srcPath, dstPath);
    const stat = fs.statSync(dstPath);
    console.log(`  ${dst} (${(stat.size / 1024).toFixed(1)}kb)`);
  } else {
    console.warn(`  SKIP: ${src} not found`);
  }
}

// verify critical file
const extJs = path.join(extDir, 'dist', 'extension.js');
const extSize = fs.statSync(extJs).size;
const srcSize = fs.statSync(path.join(srcRoot, 'dist', 'extension.js')).size;
if (extSize !== srcSize) {
  console.error(`\n  ERROR: extension.js size mismatch! src=${srcSize} dst=${extSize}`);
  process.exit(1);
}

console.log(`\n  deployed ${name} (extension.js: ${(extSize/1024).toFixed(1)}kb)`);
console.log(`  -> ${extDir}`);
console.log(`\n  Reload Window (Cmd+Shift+P -> "Reload Window") to activate.\n`);
