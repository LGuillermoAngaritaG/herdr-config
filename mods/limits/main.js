// Usage limits of Claude Code, Codex and Antigravity.
// Sidebar: one line per tool with the limit that decides for it. A click opens every limit.
// As an overlay (that click, or mod.open:limits on a key) it shows every limit of every tool.
// The numbers are shared as "limits.tools", so they show at once on start and other mods can read them.

import { View, div, image } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { exec, appHome, theme, run, layout, checking, nextCommand, shared, setShared, props, openOverlay, closeOverlay } from "herdr";

const ICON = { claude: "icons/claude.svg", codex: "icons/codex.svg", antigravity: "icons/antigravity.svg" };

function find(node, id) {
  if (node?.id === id) return node;
  for (const child of node?.children ?? []) {
    const found = find(child, id);
    if (found) return found;
  }
  return null;
}

// The sidebar's rail goes by its width, as in the spaces and agents lists.
const narrow = () => (find(layout(), "sidebar")?.size?.px ?? Infinity) < 160;

const now = () => Date.now() / 1000;

// usage.py waits up to 40 s for Claude Code, then 8 s for each open Antigravity window, and falls
// back to the last numbers it saved. The read gets longer than that (90 s), so one slow tool does
// not cost the numbers of the others.
const READ_MS = 90000;
// One read at a time, for the sidebar and the popup together: "limits.reading" is when a read
// started. A read that never ended (its copy closed) stops counting 5 s after a read's time is up.
const reading = () => Boolean(shared("limits.reading")) && now() - shared("limits.reading") < READ_MS / 1000 + 5;

function dur(sec) {
  const m = Math.max(Math.floor(sec / 60), 0);
  if (m < 1) return "<1m";
  if (m < 60) return `${m}m`;
  if (m < 1440) return `${Math.floor(m / 60)}h ${m % 60}m`;
  return `${Math.floor(m / 1440)}d ${Math.floor((m % 1440) / 60)}h`;
}

// Numbers older than a day may be wrong: they get a badge that says how old ("3d old").
const stale = (tool) => Boolean(tool.as_of) && now() - tool.as_of > 86400;
const age = (tool) => `${dur(now() - tool.as_of).split(" ")[0]} old`;

// A window whose reset time has passed is back to zero, whatever the old snapshot says.
const used = (w) => (w.resets_at && w.resets_at < now() ? 0 : w.used);

// How long a window lasts, from its label ("5h", "Opus week", "Gemini weekly"); null when unknown.
function span(label) {
  const m = /(\d+)([hd])$/.exec(label);
  if (m) return m[1] * (m[2] === "h" ? 3600 : 86400);
  return /week(ly)?$/.test(label) ? 604800 : null;
}

// Where even use would be now, in percent; null when the window's length or reset is unknown.
function pace(w) {
  const len = span(w.label);
  const left = w.resets_at - now();
  return len && w.resets_at && left > 0 && left <= len ? (1 - left / len) * 100 : null;
}

// Seconds until it runs out at the rate so far, when use is well ahead of the mark
// (10 points; under half used is too early to tell). Null otherwise.
function runsOut(w) {
  const p = pace(w);
  const u = used(w);
  if (p === null || u < 50 || u >= 100 || u <= p + 10) return null;
  return ((100 - u) * (span(w.label) * p / 100)) / u;
}

// ok, warn (75% used, or running out before the reset), high (90%), out (100%).
function level(w) {
  const u = used(w);
  if (u >= 100) return "out";
  if (u >= 90) return "high";
  return u >= 75 || runsOut(w) !== null ? "warn" : "ok";
}

// The limit that decides for a tool: the fullest general one, or a per-model one that is nearly used up.
function binding(tool) {
  const ws = tool.windows ?? [];
  const max = (list) => list.reduce((m, w) => (!m || used(w) > used(m) ? w : m), null);
  const hot = max(ws);
  return hot && used(hot) >= 90 ? hot : max(ws.filter((w) => !w.extra));
}

