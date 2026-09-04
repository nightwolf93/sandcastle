/**
 * Simulation granulaire : avalanches, effondrements, tenue des murs.
 *
 * Deux mecanismes distincts, parce qu'ils ne se ressentent pas pareil :
 *
 *  1. REGLE DE PENTE (immediate). Pour chaque voxel de surface on mesure la
 *     denivellation locale vers ses 4 voisins lateraux. Si elle depasse
 *     tan(theta_max(w, p)), du sable coule vers le bas. C'est un "slope
 *     model" (et pas un "height model" a la Bak-Tang-Wiesenfeld) : c'est ce
 *     qui donne un vrai cone d'eboulis et un angle de repos correct.
 *     Sable sec -> tan(34 deg) = 0.67, tout ce qui depasse une demi-marche
 *     coule. Sable parfait -> tan(89 deg) plafonne a 8, donc une paroi
 *     verticale ne bouge pas.
 *
 *  2. RUPTURE STRUCTURELLE (differee). Un voxel qui n'a rien dessous ne tient
 *     que par la cohesion de ses voisins. On teste par un petit parcours
 *     lateral s'il existe un appui au sol a moins de maxOverhang(w, p). Si non,
 *     on accumule de la CONTRAINTE au lieu de casser tout de suite : le joueur
 *     voit des micro-fissures et entend craquer pendant 2 a 4 secondes avant
 *     que ca lache. Une rupture doit toujours etre annoncee.
 *
 * On ne SUPPRIME jamais de matiere pour simuler un effondrement : on la
 * deplace. La masse est conservee a l'octet pres, et l'eboulis se forme tout
 * seul par la regle de pente.
 *
 * Cout maitrise par un "active set" : seuls les voxels reveilles par une
 * modification (outil, eau, voisin qui a bouge) sont examines.
 */

import {
  NX, NY, NZ, ISO, VOXEL, CHUNK, FOUNDATION_LAYERS, chidx, clamp,
} from '../core/Config.js';
import {
  maxDropByte, maxDropFarByte, maxOverhang, DROP_CAP, FAR_BASE,
} from './SandPhysics.js';

const SLICE = NX * NZ;
/**
 * Profondeur max de sondage vertical pour mesurer une denivellation, en voxels.
 *
 * Doit couvrir les hauteurs de rupture qui nous interessent : une paroi de
 * sable parfait tient environ 90 cm, soit 23 voxels. En sondant moins loin, on
 * serait incapable de voir qu'un mur trop haut doit ceder. Le cout reste
 * modere : le sondage s'arrete des qu'il rencontre de la matiere, donc il ne
 * descend loin qu'au bord des falaises.
 */
const KMAX = 32;
/**
 * Transfert maximal par voxel et par sous-pas (unites de densite 0..255).
 *
 * A 96, un voxel cedait 37 % de son contenu d'un seul coup : l'isosurface
 * sautait 4 cm en une frame, puis plus rien. A l'ecran, le sable se
 * TELEPORTAIT de cellule en cellule au lieu de couler.
 *
 * A 24, reparti sur quatre sous-pas, le debit total et la duree de l'avalanche
 * sont rigoureusement identiques — mais chaque pas ne deplace plus que 3,8 mm,
 * et le mouvement devient continu. Le cout est nul : on traite le meme nombre
 * de voxels, juste en quatre fois.
 */
const MAX_TRANSFER = 18;
/** Sous-pas d'avalanche par pas de simulation. */
const SUBSTEPS = 4;
/** Amortissement : on ne corrige qu'une fraction de l'exces de pente. */
const DAMPING = 0.40;
/** Contrainte accumulee avant rupture (unites de 1/255 par passe). */
const STRESS_BREAK = 200;
/**
 * Duree d'avertissement avant qu'un surplomb non soutenu ne cede, en secondes.
 *
 * C'est un parametre de JEU autant que de physique : il faut qu'on VOIE la
 * chose trembler avant qu'elle parte, sinon la rupture parait arbitraire.
 * Deux secondes et des poussieres, c'est le temps de retirer la main.
 */
const STRESS_WARNING_S = 2.4;
const STRESS_RATE = STRESS_BREAK / STRESS_WARNING_S;

/** Voisins lateraux (dx, dz). */
const LAT = [[1, 0], [-1, 0], [0, 1], [0, -1]];

