"""In-browser script runner, executed inside Pyodide.

Defines ``run_script``: take the user's Python source (and any sibling files), materialize them under ``/user/``,
exec the main file as ``__main__`` (the same way ``python <file>`` does on disk), capture stdout/stderr, and
return a JSON envelope listing every file the script created. Pure data in, JSON out -- no DOM, no globals --
so the worker (browser) and ``tools/`` (Node) hit the same code path.

Upstream demos already ship a ``main()`` that builds an ``OpConfig``, calls ``holoso.synthesize(...)``, and writes
the result to ``Path(__file__).resolve().parent / "build" / Path(__file__).stem``. The runner just needs to be
faithful to ``__main__`` semantics (``__name__ == "__main__"``, ``__file__`` set, cwd is the script dir) and
diff the filesystem before/after to surface the new files for the UI to render.
"""

from __future__ import annotations

import contextlib
import importlib
import io
import json
import linecache
import os
import pathlib
import sys
import traceback
import types

_USER_DIR = pathlib.Path("/user")
_TEXT_EXTS = frozenset({"v", "vh", "sv", "svh", "vhd", "vhdl", "html", "htm", "txt", "json", "py", "log", "csv", "md", "rpt"})


class _StreamRedirect(io.TextIOBase):
    """sys.stdout / sys.stderr replacement that fans every write into both a StringIO buffer (returned in
    the JSON envelope, unchanged from before) and an optional per-line JS callback (live UI streaming).

    The worker drops a JS function into module globals as ``_stream_line`` before each run; headless test
    contexts leave it unset and the class degrades to a plain buffer. Partial writes are accumulated and
    only emitted to the callback on ``\\n`` -- so ``print(x)`` (write str, write "\\n") fires exactly one
    line, and a logging record split across multiple writes still surfaces as one line."""

    def __init__(self, name: str, buf: io.StringIO, callback) -> None:
        self.name = name
        self.buf = buf
        self.callback = callback
        self._pending = ""

    def writable(self) -> bool:
        return True

    def isatty(self) -> bool:
        return False

    def write(self, s: str) -> int:
        if not isinstance(s, str):
            s = str(s)
        self.buf.write(s)
        if self.callback is None:
            return len(s)
        self._pending += s
        while "\n" in self._pending:
            line, self._pending = self._pending.split("\n", 1)
            try:
                self.callback(self.name, line)
            except Exception:
                # A callback fault must not crash synthesis; mute it and keep buffering for the envelope.
                self.callback = None
                break
        return len(s)

    def flush(self) -> None:
        if self.callback and self._pending:
            try:
                self.callback(self.name, self._pending)
            except Exception:
                pass
            self._pending = ""


def _validate_filename(name: str) -> str | None:
    """Return None if ``name`` is a safe leaf filename ending in .py; else a short reason."""
    if not isinstance(name, str) or not name:
        return "missing filename"
    if not name.endswith(".py"):
        return "filename must end in .py"
    if "/" in name or "\\" in name or name.startswith("."):
        return "filename must be a bare leaf (no path separator, no leading dot)"
    return None


def _error(kind: str, message: str, **extra: object) -> dict[str, object]:
    return {"kind": kind, "message": message, **extra}


def _user_location(user_file: pathlib.Path) -> dict[str, object] | None:
    """Return the deepest traceback frame inside the user's main file, for Ace annotation."""
    frames = traceback.extract_tb(sys.exc_info()[2])
    hits = [f for f in frames if f.filename == str(user_file)]
    if not hits:
        return None
    frame = hits[-1]
    line = frame.line or linecache.getline(str(user_file), frame.lineno or 0)
    return {"lineno": frame.lineno, "col": 0, "line": (line or "").rstrip("\n")}


def _format_holoso_error(exc, user_file: pathlib.Path) -> dict[str, object]:
    err: dict[str, object] = {"kind": type(exc).__name__, "message": getattr(exc, "message", str(exc))}
    loc = getattr(exc, "location", None)
    if loc is not None:
        err["location"] = {"lineno": loc.lineno, "col": loc.col, "line": loc.line}
    else:
        ul = _user_location(user_file)
        if ul is not None:
            err["location"] = ul
    err["traceback"] = traceback.format_exc()
    return err


def _format_exec_error(user_file: pathlib.Path) -> dict[str, object]:
    exc_type = sys.exc_info()[0]
    kind = exc_type.__name__ if exc_type else "RuntimeError"
    err: dict[str, object] = {"kind": kind, "message": traceback.format_exc()}
    loc = _user_location(user_file)
    if loc is not None:
        err["location"] = loc
    return err


def _purge_user_modules() -> None:
    """Drop any module whose ``__file__`` lives under /user/ so re-runs see edits, not cached bytecode."""
    user_prefix = str(_USER_DIR) + "/"
    for mod_name in list(sys.modules):
        mod = sys.modules.get(mod_name)
        mod_file = getattr(mod, "__file__", None) or ""
        if mod_file.startswith(user_prefix):
            del sys.modules[mod_name]
    linecache.clearcache()
    importlib.invalidate_caches()


def _snapshot(root: pathlib.Path, exclude: set[str]) -> dict[str, tuple[int, int]]:
    """Recursive (relpath -> (mtime_ns, size)) walk; relpath excluded set names use forward slashes from root."""
    out: dict[str, tuple[int, int]] = {}
    if not root.exists():
        return out
    for path in root.rglob("*"):
        if not path.is_file():
            continue
        rel = path.relative_to(root).as_posix()
        if rel in exclude:
            continue
        try:
            st = path.stat()
        except OSError:
            continue
        out[rel] = (st.st_mtime_ns, st.st_size)
    return out


