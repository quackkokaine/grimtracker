// Builds encrypted fake player.gdc files the same way the game does, then reads them back.
const GDSave = require("../src/gdsave.js");
const assert = require("assert");

function Writer(seed) {
  const bytes = [];
  let key = (seed ^ 0x55555555) >>> 0;
  const table = new Uint32Array(256);
  let k = key;
  for (let i = 0; i < 256; i++) { k = ((k >>> 1) | (k << 31)) >>> 0; k = Math.imul(k, 39916801) >>> 0; table[i] = k; }
  const raw4 = v => { for (let i = 0; i < 4; i++) bytes.push((v >>> (8 * i)) & 255); };
  raw4(seed);
  const w = {
    bytes, get pos() { return bytes.length; },
    int(v) { const e = (v ^ key) >>> 0; const start = bytes.length; raw4(e); for (let i = start; i < start + 4; i++) key = (key ^ table[bytes[i]]) >>> 0; },
    byte(v) { const e = (v ^ key) & 255; bytes.push(e); key = (key ^ table[e]) >>> 0; },
    next(v) { raw4((v ^ key) >>> 0); },
    str(s) { w.int(s.length); for (const c of s) w.byte(c.charCodeAt(0)); },
    wstr(s) { w.int(s.length); for (const c of s) { const x = c.charCodeAt(0); w.byte(x & 255); w.byte(x >> 8); } },
    uid(b) { b.forEach(x => w.byte(x)); },
    block(id, fn) {
      w.int(id);
      const lenAt = bytes.length; const keyAtLen = key; raw4(0);
      const start = bytes.length; fn();
      const len = bytes.length - start;
      const e = (len ^ keyAtLen) >>> 0; for (let i = 0; i < 4; i++) bytes[lenAt + i] = (e >>> (8 * i)) & 255;
      w.next(0);
    },
  };
  return w;
}

const hexToBytes = h => Uint8Array.from(h.match(/../g).map(x => parseInt(x, 16)));
const KNOWN = { 1515: "9A81F42DA94CE12347AEE98B28D35045", 7546: "3A8F8549AC4AA58B669A7CB4116D2150", 1517: "61086CB1CF47D6AE4FA88D882DC65220", 6652: "EBD5AD8CAE4791AB58D82AB9E42CB9A3", 92197: "743A9F98C34147430FE2B2AA57AEDB9B" };
const knownMap = new Map(Object.entries(KNOWN).map(([id, h]) => [h, +id]));
const wordsSwap = h => h.match(/.{8}/g).map(w => w.match(/../g).reverse().join("")).join("");

function makeFile({ seed, hv = 2, name = "Ashveil", hardcore = 1, lists, deaths = 0, enc = "bytes", extraBlocks = true }) {
  const w = Writer(seed);
  w.int(0x58434447); w.int(hv);
  w.wstr(name); w.byte(1); w.str("tagCharClass0109"); w.int(42); w.byte(hardcore); if (hv >= 2) w.byte(3);
  w.next(0); w.int(8); w.uid(new Uint8Array(16).fill(7));
  w.block(1, () => { w.int(5); w.byte(1); w.byte(1); w.byte(0); w.byte(1); w.int(12345); w.str("some/texture"); });
  w.block(2, () => { w.int(8); w.int(42); w.int(999999); w.int(3); w.int(1); w.int(2); w.int(9); for (let i = 0; i < 5; i++) w.int(0x3f800000); });
  if (extraBlocks) w.block(99, () => { for (let i = 0; i < 300; i++) w.byte(i & 255); w.str("future data"); });
  w.block(17, () => { w.int(2); lists.forEach(l => { w.int(l.length); l.forEach(h => w.uid(hexToBytes(enc === "bytes" ? h : wordsSwap(h)))); }); });
  w.block(16, () => { w.int(11); w.int(3600); w.int(deaths); w.int(500); for (let i = 0; i < 20; i++) w.int(i); });
  return Uint8Array.from(w.bytes).buffer;
}

// Layout A: restored lists 0-2, found lists 3-5
const K = KNOWN;
let buf = makeFile({ seed: 0xdeadbeef, lists: [[K[1515], K[7546]], [K[6652]], [], [K[1515], K[7546], K[1517]], [K[6652]], [K[92197]]], deaths: 0 });
let s = GDSave.parse(buf);
assert.equal(s.name, "Ashveil"); assert.equal(s.level, 42); assert.equal(s.hardcore, true); assert.equal(s.tag, "tagCharClass0109");
assert.equal(s.dataVersion, 8); assert.equal(s.bio.level, 42); assert.equal(s.bio.totalDevotion, 9); assert.equal(s.stats.deaths, 0);
assert.deepEqual(s.blocks, [1, 2, 99, 17, 16]);
let r = GDSave.resolve(s, knownMap);
assert.equal(r.layout, "A"); assert.equal(r.encoding, "bytes");
assert.deepEqual(r.restored.normal.sort(), [1515, 7546]); assert.deepEqual(r.restored.elite, [6652]); assert.deepEqual(r.restored.ultimate, []);
assert.deepEqual(r.found.normal.sort((a, b) => a - b), [1515, 1517, 7546]); assert.deepEqual(r.found.ultimate, [92197]);
console.log("layout A, byte ids: ok");