export class Granular {
  /**
   * @param {import('./VoxelField.js').VoxelField} field
   */
  constructor(field) {
    this.field = field;
    const n = NX * NY * NZ;

    /** 1 si le voxel est deja dans la file. */
    this.flag = new Uint8Array(n);
    /**
     * Contrainte accumulee sur les surplombs, 0..255. Sert aussi au rendu :
     * le shader en fait des micro-fissures avant la rupture.
     */
    this.stress = new Uint8Array(n);

    // Quatre files, une par couleur du damier (x&1, z&1). Trier a l'ajout
    // plutot qu'au traitement evite de reparcourir 4 fois l'ensemble actif :
    // on gagne un facteur 4 sur le debit d'avalanche, ce qui fait la
    // difference entre du sable qui coule et du sable qui rampe.
    const CAP = 1 << 18; // 262144 entrees par couleur
    this.CAP = CAP;
    this.cur = [new Int32Array(CAP), new Int32Array(CAP), new Int32Array(CAP), new Int32Array(CAP)];
    this.next = [new Int32Array(CAP), new Int32Array(CAP), new Int32Array(CAP), new Int32Array(CAP)];
    this.curLen = [0, 0, 0, 0];
    this.nextLen = [0, 0, 0, 0];

    // Parcours local d'appui : grille relative de (2R+1)^3 au plus, effacee a
    // chaque appel. Bien moins couteux qu'un tableau de marqueurs global.
    this.SUP_R = 6;
    this.SUP_S = this.SUP_R * 2 + 1;
    this.supVisit = new Uint8Array(this.SUP_S ** 3);
    this.bfs = new Int32Array(this.SUP_S ** 3 * 2);

    this.stats = { processed: 0, moved: 0, collapsed: 0, active: 0 };
    /** Evenements a sonoriser / afficher : effondrements de la frame. */
    this.events = [];

    this.rngState = 12345;
    this.parity = 0;
  }

  rand() {
    let s = this.rngState;
    s ^= s << 13; s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5; s >>>= 0;
    this.rngState = s;
    return s / 4294967296;
  }

  // -------------------------------------------------------------------------
  // FILE ACTIVE
  // -------------------------------------------------------------------------

  /**
   * Un voxel peut-il seulement bouger ?
   *
   * processVoxel n'agit que dans deux cas : soit le voxel a du vide dessous
   * (rupture possible), soit il a du vide dessus (regle de pente). Un voxel
   * enterre entre deux voxels pleins est immobile par construction — inutile
   * de l'inscrire dans la file.
   *
   * Ce filtre divise l'ensemble actif par dix apres un coup de pelle : on ne
   * garde que la coquille de surface au lieu de tout le volume remue.
   */
  movable(i) {
    const dens = this.field.density;
    if (dens[i] === 0) return false;
    const below = i >= SLICE ? dens[i - SLICE] : 255;
    if (below < ISO) return true;
    const above = i + SLICE < dens.length ? dens[i + SLICE] : 0;
    if (above < ISO) return true;
    // Un support enterre mais expose lateralement peut etre un pilier-aiguille
    // sous une masse beaucoup plus large. Il doit rester surveillable apres
    // que l'erosion a aminci son pied, sinon « quelque chose dessous » suffit
    // a porter un bloc arbitraire pour toujours.
    const y = (i / SLICE) | 0;
    const r = i - y * SLICE;
    const z = (r / NX) | 0;
    const x = r - z * NX;
    return (x > 0 && dens[i - 1] < ISO) || (x + 1 < NX && dens[i + 1] < ISO)
      || (z > 0 && dens[i - NX] < ISO) || (z + 1 < NZ && dens[i + NX] < ISO);
  }

  /** Reveille un voxel (et rien d'autre). */
  push(i) {
    if (i < 0 || i >= this.flag.length) return;
    if (this.flag[i]) return;
    if (!this.movable(i)) return;
    const y = (i / SLICE) | 0;
    const r = i - y * SLICE;
    const z = (r / NX) | 0;
    const x = r - z * NX;
    const c = (x & 1) | ((z & 1) << 1);
    const n = this.nextLen[c];
    if (n >= this.CAP) return; // sature : il sera reveille plus tard
    this.flag[i] = 1;
    this.next[c][n] = i;
    this.nextLen[c] = n + 1;
  }

  /** Reveille un voxel et son voisinage immediat (26 voisins + 2 au-dessus). */
  wake(x, y, z) {
    for (let dz = -1; dz <= 1; dz++) {
      const zz = z + dz;
      if (zz < 0 || zz >= NZ) continue;
      for (let dy = -1; dy <= 2; dy++) {
        const yy = y + dy;
        if (yy < 0 || yy >= NY) continue;
        for (let dx = -1; dx <= 1; dx++) {
          const xx = x + dx;
          if (xx < 0 || xx >= NX) continue;
          this.push(xx + NX * (zz + NZ * yy));
        }
      }
    }
  }

