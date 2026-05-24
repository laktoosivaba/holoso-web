// Vendor the Kulibin float RTL into hdl/kulibin/ for the in-browser Yosys worker.
//
// holoso_support.{v,vh} ship inside the wheel (the worker takes them from the synth result), but the
// zkf_* primitives the wrappers instantiate live in the Kulibin submodule and are NOT packaged -- so the
// resource-estimation path needs them vendored as static assets. A manifest.json lists the files for the
// worker to fetch (it indexes their modules to compute each design's instantiation closure).

import { mkdir, rm, readdir, copyFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const SYNTH = process.argv[2] || process.env.SYNTH || ROOT + "../holoso-synth";
const SRC = `${SYNTH.replace(/\/$/, "")}/lib/kulibin/float/hdl`;
const OUT = ROOT + "hdl/kulibin/";

let names;
try {
  names = (await readdir(SRC)).filter((n) => n.endsWith(".v")).sort();
} catch (e) {
  throw new Error(`cannot read Kulibin RTL at ${SRC} (is the submodule checked out? \`git submodule update --init\`): ${e.message}`);
}
if (names.length === 0) throw new Error(`no .v files in ${SRC}`);

await rm(OUT, { recursive: true, force: true });
await mkdir(OUT, { recursive: true });
for (const name of names) await copyFile(`${SRC}/${name}`, OUT + name);
await writeFile(OUT + "manifest.json", JSON.stringify(names) + "\n");

console.log(`vendored ${names.length} Kulibin RTL files from ${SRC}`);
console.log(`  -> ${OUT}`);
