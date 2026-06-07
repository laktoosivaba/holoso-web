"""In-browser synthesis driver, run inside Pyodide.

Defines ``synth_to_json``: take the user's Python source as text, materialize it as a real module on the (in-memory)
filesystem so ``inspect.getsource`` works, locate the target (function or bound class method), run
``holoso.synthesize``, and return a JSON string the JS layer renders. Pure data in, JSON out -- no DOM, no globals
beyond a per-call module counter -- so it is exercised identically by ``worker.js`` (browser) and ``tools/`` (Node),
the single source of synth logic.

A unique module name per call (``holoso_user_<n>``) gives every run a distinct ``__file__`` -> linecache stays
correct across edits, and importlib never serves a stale cached module.

Stateful targets land here as ``ClassName`` or ``ClassName.method`` entries: the driver instantiates ``ClassName()``
no-args and passes the bound method to ``synthesize`` (its ``__self__`` snapshot seeds the reset state,
``__func__`` is the analyzed method). Demos that need a sibling file (e.g. ``iir1_hpf`` imports ``IIR1LPF``)
ride along as ``extras`` written to ``/user/`` before the main module is imported.

The demo kernels shown in the picker are static source files in this repo (``demos/``), listed by the worker --
they are not part of the holoso wheel, so this driver never imports them.
"""

from __future__ import annotations

import importlib
import inspect
import json
import pathlib
import sys
import traceback
import types

_USER_DIR = pathlib.Path("/user")
_counter = 0


_SKIP_NAMES = frozenset({"main"})  # CLI entry points in upstream examples; never a synth target.


def _module_targets(module: types.ModuleType) -> list[str]:
    """
    Synthesis candidates in the module, in definition order. Plain functions appear as ``"name"``; class methods
    appear as ``"ClassName.method"`` for each ``__call__`` or non-underscore method defined directly on the class.
    Classes with no synth-eligible method (pure dataclasses, helper types) are skipped. CLI entry-point names
    in ``_SKIP_NAMES`` (e.g. ``main``) are filtered: upstream examples ship a runnable ``main()`` next to the kernel,
    and the picker would otherwise default to it.
    """
    out: list[str] = []
    for name, obj in vars(module).items():
        if getattr(obj, "__module__", None) != module.__name__:
            continue
        if name in _SKIP_NAMES:
            continue
        if isinstance(obj, types.FunctionType):
            out.append(name)
        elif inspect.isclass(obj):
            for mname, mobj in vars(obj).items():
                if not isinstance(mobj, types.FunctionType):
                    continue
                if mname == "__call__" or not mname.startswith("_"):
                    out.append(f"{name}.{mname}")
    return out


def _resolve_target(module: types.ModuleType, target_name: str):
    """
    Return a callable suitable for ``synthesize``: a plain function for ``"name"`` entries, or a bound method
    for ``"ClassName.method"`` entries (constructed via no-args ``ClassName()``).
    """
    if "." in target_name:
        cls_name, method_name = target_name.split(".", 1)
        cls = getattr(module, cls_name)
        instance = cls()
        return getattr(instance, method_name)
    return getattr(module, target_name)


def _error(kind: str, message: str, **extra: object) -> str:
    return json.dumps({"ok": False, "error": {"kind": kind, "message": message}, **extra})


def _user_location(user_file: pathlib.Path) -> dict[str, object] | None:
    """Pull the last traceback frame inside the user's module file, so an import-time crash annotates the right line."""
    import linecache

    frames = traceback.extract_tb(sys.exc_info()[2])
    hits = [f for f in frames if f.filename == str(user_file)]
    if not hits:
        return None
    frame = hits[-1]
    line = frame.line or linecache.getline(str(user_file), frame.lineno or 0)
    return {"lineno": frame.lineno, "col": 0, "line": line.rstrip("\n")}


def _default_ops(wexp: int, wman: int):
    """Build the default per-operator configuration: every float operator at the requested ZKF format, no extra
    pipeline stages. holoso.synthesize requires an explicit OpConfig; the web always synthesizes the bare kernel."""
    from holoso import FAddOperator, FDivOperator, FMulILog2OperatorFamily, FMulOperator, FloatFormat, OpConfig

    fmt = FloatFormat(wexp=int(wexp), wman=int(wman))
    return OpConfig(
        fadd=FAddOperator(fmt),
        fmul=FMulOperator(fmt),
        fdiv=FDivOperator(fmt),
        fmul_ilog2=FMulILog2OperatorFamily(fmt),
    )


