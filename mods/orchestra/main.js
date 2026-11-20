// Orchestrator, worker and reviewer: pick an agent, a model and an effort for each.
// Worker and reviewer become hc templates; the orchestrator starts in a new tab, or any
// running agent can be switched into the orchestrator role.

import { View, div } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { exec, hc, home, appHome, readTextFile, writeTextFile, theme, run, shared, setShared, terminals, agents, spaces, checking } from "herdr";

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
// The most workers an orchestrator runs at the same time (1 reviewer keeps up with 3-4).
const MAX_PARALLEL = 3;

// The command line that starts an agent with this pick. The orchestrator gets no edit tools
// where the agent allows it (Claude Code: only Bash, and only hc and git worktree run without asking).
// Codex's read-only sandbox also blocks hc, so Codex and Antigravity are held back by the brief only.
function argv(pick, role) {
  if (pick.agent === "claude") {
    const lock = role === "orchestrator" ? ["--permission-mode", "manual", "--tools", "Bash", "--allowedTools", "Bash(hc *)", "Bash(git worktree *)", "Bash(git -C * worktree *)"] : [];
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
Change only the files the task says you own. If you need to change another file, ask the orchestrator first.
If the task gives you a port, use only that port for servers you start.
If the task says you work in a git worktree, commit your changes on its branch before you report, and name the branch in the report.
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
- The only commands you run are hc commands and git worktree commands. If you catch yourself about to do a task, stop and give it to a worker.
- Do not use your own built-in subagents or tools to do work. Use only the helpers below, started with hc.

First run: hc label "$HC_TERMINAL_ID" ${ROLE_LABEL}=orchestrator   then: echo $HC_TERMINAL_ID   (that is your address).

Helpers (always --bg, a short unique --name, and your address so they can report back):
- worker (${describe(picks.worker)}): hc run --bg --rm --name w-<short> --cwd <folder> worker "<task brief>"
- reviewer (${describe(picks.reviewer)}): hc run --bg --rm --name review --cwd <folder> reviewer "Goal: <goal>. Tasks and worker reports: <each task, its worker, what it reported and where it changed things>. Run the tests and lint yourself. Orchestrator address: <your address>."
  Start exactly ONE reviewer, once, after every worker has reported. Never one reviewer per worker.

Every task brief has these parts, each on its own line:
  Goal: <what to do, in one or two sentences>
  Done when: <a check anyone can run or see>
  Files you own: <the files or folders this worker may change; no two workers own the same file>
  Read first: <files or docs to read before starting>
  Do not: <what is out of scope>
  Port: <a free port number only for this worker, if it may start a server>
  Report: what you did, files changed, tests run and their result, anything unfinished.
  Orchestrator address: <your address>

How many workers (match the effort to the goal, do not over-staff):
- A question or a small change in one place: 1 worker.
- A change in a few independent parts: 2 or 3 workers in parallel.
- Bigger work: phases. At most ${MAX_PARALLEL} workers run at the same time; start the next phase after the current one has reported.
Never more than ${MAX_PARALLEL} workers at once.

Branches and folders (in a git repo). Never merge into the user's branch; the user merges.
- Make one result branch for the goal: git -C <repo> worktree add ~/.herdr/worktrees/<repo name>/<goal slug> -b orch/<goal slug>
- One worker that changes files: it works in that result worktree.
- Parallel workers that change files: each gets its own worktree from the result branch:
    git -C <repo> worktree add ~/.herdr/worktrees/<repo name>/<worker name> -b orch/<goal slug>-<worker name> orch/<goal slug>
  and its brief says: "You work in a git worktree on branch orch/<goal slug>-<worker name>."
- Workers that only read use <repo> directly.

How to work:
1. Split the goal into tasks. If you don't know enough to split it, first start one worker to investigate and report (this one needs no approval).
2. Show the user the plan before any worker that changes files starts: each task, its worker, the files it owns, which run in parallel, and how many workers in total. Wait for the user's OK. Change the plan if they ask.
3. Start the workers (see "How many workers" and "Branches and folders").
4. Collect each worker's report. Keep waiting until every worker has reported.
5. If parallel workers used their own worktrees: start one more worker in the result worktree to merge their branches into orch/<goal slug> and resolve conflicts, and wait for its report.
6. Then start the single reviewer in the result worktree with the goal and all the reports, and wait for its review.
7. Wait with hc wait --children any. Never sleep or poll. Reports arrive as <hc from=...> messages.
8. If a helper is stuck on a start-up question (trust this folder, a permission), read it with hc read <name> and answer it (hc keys <name> enter), or ask the user.
9. Answer the user only after the review is in: what each worker did, the reviewer's findings, and the branch orch/<goal slug> to review and merge. Do not fix the findings yourself or start new work unless the user asks.
10. Keep the helpers open after you answer. For a follow-up on the same goal, send it to the worker that did that part (hc send <name> "<follow-up>. Report back the same way.") and, when the follow-up changes code, have the reviewer check it (hc send review ...).
11. When the goal is finished completely (the user says it is done, or gives you a new goal that is not a follow-up), close every helper you started: hc kill <name> for each (--rm removes it from the sidebar). Check with hc ls that none of yours is left. Remove the worker worktrees: git -C <repo> worktree remove <path> for each. Keep the result branch; ask the user before anyone deletes branches.
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

  // One line per role; a click opens its chips. Only one role is open at a time.
  role(t, role, pick) {
    const open = this.openRole === role.id;
    const models = this.modelsWithPick(pick);
    const efforts = models.find((m) => m.id === pick.model)?.efforts ?? [];
    const label = (s) => div().text_size(10.5).text_color(t.dim).child(s);
    const promptOnly = role.id === "orchestrator" && pick.agent !== "claude";
    return v_flex().gap(6).rounded(8).bg(t.background).border(1).border_color(open ? t.accent : t.border)
      .child(h_flex().id(`role-${role.id}`).px(10).py(8).gap(8).items_center().rounded(8).cursor_pointer().hover((s) => s.bg(t.hover))
        .tooltip(open ? "Close" : role.about)
        .on_click((_e, cx) => { this.openRole = open ? null : role.id; cx.notify(); })
        .child(div().w(82).flex_none().text_size(12.5).font_semibold().text_color(t.foreground).child(role.label))
        .child(div().flex_1().min_w(0).truncate().text_size(11.5).text_color(t.muted)
          .child(`${AGENTS.find((a) => a.id === pick.agent)?.label} · ${models.find((m) => m.id === pick.model)?.label ?? pick.model}${pick.effort ? ` · ${pick.effort}` : ""}`))
        .child(div().flex_none().text_size(10.5).text_color(t.dim).child(open ? "Close" : "Change")))
      .when(promptOnly, (el) => el.child(div().px(10).pb(open ? 0 : 8).text_size(10.5).text_color(t.blocked)
        .child("Only Claude Code is locked out of editing. This agent is held back by its instructions only.")))
      .when(open, (el) => el.child(v_flex().px(10).pb(10).gap(6)
        .child(div().text_size(10.5).text_color(t.dim).child(role.about))
        .child(label("Agent"))
        .child(this.chips(t, `${role.id}-agent`, AGENTS, pick.agent, (v, cx) => this.setPick(role.id, { agent: v }, cx)))
        .child(label("Model"))
        .child(models.length ? this.chips(t, `${role.id}-model`, models, pick.model, (v, cx) => this.setPick(role.id, { model: v }, cx))
          : div().text_size(11).text_color(t.dim).child(this.catalog ? "No models found" : "Loading models..."))
        .when(efforts.length > 0, (el) => el.child(label("Effort"))
          .child(this.chips(t, `${role.id}-effort`, efforts.map((e) => ({ id: e, label: e })), pick.effort, (v, cx) => this.setPick(role.id, { effort: v }, cx))))));
  }

  dot(t, status) {
    const color = { working: t.working, blocked: t.blocked, done: t.done, idle: t.idle }[status] ?? t.dim;
    return div().size(7).flex_none().rounded(4).bg(color);
  }

  // The tab name when a person named the tab (not a number, not the program name), else the
  // terminal title, else the address: what tells two agents of the same program apart.
  agentName(a) {
    const info = this.agentInfo?.get(a.address);
    const tab = info?.tab_name?.trim();
    if (tab && !/^\d+$/.test(tab) && tab !== a.program?.name) return tab;
    return info?.title?.trim() || a.address;
  }

  agentRow(t, a, spaceName) {
    const on = a.labels?.[ROLE_LABEL] === "orchestrator";
    return h_flex().id(`orch-${a.address}`).px(8).h(30).gap(8).items_center().rounded(6).hover((s) => s.bg(t.hover))
      .child(this.dot(t, a.status))
      .child(div().id(`focus-${a.address}`).flex_1().min_w(0).truncate().text_size(12).text_color(t.foreground).cursor_pointer()
        .tooltip(`Show this agent (${a.address})`).on_click(() => run("agent.focus", { terminal: a.address }))
        .child(this.agentName(a)))
      .child(div().flex_none().max_w(110).truncate().text_size(10.5).text_color(t.dim)
        .child(`${a.program?.name ?? ""}${spaceName ? ` · ${spaceName}` : ""}`))
      .child(div().id(`switch-${a.address}`).w(30).h(16).rounded(8).p(2).flex().bg(on ? t.accent : t.border)
        .when(on, (el) => el.justify_end())
        .tooltip(on ? "Stop being the orchestrator" : "Make this agent the orchestrator (held back by its instructions only: it keeps its edit tools)")
        .on_click((_e, cx) => this.toggle(a, !on, cx))
        .child(div().size(12).rounded(6).bg(on ? t.accent_foreground : t.muted)));
  }

  // The helpers an orchestrator started, under it: status, name, role; a click shows the helper.
  helperRow(t, h) {
    return h_flex().id(`helper-${h.address}`).ml(14).pl(10).pr(8).h(26).gap(8).items_center().rounded(6)
      .border_l(1).border_color(t.border).cursor_pointer().hover((s) => s.bg(t.hover))
      .tooltip("Show this helper").on_click(() => run("agent.focus", { terminal: h.address }))
      .child(this.dot(t, h.status))
      .child(div().flex_1().min_w(0).truncate().text_size(11.5).text_color(t.foreground).child(h.name ?? h.address))
      .child(div().flex_none().text_size(10.5).text_color(t.dim).child(`${h.template ?? h.program?.name ?? ""} · ${h.status ?? h.state}`));
  }

  render() {
    const t = theme();
    const picks = this.picks();
    const all = terminals();
    this.agentInfo = new Map(agents().map((x) => [x.address, x]));
    const live = all.filter((x) => x.state === "live" && x.program?.agent && !x.parent);
    const spaceOf = new Map(spaces().map((s) => [s.id, s.name]));
    const helpers = (a) => all.filter((x) => x.state === "live" && x.parent === a.address);
    const head = (s) => div().pt(4).text_size(11.5).font_medium().text_color(t.dim).child(s);
    // Orchestrators and their helpers that wait for the person; a click shows the first one.
    const orchs = live.filter((a) => a.labels?.[ROLE_LABEL] === "orchestrator");
    const blocked = [...orchs, ...orchs.flatMap(helpers)].filter((x) => x.status === "blocked");
    return v_flex().id("orchestra").size_full().min_h(0).bg(t.surface)
      // Pinned: the main action never scrolls away.
      .child(v_flex().flex_none().px(12).pt(12).pb(10).gap(8).border_b(1).border_color(t.border)
        .child(h_flex().justify_between().items_center()
          .child(h_flex().gap(8).items_center()
            .child(div().text_size(14).font_semibold().text_color(t.foreground).child("Orchestra"))
            .when(blocked.length > 0, (el) => el.child(div().id("need-you").px(7).py(1).rounded(5).text_size(11).font_semibold()
              .bg(t.blocked + "26").text_color(t.blocked).cursor_pointer()
              .tooltip(`Show ${blocked[0].name ?? blocked[0].address}`)
              .on_click(() => run("agent.focus", { terminal: blocked[0].address }))
              .child(`${blocked.length} need${blocked.length === 1 ? "s" : ""} you`))))
          .child(div().id("reload-models").text_size(11).text_color(t.dim).hover((s) => s.text_color(t.foreground))
            .tooltip("Read the model lists again").on_click((_e, cx) => this.loadCatalog(cx)).child("Reload models")))
        .child(div().id("start-orch").w_full().py(7).rounded(6).flex().justify_center().text_size(12.5).font_medium()
          .bg(t.solid).text_color(t.solid_foreground).hover((s) => s.opacity(0.9))
          .tooltip(`Opens a new tab with ${describe(picks.orchestrator)}`)
          .on_click(() => this.startOrchestrator()).child("Start orchestrator"))
        .when(Boolean(this.status), (el) => el.child(div().text_size(11.5).text_color(t.blocked).child(this.status))))
      .child(v_flex().id("orchestra-body").flex_1().min_h(0).p(12).gap(8).overflow_y_scrollbar()
        .child(head("Roles"))
        .children(ROLES.map((r) => this.role(t, r, picks[r.id])))
        .child(head("Running agents"))
        .when(live.length === 0, (el) => el.child(div().text_size(11).text_color(t.dim).child("No agents running.")))
        .children(live.map((a) => v_flex().gap(2)
          .child(this.agentRow(t, a, spaceOf.get(a.labels?.["herdr.space"])))
          .children(helpers(a).map((h) => this.helperRow(t, h))))));
  }
}
