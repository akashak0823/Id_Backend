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
// keep JSON parser for non-file routes (we'll handle multipart via multer)
app.use(cors());
// serve uploaded files statically
app.use("/uploads", express.static(path.join(process.cwd(), "uploads")));

// ensure uploads folder
const UPLOAD_DIR = path.join(process.cwd(), "uploads");
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

// multer storage + file filter
const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    cb(null, UPLOAD_DIR);
  },
  filename: function (req, file, cb) {
    const ext = path.extname(file.originalname).toLowerCase();
    cb(null, `${uuidv4()}${ext}`);
  }
});
function fileFilter(req, file, cb) {
  const allowed = ["image/jpeg", "image/png", "image/webp"];
  if (allowed.includes(file.mimetype)) cb(null, true);
  else cb(new Error("Unsupported file type"), false);
}
const upload = multer({
  storage,
  fileFilter,
  limits: { fileSize: 3 * 1024 * 1024 } // 3MB
});

// still parse JSON bodies for standard routes
app.use(bodyParser.json({ limit: "1mb" }));

// config
const PORT = process.env.PORT || 4000;
const COMPANY_CODE = process.env.COMPANY_CODE || "ART"; // set for env-specific prefix

// open sqlite db (file based)
let db;
async function initDb() {
  db = await open({
    filename: "./employees.db",
    driver: sqlite3.Database
  });

  // create table (includes photo_path)
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

// helper: dept code
function deptCode(dept) {
  if (!dept) return "GEN";
  return dept.toUpperCase().replace(/[^A-Z]/g, "").slice(0, 3).padEnd(3, "X");
}

// helper: checksum digit (mod 9) on digits of a string
function checksumDigit(s) {
  const digits = s.split("").map(ch => ch.charCodeAt(0)).join("");
  let sum = 0;
  for (const d of digits) sum += Number(d || 0);
  return (sum % 9).toString();
}

// generate employee id using a sequential counter per year+company
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
    const serialPart = parts[3] || "0";
    lastSerial = parseInt(serialPart, 10) || 0;
  }
  const nextSerial = lastSerial + 1;
  const serialStr = String(nextSerial).padStart(6, "0");

  const raw = `${COMPANY_CODE}-${yy}-${dcode}-${serialStr}`;
  const chk = checksumDigit(raw);
  return `${raw}-${chk}`;
}

// helper: create qr png dataurl from text
async function makeQRDataURL(text) {
  return await QRCode.toDataURL(text, { errorCorrectionLevel: "M", type: "image/png" });
}

// helper: create barcode png dataurl (code128)
async function makeBarcodeDataURL(text) {
  const png = await bwipjs.toBuffer({
    bcid: "code128",
    text: text,
    scale: 3,
    height: 12,
    includetext: false,
    textxalign: "center",
  });
  return `data:image/png;base64,${png.toString("base64")}`;
}

// endpoint: add employee with optional photo upload (field name: 'photo')
app.post("/api/employees", upload.single("photo"), async (req, res) => {
  try {
    // if multipart form, fields are in req.body (strings) and file is in req.file
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

    // generate unique employee id
    const employee_id = await generateEmployeeId({ dept });

    const created_at = new Date().toISOString();

    // photo path (if uploaded)
    let photo_path = null;
    if (req.file && req.file.filename) {
      photo_path = `/uploads/${req.file.filename}`;
    }

    const stmt = await db.run(
      `INSERT INTO employees (employee_id, first_name, last_name, address, position, contact, dob, blood_group, email, dept, other, photo_path, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        employee_id,
        first_name,
        last_name,
        address,
        position,
        contact,
        dob,
        blood_group,
        email,
        dept,
        other,
        photo_path,
        created_at
      ]
    );

    const saved = await db.get("SELECT * FROM employees WHERE id = ?", [stmt.lastID]);

    const details = {
      employee_id,
      first_name,
      last_name,
      address,
      position,
      contact,
      dob,
      blood_group,
      email,
      dept,
      other,
      photo_url: photo_path ? `${getBaseUrl(req)}${photo_path}` : null,
      created_at
    };

    // qr contains JSON payload (scannable) including photo_url
    const qrText = JSON.stringify(details);

    const [qrDataUrl, barcodeDataUrl] = await Promise.all([
      makeQRDataURL(qrText),
      makeBarcodeDataURL(employee_id)
    ]);

    res.json({
      success: true,
      employee: saved,
      employee_id,
      photoUrl: details.photo_url,
      qrDataUrl,
      barcodeDataUrl
    });
  } catch (err) {
    console.error("POST /api/employees error:", err);
    res.status(500).json({ success: false, error: String(err) });
  }
});

// endpoint: get employee by id (employee_id)
app.get("/api/employees/:employee_id", async (req, res) => {
  try {
    const eid = req.params.employee_id;
    const row = await db.get("SELECT * FROM employees WHERE employee_id = ?", [eid]);
    if (!row) return res.status(404).json({ success: false, error: "Not found" });

    const photo_url = row.photo_path ? `${getBaseUrl(req)}${row.photo_path}` : null;
    const details = { ...row, photo_url };
    const qrText = JSON.stringify(details);
    const qrDataUrl = await makeQRDataURL(qrText);
    const barcodeDataUrl = await makeBarcodeDataURL(row.employee_id);

    res.json({ success: true, employee: details, qrDataUrl, barcodeDataUrl });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, error: String(err) });
  }
});

app.listen(PORT, () => {
  console.log(`ID card generator API listening on ${PORT}`);
});

// helper get base url
function getBaseUrl(req) {
  const proto = req.headers["x-forwarded-proto"] || req.protocol;
  const host = req.headers["x-forwarded-host"] || req.headers.host;
  return `${proto}://${host}`;
}
