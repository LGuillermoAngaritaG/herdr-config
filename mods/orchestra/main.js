// Orchestrator, worker and reviewer: pick an agent, a model and an effort for each.
// Worker and reviewer become hc templates; the orchestrator starts in a new tab, or any
// running agent can be switched into the orchestrator role.
// Council mode: an aggregator gives one goal to three members, each picked here, and
// combines their best answers into one.

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

const COUNCIL_ROLES = [
  { id: "aggregator", label: "Aggregator", about: "Gives the goal to the three members, compares their answers, combines the best. Never does the work." },
  { id: "council1", label: "Member 1", about: "Works on the goal alone, in its own worktree when files change." },
  { id: "council2", label: "Member 2", about: "Works on the goal alone, in its own worktree when files change." },
  { id: "council3", label: "Member 3", about: "Works on the goal alone, in its own worktree when files change." },
];
const MEMBERS = ["council1", "council2", "council3"];
const template = (role) => (role.startsWith("council") ? `council-${role.slice(-1)}` : role);

const MODES = [
  { id: "orchestra", label: "Orchestra", roles: ROLES, lead: "orchestrator", start: "Start orchestrator", tab: "Orchestrator" },
  { id: "council", label: "Council", roles: COUNCIL_ROLES, lead: "aggregator", start: "Start council", tab: "Council" },
];

const DEFAULTS = {
  orchestrator: { agent: "antigravity", model: "gemini-4-neon", effort: "high" },
  worker: { agent: "claude", model: "claude-opus-5-5", effort: "high" },
  reviewer: { agent: "codex", model: "gpt-6.2-sol", effort: "high" },
  aggregator: { agent: "claude", model: "claude-opus-5-5", effort: "high" },
  council1: { agent: "claude", model: "claude-opus-5-5", effort: "high" },
  council2: { agent: "codex", model: "gpt-6.2-sol", effort: "high" },
  council3: { agent: "antigravity", model: "gemini-4-neon", effort: "high" },
};

const ROLE_LABEL = "herdr.role";
// The most workers an orchestrator runs at the same time (1 reviewer keeps up with 3-4).
const MAX_PARALLEL = 3;

