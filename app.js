/* ShiftPulse: local-first shift journal */
"use strict";
const APP_VERSION = "2.0";
const DB_NAME = "ShiftPulseDB", DB_VERSION = 1, STORE = "shifts";
const SETTINGS_KEY = "shiftpulse_settings", MIRROR_KEY = "shiftpulse_mirror";
const BACKUP_REMIND_DAYS = 7;

const state = {
  view: "home", editId: null, editDate: null, returnTo: "history",
  historyFilter: "month", statsMode: "month", statsOffset: 0,
  calDate: startOfMonth(new Date()), shifts: [], chart: null,
  settings: { goal: 176, weekStart: 1, rate: 0, currency: "", lastBackupAt: 0 },
  persisted: null, dbOk: true,
};

/* ---------- helpers ---------- */
const $ = s => document.querySelector(s);
const pad = n => String(n).padStart(2, "0");
const uid = () => (crypto.randomUUID ? crypto.randomUUID() : Date.now() + "-" + Math.random().toString(16).slice(2));
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const dateISO = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
// "YYYY-MM-DD" must be parsed as a local date: new Date("2026-10-01") is UTC and shifts the day in some time zones
const parseDate = iso => { const [y, m, d] = iso.split("-").map(Number); return new Date(y, m - 1, d); };
const parseLocal = (iso, time) => { const d = parseDate(iso); const [h, m] = time.split(":").map(Number); d.setHours(h, m, 0, 0); return d; };
const hmOf = d => pad(d.getHours()) + ":" + pad(d.getMinutes());
const addDays = (d, n) => { const x = new Date(d); x.setDate(x.getDate() + n); return x; };
function startOfMonth(d) { return new Date(d.getFullYear(), d.getMonth(), 1); }
function startOfWeek(d) { const x = new Date(d.getFullYear(), d.getMonth(), d.getDate()); x.setDate(x.getDate() - (x.getDay() - state.settings.weekStart + 7) % 7); return x; }
const fmt = (opts, d) => new Intl.DateTimeFormat("ru-RU", opts).format(d);
const monthYear = d => fmt({ month: "long", year: "numeric" }, d).replace(/\s?г\.?$/, "");
const hm = m => { m = Math.max(0, Math.round(m || 0)); const h = Math.floor(m / 60), r = m % 60; return r ? `${h}ч ${pad(r)}м` : `${h}ч`; };
const hShort = m => (m / 60).toFixed(m % 60 ? 1 : 0).replace(".", ",") + "ч";
const plural = (n, one, few, many) => { const a = n % 10, b = n % 100; return a === 1 && b !== 11 ? one : a >= 2 && a <= 4 && (b < 12 || b > 14) ? few : many; };
const shiftsWord = n => `${n} ${plural(n, "смена", "смены", "смен")}`;
const rate = () => Number(state.settings.rate) || 0;
const money = mins => rate() ? new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 0 }).format(mins / 60 * rate()) + (state.settings.currency ? " " + state.settings.currency : "") : "";
const completed = () => state.shifts.filter(s => s.status === "completed");
const activeShift = () => state.shifts.find(s => s.status === "active");
const byNewest = (a, b) => b.date.localeCompare(a.date) || b.startTime.localeCompare(a.startTime) || (b.createdAt - a.createdAt);
const sum = xs => xs.reduce((a, s) => a + (s.durationMinutes || 0), 0);
const vibrate = ms => { try { navigator.vibrate && navigator.vibrate(ms); } catch {} };

function durationFor(date, start, end, br) {
  const a = parseLocal(date, start), b = parseLocal(date, end);
  if (b <= a) b.setDate(b.getDate() + 1);
  return Math.max(0, Math.round((b - a) / 60000) - Math.max(0, Number(br) || 0));
}

function periodRange(mode, offset = 0) {
  const now = new Date();
  if (mode === "today") { const s = new Date(now.getFullYear(), now.getMonth(), now.getDate()); return [s, addDays(s, 1)]; }
  if (mode === "week") { const s = addDays(startOfWeek(now), offset * 7); return [s, addDays(s, 7)]; }
  if (mode === "year") { const y = now.getFullYear() + offset; return [new Date(y, 0, 1), new Date(y + 1, 0, 1)]; }
  if (mode === "all") return [new Date(0), new Date(8640000000000000)];
  const s = new Date(now.getFullYear(), now.getMonth() + offset, 1);
  return [s, new Date(s.getFullYear(), s.getMonth() + 1, 1)];
}
const inRange = (s, [a, b]) => { const d = parseDate(s.date); return d >= a && d < b; };
function periodLabel(mode, [a, b]) {
  if (mode === "year") return String(a.getFullYear());
  if (mode === "week") { const e = addDays(b, -1); return a.getMonth() === e.getMonth() ? `${a.getDate()}–${fmt({ day: "numeric", month: "short" }, e)}` : `${fmt({ day: "numeric", month: "short" }, a)} – ${fmt({ day: "numeric", month: "short" }, e)}`; }
  return monthYear(a);
}

/* ---------- storage: IndexedDB + localStorage mirror ---------- */
let dbPromise = null;
function openDB() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((res, rej) => {
    let r;
    try { r = indexedDB.open(DB_NAME, DB_VERSION); } catch (e) { return rej(e); }
    r.onupgradeneeded = () => { const db = r.result; if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: "id" }).createIndex("date", "date"); };
    r.onsuccess = () => { const db = r.result; db.onversionchange = () => { db.close(); dbPromise = null; }; db.onclose = () => { dbPromise = null; }; res(db); };
    r.onerror = () => rej(r.error);
  });
  dbPromise.catch(() => { dbPromise = null; });
  return dbPromise;
}
function tx(mode, fn) {
  return openDB().then(db => new Promise((res, rej) => {
    const t = db.transaction(STORE, mode), req = fn(t.objectStore(STORE));
    let out;
    if (req) req.onsuccess = () => { out = req.result; };
    t.oncomplete = () => res(out);
    t.onerror = t.onabort = () => rej(t.error);
  }));
}
const dbAll = () => tx("readonly", st => st.getAll()).then(x => x || []);
const dbPutMany = xs => tx("readwrite", st => { xs.forEach(x => st.put(x)); });
const dbDelete = id => tx("readwrite", st => st.delete(id));
const dbClear = () => tx("readwrite", st => st.clear());

