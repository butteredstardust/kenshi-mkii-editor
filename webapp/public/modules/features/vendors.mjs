import { API } from '../api-client.mjs';
import { esc, plural, showReceipt, runMutation } from '../core.mjs';
import { state, keyOf, dis } from '../state.mjs';
import { icon, ITEM_KIND_ICONS } from '../icons.mjs';
import { render, refresh, savePicker } from '../nav.mjs';
import { buildRoster } from './roster.mjs';

// ---------------------------------------------------------------- Vendors --

/**
 * Who sells what, and where.
 *
 * Three cascading pickers — faction, town, shop — then the shop's stock, with a
 * per-row Add that writes the item straight onto a chosen character. That is
 * the whole point of the page: you find a thing in a shop and take it.
 *
 * The top level is FACTION, not region. Kenshi's biome regions are real records
 * but nothing in the data links a town to one (see services/vendorsService.js),
 * and labelling faction as "region" would be a claim the data can't support.
 *
 * Stock comes from gamedata, not the save: shops generate their inventory at
 * runtime, so this is what a shop CAN carry, not what it holds right now.
 */
function vendorPicker() {
  const v = state.vendors;
  if (!v || !v.tree.length) {
    return `<div class="empty-state"><strong>No vendor data</strong>Nothing could be read from your Kenshi install.</div>`;
  }
  const sel = state.vendorSel || {};
  const faction = v.tree.find((f) => f.faction === sel.faction) || v.tree[0];
  const town = faction.towns.find((t) => t.town === sel.town) || faction.towns[0];
  const shopId = sel.shopId && town.shops.some((s) => s.id === sel.shopId)
    ? sel.shopId : town.shops[0].id;

  return `<div class="field-row">
    <label class="field field--grow">Faction
      <select id="vendor-faction">
        ${v.tree.map((f) => `<option value="${esc(f.faction)}" ${f === faction ? 'selected' : ''}>${esc(f.faction)} (${esc(f.towns.length)})</option>`).join('')}
      </select></label>
    <label class="field field--grow">Location
      <select id="vendor-town">
        ${faction.towns.map((t) => `<option value="${esc(t.town)}" ${t === town ? 'selected' : ''}>${esc(t.town)} (${esc(t.shops.length)})</option>`).join('')}
      </select></label>
    <label class="field field--grow">Shop
      <select id="vendor-shop">
        ${town.shops.map((s) => `<option value="${esc(s.id)}" ${s.id === shopId ? 'selected' : ''}>${esc(s.shop)} — ${esc(s.items)} items</option>`).join('')}
      </select></label>
  </div>`;
}

/** The selected shop's stock, with a per-row Add. Rendered imperatively. */
function vendorStock(shop) {
  if (!shop) return '<p class="hint">Pick a shop.</p>';
  if (!shop.items.length) return '<p class="hint">This shop stocks nothing this editor can add.</p>';

  const KIND = { 2: 'weapon', 3: 'armour', 4: 'trade goods', 46: 'backpack', 107: 'crossbow', 111: 'limb', 102: 'map', 21: 'research', 51: 'manufacturer' };
  const blocked = shop.items.filter((i) => !i.addable).length;
  const bps = shop.items.filter((i) => i.blueprint).length;
  return `<p class="hint">${esc(shop.shop)} in ${esc(shop.town)} — stock lists:
      ${esc(shop.lists.map((l) => l.name).join(', '))}.
      What the shop <em>can</em> carry; actual stock is rolled in game.${blocked
    ? ` ${esc(plural(blocked, 'row'))} are weapon-manufacturer entries rather than objects, so they have no Add.` : ''}${bps
    ? ` ${esc(plural(bps, 'row'))} are blueprints — the shop sells the blueprint, not the thing it unlocks.` : ''}</p>
    <div class="table-wrap"><table class="data-table">
      <thead><tr><th class="col-item">Item</th><th>Kind</th><th>From list</th><th class="shrink"></th></tr></thead>
      <tbody>${shop.items.map((it) => `<tr data-row="${esc(it.key)}"${it.addable ? '' : ' class="row-muted"'}>
        <td class="col-item"><span class="item-name">${icon(it.blueprint ? 'list' : (ITEM_KIND_ICONS[it.type] || 'bag'), it.blueprint ? 'blueprint' : (KIND[it.type] || ''))}<span>${esc(it.name)}</span></span>
          ${it.blueprint ? `<div class="muted">unlocks ${esc(it.blueprint.subjectName || it.sid)}</div>` : ''}
          ${it.addable ? '' : `<div class="muted">${esc(it.reason)}</div>`}</td>
        <td class="muted">${esc(it.blueprint ? 'blueprint' : (KIND[it.type] || `type ${it.type}`))}</td>
        <td class="muted">${esc(it.category)}</td>
        <td class="shrink"><span class="actions">
          ${it.addable
    ? `<button class="btn btn--xs vendor-add" data-row="${esc(it.key)}" ${dis()}>Add</button>`
    : '<span class="muted">—</span>'}
        </span></td>
      </tr>`).join('')}</tbody>
    </table></div>`;
}

