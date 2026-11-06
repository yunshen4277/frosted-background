/* WebM fallback for VS Code builds whose FFmpeg omits the WebM demuxer.
 * MediaSource uses Chromium's parser instead. See microsoft/vscode#195758 and
 * microsoft/vscode#343725 (MIT). This independently implemented helper keeps
 * parsing, memory, retry and lifetime bounds shared by both extension players. */
(function (root, factory) {
  'use strict';
  const api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.FrostedWebm = api;
})(typeof globalThis === 'object' ? globalThis : this, function (root) {
  'use strict';
  const MAX_BYTES = 500 * 1024 * 1024;
  const HEADER_BYTES = 65536;
  const CHUNK_BYTES = 1024 * 1024;
  const codecs = Object.freeze({ V_VP8: 'vp8', V_VP9: 'vp9', V_AV1: 'av01.0.08M.08', A_OPUS: 'opus', A_VORBIS: 'vorbis' });
  const ownFailures = new WeakSet();
  function failure(code, message) { const error = new Error(message); error.code = code; ownFailures.add(error); return error; }
  function bytesOf(value) {
    if (Object.prototype.toString.call(value) !== '[object Uint8Array]') throw failure('WEBM_FORMAT', 'WebM media bytes are unavailable.');
    if (!value.byteLength || value.byteLength > MAX_BYTES) throw failure('WEBM_LIMIT', 'WebM media is empty or exceeds 500 MB.');
    return value;
  }

  // Walk only bounded EBML headers/Tracks. Looking for codec strings in arbitrary
  // compressed bytes could falsely claim support for a different actual codec.
  function inspectWebm(value) {
    const bytes = bytesOf(value);
    const end = Math.min(bytes.byteLength, HEADER_BYTES);
    let elements = 0;
    const bad = () => failure('WEBM_FORMAT', 'The WebM header or its tracks are unsupported.');
    function vint(offset, id) {
      if (offset >= end || !bytes[offset]) throw bad();
      let width = 1, mask = 128;
      while (!(bytes[offset] & mask)) { width++; mask >>= 1; }
      if (width > (id ? 4 : 8) || offset + width > end) throw bad();
      let number = id ? bytes[offset] : bytes[offset] & (mask - 1);
      let unknown = !id && number === mask - 1;
      for (let index = 1; index < width; index++) {
        number = number * 256 + bytes[offset + index];
        unknown = unknown && bytes[offset + index] === 255;
      }
      if (!unknown && !Number.isSafeInteger(number)) throw bad();
      return { number, width, unknown };
    }
    function element(offset, limit) {
      if (++elements > 2048) throw bad();
      const id = vint(offset, true), size = vint(offset + id.width, false);
      const start = offset + id.width + size.width;
      const stop = size.unknown ? limit : start + size.number;
      if (start > limit || stop > bytes.byteLength || stop > limit || stop < start) throw bad();
      return { id: id.number, start, end: stop, unknown: size.unknown };
    }
    function ascii(item) {
      if (item.unknown || item.end > end || item.end - item.start > 64) throw bad();
      let text = '';
      for (let index = item.start; index < item.end; index++) {
        if (bytes[index] < 32 || bytes[index] > 126) throw bad();
        text += String.fromCharCode(bytes[index]);
      }
      return text;
    }
    const header = element(0, bytes.byteLength);
    if (header.id !== 0x1a45dfa3 || header.unknown || header.end > end) throw bad();
    let docType;
    for (let offset = header.start; offset < header.end;) {
      const item = element(offset, header.end);
      if (item.unknown) throw bad();
      if (item.id === 0x4282) docType = ascii(item);
      offset = item.end;
    }
    if (docType !== 'webm' && docType !== 'matroska') throw bad();
    const segment = element(header.end, bytes.byteLength);
    if (segment.id !== 0x18538067) throw bad();
    let tracks;
    for (let offset = segment.start; offset < Math.min(segment.end, end);) {
      const item = element(offset, segment.end);
      if (item.id === 0x1f43b675) break;
      if (item.unknown) throw bad();
      if (item.id === 0x1654ae6b) { tracks = item; break; }
      offset = item.end;
    }
    if (!tracks || tracks.end > end) throw bad();
    const found = new Map();
    for (let offset = tracks.start; offset < tracks.end;) {
      const entry = element(offset, tracks.end);
      if (entry.unknown) throw bad();
      offset = entry.end;
      if (entry.id !== 0xae) continue;
      let type, codec;
      for (let child = entry.start; child < entry.end;) {
        const field = element(child, entry.end);
        if (field.unknown) throw bad();
        if (field.id === 0x83) {
          if (field.end - field.start !== 1) throw bad();
          type = bytes[field.start];
        } else if (field.id === 0x86) codec = ascii(field);
        child = field.end;
      }
      if (![1, 2].includes(type) || found.has(type) || !codecs[codec] || !codec.startsWith(type === 1 ? 'V_' : 'A_')) throw bad();
      found.set(type, codecs[codec]);
    }
    if (!found.has(1)) throw bad();
    return `video/webm; codecs="${[found.get(1), found.get(2)].filter(Boolean).join(',')}"`;
  }

  function createFallback(options) {
    if (!options?.video || (!options.bytes && typeof options.load !== 'function')) throw new TypeError('A video and WebM bytes or loader are required.');
    const video = options.video;
    const onReady = options.onReady, onError = options.onError;
    const controller = new root.AbortController();
    let supplied = options.bytes, load = options.load;
    // Do not keep the original options object: it may retain a large byte array
    // or a loader closure owning a Blob even after release() clears our fields.
    options = undefined;
    let attempted = false, active = false, disposed = false, failed = false;
    let source, buffer, objectURL, timer, observingError = false;
    const notify = (callback, value) => { try { callback?.(value); } catch { /* Owner callbacks cannot change resource ownership. */ } };
    const aborted = () => failure('ABORT_ERR', 'WebM playback was disposed.');
    function check() { if (disposed || controller.signal.aborted) throw aborted(); }
    function wait(target, eventName, begin) {
      return new Promise((resolve, reject) => {
        let timeout;
        const finish = error => {
          target.removeEventListener(eventName, success);
          target.removeEventListener('error', errorEvent);
          controller.signal.removeEventListener('abort', abort);
          root.clearTimeout(timeout);
          error ? reject(error) : resolve();
        };
        const success = () => finish();
        const errorEvent = () => finish(failure('WEBM_DECODE', 'The WebM stream could not be decoded.'));
        const abort = () => finish(aborted());
        target.addEventListener(eventName, success);
        target.addEventListener('error', errorEvent);
        controller.signal.addEventListener('abort', abort, { once: true });
        timeout = root.setTimeout(() => finish(failure('WEBM_TIMEOUT', 'WebM compatibility playback timed out.')), 15000);
        try { check(); begin?.(); } catch (error) { finish(error); }
      });
    }
    function release() {
      root.clearTimeout(timer); timer = undefined;
      if (observingError) video.removeEventListener('error', nativeError);
      observingError = false;
      if (source?.readyState === 'open' && buffer) {
        try { if (buffer.updating) buffer.abort(); } catch { /* Already detached. */ }
        try { source.removeSourceBuffer(buffer); } catch { /* Already detached. */ }
      }
      buffer = undefined; source = undefined;
      if (objectURL) {
        const owned = objectURL; objectURL = undefined;
        if (video.getAttribute('src') === owned) { video.removeAttribute('src'); video.load(); }
        root.URL.revokeObjectURL(owned);
      }
      supplied = undefined; load = undefined;
    }
    function fail(error) {
      if (disposed || failed) return;
      failed = true; active = false;
      controller.abort(); release();
      const known = ownFailures.has(error);
      notify(onError, known ? error : failure(error?.name === 'QuotaExceededError' ? 'WEBM_LIMIT' : 'WEBM_DECODE', error?.name === 'QuotaExceededError' ? 'This WebM exceeds the available playback buffer.' : 'The WebM stream could not be decoded.'));
    }
    function nativeError() { fail(failure('WEBM_DECODE', 'The WebM stream could not be decoded.')); }
    async function start() {
      let bytes;
      try { bytes = bytesOf(supplied || await load(controller.signal)); }
      catch (error) { if (ownFailures.has(error)) throw error; throw failure('WEBM_READ', 'The cached WebM could not be read.'); }
      supplied = undefined; load = undefined;
      check();
      const mime = inspectWebm(bytes);
      if (typeof root.MediaSource !== 'function' || !root.MediaSource.isTypeSupported(mime)) throw failure('WEBM_UNSUPPORTED', 'This VS Code build does not support the WebM codec.');
      source = new root.MediaSource();
      objectURL = root.URL.createObjectURL(source);
      video.addEventListener('error', nativeError); observingError = true;
      await wait(source, 'sourceopen', () => { video.src = objectURL; video.load(); });
      check();
      buffer = source.addSourceBuffer(mime);
      // Bounded appends avoid a single huge append allocation. Browsers still
      // impose a total coded-frame quota; surface that limit instead of evicting
      // the beginning of a looping background or retrying indefinitely.
      for (let offset = 0; offset < bytes.byteLength; offset += CHUNK_BYTES) {
        check();
        await wait(buffer, 'updateend', () => buffer.appendBuffer(bytes.subarray(offset, Math.min(offset + CHUNK_BYTES, bytes.byteLength))));
      }
      check();
      source.endOfStream();
      root.clearTimeout(timer); timer = undefined;
      notify(onReady);
    }
    return {
      retry(error = video.error) {
        if (disposed || failed) return false;
        if (active) return true;
        if (attempted || Number(error?.code) !== 4) return false;
        attempted = true; active = true;
        timer = root.setTimeout(() => fail(failure('WEBM_TIMEOUT', 'WebM compatibility playback timed out.')), 90000);
        // Always defer, including supplied bytes: a listener attached while the
        // original error is dispatching must not mistake it for an MSE failure.
        Promise.resolve().then(start).catch(error => { if (!disposed && !failed) fail(error); });
        return true;
      },
      dispose() {
        if (disposed) return;
        disposed = true; active = false; controller.abort(); release();
      },
      get active() { return active; },
    };
  }
  return Object.freeze({ MAX_BYTES, inspectWebm, createFallback });
});