// A second copy in localStorage: if IndexedDB gets evicted or corrupted, records are restored from here on start
function writeMirror() { try { localStorage.setItem(MIRROR_KEY, JSON.stringify({ savedAt: Date.now(), shifts: state.shifts })); } catch {} }
function readMirror() { try { const m = JSON.parse(localStorage.getItem(MIRROR_KEY) || "null"); return m && Array.isArray(m.shifts) ? m.shifts : []; } catch { return []; } }
function dbFail(e) { console.error(e); state.dbOk = false; }

function normalizeShift(s) {
  if (!s || typeof s !== "object") return null;
  const isDate = v => /^\d{4}-\d{2}-\d{2}$/.test(v || ""), isTime = v => /^\d{2}:\d{2}$/.test(v || "");
  if (!isDate(s.date) || !isTime(s.startTime)) return null;
  const status = s.status === "active" ? "active" : "completed";
  if (status === "completed" && !isTime(s.endTime)) return null;
  const br = Math.max(0, Math.round(Number(s.breakMinutes) || 0));
  const dur = Number(s.durationMinutes);
  return {
    id: String(s.id || uid()), date: s.date, startTime: s.startTime,
    endTime: status === "completed" ? s.endTime : null, breakMinutes: br,
    durationMinutes: status === "completed" ? (Number.isFinite(dur) && dur >= 0 ? dur : durationFor(s.date, s.startTime, s.endTime, br)) : 0,
    comment: String(s.comment || "").slice(0, 500), status,
    createdAt: Number(s.createdAt) || Date.now(), updatedAt: Number(s.updatedAt) || 0,
  };
}

async function loadShifts() {
  let fromDb = [];
  try { fromDb = await dbAll(); state.dbOk = true; } catch (e) { dbFail(e); }
  const map = new Map();
  for (const raw of [...readMirror(), ...fromDb]) {
    const s = normalizeShift(raw); if (!s) continue;
    const prev = map.get(s.id);
    if (!prev || s.updatedAt >= prev.updatedAt) map.set(s.id, s);
  }
  state.shifts = [...map.values()];
  const dbIds = new Set(fromDb.map(s => s.id));
  const missing = state.shifts.filter(s => !dbIds.has(s.id));
  if (missing.length && state.dbOk) {
    try { await dbPutMany(missing); } catch (e) { dbFail(e); }
    if (fromDb.length === 0) setTimeout(() => toast(`Восстановлено из резервной копии: ${shiftsWord(missing.length)}`), 600);
  }
  writeMirror();
}
async function saveShifts(xs) {
  const now = Date.now();
  xs.forEach(x => { x.updatedAt = now; });
  const map = new Map(state.shifts.map(s => [s.id, s]));
  xs.forEach(x => map.set(x.id, x));
  state.shifts = [...map.values()];
  writeMirror();
  try { await dbPutMany(xs); } catch (e) { dbFail(e); }
  requestPersist();
}
async function removeShift(id) {
  state.shifts = state.shifts.filter(s => s.id !== id);
  writeMirror();
  try { await dbDelete(id); } catch (e) { dbFail(e); }
}
async function clearAll() {
  state.shifts = [];
  writeMirror();
  try { await dbClear(); } catch (e) { dbFail(e); }
}
// Asks the browser not to evict our data under storage pressure (the default storage is "best-effort")
async function requestPersist() {
  try {
    if (!navigator.storage || !navigator.storage.persist) return;
    state.persisted = await navigator.storage.persisted();
    if (!state.persisted) state.persisted = await navigator.storage.persist();
  } catch {}
}

function loadSettings() { try { state.settings = { ...state.settings, ...JSON.parse(localStorage.getItem(SETTINGS_KEY) || "{}") }; } catch {} state.settings.weekStart = Number(state.settings.weekStart) === 0 ? 0 : 1; }
function saveSettings() { try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(state.settings)); } catch {} }

/* ---------- navigation ---------- */
const navItems = [["home", "⌂", "Главная"], ["add", "＋", "Добавить"], ["stats", "◒", "Статистика"], ["history", "☰", "История"]];
const titles = { add: "Новая смена", stats: "Статистика", history: "История смен", settings: "Настройки" };
function go(view, opts = {}) {
  const fromView = state.view;
  state.editId = opts.editId || null;
  state.editDate = opts.date || null;
  if (view === "add") state.returnTo = opts.returnTo || (fromView === "add" ? state.returnTo : fromView);
  state.view = view;
  if (fromView !== view || opts.editId) history.pushState({ view }, "");
  render();
  window.scrollTo(0, 0);
}
window.addEventListener("popstate", e => {
  closeModal();
  state.view = (e.state && e.state.view) || "home";
  state.editId = null; state.editDate = null;
  render();
});

function renderNav() {
  const html = navItems.map(([id, icon, label]) => `<button class="nav-item ${state.view === id && !state.editId ? "active" : ""}" data-nav="${id}"><span class="nav-icon">${icon}</span><span>${label}</span></button>`).join("");
  $("#sideNav").innerHTML = html;
  $("#bottomNav").innerHTML = html;
}
function greeting() { const h = new Date().getHours(); return h < 5 ? "Доброй ночи" : h < 12 ? "Доброе утро" : h < 18 ? "Добрый день" : "Добрый вечер"; }
function render() {
  document.querySelectorAll(".view").forEach(v => v.classList.toggle("active", v.id === "view-" + state.view));
  renderNav();
  clearInterval(window.__timer);
  ({ home: renderHome, add: renderAdd, stats: renderStats, history: renderHistory, settings: renderSettings })[state.view]();
  $("#pageTitle").textContent = state.view === "home" ? greeting() : state.view === "add" && state.editId ? "Редактирование" : titles[state.view];
  $("#todayLabel").textContent = fmt({ weekday: "long", day: "numeric", month: "long" }, new Date());
}

