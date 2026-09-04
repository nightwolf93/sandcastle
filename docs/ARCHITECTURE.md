# Architecture

Ce document explique **pourquoi** le code est fait comme ça. Les quatre
documents de recherche voisins (`BIBLE-CHATEAUX-DE-SABLE.md`,
`RECHERCHE-PHYSIQUE-SABLE.md`, `RECHERCHE-RENDU-3D.md`, `GAME-DESIGN.md`)
donnent le fond ; celui-ci donne les décisions.

---

## 1. La décision structurante : un champ de densité continu

Tout le jeu repose sur un `VoxelField` de 256 × 96 × 256 voxels de 4 cm, soit
10,24 × 3,84 × 10,24 m. Quatre champs de 8 bits par voxel :

| Champ | Sens |
|---|---|
| `density` | 0 à 255. La surface est l'isovaleur 128. |
| `moisture` | Saturation des pores, 0 à 1. |
| `packing` | Compaction, 0 = versé en vrac, 1 = pound-up. |
| `material` | Sable, air. |

**Densité continue et pas booléenne.** C'est ce qui permet à un voxel d'être à
moitié plein, donc à la surface de passer entre deux voxels, donc au sable de
paraître lisse à 4 cm de résolution. C'est aussi ce qui rend les transferts de
matière exacts : une avalanche déplace des entiers, la masse est conservée au
bit près (le test le vérifie).

**Dense et pas creux.** 25 Mo de tableaux typés, alloués une fois. À cette
taille, un octree ou une table de hachage coûteraient plus en indirections
qu'ils ne feraient gagner en mémoire. La rareté est gérée autrement : des
compteurs par chunk (`chunkSolid`, `chunkFull`) permettent de savoir en O(1)
qu'un chunk est entièrement vide ou entièrement plein, et de ne jamais le
mailler.

**Ce qui n'est pas dans le champ voxel.** Les rochers, coquillages, oyats et
drapeaux sont des `InstancedMesh` séparés. Une première version les mettait
dans les voxels : le résultat était laid (des blobs escaliers) et polluait la
physique. Le champ voxel ne contient que du sable, ce qui garde la simulation
homogène.

---

## 2. Maillage : Surface Nets, et pourquoi la bordure fait 6 voxels

Le maillage est du **Naive Surface Nets** (dual) plutôt que du Marching Cubes :
un sommet par cellule au lieu de jusqu'à cinq triangles, donc un maillage deux
à trois fois plus léger — ce qui compte quand on remaille en continu — et des
sommets libres dans leur cellule, ce qui donne des surfaces lisses.

Le maillage tourne dans un **pool de workers**. Le thread principal extrait un
bloc, l'envoie en transfert, récupère les buffers de géométrie et les recycle.
Une comparaison de version détecte les chunks modifiés pendant le calcul et les
remet en file.

Trois pièges ont été trouvés et corrigés par les tests :

1. **L'ordre des axes.** Le bloc extrait doit être rangé `x` le plus rapide,
   puis `y`, puis `z`, alors que le champ global est rangé `x`, puis `z`, puis
   `y`. La première version se contentait de copier : le maillage sortait en
   éclats. Le test du plan incliné vérifie maintenant que la normale d'un plan
   `h = 1.6 + 0.3x + 0.1z` vaut bien `(-0.3, 1, -0.1)` normalisé.

2. **La propriété des arêtes.** Chaque arête du monde doit être émise par
   exactement un chunk, sinon on a des trous ou des faces doubles. La règle est
   « le chunk qui contient le coin bas de l'arête ». Exception : au bord négatif
   du domaine, le coin −1 n'appartient à aucun chunk — il faut l'attribuer au
   premier, sinon la paroi extérieure du bloc diorama est trouée. Et un chunk
   **plein** collé au bord doit quand même être maillé : c'est lui qui porte
   cette paroi.

3. **La largeur de la bordure.** L'occlusion ambiante est calculée au maillage
   (voir §4), et ses rayons vont chercher de la matière jusqu'à 4,4 voxels
   autour du sommet. Avec une bordure de 2 voxels, ces rayons étaient tronqués
   différemment de chaque côté d'une frontière de chunk : on voyait de fines
   lignes claires tous les 1,28 m. La bordure est donc de **6 voxels**.

Le test de maillage vérifie l'étanchéité en soudant les sommets par position et
en comptant les arêtes orientées : une surface correcte a exactement une arête
`(a,b)` et une arête `(b,a)` pour chaque paire. Le fond du bloc est
volontairement ouvert (invisible, et le fermer coûterait 130 k triangles).

---

