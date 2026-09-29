# Local Tags

Tag a track or an entire album, add cover art, and download MP3s for Spotify Local Files. Files never leave the browser.

**Live:** [spotify-metadata.onrender.com](https://spotify-metadata.onrender.com/)

Accepts MP3, WAV, FLAC, AIFF, M4A, AAC, and OGG. Non-MP3 files convert to MP3, then get ID3 tags.

Select/drop multiple files to open the album editor, or use **Add files to album** to keep the current track and add more. Each track imports its own tags when **Import embedded metadata** is enabled. Album artist is supported independently of track artist.

Tracks appear as rows in a table; edit a cell to change only that track. To edit several at once, select their rows (Shift-click for a range) and set each field in **Edit selected tracks** to **Keep existing**, **Set to**, or **Clear**, or use a column's pencil button. Only the fields you set or clear change; every other field keeps each track's own value, and differing values show as *Mixed*. Cover art can be kept, replaced, or removed, and track numbers can be numbered in list order from any start. Arrows change track order.

**Process Album** converts tracks sequentially at 192 kbps, preserves existing MP3 audio, and continues past individual failures. Download the successful tracks individually or together with **Download Album ZIP**. ZIPs use uncompressed entries and bounded checksum reads; archives larger than 4 GB must be split into smaller batches or downloaded individually. Removing tracks, clearing the album, and replacing exports release their preview/output resources.

```bash
docker compose up --build
```

Open [http://localhost:10000](http://localhost:10000).

Tests (Node.js, Python 3, and Chrome or another Chromium browser):

```bash
cd tests
npm ci
npm test
# To use another installed browser:
BROWSER_EXECUTABLE='/path/to/chromium' npm test
```

The tests exercise real conversion, metadata races, selective bulk edits, and ZIP extraction/CRCs. `tests/fixtures/tone.flac` is a generated 0.25-second 440 Hz sine wave with fixture tags, created locally with FFmpeg. No external media is required.
