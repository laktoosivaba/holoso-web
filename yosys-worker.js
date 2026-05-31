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
import { synthScript, cellHistogram, ecp5JsonScript, nextpnrArgs, summarizePnrReport } from "./yosys-job.js";

// nextpnr-ecp5 is ~170 MB of ECP5 chipdb -- never load it on page-load warm-up. The bundle is dynamically
// imported on the first Route request; its resource tars are then fetched by the runtime on first run.
let nextpnrPromise = null;
function loadNextpnr() {
  if (!nextpnrPromise) nextpnrPromise = import("./nextpnr-ecp5/bundle.js").then((m) => m.runNextpnrEcp5);
  return nextpnrPromise;
}

function tail(log, n = 8) {
  const lines = log.split("\n").filter(Boolean);
  return lines.length ? "\n" + lines.slice(-n).join("\n") : "";
}

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
  const { top, verilog, support, target } = req;
  postMessage({ type: "status", id: req.id, msg: `synthesizing ${top} for ${target}…` });
  const kulibin = await loadKulibin();
  const library = { "holoso_support.v": support, ...kulibin };
  const { files: libFiles } = closure(top, verilog, library);

  const files = { [`${top}.v`]: verilog, "job.ys": synthScript(top, libFiles, target) };
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

// nextpnr throws an opaque wasm trap on failure; the real reason is the last `ERROR:` line of its log.
// The common case here is pad overflow -- the raw kernel has more top ports than the package has pads.
function pnrErrorMessage(err, log, pkg) {
  const errLine = log.split("\n").reverse().find((l) => /ERROR:/.test(l));
  if (errLine && /TRELLIS_IO/.test(errLine)) {
    return (
      `place-and-route failed: the design needs more I/O pads than the ECP5 package${pkg ? " (" + pkg + ")" : ""} provides.\n` +
      "holoso exposes every operand and result as a top-level port, so wide kernels are I/O-pad-bound — try a larger package.\n" +
      errLine.trim()
    );
  }
  if (errLine) return "place-and-route failed:\n" + errLine.trim() + tail(log, 4);
  return "place-and-route failed: " + (err?.message || String(err)) + tail(log);
}

async function route(req) {
  const { top, verilog, support, device, pkg } = req;
  const label = `ECP5-${(device || "--85k").replace(/^--/, "")}${pkg ? " " + pkg : ""}`;
  postMessage({ type: "status", id: req.id, msg: `synthesizing ${top} for ECP5…` });
  const kulibin = await loadKulibin();
  const library = { "holoso_support.v": support, ...kulibin };
  const { files: libFiles } = closure(top, verilog, library);

  const files = { [`${top}.v`]: verilog, "job.ys": ecp5JsonScript(top, libFiles) };
  for (const f of libFiles) files[f] = library[f];

  let synthLog = "";
  const synthSink = (b) => { if (b) synthLog += typeof b === "string" ? b : new TextDecoder().decode(b); };
  let synthOut;
  try {
    synthOut = await runYosys(["job.ys"], files, { stdout: synthSink, stderr: synthSink, decodeASCII: true });
  } catch (err) {
    throw new Error("synth_ecp5 failed: " + (err?.message || String(err)) + tail(synthLog));
  }
  const designJson = synthOut["design.json"];
  if (!designJson) throw new Error("synth_ecp5 produced no netlist (design.json)");

  postMessage({ type: "status", id: req.id, msg: "loading nextpnr-ecp5… (~170 MB, cached after first use)" });
  const runNextpnr = await loadNextpnr();

  let pnrLog = "";
  const pnrSink = (b) => { if (b) pnrLog += typeof b === "string" ? b : new TextDecoder().decode(b); };
  const fetchProgress = (e) => {
    if (e.totalLength) postMessage({ type: "progress", done: e.doneLength, total: e.totalLength });
  };
  postMessage({ type: "status", id: req.id, msg: `placing & routing ${top} on ${label}…` });

  let pnrOut;
  try {
    pnrOut = await runNextpnr(nextpnrArgs({ device, pkg }), { "design.json": designJson }, { stdout: pnrSink, stderr: pnrSink, decodeASCII: true, fetchProgress });
  } catch (err) {
    throw new Error(pnrErrorMessage(err, pnrLog, pkg));
  }
  const report = summarizePnrReport(pnrOut["report.json"]);
  if (!report) throw new Error("nextpnr produced no usable report.json" + tail(pnrLog));
  postMessage({ type: "routeResult", id: req.id, top, device: label, report, log: pnrLog });
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
  // hierarchy -check abort (unresolved module), nextpnr placement/route failure (pad overflow), and any
  // other tool failure surface here with the log tail. Both jobs share the one wasm serialization queue.
  if (req.type === "estimate") {
    enqueue(() => estimate(req)).catch((err) => postMessage({ type: "error", id: req.id, message: String(err?.message || err) }));
  } else if (req.type === "route") {
    enqueue(() => route(req)).catch((err) => postMessage({ type: "error", id: req.id, message: String(err?.message || err) }));
  }
};