// The command line that starts an agent with this pick. The orchestrator gets no edit tools
// where the agent allows it (Claude Code: only Bash, and only hc and git worktree run without asking).
// Codex's read-only sandbox also blocks hc, so Codex and Antigravity are held back by the brief only.
function argv(pick, role) {
  if (pick.agent === "claude") {
    const lock = role === "orchestrator" || role === "aggregator" ? ["--permission-mode", "manual", "--tools", "Bash", "--allowedTools", "Bash(hc *)", "Bash(git worktree *)", "Bash(git -C * worktree *)", "Bash(printenv HC_TERMINAL_ID)",
      // hc exec and hc file run any command or edit any file: they would go around the lock.
      "--disallowedTools", "Bash(hc exec *)", "Bash(hc file *)"] : [];
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
You start after all the workers have finished. You get the goal, every task, and what each worker reported.
Later the orchestrator may send you fixes to recheck: then check only those fixes.
Check the actual results (the changed files, git diff, outputs), not only the reports. Do not edit files and do not start other agents.
Look for bugs, missing tests, conflicts between workers' changes, and anything that does not match the goal.
Report one review covering all tasks: findings ranked by severity per task, each with your advice (fix it, or fine to leave and why), or say it all looks good. Send it with: hc send <orchestrator address> "<review>".
The task names the orchestrator's address.`,
  councillor: `You are one of three council members started by an aggregator agent. The other two get the same goal; you work alone and do not see their work.
Do your best complete answer to the goal: the solution, the plan or the document it asks for. Do not start other agents.
Work only in the folder you start in. If the goal names a git worktree, commit your changes on its branch before you report, and name the branch.
Run the relevant tests when you change code.
When you finish or get stuck, report to the aggregator with: hc send <its address> "<report>".
The report has: your answer (or where it is: branch, file), the main choices you made and why, what you tested, and what is weak or uncertain. The aggregator compares it with the others.
Later the aggregator may ask you to take parts of the other members' work into yours, or to check the combined result: do just that and report the same way.
The goal names the aggregator's address.`,
};

function orchestratorBrief(picks) {
  return `You are now the ORCHESTRATOR. You only plan, delegate, check and report. Other agents do ALL the work.

Hard rules:
- Never do the work yourself: do not edit, create or delete files, do not write code, do not run builds or tests, do not read through the code to solve things.
- Even research is delegated: if you need to know how something works, start a worker to find out and report back.
- The only commands you run are hc commands and git worktree commands. If you catch yourself about to do a task, stop and give it to a worker.
- Do not use your own built-in subagents or tools to do work. Use only the helpers below, started with hc.

First run these two commands, one at a time: printenv HC_TERMINAL_ID   (that is your address), then: hc label <your address> ${ROLE_LABEL}=orchestrator

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
  Report: send it with hc send <orchestrator address> "<report>": what you did, files changed, tests run and their result, anything unfinished.
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
8. Right after you start a helper in a folder it has not used before, check it once with hc read <name>. If it asks to trust the folder or a similar start-up question, answer it (hc keys <name> enter). Do not kill and restart it for that.
9. You judge the review yourself. Never ask the user to review it or to choose which findings to fix. For each finding decide: fix it, or leave it (with a reason). Send each fix to the worker that did that part (hc send <name> "<fix>. Report back the same way."), wait for the reports, then send the fixes to the same reviewer to recheck only those (hc send review "<what changed>"). At most 2 fix rounds; whatever is still open after that goes in your answer as open.
10. Ask the user only for what is theirs to decide: an action they have not approved yet that is hard to undo or reaches outside this machine (deploy, publish, merge into their branch, spend money, delete data), or a choice between product directions. Everything else you decide.
11. Close each helper as soon as it is no longer needed: hc kill <name> (--rm removes it from the sidebar). A read-only worker once its report is in; a worker that changed files once the review has no open fix for its part. Keep only the reviewer and the workers with open items.
12. Answer the user once the review and your fixes are done: what was done, what the review found, what you fixed, what you left and why, and the branch orch/<goal slug> to review and merge.
13. For a follow-up on the same goal, send it to the worker that did that part if it is still open, otherwise start a new worker with what the earlier one reported; have the reviewer check any change.
14. When the goal is finished completely (the user says it is done, or gives you a new goal that is not a follow-up), close every helper you started: hc kill <name> for each (--rm removes it from the sidebar). Check with hc ls that none of yours is left. Remove the worker worktrees: git -C <repo> worktree remove <path> for each. Keep the result branch; ask the user before anyone deletes branches.
Run hc --skill once if you need the full hc manual.

Now ask the user for the goal, unless they already gave it.`;
}

function councilBrief(picks) {
  return `You are now the AGGREGATOR of a council. Three members work on the same goal on their own; you compare their answers and combine the best into one. You never do the work.

Hard rules:
- Never do the work yourself: do not edit, create or delete files, do not write code, do not run builds or tests, do not read through the code to solve things.
- The only commands you run are hc commands and git worktree commands.
- Do not use your own built-in subagents or tools to do work. Use only the members below, started with hc.

First run these two commands, one at a time: printenv HC_TERMINAL_ID   (that is your address), then: hc label <your address> ${ROLE_LABEL}=aggregator

Members (always all three, always --bg):
${MEMBERS.map((m, i) => `- member ${i + 1} (${describe(picks[m])}): hc run --bg --rm --name c${i + 1}-<goal slug> --cwd <folder> ${template(m)} "<goal brief>"`).join("\n")}

The goal brief is the same for all three, each line on its own:
  Goal: <what the user wants, with everything they told you>
  Done when: <what a complete answer looks like>
  Read first: <files or docs, if any>
  Do not: <what is out of scope; never deploy, publish or merge into the user's branch>
  Folder: <the member's folder, see below>
  Aggregator address: <your address>

Folders:
- The goal changes files in a git repo: each member gets its own worktree from the current branch:
    git -C <repo> worktree add ~/.herdr/worktrees/<repo name>/<goal slug>-c<n> -b council/<goal slug>-c<n>
  and its brief says: "You work in a git worktree on branch council/<goal slug>-c<n>. Commit there."
- A plan, a document or an answer that is not code: each member works in <repo or the user's folder> and writes its answer into its own folder ~/.herdr/council/<goal slug>/c<n>, which its brief tells it to create.
- A question about a repo that changes nothing: all three read <repo> directly.

How to work:
1. Get the goal from the user, unless they already gave it. If it is unclear, ask once; otherwise start right away.
2. Start the three members in parallel. Right after, check each once with hc read <name>; if one asks to trust the folder or a similar start-up question, answer it (hc keys <name> enter).
3. Wait with hc wait --children any until all three have reported. Never sleep or poll. Reports arrive as <hc from=...> messages.
4. Compare the three yourself. Never ask the user to compare or choose. For each answer note what is strong, what is wrong or missing. Pick the best one as the base and list the parts worth taking from the other two. Where they disagree, decide and keep the reason.
5. If files changed: ask the base member (hc send) to take those parts into its branch (it can read the other branches by name) and report. Close the other two members as soon as you no longer need them (hc kill <name>).
   If nothing changed in files: you write the combined answer yourself from the reports; that is your job, not work.
6. Ask one of the other members, before you close it, to check the combined result against the goal and report real problems only. Fix real problems once, through the base member.
7. Answer the user: the combined answer itself (the plan, the document, or the branch council/<goal slug>-c<n> to review and merge), what came from which member, where they disagreed and what you chose, and what is still open.
8. Ask the user only for what is theirs to decide: an action they have not approved that is hard to undo or reaches outside this machine (deploy, publish, merge into their branch, spend money, delete data), or a choice between product directions.
9. After you answer, keep only the base member open for follow-ups; close the rest. When the goal is finished completely (the user says so, or gives a new goal), close every member (hc kill <name>), check with hc ls that none of yours is left, and remove the worktrees of the members that were not the base (git -C <repo> worktree remove <path>). Keep the branches.
Run hc --skill once if you need the full hc manual.

Now ask the user for the goal, unless they already gave it.`;
}

const STOP_BRIEF = `You are no longer the orchestrator or aggregator. Do not start new helpers. Tell the user which helpers are still running (hc ls) and ask whether to stop them. Then run: hc label "$HC_TERMINAL_ID" ${ROLE_LABEL}=`;

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
        for (const role of ["worker", "reviewer", ...MEMBERS]) {
          const name = template(role);
          const path = `${dir}/${name}.md`;
          const about = { worker: "Does one task", reviewer: "Reviews all the work at the end" }[role] ?? `Council member ${role.slice(-1)}`;
          const text = `---\nname: ${name}\ndescription: ${about} (${describe(picks[role])}), set in Herdr's Orchestra panel\ncommand: ${argv(picks[role], role).map((a) => (/^[\w.\-=/]+$/.test(a) ? a : `'${a}'`)).join(" ")}\n---\n${TEMPLATE_BODY[MEMBERS.includes(role) ? "councillor" : role]}\n`;
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

  mode() {
    return MODES.find((m) => m.id === shared("orchestra.mode")) ?? MODES[0];
  }

  brief(mode, picks) {
    return mode.id === "council" ? councilBrief(picks) : orchestratorBrief(picks);
  }

  start() {
    const picks = this.picks();
    const mode = this.mode();
    const lead = picks[mode.lead];
    // The brief goes on the command line: Antigravity only takes a first prompt with -i.
    const brief = this.brief(mode, picks);
    // Claude reads words after --allowedTools as more tools: the brief goes after --.
    const first = { antigravity: ["-i", brief], claude: ["--", brief] }[lead.agent] ?? [brief];
    run("tab.new", { name: mode.tab, argv: [...argv(lead, mode.lead), ...first] });
  }

  toggle(t, on, cx) {
    cx.spawn(async (cx) => {
      const mode = this.mode();
      const r = await hc(["send", t.address, on ? this.brief(mode, this.picks()) : STOP_BRIEF]);
      if (r.code === 0) await hc(["label", t.address, `${ROLE_LABEL}=${on ? mode.lead : ""}`]);
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
    const promptOnly = (role.id === "orchestrator" || role.id === "aggregator") && pick.agent !== "claude";
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

  agentRow(t, a, spaceName, mode) {
    const on = a.labels?.[ROLE_LABEL] === mode.lead;
    return h_flex().id(`orch-${a.address}`).px(8).h(30).gap(8).items_center().rounded(6).hover((s) => s.bg(t.hover))
      .child(this.dot(t, a.status))
      .child(div().id(`focus-${a.address}`).flex_1().min_w(0).truncate().text_size(12).text_color(t.foreground).cursor_pointer()
        .tooltip(`Show this agent (${a.address})`).on_click(() => run("agent.focus", { terminal: a.address }))
        .child(this.agentName(a)))
      .child(div().flex_none().max_w(110).truncate().text_size(10.5).text_color(t.dim)
        .child(`${a.program?.name ?? ""}${spaceName ? ` · ${spaceName}` : ""}`))
      .child(div().id(`switch-${a.address}`).w(30).h(16).rounded(8).p(2).flex().bg(on ? t.accent : t.border)
        .when(on, (el) => el.justify_end())
        .tooltip(on ? `Stop being the ${mode.lead}` : `Make this agent the ${mode.lead} (held back by its instructions only: it keeps its edit tools)`)
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
    const mode = this.mode();
    const orchs = live.filter((a) => MODES.some((m) => a.labels?.[ROLE_LABEL] === m.lead));
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
        // Which mode the start button, the roles and the switches below use.
        .child(h_flex().p(2).gap(2).rounded(7).bg(t.background).border(1).border_color(t.border)
          .children(MODES.map((m) => div().id(`mode-${m.id}`).flex_1().py(4).rounded(5).flex().justify_center().text_size(12)
            .bg(m.id === mode.id ? t.selected : t.background).text_color(m.id === mode.id ? t.foreground : t.muted)
            .cursor_pointer().hover((s) => s.text_color(t.foreground))
            .tooltip(m.id === "council" ? "Three agents work on the same goal; an aggregator combines the best answers" : "An orchestrator splits the goal between workers, and one reviewer checks it")
            .on_click((_e, cx) => { setShared("orchestra.mode", m.id); this.openRole = null; cx.notify(); })
            .child(m.label))))
        .child(div().id("start-orch").w_full().py(7).rounded(6).flex().justify_center().text_size(12.5).font_medium()
          .bg(t.solid).text_color(t.solid_foreground).hover((s) => s.opacity(0.9))
          .tooltip(`Opens a new tab with ${describe(picks[mode.lead])}`)
          .on_click(() => this.start()).child(mode.start))
        .when(Boolean(this.status), (el) => el.child(div().text_size(11.5).text_color(t.blocked).child(this.status))))
      .child(v_flex().id("orchestra-body").flex_1().min_h(0).p(12).gap(8).overflow_y_scrollbar()
        .child(head("Roles"))
        .children(mode.roles.map((r) => this.role(t, r, picks[r.id])))
        .child(head("Running agents"))
        .when(live.length === 0, (el) => el.child(div().text_size(11).text_color(t.dim).child("No agents running.")))
        .children(live.map((a) => v_flex().gap(2)
          .child(this.agentRow(t, a, spaceOf.get(a.labels?.["herdr.space"]), mode))
          .children(helpers(a).map((h) => this.helperRow(t, h))))));
  }
}
