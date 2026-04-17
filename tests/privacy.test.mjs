import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import test from "node:test";

const forbiddenTokens = [
  ["se", "same", "api"].join(""),
  ["gr", "eet"].join(""),
  ["hey", "gr", "eet"].join(""),
  ["acad", "emy"].join(""),
  ["back", "office"].join(""),
  ["school", "-api"].join(""),
  ["192", ".", "168", "."].join(""),
];

const includedRootFiles = new Set([
  ".env.example",
  ".gitignore",
  "README.md",
  "README.ko-KR.md",
  "biome.json",
  "mcp-server.sh",
  "openapi.backends.example.json",
  "package.json",
  "tsconfig.json",
]);
const includedExtensions = new Set([".ts", ".mjs", ".json", ".md", ".sh"]);
const excludedDirs = new Set([".git", ".omx", "build", "node_modules"]);
const excludedFiles = new Set(["pnpm-lock.yaml"]);

async function collectPublishableFiles(dir = ".") {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = [];

  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (!excludedDirs.has(entry.name)) {
        files.push(...(await collectPublishableFiles(join(dir, entry.name))));
      }
      continue;
    }

    if (!entry.isFile()) {
      continue;
    }

    const path = join(dir, entry.name);
    const rel = relative(".", path);
    const ext = rel.includes(".") ? rel.slice(rel.lastIndexOf(".")) : "";
    const inRoot = !rel.includes("/") && includedRootFiles.has(rel);
    const inSourceOrTests = (rel.startsWith("src/") || rel.startsWith("tests/")) && includedExtensions.has(ext);

    if (!excludedFiles.has(rel) && (inRoot || inSourceOrTests)) {
      files.push(path);
    }
  }

  return files;
}

test("publishable files do not contain internal company-specific tokens", async () => {
  const files = await collectPublishableFiles();
  assert.ok(files.length > 0, "expected publishable files to scan");

  const hits = [];
  for (const file of files) {
    const text = (await readFile(file, "utf8")).toLowerCase();
    for (const token of forbiddenTokens) {
      if (text.includes(token)) {
        hits.push(`${relative(".", file)} -> ${token}`);
      }
    }
  }

  assert.deepEqual(hits, []);
});
