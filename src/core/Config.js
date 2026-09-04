/**
 * Sandcastle — configuration globale.
 *
 * Toutes les constantes physiques sont en unites SI (metres, secondes, kg)
 * sauf mention contraire. Les valeurs "de jeu" (multiplicateurs, budgets)
 * sont regroupees en bas.
 */

// ---------------------------------------------------------------------------
// GRILLE VOXEL
// ---------------------------------------------------------------------------

/** Taille d'un voxel en metres. 4 cm : assez fin pour des creneaux credibles. */
export const VOXEL = 0.04;

/**
 * Dimensions du domaine sculptable, en voxels.
 *
 * 320 x 320 (12,8 m de cote) : la mer occupe toute la face +Z du diorama et
 * la plage lui fait face sur toute sa largeur. Le nuage de billes ne couvre
 * que la bande active du rivage (voir SEA_STRIP_*), donc agrandir la mer ne
 * multiplie pas le cout de la physique de l'eau.
 */
/** Taille d'un chunk (cube). 32^3 = 32768 voxels par chunk. */
export const CHUNK = 32;

// --- TAILLE DE LA CARTE ------------------------------------------------------
// La taille est une CONSTANTE de la page : voxels, chunks, grille d'eau,
// textures et shaders en derivent a l'import. Elle se choisit dans le
// dialogue « Nouvelle plage » et s'applique en rechargeant la page, lue ici
// dans l'ordre : parametre d'URL `?map=LxP`, reglage conserve (`sc.map`),
// nom du worker (`map:LxP`, seul canal synchrone vers un worker de maillage),
// sinon 320 x 320. Multiples de CHUNK, entre 160 (6,4 m) et 512 (20,5 m).
export const MAP_SIZE_MIN = 160;
export const MAP_SIZE_MAX = 512;
export const MAP_SIZES = [160, 224, 320, 416, 512];
export const MAP_STORAGE_KEY = 'sc.map';

/** Arrondit au multiple de CHUNK dans les bornes ; 320 si absurde. */
export function normalizeMapSize(n) {
  n = Math.round(Number(n) / CHUNK) * CHUNK;
  if (!Number.isFinite(n)) return 320;
  return Math.min(MAP_SIZE_MAX, Math.max(MAP_SIZE_MIN, n));
}

/** Decode « LxP » ; null si le texte n'a pas cette forme. */
export function parseMapSpec(text) {
  const m = /^\s*(\d+)\s*x\s*(\d+)\s*$/i.exec(String(text ?? ''));
  return m ? { nx: normalizeMapSize(m[1]), nz: normalizeMapSize(m[2]) } : null;
}

function readMapSize() {
  let spec = null;
  try {
    if (typeof location !== 'undefined' && location.search) {
      const m = /[?&]map=(\d+x\d+)/i.exec(location.search);
      if (m) spec = parseMapSpec(m[1]);
    }
    // `window` : le fil principal d'un navigateur seulement (Node expose un
    // localStorage experimental qui avertit quand on le touche).
    if (!spec && typeof window !== 'undefined' && typeof localStorage !== 'undefined') {
      spec = parseMapSpec(localStorage.getItem(MAP_STORAGE_KEY));
    }
    if (!spec && typeof self !== 'undefined' && typeof self.name === 'string') {
      const m = /^map:(\d+x\d+)$/.exec(self.name);
      if (m) spec = parseMapSpec(m[1]);
    }
  } catch { /* stockage indisponible : taille par defaut */ }
  return spec || { nx: 320, nz: 320 };
}

/** Memorise la taille a appliquer au prochain chargement de la page. */
export function setPendingMapSize(nx, nz) {
  try { localStorage.setItem(MAP_STORAGE_KEY, `${normalizeMapSize(nx)}x${normalizeMapSize(nz)}`); } catch {}
}

const MAP = readMapSize();
export const NX = MAP.nx;
export const NY = 96;
export const NZ = MAP.nz;
export const CX = NX / CHUNK; // 10
export const CY = NY / CHUNK; // 3
export const CZ = NZ / CHUNK; // 10
export const CHUNK_COUNT = CX * CY * CZ; // 300

/** Dimensions du domaine en metres. */
export const WORLD_W = NX * VOXEL; // 12.8 m
export const WORLD_H = NY * VOXEL; // 3.84 m
export const WORLD_D = NZ * VOXEL; // 12.8 m

/** Le domaine est centre en XZ, et pose sur y=0. */
export const ORIGIN_X = -WORLD_W * 0.5;
export const ORIGIN_Y = 0;
export const ORIGIN_Z = -WORLD_D * 0.5;

/** Iso-valeur de la surface (densite 0..255). */
export const ISO = 128;

/**
 * Socle indestructible sous la plage. Quatre couches (16 cm) ferment le
 * domaine sans reduire sensiblement la profondeur de sculpture utile.
 */
