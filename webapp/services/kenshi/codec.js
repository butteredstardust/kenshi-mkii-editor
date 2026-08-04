'use strict';

const { Reader, Writer } = require('./binary');

/**
 * Kenshi record container codec — reads and writes `.save`, `.platoon`,
 * `.mod` and `gamedata.base`.
 *
 * See ../../../docs/save-format.md for how this layout was derived and for the
 * evidence behind each field. The short version:
 *
 *   header
 *   record × recordCount
 *   tail                      (filetype 15 only; opaque stream of longs)
 *
 * A record is:
 *   L instanceCount   (duplicates the length of the instances section)
 *   L typecode
 *   L id
 *   S name
 *   S stringId        ("<id>-<originating file>")
 *   L modDataType
 *   then nine count-prefixed sections, in this exact order:
 *     bools, floats, ints, vec3, vec4, strings, filenames, extraData, instances
 *
 * Ordering matters on write: Kenshi does not sort keys, and a byte-identical
 * round trip is the only cheap proof the codec understands a file. Sections are
 * therefore Maps (insertion-ordered), never plain objects.
 */

const FILETYPE = { SAVE: 15, MOD: 16, MOD_V2: 17 };

/**
 * Per-record NaN bit tables (see Reader.F()). Kept in a WeakMap rather than on
 * the record so it stays invisible to everything that reads, diffs or clones a
 * record — a caller must not have to know this exists to round-trip a file, and
 * a record that never had NaNs never gets an entry.
 */
const NAN_BITS = new WeakMap();

function readRecord(r) {
  r.nan = new Map();
  r.fOrd = 0;
  const rec = {
    instanceCount: r.L(),
    type: r.L(),
    id: r.L(),
    name: r.S(),
    sid: r.S(),
    modDataType: r.L(),
    bools: new Map(),
    floats: new Map(),
    ints: new Map(),
    vec3: new Map(),
    vec4: new Map(),
    strings: new Map(),
    filenames: new Map(),
    extra: new Map(),
    instances: [],
  };

  for (let n = r.L(); n > 0; n--) rec.bools.set(r.S(), r.B());
  for (let n = r.L(); n > 0; n--) rec.floats.set(r.S(), r.F());
  for (let n = r.L(); n > 0; n--) rec.ints.set(r.S(), r.L());
  for (let n = r.L(); n > 0; n--) rec.vec3.set(r.S(), r.V(3));
  for (let n = r.L(); n > 0; n--) rec.vec4.set(r.S(), r.V(4));
  for (let n = r.L(); n > 0; n--) rec.strings.set(r.S(), r.S());
  for (let n = r.L(); n > 0; n--) rec.filenames.set(r.S(), r.S());

  for (let n = r.L(); n > 0; n--) {
    const category = r.S();
    const rows = [];
    for (let m = r.L(); m > 0; m--) rows.push({ target: r.S(), v0: r.L(), v1: r.L(), v2: r.L() });
    rec.extra.set(category, rows);
  }

  for (let n = r.L(); n > 0; n--) {
    const inst = { id: r.S(), target: r.S(), pos: r.V(3), rot: r.V(4), states: [] };
    for (let m = r.L(); m > 0; m--) inst.states.push(r.S());
    rec.instances.push(inst);
  }

  if (r.nan.size) NAN_BITS.set(rec, r.nan);
  r.nan = null;
  return rec;
}

function writeRecord(w, rec) {
  w.nan = NAN_BITS.get(rec) || null;
  w.fOrd = 0;
  w.L(rec.instanceCount);
  w.L(rec.type);
  w.L(rec.id);
  w.S(rec.name);
  w.S(rec.sid);
  w.L(rec.modDataType);

  const emit = (map, fn) => { w.L(map.size); for (const [k, v] of map) { w.S(k); fn(v); } };
  emit(rec.bools, (v) => w.B(v));
  emit(rec.floats, (v) => w.F(v));
  emit(rec.ints, (v) => w.L(v));
  emit(rec.vec3, (v) => w.V(v));
  emit(rec.vec4, (v) => w.V(v));
  emit(rec.strings, (v) => w.S(v));
  emit(rec.filenames, (v) => w.S(v));

  w.L(rec.extra.size);
  for (const [category, rows] of rec.extra) {
    w.S(category);
    w.L(rows.length);
    for (const row of rows) { w.S(row.target); w.L(row.v0); w.L(row.v1); w.L(row.v2); }
  }


  w.L(rec.instances.length);
  for (const inst of rec.instances) {
    w.S(inst.id);
    w.S(inst.target);
    w.V(inst.pos);
    w.V(inst.rot);
    w.L(inst.states.length);
    for (const s of inst.states) w.S(s);
  }
  w.nan = null;
}

