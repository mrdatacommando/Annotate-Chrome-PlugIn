/* Annotate Tool - core/unzip.js
 *
 * Reads a ZIP produced by core/zip.js, or by anything else the bundle passed
 * through on its way here.
 *
 * WHY this is not just zip.js in reverse: our own writer only ever emits STORE
 * entries, but a bundle that has been round-tripped - emailed, re-zipped by
 * Windows Explorer, pushed through Drive or Slack - comes back DEFLATE. A
 * reader that only understood STORE would fail on exactly the bundles most
 * likely to arrive from a colleague, which is the whole point of review mode.
 *
 * DEFLATE is handled by the browser's own DecompressionStream('deflate-raw'),
 * so there is still no third-party code in the extension. Chrome has had it
 * since 103; if it is somehow missing we fail with a clear message rather than
 * silently returning empty files.
 *
 * PARSING STRATEGY: read the central directory, not the local headers. Local
 * headers are allowed to carry zeroed sizes with the real values in a trailing
 * data descriptor (streamed writers do this), whereas the central directory
 * always has the true compressed and uncompressed sizes. The local header is
 * still read, but only to find where the data actually begins - its name and
 * extra-field lengths can legitimately differ from the central copy.
 *
 * Zip64 is NOT supported, matching the writer.
 */
(function () {
  'use strict';
  const root = typeof window !== 'undefined' ? window : self;
  const AT = (root.AT = root.AT || {});

  const LOCAL_SIG = 0x04034b50;
  const CENTRAL_SIG = 0x02014b50;
  const EOCD_SIG = 0x06054b50;
  const ZIP64_EOCD_LOCATOR_SIG = 0x07064b50;

  const METHOD_STORE = 0;
  const METHOD_DEFLATE = 8;

  function reader(bytes) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    return {
      u16: (at) => view.getUint16(at, true),
      u32: (at) => view.getUint32(at, true)
    };
  }

  /* The end-of-central-directory record sits at the very end of the file,
   * unless a ZIP comment follows it - so scan backwards for the signature.
   * The comment is length-capped at 65535, hence the bounded search. */
  function findEOCD(bytes) {
    const r = reader(bytes);
    const min = Math.max(0, bytes.length - (0xffff + 22));
    for (let at = bytes.length - 22; at >= min; at--) {
      if (r.u32(at) === EOCD_SIG) return at;
    }
    return -1;
  }

  function decodeName(bytes, utf8Flag) {
    // Bit 11 of the general purpose flags declares UTF-8. Without it the spec
    // says CP437, but in practice modern writers emit UTF-8 regardless, and
    // our own filenames are ASCII either way - so UTF-8 is the safer guess.
    try {
      return new TextDecoder(utf8Flag ? 'utf-8' : 'utf-8').decode(bytes);
    } catch (_) {
      return String.fromCharCode.apply(null, bytes);
    }
  }

  async function inflateRaw(bytes) {
    if (typeof DecompressionStream === 'undefined') {
      throw new Error(
        'this browser cannot read compressed ZIP entries (DecompressionStream missing)'
      );
    }
    const stream = new Blob([bytes]).stream().pipeThrough(
      new DecompressionStream('deflate-raw')
    );
    const buf = await new Response(stream).arrayBuffer();
    return new Uint8Array(buf);
  }

  AT.unzip = {
    METHOD_STORE,
    METHOD_DEFLATE,

    /* bytes: Uint8Array of the whole archive
     * returns: Map of path -> { name, bytes, method, crc, size }
     *
     * Directory entries are skipped; every mainstream extractor recreates
     * folders from the file paths anyway. */
    async read(bytes) {
      if (!bytes || bytes.length < 22) {
        throw new Error('not a ZIP file (too small)');
      }
      const r = reader(bytes);

      const eocd = findEOCD(bytes);
      if (eocd < 0) {
        throw new Error('not a ZIP file (no end-of-central-directory record)');
      }

      // A Zip64 locator immediately before the EOCD means sizes may not fit in
      // the 32-bit fields. Say so plainly rather than reading garbage.
      if (eocd >= 20 && r.u32(eocd - 20) === ZIP64_EOCD_LOCATOR_SIG) {
        throw new Error('Zip64 archives are not supported');
      }

      const count = r.u16(eocd + 10);
      let at = r.u32(eocd + 16); // offset of first central directory header

      const files = new Map();

      for (let i = 0; i < count; i++) {
        if (at + 46 > bytes.length || r.u32(at) !== CENTRAL_SIG) {
          throw new Error('corrupt ZIP: bad central directory entry ' + (i + 1));
        }

        const flags = r.u16(at + 8);
        const method = r.u16(at + 10);
        const crc = r.u32(at + 16);
        const compSize = r.u32(at + 20);
        const rawSize = r.u32(at + 24);
        const nameLen = r.u16(at + 28);
        const extraLen = r.u16(at + 30);
        const commentLen = r.u16(at + 32);
        const localAt = r.u32(at + 42);

        /* Separators are normalised to "/". The spec requires forward slashes,
         * but Windows PowerShell's Compress-Archive emits BACKSLASHES - and a
         * bundle re-zipped by a colleague on Windows is a completely ordinary
         * way for one to reach us. Without this, every path lookup misses. */
        const name = decodeName(bytes.subarray(at + 46, at + 46 + nameLen), flags & 0x0800)
          .replace(/\\/g, '/');
        at += 46 + nameLen + extraLen + commentLen;

        if (name.endsWith('/')) continue; // directory entry

        if (localAt + 30 > bytes.length || r.u32(localAt) !== LOCAL_SIG) {
          throw new Error('corrupt ZIP: bad local header for "' + name + '"');
        }
        // The local header's own name/extra lengths are authoritative for
        // finding the data, and may differ from the central directory's.
        const dataAt = localAt + 30 + r.u16(localAt + 26) + r.u16(localAt + 28);
        if (dataAt + compSize > bytes.length) {
          throw new Error('corrupt ZIP: "' + name + '" runs past the end of the file');
        }

        const raw = bytes.subarray(dataAt, dataAt + compSize);

        let content;
        if (method === METHOD_STORE) {
          content = raw;
        } else if (method === METHOD_DEFLATE) {
          content = await inflateRaw(raw);
        } else {
          throw new Error(
            'unsupported compression method ' + method + ' in "' + name + '"'
          );
        }

        files.set(name, {
          name,
          bytes: content,
          method,
          crc,
          size: rawSize
        });
      }

      return files;
    },

    /* Verifies an entry against the CRC32 recorded in the archive. Not run on
     * every read - it doubles the cost on large screenshots - but the review
     * page uses it on report.json, where silent corruption would be worst. */
    verify(entry) {
      if (!AT.zip || !AT.zip.crc32) return true; // writer not loaded; skip
      return AT.zip.crc32(entry.bytes) === entry.crc;
    },

    text(entry) {
      return new TextDecoder('utf-8').decode(entry.bytes);
    },

    /* Turns an entry into a data URL for <img src>. Blob URLs would be leaner,
     * but they must be revoked by hand and the review page keeps every
     * screenshot alive for as long as the bundle is open - a data URL has the
     * same lifetime as the object holding it, with nothing to leak. */
    dataUrl(entry, mime) {
      let binary = '';
      const chunk = 0x8000; // avoid blowing the argument limit on big images
      for (let i = 0; i < entry.bytes.length; i += chunk) {
        binary += String.fromCharCode.apply(
          null,
          entry.bytes.subarray(i, i + chunk)
        );
      }
      return 'data:' + (mime || 'image/png') + ';base64,' + btoa(binary);
    }
  };
})();
