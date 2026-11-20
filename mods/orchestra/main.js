// Orchestrator, worker and reviewer: pick an agent, a model and an effort for each.
// Worker and reviewer become hc templates; the orchestrator starts in a new tab, or any
// running agent can be switched into the orchestrator role.

import { View, div } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { exec, hc, home, appHome, readTextFile, writeTextFile, theme, run, shared, setShared, terminals, spaces, checking } from "herdr";

const AGENTS = [
  { id: "claude", label: "Claude Code" },
  { id: "codex", label: "Codex" },
  { id: "antigravity", label: "Antigravity" },
];

const ROLES = [
  { id: "orchestrator", label: "Orchestrator", about: "Plans the work, starts helpers, never edits code." },
  { id: "worker", label: "Worker", about: "Does one task it is given." },
  { id: "reviewer", label: "Reviewer", about: "One review of all the work at the end, read-only." },
];

const DEFAULTS = {
  orchestrator: { agent: "antigravity", model: "gemini-4-neon", effort: "high" },
  worker: { agent: "claude", model: "claude-opus-5-5", effort: "high" },
  reviewer: { agent: "codex", model: "gpt-6.2-sol", effort: "high" },
};

const ROLE_LABEL = "herdr.role";

// The command line that starts an agent with this pick. The orchestrator gets no edit tools
// where the agent allows it (Claude Code: only Bash, and only hc runs without asking).
function argv(pick, role) {
  if (pick.agent === "claude") {
    const lock = role === "orchestrator" ? ["--permission-mode", "manual", "--tools", "Bash", "--allowedTools", "Bash(hc *)"] : [];
    return ["claude", "--model", pick.model, "--effort", pick.effort, ...lock];
  }
  if (pick.agent === "codex") return ["codex", "--no-daemon", "-m", pick.model, "-c", `model_reasoning_effort="${pick.effort}"`];
  return ["agy", "--model", pick.effort ? `${pick.model}-${pick.effort}` : pick.model];
}

const describe = (pick) => `${AGENTS.find((a) => a.id === pick.agent)?.label} ${pick.model}${pick.effort ? ` (${pick.effort})` : ""}`;

const TEMPLATE_BODY = {
  worker: `You are a worker started by an orchestrator agent.
Do only the task you are given, in the folder you start in. Do not start other agents.
Keep changes small and focused. Run the relevant tests when you can.
When you finish or get stuck, report to the orchestrator with: hc send <its address> "<report>".
The report says what you did, which files you changed, and anything unfinished or uncertain. A reviewer will read it.
The task names the orchestrator's address.`,
  reviewer: `You are a reviewer started by an orchestrator agent.
You run once, after all the workers have finished. You get the goal, every task, and what each worker reported.
Check the actual results (the changed files, git diff, outputs), not only the reports. Do not edit files and do not start other agents.
Look for bugs, missing tests, conflicts between workers' changes, and anything that does not match the goal.
Report one review covering all tasks, findings ranked by severity per task, or say it all looks good, with: hc send <orchestrator address> "<review>".
The task names the orchestrator's address.`,
};

function orchestratorBrief(picks) {
  return `You are now the ORCHESTRATOR. You only plan, delegate, check and report. Other agents do ALL the work.

Hard rules:
- Never do the work yourself: do not edit, create or delete files, do not write code, do not run builds or tests, do not read through the code to solve things.
- Even research is delegated: if you need to know how something works, start a worker to find out and report back.
- The only commands you run are hc commands. If you catch yourself about to do a task, stop and give it to a worker.
- Do not use your own built-in subagents or tools to do work. Use only the helpers below, started with hc.

First run: hc label "$HC_TERMINAL_ID" ${ROLE_LABEL}=orchestrator   then: echo $HC_TERMINAL_ID   (that is your address).

Helpers (always --bg, a short unique --name, an exact scope, and your address so they can report back):
- worker (${describe(picks.worker)}): hc run --bg --name w-<short> --cwd <repo> worker "<task>. Orchestrator address: <your address>."
- reviewer (${describe(picks.reviewer)}): hc run --bg --name review --cwd <repo> reviewer "Goal: <goal>. Tasks and worker reports: <each task, its worker, what it reported and where it changed things>. Orchestrator address: <your address>."
  Start exactly ONE reviewer, once, after every worker has reported. Never one reviewer per worker.

How to work:
1. Split the goal into small, clear tasks. If you don't know enough to split it, first start a worker to investigate and report.
2. Start a worker per task, in parallel when the tasks are independent.
3. Collect each worker's report. Keep waiting until every worker has reported.
4. Then start the single reviewer with the goal and all the worker reports, and wait for its review.
5. Wait with hc wait --children any. Never sleep or poll. Reports arrive as <hc from=...> messages.
6. If a helper is stuck on a start-up question (trust this folder, a permission), read it with hc read <name> and answer it (hc keys <name> enter), or ask the user.
7. Answer the user only after the review is in: what each worker did, and the reviewer's findings. Do not fix the findings yourself or start new work unless the user asks.
Run hc --skill once if you need the full hc manual.

Now ask the user for the goal, unless they already gave it.`;
}

