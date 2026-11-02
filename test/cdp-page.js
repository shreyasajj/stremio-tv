// Minimal Chrome DevTools Protocol client for one page target. Playwright's
// connectOverCDP needs browser-context management that QtWebEngine's DevTools
// server doesn't implement, so the native test talks to the page directly.

const WS = globalThis.WebSocket || require('playwright-core/lib/utilsBundle').ws;

const KEYS = {
  Enter: { code: 'Enter', keyCode: 13, text: '\r' },
  Escape: { code: 'Escape', keyCode: 27 },
  Backspace: { code: 'Backspace', keyCode: 8 },
  ArrowLeft: { code: 'ArrowLeft', keyCode: 37 },
  ArrowUp: { code: 'ArrowUp', keyCode: 38 },
  ArrowRight: { code: 'ArrowRight', keyCode: 39 },
  ArrowDown: { code: 'ArrowDown', keyCode: 40 },
};

class CdpPage {
  static async connect(port, urlIncludes) {
    const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
    const target = targets.find((t) => t.type === 'page' && t.url.includes(urlIncludes));
    if (!target) throw new Error(`no page target matching ${urlIncludes}`);
    const page = new CdpPage(new WS(target.webSocketDebuggerUrl));
    await page._opened;
    await page.send('Runtime.enable');
    await page.send('Page.enable');
    return page;
  }

  constructor(ws) {
    this.ws = ws;
    this.seq = 0;
    this.pending = new Map();
    this.errorHandlers = [];
    this._opened = new Promise((resolve, reject) => {
      ws.onopen = resolve;
      ws.onerror = (e) => reject(new Error(e.message || 'websocket error'));
    });
    ws.onmessage = (event) => {
      const msg = JSON.parse(typeof event.data === 'string' ? event.data : event.data.toString());
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(`${msg.error.message} ${msg.error.data || ''}`));
        else resolve(msg.result);
      } else if (msg.method === 'Runtime.exceptionThrown') {
        const d = msg.params.exceptionDetails;
        const text = d.exception?.description || d.text;
        this.errorHandlers.forEach((h) => h(text));
      }
    };
    this.keyboard = { press: (key) => this.press(key) };
  }

  send(method, params = {}) {
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  onPageError(handler) { this.errorHandlers.push(handler); }

  async evaluate(fn, arg) {
    const expression = `(${fn})(${arg === undefined ? '' : JSON.stringify(arg)})`;
    const res = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (res.exceptionDetails) {
      throw new Error(res.exceptionDetails.exception?.description || res.exceptionDetails.text);
    }
    return res.result.value;
  }

  async press(key) {
    const def = KEYS[key];
    if (!def) throw new Error(`unknown key ${key}`);
    const base = { key, code: def.code, windowsVirtualKeyCode: def.keyCode, nativeVirtualKeyCode: def.keyCode };
    await this.send('Input.dispatchKeyEvent', def.text
      ? { type: 'keyDown', text: def.text, unmodifiedText: def.text, ...base }
      : { type: 'rawKeyDown', ...base });
    await this.send('Input.dispatchKeyEvent', { type: 'keyUp', ...base });
  }

  waitForTimeout(ms) { return new Promise((r) => setTimeout(r, ms)); }

  async waitForFunction(fn, arg, { timeout = 15000 } = {}) {
    const end = Date.now() + timeout;
    for (;;) {
      try { if (await this.evaluate(fn, arg)) return; } catch { /* page navigating */ }
      if (Date.now() > end) throw new Error(`timeout waiting for ${String(fn).slice(0, 80)}`);
      await this.waitForTimeout(150);
    }
  }

  waitForSelector(selector, { timeout = 15000 } = {}) {
    return this.waitForFunction((s) => !!document.querySelector(s), selector, { timeout });
  }

  count(selector) { return this.evaluate((s) => document.querySelectorAll(s).length, selector); }
  text(selector) { return this.evaluate((s) => document.querySelector(s)?.textContent || '', selector); }

  async reload() {
    await this.send('Page.reload', { ignoreCache: true });
    await this.waitForTimeout(500);
  }

  close() { try { this.ws.close(); } catch { /* ignore */ } }
}

module.exports = { CdpPage };