export const FOUNDATION_LAYERS = 4;

// ---------------------------------------------------------------------------
// TERRAIN DE DEPART
// ---------------------------------------------------------------------------

/** Altitude de reference du sable sec (haut de plage), en metres. */
export const BEACH_HEIGHT = 1.6;

/** Altitude du niveau moyen de la mer. */
export const SEA_LEVEL = 1.05;

/**
 * Amplitude de la maree (demi-amplitude autour de SEA_LEVEL).
 *
 * Ce chiffre porte tout le propos du jeu. Avec une amplitude trop faible, la
 * mer ne monte jamais jusqu'a la zone constructible : la maree devient une
 * decoration et "l'ephemere" ne veut plus rien dire.
 *
 * A 0.46 m, la pleine mer atteint 1.51 m, plus une dizaine de centimetres de
 * ressac. La creation de plage (1.60 m) reste donc un refuge sur, tandis que
 * tout ce qui est bati sur la face de plage entre 1.1 et 1.5 m finira sous
 * l'eau. Batir bas, c'est batir vite et pres de l'eau — et l'accepter.
 */
export const TIDE_AMPLITUDE = 0.46;

/** Duree d'un cycle de maree complet, en secondes de jeu. */
export const TIDE_PERIOD = 12 * 60;

/** Duree d'une journee de jeu en secondes reelles. */
export const DAY_LENGTH = 20 * 60;

/**
 * Hauteur de la frange capillaire au-dessus de la nappe, en metres.
 * Sable moyen : 20-40 cm. C'est ce qui rend le sable humide "gratuit"
 * quand on creuse assez profond.
 */
export const CAPILLARY_FRINGE = 0.3;

/**
 * Denivele de la nappe phreatique entre le rivage et l'arriere-plage, en
 * metres.
 *
 * La nappe affleure au niveau de la mer sur la laisse, puis s'enfonce a mesure
 * qu'on remonte la plage — pas parce qu'elle descend dans l'absolu, mais parce
 * qu'une vraie plage est trois a quatre fois plus large que notre parcelle de
 * 10 m. Sans ce denivele, la nappe serait a 55 cm sous la berme et le moindre
 * trou se remplirait d'eau venue de nulle part.
 *
 * Avec 0.5 m, il faut creuser plus d'un metre au sommet de la plage pour
 * atteindre l'eau : l'eau libre vient de la MER, pas du sol.
 */
export const WATER_TABLE_DROP = 0.5;

/** Distance (m) sur laquelle la nappe s'enfonce, mesuree depuis le rivage. */
export const WATER_TABLE_SPAN = 4.0;

/**
 * Vitesse de suintement de la nappe vers un creux mis a nu (1/s).
 * Volontairement lente : voir l'eau monter petit a petit dans un trou creuse
 * pres de l'eau fait partie du plaisir.
 */
export const SEEPAGE_RATE = 0.32;
/**
 * Debit maximal du suintement (m/s de lame d'eau) : la vitesse de Darcy, la
 * meme que celle a laquelle l'eau ENTRE dans le sable. Sans ce plafond, la
 * relaxation vers la nappe remplissait une enceinte de murs posee au bord de
 * l'eau en trois secondes, ce qui se lisait comme de l'eau traversant les
 * murs. A 1,4 mm/s, un fond a 8 cm sous la nappe met une minute a se
 * remplir : on voit l'eau monter, et un mur protege vraiment pendant un temps.
 */
export const SEEPAGE_MAX = 1.4e-3;
/**
 * Un mur est ETANCHE a la nappe. La nappe n'alimente une cellule que si elle
 * y accede depuis la mer en ne traversant que du sable NATUREL : une cellule
 * dont le fond depasse le terrain d'origine de plus de cette hauteur (m) est
 * une construction, et elle coupe le chemin. Un trou creuse au bord de l'eau
 * se remplit toujours ; l'interieur d'une enceinte reste sec. C'est un choix
 * de jeu, pas de physique : le vrai sable suinte partout, mais un joueur qui
 * a bati un mur veut qu'il tienne.
 */
export const SEEP_BLOCK_RISE = 0.08;

/**
 * Saturation residuelle du sable hors de portee de la nappe.
 *
 * Ce n'est pas zero : loin de l'evaporation, du sable de plage garde toujours
 * quelques pourcents d'eau accrochee aux grains. C'est ce qui fait que creuser
 * donne du sable un peu meilleur PARTOUT, et pas seulement au bord de l'eau —
 * le geste fondateur du jeu doit marcher sur toute la plage.
 *
 * A 3,5 % on obtient un angle de tenue d'environ 70 degres : de quoi monter un
 * mur correct, mais pas de quoi se passer de l'arrosoir.
 */
export const RESIDUAL_SATURATION = 0.035;