/* ---------- home ---------- */
function backupBanner() {
  if (!completed().length) return "";
  const last = Number(state.settings.lastBackupAt) || 0, days = Math.floor((Date.now() - last) / 86400000);
  if (last && days < BACKUP_REMIND_DAYS) return "";
  return `<div class="banner"><div><strong>${last ? `Копия не сохранялась ${days} ${plural(days, "день", "дня", "дней")}` : "Нет резервной копии"}</strong><span>Данные хранятся только в этом браузере. Сохрани файл копии в Telegram, Google Диск или в Загрузки.</span></div><button class="btn small" data-action="backup">Сохранить</button></div>`;
}
function renderHome() {
  const now = new Date(), a = activeShift(), mr = periodRange("month"), xs = completed().filter(s => inRange(s, mr));
  const total = sum(xs), goal = Number(state.settings.goal) || 0, pct = goal ? Math.min(100, total / (goal * 60) * 100) : 0;
  const recent = completed().sort(byNewest).slice(0, 3);
  const status = a ? `
      <div class="status-head"><span class="status-pill">● НА СМЕНЕ</span><span class="sub">с ${esc(a.startTime)} · ${fmt({ day: "numeric", month: "long" }, parseDate(a.date))}</span></div>
      <h2>Рабочий режим</h2>
      <div class="timer" id="liveTimer">00:00:00</div>
      ${rate() ? `<div class="sub live-money" id="liveMoney"></div>` : ""}
      <button class="btn wide-btn" data-action="finish">Завершить смену</button>
      <div class="btn-row"><button class="btn secondary" data-action="edit-start">Изменить начало</button><button class="btn secondary" data-action="cancel-active">Отменить</button></div>`
    : `
      <div class="status-head"><span class="status-pill done">● СВОБОДЕН</span><span class="sub">${completed().length ? "последняя: " + fmt({ day: "numeric", month: "short" }, parseDate(completed().sort(byNewest)[0].date)) : ""}</span></div>
      <h2>Не на смене</h2>
      <div class="sub">Нажми «Начать», когда придёшь на работу, или добавь смену вручную.</div>
      <div class="timer dim">— —</div>
      <button class="btn wide-btn" data-action="start">▶ Начать смену</button>
      <div class="btn-row"><button class="btn secondary" data-nav="add">＋ Добавить вручную</button></div>`;
  $("#view-home").innerHTML = `
    ${backupBanner()}
    <div class="home-grid grid">
      <div class="status-card ${a ? "live" : ""}">${status}</div>
      <div class="panel">
        <div class="section-head top"><h3>${fmt({ month: "long" }, now).replace(/^./, c => c.toUpperCase())}</h3><span>${goal ? `цель ${goal}ч` : ""}</span></div>
        <div class="big-stat">${hm(total)}</div>
        <div class="sub">${shiftsWord(xs.length)}${rate() ? ` · ${money(total)}` : ""}</div>
        ${goal ? `<div class="progress"><i style="width:${pct}%"></i></div>
        <div class="progress-row"><span>${total >= goal * 60 ? "Цель выполнена 🎉" : "Осталось " + hm(goal * 60 - total)}</span><b>${pct.toFixed(0)}%</b></div>` : ""}
      </div>
    </div>
    <div class="stats-grid">
      ${metric("Средняя смена", hm(xs.length ? total / xs.length : 0))}
      ${metric("Эта неделя", hm(sum(completed().filter(s => inRange(s, periodRange("week"))))))}
      ${rate() ? metric("Заработок за месяц", money(total)) : metric("Всего смен", completed().length)}
      ${metric("Серия", streak() + " " + plural(streak(), "день", "дня", "дней"))}
    </div>
    <div class="dashboard-two">
      <div><div class="section-head"><h3>Последние смены</h3>${recent.length ? `<button class="link-btn" data-nav="history">Все →</button>` : ""}</div>
        <div class="shift-list">${recent.length ? recent.map(shiftCard).join("") : emptyState("История пока пуста", "Начни смену или добавь первую запись вручную.")}</div></div>
      <div><div class="section-head"><h3>Календарь</h3><span>нажми на день</span></div><div class="panel">${calendarHTML()}</div></div>
    </div>`;
  if (a) startTimer(a);
}
const metric = (label, value) => `<div class="metric"><span class="label">${label}</span><span class="value">${value}</span></div>`;
function startTimer(a) {
  const start = parseLocal(a.date, a.startTime).getTime();
  const tick = () => {
    const el = $("#liveTimer"); if (!el) return clearInterval(window.__timer);
    const sec = Math.max(0, Math.floor((Date.now() - start) / 1000));
    el.textContent = `${pad(Math.floor(sec / 3600))}:${pad(Math.floor(sec % 3600 / 60))}:${pad(sec % 60)}`;
    const m = $("#liveMoney"); if (m) m.textContent = "≈ " + money(sec / 60) + " заработано";
  };
  tick();
  window.__timer = setInterval(tick, 1000);
}
const emptyState = (title, text) => `<div class="empty"><div class="empty-icon">◷</div><strong>${title}</strong><div>${text}</div><br><button class="btn" data-nav="add">＋ Добавить смену</button></div>`;
function shiftCard(s) {
  const d = parseDate(s.date), overnight = s.endTime <= s.startTime;
  return `<button class="shift-card" data-edit="${s.id}">
    <div class="shift-top"><div class="shift-date">${fmt({ day: "numeric", month: "long" }, d)}<small>${fmt({ weekday: "long" }, d)}${d.getFullYear() !== new Date().getFullYear() ? " · " + d.getFullYear() : ""}</small></div><span class="duration">${hm(s.durationMinutes)}</span></div>
    <div class="shift-meta"><span>${esc(s.startTime)} → ${esc(s.endTime)}${overnight ? " <em>+1 день</em>" : ""}</span><span>${s.breakMinutes ? "перерыв " + hm(s.breakMinutes) : ""}${rate() ? (s.breakMinutes ? " · " : "") + money(s.durationMinutes) : ""}</span></div>
    ${s.comment ? `<div class="shift-comment">${esc(s.comment)}</div>` : ""}
  </button>`;
}

