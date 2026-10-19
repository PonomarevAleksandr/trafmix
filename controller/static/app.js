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

// ── kebab menu (hides secondary actions so cards aren't a wall of buttons) ──
let openMenu = null;
const closeMenu = () => { if (openMenu) { openMenu.remove(); openMenu = null; } };
document.addEventListener("click", closeMenu);
document.addEventListener("scroll", closeMenu, true);
function kebab(items) {
  const b = el("button", { className: "sm icon", textContent: "⋯", title: "Ещё" });
  b.onclick = (e) => {
    e.stopPropagation();
    const was = openMenu; closeMenu();
    if (was && was.dataset.for === String(b.__id ??= Math.random())) return;
    const m = el("div", { className: "menu" });
    m.dataset.for = String(b.__id);
    for (const it of items)
      m.append(el("button", { className: "menu-item" + (it.danger ? " danger" : ""), textContent: it.label,
        onclick: (ev) => { ev.stopPropagation(); closeMenu(); it.onclick(); } }));
    document.body.append(m);
    const r = b.getBoundingClientRect();
    m.style.top = (r.bottom + 6 + scrollY) + "px";
    m.style.left = (Math.min(r.right - 170, innerWidth - 182) + scrollX) + "px";
    openMenu = m;
  };
  return b;
}

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
    stat("Шумит сейчас", String(jobsOn), `${STATE.jobs.length} заданий всего`),
    stat("Трафик за сутки", fmtBytes(traffic), ts.reduce((s, t) => s + (t.noise_runs_24h || 0), 0) + " прогонов"),
    run
      ? stat("Идёт поток", el("div", { className: "big num" }, [el("span", { className: "pulse" }), "шум"]), "→ " + STATE.running.target, "live")
      : stat("Статус", STATE.settings.paused === "1" ? "пауза" : "покой", STATE.settings.paused === "1" ? "трафик остановлен" : "ждёт расписания"),
  );
}

// ── targets ──
function renderTargets() {
  const box = $("#targets"); box.innerHTML = "";
  if (!STATE.targets.length) {
    box.append(el("div", { className: "empty onboard" }, [
      el("b", { textContent: "Шаг 1 — добавь сервер" }),
      el("span", { textContent: "Это твой тестовый сервер (нода). Потом добавишь ему трафик, а панель будет следить, жив ли он." }),
      btn("+ сервер", "accent", () => targetDialog(null)),
    ]));
    return;
  }
  for (const t of STATE.targets) {
    const lp = t.last_probe;
    const badge = t.is_control ? el("span", { className: "badge ctl", textContent: "контроль" })
      : !t.enabled ? el("span", { className: "badge off", textContent: "выкл" })
      : lp ? el("span", { className: "badge " + (lp.ok ? "up" : "down"),
          textContent: lp.ok ? "в сети" + (lp.latency_ms != null ? " · " + Math.round(lp.latency_ms) + " мс" : "") : "не отвечает" })
      : el("span", { className: "badge off", textContent: "нет данных" });

    const probes = PROBES[t.id] || [];
    const tl = probes.length
      ? el("div", { className: "timeline", title: "Доступность за сутки" }, probes.map((p) =>
          el("i", { className: p.ok ? "up" : "down", title: new Date(p.at * 1000).toLocaleString() + (p.latency_ms != null ? ` · ${Math.round(p.latency_ms)} мс` : "") })))
      : el("div", { className: "tl-empty", textContent: t.probe_kind === "none" ? "проверка выключена" : "ждём первую проверку" });

    const active = STATE.running.job_id && STATE.running.target === t.name;
    const njobs = STATE.jobs.filter((j) => j.target_id === t.id).length;
    box.append(el("div", { className: "card" + (t.is_control ? " control" : "") + (active ? " active" : "") }, [
      el("div", { className: "top" }, [
        el("div", {}, [
          el("div", { className: "name" }, [t.name, active ? el("span", { className: "pulse" }) : ""]),
          el("div", { className: "host num", textContent: `${t.host}:${t.iperf_port}` })]),
        badge]),
      el("div", { className: "meta" }, [
        metric(t.uptime_24h == null ? "—" : t.uptime_24h + "%", "доступность 24ч"),
        metric(fmtBytes(t.noise_bytes_24h), `трафик · ${t.noise_runs_24h} прог.`),
        t.is_control ? "" : metric(String(njobs), "заданий"),
      ]),
      tl,
      el("div", { className: "foot" }, [
        t.is_control ? el("span", { className: "ctl-note", textContent: "без трафика — только проверка" })
          : btn("+ трафик", "sm accent", () => jobDialog(t.id)),
        kebab([
          { label: "Изменить сервер", onclick: () => targetDialog(t) },
          { label: "Удалить", danger: true, onclick: async () => { if (confirm(`Удалить «${t.name}»?`)) { await api("DELETE", `/api/targets/${t.id}`); refresh(); } } },
        ]),
      ]),
    ]));
  }
}
const metric = (big, lbl) => el("div", {}, [el("b", { className: "num", textContent: big }), el("div", { className: "lbl", textContent: lbl })]);

