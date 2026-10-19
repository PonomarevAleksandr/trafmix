"""SQLite storage for trafmix. One connection, a lock around writes, WAL mode.

Everything is tiny (a handful of targets, jobs and a rolling log), so one file and
no ORM keeps the controller dependency-free and light enough for a Raspberry Pi.
"""
import os
import sqlite3
import threading
import time

DB_PATH = os.environ.get("TRAFMIX_DB", os.path.join(os.path.dirname(__file__), "trafmix.db"))

_lock = threading.Lock()
_conn: sqlite3.Connection

SCHEMA = """
CREATE TABLE IF NOT EXISTS settings (
  k TEXT PRIMARY KEY,
  v TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS targets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  host TEXT NOT NULL,
  iperf_port INTEGER NOT NULL DEFAULT 5201,
  http_url TEXT,                       -- optional file URL for HTTP-shaped traffic
  probe_kind TEXT NOT NULL DEFAULT 'tcp', -- tcp | tls | none
  probe_port INTEGER NOT NULL DEFAULT 443,
  probe_min INTEGER NOT NULL DEFAULT 5,  -- reachability check every N minutes
  is_control INTEGER NOT NULL DEFAULT 0, -- a control server gets no noise, only probes
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS jobs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  target_id INTEGER NOT NULL REFERENCES targets(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  kind TEXT NOT NULL,                  -- udp | tcp | http | mix
  rate_kbit INTEGER NOT NULL DEFAULT 10000,  -- rate cap for this stream
  bytes INTEGER NOT NULL DEFAULT 0,    -- transfer size in bytes; 0 => use duration
  duration_s INTEGER NOT NULL DEFAULT 10,
  pkt_len INTEGER NOT NULL DEFAULT 1200, -- UDP payload size
  interval_min INTEGER NOT NULL DEFAULT 15,
  jitter_pct INTEGER NOT NULL DEFAULT 20, -- randomise the interval ±this %
  enabled INTEGER NOT NULL DEFAULT 1,
  last_run INTEGER NOT NULL DEFAULT 0,
  next_run INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id INTEGER,
  target_id INTEGER NOT NULL,
  kind TEXT NOT NULL,
  started_at INTEGER NOT NULL,
  took_s REAL NOT NULL DEFAULT 0,
  sent_bytes INTEGER NOT NULL DEFAULT 0,
  throughput_kbit REAL NOT NULL DEFAULT 0,
  loss_pct REAL,
  jitter_ms REAL,
  ok INTEGER NOT NULL DEFAULT 0,
  detail TEXT
);
CREATE TABLE IF NOT EXISTS probes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  target_id INTEGER NOT NULL REFERENCES targets(id) ON DELETE CASCADE,
  at INTEGER NOT NULL,
  ok INTEGER NOT NULL,
  latency_ms REAL,
  detail TEXT
);
CREATE INDEX IF NOT EXISTS runs_target_at ON runs(target_id, started_at);
CREATE INDEX IF NOT EXISTS probes_target_at ON probes(target_id, at);
"""

DEFAULT_SETTINGS = {
    "global_cap_kbit": "40000",  # total noise never exceeds this (home uplink guard)
    "paused": "0",
    "retain_hours": "168",       # keep a week of runs/probes
}


def init() -> None:
    global _conn
    _conn = sqlite3.connect(DB_PATH, check_same_thread=False)
    _conn.row_factory = sqlite3.Row
    _conn.execute("PRAGMA journal_mode=WAL")
    _conn.execute("PRAGMA foreign_keys=ON")
    with _lock:
        _conn.executescript(SCHEMA)
        for k, v in DEFAULT_SETTINGS.items():
            _conn.execute("INSERT OR IGNORE INTO settings(k, v) VALUES(?, ?)", (k, v))
        _conn.commit()


def query(sql: str, args=()) -> list:
    with _lock:
        return [dict(r) for r in _conn.execute(sql, args).fetchall()]


def one(sql: str, args=()):
    rows = query(sql, args)
    return rows[0] if rows else None


def write(sql: str, args=()) -> int:
    with _lock:
        cur = _conn.execute(sql, args)
        _conn.commit()
        return cur.lastrowid


def get_settings() -> dict:
    rows = query("SELECT k, v FROM settings")
    return {r["k"]: r["v"] for r in rows}


def set_setting(k: str, v: str) -> None:
    write("INSERT INTO settings(k, v) VALUES(?, ?) ON CONFLICT(k) DO UPDATE SET v=excluded.v", (k, str(v)))


def prune() -> None:
    cutoff = int(time.time()) - int(get_settings().get("retain_hours", "168")) * 3600
    write("DELETE FROM runs WHERE started_at < ?", (cutoff,))
    write("DELETE FROM probes WHERE at < ?", (cutoff,))
