"use strict";

require("dotenv").config();

const path = require("path");
const express = require("express");
const helmet = require("helmet");
const cors = require("cors");
const cookieParser = require("cookie-parser");
const rateLimit = require("express-rate-limit");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const admin = require("firebase-admin");
const webpush = require("web-push");
const cloudinary = require("cloudinary").v2;

const PORT = process.env.PORT || 3000;
const NODE_ENV = process.env.NODE_ENV || "development";
const IS_PROD = NODE_ENV === "production";

const JWT_SECRET = process.env.JWT_SECRET;
const ADMIN_USERNAME = process.env.ADMIN_USERNAME;
const ADMIN_PASSWORD_HASH = process.env.ADMIN_PASSWORD_HASH;
const CRON_SECRET = process.env.CRON_SECRET;

const VAPID_PUBLIC_KEY = process.env.VAPID_PUBLIC_KEY;
const VAPID_PRIVATE_KEY = process.env.VAPID_PRIVATE_KEY;
const VAPID_SUBJECT = process.env.VAPID_SUBJECT || "mailto:admin@example.com";

const COOKIE_NAME = "mudhakkir_token";
const TOKEN_TTL = "7d";

const PRAYER_KEYS = ["fajr", "dhuhr", "asr", "maghrib", "isha"];
const PRAYER_LABELS_AR = {
  fajr: "الفجر",
  dhuhr: "الظهر",
  asr: "العصر",
  maghrib: "المغرب",
  isha: "العشاء"
};

const DEFAULT_COORDS = { lat: 21.4225, lng: 39.8262 };
const PRAYER_CACHE_TTL_MS = 30 * 60 * 1000;
const prayerCache = new Map();

if (!JWT_SECRET || !ADMIN_USERNAME || !ADMIN_PASSWORD_HASH) {
  console.error("Missing required environment variables: JWT_SECRET, ADMIN_USERNAME, ADMIN_PASSWORD_HASH");
  process.exit(1);
}

if (!VAPID_PUBLIC_KEY || !VAPID_PRIVATE_KEY) {
  console.warn("VAPID keys missing — push notifications disabled.");
}

if (!CRON_SECRET) {
  console.warn("CRON_SECRET missing — /api/push/check will reject all requests.");
}

function initFirebase() {
  if (admin.apps.length) return admin.app();

  const raw = process.env.FIREBASE_SERVICE_ACCOUNT;
  if (!raw) {
    console.error("Missing FIREBASE_SERVICE_ACCOUNT environment variable.");
    process.exit(1);
  }

  let serviceAccount;
  try {
    serviceAccount = JSON.parse(raw);
  } catch (_) {
    console.error("FIREBASE_SERVICE_ACCOUNT is not valid JSON.");
    process.exit(1);
  }

  if (serviceAccount.private_key) {
    serviceAccount.private_key = serviceAccount.private_key.replace(/\\n/g, "\n");
  }

  return admin.initializeApp({
    credential: admin.credential.cert(serviceAccount)
  });
}

initFirebase();
const db = admin.firestore();

if (VAPID_PUBLIC_KEY && VAPID_PRIVATE_KEY) {
  webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);
}

if (process.env.CLOUDINARY_CLOUD_NAME) {
  cloudinary.config({
    cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
    api_key: process.env.CLOUDINARY_API_KEY,
    api_secret: process.env.CLOUDINARY_API_SECRET,
    secure: true
  });
}

const app = express();
app.set("trust proxy", 1);

app.use(helmet({
  contentSecurityPolicy: false,
  crossOriginResourcePolicy: { policy: "cross-origin" }
}));

app.use(cors({ origin: true, credentials: true }));
app.use(express.json({ limit: "64kb" }));
app.use(cookieParser());

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "محاولات كثيرة. حاول لاحقًا." }
});

const writeLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 80,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "عدد الطلبات كبير. حاول بعد قليل." }
});

function signToken(payload) {
  return jwt.sign(payload, JWT_SECRET, { expiresIn: TOKEN_TTL });
}

