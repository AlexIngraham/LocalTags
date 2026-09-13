# Local Tags

Tag a track, add cover art, download an MP3 for Spotify Local Files. Files never leave the browser.

**Live:** [spotify-metadata.onrender.com](https://spotify-metadata.onrender.com/)

Accepts MP3, WAV, FLAC, AIFF, M4A (ALAC/AAC), AAC, and OGG. Non-MP3 files convert to MP3, then get ID3v2 tags.

Choose or drop an audio file (up to 200 MB), optionally edit its details and add artwork (up to 10 MB), then select **Create Spotify MP3**. The finished file downloads automatically; **Download again** remains available if the browser blocks it. Names use `Artist - Title.mp3` when both are supplied, the title when available, or the source filename otherwise. Errors retain your edits for retry.

Readable MP3 ID3, FLAC, and WAV tags/artwork fill the form automatically. User edits take precedence and survive replacing audio; unedited imported details follow the new source. Metadata reading is best effort: M4A/AAC, OGG, and AIFF source tags are not currently imported. WAV/FLAC duration appears when available. Browser codec support determines which compressed sources can be converted; PCM AIFF includes a local decoding fallback.

Progress reflects the real operation. MP3 encoding shows the fraction of audio samples encoded; reading, decoding, tagging, and download preparation use an indeterminate bar. An existing MP3 is tagged without re-encoding. There is no upload, conversion server, or server-side percentage. Browsers do not report whether a dispatched download was saved, so the recovery link remains available. The current download URL is retained for that link; replaced URLs are released after a short grace period and resources are released when leaving the page.

```bash
docker compose up --build
```

Open [http://localhost:10000](http://localhost:10000).

For local development without Docker, run `python3 -m http.server 10000` and open `http://localhost:10000/main.html`. The static app consists of `main.html`, `style.css`, `app.js`, and `metadata.js`; fonts and the existing encoder/tagging libraries load from CDNs.

Browser workflow checks use actual encoding/tagging and validate the downloaded MP3, with CDN libraries served from local test dependencies:

```bash
cd tests
npm install
npm test
```

The workflow suite uses installed Google Chrome by default; set `BROWSER_EXECUTABLE` to another Chromium executable if needed. Test screenshots and generated audio are written under `tests/_out/workflow/`.
