/**
 * Transport de l'eau DANS le sable (l'eau libre en surface, c'est Water.js).
 *
 * Quatre mecanismes, tous a l'oeuvre en meme temps sur une vraie plage :
 *
 *  1. PERCOLATION. Au-dela de la capacite au champ (~12 % pour du sable), la
 *     gravite fait descendre l'eau. C'est pourquoi un seau d'eau verse en haut
 *     de plage disparait en quelques secondes et laisse le sable "juste bien".
 *
 *  2. DIFFUSION / SUCCION. En dessous de la capacite au champ, l'eau se
 *     redistribue vers le plus sec par succion matricielle. Lent, mais c'est ce
 *     qui rattrape les gradients trop brutaux laisses par l'arrosoir.
 *
 *  3. FRANGE CAPILLAIRE. Au-dessus de la nappe, le sable reste humide sur
 *     20 a 40 cm par remontee capillaire. C'est le "sable gratuit" : creuser un
 *     trou assez profond donne acces a du sable parfait sans porter d'eau.
 *
 *  4. EVAPORATION. Seulement en surface, proportionnelle a l'ensoleillement et
 *     au vent. C'est l'horloge du jeu : une sculpture laissee au soleil
 *     s'asseche, perd sa cohesion, et finit par s'effriter.
 *
 * Le balayage est ROULANT : chaque tick traite une colonne sur STRIDE. Une
 * colonne est donc revisitee 10/STRIDE fois par seconde, ce qui est largement
 * suffisant pour un phenomene aussi lent, et le cout reste plat.
 */

import {
  NX, NY, NZ, ISO, VOXEL, ORIGIN_X, ORIGIN_Y, ORIGIN_Z, POROSITY,
  CAPILLARY_FRINGE, RESIDUAL_SATURATION, clamp, smoothstep,
} from '../core/Config.js';

const SLICE = NX * NZ;
const COLS = NX * NZ;

/** Capacite au champ : au-dela, l'eau percole au lieu de rester accrochee. */
export const FIELD_CAPACITY = 0.12;

/**
 * Facteurs d'acceleration par rapport a la physique reelle. Sans eux, une
 * partie durerait des heures : le sable met une demi-journee a secher au
 * soleil et l'eau met des minutes a percoler sur 50 cm. On garde les rapports
 * entre phenomenes, on comprime le temps.
 */
export const TIME_SCALE = {
  percolation: 55,
  diffusion: 60,
  evaporation: 150,
  capillary: 40,
};

/** Nombre de colonnes traitees par tick = COLS / STRIDE. */
const STRIDE = 16;
/**
 * Variation d humidite (sur 255) en dessous de laquelle on ne previent
 * personne : ni remaillage, ni reveil de la mecanique. Sans ce seuil, le
 * balayage roulant marquerait la moitie du terrain comme sale a chaque tick
 * et le mailleur ne ferait plus que ca.
 */
const NOTIFY_EPS = 4;
/**
 * Variation d humidite (sur 255) a partir de laquelle on REVEILLE la
 * mecanique granulaire, et bornes de categorie (sec 2 %, humide 4 %, liquide
 * 25 %) dont le franchissement reveille toujours. theta_max ne bouge guere
 * entre deux voxels « parfaits » a 10 et 12 % : reveiller a chaque unite
 * gardait 30 000 voxels actifs en permanence et 1,3 million d appels de
 * reveil par pas de simulation, sur une plage ou rien ne bougeait. C etait
 * la premiere cause du ralentissement au fil de la partie.
 */
const WAKE_EPS = 12;
const WAKE_BOUNDS = [5, 10, 64];
/** Frequence du solveur (Hz). */
const RATE = 10;

