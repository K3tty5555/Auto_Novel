#!/usr/bin/env bun
/**
 * fanqie-publish.ts — 发布单章到番茄小说
 *
 * Usage:
 *   bun fanqie-publish.ts --md-file novels/xxx/chapters/ch048_xxx.md [--time 16:00] [--date 2024-01-15]
 *   bun fanqie-publish.ts --md-file ch048.md --title "第48章 宋缺的剑" --time 16:30
 *
 * The script:
 *   1. Reads and cleans the .md chapter file (strips Markdown formatting)
 *   2. Connects to / launches Chrome with a dedicated fanqie profile
 *   3. Opens the 番茄小说 chapter creation page in a new tab
 *   4. Fills the title, pastes the content, sets scheduled time, saves draft
 */

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import {
  CdpConnection,
  findChromeExecutable,
  getFreePort,
  resolveSharedChromeProfileDir,
  sleep,
} from './vendor/baoyu-chrome-cdp/index.ts';

// ─── Constants ────────────────────────────────────────────────────────────────

const BOOK_ID = '7615507515849067544';
const PUBLISH_URL = `https://fanqienovel.com/main/writer/${BOOK_ID}/publish/?enter_from=newchapter_0`;

const CHROME_CANDIDATES = {
  darwin: [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
  ],
  win32: ['C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'],
  default: ['/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser'],
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

function getProfileDir(): string {
  return resolveSharedChromeProfileDir({
    envNames: ['FANQIE_CHROME_PROFILE_DIR'],
    appDataDirName: 'baoyu-fanqie',
    profileDirName: 'chrome-profile',
  });
}

function getTodayDate(): string {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/** Strip Markdown formatting from a chapter .md file.
 *  Returns { title, content } where content is plain text ready for 番茄小说. */
function cleanMarkdown(raw: string): { chapterTitle: string; content: string } {
  const lines = raw.split('\n');
  let chapterTitle = '';
  const out: string[] = [];

  for (const line of lines) {
    // Extract title text from "# 第X章/第四十八章 标题" — chapterNum comes from filename
    const titleMatch = line.match(/^#\s+第[^章回]*[章回]\s*(.*)$/);
    if (titleMatch) {
      chapterTitle = titleMatch[1]!.trim();
      continue; // don't include heading in body
    }
    // Skip metadata line: > 字数：约XXXX字 | 写作日期：...
    if (/^>\s*字数[：:]\s*约\d+字/.test(line)) continue;
    // Other headings → plain text
    if (/^#{1,3}\s+/.test(line)) {
      out.push(line.replace(/^#{1,3}\s+/, ''));
      continue;
    }
    // Horizontal rule → blank line
    if (/^-{3,}$/.test(line.trim())) {
      out.push('');
      continue;
    }
    // Strip blockquote marker
    let l = line.startsWith('> ') ? line.slice(2) : line;
    // Strip bold / italic
    l = l.replace(/\*\*(.+?)\*\*/g, '$1');
    l = l.replace(/\*(.+?)\*/g, '$1');
    l = l.replace(/__(.+?)__/g, '$1');
    out.push(l);
  }

  // Normalize: collapse 3+ consecutive blank lines to 2
  const normalized = out
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  return { chapterTitle, content: normalized };
}

function copyToClipboard(text: string): void {
  spawnSync('pbcopy', [], {
    input: text,
    encoding: 'utf-8',
    stdio: ['pipe', 'inherit', 'inherit'],
  });
}

function pasteToChrome(): boolean {
  if (process.platform !== 'darwin') return false;
  const script = `
    tell application "Google Chrome"
      activate
    end tell
    delay 0.5
    tell application "System Events"
      keystroke "a" using command down
      delay 0.2
      keystroke "v" using command down
    end tell
  `;
  const result = spawnSync('osascript', ['-e', script], { stdio: 'pipe' });
  return result.status === 0;
}

/** Wait until expression returns truthy. */
async function waitFor(
  cdp: CdpConnection,
  sessionId: string,
  expression: string,
  timeoutMs = 30_000,
  pollMs = 500,
): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const r = await cdp.send<{ result: { value: boolean } }>(
        'Runtime.evaluate',
        { expression, returnByValue: true },
        // Per-poll timeout must be shorter than outer timeoutMs so the loop can iterate.
        { sessionId, timeoutMs: Math.min(pollMs * 3, 5_000) },
      );
      if (r.result.value) return true;
    } catch {}
    await sleep(pollMs);
  }
  return false;
}

/** Evaluate and return the value. */
async function evalVal<T>(
  cdp: CdpConnection,
  sessionId: string,
  expression: string,
): Promise<T> {
  const r = await cdp.send<{ result: { value: T } }>(
    'Runtime.evaluate',
    { expression, returnByValue: true },
    { sessionId },
  );
  return r.result.value;
}

/** Find existing Chrome debug port using curl (avoids Bun fetch() empty body bug).
 *  Reads DevToolsActivePort file, then falls back to ps aux. */
function findExistingChromeDebugPortCurl(profileDir: string): number | null {
  // Method 1: DevToolsActivePort file
  try {
    const content = fs.readFileSync(path.join(profileDir, 'DevToolsActivePort'), 'utf-8');
    const port = parseInt(content.split(/\r?\n/)[0]?.trim() ?? '', 10);
    if (port > 0) {
      const r = spawnSync('curl', ['--silent', '--max-time', '2', `http://127.0.0.1:${port}/json/version`], { encoding: 'utf-8', timeout: 3_000 });
      if (r.status === 0 && r.stdout?.includes('webSocketDebuggerUrl')) return port;
    }
  } catch {}

  // Method 2: ps aux — find Chrome with this profile
  if (process.platform !== 'win32') {
    const r = spawnSync('ps', ['aux'], { encoding: 'utf-8', timeout: 5_000 });
    if (r.status === 0 && r.stdout) {
      for (const line of r.stdout.split('\n')) {
        if (!line.includes(profileDir) || !line.includes('--remote-debugging-port=')) continue;
        const m = line.match(/--remote-debugging-port=(\d+)/);
        const port = parseInt(m?.[1] ?? '', 10);
        if (port > 0) {
          const cr = spawnSync('curl', ['--silent', '--max-time', '2', `http://127.0.0.1:${port}/json/version`], { encoding: 'utf-8', timeout: 3_000 });
          if (cr.status === 0 && cr.stdout?.includes('webSocketDebuggerUrl')) return port;
        }
      }
    }
  }
  return null;
}

/** Wait for Chrome debug port using curl subprocess.
 *  Bun's fetch() returns empty body from Chrome's HTTP debug endpoint — curl works fine. */
async function waitForChromeDebugPortCurl(port: number, timeoutMs: number): Promise<string> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const result = spawnSync(
      'curl',
      ['--silent', '--max-time', '3', `http://127.0.0.1:${port}/json/version`],
      { encoding: 'utf-8', timeout: 4_000 },
    );
    if (result.status === 0 && result.stdout) {
      try {
        const version = JSON.parse(result.stdout) as { webSocketDebuggerUrl?: string };
        if (version.webSocketDebuggerUrl) return version.webSocketDebuggerUrl;
      } catch {}
    }
    await sleep(300);
  }
  throw new Error(`Chrome debug port ${port} not ready after ${timeoutMs}ms`);
}

