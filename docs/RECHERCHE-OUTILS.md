# RECHERCHE — LE SYSTÈME D'OUTILS

## Refonte ergonomique et paramétrique de la caisse à outils de Sandcastle

> **Objet.** Passer de « 10 outils avec un seul réglage (le rayon) » à un vrai
> système de brosses réglable, lisible et *cozy* — sans transformer le jeu en
> logiciel de CAO.
>
> **Portée.** `src/tools/tools.js`, `src/tools/ToolManager.js`,
> `src/tools/Brush.js`, `src/ui/HUD.js`, `src/ui/hud.css`,
> `src/render/SandMaterial.js` (bloc curseur).
>
> **Documents de référence internes.** `docs/GAME-DESIGN.md` §3.0 (grammaire
> commune), §3.1 (catalogue cible de 18 outils), §4.1 (schéma de contrôles),
> §5.2 (style visuel), §5.3 (feedbacks in-world), §9.3 (undo) —
> `docs/BIBLE-CHATEAUX-DE-SABLE.md` §3 (outillage réel des sculpteurs).
>
> **Version du doc :** 1.0 — document d'implémentation.

---

### AVERTISSEMENT SUR LES SOURCES

Le quota de recherche web de la session était épuisé au moment de la rédaction ;
les tentatives de récupération directe des manuels (`docs.blender.org`,
`docs.krita.org`) ont renvoyé des 403/404. Ce document s'appuie donc sur :

1. **La lecture intégrale du code existant** (c'est la partie qui compte le plus,
   et elle est de première main) ;
2. Les deux documents internes cités ci-dessus, qui contiennent déjà une
   spécification riche et cohérente ;
3. La connaissance des conventions établies dans ZBrush, Blender Sculpt, Krita,
   Photoshop, Substance Painter, Procreate, Cities: Skylines et The Sims.

**À faire avant publication ailleurs :** revérifier les valeurs numériques
attribuées à ces logiciels (marquées ⚠︎ dans le texte). Les *principes*
ergonomiques, eux, sont robustes et documentés depuis vingt ans. Le tableau des
correspondances de vocabulaire (§2.6) sert de pont : il permet de retrouver
rapidement les pages de manuel correspondantes.

---

## SOMMAIRE

