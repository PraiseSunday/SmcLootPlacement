#!/usr/bin/env python3
"""Dump all pins to JSON (same format as seed/pins.json).

    python3 server/export_pins.py > pins-backup.json
    python3 server/export_pins.py seed/pins.json     # refresh the seed
Import: delete server/pins.db, put the file at seed/pins.json, start the server.
"""
import json, os, sqlite3, sys

db = sqlite3.connect(os.environ.get("DB_PATH", os.path.join(os.path.dirname(os.path.abspath(__file__)), "pins.db")))
db.row_factory = sqlite3.Row
rows = [dict(r) for r in db.execute("select id,x,y,z,tier,note,votes,created_at,kind from pins order by created_at")]
out = json.dumps(rows, indent=1)
open(sys.argv[1], "w").write(out + "\n") if len(sys.argv) > 1 else print(out)
print(f"{len(rows)} pins", file=sys.stderr)
