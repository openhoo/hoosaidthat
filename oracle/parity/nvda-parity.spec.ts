import { readFileSync } from "node:fs";
import {
  expect,
  SCREEN_READER_ACTIONS,
  test,
  type ScreenReaderAction,
  type ScreenReaderSession,
} from "@openhoo/hoosaidthat";

const coverage = JSON.parse(
  readFileSync(new URL("./coverage.json", import.meta.url), "utf8"),
) as {
  scenarios: Record<string, ScreenReaderAction[]>;
  pinnedBackendBoundaries: Array<{ actions: ScreenReaderAction[] }>;
};
const coveredActions = new Set(Object.values(coverage.scenarios).flat());
const pinnedBackendBoundaries = new Set(
  coverage.pinnedBackendBoundaries.flatMap(({ actions }) => actions),
);
const allActions = Object.keys(SCREEN_READER_ACTIONS) as ScreenReaderAction[];
const selectedActions = parseSelectedActions(
  process.env.HOOSAIDTHAT_NVDA_PARITY_ACTIONS,
);
const settingsOnly = process.env.HOOSAIDTHAT_NVDA_PARITY_SETTINGS === "1";
const artifactsOnly = process.env.HOOSAIDTHAT_NVDA_PARITY_ARTIFACTS === "1";
const coreOnly = process.env.HOOSAIDTHAT_NVDA_PARITY_CORE === "1";
const coreTest =
  settingsOnly ||
  artifactsOnly ||
  (!coreOnly && selectedActions.length !== allActions.length)
    ? test.skip
    : test;
const actionsTest =
  settingsOnly || artifactsOnly || coreOnly ? test.skip : test;
const settingsTest =
  artifactsOnly ||
  coreOnly ||
  (!settingsOnly && selectedActions.length !== allActions.length)
    ? test.skip
    : test;
const artifactsTest = artifactsOnly ? test : test.skip;

test("coverage manifest exactly covers advertised profile", async ({
  screenReaderClient,
}) => {
  expect([...coveredActions].sort()).toEqual([...allActions].sort());
  const capabilities = await screenReaderClient.capabilities();
  expect(capabilities.actions.map(({ action }) => action).sort()).toEqual(
    [...allActions].sort(),
  );
});

coreTest(
  "reference profile presents core speech, braille, details, table, and live-region behavior",
  async ({ page, screenReader }) => {
    await installFixture(page);
    await screenReader.returnToPage();
    await screenReader.ensureBrowseMode();
    await screenReader.documentStart();

    const heading = await screenReader.nextHeading();
    expect(heading.speech).toMatch(/Checkout.*(heading|Überschrift)/iu);
    expect(heading.braille).toContain("Checkout");

    const detailsButton = page.getByRole("button", { name: "Details action" });
    const focus = await focusFixture(
      screenReader,
      detailsButton,
      "Focus details fixture",
    );
    expect(focus.speech).toMatch(/Details action.*(button|Schalter)/iu);
    const details = await screenReader.reportDetails();
    expect(details.speech).toContain("Pinned details text");
    expect(details.braille).toContain("Pinned details text");

    await screenReader.documentStart();
    const table = await screenReader.act("nextTable");
    expect(table.speech).toMatch(/Parity table.*(table|Tabelle)/iu);
    await screenReader.act("nextLine");
    const row = await screenReader.act("nextTableRow");
    expect(row.speech).toMatch(/Alpha|Beta/u);

    const liveButton = page.getByRole("button", { name: "Update live region" });
    await focusFixture(screenReader, liveButton, "Focus live-region fixture");
    const live = await screenReader.activate();
    expect(live.speech).toContain("Parity live update");
    expect(live.braille).toContain("Parity live update");
    expect(
      live.events.some(
        (event) =>
          event.kind === "liveRegion" &&
          event.text.includes("Parity live update"),
      ),
      "semantic live-region event",
    ).toBe(true);
  },
);

coreTest(
  "live regions preserve priority, atomicity, relevance, busy suppression, and interruption order",
  async ({ page, screenReader }) => {
    await installFixture(page);
    await screenReader.returnToPage();
    await screenReader.ensureBrowseMode();

    const polite = await screenReader.observe(
      "Polite live-region update",
      async () => {
        await page.locator("#politeLive").evaluate((element) => {
          element.textContent = "Parity polite update";
        });
      },
    );
    expectLiveRegion(polite, "Parity polite update", "polite");

    const atomic = await screenReader.observe(
      "Atomic live-region update",
      async () => {
        await page.locator("#atomicValue").evaluate((element) => {
          element.textContent = "ready";
        });
      },
    );
    expectLiveRegion(atomic, /Atomic total.*ready/iu, "polite");

    const addition = await screenReader.observe(
      "Relevant addition",
      async () => {
        await page.locator("#relevantLive").evaluate((element) => {
          const item = document.createElement("span");
          item.id = "relevantItem";
          item.textContent = "Parity relevant addition";
          element.append(item);
        });
      },
    );
    expectLiveRegion(addition, "Parity relevant addition", "polite");

    const ignoredText = await screenReader.observe(
      "Ignored irrelevant text change",
      async () => {
        await page.locator("#relevantItem").evaluate((element) => {
          const textNode = element.firstChild;
          if (!textNode)
            throw new Error("relevant fixture text node is absent");
          textNode.textContent = "Parity irrelevant text change";
        });
        await page.getByRole("button", { name: "Details action" }).focus();
      },
    );
    expect(
      ignoredText.events.some(
        (event) => event.kind === "liveRegion" && event.text.trim().length > 0,
      ),
    ).toBe(false);
    expect(ignoredText.speech).not.toContain("Parity irrelevant text change");

    await page.locator("#busyLive").evaluate((element) => {
      element.setAttribute("aria-busy", "true");
    });
    const busy = await screenReader.observe(
      "Busy live-region suppression",
      async () => {
        await page.locator("#busyLive").evaluate((element) => {
          element.textContent = "Parity busy update";
        });
        await page.getByRole("button", { name: "Activate action" }).focus();
      },
    );
    expect(
      busy.events.some(
        (event) =>
          event.kind === "liveRegion" &&
          event.text.includes("Parity busy update"),
      ),
    ).toBe(false);
    await page.locator("#busyLive").evaluate((element) => {
      element.setAttribute("aria-busy", "false");
    });

    const interruption = await screenReader.observe(
      "Assertive live-region interruption",
      async () => {
        await page.locator("#politeLive").evaluate((element) => {
          element.textContent = "Parity polite before interruption";
        });
        await page.locator("#assertiveLive").evaluate((element) => {
          element.textContent = "Parity assertive interruption";
        });
      },
    );
    expectLiveRegion(
      interruption,
      "Parity assertive interruption",
      "assertive",
    );
    const assertiveSequence = interruption.events.find(
      (event) =>
        event.kind === "liveRegion" &&
        event.text.includes("Parity assertive interruption"),
    )?.sequence;
    const politeSequence = interruption.events.find(
      (event) =>
        event.kind === "liveRegion" &&
        event.text.includes("Parity polite before interruption"),
    )?.sequence;
    if (politeSequence !== undefined) {
      expect(assertiveSequence).toBeGreaterThan(politeSequence);
    }
  },
);