/* ---------- calendar ---------- */
function calendarHTML() {
  const base = state.calDate, y = base.getFullYear(), m = base.getMonth();
  const lead = (new Date(y, m, 1).getDay() - state.settings.weekStart + 7) % 7, days = new Date(y, m + 1, 0).getDate();
  const today = dateISO(new Date()), mins = {}, a = activeShift();
  completed().forEach(s => { mins[s.date] = (mins[s.date] || 0) + s.durationMinutes; });
  const heads = ["Вс", "Пн", "Вт", "Ср", "Чт", "Пт", "Сб"];
  let out = `<div class="calendar-nav"><button class="icon-mini" data-cal="-1" aria-label="Предыдущий месяц">‹</button><strong>${monthYear(base)}</strong><button class="icon-mini" data-cal="1" aria-label="Следующий месяц">›</button></div><div class="calendar">`;
  for (let i = 0; i < 7; i++) out += `<div class="cal-head">${heads[(i + state.settings.weekStart) % 7]}</div>`;
  for (let i = 0; i < lead; i++) out += `<div></div>`;
  for (let day = 1; day <= days; day++) {
    const iso = `${y}-${pad(m + 1)}-${pad(day)}`, w = mins[iso];
    out += `<button class="cal-day ${w !== undefined ? "work" : ""} ${iso === today ? "today" : ""} ${a && a.date === iso ? "live" : ""}" data-calday="${iso}"><span>${day}</span>${w !== undefined ? `<small>${hShort(w)}</small>` : ""}</button>`;
  }
  return out + "</div>";
}
function openDay(iso) {
  const xs = state.shifts.filter(s => s.date === iso && s.status === "completed").sort((a, b) => a.startTime.localeCompare(b.startTime));
  if (!xs.length) return go("add", { date: iso });
  const box = openModal(`<h3>${fmt({ weekday: "long", day: "numeric", month: "long" }, parseDate(iso))}</h3>
    <p>${shiftsWord(xs.length)} · ${hm(sum(xs))}${rate() ? " · " + money(sum(xs)) : ""}</p>
    <div class="shift-list">${xs.map(shiftCard).join("")}</div>
    <div class="modal-actions"><button class="btn secondary" data-close>Закрыть</button><button class="btn" data-add-on="${iso}">＋ Ещё смена</button></div>`);
  box.querySelector("[data-add-on]").onclick = () => { closeModal(); go("add", { date: iso }); };
}

/* ---------- add / edit ---------- */
function templates() {
  const cnt = new Map();
  completed().sort(byNewest).slice(0, 40).forEach(s => { const k = `${s.startTime}|${s.endTime}|${s.breakMinutes || 0}`; cnt.set(k, (cnt.get(k) || 0) + 1); });
  return [...cnt.entries()].sort((a, b) => b[1] - a[1]).slice(0, 4).map(([k]) => { const [start, end, br] = k.split("|"); return { start, end, br: Number(br) }; });
}
function breakField(val) {
  return `<div class="field"><label>Перерыв, минут</label><div class="break-row"><input name="break" type="number" inputmode="numeric" min="0" max="720" step="5" value="${val}">
    ${[0, 15, 30, 45, 60].map(v => `<button type="button" class="chip ${v === val ? "active" : ""}" data-break="${v}">${v || "нет"}</button>`).join("")}</div></div>`;
}
function renderAdd() {
  const edit = state.editId ? state.shifts.find(s => s.id === state.editId) : null;
  const tpls = edit ? [] : templates(), t = tpls[0] || { start: "09:00", end: "18:00", br: 0 };
  const v = edit ? { date: edit.date, start: edit.startTime, end: edit.endTime, br: edit.breakMinutes || 0, comment: edit.comment }
    : { date: state.editDate || dateISO(new Date()), start: t.start, end: t.end, br: t.br, comment: "" };
  $("#view-add").innerHTML = `<div class="panel form-panel">
    ${tpls.length ? `<div class="field"><label>Быстро · твои частые смены</label><div class="chips-row">${tpls.map(x => `<button type="button" class="chip" data-tpl="${x.start}|${x.end}|${x.br}">${x.start}–${x.end}${x.br ? ` · ${x.br}м` : ""}</button>`).join("")}</div></div>` : ""}
    <form class="form" id="shiftForm" autocomplete="off">
      <div class="field"><label>Дата</label><input name="date" type="date" value="${v.date}" required></div>
      <div class="two-col"><div class="field"><label>Начало</label><input name="start" type="time" value="${v.start}" required></div><div class="field"><label>Окончание</label><input name="end" type="time" value="${v.end}" required></div></div>
      ${breakField(v.br)}
      <div class="field"><label>Комментарий · необязательно</label><textarea name="comment" rows="2" maxlength="500" placeholder="Например: подмена, ночная">${esc(v.comment)}</textarea></div>
      <div class="preview" id="durationPreview"></div>
      <button class="btn" type="submit">${edit ? "Сохранить изменения" : "Сохранить смену"}</button>
      ${edit ? `<div class="btn-row"><button class="btn secondary" type="button" data-action="back">Отмена</button><button class="btn danger" type="button" data-action="delete-edit">Удалить</button></div>` : ""}
    </form></div>`;
  const f = $("#shiftForm");
  f.addEventListener("input", updatePreview);
  f.addEventListener("submit", saveShiftForm);
  updatePreview();
}
function updatePreview() {
  const f = $("#shiftForm"); if (!f) return;
  const { date, start, end } = f.elements, br = Number(f.elements.break.value) || 0;
  f.querySelectorAll("[data-break]").forEach(b => b.classList.toggle("active", Number(b.dataset.break) === br));
  if (!date.value || !start.value || !end.value) { $("#durationPreview").innerHTML = "Укажи дату и время"; return; }
  const m = durationFor(date.value, start.value, end.value, br);
  const others = completed().filter(s => s.date === date.value && s.id !== state.editId);
  const notes = [];
  if (end.value <= start.value) notes.push("Смена через полночь — окончание на следующий день");
  if (m > 16 * 60) notes.push("Больше 16 часов — проверь время");
  if (others.length) notes.push(`На эту дату уже есть: ${others.map(s => s.startTime + "–" + s.endTime).join(", ")}`);
  $("#durationPreview").innerHTML = `<span>Рабочее время</span><b>${hm(m)}</b>${rate() ? `<span class="earn">${money(m)}</span>` : ""}${notes.map(n => `<div class="warn">${n}</div>`).join("")}`;
}
async function saveShiftForm(e) {
  e.preventDefault();
  const f = e.currentTarget, el = f.elements;
  if (!el.date.value || !el.start.value || !el.end.value) return toast("Заполни дату и время");
  const br = Math.max(0, Math.round(Number(el.break.value) || 0));
  if (br > 720) return toast("Слишком длинный перерыв");
  const existing = state.editId ? state.shifts.find(s => s.id === state.editId) : null;
  const m = durationFor(el.date.value, el.start.value, el.end.value, br);
  if (m <= 0) return toast("Перерыв длиннее смены");
  await saveShifts([{
    id: existing?.id || uid(), date: el.date.value, startTime: el.start.value, endTime: el.end.value,
    breakMinutes: br, durationMinutes: m, comment: el.comment.value.trim(), status: "completed", createdAt: existing?.createdAt || Date.now(),
  }]);
  vibrate(20);
  toast(existing ? "Изменения сохранены" : `Смена сохранена · ${hm(m)}`);
  goBack();
}
function goBack() {
  if (history.state && history.state.view === state.view && history.length > 1) history.back();
  else go(state.returnTo && state.returnTo !== "add" ? state.returnTo : "home");
}

