import { Box, Text, usePaste, useInput } from "ink";
import { useRef } from "react";
import { formatSettingValue, type SettingsFinding } from "../../agents/projectSettings.js";
import { RENDER_OPTIONS } from "../../renderOptions.js";

// The findings are printed as plain text before this prompt, so the prompt
// must stay in the normal screen: the alternate screen would hide that text,
// and anything longer than the terminal would be lost from scrollback.
export const CONSENT_RENDER_OPTIONS = { ...RENDER_OPTIONS, alternateScreen: false };

// Keys typed before the prompt appeared (typeahead) must not answer it.
const INPUT_DELAY_MS = 250;

const TITLE =
  "This project's Claude Code settings ask Claude Code to run these commands or apply these settings during Claude sessions. Claudex cannot disable them.";

const FIX_UNREADABLE =
  "Claudex cannot read what would need approving: fix .claude/settings.json so Claudex can read it, then restart Claudex.";

function hasUnreadable(findings: readonly SettingsFinding[]): boolean {
  return findings.some((finding) => finding.kind === "unreadable");
}

function plural(count: number, word: string): string {
  return `${count} ${word}${count > 1 ? "s" : ""}`;
}

function summaryLine(findings: readonly SettingsFinding[]): string {
  const parts: string[] = [];
  const readable = findings.flatMap((f) => (f.kind === "entries" ? [f] : []));
  if (readable.length > 0) {
    const entries = readable.reduce((sum, f) => sum + f.entries.length, 0);
    parts.push(`${plural(entries, "setting")} in ${plural(readable.length, "file")}`);
  }
  const unreadable = findings.length - readable.length;
  if (unreadable > 0) parts.push(plural(unreadable, "unreadable file"));
  return `${parts.join(", ")} — scroll up to reread everything if needed.`;
}

/**
 * The full list, written once to stdout before the prompt so it stays in the
 * terminal's scrollback whatever its length. Keys and reasons arrive already
 * escaped; values go through formatSettingValue so a value cannot rewrite the
 * terminal.
 */
export function formatConsentText(findings: readonly SettingsFinding[]): string {
  const lines = [TITLE];
  for (const finding of findings) {
    lines.push("", finding.file);
    if (finding.kind === "entries") {
      for (const entry of finding.entries) lines.push(`  ${entry.key} = ${formatSettingValue(entry.value)}`);
    } else {
      lines.push(`  unreadable: ${finding.reason}`);
    }
  }
  if (hasUnreadable(findings)) lines.push("", FIX_UNREADABLE);
  lines.push("", summaryLine(findings));
  return lines.join("\n");
}

export function SettingsConsent(props: {
  findings: readonly SettingsFinding[];
  onDecide: (accept: boolean) => void;
  now?: () => number;
}) {
  const { findings, onDecide, now = Date.now } = props;
  const mountedAt = useRef(now());
  // Approving a file Claudex cannot parse would approve content nobody saw,
  // and Claude Code may still parse it (comments, BOM).
  const canAccept = !hasUnreadable(findings);

  // Registered only so that pasted text goes to this no-op instead of useInput.
  usePaste(() => {});

  useInput((input, key) => {
    if (now() - mountedAt.current < INPUT_DELAY_MS) return;
    // Quitting is the default: Enter, Escape and Ctrl+C refuse, so a reflex
    // keystroke can never consent. RENDER_OPTIONS disables Ink's own Ctrl+C.
    if ((input === "y" || input === "Y") && !key.meta && !key.ctrl) {
      if (canAccept) onDecide(true);
    } else if (input === "n" || input === "q" || key.return || key.escape || (key.ctrl && input === "c")) {
      onDecide(false);
    }
  });

  return (
    <Box flexDirection="column" paddingX={1}>
      <Text wrap="wrap">{summaryLine(findings)}</Text>
      {canAccept ? null : <Text wrap="wrap">{FIX_UNREADABLE}</Text>}
      <Text wrap="wrap">
        {canAccept ? (
          <>
            <Text color="greenBright">[y]</Text> continue with these settings ·{" "}
          </>
        ) : null}
        <Text color="redBright">[n]</Text> quit
      </Text>
    </Box>
  );
}
