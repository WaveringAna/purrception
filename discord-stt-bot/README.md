# discord-stt-bot

Transcribes each voice channel participant in real-time using local whisper.cpp and posts to `#vc-text` via per-user webhooks.

## 1. Build whisper.cpp

### Apple Silicon (Metal)
```bash
git clone https://github.com/ggerganov/whisper.cpp
cd whisper.cpp
cmake -B build -DWHISPER_METAL=ON
cmake --build build --config Release
```

### NVIDIA GPU (CUDA)
```bash
git clone https://github.com/ggerganov/whisper.cpp
cd whisper.cpp
cmake -B build -DWHISPER_CUDA=ON
cmake --build build --config Release
```

### CPU only (Linux / Windows / no GPU)
```bash
git clone https://github.com/ggerganov/whisper.cpp
cd whisper.cpp
cmake -B build
cmake --build build --config Release
```

Then download a model — `medium` is a good balance of speed and accuracy:
```bash
./models/download-ggml-model.sh medium
# or on Windows:
# powershell -ExecutionPolicy Bypass -File models/download-ggml-model.ps1 medium
```

## 2. Run the whisper server

```bash
./build/bin/whisper-server \
  -m models/ggml-medium.bin \
  --host 127.0.0.1 \
  --port 8080 \
  -t 8          # threads — bump this if you have more concurrent users
```

On Windows: `.\build\bin\Release\whisper-server.exe -m models\ggml-medium.bin --host 127.0.0.1 --port 8080 -t 8`

## 3. Set up the Discord bot

1. Create an application at https://discord.com/developers/applications
2. Under **Bot**, enable **Server Members Intent**
3. Invite with permissions: `Connect`, `Speak`, `Manage Webhooks`, `Send Messages`
4. Copy token + application ID into `.env`

```bash
cp .env.example .env
```

## 4. Run the bot

```bash
bun src/index.ts
```

## Slash commands

| Command | Description |
|---|---|
| `/join` | Join your voice channel and start transcribing |
| `/leave` | Stop transcribing and disconnect |
| `/stt-config flush_interval silence_finalize` | Tune timers live (ms) |

`flush_interval` — how often buffered audio is sent to Whisper (default 3000ms)
`silence_finalize` — per-user silence before their message is finalized (default 3000ms)

## How it works

- Each user's Opus stream is decoded to 48kHz stereo PCM via `prism-media`
- Downsampled to 16kHz mono via `wave-resampler` and wrapped in a WAV header
- Every `flush_interval` ms, buffered audio is POSTed to `whisper-server /inference`
- The transcription is appended and the webhook message is edited in place
- After `silence_finalize` ms of silence **per user**, their message is finalized and the next speech starts a new one
- Messages appear as the speaker (name + avatar) via a single webhook in `#vc-text`