**Les workers lisent le champ en mémoire partagée.** Sur une page isolée
(COOP/COEP, posés par Vite), les quatre champs voxel vivent dans des
`SharedArrayBuffer` et chaque worker de maillage les reçoit une fois. Un
remaillage n'envoie plus qu'un indice et une version : le worker extrait
lui-même le bloc `(CHUNK + 12)^3` (`meshing/Extract.js`, fonction pure
partagée avec `VoxelField.extractChunk`). Avant, le fil principal copiait
340 Ko par chunk dans des tampons transférables, jusqu'à 2 Mo par image en
remaillage intensif. Un bloc lu pendant qu'on écrit peut mélanger deux états
du chunk : c'est le cas que couvre déjà la version du chunk, qui fait jeter le
maillage et remettre le chunk en file. Sans isolation, l'ancien chemin par
copie reste le repli. La sauvegarde copie le champ avant de le passer à un
`Blob`, qui refuse une vue partagée.

**Les tampons GPU des chunks sont remplis, pas recréés.** Un chunk remaillé
dix fois par seconde pendant qu'on verse du sable laissait derrière lui
quarante tampons orphelins par seconde, libérés seulement au passage du
ramasse-miettes : mémoire GPU et pauses de collecte grimpaient au fil de la
partie. `TerrainRenderer` réutilise désormais un tampon tant qu'il est assez
grand (et pas plus de deux fois trop grand) ; la plage de dessin porte le
nombre d'indices réellement utilisés.

**Des styles de plage, un état de module.** Le profil (`beachProfile`), le
rivage (`shoreDistance`, avec l'anse d'une crique) et l'inversion
(`shorelineFor`) lisent le style courant `BEACH`, appliqué par
`applyBeachStyle` avant toute génération ou tout chargement : l'eau et la
houle interrogent ces fonctions sans connaître la plage, et leurs cartes de
rivage se reconstruisent ensuite (`Water.rebuildShore`). Dix styles règlent la
position du rivage (plus de sable ou plus de mer), la profondeur du large, les
courbures de l'avant-plage et de la face, la berme, les dunes, les rides, un
banc ou un récif au large (bosse gaussienne plafonnée, en roche pour le récif)
et une falaise de sable dur. Une graine se tape en clair (un mot est haché) ;
style et graine sont sauvegardés avec la partie et le profil est réappliqué
au chargement, sinon la bande de mer d'un lagon serait calculée sur la plage
classique. `tools/test-beach-styles.mjs` vérifie chaque style. Un gabarit n'est qu'un jeu
de paramètres : le dialogue les expose tous (`CUSTOM_FIELDS`, bornés à la
carte) et sauvegarde le jeu appliqué, pas le nom.

**La taille de la carte est une constante de la page.** Voxels, chunks, grille
d'eau, textures et défines des shaders en dérivent à l'import ; la rendre
dynamique aurait touché quarante modules. `Config.js` la lit donc au chargement
(paramètre d'URL `?map=LxP`, réglage `sc.map`, ou le **nom du worker** de
maillage `map:LxP`, seul canal synchrone vers un worker), et changer de taille
recharge la page avec la plage commandée en attente (`sc.pendingBeach`),
générée avant toute reprise de sauvegarde. Une sauvegarde d'une autre taille
demande le même rechargement puis se recharge d'elle-même.

## 3. Physique granulaire : deux mécanismes, pas un

Une seule règle ne suffit pas, parce que deux phénomènes très différents se
ressentent différemment.

### La règle de pente (immédiate)

Pour chaque voxel de surface, on mesure la dénivellation locale vers ses quatre
voisins latéraux. Si elle dépasse `tan(θ_max(w, p))`, du sable coule. C'est un
**slope model** et pas un height model à la Bak-Tang-Wiesenfeld : c'est ce qui
donne un vrai cône d'éboulis et un angle de repos correct.

Détail subtil : le plafond de `tan(θ_max)` doit être **strictement supérieur**
à la dénivellation maximale mesurable (`KMAX` voxels). Sinon une paroi
verticale dépasse toujours le seuil et le sable parfait s'érode tout seul par
les arêtes. `TAN_CAP = 12`, `KMAX = 10`.

### La rupture structurelle (différée)

Un voxel sans rien dessous ne tient que par la cohésion de ses voisins. Un
petit parcours en largeur cherche un appui **ancré au sol** dans le rayon
tenable `maxOverhang(w, p, épaisseur, charge)`.

Le mot « ancré » a coûté un test. Une première version se contentait de
« il y a de la matière dessous » : la rangée basse d'une dalle en porte-à-faux
soutenait la rangée haute, et le surplomb se déclarait stable à l'infini. Il
faut suivre la colonne jusqu'au sol.

Quand l'appui manque, on **n'effondre pas tout de suite** : la contrainte
s'accumule pendant deux à quatre secondes. Une rupture doit toujours être
annoncée.

On ne supprime jamais de matière pour simuler un effondrement : on la déplace.
L'éboulis se forme tout seul par la règle de pente.

### Le coût

