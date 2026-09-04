/**
 * Generateur de houle.
 *
 * Produit un spectre de mer irregulier : cinq composantes de periodes voisines
 * modulees par une enveloppe de groupe lente. Le solveur en eaux peu profondes
 * recoit cette houle dans une ZONE DE RELAXATION collee au mur du large
 * (Water.bandWall) : la hauteur d'eau et le flux y sont progressivement
 * ramenes vers l'onde cible. Le solveur propage ensuite tout seul : levee sur
 * le haut-fond, deferlement, jet de rive, courants de retour.
 *
 * C'est le point de tout le systeme : on ne SCRIPTE pas les vagues, on les
 * injecte au large et on laisse le solveur faire le travail. Les constructions
 * du joueur changent directement la physique des vagues : une douve avale le
 * volume du jet, un brise-lames force le deferlement plus au large, une breche
 * concentre un courant d'arrachement. Rien de tout ca n'a a etre code.
 *
 * La zone de relaxation sert AUSSI de zone absorbante. Le melange progressif
 * vers l'etat cible genere l'onde incidente ET annule tout ce qui revient du
 * rivage : une onde sortante n'est pas dans l'etat cible, donc elle se fait
 * manger. Une condition de Dirichlet reflechissait 100 % du retrait et
 * transformait le domaine en baignoire resonnante.
 *
 * Au-dela du mur, la mer est IMPOSEE (voir Water.imposeOpenSea) avec le meme
 * spectre, echantillonne sur une grille grossiere : le raccord est continu.
 *
 * ECHELLE. La mer est profonde de 90 cm au large : c'est un modele de Froude
 * au 1:10 d'une plage de 100 m. Les equations de Saint-Venant sont invariantes
 * par (longueurs x L, temps x sqrt(L)), donc une "Houle" de 18 cm et 2,6 s EST
 * une houle de 1,8 m et 8,2 s. Le solveur, lui, n'a rien a savoir de tout ca :
 * il resout a l'echelle 1:1 du bac. Seul le NOMMAGE se fait a l'echelle
 * reelle.
 */

import {
  WATER_NX as WN, WATER_NZ as WM, WATER_CELL as WC, ORIGIN_X, ORIGIN_Z, GRAVITY,
  H_GEN, W_RELAX, RELAX_P, N_COMP, C_IG, TIDE_GATE, HFACE_CAP,
  clamp,
} from '../core/Config.js';
import { SHORE_NX, SHORE_NZ, beachProfile, shoreDistance } from '../world/BeachGenerator.js';

const COLS = WN * WM;

/**
 * Ecarts relatifs de frequence des composantes.
 *
 * Mutuellement irrationnels : sans ca la superposition se repete avec une
 * periode courte et le joueur l'entend. Le battement dominant est celui de la
 * paire 1-3 (df = 0,137), soit un groupe toutes les 7,3 vagues — c'est la
 * fameuse "septieme vague", et elle sort toute seule.
 */
const DF = [-0.137, -0.061, 0.0, 0.072, 0.151];
/** Ecarts d'incidence (rad), multiplies par l'etalement directionnel. */
const DTHETA = [-0.21, -0.09, 0.0, 0.11, 0.19];

/**
 * Les six etats de mer.
 *
 * Hs en progression geometrique de raison ~2,1 : chaque cran doit etre
 * franchement plus gros que le precedent. Tp croit avec Hs comme dans la nature
 * (loi fetch-limitee reduite par Froude), en restant assez long pour garder
 * xi0 > 1, donc des deferlantes PLONGEANTES — les plus photogeniques — plutot
 * que glissantes.
 *
 * Les colonnes derivees (r2, run) sont les valeurs de Stockdon et al. (2006)
 * calculees pour la pente reelle de notre face de plage (beta = 0,21) ; elles
 * ne pilotent rien dans le solveur, elles servent a l'interface, au telegraphe
 * et aux tests de non-regression.
 */