def _read_artifact(path: pathlib.Path) -> dict[str, object]:
    """Return ``{path, ext, content}`` for an emitted file. Binary files come back base64-encoded with encoding='base64'."""
    rel = path.relative_to(_USER_DIR).as_posix()
    ext = path.suffix.lower().lstrip(".")
    raw = path.read_bytes()
    if ext in _TEXT_EXTS:
        try:
            return {"path": rel, "ext": ext, "content": raw.decode("utf-8")}
        except UnicodeDecodeError:
            pass
    import base64
    return {"path": rel, "ext": ext, "content": base64.b64encode(raw).decode("ascii"), "encoding": "base64"}


def _collect_new(before: dict[str, tuple[int, int]], after: dict[str, tuple[int, int]]) -> list[dict[str, object]]:
    artifacts: list[dict[str, object]] = []
    for rel, stamp in sorted(after.items()):
        if before.get(rel) == stamp:
            continue
        path = _USER_DIR / rel
        try:
            artifacts.append(_read_artifact(path))
        except OSError as exc:
            artifacts.append({"path": rel, "ext": path.suffix.lower().lstrip("."), "error": str(exc)})
    return artifacts


def run_script(filename: str, source: str, extras: str = "") -> str:
    """
    Run ``source`` as if it were ``python /user/<filename>``, with sibling files from ``extras`` (JSON
    ``{filename: content}``) materialized alongside. Returns a JSON envelope::

        {"ok": true,  "stdout": "...", "stderr": "...", "files": [{path, ext, content}, ...]}
        {"ok": false, "error": {kind, message, location?}, "stdout": "...", "stderr": "...", "files": [...]}

    ``files`` lists every file under ``/user/`` whose mtime/size changed during the run, excluding the
    main script and any sibling extras we placed ourselves. Paths are relative to ``/user/``.
    """
    if (reason := _validate_filename(filename)) is not None:
        return json.dumps({"ok": False, "error": _error("BadRequest", reason), "stdout": "", "stderr": "", "files": []})

    extras_map: dict[str, str] = {}
    if extras:
        try:
            parsed = json.loads(extras)
            if not isinstance(parsed, dict):
                raise TypeError("extras must be a JSON object")
        except Exception as exc:
            return json.dumps({"ok": False, "error": _error("BadRequest", f"extras is not valid JSON: {exc}"), "stdout": "", "stderr": "", "files": []})
        for fname, content in parsed.items():
            if (reason := _validate_filename(fname)) is not None:
                return json.dumps({"ok": False, "error": _error("BadRequest", f"extras[{fname!r}]: {reason}"), "stdout": "", "stderr": "", "files": []})
            if not isinstance(content, str):
                return json.dumps({"ok": False, "error": _error("BadRequest", f"extras[{fname!r}] is not a string"), "stdout": "", "stderr": "", "files": []})
            extras_map[fname] = content

    _USER_DIR.mkdir(exist_ok=True)
    user_file = _USER_DIR / filename
    user_file.write_text(source, encoding="utf-8")
    for fname, content in extras_map.items():
        (_USER_DIR / fname).write_text(content, encoding="utf-8")

    if str(_USER_DIR) not in sys.path:
        sys.path.insert(0, str(_USER_DIR))
    _purge_user_modules()

    own_inputs = {filename, *extras_map.keys()}
    before = _snapshot(_USER_DIR, own_inputs)

    module = types.ModuleType("__main__")
    module.__file__ = str(user_file)
    module.__name__ = "__main__"
    module.__package__ = None
    # Replace sys.modules['__main__'] for the duration of the run so user code's "if __name__ == '__main__'"
    # works and so dataclasses introspection (which looks up the defining module via sys.modules) sees ours.
    previous_main = sys.modules.get("__main__")
    sys.modules["__main__"] = module

    stdout_buf = io.StringIO()
    stderr_buf = io.StringIO()
    callback = globals().get("_stream_line")
    stdout_stream = _StreamRedirect("stdout", stdout_buf, callback)
    stderr_stream = _StreamRedirect("stderr", stderr_buf, callback)
    error: dict[str, object] | None = None
    prev_cwd = os.getcwd()
    try:
        os.chdir(str(_USER_DIR))
        with contextlib.redirect_stdout(stdout_stream), contextlib.redirect_stderr(stderr_stream):
            try:
                from holoso import HolosoError
            except Exception:
                HolosoError = ()  # holoso missing -> only generic exceptions caught below
            try:
                code = compile(user_file.read_text(encoding="utf-8"), str(user_file), "exec")
                exec(code, module.__dict__)
            except SystemExit as exc:
                if exc.code not in (None, 0, "0"):
                    error = _format_exec_error(user_file)
            except HolosoError as exc:  # type: ignore[misc]
                error = _format_holoso_error(exc, user_file)
            except BaseException:
                error = _format_exec_error(user_file)
    finally:
        # Flush trailing partial lines (no terminating newline) so the live UI sees them too. The envelope
        # captures the raw text via StringIO regardless, so this only matters for the streaming path.
        stdout_stream.flush()
        stderr_stream.flush()
        os.chdir(prev_cwd)
        if previous_main is not None:
            sys.modules["__main__"] = previous_main
        else:
            sys.modules.pop("__main__", None)

    after = _snapshot(_USER_DIR, own_inputs)
    files = _collect_new(before, after)

    envelope: dict[str, object] = {
        "ok": error is None,
        "stdout": stdout_buf.getvalue(),
        "stderr": stderr_buf.getvalue(),
        "files": files,
    }
    if error is not None:
        envelope["error"] = error
    return json.dumps(envelope)
