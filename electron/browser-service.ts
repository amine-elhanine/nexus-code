import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { getAppSettings, saveAppSettings } from "./store.js";
import type { BrowserActInput, BrowserCallMeta } from "./browser-tool.js";

export type AgentBrowserActivity = { url: string; timestamp: string; autoFollow: boolean; sessionId?: string; scope: "home" | "code" };

// Requests the renderer part executes on the hidden agent webviews (see
// AgentBrowserHost): one webview per browser — persist:browser-home and
// persist:browser-code are fully separate sessions (cookies, storage, cache).
// The agent never touches a window of its own: everything it "sees" is the
// matching built-in Browser tab's session, which can mirror navigations live
// (Watching) or stay put while the agent works invisibly (Headless).
export type BrowserScope = "home" | "code";

export type AgentBrowserOp =
  | { kind: "load"; url: string }
  | { kind: "eval"; js: string }
  | { kind: "back" }
  | { kind: "reload" }
  | { kind: "press"; keyCode: string }
  | { kind: "shot" };

export type AgentBrowserReply =
  | { ok: true; url?: string; title?: string; value?: unknown; dataUrl?: string; width?: number; height?: number }
  | { ok: false; error: string };

export type AgentBrowserRequest = { id: string; scope: BrowserScope } & AgentBrowserOp;
export type AgentBrowserResponse = { id: string; reply: AgentBrowserReply };

type PendingEntry = { resolve: (reply: AgentBrowserReply) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> };

// Client side of the main→renderer browser bridge. Serializes concurrent
// callers (parallel sessions share the two hidden webviews) and times out
// when the renderer is gone instead of hanging tool calls forever.
class AgentBrowserService {
  private sender: ((msg: AgentBrowserRequest) => void) | null = null;
  private pending = new Map<string, PendingEntry>();
  private queue: Promise<unknown> = Promise.resolve();
  private seq = 0;
  private headless = true;
  private settingsLoaded = false;
  private lastUrl: string | null = null;
  onActivity: ((activity: AgentBrowserActivity) => void) | null = null;

  setSender(sender: ((msg: AgentBrowserRequest) => void) | null) {
    this.sender = sender;
  }

  handleReply(payload: { id: string; reply: AgentBrowserReply }) {
    const entry = this.pending.get(payload?.id);
    if (!entry) return;
    this.pending.delete(payload.id);
    clearTimeout(entry.timer);
    entry.resolve(payload.reply);
  }

  private async ensureSettings(): Promise<void> {
    if (this.settingsLoaded) return;
    try {
      const settings = await getAppSettings();
      this.headless = settings.browserHeadless !== false;
    } catch {
      this.headless = true;
    }
    this.settingsLoaded = true;
  }

  async isHeadless(): Promise<boolean> {
    await this.ensureSettings();
    return this.headless;
  }

  async setHeadless(value: boolean): Promise<boolean> {
    await this.ensureSettings();
    this.headless = value !== false;
    try {
      await saveAppSettings({ browserHeadless: this.headless });
    } catch { /* in-memory fallback */ }
    return this.headless;
  }

  // One in-flight bridge call at a time; concurrent sessions queue instead of
  // interleaving load/eval sequences on the shared webviews.
  private request(op: AgentBrowserOp, scope: BrowserScope, timeoutMs = 30000): Promise<AgentBrowserReply> {
    const run = async (): Promise<AgentBrowserReply> => {
      const sender = this.sender;
      if (!sender) throw new Error("Agent browser is not available (app window not ready yet).");
      const id = `ab-${Date.now().toString(36)}-${this.seq++}`;
      return new Promise<AgentBrowserReply>((resolve, reject) => {
        const entry = {} as PendingEntry;
        const timer = setTimeout(() => {
          this.pending.delete(id);
          entry.reject(new Error("Agent browser did not respond in time."));
        }, timeoutMs);
        entry.timer = timer;
        entry.resolve = (reply) => {
          clearTimeout(timer);
          resolve(reply);
        };
        entry.reject = (error) => {
          clearTimeout(timer);
          reject(error);
        };
        this.pending.set(id, entry);
        try {
          sender({ id, scope, ...op });
        } catch (error) {
          this.pending.delete(id);
          clearTimeout(timer);
          reject(error instanceof Error ? error : new Error(String(error)));
        }
      });
    };
    const chained = this.queue.then(run, run);
    this.queue = chained.then(
      () => undefined,
      () => undefined
    );
    return chained;
  }

