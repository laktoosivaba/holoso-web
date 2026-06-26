"use strict";

const $ = (id) => document.getElementById(id);
const PLACEHOLDER = "// run a script to populate";
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

// Stderr carries both genuine errors AND holoso's logging output (the Python logging module writes to
// stderr by default), so classify stderr lines by their leading level word -- otherwise routine INFO
// records read as failure. Continuation lines (no leading level word) inherit the previous line's class,
// since multi-line log records share a single severity. State persists across stream messages within
// one run and resets on each new Run click.
const LOG_LEVEL_CLS = { DEBUG: "dim", INFO: "dim", WARNING: "warn", WARN: "warn", ERROR: "err", CRITICAL: "err", FATAL: "err" };
function classifyStderr(line, prevCls) {
  const m = line.match(/^(DEBUG|INFO|WARNING|WARN|ERROR|CRITICAL|FATAL)\b/);
  if (m) return LOG_LEVEL_CLS[m[1]];
  if (/^\s/.test(line) && prevCls) return prevCls;
  return "err";
}
let lastStderrCls = null;
function logStreamLine(stream, line) {
  if (!line) return;
  if (stream === "stdout") {
    logMsg(line, "dim");
    lastStderrCls = null;  // stderr continuation breaks when stdout interleaves
  } else {
    const cls = classifyStderr(line, lastStderrCls);
    logMsg(line, cls);
    lastStderrCls = cls;
  }
}

const ed = ace.edit("src-editor");
ed.session.setMode("ace/mode/python");
ed.setOptions({ fontFamily: "inherit", fontSize: 12, showPrintMargin: false, useSoftTabs: true, tabSize: 4 });

function setEditor(text) {
  ed.setValue(text, -1);
}

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
  // Drives the body[data-view=…] CSS selector that hides/shows the per-view action group on the right
  // of the top nav (Run on input, Estimate/Route + selects on resources, nothing on output).
  document.body.dataset.view = name;
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
  // The generated module `include`s holoso_support.vh (the function header), so read_verilog needs it in the FS.
  const supportVhPath = dir ? `${dir}/holoso_support.vh` : "holoso_support.vh";
  const supportVh = files.find((x) => x.path === supportVhPath);
  const top = f.path.slice(slash + 1).replace(/\.v$/, "");
  return { top, verilog: f.content, support: support?.content || "", supportVh: supportVh?.content || "" };
}

// --- demo / worker / run flow --------------------------------------------------------------------

let examples = [];
let currentExampleId = null;
// "readme" shows the rendered onboarding doc; "editor" shows a demo (or the user's edits) in the Ace
// editor. Drives which row in the input tree is active and whether Run is enabled.
let inputMode = "readme";
// Latest engine-boot status, surfaced as a loading row in the input tree until the engine is ready.
let engineStatus = "starting…";

// Run only makes sense over a kernel, so disable it whenever the README is selected (or the engine is
// still booting).
function syncRunEnabled() {
  $("run").disabled = !(ready && inputMode === "editor");
}

function showEditorPane() {
  $("readme-view").style.display = "none";
  $("src-editor").style.display = "";
  ed.resize();  // Ace lays out at zero size while display:none, so re-measure on reveal.
}

const HOLOSO_README_PATH = "holoso/README.md";
const HOLOSO_DOC_BASE = "holoso/";

