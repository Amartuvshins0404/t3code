import { ThreadId, type ProjectPlantStatus } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { plantButtonState } from "./ProjectPlantButton.logic";

const threadId = ThreadId.make("project-plant:open");
const openThread = { threadId };
const archivedOpenThread = { threadId, archived: true as const };

describe("plantButtonState", () => {
  it.each<{
    readonly name: string;
    readonly status: ProjectPlantStatus | null;
    readonly openThreadKnown: boolean;
    readonly expected: ReturnType<typeof plantButtonState>["kind"];
  }>([
    {
      name: "not planted, open thread the client knows",
      status: { _tag: "not_planted", openThread },
      openThreadKnown: true,
      expected: "open",
    },
    {
      name: "planted, open thread the client knows",
      status: { _tag: "planted", openThread },
      openThreadKnown: true,
      expected: "open",
    },
    {
      name: "not planted, open thread the client does not know",
      status: { _tag: "not_planted", openThread },
      openThreadKnown: false,
      expected: "plant",
    },
    {
      name: "planted, open thread the client does not know",
      status: { _tag: "planted", openThread },
      openThreadKnown: false,
      expected: "unplant",
    },
    {
      name: "not planted, no open thread",
      status: { _tag: "not_planted", openThread: null },
      openThreadKnown: false,
      expected: "plant",
    },
    {
      name: "planted, no open thread",
      status: { _tag: "planted", openThread: null },
      openThreadKnown: false,
      expected: "unplant",
    },
    {
      name: "blocked",
      status: { _tag: "blocked", file: ".github/workflows/merge-lane.yml" },
      openThreadKnown: false,
      expected: "disabled",
    },
    {
      name: "unavailable",
      status: { _tag: "unavailable", reason: "no_remote" },
      openThreadKnown: false,
      expected: "disabled",
    },
    {
      name: "not planted, archived open thread the client does not know",
      status: { _tag: "not_planted", openThread: archivedOpenThread },
      openThreadKnown: false,
      expected: "open",
    },
    {
      name: "planted, archived open thread the client does not know",
      status: { _tag: "planted", openThread: archivedOpenThread },
      openThreadKnown: false,
      expected: "open",
    },
    { name: "still reading", status: null, openThreadKnown: false, expected: "disabled" },
  ])("$name gives $expected", ({ status, openThreadKnown, expected }) => {
    const state = plantButtonState({ status, error: null, permitted: true, openThreadKnown });
    expect(state.kind).toBe(expected);
    if (state.kind === "open") expect(state.threadId).toBe(threadId);
  });

  it("is disabled without permission or after a failed read, whatever the status", () => {
    const status: ProjectPlantStatus = { _tag: "not_planted", openThread };
    expect(
      plantButtonState({ status, error: null, permitted: false, openThreadKnown: true }).kind,
    ).toBe("disabled");
    expect(
      plantButtonState({ status, error: "offline", permitted: true, openThreadKnown: true }).kind,
    ).toBe("disabled");
  });
});
