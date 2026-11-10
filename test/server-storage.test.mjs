import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStorage } from '../scripts/server-storage.mjs';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:net';

const temporary = () => mkdtempSync(join(tmpdir(),'fk-server-'));
test('SQLite migrations, numbered bindings, atomic returning and attachment persistence', async () => {
 const dir=temporary(), filename=join(dir,'feedbackkit.sqlite');
 let store=openStorage(filename,'migrations');
 try {
  assert.equal((await store.DB.prepare("SELECT value FROM meta WHERE key='schema_version'").first()).value,'4');
  const row=await store.DB.prepare("INSERT INTO counters (key,window_start,count) VALUES (?1,?2,1) ON CONFLICT(key) DO UPDATE SET count=count+1 RETURNING count").bind('test',123).first();
  assert.equal(row.count,1);
  assert.equal((await store.DB.prepare("UPDATE counters SET count=count+1 WHERE key=?1 RETURNING count").bind('test').first()).count,2);
  await store.UPLOADS.put('a/b',new Uint8Array([1,2,3]),{httpMetadata:{contentType:'image/png'}});
  store.close();store=openStorage(filename,'migrations');
  assert.equal((await store.DB.prepare('SELECT count FROM counters WHERE key=?1').bind('test').first()).count,2);
  const object=await store.UPLOADS.get('a/b');assert.deepEqual([...new Uint8Array(await object.arrayBuffer())],[1,2,3]);assert.equal(object.httpMetadata.contentType,'image/png');
  await store.UPLOADS.delete('a/b');assert.equal(await store.UPLOADS.get('a/b'),null);
 } finally {store.close();rmSync(dir,{recursive:true,force:true})}
});

test('real standalone HTTP: create, duplicate safety, publish conflicts, feedback persistence and private attachments',async()=>{
 const dir=temporary();const reservation=createServer();reservation.listen(0,'127.0.0.1');await once(reservation,'listening');const port=reservation.address().port;await new Promise(r=>reservation.close(r));
 const base=`http://127.0.0.1:${port}`, token='fictional-test-token-'.repeat(3);let child;
 const env={...process.env,HOST:'127.0.0.1',PORT:String(port),FK_PUBLIC_URL:base,FK_DATA_DIR:dir,ADMIN_TOKEN:token};
 async function start(){
  child=spawn(process.execPath,['scripts/server.mjs'],{env,stdio:['ignore','pipe','pipe']});let output='';child.stdout.on('data',d=>output+=d);child.stderr.on('data',d=>output+=d);
  for(let i=0;i<100;i++){if(child.exitCode!==null)throw Error(output);try{const response=await fetch(`${base}/diag`);if(response.ok)return}catch{}await new Promise(r=>setTimeout(r,50))}throw Error('Server startup timed out: '+output);
 }
 async function stop(){if(!child||child.exitCode!==null)return;child.kill('SIGTERM');await once(child,'exit')}
 const admin=async(path,method='GET',body)=>fetch(base+path,{method,headers:{Authorization:`Bearer ${token}`,Origin:base,'Content-Type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})});
 try {
  await start();const diag=await (await fetch(base+'/diag')).json();assert.equal(diag.schema.ok,true);
  assert.equal((await fetch(base+'/api/admin/projects')).status,401);
  assert.equal((await fetch(base+'/mcp')).status,404);
  const config={projectId:'example',locale:'en',delivery:'local',auth:{origins:[base]},llm:{provider:'off',model:''},templates:[{type:'feedback',label:'Feedback',fields:[]}]};
  const created=await admin('/api/admin/projects','POST',{config});assert.equal(created.status,201,await created.clone().text());const {publicKey}=await created.json();
  assert.equal((await admin('/api/admin/projects','POST',{config:{...config,locale:'de'}})).status,409);
  let stored=await (await admin('/api/admin/projects/example/config')).json();assert.equal(stored.locale,'en');
  const revised={...config,appearance:{heading:'Tell us what happened',accent:'#7c3aed',theme:'dark'}};
  assert.equal((await admin('/api/admin/projects/example/config/validate','POST',{config:revised})).status,200);
  assert.equal((await admin('/api/admin/projects/example/config','PUT',{config:revised,expectedVersion:1})).status,200);
  assert.equal((await admin('/api/admin/projects/example/config','PUT',{config,expectedVersion:1})).status,409);
  const publicConfig=await(await fetch(base+`/api/config?project=${publicKey}`,{headers:{Origin:base}})).json();assert.equal(publicConfig.appearance.heading,revised.appearance.heading);assert.equal(publicConfig.appearance.theme,'dark');assert.equal(publicConfig.llm,undefined);
  const report=await admin('/api/admin/projects/example/test-report','POST',{});assert.equal(report.status,200,await report.clone().text());
  let feedback=await(await admin('/api/admin/projects/example/feedback')).json();assert.equal(feedback.items.length,1);assert.equal(feedback.items[0].delivery,'local');
  await stop();
  const storage=openStorage(join(dir,'feedbackkit.sqlite'),'migrations');const key='example/private.png',fid=feedback.items[0].clientFeedbackId;
  await storage.UPLOADS.put(key,new Uint8Array([1,2,3]),{httpMetadata:{contentType:'image/png'}});
  await storage.DB.prepare("INSERT INTO assets (key,project_id,feedback_id,kind,created_at) VALUES (?1,?2,?3,'screenshot',?4)").bind(key,'example',fid,Date.now()).run();storage.close();
  await start();stored=await(await admin('/api/admin/projects/example/config')).json();assert.equal(stored.configVersion,2);assert.equal(stored.appearance.theme,'dark');
  feedback=await(await admin('/api/admin/projects/example/feedback')).json();assert.equal(feedback.items.length,1);
  assert.equal((await fetch(base+'/attachments/'+key)).status,404);
  assert.equal((await fetch(base+'/admin/assets/'+key)).status,401);
  const image=await admin('/admin/assets/'+key);assert.equal(image.status,200);assert.deepEqual([...new Uint8Array(await image.arrayBuffer())],[1,2,3]);
  assert.equal((await fetch(base+'/widget.js')).status,200);assert.equal((await fetch(base+'/admin.js')).status,200);
 }finally{await stop();rmSync(dir,{recursive:true,force:true})}
});