export const SEA_STATES = [
  { key: 'glass', label: 'Mer d\'huile', sub: 'La mer ne bouge pas. Pour construire tranquillement.',
    hs: 0.000, tp: 0.0, agit: 0.00, r2: 0.000, run: 0.00 },
  { key: 'lap', label: 'Clapot', sub: 'Un petit clapot qui leche le bas de la plage.',
    hs: 0.040, tp: 1.6, agit: 0.25, r2: 0.069, run: 0.33 },
  { key: 'small', label: 'Petites vagues', sub: 'Elles montent, elles redescendent. Rien de mechant.',
    hs: 0.090, tp: 2.0, agit: 0.40, r2: 0.130, run: 0.62 },
  { key: 'swell', label: 'Houle', sub: 'De vraies vagues. Elles deferlent et courent sur le sable.',
    hs: 0.180, tp: 2.6, agit: 0.55, r2: 0.239, run: 1.14 },
  { key: 'big', label: 'Grosse houle', sub: 'Ca tape. Prevoyez une douve.',
    hs: 0.300, tp: 3.1, agit: 0.75, r2: 0.368, run: 1.75 },
  { key: 'storm', label: 'Tempete', sub: 'La mer reprend tout. Vous etes prevenu.',
    hs: 0.450, tp: 3.6, agit: 1.00, r2: 0.524, run: 2.49 },
];

/** Les quatre crans d'agitation exposes au joueur. */
export const AGITATIONS = [
  { label: 'Reguliere', sub: 'Des vagues bien alignees, toujours pareilles.', a: 0.10 },
  { label: 'Naturelle', sub: 'Elles arrivent par series, avec des accalmies.', a: 0.40 },
  { label: 'Nerveuse', sub: 'Mer courte et desordonnee. Ca pilonne.', a: 0.70 },
  { label: 'Dechainee', sub: 'Aucun repit, aucune regularite.', a: 1.00 },
];

/** Les quatre crans de "ce que la mer abime". */
export const DAMAGE_LEVELS = [
  { label: 'Rien', sub: 'La mer mouille et deplace l eau, mais ne creuse rien.',
    attack: 0, erosion: false },
  { label: 'Juste le sable meuble', sub: 'Le sable en vrac part ; le sable dame tient.',
    attack: 0.22, erosion: true },
  { label: 'Normal', sub: 'Un mur bien dame resiste a la houle, pas a la tempete.',
    attack: 0.60, erosion: true },
  { label: 'Impitoyable', sub: 'Tout finit par ceder.',
    attack: 1.20, erosion: true },
];

export class WaveField {
  /** @param {import('./Water.js').Water} water */
  constructor(water) {
    this.water = water;

    /** Poids de relaxation : 0 = solveur libre, 1 = etat impose. */
    this.alpha = new Float32Array(COLS);
    /**
     * Abscisse cross-shore (m), CROISSANTE VERS LA TERRE.
     *
     * C'est exactement la distance signee au rivage moyen, donc le meme champ
     * que Water.shore. Attention au signe : la normale (SHORE_NX, SHORE_NZ)
     * de BeachGenerator pointe VERS LA MER, la houle se propage donc dans le
     * sens -n, c'est-a-dire dans le sens des sx croissants.
     */
    this.sx = new Float32Array(COLS);
    /** Abscisse le long du rivage (m), pour l'etalement directionnel. */
    this.sy = new Float32Array(COLS);
    /** Bornes en x, par ligne, des cellules simulees ou alpha > 0. */
    this.bandA = new Int32Array(WM).fill(WN);
    this.bandB = new Int32Array(WM).fill(-1);

    this.time = 0;
    /** Incremente a chaque reconstruction des bandes : le GPU recharge alpha, sx, sy. */
    this.bandsVersion = 0;
    this.stateIndex = 2;          // "Petites vagues" : voir setState
    this.agitIndex = 1;           // "Naturelle"
    this.hs = 0.09;
    this.tp = 2.0;
    /**
     * PUISSANCE, 0..1 : la periode de la houle, de 1,8 s (clapot court) a
     * 4,8 s (houle longue). A hauteur egale, une vague longue porte bien plus
     * d'energie, deferle en plongeant et court plus loin sur le sable. C'est
     * aussi ce qui dose les embruns projetes par le rouleau (Water.spray).
     * A l'echelle 1:10 du bac, 3 s de periode sont une houle de 9,5 s.
     */
    this.power = 0.23;
    this.agitation = 0.40;
    /** Incidence par rapport a la normale au rivage (rad). ~16 degres. */
    this.incidence = 0.28;
    /** k_T, ecretage de la houle par la maree (§7.2 du document). */
    this.tideGate = TIDE_GATE;
    this.enabled = true;

    /** Amplitudes, pulsations, nombres d'onde, phases. */
    this.a = new Float32Array(N_COMP);
    this.w = new Float32Array(N_COMP);
    this.kx = new Float32Array(N_COMP);
    this.ky = new Float32Array(N_COMP);
    this.ph = new Float32Array(N_COMP);
    for (let i = 0; i < N_COMP; i++) this.ph[i] = Math.random() * Math.PI * 2;

    /** Etat courant, lu par l'interface, l'audio et les tests. */
    this.hsEffective = 0;
    this.setupHeight = 0;
    this.runup2 = 0;
    this.groupAmp = 1;
    this.etaIg = 0;
    this.sGenInner = -2.6;
    this.hGen = H_GEN;
    this.cRef = Math.sqrt(GRAVITY * H_GEN);
    this.wavelength = 0;
    this.breakDepth = 0;

    /** Tampons de la recurrence de phase (voir applyGeneration). */
    this._cs = new Float64Array(N_COMP);
    this._sn = new Float64Array(N_COMP);
    this._cd = new Float64Array(N_COMP);
    this._sd = new Float64Array(N_COMP);

    this._bandsSea = -99;
    this._bandsWall = NaN;
    this._reSpec = 1;
    this.buildGeometry();
    this.setState(this.stateIndex);
  }

