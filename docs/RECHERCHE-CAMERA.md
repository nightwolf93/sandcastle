# Recherche — CONTRÔLES DE CAMÉRA

> Refonte complète de `src/render/DioramaControls.js`.
>
> Demande du joueur : « améliore tous les contrôles caméra, que ce soit vraiment pratique à
> utiliser, faire des tests complets » — et, explicitement, « la molette, que ça zoome/dézoome
> en fonction de la position de notre curseur ».
>
> Contraintes du projet, rappelées ici parce qu'elles cadrent tout le reste :
>
> | Contrainte | Valeur | Conséquence |
> |---|---|---|
> | Domaine sculptable | 10,24 × 10,24 m, terrain culminant vers 2 m | Objet posé sur une table, pas un monde ouvert |
> | Champ de vision | 32° (perspective) | Look maquette ; compression forte ; le zoom curseur est *plus* sensible qu'à 60° |
> | Distance | 1,4 → 34 m | Rapport 24:1, soit ~4,6 octaves de zoom |
> | Boutons souris | **les deux sont pris par les outils** | La caméra vit sur molette-clic, `Alt`, `Espace` et le clavier |
> | Molette nue | rayon de brosse (`ToolManager.onWheel`) | Le zoom est sur `Ctrl+molette` |
>
> Tout le code de ce document est écrit pour être collé tel quel : il respecte la structure
> `azimuth / polar / distance / target` existante, les imports de `../core/Config.js`, et
> l'API `game.field.raycast()` / `game.field.surfaceHeightAt()`.
>
> **Les chiffres sont mesurés, pas estimés.** Le fichier complet du §8 a été exécuté contre
> `three@0.185` et le `Config.js` du projet, et tous les invariants du plan de test qui ne
> demandent pas de navigateur ont été vérifiés :
>
> | Invariant | Mesure |
> |---|---|
> | Le point sous le curseur après un zoom (5 crans, 15,5 → 8,09 m) | **0,0000 px** |
> | Le sol sous le curseur après un panoramique (180 × 140 px, 61° à 21° d'élévation) | **0,0000 px** |
> | Retour au point de départ après une orbite complète | **0,00000 mm** |
> | Roulis, sur 48 poses | **9,5e-15 °** |
> | Écart 30 img/s ↔ 120 img/s, réponse à un échelon | **9,4e-14** (azimut), **3,2e-9** (distance) |
> | Convergence à 99 %, dépassement | **350 ms**, **0,000 %** |
> | Cible hors de la boîte sur 1200 panoramiques extrêmes | **0** |
>
> Cette vérification a fait apparaître **trois défauts qui n'étaient pas dans le diagnostic
> initial** — le signe inversé du panoramique vertical (§1.3), l'insuffisance de la correction
> `1/cosθ` (§4.3), et une erreur d'étalonnage d'un facteur 2 sur la demi-vie du ressort
> (§4.1.2). Ils sont corrigés dans le code du §8. Deux tests du plan initial étaient eux-mêmes
> faux (T6 et T10) et ont été refaits.

---

## Table des matières

1. [Diagnostic des contrôles actuels](#1-diagnostic-des-contrôles-actuels)
2. [Zoom ancré sur le curseur](#2-zoom-ancré-sur-le-curseur)
3. [Normalisation de la molette](#3-normalisation-de-la-molette)
4. [Sensation : amortissement, échelle, inertie](#4-sensation--amortissement-échelle-inertie)
5. [Confort et garde-fous](#5-confort-et-garde-fous)
6. [Entrées alternatives](#6-entrées-alternatives)
7. [Plan de test complet](#7-plan-de-test-complet)
8. [Le fichier complet](#8-le-fichier-complet)
9. [Ordre d'implémentation](#9-ordre-dimplémentation)
10. [Sources](#10-sources)

---

## 1. Diagnostic des contrôles actuels

Lecture ligne à ligne de `src/render/DioramaControls.js` (195 lignes). Onze défauts, du plus
grave au plus cosmétique.

| # | Défaut | Gravité | Ligne(s) |
|---|---|---|---|
| D1 | Le zoom converge vers le centre de l'écran, pas vers le curseur | **bloquant** | 121-122 |
| D2 | `deltaY` brut : le zoom est 30× plus rapide sur Chrome/Windows que sur Firefox | **bloquant** | 121 |
| D3 | **Le panoramique vertical est inversé**, et sous-compense d'un facteur `cos(polar)` | **grave** | 129-137 |
| D4 | Aucune collision : la caméra traverse le sable et passe sous le bloc | **grave** | 180-185 |
| D5 | Vitesse clavier constante : ingérable à 1,4 m, inutilisable à 34 m | grave | 158 |
| D6 | Distance interpolée linéairement au lieu de logarithmiquement | moyenne | 177 |
| D7 | Pas de recadrage (`F`, `T`, `R` du doc de design ne sont pas implémentées) | moyenne | — |
| D8 | Bornes en désaccord avec `GAME-DESIGN.md` §4.2 | moyenne | 22-23, 39-40 |
| D9 | Aucun support tactile ni trackpad ; `pointerdown` tactile déclenche l'outil | moyenne | 79-91 |
| D10 | Écouteurs clavier jamais retirés dans `dispose()` (fuite au rechargement à chaud) | mineure | 69-74, 188-194 |
| D11 | Amortissement paramétré en « fraction par frame à 60 Hz », illisible pour un designer | mineure | 47, 174 |

### 1.1 D1 — le zoom va vers le centre de l'écran

```js
onWheel(e) {
  if (!e.ctrlKey && !e.metaKey) return;
  e.preventDefault();
  const k = Math.exp(e.deltaY * 0.0012);
  this.goalDistance = clamp(this.goalDistance * k, this.minDistance, this.maxDistance);
}
```

Seule `distance` change. La cible `target` ne bouge pas, l'axe de visée non plus : le point qui
reste immobile à l'écran est donc **le pixel central**, celui où se projette `target`. Quand on
sculpte un créneau dans le coin haut-droit de l'écran et qu'on zoome, le créneau part hors champ
et il faut re-panoramiquer. C'est la friction n° 1 signalée par le joueur, et c'est aussi la
raison pour laquelle `GAME-DESIGN.md` §4.2 écrit déjà « Zoom vers le curseur : le dolly converge
vers le point sous le curseur, pas vers le centre de l'écran. **Différence énorme d'ergonomie.** »

### 1.2 D2 — `deltaY` brut

`Math.exp(deltaY * 0.0012)` prend `deltaY` tel quel. Or ce nombre n'a aucune signification
portable :

| Périphérique / navigateur | `deltaMode` | `deltaY` typique pour un cran | `k` obtenu | Effet |
|---|---|---|---|---|
| Souris, Chrome/Edge Windows | 0 (pixel) | 100 (parfois 120) | 1,127 | correct |
| Souris, Firefox Windows/Linux | 1 (ligne) | 3 | 1,0036 | **imperceptible** |
| Souris, Chrome macOS | 0 | 4 à 12 (accéléré) | 1,005 → 1,015 | trop lent |
| Trackpad macOS, deux doigts | 0 | 1 à 4 par événement, ~60 evts/s | 1,001 | trop lent, mais très fréquent |
| Trackpad Windows Precision | 0 | 12 à 100 selon le pilote | variable | incohérent |
| Pincement trackpad (tous OS) | 0 + `ctrlKey` | 1 à 10 | 1,002 | zoom au ralenti |

Le rapport entre le pire et le meilleur cas est de **1:33**. Sur Firefox le joueur croit que le
zoom est cassé.

Deuxième conséquence, plus vicieuse : le pincement du trackpad arrive comme un `wheel` avec
`ctrlKey === true` **sans que la touche Ctrl soit enfoncée**. Le code actuel l'accepte
(heureusement), mais du même coup il est incapable de distinguer un vrai `Ctrl+molette` d'un
pincement — donc incapable de leur donner deux sensibilités différentes, alors qu'elles
diffèrent d'un facteur 20.

### 1.3 D3 — le panoramique vertical est inversé, et mal dosé

```js
const scale = (2 * this.distance * Math.tan((this.camera.fov * Math.PI) / 360)) / h;
const fwd = new THREE.Vector3(-Math.sin(this.azimuth), 0, -Math.cos(this.azimuth));
this.goalTarget.addScaledVector(right, -dx * scale);
this.goalTarget.addScaledVector(fwd,   -dy * scale);   // <-- ici
```

Posons `θ = polar` (angle depuis la verticale ; `θ = 0` = vue zénithale). Le repère caméra vaut,
pour un azimut `A` :

```
u    = ( sinθ·sinA ,  cosθ ,  sinθ·cosA )     (cible -> caméra)
fwd  = -u                                      (direction de visée)
right= ( cosA      ,  0    , -sinA       )
up   = (-cosθ·sinA ,  sinθ , -cosθ·cosA  )
```

Un point fixe du monde se déplace à l'écran de `−T` (où `T` est la translation du rig). Avec
`screen_y` croissant vers le bas :

```
Δscreen_x = −(T·right) / scale        Δscreen_y = +(T·up) / scale
```

On veut `Δscreen = (dx, dy)` — le sol suit le doigt. D'où les deux conditions :

```
T·right = −dx · scale                 T·up = +dy · scale
```

Comme `T` est contraint à l'horizontale, `T = a·right + b·fwd`, et la composante horizontale de
`up` vaut exactement `cosθ · fwd`, donc `T·up = b·cosθ`. Il vient :

```
a = −dx · scale                       b = +dy · scale / cosθ
```

**Le code applique `b = −dy · scale`.** Deux erreurs superposées :

**Erreur 1 — le signe.** Le `−dy` devrait être un `+dy`. Glisser vers le haut fait descendre le
sol, alors que glisser vers la droite le fait bien aller à droite : le panoramique est
**incohérent avec son propre axe horizontal**. Mesure sur le code actuel, à 38° d'élévation, avec
un glissement de 140 px vers le haut :

```
pan(0, -140)  ->  le point saisi passe de y = 400 px a y = 560 px
                  (il descend de 160 px au lieu de monter de 140)
```

Ce n'est pas une convention discutable (« pan de caméra » plutôt que « pan de contenu ») : dans ce
cas, l'axe horizontal serait inversé lui aussi. C'est un bug de signe.

**Erreur 2 — l'amplitude.** Il manque la division par `cosθ` :

| `polar` | élévation | facteur d'erreur | ressenti |
|---|---|---|---|
| 0,12 | 83° | 0,99 | invisible |
| 0,78 (défaut) | 45° | **0,71** | le sol glisse de 30 % sous le curseur |
| 1,20 | 21° | 0,36 | il faut trois gestes pour un |
| 1,54 (`MAX_POLAR`) | 2° | **0,03** | le panoramique vertical ne fait plus rien |

La base `up × right` est identique à celle de `MapControls` de three.js avec
`screenSpacePanning = false` — mais three.js, lui, a le bon signe : il calcule
`_panDelta = _panEnd − _panStart` puis applique `_panLeft(…deltaX…)` (qui **nie**) et
`_panUp(…deltaY…)` (qui **ne nie pas**), ce qui donne exactement `T·right = −dx·s` et
`T·up = +dy·s`. Le portage dans `DioramaControls` a perdu cette asymétrie.

**Et la correction `1/cosθ` ne suffit pas.** Une fois le signe rétabli, l'erreur résiduelle
mesurée sur un glissement de 180 × 140 px à 9 m vaut encore :

| Élévation | Erreur avec `1/cosθ` corrigé |
|---|---|
| 61° | 11,9 px |
| 38° | 26,0 px |
| 21° | 46,8 px |
| 10° | 88,1 px |

Parce qu'un plan de sol vu en biais **ne se translate pas uniformément à l'écran** : les points
proches de l'horizon bougent moins que ceux du bas de l'image. L'approximation
« un pixel = `2·d·tan(fov/2)/h` mètres » n'est exacte qu'au premier ordre.

La vraie solution — celle que three.js a fini par adopter pour le pan de `MapControls`, et qui
donne **0,000 px d'erreur** — est de ne pas approximer du tout : on intersecte le rayon du curseur
avec le plan du sol au début et à la fin du mouvement, et on translate de l'opposé. Voir §4.3.

### 1.4 D4 — aucune collision

```js
const x = this.target.x + this.distance * sp * Math.sin(this.azimuth);
const y = this.target.y + this.distance * Math.cos(this.polar);
const z = this.target.z + this.distance * sp * Math.cos(this.azimuth);
this.camera.position.set(x, y, z);
```

Rien ne garantit `y > 0`. Avec `MAX_POLAR = π·0.49` et `target.y = 1,3 m`, la caméra descend à
`1,3 + 1,4·cos(1,539) = 1,34 m` à distance minimale — au-dessus du sable, par chance. Mais à
`distance = 1,4` et `target.y = 0,2` (après un panoramique dans un trou), on obtient `y = 0,24 m`
avec un terrain à 1,6 m : **la caméra est enterrée**, `near = 0,05` fait apparaître l'intérieur
des voxels, et le shader de sable affiche ses faces arrière. De même, rien n'empêche la caméra
de passer sous `y = 0` et de regarder le diorama par en dessous, ce qui casse net l'illusion
« objet posé sur une table ».

### 1.5 D5 — vitesse clavier constante

```js
const sp = 3.2 * dt * (this.keys.has('ShiftLeft') ? 2.4 : 1);
```

3,2 m/s quelle que soit la distance. À 34 m, traverser le bloc de 10 m prend 3 s : trop lent. À
1,4 m, un appui de 0,2 s sur `W` déplace la cible de 64 cm, soit **trois fois la largeur visible
de l'écran** (à 1,4 m et 32°, la hauteur visible vaut `2·1,4·tan16° = 0,80 m`). On perd le
château instantanément. La vitesse doit être proportionnelle à la distance.

### 1.6 D6 — distance interpolée linéairement

```js
this.distance += (this.goalDistance - this.distance) * k;
```

Le zoom est perçu de façon *multiplicative* : passer de 16 m à 8 m et de 8 m à 4 m sont deux
gestes identiques pour l'œil. Un lerp linéaire de 16 → 2 m parcourt 7 m dans la première frame
et 0,02 m dans la dernière : le mouvement démarre en fusée et finit en escargot. Il faut
interpoler `ln(distance)`. Corollaire agréable : les bornes deviennent `ln(1,4)` et `ln(34)`,
et l'amortissement en espace log garantit qu'un cran de molette produit toujours le même
*ressenti* de zoom, quelle que soit la distance de départ.

### 1.7 D7 — les commandes de recadrage manquent

`GAME-DESIGN.md` §4.1.2 promet `F` (focus curseur), `R` (reset), `T` (vue de dessus
orthographique), `+`/`-` (zoom), `Espace` maintenu (mode caméra temporaire), `Q`/`E` en pas de
45°, et le double-clic molette pour le focus. Aucune n'existe. `focus()` existe mais n'est
appelée qu'une fois, depuis `Game.init()`.

Ces touches sont libres : le relevé des `e.code` utilisés dans `src/` donne `BracketLeft`,
`BracketRight`, `Escape`, `F3`, `KeyH`, `KeyO`, `KeyP`, `KeyS`, `KeyY`, `KeyZ`, `Digit0..9`, plus
`KeyW/A/S/D/Q/E` pour la caméra. `KeyF`, `KeyR`, `KeyT`, `KeyG`, `KeyV`, `Space`, `Equal`,
`Minus` et les flèches sont disponibles.

### 1.8 D8 — bornes en désaccord avec le doc de design

| Paramètre | Code | `GAME-DESIGN.md` §4.2 | Verdict |
|---|---|---|---|
| Distance min | 1,4 m | 2,5 m | Le code a raison : à 32° de FOV, 2,5 m ne permet pas de voir un créneau de 12 cm en gros plan. **Garder 1,4 m**, mais activer la collision (D4) qui devient alors indispensable. |
| Distance max | 34 m | 22 m | 34 m est nécessaire pour le recadrage complet en format portrait (voir §5.3). Garder. |
| Élévation min | 2° (`MAX_POLAR = π·0.49`) | 8° | Le doc a raison : sous 8° on ne lit plus le relief et le panoramique devient impossible. **Passer `MAX_POLAR` à `π/2 − 8°` = 1,4312.** |
| Élévation max | 83° (`MIN_POLAR = 0.12`) | 82° | Équivalent. Garder 0,12, mais autoriser `polar → 0` en vue de dessus. |
| Élévation par défaut | 45° (`polar = 0.78`) | 38° | 38° est plus « diorama ». `polar = 0.9076`. |
| Amortissement | 0,16/frame | 0,12/frame | À reparamétrer en demi-vie (§4.1). |

### 1.9 D9 — trackpad et tactile

`onPointerDown` ne teste que `e.button`. Un contact tactile arrive avec `button === 0`, donc il
est capté par `ToolManager` comme une action de pelle, et la caméra est totalement inatteignable
au doigt. Il n'existe par ailleurs aucun moyen d'orbiter sur un trackpad sans molette
cliquable autrement que par `Alt + clic gauche` — ce qui, sur macOS, est intercepté par le
système dans certaines configurations (Mission Control).

### 1.10 D10 — fuite d'écouteurs

Les trois `window.addEventListener('keydown' | 'keyup' | 'blur', …)` du constructeur sont créés
avec des fermetures anonymes et ne sont jamais retirés. `dispose()` n'en retire aucun. À chaque
rechargement à chaud de Vite, un jeu de listeners supplémentaire s'accumule et pilote une caméra
fantôme.

### 1.11 D11 — amortissement illisible

```js
const k = dt > 0 ? 1 - Math.pow(1 - this.damping, dt * 60) : 1;
```

La correction de framerate est **déjà correcte** (c'est le bon `1 − (1−k₆₀)^(dt·60)`), il faut le
souligner : c'est mieux que la majorité des bases de code. Mais `0.16` ne dit rien à personne.
La même chose exprimée en demi-vie : `t½ = ln2 / (60·ln(1/0,84)) = 66 ms`. C'est ce nombre-là
qu'un designer sait régler.

### 1.12 Deux détails de plomberie

**`stopPropagation` inopérant.** `ToolManager.onWheel` appelle `e.stopPropagation()`, mais les
deux écouteurs `wheel` sont posés sur **le même élément** (`game.canvas`) : `stopPropagation`
n'empêche pas l'autre écouteur du même nœud de s'exécuter (il faudrait
`stopImmediatePropagation`). Ce qui sauve le code aujourd'hui, c'est l'ordre d'enregistrement
(`DioramaControls` est construit avant `ToolManager`) et le fait que chacun sorte tôt sur le test
`ctrlKey`. C'est fragile. La refonte fait transiter *tous* les `wheel` par un seul routeur.

**Base caméra potentiellement périmée.** `pan()` lit `this.camera.matrixWorld`, qui n'est mis à
jour qu'au rendu. Entre deux frames, un `pointermove` utilise donc la matrice de la frame
précédente. Sans conséquence visible ici (le vecteur `right` est recalculé à partir de
`azimuth` juste après), mais autant calculer la base analytiquement et supprimer la dépendance.

---

## 2. Zoom ancré sur le curseur

C'est la demande explicite du joueur, et c'est la seule modification qui change *vraiment* la
sensation d'utilisation. Le reste du document est de l'hygiène ; celle-ci est du game feel.

### 2.1 Ce qu'on veut, formellement

Soit `P` un point du monde (l'**ancre**) actuellement visible sous le curseur. Après un cran de
molette, on veut que `P` se projette **au même pixel**. C'est tout. Tout le reste en découle.

Notations :

```
T       cible d'orbite (world)
A, θ    azimut, angle polaire depuis +Y
d       distance caméra-cible
u(A,θ) = (sinθ·sinA, cosθ, sinθ·cosA)     vecteur unitaire cible -> caméra
C = T + d·u                                position caméra
k       facteur de zoom (k < 1 = on se rapproche)
```

### 2.2 Dérivation

**Étape 1 — l'orientation ne doit pas bouger.** Un zoom qui change `A` ou `θ` est une orbite
déguisée : le joueur perd sa lecture de la scène. On impose donc `A' = A`, `θ' = θ`, donc
`u' = u`. La base caméra `(right, up, fwd)` est inchangée.

**Étape 2 — condition d'invariance à l'écran.** Une caméra perspective projette un point `X` en
fonction de la *direction* de `X − C` dans la base caméra (la division par la profondeur efface
la norme). Comme la base ne change pas, `P` se projette au même pixel si et seulement si :

```
P − C'  =  λ · (P − C),      λ > 0                                        (1)
```

Autrement dit **la caméra doit se déplacer sur la droite (C, P)**. D'où :

```
C' = P + λ·(C − P)                                                        (2)
```

C'est déjà le résultat important : *le zoom ancré n'est pas un changement de distance, c'est une
translation de la caméra le long du rayon qui passe par le curseur.*

**Conséquence qu'on n'attend pas, et qui simplifie tout.** L'équation (1) ne fait intervenir ni la
profondeur de `P`, ni sa nature. Pour **tout** point `Q = C + t·û` du rayon curseur, `C' − Q` reste
colinéaire à `û` : c'est **la droite entière qui est épinglée sous le curseur**, pas seulement `P`.
La profondeur de l'ancre ne détermine donc pas *si* l'ancrage tient, seulement **à quelle vitesse
on zoome** (`δ = p·(1−k)` où `p = |P − C|`). Le choix du plan de repli (§2.5) est de ce fait
beaucoup moins critique qu'il n'y paraît : une ancre trop lointaine ne casse pas l'ancrage, elle
rend le geste trop rapide. D'où le seul garde-fou vraiment nécessaire : borner `p`.

C'est le commentaire qu'on lit dans `OrbitControls.js` de three.js, à l'endroit exact où il
applique le dolly : *« move the camera down the pointer ray — this method avoids floating point
error »*.

**Étape 3 — choisir λ.** On veut que le zoom « fasse `k` », c'est-à-dire que la distance à la
cible soit multipliée par `k`. Prenons `λ = k` et voyons ce que devient la cible. Puisque
`T' = C' − d'·u` et `d' = k·d` :

```
T' = P + k·(C − P) − k·d·u
   = P + k·(C − d·u − P)
   = P + k·(T − P)                                                        (3)
```

Le résultat est d'une simplicité remarquable :

> **La caméra, la cible et la distance subissent une seule et même homothétie de centre `P` et de
> rapport `k`.**
>
> ```
> T ← P + k·(T − P)        d ← k·d        (C ← P + k·(C − P) suit automatiquement)
> ```

Forme équivalente, plus commode à coder parce qu'elle s'exprime comme un déplacement :

```
T ← T + (1 − k)·(P − T)                                                   (4)
```

`k < 1` (zoom avant) ⇒ `(1−k) > 0` ⇒ la cible glisse **vers** l'ancre, d'une fraction `(1−k)` du
chemin. Un cran de molette classique vaut `k ≈ 0,88`, donc la cible avance de 12 % vers l'ancre.
C'est doux, et au bout d'une dizaine de crans la cible *est* l'ancre — ce qui est exactement le
comportement souhaité : le point qu'on regarde devient le pivot de l'orbite.

**Étape 4 — vérification de la composition.** Une homothétie de rapport `k₁` suivie d'une
homothétie de même centre et de rapport `k₂` est une homothétie de rapport `k₁·k₂`. Donc dix
crans de molette successifs avec la même ancre donnent rigoureusement le même résultat qu'un
seul cran de rapport `k¹⁰`. **Il n'y a aucune accumulation d'erreur.** C'est ce qui rend
l'implémentation testable au pixel près (test T1, §7.2).

### 2.3 Les deux pièges classiques, et pourquoi (4) les évite

**Piège A — ne bouger que la distance.** C'est le code actuel : `T' = T`, `d' = k·d`. On retrouve
(2) avec `P` = le point de l'axe de visée, c'est-à-dire le centre de l'écran. Le zoom converge
donc vers le centre, quoi qu'on fasse. Diagnostic D1.

**Piège B — bouger la cible « vers le curseur » sans la lier à `k`.** L'erreur qu'on voit le plus
souvent dans les implémentations maison :

```js
// FAUX
this.goalDistance *= k;
this.goalTarget.lerp(anchorPoint, 0.15);   // 0,15 sorti du chapeau
```

Ici la cible avance de 15 % vers l'ancre pendant que la distance est multipliée par `k`. Les deux
mouvements ne se compensent plus : la caméra **dérive latéralement**. Le symptôme est
caractéristique — en zoomant sur une tour, la tour glisse doucement hors de l'écran alors même
qu'on zoome dessus, et en zoom arrière la cible part à l'infini. La seule valeur correcte du
coefficient est `(1 − k)`, et elle n'est pas libre : elle est imposée par l'équation (1).

Le facteur d'interpolation qui évite les deux pièges est donc :

```
α = β · (1 − k_eff)
T ← T + α·(P − T)
```

avec deux raffinements indispensables, développés ci-dessous : `k_eff` (§2.4) et `β` (§2.8).

### 2.4 `k_eff` : le rapport réellement appliqué

La distance est bornée (`1,4 → 34 m`). Si on demande `k = 0,88` alors que `d = 1,45 m`, la
distance sera écrêtée à 1,4 m, soit un rapport réel de 0,966 — mais si on applique quand même
`(1 − 0,88)` à la cible, l'homothétie est incohérente et **la caméra glisse latéralement sans
zoomer**. Sur une souris qui produit vingt crans par seconde, cette dérive est très visible : le
joueur, bloqué à la distance minimale, voit la scène défiler toute seule.

C'est un défaut connu et régulièrement signalé des implémentations de `zoomToCursor`. Le
correctif tient en trois lignes :

```js
const dBefore = this.goalDistance;
const dAfter  = clamp(dBefore * k, this.minDistance, this.maxDistance);
const kEff    = dAfter / dBefore;          // <- le SEUL rapport a utiliser ensuite
```

Quand la borne est atteinte, `kEff === 1`, `(1 − kEff) === 0`, la cible ne bouge plus. Le zoom
« sature » proprement.

C'est exactement ce que fait Blender, qui clampe le **facteur** et non la distance a posteriori :

```c
const float zfac_min = dist_range.min / vod->rv3d->dist;
const float zfac_max = dist_range.max / vod->rv3d->dist;
CLAMP(zfac, zfac_min, zfac_max);
if (zfac != 1.0f) { view_zoom_to_window_xy_3d(...); }   /* court-circuit en butee */
```

Trois logiciels, trois comportements en butée — et le nôtre :

| Logiciel | En butée de distance minimale |
|---|---|
| three.js `zoomToCursor` | `radiusDelta = 0`, la caméra ne bouge plus, **aucun événement émis**. L'utilisateur scrolle dans le vide sans comprendre. |
| Blender | Idem, mais assumé et documenté : il faut **changer d'opérateur** (`Dolly`, `Shift+Ctrl+MMB`) pour continuer d'avancer. |
| `camera-controls` (`infinityDolly`) | Bascule automatiquement du zoom au **dolly** : la distance reste à sa borne et c'est **la cible** qu'on pousse le long de l'axe. |
| **Sandcastle** | Comme `camera-controls`, mais borné par `clampTarget()`. Voir ci-dessous. |

Sur un diorama de 10 m, la troisième voie est la bonne : arrivé à 1,4 m, continuer à scroller doit
faire **avancer** dans le sable, pas ne rien faire. La cible étant de toute façon bornée par
`clampTarget()`, il n'y a aucun risque de se perdre.

```js
// En butee : on bascule du zoom au dolly. La distance reste bloquee, mais on
// pousse la cible le long de l'axe de visee — donc on continue d'avancer.
if (Math.abs(kEff - 1) < 1e-6) {
  if (!this.infinityDolly) return;
  const want = Math.exp(notches * ZOOM_PER_NOTCH);
  const push = this.goalDistance * (1 - want);        // > 0 si on zoome avant
  const A = this.goalAzimuth, th = this.goalPolar;
  this.goalTarget.x -= push * Math.sin(th) * Math.sin(A);
  this.goalTarget.y -= push * Math.cos(th);
  this.goalTarget.z -= push * Math.sin(th) * Math.cos(A);
  this.clampTarget();
  return;
}
```

### 2.5 Trouver l'ancre `P`

Trois niveaux de repli, du plus juste au plus dégradé :

```js
/**
 * Point du monde sous le curseur, vu depuis l'etat BUT de la camera.
 *
 * On tire le rayon depuis la camera-but et non depuis la camera visible :
 * c'est la seule facon d'obtenir une invariance exacte apres convergence de
 * l'amortissement (voir 2.7). Au repos, les deux coincident.
 */
anchorAt(clientX, clientY) {
  const r = this.dom.getBoundingClientRect();
  const ndcX = ((clientX - r.left) / r.width) * 2 - 1;
  const ndcY = -((clientY - r.top) / r.height) * 2 + 1;

  // --- base et origine du rayon, calculees analytiquement -----------------
  const A = this.goalAzimuth, th = this.goalPolar, d = this.goalDistance;
  const sa = Math.sin(A), ca = Math.cos(A);
  const st = Math.sin(th), ct = Math.cos(th);

  const ux = st * sa, uy = ct, uz = st * ca;              // cible -> camera
  const ox = this.goalTarget.x + d * ux;
  const oy = this.goalTarget.y + d * uy;
  const oz = this.goalTarget.z + d * uz;

  const tanV = Math.tan((this.camera.fov * Math.PI) / 360);
  const tanH = tanV * this.camera.aspect;
  const sx = ndcX * tanH, sy = ndcY * tanV;

  // fwd = -u ; right = (ca, 0, -sa) ; up = (-ct*sa, st, -ct*ca)
  let dx = -ux + sx * ca + sy * (-ct * sa);
  let dy = -uy + sy * st;
  let dz = -uz + sx * (-sa) + sy * (-ct * ca);
  const inv = 1 / Math.hypot(dx, dy, dz);
  dx *= inv; dy *= inv; dz *= inv;

  // --- 1. le terrain ------------------------------------------------------
  const hit = this.field?.raycast({ x: ox, y: oy, z: oz }, { x: dx, y: dy, z: dz }, 80);
  if (hit) return this._clampAnchor(hit.point.x, hit.point.y, hit.point.z);

  // --- 2. plan horizontal a la hauteur de la cible ------------------------
  // On vise le ciel, ou la mer au-dela du bloc. Le plan y = target.y est le
  // repli le plus naturel : c'est le plan que le joueur "sent" comme son plan
  // de travail, et il assure la continuite quand le curseur franchit la
  // silhouette du terrain.
  if (Math.abs(dy) > 1e-5) {
    const t = (this.goalTarget.y - oy) / dy;
    if (t > 0.05 && t < 400) {
      return this._clampAnchor(ox + dx * t, this.goalTarget.y, oz + dz * t);
    }
  }

  // --- 3. plan perpendiculaire a la visee, passant par la cible ------------
  // Le rayon monte vers le ciel : plus aucun plan horizontal devant nous.
  // Ce repli degrade CONTINUMENT vers le zoom classique : au centre de
  // l'ecran il redonne exactement P = target, donc alpha = 0.
  const denom = dx * -ux + dy * -uy + dz * -uz;
  const t = d / Math.max(1e-4, denom);
  return this._clampAnchor(ox + dx * t, oy + dy * t, oz + dz * t);
}

/**
 * L'ancre est bridee a la boite du diorama + marge : sans cela, viser la mer
 * lointaine tirerait la cible a 200 m et on perdrait le chateau.
 */
_clampAnchor(x, y, z) {
  const m = ANCHOR_MARGIN;                       // 1,6 m
  return this._anchor.set(
    clamp(x, -WORLD_W / 2 - m, WORLD_W / 2 + m),
    clamp(y, 0, WORLD_H),
    clamp(z, -WORLD_D / 2 - m, WORLD_D / 2 + m)
  );
}
```

Note sur le repli n° 2 : il est **meilleur que le repli « plan `y = 0` »** qu'on trouve souvent.
Ici `y = 0` est la base du bloc, 1,6 m sous la surface du sable : ancrer là-dessus donne un zoom
qui plonge sous la plage. Le plan `y = target.y` suit la hauteur de travail courante et assure la
continuité quand le curseur passe du sable au ciel — la discontinuité résiduelle vaut la
différence de hauteur entre le terrain et la cible, quelques dizaines de centimètres,
imperceptible à l'écran.

### 2.6 Le verrouillage de l'ancre (le détail qui fait tout)

Si on relance un raycast à **chaque** événement `wheel`, l'ancre saute : un trackpad produit
60 événements par seconde et, entre deux événements, la silhouette du terrain a bougé sous le
curseur (on s'est rapproché), donc `P` change de plusieurs centimètres. Résultat : un zoom qui
tremble et qui, cumulativement, dérive.

**Règle :** on verrouille `P` au premier événement d'une rafale, et on le garde tant que

- moins de `ANCHOR_HOLD = 180 ms` séparent deux événements `wheel`, **et**
- le curseur n'a pas bougé de plus de `ANCHOR_SLOP = 12 px` depuis le verrouillage.

```js
_latchAnchor(clientX, clientY, now) {
  const stale = now - this._anchorTime > ANCHOR_HOLD;
  const moved = Math.hypot(clientX - this._anchorPx, clientY - this._anchorPy) > ANCHOR_SLOP;
  if (!this._anchorValid || stale || moved) {
    this.anchorAt(clientX, clientY);             // remplit this._anchor
    this._anchorPx = clientX;
    this._anchorPy = clientY;
    this._anchorValid = true;
  }
  this._anchorTime = now;
  return this._anchor;
}
```

Deux bénéfices : le raycast (~0,15 ms sur ce champ voxel, cf. `VoxelField.raycast` — DDA + 12
dichotomies) n'est fait qu'une fois par rafale au lieu de soixante fois par seconde, et la
composition des homothéties devient exacte puisque le centre est constant.

C'est le mécanisme le plus important de tout ce chapitre, et ce n'est pas une invention :
CesiumJS fait exactement cela, avec la même condition — l'ancre monde n'est re-piquée que si la
position **écran** du curseur a changé.

```js
// CesiumJS, ScreenSpaceCameraController.js
if (!sameStartPosition) {
  object._zoomMouseStart = Cartesian2.clone(startPosition, object._zoomMouseStart);
  pickedPosition = pickPosition(object, startPosition, scratchPickCartesian);
  if (defined(pickedPosition)) {
    object._useZoomWorldPosition = true;
    object._zoomWorldPosition = Cartesian3.clone(pickedPosition, object._zoomWorldPosition);
  } else {
    object._useZoomWorldPosition = false;   // rien sous le curseur : zoom classique
  }
}
```

Le repli de Cesium quand rien n'est touché est d'ailleurs le plus honnête de tous : plutôt
qu'inventer une ancre, il **désactive l'ancrage pour ce geste** (`camera.zoomIn(distance)`). On
préfère ici le plan de repli, parce que sur un diorama le rayon touche presque toujours quelque
chose et que la discontinuité d'un basculement de mode se verrait.

**Et le garde-fou sur la profondeur.** Comme montré au §2.2, la profondeur `p = |P − C|` ne change
pas la validité de l'ancrage, seulement sa vitesse. Une ancre à 200 m (la mer au loin) donnerait
`δ = p·(1−k) = 24 m` pour un seul cran : une téléportation. On borne donc :

```js
// p est borne entre "juste devant le near plane" et 8 fois la distance courante.
// Sans ce clamp, un cran de molette vise a 200 m et deplace la camera de 24 m.
const p = clamp(cameraToAnchorDistance, this.camera.near * 4, this.goalDistance * 8);
```

### 2.7 Ancrage exact **pendant** l'amortissement

L'amortissement complique le tableau : `goalDistance` saute d'un coup, `distance` la rejoint en
~200 ms. Si on applique l'homothétie à l'état *but* et qu'on laisse chaque canal converger
indépendamment, l'ancre n'est exacte **qu'après convergence** ; pendant le transit elle glisse de
quelques pixels. C'est ce que fait `MapControls` de three.js, et c'est acceptable.

On peut faire strictement mieux, et pour presque rien. L'astuce repose sur la propriété de
composition (§2.2, étape 4) :

> Si, à chaque frame, on mesure le rapport réellement parcouru par la distance
> `k_frame = d_après / d_avant` et qu'on applique l'homothétie de centre `P` et de rapport
> `k_frame` à la cible **courante**, alors l'ancre reste exacte à **chaque frame** du transit —
> parce que le produit des `k_frame` sur toute la durée du transit vaut exactement le `k` total
> demandé.

On obtient un zoom dont le point sous le curseur est *rigoureusement* immobile du premier au
dernier pixel de l'animation. C'est visuellement très différent — et bien plus agréable — d'un
zoom qui « recale » à la fin.

Implémentation (extrait de `update`, version finale au §8) :

```js
// --- distance : ressort en espace log --------------------------------------
const dPrev = this.distance;
this._logD = spring(this._logD, Math.log(this.goalDistance), this._sv, 'd', dt, SMOOTH_ZOOM);
this.distance = Math.exp(this._logD);

// --- ancrage : on transporte la cible avec la meme homothetie ---------------
if (this._zoomAnchorActive) {
  const kFrame = this.distance / dPrev;
  const P = this._anchor;
  const a = 1 - kFrame;                          // equation (4)
  // On applique a la cible COURANTE **et** au but, sinon la cible "revient"
  // a la fin du transit et l'ancrage se defait.
  this.target.x += (P.x - this.target.x) * a;
  this.target.y += (P.y - this.target.y) * a;
  this.target.z += (P.z - this.target.z) * a;
  if (Math.abs(this.goalDistance - this.distance) < this.distance * 1e-3) {
    this._zoomAnchorActive = false;              // transit termine
  }
}
```

et, côté `wheel`, on ne touche qu'au **but** de la distance et au **but** de la cible :

```js
/**
 * Zoom ancre. `notches` est deja normalise (§3) : 1 = un cran de molette.
 */
zoomAt(clientX, clientY, notches) {
  const P = this._latchAnchor(clientX, clientY, performance.now());

  const dBefore = this.goalDistance;
  const dAfter  = clamp(dBefore * Math.exp(notches * ZOOM_PER_NOTCH),
                        this.minDistance, this.maxDistance);
  const kEff = dAfter / dBefore;
  if (Math.abs(kEff - 1) < 1e-6) return;         // borne atteinte : on ne derive pas

  // Facteur d'ancrage : plein en zoom avant, nul en zoom arriere (2.8).
  const beta = kEff < 1 ? this.anchorIn : this.anchorOut;
  const a = beta * (1 - kEff);

  this.goalTarget.x += (P.x - this.goalTarget.x) * a;
  this.goalTarget.y += (P.y - this.goalTarget.y) * a;
  this.goalTarget.z += (P.z - this.goalTarget.z) * a;

  // Recentrage doux en zoom arriere (2.8).
  if (kEff > 1 && this.recenterOnZoomOut) {
    const g = RECENTER_GAIN * (1 - 1 / kEff);
    this.goalTarget.x += (HOME_TARGET.x - this.goalTarget.x) * g;
    this.goalTarget.z += (HOME_TARGET.z - this.goalTarget.z) * g;
  }

  this.goalDistance = dAfter;
  this.clampTarget();
  // Transit exact seulement si l'ancrage est plein : sinon le dolly est libre.
  this._zoomAnchorActive = beta > 0.999;
}
```

> Cet extrait omet, pour la lisibilité, la branche « butée » du §2.4 (bascule automatique vers le
> dolly). La version complète et vérifiée est au §8.

> **Attention.** `clampTarget()` peut casser l'invariance quand la cible atteint le bord du
> domaine. C'est voulu : mieux vaut perdre l'ancrage de quelques pixels que laisser le joueur
> partir en mer. Le test T1 (§7.2) vise volontairement une ancre à l'intérieur du bloc ; un test
> secondaire vérifie qu'au bord l'erreur reste bornée et ne diverge pas.

### 2.8 Faut-il ancrer aussi en dézoom ? — Tranché : **non**, et c'est un choix argumenté

Commençons par l'état de l'art, parce qu'il va **contre** la décision retenue et qu'il faut le
regarder en face :

| Implémentation | Dézoom ancré ? |
|---|---|
| three.js `zoomToCursor` | **oui**, symétrique (`radiusDelta < 0`, on recule le long du rayon) |
| Blender « Zoom to Mouse Position » | **oui**, symétrique (même fonction, `dfac > 1`) |
| `yomotsu/camera-controls` `dollyToCursor` | **oui** (`lerpRatio < 0`, le lerp éloigne la cible) |
| CesiumJS | **oui**, tant que l'ancre mémorisée reste valide |
| FreeCAD `zoomAtCursor` | **oui** (`pan / zoom / unpan` est symétrique) |

**Aucune** des implémentations de référence ne casse la symétrie. Leur argument est solide, et
c'est le meilleur du camp adverse :

> **L'inversibilité exacte.** L'homothétie de centre `P` et de rapport `k` a pour inverse
> l'homothétie de centre `P` et de rapport `1/k`. Si le curseur ne bouge pas, un cran avant suivi
> d'un cran arrière **redonne exactement l'état initial**. Recentrer au dézoom casse cette
> propriété : le joueur qui a scrollé un cran de trop ne peut plus revenir en arrière, il doit
> re-viser. C'est un dégât d'utilisabilité réel et mesurable.

Le second argument du camp symétrique est le modèle mental : « la molette dilate l'image autour du
curseur » est le geste universel du navigateur, de Photoshop, de Google Maps et de tous les SIG.
Le casser en dézoom crée deux gestes différents pour un seul contrôle.

Malgré tout, on tranche pour l'asymétrie **dans ce jeu-ci**, pour trois raisons.

1. **La cible fuit.** En zoom arrière on cherche presque toujours à *reprendre du contexte*, pas
   à s'éloigner d'un point précis. Si l'ancre est près du bord de l'écran,
   `T ← T + (1−k)(P−T)` avec `k = 1,14` pousse la cible dans la direction **opposée** au curseur,
   à raison de 14 % de la distance cible-ancre par cran. En huit crans on a quitté le bloc, et
   `clampTarget()` fait buter la caméra contre la limite. Sensation : « la caméra s'est barrée ».
2. **L'asymétrie casse la réversibilité.** Cinq crans avant puis cinq crans arrière, avec ancrage
   des deux côtés et une ancre re-verrouillée entre-temps (le terrain sous le curseur a changé),
   ne ramènent pas à l'état de départ. Le joueur perd son point de vue en croyant l'annuler.
3. **Le domaine est minuscule.** C'est ce qui change tout par rapport à Blender ou Cesium : ils
   travaillent dans un espace non borné, où « la cible dérive » n'a pas de sens absolu. Ici, la
   cible est bornée à 10,24 × 10,24 m par `clampTarget()`. Une cible qui fuit vers l'ancre en
   dézoom atteint la butée en huit crans et **s'y colle** — la caméra bute contre une paroi
   invisible et le joueur ne comprend pas pourquoi son dézoom « accroche ». L'asymétrie n'est pas
   une préférence esthétique : c'est ce qui empêche la butée d'être atteinte.

   Le reproche récurrent fait au « Zoom to Mouse Position » symétrique — alterner un zoom avant
   ici et un zoom arrière là fait errer le pivot, si bien qu'au bout de quelques allers-retours on
   orbite « autour de nulle part » — est ici amplifié par la petitesse du domaine.

**Ce qu'on perd, et comment on le rend.** On perd l'inversibilité exacte. On la rend autrement, et
c'est même mieux : `Ctrl+Z` de la caméra n'existe pas, mais `R` (vue diorama) et `A` (tout voir)
sont à une touche, et le recentrage en dézoom (ci-dessous) fait converger vers un état connu au
lieu de diverger. Le joueur qui « s'est perdu » retrouve son cadre en une touche — ce qui, sur un
diorama, est une meilleure réponse qu'une inversion au cran près.

**Décision retenue** — deux facteurs séparés, exposés en options :

```js
this.anchorIn  = 1.00;   // zoom avant  : ancrage exact
this.anchorOut = 0.00;   // zoom arriere : dolly pur, la cible ne bouge pas
```

Et, en prime, un **recentrage doux en zoom arrière**. Quand on s'éloigne, la cible revient
lentement vers le centre du diorama — c'est le comportement de Google Earth et de la plupart des
logiciels de CAO. La force du rappel est proportionnelle à la fraction de zoom arrière effectuée,
donc rigoureusement nulle si on ne dézoome pas :

```js
const g = RECENTER_GAIN * (1 - 1 / kEff);      // 0 a k=1, -> RECENTER_GAIN quand k -> inf
```

Avec `RECENTER_GAIN = 0.55` et un cran typique (`k = 1,136`), `g = 0,066` : il faut une dizaine
de crans pour ramener la cible au centre, ce qui correspond justement au trajet 3 m → 30 m. Le
joueur ne perçoit pas le rappel ; il perçoit que « le dézoom montre tout ». C'est exactement
l'effet recherché.

**Option pour ceux qui la veulent.** Un réglage `Zoom curseur : avant / avant + arrière / jamais`
dans les options, mappé sur `(anchorIn, anchorOut)` = `(1, 0)` / `(1, 1)` / `(0, 0)`.

### 2.9 Le zoom clavier `+` / `−` s'ancre-t-il ?

Oui, sur le curseur s'il est dans la fenêtre, sur le centre de l'écran sinon. C'est gratuit :
`zoomAt(lastPointerX, lastPointerY, ∓1)`. Cohérence garantie entre les deux moyens de zoomer, et
le test T1 peut être rejoué à l'identique sur le chemin clavier.

### 2.10 Effet de bord bienvenu : le tilt-shift suit

`Game.update` fait déjà `post.focusOn(tools.hit ? hit.point : controls.target)`. Avec le zoom
ancré, `controls.target` converge vers ce que le joueur regarde vraiment ; la bande nette du
tilt-shift se cale donc toute seule sur le sujet, même quand le curseur quitte le sable. Aucune
ligne à écrire.

---

## 3. Normalisation de la molette

### 3.1 `deltaMode` : trois unités, aucune portable

L'événement `WheelEvent` de la spécification UI Events porte `deltaX/deltaY/deltaZ` **et** un
`deltaMode` qui en donne l'unité :

| Constante | Valeur | Unité | Qui l'émet |
|---|---|---|---|
| `DOM_DELTA_PIXEL` | 0 | pixels CSS | Chromium (tous OS), WebKit/Safari, Firefox sur trackpad et sur macOS |
| `DOM_DELTA_LINE` | 1 | lignes de texte | **Firefox** avec une souris à crans sur Windows et Linux |
| `DOM_DELTA_PAGE` | 2 | pages | Windows réglé sur « défiler d'un écran par cran » ; rarissime mais existe |

**Chromium ne peut structurellement pas produire `DOM_DELTA_LINE`.** Le convertisseur de Blink
(`third_party/blink/renderer/core/events/wheel_event.cc`) n'a que deux issues :

```cpp
return event.delta_units == ui::ScrollGranularity::kScrollByPage
           ? WheelEvent::kDomDeltaPage
           : WheelEvent::kDomDeltaPixel;
```

C'est une information de première importance pour la §3.5 : **une heuristique fondée sur
« je n'ai jamais vu de `DOM_DELTA_LINE` donc c'est un trackpad » classe tout Chrome/Windows en
trackpad.** C'est exactement l'heuristique que propose `GAME-DESIGN.md` §4.1.3, et elle est
fausse.

La spécification ne fixe **aucune** correspondance entre une ligne et un pixel. Les
implémentations qui se sont imposées (`normalize-wheel` de Facebook, reprise par deck.gl,
Excalidraw et beaucoup d'autres) utilisent :

```
1 ligne ≈ 40 px          1 page ≈ 800 px
```

Ce sont des constantes empiriques, pas une norme. Elles fonctionnent parce que le cran de souris
« standard » vaut 3 lignes sous Firefox et 100 à 120 px sous Chromium : `3 × 40 = 120 ≈ 100..120`.

### 3.2 Ordres de grandeur mesurés

| Périphérique / navigateur | `deltaMode` | `deltaY` par cran / par événement | `wheelDeltaY` | Fréquence |
|---|---|---|---|---|
| Souris à crans, Chrome/Edge **Windows** | 0 | **exactement 100** | −120 | 5–20 evt/s |
| Souris à crans, Firefox Windows/Linux | 1 | **exactement 3** (lignes) | −120 | 5–20 evt/s |
| Souris à crans, Chrome **macOS** | 0 | **`n × 4,000244140625`** | −120·n | 5–30 evt/s |
| Souris à crans, Safari macOS | 0 | ~10 × accélération | −round(deltaY) | 5–30 evt/s |
| **Trackpad Windows Precision** | 0 | **multiples de 0,8333…** | −3·deltaY | 40–120 evt/s |
| Trackpad macOS, deux doigts | 0 | 1 → 100+, avec **queue d'inertie** de 1–2 s | −3·deltaY | ~60–120 evt/s |
| Magic Mouse | 0 | idem trackpad (défilement continu) | −3·deltaY | jusqu'à 120 evt/s |
| Pincement trackpad, **Chrome / Firefox** | 0 + `ctrlKey` | 0,5 → 3 | −3·deltaY | ~60–120 evt/s |
| Pincement trackpad, **Safari** | *aucun `wheel`* | — | — | `gesturechange` |
| Souris + zoom navigateur ≠ 100 % | 0 | multiplié par `devicePixelRatio` × `visualViewport.scale` | — | — |

Ces chiffres ne sont pas des observations empiriques, ils se dérivent du code des moteurs. Côté
Chromium/Windows :

```cpp
// ui/events/blink/web_input_event_builders_win.cc
// "Here we use 100 px per three lines (the default scroll amount is
//  three lines per wheel tick)."
static const float kScrollbarPixelsPerLine = 100.0f / 3.0f;
scroll_delta *= scroll_lines;            // 3 par defaut (SPI_GETWHEELSCROLLLINES)
scroll_delta *= kScrollbarPixelsPerLine; // => 1 cran = 100 px exactement
```

Corollaire immédiat : si l'utilisateur a réglé Windows sur 5 lignes par cran, `deltaY` vaut 166,67
— et sur 1 ligne, 33,33. **La valeur 100 n'est pas une constante, c'est un réglage système.**

Côté macOS, la « constante magique » `4,000244140625` s'explique entièrement :
`NSEvent.deltaY` vaut nominalement 0,1 mais est un point-fixe 16.16, soit `6554/65536 =
0,100006103515625` ; Chromium le multiplie par `kScrollbarPixelsPerCocoaTick = 40`. **Un cran de
souris macOS est donc toujours un multiple entier exact de 4,000244140625** — signature
exploitable en §3.5.

Enfin, un trackpad Windows Precision envoie des `WM_MOUSEWHEEL` avec `delta = 1` (mode « ultra
haute précision ») au lieu de 120, ce qui produit `deltaY = (1/120)·3·(100/3) = 0,8333…` :
**c'est la source des `deltaY` fractionnaires sous Windows.**

Deux enseignements. Premièrement, il **faut** convertir en une unité commune avant de faire quoi
que ce soit. Deuxièmement, la conversion ne suffit pas : un trackpad et une souris produisent la
même quantité totale de `deltaY` avec des *granularités* et des *fréquences* qui diffèrent d'un
facteur 10, donc la sensibilité doit être différente.

### 3.3 Convertir en « crans »

L'unité interne de `zoomAt()` est le **cran** : 1 cran = un déclic de molette = un facteur de
zoom `exp(ZOOM_PER_NOTCH)`. Tout le reste s'y ramène.

> ### ⚠️ Le piège Firefox : **l'ordre de lecture des propriétés change les valeurs**
>
> MDN le mentionne en une ligne laconique (« *Some browsers, for compatibility reasons, may return
> different units for the `delta*` values depending on whether `deltaMode` has been accessed* »).
> Le mécanisme est dans `dom/events/WheelEvent.cpp` de Gecko, sous le nom
> `DeltaModeCheckingState` :
>
> - si le code lit **`deltaMode` en premier**, Firefox renvoie honnêtement `deltaMode = 1` et un
>   `deltaY` **en lignes** (±3) ;
> - si le code lit **`deltaY` en premier**, Firefox pré-multiplie par la hauteur de ligne réelle
>   **et ment ensuite sur `deltaMode`, en renvoyant 0**.
>
> Le mode catastrophe est donc : lire `deltaY`, puis `deltaMode`, puis multiplier par 40 —
> **la conversion est appliquée deux fois**, et le zoom part quatre fois trop vite sur Firefox.
>
> **Règle absolue : lire `e.deltaMode` en tout premier, avant toute autre propriété de delta.**

```js
const LINE_HEIGHT = 40;    // px par ligne (convention normalize-wheel)
const PAGE_HEIGHT = 800;   // px par page
const NOTCH_PX    = 100;   // px pour un cran de souris "standard"

/**
 * Delta vertical de l'evenement, converti en pixels CSS.
 *
 * ATTENTION a l'ordre des lectures : `deltaMode` DOIT etre lu avant `deltaY`.
 * Firefox change la valeur de `deltaY` selon qu'on a consulte `deltaMode` ou
 * non (DeltaModeCheckingState) ; lire dans le mauvais ordre fait appliquer la
 * conversion ligne->pixel deux fois.
 */
function wheelPixels(e) {
  const mode = e.deltaMode;              // <-- EN PREMIER, toujours
  let dy = e.deltaY;

  if (mode === 1) dy *= LINE_HEIGHT;
  else if (mode === 2) dy *= PAGE_HEIGHT;
  else if (IS_FIREFOX) dy /= devicePixelRatio;   // Firefox double les valeurs en Retina

  // Un evenement aberrant (certains pilotes Windows envoient 3000) ne doit pas
  // teleporter la camera : on borne a 4 crans.
  if (!Number.isFinite(dy)) return 0;
  return clamp(dy, -4 * NOTCH_PX, 4 * NOTCH_PX);
}
```

Le `dy /= devicePixelRatio` sur Firefox n'est pas une superstition : c'est le correctif que
`mjolnir.js` (deck.gl) applique en production, commenté « *Firefox doubles the values on retina
screens…* ». Sans lui, le zoom est deux fois trop rapide sur un MacBook sous Firefox.

Le clamp final n'est pas décoratif non plus. Excalidraw et tldraw plafonnent tous deux à
l'équivalent de dix « pas » (`MAX_ZOOM_STEP = 10` chez tldraw, `MAX_STEP = ZOOM_STEP * 100` chez
Excalidraw) — sans quoi un pilote bavard ou une inertie de trackpad envoie la caméra à l'autre
bout du monde en un événement.

Puis, selon le profil de périphérique détecté :

```js
/** Nombre de crans equivalents. Positif = molette vers soi = zoom arriere. */
function wheelNotches(e, profile) {
  const px = wheelPixels(e);
  if (profile === 'pinch')    return px / PINCH_PX_PER_NOTCH;    // 24
  if (profile === 'trackpad') return px / TRACKPAD_PX_PER_NOTCH; // 60
  return px / NOTCH_PX;                                          // 100
}
```

Les trois diviseurs sont les seuls réglages de sensibilité du zoom, et ils sont exposés dans les
options sous la forme d'un unique multiplicateur « Sensibilité du zoom : 0,25× → 4× ».

Avec `ZOOM_PER_NOTCH = 0.13`, un cran vaut `exp(0.13) = 1,139` : il faut **5,3 crans pour doubler
la distance**, et 24 crans pour parcourir toute la plage 1,4 → 34 m. C'est le bon ordre de
grandeur (une molette standard fait 24 crans en un peu plus d'un tour de doigt).

### 3.4 Distinguer un vrai `Ctrl+molette` d'un pincement de trackpad

C'est le point le plus retors de l'entrée souris dans un navigateur. Le comportement est
**volontaire** : inventé par Microsoft avec IE10, adopté par Chrome en M35 (2014) et par Firefox
en 55, un pincement à deux doigts sur un trackpad est délivré aux pages comme un `wheel` avec
`ctrlKey === true`, précisément pour que les pages qui implémentaient déjà « Ctrl+molette = zoom »
gèrent le pincement gratuitement. Aucun `keydown` de `Control` ne l'accompagne.

> **Ce n'est pas universel, contrairement à ce qu'on lit partout.** **Safari macOS n'envoie pas de
> `wheel` avec `ctrlKey` pour le pincement** : il envoie `gesturestart` / `gesturechange` /
> `gestureend` (§3.5 bis). Un code qui ne gère que le chemin `ctrlKey` n'a **aucun** zoom au
> pincement sur Safari. Et la convention n'est normalisée nulle part : `WheelEvent` a même quitté
> la spécification UI Events pour Pointer Events, où le pincement n'est pas décrit.

Il faut aussi savoir qu'**aucune API ne permet de trancher formellement**. La question canonique
posée sur StackOverflow à ce sujet est, des années plus tard, toujours sans réponse. Ce qui suit
est donc un faisceau d'indices, pas une preuve — et c'est une raison de plus pour que **la
décision n'ait jamais de conséquence irréversible** : elle ne règle qu'une sensibilité.

Trois signaux permettent de trancher, à combiner :

**Signal 1 — l'état réel du clavier (le plus fiable).** On suit `Control` via `keydown`/`keyup`
et on compare :

```js
// Dans le routeur d'entrees :
window.addEventListener('keydown', (e) => { if (e.key === 'Control') this._ctrlDown = true; });
window.addEventListener('keyup',   (e) => { if (e.key === 'Control') this._ctrlDown = false; });
window.addEventListener('blur',    () => { this._ctrlDown = false; });

// e.ctrlKey && !this._ctrlDown  =>  c'est un pincement.
```

Limite connue : si la page reçoit le focus alors que `Ctrl` est *déjà* enfoncé, on rate le
`keydown`. On recale donc `this._ctrlDown = e.ctrlKey` sur tout `keydown`/`keyup`/`pointerdown`
autre que `Control` lui-même, ce qui referme la fenêtre en quelques millisecondes d'usage réel.

**Signal 2 — la granularité.** Un pincement produit des deltas **petits** (1 à 12) et **souvent
fractionnaires**, à ~60 Hz. Un vrai `Ctrl+molette` produit des deltas **multiples de 100 ou de
120** (Chromium) ou de 3 lignes (Firefox), à basse fréquence.

**Signal 3 — la fréquence.** Plus de 25 événements par seconde en continu : pas une molette
mécanique.

```js
/**
 * `true` si cet evenement wheel est (tres probablement) un pincement de
 * trackpad plutot qu'un vrai Ctrl+molette.
 *
 * On ne se fie jamais a un seul signal : le premier est fiable mais peut rater
 * une fenetre de quelques ms au retour de focus, les deux autres sont
 * statistiques.
 */
isPinch(e) {
  if (!e.ctrlKey) return false;
  if (!this._ctrlDown) return true;                 // Ctrl n'est pas enfonce : pincement
  // Ctrl EST enfonce, mais l'utilisateur peut quand meme pincer avec Ctrl.
  // On tranche a la granularite : un cran de molette est "gros" et entier.
  const px = Math.abs(e.deltaY);
  const coarse = e.deltaMode !== 0 || (px >= 40 && Number.isInteger(e.deltaY));
  return !coarse;
}
```

### 3.5 Détecter un trackpad (molette nue)

Aucun signal n'est certain ; on accumule des indices et on bascule de profil quand la preuve est
faite.

#### 3.5.1 Le meilleur indice : `wheelDeltaY === −3 · deltaY`

C'est l'heuristique la plus copiée du web, et on la présente en général comme un hack empirique.
Elle ne l'est pas : c'est la lecture d'un détail d'implémentation **intentionnel et nommé** des
deux moteurs.

Dans Gecko (`dom/events/WheelEvent.h` / `.cpp`) :

```cpp
static constexpr int32_t kNativeTicksToWheelDelta   = 120;
static constexpr double  kTrustedDeltaToWheelDelta  = 3.0;

int32_t WheelEvent::WheelDeltaY(CallerType aCallerType) {
  WidgetWheelEvent* ev = mEvent->AsWheelEvent();
  if (ev->mWheelTicksY != 0.0) {                       // <- peripherique A CRANS
    return int32_t(-ev->mWheelTicksY * kNativeTicksToWheelDelta);      // = -120
  }
  if (IsTrusted()) {                                   // <- peripherique CONTINU
    return int32_t(-std::round(pixelDelta * kTrustedDeltaToWheelDelta)); // = -3 * deltaY
  }
  return int32_t(-std::round(DeltaY(aCallerType)));    // "This matches Safari."
}
```

La branche `mWheelTicksY != 0` **est** le discriminant « souris à crans » du moteur. Chromium a la
même structure : `wheelDelta` dérive des *ticks* (`kTickMultiplier = 120`) tandis que `deltaY`
dérive des *pixels*, et `GetMouseWheelTick120ths()` retourne `(0,0)` dès que le périphérique est
continu (« *Since the device does continuous scrolling, it has no concept of ticks* »).

Conséquence : pour une souris Windows, `wheelDeltaY = −120` et `deltaY = 100`, soit un rapport de
1,2. Pour un trackpad, le rapport vaut exactement 3.

```js
/** Signature "peripherique continu" : rapport wheelDelta/delta de -3. */
function looksContinuous(e) {
  const wd = e.wheelDeltaY;
  if (typeof wd !== 'number' || wd === 0) return false;
  // Tolerance : le zoom navigateur divise par devicePixelRatio et casse
  // l'egalite exacte.
  return Math.abs(wd + e.deltaY * (visualViewport?.scale || 1)) < 1.001
      || wd === -Math.floor(3 * e.deltaY)
      || wd === -Math.ceil(3 * e.deltaY);
}
```

Limites, à connaître : `wheelDelta*` est **déprécié** et absent des spécifications ; Safari renvoie
`−round(deltaY)`, donc un rapport de 1 (ni 3 ni 1,2) et l'heuristique ne s'y applique pas.

#### 3.5.2 Le score complet

Les indices utilisés en production, dans l'ordre de fiabilité :

```js
/**
 * Profil de peripherique de defilement. Trois etats : 'unknown', 'mouse',
 * 'trackpad'. On ne redescend jamais de 'trackpad' a 'mouse' sans preuve
 * franche (un deltaY multiple de 100/120), pour eviter le clignotement de
 * sensibilite quand l'utilisateur alterne.
 */
/** Signature d'un cran mecanique : multiple exact de 4,000244140625 (macOS) ou
 *  wheelDelta multiple de 120 (Windows). */
const MAGIC_MAC_TICK = 4.000244140625;
function looksNotched(e, px) {
  if (Math.abs(e.deltaX) > 0.5 || px === 0) return false;
  if (Number.isInteger(Math.abs(e.deltaY / MAGIC_MAC_TICK))) return true;
  const wd = e.wheelDelta;
  return typeof wd === 'number' && wd !== 0 && wd % 120 === 0;
}

observeWheel(e, px) {
  const now = performance.now();
  const dt = now - this._lastWheelAt;
  this._lastWheelAt = now;

  // (a) deltaMode LINE ou PAGE : souris a crans. Aucun trackpad n'en emet.
  if (e.deltaMode !== 0) { this._profile = 'mouse'; return; }

  // (b) ctrlKey sans Ctrl physique : pincement, donc trackpad. Certitude.
  if (e.ctrlKey && !this._ctrlDown) { this._profile = 'trackpad'; return; }

  // (c) signature de cran mecanique. Tres forte.
  if (looksNotched(e, px)) { this._score -= 4; }

  // (d) rapport wheelDelta / delta = -3 : peripherique continu (3.5.1).
  else if (looksContinuous(e)) { this._score += 4; }

  // (e) delta fractionnaire : aucune souris a crans n'en produit.
  if (e.deltaY !== 0 && !Number.isInteger(e.deltaY)) this._score += 2;

  // (f) deltaX non nul : defilement horizontal a deux doigts.
  if (Math.abs(e.deltaX) > 0.5) this._score += 2;

  // (g) evenements tres rapproches ET petits : rafale de trackpad.
  if (dt > 0 && dt < 40 && Math.abs(px) < 40) this._score += 1;

  this._score = clamp(this._score, -8, 12);
  if (this._score >= 6) this._profile = 'trackpad';
  else if (this._score <= -4) this._profile = 'mouse';
}
```

Deux principes de conception qui valent plus que les indices eux-mêmes :

1. **Classer une *session*, pas un événement.** Les implémentations sérieuses (deck.gl) ouvrent
   une session au premier `wheel`, accumulent les échantillons pendant ~32 ms, tranchent, et
   ferment la session après 80 ms de silence. Un événement isolé ne prouve rien ; trois
   consécutifs, oui. Le score ci-dessus fait la même chose en moins de lignes, avec de
   l'hystérésis au lieu d'une fenêtre.
2. **Le défaut prudent est `'mouse'`.** En cas d'ambiguïté persistante, on reste sur le profil
   souris : c'est le moins pénalisant (un zoom un peu lent vaut mieux qu'un zoom incontrôlable).
3. **Ne jamais faire dépendre une action irréversible de cette détection.** Elle ne règle qu'une
   sensibilité, et un réglage manuel reste exposé dans les options — parce qu'aucune heuristique
   ne survit aux pilotes tiers (Logitech Options, SteerMouse, Synaptics), aux souris à molette
   libre en mode « hyper-scroll » (une MX Master ressemble alors à un trackpad), ni au zoom
   navigateur.

Le doc de design propose une autre heuristique — « si aucun `wheel` avec
`deltaMode === DOM_DELTA_LINE` n'est vu en 30 s, on bascule sur le profil trackpad ». Elle est
**fausse**, pour la raison établie au §3.1 : Chromium n'émet *jamais* `DOM_DELTA_LINE`, même avec
une souris. Elle ferait basculer tout Chrome et tout Edge en profil trackpad. On la remplace par le
score ci-dessus, et on garde son excellente idée d'ergonomie : **afficher discrètement l'aide
gestuelle** au moment de la bascule.

#### 3.5 bis Le chemin Safari : `gesturestart` / `gesturechange` / `gestureend`

Interface propriétaire WebKit, jamais standardisée, jamais implémentée ailleurs — et **la seule
façon d'obtenir le pincement sur Safari macOS**. `scale` est un **multiplicateur absolu depuis le
début du geste** (1,0 au départ), pas un incrément : l'erreur classique est de le cumuler.

```js
if ('GestureEvent' in window) {
  this.dom.addEventListener('gesturestart', (e) => {
    e.preventDefault();
    this._gestureScale = 1;
    this._latchAnchor(e.clientX, e.clientY, performance.now());
  });
  this.dom.addEventListener('gesturechange', (e) => {
    e.preventDefault();
    const k = e.scale / this._gestureScale;
    this._gestureScale = e.scale;
    // scale > 1 = ecartement des doigts = zoom avant = notches negatifs
    this.zoomAt(e.clientX, e.clientY, -Math.log(k) / ZOOM_PER_NOTCH);
  });
  this.dom.addEventListener('gestureend', (e) => e.preventDefault());
}
```

> **Ne jamais écouter les deux chemins sur iOS.** Sur Safari iOS/iPadOS, un pincement déclenche
> *à la fois* les `GestureEvent` et les `touch*`/`pointer*`, et les deux mises à jour se
> contredisent — le zoom devient doublé et saccadé. La condition de branchement correcte, celle de
> tldraw, est donc :
>
> ```js
> const useGestureEvents = !IS_IOS && 'GestureEvent' in window;
> ```
>
> Sur iOS, on passe par les pointeurs (§6.4). Sur Safari macOS, par les `GestureEvent`.

### 3.6 `passive: false` et `preventDefault`

Le listener est déjà posé avec `{ passive: false }`, et ce n'est pas une précaution de style :
depuis l'« intervention » de Chrome, **un listener `wheel` posé sur un nœud de premier niveau
(`window`, `document`, `document.body`) sans option explicite est forcé en `passive: true`** —
votre `preventDefault()` est alors silencieusement ignoré, avec un simple avertissement en
console. C'est écrit noir sur blanc dans `event_target.cc` de Blink :

```cpp
if (IsWheelScrollBlockingEvent(event_type) && IsTopLevelNode()) {
  if (!options->hasPassive()) {
    options->setPassive(true);                    // <- forcé
    options->SetPassiveForcedForDocumentTarget(true);
    return;
  }
}
```

Sur n'importe quel **autre** élément — un `<canvas>`, par exemple — le défaut reste
`passive: false`. Quatre règles :

1. **Toujours** écrire l'option explicitement, et attacher au canevas, jamais au document.
2. **Toujours** `preventDefault()` quand on consomme l'événement — sinon `Ctrl+molette` déclenche
   le zoom du *navigateur* et l'interface part en morceaux.
3. Le pincement de trackpad **doit** être `preventDefault()` pour la même raison, ainsi que
   `gesturestart` et `gesturechange` sur Safari.
4. **Annuler dès le premier événement de la rafale.** MDN avertit : « *In some browsers, only the
   first `wheel` event in a sequence is cancelable; subsequent events are non-cancelable.* » Il ne
   faut donc pas conditionner le traitement à `event.cancelable` en milieu de queue d'inertie.

Et une règle d'accessibilité, celle qu'on oublie : `Ctrl+molette` est **le raccourci système de
zoom du navigateur**, utilisé par les personnes malvoyantes. Le détourner est légitime sur un
canevas plein écran comme le nôtre, mais il faut alors impérativement fournir l'alternative :
`+` / `-` au clavier, et les boutons de la barre d'outils du HUD (§6.5).

Note de plomberie (D12) : les deux consommateurs de `wheel` (`DioramaControls` et `ToolManager`)
sont aujourd'hui deux listeners posés sur le même élément, et le `stopPropagation()` de
`ToolManager` ne bloque pas l'autre. La refonte introduit **un routeur unique** :

```js
// Un seul listener wheel dans tout le jeu. Il decide, puis delegue.
onWheel(e) {
  e.preventDefault();
  this.observeWheel(e);

  const pinch = this.isPinch(e);
  const zoomIntent = pinch || (e.ctrlKey || e.metaKey) || this.invertWheel;

  if (zoomIntent) {
    const n = wheelNotches(e, pinch ? 'pinch' : this._profile);
    this.controls.zoomAt(e.clientX, e.clientY, n);
  } else {
    // La molette nue appartient a l'outil.
    this.tools.onWheelValue(e, wheelNotches(e, this._profile));
  }
}
```

### 3.7 Molette nue = rayon de brosse, ou zoom ? — Analyse et décision

Le choix actuel (molette nue → rayon, `Ctrl+molette` → zoom) est **inhabituel dans les jeux** et
**standard dans les logiciels de sculpture**. Les deux camps :

| Logiciel | Molette nue (défaut) | Rayon de brosse (défaut) |
|---|---|---|
| **Blender** (mode sculpture) | **zoom** (`Ctrl+MMB` en glissement aussi) | **`F` + glissement** interactif ; `[` `]` par pas ; force sur `Maj+F` |
| **ZBrush** | **zoom** | **`S` + glissement** (Draw Size). *La molette est assignable à n'importe quel curseur, dont Draw Size, mais ce n'est pas le défaut.* |
| **Substance 3D Painter** | **zoom caméra** | **`Ctrl` + glissement clic droit** ; `[` `]` par pas |
| **Mudbox** | **zoom (dolly)** | **`B` + glissement** (taille), `M` + glissement (force) |
| **3D-Coat** | **zoom** | `[` `]` — *et la molette, uniquement si on l'active dans les préférences* |
| Photoshop / Krita | défilement ou zoom selon réglage | `[` `]` ; `Alt` + clic droit en glissement |
| **Nomad Sculpt** (tablette) | pincement = zoom | **curseur « Tool Radius » permanent à l'écran** + pression du stylet |

Le constat est net et double :

- **Aucun logiciel de sculpture professionnel ne met le rayon sur la molette nue par défaut.**
  Tous y mettent le zoom.
- Les deux qui *permettent* la molette pour le rayon — ZBrush et 3D-Coat — en font une **option
  désactivée par défaut**. C'est exactement le modèle à copier.

Et tous donnent au rayon un *geste dédié* : presque toujours une **touche maintenue + glissement
horizontal** (`F` sous Blender, `S` sous ZBrush, `B` sous Mudbox, `Ctrl`+clic droit sous Painter).
L'avantage est énorme et il est ergonomique, pas historique : le rayon est une grandeur
**continue** qu'on veut voir en aperçu sous le curseur, et un glissement en donne une résolution
sans commune mesure avec des crans de 120.

Contre-argument, celui du doc de design : « dans un jeu de sculpture, on change de rayon 10 à
20 fois plus souvent qu'on ne zoome ». C'est vrai — mais c'est vrai *parce que* le rayon est
difficile à changer autrement. Dans Blender, on change de rayon aussi souvent, et personne ne
réclame la molette : `F` + glissement est plus rapide.

Deuxième contre-argument : le public. *Sandcastle* n'est pas ZBrush ; le joueur arrive de
Minecraft, de Townscaper, de Cities:Skylines — **où la molette zoome, toujours**. Un joueur qui
scrolle et voit son pinceau grossir au lieu de la caméra s'approcher a une réaction unanime :
« le zoom est cassé ».

**Décision retenue — inverser le défaut, et donner au rayon un meilleur geste :**

| Entrée | Action | Note |
|---|---|---|
| **Molette nue** | **Zoom ancré sur le curseur** | Le défaut universel. C'est ce que le joueur essaie en premier. |
| **`Ctrl` + molette** | Rayon de brosse | Reste accessible sans lâcher la souris |
| **`R` maintenu + glissement horizontal** | **Rayon de brosse, en continu** | Le geste des logiciels de sculpture. Aperçu du cercle en direct, 10× plus rapide que la molette. |
| `[` / `]` | Rayon par pas de 15 % | Déjà implémenté (`ToolManager.onKeyDown`) |
| `Alt` + molette | Paramètre secondaire de l'outil | Inchangé |
| `Maj` + molette | Variante d'outil | Inchangé |

**et une option, activée d'un clic, qui restaure le comportement actuel** — parce que le doc de
design a raison sur un point : un joueur qui a pris le pli du rayon-sur-molette ne veut pas qu'on
le lui enlève.

```js
/**
 * 'zoom'   : molette = zoom, Ctrl+molette = rayon   (defaut)
 * 'radius' : molette = rayon, Ctrl+molette = zoom   (comportement historique)
 */
this.wheelMode = loadPref('sc.wheelMode', 'zoom');
```

**L'argument technique qui achève le débat.** Sur un trackpad, la molette nue n'est pas un
périphérique à crans : c'est un flux continu de 60 à 120 événements par seconde, avec un `deltaX`
non nul et une queue d'inertie de une à deux secondes. C'est parfait pour un zoom continu ; c'est
**catastrophique pour un rayon de brosse**, qui sauterait de façon incontrôlable et continuerait à
grossir tout seul pendant l'inertie. Un binding « molette = rayon » correct sur une souris à crans
devient inutilisable sur trackpad — à moins de passer par un **accumulateur de crans**, qui est de
toute façon obligatoire si l'option est proposée :

```js
/**
 * Reglage par pas discrets, robuste a tout peripherique.
 * On accumule les pixels et on ne declenche un pas qu'a chaque NOTCH_PX
 * franchi : une rafale de trackpad produit alors le meme nombre de pas qu'une
 * molette a crans pour un meme deplacement du doigt.
 */
_radiusAcc = 0;
onWheelRadius(e) {
  this._radiusAcc += wheelPixels(e);
  while (Math.abs(this._radiusAcc) >= NOTCH_PX) {
    const dir = Math.sign(this._radiusAcc);
    this.tools.setRadius(this.tools.radius * (dir < 0 ? 1 / 0.88 : 0.88));
    this._radiusAcc -= dir * NOTCH_PX;
  }
}
```

Enfin, le filet de sécurité que le doc de design décrit déjà et qu'il faut vraiment
implémenter : **si le joueur scrolle beaucoup sans obtenir l'effet qu'il cherche**, on l'aide. Une
détection très simple et très efficace :

```js
// Si le joueur fait plus de 8 crans de rayon en moins de 2 s alors que le
// rayon est deja a sa borne, il cherchait probablement a zoomer.
if (this._radiusSaturatedNotches > 8 && now - this._radiusBurstStart < 2000) {
  this.game.toast('Astuce : la molette zoome. Ctrl+molette regle le rayon.');
  this._radiusSaturatedNotches = 0;
}
```

### 3.8 Tableau récapitulatif du schéma molette

| Contexte | Chrome/Edge Windows | Firefox Windows | macOS souris | Trackpad | Résultat |
|---|---|---|---|---|---|
| molette nue | `deltaY = ±100`, mode 0 | `deltaY = ±3`, mode 1 | `deltaY = ±4..12` | fractionnaire ~60 Hz | **1 cran de zoom** dans tous les cas |
| `Ctrl` + molette | `ctrlKey`, `_ctrlDown` vrai | idem | idem | idem | **rayon de brosse** |
| pincement | — | — | — | `ctrlKey`, `_ctrlDown` **faux** | **zoom continu**, sensibilité `PINCH_PX_PER_NOTCH` |
| `gesturechange` (Safari) | — | — | — | `scale` absolu | **zoom continu**, chemin dédié |

---

## 4. Sensation : amortissement, échelle, inertie

### 4.1 Ressort critique plutôt qu'interpolation exponentielle

#### 4.1.1 Le lerp par frame et sa correction

L'erreur canonique :

```js
x += (goal - x) * 0.16;      // FAUX : dependant du framerate
```

Après `n` frames, `x_n = g + (x₀ − g)·(1 − k)ⁿ`. Le résultat dépend du **nombre d'appels**, pas du
temps écoulé : à 120 Hz la caméra converge deux fois plus vite qu'à 60 Hz. Le jeu ne se sent pas
pareil sur deux machines.

La « correction » naïve `lerp(x, g, damping * dt)` est **pire** : dès que `damping·dt > 1` on
extrapole au-delà de la cible, et à `damping·dt > 2` le système diverge géométriquement.

Deux corrections correctes, mathématiquement équivalentes :

| Forme | Expression | Paramètre |
|---|---|---|
| **A — canonique** | `k(dt) = 1 − exp(−λ·dt)` | `λ` en s⁻¹, physique |
| **B — portage 60 Hz** | `k(dt) = 1 − (1 − k₆₀)^(60·dt)` | `k₆₀`, sans dimension, lié à un framerate de référence arbitraire |

Elles sont identiques pour `λ = −60·ln(1 − k₆₀)`. La forme B n'est pas un autre modèle : c'est A
reparamétré par un framerate de référence. On ne l'utilise que pour ne pas re-régler des
constantes déjà validées par un designer. **`DioramaControls` utilise déjà la forme B** —
`1 - Math.pow(1 - this.damping, dt * 60)` — ce qui est déjà mieux que la majorité des bases de
code ; c'est le paramétrage qui est illisible (D11).

La troisième écriture, celle qu'on veut exposer, est la **demi-vie** :

```
k(dt) = 1 − 2^(−dt / H)          ⟺          λ = ln2 / H ≈ 0,6931 / H
```

```js
const LN2 = Math.LN2;
/** Rapproche x de g : la moitie du chemin restant est parcourue en `halflife` secondes. */
const dampTo = (x, g, halflife, dt) => g + (x - g) * Math.exp(-LN2 * dt / halflife);
```

Pourquoi la demi-vie gagne comme paramètre :

- **elle est en millisecondes.** « La caméra rattrape la moitié de son retard en 70 ms » est une
  phrase qu'un designer valide ou refuse en une seconde. `0,16` ne veut rien dire.
- **elle est linéaire à la perception** : doubler `H` double le « poids » ressenti.
- **elle donne les seuils directement** : il reste 1 % d'erreur au bout de `H·log₂(100) ≈ 6,64·H`,
  et 0,1 % à `9,97·H`. C'est ce chiffre qui sert de critère au test T6.

Conversion depuis la valeur actuelle : `H = −1 / (60·log₂(1 − 0,16)) = 66 ms`.

| `H` | `λ` | `k₆₀` | ressenti |
|---|---|---|---|
| 30 ms | 23,1 | 0,44 | sec, réactif, un peu « numérique » |
| **70 ms** | 9,9 | 0,152 | **défaut retenu pour l'orbite et le pan** |
| 110 ms | 6,3 | 0,10 | doux, cozy — défaut retenu pour le zoom |
| 200 ms | 3,5 | 0,057 | mou ; réservé aux transitions de cadrage |
| 0 | ∞ | 1 | snap instantané (mode « mouvement réduit ») |

#### 4.1.2 Le ressort critiquement amorti

L'oscillateur amorti `ẍ + 2ζω·ẋ + ω²(x − g) = 0` a trois régimes ; le cas **critique** `ζ = 1`
est celui qui converge le plus vite **sans dépassement**. Sa solution est analytique, donc
intégrable **exactement en une passe**, pour n'importe quel `dt` :

```
x(t) = g + (j₀ + j₁·t)·e^(−y·t)
v(t) = e^(−y·t)·(v₀ − j₁·y·t)

avec   j₀ = x₀ − g          j₁ = v₀ + y·j₀          y = 2·ln2 / H
```

Implémentation JS, à coller telle quelle :

```js
/**
 * Ressort critiquement amorti, integration exacte (Holden / Game Programming
 * Gems 4 ch. 1.10 — le meme algorithme que Mathf.SmoothDamp d'Unity).
 *
 * `s` porte l'etat de vitesse : c'est ce qui rend le mouvement C1, donc sans
 * a-coup quand la cible saute.
 *
 * @param {{x:number, v:number}} s   etat {position, vitesse}
 * @param {number} goal              cible
 * @param {number} halflife          secondes ; 0 = snap
 * @param {number} dt                secondes
 */
export function spring(s, goal, halflife, dt) {
  if (halflife <= 1e-5 || dt <= 0) { s.x = goal; s.v = 0; return s.x; }
  // y = 2*ln2/H, et NON ln2/H : voir l'encadre ci-dessous.
  const y = (2 * Math.LN2) / halflife;    // = damping / 2
  const j0 = s.x - goal;
  const j1 = s.v + j0 * y;
  const e = fastNegExp(y * dt);
  s.x = e * (j0 + j1 * dt) + goal;
  s.v = e * (s.v - j1 * y * dt);
  return s.x;
}

/**
 * Approximation de Pade de e^-x. Monotone, bornee dans ]0,1], jamais negative :
 * inconditionnellement stable, meme pour un dt aberrant. (Et environ 4x plus
 * rapide que Math.exp, ce qui n'est pas la raison de l'utiliser.)
 */
function fastNegExp(x) {
  return 1 / (1 + x + 0.48 * x * x + 0.235 * x * x * x);
}

/** Decroissance d'une vitesse vers zero, meme integration exacte. Sert a l'inertie. */
export function springDecay(s, halflife, dt) {
  const y = (2 * Math.LN2) / halflife;
  const j1 = s.v + s.x * y;
  const e = fastNegExp(y * dt);
  s.x = e * (s.x + j1 * dt);
  s.v = e * (s.v - j1 * y * dt);
  return s.x;
}
```

Pont avec Unity, utile si on compare des réglages : `smoothTime = H / ln2 ≈ 1,4427·H`, donc
`ω = 2/smoothTime = 2·ln2/H`. `Mathf.SmoothDamp` et `spring()` ci-dessus sont **le même
algorithme**, à la reparamétrisation près.

> ### Le facteur 2 dans `y`, et pourquoi il n'est pas optionnel
>
> Écrire `y = ln2 / H` paraît naturel : c'est la formule d'un amortisseur du premier ordre. Pour
> un **ressort**, c'est faux, et la conséquence est très visible.
>
> L'enveloppe d'erreur d'un ressort critique n'est pas `e^(−yt)` mais `(1 + y·t)·e^(−y·t)`. Le
> terme `(1 + y·t)` freine la convergence : avec `y = ln2/H`, l'erreur n'est encore divisée par
> deux qu'à `t ≈ 2,4·H`, et il faut `t = 6,64/y = 9,6·H` pour arriver à 1 %. À `H = 70 ms`, cela
> fait **683 ms pour se stabiliser** — mesuré, pas estimé. La caméra est molle, et le nombre
> affiché dans les options ment d'un facteur 2,4.
>
> Le facteur 2 compense exactement ce terme. C'est la convention de Holden
> (`damping = 4·ln2/H`, `y = damping/2 = 2·ln2/H`), et elle est calibrée pour que la demi-vie d'un
> ressort **se ressente** comme celle d'un amortisseur du premier ordre. Mesures sur
> l'implémentation du §8, `H = 70 ms`, écart initial de 1 rad :
>
> | | `y = ln2/H` | **`y = 2·ln2/H`** |
> |---|---|---|
> | 50 % du chemin | 240 ms | **100 ms** |
> | 95 % | 480 ms | **250 ms** |
> | 99 % | 683 ms | **350 ms** |
> | Dépassement | 0,000 % | **0,000 %** |
>
> Le dépassement reste nul dans les deux cas — on est bien critiquement amorti de part et d'autre.
> Ce n'est donc pas un bug de stabilité, c'est un bug d'**étalonnage** : le paramètre exposé au
> designer ne veut pas dire ce qu'il annonce. Et un facteur 2,4 sur la réactivité d'une caméra,
> ça ne se rattrape pas au réglage — on croit que le jeu « traîne ».

#### 4.1.3 Pourquoi le ressort plutôt que l'exponentielle, pour cette caméra

Le damper exponentiel est un système du 1er ordre (`ẋ = λ(g−x)`) ; le ressort est du 2e ordre —
**la vitesse est un état**. Quatre conséquences concrètes ici :

1. **Continuité C¹.** Quand le but saute — c'est *exactement* ce que fait `zoomAt()` à chaque cran
   de molette, et ce que fait `focus()` sur `F` — le damper impose instantanément une vitesse
   `λ·(g−x)` : la caméra part d'un coup à sa vitesse maximale. C'est un claquement. Le ressort
   accélère depuis sa vitesse actuelle.
2. **Profil de vitesse en cloche.** Le damper a sa vitesse maximale à `t = 0` puis une longue
   traîne molle. Le ressort critique depuis le repos a `v(t) ∝ t·e^(−yt)`, maximum à `t = 1/y` :
   c'est un ease-in/ease-out naturel, gratuit. Le mouvement se lit comme *intentionnel* et non
   comme *du retard*.
3. **Erreur nulle sur une cible qui glisse.** Pour une cible avançant à vitesse constante `q` — un
   drag d'orbite continu, exactement notre cas —, le damper 1er ordre laisse une erreur permanente
   `e∞ = q/λ = q·H/ln2` : la caméra traîne **indéfiniment** derrière le doigt. À `H = 70 ms` et un
   drag rapide de 900 px/s, ça fait 91 px de retard constant. Le ressort, lui, se cale dessus.
4. **L'inertie est gratuite.** `v` étant un état exposé, on y injecte la vitesse de relâchement
   (§4.4) et le même solveur gère la décélération *et* le rappel. Pas de second système, pas de
   transition à écrire.

**Où appliquer le ressort :** sur les paramètres orbitaux — `azimuth`, `polar`, `ln(distance)`,
`target.x/y/z` — **jamais sur la position monde de la caméra**. Sinon une orbite de 180° fait
passer la caméra en ligne droite *à travers* le pivot.

Réglages retenus :

```js
const H_ORBIT  = 0.070;   // azimut, polaire
const H_PAN    = 0.070;   // cible
const H_ZOOM   = 0.110;   // ln(distance) — un peu plus mou : le zoom est un geste "lourd"
const H_FRAME  = 0.150;   // recadrages automatiques (F, R, T)
```

#### 4.1.4 Deux garde-fous indispensables

```js
dt = Math.min(dt, 1 / 20);   // un GC de 800 ms ne doit pas teleporter la camera
```

`Game.update` clampe déjà à 0,1 s ; on resserre à 0,05 s dans les contrôles, parce qu'une caméra
qui saute est bien plus désagréable qu'un sable qui coule un peu moins.

Et l'azimut : **ne jamais le replier dans `[−π, π]`.** On laisse `azimuth` et `goalAzimuth`
dériver librement ; la différence reste petite, donc le ressort interpole toujours par le plus
court chemin. Le repliement ne se fait qu'à l'écriture d'une valeur absolue externe :

```js
/** Ramene `goal` dans le meme tour que `cur`, pour interpoler par l'arc le plus court. */
function unwrap(cur, goal) {
  return cur + ((((goal - cur) % TAU) + TAU + Math.PI) % TAU) - Math.PI;
}
```

### 4.2 Vitesse d'orbite et de panoramique proportionnelles à la distance

Trois lois, et elles ne sont **pas** les mêmes selon le canal :

| Canal | Loi | Pourquoi |
|---|---|---|
| **Panoramique** | Δmonde = `2 · Δpx · d · tan(fov/2) / hauteur_px` | Un pixel doit valoir un pixel : le point du plan du pivot sous le curseur reste sous le curseur. **Linéaire en `d`.** |
| **Orbite** | Δangle = `2π · Δpx / hauteur_px` | Un angle est sans échelle. **Indépendant de `d`** — sinon zoomer changerait la sensibilité de rotation, ce qui est désorientant. |
| **Zoom** | `d ← d · exp(±s)` | Multiplicatif : le nombre de crans pour diviser la distance par deux est le même à 1,4 m qu'à 34 m (Weber-Fechner). |
| **Clavier** | `v = C · d` m/s | Traverser l'écran doit prendre le même temps à toute distance. |

Le panoramique du code actuel a donc le bon facteur d'échelle — c'est le signe vertical et la
compensation d'inclinaison qui manquent (D3), et le §4.3 montre qu'il vaut mieux abandonner
l'approximation écran tout entière. L'orbite, elle, ne doit **pas** être touchée : sa loi est déjà
la bonne. C'est le clavier qui est faux (D5) :

```js
// Vitesse clavier : proportionnelle a la distance.
// A 0,9 · d m/s, traverser la hauteur visible (2·d·tan16° = 0,573·d) prend
// 0,64 s a toute distance. Meme geste a 1,4 m qu'a 34 m.
const KEY_PAN_RATE = 0.9;
const sp = KEY_PAN_RATE * this.distance * dt * (shift ? 2.5 : 1);
```

**Nuance sur l'orbite en gros plan.** À 1,4 m, une orbite de 5° déplace la caméra de 12 cm : c'est
énorme par rapport à un créneau de 8 cm. Un utilisateur qui affine un détail veut une orbite plus
fine. Plutôt que de lier la sensibilité à la distance (ce qui déroute), on ajoute un
**modificateur de précision** — `Shift` pendant un drag d'orbite divise la sensibilité par 4 —
et on l'annonce dans l'aide. C'est la convention de tous les logiciels de CAO et de sculpture.

```js
const fine = e.shiftKey ? 0.25 : 1;
this.goalAzimuth -= dx * ORBIT_RATE * fine;
this.goalPolar   -= dy * ORBIT_RATE * fine;
```

avec `ORBIT_RATE = 2π / hauteur_px` : traverser verticalement l'écran = un tour complet. À
800 px de haut, `ORBIT_RATE = 0,00785 rad/px`, contre `0,0055` (azimut) et `0,0045` (polaire)
actuellement — donc l'orbite actuelle est **30 % trop molle horizontalement et 43 % trop molle
verticalement**, et surtout **anisotrope** sans raison.

### 4.3 Le panoramique corrigé : « glisser le sol »

Il y a deux façons de faire un panoramique, et la différence entre les deux est mesurable.

#### 4.3.1 L'approximation écran (celle qu'on trouve partout)

On convertit le déplacement en pixels en un déplacement monde le long des axes caméra :

```
Δmonde = 2 · Δpx · d · tan(fov/2) / hauteur_px
```

C'est ce que fait le code actuel, ce que fait `OrbitControls` de three.js, et c'est **faux au-delà
du premier ordre**. Corrigée du signe et du facteur `1/cosθ` (§1.3), elle laisse encore une erreur
de 12 px à 61° d'élévation et de 88 px à 10° sur un glissement de 230 px. C'est visible : le sol
« patine » sous le curseur pendant les longs mouvements.

#### 4.3.2 La méthode exacte : intersecter, ne pas approximer

Le panoramique d'un diorama a une définition littérale : **le point du sol que j'ai attrapé doit
rester sous mon doigt**. On peut donc le résoudre exactement, sans aucune approximation :

1. au pixel de départ, on intersecte le rayon avec le plan horizontal `y = target.y` → `A` ;
2. au pixel d'arrivée, on intersecte le même rayon (depuis la même caméra) → `B` ;
3. on translate la cible de `−(B − A)`.

Après quoi, le point `A` se projette exactement sur le pixel d'arrivée. Ce n'est pas une
propriété approchée : c'est la définition même de l'opération.

```js
/**
 * Panoramique "glisser le sol".
 *
 * Methode exacte : on intersecte le rayon du curseur avec le plan horizontal
 * y = target.y au depart ET a l'arrivee, et on translate la cible de l'oppose.
 * Le point du sol saisi reste alors RIGOUREUSEMENT sous le curseur.
 *
 * Mesure sur l'implementation du 8, glissement de 180 x 140 px a 9 m,
 * applique en 20 increments comme un vrai geste :
 *     elevation 61 deg -> 0,0000 px
 *     elevation 38 deg -> 0,0000 px
 *     elevation 21 deg -> 0,0000 px
 *     elevation 10 deg -> 0,0000 px
 * contre 12, 26, 47 et 88 px pour l'approximation ecran.
 */
pan(fromX, fromY, toX, toY) {
  const Y = this.goalTarget.y;
  const a = this._rayToPlane(fromX, fromY, Y, this._pa);
  const b = a && this._rayToPlane(toX, toY, Y, this._pb);
  if (a && b) {
    const dx = b.x - a.x, dz = b.z - a.z;
    // Un rayon rasant coupe le plan tres loin : un pixel de glissement
    // deviendrait dix metres. Au-dela de 3 fois la distance, on refuse et on
    // retombe sur l'approximation ecran, qui est bornee par construction.
    if (Math.hypot(dx, dz) < this.goalDistance * 3) {
      this.goalTarget.x -= dx;
      this.goalTarget.z -= dz;
      this.clampTarget();
      return;
    }
  }
  this._panScreen(toX - fromX, toY - fromY);
}

/** Intersection du rayon d'un pixel avec le plan horizontal y = Y. */
_rayToPlane(clientX, clientY, Y, out) {
  const R = this._ray(clientX, clientY);
  if (Math.abs(R.dy) < 1e-5) return null;
  const t = (Y - R.oy) / R.dy;
  if (!(t > 0.02) || t > 600) return null;
  out.x = R.ox + R.dx * t;
  out.z = R.oz + R.dz * t;
  return out;
}
```

Trois conséquences agréables :

- **Le facteur `1/cosθ` disparaît**, et avec lui le plafond `PAN_LIFT_MAX` : la géométrie s'en
  charge toute seule. Le comportement à 10° d'élévation devient correct au lieu d'être plafonné.
- **La question du signe ne se pose plus.** Il n'y a plus de convention à choisir : on soustrait un
  déplacement monde, le sens est imposé.
- **Le geste est auto-correcteur.** Comme on recalcule les deux intersections à chaque
  `pointermove` depuis la caméra *courante*, une erreur accumulée (par l'amortissement, par un
  écrêtage) se rattrape au mouvement suivant au lieu de se cumuler.

Il faut en revanche passer les **deux extrémités** et non un delta, d'où le changement de
signature. Les deux appelants les ont naturellement sous la main :

```js
// souris : this._last porte la position precedente
this.pan(e.clientX - dx, e.clientY - dy, e.clientX, e.clientY);
// tactile : p = geste precedent, g = geste courant
this.pan(p.cx, p.cy, g.cx, g.cy);
```

#### 4.3.3 Le repli, et pourquoi il faut le garder

Le rayon peut ne pas couper le plan : caméra sous le plan, visée exactement horizontale, ou visée
si rasante que l'intersection tombe à 300 m. On garde donc l'approximation écran comme filet, avec
le signe corrigé et le plafond `PAN_LIFT_MAX = 4` (élévation 14,5°) :

```js
/**
 * Repli : approximation ecran, exacte au premier ordre seulement.
 *
 * Noter le signe : +dy et non -dy. Un glissement vers le haut doit faire
 * monter le sol, comme un glissement vers la droite le fait aller a droite.
 */
_panScreen(dx, dy) {
  const h = this.dom.clientHeight || 1;
  const scale = (2 * this.goalDistance * Math.tan((this.camera.fov * Math.PI) / 360)) / h;
  const A = this.goalAzimuth;
  const rx = Math.cos(A), rz = -Math.sin(A);
  const fx = -Math.sin(A), fz = -Math.cos(A);
  const lift = Math.min(1 / Math.max(Math.cos(this.goalPolar), 1e-3), PAN_LIFT_MAX);

  this.goalTarget.x += -dx * scale * rx + dy * scale * lift * fx;
  this.goalTarget.z += -dx * scale * rz + dy * scale * lift * fz;
  this.clampTarget();
}
```

#### 4.3.4 Ce que `clampTarget()` fait à l'exactitude

À 10° d'élévation et 9 m de distance, un glissement de 230 px demande **13 m** de déplacement au
sol — plus que la largeur du domaine. `clampTarget()` bride alors la cible et l'erreur mesurée
remonte à 83 px. **C'est le comportement voulu** : mieux vaut perdre l'accroche que laisser le
joueur partir en mer. Le test T8 en tient compte explicitement (§7.3).

#### 4.3.5 Variante « panoramique écran »

Une option fait glisser la cible dans le plan de l'écran plutôt que dans celui du sol, en
autorisant `target.y` à bouger — c'est le `screenSpacePanning = true` de three.js. Utile pour
longer le mur vertical d'un château. On le propose en option, pas par défaut : sur un diorama,
garder la cible au sol est précisément ce qui empêche de se perdre.

### 4.4 Inertie : combien, et quand la couper

#### 4.4.1 Estimer la vitesse de relâchement

**Ne jamais utiliser le dernier `Δpx / dt`.** Il est bruité, et il produit le bug classique :
l'utilisateur drague, s'arrête 300 ms bouton enfoncé, relâche — un jitter de 2 px divisé par un
`dt` de 4 ms envoie la caméra en orbite. On lisse sur une fenêtre glissante :

```js
/** Vitesse pointeur lissee sur ~70 ms. Retombe naturellement a zero a l'arret. */
_trackVelocity(dx, dy, dt) {
  if (dt <= 0) return;
  const a = 1 - Math.exp(-dt / 0.07);
  this._vx += (dx / dt - this._vx) * a;
  this._vy += (dy / dt - this._vy) * a;
}
```

#### 4.4.2 Combien

Modèle : traînée proportionnelle à la vitesse, `a = −λ·v`, intégrée exactement (c'est
`springDecay` ci-dessus). Les références de l'industrie donnent la fourchette :

| Système | `λ` | demi-vie |
|---|---|---|
| Android `FlingAnimation` (`DEFAULT_FRICTION = −4.2`) | 4,2 s⁻¹ | 165 ms |
| iOS `UIScrollView` deceleration `fast` (0,99/ms) | ≈ 10 s⁻¹ | 69 ms |
| iOS `UIScrollView` deceleration `normal` (0,998/ms) | ≈ 2 s⁻¹ | 346 ms |

**Retenu pour Sandcastle : `λ = 5 s⁻¹`, soit une demi-vie de 139 ms, et une inertie qui meurt en
~0,6 s.** C'est volontairement court. Ce n'est pas une carte : le domaine fait 10 m, une inertie
longue fait dépasser la cible et oblige à corriger. L'inertie est ici un **adoucissement de fin de
geste**, pas un mode de déplacement.

L'inertie ne s'applique qu'à **l'orbite**. Pas au panoramique (la cible est bornée, une inertie
qui va taper la limite est frustrante), pas au zoom (le zoom est déjà amorti par le ressort en
espace log, ajouter de l'inertie donnerait un dépassement de distance).

```js
_releaseInertia() {
  if (!this.inertiaEnabled || this._dragging !== 'orbit') return;
  const speed = Math.hypot(this._vx, this._vy);
  if (speed < INERTIA_MIN) return;                       // 120 px/s : un clic ne lance rien
  const s = Math.min(speed, INERTIA_MAX) / speed;        // 2500 px/s : clamp anti-aberration
  this._spinA = -this._vx * s * ORBIT_RATE;              // rad/s
  this._spinP = -this._vy * s * ORBIT_RATE;
}

// dans update(dt) :
if (this._spinA || this._spinP) {
  const decay = Math.exp(-INERTIA_LAMBDA * dt);          // 5 s^-1
  this.goalAzimuth += this._spinA * dt;
  this.goalPolar = clamp(this.goalPolar + this._spinP * dt, this.minPolar, this.maxPolar);
  this._spinA *= decay;
  this._spinP *= decay;
  if (Math.abs(this._spinA) + Math.abs(this._spinP) < 0.002) this._spinA = this._spinP = 0;
}
```

#### 4.4.3 Quand la couper — la table de vérité

| Événement | Action | Pourquoi |
|---|---|---|
| `pointerdown` (n'importe lequel) | `spinA = spinP = 0` **avant tout le reste** | Le joueur reprend la main. Laisser glisser sous le doigt est la faute d'UX n° 1. |
| Butée polaire atteinte | annuler **uniquement** `spinP` | Sinon la caméra « colle » à la butée en poussant contre le mur une demi-seconde. |
| `|spin| < 0,002 rad/s` | arrêt franc | Sous le seuil sous-pixel : à 34 m, 0,002 rad/s = 0,07 mm/s à l'écran. Libère la boucle. |
| Vitesse de relâchement < 120 px/s | ne pas lancer d'inertie | Un clic molette bref ne doit pas faire tourner la scène. |
| Vitesse > 2500 px/s | clamper | Un échantillon aberrant ne doit pas envoyer la caméra en orbite. |
| Changement d'outil, `blur`, `visibilitychange` | annuler | Une inertie qui survit à un changement de contexte est perçue comme un bug. |
| `focus()`, `frameAll()`, `reset()`, `T` | annuler, mais **conserver `v` comme vitesse initiale du ressort** | Continuité C¹ : c'est précisément l'avantage du ressort. |
| `prefers-reduced-motion: reduce` | inertie désactivée, `H → 0` | §5.7 |
| Mode photo (`autoRotate`) | l'inertie s'ajoute à la rotation auto puis meurt | Donne le « coup de pouce » agréable en mode photo. |

#### 4.4.4 Le « flywheel » : à ne pas implémenter ici

Android additionne les vitesses quand on relance un fling dans la même direction (`mFlywheel`).
C'est délicieux sur une liste infinie ; c'est nocif sur un diorama de 10 m, où le geste utile est
« tourner de 90° pour voir l'autre face ». On ne le reprend pas.

---

## 5. Confort et garde-fous

### 5.1 Ne jamais traverser le terrain

Pour un **diorama**, la solution générique (spherecast + rétraction du bras) est objectivement
mauvaise, et il faut le dire clairement :

> Rapprocher la caméra (`d ↓`) change la **taille apparente du sujet à l'écran**. Or toute la
> lisibilité d'un diorama repose sur une échelle stable — « un objet posé sur une table ». Un
> château qui grossit brutalement parce qu'on a frôlé le sable est le pire artefact possible.
> **Remonter l'élévation (`polar ↓`) à distance constante** ne change que l'incidence.

C'est exactement ce que `GAME-DESIGN.md` §4.2 décrit déjà pour l'évitement d'occlusion
(« la caméra remonte légèrement en élévation, max +12° »), et c'est ce que Cinemachine appelle
`Preserve Camera Distance`. On généralise la même stratégie à la collision dure.

#### 5.1.1 Le plancher du bloc : une contrainte analytique fermée

Le socle du diorama est un demi-espace `y ≥ 0`. Une contrainte contre un demi-espace admet une
solution **exacte, continue, sans lancer de rayon et sans hystérésis** :

```
y_cam = T.y + d·cos φ  ≥  y_floor
⟺  cos φ ≥ (y_floor − T.y) / d
⟺  φ ≤ acos( clamp((y_floor − T.y)/d, −1, 1) )        (cos est décroissante sur [0, π])
```

```js
/** Angle polaire maximal pour que la camera reste au-dessus du plan y = floor. */
function maxPolarForFloor(targetY, distance, floor) {
  const c = (floor - targetY) / distance;
  return Math.acos(clamp(c, -1, 1));
}
```

Avec `y_floor = 0,25 m` (25 cm au-dessus de la base du bloc, de quoi voir la stratigraphie de la
coupe sans passer dessous) : à `T.y = 1,3 m` et `d = 16,5 m`, `c = −0,064`, `φ_max = 1,635 rad`
— soit au-delà de `MAX_POLAR`, donc inactif. À `d = 1,4 m` et `T.y = 0,3 m`, `c = −0,036`,
`φ_max = 1,607` — inactif aussi. En pratique cette contrainte ne mord qu'en vue très rasante et
très proche, ce qui est exactement le cas qu'on veut couvrir.

**Règle d'or :** la contrainte s'exprime **dans l'espace de paramètres** `(A, φ, d)`, jamais sur
le résultat. Écrire `camera.position.y = Math.max(...)` après coup casserait l'invariant : à la
frame suivante, la reconstruction sphérique réinjecterait un `φ` incohérent, et la caméra
oscillerait.

#### 5.1.2 Le terrain : deux itérations de point fixe

Le terrain n'est pas un plan, mais `VoxelField.surfaceHeightAt(x, z)` est une simple lecture
bilinéaire dans `surfaceH` — quelques nanosecondes. On échantillonne le **bras** de la caméra en
`N = 6` points et on calcule de combien il faut relever `φ` :

```js
const ARM_SAMPLES = 6;
const CLEARANCE = 0.28;        // metres au-dessus du sable : le near plane fait ~2 cm

/**
 * Releve l'elevation juste ce qu'il faut pour que le bras camera-cible ne
 * plonge nulle part sous le sable.
 *
 * Methode : on echantillonne le bras, on mesure la penetration maximale, et on
 * convertit en correction d'angle par la derivee dy/dphi = -s*d*sin(phi).
 * Deux iterations suffisent (l'erreur residuelle est en O(delta^2)).
 */
solveTerrainClearance(A, phi, dist, T) {
  const F = this.field;
  if (!F) return phi;
  for (let it = 0; it < 2; it++) {
    const sp = Math.sin(phi), cp = Math.cos(phi);
    const ux = sp * Math.sin(A), uy = cp, uz = sp * Math.cos(A);
    let need = 0;
    for (let i = 1; i <= ARM_SAMPLES; i++) {
      const s = i / ARM_SAMPLES;
      const qx = T.x + s * dist * ux;
      const qy = T.y + s * dist * uy;
      const qz = T.z + s * dist * uz;
      const floor = Math.max(F.surfaceHeightAt(qx, qz) + CLEARANCE, GROUND_FLOOR);
      const pen = floor - qy;                        // > 0 = on est dedans
      if (pen > 0) {
        // d(qy)/d(phi) = -s*dist*sin(phi) : baisser phi de delta remonte de
        // s*dist*sin(phi)*delta.
        const dydphi = s * dist * Math.max(sp, 0.05);
        need = Math.max(need, pen / dydphi);
      }
    }
    if (need <= 1e-4) break;
    phi = Math.max(this.minPolar, phi - Math.min(need, 0.5));
  }
  return phi;
}
```

`GROUND_FLOOR = 0.25` reprend la contrainte du §5.1.1 — les deux se combinent naturellement, la
plus contraignante gagne.

#### 5.1.3 Hystérésis : monter vite, redescendre lentement

Appliquer la correction brute ferait pomper la caméra dès qu'on longe une tour. On applique la
règle asymétrique standard — c'est littéralement ce que Cinemachine encode avec ses deux
constantes `Damping` / `Damping When Occluded` :

| Sens | Demi-vie | Pourquoi |
|---|---|---|
| **Il faut monter** (on clippe) | 25 ms — quasi instantané | L'œil interprète un évitement rapide comme volontaire. Traverser le sable, jamais. |
| **On peut redescendre** (l'obstacle est passé) | 550 ms — lent | C'est le *retour* rapide qui produit le pompage nauséeux. |

```js
// dans update(dt), apres la resolution des ressorts :
const wanted = this.solveTerrainClearance(this.azimuth, this.polar, this.distance, this.target);
const lift = Math.max(0, this.polar - wanted);            // correction demandee
const H = lift > this._lift ? 0.025 : 0.550;              // asymetrie
this._lift += (lift - this._lift) * (1 - Math.exp(-Math.LN2 * dt / H));
const phiUsed = clamp(this.polar - this._lift, this.minPolar, this.maxPolar);
```

`_lift` est la seule variable d'état supplémentaire, et elle n'est **jamais** réinjectée dans
`polar` : c'est un décalage de rendu. Quand le joueur creuse et que la tour disparaît, `_lift`
retombe à zéro et la caméra retrouve exactement l'élévation qu'il avait choisie. C'est
essentiel : une caméra qui « garde » les corrections qu'on lui a imposées finit par dériver.

#### 5.1.4 Filet de sécurité final

Après tout, une ligne défensive, parce qu'un `NaN` ou un chargement de sauvegarde peut mettre la
caméra n'importe où :

```js
// Dernier recours : jamais sous le bloc, quoi qu'il arrive.
if (this.camera.position.y < GROUND_FLOOR) this.camera.position.y = GROUND_FLOOR;
```

### 5.2 Limites d'inclinaison et verrouillage du roulis

#### 5.2.1 Le roulis est nul par construction

Avec le paramétrage `(A, φ, d)` et `up = (0,1,0)` constant, `lookAt` construit
`right = normalize(cross(up, forward))`. Un produit vectoriel **avec** `+Y` est nécessairement
perpendiculaire à `Y` : `right` est **toujours horizontal**. Le roulis est donc identiquement
nul — ce n'est pas une correction, c'est une propriété algébrique du paramétrage. **Aucun chemin
dans l'espace `(A, φ)` ne peut produire du roulis.**

C'est l'argument décisif contre un modèle position + quaternion, où le roulis est un degré de
liberté réel qu'il faut contraindre à chaque frame — et que l'interpolation réintroduit (§5.5.2).

Corollaire : **ne jamais écrire `camera.up`** ailleurs qu'à l'initialisation. Une ligne
« redressons un peu la caméra » dans le mode photo suffirait à décaler silencieusement le repère
d'orbite et à faire réapparaître le roulis.

#### 5.2.2 Les deux bornes, et leurs justifications distinctes

```js
this.minPolar = 0.14;                  // 8,0 deg d'elevation... non : voir ci-dessous
this.maxPolar = Math.PI / 2 - 0.14;    // 8,0 deg au-dessus de l'horizon
```

| Borne | Valeur | Nature de la justification |
|---|---|---|
| `minPolar` | **0,12 rad** (élévation 83,1°) | **Perceptive, anti-spin.** Près du zénith, `sin φ → 0` : le déplacement induit par un incrément d'azimut vaut `d·sin φ·ΔA → 0`, donc la sensibilité *angulaire à l'écran* explose. À `φ = 0,12`, l'amplification vaut ×8,3 par rapport à l'équateur — encore contrôlable. En dessous de 0,05 (×20) c'est inutilisable. `Spherical.makeSafe()` de three.js utilise `ε = 1e-6` : ça évite le `NaN`, **pas** le spin. |
| `maxPolar` | **π/2 − 0,14 = 1,4308 rad** (élévation 8,0°) | **Sémantique.** À l'horizon exact, le bloc est vu par la tranche : plus d'épaisseur, plus d'ombre portée lisible, `z-fighting` sur les faces de coupe. Et le panoramique vertical devient impossible (§1.3). C'est la valeur du doc de design, et il a raison. |

La valeur actuelle `MAX_POLAR = π·0.49 = 1,5394` (élévation 1,8°) est donc corrigée à **1,4308**.

Deux exceptions, explicites :

```js
// Vue de dessus (T) : on autorise le zenith exact, mais on GELE l'azimut.
// C'est ce qui rend la singularite inoffensive : sans variation d'azimut, pas
// de spin possible.
this.minPolar = this.topView ? 0 : 0.12;

// Mode photo : on relache la borne basse a 3 deg pour les plans rasants.
this.maxPolar = this.game.photoMode ? Math.PI / 2 - 0.05 : Math.PI / 2 - 0.14;
```

### 5.3 Recadrage automatique — trois touches

| Touche | Action | Durée | Comportement |
|---|---|---|---|
| `F` | **Focus** : centrer sur le point sous le curseur | ~280 ms | La cible va au point visé ; la distance est réduite à `min(d, 4·rayon_brosse + 1,2 m)` si on est loin, sinon inchangée. |
| `A` (ou double-clic molette) | **Tout voir** | ~700 ms | Cadre la sphère englobante du bloc. |
| `R` | **Vue diorama** | ~550 ms | Retour exact à `(A = 0,78π, φ = 0,9076, d = 15,5, T = (−0,3, 1,35, −0,3))`. |
| `T` | **Vue de dessus** (toggle) | 350 ms | §5.4 |

#### 5.3.1 « Tout voir » : la formule de la sphère englobante

La sphère englobante est **tangente** aux plans du frustum. Le triangle rectangle (œil, centre,
point de tangence) donne directement :

```
sin(θ/2) = R / d        ⟹        d = R / sin(θ/2)
```

**L'erreur classique est d'écrire `R / tan(θ/2)`** — ce serait la distance pour cadrer un *disque
plat* perpendiculaire à l'axe. Comme `tan > sin`, on obtient une distance trop courte et la
sphère déborde. À 32° de FOV : `1/sin(16°) = 3,628` contre `1/tan(16°) = 3,487`, soit **3,9 % trop
près** — assez pour rogner les coins du bloc.

Et il faut prendre le plus étroit des deux champs :

```js
const DEG2RAD = Math.PI / 180;

/**
 * Distance perspective pour qu'une sphere de rayon R tienne dans le viewport.
 * En portrait (aspect < 1) c'est l'HORIZONTALE qui contraint : on prend le
 * demi-angle le plus petit des deux.
 */
function distanceToFitSphere(R, fovYdeg, aspect, pad = 0.08) {
  const tv = Math.tan(fovYdeg * DEG2RAD / 2);
  const fovEff = 2 * Math.atan(Math.min(tv, tv * aspect));
  return (R * (1 + pad)) / Math.sin(fovEff / 2);
}
```

Pour ce diorama : le bloc fait 10,24 × 10,24 m au sol et culmine vers 2 m. Centre de la sphère
englobante `(0 ; 0,9 ; 0)`, rayon
`R = √(5,12² + 5,12² + 1,1²) = 7,32 m`.

| Format | aspect | `fov_eff` | distance | tient dans `maxDistance = 34` ? |
|---|---|---|---|---|
| 16:9 | 1,778 | 32° (vertical) | **28,7 m** | oui |
| 4:3 | 1,333 | 32° | 28,7 m | oui |
| 1:1 | 1,0 | 32° | 28,7 m | oui, tout juste |
| Portrait 9:16 | 0,5625 | 18,2° (horizontal) | **50,0 m** | **non** |

Conclusion chiffrée : `maxDistance = 34 m` couvre tous les formats paysage et carrés. En portrait
strict, on accepte de rogner (`pad = 0`, distance 46 m > 34) — ou, mieux, on **cadre la boîte
plutôt que la sphère**, ce qui est plus économe pour un objet plat et large :

```js
/**
 * Variante "boite" : plus serree pour un diorama, qui est large et plat.
 * On cadre la face avant, d'ou le `+ depth/2`. Ici c'est bien `tan` et non
 * `sin` : un rectangle plan, pas une sphere.
 */
function distanceToFitBox(w, h, depth, fovYdeg, aspect) {
  const fov = fovYdeg * DEG2RAD;
  const hFit = (w / h < aspect) ? h : w / aspect;
  return (hFit * 0.5) / Math.tan(fov * 0.5) + depth * 0.5;
}
```

#### 5.3.2 Le code des trois recadrages

```js
/** Centre sur le point du monde sous le curseur, en douceur. */
focusCursor() {
  const P = this.anchorAt(this._px, this._py);
  if (!P) return;
  const d = Math.min(this.goalDistance, Math.max(this.minDistance, 4.5));
  this.tweenTo({ target: P.clone(), distance: d }, 'focus');
}

/** Cadre tout le bloc, orientation conservee. */
frameAll() {
  const R = Math.hypot(WORLD_W / 2, WORLD_D / 2, 1.1);
  const d = clamp(distanceToFitSphere(R, this.camera.fov, this.camera.aspect, 0.08),
                  this.minDistance, this.maxDistance);
  this.tweenTo({ target: new THREE.Vector3(0, 0.9, 0), distance: d }, 'frame');
}

/** Vue diorama de depart. */
reset() {
  this.tweenTo({
    azimuth: HOME.azimuth, polar: HOME.polar,
    distance: HOME.distance, target: HOME.target.clone(),
  }, 'frame');
}
```

### 5.4 Vue de dessus orthographique

Le doc de design (`§4.3` — Solution 4) en fait la réponse à « je n'arrive pas à faire un plan
carré à la souris en perspective ». Deux implémentations possibles.

#### 5.4.1 La vraie ortho (recommandée à terme)

L'équivalence exacte, celle qui garantit qu'**aucun saut d'échelle** ne se produit au niveau du
pivot :

```
h_ortho = 2 · d · tan(fov_Y / 2)
```

```js
/** Hauteur du frustum ortho equivalente a la perspective courante. */
const orthoHeight = (d, fovYdeg) => 2 * d * Math.tan(fovYdeg * DEG2RAD / 2);

function syncOrtho(ortho, state, fovYdeg, aspect, boundR = 8) {
  const h = orthoHeight(state.distance, fovYdeg);
  ortho.top = h / 2;  ortho.bottom = -h / 2;
  ortho.right = h * aspect / 2;  ortho.left = -h * aspect / 2;
  // L'ortho tolere un near NEGATIF : on ouvre la boite des deux cotes pour ne
  // rien clipper meme si la camera est "dans" le volume.
  ortho.near = -(state.distance + boundR);
  ortho.far  =   state.distance + boundR * 3;
  ortho.updateProjectionMatrix();
}
```

**Architecture retenue : un seul état orbital, deux caméras dérivées.** On garde
`(azimuth, polar, distance, target)` comme unique source de vérité, on positionne les deux
caméras à chaque frame, et la bascule ne fait que choisir laquelle est rendue. Bénéfices :
la bascule est gratuite, le geste de zoom continue de piloter `distance` à l'identique dans les
deux modes, et il n'y a jamais de dérive entre les deux états. C'est un `if` dans `Game.render`
et dans `Post`, plus une ligne dans `ToolManager` (`Raycaster.setFromCamera` gère l'ortho
nativement).

Attention : seul le plan passant par le pivot est préservé par la bascule. Ce qui est devant
grossit, ce qui est derrière rétrécit — c'est la nature même du changement de projection.

#### 5.4.2 La fausse ortho (à faire d'abord)

Un FOV très étroit avec la distance compensée donne une image **visuellement
indiscernable** d'une orthographique, sans toucher au pipeline de rendu ni au post-traitement.
C'est ce que `GAME-DESIGN.md` appelle « orthographique avec un FOV simulé ».

```
d' = d · tan(fov/2) / tan(fov'/2)
```

Avec `fov = 32°` et `fov' = 6°` : `d' = d · 0,2867/0,0524 = 5,47·d`. À `d = 12 m`, `d' = 65,6 m`
— au-delà de `maxDistance` et du `far = 120` de la caméra. Il faut donc, en mode « vue de
dessus », relever temporairement `maxDistance` et `camera.far`. C'est trois lignes, contre une
soixantaine pour la vraie ortho :

```js
setTopView(on) {
  if (on === this.topView) return;
  this.topView = on;
  if (on) {
    this._saved = { fov: this.camera.fov, max: this.maxDistance, far: this.camera.far,
                    az: this.goalAzimuth, po: this.goalPolar, d: this.goalDistance };
    const d2 = this.goalDistance * Math.tan(16 * DEG2RAD) / Math.tan(3 * DEG2RAD);
    this.maxDistance = 200;
    this.camera.far = 320;
    this.minPolar = 0;                             // zenith autorise
    this.tweenTo({ polar: 0, distance: Math.min(d2, 190), fov: 6 }, 'top');
  } else {
    this.maxDistance = this._saved.max;
    this.camera.far = this._saved.far;
    this.minPolar = 0.12;
    this.tweenTo({ polar: this._saved.po, distance: this._saved.d, fov: 32 }, 'top');
  }
}
```

Et pendant la vue de dessus, on **gèle l'orbite** (`polar` reste à 0, l'azimut reste réglable par
`Q`/`E` pour tourner le plan) : c'est ce qui rend la singularité au zénith totalement inoffensive.

### 5.5 Transitions animées : courbe et durée

#### 5.5.1 Interpoler quoi

| ❌ Faux | ✅ Correct |
|---|---|
| `lerp(position₀, position₁)` | interpoler `(A, φ, ln d, T)` |
| `slerp(quaternion₀, quaternion₁)` | interpoler `(A, φ)` |
| `lerp(d₀, d₁)` | `exp(lerp(ln d₀, ln d₁))` |
| `A₁ − A₀` brut | `shortestDelta(A₀, A₁)` |

**Pourquoi pas le lerp de position :** il trace une *corde* de la sphère d'orbite. Pour une
rotation de 180°, la caméra passe **par le centre du sujet**. Même à 90°, on perd 29 % de
distance en milieu de trajet : le château gonfle puis dégonfle.

**Pourquoi pas le slerp de quaternion :** deux orientations sans roulis ne sont pas reliées par un
chemin sans roulis dans SO(3). Le slerp prend la géodésique, dont l'axe n'est en général ni
vertical ni dans le plan de vue : les orientations intermédiaires ont un **roulis non nul**, qui
monte puis redescend. À l'écran, l'horizon bascule puis se redresse — précisément le stimulus
vestibulaire le plus agressif.

**Pourquoi `ln d` :** un lerp linéaire de 30 m → 3 m passe la première moitié de l'animation entre
30 et 16,5 m (l'objet double à peine) et la seconde entre 16,5 et 3 m (l'objet est multiplié par
5,5). Le flux optique explose en fin de course. En espace log, le taux de croissance apparent est
**constant**. Ce n'est pas de l'empirisme : c'est le résultat que Van Wijk & Nuij dérivent
formellement (la géodésique de leur métrique perceptive, sur un segment de zoom pur, est
`w(s) = w₀·e^(ρs)`).

Déroulement de l'azimut, obligatoire sous peine de faire 350° au lieu de −10° :

```js
const TAU = Math.PI * 2;
/** Ecart angulaire le plus court, dans (-pi, pi]. Le double modulo est
 *  necessaire : `%` en JS garde le signe du dividende. */
const shortestDelta = (a0, a1) => ((a1 - a0 + Math.PI) % TAU + TAU) % TAU - Math.PI;
```

#### 5.5.2 La courbe : `smootherstep`, pas `easeOutQuint`

Le critère de choix pour une caméra n'est **pas** celui d'un panneau d'interface. Le système
vestibulaire est sensible au *jerk* (dérivée de l'accélération), pas seulement à la vitesse.
Classement par continuité aux bornes :

| Courbe | Continuité en 0 et 1 | Verdict caméra |
|---|---|---|
| `smootherstep(x) = x³(x(6x − 15) + 10)` | **C²** (v = 0 **et** a = 0) | ✅ **le meilleur choix** — démarrage et arrêt imperceptibles |
| `easeInOutCubic` | C¹ (v = 0, a ≠ 0) | ✅ bon défaut, saut d'accélération faible |
| `smoothstep(x) = x²(3 − 2x)` | C¹ | ⚠️ acceptable, un peu sec (`a` saute à ±6) |
| `easeOutQuint` | **discontinu en 0** (`v(0⁺) = 5`) | ❌ **à proscrire.** Parfait pour un panneau (réactivité perçue), mais l'à-coup initial est exactement le stimulus à éviter |
| `easeOutExpo` | `v(0⁺) ≈ 6,93` | ❌ pire encore |

Les courbes `easeOut*` sont conçues pour *répondre à un clic* ; les caméras veulent des courbes
`easeInOut*` symétriques et C². On ne transpose pas les recettes d'interface.

```js
const smootherstep = (x) => x * x * x * (x * (6 * x - 15) + 10);
```

#### 5.5.3 La durée : dérivée du geste, pas fixe

Une durée fixe est fausse dans les deux sens : trop longue pour un petit recadrage, trop courte
pour un grand. La formulation de Van Wijk & Nuij donne la longueur d'arc `S` du chemin optimal
dans l'espace (pan, zoom), avec `ρ = √2` et `V = 1,0` (les valeurs mesurées sur 26 sujets valent
`ρ = 1,42 ± 0,47` et `V = 0,90 ± 0,43`) :

```js
const RHO = Math.SQRT2, RHO2 = 2, RHO4 = 4;

/**
 * Duree "naturelle" d'une transition orbitale, en secondes.
 * On alimente le modele de Van Wijk & Nuij avec :
 *   u = position du pivot          (le pan)
 *   w = largeur monde au pivot     = 2*d*tan(fov/2), donc proportionnelle a d
 */
function vanWijkDuration(T0, d0, T1, d1, fovYdeg, V = 1.0) {
  const k = 2 * Math.tan(fovYdeg * DEG2RAD / 2);
  const w0 = k * d0, w1 = k * d1;
  const dist = Math.hypot(T1.x - T0.x, T1.y - T0.y, T1.z - T0.z);
  let S;
  if (dist < 1e-9) {
    S = Math.abs(Math.log(w1 / w0)) / RHO;
  } else {
    const d2 = dist * dist;
    const b0 = (w1 * w1 - w0 * w0 + RHO4 * d2) / (2 * w0 * RHO2 * dist);
    const b1 = (w1 * w1 - w0 * w0 - RHO4 * d2) / (2 * w1 * RHO2 * dist);
    const r0 = Math.log(Math.sqrt(b0 * b0 + 1) - b0);
    const r1 = Math.log(Math.sqrt(b1 * b1 + 1) - b1);
    S = (r1 - r0) / RHO;
  }
  return clamp(S / V, 0.22, 0.90);
}
```

Ce que le modèle prédit sur du zoom pur, à `V = 1` :

| Ratio de zoom | `S` | Durée |
|---|---|---|
| ×1,3 (petit focus) | 0,185 | **185 ms** → clampée à 220 ms |
| ×2 | 0,490 | **490 ms** |
| ×4 (recadrage) | 0,980 | **900 ms** (clampée) |
| ×10 | 1,628 | 900 ms (clampée) |

Les repères empiriques du doc de design — 350 ms pour la vue de dessus, 400 ms pour le focus,
1,8 s pour l'ouverture — tombent naturellement dans cette fourchette. Ce ne sont pas des chiffres
arbitraires : ce sont les prédictions du modèle sur les ratios de zoom typiques.

Bénéfice gratuit et remarquable : quand les deux points de vue sont éloignés, la géodésique de
Van Wijk **dézoome d'elle-même en milieu de course** puis rezoome. C'est le comportement qu'on
essaie habituellement de bricoler à la main, et il tombe de la formule.

#### 5.5.4 Le tween complet

```js
/**
 * Transition animee vers un etat. Interpole (azimut, polaire, ln d, cible) —
 * jamais la position ni le quaternion.
 *
 * L'inertie est coupee, mais la VITESSE du ressort est conservee : c'est ce qui
 * evite le claquement quand on appuie sur F en plein drag.
 */
tweenTo(to, kind = 'focus') {
  this._spinA = this._spinP = 0;
  const from = {
    azimuth: this.goalAzimuth, polar: this.goalPolar,
    distance: this.goalDistance, target: this.goalTarget.clone(),
    fov: this.camera.fov,
  };
  const T1 = to.target || from.target;
  const d1 = clamp(to.distance ?? from.distance, this.minDistance, this.maxDistance);
  const dur = this.reducedMotion ? 0
            : vanWijkDuration(from.target, from.distance, T1, d1, this.camera.fov);

  this._tween = {
    from, to: {
      azimuth: to.azimuth ?? from.azimuth,
      polar: clamp(to.polar ?? from.polar, this.minPolar, this.maxPolar),
      distance: d1, target: T1, fov: to.fov ?? from.fov,
    },
    dA: shortestDelta(from.azimuth, to.azimuth ?? from.azimuth),
    lnD0: Math.log(from.distance), lnD1: Math.log(d1),
    t: 0, dur, kind,
  };
  if (dur === 0) this._applyTween(1);
}

_applyTween(u) {
  const w = this._tween, e = smootherstep(u);
  this.goalAzimuth  = w.from.azimuth + w.dA * e;
  this.goalPolar    = w.from.polar + (w.to.polar - w.from.polar) * e;
  this.goalDistance = Math.exp(w.lnD0 + (w.lnD1 - w.lnD0) * e);   // <- log, pas lerp
  this.goalTarget.lerpVectors(w.from.target, w.to.target, e);
  if (w.to.fov !== w.from.fov) {
    this.camera.fov = w.from.fov + (w.to.fov - w.from.fov) * e;
    this.camera.updateProjectionMatrix();
  }
  if (u >= 1) this._tween = null;
}
```

Un tween est **annulé instantanément** par toute entrée manuelle (drag, molette, WASD) : la
caméra appartient au joueur. C'est la règle n° 1 des recommandations d'accessibilité en 3D
(« *keeping the camera in full control of the player at all times* »).

### 5.6 Le pivot suit la hauteur du terrain

`GAME-DESIGN.md` §4.2 le demande : « le pivot suit la hauteur moyenne du terrain sous lui (lissée
sur 0,5 s) → quand on construit une tour, la caméra monte naturellement ». C'est dix lignes, et
c'est un des réglages qui se sent le plus :

```js
/**
 * La cible suit la hauteur du terrain sous elle, avec une demi-vie de 0,35 s.
 *
 * On vise 40 cm au-dessus de la surface : le centre de gravite de ce qu'on
 * regarde quand on sculpte, pas le sol. Desactive pendant un zoom ancre (sinon
 * la cible se battrait avec l'homothetie) et en vue de dessus.
 */
followTerrain(dt) {
  if (!this.autoHeight || this._zoomAnchorActive || this.topView || !this.field) return;
  const h = this.field.surfaceHeightAt(this.goalTarget.x, this.goalTarget.z) + 0.40;
  const k = 1 - Math.exp(-Math.LN2 * dt / 0.35);
  this.goalTarget.y += (clamp(h, 0.2, 3.2) - this.goalTarget.y) * k;
}
```

### 5.7 Anti-nausée et mouvement réduit

Le champ de vision étroit (32°) est déjà le meilleur allié : la relation FOV ↔ nausée est
curvilinéaire et la vection vient surtout du flux optique **périphérique**. À 32° on est très
loin de la zone à risque. Il reste trois leviers.

```js
/** Profil "mouvement reduit", branche sur la preference systeme. */
applyMotionProfile() {
  const mq = matchMedia('(prefers-reduced-motion: reduce)');
  this.reducedMotion = mq.matches || this.forceReducedMotion;
  if (this.reducedMotion) {
    this.hOrbit = this.hPan = this.hZoom = 0;   // snap : le ressort passe en mode direct
    this.inertiaEnabled = false;
    this.autoRotate = false;
    this.autoHeight = false;                    // plus d'auto-elevation du pivot
  } else {
    this.hOrbit = H_ORBIT; this.hPan = H_PAN; this.hZoom = H_ZOOM;
    this.inertiaEnabled = true;
    this.autoHeight = true;
  }
}
// A brancher au demarrage ET sur changement :
matchMedia('(prefers-reduced-motion: reduce)').addEventListener('change', () => this.applyMotionProfile());
```

En mode réduit, on fait une **coupe franche** (durée 0) plutôt qu'une transition raccourcie : une
transition de 100 ms est *plus* saccadée qu'un cut, donc plus nocive.

Le HUD expose en plus, dans les options, ce que ce profil règle séparément :

| Réglage | Plage | Défaut |
|---|---|---|
| Lissage caméra | 0 → 200 ms (demi-vie) | 70 ms |
| Inertie | oui / non | oui |
| Élévation automatique du pivot | oui / non | oui |
| Sensibilité du zoom | 0,25× → 4× | 1× |
| Zoom curseur | avant / avant + arrière / jamais | avant |
| Molette | zoom / rayon de brosse | zoom |
| Inverser l'axe vertical de l'orbite | oui / non | non |
| Orbite par pas de 22,5° | oui / non | non |

Le dernier point mérite d'être souligné : la rotation **par paliers** est la recommandation la
plus citée pour le confort (« *snap-rotating in 30 degree increments* »). Un pas de 22,5°
(π/8) donne 16 positions par tour, dont les quatre vues cardinales exactes — c'est le pas retenu
par `<model-viewer>` pour le clavier, et c'est la bonne valeur.

---

## 6. Entrées alternatives

Le point de départ est une contrainte forte : **les deux boutons de la souris appartiennent aux
outils**. La caméra n'a donc que le bouton du milieu, les modificateurs et le clavier. Or le
bouton du milieu est le premier à disparaître : il n'existe pas sur un trackpad, il est
inconfortable sur beaucoup de souris, et il est inexistant au doigt.

La réponse est un **mode caméra temporaire sur `Espace`**, déjà prévu par le doc de design
(§4.1.2 : « `Espace` (maintenu) — Mode caméra temporaire (LMB = orbite, RMB = pan) »). C'est le
seul schéma qui fonctionne sur *tous* les périphériques sans exception, et il devient le chemin
principal, pas un repli.

```js
/**
 * Mode camera temporaire. Tant qu'Espace est maintenu :
 *   - le curseur devient une main
 *   - LMB = orbite, RMB = pan
 *   - ToolManager est desactive (aucun coup de pelle accidentel)
 *
 * On coupe aussi tout geste d'outil en cours : appuyer sur Espace au milieu
 * d'un trait doit interrompre le trait, pas le laisser courir.
 */
setCameraMode(on) {
  if (on === this._camMode) return;
  this._camMode = on;
  this.dom.style.cursor = on ? 'grab' : '';
  this.game.tools.enabled = !on && !this.game.photoMode;
  if (on) this.game.tools.endStroke();
}
```

### 6.1 Souris à trois boutons (référence)

| Entrée | Action |
|---|---|
| Molette (drag) | Orbite |
| `Maj` + molette (drag) | Panoramique |
| Molette (roulement) | **Zoom ancré** |
| `Ctrl` + molette | Rayon de brosse |
| Double-clic molette | Focus sur le point visé |
| `Alt` + clic gauche | Orbite (souris sans molette cliquable) |
| `Alt` + `Maj` + clic gauche | Panoramique |
| `Espace` + clic gauche / droit | Orbite / panoramique |

### 6.2 Trackpad sans molette cliquable

C'est le cas le plus contraint, et le plus fréquent chez un joueur navigateur.

| Geste | Action | Mécanique |
|---|---|---|
| Un doigt | Déplacer le curseur | `pointermove` |
| Clic / tap | Action primaire de l'outil | `pointerdown` bouton 0 |
| Clic à deux doigts | Action secondaire | `pointerdown` bouton 2 |
| **Deux doigts, glissement** | **Zoom ancré** (vertical) / rien (horizontal) | `wheel`, profil trackpad |
| **Pincement** | **Zoom ancré, continu** | `wheel` + `ctrlKey` sans `Ctrl` réel, ou `gesturechange` |
| **`Espace` + un doigt** | **Orbite** | mode caméra temporaire |
| **`Espace` + `Maj` + un doigt** | **Panoramique** | idem |
| `Ctrl` + deux doigts vertical | Rayon de brosse | vrai `Ctrl` détecté |
| `Alt` + un doigt (glissement) | Orbite | secours si `Espace` est capté par le navigateur |

Le doc de design proposait « deux doigts glisser = orbite ». **On ne peut pas le faire** : un
glissement à deux doigts sur trackpad n'arrive au navigateur que sous forme de `wheel`, sans
aucune information de position de départ, sans début ni fin de geste, et sans moyen fiable de le
distinguer d'un défilement. En faire une orbite rendrait le zoom inaccessible. On garde donc
`wheel` = zoom (le geste que le joueur attend) et on met l'orbite sur `Espace`.

Un bandeau d'aide s'affiche **une seule fois**, au moment où le profil trackpad est détecté
(§3.5) :

> *Trackpad détecté — maintiens `Espace` et fais glisser pour tourner autour du château.
> Le pincement zoome.*

### 6.3 Souris à deux boutons (sans molette cliquable, avec roulement)

| Entrée | Action |
|---|---|
| Molette (roulement) | Zoom ancré |
| `Alt` + clic gauche (drag) | Orbite |
| `Alt` + `Maj` + clic gauche (drag) | Panoramique |
| `Espace` + clic gauche / droit | Orbite / panoramique |
| `Q` / `E` | Orbite par pas de 22,5° |

`Alt` est doublé par `Espace` parce que sur macOS `Alt+glissement` peut être capté par le système
(Mission Control), et sous certains gestionnaires de fenêtres Linux `Alt+glissement` déplace la
fenêtre. `Espace` n'a jamais ce problème.

### 6.4 Écran tactile

L'implémentation repose sur une carte de pointeurs actifs, alimentée par les événements
`pointerdown/move/up` filtrés sur `pointerType === 'touch'`. Le geste à deux doigts porte
**trois** informations simultanées et on les exploite toutes les trois :

| Grandeur mesurée | Ce qu'elle pilote |
|---|---|
| Translation du **milieu** des deux doigts | Panoramique |
| Variation de la **distance** entre les doigts | Zoom, ancré sur le milieu |
| Rotation du **segment** entre les doigts | Orbite en azimut (optionnelle, désactivée par défaut : trop de faux positifs) |

Un doigt reste l'outil, trois doigts font l'orbite. C'est le schéma le plus proche des habitudes
(Google Maps, Procreate).

```js
/**
 * Gestes tactiles.
 *   1 doigt  : outil (ToolManager)
 *   2 doigts : pincement -> zoom ancre sur le milieu ; glissement -> panoramique
 *   3 doigts : orbite
 *
 * Note : on ne fait PAS d'orbite a deux doigts. Sur une tablette on pince et
 * on fait glisser en meme temps sans le vouloir ; melanger l'orbite la-dedans
 * rend les trois gestes imprecis. Trois doigts est sans ambiguite.
 */
_touches = new Map();

onTouchDown(e) {
  this._touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
  const n = this._touches.size;
  if (n >= 2) {
    this.game.tools.endStroke();
    this.game.tools.enabled = false;
    this._gesture = this._readGesture();
    this._anchorValid = false;                 // nouvelle ancre au prochain zoom
  }
}

onTouchMove(e) {
  const t = this._touches.get(e.pointerId);
  if (!t) return;
  t.x = e.clientX; t.y = e.clientY;
  const n = this._touches.size;
  if (n < 2) return;

  const g = this._readGesture();
  const p = this._gesture;

  if (n === 2) {
    // Pincement -> zoom ancre sur le milieu des deux doigts.
    if (p.dist > 8 && g.dist > 8) {
      const k = p.dist / g.dist;                     // ecartement => k < 1 => zoom avant
      this.zoomAt(g.cx, g.cy, Math.log(k) / ZOOM_PER_NOTCH);
    }
    // Glissement du milieu -> panoramique.
    this.pan(g.cx - p.cx, g.cy - p.cy);
  } else {
    // Trois doigts -> orbite.
    const rate = TAU / (this.dom.clientHeight || 1);
    this.goalAzimuth -= (g.cx - p.cx) * rate;
    this.goalPolar = clamp(this.goalPolar - (g.cy - p.cy) * rate,
                           this.minPolar, this.maxPolar);
  }
  this._gesture = g;
}

onTouchUp(e) {
  this._touches.delete(e.pointerId);
  if (this._touches.size === 0) {
    this.game.tools.enabled = !this.game.photoMode;
  }
  this._gesture = this._touches.size >= 2 ? this._readGesture() : null;
}

/** Milieu et ecartement des deux premiers doigts. */
_readGesture() {
  const [a, b] = [...this._touches.values()];
  if (!b) return { cx: a.x, cy: a.y, dist: 0 };
  return {
    cx: (a.x + b.x) / 2,
    cy: (a.y + b.y) / 2,
    dist: Math.hypot(a.x - b.x, a.y - b.y),
  };
}
```

Trois détails qui font la différence sur tablette :

- `touch-action: none` sur le canevas, sinon le navigateur préempte le pincement pour son propre
  zoom de page et aucun `pointermove` n'arrive.
- **Seuil de démarrage** : on n'applique le zoom qu'au-delà de 8 px d'écartement, sinon deux
  doigts posés simultanément produisent un pic de zoom.
- Le doc de design promet un **curseur de rayon circulaire permanent à gauche** (« le pouce y
  tombe naturellement »). C'est la bonne réponse au problème du rayon sur tablette, et ça évite
  d'avoir à inventer un geste de plus.

### 6.5 Clavier seul

C'est une exigence normative, pas un confort : le critère WCAG **2.1.1 Keyboard** (niveau A)
impose que toute fonctionnalité soit opérable au clavier, *sauf* quand elle dépend du tracé du
mouvement et pas seulement de ses extrémités. **Une orbite ne dépend que de ses extrémités**
`(A, φ, d)` : l'exception ne s'applique pas, le clavier est obligatoire. Et le critère
**2.5.7 Dragging Movements** (AA, WCAG 2.2) exige en plus une alternative *au pointeur sans
glissement* — d'où les boutons du HUD.

| Touche | Action | Pas |
|---|---|---|
| `A` `D` ou `←` `→` | Orbite en azimut | continu ; `Maj` = ×0,25 (précision) |
| `W` `S` ou `↑` `↓` | Orbite en élévation | continu, borné |
| `Q` / `E` | Orbite par pas de **22,5°** | avec transition animée de 220 ms |
| `Maj` + `WASD` / flèches | **Panoramique** | proportionnel à la distance |
| `+` / `-` (et `PagePrec`/`PageSuiv`) | Zoom ancré sur le curseur | 1 cran par appui, répétition auto |
| `F` | Focus sur le point sous le curseur | — |
| `A` (avec `Ctrl`) | Tout voir | — |
| `R` | Vue diorama | — |
| `T` | Vue de dessus (bascule) | — |
| `Origine` | Vue diorama (synonyme de `R`) | — |

Le pas de **22,5° = π/8** n'est pas arbitraire : 16 positions par tour, dont les quatre vues
cardinales exactes en quatre appuis. C'est le pas retenu par `<model-viewer>` (`KEYBOARD_ORBIT_INCREMENT
= Math.PI / 8`), et c'est le meilleur compromis entre « perceptible » et « pas désorientant ». Un pas
de 5° rend la rotation interminable, un pas de 45° casse la continuité.

> **Attention au conflit `A`.** `A` est déjà le panoramique gauche (`KeyA`) dans le code actuel.
> « Tout voir » prend donc `Ctrl+A`, ou mieux : la touche **`Origine`** et le double-clic molette.
> `R` reste libre et devient le reset.

**Annoncer l'état.** Une caméra pilotée au clavier sans retour est inutilisable pour un
utilisateur de lecteur d'écran. La bonne pratique consiste à **quantifier** l'orbite en états
sémantiques plutôt qu'à annoncer des degrés :

```js
const AZ  = ['de face', 'de la droite', 'de dos', 'de la gauche'];
const POL = ['en surplomb, ', '', ''];

/**
 * Etat de camera lisible. On quantifie en 4 quadrants x 2 tranches : annoncer
 * "azimut 47 degres" ne sert a rien, "de face, en surplomb" oriente vraiment.
 *
 * Le + PI/4 avant la division CENTRE les quadrants sur les axes cardinaux :
 * "de face" couvre -45..+45 deg et non 0..90.
 */
function viewLabel(A, phi) {
  const q = (4 + Math.floor(((((A % TAU) + TAU) % TAU) + Math.PI / 4) / (Math.PI / 2))) % 4;
  const t = phi < Math.PI / 3 ? 0 : 1;
  return POL[t] + AZ[q];
}
```

Le HUD porte une région `aria-live="polite" aria-atomic="true"` — **jamais `assertive`**, ce n'est
pas une alerte — visuellement masquée mais pas `display:none` (sinon rien n'est lu), et on
n'annonce que **sur changement de cellule**, avec un anti-rebond de 250 ms.

```html
<div id="cam-status" class="sr-only" aria-live="polite" aria-atomic="true"></div>
<p id="cam-help" class="sr-only">
  Q et E : pivoter par pas de 22 degrés. Plus et moins : zoomer.
  F : centrer sur le curseur. R : vue par défaut. T : vue de dessus.
</p>
```

Le canevas doit porter `tabindex="0"` et un anneau de focus visible
(`:focus-visible { outline: 2px solid; outline-offset: 2px; }`) — il n'est pas focusable
nativement.

> **Piège du mode navigation.** NVDA et JAWS interceptent les flèches en *browse mode* : elles
> n'atteignent jamais le `keydown`. On ne bascule **pas** en `role="application"` (qui transfère
> toute la responsabilité au développeur et dont JAWS ne sort qu'avec `NUMPAD +`) : on garde le
> mode document et on prévoit des équivalents non-fléchés — `Q`/`E`, `W`/`S`, `+`/`-`, `F`, `R`,
> `T` — plus de **vrais `<button>`** dans une barre d'outils du HUD, qui reçoivent `Entrée` et
> `Espace` sans configuration. Cette combinaison couvre 2.1.1 et 2.5.7 d'un coup.

### 6.6 Manette (v2)

Pour mémoire, le schéma du doc de design est bon et se branche sans effort sur l'API retenue :
stick droit → `goalAzimuth/goalPolar` (avec zone morte de 0,15 et courbe de réponse en `x³`),
gâchettes → outils, `A` → `focusCursor()`, `X` → plan de travail. La seule chose à ajouter est le
zoom : croix haut/bas → `zoomAt(centreÉcran, ±1)`, puisqu'il n'y a pas de curseur.

---

## 7. Plan de test complet

Le fichier cible est `tools/test-camera.mjs`, écrit dans le style de `tools/test-play.mjs` :
Puppeteer, un helper `check(nom, ok, détail)`, sortie lisible, `process.exit(1)` en cas d'échec.
On l'ajoute à `package.json` :

```json
"test:camera": "node tools/test-camera.mjs",
"test:all": "npm test && npm run test:play && npm run test:trench && npm run test:tide && npm run test:camera"
```

### 7.1 Tableau des tests et de leurs critères chiffrés

| # | Ce qu'on vérifie | Critère chiffré | Type |
|---|---|---|---|
| **T1** | Le point du monde sous le curseur reste sous le curseur après un zoom | **erreur < 2,5 px** à 1280×800, après convergence | Puppeteer |
| **T1b** | … et **pendant** tout le transit amorti | erreur < 4 px sur chacune des 30 frames | Puppeteer |
| **T1c** | … aussi via le zoom clavier `+` | erreur < 2,5 px | Puppeteer |
| **T2** | Une orbite complète revient au point de départ | **|Δposition| < 1 mm**, |Δazimut| < 1e-6 rad | Puppeteer |
| **T2b** | Un aller-retour de glissement revient au point de départ | erreur < 0,5 px à l'écran | Puppeteer |
| **T3** | La caméra ne traverse jamais le terrain | **0 violation** sur 720 poses ; marge ≥ 0,20 m | Puppeteer |
| **T3b** | La caméra ne passe jamais sous le bloc | `camera.y ≥ 0,25 m` sur les mêmes 720 poses | Puppeteer |
| **T4** | Le panoramique reste borné | cible dans `[−6,72 ; 6,72]` en X et Z, `[0,2 ; 3,2]` en Y, après 60 glissements extrêmes | Puppeteer |
| **T5** | Le zoom respecte ses limites | `d ∈ [1,4 ; 34]` à chaque frame ; atteint chaque borne à **1 %** près | Puppeteer |
| **T6** | L'amortissement converge en un temps donné | 99 % du chemin en **≤ 450 ms** ; **dépassement ≤ 1 %** — mesuré **350 ms / 0,000 %** | Puppeteer |
| **T7** | La sensation ne dépend pas du framerate | échelon : **< 1e-6** (azimut) et **< 1e-4** (distance) ; rampe : **< 2,5 %** — voir §7.3 pour la raison de l'écart entre les deux seuils | unitaire (Node) |
| **T8** | Le panoramique « colle » : le sol suit le curseur | erreur **< 0,5 px** de 61° à 21° d'élévation — mesuré **0,000 px** (le code actuel fait 234 à 335 px) | Puppeteer |
| **T9** | La molette est normalisée entre navigateurs | trois `deltaMode` équivalents → rapports de zoom à **< 12 %** l'un de l'autre | Puppeteer |
| **T10** | Le roulis reste nul | `asin(|right.y|) <` **1e-9 °** sur 48 poses — mesuré **9,5e-15 °** | Puppeteer |
| **T11** | `F`, `R`, `T` font ce qu'elles promettent | focus à < 3 cm ; reset à < 1e-3 ; `polar < 0,01` en vue de dessus | Puppeteer |
| **T12** | Aucune régression de performance ni d'erreur | 0 erreur JS, 0 erreur WebGL, `update()` < 0,35 ms | Puppeteer |

### 7.2 Le squelette et les quatre tests demandés

```js
/**
 * Test d'integration : les controles de camera.
 *
 * Puppeteer pilote la souris, la molette et le clavier, et on verifie dans la
 * page des invariants geometriques : le point sous le curseur ne bouge pas au
 * zoom, une orbite complete est l'identite, la camera ne traverse jamais le
 * sable, le panoramique reste dans la boite.
 *
 *   node tools/test-camera.mjs [--keep]
 */

import puppeteer from 'puppeteer';
import { writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT = join(__dirname, '..', 'shots');
mkdirSync(OUT, { recursive: true });

let failures = 0;
function check(name, ok, detail = '') {
  console.log(`  ${ok ? 'OK  ' : 'FAIL'} ${name}${detail ? '  ' + detail : ''}`);
  if (!ok) failures++;
}

const url = process.env.SC_URL || 'http://localhost:5173/?fresh=1';
const browser = await puppeteer.launch({
  headless: 'shell',
  protocolTimeout: 240000,
  args: [
    '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
    '--enable-webgl', '--ignore-gpu-blocklist', '--no-sandbox', '--disable-dev-shm-usage',
  ],
});
const page = await browser.newPage();
await page.setViewport({ width: 1280, height: 800 });

const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });

console.log('Chargement...');
await page.goto(url, { waitUntil: 'networkidle2', timeout: 90000 });
await page.waitForFunction(() => !document.getElementById('boot'), { timeout: 180000 });
await page.waitForFunction(() => window.game && window.game.controls, { timeout: 30000 });
console.log('Charge.\n');

const W = 1280, H = 800;
const CX = Math.round(W / 2), CY = Math.round(H / 2);

// ---------------------------------------------------------------------------
// HELPERS
// ---------------------------------------------------------------------------

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Attend que la camera soit au repos (tous les buts atteints), ou expire.
 * On ne dort JAMAIS un temps fixe : sur SwiftShader le framerate est erratique
 * et un sleep de 400 ms peut couvrir 2 frames comme 40.
 */
async function settle(timeout = 4000) {
  await page.waitForFunction(() => {
    const c = window.game.controls;
    return Math.abs(c.goalAzimuth - c.azimuth) < 1e-4
        && Math.abs(c.goalPolar - c.polar) < 1e-4
        && Math.abs(c.goalDistance - c.distance) < c.distance * 1e-4
        && c.goalTarget.distanceTo(c.target) < 1e-3
        && !c._tween;
  }, { timeout, polling: 'raf' }).catch(() => {});
  await wait(40);
}

/** Etat complet de la camera, pour comparaison. */
async function camState() {
  return page.evaluate(() => {
    const g = window.game, c = g.controls;
    return {
      azimuth: c.azimuth, polar: c.polar, distance: c.distance,
      target: { x: c.target.x, y: c.target.y, z: c.target.z },
      pos: { x: g.camera.position.x, y: g.camera.position.y, z: g.camera.position.z },
    };
  });
}

/** Remet la camera dans un etat connu et reproductible. */
async function resetCam(over = {}) {
  await page.evaluate((o) => {
    const c = window.game.controls;
    c._tween = null;
    c._spinA = c._spinP = 0;
    c.goalAzimuth = c.azimuth = o.azimuth ?? Math.PI * 0.78;
    c.goalPolar   = c.polar   = o.polar   ?? 0.9076;
    c.goalDistance = c.distance = o.distance ?? 15.5;
    c.goalTarget.set(o.tx ?? -0.3, o.ty ?? 1.35, o.tz ?? -0.3);
    c.target.copy(c.goalTarget);
    if (c._logD !== undefined) c._logD = Math.log(c.distance);
    c.update(0);
  }, over);
  await wait(60);
}

/**
 * Projette un point du monde en coordonnees ecran (pixels CSS).
 * C'est la mesure centrale de T1 et T8 : on compare ce nombre au pixel vise.
 */
async function projectToScreen(p) {
  return page.evaluate(({ p, W, H }) => {
    const g = window.game;
    const THREE = g.controls.target.constructor;
    const v = new THREE(p.x, p.y, p.z).project(g.camera);
    return { x: (v.x * 0.5 + 0.5) * W, y: (-v.y * 0.5 + 0.5) * H, z: v.z };
  }, { p, W, H });
}

/** Point du terrain sous un pixel donne. */
async function worldAtScreen(x, y) {
  return page.evaluate(({ x, y, W, H }) => {
    const g = window.game;
    const THREE = g.tools.raycaster.constructor;
    const r = new THREE();
    r.setFromCamera({ x: (x / W) * 2 - 1, y: -(y / H) * 2 + 1 }, g.camera);
    const o = r.ray.origin, d = r.ray.direction;
    const hit = g.field.raycast({ x: o.x, y: o.y, z: o.z }, { x: d.x, y: d.y, z: d.z }, 80);
    return hit ? { x: hit.point.x, y: hit.point.y, z: hit.point.z } : null;
  }, { x, y, W, H });
}

/**
 * Envoie un evenement `wheel` synthetique EXACTEMENT comme un navigateur.
 *
 * On n'utilise pas `page.mouse.wheel()` : il ne permet ni `deltaMode` ni
 * `ctrlKey`, or ce sont precisement les deux dimensions qu'on teste.
 */
async function wheel(x, y, deltaY, { deltaMode = 0, ctrlKey = false } = {}) {
  await page.mouse.move(x, y);
  await page.evaluate(({ x, y, deltaY, deltaMode, ctrlKey }) => {
    window.game.canvas.dispatchEvent(new WheelEvent('wheel', {
      clientX: x, clientY: y, deltaY, deltaMode, ctrlKey,
      bubbles: true, cancelable: true,
    }));
  }, { x, y, deltaY, deltaMode, ctrlKey });
}
```

#### T1 — le point sous le curseur reste sous le curseur

C'est **le** test de la fonctionnalité demandée. Il mesure directement l'invariant de l'équation
(1) du §2.2 : on note le point du monde sous le curseur, on zoome, on reprojette, on compare.

```js
// ---------------------------------------------------------------------------
console.log('== T1. Zoom ancre sur le curseur ==');
{
  // On vise volontairement LOIN du centre : au centre, tout zoom est "ancre"
  // par construction et le test ne prouverait rien.
  const PX = CX + 260, PY = CY - 150;

  for (const [label, notches] of [['1 cran', 1], ['5 crans', 5], ['12 crans', 12]]) {
    await resetCam();
    await page.mouse.move(PX, PY);
    await wait(60);

    const anchor = await worldAtScreen(PX, PY);
    if (!anchor) { check(`T1 ancre trouvee (${label})`, false, 'le rayon ne touche rien'); continue; }

    const before = await projectToScreen(anchor);
    for (let i = 0; i < notches; i++) await wheel(PX, PY, -100);   // -100 = zoom avant
    await settle();

    const after = await projectToScreen(anchor);
    const err = Math.hypot(after.x - PX, after.y - PY);
    const drift = Math.hypot(after.x - before.x, after.y - before.y);
    const st = await camState();

    check(`T1 l ancre reste sous le curseur (${label})`, err < 2.5,
      `${err.toFixed(2)} px (derive ${drift.toFixed(2)} px, d=${st.distance.toFixed(2)} m)`);
    check(`T1 le zoom a bien eu lieu (${label})`, st.distance < 15.4,
      `15.50 -> ${st.distance.toFixed(2)} m`);
  }

  // --- Zoom arriere : PAS d'ancrage attendu (2.8), mais pas de fuite non plus.
  await resetCam();
  await page.mouse.move(PX, PY);
  const a2 = await worldAtScreen(PX, PY);
  for (let i = 0; i < 6; i++) await wheel(PX, PY, +100);
  await settle();
  const st2 = await camState();
  const inBox = Math.abs(st2.target.x) < 6.8 && Math.abs(st2.target.z) < 6.8;
  check('T1 le dezoom ne fait pas fuir la cible', inBox,
    `cible (${st2.target.x.toFixed(2)}, ${st2.target.z.toFixed(2)})`);
  check('T1 le dezoom recentre doucement', Math.hypot(st2.target.x, st2.target.z) < 5.2,
    `${Math.hypot(st2.target.x, st2.target.z).toFixed(2)} m du centre`);

  // --- Butee : on ne doit pas deriver lateralement en poussant contre la borne.
  await resetCam({ distance: 1.45 });
  await page.mouse.move(PX, PY);
  const beforeMin = await camState();
  for (let i = 0; i < 20; i++) await wheel(PX, PY, -100);
  await settle();
  const afterMin = await camState();
  check('T1 la distance minimale est respectee', afterMin.distance >= 1.3999,
    `${afterMin.distance.toFixed(4)} m`);
  // Avec infinityDolly la cible avance le long de l'axe : c'est voulu. Ce qu'on
  // interdit, c'est un glissement LATERAL, perpendiculaire a l'axe de visee.
  const lateral = await page.evaluate((b) => {
    const c = window.game.controls;
    const A = c.azimuth, th = c.polar;
    const ax = -Math.sin(th) * Math.sin(A), ay = -Math.cos(th), az = -Math.sin(th) * Math.cos(A);
    const dx = c.target.x - b.x, dy = c.target.y - b.y, dz = c.target.z - b.z;
    const along = dx * ax + dy * ay + dz * az;
    return Math.hypot(dx - along * ax, dy - along * ay, dz - along * az);
  }, beforeMin.target);
  check('T1 aucune derive laterale en butee', lateral < 0.02, `${(lateral * 100).toFixed(1)} cm`);
}
```

**T1b — l'ancrage tient aussi pendant le transit.** C'est ce que garantit le §2.7, et c'est ce qui
distingue une bonne implémentation d'une implémentation qui « recale » à la fin.

```js
console.log('\n== T1b. L ancre tient pendant tout le transit ==');
{
  const PX = CX + 210, PY = CY + 130;
  await resetCam();
  await page.mouse.move(PX, PY);
  await wait(60);
  const anchor = await worldAtScreen(PX, PY);

  // On instrumente la boucle : a chaque frame on reprojette l'ancre.
  await page.evaluate((a) => {
    const g = window.game;
    const THREE = g.controls.target.constructor;
    window.__samples = [];
    window.__probe = new THREE(a.x, a.y, a.z);
    const orig = g.controls.update.bind(g.controls);
    window.__origUpdate = orig;
    g.controls.update = (dt) => {
      orig(dt);
      const v = window.__probe.clone().project(g.camera);
      window.__samples.push([(v.x * 0.5 + 0.5) * 1280, (-v.y * 0.5 + 0.5) * 800]);
    };
  }, anchor);

  for (let i = 0; i < 6; i++) await wheel(PX, PY, -100);
  await settle();

  const samples = await page.evaluate(() => {
    window.game.controls.update = window.__origUpdate;
    return window.__samples;
  });
  let worst = 0;
  for (const [x, y] of samples) worst = Math.max(worst, Math.hypot(x - PX, y - PY));
  check('T1b l ancre ne bouge pas pendant l amortissement', worst < 4 && samples.length > 8,
    `pire ecart ${worst.toFixed(2)} px sur ${samples.length} frames`);
}
```

#### T2 — une orbite complète revient au point de départ

Deux versions : une algébrique (le ressort et le déroulage d'angle sont-ils sains ?) et une
gestuelle (le glissement est-il exactement réversible ?).

```js
console.log('\n== T2. Une orbite complete est l identite ==');
{
  // --- version algebrique -------------------------------------------------
  await resetCam();
  const a = await camState();
  await page.evaluate(() => { window.game.controls.goalAzimuth += Math.PI * 2; });
  await settle(6000);
  const b = await camState();
  const dPos = Math.hypot(b.pos.x - a.pos.x, b.pos.y - a.pos.y, b.pos.z - a.pos.z);
  const dAz = Math.abs(((b.azimuth - a.azimuth) % (Math.PI * 2) + Math.PI * 3) % (Math.PI * 2) - Math.PI);
  check('T2 un tour complet ramene la camera au meme point', dPos < 0.001,
    `${(dPos * 1000).toFixed(3)} mm`);
  check('T2 l azimut est module a 2pi pres', dAz < 1e-5, `${dAz.toExponential(2)} rad`);
  check('T2 la distance et l elevation sont inchangees',
    Math.abs(b.distance - a.distance) < 1e-4 && Math.abs(b.polar - a.polar) < 1e-6,
    `dd=${(b.distance - a.distance).toExponential(2)}`);

  // --- version gestuelle : aller-retour au clic molette --------------------
  await resetCam();
  const c0 = await camState();
  await page.mouse.move(CX, CY);
  await page.mouse.down({ button: 'middle' });
  for (let i = 1; i <= 20; i++) await page.mouse.move(CX + i * 15, CY + i * 4);
  for (let i = 19; i >= 0; i--) await page.mouse.move(CX + i * 15, CY + i * 4);
  await page.mouse.up({ button: 'middle' });
  await settle(6000);      // laisse mourir l inertie
  const c1 = await camState();
  const back = Math.hypot(c1.pos.x - c0.pos.x, c1.pos.y - c0.pos.y, c1.pos.z - c0.pos.z);
  check('T2 un glissement aller-retour revient au depart', back < 0.004,
    `${(back * 1000).toFixed(2)} mm`);
}
```

> **Note sur l'inertie.** Sans elle, `back` serait nul à la précision machine. Avec, le
> relâchement au point d'arrivée a une vitesse résiduelle proche de zéro (le geste a ralenti en
> revenant), donc l'écart reste sous le seuil. **Ce test est donc aussi un test de l'inertie** :
> s'il échoue avec un écart de plusieurs centimètres, c'est que l'estimateur de vitesse utilise le
> dernier `Δpx/dt` au lieu d'une moyenne glissante (§4.4.1).

#### T3 — la caméra ne traverse jamais le terrain

On balaie tout l'espace des poses atteignables et on vérifie l'invariant à chaque pose. C'est un
test exhaustif, pas un échantillonnage : 720 poses couvrent 24 azimuts × 6 élévations × 5
distances.

```js
console.log('\n== T3. La camera ne traverse jamais le terrain ==');
{
  // On construit d'abord une tour bien haute : sans relief, le test ne prouve
  // rien. On empile du sable au centre.
  await page.evaluate(() => {
    const g = window.game, B = g.tools.brush;
    for (let i = 0; i < 22; i++) B.sphere(g.tools.ctx, 0, 1.6 + i * 0.05, 0, 0.55, +255, { hardness: 0.9 });
    g.field.flushColumns();
  });
  await wait(500);

  const report = await page.evaluate(() => {
    const g = window.game, c = g.controls;
    const save = {
      a: c.goalAzimuth, p: c.goalPolar, d: c.goalDistance,
      t: { x: c.goalTarget.x, y: c.goalTarget.y, z: c.goalTarget.z },
    };
    let worst = Infinity, worstPose = null, under = 0, n = 0;

    for (let ai = 0; ai < 24; ai++) {
      for (let pi = 0; pi < 6; pi++) {
        for (const dist of [1.4, 2.2, 4, 9, 20]) {
          // On force l'etat SANS amortissement : update(0) applique les buts.
          c.goalAzimuth = c.azimuth = (ai / 24) * Math.PI * 2;
          c.goalPolar = c.polar = c.minPolar + (pi / 5) * (c.maxPolar - c.minPolar);
          c.goalDistance = c.distance = dist;
          if (c._logD !== undefined) c._logD = Math.log(dist);
          c.goalTarget.set(0, 1.9, 0);
          c.target.copy(c.goalTarget);
          c.update(1 / 60);

          const P = g.camera.position;
          const h = g.field.surfaceHeightAt(P.x, P.z);
          const margin = P.y - h;
          n++;
          if (P.y < 0.25) under++;
          if (margin < worst) {
            worst = margin;
            worstPose = { az: c.azimuth, po: c.polar, d: dist, y: P.y, h };
          }
        }
      }
    }
    // Restauration
    c.goalAzimuth = c.azimuth = save.a;
    c.goalPolar = c.polar = save.p;
    c.goalDistance = c.distance = save.d;
    if (c._logD !== undefined) c._logD = Math.log(save.d);
    c.goalTarget.set(save.t.x, save.t.y, save.t.z);
    c.target.copy(c.goalTarget);
    c.update(0);
    return { worst, worstPose, under, n };
  });

  console.log(`  ${report.n} poses testees`);
  check('T3 la camera reste au-dessus du sable', report.worst > 0.20,
    `marge minimale ${(report.worst * 100).toFixed(1)} cm` +
    (report.worstPose ? ` (az=${report.worstPose.az.toFixed(2)} pol=${report.worstPose.po.toFixed(2)} d=${report.worstPose.d})` : ''));
  check('T3b la camera ne passe jamais sous le bloc', report.under === 0,
    `${report.under} pose(s) sous 0,25 m`);
}
```

#### T4 — le panoramique reste borné

On maltraite volontairement : 60 glissements aléatoires de très grande amplitude, aux deux
extrêmes de distance et d'élévation — c'est là que le facteur `1/cos θ` (§4.3) peut faire exploser
le déplacement.

```js
console.log('\n== T4. Le panoramique reste borne ==');
{
  const M = 1.2;                                // marge de clampTarget
  const LIM_XZ = 10.24 / 2 + M;                 // 6.32
  let escapes = 0, maxX = 0, maxZ = 0, minY = 99, maxY = -99;

  for (let trial = 0; trial < 60; trial++) {
    if (trial % 12 === 0) {
      await resetCam({
        distance: [1.4, 3, 9, 20, 34][(trial / 12) | 0],
        polar: [0.14, 0.5, 0.9076, 1.25, 1.42][(trial / 12) | 0],
      });
    }
    const dx = (Math.random() * 2 - 1) * 900;
    const dy = (Math.random() * 2 - 1) * 700;
    await page.keyboard.down('Shift');
    await page.mouse.move(CX, CY);
    await page.mouse.down({ button: 'middle' });
    await page.mouse.move(CX + dx * 0.5, CY + dy * 0.5);
    await page.mouse.move(CX + dx, CY + dy);
    await page.mouse.up({ button: 'middle' });
    await page.keyboard.up('Shift');

    const st = await page.evaluate(() => {
      const c = window.game.controls;
      return { gx: c.goalTarget.x, gy: c.goalTarget.y, gz: c.goalTarget.z };
    });
    maxX = Math.max(maxX, Math.abs(st.gx));
    maxZ = Math.max(maxZ, Math.abs(st.gz));
    minY = Math.min(minY, st.gy);
    maxY = Math.max(maxY, st.gy);
    if (Math.abs(st.gx) > LIM_XZ + 1e-6 || Math.abs(st.gz) > LIM_XZ + 1e-6) escapes++;
    if (st.gy < 0.2 - 1e-6 || st.gy > 3.2 + 1e-6) escapes++;
    if (!Number.isFinite(st.gx + st.gy + st.gz)) escapes += 100;
  }

  check('T4 la cible ne sort jamais de la boite', escapes === 0,
    `${escapes} echappee(s) ; |x|max=${maxX.toFixed(2)} |z|max=${maxZ.toFixed(2)} y∈[${minY.toFixed(2)};${maxY.toFixed(2)}]`);
  check('T4 la cible reste dans la marge autorisee', maxX <= LIM_XZ && maxZ <= LIM_XZ,
    `limite ${LIM_XZ.toFixed(2)} m`);

  await settle();
  const cam = await camState();
  check('T4 la camera reste a portee du diorama',
    Math.hypot(cam.pos.x, cam.pos.z) < 45 && cam.pos.y < 45,
    `(${cam.pos.x.toFixed(1)}, ${cam.pos.y.toFixed(1)}, ${cam.pos.z.toFixed(1)})`);
}
```

### 7.3 Les tests suivants

#### T5 — le zoom respecte ses limites

```js
console.log('\n== T5. Le zoom respecte ses limites ==');
{
  await resetCam();
  // On instrumente pour surveiller la distance a CHAQUE frame, pas seulement
  // a la fin : un depassement transitoire est un bug visible.
  await page.evaluate(() => {
    const c = window.game.controls;
    window.__dmin = Infinity; window.__dmax = -Infinity;
    window.__origUpdate = c.update.bind(c);
    c.update = (dt) => {
      window.__origUpdate(dt);
      window.__dmin = Math.min(window.__dmin, c.distance);
      window.__dmax = Math.max(window.__dmax, c.distance);
    };
  });

  for (let i = 0; i < 60; i++) await wheel(CX, CY, -100);
  await settle();
  const atMin = (await camState()).distance;
  for (let i = 0; i < 90; i++) await wheel(CX, CY, +100);
  await settle();
  const atMax = (await camState()).distance;

  const r = await page.evaluate(() => {
    window.game.controls.update = window.__origUpdate;
    return { dmin: window.__dmin, dmax: window.__dmax };
  });

  check('T5 la distance ne descend jamais sous le minimum', r.dmin >= 1.4 - 1e-6,
    `${r.dmin.toFixed(4)} m (min 1.4)`);
  check('T5 la distance ne depasse jamais le maximum', r.dmax <= 34 + 1e-6,
    `${r.dmax.toFixed(4)} m (max 34)`);
  check('T5 la borne basse est bien atteinte', Math.abs(atMin - 1.4) < 0.014,
    `${atMin.toFixed(3)} m`);
  check('T5 la borne haute est bien atteinte', Math.abs(atMax - 34) < 0.34,
    `${atMax.toFixed(2)} m`);
}
```

#### T6 — l'amortissement converge, sans dépassement

Un ressort **critiquement** amorti ne doit jamais dépasser. Si ce test rapporte un dépassement de
plus de 1 %, c'est que le facteur d'amortissement `ζ` est passé sous 1 quelque part.

```js
console.log('\n== T6. L amortissement converge sans depassement ==');
{
  await resetCam();
  const target = Math.PI * 0.78 + 1.0;   // 1 rad d ecart, franc
  const trace = await page.evaluate(async (goal) => {
    const c = window.game.controls;
    const t0 = performance.now();
    const samples = [];
    c.goalAzimuth = goal;
    return await new Promise((res) => {
      const orig = c.update.bind(c);
      c.update = (dt) => {
        orig(dt);
        samples.push([performance.now() - t0, c.azimuth]);
        if (performance.now() - t0 > 1500) { c.update = orig; res(samples); }
      };
    });
  }, target);

  const start = trace[0][1];
  const span = target - start;
  let t99 = null, over = 0;
  for (const [t, a] of trace) {
    const u = (a - start) / span;
    if (t99 === null && u >= 0.99) t99 = t;
    over = Math.max(over, u - 1);
  }
  check('T6 99 % du chemin en moins de 450 ms', t99 !== null && t99 < 450,
    t99 === null ? 'jamais atteint' : `${t99.toFixed(0)} ms`);
  check('T6 aucun depassement (ressort critique)', over < 0.01,
    `depassement ${(over * 100).toFixed(2)} %`);
  check('T6 le mouvement demarre en douceur (profil en cloche)',
    trace.length > 6 && Math.abs(trace[2][1] - start) < Math.abs(span) * 0.10,
    `${((trace[2][1] - start) / span * 100).toFixed(1)} % parcourus a la 3e frame`);
}
```

Le troisième `check` mérite une explication : c'est **le test qui distingue un ressort d'une
exponentielle**. Une décroissance exponentielle démarre à sa vitesse maximale et a déjà parcouru
~20 % du chemin en trois frames ; un ressort critique, dont le profil de vitesse est en cloche,
en a parcouru moins de 10 %. Si ce test passe pour l'exponentielle, c'est que la demi-vie est trop
courte et que le mouvement claque.

#### T7 — la sensation ne dépend pas du framerate

Celui-là n'a pas besoin de navigateur : `DioramaControls.update()` est du calcul pur. On le teste
en Node, ce qui le rend rapide et déterministe. **Les chiffres ci-dessous ont été mesurés sur
l'implémentation du §8**, pas estimés.

Deux régimes, avec deux seuils très différents, et c'est le point important :

| Entrée | Ce qu'on prouve | Seuil | Mesuré |
|---|---|---|---|
| **Échelon** (le but saute une fois) | Le ressort est intégré **exactement** : la cadence n'a strictement aucun effet | azimut < 1e-6 ; distance < 1e-4 | **9,4e-14** et **3,2e-9** |
| **Rampe** (le but glisse en continu) | Aucune dépendance grossière | < 2,5 % | **0,82 %** et **2,0 %** |

Pourquoi la rampe n'atteint **pas** 1e-6, et pourquoi ce n'est pas un bug : entre deux appels à
`update()`, le but est supposé **constant** (bloqueur d'ordre zéro). Un but qui glisse est donc
échantillonné 60 fois à 30 img/s et 240 fois à 120 img/s, et cette discrétisation introduit une
erreur en `O(dt)` **quelle que soit la qualité de l'intégrateur**. Exiger 0,5 % sur une rampe
ferait échouer un code parfaitement correct. C'est l'échelon qui teste l'intégrateur ; la rampe ne
teste que l'absence de catastrophe.

Le résidu non nul en échelon a lui aussi une cause identifiée : `fastNegExp` est une
approximation de Padé de `e^(−x)`, et composer N petites approximations n'égale pas exactement une
grande. À 6 m de distance, 3,2e-9 représente **19 nanomètres**. C'est le prix de la stabilité
inconditionnelle, et c'est un très bon prix.

Anecdote instructive : avec la version *lente* du ressort (`y = ln2/H`, l'erreur d'étalonnage
décrite au §4.1.2), ce même résidu valait **3,5e-6**, soit trois ordres de grandeur de plus — non
pas parce que l'intégrateur était moins bon, mais parce que la convergence n'était pas achevée au
bout de la fenêtre de 1,5 s et que le régime transitoire était encore mesurable. Le test T7 a donc
détecté le défaut d'étalonnage du §4.1.2 avant qu'on ne le cherche.

```js
/**
 * T7 — independance au framerate.
 *
 * On rejoue EXACTEMENT le meme geste (meme duree simulee, memes entrees) a
 * deux cadences differentes et on compare l'etat final. Si le code contient un
 * `x += (g-x)*k` avec k fixe, l'ecart depasse 30 % des la rampe.
 *
 *   node tools/test-camera-unit.mjs
 */

// --- Environnement navigateur minimal --------------------------------------
// DioramaControls pose des ecouteurs sur window/document et interroge
// matchMedia des le constructeur. Sans ces bouchons, le test ne demarre pas.
const noop = () => {};
globalThis.window = {
  addEventListener: noop, removeEventListener: noop,
  devicePixelRatio: 1,
  matchMedia: () => ({ matches: false, addEventListener: noop, removeEventListener: noop }),
};
globalThis.document = { addEventListener: noop, removeEventListener: noop, hidden: false };
// Node >= 21 expose deja `navigator` en lecture seule : ne pas l'ecraser.

import * as THREE from 'three';
import { DioramaControls } from '../src/render/DioramaControls.js';

let failures = 0;
function check(name, ok, detail = '') {
  console.log(`  ${ok ? 'OK  ' : 'FAIL'} ${name}${detail ? '  ' + detail : ''}`);
  if (!ok) failures++;
}

function makeControls() {
  const cam = new THREE.PerspectiveCamera(32, 1.6, 0.05, 120);
  const dom = {                                   // canevas minimal
    clientWidth: 1280, clientHeight: 800, style: {},
    addEventListener: noop, removeEventListener: noop,
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 1280, height: 800 }),
  };
  const c = new DioramaControls(cam, dom);
  c.field = null;                                 // pas de terrain : calcul pur
  return c;
}

// --- a) ECHELON : le test strict -------------------------------------------
function runStep(fps) {
  const c = makeControls();
  c.goalAzimuth = Math.PI * 0.78 + 1.0;
  c.goalDistance = 6.0;
  const dt = 1 / fps, steps = Math.round(1.5 / dt);
  for (let i = 0; i < steps; i++) c.update(dt);
  return { a: c.azimuth, d: c.distance };
}
{
  const a = runStep(30), b = runStep(120), m = runStep(61.7);   // 61,7 : cadence batarde
  const rA = Math.abs(a.a - b.a) / Math.abs(b.a);
  const rD = Math.abs(a.d - b.d) / b.d;
  const rM = Math.abs(m.d - b.d) / b.d;
  check('T7 echelon : azimut identique a 30 et 120 img/s', rA < 1e-6, rA.toExponential(2));
  check('T7 echelon : distance identique a 30 et 120 img/s', rD < 1e-4, rD.toExponential(2));
  check('T7 echelon : idem a une cadence non entiere (61,7)', rM < 1e-4, rM.toExponential(2));
}

// --- b) RAMPE : le test de non-catastrophe ---------------------------------
function runRamp(fps) {
  const c = makeControls();
  const dt = 1 / fps, steps = Math.round(2 / dt);
  for (let i = 0; i < steps; i++) {
    const t = i * dt;
    // Le geste est exprime en fonction du TEMPS, pas du numero de frame.
    if (t < 1) {
      c.goalAzimuth = Math.PI * 0.78 + t * 1.2;
      c.goalDistance = 15.5 * Math.exp(-t * 0.8);
    }
    c.update(dt);
  }
  return { a: c.azimuth, d: c.distance };
}
{
  const a = runRamp(30), b = runRamp(120);
  const rA = Math.abs(a.a - b.a) / Math.abs(b.a);
  const rD = Math.abs(a.d - b.d) / b.d;
  check('T7 rampe : azimut a 2,5 % pres entre 30 et 120 img/s', rA < 0.025,
    `${(rA * 100).toFixed(3)} %  (${a.a.toFixed(5)} vs ${b.a.toFixed(5)})`);
  check('T7 rampe : distance a 2,5 % pres', rD < 0.025,
    `${(rD * 100).toFixed(3)} %  (${a.d.toFixed(5)} vs ${b.d.toFixed(5)})`);
}

// --- c) Robustesse : un dt aberrant ne teleporte pas ------------------------
{
  const c = makeControls();
  c.goalAzimuth = 10;
  c.update(0.8);                                  // pause GC de 800 ms
  check('T7 un dt aberrant est bride', Math.abs(c.azimuth) < 6 && Number.isFinite(c.azimuth),
    `azimut ${c.azimuth.toFixed(3)} (bride a dt = 1/20 s)`);
}

// --- d) Invariance du zoom ancre, en calcul pur ----------------------------
// Sans terrain, l'ancre tombe sur le plan y = target.y : c'est le repli n° 2.
// L'invariance doit etre EXACTE, puisqu'aucun clamp ne mord ici.
{
  const c = makeControls();
  const PX = 900, PY = 250;
  c.update(0);
  c._latchAnchor(PX, PY);
  const before = c._anchor.clone().project(c.camera);
  for (let i = 0; i < 5; i++) c.zoomAt(PX, PY, -1);
  for (let i = 0; i < 400; i++) c.update(1 / 60);
  const after = c._anchor.clone().project(c.camera);
  const err = Math.hypot((after.x - before.x) * 640, (after.y - before.y) * 400);
  check('T7d le zoom ancre est exact hors navigateur', err < 0.5, `${err.toFixed(4)} px`);
  check('T7d le zoom a bien eu lieu', c.distance < 8.5 && c.distance > 7.5,
    `${c.distance.toFixed(3)} m (attendu 15,5 x e^-0,65 = 8,09)`);
}

process.exit(failures ? 1 : 0);
```

**Sortie réelle de ce test sur l'implémentation du §8 :**

```
  OK   T7 echelon : azimut identique a 30 et 120 img/s   9.42e-14
  OK   T7 echelon : distance identique a 30 et 120 img/s 3.22e-9
  OK   T7 echelon : idem a une cadence non entiere (61,7) 9.86e-9
  OK   T7 rampe : azimut a 2,5 % pres entre 30 et 120 img/s   0.824 %
  OK   T7 rampe : distance a 2,5 % pres                       2.008 %
  OK   T7 un dt aberrant est bride   azimut 3.123 (bride a dt = 1/20 s)
  OK   T7d le zoom ancre est exact hors navigateur   0.0000 px
  OK   T7d le zoom a bien eu lieu   8.092 m (attendu 15,5 x e^-0,65 = 8,09)
```

**Ordre de grandeur si le bug est présent.** Avec `k = 0,16` fixe par frame et 2 s de simulation,
30 img/s effectue 60 pas et 120 img/s en effectue 240 : l'erreur résiduelle vaut `0,84⁶⁰ = 3,6e-5`
d'un côté et `0,84²⁴⁰ = 1,7e-18` de l'autre. Sur le régime transitoire, l'écart dépasse **30 %** en
milieu de geste — soit plus de dix fois le seuil de la rampe, et huit ordres de grandeur au-dessus
du seuil de l'échelon. Le test discrimine sans ambiguïté.

#### T8 — le panoramique « colle » au sol

C'est le test de la méthode exacte du §4.3.2. On attrape un point du sol au centre de l'écran, on
glisse en vingt incréments comme un vrai geste, et on vérifie que le point attrapé est arrivé sous
le curseur. Le critère est **0,5 px**, pas 4 : la méthode exacte donne 0,000 px, il n'y a aucune
raison d'être indulgent.

```js
console.log('\n== T8. Le panoramique colle au sol ==');
{
  const LIM = 10.24 / 2 + 1.2 - 1e-3;
  for (const polar of [0.5, 0.9076, 1.2, 1.40]) {
    await resetCam({ polar, distance: 9 });

    // On travaille sur le PLAN y = target.y (celui du panoramique), pas sur le
    // terrain : c'est ce plan-la que la methode exacte epingle.
    const Y = (await camState()).target.y;
    const p0 = await planeAtScreen(CX, CY, Y);
    if (!p0) continue;

    // Vingt increments, avec un settle entre chaque : on reproduit un geste
    // reel, et on verifie du meme coup que le geste est auto-correcteur.
    let px = CX, py = CY;
    await page.keyboard.down('Shift');
    await page.mouse.move(CX, CY);
    await page.mouse.down({ button: 'middle' });
    for (let i = 1; i <= 20; i++) {
      const nx = CX + (180 * i) / 20, ny = CY - (140 * i) / 20;
      await page.mouse.move(nx, ny);
      px = nx; py = ny;
    }
    await page.mouse.up({ button: 'middle' });
    await page.keyboard.up('Shift');
    await settle();

    const st = await camState();
    const clamped = Math.abs(st.target.x) >= LIM || Math.abs(st.target.z) >= LIM;
    const s = await projectToScreen(p0);
    const err = Math.hypot(s.x - (CX + 180), s.y - (CY - 140));
    const elev = (90 - (polar * 180) / Math.PI).toFixed(0);

    // A 10 deg d'elevation, 230 px de glissement demandent 13 m au sol : plus
    // que la largeur du domaine. clampTarget mord, et c'est VOULU.
    check(`T8 le sol suit le curseur (elevation ${elev} deg)`, err < 0.5 || clamped,
      `${err.toFixed(4)} px${clamped ? ' (cible bridee : comportement attendu)' : ''}`);
  }
}

// --- T8b : le SENS de l'axe vertical --------------------------------------
// Le bug D3 est d'abord un bug de signe. Ce test-la seul le detecte, et il ne
// coute rien.
console.log('\n== T8b. Le sens du panoramique vertical ==');
{
  await resetCam({ polar: 0.9076, distance: 9 });
  const Y = (await camState()).target.y;
  const p0 = await planeAtScreen(CX, CY, Y);
  await page.keyboard.down('Shift');
  await page.mouse.move(CX, CY);
  await page.mouse.down({ button: 'middle' });
  await page.mouse.move(CX, CY - 70);
  await page.mouse.move(CX, CY - 140);
  await page.mouse.up({ button: 'middle' });
  await page.keyboard.up('Shift');
  await settle();
  const s = await projectToScreen(p0);
  check('T8b glisser vers le haut fait MONTER le sol', s.y < CY - 100,
    `y ${CY} -> ${s.y.toFixed(1)} (attendu ${CY - 140})`);
  check('T8b l axe horizontal garde le meme sens', Math.abs(s.x - CX) < 2,
    `x ${CX} -> ${s.x.toFixed(1)}`);
}
```

avec le helper correspondant, à ajouter aux autres :

```js
/** Point du plan horizontal y = Y sous un pixel donne. */
async function planeAtScreen(x, y, Y) {
  return page.evaluate(({ x, y, Y, W, H }) => {
    const g = window.game;
    const THREE = g.tools.raycaster.constructor;
    const r = new THREE();
    r.setFromCamera({ x: (x / W) * 2 - 1, y: -(y / H) * 2 + 1 }, g.camera);
    const o = r.ray.origin, d = r.ray.direction;
    if (Math.abs(d.y) < 1e-6) return null;
    const t = (Y - o.y) / d.y;
    if (!(t > 0)) return null;
    return { x: o.x + d.x * t, y: Y, z: o.z + d.z * t };
  }, { x, y, Y, W, H });
}
```

#### T9 — la molette est normalisée

```js
console.log('\n== T9. Normalisation de la molette ==');
{
  const cases = [
    ['souris Chrome/Windows', { deltaY: -100, deltaMode: 0 }],
    ['souris Firefox (lignes)', { deltaY: -2.5, deltaMode: 1 }],   // -2.5 * 40 = -100 px
    ['souris Chrome/macOS', { deltaY: -4.000244140625 * 25, deltaMode: 0 }],
  ];
  const ratios = [];
  for (const [label, ev] of cases) {
    await resetCam();
    await wheel(CX, CY, ev.deltaY, { deltaMode: ev.deltaMode });
    await settle();
    const st = await camState();
    const r = st.distance / 15.5;
    ratios.push(r);
    console.log(`  ${label.padEnd(26)} d 15.50 -> ${st.distance.toFixed(3)} m  (k=${r.toFixed(4)})`);
  }
  const lo = Math.min(...ratios), hi = Math.max(...ratios);
  check('T9 les trois deltaMode donnent le meme zoom', (hi - lo) / lo < 0.12,
    `dispersion ${(((hi - lo) / lo) * 100).toFixed(1)} %`);

  // --- Un pincement (ctrlKey sans Ctrl physique) doit zoomer, pas changer le rayon.
  await resetCam();
  const rBefore = await page.evaluate(() => window.game.tools.radius);
  await wheel(CX, CY, -6, { deltaMode: 0, ctrlKey: true });
  await settle();
  const st = await camState();
  const rAfter = await page.evaluate(() => window.game.tools.radius);
  check('T9 le pincement zoome', st.distance < 15.49, `${st.distance.toFixed(3)} m`);
  check('T9 le pincement ne touche pas au rayon de brosse',
    Math.abs(rAfter - rBefore) < 1e-6, `${rBefore.toFixed(4)} -> ${rAfter.toFixed(4)}`);

  // --- Un VRAI Ctrl+molette doit regler le rayon, pas zoomer.
  await resetCam();
  const r2 = await page.evaluate(() => window.game.tools.radius);
  await page.keyboard.down('Control');
  await wheel(CX, CY, -100, { deltaMode: 0, ctrlKey: true });
  await page.keyboard.up('Control');
  await settle();
  const st2 = await camState();
  const r3 = await page.evaluate(() => window.game.tools.radius);
  check('T9 Ctrl+molette regle le rayon', Math.abs(r3 - r2) > 1e-4,
    `${r2.toFixed(4)} -> ${r3.toFixed(4)}`);
  check('T9 Ctrl+molette ne zoome pas', Math.abs(st2.distance - 15.5) < 1e-3,
    `${st2.distance.toFixed(4)} m`);
}
```

#### T10 — le roulis reste nul

> **Attention à la méthode de mesure.** La tentation est de projeter deux points séparés
> verticalement dans le monde et de regarder l'inclinaison du segment obtenu. C'est **mal
> conditionné** : près du zénith, l'axe `Y` du monde se projette sur un segment de quelques pixels,
> et la direction mesurée est dominée par le bruit numérique. Le test rapporte alors des
> inclinaisons de 90° sur une caméra dont le roulis est rigoureusement nul.
>
> La bonne mesure est directe : le roulis est l'inclinaison du vecteur **droite** de la caméra
> par rapport à l'horizontale, soit `asin(|right.y|)`. `right` est la première colonne de
> `matrixWorld`, donc `elements[1]` en est la composante `y`. Bien conditionné partout, y compris
> au zénith.

```js
console.log('\n== T10. Aucun roulis ==');
{
  let worst = 0, worstPose = null;
  for (let i = 0; i < 48; i++) {
    await resetCam({
      azimuth: (i / 48) * Math.PI * 2,
      polar: 0.12 + (i % 8) * 0.16,
      distance: 1.4 + (i % 5) * 8,
    });
    const roll = await page.evaluate(() => {
      const e = window.game.camera.matrixWorld.elements;   // colonne X = right
      return (Math.asin(Math.min(1, Math.abs(e[1]))) * 180) / Math.PI;
    });
    if (roll > worst) { worst = roll; worstPose = i; }
  }
  // Le roulis n'est pas "petit", il est NUL par construction : le vecteur
  // droite est un produit vectoriel avec +Y, donc perpendiculaire a Y. On peut
  // donc exiger la precision machine, et pas une tolerance de confort.
  check('T10 le roulis est nul a la precision machine', worst < 1e-9,
    `${worst.toExponential(2)} deg (pose ${worstPose} sur 48)`);
}
```

Ce test a une valeur particulière : il ne peut échouer que si quelqu'un a écrit dans `camera.up`,
ou remplacé le paramétrage `(azimut, polaire)` par des quaternions. C'est donc un **test de
non-régression architecturale** plus qu'un test numérique — et c'est exactement pour ça qu'il
mérite un seuil à la précision machine plutôt qu'à 0,25°.

#### T11 — les commandes de recadrage

```js
console.log('\n== T11. Recadrage : F, R, T, A ==');
{
  // --- F : focus sur le point sous le curseur -----------------------------
  await resetCam();
  const PX = CX - 230, PY = CY + 90;
  await page.mouse.move(PX, PY);
  await wait(60);
  const p = await worldAtScreen(PX, PY);
  await page.keyboard.press('KeyF');
  await settle(4000);
  const st = await camState();
  const d = p ? Math.hypot(st.target.x - p.x, st.target.y - p.y, st.target.z - p.z) : 99;
  check('T11 F centre sur le point vise', d < 0.03, `${(d * 100).toFixed(1)} cm`);

  // --- R : retour a la vue diorama ----------------------------------------
  await page.keyboard.press('KeyR');
  await settle(4000);
  const r = await camState();
  const ok = Math.abs(r.distance - 15.5) < 1e-2
          && Math.abs(r.polar - 0.9076) < 1e-3
          && Math.hypot(r.target.x + 0.3, r.target.z + 0.3) < 1e-2;
  check('T11 R restaure exactement la vue diorama', ok,
    `d=${r.distance.toFixed(3)} pol=${r.polar.toFixed(4)} cible=(${r.target.x.toFixed(3)},${r.target.z.toFixed(3)})`);

  // --- T : vue de dessus --------------------------------------------------
  await page.keyboard.press('KeyT');
  await settle(4000);
  const t = await camState();
  check('T11 T passe en vue zenithale', t.polar < 0.01, `polar=${t.polar.toFixed(4)}`);
  const above = await page.evaluate(() => {
    const g = window.game;
    return g.camera.position.y > 5 && Math.hypot(g.camera.position.x - g.controls.target.x,
                                                 g.camera.position.z - g.controls.target.z) < 0.05;
  });
  check('T11 la camera est bien a l aplomb de la cible', above);
  await page.keyboard.press('KeyT');
  await settle(4000);
  const back = await camState();
  check('T11 T restaure l elevation precedente', Math.abs(back.polar - 0.9076) < 1e-2,
    `polar=${back.polar.toFixed(4)}`);

  // --- Tout voir ----------------------------------------------------------
  await page.evaluate(() => window.game.controls.frameAll());
  await settle(4000);
  const f = await camState();
  const R = Math.hypot(5.12, 5.12, 1.1);
  const expect = (R * 1.08) / Math.sin((32 * Math.PI / 180) / 2);
  check('T11 "tout voir" cadre la sphere englobante',
    Math.abs(f.distance - Math.min(expect, 34)) < 0.5,
    `${f.distance.toFixed(2)} m (attendu ${Math.min(expect, 34).toFixed(2)})`);
  // Verification independante : les 8 coins du bloc sont dans le champ.
  const allVisible = await page.evaluate(() => {
    const g = window.game;
    const THREE = g.controls.target.constructor;
    for (const x of [-5.12, 5.12]) for (const z of [-5.12, 5.12]) for (const y of [0, 2]) {
      const v = new THREE(x, y, z).project(g.camera);
      if (Math.abs(v.x) > 1 || Math.abs(v.y) > 1 || v.z > 1) return false;
    }
    return true;
  });
  check('T11 les 8 coins du bloc sont visibles', allVisible);
}
```

#### T12 — santé générale

```js
console.log('\n== T12. Sante generale ==');
{
  const perf = await page.evaluate(() => {
    const c = window.game.controls;
    // 600 appels a update() avec une cible qui bouge : cas le plus charge
    // (ressorts + collision terrain + suivi de hauteur).
    c.goalAzimuth += 3;
    const t0 = performance.now();
    for (let i = 0; i < 600; i++) c.update(1 / 60);
    return (performance.now() - t0) / 600;
  });
  check('T12 update() reste sous 0,35 ms', perf < 0.35, `${perf.toFixed(3)} ms/appel`);

  const gl = await page.evaluate(() => window.game.renderer.getContext().getError());
  check('T12 aucune erreur WebGL', gl === 0, 'code ' + gl);
  check('T12 aucune erreur JavaScript', errors.length === 0, errors.slice(0, 3).join(' | '));

  const leaks = await page.evaluate(() => {
    // dispose() doit tout retirer : on compte les listeners restants via un
    // compteur maintenu par la classe.
    const c = window.game.controls;
    return typeof c._listeners === 'object' ? c._listeners.length : -1;
  });
  check('T12 les ecouteurs sont traces pour dispose()', leaks >= 0,
    leaks < 0 ? 'aucun registre de listeners' : `${leaks} enregistres`);
}

const buf = await page.screenshot({ type: 'png' });
writeFileSync(join(OUT, 'camera.png'), buf);
console.log('\n  capture : shots/camera.png');

await browser.close();
console.log(failures === 0 ? '\nTous les tests de camera passent.\n'
                           : `\n${failures} test(s) en echec.\n`);
process.exit(failures ? 1 : 0);
```

### 7.4 Ce que ces tests attrapent réellement

Vérification que chaque défaut du §1 est couvert :

| Défaut | Test qui l'attrape | Valeur mesurée avec le code actuel |
|---|---|---|
| D1 zoom au centre | **T1** | erreur ≈ **300 px** au lieu de 2,5 |
| D2 `deltaY` brut | **T9** | dispersion ≈ **3200 %** au lieu de 12 |
| D3 pan inversé et sous-compensé | **T8** et **T8b** | erreur de **234 à 335 px** selon l'élévation, et l'axe vertical part **dans le mauvais sens** |
| D4 pas de collision | **T3** | marge **négative** (caméra sous le sable) |
| D5 vitesse clavier | non couvert par un test automatique — vérification manuelle | — |
| D6 lerp linéaire de la distance | **T6** troisième `check`, et T1b (profil du transit) | — |
| Étalonnage du ressort (§4.1.2) | **T6** premier `check` | **683 ms** pour 99 % au lieu de 350 |
| D7 recadrages absents | **T11** | `F`, `R`, `T` sans effet |
| D8 bornes | **T3**, **T5** | `maxPolar` trop permissif |
| D9 tactile | non couvert (Puppeteer n'émule pas bien le multi-touch) — test manuel sur tablette | — |
| D10 fuite d'écouteurs | **T12** | pas de registre |
| D11 amortissement illisible | **T6**, **T7** | passe déjà (la correction de framerate est correcte) |

Deux zones grises assumées :

- **Le tactile** (D9). `page.touchscreen` de Puppeteer ne gère qu'un doigt. Émuler un pincement
  demande d'envoyer des `Input.dispatchTouchEvent` via CDP avec deux points, ce qui est faisable
  mais fragile. On préfère un test manuel documenté dans une check-list, plus un test unitaire de
  `_readGesture()` en Node (calcul pur, facile à couvrir).
- **La sensation elle-même.** Aucun test ne dira que la caméra est agréable. Les tests garantissent
  qu'elle est **correcte** ; le réglage des demi-vies se fait à la main, et c'est pour ça qu'elles
  sont exposées dans les options.

### 7.5 Deux tests de non-régression à ajouter aux tests existants

`tools/test-play.mjs` sculpte pendant que la caméra tourne. Deux invariants supplémentaires y ont
leur place, parce qu'ils concernent la **cohabitation** outil/caméra :

```js
// A ajouter dans test-play.mjs
check('la molette nue ne declenche jamais un coup d outil',
  (await page.evaluate(() => window.game.tools.stroke)) === null);

check('Alt+clic gauche n a pas creuse',
  Math.abs(afterAltDrag.surface - beforeAltDrag.surface) < 0.002,
  `${((afterAltDrag.surface - beforeAltDrag.surface) * 100).toFixed(2)} cm`);
```

Le second est important : `ToolManager.onDown` fait bien `if (e.altKey) return;`, mais rien ne
protège le cas `Espace` (§6). Le test le verrouille.

---

## 8. Le fichier complet

Voici `src/render/DioramaControls.js` réécrit. Il est autonome, n'ajoute aucune dépendance, et
respecte l'API existante (`update(dt)`, `focus(x,y,z,d)`, `dispose()`, `autoRotate`, `enabled`,
`target`, `azimuth`, `polar`, `distance`).

```js
/**
 * Controles camera "diorama".
 *
 * Orbite critiquement amortie autour d'une cible posee sur la plage, avec
 * ZOOM ANCRE SUR LE CURSEUR : le point du monde sous la souris ne bouge pas
 * d'un pixel pendant le zoom (voir docs/RECHERCHE-CAMERA.md §2).
 *
 * Les DEUX boutons de souris appartiennent aux outils. La camera vit donc sur :
 *   - molette (roulement)        : zoom ancre                (Ctrl+molette = rayon)
 *   - clic molette (glissement)  : orbite   / +Maj : panoramique
 *   - Alt + clic gauche          : orbite   / +Maj : panoramique
 *   - Espace maintenu            : mode camera temporaire (tout peripherique)
 *   - deux/trois doigts          : pincement-zoom, panoramique, orbite
 *   - W A S D / fleches, Q E, +/- , F, R, T
 *
 * Le champ de vision est etroit (~32 deg) : c'est ce qui donne la lecture
 * "maquette" de la reference, et c'est aussi ce qui rend le zoom ancre
 * indispensable — a 32 deg, un point a 300 px du centre sort du champ en
 * trois crans de molette si on zoome vers le centre.
 */

import * as THREE from 'three';
import { WORLD_W, WORLD_D, WORLD_H, clamp } from '../core/Config.js';

// --- geometrie ---------------------------------------------------------------
const TAU = Math.PI * 2;
const DEG2RAD = Math.PI / 180;

/** Elevation max : 83 deg. En dessous de 0,05 rad l'orbite "spinne" au zenith. */
const MIN_POLAR = 0.12;
/** Elevation min : 8 deg. Sous cet angle le bloc est vu par la tranche. */
const MAX_POLAR = Math.PI / 2 - 0.14;

const MIN_DISTANCE = 1.4;
const MAX_DISTANCE = 34;

/** Vue de depart. Elevation 38 deg = l'angle iso classique du diorama. */
const HOME = {
  azimuth: Math.PI * 0.78,
  polar: 0.9076,
  distance: 15.5,
  target: new THREE.Vector3(-0.3, 1.35, -0.3),
};

// --- sensation ---------------------------------------------------------------
/** Demi-vies, en secondes. C'est le seul parametrage lisible d'un amortissement. */
const H_ORBIT = 0.070;
const H_PAN = 0.070;
const H_ZOOM = 0.110;
const H_FRAME = 0.150;

/** Inertie d'orbite : lambda en s^-1 (demi-vie 139 ms). */
const INERTIA_LAMBDA = 5.0;
const INERTIA_MIN = 120;    // px/s : en dessous, un clic bref ne lance rien
const INERTIA_MAX = 2500;   // px/s : clamp anti-echantillon aberrant

/** Vitesse de deplacement clavier, en fractions de la distance par seconde. */
const KEY_PAN_RATE = 0.9;
const KEY_ORBIT_RATE = 1.6;
/** Pas de l'orbite discrete (Q/E) : 16 positions par tour, 4 vues cardinales. */
const ORBIT_STEP = Math.PI / 8;

/** Plafond du gain 1/cos(polar) du panoramique (elevation 14,5 deg). */
const PAN_LIFT_MAX = 4;

// --- zoom --------------------------------------------------------------------
/** Un cran = exp(0.13) = 1,139. 5,3 crans pour doubler la distance. */
const ZOOM_PER_NOTCH = 0.13;
const NOTCH_PX = 100;              // souris a crans
const TRACKPAD_PX_PER_NOTCH = 60;  // deux doigts
const PINCH_PX_PER_NOTCH = 24;     // pincement
const LINE_HEIGHT = 40;
const PAGE_HEIGHT = 800;

/** Verrouillage de l'ancre pendant une rafale de molette. */
const ANCHOR_HOLD = 180;   // ms sans evenement avant de reprendre une ancre
const ANCHOR_SLOP = 12;    // px de deplacement curseur avant de reprendre une ancre
const ANCHOR_MARGIN = 1.6; // m : l'ancre ne sort pas de la boite + marge

/** Rappel de la cible vers le centre en zoom arriere. */
const RECENTER_GAIN = 0.55;

// --- garde-fous --------------------------------------------------------------
const GROUND_FLOOR = 0.25;   // m : la camera ne descend jamais sous le bloc
const CLEARANCE = 0.28;      // m : marge au-dessus du sable
const ARM_SAMPLES = 6;

const IS_FIREFOX = typeof navigator !== 'undefined' && /firefox/i.test(navigator.userAgent);
const IS_IOS = typeof navigator !== 'undefined'
  && (/iPad|iPhone|iPod/.test(navigator.userAgent)
      || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1));

// =============================================================================
// OUTILS MATHEMATIQUES
// =============================================================================

/** Approximation de Pade de e^-x. Monotone, bornee, jamais negative. */
function fastNegExp(x) {
  return 1 / (1 + x + 0.48 * x * x + 0.235 * x * x * x);
}

/**
 * Ressort critiquement amorti, integration EXACTE en une passe.
 *
 * C'est le meme algorithme que Mathf.SmoothDamp d'Unity (Game Programming
 * Gems 4, ch. 1.10), reparametre par la demi-vie plutot que par smoothTime :
 * smoothTime = halflife / ln2.
 *
 * La vitesse est un ETAT (s.v). C'est ce qui rend le mouvement C1 : quand le
 * but saute — a chaque cran de molette, a chaque appui sur F — la camera
 * accelere depuis sa vitesse actuelle au lieu de claquer.
 *
 * @param {{x:number, v:number}} s   etat {position, vitesse}
 * @param {number} goal
 * @param {number} halflife  secondes ; 0 = snap (mode "mouvement reduit")
 * @param {number} dt        secondes
 */
function spring(s, goal, halflife, dt) {
  if (halflife <= 1e-5 || dt <= 0) { s.x = goal; s.v = 0; return s.x; }
  // y = 2*ln2/H, et non ln2/H : le terme (1 + y*t) de la solution critique
  // ralentit la convergence, et ce facteur 2 le compense pour que la demi-vie
  // d'un ressort SE RESSENTE comme celle d'un amortisseur du premier ordre.
  // (C'est la convention de Holden : damping = 4*ln2/H, y = damping/2.)
  const y = (2 * Math.LN2) / halflife;
  const j0 = s.x - goal;
  const j1 = s.v + j0 * y;
  const e = fastNegExp(y * dt);
  s.x = e * (j0 + j1 * dt) + goal;
  s.v = e * (s.v - j1 * y * dt);
  return s.x;
}

/** Ecart angulaire le plus court, dans (-pi, pi]. */
function shortestDelta(a0, a1) {
  return (((a1 - a0 + Math.PI) % TAU) + TAU) % TAU - Math.PI;
}

/** Hermite C2 : vitesse ET acceleration nulles aux deux bornes. */
function smootherstep(x) {
  return x * x * x * (x * (6 * x - 15) + 10);
}

/**
 * Distance perspective pour qu'une sphere de rayon R tienne dans le viewport.
 * `sin` et non `tan` : la sphere est TANGENTE aux plans du frustum. Avec `tan`
 * on serait 3,9 % trop pres a 32 deg et les coins du bloc seraient rognes.
 * En portrait (aspect < 1) c'est l'horizontale qui contraint.
 */
function distanceToFitSphere(R, fovYdeg, aspect, pad = 0.08) {
  const tv = Math.tan((fovYdeg * DEG2RAD) / 2);
  const fovEff = 2 * Math.atan(Math.min(tv, tv * aspect));
  return (R * (1 + pad)) / Math.sin(fovEff / 2);
}

const RHO = Math.SQRT2, RHO2 = 2, RHO4 = 4;
/**
 * Duree "naturelle" d'une transition, d'apres la geodesique de Van Wijk & Nuij
 * dans l'espace (pan, zoom). On l'alimente avec :
 *    u = position du pivot,  w = largeur monde au pivot = 2*d*tan(fov/2).
 * Bonus gratuit : quand les deux points de vue sont eloignes, le chemin
 * optimal dezoome de lui-meme en milieu de course.
 */
function vanWijkDuration(T0, d0, T1, d1, fovYdeg, V = 1.0) {
  const k = 2 * Math.tan((fovYdeg * DEG2RAD) / 2);
  const w0 = k * d0, w1 = k * d1;
  const dist = Math.hypot(T1.x - T0.x, T1.y - T0.y, T1.z - T0.z);
  let S;
  if (dist < 1e-9) {
    S = Math.abs(Math.log(w1 / w0)) / RHO;
  } else {
    const d2 = dist * dist;
    const b0 = (w1 * w1 - w0 * w0 + RHO4 * d2) / (2 * w0 * RHO2 * dist);
    const b1 = (w1 * w1 - w0 * w0 - RHO4 * d2) / (2 * w1 * RHO2 * dist);
    S = (Math.log(Math.sqrt(b1 * b1 + 1) - b1) - Math.log(Math.sqrt(b0 * b0 + 1) - b0)) / RHO;
  }
  return clamp(S / V, 0.22, 0.90);
}

// =============================================================================
export class DioramaControls {
  /**
   * @param {THREE.PerspectiveCamera} camera
   * @param {HTMLElement} dom
   */
  constructor(camera, dom) {
    this.camera = camera;
    this.dom = dom;
    /** Champ voxel, injecte par Game apres generation du terrain. */
    this.field = null;
    /** Callback pour la molette qui n'est pas du zoom (rayon de brosse). */
    this.onToolWheel = null;
    /** Callback pour activer/desactiver les outils (mode camera temporaire). */
    this.setToolsEnabled = null;

    // --- etat ----------------------------------------------------------------
    this.target = HOME.target.clone();
    this.goalTarget = HOME.target.clone();
    this.azimuth = this.goalAzimuth = HOME.azimuth;
    this.polar = this.goalPolar = HOME.polar;
    this.distance = this.goalDistance = HOME.distance;

    this.minDistance = MIN_DISTANCE;
    this.maxDistance = MAX_DISTANCE;
    this.minPolar = MIN_POLAR;
    this.maxPolar = MAX_POLAR;

    // --- ressorts ------------------------------------------------------------
    this._sA = { x: this.azimuth, v: 0 };
    this._sP = { x: this.polar, v: 0 };
    this._sD = { x: Math.log(this.distance), v: 0 };   // espace log !
    this._sT = [
      { x: this.target.x, v: 0 },
      { x: this.target.y, v: 0 },
      { x: this.target.z, v: 0 },
    ];

    // --- reglages ------------------------------------------------------------
    this.hOrbit = H_ORBIT;
    this.hPan = H_PAN;
    this.hZoom = H_ZOOM;
    this.enabled = true;
    this.autoRotate = false;
    this.autoRotateSpeed = 0.02;
    this.autoHeight = true;
    this.inertiaEnabled = true;
    this.infinityDolly = true;
    this.anchorIn = 1.0;              // ancrage plein en zoom avant
    this.anchorOut = 0.0;             // dolly pur en zoom arriere (voir §2.8)
    this.recenterOnZoomOut = true;
    this.zoomSensitivity = 1.0;
    this.wheelMode = 'zoom';          // 'zoom' | 'radius'
    this.invertOrbitY = false;
    this.reducedMotion = false;
    this.topView = false;

    // --- etat interne --------------------------------------------------------
    this._dragging = null;            // 'orbit' | 'pan'
    this._last = new THREE.Vector2();
    this._px = 0; this._py = 0;       // derniere position curseur connue
    this._vx = 0; this._vy = 0;       // vitesse pointeur lissee (px/s)
    this._lastMoveAt = 0;
    this._spinA = 0; this._spinP = 0; // inertie
    this._lift = 0;                   // correction d'elevation anti-collision
    this._tween = null;

    this._rayTmp = { ox: 0, oy: 0, oz: 0, dx: 0, dy: 0, dz: 0, ux: 0, uy: 0, uz: 0 };
    this._pa = { x: 0, z: 0 };
    this._pb = { x: 0, z: 0 };
    this._anchor = new THREE.Vector3();
    this._anchorValid = false;
    this._anchorTime = -1e9;
    this._anchorPx = 0; this._anchorPy = 0;
    this._zoomAnchorActive = false;

    this._ctrlDown = false;
    this._profile = 'unknown';        // 'mouse' | 'trackpad'
    this._score = 0;
    this._lastWheelAt = 0;
    this._radiusAcc = 0;
    this._gestureScale = 1;
    this._touches = new Map();
    this._gesture = null;
    this._camMode = false;

    this.keys = new Set();
    /** Registre des ecouteurs : dispose() doit VRAIMENT tout retirer. */
    this._listeners = [];

    this._bind();
    this.applyMotionProfile();
    this.update(0);
  }

  // ===========================================================================
  // ENTREES
  // ===========================================================================

  _on(el, ev, fn, opts) {
    el.addEventListener(ev, fn, opts);
    this._listeners.push([el, ev, fn, opts]);
  }

  _bind() {
    const d = this.dom;
    d.style.touchAction = 'none';

    this._on(d, 'contextmenu', (e) => e.preventDefault());
    this._on(d, 'pointerdown', (e) => this.onPointerDown(e));
    this._on(window, 'pointermove', (e) => this.onPointerMove(e));
    this._on(window, 'pointerup', (e) => this.onPointerUp(e));
    this._on(window, 'pointercancel', (e) => this.onPointerUp(e));
    // passive:false OBLIGATOIRE, et sur le canevas et non sur window : un
    // listener wheel pose sur un noeud de premier niveau est force en passif
    // par Chrome, et preventDefault() y est ignore.
    this._on(d, 'wheel', (e) => this.onWheel(e), { passive: false });

    this._on(window, 'keydown', (e) => this.onKeyDown(e));
    this._on(window, 'keyup', (e) => this.onKeyUp(e));
    this._on(window, 'blur', () => this.onBlur());
    this._on(document, 'visibilitychange', () => { if (document.hidden) this.onBlur(); });

    // Safari macOS : le pincement n'arrive PAS en wheel+ctrlKey.
    // Sur iOS les deux familles se declenchent et se contredisent : on exclut.
    if (!IS_IOS && 'GestureEvent' in window) {
      this._on(d, 'gesturestart', (e) => {
        e.preventDefault();
        this._gestureScale = 1;
        this._anchorValid = false;
      });
      this._on(d, 'gesturechange', (e) => {
        e.preventDefault();
        const k = e.scale / (this._gestureScale || 1);
        this._gestureScale = e.scale;
        if (k > 0) this.zoomAt(e.clientX, e.clientY, -Math.log(k) / ZOOM_PER_NOTCH);
      });
      this._on(d, 'gestureend', (e) => e.preventDefault());
    }

    this._mq = window.matchMedia('(prefers-reduced-motion: reduce)');
    this._onMq = () => this.applyMotionProfile();
    this._mq.addEventListener('change', this._onMq);
  }

  dispose() {
    for (const [el, ev, fn, opts] of this._listeners) el.removeEventListener(ev, fn, opts);
    this._listeners.length = 0;
    this._mq?.removeEventListener('change', this._onMq);
  }

  onBlur() {
    this.keys.clear();
    this._ctrlDown = false;
    this._dragging = null;
    this._spinA = this._spinP = 0;
    this._touches.clear();
    this.setCameraMode(false);
  }

  // --- pointeur --------------------------------------------------------------

  onPointerDown(e) {
    if (!this.enabled) return;
    this._px = e.clientX; this._py = e.clientY;
    // Reprendre la main coupe TOUJOURS l'inertie et tout tween en cours.
    this._spinA = this._spinP = 0;
    this._tween = null;

    if (e.pointerType === 'touch') { this.onTouchDown(e); return; }

    let mode = null;
    if (e.button === 1) mode = e.shiftKey ? 'pan' : 'orbit';
    else if (e.button === 0 && (e.altKey || this._camMode)) mode = e.shiftKey ? 'pan' : 'orbit';
    else if (e.button === 2 && this._camMode) mode = 'pan';
    if (!mode) return;

    // Double-clic molette = focus.
    if (e.button === 1 && e.detail >= 2) { this.focusCursor(); return; }

    e.preventDefault();
    this._dragging = mode;
    this._fine = e.shiftKey && mode === 'orbit';
    this._last.set(e.clientX, e.clientY);
    this._vx = this._vy = 0;
    this._lastMoveAt = performance.now();
    this.dom.setPointerCapture?.(e.pointerId);
    this.dom.style.cursor = mode === 'pan' ? 'move' : 'grabbing';
  }

  onPointerMove(e) {
    this._px = e.clientX; this._py = e.clientY;
    if (e.pointerType === 'touch') { this.onTouchMove(e); return; }
    if (!this._dragging) return;

    const dx = e.clientX - this._last.x;
    const dy = e.clientY - this._last.y;
    this._last.set(e.clientX, e.clientY);

    const now = performance.now();
    const dt = (now - this._lastMoveAt) / 1000;
    this._lastMoveAt = now;
    this._trackVelocity(dx, dy, dt);

    if (this._dragging === 'orbit') {
      // 2*pi par hauteur d'ecran : traverser verticalement = un tour complet.
      // La sensibilite d'orbite ne depend PAS de la distance : un angle est
      // sans echelle, et la lier a la distance est desorientant.
      const rate = TAU / (this.dom.clientHeight || 1);
      const fine = this._fine ? 0.25 : 1;
      const sy = this.invertOrbitY ? -1 : 1;
      this.goalAzimuth -= dx * rate * fine;
      this.goalPolar = clamp(this.goalPolar - sy * dy * rate * fine,
                             this.minPolar, this.maxPolar);
    } else {
      // On passe les DEUX extremites : le panoramique exact a besoin des deux
      // rayons, pas d un delta.
      this.pan(e.clientX - dx, e.clientY - dy, e.clientX, e.clientY);
    }
  }

  onPointerUp(e) {
    if (e.pointerType === 'touch') { this.onTouchUp(e); return; }
    if (!this._dragging) return;
    this._releaseInertia();
    this.dom.releasePointerCapture?.(e.pointerId);
    this._dragging = null;
    this.dom.style.cursor = this._camMode ? 'grab' : '';
  }

  /** Vitesse pointeur lissee sur ~70 ms : un estimateur brut fait partir la camera. */
  _trackVelocity(dx, dy, dt) {
    if (!(dt > 0) || dt > 0.25) return;
    const a = 1 - Math.exp(-dt / 0.07);
    this._vx += (dx / dt - this._vx) * a;
    this._vy += (dy / dt - this._vy) * a;
  }

  _releaseInertia() {
    if (!this.inertiaEnabled || this._dragging !== 'orbit' || this.reducedMotion) return;
    // Immobile depuis plus de 80 ms : l'utilisateur a fini son geste.
    if (performance.now() - this._lastMoveAt > 80) return;
    const speed = Math.hypot(this._vx, this._vy);
    if (speed < INERTIA_MIN) return;
    const s = Math.min(speed, INERTIA_MAX) / speed;
    const rate = TAU / (this.dom.clientHeight || 1);
    this._spinA = -this._vx * s * rate;
    this._spinP = -this._vy * s * rate * (this.invertOrbitY ? -1 : 1);
  }

  // --- molette ---------------------------------------------------------------

  /**
   * ATTENTION : `deltaMode` doit etre lu AVANT `deltaY`. Firefox change la
   * valeur de deltaY selon qu'on a consulte deltaMode ou non.
   */
  _wheelPixels(e) {
    const mode = e.deltaMode;
    let dy = e.deltaY;
    if (mode === 1) dy *= LINE_HEIGHT;
    else if (mode === 2) dy *= PAGE_HEIGHT;
    else if (IS_FIREFOX) dy /= (window.devicePixelRatio || 1);
    if (!Number.isFinite(dy)) return 0;
    return clamp(dy, -4 * NOTCH_PX, 4 * NOTCH_PX);
  }

  /** `true` si cet evenement est un pincement de trackpad et non un vrai Ctrl. */
  _isPinch(e) {
    if (!e.ctrlKey) return false;
    if (!this._ctrlDown) return true;
    // Ctrl EST enfonce : on tranche a la granularite. Un cran est gros et entier.
    return !(e.deltaMode !== 0 || (Math.abs(e.deltaY) >= 40 && Number.isInteger(e.deltaY)));
  }

  _observeWheel(e, px) {
    const now = performance.now();
    const dt = now - this._lastWheelAt;
    this._lastWheelAt = now;
    if (e.deltaMode !== 0) { this._profile = 'mouse'; return; }
    if (e.ctrlKey && !this._ctrlDown) { this._profile = 'trackpad'; return; }

    const wd = e.wheelDelta;
    const notched = Math.abs(e.deltaX) < 0.5 && px !== 0
      && (Number.isInteger(Math.abs(e.deltaY / 4.000244140625))
          || (typeof wd === 'number' && wd !== 0 && wd % 120 === 0));
    const continuous = typeof e.wheelDeltaY === 'number' && e.wheelDeltaY !== 0
      && (e.wheelDeltaY === -Math.floor(3 * e.deltaY) || e.wheelDeltaY === -Math.ceil(3 * e.deltaY));

    if (notched) this._score -= 4;
    else if (continuous) this._score += 4;
    if (e.deltaY !== 0 && !Number.isInteger(e.deltaY)) this._score += 2;
    if (Math.abs(e.deltaX) > 0.5) this._score += 2;
    if (dt > 0 && dt < 40 && Math.abs(px) < 40) this._score += 1;

    this._score = clamp(this._score, -8, 12);
    if (this._score >= 6) this._profile = 'trackpad';
    else if (this._score <= -4) this._profile = 'mouse';
  }

  onWheel(e) {
    if (!this.enabled) return;
    e.preventDefault();
    const px = this._wheelPixels(e);
    this._observeWheel(e, px);

    const pinch = this._isPinch(e);
    const realCtrl = (e.ctrlKey || e.metaKey) && !pinch;
    // Molette nue = zoom (le defaut universel). Ctrl+molette = rayon.
    // L'option 'radius' restaure le comportement historique.
    const wantZoom = pinch || (this.wheelMode === 'zoom' ? !realCtrl : realCtrl);

    if (wantZoom) {
      const per = pinch ? PINCH_PX_PER_NOTCH
        : this._profile === 'trackpad' ? TRACKPAD_PX_PER_NOTCH : NOTCH_PX;
      this.zoomAt(e.clientX, e.clientY, (px / per) * this.zoomSensitivity);
    } else if (this.onToolWheel) {
      // Accumulateur de crans : une rafale de trackpad produit le meme nombre
      // de pas qu'une molette a crans pour un meme deplacement du doigt.
      this._radiusAcc += px;
      while (Math.abs(this._radiusAcc) >= NOTCH_PX) {
        const dir = Math.sign(this._radiusAcc);
        this.onToolWheel(e, dir);
        this._radiusAcc -= dir * NOTCH_PX;
      }
    }
  }

  // --- clavier ---------------------------------------------------------------

  onKeyDown(e) {
    if (e.key === 'Control') this._ctrlDown = true;
    if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
    if (e.ctrlKey || e.metaKey) {
      if (e.code === 'KeyA') { e.preventDefault(); this.frameAll(); }
      return;
    }
    this.keys.add(e.code);

    switch (e.code) {
      case 'KeyF': e.preventDefault(); this.focusCursor(); break;
      case 'KeyR': e.preventDefault(); this.reset(); break;
      case 'KeyT': e.preventDefault(); this.setTopView(!this.topView); break;
      case 'Home': e.preventDefault(); this.reset(); break;
      case 'Equal': case 'NumpadAdd': case 'PageUp':
        e.preventDefault(); this.zoomAt(this._px, this._py, -1); break;
      case 'Minus': case 'NumpadSubtract': case 'PageDown':
        e.preventDefault(); this.zoomAt(this._px, this._py, +1); break;
      case 'Space':
        if (!e.repeat) { e.preventDefault(); this.setCameraMode(true); }
        break;
      case 'KeyQ': if (!e.repeat) this.orbitStep(+1); break;
      case 'KeyE': if (!e.repeat) this.orbitStep(-1); break;
      default: break;
    }
  }

  onKeyUp(e) {
    if (e.key === 'Control') this._ctrlDown = false;
    this.keys.delete(e.code);
    if (e.code === 'Space') this.setCameraMode(false);
  }

  /** Mode camera temporaire : marche sur TOUS les peripheriques. */
  setCameraMode(on) {
    if (on === this._camMode) return;
    this._camMode = on;
    this.dom.style.cursor = on ? 'grab' : '';
    this.setToolsEnabled?.(!on);
  }

  /** Orbite par pas de 22,5 deg, avec transition animee. */
  orbitStep(dir) {
    this.tweenTo({ azimuth: this.goalAzimuth + dir * ORBIT_STEP }, 0.22);
  }

  // --- tactile ---------------------------------------------------------------

  onTouchDown(e) {
    this._touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (this._touches.size >= 2) {
      this.setToolsEnabled?.(false);
      this._gesture = this._readGesture();
      this._anchorValid = false;
    }
  }

  onTouchMove(e) {
    const t = this._touches.get(e.pointerId);
    if (!t) return;
    t.x = e.clientX; t.y = e.clientY;
    const n = this._touches.size;
    if (n < 2) return;

    const g = this._readGesture();
    const p = this._gesture;
    if (!p) { this._gesture = g; return; }

    if (n === 2) {
      // Seuil de 8 px : deux doigts poses ensemble produiraient un pic de zoom.
      if (p.dist > 8 && g.dist > 8) {
        this.zoomAt(g.cx, g.cy, Math.log(p.dist / g.dist) / ZOOM_PER_NOTCH);
      }
      this.pan(p.cx, p.cy, g.cx, g.cy);
    } else {
      const rate = TAU / (this.dom.clientHeight || 1);
      this.goalAzimuth -= (g.cx - p.cx) * rate;
      this.goalPolar = clamp(this.goalPolar - (g.cy - p.cy) * rate,
                             this.minPolar, this.maxPolar);
    }
    this._gesture = g;
  }

  onTouchUp(e) {
    this._touches.delete(e.pointerId);
    this._gesture = this._touches.size >= 2 ? this._readGesture() : null;
    if (this._touches.size === 0) this.setToolsEnabled?.(true);
  }

  _readGesture() {
    const it = this._touches.values();
    const a = it.next().value, b = it.next().value;
    if (!a) return null;
    if (!b) return { cx: a.x, cy: a.y, dist: 0 };
    return { cx: (a.x + b.x) / 2, cy: (a.y + b.y) / 2, dist: Math.hypot(a.x - b.x, a.y - b.y) };
  }

  // ===========================================================================
  // ZOOM ANCRE
  // ===========================================================================

  /**
   * Point du monde sous le curseur, vu depuis l'etat BUT de la camera.
   *
   * Le rayon part de la camera-BUT et non de la camera visible : c'est ce qui
   * rend l'invariance exacte apres convergence de l'amortissement. Au repos,
   * les deux coincident.
   */
  /**
   * Rayon monde passant par un pixel, tire depuis l etat BUT de la camera.
   *
   * On calcule la base analytiquement plutot que de lire camera.matrixWorld :
   * celle-ci n est mise a jour qu au rendu, donc entre deux frames elle est
   * perimee — et surtout elle decrit la camera VISIBLE, pas la camera but.
   */
  _ray(clientX, clientY, out = this._rayTmp) {
    const r = this.dom.getBoundingClientRect();
    const ndcX = ((clientX - r.left) / r.width) * 2 - 1;
    const ndcY = -((clientY - r.top) / r.height) * 2 + 1;

    const A = this.goalAzimuth, th = this.goalPolar, d = this.goalDistance;
    const sa = Math.sin(A), ca = Math.cos(A);
    const st = Math.sin(th), ct = Math.cos(th);

    const ux = st * sa, uy = ct, uz = st * ca;          // cible -> camera
    out.ox = this.goalTarget.x + d * ux;
    out.oy = this.goalTarget.y + d * uy;
    out.oz = this.goalTarget.z + d * uz;
    out.ux = ux; out.uy = uy; out.uz = uz;

    const tanV = Math.tan((this.camera.fov * Math.PI) / 360);
    const tanH = tanV * this.camera.aspect;
    const sx = ndcX * tanH, sy = ndcY * tanV;

    // fwd = -u ; right = (ca, 0, -sa) ; up = (-ct*sa, st, -ct*ca)
    let dx = -ux + sx * ca + sy * (-ct * sa);
    let dy = -uy + sy * st;
    let dz = -uz + sx * (-sa) + sy * (-ct * ca);
    const inv = 1 / Math.hypot(dx, dy, dz);
    out.dx = dx * inv; out.dy = dy * inv; out.dz = dz * inv;
    return out;
  }

  /** Intersection du rayon d un pixel avec le plan horizontal y = Y. */
  _rayToPlane(clientX, clientY, Y, out) {
    const R = this._ray(clientX, clientY);
    if (Math.abs(R.dy) < 1e-5) return null;
    const t = (Y - R.oy) / R.dy;
    if (!(t > 0.02) || t > 600) return null;
    out.x = R.ox + R.dx * t;
    out.z = R.oz + R.dz * t;
    return out;
  }

  anchorAt(clientX, clientY) {
    const R = this._ray(clientX, clientY);
    const ox = R.ox, oy = R.oy, oz = R.oz;
    const dx = R.dx, dy = R.dy, dz = R.dz;
    const ux = R.ux, uy = R.uy, uz = R.uz;
    const d = this.goalDistance;

    // 1. le terrain
    const hit = this.field?.raycast({ x: ox, y: oy, z: oz }, { x: dx, y: dy, z: dz }, 80);
    if (hit) return this._clampAnchor(hit.point.x, hit.point.y, hit.point.z, ox, oy, oz, dx, dy, dz);

    // 2. plan horizontal a la hauteur de la cible (le "plan de travail" percu)
    if (Math.abs(dy) > 1e-5) {
      const t = (this.goalTarget.y - oy) / dy;
      if (t > 0.05 && t < 400) {
        return this._clampAnchor(ox + dx * t, this.goalTarget.y, oz + dz * t,
                                 ox, oy, oz, dx, dy, dz);
      }
    }

    // 3. plan perpendiculaire a la visee, passant par la cible.
    // Toujours defini. Degrade CONTINUMENT vers le zoom classique : au centre
    // de l'ecran il redonne exactement P = target, donc alpha = 0.
    const t = d / Math.max(1e-4, dx * -ux + dy * -uy + dz * -uz);
    return this._clampAnchor(ox + dx * t, oy + dy * t, oz + dz * t, ox, oy, oz, dx, dy, dz);
  }

  /**
   * Bride l'ancre en position ET en profondeur.
   *
   * La profondeur ne change pas la VALIDITE de l'ancrage (toute la droite du
   * rayon est epinglee) mais sa VITESSE : delta = p*(1-k). Une ancre a 200 m
   * donnerait 24 m de deplacement pour un seul cran.
   */
  _clampAnchor(x, y, z, ox, oy, oz, dx, dy, dz) {
    const m = ANCHOR_MARGIN;
    let px = clamp(x, -WORLD_W / 2 - m, WORLD_W / 2 + m);
    let py = clamp(y, 0, WORLD_H);
    let pz = clamp(z, -WORLD_D / 2 - m, WORLD_D / 2 + m);
    // Reprojection sur le rayon apres clamp, pour ne pas casser l'invariance.
    let p = (px - ox) * dx + (py - oy) * dy + (pz - oz) * dz;
    p = clamp(p, this.camera.near * 4, this.goalDistance * 8);
    return this._anchor.set(ox + dx * p, oy + dy * p, oz + dz * p);
  }

  /** Verrouille l'ancre pour toute la duree d'une rafale de molette. */
  _latchAnchor(clientX, clientY) {
    const now = performance.now();
    const stale = now - this._anchorTime > ANCHOR_HOLD;
    const moved = Math.hypot(clientX - this._anchorPx, clientY - this._anchorPy) > ANCHOR_SLOP;
    if (!this._anchorValid || stale || moved) {
      this.anchorAt(clientX, clientY);
      this._anchorPx = clientX;
      this._anchorPy = clientY;
      this._anchorValid = true;
    }
    this._anchorTime = now;
    return this._anchor;
  }

  /**
   * Zoom ancre sur (clientX, clientY). `notches` est deja normalise :
   * 1 = un cran de molette vers soi = zoom arriere.
   *
   * L'equation, derivee dans docs/RECHERCHE-CAMERA.md §2.2 :
   *     T <- T + (1 - k)*(P - T)     et     d <- k*d
   * soit une homothetie de centre P et de rapport k appliquee a tout le repere.
   */
  zoomAt(clientX, clientY, notches) {
    if (!this.enabled || !Number.isFinite(notches) || notches === 0) return;
    this._tween = null;
    const P = this._latchAnchor(clientX, clientY);

    const dBefore = this.goalDistance;
    const want = Math.exp(notches * ZOOM_PER_NOTCH);
    const dAfter = clamp(dBefore * want, this.minDistance, this.maxDistance);
    const kEff = dAfter / dBefore;

    if (Math.abs(kEff - 1) < 1e-6) {
      // En butee : on bascule du zoom au dolly. La distance reste bloquee mais
      // on pousse la cible le long de l'axe — donc on continue d'avancer.
      // Sans ca, l'utilisateur scrolle dans le vide sans comprendre.
      if (!this.infinityDolly) return;
      const push = dBefore * (1 - want);
      const st = Math.sin(this.goalPolar), ct = Math.cos(this.goalPolar);
      this.goalTarget.x -= push * st * Math.sin(this.goalAzimuth);
      this.goalTarget.y -= push * ct;
      this.goalTarget.z -= push * st * Math.cos(this.goalAzimuth);
      this.clampTarget();
      return;
    }

    const beta = kEff < 1 ? this.anchorIn : this.anchorOut;
    const a = beta * (1 - kEff);
    this.goalTarget.x += (P.x - this.goalTarget.x) * a;
    this.goalTarget.y += (P.y - this.goalTarget.y) * a;
    this.goalTarget.z += (P.z - this.goalTarget.z) * a;

    // Recentrage doux en zoom arriere : "le dezoom montre tout".
    // Le gain est nul a k=1, donc rigoureusement sans effet en zoom avant.
    if (kEff > 1 && this.recenterOnZoomOut) {
      const g = RECENTER_GAIN * (1 - 1 / kEff);
      this.goalTarget.x += (0 - this.goalTarget.x) * g;
      this.goalTarget.z += (0 - this.goalTarget.z) * g;
    }

    this.goalDistance = dAfter;
    this.clampTarget();
    // Transit exact (§2.7) seulement si l'ancrage est plein.
    this._zoomAnchorActive = beta > 0.999;
  }

  // ===========================================================================
  // PANORAMIQUE
  // ===========================================================================

  /**
   * Panoramique dans le plan horizontal.
   *
   * Le facteur 1/cos(polar) est essentiel : la composante horizontale du
   * vecteur "haut" de la camera vaut cos(polar) fois l'avant horizontal, donc
   * sans lui le sol glisse sous le curseur des que la vue n'est pas zenithale
   * (30 % d'erreur a 45 deg, 97 % a l'horizon).
   *
   * Le gain est plafonne a 4 : a l'horizon il tendrait vers l'infini et trois
   * pixels de tremblement enverraient la cible a l'autre bout de la plage.
   */
  pan(fromX, fromY, toX, toY) {
    const Y = this.goalTarget.y;
    const a = this._rayToPlane(fromX, fromY, Y, this._pa);
    const b = a && this._rayToPlane(toX, toY, Y, this._pb);
    if (a && b) {
      const dx = b.x - a.x, dz = b.z - a.z;
      // Un rayon rasant coupe le plan tres loin : un pixel de glissement
      // deviendrait dix metres. Au-dela de 3 fois la distance, on refuse et on
      // retombe sur l approximation ecran, qui est bornee par construction.
      if (Math.hypot(dx, dz) < this.goalDistance * 3) {
        this.goalTarget.x -= dx;
        this.goalTarget.z -= dz;
        this.clampTarget();
        return;
      }
    }
    this._panScreen(toX - fromX, toY - fromY);
  }

  /**
   * Repli : approximation ecran, exacte au premier ordre seulement.
   *
   * Le facteur 1/cos(polar) est indispensable — la composante horizontale du
   * vecteur haut de la camera vaut cos(polar) fois l avant horizontal — mais il
   * ne suffit pas : sur un glissement de 230 px a 9 m, l erreur residuelle va
   * de 12 px (elevation 61 deg) a 88 px (elevation 10 deg), parce qu un plan
   * de sol vu en biais ne se translate pas uniformement a l ecran.
   *
   * Noter le signe : +dy et non -dy. Un glissement vers le haut doit faire
   * monter le sol, comme un glissement vers la droite le fait aller a droite.
   */
  _panScreen(dx, dy) {
    const h = this.dom.clientHeight || 1;
    const scale = (2 * this.goalDistance * Math.tan((this.camera.fov * Math.PI) / 360)) / h;
    const A = this.goalAzimuth;
    const rx = Math.cos(A), rz = -Math.sin(A);
    const fx = -Math.sin(A), fz = -Math.cos(A);
    const lift = Math.min(1 / Math.max(Math.cos(this.goalPolar), 1e-3), PAN_LIFT_MAX);

    this.goalTarget.x += -dx * scale * rx + dy * scale * lift * fx;
    this.goalTarget.z += -dx * scale * rz + dy * scale * lift * fz;
    this.clampTarget();
  }

  clampTarget() {
    const m = 1.2;
    this.goalTarget.x = clamp(this.goalTarget.x, -WORLD_W / 2 - m, WORLD_W / 2 + m);
    this.goalTarget.z = clamp(this.goalTarget.z, -WORLD_D / 2 - m, WORLD_D / 2 + m);
    this.goalTarget.y = clamp(this.goalTarget.y, 0.2, 3.2);
  }

  // ===========================================================================
  // RECADRAGE
  // ===========================================================================

  /** API historique, conservee : recentre sans animation notable. */
  focus(x, y, z, distance) {
    this.goalTarget.set(x, y, z);
    if (distance) this.goalDistance = clamp(distance, this.minDistance, this.maxDistance);
    this.clampTarget();
  }

  focusCursor() {
    const P = this.anchorAt(this._px, this._py);
    if (!P) return;
    const d = Math.max(this.minDistance, Math.min(this.goalDistance, 4.5));
    this.tweenTo({ target: P.clone(), distance: d });
  }

  frameAll() {
    const R = Math.hypot(WORLD_W / 2, WORLD_D / 2, 1.1);
    const d = clamp(distanceToFitSphere(R, this.camera.fov, this.camera.aspect, 0.08),
                    this.minDistance, this.maxDistance);
    this.tweenTo({ target: new THREE.Vector3(0, 0.9, 0), distance: d });
  }

  reset() {
    this.tweenTo({
      azimuth: HOME.azimuth, polar: HOME.polar,
      distance: HOME.distance, target: HOME.target.clone(),
    });
  }

  /**
   * Vue de dessus "fausse ortho" : un FOV tres etroit avec la distance
   * compensee est visuellement indiscernable d'une orthographique, et ne
   * touche ni au pipeline de rendu ni au post-traitement.
   *     d' = d * tan(fov/2) / tan(fov'/2)
   */
  setTopView(on) {
    if (on === this.topView) return;
    this.topView = on;
    if (on) {
      this._saved = {
        polar: this.goalPolar, distance: this.goalDistance,
        fov: this.camera.fov, max: this.maxDistance, far: this.camera.far,
      };
      const d2 = this.goalDistance
        * Math.tan((this.camera.fov * DEG2RAD) / 2) / Math.tan(3 * DEG2RAD);
      this.maxDistance = 220;
      this.camera.far = 340;
      this.minPolar = 0;                  // le zenith est sans danger : azimut fige
      this.tweenTo({ polar: 0, distance: Math.min(d2, 200), fov: 6 }, 0.35);
    } else {
      const s = this._saved;
      this.maxDistance = s.max;
      this.camera.far = s.far;
      this.minPolar = MIN_POLAR;
      this.tweenTo({ polar: s.polar, distance: s.distance, fov: s.fov }, 0.35);
    }
    this.camera.updateProjectionMatrix();
  }

  /**
   * Transition animee. On interpole (azimut, polaire, ln d, cible) — jamais la
   * position ni le quaternion : un lerp de position traverse le sujet, et un
   * slerp de quaternion reintroduit du roulis en milieu de course.
   */
  tweenTo(to, duration) {
    this._spinA = this._spinP = 0;
    const from = {
      azimuth: this.goalAzimuth, polar: this.goalPolar,
      distance: this.goalDistance, target: this.goalTarget.clone(), fov: this.camera.fov,
    };
    const T1 = to.target || from.target;
    const d1 = clamp(to.distance ?? from.distance, this.minDistance, this.maxDistance);
    const dur = this.reducedMotion ? 0
      : (duration ?? vanWijkDuration(from.target, from.distance, T1, d1, this.camera.fov));

    this._tween = {
      from,
      to: {
        polar: clamp(to.polar ?? from.polar, this.minPolar, this.maxPolar),
        distance: d1, target: T1, fov: to.fov ?? from.fov,
      },
      dA: shortestDelta(from.azimuth, to.azimuth ?? from.azimuth),
      lnD0: Math.log(from.distance), lnD1: Math.log(d1),
      t: 0, dur,
    };
    if (dur === 0) this._stepTween(1e9);
  }

  _stepTween(dt) {
    const w = this._tween;
    if (!w) return;
    w.t += dt;
    const u = w.dur > 0 ? Math.min(1, w.t / w.dur) : 1;
    const e = smootherstep(u);
    this.goalAzimuth = w.from.azimuth + w.dA * e;
    this.goalPolar = w.from.polar + (w.to.polar - w.from.polar) * e;
    this.goalDistance = Math.exp(w.lnD0 + (w.lnD1 - w.lnD0) * e);
    this.goalTarget.lerpVectors(w.from.target, w.to.target, e);
    if (w.to.fov !== w.from.fov) {
      this.camera.fov = w.from.fov + (w.to.fov - w.from.fov) * e;
      this.camera.updateProjectionMatrix();
    }
    if (u >= 1) this._tween = null;
  }

  // ===========================================================================
  // GARDE-FOUS
  // ===========================================================================

  /**
   * Releve l'elevation juste ce qu'il faut pour que le bras camera-cible ne
   * plonge nulle part sous le sable.
   *
   * On remonte plutot que de rapprocher : rapprocher changerait la TAILLE
   * APPARENTE du chateau, et toute la lecture d'un diorama repose sur une
   * echelle stable.
   *
   * Deux iterations de point fixe suffisent : l'erreur residuelle est en
   * O(delta^2) et delta est deja petit apres la premiere.
   */
  solveTerrainClearance(A, phi, dist, T) {
    const F = this.field;
    if (!F || this.topView) return phi;
    for (let it = 0; it < 2; it++) {
      const sp = Math.sin(phi), cp = Math.cos(phi);
      const ux = sp * Math.sin(A), uy = cp, uz = sp * Math.cos(A);
      let need = 0;
      for (let i = 1; i <= ARM_SAMPLES; i++) {
        const s = i / ARM_SAMPLES;
        const qx = T.x + s * dist * ux;
        const qy = T.y + s * dist * uy;
        const qz = T.z + s * dist * uz;
        const floor = Math.max(F.surfaceHeightAt(qx, qz) + CLEARANCE, GROUND_FLOOR);
        const pen = floor - qy;
        if (pen > 0) need = Math.max(need, pen / (s * dist * Math.max(sp, 0.05)));
      }
      if (need <= 1e-4) break;
      phi = Math.max(this.minPolar, phi - Math.min(need, 0.5));
    }
    return phi;
  }

  /**
   * La cible suit la hauteur du terrain : quand on batit une tour, la camera
   * monte toute seule. Coupe pendant un zoom ancre (la cible s'y bat avec
   * l'homothetie) et en vue de dessus.
   */
  followTerrain(dt) {
    if (!this.autoHeight || this._zoomAnchorActive || this.topView
        || this._tween || !this.field) return;
    const h = this.field.surfaceHeightAt(this.goalTarget.x, this.goalTarget.z) + 0.40;
    const k = 1 - Math.exp(-Math.LN2 * dt / 0.35);
    this.goalTarget.y += (clamp(h, 0.2, 3.2) - this.goalTarget.y) * k;
  }

  applyMotionProfile() {
    this.reducedMotion = !!this._mq?.matches || this.forceReducedMotion === true;
    if (this.reducedMotion) {
      this.hOrbit = this.hPan = this.hZoom = 0;
      this.inertiaEnabled = false;
      this.autoRotate = false;
      this.autoHeight = false;
      this._spinA = this._spinP = 0;
    } else {
      this.hOrbit = H_ORBIT; this.hPan = H_PAN; this.hZoom = H_ZOOM;
      this.inertiaEnabled = true;
      this.autoHeight = true;
    }
  }

  // ===========================================================================
  // BOUCLE
  // ===========================================================================

  update(dt) {
    // Un GC de 800 ms ne doit pas teleporter la camera. Une camera qui saute
    // est bien plus desagreable qu'un sable qui coule un peu moins.
    dt = Math.min(Math.max(dt, 0), 1 / 20);

    if (this._tween) this._stepTween(dt);
    if (this.enabled && this.keys.size && !this._tween) this._keyboard(dt);

    // --- inertie -------------------------------------------------------------
    if (this._spinA || this._spinP) {
      const decay = Math.exp(-INERTIA_LAMBDA * dt);
      this.goalAzimuth += this._spinA * dt;
      const p = clamp(this.goalPolar + this._spinP * dt, this.minPolar, this.maxPolar);
      // En butee, on annule UNIQUEMENT la composante contrainte : sinon la
      // camera "colle" a la butee en poussant contre le mur une demi-seconde.
      if (p === this.minPolar || p === this.maxPolar) this._spinP = 0;
      this.goalPolar = p;
      this._spinA *= decay;
      this._spinP *= decay;
      if (Math.abs(this._spinA) + Math.abs(this._spinP) < 0.002) this._spinA = this._spinP = 0;
    }

    if (this.autoRotate && !this._dragging) this.goalAzimuth += this.autoRotateSpeed * dt;
    this.followTerrain(dt);

    // --- ressorts ------------------------------------------------------------
    this.azimuth = spring(this._sA, this.goalAzimuth, this.hOrbit, dt);
    this.polar = clamp(spring(this._sP, this.goalPolar, this.hOrbit, dt),
                       this.minPolar, this.maxPolar);

    const dPrev = this.distance;
    // Espace LOG : un cran de molette produit le meme ressenti a 1,4 m qu'a
    // 34 m, et le transit ne demarre plus en fusee pour finir en escargot.
    this.distance = Math.exp(spring(this._sD, Math.log(this.goalDistance), this.hZoom, dt));

    // --- ancrage exact PENDANT le transit (§2.7) -----------------------------
    // Le produit des k de chaque frame vaut exactement le k total demande :
    // l'ancre est donc immobile a CHAQUE frame, pas seulement a la fin.
    if (this._zoomAnchorActive && dPrev > 0) {
      const a = 1 - this.distance / dPrev;
      const P = this._anchor;
      this.target.x += (P.x - this.target.x) * a;
      this.target.y += (P.y - this.target.y) * a;
      this.target.z += (P.z - this.target.z) * a;
      this._sT[0].x = this.target.x; this._sT[1].x = this.target.y; this._sT[2].x = this.target.z;
      if (Math.abs(this.goalDistance - this.distance) < this.distance * 1e-3) {
        this._zoomAnchorActive = false;
      }
    } else {
      this.target.set(
        spring(this._sT[0], this.goalTarget.x, this.hPan, dt),
        spring(this._sT[1], this.goalTarget.y, this.hPan, dt),
        spring(this._sT[2], this.goalTarget.z, this.hPan, dt)
      );
    }

    // --- collision -----------------------------------------------------------
    // Asymetrie volontaire : on monte vite (25 ms) et on redescend lentement
    // (550 ms). C'est le RETOUR rapide qui produit le pompage nauseeux.
    const wanted = this.solveTerrainClearance(this.azimuth, this.polar, this.distance, this.target);
    const lift = Math.max(0, this.polar - wanted);
    const H = lift > this._lift ? 0.025 : 0.550;
    this._lift += (lift - this._lift) * (1 - Math.exp(-Math.LN2 * dt / H));
    const phi = clamp(this.polar - this._lift, this.minPolar, this.maxPolar);

    // --- reconstruction ------------------------------------------------------
    const sp = Math.sin(phi);
    this.camera.position.set(
      this.target.x + this.distance * sp * Math.sin(this.azimuth),
      this.target.y + this.distance * Math.cos(phi),
      this.target.z + this.distance * sp * Math.cos(this.azimuth)
    );
    // Dernier filet : jamais sous le bloc, quoi qu'il arrive (NaN, chargement).
    if (!(this.camera.position.y > GROUND_FLOOR)) this.camera.position.y = GROUND_FLOOR;
    // camera.up n'est JAMAIS touche : c'est ce qui garantit un roulis nul.
    this.camera.lookAt(this.target);
  }

  _keyboard(dt) {
    const shift = this.keys.has('ShiftLeft') || this.keys.has('ShiftRight');
    // Vitesse proportionnelle a la distance : traverser la hauteur visible
    // (0,573*d a 32 deg) prend 0,64 s a toute distance.
    const sp = KEY_PAN_RATE * this.distance * dt * (shift ? 2.5 : 1);
    const A = this.goalAzimuth;
    const fx = -Math.sin(A), fz = -Math.cos(A);
    const rx = Math.cos(A), rz = -Math.sin(A);
    const k = this.keys;

    const pan = shift || k.has('ShiftLeft');
    if (pan) {
      if (k.has('KeyW') || k.has('ArrowUp')) { this.goalTarget.x += fx * sp; this.goalTarget.z += fz * sp; }
      if (k.has('KeyS') || k.has('ArrowDown')) { this.goalTarget.x -= fx * sp; this.goalTarget.z -= fz * sp; }
      if (k.has('KeyA') || k.has('ArrowLeft')) { this.goalTarget.x -= rx * sp; this.goalTarget.z -= rz * sp; }
      if (k.has('KeyD') || k.has('ArrowRight')) { this.goalTarget.x += rx * sp; this.goalTarget.z += rz * sp; }
      this.clampTarget();
    } else {
      const r = KEY_ORBIT_RATE * dt;
      if (k.has('KeyA') || k.has('ArrowLeft')) this.goalAzimuth += r;
      if (k.has('KeyD') || k.has('ArrowRight')) this.goalAzimuth -= r;
      if (k.has('KeyW') || k.has('ArrowUp')) this.goalPolar = clamp(this.goalPolar - r, this.minPolar, this.maxPolar);
      if (k.has('KeyS') || k.has('ArrowDown')) this.goalPolar = clamp(this.goalPolar + r, this.minPolar, this.maxPolar);
    }
  }
}
```

### 8.1 Les quatre lignes à changer ailleurs

**`src/core/Game.js`** — injecter le champ voxel et brancher les deux rappels :

```js
this.controls = new DioramaControls(this.camera, this.canvas);
// ... apres this.field = new VoxelField(); :
this.controls.field = this.field;
// ... apres this.tools = new ToolManager(this); :
this.controls.setToolsEnabled = (on) => { this.tools.enabled = on && !this.photoMode; };
this.controls.onToolWheel = (e, dir) => this.tools.wheelStep(e, dir);
```

**`src/tools/ToolManager.js`** — supprimer son propre écouteur `wheel` (un seul routeur, §3.6) et
exposer un `wheelStep(e, dir)` qui reçoit un pas normalisé :

```js
// on(c, 'wheel', (e) => this.onWheel(e), { passive: false });   <- a supprimer

/**
 * Un pas discret de molette, deja normalise par DioramaControls.
 * @param {number} dir -1 = vers le haut (agrandir), +1 = vers le bas
 */
wheelStep(e, dir) {
  if (!this.enabled) return;
  const t = this.current;
  if (e.shiftKey && t.id === 'rake') {
    t.spacing = clamp(t.spacing * (dir < 0 ? 1 / 0.85 : 0.85), 0.02, 0.22);
    this.game.onToolChanged?.(t); return;
  }
  if (e.shiftKey && t.id === 'decor') {
    const n = DECOR_VARIANTS.length;
    t.variant = (t.variant + (dir > 0 ? 1 : n - 1)) % n;
    this.game.toast('Objet : ' + DECOR_VARIANTS[t.variant].name);
    this.game.onToolChanged?.(t); return;
  }
  this.setRadius(this.radius * (dir < 0 ? 1 / 0.85 : 0.85));
}
```

Et, dans `onDown`, ajouter la garde du mode caméra à côté de celle d'`Alt` :

```js
if (e.altKey) return;
if (!this.enabled) return;      // couvre Espace, le tactile a 2 doigts, le mode photo
```

---

## 9. Ordre d'implémentation

Cinq lots, du plus rentable au plus accessoire. Chacun est indépendant et livrable seul.

| Lot | Contenu | Défauts corrigés | Effort | Gain ressenti |
|---|---|---|---|---|
| **1** | Zoom ancré + normalisation de la molette + molette nue = zoom | D1, D2 | ~150 lignes | **énorme** — c'est la demande |
| **2** | Ressorts (avec le bon `y = 2·ln2/H`), espace log, panoramique exact, vitesse clavier | D3, D5, D6, D11 | ~120 lignes | fort |
| **3** | Collision terrain, bornes corrigées, filet `y > 0` | D4, D8 | ~60 lignes | fort (supprime des bugs visibles) |
| **4** | `F`, `R`, `T`, « tout voir », tweens Van Wijk, suivi de hauteur | D7 | ~120 lignes | moyen |
| **5** | Tactile, `Espace`, profil trackpad, accessibilité clavier, `dispose()` | D9, D10 | ~140 lignes | moyen, mais élargit le public |

**Test à chaque lot.** T1/T9 après le lot 1, T6/T7/T8 après le lot 2, T3/T5 après le lot 3, T11
après le lot 4, T12 après le lot 5. Les tests sont écrits pour être ajoutés progressivement.

### 9.1 Le lot 1 seul, si on ne fait qu'une chose

Trois modifications suffisent à répondre à la demande du joueur :

1. `_wheelPixels()` + les trois diviseurs de sensibilité (§3.3) — **et l'ordre de lecture
   `deltaMode` avant `deltaY`**, sans quoi Firefox reste cassé.
2. `anchorAt()` + `_latchAnchor()` + `zoomAt()` (§2.5 à §2.7).
3. Inverser le défaut de la molette (§3.7) et déplacer le rayon sur `Ctrl+molette`.

Environ deux heures de travail, et c'est la moitié de la valeur du document.

### 9.2 Réglages à ajouter au HUD

Ils sont tous déjà exposés comme propriétés publiques de `DioramaControls` :

| Libellé | Propriété | Plage | Défaut |
|---|---|---|---|
| Sensibilité du zoom | `zoomSensitivity` | 0,25 → 4 | 1 |
| Lissage caméra | `hOrbit` / `hPan` / `hZoom` | 0 → 200 ms | 70 / 70 / 110 |
| Inertie | `inertiaEnabled` | oui / non | oui |
| Zoom vers le curseur | `anchorIn` / `anchorOut` | avant / avant + arrière / jamais | avant |
| Molette | `wheelMode` | zoom / rayon de brosse | zoom |
| Élévation automatique du pivot | `autoHeight` | oui / non | oui |
| Inverser l'axe vertical de l'orbite | `invertOrbitY` | oui / non | non |
| Mouvement réduit | `forceReducedMotion` | auto / forcé | auto (système) |

### 9.3 Ce qui reste ouvert

- **La vraie caméra orthographique** (§5.4.1) plutôt que la fausse. Elle demande de toucher à
  `Post`, à `ToolManager` et au `resize()`. La fausse ortho à 6° de FOV est visuellement
  équivalente à 99 % et coûte quinze lignes ; on la garde jusqu'à ce que le **traceur** de la
  vue de dessus (`GAME-DESIGN.md` §4.3, Solution 4) soit implémenté — c'est lui qui aura
  vraiment besoin d'une projection parallèle exacte pour dessiner à la souris.
- **L'évitement d'occlusion** (`GAME-DESIGN.md` §4.2 : « si la caméra passe derrière une tour,
  elle remonte de max +12° »). Le mécanisme `_lift` du §5.1.3 en est déjà l'infrastructure : il
  suffit d'ajouter un second terme, calculé sur le segment cible→caméra avec un critère
  d'occlusion plutôt que de pénétration, et de le plafonner à `12° = 0,209 rad`.
- **Le « flywheel »** (relance d'inertie dans la même direction). Écarté au §4.4.4 : nocif sur un
  domaine de 10 m. À reconsidérer seulement si le mode photo gagne des travellings.
- **Le multi-touch dans les tests.** Voir §7.4.

---

## 10. Sources

### Implémentations lues dans le texte

- three.js — [`OrbitControls.js`](https://github.com/mrdoob/three.js/blob/dev/examples/jsm/controls/OrbitControls.js)
  et [`MapControls.js`](https://github.com/mrdoob/three.js/blob/dev/examples/jsm/controls/MapControls.js) :
  `zoomToCursor`, `_dollyDirection`, `_TILT_LIMIT`, `screenSpacePanning`, `cursor` /
  `minTargetRadius` / `maxTargetRadius`, `_panLeft` / `_panUp` / `_pan`, `_getZoomScale`.
  Historique : [issue #22522](https://github.com/mrdoob/three.js/issues/22522),
  [PR #26165](https://github.com/mrdoob/three.js/pull/26165),
  [issue #27110](https://github.com/mrdoob/three.js/issues/27110),
  [issue #26548](https://github.com/mrdoob/three.js/issues/26548).
- Blender — [`view3d_navigate_view_zoom.cc`](https://github.com/blender/blender/blob/main/source/blender/editors/space_view3d/view3d_navigate_view_zoom.cc)
  (`view_zoom_to_window_xy_3d` : la formule `T' = P + (T−P)·dfac`, et le clamp du *facteur*),
  [`view3d_navigate_view_dolly.cc`](https://github.com/blender/blender/blob/main/source/blender/editors/space_view3d/view3d_navigate_view_dolly.cc),
  [`view3d_navigate.cc`](https://github.com/blender/blender/blob/main/source/blender/editors/space_view3d/view3d_navigate.cc) (Auto Depth).
  Manuel : [Preferences ▸ Navigation](https://docs.blender.org/manual/en/latest/editors/preferences/navigation.html),
  [3D View ▸ Navigation](https://docs.blender.org/manual/en/latest/editors/3dview/navigate/navigation.html),
  [Brush Settings](https://docs.blender.org/manual/en/latest/sculpt_paint/brush/brush_settings.html).
- [`yomotsu/camera-controls`](https://github.com/yomotsu/camera-controls/blob/dev/src/CameraControls.ts) —
  `dollyToCursor`, `infinityDolly`, `getDistanceToFitSphere`, `getDistanceToFitBox`,
  amortissement par `smoothDamp` sur θ, φ et r séparément.
- CesiumJS — [`ScreenSpaceCameraController.js`](https://github.com/CesiumGS/cesium/blob/main/packages/engine/Source/Scene/ScreenSpaceCameraController.js) :
  `_zoomWorldPosition`, `sameStartPosition`, cascade de replis, freinage à l'approche du sol.
- FreeCAD — [`NavigationStyle.cpp`](https://github.com/FreeCAD/FreeCAD/blob/main/src/Gui/Navigation/NavigationStyle.cpp) :
  `zoomAtCursor` par `pan / zoom / unpan`, échelle exponentielle, garde-fou d'overflow.
- Google `<model-viewer>` — [`SmoothControls.ts`](https://github.com/google/model-viewer/blob/master/packages/model-viewer/src/three-components/SmoothControls.ts)
  (`KEYBOARD_ORBIT_INCREMENT = Math.PI / 8`, quantification de l'orbite en labels ARIA) et
  [`ModelScene.ts`](https://github.com/google/model-viewer/blob/master/packages/model-viewer/src/three-components/ModelScene.ts)
  (`idealCameraDistance = R / sin(fov/2)`).
- Godot — [`SpringArm3D`](https://docs.godotengine.org/en/stable/classes/class_springarm3d.html) (`margin`, `collision_mask`).
- Unity Cinemachine — [`CinemachineDeoccluder`](https://docs.unity3d.com/Packages/com.unity.cinemachine@3.1/manual/CinemachineDeoccluder.html) :
  `Strategy` (`Preserve Camera Distance`), `Damping` **vs** `Damping When Occluded`,
  `Minimum Occlusion Time`, `Smoothing Time`.

### Amortissement et sensation

- Daniel Holden — [*Spring-It-On: The Game Developer's Spring-Roll-Call*](https://www.theorangeduck.com/page/spring-roll-call)
  et son [`common.h`](https://github.com/orangeduck/Spring-It-On/blob/main/common.h) :
  `simple_spring_damper_exact`, `damper_exact`, `fast_negexp`, `halflife_to_damping`.
- Rory Driscoll — [*Frame Rate Independent Damping using Lerp*](https://www.rorydriscoll.com/2016/03/07/frame-rate-independent-damping-using-lerp/).
- Ryan Juckett — [*Damped Springs*](https://www.ryanjuckett.com/damped-springs/) (matrice de transition pré-calculée).
- Unity — [`Mathf.SmoothDamp`, source C#](https://github.com/Unity-Technologies/UnityCsReference/blob/master/Runtime/Export/Math/Mathf.cs),
  qui cite *Game Programming Gems 4*, ch. 1.10 (Thomas Lowe, *Critically Damped Ease-In/Ease-Out Smoothing*).
- AOSP — [`OverScroller.java`](https://android.googlesource.com/platform/frameworks/base/+/refs/heads/main/core/java/android/widget/OverScroller.java),
  [`ViewConfiguration.java`](https://android.googlesource.com/platform/frameworks/base/+/refs/heads/main/core/java/android/view/ViewConfiguration.java)
  (`MINIMUM_FLING_VELOCITY = 50`, `MAXIMUM_FLING_VELOCITY = 8000`).
- androidx — [`FlingAnimation.java`](https://github.com/androidx/androidx/blob/androidx-main/dynamicanimation/dynamicanimation/src/main/java/androidx/dynamicanimation/animation/FlingAnimation.java)
  (`DEFAULT_FRICTION = −4.2`, seuil d'arrêt sous-pixel `threshold × 1000/16`).

### Transitions

- Van Wijk, J. J. & Nuij, W. A. A. — [*Smooth and efficient zooming and panning*](https://vanwijk.win.tue.nl/zoompan.pdf),
  IEEE InfoVis 2003. Métrique perceptive, géodésique fermée, `ρ = 1,42 ± 0,47` et
  `V = 0,90 ± 0,43` mesurés sur 26 sujets.
- [`d3-interpolate` — `interpolateZoom`](https://d3js.org/d3-interpolate/zoom) et son
  [code source](https://github.com/d3/d3-interpolate/blob/main/src/zoom.js) (ρ = √2 par défaut).
- [easings.net](https://easings.net/) · [Wikipedia — Smoothstep](https://en.wikipedia.org/wiki/Smoothstep).
- Nielsen Norman Group — [*Executing UX Animations: Duration and Motion Characteristics*](https://www.nngroup.com/articles/animation-duration/).

### Molette, trackpad, gestes

- MDN — [`WheelEvent.deltaMode`](https://developer.mozilla.org/en-US/docs/Web/API/WheelEvent/deltaMode) ·
  [`Element: wheel event`](https://developer.mozilla.org/en-US/docs/Web/API/Element/wheel_event) ·
  [`GestureEvent`](https://developer.mozilla.org/en-US/docs/Web/API/GestureEvent).
- Chromium — [`wheel_event.cc`](https://github.com/chromium/chromium/blob/main/third_party/blink/renderer/core/events/wheel_event.cc)
  (`ConvertDeltaMode` : jamais `DOM_DELTA_LINE`),
  [`web_input_event_builders_win.cc`](https://github.com/chromium/chromium/blob/main/ui/events/blink/web_input_event_builders_win.cc)
  (`kScrollbarPixelsPerLine = 100/3`),
  [`events_mac.mm`](https://github.com/chromium/chromium/blob/main/ui/events/cocoa/events_mac.mm)
  (`kScrollbarPixelsPerCocoaTick = 40`, d'où `4,000244140625`),
  [`event_target.cc`](https://github.com/chromium/chromium/blob/main/third_party/blink/renderer/core/dom/events/event_target.cc)
  (`wheel` forcé en passif sur les nœuds de premier niveau).
- Gecko — [`WheelEvent.cpp`](https://github.com/mozilla/gecko-dev/blob/master/dom/events/WheelEvent.cpp)
  (`DeltaModeCheckingState` : l'ordre de lecture change les valeurs ;
  `kTrustedDeltaToWheelDelta = 3.0`),
  [`WinMouseScrollHandler.cpp`](https://github.com/mozilla/gecko-dev/blob/master/widget/windows/WinMouseScrollHandler.cpp).
- [`normalize-wheel`](https://github.com/basilfx/normalize-wheel/blob/master/src/normalizeWheel.js)
  (`LINE_HEIGHT = 40`, `PAGE_HEIGHT = 800`).
- deck.gl / [`mjolnir.js`](https://github.com/visgl/mjolnir.js/blob/master/src/inputs/wheel-gesture-session.ts) :
  classification par *session*, suivi de `Control` en phase de capture avec réinitialisation
  sur `blur`, correctif Retina Firefox.
- [Excalidraw `App.tsx`](https://github.com/excalidraw/excalidraw/blob/master/packages/excalidraw/components/App.tsx)
  (clamp `MAX_STEP`, atténuation `Math.min(1, absDelta / 20)`) ·
  [tldraw `normalizeWheel.ts`](https://github.com/tldraw/tldraw/blob/main/packages/editor/src/lib/utils/normalizeWheel.ts)
  et [`useGestureEvents.ts`](https://github.com/tldraw/tldraw/blob/main/packages/editor/src/lib/hooks/useGestureEvents.ts)
  (`!isIos && 'GestureEvent' in window`).
- [danburzo — *DOM gestures*](https://danburzo.ro/dom-gestures/) ·
  [kenneth.io — *Detecting multi-touch trackpad gestures*](https://kenneth.io/post/detecting-multi-touch-trackpad-gestures-in-javascript).
- [Microsoft — Windows Precision Touchpad devices](https://github.com/MicrosoftDocs/win32/blob/docs/desktop-src/w8cookbook/windows-precision-touchpad-devices.md)
  (`delta = 1` en mode ultra-haute précision, d'où les `deltaY` fractionnaires).
- StackOverflow — [*Detect touchpad vs mouse*](https://stackoverflow.com/questions/10744645/detect-touchpad-vs-mouse-in-javascript) ·
  [*Trackpad pinch causes wheel event with ctrlKey*](https://stackoverflow.com/questions/74312612/trackpad-pinch-causes-wheel-js-event-with-ctrlkey-true-how-to-tell-if-the-u)
  (toujours sans réponse) ·
  [*Height of a line in DOM_DELTA_LINE*](https://stackoverflow.com/questions/20110224/what-is-the-height-of-a-line-in-a-wheel-event-deltamode-dom-delta-line).

### Confort, accessibilité

- W3C — [SC 2.1.1 Keyboard](https://www.w3.org/WAI/WCAG22/Understanding/keyboard.html) ·
  [SC 2.5.7 Dragging Movements](https://www.w3.org/WAI/WCAG22/Understanding/dragging-movements.html) ·
  [SC 2.3.3 Animation from Interactions](https://www.w3.org/WAI/WCAG22/Understanding/animation-from-interactions.html) ·
  [XR Accessibility User Requirements](https://www.w3.org/TR/xaur/) (REQ 13a : la remise à zéro
  de la vue est une exigence, pas un confort).
- MDN — [`prefers-reduced-motion`](https://developer.mozilla.org/en-US/docs/Web/CSS/@media/prefers-reduced-motion) ·
  [rôle ARIA `application`](https://developer.mozilla.org/en-US/docs/Web/Accessibility/ARIA/Roles/application_role).
- [Game Accessibility Guidelines — *Avoid VR simulation sickness triggers*](https://gameaccessibilityguidelines.com/avoid-vr-simulation-sickness-triggers/)
  (rotation par paliers de 30°, contrôle permanent de la caméra par le joueur, horizon constant).
- [Wikipedia — Virtual reality sickness](https://en.wikipedia.org/wiki/Virtual_reality_sickness)
  (relation curvilinéaire FOV ↔ nausée, asymptote au-delà de 140°).

### Logiciels de sculpture (schémas de contrôle)

- [Blender — Brush Settings](https://docs.blender.org/manual/en/latest/sculpt_paint/brush/brush_settings.html) (`F` + glissement).
- [Maxon ZBrush — Hotkeys](https://help.maxon.net/zbr/en-us/Content/html/user-guide/customizing-zbrush/hotkeys/hotkeys.html)
  (`S` + glissement ; molette assignable en option).
- [3D-Coat — Brushes, general use](https://3dcoat.com/documentation/manual/brush-components/brushes-alphas/)
  (`[` `]`, molette activable dans les préférences).
- [Nomad Sculpt — Camera](https://nomadsculpt.com/manual/camera) et
  [Interface](https://nomadsculpt.com/manual/interface) (curseur de rayon permanent).

### Documents du projet

- `docs/GAME-DESIGN.md` §3.0.1, §4.1 à §4.3 — le schéma de contrôles décidé.
- `docs/ARCHITECTURE.md` — la boucle et l'ordre des passes.
- `src/render/DioramaControls.js`, `src/tools/ToolManager.js`, `src/core/Game.js`,
  `src/core/Config.js`, `src/sim/VoxelField.js` (`raycast`, `surfaceHeightAt`).
- `tools/test-play.mjs` — le style des tests Puppeteer repris au §7.

### Réserves

Trois points du document reposent sur des sources partiellement inaccessibles au moment de la
rédaction et méritent une revérification avant d'être cités ailleurs :

1. Les taux de décélération d'`UIScrollView` (0,998 et 0,99 par milliseconde) proviennent de la
   documentation Apple, dont la page n'a pas pu être lue directement.
2. Les valeurs exactes de Fernandes & Feiner 2016 sur la réduction dynamique du champ de vision
   (le PDF est derrière un mur) — seul le principe est repris, pas les chiffres.
3. Les schémas de contrôle de Mudbox et de Substance Painter viennent de listes de raccourcis
   tierces, les documentations officielles bloquant l'accès automatisé.
