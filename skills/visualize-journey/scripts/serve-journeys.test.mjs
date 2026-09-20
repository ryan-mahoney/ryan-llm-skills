import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, relative } from "node:path";

import { computeRoot, isAllowedHost, resolveRequestPath } from "./serve-journeys.mjs";

const tempDirs = [];
const tempDir = (prefix) => {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
};
after(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

const writeManifest = (collectionDir, journeyId, manifest) => {
  const dir = join(collectionDir, journeyId);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "manifest.json"), JSON.stringify(manifest));
};

// --- computeRoot -----------------------------------------------------------

test("computeRoot spans the two sibling repos an evidence link and a screenshot point into", () => {
  const workspace = tempDir("serve-journeys-root-");
  const appDir = join(workspace, "app");
  const marketingDir = join(workspace, "marketing");
  mkdirSync(join(appDir, "docs/journeys/visuals"), { recursive: true });
  mkdirSync(join(marketingDir, "app/components/night"), { recursive: true });
  mkdirSync(join(appDir, "docs/screenshots/SCRN-030"), { recursive: true });
  const collectionDir = join(appDir, "docs/journeys/visuals");
  writeManifest(collectionDir, "JRNY-001", {
    journey: { id: "JRNY-001", source: "../../JRNY-001-thing.md" },
    steps: [{
      id: "s1",
      visual: { status: "captured", src: "../../../screenshots/SCRN-030/default.png" },
      evidence: [{ href: "../../../../../marketing/app/components/night/NightHeader.js", kind: "source" }],
    }],
  });

  const root = computeRoot(collectionDir);

  assert.equal(root, workspace);
});

test("ignores hrefs carrying a URL scheme and strips a #fragment before resolving", () => {
  const workspace = tempDir("serve-journeys-scheme-");
  const collectionDir = join(workspace, "docs/journeys/visuals");
  mkdirSync(collectionDir, { recursive: true });
  writeManifest(collectionDir, "JRNY-001", {
    // journey.source lives two levels above the per-journey manifest dir (docs/journeys/), like
    // a real visualize-journey collection under docs/journeys/visuals/.
    journey: { id: "JRNY-001", source: "../../JRNY-001-thing.md#overview" },
    steps: [{
      id: "s1",
      evidence: [
        { href: "https://example.com/spec", kind: "document" },
        { href: "mailto:ops@example.com", kind: "document" },
      ],
    }],
  });

  // The scheme'd hrefs never widen the root; only journey.source (with its fragment stripped)
  // does, pulling the root up to docs/journeys — one level above the collection dir.
  const root = computeRoot(collectionDir);

  assert.equal(root, join(workspace, "docs/journeys"));
});

