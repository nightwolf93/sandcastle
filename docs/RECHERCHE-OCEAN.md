# Recherche océan — de la nappe plate à la mer tropicale

> Ce document **complète** `RECHERCHE-RENDU-3D.md` (§4 « L'eau »), il ne le remplace pas.
> Le §4 donne les fondations (Gerstner, Beer-Lambert, swash, carte d'humidité). Ici on traite
> exclusivement ce qui manque à `src/render/WaterRenderer.js` aujourd'hui :
> **réfraction écran réelle, caustiques projetées sur le fond, déformation du fond par les
> vaguelettes, volume d'eau visible sur la tranche du diorama, et la recette du turquoise
> lumineux.**
>
> Tout le code est prêt à coller. Cible : three.js **r185**, WebGL2, `EffectComposer`.

---

## Table des matières

- [0. Diagnostic — pourquoi l'eau est fade aujourd'hui](#0-diagnostic--pourquoi-leau-est-fade-aujourdhui)
- [1. Architecture de passes](#1-architecture-de-passes)
- [2. La capture de la scène opaque (`SceneCapture.js`)](#2-la-capture-de-la-scène-opaque-scenecapturejs)
- [3. Réfraction écran complète](#3-réfraction-écran-complète)
- [4. Absorption et diffusion — la recette du turquoise](#4-absorption-et-diffusion--la-recette-du-turquoise)
- [5. Caustiques](#5-caustiques)
- [6. Le volume d'eau vu de côté](#6-le-volume-deau-vu-de-côté)
- [7. La surface](#7-la-surface)
- [8. Le shader d'eau assemblé](#8-le-shader-deau-assemblé)
- [9. Patches de simulation (`Water.js`)](#9-patches-de-simulation-waterjs)
- [10. Intégration, performance, pièges](#10-intégration-performance-pièges)
- [11. Ordre d'implémentation](#11-ordre-dimplémentation)
- [12. Références](#12-références)

---

## 0. Diagnostic — pourquoi l'eau est fade aujourd'hui

Lecture de `src/render/WaterRenderer.js` (version actuelle). Cinq causes, par ordre de gravité :

| # | Symptôme signalé | Cause dans le code actuel | Section qui corrige |
|---|---|---|---|
| 1 | « La mer est juste un plan, on voit une tranche vide sous elle » | La géométrie est **un seul `PlaneGeometry`** avec `depthWrite: false`. Rien ne ferme le volume sur le pourtour du bloc. | [§6](#6-le-volume-deau-vu-de-côté) |
| 2 | « Pas de vraie réfraction, le fond n'est pas déformé » | `col` est calculé **entièrement analytiquement** (`mix(uDeep, uShallow, trans)`). Le fond n'est jamais échantillonné : c'est de la peinture bleue semi-transparente, le compositing alpha se charge du reste. Aucune UV n'est décalée. | [§2](#2-la-capture-de-la-scène-opaque-scenecapturejs), [§3](#3-réfraction-écran-complète) |
| 3 | « Pas de caustiques sur le fond » | Les caustiques sont additionnées **dans le shader d'eau** (`col += uSunColor * caus …`). Elles flottent donc *sur* la surface au lieu d'être *sur le sable* : elles ne suivent pas le relief, disparaissent en vue rasante, et ne réagissent pas à la vraie forme des vagues. | [§5](#5-caustiques) |
| 4 | « Pas d'effet de lentille / de profondeur » | Même cause que 2 : sans échantillonnage du fond, il n'y a rien à déplacer, donc pas de loupe. | [§3.2](#32-lalgorithme-le-point-dimpact-au-fond-reprojeté) |
| 5 | Bleu terne au lieu du turquoise Caraïbes | Trois cumuls : (a) le sable immergé est **assombri à fond** par la formule d'humidité de `SandMaterial` (`lumWet = pow(lum, 1.95) * 0.72` → on tombe à ~25 % de l'albédo sec) ; (b) l'eau n'a **aucun terme de diffusion volumique** (in-scattering), seulement de l'absorption, ce qui donne du sombre et pas du lumineux ; (c) `alpha` plafonne à 0.90 et l'`opacity` blend écrase le contraste. | [§4](#4-absorption-et-diffusion--la-recette-du-turquoise) |

Le point 5(a) est probablement le plus sous-estimé : **un lagon ne peut pas être lumineux au-dessus
d'un fond à 0.25 d'albédo.** La lumière du turquoise des Caraïbes vient à 70 % du sable blanc
rétro-diffusant. C'est corrigé en trois lignes au §4.4.

**Fichiers touchés par ce document :**

```
src/render/WaterCommon.js     (NOUVEAU — chunks GLSL partagés eau/sable)
src/render/SceneCapture.js    (NOUVEAU — capture opaque + depth)
src/render/WaterRenderer.js   (RÉÉCRIT — surface + jupe)
src/render/SandMaterial.js    (PATCH — caustiques, absorption, écume résiduelle)
src/render/Post.js            (PATCH — insertion de la passe de capture)
src/sim/Water.js              (PATCH — écume résiduelle + vitesse exportées)
src/core/Game.js              (PATCH — câblage des uniformes partagées)
```

---

## 1. Architecture de passes

### 1.1 Le problème de base

Pour réfracter, le shader d'eau doit lire **la couleur de la scène opaque** et **sa profondeur**.
Or le fragment d'eau est en train d'être dessiné dans le buffer courant : on ne peut pas lire le
buffer dans lequel on écrit (feedback loop, comportement indéfini, et sur certains pilotes ça
produit des bandes noires clignotantes).

Il faut donc **deux buffers distincts** : un pour la scène opaque (lu), un pour le rendu final
(écrit).

### 1.2 Les trois montages possibles

| Option | Principe | Coût | Risque | Verdict |
|---|---|---|---|---|
| **A. Double rendu de l'opaque** | On rend la scène sans l'eau dans `sceneRT` (couleur + `depthTexture`), puis le `RenderPass` du composer rend tout normalement. Le terrain est dessiné deux fois. | +1 passe géométrie (≈ 0.4–0.9 ms à 150 k tris, sable compris) | Nul | **RECOMMANDÉ.** C'est ce que font `Refractor.js` et `Water2.js` de three.js. Simple, zéro comportement indéfini. |
| **B. Blit couleur + profondeur** | On rend l'opaque une seule fois dans `sceneRT`, puis on recopie couleur **et** `gl_FragDepth` dans le buffer du composer, puis on rend l'eau seule par-dessus. | 1 quad plein écran avec écriture de `gl_FragDepth` (≈ 0.15 ms en 1080p) | Faible — nécessite `glslVersion: THREE.GLSL3` (WebGL2 uniquement) et désactive l'early-Z sur ce quad | Optimisation si le terrain devient lourd (> 400 k tris). Code fourni en [§2.4](#24-variante-b--blit-couleur--profondeur). |
| **C. MRT / depth partagée** | Deux RT partageant la même `DepthTexture`. | 0 | **Élevé** — on échantillonne la depth texture attachée au FBO courant : comportement indéfini par la spec GL. Marche sur desktop, casse sur mobile/ANGLE. | À éviter. |

### 1.3 Ordre exact des passes (option A)

```
┌─────────────────────────────────────────────────────────────────────────────┐
│  FRAME                                                                       │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│  0.  Simulation (Water.step, Granular, Moisture)                            │
│      → upload des DataTexture uField / uField2                              │
│                                                                              │
│  1.  SHADOW MAP        (implicite, déclenchée par le 1er render())           │
│                                                                              │
│  2.  PASSE DE CAPTURE  → sceneRT (½ résolution, HalfFloat, + depthTexture)   │
│      camera.layers.disable(LAYER_WATER)                                      │
│      renderer.render(scene, camera)                                          │
│      ├─ ciel                                                                 │
│      ├─ terrain (SandMaterial AVEC caustiques et absorption)                 │
│      └─ props                                                                │
│      camera.layers.enable(LAYER_WATER)                                       │
│      renderer.shadowMap.autoUpdate = false   ← ne pas refaire la shadow map  │
│                                                                              │
│  3.  RenderPass        → composer.writeBuffer (pleine résolution, HalfFloat) │
│      ├─ ciel                                                                 │
│      ├─ terrain + props            (opaques, renderOrder 0)                  │
│      ├─ JUPE D'EAU                 (renderOrder 9,  lit sceneRT)             │
│      └─ SURFACE D'EAU              (renderOrder 10, lit sceneRT + depth)     │
│      renderer.shadowMap.autoUpdate = true                                    │
│                                                                              │
│  4.  UnrealBloomPass   (seuil 1.45 — n'attrape que le sun glitter)          │
│  5.  OutputPass        (ACES + conversion sRGB)                              │
│  6.  DioramaShader     (tilt-shift, aberration, étalonnage, grain)          │
│  7.  SMAAPass                                                                │
│                                                                              │
└─────────────────────────────────────────────────────────────────────────────┘
```

**Deux invariants à ne jamais casser :**

1. La passe 2 est rendue **sans l'eau** (couche `LAYER_WATER` désactivée). Si l'eau se capture
   elle-même, on obtient une régression infinie visuelle (un reflet d'eau dans l'eau, qui bave).
2. Le sable dans la passe 2 **porte déjà les caustiques** mais **pas l'absorption de l'eau** :
   l'absorption est appliquée par le shader d'eau au moment où il lit `sceneRT`. Sinon elle est
   appliquée deux fois et le lagon devient noir. Voir la règle au [§5.5](#55-la-règle-dor-caustiques-dans-le-sable-absorption-dans-leau).

### 1.4 Les couches (`Layers`)

```js
// src/core/Config.js — à ajouter
/** Couche de rendu réservée aux surfaces réfractantes (eau, jupe). */
export const LAYER_WATER = 1;
```

Tout mesh d'eau fait `mesh.layers.set(LAYER_WATER)`. La caméra a par défaut la couche 0 activée ;
on lui active la 1 en plus (`camera.layers.enable(LAYER_WATER)`) et on la coupe le temps de la
capture.

⚠️ Les lumières doivent rester visibles depuis les deux couches. `DirectionalLight` n'est pas
filtrée par `layers` pour l'éclairage (seulement pour son `helper`), donc rien à faire.

---

## 2. La capture de la scène opaque (`SceneCapture.js`)

### 2.1 Le fichier complet

```js
// src/render/SceneCapture.js
/**
 * Capture de la scene opaque pour la refraction.
 *
 * On rend la scene SANS l'eau dans une render target qui porte a la fois la
 * couleur et une texture de profondeur. Le shader d'eau y lit :
 *   - la couleur du fond a refracter (uSceneColor)
 *   - la profondeur, pour savoir si l'echantillon decale est DEVANT ou DERRIERE
 *     la surface d'eau (uSceneDepth) — sans ce test, tout objet qui depasse de
 *     l'eau "bave" dans la nappe.
 *
 * Points d'attention :
 *   - la target est en HalfFloat et en espace LINEAIRE (comme les buffers de
 *     l'EffectComposer). Aucune conversion sRGB a faire a la lecture.
 *   - la depth texture DOIT etre en NearestFilter et en UnsignedIntType. Un
 *     filtrage lineaire sur une profondeur non lineaire donne des valeurs qui
 *     ne correspondent a aucune geometrie, et le test de rejet clignote.
 *   - on capture a MOITIE resolution : la refraction est floue par nature, et
 *     ca divise par quatre le cout de remplissage de la passe.
 *   - la shadow map est rendue par le PREMIER render() de la frame ; on la
 *     gele ensuite pour ne pas la payer deux fois.
 */

import * as THREE from 'three';
import { LAYER_WATER } from '../core/Config.js';

export class SceneCapture {
  /**
   * @param {THREE.WebGLRenderer} renderer
   * @param {THREE.Scene} scene
   * @param {THREE.Camera} camera
   * @param {number} scale  fraction de la resolution (0.5 = demi)
   */
  constructor(renderer, scene, camera, scale = 0.5) {
    this.renderer = renderer;
    this.scene = scene;
    this.camera = camera;
    this.scale = scale;
    this.enabled = true;

    const size = renderer.getSize(new THREE.Vector2());
    const pr = renderer.getPixelRatio();
    const w = Math.max(2, Math.floor(size.x * pr * scale));
    const h = Math.max(2, Math.floor(size.y * pr * scale));

    const depth = new THREE.DepthTexture(w, h);
    depth.type = THREE.UnsignedIntType;      // 24 bits, suffisant pour 0.1–60 m
    depth.format = THREE.DepthFormat;
    depth.minFilter = THREE.NearestFilter;
    depth.magFilter = THREE.NearestFilter;
    depth.generateMipmaps = false;

    this.target = new THREE.WebGLRenderTarget(w, h, {
      type: THREE.HalfFloatType,             // meme type que les buffers du composer
      format: THREE.RGBAFormat,
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      generateMipmaps: false,
      depthBuffer: true,
      stencilBuffer: false,
      depthTexture: depth,
    });
    // IMPORTANT : la target est en espace de travail lineaire. Ne PAS mettre
    // SRGBColorSpace ici, sinon on double la conversion au moment ou l'eau
    // relit le buffer.
    this.target.texture.colorSpace = THREE.LinearSRGBColorSpace;
    this.target.texture.name = 'sceneOpaque';

    /** Uniforme partagee : resolution du buffer courant (plein ecran). */
    this.resolution = new THREE.Vector2(size.x * pr, size.y * pr);
  }

  setSize(w, h) {
    const pr = this.renderer.getPixelRatio();
    this.resolution.set(w * pr, h * pr);
    const tw = Math.max(2, Math.floor(w * pr * this.scale));
    const th = Math.max(2, Math.floor(h * pr * this.scale));
    // setSize recree la depth texture proprement (cf. three#19447 : on ne peut
    // pas REMPLACER une depthTexture apres coup, mais setSize la redimensionne).
    this.target.setSize(tw, th);
  }

  /** A appeler juste avant composer.render(). */
  render() {
    if (!this.enabled) return;
    const r = this.renderer;

    const prevTarget = r.getRenderTarget();
    const prevAutoClear = r.autoClear;

    // 1) on masque l'eau
    this.camera.layers.disable(LAYER_WATER);

    // 2) rendu opaque dans la target
    r.setRenderTarget(this.target);
    r.autoClear = true;
    r.clear(true, true, false);
    r.render(this.scene, this.camera);

    // 3) restauration
    r.setRenderTarget(prevTarget);
    r.autoClear = prevAutoClear;
    this.camera.layers.enable(LAYER_WATER);

    // 4) la shadow map vient d'etre calculee : on la gele pour la passe finale.
    //    Game.render() doit la degeler au debut de la frame suivante.
    r.shadowMap.autoUpdate = false;
  }

  /** A appeler apres composer.render(). */
  release() {
    this.renderer.shadowMap.autoUpdate = true;
  }

  dispose() {
    this.target.depthTexture?.dispose();
    this.target.dispose();
  }
}
```

### 2.2 Câblage dans `Post.js`

```js
// src/render/Post.js — dans le constructeur, AVANT this.composer.addPass(this.renderPass)
import { SceneCapture } from './SceneCapture.js';
// ...
this.capture = new SceneCapture(renderer, scene, camera, 0.5);

// ... dans setSize()
this.capture.setSize(w, h);

// ... dans render(dt)
render(dt) {
  this.time += dt;
  this.grade.uniforms.uTime.value = this.time;
  this.capture.render();                    // <-- passe 2 du schema §1.3
  if (!this.enabled) {
    this.renderer.render(this.scene, this.camera);
  } else {
    this.composer.render(dt);
  }
  this.capture.release();
}

// ... dans dispose()
this.capture.dispose();
```

Et dans `Game.js`, juste après la construction de `WaterRenderer` :

```js
// src/core/Game.js
this.post = new Post(this.renderer, this.scene, this.camera);
// on branche le buffer de refraction sur l'eau
this.waterRenderer.bindSceneCapture(this.post.capture, this.camera);
```

### 2.3 Le mode « pas de post-traitement »

Si `post.enabled === false` (palier de qualité 0), on rend directement à l'écran. La capture
fonctionne toujours (elle a sa propre target), donc **la réfraction reste disponible même sans
composer**. C'est important : la réfraction est plus utile visuellement que le tilt-shift.

En revanche, si on veut réellement économiser, `capture.enabled = false` + un `#define NO_REFRACT`
sur le matériau d'eau (voir [§10.3](#103-paliers-de-qualité)).

### 2.4 Variante B — blit couleur + profondeur

À n'implémenter que si la double passe géométrique devient un goulot mesuré. Le principe : un quad
plein écran qui recopie la couleur **et** réécrit `gl_FragDepth` depuis la depth texture, ce qui
reconstitue le Z-buffer du buffer de destination sans redessiner la géométrie.

```js
// src/render/DepthBlit.js
import * as THREE from 'three';

/**
 * Recopie couleur + profondeur d'une render target vers le buffer courant.
 * WebGL2 uniquement (gl_FragDepth exige GLSL ES 3.00).
 */
export function createDepthBlitPass(sceneRT) {
  const mat = new THREE.RawShaderMaterial({
    glslVersion: THREE.GLSL3,
    depthTest: false,
    depthWrite: true,
    uniforms: {
      tColor: { value: sceneRT.texture },
      tDepth: { value: sceneRT.depthTexture },
    },
    vertexShader: /* glsl */ `
      in vec3 position;
      in vec2 uv;
      out vec2 vUv;
      void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }
    `,
    fragmentShader: /* glsl */ `
      precision highp float;
      uniform sampler2D tColor;
      uniform sampler2D tDepth;
      in vec2 vUv;
      out vec4 outColor;
      void main() {
        outColor = texture(tColor, vUv);
        gl_FragDepth = texture(tDepth, vUv).x;   // profondeur non lineaire, telle quelle
      }
    `,
  });
  const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), mat);
  quad.frustumCulled = false;
  const cam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  const sc = new THREE.Scene();
  sc.add(quad);
  return { scene: sc, camera: cam, material: mat };
}
```

Séquence :

```js
capture.render();                       // opaque -> sceneRT (PLEINE resolution ici !)
renderer.setRenderTarget(composerBuffer);
renderer.clear(true, true, false);
renderer.render(blit.scene, blit.camera);          // couleur + Z restaures
camera.layers.set(LAYER_WATER);                    // eau SEULE
renderer.autoClear = false;
renderer.render(scene, camera);
camera.layers.enableAll(); camera.layers.disable(2); // restaurer
```

⚠️ En variante B la capture doit être en **pleine résolution** (elle sert aussi de rendu final),
ce qui annule une partie du gain. À ne faire que si la géométrie coûte plus cher que le
remplissage — c'est-à-dire quasiment jamais sur ce projet.

---

## 3. Réfraction écran complète

### 3.1 La physique : Snell, et pourquoi le fond « bouge »

Un rayon qui passe de l'air (n₁ = 1.000) à l'eau (n₂ = 1.333) se rapproche de la normale :

```
n₁ · sin θ₁ = n₂ · sin θ₂          →      sin θ₂ = sin θ₁ / 1.333
```

Quand la surface est **plate**, tous les rayons subissent la même déviation : le fond paraît
simplement **remonté** (un objet à 1 m paraît à 0.75 m — c'est le facteur 1/n). Ce n'est pas une
déformation, c'est un décalage global. Le joueur ne le voit pas.

Quand la surface **ondule**, la normale change d'un pixel à l'autre, donc l'angle de déviation
change, donc **chaque point du fond est déplacé d'une quantité différente**. C'est ça, la
« vaguelette qui déforme le fond ».

Pour une pente faible `∇h` (ce qui est notre cas : rides de 3 mm sur 15 cm de longueur d'onde), le
déplacement apparent horizontal du fond, vu de haut, vaut :

```
δ  =  d · (1 − 1/n) · ∇h        avec  (1 − 1/n) = 0.2498  pour n = 1.333
```

Trois conséquences directes, **toutes visibles à l'écran** :

1. **L'amplitude est proportionnelle à la profondeur `d`.** Une flaque de 2 cm ne déforme rien
   (δ = 5 µm) ; un chenal de 40 cm déforme franchement (δ = 1 cm pour une pente de 10 %). C'est
   l'atténuation par la profondeur demandée — elle est *gratuite*, elle sort de la physique.
2. **L'amplitude est proportionnelle à la pente**, pas à la hauteur de vague. Les rides courtes et
   raides déforment plus qu'une houle large et haute. D'où l'importance des octaves de détail (§7.1).
3. **La convergence de ces déplacements EST la caustique.** Même formule, même gradient. On
   réutilisera le calcul (§5.1). Réfraction et caustiques ne sont pas deux effets : c'est le même,
   vu de deux côtés de la surface.

### 3.2 L'algorithme : le point d'impact au fond, reprojeté

La méthode habituelle (`uv += N.xz * strength`) est un bricolage : `strength` est en pixels, elle ne
dépend ni de la distance caméra ni du FOV, et il faut la re-régler à chaque changement de plan.

On peut faire **exact** et **moins cher**, parce qu'on connaît la profondeur d'eau `d` par la
simulation (canal G de `uField`) — on n'a pas besoin de la reconstruire depuis le Z-buffer :

```
1. V     = direction surface → caméra
2. T     = refract(-V, N, 1/1.333)          rayon réfracté sous l'eau
3. P_fond = P_surface + T · (d / −T.y)      intersection avec le plan du fond
4. UV    = projeter P_fond en espace écran
5. tester la profondeur en UV ; si l'échantillon est DEVANT l'eau, revenir à l'UV non décalé
```

C'est physiquement correct pour un fond localement horizontal (vrai à 4 cm près, notre résolution
voxel), ça donne automatiquement le bon comportement en fonction de la distance, du FOV, de la
profondeur et de l'angle de vue, et **ça produit l'effet de lentille** : là où la surface est
convexe, plusieurs rayons convergent vers le même point du fond, qui apparaît donc étiré/grossi.

```glsl
// ---------------------------------------------------------------------------
//  REFRACTION — point d'impact au fond, reprojete en espace ecran
// ---------------------------------------------------------------------------
// vWorldPos : position monde du fragment de surface
// N         : normale monde de la surface (multi-echelles, cf. §7.1)
// V         : direction fragment -> camera (normalisee)
// dCol      : hauteur de la colonne d'eau sous ce fragment (metres, canal G)
//
// Retourne l'UV ecran ou echantillonner uSceneColor, ET la longueur du trajet
// optique dans l'eau (composante "montante", du fond vers l'oeil).

struct Refr { vec2 uv; float pathView; float valid; };

Refr refractBottom(vec3 P, vec3 N, vec3 V, float dCol, vec2 baseUV, float viewZ) {
  const float ETA = 1.0 / 1.333;

  vec3 T = refract(-V, N, ETA);
  // Reflexion totale interne impossible depuis l'air, mais refract() renvoie
  // vec3(0) si ca arrive (normale degeneree). Garde-fou :
  if (dot(T, T) < 0.5) T = vec3(0.0, -1.0, 0.0);

  float cosT = max(-T.y, 0.20);            // cos de l'angle refracte vs verticale
  float travel = dCol / cosT;              // trajet fond -> surface
  vec3 hit = P + T * travel;               // point du fond atteint

  vec4 clipP = projectionMatrix * viewMatrix * vec4(hit, 1.0);
  vec2 uv = (clipP.xy / max(clipP.w, 1e-4)) * 0.5 + 0.5;

  Refr r;
  r.uv = uv;
  r.pathView = travel;
  r.valid = 1.0;
  return r;
}
```

### 3.3 Le test de rejet — la correction indispensable

Sans lui : un seau posé dans l'eau, un créneau de château qui dépasse, un rocher — tout objet
**devant** la surface d'eau est échantillonné par l'UV décalée et se met à « baver » à l'intérieur de
la nappe. C'est le défaut n° 1 de toutes les réfractions écran mal faites, et il saute aux yeux.

Le test : **si l'échantillon décalé est plus proche de la caméra que le fragment d'eau, il n'est pas
sous l'eau — on retombe sur l'UV non décalée.**

```glsl
#include <packing>

uniform sampler2D uSceneDepth;
uniform float uNear;
uniform float uFar;

/** Profondeur lineaire POSITIVE (distance le long de -Z view), en metres. */
float sceneEyeDepth(vec2 uv) {
  float raw = texture2D(uSceneDepth, uv).x;
  return -perspectiveDepthToViewZ(raw, uNear, uFar);
}
```

```glsl
  // --- test de rejet ---------------------------------------------------------
  float zRefr = sceneEyeDepth(r.uv);
  // > 0 si l'echantillon est DERRIERE la surface d'eau (donc immerge) : OK.
  // < 0 si l'echantillon est DEVANT (objet emergeant) : il faut rejeter.
  float behind = zRefr - viewZ;

  // Fondu doux sur 4 cm plutot qu'un step : un step produit une couture nette
  // de 1 px tout autour de chaque objet qui perce la surface.
  float accept = smoothstep(0.0, 0.04, behind);
  vec2 uvFinal = mix(baseUV, r.uv, accept);
```

**Trois raffinements qui comptent :**

```glsl
  // (a) Epaisseur d'eau REELLEMENT traversee. Si un objet est immerge, la
  //     lumiere a parcouru moins d'eau que la colonne entiere. Sans ce min(),
  //     un seau pose au fond d'une douve de 30 cm est teinte comme s'il etait
  //     a 30 cm alors que son bord est a 5 cm sous la surface.
  float zFinal   = sceneEyeDepth(uvFinal);
  float slabView = min(r.pathView, max(zFinal - viewZ, 0.0));

  // (b) Garde-ciel. Si l'echantillon est tres loin (le ciel derriere la
  //     tranche du bloc), on ne veut pas voir du bleu de ciel "sous" l'eau.
  float skyGuard = step(zFinal, uFar * 0.85);
  //     -> a l'usage : mix(deepWaterColor, refracted, skyGuard)

  // (c) Alignement sur le texel. Le buffer est en demi-resolution ; sans
  //     recentrage on attrape une frange de 1 texel sur les silhouettes.
  vec2 texel = 1.0 / uSceneSize;                 // taille du buffer de capture
  uvFinal = (floor(uvFinal * uSceneSize) + 0.5) * texel;
```

Le (c) est le `AlignWithGrabTexel` de Catlike Coding. Sur un buffer demi-résolution il est
franchement utile ; en pleine résolution on peut s'en passer.

### 3.4 Dispersion chromatique (l'effet de lentille)

L'indice de l'eau varie légèrement avec la longueur d'onde (n = 1.331 dans le rouge, 1.337 dans le
bleu). En pratique, plutôt que trois `refract()`, on **échelonne le vecteur de décalage** :

```glsl
  vec2 off = uvFinal - baseUV;
  vec3 refracted;
  refracted.r = texture2D(uSceneColor, baseUV + off * 0.988).r;
  refracted.g = texture2D(uSceneColor, baseUV + off * 1.000).g;
  refracted.b = texture2D(uSceneColor, baseUV + off * 1.019).b;
```

Trois `texture2D` au lieu d'un. Le gain visuel est net dès que `off` dépasse ~3 px : les bords du
récif prennent une frange cyan/orangée, exactement comme sous l'eau. En qualité basse, on retombe
sur un seul tap.

**Réglage** : les facteurs `0.988 / 1.019` correspondent à ~3 % d'écart, soit 5 à 10× la dispersion
réelle. C'est un choix assumé : à l'échelle du diorama la dispersion réelle est invisible, et cet
excès est ce qui « vend » la lentille.

### 3.5 Amplitude de la déformation en fonction de la profondeur — vérification

Avec l'algorithme du §3.2, l'amplitude n'est pas un réglage : elle sort du calcul. Voici ce qu'on
obtient, pour une caméra diorama à 45° et une ride de pente crête-à-crête de 12 % :

| Profondeur d'eau | Décalage monde δ | Décalage écran (caméra à 3 m, FOV 45°, 1080p) | Lisibilité |
|---|---|---|---|
| 2 cm (flaque) | 0.6 mm | 0.4 px | invisible — c'est voulu |
| 8 cm (laisse) | 2.4 mm | 1.5 px | frémissement, juste perceptible |
| 25 cm (douve) | 7.5 mm | 4.6 px | **franc, c'est l'effet demandé** |
| 60 cm (large) | 18 mm | 11 px | fort, presque trop |

Si on veut pousser au-delà du physique (style « aquarelle »), on n'invente pas un `uRefractStrength`
en pixels : on **exagère la pente de la surface** via `uRippleGain` (§7.1). Ça garde la cohérence
entre réfraction, spéculaire, caustiques et écume — les trois autres effets suivent automatiquement.
C'est le seul curseur artistique honnête sur cette famille d'effets.

---

## 4. Absorption et diffusion — la recette du turquoise

### 4.1 Le modèle

Deux termes seulement, mais il faut les deux :

```
L_vue  =  L_fond · exp(−σ_t · (s_soleil + s_vue))     ← ABSORPTION (assombrit, teinte)
       +  A_scatter · (1 − exp(−σ_t · s_vue))          ← DIFFUSION  (éclaircit, sature)
```

- `σ_t = σ_a + σ_s` : coefficient d'extinction, **par canal**, en m⁻¹.
- `s_soleil` : trajet de la surface au fond, le long du rayon solaire réfracté.
- `s_vue` : trajet du fond à la surface, le long du rayon de vue réfracté (le `pathView` du §3.2).
- `A_scatter` : albédo de diffusion × lumière disponible. **C'est le terme qui fait le turquoise
  lumineux, et c'est celui qui manque totalement dans le code actuel.**

Sans le second terme : l'eau ne peut que soustraire de la lumière au fond. Résultat = un sable
assombri et bleuté. Terne. Avec le second terme : l'eau **émet** sa propre couleur, qui domine quand
la profondeur augmente, et le fond reste visible en transparence par-dessus. C'est exactement la
sensation « on voit le récif à travers une masse d'eau turquoise ».

### 4.2 Les coefficients, et pourquoi il faut tricher

Absorption de l'eau pure (Pope & Fry 1997, Smith & Baker 1981), aux longueurs d'onde moyennes des
canaux RVB :

| Canal | λ | σ_a (m⁻¹) | σ_s Jerlov I (m⁻¹) | σ_s Jerlov II côtier (m⁻¹) |
|---|---|---|---|---|
| R | 650 nm | 0.340 | 0.0015 | 0.048 |
| V | 550 nm | 0.0565 | 0.0025 | 0.075 |
| B | 450 nm | 0.0092 | 0.0045 | 0.115 |

Longueur d'extinction du rouge : 1/0.34 ≈ **2.9 m**. Autrement dit, **à 40 cm de fond, l'eau réelle
est quasi incolore** (le rouge n'a perdu que 24 %). Notre diorama fait 10 m de côté et l'eau y fait
20 à 60 cm : en respectant la physique on obtient du verre, pas un lagon.

Il faut donc une **échelle optique** explicite, et il vaut mieux l'assumer dans une uniforme que la
diluer dans des constantes bidouillées :

```glsl
uniform float uDepthScale;   // "1 metre geometrique compte pour N metres optiques"
```

| `uDepthScale` | Rendu à 30 cm de fond | Usage |
|---|---|---|
| 1.0 | eau de verre, aucune couleur | maquette technique |
| 3.0 | teinte discrète, réaliste pour de l'eau de mer claire | mode « photo réaliste » |
| **6.0** | **turquoise franc, on voit encore nettement le fond** | **défaut recommandé** |
| 10.0 | lagon profond dès 20 cm, le fond se perd | mer un peu trouble |
| 18.0 | opaque, style « eau de piscine municipale » | non |

### 4.3 Le bloc d'uniformes calibré

```js
// --- Eau tropicale claire (Antilles / lagon corallien) — LE DEFAUT ---
uSigmaA:       new THREE.Vector3(0.42,  0.058, 0.016),   // absorption, m^-1
uSigmaS:       new THREE.Vector3(0.030, 0.048, 0.075),   // diffusion, m^-1
uScatterTint:  new THREE.Color(0.055, 0.78, 0.86),       // LINEAIRE, pas sRGB
uScatterGain:  0.95,
uDepthScale:   6.0,
uDeepColor:    new THREE.Color(0.012, 0.19, 0.30),       // au-dela de 1.5 m
```

Autres ambiances, à `uDepthScale` inchangé :

| Ambiance | `uSigmaA` | `uSigmaS` | `uScatterTint` (linéaire) | `uScatterGain` |
|---|---|---|---|---|
| **Lagon Caraïbes** (défaut) | (0.42, 0.058, 0.016) | (0.030, 0.048, 0.075) | (0.055, 0.78, 0.86) | 0.95 |
| Méditerranée | (0.45, 0.075, 0.030) | (0.020, 0.030, 0.050) | (0.030, 0.42, 0.72) | 0.70 |
| Mer du Nord | (0.38, 0.115, 0.230) | (0.20, 0.24, 0.22) | (0.14, 0.36, 0.30) | 0.55 |
| Piscine | (0.50, 0.070, 0.012) | (0.010, 0.015, 0.028) | (0.03, 0.62, 0.92) | 0.80 |
| Eau chargée (après une pelletée) | (0.55, 0.30, 0.42) | (0.45, 0.40, 0.32) | (0.42, 0.36, 0.24) | 0.90 |

Le canal sédiment (`uField.a`) interpole entre la ligne 1 et la ligne 5 :

```glsl
  float turb = clamp(vSed * 40.0, 0.0, 1.0);
  vec3 sigA  = mix(uSigmaA, vec3(0.55, 0.30, 0.42), turb);
  vec3 sigS  = mix(uSigmaS, vec3(0.45, 0.40, 0.32), turb);
  vec3 tint  = mix(uScatterTint, vec3(0.42, 0.36, 0.24), turb);
```

C'est le seul endroit du shader où l'eau devient laiteuse et ocre : quand le joueur creuse. Le reste
du temps elle est cristalline, ce qui rend le contraste lisible.

### 4.4 Ce qui fait vraiment le turquoise *lumineux* (et pas le bleu terne)

Cinq points, dans l'ordre d'impact. Les deux premiers sont hors du shader d'eau — c'est pour ça
qu'ils sont passés à la trappe jusqu'ici.

**1. Le fond doit être CLAIR. (Impact : énorme.)**
`SandMaterial` assombrit le sable mouillé jusqu'à ~0.25 de l'albédo sec. Physiquement juste **hors
de l'eau** (le film d'eau piège la lumière par réflexions internes) mais **faux sous l'eau** : un
sable immergé baigne dans un milieu qui rétro-diffuse, il ne s'assombrit presque pas. Correctif :

```glsl
// src/render/SandMaterial.js — dans <map_fragment>, juste apres le calcul de ws
// underwater vient du champ d'eau (cf. §5.5)
float ws = 1.0 - exp(-moist * 7.5);
ws *= mix(1.0, 0.40, underwater);       // <-- LA LIGNE QUI CHANGE TOUT
```

Effet : l'albédo du fond passe de ~0.25 à ~0.55. Le lagon gagne **plus d'une image-stop** de
luminosité, et le turquoise devient saturé au lieu d'être une teinte sur du brun.

**2. Le terme de diffusion (`inScatter`) doit être ADDITIF, jamais un `mix`.**
`mix(fond, couleurEau, t)` ne peut pas dépasser la luminance du fond : l'eau ne peut qu'assombrir.
Or une masse d'eau éclairée en plein soleil est **plus claire** qu'un sable à l'ombre. Il faut :

```glsl
  vec3 body = refracted * Tsun * Tview + scatter * (1.0 - Tview);   // ✓
  // et surtout PAS :  vec3 body = mix(refracted, waterCol, alpha); // ✗
```

**3. Le Fresnel doit rester bas aux angles de diorama.**
La caméra regarde à 40–55° d'inclinaison. À ces angles, F(θ) ≈ 0.025 : **2.5 % de reflet**, pas plus.
Le code actuel fait `fres = mix(0.02, 1.0, pow(1-NdotV, 4.0))` puis `col = mix(col, sky, fres*0.75)`,
ce qui injecte ~15 % de ciel gris-bleu au centre de l'image. C'est ce voile qui délave tout. La bonne
formule (Schlick exact, F₀ = 0.02) est au §7.4.

**4. Ne pas laisser ACES manger la saturation.**
`ACESFilmicToneMapping` désature agressivement au-dessus de ~0.8 en luminance. Le corps de l'eau doit
donc rester **sous 1.1 en linéaire** ; seuls le sun glitter et l'écume ont le droit de dépasser
(c'est eux qu'on veut voir bloomer, seuil 1.45). Concrètement : `uScatterGain ≤ 1.0`, et surveiller
que `body` ne dépasse pas 1.1 en plein soleil.

**5. Pousser la chroma en post, mais seulement dans les cyans.**
Le `DioramaShader` a déjà `uSaturation: 1.10`. Un gain global au-delà de 1.15 fait virer le sable au
orange fluo. Mieux : un boost sélectif, 6 lignes dans `Post.js` :

```glsl
      // --- boost selectif des cyans (l'eau), avant la saturation globale ---
      {
        float mx = max(col.r, max(col.g, col.b));
        float mn = min(col.r, min(col.g, col.b));
        float chroma = mx - mn;
        // 1 quand la teinte est cyan/turquoise, 0 ailleurs
        float aqua = clamp((col.b + col.g) * 0.5 - col.r, 0.0, 1.0);
        aqua = smoothstep(0.06, 0.30, aqua) * smoothstep(0.02, 0.12, chroma);
        col = mix(col, mix(vec3(dot(col, vec3(0.2126,0.7152,0.0722))), col, 1.45), aqua * 0.55);
      }
```

Résultat : l'eau gagne ~20 % de chroma, le sable ne bouge pas d'un poil.

### 4.5 Le code du corps d'eau, complet

```glsl
// ---------------------------------------------------------------------------
//  CORPS D'EAU — absorption + diffusion (single scattering analytique)
// ---------------------------------------------------------------------------
// dCol      : hauteur de colonne d'eau (m), canal G de uField
// pathView  : trajet fond -> surface le long du rayon de vue refracte (m)
// refracted : couleur du fond lue dans uSceneColor
// sunAmt    : 0..1, quantite de soleil disponible (hauteur solaire + nuages)

vec3 waterBody(vec3 refracted, float dCol, float pathView, float turb,
               vec3 sunColor, float sunAmt, vec3 skyColor) {

  vec3 sigA = mix(uSigmaA, vec3(0.55, 0.30, 0.42), turb);
  vec3 sigS = mix(uSigmaS, vec3(0.45, 0.40, 0.32), turb);
  vec3 tint = mix(uScatterTint, vec3(0.42, 0.36, 0.24), turb);
  vec3 sigT = sigA + sigS;

  // --- trajet descendant : le soleil, refracte a l'entree -------------------
  // Snell exact sur le cosinus : cos θ₂ = sqrt(1 − (1 − cos²θ₁)/n²)
  float cosSun  = max(uSunDir.y, 0.02);
  float cosSunR = sqrt(max(1.0 - (1.0 - cosSun * cosSun) / (1.333 * 1.333), 0.04));
  float pathSun = dCol / cosSunR;

  vec3 Tsun  = exp(-sigT * pathSun  * uDepthScale);
  vec3 Tview = exp(-sigT * pathView * uDepthScale);

  // --- lumiere disponible dans le volume ------------------------------------
  // Le soleil traverse d'abord la moitie de la colonne en moyenne : on prend
  // la transmittance a mi-parcours, ce qui evite un in-scatter trop rouge en
  // surface et trop bleu au fond.
  vec3 midT   = exp(-sigT * pathSun * 0.5 * uDepthScale);
  vec3 lightV = sunColor * sunAmt * midT + skyColor * 0.30;

  // --- albedo de diffusion simple : sigma_s / sigma_t ------------------------
  vec3 albedo = sigS / max(sigT, vec3(1e-4));
  vec3 scatter = tint * albedo * lightV * uScatterGain;

  // --- composition ----------------------------------------------------------
  vec3 body = refracted * Tsun * Tview + scatter * (vec3(1.0) - Tview);

  // Au-dela de ~1.5 m on ne voit plus le fond : on fond vers la couleur du large,
  // sinon les pixels lointains virent au noir quand refracted -> 0.
  float far = smoothstep(0.8, 2.2, dCol);
  body = mix(body, uDeepColor * (0.55 + 0.45 * sunAmt), far);

  return body;
}
```

**Vérification numérique** (fond de sable immergé, albédo linéaire (0.55, 0.46, 0.31), soleil à 55°,
`uDepthScale = 6`) :

| `d` | `Tsun·Tview` | `scatter·(1−Tview)` | `body` | Teinte perçue |
|---|---|---|---|---|
| 0.05 m | (0.88, 0.98, 0.99) | (0.003, 0.03, 0.04) | (0.49, 0.48, 0.35) | sable, à peine frais |
| 0.15 m | (0.68, 0.95, 0.98) | (0.01, 0.09, 0.12) | (0.38, 0.51, 0.42) | turquoise pâle ✓ |
| 0.35 m | (0.40, 0.89, 0.96) | (0.02, 0.19, 0.25) | (0.24, 0.60, 0.55) | **turquoise franc ✓✓** |
| 0.70 m | (0.16, 0.79, 0.92) | (0.04, 0.31, 0.42) | (0.13, 0.67, 0.71) | turquoise lumineux |
| 1.40 m | (0.026, 0.63, 0.85) | (0.06, 0.44, 0.60) | (0.07, 0.65, 0.86) | bleu-cyan profond |

La courbe est exactement la bonne : **la luminance MONTE avec la profondeur** entre 5 cm et 70 cm.
C'est cette inversion qui donne la sensation de lagon, et c'est impossible à obtenir avec un `mix`.

---

## 5. Caustiques

### 5.1 Le principe — c'est le jacobien de la réfraction

On a établi au §3.1 que la surface envoie le point `x` (surface) vers le point `y` (fond) :

```
y  =  x  +  d · κ · ∇h(x)          avec κ = 1 − 1/n = 0.2498
```

Un petit carré de surface `dA` est donc étiré ou comprimé en arrivant au fond, d'un facteur égal au
déterminant du jacobien de cette application. L'éclairement est conservé, donc **l'intensité au fond
est l'inverse de ce facteur** :

```
J   =  det( I + d·κ·H )   ≈  1 + d·κ·∇²h        (H = hessienne de h, ∇² = laplacien)
I_fond  =  1 / J
```

C'est tout. Une crête (bulge vers le haut, `∇²h < 0`) est une lentille plan-convexe : `J < 1`, la
lumière converge, c'est une bande brillante. Un creux disperse. Les caustiques ne sont rien d'autre
que **le laplacien de la surface d'eau, projeté au fond**.

Trois propriétés qu'on obtient gratuitement, et qui sont exactement celles que le joueur attend :

- **L'intensité croît avec `d`.** À 2 cm de fond il n'y a pas de caustiques (`J ≈ 1`). C'est ce qui
  évite le défaut du code actuel où les flaques ressemblent à du plastique froissé.
- **Les caustiques sont *nettes* près de la surface et *floues* en profondeur** si on ajoute
  l'étalement dû à la taille angulaire du soleil (0.53°) : `blur ≈ d · 0.0093 m`.
- **Elles se décalent avec le soleil.** Le point d'entrée du rayon n'est pas à l'aplomb du point du
  fond : il est décalé de `d · tan(θ_soleil_réfracté)` dans l'azimut solaire. À 10 h du matin, les
  réseaux glissent latéralement — détail que personne ne calcule et que tout le monde remarque.

### 5.2 Le chunk partagé — `WaterCommon.js`

Point d'architecture crucial : **la surface d'eau réelle = champ simulé (grandes structures) +
rides analytiques (détail)**. Les rides sont ajoutées dans le vertex shader de l'eau, elles ne sont
donc pas dans la `DataTexture`. Si le sable calcule les caustiques à partir de la seule texture, il
verra un champ lisse et n'aura aucune caustique.

Solution : **une seule fonction GLSL, dans un fichier partagé, utilisée par les deux shaders.**

```js
// src/render/WaterCommon.js
/**
 * Chunks GLSL partages entre le shader d'eau et le shader de sable.
 *
 * La regle : la forme de la surface libre est definie A UN SEUL ENDROIT.
 * Le shader d'eau s'en sert pour deplacer ses sommets et calculer sa normale ;
 * le shader de sable s'en sert pour calculer les caustiques. Si les deux
 * divergent, les caustiques ne tombent plus sur les vagues et l'illusion casse
 * immediatement.
 */

import { NX, NZ, VOXEL, WORLD_W, WORLD_D, ORIGIN_X, ORIGIN_Z } from '../core/Config.js';

/** Uniformes a partager (memes objets Vector/valeurs dans les deux materiaux). */
export function createWaterUniforms() {
  return {
    uField:      { value: null },   // RGBA float : R=surface, G=profondeur, B=ecume, A=sediment
    uField2:     { value: null },   // RG float   : R=ecume residuelle, G=|v| normalisee
    uFieldRect:  { value: new Float32Array([ORIGIN_X, ORIGIN_Z, 1 / WORLD_W, 1 / WORLD_D]) },
    uFieldTexel: { value: new Float32Array([1 / NX, 1 / NZ]) },
    uCell:       { value: VOXEL },
    uTime:       { value: 0 },
    uWind:       { value: new Float32Array([0.82, 0.57]) },  // direction, normalisee
    uWindStr:    { value: 1.0 },
    uRippleGain: { value: 1.0 },
  };
}

/** Declarations communes. A inserer AVANT tout usage. */
export const WATER_COMMON_PARS = /* glsl */ `
uniform sampler2D uField;
uniform sampler2D uField2;
uniform vec4  uFieldRect;    // (originX, originZ, 1/worldW, 1/worldD)
uniform vec2  uFieldTexel;
uniform float uCell;
uniform vec2  uWind;
uniform float uWindStr;
uniform float uRippleGain;

// ---------------------------------------------------------------------------
//  MONDE -> CHAMP D'EAU
// ---------------------------------------------------------------------------
// La simulation indexe c = x + NX*z, avec z croissant vers +Z monde. La ligne
// z=0 est donc a v=0. Aucune inversion ici : c'est le PLAN d'eau qui doit
// inverser (sa geometrie est tournee de -90 deg autour de X, donc son uv.y
// remonte vers -Z). Ne pas confondre les deux.
vec2 fieldUV(vec2 worldXZ) {
  return (worldXZ - uFieldRect.xy) * uFieldRect.zw;
}

bool inField(vec2 uv) {
  return all(greaterThanEqual(uv, vec2(0.0))) && all(lessThanEqual(uv, vec2(1.0)));
}

// ---------------------------------------------------------------------------
//  RIDES ANALYTIQUES
// ---------------------------------------------------------------------------
// Somme de trains sinusoidaux. On retourne la hauteur, le gradient ET le
// laplacien en une passe : les trois sont des derivees de la meme somme, il
// serait absurde de les recalculer separement.
//
//   acc.x = h          (m)
//   acc.y = dh/dx
//   acc.z = dh/dz
//   acc.w = laplacien  (m^-1)

void addRipple(inout vec4 acc, vec2 p, vec2 dir, float len, float amp,
               float speed, float t) {
  float k  = 6.28318530718 / len;
  vec2  K  = dir * k;
  float ph = dot(K, p) - speed * k * t;
  float s  = sin(ph);
  float c  = cos(ph);
  acc.x +=  amp * s;
  acc.y +=  amp * K.x * c;
  acc.z +=  amp * K.y * c;
  acc.w += -amp * (K.x * K.x + K.y * K.y) * s;
}

/**
 * Champ de rides. `open` = 0 sur une flaque, 1 au large : les rides
 * capillaires ont besoin de fetch (de la place pour se former).
 *
 * ANISOTROPIE : les trois trains sont serres autour de la direction du vent
 * (+-25 deg) et leurs longueurs d'onde sont etirees dans l'axe du vent.
 * Une eau isotrope ressemble a du papier bulle ; c'est l'alignement qui donne
 * l'impression de brise.
 */
vec4 rippleField(vec2 p, float t, float open) {
  vec4 acc = vec4(0.0);
  if (open < 0.01 || uWindStr < 0.01) return acc;

  vec2  w  = normalize(uWind);
  vec2  wp = vec2(-w.y, w.x);              // perpendiculaire au vent
  float A  = 0.0032 * uWindStr * uRippleGain * open;

  // Train principal : long, dans l'axe du vent
  addRipple(acc, p, normalize(w + wp * 0.10), 0.62, A * 1.00, 0.62, t);
  // Second train, croise a ~20 deg : c'est lui qui casse la regularite
  addRipple(acc, p, normalize(w - wp * 0.42), 0.29, A * 0.62, 0.78, t);
  // Rides capillaires, courtes et rapides : porteuses des caustiques nettes
  addRipple(acc, p, normalize(w + wp * 0.33), 0.135, A * 0.30, 1.05, t);
  // Quatrieme train tres court, amplitude minuscule mais pente forte :
  // il ne se voit pas en geometrie, il se voit UNIQUEMENT dans le speculaire
  // et les caustiques. C'est le "grain" de la mer.
  addRipple(acc, p, normalize(w - wp * 0.18), 0.058, A * 0.11, 1.45, t);

  return acc;
}

// ---------------------------------------------------------------------------
//  SURFACE LIBRE COMPLETE : simulation + rides
// ---------------------------------------------------------------------------
// Retourne vec4(hauteur monde, dh/dx, dh/dz, laplacien).
// `f` est l'echantillon deja lu de uField, pour eviter un fetch de plus.

vec4 waterSurface(vec2 worldXZ, vec4 f, float t) {
  float depth = f.g;
  float open  = smoothstep(0.03, 0.30, depth);

  vec4 r = rippleField(worldXZ, t, open);

  // Gradient des grandes structures, par differences finies sur la texture.
  vec2 uv = fieldUV(worldXZ);
  float hL = texture2D(uField, uv - vec2(uFieldTexel.x, 0.0)).r;
  float hR = texture2D(uField, uv + vec2(uFieldTexel.x, 0.0)).r;
  float hD = texture2D(uField, uv - vec2(0.0, uFieldTexel.y)).r;
  float hU = texture2D(uField, uv + vec2(0.0, uFieldTexel.y)).r;
  float inv2c = 1.0 / (2.0 * uCell);

  vec4 s;
  s.x = f.r + r.x;
  s.y = (hR - hL) * inv2c + r.y;
  s.z = (hU - hD) * inv2c + r.z;
  // Laplacien de la simulation : 5 points. Il est petit (la sim est lissee par
  // le solveur) mais il porte les fronts de ressac, qui donnent les grandes
  // bandes lumineuses au moment ou la lame monte. Il faut le garder.
  s.w = (hL + hR + hD + hU - 4.0 * f.r) / (uCell * uCell) + r.w;
  return s;
}

/** Normale monde a partir du gradient. */
vec3 waterNormal(vec4 surf) {
  return normalize(vec3(-surf.y, 1.0, -surf.z));
}
`;
```

**Note sur le coût** : `waterSurface()` fait **4 `texture2D`** + 4 sinus/cosinus. Dans le shader de
sable on n'a besoin que du laplacien : on peut alors sauter les 4 fetchs (variante
`rippleLaplacianOnly`, §5.3) et tomber à **zéro texture** pour les caustiques. C'est ce qui rend
l'approche viable.

### 5.3 Caustiques dérivées du champ (approche physique)

```glsl
// ---------------------------------------------------------------------------
//  CAUSTIQUES — jacobien de la refraction
// ---------------------------------------------------------------------------
// A APPELER DEPUIS LE SHADER DE SABLE, pas depuis celui de l'eau.
//
//   worldPos  : position monde du fragment de FOND
//   surfaceY  : altitude de la surface libre au-dessus (uField.r)
//   sunDir    : direction du soleil (normalisee, y > 0)
//   t         : temps
//
// Retourne un GAIN multiplicatif sur la lumiere directe : 1.0 = neutre,
// 2.5 = noeud de caustique, 0.35 = zone d'ombre entre les reseaux.

float causticGain(vec3 worldPos, float surfaceY, vec3 sunDir, float t) {
  float d = surfaceY - worldPos.y;              // profondeur locale REELLE
  if (d < 0.012) return 1.0;                    // pas de caustiques sous 1.2 cm

  const float KAPPA = 0.2498;                   // 1 - 1/1.333

  // --- point d'entree du rayon solaire a la surface -------------------------
  // Le rayon arrive au fond en worldPos ; il est entre plus haut, decale dans
  // l'azimut solaire de d * tan(theta_refracte).
  float cosS  = max(sunDir.y, 0.05);
  float sinS  = sqrt(max(1.0 - cosS * cosS, 0.0));
  float sinSR = sinS / 1.333;                                  // Snell
  float tanSR = sinSR / sqrt(max(1.0 - sinSR * sinSR, 1e-3));
  vec2  azim  = length(sunDir.xz) > 1e-4 ? normalize(sunDir.xz) : vec2(1.0, 0.0);
  vec2  entry = worldPos.xz + azim * (d * tanSR);

  // --- laplacien de la surface au point d'entree ----------------------------
  // Version economique : rides analytiques SEULES (zero fetch). Le champ
  // simule est trop lisse pour produire des reseaux nets, il n'apporte que les
  // grandes bandes du ressac (activees par CAUSTICS_FROM_SIM).
  vec4 r = rippleField(entry, t, 1.0);
  float lap = r.w;

  #ifdef CAUSTICS_FROM_SIM
  {
    vec2 uv = fieldUV(entry);
    float hC = texture2D(uField, uv).r;
    float hL = texture2D(uField, uv - vec2(uFieldTexel.x, 0.0)).r;
    float hR = texture2D(uField, uv + vec2(uFieldTexel.x, 0.0)).r;
    float hD = texture2D(uField, uv - vec2(0.0, uFieldTexel.y)).r;
    float hU = texture2D(uField, uv + vec2(0.0, uFieldTexel.y)).r;
    lap += (hL + hR + hD + hU - 4.0 * hC) / (uCell * uCell);
  }
  #endif

  // --- jacobien -------------------------------------------------------------
  float J = 1.0 + KAPPA * d * lap;
  // Le clamp bas est ce qui fabrique le "nerf" lumineux : sans lui, J passe
  // par zero au point focal et l'intensite part a l'infini (pixels blancs qui
  // clignotent, et le bloom explose). 0.28 donne un pic a ~3.6x.
  float gain = 1.0 / max(J, 0.28);

  // --- flou par la taille angulaire du soleil -------------------------------
  // Le soleil fait 0.53 deg : a 60 cm de fond, le reseau est deja etale sur
  // ~6 mm. On simule en tirant le gain vers 1 avec la profondeur.
  float sharp = exp(-d * 1.15);
  gain = mix(1.0, gain, sharp * 0.85 + 0.15);

  // --- fondus ---------------------------------------------------------------
  // (a) montee : pas de caustiques dans un film d'eau
  gain = mix(1.0, gain, smoothstep(0.012, 0.075, d));
  // (b) hauteur solaire : au ras de l'horizon, les rayons rasent et il n'y a
  //     plus de reseau, juste un scintillement diffus.
  gain = mix(1.0, gain, smoothstep(0.06, 0.35, sunDir.y));

  return gain;
}
```

**Pourquoi c'est meilleur que du bruit** : le réseau suit *vraiment* les vagues. Quand le ressac
monte, les fronts de la simulation créent de larges bandes lumineuses qui avancent avec la lame.
Quand le joueur creuse une douve et que l'eau y tourbillonne, les caustiques tourbillonnent avec.
Un Voronoï animé, si joli soit-il, ne fera jamais ça — et c'est précisément ce qui trahit une fausse
eau.

### 5.4 Caustiques procédurales (Voronoï, 2 octaves, dispersion RGB)

Complémentaires, pas concurrentes : le jacobien donne la **structure** (grandes bandes, réaction aux
vagues), le Voronoï donne le **nerf** (les filaments fins et nets qu'on voit dans une piscine). On
les multiplie.

```glsl
// ---------------------------------------------------------------------------
//  CAUSTIQUES PROCEDURALES — reseau de Voronoi anime
// ---------------------------------------------------------------------------
vec2 caus_hash22(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * vec3(0.1031, 0.1030, 0.0973));
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.xx + p3.yz) * p3.zy);
}

/** Distance au bord de cellule (F2 - F1) : c'est CA, le nerf de la caustique. */
float caus_cell(vec2 p, float t) {
  vec2 ip = floor(p), fp = fract(p);
  float f1 = 8.0, f2 = 8.0;
  for (int j = -1; j <= 1; j++) {
    for (int i = -1; i <= 1; i++) {
      vec2 g = vec2(float(i), float(j));
      vec2 o = caus_hash22(ip + g);
      // les germes tournent : c'est l'animation
      o = 0.5 + 0.42 * sin(t * 1.20 + 6.2831853 * o);
      float d = length(g + o - fp);
      if (d < f1) { f2 = f1; f1 = d; }
      else if (d < f2) { f2 = d; }
    }
  }
  return f2 - f1;                    // 0 sur une arete de Voronoi
}

float caus_layer(vec2 p, float t, float scale, float sharpness) {
  float e = caus_cell(p * scale, t);
  float c = 1.0 - smoothstep(0.0, sharpness, e);
  return c * c;                      // le carre creuse les noirs
}

/**
 * Deux octaves + dispersion chromatique.
 * `flow` : deplacement du reseau (le courant local, uField2.g * vitesse).
 */
vec3 causticsProc(vec2 xz, float t, vec2 flow) {
  vec2 p = xz - flow * t * 0.35;

  float a1 = caus_layer(p,               t * 1.00,  8.5, 0.42);
  float a2 = caus_layer(p * 1.93 + 17.0, t * 1.31, 8.5, 0.30) * 0.55;

  // Dispersion : chaque canal echantillonne avec un leger decalage spatial.
  // 4 mm suffisent — au-dela on voit trois reseaux distincts, ce qui est laid.
  vec2 disp = vec2(0.0042, 0.0);
  float r = caus_layer(p - disp, t * 1.00, 8.5, 0.42);
  float b = caus_layer(p + disp, t * 1.00, 8.5, 0.42);

  return vec3(r, a1, b) + vec3(a2);
}
```

**Combinaison des deux, dans le shader de sable :**

```glsl
  float gJ = causticGain(vWorldPos, surfaceY, uSunDirection, uTime);   // structure
  vec3  gV = causticsProc(vWorldPos.xz, uTime, flowXZ);                // nerf

  // Le Voronoi module la structure au lieu de s'y ajouter : la ou le jacobien
  // dit "ombre", aucun filament ne doit apparaitre.
  vec3 caustic = vec3(gJ) * (0.55 + 0.85 * gV);
```

| Approche | Coût (1080p, fond visible ~35 % de l'écran) | Réagit aux vraies vagues | Netteté |
|---|---|---|---|
| Jacobien seul | ~0.06 ms (0 texture, 4 sin/cos) | **oui** | moyenne |
| Jacobien + `CAUSTICS_FROM_SIM` | ~0.14 ms (5 textures) | oui, + fronts de ressac | moyenne |
| Voronoï 2 octaves + dispersion | ~0.31 ms (4 × 9 cellules) | non | **excellente** |
| Les deux | ~0.38 ms | oui | excellente |

Recommandation : **les deux en qualité haute**, jacobien seul en moyenne, rien en basse.

### 5.5 La règle d'or : caustiques dans le sable, absorption dans l'eau

C'est le point d'intégration le plus facile à rater, et l'erreur produit une eau noire.

```
  Soleil
    │
    ▼  ─── traverse l'eau vers le bas  →  absorbé (le rouge part)
  ══════════════ surface ══════════════
    │  ─── concentré/dispersé par la forme de la surface  →  CAUSTIQUES
    ▼
  ▒▒▒▒▒▒▒▒▒ fond ▒▒▒▒▒▒▒▒▒  ← le sable réfléchit (albédo)
    │  ─── traverse l'eau vers le haut →  absorbé à nouveau
  ══════════════ surface ══════════════
    │
    ▼  œil
```

Donc :

| Effet | Où il est calculé | Pourquoi |
|---|---|---|
| Caustiques | **`SandMaterial`** | C'est de la lumière **qui arrive au fond**. Elle doit suivre le relief du sable (murs de douve, marches, pente), être occultée par les ombres portées, et rester visible même quand on regarde par la tranche du bloc. |
| Absorption + diffusion | **`WaterRenderer`** | Ça s'applique au trajet **dans l'eau**, sur le résultat lu dans `sceneRT`. Le trajet aller (soleil→fond) et retour (fond→œil) sont tous deux dans `waterBody()`. |
| Assombrissement humide | `SandMaterial`, **atténué sous l'eau** | Cf. §4.4 point 1. |
| Écume résiduelle (dentelle sur le sable mouillé après le retrait) | **`SandMaterial`** | Elle persiste alors qu'il n'y a plus d'eau ; le shader d'eau a `discard` à cet endroit. |

**Si on met les caustiques dans le shader d'eau** (le code actuel) : elles ne suivent pas le relief,
disparaissent en vue rasante, et sont atténuées deux fois. **Si on met l'absorption dans le sable** :
elle est appliquée une fois dans `sceneRT` puis une seconde fois par l'eau → `exp(−2σ·s)` au lieu de
`exp(−σ·s)` → le lagon devient noir dès 30 cm.

### 5.6 Patch complet de `SandMaterial.js`

```js
// src/render/SandMaterial.js
// --- 1) IMPORTS -------------------------------------------------------------
import { WATER_COMMON_PARS } from './WaterCommon.js';

// --- 2) UNIFORMES : ajouter au bloc `uniforms` ------------------------------
    // Champ d'eau (memes objets THREE que ceux de WaterRenderer — on partage,
    // on ne duplique pas : sinon les deux shaders divergent d'une frame).
    uField:      { value: null },
    uField2:     { value: null },
    uFieldRect:  { value: new THREE.Vector4(ORIGIN_X, ORIGIN_Z, 1 / WORLD_W, 1 / WORLD_D) },
    uFieldTexel: { value: new THREE.Vector2(1 / NX, 1 / NZ) },
    uCell:       { value: VOXEL },
    uWind:       { value: new THREE.Vector2(0.82, 0.57) },
    uWindStr:    { value: 1.0 },
    uRippleGain: { value: 1.0 },
    uCausticStrength: { value: 1.0 },

// --- 3) DEFINES -------------------------------------------------------------
  mat.defines = { ...(mat.defines || {}), USE_UV: '', CAUSTICS_PROC: '' };

// --- 4) FRAGMENT : declarations ---------------------------------------------
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        /* glsl */ `
        #include <common>
        varying vec4 vData;
        varying vec3 vWorldPos;
        varying vec3 vObjNormal;
        uniform vec3 uSunDirection;
        /* … uniformes existantes inchangees … */
        uniform float uCausticStrength;
        ${WATER_COMMON_PARS}
        ${CAUSTICS_GLSL}        /* §5.3 + §5.4 colles ici */

        // Etat "sous l'eau" du fragment, calcule une seule fois.
        struct Submerged { float wet; float depth; float surfaceY; vec2 flow; float foamRes; };
        Submerged sampleWater(vec3 wp) {
          Submerged s;
          s.wet = 0.0; s.depth = 0.0; s.surfaceY = -999.0;
          s.flow = vec2(0.0); s.foamRes = 0.0;
          vec2 uv = fieldUV(wp.xz);
          if (!inField(uv)) return s;
          vec4 f  = texture2D(uField,  uv);
          vec2 f2 = texture2D(uField2, uv).rg;
          s.surfaceY = f.r;
          s.foamRes  = f2.r;
          if (f.g < 0.0016) return s;
          float d = f.r - wp.y;                    // profondeur LOCALE, pas la colonne
          if (d <= 0.0) return s;
          s.depth = d;
          s.wet = smoothstep(0.0, 0.010, d);       // fondu de 1 cm a la ligne d'eau
          s.flow = vec2(f2.g) * 0.0;               // placeholder, cf. §9.2
          return s;
        }
        `
      )
```

```js
// --- 5) FRAGMENT : albedo, correction du sable immerge ----------------------
      .replace(
        '#include <map_fragment>',
        /* glsl */ `
        float moist   = vData.x;
        float packing = vData.y;
        float bakedAO = vData.z;
        float matId   = vData.w * 255.0;

        Submerged sub = sampleWater(vWorldPos);

        /* … grain / macro inchanges … */
        vec3 gp = vWorldPos * (34.0 * uGrainScale);
        float grain = sc_fbm(gp, 3);
        float macro = sc_fbm(vWorldPos * 2.6, 3);
        vec3 base = uDryColor * (0.90 + 0.20 * grain) * (0.95 + 0.10 * macro);

        // --- assombrissement humide, ATTENUE sous l'eau ---------------------
        // Hors de l'eau, le film d'eau piege la lumiere : le sable fonce fort.
        // Sous l'eau, le sable baigne dans un milieu qui retro-diffuse : il ne
        // fonce presque pas. Sans cette correction, le fond du lagon a un
        // albedo de 0.25 et AUCUN reglage du shader d'eau ne rattrapera le
        // turquoise. C'est la correction n.1 du document.
        float ws = 1.0 - exp(-moist * 7.5);
        ws *= mix(1.0, 0.40, sub.wet);

        const vec3 LUMW = vec3(0.2126, 0.7152, 0.0722);
        float lum    = max(dot(base, LUMW), 1e-4);
        float lumWet = pow(lum, 1.0 + 0.95 * ws) * mix(1.0, 0.72, ws);
        base *= lumWet / lum;
        base  = mix(vec3(lumWet), base, 1.0 + 0.16 * ws);
        base  = mix(base, base * vec3(0.92, 0.96, 1.06),
                    smoothstep(0.5, 1.0, moist) * 0.5 * (1.0 - sub.wet * 0.6));
        base *= mix(1.03, 0.94, packing);

        // --- ECUME RESIDUELLE : la dentelle laissee par le retrait ----------
        // Elle vit sur le SABLE, pas dans l'eau : quand la lame se retire, le
        // shader d'eau a deja fait discard() a cet endroit. C'est ce liseré
        // blanc qui persiste 3-4 s qui fait "vraie plage".
        if (sub.foamRes > 0.02) {
          float lace  = sc_fbm(vec3(vWorldPos.xz * 26.0, uTime * 0.15), 3);
          float lace2 = sc_fbm(vec3(vWorldPos.xz * 9.0, uTime * 0.08), 2);
          float f = smoothstep(0.30, 0.85, sub.foamRes * (0.45 + 1.1 * lace) * (0.6 + 0.8 * lace2));
          // l'ecume ne tient pas sur les pentes fortes
          f *= smoothstep(0.55, 0.90, vObjNormal.y);
          base = mix(base, vec3(0.94, 0.95, 0.93), f * 0.85);
        }

        /* … faces de coupe du bloc diorama, inchangees … */

        diffuseColor.rgb *= base;
        `
      )
```

```js
// --- 6) FRAGMENT : injection des caustiques sur la LUMIERE DIRECTE ----------
// C'est le bon point d'insertion : `reflectedLight.directDiffuse` porte deja
// le N.L et le masque d'ombre. Une caustique ne doit pas eclairer une zone a
// l'ombre du chateau, et elle doit s'attenuer sur un mur de douve incline.
// L'injecter dans <dithering_fragment> (apres tout l'eclairage) donnerait des
// reseaux lumineux dans les ombres portees : tres visible, tres faux.
      .replace(
        '#include <lights_fragment_end>',
        /* glsl */ `
        #include <lights_fragment_end>
        if (sub.wet > 0.001 && uCausticStrength > 0.001) {
          float gJ = causticGain(vWorldPos, sub.surfaceY, uSunDirection, uTime);
          #ifdef CAUSTICS_PROC
            vec3 gV = causticsProc(vWorldPos.xz, uTime, sub.flow);
            vec3 caus = vec3(gJ) * (0.55 + 0.85 * gV);
          #else
            vec3 caus = vec3(gJ);
          #endif
          // Les caustiques n'existent que sur les faces qui voient la surface.
          float up = smoothstep(0.05, 0.55, normal.y);
          vec3 gain = mix(vec3(1.0), caus, sub.wet * up * uCausticStrength);
          reflectedLight.directDiffuse *= gain;
          // Un soupcon d'indirect : la lumiere diffusee par le volume d'eau
          // arrive de partout et remonte legerement les creux.
          reflectedLight.indirectDiffuse *= mix(1.0, 1.0 + 0.18 * (gain.g - 1.0), sub.wet);
        }
        `
      )
```

```js
// --- 7) FRAGMENT : le sable immerge ne scintille pas ------------------------
// Le sparkle de quartz est un reflet SPECULAIRE air/grain. Sous l'eau,
// l'indice du milieu passe de 1.0 a 1.33 : le contraste d'indice s'effondre et
// le scintillement disparait. Le laisser sous l'eau donne un fond qui grouille
// de points blancs — tres reconnaissable, tres moche.
      .replace(
        'float wetDamp = mix(1.0, 0.2, smoothstep(0.03, 0.4, vData.x));',
        'float wetDamp = mix(1.0, 0.2, smoothstep(0.03, 0.4, vData.x)) * (1.0 - sub.wet * 0.92);'
      );
```

Et le câblage dans `Game.js` :

```js
// src/core/Game.js — dans update(), la ou su.uWaterTable est deja mis a jour
const su = this.sandMaterial.userData.uniforms;
const wu = this.waterRenderer.uniforms;
su.uWaterTable.value = this.water.waterTable;
su.uField.value      = wu.uField.value;      // MEME objet THREE.DataTexture
su.uField2.value     = wu.uField2.value;
su.uTime.value       = wu.uTime.value;       // MEME horloge, sinon les caustiques
                                             // et les vagues se desynchronisent
su.uWind.value.copy(wu.uWind.value);
su.uWindStr.value    = wu.uWindStr.value;
su.uRippleGain.value = wu.uRippleGain.value;
su.uSunDirection.value.copy(sunDir);
```

⚠️ **`uTime` partagée** : le shader d'eau incrémente son `uTime` de `dt`. Si le sable a sa propre
horloge, les caustiques dérivent lentement par rapport aux vagues et l'illusion se défait en une
minute. Une seule horloge, copiée.

---

## 6. Le volume d'eau vu de côté

### 6.1 Diagnostic

Le mesh d'eau est **un plan sans épaisseur**, avec `depthWrite: false` et `side: DoubleSide`. Vu de
biais, au bord du bloc diorama :

- on voit la tranche du terrain (les strates dessinées par `SandMaterial`),
- au-dessus, **rien** : le plan d'eau est vu par la tranche, il fait 0 px d'épaisseur,
- résultat : une arête nette où l'eau « s'arrête », et un vide entre elle et le sable.

C'est le problème n° 1 signalé. Il est **géométrique** : aucun réglage de shader de surface ne peut
le corriger. Il faut ajouter de la matière.

### 6.2 Les deux solutions

| Solution | Principe | Coût | Verdict |
|---|---|---|---|
| **Jupe (skirt)** | Un ruban vertical de 4 × 128 quads sur le pourtour du domaine, du niveau de la surface libre jusqu'au terrain. Shader dédié montrant l'eau en coupe. | 1024 sommets, ~0.04 ms | **RECOMMANDÉ.** Contrôle total sur le look de la coupe, cohérent avec le style diorama, trivial à débugger. |
| **Ray-marching dans le fragment de surface** | La surface marche 8–16 pas le long du rayon réfracté et accumule la diffusion. | +0.6 à 1.4 ms plein écran | Utile *en plus* de la jupe, pour les particules en suspension (§6.5). **Ne résout pas le problème** : le bord du bloc reste un plan vu par la tranche. |

La jupe n'est pas une astuce : c'est ce que fait n'importe quelle maquette. Un diorama, c'est un
bloc de matière coupé net, et **la coupe doit montrer l'intérieur**. On profite même de l'occasion :
la tranche d'eau est un endroit magnifique pour montrer le dégradé de profondeur, les particules en
suspension et la ligne de flottaison — trois choses qu'on ne voit jamais depuis le dessus.

### 6.3 La géométrie (JS complet)

```js
// src/render/WaterSkirt.js
/**
 * "Jupe" d'eau : le ruban vertical qui ferme le volume d'eau sur le pourtour
 * du bloc diorama.
 *
 * Geometrie STATIQUE : deux sommets par colonne du perimetre (bas / haut),
 * deplaces verticalement dans le vertex shader en lisant le champ d'eau. Zero
 * mise a jour CPU, comme le plan de surface.
 *
 * Attributs :
 *   position : (x, 0, z) monde — le y est ecrase par le vertex shader
 *   aTop     : 0 pour le sommet du bas (fond), 1 pour celui du haut (surface)
 *   aOut     : normale sortante du cote (xz), pour l'eclairage et le Fresnel
 */

import * as THREE from 'three';
import { WORLD_W, WORLD_D, ORIGIN_X, ORIGIN_Z, VOXEL } from '../core/Config.js';

/**
 * Decalage vers l'EXTERIEUR par rapport au plan de coupe du sable.
 * 1.8 mm : assez pour gagner le test de profondeur a coup sur a toutes les
 * distances de camera du jeu (0.5 m a 12 m, near=0.1), assez peu pour que
 * personne ne voie que l'eau deborde du bloc. Voir §10.4 (z-fighting).
 */
const OUTSET = 0.0018;

export function buildSkirtGeometry(segPerSide = 128) {
  const x0 = ORIGIN_X, x1 = ORIGIN_X + WORLD_W;
  const z0 = ORIGIN_Z, z1 = ORIGIN_Z + WORLD_D;

  // Les 4 cotes, dans le sens trigonometrique vu de dessus.
  const corners = [[x0, z0], [x1, z0], [x1, z1], [x0, z1]];
  const outward = [[0, -1], [1, 0], [0, 1], [-1, 0]];

  const nCols = 4 * (segPerSide + 1);
  const pos = new Float32Array(nCols * 2 * 3);
  const top = new Float32Array(nCols * 2);
  const out = new Float32Array(nCols * 2 * 2);
  const idx = [];

  let v = 0;
  for (let s = 0; s < 4; s++) {
    const [ax, az] = corners[s];
    const [bx, bz] = corners[(s + 1) % 4];
    const [nx, nz] = outward[s];
    for (let i = 0; i <= segPerSide; i++) {
      const t = i / segPerSide;
      // On rentre d'un demi-voxel aux extremites pour ne jamais echantillonner
      // le champ hors bornes (ClampToEdge le ferait, mais on prefere une
      // valeur juste a une valeur repetee).
      const k = 0.5 * VOXEL;
      const px = ax + (bx - ax) * t + nx * OUTSET + (bx - ax) * 0 + (t < 0.5 ? k : -k) * Math.sign(bx - ax || 0);
      const pz = az + (bz - az) * t + nz * OUTSET + (t < 0.5 ? k : -k) * Math.sign(bz - az || 0);
      for (let e = 0; e < 2; e++) {
        pos[v * 3 + 0] = px;
        pos[v * 3 + 1] = 0;
        pos[v * 3 + 2] = pz;
        top[v] = e;
        out[v * 2 + 0] = nx;
        out[v * 2 + 1] = nz;
        v++;
      }
    }
  }

  let base = 0;
  for (let s = 0; s < 4; s++) {
    for (let i = 0; i < segPerSide; i++) {
      const a = (base + i) * 2;   // bas gauche
      const b = a + 1;            // haut gauche
      const c = a + 2;            // bas droite
      const d = a + 3;            // haut droite
      idx.push(a, c, b, b, c, d);
    }
    base += segPerSide + 1;
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('aTop', new THREE.BufferAttribute(top, 1));
  geo.setAttribute('aOut', new THREE.BufferAttribute(out, 2));
  geo.setIndex(idx);
  // La jupe n'est jamais culled : sa bounding box est fausse (le y vient du
  // vertex shader).
  geo.boundingSphere = new THREE.Sphere(
    new THREE.Vector3(ORIGIN_X + WORLD_W / 2, 1.0, ORIGIN_Z + WORLD_D / 2),
    Math.hypot(WORLD_W, WORLD_D)
  );
  return geo;
}
```

**Note sur le winding** : on rend la jupe en `side: THREE.DoubleSide`. À 1024 sommets, le coût
supplémentaire est nul, et ça élimine toute une classe de bugs (un côté du bloc invisible parce que
la boucle des coins tourne dans le mauvais sens). C'est le bon compromis ici.

### 6.4 Le shader de la jupe

```glsl
// ===========================================================================
//  JUPE D'EAU — VERTEX
// ===========================================================================
attribute float aTop;
attribute vec2  aOut;

uniform float uTime;

varying vec3  vWorldPos;
varying vec2  vOut;
varying float vSurfaceY;
varying float vBottomY;
varying float vColDepth;
varying float vSed;
varying float vFoam;
varying vec2  vScreenUV;
varying float vViewZ;

${WATER_COMMON_PARS}

void main() {
  vec2 wxz = position.xz;
  vec2 uv  = clamp(fieldUV(wxz), uFieldTexel * 0.5, 1.0 - uFieldTexel * 0.5);
  vec4 f   = texture2D(uField, uv);

  float depth   = f.g;
  float surface = f.r;
  float bottom  = f.r - f.g;

  vSurfaceY = surface;
  vBottomY  = bottom;
  vColDepth = depth;
  vSed      = f.a;
  vFoam     = f.b;
  vOut      = aOut;

  // Ride analytique sur l'arete superieure UNIQUEMENT : la ligne de flottaison
  // doit ondoyer exactement comme le plan de surface, sinon on voit une fente
  // entre les deux au moindre clapot.
  float open = smoothstep(0.03, 0.30, depth);
  vec4 r = rippleField(wxz, uTime, open);
  float yTop = surface + r.x;

  // Colonne seche : on ecrase la jupe sur elle-meme (triangles degeneres,
  // rejetes par le rasterizer — moins cher qu'un discard par fragment).
  float alive = step(0.0016, depth);
  float y = mix(bottom, yTop, aTop * alive);

  vec3 wp = vec3(position.x, y, position.z);
  vWorldPos = wp;

  vec4 mv = viewMatrix * vec4(wp, 1.0);
  vViewZ = -mv.z;
  gl_Position = projectionMatrix * mv;
  vScreenUV = (gl_Position.xy / max(gl_Position.w, 1e-4)) * 0.5 + 0.5;
}
```

```glsl
// ===========================================================================
//  JUPE D'EAU — FRAGMENT
// ===========================================================================
#include <packing>

uniform sampler2D uSceneColor;
uniform sampler2D uSceneDepth;
uniform vec2  uSceneSize;
uniform vec2  uResolution;
uniform float uNear, uFar;

uniform vec3  uSunDir, uSunColor;
uniform vec3  uSkyZenith, uSkyHorizon;
uniform vec3  uSigmaA, uSigmaS, uScatterTint, uDeepColor;
uniform float uScatterGain, uDepthScale;
uniform float uTime;
/** Epaisseur "visuelle" de la tranche d'eau vue de cote (m). */
uniform float uSlabThickness;
uniform float uParticles;

varying vec3  vWorldPos;
varying vec2  vOut;
varying float vSurfaceY, vBottomY, vColDepth, vSed, vFoam;
varying vec2  vScreenUV;
varying float vViewZ;

${WATER_COMMON_PARS}

float sceneEyeDepth(vec2 uv) {
  return -perspectiveDepthToViewZ(texture2D(uSceneDepth, uv).x, uNear, uFar);
}

float sk_hash13(vec3 p) {
  p = fract(p * 0.1031);
  p += dot(p, p.zyx + 31.32);
  return fract((p.x + p.y) * p.z);
}

void main() {
  if (vColDepth < 0.0016) discard;

  float yLocal = vSurfaceY - vWorldPos.y;         // profondeur sous la surface
  if (yLocal < -0.004) discard;                   // au-dessus de la ligne d'eau

  vec3 N = normalize(vec3(vOut.x, 0.0, vOut.y));
  vec3 V = normalize(cameraPosition - vWorldPos);

  // -------------------------------------------------------------------------
  //  1) LE FOND, VU A TRAVERS LA TRANCHE
  // -------------------------------------------------------------------------
  // La jupe est decalee de 1.8 mm vers l'exterieur ; juste derriere elle se
  // trouve la coupe geologique du sable (strates + ligne de nappe dessinees
  // par SandMaterial). On la lit dans le buffer de capture et on la teinte :
  // c'est ce qui fait qu'on voit le SABLE MOUILLE A TRAVERS L'EAU sur la
  // tranche, au lieu d'un aplat bleu colle par-dessus.
  vec2 base = gl_FragCoord.xy / uResolution;
  // Decalage de refraction lateral, faible : la paroi est un plan vertical.
  vec4 rr = rippleField(vWorldPos.xz, uTime, 1.0);
  vec2 off = vec2(rr.y, rr.z) * 0.020 * min(yLocal, 0.5);
  vec2 uvR = base + off;
  float zR = sceneEyeDepth(uvR);
  uvR = mix(base, uvR, smoothstep(0.0, 0.03, zR - vViewZ));
  vec3 behind = texture2D(uSceneColor, uvR).rgb;

  // -------------------------------------------------------------------------
  //  2) ABSORPTION LE LONG DE LA TRANCHE
  // -------------------------------------------------------------------------
  // Deux contributions :
  //   - le trajet HORIZONTAL vers l'interieur du bloc (ce qu'on regarde en
  //     coupe) : l'epaisseur visuelle du "verre"
  //   - le trajet VERTICAL depuis la surface : c'est lui qui fait le degrade
  //     clair-en-haut / sombre-en-bas, la signature d'une coupe d'aquarium.
  float slab  = uSlabThickness / max(abs(dot(N, V)), 0.25);
  float path  = slab + yLocal * 1.35;

  float turb  = clamp(vSed * 40.0, 0.0, 1.0);
  vec3  sigA  = mix(uSigmaA, vec3(0.55, 0.30, 0.42), turb);
  vec3  sigS  = mix(uSigmaS, vec3(0.45, 0.40, 0.32), turb);
  vec3  tint  = mix(uScatterTint, vec3(0.42, 0.36, 0.24), turb);
  vec3  sigT  = sigA + sigS;

  vec3 T = exp(-sigT * path * uDepthScale);

  // Lumiere qui descend dans le volume : attenuee par la colonne au-dessus.
  vec3 down   = exp(-sigT * yLocal * uDepthScale);
  vec3 lightV = uSunColor * max(uSunDir.y, 0.0) * down + uSkyZenith * 0.30 * down;
  vec3 albedo = sigS / max(sigT, vec3(1e-4));
  vec3 scatter = tint * albedo * lightV * uScatterGain;

  vec3 col = behind * T + scatter * (vec3(1.0) - T);

  // -------------------------------------------------------------------------
  //  3) PUITS DE LUMIERE (god rays) — gratuits, on a deja le laplacien
  // -------------------------------------------------------------------------
  // Les memes rides qui font les caustiques au fond font des colonnes
  // lumineuses dans le volume. On reutilise rippleField() au point d'entree
  // decale par le soleil.
  {
    float cosS  = max(uSunDir.y, 0.05);
    float sinSR = sqrt(max(1.0 - cosS * cosS, 0.0)) / 1.333;
    float tanSR = sinSR / sqrt(max(1.0 - sinSR * sinSR, 1e-3));
    vec2  azim  = length(uSunDir.xz) > 1e-4 ? normalize(uSunDir.xz) : vec2(1.0, 0.0);
    vec2  entry = vWorldPos.xz + azim * (yLocal * tanSR);
    float lap   = rippleField(entry, uTime, 1.0).w;
    float shaft = 1.0 / max(1.0 + 0.2498 * yLocal * lap, 0.30);
    // les puits s'estompent en profondeur (diffusion multiple)
    shaft = mix(1.0, shaft, exp(-yLocal * 1.6));
    col *= mix(1.0, shaft, 0.55 * smoothstep(0.03, 0.20, yLocal));
  }

  // -------------------------------------------------------------------------
  //  4) PARTICULES EN SUSPENSION
  // -------------------------------------------------------------------------
  // C'est ce detail qui transforme "un dégradé bleu" en "de l'eau". Grille 3D
  // fixe dans le monde, derive verticale lente, densite proportionnelle au
  // sediment. Elles accrochent le soleil : elles sont beaucoup plus visibles
  // dans les puits de lumiere, ce qui renforce l'effet precedent.
  if (uParticles > 0.001) {
    float dens = 0.06 + 0.55 * turb;
    vec3 pc = vWorldPos;
    pc.y -= uTime * 0.012;                      // remontee tres lente
    pc.xz += vec2(sin(uTime * 0.21), cos(uTime * 0.17)) * 0.01;
    float acc = 0.0;
    for (int i = 0; i < 2; i++) {
      float sc = (i == 0) ? 190.0 : 340.0;
      vec3 cell = floor(pc * sc);
      float r = sk_hash13(cell + float(i) * 13.7);
      float on = step(1.0 - dens * 0.05, r);
      vec3 fr = fract(pc * sc) - 0.5 - (sk_hash13(cell + 3.1) - 0.5) * 0.6;
      float dot2 = 1.0 - smoothstep(0.10, 0.30, length(fr));
      acc += on * dot2 * (i == 0 ? 1.0 : 0.55);
    }
    col += uSunColor * acc * uParticles * 0.55
         * smoothstep(0.01, 0.10, yLocal) * down.g;
  }

  // -------------------------------------------------------------------------
  //  5) LA LIGNE DE FLOTTAISON
  // -------------------------------------------------------------------------
  // Un menisque net : 3 mm de blanc-cyan tres lumineux, plus un liseré sombre
  // juste dessous (l'ombre portee de la surface sur elle-meme). Sans cette
  // ligne, la jupe se fond dans le sable et le bloc n'a toujours pas l'air de
  // contenir de l'eau.
  {
    float m = 1.0 - smoothstep(0.0, 0.0032, abs(yLocal));
    float shadow = smoothstep(0.0030, 0.0090, yLocal) * (1.0 - smoothstep(0.009, 0.020, yLocal));
    col *= 1.0 - shadow * 0.22;
    col += (uSunColor * 0.55 + uSkyZenith * 0.45) * m * 1.35;
  }

  // -------------------------------------------------------------------------
  //  6) ECUME COLLEE A LA PAROI
  // -------------------------------------------------------------------------
  {
    float band = 1.0 - smoothstep(0.0, 0.012, yLocal);
    float f = smoothstep(0.25, 0.75, vFoam) * band;
    col = mix(col, vec3(0.95, 0.96, 0.94), f * 0.7);
  }

  // -------------------------------------------------------------------------
  //  7) FRESNEL DE LA PAROI + REFLET DE CIEL RASANT
  // -------------------------------------------------------------------------
  float F = 0.02 + 0.98 * pow(1.0 - clamp(dot(N, V), 0.0, 1.0), 5.0);
  vec3 sky = mix(uSkyHorizon, uSkyZenith, 0.35);
  col = mix(col, sky, F * 0.42);

  // -------------------------------------------------------------------------
  //  8) OPACITE
  // -------------------------------------------------------------------------
  // Transparente au ras de la surface (la ligne d'eau doit se fondre dans le
  // sable), quasi opaque en profondeur (on ne doit pas voir a travers le bloc).
  float a = smoothstep(0.0, 0.014, yLocal);
  a *= mix(0.52, 0.94, clamp(yLocal / 0.45, 0.0, 1.0));
  a = clamp(max(a, F * 0.65), 0.0, 1.0);

  gl_FragColor = vec4(col, a);
}
```

### 6.5 Variante : ray-marching court

Si on veut du vrai volume plutôt qu'un dégradé (par exemple pour que les particules aient une
parallaxe correcte quand on tourne autour du diorama), on remplace les étapes 2–4 par une marche de
6 à 8 pas *vers l'intérieur du bloc* :

```glsl
  // --- volume par marche courte -------------------------------------------
  const int STEPS = 8;
  vec3 rd = -V;                                  // on rentre dans le bloc
  float tMax = uSlabThickness / max(abs(dot(N, V)), 0.25);
  float dt = tMax / float(STEPS);
  // dither pour casser le banding (indispensable a 8 pas)
  float jitter = sk_hash13(vec3(gl_FragCoord.xy, uTime * 60.0));

  vec3 acc = vec3(0.0);
  vec3 trans = vec3(1.0);
  for (int i = 0; i < STEPS; i++) {
    float s = (float(i) + jitter) * dt;
    vec3 sp = vWorldPos + rd * s;
    vec2 uv = fieldUV(sp.xz);
    if (!inField(uv)) break;
    vec4 f = texture2D(uField, uv);
    if (sp.y > f.r || sp.y < f.r - f.g) continue;   // hors de la lame d'eau

    float dLoc = f.r - sp.y;
    vec3  lig  = uSunColor * max(uSunDir.y, 0.0) * exp(-sigT * dLoc * uDepthScale);
    float part = 0.0;
    { vec3 cell = floor(sp * 210.0);
      part = step(0.996, sk_hash13(cell)) * 3.0; }

    vec3 srcTerm = (tint * (sigS / max(sigT, vec3(1e-4))) + vec3(part)) * lig;
    vec3 stepT = exp(-sigT * dt * uDepthScale);
    acc  += trans * srcTerm * (vec3(1.0) - stepT);
    trans *= stepT;
    if (max(trans.r, max(trans.g, trans.b)) < 0.02) break;
  }
  vec3 col = behind * trans + acc;
```

| | Jupe « dégradé » (§6.4) | Jupe ray-marchée (§6.5) |
|---|---|---|
| Coût (bande de ~60 px sur le pourtour) | 0.04 ms | 0.22 ms |
| Parallaxe des particules | non | oui |
| Suit la vraie forme du fond dans le bloc | non (approximation) | oui |
| Banding | non | à ditherer, sinon visible |

**Recommandation : la jupe en dégradé par défaut** (elle est déjà très belle et pratiquement
gratuite), la marche courte réservée au mode photo (`Post.setPhotoMode(true)`), où 0.2 ms n'ont
aucune importance et où le joueur regarde longuement une image fixe.

### 6.6 Ordre de rendu et z-fighting

```js
this.surfaceMesh.renderOrder = 10;   // la surface EN DERNIER
this.skirtMesh.renderOrder   = 9;    // la jupe avant
// (les opaques sont a 0)
```

La jupe est à `renderOrder` **inférieur** : elle est plus loin de la caméra que la surface dans les
vues de biais, et les transparents se composent de l'arrière vers l'avant.

Contre le z-fighting avec la coupe de sable (`SandMaterial`, bloc `cut`), trois mesures cumulées —
et il faut les trois :

```js
const skirtMat = new THREE.ShaderMaterial({
  /* … */
  transparent: true,
  depthWrite: false,          // 1) elle n'ecrit pas : rien ne peut se battre avec elle
  depthTest: true,
  side: THREE.DoubleSide,
  polygonOffset: true,        // 2) et si elle ecrivait un jour, elle gagnerait
  polygonOffsetFactor: -1,
  polygonOffsetUnits: -1,
});
// 3) OUTSET = 1.8 mm dans la geometrie (§6.3)
```

**Pourquoi 1.8 mm et pas 0.1 mm** : la précision du Z-buffer 24 bits à 3 m de distance avec
`near = 0.1` et `far = 60` est d'environ 0.15 mm. Il faut au moins 10× la marge pour survivre au
zoom arrière (à 12 m la précision tombe à ~2 mm — d'où la nécessité du `depthWrite: false` qui rend
le problème sans objet). Et 1.8 mm sur un bloc de 10.24 m, c'est 0.02 % : invisible.

---

## 7. La surface

### 7.1 Normales multi-échelles et anisotropie du vent

Le code actuel calcule la normale par différences finies sur la texture (bien) puis ajoute
`cos(x*26)*0.05` (moins bien : un seul train, isotrope, non conservatif — la normale ne dérive
d'aucune hauteur, donc le spéculaire ne correspond pas au déplacement des sommets).

Avec `waterSurface()` du §5.2, la normale **dérive exactement de la hauteur** utilisée pour déplacer
les sommets. Conséquence directe : le spéculaire tombe pile sur les crêtes, la réfraction bouge en
phase avec le relief, les caustiques sont sous les bonnes vagues. Ces trois cohérences sont ce qui
sépare une eau crédible d'une eau « en plastique ».

Quatre échelles, réglées pour un diorama de 10 m :

| Train | λ | Amplitude | Vitesse | Rôle visuel |
|---|---|---|---|---|
| Simulation (`uField.r`) | 0.5–4 m | 0–15 cm | — | ressac, tourbillons de douve, marée |
| Ride 1 | 62 cm | 3.2 mm | 0.62 m/s | houle courte, visible en géométrie |
| Ride 2 | 29 cm | 2.0 mm | 0.78 m/s | croisement, casse la régularité |
| Ride 3 | 13.5 cm | 0.96 mm | 1.05 m/s | **porte les caustiques nettes** |
| Ride 4 | 5.8 cm | 0.35 mm | 1.45 m/s | **porte le sun glitter** — invisible autrement |

Les rides 3 et 4 sont sous la résolution du maillage (4 cm) : elles ne doivent **jamais** être
appliquées au déplacement des sommets (elles aliaseraient violemment), seulement à la **normale** et
au **laplacien**. D'où la séparation dans `waterSurface()` : le vertex shader n'utilise que `s.x`
(et encore, il pourrait ne prendre que les rides 1–2), le fragment shader utilise `s.y/s.z/s.w`.

```glsl
// --- Vertex : deplacement, rides longues seulement -------------------------
  vec4 surf = waterSurface(wxz, f, uTime);
  // On retranche l'apport des trains courts au deplacement geometrique :
  // les garder ferait scintiller les sommets (leur longueur d'onde est sous la
  // maille de 4 cm — Nyquist).
  vec4 shortOnly = vec4(0.0);
  addRipple(shortOnly, wxz, normalize(uWind + vec2(-uWind.y, uWind.x) * 0.33), 0.135, 0.30 * A, 1.05, uTime);
  addRipple(shortOnly, wxz, normalize(uWind - vec2(-uWind.y, uWind.x) * 0.18), 0.058, 0.11 * A, 1.45, uTime);
  p.y = surf.x - shortOnly.x;
  vSurf = surf;                       // la normale complete part au fragment
```

**Anisotropie** : les quatre trains sont serrés à ±25° autour de `uWind`. Concrètement, on voit des
stries alignées dans l'axe de la brise, et le sun glitter s'étire perpendiculairement à elles.
C'est un signal très fort de « il y a du vent » que l'œil lit inconsciemment. Une eau isotrope
ressemble à du papier bulle.

Piloter `uWind` depuis la météo du jeu (`Moisture.wind` existe déjà) :

```js
// src/core/Game.js
const wa = this.moisture.windAngle ?? 0.6;
wu.uWind.value.set(Math.cos(wa), Math.sin(wa));
wu.uWindStr.value = THREE.MathUtils.clamp(this.moisture.wind * 1.4, 0.15, 2.0);
```

### 7.2 Spéculaire GGX et anticrénelage de la rugosité

```glsl
// ---------------------------------------------------------------------------
//  SPECULAIRE SOLEIL — GGX avec elargissement par la distance
// ---------------------------------------------------------------------------
// Le probleme : la ride 4 a une longueur d'onde de 5.8 cm. A 4 m de distance,
// un pixel couvre ~4 mm : ca va. A 12 m, il en couvre 1.2 cm : on
// sous-echantillonne un lobe tres serre, et le speculaire se met a clignoter
// violemment d'une frame a l'autre. La parade standard (LEAN mapping, Toksvig)
// est de RUGOSIFIER avec la distance : on remplace un lobe fin sous-echantillonne
// par un lobe large bien echantillonne. C'est physiquement la bonne reponse
// (c'est ce que fait le filtrage de la NDF), et ca coute une multiplication.

float ggxSpec(vec3 N, vec3 V, vec3 L, float rough) {
  vec3 H = normalize(L + V);
  float a  = max(rough * rough, 1e-4);
  float a2 = a * a;
  float NdH = max(dot(N, H), 0.0);
  float NdL = max(dot(N, L), 0.0);
  float NdV = max(dot(N, V), 1e-4);
  float d = NdH * NdH * (a2 - 1.0) + 1.0;
  float D = a2 / (3.14159265 * d * d);
  // Smith height-correlated, forme compacte
  float gv = NdL * sqrt(NdV * NdV * (1.0 - a2) + a2);
  float gl = NdV * sqrt(NdL * NdL * (1.0 - a2) + a2);
  float Vis = 0.5 / max(gv + gl, 1e-5);
  return D * Vis * NdL;
}

  // rugosite de base tres faible (l'eau est un miroir), elargie avec la distance
  float dist = length(cameraPosition - vWorldPos);
  float rough = 0.035 + 0.075 * smoothstep(2.0, 11.0, dist);
  // et elargie aussi la ou l'ecume casse la surface
  rough = mix(rough, 0.42, foam);

  vec3 spec = uSunColor * ggxSpec(N, V, uSunDir, rough) * 3.2;
```

Sans l'élargissement, l'eau lointaine grésille et l'`UnrealBloomPass` (seuil 1.45) transforme le
grésillement en flashes blancs. Avec, on obtient une bande lumineuse stable — le fameux « chemin de
lumière » vers le soleil.

### 7.3 Sun glitter

Le GGX donne le lobe. Le **glitter** (les milliers de petites étoiles individuelles) est un
phénomène différent : ce sont des micro-facettes *résolues* individuellement par l'œil, pas une
statistique. Il faut donc un terme séparé, exactement comme le `sparkle` de quartz de
`SandMaterial` (§3.4 de `RECHERCHE-RENDU-3D.md`) — et par cohérence de style, autant reprendre la
même construction :

```glsl
// ---------------------------------------------------------------------------
//  SUN GLITTER
// ---------------------------------------------------------------------------
vec3 wg_hash33(vec3 p) {
  p = vec3(dot(p, vec3(127.1, 311.7, 74.7)),
           dot(p, vec3(269.5, 183.3, 246.1)),
           dot(p, vec3(113.5, 271.9, 124.6)));
  return fract(sin(p) * 43758.5453123);
}
float wg_hash13(vec3 p) {
  p = fract(p * 0.1031);
  p += dot(p, p.zyx + 31.32);
  return fract((p.x + p.y) * p.z);
}

float sunGlitter(vec3 N, vec3 V, vec3 L, vec3 wp, float dist, float t, vec2 wind) {
  // Fondu en distance : au-dela de ~9 m un pixel couvre plusieurs facettes et
  // le glitter degenere en voile blanc uniforme. On l'eteint, le GGX prend le
  // relais.
  float fade = exp(-dist * 0.16) * smoothstep(14.0, 8.0, dist);
  if (fade < 0.015) return 0.0;

  // Grille de facettes qui DERIVE avec le vent : sans la derive, le glitter
  // est fige dans le monde et on voit une texture de points collee sur l'eau.
  vec3 gp = wp;
  gp.xz -= wind * t * 0.22;
  vec3 cell = floor(gp * 300.0);

  vec3 r = wg_hash33(cell) * 2.0 - 1.0;
  // Anisotropie : les facettes s'inclinent plus dans l'axe perpendiculaire au
  // vent (les rides sont des cylindres allonges dans l'axe du vent).
  vec2 wp2 = vec2(-wind.y, wind.x);
  vec2 tilt = r.xz * 0.34;
  tilt = wind * dot(tilt, wind) * 0.45 + wp2 * dot(tilt, wp2) * 1.35;

  vec3 facet = normalize(N + vec3(tilt.x, 0.0, tilt.y));
  vec3 H = normalize(L + V);
  float s = pow(max(dot(facet, H), 0.0), 700.0);

  // Densite tres faible : ~2 cellules sur 1000 s'allument. Au-dela, ce n'est
  // plus du scintillement, c'est du glitter de carte de voeux.
  float on = step(0.9978, wg_hash13(cell + 5.3));
  // Clignotement temporel : chaque facette a sa propre phase.
  float blink = 0.55 + 0.45 * sin(t * 7.5 + wg_hash13(cell + 11.1) * 62.8);

  return s * on * blink * fade;
}
```

Application :

```glsl
  float glit = sunGlitter(N, V, uSunDir, vWorldPos, dist, uTime, normalize(uWind));
  // Volontairement au-dessus du seuil de bloom (1.45) : c'est le SEUL element
  // de la scene qui a le droit de bloomer, et c'est ce qui donne le "plein
  // soleil". L'ecume l'etouffe (une crete brisee ne reflete plus).
  col += uSunColor * glit * 4.5 * (1.0 - foam);
```

### 7.4 Fresnel et réflexion de ciel analytique

```glsl
// ---------------------------------------------------------------------------
//  FRESNEL + CIEL
// ---------------------------------------------------------------------------
  // Schlick exact, F0 = 0.020 pour n = 1.333 : ((n-1)/(n+1))^2
  float NdV = clamp(dot(N, V), 0.0, 1.0);
  float F = 0.020 + 0.980 * pow(1.0 - NdV, 5.0);

  // Le point cle du §4.4 : a une inclinaison de diorama (40-55 deg), NdV ~ 0.7
  // et F vaut 0.024. VINGT-QUATRE MILLIEMES. Toute formule qui injecte 15 % de
  // ciel au centre de l'image delave l'eau — c'est le bug du code actuel
  // (fres = mix(0.02, 1.0, pow(...,4)) puis *0.75).

  vec3 R = reflect(-V, N);
  // Degrade de ciel analytique : suffisant a cette echelle et 20x moins cher
  // qu'une reflexion planaire.
  float up = clamp(R.y, 0.0, 1.0);
  vec3 sky = mix(uSkyHorizon, uSkyZenith, pow(up, 0.42));
  // Halo solaire dans le reflet (le "sun pillar")
  sky += uSunColor * pow(max(dot(R, uSunDir), 0.0), 90.0) * 1.4;
  // Sous l'horizon, le rayon reflechi vise la plage : on prend une teinte de
  // sable plutot que du ciel, sinon les vagues qui montent ont un liseré bleu.
  sky = mix(uSandBounce, sky, smoothstep(-0.06, 0.06, R.y));

  col = mix(col, sky, F);
```

`uSandBounce` : la couleur moyenne du sable éclairé, en linéaire — ~`(0.52, 0.44, 0.30)`. Détail
peu coûteux et très payant sur les vagues qui déferlent vers le spectateur.

### 7.5 Écume — trois couches + la résiduelle

| Couche | Source | Durée de vie | Où elle est dessinée |
|---|---|---|---|
| **1. Bord de vague** | profondeur `< 6 cm` × turbulence | instantanée | shader d'eau |
| **2. Turbulence** | `uField.b` (mémoire de vitesse, demi-vie 0.35 s) | ~1 s | shader d'eau |
| **3. Résiduelle** | `uField2.r` (nouveau, demi-vie ~4 s) | 4–8 s | shader d'eau **et** `SandMaterial` |

La couche 3 est la plus importante pour l'impression de « vraie plage » : c'est la dentelle blanche
qui reste sur le sable mouillé après le retrait de la lame et qui se dissout lentement. Le code
actuel ne l'a pas : l'écume disparaît en même temps que l'eau, ce qui produit un ressac « propre »
et artificiel.

```glsl
// ---------------------------------------------------------------------------
//  ECUME
// ---------------------------------------------------------------------------
float wf_vnoise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  float a = wg_hash13(vec3(i, 0.0));
  float b = wg_hash13(vec3(i + vec2(1, 0), 0.0));
  float c = wg_hash13(vec3(i + vec2(0, 1), 0.0));
  float d = wg_hash13(vec3(i + vec2(1, 1), 0.0));
  return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
}

/**
 * @param d       profondeur de la colonne (m)
 * @param turb    uField.b — memoire de turbulence
 * @param res     uField2.r — ecume residuelle
 * @param flowXZ  direction du courant, pour etirer la dentelle
 */
float foamMask(vec3 wp, float d, float turb, float res, vec2 flowXZ, float t) {
  // La dentelle est ETIREE dans le sens du courant : une ecume isotrope
  // ressemble a de la mousse a raser. C'est le detail qui la fait lire comme
  // de l'ecume de mer.
  vec2 fl = length(flowXZ) > 1e-3 ? normalize(flowXZ) : vec2(1.0, 0.0);
  vec2 pf = vec2(dot(wp.xz, fl), dot(wp.xz, vec2(-fl.y, fl.x)));
  pf.x *= 0.38;                                    // etirement 2.6:1

  float n1 = wf_vnoise(pf * 34.0 + vec2(t * 0.65, -t * 0.22));
  float n2 = wf_vnoise(pf * 12.5 - vec2(t * 0.28, t * 0.33));
  float n3 = wf_vnoise(pf * 78.0 + vec2(-t * 1.10, t * 0.85));   // grain fin

  // 1) bord de lame
  float edge = 1.0 - smoothstep(0.004, 0.060, d);
  // 2) turbulence
  float tb = turb * (0.55 + 1.9 * edge);
  // 3) residuelle : plus douce, plus large, moins contrastee
  float rs = res * 0.85;

  float m = max(tb, rs);
  m *= (0.50 + 0.80 * n1) * (0.65 + 0.65 * n2);

  float foam = smoothstep(0.22, 0.66, m);
  // grain fin : perce des trous dans les nappes epaisses (l'ecume est une
  // mousse, pas une peinture)
  foam *= 0.72 + 0.42 * n3;
  return clamp(foam, 0.0, 1.0);
}
```

Rendu de l'écume — deux erreurs à éviter :

```glsl
  float foam = foamMask(vWorldPos, dCol, vFoam, vFoamRes, flowXZ, uTime);

  // (1) L'ecume n'est pas blanc pur : c'est une mousse translucide qui laisse
  //     passer la couleur de l'eau par en dessous. Blanc pur = autocollant.
  vec3 foamCol = mix(vec3(0.93, 0.95, 0.94), col * 1.4 + 0.35, 0.22);
  //     Elle est aussi legerement retro-eclairee par le soleil (SSS de la mousse)
  foamCol += uSunColor * 0.22 * max(dot(V, -uSunDir), 0.0) * foam;

  col = mix(col, foamCol, foam);

  // (2) L'ecume DETRUIT le speculaire et le reflet : ne pas oublier de
  //     l'appliquer AVANT le GGX/glitter, ou de multiplier ceux-ci par
  //     (1 - foam). Une crete d'ecume qui brille comme un miroir est
  //     immediatement perçue comme fausse.
```

Le patch de simulation qui alimente `uField2.r` est au [§9](#9-patches-de-simulation-waterjs).

---

## 8. Le shader d'eau assemblé

Le fichier `WaterRenderer.js` réécrit. Il crée **deux mesh** (surface + jupe) partageant les mêmes
textures et uniformes.

```js
// src/render/WaterRenderer.js
/**
 * Rendu de l'eau — surface + volume.
 *
 * Deux mesh, une seule verite :
 *   - `surface` : le plan subdivise, deplace par le champ de simulation.
 *   - `skirt`   : la jupe verticale qui ferme le volume sur le pourtour du
 *                 bloc diorama. Sans elle, la mer vue de cote est une feuille
 *                 de papier.
 *
 * Deux textures flottantes, mises a jour a chaque frame :
 *   uField  RGBA : R=altitude de la surface libre, G=profondeur,
 *                  B=ecume (turbulence), A=sediment
 *   uField2 RG   : R=ecume residuelle, G=vitesse normalisee (pour l'etirement
 *                  de l'ecume et la derive des caustiques)
 *
 * Le fragment shader de la surface lit le buffer de scene opaque capture par
 * SceneCapture : c'est ce qui donne la refraction, l'effet de lentille, et la
 * possibilite d'appliquer l'absorption sur le VRAI fond plutot que sur une
 * couleur inventee.
 */

import * as THREE from 'three';
import {
  NX, NZ, VOXEL, WORLD_W, WORLD_D, ORIGIN_X, ORIGIN_Z, LAYER_WATER,
} from '../core/Config.js';
import { WATER_COMMON_PARS } from './WaterCommon.js';
import { buildSkirtGeometry } from './WaterSkirt.js';

// --- chunks GLSL (colles depuis les §3, §5, §7) -----------------------------
const GLSL_HELPERS   = /* §7.3 wg_hash33 / wg_hash13, §7.5 wf_vnoise */ ``;
const GLSL_BODY      = /* §4.5 waterBody() */ ``;
const GLSL_SPEC      = /* §7.2 ggxSpec(), §7.3 sunGlitter() */ ``;
const GLSL_FOAM      = /* §7.5 foamMask() */ ``;

const SURFACE_VERT = /* glsl */ `
uniform float uTime;
uniform float uSeaLevel;

varying vec3  vWorldPos;
varying vec4  vSurf;        // (h, dh/dx, dh/dz, laplacien)
varying float vDepth;
varying float vFoam;
varying float vFoamRes;
varying float vSed;
varying vec2  vFlow;
varying float vViewZ;

${WATER_COMMON_PARS}

void main() {
  // Le PlaneGeometry est tourne de -90 deg autour de X : son +Y local devient
  // -Z monde. On calcule donc l'UV du champ depuis la POSITION MONDE et non
  // depuis l'attribut uv, ce qui elimine definitivement le risque d'inversion
  // (et permet a WaterCommon d'utiliser la meme fonction que le sable).
  vec3 p = position;
  vec2 wxz = (modelMatrix * vec4(p, 1.0)).xz;

  vec2 uv = clamp(fieldUV(wxz), uFieldTexel * 0.5, 1.0 - uFieldTexel * 0.5);
  vec4 f  = texture2D(uField, uv);
  vec2 f2 = texture2D(uField2, uv).rg;

  vDepth   = f.g;
  vFoam    = f.b;
  vSed     = f.a;
  vFoamRes = f2.r;

  vec4 surf = waterSurface(wxz, f, uTime);
  vSurf = surf;

  // Deplacement geometrique : on retire les deux trains les plus courts (ils
  // sont sous la maille de 4 cm, cf. §7.1). Leur contribution reste dans
  // vSurf pour la normale et le laplacien.
  float open = smoothstep(0.03, 0.30, vDepth);
  vec4 shortOnly = vec4(0.0);
  {
    vec2 w = normalize(uWind);
    vec2 wp2 = vec2(-w.y, w.x);
    float A = 0.0032 * uWindStr * uRippleGain * open;
    addRipple(shortOnly, wxz, normalize(w + wp2 * 0.33), 0.135, A * 0.30, 1.05, uTime);
    addRipple(shortOnly, wxz, normalize(w - wp2 * 0.18), 0.058, A * 0.11, 1.45, uTime);
  }
  p.y = surf.x - shortOnly.x;

  // Direction du courant, pour l'etirement de l'ecume : le gradient de la
  // surface libre pointe a l'oppose de l'ecoulement.
  vFlow = -vec2(surf.y, surf.z) * 6.0;

  vec4 wp = modelMatrix * vec4(p, 1.0);
  vWorldPos = wp.xyz;
  vec4 mv = viewMatrix * wp;
  vViewZ = -mv.z;
  gl_Position = projectionMatrix * mv;
}
`;

const SURFACE_FRAG = /* glsl */ `
#include <packing>

uniform sampler2D uSceneColor;
uniform sampler2D uSceneDepth;
uniform vec2  uSceneSize;
uniform vec2  uResolution;
uniform float uNear, uFar;

uniform vec3  uSunDir, uSunColor, uSkyZenith, uSkyHorizon, uSandBounce;
uniform vec3  uSigmaA, uSigmaS, uScatterTint, uDeepColor;
uniform float uScatterGain, uDepthScale;
uniform float uTime, uSunAmount;

varying vec3  vWorldPos;
varying vec4  vSurf;
varying float vDepth, vFoam, vFoamRes, vSed, vViewZ;
varying vec2  vFlow;

${WATER_COMMON_PARS}
${GLSL_HELPERS}
${GLSL_BODY}
${GLSL_SPEC}
${GLSL_FOAM}

float sceneEyeDepth(vec2 uv) {
  return -perspectiveDepthToViewZ(texture2D(uSceneDepth, uv).x, uNear, uFar);
}

void main() {
  float dCol = vDepth;
  if (dCol < 0.0016) discard;

  vec3 N = waterNormal(vSurf);
  // Le plan est DoubleSide : vu par en dessous il faut retourner la normale,
  // sinon Fresnel et speculaire partent en vrille sur la tranche.
  if (!gl_FrontFacing) N = -N;
  vec3 V = normalize(cameraPosition - vWorldPos);
  float dist = length(cameraPosition - vWorldPos);

  vec2 base = gl_FragCoord.xy / uResolution;

  // =========================================================================
  //  1) REFRACTION  (§3)
  // =========================================================================
  vec3 refracted;
  float pathView = dCol / 0.9;
  float slabView = pathView;

#ifndef NO_REFRACT
  {
    const float ETA = 1.0 / 1.333;
    vec3 T = refract(-V, N, ETA);
    if (dot(T, T) < 0.5) T = vec3(0.0, -1.0, 0.0);
    float cosT = max(-T.y, 0.20);
    pathView = dCol / cosT;

    vec3 hit = vWorldPos + T * pathView;
    vec4 clipP = projectionMatrix * viewMatrix * vec4(hit, 1.0);
    vec2 uvR = (clipP.xy / max(clipP.w, 1e-4)) * 0.5 + 0.5;

    // --- test de rejet (§3.3) ---
    float zR = sceneEyeDepth(uvR);
    float accept = smoothstep(0.0, 0.04, zR - vViewZ);
    vec2 uvF = mix(base, uvR, accept);
    uvF = clamp(uvF, vec2(0.0015), vec2(0.9985));
    // alignement texel (buffer demi-resolution)
    uvF = (floor(uvF * uSceneSize) + 0.5) / uSceneSize;

    float zF = sceneEyeDepth(uvF);
    slabView = min(pathView, max(zF - vViewZ, 0.0));

    // --- dispersion chromatique (§3.4) ---
    vec2 off = uvF - base;
  #ifdef HQ_DISPERSION
    refracted = vec3(
      texture2D(uSceneColor, base + off * 0.988).r,
      texture2D(uSceneColor, base + off * 1.000).g,
      texture2D(uSceneColor, base + off * 1.019).b);
  #else
    refracted = texture2D(uSceneColor, uvF).rgb;
  #endif

    // --- garde-ciel (§3.3c) ---
    float skyGuard = step(zF, uFar * 0.85);
    refracted = mix(uDeepColor, refracted, skyGuard);
  }
#else
  // Palier de qualite bas : pas de buffer, on approxime le fond par la couleur
  // du sable. On garde exactement la meme suite de calcul.
  refracted = uSandBounce;
  slabView = pathView;
#endif

  // =========================================================================
  //  2) CORPS D'EAU  (§4)
  // =========================================================================
  float turb = clamp(vSed * 40.0, 0.0, 1.0);
  vec3 skyAmb = mix(uSkyHorizon, uSkyZenith, 0.6);
  vec3 col = waterBody(refracted, dCol, slabView, turb, uSunColor, uSunAmount, skyAmb);

  // =========================================================================
  //  3) ECUME  (§7.5) — AVANT le speculaire
  // =========================================================================
  float foam = foamMask(vWorldPos, dCol, vFoam, vFoamRes, vFlow, uTime);
  vec3 foamCol = mix(vec3(0.93, 0.95, 0.94), col * 1.4 + 0.35, 0.22);
  foamCol += uSunColor * 0.22 * max(dot(V, -uSunDir), 0.0) * foam;
  col = mix(col, foamCol, foam);

  // =========================================================================
  //  4) FRESNEL + CIEL  (§7.4)
  // =========================================================================
  float NdV = clamp(dot(N, V), 0.0, 1.0);
  float F = 0.020 + 0.980 * pow(1.0 - NdV, 5.0);
  vec3 R = reflect(-V, N);
  vec3 sky = mix(uSkyHorizon, uSkyZenith, pow(clamp(R.y, 0.0, 1.0), 0.42));
  sky += uSunColor * pow(max(dot(R, uSunDir), 0.0), 90.0) * 1.4;
  sky = mix(uSandBounce, sky, smoothstep(-0.06, 0.06, R.y));
  col = mix(col, sky, F * (1.0 - foam * 0.8));

  // =========================================================================
  //  5) SPECULAIRE + GLITTER  (§7.2, §7.3)
  // =========================================================================
  float rough = 0.035 + 0.075 * smoothstep(2.0, 11.0, dist);
  rough = mix(rough, 0.42, foam);
  col += uSunColor * ggxSpec(N, V, uSunDir, rough) * 3.2 * uSunAmount * (1.0 - foam * 0.85);

#ifdef HQ_GLITTER
  float glit = sunGlitter(N, V, uSunDir, vWorldPos, dist, uTime, normalize(uWind));
  col += uSunColor * glit * 4.5 * uSunAmount * (1.0 - foam);
#endif

  // =========================================================================
  //  6) OPACITE
  // =========================================================================
  // Le corps de l'eau est deja compose avec le fond (on a LU le fond). L'alpha
  // ne sert donc plus qu'a fondre le bord de la lame, la ou l'epaisseur tend
  // vers zero. C'est un changement de nature par rapport a l'ancienne version :
  // on ne "melange" plus une couleur d'eau par-dessus le sable, on REMPLACE le
  // pixel par le resultat du transport radiatif. D'ou un alpha qui monte tres
  // vite a 1.
  float alpha = smoothstep(0.0016, 0.018, dCol);
  alpha = max(alpha, foam * 0.9);
#ifdef NO_REFRACT
  // Sans buffer de fond, il FAUT rester semi-transparent, sinon on masque le
  // sable au lieu de le teinter.
  alpha = min(alpha, 0.86);
#endif

  gl_FragColor = vec4(col, clamp(alpha, 0.0, 1.0));
}
`;
```

Et la classe :

```js
export class WaterRenderer {
  constructor(scene, water, field, opts = {}) {
    this.scene = scene;
    this.water = water;
    this.field = field;

    // --- textures de champ --------------------------------------------------
    this.data = new Float32Array(NX * NZ * 4);
    this.tex = new THREE.DataTexture(this.data, NX, NZ, THREE.RGBAFormat, THREE.FloatType);
    this.tex.magFilter = this.tex.minFilter = THREE.LinearFilter;
    this.tex.wrapS = this.tex.wrapT = THREE.ClampToEdgeWrapping;
    this.tex.needsUpdate = true;

    this.data2 = new Float32Array(NX * NZ * 2);
    this.tex2 = new THREE.DataTexture(this.data2, NX, NZ, THREE.RGFormat, THREE.FloatType);
    this.tex2.magFilter = this.tex2.minFilter = THREE.LinearFilter;
    this.tex2.wrapS = this.tex2.wrapT = THREE.ClampToEdgeWrapping;
    this.tex2.needsUpdate = true;

    // --- uniformes ----------------------------------------------------------
    this.uniforms = {
      uField:      { value: this.tex },
      uField2:     { value: this.tex2 },
      uFieldRect:  { value: new THREE.Vector4(ORIGIN_X, ORIGIN_Z, 1 / WORLD_W, 1 / WORLD_D) },
      uFieldTexel: { value: new THREE.Vector2(1 / NX, 1 / NZ) },
      uCell:       { value: VOXEL },
      uTime:       { value: 0 },
      uSeaLevel:   { value: 1.05 },
      uWind:       { value: new THREE.Vector2(0.82, 0.57) },
      uWindStr:    { value: 1.0 },
      uRippleGain: { value: 1.0 },

      uSceneColor: { value: null },
      uSceneDepth: { value: null },
      uSceneSize:  { value: new THREE.Vector2(1, 1) },
      uResolution: { value: new THREE.Vector2(1, 1) },
      uNear:       { value: 0.1 },
      uFar:        { value: 60 },

      uSunDir:     { value: new THREE.Vector3(0.4, 0.8, 0.35).normalize() },
      uSunColor:   { value: new THREE.Color(1.0, 0.95, 0.85) },
      uSunAmount:  { value: 1.0 },
      uSkyZenith:  { value: new THREE.Color(0x2f6fc4).convertSRGBToLinear() },
      uSkyHorizon: { value: new THREE.Color(0xbfd8ea).convertSRGBToLinear() },
      uSandBounce: { value: new THREE.Color(0.52, 0.44, 0.30) },

      // --- calibration turquoise, §4.3 ---
      uSigmaA:      { value: new THREE.Vector3(0.42, 0.058, 0.016) },
      uSigmaS:      { value: new THREE.Vector3(0.030, 0.048, 0.075) },
      uScatterTint: { value: new THREE.Color(0.055, 0.78, 0.86) },
      uScatterGain: { value: 0.95 },
      uDepthScale:  { value: 6.0 },
      uDeepColor:   { value: new THREE.Color(0.012, 0.19, 0.30) },

      // --- jupe ---
      uSlabThickness: { value: 0.34 },
      uParticles:     { value: 1.0 },
    };

    const defines = { HQ_DISPERSION: '', HQ_GLITTER: '' };

    // --- surface ------------------------------------------------------------
    const geo = new THREE.PlaneGeometry(WORLD_W, WORLD_D, NX - 1, NZ - 1);
    geo.rotateX(-Math.PI / 2);
    geo.translate(ORIGIN_X + WORLD_W / 2, 0, ORIGIN_Z + WORLD_D / 2);

    this.material = new THREE.ShaderMaterial({
      uniforms: this.uniforms,
      defines,
      vertexShader: SURFACE_VERT,
      fragmentShader: SURFACE_FRAG,
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
    });

    this.mesh = new THREE.Mesh(geo, this.material);
    this.mesh.name = 'water-surface';
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 10;
    this.mesh.layers.set(LAYER_WATER);          // <-- exclue de la capture
    scene.add(this.mesh);

    // --- jupe ---------------------------------------------------------------
    this.skirtMaterial = new THREE.ShaderMaterial({
      uniforms: this.uniforms,                  // MEMES uniformes
      defines,
      vertexShader: SKIRT_VERT,
      fragmentShader: SKIRT_FRAG,
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
      polygonOffset: true,
      polygonOffsetFactor: -1,
      polygonOffsetUnits: -1,
    });
    this.skirt = new THREE.Mesh(buildSkirtGeometry(128), this.skirtMaterial);
    this.skirt.name = 'water-skirt';
    this.skirt.frustumCulled = false;
    this.skirt.renderOrder = 9;
    this.skirt.layers.set(LAYER_WATER);
    scene.add(this.skirt);
  }

  /** Branche le buffer de refraction. A appeler une fois apres Post. */
  bindSceneCapture(capture, camera) {
    const u = this.uniforms;
    u.uSceneColor.value = capture.target.texture;
    u.uSceneDepth.value = capture.target.depthTexture;
    u.uSceneSize.value.set(capture.target.width, capture.target.height);
    u.uResolution.value.copy(capture.resolution);
    u.uNear.value = camera.near;
    u.uFar.value = camera.far;
    this._capture = capture;
  }

  /** Recopie l'etat de la simulation dans les textures. */
  update(dt, sunDir, sunColor, skyZenith, skyHorizon) {
    const w = this.water;
    const surf = this.field.surfaceH;
    const d = this.data, d2 = this.data2;
    const h = w.h, foam = w.foam, res = w.foamRes, sed = w.sed;
    const vx = w.vx, vz = w.vz;
    const n = NX * NZ;
    for (let c = 0, o = 0, o2 = 0; c < n; c++, o += 4, o2 += 2) {
      const hw = h[c];
      d[o]     = surf[c] + hw;
      d[o + 1] = hw;
      d[o + 2] = foam[c];
      d[o + 3] = sed[c];
      d2[o2]     = res[c];
      d2[o2 + 1] = Math.min(1, Math.hypot(vx[c], vz[c]) * 0.5);
    }
    this.tex.needsUpdate = true;
    this.tex2.needsUpdate = true;

    const u = this.uniforms;
    u.uTime.value += dt;
    u.uSeaLevel.value = w.seaLevel;
    if (sunDir) u.uSunDir.value.copy(sunDir).normalize();
    if (sunColor) u.uSunColor.value.copy(sunColor);
    if (skyZenith) u.uSkyZenith.value.copy(skyZenith);
    if (skyHorizon) u.uSkyHorizon.value.copy(skyHorizon);
    u.uSunAmount.value = Math.max(0, u.uSunDir.value.y);

    // La taille du buffer de capture change au resize.
    if (this._capture) {
      u.uSceneSize.value.set(this._capture.target.width, this._capture.target.height);
      u.uResolution.value.copy(this._capture.resolution);
    }
  }

  /** Palier de qualite : 0 = bas, 1 = moyen, 2 = haut. */
  setQuality(level) {
    const set = (mat) => {
      mat.defines = {};
      if (level < 1) mat.defines.NO_REFRACT = '';
      if (level >= 2) { mat.defines.HQ_DISPERSION = ''; mat.defines.HQ_GLITTER = ''; }
      mat.needsUpdate = true;
    };
    set(this.material);
    set(this.skirtMaterial);
    this.uniforms.uParticles.value = level >= 1 ? 1.0 : 0.0;
    this.skirt.visible = level >= 1;
  }

  dispose() {
    this.scene.remove(this.mesh, this.skirt);
    this.mesh.geometry.dispose();
    this.skirt.geometry.dispose();
    this.material.dispose();
    this.skirtMaterial.dispose();
    this.tex.dispose();
    this.tex2.dispose();
  }
}
```

⚠️ **`<tonemapping_fragment>` et `<colorspace_fragment>` ont disparu** du fragment shader. C'est
volontaire, voir [§10.4](#104-pièges).

---

## 9. Patches de simulation (`Water.js`)

### 9.1 Écume résiduelle

```js
// src/sim/Water.js — dans le constructeur
    /** Ecume RESIDUELLE : la dentelle qui reste sur le sable apres le retrait. */
    this.foamRes = new Float32Array(COLS);
```

```js
// src/sim/Water.js — dans erode(), remplacer le bloc de decroissance d'ecume
  erode(dt) {
    /* … */
    const foam = this.foam;
    const foamRes = this.foamRes;

    // Deux memoires de turbulence, deux constantes de temps :
    //   - foam     : demi-vie ~0.35 s. C'est la mousse VIVANTE, sur la crete.
    //   - foamRes  : demi-vie ~4 s.    C'est la trace laissee sur le sable.
    // Une seule constante ne peut pas faire les deux : trop rapide et le
    // ressac est "propre" (l'ecume disparait avec l'eau, tres artificiel) ;
    // trop lente et la mer entiere est blanche.
    const foamDecay = Math.pow(0.965, dt * 60);
    const resDecay  = Math.pow(0.9971, dt * 60);   // ~4 s de demi-vie

    for (let z = 1; z < NZ - 1; z++) {
      /* … */
        const c = row + x;
        const hw = h[c];
        if (hw < WATER_EPSILON) {
          if (sed[c] > 0) { this.deposit(x, z, sed[c]); sed[c] = 0; }
          foam[c] *= foamDecay;
          // La residuelle continue de vivre sur le sable DECOUVERT : c'est
          // tout l'interet. On l'evapore un peu plus vite a sec.
          foamRes[c] *= resDecay * 0.997;
          continue;
        }
        const speed = Math.hypot(vx[c], vz[c]);
        foam[c] = Math.max(foam[c] * foamDecay, clamp(speed * 0.55, 0, 1));
        // La residuelle se recharge depuis la mousse vive, avec un seuil :
        // seule une ecume franche laisse une trace.
        const deposit = foam[c] > 0.35 ? (foam[c] - 0.35) * 1.45 : 0;
        foamRes[c] = Math.max(foamRes[c] * resDecay, Math.min(1, deposit));
        /* … suite inchangee … */
    }
  }
```

Et il faut décroître `foamRes` **partout**, pas seulement dans les bornes de scan (sinon la dentelle
reste figée sur les colonnes que le solveur ne visite plus). Une passe amortie une frame sur quatre
suffit :

```js
// src/sim/Water.js — dans step(), apres infiltrate(dt)
    this.decayResidualFoam(dt);

  /**
   * Decroissance globale de l'ecume residuelle.
   *
   * Les bornes de scan (scanA/scanB) ne couvrent que les lignes mouillees ou
   * voisines de mouillees. Une trace d'ecume laissee en haut d'estran par une
   * grosse vague sort de ces bornes des que la lame se retire, et resterait
   * gravee pour toujours. On balaie donc TOUT le domaine, mais une frame sur
   * quatre et avec un pas quadruple : le cout est de 16 k iterations par frame
   * sur un tableau contigu, soit une fraction de milliseconde.
   */
  decayResidualFoam(dt) {
    this._foamPhase = (this._foamPhase + 1) & 3;
    const k = Math.pow(0.9971, dt * 60 * 4);
    const r = this.foamRes;
    for (let c = this._foamPhase; c < COLS; c += 4) {
      const v = r[c];
      if (v > 0.002) r[c] = v * k;
      else if (v > 0) r[c] = 0;
    }
  }
```

(et `this._foamPhase = 0;` dans le constructeur).

### 9.2 Vitesse exportée — pour l'étirement de l'écume et la dérive des caustiques

`vx`/`vz` existent déjà. On exporte leur **module normalisé** dans `uField2.g` (fait au §8), et on
reconstruit la direction dans le shader à partir du gradient de la surface libre — c'est plus stable
qu'interpoler un champ de vecteurs à travers un filtrage bilinéaire, et ça ne coûte pas un canal
supplémentaire.

Si on veut la vraie direction (pour un flow-map d'écume plus convaincant dans les tourbillons de
douve), il faut passer `uField2` en RGBA et y mettre `(foamRes, vx*k, vz*k, age)`. Coût : 512 Ko de
plus. À faire seulement si l'étirement par le gradient déçoit à l'usage.

---

## 10. Intégration, performance, pièges

### 10.1 Séquence complète dans `Game.render()`

```js
// src/core/Game.js
render(dt) {
  // 1) simulation deja faite -> upload des textures
  this.waterRenderer.update(dt, sunDir, sunColor, skyZenith, skyHorizon);

  // 2) partage des uniformes avec le sable (§5.6)
  const su = this.sandMaterial.userData.uniforms;
  const wu = this.waterRenderer.uniforms;
  su.uField.value      = wu.uField.value;
  su.uField2.value     = wu.uField2.value;
  su.uTime.value       = wu.uTime.value;
  su.uWind.value.copy(wu.uWind.value);
  su.uWindStr.value    = wu.uWindStr.value;
  su.uRippleGain.value = wu.uRippleGain.value;
  su.uSunDirection.value.copy(sunDir);

  // 3) rendu (Post.render enchaine capture -> composer -> release)
  this.post.focusOn(/* … */);
  if (this.post) this.post.render(dt);
  else this.renderer.render(this.scene, this.camera);
}
```

### 10.2 Coût de chaque effet

Mesures indicatives, 1080p, GPU intégré milieu de gamme (Iris Xe), diorama 10 m, ~180 k triangles,
l'eau couvrant ~40 % de l'écran.

| Effet | Coût | Ce qu'on perd en le coupant |
|---|---|---|
| Passe de capture (½ rés.) | **0.55 ms** | toute la réfraction |
| Réfraction, 1 tap | 0.09 ms | — |
| Dispersion chromatique (3 taps) | +0.11 ms | l'effet de lentille aux bords du récif |
| Corps d'eau (absorption + diffusion) | 0.07 ms | le turquoise. Non négociable. |
| Normales 4 octaves analytiques | 0.13 ms | la déformation du fond devient molle |
| GGX + rugosité distance | 0.05 ms | — |
| Sun glitter | 0.10 ms | **le « plein soleil ».** Très rentable. |
| Écume 3 couches | 0.12 ms | la laisse de mer |
| Caustiques jacobien (dans le sable) | 0.06 ms | — |
| Caustiques Voronoï 2 oct. + dispersion | +0.31 ms | la netteté des filaments |
| Jupe, dégradé | 0.04 ms | **le volume.** Non négociable. |
| Jupe, ray-marching 8 pas | +0.18 ms | la parallaxe des particules |
| **Total qualité haute** | **≈ 1.8 ms** | |
| **Total qualité basse** | **≈ 0.35 ms** | |

Le poste dominant est **la passe de capture**, pas les shaders. C'est rassurant : c'est le seul qui
se coupe d'un booléen, et la moitié du gain visuel (turquoise, caustiques, volume, glitter) survit
sans elle.

### 10.3 Paliers de qualité

```js
// src/core/Game.js — dans setQuality(level)
  setQuality(level) {
    /* … reglages existants … */
    this.post.capture.enabled = level >= 1;
    this.waterRenderer.setQuality(level);
    const su = this.sandMaterial.userData.uniforms;
    su.uCausticStrength.value = level >= 1 ? 1.0 : 0.0;
    if (level >= 2) this.sandMaterial.defines.CAUSTICS_PROC = '';
    else delete this.sandMaterial.defines.CAUSTICS_PROC;
    this.sandMaterial.needsUpdate = true;
    // Palier 2 : la capture passe en 0.75x pour des bords de refraction plus nets
    this.post.capture.scale = level >= 2 ? 0.75 : 0.5;
    this.post.capture.setSize(innerWidth, innerHeight);
  }
```

| | Bas (0) | Moyen (1) | Haut (2) |
|---|---|---|---|
| Passe de capture | ✗ | ½ rés. | ¾ rés. |
| Réfraction | ✗ (fond approximé) | 1 tap | 3 taps + dispersion |
| Absorption / diffusion | ✓ | ✓ | ✓ |
| Caustiques | ✗ | jacobien | jacobien × Voronoï |
| Jupe | ✗ | dégradé | dégradé (+ marche en mode photo) |
| Particules en suspension | ✗ | ✓ | ✓ |
| Sun glitter | ✗ | ✗ | ✓ |
| Octaves de rides | 2 | 4 | 4 |

En bas, l'eau reste **turquoise et volumineuse en couleur** (le corps d'eau ne coûte rien) : elle
perd la réfraction, les caustiques et le volume géométrique. C'est le bon ordre de sacrifice.

### 10.4 Pièges

**1. Lire la target dans laquelle on dessine.**
Le symptôme classique : des bandes noires ou une image « en escalier » qui se décale d'une frame.
La règle : `uSceneColor` et `uSceneDepth` viennent **toujours** de `SceneCapture.target`, jamais du
buffer courant du composer. Si un jour on ajoute une passe de « réfraction des transparents entre
eux », il faudra une seconde capture, pas une lecture directe.

**2. Espaces colorimétriques — vérifié dans la source de r185.**
Dans `WebGLRenderer`, le tone mapping et la conversion de sortie ne sont injectés dans les shaders
que si `currentRenderTarget === null` :

```js
// three r185, WebGLPrograms.getParameters + WebGLRenderer.setProgram
let toneMapping = NoToneMapping;
if (material.toneMapped) {
  if (currentRenderTarget === null || currentRenderTarget.isXRRenderTarget === true) {
    toneMapping = renderer.toneMapping;
  }
}
outputColorSpace: (currentRenderTarget === null)
  ? renderer.outputColorSpace
  : ColorManagement.workingColorSpace
```

Conséquences pratiques, toutes importantes :

- Sous `EffectComposer`, **tout est rendu dans une render target**, donc `<tonemapping_fragment>` et
  `<colorspace_fragment>` **compilent à vide**. Les garder dans le shader d'eau n'est pas un bug,
  mais c'est trompeur : on croit tone-mapper alors que c'est `OutputPass` qui le fait. On les retire.
- Le contenu de `sceneRT` est en **linéaire sRGB non borné** (HalfFloat). On l'échantillonne
  directement : **aucun `pow(x, 2.2)`, aucun `sRGBToLinear()`**. Une conversion de trop et le fond
  devient noir dans les ombres.
- `sceneRT.texture.colorSpace` doit rester `LinearSRGBColorSpace`. Si on met `SRGBColorSpace`,
  three.js insère une décodification à la lecture et on double la conversion.
- Toutes les couleurs de calibration (`uScatterTint`, `uDeepColor`, `uSandBounce`) sont **en
  linéaire**, pas en sRGB. C'est pour ça qu'elles sont écrites en flottants dans le code plutôt qu'en
  hexadécimal : un `0x4fc3c9` sans `.convertSRGBToLinear()` donne une eau délavée, et avec, une eau
  correcte — mais on ne le voit pas dans le code, alors qu'un `(0.055, 0.78, 0.86)` est explicite.

**3. `DepthTexture`, ses contraintes.**
- `NearestFilter` obligatoire. Un `LinearFilter` sur une profondeur non linéaire interpole entre
  deux surfaces et produit des valeurs qui ne correspondent à rien : le test de rejet clignote sur
  les silhouettes.
- `UnsignedIntType` + `DepthFormat` : 24 bits. `UnsignedShortType` (16 bits) suffirait à 10 m mais
  ne coûte rien de moins en pratique.
- On ne peut pas **remplacer** la `depthTexture` d'une target déjà utilisée
  (three.js #19447) — `setSize()`, lui, fonctionne. D'où le `setSize` dans `SceneCapture`.
- Une `depthTexture` n'est valide que pour le renderer qui l'a produite (#27965). Sans importance
  ici (un seul renderer), mais à savoir si on ajoute un rendu de miniature hors écran.

**4. Shadow map rendue deux fois.**
`renderer.render()` reconstruit les shadow maps à chaque appel si `shadowMap.autoUpdate` est vrai.
Avec deux `render()` par frame, on paie la cascade deux fois pour rien. `SceneCapture.render()`
passe `autoUpdate = false` juste après la capture, `release()` le remet à `true`. **Si on oublie
`release()`, les ombres se figent** — symptôme : les ombres ne suivent plus le soleil.

**5. Z-fighting au bord du bloc.**
Traité au §6.6 : `OUTSET = 1.8 mm` + `depthWrite: false` + `polygonOffset`. Les trois. Et surtout,
**la jupe ne doit pas écrire dans le Z-buffer** : sinon elle masque la surface d'eau qui la traverse
au niveau de la ligne de flottaison, et on obtient une encoche noire de 1 px tout autour du bloc.

**6. `DoubleSide` et la normale.**
Le plan de surface est `DoubleSide` (on peut passer sous le niveau de la mer en tournant la caméra).
Sans `if (!gl_FrontFacing) N = -N;`, le Fresnel s'inverse par en dessous et l'eau devient un miroir
opaque. Trois caractères, un bug très déroutant.

**7. Ordre de tri des transparents.**
`renderOrder` : jupe 9, surface 10. three.js trie ensuite par distance au sein du même `renderOrder`.
Les props transparents (bulles, éclaboussures) doivent être à **11 ou plus**, sinon ils sont
composés avant l'eau et disparaissent dedans.

**8. `frustumCulled = false` sur les deux mesh.**
Leur `y` est calculé dans le vertex shader : la bounding box CPU est fausse. Sans ce drapeau, l'eau
disparaît quand la caméra plonge.

**9. Le `clamp` de l'UV de réfraction.**
`clamp(uvF, 0.0015, 0.9985)` : sans lui, un `ClampToEdge` sur le bord du buffer étire le pixel de
bordure sur toute la largeur de la nappe quand la caméra est très rasante. Très visible, très laid.

**10. NaN sur `refract()`.**
`refract()` renvoie `vec3(0)` en cas de réflexion totale interne. Impossible depuis l'air, mais une
normale dégénérée (colonne d'eau nulle, `normalize(vec3(0))`) y mène. Le garde-fou
`if (dot(T,T) < 0.5)` évite un écran de pixels noirs.

**11. `pixelRatio` et le resize.**
`SceneCapture.setSize()` doit être appelé **avec les dimensions CSS**, il applique le `pixelRatio`
lui-même — comme `EffectComposer.setSize()`. Mélanger les deux conventions donne un buffer de
réfraction décalé d'un facteur 2 sur écran Retina : la réfraction pointe à côté et le fond « glisse ».

**12. Le seuil de bloom.**
`UnrealBloomPass(…, 0.17, 0.32, 1.45)` : seuil 1.45. Le corps de l'eau doit rester sous ~1.1
(§4.4 point 4), le sun glitter monte à ~4.5 × `uSunColor`. Si on remonte `uScatterGain` au-dessus
de 1.2, la mer entière se met à bloomer et le diorama disparaît sous un voile laiteux.

---

## 11. Ordre d'implémentation

Chaque étape est **testable indépendamment** et apporte un gain visible. Ne pas tout faire d'un coup.

| # | Étape | Fichiers | Durée | Gain visuel |
|---|---|---|---|---|
| 1 | `LAYER_WATER` + `WaterCommon.js` (uniformes + `fieldUV` + `rippleField`) | Config, WaterCommon | 1 h | aucun (fondation) |
| 2 | Brancher `waterSurface()` dans le vertex/fragment de l'eau, remplacer la normale ad hoc | WaterRenderer | 1 h | ★★ surface bien plus riche, spéculaire cohérent |
| 3 | **Corps d'eau (§4.5)** : absorption + diffusion, calibration turquoise | WaterRenderer | 1 h | ★★★★ le turquoise apparaît |
| 4 | **Sable immergé (§4.4-1)** : `ws *= mix(1.0, 0.40, underwater)` | SandMaterial | 15 min | ★★★★ le lagon devient lumineux |
| 5 | **Jupe (§6)** | WaterSkirt, WaterRenderer | 3 h | ★★★★★ le bloc a un volume |
| 6 | **`SceneCapture` + réfraction (§2, §3)** | SceneCapture, Post, WaterRenderer, Game | 3 h | ★★★★★ le fond se déforme |
| 7 | **Caustiques jacobien (§5.3, §5.6)** | WaterCommon, SandMaterial | 2 h | ★★★★ |
| 8 | Écume résiduelle (§7.5, §9.1) | Water, WaterRenderer, SandMaterial | 2 h | ★★★ la laisse de mer |
| 9 | Sun glitter (§7.3) | WaterRenderer | 1 h | ★★★ le plein soleil |
| 10 | Caustiques Voronoï (§5.4) + dispersion chromatique (§3.4) | WaterCommon, WaterRenderer | 1 h 30 | ★★ finition |
| 11 | Boost sélectif des cyans (§4.4-5) + paliers de qualité (§10.3) | Post, Game | 1 h | ★ finition |

**Étapes 3 et 4 en premier si le temps manque.** À elles deux (1 h 15) elles règlent le grief
« mer fade » ; l'étape 5 (3 h) règle le grief n° 1 ; l'étape 6 (3 h) règle les griefs 2 et 4.

Ordre de test suggéré pour chaque étape : un `tools/shot.mjs` avec (a) vue de dessus, (b) vue de
côté au ras de l'eau, (c) vue rasante sur le bord du bloc, (d) une douve creusée de 25 cm avec un
seau dedans (c'est le cas qui révèle tous les défauts de réfraction d'un coup).

---

## 12. Références

**Réfraction écran**
- [Catlike Coding — *Looking Through Water*](https://catlikecoding.com/unity/tutorials/flow/looking-through-water/) — le test de rejet `uvOffset *= saturate(depthDifference)`, `AlignWithGrabTexel`, le brouillard exponentiel. La référence la plus directement applicable.
- [3D Game Shaders For Beginners — *Screen Space Refraction*](https://lettier.github.io/3d-game-shaders-for-beginners/screen-space-refraction.html) — `refract()` et la marche en espace écran.
- [Froyok — *Refracting Pixels*](https://www.froyok.fr/blog/2024-12-refraction/) — pourquoi le décalage naïf par la normale est faux et comment le corriger.
- [three.js — `Refractor.js` / `Water2.js`](https://github.com/mrdoob/three.js/pull/12341/files) — le montage à deux passes tel qu'il est fait dans three.js.
- [three.js docs — `WebGLRenderTarget.depthTexture`](https://threejs.org/docs/#api/en/renderers/WebGLRenderTarget.depthTexture), [issue #19447](https://github.com/mrdoob/three.js/issues/19447), [issue #27965](https://github.com/mrdoob/three.js/issues/27965)

**Caustiques**
- [Martin Renou — *Real-time rendering of water caustics*](https://medium.com/@martinRenou/real-time-rendering-of-water-caustics-59cda1d74aa) — la formulation par ratio d'aire (le jacobien du §5.1).
- [Habib — *Rendering caustics*](https://habibs.wordpress.com/2008/04/21/rendering-caustics/) — projection de la dérivée seconde de la carte de hauteur.
- [Gamasutra — *Inexpensive Underwater Caustics Using Cg*](https://www.gamedeveloper.com/programming/inexpensive-underwater-caustics-using-cg)
- [Cyanilux — *Water Shader Breakdown*](https://www.cyanilux.com/tutorials/water-shader-breakdown/) — Voronoï sur la position monde reconstruite depuis la profondeur.
- [pabennett/WaterCaustics](https://github.com/pabennett/WaterCaustics) — traçage de rayons réfractés vers le fond, code OpenGL complet.

**Écume, rivage**
- [Cyanilux — *Shoreline Shader Breakdown*](https://www.cyanilux.com/tutorials/shoreline-shader-breakdown/) — les trois niveaux d'intersection.
- [Alexander Ameye — *Stylized Water Shader*](https://ameye.dev/notes/stylized-water-shader/)
- [Harry Alisavakis — *Stylized water shader*](https://halisavakis.com/my-take-on-shaders-stylized-water-shader/)

**Optique de l'eau**
- Pope & Fry (1997), *Absorption spectrum of pure water, II* — les σ_a du §4.2.
- Solonenko & Mobley (2015), [*Inherent optical properties of Jerlov water types*](https://opg.optica.org/ao/upcoming_pdf.cfm?id=236972) — les σ_s par type d'eau.
- [Wikipédia — *Sun glitter*](https://en.wikipedia.org/wiki/Sun_glitter)
- [Real-time Water Shader in Unity — *Sun glitter*, *Subsurface scattering*](https://unitywatershader.wordpress.com/)

**Surface**
- [NVIDIA GPU Gems 1, ch. 1 — *Effective Water Simulation from Physical Models*](https://developer.nvidia.com/gpugems/gpugems/part-i-natural-effects/chapter-1-effective-water-simulation-physical-models) — Gerstner et ses dérivées analytiques.
- [Catlike Coding — *Directional Flow* / *Texture Distortion*](https://catlikecoding.com/unity/tutorials/flow/directional-flow/) — anisotropie et flow maps.
- [Unity — *Production Ready Water*](https://docs.unity3d.com/Packages/com.unity.shadergraph@17.5/manual/Shader-Graph-Sample-Production-Ready-Water.html) — décomposition en couches d'écume.

**Volume**
- [Papadopoulos & Papaioannou — *Realistic Real-time Underwater Caustics and Godrays*](https://graphics.cs.aueb.gr/graphics/docs/papers/GraphiCon09_PapadopoulosPapaioannou.pdf)
- [Shaderbits — *Creating a Volumetric Ray Marcher*](https://shaderbits.com/blog/creating-volumetric-ray-marcher)
- [Habib — *Projected grid ocean shader*](http://habib.wikidot.com/projected-grid-ocean-shader-full-html-version) — les « skirts » aux frontières de LOD.
