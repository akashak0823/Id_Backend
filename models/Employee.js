// models/Employee.js
import mongoose from "mongoose";

const { Schema, model, Types } = mongoose;

const EmployeeSchema = new Schema(
  {
    // Application / human-friendly ID (e.g. "EMP-000001")
    employee_id: {
      type: String,
      trim: true,
      unique: true,
      sparse: true, // allow null docs without employee_id
      index: true
    },

    // Personal info
    first_name: { type: String, required: true, trim: true },
    last_name:  { type: String, required: true, trim: true },

    // Work & contact
    position:   { type: String, trim: true },
    dept:       { type: String, trim: true },
    contact:    { type: String, trim: true }, // store as string to preserve leading zeros / +country
    email:      {
      type: String,
      trim: true,
      lowercase: true,
      validate: {
        validator: v => !v || /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v),
        message: props => `${props.value} is not a valid email`
      }
    },

    // Address / notes
    address: { type: String, trim: true },
    other:   { type: String, trim: true },

    // Dates
    dob: {
      type: Date, // store as Date if available; frontend converts DD-MM-YYYY -> YYYY-MM-DD before submit
      default: null
    },

    // Medical / misc
    blood_group: { type: String, trim: true },

    // Photo handling (choose one)
    photo_url: { type: String, trim: true },           // store an externally hosted URL
    photo_file_id: { type: Types.ObjectId, ref: "fs.files" }, // if using GridFS: ObjectId ref to file
    photo_file_name: { type: String, trim: true },

    // Barcode / QR outputs (optional)
    qr_data_url: { type: String, trim: true },        // data:... base64 PNG if you store it
    barcode_data_url: { type: String, trim: true },

    // Optional: store raw base64 if you insist (not recommended for many images)
    // photo_base64: { type: String } // avoid unless small dataset

    // Helpful metadata
    migrated_from_sqlite_id: { type: Number }, // optional, if you migrated from sqlite manually
    meta: { type: Schema.Types.Mixed } // free-form for any extra data
  },
  {
    timestamps: true // adds createdAt and updatedAt as Date
  }
);

// Compound index ideas (uncomment if needed)
// EmployeeSchema.index({ first_name: 1, last_name: 1 });
// EmployeeSchema.index({ contact: 1 });

export default model("Employee", EmployeeSchema);