function rebaseHolosoDocUrl(url) {
  if (!url || /^(?:[a-z][a-z0-9+.-]*:|\/\/|#|\/)/i.test(url)) return url;
  return HOLOSO_DOC_BASE + url.replace(/^\.\//, "");
}

// The upstream Holoso README is fetched and rendered once, then cached. It is vendored from the same
// release as the wheel, so marked's HTML output is injected directly (no sanitization). Links open in a
// new tab so following one doesn't navigate away from the app.
let readmeHtml = null;
async function renderReadme() {
  const host = $("readme-view");
  if (readmeHtml !== null) { host.innerHTML = readmeHtml; return; }
  host.innerHTML = '<p class="readme-dim">loading README…</p>';
  try {
    const md = await (await fetch(HOLOSO_README_PATH)).text();
    const { marked } = await import("./marked.esm.js");
    host.innerHTML = marked.parse(md);
  } catch (e) {
    host.innerHTML = `<p class="readme-err">couldn't load ${HOLOSO_README_PATH}: ${escapeHtml(String(e?.message || e))}</p>`;
    return;
  }
  for (const el of host.querySelectorAll("[src]")) {
    el.setAttribute("src", rebaseHolosoDocUrl(el.getAttribute("src")));
  }
  for (const a of host.querySelectorAll("a[href]")) {
    a.setAttribute("href", rebaseHolosoDocUrl(a.getAttribute("href")));
    a.target = "_blank";
    a.rel = "noopener noreferrer";
  }
  readmeHtml = host.innerHTML;
}

// The default landing input. Shows the rendered README in place of the editor and pins the matching
// tree row active; Run is disabled while it's up.
function showReadme() {
  inputMode = "readme";
  $("src-filename").textContent = "README.md";
  // Explicit "block", not "" — the base rule is display:none, so clearing the inline style would fall
  // back to that and leave the pane blank.
  $("readme-view").style.display = "block";
  $("src-editor").style.display = "none";
  ed.session.clearAnnotations();
  renderReadme();
  renderInputTree();
  syncRunEnabled();
}

function inputRow({ label, title, active, onClick }) {
  const li = document.createElement("li");
  const row = document.createElement("div");
  row.className = "file" + (active ? " active" : "");
  row.style.paddingLeft = "18px";
  const icon = document.createElement("span");
  icon.className = "icon";
  icon.textContent = "•";
  const name = document.createElement("span");
  name.className = "name";
  name.textContent = label;
  name.title = title;
  row.append(icon, name);
  row.onclick = onClick;
  li.appendChild(row);
  return li;
}

// A non-clickable status row shown under README while the engine boots, so the tree visibly reflects
// that the page is still loading instead of looking like a finished one-item list.
function loadingRow(text) {
  const li = document.createElement("li");
  const row = document.createElement("div");
  row.className = "file disabled";
  row.style.paddingLeft = "18px";
  const icon = document.createElement("span");
  icon.className = "icon";
  icon.textContent = "…";
  const name = document.createElement("span");
  name.className = "name";
  name.textContent = text;
  row.append(icon, name);
  li.appendChild(row);
  return li;
}

// The input tree pins README.md at the top (the default doc), then lists every demo kernel with the same
// row styling as the output trees so the visual language matches across all three tabs. Clicking a row
// activates it (blue) and either shows the README or loads the demo's source + sibling extras. Until the
// engine is ready the demos aren't loaded yet, so a loading row stands in for them.
function renderInputTree() {
  const host = $("input-tree");
  host.innerHTML = "";
  const ul = document.createElement("ul");
  ul.appendChild(inputRow({
    label: "README.md",
    title: "Holoso README",
    active: inputMode === "readme",
    onClick: showReadme,
  }));
  for (const ex of examples) {
    ul.appendChild(inputRow({
      label: ex.filename || `${ex.id}.py`,
      title: ex.label || ex.filename || ex.id,
      active: inputMode === "editor" && ex.id === currentExampleId,
      onClick: () => loadExample(ex.id),
    }));
  }
  if (!ready) ul.appendChild(loadingRow(engineStatus));
  host.appendChild(ul);
}

function loadExample(id) {
  const ex = examples.find((e) => e.id === id) || examples[0];
  if (!ex) return;
  inputMode = "editor";
  setEditor(ex.source);
  currentFilename = ex.filename || `${ex.id}.py`;
  currentExampleId = ex.id;
  $("src-filename").textContent = currentFilename;
  showEditorPane();
  ed.session.clearAnnotations();
  ed.focus();
  renderInputTree();
  syncRunEnabled();
  clearOutput();
}

const worker = new Worker("worker.js");
let ready = false;
let reqId = 0;

worker.onmessage = (e) => {
  const m = e.data;
  switch (m.type) {
    case "status":
      logMsg(m.msg, "dim");
      engineStatus = m.msg;
      if (!ready) renderInputTree();  // reflect boot progress in the tree's loading row
      break;
    case "ready":
      ready = true;
      examples = m.examples || [];
      renderInputTree();  // demos now join README in the tree; the README stays the active landing view
      logMsg("engine ready · " + m.versions, "ok");
      logMsg(`${examples.length} demo kernels loaded`, "dim");
      syncRunEnabled();
      break;
    case "fatal":
      logMsg("engine init failed: " + m.msg, "err");
      break;
    case "stream":
      logStreamLine(m.stream, m.line);
      break;
    case "result":
      onResult(m.json);
      break;
  }
};

// Initial picks after a successful run. Output prefers the last .html (typically the richest report a
// kernel emits); Resources prefers the last non-support .v from the same run, so the two views show
// "the same" pipeline by default.
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
  syncRunEnabled();
  ed.session.clearAnnotations();
  let r;
  try {
    r = JSON.parse(jsonStr);
  } catch {
    logMsg("malformed result from engine", "err");
    return;
  }

  // stdout/stderr were already painted live via the "stream" message handler; the envelope still carries
  // them for clients (tests, devtools) that want the full transcript, but no need to re-log here.

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
  lastStderrCls = null;  // fresh stderr-continuation state for the new run

  // Extras follow the loaded example so cross-file demos (e.g. ekf1_stateful imports ekf1_stateless) resolve.
  const currentExample = examples.find((e) => e.id === currentExampleId);
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

// Bundle every emitted file (preserving relative paths) into one .tar.gz. The emitted set already includes the
// self-contained holoso_support.{v,vh} alongside the design, so the bundle is a complete synthesizable source
// set with no external RTL needed. nanotar is imported lazily.
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
    supportVh: inputs.supportVh,
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
    supportVh: inputs.supportVh,
    device: $("ecp5-die").value,
    pkg: $("ecp5-pkg").value,
  });
};

clearOutput();
showReadme();  // default landing: the rendered README, readable while the engine downloads in the background
document.body.dataset.view = "input";
logMsg("booting Pyodide engine — first load downloads the runtime + numpy + sympy (tens of MB)…", "dim");
worker.postMessage({ type: "init" });
ensureYosys();
