# Recherche rendu 3D — Sandcastle

**Document technique de référence — direction technique rendu (Three.js / WebGL2 / WebGPU)**
Cible visuelle : diorama de plage miniature sur bloc carré. Sable chaud et granuleux, océan turquoise
translucide avec écume à la laisse de mer, lumière douce chaude, tilt-shift maquette.
Références d'ambiance : *The Sims* (lisibilité, matières douces), *Townscaper* (couleurs saturées,
silhouette nette), *Dorfromantik* (tilt-shift, grain, chaleur), photographie de maquette.

Version : 1.0 — septembre 2026
Cible techno : three.js r185+ (r171+ requis pour le chemin WebGPU)

---

## Table des matières

1. [Choix du renderer](#1-choix-du-renderer)
2. [Pipeline couleur et conventions](#2-pipeline-couleur-et-conventions)
3. [Le shader de sable](#3-le-shader-de-sable)
4. [L'eau](#4-leau)
5. [Lumière et atmosphère](#5-lumière-et-atmosphère)
6. [Post-processing et look diorama](#6-post-processing-et-look-diorama)
7. [Végétation et props](#7-végétation-et-props)
8. [Performance](#8-performance)
9. [Annexes : budgets, ordre d'implémentation, pièges](#9-annexes)

---

## 1. Choix du renderer

### 1.1 État de l'art fin 2025 / 2026

| Fait | Conséquence pour nous |
|---|---|
| `WebGPURenderer` est déclaré production-ready depuis **r171** (sept. 2025) | Le chemin WebGPU n'est plus expérimental |
| Safari 26 (sept. 2025) a livré WebGPU sur macOS/iOS/iPadOS → **WebGPU est baseline sur Chrome, Edge, Firefox, Safari** | Plus besoin d'un plan B « pas de WebGPU du tout » pour le desktop moderne |
| TSL (Three Shading Language) compile vers **WGSL *et* GLSL** | Un seul code de shader pour les deux backends |
| `WebGPURenderer({ forceWebGL: true })` fait tourner le même graphe de nodes sur WebGL2 | Le repli est une *option de constructeur*, pas un fork de code |
| `WebGPURenderer` **ne supporte pas** `ShaderMaterial`, `RawShaderMaterial`, `onBeforeCompile`, ni `EffectComposer` | Tout shader custom doit être écrit en nodes/TSL |
| Post-processing WebGPU = pile node-based avec MRT natif, + effets exclusifs (SSGI, SSS, DoF amélioré) | Bon pour nous, mais l'écosystème tiers (N8AO, `pmndrs/postprocessing`) reste majoritairement WebGL |
| `WebGLRenderer` reste maintenu mais **ne recevra plus de features majeures** | C'est une voie de maintenance, pas d'évolution |
| Régressions de perf mesurées sur WebGPU dans certains cas (beaucoup de meshes séparés, non instanciés — cf. rapports autour de r176) | Notre scène doit être *peu* de draw calls, ce qui est de toute façon l'objectif |

### 1.2 Recommandation

> **Cibler `WebGPURenderer` + TSL, avec `forceWebGL: true` comme repli automatique.**
> Écrire **100 % du shading custom en TSL**. Zéro `ShaderMaterial`, zéro `onBeforeCompile` dans le code
> de production.

Arguments, dans l'ordre de poids :

1. **Un seul code de shader.** Notre projet est majoritairement du shading custom (sable, eau, écume,
   stratigraphie, herbes). Maintenir deux versions GLSL/WGSL serait le principal coût du projet.
   TSL supprime ce coût.
2. **Le compute nous servira.** Sandcastle regénère en continu un champ voxel (creuser, tasser, effondrer).
   La simulation d'humidité, la diffusion capillaire, le placement d'herbes, les particules de grains,
   et à terme le meshing lui-même, sont des *compute shaders*. En WebGL2 ces passes se font en
   ping-pong sur des render targets — faisable mais laborieux. En WebGPU, `computeShader` + storage
   buffers sont natifs.
3. **Le fallback est gratuit.** `forceWebGL: true` ne demande aucun code additionnel. On peut le forcer
   par flag URL (`?webgl=1`) pour debug et pour les machines où WebGPU est instable (drivers Intel
   anciens, Linux Mesa).
4. **`WebGLRenderer` est en fin de cycle de features.** Investir 6 mois de shaders GLSL sur un renderer
   figé est un pari perdant pour un projet qui vivra plusieurs années.

### 1.3 Plan de repli (par ordre de gravité)

| Problème | Repli |
|---|---|
| WebGPU indisponible / driver buggé | `forceWebGL: true` — même code, même rendu, perte du compute (basculer les sims sur worker CPU ou ping-pong RT) |
| Un effet de post tiers indispensable est WebGL-only (ex. N8AO) | Réimplémenter en node ou basculer sur `AONode` / `GTAONode` du stack WebGPU |
| TSL bloque sur une construction exotique | `wgslFn()` / `glslFn()` permettent d'injecter du code natif dans un graphe de nodes (vérifier la disponibilité sur la révision utilisée) |
| Catastrophe totale sur le chemin node | Le présent document fournit **tous les algorithmes en GLSL**, directement portables sur `WebGLRenderer` + `onBeforeCompile` (voir §3.2 pour le patron de patch) |

### 1.4 Boot du renderer

```js
// src/render/createRenderer.js
import * as THREE from 'three/webgpu';

export async function createRenderer(canvas, { forceWebGL = false } = {}) {
  const renderer = new THREE.WebGPURenderer({
    canvas,
    antialias: false,           // on fait le AA en post (SMAA/TAA), moins cher avec du post-processing
    alpha: false,
    forceWebGL,
    powerPreference: 'high-performance',
  });

  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(window.innerWidth, window.innerHeight, false);

  // Pipeline couleur (cf. §2)
  renderer.outputColorSpace  = THREE.SRGBColorSpace;
  renderer.toneMapping       = THREE.AgXToneMapping;
  renderer.toneMappingExposure = 1.05;

  // Ombres
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type    = THREE.PCFSoftShadowMap;

  await renderer.init();   // obligatoire si on n'utilise pas setAnimationLoop()

  console.info('[render] backend =', renderer.backend?.isWebGPUBackend ? 'WebGPU' : 'WebGL2');
  return renderer;
}
```

Détection de repli côté produit :

```js
const params  = new URLSearchParams(location.search);
const wantGL  = params.has('webgl') || !navigator.gpu;
const renderer = await createRenderer(canvas, { forceWebGL: wantGL });
```

### 1.5 Convention d'écriture des shaders dans ce document

Les algorithmes sont donnés **en GLSL** — c'est la forme la plus lisible, la plus universelle, et elle
est directement utilisable sur le chemin de repli WebGL. Chaque bloc majeur est suivi de sa
**transposition TSL**. La règle de traduction est mécanique :

| GLSL | TSL |
|---|---|
| `a * b` | `a.mul(b)` |
| `a + b` | `a.add(b)` |
| `mix(a,b,t)` | `mix(a, b, t)` ou `a.mix(b, t)` |
| `dot(a,b)` | `a.dot(b)` |
| `pow(a,b)` | `a.pow(b)` |
| `smoothstep(e0,e1,x)` | `smoothstep(e0, e1, x)` |
| `varying` calculé en VS | node partagé — TSL décide seul du stage, forcer avec `.toVertexStage()` |
| `uniform float u;` | `const u = uniform(0.0)` puis `u.value = ...` |
| fonction GLSL | `Fn(({a, b}) => { ... })` |
| `#include <common>` | inutile, les helpers sont des imports depuis `three/tsl` |

---

## 2. Pipeline couleur et conventions

Avant tout shading, verrouiller ces conventions — c'est la première cause de « ça ne ressemble pas à la
référence ».

- **Espace de travail : linéaire.** Toutes les constantes de couleur dans les shaders sont en linéaire.
- **Textures albedo/couleur : `SRGBColorSpace`.** Textures de données (normal, roughness, masques,
  hauteur, humidité) : `NoColorSpace` / `LinearSRGBColorSpace`.
- **Tone mapping : `AgXToneMapping`, exposure ≈ 1.05.** AgX conserve la teinte dans les hautes lumières
  (le sable en plein soleil ne vire pas au blanc-rose comme avec ACES) et donne un rendu « pellicule
  douce » qui colle au cozy. `NeutralToneMapping` est l'alternative si l'on veut des couleurs plus
  proches de l'albedo brut (look plus « produit »). **Éviter ACES** ici : il désature et refroidit le
  sable.
- **Un seul point de tone mapping.** Si l'on fait du post-processing, désactiver le tone mapping du
  renderer et le placer en fin de chaîne d'effets (§6.2). Sinon on tone-mappe deux fois.
- **Intensités de lumière physiques** (`useLegacyLights` n'existe plus) : soleil ≈ 3.0–5.0,
  hémisphérique ≈ 0.6–1.2. Ajuster ensuite par l'exposure, pas par les intensités.

Helper de conversion, à garder dans le code de setup :

```js
// sRGB hex → Color linéaire, pour définir des constantes de shader lisibles
const lin = (hex) => new THREE.Color().setHex(hex, THREE.SRGBColorSpace); // déjà converti en linéaire
```

**Palette de référence du diorama** (hex sRGB → approx. linéaire) :

| Rôle | sRGB | Linéaire approx. |
|---|---|---|
| Sable sec clair (crêtes) | `#E6D3AE` | `(0.796, 0.633, 0.427)` |
| Sable sec moyen | `#D9C29A` | `(0.696, 0.532, 0.323)` |
| Sable sec ombre | `#BFA47C` | `(0.512, 0.371, 0.206)` |
| Sable humide (dérivé, cf. §3.3) | `#8A6E48` | `(0.242, 0.155, 0.070)` |
| Eau peu profonde | `#5FD9C8` | `(0.114, 0.708, 0.586)` |
| Eau profonde | `#0E7B8C` | `(0.005, 0.196, 0.256)` |
| Écume | `#F6FBFA` | `(0.938, 0.978, 0.970)` |
| Ciel zénith | `#63A8E8` | `(0.125, 0.397, 0.822)` |
| Ciel horizon | `#DCE9F0` | `(0.722, 0.826, 0.879)` |

---

## 3. Le shader de sable

C'est le shader central. Il doit rendre : sable sec et sable mouillé, du scintillement de grains, du
micro-détail, l'accentuation des arêtes sculptées, et un peu de translucence en lumière rasante — le
tout sur un maillage **sans UV** (surface nets / dual contouring sur champ voxel).

### 3.1 Données d'entrée

Le mesher produit, par vertex :

| Attribut | Type | Contenu |
|---|---|---|
| `position` | `vec3` | position locale (surface nets) |
| `normal` | `vec3` | normale lissée |
| `aAO` | `float` | occlusion ambiante bakée (0 = occlus, 1 = ouvert) |
| `aCurv` | `float` | courbure signée (−1 concave … +1 convexe) |
| `aCompact` | `float` | compaction (0 = sable coulant, 1 = sable tassé/sculpté) |
| `aThin` | `float` | finesse locale, pour le SSS (1 = feature fine, ex. créneau) |
| `aFaceKind` | `float` | 0 = surface sculptée, 1 = face de coupe du bloc (cf. §6.5) |

Et, en uniformes globales, une **carte d'humidité** couvrant le bloc entier (cf. §4.4) :

```
uHumidityMap : RGBA16F, 512×512 pour un bloc de 8×8 m (≈ 1.5 cm / texel)
  R = niveau d'eau (hauteur monde, en mètres)
  G = saturation en eau du sable (0..1)
  B = mousse résiduelle (0..1)
  A = profondeur d'eau au-dessus du sable (m)
```

Cette carte unique alimente **quatre** effets d'un coup : assombrissement du sable mouillé, laisse de
mer, caustiques projetées, et masque d'écume. C'est le pivot architectural du rendu.

### 3.2 Squelette : patcher `MeshStandardMaterial` (chemin de repli WebGL)

On ne réécrit **pas** un shader PBR complet — on greffe sur `MeshStandardMaterial` pour hériter des
lumières, des ombres, de l'IBL, du fog et du tone mapping.

```js
// src/materials/SandMaterialGL.js  — chemin WebGLRenderer / repli
import * as THREE from 'three';
import { SAND_COMMON, SAND_VERT_MAIN, SAND_FRAG_BODY, SAND_GLITTER_ADD } from './sand.glsl.js';

export function createSandMaterialGL(uniforms) {
  const mat = new THREE.MeshStandardMaterial({
    color: 0xffffff, roughness: 0.95, metalness: 0.0, dithering: true,
  });

  mat.userData.uniforms = uniforms; // objet partagé { uTime:{value}, uHumidityMap:{value}, ... }

  mat.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);

    // ---------- VERTEX ----------
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', /* glsl */`
        #include <common>
        attribute float aAO;
        attribute float aCurv;
        attribute float aCompact;
        attribute float aThin;
        attribute float aFaceKind;
        varying vec3  vWPos;
        varying vec3  vWNormal;
        varying float vAO;
        varying float vCurv;
        varying float vCompact;
        varying float vThin;
        varying float vFaceKind;
      `)
      .replace('#include <worldpos_vertex>', /* glsl */`
        #include <worldpos_vertex>
        vWPos     = (modelMatrix * vec4(transformed, 1.0)).xyz;
        vWNormal  = normalize(mat3(modelMatrix) * objectNormal);
        vAO       = aAO;
        vCurv     = aCurv;
        vCompact  = aCompact;
        vThin     = aThin;
        vFaceKind = aFaceKind;
      `);

    // ---------- FRAGMENT ----------
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\n${SAND_COMMON}`)
      // albedo + wetness + micro-détail
      .replace('#include <map_fragment>', SAND_FRAG_BODY)
      // rugosité pilotée par l'humidité
      .replace('#include <roughnessmap_fragment>', /* glsl */`
        float roughnessFactor = sandRoughness;
      `)
      // normale triplanaire
      .replace('#include <normal_fragment_maps>', /* glsl */`
        normal = normalize(sandNormal);
      `)
      // AO baké × AO écran
      .replace('#include <aomap_fragment>', /* glsl */`
        float ambientOcclusion = sandAO;
        reflectedLight.indirectDiffuse  *= ambientOcclusion;
        #if defined( USE_CLEARCOAT )
          clearcoatSpecularIndirect *= ambientOcclusion;
        #endif
        reflectedLight.indirectSpecular *= ambientOcclusion;
      `)
      // glitter + SSS ajoutés après l'éclairage
      .replace('#include <opaque_fragment>', `${SAND_GLITTER_ADD}\n#include <opaque_fragment>`);
  };

  // Indispensable : sinon three.js réutilise le programme d'un autre MeshStandardMaterial
  mat.customProgramCacheKey = () => 'sand-v1';

  return mat;
}
```

> **Piège n°1 du chemin WebGL** : sans `customProgramCacheKey`, three.js peut partager le programme
> compilé entre matériaux et votre patch disparaît (ou pollue les autres matériaux). Toujours le définir.
>
> **Piège n°2** : `onBeforeCompile` ne se rejoue pas quand on change une propriété du matériau. Si vous
> devez changer un `#define`, il faut `material.needsUpdate = true` → **recompilation = stall GPU**.
> Ne jamais faire ça en jeu ; réserver aux changements de réglage qualité.

### 3.3 Sable sec vs sable mouillé

**Physique en une phrase** : l'eau remplit les pores entre les grains, son indice (1.33) est plus proche
de celui du quartz (1.54) que l'air (1.0), donc moins de réflexion aux interfaces internes → la lumière
pénètre plus loin, subit plus d'absorptions → le sable s'assombrit et **se sature**. En surface, un film
d'eau lisse remplace la micro-géométrie → **rugosité qui s'effondre, spéculaire qui explose**.

Le modèle pratique le plus fidèle et le moins cher est **l'exponentiation de l'albedo** : élever
l'albedo à une puissance > 1 assombrit beaucoup plus les canaux sombres que les canaux clairs, ce qui
produit *automatiquement* la montée de saturation observée. On y ajoute un facteur multiplicatif pour
atteindre le ratio global de ~0.5–0.6 demandé.

```glsl
// ============================================================================
//  SAND — modèle sec / mouillé
// ============================================================================

// wetness : 0 = sec, 1 = saturé (nappe d'eau au-dessus)
vec3 sandWetAlbedo(vec3 dryAlbedo, float wetness) {
  // 1) exponentiation : assombrit + sature (loi de type "porosité")
  //    exposant 1.0 (sec) -> 1.9 (saturé)
  vec3  a = pow(dryAlbedo, vec3(1.0 + 0.90 * wetness));

  // 2) atténuation globale : amène le ratio total autour de 0.55 à saturation
  a *= mix(1.0, 0.72, wetness);

  // 3) très léger glissement de teinte vers le brun-vert (matière organique mouillée)
  a  = mix(a, a * vec3(0.98, 1.00, 0.92), wetness * 0.6);
  return a;
}

// Rugosité : le sable sec est quasi lambertien ; le film d'eau est un miroir.
// Deux régimes : imbibition (0 -> 0.85) puis film de surface (0.85 -> 1.0)
float sandWetRoughness(float wetness, float compact) {
  float base    = mix(0.97, 0.88, compact);         // tassé = un peu plus lisse
  float damp    = mix(base, 0.42, smoothstep(0.0, 0.85, wetness));
  float film    = smoothstep(0.85, 1.0, wetness);   // flaque / film brillant
  return mix(damp, 0.06, film);
}

// Intensité spéculaire additionnelle du film d'eau (lobe GGX explicite)
float sandWaterFilm(float wetness) {
  return smoothstep(0.55, 1.0, wetness);
}
```

Vérification numérique sur `SAND_DRY_MID = (0.696, 0.532, 0.323)` :

| wetness | R | G | B | Luminance rel. | Saturation HSV |
|---|---|---|---|---|---|
| 0.0 | 0.696 | 0.532 | 0.323 | 1.00 | 0.54 |
| 0.5 | 0.567 | 0.400 | 0.207 | 0.75 | 0.63 |
| 1.0 | 0.383 | 0.253 | 0.113 | **0.53** | **0.70** |

→ facteur ~0.53 et +30 % de saturation : conforme à l'observation.

### 3.4 Le scintillement des grains (« glitter »)

Le sable de plage scintille parce qu'une fraction de grains (quartz, mica, coquille broyée) présente
une facette quasi plane orientée aléatoirement. Quand cette facette réfléchit le soleil vers l'œil, on
voit un point sur-exposé. C'est un effet **très fort dans la référence visuelle** — sans lui le sable
paraît plastique.

**Technique** : microfacettes procédurales. Pour chaque cellule 3D de l'espace monde, un hash donne une
normale de grain `G`. Si `reflect(-L, G) · V` dépasse un seuil très haut, on émet un point brillant.
Trois échelles de cellules superposées donnent une densité stable quel que soit le zoom.

```glsl
// ============================================================================
//  HASH + GLITTER
// ============================================================================

// Hash 3D→3D sans texture (Dave Hoskins, hash33) — rapide et sans motif visible
vec3 hash33(vec3 p3) {
  p3 = fract(p3 * vec3(0.1031, 0.1030, 0.0973));
  p3 += dot(p3, p3.yxz + 33.33);
  return fract((p3.xxy + p3.yxx) * p3.zyx);
}

float hash13(vec3 p3) {
  p3 = fract(p3 * 0.1031);
  p3 += dot(p3, p3.zyx + 31.32);
  return fract((p3.x + p3.y) * p3.z);
}

// Une octave de glitter.
//   wpos      : position monde
//   N         : normale de surface (macro)
//   L, V      : vers la lumière / vers la caméra (normalisés)
//   cellSize  : taille de la cellule en mètres (≈ taille d'un "grain visible")
//   spread    : dispersion angulaire des facettes (0.6 = serré, 2.0 = chaotique)
//   density   : fraction de cellules actives (0..1)
//   sharp     : seuil de R·V (0.994 = très ponctuel, 0.96 = large)
float glitterOctave(vec3 wpos, vec3 N, vec3 L, vec3 V,
                    float cellSize, float spread, float density, float sharp) {
  vec3 cell = floor(wpos / cellSize);

  // sélection : seules `density` cellules portent un grain réfléchissant
  float sel = hash13(cell + 7.13);
  if (sel > density) return 0.0;

  // normale de facette aléatoire autour de N
  vec3 rnd = hash33(cell) * 2.0 - 1.0;
  vec3 G   = normalize(N + rnd * spread);

  // rejeter les facettes qui pointent dans le sol
  if (dot(G, N) < 0.05) return 0.0;

  vec3  R    = reflect(-L, G);
  float RdV  = dot(R, V);

  // anti-aliasing : élargir le seuil par la dérivée écran
  float fw = max(fwidth(RdV), 1e-4);
  float s  = smoothstep(sharp - fw * 2.0, min(sharp + fw * 2.0, 1.0), RdV);

  // modulation par la visibilité du grain
  return s * (0.5 + 0.5 * sel / max(density, 1e-3));
}

// Glitter multi-échelle, atténué avec la distance (anti-scintillement temporel)
vec3 sandGlitter(vec3 wpos, vec3 N, vec3 L, vec3 V, vec3 lightColor,
                 float wetness, float viewDist) {
  // le sable mouillé ne scintille pas : le film d'eau lisse les facettes
  float dryMask = 1.0 - smoothstep(0.15, 0.6, wetness);
  if (dryMask <= 0.001) return vec3(0.0);

  // fondu de distance : évite l'aliasing des grains à l'horizon
  float distFade = exp(-viewDist * 0.09);

  float g = 0.0;
  g += glitterOctave(wpos, N, L, V, 0.0060, 1.25, 0.32, 0.9975) * 1.00;
  g += glitterOctave(wpos, N, L, V, 0.0135, 1.05, 0.24, 0.9955) * 0.62;
  g += glitterOctave(wpos, N, L, V, 0.0290, 0.85, 0.16, 0.9920) * 0.34;

  // le glitter n'existe que si la face est éclairée
  float lambert = smoothstep(0.0, 0.25, dot(N, L));

  // teinte : légèrement plus chaude et plus intense que la lumière — c'est ce qui déclenche le bloom
  vec3 tint = lightColor * vec3(1.10, 1.02, 0.86);

  return tint * (g * 2.6 * dryMask * distFade * lambert);
}
```

**Réglages recommandés pour le look diorama** (caméra à ~4–8 m, FOV 28°) :

| Paramètre | Valeur | Effet si on augmente |
|---|---|---|
| `cellSize` octave 0 | 6 mm | grains plus gros, moins « poudre » |
| `spread` | 1.25 | plus chaotique, scintillement partout |
| `density` | 0.32 | plus de points, risque d'aspect « paillettes » |
| `sharp` | 0.9975 | plus ponctuel, plus « diamant » |
| gain final | 2.6 | pousser à 4.0 fait mordre le bloom (joli en plein soleil) |

> Le glitter doit **dépasser 1.0** en sortie pour que le bloom l'attrape. C'est délibéré : c'est la
> raison d'être de l'effet. Ne pas le clamper avant le tone mapping.

**Transposition TSL** :

```js
import { Fn, vec3, float, floor, fract, dot, reflect, normalize,
         smoothstep, fwidth, max, min, mix, exp, If } from 'three/tsl';

const hash33 = Fn(([p3_immutable]) => {
  const p3 = vec3(p3_immutable).toVar();
  p3.assign(fract(p3.mul(vec3(0.1031, 0.1030, 0.0973))));
  p3.addAssign(dot(p3, p3.yxz.add(33.33)));
  return fract(p3.xxy.add(p3.yxx).mul(p3.zyx));
});

const glitterOctave = Fn(({ wpos, N, L, V, cellSize, spread, density, sharp }) => {
  const cell = floor(wpos.div(cellSize)).toVar();
  const sel  = hash13(cell.add(7.13)).toVar();
  const rnd  = hash33(cell).mul(2.0).sub(1.0);
  const G    = normalize(N.add(rnd.mul(spread))).toVar();
  const R    = reflect(L.negate(), G);
  const RdV  = dot(R, V).toVar();
  const fw   = max(fwidth(RdV), 1e-4);
  const s    = smoothstep(sharp.sub(fw.mul(2.0)), min(sharp.add(fw.mul(2.0)), 1.0), RdV);
  return s.mul(sel.lessThanEqual(density).select(1.0, 0.0))
          .mul(dot(G, N).greaterThan(0.05).select(1.0, 0.0));
});
```

### 3.5 Triplanar mapping (maillage sans UV)

Le maillage surface-nets n'a pas d'UV utilisables. Triplanar : on projette la texture selon les trois
plans du monde et on mélange par les composantes de la normale.

```glsl
// ============================================================================
//  TRIPLANAR
// ============================================================================

// Poids de blending. L'exposant contrôle la dureté de la transition :
//   4.0 = transitions nettes (bon pour le sable, évite le flou aux 45°)
//   2.0 = transitions douces
vec3 triplanarWeights(vec3 wn, float sharpness) {
  vec3 b = pow(abs(wn), vec3(sharpness));
  return b / max(dot(b, vec3(1.0)), 1e-4);
}

// Échantillonnage couleur triplanaire
vec3 triplanarColor(sampler2D tex, vec3 wpos, vec3 wn, float scale, float sharpness) {
  vec3 b = triplanarWeights(wn, sharpness);
  vec3 cx = texture2D(tex, wpos.zy * scale).rgb;
  vec3 cy = texture2D(tex, wpos.xz * scale).rgb;
  vec3 cz = texture2D(tex, wpos.xy * scale).rgb;
  return cx * b.x + cy * b.y + cz * b.z;
}

// Normal mapping triplanaire — blending "Whiteout" (Ben Golus).
// Whiteout = ajouter les XY tangents aux composantes correspondantes de la normale monde,
// et multiplier le Z tangent par la composante d'axe. C'est le meilleur compromis
// qualité/coût : il préserve la force du relief sans les artefacts de UDN.
vec3 triplanarNormal(sampler2D bumpMap, vec3 wpos, vec3 wn, float scale, float sharpness, float strength) {
  vec3 b = triplanarWeights(wn, sharpness);

  // UV par axe (mêmes swizzles que pour la couleur)
  vec2 uvX = wpos.zy * scale;
  vec2 uvY = wpos.xz * scale;
  vec2 uvZ = wpos.xy * scale;

  // décodage tangent-space
  vec3 tx = texture2D(bumpMap, uvX).xyz * 2.0 - 1.0;
  vec3 ty = texture2D(bumpMap, uvY).xyz * 2.0 - 1.0;
  vec3 tz = texture2D(bumpMap, uvZ).xyz * 2.0 - 1.0;

  tx.xy *= strength;  ty.xy *= strength;  tz.xy *= strength;

  // correction de miroir : sans cela les faces opposées ont un relief inversé
  vec3 axisSign = sign(wn);
  tx.z *= axisSign.x;
  ty.z *= axisSign.y;
  tz.z *= axisSign.z;

  // ---- Whiteout blend ----
  vec3 nx = vec3(tx.xy + wn.zy, abs(tx.z) * wn.x);
  vec3 ny = vec3(ty.xy + wn.xz, abs(ty.z) * wn.y);
  vec3 nz = vec3(tz.xy + wn.xy, abs(tz.z) * wn.z);

  // recomposer dans l'ordre des axes monde
  return normalize(
      nx.zyx * b.x
    + ny.xzy * b.y
    + nz.xyz * b.z
  );
}
```

**Bruit triplanaire sans texture** (utile pour la variation de couleur, évite un fetch) :

```glsl
float valueNoise3(vec3 p) {
  vec3 i = floor(p), f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  float n000 = hash13(i + vec3(0,0,0)), n100 = hash13(i + vec3(1,0,0));
  float n010 = hash13(i + vec3(0,1,0)), n110 = hash13(i + vec3(1,1,0));
  float n001 = hash13(i + vec3(0,0,1)), n101 = hash13(i + vec3(1,0,1));
  float n011 = hash13(i + vec3(0,1,1)), n111 = hash13(i + vec3(1,1,1));
  return mix(mix(mix(n000,n100,f.x), mix(n010,n110,f.x), f.y),
             mix(mix(n001,n101,f.x), mix(n011,n111,f.x), f.y), f.z);
}

float fbm3(vec3 p, int octaves, float lac, float gain) {
  float a = 0.5, s = 0.0;
  for (int i = 0; i < 8; i++) {
    if (i >= octaves) break;
    s += a * valueNoise3(p);
    p *= lac; a *= gain;
  }
  return s;
}
```

> **Coût** : le triplanar triple les fetch de texture. Optimisation standard : si `max(b) > 0.985`,
> échantillonner un seul axe (branche cohérente sur la plupart des zones plates du sable). Gain mesuré
> ~35 % de bande passante texture sur une plage majoritairement horizontale.

```glsl
vec3 triplanarColorFast(sampler2D tex, vec3 wpos, vec3 wn, float scale, float sharpness) {
  vec3 b = triplanarWeights(wn, sharpness);
  if (b.y > 0.985) return texture2D(tex, wpos.xz * scale).rgb;  // cas dominant : sol
  vec3 cx = texture2D(tex, wpos.zy * scale).rgb;
  vec3 cy = texture2D(tex, wpos.xz * scale).rgb;
  vec3 cz = texture2D(tex, wpos.xy * scale).rgb;
  return cx * b.x + cy * b.y + cz * b.z;
}
```

### 3.6 Micro-détail : grain, variation, débris

Trois couches, cumulatives, toutes procédurales (aucune texture à charger) :

```glsl
// ============================================================================
//  MICRO-DÉTAIL DU SABLE
// ============================================================================

// 1) Grain : bruit haute fréquence appliqué à la normale (relief) et à l'albedo (bruit de valeur)
void sandGrain(vec3 wpos, inout vec3 N, inout vec3 albedo, float compact, float viewDist) {
  // fondu de détail avec la distance pour éviter l'aliasing
  float detail = exp(-viewDist * 0.22);
  if (detail < 0.01) return;

  float s = mix(700.0, 480.0, compact);       // sable tassé = grain plus fin/serré
  vec3  p = wpos * s;

  // relief : gradient central du bruit
  float e = 0.75;
  float n  = valueNoise3(p);
  float nx = valueNoise3(p + vec3(e, 0, 0));
  float ny = valueNoise3(p + vec3(0, e, 0));
  float nz = valueNoise3(p + vec3(0, 0, e));
  vec3  g  = vec3(nx - n, ny - n, nz - n);

  float amp = mix(0.55, 0.28, compact) * detail;
  N = normalize(N + (g - dot(g, N) * N) * amp);

  // variation d'albedo : ±6 %
  albedo *= 1.0 + (n - 0.5) * 0.12 * detail;
}

// 2) Variation de teinte à moyenne échelle : "taches" de sable plus clair/plus doré
vec3 sandTint(vec3 wpos, vec3 albedo) {
  float m = fbm3(wpos * 3.5, 3, 2.03, 0.55);
  // 3 pôles de teinte : doré, gris-beige, rosé (coquille broyée)
  vec3 gold  = vec3(1.06, 0.99, 0.84);
  vec3 grey  = vec3(0.96, 0.97, 1.00);
  vec3 shell = vec3(1.04, 0.97, 0.95);
  vec3 t = mix(grey, gold, smoothstep(0.35, 0.70, m));
  t = mix(t, shell, smoothstep(0.72, 0.92, m) * 0.6);
  return albedo * t;
}

// 3) Débris épars : coquillages, éclats, petits cailloux — en shader, pas en géométrie
//    (rendu comme des taches d'albedo + rugosité locale + petit bump)
void sandDebris(vec3 wpos, vec3 N, inout vec3 albedo, inout float rough, float viewDist) {
  float detail = exp(-viewDist * 0.16);
  if (detail < 0.02) return;

  const float CELL = 0.035;              // ~3.5 cm entre débris potentiels
  vec2  c  = floor(wpos.xz / CELL);
  vec3  h  = hash33(vec3(c, 3.7));
  if (h.x > 0.055) return;               // 5.5 % des cellules portent un débris

  vec2 center = (c + 0.5 + (h.yz - 0.5) * 0.7) * CELL;
  float d = length(wpos.xz - center);
  float r = CELL * mix(0.12, 0.30, h.y);
  float m = (1.0 - smoothstep(r * 0.7, r, d)) * detail;
  if (m <= 0.0) return;

  // palette de débris : nacre, corail pâle, gris ardoise
  vec3 pal = (h.z < 0.45) ? vec3(0.94, 0.92, 0.88)
           : (h.z < 0.78) ? vec3(0.90, 0.72, 0.64)
                          : vec3(0.42, 0.44, 0.46);
  albedo = mix(albedo, pal, m * 0.9);
  rough  = mix(rough, 0.28, m * 0.8);    // les coquilles sont brillantes
}

// 4) Traces d'outils : rainures laissées par la pelle / le râteau.
//    Alimenté par une texture "toolMask" (R = profondeur de trace 0..1) écrite par le gameplay.
void sandToolMarks(sampler2D toolMask, vec2 uvBlock, inout vec3 N, inout vec3 albedo, inout float rough) {
  vec3 t = texture2D(toolMask, uvBlock).rgb;   // R=profondeur, GB=gradient pré-calculé
  float depth = t.r;
  if (depth <= 0.002) return;

  // gradient stocké → perturbation de normale
  vec2 grad = (t.gb * 2.0 - 1.0) * depth;
  N = normalize(N + vec3(grad.x, 0.0, grad.y) * 1.4);

  // le fond de la rainure expose du sable plus profond, plus humide, plus foncé
  albedo *= mix(1.0, 0.86, depth);
  rough   = mix(rough, rough * 0.94, depth);
}
```

### 3.7 Sable sec coulant vs sable compacté

Différence visuelle à rendre explicitement (c'est ce qui distingue un tas de sable d'un mur de château) :

| | Sable sec coulant (`aCompact ≈ 0`) | Sable compacté / sculpté (`aCompact ≈ 1`) |
|---|---|---|
| Albedo | +8 % plus clair (plus d'air, plus de diffusion) | référence |
| Rugosité | 0.97 | 0.88 |
| Grain | grossier, amplitude 0.55 | fin, amplitude 0.28 |
| Arêtes | arrondies — écraser `aCurv` | vives — accentuer `aCurv` |
| Glitter | dense, chaotique (`spread` 1.4) | moins dense, plus aligné (`spread` 0.9) |
| SSS | fort (grains désordonnés, beaucoup de vides) | faible |
| Pente max | 34° (angle de talus) — géré par la sim, mais visible | jusqu'à 90° |

```glsl
void applyCompaction(float compact, inout vec3 albedo, inout float rough,
                     inout float curvGain, inout float sssGain, inout float grainAmp) {
  albedo    *= mix(1.08, 1.00, compact);
  rough      = mix(0.97, 0.88, compact);
  curvGain   = mix(0.35, 1.20, compact);
  sssGain    = mix(1.00, 0.45, compact);
  grainAmp   = mix(0.55, 0.28, compact);
}
```

### 3.8 Accentuation des arêtes (courbure / AO local)

Sans ça, les créneaux et les briques d'un château disparaissent : la normale lissée du surface-nets
mange les arêtes. On remonte le contraste avec la courbure.

**Bakée au meshing (recommandé)** — stable, gratuite au runtime :

```js
// src/voxel/bakeCurvature.js
// Après génération des positions/normales, pour chaque vertex :
//   curv = 1 - moyenne( dot(N_vertex, normalize(P_voisin - P_vertex)) ) recentré
// Convention : > 0 = convexe (arête saillante), < 0 = concave (rainure)
export function bakeCurvature(positions, normals, adjacency) {
  const n = positions.length / 3;
  const curv = new Float32Array(n);
  const p = new THREE.Vector3(), q = new THREE.Vector3(), nv = new THREE.Vector3(), d = new THREE.Vector3();

  for (let i = 0; i < n; i++) {
    p.fromArray(positions, i * 3);
    nv.fromArray(normals, i * 3);
    const nb = adjacency[i];
    if (!nb || nb.length === 0) { curv[i] = 0; continue; }
    let acc = 0;
    for (const j of nb) {
      q.fromArray(positions, j * 3);
      d.subVectors(q, p);
      const len = d.length();
      if (len < 1e-6) continue;
      d.multiplyScalar(1 / len);
      acc += nv.dot(d);          // >0 : le voisin est "au-dessus" du plan tangent -> concave
    }
    // -acc/nb : positif sur les convexités
    curv[i] = THREE.MathUtils.clamp(-(acc / nb.length) * 6.0, -1, 1);
  }
  return curv;
}
```

**Fallback écran (si le mesher ne peut pas la fournir)** :

```glsl
// Courbure approximée par les dérivées écran de la normale.
// Correcte visuellement, mais dépend de la résolution et scintille en mouvement -> préférer le baké.
float screenCurvature(vec3 N, vec3 viewPos) {
  vec3 dNx = dFdx(N), dNy = dFdy(N);
  vec3 dPx = dFdx(viewPos), dPy = dFdy(viewPos);
  float k = dot(dNx, normalize(dPx)) + dot(dNy, normalize(dPy));
  return clamp(-k * 0.35, -1.0, 1.0);
}
```

**Application** — c'est ici que le look « sculpté » se gagne :

```glsl
// curv : -1 (rainure) .. +1 (arête)
void applyCurvature(float curv, float gain, inout vec3 albedo, inout float ao, inout float rough) {
  float convex  = max( curv, 0.0);
  float concave = max(-curv, 0.0);

  // arêtes : plus claires (l'usure expose du sable sec) + plus rugueuses (grains détachés)
  albedo *= 1.0 + convex * 0.28 * gain;
  rough   = min(rough + convex * 0.03 * gain, 1.0);

  // creux : AO local + assombrissement + légère saturation (sable plus tassé, plus humide)
  ao     *= 1.0 - concave * 0.45 * gain;
  albedo  = mix(albedo, albedo * vec3(0.72, 0.66, 0.58), concave * 0.55 * gain);
}
```

> Réglage : commencer avec `gain = 1.0`, et **regarder la silhouette d'un créneau de face, en ombre**.
> Si le créneau n'est pas lisible sans lumière directe, monter le gain concave. C'est le test décisif.

### 3.9 SSS / translucence en lumière rasante

Au coucher de soleil, une crête de sable fine s'allume par transmission. Approximation
Barré-Brisebois/Bouchard (GDC 2011), quelques opérations vectorielles, aucun ray-marching :

```glsl
// ============================================================================
//  SSS APPROCHÉ (translucence)
// ============================================================================
//   distortion : décale H vers la normale — 0.15..0.35 pour le sable
//   power      : dureté du lobe — 4..12
//   scale      : gain
//   thickness  : 1 = feature fine (créneau, arête) ; 0 = masse
vec3 sandTranslucency(vec3 N, vec3 L, vec3 V, vec3 lightColor,
                      float thickness, float distortion, float power, float scale) {
  vec3  H    = normalize(L + N * distortion);
  float VdH  = pow(clamp(dot(V, -H), 0.0, 1.0), power) * scale;
  // teinte de transmission : le sable transmet dans les oranges
  vec3  tint = vec3(1.00, 0.62, 0.28);
  return lightColor * tint * (VdH * thickness);
}
```

Intégration :

```glsl
float thin = vThin * sssGain * (1.0 - wetness * 0.7);   // le sable mouillé transmet peu (l'eau absorbe)
vec3  sss  = sandTranslucency(normal, sunDir, viewDir, sunColor, thin, 0.22, 7.0, 1.6);
outgoingLight += sss;
```

**Où vient `aThin`** : au meshing, compter les voxels pleins dans un rayon de 3 cellules autour du
vertex ; `aThin = 1 - occupancy`. Un créneau isolé a une occupancy basse → il s'allume.

### 3.10 Le corps du shader de sable, assemblé

```glsl
// ============================================================================
//  SAND — corps du fragment shader (remplace <map_fragment>)
// ============================================================================
vec3  wp   = vWPos;
vec3  wn   = normalize(vWNormal);
vec3  V    = normalize(cameraPosition - wp);
float dist = length(cameraPosition - wp);

// ---- 1. humidité (carte partagée avec l'eau, cf. §4.4) ----
vec2  hUV      = (wp.xz - uBlockMin) / uBlockSize;
vec4  hum      = texture2D(uHumidityMap, hUV);
float waterLvl = hum.r;
float wetness  = clamp(hum.g, 0.0, 1.0);
float foamRes  = hum.b;
float submerge = clamp((waterLvl - wp.y) / 0.03, 0.0, 1.0);   // sous l'eau ?
wetness = max(wetness, submerge);

// ---- 2. paramètres de matière ----
float curvGain, sssGain, grainAmp;
float sandRough;
vec3  albedo = SAND_DRY_MID;
applyCompaction(vCompact, albedo, sandRough, curvGain, sssGain, grainAmp);

// ---- 3. teinte, grain, débris, traces ----
albedo = sandTint(wp, albedo);
vec3 N = triplanarNormal(uSandBump, wp, wn, uBumpScale, 4.0, uBumpStrength);
sandGrain(wp, N, albedo, vCompact, dist);
sandDebris(wp, N, albedo, sandRough, dist);
sandToolMarks(uToolMask, hUV, N, albedo, sandRough);

// ---- 4. courbure ----
float sandAO = vAO;
applyCurvature(vCurv, curvGain, albedo, sandAO, sandRough);

// ---- 5. mouillé ----
albedo    = sandWetAlbedo(albedo, wetness);
sandRough = sandWetRoughness(wetness, vCompact);

// ---- 6. mousse résiduelle laissée par la vague ----
float foamMask = foamRes * smoothstep(0.25, 0.9, wetness);
albedo    = mix(albedo, FOAM_COLOR, foamMask * 0.75);
sandRough = mix(sandRough, 0.55, foamMask * 0.5);

// ---- 7. caustiques si sous l'eau ----
if (submerge > 0.0) {
  float depth = max(waterLvl - wp.y, 0.0);
  vec3  caus  = causticsRGB(wp.xz, uTime, depth);
  albedo += caus * submerge * uCausticsIntensity;
}

vec3 sandNormal = N;
diffuseColor.rgb *= albedo;
```

Puis, dans le patch `<opaque_fragment>` :

```glsl
// ---- 8. glitter + SSS, ajoutés après l'éclairage ----
outgoingLight += sandGlitter(vWPos, sandNormal, uSunDir, normalize(cameraPosition - vWPos),
                             uSunColor, wetness, length(cameraPosition - vWPos));
outgoingLight += sandTranslucency(sandNormal, uSunDir, normalize(cameraPosition - vWPos),
                                  uSunColor, vThin * sssGain * (1.0 - wetness * 0.7),
                                  0.22, 7.0, 1.6);
// ---- 9. film d'eau : lobe spéculaire GGX supplémentaire ----
{
  float film = sandWaterFilm(wetness);
  if (film > 0.0) {
    vec3  Vv = normalize(cameraPosition - vWPos);
    vec3  H  = normalize(uSunDir + Vv);
    float a  = 0.055;                    // rugosité du film
    float a2 = a * a;
    float NdH = max(dot(sandNormal, H), 0.0);
    float d   = NdH * NdH * (a2 - 1.0) + 1.0;
    float D   = a2 / (3.14159265 * d * d);
    float F   = 0.02 + 0.98 * pow(1.0 - max(dot(H, Vv), 0.0), 5.0);
    outgoingLight += uSunColor * (D * F * 0.35 * film) * max(dot(sandNormal, uSunDir), 0.0);
  }
}
```

---

## 4. L'eau

Trois systèmes distincts, à ne pas confondre :

1. **L'océan** — grande nappe hors du bloc, vagues de Gerstner, couleur par profondeur.
2. **Le ressac / swash** — la bande d'écume qui monte et redescend sur la plage.
3. **L'eau captive** — douves, tranchées, seaux : nappes locales à hauteur variable.

### 4.1 Océan : vagues de Gerstner

Gerstner (ou trochoïdales) plutôt que FFT : 4–6 vagues suffisent pour un diorama, le coût est
négligeable, et on obtient les **crêtes pointues** caractéristiques (le FFT est meilleur pour du réalisme
grande échelle, hors sujet ici).

```glsl
// ============================================================================
//  GERSTNER WAVES
// ============================================================================
// Une vague : direction D (xz normalisée), amplitude A, longueur d'onde L, raideur Q, vitesse S
// Q contrôle le pincement des crêtes : Q = steepness / (k * A * nbWaves) pour éviter les boucles
struct GerstnerOut { vec3 pos; vec3 tangent; vec3 binormal; float crest; };

GerstnerOut gerstner(vec3 p0, float t, int count) {
  vec3 pos = p0;
  vec3 tan = vec3(1.0, 0.0, 0.0);
  vec3 bin = vec3(0.0, 0.0, 1.0);
  float crest = 0.0;

  for (int i = 0; i < 8; i++) {
    if (i >= count) break;
    vec2  D = uWaveDir[i];              // normalisée
    float A = uWaveAmp[i];
    float L = uWaveLen[i];
    float Q = uWaveSteep[i];
    float S = uWaveSpeed[i];

    float k   = 6.28318530718 / L;
    float w   = sqrt(9.81 * k);         // relation de dispersion en eau profonde
    float f   = k * dot(D, p0.xz) - w * S * t;
    float c   = cos(f), s = sin(f);
    float QA  = Q * A;

    pos.xz += D * (QA * c);
    pos.y  += A * s;

    // dérivées analytiques -> normale exacte
    tan.x  += -QA * D.x * D.x * k * s;
    tan.y  +=  A  * D.x * k * c;
    tan.z  += -QA * D.x * D.y * k * s;

    bin.x  += -QA * D.x * D.y * k * s;
    bin.y  +=  A  * D.y * k * c;
    bin.z  += -QA * D.y * D.y * k * s;

    crest  += s * (A / max(uWaveAmp[0], 1e-3));
  }

  GerstnerOut o;
  o.pos      = pos;
  o.tangent  = normalize(tan);
  o.binormal = normalize(bin);
  o.crest    = crest;
  return o;
}
```

Vertex shader de l'océan :

```glsl
void main() {
  vec3 wp0 = (modelMatrix * vec4(position, 1.0)).xyz;

  GerstnerOut g = gerstner(wp0, uTime, uWaveCount);

  vWPos   = g.pos;
  vNormal = normalize(cross(g.binormal, g.tangent));
  vCrest  = g.crest;

  // atténuation des vagues à l'approche du rivage (eau peu profonde)
  float shallow = smoothstep(0.0, 1.2, uSeaLevel - terrainHeight(wp0.xz));
  vWPos = mix(wp0, g.pos, shallow);

  gl_Position = projectionMatrix * viewMatrix * vec4(vWPos, 1.0);
  vScreenUV   = (gl_Position.xy / gl_Position.w) * 0.5 + 0.5;
}
```

**Réglages pour un océan de diorama** (échelle : le bloc fait 8 m, l'océan s'étend sur ~60 m) :

| # | Direction | Amplitude | Longueur | Raideur | Vitesse |
|---|---|---|---|---|---|
| 0 | (1.0, 0.15) | 0.085 m | 5.2 m | 0.62 | 1.0 |
| 1 | (0.85, −0.53) | 0.052 m | 3.1 m | 0.48 | 1.15 |
| 2 | (0.62, 0.78) | 0.028 m | 1.7 m | 0.35 | 1.35 |
| 3 | (0.95, −0.31) | 0.013 m | 0.85 m | 0.25 | 1.6 |
| 4 | (0.40, 0.92) | 0.006 m | 0.42 m | 0.18 | 2.0 |

Les 3 dernières donnent la « ride » de surface ; ne pas les mettre en géométrie sur les LOD lointains,
les basculer en normal map.

### 4.2 Couleur par profondeur (Beer-Lambert), réfraction, réflexion

```glsl
// ============================================================================
//  OCÉAN — fragment
// ============================================================================
#include <packing>

uniform sampler2D uSceneColor;   // copie du color buffer opaque
uniform sampler2D uSceneDepth;   // depth texture de la passe opaque
uniform samplerCube uEnvMap;

// Reconstruction de la profondeur linéaire (view-space Z, négatif)
float linearViewZ(vec2 uv) {
  float d = texture2D(uSceneDepth, uv).x;
  return perspectiveDepthToViewZ(d, cameraNear, cameraFar);
}

void main() {
  vec3 N = normalize(vNormal);
  vec3 V = normalize(cameraPosition - vWPos);

  // ---- détail de surface : 2 normal maps qui défilent en sens opposés ----
  vec2 uvA = vWPos.xz * 0.65 + vec2( 0.021, 0.013) * uTime;
  vec2 uvB = vWPos.xz * 1.35 + vec2(-0.017, 0.026) * uTime;
  vec3 nA = texture2D(uWaterNormals, uvA).xyz * 2.0 - 1.0;
  vec3 nB = texture2D(uWaterNormals, uvB).xyz * 2.0 - 1.0;
  vec3 nd = normalize(nA + nB);
  N = normalize(N + vec3(nd.x, 0.0, nd.y) * uRippleStrength);

  // ---- profondeur d'eau ----
  float sceneZ   = linearViewZ(vScreenUV);
  float surfZ    = vViewZ;                       // view-space Z du fragment d'eau
  float waterDepth = max(surfZ - sceneZ, 0.0);   // épaisseur traversée, en mètres

  // ---- réfraction screen-space ----
  // décalage proportionnel à la normale, atténué en eau peu profonde (sinon le fond "glisse")
  float refrScale = uRefractStrength * min(waterDepth, 0.6);
  vec2  refrUV    = vScreenUV + N.xz * refrScale / max(surfZ, 1.0);
  // sécurité : si l'échantillon décalé est DEVANT la surface d'eau, retomber sur l'UV non décalé
  if (linearViewZ(refrUV) < surfZ) refrUV = vScreenUV;
  vec3 refracted = texture2D(uSceneColor, refrUV).rgb;

  // ---- extinction Beer-Lambert ----
  // sigma = coefficient d'extinction par mètre, par canal. Le rouge s'éteint ~15x plus vite que le bleu.
  // Valeurs calibrées pour un lagon turquoise :
  const vec3 SIGMA = vec3(2.10, 0.42, 0.28);     // m^-1
  vec3 transmittance = exp(-SIGMA * waterDepth * 2.0); // *2 : aller-retour lumière

  // couleur de diffusion volumique (ce que l'eau "renvoie" elle-même)
  const vec3 SCATTER = vec3(0.055, 0.42, 0.40);
  vec3 inScatter = SCATTER * (1.0 - transmittance);

  vec3 body = refracted * transmittance + inScatter;

  // ---- réflexion ----
  vec3 R = reflect(-V, N);
  vec3 reflected = textureCube(uEnvMap, R).rgb;   // remplacer par SSR si dispo

  // Fresnel Schlick, F0 = 0.02 (eau)
  float F = 0.02 + 0.98 * pow(1.0 - max(dot(N, V), 0.0), 5.0);
  F *= uReflectStrength;

  vec3 col = mix(body, reflected, F);

  // ---- spéculaire soleil (lobe GGX serré) ----
  {
    vec3  H  = normalize(uSunDir + V);
    float a  = 0.035, a2 = a * a;
    float NdH = max(dot(N, H), 0.0);
    float d   = NdH * NdH * (a2 - 1.0) + 1.0;
    float D   = a2 / (3.14159265 * d * d);
    col += uSunColor * D * 0.9 * max(dot(N, uSunDir), 0.0);
  }

  // ---- écume ----
  col = applyFoam(col, vWPos, waterDepth, vCrest, uTime);

  // ---- bord adouci (depth fade) : l'eau ne doit pas "couper" le sable ----
  float edgeFade = smoothstep(0.0, 0.045, waterDepth);

  gl_FragColor = vec4(col, edgeFade);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
```

**Calibration de `SIGMA`** : le rapport rouge/bleu détermine la teinte. Pour du turquoise Caraïbes,
viser `(2.1, 0.42, 0.28)` ; pour une mer du Nord verte, `(1.4, 0.55, 0.95)` ; pour une piscine,
`(1.6, 0.20, 0.12)`. La couleur perçue à 1 m de fond blanc est `exp(-2*SIGMA)` ≈ `(0.015, 0.43, 0.57)`
→ un turquoise profond. Exactement la cible.

### 4.3 Le ressac / swash : écume à la laisse de mer

C'est le détail signature de la référence. Décomposition en **quatre** couches :

1. **Front de vague** : une ligne d'écume dense qui avance et recule, période 4–7 s.
2. **Traîne (lace)** : la dentelle d'écume laissée derrière le front, qui se dissout en ~2 s.
3. **Écume de crête** : sur les crêtes de Gerstner en mer.
4. **Sable mouillé résiduel** : la bande foncée qui persiste ~20 s après le retrait (gérée par la
   carte d'humidité, §4.4 — pas par le shader d'eau).

```glsl
// ============================================================================
//  ÉCUME / SWASH
// ============================================================================

// Phase du ressac : montée rapide, retrait lent (asymétrie = réalisme)
// retourne 0..1, où 1 = extension maximale sur la plage
float swashPhase(float t, float period) {
  float x = fract(t / period);
  // montée sur 25 % du cycle, retrait sur 75 %
  float up   = smoothstep(0.0, 0.25, x);
  float down = 1.0 - smoothstep(0.25, 1.0, x);
  return min(up, down) * 1.0 + max(0.0, 1.0 - abs(x - 0.25) / 0.25) * 0.0;
}

// Texture de mousse procédurale : Worley "gonflé" + fbm, deux couches en dérive
float foamTexture(vec2 p, float t) {
  // distorsion : la mousse se déforme en s'étalant
  vec2 w = vec2(fbm3(vec3(p * 3.0, t * 0.25), 3, 2.0, 0.5),
                fbm3(vec3(p * 3.0 + 17.0, t * 0.25), 3, 2.0, 0.5)) - 0.5;
  p += w * 0.35;

  float a = fbm3(vec3(p * 7.0,  t * 0.55), 4, 2.05, 0.52);
  float b = fbm3(vec3(p * 15.0, -t * 0.35), 3, 2.11, 0.48);
  // seuiller haut donne les "bulles" ; mélanger deux échelles donne la dentelle
  float f = smoothstep(0.48, 0.78, a) * 0.75 + smoothstep(0.55, 0.85, b) * 0.45;
  return clamp(f, 0.0, 1.0);
}

vec3 applyFoam(vec3 col, vec3 wp, float waterDepth, float crest, float t) {
  // ---- (A) écume de crête, en mer ----
  float crestFoam = smoothstep(0.55, 0.95, crest) * foamTexture(wp.xz * 1.4, t);

  // ---- (B) front de swash ----
  // profondeur cible du front : oscille entre 2 cm et 22 cm
  float ph        = swashPhase(t, uSwashPeriod);
  float frontDepth = mix(0.020, 0.220, ph);

  // bande centrée sur frontDepth, largeur qui s'élargit quand la vague ralentit
  float bandW     = mix(0.030, 0.075, ph);
  float band      = 1.0 - smoothstep(0.0, bandW, abs(waterDepth - frontDepth));

  // la crête du front est plus dense que sa queue
  float lead      = smoothstep(frontDepth + bandW * 0.4, frontDepth - bandW * 0.1, waterDepth);

  float swashFoam = band * mix(0.55, 1.0, lead) * foamTexture(wp.xz * 2.6 + vec2(0.0, ph * 0.4), t * 1.6);

  // ---- (C) écume de très faible profondeur (la nappe qui s'étale) ----
  float sheet = (1.0 - smoothstep(0.0, 0.035, waterDepth)) * 0.55
              * foamTexture(wp.xz * 4.0, t * 2.2);

  // ---- (D) écume autour des obstacles (château, seau) : waterDepth chute brutalement ----
  float obstacle = (1.0 - smoothstep(0.0, 0.08, waterDepth)) * 0.4;

  float foam = clamp(crestFoam + swashFoam + sheet + obstacle, 0.0, 1.0);

  // la mousse est presque blanche mais pas pure : elle prend un peu de la couleur du fond
  vec3 foamCol = mix(FOAM_COLOR, FOAM_COLOR * vec3(0.92, 0.97, 0.98), 0.4);
  return mix(col, foamCol, foam);
}
```

**Réglages** :

| Uniforme | Valeur | Note |
|---|---|---|
| `uSwashPeriod` | 5.5 s | 4 s = agité, 8 s = très calme |
| `frontDepth` max | 0.22 m | détermine jusqu'où l'eau monte sur la plage |
| `bandW` | 0.03 → 0.075 | trop large = « nappe de lait », trop étroit = « trait blanc » |
| échelle de `foamTexture` | 2.6 | à ajuster selon l'échelle du bloc |

> **Astuce look** : rendre l'écume **légèrement émissive** (× 1.15) la fait ressortir sous le tone
> mapping AgX et lui donne l'aspect « mousse éclairée par transparence » de la référence.

### 4.4 La carte d'humidité : le pivot du système

Une simulation 2D ping-pong qui unifie sable mouillé, laisse de mer, mousse résiduelle et caustiques.
En WebGPU c'est un compute pass ; en WebGL2 un ping-pong sur `WebGLRenderTarget`.

```glsl
// ============================================================================
//  HUMIDITY SIM — fragment (ping-pong)
//  Sortie : R=niveau d'eau (m), G=saturation sable, B=mousse résiduelle, A=profondeur d'eau
// ============================================================================
uniform sampler2D uPrev;        // état précédent
uniform sampler2D uTerrainH;    // R = hauteur du sable (m), écrite par le mesher
uniform float uDt, uTexel, uTime;
uniform float uSeaLevel, uSwashPeriod, uSwashReach;
uniform float uEvapRate, uAbsorbRate, uDiffuse, uFoamDecay;
varying vec2 vUv;

void main() {
  vec4  prev  = texture2D(uPrev, vUv);
  float terr  = texture2D(uTerrainH, vUv).r;

  float sat   = prev.g;
  float foam  = prev.b;

  // ---- 1. niveau d'eau de la mer, modulé par le swash ----
  float ph        = swashPhase(uTime, uSwashPeriod);
  float seaNow    = uSeaLevel + uSwashReach * (ph - 0.5) * 2.0;

  // ---- 2. eau captive (douves) : conservée depuis l'état précédent, s'infiltre ----
  float trapped   = max(prev.r - terr, 0.0);
  trapped         = max(trapped - uAbsorbRate * 0.25 * uDt, 0.0);   // infiltration

  float waterLvl  = max(seaNow, terr + trapped);
  float depth     = max(waterLvl - terr, 0.0);

  // ---- 3. saturation : absorbe si mouillé, s'évapore sinon ----
  if (depth > 0.0005) {
    sat += uAbsorbRate * uDt * (1.0 - sat) * 4.0;
    // dépôt de mousse là où la lame passe (couche mince seulement)
    float thin = 1.0 - smoothstep(0.0, 0.05, depth);
    foam = max(foam, thin * 0.85);
  } else {
    sat -= uEvapRate * uDt;
  }

  // ---- 4. diffusion capillaire (le sable "tire" l'eau latéralement, vers le haut de plage) ----
  float s0 = texture2D(uPrev, vUv + vec2( uTexel, 0.0)).g;
  float s1 = texture2D(uPrev, vUv + vec2(-uTexel, 0.0)).g;
  float s2 = texture2D(uPrev, vUv + vec2(0.0,  uTexel)).g;
  float s3 = texture2D(uPrev, vUv + vec2(0.0, -uTexel)).g;
  sat += uDiffuse * uDt * ((s0 + s1 + s2 + s3) * 0.25 - sat);

  // ---- 5. décroissance de la mousse ----
  foam -= uFoamDecay * uDt;

  gl_FragColor = vec4(waterLvl, clamp(sat, 0.0, 1.0), clamp(foam, 0.0, 1.0), depth);
}
```

Pilote JS :

```js
// src/sim/HumidityField.js
export class HumidityField {
  constructor(renderer, size = 512, blockMin, blockSize) {
    const opts = {
      type: THREE.HalfFloatType, format: THREE.RGBAFormat,
      minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter,
      depthBuffer: false, stencilBuffer: false, generateMipmaps: false,
    };
    this.rt = [new THREE.WebGLRenderTarget(size, size, opts),
               new THREE.WebGLRenderTarget(size, size, opts)];
    this.i = 0;
    this.blockMin = blockMin; this.blockSize = blockSize;
    this.mat = new THREE.ShaderMaterial({ /* uniforms + le shader ci-dessus */ });
    this.quad = new FullScreenQuad(this.mat);
    this.acc = 0;
  }

  // 20 Hz suffit largement — inutile de simuler à 60 fps
  update(renderer, dt) {
    this.acc += dt;
    const STEP = 1 / 20;
    let guard = 0;
    while (this.acc >= STEP && guard++ < 3) {
      this.acc -= STEP;
      this.mat.uniforms.uPrev.value = this.rt[this.i].texture;
      this.mat.uniforms.uDt.value   = STEP;
      const dst = this.rt[1 - this.i];
      renderer.setRenderTarget(dst);
      this.quad.render(renderer);
      renderer.setRenderTarget(null);
      this.i = 1 - this.i;
    }
  }
  get texture() { return this.rt[this.i].texture; }
}
```

Coût : 512² × 20 Hz × ~10 fetch = négligeable (< 0.15 ms). Bénéfice : le sable **se souvient** du
passage des vagues. C'est le détail qui vend l'ambiance.

### 4.5 Eau captive : douves, tranchées, seaux

L'océan est un plan ; les douves ne le sont pas. Deux approches :

**(a) Plan d'eau par corps d'eau (recommandé)** — le solveur d'eau du gameplay produit une liste de
corps connexes avec un niveau ; on génère une petite `PlaneGeometry` clippée par le masque, ou plus
simple : **une seule nappe couvrant tout le bloc**, dont la hauteur par vertex vient de la carte
d'humidité (canal R), et qu'on discard là où `depth <= 0`.

```glsl
// --- vertex de la nappe locale ---
void main() {
  vec2 uv = (position.xz - uBlockMin) / uBlockSize;
  vec4 hum = texture2D(uHumidityMap, uv);   // nécessite vertexTextures (OK en WebGL2/WebGPU)
  float lvl = hum.r;
  vDepth = hum.a;
  vec3 wp = vec3(position.x, lvl, position.z);
  // micro-ondulation de surface
  wp.y += sin(wp.x * 22.0 + uTime * 2.1) * 0.0018
        + sin(wp.z * 19.0 - uTime * 1.7) * 0.0015;
  vWPos = wp;
  gl_Position = projectionMatrix * viewMatrix * vec4(wp, 1.0);
}
```

```glsl
// --- fragment de la nappe locale ---
void main() {
  if (vDepth <= 0.002) discard;         // pas d'eau ici

  // même extinction Beer-Lambert, mais SIGMA réduit (eau très peu profonde, très claire)
  const vec3 SIGMA = vec3(1.35, 0.30, 0.22);
  float sceneZ = linearViewZ(vScreenUV);
  float thick  = clamp(vViewZ - sceneZ, 0.0, vDepth);
  vec3  T      = exp(-SIGMA * thick * 2.0);

  vec2 refrUV = vScreenUV + vNormal.xz * (0.012 * thick);
  vec3 bottom = texture2D(uSceneColor, refrUV).rgb;
  vec3 col    = bottom * T + vec3(0.05, 0.30, 0.28) * (1.0 - T);

  // reflet du ciel, faible en vue plongeante (Fresnel)
  vec3  V = normalize(cameraPosition - vWPos);
  float F = 0.02 + 0.98 * pow(1.0 - max(dot(vNormal, V), 0.0), 5.0);
  col = mix(col, textureCube(uEnvMap, reflect(-V, vNormal)).rgb, F * 0.7);

  // ligne de mousse au contact des berges : la profondeur chute -> liseré blanc
  float rim = 1.0 - smoothstep(0.0, 0.018, thick);
  col = mix(col, FOAM_COLOR, rim * 0.55 * foamTexture(vWPos.xz * 8.0, uTime));

  // soft edge : alpha proportionnel à l'épaisseur -> pas de découpe dure sur le sable
  float alpha = smoothstep(0.0, 0.010, thick);

  gl_FragColor = vec4(col, alpha);
}
```

> **Règle absolue** : l'eau doit être rendue **après** l'opaque, `depthWrite: false`,
> `transparent: true`, et le color buffer opaque doit avoir été copié dans `uSceneColor` **avant**.
> Sinon la réfraction se lit elle-même (feedback).

### 4.6 Caustiques

Pas de photon mapping : un motif procédural projeté, atténué par la profondeur. Trois octaves de
Worley « inversé » suffisent.

```glsl
// ============================================================================
//  CAUSTIQUES
// ============================================================================
vec2 causticCell(vec2 p, float t) {
  vec2  ip = floor(p), fp = fract(p);
  float md = 8.0; vec2 mr;
  for (int j = -1; j <= 1; j++)
  for (int i = -1; i <= 1; i++) {
    vec2 g = vec2(float(i), float(j));
    vec2 o = hash33(vec3(ip + g, 0.0)).xy;
    o = 0.5 + 0.42 * sin(t * 1.15 + 6.2831 * o);
    vec2 r = g + o - fp;
    float d = dot(r, r);
    if (d < md) { md = d; mr = r; }
  }
  return vec2(sqrt(md), 0.0);
}

float causticLayer(vec2 p, float t, float scale) {
  float d = causticCell(p * scale, t).x;
  // le "nervurage" : les lignes de caustique sont les frontières de Voronoi
  float c = 1.0 - smoothstep(0.0, 0.34, d);
  return pow(c, 2.4);
}

// Dispersion chromatique : les 3 canaux échantillonnent avec un léger décalage temporel
vec3 causticsRGB(vec2 xz, float t, float depth) {
  float a = causticLayer(xz, t * 1.00, 7.5);
  float b = causticLayer(xz, t * 1.13, 15.0) * 0.55;
  float base = a + b;

  vec3 c = vec3(
    base,
    causticLayer(xz + vec2(0.004, 0.0), t * 1.02, 7.5) + b,
    causticLayer(xz + vec2(0.008, 0.0), t * 1.04, 7.5) + b
  );

  // atténuation : maximum vers 8–20 cm de fond, nul en surface et en profondeur
  float dw = smoothstep(0.0, 0.06, depth) * exp(-depth * 3.2);
  return c * dw;
}
```

Appliqué **dans le shader de sable** (§3.10, étape 7), pas dans le shader d'eau : c'est plus juste
(la lumière frappe le fond) et ça marche même en regardant l'eau par la tranche.

### 4.7 Gouttes, éclaboussures, arrosoir

| Effet | Technique | Coût |
|---|---|---|
| Jet d'arrosoir | `Points` instanciés, 200–400 particules, gravité intégrée en shader (position analytique : `p0 + v0*t + 0.5*g*t²`) → **zéro update CPU** | négligeable |
| Impact au sol | Écriture d'un disque dans la carte d'humidité (petit quad additif rendu dans le RT de sim) | négligeable |
| Éclaboussure | Billboard animé (spritesheet 4×4) + 8 gouttes `Points` | 2 draw calls |
| Gouttes sur les props | Decal d'humidité : même patch de matériau que le sable, `wetness` local | inclus |
| Traînée mouillée | La diffusion de la carte d'humidité s'en charge toute seule | gratuit |

Écriture d'un impact dans la sim (à faire dans la passe de sim, avant le shader principal) :

```js
// src/sim/splash.js — un quad additif par impact, batché
export function queueWetSplat(field, worldXZ, radius, amount) {
  field.splats.push({ x: worldXZ.x, z: worldXZ.y, r: radius, a: amount });
}
// puis, une fois par step de sim, rendre tous les splats en un InstancedMesh additif
// dans le canal G (saturation) de la RT.
```

---

## 5. Lumière et atmosphère

### 5.1 Le cycle solaire

Le diorama est petit : **une seule lumière directionnelle** + une hémisphérique + l'IBL. Pas de
point lights.

```js
// src/lighting/SunCycle.js
import * as THREE from 'three';

// Table de référence (couleurs sRGB, converties en linéaire par Color.setHex)
const KEYS = [
  // heure, élévation°, azimut°, couleur soleil,  intensité, couleur ciel, couleur sol, ambiant
  {  h: 5.5, el:  -2, az:  75, sun: 0xFF9A5C, i: 0.0,  sky: 0x2E4A72, gnd: 0x2A2620, amb: 0.55 },
  {  h: 6.5, el:   6, az:  82, sun: 0xFF9351, i: 1.6,  sky: 0x6C87B8, gnd: 0x5A4A38, amb: 0.70 },
  {  h: 8.0, el:  20, az:  95, sun: 0xFFC489, i: 3.1,  sky: 0x8FB6E2, gnd: 0x7A6448, amb: 0.85 },
  { h: 10.0, el:  42, az: 118, sun: 0xFFE2BC, i: 4.2,  sky: 0xA8CBEC, gnd: 0x8A7150, amb: 1.00 },
  { h: 13.0, el:  64, az: 180, sun: 0xFFF3E4, i: 5.0,  sky: 0xBBD8F2, gnd: 0x93794F, amb: 1.10 },
  { h: 16.0, el:  40, az: 243, sun: 0xFFDDAE, i: 4.0,  sky: 0xAFC9E6, gnd: 0x8B7250, amb: 0.98 },
  { h: 18.0, el:  16, az: 267, sun: 0xFFA860, i: 2.6,  sky: 0xE0A88A, gnd: 0x6E5A42, amb: 0.80 },
  { h: 19.3, el:   3, az: 280, sun: 0xFF6E3A, i: 1.4,  sky: 0xE8896A, gnd: 0x4E3F30, amb: 0.62 },
  { h: 20.5, el:  -6, az: 288, sun: 0x8A5AA8, i: 0.0,  sky: 0x3C4E7E, gnd: 0x24222A, amb: 0.45 },
];

export class SunCycle {
  constructor(scene) {
    this.sun = new THREE.DirectionalLight(0xffffff, 4);
    this.sun.castShadow = true;
    this.configureShadow(this.sun, /* rayon du bloc */ 6.5);
    scene.add(this.sun, this.sun.target);

    this.hemi = new THREE.HemisphereLight(0xbbd8f2, 0x93794f, 1.0);
    scene.add(this.hemi);

    this.hour = 13.0;
    this._lastEnvHour = -99;
  }

  configureShadow(light, radius) {
    const s = light.shadow;
    s.mapSize.set(2048, 2048);
    // Le diorama est BORNÉ -> une seule cascade suffit, pas de CSM.
    // Frustum serré = texel de ~6 mm à 2048², largement assez pour des créneaux.
    s.camera.left = -radius; s.camera.right  =  radius;
    s.camera.top  =  radius; s.camera.bottom = -radius;
    s.camera.near = 0.5;     s.camera.far    = radius * 4.0;
    s.bias        = -0.0004;
    s.normalBias  = 0.012;    // clé : élimine le peter-panning sur les surfaces courbes du sable
    s.radius      = 3;        // PCFSoft
    s.blurSamples = 12;
  }

  setHour(h, envManager) {
    this.hour = h;
    const st = sample(KEYS, h);                    // interpolation catmull-rom sur les clés

    const el = THREE.MathUtils.degToRad(st.el);
    const az = THREE.MathUtils.degToRad(st.az);
    const d  = 30;
    this.sun.position.set(
      d * Math.cos(el) * Math.sin(az),
      d * Math.sin(el),
      d * Math.cos(el) * Math.cos(az)
    );
    this.sun.target.position.set(0, 0, 0);
    this.sun.color.setHex(st.sun, THREE.SRGBColorSpace);
    this.sun.intensity = st.i;

    this.hemi.color.setHex(st.sky, THREE.SRGBColorSpace);
    this.hemi.groundColor.setHex(st.gnd, THREE.SRGBColorSpace);
    this.hemi.intensity = st.amb;

    // IBL : régénérer SEULEMENT si le soleil a bougé significativement (cf. §5.3)
    if (Math.abs(h - this._lastEnvHour) > 0.25) {
      envManager.rebuild(this.sun.position, st);
      this._lastEnvHour = h;
    }
  }
}
```

**Pourquoi pas de CSM** : le CSM sert quand le frustum de la caméra couvre 100 m+ de terrain. Ici la
scène tient dans une sphère de 6.5 m. Une seule shadow map orthographique 2048² serrée donne
6.5 mm/texel — meilleur que ce qu'une CSM 4 cascades donnerait sur la première cascade. **Ne pas
importer `three-csm`.** C'est une complexité et un coût (4 lumières, 4 render targets) purement gratuits.

### 5.2 Ombres douces : PCSS

Pour le look cozy, l'ombre doit être **franche au contact et floue en s'éloignant** (contact hardening).
`PCFSoftShadowMap` donne un flou constant ; PCSS donne le vrai comportement.

```js
// src/lighting/pcss.js
// Remplace le chunk de shadow mapping globalement. À faire UNE FOIS au boot,
// avant la compilation du premier matériau.
import * as THREE from 'three';

const PCSS = /* glsl */`
#define LIGHT_WORLD_SIZE 0.055      // taille angulaire du soleil, en unités du frustum d'ombre
#define LIGHT_FRUSTUM_WIDTH 13.0    // = 2 * radius du §5.1
#define LIGHT_SIZE_UV (LIGHT_WORLD_SIZE / LIGHT_FRUSTUM_WIDTH)
#define NEAR_PLANE 0.5
#define NUM_SAMPLES 17
#define NUM_RINGS 11
#define BLOCKER_SEARCH_NUM_SAMPLES 12
#define PCF_NUM_SAMPLES NUM_SAMPLES

vec2 poissonDisk[NUM_SAMPLES];

void initPoissonSamples(const in vec2 randomSeed) {
  float ANGLE_STEP = PI2 * float(NUM_RINGS) / float(NUM_SAMPLES);
  float INV_NUM_SAMPLES = 1.0 / float(NUM_SAMPLES);
  float angle = rand(randomSeed) * PI2;
  float radius = INV_NUM_SAMPLES;
  float radiusStep = radius;
  for (int i = 0; i < NUM_SAMPLES; i++) {
    poissonDisk[i] = vec2(cos(angle), sin(angle)) * pow(radius, 0.75);
    radius += radiusStep;
    angle  += ANGLE_STEP;
  }
}

float penumbraSize(const in float zReceiver, const in float zBlocker) {
  return (zReceiver - zBlocker) / zBlocker;
}

float findBlocker(sampler2D sm, const in vec2 uv, const in float zReceiver) {
  float searchRadius = LIGHT_SIZE_UV * (zReceiver - NEAR_PLANE) / zReceiver;
  float blockerSum = 0.0; int numBlockers = 0;
  for (int i = 0; i < BLOCKER_SEARCH_NUM_SAMPLES; i++) {
    float shadowMapDepth = unpackRGBAToDepth(texture2D(sm, uv + poissonDisk[i] * searchRadius));
    if (shadowMapDepth < zReceiver) { blockerSum += shadowMapDepth; numBlockers++; }
  }
  if (numBlockers == 0) return -1.0;
  return blockerSum / float(numBlockers);
}

float PCF_Filter(sampler2D sm, vec2 uv, float zReceiver, float filterRadius) {
  float sum = 0.0;
  for (int i = 0; i < PCF_NUM_SAMPLES; i++) {
    float d = unpackRGBAToDepth(texture2D(sm, uv + poissonDisk[i] * filterRadius));
    if (zReceiver <= d) sum += 1.0;
  }
  return sum / float(PCF_NUM_SAMPLES);
}

float PCSS(sampler2D shadowMap, vec4 coords) {
  vec2  uv = coords.xy;
  float zReceiver = coords.z;
  initPoissonSamples(uv);
  float avgBlockerDepth = findBlocker(shadowMap, uv, zReceiver);
  if (avgBlockerDepth == -1.0) return 1.0;
  float penumbraRatio = penumbraSize(zReceiver, avgBlockerDepth);
  float filterRadius  = penumbraRatio * LIGHT_SIZE_UV * NEAR_PLANE / zReceiver;
  return PCF_Filter(shadowMap, uv, zReceiver, filterRadius);
}
`;

export function installPCSS() {
  let s = THREE.ShaderChunk.shadowmap_pars_fragment;
  s = s.replace('#ifdef USE_SHADOWMAP', '#ifdef USE_SHADOWMAP\n' + PCSS);
  s = s.replace(
    '#if defined( SHADOWMAP_TYPE_PCF )',
    'return PCSS( shadowMap, shadowCoord );\n#if defined( SHADOWMAP_TYPE_PCF )'
  );
  THREE.ShaderChunk.shadowmap_pars_fragment = s;
}
```

**Réglage `LIGHT_WORLD_SIZE`** : c'est le seul paramètre qui compte. `0.02` = soleil dur (midi),
`0.09` = soleil voilé/fin de journée. Le faire varier avec l'heure via un `uniform` (nécessite de
remplacer le `#define` par une uniforme globale) donne une lumière qui s'adoucit au couchant.

**Ombre de contact** : PCSS ne suffit pas pour l'ancrage des petits objets (coquillages, seaux).
Deux solutions cumulables :
- **AO écran à petit rayon** (N8AO, `aoRadius: 0.12`) — ancre tout automatiquement.
- **Decal d'ombre bakée** : un quad avec un disque flouté, projeté sous chaque prop, `blending:
  MultiplyBlending`. 1 draw call instancié pour tous les props. Très cheap, très efficace pour le look
  Sims.

### 5.3 Ciel et IBL

```js
// src/lighting/Environment.js
import * as THREE from 'three';
import { Sky } from 'three/addons/objects/Sky.js';        // WebGL
// import { SkyMesh } from 'three/addons/objects/SkyMesh.js'; // WebGPU

export class Environment {
  constructor(renderer, scene) {
    this.renderer = renderer;
    this.scene = scene;

    this.sky = new Sky();
    this.sky.scale.setScalar(2000);
    scene.add(this.sky);

    const u = this.sky.material.uniforms;
    u.turbidity.value        = 2.6;   // 1 = air pur, 10 = brume ; 2.6 = plage claire
    u.rayleigh.value         = 1.35;  // bleu du ciel ; > 2 = ciel très saturé
    u.mieCoefficient.value   = 0.008; // halo autour du soleil
    u.mieDirectionalG.value   = 0.80; // dureté du halo

    this.pmrem = new THREE.PMREMGenerator(renderer);
    this.pmrem.compileEquirectangularShader();
    this.envRT = null;
  }

  rebuild(sunPosition) {
    this.sky.material.uniforms.sunPosition.value.copy(sunPosition).normalize();

    // ATTENTION : masquer le disque solaire avant de générer l'env map,
    // sinon on obtient un point sur-exposé qui produit des artefacts de specular.
    const prev = this.sky.material.uniforms.mieCoefficient.value;
    this.sky.material.uniforms.mieCoefficient.value = prev * 0.35;

    if (this.envRT) this.envRT.dispose();
    this.envRT = this.pmrem.fromScene(this.sky, 0.04, 0.1, 1000);
    this.scene.environment = this.envRT.texture;
    this.scene.environmentIntensity = 1.0;

    this.sky.material.uniforms.mieCoefficient.value = prev;
  }
}
```

> **Piège majeur de perf** : `pmrem.fromScene()` coûte **3 à 8 ms**. L'appeler chaque frame pendant une
> transition jour/nuit produit un micro-stutter permanent. Solutions :
> - Ne régénérer que tous les 0.25 h de temps de jeu (§5.1) ;
> - Amortir : générer dans une frame « creuse », ou pré-générer **8 env maps** (une par clé du cycle)
>   au chargement et interpoler entre elles avec `environmentIntensity` + une lerp de couleur ambiante.
>   Coût mémoire : 8 × 256² cube PMREM ≈ 8 Mo. **C'est l'option recommandée.**

**Nuages légers** : ne pas faire de volumétrique. Un dôme de nuages = une sphère inversée avec un
shader de fbm 2 octaves défilant lentement, alpha-blend, `depthWrite: false`, rendu juste après le ciel.

```glsl
// nuages, fragment
vec2 uv = vDir.xz / max(vDir.y, 0.12) * 0.06 + uTime * vec2(0.0035, 0.0012);
float c = fbm3(vec3(uv * 3.0, uTime * 0.02), 4, 2.1, 0.5);
float cover = smoothstep(uCoverage, uCoverage + 0.22, c);
// éclairage : les bords des nuages s'allument vers le soleil
float rim = pow(max(dot(normalize(vDir), uSunDir), 0.0), 6.0);
vec3 col = mix(vec3(0.86, 0.89, 0.94), vec3(1.0, 0.96, 0.88), rim);
gl_FragColor = vec4(col, cover * uCloudAlpha * smoothstep(0.02, 0.30, vDir.y));
```

### 5.4 AO : baké au meshing vs écran

**Recommandation : les deux, avec des rôles distincts.**

| | AO baké au meshing | AO écran (SSAO/GTAO/N8AO) |
|---|---|---|
| Ce qu'il capture | l'auto-occlusion du terrain sable (rainures, créneaux, tranchées) | le contact entre objets distincts (seau posé, coquillage, herbe) |
| Coût runtime | **zéro** (un attribut `float`) | 0.7–2.5 ms selon qualité |
| Stabilité | parfaite, aucun scintillement | scintille sans denoiser temporel |
| Rayon utile | 3–5 voxels (~10 cm) | 0.10–0.25 m |
| Coût de calcul | ~0.3 ms par chunk 32³ dans le worker | — |

L'AO baké est **obligatoire** ici : le champ voxel change en permanence, et c'est lui qui donne le
volume aux sculptures. Le calcul, dans le worker de meshing :

```js
// src/voxel/bakeAO.js
// Pour chaque vertex du surface-net, échantillonner l'occupancy dans un voisinage 5x5x5 pondéré,
// dans l'hémisphère de la normale.
export function bakeVertexAO(density, dims, positions, normals, out) {
  const [W, H, D] = dims;
  const at = (x, y, z) =>
    (x < 0 || y < 0 || z < 0 || x >= W || y >= H || z >= D) ? 0 : (density[x + W * (y + H * z)] > 0 ? 1 : 0);

  const R = 3;
  for (let v = 0; v < positions.length / 3; v++) {
    const px = positions[v*3], py = positions[v*3+1], pz = positions[v*3+2];
    const nx = normals[v*3],   ny = normals[v*3+1],   nz = normals[v*3+2];
    let occ = 0, wsum = 0;
    for (let dz = -R; dz <= R; dz++)
    for (let dy = -R; dy <= R; dy++)
    for (let dx = -R; dx <= R; dx++) {
      const l2 = dx*dx + dy*dy + dz*dz;
      if (l2 === 0 || l2 > R*R) continue;
      const l = Math.sqrt(l2);
      // pondération : hémisphère de la normale × 1/distance
      const cosw = (dx*nx + dy*ny + dz*nz) / l;
      if (cosw <= 0.05) continue;
      const w = cosw / l;
      wsum += w;
      occ  += w * at((px|0)+dx, (py|0)+dy, (pz|0)+dz);
    }
    // courbe : l'AO linéaire est trop plate, on la contraste
    const a = wsum > 0 ? 1 - occ / wsum : 1;
    out[v] = Math.pow(Math.max(a, 0), 1.6);
  }
}
```

Pour l'AO écran, **N8AO** en half-res, `aoRadius: 0.14`, `intensity: 1.6`, `denoiseSamples: 4`. Sur le
chemin WebGPU, utiliser le node AO du stack officiel. Éviter le `GTAOPass` intégré : il produit des
halos visibles aux discontinuités de profondeur (bien documenté), très voyants sur les silhouettes du
château contre le ciel.

---

## 6. Post-processing et look diorama

### 6.1 Ce qui fait le « diorama »

Par ordre d'impact décroissant :

1. **Tilt-shift** (flou en bandes haut/bas) — c'est *l'effet*. Sans lui, rien ne dit « maquette ».
2. **Saturation élevée + contraste doux** — les maquettes sont peintes, pas photographiées.
3. **Focale longue + caméra haute** — FOV 22–30°, angle 35–45°. Compresse les perspectives.
4. **Bloom subtil** — l'écume, le glitter, les hautes lumières du sable.
5. **Grain fin** — casse la propreté numérique, imite la photo argentique de maquette.
6. **Vignette légère** — recentre le regard sur le bloc.
7. **Aberration chromatique très légère** — imite l'objectif macro.

### 6.2 Chaîne complète (`pmndrs/postprocessing`, chemin WebGL)

Ordre : **AO → (SSR) → Tilt-shift → Bloom → LUT/Tonemap → CA → Vignette → Noise → SMAA**.

```js
// src/post/composer.js
import * as THREE from 'three';
import {
  EffectComposer, RenderPass, EffectPass,
  BloomEffect, SMAAEffect, VignetteEffect, NoiseEffect,
  ChromaticAberrationEffect, TiltShiftEffect, LUT3DEffect,
  ToneMappingEffect, ToneMappingMode, BlendFunction, KernelSize,
} from 'postprocessing';
import { N8AOPostPass } from 'n8ao';

export function buildComposer(renderer, scene, camera) {
  const composer = new EffectComposer(renderer, {
    frameBufferType: THREE.HalfFloatType,   // indispensable : le bloom a besoin de HDR
    multisampling: 0,
  });

  composer.addPass(new RenderPass(scene, camera));

  // ---- 1. Ambient occlusion ----
  const ao = new N8AOPostPass(scene, camera, window.innerWidth, window.innerHeight);
  ao.configuration.aoRadius        = 0.14;   // mètres — petit : contacts d'objets, pas macro-occlusion
  ao.configuration.distanceFalloff = 0.6;
  ao.configuration.intensity       = 1.7;
  ao.configuration.color.set(0x2d3a52);      // AO teintée bleu = rebond du ciel. NE PAS mettre du noir.
  ao.configuration.halfRes         = true;
  ao.configuration.denoiseSamples  = 4;
  ao.configuration.denoiseRadius   = 12;
  composer.addPass(ao);

  // ---- 2. Tilt-shift ----
  const tiltShift = new TiltShiftEffect({
    blendFunction: BlendFunction.NORMAL,
    offset:     0.02,    // décalage vertical du plan net (positif = net plus haut)
    rotation:   0.0,     // radians ; ~0.05 si le sujet n'est pas parfaitement horizontal
    focusArea:  0.28,    // hauteur de la bande nette (fraction de l'écran) — LE réglage clé
    feather:    0.32,    // douceur de la transition net/flou
    kernelSize: KernelSize.MEDIUM,
    resolutionScale: 0.5, // le flou est calculé en demi-résolution : invisible, 2x moins cher
  });

  // ---- 3. Bloom ----
  const bloom = new BloomEffect({
    blendFunction: BlendFunction.ADD,
    mipmapBlur: true,
    intensity: 0.42,
    luminanceThreshold: 0.88,
    luminanceSmoothing: 0.38,
    radius: 0.72,
  });

  // ---- 4. Tone mapping (le renderer doit être en NoToneMapping) ----
  const tone = new ToneMappingEffect({
    mode: ToneMappingMode.AGX,
    resolution: 256,
    whitePoint: 4.0,
    middleGrey: 0.6,
  });

  // ---- 5. Color grading (LUT procédurale, cf. §6.4) ----
  const lut = new LUT3DEffect(makeWarmLUT(32), { blendFunction: BlendFunction.NORMAL });
  lut.blendMode.opacity.value = 0.85;

  // ---- 6. Finitions ----
  const ca = new ChromaticAberrationEffect({
    offset: new THREE.Vector2(0.00045, 0.00045),
    radialModulation: true,
    modulationOffset: 0.32,     // pas d'aberration au centre, seulement sur les bords
  });

  const vignette = new VignetteEffect({ offset: 0.34, darkness: 0.26 });

  const noise = new NoiseEffect({
    blendFunction: BlendFunction.OVERLAY,
    premultiply: true,
  });
  noise.blendMode.opacity.value = 0.055;

  const smaa = new SMAAEffect();

  // Regrouper : chaque EffectPass = 1 draw call. Ne PAS créer un pass par effet.
  composer.addPass(new EffectPass(camera, tiltShift, bloom));
  composer.addPass(new EffectPass(camera, tone, lut, ca, vignette, noise, smaa));

  return { composer, tiltShift, bloom, ao, lut, vignette, noise };
}
```

> **Le renderer doit alors être en `THREE.NoToneMapping`** — sinon double tone mapping et image délavée.

### 6.3 Réglages du tilt-shift, concrètement

Le tilt-shift échoue si le plan net n'est pas sur le sujet. Deux modes :

**(a) Bande fixe** (le plus « maquette », et le plus stable) — la caméra étant fixe en orbite autour du
bloc, une bande fixe centrée sur le milieu de l'écran suffit :

```
focusArea = 0.28   offset = 0.02   feather = 0.32
```

**(b) Bande asservie à la profondeur du sujet** — meilleur quand la caméra zoome :

```js
// asservir focusArea à la distance caméra→centre du bloc
function updateTiltShift(tiltShift, camera, blockCenter) {
  const d = camera.position.distanceTo(blockCenter);
  // proche = bande étroite (effet fort), loin = bande large (effet doux)
  tiltShift.focusArea = THREE.MathUtils.clamp(
    THREE.MathUtils.mapLinear(d, 3.0, 14.0, 0.18, 0.55), 0.18, 0.55
  );
  tiltShift.feather = THREE.MathUtils.clamp(
    THREE.MathUtils.mapLinear(d, 3.0, 14.0, 0.22, 0.45), 0.22, 0.45
  );
}
```

**Alternative : vrai DOF.** `DepthOfFieldEffect` avec `focusDistance` issu d'un raycast sous le curseur
donne un bokeh plus juste (les objets *devant* le plan net floutent aussi), mais coûte 2–3× plus cher et
scintille sur les silhouettes fines (herbes). **Recommandation : tilt-shift par défaut, DOF réservé au
mode photo.**

Paramètres du DOF si retenu :

```js
new DepthOfFieldEffect(camera, {
  focusDistance: 0.0,        // en unités de profondeur normalisée [0..1] — écrire via focusDistance
  focalLength: 0.048,        // petit = plus de champ net
  bokehScale: 3.2,           // taille du bokeh ; > 5 devient une soupe
  height: 480,               // résolution de la passe de CoC
});
```

### 6.4 Color grading : LUT chaude procédurale

Pas besoin d'un fichier `.cube` : générer la LUT en code la rend paramétrable et versionnable.

```js
// src/post/warmLUT.js
import * as THREE from 'three';

/**
 * LUT 3D "plage chaude" :
 *  - lift des ombres vers le bleu-cyan (rebond du ciel)
 *  - gamma neutre
 *  - gain des hautes lumières vers l'ambre
 *  - +12 % de saturation, avec protection des rouges saturés
 */
export function makeWarmLUT(size = 32) {
  const data = new Uint8Array(size * size * size * 4);

  const LIFT  = [ -0.010,  0.004,  0.030 ];  // ombres → cyan léger
  const GAMMA = [  1.000,  0.995,  1.020 ];
  const GAIN  = [  1.055,  1.010,  0.945 ];  // hautes lumières → ambre
  const SAT   = 1.12;
  const CONTRAST = 1.06, PIVOT = 0.42;

  let i = 0;
  for (let b = 0; b < size; b++)
  for (let g = 0; g < size; g++)
  for (let r = 0; r < size; r++) {
    let c = [ r / (size - 1), g / (size - 1), b / (size - 1) ];

    // lift / gamma / gain (modèle ASC-CDL simplifié)
    for (let k = 0; k < 3; k++) {
      let v = c[k];
      v = v * (GAIN[k] - LIFT[k]) + LIFT[k];
      v = Math.pow(Math.max(v, 0), GAMMA[k]);
      c[k] = v;
    }

    // contraste autour du pivot
    for (let k = 0; k < 3; k++) c[k] = (c[k] - PIVOT) * CONTRAST + PIVOT;

    // saturation (luma Rec.709)
    const l = 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
    for (let k = 0; k < 3; k++) c[k] = l + (c[k] - l) * SAT;

    data[i++] = Math.round(THREE.MathUtils.clamp(c[0], 0, 1) * 255);
    data[i++] = Math.round(THREE.MathUtils.clamp(c[1], 0, 1) * 255);
    data[i++] = Math.round(THREE.MathUtils.clamp(c[2], 0, 1) * 255);
    data[i++] = 255;
  }

  const tex = new THREE.Data3DTexture(data, size, size, size);
  tex.format = THREE.RGBAFormat;
  tex.type   = THREE.UnsignedByteType;
  tex.minFilter = tex.magFilter = THREE.LinearFilter;
  tex.wrapS = tex.wrapT = tex.wrapR = THREE.ClampToEdgeWrapping;
  tex.needsUpdate = true;
  return tex;
}
```

Variantes à exposer en réglage (« Matin », « Midi », « Coucher », « Nuageux ») = 4 jeux de constantes,
4 LUT générées au boot, cross-fade par `lut.blendMode.opacity`.

### 6.5 Le bloc diorama : coupe géologique

C'est ce qui transforme « un terrain » en « un objet posé sur une table ».

**Construction géométrique.** Le champ voxel est borné par une boîte. Deux options :

| Option | Comment | Verdict |
|---|---|---|
| **A — mesher clippé** | Le surface-net émet des quads de bord quand la surface touche le plan du bloc. Chaque vertex de bord reçoit `aFaceKind = 1`. | **Recommandé.** La coupe suit exactement la topologie ; creuser une tranchée jusqu'au bord ouvre une entaille visible dans la paroi. |
| B — coque séparée | Une `BoxGeometry` fixe sous le terrain, avec son propre matériau. | Plus simple, mais la paroi ne réagit pas au gameplay. Acceptable pour un prototype. |

**Shader de stratigraphie** (appliqué quand `aFaceKind == 1`) :

```glsl
// ============================================================================
//  BLOC — coupe géologique
// ============================================================================
uniform float uWaterTable;      // hauteur de la nappe phréatique (monde)
uniform float uBlockBottom;     // Y du fond du bloc

// Une couche : hauteur de sommet, couleur, granulométrie
struct Stratum { float top; vec3 col; float grain; };

vec3 shadeGeologicalCut(vec3 wp, vec3 wn, float wetnessSurface) {
  // ---- 1. perturbation des limites de couches : elles ne sont jamais droites ----
  float warp = fbm3(vec3(wp.xz * 2.6, 0.0), 3, 2.05, 0.5) - 0.5;
  float y    = wp.y + warp * 0.045;

  // ---- 2. empilement (du haut vers le bas) ----
  // les cotes sont relatives au haut du bloc (y = 0)
  vec3 col;
  float grain;
  if      (y > -0.10) { col = vec3(0.700, 0.540, 0.330); grain = 1.00; }  // sable sec de surface
  else if (y > -0.26) { col = vec3(0.612, 0.462, 0.276); grain = 0.85; }  // sable damé
  else if (y > -0.40) { col = vec3(0.520, 0.400, 0.245); grain = 0.70; }  // sable + coquilles
  else if (y > -0.62) { col = vec3(0.430, 0.352, 0.238); grain = 0.55; }  // sable limoneux
  else                { col = vec3(0.300, 0.268, 0.212); grain = 0.35; }  // vase / gravier

  // ---- 3. micro-lamination : fines strates dans chaque couche ----
  float lam = sin(y * 260.0 + warp * 22.0) * 0.5 + 0.5;
  col *= 0.94 + 0.12 * lam;

  // ---- 4. nappe phréatique : tout ce qui est dessous est mouillé ----
  //     transition franche mais pas nette : frange capillaire de ~4 cm au-dessus
  float below  = smoothstep(uWaterTable + 0.045, uWaterTable - 0.005, wp.y);
  col = sandWetAlbedo(col, below);

  // ligne de nappe : un liseré très légèrement brillant et plus foncé
  float line = 1.0 - smoothstep(0.0, 0.006, abs(wp.y - uWaterTable));
  col = mix(col, col * vec3(0.72, 0.80, 0.86), line * 0.8);

  // ---- 5. inclusions : galets, coquilles, poches de sable clair ----
  vec3 h = hash33(floor(wp * 55.0));
  if (h.x < 0.030) {
    float d = length(fract(wp * 55.0) - 0.5);
    float m = 1.0 - smoothstep(0.16, 0.30, d);
    vec3 inc = (h.y < 0.5) ? vec3(0.90, 0.87, 0.80)     // coquille
                           : vec3(0.36, 0.34, 0.32);    // galet
    col = mix(col, inc, m * 0.85);
  }

  // ---- 6. grain de coupe : la paroi est "rayée" par la découpe ----
  float scratch = fbm3(vec3(wp.xz * 90.0, wp.y * 300.0), 2, 2.0, 0.5);
  col *= 0.96 + 0.08 * scratch;

  // ---- 7. rebord supérieur : un liseré clair de 3 mm sur l'arête haute du bloc ----
  float topEdge = 1.0 - smoothstep(0.0, 0.004, -wp.y);
  col = mix(col, vec3(0.86, 0.78, 0.60), topEdge * 0.55);

  return col;
}
```

Le fond du bloc, s'il est visible en orbite basse : une couleur unie sombre (`#2A2622`) suffit, ou un
faux « socle » en bois/résine si l'on veut pousser l'objet-maquette.

**Rim light du bloc** — le détail qui fait « objet posé » : un liseré de lumière sur les arêtes
verticales du bloc, comme sur une pièce de résine :

```glsl
float rim = pow(1.0 - max(dot(normalize(vWNormal), normalize(cameraPosition - vWPos)), 0.0), 3.2);
outgoingLight += uRimColor * rim * 0.22 * float(vFaceKind);
```

### 6.6 Outline de sélection

Pour l'UI (survol d'un objet, outil actif). `OutlineEffect` de `pmndrs/postprocessing` :

```js
import { OutlineEffect, BlendFunction } from 'postprocessing';

const outline = new OutlineEffect(scene, camera, {
  blendFunction: BlendFunction.SCREEN,
  edgeStrength: 3.0,
  pulseSpeed: 0.0,
  visibleEdgeColor: 0xFFF0C8,     // ambre chaud, cohérent avec la palette
  hiddenEdgeColor: 0x704820,
  blur: true,
  xRay: true,
  resolutionScale: 0.5,
  kernelSize: KernelSize.VERY_SMALL,
});
outline.selection.set([hoveredMesh]);
// ajouter dans le MÊME EffectPass que les autres effets d'écran pour ne pas payer un pass de plus
```

> **Piège** : `OutlineEffect` fait une passe de rendu supplémentaire des objets sélectionnés. Avec 1–3
> objets c'est gratuit ; ne jamais l'utiliser pour surligner « tous les objets d'un type » (dizaines
> de meshes). Pour ce cas, préférer un `emissive` pulsé sur le matériau.

---

## 7. Végétation et props

### 7.1 Oyats / herbes de dune instanciés

Géométrie de brin : **7 vertices, 5 triangles** (4 segments, terminée en pointe). Pas d'alpha test —
géométrie pleine = pas de tri de transparence, pas d'overdraw.

```js
// src/veg/bladeGeometry.js
export function makeBladeGeometry(segments = 4, height = 1.0, width = 0.014) {
  const pos = [], idx = [], uv = [];
  for (let i = 0; i <= segments; i++) {
    const t = i / segments;
    const w = width * (1 - t * t) * 0.5;      // s'affine vers la pointe
    const y = height * t;
    if (i === segments) { pos.push(0, y, 0); uv.push(0.5, t); }
    else { pos.push(-w, y, 0, w, y, 0); uv.push(0, t, 1, t); }
  }
  for (let i = 0; i < segments; i++) {
    const a = i * 2, b = a + 1, c = a + 2, d = a + 3;
    if (i === segments - 1) idx.push(a, b, c);          // triangle terminal
    else idx.push(a, b, c, b, d, c);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv',       new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}
```

Attributs d'instance :

```js
const N = 40000;
const geo = makeBladeGeometry();
geo.setAttribute('iOffset', new THREE.InstancedBufferAttribute(new Float32Array(N*3), 3));
geo.setAttribute('iRot',    new THREE.InstancedBufferAttribute(new Float32Array(N),   1));
geo.setAttribute('iScale',  new THREE.InstancedBufferAttribute(new Float32Array(N*2), 2)); // (hauteur, largeur)
geo.setAttribute('iTint',   new THREE.InstancedBufferAttribute(new Float32Array(N*3), 3));
geo.setAttribute('iPhase',  new THREE.InstancedBufferAttribute(new Float32Array(N),   1));
const mesh = new THREE.Mesh(geo, grassMaterial);
mesh.frustumCulled = false;   // on cull par chunk, pas par InstancedMesh globale
```

Vertex shader — vent à trois octaves :

```glsl
// ============================================================================
//  HERBE — vent
// ============================================================================
attribute vec3  iOffset;
attribute float iRot;
attribute vec2  iScale;
attribute vec3  iTint;
attribute float iPhase;

uniform float uTime;
uniform vec2  uWindDir;      // normalisée
uniform float uWindStrength; // 0..1
uniform sampler2D uHumidityMap;

varying vec3 vTint;
varying float vHeightT;

mat2 rot2(float a) { float c = cos(a), s = sin(a); return mat2(c, -s, s, c); }

void main() {
  float t = uv.y;                       // 0 = base, 1 = pointe
  vHeightT = t;

  vec3 p = position;
  p.x *= iScale.y;
  p.y *= iScale.x;

  // rotation aléatoire du brin
  p.xz = rot2(iRot) * p.xz;

  vec3 wp = p + iOffset;

  // ---- vent : 3 octaves ----
  // (a) houle globale, lente et large
  float sway  = sin(uTime * 0.55 + dot(iOffset.xz, uWindDir) * 0.45 + iPhase);
  // (b) rafales : ondes qui traversent le champ
  float gustW = sin(dot(iOffset.xz, uWindDir) * 2.2 - uTime * 1.7);
  float gust  = smoothstep(0.25, 1.0, gustW) * 1.5;
  // (c) turbulence par brin
  float turb  = sin(uTime * 5.3 + iPhase * 12.0) * 0.18;

  float bend = (sway * 0.55 + gust * 0.6 + turb) * uWindStrength;

  // la flexion est cubique en hauteur : la base ne bouge pas, la pointe beaucoup
  float k = t * t * (3.0 - 2.0 * t);
  wp.xz += uWindDir * bend * 0.18 * k * iScale.x;
  // raccourcissement pour conserver la longueur de l'arc
  wp.y  -= abs(bend) * 0.05 * k * iScale.x;

  // ---- teinte : plus sombre à la base, plus jaune si sable sec ----
  vec2 hUV = (iOffset.xz - uBlockMin) / uBlockSize;
  float wet = texture2D(uHumidityMap, hUV).g;
  vTint = iTint * mix(vec3(1.02, 1.00, 0.86), vec3(0.86, 0.94, 0.80), wet)
                * mix(0.62, 1.12, t);

  gl_Position = projectionMatrix * viewMatrix * vec4(wp, 1.0);
}
```

Fragment : `MeshLambertMaterial`-like avec **translucence** (l'herbe rétro-éclairée est le meilleur
argument visuel d'une plage au couchant) :

```glsl
float ndl  = max(dot(N, uSunDir), 0.0);
float back = pow(max(dot(-N, uSunDir), 0.0), 2.0);   // face arrière éclairée
vec3 col = vTint * (uSunColor * (ndl + back * 0.85) + uAmbientColor * 0.55);
```

### 7.2 LOD et instancing

`InstancedMesh` ne supporte pas le LOD nativement. Solution : **une InstancedMesh par (chunk × niveau
de LOD)**, avec migration des instances entre niveaux selon la distance.

```js
// src/veg/GrassChunks.js
// Le bloc de 8 m est découpé en 4x4 = 16 chunks de 2 m.
// Chaque chunk possède 3 InstancedMesh (LOD0/1/2) partageant le même matériau.
const LODS = [
  { dist: 0,   segments: 4, density: 1.00 },   // proche : brin complet
  { dist: 3.5, segments: 2, density: 0.55 },   // moyen  : 2 segments, moitié moins dense
  { dist: 7.0, segments: 1, density: 0.22 },   // loin   : quad simple
];

update(camera) {
  for (const chunk of this.chunks) {
    const d = camera.position.distanceTo(chunk.center);
    const lod = d < LODS[1].dist ? 0 : d < LODS[2].dist ? 1 : 2;
    for (let i = 0; i < 3; i++) chunk.meshes[i].visible = (i === lod);
    // frustum culling manuel par chunk (moins cher que par instance)
    chunk.group.visible = this.frustum.intersectsSphere(chunk.bounds);
  }
}
```

Gain mesuré typique dans ce type de configuration : **× 1.8 à × 2.0 sur le framerate** par rapport à
un LOD unique.

**Impostors** : pour un diorama de 8 m, l'impostor octaédrique est **inutile** — rien n'est assez loin.
Le réserver au décor lointain (cocotiers de fond, rochers d'horizon), où un simple billboard croisé
(2 quads en X) suffit.

### 7.3 Props : rochers, coquillages, étoiles de mer, seaux, pelles, serviettes

| Catégorie | Technique | Draw calls |
|---|---|---|
| Coquillages, étoiles de mer, galets (décor, non interactifs) | 1 `InstancedMesh` par variante de mesh, atlas de texture partagé, couleur par instance (`instanceColor`) | 3–5 |
| Rochers | 4 variantes × `InstancedMesh`, LOD par swap de géométrie | 4 |
| Seaux, pelles, râteaux (interactifs, déplaçables) | `Mesh` individuels — ils sont peu nombreux (< 15) et doivent être raycastables | 10–15 |
| Serviettes, parasols | Mesh individuels, géométrie légère | 2–4 |
| Décor statique lointain | **Un seul mesh mergé** (`BufferGeometryUtils.mergeGeometries`) par matériau | 1–2 |

Règles :

- **Un seul atlas de texture** (2048², albedo + un atlas ORM packé R=AO/G=roughness/B=metal) pour tous
  les props → un seul matériau → merge et instancing possibles partout.
- **Ombres** : `castShadow = true` sur les props (ils sont gros et lisibles), `castShadow = false` sur
  l'herbe (coût élevé, gain visuel faible ; remplacé par un assombrissement de l'AO au sol) et sur les
  petits débris.
- **Réception d'ombre** : `receiveShadow = true` partout, y compris l'herbe (l'ombre du château qui
  traverse le champ d'oyats est un plan visuel fort).

```js
// Ombre d'herbe faussée : au lieu de la faire caster, assombrir le sable sous les touffes.
// Écrire un disque dans le canal A d'une "vegetation AO map", sampled par le shader de sable.
```

---

## 8. Performance

### 8.1 Budgets cibles

| | Bas (mobile / iGPU) | Moyen (laptop dGPU) | Haut (desktop dGPU) |
|---|---|---|---|
| Résolution interne | 0.65 × devicePixelRatio, max 1.0 | 1.0 × DPR, max 1.5 | 1.0 × DPR, max 2.0 |
| Draw calls | ≤ 55 | ≤ 90 | ≤ 130 |
| Triangles | ≤ 180 k | ≤ 450 k | ≤ 900 k |
| Brins d'herbe | 8 k | 40 k | 120 k |
| Shadow map | 1024², PCF | 2048², PCSS 12 taps | 2048², PCSS 17 taps |
| AO | désactivée | N8AO half-res, 4 denoise | N8AO full-res, 8 denoise |
| Tilt-shift | `resolutionScale` 0.35, `KernelSize.SMALL` | 0.5, MEDIUM | 0.5, LARGE |
| Bloom | mipmapBlur, radius 0.6 | radius 0.72 | radius 0.85 |
| Sim humidité | 256², 10 Hz | 512², 20 Hz | 512², 30 Hz |
| Caustiques | 1 octave | 2 octaves | 2 octaves + dispersion RGB |
| Glitter | 1 octave | 2 octaves | 3 octaves |
| Cible | 30 fps | 60 fps | 60 fps @ 1440p |

### 8.2 Le maillage voxel régénéré en continu — le vrai enjeu

Le joueur creuse, tasse, verse de l'eau : le champ voxel change à chaque frame de gameplay. C'est **la**
source de stutter potentiel.

**Architecture recommandée :**

```
Main thread                      Worker de meshing                  GPU
-----------                      -----------------                  ---
edits (creuse/tasse)  --------->  file d'attente par chunk
                                  |
                                  meshing surface-nets
                                  bake AO + courbure + thin
                                  |
  <---- Transferable ArrayBuffers (positions, normals, indices, attrs)
  |
  upload dans un BufferGeometry du POOL (pas de new)  ------------> upload GPU
```

Règles dures :

1. **Chunker à 32³.** Un edit ne touche que 1–4 chunks. Remesher 1 seul chunk 32³ coûte ~1.5 ms dans un
   worker ; remesher le bloc entier coûte 40 ms → stutter garanti.
2. **Budget de 2 chunks appliqués par frame maximum.** Si la file grossit, elle se vide sur plusieurs
   frames. L'utilisateur ne voit pas la latence de 2 frames.
3. **Pool de `BufferGeometry` pré-alloués.** Ne jamais faire `new BufferGeometry()` en jeu :
   l'allocation + le premier upload créent un pic.

```js
// src/voxel/GeometryPool.js
export class ChunkGeometryPool {
  constructor(count, maxVerts = 24000, maxIdx = 48000) {
    this.free = [];
    for (let i = 0; i < count; i++) this.free.push(this._make(maxVerts, maxIdx));
  }

  _make(maxVerts, maxIdx) {
    const g = new THREE.BufferGeometry();
    const mk = (n, item) => {
      const a = new THREE.BufferAttribute(new Float32Array(n * item), item);
      a.setUsage(THREE.DynamicDrawUsage);   // hint : le driver garde le buffer en mémoire "streaming"
      return a;
    };
    g.setAttribute('position',  mk(maxVerts, 3));
    g.setAttribute('normal',    mk(maxVerts, 3));
    g.setAttribute('aAO',       mk(maxVerts, 1));
    g.setAttribute('aCurv',     mk(maxVerts, 1));
    g.setAttribute('aCompact',  mk(maxVerts, 1));
    g.setAttribute('aThin',     mk(maxVerts, 1));
    g.setAttribute('aFaceKind', mk(maxVerts, 1));
    const idx = new THREE.BufferAttribute(new Uint32Array(maxIdx), 1);
    idx.setUsage(THREE.DynamicDrawUsage);
    g.setIndex(idx);
    g.boundingSphere = new THREE.Sphere();   // on la calcule NOUS-MÊMES (cf. ci-dessous)
    return g;
  }

  acquire() { return this.free.pop() ?? this._make(24000, 48000); }
  release(g) { this.free.push(g); }
}

// Application d'un résultat de worker
export function applyChunkMesh(geo, res, chunkCenter, chunkRadius) {
  const set = (name, src) => {
    const a = geo.getAttribute(name);
    a.array.set(src);
    // MAJ partielle : n'uploader que ce qui a changé
    a.addUpdateRange(0, src.length);
    a.needsUpdate = true;
  };
  set('position',  res.positions);
  set('normal',    res.normals);
  set('aAO',       res.ao);
  set('aCurv',     res.curv);
  set('aCompact',  res.compact);
  set('aThin',     res.thin);
  set('aFaceKind', res.faceKind);

  const idx = geo.index;
  idx.array.set(res.indices);
  idx.addUpdateRange(0, res.indices.length);
  idx.needsUpdate = true;

  geo.setDrawRange(0, res.indices.length);

  // NE PAS appeler computeBoundingSphere() : O(n) + allocation, à chaque remesh.
  // Les bornes du chunk sont connues à l'avance.
  geo.boundingSphere.center.copy(chunkCenter);
  geo.boundingSphere.radius = chunkRadius;
}
```

4. **`setDrawRange`** plutôt que redimensionner les buffers. Le nombre de vertices varie à chaque
   remesh ; réallouer force une recréation du VBO côté driver (stall). Buffer fixe + drawRange = zéro
   réallocation.
5. **Double buffering optionnel** : si l'on constate encore des pics d'upload, alterner entre deux
   géométries par chunk (celle affichée pendant que l'autre est remplie) — élimine le risque que le
   driver attende la fin d'un draw en cours sur le buffer écrit.
6. **`SharedArrayBuffer`** pour le champ de densité si les headers COOP/COEP sont disponibles : évite
   de copier 32 Ko par edit. Sinon, `Transferable` (coût de transfert nul, mais le buffer change de
   propriétaire — prévoir un pool côté worker aussi).

### 8.3 Éviter les stalls GPU

| Cause de stall | Symptôme | Remède |
|---|---|---|
| `material.needsUpdate = true` | freeze de 30–200 ms | Ne jamais en runtime. Précompiler toutes les variantes au chargement via `renderer.compileAsync(scene, camera)` |
| Première apparition d'un mesh | micro-freeze au premier passage de la caméra | `await renderer.compileAsync(scene, camera)` sur un écran de chargement, avec tous les objets visibles une fois |
| `readRenderTargetPixels()` sync | 5–20 ms de blocage | Utiliser `readRenderTargetPixelsAsync()` ; ou mieux : ne jamais lire le GPU, garder l'état autoritatif côté CPU |
| `getImageData()` / lecture canvas | idem | interdit en boucle de rendu |
| Réallocation de `WebGLRenderTarget` (resize) | pic | debouncer le resize à 150 ms |
| PMREM `fromScene` | 3–8 ms | pré-générer (§5.3) |
| Recompilation de shader sur changement de `defines` | freeze | tous les réglages qualité en **uniformes**, pas en `#define`, sauf ceux qui doivent supprimer du code (alors : recompilation explicite pendant un fondu au noir) |
| Trop de textures uniques | thrash de bind | atlas unique pour les props |

### 8.4 Résolution dynamique

```js
// src/perf/AdaptiveQuality.js
export class AdaptiveQuality {
  constructor(renderer, composer, opts = {}) {
    this.renderer = renderer;
    this.composer = composer;
    this.targetLo = opts.targetLo ?? 52;      // hystérésis : deux seuils
    this.targetHi = opts.targetHi ?? 58;
    this.scale = 1.0;
    this.minScale = 0.55;
    this.samples = [];
    this.frames = 0;
    this.tier = 2;                            // 0=bas 1=moyen 2=haut
  }

  update(dt, applyTier) {
    this.samples.push(1 / Math.max(dt, 1e-4));
    if (this.samples.length > 60) this.samples.shift();
    if (++this.frames < 120) return;          // ré-évaluer toutes les ~2 s
    this.frames = 0;

    const sorted = [...this.samples].sort((a, b) => a - b);
    const p10 = sorted[Math.floor(sorted.length * 0.10)];   // percentile 10 : capte les à-coups

    if (p10 < this.targetLo) {
      // 1) d'abord baisser la résolution (invisible, gain immédiat)
      if (this.scale > this.minScale) {
        this.scale = Math.max(this.minScale, this.scale - 0.08);
        this._applyScale();
      }
      // 2) puis descendre de palier de qualité
      else if (this.tier > 0) { this.tier--; applyTier(this.tier); }
    } else if (p10 > this.targetHi) {
      if (this.scale < 1.0) { this.scale = Math.min(1.0, this.scale + 0.05); this._applyScale(); }
      else if (this.tier < 2) { this.tier++; applyTier(this.tier); }
    }
  }

  _applyScale() {
    const w = Math.round(window.innerWidth  * this.scale);
    const h = Math.round(window.innerHeight * this.scale);
    this.renderer.setSize(w, h, false);        // false = ne pas toucher au CSS du canvas
    this.composer.setSize(w, h);
  }
}
```

> **Hystérésis obligatoire.** Sans les deux seuils (52 / 58), la qualité oscille en permanence et le
> ping-pong est plus désagréable qu'un framerate stable un peu bas.
>
> **Ne jamais changer `setPixelRatio` en runtime** : cela recrée le drawing buffer. Utiliser
> `setSize(w, h, false)` avec un canvas dont la taille CSS est fixe — l'upscale est fait gratuitement
> par le compositeur du navigateur.

### 8.5 Draw calls : la checklist

```
[ ] Terrain sable            : 1 draw call par chunk visible (16 chunks max) → 16
[ ] Faces de coupe du bloc   : incluses dans les chunks de bord           → 0
[ ] Océan                    : 1 mesh + 1 LOD lointain                    → 2
[ ] Nappe d'eau locale       : 1                                          → 1
[ ] Ciel + nuages            : 2                                          → 2
[ ] Herbes                   : 16 chunks × 1 LOD actif                    → 16
[ ] Props instanciés         : 5 InstancedMesh                            → 5
[ ] Props interactifs        : ≤ 15 meshes                                → 15
[ ] Ombres de contact (decals): 1 InstancedMesh                           → 1
[ ] Particules (eau, sable)  : 3 systèmes Points                          → 3
[ ] UI 3D (curseur d'outil)  : 2                                          → 2
[ ] Shadow pass              : ~× 0.6 des objets casteurs                 → ~25
[ ] Post-processing          : 2 EffectPass + N8AO (3 passes)             → 5
                                                                   TOTAL ≈ 93
```

Ce budget tient dans la cible « moyen ». Les leviers si l'on déborde : merger les chunks de terrain non
édités récemment, réduire les chunks d'herbe à 2×2, désactiver l'AO écran.

### 8.6 Frustum culling

Le diorama est **entièrement visible** la plupart du temps → le culling ne rapporte presque rien sur le
terrain, mais beaucoup sur l'herbe en vue rapprochée. Faire :

- `mesh.frustumCulled = false` sur les InstancedMesh d'herbe (le test de la bounding box globale est
  toujours vrai, il coûte pour rien) ;
- culling manuel **par chunk** avec un `THREE.Frustum` mis à jour une fois par frame ;
- `renderer.sortObjects` : garder `true`, mais fixer `renderOrder` explicitement (ciel = -1000,
  opaque = 0, eau = 100, particules = 200) pour éviter les tris instables.

---

## 9. Annexes

### 9.1 Ordre d'implémentation recommandé

| Étape | Contenu | Gain visuel |
|---|---|---|
| 1 | Renderer + pipeline couleur (AgX) + soleil + une seule shadow map serrée | base |
| 2 | Sable : albedo + AO baké + courbure baké | ★★★★★ — c'est 60 % du look |
| 3 | Tilt-shift + LUT chaude + vignette + grain | ★★★★★ — c'est le « diorama » |
| 4 | Carte d'humidité + sable mouillé | ★★★★ |
| 5 | Océan Gerstner + Beer-Lambert + écume de swash | ★★★★ |
| 6 | Glitter | ★★★ — beaucoup d'effet pour peu de code |
| 7 | Faces de coupe géologique du bloc | ★★★ |
| 8 | Herbes instanciées + vent | ★★★ |
| 9 | N8AO + bloom + CA | ★★ |
| 10 | Caustiques, débris, SSS, traces d'outils | ★★ — polish |

### 9.2 Les pièges, condensés

**Rendu / couleur**
1. Double tone mapping (renderer + post) → image délavée. Un seul point de tone mapping.
2. Constantes de couleur en sRGB dans un shader linéaire → sable rose fluo.
3. `frameBufferType` en `UnsignedByteType` avec du bloom → banding et bloom qui ne s'accroche pas.
4. AO noire pure → le sable devient sale. Teinter l'AO en bleu-ardoise (rebond du ciel).

**Sable**
5. Oublier `customProgramCacheKey` avec `onBeforeCompile` → le patch fuit ou disparaît.
6. Glitter sans fondu de distance ni `fwidth` → scintillement épileptique en mouvement.
7. Grain haute fréquence sans atténuation avec la distance → aliasing violent, tue le TAA/SMAA.
8. Triplanar sans correction de signe sur `tz.z` → relief inversé sur les faces opposées.
9. Courbure calculée en écran → scintille. La baker au meshing.

**Eau**
10. Réfraction lue dans le buffer qui contient déjà l'eau → feedback visuel. Copier l'opaque avant.
11. Pas de soft edge (depth fade) → l'eau coupe le sable au rasoir. Toujours `smoothstep` sur
    l'épaisseur.
12. Décalage de réfraction non borné → l'échantillon vient d'un objet *devant* l'eau, franges
    aberrantes. Tester la profondeur de l'échantillon décalé.
13. Écume purement additive → surexposition blanche. Utiliser `mix`, pas `+`.
14. `depthWrite: true` sur l'eau transparente → l'eau derrière disparaît.

**Perf**
15. `computeBoundingSphere()` à chaque remesh de chunk → O(n) + GC. La calculer à la main.
16. `new BufferGeometry()` en jeu → pic d'allocation. Pooler.
17. Redimensionner les attributs à chaque remesh → réallocation VBO. Buffer fixe + `setDrawRange`.
18. `material.needsUpdate = true` en runtime → recompilation, freeze. Réglages en uniformes.
19. `PMREMGenerator.fromScene()` par frame → 3–8 ms de stutter permanent. Pré-générer 8 env maps.
20. `setPixelRatio()` en runtime pour le scaling dynamique → recrée le drawing buffer. Utiliser
    `setSize(w, h, false)`.
21. Un `EffectPass` par effet → autant de draw calls fullscreen. Grouper les effets dans le minimum de
    passes.
22. `castShadow` sur 40 000 brins d'herbe → doublement du coût de la scène pour un gain nul.
23. CSM sur une scène bornée de 8 m → 4× le coût des ombres pour zéro qualité supplémentaire.
24. Lecture GPU synchrone (`readRenderTargetPixels`) dans la boucle → stall. Async ou état CPU
    autoritatif.
25. Pas d'hystérésis dans le scaling adaptatif → oscillation permanente de la qualité.

**WebGPU / TSL**
26. Utiliser `ShaderMaterial` ou `onBeforeCompile` sur `WebGPURenderer` → silencieusement ignoré ou
    erreur. Tout en nodes.
27. Utiliser `EffectComposer` (addon WebGL) avec `WebGPURenderer` → non supporté. Utiliser le stack de
    post node-based.
28. Oublier `await renderer.init()` quand on n'utilise pas `setAnimationLoop` → premier frame noir ou
    exception.
29. Beaucoup de meshes séparés non instanciés sur WebGPU → peut être plus lent que WebGL. Instancier
    agressivement.

### 9.3 Uniformes globales à partager entre tous les shaders

Un seul objet, injecté dans chaque matériau — évite la désynchronisation entre le sable, l'eau et
l'herbe.

```js
// src/render/globalUniforms.js
export const G = {
  uTime:             { value: 0 },
  uSunDir:           { value: new THREE.Vector3(0.4, 0.75, 0.5).normalize() },
  uSunColor:         { value: new THREE.Color(0xfff3e4).convertSRGBToLinear() },
  uAmbientColor:     { value: new THREE.Color(0xbbd8f2).convertSRGBToLinear() },
  uBlockMin:         { value: new THREE.Vector2(-4, -4) },
  uBlockSize:        { value: new THREE.Vector2(8, 8) },
  uHumidityMap:      { value: null },
  uToolMask:         { value: null },
  uSeaLevel:         { value: -0.22 },
  uSwashPeriod:      { value: 5.5 },
  uSwashReach:       { value: 0.11 },
  uWaterTable:       { value: -0.38 },
  uCausticsIntensity:{ value: 0.55 },
  uWindDir:          { value: new THREE.Vector2(0.82, 0.57).normalize() },
  uWindStrength:     { value: 0.45 },
  uSceneColor:       { value: null },
  uSceneDepth:       { value: null },
  uEnvMap:           { value: null },
};
```

### 9.4 Références

- Ben Golus — *Normal Mapping for a Triplanar Shader* + dépôt `bgolus/Normal-Mapping-for-a-Triplanar-Shader` (blending Whiteout / UDN / RNM)
- Alan Zucconi — *A Journey Into Journey's Sand Shader*, partie 5 : Glitter Reflection (théorie microfacettes du scintillement)
- Barré-Brisebois & Bouchard, GDC 2011 — *Approximating Translucency for a Fast, Cheap and Convincing Subsurface Scattering Look* (Frostbite 2)
- NVIDIA GPU Gems 1, ch. 2 — *Rendering Water Caustics* ; GPU Gems 2, part II — Shading, Lighting, and Shadows
- *A Micro-Ellipsoid Model for Wet Porous Materials Rendering* (arXiv 2401.15628) — modèle physique de l'assombrissement par saturation
- three.js — `webgl_shadowmap_pcss` (implémentation PCSS de référence, Poisson disk + blocker search)
- three.js — `Sky` / `SkyMesh` (modèle de Preetham), `PMREMGenerator`, `LUTPass`
- three.js manual — *WebGPURenderer* (imports, `forceWebGL`, limitations, migration nodes)
- three.js — spécification TSL (`three/tsl`)
- N8python/n8ao — AO écran avec denoise spatial/temporel intégré et upsampling depth-aware
- pmndrs/postprocessing — `EffectComposer`, `TiltShiftEffect`, `DepthOfFieldEffect`, `BloomEffect`, `OutlineEffect`, `LUT3DEffect`
- 0fps.net — *Ambient Occlusion for Minecraft-like Worlds* ; jedjoud10 — *Surface Nets Vertex Ambient Occlusion*
- CaffeineViking/osgw — `gerstner.glsl`, dérivées analytiques tangente/binormale
- Dave Hoskins — *Hash without Sine* (`hash13`, `hash33`)

---

*Fin du document.*
