// The sidebar shell shared by the admin module and the account module (variant B of
// docs/design/mockups/admin-plain.md): the phone menu, the theme switch, and the list
// of projects with the sections of the current one. Each bundle brings its own
// fetch, so this file knows nothing about tokens, cookies or CSRF.

const THEME_KEY = "fk-admin-theme";
const THEMES = ["auto", "light", "dark"] as const;
type Theme = (typeof THEMES)[number];

function stored(value?: string | null): string | null {
  try {
    if (value === undefined) return localStorage.getItem(THEME_KEY);
    if (value === null) localStorage.removeItem(THEME_KEY);
    else localStorage.setItem(THEME_KEY, value);
  } catch {
    /* storage unavailable: the choice holds for this load only */
  }
  return null;
}

function setTheme(theme: Theme) {
  const root = document.documentElement;
  if (theme === "auto") delete root.dataset["theme"];
  else root.dataset["theme"] = theme;
  const button = document.getElementById("theme");
  if (button) button.textContent = `Theme: ${theme[0]!.toUpperCase()}${theme.slice(1)}`;
}

/** Applies the saved theme, wires the theme button and the phone menu. Call once per page. */
export function initShell() {
  const saved = stored();
  setTheme(saved === "light" || saved === "dark" ? saved : "auto");
  document.getElementById("theme")?.addEventListener("click", () => {
    const now = (document.documentElement.dataset["theme"] as Theme | undefined) ?? "auto";
    const next = THEMES[(THEMES.indexOf(now) + 1) % THEMES.length]!;
    stored(next === "auto" ? null : next);
    setTheme(next);
  });
  const side = document.getElementById("side");
  const menu = document.getElementById("menu-btn");
  menu?.addEventListener("click", () => menu.setAttribute("aria-expanded", String(side!.classList.toggle("open"))));
}

/** Folds the phone menu away, for a link that only changes the address of the page you are on. */
export function closeMenu() {
  document.getElementById("side")?.classList.remove("open");
  document.getElementById("menu-btn")?.setAttribute("aria-expanded", "false");
}

export interface NavProject {
  id: string;
}

/**
 * Fills the project list of the sidebar. The current project gets its sections
 * (`sections` are [hash, label] pairs); `current` marks the page you are on.
 */
export function fillProjects(list: NavProject[], projectId: string | null, sections: ReadonlyArray<readonly [string, string]> = []) {
  const box = document.getElementById("side-projects");
  if (!box) return;
  box.replaceChildren(
    ...list.map((p) => {
      const here = p.id === projectId;
      const a = document.createElement("a");
      a.href = `/admin/projects/${encodeURIComponent(p.id)}`;
      a.textContent = p.id;
      if (here) a.setAttribute("aria-current", "page");
      const wrap = document.createElement("div");
      wrap.append(a);
      if (here && sections.length) {
        const sub = document.createElement("div");
        sub.className = "sub";
        sub.id = "side-sections";
        for (const [hash, label] of sections) {
          const s = document.createElement("a");
          s.href = `#${hash}`;
          s.dataset["section"] = hash;
          s.textContent = label;
          sub.append(s);
        }
        wrap.append(sub);
      }
      return wrap;
    }),
  );
}

/** Marks the sidebar link of the page you are on (`data-nav` names the page). */
export function markCurrent(view: string) {
  for (const a of document.querySelectorAll<HTMLElement>("#side [data-nav]")) {
    if (a.dataset["nav"] === view) a.setAttribute("aria-current", "page");
    else a.removeAttribute("aria-current");
  }
}
