"use strict";

const $ = (id) => document.getElementById(id);
const PLACEHOLDER = "// run a script to populate";
const BOOT_HINT = "# loading demo kernels — the engine is still starting…\n";

// File extension -> Ace mode. ext absent or unmapped -> "text".
const EXT_TO_MODE = {
  v: "verilog", vh: "verilog", sv: "verilog", svh: "verilog",
  vhd: "vhdl", vhdl: "vhdl",
  py: "python", json: "json",
  html: "html", htm: "html",
  txt: "text", log: "text", csv: "text", md: "markdown", rpt: "text",
};
const extToMode = (ext) => EXT_TO_MODE[ext] || "text";

function logMsg(msg, cls) {
  const ts = new Date().toTimeString().slice(0, 8);
  const span = document.createElement("span");
  if (cls) span.className = cls;
  span.textContent = `[${ts}] ${msg}\n`;
  $("log").appendChild(span);
  $("log").scrollTop = $("log").scrollHeight;
}

// Mirror Python's stream contents into the log, one line per timestamp, classed for stdout vs stderr.
function logStreams(stdout, stderr) {
  for (const line of (stdout || "").split("\n")) if (line) logMsg(line, "dim");
  for (const line of (stderr || "").split("\n")) if (line) logMsg(line, "err");
}

const ed = ace.edit("src-editor");
ed.session.setMode("ace/mode/python");
ed.setOptions({ fontFamily: "inherit", fontSize: 12, showPrintMargin: false, useSoftTabs: true, tabSize: 4 });

let editorTouched = false;
function setEditor(text) {
  ed.setValue(text, -1);
  editorTouched = false;
}
ed.on("change", () => {
  editorTouched = true;
});

const out = ace.edit("out-editor");
out.setOptions({ fontFamily: "inherit", fontSize: 12, showPrintMargin: false, readOnly: true });
const outEl = $("out-editor");
const frame = $("out-frame");
const resEl = $("out-resources");

window.addEventListener("resize", () => { ed.resize(); out.resize(); });

const views = { input: $("view-input"), output: $("view-output") };
const tabBtns = { input: $("tab-input"), output: $("tab-output") };

function switchView(name) {
  if (!views[name]) return;
  for (const k of Object.keys(views)) {
    views[k].classList.toggle("active", k === name);
    tabBtns[k].classList.toggle("active", k === name);
  }
  (name === "input" ? ed : out).resize();
}
$("tab-input").onclick = () => switchView("input");
$("tab-output").onclick = () => switchView("output");

let files = [];
let active = -1;
let currentFilename = "src.py";

function showText() { outEl.style.display = ""; frame.style.display = "none"; resEl.style.display = "none"; }
function showFrame() { outEl.style.display = "none"; frame.style.display = "block"; resEl.style.display = "none"; }
function showResources() { outEl.style.display = "none"; frame.style.display = "none"; resEl.style.display = "flex"; }

function clearOutput() {
  files = [];
  active = -1;
  $("out-tabs").innerHTML = "";
  showText();
  out.setValue(PLACEHOLDER, -1);
  frame.removeAttribute("srcdoc");
  $("download").disabled = true;
  $("download-all").disabled = true;
  $("estimate").disabled = true;
  $("route").disabled = true;
  $("resources").innerHTML = RES_HINT;
}

function selectTab(i) {
  active = i;
  const f = files[i];
  if (f.kind === "html") {
    showFrame();
    frame.srcdoc = f.content;
  } else {
    showText();
    out.session.setMode("ace/mode/" + f.mode);
    out.setValue(f.encoding === "base64" ? "(binary — download to view)" : f.content, -1);
    out.resize();
  }
  renderTabs();
}

// "resources" is a pseudo-tab (active === "res"): reveals the Yosys estimate UI in the same content area.
function selectResources() {
  active = "res";
  showResources();
  renderTabs();
}

