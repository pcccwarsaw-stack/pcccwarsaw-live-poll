import http from 'node:http';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync,mkdirSync} from 'node:fs';
import {dirname,resolve} from 'node:path';
import {createApp,securityHeaders} from './src/app.js';
const origin=process.env.PUBLIC_ORIGIN||'http://localhost:3000';
if(process.env.NODE_ENV==='production'&&!origin.startsWith('https:'))throw Error('Production requires HTTPS PUBLIC_ORIGIN');
const file=process.env.DB_PATH||'./data/poll.sqlite';mkdirSync(dirname(resolve(file)),{recursive:true});
const db=new DatabaseSync(file);db.exec('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;');
const app=createApp({db,transaction:fn=>{db.exec('BEGIN IMMEDIATE');try{const r=fn();db.exec('COMMIT');return r;}catch(e){db.exec('ROLLBACK');throw e;}},secret:process.env.HOST_SECRET,origin,secure:process.env.COOKIE_SECURE==='true'||origin.startsWith('https:'),initialQuestions:JSON.parse(readFileSync(new URL('./questions.json',import.meta.url)))});
const timer=setInterval(()=>{try{app.expireRounds();}catch(e){console.error(e);}},100);timer.unref();
const server=http.createServer(async(req,res)=>{try{
const path=new URL(req.url,origin).pathname;
let response;
if(path.startsWith('/api/')||path==='/health'){
const init={method:req.method,headers:req.headers};if(!['GET','HEAD'].includes(req.method)){init.body=req;init.duplex='half';}
const request=new Request(new URL(req.url,origin),init);
const ip=process.env.TRUST_PROXY==='true'?(req.headers['x-forwarded-for']||req.socket.remoteAddress):req.socket.remoteAddress;
response=await app.fetch(request,ip);
}else{
const files={'/app.js':['app.js','text/javascript'],'/style.css':['style.css','text/css'],'/favicon.svg':['favicon.svg','image/svg+xml']};
const item=files[path]||(/^\/(?:host|join(?:\/\d{6})?|screen\/[a-f0-9]{36})?\/?$/.test(path)?['index.html','text/html']:null);
response=item&&req.method==='GET'?new Response(readFileSync(new URL('./public/'+item[0],import.meta.url)),{headers:{...securityHeaders,'Content-Type':item[1]+'; charset=utf-8'}}):new Response('Not found',{status:404,headers:securityHeaders});
}
res.writeHead(response.status,Object.fromEntries(response.headers));res.end(Buffer.from(await response.arrayBuffer()));
}catch(e){console.error(e);res.writeHead(500,securityHeaders);res.end('Server error');}});
server.listen(Number(process.env.PORT||3000),'0.0.0.0',()=>console.log('Live Poll listening on '+origin));
for(const sig of ['SIGTERM','SIGINT'])process.on(sig,()=>server.close(()=>{db.close();process.exit(0);}));
