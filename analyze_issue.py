#!/usr/bin/env python3
import json
import sys
from datetime import datetime, timezone

def main() -> int:
    title = sys.argv[1] if len(sys.argv) > 1 else ""
    body = sys.argv[2] if len(sys.argv) > 2 else ""

    text = f"{title}\n{body}".lower()

    if any(x in text for x in ("traceback", "typeerror", "referenceerror", "syntaxerror", "exception", "crash")):
        category = "bug"
        severity = "high"
    elif any(x in text for x in ("login", "auth", "token", "password", "permission")):
        category = "auth"
        severity = "medium"
    elif any(x in text for x in ("slow", "timeout", "latency", "performance")):
        category = "performance"
        severity = "medium"
    else:
        category = "triage"
        severity = "low"

    print(json.dumps({
        "ok": True,
        "category": category,
        "severity": severity,
        "title": title,
        "body_length": len(body),
        "ts": datetime.now(timezone.utc).isoformat()
    }, separators=(",", ":")))

    return 0

if __name__ == "__main__":
    raise SystemExit(main())
