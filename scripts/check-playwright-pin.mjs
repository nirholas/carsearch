#!/usr/bin/env node
/**
 * Fails when the Playwright version in package.json and the Docker base image
 * tag disagree.
 *
 * They are two declarations of one fact. When they drift, nothing fails at
 * build time: the image builds, the container starts, and every browser-backed
 * adapter dies at launch in production while the site itself looks healthy.
 * A three-line check is cheaper than that outage.
 */
import { readFileSync } from 'node:fs';

const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
const declared = pkg.dependencies?.playwright;
if (!declared || /[\^~*x]/.test(declared)) {
  console.error(`playwright must be pinned to an exact version in package.json, found "${declared}"`);
  process.exit(1);
}

let failed = false;
for (const file of ['Dockerfile', 'Dockerfile.crawler']) {
  const text = readFileSync(file, 'utf8');
  const m = text.match(/mcr\.microsoft\.com\/playwright:v([\d.]+)-/);
  if (!m) {
    console.error(`${file}: no playwright base image found`);
    failed = true;
    continue;
  }
  if (m[1] !== declared) {
    console.error(`${file}: base image is v${m[1]} but package.json pins ${declared}`);
    failed = true;
  }
}

if (failed) process.exit(1);
console.log(`playwright pin consistent: ${declared}`);
