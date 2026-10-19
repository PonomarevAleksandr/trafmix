"use strict";
const $ = (s, r = document) => r.querySelector(s);
const el = (t, props = {}, kids = []) => {
  const n = Object.assign(document.createElement(t), props);
  for (const k of [].concat(kids)) if (k != null && k !== "") n.append(k);
  return n;
};
const api = async (m, p, body) => {
  const r = await fetch(p, { method: m, headers: body ? { "Content-Type": "application/json" } : {},
    body: body ? JSON.stringify(body) : undefined });
  if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || r.status);
  return r.json();
};
const fmtBytes = (b) => {
  if (!b) return "0";
  const u = ["Б", "КБ", "МБ", "ГБ", "ТБ"]; let i = 0;
  while (b >= 1024 && i < u.length - 1) { b /= 1024; i++; }
  return b.toFixed(b < 10 && i ? 1 : 0) + " " + u[i];
};
const fmtRate = (k) => k >= 1000 ? (k / 1000).toFixed(k < 10000 ? 1 : 0) + " Мбит" : Math.round(k) + " кбит";
const ago = (s) => { const d = Math.floor(Date.now() / 1000) - s; if (d < 60) return d + "с";
  if (d < 3600) return Math.floor(d / 60) + "м"; if (d < 86400) return Math.floor(d / 3600) + "ч";
  return Math.floor(d / 86400) + "д"; };
const chip = (kind) => el("span", { className: "chip " + kind, textContent: kind });
const btn = (txt, cls, onclick) => el("button", { className: cls, textContent: txt, onclick });

let STATE = null, PROBES = {};

async function refresh() {
  STATE = await api("GET", "/api/state");
  $("#cap").value = STATE.settings.global_cap_kbit;
  const paused = STATE.settings.paused === "1";
  $("#pause").textContent = paused ? "▶ продолжить" : "⏸ пауза";
  $("#pause").classList.toggle("accent", paused);
  $("#deps").textContent = [!STATE.have_iperf && "⚠ нет iperf3", !STATE.have_curl && "⚠ нет curl"].filter(Boolean).join("  ");
  for (const t of STATE.targets)
    PROBES[t.id] = (await api("GET", `/api/probes?target_id=${t.id}&hours=24`)).slice(-72);
  renderStats(); renderTargets(); renderJobs(); renderRuns();
}

// ── stat bar ──
function renderStats() {
  const ts = STATE.targets, probed = ts.filter((t) => t.last_probe && !t.is_control);
  const upNow = probed.filter((t) => t.last_probe.ok).length;
  const jobsOn = STATE.jobs.filter((j) => j.enabled).length;
  const traffic = ts.reduce((s, t) => s + (t.noise_bytes_24h || 0), 0);
  const run = STATE.running.job_id;
  const box = $("#stats"); box.innerHTML = "";
  const stat = (lbl, big, sub, cls) => el("div", { className: "stat " + (cls || "") }, [
    el("div", { className: "lbl", textContent: lbl }),
    typeof big === "string" ? el("div", { className: "big num", textContent: big }) : big,
    sub ? el("div", { className: "sub", textContent: sub }) : "",
  ]);
  box.append(
    stat("Сервера в сети", `${upNow}/${probed.length}`, `${ts.filter((t) => t.is_control).length} контрольных`),
    stat("Заданий активно", String(jobsOn), `${STATE.jobs.length} всего`),
    stat("Трафик 24ч", fmtBytes(traffic), ts.reduce((s, t) => s + (t.noise_runs_24h || 0), 0) + " прогонов"),
    run
      ? stat("Сейчас", el("div", { className: "big num" }, [el("span", { className: "pulse" }), "поток"]), "→ " + STATE.running.target, "live")
      : stat("Статус", STATE.settings.paused === "1" ? "пауза" : "покой", STATE.settings.paused === "1" ? "трафик остановлен" : "ждёт расписания"),
  );
}

