import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { createZip, uniqueFilename } from "../zip.js";

test("ZIP extracts Unicode names, empty files, and multi-chunk bytes with valid CRCs", async () => {
  const folder = await mkdtemp(join(tmpdir(), "local-tags-zip-"));
  try {
    const path = join(folder, "album.zip");
    const bytes = Uint8Array.from({ length: 800000 }, (_, i) => i % 251);
    const zip = await createZip([
      { name: "01 - Café 夜.mp3", blob: new Blob([bytes]) },
      { name: "empty.mp3", blob: new Blob([]) },
    ]);
    await writeFile(path, Buffer.from(await zip.arrayBuffer()));
    const result = spawnSync("python3", ["-c", `import sys, zipfile
with zipfile.ZipFile(sys.argv[1]) as z:
 assert z.testzip() is None
 assert z.namelist() == ['01 - Café 夜.mp3', 'empty.mp3']
 assert z.read(z.namelist()[0]) == bytes(i % 251 for i in range(800000))
 assert z.read('empty.mp3') == b''
`, path], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
  } finally { await rm(folder, { recursive: true, force: true }); }
});

test("ZIP rejects unsupported sizes before trying to read their data", async () => {
  await assert.rejects(createZip([{ name: "large.mp3", blob: { size: 0xffffffff } }]), /4 GB/);
  await assert.rejects(createZip(new Array(65535)), /Too many tracks/);
});

test("duplicate output names get unique suffixes, including case collisions", () => {
  const used = new Set();
  assert.equal(uniqueFilename("Song.mp3", used), "Song.mp3");
  assert.equal(uniqueFilename("Song (2).mp3", used), "Song (2).mp3");
  assert.equal(uniqueFilename("song.mp3", used), "song (3).mp3");
});
