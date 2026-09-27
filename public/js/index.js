(function () {
  "use strict";

  const SESSION_KEY = "mudhakkir.sessionId";

  function getSessionId() {
    try {
      let id = localStorage.getItem(SESSION_KEY);
      if (!id) {
        id = "s_" + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2, 10);
        localStorage.setItem(SESSION_KEY, id);
      }
      return id;
    } catch (_) {
      return "s_tmp_" + Math.random().toString(36).slice(2, 10);
    }
  }

  function detectDevice() {
    const ua = navigator.userAgent || "";
    if (/Mobi|Android|iPhone|iPad|iPod/i.test(ua)) {
      return /iPad|Tablet/i.test(ua) ? "tablet" : "mobile";
    }
    return "desktop";
  }

  async function apiFetch(path, options = {}) {
    const res = await fetch(path, {
      headers: { "Content-Type": "application/json", ...(options.headers || {}) },
      credentials: "include",
      ...options
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(text || `HTTP ${res.status}`);
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

  function initNav() {
    const toggle = document.querySelector(".nav-toggle");
    const nav = document.getElementById("primary-nav");
    if (!toggle || !nav) return;

    toggle.addEventListener("click", () => {
      const open = nav.classList.toggle("is-open");
      toggle.setAttribute("aria-expanded", open ? "true" : "false");
    });

    nav.addEventListener("click", (e) => {
      if (e.target.tagName === "A" && nav.classList.contains("is-open")) {
        nav.classList.remove("is-open");
        toggle.setAttribute("aria-expanded", "false");
      }
    });
  }

  function renderPrayerRows(prayers) {
    const list = document.getElementById("today-prayers");
    if (!list) return;
    list.innerHTML = "";

    prayers.forEach((p) => {
      const li = document.createElement("li");
      li.className = "prayer-row";

      const name = document.createElement("span");
      name.className = "prayer-name";
      name.textContent = p.name;

      const time = document.createElement("span");
      time.className = "prayer-time";
      time.textContent = p.time || "—";

      li.append(name, time);
      list.appendChild(li);
    });
  }

  function renderPrayerCards(prayers) {
    prayers.forEach((p) => {
      const card = document.querySelector(`.prayer-card[data-prayer="${p.key}"]`);
      if (!card) return;
      const timeEl = card.querySelector("[data-time]");
      if (timeEl) timeEl.textContent = p.time || "—";
    });
  }

  function setSourceLabel(source) {
    const el = document.getElementById("prayer-source");
    if (!el) return;
    el.textContent = source ? `المصدر: ${source}` : "المصدر: غير متاح";
  }

  function normalizeApiTimes(data) {
    const t = data.timings || data;
    return [
      { key: "fajr",    name: "الفجر",   time: t.Fajr    || t.fajr    },
      { key: "dhuhr",   name: "الظهر",   time: t.Dhuhr   || t.dhuhr   },
      { key: "asr",     name: "العصر",   time: t.Asr     || t.asr     },
      { key: "maghrib", name: "المغرب",  time: t.Maghrib || t.maghrib },
      { key: "isha",    name: "العشاء",  time: t.Isha    || t.isha    }
    ];
  }

  function getUserCoords() {
    return new Promise((resolve) => {
      if (!navigator.geolocation) {
        resolve({ lat: 21.4225, lng: 39.8262 });
        return;
      }
      const timer = setTimeout(() => resolve({ lat: 21.4225, lng: 39.8262 }), 4000);
      navigator.geolocation.getCurrentPosition(
        (pos) => {
          clearTimeout(timer);
          resolve({ lat: pos.coords.latitude, lng: pos.coords.longitude });
        },
        () => {
          clearTimeout(timer);
          resolve({ lat: 21.4225, lng: 39.8262 });
        },
        { timeout: 3500 }
      );
    });
  }

  async function loadPrayerTimes() {
    const today = new Date();
    const dateEl = document.getElementById("today-date");
    if (dateEl) dateEl.textContent = formatDateAr(today);

    try {
      const data = await apiFetch("/api/prayers/times");
      const map = normalizeApiTimes(data);
      renderPrayerRows(map);
      renderPrayerCards(map);
      setSourceLabel(data.source || "الخادم");
    } catch (err) {
      try {
        const coords = await getUserCoords();
        const url = `https://api.aladhan.com/v1/timings?latitude=${coords.lat}&longitude=${coords.lng}&method=4`;
        const res = await fetch(url);
        const json = await res.json();
        const map = normalizeApiTimes(json.data);
        renderPrayerRows(map);
        renderPrayerCards(map);
        setSourceLabel("AlAdhan");
      } catch (fallbackErr) {
        setSourceLabel(null);
      }
    }
  }

  async function trackVisit() {
    const payload = {
      sessionId: getSessionId(),
      page: location.pathname || "/",
      device: detectDevice(),
      referrer: document.referrer || null
    };
    try {
      await apiFetch("/api/visits", {
        method: "POST",
        body: JSON.stringify(payload)
      });
    } catch (err) {
      console.warn("تعذّر تسجيل الزيارة:", err.message);
    }
  }

  function initYear() {
    const el = document.getElementById("year");
    if (el) el.textContent = String(new Date().getFullYear());
  }

  function init() {
    initNav();
    initYear();
    loadPrayerTimes();
    trackVisit();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
