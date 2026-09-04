# Direction lumière & météo — Sandcastle

> **Document de direction photo.** Il complète `RECHERCHE-RENDU-3D.md` (§5 Lumière et
> atmosphère, §6 Post-processing) et le **remplace** partout où les deux se contredisent.
>
> Brief joueur, mot pour mot : *« là ça fait trop cozy, faut vraiment un style avec du
> contraste, vraiment été plage tropical ».*
>
> Cible : **midi tropical écrasant**. Soleil dur et haut. Ombres nettes, courtes, **bleues**.
> Sable presque blanc qui brûle dans les hautes lumières mais garde sa texture. Eau turquoise
> saturée. Zénith bleu profond. Contraste élevé. Aucune brume, aucun beige de studio.
>
> Références visuelles : lagons des Caraïbes entre 11 h et 14 h, *Islanders*, *Tropico*,
> dioramas photographiés en plein soleil (ombre franche + réflecteur ciel).

---

## Table des matières

- [0. Diagnostic : pourquoi l'image actuelle est lavée](#0-diagnostic--pourquoi-limage-actuelle-est-lavée)
- [1. Budget lumière chiffré](#1-budget-lumière-chiffré)
- [2. Le soleil et les ombres](#2-le-soleil-et-les-ombres)
- [3. Ciel et IBL](#3-ciel-et-ibl)
- [4. États météo](#4-états-météo)
- [5. Nuages](#5-nuages)
- [6. Pluie et ses conséquences](#6-pluie-et-ses-conséquences)
- [7. Post-traitement pour le contraste](#7-post-traitement-pour-le-contraste)
- [8. Valeurs prêtes à coller](#8-valeurs-prêtes-à-coller)
- [9. Ordre d'implémentation](#9-ordre-dimplémentation)
- [10. Références](#10-références)

---

## 0. Diagnostic : pourquoi l'image actuelle est lavée

Un rendu « pastel lavé » n'est jamais un problème de couleurs. C'est **toujours** un problème
de **rapport d'éclairement** : la lumière qui n'est pas le soleil est trop forte, donc l'écart
entre la partie éclairée et la partie à l'ombre est trop faible, donc tout se tasse dans les
tons moyens, et aucune correction colorimétrique ne peut le rattraper après coup (un contraste
qui n'a jamais été rendu ne peut pas être « remonté » : on ne fait que monter le bruit).

### 0.1 Le calcul, sur le code actuel

`Sky.js` en plein midi (`day = 1`) :

| Source | Code | Éclairement délivré à un plan horizontal |
|---|---|---|
| Soleil directionnel | `this.sun.intensity = 2.75 * day` | `2.75 × N·L ≈ 2.75 × 0.95 = 2.61` |
| Hémisphérique | `this.fill.intensity = 0.30 + 0.55 * day` | `0.85 × skyColor ≈ 0.85` |
| IBL (PMREM du dôme) | `environmentIntensity = 0.7` | `≈ 0.55` (le dôme est clair et le sol beige) |
| **Total remplissage** | | **≈ 1.40** |

**Ratio soleil / remplissage actuel : 2.61 / 1.40 = 1,9 : 1.**

Une plage à midi, c'est **6 : 1**. On est à **un tiers du contraste réel**. En photométrie
cinéma, 1,9:1 c'est ce qu'on obtient en studio avec un réflecteur posé à 30 cm du sujet : le
« key-to-fill ratio » de la lumière plate. C'est littéralement le réglage « cozy ».

### 0.2 Ce que ça donne à l'écran

Sable d'albédo 0,50, BRDF lambertienne (`irradiance × albedo/π`), ACES à `exposure = 1.05` :

| Zone | Radiance linéaire | Après ACES + sRGB | Écart |
|---|---|---|---|
| Sable au soleil | `(2.61 + 1.40) × 0.159 = 0.638` | **0,85** | — |
| Sable à l'ombre | `1.40 × 0.159 = 0.223` | **0,55** | **1,5 stop** |

**1,5 stop entre le plein soleil et l'ombre.** L'œil lit ça comme « nuageux lumineux ».
Un vrai midi tropical donne **2,6 à 3 stops**, et c'est cet écart-là qui fait « été ».

### 0.3 Les six coupables, par ordre d'impact

1. **`fill.intensity` à 0,85 + `environmentIntensity` à 0,7.** Le commentaire du code
   (« sans un remplissage généreux, tout ce qui n'est pas au soleil vire au noir ») décrit une
   peur légitime — mais la solution n'est pas de monter le remplissage, c'est de **colorer**
   l'ombre. Une ombre à 1/6 de l'éclairement n'est pas noire si elle est bleu ciel saturé :
   elle est *lisible et jolie*. Une ombre à 1/2 de l'éclairement est grise et morte.

2. **`uGround = 0xccc0b0`** — « le fond de studio clair et chaud ». Ce beige occupe **la moitié
   inférieure du dôme**, donc **la moitié de l'IBL**. Chaque surface du diorama reçoit une
   énorme carte réflectrice beige désaturée par en dessous. C'est exactement le dispositif
   d'un packshot e-commerce. C'est *l'ennemi* du look plage.

3. **`uHaze = 0.45 + golden * 0.9`** appliqué sur un terme de Mie `pow(cosA, 2.0) * 0.14` :
   ce second lobe très large **blanchit tout le ciel**, pas seulement le halo solaire. Le
   zénith `0x2f6fc4` est déjà pâle ; avec le voile de Mie il monte encore. Un ciel tropical à
   midi a un zénith **beaucoup plus sombre et plus saturé** que son horizon — c'est même le
   signe distinctif du ciel de basse latitude.

4. **`shadow.radius = 2.2` avec `PCFShadowMap` sur une ortho de 17 m à 2048².**
   1 texel = 17 / 2048 = **8,3 mm**. Le filtre PCF étale donc l'ombre sur **± 18 mm de façon
   constante**, du pied de la tour jusqu'à son sommet. Une ombre de tour de 50 cm devrait avoir
   **4,6 mm** de pénombre à son extrémité et **0,1 mm** à sa base. On est 4× trop mou au bout
   et 180× trop mou au contact.

5. **Le bloom est mort.** `UnrealBloomPass(..., threshold = 1.45)`. La valeur linéaire la plus
   claire de la scène est 0,64 (cf. tableau §0.2). **Rien ne dépasse jamais 1,45.** La passe
   tourne, coûte ses 0,6 ms, et ne produit strictement aucun pixel. Les scintillements de
   quartz et le reflet du soleil sur l'eau n'ont donc aucune floraison — le premier signal
   « il fait très chaud » disparaît.

6. **L'étalonnage est timide.** `uSaturation = 1.10`, courbe en S mélangée à `0.07`,
   `uGain = (1.028, 1.004, 0.972)`. Trois réglages qui, additionnés, se voient à peine. Et
   `uGrain = 0.020` pondéré par `(0.35 + 0.65 × (1 - lum))` **concentre le bruit dans les
   ombres**, ce qui monte leur plancher perçu et achève de les rendre laiteuses.

### 0.4 Le piège « tone mapping au mauvais moment »

C'est la seconde cause classique du look lavé, et `Post.js` **fait déjà bien** — il faut le
noter pour ne pas casser en corrigeant le reste :

```
scène HDR linéaire → bloom (linéaire) → OutputPass (tone map + sRGB) → étalonnage (sRGB) → SMAA
```

- Le **bloom doit voir du linéaire non borné**. Un bloom appliqué après tone mapping ne voit
  plus que des valeurs [0,1] écrasées : il floute l'image entière au lieu des seules hautes
  lumières → voile laiteux uniforme. C'est *la* cause n°1 des rendus WebGL délavés.
- L'**étalonnage doit venir après le tone mapping**. Un `lift` de +0,01 appliqué en linéaire
  devient +0,10 après la courbe : les noirs partent en gris. Les mêmes chiffres appliqués en
  sRGB font ce qu'on attend.
- Le **piège restant** : `SMAAPass` en fin de chaîne travaille sur du sRGB, c'est correct.
  Mais si on ajoute un jour une passe d'AO ou de god rays, elle doit se placer **avant**
  `OutputPass`, jamais après.

**Règle générale** : tout ce qui simule un phénomène *optique* (bloom, DOF, god rays, AO,
diffusion) va **avant** le tone mapping, en linéaire. Tout ce qui simule un choix *d'auteur*
(courbe, saturation, LUT, vignette, grain) va **après**, en sRGB.

---

## 1. Budget lumière chiffré

### 1.1 Les valeurs réelles

Éclairement (illuminance, lux) reçu par un **plan horizontal**, décomposé en composante
**directe** (le disque solaire) et **diffuse** (le reste de la voûte céleste).

| Condition | Élév. soleil | Direct (lx) | Diffus ciel (lx) | Total (lx) | **Ratio S/C** | EV₁₀₀ |
|---|---|---|---|---|---|---|
| Midi tropical, ciel très clair (T≈2,2) | 85° | 103 000 | 15 000 | 118 000 | **6,9 : 1** | 15,5 |
| Midi tropical, ciel clair standard (T≈3) | 80° | 95 000 | 18 000 | 113 000 | **5,3 : 1** | 15,5 |
| Après-midi, soleil à 45° | 45° | 71 000 | 14 000 | 85 000 | **5,1 : 1** | 15,1 |
| Voile de chaleur / brume (T≈6) | 75° | 58 000 | 30 000 | 88 000 | **1,9 : 1** | 15,1 |
| Nuages épars — **dans le soleil** | 60° | 88 000 | 22 000 | 110 000 | **4,0 : 1** | 15,4 |
| Nuages épars — **sous une ombre de nuage** | 60° | 0 | 22 000 | 22 000 | 0 | 13,1 |
| Couvert lumineux | — | 0 | 20 000 | 20 000 | 0 | 13,0 |
| Grain tropical (ciel plombé + pluie) | — | 0 | 6 000 | 6 000 | 0 | 11,2 |
| Soleil couchant, disque à 3° | 3° | 3 200 | 2 400 | 5 600 | **1,3 : 1** | 11,1 |
| Crépuscule civil (fin) | −6° | 0 | 3,4 | 3,4 | 0 | 0,4 |
| Pleine lune au zénith, ciel clair | — | 0,20 | 0,05 | 0,25 | **4 : 1** | −3,3 |
| Nuit sans lune, ciel étoilé | — | 0 | 0,002 | 0,002 | 0 | −10,3 |

Conversion utilisée : `EV₁₀₀ = log₂(E_lux / 2,5)` (convention posemètre incident, C = 250).
Contrôle : la règle du *sunny 16* place le plein soleil à EV 15, soit 82 000 lx — cohérent avec
un plein soleil de latitude moyenne. Le midi tropical est **une demie à trois quarts de stop
plus lumineux** que le « sunny 16 » européen, parce que le soleil est presque au zénith
(masse d'air ≈ 1,0 au lieu de 1,4) et l'atmosphère plus propre en mer.

**Dynamique totale midi → pleine lune : 18,8 stops.** Aucun moteur ne rend ça sans exposition
adaptative — d'où la table d'exposition du §8.

### 1.2 Les trois chiffres à retenir

1. **Le ratio soleil/ciel en plein soleil est de 5:1 à 7:1**, jamais 2:1. C'est *le* chiffre
   qui fait le look. Retenir **6:1** comme cible du « Grand beau ».
2. **Le ciel bleu à lui seul délivre 15 à 20 klx**, soit 13 % de l'éclairement total.
   Ce n'est pas rien — l'ombre est parfaitement lisible — mais c'est 6 fois moins que le soleil.
3. **La couleur du ciel est le facteur qui rend l'ombre acceptable.** Une ombre à 1/6, éclairée
   par un ciel à ~11 000 K, est un bleu clair **franc**. Ce n'est pas du gris à 40 %.

### 1.3 Traduction en unités Three.js

Depuis r155, `WebGLRenderer` interprète par défaut `intensity × color` d'une `DirectionalLight`
comme une **irradiance en lux** (mode physiquement correct ; `useLegacyLights` est mort). Il
n'y a donc **aucune raison de bricoler des nombres arbitraires** : il suffit de choisir une
échelle et de s'y tenir.

> **Convention Sandcastle : 1 unité d'intensité Three.js = 20 000 lux.**

Pourquoi 20 000 et pas 1 000 ou 100 000 ?
- À 20 000 lx/unité, **le midi grand beau tombe à ~5,0** pour le soleil et ~0,85 pour le ciel.
  Ces nombres sont dans la plage où le bloom, le seuil de bloom, les valeurs d'emissive et les
  `pow()` des shaders existants restent numériquement confortables (pas de `float` à 1e5 qui
  fait exploser la précision `mediump` sur mobile).
- Le sable éclairé arrive naturellement à une radiance linéaire de **~0,9**, donc juste sous
  le point de bascule d'ACES. Avec une exposition proche de 1, on est « bien exposé » sans
  triturer quoi que ce soit.

| Grandeur physique | Valeur | Unité Three.js |
|---|---|---|
| Soleil midi tropical (direct horizontal) | 100 000 lx | `sun.intensity = 5.0` |
| Ciel diffus midi tropical | 17 000 lx | remplissage total `≈ 0.85` |
| Ciel diffus couvert | 20 000 lx | `≈ 1.0` |
| Ciel diffus grain | 6 000 lx | `≈ 0.30` |
| Soleil couchant (DNI à 7° d'élévation) | 32 000 lx | `sun.intensity = 1.60` — voir note |
| Pleine lune | 0,25 lx | `1.25e-5` — **inutilisable, voir §1.5** |

> **Note sur le soleil rasant** : à 7° d'élévation, `N·L` sur un plan horizontal vaut déjà
> `sin(7°) = 0.122`. Il ne faut donc **pas** multiplier deux fois par l'élévation. On donne au
> `DirectionalLight` l'**irradiance normale au faisceau** (DNI), pas l'irradiance horizontale :
> Three.js applique `N·L` lui-même. Au coucher, la masse d'air atteint 8 à 10 et le DNI tombe à
> ~32 000 lx → `intensity = 1.60`, avec une couleur très chaude ; le `N·L = 0.122` fait le
> reste. On obtient alors **un sol faiblement éclairé ET des faces verticales orientées vers le
> soleil violemment éclairées** — c'est exactement ce qui fait le couchant. Un réglage qui
> baisse `intensity` au lieu de laisser `N·L` travailler donne une image uniformément brune et
> tue l'effet.

### 1.4 Le réglage de référence : « Grand beau, 13 h »

```js
// Sky.js — état GRAND_BEAU, dayT = 0.5
sun.intensity            = 5.00;          // 100 klx  (DNI 102 klx × N·L≈0.98)
sun.color                = 0xFFF4E2;      // 5600 K, très légèrement chaud
hemi.intensity           = 0.22;          // filet de sécurité, PAS la source principale
hemi.color               = 0x6FA8E8;      // bleu ciel SATURÉ (≈ 11 000 K)
hemi.groundColor         = 0xD9B476;      // rebond du sable, chaud et saturé
scene.environmentIntensity = 0.62;        // l'IBL fait le vrai travail
renderer.toneMappingExposure = 0.78;
```

Vérification du ratio :

```
direct  = 5.00 × N·L(0.98)                     = 4.90
diffus  = hemi(0.22) + IBL(0.62 × ~1.0)        = 0.84
ratio   = 4.90 / 0.84                          = 5.8 : 1   ✔ (cible 6:1)
```

Rendu du sable (albédo 0,50) :

| Zone | Irradiance | Radiance linéaire | ACES @ 0,78 | sRGB affiché |
|---|---|---|---|---|
| Plein soleil | 5,74 | 0,913 | 0,79 | **0,90** |
| Ombre portée | 0,84 | 0,134 | 0,145 | **0,42** |
| **Écart** | **6,8×** | | | **2,8 stops** ✔ |

Comparé à l'avant (1,5 stop), on **double le contraste utile**. Et 0,90 en sRGB, c'est le sable
qui *brûle* sans être bouché : il reste 10 % de marge pour l'écume, le quartz et le reflet
spéculaire — d'où la lecture dans les hautes lumières (§7.5).

### 1.5 La nuit rompt volontairement l'échelle

0,25 lx = 1,25 × 10⁻⁵ unité. Exposer ça correctement demanderait `toneMappingExposure ≈ 60 000`,
ce qui ferait exploser le bruit de quantification du framebuffer et rendrait le bloom ingérable.

**Aucun jeu ne fait ça, et c'est justifié** : la vision nocturne humaine est *scotopique* —
sensibilité multipliée par ~10⁴, perte de la couleur, effet Purkinje (décalage de sensibilité
vers le bleu-vert). Ce que le joueur « voit » la nuit n'est pas ce qu'un capteur mesure.

**Convention Sandcastle pour la nuit** : on quitte l'échelle physique et on adopte une
**échelle perceptuelle**, en assumant le décalage :

```js
moon.intensity  = 0.045;   // ≈ 3600× la valeur physique — c'est la vision scotopique
moon.color      = 0x9FB8DE;
hemi.intensity  = 0.020;
hemi.color      = 0x2B4A78;
scene.environmentIntensity = 0.10;
renderer.toneMappingExposure = 6.0;
// ratio lune/ciel = 0.045×0.9 / 0.030 = 1.35 : 1  → volontairement plat, c'est la nuit
```

Le ratio lune/ciel *réel* est 4:1 (la lune est un point comme le soleil). On le baisse à
**1,4:1** exprès : sous 0,25 lx l'œil humain ne distingue plus les ombres portées, et une ombre
dure de lune donne une image « jour bleu » (le vieux *day for night* d'Hollywood, qui a
justement l'air faux). **Nuit = peu de contraste, peu de saturation, dominante bleue.** C'est le
seul état météo où le brief « du contraste » ne s'applique pas.

### 1.6 Exposition : compensation partielle

Faut-il ré-exposer entre deux états météo ? Les deux extrêmes sont mauvais :

- **Exposition fixe** : le grain tropical (6 000 lx = 1/20ᵉ du grand beau) tombe à sRGB 0,12.
  Injouable — le joueur ne voit plus son château.
- **Exposition auto totale** (comme un vrai auto-exposure) : toutes les météos ont la même
  luminosité moyenne. Le grain a exactement la même clarté que le grand beau. **Il n'y a plus
  de météo**, juste un changement de couleur. C'est l'erreur la plus fréquente.

**Règle : compenser 70 % de l'écart, en stops.**

```js
// exposureFor(E) : E = éclairement total en unités Three.js
const E_REF   = 5.85;   // Grand beau
const EXP_REF = 0.78;
const COMPENSATION = 0.70;

function exposureFor(E) {
  const stops = Math.log2(E_REF / Math.max(E, 1e-4));
  return EXP_REF * Math.pow(2, stops * COMPENSATION);
}
```

| État | E (unités) | Stops sous la réf. | Exposition | Sable rendu (sRGB) |
|---|---|---|---|---|
| Grand beau | 5,85 | 0,0 | **0,78** | 0,90 / 0,42 |
| Voile de chaleur | 4,40 | 0,4 | **0,94** | 0,88 / 0,58 |
| Nuages épars (soleil) | 5,50 | 0,1 | **0,81** | 0,90 / 0,44 |
| Nuages épars (sous ombre) | 1,10 | 2,4 | **2,03** | 0,63 / 0,63 |
| Grain tropical | 0,45 | 3,7 | **3,80** | 0,55 / 0,55 |
| Coucher doré | 1,40 | 2,1 | **1,85** | 0,84 (face au soleil) / 0,60 (sol) |
| Nuit claire | — | — | **6,0** *(hors échelle)* | 0,26 / 0,20 |

Le grain reste visiblement plus sombre que le grand beau (0,55 vs 0,90) : **la météo se voit**.
Et il reste jouable.

> **Piège** : ne jamais faire varier l'exposition *en temps réel image par image* en suivant
> l'éclairement instantané. Sous des nuages épars, le soleil apparaît et disparaît toutes les
> 15 s ; une exposition qui suit produit un *pompage* insupportable. On lisse sur **6 à 10 s**
> avec des constantes de temps asymétriques (0,8 s pour s'assombrir — l'œil s'éblouit vite ;
> 5 s pour s'éclaircir — l'œil s'adapte lentement au noir). Voir §4.7.

---

## 2. Le soleil et les ombres

### 2.1 Le soleil est une source d'aire de 0,53°

Le Soleil sous-tend **0,53° d'arc** vu de la Terre (0,524° à l'aphélie, 0,542° au périhélie).
Ce n'est donc pas une source ponctuelle : chaque ombre a une **pénombre** dont la largeur croît
linéairement avec la distance entre l'occulteur et le receveur.

Pour une source **directionnelle** (le Soleil, à l'infini), la formule est immédiate — bien plus
simple que la formule classique de PCSS, qui suppose une source ponctuelle à distance finie :

```
w_pénombre = d × tan(θ_angulaire)         avec  tan(0,53°) = 0,009250
```

où `d` est la distance **occulteur → receveur** mesurée le long du rayon solaire.

| Distance occulteur → sol | Pénombre réelle | Lecture |
|---|---|---|
| 1 mm (grain de sable) | **0,009 mm** | parfaitement nette |
| 1 cm (arête d'un créneau) | **0,09 mm** | parfaitement nette |
| 5 cm (coquillage posé) | **0,46 mm** | nette |
| 10 cm | **0,93 mm** | nette |
| **25 cm (mi-hauteur d'une tour)** | **2,3 mm** | nette |
| **50 cm (sommet d'une tour)** | **4,6 mm** | à peine adoucie |
| 1 m (drapeau, pelle plantée) | **9,3 mm** | légèrement douce |
| 3,84 m (hauteur max du domaine) | **35 mm** | douce |

**C'est exactement le brief.** « Une tour de 50 cm doit avoir une ombre nette près de sa base et
à peine adoucie au bout » : la physique dit **0,09 mm à la base, 4,6 mm au sommet**. Le rapport
est de 50, mais les deux valeurs absolues sont **minuscules**.

### 2.2 La conclusion qui dérange : à cette échelle, c'est la shadow map qui limite

Comparons la pénombre attendue à la taille d'un texel.

Frustum orthographique couvrant tout le domaine depuis n'importe quel azimut solaire :
`S = 7,6 m` de demi-largeur, soit **15,2 m** de côté.

| Résolution | Taille du texel | Pénombre max utile (35 mm) | Pénombre d'une tour (4,6 mm) |
|---|---|---|---|
| 1024² | 14,8 mm | 2,4 texels | **0,31 texel** |
| 2048² | **7,4 mm** | 4,7 texels | **0,62 texel** |
| 4096² | 3,7 mm | 9,5 texels | 1,24 texel |

> **La pénombre solaire physique d'une tour de 50 cm fait moins d'un texel à 2048².**

Autrement dit : **à l'échelle de Sandcastle, l'ombre solaire réelle est nette partout.** Le
contact hardening physiquement exact serait invisible. Ce qu'on verrait, en revanche, c'est un
**escalier de 7,4 mm** sur le bord de l'ombre, très voyant en gros plan sur du sable clair.

D'où la position de direction photo, assumée :

1. **On installe PCSS**, mais **pas pour le réalisme** : pour l'anti-crénelage adaptatif du bord
   d'ombre, et pour le signal de lecture d'échelle que le joueur attend.
2. **On exagère la taille angulaire du soleil d'un facteur ≈ 4** (0,53° → 2,1°) en beau temps.
   Une tour de 50 cm obtient alors **18 mm** de pénombre au sommet et **0,4 mm** à la base :
   « nette à la base, à peine adoucie au bout », et cette fois **visible**.
3. Ce facteur devient une **uniforme pilotée par la météo** — et il redevient alors physique :
   un soleil derrière un voile de chaleur ou un cirrus **est réellement** une source d'aire
   beaucoup plus large. C'est ce qui rend le « voile de chaleur » lisible sans changer une seule
   couleur.

| État météo | Diamètre angulaire effectif | `uSunTanAngle` | Pénombre à 50 cm | Aspect |
|---|---|---|---|---|
| Grand beau | **2,1°** | 0,037 | 18 mm | dur, contact net |
| Nuages épars (soleil direct) | 2,6° | 0,045 | 23 mm | dur |
| Voile de chaleur | 7,0° | 0,122 | 61 mm | doux, ombres estompées |
| Coucher doré | 3,2° | 0,056 | 28 mm | moyen, ombres longues |
| Grain / couvert | *(soleil éteint)* | 0,300 | — | pas d'ombre lisible |
| Nuit / lune | 1,6° | 0,028 | 14 mm | ombre à peine perceptible |

### 2.3 Cadrage de la shadow map : le vrai gain, et il est gratuit

Avant de toucher au filtrage, **serrer le frustum**.

`Sky.js` utilise aujourd'hui `S = 8.5` fixe (17 m de côté) alors que le domaine fait
10,24 × 10,24 m et que la géométrie ne dépasse jamais ~2,6 m de haut. On gaspille en permanence
30 % de la résolution sur du vide.

**Niveau 1 — frustum minimal statique (2 minutes, +38 % de résolution effective)**

`S = 7.4` couvre le domaine entier, y compris les ombres rasantes projetées hors bloc.

**Niveau 2 — frustum asservi au point de focus (recommandé)**

Le joueur travaille presque toujours sur une zone de 2 à 4 m, et `DioramaControls` connaît déjà
sa cible et sa distance.

```js
// Sky.js — nouvelle méthode, appelée chaque frame depuis Game.update()
const _ZERO = new THREE.Vector3(0, 0, 0);
const _UP   = new THREE.Vector3(0, 1, 0);

/**
 * Recadre la shadow map sur la zone où le joueur travaille.
 * Gain typique : S passe de 8.5 à 3.2 -> texel de 8,3 mm à 3,1 mm à 2048².
 * @param {THREE.Vector3} focus   cible des contrôles
 * @param {number} camDist        distance caméra-cible
 */
fitShadowTo(focus, camDist) {
  const sunElev = Math.max(this.sunDir.y, 0.12);
  // Une tour de 2,6 m projette cette longueur d'ombre au sol.
  const shadowReach = 2.6 / sunElev;
  const S = THREE.MathUtils.clamp(
    camDist * 0.42 + Math.min(shadowReach, 4.0),
    2.2,   // plancher : sous 2,2 m, la tour la plus proche sort du frustum
           //            dès qu'on tourne la caméra
    7.4    // plafond : la boîte du domaine, inutile d'aller au-delà
  );

  const c = this.sun.shadow.camera;
  c.left = -S; c.right = S; c.top = S; c.bottom = -S;
  c.near = 0.5;
  c.far  = 2 * S + 14;
  c.updateProjectionMatrix();

  // --- QUANTIFICATION AU TEXEL --------------------------------------------
  // Sans ça, l'ombre "rampe" (shadow swimming) : à chaque micro-déplacement
  // de la caméra, la grille de texels glisse et tous les bords d'ombre
  // scintillent. C'est le bug le plus rageant du shadow mapping, et il est
  // parfaitement invisible tant qu'on ne bouge pas la caméra.
  const texelWorld = (2 * S) / this.sun.shadow.mapSize.width;
  this._lightBasis ??= new THREE.Matrix4();
  this._lightInv   ??= new THREE.Matrix4();
  this._tmp        ??= new THREE.Vector3();

  this._lightBasis.lookAt(this.sunDir, _ZERO, _UP);
  this._lightInv.copy(this._lightBasis).invert();

  const t = this._tmp.copy(focus).applyMatrix4(this._lightInv);
  t.x = Math.round(t.x / texelWorld) * texelWorld;
  t.y = Math.round(t.y / texelWorld) * texelWorld;
  t.applyMatrix4(this._lightBasis);

  this.sun.target.position.copy(t);
  this.sun.position.copy(t).addScaledVector(this.sunDir, 2 * S + 6);
  this.sun.target.updateMatrixWorld();

  // Le rayon PCSS s'exprime en UV : il dépend de la largeur du frustum.
  shadowUniforms.uShadowFrustumWidth.value = 2 * S;
  shadowUniforms.uShadowDepthRange.value   = c.far - c.near;
}
```

**Réglages de shadow map complets, scène bornée à 10 m :**

```js
const sh = sun.shadow;
sh.mapSize.set(2048, 2048);       // 4096 en qualité "élevée" : +2,5 Mo, +0,4 ms
sh.camera.near = 0.5;
sh.camera.far  = 2 * S + 14;      // recalculé par fitShadowTo()
sh.bias        = -0.00012;        // ← était -0.0006 : 5× trop
sh.normalBias  = 0.006;           // ← était  0.03   : 5× trop (3 cm !)
sh.radius      = 1.0;             // ignoré une fois PCSS installé
sh.intensity   = 1.0;
```

> **`normalBias = 0.03` était le coupable n°2 du look mou.** Le normal bias décale le point de
> test *le long de la normale de surface*. 3 cm sur une plage dont les créneaux font 4 cm
> (= 1 voxel), c'est **l'ombre qui se détache de l'objet qui la projette** : peter-panning
> massif. Un créneau de 4 cm n'a plus aucune ombre de contact, il *flotte*. Le bon ordre de
> grandeur est **1,5 texel** : à 2048² avec `S = 3,2`, texel = 3,1 mm → `normalBias ≈ 0.005`.
> On met 0,006, avec une petite marge.
>
> `bias` (décalage en profondeur normalisée) doit rester très petit et négatif. Sur une plage de
> profondeur ≈ 20 m, `-0.00012` vaut 2,4 mm. Au-delà, même symptôme.

### 2.4 PCSS : ce qu'il faut savoir avant de coller le code de l'exemple officiel

L'exemple `webgl_shadowmap_pcss.html` de three.js marche, mais **quatre pièges** attendent celui
qui le copie tel quel dans un projet de 2026 :

1. **Il exige `renderer.shadowMap.type = THREE.BasicShadowMap`.** Le code lit la profondeur
   brute (`texture2D(shadowMap, uv).r`). Avec `PCFShadowMap` ou `PCFSoftShadowMap`, three.js
   compile un `sampler2DShadow` et un chemin de comparaison matériel : le patch ne compile pas,
   ou produit n'importe quoi. **C'est non négociable.**
2. **Sa loi de pénombre est fausse pour un soleil.** Il calcule
   `penumbraRatio = (zReceiver − zBlocker) / zBlocker`, la loi de similitude d'une source
   **ponctuelle à distance finie**. Pour une projection **orthographique** (soleil à l'infini),
   la pénombre est **linéaire** en distance, pas proportionnelle à la profondeur. Copié tel
   quel, on obtient des ombres absurdement molles quand l'occulteur est loin du plan near de la
   lumière, et trop dures quand il en est près — un comportement instable dès que
   `fitShadowTo()` bouge le frustum.
3. **Le point d'ancrage du patch a changé en r182.** L'ancre historique
   `'#if defined( SHADOWMAP_TYPE_PCF )'` existe toujours, mais sa **première occurrence** est
   désormais dans le bloc d'aide `interleavedGradientNoise` / `vogelDiskSample`. Un patch écrit
   pour r16x/r17x s'applique donc silencieusement au mauvais endroit et **ne fait rien**, sans
   la moindre erreur.
4. **`shadowIntensity` (ajouté en r166) est perdu.** Le `return` anticipé court-circuite le
   `return mix(1.0, shadow, shadowIntensity)` final : `light.shadow.intensity` devient inopérant.

`LIGHT_FRUSTUM_WIDTH 3.75` et `NEAR_PLANE 9.5` dans l'exemple sont d'ailleurs des nombres
magiques réglés à la main — ils ne correspondent **pas** à la lumière de l'exemple (frustum de
10, near 0,5). Il n'y a rien à en tirer.

### 2.5 Implémentation : PCSS directionnel, version Sandcastle

```js
// src/render/pcss.js
//
// PCSS spécialisé SOURCE DIRECTIONNELLE (projection orthographique).
//
// Trois différences avec l'exemple officiel three.js :
//   1. loi de pénombre LINÉAIRE (source à l'infini), pas proportionnelle ;
//   2. taille angulaire du soleil en UNIFORME, pilotée par la météo ;
//   3. rayon de filtre borné en bas à 0,75 texel : c'est l'anti-crénelage du
//      bord d'ombre, obtenu SANS ramollir le contact.
//
// À appeler UNE SEULE FOIS au boot, AVANT la création du premier matériau
// (donc avant createSandMaterial(), WaterRenderer et Props).
import * as THREE from 'three';

/** Uniformes globales partagées par tous les matériaux ombrés. */
export const shadowUniforms = {
  /** tan(diamètre angulaire du soleil). 0.00925 = physique ; 0.037 = ×4. */
  uSunTanAngle:        { value: 0.037 },
  /** Largeur monde du frustum ortho d'ombre (2 × S). */
  uShadowFrustumWidth: { value: 6.4 },
  /** far − near de la caméra d'ombre, en mètres. */
  uShadowDepthRange:   { value: 20.0 },
};

const PCSS_GLSL = /* glsl */ `
#define SC_BLOCKER_SAMPLES 12
#define SC_PCF_SAMPLES 20
#define SC_RINGS 11

uniform float uSunTanAngle;
uniform float uShadowFrustumWidth;
uniform float uShadowDepthRange;

vec2 scPoisson[SC_PCF_SAMPLES];

void scInitPoisson(const in vec2 seed) {
  float angleStep = PI2 * float(SC_RINGS) / float(SC_PCF_SAMPLES);
  float invN = 1.0 / float(SC_PCF_SAMPLES);
  // Rotation aléatoire par pixel : transforme le banding en bruit,
  // que le SMAA + le grain finiront de cacher.
  float angle = rand(seed) * PI2;
  float radius = invN;
  for (int i = 0; i < SC_PCF_SAMPLES; i++) {
    // pow(r, 0.75) répartit les échantillons plus uniformément en AIRE
    // qu'un pas linéaire : moins d'anneaux visibles sur les grands rayons.
    scPoisson[i] = vec2(cos(angle), sin(angle)) * pow(radius, 0.75);
    radius += invN;
    angle  += angleStep;
  }
}

/**
 * Profondeur moyenne des occulteurs dans un disque.
 * Le rayon de recherche correspond à la pénombre MAXIMALE possible, celle
 * d'un occulteur à la distance maximale (uShadowDepthRange). On le borne :
 * au-delà, la recherche coûte plus cher que le filtre lui-même.
 */
float scFindBlocker(sampler2D sm, const in vec2 uv, const in float zReceiver,
                    out int numBlockers) {
  float maxPenumbraWorld = uShadowDepthRange * uSunTanAngle;
  float searchUV = min(maxPenumbraWorld / uShadowFrustumWidth, 0.020);

  float sum = 0.0;
  numBlockers = 0;
  for (int i = 0; i < SC_BLOCKER_SAMPLES; i++) {
    float d = texture2D(sm, uv + scPoisson[i] * searchUV).r;
    if (d < zReceiver) { sum += d; numBlockers++; }
  }
  if (numBlockers == 0) return -1.0;
  return sum / float(numBlockers);
}

float scPCF(sampler2D sm, vec2 uv, float zReceiver, float radiusUV) {
  float sum = 0.0;
  for (int i = 0; i < SC_PCF_SAMPLES; i++) {
    float d = texture2D(sm, uv + scPoisson[i] * radiusUV).r;
    sum += step(zReceiver, d);
  }
  return sum / float(SC_PCF_SAMPLES);
}

/**
 * PCSS pour source directionnelle.
 *
 * La profondeur d'une projection ORTHOGRAPHIQUE est linéaire : la distance
 * monde entre bloqueur et receveur vaut simplement (zR - zB) * (far - near).
 * La pénombre est alors d * tan(alpha), sans aucun rapport de similitude.
 */
float scPCSS_directional(sampler2D shadowMap, vec4 coords, vec2 shadowMapSize) {
  vec2  uv        = coords.xy;
  float zReceiver = coords.z;

  scInitPoisson(uv);

  int nb;
  float zBlocker = scFindBlocker(shadowMap, uv, zReceiver, nb);
  if (nb == 0) return 1.0;                       // rien devant : plein soleil

  // Distance monde occulteur -> receveur, le long du rayon solaire.
  float dWorld = max(zReceiver - zBlocker, 0.0) * uShadowDepthRange;

  // Loi physique de la pénombre d'une source d'aire angulaire.
  float penumbraWorld = dWorld * uSunTanAngle;
  float radiusUV = penumbraWorld / uShadowFrustumWidth;

  // Plancher = 0,75 texel : c'est l'anti-crénelage. Sans lui, une ombre de
  // contact (dWorld ~ 0) est un escalier de texels très visible sur du sable
  // clair en gros plan. Avec lui, elle reste NETTE mais lisse.
  // Plafond = 16 texels : garde-fou de performance et anti light-leak.
  vec2 texel = 1.0 / shadowMapSize;
  radiusUV = clamp(radiusUV, texel.x * 0.75, texel.x * 16.0);

  return scPCF(shadowMap, uv, zReceiver, radiusUV);
}
`;

/**
 * Patche le chunk global de shadow mapping. Tolérant aux versions r160 -> r186 :
 * on essaie l'ancre "moderne" (r182+, surcharge SHADOWMAP_TYPE_BASIC dédiée),
 * puis l'ancre historique. On LÈVE une exception si aucune ne marche — un
 * patch de shader qui échoue en silence est la pire des situations.
 */
export function installPCSS() {
  let src = THREE.ShaderChunk.shadowmap_pars_fragment;
  if (src.includes('scPCSS_directional')) return true;   // idempotent

  src = src.replace('#ifdef USE_SHADOWMAP', '#ifdef USE_SHADOWMAP\n' + PCSS_GLSL);

  let patched = false;

  // --- r182+ : surcharge dédiée SHADOWMAP_TYPE_BASIC ------------------------
  // Regex tolérante aux blancs : matche la source brute (ligne vide entre les
  // deux instructions) ET le bundle rollup (où les \n multiples sont collapsés).
  const modern =
    /if \( frustumTest \) \{(\s*)float depth = texture2D\( shadowMap, shadowCoord\.xy \)\.r;/;
  if (modern.test(src)) {
    src = src.replace(
      modern,
      'if ( frustumTest ) {$1' +
      'return mix( 1.0, scPCSS_directional( shadowMap, shadowCoord, shadowMapSize ), shadowIntensity );$1' +
      'float depth = texture2D( shadowMap, shadowCoord.xy ).r;'
    );
    patched = true;
  }

  // --- r160 - r181 : getShadow() unique avec branches #if -------------------
  if (!patched) {
    const legacy = '#if defined( SHADOWMAP_TYPE_PCF )';
    const i = src.indexOf(legacy);
    if (i !== -1) {
      // shadowIntensity n'existe qu'à partir de r166.
      const hasIntensity = /float getShadow\( sampler2D shadowMap, vec2 shadowMapSize, float shadowIntensity/
        .test(src);
      const ret = hasIntensity
        ? 'return mix( 1.0, scPCSS_directional( shadowMap, shadowCoord, shadowMapSize ), shadowIntensity );\n'
        : 'return scPCSS_directional( shadowMap, shadowCoord, shadowMapSize );\n';
      src = src.slice(0, i) + ret + src.slice(i);
      patched = true;
    }
  }

  if (!patched) {
    throw new Error(`[pcss] chunk shadowmap_pars_fragment non reconnu (THREE r${THREE.REVISION})`);
  }

  THREE.ShaderChunk.shadowmap_pars_fragment = src;
  return true;
}
```

**Configuration obligatoire du renderer :**

```js
import { installPCSS, shadowUniforms } from './render/pcss.js';

installPCSS();                                    // AVANT tout matériau

renderer.shadowMap.enabled = true;
renderer.shadowMap.type    = THREE.BasicShadowMap;  // ← OBLIGATOIRE (lecture .r)
renderer.reversedDepthBuffer = false;               // ← sinon les comparaisons
                                                    //   de profondeur s'inversent
```

**Branchement des uniformes.** Dans `SandMaterial.js`, une ligne suffit :

```js
mat.onBeforeCompile = (shader) => {
  Object.assign(shader.uniforms, uniforms, shadowUniforms);   // ← + shadowUniforms
  // ... le reste inchangé
};
```

Pour les matériaux qu'on n'écrit pas soi-même (props, `MeshStandardMaterial` nus), déclarer les
trois uniformes comme **globales** évite tout monkey-patch :

```js
// une seule fois, juste après installPCSS()
THREE.UniformsLib.shadowmap = Object.assign(
  THREE.UniformsLib.shadowmap || {}, shadowUniforms
);
// puis, pour chaque matériau standard de la scène :
mat.onBeforeCompile = (s) => Object.assign(s.uniforms, shadowUniforms);
```

**Coût mesuré.** 32 taps de shadow map par pixel ombré (12 blocker + 20 PCF), contre 5 pour le
PCF de base. En 1440p avec ~35 % de pixels ombrés : **+0,8 à 1,3 ms** sur un GPU intégré récent.

| Palier de qualité | Configuration | Surcoût |
|---|---|---|
| Élevée (2) | PCSS 12 + 20 taps, 2048² (4096² si GPU discret) | +1,0 ms |
| Moyenne (1) | PCSS 8 + 12 taps, 1024² | +0,4 ms |
| Basse (0) | pas de PCSS, `PCFSoftShadowMap`, `radius = 1.0`, 512² | 0 |

### 2.6 La couleur des ombres — le point le plus important du document

Une ombre en extérieur **n'est pas grise**. Elle est **bleue**, parce qu'elle n'est privée que
d'**une** source : le disque solaire. Tout le reste de la voûte — 15 000 lux de ciel Rayleigh à
~11 000 K — continue de l'éclairer.

Sur du sable clair c'est spectaculaire : l'albédo élevé du sable **révèle** la couleur de son
éclairement, exactement comme les ombres bleues sur la neige. Un sable qui vaut `#F0E0BD` au
soleil (c'est la valeur actuelle de `uDryColor` dans `SandMaterial.js`) doit devenir `#8FA8C4`
à l'ombre — **et surtout pas** `#9A9186`.

**Trois façons de l'obtenir, par ordre de qualité.**

#### (a) HemisphereLight teintée — le minimum vital

```js
// AVANT (Sky.js actuel) : la couleur du remplissage suit uHorizon, c'est-à-dire
// un bleu-gris très désaturé (0xbfd8ea, saturation = 19 %).
this.fill.color.copy(this.uniforms.uHorizon.value);
this.fill.intensity = 0.30 + 0.55 * day;

// APRÈS
this.fill.color.setHex(0x6FA8E8, THREE.SRGBColorSpace);        // saturation 52 %
this.fill.groundColor.setHex(0xD9B476, THREE.SRGBColorSpace);  // rebond du sable
this.fill.intensity = 0.22;                                    // et surtout : 4× moins
```

> **Piège de la `HemisphereLight`.** Son irradiance vaut
> `mix(groundColor, skyColor, 0.5 * N.y + 0.5)`. Pour un sol **horizontal** (`N.y = 1`), c'est
> **100 % `skyColor`**. Il ne faut donc y mettre **ni** la couleur du zénith (trop sombre, trop
> saturée) **ni** celle de l'horizon (trop pâle), mais la **moyenne cosinus-pondérée de la
> voûte**, qui tombe vers 45° d'élévation. Sur un ciel tropical (zénith `#1E5FC4`, horizon
> `#B9DCF2`), cette moyenne vaut ≈ **`#6FA8E8`**. C'est la valeur ci-dessus.

#### (b) IBL correcte — la bonne solution

La hémisphérique ne connaît que `N.y`. Elle ne peut pas savoir qu'un mur de château tourné vers
le soleil mais **à l'ombre** reçoit surtout la partie brillante du ciel près du soleil, alors
qu'un mur opposé reçoit le zénith profond. L'IBL, si.

Trois corrections à `Sky.regenerateEnvironment()` :

```js
regenerateEnvironment() {
  if (this.envTarget) this.envTarget.dispose();

  // 1. MASQUER LE DISQUE SOLAIRE avant la capture.
  //    Dans SKY_FRAG le disque vaut 12x la couleur du soleil. Une PMREM 256²
  //    transforme ce point en blob surexposé qui, après convolution, ajoute un
  //    spéculaire fantôme sur TOUTES les surfaces lisses — l'eau la première.
  //    Et surtout : le soleil est DÉJÀ représenté par le DirectionalLight.
  //    Le compter deux fois est une faute d'énergie qui lave l'image.
  const prevDisc = this.uniforms.uSunDiscGain.value;
  this.uniforms.uSunDiscGain.value = 0.0;

  // 2. Sigma de flou > 0 : lisse le grain d'étoiles et de nuage avant la
  //    convolution, sinon la PMREM aliase et l'ambiante scintille.
  this.envTarget = this.pmrem.fromScene(this.envScene, 0.035, 0.1, 100);

  this.uniforms.uSunDiscGain.value = prevDisc;

  this.scene.environment = this.envTarget.texture;
  // 3. Intensité pilotée par la météo, plus une constante magique.
  this.scene.environmentIntensity = this.state.envIntensity;   // 0.62 en grand beau
}
```

Et surtout, **changer ce qu'il y a sous l'horizon**. `uGround = 0xccc0b0` est le fond de studio
qui lave tout (§0.3). Il doit devenir le **rebond du sable réellement éclairé** :

```js
// Le sol de l'IBL n'est pas un décor : c'est le rebond du sable au soleil.
// Luminance ≈ albédo × facteur de vue (~0,35 pour une demi-sphère vue depuis
// un point posé au sol).
const bounce = 0.50 /* albédo sable */ * 0.35 /* facteur de vue */;
this.uniforms.uGround.value
  .copy(sunColor).multiplyScalar(bounce)
  .lerp(new THREE.Color(0xD9A860).convertSRGBToLinear(), 0.55);
// Grand beau, midi : ≈ #C99A55 en linéaire. Chaud, SATURÉ, et 3x plus sombre
// que l'ancien 0xccc0b0. C'est ce qui redonne du contraste haut/bas et fait
// virer le dessous des voûtes vers l'ambre.
```

**Vérification.** Sur un objet à l'ombre, on doit désormais lire :

| Face | Couleur de l'éclairement | Effet |
|---|---|---|
| Vers le haut | `#6FA8E8` bleu ciel | dominante froide franche |
| Vers le bas | `#C99A55` ambre | rebond chaud du sable |
| Verticale, dos au soleil | `#3C79C8` bleu zénith profond | la plus froide |

C'est **la séparation chaud/froid** qui fait respirer une image de plein soleil, et elle
s'obtient sans une seule ligne de color grading.

#### (c) Teinte d'ombre explicite — la triche assumée

Pour pousser au-delà du physique (look stylisé « Islanders »), on peut teinter directement le
résultat du shadow mask. 4 ALU, très efficace :

```glsl
// SandMaterial.js — injection après #include <lights_fragment_end>
// La lumière que le soleil ne délivre PAS est remplacée par un supplément de
// teinte ciel, proportionnel à l'occlusion. Physiquement discutable (on ajoute
// de l'énergie), visuellement redoutable.
#include <lights_fragment_end>
{
  float sunOcclusion = 1.0 - getShadowMask();
  reflectedLight.indirectDiffuse += uShadowTint * sunOcclusion * uShadowTintGain;
}
```

`uShadowTint = #4E86D6` (converti en linéaire), `uShadowTintGain = 0.10` en grand beau, `0.0`
partout ailleurs. **Ne jamais dépasser 0,15** : au-delà, une ombre devient plus claire qu'un mur
éclairé en contre-jour, et l'image se retourne.

### 2.7 Ombres de contact des petits objets

PCSS ne résout **pas** l'ancrage d'un coquillage de 3 cm ni d'un seau : leur ombre fait 2 à 3
texels, et le normal bias la mange. Deux solutions cumulables :

- **Decal d'ombre** sous chaque prop : un quad instancié, disque flouté,
  `blending: THREE.MultiplyBlending`, orienté selon `sunDir` et allongé de `1 / sunDir.y`.
  Un seul draw call pour tous les props. **C'est la solution.**
- **AO écran à petit rayon** (N8AO, `aoRadius: 0.12`, half-res) si le budget le permet.
  **Attention** : l'AO écran assombrit aussi les zones **au soleil**, ce qui *baisse* le
  contraste global. En plein midi tropical, garder `intensity ≤ 1.2` — au-delà, on refabrique
  méthodiquement le look mou qu'on vient d'éliminer.

---

## 3. Ciel et IBL

### 3.1 Quel modèle de ciel — la décision

Trois options réalistes, évaluées pour Sandcastle.

| | **Dôme analytique actuel** (`SKY_FRAG`) | **Preetham** (`three/addons/objects/Sky.js`) | **Hosek-Wilkie** |
|---|---|---|---|
| Coût GPU | ~14 ALU | ~55 ALU | ~15 ALU + 30 uniformes à recalculer côté CPU |
| Données | aucune | aucune | table de 65 Ko (3 × 1080 + 3 × 120 doubles) |
| Zénith à midi | **pâle** (le bug actuel) | correct, profond | correct, profond |
| Couchant | acceptable | médiocre (faiblesse connue) | **excellent** |
| Turbidité élevée | ne modélise pas | médiocre (faiblesse connue) | **excellent** |
| Albédo de sol | non | non | **oui** (le sable clair réchauffe le ciel bas) |
| Contrôle artistique | **total** | indirect (4 paramètres) | indirect (T, albédo) |

**Décision : garder le dôme analytique, le re-calibrer sur Preetham.**

Les raisons sont dictées par ce projet précis, pas par la qualité intrinsèque des modèles :

1. Le ciel de Sandcastle est vu à travers un **objectif de 32° avec un tilt-shift**, sur un
   diorama qui occupe 70 % du cadre. Le ciel visible fait quelques centaines de pixels. Payer
   55 ALU par pixel pour un modèle spectral sur cette surface est un mauvais échange.
2. Le dôme actuel est **piloté par des couleurs explicites** (`uZenith`, `uHorizon`, `uGround`).
   C'est ce qui rend la **machine à états météo du §4 possible** : on interpole six palettes
   d'auteur. Avec Preetham, on ne peut interpoler que `turbidity` / `rayleigh` — on perd la main
   sur le look, ce qui est exactement l'inverse du brief.
3. `Sky.js` de three.js est une cible mouvante : la r184 y a ajouté une couche de nuages
   procéduraux (`cloudCoverage`, `cloudDensity`, `showSunDisc`…) et la r186 a **supprimé
   l'uniforme `up`**. S'y accrocher, c'est signer pour des régressions à chaque montée de version.

**Ce qu'on prend à Preetham : ses valeurs.** On calibre les couleurs du dôme sur ce que Preetham
produit à turbidité 2,2 et 3,0, une fois pour toutes.

### 3.2 Turbidité pour un ciel tropical

La turbidité `T` est le rapport entre l'épaisseur optique totale (Rayleigh + aérosols) et
l'épaisseur optique Rayleigh seule. `T = 1` est une atmosphère purement moléculaire (impossible
sur Terre). Repères :

| T | Atmosphère | Ciel obtenu |
|---|---|---|
| 1,8 – 2,2 | **air marin tropical, après une pluie** | zénith bleu-outremer très profond, halo solaire minuscule |
| 2,2 – 3,0 | **air marin tropical standard** | ← **notre cible « Grand beau »** |
| 3 – 4 | air continental propre | bleu franc, halo net |
| 4 – 6 | **brume de chaleur, embruns, sel en suspension** | ← notre « Voile de chaleur » |
| 6 – 10 | atmosphère chargée, poussière | ciel blanchâtre, horizon effacé |
| > 10 | pollution, brume dense | ciel laiteux uniforme |

> **Le défaut de `Sky.js` de three.js est `turbidity: 2`, mais l'exemple officiel
> `webgl_shaders_sky.html` propose `turbidity: 10, rayleigh: 3`.** Beaucoup de projets copient
> l'exemple. `T = 10`, c'est un ciel de mégapole en été. **C'est une des sources classiques du
> ciel laiteux en Three.js** — et par ricochet d'un IBL lavé, puisque le ciel *est* l'IBL.

Ce que Preetham donne à `T = 2,4`, soleil à 80°, ramené en sRGB (c'est notre table de calibration) :

| Direction | sRGB | Note |
|---|---|---|
| Zénith | **`#1E5FC4`** | bleu profond, saturation 85 % |
| 45° d'élévation, à l'opposé du soleil | `#3C79C8` | |
| 45° d'élévation, côté soleil | `#79ADE0` | |
| Horizon, à l'opposé du soleil | **`#B9DCF2`** | pâle mais **pas blanc** |
| Horizon, côté soleil | `#E8E4D8` | |
| Moyenne cosinus-pondérée (= `hemi.color`) | **`#6FA8E8`** | |

À comparer aux valeurs actuelles de `Sky.js` : `uZenith = 0x2f6fc4` (proche, mais
`setRGB(0.10, 0.30, 0.72)` est appliqué en **linéaire**, ce qui donne un zénith beaucoup plus
clair une fois converti — voir §3.4), `uHorizon = 0xbfd8ea`.

**L'erreur la plus visible est le rapport zénith/horizon.** Aujourd'hui : `0.30` vs `0.84` en
luminance linéaire, soit **1 : 2,8**. Preetham à `T = 2,4` donne **1 : 4,4**. Le ciel tropical
est *beaucoup* plus contrasté du haut vers le bas qu'un ciel européen, et c'est ce gradient qui
« dit » la latitude.

### 3.3 Le shader de ciel corrigé

Cinq changements sur `SKY_FRAG`, tous petits, tous décisifs :

```glsl
varying vec3 vDir;
uniform vec3  uSunDir;
uniform vec3  uZenith;
uniform vec3  uHorizon;
uniform vec3  uGround;
uniform vec3  uSunColor;
uniform float uSunSize;
uniform float uHaze;         // halo de Mie SERRÉ uniquement
uniform float uNight;
uniform float uSunDiscGain;  // 0 pendant la capture IBL, 12 sinon  <-- NOUVEAU
uniform float uZenithPower;  // dureté du dégradé                   <-- NOUVEAU

void main() {
  vec3 d = normalize(vDir);
  float h = d.y;

  // (1) DÉGRADÉ : exposant 0.42 -> uZenithPower (~0.62 en tropical).
  // Un exposant plus GRAND resserre le pâle vers l'horizon et laisse le bleu
  // profond occuper une plus grande part de la voûte. C'est le réglage n°1
  // du "ciel tropical" et il ne coûte rien.
  float t = pow(clamp(h, 0.0, 1.0), uZenithPower);
  vec3 sky = mix(uHorizon, uZenith, t);

  // Sol (sous l'horizon) : le REBOND DU SABLE, pas un fond de studio.
  sky = mix(uGround, sky, smoothstep(-0.06, 0.03, h));

  float cosA = dot(d, uSunDir);

  // (2) MIE : on SUPPRIME le second lobe large `pow(cosA, 2.0) * 0.14`.
  // C'est lui qui blanchissait toute la moitié de ciel côté soleil. Le halo
  // solaire réel à T=2,4 est SERRÉ : il faut un exposant élevé.
  float mie = pow(max(cosA, 0.0), 22.0) * 0.42
            + pow(max(cosA, 0.0), 6.0)  * 0.10;
  sky += uSunColor * mie * uHaze;

  // (3) DISQUE SOLAIRE pilotable, pour pouvoir l'éteindre à la capture IBL.
  float ang  = acos(clamp(cosA, -1.0, 1.0));
  float disc = smoothstep(uSunSize, uSunSize * 0.55, ang);
  sky += uSunColor * disc * uSunDiscGain * (1.0 - uNight);

  // (4) ASSOMBRISSEMENT DU ZÉNITH côté opposé au soleil.
  // Le ciel réel n'est pas à symétrie de révolution : le point le plus sombre
  // est à ~90° du soleil, pas au zénith. Deux lignes, et le ciel arrête d'être
  // un dégradé de dégradé.
  float away = smoothstep(0.35, -0.25, cosA);
  sky *= mix(1.0, 0.82, away * clamp(h * 2.2, 0.0, 1.0));

  // (5) Étoiles : inchangé, mais atténuées près de l'horizon (extinction).
  if (uNight > 0.01 && h > -0.02) {
    vec3 p = floor(d * 620.0);
    float n = fract(sin(dot(p, vec3(12.9898, 78.233, 45.164))) * 43758.5453);
    float star = smoothstep(0.9975, 0.9999, n);
    sky += vec3(0.8, 0.85, 1.0) * star * uNight * smoothstep(0.0, 0.25, h);
  }

  gl_FragColor = vec4(sky, 1.0);
}
```

Et côté JS, **la correction d'espace colorimétrique** :

```js
// AVANT — setRGB() sans espace = LINÉAIRE. La valeur (0.10, 0.30, 0.72)
// affichée vaut donc sRGB #5B93DB : un bleu CLAIR. Ce n'est pas le zénith
// tropical qu'on croit écrire.
this.uniforms.uZenith.value.setRGB(0.10, 0.30, 0.72);

// APRÈS — on écrit les couleurs en sRGB (ce qu'on lit dans une pipette) et
// on laisse three.js convertir. Zéro ambiguïté.
this.uniforms.uZenith.value.setHex(0x1E5FC4, THREE.SRGBColorSpace)
  .multiplyScalar(this.state.skyGain);
```

> **C'est le troisième piège classique du look lavé** : mélanger `setRGB()` (linéaire) et
> `setHex()` (sRGB par défaut depuis r152) dans le même fichier. Une couleur linéaire `0.30`
> s'affiche à `0.58` en sRGB — presque le double. Toutes les couleurs de ce document sont
> données **en sRGB**.

### 3.4 Si l'on veut vraiment Preetham ou Hosek-Wilkie

Pour référence, la partie utile du shader Preetham de three.js — le cœur du calcul, dépouillé
de son enrobage :

```glsl
// Coefficients Rayleigh pré-calculés pour les primaires de Preetham
// (lambda = 680 / 550 / 450 nm)
const vec3 totalRayleigh = vec3(5.804543e-6, 1.3562911e-5, 3.0265902e-5);
const vec3 MieConst      = vec3(1.8399919e14, 2.7798024e14, 4.0790480e14);

const float rayleighZenithLength = 8.4e3;   // épaisseur optique au zénith (m)
const float mieZenithLength      = 1.25e3;

vec3 totalMie(float T) { return 0.434 * ((0.2 * T) * 10e-18) * MieConst; }

float rayleighPhase(float c) { return 0.05968310 * (1.0 + c * c); }
float hgPhase(float c, float g) {
  float g2 = g * g;
  return 0.07957747 * ((1.0 - g2) / pow(1.0 - 2.0 * g * c + g2, 1.5));
}

// --- fragment ---
float zenithAngle = acos(max(0.0, dir.y));
// approximation de la masse d'air de Kasten-Young
float inv = 1.0 / (cos(zenithAngle)
          + 0.15 * pow(93.885 - (zenithAngle * 180.0 / PI), -1.253));
vec3 Fex = exp(-(betaR * rayleighZenithLength * inv
               + betaM * mieZenithLength      * inv));

float cosTheta = dot(dir, sunDir);
vec3  Lin = pow(sunE * ((betaR * rayleighPhase(cosTheta * 0.5 + 0.5)
                       + betaM * hgPhase(cosTheta, g))
                       / (betaR + betaM)) * (1.0 - Fex), vec3(1.5));
```

`betaR = totalRayleigh * rayleigh`, `betaM = totalMie(turbidity) * mieCoefficient`.

**Réglages à utiliser si on part sur Preetham** (et **pas** ceux de l'exemple officiel) :

| État | `turbidity` | `rayleigh` | `mieCoefficient` | `mieDirectionalG` |
|---|---|---|---|---|
| Grand beau | **2,4** | **2,2** | 0,0035 | 0,80 |
| Voile de chaleur | 5,5 | 1,6 | 0,012 | 0,84 |
| Nuages épars | 3,0 | 2,0 | 0,005 | 0,80 |
| Grain | 9,0 | 1,0 | 0,020 | 0,88 |
| Coucher doré | 3,6 | 2,6 | 0,009 | 0,86 |
| Nuit | 2,0 | 1,2 | 0,003 | 0,78 |

**Hosek-Wilkie** est meilleur sur deux points qui comptent pour nous — les couchants et les
turbidités élevées, précisément les faiblesses documentées de Preetham — et il modélise
l'**albédo du sol**, ce qui est loin d'être anecdotique avec 100 m² de sable blanc en dessous.
Son coût GPU est même *inférieur* à Preetham (≈ 15 ALU) : la formule est un ajustement
analytique à 9 coefficients

```
L(θ,γ) = Z · (1 + A·e^(B/(cosθ+0,01)))
           · (C + D·e^(E·γ) + F·cos²γ + G·χ(H,γ) + I·√cosθ)
χ(H,γ) = (1 + cos²γ) / (1 + H² − 2H·cosγ)^1,5
```

où `A…I` et `Z` sont des `vec3` (RGB) fonction de la turbidité, de l'albédo de sol et de
l'élévation solaire.

**Le prix, c'est la table** : les coefficients viennent d'une interpolation de Bézier quintique
sur un jeu de données de 65 Ko, ré-évalué à chaque changement de soleil. La méthode standard —
celle de Blender Cycles, de diharaw/sky-models, de la plupart des moteurs — est de garder la
table **côté CPU**, de recalculer les 10 uniformes `vec3` quand le soleil bouge, et de les
téléverser. Le shader devient trivial.

**Verdict pour Sandcastle : non.** 65 Ko de table et 30 uniformes pour un ciel qui occupe
300 px et dont on veut de toute façon reprendre les couleurs à la main, c'est disproportionné.
On note ceci pour l'avenir : *si un jour le jeu montre un vrai horizon marin large avec des
couchants comme argument visuel, Hosek-Wilkie est le bon choix, et c'est la version « uniformes
calculées sur CPU » qu'il faut implémenter, pas la version spline dans le shader.*

*(Deux pièges connus de la table Hosek, notés ici pour ne pas les redécouvrir : **H et I sont
inversés dans le jeu de données officiel**, et le paramètre de spline est `élévation^(1/3)`,
pas l'élévation.)*

### 3.5 Génération de l'IBL et fréquence de rafraîchissement

`pmrem.fromScene()` coûte **3 à 8 ms**. Appelé pendant une transition, il produit un micro-freeze
parfaitement visible. La logique actuelle de `Sky.js` —

```js
if (force || Math.abs(dir.y - this.lastEnvSunY) > 0.03) { ... }
```

— est bonne dans son principe mais mal calibrée : avec `DAY_LENGTH = 20 min`, `dir.y` traverse
0,03 environ **toutes les 12 secondes** en milieu de matinée. C'est un hoquet de 5 ms trois fois
par minute, et il tombe forcément un jour au mauvais moment.

**Trois niveaux de solution, dans l'ordre où on doit les mettre en place.**

#### (a) Amortir : seuil plus large + régénération différée

```js
// Le seuil devient angulaire ET temporel : on ne régénère jamais deux fois
// en moins de 4 secondes, quoi qu'il arrive.
this._envCooldown = Math.max(0, this._envCooldown - dt);
const moved = Math.abs(dir.y - this.lastEnvSunY) > 0.075;
if (force || (moved && this._envCooldown <= 0)) {
  this._envDirty = true;
}
// … et on ne régénère QUE dans une frame où on a de la marge.
if (this._envDirty && frameBudgetMs > 4.0) {
  this._envDirty = false;
  this._envCooldown = 4.0;
  this.lastEnvSunY = dir.y;
  this.regenerateEnvironment();
}
```

Coût : 0,075 en `dir.y` ≈ 4,3° d'arc solaire ≈ 30 s de temps de jeu. **Aucun joueur ne voit la
marche.** L'IBL est une intégrale très basse fréquence : elle n'a strictement aucune raison
d'être exacte à l'image près.

#### (b) Pré-générer et interpoler — la solution recommandée

Huit environnements pré-calculés au chargement (un par clé du cycle solaire), et une
interpolation entre les deux plus proches :

```js
// Coût mémoire : 8 x cubemap PMREM 256² RGBA16F ≈ 8 Mo. C'est rien.
// Coût CPU : 8 x 5 ms = 40 ms, une fois, pendant l'écran de chargement.
async prebakeEnvironments() {
  this.envBank = [];
  for (let i = 0; i < 8; i++) {
    this.applyState(SUN_KEYS[i]);         // pose les uniformes du dôme
    this.uniforms.uSunDiscGain.value = 0; // toujours : pas de disque dans l'IBL
    this.envBank.push(this.pmrem.fromScene(this.envScene, 0.035, 0.1, 100));
    await frame();                        // ne pas bloquer le thread
  }
}
```

L'interpolation entre deux cubemaps n'est pas gratuite en WebGL2 (pas de blend natif entre deux
`samplerCube` dans le pipeline standard de three). **Ce qu'on interpole, ce n'est pas la texture,
c'est `environmentIntensity` et les couleurs des lumières.** On bascule sur la cubemap la plus
proche et on rattrape la différence de teinte avec la `HemisphereLight`. À 8 clés sur une
journée, la marche est indétectable — l'ambiante ne représente que 15 % de l'éclairement.

#### (c) Ce qu'il ne faut PAS faire

- Régénérer chaque frame. Non.
- Utiliser une PMREM de 512² ou plus. La radiance diffuse d'un ciel est un signal d'ordre 2 :
  **256² est déjà surdimensionné**, 128² suffirait. Chaque doublement quadruple le coût.
- Oublier `dispose()` sur l'ancienne `WebGLRenderTarget` — le code actuel le fait bien, ne pas
  le casser en refactorant.
- **Laisser le disque solaire dans la capture.** Détaillé au §2.6(b) : c'est une double
  comptabilité d'énergie qui produit un spéculaire fantôme et lave l'image.

### 3.6 Perspective aérienne : la tranche

**Question posée : sur 10 m, un léger voile atmosphérique aide-t-il ?**

**Réponse physique : non, catégoriquement.** Le coefficient d'extinction Rayleigh au niveau de
la mer vaut `βR ≈ 1,3 × 10⁻⁵ m⁻¹` (moyenne visible). Sur 10 mètres :

```
transmittance = exp(-1,3e-5 × 10) = 0,99987
```

**0,013 % d'atténuation.** Un brouillard qui serait visible sur 10 m dans un air clair est
physiquement impossible. Toute brume qu'on ajoute à cette distance est **du mensonge pur**.

**Réponse de direction photo : oui, mais pas là où on croit, et jamais en grand beau.**

Il faut distinguer trois choses qu'on confond systématiquement sous le mot « fog » :

| | Utile ici ? | Pourquoi |
|---|---|---|
| **Brume de distance sur le sable (0–10 m)** | **NON. Jamais.** | Physiquement absurde, et c'est *littéralement* le mécanisme du look lavé : elle mélange chaque pixel vers une couleur de ciel moyenne, ce qui écrase le contraste local. **C'est l'ennemi n°1 de ce document.** |
| **Brume sur la mer hors domaine (10–120 m)** | **OUI, toujours.** | Le fond marin s'étend au-delà du bloc. À 80 m, la transmittance Rayleigh est de 99,9 % — toujours négligeable — mais l'**embrun marin** (aérosols de Mie, βM ≈ 2×10⁻⁴ m⁻¹ en air marin) donne 1,6 % à 80 m : ténu mais réel, et surtout **c'est ce qui raccorde la mer au ciel**. Sans ça, on voit une couture horizon/mer. |
| **Voile atmosphérique conditionnel (états « brume » et « grain »)** | **OUI, c'est le sujet du §4.** | Là, on ne simule plus 10 m d'air clair : on simule 10 m d'air **chargé d'embruns et de vapeur**, ce qui existe vraiment. `βM` peut monter à 5×10⁻³ m⁻¹ dans un grain, soit 5 % à 10 m — visible. |

**Implémentation :**

```js
// Game.js — le fog n'est PAS attaché au sable, il est piloté par la météo.
// En grand beau : AUCUN fog. C'est un choix, pas un oubli.
scene.fog = new THREE.FogExp2(0x9EC8E8, 0.0);

// à chaque changement d'état météo :
scene.fog.density = state.fogDensity;   // 0.000 -> 0.055 selon l'état
scene.fog.color.copy(state.fogColor);   // = la couleur du ciel à l'horizon
```

| État | `fogDensity` | Atténuation à 10 m | Atténuation à 80 m (mer) |
|---|---|---|---|
| Grand beau | **0,000** | 0 % | 0 % |
| Voile de chaleur | 0,022 | 20 % | 83 % |
| Nuages épars | 0,004 | 4 % | 27 % |
| Grain tropical | 0,055 | 42 % | 99 % |
| Coucher doré | 0,010 | 10 % | 55 % |
| Nuit claire | 0,006 | 6 % | 38 % |

> **Règle absolue : `fog.color` doit être exactement la couleur du ciel dans la direction
> regardée.** Un fog dont la couleur ne correspond pas au ciel derrière produit une silhouette
> fantôme autour de chaque objet. Comme `FogExp2` n'a qu'une couleur unique, on utilise la
> couleur du ciel **à l'horizon** (`uHorizon`) — c'est là que le fog a le plus d'effet.

**Le meilleur substitut au fog en grand beau : le tremblement de chaleur.** Il dit « il fait
40 °C » sans toucher au contraste, ce qui est exactement ce qu'on veut :

```glsl
// Post.js — passe d'étalonnage, avant l'échantillonnage principal.
// Une distorsion d'UV minuscule, concentrée juste au-dessus de la ligne
// d'horizon, animée lentement. À 0.0015 elle est subliminale ; c'est le but.
float heatBand = exp(-pow((vUv.y - uHorizonY) * 9.0, 2.0));
vec2 shimmer = vec2(
  sin(vUv.x * 62.0 + uTime * 2.1) * 0.6 + sin(vUv.y * 91.0 - uTime * 1.4) * 0.4,
  0.0
) * uHeatShimmer * heatBand;
uv += shimmer;
```

`uHeatShimmer = 0.0015` en grand beau, `0.0035` en voile de chaleur, `0` partout ailleurs.

---

## 4. États météo

Six états. Le premier est l'état par défaut et **doit occuper la majorité du temps de jeu** :
c'est lui qui porte l'identité visuelle. Les autres existent pour le faire ressortir par
contraste — une météo permanente n'est plus une météo, c'est un décor.

Chaque état définit un `WeatherState` complet, interpolable, dont le tableau final est au §8.

```js
/**
 * @typedef {Object} WeatherState
 * @property {string}  id
 * @property {number}  sunIntensity      unités Three.js (1 u = 20 000 lx)
 * @property {number}  sunColor          hex sRGB
 * @property {number}  sunTanAngle       tan(diamètre angulaire effectif)
 * @property {number}  hemiIntensity
 * @property {number}  hemiColor
 * @property {number}  hemiGroundColor
 * @property {number}  envIntensity
 * @property {number}  zenith            hex sRGB
 * @property {number}  horizon
 * @property {number}  ground            (rebond du sable dans l'IBL)
 * @property {number}  zenithPower       dureté du dégradé de ciel
 * @property {number}  haze              gain du halo de Mie
 * @property {number}  turbidity         (documentaire, ou Preetham)
 * @property {number}  cloudCoverage     0..1
 * @property {number}  cloudShadow       0..1 force de l'ombre projetée
 * @property {number}  cloudSpeed        m/s
 * @property {number}  windSpeed         m/s  -> gameplay + vagues + embruns
 * @property {number}  rainRate          mm/h -> gameplay + particules
 * @property {number}  exposure          toneMappingExposure
 * @property {number}  bloomStrength
 * @property {number}  bloomThreshold
 * @property {number}  saturation
 * @property {number}  contrast
 * @property {number}  vignette
 * @property {number}  fogDensity
 * @property {number}  waveHeight        multiplicateur de la houle
 * @property {number}  insolation        0..1 -> Moisture.insolation
 */
```

---

### 4.1 GRAND BEAU — l'état par défaut

> *Midi, pas un nuage, l'air lavé par la brise de mer. Le sable est trop clair pour être
> regardé sans plisser les yeux. Les ombres sont des découpes bleu-marine posées sur du
> blanc. C'est l'état de référence : tous les autres sont mesurés contre lui.*

| Paramètre | Valeur |
|---|---|
| Soleil | `5.00` / `#FFF4E2` (≈ 5600 K) |
| Ciel (hemi) | `0.22` / `#6FA8E8`, sol `#D9B476` |
| IBL | `0.62` |
| **Ratio soleil / ciel** | **5,8 : 1** |
| Zénith / horizon | `#1E5FC4` / `#B9DCF2` — rapport de luminance **1 : 4,4** |
| Turbidité | 2,4 |
| Diamètre solaire | 2,1° (`uSunTanAngle = 0.037`) |
| Couverture nuageuse | 0,00 |
| Vent | 3,5 m/s (brise de mer) |
| Exposition | 0,78 |
| Bloom | force 0,32 · seuil 1,10 · rayon 0,30 |
| Saturation | 1,26 |
| Contraste | 1,18 |
| Vignette | 0,22 |
| Fog | **0,000** |
| Houle | ×1,0 |

**Palette** (sRGB, telle qu'elle doit sortir à l'écran) :

| Élément | Au soleil | À l'ombre |
|---|---|---|
| Sable sec | `#F6EDD4` | `#93A9C6` |
| Sable humide | `#C9A97A` | `#6E7F9C` |
| Eau peu profonde | `#4FD9D0` | `#2E9EA8` |
| Eau profonde | `#0E7CA8` | `#0A5C82` |
| Écume | `#FFFFFF` | `#CFE0EE` |
| Rocher | `#B8A896` | `#69748C` |

**Post-traitement.** C'est ici que le bloom devient enfin utile : avec le soleil à 5,0, le
spéculaire sur l'eau atteint 8 à 25 en linéaire et les facettes de quartz du `sparkle` montent
à 3-6. Un seuil à **1,10** les attrape, sans jamais toucher au sable (0,91).

**Gameplay.** `insolation = 1.0`, `wind = 0.35`. Le terme d'évaporation de `Moisture.js` —
`(0.25 + 0.75 × insolation) × (1 + 0.8 × wind)` — vaut **1,28**, soit son maximum.
Conséquence de design : **le sable sèche vite, donc il faut arroser souvent.** L'arrosoir
devient l'outil qu'on reprend en boucle, et le joueur *sent* le soleil. C'est voulu.
Fenêtre utile après un arrosage : ~2 minutes de temps réel avant de retomber sous
`W_OPTIMAL = 0.12`.

---

### 4.2 VOILE DE CHALEUR / BRUME DE MIDI

> *L'air tremble au-dessus du sable. Le soleil est toujours là, mais on ne peut plus le
> regarder : c'est un disque blanc dans une soupe blanche. Les ombres existent encore, mais
> leurs bords sont mangés. Tout est plus clair et moins coloré — l'inverse exact du grand beau,
> avec la même quantité de lumière.*

C'est l'état **le plus intéressant à implémenter**, parce qu'il démontre que « lumineux » et
« contrasté » sont deux axes indépendants. Il conserve 75 % de l'éclairement du grand beau et
n'a pourtant **rien de son punch**. C'est aussi, exactement, le look que le jeu a aujourd'hui —
d'où l'intérêt de le garder comme état météo *choisi* plutôt que comme défaut *subi*.

| Paramètre | Valeur |
|---|---|
| Soleil | `3.55` / `#FFF0DC` |
| Ciel (hemi) | `0.52` / `#A8C6E4`, sol `#D8C6A4` |
| IBL | `0.88` |
| **Ratio soleil / ciel** | **2,4 : 1** ← c'est tout le sujet |
| Zénith / horizon | `#5A8ECC` / `#DCE6EC` — rapport **1 : 2,0** |
| Turbidité | 5,5 |
| Diamètre solaire | **7,0°** (`uSunTanAngle = 0.122`) — ombres très adoucies |
| Couverture nuageuse | 0,10 (cirrus) |
| Vent | 1,2 m/s (air stagnant) |
| Exposition | 0,94 |
| Bloom | force 0,46 · seuil 0,90 · rayon 0,42 |
| Saturation | 1,04 |
| Contraste | 0,94 |
| Vignette | 0,16 |
| Fog | 0,022 |
| Houle | ×0,7 (mer d'huile) |
| Heat shimmer | 0,0035 |

**Gameplay.** `insolation = 0.78`, `wind = 0.10` → évaporation `0.84 × 1.08 = 0,91`. Le sable
sèche **30 % moins vite** qu'en grand beau : l'air est saturé d'humidité et immobile.
Contre-intuitif et satisfaisant — *il fait plus lourd, mais le sable tient mieux.* C'est la
fenêtre de construction confortable.

---

### 4.3 NUAGES ÉPARS — l'état le plus vivant

> *Des cumulus de beau temps défilent, poussés par l'alizé. Toutes les vingt secondes, une
> ombre balaie la plage : le sable passe de blanc brûlant à bleu-gris en une seconde, puis
> revient. C'est l'état où l'on VOIT la lumière bouger.*

Le point décisif : ce n'est pas la couche de nuages dans le ciel qui fait l'effet, c'est
**l'ombre qui défile au sol**. Le §5 y est consacré.

| Paramètre | Valeur |
|---|---|
| Soleil | `4.70` / `#FFF2E0` |
| Ciel (hemi) | `0.34` / `#7FB0E2`, sol `#D5B27C` |
| IBL | `0.72` |
| **Ratio soleil / ciel (au soleil)** | **4,4 : 1** |
| **Ratio (sous une ombre de nuage)** | **0 : 1** — c'est le contraste temporel |
| Zénith / horizon | `#2A6BC6` / `#C2DEEE` |
| Turbidité | 3,0 |
| Diamètre solaire | 2,6° (`uSunTanAngle = 0.045`) |
| **Couverture nuageuse** | **0,42** |
| **Force d'ombre de nuage** | **0,80** (le soleil chute à 20 % sous un nuage) |
| Vitesse des nuages | 6,5 m/s |
| Vent | 5,5 m/s |
| Exposition | 0,81 (lissée, cf. §4.7) |
| Bloom | force 0,34 · seuil 1,05 · rayon 0,32 |
| Saturation | 1,22 |
| Contraste | 1,14 |
| Vignette | 0,22 |
| Fog | 0,004 |
| Houle | ×1,3 |

**Gameplay — le meilleur couplage du jeu.** `insolation` n'est plus une constante : on
**échantillonne la texture d'ombre de nuage au centre du domaine**, côté CPU, et on la branche
sur `Moisture` :

```js
// Game.update()
const shade = this.clouds.shadowAt(0, 0);           // 0 = plein soleil, 1 = ombragé
this.moisture.insolation = this.weather.insolation * (1.0 - 0.75 * shade);
this.moisture.wind       = this.weather.windSpeed / 12.0;
```

Le sable sèche donc **par vagues**, littéralement au rythme des nuages. Un joueur attentif
apprend à arroser juste avant qu'une ombre arrive : le sable reste humide plus longtemps. C'est
une mécanique émergente gratuite, née d'une simple multiplication.

---

### 4.4 GRAIN TROPICAL — ciel plombé, pluie, mer agitée

> *Le grain arrive de la mer en dix minutes. Le ciel passe au gris ardoise avec une base de
> nuage presque noire. La pluie tombe dru et droite. La mer devient blanche d'écume et monte
> plus haut que la marée ne le prévoyait. Tout ce qui n'était pas assez tassé s'effondre.*

C'est l'état **antagoniste** : celui qui détruit le travail du joueur, et donc celui qui donne
sa valeur à tout le reste. Il doit être **rare** (5 à 8 % du temps) et **annoncé** (§4.7).

| Paramètre | Valeur |
|---|---|
| Soleil | `0.00` (éteint) |
| Ciel (hemi) | `0.30` / `#7E8A96`, sol `#6C6558` |
| IBL | `0.34` |
| **Ratio soleil / ciel** | **0 : 1** — aucune ombre portée |
| Zénith / horizon | `#4E5A68` / `#7C858E` — rapport **1 : 1,4**, quasi uniforme |
| Turbidité | 9,0 |
| Diamètre solaire | n/a (`uSunTanAngle = 0.300`, sans effet) |
| Couverture nuageuse | 0,96 |
| Force d'ombre de nuage | 0,10 (déjà tout ombragé) |
| Vitesse des nuages | 14 m/s |
| **Vent** | **13 m/s** |
| **Pluie** | **9 mm/h** |
| Exposition | 3,80 |
| Bloom | force 0,14 · seuil 1,50 · rayon 0,50 |
| Saturation | **0,74** (la pluie désature réellement) |
| Contraste | 1,06 |
| Vignette | 0,38 |
| Fog | 0,055 |
| Houle | **×2,2** |

**Palette :**

| Élément | Valeur |
|---|---|
| Sable sec (il n'y en a plus) | `#B0A691` |
| Sable trempé | `#6B5A46` |
| Eau peu profonde | `#4A7E86` |
| Eau profonde | `#1E3E50` |
| Écume | `#E4E8EA` |
| Ciel | `#5C6874` |

> **La saturation descend à 0,74, et c'est le seul état où elle descend.** Physiquement, une
> pluie dense diffuse la lumière de façon achromatique et le film d'eau sur les surfaces
> réfléchit spéculairement le ciel gris. Le monde devient réellement moins coloré. C'est le
> contrepoint qui rend le retour au grand beau spectaculaire.

**Gameplay — la vraie menace.** `insolation = 0.05`, `wind = 1.0`, `rainRate = 9 mm/h`.

1. **Le sable se gorge.** La pluie ajoute de l'eau au sommet de chaque colonne (§6.4). En 3 à 4
   minutes de temps réel, la saturation de surface dépasse `W_SATURATED = 0.45`.
2. **L'angle de repos s'effondre.** `REPOSE_CURVE` : à `w = 0.45` on est à ~38°, à `w = 0.60`
   à **22°**. Un mur vertical bâti à `w = 0.12` (89°) devient instable et **s'écroule**.
   Ce n'est pas un effet visuel : `Granular.js` le fait déjà.
3. **La mer monte.** `waveHeight ×2,2` plus une surcote de tempête de +8 cm sur `SEA_LEVEL` :
   le ressac atteint des zones que la marée seule n'atteindrait pas.
4. **L'évaporation s'arrête.** `(0.25 + 0.75 × 0.05) × (1 + 0.8) = 0,52` — mais avec la pluie
   qui apporte bien plus, le bilan net est très positif.

**La contrepartie** : après le grain, tout le sable est à l'humidité idéale sans un seul coup
d'arrosoir. Un grain, c'est une punition **et** un cadeau. C'est ce qui le rend jouable plutôt
qu'énervant.

---

### 4.5 COUCHER DE SOLEIL DORÉ

> *Le soleil touche l'horizon marin. Les ombres s'étirent sur toute la longueur de la plage.
> Chaque grain de sable qui dépasse projette son trait. Le sable est orange, l'eau est
> mercure et cuivre, et le ciel derrière est encore bleu-violet.*

| Paramètre | Valeur |
|---|---|
| Soleil | `1.60` / `#FF8A3C` — **DNI, pas irradiance horizontale** (cf. §1.3) |
| Ciel (hemi) | `0.30` / `#8C7FB4`, sol `#C08050` |
| IBL | `0.54` |
| **Ratio sur un plan horizontal** (`N·L = 0,12` à 7°) | **0,33 : 1** |
| **Ratio sur une face verticale au soleil** | **2,6 : 1** ← c'est là que ça se joue |
| Zénith / horizon | `#2A4A96` / `#FF9E56` |
| Turbidité | 3,6 |
| Diamètre solaire | 3,2° (`uSunTanAngle = 0.056`) |
| Couverture nuageuse | 0,25 |
| Vent | 2,5 m/s (calme du soir) |
| Exposition | 1,85 |
| Bloom | force 0,58 · seuil 0,72 · rayon 0,58 — **le bloom est le sujet** |
| Saturation | 1,32 |
| Contraste | 1,10 |
| Vignette | 0,30 |
| Fog | 0,010 |
| Houle | ×0,9 |

> **Le piège du couchant** : baisser `sun.intensity` parce que « il fait moins clair ». Non.
> Three.js applique déjà `N·L`, et à 7° d'élévation `N·L = 0,122` sur un plan horizontal. En
> donnant l'irradiance **normale au faisceau** (DNI ≈ 32 000 lx → `1.60`), on obtient
> automatiquement un sol faiblement éclairé **et** des faces verticales orientées vers le soleil
> violemment éclairées. C'est **exactement** ce qui fait le couchant : le contraste entre les
> faces qui prennent le soleil et le sol qui ne le prend plus. Baisser `intensity` détruit cet
> effet et donne une image uniformément brune.

**Le rapport chaud/froid est inversé.** Toute la journée, la lumière est chaude et l'ombre
froide. Au couchant, le soleil devient franchement orange **et** le ciel devient violet : les
deux extrêmes s'écartent encore. C'est le moment de la journée où la séparation chaud/froid est
la plus forte, malgré un ratio d'intensité faible. **Le contraste de couleur remplace le
contraste de valeur.**

**Gameplay.** `insolation = 0.18`, `wind = 0.20` → évaporation 0,45. Le sable tient. C'est la
fenêtre de finition : on sculpte les détails au moment où la lumière rasante les révèle le
mieux. La rime entre le gameplay et la photo est directe — **la lumière rasante montre le
relief que la lumière zénithale cache.**

---

### 4.6 NUIT CLAIRE / CLAIR DE LUNE

> *La lune est haute. Le sable est bleu-gris pâle, l'eau presque noire avec un chemin d'argent.
> On distingue les formes, pas les couleurs. Les étoiles sont là. Le seul état de ce document
> où l'on renonce au contraste.*

| Paramètre | Valeur |
|---|---|
| Lune (directionnelle) | `0.045` / `#9FB8DE` |
| Ciel (hemi) | `0.020` / `#2B4A78`, sol `#1E2634` |
| IBL | `0.10` |
| **Ratio lune / ciel** | **1,4 : 1** — volontairement plat (§1.5) |
| Zénith / horizon | `#060C1E` / `#16263E` |
| Turbidité | 2,0 |
| Diamètre solaire | 1,6° (`uSunTanAngle = 0.028`) |
| Couverture nuageuse | 0,15 |
| Vent | 2,0 m/s |
| Exposition | **6,0** (hors échelle physique) |
| Bloom | force 0,22 · seuil 0,55 · rayon 0,48 |
| Saturation | **0,80** (effet Purkinje : la vision scotopique est achromatique) |
| Contraste | 0,96 |
| Vignette | 0,42 |
| Fog | 0,006 |
| Houle | ×1,0 |

**Gameplay — la nuit est un cadeau.** `insolation = 0.0`, `wind = 0.17` → évaporation
**0,29**, soit le quart du grand beau. En plus, on ajoute la **rosée** :

```js
// Moisture.js — apport nocturne, uniquement sur les colonnes exposées au ciel.
// Physique : le sable rayonne vers un ciel clair à -40 °C équivalent, sa
// surface descend sous le point de rosée, la vapeur se condense.
// 0,05 mm/h de lame d'eau, ce qui est la valeur mesurée sur des dunes.
const dewRate = 1.4e-8 * (1 - insolation) * (1 - cloudCoverage) * (1 - wind * 0.6);
```

Un château laissé pour la nuit est **plus humide au matin qu'au coucher**. C'est physiquement
exact (la rosée marine est abondante) et c'est une bonne surprise de game design.

---

### 4.7 Machine à états : transitions et durées

#### Table de transition

Probabilités de l'état suivant, quand la durée de l'état courant est écoulée.

| Depuis \ Vers | Grand beau | Voile | Nuages | Grain | Coucher | Nuit |
|---|---|---|---|---|---|---|
| **Grand beau** | — | 0,30 | 0,55 | 0,05 | *(heure)* | *(heure)* |
| **Voile** | 0,45 | — | 0,40 | 0,15 | *(heure)* | *(heure)* |
| **Nuages** | 0,50 | 0,20 | — | 0,30 | *(heure)* | *(heure)* |
| **Grain** | 0,25 | 0,60 | 0,15 | — | *(heure)* | *(heure)* |
| **Coucher** | — | — | — | — | — | 1,00 |
| **Nuit** | 0,70 | 0,20 | 0,10 | 0,00 | — | — |

*(heure)* = **le coucher et la nuit ne sont pas tirés au sort** : ils sont imposés par `dayT`.
Coucher pour `dayT ∈ [0.78, 0.86]`, nuit pour `dayT ∉ [0.24, 0.88]`. La météo « diurne » reste
mémorisée pendant la nuit et reprend au matin, à 30 % près.

Trois règles dérivées de cette table, à faire respecter par le code :

1. **`Grain` n'est jamais accessible directement depuis `Grand beau` à plus de 5 %.** Un ciel
   parfaitement bleu ne devient pas noir en dix minutes ; il passe par des nuages. Cela donne
   au joueur un **avertissement visuel gratuit** : voir des cumulus s'accumuler, c'est savoir
   qu'un grain est possible.
2. **Après un `Grain`, on ne revient pas directement au `Grand beau`** dans 75 % des cas : la
   traîne du grain, c'est de la brume. C'est ce qui fait que le retour du soleil se *mérite*.
3. **Le `Grand beau` a le poids le plus fort en cumul** (durée longue × forte probabilité
   d'entrée). Cible : **50 à 55 % du temps diurne**.

#### Durées

| État | Durée (min de jeu) | Transition depuis | Notes |
|---|---|---|---|
| Grand beau | **8 – 16** | 40 s | l'état long, c'est le point |
| Voile de chaleur | 5 – 10 | **90 s** | s'installe lentement |
| Nuages épars | 6 – 12 | 50 s | |
| Grain tropical | **2,5 – 5** | **25 s (entrée) / 70 s (sortie)** | arrive vite, part lentement |
| Coucher doré | imposé (~1,6 min de jeu) | 60 s | |
| Nuit claire | imposée (~7 min de jeu) | 90 s | |

**L'asymétrie du grain est ce qui le rend dramatique** : 25 s pour que le ciel se ferme, 70 s
pour qu'il se rouvre. C'est le comportement d'un vrai grain tropical, et ça donne au joueur
juste assez de temps pour courir mettre son château à l'abri — ou pas.

#### Interpolation

Tous les paramètres scalaires et couleurs s'interpolent en `smoothstep`, **sauf trois** :

```js
/**
 * Interpole deux WeatherState. `t` est déjà lissé (smoothstep) par l'appelant.
 */
function lerpWeather(a, b, t, out) {
  for (const k of SCALAR_KEYS) out[k] = a[k] + (b[k] - a[k]) * t;
  for (const k of COLOR_KEYS)  out[k].lerpColors(a[k], b[k], t);

  // 1. EXPOSITION : jamais interpolée linéairement. Elle est LOGARITHMIQUE
  //    (c'est une échelle de stops). Une lerp linéaire entre 0.78 et 3.80
  //    passe à mi-course par 2.29, ce qui est 1,55 stop trop clair : l'image
  //    "flashe" au milieu de chaque transition vers le grain.
  out.exposure = Math.exp(Math.log(a.exposure) * (1 - t) + Math.log(b.exposure) * t);

  // 2. PLUIE : jamais interpolée symétriquement. Elle démarre vite (les
  //    premières gouttes tombent dès que le ciel se ferme) et s'arrête net.
  out.rainRate = a.rainRate + (b.rainRate - a.rainRate) * smoothstep(0.15, 0.65, t);

  // 3. HOULE : la mer a de l'inertie. Elle met plusieurs minutes à se lever
  //    et encore plus à se calmer. Un premier ordre asymétrique, pas une lerp.
  const kWave = b.waveHeight > out.waveHeight ? 0.010 : 0.004;  // par frame @60
  out.waveHeight += (b.waveHeight - out.waveHeight) * kWave;
}
```

#### Lissage de l'exposition (anti-pompage)

Sous des nuages épars, l'éclairement varie d'un facteur 5 toutes les 15 à 30 s. Une exposition
qui suit produit un *pompage* insupportable. On copie le comportement de l'œil, qui est
**asymétrique** :

```js
// Game.update()
// Éblouissement : rapide (l'iris se ferme en ~1 s).
// Adaptation au noir : lente (plusieurs secondes, voire minutes).
const target = this.weather.exposure * (1.0 + 1.9 * cloudShade);
const tau = target < this.exposure ? 0.8 : 4.5;     // secondes
const k = 1 - Math.exp(-dt / tau);
this.exposure += (target - this.exposure) * k;
this.renderer.toneMappingExposure = this.exposure;
```

> **Attention à la boucle de rétroaction.** Ne jamais piloter l'exposition sur la luminance
> *mesurée* de l'image rendue (auto-exposure classique) : le joueur qui cadre son château
> blanc en gros plan verrait toute la scène s'assombrir. On la pilote sur l'**état météo**,
> qui est une donnée de simulation, pas sur un histogramme. C'est plus simple, plus stable, et
> plus contrôlable artistiquement.

#### Squelette de la machine

```js
// src/render/Weather.js
import { WEATHER, TRANSITIONS, DURATIONS } from './WeatherStates.js';

export class Weather {
  constructor(sky, post, moisture, water) {
    this.sky = sky; this.post = post;
    this.moisture = moisture; this.water = water;

    this.fromId = 'GRAND_BEAU';
    this.toId   = 'GRAND_BEAU';
    this.blend  = 1;            // 1 = arrivé
    this.blendDur = 1;
    this.hold   = pick(DURATIONS.GRAND_BEAU) * 60;
    this.state  = cloneState(WEATHER.GRAND_BEAU);
    this.forcedByHour = false;
  }

  /** Force un état (debug, scénario, ou imposition horaire). */
  transitionTo(id, seconds) {
    if (id === this.toId) return;
    this.fromId = this.toId;
    this.toId = id;
    this.blend = 0;
    this.blendDur = seconds ?? 45;
    this.hold = pick(DURATIONS[id]) * 60;
  }

  update(dt, dayT) {
    // 1. Le cycle jour/nuit a priorité absolue sur le tirage météo.
    const forced = dayT < 0.24 || dayT > 0.88 ? 'NUIT'
                 : dayT > 0.78 ? 'COUCHER'
                 : null;
    if (forced && this.toId !== forced) {
      this.diurnalMemory = this.toId;
      this.transitionTo(forced, forced === 'NUIT' ? 90 : 60);
    } else if (!forced && (this.toId === 'NUIT' || this.toId === 'COUCHER')) {
      // Retour au matin : on reprend la météo d'hier, à 30 % près.
      const back = Math.random() < 0.7 ? (this.diurnalMemory ?? 'GRAND_BEAU')
                                       : rollFrom('NUIT');
      this.transitionTo(back, 90);
    }

    // 2. Avancement du mélange.
    if (this.blend < 1) {
      this.blend = Math.min(1, this.blend + dt / this.blendDur);
    } else if (!forced) {
      this.hold -= dt;
      if (this.hold <= 0) this.transitionTo(rollFrom(this.toId));
    }

    const t = smoothstep(0, 1, this.blend);
    lerpWeather(WEATHER[this.fromId], WEATHER[this.toId], t, this.state);

    // 3. Application.
    this.sky.applyWeather(this.state);
    this.post.applyWeather(this.state);
    this.water.setWaveScale(this.state.waveHeight);
    this.water.setWindSpeed(this.state.windSpeed);

    // 4. Gameplay : c'est ici que la météo devient une mécanique.
    const shade = this.sky.clouds.shadowAt(0, 0);
    this.moisture.insolation = this.state.insolation * (1 - 0.75 * shade);
    this.moisture.wind = this.state.windSpeed / 12;
    if (this.state.rainRate > 0.05) {
      this.rain.emit(dt, this.state.rainRate);
      this.moisture.rain(dt, this.state.rainRate);
    }
  }
}
```

#### Récapitulatif gameplay

| État | `insolation` | `wind` | Évaporation relative | Pluie | Effet net sur le sable |
|---|---|---|---|---|---|
| Grand beau | 1,00 | 0,29 | **1,00** | 0 | sèche vite — arroser souvent |
| Voile de chaleur | 0,78 | 0,10 | 0,71 | 0 | sèche lentement, fenêtre confortable |
| Nuages épars | 0,25 – 1,00 | 0,46 | 0,50 – 1,08 | 0 | **sèche par vagues** |
| Grain tropical | 0,05 | 1,00 | 0,41 | 9 mm/h | **se gorge, les murs s'effondrent** |
| Coucher doré | 0,18 | 0,21 | 0,35 | 0 | tient, fenêtre de finition |
| Nuit claire | 0,00 | 0,17 | 0,23 + rosée | 0 | **se ré-humidifie tout seul** |

---

## 5. Nuages

### 5.1 Ce qu'il ne faut pas faire

Pas de raymarching volumétrique. Ni en WebGL2, ni en WebGPU, ni « juste un peu ». Un ciel
volumétrique correct coûte 2 à 6 ms en half-res, pour un ciel qui occupe **30 % du cadre**
derrière un tilt-shift qui le floute déjà. Le rapport qualité/prix est catastrophique ici.

Pas non plus de billboards de nuages. Ils demandent du tri par profondeur, ils poppent en
rotation de caméra, et ils sont mal éclairés dès que le soleil passe derrière.

### 5.2 Ce qu'il faut faire : deux briques indépendantes

| Brique | Coût | Impact visuel |
|---|---|---|
| **A. Couche procédurale dans le dôme de ciel** | ~25 ALU sur les pixels de ciel | moyen |
| **B. Texture d'ombre de nuage projetée au sol** | **1 texture fetch dans le shader de sable et d'eau** | **énorme** |

**Si l'on ne devait en faire qu'une, ce serait la B.** Une ombre de nuage qui balaie une plage
est l'un des effets les plus puissants du rendu extérieur, et il coûte trois lignes. Le joueur
regarde le sol, pas le ciel.

### 5.3 Brique A — couche de nuages dans le dôme

Rendue **dans le même draw call** que le ciel (pas de plan supplémentaire), en projetant la
direction de vue sur un plan à altitude `uCloudBase`. C'est la « projection en dôme
aplati » : elle donne gratuitement la compression perspective vers l'horizon.

```glsl
// --- à ajouter dans SKY_FRAG, juste avant le disque solaire ---
uniform float uCloudCoverage;   // 0..1
uniform float uCloudDensity;    // dureté du bord
uniform vec2  uCloudDrift;      // position, avancée par le CPU (m)
uniform float uCloudScale;      // 1/m
uniform vec3  uCloudLit;        // face éclairée
uniform vec3  uCloudDark;       // base ombragée

float sc_hash21(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}
float sc_vnoise2(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(sc_hash21(i),               sc_hash21(i + vec2(1, 0)), f.x),
             mix(sc_hash21(i + vec2(0, 1)),  sc_hash21(i + vec2(1, 1)), f.x), f.y);
}
float sc_fbm2(vec2 p, int oct) {
  float a = 0.5, s = 0.0, n = 0.0;
  // Rotation entre octaves : sans elle, la fbm produit une grille visible
  // le long des axes, très voyante sur des nuages.
  const mat2 R = mat2(0.80, 0.60, -0.60, 0.80);
  for (int i = 0; i < 5; i++) {
    if (i >= oct) break;
    s += a * sc_vnoise2(p); n += a;
    p = R * p * 2.07; a *= 0.5;
  }
  return s / n;
}

/**
 * Densité de nuage à une position 2D du plan de nuages.
 * Deux fbm superposées à des vitesses différentes : la basse fréquence donne
 * les amas, la haute donne les bourgeons. Elles dérivent séparément, ce qui
 * fait que les nuages se DÉFORMENT en avançant au lieu de glisser en bloc.
 */
float cloudDensity(vec2 p) {
  float base   = sc_fbm2(p * 0.85 + uCloudDrift * 0.85, 4);
  float detail = sc_fbm2(p * 3.10 + uCloudDrift * 1.35, 3);
  float d = base * 0.75 + detail * 0.25;
  // Le seuil de couverture est ce qui transforme un bruit en NUAGES.
  // uCloudDensity contrôle la dureté du bord : 0.25 = cumulus tranchés,
  // 0.55 = stratus mous.
  return smoothstep(1.0 - uCloudCoverage, 1.0 - uCloudCoverage + uCloudDensity, d);
}

// --- dans main(), après le dégradé de ciel ---
if (uCloudCoverage > 0.01 && h > 0.02) {
  // Projection dôme aplati : la division par h comprime naturellement les
  // nuages vers l'horizon. Le clamp évite la singularité à l'horizon exact.
  vec2 cp = d.xz / max(h, 0.075) * uCloudScale;
  float cov = cloudDensity(cp);

  // Éclairage : deux termes, et ils suffisent.
  //  - le bord tourné vers le soleil s'allume (diffusion vers l'avant) ;
  //  - la base reste sombre (le nuage s'auto-ombrage).
  float toSun = max(dot(d, uSunDir), 0.0);
  float rim   = pow(toSun, 5.0);
  // Gradient interne bon marché : on re-sample la densité DÉCALÉE VERS LE
  // SOLEIL. Si la densité y est plus forte, on est du côté ombre du bourgeon.
  float ahead = cloudDensity(cp + uSunDir.xz * 0.12);
  float selfShadow = clamp(1.0 - (ahead - cov) * 1.6, 0.35, 1.0);

  vec3 cloudCol = mix(uCloudDark, uCloudLit, selfShadow);
  cloudCol += uSunColor * rim * 0.55 * selfShadow;

  // Fondu près de l'horizon : sans lui, la projection 1/h étire les nuages
  // en traînées radiales infinies, ce qui est le défaut classique de cette
  // méthode et se voit immédiatement.
  float horizonFade = smoothstep(0.02, 0.26, h);
  sky = mix(sky, cloudCol, cov * horizonFade);
}
```

Réglages par état :

| État | `uCloudCoverage` | `uCloudDensity` | `uCloudLit` | `uCloudDark` | dérive |
|---|---|---|---|---|---|
| Grand beau | 0,00 | — | — | — | — |
| Voile de chaleur | 0,10 | 0,55 | `#F0EEE8` | `#D8D8DC` | 1,2 m/s |
| Nuages épars | **0,42** | **0,22** | `#FFFDF6` | `#8FA4BE` | 6,5 m/s |
| Grain tropical | 0,96 | 0,50 | `#8A929C` | `#3E464E` | 14 m/s |
| Coucher doré | 0,25 | 0,28 | `#FFC088` | `#7A5C7E` | 2,5 m/s |
| Nuit claire | 0,15 | 0,35 | `#3A4A66` | `#141C2C` | 2,0 m/s |

> Le couple `uCloudLit` / `uCloudDark` est ce qui fait qu'un nuage est **un volume** et pas une
> tache. En nuages épars, l'écart entre `#FFFDF6` et `#8FA4BE` est de 2,4 stops : c'est autant
> que l'écart soleil/ombre au sol. Un cumulus de beau temps est un objet très contrasté.

### 5.4 Brique B — l'ombre de nuage projetée au sol

C'est **l'effet le plus rentable de tout ce document.**

#### Principe

Pour un point `P` du sol, on remonte le rayon solaire jusqu'à l'altitude de la base des nuages,
et on échantillonne la même densité que dans le dôme :

```
t = (h_nuage − P.y) / L.y
UV_nuage = P.xz + L.xz × t
```

Une seule texture fetch, ou une fbm si on préfère tout garder procédural.

#### Génération : une texture, pas une fbm dans le shader de sable

Le shader de sable est déjà lourd (fbm triplanaire, sparkle, coupe géologique). **Ne pas y
ajouter une fbm 4 octaves.** On génère une **texture 512×512 R8, une fois au chargement**, on la
laisse en `RepeatWrapping`, et on fait défiler ses UV. Coût runtime : **1 fetch**.

```js
// src/render/CloudShadow.js
import * as THREE from 'three';

const TILE_M = 64;   // la texture couvre 64 m -> se répète tous les 64 m.
                     // Le domaine fait 10 m : la répétition est invisible.
const RES = 512;     // 12,5 cm par texel — largement assez pour une ombre floue.

export class CloudShadow {
  constructor() {
    this.texture = this._bake();
    this.drift = new THREE.Vector2(0, 0);
    this.uniforms = {
      uCloudShadowMap:  { value: this.texture },
      uCloudShadowDrift:{ value: this.drift },
      uCloudShadowScale:{ value: 1 / TILE_M },
      uCloudShadowGain: { value: 0.0 },   // 0 = pas de nuages
      uCloudBase:       { value: 22.0 },  // altitude de la base, en mètres
      uSunDirection:    { value: new THREE.Vector3(0.4, 0.8, 0.35) },
    };
    // Copie CPU pour shadowAt() : le gameplay a besoin de la valeur, pas le GPU.
    this._cpu = this._data;
  }

  /** fbm 2D tuilable, calculée sur CPU au chargement (~18 ms). */
  _bake() {
    const data = new Uint8Array(RES * RES);
    for (let y = 0; y < RES; y++) {
      for (let x = 0; x < RES; x++) {
        // Bruit TUILABLE : on échantillonne un bruit 4D sur un tore. C'est le
        // seul moyen d'avoir une texture qui se répète sans couture visible.
        const u = (x / RES) * Math.PI * 2;
        const v = (y / RES) * Math.PI * 2;
        let amp = 0.5, sum = 0, norm = 0, f = 1;
        for (let o = 0; o < 4; o++) {
          sum += amp * torusNoise(Math.cos(u), Math.sin(u),
                                  Math.cos(v), Math.sin(v), f);
          norm += amp; amp *= 0.5; f *= 2.03;
        }
        data[y * RES + x] = Math.round(255 * (sum / norm));
      }
    }
    this._data = data;
    const tex = new THREE.DataTexture(data, RES, RES, THREE.RedFormat);
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
    tex.minFilter = THREE.LinearMipmapLinearFilter;
    tex.magFilter = THREE.LinearFilter;
    tex.generateMipmaps = true;
    tex.needsUpdate = true;
    return tex;
  }

  update(dt, windDir, windSpeed) {
    // Les nuages avancent 2,5x plus vite que le vent au sol (cisaillement).
    this.drift.x -= windDir.x * windSpeed * 2.5 * dt / TILE_M;
    this.drift.y -= windDir.y * windSpeed * 2.5 * dt / TILE_M;
  }

  /**
   * Lecture CPU pour le gameplay : combien d'ombre au point (x, z) du monde ?
   * @returns {number} 0 = plein soleil, 1 = complètement ombragé
   */
  shadowAt(wx, wz) {
    const g = this.uniforms.uCloudShadowGain.value;
    if (g < 0.01) return 0;
    const L = this.uniforms.uSunDirection.value;
    const t = this.uniforms.uCloudBase.value / Math.max(L.y, 0.15);
    const u = ((wx + L.x * t) / TILE_M + this.drift.x) % 1;
    const v = ((wz + L.z * t) / TILE_M + this.drift.y) % 1;
    const x = Math.floor(((u % 1) + 1) % 1 * RES);
    const y = Math.floor(((v % 1) + 1) % 1 * RES);
    const d = this._cpu[y * RES + x] / 255;
    // Même seuil que le GPU, sinon le gameplay et l'image ne racontent pas
    // la même histoire.
    return g * smoothstep(this.cov0, this.cov1, d);
  }
}
```

#### Injection dans le shader de sable

Trois lignes dans le `onBeforeCompile` existant de `SandMaterial.js` :

```js
// 1. déclarations, dans le remplacement de #include <common> du fragment
uniform sampler2D uCloudShadowMap;
uniform vec2  uCloudShadowDrift;
uniform float uCloudShadowScale;
uniform float uCloudShadowGain;
uniform float uCloudBase;
uniform vec2  uCloudCov;          // (seuil, seuil + adoucissement)

float cloudShadowAt(vec3 worldPos, vec3 sunDir) {
  if (uCloudShadowGain < 0.01) return 0.0;
  // Remonte le rayon solaire jusqu'à la base des nuages.
  float t = (uCloudBase - worldPos.y) / max(sunDir.y, 0.15);
  vec2 uv = (worldPos.xz + sunDir.xz * t) * uCloudShadowScale + uCloudShadowDrift;
  float d = texture2D(uCloudShadowMap, uv).r;
  return uCloudShadowGain * smoothstep(uCloudCov.x, uCloudCov.y, d);
}
```

```js
// 2. application : elle ne touche QUE la lumière directe.
//    C'est le point crucial. Un nuage cache le SOLEIL, pas le ciel.
//    Multiplier l'ambiante aussi (l'erreur courante) donne une flaque noire
//    au lieu d'une ombre de nuage : l'ombre reste ÉCLAIRÉE par le reste du ciel.
.replace(
  '#include <lights_fragment_end>',
  /* glsl */ `
  #include <lights_fragment_end>
  {
    float cs = cloudShadowAt(vWorldPos, uSunDirection);
    reflectedLight.directDiffuse  *= (1.0 - cs);
    reflectedLight.directSpecular *= (1.0 - cs);
    // Compensation d'ambiante : sous un gros cumulus, le ciel visible est
    // partiellement masqué -> l'ambiante baisse un peu aussi, mais 4x moins.
    reflectedLight.indirectDiffuse *= (1.0 - cs * 0.22);
  }
  `
)
```

```js
// 3. le sparkle de quartz doit disparaître à l'ombre du nuage, sinon la
//    plage continue de scintiller sous un nuage — très voyant.
gl_FragColor.rgb += uSunColor * spec * density * 2.2 * uSparkle
                  * wetDamp * sun * sparkFade * (1.0 - cloudShadowAt(vWorldPos, L));
```

**Le même bloc va dans `WaterRenderer.js`** — une mer qui reste brillante sous une ombre de
nuage est immédiatement fausse. C'est même là que l'effet est le plus fort : les taches sombres
qui glissent sur un lagon turquoise.

#### Réglages

| État | `uCloudShadowGain` | `uCloudCov` | Vitesse au sol | Période de passage |
|---|---|---|---|---|
| Grand beau | 0,00 | — | — | — |
| Voile de chaleur | 0,12 | (0,50 · 0,80) | 3 m/s | ~30 s |
| **Nuages épars** | **0,80** | **(0,52 · 0,64)** | **16 m/s** | **~14 s** |
| Grain tropical | 0,10 | (0,10 · 0,45) | 35 m/s | — |
| Coucher doré | 0,45 | (0,58 · 0,76) | 6 m/s | ~40 s |
| Nuit claire | 0,30 | (0,62 · 0,82) | 5 m/s | ~50 s |

> **La vitesse au sol n'est pas la vitesse du nuage.** L'ombre se déplace à la vitesse du nuage
> **divisée par `sunDir.y`** dans la direction du soleil (projection oblique). Soleil à 30°
> d'élévation → l'ombre va **deux fois plus vite** que le nuage. C'est physiquement exact et
> c'est spectaculaire : en fin d'après-midi, les ombres de nuages traversent la plage en
> quelques secondes.

> **Piège de la couverture** : `uCloudShadowGain = 0.80` en nuages épars veut dire que le soleil
> chute à 20 % sous un nuage. Ne pas mettre 1,0 : même sous un cumulus opaque, la lumière
> diffusée par les bords du nuage donne toujours 10 à 25 % de l'éclairement direct. À 1,0,
> l'ombre de nuage est un trou noir mort.

---

## 6. Pluie et ses conséquences

La pluie n'est pas un effet de particules. C'est **quatre systèmes** qui doivent s'accorder,
et si l'un manque, l'illusion tombe :

| Système | Ce qu'il apporte | Coût |
|---|---|---|
| A. Traits de pluie | l'événement, la vitesse, le bruit visuel | 1 draw call |
| B. Impacts sur l'eau | l'échelle (chaque cercle fait 8 cm) | 15 ALU dans le shader d'eau |
| C. Assombrissement mouillé | **le vrai poids visuel** | ~gratuit, déjà écrit |
| D. Ruissellement | la conséquence, la mécanique | ~gratuit, déjà écrit |

**C et D existent déjà dans le projet.** `SandMaterial.js` a tout le modèle d'assombrissement
mouillé, `Water.js` a le modèle « pipe » de ruissellement, `Moisture.js` a la percolation. La
pluie n'a qu'à leur **injecter de l'eau**. C'est la meilleure nouvelle de cette section.

### 6.1 A — les traits de pluie

Un seul `Points` de 4 000 particules, dans une **boîte qui suit la caméra** et se répète
modulo. Aucune allocation, aucun tri, aucune mise à jour CPU : tout est calculé dans le vertex
shader à partir d'une graine fixe et du temps.

```js
// src/render/Rain.js
import * as THREE from 'three';

const COUNT = 4000;
const BOX   = new THREE.Vector3(16, 9, 16);   // la boîte suit la caméra

const VERT = /* glsl */ `
uniform float uTime;
uniform vec3  uBox;
uniform vec3  uCamPos;
uniform vec3  uWind;        // m/s
uniform float uFall;        // vitesse de chute, m/s (~7 pour une grosse goutte)
uniform float uRate;        // 0..1 : fraction des gouttes actives
uniform float uSizePx;
attribute vec3 aSeed;       // position initiale normalisée 0..1 + phase
varying float vAlpha;

void main() {
  // Position enroulée : la goutte tombe et rebrousse en haut de la boîte.
  // fract() fait le modulo gratuitement, il n'y a RIEN à mettre à jour côté CPU.
  float t = uTime + aSeed.z * 97.3;
  vec3 p;
  p.y = uBox.y * fract(aSeed.y - t * uFall / uBox.y);
  // La dérive du vent doit aussi être enroulée, sinon la pluie "part" au loin.
  p.x = uBox.x * (fract(aSeed.x + t * uWind.x / uBox.x) - 0.5);
  p.z = uBox.z * (fract(aSeed.z + t * uWind.z / uBox.z) - 0.5);

  // Ancrage sur la caméra, quantifié au mètre : sans la quantification, la
  // boîte glisse continûment et la pluie a l'air de "suivre" le joueur.
  p.xz += floor(uCamPos.xz);
  p.y  += floor(uCamPos.y) - uBox.y * 0.35;

  // Extinction des gouttes en trop quand le taux baisse : on éteint TOUJOURS
  // les mêmes (seuil sur la graine), sinon la pluie clignote au lieu de
  // s'éclaircir.
  vAlpha = step(fract(aSeed.x * 31.7 + aSeed.y * 17.3), uRate);
  // Les gouttes proches sont plus visibles (parallaxe).
  float d = length(p - uCamPos);
  vAlpha *= smoothstep(14.0, 1.2, d);

  vec4 mv = modelViewMatrix * vec4(p, 1.0);
  gl_Position = projectionMatrix * mv;
  gl_PointSize = uSizePx / max(-mv.z, 0.5);
}
`;

const FRAG = /* glsl */ `
uniform vec3 uColor;
uniform float uStretch;
varying float vAlpha;
void main() {
  // Trait vertical : on écrase le point sur X. Bien moins cher que des quads
  // orientés, et à cette taille personne ne voit la différence.
  vec2 c = gl_PointCoord - 0.5;
  float a = smoothstep(0.5, 0.0, length(vec2(c.x * uStretch, c.y)));
  gl_FragColor = vec4(uColor, a * vAlpha * 0.55);
}
`;

export class Rain {
  constructor(scene) {
    const seeds = new Float32Array(COUNT * 3);
    for (let i = 0; i < COUNT * 3; i++) seeds[i] = Math.random();
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(COUNT * 3), 3));
    geo.setAttribute('aSeed', new THREE.BufferAttribute(seeds, 3));
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 999); // jamais cullé

    this.uniforms = {
      uTime:    { value: 0 },
      uBox:     { value: BOX },
      uCamPos:  { value: new THREE.Vector3() },
      uWind:    { value: new THREE.Vector3(2, 0, 1) },
      uFall:    { value: 7.0 },
      uRate:    { value: 0 },
      uSizePx:  { value: 46 },
      uStretch: { value: 5.0 },
      // La pluie est un MIROIR : elle prend la couleur du ciel, jamais du gris.
      uColor:   { value: new THREE.Color(0xC8D8E4) },
    };

    this.mesh = new THREE.Points(geo, new THREE.ShaderMaterial({
      uniforms: this.uniforms,
      vertexShader: VERT, fragmentShader: FRAG,
      transparent: true,
      depthWrite: false,        // indispensable : sinon les gouttes s'occultent
      blending: THREE.NormalBlending,
      toneMapped: true,
    }));
    this.mesh.frustumCulled = false;
    scene.add(this.mesh);
  }

  update(dt, camera, state) {
    this.uniforms.uTime.value += dt;
    this.uniforms.uCamPos.value.copy(camera.position);
    // rainRate mm/h -> densité visible. 9 mm/h = grain, uRate = 1.
    this.uniforms.uRate.value = THREE.MathUtils.clamp(state.rainRate / 9, 0, 1);
    // Plus il pleut, plus les gouttes sont grosses et rapides.
    this.uniforms.uFall.value = 5.5 + 2.5 * this.uniforms.uRate.value;
    this.uniforms.uWind.value.set(state.windSpeed * 0.55, 0, state.windSpeed * 0.25);
    this.uniforms.uStretch.value = 3.5 + state.windSpeed * 0.25;
    this.mesh.visible = this.uniforms.uRate.value > 0.02;
  }
}
```

> **Trois pièges de la pluie de particules, tous vus mille fois :**
>
> 1. **Pluie grise.** Une goutte est de l'eau transparente : elle ne fait que **réfléchir et
>    réfracter le ciel**. Sa couleur doit être `uHorizon` légèrement éclaircie, jamais un gris
>    neutre. Une pluie grise sur un ciel bleu-gris est invisible ; une pluie qui prend la
>    couleur du ciel *scintille*.
> 2. **`depthWrite: true`.** Les gouttes s'occultent entre elles, on voit des trous
>    rectangulaires. Toujours `false`.
> 3. **Boîte non quantifiée.** Si la boîte suit la caméra en continu, la pluie semble
>    accrochée au joueur, ce qui est immédiatement faux. `floor(uCamPos)` règle le problème
>    en un caractère.

### 6.2 B — impacts et cercles sur l'eau

Le motif de cercles concentriques se fait en **grille de cellules** (façon Worley) : chaque
cellule contient une goutte à une position et une phase aléatoires. Coût constant, densité
réglable.

```glsl
// WaterRenderer.js — à injecter dans le calcul de la normale de surface
uniform float uRainRate;      // mm/h
uniform float uTime;

/**
 * Perturbation de normale due aux impacts de pluie.
 * Grille de 12 cm : à 9 mm/h on a environ 1 impact actif par cellule à la fois,
 * ce qui donne visuellement la bonne densité.
 */
vec3 rainRipples(vec2 worldXZ, float rate) {
  if (rate < 0.05) return vec3(0.0, 1.0, 0.0);

  const float CELL = 0.12;              // 12 cm
  vec2 g  = worldXZ / CELL;
  vec2 gi = floor(g);
  vec2 gf = fract(g);

  vec3 n = vec3(0.0, 1.0, 0.0);
  // 3x3 cellules : un cercle peut déborder sur les voisines.
  for (int y = -1; y <= 1; y++) {
    for (int x = -1; x <= 1; x++) {
      vec2 cell = gi + vec2(float(x), float(y));
      vec3 h = sc_hash33(vec3(cell, 0.0));

      // Densité : à faible pluie, la plupart des cellules sont inactives.
      if (h.z > rate * 0.11) continue;

      // Phase : chaque cellule a son propre cycle décalé.
      float period = 1.10 + h.z * 0.9;
      float phase  = fract(uTime / period + h.x * 7.31);

      vec2  center = cell + h.xy * 0.8 + 0.1;
      float d = length(g - center) * CELL;          // en mètres

      // Le cercle s'étend à ~0,7 m/s et s'éteint en une période.
      float r = phase * 0.72 * period;
      float ring = exp(-pow((d - r) * 26.0, 2.0));  // anneau gaussien
      float decay = (1.0 - phase) * (1.0 - phase);  // amortissement

      // Pente radiale de la ride : une onde amortie, pas une bosse.
      vec2 dir = normalize(g - center + 1e-5);
      float slope = ring * decay * 0.85 * sin((d - r) * 78.0);
      n.xz += dir * slope;
    }
  }
  return normalize(n);
}
```

Application, dans le shader d'eau :

```glsl
vec3 rippleN = rainRipples(vWorldPos.xz, uRainRate);
// On mélange, on ne remplace pas : la houle reste dessous.
normal = normalize(mix(normal, normalize(normal + rippleN * 0.9), 0.75));

// La pluie CASSE le reflet spéculaire : une mer sous la pluie n'est pas un
// miroir, elle est mate. C'est ce qui vend l'effet plus que les cercles.
roughness = mix(roughness, 0.42, clamp(uRainRate / 9.0, 0.0, 1.0));
```

> **Le point contre-intuitif** : ce qui « fait pluie » sur l'eau, ce n'est pas les cercles, c'est
> **la perte du reflet**. Une surface d'eau calme est un miroir presque parfait (Fresnel proche
> de 1 en incidence rasante) ; couverte d'impacts, elle diffuse. Si l'on ne fait qu'ajouter des
> cercles sans monter la rugosité, on obtient une jolie texture sur un miroir — ce qui ne
> ressemble à rien.

### 6.3 C — l'assombrissement mouillé

**Rien à écrire.** `SandMaterial.js` contient déjà le modèle complet :

```glsl
float ws = 1.0 - exp(-moist * 7.5);
float lumWet = pow(lum, 1.0 + 0.95 * ws) * mix(1.0, 0.72, ws);
```

C'est le modèle de Lagarde (l'eau remplit les pores, l'écart d'indice diminue, la lumière
subit plus de réflexions internes avant de ressortir) appliqué sur la **luminance seule** —
un excellent choix, qui évite de faire virer un sable jaune vers l'orange fluo.

Et la rugosité suit déjà :

```glsl
roughnessFactor = mix(0.98, 0.34, smoothstep(0.02, 0.55, vData.x));
```

**Deux ajouts seulement**, pour que la pluie soit lisible *pendant* qu'elle tombe et pas
seulement après :

```glsl
// (1) FILM D'EAU DE SURFACE, distinct de la saturation du sable.
// Il apparaît en quelques secondes de pluie et disparaît en quelques secondes
// après. C'est ce qui donne la brillance IMMÉDIATE — la saturation du sable,
// elle, met des minutes à monter.
uniform float uSurfaceWetness;   // 0..1, piloté par la pluie récente

float upFacing = clamp(normal.y, 0.0, 1.0);
float film = uSurfaceWetness * upFacing * upFacing;   // seules les faces vers le haut
roughnessFactor = mix(roughnessFactor, 0.09, film * 0.8);
// Le film assombrit encore un peu : il ajoute une interface air/eau qui
// réfléchit spéculairement au lieu de laisser passer.
diffuseColor.rgb *= mix(1.0, 0.86, film);

// (2) RIDES DE PLUIE sur le sable mouillé, comme sur l'eau mais 4x plus faibles :
// le sable amortit énormément.
if (uRainRate > 0.05 && film > 0.15) {
  vec3 rn = rainRipples(vWorldPos.xz, uRainRate);
  normal = normalize(normal + (rn - vec3(0.0, 1.0, 0.0)) * 0.22 * film);
}
```

`uSurfaceWetness` est un simple premier ordre asymétrique, côté CPU :

```js
// Game.update()
const target = Math.min(1, state.rainRate / 4.0);
// Mouille vite (3 s), sèche lentement (25 s en beau temps, plus vite au vent).
const tau = target > this.surfaceWetness ? 3.0 : 25.0 / (1 + state.windSpeed / 6);
this.surfaceWetness += (target - this.surfaceWetness) * (1 - Math.exp(-dt / tau));
sandUniforms.uSurfaceWetness.value = this.surfaceWetness;
```

> **Pourquoi séparer `uSurfaceWetness` de `moisture`** : ce sont deux phénomènes de constantes
> de temps très différentes. Le film de surface apparaît en 3 s et part en 25 s ; la saturation
> du sable met des minutes à monter et des dizaines de minutes à redescendre. Les confondre
> donne soit une pluie qui n'a aucun effet visible immédiat, soit un sable qui redevient sec en
> vingt secondes. Le joueur perçoit les deux, séparément.

### 6.4 D — brancher la pluie sur la simulation existante

Trois points d'injection, tous petits.

#### (i) Apport d'eau dans `Moisture`

```js
// src/sim/Moisture.js — nouvelle méthode
/**
 * Apport de pluie. Ajoute une lame d'eau au voxel de surface de chaque colonne
 * exposée au ciel ; la percolation et la diffusion existantes font le reste.
 *
 * @param {number} dt        secondes
 * @param {number} rateMmH   intensité, mm/h
 * @param {number} shelter   0..1, fraction de colonnes abritées (0 = tout exposé)
 */
rain(dt, rateMmH, shelter = 0) {
  if (rateMmH < 0.01) return;

  // mm/h -> m/s de lame d'eau.
  const rateMs = (rateMmH / 1000) / 3600;
  // TIME_SCALE aligne le temps de simulation sur le temps de jeu, exactement
  // comme pour l'évaporation. Sans lui, 9 mm/h met 40 minutes réelles à faire
  // quoi que ce soit.
  const lame = rateMs * TIME_SCALE.rain * dt;
  // Lame d'eau -> saturation gagnée sur un voxel : une lame `lame` remplit
  // `lame / POROSITY` de hauteur de voxel.
  const dSat = lame / (VOXEL * POROSITY);
  if (dSat < 1e-6) return;

  const F = this.field, dens = F.density, mois = F.moisture;

  // Balayage roulant, comme le solveur : on ne traite qu'une fraction des
  // colonnes par tick, la pluie n'a aucun besoin d'être instantanée.
  const stride = 4;
  this.rainPhase = (this.rainPhase + 1) % stride;
  const add = Math.round(dSat * 255 * stride * (1 - shelter));
  if (add <= 0) return;

  for (let z = 0; z < NZ; z++) {
    for (let x = (z + this.rainPhase) % stride; x < NX; x += stride) {
      const col = x + NX * z;
      const top = F.topY[col];
      if (top < 0) continue;
      const i = col + SLICE * top;
      if (dens[i] < ISO) continue;
      const before = mois[i];
      mois[i] = Math.min(255, before + add);
      if (mois[i] !== before) this.touchColumn(x, z);
    }
  }
}
```

#### (ii) Ruissellement : l'eau de surface, dans `Water`

Le modèle « pipe » de `Water.js` transporte déjà l'eau de surface et l'érosion hydraulique
(Mei et al.) creuse déjà des rigoles. **Il suffit d'ajouter de la hauteur d'eau partout.**

```js
// src/sim/Water.js
/**
 * Pluie sur la grille d'eau de surface.
 * Ce qui n'est pas infiltré par Moisture ruisselle : c'est le solveur existant
 * qui s'en charge, et l'érosion aussi. Une averse creuse donc de vraies
 * rigoles sur les flancs du château, gratuitement.
 */
rain(dt, rateMmH) {
  if (rateMmH < 0.01) return;
  // Seule la fraction NON infiltrée arrive en surface. Le sable sec absorbe
  // presque tout ; le sable saturé n'absorbe plus rien et tout ruisselle.
  const rateMs = (rateMmH / 1000) / 3600 * TIME_SCALE.rain;
  const h = this.height;
  for (let c = 0; c < h.length; c++) {
    // Capacité d'infiltration résiduelle de la colonne, calculée par Moisture.
    const runoff = 1 - this.moisture.infiltrationCapacity(c);   // 0..1
    if (runoff <= 0.01) continue;
    h[c] += rateMs * dt * runoff;
  }
  this.wakeAll();
}
```

> **La conséquence de gameplay est excellente et elle est gratuite.** Au début du grain, le
> sable sec absorbe tout : rien ne ruisselle, la pluie « ne fait rien ». Puis la saturation
> monte, `runoff` grimpe, et d'un coup l'eau se met à couler **sur** le château au lieu de
> dedans. L'érosion hydraulique existante creuse alors des rigoles dans les flancs, et les
> tours s'effondrent. Le grain a donc un **arc dramatique en trois temps** — rien ne se passe,
> puis tout arrive — sans une ligne de scénarisation.

#### (iii) Impacts sur l'eau libre

```js
// Les impacts agitent la surface : on injecte du flux aléatoire dans la
// grille d'eau. Sans ça, une flaque sous la pluie reste parfaitement lisse,
// ce qui trahit tout.
rainAgitation(dt, rateMmH) {
  const amp = (rateMmH / 9) * 0.0006;
  if (amp < 1e-6) return;
  for (let k = 0; k < 60; k++) {
    const c = (Math.random() * this.height.length) | 0;
    if (this.height[c] < WATER_EPSILON) continue;
    this.fluxL[c] += (Math.random() - 0.5) * amp;
    this.fluxT[c] += (Math.random() - 0.5) * amp;
  }
}
```

### 6.5 Ce qui arrive après la pluie

Trois effets à ne pas oublier, sans quoi la sortie du grain est plate :

1. **Le sable garde sa couleur foncée** plusieurs minutes. C'est déjà le cas : `moisture`
   décroît lentement. Le contraste entre les zones qui sèchent en premier (les crêtes exposées
   au vent) et celles qui restent sombres (les creux, le pied nord des murs) est une **carte
   d'humidité visible**. Elle raconte la topographie mieux que n'importe quel AO.
2. **Les flaques.** L'eau de surface piégée dans les creux met du temps à s'infiltrer
   (`INFILTRATION_RATE = 4e-5 m/s`, soit ~25 s pour 1 mm). Ces flaques réfléchissent le ciel
   qui se dégage : ce sont les premiers morceaux de bleu qui reviennent dans l'image.
3. **Le bloom de la sortie de grain.** Quand le soleil repasse, l'exposition met 4,5 s à
   redescendre (§4.7). Pendant ces quelques secondes, la scène est **surexposée** et le bloom
   déborde. Ce n'est pas un défaut : c'est exactement ce que fait l'œil, et c'est la meilleure
   récompense visuelle qu'on puisse offrir après un grain. **Ne pas la corriger.**

---

## 7. Post-traitement pour le contraste

### 7.1 Le tone mapping : garder ACES, et pourquoi

Trois candidats sérieux en 2026, tous disponibles dans three.js.

| | **ACESFilmic** | **AgX** | **Khronos PBR Neutral** |
|---|---|---|---|
| Épaule (highlight rolloff) | longue, très douce | très longue | courte |
| Entrée max avant écrêtage | ~16 | ~40 | ~4 |
| Saturation des tons moyens | −8 % | **−22 %** | **0 %** (1:1) |
| Saturation des hautes lumières | forte désaturation | forte désaturation | désaturation contrôlée |
| Décalage de teinte | oui (bleu → cyan, rouge → orange) | faible | aucun |
| Usage prévu | cinéma, jeux HDR | rendu neutre, VFX | e-commerce, matériaux |

**Verdict : `ACESFilmicToneMapping`.**

1. Notre scène a une **grosse dynamique spéculaire** : le reflet du soleil sur l'eau atteint
   8 à 25 en linéaire, les facettes de quartz 3 à 6. Il faut une longue épaule. PBR Neutral
   écrête tout ce qui dépasse 4 : le chemin d'argent sur l'eau deviendrait une tache blanche
   uniforme.
2. Le **décalage de teinte d'ACES joue en notre faveur ici**. Le défaut le mieux documenté
   d'ACES est de faire virer les bleus saturés vers le cyan et les rouges vers l'orange en
   montant en luminance. Sur une eau turquoise et un sable ambré, c'est **exactement la dérive
   qu'on veut** : l'eau devient plus cyan quand elle est éclairée, le sable plus orange.
   La honte des uns fait le bonheur des autres.
3. AgX est trop désaturant (−22 % sur les tons moyens) pour un brief qui demande des couleurs
   franches. On passerait la moitié du budget d'étalonnage à récupérer ce qu'AgX vient
   d'enlever.

**Ce qu'on corrige** : la désaturation résiduelle d'ACES, en remontant la saturation **après**
le tone mapping (§7.4). C'est le bon endroit — remonter la saturation avant tone mapping ne
fait qu'alimenter le décalage de teinte.

Comportement d'ACES sur nos valeurs clés, avec `exposure = 0.78` :

| Élément | Linéaire | Après ACES | sRGB | Note |
|---|---|---|---|---|
| Sable au soleil | 0,91 | 0,79 | **0,90** | brûle sans boucher |
| Écume | 1,45 | 0,88 | 0,95 | |
| Sable à l'ombre | 0,134 | 0,145 | **0,42** | lisible et bleu |
| Sparkle de quartz | 4,2 | 0,975 | 0,99 | + bloom |
| Reflet solaire sur l'eau | 18 | 0,998 | 1,00 | ++ bloom |
| Eau profonde | 0,061 | 0,072 | 0,30 | |

**Pente locale de la courbe ACES à 0,91 linéaire : 0,35.** Une variation d'albédo de ±10 % dans
le sable (le `grain` et le `macro` du shader) se traduit donc par **±3,5 %** de variation à
l'écran, soit ±9 niveaux sur 255. **C'est visible.** C'est ce qui garantit qu'on garde de la
texture dans le sable blanc — détaillé au §7.5.

### 7.2 Diagnostic quantifié : avant / après

Les cinq mesures qui décrivent le look, avant et après ce document.

| Mesure | **Avant** | **Après** | Gain |
|---|---|---|---|
| Ratio soleil / remplissage | 1,9 : 1 | **5,8 : 1** | ×3,1 |
| Écart soleil/ombre sur le sable (stops) | 1,5 | **2,8** | +1,3 stop |
| Sable au soleil (sRGB) | 0,85 | 0,90 | +6 % |
| Sable à l'ombre (sRGB) | **0,55** | **0,42** | −24 % ← l'essentiel du gain |
| Saturation moyenne de l'image (HSL) | 0,21 | **0,34** | ×1,6 |
| Rapport de luminance zénith/horizon | 1 : 2,8 | **1 : 4,4** | ×1,6 |
| Pénombre au sommet d'une tour de 50 cm | 18 mm **uniforme** | 18 mm au sommet, **0,4 mm à la base** | contact hardening réel |
| Pixels atteints par le bloom | **0 %** | 1,8 % | le bloom existe |
| Teinte de l'ombre (H, S) | 38° / 11 % (beige) | **214° / 26 %** (bleu) | l'ombre a une couleur |

> **Le chiffre qui compte n'est pas « le sable est plus clair », c'est « l'ombre est plus
> sombre ».** −24 % sur l'ombre contre +6 % sur la lumière. Le contraste ne se gagne jamais en
> montant les hautes lumières (on les boucherait) : il se gagne en **descendant les ombres et
> en leur donnant une couleur**.

### 7.3 Bloom : le remettre en service

`UnrealBloomPass(resolution, strength, radius, threshold)` — valeurs actuelles :
`0.17, 0.32, 1.45`. Avec un maximum de scène à 0,64 linéaire, **le seuil de 1,45 n'est jamais
franchi.** La passe est un no-op coûteux.

```js
// Post.js
this.bloom = new UnrealBloomPass(new THREE.Vector2(w, h),
  0.32,   // strength  (était 0.17)
  0.30,   // radius    (était 0.32 — on RESSERRE encore, cf. ci-dessous)
  1.10    // threshold (était 1.45 — inatteignable)
);

// Genou souple : UnrealBloomPass met smoothWidth à 0.01, soit un seuil
// quasi binaire. Un pixel à 1.09 ne bloome pas, celui à 1.11 bloome à fond ->
// la ligne de crête de chaque vague CLIGNOTE quand elle passe le seuil.
// 0.35 donne une entrée progressive et supprime le scintillement.
this.bloom.highPassUniforms.smoothWidth.value = 0.35;
```

**Pourquoi un seuil à 1,10 et pas 1,0** : à 1,0, le seuil coïncide avec l'écume (1,45 linéaire,
mais avec la variation du bruit certaines crêtes descendent sous 1,1). On veut que le bloom
attrape :

| Source | Valeur linéaire | Bloome ? |
|---|---|---|
| Sable au soleil | 0,91 | **non** ← non négociable |
| Écume de vague | 1,45 | oui, doucement |
| Facette de quartz (`sparkle`) | 3 – 6 | oui |
| Reflet solaire sur l'eau | 8 – 25 | oui, fortement |
| Disque solaire dans le ciel | ~60 | oui, très fortement |

> **Le sable ne doit JAMAIS bloomer.** C'est la règle n°1 du bloom en scène de plein soleil.
> Un sable qui bloome perd instantanément son grain, ses traces d'outil et ses arêtes de
> créneaux : on se retrouve avec une purée blanche, et on a refabriqué le look lavé par un
> autre chemin. Si l'on monte l'exposition d'un état météo au point que le sable dépasse 1,10,
> il faut **remonter le seuil de bloom du même état** (voir la table du §8).

**Rayon court, toujours.** `radius = 0.30` étale la floraison sur ~2,5 % de la hauteur d'écran.
Au-delà (0,6 – 0,8, valeurs par défaut de beaucoup de tutoriels), les hautes lumières du ciel et
de l'eau se répandent sur tout le cadre et **le diorama disparaît sous un voile laiteux** — la
même maladie que le fog, par une autre porte.

**Filet anamorphique du soleil (optionnel, mode photo uniquement).** Un `strength` supplémentaire
sur un bloom étiré horizontalement (ratio 2:1) uniquement sur les pixels au-dessus de 6,0
linéaire — c'est-à-dire le disque solaire et le chemin d'argent. C'est le seul « lens flare »
défendable : pas de fantômes hexagonaux, pas de cercles d'iris. Une traînée horizontale douce
sur la réflexion du soleil, et rien d'autre.

### 7.4 L'étalonnage : la passe `DioramaShader`, corrigée

Six changements dans `Post.js`. Les valeurs sont **en sRGB**, appliquées après `OutputPass`
(l'ordre actuel est correct, on n'y touche pas).

```js
uniforms: {
  // ... tilt-shift et aberration inchangés ...

  // --- ÉTALONNAGE TROPICAL ------------------------------------------------
  // Lift / Gamma / Gain, convention colorimétrique standard :
  //   out = pow(in * gain + lift, 1/gamma)
  // Lift agit sur les NOIRS, gain sur les BLANCS, gamma sur les TONS MOYENS.
  //
  // Look "lagon des Caraïbes à midi" :
  //   - noirs tirés vers le bleu-cyan   (l'ombre est éclairée par le ciel)
  //   - tons moyens réchauffés          (le rebond du sable domine)
  //   - blancs à peine ambrés           (le soleil est à 5600 K, pas 6500)
  // C'est un "teal & orange" ancré dans la physique et non dans la mode.
  uLift:  { value: new THREE.Vector3(-0.014,  0.000,  0.026) },
  uGamma: { value: new THREE.Vector3( 0.975,  1.000,  1.030) },
  uGain:  { value: new THREE.Vector3( 1.045,  1.015,  0.968) },

  // Contraste en S autour d'un pivot. 0.42 en sRGB = le gris moyen 18 %.
  // Un pivot à 0.5 (l'erreur courante) assombrit tout : la moitié du sable
  // est au-dessus de 0.5 et n'a nulle part où monter.
  uContrast:      { value: 1.18 },
  uContrastPivot: { value: 0.42 },

  // Saturation. 1.26 récupère la désaturation d'ACES ET pousse au-delà.
  uSaturation: { value: 1.26 },
  // Protection : au-dessus de ce seuil de luminance, on n'ajoute plus de
  // saturation. Sans ça, le sable brûlé devient orange fluo au lieu de blanc
  // chaud, et l'écume devient bleue.
  uSatRolloff: { value: 0.82 },

  uVignette: { value: 0.22 },
  uGrain:    { value: 0.012 },
  uHeatShimmer: { value: 0.0015 },
  uHorizonY:    { value: 0.62 },
}
```

Le fragment correspondant, en remplacement du bloc `--- etalonnage ---` :

```glsl
// --- étalonnage ------------------------------------------------------------
col = max(col, 0.0);

// 1. LIFT / GAMMA / GAIN
col = col * uGain + uLift;
col = pow(max(col, 0.0), 1.0 / uGamma);

// 2. CONTRASTE autour du pivot 18 %.
//    Une multiplication autour d'un pivot, pas une courbe en S mélangée à 7 % :
//    c'est prévisible, monotone, et ça se règle avec UN chiffre.
col = (col - uContrastPivot) * uContrast + uContrastPivot;

// 3. SATURATION avec protection des hautes lumières.
float lum = dot(col, vec3(0.2126, 0.7152, 0.0722));
// Le gain de saturation retombe à 1.0 quand la luminance dépasse uSatRolloff.
// C'est CE terme qui empêche le sable brûlé de virer orange fluo.
float satGain = mix(uSaturation, 1.0, smoothstep(uSatRolloff, 1.0, lum));
col = mix(vec3(lum), col, satGain);

// 4. SÉPARATION CHAUD/FROID (le "split toning" du coloriste).
//    On pousse le chaud dans les hautes lumières et le froid dans les basses,
//    proportionnellement à la LUMINANCE. Deux vec3, 6 ALU, et l'image gagne
//    la profondeur que le grading global ne donne pas.
float shadowW = 1.0 - smoothstep(0.0, 0.45, lum);
float highW   = smoothstep(0.55, 1.0, lum);
col += uSplitCool * shadowW * 0.055;   // uSplitCool = vec3(-0.30, 0.05, 1.00)
col += uSplitWarm * highW   * 0.030;   // uSplitWarm = vec3( 1.00, 0.42,-0.30)

col = clamp(col, 0.0, 1.0);
```

**Ce qui a changé et pourquoi :**

| | Avant | Après | Raison |
|---|---|---|---|
| `uSaturation` | 1,10 | **1,26** | 1,10 ne compense même pas la désaturation d'ACES |
| Contraste | `mix(col, S(col), 0.07)` | `(col−0.42)×1.18+0.42` | 0,07 de mélange sur une courbe douce ≈ +2 % de contraste. Invisible. |
| `uLift` | `(-0.006, 0, +0.010)` | `(-0.014, 0, +0.026)` | 2,5× plus fort — c'est ce qui bleuit les ombres |
| `uGain` | `(1.028, 1.004, 0.972)` | `(1.045, 1.015, 0.968)` | idem, assumé |
| `uGamma` | absent | `(0.975, 1.0, 1.030)` | manquait : sans lui, on ne peut pas réchauffer les **tons moyens** indépendamment |
| Protection des hautes lumières | absente | `uSatRolloff = 0.82` | **indispensable** dès qu'on monte la saturation |
| Split toning | absent | ±0,055 / ±0,030 | c'est ce qui « fait cinéma » |
| `uGrain` | 0,020, **pondéré vers les ombres** | 0,012, **pondéré vers les tons moyens** | voir ci-dessous |

**Le grain était à l'envers.** Le code actuel :

```glsl
col += g * uGrain * (0.35 + 0.65 * (1.0 - clamp(lum, 0.0, 1.0)));
```

Il concentre le bruit **dans les ombres**, ce qui monte leur plancher perçu et les rend
laiteuses. Sur une pellicule, le grain est maximal dans les **tons moyens** et minimal aux
deux extrêmes (les zones sombres n'ont pas assez de cristaux exposés, les zones claires les
ont toutes exposés). La bonne pondération est une cloche :

```glsl
float grainW = 4.0 * lum * (1.0 - lum);   // = 1 à lum 0.5, = 0 aux extrêmes
col += g * uGrain * grainW;
```

### 7.5 Garder de la lecture dans les hautes lumières du sable blanc

C'est le risque n°1 de ce document : en montant le contraste, on peut boucher le sable et
perdre tout ce que le shader de sable fabrique si soigneusement (grain, micro-dunes, traces
d'outil, arêtes de créneaux). **Cinq garde-fous.**

#### (1) Plafonner le sable à 0,91 linéaire, pas plus

À 0,91 linéaire × `0.78/0.6` = 1,18 en entrée d'ACES, la pente locale de la courbe est **0,35**.
À 1,60 linéaire, elle tombe à **0,13**. La différence est brutale :

| Sable au soleil (linéaire) | Pente ACES | Variation visible pour ±10 % d'albédo |
|---|---|---|
| 0,70 | 0,48 | ±4,8 % — très lisible |
| **0,91** | **0,35** | **±3,5 % (±9/255)** — lisible ✔ |
| 1,30 | 0,19 | ±1,9 % (±5/255) — limite |
| 1,80 | 0,11 | ±1,1 % (±3/255) — **bouché** |
| 2,50 | 0,06 | ±0,6 % — bouché, texture perdue |

**C'est ce tableau qui fixe `sun.intensity = 5.0` et `exposure = 0.78`, et rien d'autre.**
Si l'on veut un sable « plus blanc », il ne faut **pas** monter l'exposition : il faut monter le
`uDryColor` (l'albédo) et *baisser* l'exposition. On gagne alors en clarté sans perdre en pente.
C'est d'ailleurs déjà la direction prise : `uDryColor` est passé de `0xe4cfa2` à `0xf0e0bd`.

#### (2) Ne jamais laisser le bloom mordre sur le sable

Cf. §7.3. Seuil de bloom **toujours au-dessus** de la valeur du sable éclairé, dans **chaque**
état météo. C'est la contrainte qui pilote la colonne `bloomThreshold` du §8.

#### (3) Préserver l'amplitude du bruit d'albédo

Dans `SandMaterial.js` :

```glsl
vec3 base = uDryColor * (0.90 + 0.20 * grain) * (0.95 + 0.10 * macro);
```

Cela fait ±10 % (grain) × ±5 % (macro), soit **±15 % d'amplitude crête à crête**. Après la
pente ACES de 0,35 : ±5 % à l'écran, soit **±13 niveaux**. C'est parfaitement lisible. **Ne pas
réduire ces amplitudes** en cherchant un sable « plus propre » : la propreté, en plein soleil,
c'est l'aplat.

#### (4) Compter sur la normale, pas sur l'albédo

En plein soleil, la variation de `N·L` est un levier **beaucoup plus fort** que la variation
d'albédo. Une micro-dune qui incline la normale de 8° fait varier `N·L` de `cos(0°)` à
`cos(8°)` = −1 % seulement au zénith… mais avec le soleil à 60° d'élévation, la même
inclinaison fait varier `N·L` de 12 %. **Le relief se lit d'autant mieux que le soleil est
bas.** Deux conséquences de direction :

- Le midi écrasant **aplatit le relief**. C'est le prix du brief, et c'est vrai en photo.
  On le compense par l'AO baké (déjà présent) et par le contraste d'ombre portée.
- Le soleil de 10 h ou de 16 h (élévation 40-45°) est **le meilleur moment pour montrer une
  sculpture**. Si le jeu a un « mode photo », son heure par défaut devrait être là, pas à midi.

#### (5) Le sparkle est un signal de haute fréquence qui survit au bouchage

Même si la base du sable sature, les facettes de quartz (valeur linéaire 3-6) restent
distinctes et **bloomées**. Elles portent une partie de la lecture de surface à elles seules.
C'est pourquoi `uSparkle` ne doit pas être coupé en plein soleil — c'est précisément là qu'il
sert le plus.

### 7.6 Ce qu'il ne faut pas ajouter

| Effet | Pourquoi non |
|---|---|
| **God rays / volumetric light scattering** | Techniquement faisable (radial blur à la Mitchell, GPU Gems 3), mais physiquement absurde : les rayons crépusculaires demandent une atmosphère diffusante **et** un occulteur devant le soleil. Sur une plage dégagée à midi, il n'y en a aucun. À réserver au **couchant avec des nuages épars**, et seulement là. |
| **Lens flare à fantômes** | Les cercles hexagonaux disent « caméra bon marché des années 2000 ». Le brief demande une lecture *photographique*, pas *vidéoludique*. Un léger filet anamorphique sur le reflet du soleil suffit (§7.3). |
| **DOF supplémentaire** | Le tilt-shift existant est déjà un DOF. En empiler un second flouterait le sujet. |
| **Chromatic aberration renforcée** | `uAberration = 0.0012` est déjà à la limite. C'est un effet qui doit se deviner. |
| **SSAO à fort rayon** | Assombrit les zones éclairées et **baisse le contraste soleil/ombre**. Petit rayon uniquement (≤ 0,14 m), intensité ≤ 1,2. |
| **Auto-exposure sur histogramme** | Rend le contraste non déterministe et pompe. On pilote l'exposition sur l'**état météo** (§4.7). |

### 7.7 Récapitulatif : l'ordre de la chaîne, inchangé

```
scène HDR linéaire
  │
  ├─ 1. RenderPass                              (linéaire, non borné)
  ├─ 2. UnrealBloomPass    seuil 1.10           (linéaire — OBLIGATOIRE ici)
  ├─ 3. OutputPass         ACES + sRGB          (le tone mapping)
  ├─ 4. DioramaShader      tilt-shift, LGG,     (sRGB — OBLIGATOIRE ici)
  │                        contraste, satu,
  │                        split toning,
  │                        vignette, grain,
  │                        heat shimmer
  └─ 5. SMAAPass                                (sRGB)
```

Si l'on ajoute un jour une passe d'AO ou de god rays : **entre 1 et 2**, jamais après 3.

---

## 8. Valeurs prêtes à coller

Toutes les couleurs sont en **sRGB** (à passer par `setHex(x, THREE.SRGBColorSpace)` ou
`new THREE.Color(x)`, jamais par `setRGB()`). Toutes les intensités sont en **unités
Three.js, 1 u = 20 000 lx**.

### 8.1 D'abord : élever le soleil

```js
// Sky.js
// ARC_TILT est l'inclinaison de l'arc solaire. À 0.38, le soleil culmine à
// 68° — c'est une latitude méditerranéenne. Un midi TROPICAL culmine entre
// 75° et 88°. À 0.20, on culmine à 78,6° : les ombres de midi font 20 % de
// la hauteur de l'objet au lieu de 40 %.
//
// C'est le changement d'une seule constante, et il divise par deux la
// longueur des ombres de midi. "Écrasant de lumière", c'est d'abord ça.
const ARC_TILT = 0.20;   // était 0.38
```

### 8.2 Cycle solaire — table par heure

`heure = 6 + (dayT − 0.25) × 24`. Élévation calculée avec `ARC_TILT = 0.20`.
Les intensités sont des **DNI** (irradiance normale au faisceau) : Three.js applique `N·L`.

| `dayT` | Heure | Élév. | K | Couleur soleil | DNI (lx) | `sunIntensity` | Ombre d'une tour de 50 cm |
|---|---|---|---|---|---|---|---|
| 0,250 | 6 h 00 | 0,0° | 1900 | `#F85418` | 0 | 0,00 | — |
| 0,275 | 6 h 36 | 8,9° | 2900 | `#FF9A48` | 30 000 | 1,50 | 3,19 m |
| 0,300 | 7 h 12 | 17,6° | 3500 | `#FFB56A` | 58 000 | 2,90 | 1,58 m |
| 0,325 | 7 h 48 | 26,7° | 4100 | `#FFCB92` | 74 000 | 3,70 | 0,99 m |
| 0,350 | 8 h 24 | 35,2° | 4700 | `#FFDDB4` | 84 000 | 4,20 | 0,71 m |
| 0,375 | 9 h 00 | 44,3° | 5000 | `#FFE6C4` | 90 000 | 4,50 | 0,51 m |
| 0,400 | 9 h 36 | 52,4° | 5200 | `#FFEACE` | 95 000 | 4,75 | 0,38 m |
| 0,425 | 10 h 12 | 61,0° | 5350 | `#FFEED8` | 99 000 | 4,95 | 0,28 m |
| 0,450 | 10 h 48 | 68,6° | 5450 | `#FFF0DA` | 101 000 | 5,05 | 0,20 m |
| 0,475 | 11 h 24 | 75,1° | 5550 | `#FFF3E0` | 103 000 | 5,15 | 0,13 m |
| **0,500** | **12 h 00** | **78,6°** | **5600** | **`#FFF4E2`** | **104 000** | **5,20** | **0,10 m** |
| 0,525 | 12 h 36 | 75,1° | 5550 | `#FFF3E0` | 103 000 | 5,15 | 0,13 m |
| 0,550 | 13 h 12 | 68,6° | 5450 | `#FFF0DA` | 101 000 | 5,05 | 0,20 m |
| 0,600 | 14 h 24 | 52,4° | 5200 | `#FFEACE` | 95 000 | 4,75 | 0,38 m |
| 0,650 | 15 h 36 | 35,2° | 4700 | `#FFDDB4` | 84 000 | 4,20 | 0,71 m |
| 0,700 | 16 h 48 | 17,6° | 3500 | `#FFB56A` | 58 000 | 2,90 | 1,58 m |
| 0,725 | 17 h 24 | 8,9° | 2900 | `#FF9A48` | 30 000 | 1,50 | 3,19 m |
| 0,740 | 17 h 46 | 3,7° | 2300 | `#FF7A2C` | 14 000 | 0,70 | 7,73 m |
| 0,750 | 18 h 00 | 0,0° | 1900 | `#F85418` | 0 | 0,00 | — |

> **Trois choses à lire dans cette table.**
>
> 1. **L'intensité varie peu entre 9 h et 15 h** (4,5 → 5,2, soit 0,2 stop). Sous les tropiques,
>    la journée est un long plateau, et non l'arche douce des latitudes moyennes. **C'est une
>    signature de latitude** aussi forte que la couleur du ciel.
> 2. **La couleur, elle, ne varie presque pas non plus** : de 5000 K à 5600 K entre 9 h et 15 h,
>    soit un écart imperceptible. Le « golden hour » tropical est **court et brutal** — tout se
>    joue dans la dernière heure. Ne pas étaler la dérive vers l'orange sur toute l'après-midi :
>    c'est ce qui donne le look « fin de journée permanente » des jeux mal réglés.
> 3. **La longueur d'ombre explose en fin de course.** 10 cm à midi, 3,2 m à 8,9°, 7,7 m à 3,7°.
>    C'est cette explosion qui rend le couchant spectaculaire, et c'est pour ça qu'il ne faut
>    **pas** baisser `sunIntensity` artificiellement au couchant : `N·L` fait déjà tout le
>    travail.

### 8.3 États météo — table complète

| Paramètre | **GRAND_BEAU** | **VOILE** | **NUAGES** | **GRAIN** | **COUCHER** | **NUIT** |
|---|---|---|---|---|---|---|
| **Lumière** | | | | | | |
| `sunIntensity` (× table 8.2) | ×1,00 | ×0,68 | ×0,90 | **0,00** | ×0,31 (=1,60) | 0,045 (lune) |
| `sunColor` | `#FFF4E2` | `#FFF0DC` | `#FFF2E0` | — | `#FF8A3C` | `#9FB8DE` |
| `sunTanAngle` | **0,037** | 0,122 | 0,045 | 0,300 | 0,056 | 0,028 |
| `hemiIntensity` | **0,22** | 0,52 | 0,34 | 0,30 | 0,30 | 0,020 |
| `hemiColor` | `#6FA8E8` | `#A8C6E4` | `#7FB0E2` | `#7E8A96` | `#8C7FB4` | `#2B4A78` |
| `hemiGroundColor` | `#D9B476` | `#D8C6A4` | `#D5B27C` | `#6C6558` | `#C08050` | `#1E2634` |
| `envIntensity` | **0,62** | 0,88 | 0,72 | 0,34 | 0,54 | 0,10 |
| **Ratio soleil/ciel** | **5,8:1** | 2,4:1 | 4,4:1 | 0:1 | 2,6:1* | 1,4:1 |
| **Ciel** | | | | | | |
| `zenith` | `#1E5FC4` | `#5A8ECC` | `#2A6BC6` | `#4E5A68` | `#2A4A96` | `#060C1E` |
| `horizon` | `#B9DCF2` | `#DCE6EC` | `#C2DEEE` | `#7C858E` | `#FF9E56` | `#16263E` |
| `ground` (IBL) | `#C99A55` | `#CDB48E` | `#C69B58` | `#4E4A42` | `#A05C34` | `#0E1420` |
| `zenithPower` | **0,62** | 0,40 | 0,58 | 0,90 | 0,50 | 0,70 |
| `haze` (gain de Mie) | **0,38** | 1,10 | 0,52 | 0,20 | 1,35 | 0,15 |
| `turbidity` | **2,4** | 5,5 | 3,0 | 9,0 | 3,6 | 2,0 |
| **Nuages** | | | | | | |
| `cloudCoverage` | 0,00 | 0,10 | **0,42** | 0,96 | 0,25 | 0,15 |
| `cloudDensity` | — | 0,55 | **0,22** | 0,50 | 0,28 | 0,35 |
| `cloudLit` | — | `#F0EEE8` | `#FFFDF6` | `#8A929C` | `#FFC088` | `#3A4A66` |
| `cloudDark` | — | `#D8D8DC` | `#8FA4BE` | `#3E464E` | `#7A5C7E` | `#141C2C` |
| `cloudShadowGain` | 0,00 | 0,12 | **0,80** | 0,10 | 0,45 | 0,30 |
| `cloudCov` (seuils) | — | 0,50 / 0,80 | **0,52 / 0,64** | 0,10 / 0,45 | 0,58 / 0,76 | 0,62 / 0,82 |
| `cloudSpeed` (m/s) | — | 1,2 | 6,5 | 14,0 | 2,5 | 2,0 |
| **Atmosphère & mer** | | | | | | |
| `windSpeed` (m/s) | 3,5 | 1,2 | 5,5 | **13,0** | 2,5 | 2,0 |
| `rainRate` (mm/h) | 0 | 0 | 0 | **9,0** | 0 | 0 |
| `fogDensity` | **0,000** | 0,022 | 0,004 | 0,055 | 0,010 | 0,006 |
| `waveHeight` | ×1,0 | ×0,7 | ×1,3 | **×2,2** | ×0,9 | ×1,0 |
| `seaLevelSurge` (m) | 0,00 | 0,00 | +0,02 | **+0,08** | 0,00 | 0,00 |
| **Post-traitement** | | | | | | |
| `exposure` | **0,78** | 0,94 | 0,81 | 3,80 | 1,85 | 6,00 |
| `bloomStrength` | **0,32** | 0,46 | 0,34 | 0,14 | 0,58 | 0,22 |
| `bloomThreshold` | **1,10** | 0,90 | 1,05 | 1,50 | 0,72 | 0,55 |
| `bloomRadius` | 0,30 | 0,42 | 0,32 | 0,50 | 0,58 | 0,48 |
| `saturation` | **1,26** | 1,04 | 1,22 | **0,74** | 1,32 | 0,80 |
| `contrast` | **1,18** | 0,94 | 1,14 | 1,06 | 1,10 | 0,96 |
| `vignette` | 0,22 | 0,16 | 0,22 | 0,38 | 0,30 | 0,42 |
| `grain` | 0,012 | 0,010 | 0,012 | 0,022 | 0,014 | 0,026 |
| `heatShimmer` | 0,0015 | **0,0035** | 0,0010 | 0,000 | 0,000 | 0,000 |
| **Gameplay** | | | | | | |
| `insolation` | **1,00** | 0,78 | 0,25–1,00 | 0,05 | 0,18 | 0,00 |
| `wind` (normalisé) | 0,29 | 0,10 | 0,46 | **1,00** | 0,21 | 0,17 |
| Évaporation relative | **1,00** | 0,71 | 0,50–1,08 | 0,41 | 0,35 | 0,23 + rosée |
| **Machine à états** | | | | | | |
| Durée (min de jeu) | 8–16 | 5–10 | 6–12 | 2,5–5 | imposée | imposée |
| Transition entrante (s) | 40 | 90 | 50 | **25** | 60 | 90 |
| Part visée du temps diurne | **50–55 %** | 18 % | 22 % | 6 % | — | — |

\* Le ratio du couchant est trompeur : mesuré sur un plan **horizontal**, il vaut 0,33:1. Les
2,6:1 correspondent à une face **verticale orientée vers le soleil** — et c'est là que se joue
le couchant.

### 8.4 Palettes de rendu attendues (contrôle qualité)

Ce que doit produire le rendu final à l'écran, après tone mapping et étalonnage. **À vérifier
à la pipette** : si les valeurs ne correspondent pas, un réglage est resté en arrière.

| Élément | GRAND_BEAU soleil | GRAND_BEAU ombre | VOILE | NUAGES ombre | GRAIN | COUCHER | NUIT |
|---|---|---|---|---|---|---|---|
| Sable sec | `#F6EDD4` | `#93A9C6` | `#EDE6DA` | `#A8B4C4` | `#B0A691` | `#F0B072` | `#4A5872` |
| Sable humide | `#C9A97A` | `#6E7F9C` | `#C4B296` | `#7C8496` | `#6B5A46` | `#B4763E` | `#32405A` |
| Eau peu profonde | `#4FD9D0` | `#2E9EA8` | `#78C8C6` | `#3E8A96` | `#4A7E86` | `#D89860` | `#1E3852` |
| Eau profonde | `#0E7CA8` | `#0A5C82` | `#4A88A0` | `#186A88` | `#1E3E50` | `#7A5A6E` | `#0A1628` |
| Écume | `#FFFFFF` | `#CFE0EE` | `#F8F8F6` | `#DDE4EA` | `#E4E8EA` | `#FFD8B0` | `#8FA0BC` |
| Rocher | `#B8A896` | `#69748C` | `#B4AEA4` | `#79808E` | `#7E786C` | `#B4744A` | `#2E3648` |
| Ciel au zénith | `#3C82D8` | — | `#7EA8D4` | — | `#5C6874` | `#3E5AA8` | `#0A1230` |

### 8.5 Le fichier, prêt à créer

```js
// src/render/WeatherStates.js
import * as THREE from 'three';

const C = (hex) => new THREE.Color().setHex(hex, THREE.SRGBColorSpace);

/** @type {Record<string, import('./Weather.js').WeatherState>} */
export const WEATHER = {
  GRAND_BEAU: {
    id: 'GRAND_BEAU', label: 'Grand beau',
    sunScale: 1.00,  sunColor: C(0xFFF4E2), sunTanAngle: 0.037,
    hemiIntensity: 0.22, hemiColor: C(0x6FA8E8), hemiGroundColor: C(0xD9B476),
    envIntensity: 0.62,
    zenith: C(0x1E5FC4), horizon: C(0xB9DCF2), ground: C(0xC99A55),
    zenithPower: 0.62, haze: 0.38, turbidity: 2.4,
    cloudCoverage: 0.00, cloudDensity: 0.30,
    cloudLit: C(0xFFFDF6), cloudDark: C(0x8FA4BE),
    cloudShadowGain: 0.00, cloudCov: [0.52, 0.64], cloudSpeed: 0.0,
    windSpeed: 3.5, rainRate: 0.0, fogDensity: 0.000,
    waveHeight: 1.0, seaLevelSurge: 0.00,
    exposure: 0.78, bloomStrength: 0.32, bloomThreshold: 1.10, bloomRadius: 0.30,
    saturation: 1.26, contrast: 1.18, vignette: 0.22, grain: 0.012,
    heatShimmer: 0.0015,
    insolation: 1.00, wind: 0.29,
    duration: [8, 16], fadeIn: 40,
  },

  VOILE: {
    id: 'VOILE', label: 'Voile de chaleur',
    sunScale: 0.68, sunColor: C(0xFFF0DC), sunTanAngle: 0.122,
    hemiIntensity: 0.52, hemiColor: C(0xA8C6E4), hemiGroundColor: C(0xD8C6A4),
    envIntensity: 0.88,
    zenith: C(0x5A8ECC), horizon: C(0xDCE6EC), ground: C(0xCDB48E),
    zenithPower: 0.40, haze: 1.10, turbidity: 5.5,
    cloudCoverage: 0.10, cloudDensity: 0.55,
    cloudLit: C(0xF0EEE8), cloudDark: C(0xD8D8DC),
    cloudShadowGain: 0.12, cloudCov: [0.50, 0.80], cloudSpeed: 1.2,
    windSpeed: 1.2, rainRate: 0.0, fogDensity: 0.022,
    waveHeight: 0.7, seaLevelSurge: 0.00,
    exposure: 0.94, bloomStrength: 0.46, bloomThreshold: 0.90, bloomRadius: 0.42,
    saturation: 1.04, contrast: 0.94, vignette: 0.16, grain: 0.010,
    heatShimmer: 0.0035,
    insolation: 0.78, wind: 0.10,
    duration: [5, 10], fadeIn: 90,
  },

  NUAGES: {
    id: 'NUAGES', label: 'Nuages épars',
    sunScale: 0.90, sunColor: C(0xFFF2E0), sunTanAngle: 0.045,
    hemiIntensity: 0.34, hemiColor: C(0x7FB0E2), hemiGroundColor: C(0xD5B27C),
    envIntensity: 0.72,
    zenith: C(0x2A6BC6), horizon: C(0xC2DEEE), ground: C(0xC69B58),
    zenithPower: 0.58, haze: 0.52, turbidity: 3.0,
    cloudCoverage: 0.42, cloudDensity: 0.22,
    cloudLit: C(0xFFFDF6), cloudDark: C(0x8FA4BE),
    cloudShadowGain: 0.80, cloudCov: [0.52, 0.64], cloudSpeed: 6.5,
    windSpeed: 5.5, rainRate: 0.0, fogDensity: 0.004,
    waveHeight: 1.3, seaLevelSurge: 0.02,
    exposure: 0.81, bloomStrength: 0.34, bloomThreshold: 1.05, bloomRadius: 0.32,
    saturation: 1.22, contrast: 1.14, vignette: 0.22, grain: 0.012,
    heatShimmer: 0.0010,
    insolation: 1.00, wind: 0.46,     // modulée par cloudShadow.shadowAt()
    duration: [6, 12], fadeIn: 50,
  },

  GRAIN: {
    id: 'GRAIN', label: 'Grain tropical',
    sunScale: 0.00, sunColor: C(0xB0B8C0), sunTanAngle: 0.300,
    hemiIntensity: 0.30, hemiColor: C(0x7E8A96), hemiGroundColor: C(0x6C6558),
    envIntensity: 0.34,
    zenith: C(0x4E5A68), horizon: C(0x7C858E), ground: C(0x4E4A42),
    zenithPower: 0.90, haze: 0.20, turbidity: 9.0,
    cloudCoverage: 0.96, cloudDensity: 0.50,
    cloudLit: C(0x8A929C), cloudDark: C(0x3E464E),
    cloudShadowGain: 0.10, cloudCov: [0.10, 0.45], cloudSpeed: 14.0,
    windSpeed: 13.0, rainRate: 9.0, fogDensity: 0.055,
    waveHeight: 2.2, seaLevelSurge: 0.08,
    exposure: 3.80, bloomStrength: 0.14, bloomThreshold: 1.50, bloomRadius: 0.50,
    saturation: 0.74, contrast: 1.06, vignette: 0.38, grain: 0.022,
    heatShimmer: 0.000,
    insolation: 0.05, wind: 1.00,
    duration: [2.5, 5], fadeIn: 25, fadeOut: 70,
  },

  COUCHER: {
    id: 'COUCHER', label: 'Coucher doré',
    // sunScale s'applique à la table 8.2 ; à dayT 0.735 celle-ci vaut déjà
    // ~1.5, donc 1.07 donne l'intensité finale ~1.60 (DNI 32 klx à 7°).
    sunScale: 1.07, sunColor: C(0xFF8A3C), sunTanAngle: 0.056,
    hemiIntensity: 0.30, hemiColor: C(0x8C7FB4), hemiGroundColor: C(0xC08050),
    envIntensity: 0.54,
    zenith: C(0x2A4A96), horizon: C(0xFF9E56), ground: C(0xA05C34),
    zenithPower: 0.50, haze: 1.35, turbidity: 3.6,
    cloudCoverage: 0.25, cloudDensity: 0.28,
    cloudLit: C(0xFFC088), cloudDark: C(0x7A5C7E),
    cloudShadowGain: 0.45, cloudCov: [0.58, 0.76], cloudSpeed: 2.5,
    windSpeed: 2.5, rainRate: 0.0, fogDensity: 0.010,
    waveHeight: 0.9, seaLevelSurge: 0.00,
    exposure: 1.85, bloomStrength: 0.58, bloomThreshold: 0.72, bloomRadius: 0.58,
    saturation: 1.32, contrast: 1.10, vignette: 0.30, grain: 0.014,
    heatShimmer: 0.000,
    insolation: 0.18, wind: 0.21,
    duration: [1.6, 1.6], fadeIn: 60,
  },

  NUIT: {
    id: 'NUIT', label: 'Nuit claire',
    // La lune remplace le soleil : intensité ABSOLUE, hors échelle physique
    // (cf. §1.5). sunScale = 0 pour neutraliser la table 8.2.
    sunScale: 0.00, moonIntensity: 0.045, sunColor: C(0x9FB8DE),
    sunTanAngle: 0.028,
    hemiIntensity: 0.020, hemiColor: C(0x2B4A78), hemiGroundColor: C(0x1E2634),
    envIntensity: 0.10,
    zenith: C(0x060C1E), horizon: C(0x16263E), ground: C(0x0E1420),
    zenithPower: 0.70, haze: 0.15, turbidity: 2.0,
    cloudCoverage: 0.15, cloudDensity: 0.35,
    cloudLit: C(0x3A4A66), cloudDark: C(0x141C2C),
    cloudShadowGain: 0.30, cloudCov: [0.62, 0.82], cloudSpeed: 2.0,
    windSpeed: 2.0, rainRate: 0.0, fogDensity: 0.006,
    waveHeight: 1.0, seaLevelSurge: 0.00,
    exposure: 6.00, bloomStrength: 0.22, bloomThreshold: 0.55, bloomRadius: 0.48,
    saturation: 0.80, contrast: 0.96, vignette: 0.42, grain: 0.026,
    heatShimmer: 0.000,
    insolation: 0.00, wind: 0.17, dew: true,
    duration: [7, 7], fadeIn: 90,
  },
};

/** Probabilités de transition (les états imposés par l'heure n'y figurent pas). */
export const TRANSITIONS = {
  GRAND_BEAU: { VOILE: 0.30, NUAGES: 0.55, GRAIN: 0.05, GRAND_BEAU: 0.10 },
  VOILE:      { GRAND_BEAU: 0.45, NUAGES: 0.40, GRAIN: 0.15 },
  NUAGES:     { GRAND_BEAU: 0.50, VOILE: 0.20, GRAIN: 0.30 },
  GRAIN:      { GRAND_BEAU: 0.25, VOILE: 0.60, NUAGES: 0.15 },
  NUIT:       { GRAND_BEAU: 0.70, VOILE: 0.20, NUAGES: 0.10 },
};

/** Constantes d'étalonnage communes à tous les états (cf. §7.4). */
export const GRADE = {
  lift:       new THREE.Vector3(-0.014, 0.000, 0.026),
  gamma:      new THREE.Vector3( 0.975, 1.000, 1.030),
  gain:       new THREE.Vector3( 1.045, 1.015, 0.968),
  contrastPivot: 0.42,
  satRolloff:    0.82,
  splitCool:  new THREE.Vector3(-0.30, 0.05, 1.00),  // ombres
  splitWarm:  new THREE.Vector3( 1.00, 0.42, -0.30), // hautes lumières
  splitCoolAmount: 0.055,
  splitWarmAmount: 0.030,
};
```

### 8.6 Diff minimal — les 12 lignes à changer pour voir la différence tout de suite

Si l'on ne devait faire qu'une passe de 15 minutes avant de juger sur pièces :

```js
// --- Sky.js ---
const ARC_TILT = 0.20;                       // était 0.38   (soleil plus haut)

this.sun.intensity = 5.0 * day;              // était 2.75   (+0,9 stop)
this.sun.color.setHex(0xFFF4E2, THREE.SRGBColorSpace);

this.fill.intensity = 0.22;                  // était 0.30 + 0.55*day
this.fill.color.setHex(0x6FA8E8, THREE.SRGBColorSpace);
this.fill.groundColor.setHex(0xD9B476, THREE.SRGBColorSpace);

this.uniforms.uZenith.value.setHex(0x1E5FC4, THREE.SRGBColorSpace);
this.uniforms.uHorizon.value.setHex(0xB9DCF2, THREE.SRGBColorSpace);
this.uniforms.uGround.value.setHex(0xC99A55, THREE.SRGBColorSpace);
this.uniforms.uHaze.value = 0.38;            // était 0.45 + golden*0.9

this.sun.shadow.normalBias = 0.006;          // était 0.03   ← le peter-panning
this.sun.shadow.bias = -0.00012;             // était -0.0006
this.sun.shadow.radius = 1.0;                // était 2.2
const S = 7.4;                               // était 8.5

this.scene.environmentIntensity = 0.62;      // était 0.7

// --- Game.js ---
renderer.toneMappingExposure = 0.78;         // était 1.05
renderer.shadowMap.type = THREE.PCFSoftShadowMap;  // était PCFShadowMap

// --- Post.js ---
this.bloom = new UnrealBloomPass(v2, 0.32, 0.30, 1.10);   // était 0.17, 0.32, 1.45
this.bloom.highPassUniforms.smoothWidth.value = 0.35;
uSaturation: 1.26,                           // était 1.10
uLift: new THREE.Vector3(-0.014, 0.0, 0.026),
uGain: new THREE.Vector3(1.045, 1.015, 0.968),
```

**Effet attendu de ces 12 lignes seules** : ratio soleil/ciel de 1,9:1 à 5,8:1, ombres bleues au
lieu de beiges, ombres de midi divisées par deux en longueur, sable qui brûle, bloom qui
fonctionne enfin, ciel avec un vrai gradient. **C'est 80 % du look, avant même d'écrire une
ligne de PCSS ou de météo.**

---

## 9. Ordre d'implémentation

Par rapport contraste-obtenu / effort, décroissant.

| # | Chantier | Effort | Impact | Dépend de |
|---|---|---|---|---|
| **1** | **Budget lumière** (§8.6) : intensités, couleurs, exposition, `ARC_TILT` | **15 min** | **★★★★★** | — |
| **2** | **Biais d'ombre** : `normalBias 0.03 → 0.006`, `bias`, `radius`, `S = 7.4` | 10 min | ★★★★☆ | — |
| **3** | **`uGround` de l'IBL** : le beige de studio → le rebond du sable | 10 min | ★★★★☆ | 1 |
| **4** | **Étalonnage** (§7.4) : LGG, contraste, saturation, split toning, grain | 45 min | ★★★★☆ | 1 |
| **5** | **Bloom remis en service** : seuil 1,10, `smoothWidth 0.35` | 5 min | ★★★☆☆ | 1 |
| **6** | **Shader de ciel** (§3.3) : Mie resserré, `zenithPower`, `uSunDiscGain` | 1 h | ★★★☆☆ | 1 |
| **7** | **`WeatherStates.js` + `Weather.js`** : les 6 états, la machine, l'interpolation | 3 h | ★★★★☆ | 1, 4, 6 |
| **8** | **Ombre de nuage** (§5.4) : `CloudShadow.js` + injection sable & eau | 2 h | ★★★★★ | 7 |
| **9** | **`fitShadowTo()`** : cadrage dynamique + quantification au texel | 1 h 30 | ★★★☆☆ | 2 |
| **10** | **PCSS directionnel** (§2.5) | 2 h | ★★☆☆☆ | 9 |
| **11** | **Couche de nuages du dôme** (§5.3) | 2 h | ★★☆☆☆ | 6, 7 |
| **12** | **Pluie** (§6) : particules, rides, `uSurfaceWetness`, injection Moisture/Water | 4 h | ★★★★☆ | 7 |
| **13** | **Décals d'ombre de contact** pour les props | 2 h | ★★☆☆☆ | 2 |
| **14** | **Rosée nocturne**, surcote de tempête, houle météo-dépendante | 1 h 30 | ★★☆☆☆ | 7, 12 |

**Le chantier 8 (ombre de nuage) mérite d'être remonté** dès que 7 est en place : c'est le
meilleur rapport impact/effort du document après le chantier 1, et c'est lui qui rend le jeu
*vivant* plutôt que simplement *contrasté*.

**Le chantier 10 (PCSS) est volontairement en fin de liste.** Il est intellectuellement
satisfaisant et visuellement marginal (§2.2) : à cette échelle, la shadow map bien cadrée du
chantier 9 fait 90 % du travail. Ne pas commencer par là.

### 9.1 Comment vérifier qu'on a réussi

Cinq tests à faire, dans l'ordre, avec une pipette :

1. **Le test de l'ombre.** Prélever le sable au soleil et le sable à l'ombre, côte à côte,
   à midi en grand beau. Attendu : **0,90 et 0,42** en luminance sRGB, soit 2,8 stops.
   Si l'ombre est au-dessus de 0,48, le remplissage est encore trop fort.
2. **Le test de la teinte d'ombre.** Convertir l'ombre en HSL. Attendu : **teinte 210–220°,
   saturation ≥ 22 %**. Si la teinte est entre 30 et 60° (beige), `uGround` ou `hemiColor` est
   resté sur l'ancienne valeur.
3. **Le test du gradient de ciel.** Prélever le zénith et l'horizon. Attendu : rapport de
   luminance **1 : 4,4 minimum**. En dessous de 1 : 3, le ciel est trop plat pour être tropical.
4. **Le test du bloom.** Compter les pixels bloomés (sortie de la passe de high-pass, seuil
   > 0). Attendu : **1 à 3 % du cadre**, tous sur l'eau, l'écume et les facettes de quartz,
   **zéro sur le sable**. À 0 %, le seuil est trop haut ; au-dessus de 6 %, le sable bloome.
5. **Le test de l'ombre de tour.** Poser un cylindre de 50 cm, soleil à 45°. Prélever le long du
   bord de l'ombre. Attendu : transition sur **1 à 2 px à la base**, sur **6 à 10 px au bout**.
   Si la transition est identique aux deux bouts, PCSS n'est pas actif (ou `radius` PCF domine).

---

## 10. Références

**Photométrie et exposition**
- *Sunny 16 rule* — plein soleil = EV 15 à ISO 100, soit ~82 000 lx incidents.
  https://en.wikipedia.org/wiki/Sunny_16_rule
- *Orders of magnitude (illuminance)* — table complète, du ciel étoilé (0,002 lx) au plein
  soleil (110 000 lx), en passant par la pleine lune (0,25 lx).
  https://en.wikipedia.org/wiki/Orders_of_magnitude_(illuminance)
- *Daylight* — décomposition direct / diffus, valeurs de ciel couvert (10–25 klx).
  https://en.wikipedia.org/wiki/Daylight
- *Moonlight* (Astronomy & Geophysics, 2017) — 0,25 lx pour une pleine lune claire, jusqu'à
  0,32 lx pour une supermoon vue des tropiques. https://academic.oup.com/astrogeo/article/58/1/1.31/2938119

**Ciel et diffusion atmosphérique**
- Preetham, Shirley, Smits, *A Practical Analytic Model for Daylight* (SIGGRAPH 1999) — le
  modèle de `three/addons/objects/Sky.js`.
- Hosek, Wilkie, *An Analytic Model for Full Spectral Sky-Dome Radiance* (SIGGRAPH 2012) —
  bleus plus profonds en journée, couchants et turbidités élevées nettement meilleurs.
  https://cgg.mff.cuni.cz/projects/SkylightModelling/
- diharaw/sky-models — implémentations OpenGL temps réel de Preetham et de Hosek-Wilkie, avec
  le jeu de données RGB. https://github.com/diharaw/sky-models
- three.js `Sky.js` — https://github.com/mrdoob/three.js/blob/dev/examples/jsm/objects/Sky.js
  *(attention : la r184 y a ajouté une couche de nuages, la r186 a supprimé l'uniforme `up`.)*

**Ombres**
- Fernando, *Percentage-Closer Soft Shadows* (SIGGRAPH 2005 sketch) — l'origine du contact
  hardening et de la recherche de bloqueurs.
- Sterna, *Contact-hardening Soft Shadows Made Fast* (2018) —
  https://wojtsterna.com/wp-content/uploads/2023/02/contact_hardening_soft_shadows.pdf
- three.js `webgl_shadowmap_pcss.html` — l'implémentation de référence. **Exige
  `THREE.BasicShadowMap`**, et sa loi de pénombre est celle d'une source ponctuelle : cf. §2.4.
  https://github.com/mrdoob/three.js/blob/dev/examples/webgl_shadowmap_pcss.html
- `shadowmap_pars_fragment.glsl.js` — le chunk patché. Restructuré en r182 ; `shadowIntensity`
  ajouté en r166. https://github.com/mrdoob/three.js/blob/dev/src/renderers/shaders/ShaderChunk/shadowmap_pars_fragment.glsl.js

**Tone mapping et étalonnage**
- Khronos, *PBR Neutral Tone Mapper* — la comparaison saturation ACES / AgX / PBR Neutral.
  https://www.khronos.org/news/press/khronos-pbr-neutral-tone-mapper-released-for-true-to-life-color-rendering-of-3d-products
- Opsenica, *Tone Mapping* — courbes, épaules, comportement des dérivées.
  https://bruop.github.io/tonemapping/
- Pierre, *Filmic, darktable and the quest of the HDR tone mapping* — pied, latitude, épaule.
  https://eng.aurelienpierre.com/2018/11/filmic-darktable-and-the-quest-of-the-hdr-tone-mapping/

**Surfaces mouillées et pluie**
- Lagarde, *Water drop 3a / 3b — Physically based wet surfaces* — le modèle d'assombrissement
  déjà implémenté dans `SandMaterial.js`.
  https://seblagarde.wordpress.com/2013/04/14/water-drop-3b-physically-based-wet-surfaces/
- Lagarde, *Water drop 2b — Dynamic rain and its effects* — rides, impacts, accumulation.
  https://seblagarde.wordpress.com/2013/01/03/water-drop-2b-dynamic-rain-and-its-effects/
- Cyanilux, *Rain Effects Breakdown* — la séparation film de surface / humidité accumulée.
  https://www.cyanilux.com/tutorials/rain-effects-breakdown/

**Post-traitement**
- Mitchell, *Volumetric Light Scattering as a Post-Process* (GPU Gems 3) — les god rays, pour
  mémoire ; déconseillés ici sauf au couchant (§7.6).
- Wronski, *Anamorphic lens flares and visual effects* — pourquoi un filet anamorphique 2:1
  est le seul flare défendable. https://bartwronski.com/2015/03/09/anamorphic-lens-flares-and-visual-effects/
- LearnOpenGL, *Physically Based Bloom* — seuil, genou souple, downsampling.
  https://learnopengl.com/Guest-Articles/2022/Phys.-Based-Bloom

**Nuages et perspective aérienne**
- shff/opengl_sky — ciel + nuages entièrement en shader, sur du matériel de 2011.
  https://github.com/shff/opengl_sky
- Staggart, *Cloud Shadows* — la projection de texture d'ombre défilante, la technique du §5.4.
  https://staggart.xyz/unity/sc-post-effects/scpe-docs/?section=cloud-shadows
- *Aerial perspective* — https://en.wikipedia.org/wiki/Aerial_perspective

**Documents internes**
- `docs/RECHERCHE-RENDU-3D.md` §5 (lumière et atmosphère), §6 (post-processing)
- `docs/RECHERCHE-PHYSIQUE-SABLE.md` (humidité, angle de repos, cohésion)
- `docs/GAME-DESIGN.md` (marée, cycle de jour, boucle de jeu)
