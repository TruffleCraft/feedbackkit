import { z } from "zod";
import { FeedbackConfig } from "../shared/contract.js";

type ObjectValue = Record<string, unknown>;
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
  appearance: "Widget appearance", theme: "Color scheme", accent: "Accent color",
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
function unwrap(s: z.ZodTypeAny): z.ZodTypeAny {
  if (s instanceof z.ZodEffects) return unwrap(s.innerType());
  if (s instanceof z.ZodDefault) return unwrap(s.removeDefault());
  if (s instanceof z.ZodOptional || s instanceof z.ZodNullable) return unwrap(s.unwrap());
  return s;
}
function initial(s: z.ZodTypeAny): unknown {
  if (s instanceof z.ZodDefault) return s.parse(undefined);
  const t = unwrap(s);
  if (t instanceof z.ZodObject) return Object.fromEntries(Object.entries(t.shape as Record<string,z.ZodTypeAny>).filter(([,v]) => !v.isOptional()).map(([k,v]) => [k,initial(v)]));
  if (t instanceof z.ZodArray) return [];
  if (t instanceof z.ZodRecord) return {};
  if (t instanceof z.ZodEnum) return t.options[0];
  if (t instanceof z.ZodLiteral) return t.value;
  if (t instanceof z.ZodBoolean) return false;
  if (t instanceof z.ZodNumber) return 1;
  if (t instanceof z.ZodUnion) return initial(t.options[0]);
  return "";
}

/** Forms and advanced JSON share one draft; validation/publication stay in main.ts. */
export function settingsEditor(root: HTMLElement, changed: (draft: ObjectValue) => void) {
  let draft: ObjectValue = {};
  let saved: ObjectValue = {};
  let selected = 0;
  let nextId = 0;
  const schema = unwrap(FeedbackConfig) as z.AnyZodObject;
  const nav = node("nav"); nav.className = "settings-nav"; nav.setAttribute("aria-label", "Settings sections");
  const content = node("div"); content.className = "settings-content";
  root.append(nav,content);
  const notify = () => changed(structuredClone(draft));
  function field(s: z.ZodTypeAny, value: unknown, key: string, path: string[], assign: (v: unknown) => void): HTMLElement {
    const box = node("div"); box.className = "settings-field";
    const title = LABELS[key] ?? key;
    const id = `setting-${++nextId}`;
    const t = unwrap(s);
    if (t instanceof z.ZodUnion) {
      const options = t.options as z.ZodTypeAny[];
      return field(options.find((o) => o.safeParse(value).success) ?? options[0]!,value,key,path,assign);
    }
    if (t instanceof z.ZodObject || t instanceof z.ZodRecord) {
      const details = node("details"); details.open = path.length < 2;
      details.append(node("summary",title));
      const object = (value && typeof value === "object" ? value : {}) as ObjectValue;
      const shape = t instanceof z.ZodObject ? t.shape as Record<string,z.ZodTypeAny> : Object.fromEntries(Object.keys(object).map((k)=>[k,t.valueSchema]));
      for (const [k,v] of Object.entries(object)) if (shape[k]) details.append(field(shape[k]!,v,k,[...path,k],(next)=>{if(next===undefined)delete object[k];else object[k]=next;assign(object)}));
      const missing = Object.keys(shape).filter((k)=>!(k in object));
      if (missing.length) {
        const select = node("select"); select.setAttribute("aria-label",`Add ${title} setting`);
        select.append(new Option("Add a setting…",""),...missing.map((k)=>new Option(LABELS[k]??k,k)));
        select.onchange=()=>{if(!select.value)return;object[select.value]=initial(shape[select.value]!);assign(object);render()};details.append(select);
      }
      if(t instanceof z.ZodRecord){
        const add=node("button","Add entry");add.type="button";add.className="b ghost sm";add.onclick=()=>{
          const k=window.prompt("Entry name (for example a language code)")?.trim();if(!k||["__proto__","constructor","prototype"].includes(k)||Object.hasOwn(object,k))return;
          object[k]=initial(t.valueSchema);assign(object);render();
        };details.append(add);
      }
      box.append(details);
    } else if (t instanceof z.ZodArray) {
      box.append(node("h3",title));
      const values = Array.isArray(value) ? value : [];
      values.forEach((v,i)=>{
        const item=node("div");item.className="settings-item";
        item.append(field(t.element,v,`${title} ${i+1}`,[...path,String(i)],(next)=>{values[i]=next;assign(values)}));
        for(const [label,delta] of [["Move up",-1],["Move down",1]] as const){const b=node("button",label);b.type="button";b.className="b ghost sm";b.disabled=i+delta<0||i+delta>=values.length;b.onclick=()=>{[values[i],values[i+delta]]=[values[i+delta],values[i]];assign(values);render()};item.append(b)}
        const remove=node("button","Remove");remove.type="button";remove.className="b ghost sm";remove.onclick=()=>{if(!window.confirm(`Remove this ${title} entry from the draft?`))return;values.splice(i,1);assign(values);render()};item.append(remove);box.append(item);
      });
      const add=node("button",`Add ${title === "Feedback types" ? "feedback type" : "entry"}`);add.type="button";add.className="b ghost sm";add.onclick=()=>{values.push(initial(t.element));assign(values);render()};box.append(add);
    } else {
      const label=node("label",title);label.htmlFor=id;box.append(label);
      let input: HTMLInputElement|HTMLTextAreaElement|HTMLSelectElement;
      if(t instanceof z.ZodEnum){const select=node("select");select.append(...t.options.map((o:string)=>new Option(o,o)));select.value=String(value??"");input=select;select.onchange=()=>assign(select.value)}
      else if(t instanceof z.ZodBoolean){const select=node("select");select.append(new Option("Yes","true"),new Option("No","false"));select.value=String(value??false);select.onchange=()=>assign(select.value==="true");input=select}
      else {const text=["guidance","extractionHint","template"].includes(key)?node("textarea"):node("input");text.value=String(value??"");if(text instanceof HTMLInputElement)text.type=t instanceof z.ZodNumber?"number":"text";input=text;text.oninput=()=>assign(t instanceof z.ZodNumber?(text.value===""?null:Number(text.value)):text.value)}
      input.id=id;
      if(key==="projectId" || ((key==="key"||key==="type") && existingId(path,value))){if(input instanceof HTMLInputElement)input.readOnly=true}
      box.append(input);
      if(HELP[key])box.append(node("p",HELP[key]));
    }
    if(s.isOptional() && !["projectId","key","type"].includes(key)){
      const unset=node("button","Use default / remove setting");unset.type="button";unset.className="settings-unset";unset.onclick=()=>{assign(undefined);render()};box.append(unset);
    }
    return box;
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
    for(const key of keys){const s=schema.shape[key] as z.ZodTypeAny;
      if(draft[key]===undefined){const add=node("button",`Configure ${LABELS[key]??key}`);add.type="button";add.className="b ghost sm";add.onclick=()=>{draft[key]=initial(s);notify();render()};content.append(add);continue}
      content.append(field(s,draft[key],key,[key],(value)=>{if(value===undefined)delete draft[key];else draft[key]=value;notify()}));
    }
  }
  return {load(value:ObjectValue,markSaved=true){draft=structuredClone(value);if(markSaved)saved=structuredClone(value);render()}};
}
