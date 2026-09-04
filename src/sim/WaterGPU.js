/**
 * Solveur de la nappe sur le GPU, et champs fins pour le rendu.
 *
 * Le solveur CPU de Water.js reste la REFERENCE : c'est lui que les tests
 * Node executent et prouvent. Ce module en est une transcription passe par
 * passe en GLSL (WebGL2, textures flottantes), et il se VERIFIE lui-meme :
 * pendant les premiers pas, les deux solveurs tournent depuis le meme etat
 * et le resultat GPU est compare au resultat CPU. Un ecart, une valeur
 * absurde, une lecture impossible : le GPU se retire et le CPU continue,
 * sans que le joueur voie autre chose qu'une ligne dans le panneau F3.
 *
 * DEUX ETAGES.
 *
 *  1. LA BOUCLE DE SOUS-PAS CFL (flux, echelle, integration, deferlement,
 *     echange du rouleau + generation) sur la grille de 160 x 160. Cinq
 *     rendus par sous-pas. Une fois par pas, une passe d'empaquetage ecrit
 *     (h, vx, vz, b) que le CPU relit de facon ASYNCHRONE (tampon de lecture
 *     + fence : jamais de readPixels bloquant, qui attendrait la fin du rendu
 *     de l'image precedente). La copie CPU a un pas de retard, invisible a
 *     30 Hz ; les modifications CPU (suintement, seau, sable verse, mer
 *     imposee) repartent vers le GPU sous forme de deltas.
 *
 *  2. LES CHAMPS FINS DU RENDU sur la grille de 320 x 320 : ce que faisaient
 *     Water.syncFine (1,2 ms par pas) puis WaterRenderer.update (dilatation
 *     du niveau, lissage temporel, 1,6 Mo televerses par mise a jour). Le
 *     rendu lit directement les textures produites ici. Le CPU ne
 *     reconstruit plus ses champs fins que pour l'erosion, un pas sur trois.
 *     Ces passes tournent A CHAQUE IMAGE et interpolent entre les deux
 *     derniers etats du solveur : a 30 Hz de solveur pour 60 a 90 images par
 *     seconde, on voyait la nappe avancer par a-coups. Avec l'interpolation,
 *     la surface glisse entre deux pas (un pas de latence, 33 ms, invisible)
 *     et le front mouille/sec avance continument.
 *
 * PLOMBERIE. WebGL2 brut, pas three.js : un rendu three coute 50 a 100 us de
 * gestion d'etat, et il y en a jusqu'a vingt-cinq par pas. Un tirage brut en
 * coute dix. On rend la main a three par `renderer.resetState()`, et le
 * rendu voit nos textures par `THREE.ExternalTexture`.
 *
 * Tout ce qui est couple au sable et aux gouttes (suintement, infiltration,
 * erosion, sape, embruns, advection de l'ecume) reste sur le CPU : ces
 * etapes lisent et ecrivent les voxels, elles n'ont rien a faire ici.
 *
 * ECARTS ASSUMES avec le CPU (tous verifies sous le seuil de validation) :
 *  - le CPU calcule ses flux en balayage (le flux de la face ouest d'une
 *    cellule est deja celui du pas courant quand elle advecte sa quantite
 *    de mouvement) ; le GPU lit partout l'etat du debut de passe ;
 *  - l'echange du rouleau est symetrique par construction (chaque paire de
 *    cellules calcule le meme transfert), la ou le CPU l'applique deux fois
 *    en sequence ; il reste exactement conservatif ;
 *  - flottants 32 bits pour h et les flux (64 sur CPU).
 */

import * as THREE from 'three';
import {
  NX, NZ, WATER_NX as WN, WATER_NZ as WM, WATER_CELL as WC, WATER_SUB as SUB, WATER_SIM_HZ,
  GRAVITY, WATER_EPSILON, HFACE_MIN, HFACE_CAP, FR_MAX, FR_DEPTH_MIN, U_ABS_MAX,
  FW_UPRUSH, FW_BACKWASH, FRIC_DEPTH_MIN, FRIC_DEPTH_HS, WATER_DAMPING_NUM,
  BREAK_ON, BREAK_OFF, BREAK_GAIN_BASE, BREAK_GAIN_AGIT, ROLLER_NU,
  BREAK_DEPTH_MIN, BREAK_DEPTH_FULL, N_COMP,
} from '../core/Config.js';
import { SHORE_NX, SHORE_NZ } from '../world/BeachGenerator.js';
import { ADV_MIN_H } from './Water.js';

const WCOLS = WN * WM;
const FCOLS = NX * NZ;
/** Pas valides consecutivement avant de confier la nappe au GPU. */
const VALIDATE_N = 3;
/** Ecart tolere entre les deux solveurs, apres un pas complet. */
const TOL_MAX = 0.015;   // m, ecart maximal sur h
const TOL_RMS = 0.0025;  // m, ecart quadratique moyen sur h

/** Unite de texture fixe par echantillonneur : une fois pour tous les programmes. */
const UNITS = {
  tS: 0, tF: 1, tV: 2, tB: 3, tG: 4, tAux: 5, tSurf: 6,
  tFineA: 7, tFineB: 8, tLvl: 9, tPrevField: 10, tPrevFlow: 11,
  tPk0: 12, tPk1: 13,
};

// ---------------------------------------------------------------------------
// GLSL
// ---------------------------------------------------------------------------

/** Un litteral flottant GLSL sur pour n'importe quel nombre JS. */
function fl(v) {
  let s = String(v);
  if (!/[.e]/.test(s)) s += '.0';
  return s;
}

/** En-tete commun : constantes du solveur, echantillonneurs, uniformes. */
export function glslHead() {
  const consts = {
    WN, WM, NX, NZ, SUB, N_COMP,
    WC: fl(WC), L: fl(WC), A: fl(WC * WC),
    GRAVITY: fl(GRAVITY), WATER_EPSILON: fl(WATER_EPSILON),
    HFACE_MIN: fl(HFACE_MIN), HFACE_CAP: fl(HFACE_CAP), ADV_MIN_H: fl(ADV_MIN_H),
    FR_MAX: fl(FR_MAX), FR_DEPTH_MIN: fl(FR_DEPTH_MIN), U_ABS_MAX: fl(U_ABS_MAX),
    FW_UPRUSH: fl(FW_UPRUSH), FW_BACKWASH: fl(FW_BACKWASH),
    FRIC_DEPTH_MIN: fl(FRIC_DEPTH_MIN), FRIC_DEPTH_HS: fl(FRIC_DEPTH_HS),
    WATER_DAMPING_NUM: fl(WATER_DAMPING_NUM),
    BREAK_ON: fl(BREAK_ON), BREAK_OFF: fl(BREAK_OFF),
    BREAK_GAIN_BASE: fl(BREAK_GAIN_BASE), BREAK_GAIN_AGIT: fl(BREAK_GAIN_AGIT),
    ROLLER_NU: fl(ROLLER_NU), BREAK_DEPTH_MIN: fl(BREAK_DEPTH_MIN), BREAK_DEPTH_FULL: fl(BREAK_DEPTH_FULL),
    SHORE_NX: fl(SHORE_NX), SHORE_NZ: fl(SHORE_NZ),
  };
  const defines = Object.entries(consts).map(([k, v]) => `#define ${k} ${v}`).join('\n');
  return `#version 300 es
precision highp float;
precision highp int;
precision highp sampler2D;
${defines}
uniform sampler2D tS;
uniform sampler2D tF;
uniform sampler2D tV;
uniform sampler2D tB;
uniform sampler2D tG;
uniform sampler2D tAux;
uniform sampler2D tSurf;
uniform sampler2D tFineA;
uniform sampler2D tFineB;
uniform sampler2D tLvl;
uniform sampler2D tPrevField;
uniform sampler2D tPrevFlow;
uniform sampler2D tPk0;
uniform sampler2D tPk1;
uniform float uLerp;
uniform float uDt;
uniform float uSea;
uniform float uHFric;
uniform float uHmFr;
uniform float uSpMaxFloor;
uniform float uGain;
uniform float uKFr;
uniform float uTime;
uniform float uGroupAmp;
uniform float uEtaIg;
uniform float uCRef;
uniform float uWavesOn;
uniform float uKL;
uniform float uKS;
uniform float uPrime;
uniform float uInitLevel;
uniform int uFromFine;
uniform float uA[N_COMP];
uniform float uKx[N_COMP];
uniform float uKy[N_COMP];
uniform float uW[N_COMP];
uniform float uPh[N_COMP];

vec4 S(ivec2 p) { return texelFetch(tS, p, 0); }
vec4 F(ivec2 p) { return texelFetch(tF, p, 0); }
vec4 V(ivec2 p) { return texelFetch(tV, p, 0); }
vec4 B(ivec2 p) { return texelFetch(tB, p, 0); }
bool inDom(ivec2 p) { return p.x >= 0 && p.y >= 0 && p.x < WN && p.y < WM; }
float safeF(float v) { return (isnan(v) || isinf(v)) ? 0.0 : v; }
`;
}