L'ensemble actif est filtré à l'entrée : `processVoxel` n'agit que sur des
voxels ayant du vide au-dessus ou en dessous. Un voxel enterré est immobile par
construction, inutile de l'inscrire. Ce seul filtre a divisé l'ensemble actif
par huit après un coup de pelle (154 k → 19 k).

Les voxels sont rangés dans **quatre files, une par couleur du damier**
`(x&1, z&1)`. Deux voxels de la même couleur ne sont jamais latéralement
adjacents, donc aucun conflit de transfert. Trier à l'ajout plutôt qu'au
traitement évite de reparcourir quatre fois l'ensemble : facteur 4 sur le débit
d'avalanche, ce qui fait la différence entre du sable qui coule et du sable qui
rampe.

---

**L'humidité ne réveille la mécanique qu'à bon escient.** Chaque unité
d'humidité changée réveillait le voxel : sur une plage où rien ne bougeait,
30 000 voxels restaient actifs en permanence et la simulation granulaire
consommait tout son budget à chaque image. Le réveil demande maintenant une
variation d'au moins 12/255, ou le franchissement d'une borne de catégorie
(sec, humide, liquide), là où l'angle de repos change vraiment.

## 4. Humidité : un balayage roulant, pas un solveur global

L'humidité bouge lentement. Plutôt qu'un solveur global coûteux, chaque tick
(10 Hz) traite **une colonne sur seize**, plus les colonnes que le joueur vient
de toucher. Une colonne est donc revisitée toutes les 1,6 s — largement assez
pour de la percolation.

Chaque colonne est résolue **de haut en bas** en une passe, ce qui transporte
l'eau vers le bas comme une vraie infiltration : percolation de l'excès
au-delà de la capacité au champ, diffusion, équilibre capillaire imposé par la
nappe, évaporation sur les seuls voxels exposés.

Un seuil de notification (`NOTIFY_EPS = 4/255`) évite de marquer la moitié du
terrain comme sale à chaque tick. Sans lui, le mailleur ne faisait plus que
remailler des variations d'humidité invisibles — c'était le premier gros
gaspillage mesuré (1 400 chunks remaillés en 40 s au repos).

Les constantes physiques sont accélérées par des facteurs explicites
(`TIME_SCALE`), parce que le sable met une demi-journée à sécher au soleil. Les
**rapports** entre phénomènes sont conservés, le temps est comprimé.

---

## 4 bis. Anti-crénelage et ombres

