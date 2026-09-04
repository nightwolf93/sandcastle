/**
 * Eau libre : mer, maree, ressac, douves, flaques, ruisseaux — et l'erosion
 * qui va avec.
 *
 * L'eau est une NAPPE : une hauteur d'eau h(x, z) posee sur le sable, resolue
 * par un solveur en eaux peu profondes (modele « pipe » de Mei et al., avec
 * les corrections qui en font un vrai schema de Saint-Venant : flux signes,
 * celerite g·h_face, frottement de fond semi-implicite, mise a l'echelle des
 * sorties). Il est conservatif par construction, hydrostatique au repos, et
 * il produit tout seul la levee sur le haut-fond, le deferlement et le jet de
 * rive parce que la celerite vaut sqrt(g h).
 *
 * TROIS GRILLES, UN SEUL ETAT.
 *
 *   - Le solveur travaille sur des CELLULES D'EAU de 8 cm (deux voxels) : la
 *     condition CFL rend son cout proportionnel a (cellules mouillees)/dx, et
 *     ce facteur huit est ce qui rend une mer de 12,8 m de front abordable.
 *     Le fond d'une cellule est le MAXIMUM de ses quatre colonnes : un mur
 *     d'un voxel reste etanche.
 *   - Il ne travaille que dans une BANDE le long du rivage, du mur du large
 *     (bandWall) jusqu'au haut de plage. Au-dela du mur, la mer est IMPOSEE :
 *     niveau de maree plus houle, sans calcul de flux. La bande suit la maree
 *     et l'etat de mer (voir updateBand).
 *   - Le rendu et l'erosion lisent des champs FINS (h, vx, vz, foam, sed, une
 *     valeur par colonne de 4 cm) reconstruits a chaque pas par syncFine() :
 *     la surface libre est interpolee entre les cellules d'eau puis coupee par
 *     le terrain fin. Une lame de 2 mm se rend sans trou, un mur d'un voxel
 *     sort de l'eau, et le renderer n'a rien a savoir de la grille grossiere.
 *
 * Ce qui QUITTE la nappe devient une GOUTTE (Droplets.js) : l'eau versee par
 * un outil, la lame qui bascule d'un rebord. Une goutte rend son volume exact
 * a la nappe la ou elle se pose ; la conservation de l'eau ne depend jamais
 * d'elle.
 *
 * Limite assumee : une cavite fermee (tunnel, tour creuse) est invisible pour
 * une nappe. Elle reste seche, et c'est documente.
 *
 * S'y greffent :
 *   - la MAREE, qui pilote a la fois le niveau de la mer et la nappe (creuser
 *     sous la nappe fait apparaitre de l'eau, comme sur une vraie plage) ;
 *   - la HOULE (Waves.js), imposee dans une zone de relaxation contre le mur
 *     du large, que le solveur propage et casse ;
 *   - l'INFILTRATION, qui convertit l'eau de surface en humidite du sable ;
 *   - l'EROSION hydraulique : capacite de transport, arrachement, advection du
 *     sediment, depot. Le seuil d'arrachement depend de la cohesion : du sable
 *     bien tasse et humide resiste cinq cents fois mieux qu'un tas de sable sec ;
 *   - le SAPEMENT des parois (undermine/notch), qui creuse une encoche a
 *     l'altitude de la lame d'eau au lieu de raboter le sommet des murs.
 */

import {
  NX, NZ, NY, VOXEL, ISO, FOUNDATION_LAYERS, ORIGIN_X, ORIGIN_Y, ORIGIN_Z,
  WATER_NX as WN, WATER_NZ as WM, WATER_SUB as SUB, WATER_CELL as WC, WATER_SIM_HZ,
  GRAVITY, SEA_LEVEL, TIDE_AMPLITUDE, TIDE_PERIOD,
  WATER_DAMPING_NUM, WATER_EPSILON, POROSITY, INFILTRATION_RATE,
  WATER_TABLE_DROP, WATER_TABLE_SPAN, SEEPAGE_RATE, SEEPAGE_MARGIN, SEEPAGE_MAX,
  SEEP_BLOCK_RISE,
  EROSION_CAPACITY, EROSION_DISSOLVE, EROSION_DEPOSIT, EROSION_MIN_SLOPE,
  HFACE_MIN, HFACE_CAP, CFL_SAFE, SUBSTEP_MAX, FR_MAX, FR_DEPTH_MIN, U_ABS_MAX,
  FW_UPRUSH, FW_BACKWASH, FRIC_DEPTH_MIN, FRIC_DEPTH_HS,
  BREAK_ON, BREAK_OFF, BREAK_GAIN_BASE, BREAK_GAIN_AGIT, ROLLER_NU, BREAK_TAU,
  BREAK_DEPTH_MIN, BREAK_DEPTH_FULL,
  TAU_DEPTH_FULL, TAU_DEPTH_ZERO,
  FOAM_GAIN, FOAM_TAU_WET, FOAM_TAU_DRY, FOAM_DEPOSIT,
  TAU_CRIT_DRY, COHESION_RESIST,
  UNDERCUT_RISE, UNDERCUT_V, SCOUR_GAIN, UNDERCUT_RATE, UNDERCUT_CAP,
  UNDERCUT_REACH,
  SCARP_FRONT, DEPOSIT_MOISTURE, DEPOSIT_PACK,
  SEA_BAND_BREAK, SEA_BAND_MIN_DEPTH, SEA_BAND_MAX_DEPTH, SEA_BAND_MAX_WIDTH,
  DROPLET_VOLUME,
  CHUNK, chidx, clamp, smoothstep,
} from '../core/Config.js';
import { cohesionFactor, packFactor } from './SandPhysics.js';
import { shoreDistance, shorelineFor, SHORE_NX, SHORE_NZ } from '../world/BeachGenerator.js';
import { WaveField, DAMAGE_LEVELS } from './Waves.js';
import { Droplets } from './Droplets.js';

const SLICE = NX * NZ;
/** Colonnes fines (une par voxel en XZ). */
const COLS = NX * NZ;
/** Cellules d'eau (grille du solveur). */
/**
 * Eau chassee par une remontee du fond : montee maximale d'une cellule
 * receveuse par evenement, et hauteur maximale au-dessus de la mer.
 */
const DISPLACE_RISE = 0.03;
const DISPLACE_ABOVE = 0.05;

const WCOLS = WN * WM;
const L = WC;            // longueur des tuyaux
const A = WC * WC;       // section d'une cellule d'eau
const AF = VOXEL * VOXEL; // section d'une colonne fine
/** Pas de la grille d'elevation de la mer imposee, en cellules d'eau (32 cm). */
const ETA_STEP = 4;
/** Marge des balayages autour des cellules mouillees (cellules d'eau). */
const SCAN_MARGIN = 2;
/** Profondeur minimale des deux cellules pour advecter la quantite de mouvement. */
/** Profondeur minimale des deux cellules pour advecter la quantite de mouvement. */
export const ADV_MIN_H = 0.02;

export class Water {
  /**
   * @param {import('./VoxelField.js').VoxelField} field
   * @param {import('./Granular.js').Granular} granular
   * @param {import('./Moisture.js').Moisture} moisture
   */
  constructor(field, granular, moisture) {
    this.field = field;
    this.granular = granular;
    this.moisture = moisture;

    // --- champs FINS (rendu, interface, erosion) ----------------------------
    /** Hauteur de la lame d'eau au-dessus de chaque colonne fine (m). */
    this.h = new Float32Array(COLS);
    /** Vitesse de l'ecoulement, interpolee depuis les cellules d'eau (m/s). */
    this.vx = new Float32Array(COLS);
    this.vz = new Float32Array(COLS);
    /** Ecume portee par l'eau. */
    this.foam = new Float32Array(COLS);
    /** Sediment en suspension (hauteur equivalente de sable, m). */
    this.sed = new Float32Array(COLS);
    /** Indicateur de deferlement 0..1, pour la crete qui se cambre au rendu. */
    this.brkFine = new Float32Array(COLS);
    /**
     * Laisse d'ecume : la dentelle qui reste sur le SABLE apres le retrait.
     *
     * Tableau separe parce que le shader d'eau fait `if (d < 0.0016) discard`.
     * Une ecume rangee dans `foam` sur une cellule seche ne serait jamais
     * dessinee — or c'est l'indicateur le plus lisible du jeu : elle marque
     * physiquement jusqu'ou la mer est montee. Elle est lue par le shader du
     * SABLE, pas par celui de l'eau.
     */
    this.foamDry = new Float32Array(COLS);
    /** Distance signee au rivage moyen, precalculee (m, > 0 cote terre). */
    this.shore = new Float32Array(COLS);
    /**
     * Altitude de la nappe phreatique sous chaque colonne (m).
     *
     * Ce n'est PAS un plan horizontal. La nappe affleure au niveau de la mer
     * sur la laisse et s'enfonce vers l'arriere-plage : c'est ce qui fait que
     * creuser au bord de l'eau donne une flaque, et creuser en haut de plage
     * donne un trou sec. Recalculee quand la maree a bouge d'un centimetre.
     */
    this.tableH = new Float32Array(COLS);
    /** Colonne mouillee au pas precedent : sert a reperer le FRONT du jet. */
    this.wetPrev = new Uint8Array(COLS);

    // --- champs du SOLVEUR (cellules d'eau) ----------------------------------
    /**
     * Hauteur d'eau par cellule (m). En double precision : c'est l'etat dont
     * la conservation est verifiee a 1e-6 m3 pres sur des minutes, et un
     * float32 accumule un biais mesurable en quelques milliers de pas.
     */
    this.hc = new Float64Array(WCOLS);
    /**
     * Flux SIGNES aux faces (m3/s). `fx[c]` traverse la face entre c et c+1,
     * positif vers +X ; `fz[c]` celle entre c et c+WN, positif vers +Z. Les
     * faces des bords -X et -Z, qui n'appartiennent a aucune cellule, sont
     * rangees a part.
     *
     * POURQUOI SIGNE, ET PAS QUATRE TUYAUX UNIDIRECTIONNELS.
     *
     * Le modele de Mei et al. utilise quatre flux sortants ecretes a zero :
     * fR, fL, fT, fB >= 0. Deux tuyaux opposes decrivent alors la MEME face,
     * et a chaque inversion du courant le flux accumule est ecrete a zero au
     * lieu de changer de signe. L'inertie de la quantite de mouvement est donc
     * DETRUITE a chaque renversement.
     *
     * Sans consequence pour du ruissellement, qui coule toujours dans le meme
     * sens. Catastrophique pour une houle, qui renverse deux fois par periode :
     * le systeme devient artificiellement raide et la celerite mesuree montait
     * a 1,4 fois sqrt(g h), avec une dispersion de 25 a 65 % selon la
     * profondeur. Autrement dit : corriger le coefficient g*h_face ne suffit
     * pas, il faut aussi que le flux puisse changer de signe.
     */
    this.fx = new Float64Array(WCOLS);
    this.fz = new Float64Array(WCOLS);
    /** Faces du bord -X (une par ligne) et -Z (une par colonne). */
    this.fxW = new Float64Array(WM);
    this.fzS = new Float64Array(WN);
    /** Facteur de mise a l'echelle des sorties, par cellule (garde-fou G1). */
    this.scale = new Float32Array(WCOLS).fill(1);
    /** Vitesse moyenne dans la cellule (m/s). */
    this.vxc = new Float32Array(WCOLS);
    this.vzc = new Float32Array(WCOLS);
    this.sedc = new Float32Array(WCOLS);
    this.sedTmp = new Float32Array(WCOLS);
    this.foamc = new Float32Array(WCOLS);
    this.foamTmp = new Float32Array(WCOLS);
    this.foamDryc = new Float32Array(WCOLS);
    /**
     * Altitude de la surface libre au pas precedent (detection du deferlement).
     * -1e9 = « pas d'histoire » : cellule seche au pas precedent. Voir
     * breaking() — une cellule qui vient de se mouiller n'a pas de d(eta)/dt.
     */
    this.etaPrev = new Float32Array(WCOLS).fill(-1e9);
    /** Indicateur de deferlement 0..1. Nourrit la dissipation ET l'ecume. */
    this.brk = new Float32Array(WCOLS);
    /** Fond de la cellule : le maximum de ses quatre colonnes fines. */
    this.bed = new Float32Array(WCOLS);
    /** Fond de la plage D'ORIGINE, avant toute construction (voir seepMask). */
    this.baseBed = new Float32Array(WCOLS);
    /** 1 = la nappe peut alimenter la cellule (chemin de sable naturel). */
    this.seepMask = new Uint8Array(WCOLS);
    /** Distance au rivage moyen, au centre de chaque cellule d'eau. */
    this.shoreC = new Float32Array(WCOLS);
    /** Nappe phreatique par cellule d'eau. */
    this.tableC = new Float32Array(WCOLS);
    /** 1 = cellule resolue par le solveur (la bande et toute la plage). */
    this.simMask = new Uint8Array(WCOLS).fill(1);
    /** 1 = mer du large, niveau impose. */
    this.openMask = new Uint8Array(WCOLS);
    /**
     * 1 = cellule que la mer atteint au repos (mer imposee comprise). La
     * zone de relaxation de la houle ne s'applique que la : une enceinte
     * fermee au large n'est pas remplie par decret.
     */
    this.reachMask = new Uint8Array(WCOLS);
    this._openBox = [WN, -1, WM, -1];
    /**
     * Bornes en X des cellules mouillees de chaque ligne Z. La plage seche et
     * la mer imposee representent l'essentiel du domaine : ne pas les
     * parcourir est ce qui rend le solveur bon marche.
     */
    this.rowMin = new Int32Array(WM).fill(WN);
    this.rowMax = new Int32Array(WM).fill(-1);
    /**
     * Bornes ELARGIES : union des bornes de la ligne et de ses deux voisines,
     * plus une marge. Indispensable — sans elle, une ligne entierement seche
     * n'est jamais parcourue, donc ne peut jamais recevoir le flux de sa
     * voisine, et un ecoulement ne progresse plus du tout en Z. Une tranchee
     * en diagonale ne coulait pas au-dela de quelques centimetres.
     */
    this.scanA = new Int32Array(WM);
    this.scanB = new Int32Array(WM);
    /** Boite fine mise a jour par le dernier syncFine (pour effacer). */
    this._prevFineBox = [NX, -1, NZ, -1];
    /** Elevation de la houle imposee, sur une grille de ETA_STEP cellules. */
    this._etaW = Math.ceil((WN - 1) / ETA_STEP) + 1;
    this._etaH = Math.ceil((WM - 1) / ETA_STEP) + 1;
    this._etaGrid = new Float32Array(this._etaW * this._etaH);
    /** File du remplissage initial et des redistributions. */
    this._queue = new Int32Array(WCOLS);
    this._receivers = new Int32Array(WCOLS);
    this._visited = new Uint8Array(WCOLS);
    this._dryFoamActive = false;
    this._dryFoamWasActive = false;
    this._dryFoamTick = 0;

    // --- etat -----------------------------------------------------------------
    this.time = 0;
    this.rescanRows = 0;
    this.tide = 0;           // -1..1
    /** Niveau de la maree SEULE : datum du generateur de houle. */
    this.tideLevel = SEA_LEVEL;
    /** Surcote de deferlement (set-up), lissee. */
    this.waveSetup = 0;
    this.seaLevel = SEA_LEVEL;
    this.waterTable = SEA_LEVEL;
    this._tableSea = -99;
    /** Position du rivage courant, en distance au rivage moyen (m). */
    this.shoreline = 0;
    this.swash = 0;
    /** Vitesse d'ecoulement du temps de la maree (multiplicateur). */
    this.tideSpeed = 1;
    /** Active/desactive l'erosion (pour un mode "sanctuaire"). */
    this.erosionEnabled = true;
    /**
     * Ce que la mer abime : multiplicateur du sapement des parois.
     *
     * Separer "hauteur des vagues" de "degats" est essentiel : beaucoup de
     * joueurs veulent le spectacle de la Tempete sans perdre leur chateau.
     * C'est une demande legitime, et y repondre coute un multiplicateur.
     */
    this.wallAttack = 0.60;
    this.damageIndex = 2;
    /** Reglage du joueur : l'eau n'emporte jamais le sable (prime sur la jauge). */
    this.sandSafe = false;
    /**
     * Mer du large et suintement de la nappe sont les deux SOURCES du systeme.
     * Les tests de conservation les coupent pour travailler en bassin ferme.
     */
    this.openSeaEnabled = true;
    this.seepEnabled = true;
    /** Mur du large (distance au rivage, convention shoreDistance). */
    this.bandWall = -Infinity;
    this._bandLevel = NaN;
    this._bandHs = NaN;

    /** Profondeur et vitesse maximales du pas precedent (CFL). */
    this.hMaxSea = 0.9;
    this.uMax = 0.5;
    /** Nombre de sous-pas effectivement utilises (panneau de debug). */
    this.substepCount = 1;
    this._simAcc = 0;
    this._erodeTick = 0;
    this._bedTick = 0;
    this._pourRemainder = 0;
    /** Embruns restant a projeter pendant ce pas (voir spray). */
    this._sprayLeft = 0;
    /** Solveur GPU optionnel (WaterGPU), attache par le jeu. Null en Node. */
    this.gpu = null;
    /**
     * Emetteur d'embruns, branche par le jeu sur le systeme de particules :
     * (x, y, z, vx, vy, vz). Purement visuel : la brume ne pese rien.
     */
    this.onSpray = null;

    this.stats = {
      wetCells: 0, volume: 0, eroded: 0, ms: 0, breaking: 0, droplets: 0,
      /** Volume cumule bu par le sable (m3). */
      infiltrated: 0,
      /** Volume cumule apporte par la nappe (m3). */
      seeped: 0,
      /** Volume chasse par le sable sans trouver de place (m3). */
      spilled: 0,
    };

    /** Gouttes balistiques : ce qui quitte la nappe. */
    this.droplets = new Droplets(field);
    this._levelAt = (wx, wz) => this.levelAt(wx, wz);
    this._land = (wx, wz, vol, foam) => this.land(wx, wz, vol, foam);

    this.buildShoreMap();
    this.captureBase();
    this.updateWaterTable(true);
    this.updateBand(true);
    /**
     * Le generateur de houle. Construit apres la bande : il a besoin du mur
     * du large pour placer sa zone de relaxation. La bande a son tour depend
     * de l'etat de mer : on la recalcule une fois le generateur en place.
     */
    this.waves = new WaveField(this);
    this.updateBand(true);
  }

