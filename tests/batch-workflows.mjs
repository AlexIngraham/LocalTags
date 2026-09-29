import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { ID3Writer } from "browser-id3-writer";

export async function runBatchChecks({
  check,
  ready,
  completeMp3,
  audioFixture,
  artworkFixture,
  delayMetadata,
  releaseMetadata,
  readTags,
  outputRoot,
}) {
  const flac = {
    name: "02.flac",
    mimeType: "audio/flac",
    buffer: await readFile(new URL("fixtures/tone.flac", import.meta.url)),
  };
  function mp3(name = "01.mp3", title = "MP3 song", track = "1") {
    const writer = new ID3Writer(completeMp3);
    writer.setFrame("TIT2", title);
    writer.setFrame("TPE1", ["MP3 artist"]);
    writer.setFrame("TALB", "MP3 album");
    writer.setFrame("TPE2", "MP3 album artist");
    if (track) writer.setFrame("TRCK", track);
    writer.setFrame("APIC", {
      type: 3,
      data: artworkFixture.buffer,
      description: "Cover",
    });
    writer.addTag();
    return {
      name,
      mimeType: "audio/mpeg",
      buffer: Buffer.from(writer.arrayBuffer),
    };
  }
  function tagged(
    name,
    {
      title,
      artist,
      album,
      albumArtist,
      genre,
      track,
      art = artworkFixture.buffer,
    },
  ) {
    const writer = new ID3Writer(completeMp3);
    for (const [id, value] of [
      ["TIT2", title],
      ["TALB", album],
      ["TPE2", albumArtist],
      ["TRCK", track],
    ])
      if (value) writer.setFrame(id, value);
    if (artist) writer.setFrame("TPE1", [artist]);
    if (genre) writer.setFrame("TCON", [genre]);
    if (art)
      writer.setFrame("APIC", { type: 3, data: art, description: "Cover" });
    writer.addTag();
    return {
      name,
      mimeType: "audio/mpeg",
      buffer: Buffer.from(writer.arrayBuffer),
    };
  }
  // Mixed genres, artists, album artists and artwork, like a real tagged album.
  const discovery = () => [
    tagged("01 One More Time.mp3", {
      title: "One More Time",
      artist: "Daft Punk",
      album: "Discovery",
      albumArtist: "Daft Punk",
      genre: "Dance",
      track: "1",
    }),
    tagged("02 Aerodynamic.mp3", {
      title: "Aerodynamic",
      artist: "Daft Punk",
      album: "Discovery",
      genre: "Electronic",
      track: "2",
    }),
    tagged("03 Digital Love.mp3", {
      title: "Digital Love",
      artist: "Daft Punk feat. DJ Falcon",
      album: "Discovery",
      genre: "Pop",
      track: "3",
      art: null,
    }),
    tagged("04 Harder Better Faster Stronger.mp3", {
      title: "Harder, Better, Faster, Stronger",
      artist: "Daft Punk",
      album: "Discovery",
      genre: "House",
      track: "4",
    }),
  ];
  const card = (page, filename) =>
    page
      .locator(".track-row")
      .filter({ has: page.getByText(filename, { exact: true }) });
  const row = (page, index) => page.locator(".track-row").nth(index);
  const field = (entry, key) => entry.locator(`[data-field="${key}"]`);
  const settled = (page) =>
    page.waitForFunction(
      () => !document.getElementById("submit-button").disabled,
    );
  const names = (page) => page.locator(".track-filename").allTextContents();
  const apply = (page) => page.locator("#apply-selected").click();
  async function clearAlbum(page) {
    page.once("dialog", (dialog) => dialog.accept());
    await page.locator("#clear-batch").click();
  }

  const setMode = (page, key, mode) =>
    page.locator(`#bulk-mode-${key}`).selectOption(mode);
  const rows = (page) =>
    page.locator(".track-row").evaluateAll((entries) =>
      entries.map((entry) => {
        const image = entry.querySelector(".track-cover");
        return {
          ...Object.fromEntries(
            [...entry.querySelectorAll("[data-field]")].map((input) => [
              input.dataset.field,
              input.value,
            ]),
          ),
          cover: image.hidden ? null : image.getAttribute("src"),
        };
      }),
    );
  const statuses = (page) =>
    page
      .locator(".track-row")
      .evaluateAll((entries) => entries.map((entry) => entry.dataset.status));
  const coverBytes = async (page, url) =>
    Buffer.from(
      await page.evaluate(
        async (src) => [
          ...new Uint8Array(await (await fetch(src)).arrayBuffer()),
        ],
        url,
      ),
    );
  const textTags = (tags) =>
    Object.fromEntries(
      ["TRCK", "TIT2", "TPE1", "TALB", "TPE2", "TCON"].map((id) => [
        id,
        tags[id],
      ]),
    );
  const expectedTags = ({ track, title, artist, album, albumArtist, genre }) =>
    Object.fromEntries(
      Object.entries({
        TRCK: track,
        TIT2: title,
        TPE1: artist,
        TALB: album,
        TPE2: albumArtist,
        TCON: genre,
      }).map(([id, value]) => [id, value || undefined]),
    );
  async function pick(page, ...indexes) {
    for (const index of indexes)
      await row(page, index).locator("[data-select]").check();
  }
  async function upload(page, fixtures) {
    await page.locator("#file").setInputFiles(fixtures);
    await settled(page);
  }
  async function drop(page, fixtures) {
    const transfer = await page.evaluateHandle(
      (files) => {
        const data = new DataTransfer();
        for (const file of files)
          data.items.add(
            new File([new Uint8Array(file.bytes)], file.name, {
              type: file.mimeType,
            }),
          );
        return data;
      },
      fixtures.map((file) => ({
        ...file,
        buffer: undefined,
        bytes: [...file.buffer],
      })),
    );
    await page
      .locator("#audio-drop")
      .dispatchEvent("drop", { dataTransfer: transfer });
    await transfer.dispose();
    await settled(page);
  }
  async function redArtwork(page) {
    const base64 = await page.evaluate(() => {
      const canvas = document.createElement("canvas");
      canvas.width = canvas.height = 2;
      const context = canvas.getContext("2d");
      context.fillStyle = "red";
      context.fillRect(0, 0, 2, 2);
      return canvas.toDataURL("image/png").split(",")[1];
    });
    return {
      name: "red.png",
      mimeType: "image/png",
      buffer: Buffer.from(base64, "base64"),
    };
  }
  async function exportTags(page) {
    await page.locator("#submit-button").click();
    await page.locator("#album-download").waitFor({ state: "visible" });
    await settled(page);
    const files = await page
      .locator(".track-download")
      .evaluateAll((links) =>
        Promise.all(
          links.map(async (link) => [
            ...new Uint8Array(await (await fetch(link.href)).arrayBuffer()),
          ]),
        ),
      );
    return files.map((bytes) => readTags(Buffer.from(bytes)));
  }

  await check(
    "batch: mixed uploads import independently, append, remove, reorder and number explicitly",
    async (page) => {
      await upload(page, [audioFixture, flac, mp3()]);
      assert.deepEqual(await names(page), [
        "01.mp3",
        "02.flac",
        audioFixture.name,
      ]);
      assert.equal(
        await field(card(page, "01.mp3"), "track").inputValue(),
        "1",
      );
      assert.equal(
        await field(card(page, "02.flac"), "track").inputValue(),
        "2",
      );
      assert.equal(
        await field(card(page, audioFixture.name), "track").inputValue(),
        "",
      );
      assert.equal(
        await field(card(page, "02.flac"), "title").inputValue(),
        "FLAC song",
      );
      assert.equal(
        await field(card(page, "02.flac"), "albumArtist").inputValue(),
        "FLAC album artist",
      );
      assert.equal(
        await field(card(page, audioFixture.name), "album").inputValue(),
        "",
      );
      await field(card(page, "01.mp3"), "title").fill("My first edit");
      await upload(page, { ...audioFixture, name: "added.wav" });
      assert.equal(
        await field(card(page, "01.mp3"), "title").inputValue(),
        "My first edit",
      );
      assert.equal(
        await field(card(page, "added.wav"), "title").inputValue(),
        "",
      );
      const id = await card(page, "02.flac").getAttribute("data-track-id");
      await card(page, "02.flac")
        .getByRole("button", { name: "Move track up", exact: true })
        .click();
      assert.equal((await names(page))[0], "02.flac");
      assert.equal(
        await card(page, "02.flac").getAttribute("data-track-id"),
        id,
      );
      await page.locator("#select-all-tracks").check();
      await setMode(page, "track", "sequence");
      await apply(page);
      assert.deepEqual(
        await page
          .locator('[data-field="track"]')
          .evaluateAll((inputs) => inputs.map((input) => input.value)),
        ["1", "2", "3", "4"],
      );
      await card(page, "01.mp3")
        .getByRole("button", { name: "Remove track", exact: true })
        .click();
      assert.equal(await page.locator(".track-row").count(), 3);
      assert.equal(
        await card(page, "02.flac").getAttribute("data-track-id"),
        id,
      );
      await clearAlbum(page);
      assert.equal(await page.locator(".track-row").count(), 0);
      assert.ok(await page.locator("#album-empty").isVisible());
      assert.ok(await page.locator("#submit-button").isDisabled());
      await drop(page, [mp3(), flac]);
      assert.equal(await page.locator(".track-row").count(), 2);
    },
  );

  await check(
    "batch: dropping files starts an album and adding to a single track preserves its edits",
    async (page) => {
      await ready(page, mp3());
      await page.locator("#title").fill("Single track edit");
      const previousUrl = await page
        .locator("#cover-preview")
        .getAttribute("src");
      await page.locator("#album-files").setInputFiles([flac, audioFixture]);
      await settled(page);
      assert.equal(await page.locator(".track-row").count(), 3);
      assert.equal(
        await field(card(page, "01.mp3"), "title").inputValue(),
        "Single track edit",
      );
      assert.ok(await card(page, "01.mp3").locator(".track-cover").isVisible());
      assert.ok(
        await page.evaluate(
          (url) => window.__workflow.revoked.includes(url),
          previousUrl,
        ),
      );
      assert.equal(
        await field(card(page, audioFixture.name), "title").inputValue(),
        "",
      );
      await clearAlbum(page);
      await drop(page, [mp3(), flac]);
      await drop(page, [{ ...audioFixture, name: "dropped.wav" }]);
      assert.equal(await page.locator(".track-row").count(), 3);
    },
  );

  await check(
    "batch: bulk fields and artwork apply only explicitly and only to selected tracks",
    async (page) => {
      await upload(page, [mp3(), flac, audioFixture]);
      const first = card(page, "01.mp3");
      const second = card(page, "02.flac");
      const third = card(page, audioFixture.name);
      const originalArt = await first
        .locator(".track-cover")
        .getAttribute("src");
      await page.locator("#bulk-album").fill("Discovery");
      await page.locator("#bulk-albumArtist").fill("Daft Punk");
      await page.locator("#bulk-genre").fill("Electronic");
      await page.locator("#album-cover").setInputFiles(artworkFixture);
      await page.locator("#album-cover-preview").waitFor({ state: "visible" });
      assert.equal(await field(first, "album").inputValue(), "MP3 album");
      assert.equal(
        await first.locator(".track-cover").getAttribute("src"),
        originalArt,
      );
      assert.ok(
        await page.locator("#apply-selected").isDisabled(),
        "nothing applies without a selection",
      );
      await first.locator("[data-select]").check();
      await second.locator("[data-select]").check();
      await apply(page);
      for (const entry of [first, second]) {
        assert.equal(await field(entry, "album").inputValue(), "Discovery");
        assert.equal(
          await field(entry, "albumArtist").inputValue(),
          "Daft Punk",
        );
        assert.equal(await field(entry, "genre").inputValue(), "Electronic");
        assert.ok(await entry.locator(".track-cover").isVisible());
      }
      assert.equal(await field(first, "artist").inputValue(), "MP3 artist");
      assert.equal(await field(third, "album").inputValue(), "");
      assert.ok(await third.locator(".track-cover").isHidden());
      await page.locator("#select-all-tracks").uncheck();
      await third.locator("[data-select]").check();
      await setMode(page, "cover", "set");
      assert.ok(
        await page.locator("#album-cover-preview").isVisible(),
        "the chosen image stays ready for another selection",
      );
      await page.locator("#bulk-album").fill("Discovery");
      await apply(page);
      assert.equal(await field(third, "album").inputValue(), "Discovery");
      assert.equal(await field(third, "genre").inputValue(), "");
      assert.ok(await third.locator(".track-cover").isVisible());
      await first
        .getByRole("button", { name: "Clear artwork", exact: true })
        .click();
      assert.ok(await first.locator(".track-cover").isHidden());
      assert.ok(await second.locator(".track-cover").isVisible());
      await page.locator("#select-all-tracks").uncheck();
      await first.locator("[data-select]").check();
      await setMode(page, "album", "clear");
      await apply(page);
      assert.equal(await field(first, "album").inputValue(), "");
      assert.equal(await field(first, "albumArtist").inputValue(), "Daft Punk");
      await first.locator("[data-select]").uncheck();
      await second.locator("[data-select]").check();
      await setMode(page, "cover", "clear");
      await apply(page);
      assert.ok(await second.locator(".track-cover").isHidden());
      assert.ok(await third.locator(".track-cover").isVisible());
      await page
        .locator("#album-cover")
        .setInputFiles({
          name: "bad.png",
          mimeType: "image/png",
          buffer: Buffer.from("not an image"),
        });
      await page.waitForFunction(() =>
        /Artwork must/.test(
          document.getElementById("bulk-error-cover").textContent,
        ),
      );
      assert.equal(
        await page.locator("#bulk-mode-cover").getAttribute("aria-invalid"),
        "true",
      );
      await setMode(page, "genre", "clear");
      assert.ok(
        await page.locator("#apply-selected").isEnabled(),
        "a rejected image does not leave the panel stuck",
      );
      await page.screenshot({
        path: join(outputRoot, "album-desktop.png"),
        fullPage: true,
      });
      await page.setViewportSize({ width: 375, height: 900 });
      assert.ok(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
      );
      await page.screenshot({
        path: join(outputRoot, "album-mobile.png"),
        fullPage: true,
      });
    },
  );

  await check(
    "selective: editing only Album preserves title, artist, genre, artwork and track number",
    async (page) => {
      await upload(page, discovery());
      const before = await rows(page);
      await page.locator("#select-all-tracks").check();
      await page
        .getByRole("button", {
          name: "Set Album for selected tracks",
          exact: true,
        })
        .click();
      assert.equal(await page.locator("#bulk-mode-album").inputValue(), "set");
      assert.equal(
        await page.evaluate(() => document.activeElement.id),
        "bulk-album",
      );
      await page.keyboard.type("Discovery (Remastered)");
      await page.keyboard.press("Enter");
      assert.deepEqual(
        await rows(page),
        before.map((entry) => ({ ...entry, album: "Discovery (Remastered)" })),
      );
      assert.match(
        await page.locator("#bulk-message").textContent(),
        /Updated Album on 4 tracks/,
      );
      assert.equal(
        await page.locator("#bulk-mode-album").inputValue(),
        "keep",
        "a finished edit is not re-applied to the next selection",
      );
      assert.deepEqual(
        await statuses(page),
        ["waiting", "waiting", "waiting", "waiting"],
        "Enter applies the edit instead of processing the album",
      );
    },
  );

  await check(
    "selective: editing only cover art preserves all text metadata",
    async (page) => {
      await upload(page, discovery());
      const before = await rows(page);
      const replacement = await redArtwork(page);
      await row(page, 0).locator("[data-select]").click();
      await row(page, 2)
        .locator("[data-select]")
        .click({ modifiers: ["Shift"] });
      assert.equal(
        await page.locator("#batch-summary").textContent(),
        "4 tracks uploaded · 3 selected",
      );
      assert.match(
        await page.locator("#bulk-cover-note").textContent(),
        /2 of 3 have artwork/,
      );
      await page
        .getByRole("button", {
          name: "Set Cover art for selected tracks",
          exact: true,
        })
        .click();
      assert.equal(await page.locator("#bulk-mode-cover").inputValue(), "set");
      assert.equal(
        await page.evaluate(() => document.activeElement.id),
        "album-cover",
      );
      await page.locator("#album-cover").setInputFiles(replacement);
      await page.locator("#album-cover-preview").waitFor({ state: "visible" });
      await apply(page);
      const after = await rows(page);
      after.forEach(({ cover, ...text }, index) => {
        const { cover: previous, ...original } = before[index];
        assert.deepEqual(text, original, `track ${index + 1} text metadata`);
        if (index < 3)
          assert.ok(
            cover && cover !== previous,
            `track ${index + 1} artwork replaced`,
          );
        else assert.equal(cover, previous, "unselected artwork kept");
      });
      for (const entry of after.slice(0, 3))
        assert.deepEqual(
          await coverBytes(page, entry.cover),
          replacement.buffer,
        );
      assert.match(
        await page.locator("#bulk-cover-note").textContent(),
        /Same artwork on all 3/,
      );
    },
  );

  await check(
    "selective: editing one track's title changes no other track, even when all are selected",
    async (page) => {
      await upload(page, discovery());
      await page.locator("#select-all-tracks").check();
      const before = await rows(page);
      await field(row(page, 1), "title").fill("Aerodynamic (Edit)");
      await field(row(page, 1), "title").press("Enter");
      assert.equal(
        await page.evaluate(
          () =>
            document.activeElement
              .closest(".track-row")
              ?.querySelector(".track-filename").textContent,
        ),
        "03 Digital Love.mp3",
        "Enter moves down a row like a spreadsheet",
      );
      assert.deepEqual(
        await rows(page),
        before.map((entry, index) =>
          index === 1 ? { ...entry, title: "Aerodynamic (Edit)" } : entry,
        ),
      );
      assert.deepEqual(
        await statuses(page),
        ["waiting", "waiting", "waiting", "waiting"],
        "Enter in a cell does not process the album",
      );
    },
  );

  await check(
    "selective: applying to selected tracks leaves unselected tracks untouched",
    async (page) => {
      await upload(page, discovery());
      const before = await rows(page);
      await pick(page, 0, 2);
      await page.locator("#bulk-artist").fill("Thomas Bangalter");
      await page.locator("#bulk-genre").fill("French House");
      await setMode(page, "cover", "clear");
      await apply(page);
      assert.deepEqual(
        await rows(page),
        before.map((entry, index) =>
          index === 0 || index === 2
            ? {
                ...entry,
                artist: "Thomas Bangalter",
                genre: "French House",
                cover: null,
              }
            : entry,
        ),
      );
    },
  );

  await check(
    "selective: mixed values show as Mixed and stay per-track when untouched",
    async (page) => {
      await upload(page, discovery());
      const before = await rows(page);
      await page.locator("#select-all-tracks").check();
      for (const key of ["track", "title", "artist", "albumArtist", "genre"]) {
        assert.equal(
          await page.locator(`#bulk-${key}`).inputValue(),
          "",
          `${key} does not borrow one track's value`,
        );
        assert.match(
          await page.locator(`#bulk-${key}`).getAttribute("placeholder"),
          /Mixed/,
        );
      }
      assert.equal(await page.locator("#bulk-album").inputValue(), "Discovery");
      assert.match(
        await page.locator("#bulk-cover-note").textContent(),
        /3 of 4 have artwork/,
      );
      await page.locator("#bulk-album").fill("Discovery (2001)");
      await apply(page);
      assert.deepEqual(
        await rows(page),
        before.map((entry) => ({ ...entry, album: "Discovery (2001)" })),
      );
      await page.locator("#select-all-tracks").uncheck();
      await pick(page, 0, 3);
      assert.equal(
        await page.locator("#bulk-artist").inputValue(),
        "Daft Punk",
        "a value shared by the selection is shown",
      );
      assert.match(
        await page.locator("#bulk-genre").getAttribute("placeholder"),
        /Mixed/,
      );
    },
  );

  await check(
    "selective: explicit Clear removes only the chosen field",
    async (page) => {
      await upload(page, discovery());
      const before = await rows(page);
      await page.locator("#select-all-tracks").check();
      await setMode(page, "genre", "clear");
      assert.ok(await page.locator("#bulk-genre").isDisabled());
      assert.match(
        await page.locator("#bulk-plan").textContent(),
        /Not applied yet: Genre on 4 tracks/,
      );
      await apply(page);
      assert.deepEqual(
        await rows(page),
        before.map((entry) => ({ ...entry, genre: "" })),
      );
    },
  );

  await check(
    "selective: blank bulk fields never erase metadata",
    async (page) => {
      await upload(page, discovery());
      const before = await rows(page);
      await page.locator("#select-all-tracks").check();
      assert.ok(
        await page.locator("#apply-selected").isDisabled(),
        "nothing to apply while every field keeps its value",
      );
      await setMode(page, "artist", "set");
      await apply(page);
      assert.match(
        await page.locator("#bulk-error-artist").textContent(),
        /choose Clear/,
      );
      assert.match(
        await page.locator("#bulk-message").textContent(),
        /Nothing was changed/,
      );
      assert.deepEqual(await rows(page), before);
      for (const value of ["", "   "]) {
        await page.locator("#bulk-album").fill(value);
        await apply(page);
        assert.equal(
          await page.locator("#bulk-album").getAttribute("aria-invalid"),
          "true",
        );
        assert.deepEqual(await rows(page), before);
      }
      await page.locator("#reset-bulk").click();
      await setMode(page, "cover", "set");
      await apply(page);
      assert.match(
        await page.locator("#bulk-error-cover").textContent(),
        /Choose an image/,
      );
      assert.deepEqual(await rows(page), before);
      await page.locator("#reset-bulk").click();
      await page.locator("#bulk-genre").fill("Electronic");
      await apply(page);
      assert.deepEqual(
        await rows(page),
        before.map((entry) => ({ ...entry, genre: "Electronic" })),
        "blank-looking mixed fields stay untouched",
      );
    },
  );

  await check(
    "selective: sequential numbering follows the current order and changes only track numbers",
    async (page) => {
      await upload(page, discovery());
      const last = card(page, "04 Harder Better Faster Stronger.mp3");
      for (let step = 0; step < 3; step++)
        await last
          .getByRole("button", { name: "Move track up", exact: true })
          .click();
      const before = await rows(page);
      assert.deepEqual(
        before.map((entry) => entry.track),
        ["4", "1", "2", "3"],
      );
      await pick(page, 1, 2, 3);
      await setMode(page, "track", "sequence");
      assert.equal(await page.locator("#bulk-track").inputValue(), "1");
      await page.locator("#bulk-track").fill("5");
      await apply(page);
      assert.deepEqual(
        await rows(page),
        before.map((entry, index) =>
          index ? { ...entry, track: String(index + 4) } : entry,
        ),
      );
      await page.locator("#select-all-tracks").check();
      await setMode(page, "track", "sequence");
      await apply(page);
      assert.deepEqual(
        await rows(page),
        before.map((entry, index) => ({ ...entry, track: String(index + 1) })),
      );
      assert.deepEqual(await names(page), [
        "04 Harder Better Faster Stronger.mp3",
        "01 One More Time.mp3",
        "02 Aerodynamic.mp3",
        "03 Digital Love.mp3",
      ]);
    },
  );

  await check(
    "selective: removing artwork leaves every other tag in the exported files",
    async (page) => {
      await upload(page, discovery());
      const before = await rows(page);
      await pick(page, 0, 1);
      await setMode(page, "cover", "clear");
      assert.match(
        await page.locator("#bulk-cover-note").textContent(),
        /Will be removed from 2 tracks/,
      );
      await apply(page);
      assert.deepEqual(
        await rows(page),
        before.map((entry, index) =>
          index < 2 ? { ...entry, cover: null } : entry,
        ),
      );
      const tags = await exportTags(page);
      tags.forEach((tag, index) =>
        assert.deepEqual(
          textTags(tag),
          expectedTags(before[index]),
          `track ${index + 1} tags`,
        ),
      );
      assert.equal(tags[0].APIC, undefined);
      assert.equal(tags[1].APIC, undefined);
      assert.equal(
        tags[2].APIC,
        undefined,
        "a track that never had artwork stays without it",
      );
      assert.ok(tags[3].APIC.includes(artworkFixture.buffer));
    },
  );

  await check(
    "selective: an album workflow combines several fields while untouched values stay intact",
    async (page) => {
      await upload(page, discovery());
      const before = await rows(page);
      const replacement = await redArtwork(page);
      await page.locator("#select-all-tracks").check();
      await page.locator("#bulk-album").fill("Discovery (Deluxe)");
      await page.locator("#bulk-genre").fill("Electronic");
      await page.locator("#album-cover").setInputFiles(replacement);
      await page.locator("#album-cover-preview").waitFor({ state: "visible" });
      assert.match(
        await page.locator("#bulk-plan").textContent(),
        /Not applied yet: Album, Genre and Cover art on 4 tracks/,
      );
      await apply(page);
      for (const key of ["album", "genre", "cover"])
        assert.equal(
          await page.locator(`#bulk-mode-${key}`).inputValue(),
          "keep",
        );
      await page.locator("#select-all-tracks").uncheck();
      await row(page, 0).locator("[data-select]").click();
      await row(page, 1)
        .locator("[data-select]")
        .click({ modifiers: ["Shift"] });
      await page.locator("#bulk-artist").fill("Daft Punk & Friends");
      await apply(page);
      await field(row(page, 2), "title").fill("Digital Love (Live)");
      const after = await rows(page);
      after.forEach(({ cover, ...text }, index) => {
        const { cover: previous, ...original } = before[index];
        assert.deepEqual(
          text,
          {
            ...original,
            album: "Discovery (Deluxe)",
            genre: "Electronic",
            ...(index < 2 && { artist: "Daft Punk & Friends" }),
            ...(index === 2 && { title: "Digital Love (Live)" }),
          },
          `track ${index + 1}`,
        );
        assert.notEqual(cover, previous);
      });
      const tags = await exportTags(page);
      tags.forEach((tag, index) => {
        assert.deepEqual(
          textTags(tag),
          expectedTags(after[index]),
          `track ${index + 1} tags`,
        );
        assert.ok(tag.APIC.includes(replacement.buffer));
      });
      assert.deepEqual(
        tags.map((tag) => tag.TPE2),
        ["Daft Punk", undefined, undefined, undefined],
        "mixed album artists survive untouched",
      );
    },
  );

  await check(
    "batch: reordering, manual edits and bulk artwork win over a delayed source parse",
    async (page) => {
      await delayMetadata(page, "slow.mp3");
      await page
        .locator("#file")
        .setInputFiles([mp3("slow.mp3"), audioFixture]);
      await page.waitForFunction(() => window.__metadataWaiting);
      const slow = card(page, "slow.mp3");
      await slow
        .getByRole("button", { name: "Move track down", exact: true })
        .click();
      await field(slow, "title").fill("Edited during read");
      await slow.locator("[data-select]").check();
      await page.locator("#bulk-album").fill("User album");
      await page.locator("#album-cover").setInputFiles(artworkFixture);
      await page.locator("#album-cover-preview").waitFor({ state: "visible" });
      await apply(page);
      const coverUrl = await slow.locator(".track-cover").getAttribute("src");
      await releaseMetadata(page);
      await settled(page);
      assert.deepEqual(await names(page), [audioFixture.name, "slow.mp3"]);
      assert.equal(
        await field(slow, "title").inputValue(),
        "Edited during read",
      );
      assert.equal(await field(slow, "album").inputValue(), "User album");
      assert.equal(
        await field(slow, "artist").inputValue(),
        "MP3 artist",
        "fields left untouched still import",
      );
      assert.equal(
        await slow.locator(".track-cover").getAttribute("src"),
        coverUrl,
      );
      assert.equal(
        await field(card(page, audioFixture.name), "album").inputValue(),
        "",
      );
    },
  );

  for (const action of ["remove", "clear"]) {
    await check(
      `batch: ${action} during metadata parsing never recreates a track or changes later uploads`,
      async (page) => {
        await delayMetadata(page, "slow.mp3");
        await page
          .locator("#file")
          .setInputFiles([mp3("slow.mp3"), audioFixture]);
        await page.waitForFunction(() => window.__metadataWaiting);
        if (action === "remove")
          await card(page, "slow.mp3")
            .getByRole("button", { name: "Remove track", exact: true })
            .click();
        else await clearAlbum(page);
        await upload(page, { ...audioFixture, name: "new.wav" });
        await field(card(page, "new.wav"), "title").fill("New file edit");
        await releaseMetadata(page);
        assert.equal(await card(page, "slow.mp3").count(), 0);
        assert.equal(
          await field(card(page, "new.wav"), "title").inputValue(),
          "New file edit",
        );
        assert.equal(
          await field(card(page, "new.wav"), "album").inputValue(),
          "",
        );
        assert.ok(
          await card(page, "new.wav").locator(".track-cover").isHidden(),
        );
        assert.equal(
          await page.locator(".track-row").count(),
          action === "remove" ? 2 : 1,
        );
      },
    );
  }

  await check(
    "batch: unreadable metadata and disabled imports leave tracks usable",
    async (page) => {
      await page.evaluate(() => {
        const slice = File.prototype.slice;
        File.prototype.slice = function (start, end) {
          if (this.name === "unreadable.mp3" && start === 0 && end === 12)
            throw Error("Metadata read unavailable");
          return slice.call(this, start, end);
        };
      });
      await upload(page, [mp3("unreadable.mp3"), flac]);
      assert.equal(
        await field(card(page, "unreadable.mp3"), "title").inputValue(),
        "",
      );
      assert.equal(
        await card(page, "unreadable.mp3")
          .locator(".track-status")
          .textContent(),
        "Waiting",
      );
      await page.locator("#import-metadata").uncheck();
      await upload(page, mp3("disabled.mp3"));
      assert.equal(
        await field(card(page, "disabled.mp3"), "title").inputValue(),
        "",
      );
      assert.ok(
        await card(page, "disabled.mp3").locator(".track-cover").isHidden(),
      );
      await page.locator("#submit-button").click();
      await page.locator("#album-download").waitFor({ state: "visible" });
      await settled(page);
      assert.equal(
        await page.locator('.track-row[data-status="complete"]').count(),
        3,
      );
    },
  );

  await check(
    "batch: clearing two stalled metadata reads immediately frees the queue for new files",
    async (page) => {
      await delayMetadata(page, "slow.mp3");
      await page
        .locator("#file")
        .setInputFiles([mp3("slow.mp3", "First"), mp3("slow.mp3", "Second")]);
      await page.waitForFunction(() => window.__metadataWaitingCount === 2);
      await clearAlbum(page);
      await upload(page, audioFixture);
      assert.equal(await page.locator(".track-row").count(), 1);
      await releaseMetadata(page);
      assert.deepEqual(await names(page), [audioFixture.name]);
      assert.equal(
        await field(card(page, audioFixture.name), "title").inputValue(),
        "",
      );
    },
  );

  await check(
    "batch: sequential mixed-format export isolates a failure and produces a valid album ZIP",
    async (page) => {
      await page.evaluate(() => {
        const decode = AudioContext.prototype.decodeAudioData;
        window.__decodes = { active: 0, max: 0, count: 0 };
        AudioContext.prototype.decodeAudioData = async function (...args) {
          const state = window.__decodes;
          state.count++;
          state.max = Math.max(state.max, ++state.active);
          try {
            return await decode.apply(this, args);
          } finally {
            state.active--;
          }
        };
      });
      const source = mp3();
      const broken = {
        name: "broken.wav",
        mimeType: "audio/wav",
        buffer: Buffer.from("RIFF0000WAVEthis file has no audio data"),
      };
      await upload(page, [source, flac, broken, audioFixture]);
      assert.equal(
        await page.evaluate(() => window.__decodes.count),
        0,
        "upload never decodes audio to PCM",
      );
      await page.locator("#select-all-tracks").check();
      await page.locator("#bulk-album").fill("Discovery");
      await page.locator("#bulk-albumArtist").fill("Daft Punk");
      await setMode(page, "track", "sequence");
      await page.locator("#album-cover").setInputFiles(artworkFixture);
      await page.locator("#album-cover-preview").waitFor({ state: "visible" });
      await apply(page);
      await page.locator("#submit-button").click();
      await page.evaluate(() =>
        document
          .getElementById("edit-form")
          .dispatchEvent(new Event("submit", { cancelable: true })),
      );
      await page.locator("#album-download").waitFor({ state: "visible" });
      await settled(page);
      assert.match(
        await page.locator("#status").textContent(),
        /3 complete, 1 failed/,
      );
      assert.match(await page.locator("#album-download-help").textContent(), /Successful tracks only; 1 failed, 0 not processed/);
      assert.ok(await page.locator("#album-download").isEnabled());
      await page.screenshot({ path: join(outputRoot, "album-partial-results.png"), fullPage: true });
      assert.equal(
        await card(page, "broken.wav").locator(".track-status").textContent(),
        "Error",
      );
      assert.equal(await page.locator(".track-download:visible").count(), 3);
      const telemetry = await page.evaluate(() => ({
        ...window.__decodes,
        stages: window.__workflow.samples.map((sample) => sample.status),
        trackStatuses: window.__workflow.samples.flatMap((sample) => sample.trackStatuses),
      }));
      assert.equal(telemetry.max, 1, "only one decoder runs at a time");
      assert.equal(
        telemetry.count,
        3,
        "MP3 bypasses decoding and double submit is ignored",
      );
      assert.ok(
        telemetry.stages.some((stage) => /Processing 4 of 4/.test(stage)),
      );
      assert.ok(telemetry.trackStatuses.some((status) => /Converting · \d+%/.test(status)), "per-track conversion progress is visible");
      const downloading = page.waitForEvent("download");
      await page.locator("#album-download").click();
      const download = await downloading;
      assert.equal(download.suggestedFilename(), "Discovery.zip");
      assert.equal(await download.failure(), null);
      const path = join(outputRoot, "Discovery.zip");
      await writeFile(path, await readFile(await download.path()));
      const extracted = spawnSync(
        "python3",
        [
          "-c",
          `import sys, zipfile, json, base64
with zipfile.ZipFile(sys.argv[1]) as z:
 assert z.testzip() is None
 print(json.dumps({name: base64.b64encode(z.read(name)).decode() for name in z.namelist()}))
`,
          path,
        ],
        { encoding: "utf8", maxBuffer: 4 * 1024 * 1024 },
      );
      assert.equal(extracted.status, 0, extracted.stderr);
      const contents = JSON.parse(extracted.stdout);
      assert.deepEqual(Object.keys(contents), [
        "01 - MP3 song.mp3",
        "02 - FLAC song.mp3",
        "04 - Source demo.mp3",
      ]);
      for (const [name, encoded] of Object.entries(contents)) {
        const bytes = Buffer.from(encoded, "base64");
        const tags = readTags(bytes);
        assert.equal(tags.TALB, "Discovery");
        assert.equal(tags.TPE2, "Daft Punk");
        assert.ok(tags.APIC.includes(artworkFixture.buffer));
        if (name.includes("MP3 song")) {
          const audio = (buffer) =>
            buffer.subarray(
              10 +
                ((buffer[6] << 21) |
                  (buffer[7] << 14) |
                  (buffer[8] << 7) |
                  buffer[9]),
            );
          assert.deepEqual(
            audio(bytes),
            audio(source.buffer),
            "MP3 audio bytes are unchanged",
          );
        }
      }
      await field(card(page, "01.mp3"), "title").fill("Revised title");
      assert.ok(
        await page.locator("#album-download").isDisabled(),
        "edits disable the previous ZIP while keeping the action visible",
      );
      assert.ok(
        await card(page, "01.mp3").locator(".track-download").isHidden(),
      );
      assert.ok(
        await card(page, "02.flac").locator(".track-download").isVisible(),
      );
    },
  );

  await check(
    "album UX: adjacent actions, disabled ZIP, unapplied edits, and keyboard download",
    async (page) => {
      await upload(page, discovery());
      const download = page.locator("#album-download");
      assert.ok(await download.isVisible());
      assert.ok(await download.isDisabled());
      assert.equal(await download.getAttribute("href"), null);
      assert.match(await page.locator("#batch-summary").textContent(), /4 tracks uploaded · 0 selected/);
      assert.ok(await page.locator("#apply-selected").isDisabled());
      assert.ok(await page.locator("#remove-selected").isDisabled());
      assert.ok(await row(page, 0).locator('[data-action="up"]').isDisabled());
      assert.ok(await row(page, 3).locator('[data-action="down"]').isDisabled());
      for (const width of [1440, 1024, 768]) {
        await page.setViewportSize({ width, height: 900 });
        const process = await page.locator("#submit-button").boundingBox();
        const zip = await download.boundingBox();
        assert.equal(process.y, zip.y, `actions share a row at ${width}px`);
        assert.ok(zip.x > process.x && zip.x - (process.x + process.width) <= 12);
        assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
      }
      await pick(page, 0, 1);
      await page.locator("#bulk-album").fill("Pending album");
      await page.locator("#submit-button").click();
      assert.match(await page.locator("#status").textContent(), /have not been applied/);
      assert.equal(await page.locator("#apply-selected").evaluate((el) => el === document.activeElement), true);
      assert.equal(await field(row(page, 0), "album").inputValue(), "Discovery");
      assert.equal(await page.locator(".track-download:visible").count(), 0);
      await page.locator("#reset-bulk").click();
      await exportTags(page);
      assert.ok(await download.isEnabled());
      assert.match(await page.locator("#album-download-help").textContent(), /ZIP ready · 4 of 4 tracks included/);
      assert.equal(await page.locator("#submit-label").textContent(), "Reprocess Album");
      assert.equal(await page.locator(".track-download:visible").count(), 4, "processing includes unselected tracks");
      await download.focus();
      const downloading = page.waitForEvent("download");
      await page.keyboard.press("Enter");
      assert.equal((await downloading).suggestedFilename(), "Discovery.zip");
      await page.screenshot({ path: join(outputRoot, "album-actions-ready.png"), fullPage: true });
      await page.setViewportSize({ width: 375, height: 900 });
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
      assert.ok((await download.boundingBox()).width < 375);
      await page.screenshot({ path: join(outputRoot, "album-actions-mobile.png"), fullPage: true });
      await field(row(page, 0), "title").fill("Updated song");
      assert.ok(await download.isVisible());
      assert.ok(await download.isDisabled());
      assert.equal(await download.getAttribute("href"), null);
      assert.match(await page.locator("#album-download-help").textContent(), /updated ZIP/);
    },
  );

  await check(
    "album UX: bulk undo restores selected tags and artwork without changing other fields",
    async (page) => {
      await upload(page, discovery());
      await pick(page, 0, 2);
      const before = await rows(page);
      await page.locator("#bulk-album").fill("Temporary");
      await setMode(page, "track", "sequence");
      await setMode(page, "cover", "clear");
      await apply(page);
      assert.ok(await page.locator("#undo-bulk").isVisible());
      assert.equal(await field(row(page, 0), "album").inputValue(), "Temporary");
      await page.locator("#undo-bulk").click();
      const after = await rows(page);
      assert.deepEqual(after.map(({ cover, ...values }) => values), before.map(({ cover, ...values }) => values));
      assert.deepEqual(after.map((entry) => Boolean(entry.cover)), before.map((entry) => Boolean(entry.cover)));
      assert.deepEqual(await coverBytes(page, after[0].cover), artworkFixture.buffer);
      assert.match(await page.locator("#bulk-message").textContent(), /Undid/);
      assert.ok(await page.locator("#undo-bulk").isHidden());
      await page.locator("#bulk-album").fill("Next edit");
      await apply(page);
      await field(row(page, 0), "title").fill("Later manual edit");
      assert.ok(await page.locator("#undo-bulk").isHidden(), "undo cannot overwrite a later manual edit");
      const tags = await exportTags(page);
      assert.equal(tags[0].TIT2, "Later manual edit");
      assert.equal(tags[1].TALB, "Discovery");
      assert.equal(tags[2].TALB, "Next edit");
    },
  );

  await check(
    "album UX: clear and remove-selected confirmations preserve edits when cancelled",
    async (page) => {
      await upload(page, discovery());
      await field(row(page, 0), "title").fill("Keep this edit");
      page.once("dialog", async (dialog) => {
        assert.match(dialog.message(), /Clear all 4 tracks/);
        await dialog.dismiss();
      });
      await page.locator("#clear-batch").click();
      assert.equal(await page.locator(".track-row").count(), 4);
      assert.equal(await field(row(page, 0), "title").inputValue(), "Keep this edit");
      await pick(page, 1, 2);
      page.once("dialog", (dialog) => dialog.dismiss());
      await page.locator("#remove-selected").click();
      assert.equal(await page.locator(".track-row").count(), 4);
      page.once("dialog", (dialog) => dialog.accept());
      await page.locator("#remove-selected").click();
      assert.deepEqual(await names(page), ["01 One More Time.mp3", "04 Harder Better Faster Stronger.mp3"]);
      await clearAlbum(page);
      assert.equal(await page.locator(".track-row").count(), 0);
      assert.ok(await page.locator("#album-download").isVisible());
      assert.ok(await page.locator("#album-download").isDisabled());
      assert.ok(await page.locator("#clear-batch").isDisabled());
      assert.ok(await page.locator("#select-all-tracks").isDisabled());
      assert.ok(await page.locator("#add-audio").evaluate((el) => el === document.activeElement));
    },
  );

  await check(
    "album UX: discarding a pending artwork read cannot reintroduce bulk changes",
    async (page) => {
      await upload(page, discovery());
      await pick(page, 2);
      await page.evaluate(() => {
        const slice = File.prototype.slice;
        const gate = new Promise((resolve) => { window.__releaseArtwork = resolve; });
        File.prototype.slice = function (start, end) {
          const blob = slice.call(this, start, end);
          if (this.name === "pending.png") {
            const read = blob.arrayBuffer.bind(blob);
            blob.arrayBuffer = async () => {
              window.__artworkWaiting = true;
              await gate;
              return read();
            };
          }
          return blob;
        };
        window.__urlsBeforeArtwork = window.__workflow.created.length;
      });
      await page.locator("#album-cover").setInputFiles({ ...artworkFixture, name: "pending.png" });
      await page.waitForFunction(() => window.__artworkWaiting);
      assert.ok(await page.locator("#submit-button").isDisabled());
      await page.locator("#reset-bulk").click();
      assert.ok(await page.locator("#submit-button").isEnabled());
      await page.evaluate(() => window.__releaseArtwork());
      await page.waitForFunction(() => {
        const urls = window.__workflow.created.slice(window.__urlsBeforeArtwork);
        return urls.length && urls.every((url) => window.__workflow.revoked.includes(url));
      });
      assert.equal(await page.locator("#bulk-mode-cover").inputValue(), "keep");
      assert.ok(await page.locator("#album-cover-preview").isHidden());
      assert.ok(await page.locator("#apply-selected").isDisabled());
    },
  );

  await check(
    "album UX: stop keeps partial downloads and consistent counts for rejected files, then allows restart",
    async (page) => {
      await upload(page, [...discovery(), {
        name: "rejected.txt", mimeType: "text/plain",
        buffer: Buffer.from("This file is not a supported audio format."),
      }]);
      await page.evaluate(() => {
        const read = File.prototype.arrayBuffer;
        const gate = new Promise((resolve) => { window.__finishTrack = resolve; });
        File.prototype.arrayBuffer = async function () {
          if (this.name === "01 One More Time.mp3") {
            window.__trackWaiting = true;
            await gate;
          }
          return read.call(this);
        };
      });
      await page.locator("#submit-button").click();
      await page.waitForFunction(() => window.__trackWaiting);
      assert.match(await page.locator("#submit-label").textContent(), /Processing… 1 \/ 5/);
      assert.ok(await page.locator("#album-download").isDisabled());
      assert.ok(await page.locator("#clear-batch").isDisabled());
      assert.ok(await page.locator("#bulk-mode-album").isDisabled());
      assert.equal(await page.locator("#album-progress-meter").getAttribute("value"), "0");
      assert.match(await page.locator("#album-progress-label").textContent(), /0 of 5 finished/);
      await page.screenshot({ path: join(outputRoot, "album-processing.png"), fullPage: true });
      await page.locator("#stop-album").click();
      assert.ok(await page.locator("#stop-album").isDisabled());
      assert.match(await page.locator("#album-download-help").textContent(), /current track will finish/);
      await page.evaluate(() => window.__finishTrack());
      await settled(page);
      assert.match(await page.locator("#status").textContent(), /Processing stopped: 1 complete, 1 failed, 3 not processed/);
      assert.match(await page.locator("#album-download-help").textContent(), /Successful tracks only; 1 failed, 3 not processed/);
      assert.equal(await page.locator("#album-progress-meter").getAttribute("value"), "1");
      assert.equal(await page.locator(".track-download:visible").count(), 1);
      assert.ok(await page.locator("#album-download").isEnabled());
      assert.ok(await page.locator("#stop-album").isHidden());
      const entries = await page.locator("#album-download").evaluate(async (link) => {
        const bytes = await (await fetch(link.href)).arrayBuffer();
        return new DataView(bytes).getUint16(bytes.byteLength - 12, true);
      });
      assert.equal(entries, 1, "the stopped album ZIP includes only the completed track");
      await page.locator("#submit-button").click();
      await settled(page);
      assert.equal(await page.locator(".track-download:visible").count(), 4);
      assert.match(await page.locator("#album-download-help").textContent(), /4 of 5 tracks included/);
    },
  );

  await check(
    "album UX: all failures keep ZIP disabled and long tables retain accessible sticky headers",
    async (page) => {
      await upload(page, Array.from({ length: 18 }, (_, index) => ({
        name: `unsupported-${index}.txt`, mimeType: "text/plain",
        buffer: Buffer.from("This is an unsupported file, not playable audio."),
      })));
      assert.equal(await page.locator('.track-row[data-status="error"]').count(), 18);
      assert.match(await row(page, 0).locator(".track-error").textContent(), /not supported/);
      const wrap = page.locator("#track-table-wrap");
      await wrap.scrollIntoViewIfNeeded();
      const headerTop = (await page.locator("#track-head th").first().boundingBox()).y;
      await wrap.evaluate((el) => { el.scrollTop = 350; el.scrollLeft = 200; });
      assert.equal((await page.locator("#track-head th").first().boundingBox()).y, headerTop);
      assert.ok(await wrap.evaluate((el) => el.scrollHeight > el.clientHeight));
      await wrap.focus();
      assert.notEqual(await wrap.evaluate((el) => getComputedStyle(el).outlineStyle), "none");
      await page.locator("#submit-button").click();
      await settled(page);
      assert.ok(await page.locator("#album-download").isVisible());
      assert.ok(await page.locator("#album-download").isDisabled());
      assert.match(await page.locator("#status").textContent(), /0 complete, 18 failed/);
      assert.match(await page.locator("#status").textContent(), /retry/);
    },
  );

  await check(
    "batch: duplicate output names are retained as separate ZIP entries",
    async (page) => {
      await upload(page, [
        mp3("a.mp3", "Same song", ""),
        mp3("b.mp3", "Same song", ""),
      ]);
      await page.locator("#submit-button").click();
      await page.locator("#album-download").waitFor({ state: "visible" });
      await settled(page);
      assert.deepEqual(
        await page
          .locator(".track-download")
          .evaluateAll((links) => links.map((link) => link.download)),
        ["MP3 artist - Same song.mp3", "MP3 artist - Same song (2).mp3"],
      );
    },
  );
}
