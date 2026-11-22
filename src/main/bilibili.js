'use strict';

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
const REFERER = 'https://www.bilibili.com/';
const TIMEOUT = 15000;

class BiliError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'BiliError';
    this.code = code;
  }
}

/** 统一发起请求：B 站接口对 Referer / UA 敏感 */
async function request(url, options = {}) {
  const { cookieHeader, referer = REFERER } = options;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT);
  const headers = {
    'User-Agent': UA,
    Referer: referer,
    // 缺少 Origin 时 B 站接口会直接返回 412 风控
    Origin: 'https://www.bilibili.com',
    Accept: 'application/json, text/plain, */*',
    'Accept-Language': 'zh-CN,zh;q=0.9',
  };
  if (cookieHeader) headers.Cookie = cookieHeader;
  try {
    return await fetch(url, { headers, redirect: 'follow', signal: controller.signal });
  } catch (err) {
    if (err.name === 'AbortError') throw new BiliError('请求超时，请检查网络后重试');
    throw new BiliError('网络请求失败：' + err.message);
  } finally {
    clearTimeout(timer);
  }
}

async function readJson(res, message) {
  if (!res.ok) throw new BiliError(`${message}（HTTP ${res.status}）`);
  try {
    return await res.json();
  } catch {
    throw new BiliError(`${message}：返回内容无法解析`);
  }
}

function normalizeSubtitleUrl(url) {
  if (!url) return '';
  return url.startsWith('//') ? 'https:' + url : url;
}