  private async evalJs<T>(js: string, scope: BrowserScope): Promise<T> {
    const reply = await this.request({ kind: "eval", js }, scope);
    if (!reply.ok) throw new Error(reply.error || "Page script failed.");
    return reply.value as T;
  }

  // Reports activity for the built-in tab follow banner. autoFollow navigates
  // the visible tab along — only ever true for fresh navigations, never for
  // clicks/fills (re-navigating would wipe the agent's in-page state).
  // sessionId tags the originating run and scope tags the browser, so each
  // sidebar only ever mirrors its own mode + chat — never another's.
  private report(url: string | null, autoFollow: boolean, sessionId: string | undefined, scope: BrowserScope) {
    if (!url) return;
    try {
      this.onActivity?.({ url, timestamp: new Date().toISOString(), autoFollow, sessionId, scope });
    } catch { /* listener is best-effort */ }
  }

  private scopeOf(meta?: BrowserCallMeta): BrowserScope {
    return meta?.scope || "code";
  }

  private normalizeUrl(raw: string): string {
    let target = (raw || "").trim();
    if (!target) throw new Error("Empty URL.");
    // The agent webview shares the app session: only http(s) may load —
    // no file://, no custom schemes.
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(target) && !/^https?:\/\//i.test(target)) {
      throw new Error(`Only http(s) URLs are allowed in the agent browser (got "${target.slice(0, 80)}").`);
    }
    if (!/^https?:\/\//i.test(target)) target = `http://${target}`;
    return new URL(target).toString();
  }

  private static readonly RESOLVE_FN = [
    "function __resolve(target){",
    "if(!target) throw new Error('No target given. Snapshot first, then use a ref like e3.');",
    "var el=null;",
    "try{el=document.querySelector('[data-nexus-ref=\"'+target+'\"]');}catch(e){el=null;}",
    "if(el) return el;",
    "try{el=document.querySelector(target);}catch(e){el=null;}",
    "if(el) return el;",
    "var needle=String(target).trim().toLowerCase();",
    "var cands=Array.prototype.slice.call(document.querySelectorAll('a,button,input,select,textarea,[role]'));",
    "for(var i=0;i<cands.length;i++){var c=cands[i];",
    "var label=((c.innerText||'')+' '+(c.getAttribute('aria-label')||'')+' '+(c.getAttribute('value')||'')+' '+(c.getAttribute('placeholder')||'')).trim().toLowerCase();",
    "if(label&&label.indexOf(needle)!==-1) return c;}",
    "throw new Error('No element matches \"'+target+'\". Snapshot first and use a ref (e.g. e3).');",
    "}",
  ].join("\n");

  private static readonly SNAPSHOT_SCRIPT = [
    "(function(){",
    "var els=Array.prototype.slice.call(document.querySelectorAll('a[href],button,input,select,textarea,[role=\"button\"],[role=\"link\"],[role=\"textbox\"],[role=\"checkbox\"],[role=\"radio\"],[role=\"switch\"],[role=\"tab\"],[role=\"menuitem\"],[tabindex]'));",
    "var out=[];var n=0;",
    "for(var i=0;i<els.length;i++){var el=els[i];",
    "var r=el.getBoundingClientRect();var tag=el.tagName;",
    "if(tag!=='INPUT'&&tag!=='SELECT'&&tag!=='TEXTAREA'&&(r.width===0||r.height===0)) continue;",
    "var vis='visible';try{vis=getComputedStyle(el).visibility;}catch(e){}",
    "if(vis==='hidden') continue;",
    "n++;var ref='e'+n;el.setAttribute('data-nexus-ref',ref);",
    "var text=((el.innerText||'')+' '+(el.getAttribute('aria-label')||'')+' '+(el.getAttribute('placeholder')||'')+' '+(el.getAttribute('value')||'')+' '+(el.getAttribute('alt')||'')).replace(/\\s+/g,' ').trim().slice(0,80);",
    "var item={ref:ref,tag:tag.toLowerCase(),text:text};",
    "var t=(el.getAttribute('type')||'').toLowerCase();if(t)item.type=t;",
    "var role=el.getAttribute('role')||'';if(role)item.role=role;",
    "if(tag==='A')item.href=(el.getAttribute('href')||'').slice(0,120);",
    "out.push(item);if(out.length>=100)break;}",
    "return{url:location.href,title:document.title||'No title',count:out.length,elements:out};",
    "})()",
  ].join("\n");

