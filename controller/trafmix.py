#!/usr/bin/env python3
"""trafmix controller — a small panel + scheduler that sends varied, rate-capped
traffic to the test servers you own and tracks whether each stays reachable.

Dependency-free (Python 3.9+ stdlib only). Backends: iperf3 and curl.

    python3 trafmix.py            # serves the panel on http://0.0.0.0:8744

Scope: only point this at servers you operate. It is a load/measurement harness.
"""
import json
import os
import random
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse, parse_qs

import db
import runners

HERE = os.path.dirname(os.path.abspath(__file__))
STATIC = os.path.join(HERE, "static")
PORT = int(os.environ.get("TRAFMIX_PORT", "8744"))

# only one traffic stream runs at a time; combined with each job's rate cap this keeps
# the total noise at or below the global cap without any token-bucket bookkeeping.
_traffic_lock = threading.Lock()
_running = {"job_id": None, "target": None, "since": 0}


# ── scheduler ────────────────────────────────────────────────────────────────

def _due_jobs(now: int) -> list:
    return db.query(
        """SELECT j.* FROM jobs j JOIN targets t ON t.id = j.target_id
           WHERE j.enabled = 1 AND t.enabled = 1 AND t.is_control = 0
             AND j.next_run <= ? ORDER BY j.next_run ASC""", (now,))


def _schedule_next(job: dict) -> None:
    jit = job["jitter_pct"] / 100.0
    factor = 1 + random.uniform(-jit, jit) if jit else 1
    delay = max(30, int(job["interval_min"] * 60 * factor))
    now = int(time.time())
    db.write("UPDATE jobs SET last_run = ?, next_run = ? WHERE id = ?", (now, now + delay, job["id"]))


def run_job(job: dict) -> dict:
    """Run one job's traffic now, cap it to the global cap, store the result."""
    cap = int(db.get_settings().get("global_cap_kbit", "40000"))
    rate = min(job["rate_kbit"], cap)
    target = db.one("SELECT * FROM targets WHERE id = ?", (job["target_id"],))
    if not target:
        return {"ok": False, "detail": "target gone"}
    kind = job["kind"]
    if kind == "mix":
        kind = random.choice(["udp", "tcp", "http"] if target["http_url"] else ["udp", "tcp"])

    with _traffic_lock:
        _running.update(job_id=job["id"], target=target["name"], since=int(time.time()))
        try:
            if kind == "http" and target["http_url"]:
                res = runners.http_pull(target["http_url"], rate, max(job["duration_s"], 5))
            elif kind in ("udp", "tcp"):
                res = runners.iperf(target["host"], target["iperf_port"], kind, rate,
                                    job["bytes"], job["duration_s"], job["pkt_len"])
            else:
                res = {"ok": False, "detail": f"no URL for http job on {target['name']}"}
        finally:
            _running.update(job_id=None, target=None, since=0)

    db.write(
        """INSERT INTO runs(job_id, target_id, kind, started_at, took_s, sent_bytes,
               throughput_kbit, loss_pct, jitter_ms, ok, detail)
           VALUES(?,?,?,?,?,?,?,?,?,?,?)""",
        (job["id"], target["id"], kind, int(time.time()), res.get("took_s", 0),
         res.get("sent_bytes", 0), res.get("throughput_kbit", 0), res.get("loss_pct"),
         res.get("jitter_ms"), 1 if res.get("ok") else 0, res.get("detail", "")))
    return res


def _probe_due(now: int) -> list:
    rows = db.query("SELECT * FROM targets WHERE enabled = 1 AND probe_kind != 'none'")
    out = []
    for t in rows:
        last = db.one("SELECT at FROM probes WHERE target_id = ? ORDER BY at DESC LIMIT 1", (t["id"],))
        if not last or now - last["at"] >= t["probe_min"] * 60:
            out.append(t)
    return out


