const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = 3456;

// Douyin API 需要模拟移动端 User-Agent
const UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Mobile/15E148 Safari/604.1';

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

// 从分享链接中提取视频 ID 或短链 code
function extractId(input) {
  input = input.trim();
  // 短链接: https://v.douyin.com/xxxxx/
  const shortMatch = input.match(/v\.douyin\.com\/([A-Za-z0-9]+)/);
  if (shortMatch) return { type: 'short', value: shortMatch[1] };
  // 长链接: https://www.douyin.com/video/123456
  const longMatch = input.match(/douyin\.com\/video\/(\d+)/);
  if (longMatch) return { type: 'long', value: longMatch[1] };
  // 纯数字视频 ID
  if (/^\d{10,}$/.test(input)) return { type: 'long', value: input };
  return null;
}

// 跟随短链重定向获取真实 URL 和视频 ID
async function resolveShortLink(code) {
  const url = `https://v.douyin.com/${code}/`;
  const resp = await fetch(url, {
    method: 'GET',
    headers: { 'User-Agent': UA },
    redirect: 'manual',
  });
  const location = resp.headers.get('location') || '';
  const match = location.match(/video\/(\d+)/);
  if (match) return match[1];
  // 尝试从 body 中提取
  const text = await resp.text();
  const bodyMatch = text.match(/video\/(\d+)/);
  return bodyMatch ? bodyMatch[1] : null;
}

// 从抖音视频页面获取无水印视频地址
async function getVideoInfo(videoId) {
  const url = `https://www.douyin.com/video/${videoId}`;
  const resp = await fetch(url, {
    headers: {
      'User-Agent': UA,
      'Accept': 'text/html,application/xhtml+xml',
    },
  });
  const html = await resp.text();

  // 从页面中提取 RENDER_DATA (SSR 数据)
  const renderMatch = html.match(/<script id="RENDER_DATA"[^>]*>([^<]+)<\/script>/);
  if (!renderMatch) {
    // 尝试从 window._ROUTER_DATA 提取
    const routerMatch = html.match(/window\._ROUTER_DATA\s*=\s*({.+?});<\/script>/s);
    if (routerMatch) {
      try {
        const data = JSON.parse(routerMatch[1]);
        const videoData = data?.loaderData?.video?.[videoId];
        if (videoData?.video?.playAddr) {
          const playAddr = videoData.video.playAddr[0]?.src || videoData.video.playAddr;
          return {
            videoUrl: playAddr,
            noWatermarkUrl: playAddr,
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

  // 遍历数据结构找到视频信息
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

  const playAddr = typeof found.video.playAddr === 'string'
    ? found.video.playAddr
    : found.video.playAddr[0]?.src || found.video.playAddr[0];

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

  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');

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
      if (!extracted) return jsonResponse(res, { error: '无效的抖音链接' }, 400);

      let videoId = extracted.value;
      if (extracted.type === 'short') {
        videoId = await resolveShortLink(extracted.value);
        if (!videoId) return jsonResponse(res, { error: '短链接解析失败' }, 400);
      }

      const info = await getVideoInfo(videoId);
      jsonResponse(res, { ...info, videoId });
    } catch (e) {
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