// ---------------------------------------------------------------------------
// PHYSIQUE DU SABLE
// ---------------------------------------------------------------------------

/** Masse volumique apparente du sable sec non tasse (kg/m3). */
export const RHO_SAND_LOOSE = 1450;
/** Masse volumique apparente du sable tasse (kg/m3). */
export const RHO_SAND_PACKED = 1750;

/** Angle de frottement interne du sable (degres). */
export const PHI_FRICTION = 34;

/**
 * Angle de stabilite maximal selon la saturation w (0..1).
 * Points de controle mesures / rapportes par les sculpteurs :
 *   w=0.00 sable sec         -> 34 deg (angle de repos, frottement pur)
 *   w=0.02 juste humide      -> 55 deg
 *   w=0.06 humide            -> 78 deg
 *   w=0.12 optimal "pack"    -> 89 deg (murs quasi verticaux)
 *   w=0.20 tres mouille      -> 80 deg
 *   w=0.35 proche saturation -> 45 deg
 *   w=0.60 sature            -> 22 deg
 *   w=1.00 liquefie          -> 12 deg (le sable coule)
 */
export const REPOSE_CURVE = [
  [0.0, 34],
  [0.02, 55],
  [0.06, 78],
  [0.12, 89],
  [0.2, 80],
  [0.35, 45],
  [0.6, 22],
  [1.0, 12],
];

/** Saturation qui donne la meilleure tenue (le "sweet spot" des sculpteurs). */
export const W_OPTIMAL = 0.12;

/** Au-dela : le sable commence a se liquefier. */
export const W_SATURATED = 0.45;

/** Cohesion apparente maximale (Pa) a la saturation optimale, sable tasse. */
export const COHESION_MAX = 2400;

/** Conductivite hydraulique du sable (m/s) — percolation gravitaire. */
export const HYDRAULIC_K = 8e-5;

/** Coefficient de diffusion de l'humidite (m2/s). */
export const MOISTURE_DIFFUSION = 3.5e-6;

/** Evaporation de reference en plein soleil (m/s de lame d'eau). ~0.6 mm/h. */
export const EVAPORATION_BASE = 1.7e-7;

/** Porosite du sable (fraction de vide). */
export const POROSITY = 0.38;

// ---------------------------------------------------------------------------
// EAU DE SURFACE (modele "pipe" shallow water 2D)
// ---------------------------------------------------------------------------

/**
 * GRILLE D'EAU : deux voxels par cellule (8 cm).
 *
 * Le solveur en eaux peu profondes est borne par la condition CFL : son cout
 * vaut (cellules mouillees) x sqrt(g h) / dx. Passer de 4 a 8 cm divise ce
 * cout par huit (quatre fois moins de cellules, sous-pas deux fois plus
 * longs), et c'est ce qui rend une mer de 12,8 m de front abordable en
 * JavaScript. Le fond d'une cellule est le MAXIMUM de ses quatre colonnes :
 * un mur d'un seul voxel reste etanche, une tranchee doit faire au moins deux
 * voxels de large pour porter de l'eau — c'est le cas de tous les outils.
 * Le rendu, lui, retrouve la resolution des voxels : la surface interpolee
 * est coupee par le terrain fin, colonne par colonne (voir Water.syncFine).
 */
export const WATER_SUB = 2;
export const WATER_NX = NX / WATER_SUB;
export const WATER_NZ = NZ / WATER_SUB;
/** Taille d'une cellule d'eau, en metres. */
export const WATER_CELL = VOXEL * WATER_SUB;
/** Cadence du solveur d'eau (Hz). Les sous-pas CFL se font a l'interieur. */
export const WATER_SIM_HZ = 30;

export const GRAVITY = 9.81;
/** Section des "tuyaux" entre cellules d'eau. */
export const PIPE_AREA = WATER_CELL * WATER_CELL;
/** Longueur des tuyaux. */
export const PIPE_LENGTH = WATER_CELL;
/**
 * Amortissement du flux, applique par pas de simulation.
 *
 * PLUS UTILISE PAR LE SOLVEUR : voir WATER_DAMPING_NUM plus bas. A 0,985 par
 * pas de 1/60 s, soit 0,40 par seconde, il mangeait 60 % de la quantite de
 * mouvement chaque seconde — partout, y compris en pleine mer — et aucune vague
 * ne survivait a la traversee de la surf zone. Le frottement de fond physique
 * (FW_UPRUSH / FW_BACKWASH) a pris le relais. Conserve comme reference.
 */
export const WATER_DAMPING = 0.985;
/** Hauteur d'eau en dessous de laquelle on considere la cellule seche. */
export const WATER_EPSILON = 0.0015;