  // -------------------------------------------------------------------------
  // GEOMETRIE : rivage, nappe, bande
  // -------------------------------------------------------------------------

  /**
   * Le style de plage a change (nouvelle plage, chargement) : rivage,
   * geometrie de la houle et nappe repartent du profil courant.
   */
  rebuildShore() {
    this.buildShoreMap();
    this.waves.buildGeometry();
    this.updateWaterTable(true);
    this._bandLevel = NaN;
  }

  buildShoreMap() {
    for (let z = 0; z < NZ; z++) {
      const wz = ORIGIN_Z + (z + 0.5) * VOXEL;
      for (let x = 0; x < NX; x++) {
        const wx = ORIGIN_X + (x + 0.5) * VOXEL;
        this.shore[x + NX * z] = shoreDistance(wx, wz, null);
      }
    }
    for (let z = 0; z < WM; z++) {
      const wz = ORIGIN_Z + (z + 0.5) * WC;
      for (let x = 0; x < WN; x++) {
        const wx = ORIGIN_X + (x + 0.5) * WC;
        this.shoreC[x + WN * z] = shoreDistance(wx, wz, null);
      }
    }
  }

  /**
   * Recalcule la surface de la nappe.
   *
   * Elle affleure au niveau de la mer sur le rivage COURANT (donc elle suit la
   * maree, et le rivage se deplace de plusieurs metres entre basse et pleine
   * mer), puis s'enfonce de WATER_TABLE_DROP sur WATER_TABLE_SPAN metres vers
   * l'interieur.
   */
  updateWaterTable(force = false) {
    if (!force && Math.abs(this.seaLevel - this._tableSea) < 0.01) return;
    this._tableSea = this.seaLevel;
    // Ou passe la ligne d'eau aujourd'hui ? On inverse le profil de plage.
    this.shoreline = shorelineFor(this.seaLevel);
    const base = this.seaLevel - 0.02;
    for (let c = 0; c < COLS; c++) {
      // Distance au rivage COURANT : negative cote mer, positive cote terre.
      const t = smoothstep(0, WATER_TABLE_SPAN, this.shore[c] - this.shoreline);
      this.tableH[c] = base - WATER_TABLE_DROP * t;
    }
    for (let c = 0; c < WCOLS; c++) {
      const t = smoothstep(0, WATER_TABLE_SPAN, this.shoreC[c] - this.shoreline);
      this.tableC[c] = base - WATER_TABLE_DROP * t;
    }
    // Valeur de reference pour l'interface et le shader (lisere de nappe).
    this.waterTable = base;
  }

  /** Altitude de la nappe a une position monde. */
  waterTableAt(wx, wz) {
    const x = clamp(Math.round((wx - ORIGIN_X) / VOXEL - 0.5), 0, NX - 1);
    const z = clamp(Math.round((wz - ORIGIN_Z) / VOXEL - 0.5), 0, NZ - 1);
    return this.tableH[x + NX * z];
  }

  /**
   * Recalcule le mur du large et les deux masques qui en dependent.
   *
   * Le mur est la ligne parallele au rivage la plus proche de la terre parmi
   * deux limites : une PROFONDEUR AU REPOS (SEA_BAND_BREAK fois la profondeur
   * de deferlement de l'etat de mer demande, bornee) au-dela de laquelle la
   * houle n'a plus rien a faire avec le sable, et une LARGEUR maximale depuis
   * la ligne d'eau courante, qui borne le travail a maree basse quand le
   * platier entier passe sous la profondeur limite. Tout est mesure sur le
   * profil d'origine : un trou creuse au large ne deplace pas le mur.
   */
  updateBand(force = false) {
    const w = this.waves;
    const gate = w ? 1 - w.tideGate * Math.max(0, this.tide) : 1;
    const hsReq = w && w.enabled ? w.hs * gate : 0;
    if (!force && Math.abs(this.seaLevel - this._bandLevel) < 0.004
        && Math.abs(hsReq - this._bandHs) < 0.002) return;
    this._bandLevel = this.seaLevel;
    this._bandHs = hsReq;

    const open = this.openMask, sim = this.simMask, shore = this.shoreC;
    let wall = -Infinity;
    if (this.openSeaEnabled) {
      const depthLimit = clamp(SEA_BAND_BREAK * hsReq / 0.78,
        SEA_BAND_MIN_DEPTH, SEA_BAND_MAX_DEPTH);
      const byDepth = shorelineFor(this.seaLevel - depthLimit);
      const byWidth = shorelineFor(this.seaLevel) - SEA_BAND_MAX_WIDTH;
      wall = Math.max(byDepth, byWidth);
    }
    this.bandWall = wall;
    // La mer imposee est ce que l'eau du hors-champ ATTEINT depuis le bord du
    // domaine, au-dela du mur et sous le niveau. Un mur construit au large
    // arrete ce parcours : l'enceinte derriere lui est resolue par le
    // solveur, pas noyee par decret.
    open.fill(0);
    let xLo = WN, xHi = -1, zLo = WM, zHi = -1;
    if (wall > -1e8) {
      this.refreshBed(true);
      const bed = this.bed, lvl = this.seaLevel;
      const queue = this._queue;
      let head = 0, tail = 0;
      const seed = (c) => {
        if (open[c] || shore[c] >= wall || bed[c] + WATER_EPSILON >= lvl) return;
        open[c] = 1; queue[tail++] = c;
      };
      for (let x = 0; x < WN; x++) { seed(x); seed(x + WN * (WM - 1)); }
      for (let z = 1; z < WM - 1; z++) { seed(WN * z); seed(WN - 1 + WN * z); }
      while (head < tail) {
        const c = queue[head++];
        const x = c % WN, z = (c / WN) | 0;
        if (x > 0) seed(c - 1);
        if (x + 1 < WN) seed(c + 1);
        if (z > 0) seed(c - WN);
        if (z + 1 < WM) seed(c + WN);
        if (x < xLo) xLo = x; if (x > xHi) xHi = x;
        if (z < zLo) zLo = z; if (z > zHi) zHi = z;
        this.scale[c] = 1;
      }
    }
    for (let c = 0; c < WCOLS; c++) sim[c] = open[c] ? 0 : 1;
    this._openBox[0] = xLo; this._openBox[1] = xHi;
    this._openBox[2] = zLo; this._openBox[3] = zHi;
    // Portee de la mer au repos : ce que l'eau du large atteint par un chemin
    // dont le fond passe sous le niveau, murs compris.
    const reach = this.reachMask;
    reach.set(open);
    if (wall > -1e8) {
      const bed = this.bed, lvl = this.seaLevel, queue = this._queue;
      let head = 0, tail = 0;
      for (let c = 0; c < WCOLS; c++) if (open[c]) queue[tail++] = c;
      const grow = (c) => {
        if (reach[c] || bed[c] + WATER_EPSILON >= lvl) return;
        reach[c] = 1; queue[tail++] = c;
      };
      while (head < tail) {
        const c = queue[head++];
        const x = c % WN, z = (c / WN) | 0;
        if (x > 0) grow(c - 1);
        if (x + 1 < WN) grow(c + 1);
        if (z > 0) grow(c - WN);
        if (z + 1 < WM) grow(c + WN);
      }
    } else {
      this.refreshBed(true);
    }
    this.updateSeepMask();
    if (w) {
      w.buildBands(true);
      w.rebuildSpectrum();
    }
  }

  /**
   * Memorise le fond naturel. A appeler sur une plage vierge, avant toute
   * construction : c'est la reference qui distingue un mur d'une dune.
   */
  captureBase() {
    this.refreshBed(true);
    this.baseBed.set(this.bed);
  }

  /**
   * Cellules que la nappe peut alimenter : celles que la mer atteint en ne
   * traversant que du sable naturel (fond au plus SEEP_BLOCK_RISE au-dessus
   * du terrain d'origine). Une construction coupe le chemin. Voir Config.
   */
  updateSeepMask() {
    const mask = this.seepMask, reach = this.reachMask;
    const bed = this.bed, base = this.baseBed, queue = this._queue;
    mask.fill(0);
    let head = 0, tail = 0;
    for (let c = 0; c < WCOLS; c++) if (reach[c]) { mask[c] = 1; queue[tail++] = c; }
    const grow = (c) => {
      if (mask[c] || bed[c] > base[c] + SEEP_BLOCK_RISE) return;
      mask[c] = 1; queue[tail++] = c;
    };
    while (head < tail) {
      const c = queue[head++];
      const x = c % WN, z = (c / WN) | 0;
      if (x > 0) grow(c - 1);
      if (x + 1 < WN) grow(c + 1);
      if (z > 0) grow(c - WN);
      if (z + 1 < WM) grow(c + WN);
    }
  }

  /** Fond des cellules d'eau : le maximum de leurs quatre colonnes fines. */
  refreshBed(full = false) {
    const F = this.field;
    const surf = F.surfaceH, bed = this.bed;
    const list = F.bedDirty, flag = F.bedDirtyFlag;
    // Incremental d'ordinaire : seules les colonnes recalculees depuis le
    // dernier pas (outil, avalanche, erosion) rafraichissent leur cellule.
    // Une passe complete de temps en temps, et sur demande, rattrape tout
    // chemin qui n'aurait pas marque ses colonnes.
    if (!full && list && (++this._bedTick & 63) !== 0) {
      for (let k = 0; k < list.length; k++) {
        const fc = list[k];
        flag[fc] = 0;
        const x = ((fc % NX) / SUB) | 0, z = (((fc / NX) | 0) / SUB) | 0;
        const r0 = NX * (z * SUB), r1 = r0 + NX, fx0 = x * SUB;
        const a = surf[r0 + fx0], b = surf[r0 + fx0 + 1];
        const c = surf[r1 + fx0], d = surf[r1 + fx0 + 1];
        let m = a > b ? a : b;
        if (c > m) m = c;
        if (d > m) m = d;
        bed[x + WN * z] = m;
      }
      list.length = 0;
      return;
    }
    for (let z = 0; z < WM; z++) {
      const r0 = NX * (z * SUB), r1 = r0 + NX;
      const row = WN * z;
      for (let x = 0; x < WN; x++) {
        const fx0 = x * SUB;
        const a = surf[r0 + fx0], b = surf[r0 + fx0 + 1];
        const c = surf[r1 + fx0], d = surf[r1 + fx0 + 1];
        let m = a > b ? a : b;
        if (c > m) m = c;
        if (d > m) m = d;
        bed[row + x] = m;
      }
    }
    if (list) {
      for (let k = 0; k < list.length; k++) flag[list[k]] = 0;
      list.length = 0;
    }
  }

