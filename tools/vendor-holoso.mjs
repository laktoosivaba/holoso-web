// Vendor a Holoso release from GitHub into the static web bundle inputs:
//   - wheels/holoso-*.whl: browser runtime package, built from the tagged source
//   - demos/: example kernels copied from the same tagged source
//   - holoso/: upstream README/docs/assets rendered on the app landing pane
//
// By default the latest SemVer tag on Zubax/holoso is used. Set HOLOSO_VERSION=0.1.3
// to pin a build to a specific release tag.

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, rm, writeFile, readdir, readFile, copyFile, cp, unlink } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);

const WEB = fileURLToPath(new URL("../", import.meta.url));
const WHEELS = WEB + "wheels/";
const DEMOS = WEB + "demos/";
const DOCS = WEB + "holoso/";
const REPO = process.env.HOLOSO_REPO || "https://github.com/Zubax/holoso";
const MAIN_BRANCH = process.env.HOLOSO_MAIN || "main";
const REQUESTED_VERSION = (process.env.HOLOSO_VERSION || "").trim();

const color = {
  dim: "\x1b[2m",
  cyan: "\x1b[36m",
  green: "\x1b[32m",
  reset: "\x1b[0m",
};

const log = (msg) => console.log(`${color.cyan}vendor-holoso:${color.reset} ${msg}`);
const ok = (msg) => console.log(`${color.green}vendor-holoso:${color.reset} ${msg}`);

function parseSemver(tag) {
  const m = tag.match(/^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/);
  if (!m) return null;
  return {
    tag,
    major: Number(m[1]),
    minor: Number(m[2]),
    patch: Number(m[3]),
    prerelease: m[4] || "",
  };
}

function compareSemver(a, b) {
  for (const key of ["major", "minor", "patch"]) {
    if (a[key] !== b[key]) return a[key] - b[key];
  }
  if (!a.prerelease && b.prerelease) return 1;
  if (a.prerelease && !b.prerelease) return -1;
  return a.prerelease.localeCompare(b.prerelease, "en", { numeric: true });
}

async function gitOutput(args) {
  const { stdout } = await execFileAsync("git", args, { maxBuffer: 8 * 1024 * 1024 });
  return stdout.trim();
}