function renderTabs() {
  const host = $("out-tabs");
  host.innerHTML = "";
  if (files.length === 0) return;
  files.forEach((f, i) => {
    const b = document.createElement("button");
    b.textContent = f.path;
    b.title = f.path;
    if (i === active) b.classList.add("active");
    b.onclick = () => selectTab(i);
    host.appendChild(b);
  });
  // The resources pseudo-tab lives at the end of the strip so the natural reading order is
  // "what the script wrote" first, then "how would this place on hardware" last.
  const rb = document.createElement("button");
  rb.textContent = "resources";
  rb.title = "in-browser Yosys estimate / ECP5 place-and-route on the active .v tab";
  if (active === "res") rb.classList.add("active");
  rb.onclick = () => selectResources();
  host.appendChild(rb);

  const onFile = typeof active === "number" && !!files[active];
  $("download").disabled = !onFile;
  $("download-all").disabled = files.length === 0;
}

// The Estimate/Route buttons operate on whichever .v the user is looking at; falling back to the first .v
// keeps a sensible default when they're parked on the report or testbench tab. holoso_support.v is the
// sibling RTL the synthesizer always co-emits, so pick it from the same directory as the chosen .v.
function activeVerilogFile() {
  if (typeof active === "number" && files[active]?.ext === "v") return files[active];
  for (const f of files) if (f.ext === "v" && !f.path.endsWith("holoso_support.v")) return f;
  for (const f of files) if (f.ext === "v") return f;
  return null;
}

function deriveRouteInputs() {
  const f = activeVerilogFile();
  if (!f) return null;
  const slash = f.path.lastIndexOf("/");
  const dir = slash >= 0 ? f.path.slice(0, slash) : "";
  const supportPath = dir ? `${dir}/holoso_support.v` : "holoso_support.v";
  const support = files.find((x) => x.path === supportPath);
  const top = f.path.slice(slash + 1).replace(/\.v$/, "");
  return { top, verilog: f.content, support: support?.content || "" };
}

let examples = [];

function populatePicker() {
  const sel = $("example");
  sel.innerHTML = "";
  for (const ex of examples) {
    const o = document.createElement("option");
    o.value = ex.id;
    o.textContent = ex.label;
    sel.appendChild(o);
  }
}

function loadExample(id) {
  const ex = examples.find((e) => e.id === id) || examples[0];
  if (!ex) return;
  setEditor(ex.source);
  currentFilename = ex.filename || `${ex.id}.py`;
  $("src-filename").textContent = currentFilename;
  ed.session.clearAnnotations();
  ed.focus();
  $("example").value = ex.id;
  clearOutput();
}
$("example").onchange = () => loadExample($("example").value);

const worker = new Worker("worker.js");
let ready = false;
let reqId = 0;

worker.onmessage = (e) => {
  const m = e.data;
  switch (m.type) {
    case "status":
      $("engine").textContent = m.msg;
      logMsg(m.msg, "dim");
      break;
    case "ready":
      ready = true;
      examples = m.examples || [];
      populatePicker();
      if (!editorTouched && examples.length) loadExample(examples[0].id);
      $("engine").textContent = m.versions;
      logMsg("engine ready · " + m.versions, "ok");
      logMsg(`${examples.length} demo kernels loaded`, "dim");
      $("run").disabled = false;
      break;
    case "fatal":
      $("engine").textContent = "engine failed to start";
      logMsg("engine init failed: " + m.msg, "err");
      break;
    case "result":
      onResult(m.json);
      break;
  }
};

// Initial tab pick after a successful run: prefer the last .html (deepest report, e.g. the wide e8m36 config
// in ekf1_stateful), else the last .v, else the first emitted file. Empty file list -> just show stdout.
function pickInitialTab(files) {
  for (let i = files.length - 1; i >= 0; i--) if (files[i].kind === "html") return i;
  for (let i = files.length - 1; i >= 0; i--) if (files[i].ext === "v") return i;
  return files.length > 0 ? 0 : -1;
}