// --- Bande simulee et mer du large --------------------------------------
/**
 * Le solveur ne travaille que dans une BANDE le long du rivage : de la ligne
 * d'eau (et de tout ce que le jet de rive mouille au-dessus) jusqu'a un mur
 * virtuel parallele au rivage. Au-dela, la mer est IMPOSEE : niveau de maree
 * plus houle, sans aucun calcul de flux. La bande suit la maree et l'etat de
 * mer : sa profondeur limite vaut SEA_BAND_BREAK x la profondeur de
 * deferlement, bornee entre SEA_BAND_MIN_DEPTH et SEA_BAND_MAX_DEPTH, et sa
 * largeur ne depasse jamais SEA_BAND_MAX_WIDTH depuis la ligne d'eau (a
 * maree basse, le platier entier passerait sous la profondeur limite).
 *
 * Consequence : une mer d'huile coute presque rien, une tempete coute ce
 * qu'elle montre. Et le large peut etre aussi grand qu'on veut.
 */
export const SEA_BAND_BREAK = 1.6;
// Une vague ne peut etre injectee qu'a 60 % de la profondeur locale : pour
// qu'une tempete de 45 cm existe, le mur doit atteindre 80 cm, c'est-a-dire
// le fond du large a maree moyenne. A maree basse le platier entier fait 40 cm
// et la tempete se calme d'elle-meme, comme sur une vraie plage.
export const SEA_BAND_MIN_DEPTH = 0.22;
export const SEA_BAND_MAX_DEPTH = 0.80;
export const SEA_BAND_MAX_WIDTH = 5.0;

// --- Gouttes balistiques -------------------------------------------------
/**
 * Ce qui QUITTE la nappe devient une goutte : l'eau versee par un outil, la
 * lame qui tombe d'un rebord plus haut que CASCADE_DROP, les embruns d'un
 * rouleau. Une goutte ne porte que son volume et sa vitesse ; elle n'a pas de
 * pression, elle retombe et rend son volume exact a la nappe. 60 mL, c'est
 * une sphere de 2,4 cm : la taille rendue est la taille physique.
 */
export const DROPLET_VOLUME = 6.0e-5;
export const DROPLET_RADIUS = Math.cbrt(DROPLET_VOLUME * 3 / (4 * Math.PI));
export const DROPLET_MAX = 4000;
export const CASCADE_DROP = 0.10;

/**
 * Marge de submersion avant que la nappe ne suinte dans un creux (m).
 *
 * Sans elle, le moindre coup de pelle qui effleure la nappe fait apparaitre un
 * film d'eau : le joueur a l'impression que l'eau sort de nulle part. Il faut
 * VRAIMENT creuser sous la nappe pour trouver de l'eau.
 */
export const SEEPAGE_MARGIN = 0.025;

/** Taux d'infiltration de l'eau de surface dans le sable (m/s). */
export const INFILTRATION_RATE = 4.0e-5;

// --- Erosion hydraulique (Mei et al.) --------------------------------------
export const EROSION_CAPACITY = 0.9; // Kc
export const EROSION_DISSOLVE = 0.12; // Ks — arrachement progressif, jamais un rabot instantane
export const EROSION_DEPOSIT = 0.45; // Kd
export const EROSION_EVAPORATE = 0.012; // Ke
/** Pente minimale prise en compte (evite les capacites nulles a plat). */
export const EROSION_MIN_SLOPE = 0.06;

// ---------------------------------------------------------------------------
// VAGUES — hydrodynamique
// ---------------------------------------------------------------------------
//
// Tout ce bloc decoule d'une seule correction : la celerite du schema "pipe".
// Ecrit  f' = f*damp + dt*A*g*(H_i - H_j)/L, avec A = dx^2 et L = dx, le schema
// propage les ondes a sqrt(g*dx) = 0,63 m/s QUELLE QUE SOIT LA PROFONDEUR,
// alors que la physique exige sqrt(g*h) — soit 2,97 m/s dans 90 cm d'eau.
// Sans dependance a h, il n'y a pas de levee sur le haut-fond, donc pas de
// gonflement d'amplitude, donc aucun deferlement possible : c'est la raison
// pour laquelle le ressac sinusoidal ne donnait qu'une bouillie. On remplace
// A*g/L par g*h_face (voir Water.flux).

/**
 * Profondeur de face minimale (m). Sans ce plancher, la pointe du jet de rive
 * (h -> 0) a une celerite nulle et n'avance plus jamais. 6 mm => 0,24 m/s.
 */
export const HFACE_MIN = 0.006;
/**
 * Profondeur de face maximale (m). Cape la celerite a 2,32 m/s, ce qui economise
 * un sous-pas complet a pleine mer.
 *
 * Le document ne l'appliquait que dans la bande de generation ; on l'applique
 * PARTOUT, sans quoi le calcul du nombre de sous-pas (qui lit ce plafond) et le
 * solveur (qui ne l'appliquait pas au large) sont en desaccord et la CFL est
 * violee au large a pleine mer. Consequence visible : nulle. Toute la physique
 * qui compte — levee, deferlement, ressaut, jet de rive — se joue sous 55 cm ;
 * seule la houle du large voyage 25 % moins vite, et on le compense en calant
 * la longueur d'onde du generateur sur la meme celerite.
 */