export class Moisture {
  /**
   * @param {import('./VoxelField.js').VoxelField} field
   * @param {import('./Granular.js').Granular} granular
   */
  constructor(field, granular) {
    this.field = field;
    this.granular = granular;

    /**
     * Altitude de la nappe sous chaque colonne, fournie par Water.
     * Tant que Water n'a pas demarre, on retombe sur une valeur plate.
     */
    this.tableH = null;
    this.waterTable = 1.03;
    /** Ensoleillement 0..1 et vent 0..1 : pilotent l'evaporation. */
    this.insolation = 0.7;
    this.wind = 0.25;

    this.phase = 0;
    this.acc = 0;
    /** Colonnes a traiter en priorite (arrosage, eau de surface). */
    this.urgent = [];
    this.urgentFlag = new Uint8Array(COLS);
    // --- PERF (colonnes chaudes / froides, debut) ---------------------------
    /**
     * Nombre de visites "pleine cadence" restantes, par colonne.
     *
     * L'essentiel du domaine est du sable a l'equilibre (saturation residuelle
     * en haut de plage, saturation totale sous la mer) : le parcourir voxel
     * par voxel dix fois par seconde ne produisait RIEN. Une colonne FROIDE
     * (hot == 0) n'est revisitee qu'un balayage sur quatre, avec un dt
     * multiplie d'autant — memes vitesses effectives, puisque tous les
     * coefficients sont fonction de dt, mais quatre fois moins de CPU.
     * Une colonne devient CHAUDE des qu'on y touche (outil, eau, voisinage)
     * ou des qu'une visite y detecte un vrai transport (pas la simple derive
     * d'evaporation d'un octet), et le reste quelques balayages.
     */
    this.hot = new Uint8Array(COLS);
    /** Compteur de balayages complets (un balayage = STRIDE ticks). */
    this.round = 0;
    /** Interrupteur A/B pour le profilage : false = ancien balayage integral. */
    this.eco = true;
    // --- PERF (colonnes chaudes / froides, fin) -----------------------------

    this.stats = { columns: 0, ms: 0, drained: 0 };

    /** Eau rendue au systeme de surface (percolation qui ressort). */
    this.seepOut = new Float32Array(COLS);
  }

  /** Signale une colonne modifiee : elle sera traitee au prochain tick. */
  touchColumn(x, z) {
    const c = x + NX * z;
    this.hot[c] = 6; // PERF : une colonne touchee repasse a pleine cadence
    if (this.urgentFlag[c]) return;
    this.urgentFlag[c] = 1;
    this.urgent.push(c);
  }

  touchBox(x0, z0, x1, z1) {
    x0 = Math.max(0, x0); z0 = Math.max(0, z0);
    x1 = Math.min(NX - 1, x1); z1 = Math.min(NZ - 1, z1);
    for (let z = z0; z <= z1; z++) {
      for (let x = x0; x <= x1; x++) this.touchColumn(x, z);
    }
  }

  /**
   * @param {number} dt secondes
   * @param {number} insolation 0..1 (hauteur du soleil)
   */
  step(dt, insolation = this.insolation) {
    this.insolation = insolation;
    this.acc += dt;
    const period = 1 / RATE;
    let ticks = 0;
    while (this.acc >= period && ticks < 3) {
      this.acc -= period;
      this.tick(period);
      ticks++;
    }
  }

