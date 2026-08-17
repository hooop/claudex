import { existsSync } from "node:fs";
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { AgentId, AutonomyBudget, TranscriptEntry } from "../types.js";

const MEMORY_DIR = ".claudex/memory";

/**
 * Default sharing policy for the memory Claudex writes into the host repository.
 *
 * Transcripts and handoffs are bulky and hold the raw text of a debate; the
 * devlog holds every prompt its author ever typed. None of that belongs in a
 * team's history by accident. Decisions and limits are the opposite: short,
 * deliberately curated, and referenced by CLAUDE.md and AGENTS.md — a teammate
 * cloning the repository should get them.
 */
const CLAUDEX_GITIGNORE = `# Écrit par Claudex au premier lancement, pour que les transcripts de tes débats
# ne partent pas dans un commit de ce dépôt.
#
# Liste blanche : tout est exclu par défaut — y compris ce que Claudex écrira
# dans de futures versions — et seul ce qui est explicitement rouvert ci-dessous
# est versionné.
*
!.gitignore
!memory/
memory/*
!memory/decisions.md
!memory/limits.md

# decisions.md et limits.md sont courts, écrits à dessein, et référencés par
# CLAUDE.md comme par AGENTS.md : une personne qui clone le dépôt doit les
# recevoir. Retire les deux dernières lignes pour garder la mémoire du projet
# entièrement locale.
`;
const MEMORY_MARKER = ".claudex/memory/decisions.md";
const STATE_FILE = ".claudex/memory/.state.json";

function memoryPath(cwd: string, file: string): string {
  return path.join(cwd, MEMORY_DIR, file);
}

async function ensureMemoryDir(cwd: string): Promise<void> {
  await mkdir(path.join(cwd, MEMORY_DIR), { recursive: true });
}

interface ClaudexState {
  lastKnownModels?: Partial<Record<AgentId, string>>;
  autonomyBudget?: AutonomyBudget;
}

const stateWrites = new Map<string, Promise<void>>();

async function readState(cwd: string): Promise<ClaudexState> {
  const p = path.join(cwd, STATE_FILE);
  if (!existsSync(p)) return {};
  try {
    return JSON.parse(await readFile(p, "utf8")) as ClaudexState;
  } catch {
    return {};
  }
}

/**
 * The Claude Agent SDK only reveals the actually-resolved default model
 * after a real turn (there's no static config to read it from beforehand,
 * unlike Codex's ~/.codex/config.toml). So we remember the last one we
 * actually saw, to show something better than a placeholder on the dashboard.
 */
export async function rememberModel(cwd: string, agent: AgentId, model: string): Promise<void> {
  await updateState(cwd, (state) => {
    state.lastKnownModels = { ...state.lastKnownModels, [agent]: model };
  });
}

export async function getLastKnownModel(cwd: string, agent: AgentId): Promise<string | null> {
  const state = await readState(cwd);
  return state.lastKnownModels?.[agent] ?? null;
}

export async function rememberAutonomyBudget(cwd: string, budget: AutonomyBudget): Promise<void> {
  await updateState(cwd, (state) => {
    state.autonomyBudget = budget;
  });
}

async function updateState(cwd: string, mutate: (state: ClaudexState) => void): Promise<void> {
  const previous = stateWrites.get(cwd) ?? Promise.resolve();
  const update = previous.catch(() => undefined).then(async () => {
    await ensureMemoryDir(cwd);
    const state = await readState(cwd);
    mutate(state);
    await writeFile(path.join(cwd, STATE_FILE), JSON.stringify(state, null, 2), "utf8");
  });
  stateWrites.set(cwd, update);
  try {
    await update;
  } finally {
    if (stateWrites.get(cwd) === update) stateWrites.delete(cwd);
  }
}

export interface DecisionEntry {
  topic: string;
  chosenApproach: string;
  agreements: string[];
  disagreementsResolved?: string[];
  filesConcerned?: string[];
}

