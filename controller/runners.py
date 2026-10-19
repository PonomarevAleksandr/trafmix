"""Traffic generators and reachability probes, as plain functions.

The actual bytes are moved by iperf3 (UDP/TCP, rate-capped) and curl (HTTP download
shape). Keeping them as subprocesses means the heavy lifting is done by battle-tested
tools and the controller itself stays a thin scheduler — light enough for a Pi.

Every generator takes a rate cap in kbit/s, so nothing it starts can exceed what the
panel allows; that is how the home uplink and the VPN servers are kept unburdened.
"""
import json
import shutil
import socket
import ssl
import subprocess
import time

HAVE_IPERF = shutil.which("iperf3") is not None
HAVE_CURL = shutil.which("curl") is not None


def _run(cmd: list, timeout: float) -> tuple[int, str, str]:
    try:
        p = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)
        return p.returncode, p.stdout, p.stderr
    except subprocess.TimeoutExpired:
        return 124, "", "timed out"
    except FileNotFoundError as e:
        return 127, "", str(e)


def iperf(host: str, port: int, proto: str, rate_kbit: int, nbytes: int,
          duration_s: int, pkt_len: int) -> dict:
    """One iperf3 stream from the server down to us (--reverse = a download to the Pi).

    proto: 'udp' or 'tcp'. Rate is always capped. Either a byte count (nbytes>0) or a
    duration drives how much is moved. Returns throughput/loss/jitter parsed from JSON.
    """
    if not HAVE_IPERF:
        return {"ok": False, "detail": "iperf3 not installed (apt install iperf3)"}
    cmd = ["iperf3", "-c", host, "-p", str(port), "--json", "--reverse",
           "--connect-timeout", "4000", "-b", f"{rate_kbit}K"]
    if proto == "udp":
        cmd += ["-u", "-l", str(pkt_len)]
    if nbytes > 0:
        cmd += ["-n", str(nbytes)]
    else:
        cmd += ["-t", str(duration_s)]
    # give the transfer its own time plus slack before we call it hung
    budget = (duration_s if nbytes == 0 else max(duration_s, nbytes * 8 / max(rate_kbit, 1) / 1000)) + 15
    t0 = time.time()
    rc, out, err = _run(cmd, timeout=budget)
    took = round(time.time() - t0, 2)
    try:
        data = json.loads(out) if out.strip() else {}
    except json.JSONDecodeError:
        data = {}
    if data.get("error"):
        return {"ok": False, "took_s": took, "detail": data["error"]}
    end = data.get("end")
    if not end:
        return {"ok": False, "took_s": took, "detail": (err or out or "no result").strip()[:300]}
    recv = end.get("sum_received") or end.get("sum") or {}
    summ = end.get("sum") or {}
    return {
        "ok": True,
        "took_s": took,
        "sent_bytes": int(recv.get("bytes", 0)),
        "throughput_kbit": round(recv.get("bits_per_second", 0) / 1000, 1),
        "loss_pct": round(summ["lost_percent"], 2) if "lost_percent" in summ else None,
        "jitter_ms": round(summ["jitter_ms"], 2) if "jitter_ms" in summ else None,
        "detail": f"{proto} reverse, cap {rate_kbit}k",
    }


def http_pull(url: str, limit_kbit: int, max_time: int) -> dict:
    """Download a file over HTTP(S) with a rate limit — web-shaped traffic."""
    if not HAVE_CURL:
        return {"ok": False, "detail": "curl not installed"}
    limit_bytes = max(1, limit_kbit * 1000 // 8)
    cmd = ["curl", "-sS", "-o", "/dev/null", "--limit-rate", str(limit_bytes),
           "--max-time", str(max_time),
           "-w", "%{size_download} %{speed_download} %{http_code}", url]
    t0 = time.time()
    rc, out, err = _run(cmd, timeout=max_time + 10)
    took = round(time.time() - t0, 2)
    if rc != 0 and not out.strip():
        return {"ok": False, "took_s": took, "detail": (err or f"curl rc={rc}").strip()[:300]}
    try:
        size, speed, code = out.split()
        size, speed = int(float(size)), float(speed)
    except ValueError:
        return {"ok": False, "took_s": took, "detail": out.strip()[:300]}
    ok = size > 0 and (code.startswith("2") or code == "000" and size > 0)
    return {
        "ok": ok,
        "took_s": took,
        "sent_bytes": size,
        "throughput_kbit": round(speed * 8 / 1000, 1),
        "loss_pct": None, "jitter_ms": None,
        "detail": f"http {code}, cap {limit_kbit}k",
    }


def probe(host: str, kind: str, port: int, timeout: float = 5.0) -> dict:
    """Is the server still reachable? A tiny TCP connect or TLS handshake, timed.

    This carries no payload — it is the measurement side of the experiment: run it on
    every target (noise and control alike) and the timeline shows which stays up.
    """
    if kind == "none":
        return {"ok": True, "latency_ms": None, "detail": "skipped"}
    t0 = time.time()
    try:
        with socket.create_connection((host, port), timeout=timeout) as sock:
            if kind == "tls":
                ctx = ssl.create_default_context()
                ctx.check_hostname = False
                ctx.verify_mode = ssl.CERT_NONE
                with ctx.wrap_socket(sock, server_hostname=host) as ss:
                    ss.do_handshake()
        return {"ok": True, "latency_ms": round((time.time() - t0) * 1000, 1), "detail": kind}
    except Exception as e:  # noqa: BLE001 - any failure means "not reachable right now"
        return {"ok": False, "latency_ms": None, "detail": str(e)[:200]}
