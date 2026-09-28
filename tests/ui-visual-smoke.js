// Explicit fixture-only visual check; never opens the owner's installed app.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn, spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const AREA = path.join(ROOT, '.tools', 'ui-validation');
const RUN = new Date().toISOString().replace(/[:.]/g, '-');
const SHOTS = path.join(AREA, 'screenshots', RUN);
const PROFILE = path.join(AREA, 'profiles', RUN);
const EXE = path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe');
const PYTHON = path.join(ROOT, '.venv', 'Scripts', 'python.exe');
const ELECTRON = `process.getBuiltinModule('module').createRequire(${JSON.stringify(path.join(ROOT, 'main.js'))})('electron')`;
const deadline = Date.now() + 170000;
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const report = { schema_version: 1, mode: 'FIXTURE ONLY — real development Electron/main/preload/renderer',
  device_calls: false, real_collector_spawned: false, startup_writes: false,
  passed: false, screenshots: [], observations: [], failures: [], console_errors: [] };
let child, socket, stopped, closed = false, stage = 'fixture preparation', sequence = 0;
const pending = new Map();
function budget() { if (Date.now() >= deadline) throw Error(`Overall deadline reached at ${stage}`); }
function check(condition, message) { if (!condition) report.failures.push(`${stage}: ${message}`); }
function hash(file) { return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'); }

function prepare() {
  fs.mkdirSync(SHOTS, { recursive: true });
  fs.mkdirSync(PROFILE, { recursive: true });
  const script = `import contextlib,io,json
from backend.tests.fixture_status_api import main
def response(scenario,endpoint='status',range_name='15m'):
    out=io.StringIO()
    with contextlib.redirect_stdout(out): main(scenario,endpoint,range_name)
    return json.loads(out.getvalue())
result={'online':response('obstruction-supported'), 'device':response('device-details'),
        'unreachable':response('dish-unreachable'), 'missing':response('router-unavailable'),
        'unsupported':response('obstruction-unsupported'),
        'history':{r:response('history-quality' if r=='15m' else 'range-views','history',r) for r in ('15m','24h','7d')}}
print(json.dumps(result))`;
  const result = spawnSync(PYTHON, ['-c', script], { cwd: ROOT, encoding: 'utf8', windowsHide: true, timeout: 20000 });
  if (result.status !== 0) throw Error('Fixture API generation failed: ' + result.stderr.slice(-1500));
  const fixtures = JSON.parse(result.stdout);
  fixtures.online.device = fixtures.device.device;
  fixtures.online.router = fixtures.device.router;
  fixtures.error = { collection_state: 'collector_error', service_state: 'unknown', metrics: {}, device: {},
    guidance: 'FIXTURE: Collector unavailable. No dish service outage is implied.' };
  fixtures.long = structuredClone(fixtures.online);
  for (const reading of Object.values(fixtures.long.device)) if (typeof reading?.value === 'string')
    reading.value = 'FIXTURE-' + reading.value + '-LongUnbrokenDeviceIdentifier'.repeat(6);
  for (const reading of Object.values(fixtures.long.router)) if (typeof reading?.value === 'string')
    reading.value = 'FIXTURE-' + reading.value + '-LongUnbrokenRouterFirmware'.repeat(5);
  fixtures.logs = { logs: [
    { timestamp: '2026-09-28T12:00:00Z', level: 'info', message: 'FIXTURE: Local collector started; no hardware requests made.' },
    { timestamp: '2026-09-28T12:00:02Z', level: 'warning', message: 'FIXTURE: Router diagnostic unavailable; dish remains reachable.' },
    { timestamp: '2026-09-28T12:00:04Z', level: 'error', message: 'FIXTURE: ' + 'LongUnbrokenDiagnosticText'.repeat(20) },
  ] };
  const fixtureEpoch = Math.floor(Date.now() / 1000) * 1000;
  const originalEpoch = Date.parse(fixtures.online.observed_at);
  const shift = fixtureEpoch - originalEpoch;
  function anchor(value) {
    if (typeof value === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z$/.test(value))
      return new Date(Date.parse(value) + shift).toISOString().replace('.000Z', 'Z');
    if (Array.isArray(value)) return value.map(anchor);
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key,item]) => [key,anchor(item)]));
    return value;
  }
  const anchored = anchor(fixtures);
  report.fixture_provenance = { generated_by: 'backend.tests.fixture_status_api (recorded responses through public API)',
    original_status_time: new Date(originalEpoch).toISOString(), anchored_test_clock: new Date(fixtureEpoch).toISOString(),
    clock_mode: 'All UTC fields shifted together; main/renderer Date.now fixed to fixture clock',
    synthetic_additions: 'Long device strings, diagnostic log text, explicit collector-error response' };
  const fixtureFile = path.join(AREA, 'fixture-responses.json');
  fs.writeFileSync(fixtureFile, JSON.stringify(anchored, null, 2));
  const wrapper = path.join(AREA, 'fixture-bootstrap.js');
  fs.writeFileSync(wrapper, `// Test-only wrapper: inert collector, fixture API, isolated profile.
const {app,BrowserWindow}=require('electron');
const fs=require('node:fs'),path=require('node:path'),{EventEmitter}=require('node:events');
app.setPath('userData',${JSON.stringify(PROFILE)});
app.setPath('sessionData',${JSON.stringify(PROFILE)});
const fixtures=JSON.parse(fs.readFileSync(${JSON.stringify(fixtureFile)},'utf8'));
global.__uiPreview={scenario:'online',fixtures,errors:[],collectorStops:0,collectorSpawns:0};
Date.now=()=>${fixtureEpoch};
const childProcess=require('node:child_process');
childProcess.spawn=(command,args)=>{
  if(!args||args[0]!=='-m'||args[1]!=='backend.collector')throw Error('Unexpected test child spawn');
  const child=new EventEmitter();
  child.stdout=new EventEmitter();child.stderr=new EventEmitter();child.pid=undefined;
  let killed=false;child.kill=()=>{if(!killed){killed=true;global.__uiPreview.collectorStops++;
    setImmediate(()=>child.emit('close',0));}return true;};
  global.__uiPreview.collectorSpawns++;
  setTimeout(()=>{if(!killed)child.stdout.emit('data',Buffer.from('{"event":"collector-listening","port":49152}\\n'));},100);
  return child;
};
global.fetch=async(url)=>{
  const route=new URL(url);const state=global.__uiPreview;
  let body;if(route.pathname==='/api/status')body=state.fixtures[state.scenario];
  else if(route.pathname==='/api/history')body=state.fixtures.history[route.searchParams.get('range')||'15m'];
  else if(route.pathname==='/api/logs')body=state.fixtures.logs;
  else if(route.pathname==='/api/logs/clear')body={status:'ok'};
  else throw Error('Unexpected fixture route');
  return {ok:true,json:async()=>structuredClone(body)};
};
app.on('web-contents-created',(_event,contents)=>{
  contents.on('console-message',(event,...args)=>{
    const detail=[event,...args].find(value=>value&&typeof value==='object'&&'level' in value);
    const level=detail?detail.level:args[0];const message=detail?detail.message:args[1];
    if(level==='error'||level===3)global.__uiPreview.errors.push(String(message).slice(0,350));
  });
  contents.on('did-finish-load',()=>contents.executeJavaScript('Date.now=()=>${fixtureEpoch}').catch(()=>{}));
  contents.on('render-process-gone',(_event,detail)=>global.__uiPreview.errors.push('Renderer gone: '+detail.reason));
});
// Inject only the updater seam; app.isPackaged and production IPC stay unchanged.
const Module=require('node:module');const load=Module._load;
const factory=require(${JSON.stringify(path.join(ROOT, 'updater.js'))});
const fakeUpdater=new EventEmitter();let finishDownload;
fakeUpdater.setFeedURL=()=>{};
fakeUpdater.checkForUpdates=async()=>{if(global.__uiPreview.updateError){fakeUpdater.emit('error',Error('fixture failure'));throw Error('fixture failure');}
  fakeUpdater.emit(global.__uiPreview.noUpdate?'update-not-available':'update-available',{version:'1.4.0'});};
fakeUpdater.downloadUpdate=()=>new Promise(resolve=>{finishDownload=resolve;fakeUpdater.emit('download-progress',{percent:43});});
fakeUpdater.quitAndInstall=()=>{global.__uiPreview.installerCalls++;if(global.__uiPreview.collectorStops!==1)throw Error('Collector still alive');
  setImmediate(()=>app.quit());};
global.__uiPreview.installerCalls=0;
global.__uiPreview.finishDownload=()=>{fakeUpdater.emit('update-downloaded');finishDownload();};
Module._load=function(name,parent,...rest){if(name==='./updater'&&parent?.filename===${JSON.stringify(path.join(ROOT, 'main.js'))})
  return {createUpdateController:options=>{const controller=factory.createUpdateController({...options,updater:fakeUpdater,version:'1.3.0'});global.__uiPreview.resetUpdates=()=>fakeUpdater.emit('error',Error('fixture reset'));return controller;}};
  return load.call(this,name,parent,...rest);};
require(${JSON.stringify(path.join(ROOT, 'main.js'))});
Module._load=load;
`);
  report.source_hashes = Object.fromEntries(['main.js', 'preload.js', 'renderer/index.html', 'renderer/app.js', 'renderer/styles.css', 'renderer/updates.js', 'updater.js']
    .map(file => [file, hash(path.join(ROOT, file))]));
  return wrapper;
}

