import descriptor from "./settings-descriptor.json";

type ObjectValue = Record<string, unknown>;
/** One setting of the config schema, as written by scripts/settings-descriptor.mjs. */
interface Desc {
  k: "object" | "array" | "record" | "enum" | "literal" | "boolean" | "number" | "union" | "string";
  opt?: boolean;
  def?: unknown;
  shape?: Record<string, Desc>;
  el?: Desc;
  val?: Desc;
  options?: Array<string | Desc>;
  value?: unknown;
}
const GROUPS = [
  ["General", ["projectId", "locale", "enabled", "askType", "auth", "storage", "rateLimit", "capture", "privacyUrl", "issueLink", "createAnyway", "turnstile"]],
  ["AI & follow-ups", ["llm"]],
  ["Types & delivery", ["templates", "delivery", "tracker"]],
  ["Appearance", ["appearance"]],
] as const;
const LABELS: Record<string, string> = {
  projectId: "Project ID", locale: "Issue language", enabled: "Accept feedback", askType: "Let visitors choose the type",
  auth: "Website access", origins: "Allowed website origins", storage: "Attachments & retention", kind: "Kind", publicBaseUrl: "Public attachment URL", retentionDays: "Delete after (days)",
  rateLimit: "Rate limit", perHour: "Reports per visitor per hour", capture: "Automatic capture", screenshot: "Page screenshot", console: "Console messages", privacyUrl: "Privacy policy URL", issueLink: "Show ticket link to visitors",
  createAnyway: "Keep feedback when details are missing", onIncomplete: "Allow incomplete reports", onLlmError: "Accept feedback if AI fails", turnstile: "Turnstile bot protection", siteKey: "Public site key", secret: "Secret environment variable name",
  llm: "AI configuration", provider: "Provider", model: "Model ID", baseUrl: "API base URL", dailyBudget: "Maximum AI calls per day", structuredOutput: "Request structured JSON output",
  templates: "Feedback types", type: "Type ID", label: "Label", guidance: "Guidance for visitors", fields: "Fields", key: "Field ID", required: "Required", askIfMissing: "Ask when missing", extractionHint: "AI extraction hint", options: "Choices", value: "Value", body: "Issue body sections", heading: "Heading", template: "Body template",
  tracker: "GitHub destination", repo: "Repository override", labels: "GitHub labels", noIssue: "Store in inbox only (legacy)", delivery: "Delivery", defaultRepo: "Default repository", patSecret: "Token environment variable name", project: "GitHub Project", org: "Organization", number: "Project number", typeOptions: "Feedback type options", status: "Initial status", page: "Page field", source: "Source field", boardItemType: "Board item type", issueFields: "Organization issue fields", fieldId: "GitHub field ID",
  appearance: "Widget appearance", theme: "Color scheme", accent: "Accent color", archived: "Archived (hidden from visitors)",
};
const HELP: Record<string, string> = {
  projectId: "Existing project IDs stay fixed so snippets and stored feedback keep working.",
  origins: "Include scheme and hostname, for example https://example.org. No page paths.",
  model: "Use the exact model ID offered by your provider. The gateway uses its configured LLM_API_KEY.",
  dailyBudget: "Number of AI calls, not a money budget. Resets at 00:00 UTC.",
  retentionDays: "Applies to reports and attachments, including unhandled reports. Remove this setting to keep them until deleted.",
  patSecret: "Reference an environment variable on the gateway. Never enter the token value here.",
  secret: "Reference a TURNSTILE_SECRET_* environment variable on the gateway.",
  key: "Existing field IDs stay fixed. Edit the label to rename what visitors see.",
  theme: "Auto follows the host website, then the visitor's system preference.",
  accent: "A six-digit hex color. Check contrast against white button text.",
};
const node = <K extends keyof HTMLElementTagNameMap>(tag: K, text?: string) => {
  const e = document.createElement(tag); if (text !== undefined) e.textContent = text; return e;
};
/**
 * The value a setting starts with when it is added. Numbers, choices and yes/no
 * settings without a default start empty: a guessed value such as 1 day of
 * retention would silently delete reports. Empty required settings stay empty
 * until the operator fills them, and validation says so.
 */