  /**
   * MER IMPOSEE. Au-dela du mur, chaque cellule prend le niveau de maree plus
   * l'elevation de la houle, echantillonnee sur une grille de 32 cm : le
   * spectre y est exact aux noeuds et lineaire entre eux, ce que l'oeil ne
   * distingue pas d'une houle de plusieurs metres de long. Aucun flux.
   */
  imposeOpenSea() {
    const ob = this._openBox;
    if (!this.openSeaEnabled || ob[1] < ob[0]) return;
    const gw = this._etaW, g = this._etaGrid;
    this.waves.sampleEtaGrid(g, gw, this._etaH, ETA_STEP);
    const hc = this.hc, bed = this.bed, open = this.openMask;
    const fx = this.fx, fz = this.fz, vx = this.vxc, vz = this.vzc;
    const foam = this.foamc, brk = this.brk, eta0 = this.etaPrev;
    const lvl = this.seaLevel;
    const inv = 1 / ETA_STEP;
    for (let z = ob[2]; z <= ob[3]; z++) {
      const row = WN * z;
      const fzg = z * inv, z0 = fzg | 0, tz = fzg - z0;
      const g0 = gw * z0;
      for (let x = ob[0]; x <= ob[1]; x++) {
        const c = row + x;
        if (!open[c]) continue;
        const fxg = x * inv, x0 = fxg | 0, tx = fxg - x0;
        const i = g0 + x0;
        const eta = (g[i] * (1 - tx) + g[i + 1] * tx) * (1 - tz)
                  + (g[i + gw] * (1 - tx) + g[i + gw + 1] * tx) * tz;
        const d = lvl + eta - bed[c];
        hc[c] = d > 0 ? d : 0;
        fx[c] = 0; fz[c] = 0; vx[c] = 0; vz[c] = 0;
        // Pas de rouleau ni d'ecume au large : ce qu'une cellule portait
        // quand elle appartenait a la bande s'efface avec elle.
        foam[c] = 0; brk[c] = 0; eta0[c] = -1e9;
      }
    }
  }

  /**
   * Remplit la mer au repos : toutes les cellules que l'eau du large peut
   * atteindre par un chemin dont le fond passe sous le niveau. Un mur ferme
   * coupe le parcours : une enceinte seche construite avant le chargement
   * d'une partie ne se remplit pas.
   */
  initialize() {
    this.hc.fill(0); this.fx.fill(0); this.fz.fill(0);
    this.fxW.fill(0); this.fzS.fill(0);
    this.vxc.fill(0); this.vzc.fill(0);
    this.sedc.fill(0); this.foamc.fill(0); this.foamDryc.fill(0);
    this.etaPrev.fill(-1e9); this.brk.fill(0);
    this.foamDry.fill(0); this.wetPrev.fill(0);
    this.droplets.clear();
    this._dryFoamActive = false;
    this.refreshBed(true);
    this.updateBand(true);
    this.imposeOpenSea();
    if (this.openSeaEnabled) {
      const reach = this.reachMask, open = this.openMask, bed = this.bed, hc = this.hc;
      const lvl = this.seaLevel;
      for (let c = 0; c < WCOLS; c++) {
        if (reach[c] && !open[c]) hc[c] = lvl - bed[c];
      }
    }
    this.rescan();
    this._prevFineBox[0] = 0; this._prevFineBox[1] = NX - 1;
    this._prevFineBox[2] = 0; this._prevFineBox[3] = NZ - 1;
    this.syncFine();
    this.gpu?.invalidate();
    return this.stats.wetCells;
  }

  /** Repart d'une plage vierge : le terrain courant devient la reference. */
  reset() {
    this.h.fill(0); this.vx.fill(0); this.vz.fill(0);
    this.foam.fill(0); this.sed.fill(0); this.brkFine.fill(0);
    this._pourRemainder = 0;
    this.stats.infiltrated = 0; this.stats.seeped = 0; this.stats.eroded = 0;
    this.captureBase();
    return this.initialize();
  }

  /** Restaure l'etat d'une sauvegarde (cellules d'eau, gouttes, fond d'origine). */
  restore(coarse, droplets, base) {
    if (base && base.length === WCOLS) this.baseBed.set(base);
    this.initialize();
    if (coarse && coarse.length === WCOLS) {
      for (let c = 0; c < WCOLS; c++) {
        const v = coarse[c];
        this.hc[c] = v > 0 && Number.isFinite(v) ? v : 0;
      }
      this.rescan();
    }
    if (droplets) this.droplets.deserialize(droplets);
    this._prevFineBox[0] = 0; this._prevFineBox[1] = NX - 1;
    this._prevFineBox[2] = 0; this._prevFineBox[3] = NZ - 1;
    this.syncFine();
    this.gpu?.invalidate();
  }

  /** Bornes de lignes recalculees de zero. */
  rescan() {
    const hc = this.hc, sim = this.simMask;
    let wet = 0;
    for (let z = 0; z < WM; z++) {
      const row = WN * z;
      let a = WN, b = -1;
      for (let x = 0; x < WN; x++) {
        const c = row + x;
        if (sim[c] && hc[c] > 0) { if (x < a) a = x; b = x; if (hc[c] > WATER_EPSILON) wet++; }
      }
      this.rowMin[z] = a; this.rowMax[z] = b;
    }
    this.stats.wetCells = wet;
  }

  /**
   * Etat de mer (0 = mer d'huile ... 5 = tempete).
   * @returns {object} la fiche du niveau, pour l'interface.
   */
  setSeaState(i) {
    const s = this.waves.setState(i);
    if (this.waves.stateIndex === 0) {
      // Mer d'huile : on n'annule pas seulement l'amplitude, on annule le
      // generateur. Restent actifs : la maree, la nappe, l'infiltration, le
      // ruissellement, le granulaire. S'arretent : le deferlement, le jet de
      // rive, le sapement, la clameur.
      this.brk.fill(0);
      this.foamc.fill(0);
    }
    this.updateBand(true);
    return s;
  }

  /** Hauteur des vagues au large (m), reglage continu. */
  setWaveHeight(hs) {
    this.waves.setCustom(hs, this.waves.power);
    if (!this.waves.enabled) { this.brk.fill(0); this.foamc.fill(0); }
    this.updateBand(true);
  }

  /** Puissance des vagues (0..1) : periode, deferlement, embruns. */
  setWavePower(p) {
    this.waves.setCustom(this.waves.hs, p);
    this.updateBand(true);
  }

  /** Agitation de la mer (0 = reguliere ... 3 = dechainee). */
  setAgitation(i) {
    return this.waves.setAgitation(i);
  }

  /** Ce que la mer abime (0 = rien ... 3 = impitoyable). */
  setDamage(i) {
    i = clamp(i | 0, 0, DAMAGE_LEVELS.length - 1);
    const d = DAMAGE_LEVELS[i];
    this.damageIndex = i;
    // « L'eau n'emporte pas le sable » : le reglage persistant du joueur prime
    // sur la jauge d'erosion de la partie. La jauge garde sa valeur, pour
    // retrouver le meme comportement si le reglage est rendu.
    this.wallAttack = this.sandSafe ? 0 : d.attack;
    this.erosionEnabled = d.erosion && !this.sandSafe;
    return d;
  }

  /** Active ou rend l'erosion par l'eau, quel que soit le niveau de la jauge. */
  setSandSafe(on) {
    this.sandSafe = !!on;
    this.setDamage(this.damageIndex);
  }

  // -------------------------------------------------------------------------
  // SOURCES ET LECTURES
  // -------------------------------------------------------------------------

  /** Cellule d'eau sous une position monde. */
  cellAt(wx, wz) {
    const x = clamp(Math.floor((wx - ORIGIN_X) / WC), 0, WN - 1);
    const z = clamp(Math.floor((wz - ORIGIN_Z) / WC), 0, WM - 1);
    return x + WN * z;
  }

  /** Altitude de la surface libre de la nappe, ou -Infinity si elle est seche. */
  levelAt(wx, wz) {
    const c = this.cellAt(wx, wz);
    return this.hc[c] > WATER_EPSILON ? this.bed[c] + this.hc[c] : -Infinity;
  }

  /** Une goutte se pose : son volume EXACT rejoint la nappe. */
  land(wx, wz, vol, foam) {
    const c = this.cellAt(wx, wz);
    // La mer du large est un reservoir infini : elle absorbe.
    if (this.openMask[c]) return;
    this.hc[c] += vol / A;
    // L'ecume d'une goutte se dilue dans la nappe : la moitie seulement.
    const f = foam * 0.5;
    if (f > this.foamc[c]) this.foamc[c] = f;
    const x = c % WN, z = (c / WN) | 0;
    if (x < this.rowMin[z]) this.rowMin[z] = x;
    if (x > this.rowMax[z]) this.rowMax[z] = x;
  }

  /**
   * Verse de l'eau dans un disque (seau, arrosoir, pluie), ou en retire
   * (eponge). L'eau versee arrive sous forme de gouttes : c'est le retour
   * visuel immediat de l'outil, et chaque goutte rend son volume a la nappe
   * en se posant.
   * @returns {number} volume effectivement ajoute (> 0) ou retire (< 0)
   */
  pour(wx, wz, radius, volume) {
    if (volume >= 0) {
      this._pourRemainder += volume;
      let n = Math.floor(this._pourRemainder / DROPLET_VOLUME);
      if (n <= 0) return 0;
      this._pourRemainder -= n * DROPLET_VOLUME;
      const D = this.droplets;
      let added = 0;
      for (; n > 0; n--) {
        const a = D.rand() * Math.PI * 2;
        const rr = radius * Math.sqrt(D.rand()) * 0.72;
        const x = wx + Math.cos(a) * rr, z = wz + Math.sin(a) * rr;
        const ground = D.groundAt(x, z);
        const level = this.levelAt(x, z);
        const top = level > ground ? level : ground;
        const y = top + 0.10 + D.rand() * 0.10;
        if (D.emit(x, y, z, 0, -0.3, 0, DROPLET_VOLUME, 0.05) < 0) {
          // Plus de place en vol : le volume rejoint la nappe directement.
          this.land(x, z, DROPLET_VOLUME, 0.05);
        }
        added += DROPLET_VOLUME;
      }
      return added;
    }
    // Eponge : on retire de la nappe, proportionnellement a ce qu'il y a.
    let want = -volume;
    const hc = this.hc, sim = this.simMask;
    const r2 = radius * radius;
    const cx = (wx - ORIGIN_X) / WC - 0.5, cz = (wz - ORIGIN_Z) / WC - 0.5;
    const reach = Math.ceil(radius / WC) + 1;
    const x0 = clamp(Math.floor(cx - reach), 0, WN - 1), x1 = clamp(Math.ceil(cx + reach), 0, WN - 1);
    const z0 = clamp(Math.floor(cz - reach), 0, WM - 1), z1 = clamp(Math.ceil(cz + reach), 0, WM - 1);
    let removed = 0;
    for (let z = z0; z <= z1 && want > 0; z++) {
      for (let x = x0; x <= x1 && want > 0; x++) {
        const c = x + WN * z;
        if (!sim[c] || hc[c] <= 0) continue;
        const dx = (x - cx) * WC, dz = (z - cz) * WC;
        if (dx * dx + dz * dz > r2) continue;
        const take = Math.min(hc[c], want / A);
        hc[c] -= take;
        want -= take * A;
        removed += take * A;
      }
    }
    return -removed;
  }