/** 短链最多跟随 4 跳，拿到真实视频地址 */
async function followShortLink(shortUrl) {
  let current = shortUrl;
  for (let i = 0; i < 4; i += 1) {
    const res = await fetch(current, {
      headers: { 'User-Agent': UA },
      redirect: 'manual',
    });
    const next = res.headers.get('location');
    if (!next) break;
    current = new URL(next, current).href;
    if (/bilibili\.com\/video\//i.test(current)) break;
  }
  return current;
}

/** 支持 BV 号 / av 号 / 完整链接 / b23.tv 短链，并解析分P参数 */
async function resolveTarget(input) {
  const raw = String(input || '').trim();
  if (!raw) throw new BiliError('请输入视频链接');

  let text = raw;
  const shortMatch = raw.match(/(?:https?:\/\/)?b23\.tv\/[A-Za-z0-9]+/i);
  if (shortMatch) {
    const link = shortMatch[0].startsWith('http') ? shortMatch[0] : 'https://' + shortMatch[0];
    text = await followShortLink(link);
  }

  const bv = text.match(/BV[0-9A-Za-z]{10}/);
  const av = text.match(/\bav(\d+)/i);
  const pageMatch = text.match(/[?&]p=(\d+)/);
  const page = pageMatch ? Number(pageMatch[1]) : 1;

  if (bv) return { bvid: bv[0], page };
  if (av) return { aid: Number(av[1]), page };
  throw new BiliError('无法识别的链接，请确认是 B 站视频地址');
}

async function getVideoInfo({ bvid, aid, cookieHeader }) {
  const query = bvid ? `bvid=${encodeURIComponent(bvid)}` : `aid=${aid}`;
  const res = await request(`https://api.bilibili.com/x/web-interface/view?${query}`, { cookieHeader });
  const json = await readJson(res, '获取视频信息失败');
  if (json.code !== 0) throw new BiliError(json.message || '获取视频信息失败', json.code);
  return json.data;
}

async function getSubtitleList(bvid, cid, cookieHeader) {
  const url = `https://api.bilibili.com/x/player/v2?bvid=${encodeURIComponent(bvid)}&cid=${encodeURIComponent(cid)}`;
  const res = await request(url, { cookieHeader });
  const json = await readJson(res, '获取字幕列表失败');
  if (json.code !== 0) throw new BiliError(json.message || '获取字幕列表失败', json.code);

  const subtitle = (json.data && json.data.subtitle) || {};
  const list = (subtitle.subtitles || [])
    .map((item) => ({
      lan: item.lan,
      lanDoc: item.lan_doc || item.lan,
      url: normalizeSubtitleUrl(item.subtitle_url),
      ai: String(item.lan || '').startsWith('ai-') || Number(item.ai_type) > 0,
    }))
    .filter((item) => item.url);

  return { list, needLogin: Boolean(subtitle.need_login_subtitle) };
}

async function getSubtitleBody(url, cookieHeader) {
  if (!url) throw new BiliError('字幕地址为空');
  const res = await request(url, { cookieHeader, referer: 'https://www.bilibili.com/video/' });
  const json = await readJson(res, '下载字幕失败');
  const lines = (json.body || [])
    .map((item) => ({
      from: Number(item.from) || 0,
      to: Number(item.to) || 0,
      content: String(item.content || '').trim(),
    }))
    .filter((item) => item.content);
  if (!lines.length) throw new BiliError('该字幕内容为空');
  return lines;
}

/**
 * B 站 AI 字幕接口存在随机返回错误内容的线上问题：
 * 同一个 cid 连续请求，subtitle_url 每次指向不同文件，可能是别的视频的字幕，
 * 也可能直接返回空。用「字幕结束时间 / 视频时长」+「字数密度」做校验，
 * 不达标就换一轮重新请求。
 */
const SUBTITLE_MAX_ROUNDS = 8;
const SUBTITLE_MAX_DOWNLOADS = 8;
const MIN_DENSITY = 1; // 每秒至少 1 个字
const MIN_COVERAGE = 0.5; // 字幕至少要覆盖一半时长
const MAX_COVERAGE = 1.1; // 超过总时长说明是别的视频
const MIN_RELEVANCE = 0.15; // 标题关键词命中率下限，低于它基本不是本视频
const LAN_PREFERENCE = ['zh-CN', 'zh-Hans', 'ai-zh', 'zh-Hant', 'ai-zh-Hant', 'en-US'];

function inspectSubtitle(lines, duration) {
  const seconds = Number(duration) || 0;
  const chars = lines.reduce((total, line) => total + line.content.length, 0);
  const maxTo = lines.reduce((max, line) => Math.max(max, Number(line.to) || 0), 0);
  const density = seconds > 0 ? chars / seconds : chars / 60;
  const coverage = seconds > 0 ? maxTo / seconds : 1;
  const healthy =
    lines.length > 0 && density >= MIN_DENSITY && coverage >= MIN_COVERAGE && coverage <= MAX_COVERAGE;
  return { density, coverage, healthy };
}

/** 排序权重：健康优先，其次覆盖率接近 1，最后看密度 */
function rankSubtitle(info) {
  if (info.healthy) return 1000 + info.density;
  const coverageScore = Math.max(0, 1 - Math.abs(info.coverage - 1));
  return coverageScore * 10 + Math.min(info.density, 6) / 100;
}

const TITLE_STOP_TOKENS = new Set([
  '我的', '我们', '你们', '他们', '这个', '那个', '什么', '怎么', '如何', '到底',
  '以及', '还有', '就是', '不是', '可以', '一个', '这期', '视频', '一下',
]);

/** 从标题里抽 2-gram 关键词，用来判断字幕是不是真的在讲这个视频 */
function titleTokens(title) {
  const text = String(title || '').toLowerCase();
  const tokens = new Set();
  for (const word of text.match(/[a-z][a-z0-9+#.]{1,}/g) || []) tokens.add(word);
  for (const run of text.match(/[\u4e00-\u9fa5]+/g) || []) {
    for (let i = 0; i + 1 < run.length; i += 1) tokens.add(run.slice(i, i + 2));
  }
  return [...tokens].filter((token) => !TITLE_STOP_TOKENS.has(token));
}

function titleRelevance(lines, title) {
  const tokens = titleTokens(title);
  if (!tokens.length) return { ratio: 0, total: 0 };
  const text = lines.map((line) => line.content).join('').toLowerCase();
  const hits = tokens.filter((token) => text.includes(token)).length;
  return { ratio: hits / tokens.length, total: tokens.length };
}

function isSuspiciousSubtitle(lines, duration, title) {
  if (!inspectSubtitle(lines, duration).healthy) return true;
  const rel = titleRelevance(lines, title);
  return rel.total >= 4 && rel.ratio < MIN_RELEVANCE;
}

function sortByPreference(list) {
  const rank = (item) => {
    const index = LAN_PREFERENCE.indexOf(item.lan);
    return index === -1 ? 99 : index;
  };
  return [...list].sort((a, b) => rank(a) - rank(b));
}

async function getBestSubtitle({ bvid, cid, duration, title, cookieHeader }) {
  const seen = new Map();
  let best = null;
  let needLogin = false;
  let downloads = 0;
  let lastError = null;

  for (let round = 0; round < SUBTITLE_MAX_ROUNDS; round += 1) {
    let list = [];
    try {
      const result = await getSubtitleList(bvid, cid, cookieHeader);
      list = result.list;
      needLogin = needLogin || result.needLogin;
    } catch (err) {
      lastError = err;
      continue;
    }
    for (const item of list) seen.set(item.lan, item);

    for (const item of sortByPreference(list)) {
      if (downloads >= SUBTITLE_MAX_DOWNLOADS) break;
      downloads += 1;
      let lines;
      try {
        lines = await getSubtitleBody(item.url, cookieHeader);
      } catch {
        continue;
      }
      const info = inspectSubtitle(lines, duration);
      const rel = titleRelevance(lines, title);
      // 时长对不上、或标题关键词几乎没命中，都算不上合格结果
      const strong = info.healthy && (rel.total < 4 || rel.ratio >= MIN_RELEVANCE);
      const rank =
        (info.healthy ? 1000 : 0) +
        rel.ratio * 200 +
        Math.min(info.density, 6) +
        (info.healthy ? 0 : Math.max(0, 1 - Math.abs(info.coverage - 1)) * 10);
      if (!best || rank > best.rank) best = { ...item, lines, info, rel, rank, strong };
      if (strong) break;
    }
    if (best && best.strong) break;
  }

  if (!best && lastError) throw lastError;

  const listOut = Array.from(seen.values()).map(({ lan, lanDoc, url, ai }) => ({ lan, lanDoc, url, ai }));
  if (best) {
    const hit = listOut.find((item) => item.lan === best.lan);
    if (hit) hit.url = best.url;
    else listOut.unshift({ lan: best.lan, lanDoc: best.lanDoc, url: best.url, ai: best.ai });
  }

  return {
    list: listOut,
    lines: best ? best.lines : [],
    chosenUrl: best ? best.url : '',
    suspicious: Boolean(best && !best.strong),
    needLogin,
  };
}

async function getNav(cookieHeader) {
  const res = await request('https://api.bilibili.com/x/web-interface/nav', { cookieHeader });
  const json = await readJson(res, '获取登录状态失败');
  const data = json.data || {};
  return {
    isLogin: Boolean(data.isLogin),
    uname: data.uname || '',
    face: data.face || '',
    mid: data.mid || 0,
  };
}

async function qrGenerate() {
  const res = await request(
    'https://passport.bilibili.com/x/passport-login/web/qrcode/generate?source=main-fe-header',
  );
  const json = await readJson(res, '生成登录二维码失败');
  if (json.code !== 0) throw new BiliError(json.message || '生成登录二维码失败', json.code);
  return { url: json.data.url, key: json.data.qrcode_key };
}

/** 从 Set-Cookie 中提取 Cookie 键值对 */
function extractSetCookies(res) {
  let raw = [];
  if (typeof res.headers.getSetCookie === 'function') {
    raw = res.headers.getSetCookie();
  } else {
    const joined = res.headers.get('set-cookie');
    if (joined) raw = joined.split(/,(?=\s*[A-Za-z_]+=)/);
  }
  const out = {};
  for (const line of raw) {
    const pair = line.split(';')[0];
    const index = pair.indexOf('=');
    if (index > 0) out[pair.slice(0, index).trim()] = pair.slice(index + 1).trim();
  }
  return out;
}

/** 扫码成功后跨域地址里也带着 Cookie，作为兜底来源 */
function cookiesFromCrossDomain(urlText) {
  const out = {};
  try {
    const parsed = new URL(urlText);
    for (const key of ['SESSDATA', 'bili_jct', 'DedeUserID', 'DedeUserID__ckMd5', 'sid']) {
      const value = parsed.searchParams.get(key);
      if (value) out[key] = value;
    }
  } catch {
    /* 忽略解析失败 */
  }
  return out;
}

const QR_STATUS = { 86101: 'waiting', 86090: 'scanned', 86038: 'expired' };

async function qrPoll(qrcodeKey) {
  const url = `https://passport.bilibili.com/x/passport-login/web/qrcode/poll?qrcode_key=${encodeURIComponent(
    qrcodeKey,
  )}&source=main-fe-header`;
  const res = await request(url);
  const json = await readJson(res, '查询扫码状态失败');
  const data = json.data || {};
  const code = Number(data.code);

  if (code === 0) {
    const cookies = { ...extractSetCookies(res), ...cookiesFromCrossDomain(data.url || '') };
    return { status: 'success', cookies };
  }
  return { status: QR_STATUS[code] || 'error', message: data.message || json.message || '扫码登录失败' };
}

/** 支持粘贴完整 Cookie 字符串，或只粘贴 SESSDATA 值 */
function parseCookieInput(text) {
  const out = {};
  const raw = String(text || '').trim();
  if (!raw) return out;
  if (raw.includes('=')) {
    for (const part of raw.split(';')) {
      const index = part.indexOf('=');
      if (index > 0) out[part.slice(0, index).trim()] = part.slice(index + 1).trim();
    }
  } else {
    out.SESSDATA = raw;
  }
  return out;
}

module.exports = {
  BiliError,
  resolveTarget,
  getVideoInfo,
  getSubtitleList,
  getSubtitleBody,
  getBestSubtitle,
  isSuspiciousSubtitle,
  getNav,
  qrGenerate,
  qrPoll,
  parseCookieInput,
};