  /** Reveille toute une boite (apres un coup d'outil). */
  wakeBox(x0, y0, z0, x1, y1, z1) {
    x0 = Math.max(0, x0 - 1); y0 = Math.max(0, y0 - 1); z0 = Math.max(0, z0 - 1);
    x1 = Math.min(NX - 1, x1 + 1); y1 = Math.min(NY - 1, y1 + 2); z1 = Math.min(NZ - 1, z1 + 1);
    for (let z = z0; z <= z1; z++) {
      for (let y = y0; y <= y1; y++) {
        const row = NX * (z + NZ * y);
        for (let x = x0; x <= x1; x++) this.push(row + x);
      }
    }
  }

  // -------------------------------------------------------------------------
  // BOUCLE
  // -------------------------------------------------------------------------

  /**
   * @param {number} dt
   * @param {number} budget nombre max de voxels examines
   */
  /**
   * Un pas de simulation = SUBSTEPS sous-pas d'avalanche.
   * Le controle structurel (surplombs) n'est evalue qu'au premier sous-pas :
   * il est cher, et 60 Hz suffisent largement a surveiller une rupture.
   */
  step(dt, budget = 90000) {
    const per = Math.max(1, (budget / SUBSTEPS) | 0);
    const sub = dt / SUBSTEPS;
    let acc = 0;
    for (let s = 0; s < SUBSTEPS; s++) {
      this.substep(sub, per, s === 0);
      acc += this.stats.processed;
    }
    this.stats.processed = acc;
  }

  substep(dt, budget, doStructural) {
    const t = this.cur; this.cur = this.next; this.next = t;
    for (let c = 0; c < 4; c++) {
      this.curLen[c] = this.nextLen[c];
      this.nextLen[c] = 0;
    }
    this.stats.active = this.curLen[0] + this.curLen[1] + this.curLen[2] + this.curLen[3];
    this.stats.processed = 0;
    if (doStructural) { this.stats.moved = 0; this.events.length = 0; }
    if (this.stats.active === 0) return;

    // Une passe par couleur. Deux voxels de la meme couleur ne sont jamais
    // lateralement adjacents, donc aucun conflit de transfert.
    const per = Math.max(1, (budget / 4) | 0);
    const off = (this.rand() * 4) | 0;
    for (let c = 0; c < 4; c++) {
      const color = (c + off) & 3;
      const list = this.cur[color];
      const len = this.curLen[color];
      const n = Math.min(len, per);
      for (let k = 0; k < n; k++) {
        const i = list[k];
        this.flag[i] = 0;
        const y = (i / SLICE) | 0;
        const r = i - y * SLICE;
        const z = (r / NX) | 0;
        const x = r - z * NX;
        this.processVoxel(x, y, z, i, dt, doStructural);
      }
      this.stats.processed += n;
      // Le reliquat repart dans la file (budget epuise).
      for (let k = n; k < len; k++) {
        const i = list[k];
        this.flag[i] = 0;
        this.push(i);
      }
    }
  }

  // -------------------------------------------------------------------------
  // REGLES
  // -------------------------------------------------------------------------

