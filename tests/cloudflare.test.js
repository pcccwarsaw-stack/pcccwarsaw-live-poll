import {test,after} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,readdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {unstable_dev} from 'wrangler';

const root=mkdtempSync(join(tmpdir(),'live-poll-cloudflare-'));
const origin='http://localhost:32188',secret='cloudflare-test-credential-32-characters';
let worker;
async function boot(){
  worker=await unstable_dev('cloudflare/worker.js',{config:'wrangler.jsonc',local:true,ip:'127.0.0.1',port:32188,
    persistTo:root,vars:{HOST_SECRET:secret,PUBLIC_ORIGIN:origin},logLevel:'error',
    experimental:{disableExperimentalWarning:true}});
}
async function stop(){if(worker){await worker.stop();worker=null;}}
after(stop);
async function req(path,method='GET',body,cookie){
  const r=await fetch(origin+path,{method,headers:{Origin:origin,...(body!==undefined?{'Content-Type':'application/json'}:{}),...(cookie?{Cookie:cookie}:{})},body:body===undefined?undefined:JSON.stringify(body)});
  return{status:r.status,data:await r.json(),cookie:r.headers.get('set-cookie')?.split(';')[0]};
}
const control=(s,action,host,extra={})=>req(`/api/events/${s.id}/control`,'POST',{action,roundId:s.roundId,position:s.position,status:s.status,...extra},host);
const vote=(s,guest,choice)=>req(`/api/events/${s.id}/vote`,'POST',{eventId:s.id,questionId:s.question.id,roundId:s.roundId,choice},guest);
function sqliteFiles(dir){return readdirSync(dir,{withFileTypes:true}).flatMap(x=>x.isDirectory()?sqliteFiles(join(dir,x.name)):x.name.endsWith('.sqlite')?[join(dir,x.name)]:[]);}
function savedStatus(id){
  for(const path of sqliteFiles(root)){
    const db=new DatabaseSync(path,{readOnly:true});
    try{if(db.prepare("SELECT name FROM sqlite_master WHERE name='events'").get())return db.prepare('SELECT status FROM events WHERE id=?').get(id)?.status;}finally{db.close();}
  }
  throw Error('No persisted events database found');
}
test('Cloudflare workerd + SQLite Durable Object 实际集成验证',async t=>{
  await boot();let host,a,b,people;
  await t.test('静态页面、安全请求来源、登录和持久题库',async()=>{
    const page=await fetch(origin+'/host');assert.equal(page.status,200);assert.match(await page.text(),/一起选/);
    assert.match(page.headers.get('content-security-policy'),/frame-ancestors 'none'/);
    assert.equal((await req('/api/events','POST',{name:'x'})).status,401);
    const csrf=await fetch(origin+'/api/login',{method:'POST',headers:{Origin:'https://bad.invalid','Content-Type':'application/json'},body:JSON.stringify({secret})});assert.equal(csrf.status,403);
    host=(await req('/api/login','POST',{secret})).cookie;assert.ok(host);
    const bank=(await req('/api/bank','GET',undefined,host)).data;bank[0].title='Cloudflare 持久题库 / Persistent bank';
    assert.equal((await req('/api/bank','PUT',bank,host)).status,200);
    a=(await req('/api/events','POST',{name:'Cloudflare A'},host)).data;b=(await req('/api/events','POST',{name:'Cloudflare B'},host)).data;
    assert.notEqual(a.id,b.id);
    const qr=await fetch(origin+`/api/events/${a.id}/qr`);assert.equal(qr.status,200);assert.match(await qr.text(),/<svg/);
  });
  await t.test('100 个真实匿名 Cookie、并发提交、首票锁定及隐藏分布',async()=>{
    people=await Promise.all(Array.from({length:100},()=>req('/api/join','POST',{code:a.code})));
    assert.ok(people.every(x=>x.status===200));assert.equal(new Set(people.map(x=>x.cookie)).size,100);
    a=(await control(a,'start',host)).data;assert.equal(a.votingDurationMs,5000);
    const votes=await Promise.all(people.map((p,i)=>vote(a,p.cookie,i%4)));assert.ok(votes.every(x=>x.status===200));
    const state=(await req(`/api/events/${a.id}/state`)).data;assert.equal(state.voted,100);assert.equal('result' in state,false);
    assert.equal((await vote(a,people[0].cookie,1)).status,409);assert.equal((await vote(a,people[0].cookie,0)).status,200);
    assert.equal((await req(`/api/events/${b.id}/state?participant=1`,'GET',undefined,people[0].cookie)).status,403);
    assert.equal((await req(`/api/events/${b.id}/state`)).data.voted,0);
    assert.equal((await control(a,'reveal',people[0].cookie)).status,401);
  });
  await t.test('持久 Alarm 在无人轮询时自动公布、截止后拒绝',async()=>{
    await new Promise(r=>setTimeout(r,Math.max(0,a.endsAt-Date.now()+450)));
    // Read the persisted SQLite file before making any HTTP state request.
    assert.equal(savedStatus(a.id),'results');
    assert.equal((await vote(a,people[0].cookie,0)).status,409);
    const result=(await req(`/api/events/${a.id}/state`)).data;
    assert.deepEqual(result.result.counts,[25,25,25,25]);assert.deepEqual(result.result.percentages,[25,25,25,25]);
    a=result;
  });
  await t.test('重新投票、旧轮拒绝、新题同步与结束',async()=>{
    const old=a;a=(await control(a,'revote',host,{confirm:true})).data;assert.notEqual(a.roundId,old.roundId);
    assert.equal((await vote(old,people[0].cookie,0)).status,409);assert.equal((await vote(a,people[0].cookie,2)).status,200);
    assert.equal((await vote(a,people[0].cookie,1)).status,409);
    assert.equal((await req(`/api/events/${a.id}/state?participant=1`,'GET',undefined,people[0].cookie)).data.choice,2);
    a=(await control(a,'reveal',host)).data;a=(await control(a,'next',host)).data;assert.equal(a.position,1);
    assert.equal((await req(`/api/events/${a.id}/state?participant=1`,'GET',undefined,people[0].cookie)).data.question.id,a.question.id);
    a=(await control(a,'end',host)).data;assert.equal(a.status,'ended');
    assert.equal((await control(a,'start',host)).status,409);
  });
  await t.test('workerd 完整重启后云端数据库、身份和历史恢复',async()=>{
    await stop();await boot();
    assert.equal((await req('/api/bank','GET',undefined,host)).data[0].title,'Cloudflare 持久题库 / Persistent bank');
    assert.equal((await req(`/api/events/${a.id}/history`,'GET',undefined,host)).data.length,2);
    assert.equal((await req(`/api/events/${a.id}/state?participant=1`,'GET',undefined,people[0].cookie)).data.status,'ended');
    assert.equal((await req(`/api/events/${b.id}/state`)).data.voted,0);
  });
  await t.test('可修改时长、1 秒持久 Alarm、结束总结和重新投票历史',async()=>{
    const qs=[{title:'总结并列 / Tied results',options:['A','B','C']},{title:'零票题 / No votes',options:['A','B']},{title:'未开始题 / Unplayed',options:['A','B']}];
    let c=(await req('/api/events','POST',{name:'可配置时长',votingSeconds:12,questions:qs},host)).data;
    const setting=(s,seconds,cookie=host)=>req(`/api/events/${s.id}/settings`,'PUT',{votingSeconds:seconds,roundId:s.roundId,position:s.position,status:s.status},cookie);
    assert.equal(c.votingSeconds,12);assert.equal((await setting(c,301)).status,400);assert.equal((await setting(c,6,people[0].cookie)).status,401);
    c=(await setting(c,6)).data;
    await Promise.all(people.slice(0,4).map(p=>req('/api/join','POST',{code:c.code},p.cookie)));
    c=(await control(c,'start',host)).data;assert.equal(c.votingDurationMs,6000);assert.equal((await setting(c,2)).status,409);
    assert.equal((await req(`/api/events/${c.id}/summary`,'GET',undefined,host)).status,409);assert.equal((await req(`/api/events/${c.id}/summary`)).status,401);
    assert.ok((await Promise.all(people.slice(0,4).map((p,i)=>vote(c,p.cookie,i<2?0:1)))).every(r=>r.status===200));
    c=(await control(c,'reveal',host)).data;assert.deepEqual(c.result.winners,[0,1]);
    const deadline=c.endsAt;c=(await setting(c,1)).data;assert.equal(c.endsAt,deadline);
    c=(await control(c,'revote',host,{confirm:true})).data;assert.equal(c.votingDurationMs,1000);assert.equal((await vote(c,people[0].cookie,2)).status,200);
    await new Promise(r=>setTimeout(r,Math.max(0,c.endsAt-Date.now()+450)));
    assert.equal(savedStatus(c.id),'results');assert.equal((await vote(c,people[0].cookie,1)).status,409);
    c=(await req(`/api/events/${c.id}/state`)).data;c=(await control(c,'next',host)).data;c=(await control(c,'start',host)).data;
    assert.equal(c.votingDurationMs,1000);c=(await control(c,'reveal',host)).data;c=(await control(c,'next',host)).data;c=(await control(c,'end',host)).data;
    const report=(await req(`/api/events/${c.id}/summary`,'GET',undefined,host)).data;
    assert.equal(report.joined,4);assert.equal(report.totalVotes,1);assert.equal(report.totalRounds,3);assert.equal(report.completedQuestions,2);
    assert.deepEqual(report.questions[0].finalResult.counts,[0,0,1]);assert.deepEqual(report.questions[0].rounds[0].winners,[0,1]);
    assert.deepEqual(report.questions[1].finalResult.percentages,[0,0]);assert.equal(report.questions[2].finalResult,null);
    assert.equal((await setting(c,5)).status,409);assert.equal((await req(`/api/events/${c.id}/summary`,'GET',undefined,people[0].cookie)).status,401);
    await stop();await boot();assert.deepEqual((await req(`/api/events/${c.id}/summary`,'GET',undefined,host)).data,report);
    assert.equal((await req(`/api/events/${c.id}/state`)).data.votingSeconds,1);assert.equal((await req(`/api/events/${b.id}/state`)).data.votingSeconds,5);
  });
  console.log('Cloudflare local persisted state: '+root);
});
