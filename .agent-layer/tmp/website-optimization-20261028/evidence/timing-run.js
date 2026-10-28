async page => {
  const context = await page.context().browser().newContext({viewport:{width:390,height:844},deviceScaleFactor:3,isMobile:true,hasTouch:true});
  const p=await context.newPage();
  const cdp=await context.newCDPSession(p);
  await cdp.send('Network.enable');
  await cdp.send('Network.clearBrowserCache');
  await cdp.send('Network.setCacheDisabled',{cacheDisabled:true});
  await cdp.send('Network.emulateNetworkConditions',{offline:false,latency:150,downloadThroughput:200000,uploadThroughput:93750,connectionType:'cellular4g'});
  await cdp.send('Emulation.setCPUThrottlingRate',{rate:4});
  await p.addInitScript(()=>{
    window.__audit={lcp:[],cls:[]};
    new PerformanceObserver(l=>l.getEntries().forEach(e=>window.__audit.lcp.push({time:e.startTime,size:e.size,url:e.url,tag:e.element?.tagName,text:e.element?.innerText?.slice(0,120)}))).observe({type:'largest-contentful-paint',buffered:true});
    new PerformanceObserver(l=>l.getEntries().forEach(e=>{if(!e.hadRecentInput)window.__audit.cls.push({time:e.startTime,value:e.value});})).observe({type:'layout-shift',buffered:true});
  });
  const requests={}, errors=[];
  cdp.on('Network.requestWillBeSent',e=>{requests[e.requestId]={id:e.requestId,url:e.request.url,type:e.type,start:e.timestamp};});
  cdp.on('Network.responseReceived',e=>{Object.assign(requests[e.requestId]||={}, {status:e.response.status,mime:e.response.mimeType,protocol:e.response.protocol,fromDiskCache:e.response.fromDiskCache,fromServiceWorker:e.response.fromServiceWorker,response:e.timestamp});});
  cdp.on('Network.loadingFinished',e=>{Object.assign(requests[e.requestId]||={}, {end:e.timestamp,transferBytes:e.encodedDataLength});});
  cdp.on('Network.loadingFailed',e=>{Object.assign(requests[e.requestId]||={}, {error:e.errorText,end:e.timestamp});});
  p.on('pageerror',e=>errors.push(String(e)));
  const capture=()=>p.evaluate(()=>({url:location.href,nav:performance.getEntriesByType('navigation')[0].toJSON(),metrics:window.__audit,resources:performance.getEntriesByType('resource').map(e=>({name:e.name,initiatorType:e.initiatorType,startTime:e.startTime,responseEnd:e.responseEnd,transferSize:e.transferSize,encodedBodySize:e.encodedBodySize,decodedBodySize:e.decodedBodySize})),images:[...document.images].map(i=>({src:i.currentSrc,complete:i.complete,naturalWidth:i.naturalWidth,top:i.getBoundingClientRect().top})),backgrounds:[...new Set([...document.querySelectorAll('*')].map(e=>getComputedStyle(e).backgroundImage).filter(s=>s!=='none'))],fonts:document.fonts.status,scrollHeight:document.documentElement.scrollHeight}));
  const result={started:new Date().toISOString(),viewport:{width:390,height:844,dpr:3},network:{down:200000,up:93750,latency:150,cpu:4},browser:page.context().browser().version()};
  try {
    await p.goto('http://127.0.0.1:31288/',{waitUntil:'load',timeout:60000});
    await p.evaluate(async()=>{await document.fonts.ready; await Promise.all([...document.images].map(i=>i.decode())); await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));});
    // Observe first viewport before any input/scroll terminates LCP collection.
    result.initial=await capture();
    result.scrollStartMs=await p.evaluate(()=>performance.now());
    const height=result.initial.scrollHeight;
    for(let y=0;y<height;y+=633){
      await p.evaluate(y=>window.scrollTo({top:y,behavior:'instant'}),y);
      // Defined scroll cadence, not post-completion idle added to the metric.
      await p.waitForTimeout(150);
    }
    await p.evaluate(async()=>{await document.fonts.ready; await Promise.all([...document.images].map(i=>i.decode()));});
    await p.waitForLoadState('networkidle');
    result.scrolled=await capture();
    result.scanCompletedMs=await p.evaluate(()=>performance.now());
    result.requests=Object.values(requests);
    const relevant=result.scrolled.resources.filter(r=>['img','css','link','script'].includes(r.initiatorType));
    result.metrics={lcpMs:result.initial.metrics.lcp.at(-1)?.time ?? null,loadMs:result.initial.nav.loadEventEnd,fullScrollAssetCompletionMs:Math.max(result.scrolled.nav.responseEnd,...relevant.map(r=>r.responseEnd)),browserTransferBytes:result.requests.reduce((n,r)=>n+(r.transferBytes||0),0),resourceTransferBytes:result.scrolled.nav.transferSize+result.scrolled.resources.reduce((n,r)=>n+r.transferSize,0),encodedBodyBytes:result.scrolled.nav.encodedBodySize+result.scrolled.resources.reduce((n,r)=>n+r.encodedBodySize,0),cls:result.initial.metrics.cls.reduce((n,e)=>n+e.value,0)};
  } catch(e) {result.error=String(e); result.requests=Object.values(requests);}
  result.errors=errors;
  await context.close();
  return result;
}