  processVoxel(x, y, z, i, dt, doStructural = true) {
    const F = this.field;
    const dens = F.density;
    const d = dens[i];
    if (d === 0) return;

    const below = y > 0 ? dens[i - SLICE] : 255;
    const m = F.moisture[i];
    const pk = F.packing[i];

    // --- 0. flambement d'un support trop mince ------------------------------
    // Une colonne de sable de 4 a 8 cm de large et de plusieurs dizaines de
    // centimetres de haut ne peut pas porter un gros chapeau, meme si chaque
    // voxel a techniquement un voxel plein dessous. Ce cas apparait surtout
    // quand l'eau ronge le pied d'un mur : sans ce test, il reste une aiguille
    // qui porte un pan entier, puis le pan semble flotter.
    const slender = below >= ISO && this.isSlenderSupport(x, y, z)
      && (y === 0 || !this.isSlenderSupport(x, y - 1, z));
    if (slender) {
      if (doStructural) {
        // Le flambement s'amorce au pied du troncon mince, pas dans chacun de
        // ses voxels a la fois. Le joueur voit un point de rupture puis la
        // masse descend, au lieu de voir toute la colonne gicler sur les cotes.
        const s = this.stress[i]
          + Math.max(1, Math.round(dt * SUBSTEPS * STRESS_RATE * 3));
        if (s < STRESS_BREAK) {
          this.stress[i] = s;
          this.push(i);
          return;
        }
        this.stress[i] = STRESS_BREAK - 1;
        this.buckleSupport(x, y, z, i, d);
      } else this.push(i); // survivre aux sous-pas sans controle structurel
      return;
    }

    // --- 1. rupture structurelle (rien dessous) ------------------------------
    // Tout ce bloc — accumulation ET retombee de la contrainte — doit etre
    // garde par doStructural. Sinon les trois sous-pas ou le controle est
    // eteint passent par la branche « tenu » et decrementent la contrainte
    // plus vite qu'elle ne monte : aucun surplomb ne cede jamais.
    if (doStructural && below < ISO) {
      if (this.checkSupport(x, y, z, m, pk)) {
        // Tenu : la contrainte retombe doucement.
        if (this.stress[i] > 0) this.stress[i] = Math.max(0, this.stress[i] - 2);
      } else {
        // +1 par pas de simulation : 200 pas, soit environ 3,3 secondes
        // d'avertissement avant que ca lache. L'ancien +14 donnait un quart de
        // seconde — le commentaire promettait 2 a 4 s, le code n'en tenait
        // rien, et la rupture paraissait arbitraire.
        // Increment proportionnel au temps ecoule, pour que la duree
        // d'avertissement ne depende pas de la cadence de la boucle.
        // `dt` recu ici est celui d'un sous-pas, mais on ne passe par cette
        // branche qu'une fois par pas complet : d'ou le facteur SUBSTEPS.
        const s = this.stress[i] + Math.max(1, Math.round(dt * SUBSTEPS * STRESS_RATE));
        if (s < STRESS_BREAK) {
          this.stress[i] = s;
          this.push(i); // on continue a surveiller
          return;
        }
        // Ca lache.
        this.stress[i] = 0;
        this.collapse(x, y, z, i, d, below);
        return;
      }
    } else if (below < ISO) {
      // Sous-pas sans controle structurel : le voxel est en l'air, la regle de
      // pente n'a rien a lui dire. On le REPORTE au sous-pas suivant. Sans ce
      // report il s'endormait aussitot, et sa contrainte — remise a jour un
      // sous-pas sur quatre — n'atteignait jamais le seuil de rupture.
      this.push(i);
      return;
    } else if (doStructural && this.stress[i] > 0) {
      this.stress[i] = Math.max(0, this.stress[i] - 3);
    }

    // --- 2. regle de pente ---------------------------------------------------
    // Seuls les voxels de surface (rien de solide juste au-dessus) coulent.
    const above = y + 1 < NY ? dens[i + SLICE] : 0;
    if (above >= ISO) return;

    // Denivellation maximale tenable : critere de Culmann, pas angle de repos.
    const maxDrop = maxDropByte(m, pk);
    if (maxDrop >= DROP_CAP) return; // materiau assez cohesif pour tout tenir
    const maxDropFar = maxDropFarByte(m, pk);
    const hSelf = this.localHeight(x, z, y);

    let bestExcess = 0;
    let bestDir = -1;
    let bestH = 0;
    let maxNear = 0;
    // Ordre tournant : evite les biais directionnels visibles (stries).
    const off = (this.rand() * 4) | 0;
    for (let k = 0; k < 4; k++) {
      const dir = LAT[(k + off) & 3];
      const nx = x + dir[0], nz = z + dir[1];
      if (nx < 0 || nz < 0 || nx >= NX || nz >= NZ) continue;
      const hN = this.localHeight(nx, nz, y);
      const drop = hSelf - hN;
      if (drop > maxNear) maxNear = drop;
      const excess = drop - maxDrop;
      if (excess > bestExcess) {
        bestExcess = excess;
        bestDir = (k + off) & 3;
        bestH = hN;
      }
    }

    // Second test, sur une base large : c'est lui qui empeche un mur de monter
    // indefiniment en marches d'escalier. On ne le fait que s'il y a du relief
    // et que le test de proximite n'a rien trouve — sur une plage plate, il ne
    // coute donc rien.
    if (bestDir < 0 && maxNear > 0.9 && maxDropFar < DROP_CAP * FAR_BASE) {
      for (let k = 0; k < 4; k++) {
        const dir = LAT[(k + off) & 3];
        const fx = x + dir[0] * FAR_BASE, fz = z + dir[1] * FAR_BASE;
        if (fx < 0 || fz < 0 || fx >= NX || fz >= NZ) continue;
        const hFar = this.localHeight(fx, fz, y);
        const excess = hSelf - hFar - maxDropFar;
        if (excess > bestExcess) {
          bestExcess = excess;
          bestDir = (k + off) & 3;
          // On evacue quand meme vers le voisin IMMEDIAT : la rupture se
          // propage ainsi de proche en proche, en cascade, au lieu de
          // teleporter la matiere a six voxels de la.
          const dn = LAT[(k + off) & 3];
          const nx = x + dn[0], nz = z + dn[1];
          bestH = (nx >= 0 && nz >= 0 && nx < NX && nz < NZ)
            ? this.localHeight(nx, nz, y)
            : hFar;
        }
      }
    }
    if (bestDir < 0) return;

    // Quantite deplacee : proportionnelle a l'exces, amortie.
    let amount = Math.round(bestExcess * DAMPING * 255 * 0.5);
    if (amount < 6) amount = 6;
    if (amount > MAX_TRANSFER) amount = MAX_TRANSFER;
    if (amount > d) amount = d;

    const dir = LAT[bestDir];
    const moved = this.transfer(x, y, z, i, x + dir[0], bestH, z + dir[1], amount);
    if (moved > 0) {
      this.stats.moved += moved;
      this.wake(x, y, z);
      this.wake(x + dir[0], Math.floor(bestH), z + dir[1]);
    }
  }