  /**
   * Recale l'eau apres une elevation instantanee du terrain par un outil.
   *
   * Le solveur stocke une PROFONDEUR, alors que le rendu utilise la surface
   * libre `fond + h`. Si un seau ajoute 60 cm de sable sans retirer ces 60 cm
   * a `h`, la surface libre monte elle aussi de 60 cm et le plan d'eau se
   * tend en grandes aiguilles le long de la tour. On conserve donc l'ancien
   * NIVEAU, et l'eau chassee est rendue aux cellules mouillees voisines : le
   * volume total ne change pas. Un creusement, lui, conserve la profondeur :
   * le niveau baisse et les voisines comblent au pas suivant, sans creer
   * d'eau.
   *
   * @param {ArrayLike<number>} columns indices XZ fins touches
   * @returns {number} volume d'eau chasse, en m3
   */
  displaceByTerrainRise(columns) {
    const surf = this.field.surfaceH, hc = this.hc, bed = this.bed;
    const seen = this._visited, queue = this._queue, receivers = this._receivers;
    let n = 0;
    // 1. cellules d'eau touchees (sans doublon).
    for (let k = 0; k < columns.length; k++) {
      const fc = columns[k];
      const c = ((fc % NX) >> 1) + WN * (((fc / NX) | 0) >> 1);
      if (seen[c] === 1) continue;
      seen[c] = 1; queue[n++] = c;
    }
    if (n === 0) return 0;
    // 2. nouveau fond, ancien niveau, exces.
    let excess = 0;
    for (let k = 0; k < n; k++) {
      const c = queue[k];
      const x = c % WN, z = (c / WN) | 0;
      const r0 = NX * (z * SUB), r1 = r0 + NX, fx0 = x * SUB;
      let m = surf[r0 + fx0];
      if (surf[r0 + fx0 + 1] > m) m = surf[r0 + fx0 + 1];
      if (surf[r1 + fx0] > m) m = surf[r1 + fx0];
      if (surf[r1 + fx0 + 1] > m) m = surf[r1 + fx0 + 1];
      const oldBed = bed[c];
      bed[c] = m;
      if (hc[c] <= 0 || m <= oldBed) continue;
      const level = oldBed + hc[c];
      const hNew = level > m ? level - m : 0;
      excess += (hc[c] - hNew) * A;
      hc[c] = hNew;
    }
    const displaced = excess;
    // 3. redistribution sur la NAPPE CONNECTEE : on parcourt de proche en
    //    proche les cellules mouillees qui touchent les cellules chassees.
    //    Si ce parcours atteint la mer du large, elle absorbe (reservoir
    //    infini) ; sinon la flaque entiere monte d'autant, ce qui est
    //    exactement ce que fait une tour posee dans une douve fermee.
    if (excess > 0) {
      const open = this.openMask;
      let toSea = false, count = 0, head = 0;
      const visit = (q) => {
        if (seen[q]) return;
        if (open[q]) { toSea = true; return; }
        if (hc[q] <= WATER_EPSILON) return;
        seen[q] = 2; receivers[count++] = q;
      };
      for (let k = 0; k < n && !toSea; k++) {
        const c = queue[k];
        const x = c % WN, z = (c / WN) | 0;
        if (x > 0) visit(c - 1);
        if (x + 1 < WN) visit(c + 1);
        if (z > 0) visit(c - WN);
        if (z + 1 < WM) visit(c + WN);
      }
      while (head < count && !toSea) {
        const q = receivers[head++];
        const x = q % WN, z = (q / WN) | 0;
        if (x > 0) visit(q - 1);
        if (x + 1 < WN) visit(q + 1);
        if (z > 0) visit(q - WN);
        if (z + 1 < WM) visit(q + WN);
      }
      if (!toSea) {
        // PLAFOND. Un seau de sable verse a 26 Hz dans le jet de rive, au
        // moment ou il est coupe de la mer, chassait a chaque passage un
        // demi-litre vers trois ou quatre cellules mouillees : des colonnes
        // d'eau d'un metre au coeur du tas, qui redescendaient en rideau sur
        // ses flancs. Une cellule ne monte donc jamais de plus de DISPLACE_RISE
        // par evenement, ni au-dessus du niveau de la mer plus DISPLACE_ABOVE ;
        // ce qui ne trouve pas de place est repute parti vers le large, comme
        // l'eau qu'une main chasse d'une flaque. Une tour dans une douve
        // fermee fait toujours monter la douve : de quelques millimetres.
        const lvlCap = this.seaLevel + DISPLACE_ABOVE;
        const spread = (list, m) => {
          let left = excess;
          for (let pass = 0; pass < 3 && left > 1e-9; pass++) {
            const each = left / (m * A);
            for (let k = 0; k < m; k++) {
              const q = list[k];
              const room = Math.min(DISPLACE_RISE, lvlCap - (bed[q] + hc[q]));
              const d = room > 0 ? Math.min(each, room) : 0;
              hc[q] += d; left -= d * A;
            }
          }
          if (left > 0) this.stats.spilled += left;
        };
        if (count > 0) spread(receivers, count);
        else spread(queue, n);   // aucune voisine : l'eau reste sur place
      }
      for (let k = 0; k < count; k++) seen[receivers[k]] = 0;
    }
    // Le mur du large ne bouge que si une cellule de la mer imposee vient
    // d'etre bouchee ; la nappe, si le fond a franchi le seuil qui la coupe.
    let bandDirty = false, seepDirty = false;
    for (let k = 0; k < n; k++) {
      const c = queue[k];
      seen[c] = 0;
      if (this.openMask[c] && bed[c] + WATER_EPSILON >= this.seaLevel) bandDirty = true;
      if (bed[c] > this.baseBed[c] + SEEP_BLOCK_RISE && this.seepMask[c]) seepDirty = true;
    }
    if (bandDirty) this.updateBand(true);
    else if (seepDirty) this.updateSeepMask();
    this.rescan();
    this.syncFine();
    return displaced;
  }

  /** Hauteur d'eau (m) a une position monde, interpolee sur la grille fine. */
  depthAt(wx, wz) {
    if (this.gpu && this.gpu.fineReady) {
      // Les champs fins vivent sur le GPU : on interpole la nappe grossiere
      // entre cellules mouillees, comme syncFine, et on coupe par le terrain.
      const u = clamp((wx - ORIGIN_X) / WC - 0.5, 0, WN - 1.001);
      const v = clamp((wz - ORIGIN_Z) / WC - 0.5, 0, WM - 1.001);
      const x0 = u | 0, z0 = v | 0, tx = u - x0, tz = v - z0;
      const hc = this.hc, bed = this.bed;
      let sum = 0, ws = 0;
      const c00 = x0 + WN * z0, c10 = c00 + 1, c01 = c00 + WN, c11 = c01 + 1;
      if (hc[c00] > WATER_EPSILON) { const w = (1 - tx) * (1 - tz); sum += w * (bed[c00] + hc[c00]); ws += w; }
      if (hc[c10] > WATER_EPSILON) { const w = tx * (1 - tz); sum += w * (bed[c10] + hc[c10]); ws += w; }
      if (hc[c01] > WATER_EPSILON) { const w = (1 - tx) * tz; sum += w * (bed[c01] + hc[c01]); ws += w; }
      if (hc[c11] > WATER_EPSILON) { const w = tx * tz; sum += w * (bed[c11] + hc[c11]); ws += w; }
      if (ws <= 1e-6) return 0;
      const d = sum / ws - this.field.surfaceHeightAt(wx, wz);
      return d > WATER_EPSILON ? d : 0;
    }
    const fx = clamp((wx - ORIGIN_X) / VOXEL - 0.5, 0, NX - 1.001);
    const fz = clamp((wz - ORIGIN_Z) / VOXEL - 0.5, 0, NZ - 1.001);
    const x0 = fx | 0, z0 = fz | 0;
    const tx = fx - x0, tz = fz - z0;
    const h = this.h;
    const a = h[x0 + NX * z0], b = h[x0 + 1 + NX * z0];
    const c = h[x0 + NX * (z0 + 1)], d = h[x0 + 1 + NX * (z0 + 1)];
    return (a * (1 - tx) + b * tx) * (1 - tz) + (c * (1 - tx) + d * tx) * tz;
  }

  /** Volume total d'eau libre (nappe simulee + gouttes), en m3. */
  totalVolume() {
    const hc = this.hc, sim = this.simMask;
    let v = 0;
    for (let c = 0; c < WCOLS; c++) if (sim[c]) v += hc[c];
    return v * A + this.droplets.volume();
  }

  // -------------------------------------------------------------------------
  // BOUCLE
  // -------------------------------------------------------------------------

  /** @param {number} dt secondes de jeu */
  step(dt) {
    const t0 = performance.now();
    this.time += dt * this.tideSpeed;

    // --- maree : sinusoide lente ---------------------------------------------
    this.tide = Math.sin((this.time / TIDE_PERIOD) * Math.PI * 2);
    this.tideLevel = SEA_LEVEL + this.tide * TIDE_AMPLITUDE;

    // SURCOTE DE DEFERLEMENT (set-up). Apres deferlement, le gradient de
    // tension de radiation RELEVE le plan d'eau moyen : 10 cm sous "Houle",
    // 22 cm sous "Tempete". C'est une elevation PERMANENTE tant que la houle
    // dure — "une maree supplementaire silencieuse" — et c'est elle qui fait
    // que le rivage moyen recule visiblement des qu'on monte la molette.
    //
    // Pourquoi une parametrisation et non un resultat du solveur : le set-up
    // EST produit par le solveur, mais a 8 cm de maille il n'en sort qu'une
    // fraction. C'est la limite bien connue des schemas en eaux peu profondes
    // a maille grossiere sur un front mouille/sec. On complete donc par la
    // formule de Stockdon et al. (2006), qui est une mesure de terrain.
    // Rampe lente : sans elle, changer d'etat de mer ferait sauter la mer.
    const target = this.waves.setupHeight;
    this.waveSetup += (target - this.waveSetup) * clamp(dt * 0.5, 0, 1);
    this.seaLevel = this.tideLevel + this.waveSetup;

    this.updateWaterTable();
    this.updateBand();
    this.waves.update(dt);
    if (this.moisture) this.moisture.tableH = this.tableH;
    // `swash` reste l'entree de l'ambiance sonore : la clameur doit monter
    // AVANT la serie, pas pendant. L'enveloppe de groupe la telegraphie.
    this.swash = this.waves.hsEffective * this.waves.groupAmp * 0.5;

    // Les gouttes volent a la cadence du jeu : elles sont peu nombreuses et
    // leur mouvement doit rester fluide a l'ecran.
    this.droplets.step(dt, this._levelAt, this._land);

    // La nappe avance a WATER_SIM_HZ, avec ses sous-pas CFL a l'interieur.
    // Plafond de trois pas par appel : une frame de 100 ms est rattrapee en
    // trois pas et non en une spirale.
    const simDt = 1 / WATER_SIM_HZ;
    this._simAcc += dt;
    let solves = 0;
    while (this._simAcc >= simDt - 1e-9 && solves < 3) {
      this.solve(simDt);
      this._simAcc -= simDt;
      solves++;
    }
    if (this._simAcc > simDt) this._simAcc = 0;

    this.stats.droplets = this.droplets.count;
    this.stats.ms = this.stats.ms * 0.85 + (performance.now() - t0) * 0.15;
  }

  /**
   * Branche le solveur GPU. Il commence par se valider contre le CPU
   * pendant quelques pas, puis prend la boucle de sous-pas a sa charge ;
   * au moindre ecart il se retire et le CPU continue. Voir WaterGPU.js.
   */
  attachGPU(gpu) {
    this.gpu = gpu;
  }

  /** Un pas du solveur, decoupe en sous-pas CFL. */
  solve(dt) {
    this.refreshBed();
    this.imposeOpenSea();
    const n = this.substeps(dt);
    this.substepCount = n;
    const sub = dt / n;
    const gpu = this.gpu;
    if (gpu && gpu.mode === 'ready') gpu.activate();
    const onGpu = !!gpu && gpu.mode === 'active';
    // En mode GPU, hMaxSea et uMax sont ceux de la derniere relecture : on
    // ne les remet pas a zero, la CFL du pas suivant en a besoin.
    if (!onGpu) { this.hMaxSea = 0; this.uMax = 0; }
    // Budget d'embruns par pas : de 6 gouttelettes en clapot a 46 en tempete.
    this._sprayLeft = this.onSpray ? Math.round(6 + 40 * this.waves.power) : 0;
    if (this.seepEnabled) this.seep(dt);
    if (onGpu) {
      gpu.solve(sub, n);
      this.computeScanRanges();
      this.foamAndSpray(dt);
    } else {
      const validating = !!gpu && gpu.mode === 'validating';
      if (validating) gpu.captureStart();
      this.runSubsteps(sub, n);
      if (validating) gpu.validateSolve(sub, n);
    }
    this.advect(dt);
    this.infiltrate(dt);
    // Quand le GPU produit les champs fins du rendu, le CPU ne les
    // reconstruit que pour l'erosion, un pas sur trois.
    const fineOnGpu = onGpu && gpu.fineReady;
    if (!fineOnGpu) this.syncFine();
    if (++this._erodeTick >= 3) {
      this._erodeTick = 0;
      if (fineOnGpu && this.erosionEnabled) this.syncFine();
      this.erode(dt * 3);
      this.undermine(dt * 3);
    }
  }

  /** La boucle de sous-pas CFL, sur CPU : la reference que le GPU transcrit. */
  runSubsteps(sub, n) {
    for (let k = 0; k < n; k++) {
      this.computeScanRanges();
      this.flux(sub);
      this.integrate(sub);
      this.breaking(sub);
      this.waves.applyGeneration(sub);
    }
  }

  /**
   * Ecume et embruns quand la boucle tourne sur le GPU : le deferlement `b`
   * relu pilote la production d'ecume (a la cadence du pas et non du
   * sous-pas, ce qui ne se voit pas) et les embruns, comme dans breaking().
   */
  foamAndSpray(dt) {
    const h = this.hc, brk = this.brk, foam = this.foamc, sim = this.simMask;
    const foamDecay = Math.exp(-dt / FOAM_TAU_WET);
    let active = 0;
    for (let z = 1; z < WM - 1; z++) {
      const row = WN * z;
      const xa = Math.max(1, this.scanA[z]);
      const xb = Math.min(WN - 2, this.scanB[z]);
      for (let x = xa; x <= xb; x++) {
        const c = row + x;
        if (!sim[c]) continue;
        const hw = h[c];
        if (hw < WATER_EPSILON) continue;
        const b = brk[c];
        if (b < 0.02) { foam[c] *= foamDecay; continue; }
        active++;
        const gate = 0.15 + 0.85 * smoothstep(BREAK_DEPTH_MIN, BREAK_DEPTH_FULL, hw);
        const fm = foam[c] * foamDecay + b * b * gate * FOAM_GAIN * dt;
        foam[c] = fm >= 1.2 ? 1.2 : (fm >= 0 ? fm : 0);
        const bRoll = b * smoothstep(BREAK_DEPTH_MIN, BREAK_DEPTH_FULL, hw);
        if (this._sprayLeft > 0 && bRoll > 0.3 && hw > 0.05) this.spray(c, x, z, hw, b);
      }
    }
    this.stats.breaking = active;
  }

  /**
   * Nombre de sous-pas necessaires pour respecter la CFL, borne a SUBSTEP_MAX.
   *
   * La borne dure est indispensable : si une frame prend 100 ms (chargement,
   * GC), le calcul exact demanderait une douzaine de sous-pas, le solveur
   * mangerait la frame suivante, et on entrerait dans une spirale de la mort.
   * Le schema pipe est docile quand on viole la CFL — la mise a l'echelle des
   * flux borne structurellement le transport, donc il DIFFUSE au lieu
   * d'exploser. Deux frames un peu molles valent mieux qu'un jeu qui se fige.
   */
  substeps(dt) {
    const c = Math.sqrt(GRAVITY * Math.min(Math.max(this.hMaxSea, 0.01), HFACE_CAP)) + this.uMax;
    return clamp(Math.ceil((dt * c) / (CFL_SAFE * WC)), 1, SUBSTEP_MAX);
  }

  /**
   * Prepare les intervalles a parcourir : pour chaque ligne, l'union de ses
   * bornes mouillees et de celles de ses voisines, elargie d'une marge. C'est
   * ce qui autorise l'eau a franchir la frontiere d'une ligne seche.
   */
  computeScanRanges() {
    for (let z = 0; z < WM; z++) {
      let a = this.rowMin[z], b = this.rowMax[z];
      if (z > 0) { if (this.rowMin[z - 1] < a) a = this.rowMin[z - 1]; if (this.rowMax[z - 1] > b) b = this.rowMax[z - 1]; }
      if (z + 1 < WM) { if (this.rowMin[z + 1] < a) a = this.rowMin[z + 1]; if (this.rowMax[z + 1] > b) b = this.rowMax[z + 1]; }
      if (b < a) { this.scanA[z] = 1; this.scanB[z] = 0; continue; } // ligne isolee et seche
      this.scanA[z] = Math.max(0, a - SCAN_MARGIN);
      this.scanB[z] = Math.min(WN - 1, b + SCAN_MARGIN);
    }
  }