actionsTest(
  "every declared web-profile command executes through selected adapter",
  async ({ page, screenReader }) => {
    const executed = new Set<ScreenReaderAction>();

    for (const action of selectedActions) {
      await installFixture(page);
      await screenReader.returnToPage();
      await screenReader.ensureBrowseMode();
      await prepareAction(page, screenReader, action);
      const observation =
        action === "returnToPage"
          ? await verifiedReturnToPage(screenReader)
          : action === "find"
            ? await screenReader.findText("Parity needle")
            : action === "brailleRoute"
              ? await screenReader.brailleRoute(0)
              : action === "brailleReportFormatting"
                ? await screenReader.brailleFormatting(0)
                : await screenReader.act(action);
      expect(observation.timedOut, action).toBe(false);
      expect(
        observation.events.some(
          (event) =>
            event.kind === "commandStarted" && event.command === action,
        ),
        `${action} command-start evidence`,
      ).toBe(true);
      expect(
        observation.events.every((event) => event.provenance !== undefined),
        `${action} event provenance`,
      ).toBe(true);
      expect(
        observation.events.some(
          (event) =>
            event.kind === "commandSettled" && event.command === action,
        ),
        `${action} command-settle evidence`,
      ).toBe(true);
      expect(
        observation.events.some(
          (event) =>
            event.kind === "commandSettled" &&
            event.command === action &&
            event.reason === "completed",
        ),
        `${action} completed evidence`,
      ).toBe(true);
      assertSemanticOutput(action, observation.speech, observation.braille);
      if (
        action === "stopSpeech" ||
        action === "pauseSpeech" ||
        action === "cycleSpeechMode"
      ) {
        const state = await screenReader.state();
        expect(state.speech, `${action} speech state`).toBeDefined();
        if (action === "stopSpeech") expect(state.speech?.paused).toBe(false);
        if (action === "pauseSpeech") expect(state.speech?.paused).toBe(true);
        if (action === "cycleSpeechMode")
          expect(state.speech?.mode).not.toBe("talk");
      }
      if (action === "leftMouseClick") {
        const state = await screenReader.state();
        const events =
          (await page.locator("body").getAttribute("data-mouse-events")) ?? "";
        const geometry = await page
          .locator("body")
          .getAttribute("data-mouse-geometry");
        expect(
          events,
          `native left-click events; ${JSON.stringify({ state, geometry })}`,
        ).toContain("click:mouseButton");
        await expect(page.locator("#live")).toHaveText("Parity mouse clicked");
      }
      if (action === "rightMouseClick") {
        await expect(page.locator("#live")).toHaveText("Parity context opened");
      }
      if (action === "moveMouseToNavigatorObject") {
        const state = await screenReader.state();
        expect(
          state.mouse?.object?.name,
          `NVDA mouse target after command: ${JSON.stringify(state)}`,
        ).toBe("Mouse action");
      }
      executed.add(action);

      if (action === "elementsList") await screenReader.act("escape");
      if (action === "toggleFocusMode")
        await screenReader.act("toggleFocusMode");
      if (action === "toggleSingleLetterNavigation") {
        await screenReader.act("toggleSingleLetterNavigation");
      }
      if (action === "toggleNativeSelection") {
        await screenReader.act("toggleNativeSelection");
      }
      if (action === "leftMouseLock" || action === "rightMouseLock") {
        await screenReader.act(action);
      }
      if (
        [
          "leftMouseClick",
          "leftMouseLock",
          "rightMouseClick",
          "rightMouseLock",
          "moveMouseToNavigatorObject",
          "moveNavigatorToMouseObject",
        ].includes(action)
      ) {
        await screenReader.act("nextReviewMode");
      }
      if (action === "pauseSpeech") await screenReader.act("pauseSpeech");
      if (action === "cycleSpeechMode") {
        await screenReader.act("cycleSpeechMode");
        await screenReader.act("cycleSpeechMode");
        await screenReader.act("cycleSpeechMode");
      }
      if (action === "brailleToggleTether") {
        await screenReader.act("brailleToggleTether");
        await screenReader.act("brailleToggleTether");
      }
    }
    expect([...executed].sort()).toEqual([...selectedActions].sort());
  },
);

