/**
 * Rendu de l'eau : la surface, son volume et ses gouttes.
 *
 * Une seule nappe pour la mer, les douves et les flaques. La physique est un
 * champ hauteur en eaux peu profondes (Water.js) ; ce renderer le lit dans une
 * texture flottante, puis le shader lui donne Fresnel, reflexion, refraction,
 * absorption, ecume et caustiques.
 *
 *   R = altitude de la surface libre
 *   G = hauteur d'eau (profondeur)
 *   B = écume (mémoire de la turbulence) — et, sur une cellule SÈCHE, la
 *       laisse d'écume que le shader du sable dessine
 *   A = sédiment en suspension
 *
 * Une seconde texture (RG) porte la FLOW MAP : la vitesse de l'écoulement,
 * qui fait défiler l'écume et le grain de la surface dans le sens du courant.
 * C'est la lecture la plus immédiate du champ de vitesse pour le joueur.
 *
 * Ce que la nappe ne peut pas montrer, les GOUTTES le montrent : l'eau qui
 * quitte la nappe (chute d'un seau, lame qui bascule d'un rebord) est une
 * goutte balistique (Droplets.js), dessinée comme une petite sphère d'eau qui
 * rend son volume à la nappe en se posant.
 *
 * Deux principes qui ont demandé plusieurs essais :
 *
 *  - LES COORDONNÉES DE TEXTURE SONT CALCULÉES DEPUIS LA POSITION MONDE, pas
 *    depuis les UV de la géométrie. Le plan est tourné de -90° autour de X, ce
 *    qui retourne son axe V ; s'appuyer dessus revenait à échantillonner la
 *    grille en miroir, et la mer se dessinait du mauvais côté de la plage.
 *    Passer par la position monde supprime toute cette classe de bugs, et la
 *    ceinture de volume peut partager exactement la même convention.
 *
 *  - LE DÉTAIL DES VAGUELETTES VIT DANS LA NORMALE, PAS DANS LA GÉOMÉTRIE.
 *    Une somme de sinus appliquée aux sommets d'une grille régulière produit
 *    un moiré très visible en incidence rasante — de longues stries diagonales
 *    parfaitement régulières, exactement ce qu'on voyait sur la mer. La
 *    géométrie ne porte plus que la houle longue ; tout le grain de surface
 *    est un bruit multi-octave évalué par pixel.
 */

import * as THREE from 'three';
import {
  NX, NZ, VOXEL, WORLD_W, WORLD_D, ORIGIN_X, ORIGIN_Z, WATER_EPSILON,
  DROPLET_RADIUS, DROPLET_MAX,
} from '../core/Config.js';
import { WaterVolume } from './WaterVolume.js';
import { WATER_COMMON_GLSL } from './WaterCommon.js';

const F = (v) => v.toFixed(5);

const VERT = /* glsl */ `
uniform sampler2D uField;
uniform sampler2D uFlow;
uniform vec2 uTexel;

varying vec2 vFieldUv;
varying vec3 vWorldPos;
varying float vDepth;
varying float vFoam;
varying float vSed;
varying vec3 vSurfNormal;
varying vec4 vClipPosition;
varying float vBrk;
varying vec2 vFlowDir;

void main() {
  // UV depuis la position monde : voir l'en-tete du fichier.
  vec2 uvw = vec2(
    (position.x - (${F(ORIGIN_X)})) / ${F(WORLD_W)},
    (position.z - (${F(ORIGIN_Z)})) / ${F(WORLD_D)}
  );
  uvw = clamp(uvw, uTexel * 0.5, 1.0 - uTexel * 0.5);
  vFieldUv = uvw;

  // Les sommets de la grille representent les COLONNES du solveur. Lire la
  // texture avec son filtrage bilineaire melangeait, au bord d'une tour, une
  // colonne seche avec la colonne mouillee voisine. La profondeur interpolee
  // restait visible tandis que le niveau venait parfois d'une autre altitude :
  // le triangle se tendait alors en une grande pointe verticale. On cale la
  // lecture geometrique au centre du texel ; le fragment garde naturellement
  // son interpolation douce a l'interieur du triangle.
  vec2 cellUv = (floor(uvw / uTexel) + 0.5) * uTexel;
  cellUv = clamp(cellUv, uTexel * 0.5, 1.0 - uTexel * 0.5);
  vec4 f = texture2D(uField, cellUv);
  float level = f.r;
  vDepth = f.g;
  vFoam = f.b;
  vSed = f.a;

  // La geometrie vient EXCLUSIVEMENT du solveur : la houle est deja dans le
  // champ hauteur. En ajouter une seconde ici recreerait des bosses sans
  // volume physique. Seule une micro-normale optique reste dans le fragment.
  vec3 p = vec3(position.x, level, position.z);

  // Normale des grandes structures, par differences finies sur la texture.
  float hL = texture2D(uField, cellUv - vec2(uTexel.x, 0.0)).r;
  float hR = texture2D(uField, cellUv + vec2(uTexel.x, 0.0)).r;
  float hD = texture2D(uField, cellUv - vec2(0.0, uTexel.y)).r;
  float hU = texture2D(uField, cellUv + vec2(0.0, uTexel.y)).r;
  vSurfNormal = normalize(vec3(hL - hR, 2.0 * ${F(VOXEL)}, hD - hU));

  // --- la crete qui se cambre -----------------------------------------------
  // La ou la vague deferle (canal B de la flow map), la face avant se penche
  // dans le sens du courant et se souleve : c'est le rouleau. Un champ
  // hauteur ne peut pas vraiment surplomber, mais en avancant la levre d'une
  // cellule d'eau la face devient verticale et le pli se lit.
  vec4 fl = texture2D(uFlow, cellUv);
  float brk = clamp(fl.b, 0.0, 1.0);
  vec2 fdir = length(fl.xy) > 0.05 ? normalize(fl.xy) : vec2(0.0, 1.0);
  vec2 grad = vec2(hR - hL, hU - hD) * (0.5 / ${F(VOXEL)});
  float down = max(0.0, -dot(grad, fdir));
  // Un front raide se cambre meme avant que le critere de deferlement ne
  // s'allume : la raideur fait la moitie du pli, le rouleau l'autre.
  float steep = smoothstep(0.35, 1.5, down);
  float lean = steep * (0.4 + 0.6 * brk);
  p.x += fdir.x * lean * 0.12;
  p.z += fdir.y * lean * 0.12;
  p.y += lean * 0.05;
  vBrk = max(brk, steep * 0.6);
  vFlowDir = fdir;

  vec4 wp = modelMatrix * vec4(p, 1.0);
  vWorldPos = wp.xyz;
  gl_Position = projectionMatrix * viewMatrix * wp;
  vClipPosition = gl_Position;
}
`;