  // -------------------------------------------------------------------------
  // GEOMETRIE
  // -------------------------------------------------------------------------

  /** Abscisses cross-shore / longshore : recalculees quand le style de plage change. */
  buildGeometry() {
    for (let z = 0; z < WM; z++) {
      const wz = ORIGIN_Z + (z + 0.5) * WC;
      for (let x = 0; x < WN; x++) {
        const wx = ORIGIN_X + (x + 0.5) * WC;
        const c = x + WN * z;
        // Meme convention que shoreDistance() sans le bruit : > 0 cote terre.
        this.sx[c] = shoreDistance(wx, wz, null);
        this.sy[c] = -SHORE_NZ * wx + SHORE_NX * wz;
      }
    }
  }

  /**
   * Recalcule le masque de relaxation.
   *
   * La zone de relaxation est collee au MUR DU LARGE (Water.bandWall) : alpha
   * vaut 1 sur le mur et retombe a 0 W_RELAX cellules plus loin vers la terre,
   * suivant un profil exponentiel (un profil lineaire laisse passer une
   * reflexion residuelle audible). Le mur suit la maree et l'etat de mer, donc
   * la zone aussi. Tout est mesure sur le profil D'ORIGINE (beachProfile), pas
   * sur surfaceH : un trou creuse au large ne doit pas deplacer la ligne de
   * generation, sinon le joueur pourrait deregler la mer a la pelle.
   */
  buildBands(force = false) {
    const W = this.water;
    // Le niveau courant, surcote comprise : c'est la vraie profondeur au mur.
    const still = W.seaLevel;
    const wall = Number.isFinite(W.bandWall) ? W.bandWall : -1e9;
    if (!force && Math.abs(still - this._bandsSea) < 0.01 && wall === this._bandsWall) return;
    this._bandsSea = still;
    this._bandsWall = wall;

    const width = W_RELAX * WC;
    this.sGenInner = wall + width;
    // Profondeur utile : celle du mur (alpha = 1), la ou la vague est
    // reellement imposee. Elle borne Hs_eff a 0,6 h (voir rebuildSpectrum) ;
    // la bande est dimensionnee par Water.updateBand pour ne pas la brider.
    this.hGen = Math.max(0.05, still - beachProfile(wall));
    // Celerite de reference : celle du bord INTERIEUR, la ou le solveur prend
    // le relais. La longueur d'onde du generateur se raccorde ainsi sans saut.
    const hRef = clamp(still - beachProfile(this.sGenInner), H_GEN, HFACE_CAP);
    this.cRef = Math.sqrt(GRAVITY * hRef);

    const denom = Math.E - 1;
    const alpha = this.alpha, sxA = this.sx;
    const sim = W.simMask, reach = W.reachMask;
    for (let z = 0; z < WM; z++) {
      const row = WN * z;
      let first = WN, last = -1;
      for (let x = 0; x < WN; x++) {
        const c = row + x;
        const t = clamp((this.sGenInner - sxA[c]) / width, 0, 1);
        // La relaxation n'impose l'onde qu'aux cellules que la mer atteint :
        // derriere un mur construit au large, le solveur seul decide.
        const a = t <= 0 || (reach && !reach[c]) ? 0 : (Math.exp(Math.pow(t, RELAX_P)) - 1) / denom;
        alpha[c] = a;
        if (a > 0.001 && (!sim || sim[c])) { if (x < first) first = x; last = x; }
      }
      this.bandA[z] = first;
      this.bandB[z] = last;
    }
    this.bandsVersion++;
  }

