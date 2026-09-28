(function () {
  "use strict";

  const API = "/api/messages";
  const POLL_INTERVAL = 3000;

  const state = {
    currentUser: null,
    messages: [],
    polling: null,
    editingId: null,
    pendingDeleteId: null,
    sending: false
  };

  const els = {};

  function cacheEls() {
    els.gate = document.getElementById("gate");
    els.panel = document.getElementById("chat-panel");
    els.messages = document.getElementById("messages");
    els.emptyState = document.getElementById("empty-state");
    els.form = document.getElementById("composer");
    els.input = document.getElementById("message-input");
    els.sendBtn = document.getElementById("send-btn");
    els.status = document.getElementById("connection-status");
    els.modal = document.getElementById("confirm-modal");
    els.modalMsg = document.getElementById("confirm-message");
    els.confirmOk = document.getElementById("confirm-ok");
    els.confirmCancel = document.getElementById("confirm-cancel");
    els.logout = document.getElementById("logout-btn");
    els.toast = document.getElementById("toast");
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
    if (res.status === 204) return null;
    const ct = res.headers.get("content-type") || "";
    return ct.includes("application/json") ? res.json() : res.text();
  }

  function setStatus(text, variant) {
    if (!els.status) return;
    els.status.textContent = text;
    els.status.classList.remove("is-online", "is-offline");
    if (variant) els.status.classList.add(variant);
  }

  function formatTime(iso) {
    if (!iso) return "";
    try {
      return new Intl.DateTimeFormat("ar", {
        hour: "2-digit",
        minute: "2-digit"
      }).format(new Date(iso));
    } catch (_) {
      return "";
    }
  }

  function formatDay(iso) {
    try {
      return new Intl.DateTimeFormat("ar", {
        weekday: "long",
        day: "numeric",
        month: "long",
        year: "numeric"
      }).format(new Date(iso));
    } catch (_) {
      return "";
    }
  }

  function dayKey(iso) {
    const d = new Date(iso);
    return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
  }

  function sameDay(a, b) {
    const da = new Date(a), db = new Date(b);
    return da.toDateString() === db.toDateString();
  }

  function isMine(msg) {
    return state.currentUser && msg.senderId === state.currentUser.id;
  }

  let toastTimer = null;
  function showToast(text, variant) {
    if (!els.toast) return;
    els.toast.textContent = text;
    els.toast.classList.remove("is-error", "is-success");
    if (variant) els.toast.classList.add(variant);
    els.toast.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { els.toast.hidden = true; }, 3000);
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

  function renderAll() {
    const container = els.messages;
    if (!container) return;
    container.innerHTML = "";

    if (!state.messages.length) {
      els.emptyState.hidden = false;
      return;
    }
    els.emptyState.hidden = true;

    let lastDay = null;
    state.messages.forEach((msg) => {
      const key = dayKey(msg.createdAt);
      if (key !== lastDay) {
        lastDay = key;
        const sep = document.createElement("div");
        sep.className = "date-separator";
        sep.textContent = sameDay(msg.createdAt, new Date())
          ? "اليوم"
          : formatDay(msg.createdAt);
        container.appendChild(sep);
      }
      container.appendChild(buildMessageNode(msg));
    });

    scrollToBottom();
  }

  function buildMessageNode(msg) {
    const mine = isMine(msg);
    const wrap = document.createElement("article");
    wrap.className = "message " + (mine ? "out" : "in");
    wrap.dataset.id = msg.id;

    if (!mine && msg.senderName) {
      const sender = document.createElement("span");
      sender.className = "message-sender";
      sender.textContent = msg.senderName;
      wrap.appendChild(sender);
    }

    const text = document.createElement("p");
    text.className = "message-text";
    if (msg.deletedAt) {
      wrap.classList.add("is-deleted");
      text.textContent = "تم حذف هذه الرسالة";
    } else {
      text.textContent = msg.text;
    }
    wrap.appendChild(text);

    const meta = document.createElement("div");
    meta.className = "message-meta";

    const time = document.createElement("span");
    time.className = "message-time";
    time.textContent = formatTime(msg.createdAt);
    meta.appendChild(time);

    if (msg.updatedAt && !msg.deletedAt) {
      const edited = document.createElement("span");
      edited.className = "edited-flag";
      edited.textContent = "معدّلة";
      meta.appendChild(edited);
    }

    wrap.appendChild(meta);

    if (mine && !msg.deletedAt) {
      if (state.editingId === msg.id) {
        wrap.appendChild(buildEditor(msg));
      } else {
        wrap.appendChild(buildActions(msg));
      }
    }

    return wrap;
  }

  function buildActions(msg) {
    const actions = document.createElement("div");
    actions.className = "message-actions";

    const editBtn = document.createElement("button");
    editBtn.type = "button";
    editBtn.className = "message-action";
    editBtn.textContent = "تعديل";
    editBtn.addEventListener("click", () => {
      state.editingId = msg.id;
      renderAll();
      const ta = els.messages.querySelector(`.message[data-id="${msg.id}"] textarea`);
      if (ta) {
        ta.focus();
        ta.setSelectionRange(ta.value.length, ta.value.length);
      }
    });

    const delBtn = document.createElement("button");
    delBtn.type = "button";
    delBtn.className = "message-action danger";
    delBtn.textContent = "حذف";
    delBtn.addEventListener("click", () => openConfirm(msg.id));

    actions.append(editBtn, delBtn);
    return actions;
  }

  function buildEditor(msg) {
    const editor = document.createElement("div");
    editor.className = "message-editor";

    const ta = document.createElement("textarea");
    ta.value = msg.text;
    ta.maxLength = 2000;

    const actions = document.createElement("div");
    actions.className = "message-editor-actions";

    const cancel = document.createElement("button");
    cancel.type = "button";
    cancel.className = "btn btn-ghost btn-sm";
    cancel.textContent = "إلغاء";
    cancel.addEventListener("click", () => {
      state.editingId = null;
      renderAll();
    });

    const save = document.createElement("button");
    save.type = "button";
    save.className = "btn btn-primary btn-sm";
    save.textContent = "حفظ";
    save.addEventListener("click", () => saveEdit(msg.id, ta.value));

    ta.addEventListener("keydown", (e) => {
      if (e.key === "Escape") {
        e.preventDefault();
        state.editingId = null;
        renderAll();
      }
      if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        saveEdit(msg.id, ta.value);
      }
    });

    actions.append(cancel, save);
    editor.append(ta, actions);
    return editor;
  }

  function openConfirm(id) {
    state.pendingDeleteId = id;
    els.modalMsg.textContent = "سيتم حذف الرسالة نهائيًا. هل تريد المتابعة؟";
    els.modal.hidden = false;
    els.confirmOk.focus();
  }

  function closeConfirm() {
    state.pendingDeleteId = null;
    els.modal.hidden = true;
  }

  function scrollToBottom() {
    const c = els.messages;
    if (c) c.scrollTop = c.scrollHeight;
  }

  function autoGrow() {
    const ta = els.input;
    if (!ta) return;
    ta.style.height = "auto";
    ta.style.height = Math.min(ta.scrollHeight, 140) + "px";
  }

  function mergeMessages(incoming) {
    const map = new Map(state.messages.map((m) => [m.id, m]));
    incoming.forEach((m) => map.set(m.id, m));
    state.messages = Array.from(map.values()).sort(
      (a, b) => new Date(a.createdAt) - new Date(b.createdAt)
    );
  }

  async function loadInitial() {
    try {
      const data = await apiFetch(API);
      state.messages = data.messages || [];
      renderAll();
      setStatus("متصل", "is-online");
    } catch (err) {
      if (err.status === 401) {
        showGate();
        return;
      }
      setStatus("تعذّر الاتصال", "is-offline");
    }
  }

  async function pollNew() {
    if (!state.currentUser) return;
    try {
      const since = state.messages.length
        ? state.messages[state.messages.length - 1].createdAt
        : null;
      const url = since ? `${API}?since=${encodeURIComponent(since)}` : API;
      const data = await apiFetch(url);
      const incoming = data.messages || [];
      if (incoming.length) {
        mergeMessages(incoming);
        renderAll();
      }
      setStatus("متصل", "is-online");
    } catch (err) {
      if (err.status === 401) {
        showGate();
        return;
      }
      setStatus("انقطع الاتصال", "is-offline");
    }
  }

  async function sendMessage(text) {
    const trimmed = text.trim();
    if (!trimmed || state.sending) return;
    state.sending = true;
    els.sendBtn.disabled = true;
    try {
      const data = await apiFetch(API, {
        method: "POST",
        body: JSON.stringify({ text: trimmed })
      });
      if (data && data.message) {
        mergeMessages([data.message]);
        renderAll();
      }
      els.input.value = "";
      autoGrow();
    } catch (err) {
      if (err.status === 401) {
        showGate();
      } else {
        showToast("تعذّر إرسال الرسالة: " + err.message, "is-error");
      }
    } finally {
      state.sending = false;
      els.sendBtn.disabled = false;
      els.input.focus();
    }
  }

  async function saveEdit(id, text) {
    const trimmed = text.trim();
    if (!trimmed) return;
    try {
      const data = await apiFetch(`${API}/${encodeURIComponent(id)}`, {
        method: "PATCH",
        body: JSON.stringify({ text: trimmed })
      });
      if (data && data.message) {
        mergeMessages([data.message]);
      }
      state.editingId = null;
      renderAll();
      showToast("تم تعديل الرسالة", "is-success");
    } catch (err) {
      showToast("تعذّر تعديل الرسالة: " + err.message, "is-error");
    }
  }

  async function deleteMessage(id) {
    try {
      await apiFetch(`${API}/${encodeURIComponent(id)}`, { method: "DELETE" });
      const msg = state.messages.find((m) => m.id === id);
      if (msg) {
        msg.deletedAt = new Date().toISOString();
        msg.text = "";
      }
      renderAll();
      showToast("تم حذف الرسالة", "is-success");
    } catch (err) {
      showToast("تعذّر حذف الرسالة: " + err.message, "is-error");
    }
  }

  async function logout() {
    try {
      await fetch("/api/auth/logout", { method: "POST", credentials: "include" });
    } catch (_) {}
    location.replace("/");
  }

  function showGate() {
    state.currentUser = null;
    if (state.polling) clearInterval(state.polling);
    els.gate.hidden = false;
    els.panel.hidden = true;
    els.logout.hidden = true;
  }

  function showChat() {
    els.gate.hidden = true;
    els.panel.hidden = false;
    els.logout.hidden = false;
  }

  async function loadSession() {
    try {
      const data = await apiFetch("/api/auth/me");
      state.currentUser = data.user;
      return true;
    } catch (_) {
      state.currentUser = null;
      return false;
    }
  }

  function bindEvents() {
    els.form.addEventListener("submit", (e) => {
      e.preventDefault();
      sendMessage(els.input.value);
    });

    els.input.addEventListener("input", autoGrow);
    els.input.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        els.form.requestSubmit();
      }
    });

    els.confirmCancel.addEventListener("click", closeConfirm);
    els.confirmOk.addEventListener("click", () => {
      const id = state.pendingDeleteId;
      closeConfirm();
      if (id) deleteMessage(id);
    });
    els.modal.addEventListener("click", (e) => {
      if (e.target === els.modal) closeConfirm();
    });
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && !els.modal.hidden) closeConfirm();
    });

    if (els.logout) els.logout.addEventListener("click", logout);
  }

  function startPolling() {
    if (state.polling) clearInterval(state.polling);
    state.polling = setInterval(pollNew, POLL_INTERVAL);
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible") pollNew();
    });
  }

  async function init() {
    cacheEls();
    bindEvents();
    autoGrow();

    const ok = await loadSession();
    if (!ok) {
      showGate();
      return;
    }

    showChat();
    await loadInitial();
    startPolling();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