def synth_to_json(source: str, wexp: int, wman: int, entry: str = "", name: str = "", extras: str = "") -> str:
    """
    Synthesize ``source`` and return a JSON result envelope (see module docstring).

    ``extras`` is an optional JSON-encoded ``{filename: content}`` map of sibling files written to ``/user/``
    before the main module is imported -- used by cross-file demos like ``iir1_hpf`` (imports ``iir1_lpf``).
    Each extras filename must end in ``.py`` and is written verbatim, so the importable name is the filename stem.
    """
    from collections import Counter

    from holoso import HolosoError, synthesize

    global _counter
    _counter += 1
    mod_name = f"holoso_user_{_counter}"
    _USER_DIR.mkdir(exist_ok=True)

    if extras:
        try:
            extras_map = json.loads(extras)
            if not isinstance(extras_map, dict):
                raise TypeError("extras must be a JSON object")
        except Exception as exc:
            return _error("BadRequest", f"extras is not valid JSON: {exc}")
        for fname, content in extras_map.items():
            if not isinstance(fname, str) or not fname.endswith(".py") or "/" in fname or fname.startswith("."):
                return _error("BadRequest", f"invalid extras filename {fname!r}")
            if not isinstance(content, str):
                return _error("BadRequest", f"extras[{fname!r}] is not a string")
            (_USER_DIR / fname).write_text(content, encoding="utf-8")

    user_file = _USER_DIR / f"{mod_name}.py"
    user_file.write_text(source, encoding="utf-8")
    if str(_USER_DIR) not in sys.path:
        sys.path.insert(0, str(_USER_DIR))
    importlib.invalidate_caches()

    try:
        module = importlib.import_module(mod_name)
    except Exception:
        err: dict[str, object] = {"kind": "ImportError", "message": traceback.format_exc()}
        loc = _user_location(user_file)
        if loc is not None:
            err["location"] = loc
        return json.dumps({"ok": False, "error": err, "targets": []})

    candidates = _module_targets(module)
    target_name = entry.strip() or (candidates[-1] if candidates else "")
    if not target_name:
        return _error("NoTarget", "no top-level function or class found to synthesize", targets=candidates)
    if target_name not in candidates:
        return _error("BadEntry", f"entry {target_name!r} not found among {candidates}", targets=candidates)

    try:
        target = _resolve_target(module, target_name)
    except Exception:
        return json.dumps(
            {
                "ok": False,
                "error": {"kind": "ConstructError", "message": traceback.format_exc()},
                "targets": candidates,
                "target": target_name,
            }
        )

    try:
        result = synthesize(target, ops=_default_ops(wexp, wman), name=(name.strip() or None))
    except HolosoError as exc:
        err = {"kind": type(exc).__name__, "message": getattr(exc, "message", str(exc))}
        loc = getattr(exc, "location", None)
        if loc is not None:
            err["location"] = {"lineno": loc.lineno, "col": loc.col, "line": loc.line}
        return json.dumps({"ok": False, "error": err, "targets": candidates, "target": target_name})
    except Exception:
        return json.dumps(
            {"ok": False, "error": {"kind": "InternalError", "message": traceback.format_exc()}, "targets": candidates}
        )

    # Post-synthesis figures live on the numerical model's Lir (the only public handle that carries them); the
    # support RTL comes back as a name->text map alongside the generated module.
    lir = result.numerical_model.lir
    support = result.verilog_output.support_files
    counts = Counter(inst.operator.mnemonic for inst in lir.float_instances)
    instances = " ".join(f"{n}×{m}" for m, n in sorted(counts.items()))
    state_slot_names = [slot.name for slot in lir.float_state_slots]
    return json.dumps(
        {
            "ok": True,
            "targets": candidates,
            "target": target_name,
            "module_name": result.module_name,
            "verilog": result.verilog_output.verilog,
            "support": support.get("holoso_support.v", ""),
            "testbench": result.cocotb_output.testbench,
            "report_html": result.html_output.html,
            "metrics": {
                "operator_instances": instances or "-",
                "float_regs": lir.float_regfile.nreg,
                "steps": lir.makespan,
                "ii_cycles": lir.initiation_interval,
                "op_count": lir.op_count,
                "max_chain_len": lir.max_chain_len,
                "state_slots": len(state_slot_names),
                "state_slot_names": state_slot_names,
            },
        }
    )