// ── jobs ──
function renderJobs() {
  const box = $("#jobs"); box.innerHTML = "";
  if (!STATE.jobs.length) {
    const msg = STATE.targets.some((t) => !t.is_control)
      ? "Шаг 2 — добавь трафик: нажми «+ трафик» на сервере выше."
      : "Сначала добавь сервер, потом ему можно добавить трафик.";
    box.append(el("div", { className: "empty", textContent: msg }));
    return;
  }
  const tgt = (id) => STATE.targets.find((t) => t.id === id);
  box.append(el("div", { className: "row head" }, [
    el("span", { className: "k", textContent: "куда · что" }), el("span", { className: "k", textContent: "тип · объём" }),
    el("span", { className: "k cell-3", textContent: "скорость" }), el("span", { className: "k cell-4", textContent: "как часто" }),
    el("span", { className: "k", textContent: "" })]));
  for (const j of STATE.jobs) {
    const t = tgt(j.target_id); if (!t) continue;
    const sw = el("label", { className: "switch", title: j.enabled ? "включено" : "выключено" }, [
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
        sw,
        btn("запустить", "sm", async () => { await api("POST", `/api/jobs/${j.id}/run`); setTimeout(refresh, 1500); }),
        kebab([
          { label: "Изменить", onclick: () => jobDialog(j.target_id, j) },
          { label: "Удалить", danger: true, onclick: async () => { await api("DELETE", `/api/jobs/${j.id}`); refresh(); } },
        ]),
      ]),
    ]));
  }
}

