/* stepperInit: +/- buttons under range sliders. Copied verbatim from the original viewer (test10-main). */
function stepperInit(spec,dark){
              var d=document,c=dark?{b:'#2a3d57',t:'#e5edf7',v:'#0f1a2b',vt:'#8ef0e2',s:'0 1px 3px #0009',o:'#344b66'}:{b:'#f4f8fd',t:'#27324a',v:'#dde8f6',vt:'#27324a',s:'0 1px 4px #27324a33',o:'#dde8f6'},st=d.createElement('style');
              st.textContent='.stp{display:flex;gap:6px;justify-content:center;align-items:stretch;margin-top:4px}'
                +'.stp button{flex:1 1 0;min-width:0;max-width:64px;height:42px;padding:0;border:1px solid '+c.o+';border-radius:10px;background:'+c.b+';color:'+c.t+';font-family:inherit;font-size:15px;font-weight:800;line-height:1;box-shadow:'+c.s+';cursor:pointer;touch-action:manipulation;-webkit-tap-highlight-color:transparent}'
                +'.stp button.sm{font-size:12px}.stp button.xs{font-size:10px}'
                +'.stp button:active{transform:translateY(1px);box-shadow:none}.stp button:disabled{opacity:.35;cursor:default;transform:none}'
                +'.stp b,.stp .value{flex:1.7 1 0;min-width:0;max-width:104px;display:flex;align-items:center;justify-content:center;padding:0 2px;border-radius:10px;background:'+c.v+';color:'+c.vt+';font-size:15px;font-weight:400;font-variant-numeric:tabular-nums;white-space:nowrap}';
              d.head.appendChild(st);
              Object.keys(spec).forEach(function(id){
                var inp=d.getElementById(id),lab=d.querySelector('label[for="'+id+'"]');
                if(!inp||!lab)return;
                var ds=spec[id],mn=+inp.min,mx=+inp.max,bs=[],row=d.createElement('div'),val=lab.querySelector('b,.value')||d.createElement('b'),n=lab.firstChild,name,
                  dec=Math.max.apply(null,ds.map(function(x){return (String(x).split('.')[1]||'').length}));
                if(n&&n.nodeType===1)n=n.firstChild;
                name=n?n.textContent.trim():'';
                var upd=function(){var v=+inp.value;bs.forEach(function(x){x[0].disabled=x[1]<0?v<=mn:v>=mx})};
                var mk=function(x){
                  var b=d.createElement('button'),t=(x<0?'\u2212':'+')+Math.abs(x);
                  b.type='button';b.textContent=t;b.className=t.length>4?'xs':t.length>3?'sm':'';b.setAttribute('aria-label',name+' '+t);
                  b.onclick=function(){inp.value=Math.min(mx,Math.max(mn,+(+inp.value+x).toFixed(dec)));inp.dispatchEvent(new Event('input',{bubbles:true}));upd()};
                  bs.push([b,x]);return b};
                row.className='stp';row.setAttribute('role','group');row.setAttribute('aria-label',name);
                ds.slice().reverse().forEach(function(x){row.appendChild(mk(-x))});
                row.appendChild(val);
                ds.forEach(function(x){row.appendChild(mk(x))});
                inp.style.display='none';inp.parentNode.insertBefore(row,inp.nextSibling);
                new MutationObserver(upd).observe(val,{childList:true,characterData:true,subtree:true});
                upd();
              });
            }
