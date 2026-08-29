# Limites connues

Contraintes, boundaries et choses explicitement écartées.

## 2026-08-07 — Le sandbox du SDK ne peut pas rendre `cwd` non-inscriptible

**Constat :** dans `@anthropic-ai/claude-agent-sdk@0.1.77` (version installée), `sandbox.filesystem.denyWrite`
ne peut pas retirer le répertoire de travail (`cwd`) de l'ensemble des chemins autorisés en écriture.
Vérifié empiriquement (pas seulement lu dans la doc) avec un script isolé appelant `query()` directement :
écriture hors `cwd` → bloquée (`operation not permitted`) ; écriture dans `cwd` → **toujours réussie**,
peu importe la forme passée à `denyWrite` (`"/"`, `"."`, chemin absolu de `cwd`, ou glob `cwd + "/**"`).
Le fichier a été vérifié présent sur disque dans les quatre variantes testées.

**Pourquoi c'est bloquant :** pendant le débat Claudex, `cwd` *est* le dépôt en cours d'analyse — c'est
précisément le répertoire qu'une exécution Bash « lecture seule » ne doit jamais pouvoir modifier. Le
sandbox du SDK ne peut pas fournir cette garantie dans cette version.

**Autres écarts constatés entre la doc publique (code.claude.com/docs/en/sandboxing) et le SDK installé :**
`failIfUnavailable`, `strictAllowlist` (réseau) et `allowManagedDomainsOnly` sont documentés côté CLI
mais absents du binaire embarqué dans ce paquet npm (0 occurrence dans `cli.js`, vérifié par grep) — ce
sont des no-ops silencieux s'ils sont passés en config, pas des erreurs.

**Ce qui fonctionne bien, à l'inverse :** `sandbox.network.allowedDomains: []` bloque proprement tout
réseau depuis Bash (échec immédiat, pas de blocage en attente d'approbation interactive) — vérifié
empiriquement aussi.

**Conséquence pour la décision du 2026-08-07 (voir handoff
`.claudex/memory/handoffs/2026-08-07-execution-lecture-seule-claude.md`) :** le prérequis technique de ce
handoff repose sur une config sandbox (`filesystem.denyWrite`, `failIfUnavailable`, `network.strictAllowlist`)
qui ne produit pas la garantie annoncée dans cette version du SDK. La décision doit être rouverte en
débat avant toute implémentation — ne pas implémenter le handoff tel quel.

**Comment appliquer :** avant d'activer Bash (même "lecture seule") pendant la phase de débat, revérifier
empiriquement sur la version du SDK alors installée — ne pas se fier à la doc seule, ni aux types `.d.ts`
seuls (`sandboxTypes.d.ts` est lui-même en retard sur ce que `cli.js` embarqué supporte réellement).

## 2026-08-11 — Le débat sur l'asymétrie d'exécution s'est tenu sous deux bugs bloquants

**Constat :** la session du 2026-08-11 (transcript
`.claudex/memory/transcripts/2026-08-11T11-32-05-920Z-debat-de-conception-en-lecture-seule-n-ecrivez-aucun-code-ne.md`)
s'est déroulée alors que le scheduler souffrait de deux défauts corrigés le jour même
(voir `decisions.md`, 2026-08-11) : aucun tour automatique ne pouvait démarrer sans politique
d'autonomie, et un tour né d'une intervention ne pouvait jamais enregistrer un consensus.

**Conséquences observables sur cette trace, à garder en tête en la relisant :**
- **Chacun des douze tours a été déclenché par une intervention humaine.** Le débat n'a jamais
  enchaîné seul ; les relances (« continue », « codex ? », « consensus ? ») sont des déblocages,
  pas des contributions au fond.
- **Aucun consensus n'a pu être enregistré** alors que les deux agents l'ont déclaré en clair à
  quatre reprises. Aucune synthèse n'a donc été produite, et aucun handoff généré automatiquement.
- **Claude s'est cru Codex au moins une fois** (bloc étiqueté `## CLAUDE`, ligne 98 : « ma réponse
  à Claude », revendication d'une capacité d'exécution qu'il n'a pas). Cause identifiée :
  `DeliveryBlock.source` n'était pas rendu dans le message livré. Corrigé depuis.
- **Déférence marquée de Claude envers Codex** en fin de débat : Codex pose les redlines, Claude
  confirme, dernier mot « Oui. ». À pondérer, puisque Claude ne pouvait vérifier aucune
  affirmation empirique — ce qui était précisément le sujet du débat.
- **Sources citées non atteignables.** Codex a cité treize fois `learn.chatgpt.com/docs/app-server`
  comme référence normative alors que son sandbox a `networkAccess: false`. Les affirmations
  étaient en fait exactes (vérifiées depuis sur le binaire), mais la citation ne prouvait rien.

