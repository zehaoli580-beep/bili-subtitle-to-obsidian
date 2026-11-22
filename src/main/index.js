'use strict';

const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const QRCode = require('qrcode');

const bili = require('./bilibili');
const { buildFilename, buildMarkdown } = require('./markdown');
const { createStore } = require('./store');

let win = null;
let config = null;
let credential = null;

const DEFAULT_CONFIG = { lastDir: '', format: 'timestamp', frontmatter: true };

function getCookies() {
  return credential.get('cookies', {});
}

function setCookies(cookies) {
  credential.set({ cookies });
}

function cookieHeader() {
  const cookies = getCookies();
  const keys = Object.keys(cookies);
  return keys.length ? keys.map((key) => `${key}=${cookies[key]}`).join('; ') : '';
}

/** 统一包装 IPC 返回值，渲染进程只需要判断 ok */
function handle(channel, fn) {
  ipcMain.handle(channel, async (_event, ...args) => {
    try {
      return { ok: true, data: await fn(...args) };
    } catch (err) {
      return { ok: false, error: (err && err.message) || '操作失败', code: err && err.code };
    }
  });
}

function createWindow() {
  win = new BrowserWindow({
    width: 1320,
    height: 880,
    minWidth: 1080,
    minHeight: 680,
    title: 'B站字幕提取器',
    backgroundColor: '#f6f7f9',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, '../preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });
  win.loadFile(path.join(__dirname, '../renderer/index.html'));
  win.on('closed', () => {
    win = null;
  });
}

function registerHandlers() {
  handle('video:parse', async (input) => {
    const target = await bili.resolveTarget(input);
    const info = await bili.getVideoInfo({ ...target, cookieHeader: cookieHeader() });
    return {
      bvid: info.bvid,
      title: info.title,
      cover: info.pic,
      desc: info.desc,
      owner: (info.owner && info.owner.name) || '未知',
      pages: (info.pages || []).map((page) => ({
        cid: page.cid,
        page: page.page,
        part: page.part,
        duration: page.duration,
      })),
      initialPage: target.page,
    };
  });

  handle('subtitle:fetch', async ({ bvid, cid, duration, title }) =>
    bili.getBestSubtitle({ bvid, cid, duration, title, cookieHeader: cookieHeader() }),
  );

  handle('subtitle:content', async ({ url, duration, title }) => {
    const lines = await bili.getSubtitleBody(url, cookieHeader());
    return { lines, suspicious: bili.isSuspiciousSubtitle(lines, duration, title) };
  });

  handle('login:status', async () => bili.getNav(cookieHeader()));

  handle('login:qr', async () => {
    const qr = await bili.qrGenerate();
    const image = await QRCode.toDataURL(qr.url, { width: 280, margin: 1 });
    return { key: qr.key, image };
  });

  handle('login:poll', async (key) => {
    const result = await bili.qrPoll(key);
    if (result.status !== 'success') return result;
    setCookies({ ...getCookies(), ...result.cookies });
    const nav = await bili.getNav(cookieHeader());
    if (!nav.isLogin) {
      setCookies({});
      throw new Error('扫码成功但登录态无效，请重试');
    }
    return { status: 'success', user: nav };
  });

  handle('login:cookie', async (text) => {
    const cookies = bili.parseCookieInput(text);
    if (!Object.keys(cookies).length) throw new Error('Cookie 内容为空');
    const merged = { ...getCookies(), ...cookies };
    const previous = getCookies();
    setCookies(merged);
    try {
      const nav = await bili.getNav(cookieHeader());
      if (!nav.isLogin) throw new Error('Cookie 无效或已过期');
      return nav;
    } catch (err) {
      setCookies(previous);
      throw err;
    }
  });

  handle('login:logout', async () => {
    setCookies({});
    return true;
  });

  handle('config:get', async () => ({ ...DEFAULT_CONFIG, ...config.all() }));

  handle('config:set', async (patch) => {
    config.set(patch);
    return { ...DEFAULT_CONFIG, ...config.all() };
  });

  handle('dialog:chooseDir', async () => {
    const result = await dialog.showOpenDialog(win, {
      title: '选择 Markdown 保存目录',
      properties: ['openDirectory', 'createDirectory'],
    });
    if (result.canceled || !result.filePaths.length) return '';
    return result.filePaths[0];
  });

  handle('export:preview', async (payload) => {
    const { video, page, pageCount, lines, options } = payload;
    if (!lines || !lines.length) throw new Error('没有可导出的字幕');
    return {
      filename: buildFilename(video, page, pageCount),
      markdown: buildMarkdown(payload),
    };
  });

  handle('export:write', async (payload) => {
    const { video, page, pageCount, lines, dir } = payload;
    if (!dir) throw new Error('请先选择保存目录');
    if (!lines || !lines.length) throw new Error('没有可导出的字幕');

    await fsp.mkdir(dir, { recursive: true });
    const markdown = buildMarkdown(payload);
    const filename = buildFilename(video, page, pageCount);
    const ext = path.extname(filename);
    const basename = path.basename(filename, ext);

    let target = path.join(dir, filename);
    let index = 2;
    while (fs.existsSync(target)) {
      target = path.join(dir, `${basename} (${index})${ext}`);
      index += 1;
    }

    await fsp.writeFile(target, markdown, 'utf8');
    return { path: target };
  });

  handle('shell:show', async (target) => {
    shell.showItemInFolder(target);
    return true;
  });
}

app.whenReady().then(() => {
  const userData = app.getPath('userData');
  config = createStore(path.join(userData, 'config.json'));
  credential = createStore(path.join(userData, 'credential.json'));

  registerHandlers();
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
