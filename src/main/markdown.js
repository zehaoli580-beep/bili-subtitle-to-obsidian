'use strict';

function pad2(value) {
  return String(value).padStart(2, '0');
}

function formatTime(seconds) {
  const total = Math.max(0, Math.floor(Number(seconds) || 0));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return h > 0 ? `${h}:${pad2(m)}:${pad2(s)}` : `${pad2(m)}:${pad2(s)}`;
}

function nowStamp() {
  const d = new Date();
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(
    d.getMinutes(),
  )}`;
}

function sanitizeName(name) {
  return String(name || '')
    .replace(/[\\/:*?"<>|\r\n\t]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[. ]+$/, '')
    .slice(0, 60)
    .trim();
}

function buildFilename(video, page, pageCount) {
  const base = sanitizeName(video.title) || '未命名视频';
  if (pageCount > 1) {
    const part = sanitizeName(page.part);
    const suffix = part && part !== base ? ` - P${page.page} ${part}` : ` - P${page.page}`;
    return `${base}${suffix}.md`;
  }
  return `${base}.md`;
}

/** 纯文本模式：把逐句字幕按标点合并成自然段，便于直接喂给 AI */
function toParagraphs(lines) {
  const paragraphs = [];
  let buffer = '';
  for (const line of lines) {
    buffer += line.content;
    const endsSentence = /[。！？!?；;…]$/.test(line.content);
    if ((endsSentence && buffer.length >= 60) || buffer.length >= 180) {
      paragraphs.push(buffer.trim());
      buffer = '';
    }
  }
  if (buffer.trim()) paragraphs.push(buffer.trim());
  return paragraphs;
}

function buildMarkdown({ video, page, pageCount, lines, options }) {
  const { withFrontmatter = true, format = 'timestamp' } = options || {};
  const url = `https://www.bilibili.com/video/${video.bvid}?p=${page.page}`;
  const duration = formatTime(page.duration || 0);
  const multi = pageCount > 1;
  const heading = multi ? `${video.title} · P${page.page} ${page.part}` : video.title;
  const out = [];

  if (withFrontmatter) {
    out.push('---');
    out.push(`title: ${JSON.stringify(video.title)}`);
    out.push(`up主: ${JSON.stringify(video.owner || '')}`);
    out.push(`bvid: ${video.bvid}`);
    out.push(`url: ${url}`);
    if (multi) out.push(`分P: ${JSON.stringify(`P${page.page} ${page.part}`)}`);
    out.push(`时长: ${JSON.stringify(duration)}`);
    out.push(`导出时间: ${JSON.stringify(nowStamp())}`);
    out.push('tags: [bilibili, 字幕]');
    out.push('---');
    out.push('');
  }

  out.push(`# ${heading}`, '');
  out.push(`> 来源：[${video.bvid}](${url}) ｜ UP主：${video.owner || '未知'} ｜ 时长：${duration}`, '');

  if (format === 'plain') {
    for (const paragraph of toParagraphs(lines)) out.push(paragraph, '');
  } else {
    for (const line of lines) {
      out.push(`[${formatTime(line.from)}](${url}&t=${Math.floor(line.from)}) ${line.content}`);
    }
    out.push('');
  }

  return out.join('\n');
}

module.exports = { formatTime, buildFilename, buildMarkdown, toParagraphs };