  // Chromium does not serialize page-side throw messages across
  // executeJavaScript (generic "Script failed to execute" only), so page
  // scripts catch and return {ok:false,error} — this rethrows with the real
  // message ("No element matches e999…", "No option matches …"). Anything
  // without ok:false passes through untouched.
  private static pageTry(body: string): string {
    return `(function(){try{${body}}catch(e){return{ok:false,error:String((e&&e.message)||e)};}})()`;
  }

  private static unwrap<T>(res: T, what: string): T {
    if (res && typeof res === "object" && (res as { ok?: unknown }).ok === false) {
      throw new Error(String((res as { error?: unknown }).error || `${what} failed in the page.`));
    }
    return res;
  }

  private formatSnapshot(snap: { url: string; title: string; count: number; elements: Array<{ ref: string; tag: string; type?: string; role?: string; text: string; href?: string }> }): string {
    const head = `Snapshot of ${snap.url} — "${snap.title}" (${snap.count} interactive element${snap.count === 1 ? "" : "s"}):`;
    if (!snap.elements.length) return `${head}\n(no interactive elements — use text to read the page)`;
    const rows = snap.elements.slice(0, 40).map((e) => {
      const kind = e.role || (e.type ? `${e.tag}[${e.type}]` : e.tag);
      const extra = e.href ? ` -> ${e.href}` : "";
      return `[${e.ref}] ${kind} "${e.text}"${extra}`;
    });
    const more = snap.count > 40 ? `\n…${snap.count - 40} more (refine with text or a narrower page)` : "";
    return `${head}\n${rows.join("\n")}${more}\nRefs expire after navigation or DOM changes — snapshot again if a ref goes missing.`;
  }

  private async snapshotNow(scope: BrowserScope): Promise<string> {
    const snap = AgentBrowserService.unwrap(
      await this.evalJs<{ url: string; title: string; count: number; elements: Array<{ ref: string; tag: string; type?: string; role?: string; text: string; href?: string }> }>(
        AgentBrowserService.pageTry(`return (${AgentBrowserService.SNAPSHOT_SCRIPT});`),
        scope
      ),
      "snapshot"
    );
    return this.formatSnapshot(snap);
  }

  // Lightweight visit: loads the URL in the agent webview (activity + follow
  // banner included) without extracting a report. Used for visibility mirrors
  // where the data comes from elsewhere (e.g. web_search results).
  async visit(rawUrl: string, meta?: BrowserCallMeta): Promise<string> {
    await this.ensureSettings();
    const scope = this.scopeOf(meta);
    const targetUrl = this.normalizeUrl(rawUrl);
    const loaded = await this.request({ kind: "load", url: targetUrl }, scope, 25000);
    if (!loaded.ok) throw new Error(loaded.error || `Could not load ${targetUrl}.`);
    this.lastUrl = loaded.url || targetUrl;
    this.report(this.lastUrl, !this.headless, meta?.sessionId, scope);
    return this.lastUrl;
  }