/* ---------- live shift ---------- */
async function startShift() {
  if (activeShift()) return;
  const now = new Date();
  await saveShifts([{ id: uid(), date: dateISO(now), startTime: hmOf(now), endTime: null, breakMinutes: 0, durationMinutes: 0, comment: "", status: "active", createdAt: Date.now() }]);
  vibrate(30);
  toast("Смена началась · " + hmOf(now));
  render();
}
function finishShiftDialog() {
  const a = activeShift(); if (!a) return;
  const box = openModal(`<h3>Завершить смену</h3><p>Начало: ${esc(a.startTime)}, ${fmt({ day: "numeric", month: "long" }, parseDate(a.date))}</p>
    <form class="form" id="finishForm">
      <div class="field"><label>Окончание</label><input name="end" type="time" value="${hmOf(new Date())}" required></div>
      ${breakField(0)}
      <div class="field"><label>Комментарий · необязательно</label><input name="comment" type="text" maxlength="500" value="${esc(a.comment)}"></div>
      <div class="preview" id="finishPreview"></div>
      <div class="modal-actions"><button type="button" class="btn secondary" data-close>Отмена</button><button class="btn" type="submit">Завершить</button></div>
    </form>`);
  const f = box.querySelector("#finishForm");
  const calc = () => {
    const br = Number(f.elements.break.value) || 0;
    f.querySelectorAll("[data-break]").forEach(b => b.classList.toggle("active", Number(b.dataset.break) === br));
    return finishMinutes(a, f.elements.end.value, br);
  };
  const show = () => { const m = calc(); box.querySelector("#finishPreview").innerHTML = `<span>Рабочее время</span><b>${hm(m)}</b>${rate() ? `<span class="earn">${money(m)}</span>` : ""}`; };
  f.addEventListener("input", show); show();
  f.addEventListener("submit", async e => {
    e.preventDefault();
    const br = Math.max(0, Number(f.elements.break.value) || 0), m = finishMinutes(a, f.elements.end.value, br);
    Object.assign(a, { endTime: f.elements.end.value, breakMinutes: br, durationMinutes: m, comment: f.elements.comment.value.trim(), status: "completed" });
    await saveShifts([a]);
    closeModal(); vibrate([20, 40, 20]);
    toast(`Смена завершена · ${hm(m)}`);
    render();
  });
}
// End time is the chosen clock time closest to "now" that is after the start (handles night shifts and long shifts)
function finishMinutes(a, end, br) {
  if (!end) return 0;
  const start = parseLocal(a.date, a.startTime), now = new Date();
  let b = parseLocal(dateISO(now), end);
  if (b - now > 12 * 3600000) b = addDays(b, -1);
  if (now - b > 12 * 3600000) b = addDays(b, 1);
  while (b < start) b = addDays(b, 1);
  return Math.max(0, Math.round((b - start) / 60000) - br);
}
function editStartDialog() {
  const a = activeShift(); if (!a) return;
  const box = openModal(`<h3>Изменить начало</h3><p>Если забыл нажать «Начать» вовремя.</p>
    <form class="form" id="startForm"><div class="two-col"><div class="field"><label>Дата</label><input name="date" type="date" value="${a.date}" required></div><div class="field"><label>Время</label><input name="start" type="time" value="${a.startTime}" required></div></div>
    <div class="modal-actions"><button type="button" class="btn secondary" data-close>Отмена</button><button class="btn" type="submit">Сохранить</button></div></form>`);
  box.querySelector("#startForm").addEventListener("submit", async e => {
    e.preventDefault();
    const el = e.currentTarget.elements;
    if (parseLocal(el.date.value, el.start.value) > new Date()) return toast("Начало не может быть в будущем");
    Object.assign(a, { date: el.date.value, startTime: el.start.value });
    await saveShifts([a]);
    closeModal(); toast("Время начала изменено"); render();
  });
}

/* ---------- history ---------- */
function renderHistory() {
  const filters = [["week", "Неделя"], ["month", "Месяц"], ["prev", "Прошлый месяц"], ["year", "Год"], ["all", "Всё время"]];
  const range = state.historyFilter === "prev" ? periodRange("month", -1) : periodRange(state.historyFilter);
  const xs = completed().filter(s => inRange(s, range)).sort(byNewest), total = sum(xs);
  let list = "", lastMonth = "";
  const multiMonth = ["year", "all"].includes(state.historyFilter);
  for (const s of xs) {
    const key = s.date.slice(0, 7);
    if (multiMonth && key !== lastMonth) {
      const ms = xs.filter(x => x.date.startsWith(key));
      list += `<div class="month-sep"><strong>${monthYear(parseDate(key + "-01"))}</strong><span>${shiftsWord(ms.length)} · ${hm(sum(ms))}</span></div>`;
      lastMonth = key;
    }
    list += shiftCard(s);
  }
  $("#view-history").innerHTML = `
    <div class="filter-row">${filters.map(([id, l]) => `<button class="chip ${state.historyFilter === id ? "active" : ""}" data-filter="${id}">${l}</button>`).join("")}</div>
    <div class="summary"><div><span>Смен</span><b>${xs.length}</b></div><div><span>Часов</span><b>${hm(total)}</b></div>${rate() ? `<div><span>Заработок</span><b>${money(total)}</b></div>` : `<div><span>Средняя</span><b>${hm(xs.length ? total / xs.length : 0)}</b></div>`}</div>
    <div class="shift-list">${xs.length ? list : emptyState("Ничего нет", "За этот период смен не найдено.")}</div>
    ${xs.length ? `<p class="notice center">Нажми на смену, чтобы изменить или удалить её</p>` : ""}`;
}

