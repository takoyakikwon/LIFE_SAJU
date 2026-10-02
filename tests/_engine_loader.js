/**
 * 공통 테스트 로더 — index.html의 인라인 계산 엔진 스크립트를 Node.js vm 샌드박스에서
 * 직접 실행해 함수들을 꺼내 쓸 수 있게 해준다. 실제 배포 파일(index.html)을 그대로
 * 읽어서 돌리므로, 테스트가 통과하면 "실제 파일에 들어있는 코드"가 검증된 것이다.
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const INDEX_HTML_PATH = path.join(__dirname, '..', 'index.html');

const EXPORT_NAMES = [
  'calcSaju', 'calcZiwei', 'buildSajuCore', 'buildZiweiCore', 'buildIntegratedProfile', 'buildPersonProfile',
  'buildLunarCalendar', 'solarToLunar', 'lunarToSolar', 'soulBodyIndex', 'reducedToStd',
  'buildGanRelations', 'buildGuiinShinsal', 'currentSeunInfo', 'buildJwabeop', 'buildInjongbeop',
];

function extractMainScript(html) {
  const scripts = [...html.matchAll(/<script([^>]*)>([\s\S]*?)<\/script>/g)];
  let best = null, bestLen = -1;
  for (const s of scripts) {
    if (s[1].includes('src=')) continue; // 외부 스크립트는 제외
    if (s[2].length > bestLen) { bestLen = s[2].length; best = s[2]; }
  }
  if (!best) throw new Error('메인 인라인 스크립트를 찾지 못했습니다.');
  return best;
}

function patchExports(src) {
  const marker = '})();';
  const idx = src.trimEnd().lastIndexOf(marker);
  if (idx === -1) throw new Error('IIFE 종료 지점을 찾지 못했습니다.');
  const exportLine = `globalThis.__exports = { ${EXPORT_NAMES.join(', ')} };\n`;
  const trimmed = src.trimEnd();
  return trimmed.slice(0, idx) + exportLine + trimmed.slice(idx);
}

function makeFakeElement() {
  return {
    style: new Proxy({ setProperty(){}, removeProperty(){}, getPropertyValue(){return '';} }, { get: (t,p) => (p in t ? t[p] : ''), set: (t,p,v) => { t[p]=v; return true; } }),
    classList: { add(){}, remove(){}, toggle(){}, contains(){return false;} },
    addEventListener(){}, removeEventListener(){},
    setAttribute(){}, getAttribute(){return null;}, removeAttribute(){},
    appendChild(x){return x;}, removeChild(){}, insertBefore(x){return x;},
    querySelector(){return makeFakeElement();}, querySelectorAll(){return [];},
    dataset: {},
    get innerHTML() { return this._html || ''; }, set innerHTML(v) { this._html = v; },
    get textContent() { return this._text || ''; }, set textContent(v) { this._text = v; },
    value: '', focus(){}, blur(){}, click(){}, scrollIntoView(){},
    getBoundingClientRect(){ return {top:0,left:0,right:0,bottom:0,width:0,height:0}; },
    closest(){return null;}, contains(){return false;},
  };
}

function buildSandbox() {
  const fakeDocument = { querySelector(){return makeFakeElement();}, querySelectorAll(){return [];}, getElementById(){return makeFakeElement();}, createElement(){return makeFakeElement();}, addEventListener(){}, removeEventListener(){}, documentElement: makeFakeElement(), body: makeFakeElement(), head: makeFakeElement(), cookie:'', readyState:'complete', visibilityState:'visible', title:'' };
  const fakeLocalStorage = (() => { const store={}; return { getItem:k=>(k in store?store[k]:null), setItem:(k,v)=>{store[k]=String(v);}, removeItem:k=>{delete store[k];}, clear:()=>{Object.keys(store).forEach(k=>delete store[k]);} }; })();
  const fakeWindow = { visualViewport:null, innerWidth:400, innerHeight:800, addEventListener(){}, removeEventListener(){}, location:{href:'http://localhost/',origin:'http://localhost',pathname:'/',search:'',hash:''}, history:{pushState(){},replaceState(){},back(){},state:null}, navigator:{userAgent:'node',language:'ko-KR',onLine:true,serviceWorker:undefined}, localStorage:fakeLocalStorage, sessionStorage:fakeLocalStorage, requestAnimationFrame:(fn)=>setTimeout(fn,0), cancelAnimationFrame:()=>{}, matchMedia:()=>({matches:false,addEventListener(){},addListener(){}}), fetch:()=>Promise.reject(new Error('fetch disabled')), Kakao:undefined, getComputedStyle:()=>({getPropertyValue:()=>''}) };
  const sandbox = { window: fakeWindow, document: fakeDocument, navigator: fakeWindow.navigator, localStorage: fakeLocalStorage, sessionStorage: fakeLocalStorage, location: fakeWindow.location, history: fakeWindow.history, console, setTimeout, clearTimeout, setInterval, clearInterval, requestAnimationFrame: fakeWindow.requestAnimationFrame, fetch: fakeWindow.fetch, URL, URLSearchParams, Promise, Intl, Date, Math, JSON, crypto: require('crypto').webcrypto, module:{exports:{}} };
  sandbox.globalThis = sandbox; sandbox.self = sandbox;
  return sandbox;
}

function loadEngine() {
  const html = fs.readFileSync(INDEX_HTML_PATH, 'utf8');
  const src = patchExports(extractMainScript(html));
  const sandbox = buildSandbox();
  vm.createContext(sandbox);
  vm.runInContext(src, sandbox, { filename: 'index.html#script', timeout: 20000 });
  return sandbox.globalThis.__exports;
}

const ZHI = ['子','丑','寅','卯','辰','巳','午','未','申','酉','戌','亥'];
const GAN = ['甲','乙','丙','丁','戊','己','庚','辛','壬','癸'];

function makeRunner() {
  let pass = 0, fail = 0;
  function check(label, actual, expected) {
    const ok = JSON.stringify(actual) === JSON.stringify(expected);
    console.log(`[${ok ? 'PASS' : 'FAIL'}] ${label}` + (ok ? '' : `  실제=${JSON.stringify(actual)} 기대=${JSON.stringify(expected)}`));
    if (ok) pass++; else fail++;
    return ok;
  }
  function finish() {
    console.log(`\n총 ${pass + fail}건 중 PASS ${pass} / FAIL ${fail}`);
    if (fail > 0) process.exitCode = 1;
  }
  return { check, finish, counts: () => ({ pass, fail }) };
}

module.exports = { loadEngine, makeRunner, ZHI, GAN };