function onResult(jsonStr) {
  $("run").disabled = false;
  ed.session.clearAnnotations();
  let r;
  try {
    r = JSON.parse(jsonStr);
  } catch {
    logMsg("malformed result from engine", "err");
    return;
  }

  // Stream output goes to the log regardless of ok/fail -- partial stdout up to the error is useful diagnostic.
  logStreams(r.stdout, r.stderr);

  if (r.ok) {
    files = (r.files || []).map((f) => ({
      path: f.path,
      content: f.content,
      ext: f.ext,
      kind: (f.ext === "html" || f.ext === "htm") ? "html" : "text",
      mode: extToMode(f.ext),
      encoding: f.encoding,
    }));
    const tab = pickInitialTab(files);
    const haveVerilog = files.some((f) => f.ext === "v");
    $("estimate").disabled = !haveVerilog;
    $("route").disabled = !haveVerilog;
    if (tab >= 0) {
      selectTab(tab);
    } else {
      $("out-tabs").innerHTML = "";
      showText();
      out.setValue("// script ran but emitted no files — see log for stdout/stderr", -1);
      $("download").disabled = true;
      $("download-all").disabled = true;
    }
    logMsg(`ran ${currentFilename} · ${files.length} file${files.length === 1 ? "" : "s"} emitted`, "ok");
  } else {
    switchView("input");
    showText();
    out.setValue(PLACEHOLDER, -1);
    reportError(r.error || {});
  }
}

function reportError(err) {
  const lines = (err.message || "").split("\n").filter(Boolean);
  const tail = lines[lines.length - 1] || "script failed";
  logMsg(`${err.kind || "error"}: ${tail}`, "err");

  const loc = err.location;
  if (loc) {
    const row = (loc.lineno || 1) - 1;
    ed.session.setAnnotations([{ row, column: loc.col || 0, text: err.message || tail, type: "error" }]);
    if (loc.line) logMsg(`  L${loc.lineno}: ${String(loc.line).trim()}`, "dim");
    ed.gotoLine(row + 1, loc.col || 0, true);
    ed.focus();
  } else if (err.kind === "InternalError" || err.kind === "BadRequest") {
    logMsg(err.message, "dim");
  }
}

$("run").onclick = () => {
  if (!ready) {
    logMsg("engine not ready yet", "err");
    return;
  }
  $("run").disabled = true;
  clearOutput();

  // Extras follow the loaded example so cross-file demos (e.g. ekf1_stateful imports ekf1_stateless) resolve.
  const currentExample = examples.find((e) => e.id === $("example").value);
  const req = {
    type: "run",
    id: ++reqId,
    filename: currentFilename,
    source: ed.getValue(),
    extras: currentExample?.extras || {},
  };
  logMsg(`POST run ${currentFilename}`);
  worker.postMessage(req);

  switchView("output");
  out.setValue("// running…", -1);
  out.resize();
};

function triggerDownload(name, blob) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(a.href);
}

function activeFileBlob(f) {
  if (f.encoding === "base64") {
    const raw = atob(f.content);
    const arr = new Uint8Array(raw.length);
    for (let i = 0; i < raw.length; i++) arr[i] = raw.charCodeAt(i);
    return new Blob([arr], { type: "application/octet-stream" });
  }
  return new Blob([f.content], { type: f.kind === "html" ? "text/html" : "text/plain" });
}

$("download").onclick = () => {
  const f = files[active];
  if (!f) return;
  const leaf = f.path.split("/").pop();
  triggerDownload(leaf, activeFileBlob(f));
};

// Bundle every emitted file (preserving relative paths) plus the Kulibin support RTL into one .tar.gz, so
// the download is a self-contained, synthesizable source set. nanotar is imported lazily.
$("download-all").onclick = async () => {
  if (!files.length || $("download-all").disabled) return;
  const btn = $("download-all");
  const label = btn.textContent;
  btn.disabled = true;
  btn.textContent = "bundling…";
  try {
    const entries = files.map((f) => ({
      name: f.path,
      data: f.encoding === "base64" ? Uint8Array.from(atob(f.content), (c) => c.charCodeAt(0)) : f.content,
    }));
    const manifest = await (await fetch("hdl/kulibin/manifest.json")).json();
    for (const n of manifest) {
      entries.push({ name: "kulibin/float/hdl/" + n, data: await (await fetch("hdl/kulibin/" + n)).text() });
    }
    const { createTarGzip } = await import("./nanotar.js");
    const gz = await createTarGzip(entries);
    const stem = currentFilename.replace(/\.py$/, "") || "bundle";
    triggerDownload(`${stem}.tar.gz`, new Blob([gz], { type: "application/gzip" }));
    logMsg(`bundled ${entries.length} files → ${stem}.tar.gz`, "ok");
  } catch (e) {
    logMsg("bundle failed: " + (e.message || e), "err");
  } finally {
    btn.textContent = label;
    btn.disabled = false;
  }
};

