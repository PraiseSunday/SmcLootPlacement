#!/usr/bin/env python3
"""Local server: serves the site AND the pin API (SQLite). Stdlib only.

    python3 server/server.py                  # http://localhost:8934
    ADMIN_TOKEN=secret PORT=8080 RATE_LIMIT=30 python3 server/server.py

First run seeds the DB from seed/pins.json. The admin token (needed to delete
pins) defaults to "admin" -- CHANGE IT when hosting publicly.
API contract: see backends/rest.js.
"""
import json, os, re, sqlite3, time, uuid
from collections import defaultdict, deque
from datetime import datetime, timezone
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DB_PATH = os.environ.get("DB_PATH", os.path.join(ROOT, "server", "pins.db"))
TOKEN = os.environ.get("ADMIN_TOKEN", "admin")
PORT = int(os.environ.get("PORT", 8934))
KINDS = ("chest", "jumppad", "recharger")
RATE_LIMIT = int(os.environ.get("RATE_LIMIT", 30))  # writes per IP per minute (0 = off)
TRUST_PROXY = os.environ.get("TRUST_PROXY") == "1"  # read client IP from X-Forwarded-For
hits = defaultdict(deque)
COLS = "id,x,y,z,kind,tier,note,votes,created_at"

db = sqlite3.connect(DB_PATH, check_same_thread=False, isolation_level=None)
db.row_factory = sqlite3.Row
db.execute("""create table if not exists pins (
  id text primary key, x real not null, y real not null, z real not null,
  kind text not null default 'chest', tier integer not null default 1,
  note text not null default '', votes integer not null default 0,
  created_at text not null)""")
if not db.execute("select 1 from pins limit 1").fetchone():
    seed = os.path.join(ROOT, "seed", "pins.json")
    if os.path.exists(seed):
        for p in json.load(open(seed)):
            db.execute(f"insert into pins({COLS}) values(?,?,?,?,?,?,?,?,?)",
                       [p.get(c) if c != "kind" else p.get(c, "chest") for c in COLS.split(",")])
        print("seeded pins from seed/pins.json")


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *a, **k):
        super().__init__(*a, directory=ROOT, **k)

    def end_headers(self):  # filenames are grid indices: never serve stale data
        self.send_header("Cache-Control", "no-cache")
        super().end_headers()

    def send_json(self, obj, code=200):
        body = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _text(self, code, msg):
        body = msg.encode()
        self.send_response(code)
        self.send_header("Content-Type", "text/plain")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def is_admin(self):
        return self.headers.get("Authorization", "") == "Bearer " + TOKEN

    def body(self):
        n = int(self.headers.get("Content-Length") or 0)
        return json.loads(self.rfile.read(n) or b"{}")

    def pin(self, pid):
        r = db.execute(f"select {COLS} from pins where id=?", [pid]).fetchone()
        return dict(r) if r else None

    def rate_limited(self):
        ip = self.client_address[0]
        if TRUST_PROXY:
            ip = self.headers.get("X-Forwarded-For", ip).split(",")[0].strip()
        q, now = hits[ip], time.time()
        while q and now - q[0] > 60:
            q.popleft()
        if RATE_LIMIT and len(q) >= RATE_LIMIT:
            return True
        q.append(now)
        return False

    def api(self, method):
        if method != "GET" and not self.is_admin() and self.rate_limited():
            return self._text(429, "Too many requests, slow down")
        path = self.path.split("?")[0][len("/api"):]
        if path == "/admin" and method == "GET":
            if not self.is_admin():
                return self._text(401, "unauthorized")
            self.send_response(204)
            return self.end_headers()
        if path == "/pins" and method == "GET":
            return self.send_json([dict(r) for r in db.execute(f"select {COLS} from pins")])
        if path == "/pins" and method == "POST":
            try:
                b = self.body()
                x, y, z = (float(b[k]) for k in "xyz")
            except (KeyError, ValueError, TypeError):
                return self._text(400, "x, y, z required")
            kind = b.get("kind", "chest")
            if kind not in KINDS:
                return self._text(400, "bad kind")
            tier = min(3, max(1, int(b.get("tier") or 1)))
            pid = str(uuid.uuid4())
            db.execute(f"insert into pins({COLS}) values(?,?,?,?,?,?,?,0,?)",
                       [pid, x, y, z, kind, tier, str(b.get("note", ""))[:500],
                        datetime.now(timezone.utc).isoformat()])
            return self.send_json(self.pin(pid), 201)
        m = re.fullmatch(r"/pins/([\w-]+)(/vote)?", path)
        if m and m[2] and method == "POST":
            try:
                delta = int(self.body()["delta"])
            except (KeyError, ValueError, TypeError):
                return self._text(400, "delta required")
            if delta not in (-1, 1):
                return self._text(400, "delta must be +1 or -1")
            db.execute("update pins set votes=votes+? where id=?", [delta, m[1]])
            p = self.pin(m[1])
            if p and p["votes"] <= -10:  # auto-remove at 10 net downvotes
                db.execute("delete from pins where id=?", [m[1]])
            return self.send_json(p or {})
        if m and not m[2] and method == "DELETE":
            if not self.is_admin():
                return self._text(401, "admin token required")
            db.execute("delete from pins where id=?", [m[1]])
            self.send_response(204)
            return self.end_headers()
        self._text(404, "not found")

    def do_GET(self):
        self.api("GET") if self.path.startswith("/api/") else super().do_GET()

    def do_POST(self):
        self.api("POST") if self.path.startswith("/api/") else self._text(405, "no")

    def do_DELETE(self):
        self.api("DELETE") if self.path.startswith("/api/") else self._text(405, "no")

    def log_message(self, *a):
        pass


if __name__ == "__main__":
    if TOKEN == "admin":
        print("WARNING: default admin token. Set ADMIN_TOKEN before exposing this.")
    print(f"http://localhost:{PORT}")
    ThreadingHTTPServer(("", PORT), Handler).serve_forever()
