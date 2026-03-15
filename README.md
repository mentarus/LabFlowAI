# Mentra OBS Stream Bridge

Bridges **Mentra smart glasses** camera feed into **OBS Studio** via unmanaged RTMP streaming. When you start the companion app on your glasses, this bridge talks to MentraOS Cloud, requests an RTMP stream to your PC, and configures OBS to show the feed (RTMP or WebRTC).

## Architecture

```
Glasses ─BLE→ Phone ─WS→ MentraOS Cloud (api.mentra.glass)
                                │
                ┌───────────────┘
                ▼
        This bridge (app WebSocket client)
                │  sends RTMP stream request
                ▼
Glasses ─RTMP→ Your PC (MediaMTX on port 1935)
                │
                ▼
        OBS (Media Source or Browser Source / WebRTC)
```

- **Unmanaged streaming**: The glasses push directly to your RTMP server. You control ingest and distribution. See [Mentra RTMP streaming docs](https://docs.mentraglass.com/app-devs/core-concepts/camera/rtmp-streaming).

---

## Prerequisites

- **Mentra glasses** and phone with the Mentra app
- **Windows PC** on the same LAN as the phone (or reachable by the glasses for RTMP)
- **Python 3** with venv
- **MediaMTX** (or another RTMP server) listening on port 1935
- **FFmpeg** in `PATH` (for WebRTC path: RTMP → Opus → WebRTC)
- **OBS Studio** with **obs-websocket** enabled
- **ngrok** (or another tunnel) if you use production MentraOS Cloud and need the webhook to be reachable from the internet

---

## 1. Create your mini-app in the Mentra Developer Console

You must register an app so the cloud can authenticate this bridge and send session webhooks.

1. Open the **[Mentra Developer Console](https://console.mentra.glass/dashboard)** and sign in.
2. Create a **new app** (mini-app):
   - Choose a **package name** (e.g. `com.yourname.obs-stream` or `rtsp-local-streaming`). You will use this in `.env` as `MENTRA_PACKAGE_NAME`.
   - Ensure the app has **Camera** permission (required for streaming).
3. Get your **API key** for this app (often under app settings or credentials). Put it in `.env` as `MENTRA_API_KEY`.
4. Configure the **webhook URL** for this app:
   - The cloud will send `session.start` / `session.stop` to this URL when a user opens or closes your app on the glasses.
   - **Local only**: If you run a local MentraOS Cloud and everything is on one machine, you can use `http://localhost:7010/webhook`.
   - **Production cloud**: The cloud must reach your PC. Use a tunnel (e.g. **ngrok**): run `ngrok http 7010`, then set the webhook in the console to `https://<your-ngrok-host>/webhook`.
5. Save. Your bridge will use the same **package name** and **API key** so the cloud accepts its WebSocket connection and sends webhooks to your server.

Reference: [Mentra RTMP Streaming](https://docs.mentraglass.com/app-devs/core-concepts/camera/rtmp-streaming) — this project uses **unmanaged streaming** (direct RTMP to your endpoint).

---

## 2. Local setup

### 2.1 Clone / copy and Python env

```bash
cd path/to/Mentra
python -m venv venv
venv\Scripts\activate
pip install -r requirements.txt
```

### 2.2 Configuration (`.env`)

Copy `.env.example` to `.env` and fill in:

| Variable | Description |
|----------|-------------|
| `MENTRA_WS_URL` | WebSocket URL for the app. Production: `wss://api.mentra.glass/app-ws`. Local cloud: `ws://localhost:8002/app-ws`. |
| `MENTRA_API_KEY` | API key from the [Mentra Developer Console](https://console.mentra.glass/dashboard) for your app. **Required.** |
| `MENTRA_PACKAGE_NAME` | Package name of your app (must match the app in the console). |
| `RTMP_SERVER_URL` | RTMP URL the **glasses** will push to. Use this PC’s **LAN IP** so the phone/glasses can reach it (e.g. `rtmp://192.168.1.115:1935/live/mentra`). Port 1935 = MediaMTX. |
| `OBS_WEBRTC_PLAYBACK_URL` | Optional. If set, OBS uses a Browser Source with this WebRTC URL (low latency + audio). Example: `http://192.168.1.115:8889/live/mentra_webrtc?muted=false`. |
| `OBS_HOST`, `OBS_PORT`, `OBS_PASSWORD` | OBS WebSocket (Tools → obs-websocket Settings). |
| `OBS_SOURCE_NAME`, `OBS_SCENE_NAME` | OBS source name and scene (empty = current scene). |
| `WEBHOOK_HOST`, `WEBHOOK_PORT` | Flask server for webhooks (default `0.0.0.0:7010`). |

**Important:** `RTMP_SERVER_URL` must be reachable from the device that sends the stream (glasses/phone). Use your PC’s LAN IP, not `localhost`, unless the stream originates on the same machine.

### 2.3 MediaMTX and FFmpeg

- **MediaMTX**: Run from the Mentra directory so it finds `mediamtx.yml`. It will:
  - Accept RTMP publish on path `live/mentra` (port 1935).
  - When the glasses publish, **runOnReady** starts FFmpeg and feeds `live/mentra_webrtc` (WebRTC, port 8889). That path is always fed while the stream is live, so OBS can connect anytime.
- **FFmpeg**: Must be in `PATH` if you use the `live/mentra_webrtc` path.

### 2.4 OBS

- Install **obs-websocket** (often bundled with OBS).
- In OBS: **Tools → obs-websocket Settings** → enable the server and note port (default 4455) and password if set. Use the same in `.env`.

---

## 3. Running

### Option A: All-in-one (Windows Terminal)

Edit `launch_mentra_obs.bat` so `MENTRA_DIR`, `MEDIAMTX_EXE`, and `NGROK_CMD` point to your paths, then:

```batch
launch_mentra_obs.bat
```

This opens three tabs: MediaMTX, ngrok (for webhook), and the bridge (`mentra_obs_stream.py`).

### Option B: Manual

1. Start **MediaMTX** from the Mentra directory (e.g. `run_mediamtx.bat` or run `mediamtx` with `mediamtx.yml` in the same folder).
2. If using production cloud and the webhook must be public: start **ngrok** (e.g. `ngrok http 7010`) and set the webhook URL in the [Mentra Console](https://console.mentra.glass/dashboard) to `https://<ngrok-host>/webhook`.
3. Start the bridge:  
   `venv\Scripts\activate` then `python mentra_obs_stream.py`.

---

## 4. Usage

1. Ensure MediaMTX and the bridge are running; if needed, ngrok as well.
2. On your **Mentra glasses**, open **your mini-app** (the one you registered with the same package name). The cloud will send a webhook to your bridge; the bridge connects to MentraOS, requests an RTMP stream to `RTMP_SERVER_URL`, and waits for the stream to go live.
3. Once the stream is live, the bridge creates or updates the OBS source (e.g. “Mentra Glasses”) and points it at the RTMP URL or at `OBS_WEBRTC_PLAYBACK_URL` if set.
4. In OBS you should see the glasses camera. To stop, close the app on the glasses; the bridge will stop the stream and disconnect.

**Health check:** `http://localhost:7010/health` — shows bridge status and, when streaming, encoder stats.

**Stream in MediaMTX but not in OBS?** Open **http://localhost:7010/refresh** in a browser (or `curl http://localhost:7010/refresh`). This forces the OBS source to reconnect (reloads the WebRTC URL or re-sets the RTMP input). Use after the glasses start publishing or if the preview went black.

---

## 5. Troubleshooting

- **“MENTRA_API_KEY not set”** — Copy `.env.example` to `.env` and set `MENTRA_API_KEY` (and optionally `MENTRA_PACKAGE_NAME`) from the [Mentra Console](https://console.mentra.glass/dashboard).
- **“Connection rejected”** — Wrong API key or package name, or app not registered. Check the console and `.env`.
- **“No stream is available on path 'live/mentra'”** — OBS (or another reader) connected to `live/mentra_webrtc` before the glasses were publishing. Restart the stream on the glasses, or ensure MediaMTX is running before you open the app (runOnReady feeds the path when the glasses publish).
- **“Timed out waiting for stream”** — Glasses didn’t report stream active within 30 s. Ensure the glasses/phone can reach `RTMP_SERVER_URL` (use LAN IP, check firewall), and that the app has camera permission.
- **Webhook not called** — For production cloud, the webhook URL must be reachable from the internet. Use ngrok and set the exact URL (including `/webhook`) in the console.
- **Livestream app won’t open on the glasses** — Can happen after longer streaming (overheating). Let the glasses cool down in a ventilated spot for a few minutes, then try again. If it still fails, power the glasses off and on, and check for app or firmware updates in the Mentra phone app.
- **Stream drops after ~30–50 s with “Error during demuxing: I/O error” in MediaMTX** — MediaMTX logs show “closing existing publisher” when a **new** RTMP connection from the glasses arrives. The glasses (or cloud) are reconnecting RTMP periodically; MediaMTX then replaces the old publisher, which tears down the feed and kills the FFmpeg process reading it. The bridge avoids sending heartbeat while the stream is live (`HEARTBEAT_SKIP_WHILE_STREAMING=true` by default) so the cloud/device are less likely to restart the stream. If it still happens, the reconnection is likely on the Mentra cloud or device side; try a longer `HEARTBEAT_INTERVAL` when not streaming, or report to Mentra. WebSocket ping is disabled by default (`WS_PING_INTERVAL=0`); you don’t need it while the source is broadcasting.

---

## References

- [Mentra RTMP streaming (managed vs unmanaged)](https://docs.mentraglass.com/app-devs/core-concepts/camera/rtmp-streaming)
- [Mentra Developer Console](https://console.mentra.glass/dashboard) — create app, API key, webhook URL
- [Mentra docs index](https://docs.mentraglass.com/llms.txt) — full documentation index
