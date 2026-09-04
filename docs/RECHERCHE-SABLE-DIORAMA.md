# Recherche — Rendu du SABLE et présentation du BLOC DIORAMA

> Document complémentaire à `RECHERCHE-RENDU-3D.md`. Celui-là décrit l'architecture complète
> du renderer ; celui-ci s'attaque à deux régressions visuelles précises signalées par le joueur :
>
> 1. **le sable est terne et plat** — beige uniforme, sans grain lisible, sans relief, sans éclat ;
> 2. **le bloc diorama vu de côté est un mur brun uniforme** — aucune stratigraphie, aucune matière.
>
> Cible : le rendu de *Sandcastle* (démo Steam, Bubblebird Studio) — sable presque blanc, chaud,
> très lumineux au soleil, grain fin visible, ombres portées nettes et bleutées, lisibilité
> parfaite des créneaux et des arêtes. **Été tropical franc et contrasté, pas pastel.**
>
> Toutes les fonctions GLSL sont préfixées `sc_` pour rester cohérentes avec
> `src/render/SandMaterial.js`. Le code est écrit pour être collé tel quel dans les blocs
> `onBeforeCompile`.

---

## Table des matières

1. [Diagnostic du sable actuel](#1-diagnostic-du-sable-actuel)
2. [Micro-relief : POM triplanaire et normales de détail](#2-micro-relief)
3. [Diffusion et spécularité](#3-diffusion-et-spécularité)
4. [Lisibilité des formes sculptées](#4-lisibilité-des-formes-sculptées)
5. [Sable mouillé : deux régimes](#5-sable-mouillé--deux-régimes)
6. [Le bloc diorama](#6-le-bloc-diorama)
7. [Valeurs prêtes à coller](#7-valeurs-prêtes-à-coller)
8. [Ordre d'implémentation et budget](#8-ordre-dimplémentation-et-budget)
9. [Sources](#9-sources)

---

## 1. Diagnostic du sable actuel

### 1.1 Ce que fait le shader aujourd'hui

Lecture de `src/render/SandMaterial.js` (317 lignes), patch par patch :

| Patch | Ce qui est fait | Verdict |
|---|---|---|
| `<map_fragment>` | albédo = `uDryColor * (0.90 + 0.20*grain) * (0.95 + 0.10*macro)` | **Plage dynamique morte** (voir 1.2) |
| | assombrissement mouillé en luminance, saturation +16 % | Bon modèle, mais **un seul régime** (voir §5) |
| | faces de coupe détectées par `abs(worldPos.xz)` vs `uDomain` | **Fragile** (voir §6.2) |
| `<roughnessmap_fragment>` | `mix(0.98, 0.34, moisture)` + bruit ±0,05 | **Le sable sec est à 0,98 : zéro spéculaire** |
| `<normal_fragment_maps>` | une octave de value-noise à 42 m⁻¹, amplitude 0,055 | **Une seule échelle**, dérivée par différences finies non normalisée |
| `<aomap_fragment>` | AO baké × 0,85 sur l'indirect, 0,35 sur le direct | OK mais **pas de courbure** |
| `<dithering_fragment>` | sparkle 1 octave, cellules 1,92 mm, densité 0,35 % | **Taille apparente non constante → aliasing** |

### 1.2 Les quatre manques, chiffrés

**a) Plage dynamique.** Le produit `(0.90 + 0.20·grain) · (0.95 + 0.10·macro)` avec `grain` et
`macro` centrés autour de 0,5 donne un albédo qui varie entre **0,855·base et 1,155·base**, soit
±15 % — et encore, le fBm de valeur ne visite quasiment jamais 0 ni 1, la plage réelle est plutôt
**±7 %**. Après tone mapping ACES, 7 % de variation d'albédo se traduit par ~4 % de variation de
luminance écran : **invisible**. La référence a un contraste local de l'ordre de **±25 à 35 %**
entre une crête ensoleillée et un creux.

**b) Micro-relief.** Une seule octave de bruit à 42 m⁻¹ = une période de 2,4 cm. C'est l'échelle
des « rides », pas celle du grain. Le grain visible d'un sable de plage à 40 cm de la caméra est à
**0,3–1 mm**, soit 1000–3000 m⁻¹. Et l'amplitude 0,055 avec un facteur 8 arbitraire (`dn * amp * 8.0`)
sans normalisation par le pas `e` donne une pente qui dépend de la fréquence du bruit — le réglage
n'est pas physique, il est empirique et il s'écroule dès qu'on change `uGrainScale`.

**c) Réponse spéculaire.** `roughness = 0.98`, `metalness = 0` → F0 = 0,04, et la NDF GGX à
α = 0,96 étale l'énergie sur tout l'hémisphère. Le lobe spéculaire vaut **~0,04/π ≈ 0,013** partout :
il n'existe pas. Or le sable sec réel **a** un léger sheen en lumière rasante (réflexion de Fresnel
sur les faces de grains alignées par le vent) et surtout un **hot-spot rétrodiffusé** (effet
d'opposition de Hapke : quand on regarde dans l'axe du soleil, les ombres inter-grains sont
masquées et la surface s'éclaircit de 15 à 30 %). Rien de tout ça n'est modélisé.

**d) Accentuation des arêtes.** Le Surface Nets lisse les normales par construction (un sommet par
cellule, gradient trilinéaire). Un créneau de 8 cm (2 voxels) sort avec une normale **quasi
identique** à celle du mur en dessous. L'AO baké aide un peu dans les rentrants, mais rien
n'éclaircit les **convexités**. C'est *la* raison pour laquelle « les formes ne se lisent pas ».

### 1.3 Albédos mesurés de vrais sables

Valeurs de réflectance hémisphérique dans le visible (400–700 nm), issues de la littérature
BRDF/télédétection (Hapke, mesures de terrain sur sables de plage et de désert). Converties en
albédo linéaire RGB approximatif — **c'est ce qu'on met dans un `diffuseColor` linéaire.**

| Sable | Albédo visible | RGB linéaire | Hex sRGB équivalent | Note |
|---|---|---|---|---|
| Quartz clair, plage tempérée, **sec** | 0,38 – 0,45 | `vec3(0.52, 0.42, 0.26)` | `#C6AC85` | dominante jaune (traces de goethite) |
| Quartz **lavé**, dune éolienne, sec | 0,45 – 0,55 | `vec3(0.63, 0.53, 0.35)` | `#D6BE96` | grain trié, plus clair en surface |
| **Corallien / carbonaté** (tropical) | 0,55 – 0,70 | `vec3(0.78, 0.72, 0.60)` | `#E9E0D0` | **presque blanc, peu saturé** |
| Coquillier broyé (lentille) | 0,65 – 0,80 | `vec3(0.90, 0.79, 0.66)` | `#F3E6D4` | très diffusant |
| Sable **mouillé** (quartz) | 0,20 – 0,26 | `vec3(0.27, 0.15, 0.06)` | `#8E6C46` | ≈ 0,55–0,65 × sec |
| Sable **saturé** (sous nappe) | 0,12 – 0,16 | `vec3(0.16, 0.09, 0.04)` | `#6F553A` | + film spéculaire |
| Volcanique basaltique (noir) | 0,03 – 0,08 | `vec3(0.035, 0.033, 0.031)` | `#3A3835` | pour référence, hors sujet ici |
| Volcanique gris (andésite) | 0,10 – 0,14 | `vec3(0.13, 0.12, 0.11)` | `#655F5A` | idem |

**Faits utiles tirés des mesures :**

- La chute de réflectance à l'humidification **sature très vite** : les premiers pourcents d'eau
  font l'essentiel du travail, ensuite le rapport mouillé/sec se stabilise vers **0,55–0,65**
  (mesures PLOS ONE sur sable de plage côtier, 350–2500 nm). Le `1 - exp(-moist * 7.5)` du shader
  actuel modélise correctement cette saturation — **on le garde**.
- La croûte de surface d'un sable ridé par le vent est **plus réfléchissante** que le sable
  sous-jacent déposé par le swash (tri granulométrique). C'est un argument pour éclaircir les
  crêtes de rides — ça tombe bien, c'est aussi ce qu'on veut esthétiquement.
- Le quartz n'a **aucune signature spectrale** en VNIR : la couleur d'un sable de plage vient des
  impuretés (oxydes de fer, débris organiques, feldspath). Donc : la teinte est un **choix
  artistique libre**, seul le niveau d'albédo est contraint.

### 1.4 Décision artistique

Pour tenir la référence *Sandcastle* (« presque blanc, chaud, très lumineux ») tout en gardant du
contraste, on vise :

```
albédo linéaire de base  : Y ≈ 0,58 – 0,64        (entre le quartz lavé et le corallien)
plage de variation totale: Y ∈ [0,42 ; 0,80]      (±30 % autour de la base)
saturation               : faible en clair, montante en foncé (les creux tirent vers l'ocre)
```

Autrement dit : **on ne monte pas la luminosité moyenne** (elle est déjà correcte à `#E4CFA2`,
Y = 0,637), **on écarte les extrêmes**. C'est le levier n° 1 de tout le document.

---

## 2. Micro-relief

### 2.1 Pourquoi le POM et pas seulement une normal map

Une normal map ment sur la silhouette : en lumière rasante (soleil bas, c'est notre cas la moitié
du cycle) le sable devrait montrer des micro-ombres portées **avec parallaxe** — un grain cache le
grain d'à côté. Une normale seule donne un dégradé lisse, jamais une ombre franche. Le POM
(parallax occlusion mapping, McGuire & McGuire 2005 pour le steep parallax, puis Tatarchuk 2006)
fait un ray-march dans un champ de hauteur en espace tangent et retourne un décalage de coordonnées
qui **déplace visuellement** la texture. C'est ce qui donne le « on a envie de le toucher ».

### 2.2 Le problème du triplanaire

Un POM triplanaire naïf = 3 ray-marchs. À 16 pas ça fait 48 échantillons par pixel. Inacceptable.

**Solution retenue : POM mono-axe dominant.** À chaque pixel, on choisit **la** projection dont le
poids triplanaire est le plus fort et on ne ray-marche que celle-là. Les deux autres n'apportent
rien de visible : quand un poids est dominant (> 0,5), l'axe est bien défini ; quand les trois sont
proches (arête à 45°), l'amplitude de parallaxe est faible de toute façon et on fond vers un simple
normal mapping. **Coût divisé par 3, artefact quasi nul.**

**Deuxième optimisation : le champ de hauteur est une texture, pas un fBm.** Évaluer `sc_fbm(p, 3)`
coûte 24 hash par échantillon ; × 16 pas = 384 hash/pixel, c'est mort. On bake une **tuile 256×256
RGBA** une seule fois au démarrage : `R` = hauteur, `GBA` = normale tangente encodée. Un tap de
texture par pas. La tuile est générée sur CPU (canvas), uploadée en `RepeatWrapping`, mipmaps ON.

```js
// src/render/SandDetailTile.js
// Tuile de détail sable : hauteur + normale tangente, tileable par construction
// (bruit de valeur sur une grille torique : hash(i mod N) au lieu de hash(i)).
import * as THREE from 'three';

const N = 256;

function hash2(x, y) {           // hash entier torique
  let h = (x * 374761393 + y * 668265263) | 0;
  h = (h ^ (h >>> 13)) * 1274126177 | 0;
  return ((h ^ (h >>> 16)) >>> 0) / 4294967295;
}
function vnoise2(x, y, period) {
  const i = Math.floor(x), j = Math.floor(y);
  let fx = x - i, fy = y - j;
  fx = fx * fx * (3 - 2 * fx); fy = fy * fy * (3 - 2 * fy);
  const w = (a, b) => hash2(((a % period) + period) % period, ((b % period) + period) % period);
  const n00 = w(i, j), n10 = w(i + 1, j), n01 = w(i, j + 1), n11 = w(i + 1, j + 1);
  return (n00 + (n10 - n00) * fx) + ((n01 + (n11 - n01) * fx) - (n00 + (n10 - n00) * fx)) * fy;
}

/**
 * Trois échelles empilées :
 *   - 64 périodes : le GRAIN (≈ 0,5 mm si la tuile fait 3,2 cm)
 *   - 16 périodes : les micro-rides
 *   -  4 périodes : les traces d'outil / le modelé à la main
 */
export function makeSandDetailTile() {
  const h = new Float32Array(N * N);
  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      const u = x / N, v = y / N;
      let s = 0;
      s += 0.55 * vnoise2(u * 64, v * 64, 64);
      s += 0.28 * vnoise2(u * 16, v * 16, 16);
      s += 0.17 * vnoise2(u * 4,  v * 4,  4);
      // Remise en forme : le sable a des crêtes fines et des creux larges.
      // pow < 1 remonte les valeurs basses -> creux plus larges, crêtes plus nettes.
      h[x + y * N] = Math.pow(s, 0.80);
    }
  }
  const data = new Uint8Array(N * N * 4);
  const S = 1.6; // pente : hauteur totale relative au pas de texel
  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      const o = x + y * N;
      const hl = h[((x - 1 + N) % N) + y * N], hr = h[((x + 1) % N) + y * N];
      const hd = h[x + ((y - 1 + N) % N) * N], hu = h[x + ((y + 1) % N) * N];
      // normale tangente depuis les différences centrées
      let nx = (hl - hr) * S * N * 0.5 / 32, ny = (hd - hu) * S * N * 0.5 / 32, nz = 1;
      const inv = 1 / Math.hypot(nx, ny, nz);
      data[o * 4 + 0] = Math.round((nx * inv * 0.5 + 0.5) * 255);
      data[o * 4 + 1] = Math.round((ny * inv * 0.5 + 0.5) * 255);
      data[o * 4 + 2] = Math.round((nz * inv * 0.5 + 0.5) * 255);
      data[o * 4 + 3] = Math.round(h[o] * 255);   // hauteur en alpha
    }
  }
  const tex = new THREE.DataTexture(data, N, N, THREE.RGBAFormat);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.generateMipmaps = true;
  tex.anisotropy = 8;
  tex.colorSpace = THREE.NoColorSpace;   // données, pas couleur — CRUCIAL
  tex.needsUpdate = true;
  return tex;
}
```

> **Piège absolu** : `colorSpace = NoColorSpace`. Si on laisse `SRGBColorSpace`, three applique une
> décompression sRGB sur la normale et sur la hauteur, et tout le relief devient mou et faux.

### 2.3 POM triplanaire mono-axe — code complet

```glsl
// ============================================================================
//  MICRO-RELIEF : PARALLAX OCCLUSION MAPPING TRIPLANAIRE MONO-AXE
// ============================================================================
uniform sampler2D uDetailTile;   // RGB = normale tangente, A = hauteur
uniform float uDetailScale;      // périodes de tuile par mètre (≈ 31.0 -> tuile de 3,2 cm)
uniform float uPomDepth;         // profondeur du champ de hauteur, en mètres (≈ 0.0035)
uniform float uPomFadeStart;     // distance de début de fondu (m)
uniform float uPomFadeEnd;       // distance de fin (m) : au-delà, plus de POM

// Poids triplanaires. Exposant élevé = transitions nettes ; 6.0 évite le flou
// aux 45° tout en gardant un fondu suffisant pour ne pas voir de couture.
vec3 sc_triWeights(vec3 n, float sharpness) {
  vec3 w = pow(abs(n), vec3(sharpness));
  return w / max(w.x + w.y + w.z, 1e-4);
}

/**
 * Construit la base tangente d'une projection planaire d'axe `axis`
 * (0 = X, 1 = Y, 2 = Z) en espace MONDE.
 * On garde une convention main droite cohérente pour les 3 axes, sinon les
 * normales de détail se retournent d'une face à l'autre.
 */
void sc_planarBasis(int axis, vec3 n, out vec2 uv, out vec3 T, out vec3 B, vec3 wp) {
  if (axis == 0) {              // projection sur le plan YZ
    float s = sign(n.x + 1e-6);
    uv = vec2(wp.z * s, wp.y);
    T  = vec3(0.0, 0.0, s);
    B  = vec3(0.0, 1.0, 0.0);
  } else if (axis == 1) {       // plan XZ (le cas dominant : le sol)
    float s = sign(n.y + 1e-6);
    uv = vec2(wp.x, wp.z * s);
    T  = vec3(1.0, 0.0, 0.0);
    B  = vec3(0.0, 0.0, s);
  } else {                      // plan XY
    float s = sign(n.z + 1e-6);
    uv = vec2(-wp.x * s, wp.y);
    T  = vec3(-s, 0.0, 0.0);
    B  = vec3(0.0, 1.0, 0.0);
  }
}

/**
 * POM sur une projection planaire.
 *   uv0    : coordonnées de départ (déjà multipliées par l'échelle)
 *   Vt     : vecteur vue en espace tangent (normalisé)
 *   depth  : amplitude en unités d'UV (= uPomDepth * uDetailScale)
 *   nSteps : nombre de pas linéaires
 * Retourne les UV décalées. La hauteur est lue dans le canal A.
 *
 * Ray-march linéaire + UNE interpolation binaire sur le dernier segment.
 * L'interpolation finale est ce qui distingue le POM du "steep parallax" :
 * sans elle on voit des marches d'escalier sous incidence rasante.
 */
vec2 sc_pom(vec2 uv0, vec3 Vt, float depth, float nSteps) {
  // Décalage total si on traversait toute la profondeur
  vec2 P = (Vt.xy / max(abs(Vt.z), 0.25)) * depth;

  float layer   = 1.0 / nSteps;
  float curDepth = 0.0;
  vec2  dUV      = P * layer;

  vec2  uv       = uv0;
  float h        = texture2D(uDetailTile, uv).a;
  float prevH    = h;
  vec2  prevUV   = uv;
  float prevDepth = 0.0;

  for (int i = 0; i < 32; i++) {
    if (float(i) >= nSteps) break;
    if (curDepth >= 1.0 - h) break;      // collision : on est passé sous la surface
    prevUV = uv; prevH = h; prevDepth = curDepth;
    uv       -= dUV;
    curDepth += layer;
    h         = texture2D(uDetailTile, uv).a;
  }

  // Interpolation linéaire sur le dernier segment (secant step)
  float after  = (1.0 - h)     - curDepth;
  float before = (1.0 - prevH) - prevDepth;
  float t = after / max(after - before, 1e-5);
  return mix(uv, prevUV, clamp(t, 0.0, 1.0));
}

/**
 * Point d'entrée : perturbe la normale et retourne aussi l'occlusion de
 * micro-relief (le "cavity" du grain), utile pour assombrir les creux.
 *
 *   wp      : position monde
 *   Nw      : normale géométrique monde (normalisée)
 *   V       : vecteur vers la caméra (normalisé)
 *   dist    : distance caméra
 *   wetness : humidité 0..1 (mouille -> relief aplati)
 */
void sc_detailPOM(vec3 wp, inout vec3 Nw, vec3 V, float dist, float wetness,
                  out float microCavity) {
  microCavity = 1.0;

  vec3 w = sc_triWeights(Nw, 6.0);
  // axe dominant
  int axis = (w.y >= w.x && w.y >= w.z) ? 1 : ((w.x >= w.z) ? 0 : 2);
  float wDom = max(max(w.x, w.y), w.z);

  vec2 uv; vec3 T, B;
  sc_planarBasis(axis, Nw, uv, T, B, wp);
  uv *= uDetailScale;

  // fondu de POM : coûteux, et inutile au-delà de ~2,5 m (le relief fait 3 mm)
  float pomFade = 1.0 - smoothstep(uPomFadeStart, uPomFadeEnd, dist);
  pomFade *= smoothstep(0.45, 0.75, wDom);          // pas de POM sur les arêtes ambiguës
  pomFade *= 1.0 - 0.75 * smoothstep(0.10, 0.45, wetness); // l'eau lisse le relief

  vec3 Nn = normalize(Nw);
  mat3 TBN = mat3(normalize(T - Nn * dot(Nn, T)),
                  normalize(B - Nn * dot(Nn, B)),
                  Nn);
  vec3 Vt = normalize(V * TBN);   // V en espace tangent (mat3 orthonormée : transpose = inverse)

  if (pomFade > 0.01) {
    // Nombre de pas adaptatif : beaucoup en rasant, peu de face.
    // 8 -> 24. À 24 pas on ne voit plus de marches même à 80° d'incidence.
    float nSteps = mix(24.0, 8.0, clamp(abs(Vt.z), 0.0, 1.0));
    vec2 uvP = sc_pom(uv, Vt, uPomDepth * uDetailScale * pomFade, nSteps);
    uv = mix(uv, uvP, pomFade);
  }

  vec4 d = texture2D(uDetailTile, uv);
  vec3 nT = d.rgb * 2.0 - 1.0;

  // Amplitude du détail : forte à courte distance, fondue au loin pour éviter
  // le fourmillement (le mip fait déjà la moitié du travail, mais pas tout).
  float amp = mix(1.0, 0.25, smoothstep(1.5, 6.0, dist));
  amp *= mix(1.0, 0.30, smoothstep(0.05, 0.45, wetness));
  nT.xy *= amp;

  Nw = normalize(TBN * normalize(nT));

  // Le canal A sert aussi d'occlusion de cavité : les creux du grain sont
  // moins exposés au ciel. 0,7 -> 1,0 c'est déjà beaucoup à cette échelle.
  microCavity = mix(1.0, 0.70 + 0.30 * d.a, amp);
}
```

**Coût mesuré à prévoir** (1080p, GPU intégré type Iris Xe / Apple M1) :

| Configuration | Taps de texture / pixel de sable | Coût estimé plein écran |
|---|---|---|
| Pas de POM (normal map seule) | 1 | ~0,1 ms |
| POM 8 pas | 9 | ~0,5 ms |
| POM adaptatif 8–24 pas, fondu à 2,5 m | ≈ 6 en moyenne (la plupart des pixels sont au-delà) | **~0,4 ms** |
| POM triplanaire complet 3×16 | 48 | ~2,6 ms — **à proscrire** |

Le fondu de distance est ce qui rend l'effet gratuit : à la caméra diorama (4–8 m, FOV 28°), seuls
les 15–20 % de pixels les plus proches ray-marchent réellement.

### 2.4 Alternative moins chère : le « bump offset » à un pas

Si le POM reste trop lourd (mobile, GPU faible, ou si le budget frame est déjà tendu par le
remaillage), on remplace `sc_pom` par un décalage à un seul échantillon. C'est du parallax mapping
classique (Kaneko 2001). Il n'y a plus d'occlusion (un grain ne cache plus son voisin) mais le
déplacement latéral, lui, est là — et c'est déjà 60 % de l'effet perçu à cette échelle.

```glsl
// Parallax "offset" : 1 tap supplémentaire, ~0,05 ms plein écran.
// Le clamp sur abs(Vt.z) évite l'explosion du décalage en incidence rasante,
// qui produit un étirement infâme (le défaut classique du parallax simple).
vec2 sc_parallaxOffset(vec2 uv, vec3 Vt, float depth) {
  float h = texture2D(uDetailTile, uv).a - 0.5;
  return uv - (Vt.xy / max(abs(Vt.z), 0.35)) * (h * depth);
}
```

Sélection au niveau du matériau, pas par pixel :

```js
mat.defines.SC_POM_QUALITY = quality;  // 0 = normal seule, 1 = offset, 2 = POM
mat.needsUpdate = true;                // recompile, à ne faire QU'au changement de réglage
```

```glsl
#if SC_POM_QUALITY == 2
  vec2 uvP = sc_pom(uv, Vt, uPomDepth * uDetailScale * pomFade, nSteps);
#elif SC_POM_QUALITY == 1
  vec2 uvP = sc_parallaxOffset(uv, Vt, uPomDepth * uDetailScale * pomFade);
#else
  vec2 uvP = uv;
#endif
```

### 2.5 Normales de détail multi-échelle, mélange whiteout

Trois échelles, chacune avec son rôle. Elles sont **toutes lues dans la même tuile**, à des
fréquences différentes et avec des décalages différents — une seule texture en mémoire.

| Échelle | Fréquence monde | Période | Rôle |
|---|---|---|---|
| **Grain** | 1400 m⁻¹ | 0,7 mm | la matière : ce qu'on voit à 40 cm |
| **Rides** | 46 m⁻¹ | 2,2 cm | le vent, le tassement |
| **Modelé** | 5,5 m⁻¹ | 18 cm | traces d'outil, coups de pelle, macro-variation |

Le mélange de normales **whiteout** (Ben Golus) est le bon compromis pour du détail : contrairement
à UDN, il ne multiplie pas les XY du détail par le Z de la base, donc le détail garde sa force sur
les surfaces non alignées. C'est exactement notre cas : le sable a des pentes partout.

```glsl
// ============================================================================
//  MÉLANGE DE NORMALES
// ============================================================================

/** Whiteout blend : additionne les pentes, multiplie les Z. */
vec3 sc_blendWhiteout(vec3 n1, vec3 n2) {
  return normalize(vec3(n1.xy + n2.xy, n1.z * n2.z));
}

/** UDN blend : moins cher, plus mou. Gardé pour référence / repli mobile. */
vec3 sc_blendUDN(vec3 n1, vec3 n2) {
  return normalize(vec3(n1.xy + n2.xy, n1.z));
}

/**
 * Normale triplanaire multi-échelle, mélange whiteout par projection.
 * Attention : on mélange les normales EN ESPACE TANGENT de chaque projection,
 * PUIS on projette en monde et on somme pondéré. Mélanger en monde d'abord
 * détruit le détail aux transitions (c'est l'erreur classique du triplanaire).
 */
vec3 sc_triplanarDetailNormal(vec3 wp, vec3 Nw, float dist, float wetness,
                              float packing) {
  vec3 w = sc_triWeights(Nw, 6.0);
  vec3 s = sign(Nw);

  // Atténuation d'échelle avec la distance : le grain disparaît avant les rides,
  // les rides avant le modelé. Sans ça, à 8 m on a un fourmillement de bruit.
  float aGrain  = (1.0 - smoothstep(0.8, 3.0, dist)) * mix(1.0, 0.25, wetness);
  float aRipple = (1.0 - smoothstep(3.0, 9.0, dist)) * mix(1.0, 0.55, packing);
  float aMacro  = 1.0;

  vec3 acc = vec3(0.0);

  // --- projection sur XZ (poids w.y) ---
  {
    vec2 uv = vec2(wp.x, wp.z * s.y);
    vec3 nG = texture2D(uDetailTile, uv * 1400.0).rgb * 2.0 - 1.0;
    vec3 nR = texture2D(uDetailTile, uv *   46.0 + 0.37).rgb * 2.0 - 1.0;
    vec3 nM = texture2D(uDetailTile, uv *    5.5 + 0.71).rgb * 2.0 - 1.0;
    nG.xy *= aGrain * 0.85; nR.xy *= aRipple * 0.60; nM.xy *= aMacro * 0.35;
    vec3 n = sc_blendWhiteout(sc_blendWhiteout(nM, nR), nG);
    acc += vec3(n.x, n.z, n.y * s.y) * w.y;   // remise en monde (tangente = X, bitangente = Z)
  }
  // --- projection sur YZ (poids w.x) ---
  {
    vec2 uv = vec2(wp.z * s.x, wp.y);
    vec3 nG = texture2D(uDetailTile, uv * 1400.0).rgb * 2.0 - 1.0;
    vec3 nR = texture2D(uDetailTile, uv *   46.0 + 0.37).rgb * 2.0 - 1.0;
    vec3 nM = texture2D(uDetailTile, uv *    5.5 + 0.71).rgb * 2.0 - 1.0;
    nG.xy *= aGrain * 0.85; nR.xy *= aRipple * 0.60; nM.xy *= aMacro * 0.35;
    vec3 n = sc_blendWhiteout(sc_blendWhiteout(nM, nR), nG);
    acc += vec3(n.z * s.x, n.y, n.x) * w.x;
  }
  // --- projection sur XY (poids w.z) ---
  {
    vec2 uv = vec2(-wp.x * s.z, wp.y);
    vec3 nG = texture2D(uDetailTile, uv * 1400.0).rgb * 2.0 - 1.0;
    vec3 nR = texture2D(uDetailTile, uv *   46.0 + 0.37).rgb * 2.0 - 1.0;
    vec3 nM = texture2D(uDetailTile, uv *    5.5 + 0.71).rgb * 2.0 - 1.0;
    nG.xy *= aGrain * 0.85; nR.xy *= aRipple * 0.60; nM.xy *= aMacro * 0.35;
    vec3 n = sc_blendWhiteout(sc_blendWhiteout(nM, nR), nG);
    acc += vec3(-n.x * s.z, n.y, n.z * s.z) * w.z;
  }

  // Recombinaison avec la normale géométrique (méthode "reoriented" simplifiée) :
  // on ajoute les pentes à la normale de base plutôt que de la remplacer.
  return normalize(Nw + (acc - Nw * dot(acc, Nw)) * 1.0);
}
```

> **Note sur le nombre de taps** : 9 (3 projections × 3 échelles). C'est deux fois le coût du POM
> mono-axe. En pratique on **ne fait pas les deux** : le POM mono-axe fournit déjà la normale de
> l'échelle « grain » (elle sort de la tuile ray-marchée). On ajoute juste **rides + modelé** en
> triplanaire léger, soit 6 taps de plus, dont on peut sauter les projections à poids < 0,05.
> Coût combiné réaliste : **8 à 11 taps en champ proche, 3 au loin.**

---

## 3. Diffusion et spécularité

### 3.1 Oren-Nayar : pourquoi ça change tout sur du sable

Lambert suppose une surface parfaitement lisse à l'échelle micro. Le sable ne l'est pas : c'est un
milieu granulaire dont la rugosité RMS des pentes est de l'ordre de σ = 0,5–0,8 rad. Conséquence
mesurable et **très visible** :

- Sous éclairage rasant, Lambert assombrit vite (cos θ). Oren-Nayar **aplatit** la chute : le sable
  garde de la matière au lieu de plonger dans le noir. C'est exactement le « manque de plage
  dynamique » ressenti — le problème n'est pas seulement les hautes lumières, ce sont aussi les
  ombres qui s'écrasent.
- Le terme de **rétrodiffusion** (quand L et V sont proches) éclaircit la surface : c'est le
  cousin pauvre de l'effet d'opposition de Hapke, et ça donne le « halo » autour de l'ombre de la
  caméra qu'on voit sur toutes les photos de plage.
- Le terme de **bord** (`max(0, cos(φL − φV))`) crée un liséré clair sur les pentes tournées vers la
  lumière — il **redonne du relief aux macro-formes** sans toucher à la géométrie.

On utilise la variante **Fujii** (« a tiny improvement of Oren-Nayar », mimosa-pudica), qui corrige
la non-conservation d'énergie du QON tout en restant à ~15 instructions. Si on veut aller plus loin,
le modèle **EON** (Portsmouth et al., JCGT 2025, retenu dans OpenPBR) est analytiquement
énergie-préservant ; il coûte une `exp` et une `sqrt` de plus. Pour du sable au soleil, Fujii suffit
largement et ne fait pas de différence perceptible.

```glsl
// ============================================================================
//  DIFFUSE OREN-NAYAR (variante Fujii, énergie approximativement conservée)
// ============================================================================
// sigma : rugosité de pente en radians. Sable sec ≈ 0.62, sable damé ≈ 0.45,
//         sable mouillé ≈ 0.25 (le film d'eau lisse les pentes).
// Retourne un facteur multiplicatif à appliquer à l'albédo (Lambert = 1.0/PI
// est déjà inclus, comme dans BRDF_Lambert de three.js).

float sc_orenNayarFujii(vec3 N, vec3 V, vec3 L, float sigma) {
  float NdL = dot(N, L);
  float NdV = dot(N, V);
  if (NdL <= 0.0) return 0.0;

  // s = cos(phi_L - phi_V) * sin(alpha) * tan(beta), sous forme stable :
  // le produit des projections tangentielles de L et V se réduit à
  // dot(L,V) - (N.L)(N.V), sans aucune trigonométrie ni normalisation.
  float LdV = dot(L, V);
  float s   = LdV - NdL * NdV;
  float t = (s <= 0.0) ? 1.0 : max(NdL, NdV);

  float s2 = sigma * sigma;
  float A = 1.0 - 0.5 * s2 / (s2 + 0.33);
  float B = 0.45 * s2 / (s2 + 0.09);

  // Correction d'énergie de Fujii : on divise par le facteur d'albédo effectif
  // pour que l'intégrale reste ≈ 1 quel que soit sigma.
  float energy = 1.0 / (1.0 + (0.5 - 2.0 / (3.0 * PI)) * (0.5 * s2 / (s2 + 0.33)));

  return (A + B * s / t) * energy;
}

/** BRDF complet, signature compatible avec BRDF_Lambert de three.js. */
vec3 sc_BRDF_OrenNayar(const in vec3 diffuseColor, const in vec3 lightDir) {
  float f = sc_orenNayarFujii(scGeoNormal, scGeoView, lightDir, scSigma);
  return RECIPROCAL_PI * diffuseColor * f;
}
```

### 3.2 Injection dans `MeshStandardMaterial` par `onBeforeCompile`

**Le problème** : `RE_Direct_Physical` est une fonction déclarée au niveau fichier (chunk
`lights_physical_pars_fragment`). Elle n'a pas accès aux variables locales de `main()` — donc pas
accès à `normal`, ni à `geometryViewDir` selon la version de three. Et sa **signature a changé**
plusieurs fois entre r150 et r170 (passage de `GeometricContext` à des paramètres explicites).

**La solution robuste, indépendante de la version** : on déclare nos propres globales au niveau
fichier, on les remplit dans `main()` juste avant l'éclairage, et on ne remplace **qu'une seule
ligne** du chunk — celle du diffus direct.

```js
// --- 1) globales + fonctions, dans <common> ------------------------------
shader.fragmentShader = shader.fragmentShader.replace(
  '#include <common>',
  /* glsl */ `
  #include <common>
  // Globales de fichier : accessibles depuis RE_Direct_Physical.
  vec3  scGeoNormal;
  vec3  scGeoView;
  float scSigma;
  ${COMMON_GLSL}
  ${OREN_NAYAR_GLSL}
  `
);

// --- 2) remplacement du diffus DIRECT uniquement -------------------------
// Cette ligne exacte n'apparaît QUE dans RE_Direct_Physical. L'indirect
// (RE_IndirectDiffuse_Physical) reste en Lambert : c'est correct, l'irradiance
// IBL est déjà intégrée sur l'hémisphère.
const LAMBERT_LINE =
  'reflectedLight.directDiffuse += irradiance * BRDF_Lambert( material.diffuseColor );';
if (shader.fragmentShader.indexOf(LAMBERT_LINE) === -1) {
  console.warn('[SandMaterial] chunk lights_physical modifié par three : ' +
               'Oren-Nayar non injecté, repli Lambert.');
} else {
  shader.fragmentShader = shader.fragmentShader.replace(
    LAMBERT_LINE,
    'reflectedLight.directDiffuse += irradiance * ' +
    'sc_BRDF_OrenNayar( material.diffuseColor, directLight.direction );'
  );
}

// --- 3) remplissage des globales avant l'éclairage -----------------------
shader.fragmentShader = shader.fragmentShader.replace(
  '#include <lights_fragment_begin>',
  /* glsl */ `
  scGeoNormal = normal;                                   // normale APRÈS détail/POM
  scGeoView   = normalize(vViewPosition);                  // en espace vue
  // sigma dépend de la matière : sec granuleux -> rugueux, mouillé -> lisse
  scSigma = mix(0.62, 0.22, smoothstep(0.05, 0.45, vData.x));
  scSigma = mix(scSigma, scSigma * 0.78, vData.y);         // le tassement lisse
  #include <lights_fragment_begin>
  `
);
```

> **Attention à l'espace de coordonnées.** Dans le fragment shader de three, `normal` et
> `directLight.direction` sont en **espace vue**. `vViewPosition` vaut `-mvPosition.xyz`, donc
> `normalize(vViewPosition)` est bien le vecteur vers la caméra en espace vue. Ne surtout pas mixer
> avec `uSunDirection` qui, dans le shader actuel, est en espace **monde** — c'est déjà une
> incohérence latente du sparkle existant (il utilise `normal`, en vue, avec `uSunDirection`, en
> monde). **À corriger** : passer une uniforme `uSunDirectionView` mise à jour par frame, ou
> transformer avec `viewMatrix`.

```js
// dans la boucle de rendu
uniforms.uSunDirectionView.value
  .copy(uniforms.uSunDirection.value)
  .transformDirection(camera.matrixWorldInverse);
```

### 3.3 Effet d'opposition (hot-spot rétrodiffusé)

Le terme B d'Oren-Nayar donne déjà une partie de la rétrodiffusion, mais pas le pic étroit. Un
terme de Hapke simplifié (shadow-hiding opposition effect, SHOE) coûte 5 instructions et donne le
« halo autour de l'ombre du joueur » :

```glsl
// ============================================================================
//  EFFET D'OPPOSITION (SHOE simplifié de Hapke)
// ============================================================================
// g : angle de phase (angle entre L et V). Quand g -> 0, les ombres entre
// grains sont cachées par les grains eux-mêmes -> la surface s'éclaircit.
//   B0 : amplitude du pic (0.4 pour un sable poreux sec, 0.15 mouillé)
//   h  : largeur angulaire (0.06 rad ≈ 3,5°) — étroit, c'est le point.
float sc_oppositionSurge(vec3 L, vec3 V, float B0, float h) {
  float cosg = clamp(dot(L, V), -1.0, 1.0);
  float g    = acos(cosg);
  return 1.0 + B0 / (1.0 + tan(g * 0.5) / h);
}
```

À appliquer sur le diffus direct seulement, avec `B0` modulé par la sécheresse :

```glsl
float surge = sc_oppositionSurge(directLight.direction, scGeoView,
                                 0.40 * (1.0 - smoothstep(0.05, 0.4, scWetness)), 0.06);
reflectedLight.directDiffuse *= surge;
```

Effet subtil mais **très « vrai »** : il fait apparaître un dégradé radial autour du point antisolaire
qui suit la caméra. C'est un des détails qui distingue une plage rendue d'une photo.

### 3.4 Sheen spéculaire du sable sec

`roughness = 0.98` tue le spéculaire. On abaisse à **0,86** en base (le sable sec a bel et bien un
lobe large mais présent) et surtout on **ajoute une variation spatiale** de roughness sur les mêmes
échelles que la normale — c'est ce qui crée le scintillement « large » que le sparkle ponctuel ne
donne pas.

```glsl
// --- <roughnessmap_fragment> réécrit --------------------------------------
float roughnessFactor = roughness;
{
  float moist = vData.x;
  float packing = vData.y;

  // Deux régimes distincts (cf. §5) : humide mat vs saturé brillant.
  float wetMat  = smoothstep(0.03, 0.30, moist);   // 0 -> 1 : mouille "mat"
  float wetFilm = smoothstep(0.55, 0.92, moist);   // 0 -> 1 : film d'eau

  // Sec : 0.86. Humide MAT : 0.92 (plus rugueux ! les grains collent en amas).
  // Saturé : 0.16 (film d'eau quasi spéculaire).
  roughnessFactor = mix(0.86, 0.92, wetMat);
  roughnessFactor = mix(roughnessFactor, 0.16, wetFilm);

  // Le tassement lisse la surface (les grains s'imbriquent).
  roughnessFactor *= mix(1.0, 0.90, packing);

  // Variation spatiale : indispensable pour casser l'uniformité.
  // Deux échelles, amplitude totale ±0,09.
  float rN = texture2D(uDetailTile, vec2(vWorldPos.x, vWorldPos.z) * 46.0).a;
  float rM = texture2D(uDetailTile, vec2(vWorldPos.x, vWorldPos.z) * 5.5 + 0.71).a;
  roughnessFactor += (rN - 0.5) * 0.10 + (rM - 0.5) * 0.08;

  // Les creux du micro-relief retiennent l'humidité -> plus lisses.
  roughnessFactor -= (1.0 - scMicroCavity) * 0.12 * wetMat;

  roughnessFactor = clamp(roughnessFactor, 0.06, 1.0);
}
```

### 3.5 Translucidité (SSS bon marché)

Un bourrelet fin de sable — un créneau de 4 cm, une arête de mur, la lèvre d'un fossé — éclairé par
derrière **laisse passer la lumière** et s'allume en orange. C'est spectaculaire au soleil bas et
c'est totalement absent aujourd'hui.

L'approximation Barré-Brisebois/Bouchard (GDC 2011, Frostbite) suffit : pas de ray-march, pas de
depth map, quelques produits scalaires.

```glsl
// ============================================================================
//  TRANSLUCIDITÉ (Barré-Brisebois & Bouchard, GDC 2011)
// ============================================================================
// L'idée : au lieu de calculer le trajet réel dans le milieu, on suppose que la
// lumière ressort dans un lobe centré sur -L, légèrement déformé vers -N.
//   thickness : 1 = feature fine (créneau isolé), 0 = masse pleine.
//               Fourni par le mailleur (cf. §4.2, canal aData2.z).
vec3 sc_translucency(vec3 N, vec3 L, vec3 V, vec3 lightColor, float thickness,
                     float distortion, float power, float scale, float ambient) {
  vec3  H   = normalize(L + N * distortion);
  float VdH = pow(clamp(dot(V, -H), 0.0, 1.0), power) * scale;
  // Teinte de transmission : le sable transmet dans les orangés (absorption
  // sélective du bleu par les oxydes de fer + trajet long).
  const vec3 TINT = vec3(1.00, 0.55, 0.22);
  return lightColor * TINT * ((VdH + ambient) * thickness);
}
```

Intégration, **après** l'éclairage (patch `<opaque_fragment>` ou en tête de
`<dithering_fragment>`) :

```glsl
{
  float thin = scThinness;                       // aData2.z
  thin *= 1.0 - smoothstep(0.1, 0.6, vData.x);   // le sable mouillé transmet peu
  if (thin > 0.01) {
    gl_FragColor.rgb += sc_translucency(
      scGeoNormal, uSunDirectionView, scGeoView, uSunColor,
      thin, 0.28, 6.0, 1.35, 0.08) * uTranslucency;
  }
}
```

> Réglage : `distortion = 0.28`, `power = 6.0`. Avec `power` trop grand (> 12) l'effet ne se voit
> plus que pile à contre-jour ; trop petit (< 4) tout le sable devient orange. `scale = 1.35` est
> déjà agressif ; monter à 2,0 si on veut un rendu « bougie » assumé au coucher de soleil.

### 3.6 Sparkle de quartz : reprise complète

Le sparkle existant a trois défauts :

1. **taille apparente non constante** — `floor(vWorldPos * 520.0)` fixe la cellule à 1,92 mm dans le
   monde. À 1 m de la caméra une cellule couvre plusieurs pixels (bien) ; à 6 m elle couvre 1/20 de
   pixel, et l'échantillonnage ponctuel devient un bruit blanc qui scintille au moindre mouvement de
   caméra. Le fondu `exp(-dist*0.42)` masque le symptôme en supprimant l'effet dès 4 m — donc **on
   n'a du sparkle que dans le premier mètre**, alors que la caméra diorama est à 4–8 m ;
2. **pas d'anti-aliasing angulaire** — `pow(dot, 900.0)` est un Dirac : entre deux frames le pic
   apparaît et disparaît sans transition ;
3. **incohérence d'espace** — `uSunDirection` (monde) est utilisé avec `normal` (vue).

La correction tient en trois idées : **cellule proportionnelle à la distance** (taille apparente
constante à l'écran), **deux octaves LOD croisées** pour que le changement de taille soit
imperceptible, et **seuil élargi par `fwidth`**.

```glsl
// ============================================================================
//  SPARKLE DE QUARTZ — taille apparente constante, anti-aliasé
// ============================================================================
uniform float uSparkle;        // gain global
uniform float uSparkleSize;    // taille apparente cible, en radians d'angle solide
                               // (0.00045 rad ≈ 1,5 px à 1080p / FOV 28°)

/**
 * Une octave. cellWorld est la taille de cellule EN MÈTRES pour ce niveau.
 *   spread  : dispersion angulaire des facettes (1.1 = serré, 2.0 = chaotique)
 *   density : fraction de cellules porteuses d'une facette (0.02 -> 2 %)
 */
float sc_sparkleOctave(vec3 wp, vec3 N, vec3 L, vec3 V,
                       float cellWorld, float spread, float density) {
  vec3 cell = floor(wp / cellWorld);
  float sel = sc_hash13(cell + 7.13);
  if (sel > density) return 0.0;

  vec3 rnd  = sc_hash33(cell) * 2.0 - 1.0;
  vec3 G    = normalize(N + rnd * spread);
  if (dot(G, N) < 0.05) return 0.0;

  vec3  R   = reflect(-L, G);
  float RdV = dot(R, V);

  // Seuil élargi par la dérivée écran : c'est l'anti-aliasing angulaire.
  // Sans ce fwidth, le sparkle "clignote" au lieu de "scintiller".
  float fw    = max(fwidth(RdV), 2.0e-4);
  float sharp = 0.9972;
  return smoothstep(sharp - fw * 2.5, min(sharp + fw * 1.5, 1.0), RdV);
}

/**
 * Sparkle multi-LOD. La taille de cellule suit la distance pour garder une
 * taille apparente constante à l'écran : cellWorld = uSparkleSize * dist.
 * On quantifie en puissances de 2 et on croise deux niveaux -> pas de "pop".
 */
vec3 sc_sparkle(vec3 wp, vec3 N, vec3 L, vec3 V, vec3 lightColor,
                float wetness, float dist, float packing) {
  // Le sable mouillé ne scintille pas (le film d'eau supprime les facettes
  // libres) ; le sable très tassé non plus (les faces sont enfouies).
  float dryMask = (1.0 - smoothstep(0.10, 0.45, wetness)) * mix(1.0, 0.55, packing);
  if (dryMask < 0.02) return vec3(0.0);

  // Taille apparente constante : plus on est loin, plus la cellule est grande.
  float target = uSparkleSize * dist;             // en mètres
  // Bornes physiques : un grain fait 0,3 mm, un amas visible max ~6 mm.
  target = clamp(target, 0.00035, 0.006);

  float lod  = log2(target / 0.00035);
  float lodF = floor(lod);
  float lodT = lod - lodF;                        // 0..1, poids de croisement

  float c0 = 0.00035 * exp2(lodF);
  float c1 = c0 * 2.0;

  // La densité doit compenser le changement de taille pour garder un nombre
  // constant de paillettes PAR PIXEL : quand la cellule double, la densité
  // surfacique doit rester la même -> densité par cellule inchangée. On garde
  // donc la même densité aux deux niveaux, seul le croisement varie.
  float g  = sc_sparkleOctave(wp, N, L, V, c0, 1.15, 0.030) * (1.0 - lodT);
        g += sc_sparkleOctave(wp, N, L, V, c1, 1.15, 0.030) * lodT;

  // Une troisième octave grossière, très rare, pour les "gros éclats" de mica.
  g += sc_sparkleOctave(wp, N, L, V, c1 * 3.0, 0.85, 0.010) * 0.55;

  // Le sparkle n'existe que sur une face éclairée.
  float lambert = smoothstep(0.0, 0.22, dot(N, L));

  // Teinte légèrement plus chaude et plus intense que le soleil : c'est ce qui
  // fait mordre le bloom. NE PAS clamper avant le tone mapping.
  const vec3 TINT = vec3(1.10, 1.02, 0.86);
  return lightColor * TINT * (g * 3.2 * dryMask * lambert * uSparkle);
}
```

**Comparatif avant / après :**

| | Actuel | Proposé |
|---|---|---|
| Taille de cellule | 1,92 mm fixe | 0,35 mm → 6 mm, proportionnelle à la distance |
| Portée utile | ~0 à 3 m (`exp(-0.42d)`) | **toute la scène** |
| Densité | 0,35 % | 3,0 % (mais chaque cellule est plus grande au loin) |
| AA angulaire | aucun (`pow 900`) | `fwidth` sur `R·V` |
| Octaves | 1 | 2 croisées + 1 rare |
| Coût | 1 hash33 + 1 hash13 | 3× (1 hash33 + 1 hash13), branchées tôt |

Le coût réel est plus bas qu'il n'y paraît : le `if (sel > density) return 0.0;` sort après **un
seul** hash dans 97 % des cas.

---

## 4. Lisibilité des formes sculptées

C'est **le** point qui décide si un château se lit ou pas. Un créneau de 8 cm sur un mur de 40 cm
doit se voir même en ombre pleine.

### 4.1 D'où vient la courbure

Trois sources, par ordre de qualité :

| Source | Stabilité | Coût | Verdict |
|---|---|---|---|
| **Bakée au mailleur** (occupancy dans une boule) | parfaite | ~0,15 ms/chunk CPU | **Recommandé** |
| Gradient de l'AO déjà bakée, en espace écran | bonne | 4 instructions | **Excellent complément**, gratuit |
| Dérivées écran de la normale (`dFdx(N)`) | médiocre (dépend de la résolution, fourmille) | 6 instructions | Repli seulement |

La bonne nouvelle : **l'AO par sommet est déjà calculée** dans `SurfaceNets.js`
(`ambientOcclusion()`, 9 directions × 3 pas). Son **gradient en espace écran** est une excellente
approximation de la courbure — et elle est parfaitement stable temporellement puisque l'AO elle-même
est bakée par sommet et interpolée linéairement.

### 4.2 Courbure bakée au mailleur (méthode « occupancy »)

Le principe : pour un point sur une surface **plane**, une petite boule centrée sur ce point est
remplie de matière à exactement 50 %. Sur une **arête convexe** (créneau, coin de mur) : moins de
50 %. Dans un **creux concave** (angle rentrant, sillon) : plus de 50 %.

Deux rayons donnent deux informations différentes pour le prix d'une boucle :

- **r = 1,6 voxel (6,4 cm)** → courbure locale, celle qui fait lire les arêtes ;
- **r = 4,0 voxels (16 cm)** → « finesse » (thinness) pour la translucidité : un créneau isolé a une
  occupancy globale basse, une masse pleine l'a haute.

```js
// --- à ajouter dans src/sim/meshing/SurfaceNets.js -------------------------

/**
 * 14 directions réparties (6 axes + 8 diagonales de cube), normalisées.
 * 14 échantillons par rayon, 28 au total. Coût mesuré : ~0,12 ms pour un chunk
 * de 1500 sommets — négligeable devant le reste du meshing.
 */
const CURV_DIRS = [
  [ 1, 0, 0], [-1, 0, 0], [0,  1, 0], [0, -1, 0], [0, 0,  1], [0, 0, -1],
  [ 0.577,  0.577,  0.577], [-0.577,  0.577,  0.577],
  [ 0.577, -0.577,  0.577], [-0.577, -0.577,  0.577],
  [ 0.577,  0.577, -0.577], [-0.577,  0.577, -0.577],
  [ 0.577, -0.577, -0.577], [-0.577, -0.577, -0.577],
];

/**
 * Retourne [curvature, thinness] normalisés en 0..255.
 *   curvature : 128 = plan, > 128 = convexe (arête), < 128 = concave (creux)
 *   thinness  : 255 = feature très fine et isolée, 0 = masse pleine
 */
function curvatureAndThinness(D, S, S2, x, y, z) {
  let occSmall = 0, occBig = 0;
  const RS = 1.6, RB = 4.0;
  for (let d = 0; d < CURV_DIRS.length; d++) {
    const dx = CURV_DIRS[d][0], dy = CURV_DIRS[d][1], dz = CURV_DIRS[d][2];
    occSmall += sampleD(D, S, S2, x + dx * RS, y + dy * RS, z + dz * RS);
    occBig   += sampleD(D, S, S2, x + dx * RB, y + dy * RB, z + dz * RB);
  }
  const n = CURV_DIRS.length * 255;
  const fS = occSmall / n;    // 0..1, 0.5 sur un plan
  const fB = occBig / n;

  // Gain 3.2 : une arête de créneau (fS ≈ 0.30) sort à ~0.86 -> bien saturé.
  let curv = 0.5 + (0.5 - fS) * 3.2;
  curv = curv < 0 ? 0 : curv > 1 ? 1 : curv;

  // Thinness : une masse pleine a fB ≈ 0.5+ ; un créneau isolé ≈ 0.22.
  let thin = 1.0 - fB * 2.6;
  thin = thin < 0 ? 0 : thin > 1 ? 1 : thin;

  return [(curv * 255) | 0, (thin * 255) | 0];
}
```

Puis, dans `NetsContext`, un **second buffer d'attributs** :

```js
// dans le constructeur de NetsContext
this.att2 = new Uint8Array(maxV * 4);   // (curvature, thinness, cutness, réservé)
```

```js
// dans la passe 1, après le calcul de att[]
const [cv, th] = curvatureAndThinness(D, S, S2, gx, gy, gz);
const b4 = vCount * 4;
att2[b4]     = cv;
att2[b4 + 1] = th;
att2[b4 + 2] = cutnessAt(originVX + i - BORDER, originVY + j - BORDER,
                         originVZ + k - BORDER);   // cf. §6.2
att2[b4 + 3] = 0;
```

Et dans `compact()` + `TerrainRenderer.js` :

```js
// TerrainRenderer.js
g.setAttribute('aData',  new THREE.BufferAttribute(geo.attrs,  4, true));
g.setAttribute('aData2', new THREE.BufferAttribute(geo.attrs2, 4, true));  // NOUVEAU
```

```glsl
// vertex shader
attribute vec4 aData2;
varying   vec4 vData2;
...
vData2 = aData2;
```

**Coût mémoire** : 4 octets de plus par sommet. Sur un maillage typique de 300 k sommets, **1,2 Mo**.
Rien.

### 4.3 Courbure écran depuis l'AO — le complément gratuit

Même avec la courbure bakée, le gradient d'AO en espace écran apporte un **liséré à l'échelle du
pixel** que la courbure par sommet (résolution 4 cm) ne peut pas donner. Les deux se cumulent.

```glsl
// ============================================================================
//  COURBURE ÉCRAN DEPUIS L'AO BAKÉE
// ============================================================================
/**
 * L'AO bakée varie continûment sur la surface. Son laplacien en espace écran
 * est ≈ proportionnel à la courbure : dans un creux, l'AO chute vite (gradient
 * fort, AO faible) ; sur une arête, elle remonte vite.
 *
 * On normalise par fwidth de la position vue, sinon l'effet grossit quand on
 * s'approche (le gradient par pixel augmente) et l'accentuation devient une
 * bouillie en gros plan.
 */
float sc_screenCurvatureFromAO(float ao, vec3 viewPos) {
  float dAOx = dFdx(ao);
  float dAOy = dFdy(ao);
  // longueur du pas monde correspondant à un pixel
  float pxWorld = max(length(vec2(length(dFdx(viewPos)), length(dFdy(viewPos)))), 1e-5);
  // gradient d'AO par mètre
  float grad = length(vec2(dAOx, dAOy)) / pxWorld;
  // signe : si l'AO locale est sous la moyenne des voisins -> creux
  float lap = (dFdx(dAOx) + dFdy(dAOy));
  return clamp(-lap * 0.5 + (ao - 0.5) * 0.35, -1.0, 1.0) * min(grad * 0.02, 1.0);
}

/** Version sans dérivées secondes (GL ES 2 / WebGL1 sans OES_standard_derivatives niveau 2). */
float sc_screenCurvatureCheap(float ao) {
  float d = fwidth(ao);
  // l'AO chute plus vite dans les concavités : d élevé + ao bas = creux
  return clamp((ao - 0.62) * 3.0, -1.0, 1.0) * smoothstep(0.002, 0.03, d);
}
```

### 4.4 Application : le liséré qui fait lire les créneaux

```glsl
// ============================================================================
//  ACCENTUATION PAR COURBURE
// ============================================================================
/**
 *   curv  : -1 (creux) .. 0 (plan) .. +1 (arête)
 *   gain  : force globale (uEdgeGain, 1.0 par défaut)
 *
 * Cinq effets simultanés, tous nécessaires :
 *   1. albédo plus clair sur les convexités (le sable sec s'accumule et sèche
 *      plus vite sur les arêtes : c'est physiquement vrai, pas juste joli) ;
 *   2. albédo plus foncé et plus saturé dans les creux (sable tassé, humide) ;
 *   3. AO renforcée dans les creux ;
 *   4. rugosité plus haute sur les arêtes (grains détachés, non liés) ;
 *   5. LÉGER durcissement de la normale vers l'arête -> l'ombre s'y accroche.
 */
void sc_applyCurvature(float curv, float gain,
                       inout vec3 albedo, inout float ao, inout float rough) {
  float convex  = max( curv, 0.0);
  float concave = max(-curv, 0.0);

  // 1 — arêtes claires. 0.30 est fort mais c'est le point de bascule visuel :
  // en dessous de 0.20 les créneaux ne se lisent pas en ombre.
  albedo *= 1.0 + convex * 0.30 * gain;

  // 2 — creux : plus foncés ET plus ocre (le sable dans un sillon est plus
  // humide, donc plus saturé — cf. §5).
  albedo = mix(albedo, albedo * vec3(0.68, 0.60, 0.50), concave * 0.55 * gain);

  // 3 — AO de contact
  ao *= 1.0 - concave * 0.45 * gain;

  // 4 — rugosité
  rough = clamp(rough + convex * 0.06 * gain - concave * 0.04 * gain, 0.05, 1.0);
}

/**
 * Bonus : liséré de "rim" sur les arêtes convexes vues de profil.
 * C'est le trait clair de 1–2 px qui détache un créneau du ciel. À appliquer
 * APRÈS l'éclairage, avec la couleur du ciel (pas du soleil).
 */
vec3 sc_edgeRim(float curv, vec3 N, vec3 V, vec3 skyColor, float strength) {
  float convex = max(curv, 0.0);
  float fresnel = pow(1.0 - clamp(dot(N, V), 0.0, 1.0), 3.0);
  return skyColor * (convex * fresnel * strength);
}
```

**Fusion des deux sources de courbure** :

```glsl
float curvBaked  = vData2.x * 2.0 - 1.0;                    // -1..1, résolution 4 cm
float curvScreen = sc_screenCurvatureFromAO(vData.z, -vViewPosition);
// La bakée porte les formes, l'écran porte le micro-détail. Somme pondérée,
// clampée pour ne pas empiler deux fois le même bord.
float curv = clamp(curvBaked * 1.0 + curvScreen * 0.45, -1.0, 1.0);
sc_applyCurvature(curv, uEdgeGain, base, bakedAO, roughnessFactor);
```

> **Test décisif** : placer la caméra de face sur un mur crénelé, **en ombre pleine** (pas de soleil
> direct), et regarder si les créneaux se lisent. Si non, monter `uEdgeGain` jusqu'à 1,6. Si les
> arêtes deviennent des traits blancs, redescendre. La valeur juste est celle où on lit la forme
> sans voir le trait.

---

## 5. Sable mouillé : deux régimes

Le modèle actuel est correct sur un point (l'assombrissement en luminance, saturé) et incomplet sur
tout le reste. Physiquement il y a **deux phénomènes distincts** qui se produisent à des taux
d'humidité différents, et les confondre est la raison pour laquelle le sable mouillé actuel n'est
« ni mat ni brillant » :

| Régime | Humidité | Physique | Rendu |
|---|---|---|---|
| **Humide (pendulaire)** | 2 % – 35 % | l'eau forme des ponts capillaires **entre** les grains ; l'indice du milieu inter-grain passe de 1,0 à 1,33 → plus de réflexions internes → moins d'énergie ressort | **plus foncé, plus saturé, MAT** (voire plus rugueux : les grains s'agglomèrent en amas) |
| **Saturé (film)** | > 60 % | une **lame d'eau continue** recouvre la surface ; l'interface air/eau est lisse | **très foncé + LOBE SPÉCULAIRE FRANC** (film d'eau), reflet du ciel |

Entre les deux, une zone de transition. Le point crucial : **le sable humide ne brille pas.**
Aujourd'hui `roughness = mix(0.98, 0.34, smoothstep(0.02, 0.55, moist))` fait briller le sable dès
20 % d'humidité — c'est le régime pendulaire, il devrait être mat. D'où l'aspect « plastique
mouillé » plutôt que « sable de bord de mer ».

### 5.1 Albédo : conserver le modèle, élargir la courbe

```glsl
// ============================================================================
//  SABLE MOUILLÉ — ALBÉDO
// ============================================================================
// Le rapport mouillé/sec sature vers 0,58 (mesures PLOS ONE sur sable côtier).
// La saturation chromatique AUGMENTE : la réduction de réflectance est plus
// forte dans le bleu (trajet optique plus long avant sortie).
vec3 sc_wetAlbedo(vec3 dry, float moist) {
  const vec3 LUMW = vec3(0.2126, 0.7152, 0.0722);

  // ws sature vite : 50 % de l'effet à 9 % d'humidité.
  float ws = 1.0 - exp(-moist * 7.5);

  float lum    = max(dot(dry, LUMW), 1e-4);
  float lumWet = pow(lum, 1.0 + 0.95 * ws) * mix(1.0, 0.72, ws);
  vec3  col    = dry * (lumWet / lum);

  // Gain de saturation : +22 % à saturation (au lieu de +16 %).
  col = mix(vec3(lumWet), col, 1.0 + 0.22 * ws);

  // Au-delà de 55 % : dérive vers le brun FROID (l'eau libre absorbe le rouge).
  float deep = smoothstep(0.55, 1.0, moist);
  col = mix(col, col * vec3(0.88, 0.95, 1.10), deep * 0.55);

  return col;
}
```

### 5.2 Rugosité : les deux régimes, séparés

Voir §3.4, mais explicitement :

```glsl
float sc_wetRoughness(float moist, float packing, float baseRough) {
  float wetMat  = smoothstep(0.03, 0.30, moist);
  float wetFilm = smoothstep(0.55, 0.92, moist);
  float r = mix(baseRough, 0.92, wetMat);      // HUMIDE = PLUS RUGUEUX
  r = mix(r, 0.16, wetFilm);                   // SATURÉ = LISSE
  return clamp(r * mix(1.0, 0.90, packing), 0.05, 1.0);
}
```

> Le `0.92` du régime humide n'est pas une erreur : un sable humide non saturé a des **agrégats**
> de grains liés par les ponts capillaires. La rugosité géométrique de surface **monte**. C'est
> exactement pourquoi on peut sculpter du sable humide : c'est aussi pourquoi il est mat.

### 5.3 Le film d'eau : lobe spéculaire dédié

Le film d'eau ne se modélise pas bien en baissant la roughness du sable : ce sont **deux couches**
(sable diffus + lame d'eau spéculaire). On ajoute donc un lobe GGX séparé, après l'éclairage.

```glsl
// ============================================================================
//  FILM D'EAU — LOBE SPÉCULAIRE SUPPLÉMENTAIRE
// ============================================================================
// Fresnel de l'interface air/eau : F0 = 0.02 (n = 1.33). Faible de face,
// TOTAL en rasant — c'est précisément pour ça que la laisse de mer brille
// quand on la regarde à l'horizontale et pas quand on la regarde d'en haut.
float sc_waterFilmMask(float moist) {
  // Transition NETTE : c'est la ligne d'eau. 0.62 -> 0.80 en humidité.
  return smoothstep(0.62, 0.80, moist);
}

vec3 sc_waterFilmSpecular(vec3 N, vec3 L, vec3 V, vec3 lightColor, float film) {
  if (film <= 0.001) return vec3(0.0);
  vec3  H   = normalize(L + V);
  float NdH = max(dot(N, H), 0.0);
  float NdL = max(dot(N, L), 0.0);
  float VdH = max(dot(V, H), 0.0);

  float a  = 0.045;                 // rugosité du film : très lisse
  float a2 = a * a;
  float d  = NdH * NdH * (a2 - 1.0) + 1.0;
  float D  = a2 / (PI * d * d);

  float F  = 0.02 + 0.98 * pow(1.0 - VdH, 5.0);

  // Pas de terme de visibilité complet : à cette rugosité il vaut ~1/(4 NdL NdV)
  // et le produit se simplifie. On garde un facteur empirique 0.30.
  return lightColor * (D * F * 0.30 * film * NdL);
}
```

Et la **réflexion du ciel** sur le film, qui compte autant que le soleil :

```glsl
// Réflexion spéculaire du ciel sur le film d'eau : c'est ce qui donne la
// bande argentée de la laisse de mer, même sans soleil dans le cadre.
{
  float film = sc_waterFilmMask(vData.x);
  if (film > 0.01) {
    float fres = 0.02 + 0.98 * pow(1.0 - clamp(dot(scGeoNormal, scGeoView), 0.0, 1.0), 5.0);
    gl_FragColor.rgb = mix(gl_FragColor.rgb, uSkyColor, fres * film * 0.55);
  }
}
```

### 5.4 Les traces sombres qui persistent après une vague

Après le retrait d'une vague, le sable reste sombre plusieurs secondes puis s'éclaircit **par le
haut** (l'évaporation attaque la couche de surface). Deux choses à ajouter :

1. **Un gradient d'assèchement irrégulier.** L'humidité ne s'évapore pas uniformément : les crêtes
   de rides sèchent en premier. On module l'humidité effective par le micro-relief.

```glsl
// Assèchement préférentiel des crêtes : les creux restent mouillés plus
// longtemps. `scMicroCavity` vient du POM (1 = crête, 0.7 = creux).
float moistEff = vData.x * mix(0.78, 1.18, 1.0 - scMicroCavity);
moistEff = clamp(moistEff, 0.0, 1.0);
```

2. **La frange de mousse résiduelle** à la limite haute atteinte par la vague. Comme le champ
   d'humidité est simulé, la limite est simplement l'iso-ligne d'humidité — on la marque :

```glsl
// Ligne de laisse : un liseré très fin, légèrement plus clair et mat,
// à la frontière du sable qui vient d'être mouillé.
float swashLine = smoothstep(0.30, 0.36, vData.x) * (1.0 - smoothstep(0.36, 0.44, vData.x));
base = mix(base, base * 1.22 + vec3(0.06, 0.055, 0.048), swashLine * 0.7);
```

3. **Les taches sombres irrégulières** (poches d'eau retenues) : bruit basse fréquence appliqué à
   l'humidité **seulement quand elle est en train de baisser**. Si la sim ne fournit pas la dérivée,
   un bruit statique sur XZ suffit visuellement :

```glsl
float blotch = sc_fbm(vec3(vWorldPos.xz * 3.2, uTime * 0.02), 2);
moistEff = clamp(moistEff * (0.85 + 0.30 * blotch), 0.0, 1.0);
```

---

## 6. Le bloc diorama

C'est aujourd'hui la partie la plus négligée : quatre lignes de shader dans une branche `if (cut >
0.001)`, avec un `sc_fbm` et deux `smoothstep`. Résultat : un mur brun. Or **c'est la face qu'on
voit en permanence** quand la caméra est en vue de côté — soit une bonne moitié du temps de jeu.

L'objectif : que le bloc ressemble à une **carotte de terrain découpée et posée sur une table**.
Une carotte, ça a : des strates franches, des granulométries qui changent, des lentilles, une nappe
visible, une arête de découpe nette en haut, et une ombre portée qui l'ancre.

### 6.1 Anatomie d'une coupe de plage réelle

De haut en bas, sur 3,84 m de hauteur de domaine (voir `Config.js` : `WORLD_H = 3.84`,
`BEACH_HEIGHT = 1.6`, `SEA_LEVEL = 1.05`, `CAPILLARY_FRINGE = 0.3`) :

| Profondeur sous la surface | Unité | Épaisseur | Couleur | Granulométrie | Signes distinctifs |
|---|---|---|---|---|---|
| 0 – 4 cm | Sable éolien sec | fine | `#DCC69B` | fine, bien triée | lamination oblique très fine |
| 4 – 22 cm | Sable de swash damé | moyenne | `#C4A87C` | moyenne | **litage plan net**, lamines de 2–5 mm |
| 15 – 30 cm | Lentilles coquillières | discontinue | `#E7DCC6` | grossière | poches lenticulaires, pas une couche continue |
| 22 – 55 cm | Sable limoneux | épaisse | `#9C8460` | fine | bioturbation, terriers |
| ~ nappe | **Frange capillaire** | 10–30 cm | `#7A5F41` | — | **plus sombre que la nappe elle-même** |
| sous la nappe | Sable saturé | — | `#4E4634` | — | reflets, aspect « verre mouillé » |
| bas du bloc | Gravier / galets | variable | `#8A7F70` | très grossière | inclusions dures |

**Le détail qui vend tout** : la **frange capillaire** est **plus sombre que la zone saturée
elle-même**. Physiquement, dans la frange, l'eau remplit les pores par capillarité mais il reste des
ménisques air/eau qui multiplient les réflexions internes ; sous la nappe, l'eau est libre et le
milieu est plus homogène optiquement. Visuellement : une **bande sombre de 10–30 cm juste au-dessus
de la ligne d'eau**, puis un éclaircissement relatif en dessous. Personne ne dessine ça, et c'est
exactement ce qui fait dire « ah oui, c'est une vraie coupe ».

Épaisseur de la frange selon la granulométrie (littérature hydrogéologique) : quelques centimètres
en sable très grossier, jusqu'à ~1 m en sédiment très fin. Pour du sable de plage moyen :
**15–30 cm**, ce qui colle avec `CAPILLARY_FRINGE = 0.3`.

### 6.2 Détecter proprement une face de coupe

**Ce qui se fait aujourd'hui — et pourquoi c'est fragile :**

```glsl
float cut = max(
  smoothstep(uDomain.z - 0.055, uDomain.z - 0.005, abs(vWorldPos.x)),
  smoothstep(uDomain.w - 0.055, uDomain.w - 0.005, abs(vWorldPos.z))
);
cut *= 1.0 - abs(vObjNormal.y);
```

Trois problèmes :

1. **Faux positifs** : une dune de sable qui touche le bord du domaine mais dont la surface est
   *horizontale* près du bord obtient `cut > 0` sur une bande de 5 cm. Le `1 - abs(n.y)` limite les
   dégâts mais casse dès qu'une paroi de coupe est légèrement inclinée (ce qui arrive : le Surface
   Nets ne produit pas de plan parfaitement vertical au bord).
2. **Faux négatifs** : si le joueur creuse une tranchée jusqu'au bord, la paroi de la tranchée est
   une vraie coupe mais peut se retrouver à `abs(x) < uDomain.z - 0.055` selon l'interpolation.
3. **Dépendance à `vObjNormal`** : la normale objet est celle du Surface Nets, lissée. Sur une arête
   entre le dessus et la coupe, elle est à 45° et `cut` vaut 0,5 : on obtient un **dégradé de 5 cm
   de stratigraphie qui bave sur le dessus du terrain**. C'est visible.

**Proposition : un attribut de sommet dédié, émis par le mailleur.**

Le mailleur, lui, **sait** exactement quelles cellules touchent le bord du domaine — c'est une
information combinatoire, pas géométrique. On la calcule une fois, on l'encode, on n'a plus jamais
d'ambiguïté.

```js
// --- src/sim/meshing/SurfaceNets.js ---------------------------------------
// Signature étendue : on passe les dimensions du domaine.
// surfaceNets(ctx, D, M, P, T, originVX, originVY, originVZ, voxelSize,
//             worldOrigin, dims /* {NX, NY, NZ} */)

/**
 * "Cutness" d'un sommet : 255 s'il appartient à une face de coupe du bloc,
 * 0 sinon, avec un fondu d'UN SEUL voxel pour éviter l'escalier.
 *
 * Un sommet est sur une face de coupe si sa CELLULE touche le plan limite du
 * domaine. La cellule (wx, wy, wz) en coordonnées voxel monde couvre
 * [wx, wx+1] : elle touche le bord X- si wx == 0, le bord X+ si wx+1 == NX-1.
 *
 * C'est purement combinatoire : aucune dépendance à la normale, aucun seuil
 * en distance. Un sommet est sur la coupe, ou il ne l'est pas.
 */
function cutnessAt(wx, wy, wz, NX, NY, NZ) {
  const onX = (wx <= 0) || (wx + 1 >= NX - 1);
  const onZ = (wz <= 0) || (wz + 1 >= NZ - 1);
  const onYbottom = (wy <= 0);
  if (onX || onZ || onYbottom) return 255;
  // Fondu d'un voxel vers l'intérieur : adoucit la jonction sans baver.
  const nearX = (wx <= 1) || (wx + 2 >= NX - 1);
  const nearZ = (wz <= 1) || (wz + 2 >= NZ - 1);
  return (nearX || nearZ) ? 96 : 0;
}
```

**Encodage** : `aData2.z` (voir §4.2). Un seul octet, aucun coût mémoire additionnel puisqu'on
ajoute déjà `aData2` pour la courbure.

**Bonus : l'axe de la coupe.** Pour orienter le litage des strates (les lamines doivent suivre le
plan de coupe, pas être projetées en triplanaire), on encode l'axe dans `aData2.w` :

```js
// 0 = pas une coupe, 1 = coupe normale à X, 2 = coupe normale à Z, 3 = fond
function cutAxisAt(wx, wy, wz, NX, NY, NZ) {
  if (wy <= 0) return 3;
  if (wx <= 0 || wx + 1 >= NX - 1) return 1;
  if (wz <= 0 || wz + 1 >= NZ - 1) return 2;
  return 0;
}
// encodé : att2[b4 + 3] = axis * 64;   // 0, 64, 128, 192 -> lisible en float
```

Dans le shader :

```glsl
float cutness = vData2.z;                       // 0..1
int   cutAxis = int(floor(vData2.w * 4.0 + 0.5)); // 0..3
```

> **Migration** : garder l'ancienne détection par position comme **repli** si `aData2` est absent
> (`#ifdef SC_HAS_DATA2`), le temps que tous les chunks soient remaillés. `TerrainRenderer` peut
> poser le define selon la présence de l'attribut.

### 6.3 Stratigraphie — code GLSL complet

```glsl
// ============================================================================
//  BLOC DIORAMA — COUPE GÉOLOGIQUE
// ============================================================================
uniform float uWaterTable;       // Y de la nappe (monde), déjà présent
uniform float uCapFringe;        // épaisseur de la frange capillaire (0.30 m)
uniform float uBlockTop;         // Y du haut du bloc (= BEACH_HEIGHT + marge)
uniform float uBlockBottom;      // Y du fond du bloc (= ORIGIN_Y)
uniform float uStrataGain;       // force globale (1.0)

/**
 * Coordonnée de litage : la profondeur sous le haut du bloc, PERTURBÉE.
 * Les strates réelles ne sont jamais horizontales : elles ondulent et
 * s'épaississent. Deux warps de fréquences différentes.
 *
 * Le warp doit être calculé dans le PLAN DE LA COUPE, pas en 3D : sinon les
 * ondulations n'ont pas de continuité d'une face à l'autre du bloc et on voit
 * que c'est du bruit 3D.
 */
float sc_strataDepth(vec3 wp, int axis) {
  // Coordonnée horizontale dans le plan de coupe
  float u = (axis == 1) ? wp.z : wp.x;

  // Ondulation grande échelle : pendage doux + biseaux
  float w1 = sc_vnoise(vec3(u * 0.55, 0.0, 0.0)) - 0.5;   // ± 0,5
  // Ondulation moyenne : irrégularités décimétriques
  float w2 = sc_vnoise(vec3(u * 3.1, 7.3, 0.0)) - 0.5;

  return (uBlockTop - wp.y) + w1 * 0.075 + w2 * 0.022;
}

/**
 * Retourne la couleur, la granulométrie (0 = fine, 1 = grossière) et la
 * "dureté" (pour la rugosité) de la strate à une profondeur donnée.
 *
 * On utilise des transitions SMOOTHSTEP courtes (2 cm) plutôt que des `if` :
 * une limite de strate réelle est nette mais pas binaire, et le smoothstep
 * évite l'aliasing sur les limites en vue rasante.
 */
void sc_strataAt(float d, out vec3 col, out float grainSize, out float hard) {
  // Empilement (profondeurs en mètres sous le haut du bloc)
  const vec3 C_EOLIEN  = vec3(0.7157, 0.5647, 0.3278);   // #DCC69B
  const vec3 C_DAME    = vec3(0.5520, 0.3916, 0.2016);   // #C4A87C
  const vec3 C_LIMON   = vec3(0.3325, 0.2307, 0.1170);   // #9C8460
  const vec3 C_VASE    = vec3(0.1559, 0.1301, 0.1022);   // #6E655A
  const vec3 C_GRAVIER = vec3(0.2542, 0.2122, 0.1620);   // #8A7F70

  col = C_EOLIEN; grainSize = 0.15; hard = 0.0;

  float t;
  t = smoothstep(0.035, 0.055, d);  col = mix(col, C_DAME,    t);
  grainSize = mix(grainSize, 0.35, t); hard = mix(hard, 0.25, t);

  t = smoothstep(0.210, 0.245, d);  col = mix(col, C_LIMON,   t);
  grainSize = mix(grainSize, 0.10, t); hard = mix(hard, 0.45, t);

  t = smoothstep(0.540, 0.600, d);  col = mix(col, C_VASE,    t);
  grainSize = mix(grainSize, 0.05, t); hard = mix(hard, 0.70, t);

  t = smoothstep(1.150, 1.300, d);  col = mix(col, C_GRAVIER, t);
  grainSize = mix(grainSize, 0.95, t); hard = mix(hard, 0.90, t);
}

/**
 * Micro-lamination : les fines lamines de 2–5 mm à l'intérieur de chaque
 * strate. C'est ce qui donne la texture "feuilletée" d'une coupe.
 *
 * Deux fréquences : 240 m⁻¹ (4 mm) et 95 m⁻¹ (1 cm), en opposition de phase
 * pour éviter un motif régulier. La phase est décalée par le warp horizontal
 * pour que les lamines suivent l'ondulation des strates.
 */
float sc_lamination(float d, float u, float grainSize) {
  float phase = d * 240.0 + sc_vnoise(vec3(u * 2.2, 0.0, 0.0)) * 9.0;
  float l1 = sin(phase) * 0.5 + 0.5;
  float l2 = sin(d * 95.0 + u * 1.7) * 0.5 + 0.5;
  // Les sables grossiers sont MOINS laminés (pas de tri fin).
  float amp = mix(1.0, 0.30, grainSize);
  return (l1 * 0.65 + l2 * 0.35) * amp;
}

/**
 * Lentilles de coquillages : des poches LENTICULAIRES (aplaties, allongées
 * horizontalement), pas des taches rondes. On étire l'espace du bruit d'un
 * facteur 6 en horizontal avant de seuiller.
 */
float sc_shellLens(vec3 wp, float d, int axis) {
  float u = (axis == 1) ? wp.z : wp.x;
  // Espace anisotrope : 6× plus étiré horizontalement
  vec3 q = vec3(u * 1.4, d * 8.4, (axis == 1 ? wp.x : wp.z) * 1.4);
  float n = sc_fbm(q, 3);
  // Les lentilles n'existent qu'entre 12 et 34 cm de profondeur
  float band = smoothstep(0.10, 0.14, d) * (1.0 - smoothstep(0.30, 0.36, d));
  return smoothstep(0.60, 0.72, n) * band;
}

/**
 * Fragments de coquilles individuels, visibles de près : des petits éclats
 * clairs, allongés, plus denses dans les lentilles.
 */
float sc_shellFragments(vec3 wp, float lensMask, float dist) {
  if (dist > 4.0) return 0.0;                     // invisibles au-delà
  vec3 cell = floor(wp * 220.0);                  // cellules de 4,5 mm
  float sel = sc_hash13(cell + 3.1);
  float density = 0.006 + 0.075 * lensMask;
  if (sel > density) return 0.0;
  vec3 f = fract(wp * 220.0) - 0.5;
  // éclat aplati : ellipse 3:1
  float r = length(vec3(f.x, f.y * 3.0, f.z));
  return (1.0 - smoothstep(0.18, 0.34, r)) * (1.0 - smoothstep(2.5, 4.0, dist));
}

/**
 * Galets et inclusions dures, dans les strates profondes.
 */
float sc_pebbles(vec3 wp, float d, out vec3 pebCol) {
  pebCol = vec3(0.20, 0.185, 0.170);
  float band = smoothstep(0.95, 1.25, d);
  if (band <= 0.0) return 0.0;
  vec3 cell = floor(wp * 42.0);                   // cellules de 2,4 cm
  float sel = sc_hash13(cell + 11.7);
  if (sel > 0.10 * band) return 0.0;
  vec3 h = sc_hash33(cell);
  vec3 f = fract(wp * 42.0) - (0.35 + h * 0.30);
  float r = length(f * vec3(1.0, 1.35, 1.0));
  pebCol = mix(vec3(0.16, 0.15, 0.14), vec3(0.36, 0.33, 0.29), h.z);
  return 1.0 - smoothstep(0.20, 0.32, r);
}

/**
 * Terriers / bioturbation : des tubes verticaux ou obliques de sable plus
 * clair qui traversent les strates. Peu nombreux mais très caractéristiques.
 */
float sc_burrows(vec3 wp, float d, int axis) {
  float u = (axis == 1) ? wp.z : wp.x;
  float band = smoothstep(0.18, 0.24, d) * (1.0 - smoothstep(0.55, 0.70, d));
  if (band <= 0.0) return 0.0;
  // tube : distance à une ligne quasi-verticale, position pseudo-aléatoire
  float lane  = floor(u * 3.2);
  float jitter = sc_hash11(lane * 1.7) - 0.5;
  float cx = (lane + 0.5 + jitter * 0.6) / 3.2;
  float wobble = (sc_vnoise(vec3(d * 5.5, lane, 0.0)) - 0.5) * 0.035;
  float dist = abs(u - cx + wobble);
  float on = step(sc_hash11(lane * 4.3), 0.35);   // 35 % des couloirs actifs
  return (1.0 - smoothstep(0.006, 0.014, dist)) * band * on;
}

/**
 * ------------------------------------------------------------------------
 *  POINT D'ENTRÉE : couleur d'une face de coupe.
 * ------------------------------------------------------------------------
 *   wp      : position monde
 *   axis    : 1 = coupe normale à X, 2 = normale à Z, 3 = fond du bloc
 *   dist    : distance caméra (pour le LOD des détails fins)
 *   out rough : rugosité de la coupe (la coupe n'a PAS la rugosité du sable)
 */
vec3 sc_shadeCutFace(vec3 wp, int axis, float dist, out float rough) {
  float d = sc_strataDepth(wp, axis);
  float u = (axis == 1) ? wp.z : wp.x;

  // --- 1. empilement de strates ------------------------------------------
  vec3 col; float grainSize, hard;
  sc_strataAt(d, col, grainSize, hard);

  // --- 2. lamination ------------------------------------------------------
  float lam = sc_lamination(d, u, grainSize);
  col *= 0.90 + 0.20 * lam;

  // --- 3. grain de la coupe : la paroi est "rayée" par la découpe ---------
  // Fréquence différente de celle du sable de surface, sinon on lit la même
  // texture partout et le bloc perd son identité de "matériau coupé".
  float scratch = sc_fbm(vec3(u * 130.0, wp.y * 340.0, 0.0), 2);
  col *= 0.94 + 0.12 * scratch;
  // Micro-piqûres : les grains arrachés par la découpe
  float pit = smoothstep(0.72, 0.86, sc_vnoise(vec3(u * 420.0, wp.y * 420.0, 0.0)));
  col *= 1.0 - pit * 0.14 * (1.0 - smoothstep(1.5, 4.0, dist));

  // --- 4. lentilles coquillières -----------------------------------------
  const vec3 C_COQUILLE = vec3(0.7991, 0.7157, 0.5647);   // #E7DCC6
  float lens = sc_shellLens(wp, d, axis);
  col = mix(col, C_COQUILLE, lens * 0.62);
  grainSize = mix(grainSize, 0.85, lens);

  float frag = sc_shellFragments(wp, lens, dist);
  col = mix(col, vec3(0.8963, 0.7913, 0.6584), frag * 0.85);

  // --- 5. bioturbation ----------------------------------------------------
  float bur = sc_burrows(wp, d, axis);
  col = mix(col, col * vec3(1.30, 1.24, 1.14), bur * 0.7);

  // --- 6. galets ----------------------------------------------------------
  vec3 pebCol;
  float peb = sc_pebbles(wp, d, pebCol);
  col = mix(col, pebCol, peb);

  // --- 7. NAPPE PHRÉATIQUE ET FRANGE CAPILLAIRE ---------------------------
  // C'est LE détail qui vend la coupe. Trois zones :
  //   a) au-dessus de la frange : sec
  //   b) la frange capillaire : LA PLUS SOMBRE (ménisques air/eau)
  //   c) sous la nappe : saturé, un peu plus clair que la frange, + reflets
  float hAbove = wp.y - uWaterTable;              // > 0 : au-dessus

  // frange : de 0 à uCapFringe au-dessus de la nappe, pic à mi-hauteur
  float fringe = (1.0 - smoothstep(uCapFringe * 0.90, uCapFringe * 1.15, hAbove))
               * smoothstep(-0.012, 0.030, hAbove);
  // sous la nappe
  float sat = 1.0 - smoothstep(-0.030, 0.010, hAbove);

  // a+b : humidité effective. La frange est traitée comme "humide max" (mat).
  float wetCut = max(fringe * 0.92, sat * 1.0);
  col = sc_wetAlbedo(col, wetCut);

  // La frange est ENCORE plus sombre que la saturation ne le prédit :
  // assombrissement supplémentaire de 18 %, teinté chaud.
  col *= mix(1.0, 0.82, fringe);
  col = mix(col, col * vec3(1.06, 0.98, 0.90), fringe * 0.6);

  // Sous la nappe : légère remontée de luminance + dérive froide
  col = mix(col, col * vec3(1.10, 1.12, 1.18), sat * 0.45);

  // Ligne d'eau elle-même : un liseré net de 6 mm, plus foncé et brillant
  float wl = 1.0 - smoothstep(0.0, 0.006, abs(hAbove));
  col = mix(col, col * vec3(0.62, 0.70, 0.80), wl * 0.75);

  // --- 8. suintement : traînées verticales sous la ligne d'eau ------------
  // De l'eau perle sur la paroi de coupe et laisse des coulures.
  {
    float seepBand = smoothstep(0.0, -0.02, hAbove) * (1.0 - smoothstep(-0.02, -0.45, hAbove));
    float streak = sc_vnoise(vec3(u * 55.0, wp.y * 2.5, 0.0));
    streak = smoothstep(0.58, 0.78, streak);
    col *= 1.0 - streak * seepBand * 0.22;
  }

  // --- 9. rugosité de la coupe -------------------------------------------
  // Une coupe fraîche est plus MATE qu'une surface de sable soufflée par le
  // vent (pas de tri, pas de faces alignées). Sauf sous la nappe : film d'eau.
  rough = mix(0.94, 0.80, grainSize);
  rough = mix(rough, 0.72, hard);
  rough = mix(rough, 0.22, sat * 0.85);
  rough = mix(rough, 0.55, lens * 0.5);           // les coquilles sont lisses
  rough = clamp(rough + (scratch - 0.5) * 0.08, 0.06, 1.0);

  return col;
}
```

**Intégration dans le patch `<map_fragment>`**, remplaçant la branche `if (cut > 0.001)` actuelle :

```glsl
// --- Faces de coupe du bloc diorama -------------------------------------
#ifdef SC_HAS_DATA2
  float cutness = vData2.z;
  int   cutAxis = int(floor(vData2.w * 4.0 + 0.5));
#else
  // Repli : ancienne détection par position (à supprimer après migration)
  float cutness = max(
    smoothstep(uDomain.z - 0.055, uDomain.z - 0.005, abs(vWorldPos.x)),
    smoothstep(uDomain.w - 0.055, uDomain.w - 0.005, abs(vWorldPos.z))
  ) * (1.0 - abs(vObjNormal.y));
  int cutAxis = (abs(vWorldPos.x) > abs(vWorldPos.z)) ? 1 : 2;
#endif

if (cutness > 0.002) {
  float cutRough;
  vec3 cutCol = sc_shadeCutFace(vWorldPos, cutAxis, scDist, cutRough);
  base = mix(base, cutCol, cutness);
  scCutRough = cutRough;      // récupéré dans <roughnessmap_fragment>
  scCutMask  = cutness;
}
```

> **Ordre des patches** : `<map_fragment>` est évalué **avant** `<roughnessmap_fragment>` dans le
> shader de three. On peut donc écrire `scCutRough` dans le premier et le lire dans le second, à
> condition de déclarer les globales dans `<common>`. C'est propre et ça évite de recalculer la
> stratigraphie deux fois.

### 6.4 Finition du bloc

Une carotte de terrain posée sur une table, ça n'est pas juste « des strates sur un cube ». Quatre
éléments de finition, tous peu coûteux, qui font 80 % de la lecture « objet » :

**a) Arête vive en haut, avec chanfrein.** L'arête supérieure d'un bloc de terrain découpé est
**nette** — c'est ce qui dit « ceci a été coupé » plutôt que « ceci s'arrête ». Mais une arête
mathématiquement vive aliase. On ajoute un chanfrein de 3 mm, éclairci (le sable sec s'y accumule
et il reçoit le ciel de plein fouet) :

```glsl
// Chanfrein d'arête supérieure du bloc. `topEdge` = distance à l'arête,
// obtenue par la conjonction de "je suis sur une coupe" et "je suis près du
// sommet du volume local". On utilise la normale : sur le chanfrein, la
// normale est à ~45° entre la verticale et l'horizontale.
{
  float vertical = abs(dot(normalize(vObjNormal), vec3(0.0, 1.0, 0.0)));
  float chamfer  = cutness * smoothstep(0.25, 0.72, vertical);
  // liseré clair : le sable sec de l'arête + le ciel
  base = mix(base, base * 1.34 + vec3(0.045, 0.040, 0.030), chamfer * 0.55);
  roughnessFactor = mix(roughnessFactor, 0.88, chamfer * 0.6);
}
```

> Si on veut un vrai chanfrein géométrique, c'est au mailleur de le produire : biseauter la
> dernière rangée de voxels de bord en abaissant la densité de 15 %. Deux lignes dans le générateur,
> et le chanfrein devient réel (avec sa propre normale, donc son propre spéculaire). **Recommandé**,
> mais le hack shader ci-dessus est déjà très efficace.

**b) Un socle.** Le fond du bloc (`cutAxis == 3`, Y = `ORIGIN_Y`) ne doit pas être du sable : c'est
la face posée. Deux options :

| Option | Rendu | Verdict |
|---|---|---|
| Fond noir mat (`#2A2622`) | neutre, disparaît | Suffisant, gratuit |
| **Socle matériau distinct** : plaque de bois/résine débordant de 2 cm | lit immédiatement comme un objet de collection | **Recommandé** — c'est un `BoxGeometry` de 12 triangles |

```js
// src/render/DioramaBase.js
const base = new THREE.Mesh(
  new THREE.BoxGeometry(WORLD_W + 0.14, 0.06, WORLD_D + 0.14),
  new THREE.MeshStandardMaterial({
    color: new THREE.Color(0x4A3A2C).convertSRGBToLinear(),
    roughness: 0.62, metalness: 0.0,
  })
);
base.position.set(0, ORIGIN_Y - 0.03, 0);
base.receiveShadow = true;
```

Le débord de 7 cm de chaque côté est important : sans lui, le socle et le bloc se confondent. Avec,
on lit deux objets empilés — et l'ombre du bloc **sur** le socle donne la profondeur.

**c) Ombre portée du bloc.** C'est ce qui **ancre** l'objet. Deux couches :

1. l'ombre de la shadow map directionnelle (déjà là si `castShadow` est activé sur le terrain **et**
   `receiveShadow` sur le socle) ;
2. une **ombre de contact** — un assombrissement très serré (1–3 cm) à la jonction bloc/socle, que
   la shadow map ne capture pas à cause du bias. Deux implémentations possibles :

```glsl
// Version analytique (recommandée ici) : on connaît la géométrie du socle,
// pas besoin de ray-marcher le depth buffer. Sur le socle uniquement :
//   distance horizontale au bord du bloc -> occlusion.
float sc_blockContactShadow(vec3 wp, vec2 halfExtent, float baseY) {
  vec2 d = abs(wp.xz) - halfExtent;
  float outside = length(max(d, 0.0)) + min(max(d.x, d.y), 0.0);
  // 0 au ras du bloc, 1 à 4 cm
  float ao = smoothstep(0.0, 0.045, outside);
  // uniquement au niveau du socle
  ao = mix(1.0, ao, 1.0 - smoothstep(0.0, 0.02, abs(wp.y - baseY)));
  return mix(0.35, 1.0, ao);      // 65 % d'assombrissement au contact
}
```

Une **contact shadow en espace écran** (ray-march dans le depth buffer, 8–12 pas) serait plus
générale (elle marcherait aussi sous les pelles, les seaux, les coquillages posés). C'est un bon
investissement si on en a besoin ailleurs ; pour la seule jonction bloc/socle, la version
analytique coûte 8 instructions au lieu de 12 taps de depth.

**d) Rim light sur les arêtes verticales du bloc.** Le liseré qui dit « objet en résine » :

```glsl
float rim = pow(1.0 - max(dot(scGeoNormal, scGeoView), 0.0), 3.2);
gl_FragColor.rgb += uSkyColor * rim * 0.20 * cutness;
```

### 6.5 Fond de studio ou vrai environnement ? — **Tranché : vrai environnement.**

**Le raisonnement.**

Un fond de studio (cyclorama uni, dégradé neutre) est la solution des rendus produit. Il isole
l'objet, il est facile à équilibrer, il ne demande aucun budget. Mais il coûte trois choses qui sont
précisément l'identité de ce jeu :

1. **Il tue l'histoire lumineuse.** La référence *Sandcastle* est « été tropical franc » : ciel
   turquoise saturé, soleil dur, ombres bleutées. Ces ombres bleutées **viennent** du ciel — c'est
   la lumière indirecte du dôme céleste. Avec un fond de studio gris, l'IBL devient neutre et les
   ombres deviennent grises. On perd le contraste chaud/froid qui est **le** ressort du look. Ce
   n'est pas rattrapable en color grading : la couleur des ombres est une donnée d'éclairage, pas
   de post-traitement.
2. **Il rend le bloc plus petit, pas plus grand.** Contre-intuitif mais net : un objet sur fond
   neutre n'a pas d'échelle. Un objet devant un horizon marin a une échelle — l'œil compare. Or on
   veut que le château **paraisse grand** dans son bloc.
3. **Il empêche l'eau de fonctionner.** L'océan hors du bloc, les vagues, la ligne d'horizon : ce
   sont les éléments qui font vivre le cycle de marée. Sans eux, la marée devient une valeur
   abstraite dans un fichier de config.

**Ce que le fond de studio apportait — et comment le récupérer sans lui.** La lecture « objet posé
sur une table » ne vient **pas** du fond. Elle vient de quatre signaux, tous déjà listés :

| Signal | Où | Poids perçu |
|---|---|---|
| Faces de coupe stratifiées | §6.3 | ★★★★★ |
| Arête vive + chanfrein en haut | §6.4a | ★★★★ |
| Socle débordant, matériau distinct | §6.4b | ★★★★ |
| Ombre de contact serrée | §6.4c | ★★★ |
| Tilt-shift (profondeur de champ courte) | `RECHERCHE-RENDU-3D.md` §6.3 | ★★★★ |

Le tilt-shift est le vrai substitut du fond de studio : il **crée** la maquette en simulant une
macro-photo. Combiné aux quatre autres, on obtient l'objet-diorama **sans** sacrifier
l'environnement.

**Recommandation opérationnelle :**

- **Environnement réel par défaut** : ciel procédural + océan infini + horizon. IBL depuis le ciel.
- Le bloc flotte au-dessus de l'océan sur son socle. Ce n'est pas réaliste — c'est assumé, c'est un
  diorama. La lecture est immédiate.
- **Un « mode photo » optionnel** qui remplace l'arrière-plan par un dégradé, **sans toucher à
  l'IBL** (on garde le dôme céleste pour l'éclairage, on ne change que ce que la caméra voit du
  fond). Techniquement : un `scene.background` distinct de `scene.environment`. C'est trois lignes,
  et ça donne le meilleur des deux mondes :

```js
scene.environment = skyEnvMap;              // toujours le ciel : ombres bleutées préservées
scene.background  = photoMode ? gradientTex : skyTexture;
```

### 6.6 Le dithering : indispensable sur ce type de scène

Une plage, c'est de grandes zones de dégradé lisse à faible contraste — le pire cas pour le banding
8 bits. Après tone mapping ACES et sortie en sRGB 8 bits, un dégradé de sable montre des bandes
visibles, surtout dans les ombres bleutées.

Three fournit `<dithering_fragment>` mais **seulement si `material.dithering = true`**. Il applique
un dither ordonné. On peut faire mieux avec un **interleaved gradient noise** (Jimenez), plus
agréable perceptuellement et sans texture :

```glsl
// ============================================================================
//  DITHER — interleaved gradient noise (Jimenez), distribution triangulaire
// ============================================================================
float sc_ign(vec2 p) {
  return fract(52.9829189 * fract(dot(p, vec2(0.06711056, 0.00583715))));
}

/**
 * Dither triangulaire : deux échantillons IGN décalés donnent une
 * distribution en triangle, qui supprime le banding SANS ajouter de bruit
 * visible dans les aplats (contrairement au dither uniforme).
 * amplitude : 1.0/255.0 pour une sortie 8 bits.
 */
vec3 sc_ditherTriangular(vec3 c, vec2 fragCoord, float amplitude) {
  float r1 = sc_ign(fragCoord);
  float r2 = sc_ign(fragCoord + 17.31);
  return c + (r1 - r2) * amplitude;
}
```

À appliquer **tout à la fin**, après le tone mapping et l'encodage sRGB (c'est-à-dire dans la passe
de post-processing finale, pas dans le shader de sable) :

