// Usage limits of Claude Code, Codex and Antigravity, plus a button for the orchestra panel.

import { View, div } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { exec, appHome, theme, run, layout, checking, nextCommand } from "herdr";

function find(node, id) {
  if (node?.id === id) return node;
  for (const child of node?.children ?? []) {
    const found = find(child, id);
    if (found) return found;
  }
  return null;
}

function ago(s) {
  const m = Math.floor((Date.now() / 1000 - s) / 60);
  if (m < 60) return `${Math.max(m, 0)}m`;
  if (m < 1440) return `${Math.floor(m / 60)}h`;
  return `${Math.floor(m / 1440)}d`;
}

function until(s) {
  const m = Math.floor((s - Date.now() / 1000) / 60);
  if (m < 60) return `${m}m`;
  if (m < 1440) return `${Math.floor(m / 60)}h ${m % 60}m`;
  return `${Math.floor(m / 1440)}d ${Math.floor((m % 1440) / 60)}h`;
}

// A window whose reset time has passed is back to zero, whatever the old snapshot says.
const used = (w) => (w.resets_at && w.resets_at < Date.now() / 1000 ? 0 : w.used);

export function toggleOrchestra() {
  const panel = find(layout(), "panel");
  const stack = find(layout(), "panel-body");
  if (panel && !panel.hidden && stack?.active === "orchestra") return run("layout.hide", { id: "panel" });
  run("layout.select", { stack: "panel-body", child: "orchestra" });
  run("layout.show", { id: "panel" });
}

export default class Limits extends View {
  init(_props, cx) {
    this.tools = [];
    this.open = new Set();
    if (checking()) return;
    this.refresh(cx);
    cx.timer.every(120000, (cx) => this.refresh(cx));
    cx.spawn(async (cx) => {
      for (;;) {
        const c = await nextCommand();
        if (c === "orchestra") toggleOrchestra();
        if (c === "refresh") this.refresh(cx);
        if (c === "expand") { this.open = new Set(this.tools.map((x) => x.id)); cx.notify(); }
        if (c === "collapse") { this.open = new Set(); cx.notify(); }
      }
    });
  }

  refresh(cx) {
    cx.spawn(async (cx) => {
      try {
        const r = await exec("python3", ["-I", `${appHome()}/mods/limits/usage.py`], { timeout: 30000 });
        this.tools = JSON.parse(r.stdout).tools;
        this.error = null;
      } catch (e) {
        this.error = String(e);
      }
      cx.notify();
    });
  }

  bar(t, w) {
    const u = used(w);
    const color = u >= 90 ? t.blocked : u >= 70 ? t.working : t.accent;
    return v_flex().gap(2)
      .child(h_flex().justify_between().text_size(10.5).text_color(t.dim)
        .child(div().truncate().child(w.label))
        .child(div().child(`${Math.round(u)}%${w.resets_at && u > 0 ? ` · ${until(w.resets_at)}` : ""}`)))
      .child(div().h(4).w_full().rounded(2).bg(t.border).child(div().h(4).rounded(2).bg(color).w(`${Math.min(u, 100)}%`)));
  }

  tool(t, tool) {
    const ws = tool.windows ?? [];
    const top = ws.filter((w) => !w.extra).reduce((m, w) => (!m || used(w) > used(m) ? w : m), null);
    const open = this.open.has(tool.id);
    // Older than a day: say how old, the numbers may be wrong.
    const stale = tool.as_of && Date.now() / 1000 - tool.as_of > 86400;
    return v_flex().id(`tool-${tool.id}`).px(8).py(4).gap(3).rounded(6).cursor_pointer()
      .hover((s) => s.bg(t.hover))
      .tooltip(tool.note ?? (open ? "Show less" : "Show every limit"))
      .on_click((_e, cx) => { open ? this.open.delete(tool.id) : this.open.add(tool.id); cx.notify(); })
      .child(h_flex().justify_between().text_size(12).text_color(t.foreground)
        .child(tool.name)
        .when(Boolean(stale), (el) => el.child(div().text_size(10.5).text_color(t.blocked).child(`${ago(tool.as_of)} old`))))
      .when(!top, (el) => el.child(div().text_size(10.5).text_color(t.dim).child(tool.note ?? "No data")))
      .when(Boolean(top) && !open, (el) => el.child(this.bar(t, top)))
      .when(open, (el) => el.children(ws.map((w) => this.bar(t, w))));
  }

  render() {
    const t = theme();
    const button = (id, label, fn) => div().id(id).px(6).py(1).rounded(5).text_size(11).text_color(t.muted)
      .hover((s) => s.bg(t.hover).text_color(t.foreground)).on_click(fn).child(label);
    return v_flex().size_full().min_h(0).bg(t.chrome).border_t(1).border_color(t.border)
      .child(h_flex().px(16).pt(10).pb(4).items_center().justify_between()
        .child(div().text_size(11.5).font_medium().text_color(t.dim).child("Limits"))
        .child(h_flex().gap(2)
          .child(button("open-orchestra", "Orchestra", toggleOrchestra))))
      .child(v_flex().id("limits-list").flex_1().min_h(0).px(8).pb(6).gap(2).overflow_y_scrollbar()
        .when(Boolean(this.error), (el) => el.child(div().px(8).text_size(11).text_color(t.blocked).child(this.error)))
        .children(this.tools.map((tool) => this.tool(t, tool))));
  }
}