/** Launch Chrome via bash script to avoid macOS singleton delegation.
 *  Direct spawn from Bun causes Chrome to exit immediately (delegates to existing instance).
 *  Running via /bin/bash gives Chrome the right GUI session context. */
function launchChromeViaBash(chromePath: string, profileDir: string, port: number): void {
  const scriptContent = [
    '#!/bin/bash',
    `'${chromePath}' \\`,
    `  --remote-debugging-port=${port} \\`,
    `  '--user-data-dir=${profileDir}' \\`,
    `  --no-first-run \\`,
    `  --no-default-browser-check \\`,
    `  'https://fanqienovel.com/main/writer/home' \\`,
    `  >/tmp/fanqie-chrome.log 2>&1 &`,
  ].join('\n');

  const scriptPath = path.join(os.tmpdir(), 'launch-fanqie-chrome.sh');
  fs.writeFileSync(scriptPath, scriptContent, { mode: 0o755 });

  const result = spawnSync('/bin/bash', [scriptPath], { encoding: 'utf-8', timeout: 5_000 });
  if (result.status !== 0) {
    throw new Error(`Failed to launch Chrome: ${result.stderr}`);
  }
}

/** Find or launch Chrome with the fanqie profile. Returns debug port. */
async function connectToChrome(): Promise<number> {
  const profileDir = getProfileDir();
  await fs.promises.mkdir(profileDir, { recursive: true });

  // Check for existing Chrome (uses curl, not Bun fetch which returns empty body)
  const existingPort = findExistingChromeDebugPortCurl(profileDir);
  if (existingPort) {
    console.log(`[fanqie] Found existing Chrome on port ${existingPort}, reusing.`);
    return existingPort;
  }

  const chromePath = findChromeExecutable({ candidates: CHROME_CANDIDATES, envNames: ['FANQIE_CHROME_PATH'] });
  if (!chromePath) throw new Error('Chrome not found. Install Google Chrome or set FANQIE_CHROME_PATH.');

  const port = await getFreePort('FANQIE_CHROME_DEBUG_PORT');
  console.log(`[fanqie] Launching Chrome (port: ${port}, profile: ${profileDir})`);
  launchChromeViaBash(chromePath, profileDir, port);
  return port;
}

// ─── Browser-side functions (serialized via .toString(), TypeScript-checked) ──
//
// Rule: functions here run in page context via Runtime.evaluate.
//   - DO NOT reference outer-scope variables (they won't exist in page context).
//   - TypeScript syntax IS allowed — Bun strips it before .toString() is called.
//   - Pass dynamic values as IIFE arguments: `(${fn.toString()})(JSON.stringify(val))`

