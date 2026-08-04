'use strict';

const { FILETYPE } = require('./codec');

/**
 * Record/instance id minting primitives.
 *
 * See saveService.js's "ID ALLOCATION" comment and TODO.md's Phase 0 /
 * 2.2 investigations for the full evidence trail. The short version repeated
 * here because it is load-bearing for every function below:
 *
 *   - Ids are scoped PER FILE, not global. Each filetype-15 file (quick.save,
 *     every .platoon) carries its own header `nextId`.
 *   - That header field equals max(id) of that file's OWN records exactly,
 *     with zero margin, in all 46 file-instances checked (save1 + autosave1,
 *     quick.save + every .platoon) — NOT max(id)+1 as the field name and
 *     docs/save-format.md §3 suggest. So `nextId` itself is already in use by
 *     an existing record; the first value guaranteed free is `nextId + 1`.
 *   - The game re-mints every id (and reorders every record) on its own next
 *     save, so a minted id only has to stay free within this one file until
 *     that happens — it is not persisted identity, just a placeholder that
 *     must not collide with anything in the same file right now.
 */

/**
 * Hands out the next free id in `file` (a parsed filetype-15 file — the
 * object codec.readFile() returns) and bumps `file.header.nextId` in place
 * so a second call in the same pass does not hand out the same id twice.
 *
 * Only valid for filetype 15. Mod files (16/17) have no `nextId` field in
 * their header at all (see codec.js readHeader) — there is nothing to read
 * or bump, so minting into a mod file is a caller error, not a case to
 * silently handle.
 */
function nextRecordId(file) {
  if (!file || !file.header || file.header.fileType !== FILETYPE.SAVE) {
    throw new Error(
      `nextRecordId: only filetype ${FILETYPE.SAVE} (save/platoon) files carry a nextId counter; ` +
      `got fileType ${file && file.header && file.header.fileType}`,
    );
  }
  const id = file.header.nextId + 1;
  file.header.nextId = id;
  return id;
}

/**
 * Mints the stringID for a freshly-allocated record id.
 *
 * The on-disk shape is "<id>-<originating file>" (docs/save-format.md §1);
 * runtime-created records almost universally carry the literal originating
 * file tag "INGAME" rather than their actual filename, hence the double
 * dash in e.g. "619--INGAME" (id "619" + "-" + "INGAME").
 *
 * DECISION (TODO.md Phase 0 open question — "should an editor-added record
 * reuse -INGAME or carry a distinct provenance tag?"): reuse -INGAME. The
 * game re-mints every id and rewrites every sid on its own next save
 * regardless of what we write here, so a distinct tag would not survive
 * long enough to be useful, and anything the game doesn't recognise as one
 * of its own tags risks being dropped or mishandled. Reusing the tag makes
 * the minted record indistinguishable from a genuine in-game one, which is
 * the safe direction when the alternative is untested.
 */
function mintSid(id) {
  return `${id}--INGAME`;
}

// The nine section Maps every record must have, per codec.js readRecord().
const RECORD_SECTIONS = ['bools', 'floats', 'ints', 'vec3', 'vec4', 'strings', 'filenames', 'extra', 'instances'];

/**
 * Allocates an id for `rec`, stamps `rec.id`/`rec.sid`, and appends it to
 * `file.records`. Returns the record for convenience.
 *
 * The caller supplies a fully-formed record: all nine sections already
 * populated (as Maps, except `instances` which is an array — see
 * codec.readRecord). This function only assigns identity and appends; it
 * does not build record contents (that is item-record-shape knowledge that
 * belongs to whatever calls this, e.g. a future addItem()).
 *
 * Validates the nine-section shape and instanceCount/instances agreement
 * before appending, per AGENTS.md §3 ("instanceCount duplicates the
 * instances section count, keep them consistent") — a malformed record must
 * fail loudly here, not silently produce a corrupt file that only fails the
 * round-trip test (or worse, doesn't).
 */
