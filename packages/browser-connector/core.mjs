#!/usr/bin/env node
/**
 * browser-mcp — an MCP stdio server that drives a real Chromium browser
 * (Edge or Chrome) over the DevTools Protocol.
 *
 * Design notes:
 *  - No dependency at all: Node's global WebSocket speaks CDP, and the browser
 *    is discovered through its own HTTP endpoint (GET /json/list).
 *  - The default instance is launched headless with a throwaway profile, so
 *    automation never takes focus from the person at the keyboard and never
 *    touches their real browsing session. `browser_connect` attaches to a
 *    browser they started themselves with --remote-debugging-port=9222 when
 *    they want their own logins.
 *  - Interacting through Runtime.evaluate (click/type/inspect) keeps the tool
 *    surface small and behaves like a user for form events; screenshots go
 *    through Page.captureScreenshot.
 *
 * MCP stdio transport: one JSON-RPC 2.0 message per line on stdin/stdout.
 * Nothing else may ever be written to stdout.
 */
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';

const CANDIDATE_BROWSERS = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
];

const state = {
  port: 0,
  ws: null,
  target: null, // { id, title, url, webSocketDebuggerUrl }
  nextId: 1,
  pending: new Map(),
  launched: null, // child process we started
  profileDir: '',
};

// ------------------------------------------------------------------ helpers
function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function httpJson(path) {
  const response = await fetch(`http://127.0.0.1:${state.port}${path}`);
  if (!response.ok) throw new Error(`browser-mcp: HTTP ${response.status} for ${path}`);
  return response.json();
}

function findBrowser() {
  for (const candidate of CANDIDATE_BROWSERS) if (existsSync(candidate)) return candidate;
  throw new Error('browser-mcp: no Edge or Chrome installation found');
}

/** Poll the debugging endpoint until the browser answers. */
async function waitForEndpoint(timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      await httpJson('/json/version');
      return;
    } catch (error) {
      lastError = error;
      await sleep(150);
    }
  }
  throw new Error(`browser-mcp: debugging endpoint never came up (${lastError?.message ?? 'timeout'})`);
}

function openSocket(url) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url);
    const onError = () => reject(new Error('browser-mcp: WebSocket connection failed'));
    socket.addEventListener('open', () => {
      socket.removeEventListener('error', onError);
      resolve(socket);
    });
    socket.addEventListener('error', onError);
  });
}

/** One CDP command on the current connection. */
function cdp(method, params = {}, sessionId) {
  if (state.ws === null) throw new Error('browser-mcp: not connected — call browser_launch or browser_connect first');
  const id = state.nextId++;
  const message = { id, method, params };
  if (sessionId !== undefined) message.sessionId = sessionId;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      state.pending.delete(id);
      reject(new Error(`browser-mcp: ${method} timed out`));
    }, 45000);
    state.pending.set(id, {
      resolve: (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      reject: (error) => {
        clearTimeout(timer);
        reject(error);
      },
    });
    state.ws.send(JSON.stringify(message));
  });
}

function attachSocketHandlers(socket) {
  socket.addEventListener('message', (event) => {
    let message;
    try {
      message = JSON.parse(event.data);
    } catch {
      return;
    }
    if (message.id === undefined) return;
    const entry = state.pending.get(message.id);
    if (entry === undefined) return;
    state.pending.delete(message.id);
    if (message.error !== undefined) entry.reject(new Error(`browser-mcp: ${message.error.message}`));
    else entry.resolve(message.result ?? {});
  });
  socket.addEventListener('close', () => {
    for (const [id, entry] of state.pending) {
      state.pending.delete(id);
      entry.reject(new Error('browser-mcp: connection closed'));
    }
    if (state.ws === socket) state.ws = null;
  });
}

async function listTargets() {
  const targets = await httpJson('/json/list');
  return targets.filter((target) => target.type === 'page').map((target) => ({
    id: target.id,
    title: target.title,
    url: target.url,
    webSocketDebuggerUrl: target.webSocketDebuggerUrl,
  }));
}

