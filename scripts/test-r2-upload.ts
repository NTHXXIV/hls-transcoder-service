/**
 * Quick test: upload one thumbnail to R2 and print the URL.
 * Usage: npx tsx scripts/test-r2-upload.ts
 */
import { promises as fs } from "node:fs";
import { PutObjectCommand } from "@aws-sdk/client-s3";
import { createR2Client } from "../src/shared/r2.js";

const R2_ENDPOINT         = process.env.R2_ENDPOINT ?? "";
const R2_ACCESS_KEY_ID    = process.env.R2_ACCESS_KEY_ID ?? "";
const R2_SECRET_ACCESS_KEY = process.env.R2_SECRET_ACCESS_KEY ?? "";
const R2_BUCKET           = process.env.R2_BUCKET ?? "";
const R2_PUBLIC_BASE_URL  = (process.env.R2_PUBLIC_BASE_URL ?? "").replace(/\/$/, "");

const TEST_FILE = "/Users/nth/stagapps/apps/stag/public/blog/bai-viet/lai-50-trieu-sau-1-thang-bat-day-925-trieu-dong-thuc-hu/thumbnail.jpg";
const R2_KEY    = "blog/bai-viet/lai-50-trieu-sau-1-thang-bat-day-925-trieu-dong-thuc-hu/thumbnail.jpg";

if (!R2_ENDPOINT || !R2_ACCESS_KEY_ID || !R2_SECRET_ACCESS_KEY || !R2_BUCKET) {
  console.error("❌ Missing R2 env vars");
  process.exit(1);
}

const body = await fs.readFile(TEST_FILE);
const client = createR2Client(R2_ENDPOINT, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY);

await client.send(new PutObjectCommand({
  Bucket: R2_BUCKET,
  Key: R2_KEY,
  Body: body,
  ContentType: "image/jpeg",
  CacheControl: "public, max-age=31536000, immutable",
}));

const url = `${R2_PUBLIC_BASE_URL}/${R2_KEY}`;
console.log(`✅ Uploaded: ${url}`);
