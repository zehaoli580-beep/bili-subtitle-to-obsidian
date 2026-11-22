const api = window.api;

const state = {
  video: null,
  pages: [],
  page: null,
  subtitles: [],
  lines: [],
  suspicious: false,
  dir: '',
  login: { isLogin: false, uname: '', face: '' },
  preview: null,
  previewToken: 0,
  pollTimer: null,
};

const $ = (id) => document.getElementById(id);

function formatDuration(seconds) {
  const total = Math.max(0, Math.floor(Number(seconds) || 0));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (n) => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
}

let toastTimer = null;

function toast(message, type = 'info', action = null) {
  const box = $('toast');
  box.className = 'toast show' + (type === 'info' ? '' : ' ' + type);
  box.textContent = '';
  const text = document.createElement('span');
  text.textContent = message;
  box.appendChild(text);
  if (action) {
    const button = document.createElement('button');
    button.className = 'toast-action';
    button.textContent = action.label;
    button.addEventListener('click', action.onClick);
    box.appendChild(button);
  }
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    box.className = 'toast';
  }, action ? 7000 : 3200);
}

/* ---------- 登录状态 ---------- */
function renderAccount() {
  const on = state.login.isLogin;
  $('loginOff').classList.toggle('hidden', on);
  $('loginOn').classList.toggle('hidden', !on);
  if (on) {
    $('userName').textContent = state.login.uname;
    $('userFace').src = state.login.face || '';
  }
}

async function refreshLogin() {
  const res = await api.loginStatus();
  if (res.ok) {
    state.login = res.data;
    renderAccount();
  }
}

/* ---------- 视频信息 ---------- */
function renderVideo() {
  const video = state.video;
  if (!video) return;
  $('videoEmpty').classList.add('hidden');
  $('videoInfo').classList.remove('hidden');

  const cover = $('cover');
  cover.src = video.cover || '';
  cover.onerror = () => {
    cover.style.visibility = 'hidden';
  };

  $('vtitle').textContent = video.title;
  $('vowner').textContent = 'UP主：' + video.owner;
  $('vpagemeta').textContent = video.pages.length > 1 ? `${video.pages.length} 个分P` : '单P视频';
  $('vdesc').textContent = video.desc || '（无简介）';
  $('pageCount').textContent = video.pages.length;
  renderPages();
}

function renderPages() {
  const box = $('pages');
  box.textContent = '';
  for (const page of state.pages) {
    const item = document.createElement('button');
    item.className = 'page-item' + (state.page && state.page.cid === page.cid ? ' active' : '');

    const index = document.createElement('span');
    index.className = 'p-index';
    index.textContent = 'P' + page.page;
    const name = document.createElement('span');
    name.className = 'p-name';
    name.textContent = page.part;
    const duration = document.createElement('span');
    duration.className = 'p-dur';
    duration.textContent = formatDuration(page.duration);

    item.append(index, name, duration);
    item.addEventListener('click', () => selectPage(page));
    box.appendChild(item);
  }
}

/* ---------- 字幕 ---------- */
function renderLang(chosenUrl) {
  const select = $('lang');
  select.textContent = '';
  for (const item of state.subtitles) {
    const option = document.createElement('option');
    option.value = item.url;
    option.textContent = item.ai ? `${item.lanDoc} · AI` : item.lanDoc;
    select.appendChild(option);
  }
  select.disabled = state.subtitles.length <= 1;
  if (chosenUrl) select.value = chosenUrl;
  $('copyBtn').disabled = !state.subtitles.length;
  $('retryBtn').disabled = !state.page;
}

/** 头部显示当前字幕的句数与异常提示 */
function renderSubMeta() {
  const meta = $('subMeta');
  if (!state.lines.length) {
    meta.textContent = '';
    meta.className = 'sub-meta';
    return;
  }
  const selected = state.subtitles.find((item) => item.url === $('lang').value);
  const label = selected ? selected.lanDoc : '';
  const count = `${state.lines.length} 句`;
  if (state.suspicious) {
    meta.textContent = `${label} · ${count} · 可能不是本视频的字幕，建议重新获取`;
    meta.className = 'sub-meta warn';
  } else {
    meta.textContent = `${label} · ${count}`;
    meta.className = 'sub-meta';
  }
}

function showEmpty(text) {
  $('subContent').classList.add('hidden');
  $('subEmpty').classList.remove('hidden');
  $('subEmpty').textContent = text;
  $('filename').textContent = '—';
  $('exportBtn').disabled = true;
  $('subMeta').textContent = '';
  $('subMeta').className = 'sub-meta';
  state.lines = [];
  state.suspicious = false;
  state.preview = null;
}