/**
 * Mod headers (filetype 16/17) end in a variable-length blob whose layout is
 * not fully understood — its size differs per file (0 bytes in Azuchi.mod,
 * 9 in Dialogue.mod, 10 in rebirth.mod). Rather than guess, probe forward for
 * the offset where a plausible record count is followed by records that
 * actually parse, then preserve every byte before it verbatim on write.
 */
function locateRecordCount(buf, from) {
  for (let k = 0; k < 40; k++) {
    const probe = new Reader(buf, from + k);
    let unknown, count;
    try { unknown = probe.L(); count = probe.L(); } catch { continue; }
    if (!(count > 0 && count < 500000)) continue;
    const at = probe.o;
    try {
      for (let i = 0; i < Math.min(3, count); i++) readRecord(probe);
    } catch { continue; }
    return { skew: k, unknown, count, recordsAt: at };
  }
  throw new Error('could not locate the record count in this mod header');
}

function readHeader(buf) {
  const r = new Reader(buf);
  const fileType = r.L();

  if (fileType === FILETYPE.SAVE) {
    const nextId = r.L();
    const count = r.L();
    // nextIdAt: byte offset of the nextId field itself (4, right after the
    // 4-byte filetype at offset 0). Only filetype-15 files (quick.save and
    // every .platoon) have this field — mod files (16/17) have no id counter
    // at all, so writeFile() must guard on this offset being defined, not on
    // fileType, to patch the two in lockstep. See ids.js for why this field
    // needs patching on write (minting a new record bumps it).
    return { fileType, nextId, count, recordsAt: r.o, countAt: 8, nextIdAt: 4 };
  }

  if (fileType === FILETYPE.MOD || fileType === FILETYPE.MOD_V2) {
    const header = { fileType };
    if (fileType === FILETYPE.MOD_V2) header.headerExtra = r.L();
    header.modVersion = r.L();
    header.author = r.S();
    header.description = r.S();
    header.dependencies = r.S();
    header.references = r.S();
    const found = locateRecordCount(buf, r.o);
    header.unknown = found.unknown;
    header.headerSkew = found.skew;
    header.count = found.count;
    header.recordsAt = found.recordsAt;
    header.countAt = found.recordsAt - 4;
    return header;
  }

  throw new Error(`unsupported Kenshi filetype ${fileType}`);
}

/**
 * Parse a whole file. `headerRaw` and `tail` are kept as raw slices so that
 * writeFile() can reproduce the original bytes exactly even where the format
 * is not fully understood.
 */
function readFile(buf) {
  const header = readHeader(buf);
  const r = new Reader(buf, header.recordsAt);
  const records = new Array(header.count);
  for (let i = 0; i < header.count; i++) records[i] = readRecord(r);
  return {
    header,
    headerRaw: buf.subarray(0, header.recordsAt),
    records,
    tail: buf.subarray(r.o),
    parsedTo: r.o,
    size: buf.length,
  };
}

function writeFile(file) {
  const w = new Writer(Math.max(1 << 16, file.size || 0));
  w.bytes(file.headerRaw);
  // Record count lives inside headerRaw; patch it in case records were added
  // or removed since the read.
  w.buf.writeInt32LE(file.records.length, file.header.countAt);
  // nextId also lives inside headerRaw (filetype 15 only — mod files have no
  // such field, hence the guard on the offset being defined rather than on
  // fileType). Patched back unchanged unless ids.js's nextRecordId() bumped
  // header.nextId in memory; writing it back with its original value keeps
  // every existing round-trip test byte-identical.
  if (file.header.nextIdAt !== undefined) {
    w.buf.writeInt32LE(file.header.nextId, file.header.nextIdAt);
  }
  for (const rec of file.records) writeRecord(w, rec);
  w.bytes(file.tail);
  return w.done();
}

module.exports = { FILETYPE, readFile, writeFile, readRecord, writeRecord, readHeader };