export function renderVendors() {
  const r = buildRoster();
  const chars = r ? r.all : [];
  const targetKey = state.vendorTarget && chars.some(({ c, file }) => keyOf(file, c.sid) === state.vendorTarget)
    ? state.vendorTarget : (chars[0] ? keyOf(chars[0].file, chars[0].c.sid) : null);

  return `${savePicker()}
    <section class="panel">
      <div class="panel-head"><h2>${icon('cats', 'Vendors')} Vendors</h2>
        <span class="muted">${esc(state.vendors ? state.vendors.stats.shops : 0)} shops ·
          ${esc(state.vendors ? state.vendors.stats.towns : 0)} towns</span></div>
      ${vendorPicker()}
      ${chars.length ? `<div class="action-bar">
        <span class="action-bar-label">${icon('add', 'Add')} Add to</span>
        <label class="field">Character
          <select id="vendor-target" ${dis()}>
            ${chars.map(({ c, file }) => `<option value="${esc(keyOf(file, c.sid))}" ${keyOf(file, c.sid) === targetKey ? 'selected' : ''}>${esc(c.name || '(unnamed)')}</option>`).join('')}
          </select></label>
        <label class="field">Place in
          <select id="vendor-section" ${dis()}>
            <option value="main">Carried</option>
            <option value="backpack_content">In backpack</option>
          </select></label>
        <label class="field">Quantity
          <input type="number" id="vendor-qty" class="w-sm" min="1" step="1" value="1" ${dis()}></label>
      </div>` : '<p class="hint">No player squad in this save to add items to.</p>'}
      <div id="vendor-stock"></div>
      <pre class="receipt" id="vendor-receipt" hidden></pre>
    </section>`;
}

/**
 * The Vendors page. The three pickers re-render (they cascade, so the town and
 * shop lists change with the faction), but loading a shop's stock does not —
 * it is fetched and written into #vendor-stock directly, the same rule the item
 * picker follows.
 */
export function wireVendors() {
  const factionSel = document.getElementById('vendor-faction');
  if (!factionSel) return;
  const townSel = document.getElementById('vendor-town');
  const shopSel = document.getElementById('vendor-shop');
  const stockEl = document.getElementById('vendor-stock');
  const receipt = document.getElementById('vendor-receipt');
  const targetSel = document.getElementById('vendor-target');
  const sectionSel = document.getElementById('vendor-section');
  const qtyInput = document.getElementById('vendor-qty');

  if (state.panelReceipt) {
    showReceipt(receipt, state.panelReceipt.result, { label: state.panelReceipt.label });
    state.panelReceipt = null;
  }

  const loadStock = async () => {
    const id = shopSel.value;
    state.vendorSel = { faction: factionSel.value, town: townSel.value, shopId: id };
    stockEl.innerHTML = '<p class="hint">Loading…</p>';
    try {
      const shop = await API.vendorShop(id);
      if (shopSel.value !== id) return; // a newer selection won
      state.vendorShop = shop;
      stockEl.innerHTML = vendorStock(shop);
      wireAddButtons();
    } catch (err) {
      stockEl.innerHTML = '';
      showReceipt(receipt, err);
    }
  };

  const wireAddButtons = () => {
    for (const btn of stockEl.querySelectorAll('.vendor-add')) {
      btn.onclick = () => {
        if (!targetSel) return showReceipt(receipt, new Error('No character to add to.'));
        const [file, sid] = targetSel.value.split('::');
        const row = (state.vendorShop.items || []).find((i) => i.key === btn.dataset.row);
        if (!row) return showReceipt(receipt, new Error('That row is no longer in this shop.'));
        const qty = Math.max(1, Number(qtyInput.value) || 1);
        // A blueprint shelf sells the BLUEPRINT, so the template written is the
        // blueprint item's, and the row's own sid rides along as what it
        // teaches. Sending row.sid here would add the armour instead.
        const body = row.blueprint
          ? { templateSid: row.blueprint.templateSid, teaches: row.blueprint.teaches }
          : { templateSid: row.sid };
        return runMutation(btn, receipt, `added ${row.name}`,
          () => API.addItem(state.save, file, sid, {
            ...body,
            section: sectionSel.value,
            ...(qty > 1 ? { quantity: qty } : {}),
          }),
          async () => { await refresh(); },
          // The "already finished" note is the only way to learn a blueprint is
          // a dud — the ledger knows and nothing on this page does.
          { details: (result) => ((result.receipts || [])[0] || {}).warnings || [] });
      };
    }
  };

  factionSel.onchange = () => { state.vendorSel = { faction: factionSel.value }; render(); };
  townSel.onchange = () => { state.vendorSel = { faction: factionSel.value, town: townSel.value }; render(); };
  shopSel.onchange = loadStock;
  if (targetSel) targetSel.onchange = () => { state.vendorTarget = targetSel.value; };

  loadStock();
}
