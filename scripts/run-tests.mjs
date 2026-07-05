#!/usr/bin/env node
// Cross-platform test runner: npm on Windows executes package.json scripts through
// cmd.exe, which does not expand `*.test.ts` globs the way POSIX shells do. Resolving
// the file list in Node and passing explicit paths to `node --import tsx --test`
// sidesteps that entirely, so `npm test` behaves the same on Windows/macOS/Linux.
import { spawnSync } from "node:child_process";
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";

function findTestFiles(dir) {
  const results = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      results.push(...findTestFiles(full));
    } else if (entry.endsWith(".test.ts")) {
      results.push(full);
    }
  }
  return results;
}

const testsDir = join(process.cwd(), "tests");
let files;
try {
  files = findTestFiles(testsDir);
} catch {
  console.log(`No tests/ directory in ${process.cwd()}, skipping.`);
  process.exit(0);
}

if (files.length === 0) {
  console.log(`No *.test.ts files found in ${testsDir}.`);
  process.exit(0);
}

const result = spawnSync(process.execPath, ["--import", "tsx", "--test", ...files], { stdio: "inherit" });
process.exit(result.status ?? 1);