/** A browser opens an extra about:blank tab beside the URL asked for; prefer a real page. */
function preferredPage(pages) {
  return pages.find((page) => page.url !== '' && page.url !== 'about:blank') ?? pages[0];
}

/** Pick a page target: explicit id/title fragment, else the first real page. */
async function selectTarget(selector) {
  const pages = await listTargets();
  if (pages.length === 0) throw new Error('browser-mcp: no page target is open');
  let chosen = preferredPage(pages);
  if (typeof selector === 'string' && selector !== '') {
    const needle = selector.toLowerCase();
    chosen =
      pages.find((page) => page.id === selector) ??
      pages.find((page) => page.title.toLowerCase().includes(needle)) ??
      pages.find((page) => page.url.toLowerCase().includes(needle));
    if (chosen === undefined) throw new Error(`browser-mcp: no page matches "${selector}"`);
  }
  if (state.target === null || state.target.id !== chosen.id) await attachTarget(chosen);
  return chosen;
}

async function attachTarget(page) {
  if (state.ws !== null) {
    try {
      state.ws.close();
    } catch {
      /* closing is best effort */
    }
    state.ws = null;
  }
  state.pending.clear();
  const socket = await openSocket(page.webSocketDebuggerUrl);
  attachSocketHandlers(socket);
  state.ws = socket;
  state.target = page;
  await cdp('Runtime.enable');
  await cdp('Page.enable');
  return page;
}

/** Evaluate an expression in the page and return its JSON value. */
async function evaluate(expression) {
  const result = await cdp('Runtime.evaluate', {
    expression,
    returnByValue: true,
    awaitPromise: true,
    userGesture: true,
  });
  if (result.exceptionDetails !== undefined) {
    const detail = result.exceptionDetails.exception?.description ?? result.exceptionDetails.text ?? 'evaluation failed';
    throw new Error(`browser-mcp: ${detail}`);
  }
  return result.result?.value;
}

const CLICK_HELPER = `
(() => {
  const byText = %TEXT%;
  const target = %SELECTOR%;
  if (!target) return { ok: false, reason: 'no element matched' };
  target.scrollIntoView({ block: 'center', inline: 'center' });
  const rect = target.getBoundingClientRect();
  const options = { bubbles: true, cancelable: true, view: window, clientX: rect.left + rect.width / 2, clientY: rect.top + rect.height / 2 };
  for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']) {
    const EventType = type.startsWith('pointer') ? PointerEvent : MouseEvent;
    target.dispatchEvent(new EventType(type, options));
  }
  if (typeof target.click === 'function') target.click();
  return { ok: true, tag: target.tagName, text: (target.innerText || target.value || '').slice(0, 120) };
})()
`;

const TYPE_HELPER = `
(() => {
  const target = %SELECTOR%;
  if (!target) return { ok: false, reason: 'no element matched' };
  target.scrollIntoView({ block: 'center', inline: 'center' });
  target.focus();
  const text = %TEXT%;
  if (target.isContentEditable) {
    target.textContent = text;
  } else {
    const prototype = target instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(prototype, 'value').set;
    setter.call(target, text);
  }
  target.dispatchEvent(new Event('input', { bubbles: true }));
  target.dispatchEvent(new Event('change', { bubbles: true }));
  return { ok: true, value: (target.value !== undefined ? target.value : target.textContent).slice(0, 120) };
})()
`;

const SNAPSHOT_HELPER = `
(() => {
  const body = document.body;
  if (!body) return { text: '', outline: [] };
  const text = (body.innerText || '').replace(/\\n{3,}/g, '\\n\\n').trim();
  const outline = [];
  for (const element of document.querySelectorAll('a, button, input, select, textarea, [role="button"], [role="link"], [role="tab"], [contenteditable="true"]')) {
    const rect = element.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) continue;
    const label = (element.innerText || element.value || element.getAttribute('aria-label') || element.getAttribute('placeholder') || element.getAttribute('title') || '').trim().slice(0, 80);
    if (label === '') continue;
    outline.push({
      tag: element.tagName.toLowerCase(),
      type: element.getAttribute('type') || undefined,
      name: element.getAttribute('name') || undefined,
      id: element.id || undefined,
      label,
    });
    if (outline.length >= 120) break;
  }
  return { text, outline, title: document.title, url: location.href };
})()
`;