export const HFACE_CAP = 0.85;
/** Marge de securite CFL : dt <= CFL_SAFE * dx / (sqrt(g h) + |u|). */
export const CFL_SAFE = 0.80;
/**
 * Nombre maximal de sous-pas par frame.
 *
 * Borne DURE. Si une frame prend 100 ms (chargement, GC), la CFL demanderait
 * une douzaine de sous-pas : le solveur mangerait la frame suivante et on
 * entrerait dans une spirale de la mort. Le schema pipe DIFFUSE quand on viole
 * la CFL (la mise a l'echelle des flux borne structurellement le transport), il
 * n'explose pas : mieux vaut deux frames un peu molles qu'un jeu qui se fige.
 */
export const SUBSTEP_MAX = 4;
/**
 * Amortissement NUMERIQUE seul (anti-oscillation). Le frottement physique
 * ci-dessous a pris le relais de l'ancien 0,985.
 */
export const WATER_DAMPING_NUM = 0.999;
/**
 * Plafond de Froude sur la vitesse. Remplace le "if (sp > 4)" en dur, qui est
 * absurde des deux cotes : dans 5 cm d'eau, 4 m/s c'est Fr = 5,7 (impossible,
 * et l'erosion explose) ; dans 90 cm c'est Fr = 1,35, parfaitement legitime.
 */
export const FR_MAX = 1.6;
/**
 * Profondeur DE REFERENCE du plafond de Froude (m), plancher applique a h.
 *
 * Correction indispensable au document, trouvee a la mesure. Applique
 * naivement a la profondeur locale, le plafond de Froude etrangle le jet de
 * rive : la pointe de la lame est mince (5 mm au bout), donc plafonnee a
 * 1,6 sqrt(g x 0,005) = 0,35 m/s, alors que la table en attend 2,2 m/s. Le
 * run-up mesure tombait a un QUART de la valeur de Stockdon.
 *
 * La langue de jet de rive n'est pas une onde de gravite, c'est une nappe
 * BALISTIQUE : son nombre de Froude local atteint couramment 3 a 8 pres de la
 * pointe, c'est mesure en laboratoire. Son echelle de vitesse est celle du
 * RESSAUT qui l'a lancee, pas celle du film residuel. On plafonne donc sur
 * max(h, h_ressaut), avec h_ressaut = max(0,10 ; Hs_eff) :
 *   Clapot   Hs = 4 cm  -> 1,58 m/s  (table : 1,17)
 *   Houle    Hs = 18 cm -> 2,13 m/s  (table : 2,17)
 *   Tempete  Hs = 45 cm -> 3,36 m/s  (table : 3,21)
 * L'accord avec la table de Stockdon est fortuit mais il n'est pas un hasard :
 * les deux disent la meme chose, u0 ~ sqrt(g Hs).
 */
export const FR_DEPTH_MIN = 0.10;
/** Plafond absolu de vitesse (m/s). Dernier garde-fou, ne mord jamais en jeu. */
export const U_ABS_MAX = 4.0;

// --- frottement de fond ------------------------------------------------------
/** Coefficient de frottement a la MONTEE du jet (turbulent, charge de bulles). */
export const FW_UPRUSH = 0.050;
/**
 * ... et a la descente. Le rapport 2:1 est mesure sur le terrain, et c'est LUI
 * qui produit le transport net vers la terre, donc la berme, donc une plage qui
 * se maintient au lieu de se raboter jusqu'a la mer. Ne jamais symetriser.
 */
export const FW_BACKWASH = 0.025;
/**
 * Epaisseur de reference du frottement de fond : plancher absolu (m) et
 * fraction de Hs.
 *
 * C'est la correction la plus importante trouvee a la mesure, et elle est dans
 * le document — juste pas a cet endroit-la. La deceleration de frottement vaut
 * (f_w/2)|u|/h : elle DIVERGE quand la lame s'amincit. Le solveur laisse
 * derriere le front un film residuel de quelques millimetres ; l'appliquer
 * dessus donne 12 s^-1, la langue de jet de rive est annihilee en un dixieme
 * de seconde, et — symptome caracteristique — le run-up SATURE : il vaut 5 cm
 * du Clapot a la Tempete, quelle que soit l'energie injectee.
 *
 * Or une langue de jet de rive n'est pas un film : c'est une lame dont
 * l'epaisseur au front vaut environ 0,30 Hs (§5.6 du document : 1,2 cm pour le
 * Clapot, 13,5 cm pour la Tempete). En calant le plancher sur cette echelle, la
 * solution balistique avec frottement
 *     x_arret = (h/f) ln(1 + f u0^2 / (2 g beta h))
 * redonne 0,34 m pour le Clapot et 2,46 m pour la Tempete — la table du
 * document, aux deux bouts de la gamme, sans autre reglage.
 */
