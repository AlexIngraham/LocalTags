# Local Tags

Tag tracks or albums, add cover art, and download MP3s for Spotify Local Files.

**Live:** [localtags.onrender.com](https://localtags.onrender.com)

Supports MP3, WAV, FLAC, AIFF, M4A, AAC, and OGG. Non-MP3 files convert to MP3 at 192 kbps, then get ID3 tags.

## Album workflow

- Drop or select multiple files (or use **Add files to album**) to open the album editor.
- With **Import embedded metadata** on, each track loads its own tags. Album artist is separate from track artist.
- Edit one track via its table row, or select rows (Shift-click for a range) and use **Edit selected tracks** / a column’s pencil. Fields you leave on **Keep existing** are untouched; mixed values show as *Mixed*.
- Cover art can be kept, replaced, or removed. Track numbers can be numbered in list order. Arrows reorder tracks.
- **Process Album** converts tracks one by one and continues past failures. Download individually or with **Download Album ZIP** (splits large batches over 4 GB).

## Local

```bash
docker compose up --build
```

Open [http://localhost:10000](http://localhost:10000).

## Tests

Needs Node.js, Python 3, and Chrome (or another Chromium browser):

```bash
cd tests
npm ci
npm test
# Optional: BROWSER_EXECUTABLE='/path/to/chromium' npm test
```

Covers conversion, metadata races, bulk edits, and ZIP/CRC checks. `tests/fixtures/tone.flac` is a short local FFmpeg fixture, no external media required.