  /**
   * Suintement de la nappe, seule source d'eau libre hors de la mer.
   *
   * Le fond doit passer FRANCHEMENT sous la nappe locale (SEEPAGE_MARGIN) : un
   * coup de pelle qui l'effleure ne doit pas produire un film d'eau, sans quoi
   * le joueur a l'impression que l'eau sort de nulle part. Et le debit suit la
   * charge : il est proportionnel a la denivellation restante, donc l'eau monte
   * vite au fond d'un trou profond et s'arrete doucement en arrivant au niveau
   * de la nappe. Voir l'eau monter petit a petit fait partie du plaisir.
   *
   * Ce qui reste vrai et voulu : creuser au BORD DE L'EAU donne une flaque,
   * creuser en HAUT DE PLAGE donne un trou sec, et il faut une tranchee pour y
   * amener la mer. C'est l'invariant de conception de tout le systeme.
   */
  seep(dt) {
    const hc = this.hc, bed = this.bed, table = this.tableC;
    const sim = this.simMask, mask = this.seepMask;
    const kSeep = clamp(dt * SEEPAGE_RATE, 0, 1);
    // Le debit suit la charge, mais jamais plus vite que l'eau ne traverse
    // le sable : voir SEEPAGE_MAX. Et seulement la ou la nappe a un chemin
    // de sable naturel depuis la mer : voir SEEP_BLOCK_RISE.
    const cap = SEEPAGE_MAX * dt;
    let added = 0;
    for (let c = 0; c < WCOLS; c++) {
      if (!sim[c] || !mask[c]) continue;
      const want = table[c] - bed[c] - SEEPAGE_MARGIN;
      if (want > hc[c]) {
        let d = (want - hc[c]) * kSeep;
        if (d > cap) d = cap;
        hc[c] += d;
        added += d;
      }
    }
    this.stats.seeped += added * A;
    // Les bornes de lignes sont recalculees a partir de zero une fois sur huit,
    // pour rattraper les cellules nouvellement mouillees par la nappe.
    this.rescanRows = (this.rescanRows + 1) & 7;
    if (this.rescanRows === 0) this.rescan();
  }

  /**
   * Mise a jour des flux entre cellules, puis mise a l'echelle.
   *
   * DEUX CORRECTIONS PAR RAPPORT AU MODELE PIPE D'ORIGINE.
   *
   * 1. LA CELERITE DEPEND DE LA PROFONDEUR. Le coefficient dt*A*g/L = dt*g*dx
   *    donne une equation d'onde de celerite sqrt(g*dx), la meme dans 5 cm que
   *    dans 90 cm d'eau. La bonne forme linearisee de la quantite de mouvement
   *    est dq/dt = -g h d(eta)/dx : le facteur est g*h_face. C'est cette
   *    dependance, et elle seule, qui produit la levee sur le haut-fond (donc
   *    le gonflement de la crete), le raidissement du front, le deferlement et
   *    un jet de rive qui est PROJETE au lieu de deborder.
   *
   *    h_face est la profondeur "hydrauliquement connectee" entre deux
   *    cellules : min des surfaces libres moins max des fonds. La formulation
   *    min/max est celle qui evite qu'une cellule pleine pousse de l'eau dans
   *    un voisin dont le FOND est plus haut que sa propre surface libre.
   *
   * 3. LA QUANTITE DE MOUVEMENT EST ADVECTEE. Le modele pipe n'a pas de
   *    terme u·du/dx : ses vagues ne se raidissent que par la difference de
   *    celerite entre crete et creux, et n'atteignent jamais le ressaut avant
   *    la plage. On ajoute df/dt = -d(u·q)/dx, en amont (le flux de quantite
   *    de mouvement au centre d'une cellule prend le debit de la face d'ou
   *    vient l'eau). C'est ce qui fait courir la crete plus vite que le
   *    creux, dresser le front, et donner a la vague de quoi s'abattre.
   *    Schema amont : dissipatif, donc stable sous la CFL deja respectee.
   *
   * 2. LE FROTTEMENT EST PHYSIQUE. Un amortissement global mangeait 60 % de la
   *    quantite de mouvement chaque seconde, partout, y compris en pleine mer.
   *    On le remplace par un frottement de fond semi-implicite (donc
   *    inconditionnellement stable) :
   *
   *        f <- f / (1 + dt * (f_w/2) * |u| / h)
   *
   *    Il mord la ou il doit — dans la lame de 5 cm du jet de rive — et nulle
   *    part ailleurs. Le coefficient f_w est DOUBLE a la montee : le front du
   *    jet est un choc turbulent charge de bulles. Ce biais n'est pas un
   *    detail : c'est lui qui produit le transport net vers la terre, donc la
   *    berme, donc une plage qui se maintient au lieu de se raboter.
   */
  flux(dt) {
    const surf = this.bed;
    const h = this.hc;
    const fx = this.fx, fz = this.fz, fxW = this.fxW, fzS = this.fzS;
    const vx = this.vxc, vz = this.vzc;
    const sim = this.simMask;
    // f += dt * g * h_face * (H_i - H_j). Le schema linearise donne alors
    // d2h/dt2 = g*h_face * d2h/dx2, soit c = sqrt(g*h). CQFD.
    const kBase = dt * GRAVITY;
    const damp = Math.pow(WATER_DAMPING_NUM, dt * 60);
    const sea = this.seaLevel;
    const halfDt = dt * 0.5;
    const advK = dt / WC;
    // Epaisseur de reference du frottement : celle de la LAME du jet de rive
    // (~0,30 Hs), pas celle du film residuel. Voir FRIC_DEPTH_MIN.
    const hFric = Math.max(FRIC_DEPTH_MIN, FRIC_DEPTH_HS * this.waves.hsEffective);

    for (let z = 0; z < WM; z++) {
      const row = WN * z;
      const xa = this.scanA[z];
      const xb = this.scanB[z];
      for (let x = xa; x <= xb; x++) {
        const c = row + x;
        if (!sim[c]) continue;
        const hcv = h[c];
        const bc = surf[c];
        const H = bc + hcv;

        // --- frottement de fond, semi-implicite ------------------------------
        // Applique aux faces que la cellule POSSEDE. Chaque face n'appartenant
        // qu'a une seule cellule, elle n'est freinee qu'une fois.
        let fric = 1;
        if (hcv >= WATER_EPSILON) {
          const ux = vx[c], uz = vz[c];
          const sp = Math.sqrt(ux * ux + uz * uz);
          // La normale de rivage pointe vers la MER : le jet monte donc dans le
          // sens -n. Signe verifie par le test de biais montee/descente.
          const onshore = (ux * SHORE_NX + uz * SHORE_NZ) < 0;
          const fw = onshore ? FW_UPRUSH : FW_BACKWASH;
          fric = 1 / (1 + halfDt * fw * sp / (hcv > hFric ? hcv : hFric));
        }

        // --- face vers +X ------------------------------------------------------
        {
          const inside = x + 1 < WN;
          const n = c + 1;
          const hn = inside ? h[n] : 0;
          if (inside && hcv < WATER_EPSILON && hn < WATER_EPSILON) {
            fx[c] = 0;
          } else {
            const bn = inside ? surf[n] : bc;
            const Hn = inside ? bn + hn : sea;
            const crest = bc > bn ? bc : bn;
            const overtop = (H > Hn ? H : Hn) - crest;
            // Une face dont la crete est au-dessus des DEUX surfaces libres
            // est un mur, pas un tuyau de profondeur minimale. Le plancher
            // HFACE_MIN ne sert qu'au front mouille/sec sur un fond que l'eau
            // peut reellement franchir.
            if (inside && overtop <= WATER_EPSILON) {
              fx[c] = 0;
            } else {
              let hF = (H < Hn ? H : Hn) - crest;
              if (hF < HFACE_MIN) hF = Math.min(HFACE_MIN, Math.max(overtop, WATER_EPSILON));
              else if (hF > HFACE_CAP) hF = HFACE_CAP;
              let f = (fx[c] * damp + kBase * hF * (H - Hn)) * fric;
              // Advection amont de la quantite de mouvement (voir en-tete).
              if (inside && hcv > ADV_MIN_H && hn > ADV_MIN_H) {
                const uc = vx[c], un = vx[n];
                const Fc = uc * (uc > 0 ? (x > 0 ? fx[c - 1] : fxW[z]) : fx[c]);
                const Fn = un * (un > 0 ? fx[c] : (x + 2 < WN ? fx[n] : 0));
                f -= (Fn - Fc) * advK;
              }
              // Le bord du domaine est un EXUTOIRE a sens unique : l'eau s'y
              // echappe (elle rejoint la mer du hors-champ) mais rien n'y entre.
              // Et elle s'echappe A SA PROPRE VITESSE : le courant de derive
              // que pousse une houle oblique doit sortir librement, sinon il
              // s'empile contre le bord en une colonne d'eau visible.
              if (!inside) {
                const out = (vx[c] > 0 ? vx[c] : 0) * hcv * L;
                if (out > f) f = out;
                if (f < 0) f = 0;
              }
              if (f !== f) f = 0; // garde NaN : le flux est un etat PERSISTANT
              fx[c] = f;
            }
          }
        }
        // --- face vers +Z ------------------------------------------------------
        {
          const inside = z + 1 < WM;
          const n = c + WN;
          const hn = inside ? h[n] : 0;
          if (inside && hcv < WATER_EPSILON && hn < WATER_EPSILON) {
            fz[c] = 0;
          } else {
            const bn = inside ? surf[n] : bc;
            const Hn = inside ? bn + hn : sea;
            const crest = bc > bn ? bc : bn;
            const overtop = (H > Hn ? H : Hn) - crest;
            if (inside && overtop <= WATER_EPSILON) {
              fz[c] = 0;
            } else {
              let hF = (H < Hn ? H : Hn) - crest;
              if (hF < HFACE_MIN) hF = Math.min(HFACE_MIN, Math.max(overtop, WATER_EPSILON));
              else if (hF > HFACE_CAP) hF = HFACE_CAP;
              let f = (fz[c] * damp + kBase * hF * (H - Hn)) * fric;
              if (inside && hcv > ADV_MIN_H && hn > ADV_MIN_H) {
                const uc = vz[c], un = vz[n];
                const Fc = uc * (uc > 0 ? (z > 0 ? fz[c - WN] : fzS[x]) : fz[c]);
                const Fn = un * (un > 0 ? fz[c] : (z + 2 < WM ? fz[n] : 0));
                f -= (Fn - Fc) * advK;
              }
              if (!inside) {
                const out = (vz[c] > 0 ? vz[c] : 0) * hcv * L;
                if (out > f) f = out;
                if (f < 0) f = 0;
              }
              if (f !== f) f = 0; // garde NaN
              fz[c] = f;
            }
          }
        }
        // --- faces des bords -X et -Z (exutoires, meme clapet) -----------------
        if (x === 0) {
          let hF = (H < sea ? H : sea) - bc;
          hF = hF < HFACE_MIN ? HFACE_MIN : hF > HFACE_CAP ? HFACE_CAP : hF;
          let f = (fxW[z] * damp + kBase * hF * (sea - H)) * fric;
          const out = -(vx[c] < 0 ? -vx[c] : 0) * hcv * L;
          if (out < f) f = out;
          fxW[z] = f > 0 ? 0 : f;
        }
        if (z === 0) {
          let hF = (H < sea ? H : sea) - bc;
          hF = hF < HFACE_MIN ? HFACE_MIN : hF > HFACE_CAP ? HFACE_CAP : hF;
          let f = (fzS[x] * damp + kBase * hF * (sea - H)) * fric;
          const out = -(vz[c] < 0 ? -vz[c] : 0) * hcv * L;
          if (out < f) f = out;
          fzS[x] = f > 0 ? 0 : f;
        }
      }
    }
  }