export const FRIC_DEPTH_MIN = 0.02;
export const FRIC_DEPTH_HS = 0.30;

// --- deferlement -------------------------------------------------------------
/** Declenchement : d(eta)/dt >= BREAK_ON * sqrt(gh) (Kennedy et al. 2000). */
export const BREAK_ON = 0.65;
/** Extinction. L'hysteresis 0,65 -> 0,15 evite le clignotement du rouleau. */
export const BREAK_OFF = 0.15;
/**
 * Dissipation de base au deferlement (1/s).
 *
 * Le document annonce 3,0 s^-1 en calculant "une vague qui traverse 1,2 m de
 * surf zone en 0,8 s conserve 1/(1+3x0,8) = 29 % de sa quantite de mouvement".
 * C'est une erreur d'arithmetique : le facteur 1/(1+gain b dt) est applique a
 * CHAQUE pas, il se compose donc en exp(-gain b T) = exp(-2,4) = 9 %, pas 29 %.
 * A 3,0 (et 5,5 avec l'agitation) le ressaut arrivait au rivage a 0,7 m/s au
 * lieu de 2,2, et le jet de rive montait quatre fois trop bas.
 *
 * A 1,2 s^-1, exp(-1,2 x 0,8) = 38 % de quantite de mouvement conservee sur la
 * traversee, soit 85 % de l'energie dissipee : c'est la fourchette mesuree sur
 * une vraie surf zone (70 a 90 %), et cette fois-ci c'est le bon calcul.
 */
export const BREAK_GAIN_BASE = 1.2;
/** Supplement de dissipation apporte par l'agitation (1/s). Une mer croisee
 *  est plus turbulente, donc plus dissipative. */
export const BREAK_GAIN_AGIT = 1.0;
/**
 * Epaisseur du rouleau (viscosite de rouleau adimensionnee).
 *
 * Le document propose 0,6. Mesure faite : a 0,6 la diffusion ecrete la crete du
 * ressaut avant qu'elle n'atteigne le rivage et le run-up est divise par deux
 * (6,0 cm au lieu de 11,0). A 0,25 le front garde encore deux a trois cellules
 * d'epaisseur — assez pour ne pas etre un mur de 4 cm — sans manger la crete.
 */
export const ROLLER_NU = 0.12;
/**
 * Profondeurs entre lesquelles le ROULEAU s'eteint (m).
 *
 * Le critere de Kennedy est concu pour la surf zone, pas pour la ZONE DE JET DE
 * RIVE, ou le front de la nappe est par construction une discontinuite : il s'y
 * declenche donc en permanence sur la pointe de la lame, et le puits de
 * quantite de mouvement qui en decoule detruit le run-up. Tous les modeles de
 * type Boussinesq coupent le deferlement au passage en zone de swash ; c'est ce
 * que fait cette porte. Sous 2 cm, plus de rouleau : seul le frottement de fond
 * freine la lame, et c'est bien lui le mecanisme physique a cette epaisseur.
 */
export const BREAK_DEPTH_MIN = 0.04;
export const BREAK_DEPTH_FULL = 0.12;
/** Surcote de contrainte quand un ressaut casse SUR le sable. */
export const BREAK_TAU = 0.85;
/**
 * Profondeurs entre lesquelles la contrainte au fond s'eteint (m).
 *
 * Un solveur en eaux peu profondes ne connait que la vitesse MOYENNEE SUR LA
 * VERTICALE. Dans une lame de 5 cm c'est aussi la vitesse au fond ; dans 60 cm
 * ce n'est plus du tout la meme chose, car la contrainte reelle y est portee
 * par le mouvement ORBITAL, qui decroit en 1/cosh(kh). Appliquer telle quelle
 * la formule de trainee en eau profonde faisait creuser une tranchee de 80 cm
 * dans l'avant-plage en deux minutes, la ou une vraie plage est a l'equilibre.
 *
 * On eteint donc la contrainte au-dela de la profondeur de la couche limite de
 * houle. Consequence de jeu : toute la morphologie se concentre la ou le joueur
 * regarde — surf zone, estran, pied des murs — et l'avant-plage reste stable.
 */
export const TAU_DEPTH_FULL = 0.25;
export const TAU_DEPTH_ZERO = 0.60;

// --- ecume -------------------------------------------------------------------
export const FOAM_GAIN = 2.4;      // 1/s : un rouleau franc blanchit en 0,4 s
/**
 * Duree de vie de l'ecume portee par l'eau (s). Plus COURTE que la periode de
 * la houle : la traine d'une vague doit s'effacer avant la suivante, sinon la
 * surf zone entiere devient un tapis blanc permanent au lieu d'une bande qui
 * avance avec chaque crete.
 */