Deux anti-crénelages, parce qu'ils ne traitent pas les mêmes arêtes. Le
composer rend dans une cible **MSAA** (4 échantillons en qualité élevée, 2 en
moyenne) : sans elle, l'option `antialias` du renderer ne sert à rien dès qu'on
rend dans une texture, et les créneaux, les brins d'oyat et le bord du bloc
étaient crénelés. Le **SMAA** rattrape ensuite les arêtes nées dans les shaders
(ligne d'eau, ombres, reflets), et il passe *avant* le grain de l'étalonnage,
sinon le grain masque les contours qu'il doit trouver. Les ombres sont en PCF
doux, sur 4096 texels pour 19 m de cadrage (le domaine de 12,8 m de côté
demande 9 m de demi-largeur en diagonale). Le ciel porte des nuages
procéduraux, cirrus blancs par beau temps, masse grise par temps couvert, qui
alimentent aussi l'éclairage indirect.

**Un NaN devient un pixel, pas un écran.** La scène est rendue dans sa propre
cible multi-échantillons, résolue une fois, puis recopiée dans le composer par
une passe qui remplace tout pixel NaN par du noir et borne les valeurs
aberrantes. Sans elle, un seul pixel invalide (un `normalize()` sur un vecteur
nul sous un angle de caméra précis) était étalé par le bloom sur l'écran
entier : des flashs noirs en bougeant la caméra. Le paramètre d'URL `?msaa=0`
(ou 2) force le nombre d'échantillons pour isoler un problème de pilote.

## 5. Eau : une nappe en eaux peu profondes, et des gouttes

L'eau est une **hauteur d'eau** `h(x, z)` posée sur le sable, résolue par un
solveur en eaux peu profondes (modèle « pipe » de Mei et al., corrigé en vrai
schéma de Saint-Venant : flux signés aux faces, célérité `g·h_face`, frottement
de fond semi-implicite, mise à l'échelle des sorties). Il est **conservatif par
construction**, hydrostatique au repos, et il produit tout seul la levée sur le
haut-fond, le déferlement et le jet de rive parce que la célérité vaut
`sqrt(g h)`. Ce choix a remplacé un nuage de billes 3D (septembre 2026) : une
bille de 12 cm ne sait pas représenter une lame de 5 mm, et 95 % de ce qu'une
plage montre est une lame mince.

**Trois grilles, un seul état.**

- Le solveur travaille sur des **cellules d'eau de 8 cm** (deux voxels). La
  condition CFL rend son coût proportionnel à `(cellules mouillées) / dx` ;
  ce facteur huit est ce qui rend une mer de 12,8 m de front abordable en
  JavaScript. Le fond d'une cellule est le **maximum** de ses quatre colonnes :
  un mur d'un voxel reste étanche, et une tranchée doit couvrir des cellules
  entières pour porter de l'eau, ce que tous les outils font.
- Il ne travaille que dans une **bande** le long du rivage, du mur du large
  (`Water.bandWall`) jusqu'au haut de plage. Au-delà du mur, la mer est
  **imposée** : niveau de marée plus houle, échantillonnée sur une grille de
  32 cm, sans aucun calcul de flux. La bande suit la marée et l'état de mer
  (sa profondeur limite vaut 1,6 fois la profondeur de déferlement) : une mer
  d'huile coûte presque rien, une tempête coûte ce qu'elle montre. La mer
  imposée est ce que l'eau du hors-champ *atteint* depuis le bord du domaine :
  un mur construit au large arrête ce parcours, et l'enceinte derrière lui est
  résolue par le solveur, pas noyée par décret. La zone de relaxation de la
  houle obéit à la même règle.
- Le rendu et l'érosion lisent des **champs fins** (`h`, `vx`, `vz`, `foam`,
  `sed`, une valeur par colonne de 4 cm) reconstruits à chaque pas par
  `syncFine()` : la surface libre est interpolée entre les cellules mouillées
  puis coupée par le terrain fin. Une lame de 2 mm se rend sans trou, un mur
  d'un voxel sort de l'eau au milieu d'une cellule mouillée, et le renderer
  n'a rien à savoir de la grille grossière.

**L'eau chassée par le sable est plafonnée.** Un seau de sable versé à 26 Hz
dans le jet de rive, au moment où il est coupé de la mer, chassait à chaque
passage un demi-litre vers trois ou quatre cellules mouillées : des colonnes
d'eau d'un mètre au cœur du tas, qui redescendaient en rideau sur ses flancs.
Une cellule receveuse ne monte jamais de plus de 3 cm par événement ni
au-dessus de la mer plus 5 cm ; le reste est réputé parti au large
(`stats.spilled`). Une tour dans une douve fermée fait toujours monter la
douve, de quelques millimètres. Et une flaque qui domine la nappe (lagune
remplie par les vagues derrière un tas) se vidange dans le sable par sa
charge, au lieu de rester indéfiniment sur un sable saturé.

**La boucle de sous-pas et les champs fins tournent sur le GPU.**
`WaterGPU.js` transcrit flux, mise à l'échelle, intégration, déferlement,
échange du rouleau et génération en cinq tirages par sous-pas (textures
RGBA32F de 160 × 160, deux cibles à sorties multiples), en ping-pong. En
WebGL2 **brut**, pas en three.js : un rendu three coûte 50 à 100 µs de
gestion d'état et il y en a jusqu'à vingt-cinq par pas, un tirage brut en
coûte dix ; on rend la main par `renderer.resetState()`. Une fois par pas,
une passe d'empaquetage écrit `(h, vx, vz, b)` que le CPU relit de façon
**asynchrone** (tampon de lecture et fence, jamais de `readPixels` bloquant,
qui attendrait la fin du rendu de l'image précédente). La copie CPU a donc un
pas de retard, invisible à 30 Hz, et les modifications CPU (suintement, seau,
sable versé, mer imposée) repartent vers le GPU sous forme de deltas.

La mesure a montré que la boucle de sous-pas ne pesait que 1 à 1,4 ms par
pas : le gros du coût était la reconstruction des champs fins (`syncFine`,
1,2 ms) puis leur dilatation, leur lissage temporel et leur téléversement par
le rendu (1,6 Mo par mise à jour). Ces trois étapes sont donc aussi des
passes GPU sur la grille de 320 × 320, et le rendu lit directement leurs
textures (`THREE.ExternalTexture`). Elles tournent **à chaque image** et
interpolent entre les deux derniers états du solveur : à 30 Hz de solveur pour
60 à 90 images par seconde, la nappe avançait par à-coups visibles ; avec
l'interpolation (un pas de latence, 33 ms, invisible) la surface glisse et le
front mouillé/sec avance continûment. Le CPU ne reconstruit plus ses champs
fins que pour l'érosion, un pas sur trois, et `depthAt` interpole la nappe
grossière. Le fond des cellules d'eau n'est plus recalculé en entier à chaque
pas : seules les colonnes recalculées depuis le pas précédent le sont, avec
une passe complète toutes les deux secondes par sûreté. Le CPU garde tout ce
qui touche au sable et aux gouttes : suintement, infiltration, érosion, sape,
embruns, advection de l'écume.

Le solveur CPU reste la référence, prouvée par les tests Node. Le GPU **se
valide contre lui** au démarrage : pendant trois pas, les deux tournent depuis
le même état et l'écart sur `h` doit rester sous 15 mm au maximum et 2,5 mm en
moyenne quadratique, sans valeur non finie ; sinon il se retire et le CPU
continue, ce que le panneau F3 affiche. `?gpuwater=0` le coupe,
`?gpuwater=trace` journalise la validation. Écarts assumés : lecture de
l'état de début de passe là où le CPU balaie en place, échange du rouleau
symétrique par construction, flottants 32 bits.

**Ce qui quitte la nappe devient une goutte.** L'eau versée par un outil, la
lame qui bascule d'un rebord : `Droplets.js` fait voler des gouttes de 60 mL
sans pression entre elles, qui rendent leur volume exact à la nappe en se
posant. La conservation de l'eau ne dépend jamais d'elles. Une goutte qui
tombe dans la mer imposée est absorbée : le large est un réservoir infini.

**Une cavité fermée reste sèche.** Un tunnel, une tour creuse sont invisibles
pour une nappe. C'est la limite assumée de ce modèle, et elle est bien moins
chère que le solveur 3D qu'il faudrait pour la lever.

**Les bornes de lignes, et le trou qu'elles ont ouvert.** La plage sèche et la
mer imposée représentent l'essentiel du domaine : chaque ligne mémorise les
bornes de ses cellules mouillées, et toutes les passes se restreignent à
l'union des bornes de la ligne et de ses deux voisines (sans cette union, une
ligne sèche ne recevait jamais le flux de sa voisine et un écoulement ne
progressait plus en `z`). Deuxième piège, trouvé au test de conservation : une
cellule qui ne portait qu'un **film sous le seuil** sortait des bornes, ses
faces n'étaient plus recalculées, et sa voisine continuait d'appliquer un flux
périmé que personne ne recevait. Quelques millilitres par seconde disparaissaient
par ce trou. Toute cellule qui porte de l'eau, si peu que ce soit, reste dans
les bornes ; et le film s'infiltre dans le sable au lieu de rester éternel.

**Le rouleau est un échange, pas un laplacien.** L'étalement du rouleau de
déferlement (trois à cinq cellules d'épaisseur au lieu d'un choc d'une cellule)
transfère de l'eau entre voisines avec la même règle de crête que le flux :
ce qu'une cellule reçoit, l'autre le perd, et rien ne franchit un mur. La
version laplacienne créait de l'eau au bord du rouleau et faisait grimper
l'écume sur les parois d'une douve.

**L'écume est une bande.** Elle naît du déferlement (critère de Kennedy sur la
vitesse de montée de la surface libre, réservé aux lames de plus de 6 mm et
complété par un critère de Froude) ; sa croissance est quadratique dans
l'indicateur de déferlement, donc un rouleau franc blanchit et un frisson ne
fait qu'une frange ; sa durée de vie (1,3 s) est plus courte que la période de
la houle, donc la traîne d'une vague s'efface avant la suivante. Elle voyage
avec l'eau (advection semi-lagrangienne), se dépose sur le sable en laisse
d'écume, dessinée par le shader du sable avec la même dentelle que l'eau, et se
résorbe.

**Pourquoi la crête court plus vite que le creux.** Le modèle « pipe »
d'origine n'a pas de terme d'advection de la quantité de mouvement : ses
vagues ne se raidissent que par la différence de célérité entre crête et
creux, et n'atteignaient jamais le ressaut avant la plage (99 % des fronts
sous 25 % de pente en houle). Le flux à chaque face reçoit maintenant
`-dt · d(u·q)/dx` en schéma amont : dissipatif, donc stable sous la CFL déjà
respectée, et suffisant pour que la crête rattrape le creux et dresse un
front vertical dans la zone de surf. Avec lui, la célérité n'est plus
plafonnée à 55 cm de profondeur mais à 85 (`HFACE_CAP`), et l'étalement du
rouleau est réduit (`ROLLER_NU`) pour ne pas re-lisser le front qu'on vient
d'obtenir.