function setAuthCookie(res, token) {
  res.cookie(COOKIE_NAME, token, {
    httpOnly: true,
    secure: IS_PROD,
    sameSite: "lax",
    maxAge: 7 * 24 * 60 * 60 * 1000,
    path: "/"
  });
}

function clearAuthCookie(res) {
  res.clearCookie(COOKIE_NAME, { path: "/" });
}

function readToken(req) {
  const fromCookie = req.cookies && req.cookies[COOKIE_NAME];
  if (fromCookie) return fromCookie;
  const header = req.headers.authorization || "";
  if (header.startsWith("Bearer ")) return header.slice(7);
  return null;
}

function authenticate(req, res, next) {
  const token = readToken(req);
  if (!token) return res.status(401).json({ error: "غير مصرّح." });
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    req.user = { id: payload.sub, name: payload.name, role: payload.role };
    return next();
  } catch (_) {
    return res.status(401).json({ error: "انتهت الجلسة. أعد الدخول." });
  }
}

function optionalAuth(req, _res, next) {
  const token = readToken(req);
  if (!token) return next();
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    req.user = { id: payload.sub, name: payload.name, role: payload.role };
  } catch (_) {}
  return next();
}

function requireAdmin(req, res, next) {
  if (!req.user || req.user.role !== "admin") {
    return res.status(403).json({ error: "ممنوع." });
  }
  return next();
}

function sanitizeText(value, max = 2000) {
  if (typeof value !== "string") return "";
  return value.replace(/\u0000/g, "").trim().slice(0, max);
}

function normalizeName(name) {
  return sanitizeText(name, 40).replace(/\s+/g, " ").toLowerCase();
}

function nameToId(nameLower) {
  return nameLower.replace(/[^a-z0-9\u0600-\u06FF]/g, "_").slice(0, 80);
}

function todayKey(date = new Date()) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function weekStart(date = new Date()) {
  const d = new Date(date);
  const day = d.getDay();
  const diff = (day + 1) % 7;
  d.setDate(d.getDate() - diff);
  d.setHours(0, 0, 0, 0);
  return d;
}

async function fetchTimingsFromAlAdhan(lat, lng, dateKey) {
  const url = `https://api.aladhan.com/v1/timings/${dateKey}?latitude=${lat}&longitude=${lng}&method=4`;
  const res = await fetch(url);
  if (!res.ok) throw new Error("prayer_api_failed");
  const json = await res.json();
  const t = json && json.data && json.data.timings;
  if (!t) throw new Error("prayer_api_bad_payload");
  return {
    fajr: t.Fajr,
    dhuhr: t.Dhuhr,
    asr: t.Asr,
    maghrib: t.Maghrib,
    isha: t.Isha
  };
}

async function getPrayerTimes(lat, lng) {
  const dateKey = todayKey();
  const cacheKey = `${dateKey}:${lat.toFixed(2)}:${lng.toFixed(2)}`;
  const cached = prayerCache.get(cacheKey);
  if (cached && Date.now() - cached.at < PRAYER_CACHE_TTL_MS) {
    return cached.data;
  }
  const data = await fetchTimingsFromAlAdhan(lat, lng, dateKey);
  prayerCache.set(cacheKey, { at: Date.now(), data });
  return data;
}

function buildPrayersPayload(times, recordsMap) {
  return PRAYER_KEYS.map((key) => {
    const rec = recordsMap.get(key);
    return {
      prayer: key,
      label: PRAYER_LABELS_AR[key],
      time: times[key] || null,
      completed: !!(rec && rec.completed),
      completedAt: rec && rec.completedAt ? rec.completedAt.toDate().toISOString() : null
    };
  });
}

async function loadRecordsMap(userId, dateKey) {
  const snap = await db.collection("prayer_records")
    .where("userId", "==", userId)
    .where("date", "==", dateKey)
    .get();
  const map = new Map();
  snap.forEach((doc) => {
    const data = doc.data();
    map.set(data.prayer, data);
  });
  return map;
}

