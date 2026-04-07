#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const os = require('os');

const srcRoot = path.join(__dirname, '..');
const pkg = JSON.parse(fs.readFileSync(path.join(srcRoot, 'package.json'), 'utf-8'));
const version = pkg.version;
const FIXED_DIR_NAME = `${pkg.publisher}.${pkg.name}`;
const extParent = path.join(os.homedir(), '.cursor', 'extensions');
const extDir = path.join(extParent, FIXED_DIR_NAME);

console.log(`\n  MultiSession Deploy v${version}`);
console.log(`  ${'─'.repeat(40)}`);

// 1. remove old versioned dirs (migration) + clean current fixed dir
for (const entry of fs.readdirSync(extParent)) {
  if (entry.startsWith(`${pkg.publisher}.${pkg.name}-`)) {
    const old = path.join(extParent, entry);
    fs.rmSync(old, { recursive: true, force: true });
    console.log(`  [clean] removed ${entry} (old versioned dir)`);
  }
}
if (fs.existsSync(extDir)) {
  fs.rmSync(extDir, { recursive: true, force: true });
  console.log(`  [clean] refreshed ${FIXED_DIR_NAME}`);
}

// 2. create fresh target dirs
fs.mkdirSync(path.join(extDir, 'dist'), { recursive: true });
fs.mkdirSync(path.join(extDir, 'media'), { recursive: true });
fs.mkdirSync(path.join(extDir, 'scripts'), { recursive: true });

// 3. copy files
const filesToCopy = [
  'dist/extension.js',
  'dist/wechat-engine.js',
  'dist/webview.js',
  'dist/webview.css',
  'dist/wechat-webview.js',
  'dist/wechat-webview.css',
  'dist/mcp-server.mjs',
  'package.json',
  'media/icon.svg',
  'scripts/get-cursor-wid',
  'scripts/capture-cursor',
];

let allOk = true;
for (const rel of filesToCopy) {
  const srcPath = path.join(srcRoot, rel);
  const dstPath = path.join(extDir, rel);
  if (fs.existsSync(srcPath)) {
    fs.copyFileSync(srcPath, dstPath);
    const sz = fs.statSync(dstPath).size;
    console.log(`  [copy] ${rel} (${(sz / 1024).toFixed(1)}kb)`);
  } else {
    console.warn(`  [skip] ${rel} — not found`);
  }
}

// 4. verify critical files exist and sizes match
const criticalFiles = ['dist/extension.js', 'dist/wechat-engine.js', 'dist/webview.js', 'dist/wechat-webview.js'];
for (const rel of criticalFiles) {
  const srcPath = path.join(srcRoot, rel);
  const dstPath = path.join(extDir, rel);
  if (!fs.existsSync(dstPath)) {
    console.error(`  [ERROR] missing: ${rel}`);
    allOk = false;
    continue;
  }
  const srcSz = fs.statSync(srcPath).size;
  const dstSz = fs.statSync(dstPath).size;
  if (srcSz !== dstSz) {
    console.error(`  [ERROR] size mismatch: ${rel} (src=${srcSz} dst=${dstSz})`);
    allOk = false;
  }
}

// 5. verify version in deployed package.json
const deployedPkg = JSON.parse(fs.readFileSync(path.join(extDir, 'package.json'), 'utf-8'));
if (deployedPkg.version !== version) {
  console.error(`  [ERROR] version mismatch: pkg=${version} deployed=${deployedPkg.version}`);
  allOk = false;
}

if (!allOk) {
  console.error('\n  Deploy FAILED — see errors above.\n');
  process.exit(1);
}

console.log(`\n  Deploy OK: ${FIXED_DIR_NAME} (v${version})`);
console.log(`  -> ${extDir}`);
console.log(`\n  Next: Cmd+Shift+P -> "Reload Window"\n`);
