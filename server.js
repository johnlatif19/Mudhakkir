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
const cloudinary = require("cloudinary").v2;

const PORT = process.env.PORT || 3000;
const NODE_ENV = process.env.NODE_ENV || "development";
const IS_PROD = NODE_ENV === "production";

const JWT_SECRET = process.env.JWT_SECRET;
const ADMIN_USERNAME = process.env.ADMIN_USERNAME;
const ADMIN_PASSWORD_HASH = process.env.ADMIN_PASSWORD_HASH;

const COOKIE_NAME = "mudhakkir_token";
const TOKEN_TTL = "7d";

if (!JWT_SECRET || !ADMIN_USERNAME || !ADMIN_PASSWORD_HASH) {
  console.error("Missing required environment variables: JWT_SECRET, ADMIN_USERNAME, ADMIN_PASSWORD_HASH");
  process.exit(1);
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

app.use(cors({
  origin: true,
  credentials: true
}));

app.use(express.json({ limit: "32kb" }));
app.use(cookieParser());

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "محاولات كثيرة. حاول لاحقًا." }
});

const writeLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
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
    deletedAt: data.deletedAt && data.deletedAt.toDate ? data.deletedAt.toDate().toISOString() : null,
    readAt: data.readAt && data.readAt.toDate ? data.readAt.toDate().toISOString() : null
  };
}

app.get("/api/health", (_req, res) => {
  res.json({ ok: true });
});

app.post("/api/auth/login", loginLimiter, async (req, res) => {
  const username = sanitizeText(req.body && req.body.username, 64);
  const password = typeof (req.body && req.body.password) === "string" ? req.body.password : "";

  if (!username || !password) {
    return res.status(400).json({ error: "أدخل اسم المستخدم وكلمة المرور." });
  }

  if (username !== ADMIN_USERNAME) {
    return res.status(401).json({ error: "بيانات الدخول غير صحيحة." });
  }

  const ok = await bcrypt.compare(password, ADMIN_PASSWORD_HASH);
  if (!ok) {
    return res.status(401).json({ error: "بيانات الدخول غير صحيحة." });
  }

  const token = signToken({ sub: "admin", name: ADMIN_USERNAME, role: "admin" });
  setAuthCookie(res, token);
  return res.json({ user: { id: "admin", name: ADMIN_USERNAME, role: "admin" } });
});

app.post("/api/auth/logout", (req, res) => {
  clearAuthCookie(res);
  res.json({ ok: true });
});

app.get("/api/auth/me", authenticate, (req, res) => {
  res.json({ user: req.user });
});

app.post("/api/visits", writeLimiter, async (req, res) => {
  try {
    const sessionId = sanitizeText(req.body && req.body.sessionId, 64);
    const page = sanitizeText(req.body && req.body.page, 200) || "/";
    const device = sanitizeText(req.body && req.body.device, 32) || "unknown";
    const referrer = sanitizeText(req.body && req.body.referrer, 300) || null;
    const userAgent = sanitizeText(req.headers["user-agent"] || "", 300) || null;

    if (!sessionId) {
      return res.status(400).json({ error: "sessionId مطلوب." });
    }

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

app.get("/api/dashboard/stats", authenticate, requireAdmin, async (_req, res) => {
  try {
    const dateKey = todayKey();
    const weekStartDate = weekStart();

    const [visitsSnap, prayersSnap] = await Promise.all([
      db.collection("visits").get(),
      db.collection("prayer_records")
        .where("date", "==", dateKey)
        .where("completed", "==", true)
        .get()
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
        completedPrayersToday: prayersSnap.size
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
      deletedAt: null,
      readAt: null
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

app.use(express.static(path.join(__dirname, "public"), {
  extensions: ["html"],
  maxAge: IS_PROD ? "1h" : 0
}));

app.get("/chat", (_req, res) => {
  res.sendFile(path.join(__dirname, "public", "chat.html"));
});

app.get("/login", (_req, res) => {
  res.sendFile(path.join(__dirname, "public", "login.html"));
});

app.get("/dashboard", (_req, res) => {
  res.sendFile(path.join(__dirname, "public", "dashboard.html"));
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
