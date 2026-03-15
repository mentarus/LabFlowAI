/**
 * Mentra Gemini Bridge
 * ====================
 * Uses the MentraOS SDK to start a managed stream from the glasses,
 * records the HLS output to disk with ffmpeg, then analyzes the
 * recording with Gemini when the session ends.
 *
 * Flow:
 *   Glasses → MentraOS Cloud (managed stream) → HLS URL
 *                                                  ↓
 *                                    ffmpeg records → /tmp/session_<id>.mp4
 *                                                  ↓
 *                                    Gemini API → /tmp/analysis_<id>.txt
 *
 * Requirements:
 *   - bun runtime
 *   - ffmpeg on PATH
 *   - PACKAGE_NAME, MENTRAOS_API_KEY, GEMINI_API_KEY in .env
 */

import { AppServer, AppSession } from "@mentra/sdk";
import {
  GoogleGenAI,
  createPartFromUri,
  createUserContent,
} from "@google/genai";
import { spawn, type ChildProcess } from "child_process";
import * as fs from "fs";
import * as path from "path";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------
const PORT = parseInt(process.env.PORT ?? "3000");
const PACKAGE_NAME = process.env.PACKAGE_NAME ?? "";
const API_KEY = process.env.MENTRAOS_API_KEY ?? "";
const GEMINI_API_KEY = process.env.GEMINI_API_KEY ?? "";
const GEMINI_MODEL =
  process.env.GEMINI_MODEL ?? "gemini-robotics-er-1.5-preview";
const GEMINI_TEMPERATURE = parseFloat(process.env.GEMINI_TEMPERATURE ?? "0.2");
const GEMINI_THINKING_BUDGET = parseInt(
  process.env.GEMINI_THINKING_BUDGET ?? "8192",
);
const GEMINI_PROMPT =
  process.env.GEMINI_PROMPT ??
  `Analyze the execution of the following protocol given the video:

\`\`\`
Step-by-Step Procedure (Volumes given for a standard T75 flask) Use Each Step as Subtask
1. Wash the Cells
   * Carefully aspirate the old culture media from the flask.
   * Add 10 mL of warmed DPBS to the flask.
   * CRITICAL: Dispense the DPBS gently down the side of the flask opposite the cell monolayer.
   * Gently rock the flask back and forth to wash away residual serum (which contains trypsin inhibitors).
   * Aspirate the DPBS.
2. Detach the Cells
   * Add 2 mL of warmed Trypsin-EDTA to the flask.
   * Rock the flask gently to ensure the trypsin covers the entire cell layer.
   * Incubate at room temperature for 1 minute.
   * Note: 293T cells detach very quickly. Tap the side of the flask gently with the palm of your hand to detach.
3. Neutralize and Resuspend
   * Immediately add 8 mL of Complete Growth Media to the flask to neutralize the trypsin (the FBS inhibits the trypsin). You should now have a total volume of 10 mL.
   * Add 14ml of media to the new flask
   * Pipette the suspension up and down gently 5 times to break up cell clumps. Wash the growth surface of the flask with the liquid to catch any stragglers.
4. Plate the Cells
   * For a 1:10 split: Add 1 mL of your cell suspension to a new T75 flask containing 14 mL of fresh Complete Growth Media (15 mL total volume).
   * Gently rock the new flask in a cross-like pattern (left-to-right, then top-to-bottom) to evenly distribute the cells. Do not swirl in a circular motion, as this causes cells to pool in the center of the flask.
5. Incubate
   * Place the flask back into the 37°C, 5% CO₂ incubator.
   * Check the cells the next day to ensure they have attached and are growing evenly.
\`\`\``;
const RECORDING_DIR = process.env.RECORDING_DIR ?? "/tmp";
const STREAM_QUALITY = (process.env.STREAM_QUALITY ?? "720p") as
  | "720p"
  | "1080p";

