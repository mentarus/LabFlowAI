/**
 * Mentra Protocol Observer
 * ========================
 * Steps through a lab protocol one step at a time.
 * Each step is recorded with the glasses camera and analysed by Gemini,
 * which returns a JSON pass/fail result shown on the glasses HUD.
 *
 * Button flow:
 *   idle        → short press → start recording step N
 *   recording   → short press → stop + Gemini analysis (shows "Analyzing…")
 *   result      → short press → start recording step N+1 (or show summary)
 *   done        → short press → reset and go back to idle
 *
 * Webview: served at /webview and /, live-updates via SSE at /api/protocol-stream
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
const RECORDING_DIR = process.env.RECORDING_DIR ?? "/tmp";

// MediaMTX
const MEDIAMTX_BIN =
  process.env.MEDIAMTX_BIN ??
  "/home/ubuntu/dev/biodexic-glasses-operator/server/mediamtx";
const MEDIAMTX_CONFIG =
  process.env.MEDIAMTX_CONFIG ??
  path.join(import.meta.dir, "..", "mediamtx.yml");

// Unmanaged RTMP
const PUBLIC_IP = process.env.PUBLIC_IP ?? "";
const RTMP_PORT = parseInt(process.env.RTMP_PORT ?? "1935");
const RTMP_STREAM_PATH = "live/mentra";
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
// Protocol definition
// ---------------------------------------------------------------------------
interface ProtocolStep {
  name: string;
  instructions: string;
}

const PROTOCOL_STEPS: ProtocolStep[] = [
  {
    name: "Wash the Cells",
    instructions:
      "Aspirate old media. Add 10 mL warmed DPBS gently down the side of the flask (opposite the cell monolayer). Rock gently to wash away residual serum. Aspirate the DPBS.",
  },
  {
    name: "Detach the Cells",
    instructions:
      "Add 2 mL warmed Trypsin-EDTA. Rock to cover the entire cell layer. Incubate at room temperature for 1 min. Tap the flask gently to detach 293T cells.",
  },
  {
    name: "Neutralize and Resuspend",
    instructions:
      "Add 8 mL Complete Growth Media to neutralize trypsin (total 10 mL). Add 14 mL media to the new flask. Pipette suspension up and down 5x to break up clumps.",
  },
  {
    name: "Plate the Cells",
    instructions:
      "1:10 split: Add 1 mL cell suspension to a new T75 with 14 mL fresh media (15 mL total). Rock in a cross pattern (L-R then top-bottom). Do not swirl.",
  },
  {
    name: "Incubate",
    instructions:
      "Place flask in 37 C, 5% CO2 incubator. Check next day to confirm attachment and even growth.",
  },
];

function buildStepPrompt(step: ProtocolStep, stepIndex: number): string {
  return (
    `You are evaluating whether a lab protocol step was performed correctly based on a video recording.\n\n` +
    `Step ${stepIndex + 1}: ${step.name}\n` +
    `Expected procedure: ${step.instructions}\n\n` +
    `Analyse the video and respond ONLY with a JSON object in this exact format (no markdown, no extra text):\n` +
    `{\n` +
    `  "step": ${stepIndex + 1},\n` +
    `  "name": "${step.name}",\n` +
    `  "performed_correctly": true or false,\n` +
    `  "deviation": null or "brief description of what was done incorrectly"\n` +
    `}`
  );
}

// ---------------------------------------------------------------------------
// Webview HTML
// ---------------------------------------------------------------------------
const WEBVIEW_HTML = `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
  <meta name="mobile-web-app-capable" content="yes">
  <title>Protocol Observer</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      background: #0a0a0f;
      color: #e0e0e0;
      font-family: -apple-system, system-ui, sans-serif;
      padding: 16px;
      min-height: 100vh;
    }
    h1 { font-size: 18px; color: #6eb5ff; margin-bottom: 4px; }
    .subtitle { font-size: 12px; color: #555; margin-bottom: 14px; }
    .conn-row {
      display: flex; align-items: center; gap: 6px;
      font-size: 11px; color: #555; margin-bottom: 14px;
    }
    .dot { width: 7px; height: 7px; border-radius: 50%; background: #555; flex-shrink: 0; }
    .dot.on { background: #6bcb77; }
    .summary {
      background: #0e2218; border-radius: 8px; padding: 12px;
      margin-bottom: 14px; text-align: center; font-size: 14px; font-weight: 600;
      display: none;
    }
    .phase-banner {
      background: #1a1a2e; border-radius: 8px; padding: 10px 14px;
      margin-bottom: 14px; font-size: 13px; color: #aaa;
      display: none;
    }
    .step {
      background: #13131f; border-radius: 8px; padding: 12px;
      margin-bottom: 10px; border-left: 4px solid #2a2a3e;
      transition: border-color 0.25s, background 0.25s;
    }
    .step.recording  { border-color: #e56060; background: #1f1318; }
    .step.analyzing  { border-color: #e5c060; background: #1f1c13; }
    .step.pass       { border-color: #60c060; background: #131f13; }
    .step.fail       { border-color: #e56060; background: #1f1313; }
    .step-row { display: flex; justify-content: space-between; align-items: center; margin-bottom: 5px; }
    .step-name { font-weight: 600; font-size: 13px; }
    .badge {
      font-size: 10px; padding: 2px 7px; border-radius: 10px;
      font-weight: 700; letter-spacing: 0.03em; flex-shrink: 0; margin-left: 8px;
    }
    .badge.recording { background: #e5606033; color: #e56060; }
    .badge.analyzing { background: #e5c06033; color: #e5c060; }
    .badge.pass      { background: #60c06033; color: #60c060; }
    .badge.fail      { background: #e5606033; color: #e56060; }
    .badge.waiting   { background: #2a2a3e44; color: #555; }
    .instructions {
      font-size: 11px; color: #777; line-height: 1.5;
      padding-top: 5px; border-top: 1px solid #1e1e30;
    }
    .instructions.active { color: #aaa; }
    .result-ok {
      font-size: 11px; color: #70c070; margin-top: 6px; line-height: 1.45;
      padding-top: 6px; border-top: 1px solid #1a2a1a;
    }
    .deviation {
      font-size: 11px; color: #e09090; margin-top: 6px; line-height: 1.45;
      padding-top: 6px; border-top: 1px solid #2a1a1a;
    }
  </style>
</head>
<body>
  <h1>Protocol Observer</h1>
  <p class="subtitle">${PROTOCOL_STEPS.length} steps &mdash; Cell Passaging (T75)</p>
  <div class="conn-row">
    <div class="dot" id="dot"></div>
    <span id="conn-label">Loading...</span>
  </div>
  <div class="summary" id="summary"></div>
  <div class="phase-banner" id="phase-banner"></div>
  <div id="steps"></div>

  <script>
    var STEPS = ${JSON.stringify(PROTOCOL_STEPS.map((s) => ({ name: s.name, instructions: s.instructions })))};

    function esc(str) {
      return String(str).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;");
    }

    function render(s) {
      var stepsEl = document.getElementById("steps");
      var summaryEl = document.getElementById("summary");
      var bannerEl  = document.getElementById("phase-banner");

      var recorded = s.stepsRecorded || 0;
      var pending  = s.pendingAnalyses || 0;

      var bannerText =
        s.phase === "idle"      ? "Press the right button to begin Step 1" :
        s.phase === "recording" ? "Recording step " + (s.currentStep + 1) + " — press button to advance" :
        s.phase === "done" && pending > 0 ? "Analyzing " + pending + " step" + (pending > 1 ? "s" : "") + " in background..." :
        s.phase === "done" && pending === 0 && s.stepResults.length > 0 ? "Protocol complete — press button to restart" :
        "";
      bannerEl.style.display = bannerText ? "block" : "none";
      bannerEl.textContent = bannerText;

      // Summary bar: only show when all analyses are done
      if (s.phase === "done" && pending === 0 && s.stepResults.length > 0) {
        var passed = s.stepResults.filter(function(r) { return r.performed_correctly; }).length;
        summaryEl.style.display = "block";
        summaryEl.textContent = "Complete: " + passed + "/" + STEPS.length + " steps passed";
        summaryEl.style.color = passed === STEPS.length ? "#6bcb77" : "#e5c060";
      } else {
        summaryEl.style.display = "none";
      }

      stepsEl.innerHTML = STEPS.map(function(step, i) {
        var result = (s.stepResults || []).find(function(r) { return r.step === i + 1; });
        // A step is "analyzing" if it has been recorded but no result yet
        var hasBeenRecorded = i < recorded;
        var isCurrent = (s.currentStep === i) && s.phase === "recording";
        var status = "waiting", badge = "WAITING";
        var extraHtml = '<div class="instructions">' + esc(step.instructions) + '</div>';

        if (result) {
          status = result.performed_correctly ? "pass" : "fail";
          badge  = result.performed_correctly ? "PASS" : "DEVIATION";
          if (result.performed_correctly) {
            extraHtml = '<div class="result-ok">Step performed correctly.</div>'
              + '<div class="instructions">' + esc(step.instructions) + '</div>';
          } else {
            extraHtml = (result.deviation ? '<div class="deviation">' + esc(result.deviation) + '</div>' : '')
              + '<div class="instructions">' + esc(step.instructions) + '</div>';
          }
        } else if (isCurrent) {
          status = "recording"; badge = "REC";
          extraHtml = '<div class="instructions active">' + esc(step.instructions) + '</div>';
        } else if (hasBeenRecorded) {
          status = "analyzing"; badge = "ANALYZING";
        }

        return '<div class="step ' + status + '">'
          + '<div class="step-row">'
          + '<span class="step-name">' + (i + 1) + '. ' + esc(step.name) + '</span>'
          + '<span class="badge ' + status + '">' + badge + '</span>'
          + '</div>'
          + extraHtml
          + '</div>';
      }).join("");
    }

    render({ phase: "idle", currentStep: 0, stepResults: [] });

    var token = new URLSearchParams(window.location.search).get("token") || "";
    var apiUrl = "/api/protocol-state" + (token ? "?token=" + encodeURIComponent(token) : "");

    function poll() {
      fetch(apiUrl)
        .then(function(r) {
          if (!r.ok) throw new Error(r.status);
          document.getElementById("dot").className = "dot on";
          document.getElementById("conn-label").textContent = "Live";
          return r.json();
        })
        .then(function(s) { render(s); })
        .catch(function() {
          document.getElementById("dot").className = "dot";
          document.getElementById("conn-label").textContent = "Reconnecting...";
        })
        .finally(function() { setTimeout(poll, 2000); });
    }
    poll();
  </script>
</body>
</html>`;

// ---------------------------------------------------------------------------
// MediaMTX
// ---------------------------------------------------------------------------
let mediamtxProcess: ChildProcess | null = null;

function startMediaMTX(): void {
  const check = Bun.spawnSync(["ss", "-tlnp"]);
  const ssOutput = new TextDecoder().decode(check.stdout);
  if (ssOutput.includes(`:${RTMP_PORT}`)) {
    console.log(
      `MediaMTX already on port ${RTMP_PORT} — skipping auto-start`,
    );
    return;
  }
  if (!fs.existsSync(MEDIAMTX_BIN)) {
    console.warn(`MediaMTX not found at ${MEDIAMTX_BIN} — start it manually`);
    return;
  }
  console.log("Starting MediaMTX…");
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
// Recording helpers
// ---------------------------------------------------------------------------
const MEDIAMTX_RECORD_DIR = "/tmp/live/mentra";

function clearSentinel(): void {
  try {
    fs.unlinkSync(RECORDING_SENTINEL);
  } catch {}
}

/**
 * Wait for a completed recording.
 * Primary: MediaMTX writes the path to RECORDING_SENTINEL via runOnRecordSegmentComplete.
 * Fallback: scan MEDIAMTX_RECORD_DIR for the .mp4 that appeared after recordingStartedAt.
 */
