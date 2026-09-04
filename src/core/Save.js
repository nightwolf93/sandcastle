/**
 * Sauvegarde et chargement.
 *
 * Les champs voxel pesent 25 Mo bruts : trop pour localStorage, et on stocke
 * donc des ArrayBuffer compresses dans IndexedDB — sans base64, qui
 * gonflerait de 33 % pour rien.
 *
 * La compression est du gzip natif (CompressionStream). Un premier jet en RLE
 * pur donnait 4,9 Mo : excellent sur la densite (des volumes entiers de 0 ou
 * de 255) mais catastrophique sur l'humidite, qui varie continument d'un voxel
 * a l'autre et ou chaque "run" de longueur 1 coute trois octets au lieu d'un.
 * Deflate encaisse les deux regimes.
 *
 * Le champ `material` n'est pas stocke : il se deduit de la densite.
 *
 * Le format est versionne : un chargement d'une version inconnue est refuse
 * proprement plutot que de produire un terrain corrompu.
 *
 * HISTORIQUE. Chaque sauvegarde, automatique ou manuelle, est une entree a
 * part, sous la cle `auto:<date>` ou `manual:<date>` : on peut revenir a un
 * etat plus ancien que la derniere sauvegarde, ce qu'un unique emplacement
 * « auto » ecrase interdisait. Les entrees automatiques sont plafonnees (les
 * plus vieilles partent), les manuelles aussi mais plus haut. La reprise au
 * demarrage charge l'entree la plus recente, quel que soit son type. La
 * sauvegarde automatique se desactive, et ce choix survit au rechargement de
 * la page (localStorage) : celui qui la coupe ne veut pas la retrouver
 * active a la partie suivante.
 */

import { NX, NY, NZ, SEA_LEVEL, TIDE_AMPLITUDE, TIDE_PERIOD, setPendingMapSize } from './Config.js';
import { applyBeachStyle, beachParamsOf } from '../world/BeachGenerator.js';

const DB_NAME = 'sandcastle';
const STORE = 'saves';
const VERSION = 7;
/** Entrees d'historique conservees, par type. */
export const HISTORY_KEEP = { auto: 10, manual: 20 };
const KEY_AUTOSAVE = 'sc.autosave';

/**
 * Decode une cle de l'historique. `auto` seul est l'ancien emplacement
 * unique : il est migre a la premiere lecture.
 * @returns {{key:string, kind:'auto'|'manual', date:number, legacy?:boolean}|null}
 */
export function parseSaveKey(key) {
  if (typeof key !== 'string') return null;
  if (key === 'auto') return { key, kind: 'auto', date: 0, legacy: true };
  const m = /^(auto|manual):(\d+)$/.exec(key);
  return m ? { key, kind: m[1], date: Number(m[2]) } : null;
}

/** Entrees triees, la plus recente d'abord. */
export function sortSaveEntries(keys) {
  return keys.map(parseSaveKey).filter(Boolean).sort((a, b) => b.date - a.date);
}

/** Cles a supprimer pour respecter les plafonds par type. */
export function saveKeysToPrune(keys, keep = HISTORY_KEEP) {
  const out = [];
  const seen = { auto: 0, manual: 0 };
  for (const e of sortSaveEntries(keys)) {
    seen[e.kind]++;
    if (seen[e.kind] > (keep[e.kind] ?? Infinity)) out.push(e.key);
  }
  return out;
}

// ---------------------------------------------------------------------------
// RLE
// ---------------------------------------------------------------------------

/**
 * Encode un Uint8Array en paires (valeur, longueur) avec longueur sur 16 bits.
 * @returns {Uint8Array}
 */
export function rleEncode(src) {
  // Pire cas : alternance stricte -> 3 octets pour 1. On alloue large puis on
  // tronque ; l'allocation est temporaire et le cas pathologique n'arrive pas
  // sur du sable.
  let cap = Math.max(1024, Math.ceil(src.length * 0.35));
  let out = new Uint8Array(cap);
  let o = 0;
  const grow = () => {
    const bigger = new Uint8Array(Math.ceil(out.length * 1.8) + 1024);
    bigger.set(out);
    out = bigger;
  };

  let i = 0;
  while (i < src.length) {
    const v = src[i];
    let run = 1;
    const max = Math.min(65535, src.length - i);
    while (run < max && src[i + run] === v) run++;
    if (o + 3 > out.length) grow();
    out[o++] = v;
    out[o++] = run & 0xff;
    out[o++] = run >> 8;
    i += run;
  }
  return out.slice(0, o);
}

