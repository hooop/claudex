import { renderToString } from "ink";
import { createElement } from "react";
import { describe, expect, it } from "vitest";
import { displayWidth } from "../../stream/lineBuffer.js";
import { AGENT_STYLE } from "../../theme.js";
import {
  describeActivity,
  fitActivityDescription,
  flattenActivityLabel,
  STATUS_BAR_RIGHT_INSET,
  StatusBar,
  statusBarWidth,
} from "../StatusBar.js";

const ANSI_SEQUENCE = /\u001b\[[0-?]*[ -/]*[@-~]/g;

describe("StatusBar activity formatting", () => {
  it("aplatit les commandes multiligne et retire les séquences terminal", () => {
    expect(flattenActivityLabel("npm test\n  --run\t\u001b[2J maintenant")).toBe(
      "npm test --run maintenant",
    );
    expect(flattenActivityLabel("✅ terminé 🚀")).toBe("[ok] terminé");
  });

  it("résume plusieurs commandes sur la même ligne", () => {
    expect(
      describeActivity({
        kind: "command",
        status: "running",
        label: "npm test",
        activeCount: 3,
      }),
    ).toBe("3 commandes en cours · $ npm test");
  });

  it("garde un résultat compact jusqu'à l'activité suivante", () => {
    expect(
      describeActivity({
        kind: "command",
        status: "failure",
        label: "npm test",
        durationMs: 8_200,
        exitCode: 1,
      }),
    ).toBe("$ npm test · 8,2 s · code 1");
  });

  it("utilise les nouveaux noms et index ANSI des agents", () => {
    expect(AGENT_STYLE.claude).toEqual({ color: "ansi256(210)", badge: "Claude" });
    expect(AGENT_STYLE.codex).toEqual({ color: "ansi256(159)", badge: "Codex" });
  });

  it("coupe une commande avant le bord droit du prompt avec trois points", () => {
    const width = 80;
    const fitted = fitActivityDescription(
      "debate",
      "claude",
      {
        kind: "command",
        status: "running",
        label: "npm test --run une-suite-de-tests-particulièrement-longue ".repeat(3),
      },
      width,
    );
    const fixedWidth = 2 + displayWidth("Claude ");

    expect(STATUS_BAR_RIGHT_INSET).toBe(3);
    expect(statusBarWidth(width)).toBe(77);
    expect(fitted).toMatch(/\.\.\.$/);
    expect(fixedWidth + displayWidth(fitted)).toBeLessThanOrEqual(statusBarWidth(width));
  });

  it("réserve la largeur du statut ASCII", () => {
    const width = 50;
    const fitted = fitActivityDescription(
      "implementation",
      "codex",
      { kind: "tool", status: "success", label: "une activité très longue ".repeat(5) },
      width,
    );
    const fixedWidth = displayWidth("Implémentation  ·  [ok] Codex ");

    expect(fixedWidth + displayWidth(fitted)).toBeLessThanOrEqual(statusBarWidth(width));
  });

  it("n'affiche rien au repos pendant le débat", () => {
    const output = renderToString(
      createElement(StatusBar, {
        phase: "debate",
        thinkingAgent: null,
        activity: null,
        paused: false,
        width: 80,
      }),
    ).replace(ANSI_SEQUENCE, "");

    expect(output).toBe("");
    expect(output).not.toContain("Claude");
    expect(output).not.toContain("Codex");
  });

  it("commence directement par l'agent pendant une activité de débat", () => {
    const output = renderToString(
      createElement(StatusBar, {
        phase: "debate",
        thinkingAgent: "claude",
        activity: { kind: "tool", status: "success", label: "Read" },
        paused: false,
        width: 80,
      }),
    ).replace(ANSI_SEQUENCE, "");

    expect(output).toBe("[ok] Claude Read");
    expect(output).not.toContain("Débat");
  });

  it("conserve les agents dans la phase d'implémentation", () => {
    const output = renderToString(
      createElement(StatusBar, {
        phase: "implementation",
        thinkingAgent: null,
        activity: null,
        paused: false,
        width: 80,
      }),
    ).replace(ANSI_SEQUENCE, "");

    expect(output).toBe("Implémentation  ·  Claude + Codex");
  });
});