/** Sommet : un triangle plein ecran tire par gl_VertexID, sans attribut. */
const VERT = `#version 300 es
void main() {
  vec2 p = vec2(gl_VertexID == 1 ? 3.0 : -1.0, gl_VertexID == 2 ? 3.0 : -1.0);
  gl_Position = vec4(p, 0.0, 1.0);
}
`;

/**
 * FLUX. Transcription de Water.flux : frottement de fond semi-implicite,
 * faces +X et +Z (profondeur de face min/max, advection amont de la quantite
 * de mouvement, exutoire au bord), faces -X / -Z du bord.
 */
const FRAG_FLUX = /* glsl */ `
layout(location = 0) out vec4 oF;
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  int x = p.x, z = p.y;
  vec4 s = S(p), f = F(p), b = B(p), v = V(p);
  if (b.g < 0.5) { oF = f; return; }
  float hcv = s.r, bc = b.r, H = bc + hcv;
  float kBase = uDt * GRAVITY;
  float damp = pow(WATER_DAMPING_NUM, uDt * 60.0);
  float advK = uDt / WC;
  float fric = 1.0;
  if (hcv >= WATER_EPSILON) {
    float sp = length(v.xy);
    bool onshore = (v.x * SHORE_NX + v.y * SHORE_NZ) < 0.0;
    float fw = onshore ? FW_UPRUSH : FW_BACKWASH;
    fric = 1.0 / (1.0 + 0.5 * uDt * fw * sp / max(hcv, uHFric));
  }

  // --- face vers +X --------------------------------------------------------
  float fxo = f.r;
  {
    bool inside = x + 1 < WN;
    ivec2 pn = ivec2(x + 1, z);
    float hn = inside ? S(pn).r : 0.0;
    if (inside && hcv < WATER_EPSILON && hn < WATER_EPSILON) {
      fxo = 0.0;
    } else {
      float bn = inside ? B(pn).r : bc;
      float Hn = inside ? bn + hn : uSea;
      float crest = max(bc, bn);
      float overtop = max(H, Hn) - crest;
      if (inside && overtop <= WATER_EPSILON) {
        fxo = 0.0;
      } else {
        float hF = min(H, Hn) - crest;
        if (hF < HFACE_MIN) hF = min(HFACE_MIN, max(overtop, WATER_EPSILON));
        else if (hF > HFACE_CAP) hF = HFACE_CAP;
        float ff = (f.r * damp + kBase * hF * (H - Hn)) * fric;
        if (inside && hcv > ADV_MIN_H && hn > ADV_MIN_H) {
          float uc = v.x, un = V(pn).x;
          float fW = x > 0 ? F(ivec2(x - 1, z)).r : f.b;
          float fn = (x + 2 < WN) ? F(pn).r : 0.0;
          float Fc = uc * (uc > 0.0 ? fW : f.r);
          float Fn = un * (un > 0.0 ? f.r : fn);
          ff -= (Fn - Fc) * advK;
        }
        if (!inside) { ff = max(ff, max(v.x, 0.0) * hcv * L); ff = max(ff, 0.0); }
        fxo = safeF(ff);
      }
    }
  }
  // --- face vers +Z --------------------------------------------------------
  float fzo = f.g;
  {
    bool inside = z + 1 < WM;
    ivec2 pn = ivec2(x, z + 1);
    float hn = inside ? S(pn).r : 0.0;
    if (inside && hcv < WATER_EPSILON && hn < WATER_EPSILON) {
      fzo = 0.0;
    } else {
      float bn = inside ? B(pn).r : bc;
      float Hn = inside ? bn + hn : uSea;
      float crest = max(bc, bn);
      float overtop = max(H, Hn) - crest;
      if (inside && overtop <= WATER_EPSILON) {
        fzo = 0.0;
      } else {
        float hF = min(H, Hn) - crest;
        if (hF < HFACE_MIN) hF = min(HFACE_MIN, max(overtop, WATER_EPSILON));
        else if (hF > HFACE_CAP) hF = HFACE_CAP;
        float ff = (f.g * damp + kBase * hF * (H - Hn)) * fric;
        if (inside && hcv > ADV_MIN_H && hn > ADV_MIN_H) {
          float uc = v.y, un = V(pn).y;
          float fS = z > 0 ? F(ivec2(x, z - 1)).g : f.a;
          float fn = (z + 2 < WM) ? F(pn).g : 0.0;
          float Fc = uc * (uc > 0.0 ? fS : f.g);
          float Fn = un * (un > 0.0 ? f.g : fn);
          ff -= (Fn - Fc) * advK;
        }
        if (!inside) { ff = max(ff, max(v.y, 0.0) * hcv * L); ff = max(ff, 0.0); }
        fzo = safeF(ff);
      }
    }
  }
  // --- faces des bords -X et -Z : exutoires a sens unique ----------------
  float fxW = 0.0;
  if (x == 0) {
    float hF = clamp(min(H, uSea) - bc, HFACE_MIN, HFACE_CAP);
    float ff = (f.b * damp + kBase * hF * (uSea - H)) * fric;
    ff = min(ff, -max(-v.x, 0.0) * hcv * L);
    fxW = safeF(ff > 0.0 ? 0.0 : ff);
  }
  float fzS = 0.0;
  if (z == 0) {
    float hF = clamp(min(H, uSea) - bc, HFACE_MIN, HFACE_CAP);
    float ff = (f.a * damp + kBase * hF * (uSea - H)) * fric;
    ff = min(ff, -max(-v.y, 0.0) * hcv * L);
    fzS = safeF(ff > 0.0 ? 0.0 : ff);
  }
  oF = vec4(fxo, fzo, fxW, fzS);
}
`;

/**
 * ECHELLE. Passes A et B de Water.integrate : chaque face est reduite par
 * le facteur de la cellule DONNEUSE pour qu'aucune cellule ne cede plus
 * d'eau qu'elle n'en a. Le facteur du voisin est recalcule sur place plutot
 * que stocke : deux evaluations par fragment coutent moins qu'une passe.
 */