async function selectPage(page) {
  state.page = page;
  state.subtitles = [];
  state.lines = [];
  state.suspicious = false;
  state.preview = null;
  renderPages();
  renderLang();
  $('copyBtn').disabled = true;
  $('retryBtn').disabled = true;
  $('subContent').classList.add('hidden');
  $('subEmpty').classList.remove('hidden');
  $('subEmpty').textContent = '正在获取字幕…';
  $('subMeta').textContent = '';
  $('filename').textContent = '—';
  $('exportBtn').disabled = true;

  const res = await api.getSubtitles({
    bvid: state.video.bvid,
    cid: page.cid,
    duration: page.duration,
    title: state.video.title,
  });
  if (!res.ok) {
    showEmpty(res.error);
    return;
  }

  state.subtitles = res.data.list || [];
  renderLang(res.data.chosenUrl);

  if (!res.data.lines || !res.data.lines.length) {
    showEmpty(
      res.data.needLogin && !state.login.isLogin
        ? '该视频的字幕需要登录后才能获取，请先点击右上角扫码登录。'
        : '该视频没有可用字幕（B 站可能未生成 AI 字幕）。',
    );
    return;
  }

  state.lines = res.data.lines;
  state.suspicious = res.data.suspicious;
  renderSubMeta();
  await updatePreview();
}

async function loadSubtitle(url) {
  $('subEmpty').classList.remove('hidden');
  $('subEmpty').textContent = '正在下载字幕…';
  $('subContent').classList.add('hidden');

  const res = await api.getSubtitleContent({
    url,
    duration: state.page.duration,
    title: state.video.title,
  });
  if (!res.ok) {
    showEmpty(res.error);
    return;
  }
  state.lines = res.data.lines;
  state.suspicious = res.data.suspicious;
  renderSubMeta();
  await updatePreview();
}

/* ---------- 预览与导出 ---------- */
function currentFormat() {
  const checked = document.querySelector('input[name="fmt"]:checked');
  return checked ? checked.value : 'timestamp';
}

function buildPayload() {
  const video = state.video;
  return {
    video: { bvid: video.bvid, title: video.title, owner: video.owner },
    page: state.page,
    pageCount: state.pages.length,
    lines: state.lines,
    options: { format: currentFormat(), withFrontmatter: $('fm').checked },
    dir: state.dir,
  };
}

async function updatePreview() {
  $('fmtBadge').textContent = currentFormat() === 'plain' ? '纯文本' : '时间戳';

  if (!state.lines.length || !state.page) {
    $('subContent').classList.add('hidden');
    $('exportBtn').disabled = true;
    return;
  }

  const token = ++state.previewToken;
  const res = await api.previewExport(buildPayload());
  if (token !== state.previewToken) return;

  if (!res.ok) {
    showEmpty(res.error);
    return;
  }

  state.preview = res.data;
  $('subEmpty').classList.add('hidden');
  $('subContent').classList.remove('hidden');
  $('subContent').textContent = res.data.markdown;
  $('filename').textContent = res.data.filename;
  $('exportBtn').disabled = !state.dir;
}

async function handleExport() {
  if (!state.lines.length) return toast('没有可导出的字幕', 'error');
  if (!state.dir) return toast('请先选择保存目录', 'error');

  $('exportBtn').disabled = true;
  const res = await api.exportMarkdown(buildPayload());
  $('exportBtn').disabled = false;

  if (!res.ok) return toast(res.error, 'error');
  toast('已导出：' + res.data.path, 'success', {
    label: '打开目录',
    onClick: () => api.showInFolder(res.data.path),
  });
}

/* ---------- 编辑并解析 ---------- */
async function handleParse() {
  const value = $('url').value.trim();
  if (!value) return toast('请先输入视频链接', 'error');

  const button = $('parseBtn');
  button.disabled = true;
  button.textContent = '解析中…';

  try {
    const res = await api.parseVideo(value);
    if (!res.ok) return toast(res.error, 'error');

    state.video = res.data;
    state.pages = res.data.pages || [];
    state.page = null;
    state.subtitles = [];
    state.lines = [];
    state.preview = null;

    renderVideo();
    const initial =
      state.pages.find((page) => page.page === res.data.initialPage) || state.pages[0];
    if (initial) await selectPage(initial);
  } finally {
    button.disabled = false;
    button.textContent = '解析';
  }
}

/* ---------- 扫码登录 ---------- */
function openModal(id) {
  $(id).classList.remove('hidden');
}