  /**
   * Bilan des flux -> nouvelle hauteur d'eau et vitesse.
   *
   * Trois passes, et l'ordre compte.
   *
   *   A. chaque cellule calcule de combien elle doit reduire ses sorties pour
   *      ne jamais donner plus d'eau qu'elle n'en a (garde-fou G1) ;
   *   B. chaque FACE est mise a l'echelle par le facteur de la cellule
   *      DONNEUSE, celle d'ou part le flux. Une face etant partagee, les deux
   *      cellules voient ainsi exactement la meme valeur : le schema reste
   *      conservatif a la machine pres ;
   *   C. divergence, nouvelle hauteur, vitesse.
   *
   * C'est cette mise a l'echelle qui rend le schema DIFFUSIF et non explosif
   * quand la CFL est violee : elle borne structurellement le transport. Elle
   * doit donc rester APRES l'ajout de g*h_face et APRES le frottement.
   */
  integrate(dt) {
    const h = this.hc;
    const fx = this.fx, fz = this.fz, fxW = this.fxW, fzS = this.fzS;
    const scale = this.scale;
    const vx = this.vxc, vz = this.vzc;
    const sim = this.simMask;
    let wet = 0, vol = 0;
    const invA = 1 / A;
    const availK = A / dt;
    // Echelle de profondeur du plafond de Froude : celle du RESSAUT qui lance
    // le jet de rive, pas celle du film residuel qui reste sur le sable.
    const hmFr = Math.max(FR_DEPTH_MIN, this.waves.hsEffective);
    const spMaxFloor = Math.min(U_ABS_MAX, FR_MAX * Math.sqrt(GRAVITY * hmFr));

    // --- A. facteur de mise a l'echelle, par cellule --------------------------
    for (let z = 0; z < WM; z++) {
      const row = WN * z;
      const xa = this.scanA[z], xb = this.scanB[z];
      for (let x = xa; x <= xb; x++) {
        const c = row + x;
        if (!sim[c]) continue;
        const fW = x > 0 ? fx[c - 1] : fxW[z];
        const fS = z > 0 ? fz[c - WN] : fzS[x];
        let out = 0;
        if (fx[c] > 0) out += fx[c];
        if (fW < 0) out -= fW;
        if (fz[c] > 0) out += fz[c];
        if (fS < 0) out -= fS;
        const avail = h[c] * availK;
        scale[c] = out > avail ? avail / out : 1;
      }
    }
    // --- B. mise a l'echelle des faces, par la cellule donneuse ---------------
    for (let z = 0; z < WM; z++) {
      const row = WN * z;
      const xa = this.scanA[z], xb = this.scanB[z];
      for (let x = xa; x <= xb; x++) {
        const c = row + x;
        if (!sim[c]) continue;
        const a = fx[c];
        if (a > 0) fx[c] = a * scale[c];
        else if (a < 0 && x + 1 < WN) fx[c] = a * scale[c + 1];
        const b = fz[c];
        if (b > 0) fz[c] = b * scale[c];
        else if (b < 0 && z + 1 < WM) fz[c] = b * scale[c + WN];
        if (x === 0 && fxW[z] < 0) fxW[z] *= scale[c];
        if (z === 0 && fzS[x] < 0) fzS[x] *= scale[c];
      }
    }
    // --- C. divergence --------------------------------------------------------
    for (let z = 0; z < WM; z++) {
      const row = WN * z;
      const xa = this.scanA[z], xb = this.scanB[z];
      let rmin = WN, rmax = -1;
      for (let x = xa; x <= xb; x++) {
        const c = row + x;
        if (!sim[c]) continue;
        const fW = x > 0 ? fx[c - 1] : fxW[z];
        const fE = fx[c];
        const fS = z > 0 ? fz[c - WN] : fzS[x];
        const fN = fz[c];
        const h0 = h[c];
        let h1 = h0 + (fW - fE + fS - fN) * dt * invA;
        // `!(h1 > 0)` attrape aussi les NaN (toute comparaison avec NaN est
        // fausse) : c'est LA barriere qui empeche une valeur corrompue de
        // contaminer le champ entier en quelques frames.
        if (!(h1 > 0)) h1 = 0;
        h[c] = h1;

        const hm = (h0 + h1) * 0.5;
        if (hm > WATER_EPSILON) {
          // Debit moyen des deux faces opposees -> vitesse moyenne de cellule.
          let ux = ((fW + fE) * 0.5) / (L * hm);
          let uz = ((fS + fN) * 0.5) / (L * hm);
          // Garde-fou : plafond de FROUDE, pas plafond de vitesse. Le plancher
          // de profondeur (FR_DEPTH_MIN) est indispensable : sans lui, la
          // pointe du jet de rive, qui est une nappe BALISTIQUE et non une
          // onde de gravite, serait plafonnee a 0,35 m/s.
          const sp = Math.sqrt(ux * ux + uz * uz);
          const spMax = hmFr > hm ? spMaxFloor
            : Math.min(U_ABS_MAX, FR_MAX * Math.sqrt(GRAVITY * hm));
          if (!(sp >= 0)) { ux = 0; uz = 0; } // garde NaN (flux corrompu)
          else if (sp > spMax) { const s = spMax / sp; ux *= s; uz *= s; }
          vx[c] = ux; vz[c] = uz;
          const spc = sp < spMax ? sp : spMax;
          if (spc > this.uMax) this.uMax = spc;
          if (h1 > this.hMaxSea) this.hMaxSea = h1;
          wet++;
          vol += h1;
        } else {
          vx[c] = 0; vz[c] = 0;
        }
        // TOUTE cellule qui porte de l'eau reste dans les bornes, y compris
        // un film sous le seuil. Une cellule sortie des bornes n'a plus ses
        // faces recalculees : sa voisine continuait d'appliquer un flux
        // perime que personne ne recevait — l'eau disparaissait (ou
        // apparaissait) par ce trou, quelques millilitres par seconde.
        if (h1 > 0) {
          if (x < rmin) rmin = x;
          rmax = x;
        }
      }
      this.rowMin[z] = rmin;
      this.rowMax[z] = rmax;
    }
    this.stats.wetCells = wet;
    this.stats.volume = vol * A;
  }

  /**
   * DEFERLEMENT.
   *
   * Detection : critere de Kennedy et al. (2000) sur la VITESSE DE MONTEE de la
   * surface libre — on deferle quand d(eta)/dt depasse une fraction de la
   * celerite — complete par un critere de Froude qui attrape ce que le premier
   * rate : les ressauts STATIONNAIRES, la ou d(eta)/dt ~ 0 mais ou la
   * dissipation est bien reelle (sortie d'une breche de douve, pied de mur).
   *
   * Dissipation : le modele pipe n'a pas d'equation de quantite de mouvement ou
   * l'on pourrait glisser une viscosite de rouleau. On agit donc directement
   * sur les FLUX — ce qui revient exactement au meme : c'est la perte de
   * quantite de mouvement au travers d'un ressaut hydraulique. Sans ce terme,
   * l'energie de la houle arrive intacte au rivage et rase tout ; avec lui, un
   * haut-fond ou un brise-lames construit par le joueur DISSIPE reellement.
   */
  breaking(dt) {
    const h = this.hc, surf = this.bed;
    const vx = this.vxc, vz = this.vzc;
    const fx = this.fx, fz = this.fz;
    const etaPrev = this.etaPrev, brk = this.brk, foam = this.foamc;
    const sim = this.simMask;
    const invDt = 1 / dt;
    const gain = BREAK_GAIN_BASE + BREAK_GAIN_AGIT * this.waves.agitation;
    const foamDecay = Math.exp(-dt / FOAM_TAU_WET);
    // Montee AMORTIE du critere de Froude (tau = 0,12 s). Le nombre de Froude
    // est calcule sur la vitesse INSTANTANEE d'une lame de quelques
    // millimetres : au bord de la laisse il franchit 1 un pas sur deux, et un
    // interrupteur binaire transformait ce bruit en clignotement d'ecume. Un
    // ressaut REEL est stationnaire par definition : il maintient Fr > 1
    // pendant des secondes.
    const kFr = 1 - Math.exp(-dt / 0.12);
    let active = 0;

    for (let z = 1; z < WM - 1; z++) {
      const row = WN * z;
      const xa = Math.max(1, this.scanA[z]);
      const xb = Math.min(WN - 2, this.scanB[z]);
      for (let x = xa; x <= xb; x++) {
        const c = row + x;
        if (!sim[c]) continue;
        const hw = h[c];
        if (hw < WATER_EPSILON) { etaPrev[c] = -1e9; brk[c] = 0; continue; }

        const eta = surf[c] + hw;
        // GARDE DE RE-MOUILLAGE. Une cellule qui vient de se mouiller n'a pas
        // d'histoire de surface libre : y lire le terrain donnerait
        // dEta = hw/dt, et le critere de Kennedy s'allumerait a fond sur
        // toute la laisse. On saute la detection pour ce pas.
        const fresh = etaPrev[c] < -1e8;
        const dEta = fresh ? 0 : (eta - etaPrev[c]) * invDt;
        etaPrev[c] = eta;

        const cel = Math.sqrt(GRAVITY * hw);
        const on = BREAK_ON * cel;
        const off = BREAK_OFF * cel;

        // Un FILM de quelques millimetres n'a pas de rouleau : sa celerite
        // est si faible que le moindre frisson numerique passe le critere de
        // Kennedy, et la plage entiere clignotait d'ecume apres chaque vague.
        // Sous 6 mm, le deferlement ne fait que s'eteindre.
        let b = brk[c];
        if (hw < 0.006) {
          b -= dt / 0.05;
          if (b < 0) b = 0;
        } else if (dEta >= on) {
          b = 1;
        } else if (dEta <= off) {
          // Relachement sur T* = 5 sqrt(h/g) : le rouleau survit a la crete.
          const tStar = 5 * Math.sqrt(hw / GRAVITY);
          b -= dt / (tStar > 0.05 ? tStar : 0.05);
          if (b < 0) b = 0;
        } else {
          const t = (dEta - off) / (on - off);
          if (t > b) b = t;
        }

        // Ressaut stationnaire : ecoulement supercritique. MAIS IL NE DOIT PAS
        // ALIMENTER LA DISSIPATION : une langue de jet de rive est
        // supercritique par nature, et la perte d'energie d'une nappe de
        // swash est deja portee par le frottement de fond. `bRoll` (Kennedy
        // seul, porte de profondeur) pilote la dissipation et l'etalement ;
        // `brk` (le max des deux) pilote l'ecume et la surcote de contrainte.
        const bRoll = b * smoothstep(BREAK_DEPTH_MIN, BREAK_DEPTH_FULL, hw);
        const ux = vx[c], uz = vz[c];
        const fr = Math.sqrt(ux * ux + uz * uz) / (cel > 0.04 ? cel : 0.04);
        // Un ressaut demande une LAME : une pellicule de quelques millimetres
        // est supercritique par nature (tout le jet de rive l'est) et ne doit
        // pas blanchir la plage entiere. La porte s'ouvre entre 6 et 30 mm.
        if (fr > 1 && hw > 0.006) {
          const t = (fr - 1) / 0.6;
          const tt = (t > 1 ? 1 : t) * smoothstep(0.006, 0.03, hw);
          if (tt > b) b += (tt - b) * kFr;
        }

        brk[c] = b;
        if (b < 0.02) { foam[c] *= foamDecay; continue; }
        active++;

        // --- 1. dissipation ---------------------------------------------------
        // Semi-implicite, donc inconditionnellement stable quel que soit dt.
        if (bRoll > 0.02) {
          const k = 1 / (1 + gain * bRoll * dt);
          fx[c] *= k; fz[c] *= k;
        }

        // --- 2. etalement du rouleau -----------------------------------------
        // Un ressaut a une epaisseur physique : l'ecume roulante. Sans ce terme,
        // le front reste un choc d'UNE cellule. Stabilite : nu dt / dx^2 <= 0,25.
        // ECHANGE, pas laplacien : ce que la cellule recoit d'une voisine,
        // la voisine le perd. Un laplacien applique cellule par cellule
        // creait ou detruisait de l'eau au bord du rouleau (87 mL sur un seau).
        if (bRoll > 0.02) {
          const k = ROLLER_NU * bRoll * cel * dt / WC;
          this.exchange(c, c + 1, k, sim);
          this.exchange(c, c - 1, k, sim);
          this.exchange(c, c + WN, k, sim);
          this.exchange(c, c - WN, k, sim);
        }

        // --- 3. ecume ---------------------------------------------------------
        // Quadratique en b : un rouleau franc blanchit, un frisson ne fait
        // qu'une frange. C'est ce qui separe la bande de deferlement du reste
        // de la surf zone.
        const foamGate = 0.15 + 0.85 * smoothstep(BREAK_DEPTH_MIN, BREAK_DEPTH_FULL, hw);
        const fm = foam[c] * foamDecay + b * b * foamGate * FOAM_GAIN * dt;
        foam[c] = fm >= 1.2 ? 1.2 : (fm >= 0 ? fm : 0); // clamp NaN-sur

        // --- 4. embruns -------------------------------------------------------
        // La crete qui s'abat projette de l'eau en l'air. Ce sont de vraies
        // gouttes : leur volume est pris a la vague et lui revient en
        // retombant, avec l'ecume qu'elles portent.
        if (this._sprayLeft > 0 && bRoll > 0.3 && hw > 0.05) this.spray(c, x, z, hw, b);
      }
    }
    this.stats.breaking = active;
  }

  /**
   * Embruns d'un rouleau : une brume de gouttelettes projetees depuis la
   * crete, dans le sens de l'ecoulement et vers le haut, d'autant plus haut
   * que la houle est puissante. Elles sont rendues par le systeme de
   * particules du jeu (fines, blanches, elles meurent au contact) : ce n'est
   * pas de l'eau qui compte, c'est de l'air qui blanchit.
   */
  spray(c, x, z, hw, b) {
    const power = this.waves.power;
    const ux = this.vxc[c], uz = this.vzc[c];
    const sp = Math.sqrt(ux * ux + uz * uz);
    if (sp < 0.35) return;
    if (Math.random() > b * (0.25 + 0.6 * power)) return;
    const wx = ORIGIN_X + (x + Math.random()) * WC;
    const wz = ORIGIN_Z + (z + Math.random()) * WC;
    const y = this.bed[c] + hw + 0.02;
    const up = 0.6 + (0.8 + 1.8 * power) * Math.random() + 0.5 * b;
    const vx = ux * 0.9 + (Math.random() - 0.5) * 0.6;
    const vz = uz * 0.9 + (Math.random() - 0.5) * 0.6;
    this.onSpray(wx, y, wz, vx, up, vz);
    this._sprayLeft--;
  }

  /**
   * Transfert conservatif d'une fraction k de la difference de SURFACE LIBRE
   * entre deux cellules, avec la meme regle de crete que le flux : une face
   * dont la crete depasse les deux surfaces est un mur, et rien ne le
   * franchit. Une version en hauteur d'eau faisait grimper le rouleau sur les
   * parois d'une douve et remplissait les enceintes fermees.
   */
  exchange(c, n, k, sim) {
    if (!sim[n]) return;
    const h = this.hc, bed = this.bed;
    const Hc = bed[c] + h[c], Hn = bed[n] + h[n];
    const crest = bed[c] > bed[n] ? bed[c] : bed[n];
    if ((Hc > Hn ? Hc : Hn) <= crest + WATER_EPSILON) return;
    let d = k * (Hn - Hc);
    if (d < 0) { if (h[c] + d < 0) d = -h[c]; }
    else if (h[n] - d < 0) d = h[n];
    h[c] += d;
    h[n] -= d;
  }

