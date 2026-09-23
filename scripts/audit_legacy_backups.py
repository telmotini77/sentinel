"""Read legacy backups with their WAL files; export a lossless JSON audit bundle.

Original files are never opened by SQLite: each database and its sidecars are
copied to a private temporary directory before a read-only connection is opened.
"""
import argparse
import hashlib
import json
import math
import shutil
import sqlite3
import tempfile
from collections import Counter
from pathlib import Path


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def canonical(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"), allow_nan=False)


def safe_value(value):
    if isinstance(value, bytes):
        return {"_sqlite_blob_hex": value.hex()}
    if isinstance(value, float) and not math.isfinite(value):
        return {"_sqlite_float": str(value)}
    return value


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("source", type=Path)
    parser.add_argument("output", type=Path)
    args = parser.parse_args()
    files = sorted(p for p in args.source.iterdir() if p.is_file())
    original_hashes = {p.name: digest(p) for p in files}
    bundle = {"format": 1, "files": [{"name": p.name, "bytes": p.stat().st_size,
              "sha256": original_hashes[p.name]} for p in files], "sources": []}
    for source in files:
        if source.suffix not in (".db", ".json"):
            continue
        entry = {"name": source.name, "test_data": ".test." in source.name, "tables": {}}
        if source.suffix == ".db":
            with tempfile.TemporaryDirectory(prefix="sentinel-sqlite-audit-") as directory:
                snapshot = Path(directory) / source.name
                shutil.copy2(source, snapshot)
                for suffix in ("-wal", "-shm"):
                    sidecar = Path(str(source) + suffix)
                    if sidecar.exists():
                        shutil.copy2(sidecar, Path(str(snapshot) + suffix))
                connection = sqlite3.connect(snapshot.as_uri() + "?mode=ro", uri=True)
                connection.row_factory = sqlite3.Row
                try:
                    entry["integrity"] = [r[0] for r in connection.execute("PRAGMA integrity_check")]
                    if entry["integrity"] != ["ok"]:
                        raise RuntimeError(f"Invalid database: {source.name}")
                    definitions = connection.execute("SELECT name,sql FROM sqlite_master WHERE type='table' ORDER BY name").fetchall()
                    entry["definitions"] = {r["name"]: r["sql"] for r in definitions}
                    for definition in definitions:
                        name = definition["name"]
                        quoted = '"' + name.replace('"', '""') + '"'
                        entry["tables"][name] = [{k: safe_value(r[k]) for k in r.keys()}
                            for r in connection.execute(f"SELECT * FROM {quoted}")]
                finally:
                    connection.close()
        else:
            data = json.loads(source.read_text(encoding="utf-8-sig"))
            if not isinstance(data, list):
                raise RuntimeError(f"Unexpected JSON structure in {source.name}")
            entry["tables"]["naps" if source.name == "nap_cache.json" else "status_history"] = data
            entry["integrity"] = ["valid_json"]
        entry["logical_sha256"] = hashlib.sha256(canonical(entry["tables"]).encode()).hexdigest()
        bundle["sources"].append(entry)
    if original_hashes != {p.name: digest(p) for p in files}:
        raise RuntimeError("A source changed during audit; discard this snapshot and retry")
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(canonical(bundle), encoding="utf-8")
    summary = []
    for source in bundle["sources"]:
        naps = source["tables"].get("naps", [])
        optical = source["tables"].get("optical_history", [])
        summary.append({"name": source["name"], "test_data": source["test_data"],
            "integrity": source["integrity"], "logical_sha256": source["logical_sha256"],
            "counts": {k: len(v) for k, v in source["tables"].items()},
            "columns": {k: list(v[0]) if v else [] for k, v in source["tables"].items()},
            "account_counts": dict(Counter(str(n.get("smartolt_account_id")) for n in naps)),
            "olt_counts": dict(Counter(str(n.get("olt_id")) for n in naps)),
            "optical_min": min((r.get("timestamp", "") for r in optical), default=None),
            "optical_max": max((r.get("timestamp", "") for r in optical), default=None),
            "meta_keys": [r.get("key") for r in source["tables"].get("app_meta", [])]})
    print(json.dumps(summary, indent=2, ensure_ascii=False))


if __name__ == "__main__":
    main()