async function remoteTags() {
  const out = await gitOutput(["ls-remote", "--tags", "--refs", REPO]);
  return out
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => line.split(/\s+/)[1]?.replace(/^refs\/tags\//, ""))
    .filter(Boolean);
}

function githubSlug(repo) {
  const m = repo.match(/^https:\/\/github\.com\/([^/]+\/[^/.]+?)(?:\.git)?$/);
  return m ? m[1] : null;
}

async function tagIsOnMain(tag) {
  const slug = githubSlug(REPO);
  if (!slug) return true;
  const url = `https://api.github.com/repos/${slug}/compare/${encodeURIComponent(tag)}...${encodeURIComponent(MAIN_BRANCH)}`;
  const res = await fetch(url, { headers: { "User-Agent": "holoso-web-vendor" } });
  if (!res.ok) throw new Error(`GitHub compare ${tag}...${MAIN_BRANCH}: HTTP ${res.status}`);
  const meta = await res.json();
  return meta.status === "ahead" || meta.status === "identical";
}

async function resolveTag() {
  const tags = await remoteTags();
  if (REQUESTED_VERSION) {
    const candidates = [REQUESTED_VERSION, REQUESTED_VERSION.replace(/^v/, ""), `v${REQUESTED_VERSION.replace(/^v/, "")}`];
    const tag = candidates.find((t) => tags.includes(t));
    if (!tag) throw new Error(`requested HOLOSO_VERSION=${REQUESTED_VERSION} is not a tag in ${REPO}`);
    return tag;
  }

  const semverTags = tags.map(parseSemver).filter(Boolean).sort(compareSemver).reverse();
  if (!semverTags.length) throw new Error(`no SemVer tags found in ${REPO}`);
  for (const tag of semverTags.map((v) => v.tag)) {
    if (await tagIsOnMain(tag)) return tag;
  }
  throw new Error(`no SemVer tags in ${REPO} are reachable from ${MAIN_BRANCH}`);
}

async function fetchBytes(url) {
  const res = await fetch(url, { headers: { "User-Agent": "holoso-web-vendor" } });
  if (!res.ok) throw new Error(`fetch ${url}: HTTP ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

async function extractArchive(tag, tmp) {
  const url = `${REPO.replace(/\.git$/, "")}/archive/refs/tags/${encodeURIComponent(tag)}.tar.gz`;
  const archive = `${tmp}/holoso-${tag}.tar.gz`;
  log(`downloading ${url}`);
  await writeFile(archive, await fetchBytes(url));
  await execFileAsync("tar", ["-xzf", archive, "-C", tmp], { maxBuffer: 8 * 1024 * 1024 });
  const dirs = (await readdir(tmp, { withFileTypes: true })).filter((d) => d.isDirectory()).map((d) => d.name);
  if (dirs.length !== 1) throw new Error(`expected one extracted source dir, found: ${dirs.join(", ") || "none"}`);
  return `${tmp}/${dirs[0]}`;
}

async function buildWheel(src) {
  await mkdir(WHEELS, { recursive: true });
  for (const name of await readdir(WHEELS).catch(() => [])) {
    if (/^holoso-.*\.whl$/.test(name)) await unlink(WHEELS + name);
  }
  log("building wheel with uv");
  await execFileAsync("uv", ["build", "--wheel", "--out-dir", WHEELS, src], {
    cwd: src,
    maxBuffer: 64 * 1024 * 1024,
  });
  const wheels = (await readdir(WHEELS)).filter((n) => /^holoso-.*\.whl$/.test(n)).sort();
  if (wheels.length !== 1) throw new Error(`expected exactly one holoso wheel, found ${wheels.length}`);
  ok(`wrote wheels/${wheels[0]}`);
}

const LABEL_MAX = 140;
function docstringSummary(content) {
  const m = content.match(/^\s*(?:#![^\n]*\n)?\s*("""|''')([\s\S]*?)\1/);
  if (!m) return null;
  const para = m[2].split(/\n[ \t]*\n/)[0].replace(/\s+/g, " ").trim();
  if (!para) return null;
  const sentence = para.match(/^.*?[.?!](?=\s|$)/);
  let text = (sentence ? sentence[0] : para).replace(/[.?!]+$/, "").trim();
  if (text.length > LABEL_MAX) text = text.slice(0, LABEL_MAX).replace(/\s+\S*$/, "") + "...";
  return text || null;
}

function detectExtras(content, siblingStems) {
  const found = new Set();
  for (const line of content.split(/\r?\n/)) {
    const m = line.match(/^\s*from\s+([A-Za-z_]\w*)\s+import\b/);
    if (m && siblingStems.has(m[1])) found.add(`${m[1]}.py`);
  }
  return [...found].sort();
}

async function vendorExamples(src) {
  const examples = `${src}/examples`;
  const files = (await readdir(examples)).filter((n) => n.endsWith(".py")).sort();
  if (!files.length) throw new Error(`no .py examples under ${examples}`);

  await rm(DEMOS, { recursive: true, force: true });
  await mkdir(DEMOS, { recursive: true });

  const stems = new Set(files.map((f) => f.replace(/\.py$/, "")));
  const manifest = [];
  for (const file of files) {
    const content = await readFile(`${examples}/${file}`, "utf8");
    const id = file.replace(/\.py$/, "");
    const desc = docstringSummary(content);
    const extras = detectExtras(content, stems).filter((n) => n !== file);
    const entry = { id, label: desc ? `${id} - ${desc}` : id, file };
    if (extras.length) entry.extras = extras;
    manifest.push(entry);
    await copyFile(`${examples}/${file}`, DEMOS + file);
  }

  await writeFile(DEMOS + "manifest.json", JSON.stringify(manifest, null, 2) + "\n");
  ok(`copied ${files.length} examples into demos/`);
}

async function vendorDocs(src) {
  await rm(DOCS, { recursive: true, force: true });
  await mkdir(DOCS, { recursive: true });

  const readme = `${src}/README.md`;
  if (!existsSync(readme)) throw new Error(`release archive has no top-level README.md`);
  await copyFile(readme, DOCS + "README.md");

  for (const name of ["LICENSE", "PRIOR_ART.md", "DESIGN.md"]) {
    const path = `${src}/${name}`;
    if (existsSync(path)) await copyFile(path, DOCS + name);
  }
  if (existsSync(`${src}/docs`)) await cp(`${src}/docs`, DOCS + "docs", { recursive: true });

  ok("copied README/docs into holoso/");
}

const tmp = await mkdtemp(`${tmpdir()}/holoso-web-`);
try {
  const tag = await resolveTag();
  log(`${REQUESTED_VERSION ? "using pinned" : "resolved latest"} Holoso tag ${color.dim}${tag}${color.reset}`);
  const src = await extractArchive(tag, tmp);
  await buildWheel(src);
  await vendorExamples(src);
  await vendorDocs(src);
  ok(`Holoso ${tag} vendored`);
} finally {
  await rm(tmp, { recursive: true, force: true });
}
