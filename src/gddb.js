/* ===== Grim Dawn game data reader =====
   Reads item names straight from the player's own game install:
   database/*.arz (item records) and resources/Text_EN.arc (English text).
   Files are read in slices, so the big database never has to be loaded whole. */
const GDDB = (() => {
  /* ---- LZ4 block decompression ---- */
  function lz4(src, outSize) {
    const out = new Uint8Array(outSize);
    let ip = 0, op = 0;
    while (ip < src.length) {
      const token = src[ip++];
      let lit = token >> 4;
      if (lit === 15) { let b; do { b = src[ip++]; lit += b; } while (b === 255); }
      if (op + lit > outSize || ip + lit > src.length) throw new Error("lz4: literal overrun");
      out.set(src.subarray(ip, ip + lit), op); ip += lit; op += lit;
      if (ip >= src.length) break; // last sequence has no match
      const off = src[ip] | (src[ip + 1] << 8); ip += 2;
      if (off === 0 || off > op) throw new Error("lz4: bad offset");
      let len = token & 15;
      if (len === 15) { let b; do { b = src[ip++]; len += b; } while (b === 255); }
      len += 4;
      if (op + len > outSize) throw new Error("lz4: match overrun");
      for (let i = 0; i < len; i++, op++) out[op] = out[op - off];
    }
    if (op !== outSize) throw new Error("lz4: size mismatch");
    return out;
  }

  const ascii = (u8, a, b) => { let s = ""; for (let i = a; i < b; i++) s += String.fromCharCode(u8[i]); return s; };
  const slice = async (file, a, n) => new Uint8Array(await file.slice(a, a + n).arrayBuffer());

  /* ---- ARZ database ---- */
  async function openArz(file) {
    const h = new DataView((await slice(file, 0, 24)).buffer);
    const hdr = { recStart: h.getInt32(4, true), recSize: h.getInt32(8, true), recCount: h.getInt32(12, true), strStart: h.getInt32(16, true), strSize: h.getInt32(20, true) };
    if (hdr.recStart <= 0 || hdr.strStart <= 0 || hdr.recCount <= 0 || hdr.strStart + hdr.strSize > file.size) throw new Error(file.name + " doesn't look like a Grim Dawn database");
    // string table
    const sb = await slice(file, hdr.strStart, hdr.strSize);
    const sv = new DataView(sb.buffer);
    const n = sv.getInt32(0, true); const strings = new Array(n); let p = 4;
    for (let i = 0; i < n; i++) { const l = sv.getInt32(p, true); p += 4; strings[i] = ascii(sb, p, p + l); p += l; }
    // record table
    const rb = await slice(file, hdr.recStart, hdr.recSize);
    const rv = new DataView(rb.buffer); const index = new Map(); p = 0;
    for (let i = 0; i < hdr.recCount; i++) {
      const name = strings[rv.getInt32(p, true)]; p += 4;
      const tl = rv.getInt32(p, true); p += 4 + tl;
      const off = rv.getInt32(p, true), csize = rv.getInt32(p + 4, true), dsize = rv.getInt32(p + 8, true); p += 20;
      index.set(name.toLowerCase().replace(/\\/g, "/"), { off, csize, dsize });
    }
    async function record(path) {
      const e = index.get(path.toLowerCase().replace(/\\/g, "/"));
      if (!e) return null;
      const data = lz4(await slice(file, e.off + 24, e.csize), e.dsize);
      const dv = new DataView(data.buffer); const rec = {}; let q = 0;
      while (q + 8 <= data.length) {
        const type = dv.getUint16(q, true), count = dv.getUint16(q + 2, true), key = strings[dv.getInt32(q + 4, true)]; q += 8;
        const vals = [];
        for (let i = 0; i < count; i++, q += 4) vals.push(type === 1 ? dv.getFloat32(q, true) : type === 2 ? strings[dv.getInt32(q, true)] : dv.getInt32(q, true));
        rec[key] = count === 1 ? vals[0] : vals;
      }
      return rec;
    }
    return { name: file.name, count: hdr.recCount, record, has: p => index.has(p.toLowerCase()) };
  }

  /* ---- ARC archive (text) ---- */
  async function openArc(file) {
    const h = new DataView((await slice(file, 0, 28)).buffer);
    if (h.getUint32(0, true) !== 0x435241 || h.getUint32(4, true) !== 3) throw new Error(file.name + " isn't a supported archive");
    const files = h.getInt32(8, true), recTableSize = h.getInt32(16, true), strTableSize = h.getInt32(20, true), recTableOff = h.getInt32(24, true);
    const tail = await slice(file, recTableOff, recTableSize + strTableSize + files * 44);
    const tv = new DataView(tail.buffer);
    const entries = [];
    for (let i = 0; i < files; i++) {
      const b = recTableSize + strTableSize + i * 44;
      const e = { type: tv.getInt32(b, true), off: tv.getInt32(b + 4, true), csize: tv.getInt32(b + 8, true), dsize: tv.getInt32(b + 12, true),
        parts: tv.getInt32(b + 28, true), firstPart: tv.getInt32(b + 32, true), nameLen: tv.getInt32(b + 36, true), nameOff: tv.getInt32(b + 40, true) };
      e.name = ascii(tail, recTableSize + e.nameOff, recTableSize + e.nameOff + e.nameLen);
      entries.push(e);
    }
    async function read(e) {
      if (e.type === 1 && e.csize === e.dsize) return slice(file, e.off, e.csize);
      const chunks = []; let total = 0;
      for (let i = 0; i < e.parts; i++) {
        const pb = (e.firstPart + i) * 12;
        const off = tv.getInt32(pb, true), cs = tv.getInt32(pb + 4, true), ds = tv.getInt32(pb + 8, true);
        const raw = await slice(file, off, cs);
        const part = cs === ds ? raw : lz4(raw, ds);
        chunks.push(part); total += part.length;
      }
      const out = new Uint8Array(total); let o = 0; chunks.forEach(c => { out.set(c, o); o += c.length; });
      return out;
    }
    // one compressed part of an entry (parts are ~256 KB), so a huge file can be read from the start
    async function readPart(e, i) {
      const pb = (e.firstPart + i) * 12;
      const off = tv.getInt32(pb, true), cs = tv.getInt32(pb + 4, true), ds = tv.getInt32(pb + 8, true);
      const raw = await slice(file, off, cs);
      return cs === ds ? raw : lz4(raw, ds);
    }
    return { name: file.name, entries, read, readPart };
  }

  function decodeText(u8) {
    if (u8[0] === 0xff && u8[1] === 0xfe) return new TextDecoder("utf-16le").decode(u8.subarray(2));
    if (u8[0] === 0xef && u8[1] === 0xbb && u8[2] === 0xbf) u8 = u8.subarray(3);
    return new TextDecoder("utf-8").decode(u8);
  }
  async function loadText(arc, into) {
    for (const e of arc.entries) {
      if (!/\.txt$/i.test(e.name)) continue;
      decodeText(await arc.read(e)).split(/\r?\n/).forEach(line => {
        const i = line.indexOf("="); if (i <= 0 || line.startsWith("#")) return;
        into.set(line.slice(0, i).trim(), line.slice(i + 1).trim());
      });
    }
    return into;
  }


  /* ---- turning record fields into tooltip-style stat lines ---- */
  const DMG = { Physical: "Physical", Pierce: "Pierce", Fire: "Fire", Cold: "Cold", Lightning: "Lightning", Poison: "Acid", Life: "Vitality", Aether: "Aether", Chaos: "Chaos",
    Elemental: "Elemental", Bleeding: "Bleeding", Disruption: "Skill Disruption", Total: "All", TotalDamage: "All", Manaburn: "Energy Drain", LifeLeech: "Life Leech", ManaLeech: "Energy Leech",
    PercentCurrentLife: "Current Life", Knockdown: "Knockdown", Stun: "Stun", Freeze: "Freeze", Petrify: "Petrify", Trap: "Entrapment", Confusion: "Confusion", Fear: "Fear", Sleep: "Sleep",
    Convert: "Mind Control", Fumble: "Reduced Target's Attack Accuracy", ProjectileFumble: "Reduced Target's Projectile Accuracy", Taunt: "Taunt", SlowAttackSpeed: "Attack Speed Slow", RunSpeed: "Slow" };
  const DOT = { Physical: "Internal Trauma", Fire: "Burn", Cold: "Frostburn", Lightning: "Electrocute", Poison: "Poison", Life: "Vitality Decay", Bleeding: "Bleeding", Aether: "Aether Decay", Chaos: "Chaos Decay" };
  const CC = new Set(["Stun", "Freeze", "Petrify", "Trap", "Confusion", "Fear", "Sleep", "Convert", "Knockdown"]);
  const PCTFX = new Set(["Fumble", "ProjectileFumble", "SlowAttackSpeed", "RunSpeed", "TotalSpeed"]);
  const CHAR = { Strength: ["Physique"], Dexterity: ["Cunning"], Intelligence: ["Spirit"], Life: ["Health"], Mana: ["Energy"], OffensiveAbility: ["Offensive Ability"], DefensiveAbility: ["Defensive Ability"],
    LifeRegen: ["Health Regenerated per Second"], ManaRegen: ["Energy Regenerated per Second"], AttackSpeed: ["Attack Speed"], SpellCastSpeed: ["Casting Speed"], RunSpeed: ["Movement Speed"], TotalSpeed: ["Total Speed"],
    DodgePercent: ["Chance to Avoid Melee Attacks", "%"], DeflectProjectile: ["Chance to Avoid Projectiles", "%"], IncreasedExperience: ["Experience Gained", "%"], EnergyAbsorptionPercent: ["Energy Absorbed from Enemy Spells", "%"],
    Constitution: ["Constitution"] };
  const n = v => { const x = Array.isArray(v) ? v[0] : v; return typeof x === "number" ? x : 0; };
  const num = v => { const r = Math.round(v * 10) / 10; return (Math.abs(r) >= 1000 ? r.toLocaleString() : String(r)); };
  const plus = v => (v > 0 ? "+" : "") + num(v);
  const words = k => k.replace(/([a-z])([A-Z])/g, "$1 $2").replace(/^./, c => c.toUpperCase());
  const META = /^(Class|templateName|FileDescription|bitmap|artifactBitmap|itemNameTag|itemQualityTag|itemStyleTag|itemClassification|itemLevel|levelRequirement|description|itemText|itemSetName|lootRandomizerName|dropSound|dropSound3D|dropSoundWater|itemCost.*|maxStackSize|actorHeight|actorRadius|scale|castsShadows|mesh|baseTexture|bumpTexture|glowTexture|specTexture|shader|cannotPickUp.*|hidePrefixName|hideSuffixName|quest|marketAdjustmentPercent|numRelicSlots|attributeScalePercent|.*Requirement|.*Equation|itemSkillAutoController|itemSkillLevel|petBonusName|augmentSkillLevel\d+|augmentMasteryLevel\d+|conversionOutType|conversionPercentage.*|racialBonusPercent.*|characterBaseAttackSpeed|characterBaseAttackSpeedTag|offensiveGlobalChance|.*Jitter|.*XOR|randomizerName|lootRandomizerJitter|completedRelicLevel|relicBonus.*|.*Sound.*|.*Fx.*|.*Effect.*)$/;

  function statLines(rec, t) {
    if (!rec) return [];
    const L = [], used = new Set(), g = k => n(rec[k]), mark = (...ks) => ks.forEach(k => used.add(k));
    const chanceOf = (k, s) => { const c = g(k); mark(k); return c && c < 100 ? `${num(c)}% Chance of ${s}` : s; };
    // armour, block, weapon damage first
    if (g("defensiveProtection")) { L.push(`${num(g("defensiveProtection"))} Armor`); mark("defensiveProtection"); }
    if (g("defensiveBlock")) { L.push(`${num(g("defensiveBlockChance"))}% Chance to Block ${num(g("defensiveBlock"))} Damage`); mark("defensiveBlock", "defensiveBlockChance"); }
    if (g("blockRecoveryTime")) { L.push(`${num(g("blockRecoveryTime"))} Second Shield Recovery`); mark("blockRecoveryTime"); }
    for (const key of Object.keys(rec)) {
      if (used.has(key) || META.test(key) || !g(key) && typeof rec[key] !== "string") continue;
      let m;
      if ((m = key.match(/^(offensive|retaliation)Slow(\w+?)(Min|Max|DurationMin|DurationMax|Modifier|DurationModifier|Chance|ModifierChance)$/))) {
        const [, kind, T] = m, P = kind + "Slow" + T, name = DOT[T] || words(T);
        if (m[3] === "Min" || m[3] === "DurationMin") {
          const per = g(P + "Min"), dur = g(P + "DurationMin"), mx = g(P + "Max");
          if (per) { const tot = per * (dur || 1), totMax = mx > per ? mx * (dur || 1) : 0; L.push(chanceOf(P + "Chance", `${num(tot)}${totMax ? "-" + num(totMax) : ""} ${name}${DOT[T] ? " Damage" : ""}${dur ? ` over ${num(dur)} Seconds` : ""}${kind === "retaliation" ? " Retaliation" : ""}`)); }
          mark(P + "Min", P + "Max", P + "DurationMin", P + "DurationMax");
        } else if (m[3] === "Modifier") { L.push(chanceOf(P + "ModifierChance", `${plus(g(key))}% ${name}${DOT[T] ? " Damage" : ""}${kind === "retaliation" ? " Retaliation" : ""}`)); mark(key); }
        else if (m[3] === "DurationModifier") { L.push(`${plus(g(key))}% ${name} Duration`); mark(key); }
        continue;
      }
      if ((m = key.match(/^(offensive|retaliation)(\w+?)(Min|Max|Modifier|Chance|ModifierChance|DurationMin|DurationModifier)$/)) && (DMG[m[2]] || m[2])) {
        const [, kind, T] = m, P = kind + T, name = DMG[T] || words(T), ret = kind === "retaliation" ? " Retaliation" : "";
        if (m[3] === "Min" || m[3] === "Max") {
          const lo = g(P + "Min"), hi = g(P + "Max");
          if (CC.has(T)) L.push(chanceOf(P + "Chance", `${num(lo)}${hi > lo ? "-" + num(hi) : ""} Second ${name}${ret}`));
          else if (PCTFX.has(T)) { const dur = g(P + "DurationMin"); mark(P + "DurationMin", P + "DurationMax"); L.push(chanceOf(P + "Chance", `${num(lo)}% ${name}${dur ? ` for ${num(dur)} Seconds` : ""}${ret}`)); }
          else if (T === "PercentCurrentLife") L.push(chanceOf(P + "Chance", `${num(lo)}% Reduction to Enemy's Health${ret}`));
          else L.push(chanceOf(P + "Chance", `${num(lo)}${hi > lo ? "-" + num(hi) : ""} ${name} Damage${ret}`));
          mark(P + "Min", P + "Max");
        } else if (m[3] === "Modifier") { L.push(chanceOf(P + "ModifierChance", `${plus(g(key))}% ${T === "Total" || T === "TotalDamage" ? "to All Damage" : name + (ret || (/Damage$/.test(name) ? "" : " Damage"))}`)); mark(key); }
        else if (m[3] === "DurationModifier") { L.push(`${plus(g(key))}% ${name} Duration`); mark(key); }
        else if (m[3] === "Chance" && !rec[P + "Min"]) { L.push(`${num(g(key))}% Chance of ${name}${ret}`); mark(key); }
        continue;
      }
      if ((m = key.match(/^defensive(\w+?)(MaxResist|Modifier|Duration|DurationChance)?$/))) {
        const T = m[1], name = DMG[T] || words(T);
        const resName = name.replace(/ ?Resistance$/, "");
        if (T === "Protection" && m[2] === "Modifier") L.push(`${plus(g(key))}% Armor`);
        else if (T === "BlockAmount" || T === "Block") L.push(`${plus(g(key))}% Shield Block Amount`);
        else if (T === "BlockChance") L.push(`${plus(g(key))}% Shield Block Chance`);
        else if (T === "Absorption") L.push(`${plus(g(key))}% Armor Absorption`);
        else if (T === "TotalSpeedResistance") L.push(`${num(g(key))}% Slow Resistance`);
        else if (T === "Reflect") L.push(`${num(g(key))}% Damage Reflected`);
        else if (m[2] === "MaxResist") L.push(`${plus(g(key))}% Maximum ${resName} Resistance`);
        else if (m[2] === "Modifier" || !m[2]) {
          if (CC.has(T) || T === "Disruption") L.push(`${num(g(key))}% Reduced ${name} Duration`);
          else L.push(`${plus(g(key))}% ${resName} Resistance`);
        } else L.push(`${words(key.replace(/^defensive/, ""))}: ${num(g(key))}`);
        mark(key); continue;
      }
      if ((m = key.match(/^character(\w+?)(Modifier)?$/))) {
        const base = m[1].replace(/Modifier$/, ""), def = CHAR[base] || CHAR[m[1]];
        const pct = !!m[2] || /Speed$/.test(base) || (def && def[1] === "%");
        let label = def ? def[0] : words(base);
        if (m[2] && base === "LifeRegen") label = "Health Regeneration";
        if (m[2] && base === "ManaRegen") label = "Energy Regeneration";
        L.push(`${plus(g(key))}${pct ? "%" : ""} ${label}`); mark(key); continue;
      }
      if (key === "skillCooldownReduction") { L.push(`-${num(g(key))}% Skill Cooldown Reduction`); mark(key); continue; }
      if (key === "skillManaCostReduction") { L.push(`-${num(g(key))}% Skill Energy Cost`); mark(key); continue; }
      if (key === "augmentAllLevel") { L.push(`${plus(g(key))} to all Skills`); mark(key); continue; }
      if (/^(offensive|defensive|retaliation|character|skill|pet|racial)/.test(key) && typeof rec[key] !== "string") { L.push(`${words(key)}: ${num(g(key))}`); mark(key); }
    }
    return L;
  }
  // stats that point at other records (skills, masteries, pet bonuses, conversions)
  async function linkedLines(rec, rec_, t) {
    const L = [];
    if (!rec) return L;
    const skillName = async p => { const s = await rec_(p); return s ? (t(s.skillDisplayName) || t(s.buffSkillName && (await rec_(s.buffSkillName) || {}).skillDisplayName) || p.split("/").pop()) : p.split("/").pop(); };
    for (let i = 1; i <= 4; i++) {
      const mp = rec["augmentMasteryName" + i]; if (mp) L.push(`${plus(n(rec["augmentMasteryLevel" + i]))} to all skills in ${await skillName(mp)}`);
      const sp = rec["augmentSkillName" + i]; if (sp) L.push(`${plus(n(rec["augmentSkillLevel" + i]))} to ${await skillName(sp)}`);
    }
    if (rec.itemSkillName) L.push(`Grants skill: ${await skillName(rec.itemSkillName)}${n(rec.itemSkillLevel) > 1 ? " (level " + num(n(rec.itemSkillLevel)) + ")" : ""}`);
    for (let i = 1; i <= 3; i++) { const ms = rec["modifiedSkillName" + i]; if (ms) L.push(`Modifies ${await skillName(ms)}`); }
    if (rec.conversionInType && rec.conversionOutType) L.push(`${num(n(rec.conversionPercentage))}% ${DMG[rec.conversionInType] || rec.conversionInType} Damage converted to ${DMG[rec.conversionOutType] || rec.conversionOutType} Damage`);
    if (rec.racialBonusRace) { const race = [].concat(rec.racialBonusRace).map(r => t("tag" + r) || t(r) || String(r)).filter(Boolean).join(", "); if (n(rec.racialBonusPercentDamage)) L.push(`${plus(n(rec.racialBonusPercentDamage))}% Damage to ${race}`); if (n(rec.racialBonusPercentDefense)) L.push(`${num(n(rec.racialBonusPercentDefense))}% Less Damage from ${race}`); }
    if (rec.petBonusName) { const pb = await rec_(rec.petBonusName); const pl = statLines(pb, t); if (pl.length) L.push("Bonus to all pets: " + pl.join(", ")); }
    return L;
  }

  /* ---- game folder ---- */
  const clean = s => (s || "").replace(/\^[a-zA-Z]/g, "").replace(/\{\^[a-zA-Z]\}/g, "").trim();
  const genderize = s => { const m = s.match(/\[ms\](.*?)\[fs\](.*)/); return m ? m[1] : s; };

  /* files: array of {path, file}. Expansion databases override the base game. */
  async function openGame(files) {
    // skip mods and backups; base game first, then Crucible, then expansions in order (later ones override)
    const byPath = p => files.filter(f => { const q = f.path.replace(/\\/g, "/"); return p.test(q) && !/(^|\/)(mods|save|settings)\//i.test(q); });
    const order = f => { const m = f.path.match(/gdx(\d+)/i); if (m) return 10 + +m[1]; return /survivalmode/i.test(f.path) ? 1 : 0; };
    const arzFiles = byPath(/(^|\/)database\/[^/]+\.arz$/i).sort((a, b) => order(a) - order(b));
    const textFiles = byPath(/(^|\/)resources\/text_en\.arc$/i).sort((a, b) => order(a) - order(b));
    if (!arzFiles.length) throw new Error("No game database found. Pick your Grim Dawn install folder (the one with Grim Dawn.exe).");
    const dbs = []; for (const f of arzFiles) dbs.push(await openArz(f.file));
    const text = new Map(); for (const f of textFiles) await loadText(await openArc(f.file), text);
    const t = tag => tag ? genderize(clean(text.get(tag) || "")) : "";
    const cache = new Map();
    async function rec(path) {
      if (!path) return null;
      const k = path.toLowerCase();
      if (cache.has(k)) return cache.get(k);
      let r = null; for (let i = dbs.length - 1; i >= 0 && !r; i--) r = await dbs[i].record(path);
      cache.set(k, r); return r;
    }
    async function describe(item) {
      const base = await rec(item.base);
      if (!base) return { known: false };
      const baseName = t(base.itemNameTag) || t(base.description) || clean(base.description || "");
      const quality = t(base.itemQualityTag) || t(base.itemStyleTag);
      const isSet = !!base.itemSetName;
      let prefix = "", suffix = "";
      if (!isSet && !/Legendary|Epic/i.test(base.itemClassification || "")) {
        const pr = await rec(item.prefix), su = await rec(item.suffix);
        prefix = pr ? t(pr.lootRandomizerName) : ""; suffix = su ? t(su.lootRandomizerName) : "";
      }
      const relic = item.relic ? await rec(item.relic) : null;
      const aug = item.augment ? await rec(item.augment) : null;
      const sections = [];
      const add = async (title, r) => { if (!r) return; const lines = statLines(r, t).concat(await linkedLines(r, rec, t)); if (lines.length) sections.push({ title, lines }); };
      await add("", base);
      if (!isSet && !/Legendary|Epic/i.test(base.itemClassification || "")) { await add(prefix ? "Prefix: " + prefix : "", await rec(item.prefix)); await add(suffix ? "Suffix: " + suffix : "", await rec(item.suffix)); }
      if (relic) await add("Component: " + (t(relic.description) || clean(relic.description || "")), relic);
      if (item.relicBonus) await add("Completion bonus", await rec(item.relicBonus));
      if (aug) await add("Augment: " + (t(aug.description) || clean(aug.description || "")), aug);
      return {
        known: true, sections, wiki: baseName,
        speed: /^Weapon/.test(base.Class || "") && base.characterBaseAttackSpeedTag ? (t(base.characterBaseAttackSpeedTag) || words(String(base.characterBaseAttackSpeedTag).replace(/^CharacterAttackSpeed/, ""))).replace(/^Speed:\s*/, "").trim() : "",
        flavor: t(base.itemText),
        name: [prefix, quality, baseName, suffix].filter(Boolean).join(" ") || item.base.split("/").pop(),
        rarity: base.itemClassification || "", level: base.itemLevel || null, req: base.levelRequirement || null,
        cls: base.Class || "", bitmap: base.bitmap || base.artifactBitmap || "",
        set: base.itemSetName ? t((await rec(base.itemSetName) || {}).setName) : "",
        component: relic ? (t(relic.description) || clean(relic.description || "")) : "",
        augment: aug ? (t(aug.description) || clean(aug.description || "")) : "",
      };
    }
    return { describe, text: t, dbs: dbs.map(d => d.name + " (" + d.count.toLocaleString() + " records)"), textCount: text.size };
  }

  return { lz4, openArz, openArc, openGame, statLines };
})();
if (typeof module !== "undefined") module.exports = GDDB;