**Comment appliquer :** ne pas lire cette trace comme un consensus ordinaire. La décision de fond
tient, mais toute affirmation de détail doit être revérifiée avant implémentation.

## 2026-08-11 — Ink 5/6 n'oublie jamais un `<Static>` démonté (crash mémoire)

**Constat :** utiliser `<Static>` d'Ink dans un écran qui peut être démonté fait mourir Claudex,
en moins d'une seconde, avec `JavaScript heap out of memory` — après un `/new`, ou après un premier
message refusé comme non débattable.

**Mécanisme, vérifié par photographie mémoire et capture de pile :**
`node_modules/ink/build/reconciler.js`, `finalizeInitialChildren()` enregistre `rootNode.staticNode = node`
quand un `<Static>` apparaît, et **ne le remet jamais à zéro** quand ce composant disparaît. Ensuite,
`renderer.js` fait inconditionnellement `if (node.staticNode?.yogaNode)` et lit la mise en page d'un
nœud mort : il obtient `width=0` et `height=36893488147419103000` (la valeur « non définie » de Yoga).
`Output.get()` exécute alors `for (let y = 0; y < 3.7e19; y++) output.push([])` — avec une largeur nulle,
chaque ligne est un tableau vide. La photographie du crash montrait exactement un tableau local
(« stack roots ») contenant **22 295 844 tableaux vides**.

**Pourquoi ça n'apparaissait qu'après une session :** seul `DebateView` utilisait `<Static>`.
Un écran d'accueil neuf ne crashe jamais ; après un cycle de session, n'importe quel rendu suffit.

**Corrigé en amont dans Ink 7.0.0** (`removeChildFromContainer` remet `staticNode` à `undefined`).
**Le projet est monté sur Ink 7.1.1 + React 19.2 le même jour**, donc ce défaut précis n'est plus
atteignable. `<Static>` a tout de même été retiré de `DebateView` : il ne servait qu'aux premières
secondes d'un débat et coûtait un état entier.

**Comment appliquer :** rien à éviter, `<Static>` est de nouveau utilisable et utilisé.

## 2026-08-11 — Rétrécir la fenêtre pendant l'amorçage brouille l'affichage (cosmétique)

**Constat :** Ink efface tout le terminal et réécrit son tampon statique dès qu'une trame précédente
était plus haute que la fenêtre courante (`shouldClearTerminalForFrame`, condition `wasOverflowing`).
Claudex dessine volontairement une trame pleine hauteur pendant l'amorçage d'un débat, pour garder la
saisie en bas de l'écran. Rétrécir la fenêtre à ce moment-là efface l'écran et fait réapparaître en
double les lignes déjà affichées.

**Pourquoi on l'accepte :** c'est purement visuel, et borné aux quelques secondes où le premier écran
n'est pas encore rempli. Le transcript archivé est construit depuis l'état de l'ordonnanceur
(`shutdown.transcript`), jamais depuis le terminal : **aucune donnée n'est perdue**, le fichier de
`.claudex/memory/transcripts/` est intact.

**Ce qui a été essayé et n'a pas marché :** borner la hauteur du pied de page sur la taille courante
du terminal plutôt que sur l'état React. Ink recalcule sa mise en page et redessine de façon
synchrone dans son propre gestionnaire de redimensionnement, avant que React ait appliqué la mise à
jour — il lit donc toujours l'ancienne trame haute. Supprimer la trame haute règle le problème mais
fait remonter la saisie en haut de l'écran au démarrage, ce qui a été jugé pire.

**Comment appliquer :** ne pas retenter de « corriger » ce point par un calcul de hauteur. Le seul
vrai correctif serait de reproduire l'effet visuel sans trame Ink haute — par exemple en poussant le
curseur avec des lignes vides écrites dans le scrollback — ce qui reste à concevoir.

## 2026-08-17 — Ce que coûte le prompt système de Claude, mesuré

**Constat :** mesuré sur cette machine avec le SDK installé, un appel trivial (`Réponds exactement:
ok`, outils limités à Read/Grep/Glob), en comparant la somme
`input_tokens + cache_creation + cache_read` de la première réponse assistant :

| Configuration | Prompt système |
| --- | --- |
| `settingSources: ["project","user"]` avec les `@` imports dans CLAUDE.md | 29 701 tokens |
| `["project"]` avec les `@` imports | 16 364 tokens |
| `["project"]` sans les `@` imports | 2 640 tokens |
| `[]` | 2 328 tokens |

