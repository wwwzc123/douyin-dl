const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const { execFile, execSync } = require('child_process');

const PORT = 3456;
const YTDLP = path.join(__dirname, 'yt-dlp.exe');
const DOWNLOADS = path.join(__dirname, 'downloads');
if (!fs.existsSync(DOWNLOADS)) fs.mkdirSync(DOWNLOADS);

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

async function resolveShort(code) {
  const resp = await fetchURL(`https://v.douyin.com/${code}/`, {
    headers: { 'User-Agent': UA },
  });
  const loc = resp.headers?.location || '';
  let m = loc.match(/share\/video\/(\d+)/);
  if (m) return { type: 'video', id: m[1] };
  m = loc.match(/share\/note\/(\d+)/);
  if (m) return { type: 'note', id: m[1] };
  const text = await resp.text();
  m = text.match(/share\/video\/(\d+)/) || text.match(/video\/(\d+)/);
  if (m) return { type: 'video', id: m[1] };
  m = text.match(/share\/note\/(\d+)/);
  if (m) return { type: 'note', id: m[1] };
  return null;
}

// 用 yt-dlp 下载视频，返回 { filePath, title }
function ytdlpDownload(url, cookiesPath) {
  return new Promise((resolve, reject) => {
    const outTmpl = path.join(DOWNLOADS, '%(id)s.%(ext)s');
    const args = ['--no-playlist', '-o', outTmpl, '--print', 'after_move:filepath', url];
    if (cookiesPath && fs.existsSync(cookiesPath)) {
      args.unshift('--cookies', cookiesPath);
    }

    const child = execFile(YTDLP, args, { timeout: 120000, maxBuffer: 1024 * 1024 * 5 }, (err, stdout, stderr) => {
      if (err) {
        // 如果需要 cookies，yt-dlp 会提示
        const msg = (stderr || err.message || '').replace(/\n/g, ' ');
        reject(new Error(msg.substring(0, 300)));
        return;
      }
      // yt-dlp 用 --print 输出文件路径
      const filePath = (stdout || '').trim().split('\n').pop();
      if (filePath && fs.existsSync(filePath)) {
        resolve({ filePath });
      } else {
        reject(new Error('下载完成但找不到文件'));
      }
    });
  });
}

async function handler(req, res) {
  const u = new URL(req.url, `http://localhost:${PORT}`);

  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', '*');
  res.setHeader('Access-Control-Expose-Headers', 'Content-Disposition');

  if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }

  // 首页
  if (req.method === 'GET' && u.pathname === '/') {
    return serveHTML(res);
  }

  // 解析链接
  if (req.method === 'GET' && u.pathname === '/api/parse') {
    const input = u.searchParams.get('url');
    if (!input) return json(res, { error: '请提供抖音链接' }, 400);

    try {
      const info = extractInfo(input);
      if (!info) return json(res, { error: '无效的链接格式' }, 400);

      let contentType = info.type;
      let contentId = info.value;

      if (info.type === 'short') {
        const resolved = await resolveShort(info.value);
        if (!resolved) return json(res, { error: '短链接解析失败' }, 400);
        contentType = resolved.type;
        contentId = resolved.id;
      }

      const pageUrl = contentType === 'note'
        ? `https://www.iesdouyin.com/share/note/${contentId}/`
        : `https://www.douyin.com/video/${contentId}`;

      const label = contentType === 'note' ? '图文' : '视频';

      json(res, {
        type: contentType,
        contentId,
        desc: `抖音${label} #${contentId}`,
        videoUrl: `https://www.douyin.com/video/${contentId}`,
        downloadDirect: `/api/download?url=${encodeURIComponent(pageUrl)}`,
        downloadSites: [
          { name: 'SnapTik', url: `https://snaptik.app/zh-cn?url=${encodeURIComponent(pageUrl)}` },
          { name: 'Douyin Downloader', url: `https://douyin.wtf/?url=${encodeURIComponent(pageUrl)}` },
          { name: 'SSSTik', url: `https://ssstik.io/zh?url=${encodeURIComponent(pageUrl)}` },
          { name: 'TikMate', url: `https://tikmate.cc/zh?url=${encodeURIComponent(pageUrl)}` },
          { name: 'TikFast', url: `https://tikfast.net/?url=${encodeURIComponent(pageUrl)}` },
          { name: 'SaveTik', url: `https://savetik.app/?url=${encodeURIComponent(pageUrl)}` },
          { name: 'DouVideo', url: `https://douvideo.com/download?url=${encodeURIComponent(pageUrl)}` },
          { name: 'DownTik', url: `https://downtik.io/?url=${encodeURIComponent(pageUrl)}` },
        ],
      });
    } catch (e) {
      json(res, { error: e.message }, 500);
    }
    return;
  }

  // 直接下载
  if (req.method === 'GET' && u.pathname === '/api/download') {
    const input = u.searchParams.get('url');
    if (!input) return json(res, { error: '请提供链接' }, 400);
    const cookies = u.searchParams.get('cookies') || '';

    try {
      // 如果用户提供了 cookies，先写临时文件
      let cookiePath = null;
      if (cookies) {
        cookiePath = path.join(DOWNLOADS, '.cookies.txt');
        fs.writeFileSync(cookiePath, cookies);
      }

      console.log('开始下载:', input);
      const result = await ytdlpDownload(input, cookiePath);
      const filename = path.basename(result.filePath);
      console.log('下载完成:', filename);

      res.writeHead(200, {
        'Content-Type': 'video/mp4',
        'Content-Disposition': `attachment; filename="${encodeURIComponent(filename)}"`,
        'Content-Length': fs.statSync(result.filePath).size,
      });

      const stream = fs.createReadStream(result.filePath);
      stream.pipe(res);
      stream.on('end', () => {
        // 下载完成后清理文件
        setTimeout(() => {
          try { fs.unlinkSync(result.filePath); } catch (e) {}
        }, 60000);
      });
    } catch (e) {
      const msg = e.message || '';
      if (msg.includes('cookies') || msg.includes('Cookie')) {
        json(res, {
          error: '需要抖音 Cookies 才能下载。请按以下步骤操作：',
          needCookies: true,
          guide: '1. 安装浏览器扩展 "Get cookies.txt"\n2. 在浏览器打开 douyin.com 并登录\n3. 点击扩展导出 cookies\n4. 粘贴到本工具的 cookies 输入框',
        }, 403);
      } else {
        json(res, { error: '下载失败: ' + msg }, 500);
      }
    }
    return;
  }

  // 上传 cookies 文件
  if (req.method === 'POST' && u.pathname === '/api/cookies') {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      const cookiePath = path.join(DOWNLOADS, '.cookies.txt');
      fs.writeFileSync(cookiePath, body);
      console.log('Cookies 已保存');
      json(res, { ok: true });
    });
    return;
  }

  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'Not found' }));
}

const server = http.createServer(handler);
server.listen(PORT, () => console.log(`http://localhost:${PORT}`));
