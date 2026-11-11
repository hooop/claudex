# Décisions

Journal des décisions validées à l'issue d'un débat Claude ↔ Codex.

## 2026-11-11 — Les réglages porteurs de commande du dépôt demandent le consentement de l'humain

**Nature :** arbitrage délégué par le mainteneur (« décisions les plus professionnelles », 2026-11-11) ;
aucune de ces décisions n'a été prise par le mainteneur lui-même. Design :
`docs/superpowers/specs/2026-11-11-project-command-settings-design.md`. Mesures dans `limits.md`
(2026-11-11, consentement).

**Décisions :**
- **D1 : Claudex lit lui-même les réglages du projet, sans jamais rien exécuter**
  (`src/agents/projectSettings.ts`). Fichier lu : `<cwd>/.claude/settings.json` seulement
  (`PROJECT_SETTINGS_FILES`), le seul que les mesures montrent lu par le moteur (Lp et Ll négatifs).
  Signalés : les six helpers de `COMMAND_SETTING_KEYS` (`apiKeyHelper`, `awsAuthRefresh`,
  `awsCredentialExport`, `gcpAuthRefresh`, `otelHeadersHelper`, `proxyAuthHelper`, relevés dans
  l'interface `Settings` de `sdk.d.ts`), toute entrée `env` et, ajouté après la revue finale, les déclarations
  de marketplaces de plugins (`extraKnownMarketplaces` et son alias documenté `additionalMarketplaces`),
  montrées entières : elles portent commandes, URL et helpers à plusieurs niveaux, qu'une liste de
  champs manquerait, et la garde réagit ainsi à tout changement (une URL déplacée). Non mesuré : que
  le moteur récupère ou exécute quoi que ce soit d'une marketplace déclarée par le projet. Pas montrés, consignés dans
  `limits.md` : `statusLine.command`, `subagentStatusLine.command`, `fileSuggestion.command` et les
  règles `permissions.allow` du dépôt. Le fichier est ouvert en non bloquant et
  doit être un fichier ordinaire de 1 Mio au plus ; tout ce que Claudex ne sait pas lire ou analyser
  (JSON invalide, commentaires, BOM, autre chose qu'un objet, clé de premier niveau `__proto__`,
  `constructor` ou `prototype`, fichier spécial, trop gros, permission)
  donne une constatation « illisible ».
- **D2 : consentement au lancement, avant toute écriture et avant tout agent** (`src/launch.ts`,
  `src/cli.tsx`, `src/ui/components/SettingsConsent.tsx`). Pas de `.claudex/` pour un projet refusé ;
  ni Root ni Codex ne démarrent avant la réponse. La liste complète est imprimée en texte simple dans
  l'écran normal (l'historique du terminal la garde, quelle que soit sa longueur), puis une petite
  invite Ink : `y` continue (sans Alt ni Ctrl ; les collages sont ignorés grâce au collage encadré ; les
  touches des 250 premières ms sont ignorées) ; `n`, `q`, Entrée, Échap, Ctrl+C quittent ; quitter est
  le défaut. Touche `y` et non `o` comme le disait le design : cohérence avec l'invite de permission.
  Tout texte venu du dépôt est échappé (caractères de contrôle, de format, bidi, de largeur nulle,
  affichés en `\uXXXX` / `\u{...}`).
- **Une constatation « illisible » rend le consentement impossible** (seul « quitter » est offert) :
  Claude Code peut analyser ce que Claudex ne sait pas lire (JSON avec commentaires, BOM) ; l'approuver
  reviendrait à approuver un contenu que personne n'a vu. Le design permettait d'y consentir ; resserré
  pendant la revue. Coût : un projet aux réglages JSONC ne peut pas être débattu tant qu'il n'est pas
  corrigé.
- **D3 : la garde relit le fichier avant chaque requête Claude** (débat et `/implement`,
  `createSettingsGuard`, appelée par `ClaudeAgent` avant `query()`). Aucune constatation, ou identique à
  l'approbation : le tour part. Sinon le tour n'est pas envoyé et échoue avec un message en français qui
  demande de quitter et relancer. Une garde qui lève une erreur refuse aussi le tour.
