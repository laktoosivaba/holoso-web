"use strict";

const $ = (id) => document.getElementById(id);
const PLACEHOLDER = "// run a script to populate";
const BOOT_HINT = "# loading demo kernels — the engine is still starting…\n";
const RES_HINT = '<span class="dim">run a script that emits a .v file, then estimate gate/FPGA resources</span>';

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

window.addEventListener("resize", () => { ed.resize(); out.resize(); });

// Three top-level views: Python input (editor + Run), Output (file tree + emitted-file preview),
// Resources (file tree filtered to .v + estimate/route).
const views = { input: $("view-input"), output: $("view-output"), resources: $("view-resources") };
const tabBtns = { input: $("tab-input"), output: $("tab-output"), resources: $("tab-resources") };

function switchView(name) {
  if (!views[name]) return;
  for (const k of Object.keys(views)) {
    views[k].classList.toggle("active", k === name);
    tabBtns[k].classList.toggle("active", k === name);
  }
  // Ace lays out at zero size while its container is display:none, so re-measure on reveal.
  if (name === "input") ed.resize();
  else if (name === "output") out.resize();
}
$("tab-input").onclick = () => switchView("input");
$("tab-output").onclick = () => switchView("output");
$("tab-resources").onclick = () => switchView("resources");

// Single shared model: the list of files the script emitted, plus two independent selections.
// activeOutput indexes into files[] (any kind allowed); activeResources also indexes files[] but is
// constrained to a .v entry (Estimate/Route disabled until one is selected).
let files = [];
let activeOutput = -1;
let activeResources = -1;
let currentFilename = "src.py";
let treeRoot = null;
let expanded = new Set();  // dir paths currently open; defaulting to "expand new dirs on creation"

function showText() { outEl.style.display = ""; frame.style.display = "none"; }
function showFrame() { outEl.style.display = "none"; frame.style.display = "block"; }

function clearOutput() {
  files = [];
  activeOutput = -1;
  activeResources = -1;
  treeRoot = null;
  expanded = new Set();
  $("output-tree").innerHTML = "";
  $("resources-tree").innerHTML = "";
  showText();
  out.setValue(PLACEHOLDER, -1);
  frame.removeAttribute("srcdoc");
  $("download").disabled = true;
  $("download-all").disabled = true;
  $("estimate").disabled = true;
  $("route").disabled = true;
  $("res-target").className = "target empty";
  $("res-target").textContent = "no .v selected";
  $("resources").innerHTML = RES_HINT;
}

// --- file tree ------------------------------------------------------------------------------------

// Build a nested {name,type,path,children?} tree out of files[]; "" path = root. Side-effect: any new
// directory is marked expanded (the user's collapse state persists across re-renders within one run).
function buildTree(files) {
  const root = { name: "", type: "dir", path: "", children: [] };
  for (let i = 0; i < files.length; i++) {
    const parts = files[i].path.split("/");
    let node = root;
    for (let j = 0; j < parts.length - 1; j++) {
      const dirName = parts[j];
      let child = node.children.find((c) => c.type === "dir" && c.name === dirName);
      if (!child) {
        const path = (node.path ? node.path + "/" : "") + dirName;
        child = { name: dirName, type: "dir", path, children: [] };
        node.children.push(child);
        expanded.add(path);  // default newly-discovered dir to open
      }
      node = child;
    }
    node.children.push({ name: parts[parts.length - 1], type: "file", idx: i, path: files[i].path });
  }
  return root;
}

function renderNode(node, opts, depth) {
  const li = document.createElement("li");
  if (node.type === "dir") {
    const row = document.createElement("div");
    row.className = "dir";
    row.style.paddingLeft = depth * 12 + 4 + "px";
    const isOpen = expanded.has(node.path);
    const chev = document.createElement("span");
    chev.className = "chev";
    chev.textContent = isOpen ? "▾" : "▸";
    const name = document.createElement("span");
    name.className = "name";
    name.textContent = node.name + "/";
    row.append(chev, name);
    row.onclick = () => {
      if (isOpen) expanded.delete(node.path);
      else expanded.add(node.path);
      renderAllTrees();
    };
    li.appendChild(row);
    if (isOpen) {
      const ul = document.createElement("ul");
      for (const child of node.children) ul.appendChild(renderNode(child, opts, depth + 1));
      li.appendChild(ul);
    }
  } else {
    const f = files[node.idx];
    const enabled = opts.enabledExt(f);
    const row = document.createElement("div");
    row.className = "file" + (enabled ? "" : " disabled") + (node.idx === opts.activeIdx ? " active" : "");
    row.style.paddingLeft = depth * 12 + 18 + "px";
    const icon = document.createElement("span");
    icon.className = "icon";
    icon.textContent = "•";
    const name = document.createElement("span");
    name.className = "name";
    name.title = node.path;
    name.textContent = node.name;
    row.append(icon, name);
    if (enabled) row.onclick = () => opts.onSelect(node.idx);
    li.appendChild(row);
  }
  return li;
}

