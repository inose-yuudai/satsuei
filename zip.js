// 小さな ZIP 作り（圧縮しない「格納」方式）。写真も動画もすでに圧縮されているので、縮めずにまとめるだけでよい。
// すべて端末の中で作り、どこにも送らない。ファイル名は UTF-8（日本語の名前でも Mac・Windows で読める）。

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function dosTime(d) {
  const time = (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2);
  const date = (Math.max(0, d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
  return { time, date };
}

// entries: [{ name: "フォルダ/ファイル名", blob: Blob }]。onProgress(済んだ数, 全部の数)
export async function makeZip(entries, onProgress) {
  const enc = new TextEncoder();
  const parts = [];
  const central = [];
  const { time, date } = dosTime(new Date());
  let offset = 0;
  for (let i = 0; i < entries.length; i++) {
    const { name, blob } = entries[i];
    const nameB = enc.encode(name);
    const size = blob.size;
    const crc = crc32(new Uint8Array(await blob.arrayBuffer()));
    const h = new DataView(new ArrayBuffer(30));
    h.setUint32(0, 0x04034b50, true);
    h.setUint16(4, 20, true);
    h.setUint16(6, 0x0800, true); // ファイル名は UTF-8
    h.setUint16(8, 0, true);      // 格納（圧縮なし）
    h.setUint16(10, time, true);
    h.setUint16(12, date, true);
    h.setUint32(14, crc, true);
    h.setUint32(18, size, true);
    h.setUint32(22, size, true);
    h.setUint16(26, nameB.length, true);
    h.setUint16(28, 0, true);
    parts.push(h.buffer, nameB, blob);

    const c = new DataView(new ArrayBuffer(46));
    c.setUint32(0, 0x02014b50, true);
    c.setUint16(4, 20, true);
    c.setUint16(6, 20, true);
    c.setUint16(8, 0x0800, true);
    c.setUint16(10, 0, true);
    c.setUint16(12, time, true);
    c.setUint16(14, date, true);
    c.setUint32(16, crc, true);
    c.setUint32(20, size, true);
    c.setUint32(24, size, true);
    c.setUint16(28, nameB.length, true);
    c.setUint32(42, offset, true);
    central.push(c.buffer, nameB);

    offset += 30 + nameB.length + size;
    if (offset > 0xffffffff) throw new Error("ZIP が大きすぎます（4GB まで）");
    if (onProgress) onProgress(i + 1, entries.length);
  }
  const cdSize = central.reduce((a, b) => a + b.byteLength, 0);
  const e = new DataView(new ArrayBuffer(22));
  e.setUint32(0, 0x06054b50, true);
  e.setUint16(8, entries.length, true);
  e.setUint16(10, entries.length, true);
  e.setUint32(12, cdSize, true);
  e.setUint32(16, offset, true);
  return new Blob([...parts, ...central, e.buffer], { type: "application/zip" });
}
