import { gzipSync } from "node:zlib";

/**
 * A minimal, deterministic ustar writer, so a release tarball can be built the
 * same way on any machine and two builds of one commit are byte-identical.
 * Entries: `{ path, mode, data }` for a file, `{ path, mode, dir: true }` for a
 * directory. The order is sorted by path, owner and group are 0, the modification
 * time is the one given. Names longer than 100 bytes use the ustar prefix field.
 */
function field(buffer, offset, length, text) {
  const bytes = Buffer.from(text, "utf8");
  if (bytes.length > length) throw new Error(`tar field too long: ${text}`);
  bytes.copy(buffer, offset);
}
const octal = (value, length) => value.toString(8).padStart(length - 1, "0") + "\0";

function header({ path, mode, size, type }, mtime) {
  const block = Buffer.alloc(512);
  let name = path;
  let prefix = "";
  if (Buffer.byteLength(name) > 100) {
    const cut = name.lastIndexOf("/", 155);
    if (cut <= 0 || Buffer.byteLength(name.slice(cut + 1)) > 100) throw new Error(`path too long for tar: ${path}`);
    prefix = name.slice(0, cut);
    name = name.slice(cut + 1);
  }
  field(block, 0, 100, name);
  field(block, 100, 8, octal(mode, 8));
  field(block, 108, 8, octal(0, 8));
  field(block, 116, 8, octal(0, 8));
  field(block, 124, 12, octal(size, 12));
  field(block, 136, 12, octal(mtime, 12));
  block.fill(0x20, 148, 156); // the checksum counts its own field as spaces
  block[156] = type.charCodeAt(0);
  field(block, 257, 6, "ustar\0");
  field(block, 263, 2, "00");
  field(block, 345, 155, prefix);
  const sum = [...block].reduce((total, byte) => total + byte, 0);
  field(block, 148, 8, sum.toString(8).padStart(6, "0") + "\0 ");
  return block;
}

export function packTar(entries, mtime = 0) {
  const parts = [];
  for (const entry of [...entries].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))) {
    if (entry.dir) {
      parts.push(header({ path: entry.path.replace(/\/?$/, "/"), mode: entry.mode, size: 0, type: "5" }, mtime));
      continue;
    }
    const data = Buffer.from(entry.data);
    parts.push(header({ path: entry.path, mode: entry.mode, size: data.length, type: "0" }, mtime), data, Buffer.alloc((512 - (data.length % 512)) % 512));
  }
  parts.push(Buffer.alloc(1024));
  return Buffer.concat(parts);
}

/** The tarball as `.tar.gz`. Node's gzip writes no name and no time, so the bytes depend on the input only. */
export const packTarGz = (entries, mtime = 0) => gzipSync(packTar(entries, mtime), { level: 9 });