async function waitForRecording(
  sessionId: string,
  recordingStartedAt: number,
  timeoutMs = 25_000,
): Promise<string | null> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    if (fs.existsSync(RECORDING_SENTINEL)) {
      const p = fs.readFileSync(RECORDING_SENTINEL, "utf8").trim();
      if (p && fs.existsSync(p)) {
        console.log(`[${sessionId}] Sentinel path: ${p}`);
        return p;
      }
    }
    await new Promise((r) => setTimeout(r, 500));
  }

  // Fallback: find the mp4 file created after this step's recording began
  console.warn(`[${sessionId}] Sentinel not written — scanning ${MEDIAMTX_RECORD_DIR}`);
  if (fs.existsSync(MEDIAMTX_RECORD_DIR)) {
    const candidates = fs
      .readdirSync(MEDIAMTX_RECORD_DIR)
      .filter((f) => f.endsWith(".mp4"))
      .map((f) => {
        const fp = path.join(MEDIAMTX_RECORD_DIR, f);
        const stat = fs.statSync(fp);
        return { fp, mtime: stat.mtime.getTime(), size: stat.size };
      })
      .filter((f) => f.mtime >= recordingStartedAt && f.size > 1024)
      .sort((a, b) => b.mtime - a.mtime);

    if (candidates.length > 0) {
      console.warn(`[${sessionId}] Fallback recording: ${candidates[0].fp}`);
      return candidates[0].fp;
    }
  }

  console.error(`[${sessionId}] No recording found`);
  return null;
}