function evaluate(expression, cleanup = false) {
  if (!cleanup) budget();
  const id = ++sequence;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { pending.delete(id); reject(Error(`Inspector timeout at ${stage}`)); }, 8000);
    pending.set(id, { resolve(value) { clearTimeout(timer); resolve(value); }, reject(error) { clearTimeout(timer); reject(error); } });
    try { socket.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression, awaitPromise: true, returnByValue: true } })); }
    catch (error) { pending.get(id).reject(error); pending.delete(id); }
  });
}
function renderer(expression) {
  return evaluate(`(async()=>{const w=${ELECTRON}.BrowserWindow.getAllWindows()[0];
    if(!w||w.webContents.isLoading())throw Error('Window loading');return w.webContents.executeJavaScript(${JSON.stringify(expression)});})()`);
}
async function start(wrapper) {
  stage = 'isolated Electron startup';
  const env = { ...process.env, STARLINK_DASHBOARD_DATA_DIR: path.join(PROFILE, 'data') };
  delete env.ELECTRON_RUN_AS_NODE; delete env.PYTHONHOME; delete env.PYTHONPATH;
  child = spawn(EXE, [wrapper, '--hidden', '--inspect=127.0.0.1:0'], { cwd: ROOT, env, windowsHide: true });
  report.owned_desktop_pid = child.pid;
  stopped = new Promise(resolve => child.once('close', code => { closed = true; resolve(code); }));
  child.stdout.on('data', () => {});
  const url = await new Promise((resolve, reject) => {
    let output = '';
    const timer = setTimeout(() => reject(Error('No inspector startup')), 15000);
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('close', () => { clearTimeout(timer); reject(Error('Desktop exited during startup')); });
    child.stderr.on('data', bytes => { output = (output + bytes).slice(-12000);
      const match = output.match(/ws:\/\/127\.0\.0\.1:\d+\/[\w-]+/);
      if (match) { clearTimeout(timer); resolve(match[0]); }
    });
  });
  socket = new WebSocket(url);
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(Error('Inspector connection timeout')), 5000);
    socket.addEventListener('open', () => { clearTimeout(timer); resolve(); }, { once: true });
    socket.addEventListener('error', () => { clearTimeout(timer); reject(Error('Inspector connection failed')); }, { once: true });
  });
  socket.addEventListener('message', event => {
    const message = JSON.parse(event.data); const request = pending.get(message.id); if (!request) return;
    pending.delete(message.id);
    if (message.error || message.result?.exceptionDetails) request.reject(Error(message.result?.exceptionDetails?.exception?.description || 'Inspector failure'));
    else request.resolve(message.result.result.value);
  });
  socket.addEventListener('close', () => { for (const request of pending.values()) request.reject(Error('Inspector closed')); pending.clear(); });
  const readyDeadline = Math.min(deadline, Date.now() + 20000);
  let ready = false;
  while (Date.now() < readyDeadline && !closed) {
    // Do not import Electron during Node bootstrap; that caches the npm shim.
    if (await evaluate(`typeof process.type==='string'?process.type:null`) !== 'browser') { await pause(150); continue; }
    ready = await evaluate(`(()=>{const e=${ELECTRON};return e.app.isReady()&&e.BrowserWindow.getAllWindows().length===1})()`);
    if (ready) { try { await renderer(`typeof renderStatus==='function'&&!!window.desktopAPI`); break; } catch {} }
    await pause(150);
  }
  if (!ready) throw Error('Electron did not become ready');
  const actualProfile = await evaluate(`${ELECTRON}.app.getPath('userData')`);
  if (path.resolve(actualProfile).toLowerCase() !== PROFILE.toLowerCase()) throw Error('Profile isolation failed');
  await evaluate(`${ELECTRON}.BrowserWindow.getAllWindows()[0].show()`);
  await renderer(`(()=>{const tag=document.createElement('div');tag.textContent='FIXTURE PREVIEW · NO HARDWARE CALLS';
    tag.style.cssText='position:fixed;right:10px;bottom:7px;z-index:99999;background:#13151c;color:#c6d3f0;border:1px solid #6b7890;padding:4px 7px;border-radius:5px;font:10px system-ui;pointer-events:none';document.body.append(tag);})()`);
}

