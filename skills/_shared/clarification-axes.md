# Les 5 axes de clarification

Grille commune au sas d'entrée (É3, feedback-app#170/#191) — appliquée par
`comprehension` (lane amélioration/feature, accès code) et `verif-bug` (lane
bug, accès navigateur) avant qu'un ticket entre en plan/estimation. Le
touchpoint live côté extension (`qualify()`, feedback-app, texte + screenshot
seuls) applique la même grille en miroir TypeScript — voir
`src/lib/services/qualification/clarification-axes.ts` dans ce repo-là.

Les trois touchpoints posent la même question — "a-t-on assez d'informations
pour planifier/estimer ce ticket ?" — avec des sources de vérité différentes.
Pour chaque axe ci-dessous, la colonne "Sources" indique ce qui permet de le
trancher à CE touchpoint (`comprehension` a le code, `verif-bug` a le
navigateur, `qualify()` n'a ni l'un ni l'autre).

**Règle commune, avant de poser une question sur un axe** : ne le fais que si
**aucune source disponible à ce touchpoint** ne permet de le trancher — pas
le texte du ticket, pas le screenshot (si présent), pas le contexte
applicatif du projet, pas le code, pas le navigateur. Une question dont la
réponse est déductible d'une de ces sources est une question de confort, pas
une clarification.

---

## Axe 1 — Périmètre

**Question centrale** : quel flux, écran ou entité est concerné, et où
s'arrête la demande ?

**Signaux d'insuffisance** : aucune page/flux nommé ; la demande pourrait
viser plusieurs endroits sans qu'on sache lequel ; le ticket mélange
plusieurs sujets sans dire lequel est prioritaire.

**Sources par touchpoint** :
- `comprehension` (code) : le flux/l'entité cité existe-t-il réellement dans
  le repo (route, composant, table) ? Un nom approximatif se résout souvent
  par un `Grep` plutôt que par une question.
- `verif-bug` (navigateur) : le flux cité est-il atteignable et observable
  tel quel sur la page visitée ?
- `qualify()` (texte/screenshot) : le screenshot ou l'URL de la page
  suffisent-ils à déduire le périmètre ?

---

## Axe 2 — Comportement attendu vs observé

**Question centrale** : quel est l'état actuel, quel est l'état désiré, sur
un cas concret ?

**Signaux d'insuffisance** : verbe vague ("ça marche pas", "c'est pas top")
sans étape reproductible ; pas de distinction entre ce qui se passe et ce
qui devrait se passer.

**Sources par touchpoint** :
- `comprehension` (code) : le comportement décrit est-il cohérent avec ce
  que fait le code (pas une fonctionnalité qui n'existe pas, pas un
  comportement qui contredit une logique visible) ?
- `verif-bug` (navigateur) : le scénario se reproduit-il tel que décrit ? —
  c'est l'objet même du rejeu Playwright.
- `qualify()` (texte/screenshot) : le screenshot montre-t-il déjà l'état
  observé (dispense de le redemander) ?

---

## Axe 3 — Conditions / cas limites

**Question centrale** : sous quel rôle, quelles données, quel état ce
comportement s'applique-t-il ?

**Signaux d'insuffisance** : le ticket laisse entendre une condition sans la
nommer ("chez certains clients seulement", "parfois") ; le comportement
décrit dépend manifestement d'un rôle ou d'un état de données non précisé.

**Sources par touchpoint** :
- `comprehension` (code) : le code révèle-t-il une condition (feature flag,
  rôle, branche métier) que le client n'a pas mentionnée et qui change le
  scope ?
- `verif-bug` (navigateur) : la condition citée (rôle, compte, navigateur)
  est-elle reproductible avec l'accès disponible (`admin_login_path`) ?
- `qualify()` (texte/screenshot) : les metadata (OS, navigateur, résolution)
  couvrent-elles déjà la condition ?

---

## Axe 4 — Cohérence code

**Question centrale** : le comportement décrit correspond-il à ce qui existe
réellement dans le code, ou repose-t-il sur une fonctionnalité hallucinée /
une contrainte technique ignorée ?

Axe propre à `comprehension` — c'est le seul touchpoint avec un accès code
direct. Ne pas se contenter d'un survol : si le ticket cite un flux ou un
comportement existant, va vérifier avec `Glob`/`Grep`/`Read` dans le repo
checkouté, ce n'est pas optionnel. Reste proportionné : un garde-fou ciblé
sur ce que le ticket cite, pas une exploration complète du repo.

**Signaux qui doivent déclencher une vérification** : le ticket nomme une
fonctionnalité, un écran ou un comportement précis ("le bouton X", "l'export
Y", "comme sur l'écran Z") — si ça ne se retrouve pas dans le code, la
reformulation ne doit pas le tenir pour acquis.

**Sources par touchpoint** :
- `comprehension` (code) : seule source directe.
- `verif-bug` (navigateur) : proxy partiel — un rejeu qui échoue à trouver
  l'élément cité est un signal du même ordre.
- `qualify()` : aucune — cet axe n'est pas vérifiable à ce touchpoint, ne
  pas prétendre le trancher, le laisser à `comprehension`.

---

## Axe 5 — Critère d'acceptation vérifiable

**Question centrale** : à la fin, quelle phrase permettra de dire "c'est
fait" sans ambiguïté ?

**Signaux d'insuffisance** : la reformulation ne permet de dériver aucun
critère testable ("améliorer l'expérience utilisateur" n'est pas un
critère ; "l'utilisateur peut exporter en CSV depuis l'écran Factures" en
est un).

**Sources par touchpoint** :
- `comprehension` : dérivé de la reformulation elle-même (`understood` +
  `acceptanceCriteria` dans le contrat de sortie) — cet axe se résout en
  écrivant, pas en interrogeant le code.
- `verif-bug` : le verdict (`reproduced`/`not_reproduced`) EST le critère
  d'acceptation pour la lane bug — rien à dériver en plus.
- `qualify()` : si aucun critère n'est déductible du texte, c'est en général
  le signal que la description est trop vague — score bas, question sur
  l'axe 1 ou 2 plutôt que sur celui-ci directement.