function defaultShotPath() {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  return join(tmpdir(), 'dsh-browser-mcp', `page-${stamp}.png`);
}

/** Wait until the attached page has a real document, not the startup blank tab. */
async function waitForReady(timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    try {
      const raw = await evaluate('JSON.stringify({ ready: document.readyState, url: location.href, title: document.title })');
      last = JSON.parse(raw);
      if ((last.ready === 'complete' || last.ready === 'interactive') && last.url !== 'about:blank') return last;
    } catch {
      /* the renderer may not answer while the navigation commits */
    }
    await sleep(200);
  }
  return last;
}

const TOOLS = [
  {
    name: 'browser_launch',
    description: 'Start a Chromium browser (Edge or Chrome) with a throwaway profile and connect to it. Headless by default, so it never takes focus. Returns the debugging port and the open page.',
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'Page to open (defaults to about:blank).' },
        headless: { type: 'boolean', description: 'Run without a window (default true).' },
        port: { type: 'number', description: 'Debugging port (default 9222).' },
      },
    },
    handler: async (args) => {
      if (state.launched !== null) {
        return text(`already launched on port ${state.port}; use browser_quit to restart`);
      }
      const browser = findBrowser();
      const port = Math.trunc(args.port ?? 9222);
      const profile = join(tmpdir(), `dsh-browser-mcp-profile-${port}`);
      mkdirSync(profile, { recursive: true });
      const flags = [
        `--remote-debugging-port=${port}`,
        `--user-data-dir=${profile}`,
        '--no-first-run',
        '--no-default-browser-check',
        '--disable-features=msEdgeFirstRunExperience,msSmartScreenProtection',
        '--disable-extensions',
        '--window-size=1600,1000',
      ];
      if (args.headless !== false) flags.push('--headless=new', '--disable-gpu');
      flags.push(typeof args.url === 'string' && args.url !== '' ? args.url : 'about:blank');
      state.port = port;
      state.profileDir = profile;
      state.launched = spawn(browser, flags, { detached: false, stdio: 'ignore' });
      state.launched.on('exit', () => {
        state.launched = null;
        state.ws = null;
        state.target = null;
      });
      await waitForEndpoint(20000);
      const page = await selectTarget('');
      const ready = await waitForReady();
      return text(
        `launched ${browser}\nport ${port}\nprofile ${profile}\npage ${page.id} — ${ready?.title || page.url}`,
      );
    },
  },
  {
    name: 'browser_connect',
    description: 'Attach to a browser the user already started with --remote-debugging-port (their own logins and tabs).',
    inputSchema: {
      type: 'object',
      properties: { port: { type: 'number', description: 'Debugging port of the running browser (default 9222).' } },
    },
    handler: async (args) => {
      state.port = Math.trunc(args.port ?? 9222);
      await waitForEndpoint(6000);
      const version = await httpJson('/json/version');
      const page = await selectTarget('');
      const ready = await waitForReady(8000);
      return text(`attached to ${version.Browser ?? 'browser'} on port ${state.port}\npage ${page.id} — ${ready?.title || page.url}`);
    },
  },
  {
    name: 'browser_tabs',
    description: 'List the open pages with their id, title and url.',
    inputSchema: { type: 'object', properties: {} },
    handler: async () => {
      const pages = await listTargets();
      if (pages.length === 0) return text('no pages open');
      return text(pages.map((page) => `${page.id}\t${page.title || '(untitled)'}\t${page.url}`).join('\n'));
    },
  },
  {
    name: 'browser_navigate',
    description: 'Open a URL (or switch to the matching page) and wait for the document to be ready.',
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'URL to open, or a title/url fragment of an existing tab to switch to.' },
        tab: { type: 'string', description: 'Tab id or title fragment to reuse instead of opening a new page.' },
        new_tab: { type: 'boolean', description: 'Force a new tab even when a tab matches.' },
      },
      required: ['url'],
    },
    handler: async (args) => {
      const looksLikeUrl = /^[a-z]+:\/\//i.test(args.url) || /^localhost|^\d+\.\d+\.\d+\.\d+/.test(args.url);
      const url = looksLikeUrl ? args.url : `https://${args.url}`;
      const pages = await listTargets();
      if (args.new_tab === true || args.tab !== undefined || pages.length === 0) {
        const target = await cdp('Target.createTarget', { url });
        await sleep(400);
        const created = (await listTargets()).find((page) => page.id === target.targetId);
        if (created !== undefined) await attachTarget(created);
      } else {
        await selectTarget('');
        await cdp('Page.navigate', { url });
      }
      for (let attempt = 0; attempt < 60; attempt += 1) {
        const ready = await evaluate('document.readyState');
        if (ready === 'complete' || ready === 'interactive') break;
        await sleep(150);
      }
      await sleep(250);
      const page = await selectTarget('');
      const settled = await waitForReady(8000);
      return text(`navigated to ${url}\npage ${page.id} — ${settled?.title ?? (await evaluate('document.title'))}`);
    },
  },
  {
    name: 'browser_snapshot',
    description: 'Read the current page: title, url, visible text, and an outline of interactive elements (links, buttons, inputs) to act on.',
    inputSchema: {
      type: 'object',
      properties: {
        tab: { type: 'string', description: 'Tab id or title fragment (defaults to the first page).' },
        max_chars: { type: 'number', description: 'Trim the visible text to this many characters (default 6000).' },
      },
    },
    handler: async (args) => {
      await selectTarget(args.tab);
      const snapshot = await evaluate(SNAPSHOT_HELPER);
      const limit = Math.trunc(args.max_chars ?? 6000);
      const body = String(snapshot.text ?? '').slice(0, limit);
      const outline = (snapshot.outline ?? [])
        .map((item) => `${item.tag}${item.type !== undefined ? `[${item.type}]` : ''}${item.id !== undefined ? `#${item.id}` : item.name !== undefined ? `[name=${item.name}]` : ''} :: ${item.label}`)
        .join('\n');
      return text(`${snapshot.title}\n${snapshot.url}\n\n--- text ---\n${body}\n\n--- interactive ---\n${outline}`);
    },
  },
  {
    name: 'browser_eval',
    description: 'Evaluate a JavaScript expression in the page and return its value as JSON.',
    inputSchema: {
      type: 'object',
      properties: {
        expression: { type: 'string', description: 'Expression to evaluate (a promise is awaited).' },
        tab: { type: 'string', description: 'Tab id or title fragment.' },
      },
      required: ['expression'],
    },
    handler: async (args) => {
      await selectTarget(args.tab);
      const value = await evaluate(args.expression);
      return text(typeof value === 'string' ? value : JSON.stringify(value, null, 2));
    },
  },
  {
    name: 'browser_click',
    description: 'Click an element found by CSS selector, or the first element whose text contains the given string.',
    inputSchema: {
      type: 'object',
      properties: {
        selector: { type: 'string', description: 'CSS selector.' },
        text: { type: 'string', description: 'Visible text to match instead of a selector.' },
        tab: { type: 'string', description: 'Tab id or title fragment.' },
      },
    },
    handler: async (args) => {
      if (args.selector === undefined && args.text === undefined) throw new Error('browser-mcp: give selector or text');
      await selectTarget(args.tab);
      const selector =
        args.selector !== undefined
          ? `document.querySelector(${JSON.stringify(args.selector)})`
          : `Array.from(document.querySelectorAll('a,button,[role="button"],[role="link"],input[type="submit"],input[type="button"],summary,label')).find((el) => ((el.innerText || el.value || '') + ' ' + (el.getAttribute('aria-label') || '')).includes(${JSON.stringify(args.text)}))`;
      const script = CLICK_HELPER.replace('%SELECTOR%', selector).replace('%TEXT%', JSON.stringify(args.text ?? ''));
      const result = await evaluate(script);
      if (!result?.ok) throw new Error(`browser-mcp: click failed — ${result?.reason ?? 'unknown'}`);
      await sleep(400);
      return text(`clicked <${result.tag}> ${result.text ?? ''}`.trim());
    },
  },
  {
    name: 'browser_type',
    description: 'Focus an input (CSS selector or a label/placeholder fragment), set its value, and fire input/change events. submit presses Enter afterwards.',
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'Text to enter.' },
        selector: { type: 'string', description: 'CSS selector of the field.' },
        field: { type: 'string', description: 'Label, placeholder or name fragment used to find the field.' },
        submit: { type: 'boolean', description: 'Press Enter after typing (default false).' },
        tab: { type: 'string', description: 'Tab id or title fragment.' },
      },
      required: ['text'],
    },
    handler: async (args) => {
      await selectTarget(args.tab);
      const selector =
        args.selector !== undefined
          ? `document.querySelector(${JSON.stringify(args.selector)})`
          : `Array.from(document.querySelectorAll('input,textarea,[contenteditable="true"]')).find((el) => [el.getAttribute('placeholder'), el.getAttribute('aria-label'), el.getAttribute('name'), el.id, el.type].some((value) => typeof value === 'string' && value.toLowerCase().includes(${JSON.stringify(String(args.field ?? '').toLowerCase())})))`;
      const script = TYPE_HELPER.replace('%SELECTOR%', selector).replace('%TEXT%', JSON.stringify(args.text));
      const result = await evaluate(script);
      if (!result?.ok) throw new Error(`browser-mcp: type failed — ${result?.reason ?? 'unknown'}`);
      if (args.submit === true) {
        await evaluate(`(() => { const el = ${selector}; if (!el) return null; el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true })); el.dispatchEvent(new KeyboardEvent('keypress', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true })); el.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true })); const form = el.form; if (form && typeof form.requestSubmit === 'function') form.requestSubmit(); return true; })()`);
        await sleep(900);
      }
      return text(`typed into field: ${result.value}`);
    },
  },
  {
    name: 'browser_screenshot',
    description: 'Screenshot the page (whole viewport, or the full scrollable page with full_page). Writes a PNG and optionally returns the image itself.',
    inputSchema: {
      type: 'object',
      properties: {
        tab: { type: 'string', description: 'Tab id or title fragment.' },
        full_page: { type: 'boolean', description: 'Capture beyond the viewport (default false).' },
        inline: { type: 'boolean', description: 'Also return the image itself (default false).' },
        path: { type: 'string', description: 'Absolute PNG path to write (defaults to a temp path).' },
        settle_ms: { type: 'number', description: 'Wait before capturing (max 5000).' },
      },
    },
    handler: async (args) => {
      const settle = Math.max(0, Math.min(Math.trunc(args.settle_ms ?? 0), 5000));
      if (settle > 0) await sleep(settle);
      await selectTarget(args.tab);
      const captured = await cdp('Page.captureScreenshot', {
        format: 'png',
        captureBeyondViewport: args.full_page === true,
        fromSurface: true,
      });
      const png = Buffer.from(captured.data ?? '', 'base64');
      if (png.length === 0) throw new Error('browser-mcp: empty screenshot');
      const outPath = typeof args.path === 'string' && args.path !== '' ? args.path : defaultShotPath();
      mkdirSync(dirname(outPath), { recursive: true });
      writeFileSync(outPath, png);
      const title = await evaluate('document.title');
      const summary = `page "${title}" -> ${outPath} (${(png.length / 1024).toFixed(1)} KiB)`;
      if (args.inline === true) {
        return {
          content: [
            { type: 'text', text: summary },
            { type: 'image', data: png.toString('base64'), mimeType: 'image/png' },
          ],
        };
      }
      return text(summary);
    },
  },
  {
    name: 'browser_close',
    description: 'Close one page (the current one, or the given tab).',
    inputSchema: { type: 'object', properties: { tab: { type: 'string', description: 'Tab id or title fragment.' } } },
    handler: async (args) => {
      const page = await selectTarget(args.tab);
      await cdp('Target.closeTarget', { targetId: page.id });
      state.target = null;
      state.ws = null;
      return text(`closed ${page.id} — ${page.title}`);
    },
  },
  {
    name: 'browser_quit',
    description: 'Close the browser instance this server launched and drop the throwaway profile.',
    inputSchema: { type: 'object', properties: {} },
    handler: async () => {
      const profile = state.profileDir;
      if (state.launched !== null) {
        state.launched.kill();
        state.launched = null;
      } else if (state.ws !== null) {
        await cdp('Browser.close').catch(() => undefined);
      }
      state.ws = null;
      state.target = null;
      if (profile !== '' && existsSync(profile)) {
        try {
          rmSync(profile, { recursive: true, force: true });
        } catch {
          /* the profile is a temp directory; a partial cleanup is fine */
        }
      }
      return text('browser closed');
    },
  },
];