// ── runs ──
async function renderRuns() {
  const rows = await api("GET", "/api/runs?limit=40");
  const box = $("#runs"); box.innerHTML = "";
  if (!rows.length) { box.append(el("div", { className: "empty", textContent: "Ещё ничего не гонялось — трафик пойдёт по расписанию или по кнопке «запустить»." })); return; }
  for (const r of rows) {
    const quality = r.loss_pct != null
      ? `потери ${r.loss_pct}%` + (r.jitter_ms != null ? ` · jit ${r.jitter_ms} мс` : "") : "—";
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

// ── dialog (core fields + collapsible «Дополнительно») ──
function openDlg(title, fields, onSave) {
  const f = $("#dlg-form"); f.innerHTML = "";
  f.append(el("h3", { textContent: title }));
  const inputs = {};
  const mk = (fl) => {
    const id = "f_" + fl.k;
    let input;
    if (fl.type === "select") {
      input = el("select", { id });
      for (const o of fl.opts) input.append(el("option", { value: o[0], textContent: o[1], selected: String(fl.val) === String(o[0]) }));
    } else if (fl.type === "check") {
      input = Object.assign(el("input", { type: "checkbox", id }), { checked: !!fl.val, style: "width:auto" });
    } else {
      input = el("input", { id, type: fl.type || "text", value: fl.val ?? "", placeholder: fl.ph || "" });
      if (fl.type === "number") { input.min = fl.min ?? 0; if (fl.step) input.step = fl.step; }
    }
    inputs[fl.k] = input;
    return el("div", { className: "frow" + (fl.type === "check" ? " check-row" : "") },
      [el("label", { htmlFor: id, textContent: fl.label }), input, fl.help ? el("small", { className: "fhelp", textContent: fl.help }) : ""]);
  };
  for (const fl of fields.filter((x) => !x.adv)) f.append(mk(fl));
  const adv = fields.filter((x) => x.adv);
  if (adv.length) {
    const d = el("details", { className: "adv" }, [el("summary", { textContent: "Дополнительно" })]);
    for (const fl of adv) d.append(mk(fl));
    f.append(d);
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
    { k: "name", label: "Название", val: d.name, ph: "Германия 1" },
    { k: "host", label: "Адрес сервера (IP или домен)", val: d.host, ph: "203.0.113.10" },
    { k: "iperf_port", label: "Порт ноды (iperf3)", type: "number", val: d.iperf_port ?? 5201 },
    { k: "is_control", label: "Контрольный — без трафика, только проверка", type: "check", val: d.is_control },
    { k: "probe_kind", label: "Как проверять, жив ли сервер", type: "select", val: d.probe_kind ?? "tcp",
      opts: [["tcp", "TCP-коннект"], ["tls", "TLS-рукопожатие"], ["none", "не проверять"]] },
    { k: "probe_port", label: "Порт проверки", type: "number", val: d.probe_port ?? 443,
      help: "Порт сервиса, который важен (443 / порт VPN), не iperf.", adv: true },
    { k: "probe_min", label: "Проверять каждые, мин", type: "number", val: d.probe_min ?? 5, min: 1, adv: true },
    { k: "http_url", label: "URL файла для HTTP-трафика", val: d.http_url ?? "", ph: "http://IP:8745/file", adv: true,
      help: "Для заданий типа HTTP. Ставится нодой автоматически." },
    { k: "enabled", label: "Включён", type: "check", val: t ? d.enabled : 1, adv: true },
  ], (out) => api(t ? "PATCH" : "POST", t ? `/api/targets/${t.id}` : "/api/targets", out));
}

function jobDialog(targetId, j) {
  const d = j || {};
  openDlg(j ? "Трафик" : "Новый трафик", [
    { k: "kind", label: "Тип трафика", type: "select", val: d.kind ?? "udp",
      opts: [["udp", "UDP-файл"], ["tcp", "TCP"], ["http", "HTTP-загрузка"], ["mix", "Микс — случайно каждый раз"]] },
    { k: "rate_kbit", label: "Скорость (лимит), кбит/с", type: "number", val: d.rate_kbit ?? 10000, min: 1, step: 1000,
      help: "10000 = 10 Мбит/с. Не больше общего лимита сверху." },
    { k: "bytes", label: "Сколько тянуть, байт", type: "number", val: d.bytes ?? 0, step: 1000000,
      help: "0 = тянуть по времени (ниже). Иначе объём, напр. 1000000000 = 1 ГБ." },
    { k: "interval_min", label: "Как часто, мин", type: "number", val: d.interval_min ?? 15, min: 1 },
    { k: "name", label: "Название", val: d.name ?? "поток", adv: true },
    { k: "duration_s", label: "Длительность, с (если объём = 0)", type: "number", val: d.duration_s ?? 10, min: 1, adv: true },
    { k: "pkt_len", label: "Размер UDP-пакета, байт", type: "number", val: d.pkt_len ?? 1200, min: 64, adv: true },
    { k: "jitter_pct", label: "Разброс интервала, %", type: "number", val: d.jitter_pct ?? 20, min: 0, adv: true,
      help: "Чтобы трафик шёл не строго по часам." },
    { k: "enabled", label: "Включено", type: "check", val: j ? d.enabled : 1, adv: true },
  ], (out) => { out.target_id = targetId; return api(j ? "PATCH" : "POST", j ? `/api/jobs/${j.id}` : "/api/jobs", out); });
}

// ── globals ──
$("#add-target").onclick = () => targetDialog(null);
$("#cap").onchange = (e) => api("PATCH", "/api/settings", { global_cap_kbit: Number(e.target.value) });
$("#pause").onclick = async () => { await api("PATCH", "/api/settings", { paused: STATE.settings.paused === "1" ? 0 : 1 }); refresh(); };

refresh();
setInterval(refresh, 4000);
