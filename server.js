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

// 提取视频 ID
function extractVideoId(input) {
  input = input.trim();
  let m = input.match(/v\.douyin\.com\/([A-Za-z0-9]+)/);
  if (m) return { type: 'short', value: m[1] };
  m = input.match(/douyin\.com\/video\/(\d+)/);
  if (m) return { type: 'long', value: m[1] };
  m = input.match(/iesdouyin\.com\/share\/video\/(\d+)/);
  if (m) return { type: 'long', value: m[1] };
  if (/^\d{10,}$/.test(input)) return { type: 'long', value: input };
  return null;
}

// 解析短链接
async function resolveShort(code) {
  const resp = await fetchURL(`https://v.douyin.com/${code}/`, {
    headers: { 'User-Agent': UA },
  });
  const loc = resp.headers?.location || '';
  let m = loc.match(/(?:share\/)?video\/(\d+)/);
  if (m) return m[1];
  const text = await resp.text();
  m = text.match(/video\/(\d+)/);
  return m ? m[1] : null;
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
      const extracted = extractVideoId(input);
      if (!extracted) return json(res, { error: '无效的抖音链接格式' }, 400);

      let videoId = extracted.value;
      if (extracted.type === 'short') {
        videoId = await resolveShort(extracted.value);
        if (!videoId) return json(res, { error: '短链接解析失败，请尝试复制完整链接' }, 400);
      }

      console.log('解析视频:', videoId);

      // 获取页面信息
      const info = await getPageInfo(videoId);
      console.log('标题:', info.desc?.substring(0, 30));

      const videoUrl = `https://www.douyin.com/video/${videoId}`;

      // 提供多个下载入口
      json(res, {
        videoId,
        desc: info.desc || '抖音视频 #' + videoId,
        cover: info.cover,
        // 几个在线下载网站
        downloadOptions: [
          { name: 'SnapTik', url: `https://snaptik.app/zh-cn?url=${encodeURIComponent(videoUrl)}` },
          { name: 'Douyin Downloader', url: `https://douyin.wtf/?url=${encodeURIComponent(videoUrl)}` },
          { name: 'SSSTik', url: `https://ssstik.io/zh?url=${encodeURIComponent(videoUrl)}` },
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
