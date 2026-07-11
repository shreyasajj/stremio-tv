// Tiny static file server for developing/testing the UI in a plain browser:
//   npm run serve   ->  http://127.0.0.1:8099/ui/index.html
const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const PORT = process.env.PORT || 8099;

const TYPES = {
  '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript',
  '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.webm': 'video/webm', '.mp4': 'video/mp4',
  '.vtt': 'text/vtt', '.srt': 'application/x-subrip',
};

function createServer() {
  return http.createServer((req, res) => {
    const urlPath = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    let file = path.normalize(path.join(ROOT, urlPath));
    if (!file.startsWith(ROOT)) { res.writeHead(403); res.end(); return; }
    if (fs.existsSync(file) && fs.statSync(file).isDirectory()) file = path.join(file, 'index.html');
    fs.readFile(file, (err, data) => {
      if (err) { res.writeHead(404); res.end('not found'); return; }
      res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream' });
      res.end(data);
    });
  });
}

module.exports = { createServer, PORT };

if (require.main === module) {
  createServer().listen(PORT, () => console.log(`serving ${ROOT} on http://127.0.0.1:${PORT}/ui/index.html`));
}
