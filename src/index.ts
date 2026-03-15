/**
 * Mentra Gemini Bridge
 * ====================
 * Uses the MentraOS SDK to start an unmanaged RTMP stream from the glasses
 * directly to MediaMTX (running on this server), records it, then analyzes
 * the recording with Gemini when the session ends.
 *
 * Flow:
 *   Glasses → RTMP (port 1935) → MediaMTX → /tmp/mentra_<timestamp>.mp4
 *                                                       ↓
 *                                         Gemini API → /tmp/analysis_<id>.txt
 *
 * Requirements:
 *   - bun runtime
 *   - mediamtx binary (path set via MEDIAMTX_BIN)
 *   - Port 1935 open (TCP inbound) in Oracle Cloud VCN + OS firewall
 *   - PACKAGE_NAME, MENTRAOS_API_KEY, GEMINI_API_KEY, PUBLIC_IP in .env
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

// MediaMTX
const MEDIAMTX_BIN =
  process.env.MEDIAMTX_BIN ??
  "/home/ubuntu/dev/biodexic-glasses-operator/server/mediamtx";
const MEDIAMTX_CONFIG =
  process.env.MEDIAMTX_CONFIG ??
  path.join(import.meta.dir, "..", "mediamtx.yml");

// Unmanaged RTMP: glasses push directly to MediaMTX on this server
const PUBLIC_IP = process.env.PUBLIC_IP ?? "";
const RTMP_PORT = parseInt(process.env.RTMP_PORT ?? "1935");
const RTMP_STREAM_PATH = "live/mentra";

// MediaMTX writes this file when a recording segment completes
const RECORDING_SENTINEL = "/tmp/mentra_recording_ready";

if (!PACKAGE_NAME || !API_KEY) {
  console.error("PACKAGE_NAME and MENTRAOS_API_KEY must be set.");
  process.exit(1);
}
if (!GEMINI_API_KEY) {
  console.error("GEMINI_API_KEY must be set.");
  process.exit(1);
}
if (!PUBLIC_IP) {
  console.error("PUBLIC_IP must be set (e.g. 163.192.31.247).");
  process.exit(1);
}

const RTMP_URL = `rtmp://${PUBLIC_IP}:${RTMP_PORT}/${RTMP_STREAM_PATH}`;

const ai = new GoogleGenAI({ apiKey: GEMINI_API_KEY });

// ---------------------------------------------------------------------------
// MediaMTX process (can also be run manually in a separate screen window)
// ---------------------------------------------------------------------------
let mediamtxProcess: ChildProcess | null = null;

function startMediaMTX(): void {
  // Skip if already running (e.g. started manually in a screen window)
  const check = Bun.spawnSync(["ss", "-tlnp"]);
  const ssOutput = new TextDecoder().decode(check.stdout);
  if (ssOutput.includes(`:${RTMP_PORT}`)) {
    console.log(`MediaMTX already listening on port ${RTMP_PORT} — skipping auto-start`);
    return;
  }
  if (!fs.existsSync(MEDIAMTX_BIN)) {
    console.warn(`MediaMTX binary not found at ${MEDIAMTX_BIN} — start it manually`);
    return;
  }
  console.log(`Starting MediaMTX (${MEDIAMTX_BIN})…`);
  mediamtxProcess = spawn(MEDIAMTX_BIN, [MEDIAMTX_CONFIG], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  mediamtxProcess.stdout?.on("data", (d: Buffer) =>
    process.stdout.write(`[mediamtx] ${d}`),
  );
  mediamtxProcess.stderr?.on("data", (d: Buffer) =>
    process.stderr.write(`[mediamtx] ${d}`),
  );
  mediamtxProcess.on("close", (code) => {
    console.log(`MediaMTX exited (code=${code})`);
    mediamtxProcess = null;
  });
}

// ---------------------------------------------------------------------------
// Recording sentinel helpers
// ---------------------------------------------------------------------------

/** Delete the sentinel so we don't pick up a stale recording from a previous session. */
function clearSentinel(): void {
  try {
    fs.unlinkSync(RECORDING_SENTINEL);
  } catch {}
}

/**
 * Wait for MediaMTX to write the sentinel file (fired by runOnRecordSegmentComplete).
 * Returns the recording file path, or null on timeout.
 */
async function waitForSentinel(
  sessionId: string,
  timeoutMs = 20_000,
): Promise<string | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fs.existsSync(RECORDING_SENTINEL)) {
      return fs.readFileSync(RECORDING_SENTINEL, "utf8").trim();
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  console.warn(`[${sessionId}] Timed out waiting for recording sentinel`);
  return null;
}

// ---------------------------------------------------------------------------
// Per-session state
// ---------------------------------------------------------------------------
interface SessionState {
  analysisTriggered: boolean;
  isStreaming: boolean;
}

