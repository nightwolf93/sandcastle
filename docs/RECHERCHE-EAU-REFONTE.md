# Refonte de l'eau — comportement, chutes d'eau, rivières et lisibilité

> Document frère de `RECHERCHE-OCEAN.md`. Celui-là traite du **rendu** de l'eau
> (réfraction d'écran, absorption de Beer-Lambert, caustiques, jupe de volume,
> spéculaire GGX, sun glitter). Celui-ci traite du **comportement** : ce que
> l'eau fait, et comment on le rend *lisible*. Les deux se recouvrent en un seul
> endroit — le shader de surface — et les renvois sont explicites.
>
> Question du joueur, mot pour mot : « refonte de l'eau pour la rendre plus
> réaliste, fluide, et visuellement compréhensive dans sa physique, vraiment
> pouvoir créer des rivières, des chutes d'eau, que ça soit vraiment visible et
> plaisant à regarder ».
>
> Quatre mots comptent là-dedans : **compréhensive**, **rivières**,
> **chutes d'eau**, **visible**. Trois d'entre eux sont hors de portée du
> solveur actuel — non par manque de réglage, mais par construction. C'est le
> sujet du chapitre 1.

---

## Table des matières

- [1. Diagnostic du solveur actuel](#1-diagnostic-du-solveur-actuel)
  - [1.1 Ce que `Water.js` sait faire](#11-ce-que-waterjs-sait-faire)
  - [1.2 Les hypothèses du modèle en eaux peu profondes](#12-les-hypothèses-du-modèle-en-eaux-peu-profondes)
  - [1.3 Les cinq impossibilités structurelles](#13-les-cinq-impossibilités-structurelles)
  - [1.4 Audit ligne à ligne](#14-audit-ligne-à-ligne)
- [2. Chutes d'eau — l'architecture hybride](#2-chutes-deau--larchitecture-hybride)
  - [2.1 Le principe : ce qui décroche quitte la grille](#21-le-principe--ce-qui-décroche-quitte-la-grille)
  - [2.2 Détecter le seuil](#22-détecter-le-seuil)
  - [2.3 Le débit au seuil : la formule du déversoir](#23-le-débit-au-seuil--la-formule-du-déversoir)
  - [2.4 La couche de particules balistiques](#24-la-couche-de-particules-balistiques)
  - [2.5 Réabsorption, impulsion, conservation](#25-réabsorption-impulsion-conservation)
  - [2.6 `Cascade.js` — le fichier complet](#26-cascadejs--le-fichier-complet)
  - [2.7 Le rendu de la lame qui tombe](#27-le-rendu-de-la-lame-qui-tombe)
  - [2.8 Embrun et halo humide](#28-embrun-et-halo-humide)
- [3. Rendre l'écoulement lisible](#3-rendre-lécoulement-lisible)
  - [3.1 Pourquoi on ne voit rien aujourd'hui](#31-pourquoi-on-ne-voit-rien-aujourdhui)
  - [3.2 Flow map : le double défilement croisé](#32-flow-map--le-double-défilement-croisé)
  - [3.3 Le champ de flux côté JS](#33-le-champ-de-flux-côté-js)
  - [3.4 Le GLSL complet](#34-le-glsl-complet)
  - [3.5 Étirement anisotrope le long des lignes de courant](#35-étirement-anisotrope-le-long-des-lignes-de-courant)
  - [3.6 Traînées d'écume advectées](#36-traînées-décume-advectées)
  - [3.7 Rides transversales et ondes stationnaires](#37-rides-transversales-et-ondes-stationnaires)
  - [3.8 Doser : la règle des trois indices](#38-doser--la-règle-des-trois-indices)
- [4. Eau blanche](#4-eau-blanche)
  - [4.1 Les critères physiques d'apparition](#41-les-critères-physiques-dapparition)
  - [4.2 Les trois échelles](#42-les-trois-échelles)
  - [4.3 Le code du générateur](#43-le-code-du-générateur)
  - [4.4 Persistance et dissipation](#44-persistance-et-dissipation)
- [5. Rivières](#5-rivières)
  - [5.1 Le bilan qui décide si une rivière vit ou meurt](#51-le-bilan-qui-décide-si-une-rivière-vit-ou-meurt)
  - [5.2 Les sources](#52-les-sources)
  - [5.3 Pourquoi `erode()` rabote au lieu de creuser](#53-pourquoi-erode-rabote-au-lieu-de-creuser)
  - [5.4 La loi de puissance de courant](#54-la-loi-de-puissance-de-courant)
  - [5.5 Sape de berge et `digAt`](#55-sape-de-berge-et-digat)
  - [5.6 Méandres : la courbure comme substitut au courant hélicoïdal](#56-méandres--la-courbure-comme-substitut-au-courant-hélicoïdal)
  - [5.7 Seuils et vasques](#57-seuils-et-vasques)
- [6. Qualité du solveur](#6-qualité-du-solveur)
  - [6.1 Les quatre candidats](#61-les-quatre-candidats)
  - [6.2 Le verdict](#62-le-verdict)
  - [6.3 Le schéma retenu, en détail](#63-le-schéma-retenu-en-détail)
  - [6.4 Chocs et ressauts sans explosion](#64-chocs-et-ressauts-sans-explosion)
  - [6.5 Conservation du volume : garantie et test](#65-conservation-du-volume--garantie-et-test)
  - [6.6 Supprimer la gélatine](#66-supprimer-la-gélatine)
- [7. Réglages et lisibilité pour le joueur](#7-réglages-et-lisibilité-pour-le-joueur)
- [8. Plan d'implémentation ordonné](#8-plan-dimplémentation-ordonné)
- [9. Bibliographie](#9-bibliographie)

---

## 1. Diagnostic du solveur actuel

### 1.1 Ce que `Water.js` sait faire

Il faut commencer par là, parce que le solveur actuel est bon dans son
domaine, et qu'une refonte qui casserait ces acquis serait une régression.

`Water.js` implémente le modèle « pipe » de Mei, Decaudin et Hu (Pacific
Graphics 2007), lui-même descendant direct de Kass & Miller (SIGGRAPH 1990).
Chaque cellule porte une hauteur d'eau `h`, et quatre tuyaux virtuels vers ses
voisines portent un débit accéléré par la différence de charge hydraulique :

```
f'_{i→j} = max(0, f_{i→j} · d + Δt · (A · g / L) · (H_i − H_j))
H = b + h                         (charge hydraulique, b = terrain)
```

puis une passe de mise à l'échelle borne la somme des sorties par le contenu de
la cellule :

```
si  Σ f_out > h_i · A / Δt   alors   f *= (h_i · A / Δt) / Σ f_out
```

Ce que ça produit, et qui marche :

| Capacité | Pourquoi ça marche |
|---|---|
| **Positivité inconditionnelle** de `h` | La mise à l'échelle garantit qu'une cellule ne donne jamais plus qu'elle n'a. C'est ce qui autorise `dt = 1/60` sans CFL explicite. |
| **Mouillage / assèchement** arbitraire | Une cellule sèche ne calcule aucun flux sortant, mais peut en recevoir. Pas de cas particulier à écrire. |
| **Nivellement** | Un creux se remplit et la surface libre s'aplanit — le comportement « flaque » est correct. |
| **Propagation d'ondes longues** | Le schéma est une équation d'ondes discrétisée : la vitesse de propagation observée est bien √(g·h). Le ressac imposé au large se propage tout seul jusqu'à l'estran. C'est joli et c'est gratuit. |
| **Marée + nappe non plane** | `updateWaterTable()` est un très bon design : la nappe suit le rivage courant et s'enfonce vers l'arrière-plage. C'est ce qui rend le geste « creuser près de l'eau » signifiant. **À conserver tel quel.** |
| **Bandes de balayage** | `scanA/scanB` avec union des lignes voisines : 3× moins de cellules parcourues, et le commentaire sur la tranchée diagonale montre que le piège a déjà été payé. **À conserver.** |
| **Érosion + advection de sédiment** | Le squelette est là (capacité, arrachement, dépôt, advection semi-lagrangienne), avec un seuil qui dépend de la cohésion. La structure est bonne ; c'est la *loi* qui est fausse (§5.3). |

Coût mesuré par `stats.ms` : de l'ordre de 1 à 2 ms par pas sur les
~20 000 cellules mouillées d'une marée moyenne. Il y a donc du budget.

### 1.2 Les hypothèses du modèle en eaux peu profondes

Les équations de Saint-Venant s'obtiennent en intégrant Navier-Stokes sur la
verticale, sous trois hypothèses. Ce sont elles qui décident de ce que le
solveur peut ou ne peut pas représenter.

**(H1) Pression hydrostatique.** On suppose l'accélération verticale négligeable
devant g, donc

```
p(x, y, z) = ρ g (η(x,z) − y)          η = b + h  (surface libre)
```

C'est vrai tant que la longueur horizontale caractéristique L est grande devant
la profondeur H : le paramètre de shallowness σ = H/L doit être ≪ 1. Sur une
marche verticale de 30 cm dans une grille de 4 cm, σ ≈ 7,5. L'hypothèse n'est
pas « un peu tendue », elle est **inversée**.

**(H2) Champ de hauteur univoque.** L'eau est décrite par une fonction
`h(x, z)` : une seule colonne d'eau par cellule, pas de surplomb, pas de lame
détachée, pas de goutte en l'air. Une chute d'eau est *par définition* une
surface libre multivaluée au-dessus du même (x, z) : il y a de l'eau à
y = 1,20 m (au bord du seuil), du vide entre 0,9 et 1,15 m, et de l'eau à
y = 0,85 m (dans la vasque). Aucun champ de hauteur ne peut écrire ça.

**(H3) Vitesse uniforme sur la verticale.** Pas de profil logarithmique, pas de
courant hélicoïdal secondaire. Conséquence directe : **pas de méandres
spontanés** (le mécanisme physique du méandre est justement la circulation
secondaire qui transporte le sédiment de la berge externe vers la berge
interne). §5.6 propose un substitut.

À ces trois hypothèses du modèle, le schéma « pipe » en ajoute une quatrième,
qui lui est propre :

**(H4) Linéarisation.** Saint-Venant complet s'écrit

```
∂h/∂t + ∇·(h u) = 0
∂(h u)/∂t + ∇·(h u⊗u) + g h ∇η = −g h S_f          (S_f = frottement)
                     ^^^^^^^^^^^
```

Le terme encadré est l'**advection de quantité de mouvement**. Le modèle
« pipe » ne le contient pas : le flux n'est accéléré que par le gradient de
charge, jamais transporté par lui-même. Formellement, `Water.js` résout une
équation d'ondes amortie, pas Saint-Venant. C'est **la** cause de l'aspect
gélatine (§6.6) et de l'absence de jet, de chocs et de ressauts.

### 1.3 Les cinq impossibilités structurelles

**① Aucune chute d'eau ne peut exister.** (H2). Au bord d'une terrasse, le
gradient de charge est énorme, donc le flux demandé est énorme, donc la mise à
l'échelle le borne à `h·A/Δt` : la cellule se vide entièrement en un pas et
son contenu **apparaît instantanément** dans la cellule d'en bas, sans jamais
traverser l'espace intermédiaire. Vitesse horizontale effective maximale :
`VOXEL/Δt = 0.04 × 60 = 2,4 m/s` — puis le garde-fou de `integrate()` la
plafonne à 4 m/s de toute façon. Visuellement : la lame reste plaquée au
niveau de la terrasse, et l'eau se téléporte. Le joueur creuse une terrasse,
verse un seau, et rien ne tombe.

**② L'écoulement n'a aucun marqueur visuel.** `vx`/`vz` sont calculés
(`integrate()` ligne ~419) mais **ne quittent jamais la simulation** :
`WaterRenderer.update()` n'exporte que `level, h, foam, sed`. Le shader n'a
donc littéralement aucune information de direction. Toute la texture de surface
défile dans trois directions fixes codées en dur (`D0/D1/D2` dans
`detailNormal`), identiques partout, indépendantes de l'eau. Une rivière qui
coule vers le sud a exactement la même apparence qu'une flaque immobile.

**③ Pas d'eau blanche.** `foam[c] = max(foam·decay, clamp(speed·0.55, 0, 1))`.
L'écume est une fonction de la *vitesse*, pas de la *turbulence*. Or une nappe
rapide et laminaire (un filet d'eau sur une pente lisse) est transparente, et
un ressaut hydraulique quasi immobile est d'un blanc éclatant. Le critère est
faux dans les deux sens. Et il n'y a qu'une seule échelle : une valeur scalaire
en surface, pas de bulles dans le volume, pas d'embrun en particules.

**④ Les rivières ne se maintiennent pas.** Trois causes cumulées :
- pas de source durable — `pour()` est un événement ponctuel, il n'existe aucun
  objet « source » persistant ;
- l'infiltration prélève `4.0e-5 × 35 = 1,4 mm/s` sur *toute* la surface
  mouillée. Un chenal de 10 cm de large et 5 m de long fait 0,5 m² de lit, soit
  **7 × 10⁻⁴ m³/s** absorbés — c'est le débit d'un ruisseau entier. (Bonne
  nouvelle : c'est auto-limitant, `room` tombe à zéro quand le lit sature.
  Mauvaise nouvelle : personne ne le sait, et le joueur voit sa rivière
  disparaître pendant les vingt premières secondes.) ;
- l'amortissement `WATER_DAMPING = 0.985^(60·dt)` freine l'écoulement
  indépendamment de la profondeur et de la rugosité : il n'existe pas de
  **vitesse d'équilibre**. Un vrai écoulement uniforme atteint la vitesse de
  Manning et s'y tient. Ici il ralentit toujours.

**⑤ Pas de chocs.** Sans terme d'advection, le schéma ne peut pas raidir un
front. Il ne peut donc représenter ni un mascaret, ni un ressaut hydraulique,
ni un écoulement torrentiel (Fr > 1) — c'est-à-dire précisément les trois
signatures visuelles qui font dire « ça coule vraiment ».

### 1.4 Audit ligne à ligne

Points précis relevés en lecture, à corriger ou à surveiller :

- **`integrate()`, `vx[c] = dwx / (L * hm)`** — division par la profondeur. Quand
  `hm → 0` la vitesse explose ; le garde-fou `if (sp > 4)` masque le symptôme
  mais laisse un champ **très bruité** dans le film mince. Une flow map bâtie
  dessus scintillerait. Remède standard : la **désingularisation** de
  Kurganov-Petrova,
  `u = 2 h q / (h² + max(h², ε²))`, qui tend continûment vers 0 au lieu
  d'exploser. §6.4.
- **`flux()`, bord du domaine** : `fR[c] = max(0, ... + k*(H − seaLevel))`, mais
  aucun flux entrant depuis l'extérieur n'est jamais ajouté. Le bord est donc un
  **puits unidirectionnel** : la mer peut sortir du domaine, jamais y rentrer par
  ce chemin. C'est masqué par `isOcean` qui impose le niveau, mais ça fausse
  tout audit de volume.
- **`applyBoundaries()`** écrit `h[c] = max(0, level − terrain)` sur les cellules
  océan : c'est une **source/puits non comptabilisée** de volume arbitraire. Il
  faut la mesurer si on veut un test de conservation (§6.5).
- **`erode()`** : `sinA = max(EROSION_MIN_SLOPE, …)` avec un plancher à 0,06
  ⇒ **toute** cellule mouillée en mouvement érode, y compris sur un fond plat.
  C'est exactement ce qui produit le rabotage uniforme au lieu d'un lit.
- **`erode()`** utilise la pente du **terrain**, pas celle de la **surface
  libre**. Or c'est la surface libre qui pilote le cisaillement au fond
  (τ = ρ g h S avec S = |∇η|). Dans un chenal qui s'approfondit, la pente du
  fond tend vers 0 alors que la pente de la surface reste celle de la vallée :
  avec la pente du fond, l'incision s'auto-éteint ; avec celle de la surface,
  elle continue. **Ce seul changement est la clé du creusement de lit.**
- **`dig()`** retire toujours le sable **au sommet de la colonne**. Un écoulement
  qui longe une berge ne peut donc que la *décapiter*, jamais la *saper*. D'où
  des chenaux qui s'élargissent au lieu de s'approfondir. §5.5.
- **`advectSediment()`** fait un aller-retour `tmp → sed` par ligne, en lisant
  `sed` de la ligne z+1 qui a *déjà* été écrasée pour z−1… non : la copie
  `sed[row+x] = tmp[row+x]` est bien faite ligne par ligne après la boucle, mais
  la rétro-trace lit `sed[x0 + NX*(z0+1)]`, ligne pas encore traitée — donc
  correcte — **et** `sed[x0 + NX*z0]` avec `z0` pouvant valoir `z−1`, ligne
  **déjà écrasée**. Il y a un biais directionnel en Z. Peu visible, mais à
  corriger en faisant la copie après la boucle complète (une seule
  `sed.set(tmp)` en fin de passe, avec `tmp` initialisé depuis `sed`).
- **`WaterRenderer.buildRenderLevel()`** dilate le niveau sur 2 cellules. Bien vu
  pour la ligne d'eau, mais ça **écrase aussi la discontinuité au seuil d'une
  cascade** : le plan d'eau se met à descendre en pente douce là où il devrait
  se couper net. Il faudra désactiver la dilatation vers le bas quand la marche
  dépasse un seuil (§2.7).

---

## 2. Chutes d'eau — l'architecture hybride

### 2.1 Le principe : ce qui décroche quitte la grille

L'idée qui résout ① tient en une phrase :

> **Le champ de hauteur décrit l'eau qui repose sur le terrain. Dès qu'un
> paquet d'eau n'a plus de terrain sous lui, il sort du champ de hauteur, vit
> comme une particule balistique, et y revient à l'atterrissage.**

C'est exactement la stratégie de Thürey et al. (« Real-time Breaking Waves for
Shallow Water Simulations », PG 2007) pour les déferlantes, et de Chentanez &
Müller (SCA 2010) pour les éclaboussures. Aucune n'essaie de faire déferler un
champ de hauteur : elles retirent le volume qui déferle, l'envoient dans un
système de particules, et le réinjectent. Le champ de hauteur reste alors
strictement dans son domaine de validité — il n'a jamais à représenter ce qu'il
ne peut pas représenter.

Trois propriétés à exiger de l'architecture :

1. **Volume conservé exactement.** Ce qu'on retire de `h` est ce qu'on met dans
   les particules, et ce qu'on réabsorbe est ce qu'on remet dans `h`. À
   l'arrondi près, `Σ h·A + Σ V_parcelle` est invariant.
2. **Budget borné.** Le nombre de particules ne dépend pas du débit : c'est le
   *volume par particule* qui s'adapte. Sinon une grosse cascade fait tomber le
   framerate.
3. **Dégradation gracieuse.** Si le budget sature, on n'émet plus — l'eau
   redescend par les tuyaux comme aujourd'hui. Moche mais correct, et jamais de
   perte de volume.

Trois couches de représentation, et il faut les distinguer :

```
    ┌───────────────┐  h, vx, vz : la nappe qui repose sur le sable
    │  CHAMP        │  Saint-Venant / pipe.  ~20 000 cellules
    └───────┬───────┘
            │ émission au seuil (§2.3)
    ┌───────▼───────┐  parcelles balistiques : l'eau EN L'AIR
    │  PARCELLES    │  p, v, V.  budget 2 400
    └───────┬───────┘
            │ réabsorption à l'impact (§2.5)
    ┌───────▼───────┐  embrun, bulles : purement visuel, volume négligé
    │  EMBRUN       │  budget 800
    └───────────────┘
```

Le rendu, lui, ajoute une quatrième couche qui **ne simule rien** : la
**nappe** (§2.7), un ruban de géométrie qui suit la parabole théorique entre le
seuil et l'impact. Les parcelles sont trop peu nombreuses pour donner
l'impression d'un rideau continu ; la nappe la donne pour zéro coût de
simulation, et les parcelles deviennent les gouttes qui s'en détachent.

### 2.2 Détecter le seuil

Une cellule est un **seuil** (*lip*) vers une de ses quatre voisines si, dans
cette direction :

```
marche libre :   Δb = b_i − (b_j + h_j)        // du fond chez moi au plan d'eau chez le voisin
```

et que trois conditions sont réunies :

```
(C1)  Δb ≥ FALL_MIN_STEP          la marche est franche          (0,10 m = 2,5 voxels)
(C2)  h_i ≥ FALL_MIN_DEPTH        il y a vraiment une lame       (0,004 m)
(C3)  η_i > b_j + h_j             l'eau va bien dans ce sens
```

**Pourquoi pas un critère de Froude ?** Le brief le suggère, et c'est
instructif de voir pourquoi la réponse est plus fine. À un **déversoir à chute
libre** (*free overfall*), l'hydraulique classique donne un résultat propre : la
section critique (Fr = 1) se situe **3 à 4 profondeurs en amont du bord**, et
la profondeur au bord vaut ≈ 0,715 h_c (Rouse, 1936). Autrement dit, **Fr = 1
au seuil n'est pas un critère à tester, c'est une condition à imposer** : quelle
que soit la bêtise que raconte le gradient de charge, un déversoir libre laisse
passer le débit critique, ni plus ni moins. C'est ce que fait §2.3, et ça a
l'immense avantage d'être **auto-limitant** : le débit ne dépend que de `h_i`,
donc il ne peut pas diverger.

Le nombre de Froude reste central — mais pour l'**eau blanche** (§4.1) et pour
les **ondes stationnaires** (§3.7), pas pour la détection du seuil.

Un détail qui compte : la marche se mesure **jusqu'au plan d'eau du voisin**,
pas jusqu'à son fond. Une vasque qui se remplit noie progressivement sa propre
cascade, la marche diminue, et la chute redevient un simple écoulement. C'est
gratuit et c'est exactement ce qu'on veut : creuser un trou sous une cascade
la fait disparaître à mesure qu'il se remplit.

### 2.3 Le débit au seuil : la formule du déversoir

Pour un seuil épais (*broad-crested weir*), la charge amont H au-dessus de la
crête impose le débit par unité de largeur :

```
h_c = (2/3) H                          profondeur critique
q   = √(g · h_c³) = (2/3)^{3/2} √g · H^{3/2}
    ≈ 1,705 · C_d · H^{3/2}            [m²/s], C_d ≈ 0,55 … 0,65
```

Et la vitesse à la crête :

```
v_c = q / h_c = √(g · h_c)
```

**Vérification numérique** (indispensable à cette échelle) — lame de 2 cm au
seuil, C_d = 0,6 :

```
q   = 1,705 × 0,6 × 0.02^1.5 = 1,023 × 2,83e-3 = 2,89e-3 m²/s
Q   = q × VOXEL = 2,89e-3 × 0,04       = 1,16e-4 m³/s par cellule de seuil
h_c = (q²/g)^{1/3} = (8,35e-6/9,81)^{1/3} = 9,5e-3 m
v_c = √(9,81 × 9,5e-3) = 0,305 m/s
```

Par pas de 1/60 s, la cellule perd `Q·Δt = 1,93e-6 m³`, soit **6 %** de son
contenu (`h·A = 3,2e-5 m³`). Parfaitement stable, et pas besoin de sous-pas.

Et la trajectoire, pour une chute de 40 cm :

```
t_vol = √(2 × 0,40 / 9,81)     = 0,285 s
v_y   = 9,81 × 0,285           = 2,80 m/s à l'impact
portée = 0,305 × 0,285         = 0,087 m ≈ 2,2 cellules
```

Une parabole de 2 cellules de portée pour 10 cellules de hauteur : **visible**,
franchement lisible sur un diorama regardé à 2 m. Et si le joueur creuse une
chute de 1 m, la portée passe à 0,14 m — la lame s'écarte visiblement de la
paroi. Bon signe : la physique donne le bon look sans réglage.

### 2.4 La couche de particules balistiques

**Structure de données.** SoA en `Float32Array`, pile de libres, pas
d'allocation en régime permanent.

```
px, py, pz : Float32Array(N)   position monde
vx, vy, vz : Float32Array(N)   vitesse m/s
vol        : Float32Array(N)   volume porté, m³
age        : Float32Array(N)
seed       : Float32Array(N)   pour le rendu (variation par goutte)
alive      : Uint8Array(N)
freeList   : Int32Array(N) + freeTop
```

**Budget adaptatif.** C'est le point qui fait tenir la chose. On mesure le débit
total qui décroche `Q_fall` (EMA sur ~0,5 s) et on estime le temps de vol moyen
`T_vol`. Le nombre de parcelles en vol à l'équilibre vaut `Q_fall · T_vol /
V_parcelle`. On inverse :

```
V_parcelle = max( V_min , Q_fall · T_vol / (0,7 · N_max) )
```

Le facteur 0,7 laisse de la marge pour les transitoires. Avec
`N_max = 2400`, `V_min = 2 mL` :

- Filet d'eau (Q = 5e-5 m³/s, T = 0,3 s) : V_p demandé = 8,9e-9 → plancher à
  2 mL → 7 parcelles en vol. Peu, mais un filet n'a pas besoin de plus ; la
  nappe (§2.7) fait le rideau.
- Cascade large (1 m de front, lame de 2 cm : Q = 25 × 1,16e-4 = 2,9e-3 m³/s,
  T = 0,3 s) : V_p = 2,9e-3 × 0,3 / 1680 = **5,2e-7 m³** → sous le plancher →
  2 mL → 435 parcelles. Confortable.
- Vidange d'un grand bassin (Q = 3e-2 m³/s) : V_p = 5,4e-6 m³ → 1 680 parcelles,
  chacune de 5,4 mL. Le budget tient, les gouttes sont juste plus grosses —
  et comme leur rayon de rendu suit `V^{1/3}`, ça se voit à peine.

**Accumulateur d'émission.** On ne peut pas émettre une parcelle par cellule et
par pas : ce serait 25 parcelles par pas pour une cascade de 1 m, soit 1 500 par
seconde. On accumule donc, par cellule, le volume prélevé dans `pending[c]`, et
on émet dès que `pending[c] ≥ V_parcelle`. Le reliquat reste en attente. Deux
sécurités :

- Si la cellule cesse d'être un seuil, `pending` **retourne dans `h`** (sinon
  fuite de volume).
- Si le pool est plein, on **n'émet pas et on ne prélève pas** : l'eau
  redescend par les tuyaux.

**Intégration.**

```
v_y ← v_y − g Δt
v   ← v · (1 − k_drag |v| Δt)        traînée quadratique, k_drag ≈ 0,12 s/m
p   ← p + v Δt
```

La traînée n'a presque aucun effet sur une chute de 40 cm (elle retire ~2 % de
la vitesse d'impact), mais elle borne les vitesses si un jour on éjecte des
gouttes rapides, et elle empêche les parcelles de traverser le sol en un pas
(voir le CCD plus bas).

**Continuous collision.** À 2,8 m/s et Δt = 1/60, une parcelle avance de 4,7 cm,
soit plus d'un voxel. Un test « py < bed » par pas peut donc rater un plancher
mince. On sous-échantillonne la trajectoire : `nSub = 1 + floor(|v|Δt / VOXEL)`,
plafonné à 4.

### 2.5 Réabsorption, impulsion, conservation

Trois issues possibles pour une parcelle :

**(a) Amerrissage / atterrissage.** `py ≤ b_c + h_c`. On rend le volume :

```
h[c] += V / A
```

et — c'est ce qui fait la différence entre une vasque morte et une vasque qui
bouillonne — on transmet la **quantité de mouvement horizontale** :

```
impX[c] += V · v_x        [m⁴/s]
impZ[c] += V · v_z
```

qui sera convertie en flux au pas suivant (§2.6, `applyImpulses`). C'est ce qui
fait que l'eau d'une cascade **repart** dans la direction de la chute au lieu de
s'étaler symétriquement.

On génère aussi l'eau blanche à partir de l'énergie cinétique verticale
dissipée :

```
E = ½ · ρ · V · v_y²        [J]        ρ = 1000
foam[c]    = min(1, foam[c] + k_f · E)
bubbles[c] = min(1, bubbles[c] + k_b · E)
```

**Ordre de grandeur** : V = 2 mL, v_y = 2,8 m/s ⇒ E = 0,5 × 1000 × 2e-6 × 7,84
= **7,8e-3 J**. Avec 400 parcelles/s c'est 3,1 W dissipés — cohérent avec
P = ρ g Q H = 1000 × 9,81 × 2,9e-3 × 0,4 = 11 W (le reste est parti en
turbulence horizontale et en bruit). Les constantes se calent donc autour de
`k_f ≈ 60` (une parcelle sature à peu près une cellule en 2 impacts).

**(b) Paroi.** `py ≤ b_c` **et** la colonne est nettement plus haute que la
position de la parcelle (`b_c − py > 1,5 · VOXEL`) **et** elle était plus basse
au pas précédent : la parcelle a percuté un mur latéralement. On annule le
déplacement horizontal, on amortit la vitesse horizontale de 80 %, et on marque
le **halo humide** (§2.8) sur la colonne touchée. La parcelle continue de
tomber en glissant le long de la paroi — comportement correct et joli.

**(c) Sortie / péremption.** Hors domaine, ou `age > 6 s`. Le volume est
comptabilisé dans `lostOut` (audit) et la parcelle est recyclée.

**Conservation.** Invariant global à vérifier en debug :

```
V_grille(t) + V_vol(t) + V_pending(t)
  = V_grille(0) + Σ sources − Σ puits
```

Sources : `pour()`, suintement de nappe, imposition océan (positive et
négative), sources de rivière. Puits : infiltration, fuite au bord,
`lostOut` des parcelles. §6.5 donne le compteur et le test.

### 2.6 `Cascade.js` — le fichier complet

Nouveau fichier `src/sim/Cascade.js`. Il ne dépend que de `Water` et de
`VoxelField`, et se branche en une ligne dans `Water.step()`.

```js
/**
 * CASCADE — la couche balistique.
 *
 * Un champ de hauteur ne peut pas represente de l'eau EN L'AIR : il n'a qu'une
 * seule altitude de surface libre par colonne. Une chute d'eau est justement
 * l'inverse — de l'eau en haut, du vide au milieu, de l'eau en bas.
 *
 * On decoupe donc le probleme : la grille garde l'eau qui repose sur le sable,
 * et tout ce qui decroche d'un seuil devient une PARCELLE balistique, qui
 * retombe sous la seule action de la gravite et rend son volume a la grille en
 * atterrissant. Le volume est conserve exactement : ce qui est retire de h est
 * mis dans une parcelle, ce qui est absorbe y est remis.
 *
 * Le debit au seuil n'est PAS pris au solveur (il y serait faux : le gradient
 * de charge sur une marche verticale est absurde et se fait ecreter par la
 * mise a l'echelle). Il est impose par l'hydraulique du deversoir a chute
 * libre : q = 1.705 * Cd * H^1.5, avec la section critique juste en amont du
 * bord. C'est auto-limitant, donc inconditionnellement stable.
 */

import {
  NX, NZ, VOXEL, ORIGIN_X, ORIGIN_Z, GRAVITY, WATER_EPSILON, clamp,
} from '../core/Config.js';

const COLS = NX * NZ;
const A = VOXEL * VOXEL;

/** Denivele minimal pour qu'une lame decroche (m). 2.5 voxels. */
export const FALL_MIN_STEP = 0.10;
/** Lame minimale au seuil (m). En dessous, ca ruisselle, ca ne tombe pas. */
export const FALL_MIN_DEPTH = 0.004;
/** Coefficient de debit du deversoir. 0.55-0.65 pour un seuil epais. */
export const WEIR_CD = 0.60;
/** Budget de parcelles en vol. */
export const FALL_MAX = 2400;
/** Volume plancher d'une parcelle (m3). 2 mL. */
export const PARCEL_MIN_VOL = 2e-6;
/** Trainee de l'air (s/m). */
export const FALL_DRAG = 0.12;
/** Duree de vie maximale (s), filet de securite. */
export const FALL_MAX_AGE = 6;

const SQRT_G = Math.sqrt(GRAVITY);
const WEIR_K = Math.pow(2 / 3, 1.5) * SQRT_G * WEIR_CD; // ~1.023

export class Cascade {
  /**
   * @param {import('./Water.js').Water} water
   * @param {import('./VoxelField.js').VoxelField} field
   */
  constructor(water, field) {
    this.water = water;
    this.field = field;

    const N = FALL_MAX;
    this.px = new Float32Array(N);
    this.py = new Float32Array(N);
    this.pz = new Float32Array(N);
    this.vx = new Float32Array(N);
    this.vy = new Float32Array(N);
    this.vz = new Float32Array(N);
    this.vol = new Float32Array(N);
    this.age = new Float32Array(N);
    this.seed = new Float32Array(N);
    this.alive = new Uint8Array(N);
    /** Pile des indices libres. */
    this.freeList = new Int32Array(N);
    for (let i = 0; i < N; i++) this.freeList[i] = N - 1 - i;
    this.freeTop = N;
    this.count = 0;

    /** Volume en attente d'emission, par cellule (m3). */
    this.pending = new Float32Array(COLS);
    /** Direction moyenne ponderee de l'emission en attente. */
    this.pendDx = new Float32Array(COLS);
    this.pendDz = new Float32Array(COLS);
    /** Vitesse critique en attente (m/s). */
    this.pendV = new Float32Array(COLS);

    /**
     * Impulsion horizontale rendue a la grille a l'atterrissage (m4/s).
     * C'est ce qui fait qu'une vasque REPART dans le sens de la chute au lieu
     * de s'etaler en rond.
     */
    this.impX = new Float32Array(COLS);
    this.impZ = new Float32Array(COLS);

    /** Liste des seuils actifs de la frame, pour le rendu de la nappe. */
    this.lips = [];       // {x,z,dx,dz,y0,v0,drop,q}
    this.lipCount = 0;

    /** Volume par parcelle, adaptatif. */
    this.parcelVol = PARCEL_MIN_VOL;
    /** Debit total qui decroche (EMA, m3/s). */
    this.fallRate = 0;
    /** Temps de vol moyen observe (EMA, s). */
    this.flightTime = 0.3;

    /** Audit de volume. */
    this.emitted = 0;
    this.absorbed = 0;
    this.lostOut = 0;

    /** Callback (x,y,z, power, vol) -> embrun. Branche par le renderer. */
    this.onSplash = null;
    /** Callback (col, amount) -> halo humide sur une paroi. */
    this.onWallHit = null;
  }

  get inFlight() {
    let v = 0;
    for (let i = 0; i < FALL_MAX; i++) if (this.alive[i]) v += this.vol[i];
    return v;
  }

  get pendingVolume() {
    let v = 0;
    for (let c = 0; c < COLS; c++) v += this.pending[c];
    return v;
  }

  // -------------------------------------------------------------------------

  step(dt) {
    this.impX.fill(0);
    this.impZ.fill(0);
    this.lipCount = 0;
    this.detectAndEmit(dt);
    this.integrate(dt);
    this.applyImpulses(dt);
  }

  // -------------------------------------------------------------------------
  // EMISSION
  // -------------------------------------------------------------------------

  detectAndEmit(dt) {
    const W = this.water, F = this.field;
    const h = W.h, surf = F.surfaceH;
    let rate = 0;

    // Volume par parcelle, ajuste au debit observe pour tenir le budget.
    const want = (this.fallRate * this.flightTime) / (FALL_MAX * 0.7);
    this.parcelVol = Math.max(PARCEL_MIN_VOL, want);

    for (let z = 1; z < NZ - 1; z++) {
      const row = NX * z;
      const xa = Math.max(1, W.scanA[z]);
      const xb = Math.min(NX - 2, W.scanB[z]);
      for (let x = xa; x <= xb; x++) {
        const c = row + x;
        const hw = h[c];
        if (hw < FALL_MIN_DEPTH) {
          // Plus de seuil ici : on rend le reliquat, sinon fuite de volume.
          if (this.pending[c] > 0) {
            h[c] += this.pending[c] / A;
            this.pending[c] = 0;
            this.pendDx[c] = this.pendDz[c] = this.pendV[c] = 0;
          }
          continue;
        }
        const bc = surf[c];
        const eta = bc + hw;

        // --- chercher la face la plus decrochante ---------------------------
        let bestDrop = 0, bdx = 0, bdz = 0;
        for (let k = 0; k < 4; k++) {
          const dx = k === 0 ? 1 : k === 1 ? -1 : 0;
          const dz = k === 2 ? 1 : k === 3 ? -1 : 0;
          const n = c + dx + NX * dz;
          const etaN = surf[n] + h[n];
          if (eta <= etaN) continue;               // (C3) l'eau ne va pas par la
          const drop = bc - etaN;                  // marche libre sous MON fond
          if (drop < FALL_MIN_STEP) continue;      // (C1)
          if (drop > bestDrop) { bestDrop = drop; bdx = dx; bdz = dz; }
        }
        if (bestDrop <= 0) {
          if (this.pending[c] > 0) {
            h[c] += this.pending[c] / A;
            this.pending[c] = 0;
          }
          continue;
        }

        // --- debit critique du deversoir a chute libre ----------------------
        // q [m2/s] ne depend QUE de la charge : auto-limitant, donc stable.
        const q = WEIR_K * hw * Math.sqrt(hw);
        let dV = q * VOXEL * dt;
        // Jamais plus de 45% de la cellule en un pas : garde-fou de positivite.
        const cap = hw * A * 0.45;
        if (dV > cap) dV = cap;
        if (dV <= 0) continue;

        // Profondeur et vitesse critiques (pour l'etat initial de la parcelle).
        const hcrit = Math.cbrt((q * q) / GRAVITY);
        const vcrit = Math.sqrt(GRAVITY * Math.max(hcrit, 1e-4));

        // Si le pool est plein, on NE PRELEVE PAS : l'eau redescend par les
        // tuyaux. Degradation gracieuse, volume conserve.
        if (this.freeTop === 0 && this.pending[c] + dV < this.parcelVol) {
          continue;
        }

        h[c] -= dV / A;
        rate += dV / dt;
        this.pending[c] += dV;
        this.pendDx[c] += bdx * dV;
        this.pendDz[c] += bdz * dV;
        this.pendV[c] += vcrit * dV;

        // Le seuil est memorise pour le rendu de la nappe (§2.7).
        if (this.lipCount < 512) {
          this.lips[this.lipCount++] = {
            x, z, dx: bdx, dz: bdz,
            y0: bc + hw * 0.35,        // profondeur au bord ~ 0.715 h_c
            v0: vcrit, drop: bestDrop, q,
          };
        }

        // --- emission ------------------------------------------------------
        while (this.pending[c] >= this.parcelVol && this.freeTop > 0) {
          const V = this.parcelVol;
          const inv = 1 / this.pending[c];
          const ux = this.pendDx[c] * inv;
          const uz = this.pendDz[c] * inv;
          const uv = this.pendV[c] * inv;
          this.pending[c] -= V;
          this.pendDx[c] -= ux * V;
          this.pendDz[c] -= uz * V;
          this.pendV[c] -= uv * V;
          this.spawn(x, z, bc + hw * 0.35, ux, uz, uv, V);
        }
      }
    }

    this.fallRate += (rate - this.fallRate) * 0.15;
  }

  spawn(x, z, y, ux, uz, v0, V) {
    const i = this.freeList[--this.freeTop];
    this.alive[i] = 1;
    this.count++;

    // On nait sur l'ARETE de la cellule, cote aval : sinon la lame semble
    // partir du milieu de la derniere cellule et flotte dans le vide.
    const jx = (Math.random() - 0.5) * 0.9;
    const jz = (Math.random() - 0.5) * 0.9;
    this.px[i] = ORIGIN_X + (x + 0.5 + ux * 0.5 + jz * Math.abs(uz)) * VOXEL;
    this.pz[i] = ORIGIN_Z + (z + 0.5 + uz * 0.5 + jx * Math.abs(ux)) * VOXEL;
    this.py[i] = y;

    // Dispersion : +-12% sur la vitesse, +-8 deg sur la direction. Sans elle
    // la lame est un rideau de gouttes parfaitement alignees, tres artificiel.
    const s = v0 * (0.88 + Math.random() * 0.24);
    const a = (Math.random() - 0.5) * 0.28;
    const ca = Math.cos(a), sa = Math.sin(a);
    this.vx[i] = (ux * ca - uz * sa) * s;
    this.vz[i] = (ux * sa + uz * ca) * s;
    this.vy[i] = -0.05 * v0;                 // legerement plongeant au bord

    this.vol[i] = V;
    this.age[i] = 0;
    this.seed[i] = Math.random();
    this.emitted += V;
  }

  // -------------------------------------------------------------------------
  // INTEGRATION
  // -------------------------------------------------------------------------

  integrate(dt) {
    const F = this.field, W = this.water;
    const surf = F.surfaceH, h = W.h;
    let flightAcc = 0, flightN = 0;

    for (let i = 0; i < FALL_MAX; i++) {
      if (!this.alive[i]) continue;

      let x = this.px[i], y = this.py[i], z = this.pz[i];
      let ux = this.vx[i], uy = this.vy[i], uz = this.vz[i];

      // Sous-pas : a 2.8 m/s on avance de 4.7 cm par frame, soit plus d'un
      // voxel. Sans CCD une parcelle traverse un plancher mince.
      const sp = Math.sqrt(ux * ux + uy * uy + uz * uz);
      const nSub = Math.min(4, 1 + ((sp * dt) / VOXEL) | 0);
      const sdt = dt / nSub;

      let done = false;
      for (let s = 0; s < nSub && !done; s++) {
        uy -= GRAVITY * sdt;
        const v = Math.sqrt(ux * ux + uy * uy + uz * uz);
        const kd = 1 - Math.min(0.5, FALL_DRAG * v * sdt);
        ux *= kd; uy *= kd; uz *= kd;

        const nx = x + ux * sdt;
        const ny = y + uy * sdt;
        const nz = z + uz * sdt;

        const cx = ((nx - ORIGIN_X) / VOXEL) | 0;
        const cz = ((nz - ORIGIN_Z) / VOXEL) | 0;
        if (cx < 0 || cz < 0 || cx >= NX || cz >= NZ) {
          this.lostOut += this.vol[i];
          this.kill(i); done = true; break;
        }
        const c = cx + NX * cz;
        const bed = surf[c];
        const top = bed + h[c];

        if (ny <= bed) {
          // --- sol ou paroi ? ---
          const ocx = ((x - ORIGIN_X) / VOXEL) | 0;
          const ocz = ((z - ORIGIN_Z) / VOXEL) | 0;
          const oldBed = surf[clamp(ocx, 0, NX - 1) + NX * clamp(ocz, 0, NZ - 1)];
          const wall = (bed - ny > VOXEL * 1.5) && (bed - oldBed > VOXEL);
          if (wall) {
            // PAROI : on glisse le long. Le mouvement horizontal est annule,
            // la chute continue. C'est ce qui plaque la lame contre la falaise.
            this.onWallHit?.(c, this.vol[i]);
            ux *= 0.18; uz *= 0.18;
            x += ux * sdt; y = ny; z += uz * sdt;
            continue;
          }
          this.land(i, c, ux, uy, uz);
          done = true; break;
        }
        if (ny <= top && h[c] > WATER_EPSILON) {
          this.land(i, c, ux, uy, uz);       // plouf dans la vasque
          done = true; break;
        }
        x = nx; y = ny; z = nz;
      }

      if (done) continue;

      this.px[i] = x; this.py[i] = y; this.pz[i] = z;
      this.vx[i] = ux; this.vy[i] = uy; this.vz[i] = uz;
      this.age[i] += dt;
      if (this.age[i] > FALL_MAX_AGE) {
        this.lostOut += this.vol[i];
        this.kill(i);
      } else { flightAcc += this.age[i]; flightN++; }
    }

    if (flightN > 0) {
      const mean = (flightAcc / flightN) * 2; // age moyen ~ moitie du vol
      this.flightTime += (clamp(mean, 0.08, 1.5) - this.flightTime) * 0.05;
    }
  }

  /** Atterrissage : le volume et la quantite de mouvement rentrent au bercail. */
  land(i, c, ux, uy, uz) {
    const W = this.water;
    const V = this.vol[i];
    W.h[c] += V / A;
    this.absorbed += V;

    this.impX[c] += V * ux;
    this.impZ[c] += V * uz;

    // Energie cinetique verticale dissipee -> eau blanche.
    const E = 0.5 * 1000 * V * uy * uy;         // joules
    W.foam[c] = Math.min(1, W.foam[c] + E * 60);
    if (W.bubbles) W.bubbles[c] = Math.min(1, W.bubbles[c] + E * 45);

    if (this.onSplash && -uy > 0.9) {
      this.onSplash(this.px[i], W.h[c] + this.field.surfaceH[c], this.pz[i], -uy, V);
    }
    this.kill(i);
  }

  kill(i) {
    this.alive[i] = 0;
    this.freeList[this.freeTop++] = i;
    this.count--;
  }

  // -------------------------------------------------------------------------
  // RETOUR DE QUANTITE DE MOUVEMENT
  // -------------------------------------------------------------------------

  /**
   * Convertit l'impulsion accumulee en flux sortants.
   *
   * impX est en m4/s (volume x vitesse). Le flux d'un tuyau est en m3/s. Le
   * temps caracteristique de transfert est le temps de traversee d'une
   * cellule, VOXEL/|v| ; en pratique on injecte simplement imp/VOXEL borne par
   * ce que la cellule peut donner, et la mise a l'echelle de flux() fera le
   * reste au pas suivant.
   */
  applyImpulses(dt) {
    const W = this.water;
    const inv = 1 / VOXEL;
    for (let c = 0; c < COLS; c++) {
      const ix = this.impX[c];
      if (ix > 0) W.fR[c] += ix * inv; else if (ix < 0) W.fL[c] -= ix * inv;
      const iz = this.impZ[c];
      if (iz > 0) W.fT[c] += iz * inv; else if (iz < 0) W.fB[c] -= iz * inv;
    }
  }
}
```

**Branchement dans `Water.js`** — trois lignes :

```js
// constructeur, apres this.foam :
this.bubbles = new Float32Array(COLS);
this.cascade = null;   // injecte apres construction pour eviter le cycle

// step(dt), entre integrate() et erode() :
this.flux(dt);
this.integrate(dt);
this.cascade?.step(dt);      // <-- ICI : apres integrate, avant erode
this.erode(dt);
```

L'ordre compte. `cascade.step()` doit venir **après** `integrate()` pour que
`h` soit à jour, et **avant** `erode()` pour que l'impact d'une chute soit
compté dans l'érosion du même pas (c'est ce qui creuse la vasque).

Et dans `Game.js` :

```js
this.water = new Water(this.field, this.granular, this.moisture);
this.cascade = new Cascade(this.water, this.field);
this.water.cascade = this.cascade;
```

### 2.7 Le rendu de la lame qui tombe

Une cascade convaincante, c'est **quatre couches empilées** qui font chacune un
travail que les autres ne peuvent pas faire :

| Couche | Ce qu'elle donne | Coût |
|---|---|---|
| **Nappe** (ruban paramétrique) | La continuité du rideau, l'étirement, la transparence en haut | ~200 quads instanciés |
| **Gouttes** (les parcelles) | Le grain, le mouvement individuel, l'éclatement en bas | ≤ 2 400 sprites |
| **Embrun** (§2.8) | Le volume au pied, le halo lumineux | ≤ 800 sprites |
| **Vasque** (grille) | L'écume, les bulles, les ondes concentriques | gratuit |

**La nappe.** Une géométrie instanciée : un quad par cellule de seuil, plié en
parabole dans le *vertex shader*. C'est la partie élégante — la trajectoire
exacte est analytique, donc on n'a rien à simuler :

```
t(s) = s · T,      T = temps de vol = (v0y + √(v0y² + 2 g D)) / g
horiz(s) = v0 · t
y(s)     = y0 + v0y · t − ½ g t²
```

Et **l'épaisseur de la lame** suit la conservation du débit : `q = v · e`, donc

```
e(s) = q / v(s),      v(s) = √(v0² + (v0y + g·t)²)
```

C'est ça qui donne la lame qui **s'affine et devient transparente en tombant**,
sans aucun réglage arbitraire. Un vrai détail de vraisemblance.

`src/render/FallSheet.js`, version condensée :

```js
import * as THREE from 'three';
import { VOXEL, GRAVITY, ORIGIN_X, ORIGIN_Z, NX } from '../core/Config.js';

const MAX_LIPS = 512;
const SEGS = 10;            // segments verticaux du ruban

const VERT = /* glsl */ `
uniform float uTime;
uniform float uG;

attribute vec3  aOrigin;    // point de depart au bord du seuil
attribute vec2  aDir;       // direction horizontale (normalisee)
attribute float aV0;        // vitesse au seuil (m/s)
attribute float aDrop;      // hauteur de chute (m)
attribute float aQ;         // debit lineique (m2/s)
attribute float aSeed;

varying float vFall;        // distance verticale parcourue (m)
varying float vSpan;        // -0.5..0.5 en travers de la lame
varying float vThin;        // epaisseur relative (1 en haut)
varying float vSeed;
varying vec3  vWorld;

void main() {
  // position.x = span (-0.5..0.5), position.y = s (0..1)
  float s = position.y;
  vSpan = position.x;
  vSeed = aSeed;

  float T = sqrt(2.0 * aDrop / uG);
  float t = s * T;
  float y = aOrigin.y - 0.5 * uG * t * t;
  vec2  o = aOrigin.xz + aDir * (aV0 * t);
  vFall = aOrigin.y - y;

  // Epaisseur : conservation du debit. e = q / v.
  float v = sqrt(aV0 * aV0 + (uG * t) * (uG * t));
  vThin = aV0 / max(v, 1e-3);

  // La lame se CONTRACTE en tombant (elle se rassemble en filets).
  float width = ${VOXEL.toFixed(4)} * (1.0 - 0.35 * s);
  vec2 perp = vec2(-aDir.y, aDir.x);
  vec3 p = vec3(o.x + perp.x * vSpan * width, y,
                o.y + perp.y * vSpan * width);

  vWorld = p;
  gl_Position = projectionMatrix * viewMatrix * vec4(p, 1.0);
}
`;

const FRAG = /* glsl */ `
uniform float uTime;
uniform vec3  uShallow;
uniform vec3  uSunColor;
uniform vec3  uSunDir;
uniform float uBreak0;      // debut de l'eclatement (m)
uniform float uBreak1;      // eclatement total (m)

varying float vFall;
varying float vSpan;
varying float vThin;
varying float vSeed;
varying vec3  vWorld;

float hash12(vec2 p){ vec3 q=fract(vec3(p.xyx)*0.1031); q+=dot(q,q.yzx+33.33);
  return fract((q.x+q.y)*q.z); }
float vn(vec2 p){ vec2 i=floor(p),f=fract(p); f=f*f*(3.0-2.0*f);
  return mix(mix(hash12(i),hash12(i+vec2(1,0)),f.x),
             mix(hash12(i+vec2(0,1)),hash12(i+vec2(1,1)),f.x),f.y); }

void main() {
  // Progression de l'eclatement : 0 = nappe pleine, 1 = pluie de gouttes.
  float br = smoothstep(uBreak0, uBreak1, vFall);

  // Filets verticaux : le motif DESCEND avec l'eau, a la vitesse locale.
  // C'est le seul indice de vitesse dont dispose l'oeil sur une lame lisse.
  float scroll = uTime * (2.0 + vFall * 3.0);
  float strand = vn(vec2(vSpan * 9.0 + vSeed * 40.0, vFall * 22.0 - scroll));
  float fine   = vn(vec2(vSpan * 26.0 + vSeed * 13.0, vFall * 60.0 - scroll * 1.7));

  // La nappe se troue : le seuil du bruit monte avec la distance de chute.
  float a = mix(1.0, step(0.30 + 0.55 * br, strand * 0.65 + fine * 0.35), br);

  // Bords adoucis, et affinement par conservation du debit.
  a *= 1.0 - smoothstep(0.34, 0.5, abs(vSpan));
  a *= mix(1.0, vThin, 0.7);
  if (a < 0.02) discard;

  // Couleur : de l'eau blanchie par l'air entraine, de plus en plus blanche
  // a mesure qu'elle eclate.
  vec3 col = mix(uShallow * 1.15, vec3(0.95, 0.97, 0.99), 0.35 + 0.55 * br);
  // Contre-jour : une lame d'eau mince est TRES lumineuse a contre-jour.
  float back = pow(clamp(dot(normalize(uSunDir), vec3(0.0, -1.0, 0.0)) * -1.0
                         + 0.5, 0.0, 1.0), 2.0);
  col += uSunColor * back * 0.25 * vThin;
  // Liseré blanc sur les aretes de la lame.
  col = mix(col, vec3(1.0), smoothstep(0.28, 0.46, abs(vSpan)) * 0.5);

  gl_FragColor = vec4(col, a * 0.92);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

export class FallSheet {
  constructor(scene, cascade, shared) {
    this.cascade = cascade;
    const base = new THREE.PlaneGeometry(1, 1, 1, SEGS);
    base.translate(0, 0.5, 0);            // s va de 0 (seuil) a 1 (impact)
    const geo = new THREE.InstancedBufferGeometry();
    geo.index = base.index;
    geo.attributes.position = base.attributes.position;

    const f3 = (n) => new THREE.InstancedBufferAttribute(new Float32Array(MAX_LIPS * n), n);
    this.aOrigin = f3(3); this.aDir = f3(2); this.aV0 = f3(1);
    this.aDrop = f3(1); this.aQ = f3(1); this.aSeed = f3(1);
    geo.setAttribute('aOrigin', this.aOrigin);
    geo.setAttribute('aDir', this.aDir);
    geo.setAttribute('aV0', this.aV0);
    geo.setAttribute('aDrop', this.aDrop);
    geo.setAttribute('aQ', this.aQ);
    geo.setAttribute('aSeed', this.aSeed);
    geo.instanceCount = 0;
    this.geo = geo;

    this.uniforms = {
      uTime: shared.uTime, uShallow: shared.uShallow,
      uSunColor: shared.uSunColor, uSunDir: shared.uSunDir,
      uG: { value: GRAVITY },
      uBreak0: { value: 0.18 }, uBreak1: { value: 0.75 },
    };
    this.mesh = new THREE.Mesh(geo, new THREE.ShaderMaterial({
      uniforms: this.uniforms, vertexShader: VERT, fragmentShader: FRAG,
      transparent: true, depthWrite: false, side: THREE.DoubleSide,
    }));
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 11;           // au-dessus de la surface d'eau
    scene.add(this.mesh);
    this._seeds = new Float32Array(MAX_LIPS);
    for (let i = 0; i < MAX_LIPS; i++) this._seeds[i] = Math.random();
  }

  update() {
    const C = this.cascade;
    const n = Math.min(C.lipCount, MAX_LIPS);
    const O = this.aOrigin.array, D = this.aDir.array;
    for (let i = 0; i < n; i++) {
      const L = C.lips[i];
      O[i * 3] = ORIGIN_X + (L.x + 0.5 + L.dx * 0.5) * VOXEL;
      O[i * 3 + 1] = L.y0;
      O[i * 3 + 2] = ORIGIN_Z + (L.z + 0.5 + L.dz * 0.5) * VOXEL;
      D[i * 2] = L.dx; D[i * 2 + 1] = L.dz;
      this.aV0.array[i] = L.v0;
      this.aDrop.array[i] = L.drop;
      this.aQ.array[i] = L.q;
      this.aSeed.array[i] = this._seeds[i];
    }
    this.geo.instanceCount = n;
    this.aOrigin.needsUpdate = this.aDir.needsUpdate = true;
    this.aV0.needsUpdate = this.aDrop.needsUpdate = true;
    this.aQ.needsUpdate = this.aSeed.needsUpdate = true;
  }
}
```

**Les gouttes.** Les parcelles se rendent en `THREE.Points` avec un shader qui
les **étire le long de la vitesse**. C'est capital : une goutte sphérique à
2,8 m/s lue par un œil (ou une caméra) laisse une traînée. Sans l'étirement, la
cascade a l'air d'être une pluie de billes.

```glsl
// vertex, pour un quad instancie oriente en billboard
vec3 vdir = normalize(aVel);
float stretch = 1.0 + clamp(length(aVel) * uExposure, 0.0, 3.0);  // uExposure ~ 0.06
// on allonge le billboard dans la direction ecran de la vitesse
vec4 cv = viewMatrix * vec4(aVel, 0.0);
vec2 sdir = normalize(cv.xy + vec2(1e-5));
vec2 quad = position.xy * aRadius;
quad = sdir * dot(quad, sdir) * stretch + (quad - sdir * dot(quad, sdir));
```

avec `aRadius = 0.55 · (3V/4π)^{1/3} · k_visual`. Pour V = 2 mL le rayon
physique est 7,8 mm ; on l'agrandit de ×2,5 environ, sinon les gouttes sont
sous-pixel et scintillent.

**Correctif obligatoire dans `WaterRenderer`.** La dilatation de
`buildRenderLevel()` doit s'arrêter aux marches franches, sinon la surface
d'eau part en biseau depuis le seuil et vient couper la nappe :

```js
// dans la boucle de dilatation, remplacer le test de voisinage par :
const stepDown = surf[c] - surf[nb];          // nb = voisin candidat
if (best < tmp[nb] && stepDown < FALL_MIN_STEP * 0.5) best = tmp[nb];
```

### 2.8 Embrun et halo humide

**Embrun (`onSplash`).** Au pied d'une chute, l'énergie dissipée fabrique des
gouttelettes fines qui montent, se dispersent et retombent en brouillard. On
les simule comme des sprites très légers, avec traînée forte et flottabilité
apparente :

```js
// Emission : n particules, n proportionnel a la puissance dissipee.
const P = 0.5 * 1000 * vol * vy * vy;         // J
const n = Math.min(4, Math.round(P * 900));
for (let k = 0; k < n; k++) {
  const a = Math.random() * Math.PI * 2;
  const r = Math.random();
  mist.spawn(
    x + Math.cos(a) * r * 0.05, y + 0.01, z + Math.sin(a) * r * 0.05,
    Math.cos(a) * (0.25 + 0.5 * Math.random()) * vy * 0.25,
    (0.35 + 0.65 * Math.random()) * vy * 0.30,     // vers le HAUT
    Math.sin(a) * (0.25 + 0.5 * Math.random()) * vy * 0.25,
    0.8 + Math.random() * 1.6                       // duree de vie
  );
}
```

Intégration : `v.y -= g·dt·0.25` (la gravité apparente d'un aérosol est très
réduite par la traînée), `v *= exp(−dt/0.35)`, plus un petit bruit de vent
`+ wind·dt`. Rendu en sprites additifs doux, `alpha = (1−age/life)² · 0.25`,
taille croissante (`r = r0 + 0.35·age`) — un nuage d'embrun **grossit** en
vieillissant, c'est sa signature.

**Halo humide (`onWallHit`).** Quand une parcelle percute une paroi, on marque
la colonne. Le plus simple et le plus juste ici : injecter directement dans le
système d'humidité existant, qui sait déjà assombrir le sable.

```js
cascade.onWallHit = (c, vol) => {
  const x = c % NX, z = (c / NX) | 0;
  const top = field.topY[c];
  if (top < 0) return;
  const i = c + NX * NZ * top;
  const add = Math.min(255 - field.moisture[i], Math.ceil(vol * 8e5));
  if (add > 0) {
    field.moisture[i] += add;
    field.touchVisual(x, top, z);
    moisture.touchColumn(x, z);
  }
};
```

Bénéfice caché : la paroi mouillée devient **cohésive** (via `cohesionFactor`),
donc une cascade qui bat une falaise de sable la *renforce* localement au lieu
de la détruire — comportement réel, et joli retour de jeu.

Pour l'auréole visuelle sur les premiers centimètres au-dessus de la ligne de
projection, voir `RECHERCHE-OCEAN.md` §5.6 : le patch de `SandMaterial.js` gère
déjà l'assombrissement par l'humidité, il n'y a rien à ajouter côté shader.

---

## 3. Rendre l'écoulement lisible

C'est le cœur de la demande — « visuellement compréhensive dans sa physique ».

### 3.1 Pourquoi on ne voit rien aujourd'hui

Trois raisons, dans l'ordre d'importance :

1. **La vitesse ne quitte jamais le CPU.** `WaterRenderer` exporte
   `(level, h, foam, sed)`. Il manque `(vx, vz)`. Sans elles, aucun effet ne
   peut être orienté.
2. **Le détail de surface défile dans des directions fixes.** `D0/D1/D2` dans
   `detailNormal()` sont des constantes. Le grain de la mer est le même partout
   et va toujours du même côté.
3. **L'œil lit le mouvement par des *traits*, pas par des *points*.** C'est de
   la perception, pas du rendu : un champ de bruit isotrope qui se translate est
   très difficile à lire ; une **traînée allongée dans le sens du courant** est
   immédiatement lisible. D'où l'insistance sur trois choses en §3.5, §3.6 et
   §3.7 : étirement anisotrope, traînées d'écume, rides transversales.

### 3.2 Flow map : le double défilement croisé

**Le problème.** On veut que la texture de surface soit *transportée* par le
champ de vitesse. La méthode naïve — accumuler le déplacement,
`uv ← uv − v·Δt` — échoue toujours, et il faut comprendre pourquoi : la
déformation d'un champ advecté croît **exponentiellement**. Le gradient de
déformation F obéit à `dF/dt = (∇v)·F`, donc ses valeurs singulières croissent
comme `exp(λt)` où λ est l'exposant de Lyapunov du champ. Au bout de quelques
secondes, la texture est étirée en filaments et n'a plus aucune structure.

**La solution : régénération périodique et fondu.** C'est l'idée de Neyret
(« Advected Textures », SCA 2003) : on maintient plusieurs copies de la texture,
chacune remise à zéro périodiquement, avec des **phases décalées**, et on les
mélange en pondérant chaque copie par une fonction qui s'annule au moment de sa
remise à zéro. Ainsi aucune copie n'accumule plus d'une période de distorsion.

La version jeu — deux copies, décalage d'un demi-cycle, fondu triangulaire — est
celle publiée par Alex Vlachos pour l'eau de *Portal 2* (SIGGRAPH 2010, cours
*Advances in Real-Time Rendering*), et c'est **la** technique clé de tout ce
document :

```
t   = temps / T_cycle
p₀  = frac(t)
p₁  = frac(t + 0,5)
w   = |2·p₀ − 1|                                  ← onde triangulaire

uv₀ = uv − flow · p₀ · amplitude
uv₁ = uv − flow · p₁ · amplitude

résultat = mix( tex(uv₀), tex(uv₁), w )
```

**Vérification du fondu**, parce que c'est là que tout le monde se trompe :

| p₀ | p₁ | w | couche visible | distorsion de la couche visible |
|---|---|---|---|---|
| 0,00 | 0,50 | **1** | couche 1 | 0,50 (mi-cycle) |
| 0,25 | 0,75 | 0,5 | mélange | 0,25 / 0,75 |
| 0,50 | 0,00 | **0** | couche 0 | 0,50 (mi-cycle) |
| 0,75 | 0,25 | 0,5 | mélange | 0,75 / 0,25 |
| 1,00⁻ | 0,50 | **1** | couche 1 | 0,50 |

La couche qui vient de se réinitialiser a toujours un poids nul, et la couche
pleinement visible est toujours à mi-distorsion. **Le saut est invisible.**
Distorsion maximale portée par une couche : `flow · amplitude` sur un cycle.

**Les deux corrections indispensables.**

*(a) Le battement global.* Si `t` est le même partout, tout l'écran fond au même
instant et on perçoit une pulsation. Correction classique : décaler la phase par
un bruit **basse fréquence spatial**, `p = frac(t + n(uv·0,3))`. Les zones
voisines fondent à des instants différents, la pulsation disparaît. Attention :
le décalage doit être **basse fréquence et statique**, sinon on réintroduit du
bruit haute fréquence à chaque cycle.

*(b) Le budget de distorsion.* On veut que la distorsion maximale reste
inférieure à ~0,7 période de la texture, sinon on voit « nager ». Avec une
texture qui se répète tous les `1/tile` mètres :

```
T_cycle ≤ 0,7 / (tile · v_max)
```

Pour `tile = 3 rep/m` (motif de 33 cm) et `v_max = 1 m/s` : `T_cycle ≤ 0,23 s`.
C'est court, et un cycle court crée son propre problème (on voit le fondu
respirer). Le compromis pratique : **T_cycle fixe autour de 1,2 s, et
amplitude qui sature** —

```
d = flow · T_cycle · tile
si |d| > 0,7  alors  d *= 0,7/|d|
```

L'eau très rapide ne « défile » alors pas plus vite que la limite, et c'est la
**traînée d'écume** (§3.6) et le **grain étiré** (§3.5) qui portent le surplus
de vitesse. C'est le bon partage : la flow map dit la *direction*, les traînées
disent la *vitesse*.

### 3.3 Le champ de flux côté JS

Il faut une deuxième texture. Convention proposée :

```
uFlow.r = flowX     m/s, lisse
uFlow.g = flowZ     m/s, lisse
uFlow.b = Froude    sans dimension
uFlow.a = whitewater  0..1  (l'ecume advectee, §3.6)
```

**Résolution.** La flow map n'a aucun besoin de la résolution voxel : elle décrit
une structure d'écoulement de l'ordre du décimètre. On l'exporte en **128×128**
(demi-résolution), ce qui divise par 4 le transfert (256 Ko/frame au lieu de
1 Mo) *et* fait le lissage gratuitement. Le filtrage linéaire du GPU reconstruit
un champ parfaitement doux.

**Lissage.** Deux étages, indispensables tous les deux :

- **temporel** : EMA de constante de temps τ ≈ 0,22 s. Sans ça, la vitesse issue
  du modèle « pipe » papillote à la fréquence de simulation et la texture
  tremble.
- **spatial** : un box 3×3 séparable. Sans ça, la division par `hm` dans
  `integrate()` fabrique des pics isolés dans le film mince.

Dans `Water.js` :

```js
// --- constructeur ---
/** Champ de vitesse LISSE, pour le rendu (flow map). Ne pilote PAS la physique. */
this.flowX = new Float32Array(COLS);
this.flowZ = new Float32Array(COLS);
this.flowTmp = new Float32Array(COLS);
/** Nombre de Froude, lisse. Fr = |v| / sqrt(g h). */
this.froude = new Float32Array(COLS);
/** Air entraine dans le volume (bulles), 0..1. */
this.bubbles = new Float32Array(COLS);
/** Ecume ADVECTEE (traines). Distincte de foam, qui est locale. */
this.trail = new Float32Array(COLS);
this.trailTmp = new Float32Array(COLS);

/** Constante de temps du lissage du champ de flux (s). */
static FLOW_TAU = 0.22;
```

```js
/**
 * Prepare le champ destine au rendu : vitesse lissee, Froude, et l'ecume
 * advectee. C'est PUREMENT visuel : rien ici ne revient dans la physique.
 * Appele en fin de step().
 */
updateFlowField(dt) {
  const h = this.h, vx = this.vx, vz = this.vz;
  const fx = this.flowX, fz = this.flowZ, fr = this.froude;
  const k = 1 - Math.exp(-dt / 0.22);
  const invG = 1 / GRAVITY;

  for (let z = 0; z < NZ; z++) {
    const row = NX * z;
    const xa = this.scanA[z], xb = this.scanB[z];
    for (let x = xa; x <= xb; x++) {
      const c = row + x;
      const hw = h[c];
      if (hw < WATER_EPSILON) {
        fx[c] -= fx[c] * k; fz[c] -= fz[c] * k; fr[c] -= fr[c] * k;
        continue;
      }
      fx[c] += (vx[c] - fx[c]) * k;
      fz[c] += (vz[c] - fz[c]) * k;
      // Froude : LE nombre qui dit si l'ecoulement est fluvial ou torrentiel.
      const sp = Math.hypot(vx[c], vz[c]);
      const cel = Math.sqrt(GRAVITY * hw);
      fr[c] += (sp / cel - fr[c]) * k;
    }
  }
  this.blurBand(fx);
  this.blurBand(fz);
  this.blurBand(fr);
}

/** Box 3x3 separable, restreint aux bandes mouillees. ~0.25 ms. */
blurBand(a) {
  const t = this.flowTmp;
  // horizontal
  for (let z = 0; z < NZ; z++) {
    const row = NX * z;
    const xa = Math.max(1, this.scanA[z]), xb = Math.min(NX - 2, this.scanB[z]);
    for (let x = xa; x <= xb; x++) {
      const c = row + x;
      t[c] = (a[c - 1] + a[c] * 2 + a[c + 1]) * 0.25;
    }
    for (let x = xa; x <= xb; x++) a[row + x] = t[row + x];
  }
  // vertical
  for (let z = 1; z < NZ - 1; z++) {
    const row = NX * z;
    const xa = Math.max(1, this.scanA[z]), xb = Math.min(NX - 2, this.scanB[z]);
    for (let x = xa; x <= xb; x++) {
      const c = row + x;
      t[c] = (a[c - NX] + a[c] * 2 + a[c + NX]) * 0.25;
    }
  }
  for (let z = 1; z < NZ - 1; z++) {
    const row = NX * z;
    const xa = Math.max(1, this.scanA[z]), xb = Math.min(NX - 2, this.scanB[z]);
    for (let x = xa; x <= xb; x++) a[row + x] = t[row + x];
  }
}
```

et dans `step()`, tout à la fin : `this.updateFlowField(dt);`

**Côté `WaterRenderer`**, la deuxième texture, en demi-résolution :

```js
// --- constructeur ---
const FW = NX >> 1, FH = NZ >> 1;
this.flowW = FW; this.flowH = FH;
this.flowData = new Float32Array(FW * FH * 4);
this.flowTex = new THREE.DataTexture(this.flowData, FW, FH,
                                     THREE.RGBAFormat, THREE.FloatType);
this.flowTex.magFilter = THREE.LinearFilter;
this.flowTex.minFilter = THREE.LinearFilter;
this.flowTex.wrapS = this.flowTex.wrapT = THREE.ClampToEdgeWrapping;
this.flowTex.needsUpdate = true;

// uniformes ajoutes
uFlow:        { value: this.flowTex },
uFlowCycle:   { value: 1.20 },     // duree d'un cycle (s)
uFlowTile:    { value: 3.0 },      // repetitions du motif par metre
uFlowDistort: { value: 1.0 },      // 0 = fige, 1 = normal (reglage joueur)
uFlowMax:     { value: 0.70 },     // distorsion max en periodes de texture
```

```js
/** Reduction 2x2 du champ de flux vers la texture GPU. */
updateFlowTexture() {
  const w = this.water;
  const FW = this.flowW, FH = this.flowH, d = this.flowData;
  const fx = w.flowX, fz = w.flowZ, fr = w.froude, tr = w.trail;
  for (let j = 0; j < FH; j++) {
    const z0 = j * 2, z1 = z0 + 1;
    for (let i = 0; i < FW; i++) {
      const x0 = i * 2, x1 = x0 + 1;
      const a = x0 + NX * z0, b = x1 + NX * z0;
      const c = x0 + NX * z1, e = x1 + NX * z1;
      const o = (i + FW * j) * 4;
      d[o]     = (fx[a] + fx[b] + fx[c] + fx[e]) * 0.25;
      d[o + 1] = (fz[a] + fz[b] + fz[c] + fz[e]) * 0.25;
      d[o + 2] = (fr[a] + fr[b] + fr[c] + fr[e]) * 0.25;
      d[o + 3] = Math.max(Math.max(tr[a], tr[b]), Math.max(tr[c], tr[e]));
    }
  }
  this.flowTex.needsUpdate = true;
}
```

Noter le `max` sur la traînée d'écume : une moyenne effacerait les filaments
fins, qui sont précisément ce qu'on veut voir.

### 3.4 Le GLSL complet

À insérer dans `WaterRenderer.js`. Ce bloc remplace l'appel à `detailNormal()`
et sert aussi à l'écume et aux caustiques.

```glsl
uniform sampler2D uFlow;
uniform float uFlowCycle;
uniform float uFlowTile;
uniform float uFlowDistort;
uniform float uFlowMax;

/* ------------------------------------------------------------------------
   FLOW MAP — double defilement croise.

   Deux copies du meme motif, dephasees d'un demi-cycle, melangees par une
   onde triangulaire qui s'annule exactement quand une copie se reinitialise.
   Aucune copie ne porte plus d'un demi-cycle de distorsion : la texture est
   transportee par le courant sans jamais s'etirer a l'infini.

   Reference : Neyret, "Advected Textures", SCA 2003 (le principe) ;
               Vlachos, "Water Flow in Portal 2", SIGGRAPH 2010 (la version
               a deux couches utilisee ici).
   ------------------------------------------------------------------------ */

/** Deplacement de texture (en UV du motif) pour une vitesse donnee. */
vec2 flowOffset(vec2 flow) {
  vec2 d = flow * uFlowCycle * uFlowTile * uFlowDistort;
  float m = length(d);
  // Saturation : au-dela, on "nage". Le surplus de vitesse est porte par
  // l'etirement (§3.5) et les trainees d'ecume (§3.6), pas par le defilement.
  if (m > uFlowMax) d *= uFlowMax / m;
  return d;
}

/** Les deux phases et le poids du fondu, avec dephasage spatial anti-battement. */
void flowPhases(vec2 p, out float p0, out float p1, out float w) {
  // Le decalage doit etre BASSE FREQUENCE et STATIQUE : haute frequence, il
  // reintroduit du bruit a chaque cycle ; anime, il fait vibrer le fondu.
  float off = vnoise2(p * 0.31);
  float t = uTime / uFlowCycle + off;
  p0 = fract(t);
  p1 = fract(t + 0.5);
  w  = abs(2.0 * p0 - 1.0);
}

/**
 * Normale de detail ADVECTEE.
 *
 * On evalue detailNormal() deux fois, sur deux jeux d'UV decales, et on
 * melange. C'est deux fois le cout ; on retire donc une octave a la version
 * advectee et on garde une octave fine STATIQUE par-dessus (le grain le plus
 * fin de l'eau ne se lit de toute facon pas comme un mouvement d'ensemble).
 */
vec3 flowNormal(vec2 p, vec2 flow, float amp, float lod) {
  float p0, p1, w;
  flowPhases(p, p0, p1, w);
  vec2 d = flowOffset(flow) / max(uFlowTile, 1e-3);   // retour en metres

  vec3 n0 = detailNormal(p - d * p0, amp, lod);
  vec3 n1 = detailNormal(p - d * p1, amp, lod);
  return normalize(mix(n0, n1, w));
}

/** Meme mecanique, pour un scalaire (ecume, caustiques). */
float flowScalar(vec2 p, vec2 flow, float freq) {
  float p0, p1, w;
  flowPhases(p, p0, p1, w);
  vec2 d = flowOffset(flow) / max(uFlowTile, 1e-3);
  float a = vnoise2((p - d * p0) * freq);
  float b = vnoise2((p - d * p1) * freq);
  return mix(a, b, w);
}
```

Et le câblage dans `main()` du fragment shader, en remplacement du bloc
`detailNormal` existant :

```glsl
  vec4 fl = texture2D(uFlow, vFieldUv);
  vec2 flow = fl.rg;
  float froude = fl.b;
  float trail  = fl.a;
  float speed  = length(flow);

  // Le detail advecte remplace le defilement a directions fixes.
  vec3 dn = flowNormal(vWorldPos.xz, flow, (3.2 + 5.0 * uChop) * open, lod);
  vec3 N = normalize(vec3(vSurfNormal.x + dn.x, vSurfNormal.y, vSurfNormal.z + dn.z));
```

L'écume et les caustiques reprennent le même flux : la dentelle d'écume doit
**couler avec l'eau**, et les caustiques doivent **dériver** avec elle (l'œil
lit très bien la dérive des taches lumineuses au fond — c'est même un des
indices de vitesse les plus efficaces, et il est gratuit ici).

```glsl
  // Ecume : la dentelle est ADVECTEE, plus une composante de trainee.
  float lace  = flowScalar(vWorldPos.xz, flow, 34.0);
  float lace2 = flowScalar(vWorldPos.xz, flow, 13.0);
  float foamMask = max(vFoam * (0.55 + 1.9 * edge), trail);
  float foam = smoothstep(0.22, 0.68, foamMask * (0.55 + 0.75 * lace) * (0.7 + 0.6 * lace2));

  // Caustiques : elles DERIVENT avec le courant (cf. RECHERCHE-OCEAN §5.4).
  vec2 cp = vWorldPos.xz - flow * uTime * 0.35;
  float c1 = vnoise2(cp * 11.0 + vec2(uTime * 0.35, uTime * 0.22));
```

### 3.5 Étirement anisotrope le long des lignes de courant

Une eau qui coule vite n'a pas des structures rondes : elle a des structures
**allongées dans le sens du courant**, parce que le cisaillement les a étirées.
Le reproduire coûte quatre lignes et double la lisibilité.

On construit un repère local `(t, n)` avec `t = flow/|flow|`, et on comprime la
coordonnée le long de `t` avant d'échantillonner le bruit :

```glsl
/** Repere local etire : les structures s'allongent dans le sens du courant. */
vec2 streamWarp(vec2 p, vec2 flow) {
  float s = length(flow);
  if (s < 1e-4) return p;
  vec2 T = flow / s;
  vec2 Nn = vec2(-T.y, T.x);
  // Facteur d'etirement : 1 (rond) a ~4 (tres allonge) selon la vitesse.
  float k = 1.0 + clamp(s * 2.4, 0.0, 3.0);
  return T * (dot(p, T) / k) + Nn * dot(p, Nn);
}
```

et on l'applique **avant** `detailNormal` et `flowScalar` :

```glsl
vec3 n0 = detailNormal(streamWarp(p - d * p0, flow), amp, lod);
```

Attention à un piège : `streamWarp` dépend de `flow`, qui varie spatialement.
Si le facteur `k` change vite, on introduit une distorsion supplémentaire non
advectée. Comme `flow` est déjà lissé sur 3×3 et en demi-résolution, ça passe ;
si des artefacts apparaissent aux discontinuités, il suffit de plafonner
`k ≤ 2,5` et d'appliquer un `smoothstep` sur la vitesse.

### 3.6 Traînées d'écume advectées

C'est le marqueur de vitesse le plus lisible qui existe — celui que le cerveau
utilise réellement pour lire un courant dans la nature. Le principe :

- une **source** localisée : au pied d'un obstacle, dans un remous, à l'impact
  d'une chute, sur la crête d'un ressaut ;
- une **advection** par le champ de vitesse : la traînée s'étire vers l'aval,
  toute seule ;
- une **dissipation** exponentielle : la traînée a une longueur finie,
  `L ≈ v · τ`. Avec `τ = 3 s` et `v = 0,5 m/s`, la traînée fait 1,5 m — la
  moitié du diorama. Parfait.

Implémentation : c'est exactement la machinerie de `advectSediment()`, avec un
terme source. À ajouter dans `Water.js` :

```js
/**
 * ECUME ADVECTEE.
 *
 * foam[] est LOCALE : elle dit "il y a de la turbulence ICI, maintenant".
 * trail[] est TRANSPORTEE : elle dit "de l'eau turbulente est passee par ici
 * et se dirige par la". C'est la seconde qui rend l'ecoulement lisible, parce
 * que l'oeil lit un TRAIT, pas un point.
 *
 * Longueur d'une trainee ~ v * TRAIL_TAU. A 0.5 m/s et 3 s, 1.5 m : la moitie
 * du diorama, ce qui est exactement l'echelle voulue.
 */
advectTrail(dt) {
  const tr = this.trail, tmp = this.trailTmp;
  const vx = this.vx, vz = this.vz, h = this.h;
  const foam = this.foam, fr = this.froude;
  const decay = Math.exp(-dt / 3.0);

  for (let z = 1; z < NZ - 1; z++) {
    const row = NX * z;
    const xa = Math.max(1, this.scanA[z]), xb = Math.min(NX - 2, this.scanB[z]);
    for (let x = xa; x <= xb; x++) {
      const c = row + x;
      if (h[c] < WATER_EPSILON) { tmp[c] = 0; continue; }
      // Retro-trace semi-lagrangienne.
      const px = clamp(x - (vx[c] * dt) / VOXEL, 0, NX - 1.001);
      const pz = clamp(z - (vz[c] * dt) / VOXEL, 0, NZ - 1.001);
      const x0 = px | 0, z0 = pz | 0;
      const tx = px - x0, tz = pz - z0;
      const a = tr[x0 + NX * z0], b = tr[x0 + 1 + NX * z0];
      const cc = tr[x0 + NX * (z0 + 1)], d = tr[x0 + 1 + NX * (z0 + 1)];
      let v = ((a * (1 - tx) + b * tx) * (1 - tz)
             + (cc * (1 - tx) + d * tx) * tz) * decay;
      // SOURCE : la turbulence locale alimente la trainee.
      const gen = foam[c] * 0.9 + smoothstep(0.9, 1.6, fr[c]) * 0.7;
      if (gen > v) v = v + (gen - v) * Math.min(1, dt * 8);
      tmp[c] = v > 1 ? 1 : v;
    }
  }
  // Copie globale APRES la boucle : sinon biais directionnel en Z
  // (la retro-trace lirait des lignes deja ecrasees). Meme correctif a
  // apporter a advectSediment().
  for (let z = 1; z < NZ - 1; z++) {
    const row = NX * z;
    const xa = Math.max(1, this.scanA[z]), xb = Math.min(NX - 2, this.scanB[z]);
    for (let x = xa; x <= xb; x++) tr[row + x] = tmp[row + x];
  }
}
```

**Le sillage derrière un obstacle.** Il faut une source spécifique, sinon rien
ne se passe autour d'un rocher : la vitesse y est *faible*, pas forte. Le bon
détecteur est la **divergence négative en amont** et la **zone de recirculation
en aval**. Version pragmatique et robuste :

```js
// dans la boucle de advectTrail, apres le calcul de gen :
// Sillage : cellule mouillee dont un voisin AMONT est un obstacle emerge.
const ux = vx[c] > 0 ? -1 : vx[c] < 0 ? 1 : 0;
const uz = vz[c] > 0 ? -NX : vz[c] < 0 ? NX : 0;
const up = c + ux + uz;
if (h[up] < WATER_EPSILON && surf[up] > surf[c] + VOXEL) {
  // On est juste derriere un obstacle : injection franche.
  gen = Math.max(gen, 0.85 * smoothstep(0.05, 0.35, Math.hypot(vx[c], vz[c])));
}
```

L'advection fait ensuite tout le travail : la tache injectée derrière le rocher
s'étire vers l'aval et dessine un sillage. C'est spectaculaire pour trois lignes
de code, et ça donne exactement l'indice « il y a un courant, et il va par là ».

### 3.7 Rides transversales et ondes stationnaires

Deux phénomènes distincts, souvent confondus, et tous deux très lisibles.

**(a) Ondes stationnaires en aval d'un obstacle.** Dans un courant de vitesse v,
une perturbation ponctuelle crée en aval un train d'ondes **immobile dans le
repère du sol** — l'onde qui remonte à la célérité c = √(gh) et le courant qui
la descend à v s'annulent. Pour une onde de gravité en eau profonde la longueur
d'onde d'équilibre est

```
λ = 2π v² / g
```

| v (m/s) | λ (m) | en cellules |
|---|---|---|
| 0,3 | 0,058 | 1,4 |
| 0,5 | 0,160 | 4,0 |
| 0,8 | 0,410 | 10 |
| 1,2 | 0,922 | 23 |

À 0,5–0,8 m/s (le régime typique d'un ruisseau creusé par le joueur) on obtient
des rides de 16 à 41 cm : parfaitement visibles sur un diorama de 10 m. Et
comme λ dépend de v², la **longueur d'onde elle-même code la vitesse** — c'est
le plus beau des indices « compréhensifs », parce qu'il est *quantitatif*.

Le rendu : une contribution à la normale, dont la **phase est verrouillée dans
l'espace** (une onde stationnaire ne défile pas !), et l'amplitude est gouvernée
par le Froude.

```glsl
/**
 * Ondes stationnaires. La phase suit la DISTANCE PARCOURUE LE LONG DU
 * COURANT, pas le temps : une onde stationnaire est immobile.
 * lambda = 2 pi v^2 / g   ->   la longueur d'onde DIT la vitesse.
 */
vec3 standingWaves(vec2 p, vec2 flow, float froude, float depth) {
  float s = length(flow);
  if (s < 0.25) return vec3(0.0, 1.0, 0.0);
  float lambda = 6.2832 * s * s / 9.81;
  float k = 6.2832 / max(lambda, 0.05);
  vec2 T = flow / s;
  // Coordonnee le long du courant. Un tres leger glissement (0.15 * s) evite
  // l'aspect "decalcomanie" sans casser le caractere stationnaire.
  float phi = dot(p, T) * k - uTime * 0.15 * s * k;
  // Amplitude : nulle en fluvial calme, maximale au passage du critique.
  float amp = smoothstep(0.55, 1.05, froude) * smoothstep(0.006, 0.03, depth);
  amp *= 1.0 - smoothstep(1.8, 3.0, froude);   // en tres torrentiel c'est blanc
  float g = cos(phi) * amp * 0.9;
  return normalize(vec3(-T.x * g, 1.0, -T.y * g));
}
```

à composer avec la normale :

```glsl
vec3 sw = standingWaves(vWorldPos.xz, flow, froude, d);
N = normalize(vec3(N.x + sw.x, N.y, N.z + sw.z));
```

**(b) Ressaut hydraulique.** Là où un écoulement torrentiel (Fr > 1) rencontre un
écoulement fluvial (Fr < 1), il y a un **choc** : la profondeur saute
brutalement, selon la relation des profondeurs conjuguées de Bélanger,

```
h₂/h₁ = ½ ( √(1 + 8 Fr₁²) − 1 )
```

| Fr₁ | h₂/h₁ | aspect |
|---|---|---|
| 1,2 | 1,28 | ride ondulée (« ressaut ondulé ») |
| 1,5 | 1,66 | ride marquée, un peu d'écume |
| 2,5 | 3,07 | rouleau blanc franc |
| 4,0 | 5,15 | ressaut violent, très écumant |

À notre échelle le ressaut est *le* phénomène qui dit « ça coule vite ici et ça
freine là » d'un seul coup d'œil. Il n'est pas nécessaire de le simuler : il
suffit de le **détecter** et de le peindre (§4.3). Un vrai schéma conservatif
(§6) le produirait spontanément — c'est un des arguments pour y aller.

**(c) Rides de courant peu profond.** Quand une lame très mince (< 1 cm) file
vite, on voit des rides transversales serrées, presque stationnaires, qui sont
en réalité des ondes de roulement (*roll waves*, instabilité de Vedernikov au-delà
de Fr ≈ 2). Rendu : la même fonction que (a), avec λ plus courte et un léger
défilement vers l'aval. Un `if (depth < 0.012 && froude > 1.6)` suffit à les
déclencher.

### 3.8 Doser : la règle des trois indices

Le risque de tout ce chapitre est évident : un tapis d'effets qui hurle.
La règle qui marche :

> **À tout instant et en tout point, au plus trois indices simultanés, et un
> seul dominant.**

En pratique, une hiérarchie par régime, avec une transition douce sur le
Froude :

| Régime | Fr | Indice dominant | Secondaires | À couper |
|---|---|---|---|---|
| Eau morte (flaque, douve) | < 0,1 | rien | reflet, une caustique lente | flow map, traînées, rides |
| Fluvial lent (nappe qui s'étale) | 0,1–0,5 | flow map advectée | dérive des caustiques | rides, écume |
| Fluvial rapide (ruisseau) | 0,5–0,9 | **traînées d'écume** | flow map, étirement | rides, blanc |
| Critique (seuil, sortie de vasque) | 0,9–1,3 | **ondes stationnaires** | traînées | — |
| Torrentiel (rapide, lame sur pente) | > 1,3 | **eau blanche** | rides serrées | flow map (noyée dans le blanc) |

Trois garde-fous concrets :

1. **Seuil d'activation sur la profondeur.** Aucun effet de courant en dessous de
   6 mm : le film mince est déjà noyé par les caustiques et le sable. Tout est
   multiplié par `smoothstep(0.006, 0.020, depth)`.
2. **Seuil d'activation sur la vitesse**, avec hystérésis douce :
   `smoothstep(0.06, 0.22, speed)`. Une eau qui bouge à 3 cm/s ne doit **rien**
   montrer, sinon les douves immobiles frémissent en permanence.
3. **Le réglage joueur `uFlowDistort`**, exposé (§7), qui multiplie *tous* les
   indices de courant d'un coup. Valeur par défaut 1,0 ; un mode « lecture »
   à 1,6 pour la construction ; 0,4 pour la contemplation.

Et une règle négative, apprise à la dure sur ce type de rendu : **ne jamais
faire varier la couleur de l'eau avec la vitesse.** La couleur code la
profondeur (Beer-Lambert, cf. `RECHERCHE-OCEAN` §4) ; si elle code aussi la
vitesse, le joueur ne peut plus lire ni l'une ni l'autre. La vitesse se dit par
la **texture** et le **mouvement**, jamais par la teinte.

---

## 4. Eau blanche

### 4.1 Les critères physiques d'apparition

L'eau blanche, c'est de l'**air entraîné**. Elle apparaît partout où la surface
libre est brisée assez violemment pour engouffrer des bulles, et disparaît par
remontée de ces bulles. Le critère actuel (`foam = speed × 0,55`) est faux dans
les deux sens ; voici les quatre vrais générateurs, dans l'ordre d'importance
pour ce jeu.

**① Impact d'une chute.** Le plus fort de loin, et déjà branché (§2.5). La
puissance dissipée au plongeon vaut

```
P = ρ g Q H          [W]        (Q = débit, H = hauteur de chute)
```

Une cascade de 40 cm à 2,9 L/s dissipe 11 W. C'est l'équivalent d'un petit
mixeur : la vasque doit être **franchement blanche**.

**② Écoulement torrentiel — Fr > 1.** Au-delà du critique, l'écoulement ne peut
plus « prévenir » l'aval, et sa surface se déstabilise. En pratique on observe
l'entraînement d'air dès Fr ≈ 1,3, et une aération complète (*white water*) vers
Fr ≈ 2,5.

```
generation_Fr = smoothstep(1.15, 2.4, Fr)
```

**③ Ressaut hydraulique.** Le plus spectaculaire, et le plus caractéristique
d'un cours d'eau. Détection sur deux cellules le long de la ligne de courant :

```
Fr(amont) > 1,1   ET   Fr(aval) < 0,9   ET   ∂h/∂s > 0
```

Le rouleau du ressaut a une longueur de l'ordre de `L ≈ 6 (h₂ − h₁)`, ce qui
permet de l'étaler correctement en aval au lieu de peindre une seule cellule.

**④ Air piégé par la convergence / le cisaillement.** C'est le critère de
Ihmsen et al. (*Unified Spray, Foam and Air Bubbles for Particle-Based Fluids*,
The Visual Computer 2012), qu'ils écrivent comme une somme sur les voisins
`Σ ‖v_i − v_j‖ (1 − v̂_ij · x̂_ij)` — une mesure de la vitesse d'approche
relative. Sur une grille, c'est la **divergence négative** :

```
div = ∂v_x/∂x + ∂v_z/∂z
generation_conv = max(0, −div) · h
```

Deux nappes qui se rencontrent (deux ruisseaux qui confluent, le retour d'une
vague) ont div < 0 et blanchissent. Une nappe qui s'étale a div > 0 et reste
claire. C'est exactement le bon comportement, et ça ne coûte que quatre
différences finies.

**⑤ Le cisaillement / les remous.** Le rotationnel `curl = ∂v_z/∂x − ∂v_x/∂z`
capture les tourbillons derrière un obstacle. Contribution mineure mais elle
donne le petit tourbillon écumeux d'aval qui rend un rocher vivant.

**Et un critère négatif, essentiel :** l'eau blanche ne doit **jamais** être
générée par la faible profondeur seule. C'est déjà noté dans le shader actuel
(« sinon toutes les douves immobiles se bordent de blanc »), et c'est juste. La
ligne d'eau qui blanchit, c'est le ressac (une vitesse d'approche réelle), pas
la profondeur.

### 4.2 Les trois échelles

Il faut trois représentations distinctes, sinon l'eau blanche a toujours l'air
d'un décalque. C'est la classification standard de la production (Houdini,
Ihmsen et al.) et elle se transpose telle quelle.

| Échelle | Nature | Support | Durée de vie | Ce qu'elle fait |
|---|---|---|---|---|
| **Mousse** (*foam*) | Radeau de bulles **à la surface** | champ 2D `trail` + `foam`, rendu en texture | τ ≈ 3–8 s | Les traînées, les tourbillons de surface, le collier au bord des vasques. **C'est ce qui rend le courant lisible.** |
| **Bulles** (*bubbles*) | Air entraîné **dans le volume** | champ 2D `bubbles`, rendu par modification de l'absorption | τ ≈ 1–3 s | Le blanchiment laiteux **sous** la surface, le nuage qui remonte au pied d'une chute. C'est ce qui donne du **volume** au blanc. |
| **Embrun** (*spray*) | Gouttelettes **en l'air** | particules (§2.8) | τ ≈ 0,8–2,4 s | Le halo, la profondeur, l'échelle. Ne représente presque pas de volume. |

La faute classique est de n'en faire qu'une (aujourd'hui : seulement la mousse,
en aplat). Résultat : une tache blanche opaque et plate, qui a l'air d'être
peinte sur l'eau plutôt que d'en faire partie.

**Les bulles, dans le shader.** C'est le moins évident et le plus payant. De
l'eau chargée de bulles ne devient pas « plus blanche » : elle devient
**diffusante**, donc son absorption s'effondre et sa réflectance de volume monte.
Concrètement, on interpole les coefficients de Beer-Lambert (cf.
`RECHERCHE-OCEAN` §4.2) vers un milieu très diffusant :

```glsl
  // uFlow.a porte l'ecume advectee ; on ajoute un canal bulles.
  float bub = fl2.r;                                // densite d'air entraine 0..1
  // 1. l'absorption s'effondre (le trajet optique se raccourcit).
  vec3 SIG = mix(SIGMA, SIGMA * 0.25, bub);
  // 2. la couleur de volume tire vers un blanc legerement bleute.
  vec3 milk = vec3(0.82, 0.90, 0.94);
  col = mix(col, milk, bub * 0.75 * smoothstep(0.004, 0.05, d));
  // 3. l'eau devient OPAQUE : on ne voit plus le fond a travers un rouleau.
  alpha = mix(alpha, 1.0, bub * 0.85);
  // 4. et elle diffuse la lumiere du soleil de facon lambertienne.
  col += uSunColor * bub * 0.22 * max(uSunDir.y, 0.0);
```

Ce bloc, à lui seul, transforme une vasque de cascade : au lieu d'une tache
blanche en surface, on obtient un **nuage** qui a une épaisseur, qui masque le
fond, et qui s'éclaircit vers le haut.

### 4.3 Le code du générateur

À ajouter dans `Water.js`, appelé depuis `step()` juste après `integrate()` (et
donc avant `cascade.step()`, qui viendra y ajouter ses impacts).

```js
/**
 * EAU BLANCHE — generation.
 *
 * L'eau blanche est de l'AIR ENTRAINE. Elle ne depend pas de la vitesse (une
 * nappe rapide et lisse est transparente) mais de la violence avec laquelle la
 * surface est brisee. Quatre generateurs, par ordre d'importance :
 *
 *   1. l'impact d'une chute        -> injecte par Cascade.land()
 *   2. l'ecoulement torrentiel     -> Froude > 1.15
 *   3. le ressaut hydraulique      -> transition torrentiel -> fluvial
 *   4. la convergence (div < 0)    -> deux nappes qui se rencontrent
 *
 * Et un generateur INTERDIT : la faible profondeur. Sinon toute douve
 * immobile se borde de blanc, ce qui est faux et tres laid.
 */
whitewater(dt) {
  const h = this.h, vx = this.vx, vz = this.vz;
  const foam = this.foam, bub = this.bubbles, fr = this.froude;
  const inv2h = 0.5 / VOXEL;

  // Dissipation : la mousse tient (radeau en surface), les bulles remontent
  // vite. Les deux constantes doivent etre TRES differentes : c'est ce qui
  // fait qu'une vasque garde un collier d'ecume apres que le blanc de volume
  // a disparu.
  const kFoam = Math.exp(-dt / 5.0);
  const kBub  = Math.exp(-dt / 1.6);

  for (let z = 1; z < NZ - 1; z++) {
    const row = NX * z;
    const xa = Math.max(1, this.scanA[z]), xb = Math.min(NX - 2, this.scanB[z]);
    for (let x = xa; x <= xb; x++) {
      const c = row + x;
      const hw = h[c];
      if (hw < WATER_EPSILON) { foam[c] *= kFoam; bub[c] *= kBub; continue; }

      const sp = Math.hypot(vx[c], vz[c]);
      const F  = fr[c];

      // --- 2. torrentiel ---------------------------------------------------
      let gen = smoothstep(1.15, 2.4, F) * 0.9;

      // --- 4. convergence (air piege) --------------------------------------
      const div = (vx[c + 1] - vx[c - 1] + vz[c + NX] - vz[c - NX]) * inv2h;
      if (div < 0) gen += Math.min(0.9, -div * 0.10) * smoothstep(0.1, 0.5, sp);

      // --- 5. cisaillement -------------------------------------------------
      const curl = (vz[c + 1] - vz[c - 1] - vx[c + NX] + vx[c - NX]) * inv2h;
      gen += Math.min(0.35, Math.abs(curl) * 0.045);

      // --- 3. ressaut hydraulique ------------------------------------------
      // On remonte d'une cellule CONTRE le courant : si l'amont est
      // torrentiel et qu'ici c'est fluvial, il y a un choc.
      if (F < 0.9 && sp > 0.12) {
        const ux = vx[c] > 0 ? -1 : vx[c] < 0 ? 1 : 0;
        const uz = vz[c] > 0 ? -NX : vz[c] < 0 ? NX : 0;
        const up = c + ux + uz;
        const Fu = fr[up];
        if (Fu > 1.1 && h[up] < hw) {
          // Profondeurs conjuguees de Belanger : h2/h1 = 0.5*(sqrt(1+8Fr^2)-1)
          const ratio = 0.5 * (Math.sqrt(1 + 8 * Fu * Fu) - 1);
          // Plus le saut est fort, plus le rouleau est blanc.
          gen += clamp((ratio - 1) * 0.55, 0, 1.2);
        }
      }

      // --- garde-fous ------------------------------------------------------
      // Rien en film mince : la ligne d'eau ne doit pas se border de blanc
      // toute seule.
      gen *= smoothstep(0.004, 0.016, hw);
      if (gen <= 0) { foam[c] *= kFoam; bub[c] *= kBub; continue; }

      // Montee rapide, descente lente : l'eau blanchit en un instant et met
      // plusieurs secondes a redevenir claire.
      const rise = Math.min(1, dt * 9);
      const nf = foam[c] * kFoam;
      foam[c] = gen > nf ? nf + (Math.min(1, gen) - nf) * rise : nf;
      const nb = bub[c] * kBub;
      // Les bulles ne se forment que s'il y a de la HAUTEUR pour les loger.
      const genB = Math.min(1, gen * smoothstep(0.01, 0.08, hw));
      bub[c] = genB > nb ? nb + (genB - nb) * rise : nb;
    }
  }
}
```

**Coût** : ~18 opérations par cellule mouillée, sur ~20 000 cellules → ≈ 0,15 ms.
Négligeable.

### 4.4 Persistance et dissipation

Trois constantes de temps, et elles doivent être franchement séparées :

| Champ | τ | Justification |
|---|---|---|
| `bubbles` | **1,6 s** | Une bulle de 1 mm remonte à ~0,1 m/s (Stokes + inertie) : dans 10 cm d'eau, 1 s. |
| `foam` | **5 s** | Un radeau de mousse en surface est stable ; il se défait par coalescence et drainage, pas par flottabilité. |
| `trail` | **3 s** | Compromis : assez long pour faire une traînée d'1,5 m à 0,5 m/s, assez court pour que le motif ne « peigne » pas tout le domaine. |

Trois raffinements qui valent leur coût :

**(a) Asymétrie montée/descente.** Codée ci-dessus : `rise = dt·9` (≈ 0,11 s de
constante de montée) contre plusieurs secondes de descente. Sans ça, l'écume
« respire » au rythme des fluctuations du solveur, ce qui est le défaut le plus
visible d'une écume mal réglée.

**(b) L'écume résiduelle qui sèche.** Quand une cellule se découvre (marée
descendante, vasque qui se vide), la mousse ne disparaît pas : elle reste
collée au sable et sèche lentement. C'est déjà traité dans
`RECHERCHE-OCEAN.md` §9.1 (écume résiduelle) — il suffit de brancher `trail`
dessus au lieu de `foam` pour que les traînées laissent une **trace** sur le
sable. Détail magnifique et quasi gratuit : le joueur voit **où l'eau est
passée**, même après qu'elle s'est retirée.

**(c) La mousse s'accumule aux contre-courants.** L'advection semi-lagrangienne
de `trail` fait ça toute seule : là où la vitesse converge, la valeur advectée
s'accumule au-delà de 1. Il ne faut donc **pas** clamper à 1 pendant
l'advection, mais seulement à l'export vers le GPU — sinon on perd les
accumulations, et les accumulations sont exactement les colliers d'écume qui
tournent dans les remous.

```js
// dans advectTrail : conserver jusqu'a 2.5, clamper seulement a l'export.
tmp[c] = v > 2.5 ? 2.5 : v;
// dans updateFlowTexture : d[o+3] = Math.min(1, max des quatre);
```

---

## 5. Rivières

### 5.1 Le bilan qui décide si une rivière vit ou meurt

Avant toute mécanique, le bilan. Une rivière existe si

```
Q_source  >  Q_infiltration + Q_évaporation + Q_stockage
```

**Infiltration.** Le code actuel prélève `rate = 4.0e-5 × 35 × dt`, soit
**1,4 mm/s** de lame d'eau, sur chaque cellule mouillée. Pour un chenal de
10 cm de large et 5 m de long (0,5 m² de lit) :

```
Q_inf = 1,4e-3 × 0,5 = 7,0e-4 m³/s = 0,70 L/s
```

À comparer au débit visuellement satisfaisant d'un ruisseau de 10 cm de large,
2 cm de profondeur, 0,4 m/s :

```
Q = 0,10 × 0,02 × 0,4 = 8,0e-4 m³/s = 0,80 L/s
```

**Les deux sont du même ordre.** Sans correctif, la moitié du débit disparaît
dans le sable. Mais — et c'est le point que le code fait déjà bien —
l'infiltration est plafonnée par la place disponible (`room = (1−w)·POROSITY·VOXEL`).
Un voxel de 4 cm à 38 % de porosité peut absorber au maximum
`0,38 × 0,04 = 15,2 mm` de lame d'eau. Une fois le lit saturé, l'infiltration
**tombe à zéro**.

Conséquence concrète, et c'est un excellent moment de jeu :

> **Le sable boit d'abord.** Il faut environ `15,2 / 1,4 ≈ 11 secondes` de
> ruissellement pour saturer le lit sous la lame. Pendant ces onze secondes, le
> ruisseau avance péniblement, s'arrête, repart. Puis le lit s'amorce et l'eau
> file d'un coup jusqu'à la mer.

C'est un phénomène **réel** (l'amorçage d'un chenal en sable sec) et c'est une
excellente tension de jeu. Il faut donc le **garder** et le **signaler** : une
teinte plus sombre du sable saturé sous la lame le fait déjà (`Moisture` +
`SandMaterial`), et un petit indicateur HUD (« lit amorcé : 62 % ») le rendrait
lisible.

En revanche, deux ajustements sont nécessaires :

1. **L'infiltration doit dépendre du tassement.** Du sable damé est beaucoup
   moins perméable. `rate *= (1 − 0.7 · packing)`. Le joueur peut alors
   **tasser le lit de sa rivière à la pelle** pour l'étanchéifier — un geste de
   construction naturel, qui existe vraiment chez les enfants sur la plage, et
   qui donne une prise directe sur le système.
2. **La ré-émergence à l'aval.** L'eau infiltrée ne disparaît pas du monde : elle
   rejoint la nappe. Si une rivière traverse une zone où le terrain descend sous
   la nappe locale, le suintement de `applyBoundaries()` la fait ressortir. Ça
   marche déjà. Il faut juste ne pas le casser.

**Stockage.** Remplir une vasque de 30 cm de diamètre et 10 cm de profondeur
demande 7 L, soit 9 secondes du débit ci-dessus. Cohérent avec le rythme du jeu.

**Évaporation.** `EVAPORATION_BASE = 1.7e-7 m/s`, quatre ordres de grandeur sous
l'infiltration. Négligeable pour une rivière. Elle compte seulement pour la
disparition lente d'une flaque.

### 5.2 Les sources

Trois mécanismes, complémentaires. Il faut les trois.

**(a) La source posable — le mécanisme principal.** Un objet persistant que le
joueur place, avec un débit réglable.

```js
/**
 * SOURCES PERMANENTES.
 *
 * Sans elles, il n'y a pas de riviere : pour() est un evenement, et un
 * ecoulement a besoin d'un DEBIT ENTRETENU. Une source est un point du monde
 * qui injecte Q m3/s indefiniment.
 *
 * Calibrage (voir §5.1) :
 *   0.2 L/s  filet      : mouille le sable, ne va pas loin sur sable sec
 *   0.8 L/s  ruisseau   : chenal de ~10 cm, lame de 2 cm, 0.4 m/s
 *   2.5 L/s  torrent    : chenal de ~25 cm, creuse vite, fait des cascades
 *   8.0 L/s  vanne      : vide un reservoir, submerge tout en aval
 */
addSpring(wx, wz, rate = 8e-4, radius = 0.06) {
  const s = { x: wx, z: wz, rate, radius, on: true, id: this._springId++ };
  this.springs.push(s);
  return s;
}

removeSpringNear(wx, wz, r = 0.15) {
  for (let i = this.springs.length - 1; i >= 0; i--) {
    const s = this.springs[i];
    if (Math.hypot(s.x - wx, s.z - wz) < r) { this.springs.splice(i, 1); return true; }
  }
  return false;
}

/** Appele en tete de step(), avant applyBoundaries. */
runSprings(dt) {
  for (let i = 0; i < this.springs.length; i++) {
    const s = this.springs[i];
    if (!s.on) continue;
    this.pour(s.x, s.z, s.radius, s.rate * dt);
    this.budget.in += s.rate * dt;
    // Presence visuelle : une source qui ne bouillonne pas est invisible, et
    // le joueur ne retrouve plus ou il les a posees.
    const cx = clamp(Math.round((s.x - ORIGIN_X) / VOXEL - 0.5), 0, NX - 1);
    const cz = clamp(Math.round((s.z - ORIGIN_Z) / VOXEL - 0.5), 0, NZ - 1);
    const c = cx + NX * cz;
    if (this.foam[c] < 0.5) this.foam[c] = 0.5;
    if (this.bubbles[c] < 0.35) this.bubbles[c] = 0.35;
  }
}
```

**(b) Le canal depuis la mer.** Ça marche **déjà**, et c'est le mécanisme le plus
riche parce qu'il est couplé à la marée. Ce qui manque, c'est un peu de charge :
l'eau qui entre par un canal creusé au niveau de la mer a une pente motrice
nulle, donc elle avance très lentement. Deux observations :

- **La marée fournit la charge.** À mi-flot, la mer monte de ~0,46 m en 3 min,
  soit 2,5 mm/s de dénivelé — un canal creusé se remplit alors avec une charge
  réelle. C'est déjà là ; il faut juste que le joueur le comprenne, d'où
  l'importance du mode « voir l'écoulement » (§7).
- **Le ressac comme pompe.** `this.swash` est ajouté au niveau imposé au large.
  Chaque vague pousse une petite quantité d'eau dans le canal, qui ne peut pas
  toute repartir (l'écoulement de retour est plus lent : c'est l'asymétrie déjà
  codée en `Math.pow(|raw|, 0.7)`). Un canal se remplit donc **par pompage** —
  phénomène réel et très satisfaisant. Rien à écrire.

**(c) La pluie.** Le générateur d'écoulement le plus pédagogique qui soit :
elle mouille tout le terrain uniformément et laisse le relief décider où l'eau
va. C'est la démo canonique de l'érosion hydraulique, et elle rend le réseau de
drainage visible d'un coup.

```js
/** Pluie uniforme. intensity en mm/h. 5 mm/h = averse legere. */
rain(dt, intensityMmH) {
  if (intensityMmH <= 0) return;
  const dh = (intensityMmH / 3600 / 1000) * dt;   // m de lame reelle
  // Facteur de jeu : 5 mm/h de vraie pluie ne se verrait pas en 20 minutes.
  const add = dh * 200;
  const surf = this.field.surfaceH;
  let n = 0;
  for (let c = 0; c < COLS; c++) {
    if (surf[c] > this.seaLevel) { this.h[c] += add; n++; }
  }
  this.budget.in += add * n * A;
}
```

Note d'équilibrage : 5 mm/h × 200 = 1 m/h = 0,28 mm/s, soit un cinquième du
taux d'infiltration. La pluie ne peut donc **pas** créer de ruissellement sur
sable sec — ce qui est physiquement juste (le sable a une conductivité énorme)
mais frustrant en jeu. Il faut soit une averse violente (× 1 000), soit —
mieux — la coupler au tassement : sur du sable damé par le joueur,
l'infiltration chute et le ruissellement apparaît. **Le joueur fabrique alors
son propre bassin versant en tassant le sable.** C'est une mécanique de jeu à
part entière, et elle sort directement de la physique.

### 5.3 Pourquoi `erode()` rabote au lieu de creuser

Quatre causes, toutes corrigibles.

**① La pente utilisée est celle du fond, pas celle de la surface libre.**

```js
const dhx = (surf[c + 1] - surf[c - 1]) * 0.5;    // <-- terrain
```

Or la contrainte de cisaillement au fond vaut `τ = ρ g h S` où **S est la pente
de la ligne d'énergie**, très bien approchée par la pente de la surface libre
`|∇η| = |∇(b+h)|`. La différence est décisive : à mesure qu'un chenal
s'approfondit, le fond s'aplanit (`∇b → 0`) donc **l'incision s'auto-éteint** ;
alors que la surface libre garde la pente de la vallée, donc **l'incision
continue** jusqu'à ce que le débit ou la cohésion l'arrêtent. C'est la
correction la plus importante du chapitre.

**② Le plancher `EROSION_MIN_SLOPE = 0.06`** garantit qu'une capacité non nulle
existe partout où il y a du mouvement, y compris sur un fond parfaitement plat.
Résultat : un rabotage uniforme de toute la surface mouillée. Il faut le
supprimer et le remplacer par le seuil physique — la contrainte critique
d'arrachement, qui existe déjà (`tauCrit`) et fait exactement ce travail.

**③ La loi est linéaire en vitesse** (`cap = Kc · sinα · speed · lw`), donc le
thalweg (là où le débit est concentré) n'érode pas beaucoup plus vite que ses
marges. Sans **non-linéarité**, il n'y a pas de rétroaction positive, et sans
rétroaction positive, il n'y a **pas de chenalisation**. C'est le mécanisme
central de la géomorphologie fluviale : un creux capte plus d'eau → il érode
plus → il se creuse → il capte encore plus d'eau. Il faut `E ∝ q^m` avec
m ≥ 0,5.

**④ `dig()` retire au sommet de la colonne.** Une berge ne peut donc être que
décapitée, jamais sapée. Les chenaux s'élargissent au lieu de s'approfondir.
§5.5.

### 5.4 La loi de puissance de courant

On remplace la loi de capacité par la **loi d'incision par excès de
cisaillement** (Howard & Kerby 1983 ; Whipple & Tucker 1999), qui est le
standard en géomorphologie et se code en dix lignes :

```
q  = h·|v|                    débit unitaire             [m²/s]
S  = |∇(b + h)|               pente de la surface libre  [-]
τ  = ρ_w · g · h · S          cisaillement au fond       [Pa]

E  = K · q^m · S^n · (1 − τ_c/τ)      si τ > τ_c
E  = 0                                 sinon
```

Exposants : `m = 0,8`, `n = 1,0`. (La forme classique du modèle en aire drainée
est `E = K A^m S^n` avec m ≈ 0,5 ; en débit unitaire local, m entre 0,7 et 1
donne la chenalisation la plus nette pour un temps de jeu court.)

Et la **capacité de transport** garde son rôle : elle décide où le sédiment se
redépose.

```
C = K_c · q^{0,9} · S^{0,7}
```

Version complète, en remplacement de `erode()` :

```js
/**
 * EROSION PAR PUISSANCE DE COURANT.
 *
 * Trois changements par rapport a la version precedente, et chacun compte :
 *
 *   1. La pente est celle de la SURFACE LIBRE, pas du fond. Dans un chenal
 *      qui se creuse, la pente du fond tend vers zero (l'incision s'eteint)
 *      alors que la surface garde la pente de la vallee (l'incision
 *      continue). C'est LA raison pour laquelle un lit ne se creusait pas.
 *
 *   2. La loi est NON LINEAIRE en debit : E ~ q^0.8. La non-linearite est le
 *      moteur de la chenalisation — un creux capte plus d'eau, donc erode
 *      plus, donc se creuse, donc capte plus. Avec une loi lineaire il n'y a
 *      aucune retroaction et l'eau rabote uniformement.
 *
 *   3. Le plancher EROSION_MIN_SLOPE disparait. Le seuil est desormais
 *      physique : la contrainte critique d'arrachement, qui depend deja de la
 *      cohesion (humidite x tassement). Un fond plat n'erode plus.
 */
erode(dt) {
  if (!this.erosionEnabled) return;
  const F = this.field;
  const h = this.h, vx = this.vx, vz = this.vz, sed = this.sed;
  const surf = F.surfaceH;
  const inv2h = 0.5 / VOXEL;
  const RHO_W = 1000;
  let total = 0;

  for (let z = 1; z < NZ - 1; z++) {
    const row = NX * z;
    const xa = Math.max(1, this.scanA[z]), xb = Math.min(NX - 2, this.scanB[z]);
    for (let x = xa; x <= xb; x++) {
      const c = row + x;
      const hw = h[c];
      if (hw < WATER_EPSILON) {
        if (sed[c] > 0) { this.deposit(x, z, sed[c]); sed[c] = 0; }
        continue;
      }
      const speed = Math.hypot(vx[c], vz[c]);
      if (speed < 0.02 && sed[c] <= 0) continue;

      // --- pente de la SURFACE LIBRE ---------------------------------------
      const eR = surf[c + 1] + h[c + 1], eL = surf[c - 1] + h[c - 1];
      const eT = surf[c + NX] + h[c + NX], eB = surf[c - NX] + h[c - NX];
      const Sx = (eR - eL) * inv2h, Sz = (eT - eB) * inv2h;
      const S = Math.hypot(Sx, Sz);

      // --- debit unitaire et cisaillement ----------------------------------
      const q = hw * speed;                                    // m2/s
      const tau = RHO_W * GRAVITY * Math.min(hw, 0.3) * S;     // Pa

      // --- resistance : cohesion locale ------------------------------------
      const top = F.topY[c];
      if (top < 0) continue;
      const i = c + SLICE * top;
      const w = F.moisture[i] / 255, p = F.packing[i] / 255;
      const tauCrit = TAU_CRIT_DRY *
        (1 + COHESION_RESIST * cohesionFactor(w) * packFactor(p));

      // --- capacite de transport -------------------------------------------
      const cap = EROSION_CAPACITY * Math.pow(q, 0.9)
                * Math.pow(S + 1e-4, 0.7) * 0.35;

      if (tau > tauCrit && cap > sed[c]) {
        // Loi de puissance de courant : E = K q^m S^n (1 - tauC/tau)
        const E = 0.55 * Math.pow(q, 0.8) * S * (1 - tauCrit / tau);
        // Plafond dur par pas : sans lui, une vague creuse un canyon.
        const amount = Math.min(E * dt,
                                (cap - sed[c]) * EROSION_DISSOLVE * dt * 6,
                                0.006 * dt * 60 * VOXEL);
        if (amount > 1e-6) {
          const got = this.digAt(x, z, surf[c], amount);
          sed[c] += got; total += got;
        }
      } else if (sed[c] > cap) {
        const amount = (sed[c] - cap) * EROSION_DEPOSIT * dt * 6;
        if (amount > 1e-6) { this.deposit(x, z, amount); sed[c] -= amount; }
      }

      // --- SAPE DE BERGE (§5.5) --------------------------------------------
      if (speed > 0.25 && tau > tauCrit) {
        this.undercut(x, z, c, vx[c], vz[c], dt, S);
      }
    }
  }
  this.stats.eroded += total;
}
```

**Vérification numérique.** Ruisseau typique : h = 0,02 m, v = 0,45 m/s,
S = 0,04.

```
q   = 0,009 m²/s
τ   = 1000 × 9,81 × 0,02 × 0,04 = 7,85 Pa
τ_c = 0,168 × (1 + 30 × 0,3) ≈ 1,68 Pa   (sable moyennement humide, peu tassé)
E   = 0,55 × 0,009^0,8 × 0,04 × (1 − 0,214)
    = 0,55 × 0,0224 × 0,04 × 0,786 = 3,87e-4 m/s
```

Soit **0,39 mm/s**, ou 2,3 cm par minute. Un lit de 5 cm se creuse en un peu
plus de deux minutes de ruissellement — le bon rythme pour du jeu (assez lent
pour être observé, assez rapide pour ne pas ennuyer). Et sur du sable bien tassé
et humide, `τ_c` monte à `0,168 × 31 = 5,2 Pa` : `E` chute à 1,6e-4, soit
2,5× plus lent. **Le joueur peut protéger son lit en le tassant.** Excellent.

### 5.5 Sape de berge et `digAt`

Le mécanisme manquant. Une berge s'érode **par la base**, à la hauteur de la
lame d'eau ; le surplomb qui en résulte s'effondre ensuite sous son propre
poids — et `Granular` sait déjà faire ça. Il suffit donc de retirer le sable **à
la bonne altitude**.

```js
/**
 * Retire du sable a une ALTITUDE donnee, pas au sommet de la colonne.
 *
 * dig() decapite ; digAt() sape. C'est toute la difference entre un chenal qui
 * s'elargit en cuvette et un chenal qui se creuse avec des berges franches.
 * Le surplomb cree ici est ensuite effondre par Granular, exactement comme
 * dans la nature.
 *
 * @returns {number} epaisseur reellement retiree (m)
 */
digAt(x, z, yWorld, amount, span = 2) {
  const F = this.field;
  const c = x + NX * z;
  let remaining = Math.round((amount / VOXEL) * 255);
  if (remaining <= 0) return 0;
  let removed = 0;
  const y0 = clamp(Math.round((yWorld - ORIGIN_Y) / VOXEL - 0.5), 0, NY - 1);
  // On attaque du haut de la bande vers le bas : on evite ainsi de creuser
  // une cavite fermee sous une croute.
  for (let dy = span; dy >= -span && remaining > 0; dy--) {
    const y = y0 + dy;
    if (y < 0 || y >= NY) continue;
    const i = c + SLICE * y;
    const d = F.density[i];
    if (d === 0) continue;
    const take = Math.min(d, remaining);
    this.writeDensity(x, y, z, d - take);
    removed += take; remaining -= take;
  }
  if (removed > 0 && this.granular) this.granular.wake(x, y0, z);
  return (removed / 255) * VOXEL;
}

/**
 * SAPE LATERALE.
 *
 * Le courant attaque les berges PERPENDICULAIREMENT a sa direction, a la
 * hauteur de la lame. Sans ce mecanisme, un chenal ne peut ni s'elargir ni se
 * deplacer lateralement, et il ne peut surtout pas MEANDRER.
 */
undercut(x, z, c, ux, uz, dt, S) {
  const F = this.field;
  const sp = Math.hypot(ux, uz);
  if (sp < 1e-4) return;
  const tx = ux / sp, tz = uz / sp;
  // Normale au courant, arrondie a la grille.
  const nx = Math.round(-tz), nz = Math.round(tx);
  if (nx === 0 && nz === 0) return;

  // La courbure decide de quel cote on attaque (§5.6). Sans courbure, on
  // attaque les DEUX berges de facon egale — le chenal s'elargit.
  const kappa = this.curvature(c);
  const bias = clamp(kappa * 0.8, -1, 1);
  const water = F.surfaceH[c] + this.h[c];

  for (let s = -1; s <= 1; s += 2) {
    const ox = x + s * nx, oz = z + s * nz;
    if (ox < 1 || oz < 1 || ox >= NX - 1 || oz >= NZ - 1) continue;
    const n = ox + NX * oz;
    if (F.surfaceH[n] <= water + VOXEL * 0.5) continue;  // pas de berge ici
    // Attaque plus forte sur la berge EXTERIEURE du virage.
    const side = 0.5 + 0.5 * s * Math.sign(bias) * Math.abs(bias);
    const amount = 0.35 * sp * S * dt * side;
    if (amount < 1e-6) continue;
    this.sed[c] += this.digAt(ox, oz, water, amount, 1);
  }
}
```

Effet observé : le chenal cesse de s'élargir symétriquement. Il creuse un lit,
et ses berges deviennent des **parois**, parce que le sable saturé du bas est
enlevé et que le sable humide du haut tient à 78–89° (`REPOSE_CURVE`) jusqu'à ce
que le surplomb devienne trop grand — puis il s'effondre en bloc, ce que
`Granular` fait déjà très bien. C'est le cycle sape/effondrement réel des berges
sableuses.

### 5.6 Méandres : la courbure comme substitut au courant hélicoïdal

Le vrai mécanisme du méandre est tridimensionnel : dans un virage, la force
centrifuge surélève la surface à l'extérieur (`Δz = v²W/(gR)`), ce qui crée un
gradient de pression qui pousse l'eau du fond vers l'**intérieur** — une
circulation secondaire hélicoïdale qui transporte le sédiment de la berge
externe (qui recule) vers le banc interne (qui avance). Un modèle en eaux peu
profondes n'a pas de circulation secondaire (H3).

Substitut fidèle et bon marché : calculer la **courbure de la ligne de courant**
et l'utiliser pour biaiser l'érosion et le dépôt.

```js
/**
 * Courbure de la ligne de courant, en 1/m. Positive = virage a gauche.
 *
 *   kappa = (v x (v.grad)v) / |v|^3
 *
 * Un modele en eaux peu profondes n'a pas de courant helicoidal secondaire :
 * il ne peut donc pas meandrer tout seul. La courbure est le meilleur
 * substitut — elle dit ou est la berge exterieure, celle qui recule, et le
 * banc interieur, celui qui avance.
 */
curvature(c) {
  const vx = this.vx, vz = this.vz;
  const inv2h = 0.5 / VOXEL;
  const dvxdx = (vx[c + 1] - vx[c - 1]) * inv2h;
  const dvxdz = (vx[c + NX] - vx[c - NX]) * inv2h;
  const dvzdx = (vz[c + 1] - vz[c - 1]) * inv2h;
  const dvzdz = (vz[c + NX] - vz[c - NX]) * inv2h;
  const ux = vx[c], uz = vz[c];
  const ax = ux * dvxdx + uz * dvxdz;
  const az = ux * dvzdx + uz * dvzdz;
  const sp2 = ux * ux + uz * uz;
  if (sp2 < 1e-6) return 0;
  return (ux * az - uz * ax) / (sp2 * Math.sqrt(sp2));   // 1/m
}
```

Trois usages :

1. **Sape préférentielle sur la berge externe** — déjà branché dans
   `undercut()` par `bias`.
2. **Dépôt préférentiel sur le banc interne.** Dans la branche de dépôt de
   `erode()`, décaler légèrement le dépôt vers l'intérieur du virage :
   ```js
   const k = this.curvature(c);
   if (Math.abs(k) > 0.5 && speed > 0.2) {
     const sg = Math.sign(k);
     const ix = Math.round(-vz[c] / speed * sg), iz = Math.round(vx[c] / speed * sg);
     this.deposit(x + ix, z + iz, amount * 0.7);
     this.deposit(x, z, amount * 0.3);
   } else {
     this.deposit(x, z, amount);
   }
   ```
3. **Superélévation visuelle.** `Δz = v²·W/(g·R) = v²·W·κ/g`. Pour v = 0,5 m/s,
   W = 0,15 m, R = 0,3 m : `Δz = 0,25 × 0,15 / (9,81 × 0,3) = 1,3 mm`. Sous le
   millimètre à notre échelle — **invisible en géométrie**. À ne pas
   implémenter dans le maillage ; en revanche l'ajouter à la **normale de
   rendu** donne un léger dévers qui se lit très bien en spéculaire :
   ```glsl
   float bank = kappa * speed * speed / 9.81;    // rad
   vec2 perp = vec2(-flow.y, flow.x) / max(speed, 1e-4);
   N = normalize(vec3(N.x - perp.x * bank * 2.0, N.y, N.z - perp.y * bank * 2.0));
   ```
   (`kappa` doit alors être exporté dans un canal libre de `uFlow`.)

Attente réaliste : sur un domaine de 10 m avec des cellules de 4 cm et quelques
minutes de temps de jeu, on n'obtiendra pas un méandre complet qui migre. On
obtiendra un chenal qui **choisit un côté** dans les virages, avec une berge
externe franche et un banc de sable interne — ce qui est déjà l'essentiel de la
signature visuelle du méandre, et largement suffisant.

### 5.7 Seuils et vasques

Le profil en **step-pool** (une succession de seuils raides et de vasques
plates) est la forme d'équilibre naturelle d'un cours d'eau à forte pente sur
matériau mobile. Bonne nouvelle : **il émerge tout seul** de la combinaison mise
en place, sans code dédié. Le mécanisme :

1. Dans une vasque, `h` est grand et `v` petit → `q` modéré mais `S` (la pente
   de la surface libre) **quasi nulle** → `E ≈ 0`, et `cap` chute → **dépôt**.
   La vasque se comble par le bas et se stabilise.
2. Au seuil, `S` est maximale et `h` faible → `τ` élevé → **incision**. Le seuil
   recule vers l'amont (érosion régressive), exactement comme un vrai seuil.
3. Sous le seuil, l'impact de la cascade (§2.5) creuse la **vasque de
   dissipation** : c'est l'érosion par la puissance dissipée, et elle est déjà
   branchée puisque `land()` injecte de l'impulsion et de la turbulence, qui
   font monter `speed` donc `q` donc `E` localement.
4. Le tout s'auto-organise en une alternance, parce que dès qu'une vasque se
   creuse, elle noie son propre seuil (§2.2 : la marche se mesure jusqu'au plan
   d'eau du voisin) et l'érosion s'y calme.

Une seule chose à surveiller pour que ça tienne : **un fond dur**, sinon un
ruisseau alimenté longtemps creuse jusqu'au bas du monde. Deux options :

- lier `τ_c` à la profondeur sous la nappe (le sable saturé en profondeur est
  plus dense) — physiquement discutable ;
- **mieux** : compter sur la limite naturelle. À mesure que le lit descend, la
  pente de la surface libre `S` diminue (le profil se concavifie), donc `E`
  diminue. C'est le mécanisme réel du **profil d'équilibre**, et il est déjà
  dans la loi. Il suffit de ne pas le court-circuiter — c'est-à-dire de **ne
  jamais remettre de plancher sur S**.

---

## 6. Qualité du solveur

### 6.1 Les quatre candidats

**(A) Modèle « pipe » (actuel).** Kass & Miller / Mei et al.

- ✅ Positivité inconditionnelle, mouillage/assèchement gratuit, ~1,5 ms.
- ❌ Pas d'advection de quantité de mouvement → pas de chocs, pas de ressauts,
  pas d'écoulement torrentiel, aspect gélatine.
- ❌ L'amortissement `0.985` n'a aucune signification physique : pas de vitesse
  d'équilibre.

**(B) Saint-Venant en volumes finis (HLL/HLLC + reconstruction hydrostatique).**
Audusse et al. 2004 pour l'équilibre au repos, Kurganov & Petrova 2007 pour la
positivité.

- ✅ Vraie physique : chocs, ressauts, régimes torrentiels, exactement
  conservatif, **équilibré** (une nappe au repos sur un fond quelconque reste au
  repos — le fameux *well-balanced*, qui n'est pas garanti par un schéma naïf).
- ⚠️ Condition CFL : `Δt ≤ Δx/(|u| + √(gh))`. Vérification à nos dimensions :

  | h (m) | √(gh) | Δt max (Δx = 4 cm, u = 0,5 m/s) |
  |---|---|---|
  | 0,02 (ruisseau) | 0,44 | 42 ms |
  | 0,20 (douve) | 1,40 | 21 ms |
  | 0,50 (mer) | 2,21 | 14,8 ms |
  | 1,00 (fosse) | 3,13 | 11,0 ms |

  À `SIM_DT = 16,7 ms`, on a besoin de **1 à 2 sous-pas**. Parfaitement
  tenable.
- ⚠️ Coût : ~60 flops par face, 2 directions, ~25 000 cellules mouillées,
  1,5 sous-pas ⇒ ≈ 4,5 Mflop/frame. En JS sur `Float32Array` : **2 à 4 ms**.
  Soit 2 à 3× le solveur actuel. Le budget existe, mais il n'est pas gratuit.

**(C) Champ de hauteur + vitesse semi-lagrangienne.** Chentanez & Müller,
SCA 2010.

- ✅ Advection inconditionnellement stable, gros pas de temps, structure très
  proche du code existant, et c'est l'architecture des jeux qui ont réussi ça.
- ✅ Elle contient *déjà*, dans le papier d'origine, la couche de particules
  pour les éclaboussures — donc elle s'accorde nativement avec §2.
- ❌ **Non conservative** : l'advection semi-lagrangienne perd du volume
  (typiquement 0,1 à 1 % par seconde). Il faut une passe de correction globale.
- ❌ Diffusive : les fronts s'adoucissent, les chocs sont mous.

**(D) Particules (PBF, FLIP).** Macklin & Müller 2013.

- Chiffrage : un bassin de 3 m² sur 20 cm = 0,6 m³. À des particules de 2 cm
  (8 × 10⁻⁶ m³), c'est **75 000 particules**, avec recherche de voisins et
  2–4 itérations de projection par pas. En JavaScript, c'est hors de portée
  d'un ou deux ordres de grandeur.
- ✅ **Mais** pour les 2 400 parcelles balistiques de §2, il n'y a ni voisinage
  ni projection : c'est de la balistique pure, à ~20 flops par particule. Coût
  total ≈ 0,1 ms. C'est exactement le bon usage des particules ici.

### 6.2 Le verdict

> **Champ de hauteur pour la nappe, particules pour ce qui décolle.** Et, à
> l'intérieur du champ de hauteur : passer d'une équation d'ondes amortie à un
> vrai Saint-Venant, en deux étapes.

**Étape 1 — « pipe augmenté » (à faire en premier).** On garde toute la
structure existante (flux, mise à l'échelle, bandes de balayage, conditions aux
limites), et on ajoute les deux termes manquants :

1. **Advection de quantité de mouvement**, par rétro-trace semi-lagrangienne du
   champ `(vx, vz)`. ~40 lignes.
2. **Frottement de Manning** en remplacement de `WATER_DAMPING`. ~5 lignes.

Effet : un écoulement acquiert de l'inertie et une vitesse d'équilibre. C'est
l'essentiel du gain visuel, pour un vingtième de l'effort de (B). Le champ
`vx/vz` cesse d'être un simple diagnostic et devient un vrai état — ce qui rend
au passage la flow map (§3) beaucoup plus stable.

**Étape 2 — HLL (seulement si les chocs restent mous).** Remplacer `flux()` +
`integrate()` par un schéma en volumes finis. À ne lancer que si, après
l'étape 1, les ressauts et les fronts n'ont toujours pas la netteté voulue.
C'est la bonne dette technique à assumer : le code de l'étape 1 est un
sur-ensemble de l'état actuel, et l'étape 2 remplace deux fonctions bien
isolées.

**Pourquoi pas (C) tel quel ?** Parce que la non-conservation est un défaut
rédhibitoire pour ce jeu : le joueur creuse, remplit, vide, et *compte* l'eau.
Une mer qui perd 1 % de volume par seconde disparaît en deux minutes. On
récupère donc l'idée qui compte de (C) — l'advection semi-lagrangienne du
**moment** — sans son défaut, parce qu'on garde le transport de **masse** en
forme conservative (flux entre cellules), qui est exactement ce que le modèle
« pipe » fait bien.

### 6.3 Le schéma retenu, en détail

**Frottement de Manning.** L'équation d'un écoulement uniforme :

```
v = (1/n) · R^{2/3} · S^{1/2}         (R ≈ h pour une nappe large)
```

avec `n` le coefficient de Manning : 0,020 pour du sable lisse, 0,030 pour du
sable rugueux, 0,045 pour un fond très irrégulier. Le terme de frottement
s'écrit en pente d'énergie :

```
S_f = n² |v| v / h^{4/3}
```

et s'intègre **implicitement** (indispensable : explicite, il oscille en eau
mince) :

```
v ← v / (1 + Δt · g · n² |v| / h^{4/3})
```

**Vérifications.**

| h (m) | S | n | v d'équilibre (m/s) |
|---|---|---|---|
| 0,02 | 0,05 | 0,025 | 0,66 |
| 0,02 | 0,15 | 0,025 | 1,14 |
| 0,05 | 0,05 | 0,025 | 1,22 |
| 0,10 | 0,02 | 0,030 | 1,03 |

Ce sont exactement les vitesses observées sur un vrai ruisseau de plage. Le
garde-fou arbitraire à 4 m/s devient inutile : le frottement borne la vitesse
tout seul, et de façon *physique* — donc les Froude calculés sont justes, donc
tout §3 et §4 se calent correctement.

**Le code, en remplacement du calcul de vitesse de `integrate()` :**

```js
/**
 * VITESSE : advection de soi-meme + gravite + frottement de Manning.
 *
 * Le modele "pipe" de Mei ne transporte pas la quantite de mouvement : le
 * flux n'est qu'accelere par le gradient de charge, jamais advecte par
 * lui-meme. Formellement, c'est une equation d'ondes amortie, pas
 * Saint-Venant. C'est la cause de l'aspect "gelatine" — tout bouge par blocs,
 * en phase — et de l'impossibilite d'un choc.
 *
 * On ajoute donc les deux termes manquants :
 *
 *   1. (u.grad)u par retro-trace semi-lagrangienne : l'eau emporte sa vitesse.
 *      C'est ce qui donne un JET quand un ruisseau debouche dans une vasque,
 *      au lieu d'un etalement radial instantane.
 *
 *   2. le frottement de Manning, S_f = n^2 |v| v / h^(4/3), integre
 *      implicitement. Il remplace WATER_DAMPING, qui freinait tout de la meme
 *      facon et interdisait donc l'existence d'une vitesse d'equilibre.
 *      Avec Manning, v -> (1/n) h^(2/3) S^(1/2) : une nappe de 2 cm sur une
 *      pente de 5% se stabilise a 0.66 m/s. C'est la bonne valeur.
 */
advectVelocity(dt) {
  const h = this.h, vx = this.vx, vz = this.vz;
  const ax = this.velTmpX, az = this.velTmpZ;    // Float32Array(COLS)
  const surf = this.field.surfaceH;
  const inv2h = 0.5 / VOXEL;
  const n2g = MANNING_N * MANNING_N * GRAVITY;

  for (let z = 1; z < NZ - 1; z++) {
    const row = NX * z;
    const xa = Math.max(1, this.scanA[z]), xb = Math.min(NX - 2, this.scanB[z]);
    for (let x = xa; x <= xb; x++) {
      const c = row + x;
      const hw = h[c];
      if (hw < WATER_EPSILON) { ax[c] = 0; az[c] = 0; continue; }

      // --- 1. auto-advection semi-lagrangienne -----------------------------
      const px = clamp(x - (vx[c] * dt) / VOXEL, 0.001, NX - 1.001);
      const pz = clamp(z - (vz[c] * dt) / VOXEL, 0.001, NZ - 1.001);
      const x0 = px | 0, z0 = pz | 0;
      const tx = px - x0, tz = pz - z0;
      const i00 = x0 + NX * z0, i10 = i00 + 1, i01 = i00 + NX, i11 = i01 + 1;
      // On ne ramene de la vitesse QUE des cellules mouillees : sinon une
      // cellule seche injecte un zero et le jet s'eteint sur son propre bord.
      const w00 = h[i00] > WATER_EPSILON ? (1 - tx) * (1 - tz) : 0;
      const w10 = h[i10] > WATER_EPSILON ? tx * (1 - tz) : 0;
      const w01 = h[i01] > WATER_EPSILON ? (1 - tx) * tz : 0;
      const w11 = h[i11] > WATER_EPSILON ? tx * tz : 0;
      const ws = w00 + w10 + w01 + w11;
      let ux, uz;
      if (ws > 1e-4) {
        const iw = 1 / ws;
        ux = (vx[i00] * w00 + vx[i10] * w10 + vx[i01] * w01 + vx[i11] * w11) * iw;
        uz = (vz[i00] * w00 + vz[i10] * w10 + vz[i01] * w01 + vz[i11] * w11) * iw;
      } else { ux = vx[c]; uz = vz[c]; }

      // --- 2. gravite : -g grad(eta) ---------------------------------------
      const eR = surf[c + 1] + h[c + 1], eL = surf[c - 1] + h[c - 1];
      const eT = surf[c + NX] + h[c + NX], eB = surf[c - NX] + h[c - NX];
      ux -= GRAVITY * dt * (eR - eL) * inv2h;
      uz -= GRAVITY * dt * (eT - eB) * inv2h;

      // --- 3. frottement de Manning, IMPLICITE -----------------------------
      const sp = Math.hypot(ux, uz);
      if (sp > 1e-5) {
        const hp = Math.pow(Math.max(hw, 0.003), 4 / 3);
        const k = 1 / (1 + dt * n2g * sp / hp);
        ux *= k; uz *= k;
      }
      ax[c] = ux; az[c] = uz;
    }
  }
  // Copie APRES la boucle complete : la retro-trace doit lire un champ
  // coherent, sinon on introduit un biais directionnel en Z.
  for (let z = 1; z < NZ - 1; z++) {
    const row = NX * z;
    const xa = Math.max(1, this.scanA[z]), xb = Math.min(NX - 2, this.scanB[z]);
    for (let x = xa; x <= xb; x++) {
      vx[row + x] = ax[row + x]; vz[row + x] = az[row + x];
    }
  }
}
```

**Et le couplage vitesse → flux.** Une fois `vx/vz` devenu un vrai état, il faut
que le transport de masse l'utilise. On remplace le calcul de flux par un
**upwind conservatif** sur la face :

```js
/**
 * Flux conservatif upwind : q_face = h_amont * v_face * largeur.
 *
 * On garde la structure "pipe" (quatre flux sortants + mise a l'echelle qui
 * garantit la positivite) mais le flux n'est plus pilote par le gradient de
 * charge seul : il est porte par la VITESSE, qui a maintenant sa propre
 * dynamique (advection + gravite + Manning). C'est ce qui transforme le
 * schema d'une equation d'ondes en un vrai transport.
 *
 * L'upwind — prendre la hauteur de la cellule D'OU VIENT l'eau — est ce qui
 * evite les hauteurs negatives et raidit les fronts au lieu de les diffuser.
 */
flux(dt) {
  const surf = this.field.surfaceH, h = this.h, vx = this.vx, vz = this.vz;
  const fR = this.fR, fL = this.fL, fT = this.fT, fB = this.fB;
  const W = VOXEL;   // largeur de la face

  for (let z = 0; z < NZ; z++) {
    const row = NX * z;
    const xa = this.scanA[z], xb = this.scanB[z];
    for (let x = xa; x <= xb; x++) {
      const c = row + x;
      const hc = h[c];
      if (hc < WATER_EPSILON) { fR[c] = fL[c] = fT[c] = fB[c] = 0; continue; }
      const eta = surf[c] + hc;

      // +X
      if (x + 1 < NX) {
        const n = c + 1;
        const vf = (vx[c] + vx[n]) * 0.5;
        // Mur : si ma surface libre ne depasse pas le fond du voisin, rien ne
        // passe. C'est la version minimale de la reconstruction hydrostatique.
        fR[c] = (vf > 0 && eta > surf[n]) ? vf * hc * W : 0;
      } else fR[c] = Math.max(0, eta - this.seaLevel) * W * 0.5;
      // -X
      if (x > 0) {
        const n = c - 1;
        const vf = (vx[c] + vx[n]) * 0.5;
        fL[c] = (vf < 0 && eta > surf[n]) ? -vf * hc * W : 0;
      } else fL[c] = Math.max(0, eta - this.seaLevel) * W * 0.5;
      // +Z
      if (z + 1 < NZ) {
        const n = c + NX;
        const vf = (vz[c] + vz[n]) * 0.5;
        fT[c] = (vf > 0 && eta > surf[n]) ? vf * hc * W : 0;
      } else fT[c] = Math.max(0, eta - this.seaLevel) * W * 0.5;
      // -Z
      if (z > 0) {
        const n = c - NX;
        const vf = (vz[c] + vz[n]) * 0.5;
        fB[c] = (vf < 0 && eta > surf[n]) ? -vf * hc * W : 0;
      } else fB[c] = Math.max(0, eta - this.seaLevel) * W * 0.5;

      // Mise a l'echelle : LA garantie de positivite. On la garde telle
      // quelle, c'est la meilleure idee du modele de Mei.
      const out = fR[c] + fL[c] + fT[c] + fB[c];
      if (out > 0) {
        const avail = (hc * A) / dt;
        if (out > avail) {
          const s = avail / out;
          fR[c] *= s; fL[c] *= s; fT[c] *= s; fB[c] *= s;
        }
      }
    }
  }
}
```

`integrate()` ne change pas pour la partie masse ; en revanche, **il ne
recalcule plus `vx/vz`** (ils sont maintenant un état à part entière, produit
par `advectVelocity`). Nouvel ordre de `step()` :

```js
step(dt) {
  this.time += dt * this.tideSpeed;
  this.updateTide();          // maree + ressac (code actuel, inchange)
  this.runSprings(dt);        // §5.2
  this.applyBoundaries(dt);
  this.computeScanRanges();
  this.advectVelocity(dt);    // (u.grad)u  -g.grad(eta)  Manning   §6.3
  this.flux(dt);              // q = h_amont * v_face, upwind        §6.3
  this.integrate(dt);         // bilan de masse
  this.whitewater(dt);        // Froude, ressauts, convergence       §4.3
  this.cascade?.step(dt);     // ce qui decroche part en balistique  §2.6
  this.erode(dt);             // puissance de courant + sape         §5.4
  this.advectSediment(dt);
  this.advectTrail(dt);       // trainees d'ecume                    §3.6
  this.infiltrate(dt);
  this.updateFlowField(dt);   // export lisse pour le rendu          §3.3
}
```

### 6.4 Chocs et ressauts sans explosion

Quatre précautions, toutes nécessaires.

**(a) Désingularisation de la vitesse.** Le calcul `v = q/h` explose en eau
mince. Formule de Kurganov & Petrova :

```
u = 2 h q / (h² + max(h², ε²)),        ε ≈ 2 mm
```

Elle vaut `q/h` quand `h ≫ ε`, tend continûment vers 0 quand `h → 0`, et **ne
demande aucun clamp arbitraire**. À utiliser partout où on reconstruit une
vitesse depuis un débit (notamment si on garde le calcul actuel de `integrate`).

```js
const EPS_DESING = 0.002;
function desingularize(q, h) {
  const h2 = h * h;
  const e2 = EPS_DESING * EPS_DESING;
  return (2 * h * q) / (h2 + (h2 > e2 ? h2 : e2));
}
```

**(b) Limiteur CFL adaptatif.** Après `advectVelocity`, mesurer la vitesse
d'onde maximale et sous-diviser le pas si nécessaire :

```js
/** Nombre de sous-pas necessaires pour respecter la CFL. */
cflSubsteps(dt) {
  let cmax = 0;
  for (let z = 0; z < NZ; z++) {
    const row = NX * z;
    for (let x = this.scanA[z]; x <= this.scanB[z]; x++) {
      const c = row + x;
      const hw = this.h[c];
      if (hw < WATER_EPSILON) continue;
      const s = Math.hypot(this.vx[c], this.vz[c]) + Math.sqrt(GRAVITY * hw);
      if (s > cmax) cmax = s;
    }
  }
  return Math.max(1, Math.min(3, Math.ceil((cmax * dt) / (VOXEL * 0.9))));
}
```

Plafonné à 3 : au-delà, mieux vaut laisser la physique tourner un peu au ralenti
(même raisonnement que `SIM_MAX_STEPS` dans `Config.js`) que faire chuter le
framerate. Chiffrage : `cmax = 3,2 m/s` (fosse de 1 m) → besoin = 1,5 →
2 sous-pas. En régime normal, 1.

**(c) Ne pas lisser les fronts.** La tentation est forte d'ajouter de la
viscosité artificielle pour calmer les oscillations. C'est exactement ce qu'il
ne faut pas faire : le ressaut *est* une oscillation, et une viscosité qui le
lisse détruit précisément le phénomène qu'on cherche. La bonne réponse est
l'**upwind** (déjà dans `flux()`) : il est dissipatif *à l'ordre du schéma*,
donc il stabilise sans effacer.

**(d) Reconstruction hydrostatique aux marches.** Sur une marche de terrain, un
schéma naïf calcule un gradient de charge à partir de hauteurs incompatibles et
peut produire un flux depuis une cellule vers un fond plus haut que sa propre
surface. Le test `eta > surf[n]` dans `flux()` en est la version minimale et
suffisante ici. La version complète (Audusse et al.) utilise
`h* = max(0, η − max(b_i, b_j))` des deux côtés de la face ; c'est ce qu'il
faudra écrire si on va jusqu'à HLL.

### 6.5 Conservation du volume : garantie et test

**Ce qui est conservatif par construction :** l'échange entre cellules via les
flux (chaque `f` est soustrait d'une cellule et ajouté à sa voisine, à
l'arrondi flottant près), et l'échange grille ↔ parcelles (§2.5).

**Ce qui ne l'est pas, et doit donc être compté :**

| Terme | Signe | Où |
|---|---|---|
| `pour()` / sources / pluie | + | `pour`, `runSprings`, `rain` |
| Suintement de nappe | + | `applyBoundaries` |
| Imposition océan | ± | `applyBoundaries` (`h[c] = level − terrain`) |
| Infiltration | − | `infiltrate` |
| Fuite au bord du domaine | − | `integrate` (flux de bord sans receveur) |
| Parcelles perdues | − | `Cascade.lostOut` |
| Clamp `h1 < 0` | + | `integrate` |

Le compteur :

```js
/**
 * AUDIT DE VOLUME.
 *
 * Un solveur d'eau qui fuit est indetectable a l'oeil pendant dix minutes,
 * puis la mer a disparu et on ne sait pas pourquoi. On compte donc TOUT ce
 * qui entre et tout ce qui sort, et on verifie l'invariant en continu.
 *
 * Invariant : V(t) - V(0) - sum(entrees) + sum(sorties) ~= 0.
 */
resetAudit() {
  this.budget = { in: 0, ocean: 0, seep: 0, clamp: 0,
                  out: 0, infil: 0, edge: 0 };
  this._v0 = this.totalVolume();
}

totalVolume() {
  let v = 0;
  const h = this.h;
  for (let c = 0; c < COLS; c++) v += h[c];
  v *= A;
  if (this.cascade) v += this.cascade.inFlight + this.cascade.pendingVolume;
  return v;
}

auditError() {
  const b = this.budget;
  const expected = this._v0 + b.in + b.ocean + b.seep + b.clamp
                            - b.out - b.infil - b.edge
                            - (this.cascade ? this.cascade.lostOut : 0);
  const actual = this.totalVolume();
  const err = actual - expected;
  return { actual, expected, err, rel: Math.abs(err) / Math.max(actual, 1e-6) };
}
```

Instrumentation minimale à ajouter :

```js
// applyBoundaries, branche ocean :
const want = Math.max(0, level - terrain);
this.budget.ocean += (want - h[c]) * A;
h[c] = want;

// applyBoundaries, branche suintement :
const add = (want - h[c]) * kSeep;
this.budget.seep += add * A;
h[c] += add;

// infiltrate :
this.budget.infil += take * A;

// integrate, clamp de positivite :
if (h1 < 0) { this.budget.clamp -= h1 * A; h1 = 0; }

// integrate, bords du domaine (les flux sortants sans cellule receveuse) :
if (x === NX - 1) this.budget.edge += fR[c] * dt;
if (x === 0)      this.budget.edge += fL[c] * dt;
if (z === NZ - 1) this.budget.edge += fT[c] * dt;
if (z === 0)      this.budget.edge += fB[c] * dt;
```

**Le test.**

```js
/**
 * TEST DE CONSERVATION DU VOLUME.
 *
 * Scenario : un bassin ferme, une cascade en son milieu, et rien d'autre.
 * On coupe la maree, l'ocean, le suintement, l'infiltration et l'erosion — le
 * seul mecanisme actif est le transport, plus la couche balistique. Si le
 * volume derive, c'est un bug, pas un effet de bord.
 *
 * Le terrain doit avoir ete sculpte par l'appelant : un plateau, une falaise
 * de 30 cm, une fosse. Sinon il n'y a pas de cascade a tester.
 */
export function testVolumeConservation(water, cascade) {
  water.tideSpeed = 0;
  water.erosionEnabled = false;
  water.isOcean.fill(0);              // pas d'imposition de niveau
  water.tableH.fill(-99);             // pas de suintement
  const moist = water.moisture;
  water.moisture = null;              // coupe l'infiltration
  water.h.fill(0);
  water.sed.fill(0);

  water.pour(0, 0, 0.5, 0.020);       // 20 litres sur le plateau
  water.resetAudit();
  const V0 = water.totalVolume();

  for (let i = 0; i < 60 * 30; i++) water.step(1 / 60);   // 30 s simulees
  const a = water.auditError();

  console.table({
    V0_litres:        (V0 * 1000).toFixed(3),
    V1_litres:        (a.actual * 1000).toFixed(3),
    attendu_litres:   (a.expected * 1000).toFixed(3),
    derive_mL:        (a.err * 1e6).toFixed(3),
    derive_relative:  (a.rel * 100).toFixed(5) + ' %',
    cascade_emis:     cascade.emitted,
    cascade_absorbe:  cascade.absorbed,
    cascade_en_vol:   cascade.inFlight,
    cascade_attente:  cascade.pendingVolume,
    cascade_perdu:    cascade.lostOut,
  });

  // Critere 1 : moins de 0,05 % de derive sur 1800 pas.
  console.assert(a.rel < 5e-4, 'FUITE DE VOLUME dans le solveur');
  // Critere 2 : la couche balistique ne perd rien.
  const c = cascade;
  const bal = c.emitted - (c.absorbed + c.inFlight + c.pendingVolume + c.lostOut);
  console.assert(Math.abs(bal) < 1e-9, 'FUITE dans la couche balistique', bal);

  water.moisture = moist;
  return a;
}
```

Seuil : **0,05 % sur 30 s**. C'est atteignable — la seule perte structurelle est
l'arrondi `Float32` sur ~10⁶ additions, soit ~10⁻⁷ en relatif. Tout ce qui
dépasse est un vrai bug. Afficher `auditError().rel` en permanence dans le HUD
de debug : c'est le meilleur détecteur de régression du projet.

### 6.6 Supprimer la gélatine

L'aspect « bloc de gelée qui tremble » vient de cinq causes cumulées. Les
traiter dans cet ordre :

**① Absence d'advection de moment (la cause principale).** Sans `(u·∇)u`, toutes
les cellules répondent au même gradient au même instant et bougent en phase :
c'est littéralement un mode propre global, ce qui *est* la définition visuelle
de la gelée. `advectVelocity()` (§6.3) le corrige. **C'est 70 % du problème.**

**② L'amortissement global.** `0.985^(60dt)` freine partout, uniformément, et
crée un couplage artificiel entre toutes les cellules (toutes ralentissent
ensemble). Manning le remplace par un frottement **qui dépend de la profondeur
locale** : le fond du chenal file, les bords traînent → **cisaillement**, et le
cisaillement est l'opposé visuel de la gelée.

**③ La normale par différences finies sur la grille.** Dans `WaterRenderer`,
`vSurfNormal` est calculée sur 4 cm. Toute ondulation d'amplitude inférieure au
demi-millimètre y est noyée ; ce qui reste, ce sont les grandes structures — qui
bougent en bloc. Correctif : **réduire le poids de la normale de simulation en
eau peu profonde** et laisser tout le détail au flow map.

```glsl
float bulk = smoothstep(0.02, 0.12, d);   // les grandes structures ne comptent
vec3 N = normalize(vec3(vSurfNormal.x * bulk + dn.x,   // qu'en eau profonde
                        vSurfNormal.y,
                        vSurfNormal.z * bulk + dn.z));
```

**④ La houle de sinus dans le vertex shader.** Trois sinus globaux ajoutés au
niveau, d'amplitude fixe et de phase mondiale : c'est une déformation
**cohérente sur tout le domaine**, donc elle *fabrique* de la gelée. Elle est
justifiée au large ; elle doit être coupée dès que l'eau est confinée. Le
masque existe déjà (`open = smoothstep(0.04, 0.40, vDepth)`) mais il ne dépend
que de la profondeur — une douve profonde ondule donc comme la haute mer. Il
faut lui ajouter un masque de **confinement** : distance à la cellule sèche la
plus proche, calculée une fois par seconde par un balayage de type chamfer
(deux passes, avant et arrière), et exportée dans un canal libre.

```js
/** Distance a la cellule seche la plus proche, en cellules. Chamfer 2 passes. */
updateConfinement() {
  const d = this.confine, h = this.h;
  const BIG = 1e4;
  for (let c = 0; c < COLS; c++) d[c] = h[c] > WATER_EPSILON ? BIG : 0;
  for (let z = 1; z < NZ; z++) for (let x = 1; x < NX; x++) {
    const c = x + NX * z;
    const m = Math.min(d[c], d[c - 1] + 1, d[c - NX] + 1, d[c - NX - 1] + 1.414);
    if (m < d[c]) d[c] = m;
  }
  for (let z = NZ - 2; z >= 0; z--) for (let x = NX - 2; x >= 0; x--) {
    const c = x + NX * z;
    const m = Math.min(d[c], d[c + 1] + 1, d[c + NX] + 1, d[c + NX + 1] + 1.414);
    if (m < d[c]) d[c] = m;
  }
}
```

Puis dans le vertex shader : `level += sw * open * confineMask * (0.5 + uChop);`
avec `confineMask = smoothstep(4.0, 20.0, confine)` — la houle n'existe qu'à
plus de 80 cm de toute rive.

**⑤ Le pas de temps.** À 1/60 avec `SIM_MAX_STEPS = 2`, une frame à 30 fps
n'exécute que deux pas au lieu de quatre : la simulation ralentit visiblement.
Sur une eau qui coule, ce ralentissement se lit comme de la viscosité. Rien à
changer dans la politique (elle est justifiée par le commentaire du `Config`),
mais il faut le savoir en réglant les constantes de temps : **elles doivent être
calées à 60 fps stable**, sinon le jeu semble plus visqueux sur une machine
lente.

---

## 7. Réglages et lisibilité pour le joueur

### 7.1 Le mode « voir l'écoulement »

Un mode de construction, activé par une touche (`F` par exemple), qui répond à
la seule question qui compte quand on creuse : **où va l'eau, et est-ce que ça
descend vraiment ?**

Deux implémentations, complémentaires. La première coûte 60 lignes et donne
80 % du bénéfice.

**(a) Les flèches instanciées** — précis, quantitatif, lisible en photo.

```js
/**
 * MODE "VOIR L'ECOULEMENT".
 *
 * Une grille grossiere de fleches, orientees selon la vitesse, colorees par le
 * nombre de Froude. C'est l'outil de CONSTRUCTION : il repond a la seule
 * question qu'on se pose en creusant une tranchee, "est-ce que ca descend
 * vraiment dans ce sens ?".
 *
 * Grille de 48x48 (une fleche tous les 21 cm) : assez dense pour lire un
 * chenal de 10 cm, assez lache pour ne pas faire un tapis.
 *
 * Une seule information par canal : la LONGUEUR dit la vitesse, la COULEUR dit
 * le regime (bleu = fluvial, blanc = critique, orange = torrentiel). Melanger
 * les deux rendrait le graphique illisible.
 */
import * as THREE from 'three';
import {
  NX, NZ, VOXEL, ORIGIN_X, ORIGIN_Z, WATER_EPSILON, clamp,
} from '../core/Config.js';

const GX = 48, GZ = 48;

export class FlowDebug {
  constructor(scene, water, field) {
    this.water = water; this.field = field;
    const geo = new THREE.ConeGeometry(0.018, 0.075, 5);
    geo.rotateX(Math.PI / 2);            // pointe vers +Z
    geo.translate(0, 0, 0.020);
    const mat = new THREE.MeshBasicMaterial({
      vertexColors: true, transparent: true, opacity: 0.85,
    });
    this.mesh = new THREE.InstancedMesh(geo, mat, GX * GZ);
    this.mesh.instanceColor = new THREE.InstancedBufferAttribute(
      new Float32Array(GX * GZ * 3), 3);
    this.mesh.frustumCulled = false;
    this.mesh.visible = false;
    this.mesh.renderOrder = 20;
    scene.add(this.mesh);
    this._m = new THREE.Matrix4();
    this._q = new THREE.Quaternion();
    this._fwd = new THREE.Vector3(0, 0, 1);
    this._dir = new THREE.Vector3();
    this._pos = new THREE.Vector3();
    this._scl = new THREE.Vector3();
  }

  set visible(v) { this.mesh.visible = v; }
  get visible() { return this.mesh.visible; }

  update() {
    if (!this.mesh.visible) return;
    const W = this.water, F = this.field;
    const col = this.mesh.instanceColor.array;
    const sx = NX / GX, sz = NZ / GZ;
    let n = 0;
    for (let j = 0; j < GZ; j++) {
      const z = Math.min(NZ - 1, ((j + 0.5) * sz) | 0);
      for (let i = 0; i < GX; i++) {
        const x = Math.min(NX - 1, ((i + 0.5) * sx) | 0);
        const c = x + NX * z;
        if (W.h[c] < WATER_EPSILON * 3) continue;
        const vx = W.flowX[c], vz = W.flowZ[c];
        const sp = Math.hypot(vx, vz);
        if (sp < 0.03) continue;

        this._pos.set(ORIGIN_X + (x + 0.5) * VOXEL,
                      F.surfaceH[c] + W.h[c] + 0.012,
                      ORIGIN_Z + (z + 0.5) * VOXEL);
        this._dir.set(vx / sp, 0, vz / sp);
        this._q.setFromUnitVectors(this._fwd, this._dir);
        this._scl.set(1, 1, clamp(sp * 1.6, 0.35, 2.6));
        this._m.compose(this._pos, this._q, this._scl);
        this.mesh.setMatrixAt(n, this._m);

        const fr = W.froude[c];
        const t = clamp(fr, 0, 2) * 0.5;
        col[n * 3]     = 0.25 + 0.75 * t;
        col[n * 3 + 1] = 0.55 + 0.35 * (1 - Math.abs(fr - 1));
        col[n * 3 + 2] = 1.00 - 0.85 * t;
        n++;
      }
    }
    this.mesh.count = n;
    this.mesh.instanceMatrix.needsUpdate = true;
    this.mesh.instanceColor.needsUpdate = true;
  }
}
```

**(b) Les lignes de courant en shader** — plus beau, gratuit, et il réutilise
*exactement* la machinerie de §3.4. Il suffit de remplacer le bruit par un motif
strié à fort contraste, et de superposer :

```glsl
#ifdef FLOW_DEBUG
  // Rayures advectees : la meme flow map, mais avec un motif LISIBLE.
  float p0, p1, w;
  flowPhases(vWorldPos.xz, p0, p1, w);
  vec2 dd = flowOffset(flow) / max(uFlowTile, 1e-3);
  // Rayures PERPENDICULAIRES au courant : elles defilent vers l'aval et l'oeil
  // lit immediatement le sens.
  vec2 T = normalize(flow + vec2(1e-5));
  float s0 = fract(dot(vWorldPos.xz - dd * p0, T) * 8.0);
  float s1 = fract(dot(vWorldPos.xz - dd * p1, T) * 8.0);
  float b0 = smoothstep(0.45, 0.50, s0) * smoothstep(0.90, 0.85, s0);
  float b1 = smoothstep(0.45, 0.50, s1) * smoothstep(0.90, 0.85, s1);
  float stripe = mix(b0, b1, w);
  vec3 regime = mix(vec3(0.2, 0.6, 1.0), vec3(1.0, 0.55, 0.15),
                    smoothstep(0.6, 1.4, froude));
  col = mix(col, regime, stripe * smoothstep(0.05, 0.25, speed) * 0.75);
#endif
```

Coût : quasi nul (deux `fract` et un `dot`), et le `#ifdef` évite de payer quoi
que ce soit hors du mode debug.

**(c) La lecture de la pente.** Complément naturel, qui répond à la question du
joueur *avant même* qu'il y ait de l'eau : afficher, en mode construction, des
isolignes de terrain tous les 2 cm. On sait alors si une tranchée descend avant
de la remplir. C'est une passe sur `TerrainRenderer`, hors sujet ici, mais à
noter.

### 7.2 Les réglages à exposer

Principe : ne surtout pas exposer les constantes physiques. Exposer des
**intentions**, chacune pilotant plusieurs constantes.

| Réglage | Plage | Défaut | Ce qu'il pilote réellement |
|---|---|---|---|
| **Débit de la source** (par source) | filet / ruisseau / torrent / vanne | ruisseau | `spring.rate` : 2e-4 / 8e-4 / 2,5e-3 / 8e-3 m³/s |
| **Érosion** | sanctuaire / douce / normale / vive | normale | `erosionEnabled` + facteur K de la loi de puissance : 0 / 0,25 / 1 / 3 |
| **Lisibilité de l'écoulement** | 0 – 2 | 1,0 | `uFlowDistort`, amplitude des traînées, amplitude des ondes stationnaires, seuil d'apparition de l'écume |
| **Agitation de la mer** | 0 – 1 | 0,35 | `uChop` (existe déjà) + amplitude du ressac |
| **Vitesse de la marée** | ×0 – ×4 | ×1 | `tideSpeed` (existe déjà) |
| **Qualité de l'eau** | basse / moyenne / haute | selon `quality` | budget de parcelles (600 / 1 400 / 2 400), embrun on/off, octaves de la flow map (1 / 2 / 3), nappe on/off |
| **Voir l'écoulement** | off / flèches / lignes | off | `FlowDebug.visible`, `#define FLOW_DEBUG` |
| **Pluie** | off / bruine / averse / orage | off | `rain()` : 0 / 2 / 10 / 40 mm/h × boost |

Deux réglages **à ne pas exposer**, malgré la tentation :

- `WATER_DAMPING` / `MANNING_N` : ils changent le comportement d'équilibre de
  tout le système, et un joueur qui les touche casse l'accord entre le Froude,
  l'écume et l'érosion. Le coefficient de Manning est une **propriété du
  sable**, pas un réglage.
- `FLOW_CYCLE` : mal réglé, il produit soit un battement visible, soit une
  texture qui nage. C'est un choix d'auteur.

### 7.3 Le retour d'information pendant la construction

Trois indicateurs, à afficher pendant qu'on creuse ou qu'on pose une source :

1. **« Lit amorcé : 62 % »** — la saturation moyenne du sable sous la lame, le
   long du chenal actif. Explique pourquoi la rivière n'avance pas encore
   (§5.1). Sans cette information, le joueur croit que le jeu est cassé.
2. **Le débit qui atteint la mer**, en L/s, mesuré comme `budget.edge` dérivé
   par seconde. C'est le score naturel d'un canal réussi.
3. **La hauteur de chute la plus élevée du monde**, avec un petit marqueur
   (`max(cascade.lips[i].drop)`). Un objectif implicite : « fais une chute de
   50 cm ».

---

## 8. Plan d'implémentation ordonné

Classement par rapport gain/effort réel. Les trois premières étapes sont
indépendantes les unes des autres et livrables séparément — chacune est visible
immédiatement.

| # | Étape | Effort | Gain | Risque |
|---|---|---|---|---|
| **1** | **Champ de flux + flow map** (§3.3, §3.4) | ½ j | ★★★★★ | faible |
| **2** | **Eau blanche : Froude, ressauts, bulles, traînées** (§3.6, §4) | ½ j | ★★★★★ | faible |
| **3** | **Cascade : seuils, parcelles, réabsorption** (§2.2–2.6) | 1 j | ★★★★★ | moyen |
| **4** | **Audit de volume + test** (§6.5) | ½ j | ★★★☆☆ (dette) | nul |
| **5** | **Sources posables + amorçage du lit** (§5.2) | ½ j | ★★★★★ | faible |
| **6** | **Nappe + gouttes + embrun** (§2.7, §2.8) | 1 j | ★★★★☆ | faible |
| **7** | **Manning + advection de moment** (§6.3) | 1 j | ★★★★☆ | moyen — recaler l'érosion ensuite |
| **8** | **Érosion par puissance de courant + `digAt`** (§5.4, §5.5) | 1 j | ★★★★☆ | moyen — équilibrage |
| **9** | **Mode « voir l'écoulement »** (§7.1) | ½ j | ★★★☆☆ | nul |
| **10** | **Ondes stationnaires + rides** (§3.7) | ½ j | ★★★☆☆ | faible |
| **11** | **Méandres par courbure** (§5.6) | 1 j | ★★☆☆☆ | élevé — instable si mal dosé |
| **12** | **HLL + reconstruction hydrostatique** (§6.1 B) | 3 j | ★★☆☆☆ | élevé |

**Ordre recommandé : 1 → 2 → 3 → 4 → 5 → 6 → 7 → 8 → 9 → 10 → 11 → (12).**

L'étape 4 est placée tôt à dessein : dès que la couche balistique existe
(étape 3), le risque de fuite de volume devient réel, et un audit ajouté après
coup ne trouve jamais rien.

Les étapes 7 et 8 sont couplées : Manning change les vitesses d'un facteur ~2,
donc les constantes d'érosion doivent être recalées **après**, pas avant.
L'étape 12 est optionnelle et ne devrait être lancée que si, après 7, les
ressauts restent mous.

### 8.1 Code prêt à coller — étape 1 : la flow map

**`src/core/Config.js`** :

```js
// --- Flow map / lisibilite de l'ecoulement ---------------------------------
/** Constante de temps du lissage du champ de vitesse pour le rendu (s). */
export const FLOW_TAU = 0.22;
/** Duree d'un cycle de la flow map (s). */
export const FLOW_CYCLE = 1.20;
/** Repetitions du motif de surface par metre. */
export const FLOW_TILE = 3.0;
/** Distorsion maximale, en periodes de texture. Au-dela, ca "nage". */
export const FLOW_MAX_DISTORT = 0.70;
/** Coefficient de Manning du sable de plage (etape 7). */
export const MANNING_N = 0.025;
```

**`src/sim/Water.js`** — trois blocs :

1. dans le constructeur, après `this.foam` :

```js
    /** Champ de vitesse LISSE pour le rendu. Ne pilote pas la physique. */
    this.flowX = new Float32Array(COLS);
    this.flowZ = new Float32Array(COLS);
    this.flowTmp = new Float32Array(COLS);
    /** Nombre de Froude lisse. C'est LE nombre qui dit le regime. */
    this.froude = new Float32Array(COLS);
```

2. les méthodes `updateFlowField(dt)` et `blurBand(a)` de §3.3 ;
3. dans `step(dt)`, en dernière ligne : `this.updateFlowField(dt);`

**`src/render/WaterRenderer.js`** — le bloc de texture et d'uniformes de §3.3,
les fonctions GLSL de §3.4, l'appel `this.updateFlowTexture();` dans `update()`,
et le remplacement de l'appel `detailNormal(vWorldPos.xz, …)` par
`flowNormal(vWorldPos.xz, flow, …)`.

**Test de recette.** Creuser une tranchée en pente vers la mer, verser un seau.
On doit voir la texture **descendre la tranchée**, et s'arrêter dans la flaque
du bas. Si elle tremble : augmenter `FLOW_TAU`. Si elle « nage » : baisser
`FLOW_MAX_DISTORT`. Si elle pulse de façon synchrone sur tout l'écran : le
décalage de phase spatial (`flowPhases`) n'est pas branché.

### 8.2 Code prêt à coller — étape 2 : l'eau blanche

**`Water.js`** : les champs `bubbles`, `trail`, `trailTmp` ; les méthodes
`whitewater(dt)` (§4.3) et `advectTrail(dt)` (§3.6) ; les appels dans `step()`
après `integrate()`. Export de `trail` dans le canal A de `uFlow` (§3.3), et de
`bubbles` dans le canal A de `uField` en remplacement de `sed` (que l'on
déplace, ou que l'on abandonne au profit de la teinte de `trail` — le sédiment
en suspension est le moins visible des quatre).

**`WaterRenderer.js`** : le bloc « bulles » de §4.2 dans le fragment, et le
remplacement du calcul de `foamMask` par `max(vFoam * (0.55 + 1.9*edge), trail)`
(§3.4).

**Test de recette.** Verser un seau sur une pente raide. On doit voir apparaître
une **traînée blanche** qui descend la pente et qui persiste quelques secondes
après le passage de l'eau ; et là où la nappe rapide arrive dans une flaque, un
**bourrelet blanc stationnaire** — le ressaut. Vérifier qu'une douve pleine et
immobile reste **entièrement transparente**, sans liseré : c'est le test négatif
qui compte le plus.

### 8.3 Code prêt à coller — étape 3 : les cascades

Le fichier `src/sim/Cascade.js` complet de §2.6, plus :

**`src/sim/Water.js`** :

```js
    // constructeur
    this.cascade = null;      // injecte par Game, evite le cycle d'import

    // step(dt), entre integrate() et erode()
    this.cascade?.step(dt);
```

**`src/core/Game.js`** :

```js
import { Cascade } from '../sim/Cascade.js';
// ...
this.water = new Water(this.field, this.granular, this.moisture);
this.cascade = new Cascade(this.water, this.field);
this.water.cascade = this.cascade;
```

**`src/render/WaterRenderer.js`** : le correctif de `buildRenderLevel()` de
§2.7 — ne pas dilater le niveau par-dessus une marche franche :

```js
// dans la boucle de dilatation, pour chaque voisin nb :
if (tmp[nb] > best && surf[c] - surf[nb] < 0.05) best = tmp[nb];
```

**Test de recette, en trois points :**

1. Creuser une fosse de 30 cm au bord d'un plateau, verser un seau sur le
   plateau. L'eau doit **franchir le bord et tomber**, pas s'accumuler contre
   la lèvre.
2. Vérifier en continu que
   `cascade.emitted === cascade.absorbed + cascade.inFlight +
   cascade.pendingVolume + cascade.lostOut`.
3. Remplir la fosse jusqu'à noyer le seuil : la cascade doit **disparaître
   progressivement** et redevenir un simple écoulement, sans discontinuité.

Un rendu minimal des parcelles suffit pour ce test (`THREE.Points`, 3 px,
blanc) — la nappe et l'embrun viennent à l'étape 6.

---

## 9. Bibliographie

**Champs de hauteur et eaux peu profondes**

- Kass, M., Miller, G. — *Rapid, Stable Fluid Dynamics for Computer Graphics*.
  SIGGRAPH 1990. (L'ancêtre du modèle de hauteur d'eau linéarisé.)
- Mei, X., Decaudin, P., Hu, B.-G. — *Fast Hydraulic Erosion Simulation and
  Visualization on GPU*. Pacific Graphics 2007. (Le modèle « pipe » actuellement
  implémenté, et son érosion.)
- Šťava, O., Beneš, B., Brisbin, M., Křivánek, J. — *Interactive Terrain
  Modeling Using Hydraulic Erosion*. SCA 2008.
- Chentanez, N., Müller, M. — *Real-time Simulation of Large Bodies of Water
  with Small Scale Details*. SCA 2010. (Champ de hauteur + particules pour les
  éclaboussures : l'architecture hybride de §2.)
- Chentanez, N., Müller, M. — *Real-time Eulerian Water Simulation Using a
  Restricted Tall Cell Grid*. SIGGRAPH 2011.
- Thürey, N., Müller-Fischer, M., Schirm, S., Gross, M. — *Real-time Breaking
  Waves for Shallow Water Simulations*. Pacific Graphics 2007. (Comment sortir
  du champ de hauteur ce qui déferle.)
- Holmberg, N., Wünsche, B. — *Efficient Modeling and Rendering of Turbulent
  Water over Natural Terrain*. GRAPHITE 2004. (Eau blanche sur un solveur en
  eaux peu profondes.)

**Schémas numériques pour Saint-Venant**

- Audusse, E., Bouchut, F., Bristeau, M.-O., Klein, R., Perthame, B. — *A Fast
  and Stable Well-Balanced Scheme with Hydrostatic Reconstruction for Shallow
  Water Flows*. SIAM J. Sci. Comput. 25(6), 2004. (§6.4 d.)
- Kurganov, A., Petrova, G. — *A Second-Order Well-Balanced Positivity
  Preserving Central-Upwind Scheme for the Saint-Venant System*. Comm. Math.
  Sci. 5(1), 2007. (La désingularisation de §6.4 a.)
- Toro, E. F. — *Shock-Capturing Methods for Free-Surface Shallow Flows*.
  Wiley, 2001. (HLL / HLLC.)
- Bridson, R. — *Fluid Simulation for Computer Graphics*, 2ᵉ éd. CRC Press,
  2015.

**Particules**

- Macklin, M., Müller, M. — *Position Based Fluids*. SIGGRAPH 2013.
- Ihmsen, M., Akinci, N., Akinci, G., Teschner, M. — *Unified Spray, Foam and
  Air Bubbles for Particle-Based Fluids*. The Visual Computer 28, 2012. (Les
  critères de génération d'eau blanche de §4.1.)
- van der Laan, W. J., Green, S., Sainz, M. — *Screen Space Fluid Rendering with
  Curvature Flow*. I3D 2009.
- Green, S. — *Screen Space Fluid Rendering for Games*. GDC 2010. (Alternative
  de rendu si les parcelles devenaient assez denses pour former une surface.)

**Advection de texture et flow maps**

- Neyret, F. — *Advected Textures*. SCA 2003. (Le principe de la régénération
  périodique décalée : la base théorique de §3.2.)
- Vlachos, A. — *Water Flow in Portal 2*. SIGGRAPH 2010, cours *Advances in
  Real-Time Rendering in 3D Graphics and Games*. (La version à deux couches et
  fondu triangulaire, avec le décalage de phase anti-battement.)
- van Hoesel, F. — *Tiling and Blending for Texture Advection* (« tiled
  directional flow »). Web3D 2011. (Variante à N couches avec rotation locale,
  utile si le fondu à deux couches montre ses limites en fort cisaillement.)
- Jeschke, S., Wojtan, C. — *Water Wave Packets*. SIGGRAPH 2017.
- Yuksel, C., House, D., Keyser, J. — *Wave Particles*. SIGGRAPH 2007.

**Hydraulique à surface libre**

- Chanson, H. — *The Hydraulics of Open Channel Flow: An Introduction*, 2ᵉ éd.
  Butterworth-Heinemann, 2004. (Froude, ressaut, déversoirs, entraînement
  d'air.)
- Rouse, H. — *Discharge Characteristics of the Free Overfall*. Civil
  Engineering 6, 1936. (La profondeur au bord d'une chute libre, ≈ 0,715 h_c.)
- Henderson, F. M. — *Open Channel Flow*. Macmillan, 1966. (Profondeurs
  conjuguées de Bélanger, ondes stationnaires, ondes de roulement.)

**Géomorphologie fluviale**

- Howard, A. D., Kerby, G. — *Channel Changes in Badlands*. GSA Bulletin 94,
  1983. (La loi de puissance de courant.)
- Whipple, K. X., Tucker, G. E. — *Dynamics of the Stream-Power River Incision
  Model*. J. Geophys. Res. 104(B8), 1999. (Les exposants m et n de §5.4.)
- Braun, J., Willett, S. D. — *A Very Efficient O(n), Implicit and Parallel
  Method to Solve the Stream Power Equation*. Geomorphology 180, 2013.
- Ikeda, S., Parker, G., Sawai, K. — *Bend Theory of River Meanders, Part 1:
  Linear Development*. J. Fluid Mech. 112, 1981. (Le mécanisme du méandre, dont
  §5.6 est un substitut 2D.)

**Documents internes du projet**

- `docs/RECHERCHE-OCEAN.md` — rendu de l'eau : réfraction d'écran, absorption,
  caustiques, jupe de volume, spéculaire. Strictement complémentaire de ce
  document ; §3.4 et §4.2 s'y branchent directement.
- `docs/RECHERCHE-PHYSIQUE-SABLE.md` — cohésion, angle de repos, tassement. Les
  seuils d'arrachement de §5.4 en dépendent entièrement.
- `docs/ARCHITECTURE.md` — ordre des passes de simulation par frame.
