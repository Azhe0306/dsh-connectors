#!/usr/bin/env node
/**
 * desktop-mcp — a dependency-light MCP stdio server that gives the agent
 * screen vision and real input on Windows.
 *
 * Design notes:
 *  - Win32 is reached through koffi (Node-API FFI), so nothing is compiled at
 *    run time, no child process is spawned per call, and no native helper is
 *    shipped. koffi's absolute path is passed in by the bundle config because
 *    the DSH host scrubs DSH_* variables from the child environment.
 *  - Screenshots prefer PrintWindow(PW_RENDERFULLCONTENT), which renders a
 *    window even while it is occluded or partly off-screen; a plain BitBlt of
 *    the screen DC is the fallback for full-desktop shots.
 *  - PNG output is encoded here (zlib + a minimal chunk writer) so the server
 *    needs no image library, and both a file path (for read_image) and an
 *    optional inline image block are returned.
 *
 * MCP stdio transport: one JSON-RPC 2.0 message per line on stdin/stdout.
 * Nothing else may ever be written to stdout.
 */
import { createRequire } from 'node:module';
import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';

const require = createRequire(import.meta.url);

function loadKoffi() {
  const candidates = [
    // Package-local first: a published bundle declares koffi as a dependency, so
    // pnpm places it beside this file.
    'koffi',
    process.env.DESKTOP_MCP_KOFFI,
    join(process.env.DSH_DESKTOP_APP_DIR ?? '', 'node_modules', 'koffi'),
    'D:/DSH Desktop/resources/app/node_modules/koffi',
  ].filter(Boolean);
  const failures = [];
  for (const candidate of candidates) {
    try {
      return require(candidate);
    } catch (error) {
      failures.push(`${candidate}: ${error.code ?? error.message}`);
    }
  }
  throw new Error(`desktop-mcp: koffi not loadable (${failures.join(' | ')})`);
}

const koffi = loadKoffi();
const user32 = koffi.load('user32.dll');
const gdi32 = koffi.load('gdi32.dll');

// ---------------------------------------------------------------- Win32 types
const RECT = koffi.struct('RECT', { left: 'int', top: 'int', right: 'int', bottom: 'int' });
const POINT = koffi.struct('POINT', { x: 'int', y: 'int' });
const BITMAPINFOHEADER = koffi.struct('BITMAPINFOHEADER', {
  biSize: 'uint32',
  biWidth: 'int32',
  biHeight: 'int32',
  biPlanes: 'uint16',
  biBitCount: 'uint16',
  biCompression: 'uint32',
  biSizeImage: 'uint32',
  biXPelsPerMeter: 'int32',
  biYPelsPerMeter: 'int32',
  biClrUsed: 'uint32',
  biClrImportant: 'uint32',
});
// One flattened INPUT for keyboard input: type, pad, KEYBDINPUT, tail pad.
// `cbSize` must equal sizeof(INPUT) — 40 on x64, because the union is sized by
// MOUSEINPUT — so the tail field is real padding, not decoration.
const KEYINPUT = koffi.struct('KEYINPUT', {
  type: 'uint32',
  pad: 'uint32',
  wVk: 'uint16',
  wScan: 'uint16',
  dwFlags: 'uint32',
  time: 'uint32',
  dwExtraInfo: 'intptr',
  tail: 'uint32',
});
const INPUT_SIZE = koffi.sizeof(KEYINPUT);
const WNDENUMPROC = koffi.proto('bool WNDENUMPROC(intptr hwnd, intptr lParam)');