  /**
   * Echantillonne l'elevation du spectre sur une grille grossiere (un point
   * toutes les `step` cellules), avec la meme recurrence de phase que
   * applyGeneration. C'est ce que lit la mer imposee au-dela du mur : le
   * spectre y est exact aux points de la grille et lineaire entre eux, ce que
   * l'oeil ne distingue pas d'une houle de plusieurs metres de long.
   */
  sampleEtaGrid(out, gw, gh, step) {
    if (!this.enabled || this.hsEffective <= 0) { out.fill(0); return; }
    const a = this.a, kx = this.kx, ky = this.ky, w = this.w, ph = this.ph;
    const cs = this._cs, sn = this._sn, cd = this._cd, sd = this._sd;
    const gAmp = this.groupAmp, ig = this.etaIg;
    for (let i = 0; i < N_COMP; i++) {
      const d = step * WC * (kx[i] * SHORE_NX + ky[i] * SHORE_NZ);
      cd[i] = Math.cos(d); sd[i] = Math.sin(d);
    }
    for (let gz = 0; gz < gh; gz++) {
      const z = Math.min(WM - 1, gz * step);
      const c0 = WN * z;
      for (let i = 0; i < N_COMP; i++) {
        const th = w[i] * this.time - kx[i] * this.sx[c0] - ky[i] * this.sy[c0] + ph[i];
        cs[i] = Math.cos(th); sn[i] = Math.sin(th);
      }
      for (let gx = 0; gx < gw; gx++) {
        let eta = 0;
        for (let i = 0; i < N_COMP; i++) {
          eta += a[i] * cs[i];
          const nc = cs[i] * cd[i] - sn[i] * sd[i];
          sn[i] = sn[i] * cd[i] + cs[i] * sd[i];
          cs[i] = nc;
        }
        out[gx + gw * gz] = eta * gAmp + ig;
      }
    }
  }

  // -------------------------------------------------------------------------
  // SPECTRE
  // -------------------------------------------------------------------------

  /** Applique l'un des six niveaux. */
  setState(i) {
    i = clamp(i | 0, 0, SEA_STATES.length - 1);
    const s = SEA_STATES[i];
    this.stateIndex = i;
    this.hs = s.hs;
    this.tp = s.tp;
    this.power = clamp((s.tp - 1.8) / 3.0, 0, 1);
    this.enabled = s.hs > 0;
    this.buildBands(true);
    this.rebuildSpectrum();
    return s;
  }

  /** Reglage continu : hauteur significative (m) et puissance (0..1). */
  setCustom(hs, power) {
    this.hs = clamp(hs, 0, 0.80);
    this.power = clamp(power, 0, 1);
    this.tp = 1.8 + 3.0 * this.power;
    this.enabled = this.hs > 0.004;
    this.stateIndex = -1;
    this.buildBands(true);
    this.rebuildSpectrum();
  }

  /** Applique l'un des quatre crans d'agitation. */
  setAgitation(i) {
    i = clamp(i | 0, 0, AGITATIONS.length - 1);
    this.agitIndex = i;
    this.agitation = AGITATIONS[i].a;
    this.rebuildSpectrum();
    return AGITATIONS[i];
  }

