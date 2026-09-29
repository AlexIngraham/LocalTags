import { readSourceMetadata } from "./metadata.js";
import { createZip, uniqueFilename } from "./zip.js";

const FIELD_LABELS = { track: "Track number", title: "Title", artist: "Artist", album: "Album", albumArtist: "Album artist", genre: "Genre" };

export function createBatchEditor(host) {
  const root = document.getElementById("batch-editor");
  const list = document.getElementById("track-list");
  const summary = document.getElementById("batch-summary");
  const albumDownload = document.getElementById("album-download");
  const bulkMessage = document.getElementById("bulk-message");
  const sharedCoverInput = document.getElementById("album-cover");
  const sharedPreview = document.getElementById("album-cover-preview");
  const bulkKeys = ["album", "albumArtist", "genre"];
  const shared = { cover: null, url: null, version: 0, pending: false };
  let tracks = [];
  let nextId = 0;
  let active = false;
  let busy = false;
  let orderVersion = 0;
  let archiveUrl = null;
  let currentTrack = null;
  let processingIndex = 0;
  let workers = 0;
  const jobs = [];
  const retired = new Map();
  const alive = (track) => tracks.includes(track);
  const reading = () => tracks.some((track) => track.pending || track.coverPending);

  function retire(url) {
    if (!url) return;
    retired.set(url, setTimeout(() => { URL.revokeObjectURL(url); retired.delete(url); }, 60_000));
  }

  function clearArchive() {
    if (!busy) host.setStatus("");
    retire(archiveUrl);
    archiveUrl = null;
    albumDownload.hidden = true;
    albumDownload.removeAttribute("href");
  }

  function invalidate(track) {
    clearArchive();
    if (track.result) retire(track.result.url);
    track.result = null;
    if (!track.pending && !track.loadError) track.status = "Waiting";
    track.error = track.loadError || "";
  }

  function createCard(track) {
    const card = document.createElement("article");
    card.className = "track-card";
    card.dataset.trackId = track.id;
    card.innerHTML = `
      <div class="track-card-heading">
        <label class="track-selection"><input type="checkbox" data-select /><span class="track-filename"></span></label>
        <span class="track-format"></span><span class="track-status" role="status"></span>
      </div>
      <div class="track-fields">${Object.entries(FIELD_LABELS).map(([key, label]) => `
        <div class="field"><label for="${track.id}-${key}">${label}</label>
        <input id="${track.id}-${key}" data-field="${key}" type="text" autocomplete="off" /></div>`).join("")}</div>
      <div class="track-card-footer">
        <img class="track-cover" alt="Track artwork" hidden />
        <label class="quiet-button track-cover-picker" for="${track.id}-cover">Choose artwork</label>
        <input id="${track.id}-cover" data-cover type="file" class="visually-hidden-file" accept="image/jpeg,image/png,image/gif,image/webp" />
        <button type="button" class="text-button" data-action="cover-remove">Clear artwork</button>
        <a class="download-link track-download" hidden>Download MP3</a>
        <div class="track-order-actions">
          <button type="button" class="quiet-button" data-action="up" aria-label="Move track up">↑</button>
          <button type="button" class="quiet-button" data-action="down" aria-label="Move track down">↓</button>
          <button type="button" class="quiet-button" data-action="remove">Remove track</button>
        </div>
      </div>
      <p class="field-message track-error" role="alert" hidden></p>`;
    return card;
  }

  function renderTrack(track) {
    const card = track.card;
    card.querySelector(".track-filename").textContent = track.file.name;
    card.querySelector(".track-format").textContent = track.format ? host.formatLabel(track.format) : "Checking format";
    card.querySelector(".track-status").textContent = track.coverPending ? "Reading artwork" : track.status;
    card.dataset.status = track.status.toLowerCase();
    card.querySelector("[data-select]").checked = track.selected;
    for (const [key, value] of Object.entries(track.values)) {
      const input = card.querySelector(`[data-field="${key}"]`);
      if (input.value !== value) input.value = value;
      if (key === "track") input.setAttribute("aria-invalid", String(!host.validTrack(value)));
    }
    const image = card.querySelector(".track-cover");
    image.hidden = !track.coverUrl;
    if (track.coverUrl) image.src = track.coverUrl;
    else image.removeAttribute("src");
    const error = card.querySelector(".track-error");
    error.textContent = track.error || track.coverError || "";
    error.hidden = !error.textContent;
    const link = card.querySelector(".track-download");
    link.hidden = !track.result;
    if (track.result) {
      link.href = track.result.url;
      link.download = track.result.name;
    } else link.removeAttribute("href");
  }

  function render() {
    tracks.forEach((track, index) => {
      renderTrack(track);
      if (list.children[index] !== track.card) list.insertBefore(track.card, list.children[index] || null);
    });
    const selected = tracks.filter((track) => track.selected).length;
    summary.textContent = `${tracks.length} tracks · ${selected} selected`;
    const selectAll = document.getElementById("select-all-tracks");
    selectAll.checked = tracks.length > 0 && selected === tracks.length;
    selectAll.indeterminate = selected > 0 && selected < tracks.length;
    host.updateActions();
  }

  async function setCover(track, file, userEdit = true) {
    if (!alive(track)) return;
    if (userEdit) track.coverEdited = true;
    const version = ++track.coverVersion;
    track.coverPending = Boolean(file);
    track.coverError = "";
    invalidate(track);
    render();
    let url = null;
    try {
      if (file) url = await host.validateArtwork(file);
      if (!alive(track) || version !== track.coverVersion) return;
      if (track.coverUrl) URL.revokeObjectURL(track.coverUrl);
      track.cover = file;
      track.coverUrl = url;
      url = null;
    } catch (error) {
      if (alive(track) && version === track.coverVersion) track.coverError = error.message;
    } finally {
      if (url) URL.revokeObjectURL(url);
      if (alive(track) && version === track.coverVersion) {
        track.coverPending = false;
        render();
      }
    }
  }

  async function readTrack(track, importMetadata) {
    try {
      if (!alive(track)) return;
      track.status = "Reading metadata";
      render();
      track.format = await host.inspectAudio(track.file);
      if (!alive(track)) return;
      if (importMetadata) {
        // Parsers already recover from corrupt tags; keep the batch usable even
        // if a browser File read or an unexpected parser exception rejects.
        const source = await readSourceMetadata(track.file).catch(() => ({}));
        if (!alive(track)) return;
        for (const key of Object.keys(FIELD_LABELS)) {
          if (!track.edited.has(key)) track.values[key] = source[key] || "";
        }
        if (source.cover && !track.coverEdited) await setCover(track, source.cover, false);
      }
      if (alive(track)) track.status = "Waiting";
    } catch (error) {
      if (alive(track)) {
        track.loadError = error.message;
        track.error = error.message;
        track.status = "Error";
      }
    } finally {
      if (alive(track)) {
        track.pending = false;
        render();
      }
    }
  }

  function pump() {
    while (workers < 2 && jobs.length) {
      const job = jobs.shift();
      if (!alive(job.track)) { job.resolve(); continue; }
      workers++;
      let released = false;
      const release = () => {
        if (released) return;
        released = true;
        workers--;
        job.track.releaseRead = null;
        job.resolve();
        pump();
      };
      // File reads cannot be physically aborted. Detach a removed entry from
      // the queue so an old stalled read cannot hold up a newly added album.
      job.track.releaseRead = release;
      readTrack(job.track, job.importMetadata).finally(release);
    }
  }

  function compareTracks(a, b) {
    const number = (track) => Number.parseInt(track.values.track, 10) || Infinity;
    const left = number(a), right = number(b);
    return (left === right ? 0 : left - right) || a.file.name.localeCompare(b.file.name, undefined, { numeric: true });
  }

  async function add(files, importMetadata, seed = null) {
    if (busy) return;
    active = true;
    root.hidden = false;
    clearArchive();
    const initiallyEmpty = !tracks.length;
    const revision = ++orderVersion;
    const entries = [...(seed ? [seed.file] : []), ...files];
    const pending = entries.map((file, index) => {
      const initial = seed && index === 0 ? seed : null;
      const track = {
        id: `track-${++nextId}`, file, format: initial?.format || null,
        values: Object.fromEntries(Object.keys(FIELD_LABELS).map((key) => [key, initial?.values[key] || ""])),
        edited: new Set(initial?.edited || []), selected: false, pending: true,
        status: "Waiting", loadError: "", error: "", coverError: "", result: null,
        cover: initial?.cover || null, coverUrl: initial?.cover ? URL.createObjectURL(initial.cover) : null,
        coverEdited: initial?.coverEdited || false, coverVersion: 0, coverPending: false,
      };
      track.card = createCard(track);
      tracks.push(track);
      if (initial?.pendingCover) setCover(track, initial.pendingCover);
      return new Promise((resolve) => jobs.push({ track, importMetadata: initial?.importMetadata ?? importMetadata, resolve }));
    });
    render();
    pump();
    await Promise.all(pending);
    // Initial sorting is a convenience. Never undo a user's reorder/numbering
    // or reshuffle existing edits when another upload has joined the album.
    if (initiallyEmpty && revision === orderVersion) {
      tracks.sort(compareTracks);
      render();
    }
  }

  function remove(track) {
    if (busy || !alive(track)) return;
    orderVersion++;
    invalidate(track);
    if (track.coverUrl) URL.revokeObjectURL(track.coverUrl);
    tracks = tracks.filter((entry) => entry !== track);
    track.releaseRead?.();
    track.card.remove();
    render();
  }

  function clear() {
    if (busy) return;
    for (const track of [...tracks]) remove(track);
    shared.version++;
    shared.pending = false;
    shared.cover = null;
    if (shared.url) URL.revokeObjectURL(shared.url);
    shared.url = null;
    sharedPreview.hidden = true;
    sharedPreview.removeAttribute("src");
    sharedCoverInput.value = "";
    bulkKeys.forEach((key) => { document.getElementById(`bulk-${key}`).value = ""; });
    root.querySelectorAll("[data-bulk-use]").forEach((input) => { input.checked = false; });
    bulkMessage.textContent = "";
    render();
  }

  function applyBulk(selectedOnly) {
    if (busy || shared.pending) return;
    const targets = tracks.filter((track) => !selectedOnly || track.selected);
    const keys = bulkKeys.filter((key) => document.getElementById(`use-${key}`).checked);
    const useCover = document.getElementById("use-cover").checked;
    if (!targets.length || (!keys.length && !useCover)) {
      bulkMessage.textContent = !targets.length ? "Select tracks first." : "Choose which shared fields to apply.";
      return;
    }
    for (const track of targets) {
      for (const key of keys) {
        track.edited.add(key);
        track.values[key] = document.getElementById(`bulk-${key}`).value;
      }
      invalidate(track);
      if (useCover) {
        // The shared file was already validated. A fresh preview URL belongs to
        // each track, so removing one track cannot revoke another track's art.
        track.coverVersion++;
        track.coverPending = false;
        track.coverEdited = true;
        track.coverError = "";
        if (track.coverUrl) URL.revokeObjectURL(track.coverUrl);
        track.cover = shared.cover;
        track.coverUrl = shared.cover ? URL.createObjectURL(shared.cover) : null;
      }
    }
    bulkMessage.textContent = `Shared details applied to ${targets.length} track${targets.length === 1 ? "" : "s"}.`;
    render();
  }

  async function process() {
    if (busy || reading() || shared.pending || !tracks.length) return;
    busy = true;
    for (const track of tracks) invalidate(track);
    host.setBusy(true);
    render();
    let completed = 0;
    const usedNames = new Set();
    try {
      for (const [index, track] of tracks.entries()) {
        currentTrack = track;
        processingIndex = index + 1;
        try {
          if (track.loadError) throw new Error(track.loadError);
          if (!host.validTrack(track.values.track)) throw new Error("Use a track number from 1–9999, or track/total with total at least the track number.");
          const values = Object.fromEntries(Object.entries(track.values).map(([key, value]) => [key, value.trim()]));
          const blob = await host.processTrack({ file: track.file, values, cover: track.cover });
          const number = Number.parseInt(values.track, 10);
          const title = host.safeName(values.title || track.file.name.replace(/\.[^.]+$/, ""));
          const name = uniqueFilename(number ? `${String(number).padStart(2, "0")} - ${[...title].slice(0, 100).join("") || "Track"}.mp3`
            : host.outputName(values.artist, values.title, track.file.name), usedNames);
          track.result = { blob, name, url: URL.createObjectURL(blob) };
          track.status = "Complete";
          completed++;
        } catch (error) {
          track.status = "Error";
          track.error = error.message || "This track could not be processed. Try another source file.";
        }
        render();
      }
      currentTrack = null;
      if (completed) {
        host.setStatus("Preparing album ZIP…");
        const blob = await createZip(tracks.filter((track) => track.result).map((track) => track.result));
        archiveUrl = URL.createObjectURL(blob);
        const albums = new Set(tracks.filter((track) => track.result).map((track) => track.values.album.trim()).filter(Boolean));
        const album = albums.size === 1 ? [...albums][0] : "Tagged album";
        albumDownload.href = archiveUrl;
        albumDownload.download = `${[...host.safeName(album)].slice(0, 100).join("") || "Tagged album"}.zip`;
        albumDownload.hidden = false;
      }
      host.setStatus(`Album processed: ${completed} complete, ${tracks.length - completed} failed.${completed ? " Download your album or individual tracks." : " Check the errors below each track."}`, completed ? "ok" : "err");
    } catch (error) {
      host.setStatus(`${completed} tracks complete. ${error.message} Individual downloads remain available.`, "err");
    } finally {
      currentTrack = null;
      busy = false;
      host.finishProcessing();
      render();
    }
  }

  list.addEventListener("input", (event) => {
    if (busy) return;
    const track = tracks.find((entry) => entry.id === event.target.closest(".track-card")?.dataset.trackId);
    if (!track) return;
    if (event.target.matches("[data-select]")) track.selected = event.target.checked;
    const key = event.target.dataset.field;
    if (key) {
      track.values[key] = event.target.value;
      track.edited.add(key);
      if (key === "track") orderVersion++;
      invalidate(track);
    }
    render();
  });
  list.addEventListener("change", (event) => {
    if (busy || !event.target.matches("[data-cover]")) return;
    const track = tracks.find((entry) => entry.id === event.target.closest(".track-card")?.dataset.trackId);
    const file = event.target.files?.[0];
    if (track && file) setCover(track, file);
    event.target.value = "";
  });
  list.addEventListener("click", (event) => {
    const action = event.target.closest("[data-action]")?.dataset.action;
    if (busy || !action) return;
    const track = tracks.find((entry) => entry.id === event.target.closest(".track-card")?.dataset.trackId);
    if (!track) return;
    if (action === "remove") remove(track);
    else if (action === "cover-remove") setCover(track, null);
    else {
      const index = tracks.indexOf(track);
      const next = index + (action === "up" ? -1 : 1);
      if (next < 0 || next >= tracks.length) return;
      [tracks[index], tracks[next]] = [tracks[next], tracks[index]];
      orderVersion++;
      clearArchive();
      render();
    }
  });
  document.getElementById("select-all-tracks").addEventListener("change", (event) => {
    if (busy) return;
    tracks.forEach((track) => { track.selected = event.target.checked; });
    render();
  });
  document.getElementById("clear-batch").addEventListener("click", clear);
  document.getElementById("sort-tracks").addEventListener("click", () => {
    if (busy) return;
    orderVersion++;
    tracks.sort(compareTracks);
    clearArchive();
    render();
  });
  document.getElementById("number-tracks").addEventListener("click", () => {
    if (busy) return;
    orderVersion++;
    tracks.forEach((track, index) => {
      track.values.track = String(index + 1);
      track.edited.add("track");
      invalidate(track);
    });
    render();
  });
  for (const key of bulkKeys) document.getElementById(`bulk-${key}`).addEventListener("input", () => {
    document.getElementById(`use-${key}`).checked = true;
  });
  document.getElementById("apply-all").addEventListener("click", () => applyBulk(false));
  document.getElementById("apply-selected").addEventListener("click", () => applyBulk(true));
  sharedCoverInput.addEventListener("change", async () => {
    const file = sharedCoverInput.files?.[0];
    if (busy || !file) return;
    const version = ++shared.version;
    shared.pending = true;
    bulkMessage.textContent = "Checking album artwork…";
    render();
    let url = null;
    try {
      url = await host.validateArtwork(file);
      if (version !== shared.version) return;
      if (shared.url) URL.revokeObjectURL(shared.url);
      shared.cover = file;
      shared.url = url;
      url = null;
      sharedPreview.src = shared.url;
      sharedPreview.hidden = false;
      document.getElementById("use-cover").checked = true;
      bulkMessage.textContent = "Album artwork ready. Choose Apply to copy it to tracks.";
    } catch (error) {
      if (version === shared.version) bulkMessage.textContent = error.message;
    } finally {
      if (url) URL.revokeObjectURL(url);
      if (version === shared.version) {
        shared.pending = false;
        sharedCoverInput.value = "";
        render();
      }
    }
  });
  document.getElementById("clear-album-cover").addEventListener("click", () => {
    if (busy) return;
    shared.version++;
    shared.pending = false;
    shared.cover = null;
    if (shared.url) URL.revokeObjectURL(shared.url);
    shared.url = null;
    sharedPreview.hidden = true;
    sharedPreview.removeAttribute("src");
    document.getElementById("use-cover").checked = true;
    bulkMessage.textContent = "Choose Apply to clear artwork from those tracks.";
    render();
  });

  return {
    get active() { return active; },
    get checking() { return reading() || shared.pending; },
    get count() { return tracks.length; },
    add, process, clear,
    stage(label) {
      if (!currentTrack) return label;
      currentTrack.status = /metadata|artwork/i.test(label) ? "Tagging" : /decod|creating/i.test(label) ? "Converting" : "Reading audio";
      renderTrack(currentTrack);
      return `Processing ${processingIndex} of ${tracks.length} · ${label}`;
    },
    updateControls(processing) {
      root.querySelectorAll("input, button").forEach((control) => { control.disabled = processing; });
      for (const id of ["apply-all", "apply-selected"]) document.getElementById(id).disabled = processing || shared.pending;
    },
    dispose() {
      for (const track of tracks) {
        if (track.coverUrl) URL.revokeObjectURL(track.coverUrl);
        if (track.result) URL.revokeObjectURL(track.result.url);
      }
      if (archiveUrl) URL.revokeObjectURL(archiveUrl);
      if (shared.url) URL.revokeObjectURL(shared.url);
      for (const [url, timer] of retired) { clearTimeout(timer); URL.revokeObjectURL(url); }
      retired.clear();
    },
  };
}