const FRAG_SCALE = /* glsl */ `
layout(location = 0) out vec4 oF;
float scaleAt(ivec2 q) {
  if (B(q).g < 0.5) return 1.0;
  vec4 fq = F(q);
  float fW = q.x > 0 ? F(ivec2(q.x - 1, q.y)).r : fq.b;
  float fS = q.y > 0 ? F(ivec2(q.x, q.y - 1)).g : fq.a;
  float o = max(fq.r, 0.0) + max(-fW, 0.0) + max(fq.g, 0.0) + max(-fS, 0.0);
  float avail = S(q).r * (A / uDt);
  return o > avail ? avail / o : 1.0;
}
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  vec4 f = F(p);
  if (B(p).g < 0.5) { oF = f; return; }
  float sc = scaleAt(p);
  float fx = f.r;
  if (fx > 0.0) fx *= sc;
  else if (fx < 0.0 && p.x + 1 < WN) fx *= scaleAt(ivec2(p.x + 1, p.y));
  float fz = f.g;
  if (fz > 0.0) fz *= sc;
  else if (fz < 0.0 && p.y + 1 < WM) fz *= scaleAt(ivec2(p.x, p.y + 1));
  float fxW = (p.x == 0 && f.b < 0.0) ? f.b * sc : f.b;
  float fzS = (p.y == 0 && f.a < 0.0) ? f.a * sc : f.a;
  oF = vec4(fx, fz, fxW, fzS);
}
`;

/**
 * INTEGRATION. Passe C de Water.integrate : divergence des flux mis a
 * l'echelle, nouvelle hauteur, vitesse de cellule plafonnee par Froude.
 * Deux sorties : S (h) et V (vitesse).
 */
const FRAG_INTEGRATE = /* glsl */ `
layout(location = 0) out vec4 oS;
layout(location = 1) out vec4 oV;
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  vec4 s = S(p);
  if (B(p).g < 0.5) { oS = s; oV = vec4(0.0); return; }
  vec4 f = F(p);
  float fW = p.x > 0 ? F(ivec2(p.x - 1, p.y)).r : f.b;
  float fS = p.y > 0 ? F(ivec2(p.x, p.y - 1)).g : f.a;
  float fE = f.r, fN = f.g;
  float h0 = s.r;
  float h1 = h0 + (fW - fE + fS - fN) * uDt / A;
  if (isnan(h1) || !(h1 > 0.0)) h1 = 0.0;
  float hm = 0.5 * (h0 + h1);
  vec2 u = vec2(0.0);
  if (hm > WATER_EPSILON) {
    u = vec2(0.5 * (fW + fE), 0.5 * (fS + fN)) / (L * hm);
    float sp = length(u);
    float spMax = uHmFr > hm ? uSpMaxFloor : min(U_ABS_MAX, FR_MAX * sqrt(GRAVITY * hm));
    if (isnan(sp) || !(sp >= 0.0)) u = vec2(0.0);
    else if (sp > spMax) u *= spMax / sp;
  }
  oS = vec4(h1, s.g, s.b, s.a);
  oV = vec4(u, 0.0, 0.0);
}
`;

/**
 * DEFERLEMENT. Critere de Kennedy sur la vitesse de montee de la surface
 * libre, complete par Froude ; dissipation semi-implicite des flux de la
 * cellule. Les bords du domaine ne deferlent pas (comme sur CPU). Sortie
 * S = (h, b, surface libre, bRoll) et F dissipe. L'ecume et les embruns
 * restent sur le CPU, nourris par b relu.
 */
const FRAG_BREAK = /* glsl */ `
layout(location = 0) out vec4 oS;
layout(location = 1) out vec4 oF;
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  int x = p.x, z = p.y;
  vec4 s = S(p), f = F(p), b = B(p);
  if (b.g < 0.5) { oS = vec4(s.r, 0.0, -1e9, 0.0); oF = f; return; }
  if (x == 0 || x == WN - 1 || z == 0 || z == WM - 1) { oS = vec4(s.r, s.g, s.b, 0.0); oF = f; return; }
  float hw = s.r;
  if (hw < WATER_EPSILON) { oS = vec4(hw, 0.0, -1e9, 0.0); oF = f; return; }
  float eta = b.r + hw;
  bool fresh = s.b < -1e8;
  float dEta = fresh ? 0.0 : (eta - s.b) / uDt;
  float cel = sqrt(GRAVITY * hw);
  float on = BREAK_ON * cel, off = BREAK_OFF * cel;
  float bk = s.g;
  if (hw < 0.006) {
    bk = max(bk - uDt / 0.05, 0.0);
  } else if (dEta >= on) {
    bk = 1.0;
  } else if (dEta <= off) {
    float tStar = 5.0 * sqrt(hw / GRAVITY);
    bk = max(bk - uDt / max(tStar, 0.05), 0.0);
  } else {
    float t = (dEta - off) / (on - off);
    bk = max(bk, t);
  }
  float bRoll = bk * smoothstep(BREAK_DEPTH_MIN, BREAK_DEPTH_FULL, hw);
  vec4 v = V(p);
  float fr = length(v.xy) / max(cel, 0.04);
  if (fr > 1.0 && hw > 0.006) {
    float t = min((fr - 1.0) / 0.6, 1.0) * smoothstep(0.006, 0.03, hw);
    if (t > bk) bk += (t - bk) * uKFr;
  }
  vec4 fo = f;
  if (bk >= 0.02 && bRoll > 0.02) {
    float k = 1.0 / (1.0 + uGain * bRoll * uDt);
    fo.r *= k; fo.g *= k;
  }
  oS = vec4(hw, bk, eta, bk >= 0.02 ? bRoll : 0.0);
  oF = fo;
}
`;

/**
 * ECHANGE DU ROULEAU + GENERATION. L'etalement du rouleau transfere une
 * fraction de la difference de surface libre entre voisines, avec la regle
 * de crete (un mur n'est pas franchi) ; formulation symetrique, donc
 * exactement conservative. Puis la relaxation vers l'onde cible dans la
 * bande de generation (Waves.applyGeneration) : h et flux melanges vers
 * l'etat cible au poids alpha.
 */
const FRAG_EXCHANGE = /* glsl */ `
layout(location = 0) out vec4 oS;
layout(location = 1) out vec4 oF;
const ivec2 OFFS[4] = ivec2[4](ivec2(1, 0), ivec2(-1, 0), ivec2(0, 1), ivec2(0, -1));
float rollK(ivec2 q, vec4 sq) {
  if (q.x == 0 || q.x == WN - 1 || q.y == 0 || q.y == WM - 1) return 0.0;
  float bRoll = sq.a;
  if (bRoll <= 0.02) return 0.0;
  return ROLLER_NU * bRoll * sqrt(GRAVITY * sq.r) * uDt / WC;
}
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  vec4 s = S(p), f = F(p), b = B(p);
  float h = s.r, bed = b.r;
  if (b.g > 0.5) {
    float Hc = bed + h;
    float kc = rollK(p, s);
    float dh = 0.0;
    for (int i = 0; i < 4; i++) {
      ivec2 q = p + OFFS[i];
      if (!inDom(q)) continue;
      vec4 bq = B(q);
      if (bq.g < 0.5) continue;
      vec4 sq = S(q);
      float k = kc + rollK(q, sq);
      if (k <= 0.0) continue;
      float Hn = bq.r + sq.r;
      float crest = max(bed, bq.r);
      if (max(Hc, Hn) <= crest + WATER_EPSILON) continue;
      float d = k * (Hn - Hc);
      d = d < 0.0 ? max(d, -0.25 * h) : min(d, 0.25 * sq.r);
      dh += d;
    }
    h = max(h + dh, 0.0);
  }
  vec4 g = texelFetch(tG, p, 0);
  float al = g.b;
  vec4 fo = f;
  if (al > 0.001) {
    float eta = 0.0;
    if (uWavesOn > 0.5) {
      for (int i = 0; i < N_COMP; i++) {
        eta += uA[i] * cos(uW[i] * uTime - uKx[i] * g.r - uKy[i] * g.g + uPh[i]);
      }
      eta = eta * uGroupAmp + uEtaIg;
    }
    float hT = max(0.0, uSea + eta - bed);
    float q = eta * uCRef * WC;
    float inv = 1.0 - al;
    h = h * inv + hT * al;
    fo.r = f.r * inv + q * (-SHORE_NX) * al;
    fo.g = f.g * inv + q * (-SHORE_NZ) * al;
  }
  oS = vec4(h, s.g, s.b, s.a);
  oF = fo;
}
`;

