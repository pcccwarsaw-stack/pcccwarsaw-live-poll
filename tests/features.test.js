import {test,after} from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtempSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';

const root=mkdtempSync(join(tmpdir(),'live-poll-features-'));
const origin='http://localhost:32189',secret='feature-tests-only-32-characters';
let child;
async function boot(){
  child=spawn(process.execPath,['server.js'],{env:{...process.env,HOST_SECRET:secret,PUBLIC_ORIGIN:origin,PORT:'32189',DB_PATH:join(root,'db.sqlite'),COOKIE_SECURE:'false'},stdio:['ignore','pipe','pipe']});
  let log='';child.stderr.on('data',d=>log+=d);
  for(let i=0;i<100;i++){try{if((await fetch(origin+'/health')).ok)return;}catch{}if(child.exitCode!==null)throw Error(log);await new Promise(r=>setTimeout(r,50));}
  throw Error('Server did not start: '+log);
}
async function stop(){if(!child||child.exitCode!==null)return;const done=new Promise(r=>child.once('exit',r));child.kill();await done;}
after(stop);
async function req(path,method='GET',body,cookie){
  const r=await fetch(origin+path,{method,headers:{Origin:origin,...(body!==undefined?{'Content-Type':'application/json'}:{}),...(cookie?{Cookie:cookie}:{})},body:body===undefined?undefined:JSON.stringify(body)});
  return{status:r.status,data:await r.json(),cookie:r.headers.get('set-cookie')?.split(';')[0]};
}
const control=(s,action,host,extra={})=>req(`/api/events/${s.id}/control`,'POST',{action,roundId:s.roundId,position:s.position,status:s.status,...extra},host);
const settings=(s,votingSeconds,host)=>req(`/api/events/${s.id}/settings`,'PUT',{votingSeconds,roundId:s.roundId,position:s.position,status:s.status},host);
const vote=(s,guest,choice)=>req(`/api/events/${s.id}/vote`,'POST',{eventId:s.id,questionId:s.question.id,roundId:s.roundId,choice},guest);
const questions=[{title:'额外假期 / Day off',options:['睡觉 / Sleep','旅行 / Travel','聚会 / Meet friends']},{title:'零票验证 / No votes',options:['早起','晚睡']},{title:'尚未开始 / Unplayed',options:['A','B']}];