settingsTest(
  "selected adapter applies and resets session presentation settings",
  async ({ page, screenReader }) => {
    await installFixture(page);
    await screenReader.returnToPage();
    await screenReader.ensureBrowseMode();
    const ariaSnapshot = await screenReader.captureAriaSnapshot("privacy");
    expect(ariaSnapshot).not.toContain("DO_NOT_LEAK_PARITY_SECRET");
    expect(ariaSnapshot).toContain("[redacted]");
    const baseline = await screenReader.presentationSettings();
    try {
      const changed = await screenReader.setPresentationSettings({
        ...baseline,
        speechSymbolLevel: "all",
        brailleTether: "review",
        reportHeadings: false,
      });
      expect(changed.speechSymbolLevel).toBe("all");
      expect(changed.brailleTether).toBe("review");
      expect(changed.reportHeadings).toBe(false);
      expect(await screenReader.presentationSettings()).toEqual(changed);

      await screenReader.documentStart();
      const suppressed = await screenReader.nextHeading();
      expect(suppressed.speech).toContain("Checkout parity");
      expect(suppressed.speech).not.toMatch(
        /heading|Überschrift|level\s+1|Ebene\s+1/iu,
      );

      const reset = await screenReader.resetPresentationSettings();
      expect(reset).toEqual(baseline);
      await screenReader.documentStart();
      const restored = await screenReader.nextHeading();
      expect(restored.speech).toMatch(
        /Checkout parity.*(?:heading|Überschrift)/iu,
      );

      const password = await screenReader.focus(
        page.getByLabel("Parity password"),
      );
      expect(JSON.stringify(password.events)).not.toContain(
        "DO_NOT_LEAK_PARITY_SECRET",
      );
      expect(
        password.events.some(
          (event) =>
            (event.kind === "speech" ||
              event.kind === "braille" ||
              event.kind === "focus") &&
            event.redacted === true,
        ),
        "protected-output provenance",
      ).toBe(true);
    } finally {
      await screenReader.resetPresentationSettings();
    }
  },
);

artifactsTest(
  "selected adapter exports stable element images and full-page screen-reader evidence",
  async ({ page, screenReader }) => {
    await installFixture(page);
    await screenReader.returnToPage();
    await screenReader.ensureBrowseMode();

    const captures = await screenReader.captureElements([
      {
        name: "details-button",
        locator: page.getByRole("button", { name: "Details action" }),
      },
      {
        name: "parity-checkbox",
        locator: page.getByRole("checkbox", { name: "Parity check" }),
      },
    ]);
    expect(captures).toHaveLength(2);
    expect(captures[0]?.speech).toMatch(
      /Details action.*(?:button|Schalter)/iu,
    );
    expect(captures[1]?.speech).toMatch(/Parity check/iu);

    const results = await screenReader.capturePageElements({
      maxPerKind: 25,
      screenshots: true,
    });
    for (const result of Object.values(results)) {
      expect(result.screenshots).toHaveLength(result.observations.length);
    }
    expect(results.headings?.observations.length).toBeGreaterThanOrEqual(6);
    expect(results.buttons?.observations.length).toBeGreaterThanOrEqual(3);
    expect(results["form-fields"]?.observations.length).toBeGreaterThanOrEqual(
      4,
    );
    expect(results.lists?.observations.length).toBeGreaterThanOrEqual(1);
    expect(results.tables?.observations.length).toBeGreaterThanOrEqual(1);
    expect(results.graphics?.observations.length).toBeGreaterThanOrEqual(1);
    expect(JSON.stringify(results)).not.toContain("DO_NOT_LEAK_PARITY_SECRET");
  },
);

function parseSelectedActions(value: string | undefined): ScreenReaderAction[] {
  if (!value?.trim()) return allActions;
  const actions = value.split(",").map((item) => item.trim());
  if (
    actions.length === 0 ||
    new Set(actions).size !== actions.length ||
    actions.some((action) => !allActions.includes(action as ScreenReaderAction))
  ) {
    throw new Error(
      "HOOSAIDTHAT_NVDA_PARITY_ACTIONS must list unique advertised actions",
    );
  }
  return actions as ScreenReaderAction[];
}

function assertSemanticOutput(
  action: ScreenReaderAction,
  speech: string,
  braille: string,
): void {
  if (action === "returnToPage") return;
  if (action === "stopSpeech" || action === "pauseSpeech") {
    expect(speech, `${action} must not enqueue speech`).toBe("");
    return;
  }
  const output = `${speech}\n${braille}`.trim();
  const expected = semanticExpectations.get(action);
  expect(expected, `${action} semantic expectation`).toBeDefined();
  expect
    .soft(output, `${action} screen-reader presentation`)
    .toMatch(expected!);
  if (!pinnedBackendBoundaries.has(action)) {
    expect
      .soft(output, `${action} must not hit a fixture or navigation failure`)
      .not.toMatch(
        /Not in a table cell|Nicht in einer Tabellenzelle|no (?:next|previous|more) |not found|0 matches|Keine (?:nächste|vorherige)|nicht gefunden/iu,
      );
  }
}

async function focusFixture(
  screenReader: ScreenReaderSession,
  locator: Parameters<ScreenReaderSession["focus"]>[0],
  label = "Focus parity fixture",
) {
  return await screenReader.observe(
    label,
    async () => locator.focus(),
    "focus",
  );
}

async function verifiedReturnToPage(
  screenReader: ScreenReaderSession,
): Promise<NonNullable<ReturnType<ScreenReaderSession["lastObservation"]>>> {
  await screenReader.returnToPage();
  const observation = screenReader.lastObservation();
  expect(observation?.action).toBe("returnToPage");
  return observation!;
}