function serializeMessage(id, data) {
  return {
    id,
    senderId: data.senderId,
    senderName: data.senderName,
    text: data.deletedAt ? "" : (data.text || ""),
    createdAt: data.createdAt && data.createdAt.toDate ? data.createdAt.toDate().toISOString() : null,
    updatedAt: data.updatedAt && data.updatedAt.toDate ? data.updatedAt.toDate().toISOString() : null,
    deletedAt: data.deletedAt && data.deletedAt.toDate ? data.deletedAt.toDate().toISOString() : null
  };
}

async function ensureAdminSeed() {
  try {
    const adminId = nameToId(ADMIN_USERNAME.toLowerCase());
    const ref = db.collection("users").doc(adminId);
    const doc = await ref.get();
    if (!doc.exists) {
      await ref.set({
        id: adminId,
        name: ADMIN_USERNAME,
        nameLower: ADMIN_USERNAME.toLowerCase(),
        passwordHash: ADMIN_PASSWORD_HASH,
        role: "admin",
        createdAt: admin.firestore.FieldValue.serverTimestamp()
      });
      console.log("Admin user seeded:", adminId);
    }
  } catch (err) {
    console.error("admin seed error:", err.message);
  }
}

ensureAdminSeed();

app.get("/api/health", (_req, res) => {
  res.json({ ok: true });
});

app.get("/api/config", (_req, res) => {
  res.json({ vapidPublicKey: VAPID_PUBLIC_KEY || null });
});

app.post("/api/auth/signup", loginLimiter, async (req, res) => {
  try {
    const name = sanitizeText(req.body && req.body.name, 40);
    const password = typeof (req.body && req.body.password) === "string" ? req.body.password : "";

    if (name.length < 2) {
      return res.status(400).json({ error: "الاسم قصير جدًا." });
    }
    if (password.length < 6) {
      return res.status(400).json({ error: "كلمة المرور يجب ألا تقل عن 6 أحرف." });
    }

    const nameLower = normalizeName(name);
    const userId = nameToId(nameLower);

    const ref = db.collection("users").doc(userId);
    const existing = await ref.get();
    if (existing.exists) {
      return res.status(409).json({ error: "الاسم مستخدم بالفعل. جرّب اسمًا آخر." });
    }

    const passwordHash = await bcrypt.hash(password, 10);

    await ref.set({
      id: userId,
      name,
      nameLower,
      passwordHash,
      role: "user",
      createdAt: admin.firestore.FieldValue.serverTimestamp()
    });

    const token = signToken({ sub: userId, name, role: "user" });
    setAuthCookie(res, token);

    return res.status(201).json({ user: { id: userId, name, role: "user" } });
  } catch (err) {
    console.error("signup error:", err.message);
    return res.status(500).json({ error: "تعذّر إنشاء الحساب." });
  }
});

app.post("/api/auth/login", loginLimiter, async (req, res) => {
  try {
    const name = sanitizeText(req.body && req.body.name, 40);
    const password = typeof (req.body && req.body.password) === "string" ? req.body.password : "";

    if (!name || !password) {
      return res.status(400).json({ error: "أدخل الاسم وكلمة المرور." });
    }

    const nameLower = normalizeName(name);
    const userId = nameToId(nameLower);
    const ref = db.collection("users").doc(userId);
    const doc = await ref.get();

    if (!doc.exists) {
      return res.status(401).json({ error: "الاسم أو كلمة المرور غير صحيحة." });
    }

    const data = doc.data();
    if (data.role === "admin") {
      return res.status(403).json({ error: "استخدم صفحة دخول الأدمن." });
    }

    const ok = await bcrypt.compare(password, data.passwordHash);
    if (!ok) {
      return res.status(401).json({ error: "الاسم أو كلمة المرور غير صحيحة." });
    }

    const token = signToken({ sub: data.id, name: data.name, role: data.role });
    setAuthCookie(res, token);

    return res.json({ user: { id: data.id, name: data.name, role: data.role } });
  } catch (err) {
    console.error("login error:", err.message);
    return res.status(500).json({ error: "تعذّر تسجيل الدخول." });
  }
});

