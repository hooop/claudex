# Décisions

Journal des décisions validées à l'issue d'un débat Claude ↔ Codex.

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