  /**
   * Hauteur de surface locale d'une colonne, en voxels (avec sous-voxel).
   * On sonde vers le bas depuis yStart+1 sur au plus KMAX voxels : au-dela, on
   * considere que la denivellation est "infinie" (falaise).
   */
  localHeight(x, z, yStart) {
    const dens = this.field.density;
    const col = x + NX * z;
    let yy = Math.min(NY - 1, yStart + 1);
    const yEnd = yStart - KMAX;
    for (; yy > yEnd; yy--) {
      if (yy < 0) return -0.5; // fond du monde
      const dv = dens[col + SLICE * yy];
      if (dv >= ISO) {
        const dAbove = yy + 1 < NY ? dens[col + SLICE * (yy + 1)] : 0;
        let frac = 0.5;
        if (dv !== dAbove) frac = clamp((dv - ISO) / (dv - dAbove), 0, 1);
        return yy + frac;
      }
    }
    return yEnd;
  }

  /**
   * Le voxel est-il retenu par la cohesion ?
   * Petit parcours en largeur dans la matiere, limite au rayon tenable, a la
   * recherche d'un voxel qui, lui, repose sur quelque chose.
   */
  checkSupport(x, y, z, m, pk) {
    const w = m / 255;
    const p = pk / 255;
    // Charge au-dessus : la compression augmente la cohesion (c'est ce qui
    // fait tenir les arches de gres — alleger une arche peut la faire tomber).
    const load = this.loadAbove(x, y, z);
    // Epaisseur reelle de la dalle en surplomb : une dalle epaisse porte plus
    // loin (le moment resistant croit avec l'epaisseur).
    const t = (1 + this.solidAbove(x, y, z)) * VOXEL;
    const R = maxOverhang(w, p, t, load) / VOXEL;
    if (R < 0.8) return false;
    const radius = Math.min(this.SUP_R, Math.round(R));
    if (radius < 1) return false;

    const dens = this.field.density;
    const S = this.SUP_S;
    const S2 = S * S;
    const R0 = this.SUP_R;
    const visit = this.supVisit;
    visit.fill(0);
    const stack = this.bfs;

    let head = 0, tail = 0;
    stack[tail++] = x + NX * (z + NZ * y);
    stack[tail++] = 0;
    visit[R0 + S * R0 + S2 * R0] = 1;

    while (head < tail) {
      const idx = stack[head++];
      const dist = stack[head++];
      const yy = (idx / SLICE) | 0;
      const rr = idx - yy * SLICE;
      const zz = (rr / NX) | 0;
      const xx = rr - zz * NX;

      // Repose-t-il sur quelque chose d'ANCRE ?
      // Se contenter de "il y a de la matiere dessous" ne suffit pas : la
      // rangee basse d'une dalle en porte-a-faux soutiendrait la rangee haute
      // et le surplomb se declarerait stable a l'infini. Il faut suivre la
      // colonne jusqu'au sol.
      if (yy === 0) return true;
      if (dens[idx - SLICE] >= ISO && this.groundedColumn(xx, yy - 1, zz)) return true;
      if (dist >= radius) continue;

      for (let k = 0; k < 6; k++) {
        let ax = xx, ay = yy, az = zz;
        if (k === 0) ax++; else if (k === 1) ax--;
        else if (k === 2) az++; else if (k === 3) az--;
        else if (k === 4) ay++; else ay--;
        if (ax < 0 || az < 0 || ay < 0 || ax >= NX || az >= NZ || ay >= NY) continue;
        const lx = ax - x + R0, ly = ay - y + R0, lz = az - z + R0;
        if (lx < 0 || ly < 0 || lz < 0 || lx >= S || ly >= S || lz >= S) continue;
        const vi = lx + S * ly + S2 * lz;
        if (visit[vi]) continue;
        const ni = ax + NX * (az + NZ * ay);
        if (dens[ni] < ISO) continue;
        visit[vi] = 1;
        if (tail + 2 > stack.length) return true; // pile pleine : on suppose tenu
        stack[tail++] = ni;
        stack[tail++] = dist + 1;
      }
    }
    return false;
  }