/* ---------- stats ---------- */
function streak() {
  const days = new Set(completed().map(s => s.date));
  let d = new Date(), n = 0;
  if (!days.has(dateISO(d))) d = addDays(d, -1);
  while (days.has(dateISO(d))) { n++; d = addDays(d, -1); }
  return n;
}
function renderStats() {
  const mode = state.statsMode, range = periodRange(mode, state.statsOffset), [a, b] = range;
  const xs = completed().filter(s => inRange(s, range)), total = sum(xs), durs = xs.map(s => s.durationMinutes);
  const workDays = new Set(xs.map(s => s.date)).size;
  const elapsed = Math.max(1, Math.round((Math.min(b, addDays(new Date(new Date().toDateString()), 1)) - a) / 86400000));
  const perWeek = total / Math.max(1, elapsed / 7);
  const labels = [], values = [];
  if (mode === "year") {
    for (let i = 0; i < 12; i++) { labels.push(fmt({ month: "short" }, new Date(a.getFullYear(), i, 1)).replace(".", "")); values.push(sum(xs.filter(s => parseDate(s.date).getMonth() === i)) / 60); }
  } else {
    for (let d = new Date(a); d < b; d = addDays(d, 1)) {
      const iso = dateISO(d);
      labels.push(mode === "week" ? fmt({ weekday: "short" }, d) : String(d.getDate()));
      values.push(sum(xs.filter(s => s.date === iso)) / 60);
    }
  }
  state.chart = { labels, values, every: mode === "month" ? 5 : 1 };
  const months = [];
  for (let i = 0; i < 12; i++) { const r = periodRange("month", -i), ms = completed().filter(s => inRange(s, r)); if (ms.length || i < 3) months.push({ i, r, n: ms.length, t: sum(ms) }); }
  const maxMonth = Math.max(1, ...months.map(m => m.t));
  $("#view-stats").innerHTML = `
    <div class="segmented">${[["week", "Неделя"], ["month", "Месяц"], ["year", "Год"]].map(([id, l]) => `<button class="${mode === id ? "active" : ""}" data-stats="${id}">${l}</button>`).join("")}</div>
    <div class="period-nav"><button class="icon-mini" data-period="-1" aria-label="Назад">‹</button><strong>${periodLabel(mode, range)}</strong><button class="icon-mini" data-period="1" ${state.statsOffset >= 0 ? "disabled" : ""} aria-label="Вперёд">›</button></div>
    <div class="stats-grid">
      ${metric("Смен", xs.length)}${metric("Рабочих часов", hm(total))}
      ${metric("Средняя смена", hm(xs.length ? total / xs.length : 0))}${rate() ? metric("Заработок", money(total)) : metric("Рабочих дней", workDays)}
    </div>
    <div class="panel"><div class="section-head top"><h3>Часы по ${mode === "year" ? "месяцам" : "дням"}</h3><span>${xs.length ? "ср. " + hShort(total / Math.max(1, mode === "year" ? values.filter(Boolean).length : workDays)) : ""}</span></div><div class="chart-wrap"><canvas id="hoursChart" class="chart"></canvas></div></div>
    <div class="stats-grid">
      ${metric("Самая длинная", hm(durs.length ? Math.max(...durs) : 0))}${metric("Самая короткая", hm(durs.length ? Math.min(...durs) : 0))}
      ${metric("В среднем в неделю", hm(perWeek))}${metric("Всего за всё время", hm(sum(completed())))}
    </div>
    <div class="section-head"><h3>По месяцам</h3><span>последние 12</span></div>
    <div class="tableish">${months.map(m => `<button class="month-row" data-month="${-m.i}"><div><strong>${monthYear(m.r[0])}</strong><span>${shiftsWord(m.n)}${rate() ? " · " + money(m.t) : ""}</span></div><div class="bar"><i style="width:${m.t / maxMonth * 100}%"></i></div><b>${hm(m.t)}</b></button>`).join("")}</div>`;
  requestAnimationFrame(drawChart);
}
function drawChart() {
  const c = $("#hoursChart"); if (!c || !state.chart) return;
  const { labels, values, every } = state.chart;
  const ctx = c.getContext("2d"), dpr = window.devicePixelRatio || 1, w = c.clientWidth, h = c.clientHeight;
  if (!w || !h) return;
  c.width = w * dpr; c.height = h * dpr; ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  const css = getComputedStyle(document.documentElement), muted = css.getPropertyValue("--muted").trim() || "#8D95A1";
  const max = Math.max(1, ...values), step = max > 40 ? 20 : max > 16 ? 5 : max > 6 ? 2 : 1, top_ = Math.ceil(max / step) * step;
  const left = 30, bottom = 22, top = 8, gw = w - left - 4, gh = h - top - bottom, n = Math.max(1, values.length), gap = gw / n, bw = Math.max(3, Math.min(26, gap * 0.62));
  ctx.clearRect(0, 0, w, h);
  ctx.font = "10px Inter, system-ui, sans-serif"; ctx.textBaseline = "middle";
  for (let v = 0; v <= top_; v += step) {
    const y = top + gh - gh * v / top_;
    ctx.strokeStyle = "rgba(255,255,255,.07)"; ctx.beginPath(); ctx.moveTo(left, y); ctx.lineTo(w, y); ctx.stroke();
    ctx.fillStyle = muted; ctx.textAlign = "right"; ctx.fillText(v + "ч", left - 6, y);
  }
  ctx.textAlign = "center"; ctx.textBaseline = "alphabetic";
  values.forEach((v, i) => {
    const x = left + i * gap + (gap - bw) / 2;
    if (v > 0) {
      const bh = Math.max(2, gh * v / top_), y = top + gh - bh, g = ctx.createLinearGradient(0, y, 0, top + gh);
      g.addColorStop(0, "#8B6CFF"); g.addColorStop(1, "#4E7DFF");
      ctx.fillStyle = g; roundRect(ctx, x, y, bw, bh, Math.min(6, bw / 2)); ctx.fill();
    }
    if (i % every === 0 || (every > 1 && i === n - 1 && (n - 1) % every > 2)) { ctx.fillStyle = muted; ctx.fillText(labels[i], x + bw / 2, h - 6); }
  });
}
// ctx.roundRect is missing on older iOS Safari, so draw the path by hand
function roundRect(ctx, x, y, w, h, r) {
  r = Math.min(r, w / 2, h / 2);
  ctx.beginPath(); ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r); ctx.lineTo(x + w, y + h); ctx.lineTo(x, y + h);
  ctx.arcTo(x, y, x + w, y, r); ctx.closePath();
}