function addRecord(file, rec) {
  if (!file || !file.header || file.header.fileType !== FILETYPE.SAVE) {
    throw new Error(
      `addRecord: only filetype ${FILETYPE.SAVE} (save/platoon) files support minting; ` +
      `got fileType ${file && file.header && file.header.fileType}`,
    );
  }
  if (!rec || typeof rec !== 'object') throw new Error('addRecord: rec must be an object');
  for (const key of RECORD_SECTIONS) {
    if (key === 'instances') {
      if (!Array.isArray(rec.instances)) throw new Error(`addRecord: rec.instances must be an array`);
    } else if (!(rec[key] instanceof Map)) {
      throw new Error(`addRecord: rec.${key} must be a Map`);
    }
  }
  if (rec.instanceCount !== rec.instances.length) {
    throw new Error(
      `addRecord: instanceCount (${rec.instanceCount}) must equal instances.length (${rec.instances.length})`,
    );
  }

  const id = nextRecordId(file);
  rec.id = id;
  rec.sid = mintSid(id);
  file.records.push(rec);
  // codec.writeFile() patches the record count into the header itself; no
  // need to touch file.header.count here.
  return rec;
}

/**
 * Appends a new instance to a container record's `instances` array (e.g. an
 * INVENTORY (41) or SQUAD (30) record) and bumps `instanceCount` in
 * lockstep, per AGENTS.md §3.
 *
 * CAUTION — `instanceCount` is NOT universally the instance count, so the
 * lockstep bump below is only correct for containers where the file itself
 * already keeps the two equal. Measured over all 3933 records of a live save:
 * they agree on every type 41 (INVENTORY, 282/282) and type 42 (1648/1648) —
 * which is what addItem() touches, so this is safe there — but on type 30
 * (SQUAD) 23 of 25 records carry `instanceCount: 0` alongside 2-19 real
 * instances, and types 28/38/94/108 disagree too. `instanceCount` does not
 * drive parsing either (codec.readRecord reads the instances section's own
 * count separately). Before using this on a SQUAD record — e.g. Phase 1.6's
 * character transfer — check what that record's own convention is rather than
 * assuming this one. See AGENTS.md §3, corrected from its earlier blanket
 * "duplicates the instances section count" claim.
 *
 * Per TODO.md 2.2(c), an instance `id` is NOT a sid — it is a small ordinal
 * string counted within that one container ("1", "2", ...). The next
 * ordinal is derived from the existing instance ids' max numeric value + 1,
 * falling back to `instances.length + 1` if any existing id is non-numeric
 * (so a container with weird/foreign ids doesn't collide with itself), never
 * assuming the existing ids are dense or already in order.
 */
function addInstance(containerRec, target, opts = {}) {
  if (!containerRec || !Array.isArray(containerRec.instances)) {
    throw new Error('addInstance: containerRec.instances must be an array');
  }

  let ordinal;
  const allNumeric = containerRec.instances.every((inst) => /^\d+$/.test(String(inst.id)));
  if (!allNumeric) {
    ordinal = containerRec.instances.length + 1;
  } else {
    const numericIds = containerRec.instances.map((inst) => Number(inst.id));
    ordinal = (numericIds.length ? Math.max(...numericIds) : 0) + 1;
  }

  const inst = {
    id: String(ordinal),
    target,
    pos: opts.pos !== undefined ? opts.pos : [0, 0, 0],
    rot: opts.rot !== undefined ? opts.rot : [1, 0, 0, 0],
    states: opts.states !== undefined ? opts.states : [],
  };
  // Only keep instanceCount in lockstep if this record already kept it that
  // way (see the CAUTION above — a SQUAD record deliberately carries 0 against
  // 19 instances, and "correcting" it would be us inventing a value the game
  // never wrote). `agreed` must be sampled BEFORE the push.
  const agreed = containerRec.instanceCount === containerRec.instances.length;
  containerRec.instances.push(inst);
  if (agreed) containerRec.instanceCount = containerRec.instances.length;
  return inst;
}

module.exports = { nextRecordId, mintSid, addRecord, addInstance };