- **Le consentement n'est jamais mémorisé** : stocké dans le projet, un dépôt pourrait le pré-remplir ;
  ailleurs, Claudex écrirait hors de `.claudex/`. La question revient à chaque lancement.
- **Trou accepté pendant un tour `/implement`** (voir `limits.md`) : non mesuré, non fermé. La phase
  d'implémentation est de confiance par conception (décision 2026-11-11, D4 de l'isolation). Rien ne
  garantit que l'humain voie une écriture dans `.claude/settings.json` avant qu'elle ait lieu : les
  règles `allow` (de l'utilisateur, ou le `permissions.allow` du dépôt, que l'écran de consentement ne
  montre pas) sont résolues avant `canUseTool` et peuvent approuver l'écriture sans invite (on n'a pas
  mesuré si Claude Code protège ses propres fichiers de réglages contre elles) ; une écriture par Bash
  ne montre que la commande ; avec `/implement codex`, Codex écrit avec `approvalPolicy: "never"`,
  sans aucune invite. La garde ne la voit qu'avant le tour Claude suivant. Accepté en connaissance de
  cause, pas parce qu'il serait petit.
- **D4/D5 :** les cas L, Lp, Ll, M de `verify:readonly` mesurent le comportement du moteur qui rend la
  porte nécessaire ; la porte elle-même est du code Claudex, prouvée par les tests unitaires et
  d'interface, et vérifiée à la main dans un pty.

**Alternatives écartées :**
- Neutraliser les helpers dans la couche « flag » (`settings: { apiKeyHelper: "" }`) : le sens d'un
  helper vide n'est pas documenté ; ne peut pas neutraliser une entrée `env` quelconque ; écraserait en
  `/implement` un helper légitime des réglages de l'utilisateur.
- Retirer `"project"` de `settingSources` : perd le CLAUDE.md du projet (décision du 2026-10-26), et
  `/implement` charge de toute façon la couche projet.
- Refuser tout projet qui déclare un helper : bloque des installations d'entreprise légitimes ; le
  principe est de laisser l'humain décider.
- Avertir sans bloquer : la commande tournerait déjà quand l'humain lit l'avertissement.
- Mémoriser le consentement par projet : voir plus haut.
- Redemander le consentement en cours de session : un nouvel état modal du scheduler pour un cas rare ;
  relancer réutilise l'écran du lancement, et la mémoire du débat survit à une relance.

**Fichiers concernés :** `src/agents/projectSettings.ts`, `src/agents/claudeAgent.ts`, `src/launch.ts`,
`src/cli.tsx`, `src/ui/Root.tsx`, `src/ui/components/SettingsConsent.tsx`,
`scripts/readonly-verification/`, `README.md`, `AGENTS.md`.

**Comment appliquer :** ne pas rouvrir la mémorisation du consentement ni le consentement à un fichier
illisible sans raison nouvelle. À chaque montée du SDK, relire `COMMAND_SETTING_KEYS` contre `sdk.d.ts`
et relancer Lp et Ll pour confirmer `PROJECT_SETTINGS_FILES` (voir `limits.md`).

---

## 2026-11-11 — Le débat de Claude n'exécute ni hook, ni serveur MCP, ni connecteur

**Nature :** arbitrage délégué par le mainteneur (design approuvé le 2026-10-28, « décisions les plus
professionnelles »). Mesures dans `limits.md` (2026-11-11).

**Décisions :**
- **D1 : quatre réglages, sur les seuls tours de débat** (`DEBATE_ISOLATION` dans
  `src/agents/debateOptions.ts`) : `strictMcpConfig: true` sans `mcpServers` (aucun serveur MCP, quelle
  que soit sa source), et `settings: { disableAllHooks, disableClaudeAiConnectors,
  disableSkillShellExecution }` tous à `true`. Ces réglages passent par la couche « flag » du SDK, la
  plus prioritaire des couches modifiables par l'utilisateur : elle l'emporte sur les réglages du dépôt
  analysé, y compris un `disableAllHooks: false` posé par un dépôt hostile (mesuré, cas J).