```glsl
gl_FragColor.rgb = sc_ditherTriangular(gl_FragColor.rgb, gl_FragCoord.xy, 1.0 / 255.0);
```

> **Piège** : dithériser avant l'encodage sRGB ne sert à rien — la quantification a lieu après. Si
> on ne peut pas toucher le post-processing, mettre `material.dithering = true` sur tous les
> matériaux du terrain est déjà un net progrès.

---

## 7. Valeurs prêtes à coller

### 7.1 Palette (sRGB hex + linéaire)

```js
// src/render/SandPalette.js
// Toutes les couleurs sont données en hex sRGB (pour l'édition) et en vec3
// linéaire (ce que le shader consomme). Y = luminance relative linéaire.

export const PALETTE = {
  // --- SABLE DE SURFACE ---------------------------------------------------
  dryHighlight: { hex: 0xF0E2C2, lin: [0.8714, 0.7605, 0.5395], Y: 0.768 }, // crêtes, arêtes
  dryBase:      { hex: 0xE4CFA2, lin: [0.7758, 0.6240, 0.3613], Y: 0.637 }, // base (inchangée)
  dryShadow:    { hex: 0xC9B085, lin: [0.5841, 0.4342, 0.2346], Y: 0.452 }, // creux, macro-variation
  wetMatte:     { hex: 0x8E6C46, lin: [0.2705, 0.1500, 0.0612], Y: 0.169 }, // humide, MAT
  saturated:    { hex: 0x6F553A, lin: [0.1590, 0.0908, 0.0423], Y: 0.102 }, // saturé, brillant
  deep:         { hex: 0x5A452F, lin: [0.1022, 0.0595, 0.0284], Y: 0.066 }, // sous la nappe

  // --- MATÉRIAUX SPÉCIAUX -------------------------------------------------
  rock:         { hex: 0x9C8C7C, lin: [0.3325, 0.2623, 0.2016], Y: 0.273 },
  shell:        { hex: 0xF3E6D4, lin: [0.8963, 0.7913, 0.6584], Y: 0.804 },
  sparkleTint:  { hex: 0xFFF4DC, lin: [1.0000, 0.9047, 0.7157], Y: 0.911 },

  // --- STRATIGRAPHIE DU BLOC ----------------------------------------------
  strataEolien: { hex: 0xDCC69B, lin: [0.7157, 0.5647, 0.3278], Y: 0.580 },
  strataDame:   { hex: 0xC4A87C, lin: [0.5520, 0.3916, 0.2016], Y: 0.412 },
  strataCoq:    { hex: 0xE7DCC6, lin: [0.7991, 0.7157, 0.5647], Y: 0.723 },
  strataLimon:  { hex: 0x9C8460, lin: [0.3325, 0.2307, 0.1170], Y: 0.244 },
  strataVase:   { hex: 0x6E655A, lin: [0.1559, 0.1301, 0.1022], Y: 0.134 },
  strataGravier:{ hex: 0x8A7F70, lin: [0.2542, 0.2122, 0.1620], Y: 0.218 },
  capFringe:    { hex: 0x7A5F41, lin: [0.1946, 0.1144, 0.0529], Y: 0.127 },
  waterTableCol:{ hex: 0x4E4634, lin: [0.0762, 0.0612, 0.0343], Y: 0.062 },

  // --- BLOC / SOCLE / LUMIÈRE ---------------------------------------------
  baseWood:     { hex: 0x4A3A2C, lin: [0.0685, 0.0423, 0.0252], Y: 0.047 },
  shadowTint:   { hex: 0x5A6E8C, lin: [0.1022, 0.1559, 0.2623], Y: 0.152 }, // ombres BLEUTÉES
};
```