  /**
   * La colonne sous (x, y, z) descend-elle jusqu'au sol sans interruption ?
   * C'est le critere d'ancrage : seul un voxel pose sur une pile continue
   * jusqu'au fond peut servir d'appui a un surplomb.
   */
  groundedColumn(x, y, z) {
    const dens = this.field.density;
    const col = x + NX * z;
    let n = 0;
    let slenderRun = 0;
    for (let yy = y; yy >= 0; yy--) {
      const i = col + SLICE * yy;
      if (dens[i] < ISO) return false;

      // Une continuite verticale n'est pas necessairement un ancrage : un
      // fil de 4 cm de large sur plusieurs cellules ne peut pas transmettre
      // la charge d'une dalle. Sans cette verification, `checkSupport`
      // declarait le gros chapeau de la capture parfaitement « relie au sol ».
      let side = 0;
      if (x > 0 && dens[i - 1] >= ISO) side++;
      if (x + 1 < NX && dens[i + 1] >= ISO) side++;
      if (z > 0 && dens[i - NX] >= ISO) side++;
      if (z + 1 < NZ && dens[i + NX] >= ISO) side++;
      slenderRun = side <= 1 ? slenderRun + 1 : 0;
      if (slenderRun >= 4) return false;
      if (++n > 64) return true; // pile tres profonde : inutile d'aller plus loin
    }
    return true;
  }

  /** Nombre de voxels pleins consecutifs au-dessus (plafonne a 8). */
  solidAbove(x, y, z) {
    const dens = this.field.density;
    const col = x + NX * z;
    let n = 0;
    for (let k = 1; k <= 8; k++) {
      const yy = y + k;
      if (yy >= NY || dens[col + SLICE * yy] < ISO) break;
      n++;
    }
    return n;
  }

  /** Fraction de matiere sur les 8 voxels au-dessus (0..1). */
  loadAbove(x, y, z) {
    const dens = this.field.density;
    const col = x + NX * z;
    let sum = 0;
    for (let k = 1; k <= 8; k++) {
      const yy = y + k;
      if (yy >= NY) break;
      sum += dens[col + SLICE * yy];
    }
    return clamp(sum / (8 * 255), 0, 1);
  }

  /**
   * Detecte un fut de un a deux voxels de large sur au moins 16 cm.
   * Deux voisins lateraux pleins suffisent a former un mur/noyau stable ; on
   * ne vise ici que les fils isoles produits par une erosion partielle.
   */
  isSlenderSupport(x, y, z) {
    const dens = this.field.density;
    if (y + 3 >= NY) return false;
    const col = x + NX * z;
    let run = 0;
    for (let yy = y; yy < Math.min(NY, y + 10); yy++) {
      const i = col + SLICE * yy;
      if (dens[i] < ISO) break;
      let side = 0;
      if (x > 0 && dens[i - 1] >= ISO) side++;
      if (x + 1 < NX && dens[i + 1] >= ISO) side++;
      if (z > 0 && dens[i - NX] >= ISO) side++;
      if (z + 1 < NZ && dens[i + NX] >= ISO) side++;
      if (side >= 2) return false; // mur ou massif, pas une aiguille
      run++;
      if (run >= 4) return true;
    }
    return false;
  }

  /** Emiette le pied vers le voisin le plus bas, par petites quantites. */
  buckleSupport(x, y, z, i, d) {
    const targets = [];
    for (const dir of LAT) {
      const nx = x + dir[0], nz = z + dir[1];
      if (nx < 0 || nz < 0 || nx >= NX || nz >= NZ) continue;
      const h = this.localHeight(nx, nz, y);
      targets.push({ x: nx, z: nz, h });
    }
    if (targets.length === 0) return;
    targets.sort((a, b) => a.h - b.h);
    // Une fois le flambement annonce, l'appui doit effectivement passer sous
    // l'isoseuil. Un goutte-a-goutte de 18/255 engraissait son voisin jusqu'a
    // en faire un nouvel appui, puis la cassure remontait dans le fut sans
    // jamais liberer le bloc porte. Ici on ne deplace que la demi-cellule
    // necessaire a ouvrir la fissure, vers le sol lateral immediat.
    const breakAmount = Math.max(MAX_TRANSFER, d - (ISO - 1));
    let remaining = breakAmount;
    let moved = 0;
    for (const target of targets) {
      if (remaining <= 0) break;
      const amount = this.transfer(x, y, z, i, target.x, target.h, target.z, remaining);
      if (amount <= 0) continue;
      moved += amount;
      remaining -= amount;
      this.wake(target.x, Math.floor(target.h), target.z);
    }
    if (moved <= 0) return;
    this.stats.moved += moved;
    this.wake(x, y, z);

    // Le fluage a deja eu lieu pendant l'amincissement du pied : lorsque le
    // dernier appui passe sous ISO, le morceau superieur doit commencer a
    // descendre au pas suivant, pas rester suspendu trois secondes de plus.
    if (this.field.density[i] < ISO && y + 1 < NY) {
      this.severSlenderNeckTop(x, y, z);
      const above = i + SLICE;
      if (this.field.density[above] >= ISO) {
        this.stress[above] = STRESS_BREAK - 1;
        this.push(above);
      }
    } else if (this.field.density[i] >= ISO) {
      // Le pied a commence a plier : les petites tranches suivantes partent
      // sans reattendre tout le delai d'amorcage.
      this.stress[i] = STRESS_BREAK - 1;
      this.push(i);
    }
  }