// Layout B, word-swapped ids, header v1, a death, unknown uid present
buf = makeFile({ seed: 0x12345678, hv: 1, enc: "words", deaths: 1, lists: [[K[1515], K[1517], "00112233445566778899AABBCCDDEEFF"], [], [], [K[1517]], [], []] });
s = GDSave.parse(buf); r = GDSave.resolve(s, knownMap);
assert.equal(s.stats.deaths, 1); assert.equal(r.encoding, "words"); assert.equal(r.layout, "B"); assert.equal(r.unknown, 1);
assert.deepEqual(r.restored.normal, [1517]);
console.log("layout B, word ids, header v1, unknown uid: ok");

// Many random seeds
for (let i = 0; i < 200; i++) {
  const seed = (Math.random() * 2 ** 32) >>> 0;
  const t = GDSave.parse(makeFile({ seed, name: "Ünïcode Name", lists: [[K[1515]], [], [], [K[1515]], [], []] }));
  assert.equal(t.name, "Ünïcode Name"); assert.equal(t.shrineLists[0].length, 1);
}
console.log("200 random keys: ok");

// Corrupt / wrong files are rejected, not misread
assert.throws(() => GDSave.parse(new Uint8Array(40).buffer));
const b2 = new Uint8Array(makeFile({ seed: 5, lists: [[], [], [], [], [], []] })); assert.throws(() => GDSave.parse(b2.slice(0, b2.length - 30).buffer));
console.log("bad files rejected: ok");

// Full-format save: masteries, attributes, complete play stats
{
  const w = Writer(0xcafef00d);
  w.int(0x58434447); w.int(2); w.wstr("Vexa"); w.byte(0); w.str("tagSkillClassName0205"); w.int(88); w.byte(1); w.byte(3);
  w.next(0); w.int(8); w.uid(new Uint8Array(16));
  w.block(1, () => { w.int(5); w.byte(1); w.byte(1); w.byte(2); w.byte(1); w.int(4321000); w.byte(0); w.int(57); w.byte(0); w.byte(0); w.byte(0); w.byte(0); w.str("tex"); w.int(0); });
  w.block(2, () => { w.int(8); w.int(88); w.int(123456789); w.int(2); w.int(5); w.int(1); w.int(54); [612.5, 490, 744].forEach(f => w.int(new Uint32Array(new Float32Array([f]).buffer)[0])); w.int(new Uint32Array(new Float32Array([9000]).buffer)[0]); w.int(new Uint32Array(new Float32Array([1500]).buffer)[0]); });
  const skill = (name, lvl) => { w.str(name); w.int(lvl); w.byte(1); w.int(0); w.int(0); w.int(0); w.byte(0); w.byte(0); w.str(""); w.str(""); };
  w.block(8, () => { w.int(6); w.int(3); skill("records/skills/playerclass05/_classtraining_class05.dbr", 50); skill("records/skills/playerclass02/_classtraining_class02.dbr", 32); skill("records/skills/playerclass02/firestrike1.dbr", 16); w.int(2); w.int(0); w.int(0); w.int(0); w.int(0); });
  const f32 = f => w.int(new Uint32Array(new Float32Array([f]).buffer)[0]);
  w.block(16, () => {
    w.int(11); w.int(360000); w.int(1); w.int(48210); w.int(9999); w.int(312); w.int(80); w.int(88); w.int(70000); w.int(220000); w.int(31000); w.int(4000); f32(152340.5);
    for (let d = 0; d < 3; d++) { w.str("Grava'thul" + d); w.int(70 + d); w.int(500000); w.str("Fiend"); w.str(d === 2 ? "Ravager of Minds" : "Slith"); }
    w.int(1200); f32(1); f32(2); f32(18400); w.int(310); w.int(14); w.int(9); w.int(4); w.int(1); w.int(77); w.int(130); w.int(203);
    w.int(120); w.int(80); w.int(22); w.int(150); w.int(300000); w.int(5); w.int(6);
    w.int(1); w.str("someskill"); w.int(3); w.int(11); w.int(12); w.byte(0); w.int(412); w.int(3301);
  });
  w.block(17, () => { w.int(2); for (let i = 0; i < 6; i++) w.int(0); });
  const t = GDSave.parse(Uint8Array.from(w.bytes).buffer);
  assert.deepEqual(t.warnings, undefined);
  const snap = GDSave.snapshot(t);
  assert.equal(snap.className, "Sorceress"); // female, Demolitionist + Arcanist
  assert.deepEqual(snap.masteries.map(m => m.name + m.level), ["Demolitionist32", "Arcanist50"]);
  assert.equal(snap.iron, 4321000); assert.equal(snap.tributes, 57); assert.equal(snap.lastDifficulty, "Ultimate");
  assert.equal(Math.round(snap.physique), 613); assert.equal(snap.devotionUnlocked, 54);
  const s = snap.stats;
  assert.equal(s.kills, 48210); assert.equal(s.deaths, 1); assert.equal(s.playTime, 360000); assert.equal(Math.round(s.greatestDamageDone), 152341);
  assert.equal(s.perDifficulty[2].lastMonsterHitBy, "Ravager of Minds"); assert.equal(s.heroKills, 310); assert.equal(s.shrinesRestored, 77);
  assert.deepEqual(s.bossKills, [120, 80, 22]); assert.equal(s.uniqueItems, 412); assert.equal(s.randomizedItems, 3301); assert.equal(s.complete, true);
  console.log("full stats save: ok");
}