export const FOAM_TAU_WET = 1.3;
export const FOAM_TAU_DRY = 9.0;   // s : laisse d'ecume sur le sable
export const FOAM_DEPOSIT = 0.75;  // fraction deposee quand la cellule s'asseche

// ---------------------------------------------------------------------------
// VAGUES — sable
// ---------------------------------------------------------------------------

/** Contrainte critique d'arrachement du sable propre (Pa, Shields, 0,3 mm). */
export const TAU_CRIT_DRY = 0.168;
/**
 * Multiplicateur de cohesion dans le seuil d'arrachement.
 *
 * ETAIT 30. Avec 30, le meilleur mur du jeu (sable parfait en pound-up) resiste
 * a 5,1 Pa alors que le plus modeste clapot en delivre 34 : tout partait, quelle
 * que soit la qualite de la construction, et le geste de damer — qui est LE
 * geste du chateau de sable — ne servait a rien.
 *
 * Avec 600, la table de resistance recoupe la table des six etats de mer :
 *   vrac 22 Pa | tasse 45 Pa | bien dame 70 Pa | pound-up 99 Pa
 * face a  Clapot 34 | Petites vagues 64 | Houle 118 | Grosse houle 181 Pa.
 * Chaque cran de damage achete un cran de houle, et au-dela de "Petites vagues"
 * la seule defense est hydraulique (douve, brise-lames), pas structurelle.
 */
export const COHESION_RESIST = 900;

/** Hauteur de paroi emergee au-dessus de la lame pour qu'on parle de "mur" (m). */
export const UNDERCUT_RISE = 0.06;
/** Vitesse minimale du jet pour saper (m/s). */
export const UNDERCUT_V = 0.35;
/**
 * Amplification par le tourbillon de pied (meme mecanique que l'affouillement
 * autour d'une pile de pont) : K = 1 + SCOUR_GAIN * min(Fr, 1.8), soit 1 a 5,0.
 */
export const SCOUR_GAIN = 1.25;
/**
 * Vitesse de creusement de l'encoche (m/s, a exces de contrainte unitaire).
 *
 * Calibrage par la mesure, pas par l'intuition : sous "Houle", le jet ne remplit
 * les QUATRE conditions du sapement (lame > 4 mm, jet > 0,35 m/s dirige vers la
 * paroi, paroi emergee, tau > tau_crit) que ~18 fois par vague sur tout un pan
 * de mur de 1,6 m. A 0,009 m/s ca ne retirait que 8 mm d'encoche par vague :
 * un mur dame restait STRICTEMENT intact apres 35 vagues, alors que le
 * document (§7 de RECHERCHE-VAGUES) vise une breche en ~8. Le seuil tau_crit
 * porte deja toute la discrimination (le Clapot a 34 Pa ne peut RIEN contre
 * un mur dame a 80 Pa, quel que soit ce debit) : ce coefficient ne regle que
 * la vitesse du supplice, pas qui le subit.
 */
export const UNDERCUT_RATE = 0.16;
/**
 * Profondeur maximale de l'encoche, en colonnes de voxels.
 *
 * C'est la piece qui manquait a toute la chaine du sapement. L'eau est un
 * champ 2D en colonnes : elle ne peut jamais OCCUPER la cavite qu'elle vient
 * de creuser dans une paroi (la surface de la colonne du mur reste au sommet
 * du mur). Sans progression explicite, l'encoche s'arretait donc a UN voxel de
 * profondeur — et checkSupport() declare stable tout surplomb de moins de
 * maxOverhang, soit 3 a 4 voxels pour du sable dame : le mur etait
 * structurellement invulnerable, quel que soit le debit d'attaque. Le jet
 * poursuit donc son travail A TRAVERS la cavite ouverte (le tourbillon en fer
 * a cheval travaille DANS l'encoche, c'est sa physique), attenue de 25 % par
 * colonne franchie, jusqu'a ce que le porte-a-faux depasse ce que la cohesion
 * sait porter — et la, Granular fait tomber le pan d'un bloc, comme prevu.
 * 5 colonnes = 20 cm : l'epaisseur d'un mur de joueur typique.
 */
export const UNDERCUT_REACH = 4;
/** Plafond dur par pas, en fraction de VOXEL : un mur ne disparait jamais en
 *  une frame. */
export const UNDERCUT_CAP = 0.08;
/** Amplification de la contrainte sur le FRONT du jet (naissance des scarps). */
export const SCARP_FRONT = 1.35;

