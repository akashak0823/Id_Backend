// server.js
import express from "express";
import bodyParser from "body-parser";
import sqlite3pkg from "sqlite3";
import { open } from "sqlite";
import QRCode from "qrcode";
import bwipjs from "bwip-js";
import cors from "cors";
import multer from "multer";
import fs from "fs";
import path from "path";
import { v4 as uuidv4 } from "uuid";

const sqlite3 = sqlite3pkg.verbose();
const app = express();

app.use(cors());
app.use(bodyParser.json({ limit: "1mb" }));

// Serve uploaded photos statically
const UPLOAD_DIR = path.join(process.cwd(), "uploads");
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });
app.use("/uploads", express.static(UPLOAD_DIR));

// Multer setup for photo uploads
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOAD_DIR),
  filename: (req, file, cb) => cb(null, `${uuidv4()}${path.extname(file.originalname).toLowerCase()}`)
});
const upload = multer({
  storage,
  fileFilter: (req, file, cb) => {
    const allowed = ["image/jpeg", "image/png", "image/webp"];
    allowed.includes(file.mimetype) ? cb(null, true) : cb(new Error("Unsupported file type"));
  },
  limits: { fileSize: 3 * 1024 * 1024 } // 3 MB limit
});

// Config
const PORT = process.env.PORT || 4000;
const COMPANY_CODE = process.env.COMPANY_CODE || "ART";

// Database setup
let db;
async function initDb() {
  db = await open({
    filename: "./employees.db",
    driver: sqlite3.Database
  });

  await db.exec(`CREATE TABLE IF NOT EXISTS employees (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    employee_id TEXT UNIQUE,
    first_name TEXT,
    last_name TEXT,
    address TEXT,
    position TEXT,
    contact TEXT,
    dob TEXT,
    blood_group TEXT,
    email TEXT,
    dept TEXT,
    other TEXT,
    photo_path TEXT,
    created_at TEXT
  )`);
}
await initDb();

// === Helper functions ===
function deptCode(dept) {
  if (!dept) return "GEN";
  return dept.toUpperCase().replace(/[^A-Z]/g, "").slice(0, 3).padEnd(3, "X");
}

function checksumDigit(s) {
  const digits = s.split("").map(ch => ch.charCodeAt(0)).join("");
  let sum = 0;
  for (const d of digits) sum += Number(d || 0);
  return (sum % 9).toString();
}

async function generateEmployeeId({ dept }) {
  const year = new Date().getFullYear();
  const yy = String(year).slice(-2);
  const dcode = deptCode(dept);

  const row = await db.get(
    `SELECT employee_id FROM employees WHERE employee_id LIKE ? ORDER BY id DESC LIMIT 1`,
    [`${COMPANY_CODE}-${yy}-${dcode}-%`]
  );

  let lastSerial = 0;
  if (row && row.employee_id) {
    const parts = row.employee_id.split("-");
    lastSerial = parseInt(parts[3] || "0", 10) || 0;
  }

  const nextSerial = lastSerial + 1;
  const serialStr = String(nextSerial).padStart(6, "0");
  const raw = `${COMPANY_CODE}-${yy}-${dcode}-${serialStr}`;
  const chk = checksumDigit(raw);
  return `${raw}-${chk}`;
}

async function makeQRDataURL(text) {
  return await QRCode.toDataURL(text, { errorCorrectionLevel: "M", type: "image/png" });
}

async function makeBarcodeDataURL(text) {
  const png = await bwipjs.toBuffer({
    bcid: "code128",
    text,
    scale: 3,
    height: 12,
    includetext: false,
    textxalign: "center"
  });
  return `data:image/png;base64,${png.toString("base64")}`;
}

function getBaseUrl(req) {
  const proto = req.headers["x-forwarded-proto"] || req.protocol;
  const host = req.headers["x-forwarded-host"] || req.headers.host;
  return `${proto}://${host}`;
}

// === API Endpoints ===

