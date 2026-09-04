# Sandcastle — Document technique de référence
## Simulation de sable granulaire humide temps réel (JS / WebGL2 / Three.js)

> **Statut** : document de recherche + spécification d'implémentation.
> **Cible** : champ de voxels creux chunké, voxel 4–5 cm, domaine ~12 × 3 × 12 m,
> + champ d'humidité, + nappe d'eau de surface 2D, 60 fps sur GPU intégré moyen.
> **Convention** : SI partout (m, s, kg, Pa). `w` (ou `S`) = **degré de saturation**
> $S = V_{eau}/V_{pores} \in [0,1]$ — c'est la variable stockée par voxel, pas la
> teneur en eau massique.

---

## 0. Résumé exécutif (à lire en 2 minutes)

| Question | Réponse retenue |
|---|---|
| Algorithme d'effondrement | **Automate cellulaire d'avalanche voxel à densité continue (Uint8), critère Mohr–Coulomb tabulé, balayage 4-couleurs, active set de voxels sales** — pas de MPM, pas de PBD |
| Surplombs / arches | **Champ de support** (BFS 3D à coût latéral depuis le sol) + critère de porte-à-faux $L_{max} = k\,c(w)/(\rho_b g)$ |
| Angle sec | $\theta_{max}(0) = 34°$ (repos dynamique 30–32°) |
| Angle humide optimal | $\theta_{max}(0.10\text{–}0.25) \approx 88\text{–}89°$ |
| Angle saturé | $\theta_{max}(1.0) \approx 15°$ |
| Cohésion max | $c_{max} \approx \phi_s k \gamma_{lv} \tan\varphi / d \approx 0.7\text{–}2.5$ kPa (sable 0.25 mm) |
| Diffusion humidité | $D \approx 10^{-5}$ m²/s (physique), $5\times10^{-4}$ m²/s (jeu), grille 2× plus grossière, 10 Hz |
| Percolation | $K_s = 8\times10^{-5}$ m/s physique → $\times 50$ en jeu |
| Eau de surface | Modèle **pipe / shallow water** (Mei et al. 2007) + érosion $C = K_c \sin\alpha\,|v|\,l_{max}(d)$ |
| Maillage | **Naive Surface Nets** sur densité Uint8 avec apron +1, normales par gradient central |
| Architecture | Sim voxel + maillage en **Web Workers** (SharedArrayBuffer), shallow-water en **fragment shader ping-pong WebGL2**, rendu thread principal |
| Budget | ~40–90 k tests de voxels / frame, 4–6 chunks remaillés / frame, ~20 MB de champs |

---

# PARTIE 1 — MODÈLE DE COHÉSION DÉPENDANT DE L'HUMIDITÉ

## 1.1 Constantes physiques de référence

| Symbole | Grandeur | Valeur | Source / remarque |
|---|---|---|---|
| $d$ | Diamètre médian des grains ($d_{50}$) | $2.5\times10^{-4}$ m (sable de plage moyen) | plage utile 0.1–1 mm |
| $R$ | Rayon de grain | $d/2 = 1.25\times10^{-4}$ m | |
| $\gamma_{lv}$ | Tension superficielle eau/air à 20 °C | $0.0728$ N/m | 0.0756 à 0 °C, 0.0712 à 30 °C |
| $\theta_c$ | Angle de contact eau/silice | $0°$–$30°$ → $\cos\theta_c \approx 0.9\text{–}1.0$ | prendre 1.0 |
| $\rho_w$ | Masse volumique de l'eau | 1000 kg/m³ | |
| $\rho_s$ | Masse volumique des grains (quartz) | 2650 kg/m³ | |
| $n$ | Porosité | 0.36–0.44 (prendre **0.38**) | lâche 0.44, dense 0.34 |
| $e$ | Indice des vides $e = n/(1-n)$ | 0.61 | lâche 0.8, dense 0.5 |
| $\phi_s$ | Fraction solide $= 1-n$ | 0.62 | |
| $\rho_b$ | Masse volumique apparente sèche | $\rho_s(1-n) = 1640$ kg/m³ | lâche 1450, tassé 1750 |
| $\rho_b^{hum}$ | Apparente humide $= \rho_b + n S \rho_w$ | 1640 + 380·S kg/m³ | à S=1 : 2020 kg/m³ |
| $\gamma_b$ | Poids volumique $= \rho_b g$ | $1.61\times10^{4}$ N/m³ | |
| $k_c$ | Nombre de coordination | 6 (lâche) – 8 (dense) | |
| $\varphi$ | Angle de frottement interne | 32–36° (prendre **34°**) | pic dense 40–42°, critique 31–33° |
| $\mu$ | $\tan\varphi$ | 0.675 | |
| $a_{cap}$ | Longueur capillaire $\sqrt{\gamma/\rho_w g}$ | 2.7 mm | au-dessus, la gravité domine |
| $\nu$ | Viscosité cinématique de l'eau | $10^{-6}$ m²/s | |
| $K_s$ | Conductivité hydraulique saturée | $8.25\times10^{-5}$ m/s (sable), $4.05\times10^{-5}$ (sable limoneux) | Carsel & Parrish 1988 |

**Nombre de Bond granulaire** — rapport cohésion capillaire / poids d'un grain :

$$\mathrm{Bo}_g = \frac{F_{cap}}{m g} = \frac{\pi d \gamma_{lv}}{\frac{\pi}{6}d^3\rho_s g} = \frac{6\gamma_{lv}}{d^2\rho_s g}$$

Pour $d = 0.25$ mm : $\mathrm{Bo}_g = 6\times0.0728 / (6.25\times10^{-8}\times2650\times9.81) = 0.437/1.625\times10^{-3} \approx \mathbf{269}$.
→ La cohésion capillaire est **~270× le poids d'un grain**. C'est pourquoi 1 % d'eau
transforme un tas de sable en matériau qui tient à la verticale.
$\mathrm{Bo}_g \propto d^{-2}$ : sable fin (0.1 mm) → 1680 ; gravier (2 mm) → 4 (plus de château).

## 1.2 Les quatre régimes de saturation

Saturation $S = V_{liq}/V_{pores}$. Attention : la littérature utilise souvent la
*fraction volumique de liquide* $W = V_{liq}/V_{total} = n\,S$. Avec $n = 0.38$ :
$W = 1\% \Leftrightarrow S = 0.026$.

| Régime | $S$ | $W$ | Morphologie du liquide | Cohésion | Comportement en jeu |
|---|---|---|---|---|---|
| **Sec / adsorbé** | $0 – 0.005$ | 0 – 0.2 % | films nanométriques, ponts sur aspérités | ~0 → montée brutale | tas à 34°, coule |
| **Pendulaire** | $0.005 – 0.30$ | 0.2 – 11 % | ponts capillaires **isolés** aux contacts | **plateau max** | murs verticaux, sculptable ✅ |
| **Funiculaire** | $0.30 – 0.80$ | 11 – 30 % | ponts fusionnés + poches d'air | décroissante | pâteux, s'affaisse |
| **Capillaire** | $0.80 – 1.0$ | 30 – 38 % | pores pleins, air en bulles isolées | faible (succion résiduelle) | boue, coule lentement |
| **Suspension / liquéfié** | $S \ge 1$, eau libre | > 38 % | pression interstitielle **positive** | **0** | quicksand, s'étale à 10–15° |

Points clés issus de la littérature :
- **Le plateau de cohésion démarre très tôt** : dès $W \approx 0.5$–1 % ($S\approx0.015$–0.03),
  la cohésion atteint déjà 70–80 % de son maximum, puis *sature* alors même que le
  nombre et la taille des ponts continuent d'augmenter (Richefeu, El Youssoufi & Radjaï 2006).
  Raison : la force par pont ne dépend quasiment pas du volume du pont ($F \to \pi d\gamma$
  dans la limite des petits volumes), et le nombre de contacts est borné par $k_c$.
- **L'optimum "château de sable" est autour de $W \approx 1$ %** ($S \approx 0.025$–0.03),
  Pakpour et al., *Scientific Reports* 2012, « How to construct the perfect sandcastle ».
- Les tas humides atteignent des **angles ≥ 90°** (surplombs) — c'est un effet de
  **taille finie** : c'est la *hauteur* du tas qui limite l'angle, pas une propriété locale.
  Voir §1.6.
- Quand l'eau devient **libre** ($S \to 1$ avec drainage empêché), la succion devient
  positive et la cohésion s'effondre → liquéfaction.

## 1.3 Pont capillaire entre deux grains

Force d'attraction entre deux sphères de rayon $R$ reliées par un ménisque
(approximation « toroïdale », valable pour de petits volumes de liquide) :

$$F_{cap} = \underbrace{2\pi r_2 \gamma_{lv}}_{\text{tension de ligne}} + \underbrace{\pi r_2^2 \,\Delta P}_{\text{dépression de Laplace}}, \qquad \Delta P = \gamma_{lv}\left(\frac{1}{r_1}+\frac{1}{r_2}\right)$$

avec $r_1$ le rayon de courbure méridien (négatif, concave) et $r_2$ le rayon du col.
Dans la **limite des petits volumes** et à distance nulle, ceci converge vers la
forme classique :

$$\boxed{F_{cap}^{max} = 2\pi R\, \gamma_{lv}\cos\theta_c = \pi d\, \gamma_{lv}\cos\theta_c}$$

**Valeur numérique** ($d = 0.25$ mm) : $F_{cap} = \pi \times 2.5\times10^{-4} \times 0.0728 = \mathbf{5.72\times10^{-5}\ N} = 57\ \mu N$.
À comparer au poids d'un grain : $2.13\times10^{-7}$ N. Rapport 269 ✅ (= $\mathrm{Bo}_g$).

**Dépendance à la distance** (utile si on veut moduler par la compaction) :

$$F_{cap}(\delta) = \frac{F_{cap}^{max}}{1 + 1.05\,\hat\delta + 2.5\,\hat\delta^2}, \qquad \hat\delta = \delta\sqrt{R/V_b}$$

où $V_b$ est le volume du pont et $\delta$ la distance entre surfaces.

**Distance de rupture** : $\delta_{rupt} \approx (1 + \theta_c/2)\,V_b^{1/3}$.
Pour $V_b = 10^{-4}\,d^3$ : $\delta_{rupt} \approx 0.046\,d \approx 12\ \mu$m.
→ La cohésion **disparaît quasi instantanément dès qu'un grain bouge de 5 % de son
diamètre** ; c'est ce qui rend les effondrements de sable humide « cassants » (rupture
fragile, blocs qui se détachent) plutôt que visqueux. **À reproduire visuellement.**

## 1.4 Succion matricielle et courbe de rétention (van Genuchten)

Pression capillaire / succion matricielle dans un pore de rayon effectif $r_p \approx 0.2\,d$ :

$$\psi = \frac{2\gamma_{lv}\cos\theta_c}{r_p} = \frac{2\gamma_{lv}}{0.2\,d}$$

Pour $d = 0.25$ mm : $\psi = 0.1456/5\times10^{-5} = \mathbf{2912\ Pa} \approx 30\ \text{cm}$ de colonne d'eau.
(cohérent avec la frange capillaire mesurée, §3.4).

**Modèle van Genuchten** (à utiliser si on veut une succion continue en $S$) :

$$S_e = \frac{\theta - \theta_r}{\theta_s-\theta_r} = \left[\frac{1}{1+(\alpha\,\psi_h)^{n_{vg}}}\right]^{m}, \quad m = 1-\frac{1}{n_{vg}}$$