  tick(dt) {
    const t0 = performance.now();
    let n = 0;

    // 1. colonnes urgentes (le joueur vient d'y toucher)
    //
    // PERF : traitement PLAFONNE. Le ressac (infiltration + erosion) touche
    // des milliers de colonnes par tick ; les resoudre toutes immediatement
    // coutait ~7 ms du tick de 9 ms. On en traite un quota par tick, le reste
    // attend le suivant (la file est dedupliquee par urgentFlag, et chaque
    // colonne touchee est de toute facon passee "chaude", donc rattrapee par
    // le balayage en moins de deux secondes). L'arrosoir du joueur touche
    // quelques dizaines de colonnes : lui reste servi dans le tick meme.
    const URGENT_MAX = this.eco ? 768 : 1e9;
    const urg = this.urgent;
    const take = Math.min(urg.length, URGENT_MAX);
    for (let k = 0; k < take; k++) {
      const c = urg[k];
      this.urgentFlag[c] = 0;
      this.solveColumn(c % NX, (c / NX) | 0, dt);
      n++;
    }
    if (take < urg.length) {
      urg.copyWithin(0, take);
      urg.length -= take;
    } else {
      urg.length = 0;
    }

    // 2. balayage roulant du reste
    this.phase = (this.phase + 1) % STRIDE;
    if (this.phase === 0) this.round++;
    // PERF : les colonnes froides ne sont visitees qu'un balayage sur quatre
    // (voir this.hot). La cle (c >> 4) & 3 etale ces visites dans l'espace.
    const coldKey = this.round & 3;
    const hot = this.hot;
    for (let c = this.phase; c < COLS; c += STRIDE) {
      if (!this.eco || hot[c] > 0) {
        if (hot[c] > 0) hot[c]--;
        // dt effectif : la colonne n'a pas ete vue depuis STRIDE ticks.
        this.solveColumn(c % NX, (c / NX) | 0, dt * STRIDE, 1);
        n++;
      } else if (((c >> 4) & 3) === coldKey) {
        // Colonne froide : visite au quart de la cadence, dt multiplie
        // d'autant. Seul touchColumn (outil, eau, vrai transfert de voisine)
        // rechauffe une colonne : l'equilibre evaporation/diffusion, qui fait
        // trembler quelques octets a chaque visite, ne doit PAS la reveiller —
        // c'est precisement le travail qu'on cherche a ne plus payer.
        // Le multiplicateur est transmis pour que les seuils de notification
        // restent les memes PAR SECONDE : sans cela, la derive d'evaporation,
        // servie en pas quatre fois plus gros, franchissait NOTIFY_EPS et
        // reveillait la mecanique granulaire sur toute la plage seche.
        this.solveColumn(c % NX, (c / NX) | 0, dt * STRIDE * 4, 4);
        n++;
      }
    }

    this.stats.columns = n;
    this.stats.ms = this.stats.ms * 0.85 + (performance.now() - t0) * 0.15;
  }