// ➕ Add new employee
app.post("/api/employees", upload.single("photo"), async (req, res) => {
  try {
    const payload = req.body || {};
    const {
      first_name = "",
      last_name = "",
      address = "",
      position = "",
      contact = "",
      dob = "",
      blood_group = "",
      email = "",
      dept = "",
      other = ""
    } = payload;

    const employee_id = await generateEmployeeId({ dept });
    const created_at = new Date().toISOString();

    let photo_path = null;
    if (req.file && req.file.filename) photo_path = `/uploads/${req.file.filename}`;

    await db.run(
      `INSERT INTO employees (employee_id, first_name, last_name, address, position, contact, dob, blood_group, email, dept, other, photo_path, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [employee_id, first_name, last_name, address, position, contact, dob, blood_group, email, dept, other, photo_path, created_at]
    );

    const saved = await db.get("SELECT * FROM employees WHERE employee_id = ?", [employee_id]);

    const verifyUrl = `${getBaseUrl(req)}/verify/${encodeURIComponent(employee_id)}`;
    const [qrDataUrl, barcodeDataUrl] = await Promise.all([
      makeQRDataURL(verifyUrl),
      makeBarcodeDataURL(employee_id)
    ]);

    res.json({
      success: true,
      employee: saved,
      employee_id,
      qrDataUrl,
      barcodeDataUrl,
      verifyUrl,
      photoUrl: photo_path ? `${getBaseUrl(req)}${photo_path}` : null
    });
  } catch (err) {
    console.error("POST /api/employees error:", err);
    res.status(500).json({ success: false, error: String(err) });
  }
});

// 🔍 Fetch employee by ID
app.get("/api/employees/:employee_id", async (req, res) => {
  try {
    const eid = req.params.employee_id;
    const row = await db.get("SELECT * FROM employees WHERE employee_id = ?", [eid]);
    if (!row) return res.status(404).json({ success: false, error: "Not found" });

    const photo_url = row.photo_path ? `${getBaseUrl(req)}${row.photo_path}` : null;
    const qrDataUrl = await makeQRDataURL(`${getBaseUrl(req)}/verify/${eid}`);
    const barcodeDataUrl = await makeBarcodeDataURL(row.employee_id);

    res.json({ success: true, employee: { ...row, photo_url }, qrDataUrl, barcodeDataUrl });
  } catch (err) {
    console.error("GET /api/employees/:id error:", err);
    res.status(500).json({ success: false, error: String(err) });
  }
});

// 🌐 Public verification page (scanned QR opens this)
app.get("/verify/:employee_id", async (req, res) => {
  const eid = req.params.employee_id;
  const row = await db.get("SELECT * FROM employees WHERE employee_id = ?", [eid]);
  if (!row) return res.status(404).send("<h2>Employee not found</h2>");

  const photo_url = row.photo_path ? `${getBaseUrl(req)}${row.photo_path}` : "";

  const html = `
  <html>
  <head>
    <title>${row.first_name} ${row.last_name} - ARTIBOTS Employee</title>
    <style>
      body {
        font-family: 'Inter', sans-serif;
        background: #F1EFEC;
        color: #030303;
        display: flex;
        align-items: center;
        justify-content: center;
        height: 100vh;
        margin: 0;
      }
      .card {
        background: #fff;
        border-radius: 16px;
        box-shadow: 0 6px 18px rgba(0, 0, 0, 0.1);
        padding: 32px;
        width: 360px;
        text-align: center;
        border-top: 6px solid #123458;
      }
      img.photo {
        width: 160px;
        height: 160px;
        object-fit: cover;
        border-radius: 12px;
        border: 4px solid #4ED7F1;
        margin-bottom: 16px;
      }
      h2 {
        margin: 0;
        color: #123458;
      }
      .id {
        font-family: 'Roboto Mono', monospace;
        color: #D4C9BE;
        font-size: 14px;
        margin-bottom: 10px;
      }
      p { margin: 6px 0; }
      hr {
        margin: 16px 0;
        border: none;
        border-top: 1px solid #eee;
      }
      .brand {
        margin-top: 10px;
        font-weight: bold;
        color: #4ED7F1;
        letter-spacing: 1px;
      }
    </style>
  </head>
  <body>
    <div class="card">
      ${photo_url ? `<img src="${photo_url}" class="photo" alt="Employee Photo"/>` : ""}
      <h2>${row.first_name} ${row.last_name}</h2>
      <div class="id">${row.employee_id}</div>
      <p><strong>Position:</strong> ${row.position || "-"}</p>
      <p><strong>Department:</strong> ${row.dept || "-"}</p>
      <p><strong>Contact:</strong> ${row.contact || "-"}</p>
      <p><strong>Email:</strong> ${row.email || "-"}</p>
      <p><strong>DOB:</strong> ${row.dob || "-"}</p>
      <p><strong>Blood Group:</strong> ${row.blood_group || "-"}</p>
      <p><strong>Address:</strong> ${row.address || "-"}</p>
      <hr />
      <div class="brand">Verified by ARTIBOTS</div>
    </div>
  </body>
  </html>`;

  res.send(html);
});

// Start server
app.listen(PORT, () => {
  console.log(`✅ ID Card & QR Generator running on http://localhost:${PORT}`);
});