  /**
   * Recalcule amplitudes / pulsations / nombres d'onde.
   *
   * Spectre etroit facon JONSWAP : N composantes autour de f_p, ponderees par
   * une gaussienne de largeur relative sigma, puis normalisees par le moment
   * d'ordre 0 :   Hs = 4 sqrt(m0),  m0 = SUM a_i^2 / 2   =>   SUM a_i^2 = Hs^2/8
   *
   * L'agitation elargit le spectre ET l'etalement directionnel : une mer
   * "nerveuse" est une mer dont l'energie est repartie sur plus de frequences
   * et plus de directions. Une houle longue venue de loin est etroite. Meme Hs,
   * deux mers totalement differentes — c'est ce que le joueur appelle
   * "l'intensite".
   */
  rebuildSpectrum() {
    const W = this.water;
    // Ecretage par la maree : sans lui, "Tempete" a pleine mer noie le domaine
    // entier, arriere-plage comprise. Aucune strategie de placement ne survit,
    // et ce n'est plus dramatique, juste frustrant.
    const gate = 1 - this.tideGate * Math.max(0, W ? W.tide : 0);
    // Limitation par la profondeur : une vague plus haute que 0,60 h a deja
    // deferle plus au large, hors du domaine. C'est ce qui rend la mer
    // automatiquement plus sage a maree basse, et c'est gratuit.
    // Sandbox : on va jusqu'a la limite physique du deferlement (H = 0,78 h)
    // plutot que de s'arreter a la marge de securite. Une vague plus haute
    // que l'eau ne le permet casse des le mur, en ressaut ; c'est violent,
    // et c'est ce qu'on a demande.
    const hsEff = Math.min(this.hs * gate, 0.78 * this.hGen);
    this.hsEffective = this.enabled ? hsEff : 0;
    this.breakDepth = hsEff / 0.78;

    const sigma = 0.055 + 0.10 * this.agitation;
    const spread = 0.35 + 0.75 * this.agitation;
    const fp = this.tp > 0 ? 1 / this.tp : 0;
    if (fp === 0 || hsEff <= 0) {
      this.a.fill(0);
      this.setupHeight = 0; this.runup2 = 0; this.wavelength = 0;
      return;
    }

    let sum2 = 0;
    const wgt = new Float64Array(N_COMP);
    for (let i = 0; i < N_COMP; i++) {
      const r = DF[i] / sigma;
      wgt[i] = Math.exp(-0.5 * r * r);
      sum2 += wgt[i] * wgt[i];
    }
    const scale = Math.sqrt((hsEff * hsEff / 8) / sum2);
    const cRef = this.cRef;
    for (let i = 0; i < N_COMP; i++) {
      this.a[i] = wgt[i] * scale;
      const f = fp * (1 + DF[i]);
      this.w[i] = 2 * Math.PI * f;
      const k = this.w[i] / cRef;             // dispersion en eau peu profonde
      const th = this.incidence + DTHETA[i] * spread;
      this.kx[i] = k * Math.cos(th);          // vers la terre
      this.ky[i] = k * Math.sin(th);          // le long du rivage
    }
    this.wavelength = cRef * this.tp;

    // Grandeurs derivees, pour l'interface, le telegraphe et les tests.
    // Stockdon et al. (2006) : R2% = 1,1 (setup + 0,5 sqrt(Sinc^2 + Sig^2)).
    const beta = 0.21;
    const L0 = GRAVITY * this.tp * this.tp / (2 * Math.PI);
    const root = Math.sqrt(hsEff * L0);
    this.setupHeight = 0.35 * beta * root;
    const sInc = 0.75 * beta * root;
    const sIg = 0.06 * root;
    this.runup2 = 1.1 * (this.setupHeight + 0.5 * Math.hypot(sInc, sIg));
  }

  /** Nombre d'Iribarren (type de deferlement), pour le panneau de debug. */
  get iribarren() {
    if (this.hsEffective <= 0 || this.tp <= 0) return 0;
    const L0 = GRAVITY * this.tp * this.tp / (2 * Math.PI);
    return 0.21 / Math.sqrt(this.hsEffective / L0);
  }

  // -------------------------------------------------------------------------
  // AVANCE
  // -------------------------------------------------------------------------

  update(dt) {
    this.time += dt;
    this.buildBands();
    // Le spectre depend de la maree (ecretage + limitation de profondeur) : on
    // le rafraichit deux fois par seconde, pas a chaque frame.
    this._reSpec += dt;
    if (this._reSpec > 0.5) { this._reSpec = 0; this.rebuildSpectrum(); }

    // --- enveloppe de groupe -------------------------------------------------
    // Le battement des composantes produit deja des groupes de ~7 vagues ;
    // cette enveloppe explicite permet a l'agitation de les accentuer ou de les
    // lisser, donc de DOSER LE DRAME. L'exposant 1,7 la rend piquee : des
    // accalmies larges (la fenetre de reparation) et des series courtes et
    // franches. Un sinus nu donnerait une respiration molle.
    const tg = this.tp * (6 + 3 * (1 - this.agitation));
    const depth = 0.20 + 0.45 * this.agitation;
    const e = 0.5 + 0.5 * Math.sin((this.time / Math.max(tg, 1e-3)) * Math.PI * 2);
    this.groupAmp = (1 - depth) + depth * Math.pow(e, 1.7) * 1.6;

    // --- onde longue liee ----------------------------------------------------
    // Sous un groupe de grosses vagues le niveau moyen est ABAISSE, entre deux
    // groupes il est RELEVE : l'onde longue liee voyage en opposition de phase
    // avec l'enveloppe. C'est elle qui fait que les vagues de debut de serie
    // montent plus haut que leur taille ne le laisserait croire — "la vague qui
    // vient te chercher plus haut". Cout : un scalaire.
    this.etaIg = -C_IG * this.hsEffective * (this.groupAmp - 1);
  }

