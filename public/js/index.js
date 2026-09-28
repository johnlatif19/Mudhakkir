(function () {
  "use strict";

  const PRAYER_ORDER = ["fajr", "dhuhr", "asr", "maghrib", "isha"];
  const PRAYER_LABELS = {
    fajr: "الفجر",
    dhuhr: "الظهر",
    asr: "العصر",
    maghrib: "المغرب",
    isha: "العشاء"
  };
  const SESSION_KEY = "mudhakkir.sessionId";

  const state = {
    user: null,
    times: null,
    prayers: null,
    busy: false,
    pushSubscribed: false,
    pushSupported: false,
    vapidPublicKey: null
  };

  const els = {};

  function cacheEls() {
    els.navAuth = document.getElementById("nav-auth");
    els.navUserName = document.getElementById("nav-user-name");
    els.navLogout = document.getElementById("nav-logout");
    els.heroTitle = document.getElementById("hero-title");
    els.heroLead = document.getElementById("hero-lead");
    els.heroCtaSignup = document.getElementById("hero-cta-signup");
    els.todayPrayers = document.getElementById("today-prayers");
    els.todayDate = document.getElementById("today-date");
    els.prayerSource = document.getElementById("prayer-source");
    els.prayersSubtitle = document.getElementById("prayers-subtitle");
    els.statusBar = document.getElementById("status-bar");
    els.statusCount = document.getElementById("status-count");
    els.btnReset = document.getElementById("btn-reset");
    els.btnEnablePush = document.getElementById("btn-enable-push");
    els.pushNote = document.getElementById("push-note");
    els.grid = document.getElementById("prayer-grid");
    els.toast = document.getElementById("toast");
    els.year = document.getElementById("year");
  }

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
    if (res.status === 401) {
      const err = new Error("unauthorized");
      err.status = 401;
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

  let toastTimer = null;
  function showToast(text, variant) {
    if (!els.toast) return;
    els.toast.textContent = text;
    els.toast.classList.remove("is-error", "is-success");
    if (variant) els.toast.classList.add(variant);
    els.toast.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { els.toast.hidden = true; }, 3200);
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

  function renderAuthUI() {
    const guestEls = els.navAuth.querySelectorAll('[data-when="guest"]');
    const userEls = els.navAuth.querySelectorAll('[data-when="user"]');

    if (state.user) {
      guestEls.forEach((el) => { el.hidden = true; });
      userEls.forEach((el) => { el.hidden = false; });
      els.navUserName.textContent = state.user.name;
      els.heroCtaSignup.hidden = true;
      els.prayersSubtitle.textContent = "علّم كل صلاة بعد أدائها، وتُحفظ حالتك تلقائيًا.";
      els.statusBar.hidden = false;
    } else {
      guestEls.forEach((el) => { el.hidden = false; });
      userEls.forEach((el) => { el.hidden = true; });
      els.heroCtaSignup.hidden = false;
      els.prayersSubtitle.textContent = "سجّل دخولك لتعليم صلواتك ومتابعة التزامك اليومي.";
      els.statusBar.hidden = true;
    }

    renderPrayerLocks();
  }

  function renderPrayerLocks() {
    document.querySelectorAll(".prayer-card").forEach((card) => {
      const action = card.querySelector("[data-action]");
      const locked = card.querySelector("[data-locked]");
      if (state.user) {
        action.hidden = false;
        locked.hidden = true;
      } else {
        action.hidden = true;
        locked.hidden = false;
      }
    });
  }

  function renderHeroTimes(times) {
    if (!els.todayPrayers) return;
    els.todayPrayers.innerHTML = "";
    PRAYER_ORDER.forEach((key) => {
      const li = document.createElement("li");
      li.className = "prayer-row";
      const name = document.createElement("span");
      name.className = "prayer-name";
      name.textContent = PRAYER_LABELS[key];
      const time = document.createElement("span");
      time.className = "prayer-time";
      time.textContent = (times && times[key]) || "—";
      li.append(name, time);
      els.todayPrayers.appendChild(li);
    });
  }

  function renderGridTimes(times) {
    document.querySelectorAll(".prayer-card").forEach((card) => {
      const key = card.dataset.prayer;
      const timeEl = card.querySelector("[data-time]");
      if (timeEl) timeEl.textContent = (times && times[key]) || "—";
    });
  }

  function renderPrayerStates(prayers) {
    state.prayers = prayers;
    const map = new Map((prayers || []).map((p) => [p.prayer, p]));

    let completedCount = 0;

    document.querySelectorAll(".prayer-card").forEach((card) => {
      const key = card.dataset.prayer;
      const p = map.get(key);
      const done = !!(p && p.completed);
      if (done) completedCount += 1;

      card.classList.toggle("is-done", done);

      const btn = card.querySelector("[data-check]");
      if (!btn) return;
      btn.classList.toggle("is-done", done);
      btn.innerHTML = "";
      if (done) {
        btn.appendChild(checkIcon());
        btn.setAttribute("aria-label", `إلغاء تعليم ${PRAYER_LABELS[key]}`);
      } else {
        const span = document.createElement("span");
        span.className = "check-empty";
        span.textContent = "—";
        btn.appendChild(span);
        btn.setAttribute("aria-label", `تعليم ${PRAYER_LABELS[key]}`);
      }
      btn.disabled = state.busy;
    });

    els.statusCount.textContent = String(completedCount);
  }

  function setSourceLabel(source) {
    if (!els.prayerSource) return;
    els.prayerSource.textContent = source ? `المصدر: ${source}` : "المصدر: غير متاح";
  }

  function setPushNote(message, variant) {
    if (!els.pushNote) return;
    if (message) {
      els.pushNote.textContent = message;
      els.pushNote.hidden = false;
      els.pushNote.classList.toggle("is-error", variant === "error");
    } else {
      els.pushNote.hidden = true;
      els.pushNote.classList.remove("is-error");
    }
  }

  function normalizeApiTimes(data) {
    const t = data.timings || data;
    return {
      fajr: t.Fajr || t.fajr,
      dhuhr: t.Dhuhr || t.dhuhr,
      asr: t.Asr || t.asr,
      maghrib: t.Maghrib || t.maghrib,
      isha: t.Isha || t.isha
    };
  }

  async function loadPrayerTimes() {
    const dateEl = els.todayDate;
    if (dateEl) dateEl.textContent = formatDateAr(new Date());

    try {
      const data = await apiFetch("/api/prayers/times");
      const times = normalizeApiTimes(data);
      state.times = times;
      renderHeroTimes(times);
      renderGridTimes(times);
      setSourceLabel(data.source || "الخادم");
    } catch (_) {
      setSourceLabel(null);
    }
  }

  async function loadTodayPrayers() {
    if (!state.user) {
      renderPrayerStates([]);
      return;
    }
    try {
      const data = await apiFetch("/api/prayers/today");
      renderPrayerStates(data.prayers || []);
    } catch (err) {
      if (err.status === 401) {
        state.user = null;
        renderAuthUI();
      }
    }
  }

  async function togglePrayer(prayer, completed) {
    if (state.busy) return;
    state.busy = true;
    document.querySelectorAll("[data-check]").forEach((b) => { b.disabled = true; });
    try {
      const data = await apiFetch("/api/prayers/complete", {
        method: "POST",
        body: JSON.stringify({ prayer, completed })
      });
      renderPrayerStates(data.prayers || []);
      showToast(completed ? "تم تعليم الصلاة كمكتملة" : "تم إلغاء التعليم", "is-success");
    } catch (err) {
      if (err.status === 401) {
        state.user = null;
        renderAuthUI();
        showToast("سجّل دخولك أولًا", "is-error");
      } else {
        showToast("تعذّر تحديث الصلاة: " + err.message, "is-error");
      }
    } finally {
      state.busy = false;
      renderPrayerStates(state.prayers || []);
    }
  }

  async function resetPrayers() {
    if (state.busy) return;
    if (!confirm("هل تريد إعادة كل صلوات اليوم؟")) return;
    state.busy = true;
    els.btnReset.disabled = true;
    try {
      const data = await apiFetch("/api/prayers/reset", { method: "POST" });
      renderPrayerStates(data.prayers || []);
      showToast("تمت إعادة صلوات اليوم", "is-success");
    } catch (err) {
      if (err.status === 401) {
        state.user = null;
        renderAuthUI();
      } else {
        showToast("تعذّرت الإعادة: " + err.message, "is-error");
      }
    } finally {
      state.busy = false;
      els.btnReset.disabled = false;
    }
  }

  async function logout() {
    try {
      await fetch("/api/auth/logout", { method: "POST", credentials: "include" });
    } catch (_) {}
    state.user = null;
    state.prayers = null;
    renderAuthUI();
    renderPrayerStates([]);
    showToast("تم تسجيل الخروج", "is-success");
  }

  async function loadSession() {
    try {
      const data = await apiFetch("/api/auth/me");
      state.user = data.user;
    } catch (_) {
      state.user = null;
    }
    renderAuthUI();
  }

  function urlBase64ToUint8Array(base64String) {
    const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
    const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
    const raw = atob(base64);
    const arr = new Uint8Array(raw.length);
    for (let i = 0; i < raw.length; i += 1) arr[i] = raw.charCodeAt(i);
    return arr;
  }

  async function registerServiceWorker() {
    if (!("serviceWorker" in navigator)) return null;
    try {
      const reg = await navigator.serviceWorker.register("/sw.js", { scope: "/" });
      return reg;
    } catch (_) {
      return null;
    }
  }

  async function checkPushSupport() {
    if (!("serviceWorker" in navigator) || !("PushManager" in window)) {
      state.pushSupported = false;
      return;
    }
    try {
      const cfg = await apiFetch("/api/config");
      state.vapidPublicKey = cfg.vapidPublicKey;
      state.pushSupported = !!cfg.vapidPublicKey;
    } catch (_) {
      state.pushSupported = false;
    }
  }

  async function refreshPushButton() {
    if (!els.btnEnablePush) return;
    if (!state.pushSupported) {
      els.btnEnablePush.disabled = true;
      els.btnEnablePush.textContent = "الإشعارات غير مدعومة";
      if (state.user) setPushNote("متصفحك لا يدعم الإشعارات.", "error");
      return;
    }
    if (!state.user) {
      els.btnEnablePush.disabled = true;
      return;
    }

    try {
      const reg = await navigator.serviceWorker.getRegistration();
      const sub = reg ? await reg.pushManager.getSubscription() : null;
      if (sub) {
        state.pushSubscribed = true;
        els.btnEnablePush.textContent = "الإشعارات مفعّلة";
        els.btnEnablePush.disabled = true;
        setPushNote("ستصلك تنبيهات قبل الصلاة بعشر وخمس دقائق وفي وقتها.", null);
      } else {
        state.pushSubscribed = false;
        els.btnEnablePush.textContent = "تفعيل الإشعارات";
        els.btnEnablePush.disabled = false;
        setPushNote(null);
      }
    } catch (_) {
      els.btnEnablePush.disabled = false;
    }
  }

  async function enablePush() {
    if (!state.user) {
      showToast("سجّل دخولك أولًا", "is-error");
      return;
    }
    if (!state.pushSupported) {
      showToast("متصفحك لا يدعم الإشعارات", "is-error");
      return;
    }

    els.btnEnablePush.disabled = true;
    try {
      const permission = await Notification.requestPermission();
      if (permission !== "granted") {
        setPushNote("الإشعارات معطّلة، فعّلها من إعدادات المتصفح.", "error");
        els.btnEnablePush.disabled = false;
        return;
      }

      const reg = await registerServiceWorker();
      if (!reg) throw new Error("service worker failed");

      await navigator.serviceWorker.ready;

      let sub = await reg.pushManager.getSubscription();
      if (!sub) {
        sub = await reg.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: urlBase64ToUint8Array(state.vapidPublicKey)
        });
      }

      await apiFetch("/api/push/subscribe", {
        method: "POST",
        body: JSON.stringify({ subscription: sub.toJSON ? sub.toJSON() : sub })
      });

      state.pushSubscribed = true;
      els.btnEnablePush.textContent = "الإشعارات مفعّلة";
      setPushNote("تم تفعيل الإشعارات. ستصلك تنبيهات قبل الصلاة.", null);
      showToast("تم تفعيل الإشعارات", "is-success");
    } catch (err) {
      setPushNote("تعذّر تفعيل الإشعارات. حاول مرة أخرى.", "error");
      els.btnEnablePush.disabled = false;
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
      await apiFetch("/api/visits", { method: "POST", body: JSON.stringify(payload) });
    } catch (_) {}
  }

  function bindGridEvents() {
    document.querySelectorAll(".prayer-card").forEach((card) => {
      const btn = card.querySelector("[data-check]");
      if (!btn) return;
      btn.addEventListener("click", () => {
        if (!state.user) {
          showToast("سجّل دخولك أولًا", "is-error");
          return;
        }
        const key = card.dataset.prayer;
        const p = (state.prayers || []).find((x) => x.prayer === key);
        const currentlyDone = !!(p && p.completed);
        togglePrayer(key, !currentlyDone);
      });
    });
  }

  function bindEvents() {
    if (els.navLogout) els.navLogout.addEventListener("click", logout);
    if (els.btnReset) els.btnReset.addEventListener("click", resetPrayers);
    if (els.btnEnablePush) els.btnEnablePush.addEventListener("click", enablePush);
  }

  function initYear() {
    if (els.year) els.year.textContent = String(new Date().getFullYear());
  }

  async function init() {
    cacheEls();
    initNav();
    initYear();
    bindEvents();
    bindGridEvents();

    registerServiceWorker();
    await checkPushSupport();
    await loadSession();
    await loadPrayerTimes();
    await loadTodayPrayers();
    await refreshPushButton();

    trackVisit();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