// ---------------------------------------------------------------------------
// Session state
// ---------------------------------------------------------------------------
// Phases: idle → recording (repeats per step) → done
// Analysis runs in the background — no blocking "analyzing" phase.
type ProtocolPhase = "idle" | "recording" | "done";

interface StepResult {
  step: number;
  name: string;
  performed_correctly: boolean;
  deviation: string | null;
}

interface SessionState {
  phase: ProtocolPhase;
  currentStep: number;   // 0-indexed: which step is currently being recorded
  stepsRecorded: number; // how many steps have been captured (button-pressed)
  stepResults: StepResult[];
  isStreaming: boolean;
  recordingStartedAt: number;
  pendingAnalyses: number; // background analyses still running
}

// ---------------------------------------------------------------------------
// Gemini step analysis
// ---------------------------------------------------------------------------
async function analyzeStep(
  recordingPath: string,
  stepIndex: number,
  sessionId: string,
): Promise<StepResult | null> {
  if (!fs.existsSync(recordingPath)) {
    console.error(`[${sessionId}] Recording not found: ${recordingPath}`);
    return null;
  }
  const fileSize = fs.statSync(recordingPath).size;
  if (fileSize < 1024) {
    console.log(
      `[${sessionId}] Recording too small (${fileSize} B), skipping analysis`,
    );
    return null;
  }

  const step = PROTOCOL_STEPS[stepIndex];
  console.log(
    `[${sessionId}] Uploading step ${stepIndex + 1} (${Math.round(fileSize / 1024)} KB)…`,
  );

  let videoFile = await ai.files.upload({
    file: recordingPath,
    config: {
      mimeType: "video/mp4",
      displayName: `session_${sessionId}_step${stepIndex + 1}`,
    },
  });

  while (videoFile.state?.toString() === "PROCESSING") {
    await new Promise((r) => setTimeout(r, 3000));
    videoFile = await ai.files.get({ name: videoFile.name! });
    if (videoFile.state?.toString() === "FAILED") {
      console.error(`[${sessionId}] Gemini file processing failed`);
      return null;
    }
  }
  if (videoFile.state?.toString() !== "ACTIVE") {
    console.error(
      `[${sessionId}] Unexpected Gemini state: ${videoFile.state}`,
    );
    return null;
  }

  console.log(`[${sessionId}] Running analysis for step ${stepIndex + 1}…`);
  const response = await ai.models.generateContent({
    model: GEMINI_MODEL,
    contents: createUserContent([
      createPartFromUri(videoFile.uri!, videoFile.mimeType || "video/mp4"),
      buildStepPrompt(step, stepIndex),
    ]),
    config: {
      temperature: GEMINI_TEMPERATURE,
      thinkingConfig: { thinkingBudget: GEMINI_THINKING_BUDGET },
    },
  });

  // Strip markdown fences if Gemini wraps the JSON
  const text = (response.text ?? "").trim();
  const jsonStr = text
    .replace(/^```(?:json)?\n?/, "")
    .replace(/\n?```$/, "")
    .trim();

  let result: StepResult;
  try {
    result = JSON.parse(jsonStr);
  } catch {
    console.error(`[${sessionId}] Failed to parse Gemini JSON: ${text}`);
    result = {
      step: stepIndex + 1,
      name: step.name,
      performed_correctly: false,
      deviation: "Analysis parse error",
    };
  }

  const outputPath = path.join(
    RECORDING_DIR,
    `step${stepIndex + 1}_${sessionId}.json`,
  );
  fs.writeFileSync(outputPath, JSON.stringify(result, null, 2));
  console.log(
    `[${sessionId}] Step ${stepIndex + 1}: ${JSON.stringify(result)}`,
  );

  try {
    await ai.files.delete({ name: videoFile.name! });
  } catch (e) {
    console.warn(`[${sessionId}] Could not delete Gemini upload:`, e);
  }

  return result;
}