**Les bords du domaine rayonnent.** Une houle oblique pousse un courant de
dérive le long de la plage ; au bord du diorama, un exutoire qui ne laisse
sortir que ce que la pression pousse voit ce courant s'empiler contre lui en
une colonne d'eau de 17 cm sur une seule cellule (un triangle d'eau pendu au
bord, dans la jupe). Les faces de bord laissent donc sortir l'eau **à sa
propre vitesse** (`u·h·L`), et rien n'y entre. Côté réglages, la hauteur va
jusqu'à 80 cm et la limite d'injection est celle du déferlement (`H = 0,78 h`
au mur) plutôt qu'une marge de sécurité : une vague plus haute que l'eau ne le
permet casse dès le mur, en ressaut. C'est violent, et c'est un bac à sable.

**La vague qui s'abat.** Là où le rouleau est franc (`bRoll > 0,3`, lame de
plus de 5 cm, courant de plus de 35 cm/s), deux choses se produisent. Au
rendu, la face avant de la crête se penche dans le sens du courant et se
soulève (canal B de la flow map, `WaterRenderer`) : un champ hauteur ne peut
pas surplomber, mais la lèvre avance d'une cellule, la face devient verticale,
blanchit, et s'éclaire par transparence de ce vert d'eau qui signe le rouleau.
Et la crête projette des **embruns** : une brume de fines particules blanches
(`SandParticles`, espèce 5) lancées vers l'avant et le haut, freinées par
l'air, qui meurent au contact. Elles ne pèsent rien : la conservation de l'eau
n'est pas concernée. De 6 à 46 gouttelettes par pas de solveur selon la
puissance.

