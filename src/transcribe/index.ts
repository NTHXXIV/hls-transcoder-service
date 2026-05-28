import { spawn } from "node:child_process";
import {
  createWriteStream,
  promises as fs,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";

import { sendCallback } from "../shared/callback.js";
import { extractAudio, getVideoDuration } from "../shared/utils.js";
import { cleanTranscript } from "./cleaner.js";
import { summarizeTranscript } from "./summarizer.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Validates the mandatory fields in the payload (Exported for Testing)
 * Validation is mode-aware:
 * - whisper: requires source_url
 * - clean:   requires raw_url (or raw inline)
 * - summarize: requires clean_url
 */
export function validatePayload(payload: any, mode?: string) {
  const resourceId = payload.resource_id || payload.lesson_id;
  if (!resourceId) {
    throw new Error("Missing mandatory field: resource_id");
  }

  if (mode === "--clean") {
    if (!payload.raw && !payload.raw_url) {
      throw new Error("Missing mandatory field for clean mode: raw_url (or raw)");
    }
    return;
  }

  if (mode === "--summarize") {
    if (!payload.clean_url) {
      throw new Error("Missing mandatory field for summarize mode: clean_url");
    }
    return;
  }

  // Default: whisper mode
  if (!payload.source_url) {
    throw new Error("Missing mandatory field for whisper mode: source_url");
  }
}

export async function runTranscriptionJob() {
  const payloadPath = process.argv[2];
  const mode = process.argv[3];

  if (!payloadPath) process.exit(1);
  const payload = JSON.parse(await fs.readFile(payloadPath, "utf-8"));
  const resourceId = payload.resource_id || payload.lesson_id;
  const jobId = payload.job_id || resourceId;
  const workingDir = path.join(os.tmpdir(), `transcribe-${jobId}-${Date.now()}`);

  try {
    validatePayload(payload, mode);
    await fs.mkdir(workingDir, { recursive: true });

    // --- MODE: WHISPER ---
    if (mode === "--whisper") {
      console.log(`🎙️ Running Whisper: ${jobId}`);
      const localVideo = path.join(workingDir, "video");
      const localAudio = path.join(workingDir, "audio.wav");

      await sendCallback(payload.callback_url, { resourceId, jobId: payload.job_id, status: "whisper_processing" }, payload.callback_client_id);

      const response = await fetch(payload.source_url);
      await pipeline(Readable.fromWeb(response.body! as any), createWriteStream(localVideo));
      const durationSeconds = await getVideoDuration(localVideo);
      await extractAudio(localVideo, localAudio);

      const whisperResult: any = await new Promise((resolve, reject) => {
        const pythonProcess = spawn("python3", [path.join(__dirname, "whisper_runner.py"), localAudio, payload.model_size || "medium", payload.initial_prompt || ""]);
        let stdout = "";
        pythonProcess.stdout.on("data", (d) => stdout += d);
        pythonProcess.stderr.on("data", (d) => process.stderr.write(d));
        pythonProcess.on("close", (c) => c === 0 ? resolve(JSON.parse(stdout)) : reject(new Error("Whisper engine failed")));
      });

      await sendCallback(payload.callback_url, {
        resourceId,
        jobId: payload.job_id,
        status: "whisper_success",
        fullText: whisperResult.full_text,
        segments: whisperResult.segments,
        metadata: { title: payload.title, durationSeconds, model: payload.model_size, isCleaned: false },
      }, payload.callback_client_id, { throwOnFail: true });
    }

    // --- MODE: CLEAN ---
    if (mode === "--clean") {
      console.log(`✨ Running Clean: ${jobId}`);

      let raw = payload.raw;
      if (!raw && payload.raw_url) {
        console.log(`📥 Fetching raw transcript from: ${payload.raw_url}`);
        const rawResp = await fetch(payload.raw_url);
        if (!rawResp.ok) throw new Error(`Failed to fetch raw transcript (${rawResp.status})`);
        raw = await rawResp.json();
      }

      await sendCallback(payload.callback_url, { resourceId, jobId: payload.job_id, status: "clean_processing" }, payload.callback_client_id);

      const { cleanedFullText, cleanedSegments } = await cleanTranscript(raw.segments);
      const finalSegments = cleanedSegments.filter((s: any) => s.text && s.text.trim().length > 0);

      await sendCallback(payload.callback_url, {
        resourceId,
        jobId: payload.job_id,
        status: "clean_success",
        fullText: cleanedFullText,
        segments: finalSegments,
        metadata: { title: payload.title, durationSeconds: raw.duration_seconds, isCleaned: true },
      }, payload.callback_client_id, { throwOnFail: true });
    }

    // --- MODE: SUMMARIZE ---
    if (mode === "--summarize") {
      console.log(`📝 Running Summarize: ${jobId}`);

      await sendCallback(payload.callback_url, { resourceId, jobId: payload.job_id, status: "summarize_processing" }, payload.callback_client_id);

      console.log(`📥 Fetching clean transcript from: ${payload.clean_url}`);
      const cleanResp = await fetch(payload.clean_url);
      if (!cleanResp.ok) throw new Error(`Failed to fetch clean transcript (${cleanResp.status})`);
      const clean: any = await cleanResp.json();

      const fullText: string = clean.fullText || clean.full_text || "";
      if (!fullText.trim()) throw new Error("Clean transcript has no fullText");

      const { summary, keywords } = await summarizeTranscript(fullText);

      await sendCallback(payload.callback_url, {
        resourceId,
        jobId: payload.job_id,
        status: "summarize_success",
        fullText,
        metadata: { ...clean.metadata, isCleaned: true, summary, keywords },
      }, payload.callback_client_id, { throwOnFail: true });
    }

  } catch (error: any) {
    console.error(`❌ Error: ${error.message}`);
    const status = mode === "--whisper" ? "whisper_failed"
      : mode === "--summarize" ? "summarize_failed"
      : "clean_failed";
    await sendCallback(payload.callback_url, { resourceId, jobId: payload.job_id, status, error: error.message }, payload.callback_client_id);
    process.exit(1);
  } finally {
    await fs.rm(workingDir, { recursive: true, force: true }).catch(() => {});
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runTranscriptionJob();
}