// A future block 16 layout we can't read must not break shrines or death detection
{
  const w = Writer(77);
  w.int(0x58434447); w.int(2); w.wstr("Odd"); w.byte(1); w.str("tagSkillClassName10"); w.int(5); w.byte(1); w.byte(3);
  w.next(0); w.int(9); w.uid(new Uint8Array(16));
  w.block(16, () => { w.int(99); w.int(10); w.int(1); w.int(5); w.int(5000000); /* bogus string length */ for (let i = 0; i < 4; i++) w.int(0); });
  w.block(17, () => { w.int(2); w.int(1); w.uid(hexToBytes(KNOWN[1515])); for (let i = 0; i < 5; i++) w.int(0); });
  const t = GDSave.parse(Uint8Array.from(w.bytes).buffer);
  assert.equal(t.stats.deaths, 1); assert.equal(t.shrineLists[0].length, 1); assert.ok(t.warnings.length === 1);
  assert.equal(GDSave.snapshot(t).className, "Berserker");
  console.log("unreadable stats block skipped safely: ok");
}

// Equipped gear (block 3), with bags in front that must be skipped
{
  const w = Writer(4242);
  w.int(0x58434447); w.int(2); w.wstr("Gearhead"); w.byte(1); w.str("tagSkillClassName0109"); w.int(90); w.byte(1); w.byte(3);
  w.next(0); w.int(8); w.uid(new Uint8Array(16));
  const item = (base, extra = {}) => { w.str(base); w.str(extra.prefix || ""); w.str(extra.suffix || ""); w.str(""); w.str(""); w.int(123); w.str(extra.relic || ""); w.str(""); w.int(0); w.str(extra.augment || ""); w.int(0); w.int(0); w.int(0); w.int(1); };
  w.block(3, () => {
    w.int(4); w.byte(1); w.int(2); w.int(0); w.int(0);
    for (let s = 0; s < 2; s++) w.block(0, () => { w.byte(0); w.int(1); item("records/items/junk/bagitem" + s + ".dbr"); w.int(3); w.int(4); });
    w.byte(0);
    for (let i = 0; i < 12; i++) { item(i === 0 ? "records/items/gearhead/c034_head.dbr" : i === 11 ? "" : "records/items/slot" + i + ".dbr", i === 2 ? { prefix: "records/items/lootaffixes/prefix/p.dbr", suffix: "records/items/lootaffixes/suffix/s.dbr", relic: "records/items/materia/compa.dbr" } : {}); w.byte(1); }
    w.byte(0); item("records/items/gearweapons/swords1h/a12_sword.dbr"); w.byte(1); item(""); w.byte(0);
    w.byte(1); item(""); w.byte(0); item(""); w.byte(0);
  });
  w.block(17, () => { w.int(2); for (let i = 0; i < 6; i++) w.int(0); });
  const t = GDSave.parse(Uint8Array.from(w.bytes).buffer);
  assert.equal(t.warnings, undefined);
  const g = GDSave.snapshot(t).gear;
  assert.equal(g.equipment[0].base, "records/items/gearhead/c034_head.dbr");
  assert.equal(g.equipment[2].suffix, "records/items/lootaffixes/suffix/s.dbr"); assert.equal(g.equipment[2].relic, "records/items/materia/compa.dbr");
  assert.equal(g.equipment[11], null); assert.equal(g.weapons[0][0].base, "records/items/gearweapons/swords1h/a12_sword.dbr"); assert.equal(g.weapons[0][1], null);
  console.log("equipped gear: ok");
}

