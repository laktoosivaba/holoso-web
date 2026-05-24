// In-browser Yosys resource estimation. A module Web Worker (so it can `import` the vendored @yowasp/yosys
// bundle and the shared closure builder), spawned lazily by app.js only when the user asks for an estimate --
// loading yosys pulls ~50 MB of WASM, so it must never be on the page's critical path.
//
// Flow per request: take the synthesized module + its holoso_support.{v,vh} (from the synth result) and the
// vendored Kulibin RTL, compute the instantiation closure (closure.js), run read_verilog -> hierarchy -check
// -> synth[/_arch] -> write_json, and report the post-synth cell-type histogram parsed from the JSON netlist.
// hierarchy -check is authoritative for unresolved modules: if it aborts, we surface that rather than numbers.

import { runYosys } from "./yosys/bundle.js";
import { closure } from "./closure.js";
import { synthScript, cellHistogram } from "./yosys-job.js";

let kulibinPromise = null;
function loadKulibin() {
  if (!kulibinPromise) {
    kulibinPromise = (async () => {
      const names = await (await fetch("hdl/kulibin/manifest.json")).json();
      const entries = await Promise.all(
        names.map(async (name) => [name, await (await fetch("hdl/kulibin/" + name)).text()])
      );
      return Object.fromEntries(entries);
    })();
  }
  return kulibinPromise;
}

async function estimate(req) {
  const { top, verilog, support, supportHeader, target } = req;
  postMessage({ type: "status", id: req.id, msg: `synthesizing ${top} for ${target}…` });
  const kulibin = await loadKulibin();
  const library = { "holoso_support.v": support, ...kulibin };
  const { files: libFiles } = closure(top, verilog, library);

  const files = { "holoso_support.vh": supportHeader, [`${top}.v`]: verilog, "job.ys": synthScript(top, libFiles, target) };
  for (const f of libFiles) files[f] = library[f];

  let log = "";
  const sink = (bytes) => {
    if (bytes) log += typeof bytes === "string" ? bytes : new TextDecoder().decode(bytes);
  };
  const fetchProgress = (e) => {
    if (e.totalLength) postMessage({ type: "progress", done: e.doneLength, total: e.totalLength });
  };

  let outputs;
  try {
    outputs = await runYosys(["job.ys"], files, { stdout: sink, stderr: sink, decodeASCII: true, fetchProgress });
  } catch (err) {
    const tail = log.split("\n").filter(Boolean).slice(-8).join("\n");
    throw new Error((err?.message || String(err)) + (tail ? "\n" + tail : ""));
  }
  const netlist = JSON.parse(outputs["netlist.json"]);
  const counts = cellHistogram(netlist, top);
  if (!counts) throw new Error(`no cells found for top module '${top}' in the netlist`);
  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  postMessage({ type: "result", id: req.id, target, top, total, counts, libFiles, log });
}

// One WASM instance backs every invocation, so serialize them through a promise chain. The first link warms
// yosys up eagerly (this worker is spawned at page load, not on first click) so the ~50 MB download and
// instantiation overlap with the user reading the page; later Estimate clicks then run with no startup cost.
let queue = Promise.resolve();
function enqueue(task) {
  const result = queue.then(task);
  queue = result.then(() => {}, () => {});
  return result;
}

function warmUp() {
  postMessage({ type: "status", msg: "loading yosys…" });
  const fetchProgress = (e) => {
    if (e.totalLength) postMessage({ type: "progress", done: e.doneLength, total: e.totalLength });
  };
  return runYosys(["-V"], {}, { stdout: () => {}, stderr: () => {}, fetchProgress }).then(() => postMessage({ type: "ready" }));
}

enqueue(warmUp).catch((err) => postMessage({ type: "error", message: "yosys failed to load: " + String(err?.message || err) }));

onmessage = (e) => {
  const req = e.data;
  if (req.type !== "estimate") return;
  // hierarchy -check abort (unresolved module) and any other yosys failure surface here with the log tail.
  enqueue(() => estimate(req)).catch((err) => postMessage({ type: "error", id: req.id, message: String(err?.message || err) }));
};