app.post("/api/auth/login-admin", loginLimiter, async (req, res) => {
  try {
    const username = sanitizeText(req.body && req.body.username, 40);
    const password = typeof (req.body && req.body.password) === "string" ? req.body.password : "";

    if (!username || !password) {
      return res.status(400).json({ error: "أدخل اسم المستخدم وكلمة المرور." });
    }

    const userId = nameToId(username.toLowerCase());
    const ref = db.collection("users").doc(userId);
    const doc = await ref.get();

    if (!doc.exists) {
      return res.status(401).json({ error: "بيانات الدخول غير صحيحة." });
    }

    const data = doc.data();
    if (data.role !== "admin") {
      return res.status(403).json({ error: "هذا الحساب ليس أدمن." });
    }

    const ok = await bcrypt.compare(password, data.passwordHash);
    if (!ok) {
      return res.status(401).json({ error: "بيانات الدخول غير صحيحة." });
    }

    const token = signToken({ sub: data.id, name: data.name, role: "admin" });
    setAuthCookie(res, token);

    return res.json({ user: { id: data.id, name: data.name, role: "admin" } });
  } catch (err) {
    console.error("admin login error:", err.message);
    return res.status(500).json({ error: "تعذّر تسجيل الدخول." });
  }
});

app.post("/api/auth/logout", (req, res) => {
  clearAuthCookie(res);
  res.json({ ok: true });
});

app.get("/api/auth/me", optionalAuth, (req, res) => {
  if (!req.user) return res.status(401).json({ error: "غير مصرّح." });
  res.json({ user: req.user });
});

app.post("/api/visits", writeLimiter, async (req, res) => {
  try {
    const sessionId = sanitizeText(req.body && req.body.sessionId, 64);
    const page = sanitizeText(req.body && req.body.page, 200) || "/";
    const device = sanitizeText(req.body && req.body.device, 32) || "unknown";
    const referrer = sanitizeText(req.body && req.body.referrer, 300) || null;
    const userAgent = sanitizeText(req.headers["user-agent"] || "", 300) || null;

    if (!sessionId) return res.status(400).json({ error: "sessionId مطلوب." });

    const dayKey = todayKey();
    const dedupeId = `${sessionId}_${dayKey}_${page}`.replace(/[^A-Za-z0-9_\-]/g, "_").slice(0, 200);
    const ref = db.collection("visits").doc(dedupeId);
    const existing = await ref.get();

    if (!existing.exists) {
      await ref.set({
        sessionId,
        page,
        device,
        referrer,
        userAgent,
        timestamp: admin.firestore.FieldValue.serverTimestamp(),
        dayKey
      });
    }

    return res.status(201).json({ ok: true });
  } catch (err) {
    console.error("visits error:", err.message);
    return res.status(500).json({ error: "تعذّر تسجيل الزيارة." });
  }
});

app.get("/api/prayers/times", async (req, res) => {
  try {
    const lat = parseFloat(req.query.lat) || DEFAULT_COORDS.lat;
    const lng = parseFloat(req.query.lng) || DEFAULT_COORDS.lng;
    const timings = await getPrayerTimes(lat, lng);
    return res.json({ timings, source: "AlAdhan", date: todayKey() });
  } catch (err) {
    console.error("prayer times error:", err.message);
    return res.status(502).json({ error: "تعذّر جلب المواقيت." });
  }
});

app.get("/api/prayers/today", authenticate, async (req, res) => {
  try {
    const dateKey = todayKey();
    const userId = req.user.id;

    const [times, recordsMap] = await Promise.all([
      getPrayerTimes(DEFAULT_COORDS.lat, DEFAULT_COORDS.lng),
      loadRecordsMap(userId, dateKey)
    ]);

    const prayers = buildPrayersPayload(times, recordsMap);
    return res.json({ date: dateKey, prayers });
  } catch (err) {
    console.error("prayers today error:", err.message);
    return res.status(500).json({ error: "تعذّر جلب الصلوات." });
  }
});