- **D4 : la phase d'implémentation garde hooks, serveurs MCP et connecteurs.** `/implement` est le
  moment où l'humain confie le dépôt aux agents avec leurs outils habituels (formateurs, contrôles
  qualité, serveurs MCP). Cette phase écrit déjà par conception ; les retirer casserait ce que les
  utilisateurs attendent pour peu de gain. Le README dit que les hooks et serveurs stdio du dépôt y
  tournent comme dans Claude Code, mais sans son dialogue de confiance.
- **Cas L (`apiKeyHelper` du dépôt) hors de cette branche** (arbitrage humain direct) : aucun réglage
  documenté ne le coupe ; il aura sa propre branche, et le README le signale comme trou connu.

**Alternatives écartées :**
- `managedSettings` (couche « policy ») : ignorée par défaut sur une machine qui a déjà une couche
  gérée par un administrateur, et son `disableAllHooks` y devient `allowManagedHooksOnly`. La couche
  « flag » s'applique sur toutes les machines.
- Mesurer le chemin d'approbation des connecteurs (ancien cas I) : impossible à conclure ; les retirer
  du débat est plus simple et vérifiable.
- `settingSources: []` pendant le débat : couperait aussi le CLAUDE.md du projet, gardé exprès
  (décision du 2026-10-26).

**Fichiers concernés :** `src/agents/debateOptions.ts`, `src/agents/claudeAgent.ts`,
`scripts/readonly-verification/`, `scripts/verify-claude-readonly.ts`, `README.md`, `AGENTS.md`.

## 2026-10-27 — Claudex garde le moteur Claude Code fourni par le SDK, à version exacte

**Nature :** arbitrage délégué par le mainteneur, pendant la montée du SDK Claude Agent de 0.1.77 à
0.3.310. Sa première intuition était d'utiliser le `claude` de l'utilisateur ; il a laissé le choix
technique.

**Constat :** le SDK 0.3.x ne contient plus de `cli.js` : il lance un binaire natif Claude Code
(2.1.310), installé par une dépendance optionnelle propre à chaque plateforme (273 Mo sur disque
en darwin-arm64 ; installation complète du SDK 331 Mo contre 92 Mo pour 0.1.77). La lecture seule du
débat a été mesurée sur un moteur précis, voir `limits.md` (2026-10-27).

**Décisions :**
- **D1 : Claudex laisse le SDK lancer le moteur qu'il fournit.** Pas de `pathToClaudeCodeExecutable`.
  La garantie de lecture seule est mesurée sur une version exacte du moteur : avec le binaire fourni,
  la version que l'utilisateur exécute est celle qui a été testée. Le binaire est de toute façon
  installé (dépendance optionnelle du SDK). La connexion ne change pas : le binaire fourni lit les
  mêmes identifiants Claude Code.
- **D2 : le SDK est épinglé à une version exacte** (`"@anthropic-ai/claude-agent-sdk": "0.3.310"`,
  sans `^`). Une montée de version est une branche délibérée, qui relance `npm run verify:readonly`
  sur l'ancienne et sur la nouvelle version.

**Alternatives écartées :**
- Le `claude` de l'utilisateur via `pathToClaudeCodeExecutable` : même téléchargement, garantie plus
  faible (la version exécutée serait celle que l'utilisateur a installée, plus ancienne ou plus
  récente que tout ce qui a été mesuré, et le SDK parle un protocole de contrôle versionné avec son
  propre binaire), et des modes d'échec en plus (aucun `claude` dans le `PATH`, mauvaise version).
- Une plage avec `^` : une version du SDK non testée atteindrait les utilisateurs, alors qu'une
  version peut changer la garantie de lecture seule.

**Fichiers concernés :** `package.json`, `package-lock.json`, `scripts/verify-claude-readonly.ts`,
`AGENTS.md`, `README.md`.

## 2026-10-26 — Claudex ne touche plus à CLAUDE.md ni à AGENTS.md

**Nature :** arbitrage humain direct, avant la distribution sur une marketplace.

**Constat :** au lancement, Claudex créait `CLAUDE.md` et `AGENTS.md`, ou leur ajoutait une section
de mémoire. Ce texte était relu par toutes les sessions Claude Code ou Codex ouvertes ensuite dans
le dépôt, débat ou pas, y compris la consigne « débat jusqu'à consensus avant toute écriture de
code ». La section revenait au lancement suivant si l'utilisateur la supprimait, et le modèle
pointait vers `devlog.md`, qui n'est pas versionné.

