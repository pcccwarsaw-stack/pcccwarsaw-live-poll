import {test,after} from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtempSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
const root=mkdtempSync(join(tmpdir(),'live-poll-test-')),port=32187,origin=`http://localhost:${port}`,secret='test-only-credential-32-characters';
let child;
async function boot(){child=spawn(process.execPath,['server.js'],{env:{...process.env,HOST_SECRET:secret,PUBLIC_ORIGIN:origin,PORT:String(port),DB_PATH:join(root,'db.sqlite'),COOKIE_SECURE:'false'},stdio:['ignore','pipe','pipe']});let log='';child.stderr.on('data',d=>log+=d);for(let i=0;i<100;i++){try{if((await fetch(origin+'/health')).ok)return;}catch{}if(child.exitCode!==null)throw Error(log);await new Promise(r=>setTimeout(r,50));}throw Error('Server did not start: '+log);}
async function stop(){if(!child||child.exitCode!==null)return;const done=new Promise(r=>child.once('exit',r));child.kill();await done;}
after(stop);
async function req(path,method='GET',body,cookie){const r=await fetch(origin+path,{method,headers:{Origin:origin,...(body!==undefined?{'Content-Type':'application/json'}:{}),...(cookie?{Cookie:cookie}:{})},body:body===undefined?undefined:JSON.stringify(body)});return {status:r.status,data:await r.json(),cookie:r.headers.get('set-cookie')?.split(';')[0]};}
const control=async(s,action,cookie,extra={})=>req(`/api/events/${s.id}/control`,'POST',{action,roundId:s.roundId,position:s.position,status:s.status,...extra},cookie);
const vote=(s,cookie,choice)=>req(`/api/events/${s.id}/vote`,'POST',{eventId:s.id,questionId:s.question.id,roundId:s.roundId,choice},cookie);
test('完整流程、100 人并发、持久恢复、安全与活动隔离',async t=>{
await boot();let host,event,other,people,s,old;
await t.test('未授权控制和跨站请求被拒绝',async()=>{assert.equal((await req('/api/events','POST',{name:'no'})).status,401);assert.equal((await req('/api/login','POST',null)).status,400);const r=await fetch(origin+'/api/login',{method:'POST',headers:{Origin:'https://attacker.invalid','Content-Type':'application/json'},body:JSON.stringify({secret})});assert.equal(r.status,403);assert.equal((await req('/api/login','POST',{secret:'bad'})).status,401);});
await t.test('登录、题库校验与持久保存、创建两个活动',async()=>{const login=await req('/api/login','POST',{secret});host=login.cookie;assert.equal(login.status,200);const qs=JSON.parse(readFileSync('questions.json'));qs[0].title='持久保存验证 / Persistent bank verification';assert.equal((await req('/api/bank','PUT',[{title:'bad',options:['one']}],host)).status,400);assert.equal((await req('/api/bank','PUT',qs,host)).status,200);const a=await req('/api/events','POST',{name:'测试 A'},host),b=await req('/api/events','POST',{name:'测试 B'},host);assert.equal(a.status,201);event=a.data;other=b.data;assert.notEqual(event.code,other.code);assert.equal(event.totalQuestions,10);});
await t.test('100 个独立匿名身份加入、二维码实际编码链接',async()=>{people=await Promise.all(Array.from({length:100},()=>req('/api/join','POST',{code:event.code})));assert.ok(people.every(p=>p.status===200));assert.equal(new Set(people.map(p=>p.cookie)).size,100);const qr=await fetch(origin+`/api/events/${event.id}/qr`);assert.equal(qr.headers.get('content-type'),'image/svg+xml');assert.match(await qr.text(),/<svg/);assert.equal((await req(`/api/events/${other.id}/state?participant=1`,'GET',undefined,people[0].cookie)).status,403);assert.equal((await vote(event,people[0].cookie,0)).status,409);});
await t.test('开始后 100 人并发提交、接口隐藏分布',async()=>{s=(await control(event,'start',host)).data;assert.equal(s.status,'voting');const r=await Promise.all(people.map((p,i)=>vote(s,p.cookie,i%4)));assert.ok(r.every(x=>x.status===200));const state=(await req(`/api/events/${event.id}/state`)).data;assert.equal(state.voted,100);for(const k of ['result','counts','percentages','winners'])assert.equal(k in state,false);assert.equal((await req(`/api/events/${event.id}/history`)).status,401);assert.equal((await control(s,'reveal',people[0].cookie)).status,401);assert.equal((await req(`/api/events/${other.id}/state`)).data.voted,0);assert.equal((await vote(s,people[0].cookie,99)).status,400);});
await t.test('重复同选幂等、改投拒绝、首次选择锁定；已开放题锁定',async()=>{const r=await Promise.all(Array.from({length:20},(_,i)=>vote(s,people[0].cookie,i%4)));assert.ok(r.every((x,i)=>x.status===(i%4===0?200:409)));assert.equal((await vote(s,people[0].cookie,0)).status,200);assert.equal((await req(`/api/events/${event.id}/state?participant=1`,'GET',undefined,people[0].cookie)).data.choice,0);assert.equal((await req(`/api/events/${event.id}/state`)).data.voted,100);const qs=(await req(`/api/events/${event.id}/questions`,'GET',undefined,host)).data;qs[0].title='illegal';assert.equal((await req(`/api/events/${event.id}/questions`,'PUT',qs,host)).status,409);});
await t.test('结束与提交竞争由事务串行处理、25% 并列第一、关闭后拒绝',async()=>{const [end,r]=await Promise.all([control(s,'reveal',host),vote(s,people[0].cookie,0)]);assert.equal(end.status,200);assert.ok([200,409].includes(r.status));old=s;s=end.data;assert.deepEqual(s.result.counts,[25,25,25,25]);assert.deepEqual(s.result.percentages,[25,25,25,25]);assert.deepEqual(s.result.winners,[0,1,2,3]);assert.equal((await vote(old,people[0].cookie,1)).status,409);assert.equal((await control(old,'reveal',host)).status,409);});
await t.test('确认重新投票产生新轮次、旧轮拒绝、历史保留',async()=>{assert.equal((await control(s,'revote',host)).status,409);s=(await control(s,'revote',host,{confirm:true})).data;assert.notEqual(s.roundId,old.roundId);assert.equal(s.voted,0);assert.equal((await vote(old,people[0].cookie,0)).status,409);assert.equal((await vote(s,people[0].cookie,0)).status,200);s=(await control(s,'reveal',host)).data;assert.equal(s.result.total,1);assert.equal((await req(`/api/events/${event.id}/history`,'GET',undefined,host)).data.length,2);});
await t.test('下一题同步、身份刷新恢复、4/3/2/1 示例百分比、零票百分比',async()=>{s=(await control(s,'next',host)).data;assert.equal(s.position,1);assert.equal((await req(`/api/events/${event.id}/state?participant=1`,'GET',undefined,people[0].cookie)).data.question.id,s.question.id);s=(await control(s,'start',host)).data;assert.equal((await vote(s,people[0].cookie,2)).status,200);assert.equal((await req(`/api/events/${event.id}/state?participant=1`,'GET',undefined,people[0].cookie)).data.choice,2);s=(await control(s,'reveal',host)).data;s=(await control(s,'next',host)).data;s=(await control(s,'start',host)).data;s=(await control(s,'reveal',host)).data;assert.deepEqual(s.result.percentages,[0,0,0]);let b=(await control(other,'start',host)).data;const joined=await Promise.all(people.slice(0,10).map(p=>req('/api/join','POST',{code:other.code},p.cookie)));assert.ok(joined.every(x=>x.status===200));const choices=[0,0,0,0,1,1,1,2,2,3];await Promise.all(choices.map((c,i)=>vote(b,people[i].cookie,c)));b=(await control(b,'reveal',host)).data;assert.deepEqual(b.result.counts,[4,3,2,1]);assert.deepEqual(b.result.percentages,[40,30,20,10]);assert.equal((await req(`/api/events/${event.id}/state`)).data.voted,0);});
await t.test('真实服务进程重启恢复活动、题库、投票和匿名选择',async()=>{await stop();await boot();const bank=(await req('/api/bank','GET',undefined,host)).data;assert.equal(bank.length,10);assert.equal(bank[0].title,'持久保存验证 / Persistent bank verification');const current=(await req(`/api/events/${other.id}/state?participant=1`,'GET',undefined,people[0].cookie)).data;assert.equal(current.choice,0);assert.deepEqual(current.result.counts,[4,3,2,1]);assert.equal((await req('/api/events','GET',undefined,host)).data.length,2);});
await t.test('结束活动及结束后拒绝控制和投票',async()=>{const ended=await control(s,'end',host);assert.equal(ended.data.status,'ended');assert.equal((await control(ended.data,'start',host)).status,409);assert.equal((await vote(s,people[0].cookie,0)).status,409);});
await t.test('非整除百分比合计 100、限流实际生效',async()=>{let c=(await req('/api/events','POST',{name:'rounding'},host)).data;await Promise.all(people.slice(0,3).map(p=>req('/api/join','POST',{code:c.code},p.cookie)));c=(await control(c,'start',host)).data;await Promise.all(people.slice(0,3).map((p,i)=>vote(c,p.cookie,i)));c=(await control(c,'reveal',host)).data;assert.deepEqual(c.result.percentages,[34,33,33,0]);let r;for(let i=0;i<65;i++){r=await vote(old,people[99].cookie,0);if(r.status===429)break;}assert.equal(r.status,429);});
await t.test('5 秒自动公布、截止前选择锁定、无请求也截止、两活动倒计时隔离',async()=>{
let a=(await req('/api/events','POST',{name:'5 秒自动截止'},host)).data;
let b=(await req('/api/events','POST',{name:'独立倒计时'},host)).data;
await req('/api/join','POST',{code:a.code},people[0].cookie);
await req('/api/join','POST',{code:b.code},people[0].cookie);
a=(await control(a,'start',host)).data;
assert.equal(a.endsAt-a.serverTime<=5000,true);assert.equal(a.votingDurationMs,5000);
assert.equal((await vote(a,people[0].cookie,0)).status,200);
await new Promise(r=>setTimeout(r,1100));
b=(await control(b,'start',host)).data;
assert.ok(b.endsAt>a.endsAt);
assert.equal((await vote(a,people[0].cookie,1)).status,409);
await new Promise(r=>setTimeout(r,Math.max(0,a.endsAt-Date.now()+180)));
const saved=new DatabaseSync(join(root,'db.sqlite'),{readOnly:true});
assert.equal(saved.prepare('SELECT status FROM events WHERE id=?').get(a.id).status,'results');saved.close();
assert.equal((await vote(a,people[0].cookie,2)).status,409);
const result=(await req(`/api/events/${a.id}/state`)).data;
assert.deepEqual(result.result.counts,[1,0,0,0]);
assert.equal((await req(`/api/events/${b.id}/state`)).data.status,'voting');
assert.equal((await vote(b,people[0].cookie,3)).status,200);
await new Promise(r=>setTimeout(r,Math.max(0,b.endsAt-Date.now()+180)));
assert.deepEqual((await req(`/api/events/${b.id}/state`)).data.result.counts,[0,0,0,1]);
});
await t.test('5 秒截止时间跨重启保持；停机期间到期启动后立即公布',async()=>{
let a=(await req('/api/events','POST',{name:'重启倒计时'},host)).data;
await req('/api/join','POST',{code:a.code},people[1].cookie);
a=(await control(a,'start',host)).data;
assert.equal((await vote(a,people[1].cookie,2)).status,200);
await stop();await boot();
const resumed=(await req(`/api/events/${a.id}/state`)).data;
assert.equal(resumed.endsAt,a.endsAt);assert.equal(resumed.status,'voting');
await stop();await new Promise(r=>setTimeout(r,Math.max(0,a.endsAt-Date.now()+50)));await boot();
const result=(await req(`/api/events/${a.id}/state`)).data;
assert.equal(result.status,'results');assert.deepEqual(result.result.counts,[0,0,1,0]);
assert.equal((await vote(a,people[1].cookie,0)).status,409);
});
await t.test('旧数据库迁移保留投票和结果',async()=>{
await stop();const legacy=new DatabaseSync(join(root,'db.sqlite'));
legacy.exec('ALTER TABLE rounds DROP COLUMN closes_at');legacy.close();await boot();
const result=(await req(`/api/events/${other.id}/state`)).data;
assert.deepEqual(result.result.counts,[4,3,2,1]);
});
await t.test('同身份并发不同选项只保存首票；刷新与重启仍锁定',async()=>{
let a=(await req('/api/events','POST',{name:'首票锁定并发验证'},host)).data;
await req('/api/join','POST',{code:a.code},people[5].cookie);
a=(await control(a,'start',host)).data;
const attempts=await Promise.all(Array.from({length:20},(_,i)=>vote(a,people[5].cookie,i%4)));
let saved=(await req(`/api/events/${a.id}/state?participant=1`,'GET',undefined,people[5].cookie)).data;
assert.equal(saved.voted,1);assert.ok(Number.isInteger(saved.choice));
attempts.forEach((r,i)=>assert.equal(r.status,i%4===saved.choice?200:409));
const first=saved.choice;
await stop();await boot();
saved=(await req(`/api/events/${a.id}/state?participant=1`,'GET',undefined,people[5].cookie)).data;
assert.equal(saved.choice,first);assert.equal(saved.voted,1);
assert.equal((await vote(a,people[5].cookie,(first+1)%4)).status,409);
assert.equal((await vote(a,people[5].cookie,first)).status,200);
const final=(await control(saved,'reveal',host)).data;
assert.equal(final.result.total,1);assert.equal(final.result.counts[first],1);
});
console.log('Test DB (temporary): '+root);
});