async function prepareAction(
  page: Parameters<typeof installFixture>[0],
  screenReader: ScreenReaderSession,
  action: ScreenReaderAction,
): Promise<void> {
  await page.bringToFront();
  if (action === "returnToPage") {
    // Enter browser chrome through NVDA first. The public returnToPage helper
    // must then prove it can cycle back to web content, possibly across more
    // than one browser-chrome stop.
    await screenReader.act("returnToPage");
  } else if (action === "escape") {
    await screenReader.documentStart();
    await screenReader.act("elementsList");
  } else if (
    action === "nextFocusable" ||
    action === "readCurrent" ||
    action === "reportDetails"
  ) {
    await focusFixture(
      screenReader,
      page.getByRole("button", { name: "Details action" }),
    );
  } else if (action === "reportShortcutKey") {
    await focusFixture(
      screenReader,
      page.getByRole("button", { name: "Details action" }),
    );
  } else if (action === "reportTextSelection") {
    await screenReader.observe("Select text in entry", async () => {
      await page.getByLabel("Parity entry").selectText();
    });
  } else if (
    action === "reportCurrentLine" ||
    action === "reportLanguage" ||
    action === "reportCaretLocation"
  ) {
    await screenReader.documentStart();
    await screenReader.findText("Parity language sample");
  } else if (action === "reportTextFormatting") {
    await screenReader.documentStart();
    await screenReader.findText("Parity formatted sample");
  } else if (action === "reportLinkDestination") {
    await screenReader.documentStart();
    await screenReader.findText("Parity destination link");
  } else if (
    action === "sayAllTableColumn" ||
    action === "sayAllTableRow" ||
    action === "readTableColumn" ||
    action === "readTableRow"
  ) {
    await screenReader.documentStart();
    await screenReader.act("nextTable");
    await screenReader.act("nextLine");
  } else if (
    [
      "reportCurrentObject",
      "moveToContainingObject",
      "moveToPreviousObject",
      "moveToPreviousObjectFlat",
      "moveToNextObject",
      "moveToNextObjectFlat",
      "moveToFirstContainedObject",
      "moveToFocusObject",
      "moveFocusToReviewPosition",
      "reportReviewLocation",
    ].includes(action)
  ) {
    const objectTarget = page.locator("#objectCurrent");
    await screenReader.observe(
      "Focus object navigation fixture",
      async () => objectTarget.focus(),
      "focus",
    );
    if (action === "moveToFirstContainedObject") {
      await screenReader.act("moveToContainingObject");
    } else if (action === "moveToFocusObject") {
      await screenReader.act("moveToPreviousObject");
    } else if (action === "moveFocusToReviewPosition") {
      await screenReader.act("moveToPreviousObject");
    }
  } else if (action === "activateNavigatorObject") {
    await focusFixture(
      screenReader,
      page.getByRole("button", { name: "Activate action" }),
    );
  } else if (
    [
      "leftMouseClick",
      "leftMouseLock",
      "rightMouseClick",
      "rightMouseLock",
      "moveMouseToNavigatorObject",
      "moveNavigatorToMouseObject",
    ].includes(action)
  ) {
    const mouseTarget = page.getByRole("button", { name: "Mouse action" });
    await mouseTarget.scrollIntoViewIfNeeded();
    await screenReader.observe(
      "Focus mouse target",
      async () => mouseTarget.focus(),
      "focus",
    );
    // NVDA's mouse-to-navigator script moves to the start of the review
    // position when one exists. Explicitly synchronize both navigator and
    // review state with system focus so a stale document-review position can
    // never send the pointer outside the browser before a real click.
    await screenReader.act("moveToFocusObject");
    // In NVDA document review, the review position is the virtual caret and
    // may legitimately differ from the focused object. Object review makes
    // this fixture target exact without bypassing NVDA's mouse command.
    await screenReader.act("previousReviewMode");
    if (action !== "moveMouseToNavigatorObject") {
      await screenReader.act("moveMouseToNavigatorObject");
    }
    if (action !== "moveMouseToNavigatorObject") {
      const state = await screenReader.state();
      const geometry = await mouseTarget.evaluate((element) => {
        const rect = element.getBoundingClientRect();
        return {
          innerWidth,
          innerHeight,
          outerWidth,
          outerHeight,
          screenWidth: screen.width,
          screenHeight: screen.height,
          availWidth: screen.availWidth,
          availHeight: screen.availHeight,
          rect: {
            left: rect.left,
            top: rect.top,
            right: rect.right,
            bottom: rect.bottom,
          },
          hit:
            (
              document.elementFromPoint(
                rect.left + rect.width / 2,
                rect.top + rect.height / 2,
              ) as HTMLElement | null
            )?.id ?? null,
        };
      });
      await page.locator("body").evaluate((body, value) => {
        body.dataset.mouseGeometry = JSON.stringify(value);
      }, geometry);
      expect(
        geometry.rect.bottom,
        `mouse target must fit native viewport: ${JSON.stringify(geometry)}`,
      ).toBeLessThanOrEqual(geometry.innerHeight);
      expect(
        state.mouse?.object?.name,
        `NVDA mouse target after mouse-to-navigator: ${JSON.stringify({ state, geometry })}`,
      ).toBe("Mouse action");
    }
    if (action === "moveNavigatorToMouseObject") {
      await screenReader.act("moveToPreviousObject");
    }
  } else if (action === "stopSpeech" || action === "pauseSpeech") {
    await screenReader.documentStart();
    await screenReader.act("sayAll");
  } else if (
    [
      "braillePanBack",
      "braillePanForward",
      "braillePreviousLine",
      "brailleNextLine",
      "brailleRoute",
      "brailleToggleTether",
      "brailleReportFormatting",
    ].includes(action)
  ) {
    const reviewText = page.locator("#reviewText");
    await reviewText.scrollIntoViewIfNeeded();
    await reviewText.evaluate((element) =>
      (element as HTMLTextAreaElement).setSelectionRange(11, 11),
    );
    await screenReader.observe(
      "Focus braille fixture",
      async () => reviewText.focus(),
      "focus",
    );
    if (action === "braillePanBack")
      await screenReader.act("braillePanForward");
  } else if (
    action.startsWith("review") ||
    action.endsWith("Review") ||
    action.includes("Review")
  ) {
    const reviewText = page.locator("#reviewText");
    let start = 11;
    let end = 11;
    if (action === "reviewLineStart") start = end = 17;
    if (action === "reviewPreviousCharacter") start = end = 12;
    if (action === "reviewSelectionStart" || action === "reviewSelectionEnd") {
      start = 11;
      end = 16;
    }
    await reviewText.evaluate(
      (element, range) =>
        (element as HTMLTextAreaElement).setSelectionRange(
          range.start,
          range.end,
        ),
      { start, end },
    );
    await screenReader.observe(
      "Focus review fixture",
      async () => reviewText.focus(),
      "focus",
    );
    if (
      action === "copyToReviewPosition" ||
      action === "moveToReviewCopyStart"
    ) {
      await screenReader.act("setReviewCopyStart");
      await screenReader.act("reviewNextWord");
    }
    if (action === "previousReviewMode")
      await screenReader.act("nextReviewMode");
  } else if (action === "activate") {
    await focusFixture(
      screenReader,
      page.getByRole("button", { name: "Activate action" }),
    );
  } else if (action === "previousFocusable" || action === "activateWithSpace") {
    await focusFixture(
      screenReader,
      page.getByRole("checkbox", { name: "Parity check" }),
    );
  } else if (
    action.includes("Table") &&
    action !== "nextTable" &&
    action !== "previousTable"
  ) {
    await screenReader.documentStart();
    await screenReader.act("nextTable");
    await screenReader.act("nextLine");
    if (action === "previousTableColumn")
      await screenReader.act("nextTableColumn");
    if (
      action === "previousTableRow" ||
      action === "firstTableColumn" ||
      action === "firstTableRow"
    ) {
      await screenReader.act("nextTableRow");
    }
    if (action === "firstTableColumn")
      await screenReader.act("nextTableColumn");
    if (action === "firstTableRow") await screenReader.act("nextTableRow");
  } else if (action === "previousParagraph") {
    await screenReader.documentStart();
    await screenReader.act("nextParagraph");
    await screenReader.act("nextParagraph");
  } else if (action === "previousLine") {
    await screenReader.documentStart();
    await screenReader.act("nextLine");
    await screenReader.act("nextLine");
  } else if (action === "previousParagraphText") {
    await screenReader.documentStart();
    await screenReader.act("nextParagraphText");
    await screenReader.act("nextParagraphText");
  } else if (
    action === "moveToContainerStart" ||
    action === "movePastContainerEnd"
  ) {
    await screenReader.documentStart();
    await screenReader.act("nextList");
    await screenReader.act("nextListItem");
  } else if (action === "exitEmbeddedObject") {
    await screenReader.observe(
      "Focus control inside embedded frame",
      async () => {
        await page
          .frameLocator('iframe[title="Parity frame"]')
          .getByRole("button", { name: "Frame action" })
          .focus();
      },
    );
  } else if (
    action === "nextVerticalParagraph" ||
    action === "previousVerticalParagraph"
  ) {
    await screenReader.documentStart();
    await screenReader.findText(
      action === "nextVerticalParagraph"
        ? "Parity aligned paragraph one"
        : "Parity aligned paragraph two",
    );
  } else if (action === "nextSameStyle" || action === "previousSameStyle") {
    await screenReader.documentStart();
    await screenReader.findText(
      action === "nextSameStyle"
        ? "Parity same style one"
        : "Parity same style two",
    );
  } else if (
    action === "nextDifferentStyle" ||
    action === "previousDifferentStyle"
  ) {
    await screenReader.documentStart();
    await screenReader.findText(
      action === "nextDifferentStyle"
        ? "Parity same style two"
        : "Parity different style",
    );
  } else if (action.startsWith("previous") || action === "documentEnd") {
    await screenReader.documentEnd();
  } else if (action === "findNext" || action === "findPrevious") {
    await screenReader.documentStart();
    await screenReader.findText("Parity needle");
    if (action === "findPrevious") await screenReader.act("findNext");
  } else {
    await screenReader.documentStart();
  }
}