/**
 * Etat du sable fraichement depose par l'eau.
 *
 * ETAIT 255 / 40. A 255, cohesionFactor(1,0) = 0 donc tau_crit = 0,17 Pa : le
 * sable depose etait immediatement reerodable par n'importe quoi, aucune berme
 * ne pouvait se former, et — plus grave — le sable pose au pied d'un mur avait
 * un theta_max de 15 degres et coulait, en emportant le mur avec lui. Le sable
 * du jet de rive EST sature quand il se pose, mais il draine en une seconde
 * (la nappe est plus bas) : 205 (w = 0,80) draine ensuite vers 0,15.
 */
export const DEPOSIT_MOISTURE = 205;
/** Le jet tasse un peu le sable en le posant. */
export const DEPOSIT_PACK = 55;

// ---------------------------------------------------------------------------
// VAGUES — generation
// ---------------------------------------------------------------------------

/** Profondeur minimale d'injection (m). Relevee dynamiquement a 2*Hs. */
export const H_GEN = 0.18;
/** Largeur de la zone de relaxation (cellules d'eau de 8 cm, soit 0,8 m).
 *  En dessous de ~0,6 m, la reflexion residuelle devient audible (mode de
 *  baignoire). */
export const W_RELAX = 7;
/** Exposant du profil de relaxation alpha. */
export const RELAX_P = 3.5;
/** Composantes spectrales. Trois s'entendent comme un battement mecanique ;
 *  au-dela de six le gain est nul. */
export const N_COMP = 5;
/** Amplitude de l'onde longue liee (infragravitaire), en fraction de Hs. */
export const C_IG = 0.22;
/** k_T : ecretage de la houle a pleine mer. Sans lui, "Tempete" a pleine mer
 *  noie le domaine entier, arriere-plage comprise. */
export const TIDE_GATE = 0.25;

// ---------------------------------------------------------------------------
// BUDGETS DE SIMULATION (par frame)
// ---------------------------------------------------------------------------

/**
 * Nombre max de voxels traites par la passe d'avalanche par frame.
 * L'ensemble actif etant filtre aux seuls voxels de surface, 60 000 suffit
 * largement meme juste apres un gros coup de pelle.
 */
export const BUDGET_GRANULAR = 60000;
/** Nombre max de colonnes traitees par la passe d'humidite par frame. */
export const BUDGET_MOISTURE = 45000;
/** Nombre max de chunks remailles par frame. */
export const BUDGET_REMESH = 6;
/** Nombre de workers de maillage. */
export const MESH_WORKERS = Math.max(
  2,
  Math.min(6, (globalThis.navigator?.hardwareConcurrency || 4) - 1)
);

/** Pas de temps fixe de la simulation (s). */
export const SIM_DT = 1 / 60;
/**
 * Nombre max de sous-pas de simulation rattrapes en une frame.
 * Deux et pas trois : sur une machine qui rame deja, rattraper trois pas de
 * simulation aggrave la chute d'images au lieu de la corriger. Mieux vaut
 * laisser la physique tourner un peu au ralenti — personne ne le voit.
 */
export const SIM_MAX_STEPS = 2;

// ---------------------------------------------------------------------------
// MATERIAUX
// ---------------------------------------------------------------------------

export const MAT_AIR = 0;
export const MAT_SAND = 1;
export const MAT_ROCK = 2; // rochers du decor, non sculptables
export const MAT_SHELL = 3;

// ---------------------------------------------------------------------------
// HELPERS
// ---------------------------------------------------------------------------

/** Index lineaire d'un voxel. Layout : x contigu, puis z, puis y. */
export function vidx(x, y, z) {
  return x + NX * (z + NZ * y);
}

/** Index d'une colonne (grille 2D XZ). */
export function cidx(x, z) {
  return x + NX * z;
}

/** Index d'un chunk. */
export function chidx(cx, cy, cz) {
  return cx + CX * (cz + CZ * cy);
}

export function inBounds(x, y, z) {
  return x >= 0 && y >= 0 && z >= 0 && x < NX && y < NY && z < NZ;
}

/** Monde -> voxel (flottant). */
export function worldToVoxel(wx, wy, wz, out = { x: 0, y: 0, z: 0 }) {
  out.x = (wx - ORIGIN_X) / VOXEL;
  out.y = (wy - ORIGIN_Y) / VOXEL;
  out.z = (wz - ORIGIN_Z) / VOXEL;
  return out;
}

/** Voxel -> monde (coin bas du voxel). */
export function voxelToWorld(vx, vy, vz, out = { x: 0, y: 0, z: 0 }) {
  out.x = ORIGIN_X + vx * VOXEL;
  out.y = ORIGIN_Y + vy * VOXEL;
  out.z = ORIGIN_Z + vz * VOXEL;
  return out;
}

export function clamp(v, a, b) {
  return v < a ? a : v > b ? b : v;
}

export function lerp(a, b, t) {
  return a + (b - a) * t;
}

export function smoothstep(e0, e1, x) {
  const t = clamp((x - e0) / (e1 - e0), 0, 1);
  return t * t * (3 - 2 * t);
}