/**
 * INJECTION. Au debut de chaque pas : les cellules simulees recoivent le
 * delta CPU (suintement, seau, sable verse), les cellules de mer imposee
 * prennent leur valeur absolue et perdent flux, deferlement et histoire,
 * comme le fait Water.imposeOpenSea.
 */
const FRAG_INJECT = /* glsl */ `
layout(location = 0) out vec4 oS;
layout(location = 1) out vec4 oF;
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  vec4 s = S(p), f = F(p), b = B(p);
  if (b.g < 0.5) { oS = vec4(max(b.b, 0.0), 0.0, -1e9, 0.0); oF = vec4(0.0); }
  else { oS = vec4(max(s.r + b.b, 0.0), s.g, s.b, s.a); oF = f; }
}
`;

/** Empaquetage pour la relecture CPU : (h, vx, vz, b). */
const FRAG_PACK = /* glsl */ `
layout(location = 0) out vec4 oP;
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  vec4 s = S(p), v = V(p);
  oP = vec4(s.r, v.x, v.y, s.g);
}
`;

/**
 * CHAMPS FINS. Transcription de Water.syncFine sur la grille fine : la
 * surface libre est interpolee bilineairement entre les centres des cellules
 * MOUILLEES (les seches ne pesent rien), puis coupee par le terrain de chaque
 * colonne. L'etat grossier (h, vx, vz, b) est lu dans les deux derniers
 * empaquetages du solveur, melanges par uLerp (0 = pas precedent, 1 = pas
 * courant) : c'est l'interpolation temporelle qui rend la nappe fluide entre
 * deux pas. Sorties : A = (h, vx, vz, ecume), B = (sediment, deferlement,
 * laisse d'ecume, niveau mouille ou -1e9).
 */
const FRAG_FINE = /* glsl */ `
layout(location = 0) out vec4 oA;
layout(location = 1) out vec4 oB;
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  float invSub = 1.0 / float(SUB);
  float u = (float(p.x) + 0.5) * invSub - 0.5;
  int x0 = int(floor(u)); float tx = u - float(x0);
  if (x0 < 0) { x0 = 0; tx = 0.0; } else if (x0 >= WN - 1) { x0 = WN - 1; tx = 0.0; }
  int x1 = (x0 + 1 < WN) ? x0 + 1 : x0;
  float v = (float(p.y) + 0.5) * invSub - 0.5;
  int z0 = int(floor(v)); float tz = v - float(z0);
  if (z0 < 0) { z0 = 0; tz = 0.0; } else if (z0 >= WM - 1) { z0 = WM - 1; tz = 0.0; }
  int z1 = (z0 + 1 < WM) ? z0 + 1 : z0;
  float sum = 0.0, wsum = 0.0, sv = 0.0, sw = 0.0, sf = 0.0, ss = 0.0, sk = 0.0;
  ivec2 cs[4] = ivec2[4](ivec2(x0, z0), ivec2(x1, z0), ivec2(x0, z1), ivec2(x1, z1));
  float ws[4] = float[4]((1.0 - tx) * (1.0 - tz), tx * (1.0 - tz), (1.0 - tx) * tz, tx * tz);
  for (int i = 0; i < 4; i++) {
    vec4 pk = mix(texelFetch(tPk0, cs[i], 0), texelFetch(tPk1, cs[i], 0), uLerp);
    if (pk.r > WATER_EPSILON) {
      float w = ws[i];
      vec4 ax = texelFetch(tAux, cs[i], 0);
      sum += w * (B(cs[i]).r + pk.r); wsum += w;
      sv += w * pk.g; sw += w * pk.b; sf += w * ax.r; ss += w * ax.g; sk += w * pk.a;
    }
  }
  float surf = texelFetch(tSurf, p, 0).r;
  float dry = texelFetch(tAux, ivec2(p.x / SUB, p.y / SUB), 0).b;
  if (wsum > 1e-6) {
    float inv = 1.0 / wsum;
    float lvl = sum * inv;
    float d = lvl - surf;
    if (d > WATER_EPSILON) {
      oA = vec4(d, sv * inv, sw * inv, sf * inv);
      oB = vec4(ss * inv, sk * inv, dry, lvl);
      return;
    }
  }
  oA = vec4(0.0);
  oB = vec4(0.0, 0.0, dry, -1e9);
}
`;

/**
 * DILATATION DU NIVEAU. Deux passes : une cellule seche prend le niveau du
 * voisin mouille LE PLUS BAS (voir WaterRenderer.buildRenderLevel : un max
 * tendait le plan de la mer par-dessus les parois d'une fosse). Sortie
 * (niveau, valide).
 */
const FRAG_DILATE = /* glsl */ `
layout(location = 0) out vec4 oL;
vec2 rd(ivec2 q) {
  if (uFromFine == 1) { float l = texelFetch(tFineB, q, 0).a; return vec2(l, l > -1e8 ? 1.0 : 0.0); }
  return texelFetch(tLvl, q, 0).rg;
}
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  vec2 c = rd(p);
  if (c.x > -1e8) { oL = vec4(c, 0.0, 0.0); return; }
  float best = 1e9;
  if (p.x > 0) { float l = rd(ivec2(p.x - 1, p.y)).x; if (l > -1e8 && l < best) best = l; }
  if (p.x + 1 < NX) { float l = rd(ivec2(p.x + 1, p.y)).x; if (l > -1e8 && l < best) best = l; }
  if (p.y > 0) { float l = rd(ivec2(p.x, p.y - 1)).x; if (l > -1e8 && l < best) best = l; }
  if (p.y + 1 < NZ) { float l = rd(ivec2(p.x, p.y + 1)).x; if (l > -1e8 && l < best) best = l; }
  oL = best < 1e8 ? vec4(best, 1.0, 0.0, 0.0) : vec4(c.x, 0.0, 0.0, 0.0);
}
`;

/**
 * TEXTURES DU RENDU. Lissage temporel et empaquetage, tels que
 * WaterRenderer.update les faisait : champ = (niveau, profondeur, ecume ou
 * laisse, sediment), flux = (vx, vz, deferlement). Une cellule seche garde
 * son dernier niveau ; une cellule qui devient visible prend son niveau
 * d'un coup, avant que sa profondeur lissee ne la revele.
 */
