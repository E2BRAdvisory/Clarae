#!/usr/bin/env python3
"""Availability report of a chaos run.

Usage: report.py DIR   (DIR holds samples.jsonl and events.tsv written by run-helm-chaos.sh)

events.tsv: "<unix_ms>\t<phase>\t<start|end>\t<note>". A sample belongs to the
phase whose start/end bracket its timestamp. Writes DIR/report.json and
DIR/report.md and prints the Markdown.
"""
import collections
import json
import os
import sys

TARGET = 99.9


def load(path):
    out = []
    with open(path) as f:
        for line in f:
            line = line.strip()
            if line:
                out.append(json.loads(line))
    return out


def stats(samples):
    n = len(samples)
    ok = sum(1 for s in samples if s["ok"])
    lat = sorted(s["ms"] for s in samples if s["ok"])
    p = lambda q: round(lat[min(len(lat) - 1, int(len(lat) * q))], 1) if lat else None
    errs = collections.Counter((s["status"] or s.get("err", "?")) for s in samples if not s["ok"])
    # longest run of consecutive failures, in seconds
    longest, cur_start, last = 0.0, None, None
    for s in sorted(samples, key=lambda x: x["ts_ms"]):
        if not s["ok"]:
            cur_start = cur_start if cur_start is not None else s["ts_ms"]
            last = s["ts_ms"]
            longest = max(longest, (last - cur_start) / 1000)
        else:
            cur_start = None
    return {
        "samples": n,
        "failed": n - ok,
        "availability_pct": round(100.0 * ok / n, 4) if n else None,
        "p50_ms": p(0.5),
        "p99_ms": p(0.99),
        "longest_failure_run_s": round(longest, 2),
        "errors": {str(k): v for k, v in errs.most_common(6)},
    }


def main():
    d = sys.argv[1]
    samples = load(os.path.join(d, "samples.jsonl"))
    events = []
    with open(os.path.join(d, "events.tsv")) as f:
        for line in f:
            parts = line.rstrip("\n").split("\t")
            if len(parts) >= 3:
                events.append((int(parts[0]), parts[1], parts[2], parts[3] if len(parts) > 3 else ""))
    phases = collections.OrderedDict()
    for ts, name, kind, note in events:
        if kind == "start":
            phases[name] = {"start": ts, "end": None, "note": note}
        elif kind == "end" and name in phases:
            phases[name]["end"] = ts
    result = {"target_pct": TARGET, "phases": {}, "kinds": {}}
    for kind in ("me", "readyz"):
        ks = [s for s in samples if s["kind"] == kind]
        if not ks:
            continue
        per = collections.OrderedDict()
        for name, ph in phases.items():
            sel = [s for s in ks if ph["start"] <= s["ts_ms"] <= (ph["end"] or ph["start"])]
            per[name] = dict(stats(sel), note=ph["note"], duration_s=round(((ph["end"] or ph["start"]) - ph["start"]) / 1000, 1))
        # Everything but the database outage: what API-pod disruptions cost.
        no_db = [s for s in ks if not any(
            n.startswith("postgres") and p["start"] <= s["ts_ms"] <= (p["end"] or p["start"]) for n, p in phases.items())]
        result["kinds"][kind] = {"overall": stats(ks), "excluding_postgres_outage": stats(no_db), "per_phase": per}
    json.dump(result, open(os.path.join(d, "report.json"), "w"), indent=2)

    md = ["# Chaos run: availability on the Helm chart", ""]
    meta_path = os.path.join(d, "meta.json")
    if os.path.exists(meta_path):
        meta = json.load(open(meta_path))
        md += ["| Parameter | Value |", "|---|---|"] + [f"| {k} | {v} |" for k, v in meta.items()] + [""]
    for kind, label in (("me", "Authenticated `GET /me` (the SLI)"), ("readyz", "`GET /readyz` (through the Service)")):
        if kind not in result["kinds"]:
            continue
        r = result["kinds"][kind]
        md += [f"## {label}", "",
               f"- overall: **{r['overall']['availability_pct']} %** ({r['overall']['failed']} failed of {r['overall']['samples']})",
               f"- excluding the PostgreSQL outage window: **{r['excluding_postgres_outage']['availability_pct']} %** "
               f"({r['excluding_postgres_outage']['failed']} failed of {r['excluding_postgres_outage']['samples']}), target {TARGET} %",
               "", "| Phase | s | samples | failed | availability % | longest failure run s | p99 ms | errors |", "|---|---|---|---|---|---|---|---|"]
        for name, s in r["per_phase"].items():
            md.append(f"| {name} | {s['duration_s']} | {s['samples']} | {s['failed']} | {s['availability_pct']} | {s['longest_failure_run_s']} | {s['p99_ms']} | {s['errors']} |")
        md.append("")
    text = "\n".join(md)
    open(os.path.join(d, "report.md"), "w").write(text)
    print(text)


main()
