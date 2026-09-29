# Local Tags

Tag tracks or albums, add cover art, and download MP3s for Spotify Local Files.

**Live:** [localtags.onrender.com](https://localtags.onrender.com)

Supports MP3, WAV, FLAC, AIFF, M4A, AAC, and OGG. Non-MP3 files convert to MP3 at 192 kbps, then get ID3 tags.

## Album workflow

- Drop or select multiple files (or use **Add files to album**) to open the album editor.
- With **Import embedded metadata** on, each track loads its own tags. Album artist is separate from track artist.
- Edit one track via its table row, or select rows (Shift-click for a range) and use **Edit selected tracks** / a column’s pencil. Fields you leave on **Keep existing** are untouched; mixed values show as *Mixed*.
- Apply or discard pending bulk changes before processing. **Undo bulk edit** restores the last applied change until the next metadata edit, upload, removal, or processing run (available once the selected tracks finish loading).
- Cover art can be kept, replaced, or removed. Track numbers can be numbered in list order. Arrows reorder tracks.
- **Process Album** processes every uploaded track, regardless of selection, and continues past failures. Overall counts and per-track status show progress. **Stop after this track** finishes the current track and keeps completed downloads.
- **Download Album ZIP** stays beside **Process Album** and is enabled when the ZIP is ready. It contains successful tracks only; failed or unprocessed tracks are excluded and counted. Metadata edits invalidate the ZIP; reprocess to update it. Individual MP3 downloads remain available for unchanged tracks.
- **Clear album** and **Remove selected** ask for confirmation before discarding edits and prepared downloads. Original files are never changed.

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
