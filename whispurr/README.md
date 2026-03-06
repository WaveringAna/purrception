# whispurr

Transcribes each voice channel participant in real-time using local whisper.cpp and posts to a text channel via per-user webhooks (similar to PluralKit).

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

Then download a model — `large-v3-turbo` is fine enough on a m4 mini for 5 users in one VC in my experience.
```bash
./models/download-ggml-model.sh large-v3-turbo
# or on Windows:
# powershell -ExecutionPolicy Bypass -File models/download-ggml-model.ps1 medium
```

## 2. Run the whisper server

```bash
./build/bin/whisper-server \
  -m models/ggml-large-v3-turbo.bin \
  --host 127.0.0.1 \
  --port 8080 \
  -t 8          # threads — bump this if you have more concurrent users
```

On Windows: `.\build\bin\Release\whisper-server.exe -m models\ggml-large-v3-turbo.bin --host 127.0.0.1 --port 8080 -t 8`

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
| `/join [channel]` | Join your voice channel and start transcribing; posts to `channel` if given, otherwise `#vc-text`, otherwise the current channel |
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
- Messages appear as the speaker (name + avatar) via a single webhook in the configured text channel
