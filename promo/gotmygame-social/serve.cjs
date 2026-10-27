// Same-origin server for the exported web build: static files + /api and /mcp proxied to the API on :4000. Usage: node serve.cjs <dist> [port]
const http=require('http'),fs=require('fs'),path=require('path');
const DIST=process.argv[2]||'/tmp/gmg-dist',PORT=+process.argv[3]||4100;
const T={'.js':'text/javascript','.html':'text/html','.css':'text/css','.json':'application/json','.png':'image/png','.ttf':'font/ttf','.ico':'image/x-icon'};
http.createServer((req,res)=>{
  if(req.url.startsWith('/api')||req.url.startsWith('/mcp')){const p=http.request({host:'127.0.0.1',port:4000,path:req.url,method:req.method,headers:req.headers},r=>{res.writeHead(r.statusCode,r.headers);r.pipe(res)});req.pipe(p);return}
  let f=path.join(DIST,decodeURIComponent(req.url.split('?')[0]));if(!fs.existsSync(f)||fs.statSync(f).isDirectory())f=path.join(DIST,'index.html');
  res.writeHead(200,{'content-type':T[path.extname(f)]||'application/octet-stream'});fs.createReadStream(f).pipe(res);
}).listen(PORT,()=>console.log('serving',DIST,PORT));
