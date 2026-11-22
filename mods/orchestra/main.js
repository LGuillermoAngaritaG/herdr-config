// Orchestrator, worker and reviewer: pick an agent, a model and an effort for each.
// Worker and reviewer become hc templates; the orchestrator starts in a new tab, or any
// running agent can be switched into the orchestrator role.
// Council mode: an aggregator gives one goal to three members, each picked here, and
// combines their best answers into one.
// The panel has two views. Runs: the leads and their helpers, most urgent first, with counts that
// filter them. Team setup: the mode, the start button, the roles, and who leads among the running agents.
// Every control works from the keyboard too (Up/Down, Enter, Esc, Left/Right, 1/2, N, R).
// With props { button: true } it is the tab bar's button that shows and hides the panel (node "orch").

import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex, ScrollHandle } from "gpui-base";
import { exec, hc, home, appHome, readTextFile, writeTextFile, theme, run, shared, setShared, terminals, agents, spaces, checking, nextCommand, props, layout, knownAgents } from "herdr";

const AGENTS = [
  { id: "claude", label: "Claude Code" },
  { id: "codex", label: "Codex" },
  { id: "antigravity", label: "Antigravity" },
  { id: "pi", label: "Pi" },
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
  // Pi has no per-command allowlist: the lead roles only lose its edit and write tools.
  if (pick.agent === "pi") return ["pi", "--model", pick.model, ...(pick.effort ? ["--thinking", pick.effort] : []), ...(role === "orchestrator" || role === "aggregator" ? ["--tools", "bash"] : [])];
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

const RANK = { error: 5, blocked: 4, done: 3, working: 2, idle: 1 };
const WORD = { error: "Error", blocked: "Needs you", done: "Done", working: "Working", idle: "Idle" };
const statusOf = (x) => x.status ?? "idle";
// A helper that failed needs the person as much as one that asks.
const needsYou = (x) => x.status === "blocked" || x.status === "error";
// The lead role a terminal carries (its herdr.role label), or null.
const leadOf = (a) => MODES.find((m) => a.labels?.[ROLE_LABEL] === m.lead)?.lead ?? null;

// The counts above the runs. A press on one shows only the agents in that state.
const FILTERS = [
  { id: "blocked", label: "Needs you", has: needsYou },
  { id: "done", label: "Done", has: (x) => x.status === "done" },
  { id: "working", label: "Working", has: (x) => x.status === "working" },
];

function find(node, id) {
  if (node?.id === id) return node;
  for (const child of node?.children ?? []) {
    const found = find(child, id);
    if (found) return found;
  }
  return null;
}

// Council members are named c<n>-<goal>: the goal tells two runs apart.
function goalOf(kids) {
  const goals = new Set(kids.map((k) => /^c\d+-(.+)$/.exec(k.name ?? "")?.[1]));
  return goals.size === 1 ? [...goals][0] ?? null : null;
}

// The fullest limit that applies, when it is 75% used or more, from the numbers the Limits panel
// shares. `model` (lower case: id and name) picks the limits named after it ("Fable week",
// "Claude/GPT 5h"); `general` adds the tool's limits that count for every model.
function tightLimit(agent, model, general) {
  const now = Date.now() / 1000;
  const used = (w) => (w.resets_at && w.resets_at < now ? 0 : w.used);
  const applies = (w) => {
    const who = w.label.split(" ").slice(0, -1).join(" ").toLowerCase();
    return who ? who.split("/").some((part) => model.includes(part)) : general;
  };
  const ws = ((shared("limits.tools") ?? []).find((x) => x.id === agent)?.windows ?? []).filter(applies);
  const w = ws.reduce((m, x) => (!m || used(x) > used(m) ? x : m), null);
  return w && used(w) >= 75 ? { label: w.label, used: Math.round(used(w)) } : null;
}

export default class Orchestra extends View {
  init(_props, cx) {
    this.handle = cx.focus_handle();
    this.scroll = ScrollHandle.new();
    // In the tab bar this mod is only the button that shows and hides the panel.
    this.button = Boolean(props()?.button);
    this.items = [];
    this.catalog = null;
    try { this.catalog = JSON.parse(localStorage.getItem("catalog") ?? "null"); } catch { this.catalog = null; }
    if (checking()) return;
    if (!this.button) {
      this.loadCatalog(cx);
      this.loadInstalled(cx);
      this.writeTemplates(cx);
    }
    // focus: pane.go moved the keyboard here. For the panel: orchestra.runs / .setup choose the view,
    // .orchestra / .council the mode, .open-<role> opens a role's choices, .start presses the start button.
    cx.spawn(async (cx) => {
      for (;;) {
        const c = await nextCommand();
        if (c === "focus") {
          this.handle.focus();
        } else if (!this.button && typeof c === "string") {
          if (c === "runs" || c === "setup") this.show(c);
          if (MODES.some((m) => m.id === c)) this.setMode(c);
          if (c.startsWith("open-")) { this.show("setup"); this.openRole = c.slice(5) || null; }
          if (c === "start") this.start();
        }
        cx.notify();
      }
    });
  }

  picks() {
    return { ...DEFAULTS, ...(shared("orchestra.picks") ?? {}) };
  }

  // The CLIs this machine does not have. When the check fails, none is marked.
  loadInstalled(cx) {
    cx.spawn(async (cx) => {
      try {
        this.absent = new Set((await knownAgents()).filter((a) => !a.installed).map((a) => a.key));
        cx.notify();
      } catch {}
    });
  }

  loadCatalog(cx) {
    if (this.loading) return;
    this.loading = true;
    cx.spawn(async (cx) => {
      try {
        const r = await exec("python3", ["-I", `${appHome()}/mods/orchestra/models.py`], { timeout: 90000 });
        this.catalog = JSON.parse(r.stdout);
        localStorage.setItem("catalog", JSON.stringify(this.catalog));
      } catch (e) {
        this.status = `Could not list models: ${e}`;
      }
      this.loading = false;
      cx.notify();
    });
  }

  models(agent) {
    return this.catalog?.[agent] ?? [];
  }

  // A model the list doesn't have stays selectable, so a saved pick is never lost. It is called
  // "not listed" only once the lists are read: before that, the list is just not there yet.
  modelsWithPick(pick) {
    const list = this.models(pick.agent);
    if (!pick.model || list.some((m) => m.id === pick.model)) return list;
    const missing = Boolean(this.catalog) && !this.loading;
    return [...list, { id: pick.model, label: missing ? `${pick.model} (not listed)` : pick.model, efforts: ["low", "medium", "high", "xhigh", "max"], missing }];
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
    // Back to the runs once the new lead shows up there.
    this.chosen = null;
  }

  // Gives an agent the lead role of the mode (`was` null), or takes its role `was` away. `ask` is
  // what the person confirmed: when the agent's role or the mode is no longer that, nothing is sent.
  setLead(ask, cx) {
    cx.spawn(async (cx) => {
      const { address, was, mode } = ask;
      const now = terminals().find((x) => x.address === address && x.state === "live");
      if (!now || leadOf(now) !== was || this.mode().id !== mode) {
        this.status = `Nothing was sent to ${address}: its role or the mode changed. Look again, then repeat.`;
        cx.notify();
        return;
      }
      const m = MODES.find((x) => x.id === mode);
      const sent = await hc(["send", address, was ? STOP_BRIEF : this.brief(m, this.picks())]);
      if (sent.code) {
        this.status = `Could not reach ${address}: ${sent.stderr.trim()}`;
      } else {
        const marked = await hc(["label", address, `${ROLE_LABEL}=${was ? "" : m.lead}`]);
        // A brief can't be taken back: say that it arrived, also when the label did not follow.
        this.half = { ...this.half, [address]: marked.code ? (was ? "" : m.lead) : undefined };
        this.status = marked.code ? `${address} got the ${was ? "stop" : m.lead} brief, but its role label could not be ${was ? "cleared" : "set"}: ${marked.stderr.trim()}. Do not send the brief again.` : null;
      }
      cx.notify();
    });
  }

  // A helper without a pane of its own opens as a peek over the tab, as in the agents list.
  showAgent(address) {
    run(agents().some((x) => x.address === address) ? "agent.focus" : "terminal.peek", { terminal: address });
  }

  // One after the other, every agent that waits for the person.
  nextWaiting() {
    const list = terminals().filter((x) => x.state === "live" && needsYou(x));
    if (!list.length) return;
    this.turn = ((this.turn ?? -1) + 1) % list.length;
    this.showAgent(list[this.turn].address);
  }

  show(view) {
    if (this.view !== view) this.cursor = null;
    this.chosen = view;
    this.armed = null;
  }

  setMode(id) {
    setShared("orchestra.mode", id);
    this.openRole = null;
    this.show("setup");
  }

  leave() {
    run("pane.go", { direction: "left" });
  }

  close() {
    if (this.handle.is_focused()) this.leave();
    run("layout.hide", { id: "orch" });
  }

  // Esc undoes one thing at a time: a question, an open role, a filter, the setup view. Then it
  // gives the keyboard back to the terminal.
  back() {
    if (this.armed) this.armed = null;
    else if (this.view === "setup" && this.openRole) { this.cursor = `role-${this.openRole}`; this.openRole = null; }
    else if (this.view === "runs" && this.filter) this.filter = null;
    else if (this.view === "setup") this.show("runs");
    else this.leave();
  }

  key(e, cx) {
    const mod = e.modifiers;
    if (mod.control || mod.alt || mod.platform) return;
    const k = e.key;
    const i = this.items.findIndex((x) => x.id === this.cursor);
    const move = (by) => {
      const to = this.items[Math.min(Math.max(i + by, 0), this.items.length - 1)];
      if (!to) return;
      this.cursor = to.id;
      this.armed = null;
      if (to.part !== null) this.scroll.scroll_to_item(to.part);
    };
    if (k === "down" || k === "j" || (k === "tab" && !mod.shift)) move(1);
    else if (k === "up" || k === "k" || k === "tab") move(-1);
    else if (k === "enter" || k === "space") { if (!e.is_held && i >= 0) this.items[i].act(cx); }
    else if (k === "escape") this.back();
    else if (k === "right") this.show("setup");
    else if (k === "left") this.view === "setup" ? this.show("runs") : this.leave();
    else if (k === "1" || k === "2") this.setMode(MODES[k - 1].id);
    else if (k === "n") this.nextWaiting();
    else if (k === "r") this.loadCatalog(cx);
    else return;
    cx.stop_propagation();
    cx.notify();
  }

  // Something the keyboard can choose: Up/Down move over them in the order drawn, Enter presses the
  // chosen one. True when it is the chosen one and the panel has the keyboard.
  reg(id, act) {
    this.next.push({ id, act, part: this.part });
    return this.cursor === id && this.handle.is_focused();
  }

  // A control: the pointer and Enter do the same with it. The chosen one has the accent outline;
  // `edge` is its outline otherwise (the color under it when it has none).
  press(t, el, id, act, edge = t.background) {
    const on = this.reg(id, act);
    return el.id(id).cursor_pointer().border(1).border_color(on ? t.accent : edge)
      .on_click((_e, cx) => { cx.stop_propagation(); this.cursor = id; act(cx); cx.notify(); });
  }

  // A choice can carry a limit that is nearly used up, and can be dimmed (a CLI that is not here).
  chips(t, id, options, selected, fn) {
    return h_flex().flex_wrap().gap(4).children(options.map((o) => {
      const on = o.id === selected;
      return this.press(t, h_flex(), `${id}-${o.id}`, (cx) => fn(o.id, cx), on ? t.input : t.border)
        .px(8).h(24).gap(5).items_center().rounded(5).text_size(11.5)
        .bg(on ? t.selected : t.background)
        .text_color(o.missing ? t.blocked : on ? t.foreground : o.absent ? t.dim : t.muted)
        .when(on, (el) => el.font_medium())
        .hover((s) => s.bg(t.hover))
        .when(Boolean(o.tip), (el) => el.tooltip(o.tip))
        .child(o.label)
        .when(Boolean(o.limit), (el) => el.child(div().text_size(11).font_medium().text_color(o.limit.used >= 90 ? t.blocked : t.working).child(`${o.limit.used}%`)));
    }));
  }

  // A small colored note on a role's line; the tooltip says it in full.
  tag(id, text, color, tip) {
    return div().id(id).flex_none().px(5).h(18).flex().items_center().rounded(4).text_size(11).font_medium()
      .bg(color + "26").text_color(color).tooltip(tip).child(text);
  }

  // A pick as people read it: agent, model name, effort.
  summary(pick) {
    const model = this.modelsWithPick(pick).find((m) => m.id === pick.model)?.label ?? pick.model;
    return `${AGENTS.find((a) => a.id === pick.agent)?.label} · ${model}${pick.effort ? ` · ${pick.effort}` : ""}`;
  }

  // One card per role, on two lines: who, then model and effort. Enter or a click opens its
  // choices; only one role is open at a time.
  role(t, role, pick) {
    const open = this.openRole === role.id;
    const models = this.modelsWithPick(pick);
    const model = models.find((m) => m.id === pick.model);
    const efforts = model?.efforts ?? [];
    const agent = AGENTS.find((a) => a.id === pick.agent)?.label ?? pick.agent;
    const label = (s) => div().text_size(11).text_color(t.muted).child(s);
    const unlocked = "Only Claude Code is locked out of editing. This agent is held back by its instructions only.";
    const canEdit = (role.id === "orchestrator" || role.id === "aggregator") && pick.agent !== "claude";
    const full = (l) => `${l.used}% of the ${l.label} limit is used. It may stop in the middle of the work.`;
    const limit = tightLimit(pick.agent, `${pick.model} ${model?.label ?? ""}`.toLowerCase(), true);
    const head = this.press(t, h_flex(), `role-${role.id}`, () => { this.openRole = open ? null : role.id; this.armed = null; }, t.surface)
      .px(9).py(6).gap(6).items_center().rounded(7).hover((s) => s.bg(t.hover))
      .tooltip(open ? "Close" : role.about)
      .child(v_flex().flex_1().min_w(0).gap(1)
        .child(h_flex().gap(6).items_center()
          .child(div().flex_none().text_size(12.5).font_semibold().text_color(t.foreground).child(role.label))
          .child(div().flex_1().min_w(0).truncate().text_size(11.5).text_color(t.muted).child(agent))
          .when(canEdit, (el) => el.child(this.tag(`edit-${role.id}`, "Can edit", t.working, unlocked)))
          .when(Boolean(limit), (el) => el.child(this.tag(`limit-${role.id}`, `Limit ${limit.used}%`, limit.used >= 90 ? t.blocked : t.working, `${agent}: ${full(limit)}`))))
        .child(div().truncate().text_size(11.5).text_color(t.muted).child(`${model?.label ?? "Choose a model"}${pick.effort ? ` · ${pick.effort}` : ""}`)))
      .child(svg(`mods/workspace-chrome/chevron-${open ? "down" : "right"}.svg`).size(13).flex_none().text_color(t.muted));
    const card = v_flex().flex_none().rounded(8).bg(t.surface).border(1).border_color(open ? t.input : t.border).child(head);
    if (!open) return card;
    const agentChoices = AGENTS.map((a) => {
      const absent = Boolean(this.absent?.has(a.id));
      const l = tightLimit(a.id, "", true);
      return { ...a, absent, limit: l, tip: absent ? `${a.label} was not found on this machine` : l ? `${a.label}: ${full(l)}` : null };
    });
    const modelChoices = models.map((m) => {
      const l = tightLimit(pick.agent, `${m.id} ${m.label}`.toLowerCase(), false);
      return { ...m, limit: l, tip: l ? full(l) : null };
    });
    return card.child(v_flex().px(10).pb(10).gap(6)
      .child(div().text_size(11.5).text_color(t.muted).child(canEdit ? `${role.about} ${unlocked}` : role.about))
      .child(label("Agent"))
      .child(this.chips(t, `${role.id}-agent`, agentChoices, pick.agent, (v, cx) => this.setPick(role.id, { agent: v }, cx)))
      .child(label("Model"))
      .child(models.length ? this.chips(t, `${role.id}-model`, modelChoices, pick.model, (v, cx) => this.setPick(role.id, { model: v }, cx))
        : div().text_size(11.5).text_color(t.muted).child(this.loading ? "Reading the models..." : "No models found"))
      .children(efforts.length ? [label("Effort"),
        this.chips(t, `${role.id}-effort`, efforts.map((e) => ({ id: e, label: e })), pick.effort, (v, cx) => this.setPick(role.id, { effort: v }, cx))] : []));
  }

  // The same marks as the tabs and the agents list: a spinner while working, else a dot.
  mark(t, status) {
    return div().w(12).flex_none().flex().justify_center().child(status === "working"
      ? svg("mods/workspace-chrome/spinner.svg").size(12).text_color(t.working).spin(900)
      : div().size(7).rounded(4).bg(status === "error" ? t.blocked : t[status] ?? t.dim));
  }

  // The status as a word, so it does not depend on color alone.
  word(t, status) {
    if (status === "blocked" || status === "error") return div().flex_none().px(6).h(18).flex().items_center().rounded(5).bg(t.blocked + "26").text_size(11).font_semibold().text_color(t.blocked).child(WORD[status]);
    return div().flex_none().text_size(11).text_color(status === "done" ? t.done : t.muted).child(WORD[status] ?? status);
  }

  // The tab name when a person named the tab (not a number, not the program name), else the
  // terminal title, else the address: what tells two agents of the same program apart.
  agentName(a) {
    const info = this.agentInfo?.get(a.address);
    const tab = info?.tab_name?.trim();
    if (tab && !/^\d+$/.test(tab) && tab !== a.program?.name) return tab;
    return info?.title?.trim() || a.address;
  }

  where(a, spaceOf) {
    const space = spaceOf.get(a.labels?.["herdr.space"]);
    return `${a.program?.name ?? ""}${space ? ` · ${space}` : ""}`;
  }

  // An orchestrator or aggregator: its status, its name and what tells it apart from the others.
  leadRow(t, a, name, about, lead, first) {
    const status = statusOf(a);
    return this.press(t, h_flex(), `row-${a.address}`, () => this.showAgent(a.address))
      .px(7).h(32).gap(8).items_center().rounded(6).hover((s) => s.bg(t.hover))
      .when(!first, (el) => el.mt(6))
      .tooltip(`Show this ${lead} (${a.address})`)
      .child(this.mark(t, status))
      .child(div().flex_none().max_w(150).truncate().text_size(12.5).font_medium().text_color(t.foreground).child(name))
      .child(div().flex_1().min_w(0).truncate().text_size(11.5).text_color(t.muted).child(about))
      .child(this.word(t, status));
  }

  // A helper under its lead, or under another helper (one step in per level): status, name, role.
  helperRow(t, h, depth, name) {
    const status = statusOf(h);
    return this.press(t, h_flex(), `row-${h.address}`, () => this.showAgent(h.address))
      .ml(14 * depth).pl(8).pr(7).h(26).gap(8).items_center().rounded(6).hover((s) => s.bg(t.hover))
      .tooltip(`Show this helper (${h.address})`)
      .child(this.mark(t, status))
      .child(div().flex_1().min_w(0).truncate().text_size(11.5).text_color(t.foreground).child(name))
      .child(div().flex_none().text_size(11).text_color(t.muted).child(h.template ?? h.program?.name ?? ""))
      .child(this.word(t, status));
  }

  // A running agent in the setup: give it the lead role of the chosen mode, or take that role away.
  // Both send a brief into a running agent, which can't be taken back: the first press only asks.
  agentRow(t, a, name, mode, spaceOf) {
    const was = leadOf(a);
    const id = `lead-${a.address}`;
    // The question is about this agent, with this role, in this mode. When one of them is no longer
    // so (its label changed, the mode changed), the question is not waiting any more.
    const ask = `${a.address}|${was ?? ""}|${mode.id}`;
    const armed = this.armed === ask;
    if (armed) this.armedShown = true;
    const tip = was ? `Tells it to stop being the ${was}. Its helpers keep running until you stop them.`
      : `Sends the ${mode.lead} brief into this agent. It keeps its edit tools: only its instructions hold it back.`;
    const act = (cx) => {
      if (!armed) { this.armed = ask; this.armedAt = Date.now(); return; }
      // A double click or a key pressed twice in a row is not an answer.
      if (Date.now() - this.armedAt < 400) return;
      this.armed = null;
      this.setLead({ address: a.address, was, mode: mode.id }, cx);
    };
    // A brief arrived but the label did not follow: the row says so until the label is right.
    const half = this.half?.[a.address];
    const note = half === undefined || half === (was ?? "") ? null
      : half ? `Already has the ${half} brief; its label is missing` : "Already has the stop brief; its label is still set";
    const on = this.reg(id, act);
    const button = (key, text, fn) => div().id(key).flex_none().px(7).h(22).flex().items_center().rounded(5).text_size(11).cursor_pointer()
      .on_click((_e, cx) => { cx.stop_propagation(); this.cursor = id; fn(cx); cx.notify(); }).child(text);
    const about = `${was ? `${was} · ` : ""}${this.where(a, spaceOf)}`;
    return h_flex().id(`agent-${a.address}`).flex_none().px(7).h(40).gap(8).items_center().rounded(6).border(1).border_color(on ? t.accent : t.background)
      .child(this.mark(t, statusOf(a)))
      .child(v_flex().flex_1().min_w(0).gap(1)
        .child(div().truncate().text_size(12).text_color(t.foreground).child(name))
        .child(div().truncate().text_size(11).text_color(note && !armed ? t.working : t.muted)
          .child(armed ? (was ? `Take the ${was} role away?` : `Send the ${mode.lead} brief?`) : note ?? about)))
      .children(armed
        ? [button(`${id}-yes`, "Confirm", act).font_medium().bg(t.solid).text_color(t.solid_foreground).tooltip(tip),
          button(`${id}-no`, "Cancel", () => { this.armed = null; }).text_color(t.muted).hover((s) => s.bg(t.hover))]
        : [button(`${id}-go`, was ? "Release" : `Make ${mode.lead}`, act).border(1).border_color(t.border).text_color(t.muted)
          .hover((s) => s.bg(t.hover).text_color(t.foreground)).tooltip(tip)]);
  }

  // One count above the runs. Pressed, only the agents in that state show; pressed again, all do.
  tile(t, f, members) {
    const n = members.filter(f.has).length;
    const on = this.filter === f.id;
    const color = !n ? t.muted : f.id === "blocked" ? t.blocked : f.id === "done" ? t.done : t.foreground;
    return this.press(t, h_flex(), `filter-${f.id}`, () => { this.filter = on ? null : f.id; }, on ? t.input : t.border)
      .flex_1().min_w(0).h(28).px(8).gap(5).items_center().rounded(6).bg(on ? t.selected : t.background).hover((s) => s.bg(t.hover))
      .tooltip(on ? "Show every state again" : `Show only: ${f.label.toLowerCase()}`)
      .child(div().flex_none().text_size(12.5).font_semibold().text_color(color).child(String(n)))
      .child(div().min_w(0).truncate().text_size(11.5).text_color(on ? t.foreground : t.muted).child(f.label));
  }

  // The tab bar's button, at the right of Files and Changes, and before it how many agents wait for the person.
  bar(t) {
    const node = find(layout(), "orch");
    const open = Boolean(node) && !node.hidden;
    const waiting = terminals().filter((x) => x.state === "live" && needsYou(x));
    const stop = (_e, cx) => cx.stop_propagation();
    const toggle = () => run("layout.toggle", { id: "orch" });
    return h_flex().id("orch-bar").size_full().pr(10).gap(6).items_center().justify_end().bg(t.chrome).border_b(1).border_color(t.border)
      .track_focus(this.handle)
      .on_key_down((e, cx) => {
        if (e.key === "enter" || e.key === "space") toggle();
        else if (e.key === "escape" || e.key === "down") run("pane.go", { direction: "down" });
        else return;
        cx.stop_propagation();
        cx.notify();
      })
      .when(waiting.length > 0, (el) => el.child(div().id("bar-need-you").flex_none().px(7).h(20).flex().items_center().rounded(5)
        .bg(t.blocked + "26").text_size(11).font_semibold().text_color(t.blocked).cursor_pointer()
        .tooltip(waiting.length === 1 ? `Show ${waiting[0].name ?? waiting[0].address}` : "Show the next agent that waits for you")
        .on_mouse_down("left", stop)
        .on_click(() => this.nextWaiting())
        .child(`${waiting.length} need${waiting.length === 1 ? "s" : ""} you`)))
      .child(h_flex().id("orch-toggle").h(26).px(8).gap(5).flex_none().items_center().rounded(6).text_size(12)
        .bg(open ? t.selected : t.chrome).text_color(open ? t.foreground : t.muted)
        .border(1).border_color(this.handle.is_focused() ? t.accent : open ? t.selected : t.chrome)
        .hover((s) => s.bg(t.hover)).on_mouse_down("left", stop).on_click(toggle)
        .tooltip(open ? "Hide the Orchestra panel" : "Show the Orchestra panel: runs, roles and start")
        .child(svg("mods/orchestra/orchestra.svg").size(14)).child("Orchestra"));
  }

  // The runs, one row per agent: each lead, then its helpers. With a filter, a lead stays above
  // the helpers that match.
  runParts(t, runs, spaceOf) {
    const filter = FILTERS.find((f) => f.id === this.filter);
    const shown = (x) => !filter || filter.has(x);
    const said = runs.map((r) => {
      const m = MODES.find((x) => x.lead === r.a.labels?.[ROLE_LABEL]);
      const name = this.agentName(r.a);
      const about = goalOf(r.kids.filter((k) => k.depth === 1).map((k) => k.t)) ?? this.where(r.a, spaceOf);
      return { name, about: name === m.tab ? about : `${m.label} · ${about}`, lead: m.lead };
    });
    // A name that is there twice also shows its terminal address, for leads and for helpers.
    const count = (list) => list.reduce((n, x) => n.set(x, (n.get(x) ?? 0) + 1), new Map());
    const leads = count(said.map((s) => s.name));
    const helperName = (h) => h.name ?? h.address;
    const helpers = count(runs.flatMap((r) => r.kids.map((k) => helperName(k.t))));
    const told = (name, twice, address) => (twice.get(name) > 1 && name !== address ? `${name} · ${address}` : name);
    const parts = [];
    this.home = "to-setup";
    runs.forEach((r, i) => {
      const kids = r.kids.filter((k) => shown(k.t));
      if (!shown(r.a) && !kids.length) return;
      const s = said[i];
      const first = !parts.length;
      if (first) this.home = `row-${r.a.address}`;
      parts.push(() => this.leadRow(t, r.a, told(s.name, leads, r.a.address), s.about, s.lead, first));
      for (const k of kids) parts.push(() => this.helperRow(t, k.t, k.depth, told(helperName(k.t), helpers, k.t.address)));
    });
    if (!parts.length) parts.push(() => div().py(14).text_size(12).text_color(t.muted)
      .child(runs.length ? "No agent in this state." : "No team is running. Start one in Team setup."));
    return parts;
  }

  // What is set up for the next run, and who leads: the roles, then the running agents.
  setupParts(t, mode, picks, tops, spaceOf) {
    const head = (s) => div().pt(4).text_size(11.5).font_medium().text_color(t.muted).child(s);
    this.home = `role-${mode.roles[0].id}`;
    const list = [...tops.filter(leadOf), ...tops.filter((a) => !leadOf(a))];
    const names = list.map((a) => this.agentName(a));
    // Two agents with the same name also show their terminal address.
    const nameOf = (a, i) => (names.filter((n) => n === names[i]).length > 1 ? `${names[i]} · ${a.address}` : names[i]);
    return [
      () => head("Roles"),
      ...mode.roles.map((r) => () => this.role(t, r, picks[r.id])),
      ...(list.length ? [() => head("Running agents")] : []),
      ...list.map((a, i) => () => this.agentRow(t, a, nameOf(a, i), mode, spaceOf)),
    ];
  }

  panel(t) {
    this.next = [];
    this.part = null;
    const picks = this.picks();
    const mode = this.mode();
    const live = terminals().filter((x) => x.state === "live");
    this.agentInfo = new Map(agents().map((x) => [x.address, x]));
    const spaceOf = new Map(spaces().map((s) => [s.id, s.name]));
    const rank = (x) => RANK[statusOf(x)] ?? 0;
    const tops = live.filter((x) => x.program?.agent && !x.parent);
    // Every live helper below `address`, a helper's own helpers right after it (as the agents list
    // has them). What waits for the person comes first: among helpers of the same parent, the one
    // whose branch is most urgent.
    const below = (address, depth) => live.filter((x) => x.parent === address)
      .map((x) => {
        const under = below(x.address, depth + 1);
        return { t: x, depth, under, rank: Math.max(rank(x), ...under.map((k) => k.rank)) };
      })
      .sort((x, y) => y.rank - x.rank)
      .flatMap(({ under, ...k }) => [k, ...under]);
    // A lead of either mode is a run, whichever mode is chosen in the setup; the most urgent run is first.
    const runs = tops.filter(leadOf)
      .map((a) => ({ a, kids: below(a.address, 1) }))
      .map((r) => ({ ...r, rank: Math.max(rank(r.a), ...r.kids.map((k) => k.rank)) }))
      .sort((x, y) => y.rank - x.rank);
    // Until the person chooses a view: the runs while a team runs, else the setup that starts one.
    this.view = this.chosen ?? (runs.length ? "runs" : "setup");
    const setup = this.view === "setup";
    const focused = this.handle.is_focused();

    const iconButton = (id, icon, tip, act) => this.press(t, div(), id, act)
      .size(24).flex_none().flex().items_center().justify_center().rounded(6).text_color(t.muted)
      .hover((s) => s.bg(t.hover).text_color(t.foreground)).tooltip(tip).child(svg(`mods/workspace-chrome/${icon}.svg`).size(13));
    const textButton = (id, text, tip, act) => this.press(t, div(), id, act, t.border)
      .flex_none().px(8).h(24).flex().items_center().rounded(6).text_size(11.5).text_color(t.muted)
      .hover((s) => s.bg(t.hover).text_color(t.foreground)).tooltip(tip).child(text);
    // The card's header, as Files and Changes have it. The setup is one step in, with a way back.
    const header = h_flex().h(42).flex_none().px(14).gap(8).items_center().border_b(1).border_color(t.border).children([
      setup ? iconButton("to-runs", "chevron-left", "Back to the runs (Left)", () => this.show("runs"))
        : svg("mods/orchestra/orchestra.svg").size(14).flex_none().text_color(t.muted),
      div().flex_1().min_w(0).truncate().font_semibold().child(setup ? "Team setup" : "Orchestra"),
      setup ? textButton("reload", this.loading ? "Reading..." : "Reload models", "Read the model lists again (R)", (cx) => this.loadCatalog(cx))
        : textButton("to-setup", "Team setup", "Start a team, choose who does what, give or take the lead (Right)", () => this.show("setup")),
      iconButton("close", "x", "Hide this panel", () => this.close()),
    ]);
    const status = this.status ? div().flex_none().px(14).pt(8).text_size(11.5).text_color(t.blocked).child(this.status) : null;

    let pinned = null;
    if (setup) {
      const lead = picks[mode.lead];
      const gone = this.absent?.has(lead.agent);
      // Pinned: the main action never scrolls away, with the mode it starts.
      pinned = v_flex().flex_none().px(12).pt(12).pb(10).gap(8).border_b(1).border_color(t.border)
        .child(h_flex().p(2).gap(2).rounded(7).bg(t.surface).border(1).border_color(t.border)
          .children(MODES.map((m, i) => this.press(t, div(), `mode-${m.id}`, () => this.setMode(m.id), m.id === mode.id ? t.selected : t.surface)
            .flex_1().py(3).rounded(5).flex().justify_center().text_size(12)
            .bg(m.id === mode.id ? t.selected : t.surface).text_color(m.id === mode.id ? t.foreground : t.muted)
            .hover((s) => s.text_color(t.foreground))
            .tooltip(`${m.id === "council" ? "Three agents work on the same goal; an aggregator combines the best answers" : "An orchestrator splits the goal between workers, and one reviewer checks it"} (${i + 1})`)
            .child(m.label))))
        .child(this.press(t, div(), "start", () => this.start(), t.solid)
          .w_full().py(6).rounded(6).flex().justify_center().text_size(12.5).font_medium()
          .bg(t.solid).text_color(t.solid_foreground).hover((s) => s.opacity(0.9)).child(mode.start))
        // What the button does, readable without hovering.
        .child(div().truncate().text_size(11).text_color(gone ? t.blocked : t.muted)
          .child(gone ? `${AGENTS.find((a) => a.id === lead.agent)?.label} was not found on this machine` : `Opens a new tab with ${this.summary(lead)}`));
    } else if (runs.length) {
      const members = runs.flatMap((r) => [r.a, ...r.kids.map((k) => k.t)]);
      pinned = h_flex().flex_none().px(12).pt(10).gap(4).children(FILTERS.map((f) => this.tile(t, f, members)));
    }

    const parts = setup ? this.setupParts(t, mode, picks, tops, spaceOf) : this.runParts(t, runs, spaceOf);
    this.armedShown = false;
    // Every part is one child of the list, so the keyboard can bring the chosen one into view.
    const body = v_flex().id(`orchestra-${this.view}`).flex_1().min_h(0).px(12).py(10).gap(setup ? 6 : 2).overflow_y_scrollbar().track_scroll(this.scroll)
      .children(parts.map((draw, i) => { this.part = i; return draw(); }));
    this.part = null;
    // A question whose agent, role or mode changed is no longer on the page: it stops waiting.
    if (this.armed && !this.armedShown) this.armed = null;

    const keys = this.armed ? ["Enter  confirm", "Esc  cancel"]
      : setup ? ["Up/Down", "Enter  choose", "1/2  mode", "R  reload"]
        : ["Up/Down", "Enter  show", "N  next waiting", "Right  setup"];
    const hints = focused ? h_flex().flex_none().px(14).h(26).gap(10).items_center().overflow_hidden().border_t(1).border_color(t.border)
      .text_size(11).text_color(t.muted).children(keys) : null;

    return v_flex().id("orchestra").size_full().min_h(0).rounded(10).overflow_hidden().bg(t.background)
      .border_1().border_color(focused ? t.accent : t.border).text_color(t.foreground).text_size(13)
      .track_focus(this.handle)
      .on_key_down((e, cx) => this.key(e, cx))
      .children([header, status, pinned, body, hints].filter(Boolean));
  }

  render() {
    const t = theme();
    if (this.button) return this.bar(t);
    let el = this.panel(t);
    // The chosen control is gone (its terminal ended, the view changed): choose the one now in its
    // place, else the view's first row, and draw again so the outline is on it.
    if (!this.next.some((x) => x.id === this.cursor)) {
      const at = this.drawn === this.view ? this.items.findIndex((x) => x.id === this.cursor) : -1;
      const to = at >= 0 ? this.next[Math.min(at, this.next.length - 1)] : this.next.find((x) => x.id === this.home) ?? this.next[0];
      this.cursor = to?.id ?? null;
      el = this.panel(t);
    }
    this.items = this.next;
    this.drawn = this.view;
    return el;
  }
}