async function select(tab, keyboard = true) {
  stage = `select ${tab}`;
  await renderer(`(()=>{window.__uiKeys=[];document.addEventListener('keydown',e=>window.__uiKeys.push({key:e.key,code:e.code,type:e.type}),{once:true});document.querySelector('[data-tab="${tab}"]').focus();})()`);
  if (keyboard) {
    await evaluate(`(()=>{const w=${ELECTRON}.BrowserWindow.getAllWindows()[0];w.focus();w.webContents.focus();w.webContents.sendInputEvent({type:'keyDown',keyCode:'Enter'});w.webContents.sendInputEvent({type:'char',keyCode:'\\r'});w.webContents.sendInputEvent({type:'keyUp',keyCode:'Enter'});})()`);
  } else await renderer(`document.querySelector('[data-tab="${tab}"]').click()`);
  await pause(180);
  return renderer(`(()=>{const b=document.querySelector('[data-tab="${tab}"]'),p=document.getElementById('${tab}');
    return {active:b.classList.contains('active')||b.getAttribute('aria-selected')==='true'||b.getAttribute('aria-current')==='page',
      viewVisible:!!p&&getComputedStyle(p).display!=='none',focused:document.activeElement===b,keys:window.__uiKeys,activeElement:document.activeElement?.id};})()`);
}
async function scenario(name) {
  stage = `fixture ${name}`;
  await evaluate(`global.__uiPreview.scenario=${JSON.stringify(name)}`);
  await renderer(`(async()=>{await updateData();await updateHistory(true);if(typeof updateLogs==='function')await updateLogs();})()`);
  await pause(250);
}
async function screenshot(name) {
  budget();
  const file = path.join(SHOTS, `fixture-${name}.png`);
  await evaluate(`(async()=>{const w=${ELECTRON}.BrowserWindow.getAllWindows()[0];const image=await w.webContents.capturePage();
    process.getBuiltinModule('fs').writeFileSync(${JSON.stringify(file)},image.toPNG());})()`);
  report.screenshots.push(path.relative(AREA, file));
}
async function inspect(name, view) {
  stage = `layout ${name}`;
  const metrics = await renderer(`(()=>{
    const visible=e=>!!e&&getComputedStyle(e).display!=='none'&&e.getBoundingClientRect().width>0;
    const nav=[...document.querySelectorAll('[data-tab]')].map(e=>{const r=e.getBoundingClientRect();
      return {tab:e.dataset.tab,visible:visible(e),withinViewport:r.left>=-1&&r.right<=innerWidth+1&&r.top>=-1&&r.bottom<=innerHeight+1};});
    const charts=['speedChart','latencyChart','lossChart'].map(id=>{const c=document.getElementById(id),chart=Chart.getChart(id),r=c?.getBoundingClientRect();
      return {id,visible:visible(c),width:chart?.width,height:chart?.height,displayedWidth:r?.width,displayedHeight:r?.height};});
    const longValues=['dish-id','hardware','software','router-id','router-software'].map(id=>{const e=document.getElementById(id);return{id,text:e?.textContent,
      visible:visible(e),overflow:e&&e.clientWidth>0?e.scrollWidth>e.clientWidth+2:false};});
    return {viewport:{width:innerWidth,height:innerHeight},pageOverflow:Math.max(document.body.scrollWidth,document.documentElement.scrollWidth)>innerWidth+2,
      headline:document.getElementById('status').textContent,nav,charts,longValues,logText:document.getElementById('logs-content')?.textContent,
      guidanceVisible:visible(document.getElementById('guidance'))&&!document.getElementById('guidance').hidden,
      unavailable:document.getElementById('download').textContent};})()`);
  report.observations.push({ name, view, ...metrics });
  check(!metrics.pageOverflow, 'horizontal page overflow');
  check(metrics.nav.length === 5 && metrics.nav.every(item => item.visible && item.withinViewport), 'navigation clipped or hidden');
  for (const chart of metrics.charts.filter(item => item.visible)) check(chart.width > 0 && chart.height > 0 &&
    Math.abs(chart.width - chart.displayedWidth) <= 2 && Math.abs(chart.height - chart.displayedHeight) <= 2, `${chart.id} drawing/display size differs`);
  if (view === 'device' && name.includes('long')) check(metrics.longValues.every(item => !item.visible || !item.overflow), 'long device value clipped');
  if (view === 'logs') check(metrics.logText.includes('FIXTURE:'), 'fixture logs missing');
  if (name.includes('unreachable')) check(metrics.guidanceVisible && /unreachable/i.test(metrics.headline), 'unreachable state/guidance missing');
  if (name.includes('error')) check(/collector/i.test(metrics.headline), 'collector failure state missing');
  await screenshot(name);
}

