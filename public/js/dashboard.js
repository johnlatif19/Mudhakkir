(function () {
  "use strict";

  const API = "/api";
  const POLL_INTERVAL = 5000;

  const PRAYER_LABELS = {
    fajr: "الفجر",
    dhuhr: "الظهر",
    asr: "العصر",
    maghrib: "المغرب",
    isha: "العشاء"
  };

  const PRAYER_ORDER = ["fajr", "dhuhr", "asr", "maghrib", "isha"];

  const state = {
    pollTimer: null,
    prayers: [],
    busy: false
  };

  const els = {};

  function cacheEls() {
    els.totalVisitors = document.getElementById("stat-total-visitors");
    els.todayVisitors = document.getElementById("stat-today-visitors");
    els.weekVisitors = document.getElementById("stat-week-visitors");
    els.completedPrayers = document.getElementById("stat-completed-prayers");
    els.prayerTable = document.getElementById("prayer-table");
    els.prayersDate = document.getElementById("prayers-date");
    els.visitsList = document.getElementById("visits-list");
    els.logout = document.getElementById("logout-btn");
  }

  async function apiFetch(path, options = {}) {
    const res = await fetch(path, {
      headers: { "Content-Type": "application/json", ...(options.headers || {}) },
      credentials: "include",
      ...options
    });
    if (res.status === 401) {
      location.replace("/login?next=/dashboard");
      throw new Error("unauthorized");
    }
    if (!res.ok) {
      let message = `HTTP ${res.status}`;
      try {
        const data = await res.json();
        if (data && data.error) message = data.error;
      } catch (_) {}
      throw new Error(message);
    }
    const ct = res.headers.get("content-type") || "";
    return ct.includes("application/json") ? res.json() : res.text();
  }

  function formatDateAr(date) {
    try {
      return new Intl.DateTimeFormat("ar", {
        weekday: "long",
        day: "numeric",
        month: "long",
        year: "numeric"
      }).format(date);
    } catch (_) {
      return date.toLocaleDateString();
    }
  }

  function formatTime(iso) {
    if (!iso) return "—";
    try {
      return new Intl.DateTimeFormat("ar", {
        hour: "2-digit",
        minute: "2-digit"
      }).format(new Date(iso));
    } catch (_) {
      return "—";
    }
  }

  function checkIcon() {
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("viewBox", "0 0 24 24");
    svg.setAttribute("fill", "none");
    svg.setAttribute("stroke", "currentColor");
    svg.setAttribute("stroke-width", "2.4");
    svg.setAttribute("stroke-linecap", "round");
    svg.setAttribute("stroke-linejoin", "round");
    const p = document.createElementNS("http://www.w3.org/2000/svg", "path");
    p.setAttribute("d", "M20 6L9 17l-5-5");
    svg.appendChild(p);
    return svg;
  }

  function renderStats(stats) {
    els.totalVisitors.textContent = String(stats.totalVisitors ?? 0);
    els.todayVisitors.textContent = String(stats.todayVisitors ?? 0);
    els.weekVisitors.textContent = String(stats.weekVisitors ?? 0);
    els.completedPrayers.textContent = String(stats.completedPrayersToday ?? 0);
  }

  function renderPrayers(prayers, date) {
    state.prayers = prayers;
    els.prayersDate.textContent = date ? formatDateAr(new Date(date)) : formatDateAr(new Date());
    els.prayerTable.innerHTML = "";

    PRAYER_ORDER.forEach((key) => {
      const p = prayers.find((x) => x.prayer === key) || {
        prayer: key,
        time: "—",
        completed: false,
        completedAt: null
      };
      els.prayerTable.appendChild(buildPrayerRow(p));
    });
  }

  function buildPrayerRow(p) {
    const li = document.createElement("li");
    li.className = "prayer-table-row";

    const name = document.createElement("span");
    name.className = "prayer-name";
    name.textContent = PRAYER_LABELS[p.prayer] || p.prayer;

    const time = document.createElement("span");
    time.className = "prayer-time";
    time.textContent = p.time || "—";

    const stateEl = document.createElement("span");
    stateEl.className = "prayer-state " + (p.completed ? "is-done" : "is-missing");
    stateEl.textContent = p.completed
      ? `مكتملة ${p.completedAt ? "• " + formatTime(p.completedAt) : ""}`
      : "غير مكتملة";

    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "prayer-check" + (p.completed ? " is-done" : "");
    btn.setAttribute("aria-label", p.completed ? "إلغاء إكمال الصلاة" : "تعليم الصلاة كمكتملة");
    btn.disabled = state.busy;
    if (p.completed) btn.appendChild(checkIcon());
    else {
      const dash = document.createElement("span");
      dash.textContent = "—";
      btn.appendChild(dash);
    }

    btn.addEventListener("click", () => togglePrayer(p.prayer, !p.completed));

    li.append(name, time, stateEl, btn);
    return li;
  }

  function renderVisits(visits) {
    els.visitsList.innerHTML = "";
    if (!visits.length) {
      const li = document.createElement("li");
      li.textContent = "لا توجد زيارات مسجلة بعد.";
      els.visitsList.appendChild(li);
      return;
    }
    visits.forEach((v) => {
      const li = document.createElement("li");
      const page = document.createElement("span");
      page.className = "visit-page";
      page.textContent = v.page || "/";

      const time = document.createElement("span");
      time.className = "visit-time";
      time.textContent = formatTime(v.timestamp);

      const device = document.createElement("span");
      device.className = "visit-device";
      device.textContent = v.device || "—";

      li.append(page, time, device);
      els.visitsList.appendChild(li);
    });
  }

  async function loadStats() {
    const data = await apiFetch(`${API}/dashboard/stats`);
    renderStats(data.stats || {});
  }

  async function loadPrayers() {
    const data = await apiFetch(`${API}/prayers/today`);
    renderPrayers(data.prayers || [], data.date);
  }

  async function loadVisits() {
    const data = await apiFetch(`${API}/dashboard/visits?limit=10`);
    renderVisits(data.visits || []);
  }

  async function togglePrayer(prayer, completed) {
    if (state.busy) return;
    state.busy = true;
    renderPrayers(state.prayers);
    try {
      const data = await apiFetch(`${API}/prayers/complete`, {
        method: "POST",
        body: JSON.stringify({ prayer, completed })
      });
      if (data && data.prayers) {
        renderPrayers(data.prayers, data.date);
      } else {
        await loadPrayers();
      }
      await loadStats();
    } catch (err) {
      alert("تعذّر تحديث حالة الصلاة: " + err.message);
      await loadPrayers();
    } finally {
      state.busy = false;
      renderPrayers(state.prayers);
    }
  }

  async function logout() {
    try {
      await fetch(`${API}/auth/logout`, {
        method: "POST",
        credentials: "include"
      });
    } catch (_) {}
    location.replace("/login");
  }

  async function refreshAll() {
    try {
      await Promise.all([loadStats(), loadPrayers(), loadVisits()]);
    } catch (err) {
      if (err.message !== "unauthorized") {
        console.warn("تعذّر تحديث اللوحة:", err.message);
      }
    }
  }

  function startPolling() {
    state.pollTimer = setInterval(refreshAll, POLL_INTERVAL);
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible") refreshAll();
    });
  }

  function bindEvents() {
    if (els.logout) els.logout.addEventListener("click", logout);
  }

  async function init() {
    cacheEls();
    bindEvents();
    await refreshAll();
    startPolling();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
