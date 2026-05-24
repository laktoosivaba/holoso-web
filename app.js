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

let files = [];
let active = 0;

function showText() { outEl.style.display = ""; frame.style.display = "none"; }
function showFrame() { outEl.style.display = "none"; frame.style.display = ""; }

function clearOutput() {
  files = [];
  active = 0;
  $("out-tabs").innerHTML = "";
  showText();
  out.setValue(PLACEHOLDER, -1);
  frame.removeAttribute("srcdoc");
  $("download").disabled = true;
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
      { name: "test_" + mod + ".py", content: r.testbench, kind: "text", mode: "python" },
      { name: mod + ".html", content: r.report_html, kind: "html" },
    ];
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

$("download").onclick = () => {
  const f = files[active];
  if (!f) return;
  const blob = new Blob([f.content], { type: f.kind === "html" ? "text/html" : "text/plain" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = f.name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(a.href);
};

setEditor(BOOT_HINT);
clearOutput();
$("synth").disabled = true;
$("engine").textContent = "starting engine…";
logMsg("booting Pyodide engine — first load downloads the runtime + numpy + sympy (tens of MB)…", "dim");
worker.postMessage({ type: "init" });