Donc : `@fichier` dans CLAUDE.md coûtait **13 724 tokens par appel**, et les réglages utilisateur
**13 337 tokens par appel** — catalogues de plugins et de skills qu'un agent limité à Read/Grep/Glob
ne peut pas utiliser. Ce préfixe est payé à *chaque* appel API, donc plusieurs dizaines de fois par
tour d'exploration, pas une fois par tour.

**Piège associé, vérifié :** retirer `"user"` sans passer le modèle explicitement fait retomber le
débat de `claude-opus-4-5` à `claude-sonnet-4-5` sans aucun message. Le modèle configuré vient de
`~/.claude/settings.json`, que seul `settingSources: ["user"]` charge. Claudex lisait déjà ce champ
(`readClaudeConfiguredModel`) mais uniquement pour l'afficher ; il le transmet maintenant au SDK.

**Sur le cache :** il n'amortit pas autant qu'il y paraît. Le TTL est de cinq minutes et un tour de
Codex s'intercale entre deux tours de Claude : sur la session `460ca9a4`, les tours 2 et 4
reconstruisent 60 195 et 66 973 tokens de préfixe avec zéro lecture de cache. L'écriture de cache se
facture 1,25× l'entrée contre 0,1× pour la lecture — sur cette session, l'écriture a coûté cinq fois
la lecture. Réduire le préfixe reste donc rentable même avec un cache qui fonctionne.

**Comment appliquer :** avant d'ajouter quoi que ce soit au prompt système du débat (import de
mémoire, source de réglages, MCP, plugin), le mesurer par cette méthode. Un chiffre lu dans le
`.jsonl` de session doit être dédupliqué sur `message.id` : le journal écrit une ligne par bloc de
contenu, et une somme naïve double les totaux.

## 2026-08-29 — `permissionMode: "plan"` n'est pas une couche d'application, et le défaut du SDK autorise l'écriture

**Constat :** deux faits vérifiés sur `@anthropic-ai/claude-agent-sdk@0.1.77` (version installée),
en réponse à la question « le mode `plan` documenté pour les subagents peut-il remplacer le sandbox
comme garantie de lecture seule ? ». Réponse : non.

**1. Le mode `plan` est une consigne de prompt, pas un contrôle.** Dans `cli.js`, la fonction de
permission des outils d'écriture (`m4A`) ne consulte jamais le mode : elle décide sur les règles
`allow`/`ask`/`deny`, les répertoires autorisés et `acceptEdits`. Sur les sept comparaisons
`=== "plan"` du binaire, la seule qui touche la couche permissions *autorise* (`plan` +
`isBypassPermissionsModeAvailable` → `behavior: "allow"`). Le caractère lecture seule est porté par
une injection de prompt : « Plan mode is active. The user indicated that they do not want you to
execute yet — you MUST NOT make any edits, run any non-readonly tools ».

**2. Sans `canUseTool`, le défaut non interactif est d'autoriser.** `permissionMode: "default"`
seul ne fait pas échouer une écriture : il n'y a personne pour répondre au `ask`, et l'appel passe.

**Test empirique** (`query()` isolé, `tools: ["Bash"]`, consigne d'écrire un fichier dans `cwd`,
présence du fichier vérifiée sur disque) :

| Cas | `permissionMode` | `allowedTools` | Bash appelé | Fichier écrit |
| --- | --- | --- | --- | --- |
| A | `plan` | — | non | non |
| B | `default` | — | oui | **oui** |
| C | `plan` | `["Bash"]` | oui | **oui** |
| D | `default` | `["Bash"]` | oui | **oui** |

Le cas A ne prouve rien : le modèle a *obéi* à la consigne, il n'a pas été *empêché*. Le cas C le
démontre — mode `plan` actif, fichier écrit quand même.

**Conséquence :** la limite du 2026-08-07 (le sandbox du SDK ne peut pas rendre `cwd`
non-inscriptible) **tient inchangée**. Le mode `plan` n'en est pas une alternative. La lecture seule
du débat repose sur deux choses, et seulement deux : `tools: DEBATE_TOOLS` dans `claudeAgent.ts`
(vraie restriction de disponibilité — l'outil n'existe pas pour le modèle) et `canUseTool` (arbitrage
humain sur chaque appel).

**Piège associé :** `allowedTools: []` ne restreint rien. C'est une liste d'auto-approbation, pas un
filtre — la doc du SDK le dit explicitement (« To restrict which tools are available, use the `tools`
option instead »). Le champ qui restreint est `tools`.

**Comment appliquer :** ne jamais traiter `permissionMode` comme une frontière de sécurité, quelle
que soit la valeur. Pour restreindre, passer par `tools`. Pour arbitrer, passer par `canUseTool`.
Revérifier empiriquement à chaque montée de version du SDK, avec les quatre cas ci-dessus : le
critère est la présence du fichier sur disque, pas le message rendu par le modèle.
