'use strict';

/**
 * Little-endian primitive readers/writers for Kenshi's binary container.
 *
 * Every value in a Kenshi data file is one of:
 *   L  4-byte signed int
 *   F  4-byte IEEE-754 float
 *   ?  1-byte boolean
 *   S  4-byte length prefix + that many bytes (no terminator)
 *
 * Strings are length-prefixed in BYTES, not characters, and they are NOT
 * guaranteed to be valid UTF-8 — save files store the odd binary blob in a
 * string field (there is a 0x80 byte in quick.save). Decoding those as UTF-8
 * substitutes U+FFFD and permanently corrupts the file on write. So every
 * string is carried as latin1, which is a lossless byte<->char mapping, and
 * only decoded to UTF-8 at the display boundary via `asText()`.
 */

const ENC = 'latin1';

/** Best-effort UTF-8 view of a latin1-carried string, for display only. */
function asText(s) {
  const buf = Buffer.from(s, ENC);
  const decoded = buf.toString('utf8');
  return Buffer.compare(Buffer.from(decoded, 'utf8'), buf) === 0 ? decoded : s;
}

/**
 * The exact inverse of `asText()`: takes UTF-8 display text (a name typed into
 * the editor, arriving through JSON) and returns the latin1-carried string the
 * codec writes byte-for-byte.
 *
 * This is the ONLY correct way to put user text into a record. Assigning the
 * raw JS string instead writes `Buffer.from(s, 'latin1')`, which silently
 * truncates every code point above U+00FF to its low byte — "Ō" (U+014C) would
 * land on disk as 0x4C, the letter "L". Round-tripping through UTF-8 bytes
 * instead means `asText(fromText(x)) === x` for any string, which is what the
 * game itself does with names typed in its own UI (the display strings in a
 * live save decode cleanly as UTF-8).
 *
 * `byteLength()` is the companion check: string fields are length-prefixed in
 * BYTES, so a caller enforcing a maximum name length must measure the encoded
 * form, not `String.length`.
 */
function fromText(text) {
  return Buffer.from(String(text ?? ''), 'utf8').toString(ENC);
}

/** Byte length of `text` once encoded by fromText(). */
function byteLength(text) {
  return Buffer.byteLength(String(text ?? ''), 'utf8');
}

class Reader {
  constructor(buf, offset = 0) {
    this.buf = buf;
    this.o = offset;
    // NaN bit preservation — see F(). `nan` is a Map(floatOrdinal -> raw u32)
    // installed per record by the codec; null means "don't bother tracking".
    this.nan = null;
    this.fOrd = 0;
  }

  get remaining() { return this.buf.length - this.o; }

  L() {
    if (this.o + 4 > this.buf.length) throw new RangeError(`L past EOF at ${this.o}`);
    const v = this.buf.readInt32LE(this.o);
    this.o += 4;
    return v;
  }

  /**
   * Read a float, remembering the exact bits of any NaN.
   *
   * Kenshi writes NaN floats into saves — 225 to 333 of them per quick.save,
   * nearly all in a type-108 spatial cache's instance positions. Most are QUIET
   * NaNs and survive a round trip untouched, because a float32 -> double ->
   * float32 trip through a JS number preserves the sign and the payload. What
   * it does NOT preserve is the "is this NaN signalling" bit: the hardware sets
   * the quiet bit on the widening conversion, so a signalling NaN comes back
   * out as `0x...ff` where the file had `0x...bf`. One bit, one byte, and the
   * byte-identical round trip that is this codec's entire safety argument
   * fails.
   *
   * So each NaN's raw bits are stored against the ORDINAL of the float within
   * its record (`fOrd`), and Writer.F() puts them back. Keying by ordinal
   * rather than by "the Nth NaN" means editing one float away from NaN cannot
   * shift the others. A record that isn't in the table — a freshly minted or
   * cloned one — just writes a canonical NaN, which is correct: nothing
   * requires new records to reproduce bits they never had.
   */
  F() {
    if (this.o + 4 > this.buf.length) throw new RangeError(`F past EOF at ${this.o}`);
    const v = this.buf.readFloatLE(this.o);
    if (this.nan && Number.isNaN(v)) this.nan.set(this.fOrd, this.buf.readUInt32LE(this.o));
    this.fOrd++;
    this.o += 4;
    return v;
  }

  B() {
    if (this.o + 1 > this.buf.length) throw new RangeError(`B past EOF at ${this.o}`);
    return this.buf[this.o++] !== 0;
  }

  S() {
    const at = this.o;
    const n = this.L();
    // A bogus length is the usual symptom of a mis-aligned parse; fail loudly
    // rather than allocating gigabytes.
    if (n < 0 || this.o + n > this.buf.length) throw new RangeError(`bad string length ${n} at ${at}`);
    const s = this.buf.toString(ENC, this.o, this.o + n);
    this.o += n;
    return s;
  }

  V(k) {
    const out = new Array(k);
    for (let i = 0; i < k; i++) out[i] = this.F();
    return out;
  }

  bytes(n) {
    if (this.o + n > this.buf.length) throw new RangeError(`bytes(${n}) past EOF at ${this.o}`);
    const b = this.buf.subarray(this.o, this.o + n);
    this.o += n;
    return b;
  }
}

class Writer {
  constructor(initial = 1 << 16) {
    this.buf = Buffer.allocUnsafe(initial);
    this.o = 0;
    // The read side's NaN table for the record currently being written, and
    // the ordinal counter that indexes it. See Reader.F().
    this.nan = null;
    this.fOrd = 0;
  }

  _need(n) {
    if (this.o + n <= this.buf.length) return;
    let size = this.buf.length * 2;
    while (size < this.o + n) size *= 2;
    const next = Buffer.allocUnsafe(size);
    this.buf.copy(next, 0, 0, this.o);
    this.buf = next;
  }

  L(v) { this._need(4); this.buf.writeInt32LE(v | 0, this.o); this.o += 4; }
  /** Write a float, restoring a NaN's original bits when we have them (Reader.F). */
  F(v) {
    this._need(4);
    const raw = this.nan && Number.isNaN(v) ? this.nan.get(this.fOrd) : undefined;
    if (raw === undefined) this.buf.writeFloatLE(v, this.o);
    else this.buf.writeUInt32LE(raw, this.o);
    this.fOrd++;
    this.o += 4;
  }
  B(v) { this._need(1); this.buf[this.o++] = v ? 1 : 0; }

  S(v) {
    const b = Buffer.from(String(v ?? ''), ENC);
    this.L(b.length);
    this._need(b.length);
    b.copy(this.buf, this.o);
    this.o += b.length;
  }

  V(arr) { for (const f of arr) this.F(f); }

  bytes(b) { this._need(b.length); b.copy(this.buf, this.o); this.o += b.length; }

  done() { return this.buf.subarray(0, this.o); }
}

module.exports = { Reader, Writer, asText, fromText, byteLength, ENC };