  /**
   * Resout une colonne complete de haut en bas.
   * Le sens est important : on transporte l'eau vers le bas en une seule
   * passe, comme une vraie infiltration.
   * @returns {number} activite de la passe : somme des |variations| d'octets
   *   d'humidite. PERF : pilote la cadence chaud/froid des colonnes — la
   *   derive d'evaporation (1 octet par visite) reste sous le seuil, un vrai
   *   transport (percolation, arrosage, infiltration) le depasse.
   * @param {number} dtMult multiplicateur de cadence applique a dt (1 pour une
   *   colonne chaude, 4 pour une froide) : les seuils de notification en sont
   *   multiplies pour rester equivalents PAR SECONDE.
   */
  solveColumn(x, z, dt, dtMult = 1) {
    const F = this.field;
    const dens = F.density;
    const mois = F.moisture;
    const col = x + NX * z;
    let activity = 0;

    const top = F.topY[col];
    if (top < 0) return 0;

    const table = this.tableH ? this.tableH[col] : this.waterTable;
    const tableY = (table - ORIGIN_Y) / VOXEL - 0.5;

    // --- coefficients ---------------------------------------------------------
    // Percolation : vitesse de Darcy ramenee en "fraction de voxel par pas".
    const kPerc = clamp((4.0e-3 * TIME_SCALE.percolation * dt) / VOXEL, 0, 0.9);
    // Diffusion verticale et laterale.
    const kDiff = clamp((5.0e-4 * TIME_SCALE.diffusion * dt) / (VOXEL * VOXEL), 0, 0.12);
    // Evaporation : lame d'eau perdue, convertie en saturation sur un voxel.
    const evapRate = 1.25e-7 * TIME_SCALE.evaporation *
      (0.25 + 0.75 * this.insolation) * (1 + 0.8 * this.wind);
    const kEvap = clamp((evapRate * dt) / (VOXEL * POROSITY), 0, 0.5);
    // Retour vers l'equilibre capillaire.
    const kCap = clamp(0.9 * TIME_SCALE.capillary * dt * 0.02, 0, 0.6);

    let carry = 0; // eau qui descend, en unites de saturation*voxel

    const bottom = Math.max(0, F.floorY[col]);
    for (let y = top; y >= bottom; y--) {
      const i = col + SLICE * y;
      if (dens[i] < ISO) { continue; }

      let w = mois[i] / 255;

      // --- eau qui arrive d'en haut ---
      if (carry > 0) {
        const room = 1 - w;
        const take = Math.min(carry, room);
        w += take;
        carry -= take;
      }

      // --- equilibre capillaire impose par la nappe ---
      const above = (y - tableY) * VOXEL;
      let wEq;
      if (above <= 0) {
        wEq = 1;
      } else {
        const t = above / CAPILLARY_FRINGE;
        // Au-dela de la frange, on ne tombe pas a zero : il reste la saturation
        // residuelle. Seule l'evaporation, plus bas, assechera la surface.
        wEq = t >= 1
          ? RESIDUAL_SATURATION
          : RESIDUAL_SATURATION + (0.95 - RESIDUAL_SATURATION) * Math.pow(1 - t, 1.6);
      }
      // On ne tire que vers le HAUT depuis la nappe : elle humidifie, elle
      // n'asseche pas. Ce sont la percolation et l'evaporation qui assechent.
      //
      // Et surtout : la remontee capillaire n'agit que DANS la frange. Au-dela,
      // la saturation residuelle n'est qu'un equilibre lointain vers lequel le
      // sable derive tres lentement. Sans cette distinction, la croute seche de
      // surface se faisait repomper a l'humidite residuelle en quelques
      // secondes, et le gradient qui recompense le creusement disparaissait.
      if (wEq > w) {
        const k = above < CAPILLARY_FRINGE ? kCap : kCap * 0.035;
        w += (wEq - w) * k;
      }

      // --- percolation : l'exces au-dessus de la capacite au champ descend ---
      // PERF + physique : UNIQUEMENT AU-DESSUS DE LA NAPPE. Sous la nappe les
      // pores sont deja pleins, l'eau n'a nulle part ou aller — l'ancienne
      // version faisait percoler les 16 000 colonnes du fond de la mer en
      // boucle (percolation -> carry -> seepOut jamais consomme -> remontee
      // capillaire), un cycle a somme nulle qui coutait la moitie du tick.
      const excess = w - FIELD_CAPACITY;
      if (excess > 0 && y > bottom && (above > 0 || !this.eco)) {
        const flux = excess * kPerc;
        w -= flux;
        carry += flux;
      }

      // --- diffusion verticale ---
      // La conductivite hydraulique NON SATUREE s'effondre quand le sable
      // seche : les ponts d'eau entre grains se rompent et il n'y a plus de
      // chemin continu. C'est exactement ce qui fait qu'une plage au soleil se
      // couvre d'une croute seche de quelques centimetres au-dessus d'un sable
      // resté humide — et non que les 30 premiers centimetres sechent d'un
      // bloc. Sans ce facteur, l'evaporation de surface se propageait vers le
      // bas et effacait tout le gradient.
      const kLocal = kDiff * (0.04 + 0.96 * smoothstep(0.015, 0.14, w));
      if (y > 0) {
        const j = i - SLICE;
        if (dens[j] >= ISO) {
          const wb = mois[j] / 255;
          const f = (wb - w) * kLocal * (0.04 + 0.96 * smoothstep(0.015, 0.14, wb));
          w += f;
          const njb = Math.round(clamp(wb - f, 0, 1) * 255);
          if (njb !== mois[j]) {
            activity += njb > mois[j] ? njb - mois[j] : mois[j] - njb;
            mois[j] = njb;
          }
        }
      }

      // --- diffusion laterale (4 voisins) ---
      // Uniquement dans les 40 premiers centimetres : plus bas, les gradients
      // lateraux sont negligeables et le cout ne se justifie pas.
      if (kLocal > 0.002 && top - y < 10) {
        for (let k = 0; k < 4; k++) {
          const nx = x + (k === 0 ? 1 : k === 1 ? -1 : 0);
          const nz = z + (k === 2 ? 1 : k === 3 ? -1 : 0);
          if (nx < 0 || nz < 0 || nx >= NX || nz >= NZ) continue;
          const j = nx + NX * (nz + NZ * y);
          if (dens[j] < ISO) continue;
          const wn = mois[j] / 255;
          const f = (wn - w) * kLocal * 0.5 *
            (0.04 + 0.96 * smoothstep(0.015, 0.14, wn));
          w += f;
          const njb = Math.round(clamp(wn - f, 0, 1) * 255);
          if (njb !== mois[j]) {
            const d = njb > mois[j] ? njb - mois[j] : mois[j] - njb;
            activity += d;
            mois[j] = njb;
            // PERF : la voisine ne repasse a pleine cadence que pour un VRAI
            // transfert. Reveiller sur 1 octet (le bruit d'arrondi de la
            // diffusion a l'equilibre) propageait l'etat chaud de proche en
            // proche jusqu'a rechauffer tout le domaine.
            if (d >= 3 && this.hot[nx + NX * nz] < 2) this.hot[nx + NX * nz] = 2;
          }
        }
      }

      // --- evaporation : uniquement les voxels exposes ---
      if (y === top || (y + 1 < NY && dens[i + SLICE] < ISO)) {
        // Le sable sature en surface s'evapore vite, le sable deja sec beaucoup
        // moins (la croute freine les echanges).
        w -= kEvap * (0.15 + 0.85 * smoothstep(0.0, 0.25, w));
      }

      w = clamp(w, 0, 1);
      // ARRONDIR, surtout pas tronquer. Une colonne est revisitee des dizaines
      // de fois par minute ; avec une troncature, chaque aller-retour
      // octet -> flottant -> octet perdait jusqu'a une unite, et le sable se
      // vidait tout seul de son humidite en une trentaine de secondes.
      const nb = Math.round(w * 255);
      const prev = mois[i];
      if (nb !== prev) {
        mois[i] = nb;
        activity += nb > prev ? nb - prev : prev - nb;
        // Seuil proportionnel a la cadence : meme sensibilite PAR SECONDE
        // qu'une colonne visitee a pleine cadence.
        const eps = NOTIFY_EPS * dtMult;
        const delta = nb > prev ? nb - prev : prev - nb;
        if (delta >= eps) {
          F.touchVisual(x, y, z);
          // Un changement d humidite change theta_max : on reveille la
          // mecanique, mais seulement quand il est assez grand pour que
          // l angle de repos change, ou qu une borne de categorie est franchie.
          if (this.granular && (delta >= WAKE_EPS * dtMult
              || (prev < WAKE_BOUNDS[0]) !== (nb < WAKE_BOUNDS[0])
              || (prev < WAKE_BOUNDS[1]) !== (nb < WAKE_BOUNDS[1])
              || (prev < WAKE_BOUNDS[2]) !== (nb < WAKE_BOUNDS[2]))) {
            this.granular.push(i);
          }
        }
      }
    }

    // L'eau qui a traverse toute la colonne ressort (nappe / suintement).
    if (carry > 0.001) {
      this.seepOut[col] += carry;
      this.stats.drained += carry;
      activity += 4; // du transit vertical est en cours : on reste eveille
    }
    return activity;
  }