function about(tool, w) {
  if (!w) return tool.note ?? "No data";
  const out = runsOut(w);
  return `${tool.name}, ${w.label} limit: ${Math.round(used(w))}% used`
    + (w.resets_at && used(w) > 0 ? `, resets in ${dur(w.resets_at - now())}.` : ".")
    + (out !== null ? ` At this rate it runs out in about ${dur(out)}, before the reset.` : "")
    + (stale(tool) ? ` These numbers are ${age(tool)}.` : "");
}

export default class Limits extends View {
  init(_props, cx) {
    if (checking() || props()?.overlay) return;
    this.refresh(cx);
    cx.timer.every(120000, (cx) => this.refresh(cx));
    // limits.orchestra shows or hides the Orchestra panel, .refresh reads the limits again,
    // .expand opens every limit and .collapse closes that.
    cx.spawn(async (cx) => {
      for (;;) {
        const c = await nextCommand();
        if (c === "orchestra") run("layout.toggle", { id: "orch" });
        if (c === "refresh") this.refresh(cx);
        if (c === "expand") this.open();
        if (c === "collapse" && this.popup) closeOverlay(this.popup);
        cx.notify();
      }
    });
  }

  refresh(cx) {
    if (reading()) return;
    setShared("limits.reading", now());
    cx.spawn(async (cx) => {
      try {
        const r = await exec("python3", ["-I", `${appHome()}/mods/limits/usage.py`], { timeout: READ_MS });
        setShared("limits.tools", JSON.parse(r.stdout).tools);
        this.error = null;
      } catch (e) {
        this.error = String(e);
      }
      setShared("limits.reading", null);
      cx.notify();
    });
  }

  // Grey while fine: a color means something needs a look.
  color(t, w) {
    return { ok: t.muted, warn: t.working, high: t.blocked, out: t.blocked }[level(w)];
  }

  // The bar, with a mark where even use would be now.
  bar(t, w) {
    const p = pace(w);
    return h_flex().relative().h(7).w_full().items_center()
      .child(div().h(3).w_full().rounded(2).bg(t.border).child(div().h(3).rounded(2).bg(this.color(t, w)).w(`${Math.min(used(w), 100)}%`)))
      .when(p !== null, (el) => el.child(div().absolute().top(0).left(`${p}%`).w(1.5).h(7).bg(t.foreground)));
  }

  value(t, w) {
    const lv = level(w);
    return div().flex_none().text_size(11.5).text_color(lv === "ok" ? t.foreground : this.color(t, w))
      .when(lv !== "ok", (el) => el.font_semibold()).child(`${Math.round(used(w))}%`);
  }

  badge(t, tool) {
    return div().flex_none().px(4).h(16).flex().items_center().rounded(4).bg(t.working + "26").text_size(10.5).font_semibold().text_color(t.working).child(age(tool));
  }

  open() {
    if (this.popup) closeOverlay(this.popup);
    this.popup = openOverlay({ mod: "limits", kind: "popup", width: 320 });
  }

  // Sidebar: icon, name, which limit, how full, when it resets; the bar under it.
  row(t, tool) {
    const w = binding(tool);
    const old = stale(tool);
    return v_flex().id(`tool-${tool.id}`).px(8).py(3).gap(2).rounded(6).cursor_pointer().hover((s) => s.bg(t.hover))
      .tooltip(`${about(tool, w)} Click for every limit.`)
      .on_click(() => this.open())
      .child(h_flex().gap(6).items_center().text_size(12)
        .child(image(ICON[tool.id]).size(13).flex_none())
        .child(div().flex_none().text_color(t.foreground).child(tool.name))
        .child(div().flex_1().min_w(0).truncate().text_size(11).text_color(t.muted).child(!w ? tool.note ?? "No data" : w.label))
        .when(Boolean(w), (el) => el.child(this.value(t, w)))
        // The badge takes the place of the time to the reset, which old numbers can't tell.
        .when(old, (el) => el.child(this.badge(t, tool)))
        .when(Boolean(w) && !old, (el) => el.child(div().w(46).flex_none().text_right().text_size(11).text_color(t.muted)
          .child(w.resets_at && used(w) > 0 ? dur(w.resets_at - now()) : ""))))
      .when(Boolean(w), (el) => el.child(this.bar(t, w)));
  }