function text(value) {
  return { content: [{ type: 'text', text: value }] };
}

async function handleTool(name, args) {
  const tool = TOOLS.find((candidate) => candidate.name === name);
  if (tool === undefined) throw new Error(`browser-mcp: unknown tool "${name}"`);
  return tool.handler(args ?? {});
}

// ------------------------------------------------------------ MCP stdio loop
const SUPPORTED_PROTOCOLS = ['2025-06-18', '2025-03-26', '2024-11-05', '2024-10-07'];

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

async function handleMessage(message) {
  const { id, method, params } = message;
  if (method === undefined) return;
  if (method === 'initialize') {
    const requested = params?.protocolVersion;
    send({
      jsonrpc: '2.0',
      id,
      result: {
        protocolVersion: SUPPORTED_PROTOCOLS.includes(requested) ? requested : SUPPORTED_PROTOCOLS[0],
        capabilities: { tools: {} },
        serverInfo: { name: 'browser-mcp', version: '1.0.0' },
      },
    });
    return;
  }
  if (method === 'notifications/initialized' || method === 'notifications/cancelled') return;
  if (method === 'ping') {
    send({ jsonrpc: '2.0', id, result: {} });
    return;
  }
  if (method === 'tools/list') {
    send({
      jsonrpc: '2.0',
      id,
      result: { tools: TOOLS.map((tool) => ({ name: tool.name, description: tool.description, inputSchema: tool.inputSchema })) },
    });
    return;
  }
  if (method === 'tools/call') {
    try {
      const result = await handleTool(params?.name, params?.arguments);
      send({ jsonrpc: '2.0', id, result: { ...result, isError: false } });
    } catch (error) {
      send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: String(error?.message ?? error) }], isError: true } });
    }
  }
}

