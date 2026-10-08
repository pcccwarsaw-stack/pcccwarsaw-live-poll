import http from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { randomBytes, createHash, timingSafeEqual } from 'node:crypto';
import { readFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import QRCode from 'qrcode';

const origin = process.env.PUBLIC_ORIGIN || 'http://localhost:3000';
if (new URL(origin).origin !== origin) throw Error('PUBLIC_ORIGIN must be an origin without trailing slash');
const secret = process.env.HOST_SECRET;
if (!secret || secret.length < 24) throw Error('HOST_SECRET must contain at least 24 characters');
const secure = process.env.COOKIE_SECURE === 'true' || origin.startsWith('https:');
if (process.env.NODE_ENV === 'production' && !origin.startsWith('https:')) throw Error('Production requires HTTPS PUBLIC_ORIGIN');
const file = process.env.DB_PATH || './data/poll.sqlite'; mkdirSync(dirname(resolve(file)), {recursive:true});
const db = new DatabaseSync(file);
db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
CREATE TABLE IF NOT EXISTS bank(id INTEGER PRIMARY KEY CHECK(id=1), json TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS sessions(token TEXT PRIMARY KEY, role TEXT NOT NULL, expires INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS events(id TEXT PRIMARY KEY, code TEXT UNIQUE NOT NULL, name TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'waiting', position INTEGER NOT NULL DEFAULT 0, round_id TEXT, created INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS questions(id TEXT PRIMARY KEY,event_id TEXT NOT NULL REFERENCES events(id),position INTEGER NOT NULL,title TEXT NOT NULL,options TEXT NOT NULL,locked INTEGER NOT NULL DEFAULT 0,UNIQUE(event_id,position));
CREATE TABLE IF NOT EXISTS rounds(id TEXT PRIMARY KEY,event_id TEXT NOT NULL REFERENCES events(id),question_id TEXT NOT NULL REFERENCES questions(id),status TEXT NOT NULL,created INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS members(event_id TEXT NOT NULL REFERENCES events(id),session TEXT NOT NULL REFERENCES sessions(token),PRIMARY KEY(event_id,session));
CREATE TABLE IF NOT EXISTS votes(round_id TEXT NOT NULL REFERENCES rounds(id),session TEXT NOT NULL REFERENCES sessions(token),choice INTEGER NOT NULL,PRIMARY KEY(round_id,session));
CREATE TABLE IF NOT EXISTS limits(key TEXT PRIMARY KEY,window INTEGER NOT NULL,count INTEGER NOT NULL);`);
const get=(s,...p)=>db.prepare(s).get(...p), all=(s,...p)=>db.prepare(s).all(...p), run=(s,...p)=>db.prepare(s).run(...p);
const VOTING_DURATION_MS=5000;
// Migrate existing databases without resetting activities or votes.
if(!all('PRAGMA table_info(rounds)').some(c=>c.name==='closes_at'))db.exec('ALTER TABLE rounds ADD COLUMN closes_at INTEGER');
run("UPDATE rounds SET closes_at=created+? WHERE closes_at IS NULL",VOTING_DURATION_MS);
const id=()=>randomBytes(18).toString('hex'); const hash=v=>createHash('sha256').update(v).digest('hex');
function fail(status,message){throw Object.assign(Error(message),{status});}
function tx(fn){db.exec('BEGIN IMMEDIATE');try{const r=fn();db.exec('COMMIT');return r;}catch(e){db.exec('ROLLBACK');throw e;}}
function expireRounds(){
const now=Date.now();
if(!get("SELECT id FROM rounds WHERE status='voting' AND closes_at<=? LIMIT 1",now))return;
tx(()=>{
run("UPDATE events SET status='results' WHERE status='voting' AND round_id IN (SELECT id FROM rounds WHERE status='voting' AND closes_at<=?)",now);
run("UPDATE rounds SET status='results' WHERE status='voting' AND closes_at<=?",now);
});
}
expireRounds();
// Deadlines live in SQLite; this timer only makes idle activities close promptly.
const expiryTimer=setInterval(()=>{try{expireRounds();}catch(e){console.error('Round expiry failed',e);}},100);
expiryTimer.unref();
export function percentages(counts){const total=counts.reduce((a,b)=>a+b,0);if(!total)return counts.map(()=>0);const raw=counts.map(n=>n*100/total),out=raw.map(Math.floor);const order=raw.map((v,i)=>({i,r:v-out[i]})).sort((a,b)=>b.r-a.r||a.i-b.i);for(let n=100-out.reduce((a,b)=>a+b,0),i=0;i<n;i++)out[order[i].i]++;return out;}
function validate(qs){if(!Array.isArray(qs)||qs.length<1||qs.length>100)fail(400,'题库必须包含 1–100 道题');return qs.map((q,i)=>{if(!q||typeof q.title!=='string'||!q.title.trim()||q.title.length>500)fail(400,`第 ${i+1} 题：title 必须是 1–500 字符字符串`);if(!Array.isArray(q.options)||q.options.length<2||q.options.length>6||q.options.some(o=>typeof o!=='string'||!o.trim()||o.length>200))fail(400,`第 ${i+1} 题：options 必须是 2–6 个非空字符串，每项最多 200 字符`);return{title:q.title.trim(),options:q.options.map(o=>o.trim())};});}
if(!get('SELECT * FROM bank'))run('INSERT INTO bank VALUES(1,?)',JSON.stringify(validate(JSON.parse(readFileSync(new URL('./questions.json',import.meta.url))))));
function limit(key,max){const w=Math.floor(Date.now()/60000);const row=get(`INSERT INTO limits VALUES(?,?,1) ON CONFLICT(key) DO UPDATE SET window=excluded.window,count=CASE WHEN limits.window=excluded.window THEN limits.count+1 ELSE 1 END RETURNING count`,hash(key),w);if(row.count>max)fail(429,'操作过于频繁，请稍后重试');if(Math.random()<0.01)run('DELETE FROM limits WHERE window<?',w-2);}
function cookie(req,name){return (req.headers.cookie||'').split(';').map(x=>x.trim().split('=')).find(x=>x[0]===name)?.[1];}
function session(req,role){const t=cookie(req,role==='host'?'lp_host':'lp_guest');const s=t&&get('SELECT * FROM sessions WHERE token=? AND role=? AND expires>?',hash(t),role,Date.now());if(!s)fail(401,role==='host'?'请先登录主持人':'请重新加入活动');return s.token;}
function setCookie(res,name,value,age){res.setHeader('Set-Cookie',`${name}=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${age}${secure?'; Secure':''}`);}
function event(e){const r=get('SELECT * FROM events WHERE id=?',e);if(!r)fail(404,'活动不存在');return r;}
function results(r){const q=get('SELECT * FROM questions WHERE id=?',r.question_id);const options=JSON.parse(q.options),counts=options.map(()=>0);for(const v of all('SELECT choice,COUNT(*) AS n FROM votes WHERE round_id=? GROUP BY choice',r.id))counts[v.choice]=v.n;const pct=percentages(counts),max=Math.max(...counts);return{roundId:r.id,questionId:q.id,title:q.title,options,total:counts.reduce((a,b)=>a+b,0),counts,percentages:pct,winners:max?counts.map((v,i)=>v===max?i:-1).filter(i=>i>=0):[]};}
function state(e,s){const q=get('SELECT * FROM questions WHERE event_id=? AND position=?',e.id,e.position);const r=e.round_id&&get('SELECT * FROM rounds WHERE id=?',e.round_id);return{id:e.id,code:e.code,name:e.name,status:e.status,position:e.position,totalQuestions:get('SELECT COUNT(*) AS n FROM questions WHERE event_id=?',e.id).n,joined:get('SELECT COUNT(*) AS n FROM members WHERE event_id=?',e.id).n,question:q?{id:q.id,title:q.title,options:JSON.parse(q.options),locked:!!q.locked}:null,roundId:r?.id||null,endsAt:r?.closes_at||null,serverTime:Date.now(),votingDurationMs:VOTING_DURATION_MS,voted:r?get('SELECT COUNT(*) AS n FROM votes WHERE round_id=?',r.id).n:0,choice:s&&r?get('SELECT choice FROM votes WHERE round_id=? AND session=?',r.id,s)?.choice??null:null,...(r&&r.status==='results'?{result:results(r)}:{}),participantUrl:`${origin}/join/${e.code}`,screenUrl:`${origin}/screen/${e.id}`};}
async function body(req){let b='';for await(const c of req){b+=c;if(b.length>150000)fail(413,'请求过大');}let value;try{value=JSON.parse(b||'{}');}catch{fail(400,'JSON 格式错误');}if(!value||typeof value!=='object')fail(400,'请求 JSON 必须为对象或题库数组');return value;}
const json=(res,status,data)=>{res.writeHead(status,{'Content-Type':'application/json; charset=utf-8'});res.end(JSON.stringify(data));};
const server=http.createServer(async(req,res)=>{
res.setHeader('Cache-Control','no-store');res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Referrer-Policy','no-referrer');res.setHeader('X-Frame-Options','DENY');res.setHeader('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
try{
const u=new URL(req.url,origin),path=u.pathname,method=req.method;
if(method!=='GET'&&method!=='HEAD'&&req.headers.origin!==origin)fail(403,'请求来源不匹配');
expireRounds();
// Never trust user-supplied forwarded IP headers. Caddy proxy client identity is enabled only explicitly.
const ip=process.env.TRUST_PROXY==='true'?(req.headers['x-forwarded-for']||req.socket.remoteAddress):req.socket.remoteAddress;
if(path==='/api/login'&&method==='POST'){limit('login:'+ip,10);const b=await body(req);const a=Buffer.from(hash(String(b.secret||''))),z=Buffer.from(hash(secret));if(!timingSafeEqual(a,z))fail(401,'管理凭证错误');const token=id();run('INSERT INTO sessions VALUES(?,?,?)',hash(token),'host',Date.now()+86400000);setCookie(res,'lp_host',token,86400);return json(res,200,{ok:true});}
if(path==='/api/logout'&&method==='POST'){const t=cookie(req,'lp_host');if(t)run('DELETE FROM sessions WHERE token=? AND role=?',hash(t),'host');setCookie(res,'lp_host','',0);return json(res,200,{ok:true});}
if(path==='/api/join'&&method==='POST'){limit('join:'+ip,240);const b=await body(req);if(typeof b.code!=='string'||!/^\d{6}$/.test(b.code))fail(400,'活动码必须是 6 位数字');const e=get('SELECT * FROM events WHERE code=?',b.code);if(!e)fail(404,'活动码不存在');let s;try{s=session(req,'guest');}catch{const token=id();s=hash(token);run('INSERT INTO sessions VALUES(?,?,?)',s,'guest',Date.now()+30*86400000);setCookie(res,'lp_guest',token,30*86400);}run('INSERT OR IGNORE INTO members VALUES(?,?)',e.id,s);return json(res,200,state(e,s));}
if(path==='/api/bank'){session(req,'host');if(method==='GET')return json(res,200,JSON.parse(get('SELECT json FROM bank').json));if(method==='PUT'){const qs=validate(await body(req));run('UPDATE bank SET json=?',JSON.stringify(qs));return json(res,200,{ok:true});}}
if(path==='/api/events'){session(req,'host');if(method==='GET')return json(res,200,all('SELECT id,code,name,status,created FROM events ORDER BY created DESC'));if(method==='POST'){limit('create:'+ip,10);const b=await body(req);if(typeof b.name!=='string'||!b.name.trim()||b.name.length>100)fail(400,'活动名称必须为 1–100 字符');const qs=validate(b.questions===undefined?JSON.parse(get('SELECT json FROM bank').json):b.questions);const e=tx(()=>{const eid=id();let code;do{code=String(100000+randomBytes(4).readUInt32BE()%900000);}while(get('SELECT id FROM events WHERE code=?',code));run('INSERT INTO events(id,code,name,created) VALUES(?,?,?,?)',eid,code,b.name.trim(),Date.now());qs.forEach((q,i)=>run('INSERT INTO questions VALUES(?,?,?,?,?,0)',id(),eid,i,q.title,JSON.stringify(q.options)));return event(eid);});return json(res,201,state(e));}}
const m=path.match(/^\/api\/events\/([a-f0-9]{36})(?:\/(state|vote|control|questions|history|qr))?$/);
if(m){const e=event(m[1]),action=m[2];
if(method==='GET'&&action==='state'){let s; if(u.searchParams.get('participant')==='1'){s=session(req,'guest');if(!get('SELECT * FROM members WHERE event_id=? AND session=?',e.id,s))fail(403,'尚未加入此活动');}return json(res,200,state(e,s));}
if(method==='GET'&&action==='qr'){res.writeHead(200,{'Content-Type':'image/svg+xml'});return res.end(await QRCode.toString(`${origin}/join/${e.code}`,{type:'svg',margin:2,width:240,color:{dark:'#123c32',light:'#ffffff'}}));}
if(method==='POST'&&action==='vote'){const s=session(req,'guest');limit('vote:'+s,60);const b=await body(req);tx(()=>{const fresh=event(e.id);if(!get('SELECT * FROM members WHERE event_id=? AND session=?',e.id,s))fail(403,'未加入此活动');const r=get('SELECT * FROM rounds WHERE id=?',fresh.round_id);if(b.eventId!==e.id||fresh.status!=='voting'||!r||r.status!=='voting'||Date.now()>=r.closes_at||b.roundId!==r.id||b.questionId!==r.question_id)fail(409,'当前轮次未开放或已结束，请同步后重试');const q=get('SELECT * FROM questions WHERE id=?',r.question_id);if(!Number.isInteger(b.choice)||b.choice<0||b.choice>=JSON.parse(q.options).length)fail(400,'选项无效');run('INSERT INTO votes VALUES(?,?,?) ON CONFLICT(round_id,session) DO UPDATE SET choice=excluded.choice',r.id,s,b.choice);});return json(res,200,state(event(e.id),s));}
session(req,'host');
if(method==='GET'&&action==='history')return json(res,200,all("SELECT * FROM rounds WHERE event_id=? AND status='results' ORDER BY created",e.id).map(results));
if(method==='GET'&&action==='questions')return json(res,200,all('SELECT * FROM questions WHERE event_id=? ORDER BY position',e.id).map(q=>({...q,options:JSON.parse(q.options)})));
if(method==='PUT'&&action==='questions'){const qs=validate(await body(req));tx(()=>{const fresh=event(e.id);if(fresh.status==='ended')fail(409,'活动已结束');const old=all('SELECT * FROM questions WHERE event_id=? ORDER BY position',e.id);for(const q of old.filter(q=>q.locked)){const n=qs[q.position];if(!n||n.title!==q.title||JSON.stringify(n.options)!==q.options)fail(409,`第 ${q.position+1} 题已开放，不能修改、删除或移动`);}if(qs.length<=fresh.position)fail(409,'不能删除当前题目');qs.forEach((q,i)=>{if(old[i])run('UPDATE questions SET title=?,options=? WHERE id=?',q.title,JSON.stringify(q.options),old[i].id);else run('INSERT INTO questions VALUES(?,?,?,?,?,0)',id(),e.id,i,q.title,JSON.stringify(q.options));});for(const q of old.slice(qs.length))run('DELETE FROM questions WHERE id=?',q.id);});return json(res,200,{ok:true});}
if(method==='POST'&&action==='control'){const b=await body(req);tx(()=>{const f=event(e.id);if(f.status==='ended')fail(409,'活动已结束');if(b.roundId!==f.round_id||b.position!==f.position||b.status!==f.status)fail(409,'状态已变化，请同步后操作');if(b.action==='start'||b.action==='revote'){if(b.action==='start'&&f.status!=='waiting')fail(409,'只能开始等待中的题目');if(b.action==='revote'&&(f.status!=='results'||b.confirm!==true))fail(409,'重新投票必须确认，并先结束当前投票');const q=get('SELECT * FROM questions WHERE event_id=? AND position=?',e.id,f.position),rid=id();const now=Date.now();run('INSERT INTO rounds(id,event_id,question_id,status,created,closes_at) VALUES(?,?,?,?,?,?)',rid,e.id,q.id,'voting',now,now+VOTING_DURATION_MS);run('UPDATE questions SET locked=1 WHERE id=?',q.id);run("UPDATE events SET status='voting',round_id=? WHERE id=?",rid,e.id);}else if(b.action==='reveal'){if(f.status!=='voting')fail(409,'当前不在投票中');run("UPDATE rounds SET status='results' WHERE id=?",f.round_id);run("UPDATE events SET status='results' WHERE id=?",e.id);}else if(b.action==='next'){if(f.status!=='results')fail(409,'请先公布结果');if(!get('SELECT id FROM questions WHERE event_id=? AND position=?',e.id,f.position+1))fail(409,'已是最后一题，请结束活动');run("UPDATE events SET status='waiting',position=position+1,round_id=NULL WHERE id=?",e.id);}else if(b.action==='end'){if(f.status==='voting')run("UPDATE rounds SET status='results' WHERE id=?",f.round_id);run("UPDATE events SET status='ended' WHERE id=?",e.id);}else fail(400,'未知控制操作');});return json(res,200,state(event(e.id)));}
}
if(method==='GET'&&path==='/health')return json(res,200,{ok:!!get('SELECT 1')});
if(method==='GET'){const files={'/app.js':['app.js','text/javascript'],'/style.css':['style.css','text/css'],'/favicon.svg':['favicon.svg','image/svg+xml']};const item=files[path]||(/^\/(?:host|join(?:\/\d{6})?|screen\/[a-f0-9]{36})?\/?$/.test(path)?['index.html','text/html']:null);if(item){res.writeHead(200,{'Content-Type':`${item[1]}; charset=utf-8`});return res.end(readFileSync(new URL('./public/'+item[0],import.meta.url)));}}
fail(404,'页面或接口不存在');
}catch(e){if(!e.status)console.error(e);json(res,e.status||500,{error:e.status?e.message:'服务器错误'});}
});
server.listen(Number(process.env.PORT||3000),'0.0.0.0',()=>console.log(`Live Poll listening on ${origin}`));
for(const sig of ['SIGTERM','SIGINT'])process.on(sig,()=>server.close(()=>{db.close();process.exit(0);}));