**Pourquoi une tempête doit avoir de l'eau sous elle.** Une vague ne peut être
injectée qu'à 60 % de la profondeur locale (au-delà elle a déjà déferlé). La
bande simulée descend donc jusqu'à 80 cm de profondeur au repos, c'est-à-dire
le fond du large à marée moyenne : une tempête de 45 cm y tient. À marée basse
le platier entier fait 40 cm et la tempête se calme d'elle-même, comme sur une
vraie plage. L'écrêtage par la marée est fixe (`TIDE_GATE`, 25 % à pleine mer)
et ne dépend plus du réglage d'érosion.

**Hauteur, puissance, météo.** La houle a deux réglages continus : la hauteur
significative `Hs` (0 à 50 cm) et la **puissance** (0 à 1), qui est sa période
(1,8 à 4,8 s, soit 5,7 à 15 s à l'échelle réelle du bac). À hauteur égale, une vague longue porte bien plus d'énergie,
déferle en plongeant, court plus loin sur le sable et projette plus d'embruns.
Cinq modes météo (`core/Weather.js` : calme, brise, houle, grosse houle,
tempête) règlent d'un geste hauteur, puissance, agitation, vent, couverture du
ciel et pluie ; la mer répond tout de suite, le ciel et le vent en quelques
secondes. La pluie est faite des gouttes de l'arrosoir : une sur huit mouille
le sable. Tout est sauvegardé avec la partie, réglages personnalisés compris.

**Les invariants sont des tests, pas des intentions.** `tools/test-water-invariants.mjs`
prouve, sans navigateur : conservation à 1e-6 m³ près sur 60 s en bassin
fermé ; mer d'huile plate au millimètre et immobile ; positivité et absence de
NaN pour tout pas jusqu'à 100 ms ; enceinte fermée sèche sous huit secondes de
houle ; seau versé en haut d'une rigole rendu à la mer sans déborder ; lame de
2,5 mm rendue sans trou ; célérité mesurée à 10 % de `sqrt(g h)` ; écume en
bande (moins de 12 % des cellules mouillées) et jamais permanente ; pleine mer
sur le milieu de plage mais pas sur la berme ; et un seau versé sur le plateau
retrouvé intégralement entre nappe, gouttes et sable.

**Budget.** `tools/bench-water.mjs` mesure `Water.step(1/60)` sur la plage de
départ, humidité et infiltration comprises : le budget est 1,5 ms en moyenne
(mesuré : ~0,9 ms). Le solveur avance à 30 Hz avec ses sous-pas CFL à
l'intérieur, la texture du champ est téléversée à 30 Hz au plus, et la
morphologie (érosion, sapement) tourne à 10 Hz.

**La nappe est une condition aux limites, pas un objet.** Toute cellule dont le
terrain passe sous le niveau de la nappe se remplit progressivement, d'où le
trou qui se remplit tout seul quand on creuse près de l'eau, exactement comme
sur une vraie plage. Mais jamais plus vite que l'eau ne traverse le sable :
le suintement est plafonné à la vitesse de Darcy (1,4 mm/s, `SEEPAGE_MAX`).
Sans ce plafond, une enceinte de murs posée au bord de l'eau se remplissait
en trois secondes, ce qui se lisait comme de l'eau traversant les murs ; à
1,4 mm/s on voit l'eau monter, et un mur protège vraiment pendant un temps.
Le chemin inverse existe : une colonne saturée dont la nappe est redescendue
sous le fond percole vers elle à la même vitesse, et la flaque piégée dans
l'enceinte se vide quand la marée se retire. Le large, lui, a son niveau
imposé : c'est le générateur de houle, et le solveur propage tout seul le
ressac sur l'estran.

**Les débits sont calibrés sur des objets réels.** Le seau d'eau débite 4 L/s,
soit un seau de plage vidé en deux secondes. L'infiltration à 1,4 mm/s fait
durer une flaque de 5 cm une trentaine de secondes, assez pour avoir le temps
de creuser une tranchée et de la voir se remplir.

---

## 6. Rendu

**WebGL2 + `MeshStandardMaterial` patché par `onBeforeCompile`.** WebGPU + TSL
aurait ouvert le compute, mais impose de tout réécrire en nodes et interdit
`EffectComposer`. Le gain ne justifiait pas le risque : la simulation tient déjà
son budget sur le CPU.

### Le sable

Le mouillé est traité **en luminance** :

```
ws     = 1 - exp(-w * 7.5)          // sature très vite
lumWet = lum^(1 + 0.95·ws) · (1 - 0.28·ws)
albedo = albedo · lumWet / lum
```

Appliquer la puissance canal par canal — comme le suggère la littérature — sur
un sable déjà très jaune le rend fluo-orange, parce que le canal bleu, plus
faible, chute beaucoup plus vite. Passer par la luminance donne la même
réponse photométrique sans dérive de teinte.

Le **scintillement** demande deux précautions : une densité très faible (un
grain sur trois cents) et un fondu exponentiel en distance. Sans le fondu,
quand un pixel couvre des dizaines de cellules de grain, l'échantillonnage
aliase et le scintillement devient un voile blanc uniforme.

L'**occlusion ambiante est calculée au maillage**, pas à l'écran. C'est gratuit
au rendu, stable quand la caméra bouge, et ça marche dans les recoins que le
SSAO rate.

Les **parois extérieures du bloc** sont détectées dans le shader par leur
position et leur normale, et reçoivent des strates et un liseré de nappe : la
tranche géologique du diorama.

### Le post-traitement

L'ordre est la seule chose qui compte vraiment :

```
scène (HDR linéaire) → bloom → tone mapping + sRGB → étalonnage → SMAA
```

Le bloom doit voir de la lumière linéaire non bornée. L'étalonnage doit venir
**après** le tone mapping : lever les noirs ou ajouter du grain sur des valeurs
linéaires produit un voile laiteux, parce qu'un `+0.01` linéaire dans les
ombres devient `+0.1` après la courbe. La première version avait l'étalonnage
avant, et toute l'image était lavée.

Le **tilt-shift** signe la miniature, mais il doit se deviner. Sa bande nette
suit ce que le joueur regarde (le point visé par l'outil), et le flou intègre
un garde-fou anti-bavure : un échantillon beaucoup plus clair que le centre —
typiquement le fond derrière une silhouette — est fortement atténué. Sans lui,
chaque contour du diorama se borde d'un halo.

### L'eau

Une seule nappe pour la mer, les douves et les flaques. La géométrie est un
plan statique ; tout le mouvement vient d'une texture flottante mise à jour
chaque frame (niveau, profondeur, écume, sédiment).

**L'écume naît de la turbulence, pas de la faible profondeur.** Une première
version la déclenchait sur l'épaisseur de la lame : toutes les douves se
bordaient de blanc, ce qui est faux — une douve immobile a une surface lisse.
Le canal d'écume porte la mémoire de la vitesse du courant ; la faible
profondeur ne fait que l'amplifier.

**L'eau diffuse, elle n'absorbe pas seulement.** Avec la seule absorption de
Beer-Lambert, le fond se voyait à 95 % sous 10 cm d'eau : l'ombre d'un tas de
sable sur le fond, vue à travers la surface, se lisait comme un trou noir dans
la mer. Un coefficient de diffusion volumique (bulles, sable en suspension)
ajoute la propre lumière turquoise de l'eau par-dessus le fond, ombre ou pas,
et le shader du sable efface jusqu'à 60 % de l'ombre portée dès que la colonne
d'eau dépasse quelques centimètres, comme le font caustiques et lumière
diffusée sous l'eau.

---

## 7. Outils et annulation

Chaque outil est un **volume balayé** le long du geste, pas une pose de bloc.
Toutes les écritures passent par `Brush.js`, ce qui garantit que trois choses
arrivent systématiquement : instantané pour l'annulation, réveil de la
mécanique granulaire, mise en file des colonnes pour le solveur d'humidité.

L'**annulation photographie des chunks entiers**. Journaliser chaque voxel
serait plus compact mais ne rattraperait pas ce que la physique a fait *après*
le geste — or c'est justement ce que le joueur veut annuler quand son mur s'est
écroulé. 128 Ko par chunk, quelques chunks par geste.

L'ergonomie 3D à la souris repose sur trois choses : la brosse se projette
toujours sur la surface (on ne sculpte jamais dans le vide), `Ctrl` verrouille
l'altitude pendant un geste (creuser une tranchée à fond plat, araser un mur),
et `Ctrl` + molette règle le rayon (la molette nue appartient à la caméra).

**La main lisse par diffusion des hauteurs, pas par flou du champ.** Un flou
gaussien 3D de la densité conserve le volume et arrondit les coins, mais laisse
une falaise verticale exactement où elle est : une face plane a une courbure
nulle, et le joueur lit « ça ne lisse pas ». La main lit donc la hauteur exacte
de chaque colonne du disque (la position de l'iso 128 que le mailleur
interpole), fait diffuser ce champ de hauteurs en forme de flux (volume
conservé au grain près, une marche de 40 cm devient une pente en S de 50 cm),
et ne réécrit que le haut de chaque colonne, ce qui préserve une fenêtre
percée sous une crête. Un léger flou 3D suit, pour effacer les facettes que
la grille dessine sur les parois : des densités intermédiaires donnent au
mailleur des sommets réellement continus. L'intensité (jauge du panneau, ou
`Ctrl` + `Maj` + molette) règle le nombre de pas de diffusion par passage ; le
rayon règle l'étendue. Tout cela est prouvé par `tools/test-hand.mjs`.

**L'atelier du sculpteur** (`src/tools/Sculpt.js`) ajoute les outils précis :
ouverture cintrée (profil plein cintre, ogive, surbaissé ou droit, percée
selon la normale de la paroi visée, avec appui pour une fenêtre), escalier
(marches à hauteur régulière entre deux points, moitié taillées, moitié
remblayées en sable damé), gouge à profil en U ou en V le long du trait,
paille qui ne retire que les voxels sans appui (une miette est un partiel avec
au plus un voisin plein, un grain en l'air un plein sans voisin ; la peau des
pentes, adossée au plein, ne bouge pas), formes de révolution (tour à fruit,
toit conique, dôme) dans le générateur. Toutes écrivent une densité cible
issue d'un champ de distance, comme les blocs : un demi-voxel d'antialiasing,
jamais de marches. Les outils « à coup unique » agissent au clic ou au
relâchement et dessinent leur contour avant (`render/ToolGhost.js`). Le
**miroir** (`M`) rejoue chaque geste symétriquement par rapport à un plan posé
au curseur : le gestionnaire construit l'état symétrique (point, normale,
trait) et rappelle l'outil avec `mirrored` ; la truelle retourne sa normale de
coupe. `tools/test-sculpt.mjs` prouve chaque opération.