// ── targets ──
function renderTargets() {
  const box = $("#targets"); box.innerHTML = "";
  for (const t of STATE.targets) {
    const lp = t.last_probe;
    const badge = t.is_control ? el("span", { className: "badge ctl", textContent: "контроль" })
      : !t.enabled ? el("span", { className: "badge off", textContent: "выкл" })
      : lp ? el("span", { className: "badge " + (lp.ok ? "up" : "down"),
          textContent: lp.ok ? "в сети" + (lp.latency_ms != null ? " · " + Math.round(lp.latency_ms) + " мс" : "") : "не отвечает" })
      : el("span", { className: "badge off", textContent: "нет данных" });

    const probes = PROBES[t.id] || [];
    const tl = probes.length
      ? el("div", { className: "timeline" }, probes.map((p) =>
          el("i", { className: p.ok ? "up" : "down", title: new Date(p.at * 1000).toLocaleString() + (p.latency_ms != null ? ` · ${Math.round(p.latency_ms)} мс` : "") })))
      : el("div", { className: "tl-empty", textContent: t.probe_kind === "none" ? "проверка выключена" : "ждём первую проверку" });

    const active = STATE.running.job_id && STATE.running.target === t.name;
    box.append(el("div", { className: "card" + (t.is_control ? " control" : "") + (active ? " active" : "") }, [
      el("div", { className: "top" }, [
        el("div", {}, [
          el("div", { className: "name" }, [t.name, active ? el("span", { className: "pulse" }) : ""]),
          el("div", { className: "host num", textContent: `${t.host}:${t.iperf_port}` })]),
        badge]),
      el("div", { className: "meta" }, [
        el("div", {}, [el("b", { className: "num", textContent: t.uptime_24h == null ? "—" : t.uptime_24h + "%" }),
          el("div", { className: "lbl", textContent: "доступность 24ч" })]),
        el("div", {}, [el("b", { className: "num", textContent: fmtBytes(t.noise_bytes_24h) }),
          el("div", { className: "lbl", textContent: `трафик 24ч · ${t.noise_runs_24h}` })]),
      ]),
      tl,
      el("div", { className: "foot" }, [
        t.is_control ? "" : btn("+ трафик", "sm accent", () => jobDialog(t.id)),
        btn("править", "sm", () => targetDialog(t)),
        btn("удалить", "sm danger", async () => { if (confirm(`Удалить «${t.name}»?`)) { await api("DELETE", `/api/targets/${t.id}`); refresh(); } }),
      ]),
    ]));
  }
  if (!STATE.targets.length) box.append(el("div", { className: "empty", textContent: "Пока нет серверов. Нажми «+ сервер»." }));
}

// ── jobs ──
function renderJobs() {
  const box = $("#jobs"); box.innerHTML = "";
  if (!STATE.jobs.length) { box.append(el("div", { className: "empty", textContent: "Заданий нет. Добавь трафик кнопкой «+ трафик» на сервере." })); return; }
  const tgt = (id) => STATE.targets.find((t) => t.id === id);
  box.append(el("div", { className: "row head" }, [
    el("span", { className: "k", textContent: "задание" }), el("span", { className: "k", textContent: "тип · объём" }),
    el("span", { className: "k cell-3", textContent: "скорость" }), el("span", { className: "k cell-4", textContent: "расписание" }),
    el("span", { className: "k", textContent: "" })]));
  for (const j of STATE.jobs) {
    const t = tgt(j.target_id); if (!t) continue;
    const sw = el("label", { className: "switch" }, [
      Object.assign(el("input", { type: "checkbox" }), { checked: !!j.enabled,
        onchange: (e) => api("PATCH", `/api/jobs/${j.id}`, { enabled: e.target.checked ? 1 : 0 }) }),
      el("span")]);
    const size = j.bytes ? fmtBytes(j.bytes) : j.duration_s + " с";
    box.append(el("div", { className: "row" }, [
      el("div", {}, [el("div", { className: "title", textContent: t.name }),
        el("div", { className: "sub", textContent: j.name })]),
      el("div", { className: "v" }, [chip(j.kind), " ", el("span", { className: "num", textContent: size })]),
      el("div", { className: "v cell-3 num", textContent: fmtRate(j.rate_kbit) }),
      el("div", { className: "v cell-4 num", textContent: `${j.interval_min} м · ±${j.jitter_pct}%` }),
      el("div", { className: "right" }, [
        sw, btn("прогнать", "sm", async () => { await api("POST", `/api/jobs/${j.id}/run`); setTimeout(refresh, 1500); }),
        btn("править", "sm", () => jobDialog(j.target_id, j)),
        btn("✕", "sm danger", async () => { await api("DELETE", `/api/jobs/${j.id}`); refresh(); })]),
    ]));
  }
}

// ── runs ──
async function renderRuns() {
  const rows = await api("GET", "/api/runs?limit=40");
  const box = $("#runs"); box.innerHTML = "";
  if (!rows.length) { box.append(el("div", { className: "empty", textContent: "Ещё ничего не гонялось." })); return; }
  for (const r of rows) {
    const quality = r.loss_pct != null || r.jitter_ms != null
      ? (r.loss_pct != null ? `потери ${r.loss_pct}%` : "") + (r.jitter_ms != null ? ` · jit ${r.jitter_ms} мс` : "")
      : "—";
    box.append(el("div", { className: "row" }, [
      el("div", {}, [el("div", { className: "title", textContent: r.target_name }),
        el("div", { className: "sub", textContent: ago(r.started_at) + " назад · " + (r.took_s || 0) + " с" })]),
      el("div", { className: "v" }, [chip(r.kind)]),
      el("div", { className: "v cell-3 num", textContent: fmtRate(r.throughput_kbit) + " · " + fmtBytes(r.sent_bytes) }),
      el("div", { className: "v cell-4 num", textContent: quality }),
      el("div", { className: r.ok ? "v run-ok" : "v run-bad", style: "text-align:right",
        textContent: r.ok ? "ok" : (r.detail || "сбой").slice(0, 40) }),
    ]));
  }
}