export async function appendDecision(cwd: string, entry: DecisionEntry): Promise<void> {
  await ensureMemoryDir(cwd);
  const date = new Date().toISOString().slice(0, 10);
  const lines = [`\n## ${date} — ${entry.topic}`, "", `**Approche retenue :** ${entry.chosenApproach}`];
  if (entry.agreements.length) {
    lines.push("", "**Accords :**", ...entry.agreements.map((a) => `- ${a}`));
  }
  if (entry.disagreementsResolved?.length) {
    lines.push("", "**Désaccords tranchés :**", ...entry.disagreementsResolved.map((d) => `- ${d}`));
  }
  if (entry.filesConcerned?.length) {
    lines.push("", "**Fichiers concernés :**", ...entry.filesConcerned.map((f) => `- \`${f}\``));
  }
  lines.push("");
  await appendFile(memoryPath(cwd, "decisions.md"), lines.join("\n"), "utf8");
}

export async function appendDevlog(cwd: string, summary: string): Promise<void> {
  await ensureMemoryDir(cwd);
  const timestamp = new Date().toISOString();
  await appendFile(memoryPath(cwd, "devlog.md"), `\n### ${timestamp}\n${summary}\n`, "utf8");
}

export async function appendLimit(cwd: string, limit: string): Promise<void> {
  await ensureMemoryDir(cwd);
  const date = new Date().toISOString().slice(0, 10);
  await appendFile(memoryPath(cwd, "limits.md"), `\n- [${date}] ${limit}\n`, "utf8");
}

/**
 * How much of a topic identifies a session. Already the bound used to name its
 * transcript file, so a devlog line and the file it points at carry the same
 * amount of the subject.
 */
const TITLE_LENGTH = 60;

/**
 * One-line title for the devlog index.
 *
 * The devlog used to record the prompt verbatim, which made it the largest file
 * in the project memory — and the memory is read at the start of every session.
 * The full text is preserved in the archived transcript; this file only has to
 * say which session it was.
 */
export function sessionTitle(topic: string): string {
  const oneLine = topic.trim().replace(/\s+/gu, " ");
  if (oneLine.length <= TITLE_LENGTH) return oneLine;
  return `${oneLine.slice(0, TITLE_LENGTH).trimEnd()}…`;
}

function slugify(topic: string): string {
  return (
    topic
      .trim()
      .toLowerCase()
      .normalize("NFD")
      .replace(/[̀-ͯ]/g, "")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/(^-+|-+$)/g, "")
      .slice(0, TITLE_LENGTH) || "sujet"
  );
}

/**
 * Writes `content` to `<dir>/<base><ext>`, exclusively (fails if the path
 * already exists instead of silently overwriting). On collision, retries
 * with a numeric suffix on the full name (`-2`, `-3`, ...) — the same
 * millisecond timestamp can otherwise collide when several handoffs are
 * generated back to back.
 */
async function writeExclusive(dir: string, base: string, ext: string, content: string): Promise<string> {
  let attempt = 0;
  while (true) {
    const suffix = attempt === 0 ? "" : `-${attempt + 1}`;
    const file = path.join(dir, `${base}${suffix}${ext}`);
    try {
      await writeFile(file, content, { encoding: "utf8", flag: "wx" });
      return file;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "EEXIST") {
        attempt++;
        continue;
      }
      throw err;
    }
  }
}

/**
 * Full verbatim archive of a finished debate, written before /new or /quit
 * wipe the in-memory transcript and reset the agents' sessions. Never read
 * back by the agents (would bloat context) — this is purely for the human,
 * a ground-truth fallback if the structured summary in decisions.md ever
 * turns out to have missed something.
 */
