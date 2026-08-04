let csrf = null;

async function session() {
  if (csrf) return csrf;
  const r = await fetch('/api/session');
  csrf = (await r.json()).csrfToken;
  return csrf;
}

async function request(method, url, body) {
  const headers = { 'Content-Type': 'application/json' };
  if (method !== 'GET') headers['x-csrf-token'] = await session();
  const res = await fetch(url, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const data = await res.json().catch(() => ({ error: `${res.status} ${res.statusText}` }));
  if (!res.ok) throw Object.assign(new Error(data.error || 'request failed'), { data });
  return data;
}

export const API = {
  status: () => request('GET', '/api/status'),
  saveStatus: (name) => request('GET', `/api/saves/${encodeURIComponent(name)}/status`),
  setMoney: (name, amount) => request('PUT', `/api/saves/${encodeURIComponent(name)}/money`, { amount }),
  setStats: (name, file, sid, stats) => request('PUT',
    `/api/saves/${encodeURIComponent(name)}/platoons/${encodeURIComponent(file)}/characters/${encodeURIComponent(sid)}/stats`,
    { stats }),
  archetypes: () => request('GET', '/api/archetypes'),
  // Rename one character (CHAR_STATE strings.name + the STATS record header name).
  renameCharacter: (name, file, sid, newName) => request('PUT',
    `/api/saves/${encodeURIComponent(name)}/platoons/${encodeURIComponent(file)}/characters/${encodeURIComponent(sid)}/name`,
    { name: newName }),
  // Rename the squad — really the player faction, the only squad-level name a
  // Kenshi save stores. Platoon filenames are intentionally left as they are.
  renameFaction: (name, newName) => request('PUT',
    `/api/saves/${encodeURIComponent(name)}/faction/name`, { name: newName }),
  // Races this save can supply a donor for, plus the one to preselect. A new
  // member is cloned from an existing character of the chosen race, so the list
  // is what the save contains, not every race in the game's data.
  races: (name) => request('GET', `/api/saves/${encodeURIComponent(name)}/races`),
  // Editorial "roll a recruit" catalogue (services/recruits.js), in the spirit
  // of the wiki's Unique Recruits page.
  recruits: () => request('GET', '/api/recruits'),
  addSquadMember: (name, file, body) => request('POST',
    `/api/saves/${encodeURIComponent(name)}/platoons/${encodeURIComponent(file)}/characters`, body),
  trainCharacter: (name, file, sid, body) => request('POST',
    `/api/saves/${encodeURIComponent(name)}/platoons/${encodeURIComponent(file)}/characters/${encodeURIComponent(sid)}/train`,
    body),
  healPart: (name, file, sid, n, body) => request('PUT',
    `/api/saves/${encodeURIComponent(name)}/platoons/${encodeURIComponent(file)}/characters/${encodeURIComponent(sid)}/medical/parts/${encodeURIComponent(n)}`,
    body),
  damagePart: (name, file, sid, n, body) => request('PUT',
    `/api/saves/${encodeURIComponent(name)}/platoons/${encodeURIComponent(file)}/characters/${encodeURIComponent(sid)}/medical/parts/${encodeURIComponent(n)}/damage`,
    body),
  setHunger: (name, file, sid, body) => request('PUT',
    `/api/saves/${encodeURIComponent(name)}/platoons/${encodeURIComponent(file)}/characters/${encodeURIComponent(sid)}/medical/hunger`,
    body),
  revive: (name, file, sid, body) => request('POST',
    `/api/saves/${encodeURIComponent(name)}/platoons/${encodeURIComponent(file)}/characters/${encodeURIComponent(sid)}/revive`,
    body),
  restoreLimbs: (name, file, sid) => request('POST',
    `/api/saves/${encodeURIComponent(name)}/platoons/${encodeURIComponent(file)}/characters/${encodeURIComponent(sid)}/medical/restore-limbs`),
  setItemSection: (name, file, sid, itemSid, section) => request('PUT',
    `/api/saves/${encodeURIComponent(name)}/platoons/${encodeURIComponent(file)}/characters/${encodeURIComponent(sid)}/inventory/${encodeURIComponent(itemSid)}/section`,
    { section }),
  setItemQuality: (name, file, sid, itemSid, body) => request('PUT',
    `/api/saves/${encodeURIComponent(name)}/platoons/${encodeURIComponent(file)}/characters/${encodeURIComponent(sid)}/inventory/${encodeURIComponent(itemSid)}/quality`,
    body),
  // Unified per-item edit: slot, level, quality, quantity and/or weapon grade
  // in ONE staged write. This is what the Gear row's single "Apply" sends;
  // setItemSection/setItemQuality above are the narrower legacy routes.
  updateItem: (name, file, sid, itemSid, body) => request('PUT',
    `/api/saves/${encodeURIComponent(name)}/platoons/${encodeURIComponent(file)}/characters/${encodeURIComponent(sid)}/inventory/${encodeURIComponent(itemSid)}`,
    body),
  // Item-template search for the "Add item" picker. Filtered server-side to
  // template typecodes 2/3/4 — the save-side type-42 ITEM record is an
  // instance, not something you can pick from.
  items: (q, limit = 40) => request('GET',
    `/api/gamedata/items?q=${encodeURIComponent(q || '')}&limit=${encodeURIComponent(limit)}`),
  // The weapon grade ladder ("Totally rusted junk" .. "Meitou"). A weapon's
  // grade is the (company sid, material sid) pair, NOT `level` — pass the
  // chosen entry's modelSid as addItem's `materialSid`.
  weaponGrades: () => request('GET', '/api/gamedata/weapon-grades'),
  addItem: (name, file, sid, body) => request('POST',
    `/api/saves/${encodeURIComponent(name)}/platoons/${encodeURIComponent(file)}/characters/${encodeURIComponent(sid)}/inventory`,
    body),
  // Named gear sets for bulk equip (services/loadouts.js) — editorial data,
  // items already resolved to names/kinds server-side.
  loadouts: () => request('GET', '/api/loadouts'),
  // Bulk equip: `{ targets: [{file, sid}], loadoutId?, items?, skipIfSlotFilled? }`
  // in ONE staged edit across however many platoon files the targets span.
  // Sending N single-item requests instead would mean N backups and N
  // intermediate on-disk states.
  equipMany: (name, body) => request('POST',
    `/api/saves/${encodeURIComponent(name)}/equip`, body),
  backups: () => request('GET', '/api/backups'),
  createBackup: (save, label) => request('POST', '/api/backups', { save, label }),
  restoreBackup: (id) => request('POST', `/api/backups/${encodeURIComponent(id)}/restore`),
  deleteBackup: (id) => request('DELETE', `/api/backups/${encodeURIComponent(id)}`),
};
