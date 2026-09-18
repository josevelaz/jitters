/**
 * agent.ts — TypeSafe System One (Jev) step loop.
 *
 * Code owns control flow. Jev cannot generate text: every step is ONE
 * `client.systemOne` request (speculative fan-out) over a closed set of
 * candidates from `candidates.ts`, and the code consumes ONLY the
 * `next_action` branch. Typing or navigating with a `none` choice finishes
 * instead of inventing text or a URL.
 *
 * Page snapshot/title/text are UNTRUSTED: they travel in `state` only and
 * are never concatenated into question `instructions` (which stay static).
 * API keys are never written to stdout/logs.
 */

import { choice, noul, TypeSafeClient } from "@typesafe-ai/sdk";
import { StudioBrowser } from "./browser.js";
import { extractCandidates } from "./candidates.js";

export const DEFAULT_MAX_STEPS = 20;
export const MAX_STEPS_CAP = 40;
const TASK_COMPLETE_THRESHOLD = 0.7;
const SUBMIT_THRESHOLD = 0.5;
const SNAPSHOT_TEXT_CAP = 4000;

/** Minimal client surface the loop needs (real or injected fake). */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export interface SystemOneLike {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  systemOne: (request: any, options?: any) => Promise<any>;
}

/** Minimal browser surface the loop needs (real StudioBrowser or a fake). */
export interface AgentBrowserLike {
  snapshot(): Promise<Array<{ ref: string; role: string; name: string }>>;
  getUrl(): Promise<string>;
  getTitle(): Promise<string>;
  clickRef(ref: string): Promise<unknown>;
  typeRef(ref: string, text: string): Promise<unknown>;
  pressKey(key?: string): Promise<unknown>;
  goto(url: string): Promise<unknown>;
  scroll(dir?: string, px?: number): Promise<unknown>;
  goBack(): Promise<unknown>;
  close(): Promise<void>;
  evalJs?(script: string): Promise<string>;
}

export interface RunAgentOptions {
  prompt: string;
  url?: string;
  maxSteps?: number;
  /** Injected TypeSafe client (tests); defaults to `new TypeSafeClient()`. */
  client?: SystemOneLike;
  /** Injected launcher (tests); defaults to `StudioBrowser.launch`. */
  launch?: (opts: { url?: string }) => Promise<AgentBrowserLike>;
}

export interface AgentStep {
  index: number;
  action: string;
  target?: string;
  value?: string;
  url?: string;
  note?: string;
}

export type AgentStatus = "done" | "stuck" | "max_steps";

export interface RunAgentResult {
  status: AgentStatus;
  steps: AgentStep[];
  /** Terminal reason: "task_complete" | "finish" | "type_none" | ... */
  reason: string;
  finalUrl?: string;
}

export function clampMaxSteps(raw?: number): number {
  if (raw === undefined) return DEFAULT_MAX_STEPS;
  if (!Number.isFinite(raw) || !Number.isInteger(raw) || raw < 1) {
    return DEFAULT_MAX_STEPS;
  }
  return Math.min(raw as number, MAX_STEPS_CAP);
}

function refKey(ref: string): string {
  return ref.startsWith("@") ? ref.slice(1) : ref;
}

async function readPageText(browser: AgentBrowserLike): Promise<string> {
  if (!browser.evalJs) return "";
  try {
    const raw = await browser.evalJs(
      "JSON.stringify(((document.body ? document.body.innerText : document.documentElement.innerText) || '').slice(0, 4000))",
    );
    try {
      const parsed: unknown = JSON.parse(raw);
      return typeof parsed === "string" ? parsed.slice(0, SNAPSHOT_TEXT_CAP) : "";
    } catch {
      return raw.slice(0, SNAPSHOT_TEXT_CAP);
    }
  } catch {
    return "";
  }
}

function lastThreeIdentical(history: string[]): boolean {
  if (history.length < 3) return false;
  const n = history.length;
  return history[n - 1] === history[n - 2] && history[n - 2] === history[n - 3];
}