app.post("/api/prayers/complete", authenticate, writeLimiter, async (req, res) => {
  try {
    const prayer = sanitizeText(req.body && req.body.prayer, 16);
    const completed = !!(req.body && req.body.completed);
    const userId = req.user.id;

    if (!PRAYER_KEYS.includes(prayer)) {
      return res.status(400).json({ error: "صلاة غير معروفة." });
    }

    const dateKey = todayKey();
    const docId = `${userId}_${dateKey}_${prayer}`;
    const ref = db.collection("prayer_records").doc(docId);

    await ref.set({
      userId,
      userName: req.user.name,
      prayer,
      date: dateKey,
      completed,
      completedAt: completed ? admin.firestore.FieldValue.serverTimestamp() : null
    }, { merge: true });

    const [times, recordsMap] = await Promise.all([
      getPrayerTimes(DEFAULT_COORDS.lat, DEFAULT_COORDS.lng),
      loadRecordsMap(userId, dateKey)
    ]);

    const prayers = buildPrayersPayload(times, recordsMap);
    return res.json({ date: dateKey, prayers });
  } catch (err) {
    console.error("prayer complete error:", err.message);
    return res.status(500).json({ error: "تعذّر تحديث حالة الصلاة." });
  }
});

app.post("/api/prayers/reset", authenticate, writeLimiter, async (req, res) => {
  try {
    const userId = req.user.id;
    const dateKey = todayKey();

    const snap = await db.collection("prayer_records")
      .where("userId", "==", userId)
      .where("date", "==", dateKey)
      .get();

    const batch = db.batch();
    snap.forEach((doc) => batch.delete(doc.ref));
    await batch.commit();

    const [times, recordsMap] = await Promise.all([
      getPrayerTimes(DEFAULT_COORDS.lat, DEFAULT_COORDS.lng),
      loadRecordsMap(userId, dateKey)
    ]);

    const prayers = buildPrayersPayload(times, recordsMap);
    return res.json({ date: dateKey, prayers });
  } catch (err) {
    console.error("prayer reset error:", err.message);
    return res.status(500).json({ error: "تعذّر إعادة الصلوات." });
  }
});

app.get("/api/dashboard/stats", authenticate, requireAdmin, async (_req, res) => {
  try {
    const dateKey = todayKey();
    const weekStartDate = weekStart();

    const [visitsSnap, prayersSnap, usersSnap] = await Promise.all([
      db.collection("visits").get(),
      db.collection("prayer_records")
        .where("date", "==", dateKey)
        .where("completed", "==", true)
        .get(),
      db.collection("users").where("role", "==", "user").get()
    ]);

    const allSessions = new Set();
    const todaySessions = new Set();
    const weekSessions = new Set();

    visitsSnap.forEach((doc) => {
      const data = doc.data();
      if (!data.sessionId) return;
      allSessions.add(data.sessionId);

      if (data.dayKey === dateKey) todaySessions.add(data.sessionId);

      const ts = data.timestamp && data.timestamp.toDate ? data.timestamp.toDate() : null;
      if (ts && ts >= weekStartDate) weekSessions.add(data.sessionId);
    });

    res.json({
      stats: {
        totalVisitors: allSessions.size,
        todayVisitors: todaySessions.size,
        weekVisitors: weekSessions.size,
        completedPrayersToday: prayersSnap.size,
        totalUsers: usersSnap.size
      }
    });
  } catch (err) {
    console.error("dashboard stats error:", err.message);
    res.status(500).json({ error: "تعذّر جلب الإحصائيات." });
  }
});

app.get("/api/dashboard/visits", authenticate, requireAdmin, async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit, 10) || 10, 50);
    const snap = await db.collection("visits")
      .orderBy("timestamp", "desc")
      .limit(limit)
      .get();

    const visits = snap.docs.map((doc) => {
      const data = doc.data();
      return {
        id: doc.id,
        page: data.page || "/",
        device: data.device || "unknown",
        timestamp: data.timestamp && data.timestamp.toDate
          ? data.timestamp.toDate().toISOString()
          : null
      };
    });

    res.json({ visits });
  } catch (err) {
    console.error("dashboard visits error:", err.message);
    res.status(500).json({ error: "تعذّر جلب الزيارات." });
  }
});