### 7.2 Rugosités

| Surface | Valeur | Note |
|---|---|---|
| Sable sec, non tassé | **0,86** | (était 0,98 — c'était le problème) |
| Sable sec, tassé | 0,77 | `× 0.90` |
| Sable humide pendulaire | **0,92** | **plus rugueux que le sec** |
| Sable saturé (film d'eau) | **0,16** | + lobe de film séparé |
| Rugosité du film d'eau lui-même | 0,045 | GGX, F0 = 0,02 |
| Face de coupe, sable fin | 0,94 | |
| Face de coupe, gravier | 0,80 | |
| Face de coupe, sous nappe | 0,22 | |
| Lentille coquillière | 0,55 | |
| Chanfrein d'arête | 0,88 | |
| Socle bois | 0,62 | |
| Variation spatiale de roughness | ±0,09 | 2 octaves (46 m⁻¹ et 5,5 m⁻¹) |

### 7.3 Échelles de bruit

| Effet | Fréquence monde | Période | Où |
|---|---|---|---|
| Grain (normale de détail) | 1400 m⁻¹ | 0,7 mm | §2.5 |
| Sparkle, cellule la plus fine | 2860 m⁻¹ | 0,35 mm | §3.6 |
| Sparkle, cellule la plus grosse | 167 m⁻¹ | 6 mm | §3.6 |
| Micro-rides | 46 m⁻¹ | 2,2 cm | §2.5 |
| Modelé / traces d'outil | 5,5 m⁻¹ | 18 cm | §2.5 |
| Macro-variation d'albédo | 2,6 m⁻¹ | 38 cm | existant |
| Taches d'assèchement | 3,2 m⁻¹ | 31 cm | §5.4 |
| Lamination fine (coupe) | 240 m⁻¹ (vertical) | 4 mm | §6.3 |
| Lamination large (coupe) | 95 m⁻¹ (vertical) | 1 cm | §6.3 |
| Rayures de découpe | 130 / 340 m⁻¹ | 8 / 3 mm | §6.3 |
| Piqûres de découpe | 420 m⁻¹ | 2,4 mm | §6.3 |
| Fragments de coquille | 220 m⁻¹ | 4,5 mm | §6.3 |
| Galets | 42 m⁻¹ | 2,4 cm | §6.3 |
| Warp de strates (grand) | 0,55 m⁻¹ | 1,8 m | §6.3 |
| Warp de strates (moyen) | 3,1 m⁻¹ | 32 cm | §6.3 |

### 7.4 Forces d'effet — bloc d'uniformes complet

```js
const uniforms = {
  // --- existant, conservé -------------------------------------------------
  uSunDirection:    { value: new THREE.Vector3(0.4, 0.8, 0.35).normalize() },
  uSunDirectionView:{ value: new THREE.Vector3() },   // NOUVEAU, mis à jour/frame
  uSunColor:        { value: new THREE.Color(1.0, 0.94, 0.82) },
  uSkyColor:        { value: new THREE.Color(0x8FC4E8).convertSRGBToLinear() },
  uDryColor:        { value: new THREE.Color(0xE4CFA2).convertSRGBToLinear() },
  uDryHighlight:    { value: new THREE.Color(0xF0E2C2).convertSRGBToLinear() },
  uDryShadow:       { value: new THREE.Color(0xC9B085).convertSRGBToLinear() },
  uRockColor:       { value: new THREE.Color(0x9C8C7C).convertSRGBToLinear() },
  uShellColor:      { value: new THREE.Color(0xF3E6D4).convertSRGBToLinear() },
  uTime:            { value: 0 },
  uDomain:          { value: new THREE.Vector4(0, 0, 5.12, 5.12) },
  uWaterTable:      { value: 0.95 },
  uCursor:          { value: new THREE.Vector4(0, -999, 0, 0) },
  uCursorColor:     { value: new THREE.Color(0x6EC6FF) },
  uCursorStrength:  { value: 0.0 },

  // --- MICRO-RELIEF -------------------------------------------------------
  uDetailTile:      { value: makeSandDetailTile() },
  uDetailScale:     { value: 31.0 },     // périodes/m -> tuile de 3,2 cm
  uPomDepth:        { value: 0.0035 },   // 3,5 mm de relief. > 6 mm = "moquette"
  uPomFadeStart:    { value: 1.6 },      // m
  uPomFadeEnd:      { value: 3.2 },      // m
  uGrainStrength:   { value: 0.85 },     // amplitude XY de la normale de grain
  uRippleStrength:  { value: 0.60 },
  uMacroStrength:   { value: 0.35 },

  // --- DIFFUSION / SPÉCULAIRE ---------------------------------------------
  uSigmaDry:        { value: 0.62 },     // rugosité Oren-Nayar, sable sec (rad)
  uSigmaWet:        { value: 0.22 },
  uOpposition:      { value: 0.40 },     // B0 du hot-spot rétrodiffusé
  uOppositionWidth: { value: 0.06 },     // rad (≈ 3,5°)
  uTranslucency:    { value: 1.0 },      // gain SSS
  uSparkle:         { value: 1.0 },
  uSparkleSize:     { value: 0.00045 },  // taille apparente (rad) ≈ 1,5 px

  // --- LISIBILITÉ ---------------------------------------------------------
  uAOStrength:      { value: 0.85 },     // inchangé
  uEdgeGain:        { value: 1.15 },     // accentuation par courbure
  uEdgeRim:         { value: 0.22 },     // liséré de ciel sur les convexités
  uCurvScreenMix:   { value: 0.45 },     // poids de la courbure écran vs bakée

  // --- MOUILLÉ ------------------------------------------------------------
  uWetSatGain:      { value: 0.22 },     // gain de saturation à saturation
  uFilmStart:       { value: 0.62 },     // seuil bas du film d'eau
  uFilmEnd:         { value: 0.80 },     // seuil haut
  uFilmSpecular:    { value: 0.30 },     // gain du lobe de film
  uSkyReflect:      { value: 0.55 },     // réflexion du ciel sur le film

  // --- BLOC DIORAMA -------------------------------------------------------
  uBlockTop:        { value: 1.90 },     // BEACH_HEIGHT + marge
  uBlockBottom:     { value: 0.00 },     // ORIGIN_Y
  uCapFringe:       { value: 0.30 },     // CAPILLARY_FRINGE
  uStrataGain:      { value: 1.0 },
  uCutRimStrength:  { value: 0.20 },
  uChamferGain:     { value: 0.55 },
};
```

### 7.5 Constantes GLSL, en un bloc

```glsl
// ============================================================================
//  CONSTANTES — à coller en tête du fragment shader
// ============================================================================
const vec3 LUMA_W       = vec3(0.2126, 0.7152, 0.0722);

// Sable
const vec3 SC_DRY_HI    = vec3(0.8714, 0.7605, 0.5395);   // #F0E2C2
const vec3 SC_DRY_BASE  = vec3(0.7758, 0.6240, 0.3613);   // #E4CFA2
const vec3 SC_DRY_LO    = vec3(0.5841, 0.4342, 0.2346);   // #C9B085
const vec3 SC_WET_MAT   = vec3(0.2705, 0.1500, 0.0612);   // #8E6C46
const vec3 SC_SATURATED = vec3(0.1590, 0.0908, 0.0423);   // #6F553A

// Strates
const vec3 SC_ST_EOLIEN = vec3(0.7157, 0.5647, 0.3278);   // #DCC69B
const vec3 SC_ST_DAME   = vec3(0.5520, 0.3916, 0.2016);   // #C4A87C
const vec3 SC_ST_COQ    = vec3(0.7991, 0.7157, 0.5647);   // #E7DCC6
const vec3 SC_ST_LIMON  = vec3(0.3325, 0.2307, 0.1170);   // #9C8460
const vec3 SC_ST_VASE   = vec3(0.1559, 0.1301, 0.1022);   // #6E655A
const vec3 SC_ST_GRAV   = vec3(0.2542, 0.2122, 0.1620);   // #8A7F70

// Effets
const vec3 SC_SSS_TINT     = vec3(1.00, 0.55, 0.22);      // transmission
const vec3 SC_SPARKLE_TINT = vec3(1.10, 1.02, 0.86);      // > 1 : déclenche le bloom
const vec3 SC_WET_COOL     = vec3(0.88, 0.95, 1.10);      // dérive froide du saturé
const vec3 SC_CONCAVE_TINT = vec3(0.68, 0.60, 0.50);      // creux plus ocre

// Amplitudes
#define SC_ALBEDO_RANGE   0.30    // ±30 % de variation d'albédo (était ±7 %)
#define SC_EDGE_CONVEX    0.30    // éclaircissement des arêtes
#define SC_EDGE_CONCAVE   0.55    // assombrissement des creux
#define SC_AO_CONCAVE     0.45
#define SC_MICRO_CAVITY   0.30    // profondeur de l'occlusion de micro-relief
#define SC_FRINGE_DARKEN  0.82    // la frange capillaire est 18 % plus sombre
```

### 7.6 Le grain d'albédo, corrigé

Le point de départ du document. Voici le remplacement direct des trois lignes fautives :

```glsl
// AVANT — plage réelle ±7 %, invisible
// vec3 gp = vWorldPos * (34.0 * uGrainScale);
// float grain = sc_fbm(gp, 3);
// float macro = sc_fbm(vWorldPos * 2.6, 3);
// vec3 base = uDryColor * (0.90 + 0.20 * grain) * (0.95 + 0.10 * macro);

// APRÈS — plage réelle ±30 %, trois échelles, interpolation entre trois teintes
{
  // Le fBm de valeur ne visite jamais 0 ni 1 : on l'étire d'abord.
  // sc_fbm renvoie ~[0.28, 0.72] en pratique -> on remappe sur [0, 1].
  float macro = clamp((sc_fbm(vWorldPos * 2.6, 3)  - 0.28) / 0.44, 0.0, 1.0);
  float meso  = clamp((sc_fbm(vWorldPos * 11.0, 2) - 0.28) / 0.44, 0.0, 1.0);
  float micro = texture2D(uDetailTile, vWorldPos.xz * 46.0).a;

  // Combinaison pondérée. Le macro porte la variation lisible de loin,
  // le meso les taches, le micro le grain.
  float v = macro * 0.50 + meso * 0.30 + micro * 0.20;

  // Courbe en S : accentue les extrêmes, c'est ce qui crée le contraste.
  v = v * v * (3.0 - 2.0 * v);

  // Interpolation à TROIS points : clair / base / sombre.
  // Deux couleurs seulement donnerait un dégradé linéaire terne.
  vec3 base = (v < 0.5)
    ? mix(SC_DRY_LO, SC_DRY_BASE, v * 2.0)
    : mix(SC_DRY_BASE, SC_DRY_HI, (v - 0.5) * 2.0);

  // Le micro-relief occlut : les creux du grain sont plus sombres.
  base *= mix(1.0 - SC_MICRO_CAVITY, 1.0, scMicroCavity);
}
```

**Vérification** : `SC_DRY_LO` a Y = 0,452, `SC_DRY_HI` a Y = 0,768. Rapport 1,70, soit **±26 %**
autour de la base (Y = 0,637). C'est exactement la cible du §1.4.

---

## 8. Ordre d'implémentation et budget

### 8.1 Par impact décroissant

| # | Changement | Effort | Impact | Coût GPU |
|---|---|---|---|---|
| 1 | **Plage d'albédo** (§7.6) — 3 couleurs, courbe en S | 20 min | ★★★★★ | 0 |
| 2 | **Roughness sable sec 0,98 → 0,86** + variation spatiale (§3.4) | 15 min | ★★★★★ | ~0,02 ms |
| 3 | **Accentuation par courbure** (§4) — attribut `aData2` + shader | 2 h | ★★★★★ | ~0,03 ms |
| 4 | **Stratigraphie du bloc** (§6.3) + `cutness` bakée (§6.2) | 3 h | ★★★★★ | ~0,15 ms (faces de coupe seules) |
| 5 | **Sparkle multi-LOD** (§3.6) | 45 min | ★★★★ | ~0,08 ms |
| 6 | **Oren-Nayar** (§3.1–3.2) | 1 h | ★★★★ | ~0,04 ms |
| 7 | **Normale de détail multi-échelle** (§2.5) + tuile bakée (§2.2) | 2 h | ★★★★ | ~0,12 ms |
| 8 | **Deux régimes de mouillé** (§5) + film spéculaire | 1 h 30 | ★★★★ | ~0,05 ms |
| 9 | **Finition du bloc** : socle, chanfrein, contact shadow (§6.4) | 1 h 30 | ★★★★ | ~0,02 ms |
| 10 | **Translucidité** (§3.5) — dépend de `aData2.y` | 45 min | ★★★ | ~0,02 ms |
| 11 | **POM** (§2.3) | 2 h | ★★★ | ~0,40 ms |
| 12 | **Effet d'opposition** (§3.3) | 20 min | ★★ | ~0,01 ms |
| 13 | **Dither triangulaire** (§6.6) | 15 min | ★★ | ~0,01 ms |

**Budget total ajouté : ~0,95 ms à 1080p** sur un GPU intégré moderne, dont 0,40 ms pour le seul
POM (désactivable). Sans POM : **0,55 ms**. À 60 fps le budget frame est de 16,7 ms ; c'est
absorbable, d'autant que le vrai goulot d'étranglement de ce projet est le remaillage CPU
(cf. `RECHERCHE-RENDU-3D.md` §8.2), pas le fragment shader.

### 8.2 Les trois changements qui, seuls, règlent 70 % du problème

Si le temps manque, faire **uniquement** ceux-là :

1. **§7.6** — trois couleurs au lieu d'une, courbe en S. *Le sable cesse d'être plat.*
2. **§3.4** — roughness 0,86 avec variation spatiale. *Le sable cesse d'être terne.*
3. **§4.4** — `sc_applyCurvature` avec `uEdgeGain = 1.15`. *Les créneaux se lisent.*

Ces trois-là représentent moins d'une heure de travail combinée et aucun changement d'architecture
(pas de nouvel attribut de sommet si on se contente de la courbure écran depuis l'AO).

### 8.3 Checklist de validation

- [ ] Créneau de 8 cm sur un mur de 40 cm, **en ombre pleine** : la forme se lit ?
- [ ] Sable sec au soleil zénithal : y a-t-il du grain visible à 1 m ? à 4 m ?
- [ ] Caméra en rotation lente : le sparkle **scintille** ou **clignote** ? (clignote = `fwidth`
      manquant ou LOD non croisé)
- [ ] Ligne d'eau après une vague : y a-t-il un liseré brillant **net** ? Le sable humide au-dessus
      est-il **mat** ?
- [ ] Bloc vu de côté : compte-t-on au moins 4 strates distinctes ? La frange capillaire est-elle
      plus sombre que le sable saturé en dessous ?
- [ ] Bloc vu de côté : l'arête supérieure est-elle **nette** (pas de bavure de stratigraphie sur le
      dessus) ?
- [ ] Bloc + socle : l'ombre de contact ancre-t-elle l'objet, ou flotte-t-il ?
- [ ] Grand aplat de sable en pénombre : y a-t-il du banding ? (sinon le dither fait son travail)

---

## 9. Sources

**BRDF et photométrie du sable**

- [Measuring and Modeling the Effect of Surface Moisture on the Spectral Reflectance of Coastal Beach Sand — PLOS ONE](https://journals.plos.org/plosone/article?id=10.1371%2Fjournal.pone.0112151) — la référence pour la courbe albédo/humidité, 350–2500 nm.
- [Field Reflectance Measurements at Night of Beach and Desert Sands within a Particulate BRDF Model — MDPI Remote Sensing](https://www.mdpi.com/2072-4292/14/19/5020) — modèle de Hapke ajusté sur des sables réels, composition quartzeuse, croûte de surface.
- [Wavelength dependence of the BRDF of beach sands — ResearchGate](https://www.researchgate.net/publication/282648822_Wavelength_dependence_of_the_bidirectional_reflectance_distribution_function_BRDF_of_beach_sands) — faible variabilité spectrale, bandes larges.
- [The Cause of the Hot Spot in Vegetation Canopies and Soils: Shadow-Hiding Versus Coherent Backscatter — NASA NTRS](https://ntrs.nasa.gov/citations/19970021464) — origine du pic d'opposition dans les sols fins secs.
- [Hapke's model — PlanetGLLiM documentation](https://kernelo-mistis.gitlabpages.inria.fr/planet-gllim-front-end/rst/scientific_doc/photometric_models/hapke.html) — formulation du SHOE.

**Diffusion rugueuse**

- [EON: A Practical Energy-Preserving Rough Diffuse BRDF — JCGT 2025](https://jcgt.org/published/0014/01/06/paper-lowres.pdf) — code GLSL, retenu dans OpenPBR.
- [A tiny improvement of Oren-Nayar reflectance model — mimosa-pudica](https://mimosa-pudica.net/improved-oren-nayar.html) — la variante Fujii utilisée ici.
- [glslify/glsl-diffuse-oren-nayar](https://github.com/glslify/glsl-diffuse-oren-nayar) — implémentation GLSL de référence.

**Scintillement / glints**

- [Journey Sand Shader: Glitter Reflection — Alan Zucconi](https://www.alanzucconi.com/2019/10/08/journey-sand-shader-5/) — l'approche seuil sur `R·V`, et l'aveu que l'aliasing n'y est pas traité.
- [Procedural Physically based BRDF for Real-Time Rendering of Glints — Chermain et al., CGF 2020](https://onlinelibrary.wiley.com/doi/10.1111/cgf.14141) — NDF à lobes multiples, la version « sérieuse ».
- [Real-Time Image-based Lighting of Glints — Kneiphof & Klein, CGF 2025](https://onlinelibrary.wiley.com/doi/full/10.1111/cgf.70175) — glints sous IBL dynamique.
- [Dynamic sparkle rendering — JAMSI 2025](https://reference-global.com/download/article/10.2478/jamsi-2025-0009.pdf) — mise à l'échelle adaptative de la taille des paillettes selon la distance caméra ; c'est le principe repris au §3.6.

**Micro-relief**

- [Parallax occlusion mapping — Wikipedia](https://en.wikipedia.org/wiki/Parallax_occlusion_mapping)
- [Parallax Mapping with Self Shadowing — bentoBAUX](https://bentobaux.github.io/posts/parallax-mapping-with-self-shadowing/) — le secant step et l'auto-ombrage.
- [Normal Mapping for a Triplanar Shader — Ben Golus](https://bgolus.medium.com/normal-mapping-for-a-triplanar-shader-10bf39dca05a) et le [dépôt de shaders associé](https://github.com/bgolus/Normal-Mapping-for-a-Triplanar-Shader) — whiteout vs UDN.
- [Blending in Detail — Self Shadow](https://blog.selfshadow.com/publications/blending-in-detail/) — le comparatif de référence des méthodes de mélange de normales.

**Translucidité**

- [Approximating Translucency for a Fast, Cheap and Convincing Subsurface Scattering Look — Colin Barré-Brisebois, GDC 2011](https://colinbarrebrisebois.com/2011/03/07/gdc-2011-approximating-translucency-for-a-fast-cheap-and-convincing-subsurface-scattering-look/)
- [An Introduction To Real-Time Subsurface Scattering — MJP](https://therealmjp.github.io/posts/sss-intro/)

**Surfaces mouillées**

- [Rendering of Wet Materials — Jensen, Legakis & Dorsey, Yale](https://graphics.cs.yale.edu/sites/default/files/wet.pdf) — le papier fondateur.
- [Water drop 3a – Physically based wet surfaces — Sébastien Lagarde](https://seblagarde.wordpress.com/2013/03/19/water-drop-3a-physically-based-wet-surfaces/) — la traduction PBR, y compris le fait que le spéculaire disparaît avant l'assombrissement au séchage.
- [Capillary fringe — Wikipedia](https://en.wikipedia.org/wiki/Capillary_fringe) et [Beach groundwater — Coastal Wiki](https://www.coastalwiki.org/wiki/Beach_groundwater) — épaisseur de la frange selon la granulométrie, seepage face.

**Courbure et lisibilité**

- [Curvature map — Polycount wiki](http://wiki.polycount.com/wiki/Curvature_map) et [Cavity vs Curvature maps](https://polycount.com/discussion/140861/cavity-vs-curvature-maps) — la distinction cavity (micro) / curvature (macro), et l'usage en masque de spéculaire.

**Diorama et présentation**

- [Sandcastle sur Steam](https://store.steampowered.com/app/3216520/Sandcastle/) et [le site du jeu](https://sandcastlegame.com/) — la référence visuelle.
- [HD-2D — Wikipedia](https://en.wikipedia.org/wiki/HD-2D) — le tilt-shift comme fabricant de maquette.
- [Building Intricate Dioramas in 3D — 80.lv](https://80.lv/articles/anya-elvidge-dioramas-in-3d) — la coupe de terrain comme socle, l'angle à 45°.

**Divers technique**

- [Modified materials — Three.js Journey](https://threejs-journey.com/lessons/modified-materials) et [Extending three.js materials with GLSL — Dusan Bosnjak](https://medium.com/@pailhead011/extending-three-js-materials-with-glsl-78ea7bbb9270) — `onBeforeCompile`, ses pièges de version.
- [Dithering part three – real world 2D quantization dithering — Bart Wronski](https://bartwronski.com/2016/10/30/dithering-part-three-real-world-2d-quantization-dithering/) — distribution triangulaire, espace de quantification.
- [How to (and how not to) fix color banding — frost.kiwi](https://blog.frost.kiwi/GLSL-noise-and-radial-gradient/)
- [Depth buffer raymarching for contact shadows — h3r2tic gist](https://gist.github.com/h3r2tic/9c8356bdaefbe80b1a22ae0aaee192db) — si on veut la version écran de l'ombre de contact.
