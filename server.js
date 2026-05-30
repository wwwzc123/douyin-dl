const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');

const PORT = 3456;

// 本机 SSL 证书环境有问题，外部请求跳过证书验证
const insecureAgent = new https.Agent({ rejectUnauthorized: false });

const UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Mobile/15E148 Safari/604.1';

// 自定义 fetch 包装，使用 insecure agent
async function fetchWithAgent(url, opts = {}) {
  const urlObj = new URL(url);
  return new Promise((resolve, reject) => {
    const options = {
      hostname: urlObj.hostname,
      port: 443,
      path: urlObj.pathname + urlObj.search,
      method: opts.method || 'GET',
      headers: opts.headers || {},
      agent: insecureAgent,
    };
    const req = https.request(options, (res) => {
      let body = '';
      res.on('data', c => body += c);
      res.on('end', () => {
        resolve({
          ok: res.statusCode >= 200 && res.statusCode < 400,
          status: res.statusCode,
          headers: res.headers,
          text: () => Promise.resolve(body),
          json: () => { try { return Promise.resolve(JSON.parse(body)); } catch(e) { return Promise.reject(e); } },
        });
      });
    });
    req.on('error', reject);
    if (opts.body) req.write(opts.body);
    req.end();
  });
}

function serveHTML(res) {
  const html = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf-8');
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(html);
}

function serve404(res) {
  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'Not found' }));
}

function jsonResponse(res, data, code = 200) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(data));
}

function extractId(input) {
  input = input.trim();
  const shortMatch = input.match(/v\.douyin\.com\/([A-Za-z0-9]+)/);
  if (shortMatch) return { type: 'short', value: shortMatch[1] };
  const longMatch = input.match(/douyin\.com\/video\/(\d+)/);
  if (longMatch) return { type: 'long', value: longMatch[1] };
  if (/^\d{10,}$/.test(input)) return { type: 'long', value: input };
  return null;
}

async function resolveShortLink(code) {
  const url = `https://v.douyin.com/${code}/`;
  const resp = await fetchWithAgent(url, {
    method: 'GET',
    headers: { 'User-Agent': UA },
  });
  // 从最终 URL 或响应体提取 video id
  const location = resp.headers?.location || '';
  const match = location.match(/video\/(\d+)/);
  if (match) return match[1];
  // 有些短链会返回 HTML
  const text = await resp.text();
  const bodyMatch = text.match(/video\/(\d+)/);
  return bodyMatch ? bodyMatch[1] : null;
}

async function getVideoInfo(videoId) {
  const url = `https://www.douyin.com/video/${videoId}`;
  const resp = await fetchWithAgent(url, {
    headers: {
      'User-Agent': UA,
      'Accept': 'text/html,application/xhtml+xml',
    },
  });
  const html = await resp.text();

  // 尝试 RENDER_DATA
  const renderMatch = html.match(/<script id="RENDER_DATA"[^>]*>([^<]+)<\/script>/);
  if (!renderMatch) {
    // 尝试 _ROUTER_DATA
    const routerMatch = html.match(/window\._ROUTER_DATA\s*=\s*({.+?});<\/script>/s);
    if (routerMatch) {
      try {
        const data = JSON.parse(routerMatch[1]);
        const videoData = data?.loaderData?.video?.[videoId];
        if (videoData?.video?.playAddr) {
          const addr = typeof videoData.video.playAddr === 'string'
            ? videoData.video.playAddr
            : videoData.video.playAddr[0]?.src || videoData.video.playAddr[0];
          return {
            videoUrl: addr,
            noWatermarkUrl: addr,
            desc: videoData.desc || '',
            cover: videoData.video?.cover?.urlList?.[0] || '',
          };
        }
      } catch (e) {}
    }
    throw new Error('无法解析视频数据，抖音页面结构可能已更新');
  }

  const raw = decodeURIComponent(renderMatch[1]);
  const data = JSON.parse(raw);

  function findVideo(obj, depth = 0) {
    if (!obj || depth > 15) return null;
    if (obj.video && obj.video.playAddr) return obj;
    for (const key of Object.keys(obj)) {
      if (typeof obj[key] === 'object') {
        const found = findVideo(obj[key], depth + 1);
        if (found) return found;
      }
    }
    return null;
  }

  const found = findVideo(data);
  if (!found) throw new Error('找不到视频播放地址');

  let playAddr = '';
  if (typeof found.video.playAddr === 'string') {
    playAddr = found.video.playAddr;
  } else if (Array.isArray(found.video.playAddr)) {
    playAddr = found.video.playAddr[0]?.src || found.video.playAddr[0];
  }

  if (!playAddr) throw new Error('播放地址为空');

  return {
    videoUrl: playAddr,
    noWatermarkUrl: playAddr,
    desc: found.desc || '',
    cover: found.video?.cover?.urlList?.[0] || found.video?.cover || '',
  };
}

const server = http.createServer(async (req, res) => {
  const urlObj = new URL(req.url, `http://localhost:${PORT}`);

  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', '*');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    return res.end();
  }

  if (req.method === 'GET' && urlObj.pathname === '/') {
    return serveHTML(res);
  }

  if (req.method === 'GET' && urlObj.pathname === '/api/parse') {
    const input = urlObj.searchParams.get('url');
    if (!input) return jsonResponse(res, { error: '请提供抖音视频链接' }, 400);

    try {
      const extracted = extractId(input);
      if (!extracted) return jsonResponse(res, { error: '无效的抖音链接，请粘贴完整的分享链接' }, 400);

      let videoId = extracted.value;
      if (extracted.type === 'short') {
        videoId = await resolveShortLink(extracted.value);
        if (!videoId) return jsonResponse(res, { error: '短链接解析失败，请尝试粘贴完整链接' }, 400);
      }

      console.log('解析视频 ID:', videoId);
      const info = await getVideoInfo(videoId);
      console.log('成功获取视频:', info.desc?.substring(0, 30));
      jsonResponse(res, { ...info, videoId });
    } catch (e) {
      console.error('解析错误:', e.message);
      jsonResponse(res, { error: e.message || '解析失败' }, 500);
    }
    return;
  }

  serve404(res);
});

server.listen(PORT, () => {
  console.log(`服务已启动: http://localhost:${PORT}`);
  console.log('在浏览器打开上面的地址，粘贴抖音分享链接即可下载');
});
