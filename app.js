"use strict";

const $ = (id) => document.getElementById(id);
const PLACEHOLDER = "// run Synthesize to populate";
const BOOT_HINT = "# loading demo kernels — the engine is still starting…\n";

function logMsg(msg, cls) {
  const ts = new Date().toTimeString().slice(0, 8);
  const span = document.createElement("span");
  if (cls) span.className = cls;
  span.textContent = `[${ts}] ${msg}\n`;
  $("log").appendChild(span);
  $("log").scrollTop = $("log").scrollHeight;
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

// The editors now flex to fill their panes, so keep Ace's internal size in sync with the viewport.
window.addEventListener("resize", () => { ed.resize(); out.resize(); });

let files = [];
let active = 0;
let lastResult = null;

function showText() { outEl.style.display = ""; frame.style.display = "none"; }
function showFrame() { outEl.style.display = "none"; frame.style.display = "block"; }

function clearOutput() {
  files = [];
  active = 0;
  lastResult = null;
  $("out-tabs").innerHTML = "";
  showText();
  out.setValue(PLACEHOLDER, -1);
  frame.removeAttribute("srcdoc");
  $("download").disabled = true;
  $("download-all").disabled = true;
  $("estimate").disabled = true;
  $("resources").innerHTML = '<span class="dim">synthesize a kernel, then estimate gate/FPGA resources</span>';
}

function selectTab(i) {
  active = i;
  const f = files[i];
  if (f.kind === "html") {
    showFrame();
    frame.srcdoc = f.content;
  } else {
    showText();
    out.session.setMode("ace/mode/" + (f.mode || "text"));
    out.setValue(f.content, -1);
    out.resize();
  }
  renderTabs();
}

function renderTabs() {
  const host = $("out-tabs");
  host.innerHTML = "";
  files.forEach((f, i) => {
    const b = document.createElement("button");
    b.textContent = f.name;
    if (i === active) b.classList.add("active");
    b.onclick = () => selectTab(i);
    host.appendChild(b);
  });
  $("download").disabled = files.length === 0;
  $("download-all").disabled = files.length === 0;
}

function setEntryOptions(targets, chosen) {
  const sel = $("entry");
  const want = chosen || sel.value;
  sel.innerHTML = '<option value="">(auto)</option>';
  for (const t of targets || []) {
    const o = document.createElement("option");
    o.value = t;
    o.textContent = t;
    sel.appendChild(o);
  }
  sel.value = (targets || []).includes(want) ? want : "";
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
  ed.session.clearAnnotations();
  ed.focus();
  $("example").value = ex.id;
  setEntryOptions([], "");
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
      logMsg(`${examples.length} demo kernels loaded from the wheel`, "dim");
      $("synth").disabled = false;
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

function onResult(jsonStr) {
  $("synth").disabled = false;
  ed.session.clearAnnotations();
  let r;
  try {
    r = JSON.parse(jsonStr);
  } catch {
    logMsg("malformed result from engine", "err");
    return;
  }
  if (r.targets) setEntryOptions(r.targets, r.target);

  if (r.ok) {
    const mod = r.module_name;
    files = [
      { name: mod + ".v", content: r.verilog, kind: "text", mode: "verilog" },
      { name: "holoso_support.v", content: r.support, kind: "text", mode: "verilog" },
      { name: "holoso_support.vh", content: r.support_header, kind: "text", mode: "verilog" },
      { name: "test_" + mod + ".py", content: r.testbench, kind: "text", mode: "python" },
      { name: mod + ".html", content: r.report_html, kind: "html" },
    ];
    lastResult = { top: mod, verilog: r.verilog, support: r.support, supportHeader: r.support_header };
    $("estimate").disabled = false;
    selectTab(0);
    const mt = r.metrics || {};
    logMsg(
      `synthesized ${r.target} → ${mod}.v · ${mt.operator_instances} · ${mt.float_regs} float regs · ` +
        `${mt.steps} steps · II≈${mt.ii_estimate} · chain ${mt.max_chain_len}`,
      "ok"
    );
  } else {
    reportError(r.error || {});
  }
}

function reportError(err) {
  const lines = (err.message || "").split("\n").filter(Boolean);
  const tail = lines[lines.length - 1] || "synthesis failed";
  logMsg(`${err.kind || "error"}: ${tail}`, "err");

  const loc = err.location;
  if (loc) {
    const row = (loc.lineno || 1) - 1;
    ed.session.setAnnotations([{ row, column: loc.col || 0, text: err.message || tail, type: "error" }]);
    if (loc.line) logMsg(`  L${loc.lineno}: ${String(loc.line).trim()}`, "dim");
    ed.gotoLine(row + 1, loc.col || 0, true);
    ed.focus();
  } else if (err.kind === "InternalError") {
    logMsg(err.message, "dim");
  }
}

$("synth").onclick = () => {
  if (!ready) {
    logMsg("engine not ready yet", "err");
    return;
  }
  $("synth").disabled = true;
  clearOutput();

  const req = {
    type: "synth",
    id: ++reqId,
    source: ed.getValue(),
    wexp: parseInt($("wexp").value, 10),
    wman: parseInt($("wman").value, 10),
    entry: $("entry").value,
  };
  logMsg(`POST synth (wexp=${req.wexp} wman=${req.wman}${req.entry ? " entry=" + req.entry : ""})`);
  worker.postMessage(req);
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

$("download").onclick = () => {
  const f = files[active];
  if (!f) return;
  triggerDownload(f.name, new Blob([f.content], { type: f.kind === "html" ? "text/html" : "text/plain" }));
};

// Bundle every output tab plus the Kulibin support RTL into one .tar.gz, so the download is a self-contained,
// synthesizable source set rather than file-by-file. nanotar is imported lazily — only when this is used.
$("download-all").onclick = async () => {
  if (!files.length || !lastResult || $("download-all").disabled) return;
  const btn = $("download-all");
  const label = btn.textContent;
  btn.disabled = true;
  btn.textContent = "bundling…";
  try {
    const entries = files.map((f) => ({ name: f.name, data: f.content }));
    const manifest = await (await fetch("hdl/kulibin/manifest.json")).json();
    for (const n of manifest) {
      entries.push({ name: "kulibin/float/hdl/" + n, data: await (await fetch("hdl/kulibin/" + n)).text() });
    }
    const { createTarGzip } = await import("./nanotar.js");
    const gz = await createTarGzip(entries);
    triggerDownload(`${lastResult.top}.tar.gz`, new Blob([gz], { type: "application/gzip" }));
    logMsg(`bundled ${entries.length} files → ${lastResult.top}.tar.gz`, "ok");
  } catch (e) {
    logMsg("bundle failed: " + (e.message || e), "err");
  } finally {
    btn.textContent = label;
    btn.disabled = false;
  }
};

const ARCH_LABEL = { generic: "generic gates", ecp5: "Lattice ECP5", xilinx: "Xilinx 7-series", ice40: "Lattice iCE40" };
let yosysWorker = null;
let estimateBusy = false;
let yosysReady = false;

const RES_HINT = '<span class="dim">synthesize a kernel, then estimate gate/FPGA resources</span>';

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

function finishEstimate() {
  estimateBusy = false;
  $("estimate").disabled = !lastResult;
}

function ensureYosys() {
  if (yosysWorker) return yosysWorker;
  yosysWorker = new Worker("yosys-worker.js", { type: "module" });
  yosysWorker.onmessage = (e) => {
    const m = e.data;
    if (m.type === "progress") {
      $("resources").innerHTML = `<span class=dim>loading yosys… ${((m.done / m.total) * 100).toFixed(0)}% of ${(m.total / 1048576).toFixed(0)} MB (cached after first load)</span>`;
    } else if (m.type === "status") {
      $("resources").innerHTML = `<span class=dim>${escapeHtml(m.msg)}</span>`;
    } else if (m.type === "ready") {
      yosysReady = true;
      if (!estimateBusy) $("resources").innerHTML = RES_HINT;
      logMsg("yosys engine ready", "ok");
    } else if (m.type === "result") {
      finishEstimate();
      renderResources(m);
      logMsg(`yosys ${m.target}: ${m.total} cells`, "ok");
    } else if (m.type === "error") {
      finishEstimate();
      $("resources").innerHTML = `<div class=err>yosys failed:\n${escapeHtml(m.message)}</div>`;
      logMsg("yosys estimate failed", "err");
    }
  };
  yosysWorker.onerror = (e) => {
    finishEstimate();
    $("resources").innerHTML = `<div class=err>yosys worker error: ${escapeHtml(e.message || String(e))}</div>`;
  };
  return yosysWorker;
}

$("estimate").onclick = () => {
  if (!lastResult || estimateBusy) return;
  estimateBusy = true;
  $("estimate").disabled = true;
  $("resources").innerHTML = '<span class="dim">starting yosys…</span>';
  ensureYosys().postMessage({
    type: "estimate",
    id: ++reqId,
    top: lastResult.top,
    verilog: lastResult.verilog,
    support: lastResult.support,
    supportHeader: lastResult.supportHeader,
    target: $("arch").value,
  });
};

setEditor(BOOT_HINT);
clearOutput();
$("synth").disabled = true;
$("engine").textContent = "starting engine…";
logMsg("booting Pyodide engine — first load downloads the runtime + numpy + sympy (tens of MB)…", "dim");
worker.postMessage({ type: "init" });
ensureYosys(); // start downloading + warming yosys now so Estimate is instant later (~50 MB, cached after)
