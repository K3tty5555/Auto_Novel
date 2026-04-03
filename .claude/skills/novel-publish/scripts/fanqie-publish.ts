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
  findExistingChromeDebugPort,
  getFreePort,
  launchChrome,
  resolveSharedChromeProfileDir,
  sleep,
  waitForChromeDebugPort,
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
function cleanMarkdown(raw: string): { title: string; content: string } {
  const lines = raw.split('\n');
  let extractedTitle = '';
  const out: string[] = [];

  for (const line of lines) {
    // Extract title from "# 第X章 xxx" heading
    const titleMatch = line.match(/^#\s+(第\S+章.*)$/);
    if (titleMatch) {
      extractedTitle = titleMatch[1].trim();
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

  return { title: extractedTitle, content: normalized };
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
        { sessionId },
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

/** Find or launch Chrome with the fanqie profile. Returns debug port. */
async function connectToChrome(): Promise<number> {
  const profileDir = getProfileDir();
  await fs.promises.mkdir(profileDir, { recursive: true });

  const existingPort = await findExistingChromeDebugPort({ profileDir });
  if (existingPort) {
    console.log(`[fanqie] Found Chrome on port ${existingPort}, checking...`);
    try {
      const wsUrl = await waitForChromeDebugPort(existingPort, 5_000);
      const test = await CdpConnection.connect(wsUrl, 5_000, { defaultTimeoutMs: 5_000 });
      await test.send('Target.getTargets');
      test.close();
      console.log('[fanqie] Reusing existing Chrome.');
      return existingPort;
    } catch {
      console.log('[fanqie] Existing Chrome unresponsive, launching fresh...');
    }
  }

  const chromePath = findChromeExecutable({ candidates: CHROME_CANDIDATES, envNames: ['FANQIE_CHROME_PATH'] });
  if (!chromePath) throw new Error('Chrome not found. Install Google Chrome or set FANQIE_CHROME_PATH.');

  const port = await getFreePort('FANQIE_CHROME_DEBUG_PORT');
  console.log(`[fanqie] Launching Chrome (port: ${port}, profile: ${profileDir})`);
  await launchChrome({
    chromePath,
    profileDir,
    port,
    url: 'https://fanqienovel.com/main/writer/home',
    extraArgs: ['--disable-blink-features=AutomationControlled', '--start-maximized'],
  });
  return port;
}

// ─── Main publish logic ───────────────────────────────────────────────────────

async function publishChapter(opts: {
  title: string;
  content: string;
  time: string;
  date: string;
}): Promise<void> {
  const { title, content, time, date } = opts;

  const port = await connectToChrome();
  const wsUrl = await waitForChromeDebugPort(port, 30_000);
  const cdp = await CdpConnection.connect(wsUrl, 30_000, { defaultTimeoutMs: 30_000 });

  try {
    // Open a fresh tab for the publish page
    const { targetId } = await cdp.send<{ targetId: string }>('Target.createTarget', {
      url: PUBLISH_URL,
    });
    console.log('[fanqie] Opened publish tab');

    const { sessionId } = await cdp.send<{ sessionId: string }>('Target.attachToTarget', {
      targetId,
      flatten: true,
    });
    await cdp.send('Target.activateTarget', { targetId });
    await cdp.send('Page.enable', {}, { sessionId });
    await cdp.send('Runtime.enable', {}, { sessionId });

    // Wait for initial load
    await sleep(3500);

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

    // ── Fill title ────────────────────────────────────────────────────────
    console.log(`[fanqie] Waiting for title input...`);
    const titleReady = await waitFor(cdp, sessionId, `!!document.querySelector('input[type="text"]')`, 20_000);
    if (!titleReady) throw new Error('Title input not found — are you logged in to 番茄小说?');

    console.log(`[fanqie] Filling title: "${title}"`);
    // Focus and clear via React native setter
    await cdp.send('Runtime.evaluate', {
      expression: `(() => {
        const el = document.querySelector('input[type="text"]');
        if (!el) return;
        el.focus();
        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
        if (setter) setter.call(el, '');
        el.dispatchEvent(new Event('input', { bubbles: true }));
      })()`,
    }, { sessionId });
    await sleep(150);

    await cdp.send('Input.insertText', { text: title }, { sessionId });
    await sleep(400);

    // Verify
    const titleGot = await evalVal<string>(cdp, sessionId, `document.querySelector('input[type="text"]')?.value ?? ''`);
    if (!titleGot) {
      // Fallback: set directly via React
      await cdp.send('Runtime.evaluate', {
        expression: `(() => {
          const el = document.querySelector('input[type="text"]');
          if (!el) return;
          const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
          if (setter) setter.call(el, ${JSON.stringify(title)});
          el.dispatchEvent(new Event('input', { bubbles: true }));
          el.dispatchEvent(new Event('change', { bubbles: true }));
        })()`,
      }, { sessionId });
      console.log('[fanqie] Title set via React setter (fallback)');
    } else {
      console.log(`[fanqie] Title verified: "${titleGot}"`);
    }

    // ── Paste content ─────────────────────────────────────────────────────
    console.log('[fanqie] Looking for content editor...');
    const editorReady = await waitFor(cdp, sessionId, `!!document.querySelector('div[contenteditable="true"]')`, 10_000);
    if (!editorReady) throw new Error('Content editor not found');

    console.log(`[fanqie] Copying content to clipboard (${content.length} chars)...`);
    copyToClipboard(content);
    await sleep(300);

    // Focus the editor
    await cdp.send('Runtime.evaluate', {
      expression: `(() => {
        const ed = document.querySelector('div[contenteditable="true"]');
        if (ed) { ed.click(); ed.focus(); }
      })()`,
    }, { sessionId });
    await sleep(300);

    // Paste via AppleScript (primary)
    console.log('[fanqie] Pasting content (Cmd+V via AppleScript)...');
    pasteToChrome();
    await sleep(2500);

    const contentLen = await evalVal<number>(cdp, sessionId,
      `document.querySelector('div[contenteditable="true"]')?.innerText?.length ?? 0`);
    console.log(`[fanqie] Content editor length: ${contentLen} chars`);

    if (contentLen < 100) {
      // Fallback: execCommand insertText
      console.log('[fanqie] Pasting via execCommand (fallback)...');
      await cdp.send('Runtime.evaluate', {
        expression: `(() => {
          const ed = document.querySelector('div[contenteditable="true"]');
          if (!ed) return;
          ed.focus();
          document.execCommand('selectAll');
          document.execCommand('insertText', false, ${JSON.stringify(content)});
        })()`,
      }, { sessionId });
      await sleep(1500);

      const len2 = await evalVal<number>(cdp, sessionId,
        `document.querySelector('div[contenteditable="true"]')?.innerText?.length ?? 0`);
      console.log(`[fanqie] After execCommand: ${len2} chars`);
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
    await cdp.send('Runtime.evaluate', {
      expression: `
        const btn = Array.from(document.querySelectorAll('button')).find(b =>
          b.textContent?.trim() === '存草稿' || b.textContent?.includes('存草稿')
        );
        if (btn) btn.click();
        else console.warn('[fanqie] 存草稿 not found');
      `,
    }, { sessionId });
    await sleep(2000);

    // ── Verify ────────────────────────────────────────────────────────────
    const currentUrl = await evalVal<string>(cdp, sessionId, `location.href`);
    console.log(`[fanqie] ✓ Done. Current URL: ${currentUrl}`);

    // Close the tab we created
    await cdp.send('Target.closeTarget', { targetId });

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
  const { title: extractedTitle, content } = cleanMarkdown(raw);
  const title = titleOverride || extractedTitle;

  if (!title) {
    console.error('Error: Could not extract title from file. Use --title to specify it.');
    process.exit(1);
  }
  if (!content) {
    console.error('Error: File content is empty after cleaning.');
    process.exit(1);
  }

  console.log(`[fanqie] Chapter : ${title}`);
  console.log(`[fanqie] Content : ${content.length} chars`);
  console.log(`[fanqie] Schedule: ${date} ${time}`);
  console.log(`[fanqie] Profile : ${getProfileDir()}`);

  await publishChapter({ title, content, time, date });
}

await main().catch((err) => {
  console.error(`[fanqie] Error: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