// ------------------------------------------------------------------ Win32 fns
const GetSystemMetrics = user32.func('int GetSystemMetrics(int nIndex)');
const EnumWindows = user32.func('bool EnumWindows(WNDENUMPROC *lpEnumFunc, intptr lParam)');
const IsWindowVisible = user32.func('bool IsWindowVisible(intptr hWnd)');
const IsIconic = user32.func('bool IsIconic(intptr hWnd)');
const GetWindowRect = user32.func('bool GetWindowRect(intptr hWnd, _Out_ RECT *lpRect)');
const GetWindowTextW = user32.func('int GetWindowTextW(intptr hWnd, void *lpString, int nMaxCount)');
const GetWindowThreadProcessId = user32.func('uint32 GetWindowThreadProcessId(intptr hWnd, _Out_ uint32 *lpdwProcessId)');
const GetWindowLongPtrW = user32.func('intptr GetWindowLongPtrW(intptr hWnd, int nIndex)');
const GetCurrentThreadId = koffi.load('kernel32.dll').func('uint32 GetCurrentThreadId()');
const AttachThreadInput = user32.func('bool AttachThreadInput(uint32 idAttach, uint32 idAttachTo, bool fAttach)');
const BringWindowToTop = user32.func('bool BringWindowToTop(intptr hWnd)');
const GetForegroundWindow = user32.func('intptr GetForegroundWindow()');
const SetForegroundWindow = user32.func('bool SetForegroundWindow(intptr hWnd)');
const ShowWindow = user32.func('bool ShowWindow(intptr hWnd, int nCmdShow)');
const PrintWindow = user32.func('bool PrintWindow(intptr hWnd, intptr hdcBlt, uint nFlags)');
const SetCursorPos = user32.func('bool SetCursorPos(int X, int Y)');
const GetCursorPos = user32.func('bool GetCursorPos(_Out_ POINT *lpPoint)');
const mouse_event = user32.func('void mouse_event(uint dwFlags, int dx, int dy, uint dwData, intptr dwExtraInfo)');
const keybd_event = user32.func('void keybd_event(uint bVk, uint bScan, uint dwFlags, intptr dwExtraInfo)');
const SendInput = user32.func('uint SendInput(uint cInputs, _In_ KEYINPUT *pInputs, int cbSize)');
const GetDC = user32.func('intptr GetDC(intptr hWnd)');
const ReleaseDC = user32.func('int ReleaseDC(intptr hWnd, intptr hDC)');
const CreateCompatibleDC = gdi32.func('intptr CreateCompatibleDC(intptr hdc)');
const CreateCompatibleBitmap = gdi32.func('intptr CreateCompatibleBitmap(intptr hdc, int cx, int cy)');
const SelectObject = gdi32.func('intptr SelectObject(intptr hdc, intptr h)');
const DeleteObject = gdi32.func('int DeleteObject(intptr ho)');
const DeleteDC = gdi32.func('int DeleteDC(intptr hdc)');
const GetDIBits = gdi32.func('int GetDIBits(intptr hdc, intptr hbm, uint start, uint cLines, void *lpvBits, _Inout_ BITMAPINFOHEADER *lpbmi, uint usage)');
const SetDIBits = gdi32.func('int SetDIBits(intptr hdc, intptr hbm, uint start, uint cLines, void *lpBits, _In_ BITMAPINFOHEADER *lpbmi, uint usage)');
const BitBlt = gdi32.func('bool BitBlt(intptr hdc, int x, int y, int cx, int cy, intptr hdcSrc, int x1, int y1, uint rop)');
const StretchBlt = gdi32.func('bool StretchBlt(intptr hdcDest, int xDest, int yDest, int wDest, int hDest, intptr hdcSrc, int xSrc, int ySrc, int wSrc, int hSrc, uint rop)');
const SetStretchBltMode = gdi32.func('int SetStretchBltMode(intptr hdc, int mode)');

const SRCCOPY = 0x00cc0020;
const HALFTONE = 4;
const PW_RENDERFULLCONTENT = 2;
const GWL_EXSTYLE = -20;
const WS_EX_TOOLWINDOW = 0x00000080;
const FLAG_MOVE = 0x0001;
const FLAG_LEFTDOWN = 0x0002;
const FLAG_LEFTUP = 0x0004;
const FLAG_RIGHTDOWN = 0x0008;
const FLAG_RIGHTUP = 0x0010;
const FLAG_MIDDLEDOWN = 0x0020;
const FLAG_MIDDLEUP = 0x0040;
const FLAG_WHEEL = 0x0800;
const FLAG_HWHEEL = 0x1000;
const KEYEVENTF_KEYUP = 0x0002;
const KEYEVENTF_UNICODE = 0x0004;