/** Find and click 存草稿 in the step-2 modal (near 确认发布). Falls back to any 存草稿. */
function _browserClickDraftBtn(): boolean {
  const allBtns = Array.from(document.querySelectorAll('button'));
  // Prefer the button inside the same modal as 确认发布 (step-2 发布设置 modal)
  const confirmBtn = allBtns.find(b => b.textContent?.trim() === '确认发布');
  if (confirmBtn) {
    const modal = confirmBtn.closest('[class*="modal"],[class*="dialog"],[class*="overlay"],[role="dialog"]')
                  ?? confirmBtn.parentElement?.parentElement;
    if (modal) {
      const modalDraftBtn = Array.from(modal.querySelectorAll('button'))
        .find(b => b.textContent?.trim().includes('存草稿'));
      if (modalDraftBtn) { modalDraftBtn.click(); return true; }
    }
  }
  // Fallback: any 存草稿 button
  const btn = allBtns.find(b => {
    const t = b.textContent?.trim() ?? '';
    return t === '存草稿' || t === '保存草稿' || t.includes('存草稿') || t.includes('保存草稿');
  });
  if (btn) { btn.click(); return true; }
  return false;
}

// ─── Main publish logic ───────────────────────────────────────────────────────

async function publishChapter(opts: {
  chapterNum: string;
  chapterTitle: string;
  content: string;
  time: string;
  date: string;
}): Promise<void> {
  const { chapterNum, chapterTitle, content, time, date } = opts;

  const port = await connectToChrome();
  const wsUrl = await waitForChromeDebugPortCurl(port, 30_000);
  const cdp = await CdpConnection.connect(wsUrl, 30_000, { defaultTimeoutMs: 30_000 });

  let targetId = '';
  let sessionId = '';
  try {
    // Open a fresh tab for the publish page
    ({ targetId } = await cdp.send<{ targetId: string }>('Target.createTarget', {
      url: PUBLISH_URL,
    }));
    console.log('[fanqie] Opened publish tab');

    ({ sessionId } = await cdp.send<{ sessionId: string }>('Target.attachToTarget', {
      targetId,
      flatten: true,
    }));
    await cdp.send('Target.activateTarget', { targetId });
    await cdp.send('Page.enable', {}, { sessionId });
    await cdp.send('Runtime.enable', {}, { sessionId });

    // Wait for initial load
    await sleep(3500);

    // ── 检测服务器重定向到旧草稿 ────────────────────────────────────────────
    // 番茄小说有时会把 PUBLISH_URL 重定向到"上次编辑中"的草稿 URL，导致新章节保存到旧草稿。
    // 检测：URL 中若出现章节 ID，说明被重定向了。
    // 修复：先导航回首页清除草稿上下文，再重新打开发布页。
    const landingUrl = await evalVal<string>(cdp, sessionId, `location.href`);
    if (/\/publish\/\d+/.test(landingUrl)) {
      console.log(`[fanqie] Detected redirect to existing draft (${landingUrl}), clearing context...`);
      await cdp.send('Page.navigate', {
        url: `https://fanqienovel.com/main/writer/${BOOK_ID}/home`,
      }, { sessionId });
      await sleep(2500);
      await cdp.send('Page.navigate', { url: PUBLISH_URL }, { sessionId });
      await sleep(4000);
      const newUrl = await evalVal<string>(cdp, sessionId, `location.href`);
      console.log(`[fanqie] After re-navigate: ${newUrl}`);
    }

    // ── Dismiss tutorial dialog (1/4 → 4/4) ──────────────────────────────
    for (let step = 0; step < 5; step++) {
      const guideBtn = await evalVal<string>(cdp, sessionId, `(() => {
        // 数字/4 pattern buttons (e.g. "1/4", "2/4")
        const byFrac = Array.from(document.querySelectorAll('button')).find(b => /\\d+\\/4/.test(b.textContent ?? ''));
        if (byFrac) return byFrac.textContent?.trim() ?? '';
        // "知道了" button inside a guide overlay
        const overlay = document.querySelector('[class*="guide"], [class*="tutorial"], [class*="Guide"]');
        const knowBtn = overlay ? overlay.querySelector('button') : null;
        return knowBtn?.textContent?.trim() ?? '';
      })()`);

      if (!guideBtn) break;
      await cdp.send('Runtime.evaluate', {
        expression: `(() => {
          const byFrac = Array.from(document.querySelectorAll('button')).find(b => /\\d+\\/4/.test(b.textContent ?? ''));
          if (byFrac) { byFrac.click(); return; }
          const overlay = document.querySelector('[class*="guide"], [class*="tutorial"], [class*="Guide"]');
          const btn = overlay?.querySelector('button');
          if (btn) btn.click();
        })()`,
      }, { sessionId });
      console.log(`[fanqie] Dismissed guide step (${guideBtn})`);
      await sleep(700);
    }

    // ── Dismiss night-time warning banner ─────────────────────────────────
    const nightOk = await evalVal<boolean>(cdp, sessionId, `
      !!document.querySelector('[class*="night"] button, [class*="warn"] button')
    `);
    if (nightOk) {
      await cdp.send('Runtime.evaluate', {
        expression: `
          const btn = document.querySelector('[class*="night"] button, [class*="warn"] button');
          if (btn) btn.click();
        `,
      }, { sessionId });
      console.log('[fanqie] Dismissed night warning');
      await sleep(400);
    }

    // ── Fill chapter number + title ───────────────────────────────────────
    // 番茄小说发布页有两个字段：章节序号（阿拉伯数字）+ 标题文本
    // 使用 CDP 鼠标点击 + Input.insertText（真实浏览器级输入），避免 React 异步重渲染清空值。
    console.log(`[fanqie] Waiting for inputs (序号 + 标题)...`);
    const inputsReady = await waitFor(cdp, sessionId, `document.querySelectorAll('input').length >= 1`, 20_000);
    if (!inputsReady) throw new Error('Inputs not found — are you logged in to 番茄小说?');

    /** CDP-click an input to give it real browser-level focus, then fill via execCommand.
     *  execCommand('insertText') fires native input events that React's synthetic event system
     *  reliably handles — unlike dispatchKeyEvent type:char which fails for non-ASCII (Chinese) chars. */
    async function fillInputByClick(
      findExpr: string, // JS expression that returns the input element
      value: string,
      label: string,
    ): Promise<string> {
      // Get element center for mouse click
      const center = await evalVal<{ x: number; y: number } | null>(cdp, sessionId, `(() => {
        const el = (${findExpr});
        if (!el) return null;
        const r = el.getBoundingClientRect();
        return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
      })()`);
      if (!center) throw new Error(`${label} input not found on page`);

      const { x, y } = center;
      // Single click to focus
      await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 }, { sessionId });
      await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 }, { sessionId });
      await sleep(150);

      // Primary: execCommand('insertText') — fires InputEvent that React's onChange handler intercepts.
      // Works reliably for both ASCII and Chinese characters on empty or pre-filled inputs.
      const actual = await evalVal<string>(cdp, sessionId, `(() => {
        const el = (${findExpr});
        if (!el) return '';
        el.focus();
        el.select();
        document.execCommand('insertText', false, ${JSON.stringify(value)});
        return el.value ?? '';
      })()`);
      await sleep(200);

      // Read back after React has had time to reconcile
      const verified = await evalVal<string>(cdp, sessionId, `(${findExpr})?.value ?? ''`);
      if (verified === value) return verified;

      // Fallback: clear field first via nativeInputValueSetter, then execCommand on empty field
      const actual2 = await evalVal<string>(cdp, sessionId, `(() => {
        const el = (${findExpr});
        if (!el) return '';
        el.focus();
        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
        setter.call(el, '');
        el.dispatchEvent(new Event('input', { bubbles: true }));
        document.execCommand('insertText', false, ${JSON.stringify(value)});
        return el.value ?? '';
      })()`);
      await sleep(300);
      return await evalVal<string>(cdp, sessionId, `(${findExpr})?.value ?? ''`);
    }

    // 序号：第一个可见 text/number input
    const numExpr = `Array.from(document.querySelectorAll('input')).filter(el => el.offsetParent !== null && (el.type === 'text' || el.type === 'number' || el.type === ''))[0]`;
    console.log(`[fanqie] Filling 序号: ${chapterNum}`);
    const numActual = await fillInputByClick(numExpr, chapterNum, '序号');
    console.log(`[fanqie] 序号 filled: ${numActual}`);

    // 标题：placeholder 含"标题"的 input；否则用第二个可见 text input
    const titleExpr = `document.querySelector('input[placeholder*="标题"]') ?? Array.from(document.querySelectorAll('input')).filter(e => e.offsetParent !== null && (e.type === 'text' || e.type === '' || !e.type))[1]`;
    console.log(`[fanqie] Filling 标题: ${chapterTitle}`);
    const titleActual = await fillInputByClick(titleExpr, chapterTitle, '标题');
    console.log(`[fanqie] 标题 filled: ${titleActual}`);

    // 点击空白处让标题框失焦，确保 React 提交状态
    await cdp.send('Runtime.evaluate', { expression: `document.activeElement?.blur()` }, { sessionId });
    await sleep(300);

    // ── Paste content ─────────────────────────────────────────────────────
    console.log('[fanqie] Looking for content editor...');
    const editorReady = await waitFor(cdp, sessionId, `!!document.querySelector('div[contenteditable="true"]')`, 10_000);
    if (!editorReady) throw new Error('Content editor not found');

    // Step 1: 确保标题框失焦
    await cdp.send('Runtime.evaluate', {
      expression: `document.activeElement?.blur()`,
    }, { sessionId });
    await sleep(300);

    // Step 2: 用 JS .click() 点击编辑区（比 .focus()+range 更稳定，会设置浏览器级焦点）
    await cdp.send('Runtime.evaluate', {
      expression: `(() => {
        const ed = document.querySelector('div[contenteditable="true"]');
        if (!ed) return;
        ed.scrollIntoView({ block: 'center' });
        ed.click();
      })()`,
    }, { sessionId });
    await sleep(300);

    // Step 3: 用 CDP 鼠标事件在编辑区 top+200 处再点一次（避开标题行，确认浏览器级焦点）
    const clickPt = await evalVal<{ x: number; y: number } | null>(cdp, sessionId, `(() => {
      const ed = document.querySelector('div[contenteditable="true"]');
      if (!ed) return null;
      const r = ed.getBoundingClientRect();
      const safeY = Math.min(r.top + 200, r.bottom - 30, window.innerHeight - 50);
      return { x: r.left + r.width / 2, y: Math.max(safeY, r.top + 30) };
    })()`);
    if (clickPt) {
      await cdp.send('Input.dispatchMouseEvent', {
        type: 'mousePressed', x: clickPt.x, y: clickPt.y,
        button: 'left', clickCount: 1,
      }, { sessionId });
      await cdp.send('Input.dispatchMouseEvent', {
        type: 'mouseReleased', x: clickPt.x, y: clickPt.y,
        button: 'left', clickCount: 1,
      }, { sessionId });
      await sleep(300);
    }

    // Step 4: 调试：打印当前 active element
    const activeTag = await evalVal<string>(cdp, sessionId,
      `(document.activeElement?.tagName ?? 'none') + '/' + (document.activeElement?.contentEditable ?? 'none') + '/' + (document.activeElement?.closest('div[contenteditable="true"]') ? 'in-editor' : 'outside')`);
    console.log(`[fanqie] Active element: ${activeTag}`);

    // Step 5: 主方法 — 系统剪贴板 + osascript Cmd+V（macOS 上最可靠，完整触发浏览器事件链）
    console.log(`[fanqie] Copying content to clipboard and pasting (${content.length} chars)...`);
    copyToClipboard(content);
    await sleep(300);

    let pasteResult = -1;
    const osaPasted = pasteToChrome();
    if (osaPasted) {
      console.log('[fanqie] Pasted via osascript (Cmd+V)');
      await sleep(2000);
      pasteResult = await evalVal<number>(cdp, sessionId,
        `document.querySelector('div[contenteditable="true"]')?.innerText?.length ?? 0`);
      console.log(`[fanqie] After osascript paste: ${pasteResult} chars`);
    }

    // Step 5b: 降级 — DataTransfer paste 事件
    if (pasteResult < 100) {
      console.log('[fanqie] Falling back to DataTransfer paste event...');
      pasteResult = await evalVal<number>(cdp, sessionId, `(() => {
        const ed = document.querySelector('div[contenteditable="true"]');
        if (!ed) return -1;
        ed.focus();
        try {
          const dt = new DataTransfer();
          dt.setData('text/plain', ${JSON.stringify(content)});
          const pasteEvt = new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: dt });
          ed.dispatchEvent(pasteEvt);
        } catch(e) { return -2; }
        return ed.innerText?.length ?? 0;
      })()`);
      console.log(`[fanqie] After DataTransfer paste: ${pasteResult} chars`);
    }

    // Step 6: 如果前两种都无效，降级用 Input.insertText
    if (pasteResult < 100) {
      console.log('[fanqie] Paste event ineffective, fallback to Input.insertText...');
      // 确保编辑区聚焦
      await cdp.send('Runtime.evaluate', {
        expression: `document.querySelector('div[contenteditable="true"]')?.focus()`,
      }, { sessionId });
      await sleep(200);
      const CHUNK = 2000;
      for (let i = 0; i < content.length; i += CHUNK) {
        await cdp.send('Input.insertText', { text: content.slice(i, i + CHUNK) }, { sessionId });
        await sleep(50);
      }
      await sleep(500);
    }

    const contentLen = await evalVal<number>(cdp, sessionId,
      `document.querySelector('div[contenteditable="true"]')?.innerText?.length ?? 0`);
    console.log(`[fanqie] Content editor final length: ${contentLen} chars`);

    if (contentLen < 100) {
      throw new Error(`Content not entered into editor (got ${contentLen} chars).`);
    }

    // ── 下一步前：验证序号/标题未被粘贴操作清空，若丢失则重填 ──────────────
    // 原因：osascript Cmd+V 激活 Chrome 时若标题 input 仍持有焦点，会把正文粘进标题，
    // 导致 React state 混乱、标题变空，草稿保存为"未命名草稿"。
    const numNow = await evalVal<string>(cdp, sessionId, `(${numExpr})?.value ?? ''`);
    const titleNow = await evalVal<string>(cdp, sessionId, `(${titleExpr})?.value ?? ''`);
    if (numNow !== chapterNum || !titleNow) {
      console.log(`[fanqie] ⚠️ Inputs changed after paste (num="${numNow}", title="${titleNow}"). Re-filling...`);
      if (numNow !== chapterNum) await fillInputByClick(numExpr, chapterNum, '序号(re)');
      if (!titleNow) await fillInputByClick(titleExpr, chapterTitle, '标题(re)');
      await sleep(500);
    }

    // ── Click 下一步 ──────────────────────────────────────────────────────
    console.log('[fanqie] Clicking 下一步...');
    const nextExists = await waitFor(cdp, sessionId, `
      !!Array.from(document.querySelectorAll('button')).find(b => b.textContent?.trim() === '下一步')
    `, 8_000);

    if (!nextExists) throw new Error('下一步 button not found');

    await cdp.send('Runtime.evaluate', {
      expression: `
        const btn = Array.from(document.querySelectorAll('button')).find(b => b.textContent?.trim() === '下一步');
        btn?.click();
      `,
    }, { sessionId });
    await sleep(2500);

    // ── 处理「发布提示」→「内容风险检测」弹框链 ──────────────────────────
    // 点「下一步」后，番茄小说会先弹出「发布提示」（错别字检查），
    // 点「提交」后再弹「是否进行内容风险检测？」，点「取消」跳过，
    // 才能到达「发布设置」modal（step 2），在那里设定时间并存草稿。
    // 注意：发布提示 dialog 可能在 下一步 点击后延迟 3-10s 才弹出，需等待。
    await waitFor(cdp, sessionId,
      `Array.from(document.querySelectorAll('button')).some(function(b) {
        const t = b.textContent ? b.textContent.trim() : '';
        return t === '提交' || t === '确认发布' || t === '确认检测' || t === '立即检测';
      })`,
      12_000);

    const btnsAfterNext = await evalVal<string[]>(cdp, sessionId,
      `Array.from(document.querySelectorAll('button')).map(b => b.textContent?.trim()).filter(Boolean)`);
    console.log(`[fanqie] After 下一步 buttons: ${JSON.stringify(btnsAfterNext)}`);

    if (btnsAfterNext.includes('提交')) {
      // Step 2a: 发布提示 dialog — click 提交 to accept spelling check result
      console.log('[fanqie] Found 发布提示 dialog, clicking 提交...');
      await cdp.send('Runtime.evaluate', {
        expression: `Array.from(document.querySelectorAll('button')).find(b => b.textContent?.trim() === '提交')?.click()`,
      }, { sessionId });
      await sleep(1800);

      // Step 2b: 内容风险检测 dialog — click 取消 to skip risk detection
      const btnsAfterSubmit = await evalVal<string[]>(cdp, sessionId,
        `Array.from(document.querySelectorAll('button')).map(b => b.textContent?.trim()).filter(Boolean)`);
      console.log(`[fanqie] After 提交 buttons: ${JSON.stringify(btnsAfterSubmit)}`);

      // The risk-detection dialog has 取消 (and possibly 确认检测 / 开始检测)
      // We want to click 取消 here to skip and proceed to 发布设置 (step 2)
      const hasRiskDialog = btnsAfterSubmit.some(b => b === '确认检测' || b === '开始检测' || b === '立即检测');
      if (hasRiskDialog) {
        console.log('[fanqie] Found 内容风险检测 dialog, clicking 取消 to skip...');
        await cdp.send('Runtime.evaluate', {
          expression: `Array.from(document.querySelectorAll('button')).find(b => b.textContent?.trim() === '取消')?.click()`,
        }, { sessionId });
        await sleep(2000); // wait for 发布设置 modal to open
      } else if (btnsAfterSubmit.includes('取消') && btnsAfterSubmit.includes('确认发布')) {
        // Already on step 2 (发布设置 modal has 取消 + 确认发布 + 存草稿)
        console.log('[fanqie] Already on step 2 (发布设置 modal)');
      } else if (btnsAfterSubmit.includes('取消') && !btnsAfterSubmit.includes('提交')) {
        // Probably risk dialog with just 取消
        console.log('[fanqie] Clicking 取消 on risk dialog...');
        await cdp.send('Runtime.evaluate', {
          expression: `Array.from(document.querySelectorAll('button')).find(b => b.textContent?.trim() === '取消')?.click()`,
        }, { sessionId });
        await sleep(2000);
      }
    }

    // ── Set scheduled time ────────────────────────────────────────────────
    console.log(`[fanqie] Setting scheduled time: ${date} ${time}`);

    // Click "定时发布" option
    await cdp.send('Runtime.evaluate', {
      expression: `(() => {
        // Try radio input with value
        const radios = Array.from(document.querySelectorAll('input[type="radio"]'));
        const scheduled = radios.find(r => r.value?.includes('timed') || r.value?.includes('schedule') || r.value?.includes('定时'));
        if (scheduled) { scheduled.click(); return; }

        // Try label / span text match
        const all = Array.from(document.querySelectorAll('label, span, div[role="radio"]'));
        const match = all.find(el => el.textContent?.trim() === '定时发布');
        if (match) { match.click(); return; }
      })()`,
    }, { sessionId });
    await sleep(600);

    // Set date and time inputs (番茄小说 may use custom date-pickers)
    await cdp.send('Runtime.evaluate', {
      expression: `(() => {
        const setter = (el, val) => {
          const s = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
          if (s) s.call(el, val);
          el.dispatchEvent(new Event('input', { bubbles: true }));
          el.dispatchEvent(new Event('change', { bubbles: true }));
        };

        // Date inputs
        for (const el of document.querySelectorAll('input[type="date"]')) setter(el, ${JSON.stringify(date)});

        // Time inputs
        for (const el of document.querySelectorAll('input[type="time"]')) setter(el, ${JSON.stringify(time)});

        // Generic text inputs that look like date/time
        for (const el of document.querySelectorAll('input[type="text"]')) {
          const ph = el.placeholder ?? '';
          if (/日期|年月日/.test(ph)) setter(el, ${JSON.stringify(date)});
          else if (/时间|时分/.test(ph)) setter(el, ${JSON.stringify(time)});
        }
      })()`,
    }, { sessionId });
    await sleep(400);

    // ── Save draft ────────────────────────────────────────────────────────
    console.log('[fanqie] Saving draft...');

    // 先打印当前页面所有按钮文本，方便调试
    const allBtns = await evalVal<string[]>(cdp, sessionId,
      `Array.from(document.querySelectorAll('button')).map(b => b.textContent?.trim()).filter(Boolean)`);
    console.log(`[fanqie] Buttons on page: ${JSON.stringify(allBtns)}`);

    // ── 处理「知道了 / 放弃 / 继续编辑」对话框 ────────────────────────────
    // 番茄小说在检测到旧草稿未完成时会弹出此对话框，必须先处理，否则存草稿会保存到旧草稿 URL。
    // 策略：先点「知道了」关闭提示，再点「放弃」解除与旧草稿的关联，让本章作为新章节保存。
    if (allBtns.includes('知道了')) {
      await cdp.send('Runtime.evaluate', {
        expression: `Array.from(document.querySelectorAll('button')).find(b => b.textContent?.trim() === '知道了')?.click()`,
      }, { sessionId });
      console.log('[fanqie] Dismissed 知道了 popup');
      await sleep(800);
    }

    if (allBtns.includes('放弃')) {
      await cdp.send('Runtime.evaluate', {
        expression: `Array.from(document.querySelectorAll('button')).find(b => b.textContent?.trim() === '放弃')?.click()`,
      }, { sessionId });
      console.log('[fanqie] Clicked 放弃 (discarding old draft session, will create fresh chapter)');
      await sleep(1500);

      // 点「放弃」后可能退回到第一页（编辑页），需要重新点「下一步」
      const btnsAfterDiscard = await evalVal<string[]>(cdp, sessionId,
        `Array.from(document.querySelectorAll('button')).map(b => b.textContent?.trim()).filter(Boolean)`);
      // Step 1 is identified by presence of 下一步 (step 2 modal has 确认发布 instead)
      const backToPage1 = btnsAfterDiscard.includes('下一步');
      if (backToPage1) {
        console.log('[fanqie] Back to page 1 after 放弃, re-clicking 下一步...');
        await cdp.send('Runtime.evaluate', {
          expression: `Array.from(document.querySelectorAll('button')).find(b => b.textContent?.trim() === '下一步')?.click()`,
        }, { sessionId });
        await sleep(2500);

        // Re-handle the 发布提示 → 内容风险检测 dialog chain (same as after first 下一步)
        await waitFor(cdp, sessionId,
          `Array.from(document.querySelectorAll('button')).some(function(b) {
            const t = b.textContent ? b.textContent.trim() : '';
            return t === '提交' || t === '确认发布' || t === '确认检测' || t === '立即检测';
          })`,
          12_000);
        const btnsAfterNext2 = await evalVal<string[]>(cdp, sessionId,
          `Array.from(document.querySelectorAll('button')).map(b => b.textContent?.trim()).filter(Boolean)`);
        console.log(`[fanqie] After re-click 下一步 buttons: ${JSON.stringify(btnsAfterNext2)}`);

        if (btnsAfterNext2.includes('提交')) {
          await cdp.send('Runtime.evaluate', {
            expression: `Array.from(document.querySelectorAll('button')).find(b => b.textContent?.trim() === '提交')?.click()`,
          }, { sessionId });
          await sleep(1800);
          const btnsAfterSubmit2 = await evalVal<string[]>(cdp, sessionId,
            `Array.from(document.querySelectorAll('button')).map(b => b.textContent?.trim()).filter(Boolean)`);
          console.log(`[fanqie] After re-submit buttons: ${JSON.stringify(btnsAfterSubmit2)}`);
          const hasRisk2 = btnsAfterSubmit2.some(b => b === '确认检测' || b === '开始检测' || b === '立即检测');
          if (hasRisk2 || (btnsAfterSubmit2.includes('取消') && !btnsAfterSubmit2.includes('确认发布'))) {
            await cdp.send('Runtime.evaluate', {
              expression: `Array.from(document.querySelectorAll('button')).find(b => b.textContent?.trim() === '取消')?.click()`,
            }, { sessionId });
            await sleep(2000);
          }
        }
      }
    }

    const draftClicked = await evalVal<boolean>(cdp, sessionId, `(${_browserClickDraftBtn.toString()})()`);

    if (!draftClicked) {
      throw new Error(`存草稿 button not found! Buttons on page: ${JSON.stringify(allBtns)}`);
    }
    console.log('[fanqie] Clicked 存草稿, waiting for save...');
    await sleep(5000);

    // ── Verify + URL collision check ──────────────────────────────────────
    const currentUrl = await evalVal<string>(cdp, sessionId, `location.href`);

    // 读取上次保存的 URL，防止服务端重定向把本章存入旧草稿
    const LAST_URL_FILE = path.join(os.tmpdir(), 'fanqie-last-chapter-url.txt');
    let prevUrl = '';
    try { prevUrl = fs.readFileSync(LAST_URL_FILE, 'utf-8').trim(); } catch {}

    if (prevUrl && currentUrl === prevUrl) {
      throw new Error(
        `URL_COLLISION: 本章保存到了与上一章相同的 URL (${currentUrl})。` +
        `服务端可能把新章节重定向到了旧草稿，请重试。`
      );
    }
    fs.writeFileSync(LAST_URL_FILE, currentUrl, 'utf-8');
    console.log(`[fanqie] ✓ Done. Current URL: ${currentUrl}`);

    // 保存后导航离开发布页，让服务器知道该草稿不再"编辑中"，防止下一章被重定向到此草稿
    await cdp.send('Page.navigate', {
      url: `https://fanqienovel.com/main/writer/${BOOK_ID}/home`,
    }, { sessionId });
    await sleep(1500);

    // Close the tab we created
    await cdp.send('Target.closeTarget', { targetId });

  } catch (err) {
    // On failure, capture a screenshot so the next debugging session starts with visual context.
    if (sessionId) {
      try {
        const { data } = await cdp.send<{ data: string }>(
          'Page.captureScreenshot', { format: 'jpeg', quality: 80 }, { sessionId },
        );
        const file = `/tmp/fanqie-fail-${Date.now()}.jpg`;
        fs.writeFileSync(file, Buffer.from(data, 'base64'));
        console.error(`[fanqie] Screenshot saved: ${file}`);
      } catch { /* ignore screenshot errors */ }
    }
    // Close the tab even on failure — prevents orphaned tabs accumulating in Chrome.
    if (targetId) {
      try { await cdp.send('Target.closeTarget', { targetId }); } catch {}
    }
    throw err;
  } finally {
    cdp.close();
  }
}