def run_probe(t: dict) -> None:
    res = runners.probe(t["host"], t["probe_kind"], t["probe_port"])
    db.write("INSERT INTO probes(target_id, at, ok, latency_ms, detail) VALUES(?,?,?,?,?)",
             (t["id"], int(time.time()), 1 if res["ok"] else 0, res.get("latency_ms"), res.get("detail", "")))


def scheduler_loop() -> None:
    last_prune = 0
    while True:
        try:
            now = int(time.time())
            paused = db.get_settings().get("paused", "0") == "1"
            for t in _probe_due(now):
                run_probe(t)
            if not paused and _running["job_id"] is None:
                due = _due_jobs(now)
                if due:
                    job = due[0]
                    _schedule_next(job)          # reserve the slot before running
                    run_job(job)
            if now - last_prune > 3600:
                db.prune()
                last_prune = now
        except Exception as e:  # noqa: BLE001 - the loop must never die
            print("scheduler error:", e)
        time.sleep(5)


# ── view model ───────────────────────────────────────────────────────────────

def target_view(t: dict) -> dict:
    now = int(time.time())
    last = db.one("SELECT * FROM probes WHERE target_id = ? ORDER BY at DESC LIMIT 1", (t["id"],))
    day = db.query("SELECT ok FROM probes WHERE target_id = ? AND at > ?", (t["id"], now - 86400))
    up = round(100 * sum(r["ok"] for r in day) / len(day), 1) if day else None
    noise = db.one(
        """SELECT SUM(sent_bytes) b, COUNT(*) n FROM runs
           WHERE target_id = ? AND started_at > ?""", (t["id"], now - 86400))
    return {
        **t,
        "last_probe": last,
        "uptime_24h": up,
        "probes_24h": len(day),
        "noise_bytes_24h": (noise or {}).get("b") or 0,
        "noise_runs_24h": (noise or {}).get("n") or 0,
    }


def state() -> dict:
    jobs = db.query("SELECT * FROM jobs ORDER BY id")
    return {
        "settings": db.get_settings(),
        "targets": [target_view(t) for t in db.query("SELECT * FROM targets ORDER BY id")],
        "jobs": jobs,
        "running": _running,
        "have_iperf": runners.HAVE_IPERF,
        "have_curl": runners.HAVE_CURL,
        "now": int(time.time()),
    }


# ── http ─────────────────────────────────────────────────────────────────────

TARGET_FIELDS = ["name", "host", "iperf_port", "http_url", "probe_kind", "probe_port",
                 "probe_min", "is_control", "enabled"]
JOB_FIELDS = ["target_id", "name", "kind", "rate_kbit", "bytes", "duration_s", "pkt_len",
              "interval_min", "jitter_pct", "enabled"]


