const GDDB = require("../src/gddb.js"), GDSave = require("../src/gdsave.js"), assert = require("assert");

// --- small LZ4 block compressor (greedy) so tests exercise real matches ---
function lz4c(src) {
  const out = [], n = src.length, H = new Map(); let anchor = 0, i = 0;
  const putLen = l => { while (l >= 255) { out.push(255); l -= 255; } out.push(l); };
  const emit = (litEnd, mlen, off) => {
    const lit = litEnd - anchor; const tok = (Math.min(lit, 15) << 4) | (mlen == null ? 0 : Math.min(mlen - 4, 15));
    out.push(tok); if (lit >= 15) putLen(lit - 15);
    for (let k = anchor; k < litEnd; k++) out.push(src[k]);
    if (mlen != null) { out.push(off & 255, off >> 8); if (mlen - 4 >= 15) putLen(mlen - 4 - 15); }
  };
  while (i + 12 < n) {
    const key = src[i] | (src[i + 1] << 8) | (src[i + 2] << 16) | (src[i + 3] << 24);
    const cand = H.get(key); H.set(key, i);
    if (cand != null && i - cand < 65535 && src[cand] === src[i] && src[cand + 1] === src[i + 1] && src[cand + 2] === src[i + 2] && src[cand + 3] === src[i + 3]) {
      let m = 4; while (i + m < n - 5 && src[cand + m] === src[i + m]) m++;
      emit(i, m, i - cand); i += m; anchor = i;
    } else i++;
  }
  emit(n, null);
  return Uint8Array.from(out);
}
// round trips, including long runs and overlapping matches
for (const s of ["", "a", "hello hello hello hello hello hello world", "x".repeat(5000), "abcabcabcabcabcabcabcabcabcabcabc" + "z".repeat(300) + "abcabcabc"]) {
  const src = new TextEncoder().encode(s), c = lz4c(src);
  assert.equal(new TextDecoder().decode(GDDB.lz4(c, src.length)), s);
}
const rnd = Uint8Array.from({ length: 20000 }, (_, i) => (i * 7919 % 251) ^ (i >> 6));
assert.deepEqual(GDDB.lz4(lz4c(rnd), rnd.length), rnd);
// hand-written LZ4 block: literal "abc", then copy 6 bytes from 3 back -> "abcabcabc"
assert.equal(new TextDecoder().decode(GDDB.lz4(Uint8Array.from([0x32, 97, 98, 99, 3, 0]), 9)), "abcabcabc");
assert.throws(() => GDDB.lz4(Uint8Array.from([0x10, 97, 9, 0]), 10));
console.log("lz4: ok");

// --- fake ARZ ---
function makeArz(records) {
  const strings = [], sidx = new Map(); const S = s => { if (!sidx.has(s)) { sidx.set(s, strings.length); strings.push(s); } return sidx.get(s); };
  const blobs = [], heads = [];
  for (const [name, fields] of Object.entries(records)) {
    const body = [];
    const u16 = v => body.push(v & 255, v >> 8), i32 = v => { const b = new Uint8Array(new Int32Array([v]).buffer); body.push(...b); }, f32 = v => body.push(...new Uint8Array(new Float32Array([v]).buffer));
    for (const [k, v] of Object.entries(fields)) {
      const arr = Array.isArray(v) ? v : [v]; const type = typeof arr[0] === "string" ? 2 : Number.isInteger(arr[0]) ? 0 : 1;
      u16(type); u16(arr.length); i32(S(k)); arr.forEach(x => type === 2 ? i32(S(x)) : type === 0 ? i32(x) : f32(x));
    }
    const raw = Uint8Array.from(body), c = lz4c(raw);
    heads.push({ name: S(name), csize: c.length, dsize: raw.length }); blobs.push(c);
  }
  const parts = []; let off = 0;
  heads.forEach((h, i) => { h.off = off; off += blobs[i].length; });
  const recTable = []; const i32 = (arr, v) => arr.push(...new Uint8Array(new Int32Array([v]).buffer));
  heads.forEach(h => { i32(recTable, h.name); i32(recTable, 8); recTable.push(...new TextEncoder().encode("DBRecord")); i32(recTable, h.off); i32(recTable, h.csize); i32(recTable, h.dsize); i32(recTable, 0); i32(recTable, 0); });
  const strTable = []; i32(strTable, strings.length); strings.forEach(s => { i32(strTable, s.length); strTable.push(...new TextEncoder().encode(s)); });
  const dataLen = off, recStart = 24 + dataLen, strStart = recStart + recTable.length;
  const hdr = []; hdr.push(2, 0, 3, 0); i32(hdr, recStart); i32(hdr, recTable.length); i32(hdr, heads.length); i32(hdr, strStart); i32(hdr, strTable.length);
  return new Blob([Uint8Array.from(hdr), ...blobs, Uint8Array.from(recTable), Uint8Array.from(strTable)]);
}
// --- fake ARC holding text files, split into compressed parts ---
function makeArc(files) {
  const data = [], partsTbl = [], recs = [], names = []; let off = 28, partIndex = 0, nameOff = 0;
  const i32 = (arr, v) => arr.push(...new Uint8Array(new Int32Array([v]).buffer));
  for (const [name, text] of Object.entries(files)) {
    const raw = new TextEncoder().encode("﻿" + text); const half = Math.floor(raw.length / 2); const first = partIndex;
    for (const piece of [raw.subarray(0, half), raw.subarray(half)]) { const c = lz4c(piece); i32(partsTbl, off); i32(partsTbl, c.length); i32(partsTbl, piece.length); data.push(c); off += c.length; partIndex++; }
    recs.push({ name, dsize: raw.length, first, nameOff }); names.push(...new TextEncoder().encode(name), 0); nameOff += name.length + 1;
  }
  const recTableOff = off, rt = []; recs.forEach(r => { i32(rt, 3); i32(rt, 0); i32(rt, 0); i32(rt, r.dsize); i32(rt, 0); i32(rt, 0); i32(rt, 0); i32(rt, 2); i32(rt, r.first); i32(rt, r.name.length); i32(rt, r.nameOff); });
  const hdr = []; i32(hdr, 0x435241); i32(hdr, 3); i32(hdr, recs.length); i32(hdr, partIndex); i32(hdr, partsTbl.length); i32(hdr, names.length); i32(hdr, recTableOff);
  return new Blob([Uint8Array.from(hdr), ...data, Uint8Array.from(partsTbl), Uint8Array.from(names), Uint8Array.from(rt)]);
}