// ── dialogs ──
function openDlg(title, fields, onSave) {
  const f = $("#dlg-form"); f.innerHTML = "";
  f.append(el("h3", { textContent: title }));
  const inputs = {};
  for (const fl of fields) {
    const id = "f_" + fl.k;
    let input;
    if (fl.type === "select") {
      input = el("select", { id });
      for (const o of fl.opts) input.append(el("option", { value: o[0], textContent: o[1], selected: String(fl.val) === String(o[0]) }));
    } else if (fl.type === "check") {
      input = Object.assign(el("input", { type: "checkbox", id }), { checked: !!fl.val, style: "width:auto" });
    } else {
      input = el("input", { id, type: fl.type || "text", value: fl.val ?? "" });
      if (fl.type === "number") { input.min = fl.min ?? 0; if (fl.step) input.step = fl.step; }
    }
    inputs[fl.k] = input;
    const row = el("div", { className: "frow" + (fl.type === "check" ? " check-row" : "") },
      [el("label", { htmlFor: id, textContent: fl.label }), input]);
    f.append(row);
  }
  f.append(el("div", { className: "dlg-actions" }, [
    btn("отмена", "ghost", () => $("#dlg").close()),
    el("button", { className: "accent", textContent: "сохранить", onclick: async (e) => {
      e.preventDefault();
      const out = {};
      for (const fl of fields) {
        const i = inputs[fl.k];
        out[fl.k] = fl.type === "check" ? (i.checked ? 1 : 0) : fl.type === "number" ? Number(i.value) : i.value;
      }
      try { await onSave(out); $("#dlg").close(); refresh(); }
      catch (err) { alert("Не вышло: " + err.message); }
    }})]));
  $("#dlg").showModal();
}

function targetDialog(t) {
  const d = t || {};
  openDlg(t ? "Сервер" : "Новый сервер", [
    { k: "name", label: "Название", val: d.name },
    { k: "host", label: "Адрес (IP или домен)", val: d.host },
    { k: "iperf_port", label: "Порт ноды (iperf3)", type: "number", val: d.iperf_port ?? 5201 },
    { k: "http_url", label: "URL файла для HTTP-трафика (необязательно)", val: d.http_url ?? "" },
    { k: "probe_kind", label: "Проверка доступности", type: "select", val: d.probe_kind ?? "tcp",
      opts: [["tcp", "TCP-коннект"], ["tls", "TLS-рукопожатие"], ["none", "не проверять"]] },
    { k: "probe_port", label: "Порт проверки (сервис, а не iperf — напр. 443)", type: "number", val: d.probe_port ?? 443 },
    { k: "probe_min", label: "Проверять каждые (мин)", type: "number", val: d.probe_min ?? 5, min: 1 },
    { k: "is_control", label: "Контрольный (без трафика)", type: "check", val: d.is_control },
    { k: "enabled", label: "Включён", type: "check", val: t ? d.enabled : 1 },
  ], (out) => api(t ? "PATCH" : "POST", t ? `/api/targets/${t.id}` : "/api/targets", out));
}

function jobDialog(targetId, j) {
  const d = j || {};
  openDlg(j ? "Трафик" : "Новый трафик", [
    { k: "name", label: "Название", val: d.name ?? "поток" },
    { k: "kind", label: "Тип", type: "select", val: d.kind ?? "udp",
      opts: [["udp", "UDP-файл"], ["tcp", "TCP"], ["http", "HTTP-загрузка"], ["mix", "Микс (случайно)"]] },
    { k: "rate_kbit", label: "Скорость, кбит/с (лимит)", type: "number", val: d.rate_kbit ?? 10000, min: 1, step: 1000 },
    { k: "bytes", label: "Объём, байт (0 = по времени)", type: "number", val: d.bytes ?? 0, step: 1000000 },
    { k: "duration_s", label: "Длительность, с (если объём 0)", type: "number", val: d.duration_s ?? 10, min: 1 },
    { k: "pkt_len", label: "Размер UDP-пакета, байт", type: "number", val: d.pkt_len ?? 1200, min: 64 },
    { k: "interval_min", label: "Каждые, мин", type: "number", val: d.interval_min ?? 15, min: 1 },
    { k: "jitter_pct", label: "Разброс интервала, %", type: "number", val: d.jitter_pct ?? 20, min: 0 },
    { k: "enabled", label: "Включено", type: "check", val: j ? d.enabled : 1 },
  ], (out) => { out.target_id = targetId; return api(j ? "PATCH" : "POST", j ? `/api/jobs/${j.id}` : "/api/jobs", out); });
}

// ── globals ──
$("#add-target").onclick = () => targetDialog(null);
$("#cap").onchange = (e) => api("PATCH", "/api/settings", { global_cap_kbit: Number(e.target.value) });
$("#pause").onclick = async () => { await api("PATCH", "/api/settings", { paused: STATE.settings.paused === "1" ? 0 : 1 }); refresh(); };

refresh();
setInterval(refresh, 4000);