def _pick(body: dict, fields: list) -> dict:
    return {k: body[k] for k in fields if k in body}


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *a):  # quiet
        pass

    def _send(self, code: int, obj=None, ctype="application/json"):
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Cache-Control", "no-store")
        body = b"" if obj is None else (obj if isinstance(obj, bytes) else json.dumps(obj).encode())
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        if body:
            self.wfile.write(body)

    def _body(self) -> dict:
        n = int(self.headers.get("Content-Length", "0") or "0")
        if not n:
            return {}
        try:
            return json.loads(self.rfile.read(n) or b"{}")
        except json.JSONDecodeError:
            return {}

    def _static(self, path: str):
        fname = "index.html" if path in ("/", "") else path.lstrip("/")
        full = os.path.normpath(os.path.join(STATIC, fname))
        if not full.startswith(STATIC) or not os.path.isfile(full):
            return self._send(404, {"error": "not found"})
        ctype = {"html": "text/html", "js": "application/javascript", "css": "text/css"}.get(
            fname.rsplit(".", 1)[-1], "application/octet-stream")
        with open(full, "rb") as f:
            self._send(200, f.read(), ctype + "; charset=utf-8")

    def do_GET(self):
        u = urlparse(self.path)
        p = u.path
        if p == "/api/state":
            return self._send(200, state())
        if p == "/api/runs":
            q = parse_qs(u.query)
            lim = min(int(q.get("limit", ["100"])[0]), 500)
            rows = db.query(
                """SELECT r.*, t.name target_name FROM runs r JOIN targets t ON t.id = r.target_id
                   ORDER BY r.started_at DESC LIMIT ?""", (lim,))
            return self._send(200, rows)
        if p == "/api/probes":
            q = parse_qs(u.query)
            tid = int(q.get("target_id", ["0"])[0])
            since = int(time.time()) - int(q.get("hours", ["24"])[0]) * 3600
            rows = db.query("SELECT at, ok, latency_ms FROM probes WHERE target_id = ? AND at > ? ORDER BY at",
                            (tid, since))
            return self._send(200, rows)
        return self._static(p)

    def do_POST(self):
        p = urlparse(self.path).path
        b = self._body()
        if p == "/api/targets":
            f = _pick(b, TARGET_FIELDS)
            if not f.get("name") or not f.get("host"):
                return self._send(400, {"error": "name and host required"})
            cols = ["name", "host", "created_at"] + [k for k in f if k not in ("name", "host")]
            vals = [f["name"], f["host"], int(time.time())] + [f[k] for k in cols[3:]]
            tid = db.write(f"INSERT INTO targets({','.join(cols)}) VALUES({','.join('?' * len(cols))})", vals)
            return self._send(200, {"id": tid})
        if p == "/api/jobs":
            f = _pick(b, JOB_FIELDS)
            if not f.get("target_id") or not f.get("kind"):
                return self._send(400, {"error": "target_id and kind required"})
            f.setdefault("name", f["kind"])
            cols = list(f) + ["created_at", "next_run"]
            vals = [f[k] for k in f] + [int(time.time()), int(time.time())]
            jid = db.write(f"INSERT INTO jobs({','.join(cols)}) VALUES({','.join('?' * len(cols))})", vals)
            return self._send(200, {"id": jid})
        m = p.strip("/").split("/")  # api/jobs/<id>/run
        if len(m) == 4 and m[0] == "api" and m[1] == "jobs" and m[3] == "run":
            job = db.one("SELECT * FROM jobs WHERE id = ?", (int(m[2]),))
            if not job:
                return self._send(404, {"error": "no job"})
            threading.Thread(target=run_job, args=(job,), daemon=True).start()
            return self._send(200, {"started": True})
        return self._send(404, {"error": "not found"})

    def do_PATCH(self):
        parts = urlparse(self.path).path.strip("/").split("/")  # api/<kind>/<id> or api/settings
        b = self._body()
        if parts[:2] == ["api", "settings"]:
            for k, v in b.items():
                if k in ("global_cap_kbit", "paused", "retain_hours"):
                    db.set_setting(k, v)
            return self._send(200, {"ok": True})
        if len(parts) == 3 and parts[0] == "api" and parts[1] in ("targets", "jobs"):
            fields = TARGET_FIELDS if parts[1] == "targets" else JOB_FIELDS
            f = _pick(b, fields)
            if not f:
                return self._send(400, {"error": "nothing to update"})
            sets = ", ".join(f"{k} = ?" for k in f)
            db.write(f"UPDATE {parts[1]} SET {sets} WHERE id = ?", [*f.values(), int(parts[2])])
            return self._send(200, {"ok": True})
        return self._send(404, {"error": "not found"})

    def do_DELETE(self):
        parts = urlparse(self.path).path.strip("/").split("/")
        if len(parts) == 3 and parts[0] == "api" and parts[1] in ("targets", "jobs"):
            db.write(f"DELETE FROM {parts[1]} WHERE id = ?", (int(parts[2]),))
            return self._send(200, {"ok": True})
        return self._send(404, {"error": "not found"})


def main():
    db.init()
    threading.Thread(target=scheduler_loop, daemon=True).start()
    srv = ThreadingHTTPServer(("0.0.0.0", PORT), Handler)
    print(f"trafmix on http://0.0.0.0:{PORT}  (iperf3={runners.HAVE_IPERF} curl={runners.HAVE_CURL})")
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
