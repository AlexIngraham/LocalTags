/**
 * Real-browser checks against the shipped page, encoder, and ID3 writer.
 * Run: cd tests && npm install && npm run test:workflow
 * Uses installed Chrome by default; BROWSER_EXECUTABLE can select another Chromium.
 * Fixture media is generated locally, and CDN modules are served from node_modules.
 */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join, extname } from "node:path";
import { chromium } from "playwright";
import { runBatchChecks } from "./batch-workflows.mjs";

const testRoot = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(testRoot, "..");
const outputRoot = join(testRoot, "_out", "workflow");
await mkdir(outputRoot, { recursive: true });

function wav(seconds = 1.6) {
  const rate = 44100;
  const frames = Math.floor(rate * seconds);
  const buffer = Buffer.alloc(44 + frames * 2);
  buffer.write("RIFF", 0);
  buffer.writeUInt32LE(36 + frames * 2, 4);
  buffer.write("WAVEfmt ", 8);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(rate, 24);
  buffer.writeUInt32LE(rate * 2, 28);
  buffer.writeUInt16LE(2, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write("data", 36);
  buffer.writeUInt32LE(frames * 2, 40);
  for (let i = 0; i < frames; i++) {
    buffer.writeInt16LE(
      Math.round(Math.sin((2 * Math.PI * 440 * i) / rate) * 12000),
      44 + i * 2,
    );
  }
  return buffer;
}

const audioFixture = {
  name: "Source demo.wav",
  mimeType: "audio/wav",
  buffer: wav(),
};
const artworkFixture = {
  name: "cover.png",
  mimeType: "image/png",
  buffer: Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aFioAAAAASUVORK5CYII=",
    "base64",
  ),
};

function taggedFlac(values, picture) {
  const uint = (value, littleEndian = false) => {
    const bytes = Buffer.alloc(4);
    if (littleEndian) bytes.writeUInt32LE(value);
    else bytes.writeUInt32BE(value);
    return bytes;
  };
  const block = (type, bytes) => {
    const header = Buffer.alloc(4);
    header[0] = type;
    header.writeUIntBE(bytes.length, 1, 3);
    return Buffer.concat([header, bytes]);
  };
  const entries = Object.entries(values).map(([key, value]) =>
    Buffer.from(`${key}=${value}`),
  );
  const comments = Buffer.concat([
    uint(0, true),
    uint(entries.length, true),
    ...entries.flatMap((entry) => [uint(entry.length, true), entry]),
  ]);
  const blocks = [block(picture ? 4 : 0x84, comments)];
  if (picture)
    blocks.push(
      block(
        0x86,
        Buffer.concat([
          uint(3),
          uint(9),
          Buffer.from("image/png"),
          uint(0),
          uint(1),
          uint(1),
          uint(24),
          uint(0),
          uint(picture.length),
          picture,
        ]),
      ),
    );
  return {
    name: "Song B.flac",
    mimeType: "audio/flac",
    buffer: Buffer.concat([Buffer.from("fLaC"), ...blocks]),
  };
}

async function fieldValues(page) {
  return page.evaluate(() =>
    Object.fromEntries(
      ["title", "artist", "album", "track", "genre"].map((id) => [
        id,
        document.getElementById(id).value,
      ]),
    ),
  );
}

// Gate the final metadata read, after validation, so race tests need no timed sleeps.
async function delayMetadata(page, filename) {
  await page.evaluate((name) => {
    const slice = File.prototype.slice;
    const gate = new Promise((resolve) => {
      window.__releaseMetadata = resolve;
    });
    let finish;
    window.__metadataFinished = new Promise((resolve) => {
      finish = resolve;
    });
    File.prototype.slice = function (start, end) {
      const blob = slice.call(this, start, end);
      if (
        this.name === name &&
        start === this.size - 128 &&
        end === this.size
      ) {
        const read = blob.arrayBuffer.bind(blob);
        blob.arrayBuffer = async () => {
          window.__metadataWaiting = true;
          window.__metadataWaitingCount =
            (window.__metadataWaitingCount || 0) + 1;
          await gate;
          const bytes = await read();
          setTimeout(finish, 0);
          return bytes;
        };
      }
      return blob;
    };
  }, filename);
}

async function releaseMetadata(page) {
  // Wait for the gated Blob read and its caller's microtasks to finish.
  await page.evaluate(async () => {
    window.__releaseMetadata();
    await window.__metadataFinished;
  });
}

function readTags(bytes) {
  assert.equal(
    bytes.toString("ascii", 0, 3),
    "ID3",
    "download contains an ID3 header",
  );
  const syncsafe = (at) =>
    (bytes[at] << 21) |
    (bytes[at + 1] << 14) |
    (bytes[at + 2] << 7) |
    bytes[at + 3];
  const end = 10 + syncsafe(6);
  const tags = {};
  for (let offset = 10; offset + 10 <= end; ) {
    const id = bytes.toString("ascii", offset, offset + 4);
    if (!/^[A-Z0-9]{4}$/.test(id)) break;
    const length =
      bytes[3] === 4 ? syncsafe(offset + 4) : bytes.readUInt32BE(offset + 4);
    const frame = bytes.subarray(offset + 10, offset + 10 + length);
    if (id.startsWith("T")) {
      const encoding = frame[0];
      const body = frame.subarray(1);
      let text;
      if (encoding === 1) {
        const swapped =
          body[0] === 0xfe
            ? Buffer.from(body.subarray(2)).swap16()
            : body.subarray(2);
        text = swapped.toString("utf16le");
      } else if (encoding === 2) {
        text = Buffer.from(body).swap16().toString("utf16le");
      } else {
        text = body.toString(encoding === 3 ? "utf8" : "latin1");
      }
      tags[id] = text.replace(/\0+$/g, "");
    } else {
      tags[id] = frame;
    }
    offset += 10 + length;
  }
  assert.ok(
    bytes.length > end + 100,
    "download contains encoded audio after the tags",
  );
  return tags;
}