/* ---------- settings ---------- */
function renderSettings() {
  const last = Number(state.settings.lastBackupAt) || 0;
  const persistTxt = state.persisted === true ? "✅ Защищено: браузер не удалит данные при нехватке памяти" : state.persisted === false ? "⚠️ Браузер может удалить данные при нехватке памяти. Установи приложение на главный экран и нажми «Защитить»" : "Статус неизвестен";
  $("#view-settings").innerHTML = `<div class="settings-list">
    <div class="section-head top"><h3>Работа</h3></div>
    <label class="setting-card"><div class="copy"><strong>Цель часов в месяц</strong><span>Прогресс на главной. 0 — без цели</span></div><input class="setting-control" id="goalInput" type="number" inputmode="numeric" min="0" max="744" value="${esc(state.settings.goal)}"></label>
    <label class="setting-card"><div class="copy"><strong>Ставка в час</strong><span>Для подсчёта заработка. 0 — не показывать</span></div><input class="setting-control" id="rateInput" type="number" inputmode="decimal" min="0" step="any" value="${esc(state.settings.rate)}"></label>
    <label class="setting-card"><div class="copy"><strong>Валюта</strong><span>Например: сом, ₸, ₽, $</span></div><input class="setting-control" id="currencyInput" type="text" maxlength="6" value="${esc(state.settings.currency)}" placeholder="—"></label>
    <label class="setting-card"><div class="copy"><strong>Первый день недели</strong><span>Календарь и недельная статистика</span></div><select class="setting-control" id="weekStart"><option value="1" ${state.settings.weekStart === 1 ? "selected" : ""}>Понедельник</option><option value="0" ${state.settings.weekStart === 0 ? "selected" : ""}>Воскресенье</option></select></label>

    <div class="section-head"><h3>Сохранность данных</h3><span>${shiftsWord(completed().length)}</span></div>
    <div class="setting-card col"><div class="copy"><strong>Хранилище браузера</strong><span>${persistTxt}${state.dbOk ? "" : "<br>⚠️ База IndexedDB недоступна, используется запасная копия"}</span></div>${state.persisted ? "" : `<button class="mini-btn" data-action="persist">Защитить</button>`}</div>
    <div class="setting-card"><div class="copy"><strong>Резервная копия (JSON)</strong><span>${last ? "Последняя: " + fmt({ day: "numeric", month: "long", hour: "2-digit", minute: "2-digit" }, new Date(last)) : "Ещё не делалась"}. Сохрани файл в Telegram «Избранное» или Google Диск</span></div><button class="btn small" data-action="backup">Сохранить</button></div>
    <div class="setting-card"><div class="copy"><strong>Восстановить из копии</strong><span>Записи объединяются, ничего не удаляется</span></div><button class="mini-btn" data-import>Выбрать файл</button></div>
    <div class="setting-card"><div class="copy"><strong>Таблица CSV</strong><span>Для Excel / Google Таблиц</span></div><button class="mini-btn" data-export="csv">CSV</button></div>
    <div class="setting-card danger-zone"><div class="copy"><strong>Удалить все данные</strong><span>Необратимо. Перед удалением будет скачана копия</span></div><button class="btn danger small" data-clear>Удалить</button></div>
    <p class="notice">ShiftPulse ${APP_VERSION} хранит данные только на этом устройстве, в этом браузере. Очистка данных браузера, программы-«чистильщики» или переустановка удалят их — поэтому регулярно сохраняй резервную копию.</p>
  </div>`;
  const bind = (id, key, parse) => $(id).addEventListener("change", e => { state.settings[key] = parse(e.target.value); saveSettings(); toast("Сохранено"); });
  bind("#goalInput", "goal", v => Math.max(0, Math.min(744, Number(v) || 0)));
  bind("#rateInput", "rate", v => Math.max(0, Number(String(v).replace(",", ".")) || 0));
  bind("#currencyInput", "currency", v => v.trim().slice(0, 6));
  bind("#weekStart", "weekStart", v => Number(v) === 0 ? 0 : 1);
}

/* ---------- export / import ---------- */
function backupBlob() { return new Blob([JSON.stringify({ app: "ShiftPulse", version: 2, exportedAt: new Date().toISOString(), settings: state.settings, shifts: state.shifts }, null, 2)], { type: "application/json" }); }
function markBackup() { state.settings.lastBackupAt = Date.now(); saveSettings(); }
async function exportJSON(silent) {
  const name = `shiftpulse_${dateISO(new Date())}.json`, blob = backupBlob();
  // On phones the share sheet lets you send the file straight to Telegram / Drive; fall back to a download
  if (!silent) {
    try {
      const file = new File([blob], name, { type: "application/json" });
      if (navigator.canShare && navigator.canShare({ files: [file] })) {
        await navigator.share({ files: [file], title: "ShiftPulse — резервная копия" });
        markBackup(); toast("Копия сохранена"); render(); return;
      }
    } catch (e) { if (e.name === "AbortError") return; }
  }
  download(blob, name);
  markBackup();
  if (!silent) { toast("Файл копии скачан"); render(); }
}
function exportCSV() {
  const head = ["Дата", "День недели", "Начало", "Конец", "Перерыв (мин)", "Часы", "Часы (десятичные)"];
  if (rate()) head.push("Заработок");
  head.push("Комментарий");
  const rows = [head, ...completed().sort((a, b) => -byNewest(a, b)).map(s => {
    const r = [s.date, fmt({ weekday: "short" }, parseDate(s.date)), s.startTime, s.endTime, s.breakMinutes || 0, hm(s.durationMinutes), (s.durationMinutes / 60).toFixed(2).replace(".", ",")];
    if (rate()) r.push(Math.round(s.durationMinutes / 60 * rate()));
    r.push(s.comment || "");
    return r;
  })];
  const csv = "﻿" + rows.map(r => r.map(v => `"${String(v).replaceAll('"', '""')}"`).join(";")).join("\r\n");
  download(new Blob([csv], { type: "text/csv;charset=utf-8" }), `shiftpulse_${dateISO(new Date())}.csv`);
}
function download(blob, name) { const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = name; document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 5000); }
function importJSON() {
  const input = document.createElement("input");
  input.type = "file"; input.accept = ".json,application/json,text/plain";
  input.onchange = async () => {
    try {
      const data = JSON.parse(await input.files[0].text());
      const incoming = (Array.isArray(data) ? data : data.shifts || []).map(normalizeShift).filter(Boolean);
      if (!incoming.length) throw Error("empty");
      const act = activeShift();
      const toSave = incoming.filter(s => s.status !== "active" || (!act && !incoming.some(x => x !== s && x.status === "active" && x.createdAt > s.createdAt)) || (act && act.id === s.id));
      const known = new Set(state.shifts.map(s => s.id)), added = toSave.filter(s => !known.has(s.id)).length;
      await saveShifts(toSave);
      if (data.settings) { const { lastBackupAt, ...rest } = data.settings; state.settings = { ...state.settings, ...rest }; loadSettingsFix(); saveSettings(); }
      toast(`Импорт: ${added} новых, ${toSave.length - added} обновлено`);
      render();
    } catch { toast("Не удалось прочитать файл копии"); }
  };
  input.click();
}
function loadSettingsFix() { state.settings.weekStart = Number(state.settings.weekStart) === 0 ? 0 : 1; }