const ARCH_LABEL = { generic: "generic gates", ecp5: "Lattice ECP5", xilinx: "Xilinx 7-series", ice40: "Lattice iCE40" };

const ECP5_PKGS = {
  "--12k": ["CABGA256", "CABGA381", "CSFBGA285", "TQFP144"],
  "--25k": ["CABGA256", "CABGA381", "CSFBGA285", "TQFP144"],
  "--45k": ["CABGA256", "CABGA381", "CABGA554", "CSFBGA285", "TQFP144"],
  "--85k": ["CABGA381", "CABGA554", "CABGA756", "CSFBGA285"],
};
const PAD_RANK = { CABGA756: 6, CABGA554: 5, CABGA400: 4, CABGA381: 3, CABGA256: 2, CSFBGA285: 1, TQFP144: 0 };

function populatePackages() {
  const sel = $("ecp5-pkg");
  const pkgs = (ECP5_PKGS[$("ecp5-die").value] || []).slice().sort((a, b) => (PAD_RANK[b] || 0) - (PAD_RANK[a] || 0));
  sel.innerHTML = "";
  for (const p of pkgs) {
    const o = document.createElement("option");
    o.value = o.textContent = p;
    sel.appendChild(o);
  }
  sel.value = pkgs[0];
}
$("ecp5-die").onchange = populatePackages;
populatePackages();
let yosysWorker = null;
let busy = false;
let yosysReady = false;

const RES_HINT = '<span class="dim">run a script that emits a .v file, then estimate gate/FPGA resources</span>';

function escapeHtml(s) {
  return String(s).replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c]);
}

function summarizeCells(counts) {
  const sum = (re) => Object.entries(counts).reduce((a, [t, n]) => a + (re.test(t) ? n : 0), 0);
  return { LUT: sum(/LUT/i), DSP: sum(/MULT|DSP|MAC/i), FF: sum(/(^|_)(FF|FD[RSCP]|DFF)/i), carry: sum(/CARRY|CCU|(^|_)CY/i), BRAM: sum(/BRAM|EBR|DP16|PDPW|RAM(?!P)/i) };
}

function renderResources(m) {
  const s = summarizeCells(m.counts);
  const chips = Object.entries(s).filter(([, n]) => n > 0).map(([k, n]) => `<span class=chip>${k} ${n}</span>`).join("");
  const rows = Object.entries(m.counts).sort((a, b) => b[1] - a[1]).map(([t, n]) => `<tr><td class=n>${n}</td><td>${escapeHtml(t)}</td></tr>`).join("");
  $("resources").innerHTML =
    `<div class=head><b>${m.total}</b> cells · ${ARCH_LABEL[m.target]} · ${m.top} · ${m.libFiles.length} support modules</div>` +
    (chips ? `<div class=chips>${chips}</div>` : "") +
    `<table>${rows}</table>`;
}

function finishResources() {
  busy = false;
  const haveVerilog = files.some((f) => f.ext === "v");
  $("estimate").disabled = !haveVerilog;
  $("route").disabled = !haveVerilog;
}