const server = createServer(async (request, response) => {
  const path = new URL(request.url, "http://localhost").pathname;
  const allowed =
    /^\/(?:main\.html|style\.css|app\.js|metadata\.js|batch\.js|edits\.js|zip\.js)$/;
  if (!allowed.test(path)) return response.writeHead(404).end();
  try {
    const contents = await readFile(join(projectRoot, path.slice(1)));
    const types = {
      ".html": "text/html",
      ".css": "text/css",
      ".js": "text/javascript",
    };
    response.writeHead(200, {
      "Content-Type": types[extname(path)],
      "Cache-Control": "no-store",
    });
    response.end(contents);
  } catch {
    response.writeHead(404).end();
  }
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const baseUrl = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({
  headless: true,
  ...(process.env.BROWSER_EXECUTABLE
    ? { executablePath: process.env.BROWSER_EXECUTABLE }
    : { channel: "chrome" }),
});

async function openEditor({ viewport = { width: 1280, height: 1000 } } = {}) {
  const context = await browser.newContext({
    acceptDownloads: true,
    viewport,
    reducedMotion: "reduce",
  });
  await context.route(
    "https://cdn.jsdelivr.net/npm/lamejs@*/lame.min.js",
    (route) =>
      route.fulfill({
        path: join(testRoot, "node_modules/lamejs/lame.min.js"),
        contentType: "text/javascript",
      }),
  );
  await context.route(
    "https://cdn.jsdelivr.net/npm/browser-id3-writer@*/+esm",
    (route) =>
      route.fulfill({
        path: join(
          testRoot,
          "node_modules/browser-id3-writer/dist/browser-id3-writer.mjs",
        ),
        contentType: "text/javascript",
      }),
  );
  await context.addInitScript(() => {
    window.__workflow = {
      created: [],
      revoked: [],
      automaticDownloads: 0,
      samples: [],
      blockDownload: false,
    };
    // Compress only deferred resource disposal, leaving conversion/stage timers intact.
    const schedule = window.setTimeout.bind(window);
    window.setTimeout = (callback, delay, ...args) =>
      schedule(callback, delay >= 60000 ? 100 : delay, ...args);
    const create = URL.createObjectURL.bind(URL);
    URL.createObjectURL = (blob) => {
      const url = create(blob);
      window.__workflow.created.push(url);
      return url;
    };
    const revoke = URL.revokeObjectURL.bind(URL);
    URL.revokeObjectURL = (url) => {
      window.__workflow.revoked.push(url);
      revoke(url);
    };
    const click = HTMLAnchorElement.prototype.click;
    HTMLAnchorElement.prototype.click = function () {
      if (this.hasAttribute("download")) {
        window.__workflow.automaticDownloads++;
        if (window.__workflow.blockDownload === "throw")
          throw new DOMException(
            "Automatic download blocked",
            "NotAllowedError",
          );
        if (window.__workflow.blockDownload) return;
      }
      return click.call(this);
    };
    document.addEventListener("DOMContentLoaded", () => {
      const sample = () => {
        const progress = document.querySelector("#progress");
        if (!progress || progress.hidden) return;
        window.__workflow.samples.push({
          value: document
            .querySelector("#progress-meter")
            .getAttribute("aria-valuenow"),
          status: document.querySelector("#status")?.textContent,
          trackStatuses: [...document.querySelectorAll(".track-status")].map((el) => el.textContent),
          disabled: document.querySelector("#submit-button")?.disabled,
          inputsDisabled: [
            ...document.querySelectorAll("#edit-form input"),
          ].every((input) => input.disabled),
        });
      };
      new MutationObserver(sample).observe(
        document.querySelector("#edit-form"),
        {
          attributes: true,
          childList: true,
          characterData: true,
          subtree: true,
        },
      );
    });
  });
  const page = await context.newPage();
  const pageErrors = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  await page.goto(`${baseUrl}/main.html`);
  await page.waitForFunction(
    () => document.querySelector("#submit-button")?.disabled,
  );
  return { page, context, pageErrors };
}

async function ready(page, fixture = audioFixture) {
  await page.locator("#file").setInputFiles(fixture);
  await page.waitForFunction(
    () => !document.querySelector("#submit-button").disabled,
  );
  assert.equal(await page.locator("#file-name").textContent(), fixture.name);
  assert.ok(await page.locator("#file-summary").isVisible());
}

async function waitForSuccess(page) {
  await page.waitForFunction(() =>
    /MP3 created/i.test(document.querySelector("#status").textContent),
  );
  assert.ok(await page.locator("#download-link").isVisible());
  assert.match(
    await page.locator("#download-link").textContent(),
    /Download again/i,
  );
  assert.ok(await page.locator("#submit-button").isEnabled());
  assert.ok(await page.locator("#progress").isHidden());
}

async function convert(page, { doubleSubmit = false } = {}) {
  const downloadPromise = page.waitForEvent("download");
  if (doubleSubmit) {
    await page.evaluate(() => {
      const form = document.querySelector("#edit-form");
      form.requestSubmit();
      form.dispatchEvent(
        new Event("submit", { bubbles: true, cancelable: true }),
      );
    });
  } else {
    await page.locator("#submit-button").click();
  }
  const download = await downloadPromise;
  assert.equal(await download.failure(), null);
  const path = await download.path();
  const bytes = await readFile(path);
  await waitForSuccess(page);
  const tags = readTags(bytes);
  const duration = await page.evaluate(async () => {
    const response = await fetch(document.querySelector("#download-link").href);
    const buffer = await response.arrayBuffer();
    const context = new AudioContext();
    try {
      return (await context.decodeAudioData(buffer)).duration;
    } finally {
      await context.close();
    }
  });
  assert.ok(duration > 0.05, "actual downloaded MP3 decodes in the browser");
  return { download, bytes, tags };
}

let passed = 0;
let failed = 0;
async function check(name, test) {
  let editor;
  try {
    editor = await openEditor();
    await test(editor.page);
    assert.deepEqual(editor.pageErrors, [], "no uncaught browser errors");
    passed++;
    console.log(`ok ${name}`);
  } catch (error) {
    failed++;
    console.error(`FAIL ${name}: ${error.stack}`);
    if (editor) {
      await editor.page
        .screenshot({
          path: join(outputRoot, `failure-${failed}.png`),
          fullPage: true,
        })
        .catch(() => {});
      await writeFile(
        join(outputRoot, `failure-${failed}.html`),
        await editor.page.content(),
      ).catch(() => {});
    }
  } finally {
    await editor?.context.close();
  }
}

let completeMp3;
try {
  await check(
    "complete upload → metadata/artwork → real progress → automatic download; duplicate submit guard",
    async (page) => {
      assert.match(
        await page.locator("#submit-button").textContent(),
        /Add an audio file first/i,
      );
      await page.screenshot({
        path: join(outputRoot, "desktop-empty.png"),
        fullPage: true,
      });
      await ready(page);
      for (const [id, value] of Object.entries({
        title: "Night Walk",
        artist: "Local Artist",
        album: "After Hours",
        track: "3/10",
        genre: "Ambient",
      })) {
        await page.locator(`#${id}`).fill(value);
      }
      await page.locator("#cover").setInputFiles(artworkFixture);
      await page.locator("#cover-preview").waitFor({ state: "visible" });
      await page.waitForFunction(
        () => !document.querySelector("#submit-button").disabled,
      );
      const { download, bytes, tags } = await convert(page, {
        doubleSubmit: true,
      });
      assert.equal(
        download.suggestedFilename(),
        "Local Artist - Night Walk.mp3",
      );
      for (const [id, value] of Object.entries({
        TIT2: "Night Walk",
        TPE1: "Local Artist",
        TALB: "After Hours",
        TRCK: "3/10",
        TCON: "Ambient",
      }))
        assert.equal(tags[id], value);
      assert.ok(
        tags.APIC?.includes(artworkFixture.buffer),
        "selected artwork is embedded in the actual output",
      );
      const telemetry = await page.evaluate(() => window.__workflow);
      assert.equal(
        telemetry.automaticDownloads,
        1,
        "double submit produced one automatic download",
      );
      assert.ok(
        telemetry.samples.some((sample) => sample.value === null),
        "non-measurable stages use an indeterminate bar",
      );
      assert.ok(
        telemetry.samples.some(
          (sample) => Number(sample.value) > 0 && Number(sample.value) < 100,
        ),
        "encoder reports real intermediate percentage",
      );
      assert.ok(
        telemetry.samples.every((sample) => sample.disabled),
        "submit stays disabled during progress",
      );
      assert.ok(
        telemetry.samples.every((sample) => sample.inputsDisabled),
        "metadata and upload inputs stay disabled during progress",
      );
      assert.match(
        await page.locator("#status").textContent(),
        /download started/i,
      );
      completeMp3 = bytes;
      await writeFile(join(outputRoot, "Local Artist - Night Walk.mp3"), bytes);
      await page.screenshot({
        path: join(outputRoot, "desktop-success.png"),
        fullPage: true,
      });
    },
  );

  await check(
    "empty and partial metadata, no artwork, repeated conversion, and old URL cleanup",
    async (page) => {
      await ready(page);
      const first = await convert(page);
      assert.match(first.download.suggestedFilename(), /Source demo.*\.mp3$/);
      assert.equal(first.tags.APIC, undefined);
      assert.equal(first.tags.TIT2, undefined);
      const firstUrl = await page
        .locator("#download-link")
        .getAttribute("href");
      await page.locator("#title").fill("Only a title");
      assert.ok(await page.locator("#download-link").isHidden());
      await page.waitForFunction(
        (url) => window.__workflow.revoked.includes(url),
        firstUrl,
      );
      await page.locator("#track").fill("7");
      const second = await convert(page);
      assert.equal(second.tags.TIT2, "Only a title");
      assert.equal(second.tags.TRCK, "7");
      assert.equal(second.tags.TPE1, undefined);
      assert.equal(second.tags.APIC, undefined);
      const secondUrl = await page
        .locator("#download-link")
        .getAttribute("href");
      assert.notEqual(firstUrl, secondUrl);
      const manual = page.waitForEvent("download");
      await page.locator("#download-link").click();
      assert.equal(await (await manual).failure(), null);
      await page.locator("#remove-audio").click();
      assert.ok(await page.locator("#submit-button").isDisabled());
      assert.equal(
        await page.locator("#title").inputValue(),
        "Only a title",
        "removing audio retains manual metadata",
      );
      await page.waitForFunction(
        (url) => window.__workflow.revoked.includes(url),
        secondUrl,
      );
    },
  );

  await check(
    "existing MP3 tags/artwork prefill and user overrides survive exporting",
    async (page) => {
      assert.ok(completeMp3, "complete workflow produced source MP3 fixture");
      await ready(page, {
        name: "existing.mp3",
        mimeType: "audio/mpeg",
        buffer: completeMp3,
      });
      await page.waitForFunction(
        () => document.querySelector("#title").value === "Night Walk",
      );
      assert.equal(await page.locator("#artist").inputValue(), "Local Artist");
      assert.equal(await page.locator("#album").inputValue(), "After Hours");
      assert.equal(await page.locator("#track").inputValue(), "3/10");
      assert.equal(await page.locator("#genre").inputValue(), "Ambient");
      await page.locator("#cover-preview").waitFor({ state: "visible" });
      await page.locator("#title").fill("New title");
      await page.locator("#remove-cover").click();
      const result = await convert(page);
      assert.equal(result.tags.TIT2, "New title");
      assert.equal(
        result.tags.APIC,
        undefined,
        "removing imported art removes it from the exported MP3",
      );
    },
  );

  await check(
    "metadata import toggle applies to new uploads and leaves current edits alone",
    async (page) => {
      const toggle = page.getByLabel("Import embedded metadata", {
        exact: false,
      });
      assert.ok(await toggle.isChecked(), "import is enabled by default");
      const tagged = {
        name: "tagged.mp3",
        mimeType: "audio/mpeg",
        buffer: completeMp3,
      };
      await ready(page, tagged);
      await page.locator("#title").fill("My current edit");
      const coverUrl = await page.locator("#cover-preview").getAttribute("src");
      await toggle.uncheck();
      assert.equal(
        await page.locator("#title").inputValue(),
        "My current edit",
      );
      assert.equal(
        await page.locator("#cover-preview").getAttribute("src"),
        coverUrl,
      );
      await ready(page, tagged);
      assert.deepEqual(await fieldValues(page), {
        title: "",
        artist: "",
        album: "",
        track: "",
        genre: "",
      });
      assert.ok(await page.locator("#cover-preview").isHidden());
      assert.match(
        await page.locator("#metadata-note").textContent(),
        /import is off/i,
      );
      const result = await convert(page);
      for (const tag of ["TIT2", "TPE1", "TALB", "TRCK", "TCON", "APIC"])
        assert.equal(result.tags[tag], undefined);
      await page.locator("#title").fill("Manual details");
      await toggle.check();
      assert.equal(await page.locator("#title").inputValue(), "Manual details");
      await ready(page, tagged);
      assert.equal(await page.locator("#title").inputValue(), "Night Walk");
      assert.ok(await page.locator("#cover-preview").isVisible());
    },
  );

  await check(
    "disabling import on the next upload also blocks a previous file's delayed metadata",
    async (page) => {
      await delayMetadata(page, "old.mp3");
      await page
        .locator("#file")
        .setInputFiles({
          name: "old.mp3",
          mimeType: "audio/mpeg",
          buffer: completeMp3,
        });
      await page.waitForFunction(() => window.__metadataWaiting);
      await page.locator("#import-metadata").uncheck();
      await ready(page, {
        name: "new.mp3",
        mimeType: "audio/mpeg",
        buffer: completeMp3,
      });
      await releaseMetadata(page);
      assert.deepEqual(await fieldValues(page), {
        title: "",
        artist: "",
        album: "",
        track: "",
        genre: "",
      });
      assert.ok(await page.locator("#cover-preview").isHidden());
      assert.match(
        await page.locator("#metadata-note").textContent(),
        /import is off/i,
      );
      assert.ok(await page.locator("#submit-button").isEnabled());
    },
  );

  await check(
    "new FLAC metadata and embedded artwork replace all previous manual edits",
    async (page) => {
      await ready(page, {
        name: "Song A.mp3",
        mimeType: "audio/mpeg",
        buffer: completeMp3,
      });
      for (const id of ["title", "artist", "album", "track", "genre"]) {
        await page
          .locator(`#${id}`)
          .fill(id === "track" ? "9" : `Edited ${id}`);
      }
      await page.locator("#cover").setInputFiles(artworkFixture);
      await page.waitForFunction(
        () => !document.querySelector("#submit-button").disabled,
      );
      const previousUrl = await page
        .locator("#cover-preview")
        .getAttribute("src");
      const picture = Buffer.from(
        await page.evaluate(() => {
          const canvas = document.createElement("canvas");
          canvas.width = canvas.height = 2;
          const context = canvas.getContext("2d");
          context.fillStyle = "red";
          context.fillRect(0, 0, 2, 2);
          return canvas.toDataURL("image/png").split(",")[1];
        }),
        "base64",
      );
      await ready(
        page,
        taggedFlac(
          {
            TITLE: "Song B",
            ARTIST: "Artist B",
            ALBUM: "Album B",
            TRACKNUMBER: "2",
            GENRE: "Jazz",
          },
          picture,
        ),
      );
      assert.deepEqual(await fieldValues(page), {
        title: "Song B",
        artist: "Artist B",
        album: "Album B",
        track: "2",
        genre: "Jazz",
      });
      const currentUrl = await page
        .locator("#cover-preview")
        .getAttribute("src");
      assert.notEqual(currentUrl, previousUrl);
      assert.ok(
        await page.evaluate(
          (url) => window.__workflow.revoked.includes(url),
          previousUrl,
        ),
      );
      const embedded = await page.evaluate(
        async (url) => [
          ...new Uint8Array(await (await fetch(url)).arrayBuffer()),
        ],
        currentUrl,
      );
      assert.deepEqual(Buffer.from(embedded), picture);
    },
  );

  await check(
    "missing fields and artwork clear both imported values and manual edits",
    async (page) => {
      await ready(page, {
        name: "Song A.mp3",
        mimeType: "audio/mpeg",
        buffer: completeMp3,
      });
      await page.locator("#album").fill("My album");
      await page.locator("#track").fill("invalid");
      await page.locator("#track").blur();
      await page.locator("#cover").setInputFiles(artworkFixture);
      await page.waitForFunction(
        () => !document.querySelector("#submit-button").disabled,
      );
      const previousUrl = await page
        .locator("#cover-preview")
        .getAttribute("src");
      await ready(page, taggedFlac({ TITLE: "Song B", ARTIST: "Artist B" }));
      assert.deepEqual(await fieldValues(page), {
        title: "Song B",
        artist: "Artist B",
        album: "",
        track: "",
        genre: "",
      });
      assert.ok(await page.locator("#track-error").isHidden());
      assert.ok(await page.locator("#cover-preview").isHidden());
      assert.ok(
        await page.evaluate(
          (url) => window.__workflow.revoked.includes(url),
          previousUrl,
        ),
      );
      await ready(page);
      assert.deepEqual(await fieldValues(page), {
        title: "",
        artist: "",
        album: "",
        track: "",
        genre: "",
      });
      assert.ok(await page.locator("#audio-error").isHidden());
    },
  );

  for (const coverChoice of ["replace", "remove"]) {
    await check(
      `delayed metadata preserves current manual fields and artwork ${coverChoice}`,
      async (page) => {
        await delayMetadata(page, "delayed.mp3");
        await page
          .locator("#file")
          .setInputFiles({
            name: "delayed.mp3",
            mimeType: "audio/mpeg",
            buffer: completeMp3,
          });
        await page.waitForFunction(() => window.__metadataWaiting);
        await page.locator("#title").fill("My current title");
        await page.locator("#album").fill("Temporary");
        await page.locator("#album").fill("");
        await page.locator("#cover").setInputFiles(artworkFixture);
        await page.locator("#cover-preview").waitFor({ state: "visible" });
        const manualUrl = await page
          .locator("#cover-preview")
          .getAttribute("src");
        if (coverChoice === "remove")
          await page.locator("#remove-cover").click();
        await releaseMetadata(page);
        await page.waitForFunction(
          () => !document.querySelector("#submit-button").disabled,
        );
        assert.equal(
          await page.locator("#title").inputValue(),
          "My current title",
        );
        assert.equal(await page.locator("#album").inputValue(), "");
        assert.equal(
          await page.locator("#artist").inputValue(),
          "Local Artist",
        );
        assert.equal(
          await page.locator("#cover-preview").getAttribute("src"),
          coverChoice === "remove" ? null : manualUrl,
        );
        await ready(page, {
          name: "next.mp3",
          mimeType: "audio/mpeg",
          buffer: completeMp3,
        });
        assert.equal(await page.locator("#title").inputValue(), "Night Walk");
        assert.equal(await page.locator("#album").inputValue(), "After Hours");
        assert.ok(
          await page.locator("#cover-preview").isVisible(),
          "a previous manual removal does not suppress the new file's art",
        );
      },
    );
  }

  await check(
    "a stale metadata parse cannot change the newer file's fields, artwork, or status",
    async (page) => {
      await delayMetadata(page, "old.mp3");
      await page
        .locator("#file")
        .setInputFiles({
          name: "old.mp3",
          mimeType: "audio/mpeg",
          buffer: completeMp3,
        });
      await page.waitForFunction(() => window.__metadataWaiting);
      await ready(
        page,
        taggedFlac({ TITLE: "Current title", ARTIST: "Current artist" }),
      );
      await page.locator("#title").fill("Current edit");
      const note = await page.locator("#metadata-note").textContent();
      await releaseMetadata(page);
      assert.deepEqual(await fieldValues(page), {
        title: "Current edit",
        artist: "Current artist",
        album: "",
        track: "",
        genre: "",
      });
      assert.ok(await page.locator("#cover-preview").isHidden());
      assert.equal(await page.locator("#metadata-note").textContent(), note);
      assert.equal(
        await page.locator("#file-name").textContent(),
        "Song B.flac",
      );
      assert.ok(await page.locator("#submit-button").isEnabled());
    },
  );

  await check(
    "malformed metadata does not block loading or converting playable audio",
    async (page) => {
      await ready(page, {
        name: "old.mp3",
        mimeType: "audio/mpeg",
        buffer: completeMp3,
      });
      const buffer = Buffer.concat([
        audioFixture.buffer,
        Buffer.from("LIST"),
        Buffer.from([255, 255, 255, 127]),
      ]);
      buffer.writeUInt32LE(buffer.length - 8, 4);
      await ready(page, {
        name: "malformed-tags.wav",
        mimeType: "audio/wav",
        buffer,
      });
      assert.deepEqual(await fieldValues(page), {
        title: "",
        artist: "",
        album: "",
        track: "",
        genre: "",
      });
      assert.ok(await page.locator("#cover-preview").isHidden());
      assert.ok(await page.locator("#audio-error").isHidden());
      const result = await convert(page);
      assert.equal(result.tags.TIT2, undefined);
      assert.equal(result.tags.APIC, undefined);
    },
  );

  await check(
    "replacing source during an artwork read cannot restore the previous source's image",
    async (page) => {
      assert.ok(completeMp3);
      await page.evaluate(() => {
        const decode = HTMLImageElement.prototype.decode;
        const gate = new Promise((resolve) => {
          window.__releaseArtwork = resolve;
        });
        HTMLImageElement.prototype.decode = async function () {
          await decode.call(this);
          window.__delayedArtworkUrl = this.src;
          await gate;
        };
      });
      await page
        .locator("#file")
        .setInputFiles({
          name: "old-source.mp3",
          mimeType: "audio/mpeg",
          buffer: completeMp3,
        });
      await page.waitForFunction(() => Boolean(window.__delayedArtworkUrl));
      await page.locator("#title").fill("Edited while reading");
      await ready(page);
      assert.equal(
        await page.locator("#artist").inputValue(),
        "",
        "previous source's untouched fields are cleared",
      );
      assert.equal(await page.locator("#title").inputValue(), "");
      await page.evaluate(() => window.__releaseArtwork());
      await page.waitForFunction(() =>
        window.__workflow.revoked.includes(window.__delayedArtworkUrl),
      );
      assert.ok(await page.locator("#cover-preview").isHidden());
      const result = await convert(page);
      assert.equal(result.tags.APIC, undefined);
      assert.equal(result.tags.TIT2, undefined);
    },
  );

  await check(
    "Enter submits once and restores keyboard focus after conversion",
    async (page) => {
      await ready(page);
      await page.locator("#title").fill("Keyboard export");
      const downloaded = page.waitForEvent("download");
      await page.locator("#title").press("Enter");
      assert.equal(await (await downloaded).failure(), null);
      await waitForSuccess(page);
      assert.equal(
        await page.evaluate(() => document.activeElement.id),
        "title",
      );
      assert.equal(
        await page.evaluate(() => window.__workflow.automaticDownloads),
        1,
      );
    },
  );

  await check(
    "rejecting an artwork replacement does not preserve the previous source's art on new audio",
    async (page) => {
      assert.ok(completeMp3);
      await ready(page, {
        name: "tagged-source.mp3",
        mimeType: "audio/mpeg",
        buffer: completeMp3,
      });
      await page.locator("#cover-preview").waitFor({ state: "visible" });
      const importedUrl = await page
        .locator("#cover-preview")
        .getAttribute("src");
      await page
        .locator("#cover")
        .setInputFiles({
          name: "invalid.png",
          mimeType: "image/png",
          buffer: Buffer.from("An invalid replacement image"),
        });
      await page.locator("#cover-error").waitFor({ state: "visible" });
      assert.equal(
        await page.locator("#cover-preview").getAttribute("src"),
        importedUrl,
      );
      await ready(page);
      assert.ok(await page.locator("#cover-preview").isHidden());
      assert.ok(
        await page.evaluate(
          (url) => window.__workflow.revoked.includes(url),
          importedUrl,
        ),
      );
      const result = await convert(page);
      assert.equal(result.tags.APIC, undefined);
    },
  );

  await check(
    "rejecting new audio while source artwork loads lets the current source finish",
    async (page) => {
      assert.ok(completeMp3);
      await page.evaluate(() => {
        const decode = HTMLImageElement.prototype.decode;
        const gate = new Promise((resolve) => {
          window.__releaseArtwork = resolve;
        });
        HTMLImageElement.prototype.decode = async function () {
          await decode.call(this);
          window.__delayedArtworkUrl = this.src;
          await gate;
        };
      });
      await page
        .locator("#file")
        .setInputFiles({
          name: "current-source.mp3",
          mimeType: "audio/mpeg",
          buffer: completeMp3,
        });
      await page.waitForFunction(() => Boolean(window.__delayedArtworkUrl));
      await page
        .locator("#file")
        .setInputFiles({
          name: "unsupported.txt",
          mimeType: "text/plain",
          buffer: Buffer.from("The replacement is not an audio file"),
        });
      await page.locator("#audio-error").waitFor({ state: "visible" });
      assert.ok(
        await page.locator("#submit-button").isDisabled(),
        "still reading the current source",
      );
      await page.evaluate(() => window.__releaseArtwork());
      await page.waitForFunction(
        () => !document.querySelector("#submit-button").disabled,
      );
      assert.equal(
        await page.locator("#file-name").textContent(),
        "current-source.mp3",
      );
      assert.equal(await page.locator("#title").inputValue(), "Night Walk");
      assert.ok(await page.locator("#cover-preview").isVisible());
      assert.doesNotMatch(
        await page.locator("#metadata-note").textContent(),
        /Reading/,
      );
      const result = await convert(page);
      assert.ok(result.tags.APIC?.includes(artworkFixture.buffer));
      assert.equal(result.tags.TIT2, "Night Walk");
    },
  );

  await check(
    "unsupported and oversized audio show inline errors while a valid selection remains usable",
    async (page) => {
      await page
        .locator("#file")
        .setInputFiles({
          name: "notes.txt",
          mimeType: "text/plain",
          buffer: Buffer.from("This is not an audio file and must be rejected"),
        });
      await page.locator("#audio-error").waitFor({ state: "visible" });
      assert.match(
        await page.locator("#audio-error").textContent(),
        /not supported|unsupported/i,
      );
      assert.ok(await page.locator("#submit-button").isDisabled());
      await ready(page);
      await page.locator("#title").fill("Keep my edits");
      await page.evaluate(() => {
        const file = new File([new Uint8Array(48)], "oversized.wav", {
          type: "audio/wav",
        });
        Object.defineProperty(file, "size", { value: 2 * 1024 ** 3 });
        const transfer = new DataTransfer();
        transfer.items.add(file);
        document.querySelector("#file").files = transfer.files;
        document
          .querySelector("#file")
          .dispatchEvent(new Event("change", { bubbles: true }));
      });
      await page.locator("#audio-error").waitFor({ state: "visible" });
      assert.match(
        await page.locator("#audio-error").textContent(),
        /large|MB|limit/i,
      );
      assert.equal(await page.locator("#title").inputValue(), "Keep my edits");
      assert.equal(
        await page.locator("#file-name").textContent(),
        audioFixture.name,
      );
      assert.ok(await page.locator("#submit-button").isEnabled());
    },
  );

  await check(
    "corrupt audio processing failure retains edits until another file is loaded",
    async (page) => {
      await ready(page, {
        name: "corrupt.wav",
        mimeType: "audio/wav",
        buffer: Buffer.from("RIFF0000WAVEthis file has no valid audio data"),
      });
      await page.locator("#title").fill("Do not lose this");
      await page.locator("#artist").fill("Retry artist");
      await page.locator("#cover").setInputFiles(artworkFixture);
      await page.locator("#cover-preview").waitFor({ state: "visible" });
      await page.locator("#submit-button").click();
      await page.waitForFunction(() =>
        document.querySelector("#status").classList.contains("err"),
      );
      assert.ok(await page.locator("#submit-button").isEnabled());
      assert.ok(await page.locator("#progress").isHidden());
      assert.equal(
        await page.locator("#title").inputValue(),
        "Do not lose this",
      );
      assert.ok(await page.locator("#cover-preview").isVisible());
      assert.equal(
        await page.evaluate(() => window.__workflow.automaticDownloads),
        0,
      );
      await ready(page);
      assert.equal(await page.locator("#title").inputValue(), "");
      const result = await convert(page);
      assert.equal(result.tags.TIT2, undefined);
      assert.equal(result.tags.APIC, undefined);
    },
  );

  await check(
    "track number validation supports N and N/total and focuses an invalid field",
    async (page) => {
      await ready(page);
      for (const value of ["0", "3/2", "three", "3/0", "1/2/3", "-1"]) {
        await page.locator("#track").fill(value);
        await page.locator("#track").blur();
        await page.locator("#track-error").waitFor({ state: "visible" });
        assert.equal(
          await page.locator("#track").getAttribute("aria-invalid"),
          "true",
        );
        await page.evaluate(() =>
          document.querySelector("#edit-form").requestSubmit(),
        );
        assert.equal(
          await page.evaluate(() => document.activeElement.id),
          "track",
        );
      }
      for (const value of ["3", "3/10", ""]) {
        await page.locator("#track").fill(value);
        await page.locator("#track").blur();
        assert.ok(await page.locator("#track-error").isHidden());
        assert.ok(await page.locator("#submit-button").isEnabled());
      }
      assert.equal(
        await page.evaluate(() => window.__workflow.automaticDownloads),
        0,
      );
    },
  );

  await check(
    "artwork validation, replacement, removal, and preview URL cleanup",
    async (page) => {
      await ready(page);
      await page
        .locator("#cover")
        .setInputFiles({
          name: "not-art.svg",
          mimeType: "image/svg+xml",
          buffer: Buffer.from("<svg xmlns='http://www.w3.org/2000/svg'/>"),
        });
      await page.locator("#cover-error").waitFor({ state: "visible" });
      await page.locator("#cover").setInputFiles(artworkFixture);
      await page.locator("#cover-preview").waitFor({ state: "visible" });
      const firstUrl = await page.locator("#cover-preview").getAttribute("src");
      await page
        .locator("#cover")
        .setInputFiles({ ...artworkFixture, name: "replacement.png" });
      await page.waitForFunction(
        (url) => document.querySelector("#cover-preview").src !== url,
        firstUrl,
      );
      assert.ok(
        await page.evaluate(
          (url) => window.__workflow.revoked.includes(url),
          firstUrl,
        ),
      );
      const secondUrl = await page
        .locator("#cover-preview")
        .getAttribute("src");
      await page.evaluate(() => {
        const file = new File([new Uint8Array(48)], "oversized.png", {
          type: "image/png",
        });
        Object.defineProperty(file, "size", { value: 20_000_000 });
        const transfer = new DataTransfer();
        transfer.items.add(file);
        document.querySelector("#cover").files = transfer.files;
        document
          .querySelector("#cover")
          .dispatchEvent(new Event("change", { bubbles: true }));
      });
      await page.locator("#cover-error").waitFor({ state: "visible" });
      assert.match(
        await page.locator("#cover-error").textContent(),
        /large|MB|limit/i,
      );
      assert.equal(
        await page.locator("#cover-preview").getAttribute("src"),
        secondUrl,
      );
      await page
        .locator("#cover")
        .setInputFiles({
          name: "broken.png",
          mimeType: "image/png",
          buffer: artworkFixture.buffer.subarray(0, 16),
        });
      await page.locator("#cover-error").waitFor({ state: "visible" });
      assert.equal(
        await page.locator("#cover-preview").getAttribute("src"),
        secondUrl,
        "invalid replacement preserves current artwork",
      );
      await page.locator("#remove-cover").click();
      assert.ok(await page.locator("#cover-preview").isHidden());
      assert.ok(
        await page.evaluate(
          (url) => window.__workflow.revoked.includes(url),
          secondUrl,
        ),
      );
      assert.equal(await page.locator("#cover").inputValue(), "");
    },
  );

  await check(
    "drag-over feedback and dropping a replacement into the populated source",
    async (page) => {
      await ready(page);
      await page.locator("#title").fill("Cleared when replacing");
      const transfer = await page.evaluateHandle(
        (bytes) => {
          const transfer = new DataTransfer();
          transfer.items.add(
            new File([new Uint8Array(bytes)], "Dropped replacement.wav", {
              type: "audio/wav",
            }),
          );
          return transfer;
        },
        [...audioFixture.buffer],
      );
      await page
        .locator("#file-summary")
        .dispatchEvent("dragenter", { dataTransfer: transfer });
      const highlighted = await page
        .locator("#file-summary")
        .evaluate(
          (node) =>
            node.matches(".is-drag-active") ||
            Boolean(node.closest(".is-drag-active")),
        );
      assert.ok(highlighted, "populated source visibly responds to drag-over");
      await page
        .locator("#file-summary")
        .dispatchEvent("drop", { dataTransfer: transfer });
      await page.waitForFunction(
        () =>
          document.querySelector("#file-name").textContent ===
          "Dropped replacement.wav",
      );
      assert.equal(await page.locator("#title").inputValue(), "");
      await transfer.dispose();
      await convert(page);
    },
  );

  for (const block of [true, "throw"]) {
    await check(
      `automatic download ${block === true ? "silently blocked" : "throws"}: completed MP3 remains manually downloadable`,
      async (page) => {
        await ready(page);
        await page.evaluate((mode) => {
          window.__workflow.blockDownload = mode;
        }, block);
        await page.locator("#submit-button").click();
        await page.locator("#download-link").waitFor({ state: "visible" });
        await page.waitForFunction(
          () => !document.querySelector("#submit-button").disabled,
        );
        assert.ok(await page.locator("#download-recovery").isVisible());
        assert.match(
          await page.locator("#download-recovery").textContent(),
          /download|browser/i,
        );
        const downloadPromise = page.waitForEvent("download");
        await page.locator("#download-link").click();
        const downloaded = await downloadPromise;
        assert.equal(await downloaded.failure(), null);
        readTags(await readFile(await downloaded.path()));
      },
    );
  }

  await runBatchChecks({
    check,
    ready,
    completeMp3,
    audioFixture,
    artworkFixture,
    delayMetadata,
    releaseMetadata,
    readTags,
    outputRoot,
  });

  await check(
    "mobile layout, focus visibility, labels, status announcements, and reduced motion",
    async (page) => {
      for (const width of [320, 375, 768, 1280]) {
        await page.setViewportSize({ width, height: 900 });
        assert.ok(
          await page.evaluate(
            () => document.documentElement.scrollWidth <= window.innerWidth,
          ),
          `no horizontal overflow at ${width}px`,
        );
      }
      await page.setViewportSize({ width: 375, height: 900 });
      await page.keyboard.press("Tab");
      assert.equal(
        await page.evaluate(() => document.activeElement.id),
        "file",
      );
      const focus = await page.locator("#audio-drop").evaluate((node) => {
        const style = getComputedStyle(node);
        return {
          outline: style.outlineStyle,
          width: style.outlineWidth,
          shadow: style.boxShadow,
        };
      });
      assert.ok(
        (focus.outline !== "none" && focus.width !== "0px") ||
          focus.shadow !== "none",
        "keyboard upload focus is visible",
      );
      for (const id of [
        "title",
        "artist",
        "album",
        "track",
        "genre",
        "cover",
      ]) {
        assert.ok(
          await page
            .locator(`#${id}`)
            .evaluate((node) => node.labels?.length > 0),
          `${id} has an associated label`,
        );
      }
      assert.equal(
        await page.locator("#status").getAttribute("aria-live"),
        "polite",
      );
      for (const id of ["audio-error", "cover-error", "track-error"])
        assert.equal(
          await page.locator(`#${id}`).getAttribute("role"),
          "alert",
        );
      await ready(page, {
        ...audioFixture,
        name: `${"A long source filename ".repeat(8)}.wav`,
      });
      await page.locator("#title").fill("Mobile title");
      assert.ok(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= window.innerWidth,
        ),
        "long selected filename does not overflow mobile",
      );
      await page.screenshot({
        path: join(outputRoot, "mobile-ready.png"),
        fullPage: true,
      });
      await convert(page);
      assert.ok(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= window.innerWidth,
        ),
        "mobile success/download state does not overflow",
      );
      await page.screenshot({
        path: join(outputRoot, "mobile-success.png"),
        fullPage: true,
      });
    },
  );
} finally {
  await browser.close();
  await new Promise((resolve) => server.close(resolve));
}

console.log(
  `\n${passed} browser workflows passed; ${failed} failed. Screenshots and actual output: tests/_out/workflow/`,
);
process.exitCode = failed ? 1 : 0;
