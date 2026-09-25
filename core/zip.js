/* Annotate Tool - core/zip.js
 *
 * A minimal ZIP writer. No compression - every entry is stored with method 0.
 *
 * WHY hand-rolled instead of bundling JSZip: MV3 forbids loading remote code,
 * so a library would have to ship inside the extension as a vendored blob we
 * cannot easily audit or update. The only thing we actually need is "put these
 * bytes in a container", and the bulk of what we store is PNG - already
 * DEFLATE-compressed internally, so re-compressing it would burn CPU to save
 * roughly nothing. Text reports are a few KB. Store-only is the right trade.
 *
 * FORMAT NOTES
 *  - General purpose flag bit 11 (0x0800) is set on every entry to declare the
 *    filename as UTF-8. Without it, unzip tools guess CP437 and mangle any
 *    non-ASCII page title that made it into a filename.
 *  - Zip64 is NOT implemented. Entries and archives above 4GB will produce a
 *    corrupt file; see MAX_TOTAL below for the guard that stops us silently
 *    writing one.
 *  - Directory entries are not emitted. Every mainstream extractor creates
 *    intermediate folders from the entry paths, and omitting them keeps the
 *    central directory smaller.
 */
(function () {
  'use strict';
  const root = typeof window !== 'undefined' ? window : self;
  const AT = (root.AT = root.AT || {});

  const LOCAL_SIG = 0x04034b50;
  const CENTRAL_SIG = 0x02014b50;
  const EOCD_SIG = 0x06054b50;
  const UTF8_FLAG = 0x0800;
  const VERSION = 20; // 2.0 - the minimum that understands what we emit

  // 4GB minus headroom. Beyond this the 32-bit size fields wrap and the
  // archive is silently corrupt, so we throw instead.
  const MAX_TOTAL = 0xffffffff - 1024 * 1024;

  /* --- CRC32 ---------------------------------------------------------- */

  let CRC_TABLE = null;
  function crcTable() {
    if (CRC_TABLE) return CRC_TABLE;
    const table = new Uint32Array(256);
    for (let i = 0; i < 256; i++) {
      let c = i;
      for (let k = 0; k < 8; k++) {
        c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      }
      table[i] = c >>> 0;
    }
    CRC_TABLE = table;
    return table;
  }

  function crc32(bytes) {
    const table = crcTable();
    let c = 0xffffffff;
    for (let i = 0; i < bytes.length; i++) {
      c = table[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
    }
    return (c ^ 0xffffffff) >>> 0;
  }

  /* --- byte helpers ---------------------------------------------------- */

  function textBytes(str) {
    return new TextEncoder().encode(str);
  }

  /* Decodes a `data:...;base64,....` URL - which is how captureVisibleTab
   * hands us a PNG - into raw bytes. */
  function dataUrlToBytes(dataUrl) {
    const comma = dataUrl.indexOf(',');
    if (comma < 0) throw new Error('zip: malformed data URL');
    const meta = dataUrl.slice(0, comma);
    const body = dataUrl.slice(comma + 1);
    if (meta.indexOf(';base64') < 0) {
      return textBytes(decodeURIComponent(body));
    }
    const bin = atob(body);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }

  /* MS-DOS packed date/time. Seconds have 2-second resolution by design of
   * the format - not a rounding bug. */
  function dosDateTime(date) {
    const d = date || new Date();
    const year = Math.max(1980, d.getFullYear());
    return {
      time:
        ((d.getHours() & 0x1f) << 11) |
        ((d.getMinutes() & 0x3f) << 5) |
        ((d.getSeconds() / 2) & 0x1f),
      date:
        (((year - 1980) & 0x7f) << 9) |
        (((d.getMonth() + 1) & 0x0f) << 5) |
        (d.getDate() & 0x1f)
    };
  }

  function writer(size) {
    const buf = new Uint8Array(size);
    let pos = 0;
    return {
      u16(v) {
        buf[pos++] = v & 0xff;
        buf[pos++] = (v >>> 8) & 0xff;
      },
      u32(v) {
        buf[pos++] = v & 0xff;
        buf[pos++] = (v >>> 8) & 0xff;
        buf[pos++] = (v >>> 16) & 0xff;
        buf[pos++] = (v >>> 24) & 0xff;
      },
      bytes(b) {
        buf.set(b, pos);
        pos += b.length;
      },
      get offset() {
        return pos;
      },
      done() {
        return buf;
      }
    };
  }

  /* --- public API ------------------------------------------------------ */

  AT.zip = {
    crc32,
    textBytes,
    dataUrlToBytes,

    /* files: [{ name: 'dir/file.png', data: Uint8Array | string, date?: Date }]
     * returns: Blob (application/zip) */
    create(files) {
      const entries = files.map((f) => {
        const data = typeof f.data === 'string' ? textBytes(f.data) : f.data;
        const nameBytes = textBytes(f.name);
        return {
          nameBytes,
          data,
          crc: crc32(data),
          dt: dosDateTime(f.date),
          offset: 0
        };
      });

      let total = 0;
      for (const e of entries) {
        total += 30 + e.nameBytes.length + e.data.length; // local header + data
        total += 46 + e.nameBytes.length; // central directory header
      }
      total += 22; // EOCD

      if (total > MAX_TOTAL) {
        throw new Error(
          'zip: archive would exceed 4GB, which this writer cannot represent'
        );
      }

      const w = writer(total);

      // Local file headers + data
      for (const e of entries) {
        e.offset = w.offset;
        w.u32(LOCAL_SIG);
        w.u16(VERSION);
        w.u16(UTF8_FLAG);
        w.u16(0); // method: store
        w.u16(e.dt.time);
        w.u16(e.dt.date);
        w.u32(e.crc);
        w.u32(e.data.length); // compressed size == uncompressed size
        w.u32(e.data.length);
        w.u16(e.nameBytes.length);
        w.u16(0); // extra field length
        w.bytes(e.nameBytes);
        w.bytes(e.data);
      }

      // Central directory
      const cdStart = w.offset;
      for (const e of entries) {
        w.u32(CENTRAL_SIG);
        w.u16(VERSION); // version made by
        w.u16(VERSION); // version needed
        w.u16(UTF8_FLAG);
        w.u16(0);
        w.u16(e.dt.time);
        w.u16(e.dt.date);
        w.u32(e.crc);
        w.u32(e.data.length);
        w.u32(e.data.length);
        w.u16(e.nameBytes.length);
        w.u16(0); // extra
        w.u16(0); // comment
        w.u16(0); // disk number start
        w.u16(0); // internal attributes
        w.u32(0); // external attributes
        w.u32(e.offset);
        w.bytes(e.nameBytes);
      }
      const cdSize = w.offset - cdStart;

      // End of central directory
      w.u32(EOCD_SIG);
      w.u16(0); // this disk
      w.u16(0); // disk with central directory
      w.u16(entries.length);
      w.u16(entries.length);
      w.u32(cdSize);
      w.u32(cdStart);
      w.u16(0); // comment length

      return new Blob([w.done()], { type: 'application/zip' });
    }
  };
})();
