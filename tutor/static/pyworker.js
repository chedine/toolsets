// Runs learner code + AI-written tests with Pyodide, off the main thread.
// The page kills and recreates this worker when a run takes too long (infinite loops).
importScripts("https://cdn.jsdelivr.net/pyodide/v0.26.2/full/pyodide.js");

const HARNESS = `
import sys, io, json, traceback

def __tutor_run(code, tests):
    out = io.StringIO()
    old = sys.stdout, sys.stderr
    sys.stdout = sys.stderr = out
    results, error = [], None
    try:
        ns = {"__name__": "__main__"}
        try:
            exec(compile(code, "your_code.py", "exec"), ns)
        except BaseException:
            error = traceback.format_exc(limit=-2)
        if error is None:
            tns = dict(ns)
            try:
                exec(compile(tests, "tests.py", "exec"), tns)
            except BaseException:
                error = "The tests could not load:\\n" + traceback.format_exc(limit=-2)
            if error is None:
                for name, fn in list(tns.items()):
                    if name.startswith("test_") and callable(fn) and name not in ns:
                        try:
                            fn()
                            results.append({"name": name, "ok": True})
                        except AssertionError as e:
                            results.append({"name": name, "ok": False, "msg": str(e) or "assertion failed"})
                        except BaseException as e:
                            results.append({"name": name, "ok": False, "msg": f"{type(e).__name__}: {e}"})
    finally:
        sys.stdout, sys.stderr = old
    return json.dumps({"results": results, "stdout": out.getvalue(), "error": error})
`;

const ready = (async () => {
  const py = await loadPyodide();
  py.runPython(HARNESS);
  return py;
})();

self.onmessage = async (e) => {
  const { id, code, tests } = e.data;
  try {
    const py = await ready;
    self.postMessage({ id, status: "loading" });
    await py.loadPackagesFromImports(code + "\n" + tests);
    self.postMessage({ id, status: "running" });
    py.globals.set("__code", code);
    py.globals.set("__tests", tests);
    const res = JSON.parse(py.runPython("__tutor_run(__code, __tests)"));
    self.postMessage({ id, status: "done", ...res });
  } catch (err) {
    self.postMessage({ id, status: "done", results: [], stdout: "", error: String(err && err.message || err) });
  }
};