function renderPnr(m) {
  const rep = m.report || {};
  const top = rep.fmax && rep.fmax[0];
  const headline = top && typeof top.achieved === "number"
    ? `<b>${top.achieved.toFixed(1)}</b> MHz`
    : "<b>—</b> (no clocked paths)";
  const clk = top ? ` · clock <code>${escapeHtml(top.clock)}</code>` : "";
  const util = (rep.utilization || []).slice(0, 8).map((u) => {
    const pct = u.available ? ((u.used / u.available) * 100).toFixed(u.used / u.available < 0.1 ? 1 : 0) : "?";
    return `<span class=chip>${escapeHtml(u.type)} ${u.used}/${u.available} (${pct}%)</span>`;
  }).join("");
  const cp = rep.criticalPath;
  let cpHtml = "";
  if (cp) {
    const srcs = (cp.sources || []).slice(0, 6).map(escapeHtml).join(", ");
    cpHtml =
      `<div class=warn>critical path ${cp.ns.toFixed(2)} ns ` +
      `(logic ${cp.logic.toFixed(1)} + routing ${cp.routing.toFixed(1)}, ${cp.segments} hops)</div>` +
      (srcs ? `<div class=dim>through: ${srcs}</div>` : "");
  }
  $("resources").innerHTML =
    `<div class=head>${headline} post-route · ${escapeHtml(m.device)} · ${escapeHtml(m.top)}${clk}</div>` +
    (util ? `<div class=chips>${util}</div>` : "") +
    cpHtml;
}

function ensureYosys() {
  if (yosysWorker) return yosysWorker;
  yosysWorker = new Worker("yosys-worker.js", { type: "module" });
  yosysWorker.onmessage = (e) => {
    const m = e.data;
    if (m.type === "progress") {
      $("resources").innerHTML = `<span class=dim>downloading… ${((m.done / m.total) * 100).toFixed(0)}% of ${(m.total / 1048576).toFixed(0)} MB (cached after first load)</span>`;
    } else if (m.type === "status") {
      $("resources").innerHTML = `<span class=dim>${escapeHtml(m.msg)}</span>`;
    } else if (m.type === "ready") {
      yosysReady = true;
      if (!busy) $("resources").innerHTML = RES_HINT;
      logMsg("yosys engine ready", "ok");
    } else if (m.type === "result") {
      finishResources();
      renderResources(m);
      logMsg(`yosys ${m.target}: ${m.total} cells`, "ok");
    } else if (m.type === "routeResult") {
      finishResources();
      renderPnr(m);
      const f = m.report?.fmax?.[0]?.achieved;
      logMsg(`nextpnr ${m.device}: routed${typeof f === "number" ? ` · Fmax ${f.toFixed(1)} MHz` : ""}`, "ok");
    } else if (m.type === "error") {
      finishResources();
      $("resources").innerHTML = `<div class=err>${escapeHtml(m.message)}</div>`;
      logMsg("resource estimate failed", "err");
    }
  };
  yosysWorker.onerror = (e) => {
    finishResources();
    $("resources").innerHTML = `<div class=err>yosys worker error: ${escapeHtml(e.message || String(e))}</div>`;
  };
  return yosysWorker;
}

$("estimate").onclick = () => {
  const inputs = deriveRouteInputs();
  if (!inputs || busy) return;
  busy = true;
  $("estimate").disabled = true;
  $("route").disabled = true;
  $("resources").innerHTML = '<span class="dim">starting yosys…</span>';
  ensureYosys().postMessage({
    type: "estimate",
    id: ++reqId,
    top: inputs.top,
    verilog: inputs.verilog,
    support: inputs.support,
    target: $("arch").value,
  });
};

$("route").onclick = () => {
  const inputs = deriveRouteInputs();
  if (!inputs || busy) return;
  busy = true;
  $("estimate").disabled = true;
  $("route").disabled = true;
  $("resources").innerHTML = '<span class="dim">starting place &amp; route…</span>';
  ensureYosys().postMessage({
    type: "route",
    id: ++reqId,
    top: inputs.top,
    verilog: inputs.verilog,
    support: inputs.support,
    device: $("ecp5-die").value,
    pkg: $("ecp5-pkg").value,
  });
};

setEditor(BOOT_HINT);
clearOutput();
$("run").disabled = true;
$("engine").textContent = "starting engine…";
logMsg("booting Pyodide engine — first load downloads the runtime + numpy + sympy (tens of MB)…", "dim");
worker.postMessage({ type: "init" });
ensureYosys();