async function run() {
  const wrapper = prepare(); budget();
  await start(wrapper);
  for (const [width, height] of [[1120, 800], [600, 750]]) {
    stage = `resize ${width}x${height}`;
    await evaluate(`${ELECTRON}.BrowserWindow.getAllWindows()[0].setSize(${width},${height})`); await pause(350);
    await scenario('online');
    for (const tab of ['network', 'statistics', 'obstruction', 'device', 'logs']) {
      const selection = await select(tab);report.observations.push({name:'keyboard-'+tab,...selection});
      check(selection.active && selection.viewVisible && selection.focused, `keyboard selection did not activate/focus ${tab}`);
      await inspect(`online-${tab}-${width}x${height}`, tab);
    }
    await select('statistics');
    for (const range of ['15m', '24h', '7d']) {
      stage = `range ${range}`;
      await renderer(`document.querySelector('[data-range="${range}"]').click()`); await pause(180);
      const selected = await renderer(`(()=>{const b=document.querySelector('[data-range="${range}"]');return{pressed:b.getAttribute('aria-pressed'),active:b.classList.contains('active'),label:document.getElementById('quality-window').textContent};})()`);
      check(selected.pressed === 'true' && selected.active, `${range} selected state missing`);
      report.observations.push({ name: `range-${range}-${width}x${height}`, ...selected });
    }
    await scenario('long'); await select('device'); await inspect(`long-device-${width}x${height}`, 'device');
    for (const name of ['unreachable', 'error', 'missing']) {
      await scenario(name); await select('network'); await inspect(`${name}-network-${width}x${height}`, 'network');
    }
    await scenario('unsupported'); await select('obstruction'); await inspect(`unsupported-obstruction-${width}x${height}`, 'obstruction');
  }
  await scenario('online');
  for (const [width,height] of [[1120,800],[600,750]]) {
    await evaluate(`${ELECTRON}.BrowserWindow.getAllWindows()[0].setSize(${width},${height})`);await pause(250);
    await select('device',false);
    await renderer(`(async()=>{renderUpdateState(await desktopUpdates.check());})()`);
    for (const phase of ['available','downloading','downloaded']) {
      stage=`update ${phase} ${width}`;
      if(phase==='downloading')await renderer(`document.getElementById('update-action').click()`);
      if(phase==='downloaded'){await evaluate(`global.__uiPreview.finishDownload()`);await pause(150);}
      await renderer(`(async()=>{renderUpdateState(await desktopUpdates.getState());})()`);
      const update=await renderer(`(()=>{const action=document.getElementById('update-action'),progress=document.getElementById('update-progress');
        return{phase:updateState.phase,action:action.textContent,actionVisible:!action.hidden,disabled:action.disabled,
          progress:progress.value,progressVisible:!progress.hidden,bannerVisible:!document.getElementById('update-notice').hidden,
          overflow:Math.max(document.body.scrollWidth,document.documentElement.scrollWidth)>innerWidth+2};})()`);
      report.observations.push({name:stage,...update});check(update.phase===phase,'Wrong update state');
      check(update.bannerVisible&&!update.overflow,'Update banner/layout missing or overflowing');
      check(phase==='downloading'?update.progressVisible&&update.progress===43&&!update.actionVisible:
        update.actionVisible&&!update.disabled&&update.action===(phase==='available'?'Download update':'Restart and install'),'Update action/progress incorrect');
      await screenshot(`update-${phase}-${width}x${height}`);
      if(phase==='available'){await select('network',false);await screenshot(`update-overview-${width}x${height}`);await select('device',false);}
    }
    // Reset the downloaded fixture through a controller error; no installer is executed.
    await evaluate(`global.__uiPreview.resetUpdates()`);
    await renderer(`(async()=>{renderUpdateState(await desktopUpdates.getState());})()`);
    await screenshot(`update-error-${width}x${height}`);
    await evaluate(`global.__uiPreview.noUpdate=true`);
    await renderer(`(async()=>{renderUpdateState(await desktopUpdates.check());})()`);
    check(await renderer(`updateState.phase==='current'&&document.getElementById('update-notice').hidden`),'Current state or banner visibility incorrect');
    await screenshot(`update-current-${width}x${height}`);
    await evaluate(`global.__uiPreview.noUpdate=false`);
  }
  const state = await evaluate(`({errors:global.__uiPreview.errors,spawns:global.__uiPreview.collectorSpawns})`);
  report.console_errors = state.errors;
  check(state.errors.length === 0, 'renderer console errors: ' + state.errors.join('; '));
  check(state.spawns === 1, 'unexpected collector stub duplication');
}