**Décisions :**
- Claudex n'écrit rien hors de `.claudex/`. `CLAUDE.md` et `AGENTS.md` appartiennent à l'utilisateur
  et restent lus par les agents pendant le débat.
- Les règles du débat (`CONSENSUS_INSTRUCTIONS`), envoyées une fois à chaque agent par le même
  chemin, nomment `decisions.md` et `limits.md`. Nommés, pas recopiés (coût en tokens, voir
  `limits.md`). Le devlog n'est plus désigné : c'est un index local des sessions.
- Les fichiers produits par les versions précédentes ne sont pas nettoyés automatiquement ; le README
  indique qu'on peut supprimer la section.

**Alternatives écartées :** écriture sur consentement au premier lancement (une option de plus à
maintenir pour un bénéfice limité aux sessions hors Claudex) ;
garder la génération en retirant seulement la phrase sur le binôme (le fichier reste modifié sans
demande).

**Fichiers concernés :** `src/memory/store.ts`, `src/orchestrator/scheduler.ts`, `README.md`.

## 2026-09-28 — Le débat utilise un viewport plein écran géré par Claudex

**Nature :** arbitrage humain direct après essais visuels du header animé.

**Constat :** le scrollback natif du terminal déplace nécessairement tout l'écran ; il ne peut pas
conserver un header et un footer fixes. Mélanger une trame Ink plein écran avec des écritures dans
ce scrollback masquait les réponses courtes, dupliquait certaines lignes et faisait empiéter les
réponses longues sur le footer.

**Décisions :**
- Claudex utilise l'alternate screen fourni par Ink 7, comme `vim`, `less` ou `htop` ; une
  réécriture avec curses est inutile.
- Pendant une session, `DebateView` possède l'intégralité des lignes formatées et n'écrit rien
  derrière sa trame. Header, transcript et footer ont chacun une zone bornée.
- Le transcript se parcourt avec la molette (mode terminal 1007 quand il est supporté), les flèches,
  Page Up/Page Down et Home/End. Le header et le footer ne bougent jamais.
- Le scrollback natif n'est pas disponible dans l'alternate screen. La trace durable reste le
  transcript canonique archivé dans `.claudex/memory/transcripts/` lors de la fermeture normale.

**Fichiers concernés :** `src/cli.tsx`, `src/ui/DebateView.tsx`,
`src/ui/components/DynamicFooter.tsx`, `src/ui/stream/`, `README.md`.

## 2026-08-04 — Architecture C (file de livraisons)

**Approche retenue :** Architecture C, validée par les deux agents.

**Éléments actés :**
- File de livraisons par destinataire
- Snapshots immuables construits par le drain
- Batches d'intervention avec barrière
- Consensus causal uniquement
- Synthèse read-only invalidable par epoch
- Acquittement par job sur tous les chemins
- Ordonnanceur complet et fermé sur tous ses états