async function installFixture(
  page: import("@playwright/test").Page,
): Promise<void> {
  const fixture = `
    <!doctype html><html lang="en"><head><meta charset="utf-8"><title>NVDA parity fixture</title></head>
    <body>
      <header><nav aria-label="Parity navigation">
        <a id="visitedLink" href="#visited-target">Parity visited link</a>
        <a href="#nav-1">Navigation link one</a><a href="#nav-2">Navigation link two</a>
        <a href="#nav-3">Navigation link three</a><a href="#nav-4">Navigation link four</a>
        <a href="#nav-5">Navigation link five</a><a href="#nav-6">Navigation link six</a>
      </nav></header>
      <main id="main">
        <h1 id="visited-target">Checkout parity</h1><h2>Level two</h2><h3>Level three</h3>
        <h4>Level four</h4><h5>Level five</h5><h6>Level six</h6>
        <div role="heading" aria-level="7">Level seven</div>
        <div role="heading" aria-level="8">Level eight</div>
        <div role="heading" aria-level="9">Level nine</div>
        <article role="article" aria-label="Parity article">Article accessibility content.</article>
        <figure aria-label="Parity figure"><figcaption>Parity figure caption</figcaption></figure>
        <fieldset aria-label="Parity grouping"><legend>Parity grouping</legend><span>Grouped content</span></fieldset>
        <div role="tablist" aria-label="Parity tabs"><button role="tab">Parity tab</button></div>
        <div role="menu" aria-label="Parity menu"><button role="menuitem">Parity menu item</button></div>
        <button aria-pressed="false">Parity toggle button</button>
        <progress aria-label="Parity progress" value="40" max="100">40%</progress>
        <a role="doc-biblioref" href="#reference-target">Parity reference</a>
        <div role="math" aria-label="Parity math formula">x plus y</div>
        <p id="aligned-one" tabindex="0" style="margin-left: 40px">Parity aligned paragraph one.</p>
        <p id="aligned-two" tabindex="0" style="margin-left: 40px">Parity aligned paragraph two.</p>
        <p><mark id="same-style-one">Parity same style one.</mark> First plain separator.</p>
        <p><mark id="same-style-two">Parity same style two.</mark> <span id="different-style">Parity different style.</span></p>
        <p><span lang="de-DE">Parity language sample.</span> <strong style="font-size: 24px">Parity formatted sample.</strong></p>
        <p>Parity needle first appears in this ordinary paragraph.</p>
        <p>Parity needle second occurrence.</p>
        <p>Parity needle third occurrence.</p>
        <a href="#other">Parity unvisited link</a>
        <a id="destinationLink" href="https://example.test/parity-destination">Parity destination link</a>
        <button aria-details="details" accesskey="x">Details action</button>
        <button id="activateButton">Activate action</button>
		<div role="note" aria-label="Object navigation group">
			<span id="objectPrevious" role="note" tabindex="0" aria-label="Object previous" style="display:inline-block;width:1px;height:1px"></span>
			<span id="objectCurrent" role="note" tabindex="0" aria-label="Object current" style="display:inline-block;width:1px;height:1px"></span>
			<span id="objectNext" role="note" tabindex="0" aria-label="Object next" style="display:inline-block;width:1px;height:1px"></span>
		</div>
        <div id="details" role="note">Pinned details text</div>
		<label>Parity entry <input type="text" value="Alpha beta"></label>
		<label>Parity password <input type="password" value="DO_NOT_LEAK_PARITY_SECRET"></label>
        <label><input type="checkbox"> Parity check</label>
        <label><input type="radio" name="choice"> Parity radio</label>
        <label>Parity select <select><option>One</option></select></label>
		<label>Review text <textarea id="reviewText" style="font-size:24px;font-weight:700">Alpha beta&#10;Gamma delta&#10;Omega last</textarea></label>
        <ul><li>First list item</li><li>Second list item</li></ul>
        <table><caption>Parity table</caption><thead><tr><th>Column A</th><th>Column B</th></tr></thead>
          <tbody><tr><td>Alpha</td><td>Beta</td></tr><tr><td>Gamma</td><td>Delta</td></tr></tbody></table>
        <img alt="Parity graphic" src="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg'/%3E">
        <hr><blockquote>Parity block quote</blockquote>
        <p><ins>Parity annotation insertion</ins></p>
        <p><mark aria-details="annotation">Annotated details target</mark></p>
        <div id="annotation" role="comment" aria-label="Parity annotation">Annotation text</div>
        <label>Spelling fixture <input aria-invalid="spelling" value="mispeling"></label>
        <object aria-label="Parity embedded object" type="image/svg+xml" data="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg'/%3E"></object>
        <iframe title="Parity frame" srcdoc="<!doctype html><button>Frame action</button><p>Frame paragraph</p>"></iframe>
		<button id="mouseButton">Mouse action</button>
        <button id="liveButton">Update live region</button><div id="live" role="alert"></div>
        <div id="politeLive" aria-live="polite"></div>
        <div id="atomicLive" aria-live="polite" aria-atomic="true">Atomic total <span id="atomicValue">pending</span></div>
        <div id="relevantLive" aria-live="polite" aria-relevant="additions"></div>
        <div id="busyLive" aria-live="polite"></div>
        <div id="assertiveLive" aria-live="assertive"></div>
        <div id="other">Trailing non-link text block.</div><div id="reference-target"></div><div id="nav-1"></div><div id="nav-2"></div>
        <div id="nav-3"></div><div id="nav-4"></div><div id="nav-5"></div><div id="nav-6"></div>
      </main>
      <script>
        liveButton.onclick=()=>live.textContent='Parity live update';
        activateButton.onclick=()=>live.textContent='Parity activated';
		mouseButton.onclick=()=>live.textContent='Parity mouse clicked';
		mouseButton.oncontextmenu=(event)=>{event.preventDefault();live.textContent='Parity context opened'};
		for(const type of ['pointerdown','mousedown','mouseup','click','contextmenu']){
			document.addEventListener(type,(event)=>{
				document.body.dataset.mouseEvents=((document.body.dataset.mouseEvents||'')+' '+type+':'+event.target.id).trim();
			},{capture:true});
		}
      </script>
    </body></html>
  `;
  await page.setContent(fixture);
  await page.bringToFront();
  await expect(
    page.getByRole("heading", { name: "Checkout parity" }),
  ).toBeVisible();
}