function renderTree(host, root, opts) {
  host.innerHTML = "";
  if (!root || root.children.length === 0) return;
  const ul = document.createElement("ul");
  for (const child of root.children) ul.appendChild(renderNode(child, opts, 0));
  host.appendChild(ul);
}

function renderAllTrees() {
  renderTree($("output-tree"), treeRoot, {
    activeIdx: activeOutput,
    enabledExt: () => true,
    onSelect: setActiveOutput,
  });
  renderTree($("resources-tree"), treeRoot, {
    activeIdx: activeResources,
    enabledExt: (f) => f.ext === "v",
    onSelect: setActiveResources,
  });
}

// --- selection: Output preview pane ---------------------------------------------------------------

function setActiveOutput(i) {
  if (i < 0 || !files[i]) return;
  activeOutput = i;
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
  $("download").disabled = false;
  // Auto-sync: a non-support .v opened in Output is almost always the one the user wants to estimate,
  // so update the Resources target without a second click. Manual Resources picks aren't overridden.
  if (f.ext === "v" && !f.path.endsWith("holoso_support.v")) {
    setActiveResources(i);
    return;
  }
  renderAllTrees();
}

// --- selection: Resources target (.v only) --------------------------------------------------------

function refreshResourceTargetChip() {
  const inputs = deriveRouteInputs();
  if (inputs) {
    $("res-target").className = "target";
    const note = inputs.support ? "+ holoso_support.v" : "(no sibling holoso_support.v)";
    $("res-target").textContent = `${activeResourcesFile().path} ${note}`;
    $("estimate").disabled = busy;
    $("route").disabled = busy;
  } else {
    $("res-target").className = "target empty";
    $("res-target").textContent = "no .v selected";
    $("estimate").disabled = true;
    $("route").disabled = true;
  }
}

function setActiveResources(i) {
  if (i < 0 || !files[i] || files[i].ext !== "v") return;
  activeResources = i;
  refreshResourceTargetChip();
  renderAllTrees();
}

function activeResourcesFile() {
  return activeResources >= 0 ? files[activeResources] : null;
}

function deriveRouteInputs() {
  const f = activeResourcesFile();
  if (!f || f.ext !== "v") return null;
  const slash = f.path.lastIndexOf("/");
  const dir = slash >= 0 ? f.path.slice(0, slash) : "";
  const supportPath = dir ? `${dir}/holoso_support.v` : "holoso_support.v";
  const support = files.find((x) => x.path === supportPath);
  const top = f.path.slice(slash + 1).replace(/\.v$/, "");
  return { top, verilog: f.content, support: support?.content || "" };
}

// --- demo / worker / run flow --------------------------------------------------------------------

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

// Initial picks after a successful run. Output prefers the last .html (the deepest report; e.g. the
// wide e8m36 variant in ekf1_stateful). Resources prefers the last non-support .v from the same run
// so the two views show "the same" pipeline by default.
function pickInitialOutput(files) {
  for (let i = files.length - 1; i >= 0; i--) if (files[i].kind === "html") return i;
  for (let i = files.length - 1; i >= 0; i--) if (files[i].ext === "v") return i;
  return files.length > 0 ? 0 : -1;
}

function pickInitialResources(files) {
  for (let i = files.length - 1; i >= 0; i--) {
    if (files[i].ext === "v" && !files[i].path.endsWith("holoso_support.v")) return i;
  }
  for (let i = files.length - 1; i >= 0; i--) if (files[i].ext === "v") return i;
  return -1;
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
    treeRoot = buildTree(files);
    $("download-all").disabled = files.length === 0;

    const oi = pickInitialOutput(files);
    const ri = pickInitialResources(files);
    activeOutput = -1;
    activeResources = -1;
    if (ri >= 0) setActiveResources(ri);
    if (oi >= 0) {
      setActiveOutput(oi);
    } else {
      showText();
      out.setValue("// script ran but emitted no files — see log for stdout/stderr", -1);
      $("download").disabled = true;
    }
    renderAllTrees();
    refreshResourceTargetChip();
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

// --- downloads ------------------------------------------------------------------------------------

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
  const f = files[activeOutput];
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

// --- yosys / nextpnr resource estimate ------------------------------------------------------------

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
  refreshResourceTargetChip();
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