const FRAG = /* glsl */ `
uniform sampler2D uField;
uniform vec2 uTexel;
uniform vec3 uSunDir;
uniform vec3 uSunColor;
uniform vec3 uShallow;
uniform vec3 uDeep;
uniform vec3 uSkyZenith;
uniform vec3 uSkyHorizon;
uniform float uTime;
uniform float uChop;
uniform sampler2D uSceneColor;
uniform sampler2D uSceneDepth;
uniform vec2 uSceneTexel;
uniform float uRefractionEnabled;
uniform float uScreenReflections;
uniform mat4 uCameraProjection;
uniform float uCameraNear;
uniform float uCameraFar;
uniform sampler2D uFlow;

varying vec2 vFieldUv;
varying vec3 vWorldPos;
varying float vDepth;
varying float vFoam;
varying float vSed;
varying vec3 vSurfNormal;
varying vec4 vClipPosition;
varying float vBrk;
varying vec2 vFlowDir;

${WATER_COMMON_GLSL}

float hash12(vec2 p) { return wc_hash12(p); }
float vnoise2(vec2 p) { return wc_vnoise2(p); }

/**
 * Normale de detail : trois octaves de bruit qui defilent dans des directions
 * differentes. C'est ce qui remplace le deplacement geometrique des
 * vaguelettes, et ca ne peut pas produire de moire puisque ca ne depend pas
 * du maillage.
 */
vec3 detailNormal(vec2 p, float amp, float lod) {
  const vec2 D0 = vec2( 0.86,  0.51);
  const vec2 D1 = vec2(-0.42,  0.91);
  const vec2 D2 = vec2( 0.31, -0.95);
  float e = 0.035;
  vec2 a = p * 3.1 + D0 * uTime * 0.35;
  float n = vnoise2(a);
  vec2 g = vec2(vnoise2(a + vec2(e, 0.0)) - n, vnoise2(a + vec2(0.0, e)) - n);
  vec2 b = p * 7.9 + D1 * uTime * 0.62;
  n = vnoise2(b);
  g += vec2(vnoise2(b + vec2(e, 0.0)) - n, vnoise2(b + vec2(0.0, e)) - n) * 0.55 * lod;
  // L'octave fine est la premiere a aliaser : des qu'un pixel couvre plusieurs
  // periodes, elle se transforme en tapis d'ecailles scintillantes. On
  // l'eteint donc avec la distance plutot que de la laisser bruiter.
  vec2 c = p * 19.3 + D2 * uTime * 0.95;
  n = vnoise2(c);
  g += vec2(vnoise2(c + vec2(e, 0.0)) - n, vnoise2(c + vec2(0.0, e)) - n) * 0.28 * lod * lod;
  return normalize(vec3(-g.x * amp, 1.0, -g.y * amp));
}

float sceneDepthToViewZ(float depth) {
  return (uCameraNear * uCameraFar) /
    ((uCameraFar - uCameraNear) * depth - uCameraFar);
}

/**
 * Petit ray-march screen-space dans la capture deja payee pour la refraction.
 * Il ne remplace pas le ciel analytique : il ajoute seulement les silhouettes
 * visibles du chateau et des rochers quand le rayon les rencontre vraiment.
 */
vec3 traceScreenReflection(vec3 worldOrigin, vec3 worldDir, out float hitMask) {
  vec3 origin = (viewMatrix * vec4(worldOrigin, 1.0)).xyz;
  vec3 dir = normalize((viewMatrix * vec4(worldDir, 0.0)).xyz);
  vec3 hitColor = vec3(0.0);
  hitMask = 0.0;
  for (int i = 1; i <= 6; i++) {
    float fi = float(i);
    float t = 0.10 + fi * fi * 0.12;
    vec3 q = origin + dir * t;
    if (q.z > -uCameraNear) break;
    vec4 clip = uCameraProjection * vec4(q, 1.0);
    vec2 uv = clip.xy / max(clip.w, 1e-5) * 0.5 + 0.5;
    if (uv.x <= uSceneTexel.x || uv.x >= 1.0 - uSceneTexel.x ||
        uv.y <= uSceneTexel.y || uv.y >= 1.0 - uSceneTexel.y) break;
    float depth = texture2D(uSceneDepth, uv).r;
    if (depth >= 0.9999) continue;
    float sceneZ = sceneDepthToViewZ(depth);
    // Positif : le rayon vient de passer derriere la premiere surface opaque.
    float crossing = sceneZ - q.z;
    float thickness = 0.10 + t * 0.035;
    if (crossing >= 0.0 && crossing < thickness) {
      float edge = min(min(uv.x, 1.0 - uv.x), min(uv.y, 1.0 - uv.y));
      hitMask = smoothstep(0.015, 0.09, edge);
      hitColor = texture2D(uSceneColor, uv).rgb;
      break;
    }
  }
  return hitColor;
}

void main() {
  float d = vDepth;
  if (d < 0.0016) discard;

  // --- normale ------------------------------------------------------------
  // Le detail s'attenue en eau tres peu profonde : une nappe de 5 mm sur le
  // sable est lisse, elle ne peut pas porter de vaguelettes.
  float open = smoothstep(0.01, 0.16, d);
  float camDist = length(cameraPosition - vWorldPos);
  float lod = clamp(1.0 - (camDist - 2.5) / 9.0, 0.12, 1.0);

  // --- ecoulement ----------------------------------------------------------
  // Flow map : la vitesse de la nappe fait defiler l'ecume et le grain de la
  // surface. Deux phases decalees d'une demi-periode et fondues l'une dans
  // l'autre (le « double defilement » classique) : le motif suit le courant
  // sans jamais s'etirer jusqu'a se dechirer.
  vec2 flow = texture2D(uFlow, vFieldUv).rg;
  float flowLen = length(flow);
  float ph1 = fract(uTime * 0.5);
  float ph2 = fract(uTime * 0.5 + 0.5);
  float phw = abs(2.0 * ph1 - 1.0);
  vec2 adv1 = vWorldPos.xz - flow * (ph1 - 0.5) * 1.4;
  vec2 adv2 = vWorldPos.xz - flow * (ph2 - 0.5) * 1.4;

  // Amplitude MODESTE. Le gradient de bruit vaut deja ~0.1 ; multiplie par 26
  // il inclinait la normale de 75 degres et la mer se couvrait de grosses
  // taches blanches la ou ces facettes attrapaient le soleil.
  float dnAmp = (1.15 + 2.1 * uChop) * open;
  vec3 dn = normalize(mix(detailNormal(adv1, dnAmp, lod), detailNormal(adv2, dnAmp, lod), phw));
  vec3 N = normalize(vec3(vSurfNormal.x + dn.x, vSurfNormal.y, vSurfNormal.z + dn.z));
  vec3 V = normalize(cameraPosition - vWorldPos);
  float ndv = clamp(dot(N, V), 0.0, 1.0);
  float sunUp = clamp(uSunDir.y, 0.0, 1.0);

  // --- couleur par profondeur ---------------------------------------------
  // Absorption de Beer-Lambert : le rouge part en quelques dizaines de
  // centimetres, d'ou le turquoise des hauts-fonds sur fond de sable clair.
  // Le chemin de secours garde une couleur analytique. Quand la capture du
  // decor est active, le vrai rayon refracte la remplace plus bas.
  vec3 SIGMA = vec3(2.10, 0.30, 0.20);
  vec3 trans = exp(-SIGMA * d * 2.1);
  vec3 col = mix(uDeep, uShallow, trans);
  col = mix(col, vec3(0.62, 0.55, 0.42), clamp(vSed * 45.0, 0.0, 0.65));

  // --- ecume ---------------------------------------------------------------
  // Elle nait de la TURBULENCE, pas de la faible profondeur : sinon toutes les
  // douves immobiles se bordent de blanc, ce qui est faux et tres laid. La
  // lame mince du bord porte en revanche plus d'ecume a quantite egale : elle
  // s'y concentre en une ligne, comme la frange d'un jet de rive.
  float edge = 1.0 - smoothstep(0.004, 0.06, d);
  // La crete qui deferle blanchit d'elle-meme, avant meme que l'ecume
  // transportee n'arrive : c'est la levre du rouleau.
  float foamAmount = vFoam * (0.55 + 1.9 * edge) + vBrk * vBrk * 0.45;
  // Les trainees d'ecume s'etirent dans le sens du courant : on comprime la
  // coordonnee de la dentelle le long de l'ecoulement.
  vec2 fdir = flowLen > 1e-4 ? flow / flowLen : vec2(1.0, 0.0);
  float stretch = smoothstep(0.05, 0.45, flowLen) * 0.55;
  vec2 f1 = adv1 - fdir * dot(adv1, fdir) * stretch;
  vec2 f2 = adv2 - fdir * dot(adv2, fdir) * stretch;
  float foam = mix(wc_foamLace(f1, uTime, foamAmount, lod),
                   wc_foamLace(f2, uTime, foamAmount, lod), phw);
  // Sous la dentelle, l'eau chargee de bulles est laiteuse : une seconde
  // couche, diffuse, qui donne de l'epaisseur au rouleau.
  float milk = smoothstep(0.10, 0.75, foamAmount) * (0.35 + 0.25 * vnoise2(adv1 * 6.0 - uTime * 0.2));

  // --- eclairage -----------------------------------------------------------
  // Fresnel de Schlick, F0 = 2 % : l'eau vue de face est presque entierement
  // transmission, vue en rasant presque entierement reflet. C'est ce contraste
  // qui fait le miroir du large et la transparence du bord.
  float fres = 0.02 + 0.98 * pow(1.0 - ndv, 5.0);

  vec3 R = reflect(-V, N);
  // IOR eau/air = 1,333. On projette la difference entre rayon incident et
  // rayon transmis dans l'ecran, puis on echantillonne la vraie scene rendue
  // sans l'eau. Le sable, les murs et les objets sont donc réellement devies.
  vec3 T = refract(-V, N, 0.7502);
  vec3 sky = mix(uSkyHorizon, uSkyZenith, pow(clamp(R.y, 0.0, 1.0), 0.45));
  sky += uSunColor * pow(max(dot(R, uSunDir), 0.0), 32.0) * 0.5;
  vec3 reflectedLight = sky;
  if (uScreenReflections > 0.5 && fres > 0.035) {
    float reflectionHit;
    vec3 sceneReflection = traceScreenReflection(vWorldPos + N * 0.012, R, reflectionHit);
    reflectedLight = mix(sky, sceneReflection, reflectionHit * 0.82);
  }

  if (uRefractionEnabled > 0.5) {
    vec2 screenUv = vClipPosition.xy / max(vClipPosition.w, 1e-5) * 0.5 + 0.5;
    vec3 incidentView = (viewMatrix * vec4(-V, 0.0)).xyz;
    vec3 transmitView = (viewMatrix * vec4(T, 0.0)).xyz;
    vec2 incidentSlope = incidentView.xy / max(abs(incidentView.z), 0.25);
    vec2 transmitSlope = transmitView.xy / max(abs(transmitView.z), 0.25);
    float rayLength = min(d / max(abs(T.y), 0.28), 2.5);
    vec2 refractOffset = (transmitSlope - incidentSlope)
                       * rayLength * (0.018 + 0.012 * open);
    // Garde une marge d'un texel pour que le filtrage ne lise jamais hors du
    // framebuffer a la limite de l'ecran.
    vec2 refractUv = clamp(screenUv + refractOffset,
                           uSceneTexel, 1.0 - uSceneTexel);
    // Une refraction screen-space ne doit jamais aspirer la couleur d'un mur
    // situe DEVANT l'eau. La profondeur de la capture permet de rejeter cet
    // echantillon et de retomber sur le rayon non devie, qui est forcement
    // derriere la surface puisque le depth-test a laisse passer ce fragment.
    float surfaceDepth = vClipPosition.z / max(vClipPosition.w, 1e-5) * 0.5 + 0.5;
    float refractedDepth = texture2D(uSceneDepth, refractUv).r;
    float behindSurface = step(surfaceDepth - 0.00035, refractedDepth);
    vec3 sceneStraight = texture2D(uSceneColor,
      clamp(screenUv, uSceneTexel, 1.0 - uSceneTexel)).rgb;
    vec3 sceneBent = texture2D(uSceneColor, refractUv).rgb;
    vec3 sceneThroughWater = mix(sceneStraight, sceneBent, behindSurface);
    // Diffusion volumique, en plus de l'absorption : l'eau d'une plage n'est
    // pas de l'eau distillee, bulles et sable en suspension renvoient une part
    // de la lumiere avant le fond. Sans ce terme, le fond se voyait a 95 %
    // sous 10 cm d'eau et l'ombre d'un tas de sable sur le fond se lisait
    // comme un trou noir dans l'eau. Le fond reste visible (75 % a 10 cm),
    // mais l'eau ajoute sa propre lumiere turquoise par-dessus, ombre ou pas.
    const float SCAT = 1.2;
    vec3 pathTrans = exp(-(SIGMA + vec3(SCAT)) * rayLength * 1.35);
    float scatFrac = 1.0 - exp(-SCAT * rayLength * 1.35);
    // La diffusion est ce qui rend le lagon LUMINEUX : la lumiere du soleil
    // entre, se disperse et ressort teintee. Elle depend du soleil, pas
    // seulement de la profondeur — une mer au crepuscule est sombre.
    vec3 inscatter = mix(uShallow, uDeep, 1.0 - exp(-d * 1.8))
                   * max(1.0 - pathTrans, vec3(scatFrac)) * (0.42 + 0.34 * sunUp);
    col = sceneThroughWater * pathTrans + inscatter;
    col = mix(col, vec3(0.62, 0.55, 0.42), clamp(vSed * 45.0, 0.0, 0.65));
  } else {
    vec3 refracted = mix(uDeep, uShallow, clamp(T.y * 0.5 + 0.5, 0.0, 1.0));
    col = mix(col, refracted, (1.0 - fres) * 0.10 * open);
  }
  // Composition physique : transmission x (1 - F) + reflet x F.
  col = mix(col, reflectedLight, fres);

  // Levre du rouleau : la face avant d'une vague qui deferle est eclairee
  // par transparence, de ce vert d'eau qui signe la vague qui s'abat.
  float front = clamp(dot(vec2(N.x, N.z), vFlowDir) * 3.0, 0.0, 1.0);
  col += vec3(0.30, 0.70, 0.55) * vBrk * front * 0.55;

  // Eau laiteuse sous le rouleau, puis la dentelle par-dessus : l'ecume est a
  // la surface, elle masque transmission et reflet au lieu d'etre recoloree
  // par eux.
  float foamLight = 0.72 + 0.28 * max(dot(N, uSunDir), 0.0);
  col = mix(col, vec3(0.80, 0.90, 0.92) * foamLight, milk * (1.0 - foam));
  col = mix(col, vec3(0.96, 0.98, 0.98) * foamLight, foam);

  // Speculaire serre + scintillement large : c'est ce qui donne le plein
  // soleil sur l'eau. Le scintillement est module par le bruit fin, donc il
  // petille au lieu de faire une tache.
  vec3 H = normalize(uSunDir + V);
  float ndh = max(dot(N, H), 0.0);
  float sparkle = 0.5 + 0.5 * vnoise2(vWorldPos.xz * 41.0 + vec2(uTime * 1.3, -uTime * 0.9));
  col += uSunColor * pow(ndh, 260.0) * 1.7 * (1.0 - foam * 0.7);
  col += uSunColor * pow(ndh, 48.0) * 0.16 * open * sparkle * lod;
  // La lame mince du jet de rive est un film brillant sur le sable mouille.
  col += uSunColor * pow(ndh, 70.0) * 0.10 * (1.0 - open);

  col *= 0.82 + 0.28 * max(dot(N, uSunDir), 0.0);

  // --- opacite -------------------------------------------------------------
  // La capture contient deja le decor transmis : elle doit donc etre composee
  // opaque une seule fois. Le chemin leger sans capture conserve l'ancien
  // alpha et laisse le framebuffer montrer directement le fond.
  float alpha = 0.10 + 0.34 * (1.0 - exp(-d * 1.6));
  alpha = mix(alpha, 1.0, max(fres * 0.85, foam));
  alpha = mix(alpha, 1.0, step(0.5, uRefractionEnabled));
  alpha = clamp(alpha, 0.0, 1.0);

  gl_FragColor = vec4(col, alpha);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

/**
 * Gouttes : petites spheres d'eau instanciees pour l'eau en vol. Fresnel,
 * reflet de ciel, speculaire du soleil, et blanchiment par l'ecume portee.
 */
const DROP_VERT = /* glsl */ `
attribute vec3 aPos;
attribute float aVis;
attribute float aFoam;

