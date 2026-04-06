#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const pkgPath = path.join(__dirname, '..', 'package.json');
const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));

const oldVersion = pkg.version;
const parts = oldVersion.split('.').map(Number);
parts[2] += 1;
const newVersion = parts.join('.');

pkg.version = newVersion;
fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, '\t') + '\n', 'utf-8');

console.log(`\n  Version: ${oldVersion} → ${newVersion}\n`);

try {
  execSync('npm run deploy', { cwd: path.join(__dirname, '..'), stdio: 'inherit' });
} catch (err) {
  console.error('\n  Release failed during deploy.\n');
  process.exit(1);
}