  /**
   * Advection semi-lagrangienne du sediment ET de l'ecume.
   *
   * Sans advection, l'ecume reste collee la ou elle est nee et le retrait
   * laisse une nappe blanche immobile qui ne ressemble a rien ; avec, elle
   * s'etire en trainees dans le sens de l'ecoulement, ce qui est la lecture la
   * plus immediate du champ de vitesse pour le joueur.
   */
  advect(dt) {
    const sed = this.sedc, tmp = this.sedTmp;
    const foam = this.foamc, ftmp = this.foamTmp, dry = this.foamDryc;
    const vx = this.vxc, vz = this.vzc, h = this.hc;
    const sim = this.simMask;
    const dryDecay = Math.exp(-dt / FOAM_TAU_DRY);
    const wetDecay = Math.exp(-dt / FOAM_TAU_WET);

    for (let z = 0; z < WM; z++) {
      const row = WN * z;
      const xa = this.scanA[z];
      const xb = this.scanB[z];
      for (let x = xa; x <= xb; x++) {
        const c = row + x;
        if (!sim[c]) { tmp[c] = sed[c]; ftmp[c] = foam[c]; continue; }
        if (h[c] < WATER_EPSILON) {
          tmp[c] = sed[c];
          // La cellule vient de s'assecher : l'ecume se DEPOSE. C'est la laisse
          // d'ecume, celle qui reste sur le sable mouille apres le retrait et
          // qui trahit jusqu'ou la mer est montee.
          if (foam[c] > 0.02) {
            const v = foam[c] * FOAM_DEPOSIT;
            if (v > dry[c]) dry[c] = v;
            foam[c] = 0;
            this._dryFoamActive = true;
          }
          ftmp[c] = 0;
          continue;
        }
        // Eau immobile : rien a transporter.
        const ux = vx[c], uz = vz[c];
        if (ux === 0 && uz === 0) {
          tmp[c] = sed[c];
          let f0 = foam[c] * wetDecay;
          if (dry[c] > 0) { f0 += dry[c] * 0.5; dry[c] *= 0.5; }
          ftmp[c] = f0 >= 1.2 ? 1.2 : (f0 >= 0 ? f0 : 0);
          continue;
        }
        const px = clamp(x - (ux * dt) / WC, 0, WN - 1.001);
        const pz = clamp(z - (uz * dt) / WC, 0, WM - 1.001);
        const x0 = px | 0, z0 = pz | 0;
        const tx = px - x0, tz = pz - z0;
        const i00 = x0 + WN * z0, i10 = i00 + 1;
        const i01 = i00 + WN, i11 = i01 + 1;
        const w00 = (1 - tx) * (1 - tz), w10 = tx * (1 - tz);
        const w01 = (1 - tx) * tz, w11 = tx * tz;
        tmp[c] = sed[i00] * w00 + sed[i10] * w10 + sed[i01] * w01 + sed[i11] * w11;
        let f = (foam[i00] * w00 + foam[i10] * w10 + foam[i01] * w01 + foam[i11] * w11) * wetDecay;
        // L'ecume seche est reprise par l'eau qui repasse dessus.
        if (dry[c] > 0) { f += dry[c] * 0.5; dry[c] *= 0.5; }
        ftmp[c] = f >= 1.2 ? 1.2 : (f >= 0 ? f : 0); // clamp NaN-sur
      }
      for (let x = xa; x <= xb; x++) {
        sed[row + x] = tmp[row + x];
        foam[row + x] = ftmp[row + x];
      }
    }
    // La laisse d'ecume se resorbe partout, y compris loin de l'eau quand la
    // maree s'est retiree : une passe complete a 4 Hz suffit largement.
    if (this._dryFoamActive && ((this._dryFoamTick = (this._dryFoamTick + 1) & 7) === 0)) {
      const k = Math.pow(dryDecay, 8);
      let max = 0;
      for (let c = 0; c < WCOLS; c++) {
        const v = dry[c];
        if (v > 0.002) { dry[c] = v * k; if (v > max) max = v; }
        else if (v > 0) dry[c] = 0;
      }
      if (max === 0) this._dryFoamActive = false;
    }
  }

  /**
   * L'eau de surface s'infiltre dans le sable et le mouille.
   *
   * Chaque colonne fine sous une cellule mouillee boit ce que ses pores
   * peuvent contenir, a la vitesse de Darcy (1,4 mm/s : une flaque de 5 cm
   * dure une trentaine de secondes, assez pour creuser une tranchee et la voir
   * se remplir). Ce qui est bu est retire de la cellule et compte dans
   * `stats.infiltrated` : c'est ainsi que la conservation est verifiee.
   */
  infiltrate(dt) {
    const F = this.field;
    const M = this.moisture;
    if (!M) return;
    const rate = INFILTRATION_RATE * 35 * dt;
    if (rate <= 0) return;
    const hc = this.hc, sim = this.simMask;
    const invSub = 1 / (SUB * SUB);
    let total = 0;
    for (let z = 0; z < WM; z++) {
      const row = WN * z;
      const xa = this.rowMin[z], xb = this.rowMax[z];
      for (let x = xa; x <= xb; x++) {
        const c = row + x;
        // Un film sous le seuil boit aussi : c'est ainsi qu'il disparait.
        if (!sim[c] || hc[c] <= 0) continue;
        for (let sz = 0; sz < SUB; sz++) {
          const fzI = z * SUB + sz;
          for (let sx = 0; sx < SUB; sx++) {
            const fxI = x * SUB + sx;
            const fc = fxI + NX * fzI;
            const top = F.topY[fc];
            if (top < 0) continue;
            const i = fc + SLICE * top;
            const w = F.moisture[i] / 255;
            if (w >= 0.999) {
              // Colonne saturee : l'eau ne peut descendre que si la nappe est
              // plus bas que le fond (elle percole alors jusqu'a elle, a la
              // vitesse de Darcy), ou si la flaque elle-meme domine la nappe :
              // sa charge la pousse alors dans le sable, vers la mer. C'est
              // ainsi qu'une flaque piegee dans une enceinte se vide quand la
              // maree redescend, et qu'une lagune remplie par les vagues
              // derriere un tas verse sur la plage finit par disparaitre au
              // lieu de rester, sombre et plate, dix centimetres au-dessus
              // de la mer sur un sable qui ne peut plus rien boire.
              const head = this.bed[c] + hc[c] - this.tableC[c] - SEEPAGE_MARGIN;
              let drain;
              if (this.tableC[c] < this.bed[c] - SEEPAGE_MARGIN) drain = Math.min(hc[c], rate);
              else if (head > 0) drain = Math.min(hc[c], rate * clamp(head / 0.05, 0.3, 1));
              else continue;
              if (drain < 1e-7) continue;
              hc[c] -= drain * invSub;
              total += drain;
              continue;
            }
            const room = (1 - w) * POROSITY * VOXEL;
            const take = Math.min(hc[c], rate, room);
            if (take < 1e-7) continue;
            hc[c] -= take * invSub;
            total += take;
            const nw = clamp(w + take / (POROSITY * VOXEL), 0, 1);
            const nb = Math.round(nw * 255);
            if (nb !== F.moisture[i]) {
              F.moisture[i] = nb;
              F.touchVisual(fxI, top, fzI);
              if (this.granular) this.granular.push(i);
              M.touchColumn(fxI, fzI);
            }
          }
        }
      }
    }
    this.stats.infiltrated += total * AF;
  }

  // -------------------------------------------------------------------------
  // CHAMPS FINS
  // -------------------------------------------------------------------------

  /**
   * Reconstruit les champs fins depuis les cellules d'eau.
   *
   * La surface libre est interpolee bilineairement entre les centres des
   * cellules MOUILLEES (les seches ne pesent rien), puis coupee par le terrain
   * de chaque colonne : une colonne plus haute que la surface est seche, une
   * colonne plus basse que le fond de sa cellule montre l'eau qui la remplit.
   * Le front mouille/sec gagne ainsi la resolution du voxel, et un mur d'un
   * seul voxel sort de l'eau meme au milieu d'une cellule mouillee.
   *
   * Seules les colonnes de la boite des cellules mouillees (et de la boite
   * precedente, pour effacer) sont parcourues.
   */
  syncFine() {
    const surf = this.field.surfaceH;
    const hc = this.hc, bed = this.bed;
    const vxc = this.vxc, vzc = this.vzc, foamc = this.foamc, sedc = this.sedc;
    const brkc = this.brk;
    const h = this.h, vx = this.vx, vz = this.vz, foam = this.foam, sed = this.sed;
    const breaking = this.brkFine;

    // Boite courante : cellules mouillees (bornes de lignes) et mer imposee.
    let cxLo = WN, cxHi = -1, czLo = WM, czHi = -1;
    for (let z = 0; z < WM; z++) {
      if (this.rowMax[z] < this.rowMin[z]) continue;
      if (this.rowMin[z] < cxLo) cxLo = this.rowMin[z];
      if (this.rowMax[z] > cxHi) cxHi = this.rowMax[z];
      if (z < czLo) czLo = z;
      czHi = z;
    }
    const ob = this._openBox;
    if (this.openSeaEnabled && ob[1] >= ob[0]) {
      if (ob[0] < cxLo) cxLo = ob[0]; if (ob[1] > cxHi) cxHi = ob[1];
      if (ob[2] < czLo) czLo = ob[2]; if (ob[3] > czHi) czHi = ob[3];
    }
    const pb = this._prevFineBox;
    let fxLo = NX, fxHi = -1, fzLo = NZ, fzHi = -1;
    if (cxHi >= cxLo) {
      fxLo = Math.max(0, (cxLo - 1) * SUB); fxHi = Math.min(NX - 1, (cxHi + 2) * SUB - 1);
      fzLo = Math.max(0, (czLo - 1) * SUB); fzHi = Math.min(NZ - 1, (czHi + 2) * SUB - 1);
    }
    const uxLo = Math.min(fxLo, pb[0]), uxHi = Math.max(fxHi, pb[1]);
    const uzLo = Math.min(fzLo, pb[2]), uzHi = Math.max(fzHi, pb[3]);
    pb[0] = fxLo; pb[1] = fxHi; pb[2] = fzLo; pb[3] = fzHi;
    if (uxHi >= uxLo && uzHi >= uzLo) {
      const invSub = 1 / SUB;
      for (let z = uzLo; z <= uzHi; z++) {
        const v = (z + 0.5) * invSub - 0.5;
        let z0 = Math.floor(v);
        let tz = v - z0;
        if (z0 < 0) { z0 = 0; tz = 0; } else if (z0 >= WM - 1) { z0 = WM - 1; tz = 0; }
        const r0 = WN * z0, r1 = z0 + 1 < WM ? r0 + WN : r0;
        const row = NX * z;
        for (let x = uxLo; x <= uxHi; x++) {
          const u = (x + 0.5) * invSub - 0.5;
          let x0 = Math.floor(u);
          let tx = u - x0;
          if (x0 < 0) { x0 = 0; tx = 0; } else if (x0 >= WN - 1) { x0 = WN - 1; tx = 0; }
          const x1 = x0 + 1 < WN ? x0 + 1 : x0;
          const c00 = r0 + x0, c10 = r0 + x1, c01 = r1 + x0, c11 = r1 + x1;
          let sum = 0, wsum = 0, sv = 0, sw = 0, sf = 0, ss = 0, sk = 0;
          let w, hv;
          hv = hc[c00];
          if (hv > WATER_EPSILON) {
            w = (1 - tx) * (1 - tz); sum += w * (bed[c00] + hv); wsum += w;
            sv += w * vxc[c00]; sw += w * vzc[c00]; sf += w * foamc[c00]; ss += w * sedc[c00]; sk += w * brkc[c00];
          }
          hv = hc[c10];
          if (hv > WATER_EPSILON) {
            w = tx * (1 - tz); sum += w * (bed[c10] + hv); wsum += w;
            sv += w * vxc[c10]; sw += w * vzc[c10]; sf += w * foamc[c10]; ss += w * sedc[c10]; sk += w * brkc[c10];
          }
          hv = hc[c01];
          if (hv > WATER_EPSILON) {
            w = (1 - tx) * tz; sum += w * (bed[c01] + hv); wsum += w;
            sv += w * vxc[c01]; sw += w * vzc[c01]; sf += w * foamc[c01]; ss += w * sedc[c01]; sk += w * brkc[c01];
          }
          hv = hc[c11];
          if (hv > WATER_EPSILON) {
            w = tx * tz; sum += w * (bed[c11] + hv); wsum += w;
            sv += w * vxc[c11]; sw += w * vzc[c11]; sf += w * foamc[c11]; ss += w * sedc[c11]; sk += w * brkc[c11];
          }
          const c = row + x;
          if (wsum > 1e-6) {
            const inv = 1 / wsum;
            const d = sum * inv - surf[c];
            if (d > WATER_EPSILON) {
              h[c] = d;
              vx[c] = sv * inv; vz[c] = sw * inv;
              foam[c] = sf * inv; sed[c] = ss * inv; breaking[c] = sk * inv;
              continue;
            }
          }
          h[c] = 0; vx[c] = 0; vz[c] = 0; foam[c] = 0; sed[c] = 0; breaking[c] = 0;
        }
      }
    }
    // Laisse d'ecume : copie de la grille grossiere, seulement quand il y en a.
    const dryc = this.foamDryc, dry = this.foamDry;
    if (this._dryFoamActive) {
      for (let z = 0; z < NZ; z++) {
        const rc = WN * (z >> 1), row = NX * z;
        for (let x = 0; x < NX; x++) dry[row + x] = dryc[rc + (x >> 1)];
      }
    } else if (this._dryFoamWasActive) {
      dry.fill(0);
    }
    this._dryFoamWasActive = this._dryFoamActive;
  }

  // -------------------------------------------------------------------------
  // MORPHOLOGIE
  // -------------------------------------------------------------------------

