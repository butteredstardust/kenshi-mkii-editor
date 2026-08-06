import { API } from '../api-client.mjs';
import {
  esc, num, plural, showReceipt, runMutation,
} from '../core.mjs';
import { watchSelects } from '../combo.mjs';
import {
  page, envEl, state, keyOf, findCharacter, canWrite,
} from '../state.mjs';
import { setNav } from '../nav.mjs';
import {
  addItemResults, addItemConfig, fitNotice, raceFitWarnings,
} from '../items.mjs';
import { defaultGradeId, defaultLevelFor } from '../grades.mjs';
import { renderSquad, wireSquadPanel, loadRaces } from '../features/squad.mjs';
import { renderGear, fitDetails } from '../features/gear.mjs';
import { renderVendors, wireVendors } from '../features/vendors.mjs';
import { renderResearch, wireResearch } from '../features/research.mjs';
import { renderFactions, wireFactions } from '../features/factions.mjs';
import { renderRecruits, wireRecruits } from '../features/recruits.mjs';
import { renderLoadouts, wireLoadouts, wireBulkEquip } from '../features/loadouts.mjs';
import { renderWorld } from '../features/world.mjs';
import { renderBackups } from '../features/backups.mjs';

/*
 * Reference implementation for docs/ui-style-guide.md. New features compose the
 * components in styles.css — they do not introduce per-feature class names, and
 * every mutation control follows the same shape: intent tier -> confirm if
 * destructive -> disabled while the game runs -> receipt via runMutation().
 */

async function boot() {
  state.env = await API.status();
  const s = state.env.saves[0];
  state.save = s ? s.name : null;
  envEl.innerHTML = state.env.gameRunning
    ? '<span class="critical">Kenshi is running — edits are blocked until you close it</span>'
    : `<span class="ok">ready</span> <span class="muted">· ${esc(plural(state.env.saves.length, 'save'))} · ${esc(state.env.saveRoot || 'no save folder found')}</span>`;
  if (state.save) state.status = await API.saveStatus(state.save);
  state.archetypes = await API.archetypes();
  state.personalities = await API.personalities().catch(() => []);
  // The full race catalogue. Save-independent (it comes from the install's
  // gamedata), so it is fetched once at boot like the archetypes — unlike
  // `state.races`, which is per-save because adding a member needs a donor.
  state.raceCatalogue = await API.raceCatalogue().then((r) => r.races).catch(() => []);
  state.recruits = await API.recruits().catch(() => []);
  // Kenshi's own name pool, so a new member is never called nothing. Fetched
  // once — the files don't change while the app runs.
  state.namePool = await API.names().then((r) => r.names).catch(() => []);
  state.loadouts = await API.loadouts().catch(() => []);
  // Town positions come from the Kenshi install, not the save, so they are
  // fetched once at boot rather than per save.
  state.locations = await API.locations().then((r) => r.locations).catch(() => []);
  state.vendors = await API.vendors().catch(() => null);
  // The item picker's filter vocabulary. Fetched here rather than off the first
  // search response, because the panel renders its <select>s before any search
  // has run — piggybacking left them empty until you had already searched.
  await API.items('', 1).then((r) => {
    state.itemKinds = r.kinds || [];
    state.itemSlots = r.slots || [];
  }).catch(() => {});
  await loadRaces();
  // The grade ladder backs the Gear row's weapon "Quality" select, which is
  // rendered synchronously, so it has to be here rather than fetched lazily.
  // It is one small request (38 rows) and almost every squad carries a weapon.
  try {
    state.weaponGrades = (await API.weaponGrades()).grades;
  } catch {
    state.weaponGrades = []; // ladder is an enhancement; rows fall back to raw fields
  }
  // The Gear row's colour and uniform <select>s are rendered synchronously too
  // (TODO.md 3.1/3.2), so both catalogues are fetched here rather than lazily.
  state.colors = await API.colors().then((r) => r.colors).catch(() => []);
  state.factionCatalogue = await API.factionCatalogue().then((r) => r.factions).catch(() => []);
  render();
}