const sessionStates = new Map<string, SessionState>();

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
    `[${sessionId}] Uploading ${Math.round(fileSize / 1024)} KB to Gemini…`,
  );
  let videoFile = await ai.files.upload({
    file: recordingPath,
    config: {
      mimeType: "video/mp4",
      displayName: `session_${sessionId}`,
    },
  });

  console.log(`[${sessionId}] Waiting for Gemini to process video…`);
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

  console.log(`[${sessionId}] Running analysis with ${GEMINI_MODEL}…`);
  const response = await ai.models.generateContent({
    model: GEMINI_MODEL,
    contents: createUserContent([
      createPartFromUri(videoFile.uri!, videoFile.mimeType || "video/mp4"),
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
    `[${sessionId}] Preview:\n${result.slice(0, 400)}${result.length > 400 ? "…" : ""}`,
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

    const state: SessionState = {
      analysisTriggered: false,
      isStreaming: false,
    };
    sessionStates.set(sessionId, state);

    // Clear any stale stream from a previous session
    try {
      const existing = await session.camera.checkExistingStream();
      if (existing.hasActiveStream) {
        console.log(
          `[${sessionId}] Stale ${existing.streamInfo?.type} stream found — clearing it`,
        );
        if (existing.streamInfo?.type === "managed") {
          await session.camera.stopManagedStream();
        } else {
          await session.camera.stopStream();
        }
        await new Promise((r) => setTimeout(r, 1000));
      }
    } catch (err) {
      console.warn(`[${sessionId}] Stream pre-check failed (non-fatal):`, err);
    }

    // RTMP stream status from glasses
    session.camera.onStreamStatus(async (status) => {
      console.log(`[${sessionId}] Stream status: ${status.status}`);

      if (status.status === "streaming" || status.status === "active") {
        state.isStreaming = true;
      }

      const terminalStatuses = [
        "stopped",
        "disconnected",
        "timeout",
        "reconnect_failed",
      ];
      if (terminalStatuses.includes(status.status)) {
        state.isStreaming = false;
        if (!state.analysisTriggered) {
          state.analysisTriggered = true;
          waitForSentinel(sessionId)
            .then((recordingPath) => {
              if (recordingPath)
                return analyzeVideo(recordingPath, sessionId);
              console.error(`[${sessionId}] No recording found after stop`);
            })
            .catch((err) =>
              console.error(`[${sessionId}] Gemini analysis error:`, err),
            );
        }
      }

      if (status.status === "error") {
        state.isStreaming = false;
        console.error(
          `[${sessionId}] Stream error: ${status.errorDetails ?? "unknown"}`,
        );
      }
    });

    // Button handler registered via session.events (same pattern as the
    // MentraOS Camera Example App) — this signals to MentraOS that the app
    // wants to handle the button, suppressing the default close-app behaviour.
    // Short press while recording → stop + analyse
    // Short press while idle    → start a new recording
    session.events.onButtonPress(async (btn) => {
      console.log(`[${sessionId}] Button: id=${btn.buttonId} type=${btn.pressType}`);
      if (btn.pressType !== "short") return;

      if (state.isStreaming) {
        console.log(`[${sessionId}] ■ Stopping recording (button press)`);
        state.isStreaming = false;
        session.camera
          .stopStream()
          .catch((err) =>
            console.error(`[${sessionId}] stopStream error:`, err),
          );
        if (!state.analysisTriggered) {
          state.analysisTriggered = true;
          waitForSentinel(sessionId)
            .then((recordingPath) => {
              if (recordingPath) return analyzeVideo(recordingPath, sessionId);
              console.error(`[${sessionId}] No recording found after stop`);
            })
            .catch((err) =>
              console.error(`[${sessionId}] Gemini analysis error:`, err),
            );
        }
      } else {
        console.log(`[${sessionId}] ▶ Starting new recording (button press)`);
        clearSentinel();
        state.analysisTriggered = false;
        state.isStreaming = true;
        session.camera
          .startStream({ rtmpUrl: RTMP_URL })
          .catch((err) => {
            console.error(`[${sessionId}] startStream error:`, err);
            state.isStreaming = false;
          });
      }
    });

    // Auto-start: recording begins immediately when the session opens.
    clearSentinel();
    state.isStreaming = true;
    session.camera
      .startStream({ rtmpUrl: RTMP_URL })
      .catch((err) => {
        console.error(`[${sessionId}] startStream error:`, err);
        state.isStreaming = false;
      });
    console.log(`[${sessionId}] Stream requested → ${RTMP_URL}`);
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
    sessionStates.delete(sessionId);

    if (state && state.isStreaming && !state.analysisTriggered) {
      state.analysisTriggered = true;
      // Glasses are disconnecting — MediaMTX will finalize the recording shortly
      waitForSentinel(sessionId, 20_000)
        .then((recordingPath) => {
          if (recordingPath) return analyzeVideo(recordingPath, sessionId);
          console.error(`[${sessionId}] No recording found after session end`);
        })
        .catch((err) => console.error(`[${sessionId}] Stop error:`, err));
    }
  }
}

// ---------------------------------------------------------------------------
// Start server
// ---------------------------------------------------------------------------
startMediaMTX();

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
console.log(`  RTMP:      ${RTMP_URL}`);
console.log(`  Model:     ${GEMINI_MODEL}`);
console.log(`  Output:    ${RECORDING_DIR}/`);
console.log("=".repeat(50));
console.log("Waiting for glasses session…\n");

const shutdown = async () => {
  console.log("\nShutting down…");
  mediamtxProcess?.kill("SIGTERM");
  await app.stop();
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
