import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { ID3Writer } from "browser-id3-writer";

export async function runBatchChecks({ check, ready, completeMp3, audioFixture, artworkFixture, delayMetadata, releaseMetadata, readTags, outputRoot }) {
  const flac = { name: "02.flac", mimeType: "audio/flac", buffer: await readFile(new URL("fixtures/tone.flac", import.meta.url)) };
  function mp3(name = "01.mp3", title = "MP3 song", track = "1") {
    const writer = new ID3Writer(completeMp3);
    writer.setFrame("TIT2", title);
    writer.setFrame("TPE1", ["MP3 artist"]);
    writer.setFrame("TALB", "MP3 album");
    writer.setFrame("TPE2", "MP3 album artist");
    if (track) writer.setFrame("TRCK", track);
    writer.setFrame("APIC", { type: 3, data: artworkFixture.buffer, description: "Cover" });
    writer.addTag();
    return { name, mimeType: "audio/mpeg", buffer: Buffer.from(writer.arrayBuffer) };
  }
  const card = (page, filename) => page.locator(".track-card").filter({ has: page.getByText(filename, { exact: true }) });
  const field = (row, key) => row.locator(`[data-field="${key}"]`);
  const settled = (page) => page.waitForFunction(() => !document.getElementById("submit-button").disabled);
  const names = (page) => page.locator(".track-filename").allTextContents();
  async function upload(page, fixtures) {
    await page.locator("#file").setInputFiles(fixtures);
    await settled(page);
  }
  async function drop(page, fixtures) {
    const transfer = await page.evaluateHandle((files) => {
      const data = new DataTransfer();
      for (const file of files) data.items.add(new File([new Uint8Array(file.bytes)], file.name, { type: file.mimeType }));
      return data;
    }, fixtures.map((file) => ({ ...file, buffer: undefined, bytes: [...file.buffer] })));
    await page.locator("#audio-drop").dispatchEvent("drop", { dataTransfer: transfer });
    await transfer.dispose();
    await settled(page);
  }

  await check("batch: mixed uploads import independently, append, remove, reorder and number explicitly", async (page) => {
    await upload(page, [audioFixture, flac, mp3()]);
    assert.deepEqual(await names(page), ["01.mp3", "02.flac", audioFixture.name]);
    assert.equal(await field(card(page, "01.mp3"), "track").inputValue(), "1");
    assert.equal(await field(card(page, "02.flac"), "track").inputValue(), "2");
    assert.equal(await field(card(page, audioFixture.name), "track").inputValue(), "");
    assert.equal(await field(card(page, "02.flac"), "title").inputValue(), "FLAC song");
    assert.equal(await field(card(page, "02.flac"), "albumArtist").inputValue(), "FLAC album artist");
    assert.equal(await field(card(page, audioFixture.name), "album").inputValue(), "");
    await field(card(page, "01.mp3"), "title").fill("My first edit");
    await upload(page, { ...audioFixture, name: "added.wav" });
    assert.equal(await field(card(page, "01.mp3"), "title").inputValue(), "My first edit");
    assert.equal(await field(card(page, "added.wav"), "title").inputValue(), "");
    const id = await card(page, "02.flac").getAttribute("data-track-id");
    await card(page, "02.flac").getByRole("button", { name: "Move track up", exact: true }).click();
    assert.equal((await names(page))[0], "02.flac");
    assert.equal(await card(page, "02.flac").getAttribute("data-track-id"), id);
    await page.locator("#number-tracks").click();
    assert.deepEqual(await page.locator('[data-field="track"]').evaluateAll((inputs) => inputs.map((input) => input.value)), ["1", "2", "3", "4"]);
    await card(page, "01.mp3").getByRole("button", { name: "Remove track", exact: true }).click();
    assert.equal(await page.locator(".track-card").count(), 3);
    assert.equal(await card(page, "02.flac").getAttribute("data-track-id"), id);
    await page.locator("#clear-batch").click();
    assert.equal(await page.locator(".track-card").count(), 0);
    assert.ok(await page.locator("#submit-button").isDisabled());
    await drop(page, [mp3(), flac]);
    assert.equal(await page.locator(".track-card").count(), 2);
  });

  await check("batch: dropping files starts an album and adding to a single track preserves its edits", async (page) => {
    await ready(page, mp3());
    await page.locator("#title").fill("Single track edit");
    const previousUrl = await page.locator("#cover-preview").getAttribute("src");
    await page.locator("#album-files").setInputFiles([flac, audioFixture]);
    await settled(page);
    assert.equal(await page.locator(".track-card").count(), 3);
    assert.equal(await field(card(page, "01.mp3"), "title").inputValue(), "Single track edit");
    assert.ok(await card(page, "01.mp3").locator(".track-cover").isVisible());
    assert.ok(await page.evaluate((url) => window.__workflow.revoked.includes(url), previousUrl));
    assert.equal(await field(card(page, audioFixture.name), "title").inputValue(), "");
    await page.locator("#clear-batch").click();
    await drop(page, [mp3(), flac]);
    await drop(page, [{ ...audioFixture, name: "dropped.wav" }]);
    assert.equal(await page.locator(".track-card").count(), 3);
  });

  await check("batch: bulk fields and artwork apply only explicitly and only to selected tracks", async (page) => {
    await upload(page, [mp3(), flac, audioFixture]);
    const first = card(page, "01.mp3");
    const second = card(page, "02.flac");
    const originalArt = await first.locator(".track-cover").getAttribute("src");
    await page.locator("#bulk-album").fill("Discovery");
    await page.locator("#bulk-albumArtist").fill("Daft Punk");
    await page.locator("#bulk-genre").fill("Electronic");
    await page.locator("#album-cover").setInputFiles(artworkFixture);
    await page.locator("#album-cover-preview").waitFor({ state: "visible" });
    assert.equal(await field(first, "album").inputValue(), "MP3 album");
    assert.equal(await first.locator(".track-cover").getAttribute("src"), originalArt);
    await first.locator("[data-select]").check();
    await second.locator("[data-select]").check();
    await page.locator("#apply-selected").click();
    for (const row of [first, second]) {
      assert.equal(await field(row, "album").inputValue(), "Discovery");
      assert.equal(await field(row, "albumArtist").inputValue(), "Daft Punk");
      assert.equal(await field(row, "genre").inputValue(), "Electronic");
      assert.ok(await row.locator(".track-cover").isVisible());
    }
    assert.equal(await field(first, "artist").inputValue(), "MP3 artist");
    assert.equal(await field(card(page, audioFixture.name), "album").inputValue(), "");
    assert.ok(await card(page, audioFixture.name).locator(".track-cover").isHidden());
    await page.locator("#apply-all").click();
    assert.equal(await field(card(page, audioFixture.name), "album").inputValue(), "Discovery");
    assert.ok(await card(page, audioFixture.name).locator(".track-cover").isVisible());
    await first.getByRole("button", { name: "Clear artwork", exact: true }).click();
    assert.ok(await first.locator(".track-cover").isHidden());
    assert.ok(await second.locator(".track-cover").isVisible());
    await page.locator("#bulk-album").fill("");
    await page.locator("#use-albumArtist").uncheck();
    await page.locator("#use-genre").uncheck();
    await page.locator("#clear-album-cover").click();
    await page.locator("#apply-selected").click();
    assert.equal(await field(first, "album").inputValue(), "");
    assert.equal(await field(first, "albumArtist").inputValue(), "Daft Punk");
    assert.ok(await second.locator(".track-cover").isHidden());
    assert.ok(await card(page, audioFixture.name).locator(".track-cover").isVisible());
    await page.locator("#album-cover").setInputFiles({ name: "bad.png", mimeType: "image/png", buffer: Buffer.from("not an image") });
    await page.waitForFunction(() => /Artwork must/.test(document.getElementById("bulk-message").textContent));
    assert.ok(await page.locator("#apply-all").isEnabled());
    await page.screenshot({ path: join(outputRoot, "album-desktop.png"), fullPage: true });
    await page.setViewportSize({ width: 375, height: 900 });
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    await page.screenshot({ path: join(outputRoot, "album-mobile.png"), fullPage: true });
  });

  await check("batch: reordering, manual edits and bulk artwork win over a delayed source parse", async (page) => {
    await delayMetadata(page, "slow.mp3");
    await page.locator("#file").setInputFiles([mp3("slow.mp3"), audioFixture]);
    await page.waitForFunction(() => window.__metadataWaiting);
    const slow = card(page, "slow.mp3");
    await slow.getByRole("button", { name: "Move track down", exact: true }).click();
    await field(slow, "title").fill("Edited during read");
    await slow.locator("[data-select]").check();
    await page.locator("#bulk-album").fill("User album");
    await page.locator("#album-cover").setInputFiles(artworkFixture);
    await page.locator("#album-cover-preview").waitFor({ state: "visible" });
    await page.locator("#apply-selected").click();
    const coverUrl = await slow.locator(".track-cover").getAttribute("src");
    await releaseMetadata(page);
    await settled(page);
    assert.deepEqual(await names(page), [audioFixture.name, "slow.mp3"]);
    assert.equal(await field(slow, "title").inputValue(), "Edited during read");
    assert.equal(await field(slow, "album").inputValue(), "User album");
    assert.equal(await slow.locator(".track-cover").getAttribute("src"), coverUrl);
    assert.equal(await field(card(page, audioFixture.name), "album").inputValue(), "");
  });

  for (const action of ["remove", "clear"]) {
    await check(`batch: ${action} during metadata parsing never recreates a track or changes later uploads`, async (page) => {
      await delayMetadata(page, "slow.mp3");
      await page.locator("#file").setInputFiles([mp3("slow.mp3"), audioFixture]);
      await page.waitForFunction(() => window.__metadataWaiting);
      if (action === "remove") await card(page, "slow.mp3").getByRole("button", { name: "Remove track", exact: true }).click();
      else await page.locator("#clear-batch").click();
      await upload(page, { ...audioFixture, name: "new.wav" });
      await field(card(page, "new.wav"), "title").fill("New file edit");
      await releaseMetadata(page);
      assert.equal(await card(page, "slow.mp3").count(), 0);
      assert.equal(await field(card(page, "new.wav"), "title").inputValue(), "New file edit");
      assert.equal(await field(card(page, "new.wav"), "album").inputValue(), "");
      assert.ok(await card(page, "new.wav").locator(".track-cover").isHidden());
      assert.equal(await page.locator(".track-card").count(), action === "remove" ? 2 : 1);
    });
  }

  await check("batch: unreadable metadata and disabled imports leave tracks usable", async (page) => {
    await page.evaluate(() => {
      const slice = File.prototype.slice;
      File.prototype.slice = function (start, end) {
        if (this.name === "unreadable.mp3" && start === 0 && end === 12) throw Error("Metadata read unavailable");
        return slice.call(this, start, end);
      };
    });
    await upload(page, [mp3("unreadable.mp3"), flac]);
    assert.equal(await field(card(page, "unreadable.mp3"), "title").inputValue(), "");
    assert.equal(await card(page, "unreadable.mp3").locator(".track-status").textContent(), "Waiting");
    await page.locator("#import-metadata").uncheck();
    await upload(page, mp3("disabled.mp3"));
    assert.equal(await field(card(page, "disabled.mp3"), "title").inputValue(), "");
    assert.ok(await card(page, "disabled.mp3").locator(".track-cover").isHidden());
    await page.locator("#submit-button").click();
    await page.locator("#album-download").waitFor({ state: "visible" });
    await settled(page);
    assert.equal(await page.locator('.track-card[data-status="complete"]').count(), 3);
  });

  await check("batch: clearing two stalled metadata reads immediately frees the queue for new files", async (page) => {
    await delayMetadata(page, "slow.mp3");
    await page.locator("#file").setInputFiles([mp3("slow.mp3", "First"), mp3("slow.mp3", "Second")]);
    await page.waitForFunction(() => window.__metadataWaitingCount === 2);
    await page.locator("#clear-batch").click();
    await upload(page, audioFixture);
    assert.equal(await page.locator(".track-card").count(), 1);
    await releaseMetadata(page);
    assert.deepEqual(await names(page), [audioFixture.name]);
    assert.equal(await field(card(page, audioFixture.name), "title").inputValue(), "");
  });

  await check("batch: sequential mixed-format export isolates a failure and produces a valid album ZIP", async (page) => {
    await page.evaluate(() => {
      const decode = AudioContext.prototype.decodeAudioData;
      window.__decodes = { active: 0, max: 0, count: 0 };
      AudioContext.prototype.decodeAudioData = async function (...args) {
        const state = window.__decodes;
        state.count++;
        state.max = Math.max(state.max, ++state.active);
        try { return await decode.apply(this, args); }
        finally { state.active--; }
      };
    });
    const source = mp3();
    const broken = { name: "broken.wav", mimeType: "audio/wav", buffer: Buffer.from("RIFF0000WAVEthis file has no audio data") };
    await upload(page, [source, flac, broken, audioFixture]);
    assert.equal(await page.evaluate(() => window.__decodes.count), 0, "upload never decodes audio to PCM");
    await page.locator("#bulk-album").fill("Discovery");
    await page.locator("#bulk-albumArtist").fill("Daft Punk");
    await page.locator("#album-cover").setInputFiles(artworkFixture);
    await page.locator("#album-cover-preview").waitFor({ state: "visible" });
    await page.locator("#apply-all").click();
    await page.locator("#number-tracks").click();
    await page.locator("#submit-button").click();
    await page.evaluate(() => document.getElementById("edit-form").dispatchEvent(new Event("submit", { cancelable: true })));
    await page.locator("#album-download").waitFor({ state: "visible" });
    await settled(page);
    assert.match(await page.locator("#status").textContent(), /3 complete, 1 failed/);
    assert.equal(await card(page, "broken.wav").locator(".track-status").textContent(), "Error");
    assert.equal(await page.locator(".track-download:visible").count(), 3);
    const telemetry = await page.evaluate(() => ({ ...window.__decodes, stages: window.__workflow.samples.map((sample) => sample.status) }));
    assert.equal(telemetry.max, 1, "only one decoder runs at a time");
    assert.equal(telemetry.count, 3, "MP3 bypasses decoding and double submit is ignored");
    assert.ok(telemetry.stages.some((stage) => /Processing 4 of 4/.test(stage)));
    const downloading = page.waitForEvent("download");
    await page.locator("#album-download").click();
    const download = await downloading;
    assert.equal(download.suggestedFilename(), "Discovery.zip");
    assert.equal(await download.failure(), null);
    const path = join(outputRoot, "Discovery.zip");
    await writeFile(path, await readFile(await download.path()));
    const extracted = spawnSync("python3", ["-c", `import sys, zipfile, json, base64
with zipfile.ZipFile(sys.argv[1]) as z:
 assert z.testzip() is None
 print(json.dumps({name: base64.b64encode(z.read(name)).decode() for name in z.namelist()}))
`, path], { encoding: "utf8", maxBuffer: 4 * 1024 * 1024 });
    assert.equal(extracted.status, 0, extracted.stderr);
    const contents = JSON.parse(extracted.stdout);
    assert.deepEqual(Object.keys(contents), ["01 - MP3 song.mp3", "02 - FLAC song.mp3", "04 - Source demo.mp3"]);
    for (const [name, encoded] of Object.entries(contents)) {
      const bytes = Buffer.from(encoded, "base64");
      const tags = readTags(bytes);
      assert.equal(tags.TALB, "Discovery");
      assert.equal(tags.TPE2, "Daft Punk");
      assert.ok(tags.APIC.includes(artworkFixture.buffer));
      if (name.includes("MP3 song")) {
        const audio = (buffer) => buffer.subarray(10 + ((buffer[6] << 21) | (buffer[7] << 14) | (buffer[8] << 7) | buffer[9]));
        assert.deepEqual(audio(bytes), audio(source.buffer), "MP3 audio bytes are unchanged");
      }
    }
    await field(card(page, "01.mp3"), "title").fill("Revised title");
    assert.ok(await page.locator("#album-download").isHidden(), "edits invalidate the previous ZIP");
    assert.ok(await card(page, "01.mp3").locator(".track-download").isHidden());
    assert.ok(await card(page, "02.flac").locator(".track-download").isVisible());
  });

  await check("batch: duplicate output names are retained as separate ZIP entries", async (page) => {
    await upload(page, [mp3("a.mp3", "Same song", ""), mp3("b.mp3", "Same song", "")]);
    await page.locator("#submit-button").click();
    await page.locator("#album-download").waitFor({ state: "visible" });
    await settled(page);
    assert.deepEqual(await page.locator(".track-download").evaluateAll((links) => links.map((link) => link.download)), ["MP3 artist - Same song.mp3", "MP3 artist - Same song (2).mp3"]);
  });
}