function closeModal(id) {
  $(id).classList.add('hidden');
  if (id === 'qrModal') {
    clearTimeout(state.pollTimer);
    state.pollTimer = null;
  }
}

async function startQrLogin() {
  const res = await api.qrGenerate();
  if (!res.ok) return toast(res.error, 'error');

  $('qrImg').src = res.data.image;
  $('qrStatus').textContent = '请使用 B 站手机客户端扫码';
  openModal('qrModal');
  pollQr(res.data.key);
}

async function pollQr(key) {
  clearTimeout(state.pollTimer);
  const res = await api.qrPoll(key);
  if (!res.ok) {
    $('qrStatus').textContent = res.error;
    return;
  }

  const status = res.data.status;
  if (status === 'success') {
    state.login = res.data.user;
    renderAccount();
    closeModal('qrModal');
    toast('登录成功', 'success');
    if (state.page) await selectPage(state.page);
    return;
  }
  if (status === 'expired') {
    $('qrStatus').textContent = '二维码已过期，请关闭后重新打开';
    return;
  }
  $('qrStatus').textContent = status === 'scanned' ? '已扫码，请在手机上确认登录' : '等待扫码…';
  state.pollTimer = setTimeout(() => pollQr(key), 2000);
}

async function saveCookie() {
  const text = $('cookieInput').value.trim();
  if (!text) return toast('请粘贴 Cookie 或 SESSDATA', 'error');

  const button = $('cookieSave');
  button.disabled = true;
  button.textContent = '验证中…';
  const res = await api.setCookie(text);
  button.disabled = false;
  button.textContent = '保存并验证';

  if (!res.ok) return toast(res.error, 'error');

  state.login = res.data;
  renderAccount();
  $('cookieInput').value = '';
  closeModal('cookieModal');
  toast('登录成功', 'success');
  if (state.page) await selectPage(state.page);
}

/* ---------- 事件绑定 ---------- */
function bindEvents() {
  $('parseBtn').addEventListener('click', handleParse);
  $('url').addEventListener('keydown', (event) => {
    if (event.key === 'Enter') handleParse();
  });

  $('loginBtn').addEventListener('click', startQrLogin);
  $('logoutBtn').addEventListener('click', async () => {
    await api.logout();
    state.login = { isLogin: false, uname: '', face: '' };
    renderAccount();
    toast('已退出登录');
  });
  $('qrCookieBtn').addEventListener('click', () => {
    closeModal('qrModal');
    openModal('cookieModal');
  });
  $('cookieSave').addEventListener('click', saveCookie);

  document.querySelectorAll('[data-close]').forEach((button) => {
    button.addEventListener('click', () => {
      const modal = button.closest('.modal');
      if (modal) closeModal(modal.id);
    });
  });
  document.querySelectorAll('.modal').forEach((modal) => {
    modal.addEventListener('click', (event) => {
      if (event.target === modal) closeModal(modal.id);
    });
  });

  $('pickDir').addEventListener('click', async () => {
    const res = await api.chooseDir();
    if (!res.ok || !res.data) return;
    state.dir = res.data;
    $('dir').value = state.dir;
    await api.saveConfig({ lastDir: state.dir });
    updatePreview();
  });

  document.querySelectorAll('input[name="fmt"]').forEach((input) => {
    input.addEventListener('change', () => {
      api.saveConfig({ format: currentFormat() });
      updatePreview();
    });
  });
  $('fm').addEventListener('change', () => {
    api.saveConfig({ frontmatter: $('fm').checked });
    updatePreview();
  });

  $('lang').addEventListener('change', () => {
    if ($('lang').value) loadSubtitle($('lang').value);
  });

  $('retryBtn').addEventListener('click', () => {
    if (state.page) selectPage(state.page);
  });

  $('copyBtn').addEventListener('click', async () => {
    if (!state.preview) return;
    await navigator.clipboard.writeText(state.preview.markdown);
    toast('已复制 Markdown 内容', 'success');
  });

  $('exportBtn').addEventListener('click', handleExport);

  $('cover').addEventListener('error', () => {
    $('cover').style.visibility = 'hidden';
  });
}

async function init() {
  bindEvents();

  const res = await api.getConfig();
  if (res.ok) {
    state.dir = res.data.lastDir || '';
    $('dir').value = state.dir;
    const format = res.data.format === 'plain' ? 'plain' : 'timestamp';
    const radio = document.querySelector(`input[name="fmt"][value="${format}"]`);
    if (radio) radio.checked = true;
    $('fm').checked = res.data.frontmatter !== false;
    $('fmtBadge').textContent = format === 'plain' ? '纯文本' : '时间戳';
  }

  await refreshLogin();
}

init();
