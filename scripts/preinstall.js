#!/usr/bin/env node
'use strict';

// Remove stale puppeteer browser-cache folders that exist but are missing
// the actual binary. An interrupted prior download leaves @puppeteer/browsers
// in a state where it sees the version folder and refuses to redownload,
// failing puppeteer's postinstall with:
//   The browser folder (.../chrome/<platform>-<ver>) exists but the
//   executable (.../chrome-<platform>/chrome) is missing
// We run before puppeteer's postinstall and clean those husks so the
// download proceeds fresh.

const fs   = require('fs');
const path = require('path');
const os   = require('os');

const BINARY_NAMES = new Set([
  'chrome',
  'chrome.exe',
  'chrome-headless-shell',
  'chrome-headless-shell.exe',
  'Google Chrome for Testing',
]);
const MIN_BINARY_BYTES = 1_000_000;
const MAX_DEPTH        = 4;

function hasBinary(rootDir) {
  const stack = [[rootDir, 0]];
  while (stack.length) {
    const [dir, depth] = stack.pop();
    if (depth > MAX_DEPTH) continue;
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
    catch { continue; }
    for (const ent of entries) {
      const full = path.join(dir, ent.name);
      if (ent.isFile() && BINARY_NAMES.has(ent.name)) {
        try {
          if (fs.statSync(full).size >= MIN_BINARY_BYTES) return true;
        } catch { /* ignore */ }
      } else if (ent.isDirectory()) {
        stack.push([full, depth + 1]);
      }
    }
  }
  return false;
}

function cleanStaleVersionDirs(parentDir) {
  if (!fs.existsSync(parentDir)) return;
  let entries;
  try { entries = fs.readdirSync(parentDir, { withFileTypes: true }); }
  catch { return; }
  for (const ent of entries) {
    if (!ent.isDirectory()) continue;
    const versionDir = path.join(parentDir, ent.name);
    if (hasBinary(versionDir)) continue;
    console.log(`[md2doc preinstall] removing stale puppeteer cache: ${versionDir}`);
    try { fs.rmSync(versionDir, { recursive: true, force: true }); }
    catch (e) {
      console.log(`[md2doc preinstall] failed to remove ${versionDir}: ${e.message}`);
    }
  }
}

const cacheRoot = process.env.PUPPETEER_CACHE_DIR
  || path.join(os.homedir(), '.cache', 'puppeteer');

cleanStaleVersionDirs(path.join(cacheRoot, 'chrome'));
cleanStaleVersionDirs(path.join(cacheRoot, 'chrome-headless-shell'));