async function cleanup() {
  stage = 'normal owned desktop cleanup';
  if (child && !closed && socket?.readyState === WebSocket.OPEN) {
    try { await evaluate(`setImmediate(()=>${ELECTRON}.app.quit()); true`, true); } catch {}
  }
  socket?.close();
  if (child && !closed) {
    const complete = await Promise.race([stopped.then(() => true), pause(8000).then(() => false)]);
    if (!complete) { child.kill(); report.failures.push('Owned desktop required forced cleanup'); await Promise.race([stopped, pause(2000)]); }
  }
  report.owned_desktop_closed = !child || closed;
  report.finished_at = new Date().toISOString();
  report.passed = report.failures.length === 0 && report.owned_desktop_closed;
  fs.mkdirSync(AREA, { recursive: true });
  fs.writeFileSync(path.join(AREA, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ passed: report.passed, screenshots: report.screenshots.length, failures: report.failures,
    report: path.join(AREA, 'report.json'), screenshotDirectory: SHOTS }));
  if (!report.passed) process.exitCode = 1;
}
const hardStop = setTimeout(() => {
  report.failures.push(`Overall three-minute bound reached at ${stage}`);
  if (child && !closed) child.kill();
  for (const request of pending.values()) request.reject(Error('Overall deadline'));
  pending.clear(); socket?.close();
}, 179000);
run().catch(error => report.failures.push(`${stage}: ${String(error.message).slice(0,500)}`))
  .finally(async () => { await cleanup(); clearTimeout(hardStop); });