(async () => {
  const base = makeArz({
    "records/items/gearhead/c034_head.dbr": { Class: "ArmorProtective_Head", itemNameTag: "tagHelm34", itemClassification: "Legendary", itemQualityTag: "tagMythical", itemLevel: 94, levelRequirement: 94, bitmap: "items/gearhead/c034.tex", defensiveProtection: 650, characterStrength: 30, defensiveFire: 20, augmentMasteryName1: "records/skills/playerclass01/_classtraining_class01.dbr", augmentMasteryLevel1: 2, petBonusName: "records/items/pets/petbonus01.dbr" },
    "records/items/gearweapons/swords1h/a12_sword.dbr": { Class: "WeaponMelee_Sword", itemNameTag: "tagSword12", itemClassification: "Rare", itemLevel: 60 },
    "records/items/lootaffixes/prefix/b_ar015.dbr": { lootRandomizerName: "tagPrefixVicious", offensivePhysicalModifier: 18 },
    "records/items/lootaffixes/suffix/a028.dbr": { lootRandomizerName: "tagSuffixAlacrity", characterAttackSpeedModifier: 6 },
    "records/skills/playerclass01/blitz1.dbr": { skillDisplayName: "tagSkillBlitz" },
    "records/skills/playerclass01/_classtraining_class01.dbr": { skillDisplayName: "tagMasterySoldier" },
    "records/items/pets/petbonus01.dbr": { characterLifeModifier: 12, defensivePhysical: 5 },
    "records/items/gearrelic/d001_relic.dbr": { Class: "ItemRelic", description: "tagRelicSerenity" },
    "records/items/gearaccessories/rings/set_ring.dbr": { Class: "ArmorJewelry_Ring", itemNameTag: "tagSetRing", itemClassification: "Epic", itemSetName: "records/sets/set_x.dbr", itemLevel: 70 },
    "records/sets/set_x.dbr": { setName: "tagSetX" },
    "records/items/materia/compa_ancientarmorplate.dbr": { description: "tagCompArmorPlate", defensivePhysical: 8, defensiveProtectionModifier: 5 },
  });
  const gdx = makeArz({ "records/items/gearweapons/swords1h/a12_sword.dbr": { Class: "WeaponMelee_Sword", itemNameTag: "tagSword12b", itemClassification: "Rare", itemLevel: 62, offensivePhysicalMin: 90, offensivePhysicalMax: 140, augmentSkillName1: "records/skills/playerclass01/blitz1.dbr", augmentSkillLevel1: 1 } });
  const text = makeArc({ "tags_items.txt": "tagHelm34=Stormheart Helm\ntagMythical=Mythical\ntagSword12=Old Sword\ntagSword12b=Bonesplitter\ntagPrefixVicious=Vicious\ntagSuffixAlacrity=of Alacrity\n# comment\ntagRelicSerenity=^kSerenity\ntagSetRing=Ring of the Voidwalker\ntagSetX=Voidwalker's Regalia\ntagCompArmorPlate=Ancient Armor Plate\ntagSkillBlitz=Blitz\ntagMasterySoldier=Soldier\n", "tags_ui.txt": "tagUnused=x" });
  const files = [
    { path: "Grim Dawn/database/database.arz", file: base },
    { path: "Grim Dawn/gdx2/database/GDX2.arz", file: gdx },
    { path: "Grim Dawn/resources/Text_EN.arc", file: text },
    { path: "Grim Dawn/resources/Items.arc", file: new Blob([new Uint8Array(4)]) },
  ];
  const game = await GDDB.openGame(files);
  assert.equal(game.textCount, 13);
  let d = await game.describe({ base: "records/items/gearhead/c034_head.dbr", prefix: "records/items/lootaffixes/prefix/b_ar015.dbr" });
  assert.equal(d.name, "Mythical Stormheart Helm"); assert.equal(d.rarity, "Legendary"); assert.equal(d.level, 94); // legendaries ignore affixes
  assert.equal(d.wiki, "Stormheart Helm"); assert.equal(d.sections.length, 1);
  assert.deepEqual(d.sections[0].lines, ["650 Armor", "+30 Physique", "+20% Fire Resistance", "+2 to all skills in Soldier", "Bonus to all pets: +12% Health, +5% Physical Resistance"]);
  d = await game.describe({ base: "records/items/gearweapons/swords1h/a12_sword.dbr", prefix: "records/items/lootaffixes/prefix/b_ar015.dbr", suffix: "records/items/lootaffixes/suffix/a028.dbr", relic: "records/items/materia/compa_ancientarmorplate.dbr" });
  assert.equal(d.name, "Vicious Bonesplitter of Alacrity"); assert.equal(d.level, 62); assert.equal(d.component, "Ancient Armor Plate"); // expansion overrides base
  assert.equal(d.wiki, "Bonesplitter");
  assert.deepEqual(d.sections.map(s => s.title), ["", "Prefix: Vicious", "Suffix: of Alacrity", "Component: Ancient Armor Plate"]);
  assert.deepEqual(d.sections[0].lines, ["90-140 Physical Damage", "+1 to Blitz"]);
  assert.deepEqual(d.sections[1].lines, ["+18% Physical Damage"]); assert.deepEqual(d.sections[2].lines, ["+6% Attack Speed"]);
  assert.deepEqual(d.sections[3].lines, ["+8% Physical Resistance", "+5% Armor"]);
  d = await game.describe({ base: "RECORDS\\items\\gearaccessories\\rings\\set_ring.dbr" });
  assert.equal(d.name, "Ring of the Voidwalker"); assert.equal(d.set, "Voidwalker's Regalia");
  d = await game.describe({ base: "records/items/gearrelic/d001_relic.dbr" }); assert.equal(d.name, "Serenity");
  d = await game.describe({ base: "records/items/nope.dbr" }); assert.equal(d.known, false);
  console.log("game database + text: ok");
  await assert.rejects(GDDB.openGame([{ path: "x/readme.txt", file: new Blob(["hi"]) }]));
  console.log("wrong folder rejected: ok");
})().catch(e => { console.error(e); process.exit(1); });