app.get("/api/dashboard/users", authenticate, requireAdmin, async (_req, res) => {
  try {
    const dateKey = todayKey();

    const usersSnap = await db.collection("users")
      .where("role", "==", "user")
      .get();

    const prayersSnap = await db.collection("prayer_records")
      .where("date", "==", dateKey)
      .get();

    const prayersByUser = new Map();
    prayersSnap.forEach((doc) => {
      const data = doc.data();
      if (!prayersByUser.has(data.userId)) {
        prayersByUser.set(data.userId, new Map());
      }
      prayersByUser.get(data.userId).set(data.prayer, !!data.completed);
    });

    const users = usersSnap.docs.map((doc) => {
      const data = doc.data();
      const map = prayersByUser.get(data.id) || new Map();
      const prayers = {};
      PRAYER_KEYS.forEach((k) => {
        prayers[k] = !!map.get(k);
      });
      const completed = PRAYER_KEYS.filter((k) => prayers[k]).length;
      return {
        id: data.id,
        name: data.name,
        createdAt: data.createdAt && data.createdAt.toDate
          ? data.createdAt.toDate().toISOString()
          : null,
        prayers,
        completedCount: completed
      };
    });

    res.json({ date: dateKey, users });
  } catch (err) {
    console.error("dashboard users error:", err.message);
    res.status(500).json({ error: "تعذّر جلب المستخدمين." });
  }
});

app.get("/api/messages", authenticate, async (req, res) => {
  try {
    const sinceRaw = req.query.since ? String(req.query.since) : null;
    const since = sinceRaw ? new Date(sinceRaw) : null;

    let query;
    if (since && !isNaN(since.getTime())) {
      query = db.collection("messages")
        .where("createdAt", ">", admin.firestore.Timestamp.fromDate(since))
        .orderBy("createdAt", "asc")
        .limit(200);
    } else {
      query = db.collection("messages")
        .orderBy("createdAt", "asc")
        .limit(200);
    }

    const snap = await query.get();
    const messages = snap.docs.map((doc) => serializeMessage(doc.id, doc.data()));
    res.json({ messages });
  } catch (err) {
    console.error("messages list error:", err.message);
    res.status(500).json({ error: "تعذّر جلب الرسائل." });
  }
});

app.post("/api/messages", authenticate, writeLimiter, async (req, res) => {
  try {
    const text = sanitizeText(req.body && req.body.text, 2000);
    if (!text) return res.status(400).json({ error: "الرسالة فارغة." });

    const docRef = await db.collection("messages").add({
      senderId: req.user.id,
      senderName: req.user.name || "مستخدم",
      text,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: null,
      deletedAt: null
    });

    const doc = await docRef.get();
    res.status(201).json({ message: serializeMessage(doc.id, doc.data()) });
  } catch (err) {
    console.error("message create error:", err.message);
    res.status(500).json({ error: "تعذّر إرسال الرسالة." });
  }
});

app.patch("/api/messages/:id", authenticate, writeLimiter, async (req, res) => {
  try {
    const id = sanitizeText(req.params.id, 128);
    const text = sanitizeText(req.body && req.body.text, 2000);
    if (!text) return res.status(400).json({ error: "الرسالة فارغة." });

    const ref = db.collection("messages").doc(id);
    const doc = await ref.get();
    if (!doc.exists) return res.status(404).json({ error: "الرسالة غير موجودة." });

    const data = doc.data();
    if (data.senderId !== req.user.id) {
      return res.status(403).json({ error: "لا يمكنك تعديل رسالة غيرك." });
    }
    if (data.deletedAt) {
      return res.status(400).json({ error: "لا يمكن تعديل رسالة محذوفة." });
    }

    await ref.update({
      text,
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    });

    const updated = await ref.get();
    res.json({ message: serializeMessage(updated.id, updated.data()) });
  } catch (err) {
    console.error("message edit error:", err.message);
    res.status(500).json({ error: "تعذّر تعديل الرسالة." });
  }
});