// ------------------------------------------------------------------ PNG writer
const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buffer) {
  let c = 0xffffffff;
  for (let i = 0; i < buffer.length; i += 1) c = CRC_TABLE[(c ^ buffer[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([length, body, crc]);
}

/** Encode top-down RGBA bytes as a PNG. */
function encodePng(rgba, width, height) {
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y += 1) {
    raw[y * (stride + 1)] = 0;
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', deflateSync(raw, { level: 6 })),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

// ------------------------------------------------------------------- capture
/**
 * Whether a captured buffer is essentially one flat colour — a window that
 * answered PrintWindow but painted nothing (composition-rendered apps: the new
 * Notepad, most UWP windows). A thin frame may still differ, so the test asks
 * whether one sampled colour dominates, not whether every sample matches.
 */
function looksBlank(rgba, width, height) {
  const stepX = Math.max(1, Math.floor(width / 16));
  const stepY = Math.max(1, Math.floor(height / 16));
  const counts = new Map();
  let total = 0;
  for (let y = 0; y < height; y += stepY) {
    for (let x = 0; x < width; x += stepX) {
      const value = rgba.readUInt32LE((y * width + x) * 4) & 0x00ffffff;
      counts.set(value, (counts.get(value) ?? 0) + 1);
      total += 1;
    }
  }
  let dominant = 0;
  for (const count of counts.values()) if (count > dominant) dominant = count;
  return total === 0 || dominant / total >= 0.9;
}

/** Whether the window lies entirely inside the primary display. */
function isOnScreen(rect) {
  return (
    rect.left >= 0 &&
    rect.top >= 0 &&
    rect.width > 0 &&
    rect.height > 0 &&
    rect.left + rect.width <= PRIMARY.width &&
    rect.top + rect.height <= PRIMARY.height
  );
}

/**
 * Render a window (or the desktop when `hwnd` is 0) into a top-down RGBA buffer.
 *
 * Modern (composition-rendered) windows — the new Notepad, most UWP apps — can
 * answer PrintWindow successfully while painting nothing. Uniform output from a
 * window that is fully on screen is therefore re-read from the screen instead.
 *
 * @returns {{width:number,height:number,rgba:Buffer,source:string}}
 */
function captureRgba(hwnd, x, y, width, height) {
  if (hwnd !== 0) {
    const rect = readWindowRect(hwnd);
    const viaPrintWindow = grabRgba(width, height, (memDc, screenDc) => PrintWindow(hwnd, memDc, PW_RENDERFULLCONTENT), 'window');
    if (!looksBlank(viaPrintWindow.rgba, width, height)) return viaPrintWindow;
    if (isOnScreen(rect)) return grabRgba(width, height, (memDc, screenDc) => BitBlt(memDc, 0, 0, width, height, screenDc, rect.left, rect.top, SRCCOPY), 'screen-fallback');
    return { ...viaPrintWindow, source: 'window-blank' };
  }
  return grabRgba(width, height, (memDc, screenDc) => BitBlt(memDc, 0, 0, width, height, screenDc, x, y, SRCCOPY), 'screen');
}

/** Run one GDI capture into a compatible bitmap and read it back as RGBA. */
function grabRgba(width, height, paint, source) {
  const screenDc = GetDC(0);
  if (screenDc === 0) throw new Error('desktop-mcp: GetDC failed');
  const memDc = CreateCompatibleDC(screenDc);
  const bitmap = CreateCompatibleBitmap(screenDc, width, height);
  if (memDc === 0 || bitmap === 0) {
    ReleaseDC(0, screenDc);
    throw new Error('desktop-mcp: GDI bitmap allocation failed');
  }
  const previous = SelectObject(memDc, bitmap);
  try {
    paint(memDc, screenDc);

    const header = {
      biSize: 40,
      biWidth: width,
      biHeight: -height,
      biPlanes: 1,
      biBitCount: 32,
      biCompression: 0,
      biSizeImage: width * height * 4,
      biXPelsPerMeter: 0,
      biYPelsPerMeter: 0,
      biClrUsed: 0,
      biClrImportant: 0,
    };
    const pixels = Buffer.alloc(width * height * 4);
    const lines = GetDIBits(memDc, bitmap, 0, height, pixels, header, 0);
    if (lines === 0) throw new Error('desktop-mcp: GetDIBits returned no scan lines');
    // DIB rows arrive BGRA with an undefined alpha channel; PNG wants opaque RGBA.
    for (let i = 0; i < pixels.length; i += 4) {
      const b = pixels[i];
      pixels[i] = pixels[i + 2];
      pixels[i + 2] = b;
      pixels[i + 3] = 255;
    }
    return { width, height, rgba: pixels, source };
  } finally {
    SelectObject(memDc, previous);
    DeleteObject(bitmap);
    DeleteDC(memDc);
    ReleaseDC(0, screenDc);
  }
}

/** Crop and optionally downscale a captured RGBA image. */
function transformRgba(image, region, scale) {
  let { width, height, rgba } = image;
  let x = 0;
  let y = 0;
  if (region && (region.width > 0 || region.height > 0)) {
    x = Math.max(0, Math.min(Math.trunc(region.x ?? 0), width - 1));
    y = Math.max(0, Math.min(Math.trunc(region.y ?? 0), height - 1));
    width = Math.max(1, Math.min(Math.trunc(region.width ?? width), image.width - x));
    height = Math.max(1, Math.min(Math.trunc(region.height ?? height), image.height - y));
    const cropped = Buffer.alloc(width * height * 4);
    for (let row = 0; row < height; row += 1) {
      rgba.copy(cropped, row * width * 4, ((y + row) * image.width + x) * 4, ((y + row) * image.width + x + width) * 4);
    }
    rgba = cropped;
  }
  const factor = Number(scale ?? 1);
  if (!(factor > 0) || factor === 1) return { width, height, rgba, rgbaOffset: { x, y } };

  const targetWidth = Math.max(1, Math.round(width * factor));
  const targetHeight = Math.max(1, Math.round(height * factor));
  const source = { width, height, rgba };
  const screenDc = GetDC(0);
  const memDc = CreateCompatibleDC(screenDc);
  const bitmap = CreateCompatibleBitmap(screenDc, targetWidth, targetHeight);
  const previous = SelectObject(memDc, bitmap);
  try {
    // Rebuild the source as a DIB through a second memory DC, then StretchBlt.
    const srcDc = CreateCompatibleDC(screenDc);
    const srcBitmap = CreateCompatibleBitmap(screenDc, width, height);
    const srcPrevious = SelectObject(srcDc, srcBitmap);
    try {
      const bgra = Buffer.from(source.rgba);
      for (let i = 0; i < bgra.length; i += 4) {
        const r = bgra[i];
        bgra[i] = bgra[i + 2];
        bgra[i + 2] = r;
      }
      const header = {
        biSize: 40,
        biWidth: width,
        biHeight: -height,
        biPlanes: 1,
        biBitCount: 32,
        biCompression: 0,
        biSizeImage: width * height * 4,
        biXPelsPerMeter: 0,
        biYPelsPerMeter: 0,
        biClrUsed: 0,
        biClrImportant: 0,
      };
      SetDIBits(srcDc, srcBitmap, 0, height, bgra, header, 0);
      SetStretchBltMode(memDc, HALFTONE);
      StretchBlt(memDc, 0, 0, targetWidth, targetHeight, srcDc, 0, 0, width, height, SRCCOPY);

      const outHeader = { ...header, biWidth: targetWidth, biHeight: -targetHeight, biSizeImage: targetWidth * targetHeight * 4 };
      const out = Buffer.alloc(targetWidth * targetHeight * 4);
      GetDIBits(memDc, bitmap, 0, targetHeight, out, outHeader, 0);
      for (let i = 0; i < out.length; i += 4) {
        const b = out[i];
        out[i] = out[i + 2];
        out[i + 2] = b;
        out[i + 3] = 255;
      }
      return { width: targetWidth, height: targetHeight, rgba: out, rgbaOffset: { x, y } };
    } finally {
      SelectObject(srcDc, srcPrevious);
      DeleteObject(srcBitmap);
      DeleteDC(srcDc);
    }
  } finally {
    SelectObject(memDc, previous);
    DeleteObject(bitmap);
    DeleteDC(memDc);
    ReleaseDC(0, screenDc);
  }
}

// ------------------------------------------------------------------- windows
function readWindowRect(hwnd) {
  const rect = {};
  if (!GetWindowRect(hwnd, rect)) return { left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 };
  return { ...rect, width: rect.right - rect.left, height: rect.bottom - rect.top };
}

function windowTitle(hwnd) {
  const buffer = Buffer.alloc(1024);
  const length = GetWindowTextW(hwnd, buffer, 512);
  if (length <= 0) return '';
  return buffer.toString('utf16le', 0, length * 2);
}

function listWindows() {
  const foreground = GetForegroundWindow();
  const found = [];
  const callback = koffi.register((hwnd) => {
    if (!IsWindowVisible(hwnd)) return true;
    const style = GetWindowLongPtrW(hwnd, GWL_EXSTYLE);
    if ((style & WS_EX_TOOLWINDOW) !== 0 && hwnd !== foreground) return true;
    const title = windowTitle(hwnd);
    const rect = readWindowRect(hwnd);
    if (title === '' && hwnd !== foreground) return true;
    if (rect.width <= 0 || rect.height <= 0) return true;
    if (rect.left <= -30000 || rect.top <= -30000) return true; // minimized
    // koffi marshals scalar out-parameters through a one-element array.
    const pid = [0];
    GetWindowThreadProcessId(hwnd, pid);
    found.push({
      id: Number(hwnd),
      title,
      pid: pid[0] ?? 0,
      rect: { x: rect.left, y: rect.top, width: rect.width, height: rect.height },
      minimized: IsIconic(hwnd),
      focused: hwnd === foreground,
    });
    return true;
  }, koffi.pointer(WNDENUMPROC));
  try {
    EnumWindows(callback, 0);
  } finally {
    koffi.unregister(callback);
  }
  return found;
}

/**
 * Bring a window to the foreground.
 *
 * Windows refuses SetForegroundWindow from a process that owns no foreground
 * window, so the calling thread is first attached to the current foreground
 * thread's input queue — the documented way to make the request legitimate —
 * and detached again afterwards.
 */
function focusWindow(hwnd) {
  if (IsIconic(hwnd)) ShowWindow(hwnd, 9);
  const targetThread = GetWindowThreadProcessId(hwnd, [0]);
  const foreground = GetForegroundWindow();
  const foregroundThread = foreground === 0 ? 0 : GetWindowThreadProcessId(foreground, [0]);
  const selfThread = GetCurrentThreadId();
  let attached = false;
  if (foregroundThread !== 0 && foregroundThread !== selfThread) {
    attached = AttachThreadInput(foregroundThread, selfThread, true);
  }
  try {
    ShowWindow(hwnd, 5);
    BringWindowToTop(hwnd);
    SetForegroundWindow(hwnd);
    sleep(140);
    return GetForegroundWindow() === Number(hwnd) || GetForegroundWindow() === hwnd;
  } finally {
    if (attached) AttachThreadInput(foregroundThread, selfThread, false);
  }
}

function resolveWindow(selector) {
  if (selector === undefined || selector === null || selector === '') return 0;
  const windows = listWindows();
  if (typeof selector === 'number' || /^\d+$/.test(String(selector))) {
    const id = Number(selector);
    const exact = windows.find((window) => window.id === id);
    if (!exact) throw new Error(`desktop-mcp: no visible window with id ${id}`);
    return exact.id;
  }
  const needle = String(selector).toLowerCase();
  const match =
    windows.find((window) => window.title.toLowerCase() === needle) ??
    windows.find((window) => window.title.toLowerCase().includes(needle));
  if (!match) throw new Error(`desktop-mcp: no visible window whose title contains "${selector}"`);
  return match.id;
}

// --------------------------------------------------------------------- input
function moveMouse(x, y) {
  if (!SetCursorPos(Math.round(x), Math.round(y))) throw new Error('desktop-mcp: SetCursorPos failed');
}

function clickMouse(x, y, button, count) {
  if (x !== undefined && y !== undefined) moveMouse(x, y);
  const down = button === 'right' ? FLAG_RIGHTDOWN : button === 'middle' ? FLAG_MIDDLEDOWN : FLAG_LEFTDOWN;
  const up = button === 'right' ? FLAG_RIGHTUP : button === 'middle' ? FLAG_MIDDLEUP : FLAG_LEFTUP;
  for (let i = 0; i < count; i += 1) {
    mouse_event(down, 0, 0, 0, 0);
    mouse_event(up, 0, 0, 0, 0);
    if (count > 1) sleep(60);
  }
}

function dragMouse(fromX, fromY, toX, toY, button) {
  moveMouse(fromX, fromY);
  sleep(60);
  const down = button === 'right' ? FLAG_RIGHTDOWN : button === 'middle' ? FLAG_MIDDLEDOWN : FLAG_LEFTDOWN;
  const up = button === 'right' ? FLAG_RIGHTUP : button === 'middle' ? FLAG_MIDDLEUP : FLAG_LEFTUP;
  mouse_event(down, 0, 0, 0, 0);
  const steps = 24;
  for (let step = 1; step <= steps; step += 1) {
    const t = step / steps;
    moveMouse(fromX + (toX - fromX) * t, fromY + (toY - fromY) * t);
    sleep(8);
  }
  mouse_event(up, 0, 0, 0, 0);
}

const VK = {
  backspace: 0x08, tab: 0x09, enter: 0x0d, return: 0x0d, shift: 0x10, ctrl: 0x11, control: 0x11,
  alt: 0x12, pause: 0x13, capslock: 0x14, esc: 0x1b, escape: 0x1b, space: 0x20, pageup: 0x21,
  pagedown: 0x22, end: 0x23, home: 0x24, left: 0x25, up: 0x26, right: 0x27, down: 0x28,
  insert: 0x2d, delete: 0x2e, del: 0x2e, win: 0x5b, meta: 0x5b, printscreen: 0x2c,
  numpad0: 0x60, numpad1: 0x61, numpad2: 0x62, numpad3: 0x63, numpad4: 0x64, numpad5: 0x65,
  numpad6: 0x66, numpad7: 0x67, numpad8: 0x68, numpad9: 0x69,
};
for (let i = 0; i < 26; i += 1) VK[String.fromCharCode(97 + i)] = 0x41 + i;
for (let i = 0; i < 10; i += 1) VK[String(i)] = 0x30 + i;
for (let i = 1; i <= 24; i += 1) VK[`f${i}`] = 0x6f + i;

function virtualKey(name) {
  const key = String(name).trim().toLowerCase();
  if (Object.prototype.hasOwnProperty.call(VK, key)) return VK[key];
  if (key.length === 1) {
    const code = key.toUpperCase().charCodeAt(0);
    if (code >= 0x30 && code <= 0x5a) return code;
  }
  throw new Error(`desktop-mcp: unknown key "${name}"`);
}

function pressKeys(keys) {
  const list = (Array.isArray(keys) ? keys : String(keys).split('+')).map((key) => String(key).trim()).filter(Boolean);
  if (list.length === 0) throw new Error('desktop-mcp: no keys given');
  const codes = list.map(virtualKey);
  for (const code of codes) keybd_event(code, 0, 0, 0);
  for (const code of [...codes].reverse()) keybd_event(code, 0, KEYEVENTF_KEYUP, 0);
}

/**
 * Type arbitrary text (including CJK) with KEYEVENTF_UNICODE inputs.
 *
 * Inputs are batched into one SendInput call per chunk: one call per character
 * floods the target's message queue and silently drops the tail, which is what
 * an editor shows as a half-typed line.
 * @returns number of characters submitted
 */
function typeText(text) {
  const inputs = [];
  for (const unit of Array.from(String(text))) {
    const utf16 = Buffer.from(unit, 'utf16le');
    for (let i = 0; i < utf16.length; i += 2) {
      const scan = utf16.readUInt16LE(i);
      inputs.push(
        { type: 1, pad: 0, wVk: 0, wScan: scan, dwFlags: KEYEVENTF_UNICODE, time: 0, dwExtraInfo: 0, tail: 0 },
        { type: 1, pad: 0, wVk: 0, wScan: scan, dwFlags: KEYEVENTF_UNICODE | KEYEVENTF_KEYUP, time: 0, dwExtraInfo: 0, tail: 0 },
      );
    }
  }
  for (let offset = 0; offset < inputs.length; offset += 64) {
    const chunk = inputs.slice(offset, offset + 64);
    const sent = SendInput(chunk.length, chunk, INPUT_SIZE);
    if (sent !== chunk.length) throw new Error(`desktop-mcp: SendInput accepted ${sent}/${chunk.length} keyboard inputs`);
    sleep(6);
  }
  return inputs.length / 2;
}

/** Resolve which window input will land in, focusing an explicitly named one. */
function ensureInputTarget(selector) {
  if (selector === undefined || selector === null || selector === '') {
    const hwnd = Number(GetForegroundWindow());
    return { hwnd, title: hwnd === 0 ? '(none)' : windowTitle(hwnd) };
  }
  const hwnd = resolveWindow(selector);
  const focused = focusWindow(hwnd);
  if (!focused) throw new Error(`desktop-mcp: could not focus "${selector}" — refusing to type blindly`);
  return { hwnd, title: windowTitle(hwnd) };
}

function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

// ------------------------------------------------------------------ registry
const PRIMARY = { width: GetSystemMetrics(0), height: GetSystemMetrics(1) };

const TOOLS = [
  {
    name: 'screen_info',
    description: 'Report the primary display size and the current cursor position.',
    inputSchema: { type: 'object', properties: {} },
    handler: () => {
      const position = {};
      GetCursorPos(position);
      return text(`display ${PRIMARY.width}x${PRIMARY.height}; cursor ${position.x},${position.y}`);
    },
  },
  {
    name: 'windows_list',
    description: 'List visible top-level windows with their id, title, pid and rectangle. Use an id with screen_shot or window_focus.',
    inputSchema: {
      type: 'object',
      properties: { title: { type: 'string', description: 'Optional case-insensitive title filter.' } },
    },
    handler: (args) => {
      const needle = typeof args.title === 'string' ? args.title.toLowerCase() : '';
      const windows = listWindows().filter((window) => needle === '' || window.title.toLowerCase().includes(needle));
      if (windows.length === 0) return text('no matching windows');
      return text(windows.map((window) => `${window.id}\t${window.rect.x},${window.rect.y} ${window.rect.width}x${window.rect.height}\tpid ${window.pid}\t${window.focused ? '[focused] ' : ''}${window.title}`).join('\n'));
    },
  },
  {
    name: 'screen_shot',
    description: 'Capture a PNG. With window omitted it captures the desktop; with a window id or title fragment it renders that window (works while occluded). Optional region crops, scale downscales, inline also returns the image itself.',
    inputSchema: {
      type: 'object',
      properties: {
        window: { type: 'string', description: 'Window id (from windows_list) or a title fragment. Omit for the whole desktop.' },
        region: {
          type: 'object',
          description: 'Crop rectangle in captured-image pixels.',
          properties: { x: { type: 'number' }, y: { type: 'number' }, width: { type: 'number' }, height: { type: 'number' } },
        },
        scale: { type: 'number', description: 'Scale factor, e.g. 0.5 to halve. Defaults to 1.' },
        inline: { type: 'boolean', description: 'Also return the image itself (defaults to false; prefer the file path for large screens).' },
        path: { type: 'string', description: 'Optional absolute PNG path to write instead of the default temp path.' },
        settle_ms: { type: 'number', description: 'Wait this many milliseconds before capturing (max 5000). Input and animations settle asynchronously, so a shot taken right after typing can miss the tail.' },
      },
    },
    handler: (args) => {
      const settle = Math.max(0, Math.min(Math.trunc(args.settle_ms ?? 0), 5000));
      if (settle > 0) sleep(settle);
      const target = resolveWindow(args.window);
      let capture;
      if (target !== 0) {
        const rect = readWindowRect(target);
        capture = captureRgba(target, rect.left, rect.top, rect.width, rect.height);
      } else {
        capture = captureRgba(0, 0, 0, PRIMARY.width, PRIMARY.height);
      }
      const result = transformRgba(capture, args.region, args.scale);
      const png = encodePng(result.rgba, result.width, result.height);
      const outPath = typeof args.path === 'string' && args.path !== '' ? args.path : defaultShotPath();
      mkdirSync(dirname(outPath), { recursive: true });
      writeFileSync(outPath, png);
      const summary = `captured ${result.width}x${result.height} via ${capture.source} -> ${outPath} (${(png.length / 1024).toFixed(1)} KiB)`;
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
    name: 'window_focus',
    description: 'Bring a window to the foreground (restoring it first if minimized).',
    inputSchema: { type: 'object', properties: { window: { type: 'string', description: 'Window id or title fragment.' } }, required: ['window'] },
    handler: (args) => {
      const hwnd = resolveWindow(args.window);
      const focused = focusWindow(hwnd);
      return text(`${focused ? 'focused' : 'could not confirm focus for'} ${hwnd} — ${windowTitle(hwnd)}`);
    },
  },
  {
    name: 'mouse_move',
    description: 'Move the pointer to absolute screen coordinates.',
    inputSchema: { type: 'object', properties: { x: { type: 'number' }, y: { type: 'number' } }, required: ['x', 'y'] },
    handler: (args) => {
      moveMouse(args.x, args.y);
      return text(`cursor at ${Math.round(args.x)},${Math.round(args.y)}`);
    },
  },
  {
    name: 'mouse_click',
    description: 'Click a mouse button, optionally moving to (x, y) first.',
    inputSchema: {
      type: 'object',
      properties: {
        x: { type: 'number' },
        y: { type: 'number' },
        button: { type: 'string', enum: ['left', 'right', 'middle'] },
        count: { type: 'number', description: 'Number of clicks, e.g. 2 for a double click.' },
      },
    },
    handler: (args) => {
      const count = Math.max(1, Math.trunc(args.count ?? 1));
      clickMouse(args.x, args.y, args.button ?? 'left', count);
      return text(`clicked ${args.button ?? 'left'} x${count}${args.x !== undefined ? ` at ${Math.round(args.x)},${Math.round(args.y)}` : ''}`);
    },
  },
  {
    name: 'mouse_drag',
    description: 'Press, drag along a straight path, and release — for sliders, canvas drawing, or selecting text.',
    inputSchema: {
      type: 'object',
      properties: {
        from_x: { type: 'number' }, from_y: { type: 'number' }, to_x: { type: 'number' }, to_y: { type: 'number' },
        button: { type: 'string', enum: ['left', 'right', 'middle'] },
      },
      required: ['from_x', 'from_y', 'to_x', 'to_y'],
    },
    handler: (args) => {
      dragMouse(args.from_x, args.from_y, args.to_x, args.to_y, args.button ?? 'left');
      return text(`dragged ${args.from_x},${args.from_y} -> ${args.to_x},${args.to_y}`);
    },
  },
  {
    name: 'mouse_scroll',
    description: 'Scroll the wheel at the current (or given) position. Positive delta scrolls up.',
    inputSchema: { type: 'object', properties: { delta: { type: 'number' }, x: { type: 'number' }, y: { type: 'number' } }, required: ['delta'] },
    handler: (args) => {
      if (args.x !== undefined && args.y !== undefined) moveMouse(args.x, args.y);
      const notches = Math.trunc(args.delta);
      const steps = Math.min(Math.abs(notches), 40);
      for (let i = 0; i < steps; i += 1) {
        mouse_event(FLAG_WHEEL, 0, 0, (Math.sign(notches) * 120) >>> 0, 0);
        sleep(12);
      }
      return text(`scrolled ${notches} notch(es)`);
    },
  },
  {
    name: 'key_press',
    description: 'Press a key or chord: "enter", "esc", "ctrl+c", "alt+tab", "f5". Optionally name the window that should receive it.',
    inputSchema: {
      type: 'object',
      properties: {
        keys: { type: 'string', description: 'Key or "+"-joined chord.' },
        window: { type: 'string', description: 'Window id or title fragment to focus first. Omit to use the current foreground window.' },
      },
      required: ['keys'],
    },
    handler: (args) => {
      const target = ensureInputTarget(args.window);
      pressKeys(args.keys);
      const label = Array.isArray(args.keys) ? args.keys.join('+') : args.keys;
      return text(`pressed ${label} in "${target.title}"`);
    },
  },
  {
    name: 'type_text',
    description: 'Type arbitrary text (Unicode included) into a window. Name the window to focus it first; omitting it types into whatever is focused and reports where the text landed.',
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string' },
        window: { type: 'string', description: 'Window id or title fragment to focus first.' },
      },
      required: ['text'],
    },
    handler: (args) => {
      const target = ensureInputTarget(args.window);
      const typed = typeText(args.text);
      return text(`typed ${typed} character(s) into "${target.title}"`);
    },
  },
];

function defaultShotPath() {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  return join(tmpdir(), 'dsh-desktop-mcp', `shot-${stamp}.png`);
}

function text(value) {
  return { content: [{ type: 'text', text: value }] };
}

function handleTool(name, args) {
  const tool = TOOLS.find((candidate) => candidate.name === name);
  if (!tool) throw new Error(`desktop-mcp: unknown tool "${name}"`);
  return tool.handler(args ?? {});
}

// ------------------------------------------------------------ MCP stdio loop
const SUPPORTED_PROTOCOLS = ['2025-06-18', '2025-03-26', '2024-11-05', '2024-10-07'];

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function handleMessage(message) {
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
        serverInfo: { name: 'desktop-mcp', version: '1.0.0' },
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
      result: {
        tools: TOOLS.map((tool) => ({ name: tool.name, description: tool.description, inputSchema: tool.inputSchema })),
      },
    });
    return;
  }
  if (method === 'tools/call') {
    try {
      const result = handleTool(params?.name, params?.arguments);
      send({ jsonrpc: '2.0', id, result: { ...result, isError: false } });
    } catch (error) {
      send({
        jsonrpc: '2.0',
        id,
        result: { content: [{ type: 'text', text: String(error?.message ?? error) }], isError: true },
      });
    }
    return;
  }
  if (id !== undefined) {
    send({ jsonrpc: '2.0', id, error: { code: -32601, message: `desktop-mcp: unsupported method "${method}"` } });
  }
}

