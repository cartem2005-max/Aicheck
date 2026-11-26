// Отдаёт eval/results/ext_detect_input.json на localhost с CORS — только для ручной проверки внешних детекторов в браузере.
const http = require('http');
const fs = require('fs');
const path = require('path');
http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Private-Network', 'true');
  if (req.method === 'OPTIONS') { res.writeHead(204, { 'Access-Control-Allow-Headers': '*' }); return res.end(); }
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(fs.readFileSync(path.join(__dirname, 'results', 'ext_detect_input.json')));
}).listen(8765, '127.0.0.1', () => console.log('ok 8765'));
