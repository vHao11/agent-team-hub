"""Summarize a JSONL log without copying raw message bodies into the result."""
from __future__ import annotations

import argparse
from collections import Counter
import json
from pathlib import Path
import sys


def summarize(source: Path) -> dict:
    levels: Counter[str] = Counter()
    events: Counter[str] = Counter()
    invalid = 0
    total = 0
    for line in source.read_text(encoding="utf-8-sig").splitlines():
        if not line.strip():
            continue
        total += 1
        try:
            entry = json.loads(line)
            if not isinstance(entry, dict):
                raise ValueError("JSON object required")
        except (ValueError, TypeError):
            invalid += 1
            continue
        levels[str(entry.get("level", "unknown")).upper()] += 1
        events[str(entry.get("event", "unknown"))] += 1
    return {"schema_version": 1, "total_lines": total, "invalid_lines": invalid,
            "levels": dict(sorted(levels.items())), "events": dict(events.most_common(20)),
            "next_action": "检查错误级别与无效行，再对照联调预期核验。"}


def main() -> int:
    parser = argparse.ArgumentParser(description="Summarize UTF-8 JSONL integration logs.")
    parser.add_argument("--file", type=Path, required=True)
    args = parser.parse_args()
    try:
        print(json.dumps(summarize(args.file), ensure_ascii=False, indent=2))
    except (OSError, UnicodeError) as exc:
        print(json.dumps({"error": str(exc)}, ensure_ascii=False), file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