function main() {
  let buffered = '';
  // Tool calls are serialized: a client that pipelines them still gets
  // launch → navigate → click ordering, and one slow call cannot race the next.
  let chain = Promise.resolve();
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => {
    buffered += chunk;
    let index = buffered.indexOf('\n');
    while (index >= 0) {
      const line = buffered.slice(0, index).trim();
      buffered = buffered.slice(index + 1);
      if (line !== '') {
        let parsed;
        try {
          parsed = JSON.parse(line);
        } catch (error) {
          send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: String(error?.message ?? error) } });
          index = buffered.indexOf('\n');
          continue;
        }
        chain = chain.then(() =>
          handleMessage(parsed).catch((error) => {
            send({ jsonrpc: '2.0', id: null, error: { code: -32603, message: String(error?.message ?? error) } });
          }),
        );
      }
      index = buffered.indexOf('\n');
    }
  });
  process.stdin.on('end', () => {
    void chain.then(() => {
      if (state.launched !== null) state.launched.kill();
      process.exit(0);
    });
  });
}

// Reused by the native Cordis front-end (`index.js`) as well as this stdio one.
export { TOOLS, handleTool };

// Only run a front-end when this file is the process entry point, so importing
// it as a library never starts a server.
const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  if (process.argv.includes('--selftest')) {
    process.stdout.write(
      `${JSON.stringify({ browser: (() => { try { return findBrowser(); } catch (error) { return String(error.message); } })(), tools: TOOLS.length, websocket: typeof WebSocket })}\n`,
    );
  } else {
    main();
  }
}