  // Rendered page inspection with JavaScript executed (dev-server hydration
  // included — the renderer settles before replying).
  async inspect(rawUrl: string, meta?: BrowserCallMeta): Promise<string> {
    await this.ensureSettings();
    const scope = this.scopeOf(meta);
    const targetUrl = this.normalizeUrl(rawUrl);
    const startTime = Date.now();
    const loaded = await this.request({ kind: "load", url: targetUrl }, scope, 25000);
    if (!loaded.ok) throw new Error(loaded.error || `Could not load ${targetUrl}.`);
    this.lastUrl = loaded.url || targetUrl;
    this.report(this.lastUrl, !this.headless, meta?.sessionId, scope);

    const data = AgentBrowserService.unwrap(
      await this.evalJs<{ title: string; headings: string[]; buttons: string[]; links: string[]; inputs: string[]; text: string }>(
        AgentBrowserService.pageTry(`return (function(){
      var textOf=function(el){return(el.innerText||el.textContent||"").trim();};
      var title=document.title||"No title";
      var headings=Array.prototype.slice.call(document.querySelectorAll("h1,h2,h3")).map(function(el){return el.tagName+": "+textOf(el);}).filter(Boolean).slice(0,15);
      var buttons=Array.prototype.slice.call(document.querySelectorAll("button")).map(textOf).filter(Boolean).slice(0,15);
      var links=Array.prototype.slice.call(document.querySelectorAll("a[href]")).map(function(a){var t=textOf(a);var href=a.getAttribute("href")||"";return t&&href.indexOf("javascript:")!==0?t+" -> "+href:"";}).filter(Boolean).slice(0,15);
      var inputs=Array.prototype.slice.call(document.querySelectorAll("input")).map(function(el){return 'input[type="'+(el.getAttribute("type")||"text")+'"] name="'+(el.getAttribute("name")||"")+'" placeholder="'+(el.getAttribute("placeholder")||"")+'"';}).slice(0,10);
      var text=(document.body?document.body.innerText:"").split("\\n").map(function(l){return l.trim();}).filter(Boolean).join("\\n").slice(0,3000);
      return{title:title,headings:headings,buttons:buttons,links:links,inputs:inputs,text:text};})();`),
        scope
      ),
      "inspect"
    );

    const durationMs = Date.now() - startTime;
    let report = `=== Page Inspection (rendered): ${targetUrl} ===\n`;
    report += `Page Title: "${data.title || "No title"}" (${durationMs}ms)\n\n`;
    if (data.headings.length > 0) {
      report += `Headings Structure:\n${data.headings.map((h) => `  • ${h}`).join("\n")}\n\n`;
    }
    if (data.buttons.length > 0) {
      report += `Interactive Buttons:\n${data.buttons.map((b) => `  [Button: "${b}"]`).join("\n")}\n\n`;
    }
    if (data.inputs.length > 0) {
      report += `Form Inputs:\n${data.inputs.map((i) => `  <${i}>`).join("\n")}\n\n`;
    }
    if (data.links.length > 0) {
      report += `Navigation Links:\n${data.links.map((l) => `  • ${l}`).join("\n")}\n\n`;
    }
    report += `Visible Page Text Content (Excerpt):\n----------------------------------------\n${data.text}\n----------------------------------------`;
    return report;
  }