test('可修改时长与结束总结：真实 HTTP 和磁盘持久验证',async t=>{
  await boot();const host=(await req('/api/login','POST',{secret})).cookie;let a,b,c,d,people,old;
  await t.test('创建时配置、默认兼容和上下界输入校验',async()=>{
    assert.equal((await req('/api/events','POST',{name:'bad',votingSeconds:0},host)).status,400);
    assert.equal((await req('/api/events','POST',{name:'bad',votingSeconds:'30'},host)).status,400);
    a=(await req('/api/events','POST',{name:'总结测试',votingSeconds:30,questions},host)).data;
    b=(await req('/api/events','POST',{name:'独立活动',questions},host)).data;
    c=(await req('/api/events','POST',{name:'最短时长',votingSeconds:1,questions:questions.slice(0,1)},host)).data;
    d=(await req('/api/events','POST',{name:'最长时长',votingSeconds:300,questions:questions.slice(0,1)},host)).data;
    assert.equal(a.votingSeconds,30);assert.equal(a.votingDurationMs,30000);assert.equal(b.votingSeconds,5);assert.equal(c.votingSeconds,1);assert.equal(d.votingSeconds,300);
    for(const invalid of [0,-1,301,1.5,'10',null,true])assert.equal((await settings(a,invalid,host)).status,400);
    assert.equal((await settings(a,20)).status,401);
    a=(await settings(a,20,host)).data;assert.equal(a.votingSeconds,20);
    assert.equal((await req(`/api/events/${b.id}/state`)).data.votingSeconds,5);
  });
  await t.test('本轮时长冻结、匿名无权修改、公布前总结受保护',async()=>{
    people=await Promise.all(Array.from({length:4},()=>req('/api/join','POST',{code:a.code})));
    old=a;a=(await control(a,'start',host)).data;
    assert.equal(a.votingDurationMs,20000);assert.ok(a.endsAt-a.serverTime>19000);
    assert.equal((await settings(a,10,host)).status,409);assert.equal((await settings(old,10,host)).status,409);
    assert.equal((await settings(a,10,people[0].cookie)).status,401);
    assert.equal((await req(`/api/events/${a.id}/summary`,'GET',undefined,host)).status,409);
    assert.equal((await req(`/api/events/${a.id}/summary`)).status,401);
    assert.ok((await Promise.all(people.map((p,i)=>vote(a,p.cookie,i<2?0:1)))).every(r=>r.status===200));
    assert.equal('result' in (await req(`/api/events/${a.id}/state`)).data,false);
    await stop();await boot();
    const resumed=(await req(`/api/events/${a.id}/state`)).data;
    assert.equal(resumed.endsAt,a.endsAt);assert.equal(resumed.votingSeconds,20);assert.equal(resumed.status,'voting');
    a=(await control(resumed,'reveal',host)).data;assert.deepEqual(a.result.winners,[0,1]);
  });
  await t.test('改时长仅用于新轮次；重投历史保留，最后一轮合计不重复',async()=>{
    const deadline=a.endsAt;a=(await settings(a,12,host)).data;
    assert.equal(a.endsAt,deadline);assert.equal(a.votingDurationMs,20000);assert.equal(a.votingSeconds,12);
    const first=a;a=(await control(a,'revote',host,{confirm:true})).data;
    assert.equal(a.votingDurationMs,12000);assert.equal((await vote(first,people[0].cookie,2)).status,409);
    assert.equal((await vote(a,people[0].cookie,2)).status,200);
    a=(await control(a,'reveal',host)).data;a=(await control(a,'next',host)).data;
    a=(await control(a,'start',host)).data;assert.equal(a.votingDurationMs,12000);
    a=(await control(a,'reveal',host)).data;a=(await control(a,'next',host)).data;
    a=(await control(a,'end',host)).data;
    const report=(await req(`/api/events/${a.id}/summary`,'GET',undefined,host)).data;
    assert.equal(report.joined,4);assert.equal(report.completedQuestions,2);assert.equal(report.totalQuestions,3);assert.equal(report.totalRounds,3);assert.equal(report.totalVotes,1);
    assert.deepEqual(report.questions.map(q=>q.position),[0,1,2]);
    assert.deepEqual(report.questions[0].finalResult.counts,[0,0,1]);assert.equal(report.questions[0].finalResult.votingSeconds,12);
    assert.deepEqual(report.questions[0].rounds[0].counts,[2,2,0]);assert.deepEqual(report.questions[0].rounds[0].winners,[0,1]);
    assert.deepEqual(report.questions[1].finalResult.percentages,[0,0]);assert.deepEqual(report.questions[1].finalResult.winners,[]);
    assert.equal(report.questions[2].finalResult,null);assert.equal(report.questions[2].roundCount,0);
    assert.equal((await req(`/api/events/${a.id}/summary`,'GET',undefined,people[0].cookie)).status,401);
    assert.equal((await settings(a,15,host)).status,409);
    await stop();await boot();assert.deepEqual((await req(`/api/events/${a.id}/summary`,'GET',undefined,host)).data,report);
    assert.equal((await req(`/api/events/${a.id}/state`)).data.votingSeconds,12);
  });
  await t.test('1 秒真实自动截止及完整题目总结；300 秒配置和活动隔离',async()=>{
    const guest=(await req('/api/join','POST',{code:c.code})).cookie;
    c=(await control(c,'start',host)).data;assert.equal(c.votingDurationMs,1000);assert.equal((await vote(c,guest,0)).status,200);
    await new Promise(r=>setTimeout(r,Math.max(0,c.endsAt-Date.now()+200)));
    const saved=new DatabaseSync(join(root,'db.sqlite'),{readOnly:true});assert.equal(saved.prepare('SELECT status FROM events WHERE id=?').get(c.id).status,'results');saved.close();
    assert.equal((await vote(c,guest,1)).status,409);c=(await req(`/api/events/${c.id}/state`)).data;c=(await control(c,'end',host)).data;
    const report=(await req(`/api/events/${c.id}/summary`,'GET',undefined,host)).data;assert.equal(report.completedQuestions,report.totalQuestions);assert.equal(report.totalVotes,1);
    d=(await control(d,'start',host)).data;assert.equal(d.votingDurationMs,300000);d=(await control(d,'end',host)).data;
    assert.equal((await req(`/api/events/${d.id}/summary`,'GET',undefined,host)).data.totalVotes,0);
    b=(await control(b,'end',host)).data;const other=(await req(`/api/events/${b.id}/summary`,'GET',undefined,host)).data;
    assert.equal(other.totalVotes,0);assert.equal(other.totalRounds,0);assert.ok(other.questions.every(q=>q.finalResult===null));
  });
  await t.test('旧 events 表迁移默认 5 秒，现有结果不丢失',async()=>{
    await stop();const legacy=new DatabaseSync(join(root,'db.sqlite'));legacy.exec('ALTER TABLE events DROP COLUMN voting_seconds');legacy.close();await boot();
    assert.equal((await req(`/api/events/${a.id}/state`)).data.votingSeconds,5);
    const report=(await req(`/api/events/${a.id}/summary`,'GET',undefined,host)).data;
    assert.equal(report.totalVotes,1);assert.deepEqual(report.questions[0].finalResult.counts,[0,0,1]);assert.equal(report.questions[0].finalResult.votingSeconds,12);
  });
});
