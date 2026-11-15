/** 使用私网地址和独立演示空间，验证多个浏览器身份的流水线闭环。 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import net from 'node:net';
import os from 'node:os';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const host = process.env.TEAMHUB_LAN_IP;
if (!host || net.isIP(host) !== 4 || !/^(10\.|192\.168\.|172\.(1[6-9]|2[0-9]|3[01])\.)/.test(host)) throw new Error('TEAMHUB_LAN_IP 必须是本机的 RFC 1918 私网 IPv4。');
const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'teamhub-lan-ui-'));
const py = process.env.TEAMHUB_TEST_PYTHON, chrome = process.env.TEAMHUB_CHROME, entry = process.env.TEAMHUB_PLAYWRIGHT_ENTRY;
if (!py || !chrome || !entry) throw new Error('请设置隔离测试 Python、Chrome 与 Playwright 入口。');
const port = await new Promise((resolve,reject)=>{const s=net.createServer();s.once('error',reject);s.listen(0,host,()=>{const p=s.address().port;s.close(()=>resolve(p));});});
const base=`http://${host}:${port}`;
const allowed=new Set(['path','home','userprofile','systemroot','windir','comspec','pathext','temp','tmp','tmpdir','lang']);
const env=Object.fromEntries(Object.entries(process.env).filter(([k])=>allowed.has(k.toLowerCase())));
const hub=spawn(py,['-m','teamhub','serve','--demo','--host',host,'--port',String(port),'--data-dir',path.join(dir,'data')],{cwd:root,env:{...env,PYTHONPATH:path.join(root,'server'),PYTHONUTF8:'1'},windowsHide:true,stdio:'ignore'});
let browser; let stage='startup';
const errors=[]; const warnings=[]; const operationIds=[];
try {
 for(let i=0;i<100;i++){if(hub.exitCode!==null)throw Error('Hub exited');try{if((await fetch(base+'/api/v1/health')).ok)break;}catch{} if(i===99)throw Error('health timeout');await new Promise(r=>setTimeout(r,100));}
 const {chromium}=await import(pathToFileURL(entry).href);browser=await chromium.launch({headless:true,executablePath:chrome});
 const contexts=await Promise.all([1,2,3].map(()=>browser.newContext({viewport:{width:1440,height:900}})));
 const pages=await Promise.all(contexts.map(c=>c.newPage())); const [admin,chen,xu]=pages;
 for(const p of pages){p.on('request',r=>{ if (r.method() !== 'GET' && r.url().includes('/api/v1/')) { try { const body=r.postDataJSON(); if(body?.operation_id) operationIds.push(body.operation_id); } catch {} } });p.on('pageerror',e=>errors.push(e.message));p.on('console',m=>{if(m.type()==='error')errors.push(m.text());if(m.type()==='warning')warnings.push(m.text())});}
 await Promise.all(pages.map(p=>p.goto(base+'/#connections')));
 assert.match(await admin.title(), /Team Hub/);assert.equal(await admin.locator('vite-error-overlay').count(),0);
 for(const p of pages){assert.equal(await p.evaluate(()=>window.isSecureContext),false);assert.equal(await p.evaluate(()=>typeof crypto.randomUUID),'undefined');await p.getByText('当前连接未加密', {exact:false}).waitFor();}
 await chen.getByRole('button',{name:/陈悦/}).click(); await xu.getByRole('button',{name:/许安/}).click();
 const who=async p=>p.evaluate(async()=>{let r=await fetch('/api/v1/auth/me',{headers:{Authorization:'Bearer '+sessionStorage.getItem('teamhub.session.v1')}});return r.json()});
 for(const [p,id,role] of [[admin,'u-lin','admin'],[chen,'u-chen','member'],[xu,'u-xu','member']]){await p.waitForFunction(expected=>sessionStorage.getItem('teamhub.session.v1')===expected, 'demo-'+id.slice(2));const me=await who(p);assert.equal(me.id,id);assert.equal(me.role,role);}
 await admin.getByRole('button',{name:'复制服务地址'}).click();await admin.getByRole('status').waitFor();
 stage='template-create'; await admin.goto(base+'/#workflows');await admin.getByRole('button',{name:'新建模板'}).first().click();let dialog=admin.locator('.modal[role=dialog]');
 await dialog.getByLabel('模板名称').fill('【系统测试】局域网跨组模板');
 await dialog.getByRole('button',{name:'添加团队角色'}).click();
 await dialog.getByLabel('团队角色名称').nth(1).fill('后续团队');
 await dialog.getByRole('button',{name:'添加步骤'}).click();
 const steps=dialog.locator('.workflow-step-editor');
 await steps.nth(0).getByLabel('步骤名称').fill('清算验证');
 await steps.nth(1).getByLabel('步骤名称').fill('质量验证');
 await steps.nth(1).getByLabel('验收标准').fill('完成质量验证');
 await steps.nth(1).getByLabel('承接团队角色').selectOption({label:'后续团队'});
 await dialog.getByRole('button',{name:'保存草稿'}).click();
 const card=admin.locator('.workflow-card').filter({hasText:'【系统测试】局域网跨组模板'});await card.waitFor();
 stage='template-edit';await card.getByRole('button',{name:'编辑草稿'}).click();dialog=admin.locator('.modal[role=dialog]');await dialog.getByLabel('模板说明').fill('独立演示数据验证');await dialog.getByRole('button',{name:'保存草稿'}).click();
 await card.getByRole('button',{name:'发布版本'}).click();await card.getByText('已发布版本').click();await card.getByRole('button',{name:'按此创建流水线'}).click();
 stage='pipeline-create';dialog=admin.locator('.modal[role=dialog]');await dialog.getByLabel('任务名称').fill('【系统测试】局域网跨组流程');await dialog.getByLabel('承接团队（团队）').selectOption('team-clearing');await dialog.getByLabel('后续团队（团队）').selectOption('team-qa');await dialog.getByLabel('验收人（验收人）').selectOption('u-lin');await dialog.getByRole('button',{name:'创建流水线'}).click();dialog=admin.locator('.modal[role=dialog]');await dialog.getByRole('button',{name:'启动流水线'}).click();await dialog.getByText('待接单').first().waitFor();await admin.screenshot({path:path.join(dir,'pipeline-created.png')});
 const getPipeline=async()=>admin.evaluate(async()=>{const r=await fetch('/api/v1/pipelines',{headers:{Authorization:'Bearer '+sessionStorage.getItem('teamhub.session.v1')}});return (await r.json()).items.find(x=>x.pipeline.title==='【系统测试】局域网跨组流程')});
 const openStep=async(p,n)=>{await p.goto(base+'/#pipelines');await p.reload();const c=p.locator('.workflow-card').filter({hasText:'【系统测试】局域网跨组流程'});await c.getByRole('button',{name:'查看详情'}).click();const d=p.locator('.modal[role=dialog]');await d.locator('.pipeline-step').nth(n).getByRole('button',{name:/打开事项/}).click();await p.locator('.detail-drawer').waitFor()};
 const work=async(p,n)=>{await openStep(p,n);const drawer=p.locator('.detail-drawer');await drawer.getByRole('button',{name:'接单',exact:true}).click();let d=p.locator('.modal[role=dialog]');await d.getByRole('button',{name:'接收协作事项'}).click();await drawer.getByRole('button',{name:'开始处理',exact:true}).click();d=p.locator('.modal[role=dialog]');await d.locator('footer.modal-actions').getByRole('button',{name:'开始处理',exact:true}).click();await drawer.getByRole('button',{name:'提交交付',exact:true}).click();d=p.locator('.modal[role=dialog]');await d.getByLabel('交付说明').fill('合成材料已准备');await d.getByLabel('名称',{exact:true}).fill('测试报告');await d.getByLabel('链接',{exact:true}).fill('https://example.com/test');await d.getByRole('button',{name:'添加链接'}).click();await d.locator('footer.modal-actions').getByRole('button',{name:'提交交付',exact:true}).click();await d.waitFor({state:'hidden'});};
 const approve=async(n)=>{await openStep(admin,n);const drawer=admin.locator('.detail-drawer');await drawer.getByRole('button',{name:'验收通过',exact:true}).click();const d=admin.locator('.modal[role=dialog]');await d.locator('footer.modal-actions').getByRole('button',{name:'验收通过',exact:true}).click();await d.waitFor({state:'hidden'});};
 stage='first-team';await work(chen,0);let p=await getPipeline();assert.equal(p.steps[0].state,'awaiting_review');assert.equal(p.steps[1].state,'waiting');await approve(0);p=await getPipeline();assert.equal(p.steps[0].state,'completed');assert.equal(p.steps[1].state,'awaiting_accept');
 stage='second-team';await work(xu,1);await approve(1);p=await getPipeline();assert.equal(p.pipeline.status,'completed');assert.deepEqual(p.steps.map(x=>x.state),['completed','completed']);
 await admin.goto(base+'/#pipelines');await admin.locator('.workflow-card').filter({hasText:'【系统测试】局域网跨组流程'}).getByText('已完成',{exact:true}).first().waitFor();await admin.screenshot({path:path.join(dir,'pipeline-complete.png')});
 await admin.reload();await admin.setViewportSize({width:390,height:844});assert.equal(await admin.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);await admin.screenshot({path:path.join(dir,'pipeline-mobile.png')});
 assert.deepEqual(errors,[]);assert.deepEqual(warnings,[]);assert.ok(operationIds.length >= 10);assert.ok(operationIds.every(id=>/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(id)));console.log(JSON.stringify({result:'passed',base,insecure_context:true,uuid_missing:true,three_independent_clients:true,template_create_edit_publish:true,two_team_flow:'completed',clipboard_fallback:true,browser_errors:errors.length,browser_warnings:warnings.length,mobile_layout:true,uuid_v4_operations:operationIds.length,evidence:dir}));
} catch(e) {console.error(JSON.stringify({result:'failed',stage,error:e.message,errors}));process.exitCode=1;} finally {await browser?.close();hub.kill();}