  // The rail: icon and percent only.
  railRow(t, tool) {
    const w = binding(tool);
    return v_flex().id(`tool-${tool.id}`).w(40).py(3).gap(1).items_center().rounded(6).cursor_pointer().hover((s) => s.bg(t.hover))
      .tooltip(about(tool, w)).on_click(() => this.open())
      .child(image(ICON[tool.id]).size(14))
      .child(w ? this.value(t, w).text_size(11) : div().text_size(11).text_color(t.muted).child("?"));
  }

  // The popup: every limit of every tool, how old the numbers are, and what the mark means.
  detail(t, tools) {
    // While a read runs, the button is only a label.
    const busy = reading();
    const label = div().id("refresh").px(7).py(3).rounded(5).text_size(11.5).text_color(busy ? t.dim : t.muted).child(busy ? "Reading..." : "Refresh");
    const button = busy ? label : label.cursor_pointer().hover((s) => s.bg(t.hover).text_color(t.foreground)).on_click((_e, cx) => this.refresh(cx));
    return v_flex().w_full().p(14).gap(12).bg(t.popover).text_size(12)
      .child(h_flex().justify_between().items_center()
        .child(div().text_size(13.5).font_semibold().text_color(t.foreground).child("Limits"))
        .child(button))
      .when(Boolean(this.error), (el) => el.child(div().text_size(11.5).text_color(t.blocked).child(this.error)))
      // The list scrolls past 400 px, so the popup stays inside a small window.
      .child(v_flex().id("limits-detail").max_h(400).pr(6).gap(12).overflow_y_scrollbar().children(tools.map((tool) => v_flex().flex_none().gap(6)
        .child(h_flex().gap(6).items_center()
          .child(image(ICON[tool.id]).size(14).flex_none())
          .child(div().flex_1().font_medium().text_color(t.foreground).child(tool.name))
          .when(stale(tool), (el) => el.child(this.badge(t, tool)))
          .when(Boolean(tool.as_of) && !stale(tool), (el) => el.child(div().text_size(11).text_color(t.muted).child(now() - tool.as_of < 60 ? "read just now" : `read ${dur(now() - tool.as_of)} ago`))))
        .when(Boolean(tool.note), (el) => el.child(div().text_size(11.5).text_color(t.muted).child(tool.note)))
        .children((tool.windows ?? []).map((w) => {
          const out = runsOut(w);
          return v_flex().gap(2)
            .child(h_flex().gap(6).items_center().text_size(11.5)
              .child(div().flex_1().truncate().text_color(t.muted).child(w.label))
              .child(this.value(t, w))
              .child(div().w(96).flex_none().text_right().text_color(t.muted)
                .child(w.resets_at && used(w) > 0 ? `resets in ${dur(w.resets_at - now())}` : "")))
            .child(this.bar(t, w))
            .when(out !== null, (el) => el.child(div().text_size(11).text_color(t.working)
              .child(`At this rate it runs out in about ${dur(out)}, before the reset.`)));
        })))))
      .child(div().text_size(11).text_color(t.muted).child("The mark on a bar is where even use would be now. Past the mark means you are using it faster than the limit refills."));
  }

  render() {
    const t = theme();
    const tools = shared("limits.tools") ?? [];
    if (props()?.overlay) return this.detail(t, tools);
    const empty = div().px(8).text_size(11.5).text_color(this.error ? t.blocked : t.muted).child(this.error ?? "Reading the limits...");
    if (narrow()) {
      return v_flex().size_full().min_h(0).py(6).gap(2).items_center().bg(t.chrome).border_t(1).border_color(t.border)
        .children(tools.map((tool) => this.railRow(t, tool)));
    }
    return v_flex().size_full().min_h(0).bg(t.chrome).border_t(1).border_color(t.border)
      .child(h_flex().px(16).pt(8).pb(2).items_center().justify_between()
        .child(div().text_size(11.5).font_medium().text_color(t.dim).child("Limits"))
        .when(Boolean(this.error) && tools.length > 0, (el) => el.child(div().text_size(11).text_color(t.blocked).tooltip(this.error).child("Not updated"))))
      .child(v_flex().id("limits-list").flex_1().min_h(0).px(8).pb(4).overflow_y_scrollbar()
        .when(tools.length === 0, (el) => el.child(empty))
        .children(tools.map((tool) => this.row(t, tool))));
  }
}