function initial(d: Desc): unknown {
  if (d.def !== undefined) return structuredClone(d.def);
  switch (d.k) {
    case "object": return Object.fromEntries(Object.entries(d.shape!).filter(([, v]) => !v.opt).map(([k, v]) => [k, initial(v)]).filter(([, v]) => v !== undefined));
    case "array": return [];
    case "record": return {};
    case "literal": return d.value;
    case "union": return initial(d.options![0] as Desc);
    case "enum": case "number": case "boolean": return undefined;
    default: return "";
  }
}
/** Which branch of a union a stored value belongs to. */
function matches(d: Desc, v: unknown): boolean {
  switch (d.k) {
    case "string": return typeof v === "string";
    case "number": return typeof v === "number";
    case "boolean": return typeof v === "boolean";
    case "enum": return (d.options as string[]).includes(v as string);
    case "literal": return v === d.value;
    case "array": return Array.isArray(v);
    case "object": case "record": return !!v && typeof v === "object" && !Array.isArray(v);
    case "union": return (d.options as Desc[]).some((o) => matches(o, v));
  }
}

/** Forms and advanced JSON share one draft; validation/publication stay in main.ts. */
export function settingsEditor(root: HTMLElement, changed: (draft: ObjectValue) => void) {
  let draft: ObjectValue = {};
  let saved: ObjectValue = {};
  let selected = 0;
  let nextId = 0;
  // Settings that were added without a start value (a number, a choice) and wait to be filled.
  const pending = new Set<string>();
  const slot = (path: string[], k: string) => [...path, k].join("\u0000");
  const schema = descriptor as Desc;
  const nav = node("nav"); nav.className = "settings-nav"; nav.setAttribute("aria-label", "Settings sections");
  const content = node("div"); content.className = "settings-content";
  root.append(nav,content);
  const notify = () => changed(structuredClone(draft));
  function field(t: Desc, value: unknown, key: string, path: string[], assign: (v: unknown) => void): HTMLElement {
    const box = node("div"); box.className = "settings-field";
    const title = LABELS[key] ?? key;
    const id = `setting-${++nextId}`;
    if (t.k === "union") {
      const options = t.options as Desc[];
      return field(options.find((o) => matches(o, value)) ?? options[0]!,value,key,path,assign);
    }
    if (t.k === "object" || t.k === "record") {
      const details = node("details"); details.open = path.length < 2;
      details.append(node("summary",title));
      const object = (value && typeof value === "object" ? value : {}) as ObjectValue;
      const shape = t.k === "object" ? t.shape! : Object.fromEntries(Object.keys(object).map((k)=>[k,t.val!]));
      const shown = [...Object.keys(object).filter((k)=>shape[k]),...Object.keys(shape).filter((k)=>!(k in object)&&pending.has(slot(path,k)))];
      for (const k of shown) details.append(field(shape[k]!,object[k],k,[...path,k],(next)=>{if(next===undefined){delete object[k];pending.delete(slot(path,k))}else object[k]=next;assign(object)}));
      const missing = Object.keys(shape).filter((k)=>!(k in object)&&!pending.has(slot(path,k)));
      if (missing.length) {
        const select = node("select"); select.setAttribute("aria-label",`Add ${title} setting`);
        select.append(new Option("Add a setting…",""),...missing.map((k)=>new Option(LABELS[k]??k,k)));
        select.onchange=()=>{if(!select.value)return;const start=initial(shape[select.value]!);if(start===undefined)pending.add(slot(path,select.value));else object[select.value]=start;assign(object);render()};details.append(select);
      }
      if(t.k === "record"){
        const add=node("button","Add entry");add.type="button";add.className="b ghost sm";add.onclick=()=>{
          const k=window.prompt("Entry name (for example a language code)")?.trim();if(!k||["__proto__","constructor","prototype"].includes(k)||Object.hasOwn(object,k))return;
          object[k]=initial(t.val!);assign(object);render();
        };details.append(add);
      }
      box.append(details);
    } else if (t.k === "array") {
      box.append(node("h3",title));
      const values = Array.isArray(value) ? value : [];
      values.forEach((v,i)=>{
        const item=node("div");item.className="settings-item";
        item.append(field(t.el!,v,`${title} ${i+1}`,[...path,String(i)],(next)=>{values[i]=next;assign(values)}));
        for(const [label,delta] of [["Move up",-1],["Move down",1]] as const){const b=node("button",label);b.type="button";b.className="b ghost sm";b.disabled=i+delta<0||i+delta>=values.length;b.onclick=()=>{[values[i],values[i+delta]]=[values[i+delta],values[i]];assign(values);render()};item.append(b)}
        // A published type is archived, never deleted: reports carry its ID.
        const published=path.length===1&&path[0]==="templates"&&publishedType(v);
        const archived=published&&(v as ObjectValue)["archived"]===true;
        const remove=node("button",published?(archived?"Unarchive":"Archive"):"Remove");remove.type="button";remove.className="b ghost sm";
        remove.onclick=()=>{
          if(published){if(!archived&&!window.confirm("Archive this type? Visitors no longer see it and the AI no longer picks it. Existing reports keep it."))return;if(archived)delete (v as ObjectValue)["archived"];else (v as ObjectValue)["archived"]=true;assign(values);render();return}
          if(!window.confirm(`Remove this ${title} entry from the draft?`))return;values.splice(i,1);assign(values);render()};
        item.append(remove);box.append(item);
      });
      const add=node("button",`Add ${title === "Feedback types" ? "feedback type" : "entry"}`);add.type="button";add.className="b ghost sm";add.onclick=()=>{values.push(initial(t.el!));assign(values);render()};box.append(add);
    } else {
      const label=node("label",title);label.htmlFor=id;box.append(label);
      let input: HTMLInputElement|HTMLTextAreaElement|HTMLSelectElement;
      // A setting that is not set yet shows an empty choice instead of pretending to hold the first value.
      const blank=value===undefined||value==="";
      if(t.k === "enum"){const select=node("select");if(blank)select.append(new Option("Choose…",""));select.append(...(t.options as string[]).map((o)=>new Option(o,o)));select.value=blank?"":String(value);input=select;select.onchange=()=>assign(select.value===""?undefined:select.value)}
      else if(t.k === "boolean"){const select=node("select");if(value===undefined)select.append(new Option("Choose…",""));select.append(new Option("Yes","true"),new Option("No","false"));select.value=value===undefined?"":String(value);select.onchange=()=>assign(select.value===""?undefined:select.value==="true");input=select}
      // Emptying an optional setting removes it. The field stays on screen until the next render, so typing again works.
      else {const text=["guidance","extractionHint","template"].includes(key)?node("textarea"):node("input");text.value=String(value??"");if(text instanceof HTMLInputElement)text.type=t.k === "number"?"number":"text";input=text;text.oninput=()=>assign(text.value===""&&(t.opt||t.k === "number")?undefined:t.k === "number"?Number(text.value):text.value)}
      input.id=id;
      if(key==="projectId" || ((key==="key"||key==="type") && existingId(path,value))){if(input instanceof HTMLInputElement)input.readOnly=true}
      box.append(input);
      if(HELP[key])box.append(node("p",HELP[key]));
    }
    if(t.opt && !["projectId","key","type"].includes(key)){
      const unset=node("button","Use default / remove setting");unset.type="button";unset.className="settings-unset";unset.onclick=()=>{assign(undefined);render()};box.append(unset);
    }
    return box;
  }
  function publishedType(item:unknown):boolean{
    const type=(item as ObjectValue|null)?.["type"];
    return Array.isArray(saved["templates"])&&(saved["templates"] as ObjectValue[]).some((t)=>t["type"]===type);
  }
  function existingId(path:string[],value:unknown):boolean{
    if(!path.includes("templates"))return false;
    const templates=Array.isArray(saved["templates"])?saved["templates"] as ObjectValue[]:[];
    return templates.some((t)=>path.at(-1)==="type"?t["type"]===value:(Array.isArray(t["fields"])?t["fields"] as ObjectValue[]:[]).some((f)=>f["key"]===value));
  }
  function render(){
    nav.replaceChildren();content.replaceChildren();
    GROUPS.forEach(([label],i)=>{const b=node("button",label);b.type="button";b.className=`b ghost sm${i===selected?" active":""}`;b.setAttribute("aria-pressed",String(i===selected));b.onclick=()=>{selected=i;render()};nav.append(b)});
    const [label,keys]=GROUPS[selected]!;content.append(node("h3",label));
    for(const key of keys){const s=schema.shape![key]!;
      if(draft[key]===undefined&&!pending.has(slot([],key))){const add=node("button",`Configure ${LABELS[key]??key}`);add.type="button";add.className="b ghost sm";add.onclick=()=>{const start=initial(s);if(start===undefined)pending.add(slot([],key));else draft[key]=start;notify();render()};content.append(add);continue}
      content.append(field(s,draft[key],key,[key],(value)=>{if(value===undefined){delete draft[key];pending.delete(slot([],key))}else draft[key]=value;notify()}));
    }
  }
  return {load(value:ObjectValue,markSaved=true){draft=structuredClone(value);pending.clear();if(markSaved)saved=structuredClone(value);render()}};
}