function savePicker() {
  return `<label class="picker">Save
    <select id="save-select">
      ${state.env.saves.map((s) => `<option value="${esc(s.name)}" ${s.name === state.save ? 'selected' : ''}>${esc(s.name)} — ${esc(s.savedAt)}</option>`).join('')}
    </select></label>`;
}

async function render() {
  page.innerHTML = state.current === 'squad' ? renderSquad()
    : state.current === 'gear' ? renderGear()
      : state.current === 'vendors' ? renderVendors()
        : state.current === 'factions' ? await renderFactions()
          : state.current === 'research' ? await renderResearch()
            : state.current === 'recruits' ? renderRecruits()
              : state.current === 'loadouts' ? renderLoadouts()
                : state.current === 'world' ? renderWorld()
                  : await renderBackups();
  wire();
}

/** Re-read the save after a successful write so the UI reflects disk. */
async function refresh() {
  state.status = await API.saveStatus(state.save);
}

function wire() {
  const sel = document.getElementById('save-select');
  if (sel) sel.onchange = async () => {
    state.save = sel.value;
    state.addMember = null; // race sids and platoon files are per-save
    state.research = null; // research state belongs to the save, not the app
    state.researchSel.clear();
    // Faction relations are per-save too, and a pending edit names a faction by
    // gamedata sid — which would look valid against the new save and write a
    // number the user chose while reading a different world.
    state.factions = null;
    state.factionView = null;
    state.factionEdits.clear();
    await refresh();
    await loadRaces();
    render();
  };

  wireSquadPanel();
  wireBulkEquip();
  wireVendors();
  wireFactions();
  wireResearch();
  wireRecruits();
  wireLoadouts();

  const money = document.getElementById('save-money');
  if (money) money.onclick = () => runMutation(
    money, document.getElementById('receipt'), 'money set',
    () => API.setMoney(state.save, Number(document.getElementById('money').value)),
    refresh,
  );

  page.querySelectorAll('[data-select]').forEach((b) => {
    b.onclick = () => { state.selected = b.dataset.select; render(); };
  });

  // Roster group disclosure. <details> already opened or closed itself by the
  // time this fires, so all this does is record the choice — re-rendering here
  // would tear down the element mid-click and fight the browser for it.
  page.querySelectorAll('.roster-squad').forEach((d) => {
    d.ontoggle = () => {
      const open = new Set([...page.querySelectorAll('.roster-squad')]
        .filter((x) => x.open).map((x) => x.dataset.group));
      state.rosterOpen = open;
    };
  });

  // Narrowing the roster by race re-renders (it changes which rows exist), and
  // deliberately does NOT clear the selection: picking "Skeleton", hitting
  // "All shown", then switching to "Hive Prince" and hitting it again is how a
  // mixed selection gets built.
  const raceSel = document.getElementById('roster-race');
  if (raceSel) raceSel.onchange = () => { state.raceFilter = raceSel.value; render(); };

  const filter = document.getElementById('roster-filter');
  if (filter) filter.oninput = () => {
    state.filter = filter.value;
    render();
    // Re-focus the filter and restore the caret — render() replaces the node.
    const next = document.getElementById('roster-filter');
    if (next) { next.focus(); next.setSelectionRange(next.value.length, next.value.length); }
  };

  page.querySelectorAll('.card').forEach((card) => {
    const receipt = card.querySelector('.receipt');
    const { file, sid } = card.dataset;

    // Re-attach the receipt stashed by a mutation that re-rendered this card.
    const pending = state.pendingReceipt;
    if (pending && pending.key === keyOf(file, sid)) {
      showReceipt(receipt, pending.result, { label: pending.label, details: pending.details });
      state.pendingReceipt = null;
    }
    // Medical edits change what the card renders, so they re-render; stat edits
    // don't move anything, so they only refresh state.
    // A re-render replaces the card's HTML — including the .receipt element the
    // result was just written into — so the confirmation would vanish the
    // instant the edit succeeded, making a working mutation look like a no-op.
    // Stash it and let the next wire() re-attach it to the fresh element.
    // `details` is the one receipt surface's extra-lines channel (style guide
    // §2.5) — the race switch is the caller that needs it, since its advisory
    // warnings are the whole reason it never refuses.
    const run = (btn, label, fn, rerender = false, details = null) => runMutation(
      btn, receipt, label, fn, async (result) => {
        await refresh();
        if (rerender) {
          state.pendingReceipt = {
            key: keyOf(file, sid), result, label, details: details ? details(result) : null,
          };
          render();
        }
      },
      { details },
    );

    const renameBtn = card.querySelector('.rename-char');
    if (renameBtn) renameBtn.onclick = () => {
      const input = card.querySelector('.char-name');
      const value = input.value.trim();
      if (!value || value === input.dataset.initial) {
        return showReceipt(receipt, new Error('Enter a different name first.'));
      }
      // Re-renders: the name shows in the card head, the roster and the filter.
      return run(renameBtn, `renamed to ${value}`, () => API.renameCharacter(state.save, file, sid, value), true);
    };

    const persoBtn = card.querySelector('.set-personality');
    if (persoBtn) persoBtn.onclick = () => {
      const sel = card.querySelector('.char-personality');
      if (sel.value === sel.dataset.initial) {
        return showReceipt(receipt, new Error('Pick a different personality first.'));
      }
      const label = sel.selectedOptions[0].textContent;
      // Re-renders: the card's own hint line describes the chosen personality.
      return run(persoBtn, `personality set to ${label}`,
        () => API.setPersonality(state.save, file, sid, Number(sel.value)), true);
    };

    const raceBtn = card.querySelector('.set-race');
    if (raceBtn) raceBtn.onclick = () => {
      const sel = card.querySelector('.char-race');
      if (sel.value === sel.dataset.initial) {
        return showReceipt(receipt, new Error('Pick a different race first.'));
      }
      const label = sel.selectedOptions[0].textContent;
      // Re-renders: the race shows in the card head, the roster row and the
      // health section's body-part table, all of which this changes.
      //
      // The warnings are the point of the receipt here. A race switch never
      // refuses on fit (AGENTS.md §3 — race compatibility is advisory), so
      // "expect this character to look different" and "this race is not
      // playable" are things the user can only learn from the result.
      return run(raceBtn, `race set to ${label}`,
        () => API.setRace(state.save, file, sid, sel.value), true,
        (result) => {
          const r = (result.receipts || [])[0] || {};
          const lines = (r.warnings || []).slice();
          if (r.parts) {
            const moved = r.parts.filter((p) => p.before.hit !== p.after.hit
              || p.before.sid !== p.after.sid);
            if (moved.length) {
              lines.push('', ...moved.map((p) => `${p.after.name}: hit ${num(p.before.hit)} → ${num(p.after.hit)}`
                + `, flesh ${num(p.before.flesh)} → ${num(p.after.flesh)} of ${num(p.after.max)}`));
            }
          }
          return lines;
        });
    };

    const statsBtn = card.querySelector('.save-stats');
    if (statsBtn) statsBtn.onclick = () => {
      const changed = {};
      card.querySelectorAll('.stat-input').forEach((input) => {
        const value = Number(input.value);
        if (input.value !== input.dataset.initial && !Number.isNaN(value)) changed[input.dataset.stat] = value;
      });
      if (Object.keys(changed).length === 0) return showReceipt(receipt, new Error('No stats changed.'));
      return run(statsBtn, `${plural(Object.keys(changed).length, 'stat')} set`,
        () => API.setStats(state.save, file, sid, changed));
    };

    card.querySelectorAll('.heal-part-btn').forEach((b) => {
      b.onclick = () => {
        const row = card.querySelector(`tr[data-part="${b.dataset.part}"]`);
        const flesh = Number(row.querySelector('.flesh-input').value);
        return run(b, 'flesh set', () => API.healPart(state.save, file, sid, b.dataset.part, { flesh }), true);
      };
    });

    card.querySelectorAll('.full-heal-btn').forEach((b) => {
      b.onclick = () => run(b, 'part healed',
        () => API.healPart(state.save, file, sid, b.dataset.part, { flesh: 'full' }), true);
    });

    const hunger = card.querySelector('.save-hunger');
    if (hunger) hunger.onclick = () => {
      const body = {};
      card.querySelectorAll('.hunger-input').forEach((input) => {
        const value = Number(input.value);
        if (input.value !== input.dataset.initial && !Number.isNaN(value)) body[input.dataset.field] = value;
      });
      if (Object.keys(body).length === 0) return showReceipt(receipt, new Error('No hunger change.'));
      return run(hunger, 'hunger set', () => API.setHunger(state.save, file, sid, body), true);
    };

    const revive = card.querySelector('.revive-btn');
    if (revive) revive.onclick = () => {
      if (!confirm('Revive this character? Clears death, KO and coma flags and raises any lethally low flesh in the same write.')) return undefined;
      return run(revive, 'revived', () => API.revive(state.save, file, sid, {}), true);
    };

    const limbs = card.querySelector('.restore-limbs-btn');
    if (limbs) limbs.onclick = () => {
      if (!confirm('Restore limbs? This deletes the raw "limbs" flag. Individual lost-limb flesh values are NOT restored by this action.')) return undefined;
      return run(limbs, 'limbs flag cleared', () => API.restoreLimbs(state.save, file, sid), true);
    };

    // Bounties (TODO.md 3.6): one Apply per row, sending only that row's
    // amount. There is no "add" control here to wire — see
    // saveService.setBountyAmount()'s comment for why that path doesn't exist.
    card.querySelectorAll('.apply-bounty-btn').forEach((b) => {
      b.onclick = () => {
        const row = b.closest('tr');
        const input = row.querySelector('.bounty-amount-input');
        const amount = Number(input.value);
        if (input.value === input.dataset.initial) {
          return showReceipt(receipt, new Error('Enter a different amount first.'));
        }
        return run(b, `bounty ${b.dataset.index} reduced to ${amount}`,
          () => API.setBountyAmount(state.save, file, sid, b.dataset.index, amount), true);
      };
    });

    const reduceBounties = card.querySelector('.reduce-bounties-btn');
    if (reduceBounties) reduceBounties.onclick = () => {
      if (!confirm('Reduce every bounty on this character to 1? This is the safe removal method — '
        + 'it lets each bounty expire on its own rather than setting it to 0, which the guide warns '
        + 'against. bountyexp/claim/crimes and who wants them are left untouched.')) return undefined;
      return run(reduceBounties, 'bounties reduced to 1',
        () => API.clearBounties(state.save, file, sid), true);
    };

    // Gear: "More" reveals the raw level/quality fields for one row.
    card.querySelectorAll('.more-item-btn').forEach((b) => {
      b.onclick = () => {
        const itemSid = b.closest('tr').dataset.sid;
        const adv = card.querySelector(`tr[data-advanced-for="${CSS.escape(itemSid)}"]`);
        const open = adv.hidden;
        adv.hidden = !open;
        b.setAttribute('aria-expanded', String(open));
      };
    });

    // Gear: every control in a row is a PENDING edit; one Apply per row sends
    // them together. The button stays disabled until something actually
    // differs from what's on disk, so "Apply" never means "write the same
    // values back" (which the mutation gate would reject as a no-op anyway,
    // reporting a confusing error for what looked like a valid action).
    const gearChar = findCharacter(file, sid);

    // These carry a string value straight through (a stringID or a composite
    // grade key) — every other `.item-field` is a plain number.
    const STRING_ITEM_FIELDS = new Set(['gradeId', 'colorSid', 'uniformSid']);

    const collectPatch = (row) => {
      const patch = {};
      // A row's advanced `level` input and its quality <select> both target
      // `level`. Later wins, and the advanced input is later in the DOM, so an
      // explicitly typed raw value takes precedence over the tier dropdown.
      const itemSid = row.dataset.sid;
      const fields = [
        ...row.querySelectorAll('.item-field'),
        ...card.querySelectorAll(`tr[data-advanced-for="${CSS.escape(itemSid)}"] .item-field`),
      ];
      for (const el of fields) {
        if (el.value === el.dataset.initial) continue;
        // A blank value on a plain number input means "nothing typed, leave
        // alone". A blank value on a <select> — colorSid's/uniformSid's
        // "— none —" — is a real, selectable state (how each is CLEARED,
        // TODO.md 3.1/3.2) and must be sent, or Apply could never clear one.
        if (el.tagName !== 'SELECT' && el.value === '') continue;
        patch[el.dataset.field] = STRING_ITEM_FIELDS.has(el.dataset.field) ? el.value : Number(el.value);
      }
      const slot = row.querySelector('.item-slot-select');
      if (slot && slot.value !== slot.dataset.initial) patch.section = slot.value;
      // Stolen: a checkbox, not a diffable value — ticking it means "clear",
      // and it is only ever rendered (items.mjs) when the item IS stolen, so
      // there is nothing to represent by unchecking it.
      const stolenBox = row.querySelector('.item-stolen-clear')
        || card.querySelector(`tr[data-advanced-for="${CSS.escape(itemSid)}"] .item-stolen-clear`);
      if (stolenBox && stolenBox.checked) patch.clearStolen = true;
      return patch;
    };

    const refreshRowState = (row) => {
      const applyBtn = row.querySelector('.apply-item-btn');
      if (!applyBtn) return;
      const changed = Object.keys(collectPatch(row)).length > 0;
      applyBtn.disabled = !changed || !canWrite();

      // Name what a slot change will displace, before the write happens.
      const slot = row.querySelector('.item-slot-select');
      const note = row.querySelector('.item-collision-note');
      if (slot && note) {
        const target = slot.value;
        const isBucket = target === 'main' || target === 'backpack_content';
        const occupant = !isBucket && gearChar
          ? (gearChar.inventory || []).find((it) => it.section === target && it.sid !== row.dataset.sid)
          : null;
        note.textContent = occupant ? `replaces ${occupant.name}` : '';
      }
    };

    card.querySelectorAll('tbody tr[data-sid]').forEach((row) => {
      const itemSid = row.dataset.sid;
      const controls = [
        ...row.querySelectorAll('.item-field, .item-slot-select'),
        ...card.querySelectorAll(`tr[data-advanced-for="${CSS.escape(itemSid)}"] .item-field, `
          + `tr[data-advanced-for="${CSS.escape(itemSid)}"] .item-stolen-clear`),
      ];
      controls.forEach((el) => {
        el.oninput = () => refreshRowState(row);
        el.onchange = () => refreshRowState(row);
      });
      refreshRowState(row);

      const applyBtn = row.querySelector('.apply-item-btn');
      if (applyBtn) applyBtn.onclick = () => {
        const patch = collectPatch(row);
        if (Object.keys(patch).length === 0) return showReceipt(receipt, new Error('Nothing changed on this row.'));
        return run(applyBtn, 'item updated',
          () => API.updateItem(state.save, file, sid, itemSid, patch), true, fitDetails);
      };

      // Unequip one item: a move to `main`, which is just the slot control's
      // most common destination with the two clicks taken out. It goes through
      // the same per-item route, so it is one staged edit like every other row
      // action — the bulk panel is where "take this off everyone" lives.
      const unequipBtn = row.querySelector('.unequip-item-btn');
      if (unequipBtn) unequipBtn.onclick = () => run(unequipBtn, 'unequipped',
        () => API.updateItem(state.save, file, sid, itemSid, { section: 'main' }), true);
    });

    // ---------------------------------------------------------- Add item --
    // Search results and the configure step are rendered imperatively rather
    // than through render(): a full re-render on every keystroke would tear
    // down the search box mid-type. Only the final write re-renders, because
    // that genuinely changes what the item tables show.
    const addSearch = card.querySelector('.add-item-search');
    if (addSearch) {
      const resultsEl = card.querySelector('.add-item-results');
      const configEl = card.querySelector('.add-item-config');
      const cardKey = keyOf(file, sid);
      const pickOf = () => (state.addItem && state.addItem.key === cardKey ? state.addItem : null);

      const wireConfig = () => {
        const pick = pickOf();
        if (!pick || !pick.template) { configEl.innerHTML = ''; return; }
        configEl.innerHTML = addItemConfig(pick);

        // Armour only — see bulkItemConfig()/addItemConfig(): a weapon's quality
        // is its Grade, and its level follows from that server-side.
        const presetSel = configEl.querySelector('.add-item-level-preset');
        const gradeSel = configEl.querySelector('.add-item-grade');
        const qtyInput = configEl.querySelector('.add-item-quantity');
        const sectionSel = configEl.querySelector('.add-item-section');
        const collision = configEl.querySelector('.add-item-collision');

        // The armour tier is the value itself, not a quick-fill for a raw box.
        if (presetSel) presetSel.onchange = () => {
          pick.level = presetSel.value === '' ? undefined : Number(presetSel.value);
        };
        if (gradeSel) gradeSel.onchange = () => { pick.gradeId = gradeSel.value || undefined; };
        if (qtyInput) qtyInput.oninput = () => { pick.quantity = Number(qtyInput.value); };

        const fitEl = configEl.querySelector('.add-item-fit');

        // Name what this placement will displace BEFORE the write, same as the
        // per-row "replaces X" note on the move control — and, in the same
        // breath, whether this character's race can wear it at all.
        const updateCollision = () => {
          pick.section = sectionSel.value;
          const target = sectionSel.value;
          const isBucket = target === 'main' || target === 'backpack_content';
          const ch = findCharacter(file, sid);
          const occupant = !isBucket && ch
            ? (ch.inventory || []).find((it) => it.section === target)
            : null;
          collision.textContent = occupant ? `Replaces ${occupant.name}, which moves back to Carried (main).` : '';
          if (fitEl) fitEl.innerHTML = fitNotice(raceFitWarnings(pick.template, ch, target));
        };
        sectionSel.onchange = updateCollision;
        updateCollision();

        configEl.querySelector('.add-item-clear').onclick = () => {
          state.addItem = { key: cardKey, query: pick.query, results: pick.results, total: pick.total };
          configEl.innerHTML = '';
        };

        const addBtn = configEl.querySelector('.add-item-btn');
        addBtn.onclick = () => {
          const body = { templateSid: pick.template.sid, section: sectionSel.value };
          if (pick.level !== undefined) body.level = pick.level;
          if (gradeSel && gradeSel.value) body.gradeId = gradeSel.value;
          if (qtyInput && qtyInput.value !== '') body.quantity = Number(qtyInput.value);
          return run(addBtn, `added ${pick.template.name}`,
            () => API.addItem(state.save, file, sid, body), true, fitDetails);
        };
      };

      const wireResults = () => {
        const pick = pickOf();
        if (!pick || !pick.results) { resultsEl.innerHTML = ''; return; }
        resultsEl.innerHTML = addItemResults(pick.results, pick.total);
        resultsEl.querySelectorAll('.pick-item-btn').forEach((b) => {
          b.onclick = async () => {
            const template = pick.results.find((r) => r.sid === b.dataset.sid);
            if (!template) return;
            // The grade ladder is only meaningful for weapons, so it is fetched
            // the first time one is actually selected rather than at boot.
            if (template.type === 2 && !state.weaponGrades) {
              try {
                state.weaponGrades = (await API.weaponGrades()).grades;
              } catch {
                state.weaponGrades = []; // ladder is optional; the server defaults the grade
              }
            }
            Object.assign(pick, {
              template,
              section: template.allowedSections[0],
              quantity: template.stackable ? 1 : undefined,
              // Sensible tier out of the box rather than the ladder's floor —
              // see DEFAULT_ARMOUR_LEVEL / defaultGradeId().
              level: defaultLevelFor(template.type),
              gradeId: template.type === 2 ? defaultGradeId() : undefined,
            });
            wireConfig();
          };
        });
      };

      const kindSel = card.querySelector('.add-item-kind');
      const slotSel = card.querySelector('.add-item-slot');

      const search = async (query) => {
        const pick = pickOf() || { key: cardKey };
        state.addItem = pick;
        pick.query = query;
        pick.kind = kindSel ? kindSel.value : '';
        pick.slot = slotSel ? slotSel.value : '';
        // The filters are part of the request identity, so a slower earlier
        // request can't overwrite a newer one that only changed a filter.
        const token = `${query}|${pick.kind}|${pick.slot}`;
        try {
          const res = await API.items(query, 40, { kind: pick.kind, slot: pick.slot });
          if (`${pick.query}|${pick.kind}|${pick.slot}` !== token) return;
          pick.results = res.items;
          pick.total = res.total;
          // The server owns the filter vocabulary; cache it the first time it
          // comes back rather than hardcoding a list that could drift.
          if (res.kinds) state.itemKinds = res.kinds;
          if (res.slots) state.itemSlots = res.slots;
        } catch (err) {
          pick.results = [];
          pick.total = 0;
          showReceipt(receipt, err);
        }
        wireResults();
      };

      let searchTimer = null;
      addSearch.oninput = () => {
        clearTimeout(searchTimer);
        const q = addSearch.value;
        searchTimer = setTimeout(() => search(q), 180);
      };
      if (kindSel) kindSel.onchange = () => search(addSearch.value);
      if (slotSel) slotSel.onchange = () => search(addSearch.value);
      // Opening the panel with nothing typed yet lists the catalogue, so the
      // control is explorable rather than a blank box that only rewards guesses.
      const addDetails = addSearch.closest('details');
      addDetails.ontoggle = () => {
        if (addDetails.open && !(pickOf() || {}).results) search('');
      };

      wireResults();
      wireConfig();
    }

    const trainMain = card.querySelector('.train-main');
    const trainSub = card.querySelector('.train-sub');
    if (trainMain && trainSub) {
      const populateSubs = () => {
        const m = state.archetypes.find((a) => a.id === trainMain.value);
        trainSub.innerHTML = (m ? m.subs : [])
          .map((s) => `<option value="${esc(s.id)}">${esc(s.label)}</option>`).join('');
      };
      const remember = () => {
        state.trainChoice = { key: keyOf(file, sid), archetype: trainMain.value, sub: trainSub.value };
      };
      trainMain.onchange = () => { populateSubs(); remember(); };
      trainSub.onchange = remember;

      // Training re-renders the card, which would otherwise snap the selects
      // back to the first archetype — leaving the form contradicting the
      // receipt that just said what was applied.
      const choice = state.trainChoice;
      if (choice && choice.key === keyOf(file, sid)) {
        trainMain.value = choice.archetype;
        populateSubs();
        trainSub.value = choice.sub;
      }
    }

    const trainBtn = card.querySelector('.train-btn');
    if (trainBtn) trainBtn.onclick = () => {
      const archetype = trainMain.value;
      const sub = trainSub.value;
      const raiseOnly = card.querySelector('.train-raise-only').checked;
      const mode = raiseOnly ? 'raise' : 'set';
      const main = state.archetypes.find((a) => a.id === archetype);
      const subEntry = main?.subs.find((s) => s.id === sub);
      const lowerNote = raiseOnly ? 'it will never lower an existing stat' : 'it CAN lower existing stats back down';
      // The character object only exists in the render pass; wire() sees the
      // card element, so identity comes off the dataset (see `data-name`).
      if (!confirm(`Train ${card.dataset.name || 'this character'} as ${main?.label || archetype} / ${subEntry?.label || sub}? `
        + `This rewrites attributes and dozens of skills — ${lowerNote}.`)) return undefined;
      return run(trainBtn, 'trained', () => API.trainCharacter(state.save, file, sid, { archetype, sub, mode }), true);
    };
  });

  // Backups is the page you come to when something has already gone wrong, so
  // it is the last place a failure may die in the console (style guide §2.5).
  const backupReceipt = document.getElementById('backup-receipt');

  // Every action on this page re-renders the table, which tears down the
  // receipt element showReceipt() just wrote into. Stash it and let the next
  // pass re-attach it, the same way the bulk panels do.
  if (backupReceipt && state.panelReceipt) {
    showReceipt(backupReceipt, state.panelReceipt.result,
      { label: state.panelReceipt.label, details: state.panelReceipt.details });
    state.panelReceipt = null;
  }
  const keepReceipt = (label, details) => async (result) => {
    state.panelReceipt = { result, label, details: details ? details(result) : null };
  };

  // View-only filters: neither writes anything, so both just re-render.
  const allSaves = document.getElementById('backup-all-saves');
  if (allSaves) {
    allSaves.onchange = () => {
      state.backupFilter.allSaves = allSaves.checked;
      render();
    };
  }
  const showAll = document.getElementById('backup-show-all');
  if (showAll) {
    showAll.onchange = () => { state.backupFilter.showAll = showAll.checked; render(); };
  }

  const mk = document.getElementById('make-backup');
  if (mk) {
    mk.onclick = () => runMutation(mk, backupReceipt, 'backed up',
      () => API.createBackup(state.save, 'manual'),
      async (result) => { await keepReceipt('backed up', (r) => [r.id])(result); render(); });
  }

  page.querySelectorAll('[data-restore]').forEach((b) => {
    b.onclick = () => {
      if (!confirm(`Restore ${b.dataset.restore}? This replaces the whole live save directory with this backup. Anything you have done in game since it was taken is lost.`)) return undefined;
      return runMutation(b, backupReceipt, 'restored',
        () => API.restoreBackup(b.dataset.restore),
        async (result) => {
          await keepReceipt('restored', (r) => [`${r.files} files into ${r.into}`])(result);
          await boot();
        });
    };
  });
  page.querySelectorAll('[data-delete]').forEach((b) => {
    b.onclick = () => {
      // A backup is the safety net. Deleting one is irreversible, and the
      // button sits one row-width from Restore.
      if (!confirm(`Delete backup ${b.dataset.delete}? This cannot be undone.`)) return undefined;
      return runMutation(b, backupReceipt, 'deleted',
        () => API.deleteBackup(b.dataset.delete),
        async (result) => { await keepReceipt('deleted', (r) => [r.deleted])(result); render(); });
    };
  });
}

export function start() {
  // Hands the shell's own render/refresh/savePicker to nav.mjs, so the feature
  // modules that import them from there (avoiding the import cycle a direct
  // import of app.mjs would create) get the real implementations.
  setNav({ render, refresh, savePicker });

  document.querySelectorAll('.tabs button').forEach((b) => {
    b.onclick = () => {
      document.querySelectorAll('.tabs button').forEach((x) => x.classList.remove('active'));
      b.classList.add('active');
      state.current = b.dataset.page;
      render();
    };
  });

  // Long <select>s get a filter box. Started ONCE, before boot, as an observer
  // on the page root rather than a call at the end of wire(): render() replaces
  // #page wholesale and several panels write their own innerHTML afterwards, so
  // a single hook here covers every path that can produce a dropdown. See
  // public/modules/combo.mjs for why the native control is kept rather than
  // replaced.
  watchSelects(page);

  boot().catch((err) => { page.innerHTML = `<p class="critical">${esc(err.message)}</p>`; });
}