function main() {
  let buffered = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => {
    buffered += chunk;
    let index = buffered.indexOf('\n');
    while (index >= 0) {
      const line = buffered.slice(0, index).trim();
      buffered = buffered.slice(index + 1);
      if (line !== '') {
        try {
          handleMessage(JSON.parse(line));
        } catch (error) {
          send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: String(error?.message ?? error) } });
        }
      }
      index = buffered.indexOf('\n');
    }
  });
  process.stdin.on('end', () => process.exit(0));
}

// `--selftest` exercises every primitive without an MCP client attached.
function selftest() {
  const report = {};
  report.loaded = { koffi: koffi.version ?? 'unknown', display: `${PRIMARY.width}x${PRIMARY.height}` };
  const windows = listWindows();
  report.windows = windows.length;
  report.foreground = windows.find((window) => window.focused)?.title ?? null;
  const shot = captureRgba(0, 0, 0, 200, 120);
  report.screenCapture = { source: shot.source, width: shot.width, height: shot.height };
  const nonUniform = new Set();
  for (let i = 0; i < shot.rgba.length; i += 4 * 37) nonUniform.add(shot.rgba[i]);
  report.screenCaptureDistinctValues = nonUniform.size;
  const scaled = transformRgba(shot, { x: 10, y: 10, width: 100, height: 60 }, 0.5);
  report.scale = `${scaled.width}x${scaled.height}`;
  const png = encodePng(shot.rgba, shot.width, shot.height);
  report.png = { bytes: png.length, magic: png.subarray(0, 8).toString('hex') };
  const position = {};
  GetCursorPos(position);
  report.cursor = `${position.x},${position.y}`;
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

// Reused by the native Cordis front-end (`index.js`) as well as this stdio one.
export { TOOLS, handleTool };

// Only run a front-end when this file is the process entry point, so importing
// it as a library never starts a server.
const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  if (process.argv.includes('--selftest')) selftest();
  else main();
}