export async function saveTranscript(
  cwd: string,
  topic: string,
  entries: readonly TranscriptEntry[],
  options: { completeness?: "stable" | "partial" } = {},
): Promise<string> {
  await ensureMemoryDir(cwd);
  const dir = path.join(cwd, MEMORY_DIR, "transcripts");
  await mkdir(dir, { recursive: true });

  const now = new Date();
  const stamp = now.toISOString().replace(/[:.]/g, "-");
  const slug = slugify(topic);

  const completeness = options.completeness ?? "stable";
  const lines = [
    `# ${topic}`,
    "",
    `${completeness === "partial" ? "Instantané partiel capturé" : "Archivé"} le ${now.toISOString()}`,
    ...(completeness === "partial"
      ? ["", "> Tour possiblement en cours au moment de la capture ; cet instantané n'est pas une clôture de session."]
      : []),
    "",
  ];

  for (const entry of entries) {
    const label = entry.kind === "summary" ? "RÉSUMÉ" : entry.from.toUpperCase();
    const target = entry.to ? ` → ${entry.to === "both" ? "les deux" : entry.to}` : "";
    lines.push(`## ${label}${target}`, "", entry.text, "");
  }

  const file = await writeExclusive(dir, `${stamp}-${slug}`, ".md", lines.join("\n"));
  return path.relative(cwd, file);
}

/**
 * Self-contained implementation prompt written once a Claude ↔ Codex debate
 * reaches consensus: project memory (decisions + limits) plus the neutral
 * synthesis, ready to hand to a native `claude` or `codex` terminal session
 * with no further explanation. Coexists with `/implement` (in-Claudex write
 * access) — this is the recommended path, not a replacement.
 */
export async function saveHandoff(cwd: string, topic: string, summary: string): Promise<string> {
  const trimmedSummary = summary.trim();
  if (!trimmedSummary) {
    throw new Error("saveHandoff: le résumé de consensus est vide");
  }

  await ensureMemoryDir(cwd);
  const dir = path.join(cwd, MEMORY_DIR, "handoffs");
  await mkdir(dir, { recursive: true });

  const now = new Date();
  const stamp = now.toISOString().replace(/[:.]/g, "-");
  const slug = slugify(topic);
  const memorySummary = await readMemorySummary(cwd);

  const lines = [
    `# ${topic}`,
    "",
    "Fichier généré par Claudex à l'issue d'un consensus Claude ↔ Codex, à transmettre tel quel " +
      "à une session `claude` ou `codex` pour implémentation.",
    "",
    "## Mémoire projet",
    "",
    memorySummary,
    "",
    "## Spécification consensuelle",
    "",
    trimmedSummary,
    "",
    "## Consigne d'exécution",
    "",
    "Implémente cette spécification en considérant les décisions ci-dessus comme actées. Ne les " +
      "rouvre pas ; si une incohérence ou une ambiguïté réellement bloquante subsiste, signale " +
      "précisément ce point avant toute modification.",
    "",
  ];

  const file = await writeExclusive(dir, `${stamp}-${slug}`, ".md", lines.join("\n"));
  const relPath = path.relative(cwd, file);
  await appendDevlog(cwd, `Handoff généré : ${relPath}`);
  return relPath;
}

export async function readMemorySummary(cwd: string): Promise<string> {
  const files = ["decisions.md", "limits.md"];
  const parts: string[] = [];
  for (const f of files) {
    const p = memoryPath(cwd, f);
    if (existsSync(p)) {
      parts.push(await readFile(p, "utf8"));
    }
  }
  return parts.join("\n\n");
}

/** Full decision journal for the interactive /decisions reader. */
export async function readDecisions(cwd: string): Promise<string | null> {
  const file = memoryPath(cwd, "decisions.md");
  return existsSync(file) ? readFile(file, "utf8") : null;
}

/**
 * Idempotent: creates .claudex/memory/*.md and wires CLAUDE.md / AGENTS.md to
 * point at them, without clobbering existing project instructions.
 */