1. [Diagnostic du système actuel](#1-diagnostic-du-système-actuel)
2. [Le modèle de paramètres](#2-le-modèle-de-paramètres)
3. [Comment on les règle](#3-comment-on-les-règle)
4. [Retour visuel du curseur](#4-retour-visuel-du-curseur)
5. [Courbes de fondu](#5-courbes-de-fondu)
6. [Ergonomie du geste](#6-ergonomie-du-geste)
7. [Interface](#7-interface)
8. [Plan d'implémentation ordonné](#8-plan-dimplémentation-ordonné)

---

# 1. DIAGNOSTIC DU SYSTÈME ACTUEL

## 1.1 Ce qui marche déjà, et qu'il ne faut surtout pas casser

Avant la liste des manques, il faut être juste : l'ossature est bonne, et
plusieurs décisions difficiles sont déjà prises correctement.

| Acquis | Où | Pourquoi c'est bien |
|---|---|---|
| **Un outil = un geste, pas une statistique** | commentaire d'en-tête de `tools.js` | C'est la bonne philosophie. Toute la refonte doit la préserver : on ajoute des réglages *de geste*, pas des « points de puissance ». |
| **Le clic droit est toujours l'inverse ou le complément** | tous les `apply(s)` | Convention interne déjà tenue à 10/10. Elle vaut de l'or : elle divise par deux le nombre d'outils à mémoriser. |
| **Toutes les écritures passent par `Brush.js`** | `EditContext.begin/end` | Un seul point de passage pour l'undo, le réveil granulaire et la file d'humidité. C'est ce qui rend la refonte *possible* : on peut changer le modèle de brosse sans toucher à la simulation. |
| **`captureChunk` est idempotent dans un groupe** | `UndoStack.js:70` (`if (g.chunks.has(ci)) return`) | Conséquence énorme : on peut appeler plusieurs opérations de brosse (symétrie, dabs multiples) dans un même geste sans corrompre l'instantané. La symétrie est donc gratuite côté undo. |
| **Ctrl verrouille l'altitude pendant un geste** | `ToolManager.raycast()` | C'est LA solution au problème « choisir une profondeur 3D avec une souris » (`GAME-DESIGN.md` §4.3). Déjà là. |
| **La molette règle le rayon, Ctrl+molette zoome** | `ToolManager.onWheel()` | Conforme à `GAME-DESIGN.md` §4.1.1, et c'est le bon arbitrage. |
| **Le rayon est réglé en échelle exponentielle** | `Math.exp(-e.deltaY * 0.0018)` | Bonne intuition : le rayon est une grandeur perceptuellement logarithmique. Passer de 5 à 6 cm et de 50 à 60 cm doivent « coûter » le même nombre de crans. |
| **Les bornes de rayon sont propres à chaque outil** | `radius: {min,max,def}` | Une mirette ne doit pas pouvoir faire 90 cm. Excellent. |
| **Un `hardness` existe déjà par appel** | `B.sphere(..., {hardness})` | Le paramètre est là — il est juste figé dans le code et jamais exposé. |

## 1.2 Les onze manques, par ordre de gravité

### M1 — Tous les paramètres sauf le rayon sont des constantes littérales

C'est le manque central, et il est massif. Un relevé exhaustif :

| Fichier / ligne | Constante | Ce qu'elle contrôle | Statut |
|---|---|---|---|
| `tools.js` pelle | `-220 * s.dt * 26` | vitesse de creusement | figée |
| `tools.js` pelle | `hardness: 0.3` | dureté du bord du trou | figée |
| `tools.js` pelle | `200 * s.dt * 26`, `packing * 0.35`, `hardness: 0.15` | dépôt de la pelletée | figées |
| `tools.js` pelle | `Math.min(tot, 0.35)` | contenance de la pelle (350 L… en m³ : 0,35 m³) | figée |
| `tools.js` main | `0.9 * s.dt * 9` | force de tassement | figée |
| `tools.js` main | `2.6 * s.dt * 9`, plafond `0.9` | force de lissage | figées |
| `tools.js` arrosoir | `0.55 * s.dt` / `-0.45 * s.dt` | débit d'humidification / séchage | figés |
| `tools.js` seau d'eau | `0.004 * s.dt` / `-0.0035 * s.dt` | débit (4 L/s) | figé |
| `tools.js` seau | `s.radius * 0.85`, `* 0.86`, `* 2.5`, `* 2.4`, `+0.25` | conicité, hauteur, capacité, gain de tassement | figées |
| `tools.js` truelle | `s.radius * 1.4` | profondeur de coupe | figée |
| `tools.js` truelle | `4.5 * s.dt * 18` | agressivité de la coupe | figée |
| `tools.js` mirette | `hardness: 0.85`, `255 * ...`, `packing: 0.6` | netteté, force, tassement du rebouchage | figées |
| `tools.js` râteau | `0.02 + s.tool.spacing * 0.25` | profondeur des rainures **couplée** à l'écartement | figée et couplée |
| `tools.js` gomme | `hardness: 0.2`, `200 * ...`, `packing: 0.2` | douceur, force, tassement du comblement | figées |
| `Brush.js:288` | `smoothstep(r * 0.72, r, rad)` | fondu du bord de la truelle | figé |
| `Brush.js:290` | `clamp(1 - sd, 0, 1)` | épaisseur de la transition de coupe (½ voxel) | figé |
| `Brush.js:194` | `0.72 / 0.28` | poids du laplacien dans le lissage | figé |
| `Brush.js:237` | `smoothstep(0.005, 0.05, w)` | seuil d'humidité du tassement | figé (physique — OK) |
| `Brush.js:322-323` | `wob = (1-q)*0.35`, `slump = (1-q)*hh*0.45` | dégradation du démoulage | figées (dérivées de la qualité — OK) |
| `Brush.js:405-406` | `0.15, 0.5` du profil de rainure | largeur du sillon | figée |

**Le seul outil qui a un deuxième réglage est le râteau** (`spacing`, via
`Maj+molette`), et **ce réglage est un secret** : la seule mention est dans
`hint2`. Le second est le variant de décoration, dans le même cas.

### M2 — Il n'y a pas de paramètre « intensité »

C'est la demande explicite du joueur. Aujourd'hui, pour creuser doucement, la
seule option est de **cliquer moins longtemps** — ce qui est un contrôle
temporel, pas un contrôle d'intensité. Conséquences :

- Impossible de faire une passe légère de mirette pour ébaucher un arc avant de
  l'affirmer ; le premier clic creuse déjà 255/255 de densité (`mirette`,
  `255 * clamp(s.dt*24*6, 0, 1)` → saturé dès `dt > 7 ms`).
- Impossible de faire un lissage « à peine » : la main lisse à `2.6 * dt * 9`
  plafonné à 0,9, soit près de la valeur maximale à chaque dab.
- Le geste n'a pas de **dynamique** : pas de montée en puissance, pas de
  différence entre effleurer et appuyer.

### M3 — La fonction de fondu est rudimentaire et non exposée

```js
// Brush.js:72
function falloff(d, r, hardness) {
  if (d >= r) return 0;
  const t = d / r;
  const soft = 1 - t * t;
  const hard = smoothstep(1, 1 - Math.max(0.06, 1 - hardness), t);
  return soft * (1 - hardness) + hard * hardness;
}
```

Trois problèmes :

1. **Le mélange linéaire de deux courbes de familles différentes est instable.**
   À `hardness = 0.5`, on obtient la moyenne d'une parabole et d'un smoothstep
   décalé — une courbe qui n'a d'intérêt ni géométrique ni perceptuel, et dont
   la dérivée seconde change de signe deux fois. Visuellement : un léger
   « épaulement » dans le bord de la brosse.
2. **`hardness` ne fait pas ce que son nom promet.** Dans tous les logiciels de
   référence, *hardness* (Photoshop) / *Focal Shift* (ZBrush) / *falloff* +
   *hardness* (Blender) déplace le **rayon du plateau central** : à hardness
   élevé, le centre est plat sur 80 % du rayon puis chute d'un coup. Ici, il
   interpole une forme. Le joueur qui vient d'un autre logiciel est trompé.
3. **Il n'y a qu'une forme.** Pas de « plateau » (indispensable pour le tassement
   et le lissage : on veut une action uniforme sous la paume), pas de « pointue »
   (indispensable pour la mirette et le pointeau), pas de « linéaire »
   (indispensable quand on veut prédire le résultat).

De plus, `smooth()` (ligne 181) et `compact()` (ligne 232) **passent des
hardness codés en dur** (`0.15` et `0.25`) au lieu du hardness de l'outil.

### M4 — La cadence est temporelle, pas spatiale

```js
// ToolManager.update()
const period = 1 / (this.current.rate || 12);
this.accumulator += dt;
while (this.accumulator >= period && n < 4) { ... }
```

C'est **le défaut ergonomique le plus visible du jeu**. Les conséquences :

- **Souris immobile → l'outil continue d'agir.** Pour une pelle ou une mirette
  c'est faux : on creuse un puits en restant appuyé sans bouger. Seuls
  l'arrosoir et le seau d'eau ont vraiment un comportement d'*aérographe*.
- **Souris rapide → des paquets espacés.** À 20 cm/s de curseur et 14 Hz, deux
  applications de pelle sont espacées de 1,4 cm : dense. À 2 m/s (un geste
  rapide, très courant), elles sont espacées de 14 cm — soit **presque un
  diamètre entier** au rayon par défaut de 16 cm. On obtient un chapelet de
  trous au lieu d'une tranchée. C'est exactement le symptôme décrit par le
  joueur (« des paquets quand on bouge vite »).
- **`n < 4` crée un plafond dépendant de la machine.** À 30 fps avec une cadence
  de 30 Hz (seau d'eau), le plafond de 4 est atteint : la quantité d'eau versée
  par seconde dépend du framerate. C'est précisément ce que le commentaire
  affirme éviter.
- **`applyOnce` utilise toujours `this.hit`, jamais un point interpolé.** Il n'y
  a aucun échantillonnage le long du trajet.
- **`stroke.lastPoint` est écrit mais jamais lu.** L'infrastructure du geste
  existe à moitié : on note d'où on vient, mais on ne s'en sert pas.

### M5 — Zéro préréglage, zéro persistance

Rien n'est mémorisé. Pire : **`select()` réinitialise le rayon à chaque
changement d'outil** (`this.radius = t.radius.def`). Le joueur qui règle sa
mirette à 3 cm, passe à la truelle et revient, retrouve 5,5 cm. C'est une
punition pour avoir exploré. Et `this.radius` est **une seule variable partagée**
au lieu d'un état par outil.

Le râteau, lui, stocke son `spacing` **sur l'objet du catalogue**
(`t.spacing = ...`, ligne 170 de `ToolManager`) — c'est-à-dire sur un singleton
exporté. Ça marche par accident, mais ça mélange définition et état, et ça
interdit d'avoir plusieurs préréglages du même outil.

### M6 — Aucun retour visuel des réglages

- Le curseur 3D est **un anneau, point** (`SandMaterial.js:322-330`) : un seul
  cercle, épaisseur fixe, opacité fixe. Il ne montre ni l'intensité, ni la
  dureté, ni la direction, ni le risque.
- Le HUD affiche `${Math.round(radius*100)} cm` dans `.ti-size`. C'est tout.
- L'écartement du râteau n'apparaît que dans le texte de `hint` :
  `(ecart ${Math.round(tool.spacing*100)} cm)`.
- `GAME-DESIGN.md` §3.0.4 spécifie pourtant : anneau extérieur = rayon, anneau
  intérieur pointillé = hardness, flèche = normale, prévisualisation fantôme,
  jauge de stabilité en arc. **Rien de tout ça n'est implémenté.**

### M7 — Pas de symétrie

Aucune trace dans le code. `GAME-DESIGN.md` §3.1 la liste (outil n°17,
touches `X` / `Y` / `Maj+X`) et §4.1.2 réserve les touches. Pour un château —
objet **par nature symétrique** (quatre tours, une façade, des créneaux
réguliers) — c'est le manque fonctionnel le plus coûteux en temps de joueur.

### M8 — Granularité d'annulation grossière

Un groupe = un `pointerdown`→`pointerup` (`GAME-DESIGN.md` §9.3 le confirme
comme voulu). Mais :

- **Un geste de 8 secondes = un seul undo.** Un joueur qui ratisse une façade
  pendant dix secondes et trouve la dernière moitié ratée perd tout.
- **Le coût mémoire est brutal** : `BYTES_PER_CHUNK = 32³ × 4 = 131 072 o`. Un
  geste balayant une bande de 2 m touche facilement 12 chunks → **1,5 Mo par
  geste**. Avec 64 Mo de budget, environ **42 gestes d'historique**. Un joueur
  attentif en fait 300 par session.
- `trim()` supprime les gestes les plus anciens — donc l'historique long est
  perdu en silence.
- Il n'y a **pas de sous-découpage temporel** : les logiciels de peinture
  découpent un trait très long en plusieurs entrées après N secondes ou N dabs
  (ou proposent un « undo par dab » optionnel).
- Un `Ctrl+Z` pendant un geste en cours (bouton maintenu) n'interrompt pas le
  geste : `undo()` appelle `endGroup()` puis restaure, et le geste continue
  d'écrire dans le vide — comportement non défini.

### M9 — Modificateurs sous-employés et incohérents

| Modificateur | Statut actuel |
|---|---|
| `Maj` | Sert de « modificateur d'outil », mais **seule la truelle l'utilise** (coupe horizontale). Sur les 9 autres outils : sans effet. |
| `Maj + molette` | Utilisé pour l'écartement du râteau et le variant de déco. Pas de logique générale. |
| `Alt` | **`ToolManager.onDown()` fait `if (e.altKey) return;`** — Alt annule purement l'outil (priorité caméra). `Alt+molette` n'est pas capté ici : `onWheel` ne teste pas `altKey`, donc Alt+molette règle… le rayon. Alors que `GAME-DESIGN.md` §4.1.1 réserve `Alt+molette` pour la force. |
| `Ctrl` | Verrou d'altitude. Bon. Mais `s.ctrl` est lu dans `makeState` et **aucun outil ne s'en sert** dans son `apply`. |
| `Maj` (verrou de direction) | Annoncé dans le commentaire d'en-tête de `ToolManager` (« Maj verrouille la direction du geste sur l'axe dominant ») — **non implémenté**. |
| `Espace`, `Tab`, `E`, `V`, `X`, `Y` | Réservés par `GAME-DESIGN.md`, non implémentés. |

Il y a donc un **écart documenté/implémenté** qui se voit dans l'aide (`HELP_HTML`
promet « Maj — modificateur d'outil » de façon générique parce qu'il n'y a rien
de précis à dire).

### M10 — Pas de support stylet ni de pression

`ToolManager` écoute des `PointerEvent` mais n'utilise que `clientX/clientY` et
`button`. Sont ignorés : `pressure`, `pointerType`, `tiltX/tiltY`, `twist`, et
surtout **`getCoalescedEvents()`** — ce dernier est un manque réel : à 120 Hz de
tablette et 60 fps de rendu, on perd la moitié des points du trajet.

### M11 — Pas de plafond de dose, donc pas de « douceur »

`clamp(s.dt * 24 * 6, 0, 1)` sature pour tout `dt` réaliste. Autrement dit,
plusieurs outils appliquent **leur effet maximum à chaque dab**, quel que soit
le contexte. Il n'y a pas de notion de « dose par dab » distincte de « dose par
seconde », ce qui est précisément la distinction *flow / opacity* des logiciels
de peinture (§2.4).

## 1.3 Synthèse : la cause racine

Les onze manques ont **une seule cause** : il n'existe pas d'objet
« paramètres d'outil ». Les valeurs vivent dans le corps des fonctions `apply`,
donc :

- on ne peut pas les afficher (M6),
- on ne peut pas les régler (M1, M2),
- on ne peut pas les sauvegarder (M5),
- on ne peut pas les partager entre outils (M3),
- et la boucle d'application n'a rien à consulter pour décider d'un espacement
  (M4).

**Toute la refonte découle de la création de cet objet.** C'est l'étape 1 du
plan (§8), et elle est mécanique : ~200 lignes, aucun changement de
comportement visible tant qu'on garde les valeurs actuelles par défaut.

---

# 2. LE MODÈLE DE PARAMÈTRES

## 2.1 Principe directeur : trois niveaux d'exposition

Le piège d'un système de brosses est d'exposer tout ce qui existe. Blender
Sculpt affiche une trentaine de champs par brosse ; c'est un outil de
professionnel et c'est légitime. Sandcastle est un jeu cozy : `GAME-DESIGN.md`
§1 pose « zéro friction d'entrée, profondeur optionnelle » et « aucun chiffre
brut » (§5, en-tête de `HUD.js`).

D'où **la règle des trois niveaux** :

| Niveau | Nom | Visibilité | Budget |
|---|---|---|---|
| **N1 — Vif** | Réglages du geste | Toujours visibles, réglables sans ouvrir de panneau (molette, modificateurs, cadran 2D) | **Exactement 2** : Rayon, Force |
| **N2 — Panneau** | Réglages de caractère | Dans le panneau contextuel de l'outil, fermé par défaut | **Au plus 4** par outil |
| **N3 — Interne** | Réglages de simulation | Jamais exposés. Constantes ou dérivés. Modifiables par la console pour le tuning. | illimité |

**Total maximum affiché par outil : 6 curseurs.** C'est le seuil au-delà duquel
un panneau cesse d'être lisible d'un coup d'œil (au-delà de ~7 éléments on
scanne au lieu de percevoir). Aucun outil du catalogue n'en a besoin de plus.

Un corollaire important : **un paramètre N2 doit changer le *caractère* de
l'outil, pas sa dose.** Si tourner un curseur ne fait que « plus / moins », il
appartient à N1 (donc c'est la Force) ou à N3 (donc c'est une constante).

## 2.2 Les paramètres COMMUNS

Six paramètres partagés par tous les outils. Ils vivent dans une classe
`ToolParams` unique, ce qui garantit que « Force » veut dire la même chose
partout — c'est la moitié de la valeur ergonomique du système.

### Tableau de référence

| Clé | Nom affiché | Plage | Défaut | Courbe | Niveau |
|---|---|---|---|---|---|
| `radius` | **Rayon** | par outil (2 cm → 90 cm) | par outil | log, ×1,10 / cran | N1 |
| `strength` | **Force** | 0,05 → 1,00 | par outil (0,55 typique) | perceptuelle `x^1.6` | N1 |
| `hardness` | **Bord** | 0,00 → 0,95 | par outil (0,35) | linéaire | N2 |
| `curve` | **Profil** | 6 valeurs nommées | par outil (`lisse`) | énumération | N2 |
| `step` | **Pas** | 0,05 → 1,00 (× rayon) | 0,25 | log | N2 |
| `secondary` | **Clic droit** | énumération courte | par outil | énumération | N2 |

### 2.2.1 `radius` — **Rayon**

**Ce qu'il change dans `Brush.js` :** c'est le `radius` déjà passé à toutes les
opérations. Il devient `r = radius / VOXEL` et borne à la fois la boîte
`ctx.begin(...)` et l'argument de `falloff(d, r, ...)`.

**Plage :** conservée telle quelle par outil (`radius: {min, max, def}` dans
`tools.js`). Elle est bien calibrée et reflète des réalités physiques : la
mirette monte à 20 cm parce qu'au-delà ce n'est plus une mirette (BIBLE §3.3.2 :
« creusement contrôlé : niches, fenêtres, cavités »), la gomme monte à 90 cm
parce que c'est une gomme.

**Courbe :** logarithmique, déjà en place (`Math.exp(-deltaY * 0.0018)`).
Recommandation : passer à un **pas discret** de ×1,10 par cran plutôt qu'un
facteur continu proportionnel à `deltaY`. Raison : `deltaY` vaut 100 sur une
souris Windows, 3 sur un trackpad macOS, 53 sur certains pilotes Logitech. Le
code actuel donne donc une sensibilité qui varie d'un facteur 30 selon le
matériel. Le pas discret rend le réglage **reproductible** — le joueur apprend
« trois crans = +33 % » et cette connaissance devient de la mémoire musculaire.

```js
// remplace this.radius * Math.exp(-e.deltaY * 0.0018)
const clicks = wheelClicks(e);            // normalise deltaMode et deltaY
setRadius(radius * Math.pow(1.10, clicks));
```

**Coût mémoire de la boîte.** À noter pour le tuning : la boucle de `sphere` est
en O(r³). Passer de 16 cm à 32 cm de rayon multiplie le travail par 8 (à 4 cm de
voxel : 8³ = 512 voxels contre 4096). Le plafond de 90 cm de la gomme
correspond à ~45³ ≈ 91 000 voxels par dab. C'est acceptable une fois par dab,
pas quatre fois — d'où l'importance de l'espacement (§6).

### 2.2.2 `strength` — **Force**

C'est **le paramètre manquant demandé par le joueur.** Il multiplie la dose de
chaque dab.

**Ce qu'il change dans `Brush.js`, opération par opération :**

| Opération | Ce que `strength` multiplie | Formule proposée |
|---|---|---|
| `sphere(…, amount, …)` | l'argument `amount` | `amount = sign * AMOUNT_MAX[tool] * dose` |
| `smooth(…, strength)` | l'argument `strength` (le taux de convergence vers la moyenne locale) | `strength = clamp(SMOOTH_MAX * dose, 0, 0.95)` |
| `compact(…, strength)` | le gain de packing **et** le gain de densité | `strength = PACK_MAX * dose` |
| `planeCut(…, strength)` | le taux d'interpolation vers le demi-espace coupé | `strength = clamp(CUT_MAX * dose, 0, 1)` |
| `rake(…, depth)` | la profondeur des sillons (`dp * 110` ligne 411) | `depth = grooveDepth * dose` |
| `stampBucket` | **rien** — c'est un outil à deux temps, la Force sert à la vitesse de remplissage | remplissage : `fillRate * dose` |

où **`dose`** est la quantité pour **un dab**, définie en §2.4 :

```js
dose = perceptual(strength) * pressure * speedDamp
perceptual(s) = Math.pow(s, 1.6)
```

**Pourquoi `x^1.6` et pas `x`.** Les logiciels de sculpture exposent tous une
force linéaire de 0 à 100 %, et tous les utilisateurs travaillent entre 5 % et
25 %. C'est le signe classique d'un mauvais mappage : la moitié utile du curseur
est écrasée dans son premier quart. En appliquant `x^1.6` (⚠︎ exposant à tuner
entre 1,4 et 2,0 en playtest), un curseur au milieu (0,5) donne une dose de
0,33 : la zone « douce » occupe la moitié gauche de la course, ce qui est
perceptuellement correct.

**Défauts par outil.** Réglés pour que `strength = 0,55` reproduise *exactement*
le comportement actuel — non-régression garantie :

```
AMOUNT_MAX (sphere)     dose(0.55) = 0.55^1.6 ≈ 0.386
pelle creuse   : -220 * 26 * dt_ref  →  AMOUNT_MAX = 220*26/0.386 ≈ 14 800  (par seconde)
```

En pratique on ne fera pas ce calcul à la main : l'étape 1 du plan (§8) écrit
littéralement les constantes actuelles dans `AMOUNT_MAX`, met `strength: 1.0`
partout, vérifie visuellement l'iso-comportement, puis abaisse les défauts à
0,55 en divisant `AMOUNT_MAX` par `0.55^1.6`. C'est une refonte à risque nul.

**Exposition :** N1, toujours. C'est la demande explicite du joueur.

### 2.2.3 `hardness` — **Bord**

**Sémantique retenue : le rayon du plateau central**, exactement comme le
*Focal Shift* de ZBrush (⚠︎ échelle −100…+100 dans ZBrush, mappée ici sur
0…0,95) et comme le *Hardness* de Photoshop.

```
hardness = 0     → aucun plateau, le fondu commence au centre  (brosse « aérographe »)
hardness = 0.5   → plein effet jusqu'à 50 % du rayon, puis fondu
hardness = 0.95  → bord quasi net, arête franche (emporte-pièce)
```

**Ce qu'il change dans `Brush.js` :** c'est le paramètre `h` de la nouvelle
fonction `falloff(t, h, curve)` (§5). Il ne change **que** le profil de fondu —
jamais l'amplitude au centre. C'est ce qui le rend orthogonal à la Force, et
donc apprenable.

**Nom affiché : « Bord ».** Pas « Dureté » : en français, « dureté » évoque la
résistance du sable, pas la netteté de la brosse. Les deux extrémités du curseur
sont étiquetées **« fondu »** et **« net »**, avec une vignette qui montre le
profil (§7.3).

**Exposition :** N2. Un joueur de trois heures ne l'ouvrira jamais ; un joueur de
trente heures ne pourra plus s'en passer (c'est ce qui sépare une fenêtre nette
d'un trou flou).

**Ce qu'il faut corriger tout de suite :** `smooth()` et `compact()` codent en
dur `0.15` et `0.25`. Ils doivent recevoir le hardness de l'outil.

### 2.2.4 `curve` — **Profil**

Six formes nommées, détaillées en §5 :

| Valeur | Nom affiché | Silhouette | Sert à |
|---|---|---|---|
| `plate` | **Galette** | ▁▇▇▇▇▁ convexe | tassement, lissage à plat |
| `lisse` | **Lisse** | douce, symétrique (smoothstep) | défaut universel |
| `lineaire` | **Linéaire** | rampe droite | prévisible, cônes propres |
| `pointue` | **Pointue** | pic étroit | mirette, pointeau, détail |
| `franche` | **Franche** | quasi carrée | emporte-pièce, plans nets |
| `douce` | **Voile** | très étalée, presque plate au bord | arrosoir, brumisation |

**Ce qu'il change dans `Brush.js` :** le corps de `falloff`. Une seule fonction,
un `switch` sur un petit entier, aucun coût mesurable (le `switch` est hors
boucle : on capture la fonction une fois avant la triple boucle).

**Exposition :** N2, mais **sous forme de six vignettes cliquables**, pas d'un
menu déroulant. Le profil est une *forme* : il doit se choisir par sa silhouette.

### 2.2.5 `step` — **Pas** (espacement)

Distance entre deux applications successives, **exprimée en fraction du rayon**.
C'est le paramètre qui remplace `rate`.

```
step = 0.05  → 20 dabs par diamètre : trait continu, lourd en CPU
step = 0.25  → 8 dabs par diamètre : défaut, continu et fluide  (⚠︎ Krita ~0,1 ; Blender ~0,1 ; Photoshop 25 %)
step = 1.00  → 1 dab par diamètre : chapelet visible, utile pour les motifs
```

**Ce qu'il change :** rien dans `Brush.js` — c'est la boucle de `ToolManager`
qui le consulte (§6.1). Mais il change tout au ressenti.

**Exposition :** N2 pour la plupart des outils. **N1 pour le râteau et la
décoration** (où il devient un paramètre de motif : « un créneau tous les
20 cm »), sous le nom **« Espacement »**.

**Cas particulier des outils continus.** L'arrosoir et le seau d'eau doivent
continuer d'agir souris immobile (ce sont des débits). Ils ont donc un mode
`stroke: 'airbrush'` (§6.1) où `step` est ignoré au profit d'une cadence
temporelle — le comportement actuel, mais assumé et déclaré au lieu d'être subi.

### 2.2.6 `secondary` — **Clic droit**

Le seul paramètre commun qui n'est pas un nombre. Il déclare **ce que fait le
bouton secondaire**, parmi une énumération courte :

| Valeur | Sens | Outils qui l'ont par défaut |
|---|---|---|
| `invert` | même opération, signe inversé | mirette, gomme, arrosoir, seau d'eau |
| `smooth` | lisse la surface | main, truelle, râteau |
| `deposit` | dépose ce qui est porté | pelle |
| `remove` | retire l'objet posé | décoration |
| `release` | déclenche le 2ᵉ temps sans le 1ᵉʳ | seau |
| `pick` | prélève les réglages depuis la surface visée | *(nouveau, §3.5)* |

**Pourquoi l'exposer.** Deux raisons. D'abord, c'est **le seul moyen d'obtenir
le lissage sur tous les outils** sans ajouter un onzième bouton : un sculpteur
lisse en permanence (BIBLE §3.3.3 : le pinceau souple « retire les grains ET
adoucit la surface » est utilisé après chaque passe). Ensuite, ça rend visible
une convention déjà tenue par le code — la rendre explicite est de la pédagogie
gratuite.

**Contrainte :** la liste proposée par outil est courte (2 à 3 valeurs
pertinentes), jamais les six. On ne propose pas `release` sur la pelle.

**Exposition :** N2, sous forme de deux ou trois pastilles, pas d'un menu.

## 2.3 Les paramètres PROPRES, outil par outil

Format des fiches : `clé` — **Nom** · plage · défaut · courbe · **effet exact
dans `Brush.js`** · niveau.

---

### 🥄 Pelle (`shovel`)

| Clé | Nom | Plage | Déf. | Courbe | Effet dans `Brush.js` | Niv. |
|---|---|---|---|---|---|---|
| `capacity` | **Contenance** | 5 → 40 L | 12 L | log | plafond de `g.carried.volume` (aujourd'hui `0.35` m³ = 350 L, valeur manifestement erronée d'un facteur 30) | N2 |
| `throw` | **Portée de rejet** | 0 → 2,0 × rayon | 0,35 | linéaire | décalage du centre de dépôt : aujourd'hui `p.y + s.radius*0.35` (vertical) ; devient un décalage **le long de la direction du geste**, projeté au sol, conforme à `GAME-DESIGN.md` §3.0.3 politique `PILE_ADJACENT` | N2 |
| `loosePacking` | tassement du sable rejeté | 0,1 → 0,6 | 0,35 | — | `packing: carried.packing * loosePacking` | **N3** |
| `digHardness` | — | — | 0,30 | — | remplacé par le `hardness` commun | supprimé |

**Notes.** `capacity` mérite N2 : c'est un choix de style de jeu (grosse pelle =
terrassement rapide, petite pelle = précision), et c'est parlant. `throw` est le
paramètre qui rend la conservation de matière *visible* et donc crédible : à 0
on rebouche son propre trou, à 2,0 on fait un remblai propre à côté.

---

### ✋ Main (`hand`)

| Clé | Nom | Plage | Déf. | Courbe | Effet dans `Brush.js` | Niv. |
|---|---|---|---|---|---|---|
| `flatten` | **Étalement** | 0,3 → 1,6 | 1,0 | linéaire | **anisotropie verticale** de la brosse : `dy` est divisé par `flatten` avant le calcul de `d`. À 0,3 la main est une galette large et plate (BIBLE §2.2 *pancake method*) ; à 1,6 c'est un poing qui enfonce | N2 |
| `vibrate` | **Vibration** | 0 → 1 | 0,25 | linéaire | fait remonter l'eau : ajoute `+vibrate * 0.04` à `F.moisture[i]` **de la couche supérieure** et `-` en dessous. Reproduit « tapoter la paroi → vibrer, faire remonter l'eau » (BIBLE §3.7) | N2 |
| `packDepth` | profondeur d'action du tassement | — | 0,8 × rayon | — | `compact` agit dans une demi-sphère orientée vers le bas, pas une sphère complète | **N3** |
| `smoothMix` | poids du laplacien | 0,5 → 0,9 | 0,72 | — | ligne 194 de `Brush.js` (`avg = sum/n * 0.72 + cur * 0.28`) | **N3** |

**Notes.** `flatten` est le meilleur candidat « paramètre de caractère » du jeu :
un seul curseur transforme la main en dame (BIBLE §3.1 : plaque de 15–20 cm,
lâchée verticalement) ou en poing. Il justifie à lui seul l'existence du panneau.
`vibrate` est cher en crédibilité pour trois lignes de code.

---

### 🌱 Arrosoir (`can`)

| Clé | Nom | Plage | Déf. | Courbe | Effet | Niv. |
|---|---|---|---|---|---|---|
| `flow` | **Débit** | 0,05 → 1,5 L/s | 0,35 | log | remplace `0.55 * s.dt` dans `moisture.wetSphere` | **N1** (il *est* la Force pour cet outil) |
| `pattern` | **Buse** | `brume` \| `pomme` \| `jet` | `pomme` | énum | préréglage lié qui écrit `hardness` et `depth` : brume → `hardness 0.05, depth 0.02 m` ; pomme → `0.35, 0.08` ; jet → `0.85, 0.30` | N2 |
| `depth` | **Pénétration** | 1 → 40 cm | 8 cm | log | l'humidification est aujourd'hui une **sphère** centrée sur le point ; elle doit devenir un **cylindre vertical** de profondeur `depth` depuis la surface. C'est ce qui fait la différence entre « mouiller la peau » et « détremper » | N2 |

**Notes.** Pour l'arrosoir, la Force **est** le débit : les deux curseurs N1
fusionnent, et le panneau n'en montre qu'un, étiqueté « Débit », en L/s. Traduire
un paramètre abstrait en unité du monde est la meilleure façon de le rendre
compréhensible sans explication (BIBLE §3.4 : pulvérisateur 0,5–1 L, buse
réglable en brouillard fin — « ⚠️ toujours en brouillard, jamais en jet »).

Le `pattern` est un **préréglage encapsulé** : trois pastilles qui écrivent
plusieurs paramètres d'un coup. C'est le bon compromis entre lisibilité et
puissance, et le patron à réutiliser partout (§3.5).

---

### 🪣 Seau d'eau (`water`)

| Clé | Nom | Plage | Déf. | Courbe | Effet | Niv. |
|---|---|---|---|---|---|---|
| `flow` | **Débit** | 0,5 → 20 L/s | 4 L/s | log | `water.pour(x, z, r, flow * dt / 1000)` — remplace le `0.004` littéral | **N1** |
| `spread` | **Étalement** | 0,4 → 1,4 × rayon | 1,0 | linéaire | rayon effectif de la colonne d'eau versée | N2 |
| `soakRatio` | part de l'eau qui imbibe au lieu de ruisseler | 0 → 0,6 | 0,25 | — | fraction transférée à `moisture` plutôt qu'à `water` | **N3** |

**Notes.** Le commentaire du code (« La première version débitait 66 L/s — de
quoi noyer une douve en un clic ») est exactement l'argument pour exposer ce
paramètre : le bon débit dépend de ce qu'on fait. Remplir une douve de 3 m ≠
faire une flaque de 20 cm.

---

### 🏰 Seau (`bucket`)

| Clé | Nom | Plage | Déf. | Courbe | Effet dans `stampBucket` | Niv. |
|---|---|---|---|---|---|---|
| `taper` | **Conicité** | 0,55 → 1,05 | 0,86 | linéaire | `rTop = rBottom * taper` (aujourd'hui `r * 0.86` en dur). À 1,05 → cylindre légèrement évasé (tube PVC, BIBLE §3.2) ; à 0,55 → cône marqué (seau de plage) | **N1** |
| `height` | **Hauteur** | 1,2 → 4,0 × rayon | 2,5 | linéaire | `h = r * height * t.fill` (aujourd'hui `2.5`) | **N1** |
| `crenels` | **Créneaux** | 0 → 12 | 0 | entier | découpe `crenels` encoches régulières au sommet du tronc de cône. Une soustraction angulaire : `if (crenels > 0 && frac(ang/(2π)*crenels) < 0.42 && t > 0.86) skip` | N2 |
| `fillRate` | vitesse de remplissage | — | 180×30 | — | actuel `-180 * s.dt * 30` | **N3** |
| `packBonus` | gain de tassement au démoulage | 0,1 → 0,4 | 0,25 | — | `packing = clamp(t.fillPack + packBonus, 0, 1)` | **N3** |

**Notes.** Pour le seau, la Force commune ne sert à rien (c'est un outil à deux
temps). Les deux N1 deviennent donc **Conicité** et **Hauteur** : le curseur
« Force » est remplacé dans le HUD par ces deux-là. C'est autorisé par le
modèle — N1 signifie « deux réglages toujours accessibles », pas « toujours les
mêmes deux ».

`crenels` est le meilleur rapport plaisir/effort de tout ce document. Trois
lignes dans `stampBucket`, et le joueur fabrique une tour de château au lieu
d'un tas conique.

---

### 🔪 Truelle (`trowel`)

| Clé | Nom | Plage | Déf. | Courbe | Effet dans `planeCut` | Niv. |
|---|---|---|---|---|---|---|
| `depth` | **Profondeur de coupe** | 0,3 → 4,0 × rayon | 1,4 | log | l'argument `depth` (aujourd'hui `s.radius * 1.4`). Contrôle jusqu'où derrière le plan la matière est retirée | **N1** (2ᵉ curseur, à côté du Rayon) |
| `plane` | **Plan** | `camera` \| `horizontal` \| `normale` \| `verrouillé` | `camera` | énum | choisit `(nx,ny,nz)`. `normale` = plan tangent à la surface visée (rabotage) ; `verrouillé` = le plan est figé au `pointerdown` et ne bouge plus de tout le geste — **c'est ce qui permet une vraie façade plane** | N2 |
| `bevel` | **Biseau** | 0° → 45° | 0° | linéaire | incline le plan de `bevel` degrés autour de l'axe horizontal du geste. Fait les fruits de mur et les corniches (BIBLE §3.3.1 truelle margée : « corniches, bandeaux ») | N2 |
| `edgeSoft` | douceur du bord du disque | 0,5 → 0,95 | 0,72 | — | ligne 288 : `smoothstep(r * edgeSoft, r, rad)` | **N3** (piloté par `hardness`) |
| `cutWidth` | épaisseur de la transition | 0,3 → 2,0 voxel | 1,0 | — | ligne 290 : `clamp(1 - sd/cutWidth, 0, 1)` | **N3** |

**Notes.** `plane: 'verrouillé'` est la fonctionnalité la plus demandée
implicitement : aujourd'hui, le plan est recalculé à chaque dab depuis la
direction caméra, donc si la caméra bouge d'un degré pendant le geste la face
n'est plus plane. Le verrouillage au `pointerdown` corrige un bug latent autant
qu'il ajoute une fonction.

`depth` en N1 est justifié : c'est le paramètre qu'on change constamment quand
on taille (effleurer vs trancher), au même titre que le rayon.

---

### 🥄 Mirette (`carve`)

| Clé | Nom | Plage | Déf. | Courbe | Effet | Niv. |
|---|---|---|---|---|---|---|
| `profile` | **Forme** | `boucle` \| `demi-sphère` \| `U` \| `V` | `boucle` | énum | change la primitive : `boucle` = `sphere` (actuel) ; `demi-sphère` = `sphere` tronquée par le plan tangent, un appui-rotation et la niche est faite (BIBLE §3.3.2 *melon baller*) ; `U` = capsule le long du geste ; `V` = deux plans sécants (`planeCut` ×2) | **N1** (2ᵉ curseur, en pastilles) |
| `plunge` | **Plongée** | 0 → 3,0 × rayon | 1,0 | log | décalage du centre **le long de la normale, vers l'intérieur** : `p - n * plunge * r`. Permet de creuser profond avec une petite ouverture (ébrasement d'une meurtrière) | N2 |
| `refillPacking` | tassement du rebouchage | — | 0,6 | — | ligne `packing: 0.6` | **N3** |

**Notes.** La mirette est l'outil de détail (BIBLE §3.7 : « 0,5–10 cm³, phase
détail »). Son `hardness` par défaut de 0,85 est déjà le bon choix et devient la
valeur par défaut du paramètre commun pour cet outil, avec `curve: 'pointue'`.

---

### 🌾 Râteau (`rake`)

| Clé | Nom | Plage | Déf. | Courbe | Effet dans `rake()` | Niv. |
|---|---|---|---|---|---|---|
| `pitch` | **Écartement** | 1,5 → 25 cm | 5 cm | log | argument `spacing` (à renommer pour ne pas collisionner avec le `step` commun) | **N1** (2ᵉ curseur) |
| `grooveDepth` | **Profondeur** | 0,3 → 5 cm | 1,2 cm | log | argument `depth` — aujourd'hui **couplé** à l'écartement (`0.02 + spacing * 0.25`), ce qui est un bug de design : on ne peut pas faire des rainures fines et espacées | N2 |
| `angle` | **Orientation** | −90° → +90° | 0° | linéaire | rotation de l'axe `u` autour de la normale. Aujourd'hui la direction est forcée à l'horizontale (`tx = -nz, ty = 0, tz = nx`) : impossible de faire des stries verticales ou en épi | N2 |
| `pattern` | **Motif** | `stries` \| `briques` \| `tuiles` \| `bois` | `stries` | énum | `briques` = décalage d'une demi-période une ligne sur deux + rainures perpendiculaires ; `tuiles` = arcs ; `bois` = bruit 1D superposé. Correspond à la truelle dentée demi-lune de la BIBLE §3.3.1 (« texture instantanée : joints de brique, ondulations, écailles, bois ») | N2 |
| `grooveWidth` | largeur du sillon | 0,1 → 0,45 | 0,15 | — | lignes 405-406, seuils du `smoothstep` | **N3** |

**Notes.** Le râteau est l'outil qui gagne le plus à la refonte : il passe d'un
paramètre secret à quatre réglages parlants qui produisent visuellement des
matériaux différents. Le découplage `pitch` / `grooveDepth` est une correction,
pas une addition.

⚠︎ Nommage : le champ `spacing` de `tools.js` doit être renommé `pitch` **dans
le même commit** que l'introduction du `step` commun, sinon confusion garantie.

---

### 🚩 Décoration (`decor`)

| Clé | Nom | Plage | Déf. | Courbe | Effet | Niv. |
|---|---|---|---|---|---|---|
| `variant` | **Objet** | 6 valeurs | 0 | énum | `props.place(variant, ...)` — existe déjà, mais uniquement via `Maj+molette`, non affiché | **N1** (grille de vignettes) |
| `scale` | **Taille** | 0,5 → 2,0 | 1,0 | log | échelle du prop posé | **N1** (2ᵉ curseur, remplace la Force) |
| `jitter` | **Dispersion** | 0 → 1 | 0,15 | linéaire | position/rotation aléatoire dans le rayon. À 0 : pose exacte. À 1 : semis naturel d'oyats | N2 |
| `align` | **Aplomb** | `normale` \| `vertical` | `normale` | énum | oriente le prop selon la normale de surface (coquillage) ou toujours vers le haut (drapeau, oyat) | N2 |

**Notes.** Combiné à `step` (renommé « Espacement » pour cet outil) et au **semis
le long du chemin** (§6.4), on obtient d'un coup la pose d'une haie d'oyats ou
d'une rangée de galets en un seul geste. C'est le meilleur exemple de la
puissance du modèle : trois paramètres génériques + un propre = une
fonctionnalité qui aurait demandé un outil dédié.

---

### 🧽 Gomme (`eraser`)

| Clé | Nom | Plage | Déf. | Courbe | Effet | Niv. |
|---|---|---|---|---|---|---|
| — | — | — | — | — | La gomme n'a **aucun paramètre propre**, et c'est volontaire | — |
| `fillPacking` | tassement du comblement | — | 0,2 | — | ligne `packing: 0.2` | **N3** |

**Notes.** La gomme est l'outil « je me suis trompé ». Elle doit rester le plus
simple du jeu : rayon, force, et c'est tout. Lui ajouter des réglages serait
contre-productif — on la prend justement quand on ne veut plus réfléchir.

---

## 2.4 La distinction Flow / Opacity, adaptée au sable

C'est la distinction la plus mal comprise des logiciels de peinture, et elle a
une traduction directe et utile ici.

| Photoshop | Sens | Traduction Sandcastle |
|---|---|---|
| **Flow** | dose déposée **par dab** | `dose` : ce que fait un seul dab |
| **Opacity** | plafond atteignable **par trait** | `strokeCap` : ce que le geste entier peut faire au maximum |

**Pourquoi c'est important ici.** Sans plafond de trait, repasser dix fois au
même endroit avec une force faible équivaut à une force forte : le réglage de
Force devient un réglage de patience, et l'outil n'a plus de caractère. Avec un
plafond de trait :

- **Force basse + plafond bas** = un outil qui *effleure* et refuse d'aller plus
  loin, quoi qu'on fasse. C'est le pinceau de finition, la brume de
  pulvérisateur.
- **Force basse + plafond haut** = un outil qui construit lentement mais peut
  tout faire. C'est le comportement actuel de tous les outils.

**Implémentation minimale et honnête.** Un plafond de trait exact demande un
masque « déjà touché » par voxel, coûteux en mémoire. Le compromis retenu :
un **plafond par colonne (x, z)** dans un `Float32Array` de la taille de la
grille, remis à zéro au `pointerdown` :

```js
// EditContext, nouveau champ
this.strokeMask = new Float32Array(NX * NZ);   // 256*256*4 = 256 Ko, réutilisé
this.strokeCap = 1.0;                           // 1 = pas de plafond

// dans sphere(), avant l'écriture :
const ci = x + NX * z;
const used = ctx.strokeMask[ci];
const room = Math.max(0, ctx.strokeCap - used);
if (room <= 0) continue;
const applied = Math.min(Math.abs(amount * f) / 255, room);
ctx.strokeMask[ci] = used + applied;
```

Coût : une lecture et une écriture par voxel, dans un tableau 2D déjà chaud en
cache (on balaye en `z` puis `x`). Négligeable.

**Exposition :** `strokeCap` est **N3** pour tous les outils sauf trois, où il
est fixé en dur à une valeur < 1 pour donner du caractère :

| Outil | `strokeCap` | Effet perçu |
|---|---|---|
| Arrosoir en mode `brume` | 0,25 | on ne peut pas détremper par accident |
| Main (lissage, clic droit) | 0,60 | le lissage ne peut pas effacer un détail entièrement |
| Râteau | 0,50 | repasser ne creuse pas indéfiniment la même rainure |

## 2.5 Ce qui reste interne, et pourquoi

Récapitulatif des paramètres **délibérément non exposés**, avec la justification.
Cette liste est aussi importante que la précédente : un système de brosses se
juge autant à ce qu'il cache qu'à ce qu'il montre.

| Paramètre | Pourquoi il reste interne |
|---|---|
| `smoothMix` (0,72) | Change la « raideur » du lissage. Aucun joueur ne saura ce que ça veut dire, et la valeur actuelle est bonne. |
| `cutWidth` (½ voxel) | C'est le paramètre qui donne l'arête vive. Le baisser fait de la bouillie, le monter fait de l'aliasing. Il n'y a qu'une bonne valeur. |
| `edgeSoft` (0,72) | Redondant avec `hardness`. Doit être *dérivé* de lui : `edgeSoft = 0.45 + 0.5 * hardness`. |
| `speedDamp` | Atténuation quand le curseur va vite. Doit être invisible : c'est un filet de sécurité (`GAME-DESIGN.md` §3.0.2 : « geste très rapide = 0,4 — ça empêche les labours accidentels »), pas un choix. |
| `dabCap` | Plafond de dose par dab. Empêche un pic de `dt` de creuser un cratère. Purement défensif. |
| Seuils physiques (`smoothstep(0.005, 0.05, w)`) | C'est de la **simulation**, pas de l'outil. Le sable sec ne se tasse pas : ce n'est pas négociable, c'est la BIBLE §1.4.3. |
| `wob` / `slump` du démoulage | Dérivés de `demouldQuality`. Les exposer détruirait la boucle d'apprentissage « bien mouiller → beau démoulage », qui est le cœur de la §2.4 de la BIBLE. |
| `fillRate` du seau | Le temps de remplissage est un **rythme**, pas un réglage. Le régler casserait le feedback sonore `bucketFull`. |

**La règle qui a servi de filtre :** *un paramètre mérite d'être exposé si un
joueur pourrait vouloir deux valeurs différentes dans la même session, pour deux
usages également légitimes.* Tout ce qui a une seule bonne valeur reste dans le
code.

## 2.6 Table de correspondance du vocabulaire

Pont vers les manuels des logiciels de référence, utile pour retrouver les
bonnes pages et pour les joueurs qui viennent d'ailleurs.

| Sandcastle | ZBrush | Blender Sculpt | Krita / Photoshop | Substance Painter |
|---|---|---|---|---|
| **Rayon** | Draw Size | Radius | Size / Diameter | Size |
| **Force** | Z Intensity | Strength | Flow | Flow |
| **Bord** | Focal Shift | Falloff + Hardness | Hardness | Hardness |
| **Profil** | Curve (courbe éditable) | Falloff shape (Smooth, Sphere, Root, Sharp, Linear, Constant) | Auto-brush fade | Falloff curve |
| **Pas** | — (Stroke ▸ Spacing) | Stroke ▸ Spacing | Spacing | Spacing |
| **Plafond de trait** | — | Accumulate (inversé) | Opacity | Opacity |
| **Symétrie** | Transform ▸ Activate Symmetry | Mesh Symmetry X/Y/Z + Radial | Multibrush / Mirror | Symmetry |
| **Alignement du plan** | Backface Mask / ZAdd modes | Sculpt Plane (Area/View/X/Y/Z) | — | — |
| **Préréglage** | Brush ▸ Save As | Brush datablock / Asset | Brush preset | Preset |

⚠︎ Les noms exacts et les plages numériques de cette table sont à revérifier
dans les manuels officiels avant toute citation externe.

---

# 3. COMMENT ON LES RÈGLE

Cinq schémas de réglage sont possibles. Aucun ne suffit seul ; la bonne réponse
est une combinaison à trois étages. Voici l'analyse de chacun, puis la
recommandation.

## 3.1 Molette seule et molette + modificateurs

### Le principe

La molette est le meilleur canal d'entrée du jeu pour une raison mécanique : la
main **ne quitte pas la souris**, donc le curseur ne quitte pas le point de
travail. C'est la propriété que `GAME-DESIGN.md` §4.1.1 invoque pour justifier
molette = rayon plutôt que molette = zoom, et c'est la bonne décision.

### Combien de modificateurs avant que ce soit illisible ?

C'est la vraie question. Trois faits :

1. **Un modificateur seul se retient. Deux se retiennent avec un effort. Trois ne
   se retiennent pas** — sauf par les 5 % d'utilisateurs experts d'un logiciel
   professionnel qui l'utilisent 6 h par jour. Sandcastle vise une session de
   30 minutes, une fois par semaine.
2. **Certains modificateurs sont préemptés par le système.** `Ctrl+molette` =
   zoom navigateur : c'est une convention OS/navigateur qu'on ne peut ni ignorer
   ni remapper proprement (et le code fait bien `if (e.ctrlKey||e.metaKey) return;`).
   Sur macOS, un trackpad envoie `ctrlKey: true` pour le geste de pincement —
   donc `Ctrl+molette` **est déjà occupé de fait**.
3. **Le nombre de combinaisons perçues n'est pas 4 mais 8**, parce que chaque
   combinaison a deux sens (haut/bas). Un joueur qui teste au hasard tombe sur
   8 comportements.

**Verdict : trois combinaisons molette au total, dont une imposée.**

| Combinaison | Affectation | Statut |
|---|---|---|
| **Molette** | Rayon | conservé (déjà en place, conforme §4.1.1) |
| **Maj + molette** | Force | **nouveau** |
| **Alt + molette** | Paramètre propre n°1 de l'outil (contextuel) | **nouveau** |
| **Ctrl + molette** | Zoom caméra | imposé, conservé |

**Attention au conflit existant :** `Maj+molette` est aujourd'hui pris par
l'écartement du râteau et le variant de déco. Ces deux usages **migrent vers
`Alt+molette`**, qui est justement défini comme « le paramètre propre n°1 ». Le
tableau des paramètres propres (§2.3) désigne pour chaque outil quel paramètre
est en N1 secondaire — c'est celui-là qu'`Alt+molette` règle :

| Outil | `Alt + molette` règle |
|---|---|
| Pelle | Contenance |
| Main | Étalement |
| Arrosoir | Pénétration (la Force est déjà le Débit) |
| Seau d'eau | Étalement |
| Seau | Hauteur |
| Truelle | Profondeur de coupe |
| Mirette | Plongée |
| Râteau | **Écartement** (migration depuis `Maj+molette`) |
| Décoration | **Objet** (migration depuis `Maj+molette`) |
| Gomme | (rien) |

**Note d'implémentation obligatoire.** `onWheel` doit tester `altKey` **avant**
de tomber sur le rayon, ce qu'il ne fait pas aujourd'hui. Et `onDown` doit
cesser de faire `if (e.altKey) return;` de façon inconditionnelle — sinon
maintenir Alt pour régler puis cliquer sans relâcher ne fait rien. Le bon test
est un drapeau explicite de « mode caméra » plutôt qu'un test de touche brut.

### Limites de la molette

- **Elle ne montre pas la valeur.** On tourne à l'aveugle et on regarde le
  résultat. Acceptable pour le rayon (l'anneau le montre) ; mauvais pour tout
  le reste **sauf si** un affichage temporaire apparaît (§4.5).
- **Elle ne permet pas de sauter à une valeur.** Pour passer de 5 cm à 60 cm il
  faut 26 crans. Il faut donc un accès direct : c'est le rôle des préréglages.
- **Elle est absente sur trackpad et tactile.** `GAME-DESIGN.md` §4.1.3 prévoit
  déjà `Ctrl` + deux doigts vertical, mais c'est un pis-aller. Le cadran 2D
  (§3.2) et le panneau (§3.3) sont les vrais recours.

## 3.2 Le cadran 2D à la ZBrush (touche maintenue + glisser)

### Le principe

Maintenir une touche transforme le déplacement de la souris en réglage : l'axe
horizontal règle un paramètre, l'axe vertical un autre. On relâche, le curseur
**revient exactement là où il était** (via `requestPointerLock` ou une
restauration manuelle). ZBrush le fait avec `Espace`, Blender avec `F` (rayon)
et `Maj+F` (force), Substance Painter avec `Ctrl` + clic droit glissé, Krita
avec `Maj` + glisser.

### Pourquoi c'est le meilleur schéma pour ce jeu

C'est de loin le plus **kinesthésique** des cinq : la valeur n'est pas un
nombre qu'on incrémente, c'est une **position de la main**. Après une heure, on
règle sans regarder, à la manière d'un potier qui ouvre les doigts. Ça
correspond exactement au pilier « le plaisir tactile avant le résultat »
(`GAME-DESIGN.md` §1.3).

Trois avantages concrets :

1. **Deux paramètres d'un coup**, sans changer de main ni de mode.
2. **Le retour est immédiat et in-world** : l'anneau de curseur grossit et
   s'assombrit sous la main pendant le réglage. On voit ce qu'on fait sur le
   sable, pas dans un panneau.
3. **Il fonctionne à l'identique sur trackpad** (glisser à un doigt) et sur
   tablette (appui long puis glisser).

### Les pièges

- **Le curseur ne doit pas dériver.** Sans `Pointer Lock`, le curseur part
  physiquement en réglant, et on ne sculpte plus au bon endroit. Solution :
  `canvas.requestPointerLock()` à l'appui, `document.exitPointerLock()` au
  relâchement, et on continue de rendre l'anneau à la position *gelée*.
  `Pointer Lock` demande un geste utilisateur — un `keydown` suffit dans les
  navigateurs actuels, mais il faut prévoir le repli (accumuler `movementX/Y`
  et ignorer la position réelle).
- **Le choix de la touche est délicat.** Toutes les lettres évidentes sont
  prises par `GAME-DESIGN.md` §4.1.2 : `S` (WASD), `F` (focus), `R` (reset
  caméra), `T` (vue de dessus), `E` (menu radial), `V` (analyse), `G` (grille),
  `X`/`Y` (symétrie). **`B` est libre** (« Brosse ») — c'est le choix retenu.
- **Il faut une zone morte.** Sans elle, un micro-mouvement pendant l'appui
  modifie la valeur : le joueur croit à un bug. 6 px de zone morte.
- **La sensibilité doit être en pixels, pas en fraction d'écran.** Sinon le
  réglage change de sensibilité entre un écran 1080p et un 4K.

### Mapping recommandé

```
B maintenu + glisser   ->  horizontal = RAYON   (droite = plus grand)
                           vertical   = FORCE   (haut  = plus fort)

Maj + B maintenu       ->  horizontal = BORD    (droite = plus net)
                           vertical   = PAS     (haut  = plus serré)
```

Le second étage n'est pas à apprendre : il est découvert par ceux qui essaient
`Maj` sur tout, ce qui est le comportement d'exploration naturel.

**Sens des axes.** Droite = plus, haut = plus. C'est contre-intuitif pour
l'axe Y en coordonnées écran (`clientY` croît vers le bas) mais parfaitement
intuitif pour un humain : monter la main = monter la valeur. C'est la convention
de tous les logiciels cités.

## 3.3 Le panneau contextuel sous la barre d'outils

### Le principe

Un panneau qui apparaît juste au-dessus de la barre d'outils, montrant les
réglages de l'outil courant. C'est le modèle de la barre d'options de Photoshop,
du panneau latéral de Procreate, et de la barre contextuelle de Cities: Skylines.

### Ce qu'il apporte, et que rien d'autre n'apporte

- **La découvrabilité.** C'est le seul canal qui *montre l'existence* d'un
  réglage. La molette et le cadran 2D sont invisibles : personne ne devine
  `Alt+molette`. Un joueur qui n'ouvre jamais le panneau n'apprendra jamais que
  le râteau a un écartement — c'est exactement la situation actuelle.
- **Les valeurs absolues.** « 12 cm », « 4 L/s », « 8 créneaux ». Les
  paramètres énumérés (Profil, Buse, Motif, Plan) ne se règlent pas à la
  molette : ils se **choisissent**, donc il faut les voir.
- **L'accessibilité.** `GAME-DESIGN.md` §5.6 traite d'accessibilité ; un système
  entièrement à base de modificateurs de clavier exclut ceux qui jouent d'une
  seule main ou au trackpad.

### Le risque, et la parade

Le risque est frontal : **le panneau contredit le pilier « l'UI doit savoir
disparaître »** (`GAME-DESIGN.md` §5.4). Quatre parades, toutes nécessaires :

1. **Fermé par défaut**, et l'état d'ouverture est mémorisé par outil. Le joueur
   qui l'ouvre une fois pour le râteau ne le voit pas revenir sur la pelle.
2. **Il se referme pendant le geste** (opacité 0 dès `pointerdown`, retour en
   250 ms au `pointerup`). On sculpte, on ne lit pas. C'est déjà la règle du
   « fade en action » de §5.4, étendue au panneau.
3. **Il ne dépasse jamais 6 lignes** (règle des trois niveaux, §2.1).
4. **Il partage le galet de la barre d'outils** : ce n'est pas une deuxième
   fenêtre, c'est le même objet crème qui pousse vers le haut. Visuellement,
   l'écran ne gagne pas un élément.

### Ouverture

- **Cliquer sur l'outil déjà actif** ouvre/ferme son panneau. C'est le geste de
  Procreate et de la plupart des applications tactiles, et il est
  auto-découvrable : on reclique par réflexe sur ce qu'on vient de choisir.
- **Touche `C`** (« Configurer ») fait la même chose au clavier. `C` est libre
  dans §4.1.2.
- Un petit chevron apparaît sur le bouton de l'outil actif pour signaler qu'il y
  a quelque chose dessous. C'est le seul pixel ajouté à l'écran par défaut.

## 3.4 Le menu radial (touche maintenue)

### Ce pour quoi il est excellent

Le menu radial est **le champion absolu de la mémoire musculaire**, pour une
raison géométrique : chaque cible est à la même distance du centre et occupe un
secteur infiniment profond. On finit par ne plus le regarder — on fait
« maintenir `E`, geste vers le haut-droite » sans lire. C'est la propriété que
Sandcastle veut pour le **changement d'outil**, et `GAME-DESIGN.md` §4.1.2 le
prévoit déjà (`E` maintenu).

### Ce pour quoi il est mauvais

**Il est mauvais pour les valeurs continues.** Un secteur radial représente un
choix discret ; forcer un curseur dedans (comme certains menus radiaux de jeux)
donne un contrôle imprécis et frustrant. Il est aussi mauvais au-delà de
**8 secteurs** : à 12 secteurs, la largeur angulaire tombe à 30° et les erreurs
de sélection deviennent fréquentes.

### Affectation retenue

| Geste | Contenu | Nombre de secteurs |
|---|---|---|
| `E` maintenu | **Les 10 outils** | 10 — à la limite haute, mais acceptable car les positions sont fixes à vie et redondantes avec les touches 1–0 |
| `Maj + E` maintenu | **Les préréglages de l'outil courant** | 6 max |

Le second est le vrai apport : « maintenir Maj+E, geste vers la gauche » =
« mon râteau à briques ». C'est le raccourci d'expert, celui qui fait gagner
20 secondes toutes les deux minutes.

## 3.5 Les préréglages nommés

### Pourquoi ils sont indispensables ici

Un préréglage résout trois problèmes d'un coup :

1. **Le saut de valeur.** Passer de la mirette fine à la mirette large sans
   26 crans de molette.
2. **La combinaison.** Un « bon » réglage n'est jamais un paramètre isolé : des
   briques, c'est `pitch 6 cm` + `grooveDepth 1 cm` + `pattern briques` +
   `hardness 0,7` + `curve franche`. Aucun joueur ne retrouvera ça de mémoire.
3. **La transmission.** Un préréglage a un **nom**, donc il s'enseigne : le
   tutoriel, un ami, une capture d'écran peuvent dire « prends *Briques* ».

### Trois familles

| Famille | Origine | Modifiable ? | Nombre |
|---|---|---|---|
| **Livrés** | fournis avec le jeu, écrits dans `tools.js` | non (mais duplicables) | 3 à 5 par outil |
| **Joueur** | `Ctrl+Alt+chiffre` mémorise l'état courant | oui | 6 par outil |
| **Dernier utilisé** | automatique, par outil, persistant | — | 1 par outil |

Le troisième est le plus important et le moins visible : **`select()` ne doit
plus réinitialiser les paramètres** (M5). Chaque outil garde son état, y compris
d'une session à l'autre (sérialisé dans la sauvegarde à côté du terrain).

### Préréglages livrés, proposition

Nommés comme des objets du monde réel, jamais comme des valeurs (conforme à
`GAME-DESIGN.md` §5.2 : « Toutes les icônes sont des objets réels, jamais des
symboles abstraits » — la règle vaut aussi pour les mots).

| Outil | Préréglages livrés |
|---|---|
| Pelle | *Pelle d'enfant* (r 10 cm, contenance 5 L) · *Pelle de terrassier* (r 30 cm, 25 L) · *Pelle de tranchée* (r 7 cm, profil pointue, 8 L) |
| Main | *Paume* (étalement 1,0) · *Galette* (étalement 0,35, profil galette, r 25 cm) · *Dame* (étalement 0,6, force 0,9, r 18 cm) |
| Arrosoir | *Brume* · *Pomme* · *Jet* |
| Seau d'eau | *Filet* (0,5 L/s) · *Seau* (4 L/s) · *Vidange* (18 L/s) |
| Seau | *Seau de plage* (conicité 0,86, h 2,5) · *Tour crénelée* (conicité 0,92, h 3,2, créneaux 8) · *Tube PVC* (conicité 1,0, h 4,0) · *Gobelet* (r 5 cm, h 1,8) |
| Truelle | *Langue de chat* (r 12 cm, profondeur 1,4) · *Truelle margée* (r 6 cm, profondeur 0,6, bord net) · *Couteau à enduire* (r 22 cm, profondeur 0,4, plan verrouillé) |
| Mirette | *Boucle* · *Cuillère à melon* (profil demi-sphère) · *Pointeau* (r 2 cm, profil pointue, force 1,0) |
| Râteau | *Stries* · *Briques* · *Tuiles* · *Bois* · *Fourchette* (pitch 1,5 cm, r 6 cm) |
| Décoration | *Un par un* (dispersion 0) · *Semis d'oyats* (dispersion 0,8, espacement 0,5) |
| Gomme | — |

Chaque nom vient directement de la BIBLE §3. C'est de la culture gratuite : le
joueur apprend le vrai vocabulaire du métier en choisissant une brosse.

### La pipette de réglages (`pick`)

Bonus à coût quasi nul, dérivé du `secondary: 'pick'` de §2.2.6 : **`Alt + clic`
sur une zone du sable adopte les réglages qui ont servi à la faire.** Cela
suppose de stocker, par chunk, l'identifiant du dernier préréglage appliqué
(1 octet par chunk, 192 octets au total). Utile après une pause : « j'avais fait
ces briques comment, déjà ? »

## 3.6 Recommandation combinée

Le schéma retenu est à **trois étages, du plus rapide au plus explicite**. Chaque
étage sert un moment différent de la session, et aucun n'est obligatoire.

```
ÉTAGE 1 — RÉFLEXE          molette · Maj+molette · Alt+molette
(pendant le geste)         la main ne bouge pas, on ajuste au vol
                           -> Rayon, Force, paramètre propre n°1

ÉTAGE 2 — INTENTION        B maintenu + glisser (cadran 2D)
(entre deux gestes)        Maj+E maintenu (menu radial des préréglages)
                           -> réglage kinesthésique, saut de valeur

ÉTAGE 3 — EXPLORATION      clic sur l'outil actif · touche C
(une fois par session)     -> panneau : tout, avec les noms et les unités
```

**Pourquoi les trois et pas un seul.** Chaque étage échoue seul :

- L'étage 1 seul → les réglages restent invisibles (situation actuelle).
- L'étage 2 seul → pas de valeurs absolues, pas d'énumérations, pas de trackpad.
- L'étage 3 seul → il faut quitter le sable pour régler, ce qui casse le flux.

**Ordre d'implémentation.** L'étage 3 d'abord (le panneau), parce qu'il rend les
paramètres visibles et donc testables ; puis l'étage 1 (molette) ; puis l'étage 2
(cadran + radial), qui est du confort d'expert.

## 3.7 Table complète des raccourcis

Table consolidée, conforme à `GAME-DESIGN.md` §4.1. **Gras = nouveau.**
*Italique = déjà spécifié dans §4.1 mais non implémenté.*

### Souris

| Entrée | Contexte | Action |
|---|---|---|
| Clic gauche maintenu | plage | Action primaire de l'outil |
| Clic droit maintenu | plage | Action secondaire (paramètre `secondary`) |
| Clic milieu glissé | partout | Orbite caméra |
| Maj + clic milieu | partout | Pan caméra |
| Molette | partout | **Rayon** (pas discret ×1,10) |
| **Maj + molette** | partout | **Force** |
| **Alt + molette** | partout | **Paramètre propre n°1** (contextuel, §3.1) |
| Ctrl + molette | partout | Zoom caméra |
| **Alt + clic gauche** | sur le sable | **Pipette de réglages** |
| **Clic sur l'outil actif** | barre | **Ouvre/ferme le panneau de réglages** |
| *Double-clic milieu* | plage | *Focus caméra* |

### Clavier — outils et réglages

| Touche | Action |
|---|---|
| `1`–`9`, `0` | Sélection d'outil |
| `[` / `]` | Rayon −/+ (déjà en place) |
| **`Maj+[` / `Maj+]`** | **Force −/+** |
| **`B` maintenu + glisser** | **Cadran 2D : Rayon (X) × Force (Y)** |
| **`Maj+B` maintenu + glisser** | **Cadran 2D : Bord (X) × Pas (Y)** |
| **`C`** | **Ouvre/ferme le panneau de réglages** |
| *`E` maintenu* | *Menu radial des outils* |
| **`Maj+E` maintenu** | **Menu radial des préréglages de l'outil** |
| **`Alt+1` … `Alt+6`** | **Rappelle le préréglage n** |
| **`Ctrl+Alt+1` … `Ctrl+Alt+6`** | **Mémorise le préréglage n** |

### Clavier — contraintes de geste

| Touche | Action |
|---|---|
| `Ctrl` maintenu | Verrouille l'altitude (déjà en place) |
| **`Maj` maintenu pendant un geste** | **Verrouille l'axe du geste** (§6.3) |
| **`Maj` + clic sans glisser** | **Ligne droite depuis le dernier point** (§6.3) |
| *`Tab`* | *Fige/libère le plan de travail* |
| **`X`** | **Symétrie miroir sur X** |
| **`Y`** | **Symétrie miroir sur Z** *(nom historique de la touche, cf. §4.1.2)* |
| **`Maj+X`** | **Symétrie radiale (cycle 2/4/6/8)** |
| **`Maj+Y`** | **Déplace l'axe de symétrie sous le curseur** |
| **`N`** | **Répétition de motif le long du chemin** (créneaux, §6.4) |

### Clavier — reste (inchangé)

| Touche | Action |
|---|---|
| `Ctrl+Z` / `Ctrl+Maj+Z` / `Ctrl+Y` | Annuler / Refaire |
| **`Ctrl+Z` pendant un geste** | **Interrompt le geste puis annule** (correction de M8) |
| `W A S D` / `Q E` | Caméra |
| `P` / `H` / `F3` | Photo / Aide / Diagnostics |
| `Ctrl+S` / `Ctrl+O` | Sauvegarder / Recharger |
| *`V` maintenu* | *Mode analyse* |

### Note sur les conflits résolus

| Conflit | Résolution |
|---|---|
| `Maj+molette` (râteau, déco) vs Force | Migration vers `Alt+molette`, qui est *par définition* le paramètre propre n°1 |
| `Maj` = modificateur d'outil (truelle : coupe horizontale) vs `Maj` = verrou d'axe | La coupe horizontale devient le paramètre `plane: 'horizontal'`, réglable dans le panneau **et** cyclable par `Alt+molette`. `Maj` est libéré pour le verrou d'axe, uniforme sur tous les outils. **C'est une simplification, pas un ajout.** |
| `E` = rotation caméra (tap) vs `E` = menu radial (maintenu) | Distinction par la durée : moins de 180 ms = tap = rotation ; au-delà = radial. Convention établie, sans ambiguïté à l'usage. |
| `B` (cadran) | Aucune collision : `B` n'est réservé nulle part dans §4.1.2. |
| `Alt` bloque l'outil (`onDown`) vs `Alt+molette` | `Alt` cesse d'être un veto global ; il devient un modificateur normal. La caméra à l'`Alt+clic` (souris sans molette, cf. `HELP_HTML`) est conservée mais seulement si aucun geste n'est en cours. |

### Budget mnémonique

Compte final des choses à retenir pour **jouer confortablement** (pas pour tout
faire) : molette = taille, `Maj`+molette = force, clic sur l'outil actif =
réglages. **Trois.** Tout le reste est du bonus découvrable, et le panneau
affiche le raccourci à côté de chaque curseur — c'est la façon la moins chère
d'enseigner un raccourci (le joueur le lit au moment exact où il en a besoin).

---

# 4. RETOUR VISUEL DU CURSEUR

## 4.1 État actuel

Neuf lignes, dans le fragment shader de `SandMaterial.js` (322–330) :

```glsl
if (uCursorStrength > 0.001) {
  float d = distance(vWorldPos, uCursor.xyz);
  float r = uCursor.w;
  float ring = smoothstep(r, r * 0.94, d) * smoothstep(r * 0.80, r * 0.88, d);
  float fill = smoothstep(r, r * 0.9, d) * 0.10;
  gl_FragColor.rgb = mix(gl_FragColor.rgb, uCursorColor,
                         clamp((ring * 0.7 + fill) * uCursorStrength, 0.0, 0.85));
}
```

C'est **un anneau et un voile**, avec trois défauts :

1. **L'épaisseur de l'anneau est proportionnelle au rayon** (`r*0.80` à `r*0.94`,
   soit 14 % du rayon). À 2 cm de rayon, l'anneau fait 3 mm : invisible. À 90 cm,
   il fait 12 cm : un beignet. L'épaisseur doit être **constante à l'écran**,
   comme le fait déjà le code de scintillement quelques lignes plus haut
   (`cellSize = 520.0 / max(1.0, dist * 0.75)`) — le bon réflexe est là, il faut
   juste l'appliquer aussi au curseur.
2. **La distance est mesurée en 3D** (`distance(vWorldPos, uCursor.xyz)`). Sur un
   mur vertical, l'anneau devient une ellipse écrasée qui ne correspond plus à
   l'empreinte de la brosse. Il faut mesurer la distance dans le **plan tangent
   à la surface visée**, ce qui donne un décal qui épouse la géométrie
   (`GAME-DESIGN.md` §3.0.4 : « Décal projeté sur la surface qui suit la
   courbure »).
3. **Il ne communique qu'une seule des six informations utiles.**

## 4.2 Ce que le curseur doit montrer

Par ordre de priorité — c'est-à-dire par ordre de fréquence de consultation :

| Rang | Information | Encodage retenu | Pourquoi cet encodage |
|---|---|---|---|
| 1 | **Rayon** | rayon de l'anneau extérieur, épaisseur constante à l'écran | déjà appris par tous les joueurs de tous les logiciels |
| 2 | **Intensité (Force)** | **opacité du remplissage intérieur**, de 4 % à 26 % | l'aire est perçue comme une quantité ; c'est la métaphore de la « pression » |
| 3 | **Dureté du bord** | **anneau intérieur pointillé** au rayon du plateau (`r × hardness`) | conforme à `GAME-DESIGN.md` §3.0.4 ; les pointillés disent « limite floue » là où le trait plein dit « limite dure » |
| 4 | **Direction du geste** | **queue de comète** : une traînée derrière le curseur, longueur ∝ vitesse | montre le verrou d'axe et la vitesse (donc `speedDamp`) sans rien ajouter |
| 5 | **Prévisualisation** | **teinte du remplissage** : bleuté = on retire, ambré = on ajoute ; plus un **liseré d'horizon** sur la trace du plan/des rainures | dit ce qui va se passer avant que ça se passe |
| 6 | **Risque d'effondrement** | **hachures corail** animées dans l'anneau, jamais de rouge | conforme à `GAME-DESIGN.md` §5.3 : « informatif, pas anxiogène » |

Deux règles de retenue, sans lesquelles ça devient un cockpit :

- **Jamais plus de trois signaux simultanés.** Les rangs 1–3 sont permanents ; le
  rang 4 n'apparaît qu'en mouvement ; le rang 5 n'apparaît que pour les outils
  directionnels ; le rang 6 n'apparaît qu'au-delà de 60 % de contrainte.
- **Tout s'estompe pendant le geste sauf le rang 1 et le rang 6.** Quand on
  sculpte, on regarde le sable. `uCursorStrength` sert déjà de fondu global ; on
  ajoute `uCursorDetail` qui tombe à 0,25 pendant un geste.

## 4.3 Encodages détaillés

### Dureté du bord — l'anneau intérieur

Le plateau central s'arrête à `r × hardness`. On dessine un second anneau à ce
rayon, **pointillé**, plus fin et plus transparent que l'extérieur.

- `hardness = 0` → le rayon intérieur est nul : **l'anneau intérieur disparaît**.
  C'est exactement la bonne sémantique : « pas de plateau, tout est fondu ».
- `hardness = 0,95` → l'anneau intérieur est presque confondu avec l'extérieur.
  Les deux traits se collent, ce qui *se lit* comme « bord net » — un double
  trait serré évoque une arête.

Le nombre de tirets doit être **constant en angle** (24 tirets), pas en longueur,
sinon un petit rayon donne un cercle plein.

**Pourquoi pas un dégradé de remplissage pour la dureté ?** Testé mentalement et
rejeté : le remplissage est déjà pris par la Force, et deux informations dans le
même canal se confondent. Le trait est un canal libre.

### Intensité — opacité, pas épaisseur

Trois candidats, un seul survit :

| Candidat | Verdict |
|---|---|
| **Épaisseur de l'anneau** | ✗ Entre en conflit avec la lisibilité du rayon (un anneau épais rend le rayon ambigu : rayon intérieur ou extérieur ?). |
| **Nombre d'anneaux concentriques** | ✗ Illisible au-delà de 3, et discrétise une valeur continue. |
| **Opacité du remplissage** | ✓ Canal libre, continu, perçu comme une quantité, et déjà présent dans le code (`fill`, aujourd'hui figé à 0,10). |

Formule : `fillAlpha = 0.04 + 0.22 * force`. À force minimale on voit à peine le
disque (l'outil « effleure ») ; à force maximale il est franchement teinté sans
masquer le sable. Le plafond de 0,26 est important : au-delà, on ne voit plus la
matière qu'on sculpte.

### Outils directionnels — la trace du geste

Deux cas distincts, deux dessins distincts.

**La truelle** — on montre **la trace du plan de coupe** : une ligne droite
traversant le disque, perpendiculaire à la normale du plan projetée sur la
surface, **avec un côté ombré** (le côté qui va disparaître). C'est le dessin le
plus informatif du jeu : il répond d'un coup d'œil à « de quel côté ça coupe ? »,
question sur laquelle on se trompe sans arrêt aujourd'hui.

```
      ╱ trace du plan
   ▓▓╱          ← côté qui sera retiré (ombré, hachures fines)
  ▓▓╱
 ──╱────────    ← ligne de coupe, trait plein, épaisseur constante
  ╱
 ╱              ← côté conservé (clair)
```

**Le râteau** — on montre **les dents** : `n` traits parallèles espacés de
`pitch`, orientés selon `angle`, s'estompant vers le bord du disque. Le joueur
voit exactement où tomberont les rainures avant de cliquer, ce qui permet
d'aligner un lit de briques sur le précédent. C'est indispensable pour faire un
mur crédible et impossible aujourd'hui.

**Le seau** — on montre **la silhouette du tronc de cône** en fil de fer (base,
sommet, et `crenels` encoches), à la hauteur qu'il aura selon le remplissage.
C'est la seule prévisualisation qui a besoin d'une géométrie séparée du shader
du sable (un `LineSegments` Three.js), les autres tiennent dans le shader.

### Risque d'effondrement

Reprend le vocabulaire de `GAME-DESIGN.md` §5.3 : hachures diagonales fines,
corail pâle, animées lentement, **jamais de rouge, jamais de son**. Sur le
curseur, elles apparaissent **dans la couronne** entre l'anneau intérieur et
l'anneau extérieur, ce qui les rend visibles sans masquer la zone de travail.

`uCursorRisk` vient de la contrainte locale déjà calculable par le modèle de
stabilité (`GAME-DESIGN.md` §9.4). Tant que ce modèle n'est pas branché, on peut
alimenter l'uniforme avec une heuristique bon marché et honnête : hauteur de la
colonne sous le curseur ÷ hauteur tenable `thetaMax(w, packing)` — deux fonctions
qui existent déjà dans `SandPhysics.js` et sont déjà appelées par le HUD.

## 4.4 Code GLSL proposé

Remplace intégralement le bloc 322–330 de `SandMaterial.js`. Les uniformes à
ajouter sont listés juste après.

```glsl
// --- uniformes a ajouter dans le bloc uniforms de SandMaterial.js ---
// uCursor       vec4  : xyz = point vise, w = rayon monde
// uCursorColor  vec3  : couleur de l'outil
// uCursorStrength float: fondu global 0..1 (existe deja)
// uCursorShape  vec4  : x = hardness, y = force, z = risque 0..1, w = detail 0..1
// uCursorNormal vec4  : xyz = normale de la surface visee, w = mode directionnel
//                       (0 = aucun, 1 = plan de coupe, 2 = rainures, 3 = fleche)
// uCursorDir    vec4  : xyz = direction (normale du plan, ou axe de repetition),
//                       w = pas des rainures en metres
// uCursorMotion vec4  : xyz = direction du geste (monde), w = vitesse 0..1
// uTime         float : deja present dans le materiau

// ---------------------------------------------------------------------------
// Anneau de curseur enrichi.
//
// Tout est mesure dans le PLAN TANGENT a la surface visee, pas en 3D : sur un
// mur vertical, l'empreinte reelle de la brosse est un disque dans ce plan, et
// c'est ce disque qu'il faut dessiner. Mesurer en 3D donnait une ellipse qui ne
// correspondait a rien.
//
// Toutes les EPAISSEURS de trait sont converties en metres a partir d'une
// epaisseur voulue en pixels, pour qu'un anneau de 2 cm et un anneau de 90 cm
// aient le meme trait a l'ecran.
// ---------------------------------------------------------------------------
if (uCursorStrength > 0.001) {
  vec3  P  = uCursor.xyz;
  float R  = max(uCursor.w, 1e-4);
  vec3  Ncur = normalize(uCursorNormal.xyz);

  // Coordonnees locales dans le plan tangent -------------------------------
  vec3  rel = vWorldPos - P;
  float off = dot(rel, Ncur);                 // ecart hors du plan
  vec3  inp = rel - Ncur * off;               // composante dans le plan
  float d   = length(inp);

  // Le decal ne s'affiche pas sur les surfaces trop obliques ni trop loin du
  // plan tangent : sinon il "bave" sur les faces cachees.
  float planeFade = 1.0 - smoothstep(R * 0.35, R * 0.75, abs(off));
  planeFade *= smoothstep(0.15, 0.5, abs(dot(normalize(Nw), Ncur)));

  if (planeFade > 0.002 && d < R * 1.25) {
    // Epaisseur de trait constante a l'ecran -------------------------------
    // 1 px ~ (distance * 2 * tan(fov/2)) / hauteurEcran. On approxime avec un
    // facteur unique calibre pour un FOV de 32 deg (cf. GAME-DESIGN 4.2).
    float camDist = distance(cameraPosition, vWorldPos);
    float px      = camDist * 0.0011;          // ~1 px en metres
    float wOuter  = max(px * 1.8, R * 0.004);  // anneau exterieur : 1.8 px
    float wInner  = max(px * 1.1, R * 0.003);  // anneau interieur : 1.1 px

    float hard  = clamp(uCursorShape.x, 0.0, 0.98);
    float force = clamp(uCursorShape.y, 0.0, 1.0);
    float risk  = clamp(uCursorShape.z, 0.0, 1.0);
    float det   = clamp(uCursorShape.w, 0.0, 1.0);   // 0.25 pendant un geste

    // 1) Anneau exterieur = RAYON -----------------------------------------
    float ringOut = 1.0 - smoothstep(0.0, wOuter, abs(d - R));

    // 2) Remplissage = FORCE ----------------------------------------------
    float disk  = 1.0 - smoothstep(R - wOuter, R, d);
    float fillA = (0.04 + 0.22 * force) * disk;

    // 3) Anneau interieur pointille = BORD (hardness) ----------------------
    //    A hardness = 0 il n'existe pas : il n'y a pas de plateau.
    float rIn  = R * hard;
    float ang  = atan(dot(inp, normalize(cross(Ncur, vec3(0.0, 1.0, 0.02)))),
                      dot(inp, normalize(cross(cross(Ncur, vec3(0.0, 1.0, 0.02)), Ncur))));
    float dash = step(0.42, fract(ang * (24.0 / 6.28318) + 0.5));
    float ringIn = (1.0 - smoothstep(0.0, wInner, abs(d - rIn)))
                 * dash * smoothstep(0.02, 0.12, hard);

    // 4) Queue de comete = DIRECTION du geste ------------------------------
    //    Une trainee derriere le curseur, longueur proportionnelle a la vitesse.
    float comet = 0.0;
    if (uCursorMotion.w > 0.02) {
      vec3  mdir = normalize(uCursorMotion.xyz - Ncur * dot(uCursorMotion.xyz, Ncur));
      float along = dot(inp, mdir);            // >0 devant, <0 derriere
      float side  = length(inp - mdir * along);
      float tail  = R * (0.6 + 1.8 * uCursorMotion.w);
      comet = smoothstep(0.0, -tail, along)
            * (1.0 - smoothstep(wOuter * 0.5, wOuter * 2.2, side))
            * (0.35 * uCursorMotion.w);
    }

    // 5) Trace directionnelle ---------------------------------------------
    float guide = 0.0;
    float shade = 0.0;
    int mode = int(uCursorNormal.w + 0.5);

    if (mode == 1) {
      // TRUELLE : trace du plan de coupe + ombrage du cote retire.
      vec3  pn   = normalize(uCursorDir.xyz);
      vec3  pnT  = pn - Ncur * dot(pn, Ncur);        // projete dans le plan tangent
      float lpn  = length(pnT);
      if (lpn > 1e-4) {
        pnT /= lpn;
        float sd = dot(inp, pnT);                    // distance signee a la trace
        guide = (1.0 - smoothstep(0.0, wOuter, abs(sd))) * disk;
        // hachures fines du cote positif (celui qui disparait)
        float hatch = step(0.55, fract((dot(inp, vec3(pnT.z, 0.0, -pnT.x)) + sd) / (px * 5.0)));
        shade = smoothstep(0.0, R * 0.10, sd) * disk * hatch * 0.30;
      }
    } else if (mode == 2) {
      // RATEAU : les dents, espacees de uCursorDir.w, orientees par uCursorDir.xyz.
      vec3  u = normalize(uCursorDir.xyz - Ncur * dot(uCursorDir.xyz, Ncur));
      float pitch = max(uCursorDir.w, 0.005);
      float t = dot(inp, u) / pitch;
      float teeth = 1.0 - smoothstep(0.0, max(px * 1.2, pitch * 0.10),
                                     abs(fract(t + 0.5) - 0.5) * pitch);
      guide = teeth * disk * (1.0 - smoothstep(R * 0.55, R, d));
    } else if (mode == 3) {
      // FLECHE : direction de rejet (pelle) — un simple segment radial.
      vec3  u = normalize(uCursorDir.xyz - Ncur * dot(uCursorDir.xyz, Ncur));
      float along = dot(inp, u);
      float side  = length(inp - u * along);
      guide = step(0.0, along) * (1.0 - smoothstep(0.0, wOuter, side)) * disk;
    }

    // 6) Risque d'effondrement : hachures corail dans la couronne ----------
    float alert = 0.0;
    if (risk > 0.60) {
      float band  = smoothstep(rIn, rIn + wOuter * 2.0, d)
                  * (1.0 - smoothstep(R - wOuter * 2.0, R, d));
      float diag  = fract((vWorldPos.x + vWorldPos.z + vWorldPos.y * 0.5) / (px * 7.0)
                          - uTime * 0.08);
      alert = band * step(0.62, diag) * smoothstep(0.60, 0.95, risk);
    }

    // Composition ----------------------------------------------------------
    vec3 coral = vec3(0.94, 0.66, 0.58);
    float k = uCursorStrength * planeFade;

    // Les details s'effacent pendant le geste ; le rayon et l'alerte restent.
    float kd = k * det;

    gl_FragColor.rgb = mix(gl_FragColor.rgb, uCursorColor,
                           clamp(fillA * kd, 0.0, 0.30));
    gl_FragColor.rgb = mix(gl_FragColor.rgb, uCursorColor * 0.55,
                           clamp(shade * kd, 0.0, 0.35));
    gl_FragColor.rgb = mix(gl_FragColor.rgb, uCursorColor,
                           clamp((ringIn * 0.55 + guide * 0.75 + comet) * kd, 0.0, 0.75));
    gl_FragColor.rgb = mix(gl_FragColor.rgb, uCursorColor,
                           clamp(ringOut * 0.85 * k, 0.0, 0.90));
    gl_FragColor.rgb = mix(gl_FragColor.rgb, coral,
                           clamp(alert * 0.70 * k, 0.0, 0.55));
  }
}
```

### Notes d'implémentation

- **Coût.** Le bloc est intégralement gardé par `uCursorStrength > 0.001` puis
  par `planeFade > 0.002 && d < R * 1.25`. En pratique, seuls les fragments dans
  un disque de rayon `1,25 R` autour du curseur exécutent le corps — quelques
  milliers de pixels. Le `atan` du pointillé est la seule opération chère et
  elle est dans cette zone.
- **Le facteur `0.0011`** de `px` est calibré pour un FOV vertical de 32° et une
  fenêtre de ~900 px de haut (`px ≈ 2·tan(16°)/900 ≈ 0.00064`… ⚠︎ à recalibrer :
  passer `uPixelScale = 2.0*tan(fov/2)/canvasHeight` en uniforme plutôt que de
  coder une constante, sinon le trait change d'épaisseur avec la résolution).
- **`Nw`** est la normale du fragment, déjà disponible dans le shader (utilisée
  par le bloc de scintillement juste au-dessus). `uCursorNormal.xyz` est la
  normale **du point visé**, fournie par le raycast — les deux sont différentes,
  et c'est leur produit scalaire qui masque les faces obliques.
- **Le calcul de `ang`** est volontairement grossier (base tangente construite à
  partir d'un vecteur arbitraire quasi vertical). Il suffit pour un pointillé :
  seule la régularité angulaire compte, pas l'origine. Cas dégénéré si
  `Ncur ≈ (0,1,0.02)` normalisé — d'où le `0.02` qui l'évite en pratique.

## 4.5 Le retour hors-monde : la pastille de réglage

Le curseur 3D ne peut pas afficher de chiffre (`HUD.js` : « aucun chiffre brut »
— mais la règle vise les grandeurs physiques du sable, pas les réglages d'outil,
qui eux doivent être précis). Il faut donc un complément 2D **transitoire** :

> **Règle : pendant 900 ms après un changement de réglage, une pastille
> apparaît à 34 px sous le curseur, montrant le nom du paramètre, sa valeur, et
> une mini-jauge. Elle s'efface en 250 ms.**

C'est le pattern des logiciels de peinture, et il résout le principal défaut de
la molette (§3.1). Le coût est d'un `<div>` positionné en absolu. Il réutilise
le style `.tool-info` existant, en plus petit.

```
                ╭──────────────────╮
                │  Force    ▮▮▮▮▯▯  62 %  │
                ╰──────────────────╯
```

Pendant un cadran 2D (`B` maintenu), la même pastille reste affichée en
permanence et montre **les deux** valeurs, avec un petit repère en croix
indiquant la position du curseur virtuel dans le cadran.

---

# 5. COURBES DE FONDU

## 5.1 Le problème avec la fonction actuelle

```js
function falloff(d, r, hardness) {
  if (d >= r) return 0;
  const t = d / r;
  const soft = 1 - t * t;                                       // parabole
  const hard = smoothstep(1, 1 - Math.max(0.06, 1 - hardness), t); // marche décalée
  return soft * (1 - hardness) + hard * hardness;               // mélange linéaire
}
```

Valeurs au centre (`t = 0`) : `soft = 1`, `hard = 1`, donc `f(0) = 1`. Bon.
Valeurs au bord (`t → 1`) : `soft → 0`, `hard → 0`. Bon.
**Le problème est entre les deux.**

| `hardness` | `f(0.5)` | Forme réelle |
|---|---|---|
| 0,0 | 0,750 | parabole pure |
| 0,3 | 0,525 | parabole + un début de marche à `t = 0,7` |
| 0,6 | 0,400 | mélange : **la dérivée seconde change de signe deux fois** |
| 0,9 | 0,300 | marche presque pure à `t = 0,9`, mais avec 10 % de parabole résiduelle qui crée un halo faible sur tout le disque |

Le cas `hardness = 0,9` illustre bien le défaut : on veut un emporte-pièce, on
obtient un emporte-pièce **plus un voile de 10 %** sur tout le disque. Visuellement,
la mirette (qui utilise `hardness: 0.85`) creuse un trou net **entouré d'une
cuvette molle** dont personne n'a jamais voulu.

## 5.2 Le modèle proposé : plateau + forme

Deux paramètres orthogonaux, comme dans tous les logiciels de référence :

1. **`hardness` (h)** — le rayon du **plateau** central, en fraction du rayon.
   Dans le plateau, `f = 1` exactement.
2. **`curve`** — la **forme** de la transition entre le bord du plateau et le
   bord de la brosse.

```
        f
     1 ─┬────────────╮
        │  plateau   ╲            <- forme choisie par `curve`
        │   f = 1     ╲
     0 ─┴────────────────╲──── t
        0            h     1
```

Reparamétrage : on définit `s`, la **coordonnée normalisée dans la transition**,
qui vaut 1 au bord du plateau et 0 au bord de la brosse :

```
u = (t - h) / (1 - h)      clampé dans [0, 1]      (0 au plateau, 1 au bord)
s = 1 - u                                          (1 au plateau, 0 au bord)
f = SHAPE(s)
```

`SHAPE` est monotone croissante, `SHAPE(0) = 0`, `SHAPE(1) = 1`. C'est tout.
Toutes les propriétés désirables en découlent : continuité, `f(0) = 1`,
`f(1) = 0`, et **le hardness fait exactement ce que son nom dit**.

## 5.3 Le jeu de courbes

| Clé | Nom affiché | Formule `SHAPE(s)` | Silhouette | Caractère |
|---|---|---|---|---|
| `plate` | **Galette** | `sqrt(1 - (1-s)²)` | ▔▔▔╲ | Reste à pleine puissance longtemps, puis chute vite. Bord de dame. |
| `lisse` | **Lisse** | `s²(3 - 2s)` | ╭─╮ | Smoothstep. Dérivée nulle aux deux extrémités : aucune arête, aucun raccord visible. **Défaut universel.** |
| `lineaire` | **Linéaire** | `s` | ╱ | Rampe droite. Prévisible : le cône obtenu a exactement la pente qu'on attend. |
| `pointue` | **Pointue** | `s²` | ⌐╲ | Chute immédiate au sortir du plateau. Concentre l'effet au centre. Gouge, pointeau. |
| `franche` | **Franche** | `smoothstep(0, 0.14, s)` | ▏▔ | Quasi carrée. Bord net, arête vive. Emporte-pièce. |
| `douce` | **Voile** | `s^0.55` | ╭──── | Monte vite puis s'aplatit : effet très étalé et très doux au centre. Brumisation. |

En code (JS) :

```js
// Brush.js — remplace la fonction falloff() actuelle.

/** Identifiants de courbe. L'ordre est stable : il est sérialisé. */
export const CURVE = {
  plate: 0, lisse: 1, lineaire: 2, pointue: 3, franche: 4, douce: 5,
};

/**
 * Profil de brosse.
 *
 * Deux parametres ORTHOGONAUX :
 *   - `h` (hardness) est le rayon du PLATEAU central, en fraction du rayon.
 *     Dans le plateau, la brosse agit a pleine puissance. C'est le Focal Shift
 *     de ZBrush et le Hardness de Photoshop, pas une interpolation de formes.
 *   - `curve` est la FORME de la transition entre le plateau et le bord.
 *
 * L'ancienne version melangeait lineairement une parabole et un smoothstep
 * decale : a hardness eleve, elle laissait un voile de (1-h) sur tout le
 * disque — la mirette creusait un trou net entoure d'une cuvette molle.
 *
 * @param {number} t distance normalisee, 0 au centre, 1 au bord
 * @param {number} h rayon du plateau, 0..0.98
 * @param {number} curve identifiant CURVE.*
 */
export function profile(t, h, curve) {
  if (t >= 1) return 0;
  if (t <= h) return 1;
  const s = 1 - (t - h) / (1 - h);        // 1 au plateau, 0 au bord
  switch (curve) {
    case 0: { const a = 1 - s; return Math.sqrt(Math.max(0, 1 - a * a)); } // galette
    case 2: return s;                                                     // lineaire
    case 3: return s * s;                                                 // pointue
    case 4: return smoothstep(0, 0.14, s);                                // franche
    case 5: return Math.pow(s, 0.55);                                     // voile
    default: return s * s * (3 - 2 * s);                                  // lisse
  }
}

/**
 * Adaptateur : signature historique, pour ne pas toucher aux 6 operations d'un
 * coup. `falloff(d, r, h)` continue de marcher, avec la courbe par defaut.
 */
function falloff(d, r, h, curve = 1) {
  return d >= r ? 0 : profile(d / r, h, curve);
}
```

Et la version GLSL, **strictement identique**, pour que la prévisualisation du
curseur ne mente jamais sur ce que fera la brosse :

```glsl
// SandMaterial.js — a inserer avant main() du fragment shader.
float sc_profile(float t, float h, int curve) {
  if (t >= 1.0) return 0.0;
  if (t <= h)   return 1.0;
  float s = 1.0 - (t - h) / max(1e-4, 1.0 - h);
  if (curve == 0) { float a = 1.0 - s; return sqrt(max(0.0, 1.0 - a * a)); }
  if (curve == 2) return s;
  if (curve == 3) return s * s;
  if (curve == 4) return smoothstep(0.0, 0.14, s);
  if (curve == 5) return pow(s, 0.55);
  return s * s * (3.0 - 2.0 * s);
}
```

## 5.4 Table des valeurs, pour vérification

`f(t)` à `h = 0,35` (le défaut) :

| `t` | Galette | Lisse | Linéaire | Pointue | Franche | Voile |
|---|---|---|---|---|---|---|
| 0,00 | 1,000 | 1,000 | 1,000 | 1,000 | 1,000 | 1,000 |
| 0,35 | 1,000 | 1,000 | 1,000 | 1,000 | 1,000 | 1,000 |
| 0,50 | 0,979 | 0,914 | 0,769 | 0,592 | 1,000 | 0,869 |
| 0,65 | 0,866 | 0,648 | 0,538 | 0,290 | 1,000 | 0,712 |
| 0,80 | 0,600 | 0,286 | 0,308 | 0,095 | 0,998 | 0,522 |
| 0,90 | 0,363 | 0,097 | 0,154 | 0,024 | 0,833 | 0,352 |
| 0,97 | 0,138 | 0,013 | 0,046 | 0,002 | 0,193 | 0,183 |
| 1,00 | 0,000 | 0,000 | 0,000 | 0,000 | 0,000 | 0,000 |

Lecture : à mi-parcours de la transition, la Galette est encore à 87 %, la
Pointue déjà tombée à 29 %. C'est bien un facteur 3 de différence de caractère —
ce qui justifie l'existence de six courbes plutôt que d'un seul curseur.

## 5.5 Quelle courbe pour quel outil

| Outil | `curve` par défaut | `hardness` par défaut | Justification |
|---|---|---|---|
| **Pelle** (creuser) | `lisse` | 0,30 | Un coup de pelle laisse une cuvette adoucie, pas un trou à bord vif. Valeur actuelle conservée. |
| **Pelle** (déposer) | `douce` | 0,10 | Le sable en vrac s'étale ; un tas déposé a un pied très évasé. |
| **Main** (tasser) | **`plate`** | 0,55 | **La correction la plus importante du chapitre.** Une paume tasse *uniformément* sous sa surface. Aujourd'hui `compact()` utilise `0.25` en dur avec une parabole : le centre est tassé deux fois plus que le bord, ce qui crée des cuvettes au lieu de plans. |
| **Main** (lisser) | `lisse` | 0,20 | Le lissage doit fondre dans ce qui l'entoure, sinon on voit le bord de la passe. |
| **Arrosoir** | **`douce`** | 0,05 | Une brumisation n'a pas de bord. C'est la définition même du `douce`. |
| **Seau d'eau** | `lisse` | 0,45 | Un jet a un cœur net et un pourtour éclaboussé. |
| **Seau** (démoulage) | — | — | `stampBucket` n'utilise pas `falloff` : c'est un champ de distance signé. Rien à faire. |
| **Truelle** | **`franche`** | 0,80 | Une truelle produit un plan, pas un dégradé. Le disque doit être quasi uniforme et s'arrêter net (c'est aujourd'hui approximé par le `smoothstep(r*0.72, r, rad)` de la ligne 288, qui doit devenir `profile()` avec ces valeurs). |
| **Mirette** | **`pointue`** | 0,55 | Concentre l'effet : une gouge creuse profond au centre et à peine sur les côtés (BIBLE §3.3.2 : « gouger en rotation », 0,5–10 cm³). Le `0.85` actuel avec la vieille formule donnait au contraire un bord dur *et* un halo. |
| **Râteau** | `franche` | 0,70 | Les dents doivent être franches ; le fondu se fait par le `1 - smoothstep(r*0.6, r, dist)` du bord du disque, pas par la dent elle-même. |
| **Décoration** | — | — | Pas de champ modifié. |
| **Gomme** | `lisse` | 0,20 | Doit fondre. Valeur actuelle conservée. |

**Cas à surveiller.** `smooth()` et `compact()` doivent **cesser** de coder leur
hardness en dur (`0.15` et `0.25`, lignes 181 et 232) et recevoir celui de
l'outil. C'est un changement de comportement visible et voulu : la main tassera
plus uniformément (`plate` + `h 0.55`), et c'est une amélioration nette — le
« pound-up » de la BIBLE §1.4 produit des couches plates, pas des cratères.

## 5.6 Courbes candidates rejetées

| Candidate | Pourquoi non |
|---|---|
| **Courbe éditable par points** (à la ZBrush / Blender) | Puissante, mais demande un widget d'édition de courbe — l'objet d'UI le moins *cozy* qui soit. Six préréglages couvrent 98 % des usages. |
| **Gaussienne pure** `exp(-4.5 t²)` | Ne vaut jamais 0 : il faut la tronquer et la renormaliser, ce qui la rend indiscernable de `lisse` à l'œil tout en coûtant un `exp` par voxel. |
| **Anneau / donut** (pic au bord) | Cas d'usage réel (l'outil « pincer » de ZBrush), mais aucun outil du catalogue actuel n'en a besoin. À rouvrir si un outil « rebord » apparaît. |
| **Courbe par bruit** (fondu irrégulier) | Séduisant pour l'aspect « grain de sable », mais le bruit doit vivre dans la *matière* (déjà présent via `stampBucket.wob`), pas dans l'outil : sinon deux passes identiques donnent des résultats différents et le joueur perd la maîtrise. |

---

# 6. ERGONOMIE DU GESTE

## 6.1 Espacement fondé sur la distance

### 6.1.1 Le diagnostic chiffré

La boucle actuelle :

```js
const period = 1 / (this.current.rate || 12);
this.accumulator += dt;
let n = 0;
while (this.accumulator >= period && n < 4) {
  this.accumulator -= period;
  this.applyOnce(period);
  n++;
}
```

Trois défauts, chiffrés au rayon par défaut de la pelle (16 cm, `rate` 14 Hz) :

| Vitesse du curseur sur le sable | Espacement entre deux dabs | En fraction du **diamètre** |
|---|---|---|
| 0 m/s (immobile) | 0 cm — **on creuse un puits sans bouger** | 0 |
| 0,2 m/s (geste lent) | 1,4 cm | 4 % |
| 1,0 m/s (geste normal) | 7,1 cm | 22 % |
| 2,5 m/s (geste rapide) | 17,9 cm | **56 % — le chapelet apparaît** |
| 5,0 m/s (geste vif) | 35,7 cm | **112 % — trous disjoints** |

Au-delà de ~40 % du diamètre, l'union des sphères cesse d'être un tube et
devient un chapelet. C'est exactement le seuil que le joueur franchit dès qu'il
balaye une façade d'un geste ample. **C'est le bug qu'il faut corriger en
premier**, avant tout ajout de paramètre.

### 6.1.2 L'algorithme

Le modèle est celui de tous les logiciels de peinture depuis 1990 :

> On ne déclenche pas un dab toutes les *N* millisecondes. On déclenche un dab
> tous les *S* **mètres parcourus**, où `S = step × rayon`. Le reste de distance
> est reporté d'une frame à l'autre.

Quatre subtilités qui font la différence entre une implémentation naïve et une
implémentation correcte :

1. **L'interpolation doit se faire en espace écran, pas en espace monde.** Si on
   interpole entre deux points 3D de la surface et qu'on applique là, le segment
   traverse le relief : sur un mur, les dabs intermédiaires flottent dans l'air
   ou s'enfoncent dans la masse. La bonne méthode est d'interpoler la
   **position du pointeur en pixels** et de **relancer un raycast** pour chaque
   dab. C'est un raycast de plus par dab, mais `field.raycast` est déjà appelé à
   chaque frame et la grille est un DDA rapide.
2. **La distance qui compte est la distance monde**, pas la distance écran.
   Sinon l'espacement change avec le zoom. On mesure donc en monde, on
   interpole en écran : il faut une petite boucle qui subdivise jusqu'à ce que
   chaque sous-segment monde soit ≤ `S`.
3. **Le premier dab est immédiat.** Un clic bref doit faire quelque chose
   (le code actuel le fait déjà, ligne 138 — il faut le conserver).
4. **Les outils de débit gardent une cadence temporelle.** L'arrosoir et le seau
   d'eau *doivent* continuer d'agir souris immobile : ce sont des robinets. On
   déclare donc un mode de trait par outil.

### 6.1.3 Trois modes de trait

| Mode | Déclenchement | Outils |
|---|---|---|
| `space` | tous les `step × rayon` parcourus | pelle, main, truelle, mirette, râteau, gomme |
| `airbrush` | tous les `1/rate` secondes **plus** l'espacement quand on bouge | arrosoir, seau d'eau |
| `once` | un seul dab au `pointerdown`, plus rien | décoration (en mode « un par un »), seau (2 temps) |

Les trois se codent dans la même classe.

### 6.1.4 Code complet — `StrokeEngine`

Nouveau fichier `src/tools/StrokeEngine.js`. Prêt à coller.

```js
/**
 * Moteur de trait : decide QUAND et OU l'outil s'applique.
 *
 * Le probleme resolu : jusqu'ici les outils s'appliquaient a cadence fixe
 * (14 a 30 Hz) independamment du mouvement de la souris. Souris immobile, on
 * creusait un puits ; souris rapide, les applications etaient espacees de plus
 * d'un diametre et laissaient un chapelet de trous au lieu d'une tranchee.
 *
 * Le modele retenu est celui des logiciels de peinture : un "dab" tous les
 * `step * rayon` metres PARCOURUS, avec report du reliquat d'une frame a
 * l'autre, et interpolation le long du trajet.
 *
 * Subtilite importante : on interpole la position du POINTEUR (en pixels) et on
 * relance un raycast pour chaque dab, au lieu d'interpoler le point 3D. Sinon
 * le segment traverse le relief et les dabs intermediaires flottent dans l'air.
 */

const MAX_DABS_PER_FRAME = 24;   // filet de securite (fenetre masquee, gros lag)

export class StrokeEngine {
  constructor(tools) {
    /** @type {import('./ToolManager.js').ToolManager} */
    this.tools = tools;
    this.reset();
  }

  reset() {
    this.active = false;
    /** Position pointeur (NDC) du dernier dab pose. */
    this.lastNdc = { x: 0, y: 0 };
    /** Point monde du dernier dab pose. */
    this.lastPoint = null;
    /** Reliquat de distance non consommee, en metres. */
    this.carry = 0;
    /** Accumulateur temporel, pour le mode aerographe. */
    this.timeAcc = 0;
    /** Nombre de dabs poses dans ce geste (sert a la granularite d'undo). */
    this.count = 0;
    /** Longueur totale parcourue, en metres. */
    this.length = 0;
    /** Vitesse lissee du geste, en m/s. */
    this.speed = 0;
    /** Direction monde lissee du geste. */
    this.dir = { x: 0, y: 0, z: 0 };
  }

  /** Debut d'un geste : premier dab immediat au point vise. */
  begin(ndc, hit) {
    this.reset();
    this.active = true;
    this.lastNdc.x = ndc.x; this.lastNdc.y = ndc.y;
    this.lastPoint = { x: hit.point.x, y: hit.point.y, z: hit.point.z };
    this.carry = 0;
    this.emit(hit, 1);
  }

  /**
   * Avance d'une frame.
   * @param {number} dt secondes
   * @param {{x:number,y:number}} ndc position pointeur normalisee (-1..1)
   * @param {{point:object, normal:object}} hit point vise courant (peut etre null)
   */
  update(dt, ndc, hit) {
    if (!this.active) return;
    const T = this.tools;
    const p = T.params;                 // ToolParams de l'outil courant
    const mode = T.current.stroke || 'space';

    if (mode === 'once') return;

    // --- aerographe : cadence temporelle, meme immobile --------------------
    if (mode === 'airbrush') {
      const period = 1 / Math.max(1, T.current.rate || 20);
      this.timeAcc += dt;
      let n = 0;
      while (this.timeAcc >= period && n < MAX_DABS_PER_FRAME) {
        this.timeAcc -= period;
        // On suit le pointeur en direct : pas d'interpolation utile pour un
        // robinet, l'eau tombe la ou on vise.
        if (hit) this.emit(hit, period * (T.current.rate || 20) / (T.current.rate || 20));
        n++;
      }
      if (hit) this.trackMotion(dt, hit.point);
      return;
    }

    // --- espacement par distance ------------------------------------------
    if (!hit || !this.lastPoint) return;

    const step = Math.max(0.004, p.step * p.radius);   // metres, plancher 4 mm
    const P = hit.point;
    let segLen = dist3(this.lastPoint, P);

    this.trackMotion(dt, P);

    if (segLen <= 1e-6) {
      // Souris immobile : on ne fait RIEN. C'est le comportement voulu.
      this.lastNdc.x = ndc.x; this.lastNdc.y = ndc.y;
      return;
    }

    // Nombre de dabs a poser sur ce segment.
    const total = this.carry + segLen;
    let nDabs = Math.floor(total / step);
    if (nDabs <= 0) {
      this.carry = total;
      this.lastNdc.x = ndc.x; this.lastNdc.y = ndc.y;
      this.lastPoint = { x: P.x, y: P.y, z: P.z };
      return;
    }
    if (nDabs > MAX_DABS_PER_FRAME) {
      // Saut enorme (fenetre revenue au premier plan, teleport du pointeur).
      // On pose quelques dabs pour ne pas laisser de trou, mais on ne bloque
      // pas la frame pendant 400 ms.
      nDabs = MAX_DABS_PER_FRAME;
    }

    const startNdc = { x: this.lastNdc.x, y: this.lastNdc.y };
    const dNdcX = ndc.x - startNdc.x;
    const dNdcY = ndc.y - startNdc.y;

    // Distance deja "consommee" au debut du segment.
    let travelled = step - this.carry;

    for (let i = 0; i < nDabs; i++) {
      // Fraction du segment, mesuree en distance MONDE mais appliquee en NDC.
      // L'approximation lineaire monde <-> ecran est excellente sur un segment
      // d'une frame (quelques dizaines de pixels au plus).
      const f = travelled / segLen;
      const nx = startNdc.x + dNdcX * f;
      const ny = startNdc.y + dNdcY * f;
      const h = T.raycastAt(nx, ny);
      if (h) this.emit(h, 1);
      travelled += step;
    }

    this.carry = total - nDabs * step;
    this.lastNdc.x = ndc.x; this.lastNdc.y = ndc.y;
    this.lastPoint = { x: P.x, y: P.y, z: P.z };
  }

  /** Vitesse et direction lissees : servent au speedDamp et a la comete. */
  trackMotion(dt, P) {
    if (!this.lastPoint || dt <= 0) return;
    const dx = P.x - this.lastPoint.x;
    const dy = P.y - this.lastPoint.y;
    const dz = P.z - this.lastPoint.z;
    const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
    const v = d / dt;
    const k = 1 - Math.pow(0.02, dt);            // lissage ~ 250 ms
    this.speed += (v - this.speed) * k;
    if (d > 1e-6) {
      this.dir.x += (dx / d - this.dir.x) * k;
      this.dir.y += (dy / d - this.dir.y) * k;
      this.dir.z += (dz / d - this.dir.z) * k;
    }
    this.length += d;
  }

  /** Pose un dab : c'est le seul endroit qui appelle tool.apply(). */
  emit(hit, weight) {
    this.count++;
    this.tools.applyDab(hit, weight, this);
  }

  end() { this.active = false; }
}

function dist3(a, b) {
  const dx = a.x - b.x, dy = a.y - b.y, dz = a.z - b.z;
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}
```

### 6.1.5 Le contrat `apply` change : `dt` devient `dose`

C'est le changement le plus intrusif de la refonte, et il faut le faire d'un
bloc. Aujourd'hui chaque outil écrit `-220 * s.dt * 26` : il **recompose
lui-même** une dose à partir du temps. C'est ce qui rend impossible de découpler
la cadence de l'intensité.

Nouveau contrat : `ToolManager` calcule **une fois** la dose du dab, et l'outil
la multiplie par sa constante d'amplitude.

```js
// ToolManager.js
applyDab(hit, weight, stroke) {
  const p = this.params;                      // ToolParams de l'outil courant
  const T = this.current;

  // --- dose du dab : c'est ICI que se decide l'intensite ------------------
  // 1. Force perceptuelle (voir §2.2.2)
  let dose = Math.pow(p.strength, 1.6);
  // 2. Pression du stylet (1.0 a la souris)
  dose *= this.pressure;
  // 3. Amortissement a geste rapide : empeche les "labours" accidentels
  //    (GAME-DESIGN §3.0.2 : geste lent = 1.0, geste tres rapide = 0.4)
  const damp = 1 - 0.6 * smoothstep(0.6, 3.0, stroke.speed);
  dose *= damp;
  // 4. Pondération du dab (aerographe : fraction de periode)
  dose *= weight;
  // 5. Plafond defensif
  dose = clamp(dose, 0, 1);

  const s = {
    ctx: this.ctx,
    hit,
    dose,                                     // <- remplace `dt`
    p,                                        // <- tous les parametres
    radius: p.radius,                         // conserve pour compatibilite
    button: this.stroke ? this.stroke.button : 0,
    shift: this.shift, ctrl: this.ctrl, alt: this.alt,
    dir: stroke.dir, speed: stroke.speed,
    game: this.game,
    tool: T,
  };

  // La symetrie enveloppe l'application (voir §6.2).
  this.forEachSymmetry(s, (ss) => T.apply?.(ss));

  // Granularite d'undo : on coupe le groupe tous les N dabs (voir §6.5).
  if (stroke.count % UNDO_SPLIT_DABS === 0) this.splitUndoGroup();
}
```

Et un outil devient, par exemple pour la pelle :

```js
// tools.js — pelle, apres refonte
{
  id: 'shovel',
  // ...
  stroke: 'space',
  params: {                       // valeurs par defaut de ToolParams
    radius: 0.16, strength: 0.55, hardness: 0.30,
    curve: CURVE.lisse, step: 0.22, secondary: 'deposit',
    capacity: 0.012, throw: 0.35,
  },
  DIG_RATE: 5700,                 // densite/seconde au centre, a pleine dose
  apply(s) {
    const g = s.game, p = s.hit.point, P = s.p;
    if (s.button === 0) {
      const w  = g.field.averageMoisture(p.x, p.y, p.z, P.radius * 0.8);
      const pk = g.field.averagePacking(p.x, p.y, p.z, P.radius * 0.8);
      const v = B.sphere(s.ctx, p.x, p.y, p.z, P.radius,
                         -this.DIG_RATE * s.dose,
                         { hardness: P.hardness, curve: P.curve });
      // ... suite inchangee, avec P.capacity au lieu de 0.35
    } else {
      // ... depot, decale de P.throw * P.radius le long de s.dir
    }
  },
}
```

**Conversion des constantes.** Chaque `X * s.dt * RATE` devient `X * RATE * dose`
en posant `dose_ref = 1` : autrement dit, on remplace `s.dt * rate` par `1` et
on garde le facteur. Vérification pour la pelle : `220 * 26 = 5720` ≈ `DIG_RATE`.
La conversion est mécanique et sans risque, outil par outil.

### 6.1.6 Points de trajet manqués : `getCoalescedEvents`

Aujourd'hui `onMove` ne stocke que la dernière position. Sur une tablette à
120 Hz ou une souris gaming à 1000 Hz, avec un rendu à 60 fps, on perd 1 à
16 points intermédiaires par frame. À vitesse élevée, les points perdus sont
justement ceux qui décrivent la courbe du geste.

Correction en trois lignes :

```js
onMove(e) {
  if (!this.enabled) return;
  const evs = e.getCoalescedEvents ? e.getCoalescedEvents() : [e];
  for (const ev of evs) this.queuePointer(ev);   // file de positions NDC
  this.updatePointer(e);
  this.pressure = (e.pointerType === 'pen' && e.pressure > 0)
    ? pressureCurve(e.pressure) : 1;
}
```

Le `StrokeEngine` consomme alors la file au lieu d'un seul point, ce qui donne
un trajet fidèle. Coût : un tableau de quelques dizaines d'entrées par frame.

**Courbe de pression.** `PointerEvent.pressure` est linéaire de 0 à 1 mais les
stylets ne sont pas linéaires en ressenti. La courbe usuelle est
`pressureCurve(x) = 0.15 + 0.85 * x^1.4` (⚠︎ exposant à tuner) : un plancher non
nul évite que l'outil ne fasse rien en début de trait, et l'exposant donne du
contrôle dans les pressions faibles. À exposer comme une case à cocher unique
(« Sensibilité au stylet ») et rien de plus.

## 6.2 Symétrie

### 6.2.1 Est-ce utile pour un château ?

**Oui, massivement, et c'est probablement le meilleur rapport
plaisir/implémentation de tout ce document.** Trois arguments :

1. **Un château est symétrique par nature.** Une façade, un donjon à quatre
   tours, un porche : tout est en miroir. Un joueur qui sculpte la moitié gauche
   puis doit refaire la droite à main levée obtient un résultat asymétrique et
   décevant, et il abandonne le détail.
2. **La symétrie radiale est *exactement* le geste du tour de potier**, et elle
   produit des tours, des dômes et des rosaces en un geste. C'est un moment
   « waouh » gratuit.
3. **`GAME-DESIGN.md` §3.1 la liste déjà** (outil n°17) et §4.1.2 réserve les
   touches. Ce n'est pas une invention, c'est une dette.

**Le contre-argument, et sa réponse.** La symétrie parfaite peut donner un objet
« mécanique », contraire au charme fait-main. Deux parades : (a) elle est
désactivée par défaut ; (b) un paramètre `symJitter` (N3, ~2 % du rayon)
décale imperceptiblement chaque copie, ce qui garde la lecture symétrique tout
en évitant l'aspect cloné. C'est ce que font les outils de *scattering*.

### 6.2.2 Implémentation sur un champ de voxels

La bonne surprise : **c'est trivial ici**, parce que toutes les opérations de
`Brush.js` prennent un point monde et (parfois) une direction monde. Il suffit
de rappeler `apply` avec des points transformés. Trois conditions :

1. **Transformer aussi les vecteurs.** Un miroir sur X inverse la composante `x`
   des directions (normale du plan de coupe, axe des rainures, direction du
   geste). Un oubli ici donne une truelle qui coupe du mauvais côté sur la copie
   miroir — le bug classique.
2. **Un seul groupe d'undo.** Déjà garanti : `UndoStack.captureChunk` ignore les
   chunks déjà photographiés dans le groupe courant (`if (g.chunks.has(ci))
   return`). Donc N copies dans le même geste = un seul instantané par chunk.
   **Rien à changer dans `UndoStack`.**
3. **Le miroir doit s'appliquer autour d'un axe choisi, pas autour de l'origine
   du monde.** Un château est rarement centré sur (0,0). L'axe est donc un
   `{x, z}` déplaçable (`Maj+Y` le pose sous le curseur), matérialisé au sol par
   une fine ligne pointillée crème.

### 6.2.3 Code

```js
// ToolManager.js — symetrie

/**
 * Etat de symetrie. `mirrorX` reflete autour du plan x = axis.x ;
 * `mirrorZ` autour de z = axis.z ; `radial` repete N fois autour de
 * l'axe vertical passant par `axis`.
 */
initSymmetry() {
  this.sym = { mirrorX: false, mirrorZ: false, radial: 1,
               axis: { x: 0, z: 0 }, jitter: 0.02 };
  this._symBuf = [];
}

/**
 * Applique `fn` une fois par instance symetrique.
 *
 * Les POINTS et les DIRECTIONS sont transformes ensemble : oublier les
 * directions donne une truelle qui coupe du mauvais cote sur la copie miroir.
 *
 * L'undo est gratuit : UndoStack.captureChunk ignore un chunk deja photographie
 * dans le groupe courant, donc N copies = 1 instantane par chunk.
 */
forEachSymmetry(s, fn) {
  const S = this.sym;
  const n = S.radial | 0;
  if (!S.mirrorX && !S.mirrorZ && n <= 1) { fn(s); return; }

  const ax = S.axis.x, az = S.axis.z;
  const out = this._symBuf; out.length = 0;

  // 1. Repetition radiale autour de l'axe vertical.
  const seeds = [];
  const px = s.hit.point.x - ax, pz = s.hit.point.z - az;
  const nx0 = s.hit.normal.x,    nz0 = s.hit.normal.z;
  const dx0 = s.dir ? s.dir.x : 0, dz0 = s.dir ? s.dir.z : 0;
  for (let k = 0; k < Math.max(1, n); k++) {
    const a = (k / Math.max(1, n)) * Math.PI * 2;
    const c = Math.cos(a), si = Math.sin(a);
    seeds.push({
      px: px * c - pz * si, pz: px * si + pz * c,
      nx: nx0 * c - nz0 * si, nz: nx0 * si + nz0 * c,
      dx: dx0 * c - dz0 * si, dz: dx0 * si + dz0 * c,
      sx: 1, sz: 1,
    });
  }

  // 2. Miroirs, appliques a chaque graine radiale.
  for (const g of seeds) {
    out.push(g);
    if (S.mirrorX) out.push({ ...g, px: -g.px, nx: -g.nx, dx: -g.dx, sx: -g.sx });
  }
  const len = out.length;
  if (S.mirrorZ) {
    for (let i = 0; i < len; i++) {
      const g = out[i];
      out.push({ ...g, pz: -g.pz, nz: -g.nz, dz: -g.dz, sz: -g.sz });
    }
  }

  // 3. Application. La premiere instance est l'originale : aucun jitter.
  const hit0 = s.hit;
  for (let i = 0; i < out.length; i++) {
    const g = out[i];
    const j = i === 0 ? 0 : S.jitter * s.p.radius;
    const jx = j ? (Math.random() - 0.5) * j : 0;
    const jz = j ? (Math.random() - 0.5) * j : 0;
    s.hit = {
      point:  { x: ax + g.px + jx, y: hit0.point.y, z: az + g.pz + jz },
      normal: { x: g.nx, y: hit0.normal.y, z: g.nz },
      mirrored: g.sx * g.sz < 0,     // utile aux outils qui posent des objets
    };
    if (s.dir) s.dir = { x: g.dx, y: s.dir.y, z: g.dz };
    fn(s);
  }
  s.hit = hit0;
}
```

### 6.2.4 Pièges à connaître

| Piège | Effet | Parade |
|---|---|---|
| **Coût CPU multiplié par N** | Symétrie radiale 8 + 2 miroirs = 32 applications par dab. À 90 cm de rayon, injouable. | Plafonner le produit `radial × miroirs` à 8, et **réduire automatiquement le nombre de dabs** (`step` effectif × N^0,4) quand la symétrie est active. |
| **Le point miroir peut être hors terrain** | `ctx.begin()` renvoie `false`, l'opération est ignorée en silence. C'est le bon comportement. | Rien à faire, mais ne pas s'étonner. |
| **Les copies se chevauchent près de l'axe** | Sculpter sur l'axe applique 2× (ou N×) au même endroit : effet doublé, visible. | Atténuer la dose des copies dont le point est à moins de `radius` de l'axe : `dose *= smoothstep(0, radius, distAxe)`. |
| **La décoration miroir doit être miroir** | Un drapeau miroité doit être *retourné*, pas juste déplacé. | Le drapeau `mirrored` du hit est propagé à `props.place()`. |
| **La symétrie et le verrou d'altitude** | Le miroir conserve `y`, ce qui est correct pour un miroir vertical. | Rien. |

### 6.2.5 Affordance

La symétrie doit être **impossible à oublier active** — c'est la source n°1 de
frustration dans les logiciels de sculpture (« pourquoi ça sculpte de l'autre
côté aussi ?! »). Trois signaux :

1. **Une ligne pointillée crème au sol** le long de chaque plan actif, visible en
   permanence.
2. **Le bouton de la barre d'outils est encadré** d'un liseré vert sauge.
3. **Le curseur affiche ses copies fantômes** (un simple anneau atténué à
   `uCursorStrength × 0.35` pour chaque instance) — c'est le signal le plus
   efficace, parce qu'il est au point de regard.

## 6.3 Verrouillage d'axe, ligne droite, contraintes

Trois contraintes, toutes attendues et aucune implémentée. Le commentaire
d'en-tête de `ToolManager` promet déjà la première.

### 6.3.1 Verrou d'axe (`Maj` maintenu pendant le geste)

**Comportement.** Au premier mouvement significatif après l'appui de `Maj`, on
détermine l'axe monde dominant du geste (X, Z, ou Y si le geste est
majoritairement vertical). Ensuite, tous les points sont **projetés sur la
droite** passant par le point de départ et dirigée par cet axe.

Détail décisif : la détection ne doit pas se faire au tout premier pixel (bruit),
mais après un déplacement de **12 px**, avec une **hystérésis** — une fois l'axe
choisi, il ne change plus tant que `Maj` n'est pas relâché. Sans hystérésis,
l'axe saute quand le geste passe près de la diagonale, ce qui est
insupportable.

```js
// ToolManager — dans raycast(), apres la projection surface / plan verrouille
applyAxisLock(hit) {
  const st = this.stroke;
  if (!st || !this.shift || !hit) return hit;

  const s = st.startPoint;
  const dx = hit.point.x - s.x, dy = hit.point.y - s.y, dz = hit.point.z - s.z;

  if (st.axis === undefined) {
    // Hysteresis : on ne choisit qu'apres 12 px equivalents (~2 cm monde au
    // zoom par defaut) et on ne revient jamais dessus.
    if (Math.hypot(dx, dy, dz) < 0.02) return hit;
    const ax = Math.abs(dx), ay = Math.abs(dy), az = Math.abs(dz);
    st.axis = (ay > ax && ay > az) ? 1 : (ax >= az ? 0 : 2);
  }

  const p = { x: s.x, y: s.y, z: s.z };
  if (st.axis === 0) p.x = hit.point.x;
  else if (st.axis === 1) p.y = hit.point.y;
  else p.z = hit.point.z;

  return { ...hit, point: p, constrained: true };
}
```

**Retour visuel :** une ligne fine de la couleur de l'outil, du point de départ
au curseur, prolongée de 30 cm au-delà. Elle dit « tu es sur un rail ».

### 6.3.2 Ligne droite (`Maj` + clic sans glisser)

C'est le *line tool* de tous les logiciels de peinture, et c'est **la
fonctionnalité qui manque le plus pour faire des murs**.

**Comportement.** `Maj + clic` alors qu'un point d'ancrage existe (le dernier
point du geste précédent) applique l'outil **le long du segment** entre l'ancre
et le point cliqué, avec le même espacement `step × radius`. Une seule action,
un seul undo.

```js
strokeLine(a, b) {
  const p = this.params;
  const step = Math.max(0.004, p.step * p.radius);
  const d = dist3(a, b);
  const n = Math.max(1, Math.min(400, Math.ceil(d / step)));
  this.undo.beginGroup(this.current.name + ' (ligne)');
  const eng = { speed: 0, dir: norm3(sub3(b, a)), count: 0 };
  for (let i = 0; i <= n; i++) {
    const f = i / n;
    // On interpole en NDC puis on relance un raycast, comme pour un trait
    // normal : sinon le segment traverse le relief.
    const h = this.raycastAt(lerp(a.ndc.x, b.ndc.x, f), lerp(a.ndc.y, b.ndc.y, f));
    if (h) { eng.count = i; this.applyDab(h, 1, eng); }
  }
  this.undo.endGroup();
}
```

**Usage :** un mur de 3 m à la truelle en deux clics. Une rangée de créneaux au
seau. Une douve rectiligne à la pelle. C'est immédiatement lisible et personne
n'a besoin qu'on l'explique.

### 6.3.3 Les autres contraintes, par ordre de valeur

| Contrainte | Geste | Valeur | Coût |
|---|---|---|---|
| **Verrou d'altitude** | `Ctrl` maintenu | ★★★★★ | **déjà implémenté** |
| **Ligne droite** | `Maj` + clic | ★★★★★ | faible (code ci-dessus) |
| **Verrou d'axe** | `Maj` maintenu | ★★★★ | faible |
| **Plan de travail figé** | `Tab` | ★★★★ | moyen (spécifié §4.3 de GAME-DESIGN) |
| **Arc / cercle** | `Ctrl+Maj` + glisser depuis un centre | ★★★ | moyen — mais c'est le *compas improvisé* de la BIBLE §3.5, très fidèle |
| **Stabilisateur de trait** | permanent, réglable | ★★★ | faible (voir ci-dessous) |
| **Magnétisme sur la grille** | `G` | ★ | à éviter : anti-cozy, le sable n'est pas un tableur |

**Le stabilisateur** mérite un mot. C'est un lissage du trajet du curseur (le
« smooth stroke » de Blender, la « stabilisation » de Krita) : au lieu de suivre
le pointeur, l'outil suit un point qui *poursuit* le pointeur avec un retard
élastique. Trois lignes de code, effet énorme sur la qualité des courbes tracées
à la souris :

```js
// dans StrokeEngine.update(), avant le calcul du segment
if (p.smoothing > 0) {
  const k = 1 - Math.pow(1 - p.smoothing, dt * 60);
  this.anchor.x += (P.x - this.anchor.x) * (1 - p.smoothing * 0.85);
  // ... idem y, z ; on utilise `anchor` au lieu de P pour poser les dabs
}
```

À exposer ? **Non, en N3, avec une valeur fixe faible (0,25).** C'est un réglage
que personne ne comprend en le lisant et que tout le monde apprécie sans le
savoir. Le mettre à 0 rend la souris nerveuse ; le monter au-delà de 0,6 donne
une sensation de latence.

## 6.4 Répétition d'un motif le long d'un chemin — les créneaux

C'est la fonctionnalité qui transforme le jeu, et elle **tombe presque
gratuitement** du moteur de trait.

### 6.4.1 Le principe

Le `StrokeEngine` sait déjà poser un événement tous les `S` mètres parcourus. Il
suffit de changer ce que fait cet événement :

| Mode | Ce que fait un dab | Résultat |
|---|---|---|
| `brush` (défaut) | applique la brosse | trait continu |
| `stamp` | applique **un motif orienté** selon la tangente du chemin | chapelet régulier de formes |

Avec `step = 1.0` (un dab par diamètre) et un motif « bloc rectangulaire », on
obtient… **des créneaux**. Avec un motif « demi-sphère », des modillons. Avec un
prop, une haie d'oyats.

### 6.4.2 Les motifs proposés

| Motif | Primitive | Usage |
|---|---|---|
| `merlon` | boîte arrondie, hauteur `1,2 × r`, orientée tangente/normale | **créneaux** sur un chemin de ronde |
| `crenel` | l'inverse : une soustraction rectangulaire | découper des créneaux dans un mur existant |
| `corbel` | demi-cylindre horizontal saillant | corniche à modillons |
| `step` | marche rectangulaire décalée en `y` de `+h` à chaque dab | **escalier** — le dab n°k monte de `k × h` |
| `arcade` | arche : deux `planeCut` + une soustraction cylindrique | galerie |
| `prop` | pose un objet de `DECOR_VARIANTS` | haie, palissade, alignement de galets |

### 6.4.3 Code : orientation et pose

La seule difficulté est l'orientation. Un créneau doit être **aligné sur la
tangente du chemin**, pas sur les axes du monde, sinon une courbe donne des
blocs de guingois.

```js
/**
 * Depose un motif oriente par la tangente du chemin.
 *
 * Repere local :
 *   T = tangente du geste (projetee dans le plan horizontal si le motif doit
 *       rester d'aplomb, ce qui est le cas des creneaux)
 *   N = normale de la surface visee
 *   Bt = T x N
 *
 * `index` est le numero du dab dans le geste : il sert aux motifs progressifs
 * (escalier) et a l'alternance (un merlon sur deux).
 */
export function stampAlongPath(ctx, hit, dir, params, index) {
  const p = hit.point;
  const r = params.radius;

  // Tangente horizontale, normalisee. Si le geste est trop lent pour avoir une
  // direction fiable, on garde la derniere connue (le StrokeEngine la lisse).
  let tx = dir.x, tz = dir.z;
  const tl = Math.hypot(tx, tz) || 1;
  tx /= tl; tz /= tl;

  switch (params.pattern) {
    case 'merlon': {
      // Un bloc sur deux : creneaux pleins et vides.
      if (params.alternate && (index & 1)) return;
      B.box(ctx, p.x, p.y + r * 0.55, p.z,
            tx, tz,                         // orientation horizontale
            r * 0.9, r * 1.2, r * 0.75,     // demi-dimensions L/H/P
            +255, { hardness: 0.9, curve: CURVE.franche,
                    moisture: params.moisture, packing: 0.75 });
      break;
    }
    case 'crenel': {
      if (index & 1) return;
      B.box(ctx, p.x, p.y + r * 0.6, p.z, tx, tz,
            r * 0.8, r * 1.4, r * 1.6, -255,
            { hardness: 0.95, curve: CURVE.franche });
      break;
    }
    case 'step': {
      const h = r * 0.55 * index;
      B.box(ctx, p.x, p.y + h, p.z, tx, tz, r, r * 0.3, r, +255,
            { hardness: 0.9, curve: CURVE.franche, packing: 0.8 });
      break;
    }
    case 'prop': {
      const jitter = params.jitter * r;
      ctx.game.props.place(params.variant,
        p.x + (Math.random() - 0.5) * jitter,
        p.y,
        p.z + (Math.random() - 0.5) * jitter,
        params.align === 'vertical' ? { x: 0, y: 1, z: 0 } : hit.normal,
        params.scale * (1 + (Math.random() - 0.5) * params.jitter * 0.4));
      break;
    }
  }
}
```

Cela suppose **une nouvelle primitive `B.box()`** dans `Brush.js` — une boîte
orientée autour d'un axe vertical, à coins adoucis. C'est ~50 lignes sur le
modèle de `stampBucket`, avec un champ de distance signé de boîte :

```js
// sdBox local, dans le repere (T, up, Bt)
const lx =  dx * tx + dz * tz;              // le long de la tangente
const lz = -dx * tz + dz * tx;              // perpendiculaire
const ly =  dy;
const qx = Math.abs(lx) - hx, qy = Math.abs(ly) - hy, qz = Math.abs(lz) - hz;
const outside = Math.hypot(Math.max(qx,0), Math.max(qy,0), Math.max(qz,0));
const inside  = Math.min(Math.max(qx, Math.max(qy, qz)), 0);
const sd = -(outside + inside);             // >0 dedans
const target = clamp(128 + sd * 128 / round, 0, 255);
```

### 6.4.4 Ergonomie du mode motif

- **Touche `N`** bascule le mode `stamp` de l'outil courant (les outils qui le
  supportent : seau, mirette, décoration, truelle).
- **Le `step` devient le paramètre principal** et son unité change dans le
  panneau : « un créneau tous les **28 cm** » au lieu de « pas 0,9 ».
- **Le curseur montre le motif fantôme** à sa prochaine position, orienté selon
  la tangente courante. C'est indispensable : sans ça on ne sait pas où tombera
  le prochain créneau.
- **`Maj` + clic (ligne droite) + mode motif** = une rangée de créneaux parfaite
  sur un mur droit, en deux clics. C'est le combo qui justifie tout le chapitre.

## 6.5 Granularité d'annulation

Trois corrections à `UndoStack` / `ToolManager`, par ordre d'importance.

### 6.5.1 Découpage des gestes longs

Un geste de 8 s = un seul undo aujourd'hui. Correction : couper le groupe tous
les `UNDO_SPLIT_DABS` dabs **ou** toutes les 2,5 secondes, en gardant le même
libellé suffixé d'un compteur invisible.

```js
const UNDO_SPLIT_DABS = 48;
const UNDO_SPLIT_SECONDS = 2.5;

splitUndoGroup() {
  const label = this.current.name;
  this.undo.endGroup();
  this.undo.beginGroup(label);
  this._groupStart = performance.now();
}
```

Le joueur perçoit alors « un Ctrl+Z annule les deux dernières secondes de
ratissage », ce qui est bien plus proche de son intention que « annule les huit
secondes ».

### 6.5.2 Compression des instantanés

`BYTES_PER_CHUNK = 131 072`. Une bande de 2 m touche 12 chunks → 1,5 Mo par
geste, ~42 gestes d'historique. `GAME-DESIGN.md` §9.3 prévoit déjà la parade :

> « On stocke un delta compressé (les indices modifiés + les anciennes valeurs)
> plutôt que le chunk entier quand moins de 15 % du chunk est touché. »

En pratique un dab de 16 cm de rayon dans un chunk de 32³ touche ~2 % des
voxels. Le gain est donc d'un facteur 10 à 30 sur la grande majorité des
gestes — soit **500 à 1 000 gestes d'historique** au lieu de 42. C'est la
différence entre « je peux revenir en arrière » et « je peux explorer sans
peur », ce qui est un pilier (`GAME-DESIGN.md` §1.2, sécurité).

Implémentation : `captureChunk` diffère la copie et enregistre plutôt un
`Set` d'indices touchés + un `Uint8Array` des anciennes valeurs, avec bascule
vers l'instantané plein si le compte dépasse 15 % de `CHUNK3`.

### 6.5.3 `Ctrl+Z` pendant un geste

Aujourd'hui : `undo()` fait `endGroup()` puis restaure, mais `this.stroke` reste
actif et continue d'écrire — dans un groupe fraîchement rouvert, sur des données
qui viennent d'être restaurées. Comportement indéfini.

Correction, deux lignes :

```js
if ((e.ctrlKey || e.metaKey) && e.code === 'KeyZ') {
  e.preventDefault();
  this.endStroke();            // <- ferme proprement le geste en cours
  this.strokeEngine.end();
  // ... suite inchangee
}
```

### 6.5.4 Ce qu'on ne fait PAS

**Pas d'undo par dab.** Certains logiciels le proposent ; c'est un piège ici :
avec l'espacement par distance, un geste ample fait 200 dabs. Un `Ctrl+Z` qui
recule d'un dab donnerait l'impression que l'undo est cassé.

**Pas de gomme temporelle en v1.** `GAME-DESIGN.md` §9.3 la mentionne (rejouer
les deltas à l'envers localement) : c'est une idée superbe mais elle dépend de
la compression par delta (§6.5.2). À garder pour la v2.

---

# 7. INTERFACE

## 7.1 Contrainte de départ

Le style est posé et il est bon : galets crème très arrondis (`--r-lg: 26px`,
`border-radius: 999px` pour la barre), ombres brun-chaud diffuses, icônes au
trait 1,5 px, aucun angle droit. Tout ce qui suit **réutilise les jetons CSS
existants** (`--cream`, `--sand`, `--ink`, `--ink-soft`, `--shadow-soft`,
`--r-md`) et n'en introduit qu'un : `--r-pill`.

La contrainte dure : `GAME-DESIGN.md` §5.4 impose que l'UI sache disparaître, et
`HUD.js` en tête impose « aucun chiffre brut » pour l'état du sable. Les
réglages d'outil sont l'exception assumée à cette dernière règle — un rayon en
centimètres est une information *utile*, pas une abstraction. Mais elle reste
soumise à la première : **fermé par défaut, effacé pendant le geste**.

## 7.2 État fermé — ce que voit un joueur qui n'a rien ouvert

```
                        ╭───────────────────────────────╮
                        │  Râteau   Grave des rainures  │      <- .tool-info (existant)
                        │           écart 5 cm · 62 %   │
                        ╰───────────────────────────────╯

   ╭──────────────────────────────────────────────────────────────────────╮
   │  ⛏   ✋   🚿   💧   🪣   🔪   ◡   ⌗   ⚑   ▱  │  ↺   ⤺  │
   │  1    2    3    4    5    6    7   [8]   9    0  │           │
   ╰──────────────────────────────────────────────────────────────────────╯
                                        ⌄                                    <- chevron discret
```

**Une seule chose change par rapport à aujourd'hui :**

1. `.tool-info` gagne une deuxième ligne courte qui affiche **les deux réglages
   N1** de l'outil courant (ici : écart du râteau et Force). Deux valeurs, pas
   six. Elle reprend le style `.ti-size` existant, en `--ink-soft`.
2. Un **chevron de 8 px** sous le bouton actif dit qu'il y a un panneau dessous.

C'est tout. L'écran ne gagne pas un pixel de panneau. Le joueur qui ne veut pas
de réglages ne les voit jamais.

## 7.3 État ouvert — le panneau de réglages

```
   ╭────────────────────────────────────────────────────────────────────╮
   │                                                                    │
   │   ⌗  RÂTEAU                                    Stries ▾    ✕      │
   │      Grave des rainures : briques, tuiles, stries                  │
   │                                                                    │
   │   ─────────────────────────────────────────────────────────────    │
   │                                                                    │
   │   Rayon        ●━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━○      14 cm   │
   │                                                        molette     │
   │                                                                    │
   │   Force        ●━━━━━━━━━━━━━━━━━━━━○                     62 %    │
   │                                                      Maj+molette   │
   │                                                                    │
   │   Écartement   ●━━━━━━━━━━━○                                5 cm   │
   │                                                      Alt+molette   │
   │                                                                    │
   │   ─────────────────────────────────────────────────  plus ⌄  ──    │
   │                                                                    │
   │   Profondeur   ●━━━━━━━━━━━━━━━━━━━○                      1,2 cm   │
   │                                                                    │
   │   Orientation  ●━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━○            0°    │
   │                                                                    │
   │   Motif        ╭─────╮ ╭─────╮ ╭─────╮ ╭─────╮                     │
   │                │ ≡≡≡ │ │ ▤▤▤ │ │ ⌒⌒⌒ │ │ ⌇⌇⌇ │                     │
   │                ╰─────╯ ╰─────╯ ╰─────╯ ╰─────╯                     │
   │                 stries  briques  tuiles   bois                     │
   │                                                                    │
   │   Bord         ╭──╮ ╭──╮ ╭──╮ ╭──╮ ╭──╮ ╭──╮      ●━━━━━━○  70 %   │
   │                │▔▔│ │╭╮│ │╱ │ │◣ │ │▐▌│ │╭─│                        │
   │                ╰──╯ ╰──╯ ╰──╯ ╰──╯ ╰──╯ ╰──╯                        │
   │                galette lisse linéaire pointue franche voile        │
   │                                                                    │
   │   Clic droit   ( lisser )  ( effacer les rainures )                │
   │                                                                    │
   │   ─────────────────────────────────────────────────────────────    │
   │   ⟳  Stries   Briques   Tuiles   Bois   Fourchette   +             │
   ╰────────────────────────────────────────────────────────────────────╯
   ╭──────────────────────────────────────────────────────────────────────╮
   │  ⛏   ✋   🚿   💧   🪣   🔪   ◡  [⌗]  ⚑   ▱  │  ↺   ⤺  │
   ╰──────────────────────────────────────────────────────────────────────╯
```

### Anatomie, de haut en bas

| Zone | Contenu | Toujours présente ? |
|---|---|---|
| **En-tête** | icône + nom + `hint` + nom du préréglage courant + fermeture | oui |
| **Bloc N1** | 2 ou 3 curseurs, avec le raccourci en gris sous le curseur | oui |
| **Séparateur « plus ⌄ »** | replie tout le bloc N2 | oui |
| **Bloc N2** | 1 à 4 curseurs / vignettes propres à l'outil | selon l'outil |
| **Bord + Profil** | une ligne combinée : les six silhouettes **et** le curseur de plateau | oui |
| **Clic droit** | 2 à 3 pastilles | oui |
| **Barre de préréglages** | les livrés puis les joueurs, plus un « + » | oui |

### Décisions de design

**Le raccourci est écrit sous chaque curseur N1.** Trois mots gris, 10 px. C'est
le moyen le moins cher d'enseigner `Maj+molette` : le joueur le lit à l'instant
exact où il utilise le curseur à la souris, et la fois d'après il essaie le
raccourci. Aucun tutoriel ne fait mieux.

**Bord et Profil sont sur une seule ligne.** Ce sont les deux moitiés d'une
même idée (§5.2). Les séparer donnerait deux réglages incompréhensibles ; les
réunir donne un objet unique « la forme du bord », qui se comprend en le
regardant. Les six silhouettes sont des SVG au trait de 20×14 px, dans le même
langage graphique que les icônes d'outils.

**Aucun champ de saisie numérique.** La valeur est affichée à droite du curseur,
mais elle n'est pas éditable. Un jeu cozy ne demande pas de taper « 0,347 ».
Exception admise : un clic sur la valeur la remet au défaut de l'outil — c'est
le geste de reset universel, et il est découvrable par le curseur `pointer`.

**Les unités sont celles du monde.** « 14 cm », « 4 L/s », « 1,2 cm », « 8
créneaux », « 0° ». Jamais « 0,62 » sauf pour la Force, où « 62 % » est la
formulation la plus honnête (c'est une fraction du maximum de l'outil, pas une
grandeur physique).

**Un seul geste ferme tout :** `Échap`, clic ailleurs, `C`, ou re-clic sur
l'outil actif.

## 7.4 Le cadran 2D (`B` maintenu)

Pas un panneau : un dessin **sous le curseur**, dans le monde.

```
                    Force
                      ▲
                      │
              ╭───────┼───────╮
              │       │       │
              │       │   ✛   │  ← position courante dans le cadran
              │       │       │
        ──────┼───────┼───────┼──────▶  Rayon
              │       │       │
              │       │       │
              ╰───────┼───────╯
                      │

                 ╭──────────────────╮
                 │  14 cm  ·  62 %  │
                 ╰──────────────────╯
```

- Le cadre fait 180 px de côté, crème à 80 % d'opacité, coins à 26 px.
- L'anneau de brosse continue d'être dessiné sur le sable derrière, **et il
  change en direct**. C'est le point : on règle en regardant le sable, pas le
  cadran. Le cadran n'est qu'une confirmation périphérique.
- À la sortie, le cadran s'efface en 180 ms et la pastille de valeur reste
  900 ms (§4.5).

## 7.5 Le menu radial des préréglages (`Maj+E` maintenu)

```
                       ╭───────╮
                       │ Bois  │
                       ╰───────╯
          ╭────────╮              ╭─────────╮
          │Fourchette│            │ Stries  │
          ╰────────╯              ╰─────────╯
                        ● ← curseur
          ╭────────╮              ╭─────────╮
          │ Tuiles │              │ Briques │
          ╰────────╯              ╰─────────╯
                       ╭───────╮
                       │   +   │
                       ╰───────╯
```

Six secteurs maximum. Chaque pastille montre **une vignette du résultat**
(un carré de 40 px avec la texture générée hors ligne), pas une icône
abstraite — conforme à §5.2 (« Toutes les icônes sont des objets réels »).
Sélection par direction, validation au relâchement. Stagger de 12 ms par
secteur au déploiement, comme spécifié §5.2.

## 7.6 Comment garder l'écran calme

Huit règles, dans l'ordre où elles s'appliquent.

| # | Règle | Mise en œuvre |
|---|---|---|
| 1 | **Rien de nouveau par défaut** | Panneau fermé, cadran absent, radial absent. L'écran au premier lancement est **identique** à celui d'aujourd'hui, plus un chevron de 8 px. |
| 2 | **Un seul panneau à la fois** | Ouvrir le panneau d'outil ferme l'aide, et réciproquement. Aucun empilement possible. |
| 3 | **Tout s'efface pendant le geste** | `pointerdown` → le panneau passe à `opacity: 0; pointer-events: none` en 120 ms. Retour en 250 ms au `pointerup`. Étend la règle « fade en action » de §5.4. |
| 4 | **La valeur est temporaire** | La pastille de réglage vit 900 ms. Aucun affichage numérique permanent en dehors du panneau ouvert. |
| 5 | **N2 est replié** | Le bloc « plus ⌄ » est fermé la première fois. Son état est mémorisé **par outil** : le joueur qui déplie le râteau ne déplie pas la gomme. |
| 6 | **Six lignes maximum** | Contrainte dure (§2.1). Si un outil en demande une septième, c'est qu'un paramètre doit descendre en N3. |
| 7 | **Le panneau est le même galet** | Il partage la bordure et l'ombre de la barre d'outils et s'ancre dessus. Visuellement l'écran ne gagne pas d'objet, la barre grandit. |
| 8 | **Auto-fade hérité** | Après 6 s d'inactivité, le panneau suit la règle générale (opacité 25 %). |

## 7.7 CSS — extrait

Dans le langage existant, sans nouveau jeton sauf `--r-pill`.

```css
/* --- panneau de reglages d'outil ------------------------------------------
   Il pousse la barre d'outils vers le haut au lieu de flotter au-dessus :
   visuellement, l'ecran ne gagne pas un objet, la barre grandit. */

.tool-panel {
  position: absolute;
  bottom: 88px;
  left: 50%;
  transform: translateX(-50%) translateY(8px) scale(0.97);
  width: min(560px, calc(100vw - 32px));
  padding: 18px 22px 14px;
  border-radius: var(--r-lg);
  background: rgba(253, 247, 234, 0.97);
  border: 1.5px solid rgba(255, 255, 255, 0.8);
  box-shadow: var(--shadow-hi);
  opacity: 0;
  pointer-events: none;
  transition: opacity 0.22s ease,
              transform 0.22s cubic-bezier(0.34, 1.3, 0.64, 1);
}
.tool-panel.open   { opacity: 1; pointer-events: auto;
                     transform: translateX(-50%) translateY(0) scale(1); }
/* Pendant un geste : on sculpte, on ne lit pas. */
.tool-panel.acting { opacity: 0; pointer-events: none; transition-duration: 0.12s; }

.tp-row {
  display: grid;
  grid-template-columns: 92px 1fr 64px;
  align-items: center;
  gap: 12px;
  padding: 7px 0;
}
.tp-label { font-size: 0.92em; color: var(--ink); }
.tp-value { font-size: 0.92em; font-weight: 800; color: var(--ink);
            text-align: right; font-variant-numeric: tabular-nums;
            cursor: pointer; }        /* clic = retour au defaut */
.tp-key   { grid-column: 2; font-size: 0.66em; color: var(--ink-soft);
            opacity: 0.7; margin-top: -4px; }

/* Curseur : piste sable, poignee creme bombee, aucun angle droit. */
.tp-slider { -webkit-appearance: none; appearance: none;
             width: 100%; height: 22px; background: transparent; }
.tp-slider::-webkit-slider-runnable-track {
  height: 8px; border-radius: 999px;
  background: linear-gradient(90deg, var(--sand) 0%, var(--sand) var(--fill, 50%),
                              rgba(200, 172, 124, 0.28) var(--fill, 50%));
}
.tp-slider::-webkit-slider-thumb {
  -webkit-appearance: none; width: 20px; height: 20px; margin-top: -6px;
  border-radius: 50%; background: var(--cream);
  border: 2px solid var(--sand-dark);
  box-shadow: 0 2px 6px rgba(74, 58, 40, 0.28);
  transition: transform 0.13s cubic-bezier(0.34, 1.56, 0.64, 1);
}
.tp-slider:hover::-webkit-slider-thumb { transform: scale(1.15); }

/* Vignettes (profil de bord, motif, buse) : des formes, pas des mots. */
.tp-chips { display: flex; gap: 6px; }
.tp-chip {
  width: 44px; height: 34px;
  border-radius: var(--r-sm);
  background: rgba(200, 172, 124, 0.14);
  display: grid; place-items: center;
  color: var(--ink-soft);
  transition: transform 0.14s, background 0.14s, color 0.14s;
}
.tp-chip:hover  { transform: translateY(-2px); background: rgba(200, 172, 124, 0.26); }
.tp-chip.active { background: linear-gradient(180deg, #b7e08a, #8ec964);
                  color: #33501f;
                  box-shadow: 0 4px 10px rgba(120, 170, 80, 0.4); }

/* Barre de prereglages : des pilules, pas des onglets. */
.tp-presets { display: flex; gap: 6px; flex-wrap: wrap;
              padding-top: 12px; margin-top: 8px;
              border-top: 1.5px solid rgba(140, 116, 84, 0.16); }
.tp-preset  { padding: 5px 13px; border-radius: 999px;
              font-size: 0.84em; color: var(--ink-soft);
              background: rgba(200, 172, 124, 0.14); }
.tp-preset.active { background: var(--sand); color: var(--ink); font-weight: 700; }

/* Chevron sous l'outil actif : le seul pixel ajoute par defaut. */
.tool-btn.active::after {
  content: ''; position: absolute; bottom: -7px; left: 50%;
  width: 8px; height: 8px; margin-left: -4px;
  border-left: 1.5px solid var(--sand-dark);
  border-bottom: 1.5px solid var(--sand-dark);
  transform: rotate(-45deg);
  opacity: 0.55;
}

/* Pastille de valeur transitoire, sous le curseur. */
.brush-hud {
  position: fixed; pointer-events: none; z-index: 20;
  transform: translate(-50%, 34px);
  padding: 5px 14px; border-radius: 999px;
  background: rgba(253, 247, 234, 0.92);
  box-shadow: var(--shadow-soft);
  font-size: 0.86em; font-weight: 700; color: var(--ink);
  font-variant-numeric: tabular-nums;
  opacity: 0; transition: opacity 0.25s ease;
}
.brush-hud.on { opacity: 1; transition-duration: 0.08s; }
```

## 7.8 Ce qui disparaît de l'UI actuelle

Petite hygiène : la refonte permet de **supprimer** deux bricolages.

| Élément actuel | Sort |
|---|---|
| `hint2` (« Molette : écartement. Clic droit : effacer les rainures. ») | Supprimé pour les parties « molette » : le panneau le dit mieux. La partie « clic droit » migre vers la ligne `secondary`. |
| Le formatage spécial du râteau et de la déco dans `setActiveTool()` (`if (tool.id === 'rake') hint = ...`) | Supprimé. Le HUD n'a plus à connaître les outils un par un : il lit `params` et son schéma. |

C'est le signe qu'une abstraction est la bonne : elle **retire** du code
spécial-cas au lieu d'en ajouter.

---

# 8. PLAN D'IMPLÉMENTATION ORDONNÉ

## 8.1 Principe d'ordonnancement

Les étapes sont ordonnées par **rapport (valeur perçue) / (risque × effort)**, et
chaque étape laisse le jeu jouable. Deux règles :

- **Aucune étape ne casse le comportement existant** tant que les valeurs par
  défaut reproduisent les constantes actuelles.
- **L'étape 2 (espacement) passe avant tout ajout de paramètre**, parce que
  c'est un *bug* et que le reste n'a de sens qu'une fois le geste correct.

| # | Étape | Fichiers | Effort | Valeur | Risque |
|---|---|---|---|---|---|
| 1 | **Structure de paramètres** `ToolParams` | `ToolParams.js` (nv), `tools.js`, `ToolManager.js` | 1 j | fondation | faible |
| 2 | **Espacement par distance** `StrokeEngine` | `StrokeEngine.js` (nv), `ToolManager.js`, `tools.js` | 1,5 j | ★★★★★ | moyen |
| 3 | **Curseur enrichi** | `SandMaterial.js`, `ToolManager.js` | 1 j | ★★★★ | faible |
| 4 | **Courbes de fondu** `profile()` | `Brush.js`, `tools.js` | 0,5 j | ★★★★ | faible |
| 5 | **Panneau de réglages** | `HUD.js`, `hud.css`, `ToolParams.js` | 2 j | ★★★★★ | faible |
| 6 | **Molette + modificateurs, `[`/`]`, pastille** | `ToolManager.js`, `HUD.js` | 0,5 j | ★★★★ | faible |
| 7 | **Préréglages + persistance par outil** | `ToolParams.js`, `tools.js`, sauvegarde | 1 j | ★★★★ | faible |
| 8 | **Paramètres propres** (conicité, créneaux, écartement/profondeur découplés, plan verrouillé, étalement…) | `tools.js`, `Brush.js` | 2 j | ★★★★ | moyen |
| 9 | **Verrou d'axe + ligne droite** | `ToolManager.js` | 0,5 j | ★★★★ | faible |
| 10 | **Symétrie** (miroir + radiale + affordance) | `ToolManager.js`, `SandMaterial.js`, `HUD.js` | 1,5 j | ★★★★★ | moyen |
| 11 | **Cadran 2D (`B`) + menu radial (`E`, `Maj+E`)** | `ToolManager.js`, `HUD.js` | 1,5 j | ★★★ | faible |
| 12 | **Motifs le long du chemin** (`B.box`, créneaux, escalier, semis) | `Brush.js`, `tools.js` | 2 j | ★★★★★ | moyen |
| 13 | **Undo : découpage + compression delta** | `UndoStack.js`, `ToolManager.js` | 1,5 j | ★★★ | moyen |
| 14 | **Stylet : pression + `getCoalescedEvents`** | `ToolManager.js` | 0,5 j | ★★ | faible |

Total ≈ 18 jours-homme. Les étapes 1 à 6 (≈ 6,5 j) forment un lot cohérent qui
répond déjà entièrement à la demande du joueur (« régler l'intensité », « tout
améliorer ergonomiquement »).

---

## 8.2 ÉTAPE 1 — Structure de paramètres

Nouveau fichier `src/tools/ToolParams.js`. Aucun changement de comportement :
les valeurs par défaut reproduisent les constantes actuelles.

```js
/**
 * Parametres d'outil.
 *
 * Avant ce fichier, chaque valeur d'un outil (intensite, durete du bord,
 * profondeur de coupe, ecartement des dents...) etait un litteral au milieu
 * d'une fonction `apply`. Consequence : on ne pouvait ni les afficher, ni les
 * regler, ni les sauvegarder, ni les partager entre outils.
 *
 * Le modele : SIX parametres communs a tous les outils, plus des parametres
 * propres declares par chaque outil. Chacun porte son schema (plage, defaut,
 * courbe, unite, niveau d'exposition), ce qui permet au HUD de construire son
 * panneau tout seul, sans connaitre les outils un par un.
 *
 * Trois niveaux d'exposition :
 *   1 = toujours accessible (molette / modificateurs / 2 premieres lignes)
 *   2 = dans le panneau, replie par defaut
 *   3 = interne, jamais montre (mais reglable depuis la console pour le tuning)
 */

import { clamp } from '../core/Config.js';

/** Identifiants de courbe de fondu. L'ordre est stable : il est serialise. */
export const CURVE = {
  plate: 0, lisse: 1, lineaire: 2, pointue: 3, franche: 4, douce: 5,
};
export const CURVE_NAMES = ['Galette', 'Lisse', 'Lineaire', 'Pointue', 'Franche', 'Voile'];

/**
 * Schema d'un parametre.
 * @typedef {Object} ParamSpec
 * @property {string} label      nom affiche, en francais
 * @property {'num'|'enum'|'bool'} kind
 * @property {number} [min]
 * @property {number} [max]
 * @property {number} def
 * @property {'lin'|'log'} [scale]  courbe de reglage (log = pas multiplicatif)
 * @property {string} [unit]     'm' -> affiche en cm, 'L/s', 'deg', '%', ''
 * @property {string[]} [options] pour kind 'enum'
 * @property {1|2|3} level
 * @property {string} [hint]     raccourci affiche sous le curseur
 */

/** Schema des six parametres COMMUNS. */
export const COMMON_SPECS = {
  radius:   { label: 'Rayon',      kind: 'num', min: 0.02, max: 0.90, def: 0.16,
              scale: 'log', unit: 'm',  level: 1, hint: 'molette' },
  strength: { label: 'Force',      kind: 'num', min: 0.05, max: 1.00, def: 0.55,
              scale: 'lin', unit: '%',  level: 1, hint: 'Maj+molette' },
  hardness: { label: 'Bord',       kind: 'num', min: 0.00, max: 0.95, def: 0.35,
              scale: 'lin', unit: '%',  level: 2 },
  curve:    { label: 'Profil',     kind: 'enum', options: CURVE_NAMES, def: CURVE.lisse,
              level: 2 },
  step:     { label: 'Pas',        kind: 'num', min: 0.05, max: 1.00, def: 0.25,
              scale: 'log', unit: '',   level: 2 },
  secondary:{ label: 'Clic droit', kind: 'enum', options: [], def: 0, level: 2 },
};

/**
 * Etat de parametres d'un outil. Un objet PAR OUTIL, conserve pour toute la
 * session (et serialise dans la sauvegarde) : changer d'outil et revenir ne
 * doit plus reinitialiser le rayon, ce qui punissait l'exploration.
 */
export class ToolParams {
  /**
   * @param {object} tool entree du catalogue TOOLS
   */
  constructor(tool) {
    this.toolId = tool.id;
    /** @type {Record<string, ParamSpec>} */
    this.specs = {};
    /** @type {Record<string, number>} */
    this.values = {};

    // 1. Les communs, avec les surcharges de l'outil.
    for (const [key, base] of Object.entries(COMMON_SPECS)) {
      const over = tool.paramOverrides?.[key];
      this.specs[key] = over ? { ...base, ...over } : base;
      this.values[key] = this.specs[key].def;
    }
    // Compatibilite : l'ancien bloc `radius: {min,max,def}` fait foi s'il existe.
    if (tool.radius) {
      this.specs.radius = { ...this.specs.radius, ...tool.radius };
      this.values.radius = tool.radius.def;
    }

    // 2. Les propres, declares par l'outil.
    for (const [key, spec] of Object.entries(tool.ownParams || {})) {
      this.specs[key] = spec;
      this.values[key] = spec.def;
    }

    // 3. Acces direct : p.radius, p.strength, p.pitch...
    //    On definit des accesseurs plutot que de copier, pour que le HUD et le
    //    code d'outil voient toujours la meme valeur.
    for (const key of Object.keys(this.specs)) {
      if (key in this) continue;
      Object.defineProperty(this, key, {
        get: () => this.values[key],
        set: (v) => this.set(key, v),
        enumerable: true,
      });
    }

    this.defaults = { ...this.values };
    /** Nom du prereglage courant, ou null si l'etat a ete modifie a la main. */
    this.presetName = tool.presets?.[0]?.name ?? null;
    /** Le bloc niveau 2 du panneau est-il deplie ? Memorise par outil. */
    this.expanded = false;
  }

  /** Ecrit une valeur en la bornant selon son schema. */
  set(key, v) {
    const s = this.specs[key];
    if (!s) return;
    if (s.kind === 'num') v = clamp(v, s.min, s.max);
    else if (s.kind === 'enum') v = clamp(Math.round(v), 0, Math.max(0, s.options.length - 1));
    else v = v ? 1 : 0;
    if (this.values[key] === v) return;
    this.values[key] = v;
    this.presetName = null;          // l'etat ne correspond plus a un prereglage
    this.onChange?.(key, v);
  }

  /**
   * Reglage relatif, dans la bonne echelle.
   * `steps` est un nombre de crans de molette (positif = augmenter).
   * En echelle log le pas est multiplicatif : passer de 5 a 6 cm et de 50 a
   * 60 cm coute le meme nombre de crans, ce qui est la bonne perception.
   */
  nudge(key, steps) {
    const s = this.specs[key];
    if (!s) return;
    if (s.kind !== 'num') { this.set(key, this.values[key] + Math.sign(steps)); return; }
    if (s.scale === 'log') this.set(key, this.values[key] * Math.pow(1.10, steps));
    else this.set(key, this.values[key] + (s.max - s.min) * 0.04 * steps);
  }

  reset(key) {
    if (key) this.set(key, this.defaults[key]);
    else for (const k of Object.keys(this.defaults)) this.set(k, this.defaults[k]);
  }

  /** Valeur formatee pour l'affichage. Jamais un flottant brut. */
  format(key) {
    const s = this.specs[key];
    const v = this.values[key];
    if (!s) return '';
    if (s.kind === 'enum') return s.options[v] ?? '';
    if (s.kind === 'bool') return v ? 'oui' : 'non';
    switch (s.unit) {
      case 'm':    return v < 0.1 ? `${(v * 100).toFixed(1)} cm` : `${Math.round(v * 100)} cm`;
      case '%':    return `${Math.round(v * 100)} %`;
      case 'L':    return `${(v * 1000).toFixed(0)} L`;
      case 'L/s':  return `${v.toFixed(v < 1 ? 2 : 1)} L/s`;
      case 'deg':  return `${Math.round(v)}°`;
      case 'x':    return `×${v.toFixed(2)}`;
      case 'n':    return `${Math.round(v)}`;
      default:     return v.toFixed(2);
    }
  }

  /** Fraction 0..1 de la course, pour dessiner le curseur. */
  fraction(key) {
    const s = this.specs[key];
    if (!s || s.kind !== 'num') return 0;
    if (s.scale === 'log') {
      const a = Math.log(Math.max(1e-6, s.min)), b = Math.log(s.max);
      return clamp((Math.log(Math.max(1e-6, this.values[key])) - a) / (b - a), 0, 1);
    }
    return clamp((this.values[key] - s.min) / (s.max - s.min), 0, 1);
  }
  setFraction(key, f) {
    const s = this.specs[key];
    if (!s || s.kind !== 'num') return;
    if (s.scale === 'log') {
      const a = Math.log(Math.max(1e-6, s.min)), b = Math.log(s.max);
      this.set(key, Math.exp(a + (b - a) * clamp(f, 0, 1)));
    } else {
      this.set(key, s.min + (s.max - s.min) * clamp(f, 0, 1));
    }
  }

  /** Cles a afficher dans le panneau, par niveau. */
  keysAtLevel(level) {
    return Object.keys(this.specs).filter((k) => this.specs[k].level === level);
  }

  /** Le parametre propre n°1 : celui que regle Alt+molette. */
  get altKey() {
    const own = Object.keys(this.specs).filter(
      (k) => !(k in COMMON_SPECS) && this.specs[k].level === 1);
    return own[0] ?? null;
  }

  applyPreset(preset) {
    for (const [k, v] of Object.entries(preset.values)) this.set(k, v);
    this.presetName = preset.name;
  }

  serialize() { return { ...this.values }; }
  deserialize(o) { for (const [k, v] of Object.entries(o || {})) this.set(k, v); }
}

/** Fabrique un ToolParams par outil, une fois pour toute la session. */
export function buildParams(tools) {
  const map = {};
  for (const t of tools) map[t.id] = new ToolParams(t);
  return map;
}
```

### Branchement dans `ToolManager`

```js
// ToolManager.js — constructeur
import { buildParams } from './ToolParams.js';
// ...
this.paramsById = buildParams(this.tools);
this.current = TOOL_BY_ID.shovel;

// Un accesseur, pour que tout le code dise `this.params.radius`.
get params() { return this.paramsById[this.current.id]; }

// select() ne reinitialise PLUS rien : chaque outil garde son etat.
select(id) {
  const t = TOOL_BY_ID[id];
  if (!t) return;
  if (t === this.current) { this.game.hud?.toggleToolPanel(); return; }  // §3.3
  this.endStroke();
  this.current = t;
  this.game.onToolChanged?.(t);
}

// Compatibilite ascendante le temps de la migration : `this.radius` devient
// un alias lisible/ecrivable de params.radius, pour que HUD.js et les tests
// existants continuent de fonctionner sans modification.
get radius() { return this.params.radius; }
set radius(v) { this.params.set('radius', v); }
```

### Exemple de déclaration d'outil (râteau)

```js
// tools.js — extrait, apres migration
{
  id: 'rake',
  name: 'Rateau',
  icon: 'rake',
  key: 'Digit8',
  hint: 'Grave des rainures : appareil de briques, tuiles, stries.',
  cursor: '#a8d68a',
  stroke: 'space',
  radius: { min: 0.05, max: 0.40, def: 0.14 },
  paramOverrides: {
    hardness:  { def: 0.70 },
    curve:     { def: CURVE.franche },
    step:      { def: 0.18 },
    secondary: { options: ['Lisser', 'Effacer les rainures'], def: 0 },
  },
  ownParams: {
    pitch:       { label: 'Ecartement', kind: 'num', min: 0.015, max: 0.25, def: 0.05,
                   scale: 'log', unit: 'm', level: 1, hint: 'Alt+molette' },
    grooveDepth: { label: 'Profondeur', kind: 'num', min: 0.003, max: 0.05, def: 0.012,
                   scale: 'log', unit: 'm', level: 2 },
    angle:       { label: 'Orientation', kind: 'num', min: -90, max: 90, def: 0,
                   scale: 'lin', unit: 'deg', level: 2 },
    pattern:     { label: 'Motif', kind: 'enum',
                   options: ['Stries', 'Briques', 'Tuiles', 'Bois'], def: 0, level: 2 },
  },
  presets: [
    { name: 'Stries',     values: { pitch: 0.05,  grooveDepth: 0.012, pattern: 0 } },
    { name: 'Briques',    values: { pitch: 0.06,  grooveDepth: 0.010, pattern: 1, hardness: 0.7 } },
    { name: 'Tuiles',     values: { pitch: 0.045, grooveDepth: 0.018, pattern: 2 } },
    { name: 'Bois',       values: { pitch: 0.02,  grooveDepth: 0.006, pattern: 3 } },
    { name: 'Fourchette', values: { pitch: 0.015, grooveDepth: 0.008, radius: 0.06 } },
  ],
  apply(s) {
    const P = s.p, p = s.hit.point, n = s.hit.normal;
    if (s.button === 2) {
      B.smooth(s.ctx, p.x, p.y, p.z, P.radius,
               clamp(2.5 * s.dose, 0, 0.85), P.hardness, P.curve);
      return;
    }
    B.rake(s.ctx, p.x, p.y, p.z, n.x, n.y, n.z, P.radius,
           P.pitch, P.grooveDepth * s.dose, P.angle * Math.PI / 180, P.pattern);
    s.game.audio?.play('rake');
  },
}
```

**Critère de recette de l'étape 1 :** le jeu se comporte exactement comme avant,
et `game.tools.params.values` affiche dans la console un objet complet pour
chaque outil.

---

## 8.3 ÉTAPE 2 — Espacement par distance

Le fichier `StrokeEngine.js` est donné intégralement en §6.1.4. Voici les
raccords dans `ToolManager.js`.

```js
// ToolManager.js — remplacements

import { StrokeEngine } from './StrokeEngine.js';
import { clamp, smoothstep } from '../core/Config.js';

// --- constructeur ---------------------------------------------------------
this.engine = new StrokeEngine(this);
this.pressure = 1;
this._groupStart = 0;

const UNDO_SPLIT_DABS = 48;
const UNDO_SPLIT_SECONDS = 2.5;

// --- entree ---------------------------------------------------------------
onDown(e) {
  if (!this.enabled) return;
  if (e.button !== 0 && e.button !== 2) return;
  if (e.altKey && !this.stroke) { this.pickSettings(e); return; }   // §3.5
  this.updatePointer(e);
  const hit = this.raycast();
  if (!hit) return;
  e.preventDefault();

  this.pressure = (e.pointerType === 'pen' && e.pressure > 0)
    ? pressureCurve(e.pressure) : 1;

  this.undo.beginGroup(this.current.name);
  this._groupStart = performance.now();
  this.stroke = {
    button: e.button,
    lockY: null,
    axis: undefined,
    startPoint: { x: hit.point.x, y: hit.point.y, z: hit.point.z },
  };
  this.hit = hit;

  this.current.down?.(this.makeState(hit, 1));
  // Le premier dab est immediat : un clic bref doit faire quelque chose.
  this.engine.begin({ x: this.pointer.x, y: this.pointer.y }, hit);
}

onMove(e) {
  if (!this.enabled) return;
  // Les evenements fusionnes sont les points intermediaires du trajet : sans
  // eux, une souris a 1000 Hz rendue a 60 fps perd 15 points sur 16, et la
  // courbe du geste est reconstruite en zigzag.
  const evs = e.getCoalescedEvents ? e.getCoalescedEvents() : [e];
  for (const ev of evs) this.pushPointerSample(ev);
  this.updatePointer(e);
  if (e.pointerType === 'pen' && e.pressure > 0) this.pressure = pressureCurve(e.pressure);
}

onUp(e) {
  if (!this.stroke) return;
  if (e.button !== this.stroke.button) return;
  const hit = this.hit || this.raycast();
  if (hit) this.current.up?.(this.makeState(hit, 1));
  this.engine.end();
  this.endStroke();
}

// --- boucle ---------------------------------------------------------------
update(dt) {
  if (!this.enabled) { this.fadeCursor(dt, 0); return; }

  const hit = this.raycast();
  this.hit = hit;

  if (this.stroke) {
    // On rejoue les positions intermediaires accumulees depuis la derniere
    // frame, puis la position courante. C'est ce qui donne un trait fidele.
    const q = this.pointerQueue;
    const sub = q.length ? dt / q.length : dt;
    for (const s of q) {
      const h = this.raycastAt(s.x, s.y);
      if (h) this.engine.update(sub, s, h);
    }
    q.length = 0;
    if (hit) this.engine.update(0, { x: this.pointer.x, y: this.pointer.y }, hit);

    // Decoupage temporel du groupe d'undo (§6.5.1).
    if (performance.now() - this._groupStart > UNDO_SPLIT_SECONDS * 1000) {
      this.splitUndoGroup();
    }
  }

  this.fadeCursor(dt, hit ? 1 : 0);
  this.updateCursorUniforms(hit);
}

// --- visee a une position arbitraire (necessaire a l'interpolation) --------
/**
 * Raycast a une position NDC quelconque, sans toucher a l'etat du pointeur.
 * C'est ce qui permet au StrokeEngine de poser des dabs le long du trajet :
 * on interpole la position ECRAN et on relance un raycast, au lieu
 * d'interpoler le point 3D (qui traverserait le relief).
 */
raycastAt(nx, ny) {
  this._ndc.set(nx, ny);
  this.raycaster.setFromCamera(this._ndc, this.game.camera);
  const o = this.raycaster.ray.origin, d = this.raycaster.ray.direction;

  if (this.stroke && this.ctrl) {
    if (this.stroke.lockY === null) this.stroke.lockY = this.stroke.startPoint.y;
    const y = this.stroke.lockY;
    if (Math.abs(d.y) > 1e-4) {
      const t = (y - o.y) / d.y;
      if (t > 0) {
        return { point: { x: o.x + d.x * t, y, z: o.z + d.z * t },
                 normal: { x: 0, y: 1, z: 0 }, distance: t, locked: true };
      }
    }
  }
  const hit = this.game.field.raycast({ x: o.x, y: o.y, z: o.z },
                                      { x: d.x, y: d.y, z: d.z }, 60);
  return this.applyAxisLock(hit);          // §6.3.1
}

raycast() {
  if (!this.hasPointer) return null;
  return this.raycastAt(this.pointer.x, this.pointer.y);
}

// --- pose d'un dab --------------------------------------------------------
// (corps donne en §6.1.5 : calcul de la dose, etat, symetrie, decoupage undo)

pushPointerSample(e) {
  const r = this.canvas.getBoundingClientRect();
  this.pointerQueue.push({
    x: ((e.clientX - r.left) / r.width) * 2 - 1,
    y: -((e.clientY - r.top) / r.height) * 2 + 1,
  });
  if (this.pointerQueue.length > 64) this.pointerQueue.shift();
}

splitUndoGroup() {
  const label = this.current.name;
  this.undo.endGroup();
  this.undo.beginGroup(label);
  this._groupStart = performance.now();
}

function pressureCurve(x) { return 0.15 + 0.85 * Math.pow(x, 1.4); }
```

### Migration des outils

Chaque `apply` remplace `s.dt * RATE` par `s.dose`, en gardant le produit des
constantes. Table de conversion complète :

| Outil | Avant | Après |
|---|---|---|
| pelle creuse | `-220 * s.dt * 26` | `-5720 * s.dose` |
| pelle dépose | `200 * s.dt * 26` | `5200 * s.dose` |
| main tasse | `0.9 * s.dt * 9` | `8.1 * s.dose` |
| main lisse | `clamp(2.6 * s.dt * 9, 0, 0.9)` | `clamp(23.4 * s.dose, 0, 0.9)` |
| arrosoir | `0.55 * s.dt` | *(mode airbrush : garde `s.dt`, module par `P.flow`)* |
| seau d'eau | `0.004 * s.dt` | *(idem : `P.flow / 1000 * s.dt`)* |
| truelle | `clamp(4.5 * s.dt * 18, 0, 1)` | `clamp(81 * s.dose, 0, 1)` |
| mirette | `255 * clamp(s.dt * 24 * 6, 0, 1)` | `255 * clamp(6 * s.dose, 0, 1)` |
| râteau | `0.02 + spacing * 0.25` | `P.grooveDepth * s.dose` |
| gomme | `200 * clamp(s.dt * 14 * 5, 0, 1)` | `200 * clamp(5 * s.dose, 0, 1)` |

**Critère de recette :** balayer une façade d'un geste rapide produit une trace
continue, pas un chapelet ; garder le bouton appuyé sans bouger ne creuse plus
(sauf arrosoir et seau d'eau) ; la quantité de matière déplacée pour un geste
donné est identique à 30 fps et à 144 fps.

---

## 8.4 ÉTAPE 3 — Curseur enrichi

Le GLSL complet est en §4.4. Voici les uniformes et leur alimentation.

```js
// SandMaterial.js — ajouts au bloc uniforms
uCursorShape:  { value: new THREE.Vector4(0.35, 0.55, 0, 1) }, // hardness, force, risque, detail
uCursorNormal: { value: new THREE.Vector4(0, 1, 0, 0) },       // xyz normale, w mode
uCursorDir:    { value: new THREE.Vector4(1, 0, 0, 0.05) },    // xyz direction, w pas
uCursorMotion: { value: new THREE.Vector4(0, 0, 0, 0) },       // xyz direction geste, w vitesse
uPixelScale:   { value: 0.0011 },                              // metres par pixel a 1 m
```

```js
// ToolManager.js — remplace updateCursorUniforms()

/**
 * Alimente les uniformes du curseur.
 *
 * Le curseur ne montrait qu'un anneau de rayon. Il montre desormais :
 *   - le rayon (anneau exterieur, epaisseur constante a l'ecran) ;
 *   - la force (opacite du remplissage) ;
 *   - la durete du bord (anneau interieur pointille, au rayon du plateau) ;
 *   - la direction du geste (queue de comete) ;
 *   - la trace du plan de coupe ou l'orientation des rainures ;
 *   - le risque d'effondrement (hachures corail, jamais de rouge).
 *
 * Pendant un geste, tout sauf le rayon et l'alerte s'estompe : on sculpte, on
 * ne lit pas.
 */
updateCursorUniforms(hit) {
  const u = this.game.sandMaterial.userData.uniforms;
  const P = this.params;
  const T = this.current;

  if (hit) {
    u.uCursor.value.set(hit.point.x, hit.point.y, hit.point.z, P.radius);
    u.uCursorColor.value.set(T.cursor || '#7ec8ff');

    // --- forme -----------------------------------------------------------
    const detail = this.stroke ? 0.25 : 1.0;
    u.uCursorShape.value.set(P.hardness, P.strength, this.riskAt(hit.point), detail);

    // --- orientation du decal --------------------------------------------
    const n = hit.normal;
    let mode = 0;
    if (T.id === 'trowel') mode = 1;
    else if (T.id === 'rake') mode = 2;
    else if (T.id === 'shovel' && this.stroke?.button === 2) mode = 3;
    u.uCursorNormal.value.set(n.x, n.y, n.z, mode);

    // --- direction propre a l'outil ---------------------------------------
    if (mode === 1) {
      // Truelle : la normale du plan de coupe.
      const pl = this.trowelPlane(hit);
      u.uCursorDir.value.set(pl.x, pl.y, pl.z, 0);
    } else if (mode === 2) {
      // Rateau : l'axe de repetition des dents et leur ecartement.
      const a = (P.angle || 0) * Math.PI / 180;
      let tx = -n.z, tz = n.x;
      const tl = Math.hypot(tx, tz) || 1; tx /= tl; tz /= tl;
      const ca = Math.cos(a), sa = Math.sin(a);
      u.uCursorDir.value.set(tx * ca - tz * sa, 0, tx * sa + tz * ca, P.pitch || 0.05);
    } else if (mode === 3) {
      const d = this.engine.dir;
      u.uCursorDir.value.set(d.x, d.y, d.z, 0);
    }

    // --- mouvement --------------------------------------------------------
    const d = this.engine.dir;
    const v = Math.min(1, this.engine.speed / 2.5);
    u.uCursorMotion.value.set(d.x, d.y, d.z, this.stroke ? v : 0);
  }

  u.uCursorStrength.value = this.cursorFade;

  // Echelle pixel : recalculee au resize, jamais codee en dur.
  const cam = this.game.camera;
  u.uPixelScale.value =
    2 * Math.tan((cam.fov * Math.PI / 180) / 2) / this.canvas.clientHeight;
}

/**
 * Risque d'effondrement local, 0..1.
 *
 * En attendant le modele de stabilite complet (GAME-DESIGN §9.4), heuristique
 * honnete et bon marche : hauteur de la colonne rapportee a la hauteur tenable
 * pour l'humidite et la compaction locales. Les deux fonctions existent deja et
 * sont deja appelees par le HUD.
 */
riskAt(p) {
  const F = this.game.field;
  const w  = F.averageMoisture(p.x, p.y, p.z, 0.12);
  const pk = F.averagePacking(p.x, p.y, p.z, 0.12);
  const h  = F.columnHeightAt(p.x, p.z) - F.groundAt(p.x, p.z);
  const theta = thetaMax(w, pk);                       // degres
  const holdable = 0.25 + 1.4 * (theta - 30) / 60;     // metres, empirique
  return clamp(h / Math.max(0.05, holdable), 0, 1.4);
}
```

### Correctif à appliquer au GLSL de §4.4

Remplacer la constante magique par l'uniforme :

```glsl
// avant : float px = camDist * 0.0011;
float px = camDist * uPixelScale;
```

**Critère de recette :** l'anneau a la même épaisseur apparente à 2 cm et à
90 cm de rayon ; l'anneau intérieur disparaît quand le Bord tombe à 0 ; le
remplissage s'assombrit quand on monte la Force ; la truelle montre de quel côté
elle coupe ; le râteau montre où tomberont ses dents.

---

## 8.5 Jalons et démonstrations

| Jalon | Contenu | Ce qu'on montre |
|---|---|---|
| **J1** (étapes 1–3) | Paramètres + geste + curseur | « Le geste est juste, et on voit ce qu'on fait. » Un balayage rapide laisse une trace continue ; l'anneau montre la force. |
| **J2** (étapes 4–7) | Courbes, panneau, molette, préréglages | « On règle tout, sans jamais quitter le sable. » Démonstration : régler le râteau en briques en 4 secondes. |
| **J3** (étapes 8–10) | Paramètres propres, contraintes, symétrie | « On construit un château, pas un tas. » Démonstration : une façade symétrique en 90 secondes. |
| **J4** (étapes 11–14) | Cadran, radial, motifs, undo, stylet | « Le confort d'expert. » Démonstration : une rangée de créneaux en deux clics. |

## 8.6 Risques et parades

| Risque | Probabilité | Parade |
|---|---|---|
| **La conversion `dt` → `dose` change subtilement l'équilibre de tous les outils** | élevée | Faire l'étape 2 avec `strength` figé à la valeur qui reproduit l'ancien comportement, valider outil par outil, *puis* seulement rendre `strength` réglable. |
| **L'interpolation en NDC coûte trop cher (1 raycast par dab)** | moyenne | Plafond `MAX_DABS_PER_FRAME = 24` déjà présent. Si insuffisant : réutiliser le hit précédent quand deux dabs sont à moins d'un voxel l'un de l'autre. |
| **Le panneau alourdit l'écran malgré les 8 règles** | moyenne | Le tester **fermé** pendant une semaine complète de playtest avant de l'ouvrir. Si le joueur ne le manque pas, c'est que N1 suffit et qu'il faut couper dans N2. |
| **Six courbes de fondu, personne n'en utilise plus de deux** | élevée | Acceptable : les six existent surtout pour que les **préréglages livrés** aient du caractère. Le joueur les subit plus qu'il ne les choisit, et c'est très bien. |
| **La symétrie multiplie le coût CPU par 8** | moyenne | Plafond dur (radial × miroirs ≤ 8) + augmentation automatique du `step` effectif. Mesurer avant de livrer. |
| **`Pointer Lock` refusé par le navigateur (cadran 2D)** | faible | Repli documenté : accumuler `movementX/Y` et geler le rendu de l'anneau. Le cadran reste utilisable, le curseur dérive visuellement — acceptable. |

---

# ANNEXE — CHECKLIST DE RECETTE

Trente vérifications, à passer avant de considérer le chantier fini.

**Geste**
1. Un clic bref fait quelque chose.
2. Bouton maintenu sans bouger : rien ne se passe (sauf arrosoir, seau d'eau).
3. Balayage rapide : trace continue, pas de chapelet.
4. Même quantité de matière déplacée à 30 fps et à 144 fps.
5. Alt-tab pendant un geste ne creuse pas un cratère au retour.
6. Le trait suit la courbe de la souris, pas une polyligne à angles.

**Paramètres**
7. Changer d'outil et revenir conserve le rayon **et** tous les réglages.
8. Le rayon change du même « nombre de crans » de 5→6 cm et de 50→60 cm.
9. Force à 5 % : l'outil effleure visiblement.
10. Force à 100 % : l'outil ne dépasse jamais son plafond défensif.
11. Bord à 0 : fondu total, aucun plateau. Bord à 95 % : arête franche.
12. Aucun paramètre n'a d'effet sur un autre (orthogonalité).

**Réglage**
13. Molette = rayon. Maj+molette = force. Alt+molette = param propre.
14. Ctrl+molette zoome toujours, jamais autre chose.
15. La pastille de valeur apparaît puis s'efface.
16. `B` maintenu règle rayon et force ; le curseur ne dérive pas.
17. Le panneau s'ouvre au clic sur l'outil actif et à `C`.
18. Le panneau disparaît pendant un geste et revient après.
19. `Alt+1..6` rappelle un préréglage ; `Ctrl+Alt+1..6` en mémorise un.

**Curseur**
20. Épaisseur d'anneau constante à l'écran, tous rayons et toutes distances.
21. L'anneau épouse un mur vertical (pas d'ellipse écrasée).
22. La truelle montre son plan et le côté qui disparaît.
23. Le râteau montre ses dents à leur écartement réel.
24. Les hachures de risque n'apparaissent qu'au-delà de 60 % et ne sont pas rouges.

**Contraintes et symétrie**
25. `Ctrl` verrouille l'altitude (non-régression).
26. `Maj` verrouille l'axe, sans saut près de la diagonale.
27. `Maj`+clic trace une ligne droite, en un seul undo.
28. La symétrie active est impossible à ne pas voir (ligne au sol + fantômes).
29. Sculpter sur l'axe de symétrie ne double pas l'effet.

**Annulation**
30. `Ctrl+Z` pendant un geste interrompt proprement, puis annule.