  /**
   * Mouille une sphere (arrosoir, seau d'eau, vague).
   * @param {number} amount saturation ajoutee au centre (0..1)
   */
  wetSphere(wx, wy, wz, radius, amount) {
    const F = this.field;
    const r = radius / VOXEL;
    const cx = (wx - ORIGIN_X) / VOXEL - 0.5;
    const cy = (wy - ORIGIN_Y) / VOXEL - 0.5;
    const cz = (wz - ORIGIN_Z) / VOXEL - 0.5;
    const x0 = Math.max(0, Math.floor(cx - r)), x1 = Math.min(NX - 1, Math.ceil(cx + r));
    const y0 = Math.max(0, Math.floor(cy - r)), y1 = Math.min(NY - 1, Math.ceil(cy + r));
    const z0 = Math.max(0, Math.floor(cz - r)), z1 = Math.min(NZ - 1, Math.ceil(cz + r));
    const r2 = r * r;
    for (let z = z0; z <= z1; z++) {
      for (let y = y0; y <= y1; y++) {
        for (let x = x0; x <= x1; x++) {
          const dx = x - cx, dy = y - cy, dz = z - cz;
          const d2 = dx * dx + dy * dy + dz * dz;
          if (d2 > r2) continue;
          const i = x + NX * (z + NZ * y);
          if (F.density[i] < ISO) continue;
          const fall = 1 - Math.sqrt(d2) / r;
          const w = F.moisture[i] / 255 + amount * fall * fall;
          const nb = Math.round(clamp(w, 0, 1) * 255);
          if (nb !== F.moisture[i]) {
            F.moisture[i] = nb;
            F.touchVisual(x, y, z);
            if (this.granular) this.granular.push(i);
          }
        }
      }
    }
    this.touchBox(x0, z0, x1, z1);
  }
}