// ─── CLI ──────────────────────────────────────────────────────────────────────

function printUsage(): never {
  console.log(`
fanqie-publish.ts — Publish one chapter to 番茄小说

Usage:
  bun fanqie-publish.ts --md-file <path/to/chNNN_title.md> [options]

Options:
  --md-file <path>   Path to the chapter Markdown file (required)
  --title <text>     Override the chapter title (default: extracted from # heading)
  --time <HH:MM>     Scheduled publish time (default: 16:00)
  --date <YYYY-MM-DD> Scheduled publish date (default: today)
  --help             Show this help

Environment:
  FANQIE_CHROME_PATH         Override Chrome executable path
  FANQIE_CHROME_PROFILE_DIR  Override Chrome profile directory
  FANQIE_CHROME_DEBUG_PORT   Use a fixed debug port

Example:
  bun fanqie-publish.ts --md-file novels/开门剑山/chapters/ch048_宋缺的剑.md --time 16:00
`);
  process.exit(0);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.includes('--help') || args.includes('-h')) printUsage();

  let mdFile = '';
  let titleOverride = '';
  let time = '16:00';
  let date = getTodayDate();

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if ((arg === '--md-file' || arg === '--file') && args[i + 1]) mdFile = args[++i]!;
    else if (arg === '--title' && args[i + 1]) titleOverride = args[++i]!;
    else if (arg === '--time' && args[i + 1]) time = args[++i]!;
    else if (arg === '--date' && args[i + 1]) date = args[++i]!;
  }

  if (!mdFile) {
    console.error('Error: --md-file is required');
    process.exit(1);
  }
  if (!fs.existsSync(mdFile)) {
    console.error(`Error: File not found: ${mdFile}`);
    process.exit(1);
  }

  const raw = fs.readFileSync(mdFile, 'utf-8');
  const { chapterTitle, content } = cleanMarkdown(raw);

  // Extract chapter number from filename: ch048_xxx.md → "48"
  const fileNumMatch = path.basename(mdFile).match(/^ch(\d+)/i);
  const fileNum = fileNumMatch ? String(parseInt(fileNumMatch[1]!, 10)) : '';

  // --title override: "48 宋缺的剑" or just title text
  let finalNum = fileNum;
  let finalTitle = chapterTitle;
  if (titleOverride) {
    const m = titleOverride.match(/^(\d+)\s+(.+)$/);
    if (m) { finalNum = m[1]!; finalTitle = m[2]!; }
    else { finalTitle = titleOverride; }
  }

  if (!finalNum || !finalTitle) {
    console.error('Error: Could not extract chapter number/title. Filename should be ch048_title.md');
    process.exit(1);
  }
  if (!content) {
    console.error('Error: File content is empty after cleaning.');
    process.exit(1);
  }

  console.log(`[fanqie] 序号   : ${finalNum}`);
  console.log(`[fanqie] 标题   : ${finalTitle}`);
  console.log(`[fanqie] Content: ${content.length} chars`);
  console.log(`[fanqie] Schedule: ${date} ${time}`);
  console.log(`[fanqie] Profile : ${getProfileDir()}`);

  await publishChapter({ chapterNum: finalNum, chapterTitle: finalTitle, content, time, date });
}

await main().catch((err) => {
  console.error(`[fanqie] Error: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
