#!/usr/bin/env node
/**
 * Dev watcher: monitors src/ changes, auto-compiles and deploys.
 * Reload Window is still needed (VS Code limitation), but compile+deploy is automatic.
 *
 * Usage: npm run dev
 */
const { execSync, spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const srcDir = path.join(__dirname, '..', 'src');
let debounce = null;
let building = false;

function buildAndDeploy(changedFile) {
  if (building) return;
  building = true;

  const label = changedFile ? path.relative(srcDir, changedFile) : 'all';
  const start = Date.now();
  console.log(`\n[${new Date().toLocaleTimeString()}] change: ${label}`);

  try {
    execSync('npm run build', { cwd: path.join(__dirname, '..'), stdio: 'pipe' });
    execSync('node scripts/deploy.js', { cwd: path.join(__dirname, '..'), stdio: 'inherit' });
    console.log(`  built in ${Date.now() - start}ms — Reload Window to see changes`);
  } catch (err) {
    console.error(`  BUILD FAILED:`, err.stderr?.toString() || err.message);
  }

  building = false;
}

console.log('watching src/ for changes... (Ctrl+C to stop)\n');
buildAndDeploy();

fs.watch(srcDir, { recursive: true }, (event, filename) => {
  if (!filename) return;
  if (filename.endsWith('.ts') || filename.endsWith('.tsx') || filename.endsWith('.css')) {
    clearTimeout(debounce);
    debounce = setTimeout(() => buildAndDeploy(path.join(srcDir, filename)), 300);
  }
});