  /**
   * Ouvre aussi la jonction entre un fut tres mince et la masse qu'il porte.
   * Le pied seul ne suffit pas : la colonne se telescoperait dans son propre
   * trou et le chapeau resterait exactement a la meme altitude. La rupture
   * haute detache le morceau porte ; elle ne deplace qu'une demi-cellule vers
   * une case laterale adjacente, donc aucune matiere ne se teleporte.
   */
  severSlenderNeckTop(x, y, z) {
    const F = this.field;
    const dens = F.density;
    const col = x + NX * z;
    let top = -1;
    let run = 0;
    for (let yy = y + 1; yy < Math.min(NY - 1, y + 14); yy++) {
      const i = col + SLICE * yy;
      if (dens[i] < ISO) break;
      let side = 0;
      if (x > 0 && dens[i - 1] >= ISO) side++;
      if (x + 1 < NX && dens[i + 1] >= ISO) side++;
      if (z > 0 && dens[i - NX] >= ISO) side++;
      if (z + 1 < NZ && dens[i + NX] >= ISO) side++;
      if (side >= 2) break;
      top = yy;
      run++;
    }
    if (run < 3 || top < 0 || top + 1 >= NY) return;

    const from = col + SLICE * top;
    let to = -1;
    let bestDensity = 256;
    for (const dir of LAT) {
      const xx = x + dir[0], zz = z + dir[1];
      if (xx < 0 || zz < 0 || xx >= NX || zz >= NZ) continue;
      const j = xx + NX * (zz + NZ * top);
      if (dens[j] < bestDensity) { bestDensity = dens[j]; to = j; }
    }
    if (to < 0) return;
    const amount = Math.min(dens[from] - (ISO - 1), 255 - dens[to]);
    if (amount <= 0 || this.transferTo(from, to, amount, 0.58) <= 0) return;
    this.wake(x, top, z);
    const above = from + SLICE;
    if (dens[above] >= ISO) {
      this.stress[above] = STRESS_BREAK - 1;
      this.push(above);
    }
  }

  /**
   * Effondrement d'un voxel non soutenu : il tombe d'un cran. La regle de
   * pente s'occupera de former l'eboulis.
   */
  collapse(x, y, z, i, d, below) {
    const F = this.field;
    const room = 255 - below;
    const amount = Math.min(d, room, MAX_TRANSFER * 2);
    if (amount <= 0) return;
    this.transferTo(i, i - SLICE, amount, 0.55);
    // Une fissure deja ouverte ne se « recolle » pas entre deux petits
    // transferts. Tant que ce meme voxel reste plein au-dessus du vide, il
    // poursuit sa chute au pas suivant. Sans cela, chaque tranche de 5 mm
    // attendait de nouveau tout le delai d'amorcage : un gros bloc pouvait
    // sembler flotter plusieurs dizaines de secondes sur un fil de sable.
    if (F.density[i] >= ISO && F.density[i - SLICE] < ISO) {
      this.stress[i] = STRESS_BREAK - 1;
    } else if (F.density[i] < ISO && y + 1 < NY) {
      // Le delai a deja ete paye au point de rupture. La fissure verticale
      // suit aussitot la disparition de l'appui, sans recreer un nouveau fil.
      const above = i + SLICE;
      if (F.density[above] >= ISO) {
        this.stress[above] = STRESS_BREAK - 1;
        this.push(above);
      }
    }
    this.stats.collapsed++;
    if (this.events.length < 24) {
      this.events.push({ type: 'collapse', x, y, z, amount });
    }
    this.wake(x, y, z);
    this.wake(x, y - 1, z);
    this.propagateCrack(x, y, z);
  }