app.delete("/api/messages/:id", authenticate, writeLimiter, async (req, res) => {
  try {
    const id = sanitizeText(req.params.id, 128);
    const ref = db.collection("messages").doc(id);
    const doc = await ref.get();
    if (!doc.exists) return res.status(404).json({ error: "الرسالة غير موجودة." });

    const data = doc.data();
    if (data.senderId !== req.user.id) {
      return res.status(403).json({ error: "لا يمكنك حذف رسالة غيرك." });
    }

    await ref.update({
      text: "",
      deletedAt: admin.firestore.FieldValue.serverTimestamp()
    });

    res.json({ ok: true });
  } catch (err) {
    console.error("message delete error:", err.message);
    res.status(500).json({ error: "تعذّر حذف الرسالة." });
  }
});

app.post("/api/push/subscribe", authenticate, writeLimiter, async (req, res) => {
  try {
    const sub = req.body && req.body.subscription;
    if (!sub || !sub.endpoint) {
      return res.status(400).json({ error: "subscription غير صالح." });
    }

    const subId = Buffer.from(sub.endpoint).toString("base64").replace(/[^A-Za-z0-9]/g, "").slice(0, 120);

    await db.collection("push_subscriptions").doc(subId).set({
      userId: req.user.id,
      userName: req.user.name,
      subscription: sub,
      createdAt: admin.firestore.FieldValue.serverTimestamp()
    }, { merge: true });

    res.json({ ok: true });
  } catch (err) {
    console.error("push subscribe error:", err.message);
    res.status(500).json({ error: "تعذّر تسجيل الإشعارات." });
  }
});

app.post("/api/push/unsubscribe", authenticate, writeLimiter, async (req, res) => {
  try {
    const endpoint = req.body && req.body.endpoint;
    if (!endpoint) return res.status(400).json({ error: "endpoint مطلوب." });

    const subId = Buffer.from(endpoint).toString("base64").replace(/[^A-Za-z0-9]/g, "").slice(0, 120);
    await db.collection("push_subscriptions").doc(subId).delete();
    res.json({ ok: true });
  } catch (err) {
    console.error("push unsubscribe error:", err.message);
    res.status(500).json({ error: "تعذّر إلغاء الإشعارات." });
  }
});

function parseTimeToDate(timeStr, baseDate) {
  if (!timeStr || typeof timeStr !== "string") return null;
  const clean = timeStr.split(" ")[0];
  const [hh, mm] = clean.split(":").map((n) => parseInt(n, 10));
  if (isNaN(hh) || isNaN(mm)) return null;
  const d = new Date(baseDate);
  d.setHours(hh, mm, 0, 0);
  return d;
}