/** @param {Uint8Array} src @param {Uint8Array} dst */
export function rleDecode(src, dst) {
  let o = 0;
  for (let i = 0; i + 2 < src.length; i += 3) {
    const v = src[i];
    const run = src[i + 1] | (src[i + 2] << 8);
    if (v === 0) { o += run; continue; } // dst suppose remis a zero
    dst.fill(v, o, o + run);
    o += run;
  }
  return o;
}

// ---------------------------------------------------------------------------
// IndexedDB
// ---------------------------------------------------------------------------

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function tx(db, mode, fn) {
  return new Promise((resolve, reject) => {
    const t = db.transaction(STORE, mode);
    const store = t.objectStore(STORE);
    const r = fn(store);
    t.oncomplete = () => resolve(r?.result);
    t.onerror = () => reject(t.error);
  });
}

// ---------------------------------------------------------------------------

export class SaveManager {
  /** @param {import('./Game.js').Game} game */
  constructor(game) {
    this.game = game;
    this.autosaveEvery = 90; // secondes
    this.acc = 0;
    this.busy = false;
    this.lastSaved = 0;
    this.autosaveEnabled = true;
    try { this.autosaveEnabled = localStorage.getItem(KEY_AUTOSAVE) !== '0'; } catch {}
    this._migrated = false;
  }

  /** Active ou coupe la sauvegarde automatique ; le choix est conserve. */
  setAutosave(on) {
    this.autosaveEnabled = !!on;
    this.acc = 0;
    try { localStorage.setItem(KEY_AUTOSAVE, on ? '1' : '0'); } catch {}
  }

  /** Secondes avant la prochaine sauvegarde automatique. */
  get nextAutosaveIn() { return Math.max(0, this.autosaveEvery - this.acc); }

  /** Assemble l'etat du jeu en un objet stockable. */
  async serialize() {
    const g = this.game;
    const F = g.field;
    return {
      version: VERSION,
      dims: [NX, NY, NZ],
      date: Date.now(),
      density: await pack(F.density),
      moisture: await pack(F.moisture),
      packing: await pack(quantizeTo(F.packing, 16)),
      // La nappe : une hauteur par cellule d'eau, et les gouttes en vol.
      waterCells: Float32Array.from(g.water.hc),
      waterBase: Float32Array.from(g.water.baseBed),
      droplets: g.water.droplets.serialize(),
      props: g.props.serialize(),
      // Un chantier qu'on retrouve exactement comme on l'a laisse, outils
      // compris, c'est la moitie du plaisir de revenir sur une sauvegarde.
      droppedTools: g.droppedTools?.serialize() ?? [],
      dayT: g.dayT,
      tideTime: g.water.time,
      tideSpeed: g.water.tideSpeed,
      // Les reglages du panneau Mer font partie de la partie : on retrouve
      // la meme mer, et surtout la meme erosion, qu'en la quittant.
      sea: {
        weather: g.weather?.index ?? -1,
        hs: g.water.waves.hs,
        power: g.water.waves.power,
        agit: g.water.waves.agitIndex,
        damage: g.water.damageIndex,
      },
      carried: { ...g.carried },
      // Le style de plage : l'eau et la houle en dependent (profil, rivage).
      beach: {
        style: g.beachInfo?.style || 'classique',
        params: g.beachInfo?.params || null,
        seed: g.beachInfo?.seed ?? 0,
      },
      // Reglages d'outils qui font partie de la maniere de jouer.
      tools: {
        hand: { intensity: g.tools?.tools?.find((t) => t.id === 'hand')?.intensity ?? 0.5 },
      },
      camera: {
        tx: g.controls.goalTarget.x, ty: g.controls.goalTarget.y, tz: g.controls.goalTarget.z,
        dist: g.controls.goalDistance,
        az: g.controls.goalAzimuth,
        pol: g.controls.goalPolar,
      },
    };
  }