const STOP_BRIEF = `You are no longer the orchestrator. Do not start new helpers. Tell the user which helpers are still running (hc ls) and ask whether to stop them. Then run: hc label "$HC_TERMINAL_ID" ${ROLE_LABEL}=`;

export default class Orchestra extends View {
  init(_props, cx) {
    this.catalog = null;
    try { this.catalog = JSON.parse(localStorage.getItem("catalog") ?? "null"); } catch { this.catalog = null; }
    if (checking()) return;
    this.loadCatalog(cx);
    this.writeTemplates(cx);
  }

  picks() {
    return { ...DEFAULTS, ...(shared("orchestra.picks") ?? {}) };
  }

  loadCatalog(cx) {
    cx.spawn(async (cx) => {
      try {
        const r = await exec("python3", ["-I", `${appHome()}/mods/orchestra/models.py`], { timeout: 90000 });
        this.catalog = JSON.parse(r.stdout);
        localStorage.setItem("catalog", JSON.stringify(this.catalog));
      } catch (e) {
        this.status = `Could not list models: ${e}`;
      }
      cx.notify();
    });
  }

  models(agent) {
    return this.catalog?.[agent] ?? [];
  }

  // A model the list doesn't have (yet) stays selectable, so a saved pick is never lost.
  modelsWithPick(pick) {
    const list = this.models(pick.agent);
    if (pick.model && !list.some((m) => m.id === pick.model)) return [...list, { id: pick.model, label: `${pick.model} (not listed)`, efforts: ["low", "medium", "high", "xhigh", "max"], missing: true }];
    return list;
  }

  setPick(role, change, cx) {
    const picks = this.picks();
    let pick = { ...picks[role], ...change };
    if (change.agent) {
      const first = this.models(change.agent)[0];
      pick = { agent: change.agent, model: first?.id ?? "", effort: first?.efforts?.includes("high") ? "high" : first?.efforts?.at(-1) ?? null };
    } else if (change.model) {
      const m = this.modelsWithPick(pick).find((x) => x.id === change.model);
      if (!m?.efforts?.includes(pick.effort)) pick.effort = m?.efforts?.includes("high") ? "high" : m?.efforts?.at(-1) ?? null;
    }
    setShared("orchestra.picks", { ...picks, [role]: pick });
    this.writeTemplates(cx);
  }

  writeTemplates(cx) {
    cx.spawn(async (cx) => {
      const picks = this.picks();
      const dir = `${home()}/.config/herdr-core/templates`;
      try {
        await exec("mkdir", ["-p", dir]);
        for (const role of ["worker", "reviewer"]) {
          const path = `${dir}/${role}.md`;
          const text = `---\nname: ${role}\ndescription: ${role === "worker" ? "Does one task" : "Reviews all the work at the end"} (${describe(picks[role])}), set in Herdr's Orchestra panel\ncommand: ${argv(picks[role], role).map((a) => (/^[\w.\-=/]+$/.test(a) ? a : `'${a}'`)).join(" ")}\n---\n${TEMPLATE_BODY[role]}\n`;
          const old = await readTextFile(path);
          if (old !== text) await writeTextFile(path, text, old);
        }
        this.status = null;
      } catch (e) {
        this.status = `Could not save the helper roles: ${e}`;
      }
      cx.notify();
    });
  }

  startOrchestrator() {
    const picks = this.picks();
    // The brief goes on the command line: Antigravity only takes a first prompt with -i.
    const brief = orchestratorBrief(picks);
    // Claude reads words after --allowedTools as more tools: the brief goes after --.
    const first = { antigravity: ["-i", brief], claude: ["--", brief] }[picks.orchestrator.agent] ?? [brief];
    run("tab.new", { name: "Orchestrator", argv: [...argv(picks.orchestrator, "orchestrator"), ...first] });
  }

  toggle(t, on, cx) {
    cx.spawn(async (cx) => {
      const r = await hc(["send", t.address, on ? orchestratorBrief(this.picks()) : STOP_BRIEF]);
      if (r.code === 0) await hc(["label", t.address, `${ROLE_LABEL}=${on ? "orchestrator" : ""}`]);
      this.status = r.code ? `Could not reach ${t.address}: ${r.stderr.trim()}` : null;
      cx.notify();
    });
  }