  /**
   * Propagation de fissure.
   *
   * L'AMORCAGE d'une rupture est lent — c'est du fluage, il faut quelques
   * secondes, et c'est ce que compte `stress`. La PROPAGATION, elle, est
   * quasi instantanee : une fois qu'un point a lache, ses voisins portent sa
   * charge en plus de la leur et cedent dans la foulee. Sans ce transfert de
   * charge, une dalle de douze voxels mettrait quarante secondes a peler
   * voxel par voxel, alors qu'en vrai elle part d'un bloc.
   *
   * On ensemence donc les voisins non soutenus a 78 % du seuil : ils tiennent
   * encore trois ou quatre dixiemes de seconde — juste assez pour qu'on VOIE
   * la fissure courir — puis suivent.
   */
  propagateCrack(x, y, z) {
    const F = this.field;
    const dens = F.density;
    const seed = (STRESS_BREAK * 0.82) | 0;
    for (let dy = -1; dy <= 1; dy++) {
      const yy = y + dy;
      if (yy < 1 || yy >= NY) continue;
      for (let dz = -1; dz <= 1; dz++) {
        const zz = z + dz;
        if (zz < 0 || zz >= NZ) continue;
        for (let dx = -1; dx <= 1; dx++) {
          const xx = x + dx;
          if (xx < 0 || xx >= NX) continue;
          if (dx === 0 && dy === 0 && dz === 0) continue;
          const j = xx + NX * (zz + NZ * yy);
          if (dens[j] < ISO) continue;
          // Seuls les voisins qui sont eux aussi dans le vide.
          if (dens[j - SLICE] >= ISO) continue;
          if (this.stress[j] < seed) this.stress[j] = seed;
          this.push(j);
        }
      }
    }
  }

  /**
   * Deplace `amount` de densite du sommet de la colonne (x,z) vers le sommet
   * de la colonne voisine, a la hauteur hTarget.
   * @returns {number} quantite reellement deplacee
   */
  transfer(x, y, z, i, nx, hTarget, nz, amount) {
    const F = this.field;
    const dens = F.density;

    // Cible : le premier voxel avec de la place au-dessus de la surface voisine.
    let ty = Math.floor(hTarget);
    if (ty < 0) ty = 0;
    let ti = -1;
    for (let k = 0; k < 3; k++) {
      const yy = ty + k;
      if (yy >= NY) break;
      const j = nx + NX * (nz + NZ * yy);
      if (dens[j] < 255) { ti = j; break; }
    }
    if (ti < 0) return 0;
    const room = 255 - dens[ti];
    const a = Math.min(amount, room);
    if (a <= 0) return 0;
    return this.transferTo(i, ti, a, 0.6);
  }

  /**
   * Transfert elementaire entre deux voxels, avec melange de l'humidite et
   * perte de compaction (du sable qui coule se desserre).
   */
  transferTo(from, to, amount, packLoss) {
    const F = this.field;
    const dens = F.density;
    // La fondation n'est jamais une source de sable mobile. `writeVoxel`
    // refuse deja de l'amincir ; ce garde-fou empeche aussi de crediter la
    // destination quand le debit provient d'une couche indestructible.
    if (((from / SLICE) | 0) < FOUNDATION_LAYERS) return 0;
    const a = Math.min(amount, dens[from], 255 - dens[to]);
    if (a <= 0) return 0;

    const dTo = dens[to];
    const mFrom = F.moisture[from], pFrom = F.packing[from];

    // Melange pondere par les volumes.
    const total = dTo + a;
    const nm = (F.moisture[to] * dTo + mFrom * a) / total;
    const np = (F.packing[to] * dTo + pFrom * packLoss * a) / total;

    // Ecriture directe : on met a jour les compteurs de chunk a la main pour
    // eviter le cout de VoxelField.set() dans cette boucle tres chaude.
    this.writeVoxel(from, dens[from] - a);
    this.writeVoxel(to, dTo + a);
    if (dens[to] > 0) {
      F.moisture[to] = nm | 0;
      F.packing[to] = np | 0;
      F.material[to] = 1;
    }
    return a;
  }

  /** Ecriture bas niveau avec mise a jour des metadonnees. */
  writeVoxel(i, v) {
    const F = this.field;
    const dens = F.density;
    const old = dens[i];
    v = v < 0 ? 0 : v > 255 ? 255 : v | 0;
    const y = (i / SLICE) | 0;
    if (y < FOUNDATION_LAYERS && v < old) return;
    if (v === old) return;
    dens[i] = v;

    const r = i - y * SLICE;
    const z = (r / NX) | 0;
    const x = r - z * NX;

    const ci = chidx((x / CHUNK) | 0, (y / CHUNK) | 0, (z / CHUNK) | 0);
    if (old > 0 && v === 0) F.chunkSolid[ci]--;
    else if (old === 0 && v > 0) F.chunkSolid[ci]++;
    if (old >= ISO && v < ISO) F.chunkFull[ci]--;
    else if (old < ISO && v >= ISO) F.chunkFull[ci]++;

    if (v === 0) {
      F.moisture[i] = 0;
      F.packing[i] = 0;
      F.material[i] = 0;
      this.stress[i] = 0;
    }
    F.touch(x, y, z);
  }
}
