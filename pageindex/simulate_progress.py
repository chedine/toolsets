#!/usr/bin/env python3
"""Simulate indexer progress UI without touching real PDFs or outputs.

Use this to experiment with dashboard refresh, ANSI redraw, concurrent workers,
and serialized LLM slots without indexing documents.
"""
from __future__ import annotations

import argparse
import concurrent.futures
import copy
import random
import threading
import time
from pathlib import Path

import index_document as idx


def make_config(args: argparse.Namespace) -> dict:
    cfg = idx.load_config(Path(args.config).expanduser()) if args.config else {}
    cfg = copy.deepcopy(cfg)
    cfg.setdefault("progress", {})
    cfg["progress"]["enabled"] = True
    cfg["progress"]["verbose"] = True
    cfg["progress"]["style"] = "log" if args.mode == "log" else "inline"
    cfg["progress"]["force_inline"] = not args.no_ansi
    cfg["progress"]["colors"] = not args.no_color
    cfg.setdefault("llm", {})
    cfg["llm"]["max_parallel_requests"] = args.llm_slots
    return cfg


def simulate_file(path: Path, config: dict, args: argparse.Namespace, llm_sem: threading.BoundedSemaphore) -> None:
    jitter = random.Random(hash(path.name) & 0xFFFFFFFF)

    def pause(mult: float = 1.0) -> None:
        time.sleep(max(0.0, args.stage_seconds * mult + jitter.uniform(0, args.jitter)))

    idx.status(config, path, "starting fake indexing")
    pause(0.4)
    idx.status(config, path, "extracting fake PDF text")
    pause(0.7)
    pages = jitter.randint(20, 250)
    outline = jitter.randint(0, 200)
    idx.status(config, path, f"extracted {pages} fake pages; outline entries: {outline}")
    pause(0.5)
    idx.status(config, path, "building fake tree")
    pause(0.5)

    nodes = args.nodes + jitter.randint(0, args.node_jitter)
    for i in range(1, nodes + 1):
        idx.status(config, path, f"summarizing nodes {i}/{nodes}: fake section {i}")
        idx.status(config, path, f"waiting for LLM slot: fake node {i}")
        with llm_sem:
            idx.status(config, path, f"LLM request in progress: fake node {i}")
            pause(1.0)

    idx.status(config, path, "writing fake outputs")
    pause(0.3)
    idx.status(config, path, "updating fake master index")
    pause(0.2)

    if args.fail and path.name.endswith(str(args.fail)):
        raise RuntimeError("intentional simulated failure")


def main() -> int:
    parser = argparse.ArgumentParser(description="Simulate indexer progress UI without indexing real files")
    parser.add_argument("--config", default="config.yaml", help="Optional config.yaml to inherit defaults from")
    parser.add_argument("--files", type=int, default=5, help="Number of fake files")
    parser.add_argument("--workers", type=int, default=3, help="Concurrent fake file workers")
    parser.add_argument("--llm-slots", type=int, default=1, help="Concurrent fake LLM requests")
    parser.add_argument("--nodes", type=int, default=8, help="Base fake summary nodes per file")
    parser.add_argument("--node-jitter", type=int, default=4, help="Random extra nodes per file")
    parser.add_argument("--stage-seconds", type=float, default=0.6, help="Base seconds per fake stage")
    parser.add_argument("--jitter", type=float, default=0.2, help="Random seconds added to stages")
    parser.add_argument("--mode", choices=["dashboard", "log"], default="dashboard", help="Progress mode")
    parser.add_argument("--no-ansi", action="store_true", help="Disable in-place ANSI redraw")
    parser.add_argument("--no-color", action="store_true", help="Disable colored circles")
    parser.add_argument("--fail", type=int, default=0, help="Fail file ending with this number, e.g. 3")
    args = parser.parse_args()

    config = make_config(args)
    fake_files = [Path(f"fake_inbox/FakeDocument_{i:02d}.pdf") for i in range(1, args.files + 1)]
    workers = min(max(1, args.workers), len(fake_files))
    llm_sem = threading.BoundedSemaphore(max(1, args.llm_slots))

    print(f"Simulating {len(fake_files)} files; workers={workers}; llm_slots={args.llm_slots}; mode={args.mode}; ansi={not args.no_ansi}", flush=True)
    idx.PROGRESS = idx.ProgressReporter(config, fake_files)
    idx.PROGRESS.start()

    failures: list[tuple[Path, str]] = []
    try:
        with concurrent.futures.ThreadPoolExecutor(max_workers=workers) as executor:
            futures = {executor.submit(simulate_file, path, config, args, llm_sem): path for path in fake_files}
            for future in concurrent.futures.as_completed(futures):
                path = futures[future]
                try:
                    future.result()
                    idx.PROGRESS.done(path, "fake indexed; fake master updated")
                except Exception as exc:
                    failures.append((path, str(exc)))
                    idx.PROGRESS.failed(path, str(exc))
    except KeyboardInterrupt:
        print("\nInterrupted by user", flush=True)
        return 130
    finally:
        if idx.PROGRESS:
            idx.PROGRESS.stop()
        idx.PROGRESS = None

    if failures:
        print("Failures:", flush=True)
        for path, err in failures:
            print(f"- {path}: {err}", flush=True)
        return 1
    print("Simulation complete", flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