export async function initMemoryScaffold(cwd: string): Promise<{ created: string[] }> {
  await ensureMemoryDir(cwd);
  const created: string[] = [];

  // Written before anything else. Claudex starts recording debates inside the
  // user's own repository, so without this the first `git add .` sweeps a full
  // transcript of their internal discussions into a commit — possibly their
  // employer's. Curated memory (decisions, limits) stays committable on
  // purpose: it is small, deliberate, and the file CLAUDE.md/AGENTS.md point at.
  const ignorePath = path.join(cwd, ".claudex", ".gitignore");
  if (!existsSync(ignorePath)) {
    await writeFile(ignorePath, CLAUDEX_GITIGNORE, "utf8");
    created.push(".claudex/.gitignore");
  }

  const scaffolds: [string, string][] = [
    [
      memoryPath(cwd, "decisions.md"),
      "# Décisions\n\nJournal des décisions validées à l'issue d'un débat Claude ↔ Codex.\n",
    ],
    [memoryPath(cwd, "devlog.md"), "# Devlog\n\nJournal des sessions Claudex.\n"],
    [
      memoryPath(cwd, "limits.md"),
      "# Limites connues\n\nContraintes, boundaries et choses explicitement écartées.\n",
    ],
  ];

  for (const [file, content] of scaffolds) {
    if (!existsSync(file)) {
      await writeFile(file, content, "utf8");
      created.push(path.relative(cwd, file));
    }
  }

  const claudeMdPath = path.join(cwd, "CLAUDE.md");
  const agentsMdPath = path.join(cwd, "AGENTS.md");

  if (!existsSync(claudeMdPath)) {
    await writeFile(claudeMdPath, claudeMdTemplate(), "utf8");
    created.push("CLAUDE.md");
  } else {
    const contents = await readFile(claudeMdPath, "utf8");
    if (!contents.includes(MEMORY_MARKER)) {
      await appendFile(claudeMdPath, `\n${claudeMdMemorySection()}\n`, "utf8");
      created.push("CLAUDE.md (mémoire ajoutée)");
    }
  }

  if (!existsSync(agentsMdPath)) {
    await writeFile(agentsMdPath, agentsMdTemplate(), "utf8");
    created.push("AGENTS.md");
  } else {
    const contents = await readFile(agentsMdPath, "utf8");
    if (!contents.includes(MEMORY_MARKER)) {
      await appendFile(agentsMdPath, `\n${agentsMdMemorySection()}\n`, "utf8");
      created.push("AGENTS.md (mémoire ajoutée)");
    }
  }

  return { created };
}

/**
 * Named, not imported. `@fichier` inlines the whole file into Claude's system
 * prompt on every single call, so the project memory was re-billed at each tool
 * use of each turn while Codex, pointed at the same files by AGENTS.md, paid
 * only for what it chose to read. Pointing at them restores the symmetry.
 */
function claudeMdMemorySection(): string {
  return [
    "## Mémoire du projet (Claudex)",
    "",
    "Avant de proposer une architecture ou une décision, lis ces fichiers :",
    "- `.claudex/memory/decisions.md` — décisions déjà actées",
    "- `.claudex/memory/limits.md` — contraintes et choses explicitement écartées",
    "- `.claudex/memory/devlog.md` — index des sessions passées",
    "",
    "Ne remets pas en question une décision déjà actée sans le signaler explicitement et sans raison nouvelle.",
  ].join("\n");
}

function agentsMdMemorySection(): string {
  return [
    "## Mémoire du projet (Claudex)",
    "",
    "Avant de proposer une architecture ou une décision, lis ces fichiers :",
    "- `.claudex/memory/decisions.md` — décisions déjà actées",
    "- `.claudex/memory/devlog.md` — historique des sessions",
    "- `.claudex/memory/limits.md` — contraintes et choses explicitement écartées",
    "",
    "Ne remets pas en question une décision déjà actée sans le signaler explicitement et sans raison nouvelle.",
  ].join("\n");
}

function claudeMdTemplate(): string {
  return [
    "# Projet",
    "",
    "Ce projet est développé avec Claudex : Claude Code et Codex y travaillent en binôme, en débat structuré jusqu'à consensus avant toute écriture de code, sous supervision humaine directe.",
    "",
    claudeMdMemorySection(),
    "",
  ].join("\n");
}

function agentsMdTemplate(): string {
  return [
    "# Agents",
    "",
    "Ce projet est développé avec Claudex : Claude Code et Codex y travaillent en binôme, en débat structuré jusqu'à consensus avant toute écriture de code, sous supervision humaine directe.",
    "",
    agentsMdMemorySection(),
    "",
  ].join("\n");
}
