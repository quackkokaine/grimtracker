/* ===== Grim Dawn save reader (player.gdc) =====
   Reads only what the tracker needs: header (name, class tag, level, hardcore),
   block 1 (difficulty / mod flag), block 2 (level, devotion), block 16 (deaths),
   block 17 (shrine lists). Every other block is skipped, so new blocks added in
   later game versions don't break the reader. */
const GDSave = (() => {
  const MAGIC = 0x58434447; // "GDCX"

  function Reader(buf) {
    const dv = new DataView(buf);
    const len = buf.byteLength;
    let pos = 0, key = 0;
    const table = new Uint32Array(256);

    function need(n) { if (pos + n > len) throw new Error("unexpected end of file at " + pos); }
    function upd(b) { key = (key ^ table[b]) >>> 0; }

    return {
      get pos() { return pos; }, len,
      snap() { return [pos, key]; },
      restore(s) { pos = s[0]; key = s[1]; },
      float() { const i = this.int(); const f = new DataView(new ArrayBuffer(4)); f.setUint32(0, i, true); return f.getFloat32(0, true); },
      init() {
        need(4);
        let k = (dv.getUint32(0, true) ^ 0x55555555) >>> 0; pos = 4;
        key = k;
        for (let i = 0; i < 256; i++) {
          k = ((k >>> 1) | (k << 31)) >>> 0;
          k = Math.imul(k, 39916801) >>> 0;
          table[i] = k;
        }
      },
      int() {
        need(4);
        const raw = dv.getUint32(pos, true);
        const ret = (raw ^ key) >>> 0;
        for (let i = 0; i < 4; i++) upd(dv.getUint8(pos + i));
        pos += 4; return ret;
      },
      byte() {
        need(1);
        const raw = dv.getUint8(pos);
        const ret = (raw ^ key) & 255;
        upd(raw); pos += 1; return ret;
      },
      next() { need(4); const r = (dv.getUint32(pos, true) ^ key) >>> 0; pos += 4; return r; },
      skipTo(end) { if (end > len) throw new Error("block runs past end of file"); while (pos < end) { upd(dv.getUint8(pos)); pos++; } },
      str() { const n = this.int(); if (n > 4096) throw new Error("bad string length " + n); let s = ""; for (let i = 0; i < n; i++) s += String.fromCharCode(this.byte()); return s; },
      wstr() { const n = this.int(); if (n > 4096) throw new Error("bad name length " + n); let s = ""; for (let i = 0; i < n; i++) { const lo = this.byte(), hi = this.byte(); s += String.fromCharCode(lo | (hi << 8)); } return s; },
      uid() { const b = new Uint8Array(16); for (let i = 0; i < 16; i++) b[i] = this.byte(); return b; },
    };
  }

  const guard = (r, end) => { if (r.pos > end) throw new Error("overran block"); };
  function readBlock(r, id, end, out) {
    if (id === 1) {
      const v = r.int();
      out.info = { version: v, isInMainQuest: r.byte(), hasBeenInGame: r.byte(), lastDifficulty: r.byte(), greatestDifficulty: r.byte() };
      out.info.iron = r.int(); out.info.greatestCrucible = r.byte(); out.info.tributes = r.int();
    } else if (id === 2) {
      const v = r.int();
      out.bio = { version: v, level: r.int(), experience: r.int(), attributePoints: r.int(), skillPoints: r.int(), devotionPoints: r.int(), totalDevotion: r.int(),
        physique: r.float(), cunning: r.float(), spirit: r.float(), health: r.float(), energy: r.float() };
    } else if (id === 3) {
      // Inventory. Bags are nested blocks, so this block can't be skipped byte by byte.
      // Item layout depends on the block version: newer saves (v11 seen in game 1.3) carry
      // four extra numbers per item. Try the layouts and keep the one that lands exactly on the block end.
      const v = r.int(); const has = r.byte();
      if (!has) return;
      const sacks = r.int(); r.int(); r.int();
      if (sacks > 100) throw new Error("bad sack count");
      for (let i = 0; i < sacks; i++) { r.int(); const len = r.next(); r.skipTo(r.pos + len); r.next(); }
      const afterBags = r.snap();
      const layouts = v >= 11 ? [4, 0] : [0, 4];
      let lastErr;
      for (const extra of layouts) {
        r.restore(afterBags);
        try {
          const item = () => {
            const it = { base: r.str(), prefix: r.str(), suffix: r.str(), modifier: r.str(), transmute: r.str() };
            it.seed = r.int(); it.relic = r.str(); it.relicBonus = r.str(); r.int(); it.augment = r.str(); r.int(); r.int(); it.relicLevel = r.int();
            for (let k = 0; k < extra; k++) r.int();
            it.stack = r.int(); it.attached = r.byte(); return it;
          };
          const useAlt = r.byte(); const equipment = [];
          for (let i = 0; i < 12; i++) { guard(r, end); equipment.push(item()); }
          const sets = [];
          for (let s = 0; s < 2; s++) { r.byte(); sets.push([item(), item()]); }
          if (r.pos !== end) throw new Error("item layout mismatch");
          out.gear = { version: v, useAlt: !!useAlt, equipment, weapons: sets };
          return;
        } catch (e) { lastErr = e; }
      }
      r.restore(afterBags); r.skipTo(end); // equipment has no nested blocks, so this skip is safe
      (out.warnings = out.warnings || []).push("block 3: gear not read (" + lastErr.message + ")");
    } else if (id === 4) {
      // Personal stash: from version 6 its pages are nested blocks, which must be stepped over one by one.
      const v = r.int();
      if (v >= 6) { const pages = r.int(); if (pages > 100) throw new Error("bad stash page count"); for (let i = 0; i < pages; i++) { r.int(); const len = r.next(); r.skipTo(r.pos + len); r.next(); } }
      r.skipTo(end);
    } else if (id === 8) {
      const v = r.int(); const n = r.int(); if (n > 2000) throw new Error("bad skill count");
      const skills = [];
      for (let i = 0; i < n; i++) {
        guard(r, end);
        const s = { name: r.str(), level: r.int(), enabled: r.byte(), devotionLevel: r.int(), devotionExp: r.int(), sublevel: r.int(), active: r.byte(), transition: r.byte() };
        if (v >= 8) r.byte(); // newer saves add one more flag per skill
        r.str(); r.str(); skills.push(s);
      }
      out.skills = { version: v, list: skills, masteriesAllowed: r.int() };
    } else if (id === 16) {
      const v = r.int(), st = { version: v };
      st.playTime = r.int(); st.deaths = r.int();
      out.stats = st; // deaths first, so death detection survives a layout change further down
      ["kills","xpFromKills","healthPotions","energyPotions","maxLevel","hitsReceived","hitsInflicted","critsInflicted","critsReceived"].forEach(k => st[k] = r.int());
      st.greatestDamageDone = r.float();
      st.perDifficulty = [];
      for (let d = 0; d < 3; d++) { guard(r, end); st.perDifficulty.push({ greatestMonster: r.str(), greatestMonsterLevel: r.int(), greatestMonsterLife: r.int(), lastMonsterHit: r.str(), lastMonsterHitBy: r.str() }); }
      st.championKills = r.int(); r.float(); r.float(); st.greatestDamageReceived = r.float();
      ["heroKills","itemsCrafted","relicsCrafted","transcendentRelicsCrafted","mythicalRelicsCrafted","shrinesRestored","oneShotChests","loreNotes"].forEach(k => st[k] = r.int());
      st.bossKills = [r.int(), r.int(), r.int()];
      st.crucibleWave = r.int(); st.crucibleScore = r.int(); r.int(); r.int();
      st.complete = true;
      const s2 = r.snap();
      try { // optional newer fields
        if (v >= 11) { const n = r.int(); if (n > 5000) throw 0; for (let i = 0; i < n; i++) { guard(r, end); r.str(); r.int(); } st.souls = r.int(); st.essence = r.int(); r.byte(); }
        guard(r, end); if (r.pos + 8 <= end) { st.uniqueItems = r.int(); st.randomizedItems = r.int(); }
        guard(r, end);
      } catch (e) { r.restore(s2); delete st.uniqueItems; delete st.randomizedItems; delete st.souls; delete st.essence; }
    } else if (id === 17) {
      out.shrineVersion = r.int();
      out.shrineLists = [];
      for (let i = 0; i < 6; i++) {
        const n = r.int();
        if (n > 5000) throw new Error("bad shrine list size " + n);
        const list = [];
        for (let j = 0; j < n; j++) list.push(r.uid());
        out.shrineLists.push(list);
      }
    }
  }


  /* class names (from Grimtools' game text) */
  const CLASS = {"01":"Soldier","0102":"Commando","0103":"Witchblade","0104":"Blademaster","0105":"Battlemage","0106":"Warder","0107":"Tactician","0108":"Death Knight","0109":"Warlord","0110":"Thane","02":"Demolitionist","0203":"Pyromancer","0204":"Saboteur","0205":"[ms]Sorcerer[fs]Sorceress","0206":"Elementalist","0207":"Purifier","0208":"Defiler","0209":"Shieldbreaker","0210":"Dreadnaught","03":"Occultist","0304":"Witch Hunter","0305":"Warlock","0306":"Conjurer","0307":"Deceiver","0308":"Cabalist","0309":"Sentinel","0310":"Mystic","04":"Nightblade","0405":"Spellbreaker","0406":"Trickster","0407":"Infiltrator","0408":"Reaper","0409":"Dervish","0410":"Reaver","05":"Arcanist","0506":"Druid","0507":"Mage Hunter","0508":"Spellbinder","0509":"Templar","0510":"Evoker","06":"Shaman","0607":"Vindicator","0608":"Ritualist","0609":"Archon","0610":"Primalist","07":"Inquisitor","0708":"Apostate","0709":"Paladin","0710":"Runekeeper","08":"Necromancer","0809":"Oppressor","0810":"Veilwalker","09":"Oathkeeper","0910":"Zealot","10":"Berserker"};
  const pickSex = (s, male) => { const m = s.match(/\[ms\](.*?)\[fs\](.*)/); return m ? (male ? m[1] : m[2]) : s; };
  function classInfo(save) {
    const masteries = [];
    ((save.skills && save.skills.list) || []).forEach(s => {
      const m = s.name.match(/playerclass(\d+)\/_classtraining_class\d+\.dbr$/i);
      if (m) { const id = m[1].padStart(2, "0"); masteries.push({ id, name: CLASS[id] || "Mastery " + id, level: s.level }); }
    });
    masteries.sort((a, b) => a.id.localeCompare(b.id));
    let key = masteries.map(m => m.id).join("");
    let name = CLASS[key];
    if (!name) { const d = (save.tag || "").match(/(\d{2,4})$/); if (d && CLASS[d[1]]) name = CLASS[d[1]]; }
    return { className: name ? pickSex(name, save.male) : "", masteries };
  }
  const DIFF = ["Normal", "Elite", "Ultimate"];
  const slim = it => it && it.base ? { base: it.base, prefix: it.prefix, suffix: it.suffix, relic: it.relic, relicBonus: it.relicBonus, augment: it.augment, modifier: it.modifier, transmute: it.transmute } : null;
  /* plain snapshot of everything worth showing */
  function snapshot(save) {
    const ci = classInfo(save), b = save.bio || {}, i = save.info || {}, s = save.stats || {};
    return {
      className: ci.className, masteries: ci.masteries,
      level: b.level || save.level, experience: b.experience,
      physique: b.physique, cunning: b.cunning, spirit: b.spirit, health: b.health, energy: b.energy,
      unspentAttributes: b.attributePoints, unspentSkills: b.skillPoints, devotionUnlocked: b.totalDevotion, unspentDevotion: b.devotionPoints,
      iron: i.iron, tributes: i.tributes, lastDifficulty: DIFF[i.lastDifficulty], greatestDifficulty: i.greatestDifficulty,
      stats: s.version != null ? Object.assign({}, s) : null,
      gear: save.gear ? { useAlt: save.gear.useAlt, equipment: save.gear.equipment.map(slim), weapons: save.gear.weapons.map(w => w.map(slim)) } : null,
      readAt: Date.now(),
    };
  }

  function parse(buf) {
    const r = Reader(buf);
    r.init();
    if (r.int() !== MAGIC) throw new Error("not a Grim Dawn character file");
    const headerVersion = r.int();
    const out = { headerVersion, blocks: [] };
    out.name = r.wstr();
    out.male = r.byte();
    out.tag = r.str();
    out.level = r.int();
    out.hardcore = !!r.byte();
    if (headerVersion >= 2) out.expansionByte = r.byte();
    r.next(); // header checksum
    out.dataVersion = r.int();
    r.uid(); // character id

    while (r.pos < r.len) {
      const id = r.int();
      const blen = r.next();
      const end = r.pos + blen;
      if (end > r.len) throw new Error("block " + id + " runs past end of file");
      out.blocks.push(id);
      const snap = r.snap();
      try {
        readBlock(r, id, end, out);
        if (r.pos > end) throw new Error("overran block");
      } catch (e) {
        // couldn't make sense of this block (new game version?): rewind and skip it
        r.restore(snap);
        (out.warnings = out.warnings || []).push("block " + id + ": " + e.message);
      }
      r.skipTo(end);
      r.next(); // block checksum
    }
    return out;
  }

  /* --- turning UIDs into shrine ids --- */
  const hex = b => Array.from(b, x => x.toString(16).padStart(2, "0")).join("").toUpperCase();
  const hexWords = b => { let s = ""; for (let i = 0; i < 16; i += 4) for (let j = 3; j >= 0; j--) s += b[i + j].toString(16).padStart(2, "0"); return s.toUpperCase(); };
  const ENCODINGS = { bytes: hex, words: hexWords };

  // Possible ways the six lists are laid out: [restored N,E,U] and [found N,E,U]
  const LAYOUTS = {
    A: { restored: [0, 1, 2], found: [3, 4, 5] },
    B: { restored: [3, 4, 5], found: [0, 1, 2] },
    C: { restored: [1, 3, 5], found: [0, 2, 4] },
    D: { restored: [0, 2, 4], found: [1, 3, 5] },
  };

  /* known: Map(uidHex -> shrineId). Returns per-difficulty restored/found arrays of shrine ids. */
  function resolve(save, known, forceLayout) {
    const restoredStat = save.stats && save.stats.complete ? save.stats.shrinesRestored : null;
    const lists = save.shrineLists || [[], [], [], [], [], []];
    let enc = "bytes", best = -1;
    for (const [name, fn] of Object.entries(ENCODINGS)) {
      let n = 0; lists.forEach(l => l.forEach(u => { if (known.has(fn(u))) n++; }));
      if (n > best) { best = n; enc = name; }
    }
    const fn = ENCODINGS[enc];
    let total = 0, unknown = 0;
    const sets = lists.map(l => {
      const s = new Set();
      l.forEach(u => { total++; const id = known.get(fn(u)); if (id != null) s.add(id); else unknown++; });
      return s;
    });
    // pick the layout where "restored" is always inside "found" (fewest violations)
    // Real saves (game 1.3) pair the lists by difficulty. Score each layout: "restored" must sit inside
    // "found", and the restored total should match the save's own shrines-restored counter.
    let layout = forceLayout && LAYOUTS[forceLayout] ? forceLayout : null, scores = {};
    for (const [k, L] of Object.entries(LAYOUTS)) {
      let bad = 0, total = 0;
      for (let d = 0; d < 3; d++) { sets[L.restored[d]].forEach(id => { if (!sets[L.found[d]].has(id)) bad++; }); total += lists[L.restored[d]].length; }
      scores[k] = bad * 1000 + (restoredStat != null ? Math.abs(total - restoredStat) : 0);
    }
    if (!layout) layout = ["D", "C", "A", "B"].reduce((a, b) => scores[b] < scores[a] ? b : a, "D");
    const L = LAYOUTS[layout];
    const D = ["normal", "elite", "ultimate"];
    const restored = {}, found = {};
    D.forEach((d, i) => { restored[d] = [...sets[L.restored[i]]]; found[d] = [...sets[L.found[i]]]; });
    return { encoding: enc, layout, layoutScores: scores, restored, found, listSizes: lists.map(l => l.length), total, unknown };
  }

  return { parse, resolve, classInfo, snapshot, hex, hexWords, LAYOUTS, CLASS };
})();
if (typeof module !== "undefined") module.exports = GDSave;
