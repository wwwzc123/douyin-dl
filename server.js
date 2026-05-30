const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');

const PORT = 3456;
const agent = new https.Agent({ rejectUnauthorized: false });
const UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Mobile/15E148 Safari/604.1';

function fetchURL(url, opts = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    https.request({
      hostname: u.hostname, path: u.pathname + u.search,
      method: opts.method || 'GET', headers: opts.headers || {}, agent,
    }, res => {
      let body = '';
      res.on('data', c => body += c);
      res.on('end', () => resolve({
        ok: res.statusCode >= 200 && res.statusCode < 400,
        status: res.statusCode, headers: res.headers,
        text: () => Promise.resolve(body),
      }));
    }).on('error', reject).end();
  });
}

function serveHTML(res) {
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(fs.readFileSync(path.join(__dirname, 'index.html'), 'utf-8'));
}

function json(res, data, code = 200) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(data));
}

// 提取内容 ID 和类型
function extractInfo(input) {
  input = input.trim();
  let m = input.match(/v\.douyin\.com\/([A-Za-z0-9_]+)/);
  if (m) return { type: 'short', value: m[1] };
  m = input.match(/douyin\.com\/video\/(\d+)/);
  if (m) return { type: 'video', value: m[1] };
  m = input.match(/iesdouyin\.com\/share\/video\/(\d+)/);
  if (m) return { type: 'video', value: m[1] };
  m = input.match(/iesdouyin\.com\/share\/note\/(\d+)/);
  if (m) return { type: 'note', value: m[1] };
  if (/^\d{10,}$/.test(input)) return { type: 'video', value: input };
  return null;
}

// 解析短链接 -> { type, id }
async function resolveShort(code) {
  const resp = await fetchURL(`https://v.douyin.com/${code}/`, {
    headers: { 'User-Agent': UA },
  });
  const loc = resp.headers?.location || '';

  // 视频
  let m = loc.match(/share\/video\/(\d+)/);
  if (m) return { type: 'video', id: m[1] };
  // 图文
  m = loc.match(/share\/note\/(\d+)/);
  if (m) return { type: 'note', id: m[1] };

  // 从 body 中找
  const text = await resp.text();
  m = text.match(/share\/video\/(\d+)/);
  if (m) return { type: 'video', id: m[1] };
  m = text.match(/share\/note\/(\d+)/);
  if (m) return { type: 'note', id: m[1] };
  m = text.match(/video\/(\d+)/);
  if (m) return { type: 'video', id: m[1] };

  return null;
}

// 获取视频页面标题等信息
async function getPageInfo(videoId) {
  const resp = await fetchURL(`https://www.iesdouyin.com/share/video/${videoId}/`, {
    headers: { 'User-Agent': UA },
  });
  const html = await resp.text();
  // 提取标题
  const titleMatch = html.match(/<title>([^<]+)<\/title>/);
  const title = titleMatch ? titleMatch[1].replace(' - 抖音', '').trim() : '';
  // 提取描述
  const descMatch = html.match(/"desc"\s*:\s*"([^"]+)"/);
  const desc = descMatch ? descMatch[1] : title;
  // 提取封面
  const coverMatch = html.match(/"cover"\s*:\s*\{[^}]*"url_list"\s*:\s*\["([^"]+)"/);
  const cover = coverMatch ? coverMatch[1] : '';
  return { desc, cover };
}

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, `http://localhost:${PORT}`);

  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', '*');

  if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }
  if (req.method === 'GET' && u.pathname === '/') return serveHTML(res);

  if (req.method === 'GET' && u.pathname === '/api/parse') {
    const input = u.searchParams.get('url');
    if (!input) return json(res, { error: '请提供抖音视频链接' }, 400);

    try {
      const info = extractInfo(input);
      if (!info) return json(res, { error: '无效的抖音链接格式' }, 400);

      let contentType = info.type;
      let contentId = info.value;

      if (info.type === 'short') {
        const resolved = await resolveShort(info.value);
        if (!resolved) return json(res, { error: '短链接解析失败' }, 400);
        contentType = resolved.type;
        contentId = resolved.id;
      }

      console.log('解析:', contentType, contentId);

      const pageUrl = contentType === 'note'
        ? `https://www.iesdouyin.com/share/note/${contentId}/`
        : `https://www.douyin.com/video/${contentId}`;

      const label = contentType === 'note' ? '图文' : '视频';

      json(res, {
        type: contentType,
        contentId,
        desc: `抖音${label} #${contentId}`,
        downloadOptions: [
          { name: 'SnapTik', url: `https://snaptik.app/zh-cn?url=${encodeURIComponent(pageUrl)}` },
          { name: 'Douyin Downloader', url: `https://douyin.wtf/?url=${encodeURIComponent(pageUrl)}` },
          { name: 'SSSTik', url: `https://ssstik.io/zh?url=${encodeURIComponent(pageUrl)}` },
        ],
      });

    } catch (e) {
      console.error('错误:', e.message);
      json(res, { error: e.message }, 500);
    }
    return;
  }

  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'Not found' }));
});

server.listen(PORT, () => {
  console.log(`服务已启动: http://localhost:${PORT}`);
});