// ---------------------------------------------------------------------------
// App
// ---------------------------------------------------------------------------
class ProtocolObserverApp extends AppServer {
  // Per-user state (userId is the key)
  private userStates = new Map<string, SessionState>();

  constructor(config: ConstructorParameters<typeof AppServer>[0]) {
    super(config);

    // --- Webview routes ---
    this.get("/webview", (c) => c.html(WEBVIEW_HTML));
    this.get("/", (c) => c.html(WEBVIEW_HTML));

    // --- Polling state endpoint ---
    this.get("/api/protocol-state", (c) => {
      const userId = c.get("authUserId");
      if (!userId) return c.text("Unauthorized", 401);
      const state = this.userStates.get(userId);
      return c.json(
        state
          ? {
              phase: state.phase,
              currentStep: state.currentStep,
              stepsRecorded: state.stepsRecorded,
              stepResults: state.stepResults,
              pendingAnalyses: state.pendingAnalyses,
            }
          : { phase: "idle", currentStep: 0, stepsRecorded: 0, stepResults: [], pendingAnalyses: 0 },
      );
    });
  }

  protected async onSession(
    session: AppSession,
    sessionId: string,
    userId: string,
  ): Promise<void> {
    console.log(`[${sessionId}] Session started (user=${userId})`);

    const state: SessionState = {
      phase: "idle",
      currentStep: 0,
      stepsRecorded: 0,
      stepResults: [],
      isStreaming: false,
      recordingStartedAt: 0,
      pendingAnalyses: 0,
    };
    this.userStates.set(userId, state);

    // Clear any stale stream
    try {
      const existing = await session.camera.checkExistingStream();
      if (existing.hasActiveStream) {
        console.log(`[${sessionId}] Clearing stale stream`);
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

    // --- Display helpers ---

    const showIdle = () => {
      session.layouts.showReferenceCard(
        "Protocol Observer",
        `${PROTOCOL_STEPS.length} steps ready\nPress button to begin Step 1: ${PROTOCOL_STEPS[0].name}`,
      );
    };

    const showRecording = (stepIndex: number) => {
      const step = PROTOCOL_STEPS[stepIndex];
      session.layouts.showDoubleTextWall(
        `[REC] Step ${stepIndex + 1}/${PROTOCOL_STEPS.length}: ${step.name}`,
        step.instructions,
      );
    };

    const showAllRecorded = () => {
      session.layouts.showTextWall(
        `All ${PROTOCOL_STEPS.length} steps recorded — analyzing in background...`,
      );
    };

    const showFinalSummary = () => {
      const passed = state.stepResults.filter((r) => r.performed_correctly).length;
      const lines = state.stepResults
        .sort((a, b) => a.step - b.step)
        .map((r) => `${r.step}. ${r.name}: ${r.performed_correctly ? "PASS" : "FAIL"}`)
        .join("\n");
      session.layouts.showDoubleTextWall(
        `Complete: ${passed}/${PROTOCOL_STEPS.length} steps passed`,
        lines,
      );
    };

    // --- Background analysis ---

    /** Fire-and-forget: wait for the recording then run Gemini in the background. */
    const triggerAnalysis = (stepIndex: number, recordingStartedAt: number) => {
      state.pendingAnalyses++;
      waitForRecording(sessionId, recordingStartedAt)
        .then((recordingPath) => {
          if (!recordingPath) {
            console.error(`[${sessionId}] No recording for step ${stepIndex + 1}`);
            return null;
          }
          return analyzeStep(recordingPath, stepIndex, sessionId);
        })
        .then((result) => {
          if (result) {
            state.stepResults.push(result);
            state.stepResults.sort((a, b) => a.step - b.step);
          }
        })
        .catch((err) =>
          console.error(`[${sessionId}] Analysis error step ${stepIndex + 1}:`, err),
        )
        .finally(() => {
          state.pendingAnalyses--;
          console.log(`[${sessionId}] Step ${stepIndex + 1} analysis done (${state.pendingAnalyses} pending)`);
          // When all analyses are complete and all steps have been recorded, save summary
          if (state.pendingAnalyses === 0 && state.phase === "done") {
            const outputPath = path.join(RECORDING_DIR, `protocol_${sessionId}.json`);
            fs.writeFileSync(outputPath, JSON.stringify(state.stepResults, null, 2));
            console.log(`[${sessionId}] Protocol complete — results → ${outputPath}`);
            showFinalSummary();
          }
        });
    };

    // --- Stream status tracking ---
    session.camera.onStreamStatus((status) => {
      console.log(`[${sessionId}] Stream status: ${status.status}`);
      if (status.status === "streaming" || status.status === "active") {
        state.isStreaming = true;
      }
      if (["stopped", "disconnected", "timeout", "reconnect_failed"].includes(status.status)) {
        state.isStreaming = false;
      }
    });

    // --- Button handler ---
    session.events.onButtonPress((btn) => {
      console.log(
        `[${sessionId}] Button: id=${btn.buttonId} type=${btn.pressType} phase=${state.phase} step=${state.currentStep + 1}`,
      );
      if (btn.pressType !== "short") return;

      switch (state.phase) {
        case "idle": {
          // Start recording step 1
          clearSentinel();
          state.recordingStartedAt = Date.now();
          state.phase = "recording";
          state.isStreaming = true;
          showRecording(state.currentStep);
          session.camera
            .startStream({ rtmpUrl: RTMP_URL })
            .catch((err) => {
              console.error(`[${sessionId}] startStream error:`, err);
              state.isStreaming = false;
              state.phase = "idle";
              showIdle();
            });
          break;
        }

        case "recording": {
          const stepIndex = state.currentStep;
          const startedAt = state.recordingStartedAt;
          const isLastStep = stepIndex === PROTOCOL_STEPS.length - 1;

          // Stop this step's recording
          state.isStreaming = false;
          state.stepsRecorded = stepIndex + 1;
          session.camera
            .stopStream()
            .catch((err) => console.error(`[${sessionId}] stopStream error:`, err));

          // Kick off background analysis for this step
          triggerAnalysis(stepIndex, startedAt);

          if (isLastStep) {
            // All steps recorded — go to done
            state.phase = "done";
            showAllRecorded();
          } else {
            // Show a brief "transitioning" message and return immediately so the
            // button handler doesn't block (a blocked async handler causes MentraOS
            // to fall back to the native close-app behaviour → user_disabled).
            // The next stream is started from a setTimeout outside the handler.
            state.phase = "idle"; // prevent double-presses during the gap
            const nextStep = stepIndex + 1;
            session.layouts.showTextWall(
              `Step ${stepIndex + 1} recorded — starting Step ${nextStep + 1}...`,
            );
            setTimeout(() => {
              state.currentStep = nextStep;
              clearSentinel();
              state.recordingStartedAt = Date.now();
              state.phase = "recording";
              state.isStreaming = true;
              showRecording(nextStep);
              session.camera
                .startStream({ rtmpUrl: RTMP_URL })
                .catch((err) => {
                  console.error(`[${sessionId}] startStream error:`, err);
                  state.isStreaming = false;
                  state.phase = "idle";
                  showIdle();
                });
            }, 1500);
          }
          break;
        }

        case "done": {
          if (state.pendingAnalyses > 0) {
            session.layouts.showTextWall(
              `Analyzing... ${state.pendingAnalyses} step${state.pendingAnalyses > 1 ? "s" : ""} remaining`,
            );
          } else {
            // Reset for a new run
            state.currentStep = 0;
            state.stepsRecorded = 0;
            state.stepResults = [];
            state.pendingAnalyses = 0;
            state.phase = "idle";
            showIdle();
          }
          break;
        }
      }
    });

    showIdle();
    console.log(`[${sessionId}] Ready — press button to begin protocol`);
  }

  protected async onStop(
    sessionId: string,
    userId: string,
    reason: string,
  ): Promise<void> {
    console.log(
      `[${sessionId}] Session ended (user=${userId}, reason=${reason})`,
    );
    const state = this.userStates.get(userId);

    if (state && state.stepResults.length > 0) {
      const outputPath = path.join(RECORDING_DIR, `protocol_${sessionId}.json`);
      fs.writeFileSync(outputPath, JSON.stringify(state.stepResults, null, 2));
      console.log(
        `[${sessionId}] Partial results (${state.stepResults.length} steps) → ${outputPath}`,
      );
    }

    this.userStates.delete(userId);
  }
}

// ---------------------------------------------------------------------------
// Start server
// ---------------------------------------------------------------------------
startMediaMTX();

const app = new ProtocolObserverApp({
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
console.log("Protocol Observer");
console.log(`  Port:    ${PORT}`);
console.log(`  Package: ${PACKAGE_NAME}`);
console.log(`  RTMP:    ${RTMP_URL}`);
console.log(`  Model:   ${GEMINI_MODEL}`);
console.log(`  Steps:   ${PROTOCOL_STEPS.length}`);
PROTOCOL_STEPS.forEach((s, i) => console.log(`    ${i + 1}. ${s.name}`));
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