  async applySnapshot(s) {
    const g = this.game;
    const F = g.field;
    if (!s || ![2, 3, 4, 5, 6, VERSION].includes(s.version)) throw new Error('Sauvegarde incompatible');
    const [nx, ny, nz] = s.dims;
    if (ny !== NY) throw new Error('Sauvegarde incompatible (hauteur)');
    if (nx !== NX || nz !== NZ) {
      // Une autre taille de carte : la page se recharge a cette taille et
      // reprend cette sauvegarde (c'est la plus recente).
      setPendingMapSize(nx, nz);
      setTimeout(() => location.reload(), 150);
      throw new Error(`carte de ${nx} x ${nz} : rechargement`);
    }

    await unpackInto(s.density, F.density);
    await unpackInto(s.moisture, F.moisture);
    await unpackInto(s.packing, F.packing);
    // Le materiau se deduit : du sable partout ou il y a de la matiere.
    for (let i = 0; i < F.density.length; i++) F.material[i] = F.density[i] > 0 ? 1 : 0;
    F.rebuildAll();

    // Le style de plage AVANT l'eau : le rivage, la bande et la houle
    // lisent le profil courant. Les anciennes sauvegardes sont classiques.
    const styleId = s.beach?.style || 'classique';
    const applied = applyBeachStyle(s.beach?.params || styleId);
    g.beachInfo = { style: applied.id, params: beachParamsOf(applied), seed: s.beach?.seed ?? 0 };
    g.water.rebuildShore();

    // Le niveau physique doit etre connu AVANT de regenerer la mer. Les
    // versions anterieures a 7 stockaient l'eau autrement (colonnes fines,
    // puis billes) : on conserve tout le chateau et on recree une mer propre,
    // horizontale, autour de lui.
    g.water.time = s.tideTime ?? 0;
    g.water.tideSpeed = s.tideSpeed ?? 1;
    g.water.tide = Math.sin((g.water.time / TIDE_PERIOD) * Math.PI * 2);
    g.water.tideLevel = SEA_LEVEL + g.water.tide * TIDE_AMPLITUDE;
    g.water.waveSetup = 0;
    g.water.seaLevel = g.water.tideLevel;
    if (s.sea) {
      if (s.sea.weather >= 0 && g.weather) g.weather.apply(s.sea.weather);
      else if (Number.isFinite(s.sea.state)) g.water.setSeaState(s.sea.state);
      if (Number.isFinite(s.sea.hs)) g.water.setWaveHeight(s.sea.hs);
      if (Number.isFinite(s.sea.power)) g.water.setWavePower(s.sea.power);
      g.water.setAgitation(s.sea.agit ?? 1);
      g.water.setDamage(s.sea.damage ?? 2);
      if (g.weather && !(s.sea.weather >= 0)) g.weather.markCustom();
    }
    if (s.version >= 7 && s.waterCells) g.water.restore(s.waterCells, s.droplets, s.waterBase);
    else g.water.initialize();
    g.hud?.syncSeaPanel();

    g.props.deserialize(s.props);
    g.droppedTools?.deserialize(s.droppedTools);
    // Un seau reste plein n'est pas serialise : on remet l'etat a plat, sinon
    // le joueur retrouve un seau « bloque » et vide.
    const bucket = g.tools?.tools?.find((t) => t.id === 'bucket');
    if (bucket) { bucket.stuck = false; bucket.fill = 0; }
    // Le rig VISIBLE doit suivre l'etat : sans cette ligne, un seau plein a
    // la sauvegarde reste plein a l'ecran alors que l'etat, lui, est vide.
    g.toolAvatar?.built?.bucket?.bucket?.setFill(0, 0.12);
    g.dayT = s.dayT ?? 0.36;
    Object.assign(g.carried, s.carried || {});
    const hand = g.tools?.tools?.find((t) => t.id === 'hand');
    if (hand && typeof s.tools?.hand?.intensity === 'number') {
      hand.intensity = Math.min(1, Math.max(0, s.tools.hand.intensity));
      g.hud?.syncHandPanel?.(g.tools.current);
    }
    if (s.camera) {
      g.controls.goalTarget.set(s.camera.tx, s.camera.ty, s.camera.tz);
      g.controls.target.copy(g.controls.goalTarget);
      g.controls.goalDistance = g.controls.distance = s.camera.dist;
      g.controls.goalAzimuth = g.controls.azimuth = s.camera.az;
      g.controls.goalPolar = g.controls.polar = s.camera.pol;
    }
    g.sky.update(g.dayT, true);
    g.granular.wakeBox(0, 0, 0, NX - 1, NY - 1, NZ - 1);
    g.tools.undo.clear();
  }