  /**
   * Elevation cible au-dessus du niveau de la mer, pour une cellule.
   * Version scalaire, lisible : applyGeneration utilise une recurrence.
   */
  etaAt(c) {
    if (!this.enabled) return 0;
    let e = 0;
    const sx = this.sx[c], sy = this.sy[c];
    for (let i = 0; i < N_COMP; i++) {
      e += this.a[i] * Math.cos(this.w[i] * this.time - this.kx[i] * sx - this.ky[i] * sy + this.ph[i]);
    }
    return e * this.groupAmp + this.etaIg;
  }

  /**
   * Relaxation vers l'etat cible. REMPLACE la branche `isOcean` de
   * Water.applyBoundaries.
   *
   *     h <- (1 - a) h_solved + a h_target
   *     f <- (1 - a) f_solved + a f_target
   *
   * Le melange fait les deux choses a la fois : il GENERE l'onde incidente la
   * ou alpha ~ 1, et il ABSORBE tout ce qui revient du rivage, puisqu'une onde
   * sortante n'appartient pas a l'etat cible. C'est ce qu'utilisent tous les
   * canaux a houle numeriques, et c'est infiniment plus court qu'une PML.
   *
   * OPTIMISATION. Evaluer 5 cosinus sur les ~20 000 cellules de la bande, deux
   * fois par frame, coute 6 ms a lui seul. Comme sx et sy sont AFFINES en x le
   * long d'une ligne, la phase de chaque composante avance d'un increment
   * constant : on la fait tourner par une rotation 2x2 (4 mult, 2 add) au lieu
   * d'appeler Math.cos. On repart d'un vrai cosinus au debut de chaque ligne,
   * ce qui borne la derive numerique a 256 pas de recurrence.
   */
  applyGeneration(dt) {
    const W = this.water;
    const h = W.hc, surf = W.bed;
    const fx = W.fx, fz = W.fz;
    const alpha = this.alpha, sxA = this.sx, syA = this.sy;
    const lvl = W.seaLevel;
    const a = this.a, kx = this.kx, ky = this.ky, w = this.w, ph = this.ph;
    const cs = this._cs, sn = this._sn, cd = this._cd, sd = this._sd;
    const on = this.enabled;
    const gAmp = this.groupAmp, ig = this.etaIg;
    const cRef = this.cRef;
    // Direction du flux cible : vers la TERRE, donc -n.
    const nxL = -SHORE_NX, nzL = -SHORE_NZ;

    // Increment de phase pour un pas de +1 en x, par composante.
    if (on) {
      for (let i = 0; i < N_COMP; i++) {
        const d = WC * (kx[i] * SHORE_NX + ky[i] * SHORE_NZ);
        cd[i] = Math.cos(d); sd[i] = Math.sin(d);
      }
    }

    for (let z = 0; z < WM; z++) {
      const xa = this.bandA[z], xb = this.bandB[z];
      if (xb < xa) continue;
      const row = WN * z;
      const c0 = row + xa;
      if (on) {
        for (let i = 0; i < N_COMP; i++) {
          const th = w[i] * this.time - kx[i] * sxA[c0] - ky[i] * syA[c0] + ph[i];
          cs[i] = Math.cos(th); sn[i] = Math.sin(th);
        }
      }
      for (let x = xa; x <= xb; x++) {
        const c = row + x;
        const al = alpha[c];

        let eta = 0;
        if (on) {
          for (let i = 0; i < N_COMP; i++) {
            eta += a[i] * cs[i];
            const nc = cs[i] * cd[i] - sn[i] * sd[i];
            sn[i] = sn[i] * cd[i] + cs[i] * sd[i];
            cs[i] = nc;
          }
          eta = eta * gAmp + ig;
        }
        if (al <= 0.001) continue;

        const bed = surf[c];
        const hTarget = Math.max(0, lvl + eta - bed);
        // Debit d'une onde progressive en eau peu profonde : q = eta * c. C'est
        // cette relation (l'invariant de Riemann sortant) qui rend la limite
        // TRANSPARENTE : une onde qui la traverse dans le bon sens est
        // reproduite exactement, une onde qui revient ne l'est pas et se fait
        // absorber. Sans elle, la bande genere ET reflechit.
        const q = eta * cRef * WC;
        const inv = 1 - al;
        h[c] = h[c] * inv + hTarget * al;
        fx[c] = fx[c] * inv + q * nxL * al;
        fz[c] = fz[c] * inv + q * nzL * al;
      }
    }
  }
}
