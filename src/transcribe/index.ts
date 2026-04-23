import { PutObjectCommand } from "@aws-sdk/client-s3";
import { spawn } from "node:child_process";
import {
  createWriteStream,
  promises as fs,
  readFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";

import { decrypt } from "../shared/crypto.js";
import { sendCallback, validateCallbackUrl } from "../shared/callback.js";
import { createR2Client } from "../shared/r2.js";
import { extractAudio, getVideoDuration } from "../shared/utils.js";
import { cleanTranscript } from "./cleaner.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export async function runTranscriptionJob() {
  const payloadPath = process.argv[2];
  const stage = process.argv[3]; // --stage=whisper or --stage=gemini

  if (!payloadPath) {
    console.error("Missing payload path");
    process.exit(1);
  }

  let payload;
  try {
    payload = JSON.parse(readFileSync(payloadPath, "utf-8"));
  } catch (e) {
    console.error("❌ Failed to parse payload JSON");
    process.exit(1);
  }

  const PRIVATE_KEY = process.env.TRANSCODER_PRIVATE_KEY;
  const JOB_ID = payload.job_id;
  const LESSON_ID = typeof payload.lesson_id === "string" ? payload.lesson_id.trim() : "";
  const CALLBACK_URL = payload.callback_url;
  const CALLBACK_CLIENT_ID = payload.callback_client_id;
  const SOURCE_VERSION = payload.source_version;
  const TARGET_R2_CONFIG = payload.target_r2_config;
  const TITLE = payload.title || "";
  const MODEL_SIZE = payload.model_size || "medium";
  const SOURCE_URL = payload.source_url;

  // --- SECURITY VALIDATIONS ---
  if (!LESSON_ID || !SOURCE_URL || !TARGET_R2_CONFIG) {
    console.error("❌ Missing mandatory fields");
    process.exit(1);
  }
  if (CALLBACK_URL) {
    try { validateCallbackUrl(CALLBACK_URL); } catch (e) {
      console.error("❌ Invalid Callback URL");
      process.exit(1);
    }
  }
  // --- END SECURITY VALIDATIONS ---

  const workingDir = path.join(os.tmpdir(), `transcribe-job-${JOB_ID || 'default'}`);
  const localVideo = path.join(workingDir, "source_video");
  const localAudio = path.join(workingDir, "audio.wav");
  const intermediatePath = path.join(workingDir, "intermediate.json");
  const resultJsonPath = path.join(workingDir, "transcript.json");

  try {
    // --- PHASE 1: WHISPER ---
    if (!stage || stage === "--stage=whisper") {
      console.log(`🎙️ Phase 1: Transcription started for ${SOURCE_URL}`);
      await fs.mkdir(workingDir, { recursive: true });
      
      await sendCallback(CALLBACK_URL, {
        lessonId: LESSON_ID, jobId: JOB_ID, sourceVersion: SOURCE_VERSION,
        status: "processing",
      }, CALLBACK_CLIENT_ID);

      const response = await fetch(SOURCE_URL);
      if (!response.ok) throw new Error(`Download failed: ${response.statusText}`);
      await pipeline(Readable.fromWeb(response.body! as any), createWriteStream(localVideo));

      const durationSeconds = await getVideoDuration(localVideo);
      await extractAudio(localVideo, localAudio);

      console.log(`🤖 Running Whisper (${MODEL_SIZE})...`);
      const initialPrompt = payload.initial_prompt || "Chào mọi người...";
      const whisperScript = path.join(__dirname, "whisper_runner.py");
      
      const whisperResult: any = await new Promise((resolve, reject) => {
        const pythonProcess = spawn("python3", [whisperScript, localAudio, MODEL_SIZE, initialPrompt]);
        let stdout = "";
        pythonProcess.stdout.on("data", (data) => stdout += data.toString());
        pythonProcess.stderr.on("data", (data) => process.stderr.write(data));
        pythonProcess.on("close", (code) => {
          if (code !== 0) return reject(new Error(`Whisper failed with code ${code}`));
          try { resolve(JSON.parse(stdout)); } catch (e) { reject(new Error("Failed to parse Whisper JSON output")); }
        });
      });

      await fs.writeFile(intermediatePath, JSON.stringify({ whisperResult, durationSeconds }));
      console.log(`✅ Phase 1 Complete. Intermediate data saved.`);
    }

    // --- PHASE 2: GEMINI & CALLBACK ---
    if (!stage || stage === "--stage=gemini") {
      console.log(`✨ Phase 2: AI Cleaning & Callback...`);
      
      let whisperResult: any;
      let durationSeconds: number;

      if (payload.raw_segments) {
        console.log("📦 Using raw segments from payload...");
        whisperResult = {
          segments: payload.raw_segments,
          language: payload.language || "vi",
          full_text: payload.raw_full_text || ""
        };
        durationSeconds = payload.duration_seconds || 0;
      } else {
        console.log("📂 Reading from intermediate file...");
        if (!(readFileSync(intermediatePath))) throw new Error("Intermediate file not found. Phase 1 might have failed.");
        const intermediate = JSON.parse(readFileSync(intermediatePath, "utf-8"));
        whisperResult = intermediate.whisperResult;
        durationSeconds = intermediate.durationSeconds;
      }

      const { cleanedFullText, cleanedSegments, summary, keywords } = await cleanTranscript(whisperResult.segments);

      const finalResult = {
        jobId: JOB_ID, lessonId: LESSON_ID,
        metadata: {
          title: TITLE, language: whisperResult.language,
          durationSeconds: durationSeconds || whisperResult.duration,
          model: MODEL_SIZE, generatedAt: new Date().toISOString(),
          isCleaned: !!process.env.GEMINI_API_KEY,
          summary, keywords
        },
        fullText: cleanedFullText,
        rawFullText: whisperResult.full_text,
        segments: cleanedSegments,
        rawSegments: whisperResult.segments
      };

      await fs.writeFile(resultJsonPath, JSON.stringify(finalResult, null, 2));

      console.log(`☁️ Uploading result to R2...`);
      if (!PRIVATE_KEY) throw new Error("TRANSCODER_PRIVATE_KEY is not set");
      
      const ACCESS_KEY_ID = decrypt(TARGET_R2_CONFIG.access_key_id, PRIVATE_KEY);
      const SECRET_ACCESS_KEY = decrypt(TARGET_R2_CONFIG.secret_access_key, PRIVATE_KEY);
      const client = createR2Client(TARGET_R2_CONFIG.endpoint, ACCESS_KEY_ID, SECRET_ACCESS_KEY);
      const transcriptKey = `${TARGET_R2_CONFIG.prefix}/transcript.json`;
      
      await client.send(new PutObjectCommand({
        Bucket: TARGET_R2_CONFIG.bucket,
        Key: transcriptKey,
        Body: readFileSync(resultJsonPath),
        ContentType: "application/json",
      }));

      const transcriptUrl = `${TARGET_R2_CONFIG.public_base_url.replace(/\/$/, "")}/${transcriptKey}`;
      
      await sendCallback(CALLBACK_URL, {
        lessonId: LESSON_ID, jobId: JOB_ID, sourceVersion: SOURCE_VERSION,
        status: "transcription_ready",
        transcriptUrl, fullText: finalResult.fullText, segments: finalResult.segments,
        metadata: finalResult.metadata
      }, CALLBACK_CLIENT_ID);

      console.log(`✅ Phase 2 Success: ${transcriptUrl}`);
    }

  } catch (error: any) {
    console.error(`❌ Job Failed: ${error?.message}`);
    // Luôn gửi callback failed để BE không bị treo
    await sendCallback(CALLBACK_URL, {
      lessonId: LESSON_ID, jobId: JOB_ID, sourceVersion: SOURCE_VERSION,
      status: "failed", error: String(error?.message || error),
    }, CALLBACK_CLIENT_ID);
    process.exit(1);
  } finally {
    // Chỉ dọn dẹp sau khi hoàn tất giai đoạn cuối cùng
    if (!stage || stage === "--stage=gemini") {
      await fs.rm(workingDir, { recursive: true, force: true }).catch(() => {});
      try { await fs.unlink(payloadPath); } catch (e) {}
    }
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runTranscriptionJob();
}
