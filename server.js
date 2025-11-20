// server.js
import express from "express";
import bodyParser from "body-parser";
import cors from "cors";
import multer from "multer";
import { v4 as uuidv4 } from "uuid";
import QRCode from "qrcode";
import bwipjs from "bwip-js";
import mongoose from "mongoose";
import cloudinary from "cloudinary";
import streamifier from "streamifier";
import dotenv from "dotenv";
import path from "path";

dotenv.config();

// App + config
const app = express();
// enable CORS (you can restrict origins later)
app.use(cors());
app.use(bodyParser.json({ limit: "8mb" }));
app.use(bodyParser.urlencoded({ extended: true }));

const PORT = process.env.PORT || 4000;
const COMPANY_CODE = process.env.COMPANY_CODE || "ART";
const MONGODB_URI = process.env.MONGODB_URI || "mongodb+srv://Akash:Akash0515@database.otmxfxp.mongodb.net/Rtech?retryWrites=true&w=majority&appName=Database";
const CLOUDINARY_UPLOAD_FOLDER = process.env.CLOUDINARY_UPLOAD_FOLDER || "Artibots";

// Configure Cloudinary
cloudinary.v2.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
  secure: true
});

// Mongoose setup
await mongoose.connect(MONGODB_URI, { useNewUrlParser: true, useUnifiedTopology: true });
console.log("✅ Connected to MongoDB");

// Employee schema
const employeeSchema = new mongoose.Schema({
  employee_id: { type: String, unique: true, index: true },
  first_name: String,
  last_name: String,
  address: String,
  position: String,
  contact: String,
  dob: String,
  blood_group: String,
  email: String,
  dept: String,
  other: String,
  photo_public_id: String, // Cloudinary public_id (if uploaded by server)
  photo_url: String,       // public URL (secure_url or external)
  created_at: { type: Date, default: Date.now }
}, { versionKey: false });

const Employee = mongoose.model("Employee", employeeSchema);

// Multer memory storage for optional server-side uploads
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 6 * 1024 * 1024 }, // 6 MB
  fileFilter: (req, file, cb) => {
    const allowed = ["image/jpeg", "image/png", "image/webp"];
    if (allowed.includes(file.mimetype)) cb(null, true);
    else cb(new Error("Unsupported file type"));
  }
});