/**
 * Run the Jev step loop for one prompt. Always closes the browser.
 * Returns `{ status: "done" | "stuck" | "max_steps", steps, ... }` so
 * recording (Task 4) and composition (Task 6) can wrap it.
 */
export async function runAgent(options: RunAgentOptions): Promise<RunAgentResult> {
  const { prompt } = options;
  const maxSteps = clampMaxSteps(options.maxSteps);
  const { typeCandidates, urlCandidates } = extractCandidates(
    prompt,
    options.url,
  );
  const client: SystemOneLike = options.client ?? new TypeSafeClient();
  const launch =
    options.launch ??
    ((opts: { url?: string }) =>
      StudioBrowser.launch(opts) as unknown as Promise<AgentBrowserLike>);

  const browser = await launch(options.url ? { url: options.url } : {});
  const steps: AgentStep[] = [];
  const history: string[] = [];
  let finalUrl = "";

  const finish = async (
    status: AgentStatus,
    reason: string,
  ): Promise<RunAgentResult> => {
    try {
      finalUrl = await browser.getUrl();
    } catch {
      // best effort; keep the recorded reason
    }
    return { status, steps, reason, finalUrl };
  };

  try {
    for (let index = 0; index < maxSteps; index++) {
      let url = "";
      let title = "";
      let refs: Array<{ ref: string; role: string; name: string }> = [];
      try {
        url = await browser.getUrl();
      } catch {
        url = "";
      }
      try {
        title = await browser.getTitle();
      } catch {
        title = "";
      }
      try {
        refs = await browser.snapshot();
      } catch {
        refs = [];
      }
      const snapshotText = await readPageText(browser);

      const refToKey = new Map<string, string>();
      const clickCriteria: Record<string, string | null> = {};
      const typeTargetCriteria: Record<string, string | null> = {};
      for (const r of refs) {
        const key = refKey(r.ref);
        if (!key || key === "none" || refToKey.has(key)) continue;
        refToKey.set(key, r.ref);
        const label = `${r.role} ${r.name}`.trim() || r.ref;
        clickCriteria[key] = label;
        typeTargetCriteria[key] = label;
      }
      clickCriteria["none"] = "No suitable element to click";
      typeTargetCriteria["none"] = "No suitable element to type into";

      const typeValueCriteria: Record<string, string | null> = {};
      for (const c of typeCandidates) typeValueCriteria[c] = c;
      typeValueCriteria["none"] = "No suitable text to type";

      const navigateCriteria: Record<string, string | null> = {};
      for (const u of urlCandidates) navigateCriteria[u] = u;
      navigateCriteria["none"] = "No suitable URL to open";

      // UNTRUSTED page data travels in `state` only. Instructions below are
      // static strings — page text is never concatenated into them.
      const state = {
        task: prompt,
        progress: `Step ${index + 1} of ${maxSteps}. ${history.length} prior action(s).`,
        history,
        page: {
          url,
          title,
          snapshotText,
          elements: refs.map((r) => ({ ref: r.ref, role: r.role, name: r.name })),
        },
        type_candidates: typeCandidates,
        url_candidates: urlCandidates,
      };

      const questions = {
        task_complete: noul("Is the task described in state.task complete?", {
          true: "The task goal is visibly satisfied by the current page.",
          false: "The task goal is not yet satisfied; more actions are needed.",
        }),
        next_action: choice("What single browser action should be taken next?", {
          click: "Click an element from the snapshot refs.",
          type: "Type extracted text into an element from the snapshot refs.",
          navigate: "Navigate directly to one of the URL candidates.",
          scroll_down: "Scroll the page down.",
          scroll_up: "Scroll the page up.",
          go_back: "Go back to the previous page.",
          finish: "Nothing further is needed; stop the run.",
        }),
        click_target: choice("Which element should be clicked?", clickCriteria),
        type_target: choice(
          "Which element should receive typed text?",
          typeTargetCriteria,
        ),
        type_value: choice(
          "Which extracted text should be typed?",
          typeValueCriteria,
        ),
        submit_after_typing: noul("Should Enter be pressed after typing?", {
          true: "The task needs the typed text to be submitted with Enter.",
          false: "Typing alone is enough; do not press Enter.",
        }),
        navigate_url: choice(
          "Which URL should be navigated to?",
          navigateCriteria,
        ),
      };

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const response: any = await client.systemOne({ state, questions });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const answers: any = response?.answers ?? {};

      const completeScore: number =
        typeof answers.task_complete?.noul === "number"
          ? answers.task_complete.noul
          : 0;
      if (completeScore >= TASK_COMPLETE_THRESHOLD) {
        return await finish("done", "task_complete");
      }

      // Consume ONLY the next_action branch; speculative answers on unused
      // branches are ignored.
      const action: string = answers.next_action?.choice ?? "finish";
      const resolveRef = (key: unknown): string | null => {
        if (typeof key !== "string" || key === "none") return null;
        return refToKey.get(key) ?? (key.startsWith("@") ? key : null);
      };

      if (action === "click") {
        const ref = resolveRef(answers.click_target?.choice);
        if (!ref) {
          steps.push({ index, action: "click", note: "click_target none" });
          return await finish("done", "click_none");
        }
        await browser.clickRef(ref);
        const entry = `click:${refKey(ref)}`;
        history.push(entry);
        steps.push({ index, action: "click", target: ref });
        if (lastThreeIdentical(history)) return await finish("stuck", "repeat");
        continue;
      }

      if (action === "type") {
        const ref = resolveRef(answers.type_target?.choice);
        const value: unknown = answers.type_value?.choice;
        if (!ref || typeof value !== "string" || value === "none") {
          steps.push({ index, action: "type", note: "type_target/type_value none" });
          return await finish("done", "type_none");
        }
        // Closed set: never type a string outside the extracted candidates.
        if (!typeCandidates.includes(value)) {
          steps.push({ index, action: "type", note: "type_value outside closed set" });
          return await finish("done", "type_none");
        }
        await browser.typeRef(ref, value);
        const submitScore: number =
          typeof answers.submit_after_typing?.noul === "number"
            ? answers.submit_after_typing.noul
            : 0;
        if (submitScore >= SUBMIT_THRESHOLD) {
          await browser.pressKey("Enter");
        }
        const entry = `type:${refKey(ref)}:${value}`;
        history.push(entry);
        steps.push({ index, action: "type", target: ref, value });
        if (lastThreeIdentical(history)) return await finish("stuck", "repeat");
        continue;
      }

      if (action === "navigate") {
        const dest: unknown = answers.navigate_url?.choice;
        if (typeof dest !== "string" || dest === "none") {
          steps.push({ index, action: "navigate", note: "navigate_url none" });
          return await finish("done", "navigate_none");
        }
        // Closed set: never navigate outside the extracted URL candidates.
        if (!urlCandidates.includes(dest)) {
          steps.push({ index, action: "navigate", note: "navigate_url outside closed set" });
          return await finish("done", "navigate_none");
        }
        await browser.goto(dest as string);
        const entry = `navigate:${dest}`;
        history.push(entry);
        steps.push({ index, action: "navigate", url: dest });
        if (lastThreeIdentical(history)) return await finish("stuck", "repeat");
        continue;
      }

      if (action === "scroll_down") {
        await browser.scroll("down", 300);
        history.push("scroll_down");
        steps.push({ index, action: "scroll_down" });
        if (lastThreeIdentical(history)) return await finish("stuck", "repeat");
        continue;
      }

      if (action === "scroll_up") {
        await browser.scroll("up", 300);
        history.push("scroll_up");
        steps.push({ index, action: "scroll_up" });
        if (lastThreeIdentical(history)) return await finish("stuck", "repeat");
        continue;
      }

      if (action === "go_back") {
        await browser.goBack();
        history.push("go_back");
        steps.push({ index, action: "go_back" });
        if (lastThreeIdentical(history)) return await finish("stuck", "repeat");
        continue;
      }

      // "finish" or anything unrecognized stops the run.
      steps.push({ index, action: "finish" });
      return await finish("done", "finish");
    }
    return await finish("max_steps", "max_steps");
  } finally {
    await browser.close();
  }
}