varying vec3 vN;
varying vec3 vW;
varying float vVis;
varying float vFoam;

void main() {
  // La taille physique de la goutte (60 mL), a peine gonflee quand elle est
  // pleinement visible : un filet de gouttes se lit comme un filet.
  float s = ${F(DROPLET_RADIUS)} * (0.80 + 0.20 * aVis);
  vec3 p = aPos + normal * s;
  vN = normal;
  vW = p;
  vVis = aVis;
  vFoam = aFoam;
  gl_Position = projectionMatrix * viewMatrix * vec4(p, 1.0);
}
`;

const DROP_FRAG = /* glsl */ `
uniform vec3 uSunDir;
uniform vec3 uSunColor;
uniform vec3 uShallow;
uniform vec3 uDeep;
uniform vec3 uSkyZenith;
uniform vec3 uSkyHorizon;

varying vec3 vN;
varying vec3 vW;
varying float vVis;
varying float vFoam;

void main() {
  if (vVis < 0.02) discard;
  vec3 N = normalize(vN);
  vec3 V = normalize(cameraPosition - vW);
  float ndv = max(dot(N, V), 0.0);
  float fres = 0.03 + 0.97 * pow(1.0 - ndv, 5.0);
  vec3 R = reflect(-V, N);
  vec3 sky = mix(uSkyHorizon, uSkyZenith, pow(clamp(R.y, 0.0, 1.0), 0.45));
  float ndl = max(dot(N, uSunDir), 0.0);
  // Corps de la goutte : l'eau claire des hauts-fonds, eclairee par le soleil
  // et par le ciel (les gouttes sont fines, la lumiere les traverse).
  vec3 body = mix(uShallow, uDeep, 0.30) * (0.55 + 0.45 * ndl) + uSkyZenith * 0.10;
  vec3 col = mix(body, sky, fres);
  vec3 H = normalize(uSunDir + V);
  col += uSunColor * pow(max(dot(N, H), 0.0), 120.0) * 1.3;
  float foam = clamp(vFoam * 1.4, 0.0, 1.0);
  vec3 foamCol = vec3(0.95, 0.97, 0.98) * (0.72 + 0.28 * ndl);
  col = mix(col, foamCol, foam);
  float alpha = (0.58 + 0.42 * fres) * vVis;
  alpha = mix(alpha, vVis, foam);
  gl_FragColor = vec4(col, alpha);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

export class WaterRenderer {
  /**
   * @param {THREE.Scene} scene
   * @param {import('../sim/Water.js').Water} water
   * @param {import('../sim/VoxelField.js').VoxelField} field
   */
  constructor(scene, water, field, renderer = null) {
    this.scene = scene;
    this.water = water;
    this.field = field;

    this.data = new Float32Array(NX * NZ * 4);
    /**
     * Altitude de la surface libre utilisee POUR LE RENDU.
     *
     * Ce n'est pas tout a fait celle de la simulation. Une cellule seche n'a
     * pas de niveau d'eau : y stocker l'altitude du terrain fait grimper les
     * sommets du plan d'eau le long de la plage, et comme une cellule sur deux
     * est mouillee pres de la laisse, le maillage se herisse de dents de scie
     * qui semblent remonter sur le sable.
     *
     * On DILATE donc le niveau des cellules mouillees dans leurs voisines
     * seches : la nappe reste plate au passage de la ligne d'eau, et c'est la
     * profondeur — nulle sur ces cellules — qui les fait disparaitre au
     * fragment.
     */
    this.renderLevel = new Float32Array(NX * NZ);
    this.levelTmp = new Float32Array(NX * NZ);
    /**
     * Vaut 1 quand `renderLevel` vient d'une cellule mouillee (directement ou
     * par dilatation), 0 quand il ne s'agit que du niveau invisible conserve
     * pour une cellule seche. Ce masque permet de caler instantanement un
     * sommet avant que sa profondeur lissee ne le rende visible.
     */
    this.renderLevelValid = new Uint8Array(NX * NZ);
    /**
     * `data` est LISSE dans le temps (EMA) au lieu de recopier l'etat brut.
     *
     * Le solveur travaille par sous-pas et les cellules de la laisse alternent
     * mouille/sec d'une frame a l'autre : recopier l'etat brut fait CLIGNOTER
     * l'eau et l'ecume a la frequence de la simulation. Le document de refonte
     * prescrit un lissage temporel du champ destine au rendu (tau = 0,22 s
     * pour ce qui est lent a l'oeil — ecume, sediment) ; pour le niveau et la
     * profondeur on prend un tau court (0,07 s) : assez long pour eteindre
     * l'alternance a 60 Hz (attenuee ~25x), assez court pour ne coter que 3 %
     * de l'amplitude d'une vague de periode 2 s. `_primed` évite la rampe de
     * demarrage depuis zero.
     */
    this._primed = false;
    /**
     * Cadence du champ envoye au GPU. La simulation ne reconstruit la nappe
     * qu'a 15 Hz ; lisser et televerser 1,6 Mo de texture a 60 Hz coutait
     * une milliseconde par frame pour rien de visible. Le jeu regle 30 Hz ;
     * 60 Hz reste la valeur par defaut (tests, outils) pour que chaque appel
     * a update() soit pris en compte.
     */
    this.fieldHz = 60;
    this._fieldAcc = 0;
    this.tex = new THREE.DataTexture(this.data, NX, NZ, THREE.RGBAFormat, THREE.FloatType);
    this.tex.magFilter = THREE.LinearFilter;
    this.tex.minFilter = THREE.LinearFilter;
    this.tex.wrapS = this.tex.wrapT = THREE.ClampToEdgeWrapping;
    this.tex.needsUpdate = true;
    /**
     * Flow map : vitesse de l'ecoulement (RG, m/s), lissee comme l'ecume, et
     * indicateur de deferlement (B) pour la crete qui se cambre.
     */
    this.flow = new Float32Array(NX * NZ * 4);
    this.flowTex = new THREE.DataTexture(this.flow, NX, NZ, THREE.RGBAFormat, THREE.FloatType);
    this.flowTex.magFilter = THREE.LinearFilter;
    this.flowTex.minFilter = THREE.LinearFilter;
    this.flowTex.wrapS = this.flowTex.wrapT = THREE.ClampToEdgeWrapping;
    this.flowTex.needsUpdate = true;

    // Capture basse resolution du decor SANS eau. Le shader la traverse avec
    // le rayon refracte ; contrairement a une simple transparence alpha, les
    // contours du sable et du chateau se courbent vraiment sous la surface.
    // Le format RGBA8 suffit (la capture reste lineaire) et limite fortement
    // bande passante et memoire sur les GPU integres.
    const refractionDepth = new THREE.DepthTexture(1, 1, THREE.UnsignedIntType);
    refractionDepth.name = 'waterRefractionDepth';
    this.refractionTarget = new THREE.WebGLRenderTarget(1, 1, {
      format: THREE.RGBAFormat,
      type: THREE.UnsignedByteType,
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      depthBuffer: true,
      depthTexture: refractionDepth,
      stencilBuffer: false,
    });
    this.refractionTarget.texture.name = 'waterRefractionScene';
    this.refractionTarget.texture.colorSpace = THREE.LinearSRGBColorSpace;
    this.refractionQuality = 0;
    this.refractionCadence = 1;
    this._refractionFrame = 0;
    this._hasRefractionFrame = false;
    this._refractionCaptureUniforms = [];

    this.uniforms = {
      uField: { value: this.tex },
      uFlow: { value: this.flowTex },
      uTexel: { value: new THREE.Vector2(1 / NX, 1 / NZ) },
      uTime: { value: 0 },
      uSunDir: { value: new THREE.Vector3(0.4, 0.8, 0.35) },
      uSunColor: { value: new THREE.Color(1, 0.95, 0.85) },
      // Palette de lagon : le turquoise vient de l'absorption du rouge sur un
      // fond de sable BLANC qui renvoie tout le reste. Un fond sombre
      // donnerait le meme bleu terne quelle que soit la couleur choisie. Le
      // large, lui, tire vers un bleu profond et sature : c'est le contraste
      // entre les deux qui rend le lagon vibrant.
      uShallow: { value: new THREE.Color(0x4fe6d2).convertSRGBToLinear() },
      uDeep: { value: new THREE.Color(0x0b5a9c).convertSRGBToLinear() },
      uSkyZenith: { value: new THREE.Color(0x2f6fc4) },
      uSkyHorizon: { value: new THREE.Color(0xbfd8ea) },
      /** Agitation de la mer, 0..1 : pilote l'amplitude des vaguelettes. */
      uChop: { value: 0.35 },
      uSceneColor: { value: this.refractionTarget.texture },
      uSceneDepth: { value: this.refractionTarget.depthTexture },
      uSceneTexel: { value: new THREE.Vector2(1, 1) },
      uRefractionEnabled: { value: 0 },
      uScreenReflections: { value: 0 },
      uCameraProjection: { value: new THREE.Matrix4() },
      uCameraNear: { value: 0.05 },
      uCameraFar: { value: 120 },
    };

    const geo = new THREE.PlaneGeometry(WORLD_W, WORLD_D, NX - 1, NZ - 1);
    geo.rotateX(-Math.PI / 2);

    this.material = new THREE.ShaderMaterial({
      uniforms: this.uniforms,
      vertexShader: VERT,
      fragmentShader: FRAG,
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
    });

    this.mesh = new THREE.Mesh(geo, this.material);
    this.mesh.name = 'waterSurface';
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 10;
    scene.add(this.mesh);

    // La jupe : le volume d'eau vu par la tranche, au bord du diorama. Sans
    // elle, la surface flotte dans le vide des qu'on baisse la camera.
    this.volume = new WaterVolume(scene, this.uniforms);

    // Les gouttes : l'eau en vol, rendue comme de petites spheres d'eau.
    const dropGeo = new THREE.InstancedBufferGeometry();
    const sphere = new THREE.SphereGeometry(1, 8, 6);
    dropGeo.setAttribute('position', sphere.getAttribute('position'));
    dropGeo.setAttribute('normal', sphere.getAttribute('normal'));
    dropGeo.setIndex(sphere.getIndex());
    this._dropPos = new THREE.InstancedBufferAttribute(new Float32Array(DROPLET_MAX * 3), 3);
    this._dropVis = new THREE.InstancedBufferAttribute(new Float32Array(DROPLET_MAX), 1);
    this._dropFoam = new THREE.InstancedBufferAttribute(new Float32Array(DROPLET_MAX), 1);
    this._dropPos.setUsage(THREE.DynamicDrawUsage);
    this._dropVis.setUsage(THREE.DynamicDrawUsage);
    this._dropFoam.setUsage(THREE.DynamicDrawUsage);
    dropGeo.setAttribute('aPos', this._dropPos);
    dropGeo.setAttribute('aVis', this._dropVis);
    dropGeo.setAttribute('aFoam', this._dropFoam);
    dropGeo.instanceCount = 0;
    dropGeo.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 1, 0), 12);
    this.dropletMaterial = new THREE.ShaderMaterial({
      uniforms: {
        uSunDir: this.uniforms.uSunDir,
        uSunColor: this.uniforms.uSunColor,
        uShallow: this.uniforms.uShallow,
        uDeep: this.uniforms.uDeep,
        uSkyZenith: this.uniforms.uSkyZenith,
        uSkyHorizon: this.uniforms.uSkyHorizon,
      },
      vertexShader: DROP_VERT,
      fragmentShader: DROP_FRAG,
      transparent: true,
      depthWrite: false,
    });
    this.droplets = new THREE.Mesh(dropGeo, this.dropletMaterial);
    this.droplets.name = 'waterDroplets';
    this.droplets.frustumCulled = false;
    this.droplets.renderOrder = 11;
    scene.add(this.droplets);
    this._dropletRevision = -1;

    if (renderer) {
      const size = renderer.getSize(new THREE.Vector2());
      this.setRefractionQuality(2);
      this.resize(size.x, size.y, renderer.getPixelRatio());
    }
  }

  /**
   * Regle le cout de la vraie refraction. En qualite moyenne la capture est
   * plus petite et renouvelee une frame sur deux ; en qualite basse elle est
   * coupee. La physique et la surface restent identiques.
   */
  setRefractionQuality(level) {
    this.refractionQuality = Math.max(0, Math.min(2, level | 0));
    this.refractionCadence = this.refractionQuality === 1 ? 2 : 1;
    this.uniforms.uRefractionEnabled.value = this.refractionQuality >= 1 ? 1 : 0;
    this.uniforms.uScreenReflections.value = this.refractionQuality >= 2 ? 1 : 0;
  }

  /**
   * Enregistre le drapeau d'un materiau qui applique deja l'absorption de
   * l'eau. Il sera neutralise pendant la capture pour ne pas compter deux fois
   * Beer-Lambert ; ses caustiques, elles, restent dans l'image du fond.
   */
  registerRefractionCaptureUniform(uniform) {
    if (uniform && !this._refractionCaptureUniforms.includes(uniform)) {
      this._refractionCaptureUniforms.push(uniform);
    }
  }

  /** Dimensionne la capture, plafonnee a 1,35 Mpix meme sur un ecran 4K. */
  resize(width, height, pixelRatio = 1) {
    if (this.refractionQuality < 1) {
      this.refractionTarget.setSize(1, 1);
      this.refractionTarget.depthTexture.image.width = 1;
      this.refractionTarget.depthTexture.image.height = 1;
      this.uniforms.uSceneTexel.value.set(1, 1);
      this._hasRefractionFrame = false;
      return;
    }
    const scale = this.refractionQuality >= 2 ? 0.45 : 0.32;
    let w = Math.max(1, Math.round(width * pixelRatio * scale));
    let h = Math.max(1, Math.round(height * pixelRatio * scale));
    const maxPixels = 1_350_000;
    if (w * h > maxPixels) {
      const k = Math.sqrt(maxPixels / (w * h));
      w = Math.max(1, Math.round(w * k));
      h = Math.max(1, Math.round(h * k));
    }
    this.refractionTarget.setSize(w, h);
    this.refractionTarget.depthTexture.image.width = w;
    this.refractionTarget.depthTexture.image.height = h;
    this.uniforms.uSceneTexel.value.set(1 / w, 1 / h);
    this._hasRefractionFrame = false;
  }

  /**
   * Rend le decor opaque dans la texture traversee par l'eau. Cette methode ne
   * cree aucun canvas ni navigateur : c'est une passe WebGL dans le renderer
   * deja utilise par le jeu.
   */
  captureRefraction(renderer, camera) {
    if (this.refractionQuality < 1 || !renderer || !camera) return;
    this._refractionFrame++;
    if (this._hasRefractionFrame &&
        (this._refractionFrame - 1) % this.refractionCadence !== 0) return;

    const oldTarget = renderer.getRenderTarget();
    const surfaceVisible = this.mesh.visible;
    const volumeVisible = this.volume.mesh.visible;
    const dropletsVisible = this.droplets.visible;
    const xrEnabled = renderer.xr.enabled;
    const captureValues = this._refractionCaptureUniforms.map((u) => u.value);
    this.mesh.visible = false;
    this.volume.mesh.visible = false;
    this.droplets.visible = false;
    for (const u of this._refractionCaptureUniforms) u.value = 1;
    this.uniforms.uCameraProjection.value.copy(camera.projectionMatrix);
    this.uniforms.uCameraNear.value = camera.near;
    this.uniforms.uCameraFar.value = camera.far;
    try {
      renderer.xr.enabled = false;
      renderer.setRenderTarget(this.refractionTarget);
      renderer.clear();
      renderer.render(this.scene, camera);
      this._hasRefractionFrame = true;
    } finally {
      renderer.setRenderTarget(oldTarget);
      renderer.xr.enabled = xrEnabled;
      this.mesh.visible = surfaceVisible;
      this.volume.mesh.visible = volumeVisible;
      this.droplets.visible = dropletsVisible;
      for (let i = 0; i < this._refractionCaptureUniforms.length; i++) {
        this._refractionCaptureUniforms[i].value = captureValues[i];
      }
    }
  }

  /**
   * Dilate le niveau de la surface libre dans les cellules seches voisines.
   * Deux passes suffisent : un triangle du plan d'eau ne couvre qu'une cellule.
   */
  buildRenderLevel() {
    const w = this.water;
    const surf = this.field.surfaceH;
    const h = w.h;
    const lvl = this.renderLevel;
    const tmp = this.levelTmp;
    const valid = this.renderLevelValid;
    const n = NX * NZ;

    for (let c = 0; c < n; c++) {
      const wet = h[c] > WATER_EPSILON;
      lvl[c] = wet ? surf[c] + h[c] : -1e9;
      valid[c] = wet ? 1 : 0;
    }
    // La dilatation prend le niveau du voisin mouille LE PLUS BAS, pas le plus
    // haut. Deux plans d'eau peuvent se cotoyer a des niveaux tres differents
    // — la mer a 1,15 m et, deux cellules plus loin, la nappe au fond d'une
    // fosse a 0,75 m. Avec un max, la cellule seche du rebord adoptait le
    // niveau de la MER : le plan d'eau se tendait par-dessus la paroi et le
    // shader du sable (qui compare `wf.r` a son altitude) peignait « sous
    // l'eau » tout le flanc de la fosse — des plaques turquoise a mi-hauteur
    // des parois, qui clignotaient au rythme du jet de rive (mesure : 29
    // frames sur 60). Avec un min, le raccord entre les deux plans passe A
    // L'INTERIEUR du massif de sable, donc il est invisible ; et au bord de
    // mer ordinaire, ou tous les voisins mouilles sont au meme niveau a
    // quelques millimetres pres, min et max sont equivalents.
    for (let pass = 0; pass < 2; pass++) {
      tmp.set(lvl);
      for (let z = 0; z < NZ; z++) {
        const row = NX * z;
        for (let x = 0; x < NX; x++) {
          const c = row + x;
          if (tmp[c] > -1e8) continue; // deja mouillee
          let best = 1e9;
          if (x > 0 && tmp[c - 1] > -1e8 && tmp[c - 1] < best) best = tmp[c - 1];
          if (x + 1 < NX && tmp[c + 1] > -1e8 && tmp[c + 1] < best) best = tmp[c + 1];
          if (z > 0 && tmp[c - NX] > -1e8 && tmp[c - NX] < best) best = tmp[c - NX];
          if (z + 1 < NZ && tmp[c + NX] > -1e8 && tmp[c + NX] < best) best = tmp[c + NX];
          if (best < 1e8) {
            lvl[c] = best;
            valid[c] = 1;
          }
        }
      }
    }
    // Une cellule seche peut rester visible quelques frames, le temps que la
    // profondeur EMA passe sous le seuil de discard. Il ne faut surtout pas
    // faire remonter son sommet vers `surf[c]` pendant ce delai : sur une
    // paroi ou un tas de sable, cela etirait la derniere pellicule d'eau en une
    // longue pointe verticale. On fige donc son dernier niveau rendu. Au tout
    // premier frame, le niveau de la mer est un neutre sur et invisible.
    const initialDryLevel = Number.isFinite(w.seaLevel) ? w.seaLevel : 0;
    for (let c = 0; c < n; c++) {
      if (lvl[c] < -1e8) {
        lvl[c] = this._primed ? this.data[c * 4] : initialDryLevel;
        valid[c] = 0;
      }
    }
  }

  /**
   * La texture (niveau, profondeur, ecume, sediment) que les autres
   * materiaux (sable, decor immerge) doivent echantillonner : celle du GPU
   * quand il produit les champs fins, la notre sinon.
   */
  get fieldTexture() {
    const gpu = this.water.gpu;
    return this._gpuFields && gpu?.fieldTexture ? gpu.fieldTexture : this.tex;
  }

  /** Recopie l'etat de la simulation dans la texture. */
  update(dt, sunDir, sunColor, skyZenith, skyHorizon) {
    const w = this.water;
    this.uniforms.uTime.value += dt;
    if (sunDir) this.uniforms.uSunDir.value.copy(sunDir);
    if (sunColor) this.uniforms.uSunColor.value.copy(sunColor);
    if (skyZenith) this.uniforms.uSkyZenith.value.copy(skyZenith);
    if (skyHorizon) this.uniforms.uSkyHorizon.value.copy(skyHorizon);

    // Champs fins produits par le GPU, a chaque image : ils interpolent
    // entre les deux derniers pas du solveur, le rendu ne voit plus sa
    // cadence. Le CPU ne reconstruit ni ne televerse rien. Voir
    // WaterGPU.renderFine.
    const gpu = w.gpu;
    if (gpu && gpu.fineReady && gpu.renderFine(dt)) {
      this.uniforms.uField.value = gpu.fieldTexture;
      this.uniforms.uFlow.value = gpu.flowTexture;
      this._gpuFields = true;
      this._primed = true;
      this._fieldAcc = 0;
      this.syncParticles(w);
      return;
    }

    this._fieldAcc += dt;
    if (this._primed && this._fieldAcc < 1 / this.fieldHz - 1e-4) {
      this.syncParticles(w);
      return;
    }
    dt = this._fieldAcc;
    this._fieldAcc = 0;

    if (this._gpuFields) {
      // Retour au chemin CPU : on repart de l'etat exact, sans rampe.
      this._gpuFields = false;
      this._primed = false;
      this.uniforms.uField.value = this.tex;
      this.uniforms.uFlow.value = this.flowTex;
    }

    const data = this.data, flow = this.flow;
    const h = w.h, foam = w.foam, sed = w.sed;
    const vx = w.vx || null, vz = w.vz || null;
    const brk = w.brkFine || null;
    // La laisse d'ecume vit dans le canal B des cellules SECHES : le shader
    // de l'eau y fait `discard`, celui du sable la dessine.
    const foamDry = w.foamDry || null;
    const n = NX * NZ;
    this.buildRenderLevel();
    const lvl = this.renderLevel;
    if (!this._primed) {
      // Premiere frame (ou renderer tout neuf) : on part de l'etat exact,
      // sinon la mer met un tiers de seconde a « monter » depuis zero.
      for (let c = 0, o = 0; c < n; c++, o += 4) {
        data[o] = lvl[c];
        data[o + 1] = h[c];
        data[o + 2] = h[c] > WATER_EPSILON || !foamDry ? foam[c] : foamDry[c];
        data[o + 3] = sed[c];
        if (vx) { flow[c * 4] = vx[c]; flow[c * 4 + 1] = vz[c]; }
        flow[c * 4 + 2] = brk ? brk[c] : 0;
      }
      this._primed = true;
    } else {
      // Lissage temporel (voir le commentaire du constructeur). kL pour le
      // niveau et la profondeur, kS pour l'ecume et le sediment.
      const kL = 1 - Math.exp(-dt / 0.07);
      const kS = 1 - Math.exp(-dt / 0.22);
      const valid = this.renderLevelValid;
      for (let c = 0, o = 0; c < n; c++, o += 4) {
        // Quand une cellule (ou la couronne seche qui borde la nappe) devient
        // visible, son altitude doit etre correcte AVANT que sa profondeur ne
        // franchisse le seuil du shader. Lisser simultanement les deux ferait
        // apparaitre pendant 2-3 frames une aiguille reliant l'ancien niveau
        // invisible au nouveau plan d'eau.
        const wasVisible = data[o + 1] >= 0.0016;
        if (!wasVisible && valid[c]) data[o] = lvl[c];
        else data[o] += (lvl[c] - data[o]) * kL;
        data[o + 1] += (h[c] - data[o + 1]) * kL;
        const f = h[c] > WATER_EPSILON || !foamDry ? foam[c] : foamDry[c];
        data[o + 2] += (f - data[o + 2]) * kS;
        data[o + 3] += (sed[c] - data[o + 3]) * kS;
        if (vx) {
          flow[c * 4] += (vx[c] - flow[c * 4]) * kS;
          flow[c * 4 + 1] += (vz[c] - flow[c * 4 + 1]) * kS;
        }
        // Le deferlement est bref : il suit la cadence du niveau, pas celle
        // de l'ecume, sinon la crete se cambre apres la vague.
        flow[c * 4 + 2] += ((brk ? brk[c] : 0) - flow[c * 4 + 2]) * kL;
      }
    }
    this.tex.needsUpdate = true;
    this.flowTex.needsUpdate = true;
    this.syncParticles(w);
  }

  /** Les gouttes suivent la revision du solveur, pas la cadence du rendu. */
  syncParticles(w) {
    const d = w.droplets;
    if (d && (d.revision ?? -1) !== this._dropletRevision) {
      this.syncDroplets(d);
      this._dropletRevision = d.revision;
    }
  }

  /**
   * Recopie les gouttes en vol. Leur visibilite `vis` est tenue par le
   * solveur (une goutte nait en 40 ms) ; ici on ne fait que compacter celles
   * dont la visibilite n'est pas nulle.
   */
  syncDroplets(p) {
    const vis = p.vis, foam = p.foam;
    if (!vis) { this.droplets.geometry.instanceCount = 0; return; }
    const pos = this._dropPos.array, v = this._dropVis.array, f = this._dropFoam.array;
    const cnt = Math.min(p.count, DROPLET_MAX);
    let n = 0;
    for (let i = 0; i < cnt; i++) {
      const a = vis[i];
      if (a < 0.02) continue;
      pos[n * 3] = p.x[i]; pos[n * 3 + 1] = p.y[i]; pos[n * 3 + 2] = p.z[i];
      v[n] = a;
      f[n] = foam ? foam[i] : 0;
      n++;
    }
    this.droplets.geometry.instanceCount = n;
    if (n > 0) {
      this._dropPos.addUpdateRange(0, n * 3);
      this._dropVis.addUpdateRange(0, n);
      this._dropFoam.addUpdateRange(0, n);
      this._dropPos.needsUpdate = true;
      this._dropVis.needsUpdate = true;
      this._dropFoam.needsUpdate = true;
    }
  }

  /** Agitation de la mer (0 = mer d'huile, 1 = clapot marque). */
  setChop(v) {
    this.uniforms.uChop.value = Math.max(0, Math.min(1, v));
  }

  dispose() {
    this.volume.dispose();
    this.scene.remove(this.droplets);
    this.droplets.geometry.dispose();
    this.dropletMaterial.dispose();
    this.scene.remove(this.mesh);
    this.mesh.geometry.dispose();
    this.material.dispose();
    this.tex.dispose();
    this.flowTex.dispose();
    this.refractionTarget.dispose();
  }
}