**Statut à la consignation :** aucun fichier modifié, implémentation non démarrée — décision récupérée manuellement suite à un bug de détection de consensus (marqueur non reconnu à cause d'un formatage markdown), qui a empêché la synthèse automatique de se générer. Le détail complet du raisonnement du débat n'a pas pu être archivé automatiquement (commande `/save` absente de cette version de session) ; seule cette décision finale, capturée depuis l'écran, a pu être préservée.

## 2026-08-06 — Commande /handoff pour génération de fichier d'implémentation

**Approche retenue :** Ajouter une commande `/handoff`, coexistant avec `/implement`, qui génère un fichier markdown autoportant (contexte projet + synthèse consensuelle) destiné à être transmis tel quel à une session `claude` ou `codex` native pour implémentation. `/handoff` devient le chemin recommandé par défaut ; `/implement` reste disponible pour rester dans Claudex sur des changements ponctuels.

**Accords :**
- Fonction `saveHandoff(cwd, topic, summary)` dans `store.ts` — sémantique « nouveau fichier » (comme `saveTranscript()`), pas « journal » (comme `appendDecision()`)
- Garde explicite sur `session.implementationSummary?.trim()` avant d'autoriser `/handoff` (garde qui n'existe pas aujourd'hui sur `/implement`)
- Nouvelle API publique `recordHandoffGenerated(path)` sur `Scheduler` (appelle `addEntry()` privé), déléguée par `DebateSession` pour l'UI
- Structure du fichier généré : intro + `## Mémoire projet` (`readMemorySummary()` verbatim) + `## Spécification consensuelle` (`implementationSummary`) + `## Consigne d'exécution`
- Gestion de collision de timestamp par suffixe numérique (`-2`, `-3`, …), création exclusive avec réessai uniquement sur `EEXIST`
- `SYNTHESIS_PROMPT` étendu de façon conditionnelle (fichiers/composants, interfaces, comportements, tests — uniquement s'ils ressortent du débat, sans rubrique vide inventée)
- UX mise à jour pour recommander `/handoff` : bannière post-consensus, placeholder de saisie, `HelpPanel`, `README.md`
- Aucune modification de `/implement`, de la mécanique de débat (Architecture C) ni des critères de consensus

**Fichiers concernés :**
- `src/orchestrator/commands.ts`
- `src/memory/store.ts`
- `src/orchestrator/scheduler.ts`
- `src/orchestrator/session.ts`
- `src/ui/DebateView.tsx`
- `README.md`
- `src/orchestrator/__tests__/commands.test.ts` (nouveau)
- `src/memory/__tests__/store.test.ts` (nouveau)

## 2026-08-11 — L'autonomie est illimitée par défaut ; le consensus survit à une intervention

**Nature :** arbitrage humain direct, hors débat Claude ↔ Codex. Tranche une question que le
handoff du 2026-08-10 laissait explicitement ouverte (« Budget d'autonomie : métrique ; valeur ;
politique de persistance ou question interactive »), et remplace le comportement fail-closed qui
avait été implémenté en attendant.

**Contexte :** les deux comportements se combinaient en piège fermé. Aucune politique d'autonomie
n'étant configurée, aucun tour automatique ne pouvait démarrer ; seules les interventions humaines
faisaient avancer le débat ; et les tours nés d'une intervention étaient exclus du consensus. Les
deux agents pouvaient être d'accord sans que la session puisse jamais se clore.

**Décisions :**
- **Absence de politique d'autonomie = illimité.** Le risque qu'un budget obligatoire borne est
  l'emballement non supervisé. Claudex n'a aucun mode non supervisé : `src/cli.tsx` refuse de
  démarrer sans TTY, et Échap met en pause au clavier même pendant un tour. La supervision est
  structurelle, pas budgétaire. Ce n'est donc pas une valeur par défaut arbitraire : c'est le
  constat qu'aucune borne n'est nécessaire dans le seul mode qui existe.
- `/autonomy starts N` et `/autonomy time <durée>` restent, comme bornes **optionnelles**, pour
  qui prévoit de s'éloigner du terminal. `unbounded` redevient un retrait de borne.
- L'état de suspension `autonomy-required` est supprimé : il n'est plus atteignable.
- **Le consensus dépend de l'epoch seule, plus de l'origine du tour.** Un tour qui répond à la
  dernière intervention porte l'epoch que cette intervention a créée ; deux agents qui s'accordent
  juste après une question humaine s'accordent réellement. Toute entrée plus récente les invalide
  déjà via `incrementEpoch()`.
- Au consensus, les livraisons automatiques encore en attente sont abandonnées : sinon un `/resume`
  après la synthèse rejouerait un tour mis en file avant l'accord et rouvrirait un débat clos. Seule
  une vraie intervention doit le rouvrir, par une nouvelle epoch.

**Fichiers concernés :** `src/orchestrator/scheduler.ts`, `src/types.ts`, `src/orchestrator/types.ts`,
`src/ui/DebateView.tsx`, `src/ui/components/StatusBar.tsx`, `src/__tests__/scheduler.test.ts`,
`src/ui/__tests__/root.test.tsx`, `README.md`.

**Attention pour les tests :** des agents factices qui répondent toujours `<<CONTINUE>>` ne sont
plus freinés par rien. Un fixture qui a besoin d'un débat fini doit poser sa propre borne
(`root.test.tsx` le fait), pas compter sur un blocage global.

## 2026-08-17 — Les règles du débat ne nomment plus aucun agent

**Nature :** arbitrage humain à l'issue d'un échange Claude ↔ Codex conduit hors Claudex, pièces
mesurées à l'appui. Corrige une asymétrie inscrite dans le prompt depuis l'origine.

**Constat mesuré :** sur les 37 sessions de débat retrouvées dans `~/.claude/projects/`, Claude
n'émet plus aucun appel d'outil après son premier tour, et 55 % de ses tours s'ouvrent sur un accord
explicite (« Je confirme », « Tu as raison », « Je reconnais »). Les occurrences du mot « objection »
sont presque toutes des négations (« je n'ai plus d'objection »). Le motif est identique sur Sonnet
4.5, Opus 4.5 et Sonnet 5 : il vient du harnais, pas du modèle.

**Cause identifiée :** `CONSENSUS_INSTRUCTIONS` disait « Claude n'a pas d'outil d'exécution et doit
demander à Codex de vérifier ». Les deux agents recevaient cette phrase : elle disqualifiait la seule
capacité de l'un et signalait à l'autre que son contradicteur ne pouvait rien contrôler.

**Décisions :**
- Aucune règle ne nomme un agent en dehors des rôles `self` et `other`. Vérifié comme une propriété :
  un test permute les deux noms dans les instructions et exige d'obtenir exactement celles de l'autre.
- La règle de preuve devient symétrique : qui exécute donne la commande exacte et sa sortie brute ;
  qui ne peut pas exécuter la réclame et refuse une affirmation empirique non étayée. Exiger la
  preuve fait partie du rôle autant que la fournir.
- Le consensus demande d'avoir examiné au moins une alternative sérieuse. Poursuivre exigeait une
  objection *nouvelle* quand s'accorder n'exigeait rien : dans le doute, l'accord était le coup valide
  le moins cher. Il n'est jamais demandé de fabriquer un désaccord.
- L'interdiction des marqueurs Markdown est retirée des deux prompts. C'est une contrainte
  d'affichage, déjà appliquée par le renderer ; l'imposer au modèle dégradait les handoffs, qui sont
  par la décision du 2026-08-06 des documents Markdown autoportants.

**Fichiers concernés :** `src/orchestrator/scheduler.ts`, `src/__tests__/scheduler.test.ts`.

**Ce qui n'est pas démontré :** une cause documentée a été retirée, pas la déférence elle-même. À
revérifier sur les prochaines sessions avec les mêmes mesures — appels d'outils après le premier
tour, phrases d'ouverture, qui produit les preuves. Les 37 traces archivées donnent la ligne de base.

## 2026-08-17 — L'asymétrie d'exécution reste en l'état, en attendant la mesure

**Nature :** décision de séquencement, prise après le correctif de prompt ci-dessus.

**Décision :** ne rien construire pour l'instant. Le correctif de prompt vient de retirer la cause
la plus probable de la déférence pour un coût nul ; construire un canal d'exécution partagé avant
d'avoir mesuré son effet reviendrait à payer une complexité d'ordonnanceur pour un problème
peut-être déjà résolu.

**Condition de réouverture :** si, sur les prochaines sessions, Claude continue de n'appeler aucun
outil après son premier tour et d'ouvrir ses réponses par un accord, alors la capacité est bien en
cause et le canal se justifie.

**Ce qui serait construit dans ce cas — et ce qui est écarté :**
- Retenu : un fil `codex app-server` dédié en `readOnly` + `networkAccess: false`, distinct du fil
  débatteur, dont n'importe quel agent demande une commande et dont la sortie brute entre dans les
  deux transcrits. Même garantie d'écriture qu'aujourd'hui, aucune dépendance nouvelle.
- Écarté : donner Bash à Claude sous approbation humaine. Cela remplace une garantie du système
  d'exploitation par l'attention de l'humain, qui ne peut pas déduire de `npm test` les fichiers
  qu'il écrit. C'est précisément le raisonnement de `claudeAgent.ts`.
- Sur les lectures non restreintes de `command/exec` (relevé par Codex, vérifié dans le schéma v2) :
  ce n'est pas un obstacle nouveau. Le fil débatteur Codex a déjà exactement cette exposition, elle
  est documentée dans le README et acceptée. Un second exécuteur en lecture seule n'ajoute aucune
  classe de risque.