// ---------- Helpers ----------
function escapeRegExp(string) {
  return String(string || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
function escapeHtml(unsafe) {
  if (unsafe == null) return "";
  return String(unsafe)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function deptCode(dept) {
  if (!dept) return "GEN";
  return dept.toUpperCase().replace(/[^A-Z]/g, "").slice(0, 3).padEnd(3, "X");
}

function checksumDigit(s) {
  const digits = s.split("").map(ch => String(ch.charCodeAt(0))).join("");
  let sum = 0;
  for (const d of digits) sum += Number(d || 0);
  return String(sum % 9);
}

async function generateEmployeeId({ dept }) {
  const year = new Date().getFullYear();
  const yy = String(year).slice(-2);
  const dcode = deptCode(dept);

  const regex = new RegExp(`^${COMPANY_CODE}-${yy}-${dcode}-\\d{6}-\\d$`);
  const last = await Employee.findOne({ employee_id: { $regex: regex } }).sort({ created_at: -1 }).lean();

  let lastSerial = 0;
  if (last && last.employee_id) {
    const parts = last.employee_id.split("-");
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

async function makeQRCodeBuffer(text) {
  // return Node buffer (binary PNG)
  return await QRCode.toBuffer(text, { errorCorrectionLevel: "M", type: "png" });
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

async function makeBarcodeBuffer(text) {
  const png = await bwipjs.toBuffer({
    bcid: "code128",
    text,
    scale: 3,
    height: 12,
    includetext: false,
    textxalign: "center"
  });
  return png;
}

function getBaseUrl(req) {
  const proto = (req.headers["x-forwarded-proto"] || req.protocol || "http").split(",")[0].trim();
  const host = (req.headers["x-forwarded-host"] || req.headers.host || `localhost:${PORT}`).split(",")[0].trim();
  return `${proto}://${host}`;
}

// Upload buffer to Cloudinary; returns cloudinary result object
function uploadBufferToCloudinary(buffer, originalName) {
  return new Promise((resolve, reject) => {
    const options = {
      folder: CLOUDINARY_UPLOAD_FOLDER,
      use_filename: true,
      unique_filename: true,
      resource_type: "image",
      transformation: [{ width: 2000, crop: "limit" }]
    };

    const uploadStream = cloudinary.v2.uploader.upload_stream(options, (err, result) => {
      if (err) return reject(err);
      resolve(result);
    });

    streamifier.createReadStream(buffer).pipe(uploadStream);
  });
}

// Delete image by public_id (if exists)
async function deleteCloudinaryImage(public_id) {
  if (!public_id) return;
  try {
    await cloudinary.v2.uploader.destroy(public_id, { resource_type: "image" });
  } catch (err) {
    console.warn("Cloudinary delete failed:", err.message || err);
  }
}

// ---------- Routes ----------

// Create employee
// Accepts:
// - multipart/form-data with optional file field "photo" (server uploads to Cloudinary)
// - OR application/json / form-encoded with photoUrl in body (client uploaded to Cloudinary)
app.post("/api/employees", upload.single("photo"), async (req, res) => {
  try {
    // normalize incoming fields (req.body will contain text fields for both)
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
      other = "",
      photoUrl = "" // from client-side direct upload (if present)
    } = payload;

    if (!first_name || !last_name) {
      return res.status(400).json({ success: false, error: "first_name and last_name are required" });
    }

    // Duplicate check (email/contact or same name + dob)
    const duplicate = await Employee.findOne({
      $or: [
        { email: email || null },
        { contact: contact || null },
        { $and: [
            { first_name: { $regex: `^${escapeRegExp(first_name)}$`, $options: "i" } },
            { last_name: { $regex: `^${escapeRegExp(last_name)}$`, $options: "i" } },
            { dob: dob || null }
          ] }
      ]
    }).lean();

    if (duplicate) {
      return res.status(400).json({ success: false, error: "Duplicate employee detected! Same email, contact, or name with DOB already exists." });
    }

    // generate employee id
    const employee_id = await generateEmployeeId({ dept });
    const created_at = new Date();

    // Photo handling priority:
    // 1) If client provided photoUrl in body, prefer that (no server upload)
    // 2) Else if client attached file 'photo' (multipart), server will upload to Cloudinary
    let photo_url = photoUrl || null;
    let photo_public_id = null;

    if (!photo_url && req.file && req.file.buffer) {
      // server-side upload to Cloudinary
      try {
        const result = await uploadBufferToCloudinary(req.file.buffer, req.file.originalname);
        photo_public_id = result.public_id;
        photo_url = result.secure_url;
      } catch (err) {
        console.error("Cloudinary upload failed:", err);
        return res.status(500).json({ success: false, error: "Image upload failed", details: String(err) });
      }
    }

    // save to MongoDB
    const doc = new Employee({
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
      photo_public_id,
      photo_url,
      created_at
    });

    await doc.save();

    // generate QR & barcode
    const verifyUrl = `${getBaseUrl(req)}/verify/${encodeURIComponent(employee_id)}`;
    const [qrDataUrl, barcodeDataUrl] = await Promise.all([
      makeQRDataURL(verifyUrl),
      makeBarcodeDataURL(employee_id)
    ]);

    res.json({
      success: true,
      employee: doc,
      employee_id,
      qrDataUrl,
      barcodeDataUrl,
      verifyUrl,
      photoUrl: photo_url || null
    });
  } catch (err) {
    console.error("POST /api/employees error:", err);
    res.status(500).json({ success: false, error: String(err) });
  }
});

// Update employee (PUT)
// Accepts multipart/form-data with optional "photo" file OR JSON/form data with photoUrl
app.put("/api/employees/:employee_id", upload.single("photo"), async (req, res) => {
  try {
    const eid = req.params.employee_id;
    const existing = await Employee.findOne({ employee_id: eid });
    if (!existing) return res.status(404).json({ success: false, error: "Not found" });

    // normalize incoming fields
    const payload = req.body || {};
    const {
      first_name = existing.first_name,
      last_name = existing.last_name,
      address = existing.address,
      position = existing.position,
      contact = existing.contact,
      dob = existing.dob,
      blood_group = existing.blood_group,
      email = existing.email,
      dept = existing.dept,
      other = existing.other,
      photoUrl = "" // client-provided URL (if any). sentinel: "__DELETE__"
    } = payload;

    // Basic validation
    if (!first_name || !last_name) {
      return res.status(400).json({ success: false, error: "first_name and last_name are required" });
    }

    // Duplicate check excluding current record
    const duplicate = await Employee.findOne({
      _id: { $ne: existing._id },
      $or: [
        { email: email || null },
        { contact: contact || null },
        { $and: [
            { first_name: { $regex: `^${escapeRegExp(first_name)}$`, $options: "i" } },
            { last_name: { $regex: `^${escapeRegExp(last_name)}$`, $options: "i" } },
            { dob: dob || null }
          ] }
      ]
    }).lean();

    if (duplicate) {
      return res.status(400).json({ success: false, error: "Duplicate employee detected! Same email, contact, or name with DOB already exists." });
    }

    // Photo handling:
    // - If new file uploaded (req.file) -> upload it and delete old server-uploaded image (if any)
    // - Else if photoUrl === "__DELETE__" -> delete old server-uploaded image (if any) and clear photo fields
    // - Else if photoUrl provided and it's different from existing.photo_url -> if existing was server-uploaded, delete old public_id
    // - Else keep existing photo data
    let photo_url = existing.photo_url || null;
    let photo_public_id = existing.photo_public_id || null;

    if (req.file && req.file.buffer) {
      // upload new image
      try {
        const result = await uploadBufferToCloudinary(req.file.buffer, req.file.originalname);
        // delete previous server-uploaded image if present
        if (photo_public_id) {
          await deleteCloudinaryImage(photo_public_id);
        }
        photo_public_id = result.public_id;
        photo_url = result.secure_url;
      } catch (err) {
        console.error("Cloudinary upload failed:", err);
        return res.status(500).json({ success: false, error: "Image upload failed", details: String(err) });
      }
    } else if (photoUrl === "__DELETE__") {
      // explicit delete request from client
      if (photo_public_id) {
        await deleteCloudinaryImage(photo_public_id);
      }
      photo_public_id = null;
      photo_url = null;
    } else if (photoUrl) {
      // client provided an external URL (or a Cloudinary URL already); if it differs from existing and previous was server-uploaded, remove old
      if (photoUrl !== photo_url) {
        if (photo_public_id) {
          await deleteCloudinaryImage(photo_public_id);
        }
        photo_public_id = null;
        photo_url = photoUrl;
      }
      // else no change
    }

    // Update fields (do not allow changing employee_id here)
    existing.first_name = first_name;
    existing.last_name = last_name;
    existing.address = address;
    existing.position = position;
    existing.contact = contact;
    existing.dob = dob;
    existing.blood_group = blood_group;
    existing.email = email;
    existing.dept = dept;
    existing.other = other;
    existing.photo_public_id = photo_public_id;
    existing.photo_url = photo_url;

    await existing.save();

    const verifyUrl = `${getBaseUrl(req)}/verify/${encodeURIComponent(existing.employee_id)}`;
    const [qrDataUrl, barcodeDataUrl] = await Promise.all([
      makeQRDataURL(verifyUrl),
      makeBarcodeDataURL(existing.employee_id)
    ]);

    res.json({
      success: true,
      employee: existing,
      qrDataUrl,
      barcodeDataUrl,
      verifyUrl,
      photoUrl: existing.photo_url || null
    });
  } catch (err) {
    console.error("PUT /api/employees/:id error:", err);
    res.status(500).json({ success: false, error: String(err) });
  }
});

// List employees (search q, limit, offset)
app.get("/api/employees", async (req, res) => {
  try {
    const q = (req.query.q || "").trim();
    const limit = Math.min(parseInt(req.query.limit || "50", 10) || 50, 200);
    const offset = parseInt(req.query.offset || "0", 10) || 0;

    let filter = {};
    if (q) {
      const like = new RegExp(escapeRegExp(q), "i");
      filter = {
        $or: [
          { employee_id: like },
          { first_name: like },
          { last_name: like },
          { email: like },
          { contact: like }
        ]
      };
    }

    const rows = await Employee.find(filter).sort({ created_at: -1 }).skip(offset).limit(limit).lean();
    const base = getBaseUrl(req);
    const employees = rows.map(r => ({
      id: r._id,
      employee_id: r.employee_id,
      first_name: r.first_name,
      last_name: r.last_name,
      position: r.position,
      dept: r.dept,
      contact: r.contact,
      email: r.email,
      created_at: r.created_at,
      photo_url: r.photo_url || null,
      verify_url: `${base}/verify/${encodeURIComponent(r.employee_id)}`
    }));

    res.json({ success: true, employees, count: employees.length, limit, offset });
  } catch (err) {
    console.error("GET /api/employees error:", err);
    res.status(500).json({ success: false, error: String(err) });
  }
});

// Get single employee (with data URLs for QR + barcode)
app.get("/api/employees/:employee_id", async (req, res) => {
  try {
    const eid = req.params.employee_id;
    const row = await Employee.findOne({ employee_id: eid }).lean();
    if (!row) return res.status(404).json({ success: false, error: "Not found" });

    const photo_url = row.photo_url || null;
    const verifyUrl = `${getBaseUrl(req)}/verify/${eid}`;
    const [qrDataUrl, barcodeDataUrl] = await Promise.all([
      makeQRDataURL(verifyUrl),
      makeBarcodeDataURL(row.employee_id)
    ]);

    res.json({ success: true, employee: { ...row, photo_url }, qrDataUrl, barcodeDataUrl, verifyUrl });
  } catch (err) {
    console.error("GET /api/employees/:id error:", err);
    res.status(500).json({ success: false, error: String(err) });
  }
});

// Download QR (binary PNG) - Content-Disposition: attachment
app.get("/api/employees/:employee_id/qr", async (req, res) => {
  try {
    const eid = req.params.employee_id;
    const row = await Employee.findOne({ employee_id: eid }).lean();
    if (!row) return res.status(404).send("Not found");

    const verifyUrl = `${getBaseUrl(req)}/verify/${encodeURIComponent(eid)}`;
    const buffer = await makeQRCodeBuffer(verifyUrl);

    res.setHeader("Content-Type", "image/png");
    res.setHeader("Content-Disposition", `attachment; filename="${eid}-qr.png"`);
    res.send(buffer);
  } catch (err) {
    console.error("GET /api/employees/:id/qr error:", err);
    res.status(500).send("Server error");
  }
});

// Download Barcode (binary PNG) - Content-Disposition: attachment
app.get("/api/employees/:employee_id/barcode", async (req, res) => {
  try {
    const eid = req.params.employee_id;
    const row = await Employee.findOne({ employee_id: eid }).lean();
    if (!row) return res.status(404).send("Not found");

    const buffer = await makeBarcodeBuffer(row.employee_id);

    res.setHeader("Content-Type", "image/png");
    res.setHeader("Content-Disposition", `attachment; filename="${eid}-barcode.png"`);
    res.send(buffer);
  } catch (err) {
    console.error("GET /api/employees/:id/barcode error:", err);
    res.status(500).send("Server error");
  }
});

// Delete employee (and delete server-uploaded Cloudinary image if any)
app.delete("/api/employees/:employee_id", async (req, res) => {
  try {
    const eid = req.params.employee_id;
    const row = await Employee.findOne({ employee_id: eid });
    if (!row) return res.status(404).json({ success: false, error: "Not found" });

    // if we stored a photo_public_id (i.e. server uploaded), delete it from Cloudinary
    if (row.photo_public_id) {
      await deleteCloudinaryImage(row.photo_public_id);
    }

    await Employee.deleteOne({ employee_id: eid });

    res.json({ success: true, message: "Deleted" });
  } catch (err) {
    console.error("DELETE /api/employees/:id error:", err);
    res.status(500).json({ success: false, error: String(err) });
  }
});

// Public verification page (simple HTML)
app.get("/verify/:employee_id", async (req, res) => {
  try {
    const eid = req.params.employee_id;
    const row = await Employee.findOne({ employee_id: eid }).lean();
    if (!row) return res.status(404).send("<h2>Employee not found</h2>");

    const photo_url = row.photo_url || "";

    const html = `
    <html>
    <head>
      <title>${escapeHtml(row.first_name)} ${escapeHtml(row.last_name)} - ${COMPANY_CODE} Employee</title>
      <meta name="viewport" content="width=device-width,initial-scale=1" />
      <style>
        body { font-family: 'Inter', sans-serif; background: #F1EFEC; color: #030303; display:flex; align-items:center; justify-content:center; height:100vh; margin:0; }
        .card { background:#fff; border-radius:16px; box-shadow:0 6px 18px rgba(0,0,0,0.1); padding:32px; width:360px; text-align:center; border-top:6px solid #123458; }
        img.photo { width:160px; height:160px; object-fit:cover; border-radius:12px; border:4px solid #4ED7F1; margin-bottom:16px; }
        h2{ margin:0; color:#123458; } .id{ font-family:'Roboto Mono', monospace; color:#D4C9BE; font-size:14px; margin-bottom:10px; }
        p{ margin:6px 0; } hr{ margin:16px 0; border:none; border-top:1px solid #eee; } .brand{ margin-top:10px; font-weight:bold; color:#4ED7F1; letter-spacing:1px; }
      </style>
    </head>
    <body>
      <div class="card">
        ${photo_url ? `<img src="${photo_url}" class="photo" alt="Employee Photo"/>` : ""}
        <h2>${escapeHtml(row.first_name)} ${escapeHtml(row.last_name)}</h2>
        <div class="id">${escapeHtml(row.employee_id)}</div>
        <p><strong>Position:</strong> ${escapeHtml(row.position || "-")}</p>
        <p><strong>Department:</strong> ${escapeHtml(row.dept || "-")}</p>
        <p><strong>Contact:</strong> ${escapeHtml(row.contact || "-")}</p>
        <p><strong>Email:</strong> ${escapeHtml(row.email || "-")}</p>
        <p><strong>DOB:</strong> ${escapeHtml(row.dob || "-")}</p>
        <p><strong>Blood Group:</strong> ${escapeHtml(row.blood_group || "-")}</p>
        <p><strong>Address:</strong> ${escapeHtml(row.address || "-")}</p>
        <hr />
        <div class="brand">Verified by ${escapeHtml(COMPANY_CODE)}</div>
      </div>
    </body>
    </html>`;
    res.send(html);
  } catch (err) {
    console.error("GET /verify error:", err);
    res.status(500).send("<h2>Server error</h2>");
  }
});

// Start
app.listen(PORT, () => {
  console.log(`✅ ID Card & QR Generator running on http://localhost:${PORT}`);
});