  /**
   * Erosion / depot.
   * Capacite de transport C = Kc * sin(alpha) * |v| * lw, avec un seuil
   * d'arrachement fonction de la cohesion locale : c'est ce qui fait qu'une
   * douve creusee dans du sable bien tasse resiste au ressac, alors qu'un mur
   * de sable sec part en trente secondes.
   *
   * Le sediment vit par cellule d'eau (il voyage avec elle) ; l'arrachement et
   * le depot se font colonne fine par colonne fine, la ou le sable est.
   */
  erode(dt) {
    if (!this.erosionEnabled) return;
    const F = this.field;
    const h = this.h, vxc = this.vxc, vzc = this.vzc, sed = this.sedc;
    const hc = this.hc, surf = F.surfaceH;
    const brk = this.brk, wetPrev = this.wetPrev, sim = this.simMask;
    const invSub = 1 / (SUB * SUB);
    let total = 0;

    for (let z = 1; z < WM - 1; z++) {
      const row = WN * z;
      const xa = Math.max(1, this.scanA[z]);
      const xb = Math.min(WN - 2, this.scanB[z]);
      for (let x = xa; x <= xb; x++) {
        const c = row + x;
        if (!sim[c]) continue;
        if (hc[c] < WATER_EPSILON) {
          // La cellule est seche : tout son sediment se pose sur ses colonnes.
          if (sed[c] > 0) {
            for (let sz = 0; sz < SUB; sz++) for (let sx = 0; sx < SUB; sx++) {
              this.deposit(x * SUB + sx, z * SUB + sz, sed[c]);
            }
            sed[c] = 0;
          }
          for (let sz = 0; sz < SUB; sz++) for (let sx = 0; sx < SUB; sx++) {
            wetPrev[x * SUB + sx + NX * (z * SUB + sz)] = 0;
          }
          continue;
        }
        const ux = vxc[c], uz = vzc[c];
        const speed = Math.sqrt(ux * ux + uz * uz);
        if (speed < 0.02) continue;
        const onshore = (ux * SHORE_NX + uz * SHORE_NZ) < 0;
        const fw = onshore ? FW_UPRUSH : FW_BACKWASH;
        const tauDrag = 500 * fw * speed * speed;
        const brkC = brk[c];

        for (let sz = 0; sz < SUB; sz++) {
          const fzI = z * SUB + sz;
          for (let sx = 0; sx < SUB; sx++) {
            const fxI = x * SUB + sx;
            const fc = fxI + NX * fzI;
            const hw = h[fc];
            if (hw < WATER_EPSILON) { wetPrev[fc] = 0; continue; }
            // FRONT DU JET : la lame vient d'arriver ici. La contrainte y est
            // maximale (choc + turbulence + f_w double), et c'est la que se
            // creuse la micro-falaise (scarp) qui signe une plage en erosion.
            const wasDry = wetPrev[fc] === 0;
            wetPrev[fc] = 1;

            // Pente locale
            const dhx = (surf[fc + 1] - surf[fc - 1]) * 0.5;
            const dhz = (surf[fc + NX] - surf[fc - NX]) * 0.5;
            const grad = Math.sqrt(dhx * dhx + dhz * dhz) / VOXEL;
            const sinA = Math.max(EROSION_MIN_SLOPE, grad / Math.sqrt(1 + grad * grad));

            // DEUX REGIMES, DEUX FORMULES, et on prend le max :
            //  (a) trainee de fond, tau = 1/2 rho f_w |u| u : domine dans la
            //      lame mince et rapide du jet de rive ;
            //  (b) ecoulement graduellement varie, tau = rho g h S : domine
            //      dans le ruissellement, ou (a) est negligeable.
            const tauFlow = 1000 * GRAVITY * Math.min(hw, 0.25) * sinA * 0.35;
            // Extinction en eau profonde : la vitesse moyennee sur la
            // verticale n'est plus la vitesse au fond des que la colonne
            // depasse la couche limite de houle.
            const bedExp = 1 - smoothstep(TAU_DEPTH_FULL, TAU_DEPTH_ZERO, hw);
            if (bedExp <= 0.001) continue;
            // Un ressaut qui casse SUR le sable remue bien davantage qu'un
            // ecoulement lisse de meme vitesse.
            const tau = (tauDrag > tauFlow ? tauDrag : tauFlow) * bedExp *
              (1 + BREAK_TAU * brkC) * (wasDry ? SCARP_FRONT : 1);

            // Resistance : cohesion du sable de surface
            const top = F.topY[fc];
            if (top < 0) continue;
            const i = fc + SLICE * top;
            const w = F.moisture[i] / 255;
            const p = F.packing[i] / 255;
            const tauCrit = TAU_CRIT_DRY * (1 + COHESION_RESIST * cohesionFactor(w) * packFactor(p));

            // Capacite de transport, limitee par la profondeur d'eau
            const lw = smoothstep(0.0, 0.05, hw);
            const cap = EROSION_CAPACITY * sinA * speed * lw * 0.008;

            if (tau > tauCrit && cap > sed[c]) {
              // tau/tauCrit decide SI ca s'erode ; la capacite et le plafond
              // decident A QUELLE VITESSE. Borne a 1 : le multiplicateur
              // tempere pres du seuil et ne fait jamais qu'un ecoulement erode
              // plus vite que sa capacite.
              const excess = Math.min(1, tau / tauCrit - 1);
              // Plafond dur sur l'epaisseur arrachee en un pas : sans lui, une
              // seule vague peut creuser 20 cm et le rivage part en canyon.
              const amount = Math.min(
                (cap - sed[c]) * EROSION_DISSOLVE * this.wallAttack * dt * 6 * excess,
                0.0025 * Math.max(0.25, this.wallAttack) * dt * 60 * VOXEL
              );
              if (amount > 1e-6) {
                const got = this.dig(fxI, fzI, amount);
                sed[c] += got * invSub;
                total += got;
              }
            } else if (sed[c] > cap) {
              const amount = (sed[c] - cap) * EROSION_DEPOSIT * dt * 6;
              if (amount > 1e-6) {
                this.deposit(fxI, fzI, amount);
                sed[c] -= amount * invSub;
              }
            }
          }
        }
      }
    }
    this.stats.eroded += total;
  }

  /**
   * Retire `amount` metres de sable au sommet d'une colonne.
   * @returns {number} epaisseur reellement retiree
   */
  dig(x, z, amount) {
    const F = this.field;
    const c = x + NX * z;
    let remaining = Math.round((amount / VOXEL) * 255);
    if (remaining <= 0) return 0;
    let removed = 0;
    let y = F.topY[c];
    while (remaining > 0 && y >= FOUNDATION_LAYERS) {
      const i = c + SLICE * y;
      const d = F.density[i];
      if (d === 0) { y--; continue; }
      const take = Math.min(d, remaining);
      this.writeDensity(x, y, z, d - take);
      removed += take;
      remaining -= take;
      y--;
    }
    if (removed > 0 && this.granular) this.granular.wake(x, Math.max(0, y), z);
    return (removed / 255) * VOXEL;
  }

  /** Depose `amount` metres de sable au sommet d'une colonne. */
  deposit(x, z, amount) {
    const F = this.field;
    const c = x + NX * z;
    let remaining = Math.round((amount / VOXEL) * 255);
    if (remaining <= 0) return;
    let y = Math.max(0, F.topY[c]);
    while (remaining > 0 && y < NY) {
      const i = c + SLICE * y;
      const d = F.density[i];
      const room = 255 - d;
      if (room > 0) {
        const put = Math.min(room, remaining);
        this.writeDensity(x, y, z, d + put);
        // Le sable depose par le jet de rive est sature au moment ou il se
        // pose, mais il draine tres vite (la nappe est plus bas) : en une
        // seconde il repasse en regime capillaire et retrouve de la cohesion.
        // Le deposer a 255 donnait un theta_max de 15 degres : il COULAIT et
        // emportait le pied des murs avec lui.
        F.moisture[i] = DEPOSIT_MOISTURE;
        F.packing[i] = DEPOSIT_PACK;
        remaining -= put;
      }
      y++;
    }
    if (this.granular) this.granular.wake(x, Math.min(NY - 1, y), z);
  }

  /**
   * SAPEMENT DES PAROIS.
   *
   * Le jet de rive qui frappe un mur ne rabote pas son sommet : il creuse une
   * ENCOCHE a son pied, a l'altitude de la lame d'eau. Quand il rencontre une
   * paroi raide il ne glisse pas dessus, il STAGNE : la pression dynamique se
   * convertit en pression statique, l'ecoulement est devie vers le bas, et il
   * se forme au pied un tourbillon en fer a cheval — le meme que sous une pile
   * de pont — qui multiplie la contrainte locale par 2 a 5.
   *
   * Tout ce qui SUIT la creation de l'encoche est deja ecrit et teste dans
   * Granular : le porte-a-faux, l'accumulation de contrainte, les
   * micro-fissures, et l'effondrement en bloc. Il ne manquait qu'une chose :
   * creuser au bon endroit.
   */
  undermine(dt) {
    if (!this.erosionEnabled || this.wallAttack <= 0) return;
    const F = this.field;
    const h = this.h, vxc = this.vxc, vzc = this.vzc, sed = this.sedc;
    const hc = this.hc, surf = F.surfaceH, brk = this.brk, sim = this.simMask;
    const capStep = UNDERCUT_CAP * VOXEL * dt * 60;
    const invSub = 1 / (SUB * SUB);
    let total = 0;

    for (let z = 1; z < WM - 1; z++) {
      const row = WN * z;
      const xa = Math.max(1, this.scanA[z]);
      const xb = Math.min(WN - 2, this.scanB[z]);
      for (let x = xa; x <= xb; x++) {
        const c = row + x;
        if (!sim[c] || hc[c] < 0.004) continue;
        const ux = vxc[c], uz = vzc[c];
        const sp = Math.sqrt(ux * ux + uz * uz);
        if (sp < UNDERCUT_V) continue;
        const brkC = brk[c];

        for (let sz = 0; sz < SUB; sz++) {
          const fzI = z * SUB + sz;
          for (let sx = 0; sx < SUB; sx++) {
            const fxI = x * SUB + sx;
            const fc = fxI + NX * fzI;
            const hw = h[fc];
            if (hw < 0.004) continue;                    // pas de lame utile

            const eta = surf[fc] + hw;                   // surface libre
            const cel = Math.sqrt(GRAVITY * hw);
            const fr = Math.min(sp / (cel > 0.05 ? cel : 0.05), 1.8);
            const K = 1 + SCOUR_GAIN * fr;               // tourbillon de pied
            const tau = 500 * FW_UPRUSH * sp * sp * K * (1 + BREAK_TAU * brkC);

            // Voxel VISE : celui qui borde la surface libre, PAS le sommet.
            const yHit = clamp(Math.round((eta - ORIGIN_Y) / VOXEL - 0.5), 0, NY - 1);

            // --- lequel des quatre voisins est un MUR ? -----------------------
            for (let k = 0; k < 4; k++) {
              const dx = k === 0 ? 1 : k === 1 ? -1 : 0;
              const dz = k === 2 ? 1 : k === 3 ? -1 : 0;

              // Le jet doit etre dirige VERS la paroi...
              if (ux * dx + uz * dz < UNDERCUT_V) continue;

              // ... et il PROGRESSE dans l'encoche qu'il a deja ouverte. L'eau
              // est une nappe : elle ne peut pas occuper la cavite, donc sans
              // cette avancee explicite l'encoche plafonnait a UN voxel et
              // aucun mur ne tombait jamais.
              let atten = 1;
              for (let r = 1; r <= UNDERCUT_REACH; r++) {
                const nx = fxI + dx * r, nz = fzI + dz * r;
                if (nx < 1 || nz < 1 || nx >= NX - 1 || nz >= NZ - 1) break;
                const n = nx + NX * nz;
                // La paroi doit franchement depasser la surface libre.
                if (surf[n] - eta < UNDERCUT_RISE) break;
                const i = n + SLICE * yHit;
                if (F.density[i] === 0) { atten *= 0.75; continue; } // cavite ouverte : on avance

                // Resistance LOCALE du voxel vise : la chaine se boucle ici.
                const w = F.moisture[i] / 255;
                const pk = F.packing[i] / 255;
                const tauCrit = TAU_CRIT_DRY *
                  (1 + COHESION_RESIST * cohesionFactor(w) * packFactor(pk));
                if (tau * atten <= tauCrit) break;

                const excess = Math.min(3, (tau * atten) / tauCrit - 1);
                const amount = Math.min(UNDERCUT_RATE * excess * this.wallAttack * dt, capStep);
                if (amount >= 1e-6) {
                  const got = this.notch(nx, yHit, nz, amount);
                  if (got > 0) { sed[c] += got * invSub; total += got; }
                }
                break; // une bouchee par direction et par pas
              }
            }
          }
        }
      }
    }
    this.stats.eroded += total;
  }

  /**
   * Retire de la matiere sur une TRANCHE D'ALTITUDE — le voxel vise et celui
   * juste dessous — et non au sommet de la colonne comme dig().
   *
   * C'est cette fonction, et elle seule, qui produit le surplomb. On mord sur
   * DEUX voxels : une encoche d'un seul voxel (4 cm) se comble par eboulement
   * avant d'avoir pu creer un porte-a-faux visible.
   *
   * @returns {number} epaisseur reellement retiree (m)
   */
  notch(x, y, z, amount) {
    const F = this.field;
    let remaining = Math.round((amount / VOXEL) * 255);
    if (remaining <= 0) return 0;
    let removed = 0;
    const col = x + NX * z;
    for (let dy = 0; dy >= -1 && remaining > 0; dy--) {
      const yy = y + dy;
      if (yy < FOUNDATION_LAYERS) break;
      const i = col + SLICE * yy;
      const d = F.density[i];
      if (d === 0) continue;
      const take = Math.min(d, remaining);
      this.writeDensity(x, yy, z, d - take);
      removed += take;
      remaining -= take;
    }
    if (removed > 0) {
      // Reveille la COLONNE AU-DESSUS : c'est elle qui va se retrouver en
      // porte-a-faux, accumuler du stress et finir par tomber en bloc.
      if (this.granular) {
        this.granular.wake(x, Math.min(NY - 1, y + 1), z);
        this.granular.wake(x, Math.min(NY - 1, y + 2), z);
      }
      if (this.moisture) this.moisture.touchColumn(x, z);
    }
    return (removed / 255) * VOXEL;
  }

  /** Ecriture bas niveau (memes precautions que Granular.writeVoxel). */
  writeDensity(x, y, z, v) {
    const F = this.field;
    const i = x + NX * (z + NZ * y);
    const old = F.density[i];
    v = v < 0 ? 0 : v > 255 ? 255 : v | 0;
    if (y < FOUNDATION_LAYERS && v < old) return;
    if (v === old) return;
    F.density[i] = v;
    const ci = chidx((x / CHUNK) | 0, (y / CHUNK) | 0, (z / CHUNK) | 0);
    if (old > 0 && v === 0) F.chunkSolid[ci]--;
    else if (old === 0 && v > 0) F.chunkSolid[ci]++;
    if (old >= ISO && v < ISO) F.chunkFull[ci]--;
    else if (old < ISO && v >= ISO) F.chunkFull[ci]++;
    if (v === 0) {
      F.moisture[i] = 0; F.packing[i] = 0; F.material[i] = 0;
    } else if (old === 0) {
      F.material[i] = 1;
    }
    F.touch(x, y, z);
  }

  /** Heure de maree lisible : 0 = basse, 1 = haute. */
  get tidePhase() {
    return (this.tide + 1) * 0.5;
  }
}
