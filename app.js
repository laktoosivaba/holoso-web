// UI controller for holoso-web. Owns the editors, controls, output tabs and log; talks to worker.js over postMessage.
// All synthesis happens in the worker (Pyodide); this file never touches Python.
"use strict";

const $ = (id) => document.getElementById(id);

const DEFAULT_SRC = `def dot2(a, b, c, d):
    ab = a * b
    cd = c * d
    return ab + cd
`;

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
ed.setValue(DEFAULT_SRC, -1);

const out = ace.edit("out-editor");
out.session.setMode("ace/mode/verilog");
out.setOptions({ fontFamily: "inherit", fontSize: 12, showPrintMargin: false, readOnly: true });
out.setValue("// run Synthesize to populate", -1);

let files = []; // [{name, content}]
let active = 0;

function renderTabs() {
  const host = $("out-tabs");
  host.innerHTML = "";
  files.forEach((f, i) => {
    const b = document.createElement("button");
    b.textContent = f.name;
    if (i === active) b.classList.add("active");
    b.onclick = () => {
      active = i;
      out.setValue(files[i].content, -1);
      renderTabs();
    };
    host.appendChild(b);
  });
  $("download").disabled = files.length === 0;
}

// The entry picker is populated from the candidate functions the worker reports; "(auto)" lets the driver pick the
// last-defined function. Keep the current selection if it survives a re-parse.
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
      $("engine").textContent = m.versions;
      logMsg("engine ready · " + m.versions, "ok");
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
    files = [
      { name: r.module_name + ".v", content: r.verilog },
      { name: "holoso_support.v", content: r.support },
    ];
    active = 0;
    out.setValue(files[0].content, -1);
    renderTabs();
    const mt = r.metrics || {};
    logMsg(
      `synthesized ${r.target} → ${r.module_name}.v · ${mt.operator_instances} · ${mt.float_regs} float regs · ` +
        `${mt.steps} steps · II≈${mt.ii_estimate} · chain ${mt.max_chain_len}`,
      "ok"
    );
  } else {
    const err = r.error || {};
    const tail = (err.message || "").split("\n").filter(Boolean).pop() || "synthesis failed";
    logMsg(`${err.kind || "error"}: ${tail}`, "err");
    if (err.location) {
      const row = (err.location.lineno || 1) - 1;
      ed.session.setAnnotations([{ row, column: err.location.col || 0, text: err.message || tail, type: "error" }]);
      ed.gotoLine(row + 1, err.location.col || 0, true);
      ed.focus();
    }
  }
}

$("synth").onclick = () => {
  if (!ready) {
    logMsg("engine not ready yet", "err");
    return;
  }
  $("synth").disabled = true;
  $("download").disabled = true;
  files = [];
  active = 0;
  $("out-tabs").innerHTML = "";
  out.setValue("", -1);

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
  const blob = new Blob([f.content], { type: "text/plain" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = f.name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(a.href);
};

// Boot the engine immediately; the first load pulls Pyodide + numpy + sympy (tens of MB), so warn in the log.
$("synth").disabled = true;
$("engine").textContent = "starting engine…";
logMsg("booting Pyodide engine — first load downloads the runtime + numpy + sympy (tens of MB)…", "dim");
worker.postMessage({ type: "init" });