const FRAG_RENDER = /* glsl */ `
layout(location = 0) out vec4 oField;
layout(location = 1) out vec4 oFlow;
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  vec4 a = texelFetch(tFineA, p, 0);
  vec4 b = texelFetch(tFineB, p, 0);
  vec2 l = texelFetch(tLvl, p, 0).rg;
  vec4 pf = texelFetch(tPrevField, p, 0);
  vec4 pv = texelFetch(tPrevFlow, p, 0);
  bool valid = l.g > 0.5;
  float lvl = l.r;
  float h = a.r;
  float f = h > WATER_EPSILON ? a.a : b.b;
  if (uPrime < 0.5) {
    if (!valid) lvl = uInitLevel;
    oField = vec4(lvl, h, f, b.r);
    oFlow = vec4(a.g, a.b, b.g, 0.0);
    return;
  }
  if (!valid) lvl = pf.r;
  bool wasVisible = pf.g >= 0.0016;
  float r = (!wasVisible && valid) ? lvl : pf.r + (lvl - pf.r) * uKL;
  float g = pf.g + (h - pf.g) * uKL;
  float bb = pf.b + (f - pf.b) * uKS;
  float aa = pf.a + (b.r - pf.a) * uKS;
  oField = vec4(r, g, bb, aa);
  oFlow = vec4(pv.rg + (a.gb - pv.rg) * uKS, pv.b + (b.g - pv.b) * uKL, 0.0);
}
`;

/** Toutes les sources, pour les tests et le diagnostic. */
export function buildWaterShaders() {
  const head = glslHead();
  return {
    vertex: VERT,
    flux: head + FRAG_FLUX,
    scale: head + FRAG_SCALE,
    integrate: head + FRAG_INTEGRATE,
    breaking: head + FRAG_BREAK,
    exchange: head + FRAG_EXCHANGE,
    inject: head + FRAG_INJECT,
    pack: head + FRAG_PACK,
    fine: head + FRAG_FINE,
    dilate: head + FRAG_DILATE,
    render: head + FRAG_RENDER,
  };
}

// ---------------------------------------------------------------------------
// PIPELINE
// ---------------------------------------------------------------------------

const SCALARS = ['uDt', 'uSea', 'uHFric', 'uHmFr', 'uSpMaxFloor', 'uGain', 'uKFr', 'uTime',
  'uGroupAmp', 'uEtaIg', 'uCRef', 'uWavesOn', 'uKL', 'uKS', 'uPrime', 'uInitLevel', 'uLerp'];
const ARRAYS = ['uA', 'uKx', 'uKy', 'uW', 'uPh'];

export class WaterGPU {
  /**
   * @param {import('./Water.js').Water} water
   * @param {THREE.WebGLRenderer} renderer
   * @param {{trace?: boolean, fine?: boolean}} [opts]
   */
  constructor(water, renderer, opts = {}) {
    this.water = water;
    this.renderer = renderer;
    this.trace = !!opts.trace;
    /** 'validating' | 'ready' | 'active' | 'off' */
    this.mode = 'off';
    this.reason = '';
    this.validated = 0;
    this.solveId = 0;
    this.pending = false;
    this._ref = null;
    this._skip = false;
    this._bandsSeen = -1;
    this._surfSeen = -1;
    this.stats = { readbacks: 0, lateReadbacks: 0, maxErr: 0, rmsErr: 0 };

    const gl = renderer.getContext();
    if (typeof WebGL2RenderingContext === 'undefined' || !(gl instanceof WebGL2RenderingContext)) {
      throw new Error('WebGL2 requis');
    }
    this.gl = gl;
    if (!gl.getExtension('EXT_color_buffer_float')) throw new Error('EXT_color_buffer_float absent');
    // Les textures du rendu sont filtrees lineairement : il faut le filtrage
    // des flottants. Sans lui, seul le solveur passe sur le GPU.
    this.linearFloat = !!gl.getExtension('OES_texture_float_linear');
    this.fineEnabled = this.linearFloat && opts.fine !== false;

    // --- programmes ---------------------------------------------------------
    const src = buildWaterShaders();
    this.pFlux = this._program(src.flux);
    this.pScale = this._program(src.scale);
    this.pIntegrate = this._program(src.integrate);
    this.pBreak = this._program(src.breaking);
    this.pExchange = this._program(src.exchange);
    this.pInject = this._program(src.inject);
    this.pPack = this._program(src.pack);
    if (this.fineEnabled) {
      this.pFine = this._program(src.fine);
      this.pDilate = this._program(src.dilate);
      this.pRender = this._program(src.render);
    }

    // --- textures grossieres ---------------------------------------------------
    this.S = [this._tex(WN, WM), this._tex(WN, WM)];
    this.Fx = [this._tex(WN, WM), this._tex(WN, WM)];
    this.Vv = [this._tex(WN, WM), this._tex(WN, WM)];
    this.F0 = this._tex(WN, WM);
    this.F1 = this._tex(WN, WM);
    this.texB = this._tex(WN, WM);     // (fond, sim, delta h ou h impose, 0)
    this.texG = this._tex(WN, WM);     // (sx, sy, alpha, 0)
    this.texAux = this._tex(WN, WM);   // (ecume, sediment, laisse, 0)
    // Deux empaquetages (h, vx, vz, b) : le pas courant et le precedent, entre
    // lesquels les champs fins interpolent a chaque image.
    this.packT = [this._tex(WN, WM), this._tex(WN, WM)];
    this.packIdx = 0;
    this.solveStamp = 0;
    this._auxDirty = true;
    this.sIdx = 0; this.fIdx = 0; this.vIdx = 0;
    this.dataB = new Float32Array(WCOLS * 4);
    this.dataG = new Float32Array(WCOLS * 4);
    this.dataAux = new Float32Array(WCOLS * 4);
    this.dataS = new Float32Array(WCOLS * 4);
    this.dataF = new Float32Array(WCOLS * 4);
    this.dataV = new Float32Array(WCOLS * 4);

    // --- textures fines ------------------------------------------------------
    if (this.fineEnabled) {
      this.texSurf = this._tex(NX, NZ, gl.R32F, gl.RED);
      this.fineA = this._tex(NX, NZ);
      this.fineB = this._tex(NX, NZ);
      this.lvl = [this._tex(NX, NZ, gl.RG32F, gl.RG), this._tex(NX, NZ, gl.RG32F, gl.RG)];
      this.fieldT = [this._tex(NX, NZ, gl.RGBA32F, gl.RGBA, true), this._tex(NX, NZ, gl.RGBA32F, gl.RGBA, true)];
      this.flowT = [this._tex(NX, NZ, gl.RGBA32F, gl.RGBA, true), this._tex(NX, NZ, gl.RGBA32F, gl.RGBA, true)];
      this.fieldIdx = 0;
      this.fieldTex = [new THREE.ExternalTexture(this.fieldT[0]), new THREE.ExternalTexture(this.fieldT[1])];
      this.flowTex = [new THREE.ExternalTexture(this.flowT[0]), new THREE.ExternalTexture(this.flowT[1])];
      this.dataSurf = new Float32Array(FCOLS);
      this._primed = false;
    }

    this.vao = gl.createVertexArray();
    this.fbos = new Map();
    // Tampon de relecture asynchrone.
    this.pbo = gl.createBuffer();
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, this.pbo);
    gl.bufferData(gl.PIXEL_PACK_BUFFER, WCOLS * 16, gl.STREAM_READ);
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
    this.sync = null;
    this.readBuf = new Float32Array(WCOLS * 4);
    /** Copie de h telle que le GPU la connait : les deltas se mesurent par rapport a elle. */
    this.hcBase = new Float32Array(WCOLS);

