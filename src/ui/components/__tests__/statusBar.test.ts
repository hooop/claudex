import { describe, expect, it } from "vitest";
import { displayWidth } from "../../stream/lineBuffer.js";
import { AGENT_STYLE } from "../../theme.js";
import {
  describeActivity,
  fitActivityDescription,
  flattenActivityLabel,
  STATUS_BAR_RIGHT_INSET,
  statusBarWidth,
} from "../StatusBar.js";

describe("StatusBar activity formatting", () => {
  it("aplatit les commandes multiligne et retire les séquences terminal", () => {
    expect(flattenActivityLabel("npm test\n  --run\t\u001b[2J maintenant")).toBe(
      "npm test --run maintenant",
    );
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
    const fixedWidth = displayWidth("débat  ·  ") + 2 + displayWidth("Claude ");

    expect(STATUS_BAR_RIGHT_INSET).toBe(3);
    expect(statusBarWidth(width)).toBe(77);
    expect(fitted).toMatch(/\.\.\.$/);
    expect(fixedWidth + displayWidth(fitted)).toBeLessThanOrEqual(statusBarWidth(width));
  });
});