if (!PACKAGE_NAME || !API_KEY) {
  console.error("PACKAGE_NAME and MENTRAOS_API_KEY must be set.");
  process.exit(1);
}
if (!GEMINI_API_KEY) {
  console.error("GEMINI_API_KEY must be set.");
  process.exit(1);
}

const ai = new GoogleGenAI({ apiKey: GEMINI_API_KEY });

// ---------------------------------------------------------------------------
// Per-session state
// ---------------------------------------------------------------------------
interface SessionState {
  ffmpegProcess: ChildProcess | null;
  recordingPath: string;
  analysisTriggered: boolean;
}

const sessionStates = new Map<string, SessionState>();

// ---------------------------------------------------------------------------
// Recording helpers
// ---------------------------------------------------------------------------
function startRecording(
  hlsUrl: string,
  recordingPath: string,
  sessionId: string,
): ChildProcess {
  const ffmpeg = spawn(
    "ffmpeg",
    [
      "-y",
      "-i",
      hlsUrl,
      "-c",
      "copy",
      // Fragmented MP4: keeps file valid even if ffmpeg is interrupted
      "-movflags",
      "frag_keyframe+empty_moov",
      recordingPath,
    ],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  // ffmpeg writes progress to stderr
  ffmpeg.stderr?.on("data", (d: Buffer) => process.stdout.write(d));
  ffmpeg.on("close", (code) =>
    console.log(`[${sessionId}] ffmpeg exited (code=${code})`),
  );
  return ffmpeg;
}

function stopRecording(
  state: SessionState,
  sessionId: string,
): Promise<void> {
  return new Promise((resolve) => {
    if (!state.ffmpegProcess) return resolve();
    const proc = state.ffmpegProcess;
    state.ffmpegProcess = null;
    // SIGINT lets ffmpeg flush and finalize the MP4 moov atom
    proc.kill("SIGINT");
    const timeout = setTimeout(() => {
      proc.kill("SIGKILL");
      resolve();
    }, 8000);
    proc.once("close", () => {
      clearTimeout(timeout);
      resolve();
    });
  });
}

// ---------------------------------------------------------------------------
// Gemini analysis
// ---------------------------------------------------------------------------
async function analyzeVideo(
  recordingPath: string,
  sessionId: string,
): Promise<void> {
  if (!fs.existsSync(recordingPath)) {
    console.error(`[${sessionId}] Recording not found: ${recordingPath}`);
    return;
  }
  const fileSize = fs.statSync(recordingPath).size;
  if (fileSize < 1024) {
    console.log(
      `[${sessionId}] Recording too small (${fileSize} B), skipping analysis.`,
    );
    return;
  }

  console.log(
    `[${sessionId}] Uploading ${Math.round(fileSize / 1024)} KB to Gemini...`,
  );
  let videoFile = await ai.files.upload({
    file: recordingPath,
    config: {
      mimeType: "video/mp4",
      displayName: `session_${sessionId}`,
    },
  });

  console.log(`[${sessionId}] Waiting for Gemini to process video...`);
  while (videoFile.state?.toString() === "PROCESSING") {
    await new Promise((r) => setTimeout(r, 3000));
    videoFile = await ai.files.get({ name: videoFile.name! });
    if (videoFile.state?.toString() === "FAILED") {
      console.error(`[${sessionId}] Gemini file processing failed.`);
      return;
    }
  }
  if (videoFile.state?.toString() !== "ACTIVE") {
    console.error(
      `[${sessionId}] Unexpected Gemini file state: ${videoFile.state}`,
    );
    return;
  }

  console.log(`[${sessionId}] Running analysis with ${GEMINI_MODEL}...`);
  const response = await ai.models.generateContent({
    model: GEMINI_MODEL,
    contents: createUserContent([
      createPartFromUri(
        videoFile.uri!,
        videoFile.mimeType || "video/mp4",
      ),
      GEMINI_PROMPT,
    ]),
    config: {
      temperature: GEMINI_TEMPERATURE,
      thinkingConfig: { thinkingBudget: GEMINI_THINKING_BUDGET },
    },
  });

  const result = (response.text ?? "").replace(/\n{3,}/g, "\n\n");
  const outputPath = path.join(RECORDING_DIR, `analysis_${sessionId}.txt`);
  fs.writeFileSync(outputPath, result);

  console.log(`[${sessionId}] Analysis saved → ${outputPath}`);
  console.log(
    `[${sessionId}] Preview:\n${result.slice(0, 400)}${result.length > 400 ? "..." : ""}`,
  );

  try {
    await ai.files.delete({ name: videoFile.name! });
  } catch (e) {
    console.warn(`[${sessionId}] Could not delete Gemini upload:`, e);
  }
}

// ---------------------------------------------------------------------------
// App
// ---------------------------------------------------------------------------
class GeminiStreamApp extends AppServer {
  protected async onSession(
    session: AppSession,
    sessionId: string,
    userId: string,
  ): Promise<void> {
    console.log(`[${sessionId}] Session started (user=${userId})`);

    const recordingPath = path.join(
      RECORDING_DIR,
      `session_${sessionId}.mp4`,
    );
    const state: SessionState = {
      ffmpegProcess: null,
      recordingPath,
      analysisTriggered: false,
    };
    sessionStates.set(sessionId, state);

    session.camera.onManagedStreamStatus(async (status) => {
      console.log(`[${sessionId}] Stream status: ${status.status}`);

      if (status.status === "active" && status.hlsUrl) {
        // Handle mid-session reconnects: stop previous ffmpeg before starting new one
        if (state.ffmpegProcess) {
          console.log(`[${sessionId}] Stream reconnected — restarting recording`);
          await stopRecording(state, sessionId);
        }
        console.log(`[${sessionId}] Recording HLS → ${recordingPath}`);
        state.ffmpegProcess = startRecording(
          status.hlsUrl,
          recordingPath,
          sessionId,
        );
      }

      if (status.status === "stopped") {
        await stopRecording(state, sessionId);
        if (!state.analysisTriggered) {
          state.analysisTriggered = true;
          analyzeVideo(recordingPath, sessionId).catch((err) =>
            console.error(`[${sessionId}] Gemini analysis error:`, err),
          );
        }
      }

      if (status.status === "error") {
        console.error(`[${sessionId}] Stream error — stopping recording`);
        await stopRecording(state, sessionId);
      }
    });

    await session.camera.startManagedStream({ quality: STREAM_QUALITY });
    console.log(`[${sessionId}] Managed stream requested (quality=${STREAM_QUALITY})`);
  }

  protected async onStop(
    sessionId: string,
    userId: string,
    reason: string,
  ): Promise<void> {
    console.log(
      `[${sessionId}] Session ended (user=${userId}, reason=${reason})`,
    );
    const state = sessionStates.get(sessionId);
    if (state) {
      await stopRecording(state, sessionId);
      sessionStates.delete(sessionId);
    }
  }
}

// ---------------------------------------------------------------------------
// Start server
// ---------------------------------------------------------------------------
const app = new GeminiStreamApp({
  packageName: PACKAGE_NAME,
  apiKey: API_KEY,
  port: PORT,
});

await app.start();

Bun.serve({
  port: PORT,
  idleTimeout: 120,
  fetch: (req) => app.fetch(req),
});

console.log("=".repeat(50));
console.log("Mentra Gemini Bridge");
console.log(`  Port:      ${PORT}`);
console.log(`  Package:   ${PACKAGE_NAME}`);
console.log(`  Model:     ${GEMINI_MODEL}`);
console.log(`  Quality:   ${STREAM_QUALITY}`);
console.log(`  Output:    ${RECORDING_DIR}/`);
console.log("=".repeat(50));
console.log("Waiting for glasses session...\n");

const shutdown = async () => {
  console.log("\nShutting down...");
  await app.stop();
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