// Game 1.3 layouts seen in real saves: inventory v11 (4 extra numbers per item), stash v6+ with
// nested pages, skills v8 (one extra flag), and shrine lists paired by difficulty.
{
  const w = Writer(90210);
  w.int(0x58434447); w.int(2); w.wstr("Newer"); w.byte(1); w.str("tagSkillClassName0104"); w.int(16); w.byte(1); w.byte(7);
  w.next(0); w.int(8); w.uid(new Uint8Array(16));
  const f32 = f => w.int(new Uint32Array(new Float32Array([f]).buffer)[0]);
  const item = (base, extra = {}) => { w.str(base); w.str(extra.prefix || ""); w.str(""); w.str(""); w.str(""); w.int(5); w.str(extra.relic || ""); w.str(""); w.int(0); w.str(""); w.int(0); w.int(0); w.int(0); w.int(0); w.int(0); w.int(1); w.int(0); w.int(0); };
  w.block(3, () => {
    w.int(11); w.byte(1); w.int(1); w.int(0); w.int(0);
    w.block(0, () => { w.byte(0); w.int(2); item("records/items/materia/compa_corpsedust.dbr"); w.int(0); w.int(6); item("records/items/materia/compa_aethercrystal.dbr"); w.int(0); w.int(4); });
    w.byte(0);
    for (let i = 0; i < 12; i++) { item(i === 0 ? "records/items/gearhead/a03_head002.dbr" : "", i === 0 ? { prefix: "records/items/lootaffixes/prefix/b_ar030_ar.dbr", relic: "records/items/materia/compa_festeringblood.dbr" } : {}); w.byte(1); }
    w.byte(0); item("records/items/gearweapons/blunt1h/b016a_blunt.dbr"); w.byte(1); item(""); w.byte(0); w.byte(1); item(""); w.byte(0); item(""); w.byte(0);
  });
  w.block(4, () => { w.int(11); w.int(1); w.block(0, () => { w.int(10); w.int(18); w.int(0); }); });
  const sk = (name, lvl) => { w.str(name); w.int(lvl); w.byte(1); w.int(0); w.int(0); w.int(0); w.byte(0); w.byte(0); w.byte(0); w.str(""); w.str(""); };
  w.block(8, () => { w.int(8); w.int(2); sk("records/skills/playerclass01/_classtraining_class01.dbr", 13); sk("records/skills/playerclass04/_classtraining_class04.dbr", 20); w.int(2); w.int(0); w.int(0); w.int(0); });
  w.block(17, () => { w.int(2); const L = [[KNOWN[1515], KNOWN[7546]], [KNOWN[1515], KNOWN[7546], KNOWN[1517]], [], [], [], []]; L.forEach(l => { w.int(l.length); l.forEach(h => w.uid(hexToBytes(h))); }); });
  w.block(16, () => {
    w.int(11); w.int(5564); w.int(1); for (let i = 0; i < 9; i++) w.int(i); f32(100);
    for (let d = 0; d < 3; d++) { w.str(""); w.int(0); w.int(0); w.str(""); w.str(""); }
    w.int(0); f32(0); f32(0); f32(0); for (let i = 0; i < 5; i++) w.int(0); w.int(2); w.int(0); w.int(0); w.int(0); w.int(0); w.int(0); w.int(0); w.int(0); w.int(0); w.int(0); w.int(0);
    w.int(0); w.int(0); w.int(0); w.byte(0); w.int(0); w.int(0);
  });
  const t = GDSave.parse(Uint8Array.from(w.bytes).buffer);
  assert.equal(t.warnings, undefined, JSON.stringify(t.warnings));
  const snap = GDSave.snapshot(t);
  assert.equal(snap.gear.equipment[0].base, "records/items/gearhead/a03_head002.dbr"); assert.equal(snap.gear.equipment[0].relic, "records/items/materia/compa_festeringblood.dbr");
  assert.equal(snap.gear.weapons[0][0].base, "records/items/gearweapons/blunt1h/b016a_blunt.dbr");
  assert.deepEqual(snap.masteries.map(m => m.name + m.level), ["Soldier13", "Nightblade20"]); assert.equal(snap.className, "Blademaster");
  assert.equal(t.stats.deaths, 1); assert.equal(t.stats.shrinesRestored, 2);
  const r = GDSave.resolve(t, knownMap);
  assert.deepEqual(r.restored.normal.sort((a, b) => a - b), [1515, 7546]); assert.deepEqual(r.found.normal.sort((a, b) => a - b), [1515, 1517, 7546]);
  assert.deepEqual(r.restored.elite, []);
  console.log("game 1.3 save layouts: ok");
}