/* ---------- ui primitives ---------- */
function toast(text, action) {
  const el = $("#toast");
  el.innerHTML = `<span>${esc(text)}</span>${action ? `<button>${esc(action.label)}</button>` : ""}`;
  if (action) el.querySelector("button").onclick = () => { el.classList.remove("show"); action.fn(); };
  el.classList.add("show");
  clearTimeout(window.__toast);
  window.__toast = setTimeout(() => el.classList.remove("show"), action ? 5000 : 2400);
}
function openModal(html) {
  const root = $("#modalRoot");
  root.innerHTML = `<div class="modal-backdrop" id="modal"><div class="modal" role="dialog" aria-modal="true">${html}</div></div>`;
  const m = $("#modal");
  m.addEventListener("click", e => { if (e.target === m || e.target.closest("[data-close]")) closeModal(); });
  return m.querySelector(".modal");
}
function closeModal() { $("#modalRoot").innerHTML = ""; }
function confirmModal(title, text, okLabel, onOk) {
  const box = openModal(`<h3>${title}</h3><p>${text}</p><div class="modal-actions"><button class="btn secondary" data-close>Отмена</button><button class="btn danger" data-ok>${okLabel}</button></div>`);
  box.querySelector("[data-ok]").onclick = () => { closeModal(); onOk(); };
}
async function deleteShift(id, skipRender) {
  const s = state.shifts.find(x => x.id === id); if (!s) return;
  await removeShift(id);
  if (!skipRender) render();
  toast("Смена удалена", { label: "Вернуть", fn: async () => { await saveShifts([s]); render(); toast("Смена восстановлена"); } });
}

/* ---------- events ---------- */
document.addEventListener("keydown", e => { if (e.key === "Escape") closeModal(); });
document.addEventListener("click", async e => {
  const t = e.target, q = sel => t.closest(sel);
  let el;
  if ((el = q("[data-nav]"))) { closeModal(); return go(el.dataset.nav); }
  if ((el = q("[data-edit]"))) { closeModal(); return go("add", { editId: el.dataset.edit }); }
  if ((el = q("[data-break]"))) { const f = el.closest("form"); f.elements.break.value = el.dataset.break; f.dispatchEvent(new Event("input")); return; }
  if ((el = q("[data-tpl]"))) { const [s, en, br] = el.dataset.tpl.split("|"), f = $("#shiftForm"); f.elements.start.value = s; f.elements.end.value = en; f.elements.break.value = br; updatePreview(); return; }
  if ((el = q("[data-filter]"))) { state.historyFilter = el.dataset.filter; return render(); }
  if ((el = q("[data-stats]"))) { state.statsMode = el.dataset.stats; state.statsOffset = 0; return render(); }
  if ((el = q("[data-period]"))) { state.statsOffset = Math.min(0, state.statsOffset + Number(el.dataset.period)); return render(); }
  if ((el = q("[data-month]"))) { state.statsMode = "month"; state.statsOffset = Number(el.dataset.month); render(); return window.scrollTo({ top: 0, behavior: "smooth" }); }
  if ((el = q("[data-cal]"))) { const d = state.calDate; state.calDate = new Date(d.getFullYear(), d.getMonth() + Number(el.dataset.cal), 1); return render(); }
  if ((el = q("[data-calday]"))) return openDay(el.dataset.calday);
  if ((el = q("[data-export]"))) return exportCSV();
  if (q("[data-import]")) return importJSON();
  if (q("[data-clear]")) return confirmModal("Удалить все данные?", "Все смены будут удалены с этого устройства. Перед удалением автоматически скачается файл резервной копии.", "Удалить всё", async () => { if (completed().length) await exportJSON(true); await clearAll(); toast("Все данные удалены"); render(); });
  if ((el = q("[data-action]"))) {
    const a = el.dataset.action;
    if (a === "settings") return go("settings");
    if (a === "start") return startShift();
    if (a === "finish") return finishShiftDialog();
    if (a === "edit-start") return editStartDialog();
    if (a === "cancel-active") return confirmModal("Отменить текущую смену?", "Запущенная смена будет удалена без сохранения.", "Отменить смену", async () => { await removeShift(activeShift().id); toast("Смена отменена"); render(); });
    if (a === "backup") return exportJSON();
    if (a === "persist") { await requestPersist(); toast(state.persisted ? "Данные защищены" : "Браузер отказал. Установи приложение на главный экран и попробуй снова"); return render(); }
    if (a === "back") return goBack();
    if (a === "delete-edit") { const id = state.editId; await deleteShift(id, true); return goBack(); }
  }
});

let resizeTimer;
window.addEventListener("resize", () => { clearTimeout(resizeTimer); resizeTimer = setTimeout(() => { if (state.view === "stats") drawChart(); }, 150); });
// Coming back to the app after hours: refresh greeting, date, timer and the "today" mark
document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible" && !$("#modal") && state.view !== "add") render(); });

async function boot() {
  loadSettings();
  await loadShifts();
  history.replaceState({ view: "home" }, "");
  render();
  requestPersist().then(() => { if (state.view === "settings") render(); });
  if ("serviceWorker" in navigator) {
    const hadController = !!navigator.serviceWorker.controller;
    navigator.serviceWorker.register("./sw.js", { updateViaCache: "none" }).catch(() => {});
    let reloaded = false;
    navigator.serviceWorker.addEventListener("controllerchange", () => { if (hadController && !reloaded && !$("#modal") && state.view !== "add") { reloaded = true; location.reload(); } });
  }
}
boot();