  /**
   * Ecrit une nouvelle entree d'historique.
   * @param {'auto'|'manual'} kind
   */
  async save(kind = 'manual') {
    if (this.busy) return false;
    if (kind !== 'auto') kind = 'manual';
    this.busy = true;
    try {
      const snap = await this.serialize();
      const key = `${kind}:${snap.date}`;
      const db = await openDB();
      await tx(db, 'readwrite', (st) => st.put(snap, key));
      // Plafond par type : les plus vieilles entrees partent.
      const keys = await tx(db, 'readonly', (st) => st.getAllKeys());
      const drop = saveKeysToPrune(keys || []);
      if (drop.length) await tx(db, 'readwrite', (st) => { for (const k of drop) st.delete(k); });
      db.close();
      this.lastSaved = performance.now();
      this.acc = 0;
      const dropletBytes = (snap.droplets?.count || 0) * 8 * 4;
      const kb = (snap.density.length + snap.moisture.length + snap.packing.length
        + snap.waterCells.length * 8 + dropletBytes) / 1024;
      return { kb, key, kind };
    } finally {
      this.busy = false;
    }
  }

  /**
   * Charge une entree ; `latest` designe la plus recente, tous types
   * confondus (c'est la reprise au demarrage).
   */
  async load(key = 'latest') {
    if (key === 'latest') {
      const entries = await this.list();
      if (!entries.length) return false;
      key = entries[0].key;
    }
    const db = await openDB();
    const snap = await tx(db, 'readonly', (st) => st.get(key));
    db.close();
    if (!snap) return false;
    await this.applySnapshot(snap);
    return true;
  }

  /** L'historique, la plus recente entree d'abord. */
  async list() {
    const db = await openDB();
    let keys = (await tx(db, 'readonly', (st) => st.getAllKeys())) || [];
    // Migration de l'ancien emplacement unique « auto » vers l'historique.
    if (!this._migrated && keys.includes('auto')) {
      const snap = await tx(db, 'readonly', (st) => st.get('auto'));
      if (snap) {
        const key = `auto:${snap.date || Date.now()}`;
        await tx(db, 'readwrite', (st) => { st.put(snap, key); st.delete('auto'); });
        keys = keys.filter((k) => k !== 'auto').concat(key);
      }
    }
    this._migrated = true;
    db.close();
    return sortSaveEntries(keys);
  }

  async remove(key) {
    const db = await openDB();
    await tx(db, 'readwrite', (st) => st.delete(key));
    db.close();
  }

  update(dt) {
    if (!this.autosaveEnabled) return;
    this.acc += dt;
    if (this.acc < this.autosaveEvery) return;
    this.acc = 0;
    this.save('auto').then((r) => {
      if (!r) return;
      this.game.toast(`Sauvegarde automatique (${r.kb.toFixed(0)} Ko)`);
      this.game.hud?.onSavesChanged?.();
    }).catch(() => {});
  }
}

// ---------------------------------------------------------------------------
// COMPRESSION
// ---------------------------------------------------------------------------

const HAS_CS = typeof CompressionStream !== 'undefined';

/** Compresse un Uint8Array. Repli sur du RLE si gzip n'est pas disponible. */
export async function pack(src) {
  if (!HAS_CS) {
    const out = rleEncode(src);
    const tagged = new Uint8Array(out.length + 1);
    tagged[0] = 1; // 1 = RLE
    tagged.set(out, 1);
    return tagged;
  }
  // Un Blob refuse une vue sur memoire partagee : on copie (3 Mo, une fois
  // par sauvegarde) quand le champ vit dans un SharedArrayBuffer.
  const plain = (typeof SharedArrayBuffer !== 'undefined' && src.buffer instanceof SharedArrayBuffer)
    ? src.slice() : src;
  const stream = new Blob([plain]).stream().pipeThrough(new CompressionStream('gzip'));
  const buf = new Uint8Array(await new Response(stream).arrayBuffer());
  const tagged = new Uint8Array(buf.length + 1);
  tagged[0] = 0; // 0 = gzip
  tagged.set(buf, 1);
  return tagged;
}

/** Decompresse dans un tableau deja alloue (et remis a zero si besoin). */
export async function unpackInto(tagged, dst) {
  if (!tagged || tagged.length === 0) return;
  const body = tagged.subarray(1);
  if (tagged[0] === 1) {
    dst.fill(0);
    rleDecode(body, dst);
    return;
  }
  const stream = new Blob([body]).stream().pipeThrough(new DecompressionStream('gzip'));
  const out = new Uint8Array(await new Response(stream).arrayBuffer());
  dst.set(out.subarray(0, dst.length));
}

/** Reduit le nombre de niveaux : la compaction n'a pas besoin de 256 valeurs. */
function quantizeTo(src, levels) {
  const out = new Uint8Array(src.length);
  const step = 255 / (levels - 1);
  for (let i = 0; i < src.length; i++) {
    out[i] = Math.round(Math.round(src[i] / step) * step);
  }
  return out;
}
