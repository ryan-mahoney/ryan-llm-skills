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

// --- .specs root regimes (R13) -------------------------------------------------

// A real `.specs/` layout: the collection under `.specs/ux-qa/visuals/`, captures in
// `.specs/images/`, run output and a spec sentinel beside them, and a docs link that either
// roots the server at `.specs` itself or pulls it up to the repository.
const specsLayout = () => {
  const repo = tempDir("serve-journeys-specs-");
  const specs = join(repo, ".specs");
  const collectionDir = join(specs, "ux-qa/visuals");
  mkdirSync(join(specs, "images/journeys/JRNY-001"), { recursive: true });
  mkdirSync(join(specs, "ux-qa/runs/JRNY-001"), { recursive: true });
  mkdirSync(join(repo, "docs"), { recursive: true });
  writeFileSync(join(specs, "images/journeys/JRNY-001/default.png"), "png-bytes");
  writeFileSync(join(specs, "images/notes.txt"), "public capture notes");
  writeFileSync(join(specs, "gmi-api-key.txt"), "SECRET");
  writeFileSync(join(specs, "ux-qa/runs/JRNY-001/session.json"), '{"databaseUrl":"postgres://"}');
  writeFileSync(join(repo, "docs/notes.md"), "# notes");
  // A symlink inside a served `.specs` folder that points at a denied `.specs` file.
  symlinkSync("../gmi-api-key.txt", join(specs, "images/key.txt"));
  const outsideDir = tempDir("serve-journeys-specs-outside-");
  writeFileSync(join(outsideDir, "secret.txt"), "nope");
  symlinkSync(outsideDir, join(specs, "images/outside"));
  mkdirSync(join(collectionDir, "JRNY-001"), { recursive: true });
  writeFileSync(join(collectionDir, "JRNY-001/index.html"), "<html>journey</html>");
  return { repo, collectionDir };
};

const writeSpecsManifest = (collectionDir, withDocsLink) => writeManifest(collectionDir, "JRNY-001", {
  journey: { id: "JRNY-001", source: "../../runs/JRNY-001/JRNY-001-thing.md" },
  steps: [{
    id: "s1",
    visual: { status: "captured", src: "../../../images/journeys/JRNY-001/default.png" },
    ...(withDocsLink ? { evidence: [{ href: "../../../../docs/notes.md", kind: "document" }] } : {}),
  }],
});

test("roots at .specs when every manifest href stays inside it, serving only images/ and ux-qa/visuals/", () => {
  const { repo, collectionDir } = specsLayout();
  writeSpecsManifest(collectionDir, false);

  const root = computeRoot(collectionDir);

  assert.equal(root, join(repo, ".specs"));
  assert.equal(resolveRequestPath(root, "/images/journeys/JRNY-001/default.png").status, 200);
  assert.equal(resolveRequestPath(root, "/ux-qa/visuals/JRNY-001/index.html").status, 200);
  assert.equal(resolveRequestPath(root, "/images/notes.txt").status, 200);
  assert.equal(resolveRequestPath(root, "/gmi-api-key.txt").status, 403);
  assert.equal(resolveRequestPath(root, "/ux-qa/runs/JRNY-001/session.json").status, 403);
});

test("roots at the repository when a manifest links docs/, admitting the literal .specs segment", () => {
  const { repo, collectionDir } = specsLayout();
  writeSpecsManifest(collectionDir, true);

  const root = computeRoot(collectionDir);

  assert.equal(root, repo);
  assert.equal(resolveRequestPath(root, "/.specs/images/journeys/JRNY-001/default.png").status, 200);
  assert.equal(resolveRequestPath(root, "/.specs/ux-qa/visuals/JRNY-001/index.html").status, 200);
  assert.equal(resolveRequestPath(root, "/.specs/gmi-api-key.txt").status, 403);
  assert.equal(resolveRequestPath(root, "/.specs/ux-qa/runs/JRNY-001/session.json").status, 403);
  // The repository regime still serves its own non-.specs files and still denies other dots.
  assert.equal(resolveRequestPath(root, "/docs/notes.md").status, 200);
  assert.equal(resolveRequestPath(root, "/.env").status, 403);
});

test("403s a symlink inside a served .specs folder that resolves to a denied path", () => {
  const { collectionDir } = specsLayout();
  writeSpecsManifest(collectionDir, false);

  const root = computeRoot(collectionDir);

  // images/key.txt -> .specs/gmi-api-key.txt and images/outside/secret.txt leaves the root.
  assert.equal(resolveRequestPath(root, "/images/key.txt").status, 403);
  assert.equal(resolveRequestPath(root, "/images/outside/secret.txt").status, 403);
  // The same layout's served capture is still reachable, so the denials are the rule and not a
  // root that denies everything.
  assert.equal(resolveRequestPath(root, "/images/journeys/JRNY-001/default.png").status, 200);
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
