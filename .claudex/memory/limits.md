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
