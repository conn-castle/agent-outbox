async page => {
  const variant='VARIANT';
  const root='/home/nicholasjconn/git-repos/conn-castle/agent-outbox/.agent-layer/tmp/website-optimization-20261028';
  const result={variant,browser:page.context().browser().version(),views:[]};
  for(const view of [{name:'desktop',width:1440,height:1000,dpr:1},{name:'tablet-wide',width:1024,height:1000,dpr:1},{name:'tablet',width:768,height:1024,dpr:1},{name:'mobile',width:390,height:844,dpr:3}]){
    const mobile=view.name==='mobile';
    const ctx=await page.context().browser().newContext({viewport:{width:view.width,height:view.height},deviceScaleFactor:view.dpr,isMobile:mobile,hasTouch:mobile,colorScheme:'light'});
    const p=await ctx.newPage();
    const errors=[]; p.on('pageerror',e=>errors.push(String(e)));
    const settle=async()=>{
      await p.evaluate(async()=>{await document.fonts.ready; await Promise.all([...document.images].map(i=>i.decode()));
        // Match only observed animation phases; do not alter DOM/CSS/content.
        const animations=document.getAnimations(); window.__captureAnimations=animations.map(a=>({name:a.animationName,state:a.playState}));
        animations.forEach(a=>{if(a.effect?.getTiming().iterations===Infinity){a.pause();a.currentTime=0;}});
        await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));
      });
    };
    const capture=async(name,fullPage=false)=>{await p.evaluate(async()=>{await Promise.all(document.getAnimations().filter(a=>a.effect?.getTiming().iterations!==Infinity).map(a=>a.finished.catch(()=>{})));});const path=`${root}/screenshots/${variant}-${view.name}-${name}.png`;await p.screenshot({path,fullPage,scale:'device'});return path;};
    await p.goto('http://127.0.0.1:31288/',{waitUntil:'networkidle'}); await settle();
    const data={...view,full:await capture('full',true),top:await capture('top'),errors};
    data.state=await p.evaluate(()=>({title:document.title,text:document.body.innerText,links:[...document.querySelectorAll('a')].map(a=>({text:a.innerText,href:a.getAttribute('href')})),images:[...document.images].map(i=>({src:i.currentSrc,alt:i.alt,width:i.width,height:i.height,naturalWidth:i.naturalWidth,naturalHeight:i.naturalHeight})),animations:window.__captureAnimations,fonts:document.fonts.status,scrollWidth:document.documentElement.scrollWidth}));
    const menu=p.getByRole('button',{name:'Menu',exact:true});
    if(await menu.isVisible()){
      await menu.click();
      if(await menu.getAttribute('aria-expanded')!=='true')throw new Error('Menu did not open');
      data.menu=await capture('menu');
      await p.keyboard.press('Escape');
      if(await menu.getAttribute('aria-expanded')!=='false')throw new Error('Escape did not close menu');
      data.escapeFocus=await menu.evaluate(e=>document.activeElement===e);
      await menu.click();
    }
    await p.getByRole('navigation',{name:'Primary',exact:true}).getByRole('link',{name:'Pricing',exact:true}).click();
    await p.waitForFunction(()=>location.hash==='#pricing');
    // Wait for the existing smooth scroll to finish at a stable position.
    await p.evaluate(()=>new Promise(resolve=>{let prior=scrollY,stable=0;function frame(){if(scrollY===prior)stable++;else stable=0;prior=scrollY;if(stable>=8)resolve();else requestAnimationFrame(frame);}requestAnimationFrame(frame);}));
    data.pricing=await capture('pricing');
    data.pricingNavigation=await p.evaluate(()=>({hash:location.hash,scrollY,headingVisible:document.querySelector('#pricing').getBoundingClientRect().top<innerHeight,menuExpanded:document.querySelector('.nav-toggle').getAttribute('aria-expanded')}));
    if(!data.pricingNavigation.headingVisible)throw new Error('Pricing anchor failed');
    if(view.name==='mobile'||view.name==='desktop'){
      await p.goto('http://127.0.0.1:31288/',{waitUntil:'networkidle'});
      const cta=p.getByRole('link',{name:'Get started free',exact:true});
      data.ctaHref=await cta.getAttribute('href');
      await cta.hover(); data.ctaHover=await capture('cta-hover');
      await cta.click();await p.waitForURL('**/sign-up');await p.waitForLoadState('networkidle');
      data.cta={url:p.url(),text:await p.locator('main').innerText()};
      data.signUp=await capture('sign-up');
      await p.goto('http://127.0.0.1:31288/docs/api',{waitUntil:'networkidle'});await settle();
      data.docs={url:p.url(),title:await p.title(),headings:await p.getByRole('heading').allTextContents()};
      data.docsScreenshot=await capture('docs');
    }
    result.views.push(data);await ctx.close();
  }
  return result;
}