    this._release();
    this.mode = 'validating';
  }

  /** Etiquette pour le panneau de diagnostic. */
  get label() {
    if (this.mode === 'active') return this.fineEnabled ? 'GPU + champs fins' : 'GPU';
    if (this.mode === 'validating' || this.mode === 'ready') return `GPU (validation ${this.validated}/${VALIDATE_N})`;
    return `CPU (${this.reason || 'GPU coupe'})`;
  }

  get active() { return this.mode === 'active'; }

  /** Les textures du rendu sont produites ici. */
  get fineReady() { return this.mode === 'active' && this.fineEnabled; }

  /** Texture (niveau, profondeur, ecume, sediment) courante du rendu. */
  get fieldTexture() { return this.fineEnabled ? this.fieldTex[this.fieldIdx] : null; }

  /** Texture (vx, vz, deferlement) courante du rendu. */
  get flowTexture() { return this.fineEnabled ? this.flowTex[this.fieldIdx] : null; }

  // --- GL de base ---------------------------------------------------------------

  _program(fragSrc) {
    const gl = this.gl;
    const compile = (type, source) => {
      const sh = gl.createShader(type);
      gl.shaderSource(sh, source);
      gl.compileShader(sh);
      if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
        const log = gl.getShaderInfoLog(sh);
        gl.deleteShader(sh);
        throw new Error('shader : ' + log);
      }
      return sh;
    };
    const vs = compile(gl.VERTEX_SHADER, VERT);
    const fs = compile(gl.FRAGMENT_SHADER, fragSrc);
    const prog = gl.createProgram();
    gl.attachShader(prog, vs); gl.attachShader(prog, fs);
    gl.linkProgram(prog);
    gl.deleteShader(vs); gl.deleteShader(fs);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
      const log = gl.getProgramInfoLog(prog);
      gl.deleteProgram(prog);
      throw new Error('programme : ' + log);
    }
    const loc = {};
    gl.useProgram(prog);
    for (const name of Object.keys(UNITS)) {
      const l = gl.getUniformLocation(prog, name);
      if (l) gl.uniform1i(l, UNITS[name]);
    }
    for (const name of SCALARS) loc[name] = gl.getUniformLocation(prog, name);
    for (const name of ARRAYS) loc[name] = gl.getUniformLocation(prog, name + '[0]') || gl.getUniformLocation(prog, name);
    loc.uFromFine = gl.getUniformLocation(prog, 'uFromFine');
    return { prog, loc };
  }

  _tex(w, h, internal, format, linear = false) {
    const gl = this.gl;
    const t = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texImage2D(gl.TEXTURE_2D, 0, internal ?? gl.RGBA32F, w, h, 0, format ?? gl.RGBA, gl.FLOAT, null);
    const f = linear ? gl.LINEAR : gl.NEAREST;
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, f);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, f);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    t.__w = w; t.__h = h; t.__format = format ?? gl.RGBA;
    t.__id = ++WaterGPU._texIds;
    return t;
  }

  _upload(tex, data) {
    const gl = this.gl;
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 4);
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, tex.__w, tex.__h, tex.__format, gl.FLOAT, data);
  }

  _fbo(outputs) {
    const key = outputs.map((t) => t.__id).join(':');
    let fbo = this.fbos.get(key);
    if (fbo) return fbo;
    const gl = this.gl;
    fbo = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    const bufs = [];
    for (let i = 0; i < outputs.length; i++) {
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0 + i, gl.TEXTURE_2D, outputs[i], 0);
      bufs.push(gl.COLOR_ATTACHMENT0 + i);
    }
    gl.drawBuffers(bufs);
    const st = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
    if (st !== gl.FRAMEBUFFER_COMPLETE) throw new Error('cible incomplete (' + st + ')');
    fbo.__w = outputs[0].__w; fbo.__h = outputs[0].__h;
    this.fbos.set(key, fbo);
    return fbo;
  }

  /** Prepare l'etat GL pour une serie de passes. */
  _begin() {
    const gl = this.gl;
    gl.disable(gl.DEPTH_TEST);
    gl.disable(gl.BLEND);
    gl.disable(gl.SCISSOR_TEST);
    gl.disable(gl.CULL_FACE);
    gl.disable(gl.STENCIL_TEST);
    gl.colorMask(true, true, true, true);
    gl.bindVertexArray(this.vao);
  }

  /** Rend la main a three.js, dont le cache d'etat ne sait rien de nos appels. */
  _release() {
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.bindVertexArray(null);
    this.renderer.resetState();
  }

  _draw(P, outputs, inputs) {
    const gl = this.gl;
    const fbo = this._fbo(outputs);
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.viewport(0, 0, fbo.__w, fbo.__h);
    gl.useProgram(P.prog);
    for (const name in inputs) {
      gl.activeTexture(gl.TEXTURE0 + UNITS[name]);
      gl.bindTexture(gl.TEXTURE_2D, inputs[name]);
    }
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  _setSolverUniforms(P, sub) {
    const gl = this.gl, W = this.water, w = W.waves, loc = P.loc;
    gl.useProgram(P.prog);
    const hmFr = Math.max(FR_DEPTH_MIN, w.hsEffective);
    const vals = {
      uDt: sub, uSea: W.seaLevel,
      uHFric: Math.max(FRIC_DEPTH_MIN, FRIC_DEPTH_HS * w.hsEffective),
      uHmFr: hmFr, uSpMaxFloor: Math.min(U_ABS_MAX, FR_MAX * Math.sqrt(GRAVITY * hmFr)),
      uGain: BREAK_GAIN_BASE + BREAK_GAIN_AGIT * w.agitation,
      uKFr: 1 - Math.exp(-sub / 0.12), uTime: w.time, uGroupAmp: w.groupAmp,
      uEtaIg: w.etaIg, uCRef: w.cRef, uWavesOn: w.enabled ? 1 : 0,
    };
    for (const k in vals) if (loc[k]) gl.uniform1f(loc[k], vals[k]);
    if (loc.uA) gl.uniform1fv(loc.uA, w.a);
    if (loc.uKx) gl.uniform1fv(loc.uKx, w.kx);
    if (loc.uKy) gl.uniform1fv(loc.uKy, w.ky);
    if (loc.uW) gl.uniform1fv(loc.uW, w.w);
    if (loc.uPh) gl.uniform1fv(loc.uPh, w.ph);
  }

  // --- entrees CPU -> GPU ----------------------------------------------------

  _fillB(absolute) {
    const W = this.water, d = this.dataB;
    const bed = W.bed, sim = W.simMask, hc = W.hc, base = this.hcBase;
    for (let c = 0, o = 0; c < WCOLS; c++, o += 4) {
      d[o] = bed[c];
      d[o + 1] = sim[c];
      d[o + 2] = absolute || !sim[c] ? hc[c] : hc[c] - base[c];
      d[o + 3] = 0;
      base[c] = hc[c];
    }
    this._upload(this.texB, d);
  }

  _fillG() {
    const w = this.water.waves, d = this.dataG;
    for (let c = 0, o = 0; c < WCOLS; c++, o += 4) {
      d[o] = w.sx[c]; d[o + 1] = w.sy[c]; d[o + 2] = w.alpha[c]; d[o + 3] = 0;
    }
    this._upload(this.texG, d);
    this._bandsSeen = w.bandsVersion;
  }

  _prepare(sub) {
    const w = this.water.waves;
    if (w.bandsVersion !== this._bandsSeen) this._fillG();
    for (const P of [this.pFlux, this.pScale, this.pIntegrate, this.pBreak, this.pExchange]) {
      this._setSolverUniforms(P, sub);
    }
  }

  /**
   * Charge l'etat CPU complet (h, b, surface libre, flux, vitesses) dans les
   * textures courantes : depart d'une validation, activation, remise a zero.
   */
  uploadFull() {
    const W = this.water;
    const dS = this.dataS, dF = this.dataF, dV = this.dataV;
    const hc = W.hc, brk = W.brk, eta = W.etaPrev, fx = W.fx, fz = W.fz, fxW = W.fxW, fzS = W.fzS;
    const vx = W.vxc, vz = W.vzc;
    for (let z = 0, c = 0; z < WM; z++) {
      for (let x = 0; x < WN; x++, c++) {
        const o = c * 4;
        dS[o] = hc[c]; dS[o + 1] = brk[c]; dS[o + 2] = eta[c]; dS[o + 3] = 0;
        dF[o] = fx[c]; dF[o + 1] = fz[c]; dF[o + 2] = x === 0 ? fxW[z] : 0; dF[o + 3] = z === 0 ? fzS[x] : 0;
        dV[o] = vx[c]; dV[o + 1] = vz[c]; dV[o + 2] = 0; dV[o + 3] = 0;
        this.hcBase[c] = hc[c];
      }
    }
    this._upload(this.S[this.sIdx], dS);
    this._upload(this.Fx[this.fIdx], dF);
    this._upload(this.Vv[this.vIdx], dV);
  }

  /** L'etat CPU a ete reecrit (nouvelle plage, chargement) : on repart de lui. */
  invalidate() {
    if (this.mode === 'off') return;
    try {
      this.uploadFull();
      this._release();
    } catch (e) {
      this._fail('rechargement impossible : ' + e.message);
    }
  }

  // --- passes du solveur --------------------------------------------------------

  _substep() {
    const sA = this.sIdx, sB = 1 - sA, fA = this.fIdx, fB = 1 - fA, vA = this.vIdx, vB = 1 - vA;
    const S = this.S, Fx = this.Fx, Vv = this.Vv;
    // FLUX : etat courant -> F0.
    this._draw(this.pFlux, [this.F0], { tS: S[sA], tF: Fx[fA], tV: Vv[vA], tB: this.texB });
    // ECHELLE : F0 -> F1.
    this._draw(this.pScale, [this.F1], { tS: S[sA], tF: this.F0, tB: this.texB });
    // INTEGRATION : (S, F1) -> (S1, V1).
    this._draw(this.pIntegrate, [S[sB], Vv[vB]], { tS: S[sA], tF: this.F1, tB: this.texB });
    // DEFERLEMENT : (S1, V1, F1) -> (S2 dans S[sA], F2 dans Fx[fB]).
    this._draw(this.pBreak, [S[sA], Fx[fB]], { tS: S[sB], tV: Vv[vB], tF: this.F1, tB: this.texB });
    // ECHANGE + GENERATION : (S2, F2) -> (S3 dans S[sB], F3 dans Fx[fA]).
    this._draw(this.pExchange, [S[sB], Fx[fA]], { tS: S[sA], tF: Fx[fB], tB: this.texB, tG: this.texG });
    this.sIdx = sB; this.vIdx = vB;
  }

  _pack() {
    const nxt = 1 - this.packIdx;
    this._draw(this.pPack, [this.packT[nxt]], { tS: this.S[this.sIdx], tV: this.Vv[this.vIdx] });
    this.packIdx = nxt;
    this.solveStamp = performance.now();
    this._auxDirty = true;
  }

  /**
   * Un pas complet en mode ACTIF : injection des modifications CPU, sous-pas,
   * empaquetage et lecture asynchrone.
   */
  solve(sub, n) {
    if (this.mode !== 'active') return;
    try {
      this._begin();
      this._pollReadback();
      this._prepare(sub);
      this._fillB(false);
      const sA = this.sIdx, fA = this.fIdx;
      this._draw(this.pInject, [this.S[1 - sA], this.Fx[1 - fA]], { tS: this.S[sA], tF: this.Fx[fA], tB: this.texB });
      this.sIdx = 1 - sA; this.fIdx = 1 - fA;
      for (let k = 0; k < n; k++) this._substep();
      this._pack();
      this._requestReadback(null);
      this._release();
    } catch (e) {
      this._release();
      this._fail('erreur GPU : ' + e.message);
    }
  }

  /** Debut de validation : le GPU repart de l'etat CPU d'avant les sous-pas. */
  captureStart() {
    if (this.mode !== 'validating') return;
    this._begin();
    this._pollReadback();
    if (this.pending) { this._skip = true; this._release(); return; }
    this._skip = false;
    try { this.uploadFull(); this._release(); }
    catch (e) { this._release(); this._fail('chargement impossible : ' + e.message); }
  }

  /**
   * Fin de validation : les memes sous-pas sur le GPU, et le resultat CPU
   * (deja calcule) mis de cote pour la comparaison a la relecture.
   */
  validateSolve(sub, n) {
    if (this.mode !== 'validating' || this._skip) return;
    try {
      this._begin();
      this._prepare(sub);
      this._fillB(true);
      for (let k = 0; k < n; k++) this._substep();
      this._pack();
      const W = this.water;
      this._requestReadback({ hc: Float32Array.from(W.hc) });
      this._release();
    } catch (e) {
      this._release();
      this._fail('erreur GPU : ' + e.message);
    }
  }

  /** Passage en mode actif, depuis l'etat CPU courant (exactement synchrone). */
  activate() {
    if (this.mode !== 'ready') return;
    try {
      this._begin();
      this.uploadFull();
      // Les deux empaquetages partent du meme etat : pas de rampe au depart.
      this._pack(); this._pack();
      this._release();
      this.mode = 'active';
      this.pending = false;
      console.info('[eau] solveur GPU actif%s (validation : ecart max %s mm, rms %s mm)',
        this.fineEnabled ? ' avec champs fins' : '',
        (this.stats.maxErr * 1000).toFixed(2), (this.stats.rmsErr * 1000).toFixed(3));
    } catch (e) {
      this._release();
      this._fail('activation impossible : ' + e.message);
    }
  }

  // --- relecture asynchrone -----------------------------------------------------

  _requestReadback(ref) {
    if (this.pending) { this.stats.lateReadbacks++; return; }
    const gl = this.gl;
    const fbo = this._fbo([this.packT[this.packIdx]]);
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, fbo);
    gl.readBuffer(gl.COLOR_ATTACHMENT0);
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, this.pbo);
    gl.readPixels(0, 0, WN, WM, gl.RGBA, gl.FLOAT, 0);
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, null);
    this.sync = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0);
    gl.flush();
    this.pending = true;
    this.solveId++;
    if (ref) { ref.id = this.solveId; this._ref = ref; }
    this._pendingId = this.solveId;
  }

  /** La relecture demandee au pas precedent est-elle arrivee ? */
  _pollReadback() {
    if (!this.pending || !this.sync) return;
    const gl = this.gl;
    const st = gl.clientWaitSync(this.sync, 0, 0);
    if (st !== gl.ALREADY_SIGNALED && st !== gl.CONDITION_SATISFIED) {
      if (st === gl.WAIT_FAILED) this._fail('fence en erreur');
      return;
    }
    gl.deleteSync(this.sync);
    this.sync = null;
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, this.pbo);
    gl.getBufferSubData(gl.PIXEL_PACK_BUFFER, 0, this.readBuf);
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
    this.pending = false;
    this.stats.readbacks++;
    this._onReadback(this.readBuf, this._pendingId);
  }

  _onReadback(buf, id) {
    if (this.mode === 'off') return;
    const W = this.water, sim = W.simMask;
    if (this.mode === 'validating') {
      const ref = this._ref;
      if (!ref || ref.id !== id) return;
      this._ref = null;
      let maxErr = 0, sq = 0, n = 0, bad = false;
      for (let c = 0; c < WCOLS; c++) {
        if (!sim[c]) continue;
        const h = buf[c * 4];
        if (!(h >= 0)) { bad = true; break; }
        const e = Math.abs(h - ref.hc[c]);
        if (e > maxErr) maxErr = e;
        sq += e * e; n++;
      }
      const rms = n ? Math.sqrt(sq / n) : 0;
      this.stats.maxErr = Math.max(this.stats.maxErr, maxErr);
      this.stats.rmsErr = Math.max(this.stats.rmsErr, rms);
      if (this.trace) console.info('[eau] validation GPU : max %s mm, rms %s mm', (maxErr * 1000).toFixed(2), (rms * 1000).toFixed(3));
      if (bad) { this._fail('valeur non finie relue'); return; }
      if (maxErr > TOL_MAX || rms > TOL_RMS) {
        this._fail(`ecart CPU/GPU ${(maxErr * 1000).toFixed(1)} mm max, ${(rms * 1000).toFixed(2)} mm rms`);
        return;
      }
      if (++this.validated >= VALIDATE_N) this.mode = 'ready';
      return;
    }
    // Mode actif : la copie CPU prend l'etat GPU, plus ce que le CPU a
    // change depuis le dernier envoi (ce delta n'est pas encore sur le GPU).
    const hc = W.hc, vx = W.vxc, vz = W.vzc, brk = W.brk, base = this.hcBase;
    let wet = 0, vol = 0, hMax = 0, uMax = 0, breaking = 0, bad = false;
    for (let c = 0; c < WCOLS; c++) {
      if (!sim[c]) continue;
      const o = c * 4;
      let h = buf[o];
      if (!(h >= 0)) { bad = true; h = 0; }
      const pend = hc[c] - base[c];
      const nh = h + pend;
      hc[c] = nh > 0 ? nh : 0;
      base[c] = h;
      const ux = buf[o + 1], uz = buf[o + 2], b = buf[o + 3];
      vx[c] = ux === ux ? ux : 0; vz[c] = uz === uz ? uz : 0; brk[c] = b === b ? b : 0;
      if (h > WATER_EPSILON) {
        wet++; vol += h;
        const sp = Math.sqrt(vx[c] * vx[c] + vz[c] * vz[c]);
        if (sp > uMax) uMax = sp;
        if (h > hMax) hMax = h;
      }
      if (brk[c] >= 0.02) breaking++;
    }
    if (bad) { this._fail('valeur non finie relue'); return; }
    W.stats.wetCells = wet; W.stats.volume = vol * WC * WC; W.stats.breaking = breaking;
    W.hMaxSea = hMax; W.uMax = uMax;
    W.rescan();
  }

  // --- champs fins du rendu -------------------------------------------------------

  /**
   * Produit les textures du rendu, A CHAQUE IMAGE, en interpolant entre les
   * deux derniers pas du solveur. `dt` est l'intervalle depuis l'image
   * precedente, pour le lissage temporel.
   */
  renderFine(dt) {
    if (!this.fineReady) return false;
    try {
      const gl = this.gl, W = this.water;
      this._begin();
      // Ecume, sediment et laisse vivent sur le CPU : on les televerse quand
      // le solveur a avance, pas a chaque image.
      if (this._auxDirty) {
        this._auxDirty = false;
        const d = this.dataAux, foam = W.foamc, sed = W.sedc, dry = W.foamDryc;
        const dryOn = W._dryFoamActive ? 1 : 0;
        for (let c = 0, o = 0; c < WCOLS; c++, o += 4) {
          d[o] = foam[c]; d[o + 1] = sed[c]; d[o + 2] = dryOn ? dry[c] : 0; d[o + 3] = 0;
        }
        this._upload(this.texAux, d);
      }
      // Position entre le pas precedent (0) et le pas courant (1).
      const lerp = Math.min(1, Math.max(0, (performance.now() - this.solveStamp) * WATER_SIM_HZ / 1000));
      gl.useProgram(this.pFine.prog);
      gl.uniform1f(this.pFine.loc.uLerp, lerp);
      // Le terrain fin, seulement quand il a change.
      const F = W.field;
      if (F.surfaceVersion !== this._surfSeen) {
        this._surfSeen = F.surfaceVersion;
        this._upload(this.texSurf, F.surfaceH);
      }
      this._draw(this.pFine, [this.fineA, this.fineB], {
        tPk0: this.packT[1 - this.packIdx], tPk1: this.packT[this.packIdx],
        tB: this.texB, tAux: this.texAux, tSurf: this.texSurf,
      });
      gl.useProgram(this.pDilate.prog);
      gl.uniform1i(this.pDilate.loc.uFromFine, 1);
      this._draw(this.pDilate, [this.lvl[0]], { tFineB: this.fineB, tLvl: this.lvl[1] });
      gl.uniform1i(this.pDilate.loc.uFromFine, 0);
      this._draw(this.pDilate, [this.lvl[1]], { tFineB: this.fineB, tLvl: this.lvl[0] });
      const prev = this.fieldIdx, next = 1 - prev;
      const P = this.pRender;
      gl.useProgram(P.prog);
      // L'interpolation lisse deja le mouvement : le niveau ne garde qu'un
      // filtre court contre l'alternance mouille/sec d'une image a l'autre.
      gl.uniform1f(P.loc.uKL, 1 - Math.exp(-dt / 0.035));
      gl.uniform1f(P.loc.uKS, 1 - Math.exp(-dt / 0.22));
      gl.uniform1f(P.loc.uPrime, this._primed ? 1 : 0);
      gl.uniform1f(P.loc.uInitLevel, Number.isFinite(W.seaLevel) ? W.seaLevel : 0);
      this._draw(P, [this.fieldT[next], this.flowT[next]], {
        tFineA: this.fineA, tFineB: this.fineB, tLvl: this.lvl[1],
        tPrevField: this.fieldT[prev], tPrevFlow: this.flowT[prev],
      });
      this.fieldIdx = next;
      this._primed = true;
      this._release();
      return true;
    } catch (e) {
      this._release();
      this._fail('champs fins : ' + e.message);
      return false;
    }
  }

  _fail(reason) {
    if (this.mode === 'off') return;
    this.mode = 'off';
    this.reason = reason;
    this.pending = false;
    console.warn('[eau] solveur GPU desactive, retour au CPU :', reason);
  }

  dispose() {
    this.mode = 'off';
    const gl = this.gl;
    for (const fbo of this.fbos.values()) gl.deleteFramebuffer(fbo);
    this.fbos.clear();
    const texs = [...this.S, ...this.Fx, ...this.Vv, this.F0, this.F1, this.texB, this.texG, this.texAux, ...this.packT];
    if (this.fineEnabled) texs.push(this.texSurf, this.fineA, this.fineB, ...this.lvl, ...this.fieldT, ...this.flowT);
    for (const t of texs) gl.deleteTexture(t);
    for (const P of [this.pFlux, this.pScale, this.pIntegrate, this.pBreak, this.pExchange, this.pInject, this.pPack, this.pFine, this.pDilate, this.pRender]) {
      if (P) gl.deleteProgram(P.prog);
    }
    gl.deleteVertexArray(this.vao);
    gl.deleteBuffer(this.pbo);
    if (this.sync) gl.deleteSync(this.sync);
    this.renderer.resetState();
  }
}
WaterGPU._texIds = 0;