  // Text interaction with the loaded page: snapshot/click/fill/type/press/
  // scroll/navigate/back/reload/text/screenshot. Throws friendly errors; the
  // browser_act tool converts them to model-readable strings (never throws).
  // projectRoot scopes screenshot output (.nexus/browser/); without it shots
  // fall back to the OS temp dir.
  async act(input: BrowserActInput, projectRoot?: string, meta?: BrowserCallMeta): Promise<string> {
    await this.ensureSettings();
    const action = input?.action;
    if (!action) throw new Error("No action given. Use snapshot, click, fill, type, press, scroll, navigate, back, reload, text, or screenshot.");
    if ((action === "click" || action === "fill" || action === "type") && !input.target) {
      throw new Error(`${action} needs a target (snapshot first, then use a ref like e3).`);
    }
    if ((action === "fill" || action === "type") && input.value == null) throw new Error(`${action} needs a value.`);
    if (action === "press" && !(input.key || "").trim()) throw new Error("press needs a key (Enter, Escape, Tab, ArrowUp, …).");
    if (action === "navigate" && !input.url) throw new Error("navigate needs a url.");
    const scope = this.scopeOf(meta);

    switch (action) {
      case "snapshot": {
        return this.snapshotNow(scope);
      }
      case "navigate": {
        const targetUrl = this.normalizeUrl(input.url || "");
        const loaded = await this.request({ kind: "load", url: targetUrl }, scope, 25000);
        if (!loaded.ok) throw new Error(loaded.error || `Could not load ${targetUrl}.`);
        this.lastUrl = loaded.url || targetUrl;
        this.report(this.lastUrl, !this.headless, meta?.sessionId, scope);
        return `Navigated to ${targetUrl}.\n${await this.snapshotNow(scope)}`;
      }
      case "click": {
        const res = AgentBrowserService.unwrap(
          await this.evalJs<{ ok: boolean; error?: string; tag: string; text: string }>(
            `${AgentBrowserService.RESOLVE_FN}\n${AgentBrowserService.pageTry(`var el=__resolve(${JSON.stringify(input.target)});try{el.scrollIntoView({block:'center'});}catch(e){}el.click();return{ok:true,tag:el.tagName.toLowerCase(),text:(el.innerText||'').trim().slice(0,80)};`)}`
            ,
            scope
          ),
          "click"
        );
        this.report(this.lastUrl, false, meta?.sessionId, scope);
        return `Clicked <${res.tag}> "${res.text}". Snapshot again to see what changed.`;
      }
      case "fill": {
        const res = AgentBrowserService.unwrap(
          await this.evalJs<{ ok: boolean; error?: string; tag?: string; selected?: string; checked?: boolean }>(
            `${AgentBrowserService.RESOLVE_FN}\n${AgentBrowserService.pageTry(
              `var el=__resolve(${JSON.stringify(input.target)});var value=${JSON.stringify(input.value)};var tag=el.tagName;` +
                `if(tag==='SELECT'){var opts=el.options;var hit=-1;for(var i=0;i<opts.length;i++){if(opts[i].text===value||opts[i].value===value){hit=i;break;}}` +
                `if(hit===-1)throw new Error('No option matches "'+value+'".');el.selectedIndex=hit;el.dispatchEvent(new Event('change',{bubbles:true}));return{ok:true,selected:opts[hit].text};}` +
                `if(tag==='INPUT'&&(el.type==='checkbox'||el.type==='radio')){var want=/^(true|1|yes|on|check)/i.test(value);if(el.checked!==want)el.click();return{ok:true,checked:el.checked};}` +
                `if(el.isContentEditable){el.focus();el.textContent=value;el.dispatchEvent(new Event('input',{bubbles:true}));return{ok:true};}` +
                `var proto=tag==='TEXTAREA'?HTMLTextAreaElement.prototype:HTMLInputElement.prototype;var desc=Object.getOwnPropertyDescriptor(proto,'value');` +
                `el.focus();if(desc&&desc.set)desc.set.call(el,value);else el.value=value;` +
                `el.dispatchEvent(new Event('input',{bubbles:true}));el.dispatchEvent(new Event('change',{bubbles:true}));return{ok:true,tag:tag.toLowerCase()};`
            )}`,
            scope
          ),
          "fill"
        );
        this.report(this.lastUrl, false, meta?.sessionId, scope);
        if (res.selected != null) return `Selected "${res.selected}".`;
        if (res.checked != null) return `Checkbox is now ${res.checked ? "checked" : "unchecked"}.`;
        return `Filled <${res.tag || "field"}>.`;
      }
      case "type": {
        AgentBrowserService.unwrap(
          await this.evalJs<{ ok: boolean; error?: string }>(
            `${AgentBrowserService.RESOLVE_FN}\n${AgentBrowserService.pageTry(
              `var el=__resolve(${JSON.stringify(input.target)});el.focus();var ok=false;` +
                `try{ok=document.execCommand('insertText',false,${JSON.stringify(input.value)});}catch(e){ok=false;}` +
                `if(!ok&&'value' in el){el.value=(el.value||'')+${JSON.stringify(input.value)};el.dispatchEvent(new Event('input',{bubbles:true}));}` +
                `return{ok:true};`
            )}`,
            scope
          ),
          "type"
        );
        this.report(this.lastUrl, false, meta?.sessionId, scope);
        return "Typed into the field (appended).";
      }
      case "press": {
        const key = (input.key || "").trim();
        const alias: Record<string, string> = {
          enter: "Enter", return: "Enter", esc: "Escape", escape: "Escape",
          space: "Space", tab: "Tab", up: "Up", down: "Down", left: "Left", right: "Right",
          backspace: "Backspace", delete: "Delete", home: "Home", end: "End",
          pageup: "PageUp", pagedown: "PageDown",
        };
        const keyCode = alias[key.toLowerCase()] || (/^f\d{1,2}$/i.test(key) ? key.toUpperCase() : key);
        const pressed = await this.request({ kind: "press", keyCode }, scope);
        if (!pressed.ok) throw new Error(pressed.error || "Key press failed.");
        this.report(this.lastUrl, false, meta?.sessionId, scope);
        return `Pressed ${keyCode}. Snapshot again to see what changed.`;
      }
      case "scroll": {
        const direction = input.direction || "down";
        if (input.target) {
          AgentBrowserService.unwrap(
            await this.evalJs<{ ok: boolean; error?: string }>(
              `${AgentBrowserService.RESOLVE_FN}\n${AgentBrowserService.pageTry(`var el=__resolve(${JSON.stringify(input.target)});try{el.scrollIntoView({block:'center'});}catch(e){}return{ok:true};`)}`,
              scope
            ),
            "scroll"
          );
          return "Scrolled to the element.";
        }
        const dy = direction === "top" ? "top" : direction === "bottom" ? "bottom" : direction === "up" ? -600 : 600;
        await this.evalJs<{ ok: boolean; y: number }>(
          AgentBrowserService.pageTry(
            `(function(){if(${JSON.stringify(dy)}==='top'){window.scrollTo(0,0);}else if(${JSON.stringify(dy)}==='bottom'){window.scrollTo(0,document.body?document.body.scrollHeight:0);}else{window.scrollBy(0,${typeof dy === "number" ? dy : 600});}return{ok:true,y:window.scrollY};})()`
          ),
          scope
        );
        return `Scrolled ${direction}.`;
      }
      case "back": {
        const went = await this.request({ kind: "back" }, scope, 15000);
        if (!went.ok) throw new Error(went.error || "Could not go back.");
        this.report(this.lastUrl, false, meta?.sessionId, scope);
        return "Went back. Snapshot again to see the page.";
      }
      case "reload": {
        const reloaded = await this.request({ kind: "reload" }, scope, 20000);
        if (!reloaded.ok) throw new Error(reloaded.error || "Could not reload.");
        this.report(this.lastUrl, false, meta?.sessionId, scope);
        return "Reloaded. Snapshot again to see the page.";
      }
      case "text": {
        const res = AgentBrowserService.unwrap(
          await this.evalJs<{ text: string }>(
            AgentBrowserService.pageTry(`return{text:(document.body?document.body.innerText:'').slice(0,4000)};`),
            scope
          ),
          "text"
        );
        return `Rendered text of ${this.lastUrl || "the page"}:\n----------------------------------------\n${res.text}\n----------------------------------------`;
      }
      case "screenshot": {
        const shot = await this.request({ kind: "shot" }, scope, 25000);
        if (!shot.ok) throw new Error(shot.error || "Screenshot failed.");
        if (!shot.dataUrl) throw new Error("Screenshot came back empty.");
        const base64 = shot.dataUrl.includes(",") ? shot.dataUrl.split(",")[1] : shot.dataUrl;
        const shotDir = projectRoot ? path.join(path.resolve(projectRoot), ".nexus", "browser") : path.join(os.tmpdir(), "nexus-browser");
        const file = `shot-${Date.now().toString(36)}.png`;
        await fs.mkdir(shotDir, { recursive: true });
        await fs.writeFile(path.join(shotDir, file), Buffer.from(base64, "base64"));
        const where = projectRoot ? `.nexus/browser/${file}` : path.join(shotDir, file);
        const dims = shot.width && shot.height ? ` (${shot.width}x${shot.height})` : "";
        return (
          `Screenshot saved to ${where}${dims}. ` +
          `The model cannot view images yet — open the file yourself to verify visually, or describe what to check and ask the agent to snapshot/text instead.`
        );
      }
      default:
        throw new Error(`Unknown browser action "${action}". Use snapshot, click, fill, type, press, scroll, navigate, back, reload, text, or screenshot.`);
    }
  }

  destroy(): void {
    for (const [, entry] of this.pending) {
      clearTimeout(entry.timer);
      entry.reject(new Error("Agent browser is shutting down."));
    }
    this.pending.clear();
    this.sender = null;
  }
}

export const agentBrowserService = new AgentBrowserService();



