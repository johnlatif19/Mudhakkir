(function () {
  "use strict";

  const API = "/api";
  const POLL_INTERVAL = 5000;

  const PRAYER_KEYS = ["fajr", "dhuhr", "asr", "maghrib", "isha"];

  const state = {
    pollTimer: null
  };

  const els = {};

  function cacheEls() {
    els.totalVisitors = document.getElementById("stat-total-visitors");
    els.todayVisitors = document.getElementById("stat-today-visitors");
    els.weekVisitors = document.getElementById("stat-week-visitors");
    els.totalUsers = document.getElementById("stat-total-users");
    els.completedPrayers = document.getElementById("stat-completed-prayers");
    els.usersTbody = document.getElementById("users-tbody");
    els.usersDate = document.getElementById("users-date");
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
      location.replace("/login-admin");
      const err = new Error("unauthorized");
      err.status = 401;
      throw err;
    }
    if (res.status === 403) {
      location.replace("/");
      const err = new Error("forbidden");
      err.status = 403;
      throw err;
    }
    if (!res.ok) {
      let message = `HTTP ${res.status}`;
      try {
        const data = await res.json();
        if (data && data.error) message = data.error;
      } catch (_) {}
      const err = new Error(message);
      err.status = res.status;
      throw err;
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
    svg.setAttribute("stroke-width", "2.6");
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
    els.totalUsers.textContent = String(stats.totalUsers ?? 0);
    els.completedPrayers.textContent = String(stats.completedPrayersToday ?? 0);
  }

  function renderUsers(users, date) {
    els.usersDate.textContent = date ? formatDateAr(new Date(date)) : formatDateAr(new Date());
    els.usersTbody.innerHTML = "";

    if (!users.length) {
      const tr = document.createElement("tr");
      const td = document.createElement("td");
      td.colSpan = 7;
      td.className = "table-empty";
      td.textContent = "لا يوجد مستخدمون مسجّلون بعد.";
      tr.appendChild(td);
      els.usersTbody.appendChild(tr);
      return;
    }

    users.forEach((u) => {
      const tr = document.createElement("tr");

      const nameTd = document.createElement("td");
      nameTd.className = "cell-name";
      nameTd.textContent = u.name;
      tr.appendChild(nameTd);

      PRAYER_KEYS.forEach((key) => {
        const td = document.createElement("td");
        const mark = document.createElement("span");
        const done = !!u.prayers[key];
        mark.className = "mark" + (done ? " is-done" : "");
        if (done) mark.appendChild(checkIcon());
        else mark.textContent = "—";
        td.appendChild(mark);
        tr.appendChild(td);
      });

      const countTd = document.createElement("td");
      countTd.className = "cell-count";
      countTd.textContent = `${u.completedCount} / ${PRAYER_KEYS.length}`;
      tr.appendChild(countTd);

      els.usersTbody.appendChild(tr);
    });
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

  async function loadUsers() {
    const data = await apiFetch(`${API}/dashboard/users`);
    renderUsers(data.users || [], data.date);
  }

  async function loadVisits() {
    const data = await apiFetch(`${API}/dashboard/visits?limit=10`);
    renderVisits(data.visits || []);
  }

  async function logout() {
    try {
      await fetch(`${API}/auth/logout`, {
        method: "POST",
        credentials: "include"
      });
    } catch (_) {}
    location.replace("/login-admin");
  }

  async function refreshAll() {
    try {
      await Promise.all([loadStats(), loadUsers(), loadVisits()]);
    } catch (err) {
      if (err.status !== 401 && err.status !== 403) {
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