$$\Rightarrow \quad \psi_h(S_e) = \frac{1}{\alpha}\left(S_e^{-1/m}-1\right)^{1/n_{vg}} \quad [\text{m de colonne d'eau}]$$

Paramètres (Carsel & Parrish 1988) :

| Sol | $\theta_r$ | $\theta_s$ | $\alpha$ [1/m] | $n_{vg}$ | $K_s$ [m/s] | $1/\alpha$ (entrée d'air) |
|---|---|---|---|---|---|---|
| **Sand** | 0.045 | 0.43 | 14.5 | 2.68 | $8.25\times10^{-5}$ | 6.9 cm |
| **Loamy sand** | 0.057 | 0.41 | 12.4 | 2.28 | $4.05\times10^{-5}$ | 8.1 cm |
| **Sandy loam** | 0.065 | 0.41 | 7.5 | 1.89 | $1.23\times10^{-5}$ | 13.3 cm |
| Sable de plage fin (recommandé jeu) | 0.03 | 0.38 | **5.0** | **3.0** | $6\times10^{-5}$ | 20 cm |

Conductivité hydraulique **non saturée** (Mualem–van Genuchten) :

$$K(S_e) = K_s\, S_e^{1/2}\left[1-\left(1-S_e^{1/m}\right)^{m}\right]^2$$

Valeurs tabulées ($K_s = 8\times10^{-5}$, $n_{vg}=2.68$, $m=0.627$) :

| $S_e$ | 0.1 | 0.2 | 0.4 | 0.6 | 0.8 | 0.9 | 1.0 |
|---|---|---|---|---|---|---|---|
| $K/K_s$ | $2\times10^{-6}$ | $1.1\times10^{-4}$ | $4.6\times10^{-3}$ | $3.5\times10^{-2}$ | 0.18 | 0.41 | 1.0 |
| $K$ [m/s] | $1.6\times10^{-10}$ | $8.8\times10^{-9}$ | $3.7\times10^{-7}$ | $2.8\times10^{-6}$ | $1.4\times10^{-5}$ | $3.3\times10^{-5}$ | $8\times10^{-5}$ |

→ **Conséquence gameplay majeure** : le sable humide (S ≈ 0.1–0.3) ne draine
pratiquement pas ($K < 10^{-8}$ m/s = 1 mm/jour). Une sculpture reste humide très
longtemps ; seule l'**évaporation de surface** la sèche. C'est physiquement correct
et c'est une bonne nouvelle pour le jeu.

## 1.5 De la force microscopique à la cohésion macroscopique

**Modèle de Rumpf (1958)** — résistance à la traction d'un agglomérat pendulaire de
sphères monodisperses :

$$\boxed{\sigma_t = \frac{\phi_s\, k_c}{\pi}\cdot\frac{F_{cap}}{d^2}}$$

En substituant $F_{cap} = \pi d\gamma_{lv}$ :

$$\boxed{\sigma_t = \frac{\phi_s\, k_c\, \gamma_{lv}}{d}} \qquad \text{(forme mémorisable, } \sigma_t \propto 1/d\text{)}$$

**Valeurs numériques** ($\phi_s = 0.62$, $k_c = 6$, $\gamma_{lv}=0.0728$) :

| $d$ [mm] | 0.1 | 0.25 | 0.5 | 1.0 | 2.0 |
|---|---|---|---|---|---|
| $\sigma_t$ [Pa] | 2710 | **1084** | 542 | 271 | 135 |
| $c = \sigma_t\tan\varphi$ [Pa] | 1830 | **732** | 366 | 183 | 91 |
| Surplomb max $c/\gamma_b$ [cm] | 11.4 | **4.5** | 2.3 | 1.1 | 0.6 |

**Cohésion de Coulomb** — la cohésion qui intervient dans $\tau = c + \sigma\tan\varphi$
se déduit de la résistance à la traction par (Richefeu et al. 2006) :

$$c = \sigma_t \tan\varphi \qquad \text{ou, forme équivalente « contrainte effective »} \qquad \tau = \tan\varphi\,(\sigma + \sigma_t)$$

**Approche Bishop / contrainte effective** (équivalente, plus « mécanique des sols ») :

$$\sigma' = (\sigma - u_a) + \chi(S)\,(u_a - u_w), \qquad \chi \approx S_e$$
$$\Rightarrow \quad c(S) = \chi(S)\,\psi(S)\,\tan\varphi \approx S_e\,\psi(S_e)\,\tan\varphi$$

Cette forme reproduit naturellement la **non-monotonie** : à $S\to0$, $\psi\to\infty$
mais $\chi\to0$ ; à $S\to1$, $\chi\to1$ mais $\psi\to0$. Le produit a un maximum.
Avec les paramètres « plage » ($\alpha=5$, $n_{vg}=3$) le maximum tombe vers $S_e \approx 0.15$
et vaut $c_{max} \approx 0.35 \times 2000 \times 0.675 \approx 470$ Pa — sous-estimé,
car la formule de Bishop ignore la contribution *déviatorique* des ponts. **Recommandation :
utiliser la forme empirique §1.6 calibrée sur $c_{max}$ de Rumpf, avec un facteur de
tassement.**

**Valeurs expérimentales de cohésion apparente** (sables non saturés, essais triaxiaux /
boîte de cisaillement) : 1–8 kPa pour des succions de 4–12 kPa ; sables fins bien gradués
jusqu'à 20–29 kPa. Pour un sable de plage lâche, **1–3 kPa est la fourchette réaliste**.

> **Constante retenue : $c_{max} = 2400$ Pa** pour du sable tassé à $d_{50}=0.25$ mm
> (valeur déjà dans `Config.js`, cohérente : Rumpf donne 732 Pa pour un empilement lâche
> $k_c=6$ ; le tassement porte $k_c$ à 8–10 et $\phi_s$ à 0.66, et la polydispersité
> multiplie par ~2, d'où le facteur ≈ 3).

## 1.6 Angle de stabilité maximal $\theta_{max}(w)$ — la courbe exploitable

### 1.6.1 Théorie (Halsey & Levine 1998, *PRL* 80, 3141)

En appliquant Mohr–Coulomb à la surface libre d'un tas de hauteur $H$ :

$$\tan\theta_m \simeq \mu + \frac{\sqrt{8\pi\,\mu\,\gamma_{lv}}}{d\,\rho_b\, g\, H}\,\sec\!\left(\arctan\mu\right)$$

Ce qui traduit trois choses essentielles :
1. $\theta_m \to \varphi$ quand $\gamma_{lv}\to0$ (sable sec) ;
2. $\theta_m$ **augmente quand $H$ diminue** → un petit tas humide tient plus raide qu'un gros ;
3. $\theta_m \propto 1/d$ → le sable fin tient mieux.

### 1.6.2 Forme fermée « pente infinie avec cohésion » (à utiliser dans la passe de relaxation)

Pour une couche mobile d'épaisseur verticale $z$ sur une pente $\theta$ :

$$\tau = \gamma_b z \sin\theta\cos\theta, \qquad \sigma_n = \gamma_b z\cos^2\theta$$

Rupture quand $\tau > c + \sigma_n\tan\varphi$. En posant $\zeta = \dfrac{c}{\gamma_b z}$ :

$$\sin(2\theta-\varphi) = 2\zeta\cos\varphi + \sin\varphi$$

$$\boxed{\ \theta_{max}(c,z) = \frac{\varphi + \arcsin\!\big[\mathrm{clamp}(2\zeta\cos\varphi + \sin\varphi,\,-1,\,1)\big]}{2}\ }$$

- $c=0 \Rightarrow \theta_{max} = \varphi$ ✅
- Saturation : $\theta_{max}^{sup} = (\varphi + 90°)/2 = 62°$ pour $\varphi=34°$.

**Ce plafond de 62° est la limite du modèle de pente infinie** — il ne peut pas
décrire un mur vertical. Pour ça il faut le critère de pente finie.

### 1.6.3 Critère de pente finie (Culmann) — pour les murs et falaises

Hauteur critique d'un talus de pente $\beta$ dans un sol $(c,\varphi)$ :

$$\boxed{H_c(\beta) = \frac{4c}{\gamma_b}\cdot\frac{\sin\beta\,\cos\varphi}{1-\cos(\beta-\varphi)}}$$

Cas vertical $\beta=90°$ : $H_c = \dfrac{4c}{\gamma_b}\tan\!\left(45°+\frac{\varphi}{2}\right)$.

**Valeurs** ($\gamma_b = 1.61\times10^4$ N/m³, $\varphi=34°$, $\tan(45+17°)=1.881$) :

| $c$ [Pa] | 200 | 500 | 1000 | 2400 | 5000 |
|---|---|---|---|---|---|
| $H_c(90°)$ [cm] | 9.3 | 23 | 47 | **112** | 234 |
| $H_c(70°)$ [cm] | 15 | 37 | 75 | 179 | 373 |
| $H_c(50°)$ [cm] | 32 | 79 | 158 | 380 | 791 |

→ Avec $c_{max}=2400$ Pa, un **mur vertical de sable humide tient jusqu'à ~1.1 m**.
C'est exactement l'ordre de grandeur observé sur les plages (les murs de château
s'effondrent au-delà de ~1 m). ✅ Validation croisée réussie.

### 1.6.4 Courbe empirique recommandée $\theta_{max}(w)$

Pour le gameplay on veut une fonction **locale** (sans connaître $H$), calée sur
l'expérience. Modèle en deux termes :

$$\boxed{\theta_{max}(w) = \theta_{res}(w) + \big[\theta_{peak}-\theta_{res}(w)\big]\cdot f_{coh}(w)}$$

$$f_{coh}(w) = \underbrace{\left(1-e^{-w/w_r}\right)}_{\text{montée capillaire}}\cdot\underbrace{\big[1-\mathrm{smoothstep}(w_d,\,w_l,\,w)\big]}_{\text{noyade}}$$

$$\theta_{res}(w) = \varphi\cdot\big[1-\kappa\,\mathrm{smoothstep}(w_q,\,1,\,w)\big]$$

| Paramètre | Valeur | Rôle |
|---|---|---|
| $\varphi$ | 34° | angle de repos sec |
| $\theta_{peak}$ | 89° | plafond (on ne dépasse pas 90 dans la relaxation locale) |
| $w_r$ | **0.030** | échelle de montée : 63 % de la cohésion à $w=0.03$ |
| $w_d$ | **0.25** | début de la noyade |
| $w_l$ | **0.90** | cohésion nulle |
| $w_q$ | **0.75** | début de la liquéfaction |
| $\kappa$ | **0.55** | perte de frottement à saturation → 15.3° |

**Table de valeurs (à copier telle quelle)** :

| $w$ | 0.00 | 0.01 | 0.02 | 0.03 | 0.05 | 0.08 | 0.10 | 0.15 | 0.20 | 0.25 |
|---|---|---|---|---|---|---|---|---|---|---|
| $\theta_{max}$ [°] | **34.0** | 49.6 | 60.8 | 68.8 | 78.6 | 85.2 | **87.0** | 88.6 | 88.9 | **89.0** |

| $w$ | 0.30 | 0.40 | 0.50 | 0.60 | 0.70 | 0.80 | 0.90 | 0.95 | 1.00 |
|---|---|---|---|---|---|---|---|---|---|
| $\theta_{max}$ [°] | 88.1 | 81.6 | **70.8** | 58.4 | 46.4 | 35.7 | 21.9 | 17.2 | **15.3** |

Et la cohésion associée :

$$\boxed{c(w) = c_{max}\cdot f_{coh}(w)\cdot \Gamma(\rho)} \qquad c_{max} = 2400\ \text{Pa}$$

| $w$ | 0.00 | 0.02 | 0.05 | 0.10 | 0.25 | 0.50 | 0.75 | 0.90 | 1.00 |
|---|---|---|---|---|---|---|---|---|---|
| $c$ [Pa] | 0 | 1170 | 1946 | 2314 | 2400 | 1608 | 336 | 0 | 0 |
| $\sigma_t = c/\tan\varphi$ [Pa] | 0 | 1733 | 2883 | 3428 | 3556 | 2382 | 498 | 0 | 0 |

> **Remarque de cohérence** : la courbe `REPOSE_CURVE` déjà présente dans `Config.js`
> (34/55/78/89/80/45/22/12) est très proche de ce modèle sur la montée mais **redescend
> trop tôt** : elle donne 45° dès $w=0.35$ alors que le plateau pendulaire s'étend
> jusqu'à $S\approx0.30$–0.40. Recommandation : déplacer les points de contrôle
> vers (0.30 → 88), (0.50 → 71), (0.70 → 46), (0.85 → 28), (1.0 → 15).

### 1.6.5 Effet de la compaction / densité relative

Densité relative $D_r = \dfrac{e_{max}-e}{e_{max}-e_{min}}$, avec $e_{max}\approx0.85$,
$e_{min}\approx0.50$ pour un sable de plage.

**Sur l'angle de frottement** (corrélation de Bolton, contraintes faibles) :

$$\varphi_{peak} = \varphi_{cv} + 3\,I_R, \qquad I_R = D_r\,(Q - \ln p') - 1$$

En pratique, pour des contraintes très faibles (< 5 kPa, cas d'un château de sable),
prendre simplement :

$$\boxed{\varphi(D_r) = \varphi_{cv} + 10°\cdot D_r} \qquad \varphi_{cv}=31°$$

| $D_r$ | 0 (très lâche) | 0.3 (lâche) | 0.6 (moyen) | 0.85 (dense) | 1.0 (tapé) |
|---|---|---|---|---|---|
| $\varphi$ [°] | 31 | 34 | 37 | 39.5 | 41 |
| $n$ | 0.46 | 0.42 | 0.38 | 0.35 | 0.33 |
| $\rho_b$ [kg/m³] | 1430 | 1540 | 1640 | 1720 | 1780 |

**Sur la cohésion** — deux effets multiplicatifs :
1. le nombre de coordination croît : $k_c \approx 4 + 6\,D_r$ (de 4 à 10) ;
2. la fraction solide croît : $\phi_s = 1-n$.

$$\boxed{\Gamma(D_r) = \frac{\phi_s(D_r)\,k_c(D_r)}{\phi_s(0.6)\,k_c(0.6)} = \frac{(1-n(D_r))(4+6D_r)}{0.62\times7.6}}$$

| $D_r$ | 0 | 0.3 | 0.6 | 0.85 | 1.0 |
|---|---|---|---|---|---|
| $\Gamma$ | 0.46 | 0.71 | **1.00** | 1.22 | 1.35 |

→ **Taper le sable double presque sa cohésion** : de $D_r=0.1$ à $D_r=0.9$, $\Gamma$
passe de 0.52 à 1.26 (×2.4). C'est une mécanique de gameplay excellente (« tasser
avec la pelle »). Stocker $D_r$ par voxel sur 4 bits suffit (16 niveaux).

**Effet combiné sur $H_c$** : sable lâche humide $c = 0.46\times2400 = 1100$ Pa →
mur vertical de 51 cm. Sable tassé humide $c = 1.35\times2400=3240$ Pa → 1.51 m. ✅

## 1.7 Mohr–Coulomb transformé en test local pas cher

### 1.7.1 Le test de pente (99 % des cas)

Pour deux colonnes voisines séparées de $L$ (= `VOXEL` en 4-voisinage, `VOXEL·√2` en diagonale),
avec des hauteurs de surface $z_a > z_b$ :

```
Δz    = z_a - z_b
tanθ  = Δz / L
stable ⟺ tanθ ≤ tanθ_max(w, z_slab)
```

L'épaisseur de la couche mobile $z_{slab}$ est ce qui manque. Approximation
**très bon marché et suffisante** :

$$z_{slab} = \min\big(\Delta z,\ z_{col},\ z_{cap}\big), \qquad z_{cap} = 8\,h$$

($h$ = taille du voxel ; on plafonne pour que $\zeta$ ne devienne pas ridicule).

### 1.7.2 LUT 2D — coût : un `Float32Array` de 256 entrées

Précalculer une fois :

```
TAN_THETA_MAX[iw*16 + iz]   // iw : 16 paliers de w, iz : 16 paliers de z_slab
```

- $iw = \lfloor w \times 15.999\rfloor$ (w stocké en Uint8 → `w8 >> 4`, gratuit)
- $iz = \min(15, \lfloor z_{slab}/h\rfloor)$ (déjà en voxels, gratuit)

Le test d'avalanche devient **un `Math.imul`, une lecture de tableau et une comparaison**.
Sur du JS moderne : **~8–15 ns par test de paire**. Avec 4 voisins → ~50 ns par voxel.

### 1.7.3 Version « contrainte » pour les cas verticaux

Quand $\tan\theta \to \infty$ (mur vertical, $\Delta z > 0$ et $z_b$ = vide), le test de
pente n'a plus de sens. On bascule sur le critère de Culmann discret :

$$\text{effondre si} \quad H_{libre} > H_c(\beta_{eff}) \quad\text{avec}\quad \beta_{eff} = \arctan\!\left(\frac{\Delta z}{\max(L, h)}\right)$$

Concrètement : on maintient un champ `freeHeight[x][z]` = hauteur de la façade libre
(nombre de voxels au-dessus du premier voisin latéral solide). Mise à jour incrémentale
en O(1) lors des modifications. Voir §2.4.

### 1.7.4 Traitement de l'eau libre (pression interstitielle)

Sous le niveau de la nappe ($y < y_{nappe}$), le sable est **déjaugé** :

$$\gamma'_b = (\rho_s - \rho_w)(1-n)\,g = 1650\times0.62\times9.81 = 1.00\times10^4\ \text{N/m}^³$$

soit 62 % du poids sec. Effet : les pentes immergées sont **plus stables en apparence**
(le poids moteur baisse dans le même rapport que la contrainte normale, donc $\theta_{max}$
ne change pas en théorie), mais la **cohésion tombe à 0** → $\theta_{max} = \varphi$
si drainé, et $\to 0$ si liquéfié (surpression interstitielle). Traduction jeu :

```
si y < ySeaLevel :  w = 1.0  et  liquefaction = clamp(dPore/(γ'_b·z), 0, 1)
θ_max_eff = lerp(θ_max(1.0), 5°, liquefaction)
```

---

# PARTIE 2 — ALGORITHME DE STABILITÉ / EFFONDREMENT SUR VOXELS

## 2.1 Comparatif des cinq familles

| Critère | CA d'avalanche voxel | Thermal erosion (heightfield) | Sandpile BTW | MPM (Drucker–Prager) | PBD/XPBD granulaire |
|---|---|---|---|---|---|
| Représentation | champ 3D creux, densité continue | hauteur 2D | entiers 2D | particules + grille | particules |
| Surplombs / grottes | ✅ natif | ❌ impossible | ❌ | ✅ | ✅ |
| Cohésion / murs verticaux | ✅ via seuil | ⚠️ via talus > 60° seulement | ❌ | ✅ (le plus rigoureux) | ⚠️ contraintes de distance |
| Conservation de masse | ✅ exacte (entiers) | ✅ | ✅ | ⚠️ (dérive numérique) | ⚠️ |
| Coût JS (12×3×12 m) | **0.5–4 ms/frame** (active set) | 0.3 ms | 0.1 ms | 30–300 ms ❌ | 10–80 ms ❌ |
| Sculptable / creusable | ✅ trivial | ❌ | ❌ | ⚠️ (reconstruire particules) | ⚠️ |
| Maillage direct | ✅ Surface Nets | ✅ grille | — | ❌ (besoin de surfacing) | ❌ |
| Réalisme des avalanches | ⭐⭐⭐ | ⭐⭐ | ⭐ | ⭐⭐⭐⭐⭐ | ⭐⭐⭐⭐ |
| Déterminisme / rejouabilité | ✅ | ✅ | ✅ | ⚠️ | ⚠️ |

**Détail des disqualifications :**

- **MPM (Klár et al. 2016, *Drucker-Prager Elastoplasticity for Sand Animation*)** est le
  standard de référence : hyperélasticité en déformation de Hencky + surface de charge de
  Drucker–Prager, flux non associé, projection de contrainte (« return mapping ») sur le
  cône. C'est le seul modèle qui capture correctement dilatance, cisaillement, jets, mélange
  sable/eau. **Mais** : les implémentations GPU de référence tournent à 5–40 M particules
  *en offline* (< 1 min/frame), et même les versions temps réel demandent 100k–1M particules
  sur GPU dédié avec compute shaders. En JS/WebGL2 : hors budget. Réservé à une éventuelle
  version WebGPU d'un *effet local* (jet de sable d'une pelle, 5–20 k particules).
- **PBD/XPBD granulaire** (Macklin & Müller, « Parallel Particles P2 ») : 5–10 itérations
  suffisent visuellement, mais il faut 200–500 particules par litre pour un rendu correct →
  ~50 M particules pour 12×3×12 m. Impossible. Utilisable **uniquement** pour la fraction
  volante (voir §2.6).
- **BTW sandpile** : conserve le nombre de grains mais c'est un *height model*, pas un
  *slope model* ; la littérature elle-même note que « pour modéliser un vrai tas de sable,
  il faut un modèle de pente, pas de hauteur ». L'auto-organisation critique produit des
  avalanches en loi de puissance jolies statistiquement mais visuellement fausses (pas de
  cône d'éboulis, pas d'angle de repos net). ❌
- **Thermal erosion / talus (Musgrave 1989)** : excellent et quasi gratuit, mais 2D.
  → **On le garde comme *sous-routine* de la version 3D** (c'est mathématiquement la même
  règle de redistribution proportionnelle à l'excès de pente).

## 2.2 → Algorithme recommandé

> **Automate cellulaire d'avalanche 3D à densité continue**, sur active set,
> avec seuil Mohr–Coulomb tabulé, balayage 4-couleurs horizontal,
> transferts entiers (conservation exacte), amortissement, et
> **champ de support** séparé pour les surplombs/arches.

Points de conception non négociables :

1. **Densité continue Uint8 (0–255), iso = 128.** Ne *jamais* faire du binaire
   plein/vide. Les transferts partiels (8–48 unités par pas) donnent un écoulement
   visuellement continu avec Surface Nets, et une conservation de masse exacte.
2. **Le champ de densité est la vérité.** Pas de liste de particules persistantes.
3. **Active set** : seuls les voxels « sales » sont testés. Un tas au repos coûte 0.
4. **Réveil en cascade** : tout voxel qui change réveille ses 26 voisins (ou au moins
   les 6+4 pertinents) + les 3 voxels au-dessus.

## 2.3 Détail de la passe de relaxation

### 2.3.1 Ordre de balayage — éviter les biais directionnels

Un balayage `for x for y for z` produit une dérive systématique du sable vers +x
(le voxel déjà mis à jour ce frame reçoit puis redonne). Trois parades combinées :

1. **Damier 4 couleurs dans le plan horizontal** : `color = (x & 1) | ((z & 1) << 1)`.
   Dans une couleur donnée, aucun voxel n'a de voisin latéral (4-voisinage) de la même
   couleur → mise à jour parallélisable et sans conflit. On traite les 4 couleurs dans un
   ordre **permuté aléatoirement à chaque frame**.
   *(Si on utilise le 8-voisinage horizontal, il faut 4 couleurs sur un pas de 2 :
   `(x&1)|((z&1)<<1)` ne suffit plus pour les diagonales — traiter les diagonales dans une
   sous-passe séparée avec un facteur de transfert réduit de $1/\sqrt2$.)*
2. **Permutation de l'ordre des voisins** dans la boucle interne (table de 24 permutations
   pré-générée, indexée par `(frame*2654435761 ^ hash(x,z)) & 23`).
3. **Balayage vertical de bas en haut** pour l'écoulement (le sable descend), de haut en
   bas pour l'effondrement (les blocs tombent). En pratique : **de bas en haut**, ce qui
   fait qu'un voxel qui vient de se vider est immédiatement rempli par celui du dessus →
   colonne qui s'écoule d'un coup, visuellement juste.

### 2.3.2 Règle de transfert

Pour un voxel source $s$ (densité $\rho_s > \text{ISO}$) et un voisin latéral $t$ :

```
Δz    = surfaceHeight(x_s,z_s) - surfaceHeight(x_t,z_t)     [en unités de voxel, continu]
excess = Δz - tanθ_max * (L/h)                              [en unités de voxel]
si excess <= 0 : stable, rien
amount = clamp( round(DAMPING * excess * 255 * 0.5), 1, maxTransfer )
amount = min(amount, ρ_s - ISO, 255 - ρ_t)                  [ne pas creuser sous l'iso]
ρ_s -= amount ; ρ_t += amount                               [entiers → masse conservée]
```

- `DAMPING = 0.35` (plage utile 0.25–0.5). Au-delà de 0.5 avec 4 couleurs, oscillations
  en damier visibles.
- `maxTransfer = 48` (sur 255). Limite la vitesse d'écoulement à ≈ 0.19 voxel/pas ;
  avec 2 passes/frame à 60 Hz et $h=4$ cm → **0.9 m/s**. Un écoulement de sable réel
  descend une pente à 0.5–2 m/s. ✅ Pour un effondrement spectaculaire on autorise
  `maxTransfer = 128` pendant les 20 premiers pas suivant l'événement (voir §2.6).
- Le facteur 0.5 vient du fait que transférer $\delta$ réduit $\Delta z$ de $2\delta$
  (la source baisse et la cible monte) → c'est un Jacobi sous-relaxé.

### 2.3.3 Conservation de la masse

- Tous les transferts sont **entiers sur Uint8** → somme invariante bit à bit.
- Garder un accumulateur `int32 totalMass` mis à jour uniquement lors des ajouts/retraits
  explicites (pelle, érosion). En debug, recalculer la somme toutes les 600 frames et
  asserter l'égalité.
- Sable qui sort du domaine : le compter dans `massLost` (pour pouvoir le réinjecter au
  bord de mer, ou juste pour le debug).

### 2.3.4 Active set (« dirty voxels »)

Structure recommandée — **deux `Int32Array` en ping-pong + un bitset de présence** :

```
activeA / activeB : Int32Array(MAX_ACTIVE)   // indices linéaires
activeCount
inActive          : Uint8Array(NX*NY*NZ) bitset (ou Uint8 direct : 4 MB, simple)
```

`push(idx)` : `if (!inActive[idx]) { inActive[idx]=1; activeA[n++]=idx; }`
→ O(1), pas de Set/Map JS (200× plus lent).

**Boucle :**
```
pour chaque couleur c dans permutation(4) :
    pour i dans [0, activeCount) :
        idx = activeA[i]
        si color(idx) != c : continuer
        si relax(idx) a modifié quelque chose :
            wake(idx) ; wake(les 4 voisins latéraux) ; wake(voxel dessus) ; wake(voxel dessous)
swap(activeA, activeB) ; activeCount = nextCount
```

**Réveil** : un voxel non modifié pendant $N_{sleep}=3$ passes consécutives sort de
l'active set. Cela évite qu'un tas « frémissant » reste actif indéfiniment.
Ajouter une **hystérésis sur le seuil** : on réveille si $\tan\theta > \tan\theta_{max}$,
on endort si $\tan\theta < 0.97\,\tan\theta_{max}$.

### 2.3.5 Itérations par frame et budget

| Situation | Voxels actifs typiques | Passes/frame | Coût JS |
|---|---|---|---|
| Repos complet | 0 | — | ~0.02 ms |
| Sculpture au pinceau | 300 – 2 000 | 2 | 0.1 – 0.3 ms |
| Effondrement d'un mur | 5 000 – 25 000 | 2 | 0.6 – 2.5 ms |
| Vague qui casse un château | 30 000 – 80 000 | **1** (dégradé) | 3 – 5 ms |
| Plafond dur | `BUDGET_GRANULAR = 90 000` | 1 | ~5 ms |

**Dégradation gracieuse** : si `activeCount > BUDGET`, trier grossièrement par « excès de
pente » (bucket sort sur 8 seaux) et ne traiter que les plus instables ; les autres
restent dans l'active set pour la frame suivante. **Ne jamais** simplement tronquer :
ça fige des configurations instables au hasard et ça se voit.

## 2.4 Surplombs et arches — le champ de support

C'est le point le plus délicat. Trois mécanismes complémentaires, du moins cher au plus cher.

### 2.4.1 Mécanisme A — Test de porte-à-faux local (le moins cher, ~80 % du travail)

Un voxel de sable **sans voxel solide en dessous** est en porte-à-faux. La question est :
*de quelle longueur horizontale est-il éloigné du support le plus proche ?*

**Champ de support** `sup : Uint8Array` — distance de chemin, en voxels, jusqu'à un
appui vertical, calculée par un **BFS multi-source à coûts entiers (dial / bucket queue)** :

```
coût 0 : descendre (y-1) vers un voxel solide          -> support gratuit
coût 1 : se déplacer latéralement (±x, ±z)             -> extension du porte-à-faux
coût 2 : monter (y+1)                                  -> pénalise les colonnes suspendues
sources : tous les voxels solides posés sur le sol (y=0) ou sur du MAT_ROCK  -> sup = 0
```

Comme le BFS prend le **plus court chemin**, un voxel au milieu d'une arche obtient
automatiquement `sup = span/2` (le chemin passe par le côté le plus proche) — **les arches
sont gérées gratuitement**, sans code spécifique. ✅

**Critère d'effondrement.** Deux modes de rupture pour un porte-à-faux de longueur $L$ et
d'épaisseur verticale $t$ :

*Cisaillement à l'encastrement* — la section verticale doit reprendre le poids :
$$\tau = \frac{\rho_b g\, t\, L}{t} = \rho_b g L \le c \quad\Rightarrow\quad \boxed{L_{max}^{shear} = \frac{c(w)}{\rho_b\, g}}$$

*Flexion* — moment $M = \rho_b g\,t\,L^2/2$, module $Z = t^2/6$ :
$$\sigma = \frac{M}{Z} = \frac{3\rho_b g L^2}{t} \le \sigma_t \quad\Rightarrow\quad \boxed{L_{max}^{bend} = \sqrt{\frac{\sigma_t(w)\,t}{3\rho_b\,g}}}$$

$$L_{max} = k_{arch}\cdot\min\!\left(L_{max}^{shear},\ L_{max}^{bend}\right)$$

**Valeurs** ($\rho_b g = 1.61\times10^4$ N/m³, $h = 4$ cm, $k_{arch}=1$) :

| $c$ [Pa] | $\sigma_t$ [Pa] | $L^{shear}$ | $L^{bend}$ ($t$=20 cm) | $L^{bend}$ ($t$=50 cm) | $L_{max}$ | en voxels |
|---|---|---|---|---|---|---|
| 0 (sec) | 0 | 0 | 0 | 0 | **0** | **0** ✅ |
| 500 | 740 | 3.1 cm | 5.5 cm | 8.8 cm | 3.1 cm | ~1 |
| 1200 | 1780 | 7.5 cm | 8.6 cm | 13.6 cm | 7.5 cm | ~2 |
| 2400 | 3556 | 14.9 cm | 12.1 cm | 19.2 cm | 12.1 cm | **3** |
| 5000 | 7400 | 31 cm | 17.5 cm | 27.7 cm | 17.5 cm | 4 |

→ **Sable sec : aucun surplomb possible** (physiquement exact).
→ **Sable humide optimal : surplomb de 3–4 voxels = 12–16 cm.** C'est petit mais c'est
la réalité, et c'est *exactement* ce qui donne le look « sculpture de sable » avec ses
petits encorbellements et ses fenêtres découpées.
→ Pour un gameplay plus permissif : `k_arch = 2.0` → 6–8 voxels (25–32 cm). Recommandé.

**Déclenchement** : à chaque passe, pour tout voxel de l'active set,
`si sup[idx] > N_max(w, t) : effondrer` (voir §2.6 pour « comment »).

### 2.4.2 Mécanisme B — Propagation descendante de contrainte (le « poids porté »)

Pour empêcher les colonnes fines de porter des masses absurdes, propager un champ
$\sigma_v$ = contrainte verticale, en **une seule passe de haut en bas** :

$$\sigma_v(x,y,z) = \rho_b\, g\, h\cdot\frac{\rho_{vox}}{255} + \frac{1}{N}\sum_{\text{voisins }(x',z')\text{ au-dessus}} \omega\,\sigma_v(x',y+1,z')$$

avec un noyau de diffusion latérale (Boussinesq discret / « effet de voûte ») :
$\omega = 0.7$ au-dessus direct, $0.075$ pour chacun des 4 latéraux au-dessus.
Ce noyau reproduit qualitativement le **dip de pression sous un tas de sable**
(effet de voûte, force chains) sans rien coûter.

Rupture par écrasement si $\sigma_v > \sigma_{crush}$, avec pour du sable
$\sigma_{crush} \approx 50$–200 kPa (ne se déclenche jamais à 3 m de haut :
$\sigma_v^{max} = 1.61\times10^4\times3 = 48$ kPa) — **donc en pratique on ne s'en sert
que pour le sable sur-saturé/liquéfié** où $\sigma_{crush}$ chute.

Coût : $O(N_{actifs})$, 1 passe, uniquement sur les colonnes marquées sales.
**Optionnel — à implémenter en phase 2.**

### 2.4.3 Mécanisme C — Connectivité au sol (flood-fill / îlots)

Un morceau totalement détaché (pont coupé en deux, bloc découpé à la pelle) doit tomber.
Le champ `sup` du mécanisme A le détecte déjà : un composant déconnecté n'est atteint par
aucune source → `sup = 255` (INF). **C'est le même BFS, aucun code supplémentaire.**

```
si sup[idx] == 255 : voxel en chute libre -> convertir en particule (ou faire descendre
                     la colonne entière de 1 voxel/pas jusqu'à contact)
```

### 2.4.4 Mise à jour incrémentale du champ de support

Recalculer un BFS sur 4 M voxels coûte ~40–80 ms. Inacceptable par frame. Stratégie :

1. **Rayon borné.** On n'a besoin de `sup` que jusqu'à `SUP_MAX = 12` (au-delà,
   tout s'effondre de toute façon). BFS borné à 12 niveaux.
2. **Région dirty.** Quand un voxel change, on invalide `sup` dans une boîte de rayon
   `SUP_MAX` autour, on remet ces valeurs à INF, on réamorce le BFS avec comme sources
   les voxels de la **frontière** de la boîte (valeurs encore valides) + les appuis
   internes. Coût : $O((2\times12)^3) = 13$ k voxels au pire, ~0.3 ms. En pratique on
   traite les boîtes fusionnées (union des AABB dirty) une fois par frame.
3. **Amortissement.** Si plusieurs boîtes sont en attente, en traiter au plus
   `BUDGET_SUPPORT = 40 000` voxels par frame ; les voxels dont `sup` n'est pas à jour
   conservent leur ancienne valeur (conservatif : ils ne s'effondrent pas
   prématurément, ils s'effondrent avec 1–2 frames de retard — invisible).

**Structure du BFS à coûts {0,1,2}** : file à seaux (dial) de 3 niveaux ; c'est un
Dijkstra en $O(V)$ sans tas binaire.

## 2.5 Champ auxiliaire `freeHeight` pour Culmann

Pour le critère de mur vertical (§1.7.3), maintenir une grille 2D :

```
freeHeight[x][z] = nombre de voxels solides consécutifs, en partant de la surface
                   vers le bas, dont AU MOINS un voisin latéral (4-voisinage) est vide
```

C'est la hauteur de façade exposée. Mise à jour : recalcul de la colonne complète
($O(N_Y)=96$ itérations) uniquement pour les colonnes dirty → ~10 k colonnes max/frame
= 1 M itérations triviales ≈ 1.5 ms au pire, en pratique < 0.1 ms.

Test :
```
H = freeHeight[x][z] * VOXEL
si H > H_c(β_eff, c(w)) : marquer la colonne comme "en rupture"
   -> injecter un excès de pente artificiel qui force l'avalanche
      (on ne téléporte pas de matière : on baisse θ_max_eff de cette colonne à φ
       pendant 30 frames -> elle se met à couler naturellement)
```

**Astuce clé** : ne jamais « supprimer » de la matière pour simuler un effondrement.
On **abaisse localement $\theta_{max}$**, et l'automate d'avalanche fait le reste.
Résultat : la masse est conservée, le cône d'éboulis se forme tout seul, et la
transition est continue.

## 2.6 Rendre l'effondrement visuellement BON

Sept techniques, par ordre d'impact visuel décroissant :

### (1) Densité continue + Surface Nets = écoulement lisse
Déjà couvert. C'est **le** point qui distingue un rendu « Minecraft qui clignote » d'un
rendu « sable qui coule ». Transferts de 8–48/255 par pas → la surface se déforme de
manière sub-voxel.

### (2) Front de rupture progressif, jamais instantané
Quand Culmann déclenche une rupture de mur, ne pas relâcher toute la colonne d'un coup.
Modèle en 3 temps, calé sur le comportement réel du sable humide (rupture fragile) :

| Phase | Durée | Effet |
|---|---|---|
| **Fissuration** | 0.15 – 0.3 s | $\theta_{max}$ descend de 89° à ~60° ; micro-affaissement de 1–2 cm ; particules de poussière fines au sommet ; son de craquement |
| **Basculement** | 0.3 – 0.8 s | $\theta_{max} \to \varphi$ ; `maxTransfer = 128` ; le bloc bascule (l'automate crée naturellement une rotation apparente) |
| **Étalement** | 1 – 3 s | retour progressif de $\theta_{max}$ vers $\theta_{max}(w)$ ; le cône d'éboulis se stabilise |

Interpoler $\theta_{max}$ avec un `smoothstep` sur un champ `breakTimer : Uint8Array`
(par colonne, 1 octet, 0–255 frames).

### (3) Cône d'éboulis — gratuit, mais il faut le laisser se former
La relaxation Mohr–Coulomb produit **automatiquement** un talus à $\theta_{max}(w)$ au pied
de l'effondrement. Deux réglages pour qu'il soit joli :
- Le sable qui vient de s'effondrer doit être **plus sec** (il a perdu ses ponts capillaires
  par cisaillement !) → appliquer `w *= 0.85` aux voxels transférés lors d'une avalanche
  rapide. Physiquement justifié (dilatance : le cisaillement fait gonfler le sable, la
  saturation locale chute — c'est pourquoi le sable *blanchit* sous le pied sur une plage
  mouillée). **Effet visuel très fort, presque gratuit.**
- Jitter du seuil : $\theta_{max}$ perturbé de $\pm1.5°$ par un bruit de hash spatial
  stable → brise les fronts plats et les cônes trop parfaits.

### (4) Bruit de rupture spatialement corrélé
Un bruit blanc par voxel donne un aspect « grésillant ». Utiliser un bruit de valeur
3D à basse fréquence (période 6–10 voxels), précalculé dans une `Int8Array` de 64³
tuilée :
```
θ_max_eff = θ_max(w) * (1 + 0.03 * noise3(x>>1, y>>1, z>>1))
```

### (5) Fraction volante : particules GPU
Le champ voxel gère la masse ; les particules gèrent le **spectacle**.
- Émettre 1 particule par ~4 unités de densité déplacée avec $|\Delta| > 24$ (i.e.
  seulement les mouvements rapides). Cap : 20 000 particules vivantes.
- Vitesse initiale = direction du transfert × 1.5 m/s + composante verticale de chute.
- Intégration `THREE.Points` + `BufferGeometry`, mise à jour en Float32Array, ou mieux :
  **transform feedback WebGL2** / storage buffer WebGPU → coût CPU nul.
- **Ne pas** réinjecter la masse : elle est déjà dans le champ. Les particules sont
  purement décoratives et fade out en 0.6–1.2 s.

### (6) Poussière
- Billboards additifs, 200–800 vivants, taille 0.15 → 0.8 m sur la durée de vie,
  opacité $\propto (1-t)^2$, durée 1.5–2.5 s.
- Émission **proportionnelle au volume déplacé et à $(1-w)$** : le sable mouillé ne fait
  pas de poussière. $N_{dust} = 0.02\,\Delta V_{voxels}\,(1-w)^2$.
- Vélocité : composante horizontale = direction de l'éboulis × 0.8 m/s, verticale +0.3 m/s,
  drag 0.9/frame, léger bruit de curl.

### (7) Retour d'humidité sur la surface fraîche
Quand une face interne est exposée, elle est **plus humide et plus sombre** que la surface
sèche (qui a évaporé). Le shader lit directement le champ `w` interpolé → transition
automatique claire/foncé sur la cassure. **Un des détails les plus « vendeurs ».**
Albedo : $A = \mathrm{lerp}(A_{sec}, A_{sec}\times0.55, \mathrm{smoothstep}(0,0.35,w))$
+ un boost de spéculaire/roughness ($\text{rough} = \mathrm{lerp}(0.95, 0.45, w)$).

### (8) Validation physique : longueur de runout
Pour vérifier que l'effondrement « a la bonne taille », comparer aux lois d'échelle
expérimentales de l'effondrement de colonne granulaire (Lube et al. 2004, Lajeunesse et al. 2005).
Pour une colonne de rayon $R_0$ et de rapport d'aspect $a = H_0/R_0$ :

$$\frac{R_\infty - R_0}{R_0} \simeq \begin{cases} 1.24\,a & a \lesssim 1.7 \\ 1.6\,\sqrt{a} & a \gtrsim 1.7\end{cases}
\qquad \frac{H_\infty}{H_0} \simeq \begin{cases} 1 & a \lesssim 0.74 \\ 0.88\,a^{-0.6} & a \gtrsim 0.74\end{cases}$$

**Test de non-régression** : colonne de sable sec $R_0 = 0.4$ m, $H_0 = 1.2$ m ($a=3$).
Attendu : $R_\infty = 0.4(1+1.6\sqrt3) = 1.51$ m, $H_\infty = 1.2\times0.88\times3^{-0.6} = 0.54$ m.
Si la simulation donne ça à ±20 %, la calibration de `DAMPING` et `maxTransfer` est bonne.

---

# PARTIE 3 — HUMIDITÉ : DIFFUSION, PERCOLATION, ÉVAPORATION

## 3.1 Équation de Richards et sa simplification

Forme mixte de Richards :

$$\frac{\partial \theta}{\partial t} = \nabla\!\cdot\!\big[K(\theta)\,\nabla h\big] + \frac{\partial K(\theta)}{\partial z}, \qquad h = \psi(\theta) + z$$

Résoudre ça implicitement (Picard/Newton + solveur linéaire) est hors budget.
**Décomposition en splitting opérateur** — trois sous-passes explicites indépendantes :

$$\underbrace{\frac{\partial\theta}{\partial t} = -\frac{\partial K(\theta)}{\partial z}}_{\text{(A) percolation gravitaire, advection}} \;+\; \underbrace{\nabla\!\cdot\!\big[D(\theta)\nabla\theta\big]}_{\text{(B) diffusion capillaire}} \;+\; \underbrace{s_{evap} + s_{cap} + s_{infil}}_{\text{(C) termes sources}}$$

avec la **diffusivité hydraulique** $D(\theta) = K(\theta)\,\dfrac{d\psi}{d\theta}$.

## 3.2 (A) Percolation gravitaire

Modèle « seau » (bucket / tipping-bucket), inconditionnellement stable et conservatif :

```
pour chaque voxel de haut en bas :
    surplus = max(0, w[i] - w_fc)                 # w_fc : capacité au champ
    flux    = min(surplus, K_game * dt / (n*h))   # limité par la conductivité
    place   = w_max - w[below]                    # place disponible en dessous
    move    = min(flux, place)
    w[i] -= move ; w[below] += move
    si w[below] est déjà plein -> étalement latéral (répartir sur les 4 voisins)
```

| Constante | Valeur physique | Valeur jeu | Justification |
|---|---|---|---|
| $w_{fc}$ (capacité au champ) | 0.10 – 0.15 | **0.12** | pF 2.5 ; sable retient peu |
| $w_{max}$ | 1.0 | **0.98** | on garde un epsilon d'air |
| $K_s$ | $8\times10^{-5}$ m/s | **$4\times10^{-3}$ m/s** ($\times50$) | sinon 8 min pour traverser un voxel |
| $K(w)$ | Mualem–vG | $K_s\,w_e^{3}$ (approx cubique) | $w_e = (w-w_r)/(1-w_r)$, $w_r=0.03$ |

À $K_{game} = 4\times10^{-3}$ m/s, $n=0.38$, $h=0.04$ m :
$\Delta w/\Delta t = K/(n h) = 0.26$ /s → une saturation totale se vide en ~4 s. ✅

**Nappe phréatique** : sous `SEA_LEVEL` (ajusté par la marée), forcer $w = 1$ et bloquer
la percolation sortante. Le niveau de nappe suit la marée avec un retard : filtre passe-bas

$$y_{nappe}^{t+1} = y_{nappe}^{t} + (y_{mer}^{t} - y_{nappe}^{t})\cdot\big(1-e^{-\Delta t/\tau_{n}}\big), \quad \tau_n = 90\ \text{s de jeu}$$

et une pente vers l'intérieur des terres (la nappe de plage n'est pas horizontale) :
$y_{nappe}(x,z) = y_{mer} + \max(0, (D_{shore} - 0.5))\times 0.04$ (pente 4 %).

## 3.3 (B) Diffusion capillaire

$$\frac{\partial w}{\partial t} = D\,\nabla^2 w$$

Schéma explicite 7-points, condition de stabilité (von Neumann, 3D) :

$$\Delta t \le \frac{h^2}{6D} \qquad\text{(prendre } \Delta t \le 0.5\,\frac{h^2}{6D}\text{ pour la marge)}$$

| $D$ [m²/s] | $h$ | $\Delta t_{max}$ | Temps pour diffuser 1 voxel ($h^2/D$) | Temps pour 20 cm |
|---|---|---|---|---|
| $10^{-5}$ (physique moyen) | 4 cm | 26.7 s | 160 s | 66 min |
| $10^{-4}$ | 4 cm | 2.67 s | 16 s | 6.6 min |
| **$5\times10^{-4}$ (jeu)** | 4 cm | **0.53 s** | **3.2 s** | **80 s** |
| $10^{-3}$ | 4 cm | 0.27 s | 1.6 s | 40 s |
| $5\times10^{-4}$ | 8 cm (grille 2×) | **2.13 s** | 12.8 s | 80 s |

> **Recommandation : grille d'humidité 2× plus grossière** (8 cm, soit 128×48×128 = 786 k
> cellules au lieu de 6.3 M) mise à jour à **10 Hz** avec $D = 5\times10^{-4}$ m²/s.
> $\Delta t = 0.1$ s $\ll 2.13$ s → stabilité massive, on peut même faire 4 sous-itérations
> pour accélérer la diffusion effective ($D_{eff} = 2\times10^{-3}$).
> Coût : 786 k × 7 lectures = 5.5 M ops **toutes les 6 frames** → ~4 ms amorti à 0.7 ms/frame.
> L'échantillonnage voxel→humidité se fait par trilerp dans le shader et par
> `w8[(x>>1) + ...]` dans la physique (décalage de bits, gratuit).

**Anisotropie** : en réalité la diffusion capillaire est isotrope mais la gravité ajoute
un biais vertical, déjà traité par (A). Garder (B) isotrope. Optionnellement pondérer
$D_y = 1.2\,D_{xz}$ pour un rendu plus « colonne humide ».

**Dépendance à la saturation** (à activer si le budget le permet) :
$$D(w) = D_0\,\left[4\,w_e(1-w_e)\right]^{0.7}$$
Maximum à $w_e = 0.5$, nul aux extrêmes → le sable très sec n'aspire pas
(faux physiquement mais visuellement correct : les fronts d'humidité restent nets).
Sans ce terme, les fronts se floutent trop et on perd l'aspect « tache d'eau ».

## 3.4 (C1) Remontée capillaire depuis la nappe

**Hauteur de frange capillaire** — Young–Laplace dans un pore de rayon $r_p$ :

$$h_{cap} = \frac{2\gamma_{lv}\cos\theta_c}{\rho_w\, g\, r_p}, \qquad r_p \approx 0.2\,d_{10}$$

ou la formule empirique de **Terzaghi–Hazen** : $h_{cap} = \dfrac{C}{e\cdot d_{10}}$ avec
$C = 0.1$–0.5 cm² et $d_{10}$ en cm.

**Valeurs mesurées et calculées :**

| Matériau | $d_{10}$ | $h_{cap}$ calculé | $h_{cap}$ mesuré (littérature) |
|---|---|---|---|
| Gravier fin | 2 mm | 3.7 cm | 2 – 10 cm |
| Sable grossier | 0.6 mm | 12 cm | **10 – 15 cm** |
| Sable moyen (plage) | 0.3 mm | 25 cm | **13.5 – 30 cm** |
| Sable fin | 0.15 mm | 49 cm | 30 – 100 cm |
| Sable limoneux | 0.06 mm | 1.2 m | 0.7 – 1.5 m |
| Limon | 0.02 mm | 3.7 m | 1.5 – 10 m |

> `CAPILLARY_FRINGE = 0.30` m dans `Config.js` : ✅ **valeur correcte** pour un sable
> de plage moyen. C'est le mécanisme qui donne au joueur du sable humide « gratuit »
> quand il creuse — bonne mécanique.

**Profil d'équilibre** au-dessus de la nappe (à $z$ mètres au-dessus de $y_{nappe}$) :

$$w_{eq}(z) = \begin{cases} 1 & z \le z_{ae} \\ \left[1+(\alpha z)^{n_{vg}}\right]^{-m} & z > z_{ae}\end{cases}$$

avec $z_{ae} = 1/\alpha$ (entrée d'air). Pour $\alpha = 5$ m⁻¹, $n_{vg}=3$, $m = 0.667$ :

| $z$ [cm] | 0 | 10 | 20 | 30 | 40 | 60 | 100 | 150 |
|---|---|---|---|---|---|---|---|---|
| $w_{eq}$ | 1.00 | 1.00 | 0.94 | 0.79 | 0.62 | 0.35 | 0.13 | 0.05 |

**Implémentation (relaxation vers l'équilibre, très bon marché)** — une seule ligne
par cellule, appliquée à la grille d'humidité :

$$w \mathrel{{+}{=}} \big(w_{eq}(y - y_{nappe}) - w\big)\cdot\big(1-e^{-\Delta t/\tau_{cap}}\big), \qquad \tau_{cap} = 20\ \text{s}$$

Ne l'appliquer que si $w < w_{eq}$ (la remontée capillaire mouille, elle ne sèche pas ;
le séchage est géré par l'évaporation). Précalculer $w_{eq}$ dans une LUT de 128 entrées
indexée par $\lfloor (y-y_{nappe})/h_m \rfloor$.

## 3.5 (C2) Évaporation de surface

**Référence FAO-56 Penman–Monteith** (évapotranspiration de référence, mm/jour) :

$$ET_0 = \frac{0.408\,\Delta\,(R_n - G) + \gamma_{psy}\dfrac{900}{T+273}\,u_2\,(e_s-e_a)}{\Delta + \gamma_{psy}(1+0.34\,u_2)}$$

$\Delta$ = pente de la courbe de pression de vapeur [kPa/°C], $\gamma_{psy} = 0.067$ kPa/°C,
$R_n$ [MJ/m²/j], $u_2$ = vent à 2 m [m/s], $(e_s-e_a)$ = déficit de vapeur [kPa].

**Version jeu simplifiée** (calibrée pour redonner les mêmes ordres de grandeur) :

$$\boxed{E\,[\text{mm/h}] = E_0\cdot\big(0.25 + 0.75\,I_{sun}\big)\cdot\big(1 + 0.35\,u\big)\cdot 2^{(T-20)/12}\cdot(1-RH)}$$

avec $E_0 = 0.45$ mm/h, $I_{sun}\in[0,1]$ (facteur d'ensoleillement = $\max(0,\sin(\text{élévation solaire}))\times(1-\text{nuages})$),
$u$ = vitesse du vent [m/s], $T$ [°C], $RH$ = humidité relative de l'air [0,1].

**Valeurs de référence :**

| Scénario | $I_{sun}$ | $u$ | $T$ | $RH$ | $E$ [mm/h] | $E$ [mm/j] |
|---|---|---|---|---|---|---|
| Nuit calme | 0 | 1 | 16 | 0.85 | 0.023 | 0.55 |
| Matin nuageux | 0.3 | 2 | 20 | 0.7 | 0.093 | 2.2 |
| **Midi ensoleillé, brise** | **0.95** | **3** | **28** | **0.45** | **0.46** | **11** |
| Après-midi venteux | 0.7 | 7 | 26 | 0.5 | 0.63 | 15 |
| Canicule sans vent | 1.0 | 0.5 | 35 | 0.3 | 0.53 | 12.7 |

*(Les valeurs journalières d'évaporation potentielle sur une plage méditerranéenne en été
sont de 6–10 mm/j ; 11 mm/j en pointe de midi extrapolé est cohérent.)*

**Conversion en perte de saturation par seconde**, appliquée sur une couche de surface
d'épaisseur $d_{evap}$ :

$$\boxed{\frac{dw}{dt} = -\frac{E\,[\text{m/s}]}{n\cdot d_{evap}}\cdot \beta_{stage}(w)\cdot A_{game}}$$

- $d_{evap} = 0.02$ m (2 cm — l'évaporation ne concerne que la pellicule superficielle ;
  en dessous c'est la diffusion qui alimente). En voxels de 4 cm : **le demi-voxel de surface**.
- $\beta_{stage}(w)$ — le séchage réel se fait en deux phases :
  - **Stage 1** ($w > w_{crit} \approx 0.15$) : évaporation ≈ potentielle, $\beta = 1$.
  - **Stage 2** ($w < w_{crit}$) : limitée par la diffusion de vapeur, $\beta = (w/w_{crit})^2$.
  $$\beta_{stage}(w) = \min\!\big(1,\ (w/0.15)^2\big)$$
- $A_{game}$ = accélération temporelle. Avec $E = 0.46$ mm/h $= 1.28\times10^{-7}$ m/s :
  $$\frac{dw}{dt} = \frac{1.28\times10^{-7}}{0.38\times0.02} = 1.68\times10^{-5}\ \text{s}^{-1}$$
  → 16.5 heures pour passer de $w=1$ à $w=0$. **Beaucoup trop lent pour le jeu.**
  Avec $A_{game} = 120$ : $2.0\times10^{-3}$ s⁻¹ → **séchage complet en ~8 min de jeu**,
  et la couche de surface passe de 0.4 à 0.15 (perte de tenue) en **2 minutes**. ✅
  C'est le bon tempo : le joueur doit re-mouiller son château régulièrement.

> `EVAPORATION_BASE = 1.7e-7` m/s dans `Config.js` = 0.61 mm/h : ✅ cohérent avec
> « plein soleil ». Il manque juste le facteur $A_{game}$ et $\beta_{stage}$.

**Facteurs supplémentaires (bonus visuel/gameplay) :**
- **Ombre** : un voxel à l'ombre (test de visibilité solaire déjà calculé pour le rendu, ou
  simple AO vertical) → $I_{sun}$ local × 0.15. Les faces nord des tours restent humides.
  Excellent détail.
- **Orientation** : $E \mathrel{{\times}{=}} \max(0.2, \mathbf{n}\cdot\mathbf{l})$ (normale · direction du soleil).
- **Exposition au vent** : $E \mathrel{{\times}{=}} (0.5 + 0.5\,\max(0,\mathbf{n}\cdot\mathbf{v}_{wind}))$.

## 3.6 (C3) Infiltration depuis l'eau de surface

$$I = \min\!\Big(K_{inf}\cdot(1-w_{surf}),\ \frac{d_{water}}{\Delta t}\Big) \quad [\text{m/s}]$$
$$d_{water} \mathrel{-}= I\,\Delta t, \qquad w_{surf} \mathrel{+}= \frac{I\,\Delta t}{n\,h}$$

`INFILTRATION_RATE = 4e-5` m/s (`Config.js`) : c'est la valeur *physique* (≈ $0.5\,K_s$).
Sur un voxel de 4 cm : $\Delta w = 4\times10^{-5}/(0.38\times0.04) = 2.6\times10^{-3}$ /s
→ 6 minutes pour saturer un voxel. **Trop lent** : passer à $K_{inf} = 1.5\times10^{-3}$ m/s
($\times 40$) → $\Delta w = 0.1$/s → 10 s pour saturer. Une flaque doit disparaître
dans le sable en quelques secondes, comme sur une vraie plage.

## 3.7 Récapitulatif du schéma numérique d'humidité

```
Toutes les 6 frames (dt_m = 0.1 s), sur la grille 2× grossière (8 cm) :
  1. Nappe        : w = 1 sous y_nappe ; y_nappe suit la marée (filtre τ=90s)
  2. Capillarité  : w += (w_eq(y-y_nappe) - w) * (1-exp(-dt/20))   si w < w_eq
  3. Infiltration : depuis waterDepth 2D (grille eau), sur la colonne de surface
  4. Percolation  : bucket cascade de haut en bas, K_game(w)
  5. Diffusion    : 4 sous-pas explicites, D_eff = 5e-4, dt_sub = 0.025 s
                    (nombre de diffusion = D*dt/h² = 5e-4*0.025/0.0064 = 0.002  ≪ 1/6) ✅
  6. Évaporation  : seulement sur les cellules de surface (liste maintenue), β_stage
  7. Marquer les chunks dont w a changé de plus de 4/255 → remesh couleur (pas géométrie)
```

**Coût total mesuré attendu** : 786 k cellules, ~25 ops/cellule pour les 4 passes
= 20 M ops toutes les 100 ms → **~5–8 ms tous les 6 frames**, soit **~1 ms/frame amorti**.
À faire dans le Web Worker de physique.

---

# PARTIE 4 — COUPLAGE EAU/SABLE ET ÉROSION

## 4.1 Le modèle « pipe » shallow water (Mei, Decaudin & Hu, PG 2007)

Grille 2D régulière alignée sur les colonnes voxel. État par cellule :

| Champ | Type | Sens |
|---|---|---|
| $b$ | Float32 | altitude du terrain (dérivée du champ voxel, cache) |
| $d$ | Float32 | hauteur d'eau |
| $s$ | Float32 | sédiment en suspension (concentration × hauteur) |
| $f^{L},f^{R},f^{T},f^{B}$ | Float32 ×4 | flux sortants dans les 4 tuyaux [m³/s] |
| $(u,v)$ | Float32 ×2 | vitesse déduite [m/s] |

### Étape 1 — Sources (pluie, vague, joueur)
$$d_1(x,y) = d(x,y,t) + \Delta t\cdot r_t(x,y)$$

### Étape 2 — Mise à jour des flux
$$\Delta h^{L}(x,y,t) = b(x,y)+d_1(x,y) - b(x-1,y) - d_1(x-1,y)$$
$$\boxed{f^{L}(x,y,t+\Delta t) = \max\!\left(0,\ f^{L}(x,y,t)\cdot \lambda + \Delta t\cdot A\cdot \frac{g\cdot \Delta h^{L}}{l}\right)}$$

idem pour R, T, B. $A$ = section du tuyau, $l$ = longueur du tuyau, $\lambda$ = amortissement.

### Étape 3 — Facteur d'échelle (garantit $d \ge 0$)
$$K = \min\!\left(1,\ \frac{d_1\cdot l_x\cdot l_y}{(f^L+f^R+f^T+f^B)\,\Delta t}\right), \qquad f^{i} \mathrel{{\times}{=}} K$$

**C'est cette étape qui rend le schéma inconditionnellement positif.** Sans elle, ça explose.

### Étape 4 — Mise à jour de la hauteur d'eau
$$\Delta V = \Delta t\left(\sum f_{in} - \sum f_{out}\right), \qquad d_2 = d_1 + \frac{\Delta V}{l_x\,l_y}$$

$\sum f_{in} = f^{R}_{(x-1,y)} + f^{L}_{(x+1,y)} + f^{T}_{(x,y-1)} + f^{B}_{(x,y+1)}$

### Étape 5 — Champ de vitesse
$$\Delta W_x = \frac{f^{R}_{(x-1,y)} - f^{L}_{(x,y)} + f^{R}_{(x,y)} - f^{L}_{(x+1,y)}}{2}$$
$$u = \frac{\Delta W_x}{l_y\cdot \bar d}, \qquad \bar d = \frac{d_1+d_2}{2}$$

⚠️ **Piège classique** : diviser par $\bar d$ quand $\bar d \to 0$ produit des vitesses
infinies au bord de l'eau (exactement là où on veut éroder !). Clamper :
$\bar d \leftarrow \max(\bar d, d_{min})$ avec $d_{min} = 0.5$ cm, **et** clamper
$|v| \le 6$ m/s.

### Étape 6 — Évaporation
$$d(x,y,t+\Delta t) = d_2(x,y)\cdot(1 - K_e\,\Delta t)$$

### Constantes recommandées

| Const. | Symbole | Valeur Mei et al. | **Valeur Sandcastle** | Note |
|---|---|---|---|---|
| Section du tuyau | $A$ | 1.0 (grille unitaire) | $h^2 = 1.6\times10^{-3}$ m² | = `PIPE_AREA` ✅ |
| Longueur du tuyau | $l$ | 1.0 | $h = 0.04$ m | = `PIPE_LENGTH` ✅ |
| Gravité | $g$ | 9.81 | 9.81 | |
| Amortissement | $\lambda$ | (absent) | **0.985** | tue les ondes stationnaires parasites |
| Pas de temps | $\Delta t$ | 0.02 s | **0.0083 s** (2 sous-pas / frame) | voir CFL ci-dessous |
| Capacité | $K_c$ | 1.0 | **0.9** | ✅ `EROSION_CAPACITY` |
| Dissolution | $K_s$ | 0.5 | **0.35** | ✅ |
| Déposition | $K_d$ | 1.0 | **0.45** | ✅ |
| Évaporation | $K_e$ | 0.015 | **0.012** | ✅ |
| Pluie | $K_r$ | 0.0012 | 0 (pas de pluie) | |
| Pente min | — | — | **0.06** | évite $C=0$ sur plat ✅ |
| Seuil sec | — | — | $1.5$ mm | ✅ `WATER_EPSILON` |

### Stabilité (CFL)

Le facteur $K$ garantit la positivité, mais pas l'absence d'oscillations. La condition
de type CFL pour les ondes de gravité :

$$\boxed{\Delta t \le \frac{l}{\sqrt{2\,g\,d_{max}}}} \quad\text{et}\quad \Delta t \le \frac{l\cdot l_x\, l_y}{A\cdot \sqrt{g\,l\,d_{max}}}$$

Pour $l = 0.04$ m, $d_{max} = 0.5$ m : $\Delta t \le 0.04/\sqrt{9.81} = 0.0128$ s.
→ **Un pas de 1/60 s (0.0167) est déjà trop long.** Faire **2 sous-pas de 0.0083 s**
par frame, ou une grille d'eau 2× plus grossière (8 cm → $\Delta t \le 0.026$ s, 1 pas suffit).

> **Recommandation** : grille d'eau à la **même résolution que les voxels** (4 cm, 256×256 =
> 65 536 cellules) avec **2 sous-pas**, exécutée sur **GPU en fragment shader ping-pong**
> (voir §5.4). Sur CPU JS, 65 k cellules × 2 sous-pas × ~40 ops = 5 M ops/frame ≈ 3–5 ms —
> faisable mais ça mange la moitié du budget.

## 4.2 Érosion hydraulique

### Capacité de transport
$$\boxed{C = K_c\cdot\sin\alpha\cdot|\vec v|\cdot l_{max}(d)}$$

- $\alpha$ = angle local du terrain : $\sin\alpha = \dfrac{|\nabla b|}{\sqrt{1+|\nabla b|^2}}$,
  avec $\nabla b$ estimé par différences centrées sur $b$.
- $\sin\alpha \leftarrow \max(\sin\alpha, 0.06)$ (`EROSION_MIN_SLOPE`) — sinon aucun
  transport sur une plage plate, et une plage EST plate.
- $l_{max}(d)$ — **le terme clé ajouté par Mei et al.** : atténue l'érosion sous une
  lame d'eau profonde (physiquement : la contrainte au fond ne dépend pas de la profondeur
  pour un écoulement lent) :
$$l_{max}(d) = \begin{cases} 0 & d \le 0 \\ d/d_{max} & 0 < d < d_{max} \\ 1 & d \ge d_{max}\end{cases} \qquad d_{max} = 0.06\ \text{m}$$
  Sans ce terme, le fond de mer se creuse indéfiniment. **Ne pas l'oublier.**

### Érosion / déposition
$$\text{si } C > s:\quad b \mathrel{-}= R_s\,K_s(C-s),\quad s_1 = s + R_s\,K_s(C-s)$$
$$\text{si } C \le s:\quad b \mathrel{+}= K_d(s-C),\quad s_1 = s - K_d(s-C)$$

où $R_s\in[0,1]$ est le **facteur de résistance à l'érosion**, notre point de couplage
avec la cohésion (voir §4.4). Pour de la roche : $R_s = 0.02$. Pour du sable sec : 1.0.

### Advection du sédiment (semi-lagrangienne)
$$s(x,y,t+\Delta t) = s_1\big(x - u\,\Delta t,\ y - v\,\Delta t\big)$$

Interpolation bilinéaire, avec clamp aux bords. Non conservative — corriger en
redistribuant l'erreur globale de masse de sédiment une fois par frame :
`s *= (massBefore / massAfter)`.

### Retour vers le champ voxel
$b$ est une altitude continue. Pour l'appliquer au champ voxel :
```
Δb = b_new - b_old                            [m]
Δρ = Δb / VOXEL * 255                         [unités de densité, signé]
appliquer Δρ à la colonne, en partant du voxel de surface, en débordant
sur les voxels adjacents si |Δρ| > reste disponible.
marquer la colonne dirty (avalanche + remesh)
```

## 4.3 Contrainte de cisaillement et seuil de Shields

Plutôt que (ou en plus de) la formule empirique de Mei, on peut utiliser une entrée
**physique** du seuil d'entraînement — indispensable pour un rendu correct du ressac.

**Contrainte au fond** (loi quadratique) :
$$\tau_b = \rho_w\, C_f\,|\vec v|^2, \qquad C_f \approx 0.004\text{–}0.01 \ (\text{prendre } 0.006)$$
ou via Manning : $\tau_b = \rho_w\,g\,n_M^2\,|\vec v|^2 / d^{1/3}$, $n_M = 0.02$ s/m^{1/3}.

**Paramètre de Shields et seuil critique (Soulsby–Whitehouse)** :
$$D_* = d\left[\frac{(s_g-1)g}{\nu^2}\right]^{1/3}, \quad s_g = \frac{\rho_s}{\rho_w}=2.65$$
$$\theta_{cr} = \frac{0.30}{1+1.2\,D_*} + 0.055\left[1-e^{-0.020\,D_*}\right]$$
$$\tau_{cr} = \theta_{cr}\,(\rho_s-\rho_w)\,g\,d$$

**Valeurs calculées :**

| $d$ [mm] | $D_*$ | $\theta_{cr}$ | $\tau_{cr}$ [Pa] | $v_{cr}$ [m/s] ($C_f$=0.006) |
|---|---|---|---|---|
| 0.10 | 2.53 | 0.0759 | 0.123 | 0.143 |
| **0.25** | **6.32** | **0.0415** | **0.168** | **0.167** |
| 0.50 | 12.6 | 0.0257 | 0.208 | 0.186 |
| 1.00 | 25.3 | 0.0173 | 0.280 | 0.216 |
| 2.00 | 50.5 | 0.0140 | 0.454 | 0.275 |

→ Pour du sable de plage, **le seuil est atteint dès ~17 cm/s**. Le ressac (0.5–2 m/s)
le dépasse d'un facteur 3–12. ✅ Réaliste : le ressac érode massivement.

**Formule de transport (Meyer-Peter & Müller)**, alternative à $C = K_c\sin\alpha|v|$
si on veut du physique :
$$q_b = 8\,(\theta-\theta_{cr})^{3/2}\sqrt{(s_g-1)g\,d^3} \qquad [\text{m}^2/\text{s}]$$

Recommandation pratique : **garder la formule de Mei pour la capacité** (bien calibrée
visuellement, pas chère) et **utiliser Shields uniquement comme porte tout-ou-rien** :

$$C_{eff} = C \cdot \mathbf{1}\!\left[\tau_b > \tau_{cr}(w)\right] \cdot \min\!\left(1, \frac{\tau_b - \tau_{cr}}{\tau_{cr}}\right)$$

## 4.4 Effet de la cohésion humide sur le seuil d'érosion

Un sédiment cohésif résiste bien plus. Formulation adimensionnée cohérente :

$$\boxed{\tau_{cr}(w) = \tau_{cr,0}\cdot\Big[1 + K_{coh}\cdot\frac{c(w)}{(\rho_s-\rho_w)g\,d}\Big]}$$

Le dénominateur $(\rho_s-\rho_w)g\,d = 1650\times9.81\times2.5\times10^{-4} = 4.05$ Pa.

| $w$ | $c(w)$ [Pa] | $c/4.05$ | $\tau_{cr}$ avec $K_{coh}=0.02$ | Facteur |
|---|---|---|---|---|
| 0 (sec) | 0 | 0 | 0.168 Pa | ×1.0 |
| 0.05 | 1946 | 481 | 1.79 Pa | ×10.6 |
| 0.15 | 2377 | 587 | 2.14 Pa | ×12.7 |
| 0.50 | 1608 | 397 | 1.50 Pa | ×8.9 |
| 1.0 (saturé) | 0 | 0 | 0.168 Pa | ×1.0 |

$K_{coh} \in [0.01, 0.05]$ ; **0.02 recommandé**. Interprétation gameplay :
**un château bien humide résiste ~10× mieux à la vague qu'un tas de sable sec.**
Mais dès que la vague le sature ($w\to1$), la protection disparaît → il fond.
Excellente boucle de gameplay, et physiquement juste.

Équivalent en facteur de résistance dans la formule de Mei :
$$R_s(w) = \frac{1}{1 + K_{coh}\,c(w)/[(\rho_s-\rho_w)g\,d]} \in [0.08, 1]$$

## 4.5 Sapement (undercutting) par le ressac

C'est LE mécanisme qui produit les micro-falaises verticales (« beach scarps ») et les
effondrements de château spectaculaires. Modèle en 4 étapes :

### (a) Bande de sape
L'érosion par le swash n'est pas uniforme sur la colonne : elle est concentrée dans une
bande autour de la **ligne d'eau instantanée** $y_w = b + d$. Pondération :

$$\eta(y) = \exp\!\left[-\frac{(y-y_w)^2}{2\sigma_w^2}\right], \qquad \sigma_w = 1.5\,h = 6\ \text{cm}$$

Appliquer l'érosion voxel avec ce poids sur les 4 voxels autour de $y_w$, **au lieu
d'abaisser uniquement le sommet de la colonne**. C'est ce qui creuse une **encoche**.

### (b) Asymétrie swash / backwash
- **Swash (jet de rive, montant)** : vitesse forte (0.8–2.5 m/s), courte (1–2 s),
  transporte le sédiment vers le haut de plage. Infiltration importante ⇒ perte de volume
  d'eau ⇒ **dépôt** en haut de swash.
- **Backwash (retrait)** : vitesse plus faible mais durée plus longue, **écoulement
  concentré et laminaire au ras du sol** ⇒ contrainte de cisaillement élevée ⇒ **érosion**
  et transport vers le large.

Implémentation : multiplier $K_s$ (dissolution) par $1.0$ pendant le backwash
($\vec v\cdot\vec n_{shore} < 0$) et par $0.45$ pendant le swash ; multiplier $K_d$
(déposition) par l'inverse. Un simple test de signe sur $u$ projeté.

### (c) Détection de la falaise et déclenchement
```
pour chaque colonne au contact de l'eau :
    notch = freeHeight[x][z]                       // hauteur de façade libre (§2.5)
    overhang = sup[voxel sommet]                   // porte-à-faux au-dessus de l'encoche
    si overhang > N_max(w) OU notch*VOXEL > H_c(90°, c(w)) :
        déclencher la rupture (breakTimer = 45 frames), θ_max -> φ progressivement
```

### (d) Effondrement en bloc
Le sapement produit des ruptures **en bloc** (slumping), pas un écoulement grain à grain.
Pour le rendre : pendant la phase de basculement, autoriser le transfert vertical
sur **toute la hauteur de la façade en une seule passe** (`maxTransfer = 255`,
`DAMPING = 0.9` localement), puis revenir au régime normal. Visuellement : un pan entier
tombe d'un coup dans l'eau, gerbe d'éclaboussures, nuage de sédiment en suspension.
Ajouter un pic de $s$ (sédiment) proportionnel au volume tombé → l'eau devient trouble
pendant 3–5 s.

## 4.6 Marée et vagues (générateur d'événements)

```
niveau de mer :  y_sea(t) = SEA_LEVEL + TIDE_AMPLITUDE * sin(2π t / TIDE_PERIOD)
train de vagues : à intervalle T_wave ∈ [4, 9] s, injecter une source linéaire
                  au bord large :  d += A_wave * exp(-((z-z0)/L)²)
                  A_wave ∈ [0.04, 0.25] m selon l'état de mer (0..1)
                  + impulsion de flux f^T += ρ * A_wave * c_wave,  c_wave = sqrt(g*d)
```

Cela suffit : le modèle pipe fait naturellement déferler la vague sur la pente
(shoaling par conservation d'énergie) et produit swash + backwash. Pas besoin d'un
solveur de vagues séparé.

---

# PARTIE 5 — PERFORMANCE ET ARCHITECTURE

## 5.1 Dimensionnement

Le projet utilise `VOXEL = 0.04`, `NX/NY/NZ = 256/96/256`, `CHUNK = 32` :

| Grandeur | Valeur |
|---|---|
| Domaine | 10.24 × 3.84 × 10.24 m |
| Voxels totaux | 256×96×256 = **6 291 456** |
| Chunks | 8 × 3 × 8 = **192** |
| Voxels par chunk | 32³ = 32 768 |
| Colonnes (grille 2D) | 65 536 |
| Grille humidité (2×) | 128×48×128 = 786 432 |
| Grille eau (2D) | 256×256 = 65 536 |

**Empreinte mémoire :**

| Champ | Type | Taille dense | Sparse (~35 % alloués) |
|---|---|---|---|
| `density` | Uint8 | 6.0 MB | **2.1 MB** |
| `material` | Uint8 (4 bits suffiraient) | 6.0 MB | 2.1 MB |
| `support` | Uint8 | 6.0 MB | 2.1 MB |
| `moisture` (grille 2×) | Uint8 | 0.75 MB | 0.75 MB |
| `compaction` $D_r$ | Uint8 (ou 4 bits packés avec material) | 6.0 MB | 2.1 MB |
| `inActive` bitset | Uint8/8 | 0.75 MB | 0.75 MB |
| Eau (b,d,s,f×4,u,v) | Float32 ×9 | 2.4 MB | 2.4 MB |
| `freeHeight`, `surfaceY` | Uint8/Uint16 | 0.2 MB | 0.2 MB |
| Meshes GPU (192 chunks) | pos+nrm+col interleaved | ~15–40 MB | ~15–40 MB |
| **Total RAM** | | ~28 MB | **~13 MB** |

→ Très confortable. On peut même passer à `VOXEL = 0.03` (341³ ≈ 12 M voxels) si le CPU suit.
**Le facteur limitant n'est pas la mémoire, c'est le nombre de voxels touchés par frame.**

## 5.2 Structures de données

### Chunk creux
```js
class Chunk {
  density   : Uint8Array(32768) | null   // null = chunk 100% air (ou 100% plein)
  material  : Uint8Array(32768) | null
  support   : Uint8Array(32768) | null
  uniform   : 0 | 255 | -1               // -1 = non uniforme ; sinon densité constante
  solidCount: int                        // pour détecter le retour à l'uniformité
  dirtyMesh : bool
  dirtyMask : Uint8Array(64)             // 1 bit par sous-bloc 8³ (4x4x4=64)
  aabbDirty : {x0,y0,z0,x1,y1,z1}        // boîte englobante des modifs de cette frame
  version   : int
}
```

- **Allocation paresseuse** : un chunk n'alloue ses `Uint8Array` qu'à la première écriture
  non uniforme. Les chunks d'air pur ne coûtent rien.
- **Désallocation** : si `solidCount == 0` ou `== 32768` pendant 120 frames, libérer et
  repasser en `uniform`. Important pour les 2/3 supérieurs du domaine (ciel).
- **Indexation** : `Map<int, Chunk>` avec clé `cx | (cy<<5) | (cz<<10)`, ou plus simple et
  plus rapide ici : un `Array(192)` plat car le domaine est fixe et petit. **Pas d'octree
  ni de hash spatial : 192 chunks tiennent dans un tableau plat, un octree serait plus lent.**
- **Palettes** : la technique Teardown (1 octet par voxel indexant une palette de 256
  matériaux avec couleur + roughness + type physique) est parfaite ici. On n'a besoin
  que de ~8 matériaux (air, sable, sable tassé, roche, coquillage, eau, algue, bois flotté)
  → `material` sur 3 bits, packable avec $D_r$ sur 4 bits + 1 bit de flag dans un seul Uint8.

### Dirty tracking à deux niveaux
1. **Niveau voxel** : l'active set (§2.3.4) pour la physique.
2. **Niveau sous-bloc 8³** : `dirtyMask` (64 bits par chunk) pour le maillage.
   Le mailleur ne remaille que les sous-blocs sales → sur une modification ponctuelle
   au pinceau, on remaille 1–8 sous-blocs (512–4096 voxels) au lieu de 32 768. **×8 à ×60.**
   *(Nécessite un mesh par chunk découpé en sous-plages d'index, ou plus simple : accumuler
   les sous-blocs sales et remailler le chunk entier si > 12 sous-blocs sont sales, sinon
   remailler chirurgicalement.)*

Note : dans la pratique, **la solution la plus simple qui marche** est de remailler
le chunk 32³ entier (1–3 ms) et de limiter à `BUDGET_REMESH = 6` chunks/frame.
Ne passer au niveau sous-bloc que si le profilage le réclame.

## 5.3 Répartition des tâches

| Tâche | Où | Fréquence | Budget cible |
|---|---|---|---|
| Input, caméra, UI, outils | **Main thread** | 60 Hz | 0.5 ms |
| Raycast sur voxels (DDA) | **Main thread** | par clic / hover | 0.1 ms |
| Avalanche + support + Culmann | **Worker « physics »** | 60 Hz | 3–5 ms |
| Humidité (diffusion, percolation, évaporation) | **Worker « physics »** | 10 Hz | 1 ms amorti |
| Shallow water + érosion | **GPU (WebGL2 ping-pong)** ou worker | 60 Hz (2 sous-pas) | 0.3 ms GPU / 4 ms CPU |
| Surface Nets | **Workers « mesh » × 3–5** | à la demande | 6 chunks/frame |
| Upload des BufferGeometry | **Main thread** | à la demande | 0.5 ms |
| Rendu Three.js | **Main thread + GPU** | 60 Hz | 4–8 ms |
| Particules (sable volant, poussière) | **GPU (transform feedback / points)** | 60 Hz | 0.2 ms |

**Communication** :
- `SharedArrayBuffer` pour `density`, `material`, `moisture`, `support`.
  ⚠️ Nécessite les en-têtes **COOP/COEP** (`Cross-Origin-Opener-Policy: same-origin`,
  `Cross-Origin-Embedder-Policy: require-corp`). En dev Vite :
  ```js
  server: { headers: {
    'Cross-Origin-Opener-Policy': 'same-origin',
    'Cross-Origin-Embedder-Policy': 'require-corp' } }
  ```
- **Fallback sans SAB** : double-buffering avec `ArrayBuffer` transférables
  (`postMessage(buf, [buf])` = coût nul, mais le main thread perd l'accès). Faisable,
  plus contraignant. Prévoir le fallback dès le début.
- `Atomics.store/load` uniquement pour les compteurs de synchronisation
  (`Atomics.wait`/`notify` pour le rendez-vous worker↔main). Ne **pas** faire d'atomics
  sur les données voxel : le worker physique est seul écrivain.
- Les workers de maillage ne font que **lire** `density`/`moisture` et renvoient des
  `Float32Array` transférables (positions, normales, couleurs) + `Uint32Array` (indices).

**Anti-tearing** : le worker physique publie un `version` atomique après chaque pas.
Les mailleurs capturent `version`, lisent, et si `version` a changé pendant la lecture,
ils rejettent et refont. En pratique, la fenêtre est si petite (< 1 ms) que le simple
fait de mailler des chunks non touchés par la frame courante suffit.

## 5.4 GPU : WebGL2 vs WebGPU

**État 2026** : WebGPU est disponible dans Chrome/Edge/Opera (113+) et Safari 26+ ;
Firefox reste désactivé par défaut. WebGL2 est universel (~98 %).

**Recommandation : WebGL2 comme socle, WebGPU en accélération optionnelle.**

| Ce qui passe très bien en WebGL2 (fragment shader ping-pong) | Ce qui NE passe pas |
|---|---|
| Shallow water pipe model (grille 2D, RGBA32F ×2 textures) ✅ | Automate d'avalanche 3D creux (branchy, scatter, active set) ❌ |
| Érosion / sédiment 2D ✅ | Surface Nets (génération de géométrie variable) ❌ |
| Diffusion d'humidité (texture 3D en atlas 2D, ou 128 slices) ✅ | BFS de support (dépendances longue portée) ❌ |
| Particules de sable/poussière (transform feedback) ✅ | |
| Érosion thermique 2D ✅ | |

**Layout des textures pour l'eau (WebGL2)** :
```
texA : RGBA32F  ->  (b, d, s, unused)      // terrain, eau, sédiment
texB : RGBA32F  ->  (fL, fR, fT, fB)       // flux
texC : RG32F    ->  (u, v)                 // vitesse
Passes :   1) flux (lit A,B -> écrit B')   2) hauteur+vitesse (lit A,B' -> écrit A',C)
           3) érosion (lit A',C -> écrit A'')  4) advection semi-lagrangienne (A'' -> A''')
```
4 passes de 256×256 = 262 k invocations de fragment → **< 0.2 ms** sur n'importe quel GPU
intégré moderne. C'est 20× moins cher que le CPU.

**Lecture GPU→CPU** : le champ voxel a besoin de $\Delta b$ pour appliquer l'érosion.
`readPixels` synchrone = stall de 2–5 ms ❌. Utiliser **`PIXEL_PACK_BUFFER` + `fenceSync`
asynchrone** avec 2 frames de latence : on lit le $\Delta b$ de la frame N-2.
Invisible visuellement.
*Alternative plus simple pour la v1 : faire l'eau sur le CPU dans le worker physique
(4 ms), et migrer sur GPU plus tard.*

**Si WebGPU est disponible** : un compute shader pour l'avalanche devient envisageable
(damier 4 couleurs = 4 dispatches, atomics sur `atomicAdd` de la densité packée). Gain
potentiel ×20. Mais c'est un chemin de code entièrement séparé — **phase 3 au plus tôt**.

## 5.5 Maillage : Surface Nets

### Choix

| Algorithme | Triangles | Qualité normales | Arêtes vives | Coût JS (32³) | Seams |
|---|---|---|---|---|---|
| Marching Cubes | ~1.4× | bonnes (gradient) | non | 2–4 ms | faciles (apron) |
| **Naive Surface Nets** | **1.0×** | **excellentes (gradient)** | non | **0.8–2 ms** | **faciles (apron)** |
| Dual Contouring (QEF) | 1.0× | excellentes | **oui** | 4–10 ms | complexes (LOD) |
| Transvoxel | ~1.5× | bonnes | non | 3–6 ms | conçu pour LOD |

→ **Naive Surface Nets.** Le sable n'a **aucune** arête vive : le QEF de Dual Contouring
serait du coût pur perdu, et ses instabilités numériques (vertex qui sort de sa cellule)
sont un cauchemar à déboguer. Surface Nets produit ~30 % de triangles en moins que
Marching Cubes, un maillage quad-dominant régulier idéal pour la déformation continue,
et tourne 2× plus vite. (Référence : ~20 M triangles/s en Rust monocœur ; en JS
avec des typed arrays, compter 3–6 M tri/s.)

### Pseudo-code de la variante retenue

```
SurfaceNets(chunk cx,cy,cz) :

  N = 32 ; iso = 128
  # 1. Échantillonner un champ (N+1)³ = 33³ = 35937 valeurs, avec APRON
  #    Les valeurs du bord viennent des chunks VOISINS -> pas de seam possible.
  field = Float32Array(33*33*33)
  pour (i,j,k) dans [0..32]³ :
      field[...] = sampleDensityGlobal(cx*32+i, cy*32+j, cz*32+k)   # lit à travers les chunks

  # 2. Pour chaque cellule 2x2x2 (32³ cellules), placer AU PLUS un vertex
  vertexIndex = Int32Array(33*33*33).fill(-1)
  positions = [] ; normals = [] ; colors = []

  pour (i,j,k) dans [0..31]³ :
      # masque des 8 coins
      mask = 0
      pour c dans 0..7 : si field[corner(c)] >= iso : mask |= (1<<c)
      si mask == 0 ou mask == 255 : continuer        # cellule entièrement dedans/dehors

      # 3. Position du vertex = moyenne des intersections sur les 12 arêtes
      sum = (0,0,0) ; count = 0
      pour chaque arête (a,b) des 12 :
          va = field[a] ; vb = field[b]
          si (va >= iso) != (vb >= iso) :
              t = (iso - va) / (vb - va)             # interpolation linéaire
              sum += lerp(cornerPos[a], cornerPos[b], t)
              count++
      p = sum / count
      # (variante « surface nets lissés » : 2 itérations de relaxation vers la moyenne
      #  des voisins, en re-clampant p dans la cellule -> surface plus douce, +0.3 ms)

      vertexIndex[i,j,k] = positions.length/3
      positions.push(origin + (i,j,k)*h + p*h)

      # 4. NORMALE par gradient central du champ CONTINU (pas des faces !)
      #    -> C1 aux seams car le champ est partagé, et pas de facettes.
      g = ( sampleTrilinear(x+ε) - sampleTrilinear(x-ε),  ... ) / (2ε)
      normals.push( normalize(-g) )

      # 5. Couleur / attributs : humidité trilerp + compaction + matériau
      colors.push( packSandColor(moistureTrilerp(x), Dr, material) )

  # 6. Quads : pour chaque arête du réseau dual dont les extrémités changent de signe,
  #    émettre le quad formé par les 4 cellules qui la partagent.
  pour (i,j,k) dans [1..31]³ :
      pour axe dans {x,y,z} :
          s0 = field[i,j,k] >= iso ; s1 = field[i,j,k + e_axe] >= iso
          si s0 == s1 : continuer
          # les 4 cellules adjacentes à cette arête
          v0,v1,v2,v3 = vertexIndex des 4 cellules  (ordre selon l'axe)
          si s0 : emit(v0,v1,v2) ; emit(v0,v2,v3)
          sinon  : emit(v0,v2,v1) ; emit(v0,v3,v2)   # winding inversé

  retourner {positions: Float32Array, normals: Float32Array,
             colors: Uint8Array, indices: Uint32Array}
```

### Gestion des seams — la règle d'or

> **Ne jamais mailler un chunk avec ses seules données.** Toujours échantillonner un
> apron de +1 voxel dans chaque direction positive (grille 33³ pour un chunk 32³).

Conséquence : deux chunks voisins calculent **exactement les mêmes** valeurs de champ sur
leur frontière commune → **exactement les mêmes** positions et normales de vertex →
soudure parfaite, aucun crack, aucune couture visible sur l'éclairage. Le coût est de
$(33/32)^3 = 1.10$, soit +10 %. C'est le meilleur rapport qualité/prix de tout le pipeline.

⚠️ **Corollaire** : modifier un voxel sur la face d'un chunk salit **aussi** le ou les
chunks voisins. Le `markDirty(x,y,z)` doit propager :
```js
if (lx === 0)      markChunkDirty(cx-1, cy, cz);
if (lx === 31)     markChunkDirty(cx+1, cy, cz);   // idem y, z, et les coins
```

### Normales
- **Toujours par gradient du champ scalaire**, jamais par moyenne des normales de faces.
  Le gradient est continu à travers les seams et donne un rendu lisse gratuit.
- Le gradient au vertex se calcule par différences centrées **trilinéairement
  interpolées** à la position exacte du vertex (pas au centre de la cellule) : ça
  supprime le « quadrillage » visible sur les surfaces presque planes.
- Coût : 6 échantillons trilinéaires par vertex ≈ 48 lectures. Sur ~4 000 vertices par
  chunk : 190 k lectures ≈ 0.3 ms. Acceptable.
- Alternative moins chère (−0.25 ms, qualité 90 %) : gradient central sur la grille
  entière précalculé dans 3 `Int8Array` de 33³, puis trilerp. Recommandé si le profil serre.

## 5.6 Budgets chiffrés (cible 60 fps = 16.6 ms)

### Coûts unitaires mesurables en JS (V8, typed arrays, sans allocation)

| Opération | Coût |
|---|---|
| Lecture/écriture `Uint8Array` indexée | 1–2 ns |
| Test de stabilité d'une paire (LUT + compare) | 8–15 ns |
| Test complet d'un voxel (4 voisins + réveils) | 40–70 ns |
| Une cellule de diffusion 7 points | 15–25 ns |
| Une cellule shallow-water (4 flux + hauteur + vitesse) | 60–90 ns |
| Un vertex Surface Nets (12 arêtes + gradient) | 250–400 ns |
| BFS de support, un voxel | 20–35 ns |

### Répartition cible

| Poste | Frame calme | Frame « effondrement » | Frame « vague » |
|---|---|---|---|
| Avalanche (worker) | 0.1 ms (500 actifs) | 2.5 ms (40 k) | 4.5 ms (80 k) |
| Support BFS (worker) | 0.05 ms | 1.0 ms (30 k) | 1.4 ms (40 k) |
| Humidité (worker, amorti) | 0.8 ms | 0.8 ms | 0.8 ms |
| Shallow water (GPU) | 0.15 ms | 0.15 ms | 0.25 ms |
| Maillage (workers ×4) | 0 | 4 × 1.5 ms parallèle | 4 × 1.8 ms |
| Upload géométrie (main) | 0 | 0.4 ms (6 chunks) | 0.5 ms |
| Rendu Three.js (main) | 3.5 ms | 4.0 ms | 5.5 ms |
| **Main thread total** | **~4 ms** | **~5 ms** | **~6.5 ms** |
| **Worker physique total** | **~1 ms** | **~4.3 ms** | **~6.7 ms** |

→ **Marge confortable.** Le worker physique et le main thread tournent en parallèle ;
le budget critique est celui du **main thread** (rendu + upload), qui reste sous 7 ms.

### Chiffres à retenir

- **Voxels actifs testables à 60 fps en JS dans un worker : 60 000 – 120 000/frame**
  (en visant 4–6 ms). `BUDGET_GRANULAR = 90 000` dans `Config.js` : ✅ bien calibré,
  légèrement optimiste — mesurer et ajuster à 60 k si le worker déborde.
- **Chunks remaillés : 4–8 par frame** avec 4 workers. `BUDGET_REMESH = 6` : ✅
- **Triangles à l'écran** : un domaine de 10×10 m à 4 cm produit une surface de
  ~250×250 quads ≈ **125 k triangles** pour le terrain plat, jusqu'à 400 k avec des
  sculptures détaillées. Sans problème pour un GPU intégré (target : < 800 k).
- **Draw calls** : 192 chunks = 192 draw calls. À réduire :
  merger les chunks non modifiés depuis 5 s en super-meshes de 2×2×2 chunks
  (→ 24 draw calls) et les re-séparer à la première modification.

### Stratégies de LOD

Pour un domaine de 10 m entièrement à portée de main, le LOD géométrique est **peu utile**.
Ce qui est utile :

1. **LOD de simulation (le vrai gain)** :
   - Chunks à > 6 m de la caméra ET sans modification depuis 3 s : la passe d'avalanche
     est exécutée 1 frame sur 4.
   - Chunks entièrement submergés ou entièrement enterrés : avalanche désactivée
     (aucune surface libre).
2. **LOD de maillage** : chunks à > 8 m maillés à `stride = 2` (grille 17³ au lieu de 33³) →
   ×8 moins de vertices. Transition gérée par un **skirt** (jupe verticale de 1 voxel au
   bord du chunk) plutôt que par du stitching : c'est 30 lignes de code au lieu de 500,
   et c'est invisible sur du sable.
3. **Terrain lointain** : au-delà du domaine sculptable, un simple heightfield statique
   (`PlaneGeometry` déformée) pour la plage et les dunes. 0 coût de simulation.
4. **LOD d'humidité** : la grille est déjà 2× plus grossière. Passer à 4× pour les zones
   loin de la caméra n'apporte presque rien (la grille entière ne coûte que 0.8 ms).

---

# PARTIE 6 — PSEUDO-CODE PRÊT À IMPLÉMENTER

## 6.1 `theta_max(w)` et `cohesion(w)`

```js
// --- Constantes (à mettre dans Config.js) --------------------------------
export const PHI_DEG      = 34.0;   // angle de frottement interne
export const THETA_PEAK   = 89.0;   // plafond de l'angle de stabilité
export const W_RISE       = 0.030;  // échelle de montée capillaire
export const W_DROWN_LO   = 0.25;   // début de la noyade
export const W_DROWN_HI   = 0.90;   // cohésion nulle
export const W_LIQ        = 0.75;   // début de la liquéfaction du frottement
export const KAPPA_LIQ    = 0.55;   // perte de frottement à saturation
export const COHESION_MAX = 2400;   // Pa, sable tassé Dr = 0.6
export const RHO_B_G      = 1640 * 9.81; // 16 088 N/m3

/** Facteur de cohésion normalisé f_coh(w) ∈ [0,1]. Montée capillaire × noyade. */
export function cohesionFactor(w) {
  const rise  = 1 - Math.exp(-w / W_RISE);
  const drown = 1 - smoothstep(W_DROWN_LO, W_DROWN_HI, w);
  return rise * drown;
}

/** Facteur de compaction Γ(Dr) ∈ [0.46, 1.35]. Dr ∈ [0,1]. */
export function compactionFactor(Dr) {
  const n  = 0.46 - 0.13 * Dr;          // porosité 0.46 -> 0.33
  const kc = 4 + 6 * Dr;                // coordination 4 -> 10
  return ((1 - n) * kc) / (0.62 * 7.6); // normalisé à Dr = 0.6
}

/** Cohésion apparente en Pa. */
export function cohesion(w, Dr = 0.6) {
  return COHESION_MAX * cohesionFactor(w) * compactionFactor(Dr);
}

/** Angle de frottement effectif (perd du frottement quand ça se liquéfie). */
export function phiEff(w, Dr = 0.6) {
  const phi0 = 31 + 10 * Dr;            // 31° lâche -> 41° tassé
  return phi0 * (1 - KAPPA_LIQ * smoothstep(W_LIQ, 1.0, w));
}

/** Angle de stabilité maximal, en DEGRÉS. Courbe empirique §1.6.4. */
export function thetaMaxDeg(w, Dr = 0.6) {
  const res = phiEff(w, Dr);
  return res + (THETA_PEAK - res) * cohesionFactor(w);
}

/** Variante physique : pente infinie avec cohésion, dépendante de l'épaisseur. */
export function thetaMaxSlope(w, zSlab, Dr = 0.6) {
  const phi  = phiEff(w, Dr) * DEG2RAD;
  const zeta = cohesion(w, Dr) / (RHO_B_G * Math.max(zSlab, 1e-3));
  const arg  = clamp(2 * zeta * Math.cos(phi) + Math.sin(phi), -1, 1);
  return 0.5 * (phi + Math.asin(arg));   // radians ; plafonne à (φ+90°)/2
}

/** Hauteur critique d'un talus de pente beta (Culmann), en mètres. */
export function culmannHc(betaRad, w, Dr = 0.6) {
  const phi = phiEff(w, Dr) * DEG2RAD;
  const den = 1 - Math.cos(betaRad - phi);
  if (den < 1e-4) return Infinity;
  return (4 * cohesion(w, Dr) / RHO_B_G) * (Math.sin(betaRad) * Math.cos(phi)) / den;
}

// --- LUT 16×16 construite une fois au démarrage ---------------------------
// tanθ_max en fonction de (w quantifié 4 bits, épaisseur de couche 0..15 voxels)
export const TAN_LUT = new Float32Array(256);
export function buildTanLUT(Dr = 0.6) {
  for (let iw = 0; iw < 16; iw++) {
    const w = (iw + 0.5) / 16;
    for (let iz = 0; iz < 16; iz++) {
      const zSlab = (iz + 1) * VOXEL;
      // on prend le MIN des deux modèles : empirique (plafonné à 89°) et pente infinie
      // enrichie de la contribution de cohésion -> comportement lisse et borné
      const tEmp   = Math.tan(Math.min(thetaMaxDeg(w, Dr), 89.5) * DEG2RAD);
      const tSlope = Math.tan(thetaMaxSlope(w, zSlab, Dr));
      TAN_LUT[iw * 16 + iz] = Math.min(tEmp, Math.max(tSlope, 0.2));
    }
  }
}
// Lecture ultra-rapide dans la boucle chaude :
//   TAN_LUT[((w8 >> 4) << 4) | (slabVox < 15 ? slabVox : 15)]
```

## 6.2 Passe d'avalanche

```js
const NB4  = [[1,0],[-1,0],[0,1],[0,-1]];
const PERM = buildPermutations24();     // 24 permutations de [0,1,2,3]

/**
 * Une passe de relaxation sur l'active set.
 * @returns nombre de voxels modifiés
 */
function avalanchePass(field, frame) {
  const { density, moisture, surfaceY, dirty } = field;
  const colorOrder = PERM[(frame * 7) & 23];   // ordre des 4 couleurs, varie par frame
  let modified = 0;

  for (let ci = 0; ci < 4; ci++) {
    const color = colorOrder[ci];

    for (let i = 0, n = dirty.count; i < n; i++) {
      const idx = dirty.list[i];
      const x = idx % NX, y = (idx / (NX * NZ)) | 0, z = ((idx / NX) | 0) % NZ;

      // damier horizontal : dans une couleur, aucun voisin latéral n'est de la même couleur
      if (((x & 1) | ((z & 1) << 1)) !== color) continue;

      let rho = density[idx];
      if (rho <= ISO) continue;                         // rien à donner

      // 1) CHUTE LIBRE : le voxel du dessous a de la place ?
      if (y > 0) {
        const below = idx - NX * NZ;
        const rb = density[below];
        if (rb < 250) {
          const amt = Math.min(rho - ISO + 1, 255 - rb, MAX_FALL); // MAX_FALL = 128
          if (amt > 0) {
            density[idx] = rho -= amt;
            density[below] = rb + amt;
            transferMoisture(moisture, idx, below, amt);
            wakeNeighbourhood(dirty, x, y, z);
            markMeshDirty(x, y, z);
            modified++;
            if (rho <= ISO) continue;
          }
        }
      }

      // 2) AVALANCHE LATÉRALE
      const w8    = moisture[midx(x, y, z)];
      const hSelf = columnHeightAt(surfaceY, x, z);      // hauteur continue, en voxels
      const nbOrd = PERM[(hash3(x, y, z) ^ frame) & 23]; // ordre des voisins randomisé

      for (let k = 0; k < 4; k++) {
        const [dx, dz] = NB4[nbOrd[k]];
        const nx = x + dx, nz = z + dz;
        if (nx < 0 || nz < 0 || nx >= NX || nz >= NZ) continue;

        const hN   = columnHeightAt(surfaceY, nx, nz);
        const dz_v = hSelf - hN;                          // en voxels
        if (dz_v <= 0) continue;

        // épaisseur de la couche mobile, plafonnée à 15 voxels
        const slab = Math.min(15, Math.max(1, dz_v | 0));
        const tanMax = TAN_LUT[((w8 >> 4) << 4) | slab];  // L = 1 voxel -> tanθ = dz_v

        // bruit corrélé pour casser les fronts plats (±3 %)
        const jitter = 1 + 0.03 * NOISE3[noiseIdx(x >> 1, y >> 1, z >> 1)] * (1 / 127);
        const excess = dz_v - tanMax * jitter;
        if (excess <= 0) continue;

        const nIdx = vidx(nx, y, nz);
        const rn   = density[nIdx];
        let amt = (DAMPING * excess * 0.5 * 255) | 0;     // DAMPING = 0.35
        if (amt < 1) amt = 1;
        if (amt > maxTransferFor(x, z)) amt = maxTransferFor(x, z);  // 48, ou 128 si breakTimer > 0
        if (amt > rho - ISO) amt = rho - ISO;
        if (amt > 255 - rn)  amt = 255 - rn;
        if (amt <= 0) continue;

        density[idx]  = rho -= amt;
        density[nIdx] = rn + amt;

        // dilatance : le sable cisaillé perd de l'humidité apparente
        transferMoisture(moisture, idx, nIdx, amt, /*dilatancy=*/0.85);

        spawnSandParticles(x, y, z, dx, dz, amt);          // seulement si amt > 24
        wakeNeighbourhood(dirty, x, y, z);
        wakeNeighbourhood(dirty, nx, y, nz);
        markMeshDirty(x, y, z); markMeshDirty(nx, y, nz);
        modified++;
        if (rho <= ISO) break;
      }
    }
    dirty.swap();     // les réveils de cette couleur entrent dans la liste suivante
  }
  return modified;
}

/** Réveille le voisinage d'un voxel modifié (6 + les 4 diagonales du plan + dessus/dessous). */
function wakeNeighbourhood(dirty, x, y, z) {
  for (let dy = -1; dy <= 2; dy++)          // +2 : le sable au-dessus doit retomber
    for (let dz = -1; dz <= 1; dz++)
      for (let dx = -1; dx <= 1; dx++) {
        const nx = x + dx, ny = y + dy, nz = z + dz;
        if (inBounds(nx, ny, nz)) dirty.push(vidx(nx, ny, nz));
      }
}
```

## 6.3 Test de support / porte-à-faux

```js
const SUP_INF = 255;
const SUP_MAX = 12;              // au-delà, tout s'effondre de toute façon

/**
 * BFS multi-source à coûts {0 (descendre), 1 (latéral), 2 (monter)}
 * sur une boîte englobante. File à seaux (dial) -> O(V), pas de tas binaire.
 */
function rebuildSupport(field, box) {
  const { density, support } = field;
  const buckets = [[], [], []];        // 3 seaux suffisent pour des coûts 0..2
  let cur = 0;

  // 1) initialisation : INF partout dans la boîte, sources = frontière valide + sol
  forEachVoxelInBox(box, (x, y, z, idx) => {
    if (density[idx] <= ISO) { support[idx] = SUP_INF; return; }
    if (y === 0 || isBedrock(field, x, y - 1, z)) {
      support[idx] = 0; buckets[0].push(idx);
    } else if (isOnBoxBorder(box, x, y, z) && support[idx] < SUP_INF) {
      buckets[Math.min(2, support[idx] % 3)].push(idx);   // valeur héritée valide
    } else {
      support[idx] = SUP_INF;
    }
  });

  // 2) propagation
  let processed = 0;
  for (let dist = 0; dist <= SUP_MAX; dist++) {
    const q = buckets[cur];
    while (q.length) {
      const idx = q.pop();
      const d = support[idx];
      if (d !== dist) continue;                       // entrée périmée
      if (++processed > BUDGET_SUPPORT) return false; // amorti sur la frame suivante

      const { x, y, z } = unpack(idx);
      // dessus : coût 0 en descendant depuis lui -> il hérite de d
      relaxTo(x, y + 1, z, d + 0, buckets, cur);
      // latéraux : coût 1
      relaxTo(x + 1, y, z, d + 1, buckets, cur);
      relaxTo(x - 1, y, z, d + 1, buckets, cur);
      relaxTo(x, y, z + 1, d + 1, buckets, cur);
      relaxTo(x, y, z - 1, d + 1, buckets, cur);
      // dessous : coût 2 (colonne suspendue sous un porte-à-faux)
      relaxTo(x, y - 1, z, d + 2, buckets, cur);
    }
    buckets[cur].length = 0;
    cur = (cur + 1) % 3;
  }
  return true;
}

/** Longueur maximale de porte-à-faux, en voxels. */
function maxOverhangVox(w, Dr, thicknessVox) {
  const c  = cohesion(w, Dr);
  const st = c / Math.tan(phiEff(w, Dr) * DEG2RAD);      // résistance à la traction
  const t  = thicknessVox * VOXEL;
  const Lshear = c / RHO_B_G;                           // cisaillement à l'encastrement
  const Lbend  = Math.sqrt(st * t / (3 * RHO_B_G));     // flexion
  const L = K_ARCH * Math.min(Lshear, Lbend);           // K_ARCH = 2.0 (gameplay)
  return Math.min(SUP_MAX, (L / VOXEL) | 0);
}

/** Test d'effondrement de porte-à-faux, appelé sur les voxels de l'active set. */
function checkOverhangCollapse(field, idx, x, y, z) {
  const s = field.support[idx];
  if (s === 0) return false;                            // posé au sol, rien à faire

  if (s >= SUP_INF) {                                   // totalement déconnecté
    triggerFreefall(field, idx);
    return true;
  }
  const w  = field.moisture[midx(x, y, z)] / 255;
  const Dr = field.compaction[idx] / 255;
  const t  = localThicknessVox(field, x, y, z);         // épaisseur verticale locale
  if (s > maxOverhangVox(w, Dr, t)) {
    triggerBreak(field, x, z, /*frames=*/45);           // baisse θ_max progressivement
    return true;
  }
  return false;
}

/** Rupture : on n'enlève JAMAIS de matière, on abaisse θ_max localement. */
function triggerBreak(field, x, z, frames) {
  field.breakTimer[cidx(x, z)] = frames;
  // pendant `frames` frames :
  //   phase = breakTimer / frames
  //   θ_max_eff = lerp(φ, θ_max(w), smoothstep(0, 0.4, 1 - phase))
  //   maxTransfer = lerp(48, 128, ...)
  // et on émet poussière + son.
}
```

## 6.4 Passe d'humidité

```js
/**
 * Grille d'humidité 2× plus grossière : MX=NX/2, MY=NY/2, MZ=NZ/2.
 * Appelée toutes les 6 frames avec dtM = 0.1 s.
 */
function moisturePass(field, dtM, env) {
  const { moisture, solidMask } = field;   // solidMask : 1 si la cellule contient du sable
  const H  = VOXEL * 2;                    // 8 cm
  const yW = field.waterTable;             // altitude de la nappe (m)

  // --- 1) NAPPE + REMONTÉE CAPILLAIRE -----------------------------------
  const kCap = 1 - Math.exp(-dtM / TAU_CAP);            // TAU_CAP = 20 s
  for (let j = 0; j < MY; j++) {
    const yWorld = ORIGIN_Y + (j + 0.5) * H;
    const above  = yWorld - yW;
    const wEq = above <= 0 ? 1.0 : W_EQ_LUT[Math.min(127, (above / 0.02) | 0)];
    for (let k = 0; k < MZ; k++)
      for (let i = 0; i < MX; i++) {
        const m = i + MX * (k + MZ * j);
        if (!solidMask[m]) continue;
        const w = moisture[m] / 255;
        if (w < wEq) moisture[m] = ((w + (wEq - w) * kCap) * 255) | 0;
      }
  }

  // --- 2) INFILTRATION depuis l'eau de surface ---------------------------
  for (let k = 0; k < MZ; k++)
    for (let i = 0; i < MX; i++) {
      const d = waterDepthAt(i * 2, k * 2);
      if (d < WATER_EPSILON) continue;
      const j = surfaceCellY(i, k);
      const m = i + MX * (k + MZ * j);
      const w = moisture[m] / 255;
      const I = Math.min(K_INFIL * (1 - w), d / dtM);   // K_INFIL = 1.5e-3 m/s
      const dw = (I * dtM) / (POROSITY * H);
      moisture[m] = Math.min(255, moisture[m] + (dw * 255) | 0);
      addWaterDepth(i * 2, k * 2, -I * dtM);
    }

  // --- 3) PERCOLATION GRAVITAIRE (bucket cascade, haut -> bas) ----------
  const K_GAME = 4e-3;                                   // m/s (50× physique)
  for (let j = MY - 1; j >= 1; j--)
    for (let k = 0; k < MZ; k++)
      for (let i = 0; i < MX; i++) {
        const m = i + MX * (k + MZ * j);
        if (!solidMask[m]) continue;
        const w = moisture[m] / 255;
        if (w <= W_FIELD_CAP) continue;                  // 0.12
        const we  = (w - W_RESID) / (1 - W_RESID);       // W_RESID = 0.03
        const K   = K_GAME * we * we * we;               // approx Mualem cubique
        const flux = Math.min(w - W_FIELD_CAP, (K * dtM) / (POROSITY * H));
        const mb   = m - MX * MZ;
        if (!solidMask[mb]) continue;                    // au-dessus du vide : chute libre
        const wb   = moisture[mb] / 255;
        const move = Math.min(flux, W_MAX - wb);         // W_MAX = 0.98
        if (move <= 0) continue;
        moisture[m]  = ((w  - move) * 255) | 0;
        moisture[mb] = ((wb + move) * 255) | 0;
      }

  // --- 4) DIFFUSION CAPILLAIRE (explicite, 4 sous-pas) ------------------
  const SUB = 4, dtS = dtM / SUB;
  const lambda = (D_MOIST * dtS) / (H * H);              // D_MOIST = 5e-4 m2/s
  console.assert(lambda < 1 / 6, 'diffusion instable !');  // 0.00195 ≪ 0.1667 ✅
  for (let s = 0; s < SUB; s++) {
    tmp.set(moisture);
    for (let j = 1; j < MY - 1; j++)
      for (let k = 1; k < MZ - 1; k++)
        for (let i = 1; i < MX - 1; i++) {
          const m = i + MX * (k + MZ * j);
          if (!solidMask[m]) continue;
          const c0 = tmp[m];
          // Neumann homogène : un voisin vide renvoie la valeur centrale (flux nul)
          const nx0 = solidMask[m-1]     ? tmp[m-1]     : c0;
          const nx1 = solidMask[m+1]     ? tmp[m+1]     : c0;
          const nz0 = solidMask[m-MX]    ? tmp[m-MX]    : c0;
          const nz1 = solidMask[m+MX]    ? tmp[m+MX]    : c0;
          const ny0 = solidMask[m-MX*MZ] ? tmp[m-MX*MZ] : c0;
          const ny1 = solidMask[m+MX*MZ] ? tmp[m+MX*MZ] : c0;
          const lap = nx0 + nx1 + nz0 + nz1 + ny0 + ny1 - 6 * c0;
          // D(w) dépendant de la saturation : fronts nets
          const we = c0 / 255;
          const dscale = Math.pow(Math.max(0.05, 4 * we * (1 - we)), 0.7);
          moisture[m] = clamp8(c0 + lambda * dscale * lap * SUB_BOOST);
        }
  }

  // --- 5) ÉVAPORATION (cellules de surface uniquement) ------------------
  const Emm = EVAP_BASE_MMH
            * (0.25 + 0.75 * env.sun)
            * (1 + 0.35 * env.wind)
            * Math.pow(2, (env.temp - 20) / 12)
            * (1 - env.humidity);
  const E   = (Emm / 3.6e6);                             // mm/h -> m/s
  const base = (E * dtM * GAME_EVAP_ACCEL) / (POROSITY * EVAP_DEPTH); // ×120, 0.02 m
  for (let s = 0; s < surfaceCells.length; s++) {
    const m = surfaceCells[s];
    const w = moisture[m] / 255;
    const beta = Math.min(1, (w / 0.15) * (w / 0.15));   // stage-1 / stage-2
    const shade = surfaceShade[s];                       // 0.15 à l'ombre, 1 au soleil
    const ndotl = surfaceNdotL[s];                       // max(0.2, n·l)
    moisture[m] = clamp8(moisture[m] - base * beta * shade * ndotl * 255);
  }
}
```

## 6.5 Passe shallow-water + érosion

```js
/**
 * Modèle pipe (Mei et al. 2007) + érosion. Grille 2D NX×NZ, dt = 1/120 (2 sous-pas/frame).
 * Sur CPU ici ; la version GPU est le portage direct en 4 passes de fragment shader.
 */
function waterErosionStep(W, dt) {
  const { b, d, s, fL, fR, fT, fB, u, v, tmp } = W;
  const lx = VOXEL, lz = VOXEL, A = PIPE_AREA, l = PIPE_LENGTH;
  const cellArea = lx * lz;

  // ---- 1) FLUX ---------------------------------------------------------
  for (let z = 0; z < NZ; z++)
    for (let x = 0; x < NX; x++) {
      const i = x + NX * z;
      const h0 = b[i] + d[i];
      const kf = (dt * A * GRAVITY) / l;

      let l_ = x > 0      ? Math.max(0, fL[i] * WATER_DAMPING + kf * (h0 - b[i-1]  - d[i-1]))  : 0;
      let r_ = x < NX - 1 ? Math.max(0, fR[i] * WATER_DAMPING + kf * (h0 - b[i+1]  - d[i+1]))  : 0;
      let t_ = z < NZ - 1 ? Math.max(0, fT[i] * WATER_DAMPING + kf * (h0 - b[i+NX] - d[i+NX])) : 0;
      let m_ = z > 0      ? Math.max(0, fB[i] * WATER_DAMPING + kf * (h0 - b[i-NX] - d[i-NX])) : 0;

      // ---- 2) SCALING K : garantit d >= 0 (inconditionnellement positif) -
      const out = l_ + r_ + t_ + m_;
      if (out > 0) {
        const K = Math.min(1, (d[i] * cellArea) / (out * dt));
        l_ *= K; r_ *= K; t_ *= K; m_ *= K;
      }
      fL[i] = l_; fR[i] = r_; fT[i] = t_; fB[i] = m_;
    }

  // ---- 3) HAUTEUR D'EAU + VITESSE -------------------------------------
  for (let z = 1; z < NZ - 1; z++)
    for (let x = 1; x < NX - 1; x++) {
      const i = x + NX * z;
      const inF  = fR[i-1] + fL[i+1] + fT[i-NX] + fB[i+NX];
      const outF = fL[i] + fR[i] + fT[i] + fB[i];
      const d1 = d[i];
      const d2 = Math.max(0, d1 + (dt * (inF - outF)) / cellArea);
      const dBar = Math.max(0.005, 0.5 * (d1 + d2));            // anti division par 0
      u[i] = clamp((fR[i-1]  - fL[i] + fR[i] - fL[i+1])  * 0.5 / (lz * dBar), -6, 6);
      v[i] = clamp((fT[i-NX] - fB[i] + fT[i] - fB[i+NX]) * 0.5 / (lx * dBar), -6, 6);
      d[i] = d2;
    }

  // ---- 4) ÉROSION / DÉPOSITION ----------------------------------------
  for (let z = 1; z < NZ - 1; z++)
    for (let x = 1; x < NX - 1; x++) {
      const i = x + NX * z;
      if (d[i] < WATER_EPSILON) continue;

      // pente locale
      const gx = (b[i+1]  - b[i-1])  / (2 * lx);
      const gz = (b[i+NX] - b[i-NX]) / (2 * lz);
      const g  = Math.hypot(gx, gz);
      const sinA = Math.max(EROSION_MIN_SLOPE, g / Math.sqrt(1 + g * g));

      const speed = Math.hypot(u[i], v[i]);
      const lmax  = Math.min(1, d[i] / D_MAX_EROSION);          // D_MAX_EROSION = 0.06 m
      let C = EROSION_CAPACITY * sinA * speed * lmax;

      // -- seuil de Shields modulé par la cohésion humide ------------------
      const tau   = RHO_W * CF_BED * speed * speed;             // CF_BED = 0.006
      const w     = moistureAtColumn(x, z);
      const tauCr = TAU_CR0 * (1 + K_COH * cohesion(w, drAtColumn(x, z)) / SUBMERGED_UNIT);
      if (tau <= tauCr) C = 0;
      else C *= Math.min(1, (tau - tauCr) / tauCr);

      // -- asymétrie swash / backwash --------------------------------------
      const onshore = (u[i] * SHORE_NX + v[i] * SHORE_NZ) > 0;
      const ks = EROSION_DISSOLVE * (onshore ? 0.45 : 1.0);
      const kd = EROSION_DEPOSIT  * (onshore ? 1.0  : 0.55);

      if (C > s[i]) {
        const amt = ks * (C - s[i]);
        b[i] -= amt; s[i] += amt;
        // -- SAPEMENT : concentrer l'enlèvement autour de la ligne d'eau ---
        applyErosionToVoxels(x, z, amt, b[i] + d[i], /*sigma=*/1.5 * VOXEL);
      } else {
        const amt = kd * (s[i] - C);
        b[i] += amt; s[i] -= amt;
        applyDepositionToVoxels(x, z, amt);
      }
      markColumnDirty(x, z);
    }

  // ---- 5) ADVECTION SEMI-LAGRANGIENNE DU SÉDIMENT ---------------------
  tmp.set(s);
  for (let z = 1; z < NZ - 1; z++)
    for (let x = 1; x < NX - 1; x++) {
      const i = x + NX * z;
      const px = clamp(x - u[i] * dt / lx, 0, NX - 1.001);
      const pz = clamp(z - v[i] * dt / lz, 0, NZ - 1.001);
      s[i] = bilerp(tmp, px, pz);
    }
  renormalizeSediment(s, tmp);       // correction de masse globale (advection non conservative)

  // ---- 6) ÉVAPORATION DE LA LAME D'EAU ---------------------------------
  const ke = 1 - EROSION_EVAPORATE * dt;
  for (let i = 0; i < NX * NZ; i++) { d[i] *= ke; if (d[i] < 1e-5) d[i] = 0; }
}
```

## 6.6 Squelette de la boucle principale

```js
// --- Main thread ---------------------------------------------------------
function frame(now) {
  const dt = Math.min(0.05, (now - last) / 1000); last = now;
  accumulator += dt;

  handleInput();                          // outils : creuser, ajouter, tasser, arroser
  while (accumulator >= SIM_DT && steps < SIM_MAX_STEPS) {
    physicsWorker.postTick(SIM_DT, env);  // non bloquant : le worker travaille en //
    accumulator -= SIM_DT; steps++;
  }

  waterGPU.step(2);                       // 2 sous-pas de shallow water sur GPU
  collectMeshResults(BUDGET_REMESH);      // récupère les géométries prêtes -> upload
  dispatchMeshJobs(meshWorkers);          // envoie les chunks sales aux mailleurs
  particles.update(dt);                   // GPU
  renderer.render(scene, camera);
  requestAnimationFrame(frame);
}

// --- Worker « physics » --------------------------------------------------
function tick(dt, env) {
  applyPendingEdits();                    // édits du joueur mis en file
  updateWaterTable(dt, env.tide);
  updateFreeHeight();                     // colonnes sales seulement
  checkCulmannBreaks();                   // murs trop hauts -> breakTimer
  rebuildSupportIncremental();            // BFS borné sur les AABB sales
  const passes = dirty.count > 40000 ? 1 : 2;
  for (let p = 0; p < passes; p++) avalanchePass(field, frameNo);
  processOverhangs();                     // porte-à-faux + îlots déconnectés
  if ((frameNo % 6) === 0) moisturePass(field, 0.1, env);
  publishVersion();                       // Atomics.store -> les mailleurs peuvent lire
  frameNo++;
}
```

---

# PARTIE 7 — PLAN D'IMPLÉMENTATION ET VALIDATION

## 7.1 Ordre de développement recommandé

| Phase | Contenu | Critère de validation |
|---|---|---|
| **1** | Champ voxel + Surface Nets + apron + édition au pinceau | Sculpter une boule, pas de seam visible, 60 fps |
| **2** | Avalanche sèche (θ = 34° constant), active set, damier | Colonne $a=3$ → runout à ±20 % de Lube (§2.6.8) |
| **3** | Champ d'humidité (diffusion + évaporation + nappe) + `θ_max(w)` | Mur vertical de 80 cm tient si $w=0.15$, tombe si $w=0.03$ |
| **4** | Champ de support + porte-à-faux + connectivité | Une arche de 25 cm de portée tient à $w=0.15$, tombe en séchant |
| **5** | Culmann + breakTimer + effondrement progressif + poussière | Une tour de 1.5 m s'effondre en 1.5 s, cône d'éboulis correct |
| **6** | Shallow water CPU + marée + swash/backwash | La vague monte, s'infiltre, redescend |
| **7** | Érosion + Shields + cohésion + sapement | Une falaise miniature se forme et s'effondre |
| **8** | Portage GPU de l'eau, LOD, super-meshes, particules GPU | 60 fps stable avec 5 châteaux et une tempête |

## 7.2 Tests de non-régression physiques

```
T1  Angle de repos sec       : verser 50 k voxels -> mesurer la pente du cône = 34° ± 2°
T2  Runout de colonne        : a=3, R0=0.4 m -> R∞ = 1.51 m ± 20 %, H∞ = 0.54 m ± 20 %
T3  Mur vertical             : c=2400 Pa -> H_c = 1.12 m ; tester 0.9 m (tient) / 1.4 m (tombe)
T4  Porte-à-faux             : w=0.15, t=20 cm -> L_max = 24 cm (k_arch=2) ± 1 voxel
T5  Conservation de masse    : somme(density) invariante sur 10 000 frames sans édition
T6  Frange capillaire        : nappe à y=0.9 -> w(y=1.1) ≈ 0.94, w(y=1.5) ≈ 0.13
T7  Séchage                  : w=1 -> w<0.15 en ~2 min de jeu (soleil de midi)
T8  Positivité de l'eau      : min(d) >= 0 sur 10 000 frames avec vagues
T9  Stabilité de la diffusion: max(|Δw|/frame) < 0.05, pas d'oscillation en damier
T10 Seuil de Shields         : v=0.1 m/s -> pas d'érosion ; v=0.5 m/s -> érosion sur sable sec
```

## 7.3 Tableau récapitulatif de toutes les constantes

```js
// ===== GÉOMÉTRIE ==========================================================
VOXEL              = 0.04    m
NX, NY, NZ         = 256, 96, 256
CHUNK              = 32
ISO                = 128     (sur 0..255)

// ===== SABLE : PROPRIÉTÉS =================================================
D50                = 2.5e-4  m        // diamètre médian
POROSITY           = 0.38             // 0.46 lâche .. 0.33 tassé
RHO_B              = 1640    kg/m3    // apparente sèche
RHO_B_G            = 16088   N/m3
PHI_CV             = 31      °        // frottement critique
PHI_DEG            = 34      °        // frottement à Dr = 0.3
GAMMA_LV           = 0.0728  N/m      // tension superficielle eau
BOND_GRANULAIRE    = 269               // F_cap / poids d'un grain

// ===== COHÉSION ===========================================================
COHESION_MAX       = 2400    Pa       // à Dr = 0.6, w optimal
W_RISE             = 0.030            // échelle de montée capillaire
W_DROWN_LO/HI      = 0.25 / 0.90
W_LIQ              = 0.75 ; KAPPA_LIQ = 0.55
THETA_PEAK         = 89      °
K_ARCH             = 2.0              // permissivité des surplombs

// ===== AVALANCHE ==========================================================
DAMPING            = 0.35             // 0.25 .. 0.50
MAX_TRANSFER       = 48      /255     // 128 pendant une rupture
MAX_FALL           = 128     /255
N_SLEEP            = 3       passes
HYSTERESIS         = 0.97
BUDGET_GRANULAR    = 90000   voxels/frame
BUDGET_SUPPORT     = 40000   voxels/frame
SUP_MAX            = 12      voxels
PASSES_PER_FRAME   = 2 (1 si > 40 k actifs)

// ===== HUMIDITÉ ===========================================================
grille 2× grossière (8 cm), 10 Hz, dtM = 0.1 s
D_MOIST            = 5e-4    m2/s     // 4 sous-pas -> λ = 0.002 ≪ 1/6
K_GAME (percol.)   = 4e-3    m/s      // = 50 × K_s physique (8e-5)
W_FIELD_CAP        = 0.12
W_RESID            = 0.03 ; W_MAX = 0.98
CAPILLARY_FRINGE   = 0.30    m        // α = 5 m-1, n_vg = 3
TAU_CAP            = 20      s
TAU_WATERTABLE     = 90      s
EVAP_BASE          = 0.45    mm/h     // plein soleil, référence
GAME_EVAP_ACCEL    = 120
EVAP_DEPTH         = 0.02    m
W_CRIT_STAGE2      = 0.15
K_INFIL            = 1.5e-3  m/s      // 40 × la valeur physique

// ===== EAU DE SURFACE =====================================================
grille 256×256 (4 cm), 2 sous-pas de 1/120 s
PIPE_AREA          = 1.6e-3  m2 (= h²)
PIPE_LENGTH        = 0.04    m
WATER_DAMPING      = 0.985
WATER_EPSILON      = 0.0015  m
V_MAX              = 6       m/s
D_BAR_MIN          = 0.005   m
CFL                : dt <= l / sqrt(2 g d_max) = 0.0128 s

// ===== ÉROSION ============================================================
EROSION_CAPACITY   Kc = 0.9
EROSION_DISSOLVE   Ks = 0.35   (×0.45 en swash, ×1.0 en backwash)
EROSION_DEPOSIT    Kd = 0.45   (×1.0 en swash, ×0.55 en backwash)
EROSION_EVAPORATE  Ke = 0.012
EROSION_MIN_SLOPE  = 0.06
D_MAX_EROSION      = 0.06    m        // l_max(d), NE PAS OUBLIER
CF_BED             = 0.006
TAU_CR0            = 0.168   Pa       // Shields, d = 0.25 mm
SUBMERGED_UNIT     = 4.05    Pa       // (ρs-ρw) g d
K_COH              = 0.02             // 0.01 .. 0.05
SIGMA_SWASH        = 0.06    m        // largeur de la bande de sape

// ===== RENDU / BUDGETS ====================================================
BUDGET_REMESH      = 6       chunks/frame
MESH_WORKERS       = 3..5
LOD_SIM_DIST       = 6       m        // avalanche 1 frame sur 4 au-delà
LOD_MESH_DIST      = 8       m        // stride 2
```

---

# PARTIE 8 — SOURCES

**Matériaux granulaires humides / cohésion**
- Mitarai & Nori, *Wet Granular Materials*, Adv. Phys. 55 (2006) — [arXiv:cond-mat/0601660](https://arxiv.org/pdf/cond-mat/0601660) — régimes pendulaire/funiculaire/capillaire, Rumpf, Mohr-Coulomb $\tau > \mu(\sigma+\sigma_c)$, longueur capillaire 3.9 mm, angles > 90°
- Halsey & Levine, *How Sandcastles Fall*, PRL 80, 3141 (1998) — régimes aspérité/rugosité/sphérique, formule $\tan\theta_m$
- Hornbaker, Albert, Albert, Barabási & Schiffer, *What keeps sandcastles standing?*, [Nature 387, 765 (1997)](https://www.nature.com/articles/42831)
- Nowak, Samadani & Kudrolli, *Maximum angle of stability of a wet granular pile*, [Nature Physics 1, 50 (2005)](https://www.nature.com/articles/nphys106)
- Pakpour, Habibi, Møller & Bonn, *How to construct the perfect sandcastle*, [Sci. Rep. 2, 549 (2012)](https://www.nature.com/articles/srep00549) — optimum à ~1 % de fraction volumique de liquide, $H \propto R^{2/3}$
- Samadani & Kudrolli, *Angle of repose and segregation in cohesive granular matter*, [arXiv:cond-mat/0106572](https://arxiv.org/pdf/cond-mat/0106572)
- Richefeu, El Youssoufi & Radjaï, *Shear strength properties of wet granular materials*, PRE 73, 051304 (2006) — saturation de la cohésion, $c = \sigma_t\tan\varphi$
- Scheel et al., *Morphological clues to wet granular pile stability*, [Nature Materials 7, 189 (2008)](https://www.nature.com/articles/nmat2117)

**Sols non saturés / hydraulique**
- van Genuchten (1980), *A Closed-form Equation for Predicting the Hydraulic Conductivity of Unsaturated Soils*
- Carsel & Parrish (1988) — table de paramètres van Genuchten par texture ([tables reproduites](https://www.pnnl.gov/main/publications/external/technical_reports/PNNL-19800.pdf))
- Lu & Likos, *A closed-form equation for effective stress in unsaturated soil*, [WRR 46 (2010)](https://agupubs.onlinelibrary.wiley.com/doi/full/10.1029/2009WR008646) — contrainte de succion, Bishop
- Salim, *Extent of Capillary Rise in Sands and Silts*, [thèse WMU](https://scholarworks.wmich.edu/masters_theses/688/) — 13.5 cm (0.35–0.7 mm), 14.85 cm (0.3–0.6 mm)
- [Stability Analysis of the Explicit Difference Scheme for Richards Equation](https://pmc.ncbi.nlm.nih.gov/articles/PMC7516825/), Entropy 22, 352 (2020)
- FAO-56, [Chapitre 4 : Détermination de $ET_0$](https://www.fao.org/4/x0490e/x0490e08.htm) ; [Penman (1948)](http://soilphysics.okstate.edu/teaching/soil-6583/references-folder/penman%201948.pdf)

**Simulation graphique**
- Klár, Gast, Pradhana, Fu, Schroeder, Jiang & Teran, *Drucker-Prager Elastoplasticity for Sand Animation*, SIGGRAPH 2016 — [PDF](https://math.ucdavis.edu/~jteran/papers/KGPSJT16.pdf), [ACM](https://dl.acm.org/doi/10.1145/2897824.2925906)
- Mei, Decaudin & Hu, *Fast Hydraulic Erosion Simulation and Visualization on GPU*, Pacific Graphics 2007 — [PDF](https://evasion.inrialpes.fr/Publications/2007/MDH07/FastErosion_PG07.pdf), [implémentation Unity de référence](https://github.com/bshishov/UnityTerrainErosionGPU)
- Musgrave, Kolb & Mace, *The Synthesis and Rendering of Eroded Fractal Terrains*, SIGGRAPH 1989 — érosion thermique / angle de talus
- Beneš & Forsbach, *Layered Data Representation for Visual Simulation of Terrain Erosion*, [SCCG 2001](https://www.cs.purdue.edu/cgvlab/www/resources/papers/Benes-2001-Layered_data_representation_for_visual_simulation_of_terrain_ero.pdf)
- Macklin, Müller et al., *Position Based Fluids* / *Unified Particle Physics* ; [*Parallel Particles (P2)*](https://www.researchgate.net/publication/272825505)
- Wu, Fang, Jiang et al., *GPU Optimization of Material Point Methods*, [SIGGRAPH Asia 2018](https://dl.acm.org/doi/10.1145/3272127.3275044)
- Bridson, *Fluid Simulation for Computer Graphics*, 2e éd. — shallow water, CFL, advection semi-lagrangienne

**Sédimentologie / érosion côtière**
- Soulsby & Whitehouse (1997), formule de $\theta_{cr}$ ; [Shields parameter](https://en.wikipedia.org/wiki/Shields_parameter)
- Meyer-Peter & Müller (1948), transport par charriage
- Lube, Huppert, Sparks & Hallworth, *Axisymmetric collapses of granular columns*, JFM 508 (2004) ; Lajeunesse et al., Phys. Fluids 17 (2005) — lois d'échelle du runout
- [Beach scarp dynamics at nourished beaches](https://www.sciencedirect.com/science/article/pii/S0378383919303229) ; [Cliff Notching Due To Swash Abrasion](https://agupubs.onlinelibrary.wiley.com/doi/full/10.1029/2024GL112175)
- [NEWTS1.0: Numerical model of coastal Erosion by Waves and Transgressive Scarps](https://gmd.copernicus.org/articles/17/3433/2024/)

**Voxels, maillage, moteurs**
- [Smooth Voxel Mapping: Real-time Surface Nets and Texturing](https://bonsairobo.medium.com/smooth-voxel-mapping-a-technical-deep-dive-on-real-time-surface-nets-and-texturing-ef06d0f8ca14) ; [fast-surface-nets-rs](https://github.com/bonsairobo/fast-surface-nets-rs)
- Mikola Lysenko, [Smooth Voxel Terrain (Part 2)](https://0fps.net/2012/07/12/smooth-voxel-terrain-part-2/) — comparaison MC / SN / DC
- Nick Gildea, [Dual Contouring: Seams & LOD for Chunked Terrain](http://ngildea.blogspot.com/2014/09/dual-contouring-chunked-terrain.html)
- [Understanding Surface Nets](https://cerbion.net/blog/understanding-surface-nets/) ; [Zylann/godot_voxel — références sur l'extraction de surface](https://github.com/Zylann/godot_voxel/issues/24)
- Petri Purho, *Exploring the Tech and Design of Noita*, GDC 2019 — [notes](https://braindump.jethro.dev/posts/gdc_vault_exploring_the_tech_and_design_of_noita/) — chunks 64×64, dirty rects, multithreading
- Dennis Gustafsson, [Voxagon Blog](https://blog.voxagon.se/) ; [Teardown Teardown](https://juandiegomontoya.github.io/teardown_breakdown.html) — palette 8 bits, 1 octet/voxel, séparation en objets déconnectés
- Éric Chahi / Ubisoft Montpellier, *The Core of From Dust*, [Game Developer](https://www.gamedeveloper.com/design/the-core-of-i-from-dust-i-)
- [SharedArrayBuffer — MDN](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/SharedArrayBuffer)
- [WebGPU vs WebGL en 2026](https://app.cinevva.com/guides/webgpu-vs-webgl-games) ; [Introduction to WebGPU Compute Shaders (Three.js)](https://threejsroadmap.com/blog/introduction-to-webgpu-compute-shaders)
- Bak, Tang & Wiesenfeld (1987) ; [Sandpile Models of Self-Organized Criticality](https://arxiv.org/html/cond-mat/9908316) — et pourquoi il faut un *slope model*, pas un *height model*

---

*Document rédigé pour le projet Sandcastle. Toutes les valeurs numériques sont soit
issues de la littérature citée, soit dérivées analytiquement des formules données ;
les constantes marquées « jeu » sont des accélérations temporelles assumées et
documentées comme telles.*