app.post("/api/push/check", async (req, res) => {
  try {
    const secret = req.headers["x-cron-secret"] || "";
    if (!CRON_SECRET || secret !== CRON_SECRET) {
      return res.status(401).json({ error: "غير مصرّح." });
    }

    if (!VAPID_PUBLIC_KEY || !VAPID_PRIVATE_KEY) {
      return res.status(503).json({ error: "Push غير مهيأ." });
    }

    const now = new Date();
    const dateKey = todayKey(now);
    const timings = await getPrayerTimes(DEFAULT_COORDS.lat, DEFAULT_COORDS.lng);

    const prayerTimes = {};
    PRAYER_KEYS.forEach((k) => {
      prayerTimes[k] = parseTimeToDate(timings[k], now);
    });

    const subsSnap = await db.collection("push_subscriptions").get();
    if (subsSnap.empty) {
      return res.json({ ok: true, sent: 0, checked: 0 });
    }

    const userIds = new Set();
    subsSnap.forEach((doc) => {
      const data = doc.data();
      if (data.userId) userIds.add(data.userId);
    });

    const recordsSnap = await db.collection("prayer_records")
      .where("date", "==", dateKey)
      .get();

    const completedByUser = new Map();
    recordsSnap.forEach((doc) => {
      const data = doc.data();
      if (!completedByUser.has(data.userId)) completedByUser.set(data.userId, new Set());
      if (data.completed) completedByUser.get(data.userId).add(data.prayer);
    });

    const stages = [
      { key: "t10", offsetMin: -10 },
      { key: "t5", offsetMin: -5 },
      { key: "now", offsetMin: 0 }
    ];

    const windowTolerance = 3;

    let sent = 0;
    const errors = [];

    for (const subDoc of subsSnap.docs) {
      const subData = subDoc.data();
      const userId = subData.userId;
      const subscription = subData.subscription;
      if (!userId || !subscription) continue;

      const completed = completedByUser.get(userId) || new Set();

      for (const prayer of PRAYER_KEYS) {
        if (completed.has(prayer)) continue;
        const pTime = prayerTimes[prayer];
        if (!pTime) continue;

        for (const stage of stages) {
          const target = new Date(pTime.getTime() + stage.offsetMin * 60 * 1000);
          const diffMin = (now - target) / (60 * 1000);
          if (diffMin < 0 || diffMin > windowTolerance) continue;

          const logId = `${userId}_${prayer}_${dateKey}_${stage.key}`.replace(/[^A-Za-z0-9_\-]/g, "_");
          const logRef = db.collection("push_log").doc(logId);
          const logDoc = await logRef.get();
          if (logDoc.exists) continue;

          const payload = JSON.stringify({
            title: "مُذَكِّر",
            body: stage.key === "now"
              ? `حان الآن وقت صلاة ${PRAYER_LABELS_AR[prayer]}`
              : `باقي ${Math.abs(stage.offsetMin)} دقيقة على صلاة ${PRAYER_LABELS_AR[prayer]}`,
            tag: `${prayer}_${stage.key}_${dateKey}`,
            url: "/"
          });

          try {
            await webpush.sendNotification(subscription, payload);
            await logRef.set({
              userId,
              prayer,
              date: dateKey,
              stage: stage.key,
              sentAt: admin.firestore.FieldValue.serverTimestamp()
            });
            sent += 1;
          } catch (err) {
            errors.push({ subId: subDoc.id, code: err.statusCode || null });
            if (err.statusCode === 404 || err.statusCode === 410) {
              await subDoc.ref.delete().catch(() => {});
            }
          }
        }
      }
    }

    return res.json({ ok: true, sent, checked: subsSnap.size, errors: errors.length });
  } catch (err) {
    console.error("push check error:", err.message);
    return res.status(500).json({ error: "تعذّر فحص الإشعارات." });
  }
});

app.use(express.static(path.join(__dirname, "public"), {
  extensions: ["html"],
  maxAge: IS_PROD ? "1h" : 0
}));

app.get("/sign-up", (_req, res) => {
  res.sendFile(path.join(__dirname, "public", "sign-up.html"));
});

app.get("/login", (_req, res) => {
  res.sendFile(path.join(__dirname, "public", "login.html"));
});

app.get("/login-admin", (_req, res) => {
  res.sendFile(path.join(__dirname, "public", "login-admin.html"));
});

app.get("/chat", (_req, res) => {
  res.sendFile(path.join(__dirname, "public", "chat.html"));
});

app.get("/dashboard", (_req, res) => {
  res.sendFile(path.join(__dirname, "public", "dashboard.html"));
});

app.get("/sw.js", (_req, res) => {
  res.sendFile(path.join(__dirname, "public", "sw.js"));
});

app.get("/manifest.json", (_req, res) => {
  res.sendFile(path.join(__dirname, "public", "manifest.json"));
});

app.use((req, res) => {
  if (req.path.startsWith("/api/")) {
    return res.status(404).json({ error: "المسار غير موجود." });
  }
  return res.status(404).sendFile(path.join(__dirname, "public", "index.html"));
});

app.use((err, _req, res, _next) => {
  console.error("unhandled error:", err.message);
  res.status(500).json({ error: "حدث خطأ غير متوقع." });
});

if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`Mudhakkir server listening on port ${PORT}`);
  });
}

module.exports = app;