**Le seau de sable crée de la matière.** La pelle déplace, la gomme efface,
lui génère : c'est le seul moyen de reboucher un trou sans aller chercher le
sable ailleurs. Il dépose une calotte sur la surface visée (une sphère
centrée sur le point visé suivait la surface qui montait et empilait trois
mètres en une seconde), en vrac et plutôt sec, et laisse la physique
granulaire faire le cône.

---

## 8. Sauvegarde

`IndexedDB` + `CompressionStream('gzip')`, sans base64. Une plage travaillée
tient en ~480 Ko.

Un premier jet en RLE pur donnait 4,9 Mo : excellent sur la densité (des
volumes entiers de 0 ou de 255), catastrophique sur l'humidité, qui varie
continûment d'un voxel à l'autre et où chaque run de longueur 1 coûte trois
octets au lieu d'un. Deflate encaisse les deux régimes. Le RLE reste comme
repli si `CompressionStream` manque.

Le champ `material` n'est pas stocké : il se déduit de la densité.

**Un historique, pas un emplacement.** Chaque sauvegarde, automatique ou
manuelle, est une entrée `auto:<date>` ou `manual:<date>` : on peut revenir à
un état plus ancien que la dernière sauvegarde, ce qu'un unique emplacement
écrasé toutes les 90 s interdisait. Les automatiques sont plafonnées à 10, les
manuelles à 20 (les plus vieilles partent). La reprise au démarrage charge
l'entrée la plus récente, tous types confondus ; une nouvelle plage entre
aussitôt dans l'historique pour que la reprise la retrouve. La sauvegarde
automatique se coupe, et ce choix survit au rechargement (`localStorage`),
comme le réglage « l'eau n'emporte pas le sable », qui prime sur la jauge
d'érosion de la partie sans en changer la valeur. `tools/test-save.mjs`
couvre le tri et l'élagage.

---

## 9. Ce qui reste ouvert

- **Résolution.** 4 cm est un compromis. Les créneaux d'une tour de 30 cm font
  sept voxels : ça passe, mais une résolution de 2 cm transformerait la
  finesse de sculpture — au prix de huit fois la mémoire et du passage
  obligatoire de la simulation sur le GPU.
- **Le granulaire sur le GPU.** L'eau y est (voir §5) ; le granulaire est
  plus délicat à cause de l'ensemble actif.
- **Relecture GPU sans copie.** La relecture asynchrone de l'eau passe par un
  tampon de 400 Ko par pas ; une texture partagée avec le rendu de la surface
  éviterait même ce trajet.
- **Plusieurs plages.** La qualité du sable (angularité, fines) est déjà un
  paramètre du modèle : en faire une propriété de gisement donnerait à chaque
  lieu ses limites propres, et donc une vraie progression.
