import { readdir, readFile, copyFile, writeFile, mkdir, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const SYNTH = process.argv[2] || process.env.SYNTH || ROOT + "../holoso-synth";
const SRC = `${SYNTH.replace(/\/$/, "")}/examples`;
const OUT = ROOT + "demos/";

let files;
try {
  files = (await readdir(SRC)).filter((n) => n.endsWith(".py")).sort();
} catch (e) {
  console.warn(`cannot read examples at ${SRC}, skipping vendor-examples: ${e.message}`);
  process.exit(0);
}

await rm(OUT, { recursive: true, force: true });
await mkdir(OUT, { recursive: true });

const manifest = [];
for (const file of files) {
  const content = await readFile(`${SRC}/${file}`, "utf8");
  const id = file.replace(/\.py$/, "");
  
  let desc = id;
  const match = content.match(/(?:^|\n)"""([^\n]*?)(?:"""|$)/);
  if (match) {
    desc = match[1].trim();
  }
  
  // if desc already starts with "id - " or "id — ", remove it
  if (desc.startsWith(id + " - ") || desc.startsWith(id + " — ")) {
    desc = desc.substring(id.length + 3);
  }
  
  manifest.push({ id, label: `${id} — ${desc}`, file });
  await copyFile(`${SRC}/${file}`, OUT + file);
}

await writeFile(OUT + "manifest.json", JSON.stringify(manifest, null, 2) + "\n");
console.log(`vendored ${files.length} examples from ${SRC}`);