test("refuses a root that would climb to /", () => {
  const workspace = tempDir("serve-journeys-slash-");
  const collectionDir = join(workspace, "docs/journeys/visuals");
  mkdirSync(collectionDir, { recursive: true });
  writeManifest(collectionDir, "JRNY-001", {
    journey: { id: "JRNY-001" },
    steps: [{ id: "s1", evidence: [{ href: "../../../../../../../../../../etc/motd", kind: "source" }] }],
  });

  assert.throws(() => computeRoot(collectionDir), /climb to \//);
});

test("refuses a root that would climb to the home directory", () => {
  const home = homedir();
  const base = mkdtempSync(join(home, "serve-journeys-home-"));
  tempDirs.push(base);
  const sibling = mkdtempSync(join(home, "serve-journeys-home-"));
  tempDirs.push(sibling);
  const collectionDir = join(base, "docs/journeys/visuals");
  const journeyDir = join(collectionDir, "JRNY-001");
  mkdirSync(journeyDir, { recursive: true });
  writeFileSync(join(sibling, "other.md"), "unrelated");
  // journey.source resolves relative to the manifest's own directory (journeyDir), not the
  // collection dir.
  const hrefTarget = relative(journeyDir, join(sibling, "other.md"));
  writeManifest(collectionDir, "JRNY-001", {
    journey: { id: "JRNY-001", source: hrefTarget },
    steps: [{ id: "s1" }],
  });

  assert.throws(() => computeRoot(collectionDir), /climb to the home directory/);
});

// --- resolveRequestPath ------------------------------------------------------

const rootWithFiles = () => {
  const root = tempDir("serve-journeys-files-");
  mkdirSync(join(root, "app/docs/journeys/visuals/JRNY-001"), { recursive: true });
  writeFileSync(join(root, "app/docs/journeys/visuals/JRNY-001/index.html"), "<html>journey</html>");
  mkdirSync(join(root, "marketing/app/components"), { recursive: true });
  writeFileSync(join(root, "marketing/app/components/Header.js"), "export default {};");
  writeFileSync(join(root, "app/docs/notes.md"), "# notes");
  mkdirSync(join(root, "app/.env-dir"), { recursive: true });
  writeFileSync(join(root, "app/.env"), "SECRET=1");
  mkdirSync(join(root, "app/.git"), { recursive: true });
  writeFileSync(join(root, "app/.git/config"), "[core]");
  mkdirSync(join(root, "app/node_modules/pkg"), { recursive: true });
  writeFileSync(join(root, "app/node_modules/pkg/index.js"), "module.exports = {};");
  const outsideDir = tempDir("serve-journeys-outside-");
  writeFileSync(join(outsideDir, "secret.txt"), "nope");
  symlinkSync(join(outsideDir, "secret.txt"), join(root, "app/escape.txt"));
  return root;
};

test("serves a .js source file as text/plain", () => {
  const root = rootWithFiles();
  const result = resolveRequestPath(root, "/marketing/app/components/Header.js");
  assert.deepEqual(
    { status: result.status, type: result.type },
    { status: 200, type: "text/plain; charset=utf-8" },
  );
});

test("serves a .md source file as text/plain", () => {
  const root = rootWithFiles();
  const result = resolveRequestPath(root, "/app/docs/notes.md");
  assert.equal(result.type, "text/plain; charset=utf-8");
});

test("serves a .html page as text/html", () => {
  const root = rootWithFiles();
  const result = resolveRequestPath(root, "/app/docs/journeys/visuals/JRNY-001/index.html");
  assert.deepEqual(
    { status: result.status, type: result.type },
    { status: 200, type: "text/html; charset=utf-8" },
  );
});

test("serves a directory's index.html when no filename is given", () => {
  const root = rootWithFiles();
  const result = resolveRequestPath(root, "/app/docs/journeys/visuals/JRNY-001");
  assert.equal(result.status, 200);
  assert.equal(result.type, "text/html; charset=utf-8");
});

test("404s a path with no matching file", () => {
  const root = rootWithFiles();
  assert.equal(resolveRequestPath(root, "/app/docs/missing.md").status, 404);
});

test("403s a literal .. traversal segment", () => {
  const root = rootWithFiles();
  assert.equal(resolveRequestPath(root, "/app/../../etc/passwd").status, 403);
});

test("403s an encoded %2e%2e traversal segment", () => {
  const root = rootWithFiles();
  assert.equal(resolveRequestPath(root, "/app/%2e%2e/%2e%2e/etc/passwd").status, 403);
});

test("403s a dot-prefixed segment such as .env", () => {
  const root = rootWithFiles();
  assert.equal(resolveRequestPath(root, "/app/.env").status, 403);
});

test("403s a path inside a dot-prefixed directory such as .git", () => {
  const root = rootWithFiles();
  assert.equal(resolveRequestPath(root, "/app/.git/config").status, 403);
});

test("403s a path inside node_modules", () => {
  const root = rootWithFiles();
  assert.equal(resolveRequestPath(root, "/app/node_modules/pkg/index.js").status, 403);
});

test("403s a symlink that resolves outside root", () => {
  const root = rootWithFiles();
  assert.equal(resolveRequestPath(root, "/app/escape.txt").status, 403);
});

// --- isAllowedHost -----------------------------------------------------------

test("allows 127.0.0.1 and localhost with the matching port", () => {
  assert.equal(isAllowedHost("127.0.0.1:4173", 4173), true);
  assert.equal(isAllowedHost("localhost:4173", 4173), true);
});

test("rejects a Host header naming another hostname or port", () => {
  assert.equal(isAllowedHost("evil.example:4173", 4173), false);
  assert.equal(isAllowedHost("127.0.0.1:9999", 4173), false);
});
