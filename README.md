# Mentra Gemini Bridge

Records a **Mentra smart glasses** session to disk and analyzes the video with the **Gemini API** when the session ends.

## Architecture

```
Glasses ─BLE→ Phone ─→ MentraOS Cloud (managed stream)
                                │
                     HLS playback URL (when active)
                                │
                                ▼
                    ffmpeg records → session_<id>.mp4
                                │
                                ▼
                    Gemini Files API → analysis_<id>.txt
```

- **Managed streaming**: MentraOS Cloud handles RTMP ingest and delivers an HLS URL. No self-hosted RTMP server needed.
- **Recording**: ffmpeg pulls the HLS stream and writes a fragmented MP4 (resilient to interruption).
- **Analysis**: the recording is uploaded to the Gemini Files API, analyzed with `gemini-robotics-er-1.5-preview`, and the result saved as a text file.

---

## Prerequisites

- **Mentra glasses** and phone with the Mentra app
- **[Bun](https://bun.sh)** runtime (`curl -fsSL https://bun.sh/install | bash`)
- **ffmpeg** in `PATH`
- A registered app in the [Mentra Developer Console](https://console.mentra.glass/dashboard) with **Camera** permission
- A **Gemini API key** from [Google AI Studio](https://aistudio.google.com)
- A public HTTPS endpoint for the webhook — this project uses a **Cloudflare Tunnel** (no port forwarding required)

---

## 1. Register your app

1. Open the [Mentra Developer Console](https://console.mentra.glass/dashboard) and sign in.
2. Create a new app:
   - **Package name** — e.g. `com.yourname.gemini-bridge`. Must match `PACKAGE_NAME` in `.env`.
   - **Camera** permission — required for streaming.
3. Copy the **API key** — goes into `MENTRAOS_API_KEY` in `.env`.
4. Set the **Webhook URL** to your public HTTPS endpoint + no path needed (the SDK registers its own routes):
   - With a Cloudflare Tunnel: `https://<your-tunnel-hostname>`
   - The tunnel should forward to `localhost:3000` (or whatever `PORT` you set).

---

## 2. Setup

```bash
git clone <this-repo>
cd Mentra-Livestreaming-Test

bun install

cp .env.example .env
# fill in .env (see table below)
```

### Environment variables

| Variable | Required | Description |
|---|---|---|
| `PACKAGE_NAME` | ✓ | App package name — must match the Developer Console exactly |
| `MENTRAOS_API_KEY` | ✓ | API key from the Developer Console |
| `GEMINI_API_KEY` | ✓ | Gemini API key from [Google AI Studio](https://aistudio.google.com) |
| `PORT` | | HTTP port for the webhook server (default: `3000`) |
| `GEMINI_MODEL` | | Gemini model (default: `gemini-robotics-er-1.5-preview`) |
| `GEMINI_TEMPERATURE` | | Sampling temperature (default: `0.2`) |
| `GEMINI_THINKING_BUDGET` | | Thinking token budget (default: `8192`) |
| `GEMINI_PROMPT` | | Override the analysis prompt (see `.env.example` for the default) |
| `STREAM_QUALITY` | | `720p` or `1080p` (default: `720p`) |
| `RECORDING_DIR` | | Directory for recordings and analysis output (default: `/tmp`) |

---

## 3. Cloudflare Tunnel setup

The bridge needs a public HTTPS URL so MentraOS Cloud can reach it. Cloudflare Tunnels provide this without opening any firewall ports.

```bash
# Install cloudflared
curl -L https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64 \
  -o /usr/local/bin/cloudflared && chmod +x /usr/local/bin/cloudflared

# Authenticate and create a named tunnel
cloudflared tunnel login
cloudflared tunnel create mentra-bridge

# Route your domain (or use a free trycloudflare.com URL for testing)
cloudflared tunnel route dns mentra-bridge <your-hostname>

# Start the tunnel (forwards to the bridge on port 3000)
cloudflared tunnel run --url http://localhost:3000 mentra-bridge
```

For testing without a domain:
```bash
cloudflared tunnel --url http://localhost:3000
# Cloudflare prints a free *.trycloudflare.com URL — use that as your webhook URL
```

Set the webhook URL in the [Developer Console](https://console.mentra.glass/dashboard) to the Cloudflare hostname (no trailing path needed).

---

## 4. Running

```bash
# Development (auto-restarts on file changes)
bun run dev

# Production
bun run start
```

On startup you will see:
```
==================================================
Mentra Gemini Bridge
  Port:      3000
  Package:   com.yourname.gemini-bridge
  Model:     gemini-robotics-er-1.5-preview
  Quality:   720p
  Output:    /tmp/
==================================================
Waiting for glasses session...
```

### Session flow

1. Open your mini-app on the Mentra glasses.
2. MentraOS Cloud sends a session webhook → bridge calls `startManagedStream`.
3. Once the stream is active, ffmpeg starts recording to `/tmp/session_<id>.mp4`.
4. Close the app (or let the session end naturally).
5. ffmpeg is stopped gracefully, the recording is uploaded to Gemini, and the analysis is saved to `/tmp/analysis_<id>.txt`.

---

## 5. Troubleshooting

**`PACKAGE_NAME` / `MENTRAOS_API_KEY` errors**
Copy `.env.example` to `.env` and fill in both values from the [Developer Console](https://console.mentra.glass/dashboard).

**Session connects then immediately disconnects**
Check that the webhook URL in the Developer Console matches your Cloudflare Tunnel hostname exactly, including `https://`.

**Stream stays in `initializing` and never reaches `active`**
The glasses are connecting to MentraOS Cloud's managed stream ingest but not sending video. Possible causes:
- The glasses app doesn't have Camera permission — check the Developer Console.
- Another stream is already active — the bridge logs an `Existing stream found` message on reconnect.
- Managed streaming requires internet on the phone — check connectivity.

**Recording is created but Gemini analysis fails**
- Verify `GEMINI_API_KEY` is set and valid.
- Check the file size logged — very short sessions produce files under 1 KB which are skipped.
- Gemini model availability: `gemini-robotics-er-1.5-preview` is a preview model. Substitute `gemini-2.0-flash` or `gemini-1.5-pro` in `.env` if it is unavailable.

**ffmpeg exits immediately**
- Confirm ffmpeg is in `PATH`: `which ffmpeg`
- The HLS URL requires internet access from the server — the managed stream CDN URL must be reachable.

---

## References

- [Mentra RTMP streaming (managed vs unmanaged)](https://docs.mentraglass.com/app-devs/core-concepts/camera/rtmp-streaming)
- [Mentra Developer Console](https://console.mentra.glass/dashboard)
- [Gemini Files API](https://ai.google.dev/gemini-api/docs/files)
- [Cloudflare Tunnels](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/)