// stat lines
{
  const t = tag => ({ tagRaceBeast: "Beasts" })[tag] || "";
  const L = GDDB.statLines({
    Class: "WeaponMelee_Sword", itemNameTag: "x", itemLevel: 60, levelRequirement: 58,
    offensivePhysicalMin: 120, offensivePhysicalMax: 180, offensiveFireMin: 30, offensiveFireMax: 30, offensiveFireModifier: 25,
    offensiveSlowBleedingMin: 20, offensiveSlowBleedingDurationMin: 3, offensiveSlowFireModifier: 40, offensiveSlowFireDurationModifier: 20,
    offensiveStunMin: 1.5, offensiveStunChance: 20, offensiveTotalDamageModifier: 10,
    defensiveFire: 15, defensivePoison: 22.5, defensiveFireMaxResist: 3, defensiveProtection: 410, defensiveStun: 30,
    characterStrength: 25, characterLifeModifier: 6, characterAttackSpeedModifier: 8, characterDodgePercent: 4, characterLifeRegen: 12.5,
    retaliationPhysicalMin: 150, retaliationAetherModifier: 30, skillCooldownReduction: 5, augmentAllLevel: 2,
    offensiveCritDamageModifier: 7, someWeirdThing: 3, characterBrandNewStat: 9,
  }, t);
  const want = ["410 Armor", "120-180 Physical Damage", "30 Fire Damage", "+25% Fire Damage", "60 Bleeding Damage over 3 Seconds", "+40% Burn Damage", "+20% Burn Duration",
    "20% Chance of 1.5 Second Stun", "+10% to All Damage", "+15% Fire Resistance", "+22.5% Acid Resistance", "+3% Maximum Fire Resistance", "30% Reduced Stun Duration",
    "+25 Physique", "+6% Health", "+8% Attack Speed", "+4% Chance to Avoid Melee Attacks", "+12.5 Health Regenerated per Second", "150 Physical Damage Retaliation",
    "+30% Aether Retaliation", "-5% Skill Cooldown Reduction", "+2 to all Skills", "+7% Crit Damage", "+9 Brand New Stat"];
  want.forEach(w => assert.ok(L.includes(w), "missing: " + w + "\n got: " + JSON.stringify(L)));
  assert.ok(!L.some(l => /Item Level|Level Requirement|someWeird/i.test(l)), JSON.stringify(L));
  console.log("stat lines: ok (" + L.length + " lines)");
}
