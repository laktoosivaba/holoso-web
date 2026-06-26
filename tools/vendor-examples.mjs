// Vendor demo kernels from holoso-synth/examples/ into holoso-web/demos/ and rebuild manifest.json.
// Every .py is copied verbatim; manifest is regenerated each run, so removing this script's outputs and re-running
// is the supported way to refresh. The picker takes the manifest at face value -- if a vendored kernel doesn't
// synthesize (frontend feature gap, aspirational example, etc.) the user just sees a synth error.
//
// Sibling-import detection: every `from <name> import …` whose <name> matches another vendored file becomes an
// `extras: [<name>.py]` entry, so cross-file demos (ekf1_stateful imports ekf1_stateless, iir1_hpf imports iir1_lpf)
// resolve at runtime without manual manifest curation.

import { readdir, readFile, copyFile, writeFile, mkdir, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const WEB = fileURLToPath(new URL("../", import.meta.url));
const SYNTH = process.argv[2] || process.env.SYNTH || WEB + "../holoso-synth";
const SRC = `${SYNTH.replace(/\/$/, "")}/examples`;
const OUT = WEB + "demos/";

// First sentence of the leading module docstring, used as the picker-label suffix (shown as the row's
// hover tooltip). Falls back to the filename stem when the file has no module docstring (e.g. iir1_lpf.py).
const LABEL_MAX = 140;
function docstringSummary(content) {
  const m = content.match(/^\s*(?:#![^\n]*\n)?\s*("""|''')([\s\S]*?)\1/);
  if (!m) return null;
  // Collapse the leading paragraph (up to the first blank line) onto one line, then take the first
  // sentence -- the docstring's opening line often wraps mid-thought, which reads badly as a label.
  const para = m[2].split(/\n[ \t]*\n/)[0].replace(/\s+/g, " ").trim();
  if (!para) return null;
  const sentence = para.match(/^.*?[.?!](?=\s|$)/);
  let text = (sentence ? sentence[0] : para).replace(/[.?!]+$/, "").trim();
  if (text.length > LABEL_MAX) text = text.slice(0, LABEL_MAX).replace(/\s+\S*$/, "") + "…";
  return text || null;
}

// Sibling-import scan: every top-level `from <name> import …` whose <name>.py also lives in this directory.
function detectExtras(content, siblingStems) {
  const found = new Set();
  for (const line of content.split(/\r?\n/)) {
    const m = line.match(/^\s*from\s+([A-Za-z_]\w*)\s+import\b/);
    if (m && siblingStems.has(m[1])) found.add(`${m[1]}.py`);
  }
  return [...found].sort();
}

const files = (await readdir(SRC)).filter((n) => n.endsWith(".py")).sort();
if (!files.length) {
  console.warn(`vendor-examples: no .py files under ${SRC}`);
  process.exit(0);
}

await rm(OUT, { recursive: true, force: true });
await mkdir(OUT, { recursive: true });

const stems = new Set(files.map((f) => f.replace(/\.py$/, "")));
const manifest = [];
for (const file of files) {
  const content = await readFile(`${SRC}/${file}`, "utf8");
  const id = file.replace(/\.py$/, "");
  const desc = docstringSummary(content);
  const label = desc ? `${id} — ${desc}` : id;
  const extras = detectExtras(content, stems).filter((n) => n !== file);
  const entry = { id, label, file };
  if (extras.length) entry.extras = extras;
  manifest.push(entry);
  await copyFile(`${SRC}/${file}`, OUT + file);
}

await writeFile(OUT + "manifest.json", JSON.stringify(manifest, null, 2) + "\n");
console.log(`vendor-examples: copied ${files.length} files from ${SRC} → ${OUT}`);
for (const e of manifest) {
  console.log(`  - ${e.id}${e.extras ? ` (extras: ${e.extras.join(", ")})` : ""}`);
}
