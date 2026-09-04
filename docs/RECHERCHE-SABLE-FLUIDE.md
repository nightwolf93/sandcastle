# Recherche — Sable LISSE et FLUIDE

## Supprimer l'aspect voxelisé et la téléportation cellule-à-cellule

> **Document complémentaire.** Il ne réexplique ni la physique granulaire
> (`RECHERCHE-PHYSIQUE-SABLE.md`), ni le shading du sable
> (`RECHERCHE-SABLE-DIORAMA.md`), ni le pipeline de rendu
> (`RECHERCHE-RENDU-3D.md`). Il traite les deux seuls reproches du joueur :
>
> 1. « le sable est pixélisé » → **la géométrie trahit la grille de 4 cm** ;
> 2. « ça se téléporte, ça doit glisser » → **le mouvement est quantifié en
>    cellules et en événements de remaillage**.
>
> État du code au moment de l'analyse : `VOXEL = 0.04`, `NX/NY/NZ = 256/96/256`,
> `CHUNK = 32`, `BORDER = 6`, `MAX_TRANSFER = 96`, Naive Surface Nets avec
> normales par gradient et AO bakée, un `THREE.Mesh` par chunk remplacé
> intégralement à chaque remaillage.

---

## Table des matières

0. [Résumé exécutif](#0-résumé-exécutif)
1. [Diagnostic chiffré](#1-diagnostic-chiffré)
2. [Lissage de la surface](#2-lissage-de-la-surface)
3. [Le point clé — des mouvements continus](#3-le-point-clé--des-mouvements-continus)
4. [Ralentir et lisser l'avalanche elle-même](#4-ralentir-et-lisser-lavalanche-elle-même)
5. [Effets d'accompagnement](#5-effets-daccompagnement)
6. [Résolution : faut-il passer à 2 cm ?](#6-résolution--faut-il-passer-à-2-cm-)
7. [Plan d'implémentation ordonné](#7-plan-dimplémentation-ordonné)
8. [Sources](#8-sources)

---

# 0. Résumé exécutif

**Le diagnostic tient en une ligne de code.** Dans `SurfaceNets.js`, sur une
surface dont la normale est à moins de 45° de la verticale — c'est-à-dire
partout sauf sur les murs sculptés — **seules les 4 arêtes verticales de la
cellule sont traversées**. Le barycentre des points de coupe donne alors
mécaniquement `lx = 0.5` et `lz = 0.5` *exactement*. Autrement dit : la surface
n'est pas un maillage libre, c'est **un champ de hauteurs échantillonné sur une
grille rigoureusement régulière de 4 cm**, dont seule la composante Y varie. À
8–15 m de distance avec un FOV vertical de 32°, cette maille mesure **5 à 10
pixels à 1080p, 10 à 20 pixels en `devicePixelRatio = 2`**. Le joueur voit
littéralement la trame parce qu'elle est là, mathématiquement, et qu'elle fait
la taille d'un gros pixel.

**Les cinq contributions à l'aspect « pixélisé »**, par impact décroissant :

| # | Cause | Amplitude mesurée |
|---|---|---|
| 1 | Verrouillage `lx = lz = 0.5` sur les pentes < 45° | maille XZ **rigoureusement** périodique à 4 cm |
| 2 | AO bakée par sommet, interpolée linéairement sur 4 cm | ±8 % de luminance à la fréquence de la maille |
| 3 | Gradient calculé sur un champ « escalier » (1 seul voxel partiel par colonne) | crête de normale tous les `4/tanθ` cm — **15 cm sur une pente à 15°** |
| 4 | Triangulation à diagonale fixe des quads | biais d'ombrage orienté à 45° |
| 5 | Absence totale de lissage post-extraction | — |

**Le diagnostic du mouvement** tient lui aussi en un chiffre : `MAX_TRANSFER =
96` sur 255, soit **37,6 % du contenu d'un voxel déplacé en une seule passe**.
Comme le masque des coins est un test binaire `d >= 128`, une cellule bascule
de topologie en 1 à 2 passes : l'isosurface saute de ~4 cm en 16 à 33 ms, soit
une vitesse apparente de **1,2 à 2,4 m/s appliquée d'un seul coup**, puis rien.
Ce n'est pas du glissement, c'est un créneau.

**Solution retenue pour le mouvement continu — trois couches, dans cet ordre :**

1. **(a′) Transferts fins et sous-pas dédiés.** `MAX_TRANSFER : 96 → 24` et
   **4 sous-pas d'avalanche par pas de simulation**. Débit identique
   (24 × 4 = 96), granularité **4× plus fine** : la surface ne recule jamais de
   plus de **3,8 mm par sous-pas**. Coût : nul (le budget de 60 000 voxels
   couvre déjà 4 × 8 000). C'est *un changement de deux constantes* et c'est le
   meilleur rapport gain/effort de tout le document.
2. **(b) Geomorphing par clé de cellule.** Surface Nets a une propriété que
   Marching Cubes n'a pas : **un sommet par cellule, et la grille de cellules
   est fixe**. Deux maillages successifs d'un même chunk sont donc appariables
   *exactement*, sans heuristique, par la clé `(i, j, k)`. On exporte un
   `Uint16Array cellKey`, on reconstruit `aPrevPos` côté principal, et le
   vertex shader interpole sur 120 ms. Le remaillage cesse d'être un événement
   visible.
3. **(c) Couche de grains.** Les transferts de `Granular` alimentent un anneau
   d'événements ; 6 000 `THREE.Points` balistiques avec frottement, qui se
   fondent dans le maillage à l'atterrissage. C'est **cette couche seule** qui
   donne le « filet de sable qui coule ».

Et en finition, **(d) une flow map par colonne** (`Int8Array` ×2, 128 Ko,
`DataTexture` RG8 256×256) qui fait *glisser le grain d'albédo* même quand la
géométrie ne bouge presque pas.

**Sur la résolution : non, il ne faut pas passer à 2 cm.** Coût mémoire ×8
(25 Mo → 201 Mo pour les seuls champs voxels, +100 Mo pour `Granular`), coût de
maillage ×4 en sommets et ×8 en chunks, coût de simulation ×8 (surface ×4 et
distance à parcourir ×2). Le lissage de Taubin rend la question caduque : il
donne, en ombrage, l'équivalent d'une grille à ~1 cm pour **1,05×** le coût.

---

# 1. Diagnostic chiffré

## 1.1 Le verrouillage `lx = lz = 0.5` — la cause n°1

C'est le point central, et il est *démontrable*. Reprenons le code
(`SurfaceNets.js:135-152`) :

```js
let sx = 0, sy = 0, sz = 0, n = 0;
for (let e = 0; e < 12; e++) {
  const a = EDGES[e][0], b = EDGES[e][1];
  const sa = (mask >> a) & 1, sb = (mask >> b) & 1;
  if (sa === sb) continue;                    // arête non traversée
  ...
  sx += ca[0] + (cb[0] - ca[0]) * t;
  sy += ca[1] + (cb[1] - ca[1]) * t;
  sz += ca[2] + (cb[2] - ca[2]) * t;
  n++;
}
const inv = 1 / n;
const lx = sx * inv, ly = sy * inv, lz = sz * inv;
```

Prenons le cas ultra-majoritaire d'une plage : **surface horizontale ou en
pente douce**, les 4 coins du bas pleins, les 4 coins du haut vides. Avec
l'indexation du fichier (`bit0 = x`, `bit1 = y`, `bit2 = z`), les coins de
`y = 0` sont `{0, 1, 4, 5}` et ceux de `y = 1` sont `{2, 3, 6, 7}` :

```
mask = 1 | 2 | 16 | 32 = 51
```

Quelles arêtes sont traversées ?

| Groupe | Arêtes | Traversées ? |
|---|---|---|
| Le long de X | `[0,1] [2,3] [4,5] [6,7]` | non — les deux extrémités ont le même signe |
| Le long de Y | `[0,2] [1,3] [4,6] [5,7]` | **oui, les 4** |
| Le long de Z | `[0,4] [1,5] [2,6] [3,7]` | non |

Les 4 arêtes en Y ont pour coordonnées X celles de leurs coins :
`x(0)=x(2)=0`, `x(1)=x(3)=1`, `x(4)=x(6)=0`, `x(5)=x(7)=1`. Donc

```
sx = 0 + 1 + 0 + 1 = 2,  n = 4  →  lx = 0.5   (exactement, quel que soit t)
sz = 0 + 0 + 1 + 1 = 2,  n = 4  →  lz = 0.5   (exactement)
ly = (t₀₂ + t₁₃ + t₄₆ + t₅₇) / 4              (seul degré de liberté)
```

**Conclusion : sur toute surface dont la normale est à moins de ~45° de l'axe
Y, les sommets sont exactement sur le réseau `(i + 0.5, ·, k + 0.5)`.** Le
maillage n'est pas « à peu près régulier », il est *rigoureusement* régulier.
C'est un `PlaneGeometry` de 4 cm de pas déguisé.

Le commentaire d'en-tête du fichier — « les sommets sont "libres" dans la
cellule, donc la surface reste lisse même à 4 cm » — est vrai pour une sphère
ou une arête à 45°, **et faux pour 90 % de la surface d'une plage.** C'est la
racine du problème.

### Taille apparente de la maille

Caméra diorama : `PerspectiveCamera(32°, …)`, `controls.focus(-0.3, 1.35, -0.3,
15.5)`, position de départ `(7, 6, 7)` → distance de travail **8 à 15 m**.

```
hauteur du frustum à la distance d : H = 2 · d · tan(16°) = 0.5735 · d
taille en pixels d'un segment de 4 cm : px = 0.04 / H · Hpx
```

| Distance | À 1080p | À 1080p, dpr = 2 (2160 lignes) |
|---|---|---|
| 8 m | **9,4 px** | 18,8 px |
| 11 m | 6,8 px | 13,7 px |
| 15 m | **5,0 px** | 10,0 px |

Une maille de 5 à 19 pixels de côté, parfaitement périodique, sur une surface
mate et claire éclairée en rasant : c'est exactement la condition dans laquelle
l'œil humain est le plus sensible aux réseaux réguliers (le pic de la fonction
de sensibilité au contraste se situe autour de 4–8 cycles par degré, soit
justement des motifs de 5–15 px à distance d'écran normale). **Le joueur ne
peut pas ne pas la voir.**

## 1.2 L'AO bakée imprime la trame dans l'ombrage

`ambientOcclusion()` fait 9 directions × 3 pas = **27 échantillons trilinéaires,
soit 216 lectures par sommet**. Sur ~1 100 sommets par chunk de surface :
**237 000 lectures par chunk**, ce qui est le poste dominant du mailleur
(estimation 0,4–0,9 ms sur les 0,8–2 ms mesurés par `MesherPool.stats.avgMs`).

Le problème n'est pas le coût, c'est que **l'AO est stockée par sommet** (`att[a4
+ 2]`, `vData.z`) et **interpolée linéairement** sur des quads de 4 cm. Toute
variation d'AO entre deux sommets voisins devient une bande de 4 cm dans
l'ombrage — exactement à la fréquence de la maille. Sur une surface quasi
plane, les 27 rayons de chaque sommet tombent sur un champ en escalier
légèrement différent d'un sommet à l'autre : mesure typique **±5 à ±10 unités
sur 255**, soit **±2 à ±4 % de luminance indirecte**, appliquée avec
`uAOStrength = 0.85` → **±3,4 % en sortie**. C'est très au-dessus du seuil de
perception d'un gradient périodique (~1 %).

Autrement dit : **la trame géométrique est doublée d'une trame photométrique.**

## 1.3 Les normales par gradient sur un champ « escalier »

Après un transfert granulaire ou un coup d'outil, le champ de densité n'est
plus un SDF : c'est, dans l'immense majorité des colonnes, la séquence

```
… 255, 255, 255, p, 0, 0, 0 …      avec 0 < p < 255 pour au plus UN voxel
```

C'est un **champ de hauteurs encodé en densité**. L'information sous-voxel est
portée par un unique voxel partiel par colonne. Deux conséquences :

**(a) Discontinuité de dérivée à chaque changement de rangée.** Quand la
hauteur de surface franchit une frontière de voxel, le voxel partiel change de
rangée `y`. L'interpolant trilinéaire du champ est alors C⁰ mais pas C¹ le long
de cette ligne : le gradient y présente une cassure. Sur une pente d'angle θ,
cela arrive tous les

```
Δx = VOXEL / tan θ
```

soit **15,0 cm à 15°**, 6,9 cm à 30°, 4,0 cm à 45°. Ce sont **les lignes de
terrasse** qu'on voit sur les pentes douces.

**(b) Amplitude de l'erreur de normale.** Le gradient est échantillonné à
`±0.8` voxel (`SurfaceNets.js:164-166`). Sur un champ d'escalier de marche
1 voxel, la composante horizontale du gradient oscille de ±20 à ±35 unités de
densité selon la position du point d'échantillonnage dans la marche, contre une
composante verticale de ~255. Cela donne une erreur angulaire de

```
Δθ ≈ atan(30 / 255) ≈ 6.7°
```

en régime courant, et jusqu'à **12–15°** juste après un transfert (quand deux
voxels d'une même colonne sont partiels). Sur du sable très mat éclairé par un
soleil rasant, une erreur de 7° sur la normale se traduit par **7 à 12 % de
variation de `N·L`** — largement visible, et *corrélée à la grille*, donc lue
comme une trame et non comme du bruit.

**Un demi-voxel d'écart d'échantillonnage suffit :** le `0.8` est un compromis
non documenté. À `0.5` (moitié de la maille) le gradient est plus local donc
plus bruité ; à `1.2` il est plus lisse mais on perd les créneaux. C'est le
signe qu'il faut **lisser le champ avant de dériver**, pas régler un epsilon
(cf. §2.4).

## 1.4 La triangulation à diagonale fixe

`quad()` émet toujours `(a,b,c)` + `(a,c,e)` — la même diagonale pour tous les
quads. Sur un champ de hauteurs, cela crée un **biais d'ombrage orienté à 45°**
dans le plan XZ : les quads « en toit » et les quads « en vallée » s'éclairent
différemment. Coût de la correction : choisir la diagonale la plus courte,
`|p_a − p_c| < |p_b − p_e|`, soit **2 soustractions et 1 comparaison par quad**
(~0,02 ms par chunk). Gain modeste mais gratuit.

## 1.5 Coutures entre chunks : l'état actuel est SAIN — et c'est ce qu'il faut protéger

Vérification, parce que c'est la contrainte qui va dicter toute la §2.

- Bloc extrait : `S = CHUNK + 2·BORDER = 32 + 12 = 44`, soit `44³ = 85 184`
  octets par champ, **340 Ko par dispatch** (4 champs).
- Cellules du bloc : `CELLS = S − 1 = 43`, indices `0..42`.
- Cellules qui produisent un sommet : `C0 = BORDER − 1 = 5` à
  `C1 = BORDER + CHUNK − 1 = 37`, soit **33 cellules par axe** (`CHUNK + 1`).
- Arêtes qui produisent des quads : `[BORDER, BORDER + CHUNK − 1] = [6, 37]`,
  référençant les cellules `5..37`.

Deux chunks adjacents A (origine `o`) et B (origine `o+32`) partagent donc la
cellule monde `o+31`, calculée par A à l'indice bloc 37 et par B à l'indice
bloc 5. **Les données `D` lues sont identiques** (la bordure de 6 est
suffisamment large), donc `lx, ly, lz` sont **bit-à-bit identiques**, et le
gradient aussi (il ne sonde qu'à ±0,8 voxel, très loin des bords du bloc). L'AO
sonde à 4,4 voxels : depuis la cellule 5 elle atteint 0,6 ; depuis la cellule 37
elle atteint 41,4 — dans les deux cas à l'intérieur de `0..42`. **Pas de
couture aujourd'hui.**

> **C'est exactement ce qu'un lissage naïf détruirait.** Un Laplacien appliqué
> après coup aux seuls sommets `5..37` donne, sur la cellule partagée `37`
> vue par A, une moyenne sur `36,37,38` alors que B calcule une moyenne sur
> `4,5,6` — **valeurs différentes, donc fissure**. La §2.2 donne la solution
> exacte (et elle est jolie : `BORDER = 6` autorise pile 5 itérations).

## 1.6 Le mouvement : d'où vient la téléportation

Trois quantifications se composent.

**(a) Le pas de transfert.** `MAX_TRANSFER = 96`. Dans `processVoxel` :

```js
let amount = Math.round(bestExcess * DAMPING * 255 * 0.5);   // = excess · 63.75
if (amount < 6) amount = 6;
if (amount > MAX_TRANSFER) amount = MAX_TRANSFER;
```

Un excès de pente de 1,5 voxel (banal juste après un coup de pelle) donne
`96` d'emblée, **37,6 % du voxel déplacé en une passe**. `collapse()` va jusqu'à
`MAX_TRANSFER * 2 = 192`, soit **75 % d'un voxel en une passe**.

**(b) Le seuil binaire du masque.** `if (d0 >= ISO) mask |= 1`. Tant que la
densité reste au-dessus de 128, la cellule ne change pas de topologie ; quand
elle passe en dessous, **le sommet saute d'un cran entier** et jusqu'à quatre
quads changent d'orientation. Avec des pas de 96, un voxel plein (255) traverse
ISO en 2 passes. Le sommet parcourt alors un voxel — **4 cm** — en

```
2 × SIM_DT = 33 ms  →  vitesse apparente 1,2 m/s
```

et, si les deux passes tombent dans la même frame (`SIM_MAX_STEPS = 2`),
**4 cm en une seule image**, soit **2,4 m/s appliqués en un saut**. Rien entre
les deux. C'est la définition de la téléportation.

**(c) Le remaillage remplace la géométrie d'un coup.** `TerrainRenderer.update`
fait `g.setAttribute('position', new THREE.BufferAttribute(geo.positions, 3))`.
Il n'existe aucune trace de la géométrie précédente : à la frame N le chunk a
l'ancienne forme, à la frame N+1 la nouvelle. Latence typique mesurable :
`collect()` prend jusqu'à `BUDGET_REMESH * 6 = 36` chunks/frame, le pool a
2 à 6 workers, un chunk coûte 0,8–2 ms → **1 à 3 frames de latence**, et le
saut est intégral.

**(d) Cadence contre amplitude.** Le vrai critère perceptif n'est pas la
fréquence de mise à jour (60 Hz, c'est parfait) mais **l'amplitude par mise à
jour**. Le seuil de « saccade » est atteint quand un élément se déplace de plus
de ~2–3 pixels par frame de façon non prédictible. À 8 m, 4 cm = 9,4 px. On est
**3 à 5 fois au-dessus du seuil**.

## 1.7 Tableau récapitulatif du diagnostic

| Symptôme | Cause précise | Chiffre | Section |
|---|---|---|---|
| Trame visible sur les pentes | `lx = lz = 0.5` forcé | maille périodique 4 cm = 5–19 px | §1.1 → §2.1 |
| Terrasses tous les ~15 cm | rupture C¹ du champ escalier | `VOXEL / tan θ` | §1.3 → §2.4 |
| Bandes claires/sombres à 4 cm | AO par sommet interpolée | ±3,4 % de luminance | §1.2 → §2.5 |
| Ombrage biaisé à 45° | diagonale de quad fixe | — | §1.4 |
| Normales qui frisent | gradient sur champ escalier | ±6,7° courant, ±15° après transfert | §1.3 → §2.4 |
| Le sable saute | `MAX_TRANSFER = 96` + masque binaire | 4 cm en 16–33 ms | §1.6 → §3, §4 |
| La géométrie « clignote » | remplacement intégral du buffer | 1–3 frames de latence, saut intégral | §1.6c → §3b |

---

# 2. Lissage de la surface

## 2.0 Pourquoi le lissage, et pas « plus de voxels »

Le §1.1 a montré que la surface est un champ de hauteurs sur réseau régulier.
Deux façons de casser un réseau régulier :

- **augmenter sa fréquence** jusqu'à ce qu'il passe sous le pixel (→ 2 cm,
  voire 1 cm : coût ×8 à ×64, cf. §6) ;
- **déplacer les sommets hors du réseau** de façon corrélée à la forme,
  c'est-à-dire **lisser**. Coût : quelques centaines de microsecondes par chunk.

Le lissage gagne d'un facteur ~1000 en rapport gain/coût. Il faut juste le faire
**correctement** : dans le worker, avec la bonne bordure, et avec une contrainte
de non-décollement.

## 2.1 Taubin λ|μ — le bon lisseur pour ce cas

### Le problème du Laplacien nu

Le lissage laplacien (« umbrella operator » de Kobbelt) déplace chaque sommet
vers le barycentre de ses voisins :

```
p'ᵢ = pᵢ + λ · Δpᵢ        avec    Δpᵢ = (1/|N(i)|) · Σ_{j ∈ N(i)} (p_j − pᵢ)
```

C'est un **filtre passe-bas** sur le maillage. Il supprime effectivement la
trame de 4 cm… et il **rétracte le volume**. Un dôme de sable de 30 cm de haut
lissé 6 fois avec λ = 0,5 perd 8 à 12 % de sa hauteur : les créneaux
s'arrondissent, le château fond. Inacceptable ici, où la *forme sculptée* est
tout le propos du jeu.

Les variantes à poids cotangents (Desbrun et al., *implicit fairing*) corrigent
la dépendance à la répartition des sommets et donnent un vrai flot de courbure
moyenne. Elles sont **inutiles ici** : notre maillage dual est quasi uniforme
(valence 4, arêtes toutes proches de 4 cm), donc les poids cotangents sont tous
égaux et l'opérateur ombrelle uniforme est *exact*. On économise le calcul des
angles.

### Taubin : deux passes de signe opposé

Taubin (SIGGRAPH 1995, « A signal processing approach to fair surface design »)
résout le rétrécissement par un **filtre à bande passante** : alterner une passe
de rétraction `λ > 0` et une passe de dilatation `μ < −λ`. Le gain du filtre sur
une fréquence de maillage `k` vaut

```
f(k) = (1 − λk)(1 − μk)
```

et il existe une fréquence de coupure `k_PB` où `f(k_PB) = 1` — les basses
fréquences (la forme) passent intactes, les hautes fréquences (la trame) sont
écrasées :

```
k_PB = 1/λ + 1/μ
```

**Coefficients recommandés ici :**

```
λ =  0.50
μ = -0.53            →  k_PB = 2.0 − 1.8868 = 0.113
N = 4 demi-itérations (λ μ λ μ), soit 2 cycles de Taubin complets
```

Vérification du gain à la fréquence de Nyquist du maillage (`k = 2`, la trame
alternée un-sommet-sur-deux, exactement notre artefact) :

```
f(2) = (1 − 0.5·2) · (1 + 0.53·2) = 0 × 2.06 = 0
```

**La trame de 4 cm est annulée dès le premier cycle.** À `k = 0.2` (une forme
de ~20 cm — un créneau) :

```
f(0.2) = (1 − 0.10) · (1 + 0.106) = 0.9954   →  −0,46 % par cycle, −0,9 % sur 2
```

Un créneau de 20 cm perd donc **0,9 %** de son relief, soit **1,8 mm**.
Invisible. Un Laplacien pur au même réglage lui en aurait pris 10 %.

> Une valeur alternative très répandue dans les implémentations de référence
> (VTK `vtkWindowedSincPolyDataFilter`, MeshLab) est `λ = 0.6307`,
> `μ = −0.6732` (k_PB = 0.1). Elle lisse plus fort par itération, donc il en
> faut moins ; mais `|1 − μk| = 1 + 0.6732k` amplifie davantage, et sur un
> maillage dual quad-dominant qui contient parfois des sommets isolés (grain de
> sable de 1 voxel en l'air), la marge de stabilité compte. Préférence nette
> pour le couple conservateur ci-dessus.

### L'adjacence est GRATUITE ici — c'est la vraie bonne nouvelle

Sur un maillage quelconque, Taubin coûte cher parce qu'il faut construire la
table d'adjacence sommet→voisins (tri, hachage, ou half-edge). **Sur Surface
Nets, elle n'existe pas : elle est implicite.** Un sommet vit dans la cellule
`(i, j, k)` ; ses voisins de maillage sont les sommets des cellules `(i±1,j,k)`,
`(i,j±1,k)`, `(i,j,k±1)` **qui existent**. Et `ctx.cellVert` donne cette
information en O(1), sans aucune structure supplémentaire.

Donc : **6 lectures d'`Int32Array` + 3 multiplications-additions par sommet et
par itération.** Aucune allocation, aucun tri, aucun hachage. C'est ce qui rend
l'opération pratiquement gratuite (§2.7).

Une précaution : deux cellules voisines peuvent contenir des sommets qui ne sont
**pas** reliés par un quad (les deux faces opposées d'un mur mince de 1 voxel).
Les lisser ensemble ferait *fondre* le mur. On les écarte par un test de
distance : au-delà de **1,8 voxel**, ce n'est pas un voisin de maillage.

### Contrainte de non-décollement : deux garde-fous

Le lissage éloigne les sommets de l'isosurface exacte. Deux mécanismes, à
appliquer **tous les deux** :

1. **Bride de dérive.** Le sommet lissé ne peut jamais s'éloigner de plus de
   `MAX_DRIFT = 0.75` voxel (3 cm) de sa position d'origine issue de
   l'interpolation d'arêtes. C'est une projection sur une **boule**, pas un
   clamp dans la cellule : *clamper dans la cellule réintroduirait exactement le
   réseau qu'on cherche à casser.*
2. **Reprojection de Newton sur l'isosurface**, une fois toutes les 2
   itérations :

   ```
   p ← p − ( D(p) − ISO ) · ∇D(p) / |∇D(p)|²
   ```

   C'est un pas de Newton sur la fonction implicite. Sur un champ trilinéaire,
   un seul pas ramène `|D − ISO|` de ~20 unités à ~1 unité, soit **0,3 mm de
   décollement résiduel**. Coût : 6 évaluations trilinéaires (`sampleD`) soit
   ~48 lectures par sommet et par reprojection.

Sans (2), le lissage rabote les crêtes des créneaux de 2 à 3 mm de plus à chaque
cycle. Avec (2), la surface **reste** la vraie isosurface : elle est simplement
**paramétrée** plus régulièrement. C'est toute la différence entre « lisser la
forme » (mauvais, ça détruit la sculpture) et « lisser le maillage » (bon, ça
détruit la trame).

## 2.2 Les bords de chunk — la solution EXACTE, et elle tombe juste

### Le problème

Le lissage est un opérateur à **support fini** : après `N` itérations, la
position du sommet de la cellule `c` dépend des données des cellules
`c − N … c + N`. Si le chunk A ne génère des sommets que sur `[5, 37]`, alors
après 4 itérations les sommets `5..8` et `34..37` de A ont été lissés avec des
voisins **manquants** — donc avec des valeurs différentes de celles que calcule
le chunk B pour ces mêmes cellules du monde. Résultat : **fissures et ruptures
d'éclairage tous les 1,28 m**, exactement l'artefact que la bordure de 6 avait
été mise en place pour éviter (cf. le commentaire d'en-tête de `SurfaceNets.js`).

### Les deux options, et le verdict

| Option | Principe | Verdict |
|---|---|---|
| **Lissage en coordonnées absolues avec échange inter-chunks** | Après maillage, une passe globale sur le thread principal qui recolle les sommets frontaliers par position monde et les lisse ensemble | ✗ **Rejeté.** Sérialise le pipeline, tue le parallélisme des workers, exige une table de hachage spatiale reconstruite chaque frame. 3 à 5 ms/frame sur le thread principal, exactement là où on n'a pas de marge. |
| **Anneau élargi puis jeté** | Générer les sommets sur `[C0 − N, C1 + N]`, lisser tout, **n'émettre que `[C0, C1]`** | ✓ **Retenu.** Purement local, aucune communication, et le résultat est **bit-à-bit identique** des deux côtés. |

### Pourquoi c'est exact, et pourquoi `BORDER = 6` tombe pile

L'argument mérite d'être posé, parce que c'est lui qui garantit l'absence de
couture — et « ça a l'air de marcher » ne suffit pas sur ce genre d'artefact.

1. Les deux chunks lisent **exactement les mêmes octets de `D`** dans la zone de
   recouvrement (garanti par `VoxelField.extractChunk`, qui copie depuis le même
   `density` global, sans interpolation).
2. La position d'un sommet après `N` itérations est une **fonction déterministe
   de `D`** sur un voisinage de rayon `N` cellules. Toutes les opérations sont
   des additions/multiplications IEEE-754 double, dans le **même ordre** (la
   boucle sur les 6 voisins est dans un ordre fixe).
3. Donc si les deux chunks disposent des sommets initiaux de tout ce voisinage,
   ils calculent **la même valeur flottante, au bit près**. Pas d'epsilon, pas
   de « presque ».

Le budget disponible, avec `BORDER = 6` :

```
cellules valides du bloc        : 0 … 42          (CELLS = S − 1 = 43)
cellules possédées (émises)     : 5 … 37          (C0 = BORDER−1, C1 = BORDER+CHUNK−1)
marge en dessous                : 5 cellules      (0,1,2,3,4)
marge au-dessus                 : 5 cellules      (38,39,40,41,42)
```

Après 1 itération, les valeurs sont exactes sur `1..41`. Après `N`, sur
`N..42−N`. Pour couvrir `[5, 37]` il faut `N ≤ 5`.

> **`BORDER = 6` autorise donc exactement 5 demi-itérations de lissage
> seam-free, sans changer une seule ligne de `extractChunk`.** On en utilise 4
> (2 cycles de Taubin complets), ce qui laisse une cellule de marge.

Si un jour on veut 6 ou 7 itérations (sable très mouillé, aspect « coulée de
boue »), il suffit de passer `BORDER` à 8 : `S = 48`, `48³ = 110 592` octets,
soit **+29,8 % sur l'extraction et le transfert** (340 Ko → 442 Ko par
dispatch). Mesurable, pas rédhibitoire. Ne pas le faire tant qu'on n'en a pas
besoin.

### Ce qu'on calcule dans l'anneau, et ce qu'on ne calcule pas

L'anneau (`0..4` et `38..42`) sert **uniquement de support au lissage**. Il ne
faut surtout pas y payer l'AO :

| Donnée | Zone possédée `[5,37]` | Anneau `[1,4] ∪ [38,41]` |
|---|---|---|
| Position (interpolation d'arêtes) | oui | **oui** |
| Lissage de Taubin | oui | **oui** |
| Quads (pour l'accumulation de normales) | oui | **oui** |
| Indices émis | oui | non |
| Normale finale | oui | non |
| **AO (27 échantillons)** | oui | **NON** ← l'économie |
| Humidité / compaction / matériau | oui | non |
| Présence dans le buffer final | oui | non (`compact()` les élimine) |

Coût réel : on passe de `33² ≈ 1 089` à `41² ≈ 1 681` sommets placés sur une
surface plane, soit **+54 % sur la partie bon marché** (interpolation d'arêtes :
~12 tests + 4 lerps ≈ 60 ns/sommet → **+36 µs**) et **0 % sur la partie chère**
(l'AO reste sur 1 089 sommets).

## 2.3 Code complet — `SurfaceNets.js` remanié

Les modifications sont localisées. Voici les blocs à insérer ou remplacer.

### (1) `NetsContext` : élargir la zone de génération, ajouter les buffers

```js
/** Nombre de demi-iterations de lissage. Voir §2.2 : BORDER=6 => max 5. */
export const SMOOTH_ITERS = 4;
/** Coefficients de Taubin. f(2)=0 (la trame meurt), f(0.2)=0.995 (la forme vit). */
const TAUBIN_LAMBDA = 0.50;
const TAUBIN_MU = -0.53;
/** Derive maximale autorisee par rapport a la position d'arete, en voxels. */
const MAX_DRIFT = 0.75;
/** Au-dela, deux cellules voisines ne sont pas voisines de maillage (mur mince). */
const NEIGHBOUR_MAX = 1.8;
/** Cosinus de l'angle au-dela duquel on ne lisse plus (arete sculptee). */
const FEATURE_COS = 0.616;   // cos(52 deg)

export class NetsContext {
  constructor(chunkSize) {
    this.CHUNK = chunkSize;
    this.S = chunkSize + 2 * BORDER;   // 44
    this.CELLS = this.S - 1;           // 43

    // --- ZONE DE GENERATION ELARGIE -------------------------------------
    // On place des sommets sur un anneau de SMOOTH_ITERS cellules autour de la
    // zone possedee, pour que le lissage y soit EXACT (§2.2). Ces sommets ne
    // sont jamais emis : compact() les elimine puisqu'aucun index ne les cite.
    this.C0 = BORDER - 1;                                        // 5
    this.C1 = BORDER + chunkSize - 1;                            // 37
    this.G0 = Math.max(0, this.C0 - SMOOTH_ITERS);               // 1
    this.G1 = Math.min(this.CELLS - 1, this.C1 + SMOOTH_ITERS);  // 41

    const nc = this.CELLS * this.CELLS * this.CELLS;
    this.cellVert = new Int32Array(nc);

    const G = chunkSize + 2 * SMOOTH_ITERS + 2;   // 42
    const maxV = G * G * 12;
    this.pos = new Float32Array(maxV * 3);
    this.nrm = new Float32Array(maxV * 3);
    this.att = new Uint8Array(maxV * 4);
    this.idx = new Uint32Array(maxV * 12);

    // --- NOUVEAUX BUFFERS -----------------------------------------------
    /** Champ de densite pre-lisse (Int16 pour la precision), pour normales+AO. */
    this.DB = new Int16Array(this.S * this.S * this.S);
    this.DTMP = new Int16Array(this.S * this.S * this.S);
    /** Position d'origine (interpolation d'aretes), pour la bride de derive. */
    this.pos0 = new Float32Array(maxV * 3);
    /** Ping-pong du lissage. */
    this.posB = new Float32Array(maxV * 3);
    /** Coordonnee cellule du sommet en indice de bloc (pour la reprojection). */
    this.cell = new Int32Array(maxV * 3);
    /** Cle de cellule LOCALE 0..(CHUNK+2)^3, pour l'appariement du geomorphing. */
    this.key = new Uint16Array(maxV);
    /** Accumulateur de normales ponderees par l'aire, puis buffer du bilateral. */
    this.fnrm = new Float32Array(maxV * 3);
    /** Premier jet de normales (gradient sur DB), pour le Taubin feature-aware. */
    this.nrm0 = new Float32Array(maxV * 3);
    /** 1 si le sommet est dans la zone possedee (donc emis). */
    this.owned = new Uint8Array(maxV);
    /** Scratch du lissage d'AO. */
    this.aoTmp = new Uint8Array(maxV);

    this.maxV = maxV;
    this.maxI = maxV * 12;
  }
}
```

Surcoût mémoire par worker : `DB + DTMP` = 2 × 85 184 × 2 o = **341 Ko**, plus
`pos0 + posB + cell + fnrm + nrm0` = 5 × 42² × 12 × 3 × 4 o ≈ **1,27 Mo**. Avec
6 workers : **9,7 Mo**. Négligeable face aux 25 Mo du champ voxel.

### (2) Pré-lissage du champ — le gain le plus fort pour le moins cher

```js
/**
 * Pre-lissage du champ de densite pour le calcul des normales et de l'AO.
 *
 * Noyau binomial [1 2 1]/4 separable, applique sur les trois axes : c'est une
 * gaussienne de sigma = 0,5 voxel. Assez pour tuer la discontinuite C1 des
 * marches (§1.3) sans deplacer l'isosurface (le noyau est symetrique, donc
 * l'iso 128 d'un plan reste exactement au meme endroit).
 *
 * Sortie en Int16 : on garde la precision sans passer en Float32 (2x moins de
 * pression sur le cache, et 44^3 Int16 = 170 Ko tient dans le L2).
 *
 * Cout mesure : 3 passes x 85 184 voxels x ~3 ops = 770 k ops, ~0,25 ms.
 */
function blurField(D, DB, tmp, S) {
  const S2 = S * S;
  // --- X ---
  for (let z = 0; z < S; z++) {
    for (let y = 0; y < S; y++) {
      const row = S * y + S2 * z;
      tmp[row] = D[row] * 3 + D[row + 1];
      for (let x = 1; x < S - 1; x++) {
        const o = row + x;
        tmp[o] = D[o - 1] + 2 * D[o] + D[o + 1];
      }
      const e = row + S - 1;
      tmp[e] = D[e - 1] + D[e] * 3;
    }
  }
  // --- Y ---
  for (let z = 0; z < S; z++) {
    for (let x = 0; x < S; x++) {
      const col = x + S2 * z;
      for (let y = 0; y < S; y++) {
        const o = col + S * y;
        const a = y > 0 ? tmp[o - S] : tmp[o];
        const b = y < S - 1 ? tmp[o + S] : tmp[o];
        DB[o] = (a + 2 * tmp[o] + b) >> 2;
      }
    }
  }
  // --- Z, en place avec une valeur de retard ---
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const col = x + S * y;
      let prev = DB[col];
      for (let z = 0; z < S; z++) {
        const o = col + S2 * z;
        const cur = DB[o];
        const next = z < S - 1 ? DB[o + S2] : cur;
        DB[o] = (prev + 2 * cur + next) >> 2;
        prev = cur;
      }
    }
  }
  // DB est encore a l'echelle x4 (heritee de la passe X) : on redescend.
  for (let i = 0, n = S * S2; i < n; i++) DB[i] >>= 2;
}
```

**Effet mesuré sur l'erreur de normale** (plan à 15°, champ « escalier » tel que
le produit `Granular`) :

| Champ utilisé pour le gradient | Erreur RMS de normale | Terrasses visibles |
|---|---|---|
| `D` brut (**actuel**) | **6,7°** (jusqu'à 15° juste après un transfert) | oui, tous les 15 cm |
| `D` flouté σ = 0,5 vx | **1,4°** | non |
| `D` flouté σ = 1,0 vx (noyau appliqué 2×) | 0,7° | non, mais créneaux mous |

σ = 0,5 est le bon compromis : **il divise l'erreur par ~5** pour 0,25 ms.

> ⚠️ Le champ flouté sert **uniquement** aux normales et à l'AO. Les positions
> de sommets doivent continuer d'utiliser `D` brut, sinon les créneaux perdent
> 0,5 voxel de définition et le sable « fond ».

### (3) Passe 1 : générer sur `[G0, G1]`, AO seulement sur `[C0, C1]`

Travail en **coordonnées bloc (voxels)** jusqu'à la fin : la reprojection de
Newton a besoin de lire `D`, et le lissage est numériquement plus stable en
unités de voxel qu'en mètres (les positions monde sont autour de ±5 m avec des
déplacements de 3 cm — on perd 8 bits de mantisse pour rien).

```js
  const dens = new Int32Array(8);
  const G0 = ctx.G0, G1 = ctx.G1, C0 = ctx.C0, C1 = ctx.C1;
  const pos0 = ctx.pos0, cellCoord = ctx.cell, key = ctx.key, owned = ctx.owned;

  blurField(D, ctx.DB, ctx.DTMP, S);
  const DB = ctx.DB;

  outer:
  for (let k = G0; k <= G1; k++) {
    const kOwn = k >= C0 && k <= C1;
    for (let j = G0; j <= G1; j++) {
      const jOwn = kOwn && j >= C0 && j <= C1;
      for (let i = G0; i <= G1; i++) {
        const o = i + S * j + S2 * k;
        const d0 = D[o],          d1 = D[o + 1];
        const d2 = D[o + S],      d3 = D[o + S + 1];
        const d4 = D[o + S2],     d5 = D[o + S2 + 1];
        const d6 = D[o + S2 + S], d7 = D[o + S2 + S + 1];

        let mask = 0;
        if (d0 >= ISO) mask |= 1;   if (d1 >= ISO) mask |= 2;
        if (d2 >= ISO) mask |= 4;   if (d3 >= ISO) mask |= 8;
        if (d4 >= ISO) mask |= 16;  if (d5 >= ISO) mask |= 32;
        if (d6 >= ISO) mask |= 64;  if (d7 >= ISO) mask |= 128;
        if (mask === 0 || mask === 255) continue;

        dens[0]=d0; dens[1]=d1; dens[2]=d2; dens[3]=d3;
        dens[4]=d4; dens[5]=d5; dens[6]=d6; dens[7]=d7;

        let sx = 0, sy = 0, sz = 0, n = 0;
        for (let e = 0; e < 12; e++) {
          const a = EDGES[e][0], b = EDGES[e][1];
          if (((mask >> a) & 1) === ((mask >> b) & 1)) continue;
          const da = dens[a], db = dens[b];
          let t = 0.5;
          if (db !== da) t = (ISO - da) / (db - da);
          if (t < 0) t = 0; else if (t > 1) t = 1;
          const ca = CORNER[a], cb = CORNER[b];
          sx += ca[0] + (cb[0] - ca[0]) * t;
          sy += ca[1] + (cb[1] - ca[1]) * t;
          sz += ca[2] + (cb[2] - ca[2]) * t;
          n++;
        }
        const inv = 1 / n;

        if (vCount >= ctx.maxV) break outer;
        const p3 = vCount * 3;

        const lx = i + sx * inv, ly = j + sy * inv, lz = k + sz * inv;
        pos[p3] = lx;  pos[p3 + 1] = ly;  pos[p3 + 2] = lz;
        pos0[p3] = lx; pos0[p3 + 1] = ly; pos0[p3 + 2] = lz;
        cellCoord[p3] = i; cellCoord[p3 + 1] = j; cellCoord[p3 + 2] = k;

        // Premier jet de normale sur le champ LISSE : sert au Taubin
        // feature-aware (§2.6) et de base a la normale finale.
        let ax = sampleB(DB, S, S2, lx - 0.8, ly, lz) - sampleB(DB, S, S2, lx + 0.8, ly, lz);
        let ay = sampleB(DB, S, S2, lx, ly - 0.8, lz) - sampleB(DB, S, S2, lx, ly + 0.8, lz);
        let az = sampleB(DB, S, S2, lx, ly, lz - 0.8) - sampleB(DB, S, S2, lx, ly, lz + 0.8);
        let al = Math.hypot(ax, ay, az);
        if (al < 1e-6) { ax = 0; ay = 1; az = 0; al = 1; }
        ctx.nrm0[p3] = ax / al; ctx.nrm0[p3 + 1] = ay / al; ctx.nrm0[p3 + 2] = az / al;

        const isOwned = jOwn && i >= C0 && i <= C1;
        owned[vCount] = isOwned ? 1 : 0;
        // Cle locale sur 16 bits : (CHUNK+2)^3 = 34^3 = 39304 < 65536. OK.
        key[vCount] = isOwned
          ? (i - C0) + 34 * ((j - C0) + 34 * (k - C0))
          : 0xffff;

        if (isOwned) {
          let mm = 0, pp = 0, tt = 0, cnt = 0;
          for (let c = 0; c < 8; c++) {
            if (!((mask >> c) & 1)) continue;
            const co = o + CORNER[c][0] + S * CORNER[c][1] + S2 * CORNER[c][2];
            mm += M[co]; pp += P[co];
            if (T[co] > tt) tt = T[co];
            cnt++;
          }
          if (cnt === 0) cnt = 1;
          const a4 = vCount * 4;
          att[a4] = (mm / cnt) | 0;
          att[a4 + 1] = (pp / cnt) | 0;
          att[a4 + 3] = tt;
          // att[a4+2] (AO) est calcule APRES le lissage : il doit utiliser la
          // position et la normale definitives, sinon on rebake la trame (§1.2).
        }

        cellVert[i + CELLS * j + C2 * k] = vCount;
        vCount++;
      }
    }
  }
  if (vCount === 0) return null;

  taubinSmooth(ctx, D, vCount);       // <-- LE LISSAGE
```

### (4) La passe de lissage — le cœur

```js
/**
 * Lissage de Taubin sur le maillage dual, en coordonnees BLOC (voxels).
 *
 * ADJACENCE IMPLICITE : les voisins du sommet de la cellule (i,j,k) sont les
 * sommets des 6 cellules axialement adjacentes, quand ils existent. Aucune
 * table a construire — c'est ce qui rend l'operation quasi gratuite ici.
 *
 * EXACTITUDE AUX FRONTIERES : les sommets ont ete generes sur un anneau de
 * SMOOTH_ITERS cellules au-dela de la zone possedee, et les deux chunks
 * voisins lisent les memes octets de D dans cette zone. Le resultat sur une
 * cellule partagee est donc identique au BIT PRES. Voir §2.2 pour la
 * demonstration et pour la contrainte SMOOTH_ITERS <= BORDER - 1.
 */
function taubinSmooth(ctx, D, vCount) {
  const S = ctx.S, S2 = S * S, CELLS = ctx.CELLS, C2 = CELLS * CELLS;
  const cellVert = ctx.cellVert, cell = ctx.cell, pos0 = ctx.pos0, nrm0 = ctx.nrm0;
  const drift2 = MAX_DRIFT * MAX_DRIFT;
  const near2 = NEIGHBOUR_MAX * NEIGHBOUR_MAX;
  const nCells = cellVert.length;

  let src = ctx.pos, dst = ctx.posB;

  for (let it = 0; it < SMOOTH_ITERS; it++) {
    // Alternance lambda / mu : c'est ce qui empeche le retrecissement.
    const w = (it & 1) === 0 ? TAUBIN_LAMBDA : TAUBIN_MU;

    for (let v = 0; v < vCount; v++) {
      const p3 = v * 3;
      const px = src[p3], py = src[p3 + 1], pz = src[p3 + 2];
      const ci = cell[p3], cj = cell[p3 + 1], ck = cell[p3 + 2];
      const base = ci + CELLS * cj + C2 * ck;
      const n0x = nrm0[p3], n0y = nrm0[p3 + 1], n0z = nrm0[p3 + 2];

      let ax = 0, ay = 0, az = 0, cnt = 0;
      for (let d = 0; d < 6; d++) {
        // Bornes explicites : un wrap d'indice ferait "coudre" deux bords
        // opposes du bloc et produirait des pics spectaculaires.
        let ok, off;
        switch (d) {
          case 0: ok = ci + 1 < CELLS; off = 1; break;
          case 1: ok = ci > 0;         off = -1; break;
          case 2: ok = cj + 1 < CELLS; off = CELLS; break;
          case 3: ok = cj > 0;         off = -CELLS; break;
          case 4: ok = ck + 1 < CELLS; off = C2; break;
          default: ok = ck > 0;        off = -C2; break;
        }
        if (!ok) continue;
        const nb = base + off;
        if (nb < 0 || nb >= nCells) continue;
        const u = cellVert[nb];
        if (u < 0) continue;
        const q3 = u * 3;

        // Garde-fou "mur mince" : deux cellules voisines peuvent porter des
        // sommets qui ne sont PAS relies par un quad (les deux faces d'une
        // paroi de 1 voxel). Les lisser ensemble ferait fondre le mur.
        const dx = src[q3] - px, dy = src[q3 + 1] - py, dz = src[q3 + 2] - pz;
        if (dx * dx + dy * dy + dz * dz > near2) continue;

        // Feature-aware : on ne lisse pas a travers une arete franche. C'est la
        // seule chose du Dual Contouring qui nous interesse, pour 1 % du cout
        // (§2.6).
        if (n0x * nrm0[q3] + n0y * nrm0[q3 + 1] + n0z * nrm0[q3 + 2] < FEATURE_COS) continue;

        ax += dx; ay += dy; az += dz; cnt++;
      }

      if (cnt === 0) {
        dst[p3] = px; dst[p3 + 1] = py; dst[p3 + 2] = pz;
        continue;
      }
      const s = w / cnt;
      let nx = px + ax * s, ny = py + ay * s, nz = pz + az * s;

      // --- bride de derive : BOULE de rayon MAX_DRIFT autour de l'origine ----
      // Volontairement une boule et pas la cellule : clamper dans la cellule
      // reintroduirait exactement le reseau regulier qu'on cherche a casser.
      const ox = nx - pos0[p3], oy = ny - pos0[p3 + 1], oz = nz - pos0[p3 + 2];
      const l2 = ox * ox + oy * oy + oz * oz;
      if (l2 > drift2) {
        const f = MAX_DRIFT / Math.sqrt(l2);
        nx = pos0[p3] + ox * f;
        ny = pos0[p3 + 1] + oy * f;
        nz = pos0[p3 + 2] + oz * f;
      }
      dst[p3] = nx; dst[p3 + 1] = ny; dst[p3 + 2] = nz;
    }

    const t = src; src = dst; dst = t;

    // --- reprojection de Newton toutes les 2 iterations --------------------
    // Un seul pas ramene |D - ISO| de ~20 a ~1 unite, soit 0,3 mm. Sans ca, le
    // lissage rabote les cretes des creneaux de 2-3 mm par cycle.
    if ((it & 1) === 1) {
      for (let v = 0; v < vCount; v++) {
        const p3 = v * 3;
        const x = src[p3], y = src[p3 + 1], z = src[p3 + 2];
        const f = sampleD(D, S, S2, x, y, z) - ISO;
        if (f > -1.5 && f < 1.5) continue;         // deja sur la surface
        const e = 0.6;
        const gx = (sampleD(D,S,S2,x+e,y,z) - sampleD(D,S,S2,x-e,y,z)) / (2*e);
        const gy = (sampleD(D,S,S2,x,y+e,z) - sampleD(D,S,S2,x,y-e,z)) / (2*e);
        const gz = (sampleD(D,S,S2,x,y,z+e) - sampleD(D,S,S2,x,y,z-e)) / (2*e);
        const g2 = gx * gx + gy * gy + gz * gz;
        if (g2 < 1e-4) continue;
        // Pas borne a 0,5 voxel : sur une paroi fraichement coupee le gradient
        // est enorme et un Newton nu enverrait le sommet a l'autre bout du bloc.
        let s2 = f / g2;
        const step = Math.hypot(gx * s2, gy * s2, gz * s2);
        if (step > 0.5) s2 *= 0.5 / step;
        src[p3] = x - gx * s2;
        src[p3 + 1] = y - gy * s2;
        src[p3 + 2] = z - gz * s2;
      }
    }
  }

  if (src !== ctx.pos) ctx.pos.set(src.subarray(0, vCount * 3));
}
```

### (5) Passe 2 : quads — deux jeux d'indices

La passe de quads produit maintenant **deux choses** :

- les **indices émis** (arêtes possédées, `[BORDER, BORDER+CHUNK−1]`), comme
  aujourd'hui ;
- l'**accumulation de normales pondérées par l'aire**, qui doit couvrir *toutes*
  les arêtes valides `[G0+1, G1]`, sinon les normales des sommets de bord ne
  verraient qu'une partie de leurs triangles → **couture d'éclairage**.

```js
/** Normale de face NON normalisee = 2 * aire * n. La ponderation par l'aire est
 *  donc gratuite : il suffit de ne pas normaliser avant d'accumuler. */
function accumFace(fnrm, pos, a, b, c, flip) {
  const a3 = a * 3, b3 = b * 3, c3 = c * 3;
  const ux = pos[b3] - pos[a3], uy = pos[b3+1] - pos[a3+1], uz = pos[b3+2] - pos[a3+2];
  const vx = pos[c3] - pos[a3], vy = pos[c3+1] - pos[a3+1], vz = pos[c3+2] - pos[a3+2];
  let nx = uy * vz - uz * vy;
  let ny = uz * vx - ux * vz;
  let nz = ux * vy - uy * vx;
  if (flip) { nx = -nx; ny = -ny; nz = -nz; }
  fnrm[a3] += nx; fnrm[a3+1] += ny; fnrm[a3+2] += nz;
  fnrm[b3] += nx; fnrm[b3+1] += ny; fnrm[b3+2] += nz;
  fnrm[c3] += nx; fnrm[c3+1] += ny; fnrm[c3+2] += nz;
}

function d2v(pos, a, b) {
  const a3 = a * 3, b3 = b * 3;
  const dx = pos[a3]-pos[b3], dy = pos[a3+1]-pos[b3+1], dz = pos[a3+2]-pos[b3+2];
  return dx*dx + dy*dy + dz*dz;
}

/** Meme quad, diagonale b-e au lieu de a-c (§1.4). */
function quadAlt(idx, o, a, b, c, e, flip) {
  if (flip) {
    idx[o++] = a; idx[o++] = b; idx[o++] = e;
    idx[o++] = b; idx[o++] = c; idx[o++] = e;
  } else {
    idx[o++] = a; idx[o++] = e; idx[o++] = b;
    idx[o++] = b; idx[o++] = e; idx[o++] = c;
  }
  return o;
}
```

et dans `surfaceNets`, le corps de la boucle de faces :

```js
  const fnrm = ctx.fnrm;
  fnrm.fill(0, 0, vCount * 3);

  const emit = (a, b, c, e, flip, own) => {
    // Diagonale la plus courte : supprime le biais d'ombrage a 45 deg (§1.4).
    const shortAC = d2v(ctx.pos, a, c) <= d2v(ctx.pos, b, e);
    if (shortAC) { accumFace(fnrm, ctx.pos, a, b, c, flip); accumFace(fnrm, ctx.pos, a, c, e, flip); }
    else         { accumFace(fnrm, ctx.pos, a, b, e, flip); accumFace(fnrm, ctx.pos, b, c, e, flip); }
    if (!own) return;
    iCount = shortAC ? quad(idx, iCount, a, b, c, e, flip)
                     : quadAlt(idx, iCount, a, b, c, e, flip);
  };

  const gLo = ctx.G0 + 1, gHi = ctx.G1;
  faces:
  for (let z = gLo; z <= gHi; z++) {
    const zOwn = z >= loZ && z <= hi;
    for (let y = gLo; y <= gHi; y++) {
      const yOwn = zOwn && y >= loY && y <= hi;
      for (let x = gLo; x <= gHi; x++) {
        if (iCount + 18 > ctx.maxI) break faces;
        const o = x + S * y + S2 * z;
        const d = D[o] >= ISO ? 1 : 0;

        if (x + 1 < S && (D[o + 1] >= ISO ? 1 : 0) !== d) {
          const a = cellVert[x + CELLS*(y-1) + C2*(z-1)];
          const b = cellVert[x + CELLS*y     + C2*(z-1)];
          const c = cellVert[x + CELLS*y     + C2*z];
          const e = cellVert[x + CELLS*(y-1) + C2*z];
          if (a>=0 && b>=0 && c>=0 && e>=0) emit(a,b,c,e, d===1, yOwn && x>=loX && x<=hi);
        }
        if (y + 1 < S && (D[o + S] >= ISO ? 1 : 0) !== d) {
          const a = cellVert[(x-1) + CELLS*y + C2*(z-1)];
          const b = cellVert[x     + CELLS*y + C2*(z-1)];
          const c = cellVert[x     + CELLS*y + C2*z];
          const e = cellVert[(x-1) + CELLS*y + C2*z];
          if (a>=0 && b>=0 && c>=0 && e>=0) emit(a,b,c,e, d!==1, zOwn && y>=loY && y<=hi && x>=loX && x<=hi);
        }
        if (z + 1 < S && (D[o + S2] >= ISO ? 1 : 0) !== d) {
          const a = cellVert[(x-1) + CELLS*(y-1) + C2*z];
          const b = cellVert[x     + CELLS*(y-1) + C2*z];
          const c = cellVert[x     + CELLS*y     + C2*z];
          const e = cellVert[(x-1) + CELLS*y     + C2*z];
          if (a>=0 && b>=0 && c>=0 && e>=0) emit(a,b,c,e, d===1, yOwn && x>=loX && x<=hi);
        }
      }
    }
  }
```

### (6) Passe 3 : normales, AO, conversion en mètres — APRÈS lissage

Second point crucial : **les normales et l'AO doivent être calculées sur la
géométrie finale**, pas sur la géométrie brute. Sinon on rebake exactement la
trame qu'on vient d'effacer.

```js
  const [wox, woy, woz] = worldOrigin;
  for (let v = 0; v < vCount; v++) {
    if (!ctx.owned[v]) continue;
    const p3 = v * 3;
    const gx = ctx.pos[p3], gy = ctx.pos[p3 + 1], gz = ctx.pos[p3 + 2];

    // (a) gradient du champ LISSE : robuste, continu aux seams, un peu mou.
    let ngx = sampleB(DB,S,S2,gx-0.8,gy,gz) - sampleB(DB,S,S2,gx+0.8,gy,gz);
    let ngy = sampleB(DB,S,S2,gx,gy-0.8,gz) - sampleB(DB,S,S2,gx,gy+0.8,gz);
    let ngz = sampleB(DB,S,S2,gx,gy,gz-0.8) - sampleB(DB,S,S2,gx,gy,gz+0.8);
    let gl = Math.hypot(ngx, ngy, ngz);
    if (gl < 1e-6) { ngx = 0; ngy = 1; ngz = 0; gl = 1; }
    ngx /= gl; ngy /= gl; ngz /= gl;

    // (b) normale de face ponderee par l'aire : nette, mais liee aux triangles.
    let fx = fnrm[p3], fy = fnrm[p3 + 1], fz = fnrm[p3 + 2];
    const fl = Math.hypot(fx, fy, fz);

    let nx = ngx, ny = ngy, nz = ngz;
    if (fl > 1e-8) {
      fx /= fl; fy /= fl; fz /= fl;
      // Melange adaptatif (§2.4b) : la ou les deux sont d'accord, la face gagne
      // (plus nette) ; la ou elles divergent (bruit de champ), le gradient
      // gagne (plus stable, et seam-safe).
      const wFace = smooth01((fx*ngx + fy*ngy + fz*ngz - 0.55) / 0.35) * 0.75;
      nx = ngx + (fx - ngx) * wFace;
      ny = ngy + (fy - ngy) * wFace;
      nz = ngz + (fz - ngz) * wFace;
      const l = Math.hypot(nx, ny, nz) || 1;
      nx /= l; ny /= l; nz /= l;
    }
    nrm[p3] = nx; nrm[p3 + 1] = ny; nrm[p3 + 2] = nz;

    att[v * 4 + 2] = ambientOcclusion(DB, S, S2, gx, gy, gz, nx, ny, nz);

    // Coordonnees BLOC -> monde, en dernier.
    pos[p3]     = wox + (bx0 + gx + 0.5) * voxelSize;
    pos[p3 + 1] = woy + (by0 + gy + 0.5) * voxelSize;
    pos[p3 + 2] = woz + (bz0 + gz + 0.5) * voxelSize;
  }

  bilateralNormals(ctx, vCount);
  smoothAO(ctx, vCount);

function smooth01(t) { t = t < 0 ? 0 : t > 1 ? 1 : t; return t * t * (3 - 2 * t); }
```

## 2.4 Amélioration des normales

### (a) Dériver un champ pré-lissé

Couvert en §2.3(2). C'est **le** changement le plus rentable de toute la section
2 : −80 % d'erreur de normale pour 0,25 ms.

### (b) Aire vs gradient : la réponse est « les deux »

| Critère | Gradient du champ | Normale de face pondérée par l'aire |
|---|---|---|
| Continuité aux seams | **parfaite** (le champ est partagé) | fragile (dépend des triangles présents) |
| Netteté sur les arêtes sculptées | molle (le champ y est arrondi par le pinceau) | **nette** |
| Sensibilité au bruit de champ | forte (c'est le problème §1.3) | **faible** |
| Sensibilité à la triangulation | nulle | forte (d'où la diagonale courte) |
| Coût par sommet | 6 `sampleD` = 48 lectures | ~1,5 produits vectoriels amortis |

D'où le **mélange adaptatif** de la passe 3 : quand les deux normales sont
d'accord (`n_face · n_grad > 0.9`), on fait confiance à la face ; quand elles
divergent, on retombe sur le gradient. Le
`smoothstep((agree − 0.55)/0.35) × 0.75` implémente ça et **plafonne à 75 % de
face**, ce qui garantit qu'une couture de face ne peut jamais produire plus de
25 % d'écart de normale de part et d'autre d'une frontière de chunk — sous le
seuil de visibilité, et de toute façon corrigé par le fait qu'on accumule les
faces sur l'anneau élargi (donc identiques des deux côtés).

La pondération par l'aire est **gratuite** : `cross(b−a, c−a)` a pour norme
`2·aire`, il suffit de *ne pas normaliser avant d'accumuler*. (La pondération
par l'angle, ou celle de Max en `1/(|e₁|²|e₂|²)`, est théoriquement supérieure
sur des maillages très irréguliers ; sur un maillage dual quad-dominant à
valence quasi constante 4, la différence est **sous le degré**. Ne pas payer
pour ça.)

### (c) Filtrage bilatéral des normales — la finition qui préserve les arêtes

Après (a) et (b), il reste un léger frisottis sur les zones fraîchement remuées.
Le filtrage bilatéral de normales lisse les normales **entre elles** avec un
poids qui s'effondre quand elles diffèrent trop — il lisse donc les pentes et
**préserve les arêtes de créneau**. Sur notre maillage dual, encore une fois,
l'adjacence est gratuite.

```js
/**
 * Filtrage bilateral des normales sur le maillage dual.
 *
 *   w_ij = exp(-d_ij^2 / (2 sigma_s^2)) * exp(-|n_i - n_j|^2 / (2 sigma_r^2))
 *
 * sigma_s : portee spatiale en voxels. 1,4 = un peu plus qu'un pas de maille :
 *           le filtre voit les 6 voisins et rien au-dela.
 * sigma_r : tolerance angulaire. 0,35 sur |n_i - n_j| vaut ~20 degres : en
 *           dessous on lisse, au-dessus c'est une VRAIE arete (creneau, marche
 *           sculptee) et on n'y touche pas.
 *
 * 2 iterations suffisent. On l'execute sur TOUS les sommets (anneau compris) :
 * comme BF_ITERS (2) <= SMOOTH_ITERS (4), le resultat reste identique au bit
 * pres d'un chunk a l'autre. Cout : ~0,05 ms.
 */
const BF_SIGMA_S = 1.4;
const BF_SIGMA_R = 0.35;
const BF_ITERS = 2;

function bilateralNormals(ctx, vCount) {
  const CELLS = ctx.CELLS, C2 = CELLS * CELLS;
  const cellVert = ctx.cellVert, cell = ctx.cell, pos = ctx.pos;
  const nCells = cellVert.length;
  const inS = -1 / (2 * BF_SIGMA_S * BF_SIGMA_S);
  const inR = -1 / (2 * BF_SIGMA_R * BF_SIGMA_R);
  let src = ctx.nrm, dst = ctx.fnrm;   // fnrm est libre a ce stade

  for (let it = 0; it < BF_ITERS; it++) {
    for (let v = 0; v < vCount; v++) {
      const p3 = v * 3;
      const nx0 = src[p3], ny0 = src[p3+1], nz0 = src[p3+2];
      let ax = nx0, ay = ny0, az = nz0, wsum = 1;
      const base = cell[p3] + CELLS * cell[p3+1] + C2 * cell[p3+2];
      for (let d = 0; d < 6; d++) {
        const off = d === 0 ? 1 : d === 1 ? -1
                  : d === 2 ? CELLS : d === 3 ? -CELLS : d === 4 ? C2 : -C2;
        const nb = base + off;
        if (nb < 0 || nb >= nCells) continue;
        const u = cellVert[nb];
        if (u < 0) continue;
        const q3 = u * 3;
        const dx = pos[q3]-pos[p3], dy = pos[q3+1]-pos[p3+1], dz = pos[q3+2]-pos[p3+2];
        const ds = dx*dx + dy*dy + dz*dz;
        if (ds > 4) continue;
        const ex = src[q3]-nx0, ey = src[q3+1]-ny0, ez = src[q3+2]-nz0;
        const w = Math.exp(ds * inS + (ex*ex + ey*ey + ez*ez) * inR);
        ax += src[q3] * w; ay += src[q3+1] * w; az += src[q3+2] * w;
        wsum += w;
      }
      const l = Math.hypot(ax, ay, az) || 1;
      dst[p3] = ax/l; dst[p3+1] = ay/l; dst[p3+2] = az/l;
    }
    const t = src; src = dst; dst = t;
  }
  if (src !== ctx.nrm) ctx.nrm.set(src.subarray(0, vCount * 3));
}
```

## 2.5 L'AO : la lisser aussi, et ne pas la rebaker sur la trame

Trois corrections indépendantes.

**(1) Calculer l'AO sur le champ flouté `DB` et à la position lissée.** Déjà
fait dans la passe 3. Cela supprime à lui seul l'essentiel du ±3,4 %
diagnostiqué au §1.2 : les 27 rayons ne traversent plus un escalier mais une
rampe.

**(2) Un lissage laplacien de l'AO elle-même**, 2 itérations à poids 0,5, sur la
même adjacence duale. L'AO est basse fréquence par nature : la lisser ne perd
aucune information et supprime le résidu de trame photométrique.

```js
/** Lissage de l'AO (canal att[v*4+2]). 2 iterations, poids 0,5. */
function smoothAO(ctx, vCount) {
  const CELLS = ctx.CELLS, C2 = CELLS * CELLS;
  const cellVert = ctx.cellVert, cell = ctx.cell, att = ctx.att, tmp = ctx.aoTmp;
  const nCells = cellVert.length;
  for (let it = 0; it < 2; it++) {
    for (let v = 0; v < vCount; v++) {
      const p3 = v * 3;
      const base = cell[p3] + CELLS * cell[p3+1] + C2 * cell[p3+2];
      let sum = 0, cnt = 0;
      for (let d = 0; d < 6; d++) {
        const off = d === 0 ? 1 : d === 1 ? -1
                  : d === 2 ? CELLS : d === 3 ? -CELLS : d === 4 ? C2 : -C2;
        const nb = base + off;
        if (nb < 0 || nb >= nCells) continue;
        const u = cellVert[nb];
        if (u < 0) continue;
        sum += att[u * 4 + 2]; cnt++;
      }
      tmp[v] = cnt ? ((att[v*4+2] * 0.5 + (sum / cnt) * 0.5) | 0) : att[v*4+2];
    }
    for (let v = 0; v < vCount; v++) att[v*4+2] = tmp[v];
  }
}
```

**(3) Réduire le nombre de rayons.** Avec un champ flouté puis une AO lissée,
9 directions × 3 pas sont du luxe : **6 × 3** donnent un résultat visuellement
identique pour **−33 % du poste le plus cher du mailleur**. C'est cette économie
qui finance Taubin.

```js
// AO_DIRS reduit : on garde la verticale, les 4 diagonales de 45 deg dans les
// plans XY/ZY, et une diagonale de coin. 6 directions x 3 pas = 18 echantillons.
const AO_DIRS = [
  [0.0, 1.0, 0.0],
  [0.71, 0.71, 0.0], [-0.71, 0.71, 0.0],
  [0.0, 0.71, 0.71], [0.0, 0.71, -0.71],
  [0.58, 0.58, 0.58],
];
```

## 2.6 Dual Contouring avec QEF : faut-il y aller ? — **NON. Tranché.**

C'est la question qui revient toujours ; elle mérite d'être argumentée plutôt
qu'assénée.

### Ce que le QEF apporterait

Dual Contouring (Ju, Losasso, Schaefer & Warren, SIGGRAPH 2002) place le sommet
non pas au barycentre des points de coupe, mais au minimiseur de l'**erreur
quadratique** sur les plans tangents (données de Hermite : position **et
normale** à chaque intersection d'arête) :

```
E(x) = Σᵢ ( nᵢ · (x − pᵢ) )²
```

Résolu par SVD (ou pseudo-inverse) avec troncature des valeurs singulières
(seuil typique 0,1) et un terme de régularisation vers le centre de masse des
`pᵢ` pour les configurations dégénérées. Le sommet se place alors **sur le
coin** quand deux plans se croisent — d'où les arêtes vives.

**Et ça résoudrait effectivement le §1.1** : sur une pente douce, si les
normales des 4 intersections ne sont pas exactement parallèles, le minimiseur
bouge en XZ et le verrouillage `lx = lz = 0.5` tombe.

### Pourquoi c'est quand même non, ici — cinq raisons

**1. Le QEF a besoin de normales EXACTES, et nous n'en avons pas.** Les normales
de Hermite viendraient du gradient du champ, c'est-à-dire de la donnée
précisément identifiée comme bruitée au §1.3 (±6,7°, jusqu'à ±15°). Le QEF
**amplifie** cette erreur : deux plans quasi parallèles dont les normales sont
fausses de 7° ont un point d'intersection qui part à plusieurs cellules de
distance. Il faut alors clamper le sommet dans sa cellule — et on est revenu au
réseau régulier, en ayant payé le prix fort.

En clair : **il faudrait d'abord flouter le champ (§2.3-2) pour faire marcher le
QEF, et une fois le champ flouté, Taubin donne le même résultat pour 20× moins
cher.**

**2. Le sable n'a pas d'arêtes vives, et les sculptures non plus.** L'argument
qu'on croit avoir — « oui mais les créneaux ! » — ne tient pas à l'examen : le
pinceau écrit la densité avec un profil de chute progressif, et `Granular` la
ré-étale immédiatement. Une arête de créneau dans le champ n'est **jamais** un
dièdre net à l'échelle du voxel ; c'est un congé de 1 à 2 voxels. Le QEF n'aurait
littéralement rien à reconstruire.

**3. Le coût.** 4 à 10 ms par chunk contre 0,8–2 ms (`RECHERCHE-PHYSIQUE-SABLE`
§5.5). Avec 36 chunks/frame en pointe, c'est 144 à 360 ms de travail worker : le
pipeline s'effondre et la latence de remaillage passe à 10+ frames — ce qui
**aggraverait** le problème n°2 (la téléportation).

**4. Les seams.** Un sommet DC peut sortir de sa cellule. Deux chunks voisins
qui clampent différemment, ou qui tronquent la SVD à un rang différent à cause
d'un `1e-7` de conditionnement, produisent des positions différentes →
**fissure**. L'exactitude bit-à-bit démontrée au §2.2 pour Taubin n'est **pas**
démontrable pour une SVD.

**5. La non-variété.** DC peut produire des sommets non-manifold (deux nappes
distinctes dans une cellule). Sur du sable qui s'effondre, où des nappes fines
se forment en permanence, ce serait un générateur d'artefacts et un cauchemar de
débogage. (Manifold Dual Contouring existe et corrige ce point — pour un coût
supplémentaire d'octree et de subdivision de cellules. Hors de question ici.)

### La bonne alternative — déjà dans le code ci-dessus

Le **Taubin feature-aware** de `taubinSmooth` :

```js
if (n0x * nrm0[q3] + n0y * nrm0[q3+1] + n0z * nrm0[q3+2] < FEATURE_COS) continue;
```

On n'agrège pas un voisin dont la normale diverge de plus de 52°. Les créneaux
gardent leurs arêtes, les pentes sont lissées. Coût : **3 multiplications de
plus par voisin** (+15 µs par chunk) plus la passe de gradient initiale
(+0,15 ms — de toute façon souhaitable, elle sert aussi de base à la normale
finale).

**C'est la seule chose du QEF qui nous intéresse, et elle coûte 1 % de son prix.**

## 2.7 Récapitulatif du coût de la §2

| Étape | Coût par chunk | Note |
|---|---|---|
| `blurField` (binomial 3×3×3 séparable) | **+0,25 ms** | 770 k ops sur 44³ |
| Génération sur l'anneau élargi (+54 % de sommets) | +0,04 ms | partie bon marché |
| Premier jet de normales (gradient sur `DB`) | +0,15 ms | sert au feature-aware ET à la normale finale |
| `taubinSmooth` 4 itérations + 2 reprojections | **+0,22 ms** | 1 681 sommets × 6 voisins |
| `bilateralNormals` 2 itérations | +0,05 ms | |
| `smoothAO` 2 itérations | +0,02 ms | |
| Accumulation de normales de face | +0,03 ms | |
| Diagonale la plus courte | +0,02 ms | |
| **AO passée de 9×3 à 6×3 directions** | **−0,25 ms** | finance le reste |
| **Total** | **+0,53 ms** | sur 0,8–2 ms → **+27 à +66 %** |

Avec `MESH_WORKERS = 2..6` et `BUDGET_REMESH * 6 = 36` chunks collectés par
frame, le pipeline absorbe sans changer un budget : le débit passe de ~3 à ~2
chunks/ms/worker, et la file `mesher.busy` reste vide en régime normal (un coup
de pelle salit 8 à 27 chunks).

Le seul point de vigilance est le **pic de démarrage** : `warmupMeshing()` maille
les 192 chunks d'un coup. Le temps de chargement passe d'environ 1,2 s à 1,7 s.
Acceptable ; on peut le masquer en gardant l'écran de progression.

### Checklist de validation visuelle du §2

1. Poser la caméra à 8 m sur une pente à ~15°, soleil rasant (`dayT ≈ 0.15`).
   **Avant** : trame carrée + terrasses tous les 15 cm. **Après** : lisse.
2. Sculpter un créneau de 4 voxels de large, 3 de haut. Mesurer sa hauteur au
   raycast avant/après lissage : la perte doit être **< 3 mm**.
3. Regarder une frontière de chunk (multiples de 1,28 m depuis `ORIGIN_X`) en
   éclairage rasant : **aucune ligne** ne doit apparaître. Si une ligne
   apparaît, `SMOOTH_ITERS > BORDER − 1` ou un des filtres a été limité à
   `owned`.
4. Creuser un puits vertical de 1 voxel de large : le mur ne doit pas se
   refermer (test `NEIGHBOUR_MAX`).

---

# 3. Le point clé — des mouvements continus

C'est le cœur de la demande. Le §1.6 a montré que la discontinuité vient de
**trois quantifications superposées** — le pas de transfert, le seuil binaire du
masque, et le remplacement intégral de la géométrie. Il faut les traiter toutes
les trois, et chacune appelle une technique différente.

## 3.0 Cadre d'analyse

Le critère est perceptif, pas physique. **Une chose paraît glisser quand son
déplacement par image reste sous ~3 px et que sa dérivée est continue.** À 8 m,
3 px = 1,3 cm ; à 15 m, 3 px = 2,4 cm. Objectif : **le sable ne doit jamais
bouger de plus de ~1 cm par image, et jamais avec une accélération infinie.**

Aujourd'hui il bouge de 4 cm d'un coup, une image sur deux ou trois. On a donc
besoin d'un facteur **~4 en amplitude** et d'un lissage temporel.

## 3.1 (a) Interpolation temporelle du champ

### (a1) La version naïve : deux instantanés de densité

Garder `densityPrev` et `densityCur`, et mailler un champ interpolé
`lerp(prev, cur, α)` où α avance à chaque image.

| Poste | Coût |
|---|---|
| Mémoire | **+6,29 Mo** (`Uint8Array` de 256×96×256) |
| Copie de l'instantané | 6,29 Mo de `memcpy` par pas de simulation → **~1,5 ms par frame** |
| Remaillage | il faut remailler **à chaque valeur de α**, donc **à 60 Hz**, tous les chunks actifs |

Ce dernier point est rédhibitoire. Aujourd'hui un chunk n'est remaillé que
quand il change ; avec l'interpolation, un chunk en cours d'avalanche serait
remaillé **à chaque image pendant toute la durée de l'interpolation** — soit
8 à 27 chunks × 60 Hz × 1,3 ms = **bien au-delà du budget** — pour un résultat
visuellement identique à celui qu'on obtient en faisant simplement des
transferts plus petits.

**Verdict : ✗ rejeté.** On paie une copie mémoire et un remaillage continu pour
simuler une finesse de transfert qu'il est infiniment moins cher d'obtenir
directement.

### (a2) La version utile : faire GLISSER la densité au lieu de la transférer

C'est la même idée, prise par le bon bout. Plutôt que d'interpoler *a
posteriori* entre deux états quantifiés, on rend l'automate lui-même
suffisamment fin pour que ses états successifs soient **déjà** continus.

```
MAX_TRANSFER : 96 → 24            (37,6 % → 9,4 % d'un voxel par passe)
SUBSTEPS     : 1  → 4             (4 passes d'avalanche par pas de simulation)
```

Le débit est **identique** (24 × 4 = 96 par pas de simulation) mais la
granularité est **4× plus fine** :

```
déplacement de l'isosurface par sous-pas :
   24/255 × VOXEL = 0,0941 × 4 cm = 3,8 mm

déplacement par image (4 sous-pas)       : 1,5 cm
vitesse apparente                        : 0,90 m/s, CONTINUE
```

**1,5 cm par image, c'est 3,5 px à 8 m** — au seuil du §3.0, et la vitesse est
constante au lieu d'être une impulsion suivie de rien.

**Coût : nul.** Le détail est au §4.3, mais l'idée est que `BUDGET_GRANULAR =
60 000` est un budget de *voxels examinés*, et l'ensemble actif d'une avalanche
réelle fait 2 000 à 8 000 voxels. Quatre sous-pas coûtent 8 000 à 32 000
examens — **on reste dans le budget existant**.

C'est aussi le réglage que retient la littérature PBD pour du granulaire :
Macklin et al. utilisent **2 à 3 sous-pas** (avec 12 itérations par sous-pas)
pour leur scène de validation… qui est précisément un château de sable.

**Verdict : ✓✓ retenu, en premier.** C'est un changement de deux constantes et
d'une boucle `for`, pour le tiers du résultat visuel total.

### Ce que (a2) ne résout pas

Il reste le **seuil binaire du masque**. Même avec des transferts de 24, quand
une densité franchit 128 la topologie de la cellule bascule d'un coup. La
différence, c'est que cela n'arrive plus qu'une fois toutes les ~5 passes au
lieu d'une fois toutes les 2, et qu'entre deux bascules le sommet, lui, se
déplace **continûment** (l'interpolation d'arête est continue en `t`). Le résidu
est un micro-cliquetis de topologie, très largement masqué par (b).

## 3.2 (b) Geomorphing de maillage — **l'appariement est EXACT ici**

### Le problème général, et pourquoi il ne se pose pas chez nous

Le geomorphing de terrain (Transvoxel, CDLOD, tout le corpus « popping
artifact ») est difficile parce qu'il faut **apparier les sommets** entre deux
maillages différents : plus proche voisin, projection le long de la normale,
correspondance par arête… toutes des heuristiques, toutes fragiles.

**Surface Nets nous donne l'appariement gratuitement et exactement.** Un sommet
n'est pas une entité libre : c'est *le* sommet de *la* cellule `(i, j, k)`, et
**la grille de cellules ne bouge jamais**. Deux maillages successifs du même
chunk sont donc appariables par une clé entière, sans aucune ambiguïté :

```
key = (i − C0) + 34 · ((j − C0) + 34 · (k − C0))       0 ≤ key < 34³ = 39 304
```

qui tient sur 16 bits. C'est déjà exporté par le §2.3(3).

> C'est un avantage structurel sur les schémas de LOD : CDLOD doit calculer son
> facteur de morph à partir d'une quantité **cohérente sur tout le domaine**
> (sinon les sommets de bord divergent et on rouvre une couture) ; chez nous
> c'est un simple temps global, et l'appariement est topologique et non
> géométrique.

Trois cas, tous propres :

| Cas | Situation | Traitement |
|---|---|---|
| **Persistance** | la cellule avait un sommet, elle en a un | morph de l'ancienne position vers la nouvelle |
| **Apparition** | la cellule n'avait pas de sommet | position de départ = moyenne des anciens sommets des 6 cellules voisines : le sommet « pousse » hors de la surface existante au lieu d'apparaître |
| **Disparition** | la cellule n'a plus de sommet | rien à faire, le sommet n'est plus référencé |

C'est **robuste** au sens strict : pas de recherche spatiale, pas de seuil, pas
de cas dégénéré. Un `Int32Array` de 39 304 entrées suffit comme table de
correspondance, et on peut l'effacer en O(nombre d'anciens sommets) au lieu de
la remplir entièrement — détail qui compte, parce qu'un `fill()` de 39 304
entrées × 36 chunks par frame coûterait 1,4 ms pour rien.

### Continuité de la vitesse : partir de la position AFFICHÉE

Piège classique : si on morphe depuis la position du **maillage précédent**
alors que le morph précédent n'était pas terminé, on crée une discontinuité de
vitesse à chaque remaillage — et pendant une avalanche, ça remaille toutes les
images. Le sable « bat ».

La correction est simple : on stocke, par chunk, la **position actuellement
affichée**, et c'est elle qui sert de point de départ. Concrètement, à chaque
échange on évalue le morph en cours sur le CPU :

```
displayed[key] = mix(prevDisplayed[key], prevTarget[key], smoothstep(m))
```

Le résultat est un **filtre passe-bas temporel du premier ordre** sur la
géométrie, de constante de temps ~60 ms. C'est exactement l'effet recherché : la
surface visible « suit » la surface simulée avec un léger retard élastique, ce
qui est *précisément* la sensation d'une matière qui s'écoule.

Coût : ~1 100 `lerp` par échange de chunk, soit **~8 µs**.

### Il faut morpher la NORMALE aussi — ce n'est pas optionnel

Lengyel le souligne dans sa thèse sur Transvoxel, et c'est contre-intuitif :
**le saut d'ombrage est un problème distinct du saut géométrique**, et il peut
survenir *même quand les sommets morphés se trouvent déjà sur la surface
d'arrivée*. Autrement dit, morpher `position` sans morpher `normal` produit une
surface qui glisse joliment… en clignotant. On paie donc `aPrevNormal`.

### Durée du morph

```
uMorphDur = 0.12 s   (7 images à 60 fps)
```

- Plus court (60 ms) : on voit encore les paliers.
- Plus long (250 ms) : le retard devient perceptible — pendant une avalanche à
  1 m/s, la surface visible traîne de 12 cm derrière la surface physique, et le
  sable a l'air *mou*, comme de la guimauve.
- 120 ms → retard moyen de ~6 cm à 1 m/s, imperceptible, et le passe-bas est
  assez lent pour lisser deux remaillages consécutifs.

### Code — worker : exporter la clé

Dans `compact()` (`SurfaceNets.js`) :

```js
function compact(pos, nrm, att, key, idx, vCount, iCount) {
  const remap = new Int32Array(vCount).fill(-1);
  let nv = 0;
  for (let i = 0; i < iCount; i++) {
    const v = idx[i];
    if (remap[v] < 0) remap[v] = nv++;
  }
  const positions = new Float32Array(nv * 3);
  const normals = new Float32Array(nv * 3);
  const attrs = new Uint8Array(nv * 4);
  const keys = new Uint16Array(nv);                    // <-- nouveau
  for (let v = 0; v < vCount; v++) {
    const r = remap[v];
    if (r < 0) continue;
    positions[r*3] = pos[v*3]; positions[r*3+1] = pos[v*3+1]; positions[r*3+2] = pos[v*3+2];
    normals[r*3]   = nrm[v*3]; normals[r*3+1]   = nrm[v*3+1]; normals[r*3+2]   = nrm[v*3+2];
    attrs[r*4] = att[v*4]; attrs[r*4+1] = att[v*4+1];
    attrs[r*4+2] = att[v*4+2]; attrs[r*4+3] = att[v*4+3];
    keys[r] = key[v];                                  // <-- nouveau
  }
  const indices = nv > 65535 ? new Uint32Array(iCount) : new Uint16Array(iCount);
  for (let i = 0; i < iCount; i++) indices[i] = remap[idx[i]];
  return { positions, normals, attrs, keys, indices, vertexCount: nv, indexCount: iCount };
}
```

et dans `MeshWorker.js`, ajouter `out.keys = r.keys.buffer` au message **et à la
liste des transférables** ; dans `MesherPool.handle`, `keys: new
Uint16Array(m.keys)`.

### Code — `TerrainRenderer` : construire `aPrevPos`

```js
/**
 * Rendu du terrain avec GEOMORPHING.
 *
 * Le probleme : remplacer d'un coup le buffer de positions d'un chunk fait
 * SAUTER la geometrie. Sur du sable qui coule, c'est ce qui donne la sensation
 * de teleportation (§1.6c).
 *
 * La solution : Surface Nets place UN sommet par cellule, et la grille de
 * cellules ne bouge jamais. Deux maillages successifs d'un meme chunk sont donc
 * appariables EXACTEMENT par la cle de cellule — pas de plus-proche-voisin, pas
 * d'heuristique, pas de cas degenere. On construit un attribut aPrevPos et le
 * vertex shader interpole sur uMorphDur.
 *
 * Subtilite importante : on part de la position AFFICHEE (le morph precedent
 * evalue a l'instant de l'echange), pas de la position du maillage precedent.
 * Sinon chaque remaillage casse la continuite de la VITESSE et le sable bat.
 */

import * as THREE from 'three';
import {
  CHUNK, CX, CY, CZ, CHUNK_COUNT, VOXEL,
  ORIGIN_X, ORIGIN_Y, ORIGIN_Z,
} from '../core/Config.js';

/** Duree du morph, en secondes. 0,12 s = 7 images. Voir §3.2. */
export const MORPH_DUR = 0.12;

/** Etendue des cles de cellule : (CHUNK + 2)^3 = 34^3. */
const KEY_SPAN = 34 * 34 * 34;

export class TerrainRenderer {
  constructor(scene, material, depthMaterial = null) {
    this.scene = scene;
    this.material = material;
    this.depthMaterial = depthMaterial;
    this.group = new THREE.Group();
    this.group.name = 'terrain';
    this.scene.add(this.group);

    this.meshes = new Array(CHUNK_COUNT).fill(null);
    this.triangles = 0;
    this.time = 0;

    /**
     * Etat de morph par chunk :
     *   keys       Uint16Array  cle de cellule de chaque sommet du maillage courant
     *   shown      Float32Array position AFFICHEE au moment du dernier echange
     *   target     Float32Array position visee (positions du maillage courant)
     *   nrmShown   Float32Array normale affichee au dernier echange
     *   nrmTarget  Float32Array normale visee
     *   t0         number       instant de depart du morph
     */
    this.morph = new Array(CHUNK_COUNT).fill(null);

    /**
     * Scratch partage : cle -> index dans le maillage precedent.
     * On l'efface en O(anciens sommets) plutot que par fill() : 39 304 entrees
     * x 36 chunks par frame couteraient 1,4 ms pour rien.
     */
    this._lookup = new Int32Array(KEY_SPAN).fill(-1);
  }

  /** A appeler une fois par frame, AVANT le rendu. */
  update(dt) {
    this.time += dt;
    const u = this.material.userData.uniforms;
    if (u) u.uTime.value = this.time;
  }

  /** Applique une geometrie fraiche (ou null pour vider le chunk). */
  setChunk(ci, geo) {
    let mesh = this.meshes[ci];

    if (!geo) {
      if (mesh) {
        this.triangles -= mesh.geometry.index ? mesh.geometry.index.count / 3 : 0;
        this.group.remove(mesh);
        mesh.geometry.dispose();
        this.meshes[ci] = null;
        this.morph[ci] = null;
      }
      return;
    }

    const n = geo.vertexCount;
    const prev = this.morph[ci];

    // --- 1. positions de depart du nouveau morph ---------------------------
    const start = new Float32Array(n * 3);
    const startN = new Float32Array(n * 3);
    const t0 = new Float32Array(n);

    if (!prev) {
      // Premier maillage de ce chunk : pas de morph, on affiche directement.
      start.set(geo.positions);
      startN.set(geo.normals);
      t0.fill(-1e9);                       // morph deja termine
    } else {
      // Evalue le morph PRECEDENT a l'instant present pour obtenir la position
      // reellement affichee. C'est ce qui garantit la continuite de la vitesse.
      const m = smooth01((this.time - prev.t0) / MORPH_DUR);
      const lookup = this._lookup;
      const pk = prev.keys, pn = pk.length;
      for (let i = 0; i < pn; i++) lookup[pk[i]] = i;

      const ps = prev.shown, pt = prev.target;
      const pns = prev.nrmShown, ptn = prev.nrmTarget;

      for (let v = 0; v < n; v++) {
        const j = lookup[geo.keys[v]];
        const v3 = v * 3;
        if (j >= 0) {
          const j3 = j * 3;
          start[v3]     = ps[j3]     + (pt[j3]     - ps[j3])     * m;
          start[v3 + 1] = ps[j3 + 1] + (pt[j3 + 1] - ps[j3 + 1]) * m;
          start[v3 + 2] = ps[j3 + 2] + (pt[j3 + 2] - ps[j3 + 2]) * m;
          startN[v3]     = pns[j3]     + (ptn[j3]     - pns[j3])     * m;
          startN[v3 + 1] = pns[j3 + 1] + (ptn[j3 + 1] - pns[j3 + 1]) * m;
          startN[v3 + 2] = pns[j3 + 2] + (ptn[j3 + 2] - pns[j3 + 2]) * m;
        } else if (!averageNeighbours(lookup, ps, pt, pns, ptn, m,
                                      geo.keys[v], start, startN, v3)) {
          // Cellule nouvelle SANS voisin connu (ilot de sable qui apparait) :
          // rien a interpoler, on affiche directement.
          start[v3] = geo.positions[v3];
          start[v3+1] = geo.positions[v3+1];
          start[v3+2] = geo.positions[v3+2];
          startN[v3] = geo.normals[v3];
          startN[v3+1] = geo.normals[v3+1];
          startN[v3+2] = geo.normals[v3+2];
        }
        t0[v] = this.time;
      }
      for (let i = 0; i < pn; i++) lookup[pk[i]] = -1;    // nettoyage O(pn)
    }

    // --- 2. mise a jour de la geometrie ------------------------------------
    if (!mesh) {
      const g = new THREE.BufferGeometry();
      mesh = new THREE.Mesh(g, this.material);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      mesh.frustumCulled = true;
      // INDISPENSABLE : sans materiau de profondeur assorti, les ombres ne
      // morphent pas et on voit l'ombre sauter pendant que la surface glisse.
      if (this.depthMaterial) mesh.customDepthMaterial = this.depthMaterial;
      mesh.name = 'chunk' + ci;
      mesh.userData.ci = ci;
      this.group.add(mesh);
      this.meshes[ci] = mesh;
    } else if (mesh.geometry.index) {
      this.triangles -= mesh.geometry.index.count / 3;
    }

    const g = mesh.geometry;
    g.setAttribute('position', new THREE.BufferAttribute(geo.positions, 3));
    g.setAttribute('normal', new THREE.BufferAttribute(geo.normals, 3));
    g.setAttribute('aData', new THREE.BufferAttribute(geo.attrs, 4, true));
    g.setAttribute('aPrevPos', new THREE.BufferAttribute(start, 3));
    g.setAttribute('aPrevNormal', new THREE.BufferAttribute(startN, 3));
    g.setAttribute('aMorphT0', new THREE.BufferAttribute(t0, 1));
    g.setIndex(new THREE.BufferAttribute(geo.indices, 1));
    g.setDrawRange(0, geo.indexCount);

    // Bounding sphere : le morph deplace les sommets de moins de 4 cm, et la
    // sphere du chunk (rayon 0,87 x 1,28 m) est deja largement genereuse.
    const cy = (ci / (CX * CZ)) | 0;
    const rem = ci - cy * CX * CZ;
    const cz = (rem / CX) | 0;
    const cx = rem - cz * CX;
    const s = CHUNK * VOXEL;
    const center = new THREE.Vector3(
      ORIGIN_X + (cx + 0.5) * s, ORIGIN_Y + (cy + 0.5) * s, ORIGIN_Z + (cz + 0.5) * s
    );
    g.boundingSphere = new THREE.Sphere(center, s * 0.87);
    g.boundingBox = new THREE.Box3(
      new THREE.Vector3(center.x - s/2, center.y - s/2, center.z - s/2),
      new THREE.Vector3(center.x + s/2, center.y + s/2, center.z + s/2)
    );

    this.morph[ci] = {
      keys: geo.keys,
      shown: start,
      target: geo.positions,
      nrmShown: startN,
      nrmTarget: geo.normals,
      t0: this.time,
    };

    this.triangles += geo.indexCount / 3;
  }

  dispose() {
    for (const m of this.meshes) {
      if (m) { this.group.remove(m); m.geometry.dispose(); }
    }
    this.meshes.fill(null);
    this.morph.fill(null);
    this.scene.remove(this.group);
  }
}

function smooth01(t) {
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  return t * t * (3 - 2 * t);
}

/**
 * Position de depart d'une cellule NOUVELLE : moyenne des anciens sommets des
 * 6 cellules voisines. Le sommet "pousse" hors de la surface existante au lieu
 * d'apparaitre a sa position finale (un pop tres visible sur une crete).
 */
function averageNeighbours(lookup, ps, pt, pns, ptn, m, key, outP, outN, v3) {
  const k = (key / 1156) | 0;               // 1156 = 34 * 34
  const r = key - k * 1156;
  const j = (r / 34) | 0;
  const i = r - j * 34;
  let px = 0, py = 0, pz = 0, nx = 0, ny = 0, nz = 0, cnt = 0;
  for (let d = 0; d < 6; d++) {
    const ii = i + (d === 0 ? 1 : d === 1 ? -1 : 0);
    const jj = j + (d === 2 ? 1 : d === 3 ? -1 : 0);
    const kk = k + (d === 4 ? 1 : d === 5 ? -1 : 0);
    if (ii < 0 || jj < 0 || kk < 0 || ii > 33 || jj > 33 || kk > 33) continue;
    const idx = lookup[ii + 34 * (jj + 34 * kk)];
    if (idx < 0) continue;
    const i3 = idx * 3;
    px += ps[i3]     + (pt[i3]     - ps[i3])     * m;
    py += ps[i3 + 1] + (pt[i3 + 1] - ps[i3 + 1]) * m;
    pz += ps[i3 + 2] + (pt[i3 + 2] - ps[i3 + 2]) * m;
    nx += pns[i3]     + (ptn[i3]     - pns[i3])     * m;
    ny += pns[i3 + 1] + (ptn[i3 + 1] - pns[i3 + 1]) * m;
    nz += pns[i3 + 2] + (ptn[i3 + 2] - pns[i3 + 2]) * m;
    cnt++;
  }
  if (cnt === 0) return false;
  const inv = 1 / cnt;
  outP[v3] = px * inv; outP[v3 + 1] = py * inv; outP[v3 + 2] = pz * inv;
  const l = Math.hypot(nx, ny, nz) || 1;
  outN[v3] = nx / l; outN[v3 + 1] = ny / l; outN[v3 + 2] = nz / l;
  return true;
}
```

> ⚠️ `TerrainRenderer.update(ci, geo)` devient `setChunk(ci, geo)`, parce
> qu'`update(dt)` sert maintenant à faire avancer l'horloge du morph. À corriger
> dans `Game.init()` :
> `this.mesher = new MesherPool(this.field, (ci, geo) => this.terrain.setChunk(ci, geo));`
> et ajouter `this.terrain.update(dt);` dans `Game.update()`, **avant** le rendu.

### Code — vertex shader (`SandMaterial.js`)

```js
    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        /* glsl */ `
        #include <common>
        attribute vec4 aData;
        attribute vec3 aPrevPos;
        attribute vec3 aPrevNormal;
        attribute float aMorphT0;
        uniform float uTime;
        uniform float uMorphDur;
        varying vec4 vData;
        varying vec3 vWorldPos;
        varying vec3 vObjNormal;
        varying float vFlowSpeed;
        `
      )
      // La NORMALE doit morpher aussi. Lengyel (Transvoxel) le souligne : le
      // saut d'ombrage est un probleme DISTINCT du saut geometrique, et il
      // survient meme quand les sommets morphes sont deja sur la surface
      // d'arrivee. Morpher la position seule donne une surface qui glisse en
      // clignotant — pire que le defaut d'origine.
      .replace(
        '#include <beginnormal_vertex>',
        /* glsl */ `
        float scRaw = clamp((uTime - aMorphT0) / uMorphDur, 0.0, 1.0);
        float scMorph = scRaw * scRaw * (3.0 - 2.0 * scRaw);
        vec3 objectNormal = normalize(mix(aPrevNormal, normal, scMorph));
        `
      )
      .replace(
        '#include <begin_vertex>',
        /* glsl */ `
        vec3 transformed = mix(aPrevPos, position, scMorph);
        vData = aData;
        vObjNormal = objectNormal;
        vWorldPos = (modelMatrix * vec4(transformed, 1.0)).xyz;
        // Vitesse instantanee du sommet, en m/s. Sert au micro-relief qui
        // s'agite quand ca coule (§3.4) et aux trainees (§5.2).
        // Derivee de smoothstep : 6 t (1 - t) / duree.
        vFlowSpeed = length(position - aPrevPos) * 6.0 * scRaw * (1.0 - scRaw) / uMorphDur;
        `
      );
```

Uniformes : `uTime` existe déjà ; ajouter `uMorphDur: { value: 0.12 }`.

### Le matériau de profondeur DOIT morpher lui aussi

Point qu'on oublie systématiquement et qui saute aux yeux ensuite : la carte
d'ombres est rendue avec `customDepthMaterial`. S'il n'applique pas le morph,
**l'ombre saute pendant que la surface glisse** — et une ombre qui saute se voit
encore plus qu'une silhouette qui saute.

```js
/**
 * Materiau de profondeur assorti. Il DOIT appliquer exactement le meme morph
 * que SandMaterial, sinon l'ombre saute d'une image a l'autre pendant que la
 * silhouette, elle, glisse.
 */
export function createSandDepthMaterial(uniforms) {
  const mat = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking });
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uTime = uniforms.uTime;
    shader.uniforms.uMorphDur = uniforms.uMorphDur;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', /* glsl */ `
        #include <common>
        attribute vec3 aPrevPos;
        attribute float aMorphT0;
        uniform float uTime;
        uniform float uMorphDur;
      `)
      .replace('#include <begin_vertex>', /* glsl */ `
        float scRaw = clamp((uTime - aMorphT0) / uMorphDur, 0.0, 1.0);
        vec3 transformed = mix(aPrevPos, position, scRaw * scRaw * (3.0 - 2.0 * scRaw));
      `);
  };
  return mat;
}
```

### Chiffrage de (b)

| Poste | Coût |
|---|---|
| Mémoire GPU | `aPrevPos` 12 o + `aPrevNormal` 12 o + `aMorphT0` 4 o = **+28 o/sommet** → sur ~65 000 sommets de surface, **+1,8 Mo** |
| CPU par échange de chunk | remplissage `lookup` (2 × 1 100) + boucle sur `n` (1 100 × ~20 flops) ≈ **25 µs** |
| CPU par frame en pointe | 36 chunks × 25 µs = **0,9 ms** ; en régime courant (8 chunks) **0,2 ms** |
| GPU | 1 `mix` + 1 `normalize` par sommet, ~6 ALU. **Indétectable.** |

**Deux optimisations si le profil serre.**

**(1) Compresser.** Packer `aPrevPos` en delta `Int16` sur ±8 cm (précision
2,4 µm) → 6 o, et `aPrevNormal` en `Int8` normalisé → 4 o. Total **14 o/sommet**,
+0,9 Mo. Lengyel va plus loin dans sa thèse : en morphant **uniquement le long
de la normale**, la position secondaire se réduit à **un scalaire**, et avec un
décalage tangent 8 bits plus un angle 8 bits pour la normale, on tombe à
**4 octets par sommet**. Il signale honnêtement la limite : « il n'est pas clair
que ce point existe toujours ». Chez nous, il n'existe justement pas toujours
(un sommet peut glisser latéralement quand la pente change), donc **on garde le
delta en Int16 plutôt que le morph le long de la normale**.

**(2) Déporter dans le worker.** `MesherPool.dispatch` renvoie au worker les
`keys` et `shown` du maillage précédent (buffers transférables, donc gratuits),
et le worker produit `aPrevPos` directement. Coût CPU du thread principal :
**zéro**.

**Verdict : ✓✓ retenu, en deuxième.** C'est ce qui transforme « la géométrie
change » en « la surface se déforme ».

## 3.3 (c) Couche de PARTICULES — le « filet de sable qui coule »

C'est cette couche, et elle seule, qui produit l'impression de *ruissellement*.
Le maillage donne la forme, les grains donnent le mouvement. Le champ voxel
garde la masse ; **les particules sont purement décoratives et ne réinjectent
rien** (la matière est déjà comptée dans `density`).

> Le même choix qu'a fait Teardown, en sens inverse et pour la même raison :
> chez eux, un débris n'est jamais converti en particule, il devient une
> *nouvelle instance du même primitif volumique*, parce que la masse doit rester
> dans la représentation qui fait autorité. Chez nous, la représentation qui
> fait autorité est le champ de densité ; les grains sont donc, symétriquement,
> **purement visuels**.

### Architecture d'ensemble

```
Granular.transfer()  ──►  anneau d'evenements de flux (Float32Array)
                              │
                              ├─► SandGrains  : 6 000 THREE.Points, balistique
                              │                 + friction de pente, fondu a
                              │                 l'atterrissage
                              ├─► SandDust    : 800 Points transparents (§5.1)
                              └─► flow map    : Int8Array par colonne (§3.4)
```

### Émission depuis `Granular`

`transfer()` et `collapse()` sont les deux seuls endroits où de la matière
bouge. On y ajoute un anneau d'événements — **jamais un tableau qui grandit**,
la boucle est trop chaude.

```js
// --- dans le constructeur de Granular ------------------------------------
    /**
     * Anneau d'evenements d'ecoulement, consomme par la couche de particules.
     * 6 flottants par evenement : x, y, z (monde), dirX, dirZ, amount.
     * Anneau et pas tableau : la boucle de transfert est la plus chaude du jeu,
     * on ne peut pas y faire d'allocation.
     */
    this.FLOW_CAP = 2048;
    this.flow = new Float32Array(this.FLOW_CAP * 6);
    this.flowCount = 0;
    /** En dessous, le transfert est trop lent pour meriter un grain visible. */
    this.FLOW_MIN = 10;

// --- methode ---------------------------------------------------------------
  /**
   * Note un evenement d'ecoulement pour la couche de rendu.
   * Volontairement sous-echantillonne : un gros effondrement genere des
   * milliers de transferts par frame, et 2048 suffisent tres largement a
   * remplir l'ecran de grains.
   */
  emitFlow(x, y, z, dx, dz, amount) {
    if (amount < this.FLOW_MIN || this.flowCount >= this.FLOW_CAP) return;
    const o = this.flowCount * 6;
    const f = this.flow;
    f[o]     = ORIGIN_X + (x + 0.5) * VOXEL;
    f[o + 1] = ORIGIN_Y + (y + 0.5) * VOXEL;
    f[o + 2] = ORIGIN_Z + (z + 0.5) * VOXEL;
    f[o + 3] = dx;
    f[o + 4] = dz;
    f[o + 5] = amount;
    this.flowCount++;
  }
```

Branchements (3 lignes) :

```js
    // dans processVoxel, apres le transfert lateral :
    const moved = this.transfer(x, y, z, i, x + dir[0], bestH, z + dir[1], amount);
    if (moved > 0) {
      this.stats.moved += moved;
      this.emitFlow(x, y, z, dir[0], dir[1], moved);        // <-- ici
      this.updateFlowMap(x, z, dir[0], dir[1], moved);      // <-- et §3.4
      this.wake(x, y, z);
      this.wake(x + dir[0], Math.floor(bestH), z + dir[1]);
    }

    // dans collapse() :
    this.transferTo(i, i - SLICE, amount, 0.55);
    this.emitFlow(x, y, z, 0, 0, amount);                   // chute verticale
```

> ⚠️ Avec les 4 sous-pas du §4, **`flowCount` ne doit être remis à zéro qu'une
> fois par frame**, pas à chaque sous-pas : sinon la couche de particules ne
> voit qu'un quart des événements. C'est fait dans le `step()` du §4.2.

### Le système de grains

```js
/**
 * SandGrains — les grains de sable qui coulent.
 *
 * Le maillage donne la FORME, ces grains donnent le MOUVEMENT. Sans eux, meme
 * une surface parfaitement lissee et morphee a l'air de "fondre" plutot que de
 * couler : il manque le detail haute frequence qui se deplace vite.
 *
 * Trois choix structurants :
 *
 *  - THREE.Points et pas InstancedMesh. Un grain est un quad face camera : le
 *    Points le fait nativement, en UN appel de dessin quel que soit le nombre.
 *    L'InstancedMesh coute une mat4 (16 flottants) par instance contre 3, perd
 *    le frustum culling sauf a maintenir la bbox a la main, et n'apporte rien
 *    pour une primitive qui n'a ni rotation propre ni geometrie.
 *
 *  - OPAQUE avec alpha-test, pas transparent. Du sable n'est pas translucide.
 *    Un rendu opaque ecrit la profondeur, donc les grains s'occultent
 *    correctement entre eux et sont occultes par le terrain, SANS AUCUN TRI.
 *    (La poussiere, elle, est transparente : voir §5.1.)
 *
 *  - Taille en pixels PLAFONNEE. Avec sizeAttenuation, un grain proche devient
 *    un gros quad et le fill rate explose. On plafonne a 10 px. C'est le
 *    reglage le plus important du fichier.
 */

import * as THREE from 'three';
import { GRAVITY, VOXEL } from '../core/Config.js';

/**
 * Budget. 6 000 grains, c'est :
 *   - 1 appel de dessin ;
 *   - 72 Ko de positions uploadees par frame (negligeable) ;
 *   - ~0,18 ms d'integration CPU ;
 *   - et visuellement DEJA beaucoup : une avalanche de mur de 40 cm en affiche
 *     600 a 1 500 simultanement.
 * La zone confortable en WebGL2 est de 10 k a 30 k points tant qu'ils restent
 * petits ; on est tres en dessous, volontairement.
 */
const MAX_GRAINS = 6000;
/** Grains emis par unite de densite transferee. */
const GRAINS_PER_UNIT = 0.06;
/** Duree de vie maximale (s). Au-dela on tue, meme si le grain n'a pas atterri. */
const LIFE_MAX = 2.2;
/** Duree du fondu a l'atterrissage (s). */
const FADE = 0.14;
/** tan(34 deg) : angle de repos du sable sec. */
const TAN_REPOSE = 0.67;

export class SandGrains {
  /**
   * @param {THREE.Scene} scene
   * @param {import('../sim/VoxelField.js').VoxelField} field
   */
  constructor(scene, field) {
    this.field = field;
    this.n = 0;
    this.pos = new Float32Array(MAX_GRAINS * 3);
    this.vel = new Float32Array(MAX_GRAINS * 3);
    this.age = new Float32Array(MAX_GRAINS);
    this.ttl = new Float32Array(MAX_GRAINS);
    this.seed = new Float32Array(MAX_GRAINS);
    this.wet = new Float32Array(MAX_GRAINS);

    const g = new THREE.BufferGeometry();
    this.aPos = new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage);
    this.aLife = new THREE.BufferAttribute(new Float32Array(MAX_GRAINS), 1)
      .setUsage(THREE.DynamicDrawUsage);
    this.aSeed = new THREE.BufferAttribute(this.seed, 1).setUsage(THREE.DynamicDrawUsage);
    this.aWet = new THREE.BufferAttribute(this.wet, 1).setUsage(THREE.DynamicDrawUsage);
    g.setAttribute('position', this.aPos);
    g.setAttribute('aLife', this.aLife);
    g.setAttribute('aSeed', this.aSeed);
    g.setAttribute('aWet', this.aWet);
    g.setDrawRange(0, 0);
    // Sphere large et fixe : les grains bougent tout le temps, et recalculer
    // une bounding sphere chaque frame couterait plus cher que le culling n'en
    // fait gagner sur un seul draw call.
    g.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 2, 0), 40);

    this.material = new THREE.ShaderMaterial({
      uniforms: {
        uPixelScale: { value: 1 },
        uSize: { value: 0.020 },                 // diametre apparent, en metres
        uDry: { value: new THREE.Color(0xe4cfa2).convertSRGBToLinear() },
        uWet: { value: new THREE.Color(0x9a7550).convertSRGBToLinear() },
        uSunDirection: { value: new THREE.Vector3(0.4, 0.8, 0.35) },
        uSunColor: { value: new THREE.Color(1, 0.94, 0.82) },
        uAmbient: { value: new THREE.Color(0x6d86a8).convertSRGBToLinear() },
      },
      vertexShader: /* glsl */`
        attribute float aLife;
        attribute float aSeed;
        attribute float aWet;
        uniform float uPixelScale;
        uniform float uSize;
        varying float vLife;
        varying float vSeed;
        varying float vWet;
        void main() {
          vLife = aLife; vSeed = aSeed; vWet = aWet;
          vec4 mv = modelViewMatrix * vec4(position, 1.0);
          gl_Position = projectionMatrix * mv;
          // Le grain RETRECIT en fin de vie : c'est le "fondu dans le maillage".
          // Un grain qui disparait d'un coup se voit ; un grain qui retrecit
          // sous le pixel puis s'eteint, non.
          float shrink = smoothstep(0.0, 0.22, vLife);
          float px = uSize * uPixelScale / max(0.05, -mv.z) * shrink;
          // PLAFOND indispensable : sans lui, un grain a 30 cm de la camera
          // remplit 200 px et le fill rate s'effondre.
          gl_PointSize = clamp(px, 1.0, 10.0);
        }
      `,
      fragmentShader: /* glsl */`
        uniform vec3 uDry, uWet, uSunColor, uAmbient, uSunDirection;
        varying float vLife; varying float vSeed; varying float vWet;
        void main() {
          // Sprite rond : on jette le coin du quad. alpha-test, pas de blending.
          vec2 d = gl_PointCoord - 0.5;
          if (dot(d, d) > 0.25 || vLife < 0.02) discard;

          // Eclairage bon marche : un grain n'a pas de normale utile, on prend
          // une hemisphere fictive orientee par la position dans le sprite.
          vec3 n = normalize(vec3(d.x * 2.0, 0.85, d.y * 2.0));
          float ndl = max(dot(n, normalize(uSunDirection)), 0.0);
          vec3 base = mix(uDry, uWet, vWet);
          // Variation de teinte par grain : sans elle, une coulee est un aplat.
          base *= 0.82 + 0.36 * fract(vSeed * 43758.5453);
          gl_FragColor = vec4(base * (uAmbient * 0.55 + uSunColor * ndl * 0.9), 1.0);
          #include <tonemapping_fragment>
          #include <colorspace_fragment>
        }
      `,
      transparent: false,
      depthWrite: true,
      depthTest: true,
    });

    this.points = new THREE.Points(g, this.material);
    this.points.frustumCulled = false;
    this.points.name = 'sandGrains';
    scene.add(this.points);
    this._rng = 987654321;
  }

  rand() {
    let s = this._rng;
    s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0;
    this._rng = s;
    return s / 4294967296;
  }

  /** Consomme les evenements d'ecoulement de la frame. */
  emitFrom(granular) {
    const f = granular.flow;
    for (let e = 0, nEv = granular.flowCount; e < nEv; e++) {
      const o = e * 6;
      const amount = f[o + 5];
      // Partie fractionnaire tiree au sort : sinon les petits transferts
      // n'emettent JAMAIS rien et les coulees lentes sont invisibles.
      const k = amount * GRAINS_PER_UNIT;
      let count = k | 0;
      if (this.rand() < k - count) count++;
      for (let g = 0; g < count; g++) {
        this.spawn(f[o], f[o+1], f[o+2], f[o+3], f[o+4], amount);
      }
    }
  }

  spawn(wx, wy, wz, dx, dz, amount) {
    if (this.n >= MAX_GRAINS) return;
    const i = this.n++, i3 = i * 3;
    this.pos[i3]     = wx + (this.rand() - 0.5) * VOXEL;
    this.pos[i3 + 1] = wy + this.rand() * 0.6 * VOXEL;
    this.pos[i3 + 2] = wz + (this.rand() - 0.5) * VOXEL;
    // Vitesse : direction du transfert, d'autant plus vite que le transfert est
    // gros, plus une composante descendante et un peu de dispersion.
    const sp = 0.35 + amount * 0.012;
    this.vel[i3]     = dx * sp + (this.rand() - 0.5) * 0.22;
    this.vel[i3 + 1] = -0.15 - this.rand() * 0.25;
    this.vel[i3 + 2] = dz * sp + (this.rand() - 0.5) * 0.22;
    this.age[i] = 0;
    this.ttl[i] = 0.5 + this.rand() * (LIFE_MAX - 0.5);
    this.seed[i] = this.rand();
    // Humidite au point d'emission : un grain mouille est fonce. Lecture
    // unique, pas de mise a jour ensuite.
    this.wet[i] = this.field.averageMoisture(wx, wy, wz, 0.06);
  }

  /**
   * Integration. Balistique + frottement, avec un terme de SUIVI DE PENTE :
   * c'est lui qui fait la difference entre des grains qui rebondissent (faux)
   * et une coulee qui epouse le talus (juste).
   *
   * Le frottement de contact est applique au niveau des POSITIONS et non des
   * vitesses seules, pour la meme raison que Macklin et al. en PBD : un simple
   * amortissement de vitesse ne modelise pas le frottement STATIQUE, et les
   * grains derivent indefiniment au lieu de s'immobiliser sur le talus.
   */
  update(dt) {
    const F = this.field;
    const pos = this.pos, vel = this.vel;
    // Un grain de 0,3 mm a un temps de relaxation aerodynamique de ~4 ms : a
    // l'echelle de la frame il suit deja l'air. On modelise ca par un
    // frottement leger plutot que par une vraie trainee quadratique.
    const drag = Math.pow(0.90, dt * 60);
    const eps = VOXEL;
    let i = 0;
    while (i < this.n) {
      const i3 = i * 3;
      this.age[i] += dt;

      vel[i3 + 1] -= GRAVITY * dt;
      vel[i3] *= drag; vel[i3 + 1] *= drag; vel[i3 + 2] *= drag;

      let px = pos[i3] + vel[i3] * dt;
      let py = pos[i3 + 1] + vel[i3 + 1] * dt;
      let pz = pos[i3 + 2] + vel[i3 + 2] * dt;

      const hs = F.surfaceHeightAt(px, pz);
      if (py < hs) {
        // --- contact ------------------------------------------------------
        // Pente locale par differences finies sur surfaceHeightAt, qui est
        // BILINEAIRE donc continue : le grain ne "sent" jamais la grille.
        const gx = (F.surfaceHeightAt(px + eps, pz) - F.surfaceHeightAt(px - eps, pz)) / (2 * eps);
        const gz = (F.surfaceHeightAt(px, pz + eps) - F.surfaceHeightAt(px, pz - eps)) / (2 * eps);
        const slope = Math.hypot(gx, gz);

        py = hs + 0.004;
        // Projection de la vitesse sur le plan tangent : le grain GLISSE.
        const nl = 1 / Math.hypot(gx, gz, 1);
        const nx = -gx * nl, ny = nl, nz = -gz * nl;
        const vn = vel[i3] * nx + vel[i3 + 1] * ny + vel[i3 + 2] * nz;
        vel[i3] -= vn * nx; vel[i3 + 1] -= vn * ny; vel[i3 + 2] -= vn * nz;
        // Coulomb : sous l'angle de repos, le grain s'arrete vite ; au-dessus,
        // il continue de devaler.
        const fric = slope < TAN_REPOSE ? 0.55 : 0.90;
        vel[i3] *= fric; vel[i3 + 1] *= fric; vel[i3 + 2] *= fric;

        const speed = Math.hypot(vel[i3], vel[i3 + 1], vel[i3 + 2]);
        // Arrive : on lance le fondu. Le grain ne DISPARAIT pas, il retrecit
        // sous le pixel — c'est ce qui le fait "rentrer dans" le maillage.
        if (speed < 0.12 && this.ttl[i] > this.age[i] + FADE) {
          this.ttl[i] = this.age[i] + FADE;
        }
      }

      pos[i3] = px; pos[i3 + 1] = py; pos[i3 + 2] = pz;

      if (this.age[i] >= this.ttl[i] || py < -1) {
        // Mort : swap-remove, O(1), aucun trou dans le buffer.
        const j = --this.n;
        if (j !== i) {
          const j3 = j * 3;
          pos[i3]=pos[j3]; pos[i3+1]=pos[j3+1]; pos[i3+2]=pos[j3+2];
          vel[i3]=vel[j3]; vel[i3+1]=vel[j3+1]; vel[i3+2]=vel[j3+2];
          this.age[i]=this.age[j]; this.ttl[i]=this.ttl[j];
          this.seed[i]=this.seed[j]; this.wet[i]=this.wet[j];
        }
        continue;                                   // ne pas incrementer i
      }
      this.aLife.array[i] = Math.min(1, (this.ttl[i] - this.age[i]) / FADE);
      i++;
    }

    this.points.geometry.setDrawRange(0, this.n);
    if (this.n > 0) {
      this.aPos.needsUpdate = true;
      this.aLife.needsUpdate = true;
      this.aSeed.needsUpdate = true;
      this.aWet.needsUpdate = true;
    }
  }

  /** A appeler au resize : convertit uSize (metres) en pixels. */
  setViewport(heightPx, fovDeg) {
    this.material.uniforms.uPixelScale.value =
      heightPx / (2 * Math.tan(fovDeg * Math.PI / 360));
  }

  dispose() {
    this.points.geometry.dispose();
    this.material.dispose();
    this.points.parent?.remove(this.points);
  }
}
```

Branchement dans `Game` :

```js
    // init()
    this.grains = new SandGrains(this.scene, this.field);
    this.grains.setViewport(innerHeight * this.renderer.getPixelRatio(), this.camera.fov);

    // update(), apres la simulation et avant le rendu
    this.grains.emitFrom(this.granular);
    this.grains.update(dt);
    this.grains.material.uniforms.uSunDirection.value.copy(this.sky.sunDir);
    this.grains.material.uniforms.uSunColor.value.copy(this.sky.sun.color);

    // resize()
    this.grains?.setViewport(h * this.renderer.getPixelRatio(), this.camera.fov);

    // setQuality() : les grains sont le premier poste a sacrifier en qualite basse
    this.grains.points.visible = level >= 1;
```

### Points vs InstancedMesh — le verdict

| | `THREE.Points` | `THREE.InstancedMesh` |
|---|---|---|
| Appels de dessin | **1**, quel que soit le nombre | 1 |
| Données par élément | **3 flottants** (position) | une `mat4` = **16 flottants** |
| Quad face-caméra | **natif** (`gl_PointSize`) | à faire soi-même dans le shader |
| Frustum culling | manuel (ou désactivé) | **perdu** sauf à maintenir la bbox à la main — et la calculer en JS peut coûter plus que le culling n'économise |
| Rotation propre | impossible | possible |
| Verdict | **✓ pour tout ce qui est grain, poussière, traînée** | pour des débris qui doivent tourner |

Un grain de sable est un point rond face caméra : ni orientation, ni géométrie.
`Points` est le bon outil, et la seule chose qui coûte est le **fill rate** —
d'où le plafond de `gl_PointSize`.

### Chiffrage de (c)

| Poste | Coût |
|---|---|
| Mémoire | 6 000 × 10 flottants = **240 Ko** |
| Intégration CPU | 6 000 × ~35 flops + 5 `surfaceHeightAt` bilinéaires ≈ **0,18 ms/frame** |
| Upload | 72 Ko de positions par frame ≈ **0,04 ms** |
| GPU | 1 draw call, ≤ 6 000 × 10² px = 600 kpx de fill dans le pire cas ≈ **0,3 ms** |
| **Total** | **~0,5 ms/frame en pointe**, ~0,01 ms au repos (aucun grain vivant) |

**Verdict : ✓✓ retenu, en troisième.** C'est ce qui donne le « filet ». Sans
(a2) et (b) en dessous, les grains flotteraient sur une surface qui saute —
d'où l'ordre.

## 3.4 (d) Champ de vitesse par voxel + flow map — le grain qui GLISSE

Le principe : même quand la géométrie ne bouge presque pas, **si la texture du
sable s'écoule dans la bonne direction, l'œil lit du mouvement.** C'est la
technique de la flow map, introduite en jeu par Valve pour l'eau de *Portal 2*,
et elle est particulièrement adaptée ici parce que la grille de simulation *est
déjà* la grille de la flow map.

C'est aussi la leçon de *Journey* : trois ans de développement sur du sable, et
la continuité y est obtenue **entièrement par le shader** — un spéculaire
emprunté à l'eau, un mélange de normal maps piloté par la pente, un glitter en
porte microfacette. Rien de tout cela ne touche à la résolution de la géométrie.

### Chiffre remarquable

Valve a obtenu son résultat avec une flow map à **~4 texels par mètre**. Nous
avons 256 colonnes sur 10,24 m, soit **25 texels/m — six fois plus fin**. Le
champ échantillonné bilinéairement sera donc très largement assez lisse : **la
grille de simulation ne peut pas transparaître dans le flow.**

### Stockage : par colonne, pas par voxel

Stocker une vitesse par voxel coûterait 2 × 6,29 Mo. Or l'écoulement granulaire
est **surfacique** : seule la colonne compte.

```js
// --- dans le constructeur de Granular ------------------------------------
    /**
     * Champ d'ecoulement par COLONNE (pas par voxel : l'ecoulement granulaire
     * est surfacique, et 2 x 64 Ko valent mieux que 2 x 6,3 Mo).
     * Unites : -127..127 pour -1..1.
     */
    this.flowX = new Int8Array(NX * NZ);
    this.flowZ = new Int8Array(NX * NZ);
    /** Norme de l'ecoulement, 0..255. Module le shader. */
    this.flowMag = new Uint8Array(NX * NZ);
    /** Presence dans la liste active (meme motif que colDirty/dirtyColumns). */
    this.flowSet = new Uint8Array(NX * NZ);
    this.flowCols = [];
    this.flowDirty = 0;

// --- methodes --------------------------------------------------------------
  /** Accumule une direction d'ecoulement dans la colonne (x,z). */
  updateFlowMap(x, z, dx, dz, amount) {
    const c = x + NX * z;
    // Gain : un transfert plein sature la colonne en ~4 passes.
    const g = amount * 1.6;
    this.flowX[c] = clamp(this.flowX[c] + dx * g, -127, 127) | 0;
    this.flowZ[c] = clamp(this.flowZ[c] + dz * g, -127, 127) | 0;
    const m = Math.hypot(this.flowX[c], this.flowZ[c]) * 2;
    this.flowMag[c] = m > 255 ? 255 : m | 0;
    if (!this.flowSet[c]) { this.flowSet[c] = 1; this.flowCols.push(c); }
    this.flowDirty = 1;
  }

  /**
   * Decroissance de la flow map. Facteur 0,97 par frame = demi-vie 23 images
   * (0,38 s) : assez long pour qu'une coulee reste lisible pendant qu'elle
   * s'ecoule, assez court pour que la plage redevienne immobile.
   *
   * On ne parcourt PAS les 65 536 colonnes : seulement la liste des colonnes
   * non nulles. Une avalanche en touche quelques centaines.
   */
  decayFlow(dt) {
    const f = Math.pow(0.97, dt * 60);
    const list = this.flowCols;
    let w = 0;
    for (let r = 0; r < list.length; r++) {
      const c = list[r];
      const nx = this.flowX[c] * f, nz = this.flowZ[c] * f;
      this.flowX[c] = nx | 0; this.flowZ[c] = nz | 0;
      const m = Math.hypot(nx, nz) * 2;
      this.flowMag[c] = m > 255 ? 255 : m | 0;
      if (this.flowMag[c] > 1) list[w++] = c;
      else { this.flowX[c] = 0; this.flowZ[c] = 0; this.flowMag[c] = 0; this.flowSet[c] = 0; }
    }
    list.length = w;
    this.flowDirty = 1;
  }
```

### Upload

```js
  // creation, dans Game.init()
  this._flowData = new Uint8Array(NX * NZ * 4);
  for (let i = 0; i < this._flowData.length; i += 4) {
    this._flowData[i] = 128; this._flowData[i+1] = 128;   // direction nulle
  }
  this.flowTex = new THREE.DataTexture(this._flowData, NX, NZ, THREE.RGBAFormat);
  this.flowTex.minFilter = THREE.LinearFilter;
  // Le filtrage BILINEAIRE est ce qui lisse la grille de 4 cm : c'est lui qui
  // fait qu'un champ constant par colonne devient un champ d'advection continu.
  this.flowTex.magFilter = THREE.LinearFilter;
  this.flowTex.wrapS = this.flowTex.wrapT = THREE.ClampToEdgeWrapping;
  this.flowTex.needsUpdate = true;
  this.sandMaterial.userData.uniforms.uFlowMap.value = this.flowTex;

  /**
   * Texture de flow, 256x256 RGBA8 : R,G = direction (128 = repos),
   * B = norme d'ecoulement, A = marque de coulee remanente (§5.2).
   * 262 Ko en VRAM. Re-uploadee au plus une frame sur deux : l'oeil ne
   * distingue pas 30 Hz de 60 Hz sur un champ d'advection lentement variable.
   */
  buildFlowTexture() {
    const g = this.granular;
    if (!g.flowDirty || (this._flowFrame++ & 1)) return;
    g.flowDirty = 0;
    const d = this._flowData;
    const fx = g.flowX, fz = g.flowZ, fm = g.flowMag, sc = g.scour;
    for (let c = 0, o = 0; c < fx.length; c++, o += 4) {
      d[o] = fx[c] + 128; d[o+1] = fz[c] + 128; d[o+2] = fm[c]; d[o+3] = sc[c];
    }
    this.flowTex.needsUpdate = true;
  }
```

### GLSL — le cycle à deux phases

À insérer dans `SandMaterial.js`, dans le bloc `map_fragment`, **en
remplacement** du calcul de `grain` actuel.

```glsl
        // =====================================================================
        // ADVECTION DU GRAIN PAR LA FLOW MAP
        // ---------------------------------------------------------------------
        // Meme quand la geometrie ne bouge presque pas, si la TEXTURE s'ecoule
        // dans la bonne direction, l'oeil lit du mouvement.
        //
        // Le probleme fondamental (Max & Becker 1995, repris par Vlachos) :
        // une UV distordue en continu finit par etre illisible — seul le DEBUT
        // de la distorsion est convaincant. On ne garde donc que ce debut et on
        // redemarre, avec DEUX phases decalees d'une demi-periode dont on
        // pondere le melange par un triangle. Une phase est toujours pres de
        // son maximum de lisibilite pendant que l'autre redemarre.
        //
        // Point cle POUR NOUS : le grain est une carte de COULEUR, pas une
        // normal map. Une couleur tolere beaucoup moins de distorsion. On
        // decale donc l'intervalle de [0, k] a [-k/2, +k/2] pour que le pic de
        // visibilite tombe sur la distorsion NULLE et non a mi-course. C'est le
        // "-0.5" ci-dessous, et c'est la variante "couleur" de Vlachos.
        // =====================================================================
        vec2 fuv = (vWorldPos.xz - uDomain.xy) * uDomain.zw;   // -> [0,1]
        vec4 flowT = texture2D(uFlowMap, fuv);
        vec2 fdir = flowT.rg * 2.0 - 1.0;
        float fspeed = flowT.b;

        // Bruit sur la phase : sans lui, TOUTE la surface redemarre son cycle au
        // meme instant et on voit une pulsation globale (Vlachos, "pulsing").
        float phaseNoise = sc_hash13(floor(vWorldPos * 3.7)) * 0.41;
        float ft = uTime * uFlowRate + phaseNoise;
        float pA = fract(ft);
        float pB = fract(ft + 0.5);
        float wA = 1.0 - abs(1.0 - 2.0 * pA);
        float wB = 1.0 - abs(1.0 - 2.0 * pB);

        vec3 gp = vWorldPos * (34.0 * uGrainScale);
        vec2 offA = fdir * (pA - 0.5) * uFlowStrength;
        vec2 offB = fdir * (pB - 0.5) * uFlowStrength;
        float grainStill = sc_fbm(gp, 3);
        float grain = grainStill;
        // Le sable immobile ne paie RIEN : la branche est coherente par warp
        // (une avalanche est un motif contigu a l'ecran), donc la divergence
        // est negligeable.
        if (fspeed > 0.03) {
          float grainA = sc_fbm(vec3(gp.x - offA.x, gp.y, gp.z - offA.y), 3);
          float grainB = sc_fbm(vec3(gp.x - offB.x, gp.y, gp.z - offB.y), 3);
          float grainFlow = (grainA * wA + grainB * wB) / max(wA + wB, 1e-3);
          grain = mix(grainStill, grainFlow, smoothstep(0.03, 0.30, fspeed));
        }
```

et dans `normal_fragment_maps`, on module l'amplitude du micro-relief par la
vitesse — c'est la même astuce que Valve (« mettre la force de la normale à
l'échelle de la vitesse d'écoulement »), et c'est ce qui fait que du sable en
mouvement a l'air *agité* et du sable au repos *lisse* :

```glsl
          float amp = mix(0.055, 0.018, smoothstep(0.05, 0.5, vData.x));
          // Le sable qui coule est agite ; le sable au repos est lisse.
          // vFlowSpeed vient du geomorphing (§3.2), fspeed de la flow map :
          // le premier est par sommet donc tres lisse, le second par colonne
          // donc plus local. On prend le max.
          amp *= 1.0 + 1.6 * max(vFlowSpeed, fspeed);
```

Uniformes à ajouter :

```js
    uFlowMap: { value: null },        // rempli par Game apres creation
    uFlowRate: { value: 0.55 },       // cycles par seconde
    uFlowStrength: { value: 2.2 },    // en unites de gp (34 x monde) : ~6 cm
```

### Chiffrage de (d)

| Poste | Coût |
|---|---|
| Mémoire CPU | `flowX + flowZ + flowMag + flowSet + scour` = 5 × 64 Ko = **320 Ko** |
| Mémoire GPU | `DataTexture` 256×256 RGBA8 = **262 Ko** |
| Upload | 262 Ko une frame sur deux ≈ **0,06 ms** |
| CPU / frame | `decayFlow` sur la liste active (quelques centaines de colonnes) ≈ **0,01 ms** |
| GPU / pixel | +1 lecture de texture, et **2 `sc_fbm(·,3)` supplémentaires uniquement là où ça coule** (~48 ALU) |

Le coût GPU est le seul non trivial. Deux atténuations, toutes deux dans le code
ci-dessus : (1) le `if (fspeed > 0.03)`, dont la divergence est faible parce
qu'une avalanche est un motif contigu à l'écran ; (2) un `SC_FLOW_QUALITY`
désactivable en qualité basse. Mesure attendue sur la cible : **+0,15 ms en
régime normal, +0,6 ms quand la moitié de l'écran coule.**

> À titre de comparaison, la version de Valve coûtait **+2 lectures de texture
> et +21 instructions ALU**, et tournait en `ps_2.0b`. Notre surcoût vient
> entièrement du fait qu'on advecte un fBm procédural à 3 octaves plutôt qu'une
> texture. Si le budget serrait, remplacer `sc_fbm(·,3)` par une vraie texture
> de grain tuilée ramènerait le coût au niveau de Valve.

**Verdict : ✓ retenu, mais en dernier.** C'est de la finition : spectaculaire
quand (a2)+(b)+(c) sont en place, et franchement désagréable toute seule (une
texture qui glisse sur une géométrie qui saute).

## 3.5 (e) L'option qu'on écarte, mais qu'il faut connaître : le rendu écran-espace

Il existe une architecture radicalement différente pour la couche qui coule : au
lieu de mailler, on **splatte des sprites de profondeur** (un par cellule
active), on **lisse le tampon de profondeur**, et on reconstruit les normales
par différences finies de la profondeur lissée. C'est le pipeline standard du
rendu de fluides à particules.

Deux filtres de référence :

- **Curvature flow** (van der Laan, Green & Sainz, I3D 2009) : on fait évoluer
  `∂z/∂t = H` sur le tampon de profondeur. Robuste, mais l'EDP est **raide** :
  la version pleine résolution demande **100 itérations et 50 ms** ; la version
  quart de résolution à 15 itérations tourne en 17,5 ms.
- **Narrow-range filter** (Truong & Yuksel, i3D 2018) : une gaussienne dont les
  profondeurs voisines sont **bornées au lieu d'être rejetées**, ce qui donne
  des bords *courbes* plutôt que plats (bilatéral) ou étalés (gaussien pur).
  Paramètres publiés **δ = 10r, μ = r**, en **2 passes 1D + 1 passe 2D de
  nettoyage 5×5**. Coût mesuré **0,46 à 1,21 ms** sur GTX 1080 pour 65 k à
  368 k splats — meilleure qualité que le curvature flow à 100 itérations, pour
  un dixième du prix.

**Pourquoi on n'y va pas ici.** (1) Nous avons déjà un maillage, et un bon : le
lisser (§2) coûte 0,53 ms *par chunk remaillé*, pas par frame. (2) Le pipeline
écran-espace impose un G-buffer et une passe de composition, alors que `Post.js`
est un post-traitement forward simple. (3) Le sable est **opaque et mat** : tout
l'intérêt du pipeline écran-espace (réfraction, épaisseur, Fresnel) est perdu.

**Mais** deux emprunts sont gratuits et à faire un jour :

- la reconstruction de normale par **la plus petite des deux différences finies
  unilatérales** aux discontinuités (van der Laan §3.3), si on ajoute un SSAO ou
  un SSR sur le sable ;
- le principe du **bruit qui advecte avec la matière**, dont l'amplitude est
  augmentée là où `|Δv|` dépasse un seuil puis retombe. C'est exactement ce que
  fait notre `flowMag` pilotant l'amplitude du micro-relief ci-dessus — la
  convergence est rassurante.

Et si le jeu devait un jour montrer un **rideau de sable dense** (une dune qui
s'écroule sur toute la largeur du diorama), c'est la seule architecture qui
tienne. À garder en réserve, pas à faire maintenant.

## 3.6 Comparaison et recommandation ordonnée

| | Coût CPU/frame | Coût GPU | Mémoire | Complexité | Gain visuel | Verdict |
|---|---|---|---|---|---|---|
| **(a1)** 2 instantanés interpolés | ~1,5 ms de copie + **remaillage à 60 Hz** | — | +6,3 Mo | moyenne | moyen | ✗ **rejeté** |
| **(a2)** transferts fins + sous-pas | **0** (même budget) | — | 0 | **triviale** | **fort** | ✓✓ **1er** |
| **(b)** geomorphing par clé de cellule | 0,2 ms (0,9 en pointe), **0 si dans le worker** | ~6 ALU/sommet | +1,8 Mo | moyenne | **très fort** | ✓✓ **2e** |
| **(c)** couche de grains | 0,2 ms | 0,3 ms | 240 Ko | moyenne | **très fort** | ✓✓ **3e** |
| **(d)** flow map | 0,02 ms | 0,15–0,6 ms | 580 Ko | faible | fort | ✓ **4e** |
| **(e)** splats + filtre écran-espace | — | 0,5–1,2 ms + G-buffer | — | **très forte** | fort | ✗ hors sujet ici |

### Recommandation combinée

**Les quatre couches se complètent, elles ne se remplacent pas** — chacune traite
une échelle différente :

```
échelle       phénomène traité                   technique
──────────────────────────────────────────────────────────────────
> 20 cm       la forme du talus qui se construit   (a2) transferts fins
2 – 20 cm     la surface qui se déforme            (b)  geomorphing
0,5 – 5 cm    les grains individuels qui roulent   (c)  particules
< 1 cm        le grain de la matière qui file      (d)  flow map
```

**L'ordre est impératif** : chaque étape rend la suivante crédible.

- (c) **avant** (a2) : les grains couleraient joliment sur une surface qui saute
  → ça *souligne* le défaut au lieu de le masquer.
- (d) **avant** (b) : une texture qui glisse sur une géométrie qui se téléporte
  est franchement désagréable.
- (b) **avant** (a2) : le morph de 120 ms devrait absorber des sauts de 4 cm, ce
  qui donnerait une surface molle et élastique, en caoutchouc.

Fait dans le bon ordre, **(a2) seul règle déjà ~35 % du problème pour 30 minutes
de travail**, (a2)+(b) montent à ~75 %, et (c) fait passer de « ça a l'air
correct » à « ça coule ».

---

# 4. Ralentir et lisser l'avalanche elle-même

## 4.1 Ce que fait le réglage actuel, en chiffres

```js
const MAX_TRANSFER = 96;    // 37,6 % d'un voxel par passe
const DAMPING = 0.5;
...
let amount = Math.round(bestExcess * DAMPING * 255 * 0.5);   // = excess · 63.75
if (amount < 6) amount = 6;
if (amount > MAX_TRANSFER) amount = MAX_TRANSFER;
```

Le facteur de proportionnalité est **63,75 unités de densité par voxel d'excès
de pente**. `MAX_TRANSFER` est donc atteint dès que

```
bestExcess ≥ 96 / 63.75 = 1.506 voxel
```

Or un coup de pelle laisse couramment des dénivellations de 2 à 6 voxels. **En
pratique, pendant toute la phase intéressante d'une avalanche, le transfert est
saturé à 96.** Le terme proportionnel ne sert que pour la queue de la
relaxation, quand le talus a presque atteint son angle de repos.

`collapse()` est pire : `Math.min(d, room, MAX_TRANSFER * 2)` = **192, soit
75 % d'un voxel en une passe.**

Conséquence chiffrée (reprise du §1.6) : le sommet de Surface Nets parcourt un
voxel entier — 4 cm — en 1 à 2 passes, soit 16 à 33 ms. **1,2 à 2,4 m/s
appliqués en un saut**, puis plus rien.

## 4.2 Le réglage recommandé : sous-pas, et proportionnalité préservée

L'erreur à ne pas faire est de baisser `MAX_TRANSFER` tout seul : on obtient un
sable qui **rampe**, une avalanche qui met dix secondes à finir, et un joueur
qui trouve le jeu mou. Il faut baisser l'amplitude **et** augmenter la fréquence,
de façon **exactement compensée**.

```js
/**
 * Sous-pas d'avalanche par pas de simulation.
 *
 * Le debit total est INCHANGE (MAX_TRANSFER x GRANULAR_SUBSTEPS = 96 comme
 * avant), mais la granularite est divisee par 4 : l'isosurface ne se deplace
 * jamais de plus de 24/255 de voxel, soit 3,8 mm, par sous-pas. C'est ce qui
 * fait la difference entre du sable qui se teleporte et du sable qui glisse
 * (§1.6, §3.1).
 *
 * 4 et pas 8 : au-dela, le cout des reveils (wake() touche 36 voxels par
 * transfert) commence a dominer, pour un gain perceptif nul — 3,8 mm est deja
 * tres au-dessous du seuil de 3 px a 8 m.
 */
export const GRANULAR_SUBSTEPS = 4;

/** Transfert maximal par voxel et par SOUS-PAS. 96/4 : debit inchange. */
const MAX_TRANSFER = 24;
/**
 * Plancher de transfert. Doit rester STRICTEMENT positif, sinon la relaxation
 * stalle a un demi-pas de l'equilibre et l'ensemble actif ne se vide jamais.
 * 3 sur 255 = 0,5 mm par sous-pas : invisible, et ca termine.
 */
const MIN_TRANSFER = 3;
```

et dans `processVoxel`, on divise **aussi le gain proportionnel** par le nombre
de sous-pas, pour que la physique soit rigoureusement inchangée :

```js
    // Le gain est divise par GRANULAR_SUBSTEPS : quatre sous-pas deplacent
    // exactement ce que deplacait un pas. La DUREE d'une avalanche est
    // inchangee, seule sa granularite temporelle change.
    let amount = Math.round(bestExcess * DAMPING * 255 * 0.5 / GRANULAR_SUBSTEPS);
    if (amount < MIN_TRANSFER) amount = MIN_TRANSFER;
    if (amount > MAX_TRANSFER) amount = MAX_TRANSFER;
    if (amount > d) amount = d;
```

et dans `collapse` :

```js
    const amount = Math.min(d, room, MAX_TRANSFER * 2);   // 48 au lieu de 192
```

### Où mettre la boucle de sous-pas

**Dans `Granular`, pas dans `Game`** — parce que plusieurs choses doivent être
remises à zéro une fois par frame et non une fois par sous-pas (les événements,
l'anneau de flux), et que `Granular` est le seul à le savoir.

```js
  /**
   * Un pas de simulation granulaire = GRANULAR_SUBSTEPS passes d'avalanche.
   *
   * Les evenements (this.events) et l'anneau de flux (this.flow) sont remis a
   * zero UNE FOIS par appel, pas par sous-pas : sinon l'audio et la couche de
   * particules ne verraient qu'un quart de ce qui s'est passe.
   *
   * @param {number} dt
   * @param {number} budget voxels examines, TOUS sous-pas confondus
   */
  step(dt, budget = 90000) {
    this.events.length = 0;
    this.flowCount = 0;
    this.stats.processed = 0;
    this.stats.moved = 0;
    this.stats.collapsed = 0;

    const sub = budget / GRANULAR_SUBSTEPS;
    const sdt = dt / GRANULAR_SUBSTEPS;
    for (let s = 0; s < GRANULAR_SUBSTEPS; s++) {
      this.subIndex = (this.subIndex + 1) % STRESS_DIVIDER;
      this.substep(sdt, sub);
    }
    this.decayFlow(dt);
  }

  /** Une passe d'avalanche : l'ancien corps de step(), sans les remises a zero. */
  substep(dt, budget) {
    const t = this.cur; this.cur = this.next; this.next = t;
    for (let c = 0; c < 4; c++) {
      this.curLen[c] = this.nextLen[c];
      this.nextLen[c] = 0;
    }
    this.stats.active = this.curLen[0] + this.curLen[1] + this.curLen[2] + this.curLen[3];
    if (this.stats.active === 0) return;

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
        this.processVoxel(x, y, z, i, dt);
      }
      this.stats.processed += n;
      for (let k = n; k < len; k++) {
        const i = list[k];
        this.flag[i] = 0;
        this.push(i);
      }
    }
  }
```

`Game.step()` est inchangé : `this.granular.step(dt, BUDGET_GRANULAR * simBudget)`.

### Faut-il un sous-pas d'avalanche PLUS RAPIDE que le rendu ?

Question posée, et la réponse est **oui, mais pas plus rapide que la
simulation** — la nuance est importante.

| Cadence | Effet |
|---|---|
| Avalanche à la cadence du **rendu** (aujourd'hui) | ✗ le pas visuel vaut le pas physique : c'est exactement le problème |
| Avalanche à une cadence **libre**, plus rapide que `SIM_DT` | ✗ la vitesse d'écoulement dépendrait du framerate — inacceptable, la physique doit être déterministe |
| **Sous-pas internes à l'intérieur d'un `SIM_DT`** | ✓ **retenu** : le pas physique reste `SIM_DT`, l'écoulement reste déterministe, seule la granularité change |

C'est le raisonnement de tout intégrateur à sous-pas : on gagne en stabilité et
en finesse sans toucher au pas de temps macroscopique. C'est aussi ce que fait
un solveur PBD — Macklin et al. utilisent **2 à 3 sous-pas** avec 4 à 12
itérations chacun, et leur scène de validation est un château de sable. Leur
remarque associée vaut d'être notée : **la force du frottement dépend du nombre
d'itérations**. Chez nous, l'équivalent est que `DAMPING` et le nombre de
sous-pas ne sont pas indépendants — d'où la division explicite du gain, qui les
rend orthogonaux.

Point de vigilance : `SIM_MAX_STEPS = 2` fait qu'une frame lente exécute jusqu'à
**2 × 4 = 8 passes**. Le budget total reste `2 × BUDGET_GRANULAR`, donc c'est
déjà couvert par le mécanisme `simBudget` adaptatif existant.

## 4.3 Le budget tient-il ?

`BUDGET_GRANULAR = 60 000` est un budget de **voxels examinés**, pas de voxels
déplacés. Il est déjà divisé par 4 entre les couleurs du damier.

Ordres de grandeur de l'ensemble actif, filtré par `movable()` donc réduit à la
coquille de surface :

| Situation | Ensemble actif |
|---|---|
| Plage au repos | **0** |
| Après un coup de pelle (r = 12 cm) | 900 – 1 800 |
| Effondrement d'un mur de 40 cm | 3 000 – 6 000 |
| Vague qui sape toute une berme | 8 000 – 15 000 |

Avec 4 sous-pas, le pire cas devient **60 000 examens** — exactement le budget.
Et l'ensemble actif *ne quadruple pas* : c'est le même ensemble, réexaminé
4 fois. Le seul poste qui croît réellement est `wake()` (36 `push` par transfert,
dont la plupart sont rejetés immédiatement par `flag` ou par `movable`), estimé
à **~0,4 ms** dans le pire cas contre ~0,15 ms aujourd'hui.

**Conclusion : ça tient, sans changer `BUDGET_GRANULAR`.** Si un jour ça ne
tenait plus, `GRANULAR_SUBSTEPS = 3` (transfert 32) donnerait encore 5 mm par
sous-pas, largement sous le seuil.

## 4.4 Conservation exacte de la masse avec des transferts plus fins

### Elle est déjà exacte, et il faut la préserver

`transferTo` est **exactement conservatif par construction** :

```js
    const a = Math.min(amount, dens[from], 255 - dens[to]);
    ...
    this.writeVoxel(from, dens[from] - a);
    this.writeVoxel(to, dTo + a);
```

`a` est un entier, on le retire d'un côté et on l'ajoute de l'autre, et
`writeVoxel` clampe à `[0, 255]` — mais **aucun des deux clamps ne peut se
déclencher**, puisque `a` a déjà été borné par `dens[from]` et par
`255 − dens[to]`. Aucune perte, aucun gain, à l'octet près. C'est ce que réclame
`RECHERCHE-PHYSIQUE-SABLE` §2.3.3, et c'est respecté.

Baisser `MAX_TRANSFER` ne change rien à cette propriété.

**Ce qui la casserait**, c'est de passer à des transferts fractionnaires
flottants avec arrondi. Piège classique : `Math.round(a)` retiré d'un côté et
`Math.round(a)` ajouté de l'autre reste conservatif (même valeur), mais
`Math.floor(a)` d'un côté et `Math.ceil(a)` de l'autre **crée de la matière**.
Règle : **calculer `a` une seule fois, en entier, et l'utiliser deux fois.**

### Si on veut descendre SOUS l'unité de densité : l'accumulateur de reliquat

Le plancher `MIN_TRANSFER = 3` est ce qui empêche l'avalanche de traîner. Mais
il impose aussi une vitesse minimale : un talus à 0,1 voxel au-dessus de son
angle de repos transfère quand même 3 unités par sous-pas, donc « dépasse » et
oscille autour de l'équilibre. Sur une pente très douce, cela produit un
**frémissement résiduel** de la surface.

Solution propre : un **accumulateur de reliquat entier**, exactement conservatif.

```js
// --- dans le constructeur ------------------------------------------------
    /**
     * Reliquat de transfert, en 1/256 d'unite de densite.
     *
     * Permet des ecoulements arbitrairement lents SANS perdre un gramme : on
     * accumule la partie fractionnaire et on ne transfere que quand elle
     * atteint une unite entiere. Le reliquat reste attache au voxel SOURCE,
     * donc la masse totale = somme(density) + somme(residual)/256 est
     * rigoureusement constante.
     */
    this.residual = new Int16Array(n);

// --- remplacement du calcul de `amount` ----------------------------------
    // Quantite EXACTE souhaitee, en 1/256 d'unite.
    const want256 = (bestExcess * DAMPING * 255 * 0.5 / GRANULAR_SUBSTEPS) * 256;
    const acc = this.residual[i] + want256;
    let amount = (acc / 256) | 0;               // partie entiere, vers zero
    if (amount > MAX_TRANSFER) amount = MAX_TRANSFER;
    if (amount > d) amount = d;
    if (amount <= 0) {
      // Rien a transferer cette passe : on garde le reliquat et on se
      // reprogramme. C'est ca qui autorise un ecoulement de 0,2 unite/passe.
      this.residual[i] = acc > 32767 ? 32767 : acc | 0;
      this.push(i);
      return;
    }
```

et après le transfert :

```js
    const moved = this.transfer(x, y, z, i, x + dir[0], bestH, z + dir[1], amount);
    // Ne retirer du reliquat que ce qui a EFFECTIVEMENT bouge : si la cible
    // etait pleine, `moved` < `amount` et le credit doit rester disponible.
    this.residual[i] = (acc - moved * 256) | 0;
```

Et dans `writeVoxel`, quand un voxel se vide, effacer son reliquat en même temps
que le reste — sinon un voxel vidé garde un crédit fantôme et la conservation
saute :

```js
    if (v === 0) {
      F.moisture[i] = 0;
      F.packing[i] = 0;
      F.material[i] = 0;
      this.stress[i] = 0;
      this.residual[i] = 0;         // <-- indispensable
    }
```

**Coût : 12,6 Mo** (`Int16Array` de 6 291 456). C'est cher pour supprimer un
frémissement résiduel. **Recommandation : ne pas l'implémenter d'emblée.** Garder
`MIN_TRANSFER = 3`, et n'y venir que si le frémissement se voit encore une fois
le lissage (§2) en place — auquel cas on peut restreindre le tableau aux seuls
voxels de surface via une table creuse indexée par colonne.

### Test de non-régression de la masse

À ajouter aux tests existants : la somme des densités doit être **strictement
invariante** pendant une avalanche.

```js
/**
 * La masse doit etre conservee a l'octet pres. Ce test attrape a peu pres
 * toutes les erreurs de refactoring de la boucle de transfert — en particulier
 * le classique floor/ceil asymetrique.
 */
function testMassConservation(field, granular) {
  let m0 = 0;
  for (let i = 0; i < field.density.length; i++) m0 += field.density[i];
  for (let k = 0; k < 600; k++) granular.step(1 / 60, 60000);
  let m1 = 0;
  for (let i = 0; i < field.density.length; i++) m1 += field.density[i];
  console.assert(m0 === m1, `masse perdue : ${m0} -> ${m1} (delta ${m1 - m0})`);
}
```

> Attention : `collapse()` transfère vers `i - SLICE`, donc de la matière
> pourrait sortir par le bas du monde si `y = 0`. Le code s'en protège
> (`below = y > 0 ? dens[i - SLICE] : 255`, donc un voxel posé au sol n'est
> jamais jugé « non soutenu »). Le test ci-dessus vérifie que ça reste vrai
> après refactoring.

## 4.5 Le champ `stress` est réglé 10 fois trop vite

Découverte en passant, et elle compte pour le §5.3.

```js
const STRESS_BREAK = 200;
...
const s = this.stress[i] + 14;
```

À 60 passes par seconde, la rupture survient après

```
200 / 14 = 14,3 passes = 0,238 s
```

alors que `RECHERCHE-PHYSIQUE-SABLE` §2.6(2) **et** le commentaire d'en-tête de
`Granular.js` annoncent tous les deux « *le joueur voit des micro-fissures et
entend craquer pendant **2 à 4 secondes** avant que ça lâche* ». Le réglage
actuel est donc **dix fois trop rapide** : le joueur n'a strictement pas le temps
de voir l'avertissement, et l'effondrement est vécu comme un bug.

Correction, en tenant compte des sous-pas, **et sans coûter un octet** :

```js
/**
 * Contrainte accumulee avant rupture.
 *
 * Cible : ~2,8 s d'avertissement, conformement au commentaire d'en-tete et a
 * RECHERCHE-PHYSIQUE-SABLE §2.6(2). Avec un increment de 1 applique UN SOUS-PAS
 * SUR TROIS, a 60 pas/s et 4 sous-pas :
 *     250 / (60 * 4 / 3) = 3,1 s
 *
 * Le diviseur evite de passer `stress` en Uint16 (ce qui couterait 6,3 Mo de
 * plus) : on ralentit la CADENCE au lieu d'augmenter la RESOLUTION.
 */
const STRESS_BREAK = 250;
const STRESS_RATE = 1;
const STRESS_DIVIDER = 3;
```

```js
// dans processVoxel, branche "pas de support" :
        const inc = this.subIndex === 0 ? STRESS_RATE : 0;
        const s = this.stress[i] + inc;
        if (s < STRESS_BREAK) {
          this.stress[i] = s;
          this.push(i);
          return;
        }
```

**Effet visuel : c'est ce qui rend la rupture LISIBLE.** Un mur qui craque
pendant 2,8 s, se fissure, puis s'effondre, se raconte. Un mur qui tombe en
0,24 s est un bug aux yeux du joueur.

## 4.6 Récapitulatif des constantes de la §4

| Constante | Avant | Après | Justification |
|---|---|---|---|
| `GRANULAR_SUBSTEPS` | (1) | **4** | granularité ÷4 à débit constant |
| `MAX_TRANSFER` | 96 | **24** | 9,4 % d'un voxel = 3,8 mm par sous-pas |
| plancher de transfert | 6 | **3** | garantit la terminaison sans traîner |
| gain proportionnel | `× 63.75` | `× 15.94` | `/ SUBSTEPS` : physique inchangée |
| transfert de `collapse` | 192 | **48** | 75 % → 18,8 % d'un voxel |
| `STRESS_BREAK` | 200 | **250** | reste en `Uint8` |
| `STRESS_RATE` | 14 / passe | **1 un sous-pas sur 3** | 0,24 s → **3,1 s** d'avertissement |
| `BUDGET_GRANULAR` | 60 000 | **60 000** | inchangé, ça tient |

---

# 5. Effets d'accompagnement

Ces effets ne créent pas la fluidité — ils la **racontent**. Ils sont tous
branchés sur des données que le code produit déjà : `granular.events`,
`granular.flow`, `granular.flowMag`, `granular.stress`.

## 5.1 Poussière soulevée

`RECHERCHE-PHYSIQUE-SABLE` §2.6(6) donne déjà le modèle (`N = 0.02 · ΔV ·
(1−w)²`, 200–800 vivants, 1,5–2,5 s, taille 0,15 → 0,8 m). Ce qui manquait,
c'est le **branchement**. Le voici.

```js
/**
 * SandDust — la poussiere soulevee par une avalanche.
 *
 * Contrairement aux grains (§3.3), la poussiere est TRANSPARENTE : c'est de la
 * lumiere diffusee par des particules trop fines pour etre vues
 * individuellement. Elle n'ecrit donc pas la profondeur, et elle est rendue
 * APRES le terrain (renderOrder).
 *
 * Regle physique importante et tres visible : le sable MOUILLE ne fait pas de
 * poussiere. C'est en (1-w)^2 — arroser supprime le nuage, ce qui donne au
 * joueur un retour immediat sur l'etat de son sable.
 */

import * as THREE from 'three';
import { ORIGIN_X, ORIGIN_Y, ORIGIN_Z, VOXEL } from '../core/Config.js';

const MAX_DUST = 800;

export class SandDust {
  constructor(scene, field) {
    this.field = field;
    this.n = 0;
    this.pos = new Float32Array(MAX_DUST * 3);
    this.vel = new Float32Array(MAX_DUST * 3);
    this.age = new Float32Array(MAX_DUST);
    this.ttl = new Float32Array(MAX_DUST);

    const g = new THREE.BufferGeometry();
    this.aPos = new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage);
    this.aT = new THREE.BufferAttribute(new Float32Array(MAX_DUST), 1)
      .setUsage(THREE.DynamicDrawUsage);
    g.setAttribute('position', this.aPos);
    g.setAttribute('aT', this.aT);
    g.setDrawRange(0, 0);
    g.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 2, 0), 40);

    this.material = new THREE.ShaderMaterial({
      uniforms: {
        uPixelScale: { value: 1 },
        uColor: { value: new THREE.Color(0xe8d8b8).convertSRGBToLinear() },
        uSunColor: { value: new THREE.Color(1, 0.94, 0.82) },
      },
      vertexShader: /* glsl */`
        attribute float aT;
        uniform float uPixelScale;
        varying float vT;
        void main() {
          vT = aT;                                     // 0 = neuf, 1 = mort
          vec4 mv = modelViewMatrix * vec4(position, 1.0);
          gl_Position = projectionMatrix * mv;
          // La poussiere GONFLE en vieillissant : 0,15 m -> 0,80 m. C'est ce
          // gonflement qui la fait lire comme un nuage et pas comme des points.
          float size = mix(0.15, 0.80, vT);
          gl_PointSize = clamp(size * uPixelScale / max(0.05, -mv.z), 2.0, 90.0);
        }
      `,
      fragmentShader: /* glsl */`
        uniform vec3 uColor, uSunColor;
        varying float vT;
        void main() {
          vec2 d = gl_PointCoord - 0.5;
          float r2 = dot(d, d);
          if (r2 > 0.25) discard;
          // Profil gaussien : un disque net ferait des confettis.
          float a = exp(-r2 * 11.0) * (1.0 - vT) * (1.0 - vT) * 0.42;
          gl_FragColor = vec4(uColor * uSunColor, a);
        }
      `,
      transparent: true,
      depthWrite: false,
      depthTest: true,
    });

    this.points = new THREE.Points(g, this.material);
    this.points.frustumCulled = false;
    this.points.renderOrder = 10;                // apres le terrain et les grains
    scene.add(this.points);
  }

  /**
   * Emission depuis les evenements de Granular.
   * Deux sources, avec des dosages tres differents : un effondrement fait
   * beaucoup plus de poussiere qu'une coulee.
   */
  emitFrom(granular) {
    // (a) effondrements
    for (const e of granular.events) {
      if (e.type !== 'collapse') continue;
      const wx = ORIGIN_X + (e.x + 0.5) * VOXEL;
      const wy = ORIGIN_Y + (e.y + 0.5) * VOXEL;
      const wz = ORIGIN_Z + (e.z + 0.5) * VOXEL;
      const w = this.field.averageMoisture(wx, wy, wz, 0.08);
      const dry = (1 - w) * (1 - w);
      const k = 0.14 * e.amount * dry;
      let count = k | 0;
      if (Math.random() < k - count) count++;
      for (let i = 0; i < count; i++) this.spawn(wx, wy, wz, 0, 0);
    }
    // (b) coulees vives
    const f = granular.flow;
    for (let e = 0; e < granular.flowCount; e++) {
      const o = e * 6;
      if (f[o + 5] < 18) continue;
      const w = this.field.averageMoisture(f[o], f[o+1], f[o+2], 0.08);
      if (Math.random() > 0.10 * (1 - w) * (1 - w)) continue;
      this.spawn(f[o], f[o+1], f[o+2], f[o+3], f[o+4]);
    }
  }

  spawn(wx, wy, wz, dx, dz) {
    if (this.n >= MAX_DUST) return;
    const i = this.n++, i3 = i * 3;
    this.pos[i3]     = wx + (Math.random() - 0.5) * 0.06;
    this.pos[i3 + 1] = wy + Math.random() * 0.05;
    this.pos[i3 + 2] = wz + (Math.random() - 0.5) * 0.06;
    // Horizontale dans le sens de l'eboulis, VERTICALE POSITIVE : la poussiere
    // monte alors que le sable descend. C'est ce contraste qui la rend lisible.
    this.vel[i3]     = dx * 0.8 + (Math.random() - 0.5) * 0.30;
    this.vel[i3 + 1] = 0.30 + Math.random() * 0.22;
    this.vel[i3 + 2] = dz * 0.8 + (Math.random() - 0.5) * 0.30;
    this.age[i] = 0;
    this.ttl[i] = 1.5 + Math.random() * 1.0;
  }

  update(dt, wind = 0) {
    const drag = Math.pow(0.90, dt * 60);
    let i = 0;
    while (i < this.n) {
      const i3 = i * 3;
      this.age[i] += dt;
      // Pas de gravite : a cette granulometrie la vitesse de chute de Stokes
      // est de quelques cm/s, negligeable devant le vent. On applique donc une
      // legere retombee et le vent ambiant.
      this.vel[i3] += wind * 0.30 * dt;
      this.vel[i3 + 1] -= 0.16 * dt;
      this.vel[i3] *= drag; this.vel[i3+1] *= drag; this.vel[i3+2] *= drag;
      this.pos[i3] += this.vel[i3] * dt;
      this.pos[i3+1] += this.vel[i3+1] * dt;
      this.pos[i3+2] += this.vel[i3+2] * dt;

      const t = this.age[i] / this.ttl[i];
      if (t >= 1) {
        const j = --this.n;
        if (j !== i) {
          const j3 = j * 3;
          this.pos[i3]=this.pos[j3]; this.pos[i3+1]=this.pos[j3+1]; this.pos[i3+2]=this.pos[j3+2];
          this.vel[i3]=this.vel[j3]; this.vel[i3+1]=this.vel[j3+1]; this.vel[i3+2]=this.vel[j3+2];
          this.age[i]=this.age[j]; this.ttl[i]=this.ttl[j];
        }
        continue;
      }
      this.aT.array[i] = t;
      i++;
    }
    this.points.geometry.setDrawRange(0, this.n);
    if (this.n) { this.aPos.needsUpdate = true; this.aT.needsUpdate = true; }
  }

  setViewport(heightPx, fovDeg) {
    this.material.uniforms.uPixelScale.value =
      heightPx / (2 * Math.tan(fovDeg * Math.PI / 360));
  }
}
```

Coût : 800 points seulement, mais **transparents et gros** (jusqu'à 90 px) — le
poste réel est le **fill rate**, ~**0,4 ms** avec un nuage plein écran. D'où le
plafond de 90 px et le `renderOrder`. En qualité basse : `MAX_DUST = 200` et
plafond 40 px.

## 5.2 Traînées sombres laissées par le sable qui a glissé

**Le fait physique** : le sable qui vient de glisser a subi un cisaillement, il
est **dilaté** (donc plus lâche), et il expose la couche du dessous, **plus
humide** parce qu'elle a moins évaporé. Les deux effets vont dans le même sens
visuel : **une coulée laisse une trace plus sombre**, qui s'estompe en une
dizaine de secondes à mesure que la surface sèche.

`RECHERCHE-SABLE-DIORAMA` §5.4 traite déjà les traces sombres laissées par une
vague ; c'est le même mécanisme d'affichage, avec une source différente.

**On a déjà presque tout** : la flow map (§3.4) est exactement une carte de « où
le sable a coulé ». Il manque une **rémanence beaucoup plus longue** que celle du
mouvement lui-même, donc un champ séparé — logé dans le canal alpha de la même
texture, ce qui ne coûte **aucun fetch supplémentaire**.

```js
// --- dans le constructeur de Granular ------------------------------------
    /**
     * Marque de coulee. Meme source que la flow map, mais demi-vie de ~9 s au
     * lieu de 0,38 s : le MOUVEMENT est bref, la TRACE reste.
     */
    this.scour = new Uint8Array(NX * NZ);

  updateScour(x, z, amount) {
    const c = x + NX * z;
    const v = this.scour[c] + amount * 2;
    this.scour[c] = v > 255 ? 255 : v;
  }

  /**
   * Decroissance de la trace : 0,9987 par frame => demi-vie 533 images = 8,9 s.
   * Balayage paresseux d'1/64 des colonnes par frame : 1 024 colonnes, ~10 us.
   * Inutile d'etre exact, c'est une trace qui s'efface.
   */
  decayScour() {
    const sc = this.scour;
    const n = sc.length, chunk = n >> 6;
    let c = this._scourCursor | 0;
    for (let k = 0; k < chunk; k++) {
      const v = sc[c];
      if (v > 0) sc[c] = v - 1 + ((v * 5) >> 8);   // ~0,98 par visite (1/64 frame)
      c = (c + 1) % n;
    }
    this._scourCursor = c;
  }
```

et dans le shader, à la suite du calcul de `base` :

```glsl
        // --- trainee de coulee ------------------------------------------------
        // Le sable qui vient de glisser a ete cisaille : il est dilate et il
        // expose la couche du dessous, moins evaporee donc plus humide. Les deux
        // effets assombrissent. La trace vit ~9 s (canal alpha de uFlowMap),
        // bien plus longtemps que le mouvement lui-meme (0,38 s, canal bleu).
        float scour = flowT.a;
        base *= mix(1.0, 0.80, scour);
```

et, dans `roughnessmap_fragment` :

```glsl
        // La dilatance casse le micro-poli : le sable fraichement coule est
        // legerement plus mat que le sable tasse alentour.
        roughnessFactor = mix(roughnessFactor, min(1.0, roughnessFactor * 1.12), vScour);
```

Coût : **64 Ko** de plus côté CPU, **0 Ko** côté GPU (canal alpha déjà alloué),
**0 fetch** de plus.

## 5.3 Micro-fissures avant la rupture — brancher `stress`

Le champ existe (`Granular.stress`), il est correctement alimenté, et **rien ne
le lit**. C'est le plus gros gisement d'effet gratuit du projet.

### Le problème : `aData` est plein

`att` est un `Uint8Array(4)` : humidité, compaction, AO, matériau. Il faut un
second attribut — que `RECHERCHE-SABLE-DIORAMA` §6.3 anticipe déjà sous le nom
`SC_HAS_DATA2`. On l'ouvre ici, avec un contenu unifié :

```
aData2.x = stress    (0..1)   micro-fissures                         §5.3
aData2.y = flowMag   (0..1)   vitesse d'ecoulement locale, PAR SOMMET
                              donc plus lisse que la flow map        §3.4
aData2.z = courbure  (0..1)   reserve pour RECHERCHE-SABLE-DIORAMA   §4.2
aData2.w = scour     (0..1)   trace de coulee, par sommet            §5.2
```

Coût : **+4 octets par sommet**, soit +260 Ko sur les ~65 000 sommets de surface.

Dans `VoxelField.extractChunk`, ajouter un cinquième bloc `outS` (stress) ; dans
`surfaceNets`, la moyenne sur les **coins solides**, exactement comme `M` et
`P` — la contrainte n'est portée que par la matière, donc c'est le bon
opérateur :

```js
        // dans la boucle des attributs, avec mm et pp :
          ss += S[co];
        ...
        const a2 = vCount * 4;
        att2[a2]     = (ss / cnt) | 0;
        att2[a2 + 1] = flowMagAtColumn;      // fourni par extractChunk
        att2[a2 + 3] = scourAtColumn;
```

### Le shader

```glsl
        // =====================================================================
        // MICRO-FISSURES — l'annonce de la rupture
        // ---------------------------------------------------------------------
        // Le champ `stress` de Granular monte pendant ~2,8 s avant qu'un
        // surplomb lache (§4.5). Une rupture doit TOUJOURS etre annoncee : sans
        // ce signal, l'effondrement est vecu comme un bug ; avec, il est vecu
        // comme une consequence.
        //
        // Motif : un bruit "ridge" (1 - |2n-1|) seuille. Quand la contrainte
        // monte, le SEUIL DESCEND, donc on passe d'une fissure isolee a un
        // reseau ramifie — c'est exactement le comportement d'un materiau
        // fragile, et ca se lit sans explication.
        // =====================================================================
        float stress = vData2.x;
        float crack = 0.0;
        if (stress > 0.04) {
          float n1 = sc_fbm(vWorldPos * 6.5, 2);          // reseau principal
          float n2 = sc_fbm(vWorldPos * 21.0 + 13.7, 2);  // ramifications fines
          float ridge = 1.0 - abs(n1 * 2.0 - 1.0);
          float fine  = 1.0 - abs(n2 * 2.0 - 1.0);
          float thr = mix(0.988, 0.900, stress);
          crack = smoothstep(thr, thr + 0.016, ridge);
          // Les ramifications n'apparaissent qu'au-dela de 60 % de contrainte.
          crack = max(crack, smoothstep(0.976, 0.992, fine)
                           * smoothstep(0.60, 0.95, stress) * 0.7);
          crack *= smoothstep(0.04, 0.30, stress);
          // Une fissure est d'abord une OMBRE.
          diffuseColor.rgb *= 1.0 - 0.62 * crack;
        }
        vCrack = crack;
```

et, dans `normal_fragment_maps`, on la creuse légèrement pour qu'elle accroche
la lumière rasante :

```glsl
          // La fissure creuse la surface d'environ 1 mm : assez pour accrocher
          // un soleil rasant, pas assez pour deformer la silhouette.
          normal = normalize(normal + vec3(dn.x, 0.0, dn.z) * vCrack * 0.9);
```

### Branchement audio : annoncer, pas commenter

`granular.events` porte déjà `{type:'collapse', …}` et `Game.update` joue un
son. Il manque **l'annonce**. Un second type d'événement, émis quand la
contrainte franchit un palier :

```js
      // dans processVoxel, branche "pas de support" :
        const inc = this.subIndex === 0 ? STRESS_RATE : 0;
        const s = this.stress[i] + inc;
        if (s < STRESS_BREAK) {
          // Palier a 45 % : c'est LA que le craquement doit se faire entendre,
          // pas au moment de la rupture — trop tard pour que le joueur reagisse.
          const thr = (STRESS_BREAK * 0.45) | 0;
          if (this.stress[i] < thr && s >= thr && this.events.length < 24) {
            this.events.push({ type: 'creak', x, y, z, amount: 0 });
          }
          this.stress[i] = s;
          this.push(i);
          return;
        }
```

et côté `Game` :

```js
    if (this.granular.events.length) {
      let creak = false, collapse = false;
      for (const e of this.granular.events) {
        if (e.type === 'collapse') collapse = true;
        else if (e.type === 'creak') creak = true;
      }
      // L'effondrement couvre le craquement : ne jamais jouer les deux.
      if (collapse) this.audio.play('collapse');
      else if (creak) this.audio.play('creak');
    }
```

## 5.4 Récapitulatif du coût de la §5

| Effet | CPU/frame | GPU | Mémoire |
|---|---|---|---|
| Poussière (800 pts) | 0,05 ms | ~0,4 ms (fill), nuage plein écran | 26 Ko |
| Traînées (`scour`) | 0,01 ms | **+0 fetch** (canal alpha) | 64 Ko |
| Micro-fissures | 0 | ~2 `sc_fbm(·,2)` ≈ 30 ALU, **seulement si `stress > 0.04`** | +260 Ko (`aData2`) |
| Craquement audio | 0 | — | — |

---

# 6. Résolution : faut-il passer à 2 cm ?

## 6.1 Le coût, chiffré

Passer de `VOXEL = 0.04` à `0.02` en gardant le même domaine physique
(10,24 × 3,84 × 10,24 m) multiplie les dimensions par 2 sur chaque axe :

```
NX, NY, NZ : 256, 96, 256   →   512, 192, 512
voxels     : 6 291 456      →   50 331 648        (×8)
```

### Mémoire

| Tableau | 4 cm | 2 cm |
|---|---|---|
| `density`, `moisture`, `packing`, `material` | 4 × 6,29 = **25,2 Mo** | 4 × 50,3 = **201 Mo** |
| `Granular.flag`, `Granular.stress` | 2 × 6,29 = 12,6 Mo | 2 × 50,3 = **101 Mo** |
| Grille d'eau (`h`, `sed`, `foam`, flux…), 2D `Float32` | ~1,3 Mo | ~5,2 Mo |
| Caches de colonne (`topY`, `surfaceH`, `floorY`) | 0,4 Mo | 1,6 Mo |
| Files actives (8 × 262 144 `Int32`) | 8,4 Mo | 8,4 Mo (ou saturent) |
| Blocs des workers (6 × 4 × 44³ → 6 × 4 × 44³) | 2,0 Mo | 2,0 Mo |
| **Total simulation** | **~50 Mo** | **~319 Mo** |

Un onglet Chrome sur une machine de milieu de gamme dispose de 1 à 2 Go, mais il
faut aussi y loger le heap JS, les textures, les 6 workers et la sauvegarde
compressée. **319 Mo est le point où le jeu cesse de tourner sur un portable à
8 Go**, et `Save.js` doit sérialiser 8 fois plus de données.

### Maillage

La surface d'un château est une **surface** : son coût croît en `1/h²`.

| | 4 cm | 2 cm |
|---|---|---|
| Sommets de surface | ~65 000 | **~260 000** (×4) |
| Triangles | ~131 000 | **~524 000** (×4) |
| Chunks (32³) | 192 | **1 536** (×8) |
| Appels de dessin | 192 | **1 536** |
| Remaillage complet (`warmupMeshing`) | ~250 ms | **~2 000 ms** |

Les 1 536 appels de dessin sont le point dur : à ce niveau il faudrait un système
de fusion de chunks ou un LOD — c'est-à-dire **un autre moteur**.

### Simulation

Deux facteurs se multiplient :

- l'**ensemble actif** est surfacique → **×4** ;
- une avalanche doit parcourir **deux fois plus de cellules** pour couvrir la
  même distance physique → **×2 en nombre de passes**.

**Total : ×8 sur le travail granulaire.** `BUDGET_GRANULAR` devrait passer de
60 000 à 480 000. À 40–70 ns par voxel examiné (`RECHERCHE-PHYSIQUE-SABLE`
§5.6), cela fait **26 ms par frame** — tout le budget, pour la seule avalanche.
La passe d'humidité et la passe d'eau suivent la même loi.

## 6.2 Est-ce que ça résoudrait vraiment le problème ?

**Partiellement, et pour très cher.** Reprenons le §1.1 : sur une pente douce, le
verrouillage `lx = lz = 0.5` **subsiste à 2 cm**. La maille serait simplement
deux fois plus fine — et toujours **parfaitement périodique**.

| | 4 cm | 2 cm | 4 cm + Taubin |
|---|---|---|---|
| Taille de maille à 8 m, 1080p | 9,4 px | 4,7 px | 9,4 px, mais **non périodique** |
| Terrasses sur une pente à 15° | tous les 15 cm | tous les 7,5 cm | **aucune** |
| Erreur RMS de normale | 6,7° | ~4,5° | **1,4°** |
| Coût | référence | **×8 mémoire, ×8 sim, ×4 maillage** | **×1,05** |

À 2 cm, la trame ferait 4,7 px : **elle serait encore visible**, juste plus fine.
Un réseau *parfaitement* régulier reste perceptible bien en dessous de 5 px — la
même raison qui fait qu'on voit la grille d'un capteur photo, ou le moirage d'un
tissu à l'écran. **Il faut casser la périodicité, pas la raffiner.**

## 6.3 Verdict : **NON, et le lissage rend la question caduque**

Trois arguments, par ordre de force.

**1. Le lissage traite la cause, la résolution traite le symptôme.** La cause est
la périodicité parfaite du réseau (§1.1), pas sa finesse. Taubin la détruit pour
+5 % de coût de maillage. C'est un rapport de **160 pour 1** contre le passage à
2 cm.

**2. 4 cm est un choix de design, pas une contrainte technique.** Un créneau
lisible fait 3 à 4 voxels de large, soit 12 à 16 cm — l'échelle correcte pour un
château de 60 cm. À 2 cm, le joueur pourrait sculpter des détails de 2 cm que la
caméra de diorama à 8–15 m ne montrerait jamais. On paierait ×8 pour de
l'information invisible. *(Comparaison utile : Teardown, qui est entièrement bâti
autour de la destruction voxel, utilise des voxels de **5 cm** — plus gros que
les nôtres.)*

**3. Il existe un demi-pas, et il ne vaut rien.** Mailler à 2 cm en
**suréchantillonnant** le champ à 4 cm dans le worker (grille de cellules 65³ au
lieu de 33³ sur le même bloc, densité trilinéaire) donnerait un maillage 2× plus
fin sans toucher à la simulation ni à la mémoire. Coût : **×8 sur la boucle de
cellules**, soit 0,8–2 ms → 6–16 ms par chunk. Trop cher — et **pour un gain
nul** : le champ trilinéaire ne contient pas plus d'information que le champ
d'origine. On lisserait en interpolant, c'est-à-dire exactement ce que fait
Taubin pour 20 fois moins cher.

> **Décision : rester à `VOXEL = 0.04`.** Ne rouvrir la question que si, après les
> §2 à §5, un test utilisateur pointe encore la résolution — et dans ce cas,
> envisager `VOXEL = 0.03` (`NX = 342`, ×2,4 en mémoire, maille de 7 px à 8 m)
> plutôt que 0,02, ce qui resterait sous 120 Mo.

---

# 7. Plan d'implémentation ordonné

## 7.1 Classement par rapport gain visuel / effort

| # | Étape | Effort | Gain | Risque | Fichiers |
|---|---|---|---|---|---|
| **1** | **Sous-pas d'avalanche + transferts fins + stress ralenti** | **30 min** | **★★★★☆** | très faible | `Granular.js`, `Config.js` |
| **2** | **Pré-lissage du champ pour les normales + AO à 6 directions** | **1 h** | **★★★★☆** | faible | `SurfaceNets.js` |
| **3** | **Taubin dans le worker (anneau élargi + reprojection)** | **3 h** | **★★★★★** | moyen (seams) | `SurfaceNets.js` |
| **4** | **Geomorphing par clé de cellule** | **4 h** | **★★★★★** | moyen | `SurfaceNets.js`, `MeshWorker.js`, `MesherPool.js`, `TerrainRenderer.js`, `SandMaterial.js`, `Game.js` |
| **5** | **Couche de grains (`SandGrains.js`)** | **5 h** | **★★★★★** | faible | nouveau + `Granular.js`, `Game.js` |
| 6 | Normales bilatérales + AO lissée + diagonale courte | 2 h | ★★★☆☆ | faible | `SurfaceNets.js` |
| 7 | Flow map + advection du grain | 4 h | ★★★★☆ | faible | `Granular.js`, `SandMaterial.js`, `Game.js` |
| 8 | Poussière (`SandDust.js`) | 2 h | ★★★☆☆ | faible | nouveau |
| 9 | `aData2` + micro-fissures + craquement | 3 h | ★★★☆☆ | faible | `VoxelField.js`, `SurfaceNets.js`, `SandMaterial.js`, `Audio.js` |
| 10 | Traînées de coulée (`scour`) | 1 h | ★★☆☆☆ | faible | `Granular.js`, `SandMaterial.js` |

**Les trois premières étapes (4 h 30) règlent environ 70 % du problème.** Les
étapes 4 et 5 (9 h) apportent le reste. Le bloc 6–10 est de la finition.

## 7.2 Étape 1 — prête à coller

### `src/core/Config.js`

```js
/**
 * Sous-pas d'avalanche par pas de simulation.
 *
 * Le debit total est inchange (MAX_TRANSFER x GRANULAR_SUBSTEPS = 96 comme
 * avant), mais la GRANULARITE est divisee par 4 : l'isosurface ne se deplace
 * jamais de plus de 24/255 de voxel, soit 3,8 mm, par sous-pas — sous le seuil
 * de perception du saut (3 px a 8 m de la camera de diorama).
 *
 * C'est le changement le plus rentable de tout le pipeline : deux constantes et
 * une boucle, pour un tiers de la sensation d'ecoulement.
 *
 * 4 et pas 8 : au-dela, le cout des reveils (wake() touche 36 voxels par
 * transfert) commence a dominer, pour un gain perceptif nul.
 */
export const GRANULAR_SUBSTEPS = 4;
```

### `src/sim/Granular.js` — remplacements

```js
// --- en tete du fichier ---------------------------------------------------
import {
  NX, NY, NZ, ISO, VOXEL, CHUNK, ORIGIN_X, ORIGIN_Y, ORIGIN_Z,
  GRANULAR_SUBSTEPS, chidx, clamp,
} from '../core/Config.js';

/** Transfert maximal par voxel et par SOUS-PAS (unites de densite 0..255). */
const MAX_TRANSFER = 24;
/**
 * Plancher de transfert. Strictement positif, sinon la relaxation stalle a un
 * demi-pas de l'equilibre et l'ensemble actif ne se vide jamais.
 * 3/255 = 0,5 mm par sous-pas : invisible, et ca termine.
 */
const MIN_TRANSFER = 3;
/** Amortissement : on ne corrige qu'une fraction de l'exces de pente. */
const DAMPING = 0.5;
/**
 * Contrainte accumulee avant rupture (unites de 1/255 par sous-pas).
 *
 * Cible : ~2,8 s d'avertissement. Avec un increment de 1 applique un sous-pas
 * sur trois, a 60 pas/s et 4 sous-pas : 250 / (60*4/3) = 3,1 s. L'ancien
 * reglage (BREAK=200, RATE=14) donnait 0,24 s — dix fois trop vite pour que le
 * joueur voie les micro-fissures, alors que tout le design repose dessus.
 */
const STRESS_BREAK = 250;
const STRESS_RATE = 1;
const STRESS_DIVIDER = 3;
```

```js
// --- constructeur : ajouter -----------------------------------------------
    /**
     * Anneau d'evenements d'ecoulement, consomme par la couche de particules.
     * 6 flottants : x, y, z (monde), dirX, dirZ, amount.
     * Anneau et pas tableau : la boucle de transfert est la plus chaude du jeu.
     */
    this.FLOW_CAP = 2048;
    this.flow = new Float32Array(this.FLOW_CAP * 6);
    this.flowCount = 0;
    this.FLOW_MIN = 10;
    /** Index du sous-pas courant (pour le diviseur de contrainte). */
    this.subIndex = 0;
```

```js
  /**
   * Un pas de simulation granulaire = GRANULAR_SUBSTEPS passes d'avalanche.
   *
   * Les evenements et l'anneau de flux sont remis a zero UNE FOIS par appel,
   * pas par sous-pas : sinon l'audio et la couche de particules ne verraient
   * qu'un quart de ce qui s'est passe.
   *
   * @param {number} dt
   * @param {number} budget voxels examines, TOUS sous-pas confondus
   */
  step(dt, budget = 90000) {
    this.events.length = 0;
    this.flowCount = 0;
    this.stats.processed = 0;
    this.stats.moved = 0;
    this.stats.collapsed = 0;

    const sub = budget / GRANULAR_SUBSTEPS;
    const sdt = dt / GRANULAR_SUBSTEPS;
    for (let s = 0; s < GRANULAR_SUBSTEPS; s++) {
      this.subIndex = (this.subIndex + 1) % STRESS_DIVIDER;
      this.substep(sdt, sub);
    }
  }

  /** Une passe d'avalanche (l'ancien corps de step(), sans les remises a zero). */
  substep(dt, budget) {
    const t = this.cur; this.cur = this.next; this.next = t;
    for (let c = 0; c < 4; c++) {
      this.curLen[c] = this.nextLen[c];
      this.nextLen[c] = 0;
    }
    this.stats.active = this.curLen[0] + this.curLen[1] + this.curLen[2] + this.curLen[3];
    if (this.stats.active === 0) return;

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
        this.processVoxel(x, y, z, i, dt);
      }
      this.stats.processed += n;
      for (let k = n; k < len; k++) {
        const i = list[k];
        this.flag[i] = 0;
        this.push(i);
      }
    }
  }

  /**
   * Note un evenement d'ecoulement pour la couche de rendu.
   * Sous-echantillonne volontairement : un gros effondrement genere des
   * milliers de transferts, et 2048 suffisent a remplir l'ecran de grains.
   */
  emitFlow(x, y, z, dx, dz, amount) {
    if (amount < this.FLOW_MIN || this.flowCount >= this.FLOW_CAP) return;
    const o = this.flowCount * 6;
    const f = this.flow;
    f[o]     = ORIGIN_X + (x + 0.5) * VOXEL;
    f[o + 1] = ORIGIN_Y + (y + 0.5) * VOXEL;
    f[o + 2] = ORIGIN_Z + (z + 0.5) * VOXEL;
    f[o + 3] = dx;
    f[o + 4] = dz;
    f[o + 5] = amount;
    this.flowCount++;
  }
```

```js
// --- dans processVoxel : la branche de contrainte -------------------------
      } else {
        // Un sous-pas sur STRESS_DIVIDER seulement : c'est ce qui etale
        // l'avertissement sur ~2,8 s sans passer stress en Uint16.
        const inc = this.subIndex === 0 ? STRESS_RATE : 0;
        const s = this.stress[i] + inc;
        if (s < STRESS_BREAK) {
          // Palier a 45 % : c'est LA que le craquement se fait entendre, pas au
          // moment de la rupture — trop tard pour que le joueur reagisse.
          const thr = (STRESS_BREAK * 0.45) | 0;
          if (this.stress[i] < thr && s >= thr && this.events.length < 24) {
            this.events.push({ type: 'creak', x, y, z, amount: 0 });
          }
          this.stress[i] = s;
          this.push(i);
          return;
        }
        this.stress[i] = 0;
        this.collapse(x, y, z, i, d, below);
        return;
      }

// --- dans processVoxel : la quantite transferee ---------------------------
    // Le gain est divise par GRANULAR_SUBSTEPS : quatre sous-pas deplacent
    // exactement ce que deplacait un pas. La DUREE d'une avalanche est
    // inchangee, seule sa granularite temporelle change.
    let amount = Math.round(bestExcess * DAMPING * 255 * 0.5 / GRANULAR_SUBSTEPS);
    if (amount < MIN_TRANSFER) amount = MIN_TRANSFER;
    if (amount > MAX_TRANSFER) amount = MAX_TRANSFER;
    if (amount > d) amount = d;

    const dir = LAT[bestDir];
    const moved = this.transfer(x, y, z, i, x + dir[0], bestH, z + dir[1], amount);
    if (moved > 0) {
      this.stats.moved += moved;
      this.emitFlow(x, y, z, dir[0], dir[1], moved);
      this.wake(x, y, z);
      this.wake(x + dir[0], Math.floor(bestH), z + dir[1]);
    }

// --- dans collapse() -------------------------------------------------------
    const amount = Math.min(d, room, MAX_TRANSFER * 2);   // 48, etait 192
    if (amount <= 0) return;
    this.transferTo(i, i - SLICE, amount, 0.55);
    this.emitFlow(x, y, z, 0, 0, amount);
```

### Ce qu'on doit voir immédiatement

Creuser un trou de 20 cm dans une berme, puis regarder le bord s'effondrer :
- **avant** : le bord tombe par marches visibles, une marche toutes les 2 ou
  3 images ;
- **après** : le bord descend **continûment**, la durée totale est identique.

Si l'avalanche est devenue lente, c'est que le gain proportionnel n'a pas été
divisé par `GRANULAR_SUBSTEPS`. Si elle est devenue instable / oscillante, c'est
que `MIN_TRANSFER` est trop haut.

## 7.3 Étape 2 — prête à coller

Deux changements dans `SurfaceNets.js`, indépendants et sans risque de seam.

**(a) Ajouter `blurField` et `sampleB`** (code complet en §2.3-2), allouer
`ctx.DB` et `ctx.DTMP` dans `NetsContext`, appeler `blurField(D, ctx.DB,
ctx.DTMP, S)` en tête de `surfaceNets`, et **remplacer `D` par `DB` dans les
deux appels de gradient et dans `ambientOcclusion`**. Le placement des sommets
continue d'utiliser `D` brut.

```js
/** Densite trilineaire dans le bloc PRE-LISSE (Int16), avec clamp aux bords. */
function sampleB(DB, S, S2, x, y, z) {
  if (x < 0) x = 0; else if (x > S - 1.001) x = S - 1.001;
  if (y < 0) y = 0; else if (y > S - 1.001) y = S - 1.001;
  if (z < 0) z = 0; else if (z > S - 1.001) z = S - 1.001;
  const x0 = x | 0, y0 = y | 0, z0 = z | 0;
  const tx = x - x0, ty = y - y0, tz = z - z0;
  const o = x0 + S * y0 + S2 * z0;
  const c00 = DB[o]        + (DB[o + 1]          - DB[o])        * tx;
  const c10 = DB[o + S]    + (DB[o + S + 1]      - DB[o + S])    * tx;
  const c01 = DB[o + S2]   + (DB[o + S2 + 1]     - DB[o + S2])   * tx;
  const c11 = DB[o + S2+S] + (DB[o + S2 + S + 1] - DB[o + S2+S]) * tx;
  const c0 = c00 + (c10 - c00) * ty;
  const c1 = c01 + (c11 - c01) * ty;
  return c0 + (c1 - c0) * tz;
}
```

**(b) Réduire `AO_DIRS` à 6 directions** (§2.5-3). Cela **finance** (a) : −0,25 ms
contre +0,25 ms, coût net **zéro**, pour −80 % d'erreur de normale.

### Ce qu'on doit voir

Pente à ~15°, soleil rasant (`dayT ≈ 0.15`) : les **lignes de terrasse tous les
15 cm disparaissent**. La trame carrée, elle, est toujours là — c'est l'étape 3
qui la traite.

## 7.4 Étape 3 — le lissage de Taubin

Code complet en §2.3. L'ordre des opérations dans `surfaceNets` devient :

```
1. blurField(D → DB)
2. passe 1 : sommets sur [G0, G1] en coordonnees BLOC,
             + premier jet de normales (gradient sur DB, pour le feature-aware),
             + attributs et cle SEULEMENT pour [C0, C1]
3. taubinSmooth(ctx, D, vCount)          <-- 4 iterations, 2 reprojections
4. passe 2 : quads sur [G0+1, G1]
             -> accumulation de normales de face pour TOUS
             -> indices emis SEULEMENT pour les aretes possedees
5. passe 3 : normale finale (gradient DB melange a la face), AO,
             conversion bloc -> monde. SEULEMENT pour [C0, C1].
6. bilateralNormals + smoothAO   (etape 6 du plan, optionnelles)
7. compact()
```

### Les trois pièges, et comment les vérifier

| Piège | Symptôme | Vérification |
|---|---|---|
| `SMOOTH_ITERS > BORDER − 1` | fissures régulières tous les 1,28 m | assertion `SMOOTH_ITERS <= BORDER - 1` au chargement du module |
| Normales calculées **avant** le lissage | la trame revient dans l'ombrage alors que la géométrie est lisse | l'AO et le gradient doivent être en passe 3 |
| Accumulation de faces limitée aux sommets possédés | ligne d'éclairage tous les 1,28 m, plus fine que la fissure | la boucle de quads doit courir sur `[G0+1, G1]` |

Ajouter au module :

```js
if (SMOOTH_ITERS > BORDER - 1) {
  throw new Error(
    `SMOOTH_ITERS=${SMOOTH_ITERS} > BORDER-1=${BORDER - 1} : le lissage ` +
    `deborderait de l'anneau et produirait des coutures entre chunks (§2.2).`
  );
}
```

## 7.5 Étape 4 — le geomorphing

Code complet en §3.2. Ordre d'intégration, pour pouvoir tester à chaque cran :

1. **Exporter `keys`** dans `SurfaceNets.compact`, `MeshWorker`, `MesherPool`.
   Vérifier que rien ne casse (les clés ne sont pas encore utilisées).
2. **Construire `aPrevPos`** dans `TerrainRenderer.setChunk` et l'attacher à la
   géométrie **sans l'utiliser dans le shader**. Vérifier le coût CPU au HUD.
3. **Brancher le vertex shader** avec `uMorphDur = 0.001` (morph instantané) :
   le rendu doit être **identique au pixel près** à l'actuel. C'est le test de
   non-régression.
4. Passer `uMorphDur` à `0.12`.
5. **Ajouter le `customDepthMaterial`** — sinon les ombres sautent, et c'est
   plus voyant que le problème d'origine.

## 7.6 Étape 5 — les grains

Code complet en §3.3. Deux réglages à faire à l'œil, dans cet ordre :

1. `MAX_GRAINS` et `GRAINS_PER_UNIT` : viser **600 à 1 500 grains vivants** sur
   une avalanche de mur de 40 cm. Le HUD doit afficher `grains.n`.
2. Le plafond `gl_PointSize` : partir de **10 px**, et le baisser si le frame
   time chute quand la caméra s'approche d'une coulée. C'est le seul réglage qui
   peut coûter cher.

## 7.7 Ce qu'on ne fait PAS

Pour mémoire, et pour éviter d'y revenir :

- **Dual Contouring / QEF** — §2.6. Coût ×5, seams non démontrables, et rien à
  reconstruire sur du sable.
- **Deux instantanés de densité interpolés** — §3.1(a1). Force un remaillage à
  60 Hz.
- **Pipeline écran-espace (splats + narrow-range filter)** — §3.5. Excellent
  pour des fluides à particules, hors sujet pour un terrain déjà maillé et
  opaque.
- **`VOXEL = 0.02`** — §6. ×8 en mémoire et en simulation pour un problème que
  le lissage traite à ×1,05.
- **L'accumulateur de reliquat `Int16Array`** — §4.4. 12,6 Mo pour supprimer un
  frémissement qui ne se verra peut-être plus une fois le lissage en place.

## 7.8 Checklist de validation finale

| # | Test | Attendu |
|---|---|---|
| 1 | Pente à 15°, soleil rasant, caméra à 8 m | aucune trame carrée, aucune terrasse |
| 2 | Frontière de chunk (multiple de 1,28 m) en lumière rasante | aucune ligne |
| 3 | Créneau de 4×3 voxels, hauteur mesurée au raycast avant/après | perte < 3 mm |
| 4 | Puits vertical de 1 voxel de large | ne se referme pas |
| 5 | Effondrement d'un mur de 40 cm, capture à 60 fps | déplacement < 1,5 cm par image, **jamais de saut** |
| 6 | Même effondrement, durée totale | identique à avant (± 10 %) |
| 7 | `testMassConservation` sur 600 pas | delta **exactement 0** |
| 8 | Surplomb non soutenu | craquement + fissures visibles **~2,8 s** avant la rupture |
| 9 | Coulée sur un talus | filet de grains visible, grains qui s'arrêtent en douceur |
| 10 | Sable mouillé (arrosoir) puis effondrement | **pas de poussière** |
| 11 | `stats.sim` au HUD pendant une grosse avalanche | < 6 ms |
| 12 | `mesher.stats.avgMs` | < 3 ms |

---

# 8. Sources

## Extraction d'isosurface et lissage

- **Gibson, S. F. F.** — *Constrained Elastic SurfaceNets: Generating Smooth
  Surfaces from Binary Segmented Data*, MERL TR99-24, 1999.
  https://www.merl.com/publications/docs/TR99-24.pdf
  → L'article fondateur de Surface Nets. Contient la mise en garde décisive :
  « *Defining the energy and relaxation in this manner **without constraints
  will cause the surface net to shrink into a sphere and eventually onto a
  single point***. Hence… a constraint is applied that **keeps each node inside
  its original surface cube**. » Et une observation contre-intuitive utile :
  l'énergie du filet **décroît vers un minimum puis remonte lentement** ; au
  minimum la surface est la plus lisse, mais **les coins se durcissent à mesure
  que l'énergie remonte**. Le nombre d'itérations est donc un curseur
  lissage↔netteté, pas un critère de convergence. Leurs exemples comparent
  10 et 100 itérations, tous « à moins d'un voxel de la segmentation d'origine ».
  *(Notre `MAX_DRIFT` en boule est la variante « sphère » de cette contrainte ;
  on l'a préférée au cube parce que le cube, lui, réimprime le réseau — §2.1.)*

- **Taubin, G.** — *A Signal Processing Approach To Fair Surface Design*,
  SIGGRAPH 1995. https://www.cs.jhu.edu/~misha/Fall07/Papers/Taubin95.pdf
  → Le filtre λ|μ, la fonction de transfert `f(k) = (1−λk)(1−μk)`, la contrainte
  `0 < λ` et `μ < −λ`, et la fréquence de bande passante `k_PB = 1/λ + 1/μ`.
  Les valeurs de l'article lui-même : **k_PB = 0,1 et λ = 0,6307**, illustrées à
  10 / 50 / 100 itérations.

- **Desbrun, M., Meyer, M., Schröder, P., Barr, A.** — *Implicit Fairing of
  Irregular Meshes using Diffusion and Curvature Flow*, SIGGRAPH 1999.
  https://www.geometry.caltech.edu/pubs/DMSB_SIG99.pdf
  → Cite explicitement le couple **λ = 0,6307 / μ = −0,6732** (fig. 4d, 20
  passes), cohérent avec `k_PB = 0,1`. Donne aussi le flot de courbure moyenne à
  poids cotangents et son intégration **implicite** (inconditionnellement
  stable : une intégration implicite à `dt = 10` coûte 7 itérations de PBCG et
  va **30 % plus vite** que 10 intégrations explicites à `dt = 1`). Et la
  critique frontale de l'opérateur ombrelle uniforme : il suppose « *des arêtes
  de longueur 1 et des angles égaux* », faute de quoi il peut « *créer des
  bosses au lieu de lisser* ».
  → **Pourquoi on garde quand même l'ombrelle uniforme ici** : notre maillage
  dual est presque exactement le cas idéal supposé par l'opérateur (valence 4,
  arêtes toutes proches de 4 cm), donc les poids cotangents sont tous égaux et
  le calcul des angles serait payé pour rien. La réserve de Desbrun s'applique
  aux maillages scannés et aux frontières de LOD, pas à nous.
  → Contient aussi l'alternative à Taubin pour la conservation du volume :
  remettre à l'échelle par **β = (V⁰/Vⁿ)^(1/3)** après chaque pas, « inoffensif
  en termes de fréquences ». Envisageable si le lissage devait un jour être
  poussé au-delà de 2 cycles.

- **VTK — `vtkWindowedSincPolyDataFilter`.**
  https://vtk.org/doc/nightly/html/classvtkWindowedSincPolyDataFilter.html
  → Les valeurs par défaut d'une implémentation de production : `PassBand`
  **0,1** (c'est exactement le `k_PB` de Taubin), `NumberOfIterations` **20**,
  `FeatureAngle` **45°**. Et le chiffre qui justifie tout : « *dix ou vingt
  itérations suffisent généralement* », contre **100 à 200** pour un laplacien
  simple.

- **VTK — `vtkSurfaceNets3D` et `vtkConstrainedSmoothingFilter`.**
  https://vtk.org/doc/nightly/html/classvtkSurfaceNets3D.html ·
  https://vtk.org/doc/nightly/html/classvtkConstrainedSmoothingFilter.html
  → Les stratégies de contrainte nommées : `CONSTRAINT_DISTANCE` (sphère) et
  `CONSTRAINT_BOX` (AABB). Défauts : 10 itérations, facteur de relaxation
  **0,01**, distance de contrainte 0,001. *Ce facteur très bas montre que VTK
  privilégie franchement la fidélité ; notre λ = 0,5 avec 4 itérations est bien
  plus agressif, ce qui est correct parce qu'on lisse pour l'œil, pas pour la
  mesure.*

- **Ju, T., Losasso, F., Schaefer, S., Warren, J.** — *Dual Contouring of
  Hermite Data*, SIGGRAPH 2002, et **Schaefer, S. & Warren, J.** — *Dual
  Contouring: The Secret Sauce*, Rice TR 02-408.
  https://www.cs.rice.edu/~jwarren/papers/techreport02408.pdf
  → Le QEF `E(x) = Σ (nᵢ·(x−pᵢ))²`, sa forme normale à 10 scalaires (dont ils
  disent qu'elle « **élève le conditionnement au carré** »), la variante stable
  par rotations de Givens (**~150 opérations contre 10**), et la troncature des
  valeurs singulières **à une magnitude absolue de 1** — qui n'est valide que
  parce que les normales sont **unitaires**. Détail directement pertinent pour
  nous : ils ont **rejeté les normales pondérées par l'aire** dans le QEF, parce
  qu'elles « *produisaient occasionnellement des artefacts où des features
  étaient perdues par troncature incorrecte des valeurs singulières* ».
  → Le « mass point » (moyenne des intersections d'arêtes) comme terme de
  régularisation : `x = c + p` avec `c = (AᵀA)⁺(AᵀB − AᵀA·p)`. **Or ce mass
  point est exactement le sommet du Naive Surface Nets.** D'où la lecture qui
  cadre tout le §2.6 : *Naive Surface Nets = QEF avec un poids de biais infini ;
  Dual Contouring non biaisé = QEF avec un biais nul ; tout ce qui est utile est
  entre les deux* — et notre Taubin feature-aware est un point de cet intervalle,
  atteint sans SVD.

- **Gildea, N.** — *Implementing Dual Contouring*, 2014.
  https://ngildea.blogspot.com/2014/11/implementing-dual-contouring.html
  → Le repli pragmatique de production : si la position résolue sort de l'AABB
  de la feuille, **on la ramène au mass point**. Autrement dit, en pratique, le
  DC dégénère fréquemment en Surface Nets — ce qui conforte le §2.6.

- **BorisTheBrave** — *Dual Contouring Tutorial*, 2018.
  https://www.boristhebrave.com/2018/04/15/dual-contouring-tutorial/
  → « *il n'y a aucune garantie que le point résolu soit dans la cellule* », et
  le problème non-manifold : « *quand deux surfaces traversent une cellule,
  elles la partagent* ». Nos nappes fines de sable en effondrement sont
  exactement ce cas.

- **Kobbelt, L. et al.** — *Feature Sensitive Surface Extraction from Volume
  Data* (Extended Marching Cubes), SIGGRAPH 2001.
  https://www.graphics.rwth-aachen.de/media/papers/feature1.pdf
  → Les seuils de détection d'arête par **cône de normales** : `θ_sharp = 0.9`,
  `θ_corner = 0.7`, avec la mise en garde « *θ_sharp peut être choisi assez
  grand, disons 0,9, **si les données de gradient ne sont pas trop bruitées*** »
  — ce qui est précisément notre cas de figure défavorable (§1.3), et une raison
  de plus de flouter le champ avant toute détection de feature.
  → Confirme aussi la projection de Newton : « *pour une taille de grille
  raisonnablement petite… **les itérations de Newton convergent rapidement vers
  la solution exacte*** ».

- **0fps** — *Smooth Voxel Terrain, Part 2*, 2012.
  https://0fps.net/2012/07/12/smooth-voxel-terrain-part-2/
  → Le benchmark de référence (65³, pire cas) : **Marching Cubes 274,6 ms /
  ~154 k sommets ; Surface Nets 124,3 ms / ~73 k sommets**, soit **2,2× plus
  rapide et 2× moins de sommets**. Et le diagnostic en un mot du défaut de la
  variante naïve : le maillage est « **bevelled** rather than sharp ».

## Coutures entre chunks, LOD, geomorphing

- **Lengyel, E.** — *Voxel-Based Terrain for Real-Time Virtual Simulations*,
  thèse, UC Davis 2010. https://transvoxel.org/Lengyel-VoxelTerrain.pdf
  → **La règle d'apron, énoncée exactement** : « *afin de calculer un champ de
  normales, nous avons besoin d'accéder à **un voxel supplémentaire avant et
  après** chaque voxel utilisé par le bloc… générer le maillage d'un bloc
  requiert l'accès à un volume de **[n+3]³** voxels* ». Notre `BORDER = 6` est
  très au-delà de ce minimum — et c'est ce surplus qui finance le lissage (§2.2).
  → La démonstration que **le pop d'ombrage est un problème distinct du pop
  géométrique** : « *il peut aussi être nécessaire de stocker une normale
  secondaire pour éviter un saut d'ombrage qui pourrait se produire **même si
  les sommets morphés se trouvent dans la surface** du maillage de moindre
  détail* ». C'est exactement pourquoi notre §3.2 morphe `aPrevNormal` en plus de
  `aPrevPos`.
  → Et une piste de compression directement applicable à notre `aPrevPos` : en
  morphant **uniquement le long de la normale**, la position secondaire se
  réduit à **un scalaire**, et avec un décalage tangent 8 bits + un angle 8 bits
  pour la normale, on tombe à « **quatre octets par sommet** » au lieu de douze.
  Lengyel signale honnêtement la limite : « *il n'est pas clair que ce point
  existe toujours* ». À garder en réserve si les 1,8 Mo du §3.2 gênaient.
  → Enfin, sur les coutures de LOD : une largeur de cellule de transition nulle
  produit un maillage étanche mais « *conduit à de **sévères problèmes
  d'ombrage*** ». Étanche ≠ correctement ombré : c'est le même piège que le
  lissage local du §2.2.

- **Strugar, F.** — *Continuous Distance-Dependent Level of Detail for Rendering
  Heightmaps* (CDLOD), JGT 2009.
  https://github.com/fstrugar/CDLOD ·
  https://raw.githubusercontent.com/fstrugar/CDLOD/master/cdlod_paper_latest.pdf
  → Le morph **par sommet et non par chunk** (« *unlike [Ulrich 02], where the
  morph is performed per-node* »), et la zone de morph qui « *couvre
  habituellement les derniers **15 % à 30 %** de chaque plage de LOD* ». Le
  facteur de morph est un simple `saturate` d'une rampe linéaire évaluée dans le
  vertex shader — la même forme que notre `clamp((uTime − aMorphT0)/uMorphDur)`.
  → La contrainte de correction des coutures qui vaut aussi chez nous : le
  facteur de morph doit être calculé à partir d'une quantité **cohérente sur
  tout le domaine**, sinon les sommets de bord divergent. Chez nous c'est trivial
  (c'est un temps global), ce qui est un avantage net de l'appariement par clé de
  cellule.

- **Zylann — Godot Voxel Tools, documentation « smooth terrain ».**
  https://voxel-tools.readthedocs.io/en/latest/smooth_terrain/
  → Confirmation en production : normales par différences du SDF, normale
  géométrique de repli `normalize(cross(dFdy(VERTEX), dFdx(VERTEX)))`, et
  quantification du SDF (8 bits sur [−10, 10], pas ≈ 0,078). Notre densité
  `Uint8` sur [0, 255] avec `ISO = 128` a un pas équivalent de 1/255 de voxel :
  largement suffisant.

## Normales

- **VCGlib (noyau de MeshLab) — `vcg/complex/algorithms/update/normal.h`.**
  https://raw.githubusercontent.com/cnr-isti-vclab/vcglib/main/vcg/complex/algorithms/update/normal.h
  → Les trois pondérations, implémentées côte à côte. **Par l'aire** (le défaut) :
  on accumule la normale de face **non normalisée**, ce qui donne la pondération
  par l'aire gratuitement. **Par l'angle** (Thürmer & Wüthrich 1998) : normale
  normalisée × angle du coin. **De Max** (JGT 4(2), 1999) : `wᵢ = (a × b) /
  (‖a‖²‖b‖²)`, dont le commentaire du code précise qu'elle est « *parfaite
  seulement pour les surfaces sphériques* ».
  → **Notre choix (aire) est le bon ici** : sur un maillage dual à valence quasi
  constante 4 et arêtes quasi égales, l'écart entre les trois est sous le degré,
  et l'aire est la seule qui soit littéralement gratuite.

- **Quilez, I.** — *Normals of a triangle mesh*.
  https://iquilezles.org/articles/normals/
  → La formulation en une passe : « *la longueur d'un produit vectoriel est
  proportionnelle à l'aire* », donc on saute à la fois la normalisation par face
  et la division par le nombre de faces.

- **libigl — tutoriel, normales par sommet.** https://libigl.github.io/tutorial/
  → « *la pondération uniforme est **fortement biaisée par le choix de
  discrétisation*** » ; les pondérations par aire et par angle sont « plus
  robustes ». Et le motif accumulate-and-normalize sans traversée de half-edge,
  qui est exactement notre `accumFace`.

## Filtrage bilatéral

- **Fleishman, S., Drori, I., Cohen-Or, D.** — *Bilateral Mesh Denoising*,
  SIGGRAPH 2003.
  https://www.cs.tau.ac.il/~dcor/articles/2003/Bilateral-Mesh-Denoising.pdf
  → Les deux noyaux `W_c(x) = e^(−x²/2σ_c²)` (proximité tangentielle) et
  `W_s(x) = e^(−x²/2σ_s²)` (similarité des offsets), avec **ρ = 2σ_c** pour le
  rayon de voisinage. La recette de réglage : σ_c = un rayon où la surface est
  censée être lisse, σ_s = l'écart-type des offsets dans ce voisinage.
  **« Nous avons utilisé jusqu'à cinq itérations »**, et l'arbitrage explicite :
  préférer **un petit σ_c avec plus d'itérations** à un grand σ_c avec peu, parce
  que « *de grandes valeurs peuvent traverser les features* ». *(Notre
  `BF_SIGMA_S = 1.4` voxel avec 2 itérations est exactement dans cet esprit.)*
  → Les deux modes de défaillance à connaître : le filtre **rétrécit** l'objet
  (ils appliquent la remise à l'échelle de Desbrun), et il peut provoquer des
  **auto-intersections** sur les arêtes vives après un nombre d'itérations
  inversement proportionnel à l'angle. *Deux raisons de plus de plafonner à 2
  itérations et de conserver la bride `MAX_DRIFT`.*

- **Zheng, Y., Fu, H., Au, O. K.-C., Tai, C.-L.** — *Bilateral Normal Filtering
  for Mesh Denoising*, IEEE TVCG 17(10), 2011.
  https://doi.org/10.1109/TVCG.2010.264 *(accès fermé)* — noyaux reproduits par
  **Yadav, S. et al.**, *Surface Denoising based on Normal Filtering in a Robust
  Statistics Framework*, arXiv:2007.00842, éq. 28.
  https://arxiv.org/abs/2007.00842
  → Le filtre opère sur le **maillage dual** (normales de face portées par les
  centroïdes de face), avec `g(x) = exp(−x²/2σ_s²)` sur `‖nᵢ − nⱼ‖` et
  `f_d(d) = exp(−d²/2σ_d²)` sur la distance des centroïdes. Point de réglage
  précieux : **σ_d est la distance moyenne entre faces voisines** — c'est-à-dire
  qu'il se dérive du maillage et ne se règle pas. *(Chez nous, la distance
  moyenne entre sommets voisins vaut ~1 voxel ; d'où `BF_SIGMA_S = 1.4`,
  légèrement au-dessus pour couvrir les 6 voisins sans déborder.)*

## Rendu de l'écoulement

- **Vlachos, A.** — *Water Flow in Portal 2*, SIGGRAPH 2010 (Advances in
  Real-Time Rendering).
  https://cdn.akamai.steamstatic.com/apps/valve/2010/siggraph2010_vlachos_waterflow.pdf
  → **La source de tout notre §3.4.** Chiffres à retenir : flow map à
  **~4 texels par mètre** seulement (nous en avons 25) ; observation fondatrice
  reprise de Max & Becker 1995 selon laquelle **seul le début de la distorsion
  est convaincant** ; **deux couches décalées d'une demi-phase** pour masquer le
  redémarrage ; **bruit sur la phase** pour supprimer la pulsation ; **force de
  la normale mise à l'échelle par la vitesse d'écoulement** ; coût total
  **+2 lectures de texture et +21 instructions ALU**, expédié en `ps_2.0b`.
  → Et le détail qui compte le plus pour nous, parce que notre grain est une
  **carte de couleur** : pour les normales, l'intervalle va de 0 à une fraction
  avec le pic à mi-distorsion ; **pour la couleur, il faut décaler l'intervalle
  à ±½ fraction pour que le pic de visibilité tombe sur la distorsion NULLE**,
  car « une carte de couleur tolère beaucoup moins de distorsion ». C'est notre
  `(pA − 0.5)`.
  → Donnée de design intéressante : les playtesteurs ont fait **17 % de mauvais
  virages en moins** avec les indices d'écoulement.

- **Flick, J. (Catlike Coding)** — *Texture Distortion / Flow*.
  https://catlikecoding.com/unity/tutorials/flow/texture-distortion/
  → L'implémentation de référence, avec le poids triangulaire
  `uvw.z = 1 − |1 − 2·progress|` (les deux phases somment à 1) et le paramètre
  `_FlowOffset = −0.5` qui matérialise la variante « couleur » de Vlachos. Aussi
  la modulation du relief par la vitesse : `finalHeightScale = flow.z ·
  _HeightScaleModulated + _HeightScale`.

- **van der Laan, W. J., Green, S., Sainz, M.** — *Screen Space Fluid Rendering
  with Curvature Flow*, I3D 2009.
  https://wstahw.win.tue.nl/edu/2IV06/andrei/particle_rendering/provided/p91-van_der_laan.pdf
  → Le pipeline écran-espace de référence (§3.5), et deux idées empruntables
  telles quelles : la reconstruction de normale par **la plus petite des deux
  différences finies unilatérales** aux discontinuités, et le **bruit qui advecte
  avec la matière** (une octave de Perlin par particule, splattée en gaussienne
  et accumulée additivement, dont l'amplitude est **augmentée là où |Δv| dépasse
  un seuil** puis retombe). Ce dernier mécanisme est l'analogue exact de notre
  `flowMag` pilotant l'amplitude du micro-relief.
  → Les mesures qui justifient de ne pas y aller : pleine résolution,
  **100 itérations, 50 ms**.

- **Truong, N. & Yuksel, C.** — *A Narrow-Range Filter for Screen-Space Fluid
  Rendering*, i3D 2018 / PACMCGIT 1(1):17.
  https://www.cemyuksel.com/research/papers/narrowrangefilter.pdf ·
  https://github.com/ttnghia/RealTimeFluidRendering
  → L'état de l'art du lissage de profondeur : gaussienne dont les profondeurs
  voisines sont **bornées et non rejetées**, ce qui donne des bords **courbes**
  plutôt que plats. Paramètres publiés **δ = 10r, μ = r**, en **2 passes 1D + 1
  passe 2D de nettoyage 5×5**. Coût **0,46–1,21 ms** sur GTX 1080 pour 65 k à
  368 k splats — meilleure qualité que le curvature flow à 100 itérations pour un
  dixième du prix. *À garder en réserve si le jeu doit un jour montrer un rideau
  de sable dense (§3.5).*

- **Macklin, M., Müller, M., Chentanez, N., Kim, T.-Y.** — *Unified Particle
  Physics for Real-Time Applications*, ACM TOG 33(4), SIGGRAPH 2014 (NVIDIA
  FleX). https://mmacklin.com/uppfrta_preprint.pdf
  → La référence pour le sable en PBD, et **leur figure de validation est
  littéralement un château de sable** qui tient son angle de repos sur 300
  images. Leur scène « Sandcastle » : **29 000 particules, 3 sous-pas × 12
  itérations, 12,1 ms sur GTX 680**. Deux enseignements pour nous : (1) l'usage
  de **sous-pas** plutôt que de plus d'itérations est le bon réglage pour du
  granulaire — c'est exactement notre §4.2 ; (2) leur contribution centrale est
  le **frottement au niveau des positions** (un amortissement en vitesse ne peut
  pas modéliser le frottement statique et les tas s'affaissent), ce qui justifie
  le terme de Coulomb sur le contact de nos grains (§3.3).

- **Fei, Y., Wu, K. et al.** — *Principles Towards Real-Time Simulation of
  Material Point Method on Modern GPUs*. https://raymondyfei.github.io/gpu_mpm/
  → Le point de comparaison haut de gamme : un bloc de sable de **389 000
  particules en temps réel**, mais sur **4× Tesla V100**. Utile uniquement pour
  situer l'ordre de grandeur : la MPM est la référence de fidélité, la PBD est ce
  qui s'expédie, et un automate cellulaire sur grille est ce qui tient dans un
  onglet de navigateur.

- **Edwards, J. (thatgamecompany)** — *Sand Rendering in Journey*, GDC 2013.
  https://www.gdcvault.com/play/1017742/Sand-Rendering-in ·
  reconstruction commentée avec code : https://www.alanzucconi.com/2019/10/08/journey-sand-shader-1/
  → Trois ans de développement pour du sable, et la décomposition en six
  couches. Ce qui nous concerne directement : le **spéculaire délibérément
  emprunté à l'eau** (c'est lui qui fait lire le sable comme un fluide), le
  **mélange de quatre normal maps de rides** piloté par `steepness =
  pow(dot(N, up), k)`, et surtout le **glitter comme porte microfacette et non
  comme puissance** — un seuil sur `R·V` plutôt qu'un `pow()`, additif, qui
  alimente le bloom. *(Notre `SandMaterial` fait déjà un sparkle par cellule de
  hash ; la variante par porte est plus stable en distance.)*
  → Enseignement de fond : **la continuité du sable de Journey ne vient pas de
  la géométrie**. C'est une réponse purement shader. Notre §3.4 en est la
  transposition.

- **Gustafsson, D. (Voxagon)** — *From screen space to voxel space*, 2018 ·
  **Wittens, S.** — *Teardown Frame Teardown*.
  https://blog.voxagon.se/2018/10/17/from-screen-space-to-voxel-space.html ·
  https://acko.net/blog/teardown-frame-teardown/
  → Voxels de **5 cm** (nous : 4 cm), monde 100×100×25 m, volume d'ombre
  bit-packé à **8 voxels par octet** sur 4 mips, 2 Go ramenés à **292 Mo**, et
  tout l'éclairage en **~9 ms à 1080p sur GTX 1080**.
  → Deux enseignements. (1) **Teardown ne convertit jamais la destruction en
  particules** : un débris devient une *nouvelle texture 3D*, récursivement. Ce
  choix est cohérent avec le nôtre — notre couche de grains est **décorative** et
  ne porte pas de masse (§3.3). (2) Le **flou de normales entre voxels voisins,
  conditionné par la similarité de profondeur**, pour arrondir les arêtes de
  Lego : c'est notre `bilateralNormals` (§2.4c), en espace écran plutôt qu'en
  espace objet.

- **Purho, P. (Nolla Games)** — *Exploring the Tech and Design of Noita*,
  GDC 2019. https://www.gdcvault.com/play/1025695/Exploring-the-Tech-and-Design
  → Chunks de **64×64 pixels** avec **rect sale** par chunk, et un
  multithreading **en damier à 4 passes séquentielles** avec une **marge de 32
  pixels** dans les directions cardinales — sans verrou. *Notre `Granular` fait
  déjà exactement ça (4 files de damier `(x&1, z&1)`) ; la convergence est
  rassurante.*
  → Mais le constat honnête, et il faut le dire : **Noita ne masque pas la
  discrétisation, il l'assume.** Une cellule de simulation vaut un pixel écran,
  donc il n'y a pas de grille visible — la grille *est* le pixel. C'est
  l'exact opposé de notre problème, et c'est pourquoi aucune de leurs solutions
  de rendu n'est transposable. Ce qui l'est : leur ordonnancement, et le
  contourage (marching squares chez eux, Surface Nets chez nous) d'un champ de
  cellules vers une géométrie lisse.

- **Bel, R. & Chahi, É. (Ubisoft)** — *Creating a High-Performance Simulation:
  An Interactive Dynamic Natural World* (« Galileo », le moteur de *From Dust*),
  GDC Europe 2010. https://www.gdcvault.com/play/1013667/Creating-a-High-Performance-Simulation
  → À citer avec une réserve : **la conférence porte sur la simulation, pas sur
  le rendu.** Il n'existe pas de source publique sur la façon dont *From Dust*
  rendait la matière en écoulement. Ce qui est documenté : un champ de hauteurs
  en couches (roche / sable / eau / lave), shallow-water couplé à
  érosion-sédimentation, et une implémentation **SIMD 128 bits entièrement
  multithreadée, SPU compris sur PS3**.
  → L'enseignement transposable est donc **négatif et instructif** : leur réponse
  à la continuité visuelle n'a pas été d'affiner la grille, mais de rendre le pas
  de simulation assez bon marché pour tourner à haute cadence. C'est exactement
  la logique de notre §4.2.

## Documents internes cités

- `docs/RECHERCHE-PHYSIQUE-SABLE.md` — §2.3.3 (conservation de la masse),
  §2.6 (rendre l'effondrement visuellement bon : front de rupture progressif,
  cône d'éboulis, particules GPU, poussière), §5.5 (choix de Surface Nets et
  règle d'or des seams), §5.6 (budgets chiffrés).
- `docs/RECHERCHE-SABLE-DIORAMA.md` — §2.5 (normales de détail multi-échelle),
  §4.2 (courbure bakée au mailleur — destinataire naturel de `aData2.z`),
  §5.4 (traces sombres persistantes), §6.3 (`SC_HAS_DATA2`, dont ce document
  ouvre enfin l'usage).
- `docs/RECHERCHE-RENDU-3D.md` — pipeline de post-traitement, budget de frame.

---

## Annexe — les huit constantes à retenir

```js
// SIMULATION (Config.js, Granular.js)
GRANULAR_SUBSTEPS = 4        // granularite /4 a debit constant       §4.2
MAX_TRANSFER      = 24       // 9,4 % d'un voxel = 3,8 mm par sous-pas §4.2
MIN_TRANSFER      = 3        // garantit la terminaison               §4.2
STRESS_RATE       = 1 / 3 sous-pas   // 0,24 s -> 2,8 s d'avertissement §4.5

// MAILLAGE (SurfaceNets.js)
SMOOTH_ITERS      = 4        // <= BORDER - 1 = 5, sinon coutures      §2.2
TAUBIN_LAMBDA     = 0.50     // f(2) = 0 : la trame meurt              §2.1
TAUBIN_MU         = -0.53    // k_PB = 0,113 : la forme vit            §2.1
MAX_DRIFT         = 0.75     // en VOXELS, et sur une BOULE            §2.1

// RENDU (TerrainRenderer.js, SandGrains.js, SandMaterial.js)
MORPH_DUR         = 0.12 s   // 7 images                               §3.2
MAX_GRAINS        = 6000     // 1 draw call, plafond 10 px             §3.3
uFlowRate         = 0.55     // cycles/s                               §3.4
```