function expectLiveRegion(
  observation: Awaited<ReturnType<ScreenReaderSession["observe"]>>,
  expected: string | RegExp,
  priority: "polite" | "assertive",
): void {
  const matches = (text: string): boolean =>
    typeof expected === "string"
      ? text.includes(expected)
      : expected.test(text);
  expect(
    observation.events.some(
      (event) =>
        event.kind === "liveRegion" &&
        event.priority === priority &&
        matches(event.text),
    ),
    `${priority} live-region event matching ${String(expected)}`,
  ).toBe(true);
}

const semanticExpectations = new Map<ScreenReaderAction, RegExp>([
  ["nextFocusable", /Activate action/iu],
  ["previousFocusable", /Parity password/iu],
  ["activate", /Parity activated/iu],
  ["activateWithSpace", /checked|aktiviert|ausgewählt/iu],
  ["escape", /NVDA parity fixture|Parity visited link/iu],
  ["nextHeading", /Checkout parity/iu],
  ["previousHeading", /Level nine/iu],
  ["nextLandmark", /Checkout parity/iu],
  [
    "previousLandmark",
    /Checkout parity|main landmark|Haupt Sprungmarke|Parity navigation|banner landmark|Banner Sprungmarke/iu,
  ],
  ["nextButton", /Parity toggle button/iu],
  ["previousButton", /Update live region/iu],
  ["nextFormField", /Parity tab/iu],
  ["previousFormField", /Update live region/iu],
  ["nextLink", /Navigation link|Parity unvisited link/iu],
  ["previousLink", /Parity destination link/iu],
  ["nextVisitedLink", /no next visited link|Kein weiterer besuchter Link/iu],
  [
    "previousVisitedLink",
    /no previous visited link|Kein vorheriger besuchter Link/iu,
  ],
  ["nextUnvisitedLink", /Navigation link|Parity unvisited link/iu],
  ["previousUnvisitedLink", /Parity destination link/iu],
  ["nextList", /First list item/iu],
  ["previousList", /First list item/iu],
  ["nextListItem", /First list item/iu],
  ["previousListItem", /Second list item/iu],
  ["nextTable", /Parity table/iu],
  ["previousTable", /Parity table/iu],
  ["nextImage", /Parity graphic/iu],
  ["previousImage", /Parity graphic/iu],
  ["nextCheckbox", /Parity check/iu],
  ["previousCheckbox", /Parity check/iu],
  ["nextRadioButton", /Parity radio/iu],
  ["previousRadioButton", /Parity radio/iu],
  ["nextCombobox", /Parity select/iu],
  ["previousCombobox", /Parity select/iu],
  ["nextEntry", /Parity entry/iu],
  ["previousEntry", /Spelling fixture|Parity entry/iu],
  ["nextParagraph", /Article accessibility content/iu],
  ["previousParagraph", /Article accessibility content/iu],
  ["nextFrame", /Parity frame/iu],
  ["previousFrame", /Parity frame/iu],
  ["nextSeparator", /separator|Trennlinie|⠤/iu],
  ["previousSeparator", /separator|Trennlinie|⠤/iu],
  ["nextBlockQuote", /Parity block quote/iu],
  ["previousBlockQuote", /Parity block quote/iu],
  ["nextEmbeddedObject", /Parity figure|Parity embedded object|data:image/iu],
  ["previousEmbeddedObject", /Parity embedded object|data:image/iu],
  ["nextAnnotation", /Parity annotation insertion/iu],
  ["previousAnnotation", /Parity annotation insertion/iu],
  [
    "nextSpellingError",
    /Not supported in this document|Keine Unterstützung in diesem Dokument/iu,
  ],
  [
    "previousSpellingError",
    /Not supported in this document|Keine Unterstützung in diesem Dokument/iu,
  ],
  ["nextNotLinkBlock", /Checkout parity/iu],
  ["previousNotLinkBlock", /Parity math formula/iu],
  ["nextArticle", /Parity article|Article accessibility content/iu],
  ["previousArticle", /Parity article|Article accessibility content/iu],
  ["nextFigure", /Parity figure|Parity figure caption/iu],
  ["previousFigure", /Parity figure|Parity figure caption/iu],
  ["nextGrouping", /Parity grouping/iu],
  ["previousGrouping", /Parity grouping/iu],
  ["nextTab", /Parity tab/iu],
  ["previousTab", /Parity tab/iu],
  ["nextMenuItem", /Parity menu item/iu],
  ["previousMenuItem", /Parity menu item/iu],
  ["nextToggleButton", /Parity toggle button/iu],
  ["previousToggleButton", /Parity toggle button/iu],
  ["nextProgressBar", /Parity progress|40/iu],
  ["previousProgressBar", /Parity progress|40/iu],
  [
    "nextReference",
    /Not supported in this document|Keine Unterstützung in diesem Dokument/iu,
  ],
  [
    "previousReference",
    /Not supported in this document|Keine Unterstützung in diesem Dokument/iu,
  ],
  ["nextMathFormula", /Parity math formula|x plus y|mathematic/iu],
  ["previousMathFormula", /Parity math formula|x plus y|mathematisch/iu],
  ["nextVerticalParagraph", /Parity aligned paragraph/iu],
  ["previousVerticalParagraph", /Parity aligned paragraph/iu],
  ["nextSameStyle", /Parity same style/iu],
  ["previousSameStyle", /Parity same style/iu],
  ["nextDifferentStyle", /Parity different style/iu],
  ["previousDifferentStyle", /Parity different style|Parity same style/iu],
  ["nextCharacter", /\S/u],
  ["previousCharacter", /\S/u],
  ["nextWord", /visited|Navigation/iu],
  ["previousWord", /block|navigation/iu],
  ["nextLine", /Navigation link five|Navigation link six/iu],
  ["previousLine", /Navigation link five|Navigation link six/iu],
  ["nextParagraphText", /Checkout parity/iu],
  ["previousParagraphText", /Checkout parity/iu],
  ["documentStart", /Parity visited link/iu],
  ["documentEnd", /blank|leer|Trailing non-link text block/iu],
  ["moveToContainerStart", /list|Liste|First list item/iu],
  ["movePastContainerEnd", /Parity table|table|Tabelle/iu],
  ["refreshBrowseDocument", /Refreshed|Aktualisiert/iu],
  [
    "exitEmbeddedObject",
    /^(?:|(?:Parity frame (?:frame btn|Rahmen sltr) Frame action\s*)+)$/iu,
  ],
  [
    "toggleNativeSelection",
    /Native app selection mode enabled|Nativer Auswahlmodus aktiviert/iu,
  ],
  ["previousTableColumn", /Column A/iu],
  ["nextTableColumn", /Column B/iu],
  ["previousTableRow", /Column A/iu],
  ["nextTableRow", /Alpha/iu],
  ["firstTableColumn", /Alpha/iu],
  ["lastTableColumn", /Column B/iu],
  ["firstTableRow", /Column A/iu],
  ["lastTableRow", /Gamma/iu],
  ["readCurrent", /Details action/iu],
  ["reportDetails", /Pinned details text/iu],
  ["sayAll", /Checkout parity/iu],
  ["reportTitle", /NVDA parity fixture/iu],
  [
    "readActiveWindow",
    /NVDA parity fixture|Parity visited link|Checkout parity/iu,
  ],
  ["reportShortcutKey", /(?:Alt|Option).*[xX]|[xX].*(?:Alt|Option)/iu],
  ["reportCurrentLine", /Parity language sample/iu],
  ["reportTextSelection", /Alpha beta.*(?:selected|ausgewählt)/iu],
  ["reportTextFormatting", /(?:font|Schrift|bold|Fett|24)/iu],
  ["reportLanguage", /German|Deutsch/iu],
  ["reportLinkDestination", /https:\/\/example\.test\/parity-destination/iu],
  ["reportCaretLocation", /(?:top|left|oben|links|%|Prozent|pixel)/iu],
  ["sayAllTableColumn", /Column A.*Alpha|Alpha.*Gamma/isu],
  ["sayAllTableRow", /Column A.*Column B/isu],
  ["readTableColumn", /Column A.*Alpha|Alpha.*Gamma/isu],
  ["readTableRow", /Column A.*Column B/isu],
  ["reportCurrentObject", /Object current/iu],
  ["moveToContainingObject", /Object navigation group/iu],
  ["moveToPreviousObject", /Object previous/iu],
  ["moveToPreviousObjectFlat", /Object previous/iu],
  ["moveToNextObject", /Object next/iu],
  ["moveToNextObjectFlat", /Object next/iu],
  ["moveToFirstContainedObject", /Object previous/iu],
  ["moveToFocusObject", /Object current/iu],
  ["activateNavigatorObject", /Parity activated|Activate|Aktivieren/iu],
  [
    "moveFocusToReviewPosition",
    /Object previous|Move focus|Fokus (?:verschieben|bewegen)/iu,
  ],
  ["reportReviewLocation", /(?:top|left|oben|links|%|Prozent|pixel)/iu],
  ["reviewTopLine", /Alpha beta/iu],
  ["reviewPreviousLine", /Alpha beta|Top|Oben/iu],
  ["reviewCurrentLine", /Gamma delta/iu],
  ["reviewNextLine", /Omega last|Bottom|Unten/iu],
  ["reviewBottomLine", /Omega last/iu],
  ["reviewPreviousWord", /beta|Alpha/iu],
  ["reviewCurrentWord", /Gamma/iu],
  ["reviewNextWord", /delta/iu],
  ["reviewLineStart", /G/iu],
  ["reviewPreviousCharacter", /G/iu],
  ["reviewCurrentCharacter", /G/iu],
  ["reviewNextCharacter", /a/iu],
  ["reviewLineEnd", /a/iu],
  [
    "reviewPreviousPage",
    /Movement by page not supported|Seitenweises Verschieben|Alpha beta|Top|Oben/iu,
  ],
  [
    "reviewNextPage",
    /Movement by page not supported|Seitenweises Verschieben|Omega last|Bottom|Unten/iu,
  ],
  ["reviewSelectionStart", /G/iu],
  ["reviewSelectionEnd", /a/iu],
  ["sayAllReview", /Gamma delta|Omega last/iu],
  ["setReviewCopyStart", /Start marked|Startmarke gesetzt/iu],
  ["copyToReviewPosition", /selected|ausgewählt|select text|Text auswählen/iu],
  ["moveToReviewCopyStart", /G/iu],
  ["reportReviewFormatting", /(?:font|Schrift|bold|Fett|24)/iu],
  [
    "nextReviewMode",
    /(?:Object|Document|Screen) review|(?:Objekt|Dokument|Bildschirm)betrachter/iu,
  ],
  [
    "previousReviewMode",
    /(?:Object|Document|Screen) review|(?:Objekt|Dokument|Bildschirm)betrachter/iu,
  ],
  ["leftMouseClick", /Left click|Linksklick/iu],
  ["leftMouseLock", /Left mouse button lock|Linke Maustaste gesperrt/iu],
  ["rightMouseClick", /Right click|Rechtsklick/iu],
  ["rightMouseLock", /Right mouse button locked|Rechte Maustaste gesperrt/iu],
  ["moveMouseToNavigatorObject", /^$/u],
  [
    "moveNavigatorToMouseObject",
    /Mouse action|Move navigator object to mouse|Ziehe Navigator zur Maus/iu,
  ],
  ["stopSpeech", /^$/u],
  ["pauseSpeech", /^$/u],
  ["cycleSpeechMode", /Speech mode|Sprachmodus/iu],
  ["braillePanBack", /Review text|Alpha beta|Gamma delta/iu],
  ["braillePanForward", /Review text|Alpha beta|Gamma delta|Omega last/iu],
  ["braillePreviousLine", /Alpha beta|Gamma delta|Review text/iu],
  ["brailleNextLine", /Gamma delta|Omega last|Review text/iu],
  ["brailleRoute", /Review text|Alpha beta|Gamma delta|G/u],
  ["brailleToggleTether", /Braille tethered|Braille-Darstellung gekoppelt/iu],
  ["brailleReportFormatting", /(?:font|Schrift|bold|Fett|24)/iu],
  ["toggleFocusMode", /Parity visited link|focus mode|Fokusmodus|Interaktionsmodus/iu],
  [
    "toggleSingleLetterNavigation",
    /Single letter navigation off|Schnellnavigation ausgeschaltet/iu,
  ],
  ["elementsList", /Elements List|Elementliste|Parity visited link/iu],
  ["find", /Parity needle/iu],
  ["findNext", /Parity needle/iu],
  ["findPrevious", /Parity needle/iu],
]);

for (let level = 1; level <= 9; level += 1) {
  const label =
    level === 1
      ? "Checkout parity"
      : `Level ${["", "", "two", "three", "four", "five", "six", "seven", "eight", "nine"][level]}`;
  semanticExpectations.set(
    `nextHeading${level}` as ScreenReaderAction,
    new RegExp(label, "iu"),
  );
  semanticExpectations.set(
    `previousHeading${level}` as ScreenReaderAction,
    new RegExp(label, "iu"),
  );
}

if (
  semanticExpectations.size !== allActions.length - 1 ||
  allActions.some(
    (action) => action !== "returnToPage" && !semanticExpectations.has(action),
  )
) {
  throw new Error(
    "semantic expectation catalog does not exactly cover advertised profile",
  );
}