  chips(t, id, options, selected, fn) {
    return h_flex().flex_wrap().gap(4).children(options.map((o) => div().id(`${id}-${o.id}`).px(7).py(2).rounded(5).text_size(11)
      .border(1).border_color(o.id === selected ? t.accent : t.border)
      .bg(o.id === selected ? t.selected : t.background)
      .text_color(o.missing ? t.blocked : o.id === selected ? t.foreground : t.muted)
      .hover((s) => s.bg(t.hover)).on_click((_e, cx) => fn(o.id, cx)).child(o.label)));
  }

  role(t, role, pick) {
    const models = this.modelsWithPick(pick);
    const efforts = models.find((m) => m.id === pick.model)?.efforts ?? [];
    const label = (s) => div().text_size(10.5).text_color(t.dim).child(s);
    return v_flex().p(10).gap(6).rounded(8).bg(t.background).border(1).border_color(t.border)
      .child(h_flex().justify_between().items_center()
        .child(div().text_size(12.5).font_semibold().text_color(t.foreground).child(role.label))
        .child(div().text_size(10.5).text_color(t.dim).child(role.about)))
      .child(label("Agent"))
      .child(this.chips(t, `${role.id}-agent`, AGENTS, pick.agent, (v, cx) => this.setPick(role.id, { agent: v }, cx)))
      .child(label("Model"))
      .child(models.length ? this.chips(t, `${role.id}-model`, models, pick.model, (v, cx) => this.setPick(role.id, { model: v }, cx))
        : div().text_size(11).text_color(t.dim).child(this.catalog ? "No models found" : "Loading models..."))
      .when(efforts.length > 0, (el) => el.child(label("Effort"))
        .child(this.chips(t, `${role.id}-effort`, efforts.map((e) => ({ id: e, label: e })), pick.effort, (v, cx) => this.setPick(role.id, { effort: v }, cx))));
  }

  agentRow(t, a, spaceName) {
    const on = a.labels?.[ROLE_LABEL] === "orchestrator";
    return h_flex().id(`orch-${a.address}`).px(8).h(30).gap(8).items_center().rounded(6).hover((s) => s.bg(t.hover))
      .child(div().flex_1().min_w(0).truncate().text_size(12).text_color(t.foreground).child(`${a.program?.name ?? a.address}${spaceName ? ` · ${spaceName}` : ""}`))
      .child(div().id(`switch-${a.address}`).w(30).h(16).rounded(8).p(2).flex().bg(on ? t.accent : t.border)
        .when(on, (el) => el.justify_end())
        .tooltip(on ? "Stop being the orchestrator" : "Make this agent the orchestrator")
        .on_click((_e, cx) => this.toggle(a, !on, cx))
        .child(div().size(12).rounded(6).bg(on ? t.accent_foreground : t.muted)));
  }

  render() {
    const t = theme();
    const picks = this.picks();
    const live = terminals().filter((x) => x.state === "live" && x.program?.agent && !x.parent);
    const spaceOf = new Map(spaces().map((s) => [s.id, s.name]));
    const button = (id, label, fn) => div().id(id).px(10).py(5).rounded(6).text_size(12).bg(t.solid).text_color(t.solid_foreground)
      .hover((s) => s.opacity(0.9)).on_click(fn).child(label);
    return v_flex().id("orchestra").size_full().min_h(0).bg(t.surface).p(12).gap(10).overflow_y_scrollbar()
      .child(h_flex().justify_between().items_center()
        .child(div().text_size(14).font_semibold().text_color(t.foreground).child("Orchestra"))
        .child(div().id("reload-models").text_size(11).text_color(t.dim).hover((s) => s.text_color(t.foreground))
          .tooltip("Read the model lists again").on_click((_e, cx) => this.loadCatalog(cx)).child("Reload models")))
      .when(Boolean(this.status), (el) => el.child(div().text_size(11.5).text_color(t.blocked).child(this.status)))
      .children(ROLES.map((r) => this.role(t, r, picks[r.id])))
      .child(h_flex().gap(8).items_center()
        .child(button("start-orch", "Start orchestrator", () => this.startOrchestrator()))
        .child(div().text_size(10.5).text_color(t.dim).child("in a new tab")))
      .child(div().pt(4).text_size(11.5).font_medium().text_color(t.dim).child("Running agents"))
      .when(live.length === 0, (el) => el.child(div().text_size(11).text_color(t.dim).child("No agents running.")))
      .children(live.map((a) => this.agentRow(t, a, spaceOf.get(a.labels?.["herdr.space"]))));
  }
}
