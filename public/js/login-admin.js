(function () {
  "use strict";

  const els = {};

  function cacheEls() {
    els.form = document.getElementById("admin-login-form");
    els.username = document.getElementById("username");
    els.password = document.getElementById("password");
    els.usernameError = document.getElementById("username-error");
    els.passwordError = document.getElementById("password-error");
    els.formError = document.getElementById("form-error");
    els.submit = document.getElementById("submit-btn");
    els.toggle = document.getElementById("password-toggle");
  }

  function setFieldError(input, errorEl, message) {
    const field = input.closest(".field");
    if (message) {
      field.classList.add("has-error");
      errorEl.textContent = message;
      errorEl.hidden = false;
    } else {
      field.classList.remove("has-error");
      errorEl.textContent = "";
      errorEl.hidden = true;
    }
  }

  function setFormError(message) {
    if (!els.formError) return;
    if (message) {
      els.formError.textContent = message;
      els.formError.hidden = false;
    } else {
      els.formError.textContent = "";
      els.formError.hidden = true;
    }
  }

  function setLoading(loading) {
    els.submit.disabled = loading;
    els.submit.classList.toggle("is-loading", loading);
  }

  function validate() {
    let ok = true;
    const username = els.username.value.trim();
    const password = els.password.value;

    if (username.length < 3) {
      setFieldError(els.username, els.usernameError, "أدخل اسم المستخدم.");
      ok = false;
    } else {
      setFieldError(els.username, els.usernameError, "");
    }

    if (password.length < 4) {
      setFieldError(els.password, els.passwordError, "كلمة المرور يجب ألا تقل عن 4 أحرف.");
      ok = false;
    } else {
      setFieldError(els.password, els.passwordError, "");
    }

    return ok;
  }

  async function submit(e) {
    e.preventDefault();
    setFormError("");
    if (!validate()) return;

    setLoading(true);
    try {
      const res = await fetch("/api/auth/login-admin", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({
          username: els.username.value.trim(),
          password: els.password.value
        })
      });

      if (!res.ok) {
        let message = "بيانات الدخول غير صحيحة.";
        try {
          const data = await res.json();
          if (data && data.error) message = data.error;
        } catch (_) {}
        setFormError(message);
        return;
      }

      location.replace("/dashboard");
    } catch (err) {
      setFormError("تعذّر الاتصال بالخدمة. حاول مرة أخرى.");
    } finally {
      setLoading(false);
    }
  }

  function togglePassword() {
    const isPwd = els.password.type === "password";
    els.password.type = isPwd ? "text" : "password";
    els.toggle.textContent = isPwd ? "إخفاء" : "إظهار";
    els.toggle.setAttribute("aria-label", isPwd ? "إخفاء كلمة المرور" : "إظهار كلمة المرور");
    els.password.focus();
  }

  async function checkSession() {
    try {
      const res = await fetch("/api/auth/me", { credentials: "include" });
      if (res.ok) {
        const data = await res.json();
        if (data && data.user && data.user.role === "admin") {
          location.replace("/dashboard");
        }
      }
    } catch (_) {}
  }

  function init() {
    cacheEls();
    els.form.addEventListener("submit", submit);
    els.toggle.addEventListener("click", togglePassword);
    els.username.addEventListener("input", () => setFieldError(els.username, els.usernameError, ""));
    els.password.addEventListener("input", () => setFieldError(els.password, els.passwordError, ""));
    checkSession();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
