```bash
S=/tmp/claude-1000/-home-user-hp-workspace-md2doc/cc552bfe-c005-4ece-b528-ad08d7b94e52/scratchpad; cd $S && python3 - <<'E'
p='variants.js'; s=open(p).read()
s=s.replace("await p.screenshot({ path: `${cfg.outDir}/${s.name}.png`, clip: s.clip });",
"const sy = await p.evaluate(() => window.scrollY);\n    const clip = s.clip ? { ...s.clip, y: s.clip.y + sy } : undefined;\n    await p.screenshot({ path: `${cfg.outDir}/${s.name}.png`, clip });")
open(p,'w').write(s)
E
FONTCONFIG_FILE=$S/fonts.conf node variants.js i1.json 2>&1 | grep -v '^shot' ; ls shots | wc -l
```

```bash
S=/tmp/claude-1000/-home-user-hp-workspace-md2doc/cc552bfe-c005-4ece-b528-ad08d7b94e52/scratchpad; cd $S && python3 - <<'E'
s=open('fontprobe.js').read()
s=s.replace("for (const id of nodeIds.slice(0,80)) { const r=await c.send('CSS.getPlatformFontsForNode',{nodeId:id}); if (r.fonts.length>1){found=r.fonts;break;} }",
"for (const id of nodeIds) { const {outerHTML}=await c.send('DOM.getOuterHTML',{nodeId:id}); if (outerHTML.includes('本 IP 不含')) { found=(await c.send('CSS.getPlatformFontsForNode',{nodeId:id})).fonts.map(f=>f.familyName+':'+f.glyphCount); break; } }")
open('fontprobe.js','w').write(s)
E
cd /home/user/hp_workspace/md2doc && FONTCONFIG_FILE=$S/fonts-sc.conf node $S/fontprobe.js
```

```bash
S=/tmp/claude-1000/-home-user-hp-workspace-md2doc/cc552bfe-c005-4ece-b528-ad08d7b94e52/scratchpad; cd $S && python3 - <<'E'
s=open('variants.js').read()
s=s.replace("const b = await puppeteer.launch({ args: ['--no-sandbox', '--font-render-hinting=none'] });",
"const b = await puppeteer.launch({ args: ['--no-sandbox', '--font-render-hinting=none', ...(cfg.args || [])], env: { ...process.env, ...(cfg.env || {}) } });")
open('variants.js','w').write(s)
import json
stack='-apple-system, BlinkMacSystemFont, "Segoe UI", "Helvetica Neue", Arial, "PingFang TC", "Microsoft JhengHei", "Noto Sans CJK TC", "Noto Sans TC", sans-serif'
mono='"Cascadia Mono", Consolas, "SFMono-Regular", "Liberation Mono", Menlo, "Microsoft JhengHei", monospace'
V={"A":"","B":f"body{{font-family:{stack}}} code{{font-family:{mono}}}","C":f"body{{font-family:{stack};text-autospace:normal}} code{{font-family:{mono}}}"}
shots=[]
for k,css in V.items():
  shots.append(dict(name=f"i2-zh-{k}",width=1440,height=900,dpr=2,css=css,target="8.3 Safety",offset=150,clip=dict(x=340,y=0,width=760,height=420)))
  shots.append(dict(name=f"i2-rev-{k}",width=1440,height=900,dpr=2,css=css,target="Revision History",offset=10,clip=dict(x=340,y=40,width=900,height=380)))
json.dump(dict(html="/tmp/md2doc/mac_merge_tx_spec-e2407d.html",outDir=S+"/shots",args=["--lang=zh-TW"],env={"LANG":"zh_TW.UTF-8"},shots=shots),open('i2.json','w'))
E
FONTCONFIG_FILE=$S/fonts-sc.conf node variants.js i2.json 2>&1 | grep -v '^shot'; ls shots | grep i2
```

```bash
S=/tmp/claude-1000/-home-user-hp-workspace-md2doc/cc552bfe-c005-4ece-b528-ad08d7b94e52/scratchpad; cd $S && grep -c 'cfg.args' variants.js && python3 - <<'E'
import json, os
S=os.getcwd()
stack='-apple-system, BlinkMacSystemFont, "Segoe UI", "Helvetica Neue", Arial, "PingFang TC", "Microsoft JhengHei", "Noto Sans CJK TC", "Noto Sans TC", sans-serif'
mono='"Cascadia Mono", Consolas, "SFMono-Regular", "Liberation Mono", Menlo, "Microsoft JhengHei", monospace'
V={"A":"","B":f"body{{font-family:{stack}}} code{{font-family:{mono}}}","C":f"body{{font-family:{stack};text-autospace:normal}} code{{font-family:{mono}}}"}
shots=[]
for k,css in V.items():
  shots.append(dict(name=f"i2-zh-{k}",width=1440,height=900,dpr=2,css=css,target="8.3 Safety",offset=150,clip=dict(x=340,y=0,width=760,height=420)))
  shots.append(dict(name=f"i2-rev-{k}",width=1440,height=900,dpr=2,css=css,target="Revision History",offset=10,clip=dict(x=340,y=40,width=900,height=380)))
json.dump(dict(html="/tmp/md2doc/mac_merge_tx_spec-e2407d.html",outDir=S+"/shots",args=["--lang=zh-TW"],env={"LANG":"zh_TW.UTF-8"},shots=shots),open('i2.json','w'))
E
FONTCONFIG_FILE=$S/fonts-sc.conf node variants.js i2.json 2>&1 | grep -v '^shot'; ls shots | grep i2
```

```bash
S=/tmp/claude-1000/-home-user-hp-workspace-md2doc/cc552bfe-c005-4ece-b528-ad08d7b94e52/scratchpad; cd $S && python3 - <<'E'
import json, os
S=os.getcwd()
base='body{font-family:-apple-system, BlinkMacSystemFont, "Segoe UI", "Helvetica Neue", Arial, "PingFang TC", "Microsoft JhengHei", "Noto Sans CJK TC", "Noto Sans TC", sans-serif} code{font-family:"Cascadia Mono", Consolas, "SFMono-Regular", "Liberation Mono", Menlo, "Microsoft JhengHei", monospace}'
top='.content table th, .content table td{vertical-align:top} .content table{font-variant-numeric:tabular-nums}'
rules='.content table th, .content table td{border-left:none;border-right:none;border-top:none;border-bottom:1px solid #e1e4e8} .content table thead th{border-bottom:2px solid #c9ced4}'
nozebra='.content table tr:nth-child(even), .content table tbody tr:nth-child(even) td:first-child{background:#ffffff} .content table th, .content table thead th:first-child{background:#ffffff}'
V={"A":base,"B":base+top,"C":base+top+rules,"D":base+top+rules+nozebra}
shots=[]
for k,css in V.items():
  shots.append(dict(name=f"i3-rev-{k}",width=1440,height=900,css=css,target="Revision History",offset=10,clip=dict(x=340,y=40,width=1100,height=700)))
  shots.append(dict(name=f"i3-if-{k}",width=1440,height=900,css=css,target="IF-VR-01",offset=20,clip=dict(x=340,y=0,width=1100,height=620)))
  shots.append(dict(name=f"i3-err-{k}",width=1440,height=900,css=css,target="9. Exception and Error Handling",offset=10,clip=dict(x=340,y=0,width=1100,height=700)))
  shots.append(dict(name=f"i3-mob-{k}",width=390,height=844,dpr=2,css=css,target="5. Parameters and Configuration",offset=70,clip=dict(x=0,y=0,width=390,height=844)))
json.dump(dict(html="/tmp/md2doc/mac_merge_tx_spec-e2407d.html",outDir=S+"/shots",args=["--lang=zh-TW"],env={"LANG":"zh_TW.UTF-8"},shots=shots),open('i3.json','w'))
E
FONTCONFIG_FILE=$S/fonts-sc.conf node variants.js i3.json 2>&1 | grep -v '^shot'; ls shots | grep -c i3
```

```bash
S=/tmp/claude-1000/-home-user-hp-workspace-md2doc/cc552bfe-c005-4ece-b528-ad08d7b94e52/scratchpad; cd $S && python3 - <<'E'
p='build_item.py'; s=open(p).read()
s=s.replace("""    single = f'<img class="shot" data-scene="{sc["id"]}" alt="" width="{sc["w"]}" height="{sc["h"]}">'""",
"""    mw = f' style="max-width:{sc["maxw"]}px"' if sc.get("maxw") else ""
    single = f'<img class="shot" data-scene="{sc["id"]}" alt="" width="{sc["w"]}" height="{sc["h"]}"{mw}>'""")
s=s.replace("""f'<img src="img/{slug}-{sc["id"]}-{o["key"]}.png" alt="{esc(sc["title"])}：選項 {o["key"]}" width="{sc["w"]}" height="{sc["h"]}" loading="lazy"></figure>'""",
"""f'<img src="img/{slug}-{sc["id"]}-{o["key"]}.png" alt="{esc(sc["title"])}：選項 {o["key"]}" width="{sc["w"]}" height="{sc["h"]}" loading="lazy"{mw}></figure>'""")
open(p,'w').write(s)
E
python3 - <<E
import json; p="$S/i3-item.json"; d=json.load(open(p)); d["scenes"][3]["maxw"]=390; json.dump(d,open(p,"w"),ensure_ascii=False)
E
python3 build_item.py i3-item.json && grep -c 'max-width:390px' review/i3/i3.html
```

```bash
S=/tmp/claude-1000/-home-user-hp-workspace-md2doc/cc552bfe-c005-4ece-b528-ad08d7b94e52/scratchpad; cd $S && cat > decided.py <<'E'
# CSS for decisions already made, applied under every later item's screenshots.
FONT = 'body{font-family:-apple-system, BlinkMacSystemFont, "Segoe UI", "Helvetica Neue", Arial, "PingFang TC", "Microsoft JhengHei", "Noto Sans CJK TC", "Noto Sans TC", sans-serif} code{font-family:"Cascadia Mono", Consolas, "SFMono-Regular", "Liberation Mono", Menlo, "Microsoft JhengHei", monospace}'
TABLE = ('.content table th, .content table td{vertical-align:top} .content table{font-variant-numeric:tabular-nums}'
         '.content table th, .content table td{border-left:none;border-right:none;border-top:none;border-bottom:1px solid #e1e4e8} .content table thead th{border-bottom:2px solid #c9ced4}'
         '.content table tr:nth-child(even), .content table tbody tr:nth-child(even) td:first-child{background:#ffffff} .content table th, .content table thead th:first-child{background:#ffffff}')
BASE = FONT + TABLE
COMMON = dict(html="/tmp/md2doc/mac_merge_tx_spec-e2407d.html", args=["--lang=zh-TW"], env={"LANG": "zh_TW.UTF-8"})
E
python3 - <<'E'
import json, os, sys
sys.path.insert(0, '.'); from decided import BASE, COMMON
S=os.getcwd()
size='.content h2{margin-top:2.2em;margin-bottom:.7em} .content h3{font-size:1.3em;margin-top:2em;margin-bottom:.5em} .content h4{font-size:1.1em;margin-top:1.8em;margin-bottom:.4em}'
sec='.content .sec{color:#8b949e;font-weight:500;margin-right:.4em;font-variant-numeric:tabular-nums}'
hang='.content{padding-left:3.8em;box-sizing:border-box} .content .heading-with-anchor{position:relative} .content .sec{position:absolute;right:100%;margin-right:.55em;color:#8b949e;font-weight:500;white-space:nowrap;font-variant-numeric:tabular-nums}'
js=r"""document.querySelectorAll('.content :is(h1,h2,h3,h4,h5,h6)').forEach(h=>{const t=h.firstChild; if(t&&t.nodeType===3){const m=t.data.match(/^(\d+(?:\.\d+)*\.?)\s+/); if(m){const s=document.createElement('span'); s.className='sec'; s.textContent=m[1]; t.data=t.data.slice(m[0].length); h.insertBefore(s,t);}}})"""
V={"A":(BASE,None),"B":(BASE+size,None),"C":(BASE+size+sec,js),"D":(BASE+size+hang,js)}
shots=[]
for k,(css,j) in V.items():
  for sid,t,off in [("ad","3.4.1 AD-MMTX-001",260),("as","4.1 Assumptions",150),("if","IF-TX-04 — Dual",40)]:
    shots.append(dict(name=f"i4-{sid}-{k}",width=1440,height=900,css=css,js=j,target=t,offset=off,clip=dict(x=340,y=0,width=1100,height=760)))
json.dump(dict(COMMON,outDir=S+"/shots",shots=shots),open('i4.json','w'))
E
FONTCONFIG_FILE=$S/fonts-sc.conf node variants.js i4.json 2>&1 | grep -v '^shot'; ls shots | grep -c i4
```

```bash
S=/tmp/claude-1000/-home-user-hp-workspace-md2doc/cc552bfe-c005-4ece-b528-ad08d7b94e52/scratchpad; cd $S && python3 - <<'E'
import json
d=json.load(open('i4.json'))
for s in d['shots']:
  if s['name'][-1] in 'CD':
    s['target']=s['target'].replace('3.4.1 ','3.4.1').replace('4.1 ','4.1')
d['shots']=[s for s in d['shots'] if s['name'][-1] in 'CD' and s['name'].split('-')[1] in ('ad','as')]
json.dump(d,open('i4b.json','w'))
E
FONTCONFIG_FILE=$S/fonts-sc.conf node variants.js i4b.json 2>&1 | grep -v '^shot'; echo done
```

```bash
S=/tmp/claude-1000/-home-user-hp-workspace-md2doc/cc552bfe-c005-4ece-b528-ad08d7b94e52/scratchpad; cat > $S/refs.js <<'E'
const puppeteer = require('/home/user/hp_workspace/md2doc/node_modules/puppeteer');
const sites = [
  ['w3c', 'https://www.w3.org/TR/css-grid-2/', 'h3'],
  ['whatwg', 'https://html.spec.whatwg.org/multipage/dom.html', 'h4'],
  ['ecma', 'https://tc39.es/ecma262/multipage/ecmascript-data-types-and-values.html', 'h1'],
  ['rfc', 'https://www.rfc-editor.org/rfc/rfc9293.html', 'h3'],
];
(async () => {
  const b = await puppeteer.launch({ args: ['--no-sandbox'] });
  for (const [id, url, tag] of sites) {
    const p = await b.newPage(); await p.setViewport({ width: 1440, height: 900 });
    try { await p.goto(url, { waitUntil: 'networkidle2', timeout: 60000 }); } catch (e) { console.log(id, 'load', e.message); }
    await new Promise(r => setTimeout(r, 1500));
    const info = await p.evaluate(() => {
      const body = parseFloat(getComputedStyle(document.body).fontSize);
      const out = { body, levels: {} };
      for (const t of ['h2', 'h3', 'h4']) {
        const hs = [...document.querySelectorAll(t)].filter(h => /^\s*[\d.]+|^\s*[A-Z]?\d/.test(h.textContent));
        const h = hs[Math.min(3, hs.length - 1)];
        if (!h) continue;
        const cs = getComputedStyle(h);
        const num = h.querySelector('.secno, .secnum, [class*="secno"], [class*="secnum"], .section-number, a.section-number, span');
        const ncs = num ? getComputedStyle(num) : null;
        out.levels[t] = { text: h.textContent.trim().slice(0, 50), size: (parseFloat(cs.fontSize) / body).toFixed(2), weight: cs.fontWeight, color: cs.color, mt: cs.marginTop, mb: cs.marginBottom,
          num: num ? { cls: num.className, text: num.textContent.trim().slice(0, 12), color: ncs.color, weight: ncs.fontWeight, pos: ncs.position } : null };
      }
      return out;
    });
    console.log(id, JSON.stringify(info));
    const target = await p.evaluate(() => { const h = [...document.querySelectorAll('h3')].filter(h => /\d/.test(h.textContent))[2] || document.querySelector('h2'); if (!h) return false; window.scrollTo(0, h.getBoundingClientRect().top + scrollY - 200); return true; });
    await new Promise(r => setTimeout(r, 800));
    await p.screenshot({ path: `${process.argv[2]}/ref-${id}.png` });
    await p.close();
  }
  await b.close();
})();
E
cd /home/user/hp_workspace/md2doc && FONTCONFIG_FILE=$S/fonts-sc.conf timeout 300 node $S/refs.js $S/shots
```

```bash
S=/tmp/claude-1000/-home-user-hp-workspace-md2doc/cc552bfe-c005-4ece-b528-ad08d7b94e52/scratchpad; cat > $S/refs2.js <<'E'
const puppeteer = require('/home/user/hp_workspace/md2doc/node_modules/puppeteer');
(async () => {
  const b = await puppeteer.launch({ args: ['--no-sandbox'] });
  for (const [id, url, sel] of [['w3c','https://www.w3.org/TR/css-grid-2/','.secno'],['ecma','https://tc39.es/ecma262/multipage/ecmascript-data-types-and-values.html','.secnum']]) {
    const p = await b.newPage(); await p.setViewport({ width: 1440, height: 900 });
    await p.goto(url, { waitUntil: 'networkidle2', timeout: 60000 }).catch(e => console.log(id, e.message));
    await new Promise(r => setTimeout(r, 1500));
    const info = await p.evaluate((sel) => {
      const body = parseFloat(getComputedStyle(document.body).fontSize);
      const res = {};
      for (const n of document.querySelectorAll(sel)) {
        const h = n.closest('h1,h2,h3,h4,h5,h6'); if (!h || h.closest('nav,#toc,.toc')) continue;
        const d = h.tagName; if (res[d]) continue;
        const hc = getComputedStyle(h), nc = getComputedStyle(n);
        res[d] = { text: h.textContent.trim().replace(/\s+/g,' ').slice(0, 50), size: (parseFloat(hc.fontSize) / body).toFixed(2), weight: hc.fontWeight, color: hc.color, mt: hc.marginTop, mb: hc.marginBottom, numColor: nc.color, numWeight: nc.fontWeight, numPos: nc.position, numFloat: nc.float, numMarginL: nc.marginLeft };
      }
      return { body, res };
    }, sel);
    console.log(id, JSON.stringify(info));
    await p.evaluate((sel) => { const n = [...document.querySelectorAll(sel)].map(n => n.closest('h3,h4')).filter(Boolean)[2]; if (n) window.scrollTo(0, n.getBoundingClientRect().top + scrollY - 200); }, sel);
    await new Promise(r => setTimeout(r, 800));
    await p.screenshot({ path: `${process.argv[2]}/ref-${id}.png` });
    await p.close();
  }
  await b.close();
})();
E
cd /home/user/hp_workspace/md2doc && FONTCONFIG_FILE=$S/fonts-sc.conf timeout 200 node $S/refs2.js $S/shots
```

```bash
S=/tmp/claude-1000/-home-user-hp-workspace-md2doc/cc552bfe-c005-4ece-b528-ad08d7b94e52/scratchpad; cd $S && for s in ad as if; do mv shots/i4-$s-C.png shots/i4-$s-D.png; done && python3 - <<'E'
import json, os, sys
sys.path.insert(0,'.'); from decided import BASE, COMMON
size='.content h2{margin-top:2.2em;margin-bottom:.7em} .content h3{font-size:1.3em;margin-top:2em;margin-bottom:.5em} .content h4{font-size:1.1em;margin-top:1.8em;margin-bottom:.4em}'
gap='.content .sec{margin-right:.65em;font-variant-numeric:tabular-nums}'
js=r"""document.querySelectorAll('.content :is(h1,h2,h3,h4,h5,h6)').forEach(h=>{const t=h.firstChild; if(t&&t.nodeType===3){const m=t.data.match(/^(\d+(?:\.\d+)*\.?)\s+/); if(m){const s=document.createElement('span'); s.className='sec'; s.textContent=m[1]; t.data=t.data.slice(m[0].length); h.insertBefore(s,t);}}})"""
shots=[]
for sid,t,off in [("ad","3.4.1AD-MMTX-001",260),("as","4.1Assumptions",150),("if","IF-TX-04 — Dual",40)]:
  shots.append(dict(name=f"i4-{sid}-C",width=1440,height=900,css=BASE+size+gap,js=js,target=t,offset=off,clip=dict(x=340,y=0,width=1100,height=760)))
json.dump(dict(COMMON,outDir=os.getcwd()+"/shots",shots=shots),open('i4c.json','w'))
from PIL import Image
Image.open('shots/ref-whatwg.png').crop((0,170,1300,700)).save('shots/ref4-whatwg.png')
Image.open('shots/ref-rfc.png').crop((140,160,920,420)).save('shots/ref4-rfc.png')
Image.open('shots/ref-ecma.png').crop((476,0,1440,640)).save('shots/ref4-ecma.png')
E
FONTCONFIG_FILE=$S/fonts-sc.conf node variants.js i4c.json 2>&1 | grep -v '^shot'; echo ok
```

```bash
S=/tmp/claude-1000/-home-user-hp-workspace-md2doc/cc552bfe-c005-4ece-b528-ad08d7b94e52/scratchpad; cd $S && python3 - <<'E'
p='build_item.py'; s=open(p).read()
s=s.replace("  {scenes_html}\n","  {scenes_html}\n  {refs_html}\n",1)
s=s.replace(".recbox {{", ".refs {{ margin-top: 40px; border-top: 1px solid var(--rule); padding-top: 22px; }}\n.refs figure {{ margin: 16px 0 22px; }}\n.refs img {{ display: block; max-width: 100%; height: auto; border: 1px solid var(--rule); border-radius: 4px; }}\n.refs figcaption {{ font-size: .9rem; color: var(--muted); margin-top: 6px; max-width: 52em; }}\n.recbox {{",1)
open(p,'w').write(s)
E
grep -c refs_html build_item.py
```

```bash
S=/tmp/claude-1000/-home-user-hp-workspace-md2doc/cc552bfe-c005-4ece-b528-ad08d7b94e52/scratchpad; cd $S && sed -i 's/後面接兩個空白的寬度，和標題同色。/後面的空隙比一般空白寬，和標題同色。/' i4-item.json && python3 build_item.py i4-item.json >/dev/null && python3 -c "
from PIL import Image; Image.open('shots/i4-ad-C.png').crop((0,230,700,300)).save('/tmp/claude-1000/-home-user-hp-workspace-md2doc/cc552bfe-c005-4ece-b528-ad08d7b94e52/scratchpad/peek.png')"
```

```bash
S=/tmp/claude-1000/-home-user-hp-workspace-md2doc/cc552bfe-c005-4ece-b528-ad08d7b94e52/scratchpad; cd $S && python3 - <<'E'
p='variants.js'; s=open(p).read()
s=s.replace("await p.goto('file://' + cfg.html,","await p.goto('file://' + (s.html || cfg.html),")
s=s.replace("    if (s.probe)","""    if (s.el) {
      const hs = await p.$$(s.el); const h = hs[s.idx || 0];
      await h.evaluate(e => e.scrollIntoView({ block: 'center' })); await new Promise(r => setTimeout(r, 400));
      await h.screenshot({ path: `${cfg.outDir}/${s.name}.png` }); console.log('shot', s.name); continue;
    }
    if (s.probe)""")
open(p,'w').write(s)
import json, os, sys
sys.path.insert(0,'.'); from decided import BASE, COMMON
src=open('/tmp/md2doc/mac_merge_tx_spec-e2407d.html').read()
init="mermaid.initialize({ startOnLoad: true, theme: 'default' })"
assert init in src
ff="\"Segoe UI\", \"Microsoft JhengHei\", Arial, sans-serif"
gvfix=lambda h: h.replace('font-family="Times,serif"','font-family="Helvetica,sans-Serif"')
V={
 "A": src,
 "B": gvfix(src.replace(init, "mermaid.initialize({ startOnLoad: true, theme: 'neutral', themeVariables: { fontFamily: '%s' } })" % ff.replace("'", "\\'"))),
 "C": gvfix(src.replace(init, "mermaid.initialize({ startOnLoad: true, theme: 'base', themeVariables: { fontFamily: '%s', primaryColor: '#eef3f8', primaryBorderColor: '#4f6b8a', primaryTextColor: '#24292e', lineColor: '#57606a', secondaryColor: '#f6f8fa', tertiaryColor: '#ffffff', edgeLabelBackground: '#ffffff' } })" % ff)),
 "D": gvfix(src),
}
shots=[]
for k,h in V.items():
  f=f"{os.getcwd()}/var-i5-{k}.html"; open(f,'w').write(h)
  for i in range(3): shots.append(dict(name=f"i5-m{i}-{k}",html=f,width=1440,height=900,css=BASE,el=".content .mermaid",idx=i))
  for i in range(2): shots.append(dict(name=f"i5-g{i}-{k}",html=f,width=1440,height=900,css=BASE,el=".content .graphviz",idx=i))
json.dump(dict(COMMON,outDir=os.getcwd()+"/shots",shots=shots),open('i5.json','w'))
E
FONTCONFIG_FILE=$S/fonts-sc.conf node variants.js i5.json 2>&1 | grep -v '^shot'; python3 -c "
from PIL import Image; import glob
for f in sorted(glob.glob('$S/shots/i5-*-A.png')): print(f.split('/')[-1], Image.open(f).size)"
```

```bash
S=/tmp/claude-1000/-home-user-hp-workspace-md2doc/cc552bfe-c005-4ece-b528-ad08d7b94e52/scratchpad; cd $S && python3 - <<'E'
import json
d=json.load(open('i5-item.json'))
d['scenes'][4]['title']='graphviz：12. Internal Architecture'
d['scenes'][4]['caption']='圖裡標籤互相壓到（例如 smd_illegal、tx_err）是 dot 的排版結果，每個選項都一樣，不是字型造成的。'
json.dump(d,open('i5-item.json','w'),ensure_ascii=False)
E
python3 build_item.py i5-item.json >/dev/null; cat i5-files.json
```

```bash
S=/tmp/claude-1000/-home-user-hp-workspace-md2doc/cc552bfe-c005-4ece-b528-ad08d7b94e52/scratchpad; cat > $S/refs5.js <<'E'
const puppeteer = require('/home/user/hp_workspace/md2doc/node_modules/puppeteer');
const sites = [
  ['mkdocs', 'https://squidfunk.github.io/mkdocs-material/reference/diagrams/'],
  ['docusaurus', 'https://docusaurus.io/docs/markdown-features/diagrams'],
  ['mermaiddocs', 'https://mermaid.js.org/syntax/stateDiagram.html'],
  ['github', 'https://github.com/mermaid-js/mermaid/blob/develop/README.md'],
];
(async () => {
  const b = await puppeteer.launch({ args: ['--no-sandbox'] });
  for (const [id, url] of sites) {
    const p = await b.newPage(); await p.setViewport({ width: 1440, height: 1000 });
    await p.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: 'light' }]);
    try { await p.goto(url, { waitUntil: 'networkidle2', timeout: 60000 }); } catch (e) { console.log(id, 'load', e.message); }
    await new Promise(r => setTimeout(r, 4000));
    const found = await p.evaluate(() => {
      const svgs = [...document.querySelectorAll('svg')].filter(s => s.querySelector('.node, .statediagram-state, g.node, rect.basic') && s.getBoundingClientRect().width > 150);
      const frames = [...document.querySelectorAll('iframe')].map(f => f.src).filter(s => /viewscreen|render/.test(s));
      if (!svgs.length) return { n: 0, frames };
      const s = svgs[0]; s.scrollIntoView({ block: 'center' });
      const r = s.querySelector('.node rect, .node path, rect.basic, .node polygon');
      const cs = r ? getComputedStyle(r) : null;
      const t = s.querySelector('.nodeLabel, text, span');
      return { n: svgs.length, fill: cs && cs.fill, stroke: cs && cs.stroke, font: t && getComputedStyle(t).fontFamily, frames };
    });
    console.log(id, JSON.stringify(found));
    await new Promise(r => setTimeout(r, 800));
    await p.screenshot({ path: `${process.argv[2]}/ref5-${id}.png` });
    await p.close();
  }
  await b.close();
})();
E
cd /home/user/hp_workspace/md2doc && FONTCONFIG_FILE=$S/fonts-sc.conf timeout 400 node $S/refs5.js $S/shots
```

```bash
S=/tmp/claude-1000/-home-user-hp-workspace-md2doc/cc552bfe-c005-4ece-b528-ad08d7b94e52/scratchpad; cat > $S/refs5b.js <<'E'
const puppeteer = require('/home/user/hp_workspace/md2doc/node_modules/puppeteer');
(async () => {
  const b = await puppeteer.launch({ args: ['--no-sandbox'] });
  // mkdocs material: mermaid renders into a shadow root on div.mermaid
  let p = await b.newPage(); await p.setViewport({ width: 1440, height: 1000 });
  await p.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: 'light' }]);
  await p.goto('https://squidfunk.github.io/mkdocs-material/reference/diagrams/', { waitUntil: 'networkidle2', timeout: 60000 }).catch(e => console.log(e.message));
  await new Promise(r => setTimeout(r, 4000));
  const info = await p.evaluate(() => {
    const hosts = [...document.querySelectorAll('.mermaid')];
    const out = [];
    for (const h of hosts) {
      const root = h.shadowRoot || h; const svg = root.querySelector('svg'); if (!svg) continue;
      const r = svg.querySelector('.node rect, .node path, .node polygon'); const cs = r && getComputedStyle(r);
      const t = svg.querySelector('.nodeLabel, text'); out.push({ type: svg.getAttribute('aria-roledescription'), fill: cs && cs.fill, stroke: cs && cs.stroke, font: t && getComputedStyle(t).fontFamily });
    }
    const st = hosts.find(h => ((h.shadowRoot || h).querySelector('svg') || {}).getAttribute && (h.shadowRoot || h).querySelector('svg').getAttribute('aria-roledescription') === 'stateDiagram') || hosts[0];
    if (st) st.scrollIntoView({ block: 'center' });
    return out;
  });
  console.log('mkdocs', JSON.stringify(info));
  await new Promise(r => setTimeout(r, 800));
  await p.screenshot({ path: process.argv[2] + '/ref5-mkdocs.png' }); await p.close();
  // github: screenshot first rendered mermaid iframe
  p = await b.newPage(); await p.setViewport({ width: 1440, height: 1000 });
  await p.goto('https://github.com/mermaid-js/mermaid/blob/develop/README.md', { waitUntil: 'networkidle2', timeout: 60000 }).catch(e => console.log(e.message));
  await new Promise(r => setTimeout(r, 6000));
  const frames = await p.$$('iframe[src*="viewscreen"]');
  console.log('github frames', frames.length);
  for (let i = 0; i < Math.min(frames.length, 4); i++) {
    await frames[i].evaluate(e => e.scrollIntoView({ block: 'center' })); await new Promise(r => setTimeout(r, 2500));
    const fr = await frames[i].contentFrame();
    const d = fr ? await fr.evaluate(() => { const svg = document.querySelector('svg'); if (!svg) return null; const r = svg.querySelector('.node rect, .node path, .node polygon'); const cs = r && getComputedStyle(r); const t = svg.querySelector('.nodeLabel, text'); return { type: svg.getAttribute('aria-roledescription'), fill: cs && cs.fill, stroke: cs && cs.stroke, font: t && getComputedStyle(t).fontFamily }; }).catch(e => 'err ' + e.message) : 'noframe';
    console.log('github', i, JSON.stringify(d));
    await frames[i].screenshot({ path: `${process.argv[2]}/ref5-github-${i}.png` }).catch(e => console.log('shot', e.message));
  }
  await b.close();
})();
E
cd /home/user/hp_workspace/md2doc && FONTCONFIG_FILE=$S/fonts-sc.conf timeout 300 node $S/refs5b.js $S/shots
```

```bash
S=/tmp/claude-1000/-home-user-hp-workspace-md2doc/cc552bfe-c005-4ece-b528-ad08d7b94e52/scratchpad; cat > $S/refs5c.js <<'E'
const puppeteer = require('/home/user/hp_workspace/md2doc/node_modules/puppeteer');
(async () => {
  const b = await puppeteer.launch({ args: ['--no-sandbox'] });
  const p = await b.newPage(); await p.setViewport({ width: 1440, height: 1000 });
  await p.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: 'light' }]);
  await p.goto('https://mermaid.js.org/syntax/stateDiagram.html', { waitUntil: 'networkidle2', timeout: 60000 }).catch(e => console.log(e.message));
  await new Promise(r => setTimeout(r, 3000));
  await p.evaluate(() => { const a = [...document.querySelectorAll('a,button')].find(x => /skip for now/i.test(x.textContent)); if (a) a.click(); });
  await new Promise(r => setTimeout(r, 1500));
  const heads = await p.evaluate(() => [...document.querySelectorAll('h2,h3')].slice(0, 6).map(h => h.textContent.trim()));
  console.log(heads);
  const svgs = await p.$$('svg[aria-roledescription^="state"]');
  console.log('state svgs', svgs.length);
  for (let i = 0; i < Math.min(3, svgs.length); i++) {
    const d = await svgs[i].evaluate(s => { const r = s.querySelector('.node rect, .node path'); const cs = r && getComputedStyle(r); const t = s.querySelector('.nodeLabel, text'); let h = s; while (h && !/^H[23]$/.test((h.previousElementSibling || {}).tagName || '')) h = h.parentElement; return { fill: cs && cs.fill, stroke: cs && cs.stroke, font: t && getComputedStyle(t).fontFamily, w: s.getBoundingClientRect().width }; });
    console.log(i, JSON.stringify(d));
    await svgs[i].evaluate(e => e.scrollIntoView({ block: 'center' })); await new Promise(r => setTimeout(r, 500));
    await svgs[i].screenshot({ path: `${process.argv[2]}/ref5-mermaid-${i}.png` });
  }
  const ds = await p.$$('.docusaurus');
  await b.close();
  const b2 = await puppeteer.launch({ args: ['--no-sandbox'] }); const q = await b2.newPage(); await q.setViewport({ width: 1440, height: 1000 });
  await q.goto('https://docusaurus.io/docs/markdown-features/diagrams', { waitUntil: 'networkidle2', timeout: 60000 }).catch(e => console.log(e.message));
  await new Promise(r => setTimeout(r, 3000));
  const dsv = (await q.$$('svg[aria-roledescription]'))[0];
  if (dsv) { await dsv.evaluate(e => e.scrollIntoView({ block: 'center' })); await new Promise(r => setTimeout(r, 500)); await dsv.screenshot({ path: `${process.argv[2]}/ref5-docusaurus-el.png` }); }
  const m = await q.$('.mermaid'); console.log('docu', !!dsv);
  await b2.close();
})();
E
cd /home/user/hp_workspace/md2doc && FONTCONFIG_FILE=$S/fonts-sc.conf timeout 240 node $S/refs5c.js $S/shots
```

```bash
S=/tmp/claude-1000/-home-user-hp-workspace-md2doc/cc552bfe-c005-4ece-b528-ad08d7b94e52/scratchpad; cd $S && rm -f shots/i5-* && python3 - <<'E'
import json, os, sys
sys.path.insert(0,'.'); from decided import BASE, COMMON
src=open('/tmp/md2doc/mac_merge_tx_spec-e2407d.html').read()
init="mermaid.initialize({ startOnLoad: true, theme: 'default' })"
ff='"Segoe UI", "Microsoft JhengHei", Arial, sans-serif'
gv=lambda h: h.replace('font-family="Times,serif"','font-family="Helvetica,sans-Serif"')
def m(cfg): return gv(src.replace(init, "mermaid.initialize({ startOnLoad: true, %s })" % cfg))
V={
 "A": src,
 "B": m("theme: 'base', themeVariables: { fontFamily: '%s', primaryColor: '#eaf2fd', primaryBorderColor: '#0969da', primaryTextColor: '#1f2328', lineColor: '#57606a', secondaryColor: '#f6f8fa', tertiaryColor: '#ffffff', edgeLabelBackground: '#ffffff' }" % ff),
 "C": m("theme: 'redux-color', look: 'neo', themeVariables: { fontFamily: '%s' }" % ff),
 "D": m("theme: 'redux', look: 'neo', themeVariables: { fontFamily: '%s' }" % ff),
}
shots=[]
for k,h in V.items():
  f=f"{os.getcwd()}/var-i5-{k}.html"; open(f,'w').write(h)
  for i in range(3): shots.append(dict(name=f"i5-m{i}-{k}",html=f,width=1440,height=900,css=BASE,el=".content .mermaid",idx=i))
  for i in range(2): shots.append(dict(name=f"i5-g{i}-{k}",html=f,width=1440,height=900,css=BASE,el=".content .graphviz",idx=i))
json.dump(dict(COMMON,outDir=os.getcwd()+"/shots",shots=shots),open('i5.json','w'))
E
FONTCONFIG_FILE=$S/fonts-sc.conf node variants.js i5.json 2>&1 | grep -v '^shot'; ls shots | grep -c '^i5-'
```

```bash
S=/tmp/claude-1000/-home-user-hp-workspace-md2doc/cc552bfe-c005-4ece-b528-ad08d7b94e52/scratchpad; cd $S && rm -f shots/i5-*-D.png && python3 - <<'E'
import json, os, sys
sys.path.insert(0,'.'); from decided import BASE, COMMON
src=open('/tmp/md2doc/mac_merge_tx_spec-e2407d.html').read()
init="mermaid.initialize({ startOnLoad: true, theme: 'default' })"
ff='"Segoe UI", "Microsoft JhengHei", Arial, sans-serif'
h=src.replace(init, "mermaid.initialize({ startOnLoad: true, theme: 'redux-color', look: 'neo', themeVariables: { fontFamily: '%s', edgeLabelBackground: '#ffffff' } })" % ff).replace('font-family="Times,serif"','font-family="Helvetica,sans-Serif"')
f=os.getcwd()+"/var-i5-D.html"; open(f,'w').write(h)
shots=[dict(name=f"i5-m{i}-D",html=f,width=1440,height=900,css=BASE,el=".content .mermaid",idx=i) for i in range(3)]+[dict(name=f"i5-g{i}-D",html=f,width=1440,height=900,css=BASE,el=".content .graphviz",idx=i) for i in range(2)]
json.dump(dict(COMMON,outDir=os.getcwd()+"/shots",shots=shots),open('i5d.json','w'))
E
FONTCONFIG_FILE=$S/fonts-sc.conf node variants.js i5d.json 2>&1 | grep -v '^shot'; echo ok
```

```bash
S=/tmp/claude-1000/-home-user-hp-workspace-md2doc/cc552bfe-c005-4ece-b528-ad08d7b94e52/scratchpad; cd $S && python3 -c "
from PIL import Image
Image.open('shots/ref5-mkdocs.png').crop((376,405,1064,596)).save('shots/ref5-mkdocs-el.png')
Image.open('shots/ref5-github-0.png').crop((150,30,880,230)).save('shots/ref5-github-el.png')
" && cat > i5-item.json <<'E'
{
  "n": 5, "slug": "i5", "short": "圖表配色",
  "title": "圖表的字型與配色",
  "intro": [
    "兩個問題：mermaid 用的是 <code>theme: 'default'</code>，淡紫色底加紫框；graphviz 在作者沒指定 <code>fontname</code> 時預設用 Times，所以同一張圖裡節點是無襯線字、連線標籤卻是襯線字（這份 spec 的輸出裡有 25 處 <code>Times,serif</code>）。",
    "<strong>這一版改過。</strong>上一版用「適合列印」當作推薦 neutral 的理由，但 HTML 是給人在螢幕上讀的，所以改找以螢幕閱讀為主的文件網站當參考，實測截圖放在頁面最下方。我上一版也說錯了一件事：md2doc 用的 mermaid 11.15.0 不只五個主題，另外還有 <code>neo</code>、<code>redux</code>、<code>redux-color</code> 主題，以及 <code>look: 'neo'</code> 外觀。",
    "B、C、D 都已經把 graphviz 的 Times 換成和節點相同的 Helvetica 系（Windows 上實際顯示 Arial）。節點的底色（淺藍、灰）是作者在 .dot 裡指定的，任何選項都不會改動。"
  ],
  "options": [
    {"key": "A", "label": "現況：mermaid 預設紫色", "desc": "GitHub 與 Docusaurus 都是這個樣子（見下方參考）。graphviz 連線標籤維持 Times。"},
    {"key": "B", "label": "套用文件主色", "desc": "Material for MkDocs 的做法：淡藍底，框線用 md2doc 的連結藍 <code>#0969da</code>，字型和內文一致。用 base 主題加一組 themeVariables，需要自己維護這組色票。"},
    {"key": "C", "label": "mermaid 新外觀", "desc": "mermaid 官網現在的狀態圖預設：<code>redux-color</code> 主題加 <code>look: 'neo'</code>，白底、深色框、粗線、圓角。連線標籤是 mermaid 預設的灰底色塊（官網上也是這樣）。"},
    {"key": "D", "label": "mermaid 新外觀＋白底標籤", "rec": true, "desc": "同 C，只多一行 <code>edgeLabelBackground: '#ffffff'</code>，拿掉連線標籤的灰底色塊。"}
  ],
  "scenes": [
    {"id": "m0", "title": "mermaid：TX_PROC 狀態機（13.1）", "caption": "最大的一張狀態圖，線條交錯最多。", "w": 1060, "h": 1064},
    {"id": "m1", "title": "mermaid：Verify 狀態機", "caption": "連線標籤很長的狀態圖，最容易看出 C 的灰底色塊和 D 的差別。", "w": 1060, "h": 656},
    {"id": "m2", "title": "mermaid：Respond 狀態機", "caption": "小圖。", "w": 1060, "h": 234},
    {"id": "g0", "title": "graphviz：1.1 Overview Block Diagram", "caption": "看 emac_tx_*、pulse_100us 等連線標籤：A 是 Times 襯線字，其他選項是無襯線字。", "w": 1060, "h": 518},
    {"id": "g1", "title": "graphviz：12. Internal Architecture", "caption": "圖裡標籤互相壓到（例如 smd_illegal、tx_err）是 dot 自動排版造成的，每個選項都一樣，不是字型造成的。", "w": 1060, "h": 436}
  ],
  "refs_title": "參考：以螢幕閱讀為主的文件網站怎麼畫 mermaid",
  "refs_intro": "2026-10-01 用 Chrome 實際開啟並讀取節點的 computed style。",
  "refs": [
    {"img": "ref5-github-el.png", "title": "GitHub（README 的 mermaid 區塊）", "caption": "節點底色 <code>rgb(236,236,255)</code>、框線 <code>rgb(147,112,219)</code>、字型 trebuchet ms。就是 mermaid 預設主題，和 md2doc 現況相同。", "w": 730, "h": 200},
    {"img": "ref5-docusaurus-el.png", "title": "Docusaurus 官方文件", "caption": "同樣是 mermaid 預設主題，節點顏色與 GitHub 完全相同。", "w": 360, "h": 240},
    {"img": "ref5-mkdocs-el.png", "title": "Material for MkDocs 官方文件", "caption": "圖表跟著網站配色：淡靛藍底、靛藍框、細線，字型和內文一致（Roboto）。這是 B 選項的做法。", "w": 688, "h": 191},
    {"img": "ref5-mermaid-2.png", "title": "mermaid 官網（v12 文件）狀態圖", "caption": "節點白底、框線 <code>rgb(40,37,61)</code>、粗線條、圓角，是 redux-color 主題加 neo 外觀，也是 v12 狀態圖的新預設。連線標籤是灰底。這是 C、D 選項的做法。", "w": 220, "h": 685}
  ],
  "recommend": "<p><strong>我推薦 D：mermaid 新外觀＋白底標籤。</strong>理由：一、你的 spec 裡三張 mermaid 圖全是狀態機，而 neo 外觀正是 mermaid 官方為狀態圖新定的預設，粗框線、深色線條在螢幕上最容易追蹤狀態轉移，日後 mermaid 升到 v12 也不會變成另一種樣子；二、它不需要維護色票（B 需要），只多一行白底標籤，就修掉 C 最刺眼的灰色色塊，長條件式的轉移標籤變得好讀。</p><p>如果你比較希望圖表和文件的藍色系融為一體，B 是次佳選擇，也是 Material for MkDocs 的做法。</p>",
  "notes": ["A 並不是「錯」：GitHub、Docusaurus 都這樣。它的問題只在紫色是文件其他地方都沒有的顏色，以及沒有修 graphviz 的 Times。"]
}
E
python3 build_item.py i5-item.json >/dev/null && ls review/i5/img | wc -l
```

```bash
S=/tmp/claude-1000/-home-user-hp-workspace-md2doc/cc552bfe-c005-4ece-b528-ad08d7b94e52/scratchpad; cd $S && rm -f shots/i5-* review/i5/img/i5-* && python3 - <<'E'
import json, os, sys
sys.path.insert(0,'.'); from decided import BASE, COMMON
src=open('/tmp/md2doc/mac_merge_tx_spec-e2407d.html').read()
init="mermaid.initialize({ startOnLoad: true, theme: 'default' })"
ff='"Segoe UI", "Microsoft JhengHei", Arial, sans-serif'
gv=lambda h: h.replace('font-family="Times,serif"','font-family="Helvetica,sans-Serif"')
def m(cfg): return gv(src.replace(init, "mermaid.initialize({ startOnLoad: true, %s })" % cfg))
def base(fill, border, text='#1f2328', line='#57606a', look=None, label='#ffffff'):
    lk = f"look: '{look}', " if look else ""
    return m(f"theme: 'base', {lk}themeVariables: {{ fontFamily: '{ff}', primaryColor: '{fill}', primaryBorderColor: '{border}', primaryTextColor: '{text}', lineColor: '{line}', secondaryColor: '#f6f8fa', tertiaryColor: '#ffffff', edgeLabelBackground: '{label}' }}")
V={
 "A": src,
 "B": base('#eaf2fd', '#0969da'),
 "C": base('#eaf2fd', '#0969da', look='neo'),
 "D": base('#eef0fb', '#4051b5'),
 "E": m(f"theme: 'forest', themeVariables: {{ fontFamily: '{ff}' }}"),
 "F": base('#e3f4f1', '#0f766e', line='#4b5a58'),
 "G": base('#fff3dd', '#b45309', line='#6b5b4a'),
 "H": m(f"theme: 'default', look: 'neo', themeVariables: {{ fontFamily: '{ff}', edgeLabelBackground: '#ffffff' }}"),
}
shots=[]
for k,h in V.items():
  f=f"{os.getcwd()}/var-i5-{k}.html"; open(f,'w').write(h)
  for i in range(3): shots.append(dict(name=f"i5-m{i}-{k}",html=f,width=1440,height=900,css=BASE,el=".content .mermaid",idx=i))
  for i in range(2): shots.append(dict(name=f"i5-g{i}-{k}",html=f,width=1440,height=900,css=BASE,el=".content .graphviz",idx=i))
json.dump(dict(COMMON,outDir=os.getcwd()+"/shots",shots=shots),open('i5.json','w'))
E
FONTCONFIG_FILE=$S/fonts-sc.conf node variants.js i5.json 2>&1 | grep -v '^shot'; ls shots | grep -c '^i5-'
```

```bash
S=/tmp/claude-1000/-home-user-hp-workspace-md2doc/cc552bfe-c005-4ece-b528-ad08d7b94e52/scratchpad; cd $S && python3 - <<'E'
import json
d=json.load(open('i5-item.json'))
d['intro']=[
 "兩個問題：mermaid 用的是 <code>theme: 'default'</code>，淡紫色底加紫框；graphviz 在作者沒指定 <code>fontname</code> 時預設用 Times，所以同一張圖裡節點是無襯線字、連線標籤卻是襯線字（這份 spec 的輸出裡有 25 處 <code>Times,serif</code>）。",
 "<strong>第三版：依你「偏好有上色」重做，共 8 種配色。</strong>每個選項後面都標明參考來源；標「自選」的是我配的色，沒有外部參考。除了 A 之外，mermaid 字型都改成和內文一致、連線標籤改成白底，graphviz 的 Times 也都換成和節點相同的 Helvetica 系（Windows 上實際顯示 Arial）。",
 "graphviz 節點的底色（淺藍、灰）是作者在 .dot 裡指定的，任何選項都不會改動；配色只影響 mermaid。選好色系之後，底色的深淺還可以再調。"
]
d['options']=[
 {"key":"A","label":"現況：預設紫","desc":"mermaid 預設主題。參考：GitHub、Docusaurus 都是這個樣子。graphviz 維持 Times。"},
 {"key":"B","label":"文件藍","desc":"淡藍底 <code>#eaf2fd</code>，框線用 md2doc 的連結藍 <code>#0969da</code>。參考：Material for MkDocs 讓圖表跟著網站主色。"},
 {"key":"C","label":"文件藍＋neo 外觀","rec":True,"desc":"同 B 的顏色，加上 mermaid 的 <code>look: 'neo'</code>：圓角、節點帶淡陰影。參考：MkDocs 的「跟著主色」＋ mermaid v12 狀態圖預設的 neo 外觀。"},
 {"key":"D","label":"靛藍","desc":"淡靛藍底 <code>#eef0fb</code>、靛藍框 <code>#4051b5</code>。參考：Material for MkDocs 預設主色 indigo 的實際配色。"},
 {"key":"E","label":"森林綠（mermaid 內建）","desc":"mermaid 內建的 forest 主題，底色最飽和。參考：mermaid 官方主題。"},
 {"key":"F","label":"青綠","desc":"淡青綠底 <code>#e3f4f1</code>、深青綠框 <code>#0f766e</code>。自選，沒有外部參考。"},
 {"key":"G","label":"琥珀","desc":"淡琥珀底 <code>#fff3dd</code>、深琥珀框 <code>#b45309</code>，暖色調。自選，沒有外部參考。"},
 {"key":"H","label":"預設紫＋neo 外觀","desc":"保留 mermaid 預設的紫色，只換成 neo 外觀並把標籤改成白底。參考：mermaid 官方的 default 主題＋neo 外觀。"}
]
d['recommend']="<p><strong>我推薦 C：文件藍＋neo 外觀。</strong>理由：一、圖表的藍和 md2doc 的連結、TOC 目前位置標示是同一個藍，圖和文件看起來是同一套設計；紫色（A、H）、綠色（E、F）、琥珀（G）則是文件其他地方都沒有的顏色；二、neo 外觀的圓角和淡陰影讓狀態方塊從線條中浮出來，在螢幕上追蹤狀態機的轉移比 B 的平面框更容易，而且它是 mermaid 官方為狀態圖定的新預設。</p><p>如果你想要顏色更明顯，E（森林綠）是 8 種裡最飽和的；也可以先選色系，我再把底色調深。</p>"
d['notes']=["A 並不是「錯」：GitHub、Docusaurus 都這樣。它的問題在於紫色是文件其他地方都沒有的顏色，而且沒有修 graphviz 的 Times。","上一版的「redux-color＋neo」（白底黑框）已經拿掉，因為它在這份 spec 的狀態圖上完全沒有顏色（redux-color 只會替複合狀態上色）。"]
json.dump(d,open('i5-item.json','w'),ensure_ascii=False)
E
python3 build_item.py i5-item.json >/dev/null && python3 -c "
import json,os
d='$S/review/i5/img'
json.dump({'img/'+f: d+'/'+f for f in sorted(os.listdir(d))}, open('$S/i5-files.json','w'))
print(len(os.listdir(d)))"
```

```bash
S=/tmp/claude-1000/-home-user-hp-workspace-md2doc/cc552bfe-c005-4ece-b528-ad08d7b94e52/scratchpad; cd $S && python3 - <<'E'
import json
d=json.load(open('i5-item.json'))
for r in d['refs']:
  if 'mkdocs' in r['img']: r['caption']="圖表跟著網站配色：淡靛藍底、靛藍框、細線，字型和內文一致（Roboto）。B、C 用同樣的做法換成 md2doc 的藍，D 直接用它的靛藍。"
  if 'mermaid-2' in r['img']: r['caption']="v12 狀態圖的新預設：redux-color 主題加 neo 外觀，白底、深色框、圓角。C、H 採用它的 neo 外觀，但保留顏色。"
  if 'github' in r['img'] or 'docusaurus' in r['img']: r['caption']=r['caption'].replace('和 md2doc 現況相同','和 md2doc 現況（A）相同')
json.dump(d,open('i5-item.json','w'),ensure_ascii=False)
E
python3 build_item.py i5-item.json >/dev/null; grep -c 'C、D 選項' review/i5/i5.html
```

```bash
S=/tmp/claude-1000/-home-user-hp-workspace-md2doc/cc552bfe-c005-4ece-b528-ad08d7b94e52/scratchpad; cd $S && cat >> decided.py <<'E'

# item 4 = C: larger H3/H4, space above > below, section number span with wider gap
HEAD = ('.content h2{margin-top:2.2em;margin-bottom:.7em} .content h3{font-size:1.3em;margin-top:2em;margin-bottom:.5em} .content h4{font-size:1.1em;margin-top:1.8em;margin-bottom:.4em}'
        '.content .sec{margin-right:.65em;font-variant-numeric:tabular-nums}')
BASE = FONT + TABLE + HEAD
JS = r"""document.querySelectorAll('.content :is(h1,h2,h3,h4,h5,h6)').forEach(h=>{const t=h.firstChild; if(t&&t.nodeType===3){const m=t.data.match(/^(\d+(?:\.\d+)*\.?)\s+/); if(m){const s=document.createElement('span'); s.className='sec'; s.textContent=m[1]; t.data=t.data.slice(m[0].length); h.insertBefore(s,t);}}})"""
# item 5 = B: doc-blue mermaid palette + graphviz Times fix, baked into the html
import os as _os
COMMON = dict(COMMON, html=_os.path.join(_os.path.dirname(_os.path.abspath(__file__)), "var-i5-B.html"))
E
python3 -c "import sys; sys.path.insert(0,'$S'); import decided; print(decided.COMMON['html'], len(decided.BASE))"; ls -la $S/var-i5-B.html | awk '{print $5}'
```

```bash
S=/tmp/claude-1000/-home-user-hp-workspace-md2doc/cc552bfe-c005-4ece-b528-ad08d7b94e52/scratchpad; cat > $S/refs6.js <<'E'
const puppeteer = require('/home/user/hp_workspace/md2doc/node_modules/puppeteer');
const sites = [['mkdocs','https://squidfunk.github.io/mkdocs-material/reference/diagrams/'],['docusaurus','https://docusaurus.io/docs/markdown-features/diagrams'],['mdn','https://developer.mozilla.org/en-US/docs/Web/CSS/position'],['ghdocs','https://docs.github.com/en/get-started/writing-on-github/working-with-advanced-formatting/creating-diagrams']];
(async () => {
  const b = await puppeteer.launch({ args: ['--no-sandbox'] });
  for (const [id, url] of sites) {
    const p = await b.newPage(); await p.setViewport({ width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
    await p.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: 'light' }]);
    await p.goto(url, { waitUntil: 'networkidle2', timeout: 60000 }).catch(e => console.log(id, e.message));
    await new Promise(r => setTimeout(r, 2500));
    await p.evaluate(() => window.scrollTo(0, 1400)); await new Promise(r => setTimeout(r, 1200));
    const bar = await p.evaluate(() => { const els = [...document.querySelectorAll('header, nav, [class*="header"], [class*="navbar"]')].filter(e => { const cs = getComputedStyle(e); const r = e.getBoundingClientRect(); return (cs.position === 'sticky' || cs.position === 'fixed') && r.top <= 1 && r.height > 20 && r.height < 120; }); return els.slice(0, 2).map(e => ({ tag: e.tagName, cls: String(e.className).slice(0, 40), h: Math.round(e.getBoundingClientRect().height), pos: getComputedStyle(e).position, text: e.innerText.replace(/\s+/g, ' ').slice(0, 60) })); });
    console.log(id, JSON.stringify(bar));
    await p.screenshot({ path: `${process.argv[2]}/ref6-${id}.png` });
    await p.close();
  }
  await b.close();
})();
E
cd /home/user/hp_workspace/md2doc && FONTCONFIG_FILE=$S/fonts-sc.conf timeout 300 node $S/refs6.js $S/shots
```

```bash
S=/tmp/claude-1000/-home-user-hp-workspace-md2doc/cc552bfe-c005-4ece-b528-ad08d7b94e52/scratchpad; cd $S && python3 - <<'E'
p='variants.js'; s=open(p).read()
s=s.replace("    if (s.el) {","    if (s.postjs) { await p.evaluate(s.postjs); await new Promise(r => setTimeout(r, 300)); }\n    if (s.el) {",1)
open(p,'w').write(s)
import json, os, sys
sys.path.insert(0,'.'); from decided import BASE, COMMON, JS
shadow='.reader-sidebar{box-shadow:none} body[data-sidebar-open] .reader-sidebar{box-shadow:2px 0 12px rgba(0,0,0,.15)}'
barcss=('.m-bar{position:fixed;top:0;left:0;right:0;z-index:100;background:#fff;border-bottom:1px solid #d8dee4;display:flex;align-items:center;gap:10px;padding:0 12px;box-sizing:border-box}'
        '.m-bar .sidebar-toggle{position:static;box-shadow:none;border-color:#d0d7de;flex:0 0 auto}'
        '.m-t{min-width:0;flex:1 1 auto;line-height:1.3}.m-t div{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}'
        '.m-t .l1{font-size:14px;font-weight:600;color:#24292e}.m-t .l0{font-size:11.5px;color:#6a737d}'
        '.page-layout{padding-top:60px !important}')
mk=r"""(()=>{const t=document.querySelector('.sidebar-toggle');const b=document.createElement('div');b.className='m-bar';b.style.height='%s';b.appendChild(t);const s=document.createElement('div');s.className='m-t';b.appendChild(s);document.body.appendChild(b);})()"""
lab=r"""const lab=h=>{if(!h)return'';const c=h.cloneNode(true);c.querySelectorAll('.heading-anchor').forEach(a=>a.remove());const s=c.querySelector('.sec');if(s)s.textContent=s.textContent+' ';return c.textContent.trim()};"""
post={
 "B": lab+r"""let h2=null,h3=null;for(const h of document.querySelectorAll('.content h1,.content h2,.content h3')){if(h.getBoundingClientRect().top<64){if(h.tagName!=='H3'){h2=h;h3=null}else h3=h}}document.querySelector('.m-t').innerHTML='<div class="l1"></div>';document.querySelector('.m-t .l1').textContent=lab(h3||h2);""",
 "C": lab+r"""let h2=null,h3=null;for(const h of document.querySelectorAll('.content h1,.content h2,.content h3')){if(h.getBoundingClientRect().top<70){if(h.tagName!=='H3'){h2=h;h3=null}else h3=h}}const m=document.querySelector('.m-t');m.innerHTML='<div class="l0"></div><div class="l1"></div>';m.querySelector('.l0').textContent=h3?lab(h2):lab(document.querySelector('.content h1'));m.querySelector('.l1').textContent=lab(h3||h2);""",
 "E": lab+r"""const m=document.querySelector('.m-t');m.innerHTML='<div class="l1"></div>';m.querySelector('.l1').textContent=lab(document.querySelector('.content h1'));""",
}
fab='.sidebar-toggle{top:auto !important;left:auto !important;bottom:20px;right:16px;width:48px;height:48px;border-radius:50% !important;justify-content:center;box-shadow:0 2px 10px rgba(0,0,0,.2) !important}'
V={"A":(BASE,JS,None),"B":(BASE+shadow+barcss,JS+';'+mk%'44px',post["B"]),"C":(BASE+shadow+barcss,JS+';'+mk%'52px',post["C"]),"D":(BASE+shadow+fab,JS,None),"E":(BASE+shadow+barcss,JS+';'+mk%'44px',post["E"])}
shots=[]
for k,(css,js,pj) in V.items():
  for sid,t,off in [("top",None,0),("list","4.3Out-of-Scope",330),("tbl","IF-VR-01",180)]:
    sh=dict(name=f"i6-{sid}-{k}",width=390,height=844,dpr=2,css=css,js=js,postjs=pj,clip=dict(x=0,y=0,width=390,height=844))
    if t: sh.update(target=t,offset=off)
    shots.append(sh)
json.dump(dict(COMMON,outDir=os.getcwd()+"/shots",shots=shots),open('i6.json','w'))
E
FONTCONFIG_FILE=$S/fonts-sc.conf node variants.js i6.json 2>&1 | grep -v '^shot'; ls shots | grep -c '^i6-'
```

```bash
S=/tmp/claude-1000/-home-user-hp-workspace-md2doc/cc552bfe-c005-4ece-b528-ad08d7b94e52/scratchpad; cd $S && python3 - <<'E'
import json
d=json.load(open('i6.json'))
keep=[]
for s in d['shots']:
  k=s['name'][-1]
  if k=='B': s['postjs']=s['postjs'].replace("lab(h3||h2)","(lab(h3||h2)||lab(document.querySelector('.content h1')))"); keep.append(s)
  if k=='C': s['postjs']=s['postjs'].replace("m.querySelector('.l1').textContent=lab(h3||h2);","m.querySelector('.l1').textContent=lab(h3||h2);if(!h2&&!h3){m.querySelector('.l0').remove();m.querySelector('.l1').textContent=lab(document.querySelector('.content h1'));}"); keep.append(s)
d['shots']=keep; json.dump(d,open('i6bc.json','w'))
E
FONTCONFIG_FILE=$S/fonts-sc.conf node variants.js i6bc.json 2>&1 | grep -v '^shot'; echo ok
```

```bash
S=/tmp/claude-1000/-home-user-hp-workspace-md2doc/cc552bfe-c005-4ece-b528-ad08d7b94e52/scratchpad; cd $S && python3 -c "
from PIL import Image
for k in ['mkdocs','docusaurus','mdn','ghdocs']:
  Image.open(f'shots/ref6-{k}.png').crop((0,0,780,640)).save(f'shots/ref6-{k}-top.png')
" && cat > i6-item.json <<'E'
{
  "n": 6, "slug": "i6", "short": "手機選單",
  "title": "手機版：選單按鈕與左緣灰邊",
  "intro": [
    "兩個問題：一、左上角的 ☰ 是 <code>position: fixed</code> 浮在內文上，捲動時會直接蓋住文字；二、選單抽屜收起時只是往左移出畫面，但它的陰影 <code>box-shadow: 2px 0 12px</code> 還留著，所以螢幕左緣永遠有一條灰邊（看 A 的左緣）。",
    "第二個是 bug，B–E 都已修正：陰影只在抽屜打開時出現。這一頁要選的是 ☰ 的處理方式。截圖是 390 寬的手機，已套用前面定案的字型、表格、標題與圖表設定。",
    "標題後面的 <code>#</code> 錨點下一頁再討論，這頁先不動。"
  ],
  "options": [
    {"key": "A", "label": "現況：浮動 ☰", "desc": "☰ 固定在左上角浮在內文上，左緣有灰邊。"},
    {"key": "B", "label": "頂列：☰＋目前章節", "rec": true, "desc": "44px 白色頂列固定在最上方，放 ☰ 和目前捲到的章節名稱（H2 或 H3），捲動時會跟著更新。參考：Material for MkDocs 的手機頂列（48px，☰＋標題）。"},
    {"key": "C", "label": "頂列：☰＋兩層章節", "desc": "52px 頂列，上面一行小字是所屬的 H2，下面是目前的 H3，類似麵包屑。參考：MDN、GitHub Docs 的麵包屑列。資訊最多，但佔的高度也最多。"},
    {"key": "D", "label": "右下角圓形按鈕", "desc": "☰ 改成右下角的圓形浮動按鈕，拇指好按、不佔頂部空間，但仍然浮在內文上，會蓋住右下角的字。上方四個參考網站都沒有這樣做。"},
    {"key": "E", "label": "頂列：☰＋文件標題", "desc": "44px 頂列，固定顯示文件標題，不隨捲動變化。參考：Docusaurus 頂列顯示網站名稱。"}
  ],
  "scenes": [
    {"id": "top", "title": "文件開頭", "caption": "注意 A 的左緣灰邊，以及各選項頂列的內容。", "w": 780, "h": 1688, "maxw": 390},
    {"id": "list", "title": "捲到 4.2 Constraints 的清單", "caption": "A 的 ☰ 蓋住清單文字；B、C 的頂列顯示目前所在章節。", "w": 780, "h": 1688, "maxw": 390},
    {"id": "tbl", "title": "捲到 IF-VR-01 介面表", "caption": "D 的圓形按鈕在右下角，可以看出它會蓋到什麼。", "w": 780, "h": 1688, "maxw": 390}
  ],
  "refs_title": "參考：文件網站的手機版選單",
  "refs_intro": "2026-10-01 用 390 寬的手機模擬開啟、往下捲 1400px 後截圖。四個網站都用固定在頂端的橫列放選單按鈕，沒有一個讓按鈕浮在內文上。",
  "refs": [
    {"img": "ref6-mkdocs-top.png", "title": "Material for MkDocs", "caption": "48px 頂列（sticky）：☰＋頁面標題＋搜尋。", "w": 390, "h": 320},
    {"img": "ref6-docusaurus-top.png", "title": "Docusaurus", "caption": "60px 頂列（sticky）：☰＋網站名稱＋搜尋。", "w": 390, "h": 320},
    {"img": "ref6-mdn-top.png", "title": "MDN", "caption": "頂列下方多一行麵包屑（Web › CSS › Reference › …），總高 78px。", "w": 390, "h": 320},
    {"img": "ref6-ghdocs-top.png", "title": "GitHub Docs", "caption": "頂列＋麵包屑＋目前文章標題，三層。", "w": 390, "h": 320}
  ],
  "recommend": "<p><strong>我推薦 B：頂列放 ☰＋目前章節。</strong>理由：一、頂列不再蓋住任何內文，這是四個參考網站一致的做法；二、spec 一份動輒上千行，手機上最容易迷路，頂列顯示目前捲到哪一節，等於把桌面版 sidebar 的麵包屑搬到手機上，而且只佔 44px。C 資訊更多，但多佔 8px，而且上面那行小字在手機上不太好讀。</p>",
  "notes": ["頂列只在 1080px 以下（手機、平板直向）出現；桌面版不變。", "B、C 的章節名稱在實作時要跟著捲動更新，會重用現有 breadcrumb 的計算邏輯，不另外寫一套。"]
}
E
python3 build_item.py i6-item.json >/dev/null && ls review/i6/img | wc -l
```

```bash
S=/tmp/claude-1000/-home-user-hp-workspace-md2doc/cc552bfe-c005-4ece-b528-ad08d7b94e52/scratchpad; cd $S && python3 - <<'E'
import json
d=json.load(open('i6-item.json'))
d['scenes'][2]['title']='捲到 6. Interface Definition'
d['scenes'][2]['caption']='D 的圓形按鈕在右下角，會蓋到右下的文字。B、C 的頂列此時顯示的仍是第 5 節，因為第 6 節的標題還沒捲過頂列。'
json.dump(d,open('i6-item.json','w'),ensure_ascii=False)
E
python3 build_item.py i6-item.json >/dev/null; cd review/i6 && ls img | python3 -c "import sys,json;print(json.dumps([{'path':'img/'+l.split()[0]} for l in sys.stdin if l.strip()]))"
```

```bash
S=/tmp/claude-1000/-home-user-hp-workspace-md2doc/cc552bfe-c005-4ece-b528-ad08d7b94e52/scratchpad; cat > $S/refs6b.js <<'E'
const puppeteer = require('/home/user/hp_workspace/md2doc/node_modules/puppeteer');
const sites = [['mkdocs','https://squidfunk.github.io/mkdocs-material/reference/diagrams/','a.headerlink'],['docusaurus','https://docusaurus.io/docs/markdown-features/diagrams','a.hash-link'],['mdn','https://developer.mozilla.org/en-US/docs/Web/CSS/position','h2 a, h3 a'],['ghdocs','https://docs.github.com/en/get-started/writing-on-github/working-with-advanced-formatting/creating-diagrams','h2 a, h3 a'],['whatwg','https://html.spec.whatwg.org/multipage/dom.html','a.self-link']];
(async () => {
  const b = await puppeteer.launch({ args: ['--no-sandbox'] });
  for (const [id, url, sel] of sites) for (const mob of [true, false]) {
    const p = await b.newPage();
    await p.setViewport(mob ? { width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true } : { width: 1440, height: 900 });
    await p.goto(url, { waitUntil: 'networkidle2', timeout: 60000 }).catch(e => console.log(id, e.message));
    await new Promise(r => setTimeout(r, 2500));
    const r = await p.evaluate(sel => { const a = [...document.querySelectorAll(sel)].find(a => a.closest('h2,h3')); if (!a) return null; const cs = getComputedStyle(a), bcs = getComputedStyle(a, '::before'), acs = getComputedStyle(a, '::after'); a.closest('h2,h3').scrollIntoView({ block: 'center' }); return { text: a.textContent.trim().slice(0, 30), opacity: cs.opacity, visibility: cs.visibility, display: cs.display, before: bcs.content, after: acs.content, headingIsLink: a.textContent.trim().length > 3 }; }, sel);
    console.log(id, mob ? 'mobile' : 'desktop', JSON.stringify(r));
    if (mob) { await new Promise(r => setTimeout(r, 600)); await p.screenshot({ path: `${process.argv[2]}/ref6b-${id}.png` }); }
    await p.close();
  }
  await b.close();
})();
E
cd /home/user/hp_workspace/md2doc && FONTCONFIG_FILE=$S/fonts-sc.conf timeout 400 node $S/refs6b.js $S/shots
```

```bash
S=/tmp/claude-1000/-home-user-hp-workspace-md2doc/cc552bfe-c005-4ece-b528-ad08d7b94e52/scratchpad; cd $S && python3 - <<'E'
import json
d=json.load(open('i6.json'))
b=[s for s in d['shots'] if s['name']=='i6-top-B'][0]
bc=[s for s in json.load(open('i6bc.json'))['shots'] if s['name']=='i6-top-B'][0]
open('decided.py','a').write("\n# item 6 = B: mobile top bar (css includes shadow fix), apply only to mobile shots\nMOB_CSS = %r\nMOB_JS = %r\nMOB_POST = %r\n" % (b['css'].split('.reader-sidebar{box-shadow:none}')[1].join(['.reader-sidebar{box-shadow:none}',''])[0:0] + '.reader-sidebar{box-shadow:none}' + b['css'].split('.reader-sidebar{box-shadow:none}')[1], b['js'].split(';',1)[1] if False else b['js'][len(json.load(open('i6.json'))['shots'][0]['js'])+1:], bc['postjs']))
E
python3 -c "
import sys; sys.path.insert(0,'$S'); import decided as d
print(d.MOB_CSS[:120]); print(d.MOB_JS[:80]); print(d.MOB_POST[-120:])"
```

```bash
S=/tmp/claude-1000/-home-user-hp-workspace-md2doc/cc552bfe-c005-4ece-b528-ad08d7b94e52/scratchpad; cd $S && python3 - <<'E'
import json, os, sys
sys.path.insert(0,'.'); from decided import BASE, COMMON, JS, MOB_CSS, MOB_JS, MOB_POST
sect_js = r"""document.querySelectorAll('.heading-anchor').forEach(a=>a.textContent='§')"""
V={
 "A": ("", ""),
 "B": ("@media (max-width:1080px){.heading-anchor{opacity:0 !important}}", ""),
 "C": (".heading-anchor{display:none !important}", ""),
 "D": ("@media (max-width:1080px){.content h1 .heading-anchor{display:none}}", ""),
 "E": (".heading-with-anchor{position:relative}.heading-anchor{position:absolute;right:100%;margin-right:.35em;margin-left:0 !important;opacity:.45 !important;font-size:.72em;top:50%;transform:translateY(-50%);font-weight:400}", sect_js),
}
shots=[]
for k,(css,js) in V.items():
  jj = JS + (';'+js if js else '')
  shots.append(dict(name=f"i6b-mtop-{k}",width=390,height=844,dpr=2,css=BASE+MOB_CSS+css,js=jj+';'+MOB_JS,postjs=MOB_POST,clip=dict(x=0,y=0,width=390,height=520)))
  shots.append(dict(name=f"i6b-msec-{k}",width=390,height=844,dpr=2,css=BASE+MOB_CSS+css,js=jj+';'+MOB_JS,postjs=MOB_POST,target="4.3Out-of-Scope",offset=380,clip=dict(x=0,y=0,width=390,height=560)))
  shots.append(dict(name=f"i6b-desk-{k}",width=1440,height=900,css=BASE+css,js=jj,target="4.Assumptions",offset=30,clip=dict(x=300,y=0,width=900,height=380)))
json.dump(dict(COMMON,outDir=os.getcwd()+"/shots",shots=shots),open('i6b.json','w'))
E
FONTCONFIG_FILE=$S/fonts-sc.conf node variants.js i6b.json 2>&1 | grep -v '^shot'; ls shots | grep -c '^i6b-'
```

```bash
S=/tmp/claude-1000/-home-user-hp-workspace-md2doc/cc552bfe-c005-4ece-b528-ad08d7b94e52/scratchpad; cd $S && python3 -c "
from PIL import Image
for k,box in [('mkdocs',None),('docusaurus',None),('whatwg',None),('ghdocs',None)]:
  im=Image.open(f'shots/ref6b-{k}.png'); w,h=im.size; im.crop((0,int(h*0.3),w,int(h*0.7))).save(f'shots/ref6b-{k}-c.png'); print(k, im.size)
" && cat > i6b-item.json <<'E'
{
  "n": "6b", "slug": "i6b", "short": "標題錨點",
  "title": "標題後面的 # 錨點",
  "intro": [
    "每個標題後面都有一個 <code>#</code> 連結，用來複製該節的網址。桌面版平常是透明的，滑鼠移上去才出現；但手機沒有滑鼠，所以 md2doc 在 1080px 以下讓它<strong>常駐</strong>，每個標題後面都多一個灰色的 #。文件標題（H1）折成四行時，# 會掛在最後一行尾巴。",
    "截圖已套用前面所有定案，包含第 6 項的手機頂列。"
  ],
  "options": [
    {"key": "A", "label": "現況：手機常駐 #", "desc": "手機上每個標題後面都有 #；桌面版滑鼠移上去才出現。"},
    {"key": "B", "label": "手機也隱藏 #", "rec": true, "desc": "手機上和桌面一樣平常看不到 #。參考：Material for MkDocs（¶）與 Docusaurus（#）在手機上都是透明的，實測 opacity 0。代價是手機上無法點 # 複製章節網址，但 TOC 仍然可以跳到該節。"},
    {"key": "C", "label": "標題本身當連結", "desc": "拿掉 #，改成點標題文字就能取得該節網址。參考：GitHub Docs、MDN。畫面和 B 一樣乾淨，但標題變成可以點的連結，在手機上捲動時容易誤觸跳動。"},
    {"key": "D", "label": "只拿掉 H1 的 #", "desc": "手機上 H1 不顯示 #，H2 以下照舊常駐。這是我上一輪的提案，沒有外部參考。"},
    {"key": "E", "label": "§ 淡色放在標題左側", "desc": "把 # 換成 §，半透明常駐在標題左邊的空白處，桌面、手機都看得到。參考：WHATWG HTML Standard（§，opacity 0.5）。"}
  ],
  "scenes": [
    {"id": "mtop", "title": "手機：文件開頭", "caption": "A 的 # 掛在 H1 最後一行尾巴。", "w": 780, "h": 1040, "maxw": 390},
    {"id": "msec", "title": "手機：4.3 Out-of-Scope", "caption": "一般章節標題。B、C 畫面相同，差別在行為（C 點標題就會跳到該節網址）。", "w": 780, "h": 1120, "maxw": 390},
    {"id": "desk", "title": "桌面：4. / 4.1", "caption": "A、B、C、D 在桌面上都一樣，平常看不到 #；只有 E 會在左側常駐淡色 §。", "w": 900, "h": 380}
  ],
  "refs_title": "參考：文件網站的標題錨點",
  "refs_intro": "2026-10-01 用 390 寬手機模擬開啟，讀取錨點元素的 computed style。",
  "refs": [
    {"img": "ref6b-mkdocs-c.png", "title": "Material for MkDocs", "caption": "錨點是 ¶，手機與桌面都是 opacity 0，滑鼠移上去才出現，手機上等於看不到。", "w": 390, "h": 340},
    {"img": "ref6b-docusaurus-c.png", "title": "Docusaurus", "caption": "錨點是 #（::before），手機與桌面都是 opacity 0。", "w": 390, "h": 340},
    {"img": "ref6b-ghdocs-c.png", "title": "GitHub Docs", "caption": "標題文字本身就是連結，沒有另外的符號。", "w": 390, "h": 340},
    {"img": "ref6b-whatwg-c.png", "title": "WHATWG HTML Standard", "caption": "§ 放在標題左側，opacity 0.5，手機與桌面都常駐。", "w": 390, "h": 340}
  ],
  "recommend": "<p><strong>我推薦 B：手機也隱藏 #。</strong>理由：一、兩個最主流的文件框架（Material for MkDocs、Docusaurus）都這樣做，手機畫面最乾淨，H1 不會多掛一個符號；二、手機上很少有人需要複製章節網址，真的需要時從桌面版複製即可，而 TOC 跳轉不受影響。C 雖然也乾淨，但整個標題變成連結，手機捲動時容易誤觸。</p>",
  "notes": []
}
E
python3 build_item.py i6b-item.json >/dev/null && cd review/i6b && ls img | python3 -c "import sys,json;print(json.dumps([{'path':'img/'+l.split()[0]} for l in sys.stdin if l.strip()]))"
```

```bash
S=/tmp/claude-1000/-home-user-hp-workspace-md2doc/cc552bfe-c005-4ece-b528-ad08d7b94e52/scratchpad; cd $S && python3 - <<'E'
import json
d=json.load(open('i6b.json'))
mob='@media (max-width:1080px){.heading-anchor{position:static !important;transform:none !important;margin-left:.45em !important;margin-right:0 !important;font-size:.75em}}'
d['shots']=[s for s in d['shots'] if s['name'].endswith('-E')]
for s in d['shots']: s['css']+=mob
json.dump(d,open('i6bE.json','w'))
it=json.load(open('i6b-item.json'))
it['options'][4]['label']='淡色 § 常駐'
it['options'][4]['desc']='把 # 換成 §，半透明常駐：桌面版放在標題左邊的空白處，手機版放在標題後面。參考：WHATWG HTML Standard（opacity 0.5，桌面在左、手機在後）。'
it['refs'][3]['caption']='§ 以 opacity 0.5 常駐。這張是手機版，§ 在標題後面；桌面版則放在標題左側（見第 4 項的參考截圖）。'
json.dump(it,open('i6b-item.json','w'),ensure_ascii=False)
E
FONTCONFIG_FILE=$S/fonts-sc.conf node variants.js i6bE.json 2>&1 | grep -v '^shot'; python3 build_item.py i6b-item.json >/dev/null; echo ok
```

```bash
S=/tmp/claude-1000/-home-user-hp-workspace-md2doc/cc552bfe-c005-4ece-b528-ad08d7b94e52/scratchpad; cd $S && cat >> decided.py <<'E'
# item 6b = B: hide heading anchors on mobile too
MOB_CSS = MOB_CSS + '@media (max-width:1080px){.heading-anchor{opacity:0 !important}}'
E
grep -o '<input[^>]*search[^>]*>' /tmp/md2doc/mac_merge_tx_spec-e2407d.html | head -2; grep -o '<div class="reader-tools".\{0,900\}' /tmp/md2doc/mac_merge_tx_spec-e2407d.html | head -c 1500; echo; grep -o '<div class="toc-header".\{0,700\}' /tmp/md2doc/mac_merge_tx_spec-e2407d.html | head -c 900
```

```bash
S=/tmp/claude-1000/-home-user-hp-workspace-md2doc/cc552bfe-c005-4ece-b528-ad08d7b94e52/scratchpad; cat > $S/refs7.js <<'E'
const puppeteer = require('/home/user/hp_workspace/md2doc/node_modules/puppeteer');
const sites = [['mdn','https://developer.mozilla.org/en-US/docs/Web/CSS/position'],['mkdocs','https://squidfunk.github.io/mkdocs-material/reference/diagrams/'],['docusaurus','https://docusaurus.io/docs/markdown-features/diagrams'],['ecma','https://tc39.es/ecma262/multipage/ecmascript-data-types-and-values.html']];
(async () => {
  const b = await puppeteer.launch({ args: ['--no-sandbox'] });
  for (const [id, url] of sites) {
    const p = await b.newPage(); await p.setViewport({ width: 1440, height: 900 });
    await p.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: 'light' }]);
    await p.goto(url, { waitUntil: 'networkidle2', timeout: 60000 }).catch(e => console.log(id, e.message));
    await new Promise(r => setTimeout(r, 2500));
    await p.screenshot({ path: `${process.argv[2]}/ref7-${id}.png` });
    await p.close();
  }
  await b.close();
})();
E
cd /home/user/hp_workspace/md2doc && FONTCONFIG_FILE=$S/fonts-sc.conf timeout 300 node $S/refs7.js $S/shots && python3 - <<E
from PIL import Image
S="$S"
sheet=Image.new('RGB',(4*560,900),'white')
for i,k in enumerate(['mdn','mkdocs','docusaurus','ecma']):
  sheet.paste(Image.open(f"{S}/shots/ref7-{k}.png").convert('RGB').crop((0,0,550,900)),(i*560,0))
sheet.save(f"{S}/sheet7.png")
E
```

```bash
S=/tmp/claude-1000/-home-user-hp-workspace-md2doc/cc552bfe-c005-4ece-b528-ad08d7b94e52/scratchpad; cd $S && python3 - <<'E'
import json, os, sys
sys.path.insert(0,'.'); from decided import BASE, COMMON, JS
search=('.reader-search-label{display:none}.reader-search-row{margin:0}'
        '.reader-search-row input[type="search"]{padding:7px 10px;border-radius:6px;background:#fff}'
        '#doc-search-submit,#doc-search-clear{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);border:0}')
ph=r"""document.getElementById('doc-search-input').placeholder='Search this document';"""
flat='.reader-tools,.search-results,.toc{border:none !important;background:transparent !important;padding:4px 2px !important}.sidebar-splitter::before{background:#e1e4e8 !important;width:1px !important}'
panel=('.reader-sidebar{background:#f6f8fa;border:1px solid #e1e4e8;border-radius:10px;padding:12px 10px 12px 12px !important}'
       '.reader-tools,.search-results,.toc{border:none !important;background:transparent !important;padding:2px 0 !important}')
V={"A":("",""),"B":(search+flat,ph),"C":(search,ph),"D":(search+panel,ph)}
dosearch=r"""(()=>{const i=document.getElementById('doc-search-input');i.value='preempt';document.getElementById('doc-search-submit').click();})()"""
shots=[]
for k,(css,js) in V.items():
  shots.append(dict(name=f"i7-top-{k}",width=1440,height=900,css=BASE+css,js=JS+';'+js,clip=dict(x=0,y=0,width=820,height=700)))
  shots.append(dict(name=f"i7-find-{k}",width=1440,height=900,css=BASE+css,js=JS+';'+js+dosearch,clip=dict(x=0,y=0,width=820,height=900)))
json.dump(dict(COMMON,outDir=os.getcwd()+"/shots",shots=shots),open('i7.json','w'))
E
FONTCONFIG_FILE=$S/fonts-sc.conf node variants.js i7.json 2>&1 | grep -v '^shot'; python3 - <<E
from PIL import Image
S="$S"; sheet=Image.new('RGB',(4*420,900),'white')
for i,k in enumerate("ABCD"): sheet.paste(Image.open(f"{S}/shots/i7-find-{k}.png").convert('RGB').crop((0,0,410,900)),(i*420,0))
sheet.save(f"{S}/peek7.png")
E
```

```bash
S=/tmp/claude-1000/-home-user-hp-workspace-md2doc/cc552bfe-c005-4ece-b528-ad08d7b94e52/scratchpad; cd $S && python3 - <<'E'
import json
d=json.load(open('i7.json'))
fix=('.search-results-header{flex-direction:row !important;align-items:center !important;gap:8px !important}'
     '.search-results-title,.toc-title{text-transform:none !important;letter-spacing:0 !important;font-size:.9rem !important;color:#24292e !important}'
     '.search-results-header .reader-status{flex:1 1 auto}')
d['shots']=[s for s in d['shots'] if s['name'][-1] in 'BCD']
for s in d['shots']: s['css']+=fix
json.dump(d,open('i7b.json','w'))
E
FONTCONFIG_FILE=$S/fonts-sc.conf node variants.js i7b.json 2>&1 | grep -v '^shot'; python3 -c "
from PIL import Image; Image.open('$S/shots/i7-find-B.png').crop((0,0,420,330)).save('$S/peek7b.png')"
```

```bash
S=/tmp/claude-1000/-home-user-hp-workspace-md2doc/cc552bfe-c005-4ece-b528-ad08d7b94e52/scratchpad; cd $S && python3 -c "
from PIL import Image
for k,b in [('mdn',(0,150,520,700)),('mkdocs',(0,150,550,660)),('docusaurus',(0,80,550,700)),('ecma',(0,0,480,560))]:
  Image.open(f'shots/ref7-{k}.png').crop(b).save(f'shots/ref7-{k}-c.png')
" && cat > i7-item.json <<'E'
{
  "n": 7, "slug": "i7", "short": "側欄",
  "title": "側欄：卡片與搜尋列",
  "intro": [
    "現在側欄是兩到三張灰底圓角卡片（搜尋、搜尋結果、目錄），每張都有全大寫加字距的標籤（SEARCH、RESULTS）。搜尋列放了 Search、Clear 兩顆按鈕，把輸入框擠到提示文字被切成「Enter keyword a…」。搜尋時結果區的 ◀ ▶ 各佔一整行，疊成兩條長橫條。",
    "B、C、D 都做了相同的搜尋列修正：拿掉 SEARCH 標籤，輸入框全寬，按 Enter 搜尋、用輸入框內建的 ✕ 清除；Search / Clear 按鈕在畫面上隱藏但保留在 HTML 裡（鍵盤操作與既有測試不受影響）；結果區改成同一行「Results 1/61 ◀ ▶」。三者的差別只在側欄的外框。",
    "截圖已套用前面所有定案。提示文字暫時用英文「Search this document」，和介面其他英文一致。"
  ],
  "options": [
    {"key": "A", "label": "現況：多張卡片", "desc": "搜尋、結果、目錄各自一張灰底卡片。"},
    {"key": "B", "label": "無框", "rec": true, "desc": "拿掉所有卡片的框線與底色，側欄與內文之間用一條細線分隔。參考：MDN、Material for MkDocs、Docusaurus 的側欄都沒有卡片。"},
    {"key": "C", "label": "保留卡片，只修搜尋列", "desc": "外觀和現在一樣是多張卡片，只套用上面的搜尋列修正。改動最小。"},
    {"key": "D", "label": "合成一塊灰色面板", "desc": "整個側欄合成一塊淡灰色圓角面板，內部不再分卡片。參考：ECMA-262 的側欄是一整塊灰色面板。"}
  ],
  "scenes": [
    {"id": "top", "title": "一般閱讀狀態", "caption": "側欄加上內文開頭。", "w": 820, "h": 700},
    {"id": "find", "title": "搜尋「preempt」時", "caption": "搜尋結果、目錄同時出現時，卡片的層層框線最明顯。", "w": 820, "h": 900}
  ],
  "refs_title": "參考：文件網站的桌面版側欄",
  "refs_intro": "2026-10-01 以 1440 寬開啟截圖。",
  "refs": [
    {"img": "ref7-mdn-c.png", "title": "MDN", "caption": "沒有卡片；最上方一個全寬的 Filter 輸入框，目前項目用左側色條加淡底標示。", "w": 520, "h": 550},
    {"img": "ref7-mkdocs-c.png", "title": "Material for MkDocs", "caption": "沒有卡片，純清單。搜尋放在頂端的標題列。", "w": 550, "h": 510},
    {"img": "ref7-docusaurus-c.png", "title": "Docusaurus", "caption": "沒有卡片，側欄右邊一條細線分隔，目前項目淡灰底。", "w": 550, "h": 620},
    {"img": "ref7-ecma-c.png", "title": "ECMA-262", "caption": "整個側欄是一塊灰色面板，搜尋框全寬放在最上方。", "w": 480, "h": 560}
  ],
  "recommend": "<p><strong>我推薦 B：無框。</strong>理由：一、側欄是導覽工具，應該退到背景，內文才是主體；三個主流文件網站都不用卡片，MDN 的「最上方全寬篩選框」和 B 的搜尋列幾乎一樣；二、搜尋時 A、C 會出現三層框線疊在一起（搜尋卡、結果卡、目錄卡），B 把這些雜訊全部拿掉，只剩內容本身。D 也很乾淨，但整塊灰色面板在寬螢幕上會和內文形成明顯的兩個區塊，比 B 重。</p>",
  "notes": ["搜尋結果中的淡藍色醒目框（目前選中的結果）和 TOC 項目的淡藍底，屬於下一項（第 8 項 TOC）的範圍，這頁沒有改。"]
}
E
python3 build_item.py i7-item.json >/dev/null && cd review/i7 && ls img | python3 -c "import sys,json;print(json.dumps([{'path':'img/'+l.split()[0]} for l in sys.stdin if l.strip()]))"
```

```bash
S=/tmp/claude-1000/-home-user-hp-workspace-md2doc/cc552bfe-c005-4ece-b528-ad08d7b94e52/scratchpad; cd $S && sed -i 's/await p.evaluate(s.postjs); await new Promise(r => setTimeout(r, 300));/await p.evaluate(s.postjs); await new Promise(r => setTimeout(r, 1200));/' variants.js && grep -c 'setTimeout(r, 1200)); }' variants.js && python3 sidebar_variants.py && FONTCONFIG_FILE=$S/fonts-sc.conf node variants.js i78.json 2>&1 | grep -v '^shot'; ls shots | grep -c '^i78-'
```

```bash
S=/tmp/claude-1000/-home-user-hp-workspace-md2doc/cc552bfe-c005-4ece-b528-ad08d7b94e52/scratchpad; cd $S && python3 - <<'E'
p='variants.js'; s=open(p).read()
s=s.replace("  const p = await b.newPage();\n  for (const s of cfg.shots) {","  for (const s of cfg.shots) {\n    const ctx = await b.createBrowserContext(); const p = await ctx.newPage();")
s=s.replace("await h.screenshot({ path: `${cfg.outDir}/${s.name}.png` }); console.log('shot', s.name); continue;","await h.screenshot({ path: `${cfg.outDir}/${s.name}.png` }); console.log('shot', s.name); await ctx.close(); continue;")
s=s.replace("    console.log('shot', s.name);\n  }","    console.log('shot', s.name);\n    await ctx.close();\n  }")
open(p,'w').write(s)
E
grep -n 'createBrowserContext\|ctx.close' variants.js; FONTCONFIG_FILE=$S/fonts-sc.conf node variants.js i78.json 2>&1 | grep -v '^shot'; python3 - <<E
from PIL import Image
S="$S"
for sc in ['read','find']:
  sheet=Image.new('RGB',(4*430,900),'white')
  for i,k in enumerate("ABCD"): sheet.paste(Image.open(f"{S}/shots/i78-{sc}-{k}.png").convert('RGB').resize((420,900)),(i*430,0))
  sheet.save(f"{S}/peek78-{sc}.png")
E
```

```bash
S=/tmp/claude-1000/-home-user-hp-workspace-md2doc/cc552bfe-c005-4ece-b528-ad08d7b94e52/scratchpad; cd $S && python3 - <<'E'
p='sidebar_variants.py'; s=open(p).read()
s=s.replace("""  'expand': '<path d="m7 15 5 5 5-5"/><path d="m7 9 5-5 5 5"/>',
  'collapse': '<path d="m7 20 5-5 5 5"/><path d="m7 4 5 5 5-5"/>',""",
"""  'expand': '<path d="M12 22v-6"/><path d="M12 8V2"/><path d="M4 12H2"/><path d="M10 12H8"/><path d="M16 12h-2"/><path d="M22 12h-2"/><path d="m15 19-3 3-3-3"/><path d="m15 5-3-3-3 3"/>',
  'collapse': '<path d="M12 22v-6"/><path d="M12 8V2"/><path d="M4 12H2"/><path d="M10 12H8"/><path d="M16 12h-2"/><path d="M22 12h-2"/><path d="m15 19-3-3-3 3"/><path d="m15 5-3 3-3-3"/>',""")
open(p,'w').write(s)
E
python3 sidebar_variants.py >/dev/null && python3 -c "
import json; d=json.load(open('i78.json')); d['shots']=[s for s in d['shots'] if s['name'][-1] in 'BD']; json.dump(d,open('i78bd.json','w'))" && FONTCONFIG_FILE=$S/fonts-sc.conf node variants.js i78bd.json 2>&1 | grep -v '^shot'; python3 - <<E
from PIL import Image
S="$S"
a=Image.open(f"{S}/shots/i78-read-B.png").crop((0,160,840,240))
sheet=Image.new('RGB',(4*400+840,900),'white'); sheet.paste(a,(0,0))
for i,k in enumerate("ABCD"):
  sheet.paste(Image.open(f"{S}/shots/i78-hide-{k}.png").convert('RGB').crop((0,0,400,500)),(i*400,100))
for i,k in enumerate("BD"):
  sheet.paste(Image.open(f"{S}/shots/i78-mob-{k}.png").convert('RGB').resize((390,844)).crop((0,0,390,560)),(1600+i*420,100))
sheet.save(f"{S}/peek78-misc.png")
E
```

```bash
S=/tmp/claude-1000/-home-user-hp-workspace-md2doc/cc552bfe-c005-4ece-b528-ad08d7b94e52/scratchpad; cd $S && python3 - <<'E'
p='sidebar_variants.py'; s=open(p).read()
s=s.replace("""  '.toc a.is-match{background:#fff5c2 !important;color:inherit !important}'
)""","""  '.toc a.is-match{background:#fff5c2 !important;color:inherit !important}'
  'body[data-toc-collapsed] #toc-expand-all,body[data-toc-collapsed] #toc-collapse-all,body[data-toc-collapsed] .md2doc-toc-label{display:none !important}'
  'body[data-toc-collapsed] .toc-header{border-bottom:none !important}'
)""",1)
open(p,'w').write(s)
E
cat >> decided.py <<'E'
# item 6 detail: the drawer opens below the 44px top bar so the bar never covers it and the menu button stays reachable
MOB_CSS = MOB_CSS + '@media (max-width:1080px){.reader-sidebar{top:44px !important;height:calc(100vh - 44px) !important}}'
E
python3 sidebar_variants.py >/dev/null && FONTCONFIG_FILE=$S/fonts-sc.conf node variants.js i78.json 2>&1 | grep -v '^shot'; python3 - <<E
from PIL import Image
S="$S"
sheet=Image.new('RGB',(4*400+4*400,900),'white')
for i,k in enumerate("ABCD"):
  sheet.paste(Image.open(f"{S}/shots/i78-hide-{k}.png").convert('RGB').crop((0,0,390,900)),(i*400,0))
  sheet.paste(Image.open(f"{S}/shots/i78-mob-{k}.png").convert('RGB').resize((390,844)),(1600+i*400,0))
sheet.save(f"{S}/peek78-misc.png")
E
```

```bash
S=/tmp/claude-1000/-home-user-hp-workspace-md2doc/cc552bfe-c005-4ece-b528-ad08d7b94e52/scratchpad; cd $S && python3 - <<'E'
p='sidebar_variants.py'; s=open(p).read()
s=s.replace("""  'body[data-toc-collapsed] .toc-header{border-bottom:none !important}'""","""  'body[data-toc-collapsed] .toc-header{border-bottom:none !important}'
  '@media (max-width:1080px){#toc-collapse-toggle{display:none !important}}'""",1)
open(p,'w').write(s)
E
python3 sidebar_variants.py >/dev/null && python3 -c "
import json; d=json.load(open('i78.json')); d['shots']=[s for s in d['shots'] if s['name'].startswith('i78-mob')]; json.dump(d,open('i78m.json','w'))" && FONTCONFIG_FILE=$S/fonts-sc.conf node variants.js i78m.json 2>&1 | grep -v '^shot'; echo ok
```

```bash
S=/tmp/claude-1000/-home-user-hp-workspace-md2doc/cc552bfe-c005-4ece-b528-ad08d7b94e52/scratchpad; cd $S && python3 - <<'E'
p='build_item.py'; s=open(p).read()
if '.cmp' not in s:
  s=s.replace(".recbox {{", ".cmp {{ border-collapse: collapse; width: 100%; font-size: .86rem; margin: 6px 0 14px; background: var(--surface); }}\n.cmp th, .cmp td {{ border-bottom: 1px solid var(--rule); padding: 6px 8px; text-align: left; vertical-align: top; }}\n.cmp th {{ font-weight: 600; white-space: nowrap; }}\n.cmpwrap {{ overflow-x: auto; }}\n.recbox {{",1)
  s=s.replace('<header class="col">','<header>',1)
  s=s.replace("intro_html = \"\".join(f\"<p>{p}</p>\" for p in item[\"intro\"])","intro_html = \"\".join(p if p.startswith('<div') else f'<p class=\"col\">{p}</p>' for p in item[\"intro\"])")
open(p,'w').write(s)
E
grep -c 'cmpwrap' build_item.py; cp shots/ref7-*-c.png shots/ 2>/dev/null; cat > i78-item.json <<'E'
{
  "n": "7+8", "slug": "i78", "short": "側欄整體",
  "title": "側欄整體設計：搜尋、按鈕、麵包屑、TOC",
  "intro": [
    "依你的要求，把原本的第 7 項（卡片、搜尋列）和第 8 項（TOC）合併，當成一整套來設計。B、C、D 各自對應一個參考網站的整體做法，每個元件都一起變動，不是零件拼湊。",
    "三個方向共同修正的問題：一、整棵 TOC 原本都掛在文件標題（H1）底下，每個項目白白多縮排一層，現在改成從第一層章節開始；二、搜尋列拿掉 SEARCH 標籤、輸入框全寬、按 Enter 搜尋，Search 與 Clear 按鈕從畫面上隱藏但保留在 HTML 裡；三、搜尋結果的 ◀ ▶ 不再各自疊成一整條；四、顏色分工統一，<strong>藍色＝目前位置、黃色＝搜尋命中</strong>（和內文裡的搜尋標記同色）。現況的 TOC 用同一種淡藍同時標示兩者，搜尋時分不出來。",
    "<div class=\"cmpwrap\"><table class=\"cmp\"><thead><tr><th>元件</th><th>A 現況</th><th>B 安靜清單（MDN）</th><th>C 圓角列（Docusaurus）</th><th>D 單一面板（ECMA-262）</th></tr></thead><tbody><tr><th>外框</th><td>三張灰底卡片</td><td>無框，側欄右邊一條細線</td><td>無框，側欄右邊一條細線</td><td>整條側欄一塊淡灰面板</td></tr><tr><th>目錄按鈕</th><td>⊞ ⊟ ◀ 加框符號</td><td>無框線圖示，放在麵包屑右側</td><td>文字連結「Expand all / Collapse all」</td><td>無框線圖示，放在「Contents」標題右側</td></tr><tr><th>隱藏側欄</th><td>◀ 和展開、收合按鈕擠在一起</td><td>面板圖示，和目錄按鈕同一排</td><td>移到側欄最底部，整條「«」</td><td>面板圖示，和目錄按鈕同一排</td></tr><tr><th>目前位置</th><td>三行麵包屑＋TOC 粗體藍字</td><td>一行麵包屑「6. … › IF-VR-01 …」＋左側藍色條</td><td>拿掉麵包屑；目前項目淡灰圓角底＋藍色粗體</td><td>拿掉麵包屑；整條路徑（6. → IF-VR-01）加粗，目前項目藍底</td></tr><tr><th>長標題</th><td>硬切在字中間</td><td>單行，右緣漸隱</td><td>自動換行，完整顯示</td><td>單行，右緣漸隱</td></tr><tr><th>展開箭頭</th><td>左側 ▸，和無子項目錯位 6px</td><td>左側 ▸，對齊修正</td><td>右側 ›</td><td>左側 ▸，對齊修正</td></tr><tr><th>搜尋結果</th><td>灰底卡片，◀ ▶ 疊成兩條</td><td>平面清單，選中項目左側藍色條</td><td>圓角列，選中項目淡灰底</td><td>白色小卡，選中項目藍底</td></tr></tbody></table></div>",
    "截圖已套用前面所有定案（字型、表格、標題、圖表配色、手機頂列）。手機抽屜也改成從頂列下方打開，不會再被頂列蓋住。"
  ],
  "options": [
    {"key": "A", "label": "現況", "desc": "三張卡片、全大寫標籤、加框符號按鈕、三行麵包屑、TOC 單行硬切。"},
    {"key": "B", "label": "安靜清單（MDN）", "rec": true, "desc": "無框、一行麵包屑、無框線圖示、左側藍色條標示目前位置、長標題右緣漸隱。保留既有「單行＋橫向偷看」的設計（有測試守著）。"},
    {"key": "C", "label": "圓角列（Docusaurus）", "desc": "無框、文字按鈕、長標題換行完整顯示、展開箭頭在右側、隱藏側欄按鈕在底部。拿掉麵包屑。長標題換行會推翻既有的單行設計，<code>reader-panels.test.js:51–52</code> 要改。"},
    {"key": "D", "label": "單一面板（ECMA-262）", "desc": "一塊灰色面板、「Contents」標題列、整條路徑加粗取代麵包屑、長標題右緣漸隱。"}
  ],
  "scenes": [
    {"id": "read", "title": "閱讀中：捲到 IF-VR-01", "caption": "側欄放大（2 倍解析度）。看目前位置怎麼標示、長標題怎麼處理。", "w": 840, "h": 1800, "maxw": 420},
    {"id": "page", "title": "整頁：側欄與內文的關係", "caption": "1440 寬整頁，看側欄在整個版面裡的份量。", "w": 1440, "h": 900},
    {"id": "find", "title": "搜尋「preempt」", "caption": "結果清單、TOC 命中標示、目前位置同時出現。", "w": 840, "h": 1800, "maxw": 420},
    {"id": "hide", "title": "隱藏側欄後", "caption": "收成細條時剩下什麼。C 的「»」在細條最底部。", "w": 900, "h": 900},
    {"id": "mob", "title": "手機：打開抽屜", "caption": "390 寬，抽屜從頂列下方打開。", "w": 780, "h": 1688, "maxw": 390}
  ],
  "refs_title": "參考：文件網站的桌面版側欄",
  "refs_intro": "2026-10-01 以 1440 寬開啟截圖。",
  "refs": [
    {"img": "ref7-mdn-c.png", "title": "MDN（B 的參考）", "caption": "沒有卡片；最上方全寬的 Filter 輸入框；目前項目用左側色條加淡底標示。", "w": 520, "h": 550},
    {"img": "ref7-docusaurus-c.png", "title": "Docusaurus（C 的參考）", "caption": "沒有卡片；長標題換行（Headings and Table of contents）；展開箭頭在右側；隱藏側欄的 « 在底部。", "w": 550, "h": 620},
    {"img": "ref7-ecma-c.png", "title": "ECMA-262（D 的參考）", "caption": "一整塊灰色面板；搜尋框全寬；Table of Contents 標題列；整條目前路徑（6 → 6.1 → 6.1.1）都加底色。", "w": 480, "h": 560},
    {"img": "ref7-mkdocs-c.png", "title": "Material for MkDocs", "caption": "沒有卡片，純清單，搜尋在頂端標題列。", "w": 550, "h": 510}
  ],
  "recommend": "<p><strong>我推薦 B：安靜清單（MDN）。</strong>理由：一、spec 的 TOC 很深（到 H4），B 保留一行麵包屑，TOC 捲到哪裡都知道自己在第幾章，C、D 拿掉麵包屑後，一旦目前項目捲出 TOC 可視範圍就失去位置資訊；二、B 保留既有的單行加橫向偷看設計，不用推翻有測試守著的決定，而右緣漸隱補上了原本「不知道後面還有字」的缺點；三、無框加上細線，側欄份量最輕，看場景 2 最明顯。</p><p>如果你比較重視長標題一眼看完整（IF-TX-04 這類很長的介面名稱），C 是次佳選擇，代價是 TOC 會變長，而且要改一條既有測試。</p>",
  "notes": ["按鈕圖示用的是 Lucide 圖示庫（ISC 授權）的 fold / unfold / panel-left 形狀，實作時會以內嵌 SVG 放進 md2doc，不會多一個外部依賴。", "搜尋框的提示文字暫時用英文「Search this document」，和介面其他英文一致；若要改中文可以一起改。"]
}
E
python3 build_item.py i78-item.json >/dev/null && cd review/i78 && ls img | python3 -c "import sys,json;print(json.dumps([{'path':'img/'+l.split()[0]} for l in sys.stdin if l.strip()]))"
```

```bash
S=/tmp/claude-1000/-home-user-hp-workspace-md2doc/cc552bfe-c005-4ece-b528-ad08d7b94e52/scratchpad; cd $S && python3 - <<'E'
import json
d=json.load(open('i78-item.json'))
for o in d['options']:
  o['rec'] = (o['key']=='D')
d['recommend']=("<p><strong>我推薦 D：單一面板（ECMA-262）。</strong>理由：一、md2doc 捲動時會自動把 TOC 捲到目前項目（<code>syncActiveHeading</code> 呼叫 <code>ensureTocLinkVisible</code>，<code>lib/md2doc.js:3889</code>），所以目前位置在 TOC 裡永遠看得到；D 把「6. Interface Definition → IF-VR-01」整條路徑直接在樹上加粗，位置資訊只顯示一次。B 的麵包屑和 TOC 裡的藍色目前項目則是同一件事講兩次，佔掉一行空間。"
 "二、D 和 B 一樣保留既有的單行設計（有測試守著），右緣漸隱補上「後面還有字」的提示，不用改測試。C 的換行雖然能完整顯示長標題，但要推翻這個既有決定，TOC 也會變長。</p>"
 "<p>D 的代價是灰色面板比 B 的無框重一點（看場景 2）。如果你喜歡 D 的路徑加粗、但想要 B 的無框，也可以組合成「B 的外框＋D 的 TOC」，選 Other 告訴我。</p>"
 "<p class=\"hint\">這一版推薦從 B 改成 D：原本以「拿掉麵包屑，目前項目可能捲出可視範圍」為理由推 B，查程式碼後發現 TOC 會自動捲到目前項目，這個理由不成立。</p>")
json.dump(d,open('i78-item.json','w'),ensure_ascii=False)
E
python3 build_item.py i78-item.json >/dev/null; echo ok
```

```bash
S=/tmp/claude-1000/-home-user-hp-workspace-md2doc/cc552bfe-c005-4ece-b528-ad08d7b94e52/scratchpad; cd $S && python3 - <<'E'
import sidebar_variants as sv
open('decided.py','a').write("\n# item 7+8 = D: ECMA-262-style single panel sidebar\nSIDEBAR_CSS = %r\nSIDEBAR_JS = %r\nBASE = BASE + SIDEBAR_CSS\nJS = JS + ';' + SIDEBAR_JS\n" % (sv.D_CSS, sv.D_JS))
E
python3 -c "import sys;sys.path.insert(0,'$S');import decided as d;print(len(d.BASE),len(d.JS))"
cat > $S/refs9.js <<'E'
const puppeteer = require('/home/user/hp_workspace/md2doc/node_modules/puppeteer');
const sites = [['mdn','https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Elements/input'],['docusaurus','https://docusaurus.io/docs/api/docusaurus-config'],['mkdocs','https://squidfunk.github.io/mkdocs-material/setup/changing-the-colors/'],['whatwg','https://html.spec.whatwg.org/multipage/input.html'],['ghdocs','https://docs.github.com/en/actions/reference/workflows-and-actions/contexts']];
(async () => {
  const b = await puppeteer.launch({ args: ['--no-sandbox'] });
  for (const [id, url] of sites) {
    const ctx = await b.createBrowserContext(); const p = await ctx.newPage(); await p.setViewport({ width: 1440, height: 900 });
    await p.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: 'light' }]);
    await p.goto(url, { waitUntil: 'networkidle2', timeout: 60000 }).catch(e => console.log(id, e.message));
    await new Promise(r => setTimeout(r, 2500));
    const r = await p.evaluate(() => {
      const st = c => { const s = getComputedStyle(c); return { bg: s.backgroundColor, color: s.color, border: s.borderTopWidth + ' ' + s.borderTopStyle + ' ' + s.borderTopColor, pad: s.padding, fs: s.fontSize, ff: s.fontFamily.slice(0, 40) }; };
      const inTd = [...document.querySelectorAll('td code')].find(c => !c.closest('pre'));
      const inP = [...document.querySelectorAll('p code')].find(c => !c.closest('pre'));
      if (inTd) inTd.closest('table').scrollIntoView({ block: 'center' });
      return { td: inTd && st(inTd), p: inP && st(inP) };
    });
    console.log(id, JSON.stringify(r));
    await new Promise(r => setTimeout(r, 600));
    await p.screenshot({ path: `${process.argv[2]}/ref9-${id}.png` });
    await ctx.close();
  }
  await b.close();
})();
E
cd /home/user/hp_workspace/md2doc && FONTCONFIG_FILE=$S/fonts-sc.conf timeout 400 node $S/refs9.js $S/shots
```

```bash
S=/tmp/claude-1000/-home-user-hp-workspace-md2doc/cc552bfe-c005-4ece-b528-ad08d7b94e52/scratchpad; cd $S && python3 - <<'E'
import json, os, sys
sys.path.insert(0,'.'); from decided import BASE, COMMON, JS
nobg = lambda sel: f'{sel}{{background:none !important;padding:0 !important;border:none !important}}'
V={
 "A": "",
 "B": nobg('.content td code,.content th code'),
 "C": nobg('.content :not(pre) > code') + '.content :not(pre) > code{color:#b93a0c}',
 "D": '.content :not(pre) > code{background:#f6f8fa !important;border:1px solid #d8dee4;border-radius:4px;padding:1px 4px !important}',
 "E": nobg('.content :not(pre) > code') + '.content :not(pre) > code{color:#0b6b73}',
 "F": nobg('.content :not(pre) > code') + '.content :not(pre) > code{color:#6f42c1}',
}
shots=[]
for k,css in V.items():
  for sid,t,off in [("if","eMAC slave channel signals",20),("para","3.4.2AD-MMTX-002",30),("csr","8.3Safety",120)]:
    shots.append(dict(name=f"i9-{sid}-{k}",width=1440,height=900,css=BASE+css,js=JS,target=t,offset=off,clip=dict(x=340,y=0,width=1100,height=640)))
json.dump(dict(COMMON,outDir=os.getcwd()+"/shots",shots=shots),open('i9.json','w'))
E
FONTCONFIG_FILE=$S/fonts-sc.conf node variants.js i9.json 2>&1 | grep -v '^shot'; python3 - <<E
from PIL import Image
S="$S"; sheet=Image.new('RGB',(3*560,2*330),'white')
for i,k in enumerate("ABCDEF"): sheet.paste(Image.open(f"{S}/shots/i9-if-{k}.png").convert('RGB').crop((0,0,550,320)),((i%3)*560,(i//3)*330))
sheet.save(f"{S}/peek9.png")
E
```

```bash
S=/tmp/claude-1000/-home-user-hp-workspace-md2doc/cc552bfe-c005-4ece-b528-ad08d7b94e52/scratchpad; cd $S && python3 - <<'E'
from PIL import Image
for k in ['mdn','docusaurus','whatwg','ghdocs']:
  im=Image.open(f'shots/ref9-{k}.png'); im.crop((0,200,1440,700)).save(f'shots/ref9-{k}-c.png')
E
cat > i9-item.json <<'E'
{
  "n": 9, "slug": "i9", "short": "訊號名樣式",
  "title": "訊號名（行內 code）的樣式",
  "intro": [
    "spec 裡的訊號名、參數、暫存器欄位都是行內 code（<code>`emac_tx_tdata`</code>），現在每一個都是灰底小方塊。介面表的前幾欄每格都是灰底，一整頁下來是一大片灰塊。",
    "參考網站實測：<strong>MDN、Docusaurus、GitHub Docs 的表格裡 code 也有灰底</strong>，和現況相同，Docusaurus 另外加一圈淡框線；<strong>WHATWG 則完全不用底色，改用橘紅色等寬字</strong>。依你偏好上色的方向，另外給了三種顏色。",
    "截圖已套用前面所有定案，包含 D 單一面板側欄（本頁截圖只裁內文區）。"
  ],
  "options": [
    {"key": "A", "label": "現況：灰底", "desc": "所有 code 灰底。參考：MDN、GitHub Docs。"},
    {"key": "B", "label": "只拿掉表格內灰底", "desc": "表格裡不要灰底，段落裡保留。我自己的提案，沒有外部參考（MDN、GitHub Docs 在表格裡都保留灰底）。"},
    {"key": "C", "label": "無底＋橘紅字", "rec": true, "desc": "全部 code 不要底色，改成橘紅色 <code>#b93a0c</code> 等寬字。參考：WHATWG HTML Standard（實測 <code>rgb(206,60,5)</code>，這裡稍微壓暗以提高對比）。"},
    {"key": "D", "label": "灰底＋淡框線", "desc": "保留灰底，再加一圈淡框線，每個 code 的邊界更清楚。參考：Docusaurus。"},
    {"key": "E", "label": "無底＋青綠字", "desc": "同 C，顏色改成青綠 <code>#0b6b73</code>。我配的色，沒有外部參考。"},
    {"key": "F", "label": "無底＋紫字", "desc": "同 C，顏色改成紫色 <code>#6f42c1</code>。我配的色，沒有外部參考。"}
  ],
  "scenes": [
    {"id": "if", "title": "介面表：eMAC slave channel signals", "caption": "訊號名、參數、時脈都是 code，灰底最密的地方。", "w": 1100, "h": 640},
    {"id": "para", "title": "段落：3.4.2 Decision", "caption": "段落裡夾著大量訊號名。", "w": 1100, "h": 640},
    {"id": "csr", "title": "暫存器表：8.3 Safety 相關 CSR 欄位", "caption": "暫存器名、欄位名、bit 位置。", "w": 1100, "h": 640}
  ],
  "refs_title": "參考：文件網站的行內 code",
  "refs_intro": "2026-10-01 以 1440 寬開啟，讀取表格內與段落內 code 的 computed style。",
  "refs": [
    {"img": "ref9-mdn-c.png", "title": "MDN", "caption": "灰底 <code>rgb(237,238,240)</code>，表格內外相同（表格裡是連結所以藍字）。", "w": 1440, "h": 500},
    {"img": "ref9-docusaurus-c.png", "title": "Docusaurus", "caption": "灰底 <code>rgb(246,247,248)</code>＋1px 淡框線，表格內外相同。", "w": 1440, "h": 500},
    {"img": "ref9-ghdocs-c.png", "title": "GitHub Docs", "caption": "半透明灰底，表格內外相同。", "w": 1440, "h": 500},
    {"img": "ref9-whatwg-c.png", "title": "WHATWG HTML Standard", "caption": "沒有底色；code 是橘紅色 <code>rgb(206,60,5)</code> 的等寬字。", "w": 1440, "h": 500}
  ],
  "recommend": "<p><strong>我推薦 C：無底＋橘紅字。</strong>理由：一、你偏好有顏色的樣式，而 C 有 WHATWG 這個實際參考，不是我憑空配的；橘色和前面定案的文件藍（連結、圖表、TOC 目前位置）是互補色，訊號名一眼就和連結分得開，E 的青綠和 F 的紫都太接近藍色系；二、拿掉灰底後，介面表不再是一片灰塊，訊號名靠顏色辨識，版面反而更乾淨。</p><p>如果你覺得整份文件滿是橘色太吵，A 是主流網站最常見的做法，也可以維持現況。</p>",
  "notes": ["另外觀察到 code 的字級偏小（0.875em 的 Consolas 約 13px，比內文 15px 小不少），這一項沒有一起調整，選完顏色後可以再看要不要放大到 0.92em 左右。"]
}
E
python3 build_item.py i9-item.json >/dev/null && cd review/i9 && ls img | python3 -c "import sys,json;print(json.dumps([{'path':'img/'+l.split()[0]} for l in sys.stdin if l.strip()]))"
```

```bash
S=/tmp/claude-1000/-home-user-hp-workspace-md2doc/cc552bfe-c005-4ece-b528-ad08d7b94e52/scratchpad; cd $S && python3 - <<'E'
import json
d=json.load(open('i9-item.json'))
d['refs'][3]['caption']='沒有底色。表格裡的 code 是粗體橘紅 <code>rgb(206,60,5)</code>；段落裡的 code 則是灰色 <code>rgb(102,102,102)</code>。'
d['options'][2]['desc']='全部 code 不要底色，改成橘紅色 <code>#b93a0c</code> 等寬字。參考：WHATWG HTML Standard 表格裡的 code（實測 <code>rgb(206,60,5)</code>，這裡稍微壓暗以提高對比）；WHATWG 段落裡的 code 是灰色，C 則段落也上色。'
d['intro'][1]=d['intro'][1].replace('<strong>WHATWG 則完全不用底色，改用橘紅色等寬字</strong>','<strong>WHATWG 則完全不用底色</strong>，表格裡用粗體橘紅字、段落裡用灰字')
json.dump(d,open('i9-item.json','w'),ensure_ascii=False)
E
python3 build_item.py i9-item.json >/dev/null; echo ok
```

```bash
S=/tmp/claude-1000/-home-user-hp-workspace-md2doc/cc552bfe-c005-4ece-b528-ad08d7b94e52/scratchpad; cd $S && cat >> decided.py <<'E'
# item 9 = C: inline code without background, orange-red text (WHATWG)
CODE_CSS = '.content :not(pre) > code{background:none !important;padding:0 !important;border:none !important;color:#b93a0c}'
BASE = BASE + CODE_CSS
E
python3 - <<'E'
import json, os, sys
sys.path.insert(0,'.'); from decided import BASE, COMMON, JS
V={"A":"", "B":".content :not(pre) > code{font-size:.92em !important}", "C":".content :not(pre) > code{font-size:1em !important}"}
shots=[]
for k,css in V.items():
  for sid,t,off in [("if","eMAC slave channel signals",20),("para","3.4.2AD-MMTX-002",30)]:
    shots.append(dict(name=f"i9b-{sid}-{k}",width=1440,height=900,dpr=2,css=BASE+css,js=JS,target=t,offset=off,clip=dict(x=340,y=0,width=1100,height=520)))
json.dump(dict(COMMON,outDir=os.getcwd()+"/shots",shots=shots),open('i9b.json','w'))
it={"n":"9b","slug":"i9b","short":"code 字級","title":"訊號名（行內 code）的字級",
 "intro":["現在行內 code 是 0.875em，15px 內文下約 13px。Consolas 的字母本身又比 Segoe UI 小一號（x-height 較低），所以訊號名看起來比旁邊的文字小一截。截圖已套用第 9 項的橘紅字，2 倍解析度。",
  "參考網站的 code 字級 ÷ 內文字級（2026-10-01 實測）：GitHub Docs 0.85、Material for MkDocs 0.85、Docusaurus 0.90、MDN 1.0、WHATWG 1.0。"],
 "options":[{"key":"A","label":"現況 0.875em","desc":"約 13.1px。參考：GitHub Docs、MkDocs（0.85）。"},
  {"key":"B","label":"0.92em","rec":True,"desc":"約 13.8px。參考：Docusaurus（0.90）。"},
  {"key":"C","label":"1em","desc":"和內文同為 15px。參考：MDN、WHATWG。等寬字比較寬，表格欄位會變寬一些。"}],
 "scenes":[{"id":"if","title":"介面表","caption":"訊號名欄位的寬度也會跟著字級變。","w":2200,"h":1040},
  {"id":"para","title":"段落：3.4.2 Decision","caption":"段落裡 code 和旁邊文字的大小落差。","w":2200,"h":1040}],
 "recommend":"<p><strong>我推薦 B：0.92em。</strong>理由：一、Consolas 本身字面偏小，0.92em 看起來才和 Segoe UI 內文差不多大，訊號名在段落裡不再「縮一號」；二、C 的 1em 讓介面表的訊號名欄位明顯變寬，表格較寬時更容易出現橫向捲動，B 取中間值，只比現在寬一點點。</p>","notes":[]}
json.dump(it,open('i9b-item.json','w'),ensure_ascii=False)
E
FONTCONFIG_FILE=$S/fonts-sc.conf node variants.js i9b.json 2>&1 | grep -v '^shot'; python3 build_item.py i9b-item.json >/dev/null && cd review/i9b && ls img | python3 -c "import sys,json;print(json.dumps([{'path':'img/'+l.split()[0]} for l in sys.stdin if l.strip()]))"
```

```bash
S=/tmp/claude-1000/-home-user-hp-workspace-md2doc/cc552bfe-c005-4ece-b528-ad08d7b94e52/scratchpad; cd $S && cat >> decided.py <<'E'
# item 9b = B: inline code 0.92em
BASE = BASE + '.content :not(pre) > code{font-size:.92em !important}'
E
cat > refs10.js <<'E'
const puppeteer = require('/home/user/hp_workspace/md2doc/node_modules/puppeteer');
const sites = [['ghdocs','https://docs.github.com/en/get-started/writing-on-github/working-with-advanced-formatting/creating-diagrams',6],['mdn','https://developer.mozilla.org/en-US/docs/Web/CSS/position',8],['govuk','https://www.gov.uk/browse/driving',6],['docusaurus','https://docusaurus.io/docs/markdown-features/diagrams',6]];
(async () => {
  const b = await puppeteer.launch({ args: ['--no-sandbox'] });
  for (const [id, url, n] of sites) {
    const ctx = await b.createBrowserContext(); const p = await ctx.newPage(); await p.setViewport({ width: 1440, height: 900 });
    await p.goto(url, { waitUntil: 'networkidle2', timeout: 60000 }).catch(e => console.log(id, e.message));
    await new Promise(r => setTimeout(r, 2000));
    for (let i = 0; i < n; i++) { await p.keyboard.press('Tab'); await new Promise(r => setTimeout(r, 120)); }
    const r = await p.evaluate(() => { const e = document.activeElement; const s = getComputedStyle(e); const rc = e.getBoundingClientRect(); return { tag: e.tagName, text: (e.innerText || e.value || '').slice(0, 30), outline: s.outlineWidth + ' ' + s.outlineStyle + ' ' + s.outlineColor, offset: s.outlineOffset, shadow: s.boxShadow.slice(0, 80), bg: s.backgroundColor, rect: [rc.x, rc.y, rc.width, rc.height].map(Math.round) }; });
    console.log(id, JSON.stringify(r));
    const [x, y, w, h] = r.rect; const cx = Math.max(0, x - 60), cy = Math.max(0, y - 40);
    await p.screenshot({ path: `${process.argv[2]}/ref10-${id}.png`, clip: { x: cx, y: cy, width: Math.min(1440 - cx, w + 120), height: Math.min(900 - cy, h + 80) } });
    await ctx.close();
  }
  await b.close();
})();
E
cd /home/user/hp_workspace/md2doc && FONTCONFIG_FILE=$S/fonts-sc.conf timeout 300 node $S/refs10.js $S/shots
```

```bash
S=/tmp/claude-1000/-home-user-hp-workspace-md2doc/cc552bfe-c005-4ece-b528-ad08d7b94e52/scratchpad; cd $S && python3 - <<'E'
p='variants.js'; s=open(p).read()
if 'tabFrom' not in s:
  s=s.replace("    if (s.el) {","""    if (s.focus) { await p.evaluate(sel => document.querySelector(sel).focus(), s.focus); await new Promise(r => setTimeout(r, 300)); }
    if (s.tabFrom) { await p.evaluate(sel => document.querySelector(sel).focus(), s.tabFrom); await p.keyboard.press('Tab'); await new Promise(r => setTimeout(r, 400)); }
    if (s.el) {""",1)
open(p,'w').write(s)
import json, os, sys
sys.path.insert(0,'.'); from decided import BASE, COMMON, JS
import sidebar_variants as sv
tabfix=r"""['doc-search-submit','doc-search-clear'].forEach(id=>document.getElementById(id).tabIndex=-1)"""
ring='.reader-sidebar :is(a,button,input):focus-visible,.content a:focus-visible{outline:2px solid #0969da !important;outline-offset:2px;border-radius:4px}.toc a:focus-visible{outline-offset:-2px !important}'
gov='.reader-sidebar :is(a,button):focus-visible,.content a:focus-visible{outline:3px solid transparent !important;background:#ffdd00 !important;color:#0b0c0c !important;box-shadow:0 -2px #ffdd00,0 4px #0b0c0c !important;text-decoration:none}.reader-sidebar input:focus-visible{outline:3px solid #ffdd00 !important;box-shadow:inset 0 0 0 2px #0b0c0c !important}'
V={"A":"","B":ring,"C":gov}
shots=[]
for k,css in V.items():
  js=JS+';'+tabfix
  shots.append(dict(name=f"i10-input-{k}",width=1440,height=900,dpr=2,css=BASE+css,js=js,focus="#doc-search-input",clip=dict(x=0,y=0,width=420,height=200)))
  shots.append(dict(name=f"i10-btn-{k}",width=1440,height=900,dpr=2,css=BASE+css,js=js,tabFrom="#doc-search-input",clip=dict(x=0,y=60,width=420,height=200)))
  shots.append(dict(name=f"i10-toc-{k}",width=1440,height=900,dpr=2,css=BASE+css,js=js,postjs=sv.GOTO,tabFrom='.toc a[href^="#if-tx-05"]',clip=dict(x=0,y=250,width=420,height=320)))
json.dump(dict(COMMON,outDir=os.getcwd()+"/shots",shots=shots),open('i10.json','w'))
E
FONTCONFIG_FILE=$S/fonts-sc.conf node variants.js i10.json 2>&1 | grep -v '^shot'; python3 - <<E
from PIL import Image
S="$S"; sheet=Image.new('RGB',(3*430,720+10),'white')
for i,k in enumerate("ABC"):
  y=0
  for sc,h in [('input',200),('btn',200),('toc',320)]:
    im=Image.open(f"{S}/shots/i10-{sc}-{k}.png").convert('RGB').resize((420,h)); sheet.paste(im,(i*430,y)); y+=h+3
sheet.save(f"{S}/peek10.png")
E
```

```bash
S=/tmp/claude-1000/-home-user-hp-workspace-md2doc/cc552bfe-c005-4ece-b528-ad08d7b94e52/scratchpad; cd $S && cat > i10-item.json <<'E'
{
  "n": 10, "slug": "i10", "short": "鍵盤焦點",
  "title": "鍵盤焦點",
  "intro": [
    "<strong>先更正：</strong>第一輪總覽我寫「鍵盤焦點在灰底卡片上幾乎看不見」，這沒有實測過。這次實際用 Tab 鍵移動後截圖，Chrome 預設的焦點框（A）是黑白雙層、約 2px，在灰色面板上也很清楚。",
    "實測時找到一個真正的問題，是第 7+8 項的新側欄帶出來的：Search / Clear 按鈕在畫面上隱藏了，但仍然在 Tab 順序裡，所以從搜尋框按 Tab 時，焦點會「消失」兩次才到下一個按鈕。<strong>三個選項都已修正</strong>（替這兩顆按鈕加 <code>tabindex=\"-1\"</code>，按 Enter 搜尋、按 Esc 或 ✕ 清除仍可用）。",
    "參考網站實測（2026-10-01，實際按 Tab）：MDN、Docusaurus 用 Chrome 預設焦點框；GitHub Docs 用 4px 實線藍框、外推 2px；GOV.UK 用黃色底加深色底線。截圖已套用前面所有定案。"
  ],
  "options": [
    {"key": "A", "label": "維持 Chrome 預設", "rec": true, "desc": "黑白雙層焦點框。參考：MDN、Docusaurus。"},
    {"key": "B", "label": "文件藍焦點框", "desc": "2px 藍色實線框、外推 2px（TOC 內改成內縮，避免被側欄邊緣切掉）。參考：GitHub Docs（實測 4px）。"},
    {"key": "C", "label": "黃底高對比", "desc": "焦點項目變黃底加深色底線。參考：GOV.UK。和 md2doc 的「黃色＝搜尋命中」衝突。"}
  ],
  "scenes": [
    {"id": "input", "title": "焦點在搜尋框", "caption": "", "w": 840, "h": 400, "maxw": 420},
    {"id": "btn", "title": "從搜尋框按一次 Tab：焦點到「全部展開」", "caption": "修正前這一步要按三次 Tab，中間兩次焦點看不見。", "w": 840, "h": 400, "maxw": 420},
    {"id": "toc", "title": "焦點在 TOC 的 IF-VR-01（同時也是目前位置）", "caption": "最能看出焦點樣式和「目前位置」藍色標示會不會混淆。", "w": 840, "h": 640, "maxw": 420}
  ],
  "refs_title": "參考：實際按 Tab 後的焦點樣式",
  "refs_intro": "每張都是在該網站按數次 Tab 後，焦點所在元素附近的截圖。",
  "refs": [
    {"img": "ref10-mdn.png", "title": "MDN", "caption": "Chrome 預設焦點框（<code>1px auto</code>）。", "w": 237, "h": 117},
    {"img": "ref10-docusaurus.png", "title": "Docusaurus", "caption": "Chrome 預設焦點框。", "w": 169, "h": 114},
    {"img": "ref10-ghdocs.png", "title": "GitHub Docs", "caption": "4px 實線藍框，外推 2px。", "w": 497, "h": 112},
    {"img": "ref10-govuk.png", "title": "GOV.UK", "caption": "黃色底 <code>#ffdd00</code> 加深色底線。", "w": 223, "h": 141}
  ],
  "recommend": "<p><strong>我推薦 A：維持 Chrome 預設，只修 Tab 順序。</strong>理由：一、實測預設焦點框已經夠清楚，而且黑白配色和 md2doc 的藍（目前位置）、黃（搜尋命中）都不衝突；B 的藍框在 IF-VR-01 上和目前位置的藍色標示疊在一起，分不出哪個是焦點；C 的黃底則和搜尋命中撞色。二、真正影響鍵盤使用的是隱藏按鈕還在 Tab 順序裡，這個已經在三個選項都修掉了，不需要再改焦點樣式。</p>",
  "notes": []
}
E
python3 build_item.py i10-item.json >/dev/null && python3 -c "
from PIL import Image
for k in ['mdn','docusaurus','ghdocs','govuk']: print(k, Image.open('$S/review/i10/img/ref10-'+k+'.png').size)" 2>/dev/null || ls review/i10/img
```

```bash
S=/tmp/claude-1000/-home-user-hp-workspace-md2doc/cc552bfe-c005-4ece-b528-ad08d7b94e52/scratchpad; cd $S && sed -i 's/按 Enter 搜尋、按 Esc 或 ✕ 清除仍可用/按 Enter 搜尋；清除改用輸入框內建的 ✕，實作時要確認它會一併清掉搜尋結果/' i10-item.json && python3 build_item.py i10-item.json >/dev/null && cd review/i10 && ls img | python3 -c "import sys,json;print(json.dumps([{'path':'img/'+l.split()[0]} for l in sys.stdin if l.strip()]))"
```

```bash
S=/tmp/claude-1000/-home-user-hp-workspace-md2doc/cc552bfe-c005-4ece-b528-ad08d7b94e52/scratchpad; cd $S && cat >> decided.py <<'E'
# item 10 = B: doc-blue focus ring (+ hidden search buttons out of tab order)
BASE = BASE + '.reader-sidebar :is(a,button,input):focus-visible,.content a:focus-visible{outline:2px solid #0969da !important;outline-offset:2px;border-radius:4px}.toc a:focus-visible{outline-offset:-2px !important}'
JS = JS + r""";['doc-search-submit','doc-search-clear'].forEach(id=>document.getElementById(id).tabIndex=-1)"""
E
cat > refs11.js <<'E'
const puppeteer = require('/home/user/hp_workspace/md2doc/node_modules/puppeteer');
const sites = [['ghdocs','https://docs.github.com/en/get-started/writing-on-github/working-with-advanced-formatting/creating-diagrams'],['mdn','https://developer.mozilla.org/en-US/docs/Web/CSS/position'],['docusaurus','https://docusaurus.io/docs/markdown-features/diagrams']];
(async () => {
  const b = await puppeteer.launch({ args: ['--no-sandbox'] });
  for (const [id, url] of sites) {
    const ctx = await b.createBrowserContext(); const p = await ctx.newPage(); await p.setViewport({ width: 1440, height: 900 });
    await p.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: 'dark' }]);
    await p.goto(url, { waitUntil: 'networkidle2', timeout: 60000 }).catch(e => console.log(id, e.message));
    await new Promise(r => setTimeout(r, 3000));
    const info = await p.evaluate(() => { const d = document.querySelector('svg[id^="mermaid"], .mermaid svg, iframe[src*="viewscreen"], img'); if (d) d.scrollIntoView({ block: 'center' }); return { bg: getComputedStyle(document.body).backgroundColor, diag: d && d.tagName }; });
    await new Promise(r => setTimeout(r, 2500));
    console.log(id, JSON.stringify(info));
    await p.screenshot({ path: `${process.argv[2]}/ref11-${id}.png` });
    await ctx.close();
  }
  await b.close();
})();
E
cd /home/user/hp_workspace/md2doc && FONTCONFIG_FILE=$S/fonts-sc.conf timeout 300 node $S/refs11.js $S/shots && python3 - <<E
from PIL import Image
S="$S"; sheet=Image.new('RGB',(3*720,450),'white')
for i,k in enumerate(['ghdocs','mdn','docusaurus']): sheet.paste(Image.open(f"{S}/shots/ref11-{k}.png").convert('RGB').resize((720,450)),(i*720,0))
sheet.save(f"{S}/peek11r.png")
E
```

```bash
S=/tmp/claude-1000/-home-user-hp-workspace-md2doc/cc552bfe-c005-4ece-b528-ad08d7b94e52/scratchpad; cd $S && sed -e "s#const sites = \[.*#const sites = [['docusaurus','https://docusaurus.io/docs/markdown-features/diagrams']];#" -e "s#document.querySelector('svg\[id^=\"mermaid\"\], .mermaid svg, iframe\[src\*=\"viewscreen\"\], img')#document.querySelector('svg[aria-roledescription]')#" -e "s#info = await p.evaluate(() => { const d#info = await p.evaluate(() => { const d#" refs11.js > refs11b.js && grep -c "aria-roledescription" refs11b.js && cd /home/user/hp_workspace/md2doc && FONTCONFIG_FILE=$S/fonts-sc.conf timeout 200 node $S/refs11b.js $S/shots && python3 - <<E
from PIL import Image
S="$S"
im=Image.open(f"{S}/shots/ref11-docusaurus.png"); print(im.size)
im.crop((300,150,1200,750)).save(f"{S}/peek11d.png")
E
```

```bash
S=/tmp/claude-1000/-home-user-hp-workspace-md2doc/cc552bfe-c005-4ece-b528-ad08d7b94e52/scratchpad; cd $S && python3 - <<'E'
import json, os, sys
sys.path.insert(0,'.'); from decided import BASE, COMMON, JS
inv='html{filter:invert(1) hue-rotate(180deg);background:#fff}'
back='filter:invert(1) hue-rotate(180deg);'
panel='.content .mermaid,.content .graphviz{background:#fff;border-radius:8px;padding:12px}'
V={"A":"",
   "B":inv+panel+'.content .mermaid,.content .graphviz,.content img{'+back+'}',
   "C":inv+'.content .graphviz{background:#fff;border-radius:8px;padding:12px}.content .graphviz,.content img{'+back+'}',
   "D":inv}
shots=[]
for k,css in V.items():
  shots.append(dict(name=f"i11-page-{k}",width=1440,height=900,css=BASE+css,js=JS,clip=dict(x=0,y=0,width=1440,height=900)))
  shots.append(dict(name=f"i11-fsm-{k}",width=1440,height=900,css=BASE+css,js=JS,target="13.1",offset=60,clip=dict(x=340,y=0,width=1100,height=900)))
  shots.append(dict(name=f"i11-gv-{k}",width=1440,height=900,css=BASE+css,js=JS,target="1.1Overview Block Diagram",offset=40,clip=dict(x=340,y=0,width=1100,height=700)))
json.dump(dict(COMMON,outDir=os.getcwd()+"/shots",shots=shots),open('i11.json','w'))
E
FONTCONFIG_FILE=$S/fonts-sc.conf node variants.js i11.json 2>&1 | grep -v '^shot'; python3 - <<E
from PIL import Image
S="$S"; sheet=Image.new('RGB',(4*550,2*450),'white')
for i,k in enumerate("ABCD"):
  sheet.paste(Image.open(f"{S}/shots/i11-fsm-{k}.png").convert('RGB').resize((550,450)),(i*550,0))
  sheet.paste(Image.open(f"{S}/shots/i11-gv-{k}.png").convert('RGB').resize((550,350)),(i*550,450))
sheet.save(f"{S}/peek11.png")
E
```

```bash
S=/tmp/claude-1000/-home-user-hp-workspace-md2doc/cc552bfe-c005-4ece-b528-ad08d7b94e52/scratchpad; cd $S && python3 - <<'E'
import json, sys; sys.path.insert(0,'.')
from decided import BASE, JS, COMMON, GOTO_IFVR, MOB_CSS, MOB_JS, MOB_POST
shots=[dict(name="chk-desk",width=1440,height=900,css=BASE,js=JS,postjs=GOTO_IFVR,clip=dict(x=0,y=0,width=1440,height=900)),
       dict(name="chk-mob",width=390,height=844,dpr=2,css=BASE+MOB_CSS,js=JS+';'+MOB_JS,target="4.3Out-of-Scope",offset=330,postjs=MOB_POST,clip=dict(x=0,y=0,width=390,height=844))]
json.dump(dict(COMMON,outDir=S+"/shots" if False else __import__('os').getcwd()+"/shots",shots=shots),open('chk.json','w'))
E
FONTCONFIG_FILE=$S/fonts-sc.conf node variants.js chk.json 2>&1 | grep -v '^shot'; echo done
```

```bash
S=/tmp/claude-1000/-home-user-hp-workspace-md2doc/cc552bfe-c005-4ece-b528-ad08d7b94e52/scratchpad; cd $S && python3 - <<'E'
p='variants.js'; s=open(p).read()
s=s.replace("      if (s.el) {","""      if (s.boxes) {
        const cx = (s.clip && s.clip.x) || 0, cy = (s.clip && s.clip.y) || 0;
        const bx = await p.evaluate((sels, cx, cy) => Object.fromEntries(Object.entries(sels).map(([k, sel]) =>
          [k, [...document.querySelectorAll(sel)].map(e => { const r = e.getBoundingClientRect(); return [r.x - cx, r.y - cy, r.width, r.height].map(Math.round); })
            .filter(([x, y, w, h]) => y + h > 0 && y < innerHeight && w > 0)])), s.boxes, cx, cy);
        fs.writeFileSync(`${cfg.outDir}/${s.name}.boxes.json`, JSON.stringify(bx));
      }
      if (s.el) {""",1)
open(p,'w').write(s)
import json, sys, os; sys.path.insert(0,'.')
from decided import BASE, JS, COMMON
boxes={"mermaid":".content .mermaid svg","graphviz":".content .graphviz svg"}
shots=[dict(name="i11raw-page",width=1440,height=900,css=BASE,js=JS,boxes=boxes,clip=dict(x=0,y=0,width=1440,height=900)),
       dict(name="i11raw-fsm",width=1440,height=900,css=BASE,js=JS,target="Verify / Respond FSM",offset=60,boxes=boxes,clip=dict(x=340,y=0,width=1100,height=900)),
       dict(name="i11raw-gv",width=1440,height=900,css=BASE,js=JS,target="1.1Overview Block Diagram",offset=40,boxes=boxes,clip=dict(x=340,y=0,width=1100,height=760))]
json.dump(dict(COMMON,outDir=os.getcwd()+"/shots",shots=shots),open('i11.json','w'))
E
FONTCONFIG_FILE=$S/fonts-sc.conf node variants.js i11.json 2>&1 | grep -v '^shot'; cat shots/i11raw-fsm.boxes.json; echo; cat shots/i11raw-gv.boxes.json
```

```bash
S=/tmp/claude-1000/-home-user-hp-workspace-md2doc/cc552bfe-c005-4ece-b528-ad08d7b94e52/scratchpad; cd $S && python3 - <<'E'
import json
d=json.load(open('i11.json'))
for s in d['shots']:
  if s['name']=='i11raw-fsm':
    s.pop('target'); s.pop('offset')
    s['postjs']=r"""(()=>{const m=document.querySelectorAll('.content .mermaid')[1];window.scrollTo(0,m.getBoundingClientRect().top+scrollY-160);})()"""
json.dump(d,open('i11.json','w'))
E
FONTCONFIG_FILE=$S/fonts-sc.conf node variants.js i11.json fsm 2>&1 | grep -v '^shot'; cat shots/i11raw-fsm.boxes.json
```

```bash
S=/tmp/claude-1000/-home-user-hp-workspace-md2doc/cc552bfe-c005-4ece-b528-ad08d7b94e52/scratchpad; cd $S && cat > darkify.py <<'E'
import json, sys
from PIL import Image, ImageOps, ImageChops
def dark(im):
    inv = ImageOps.invert(im.convert('RGB'))
    h, s, v = inv.convert('HSV').split()
    h = h.point(lambda x: (x + 128) % 256)
    rgb = Image.merge('HSV', (h, s, v)).convert('RGB')
    return rgb.point(lambda c: int(16 + c * 0.86))
def variant(name, keep):  # keep: list of box kinds that stay light
    im = Image.open(f'shots/i11raw-{name}.png').convert('RGB')
    boxes = json.load(open(f'shots/i11raw-{name}.boxes.json'))
    out = dark(im)
    for kind in keep:
        for x, y, w, h in boxes.get(kind, []):
            pad = 12
            box = (max(0, x - pad), max(0, y - pad), min(im.width, x + w + pad), min(im.height, y + h + pad))
            out.paste(im.crop(box), box[:2])
    return out
for name in ['page', 'fsm', 'gv']:
    Image.open(f'shots/i11raw-{name}.png').convert('RGB').save(f'shots/i11-{name}-A.png')
    variant(name, ['mermaid', 'graphviz']).save(f'shots/i11-{name}-B.png')
    variant(name, ['graphviz']).save(f'shots/i11-{name}-C.png')
    variant(name, []).save(f'shots/i11-{name}-D.png')
print('ok')
E
python3 darkify.py && python3 -c "
from PIL import Image
s=Image.new('RGB',(4*550,2*450),'white')
for i,k in enumerate('ABCD'):
  s.paste(Image.open('shots/i11-fsm-'+k+'.png').resize((550,450)),(i*550,0))
  s.paste(Image.open('shots/i11-gv-'+k+'.png').resize((550,388)),(i*550,450))
s.save('peek11.png')"
```

```bash
S=/tmp/claude-1000/-home-user-hp-workspace-md2doc/cc552bfe-c005-4ece-b528-ad08d7b94e52/scratchpad; cat > $S/refs11.js <<'E'
const puppeteer = require('/home/user/hp_workspace/md2doc/node_modules/puppeteer');
const sites = [['ghdocs','https://docs.github.com/en/get-started/writing-on-github/working-with-advanced-formatting/creating-diagrams','img'],['docusaurus','https://docusaurus.io/docs/markdown-features/diagrams','svg[aria-roledescription]']];
(async () => {
  const b = await puppeteer.launch({ args: ['--no-sandbox'] });
  for (const [id, url, sel] of sites) {
    const ctx = await b.createBrowserContext(); const p = await ctx.newPage(); await p.setViewport({ width: 1440, height: 900 });
    await p.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: 'dark' }]);
    await p.goto(url, { waitUntil: 'networkidle2', timeout: 60000 }).catch(e => console.log(id, e.message));
    await new Promise(r => setTimeout(r, 3000));
    const r = await p.evaluate(sel => { const d = [...document.querySelectorAll(sel)].find(e => e.getBoundingClientRect().width > 200 && !e.closest('header,nav')); if (!d) return null; d.scrollIntoView({ block: 'center' }); const rc = d.getBoundingClientRect(); return [rc.x, rc.y, rc.width, rc.height].map(Math.round); }, sel);
    await new Promise(r => setTimeout(r, 2500));
    const rc = await p.evaluate(sel => { const d = [...document.querySelectorAll(sel)].find(e => e.getBoundingClientRect().width > 200 && !e.closest('header,nav')); const r = d.getBoundingClientRect(); return [r.x, r.y, r.width, r.height].map(Math.round); }, sel);
    console.log(id, rc);
    const [x, y, w, h] = rc;
    await p.screenshot({ path: `${process.argv[2]}/ref11-${id}.png`, clip: { x: Math.max(0, x - 120), y: Math.max(0, y - 120), width: Math.min(1440 - Math.max(0, x - 120), w + 240), height: Math.min(900 - Math.max(0, y - 120), h + 240) } });
    await ctx.close();
  }
  await b.close();
})();
E
cd /home/user/hp_workspace/md2doc && FONTCONFIG_FILE=$S/fonts-sc.conf timeout 240 node $S/refs11.js $S/shots && python3 -c "
from PIL import Image
for k in ['ghdocs','docusaurus']: print(k, Image.open('$S/shots/ref11-'+k+'.png').size)"
```

```bash
S=/tmp/claude-1000/-home-user-hp-workspace-md2doc/cc552bfe-c005-4ece-b528-ad08d7b94e52/scratchpad; cd $S && sed -i 's/const r = d.getBoundingClientRect(); return \[r.x, r.y, r.width, r.height\].map(Math.round); }, sel);/const r = d.getBoundingClientRect(); return [r.x, r.y + scrollY, r.width, r.height].map(Math.round); }, sel);/' refs11.js && sed -i 's/height: Math.min(900 - Math.max(0, y - 120), h + 240)/height: h + 240/' refs11.js && grep -c 'r.y + scrollY' refs11.js && cd /home/user/hp_workspace/md2doc && FONTCONFIG_FILE=$S/fonts-sc.conf timeout 240 node $S/refs11.js $S/shots && python3 -c "
from PIL import Image
a=Image.open('$S/shots/ref11-ghdocs.png'); b=Image.open('$S/shots/ref11-docusaurus.png')
s=Image.new('RGB',(a.width+b.width+10,max(a.height,b.height)),'white'); s.paste(a,(0,0)); s.paste(b,(a.width+10,0)); s.save('$S/peek11r.png')"
```

```bash
S=/tmp/claude-1000/-home-user-hp-workspace-md2doc/cc552bfe-c005-4ece-b528-ad08d7b94e52/scratchpad; cd $S && cat > i11-item.json <<'E'
{
  "n": 11, "slug": "i11", "short": "深色模式",
  "title": "深色模式：圖表怎麼處理",
  "intro": [
    "md2doc 目前只有淺色。做深色模式時，文字和表格只要換一組顏色就好，真正的取捨在圖表：mermaid 是在瀏覽器裡即時繪製的，可以換深色配色重畫；graphviz、draw.io、WaveDrom 則是預先產生好的 SVG，顏色由 spec 作者寫死在檔案裡。",
    "<strong>這頁的深色截圖是模擬的近似效果</strong>：用影像處理把淺色截圖反相，再把色相轉 180 度（所以藍色仍是藍、橘色仍是橘），最後把背景壓成深灰。實作時會另外設計一組深色配色，背景、文字的確切顏色會不一樣，但「圖表怎麼處理」這個差別可以從截圖看清楚。截圖已套用前面所有定案。",
    "參考網站（2026-10-01 以系統深色模式開啟）：GitHub Docs 把圖表放在白色底板上；Docusaurus 把 mermaid 換成深色配色重畫。"
  ],
  "options": [
    {"key": "A", "label": "不做深色（維持淺色）", "desc": "維持現狀，系統設成深色模式時 md2doc 仍是淺色。"},
    {"key": "B", "label": "深色＋所有圖表白底板", "desc": "文字、表格、側欄變深色；mermaid 與 graphviz 都保留原本的淺色，放在白色底板上。參考：GitHub Docs。作者指定的顏色完全不變，但白色底板在深色頁面上很亮。"},
    {"key": "C", "label": "深色＋mermaid 深色、其他圖白底板", "rec": true, "desc": "mermaid 換成深色配色重畫；graphviz、draw.io、WaveDrom 這些預先產生的圖保留淺色白底板。參考：Docusaurus 的 mermaid 處理方式。"},
    {"key": "D", "label": "深色＋所有圖表反相", "desc": "所有圖表一起反相（保留色相），整頁沒有白色區塊。沒有實測到使用這種做法的參考網站。作者指定的淺色會變成深色，波形圖、示意圖裡有語意的顏色深淺會反過來。"}
  ],
  "scenes": [
    {"id": "page", "title": "文件開頭與側欄", "caption": "沒有圖表的區域，B、C、D 看起來一樣。", "w": 1440, "h": 900},
    {"id": "fsm", "title": "mermaid：Verify 狀態機（13.2.3）", "caption": "B 是白底板；C、D 是深色。", "w": 1100, "h": 900},
    {"id": "gv", "title": "graphviz：1.1 Overview Block Diagram", "caption": "B、C 是白底板；D 反相後，作者設定的淺藍節點變成深藍。", "w": 1100, "h": 760}
  ],
  "refs_title": "參考：深色模式下的 mermaid 圖",
  "refs_intro": "2026-10-01 以 prefers-color-scheme: dark 開啟。",
  "refs": [
    {"img": "ref11-ghdocs.png", "title": "GitHub Docs", "caption": "整頁深色，mermaid 圖放在白色底板上（B 的做法）。", "w": 960, "h": 598},
    {"img": "ref11-docusaurus.png", "title": "Docusaurus", "caption": "mermaid 改用深色配色重畫，深灰節點、淺色線條（C 對 mermaid 的做法）。", "w": 600, "h": 480}
  ],
  "recommend": "<p><strong>我推薦 C：mermaid 深色、其他圖白底板。</strong>理由：一、你的 spec 裡最常見的圖是 mermaid 狀態機（這份有 3 張，graphviz 2 張），mermaid 本來就在瀏覽器裡即時繪製，可以像 Docusaurus 那樣正確換成深色配色，避免最常出現的圖變成刺眼的白色區塊；二、graphviz、draw.io、WaveDrom 的顏色是作者在原始檔裡指定的，保留白底板才能讓作者的顏色百分之百不變，D 的整張反相會把波形圖、方塊圖裡有意義的深淺反過來，風險最大。</p><p>要注意成本：深色模式需要把 md2doc 那 1500 多行樣式裡寫死的顏色全部改成變數（含編輯模式），是這次審查中工作量最大的一項。如果這一輪想先把其他項目做完，選 A 延後也合理。</p>",
  "notes": ["深色模式要跟隨系統設定，還是加一個手動切換鈕，等選完方向後再決定。"]
}
E
python3 build_item.py i11-item.json
```

```bash
S=/tmp/claude-1000/-home-user-hp-workspace-md2doc/cc552bfe-c005-4ece-b528-ad08d7b94e52/scratchpad; cat > $S/refs11t.js <<'E'
const puppeteer = require('/home/user/hp_workspace/md2doc/node_modules/puppeteer');
const sites = [
  ['mdn','https://developer.mozilla.org/en-US/docs/Web/CSS/position'],
  ['docusaurus','https://docusaurus.io/docs/markdown-features/diagrams'],
  ['mkdocs','https://squidfunk.github.io/mkdocs-material/reference/diagrams/'],
  ['python','https://docs.python.org/3/library/functions.html'],
  ['mdbook','https://doc.rust-lang.org/book/ch01-00-getting-started.html'],
  ['vitepress','https://vitepress.dev/guide/what-is-vitepress'],
  ['ghdocs','https://docs.github.com/en/get-started/writing-on-github/working-with-advanced-formatting/creating-diagrams'],
  ['ecma','https://tc39.es/ecma262/multipage/ecmascript-data-types-and-values.html'],
];
(async () => {
  const b = await puppeteer.launch({ args: ['--no-sandbox'] });
  for (const mob of [false, true]) for (const [id, url] of sites) {
    const ctx = await b.createBrowserContext(); const p = await ctx.newPage();
    await p.setViewport(mob ? { width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true } : { width: 1440, height: 900 });
    await p.goto(url, { waitUntil: 'networkidle2', timeout: 60000 }).catch(e => console.log(id, e.message));
    await new Promise(r => setTimeout(r, 2500));
    const r = await p.evaluate(() => {
      const re = /theme|dark|light|color scheme|colour|appearance|配色/i;
      const cands = [...document.querySelectorAll('button, a, select, label, input')].filter(e => {
        const t = [e.getAttribute('aria-label'), e.title, e.getAttribute('data-md-color-media') && 'theme', e.id, e.className && String(e.className), e.tagName === 'SELECT' ? e.innerText : ''].join(' ');
        const rc = e.getBoundingClientRect(); return re.test(t) && rc.width > 0 && rc.height > 0;
      });
      return cands.slice(0, 3).map(e => { const rc = e.getBoundingClientRect(); return { tag: e.tagName, label: (e.getAttribute('aria-label') || e.title || e.innerText || '').trim().replace(/\s+/g, ' ').slice(0, 50), x: Math.round(rc.x), y: Math.round(rc.y), w: Math.round(rc.width), h: Math.round(rc.height), pos: getComputedStyle(e.closest('header,nav,aside,footer,[class*="sidebar"],[class*="header"]') || e).position, inside: (e.closest('header,nav,aside,footer,[class*="sidebar"],[class*="header"]') || {}).tagName || '-' }; });
    });
    console.log(mob ? 'MOB' : 'DESK', id, JSON.stringify(r));
    await p.screenshot({ path: `${process.argv[2]}/ref11t-${mob ? 'm' : 'd'}-${id}.png` });
    await ctx.close();
  }
  await b.close();
})();
E
cd /home/user/hp_workspace/md2doc && FONTCONFIG_FILE=$S/fonts-sc.conf timeout 600 node $S/refs11t.js $S/shots
```

```bash
S=/tmp/claude-1000/-home-user-hp-workspace-md2doc/cc552bfe-c005-4ece-b528-ad08d7b94e52/scratchpad; cd $S && python3 - <<'E'
import json, os, sys; sys.path.insert(0,'.')
from decided import BASE, JS, COMMON, MOB_CSS, MOB_JS, MOB_POST, GOTO_IFVR
ICO = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M12 18a6 6 0 0 0 0-12v12z"/></svg>'
mk = r"""const mkBtn=(cls)=>{const b=document.createElement('button');b.type='button';b.className='md2doc-theme '+cls;b.innerHTML=%s;b.title='Theme: Auto (follows system)';b.setAttribute('aria-label','Theme: Auto (follows system)');return b;};""" % json.dumps(ICO)
icon_css = ('.md2doc-theme{border:none;background:transparent;color:#59636e;padding:4px;border-radius:6px;display:inline-grid;place-items:center;line-height:0;cursor:pointer}'
            '.md2doc-theme:hover{background:#e3e8ee;color:#1f2328}')
mobbar_css = '.m-bar .md2doc-theme{margin-left:auto;padding:8px;border:1px solid #d0d7de;border-radius:8px;background:#fff}'
V = {
 "A": ("", "", ""),
 "B": (icon_css + mobbar_css,
       mk + r"""document.querySelector('.toc-header-actions').prepend(mkBtn('in-toc'));""",
       mk + r"""document.querySelector('.m-bar').appendChild(mkBtn('in-bar'));"""),
 "C": (icon_css + mobbar_css + '.reader-search-row{align-items:center}.reader-search-row .md2doc-theme{flex:0 0 auto;padding:7px;border:1px solid #d0d7de;background:#fff}',
       mk + r"""document.querySelector('.reader-search-row').appendChild(mkBtn('in-search'));""",
       mk + r"""document.querySelector('.m-bar').appendChild(mkBtn('in-bar'));"""),
 "D": (icon_css + '.md2doc-theme.fab{position:fixed;right:20px;bottom:20px;z-index:101;width:44px;height:44px;border-radius:50%;background:#fff;border:1px solid #d0d7de;box-shadow:0 2px 10px rgba(0,0,0,.18);color:#1f2328}',
       mk + r"""document.body.appendChild(mkBtn('fab'));""", ""),
 "E": ('.md2doc-seg{display:flex;gap:2px;padding:3px;border-radius:8px;background:#e3e8ee;margin-top:8px;flex:0 0 auto}'
       '.md2doc-seg button{flex:1 1 0;border:none;background:transparent;border-radius:6px;padding:5px 0;font:inherit;font-size:.8rem;color:#59636e;cursor:pointer}'
       '.md2doc-seg button[aria-pressed="true"]{background:#fff;color:#1f2328;font-weight:600;box-shadow:0 1px 2px rgba(0,0,0,.12)}',
       r"""(()=>{const d=document.createElement('div');d.className='md2doc-seg';d.setAttribute('role','group');d.setAttribute('aria-label','Theme');['Auto','Light','Dark'].forEach((t,i)=>{const b=document.createElement('button');b.type='button';b.textContent=t;b.setAttribute('aria-pressed',i===0?'true':'false');d.appendChild(b)});document.querySelector('.reader-sidebar').appendChild(d);})()""", ""),
}
OPEN = r"""document.getElementById('sidebar-toggle').click()"""
shots = []
for k, (css, djs, mjs) in V.items():
    shots.append(dict(name=f"i11t-side-{k}", width=1440, height=900, dpr=2, css=BASE+css, js=JS+';'+djs, clip=dict(x=0, y=0, width=420, height=900)))
    shots.append(dict(name=f"i11t-page-{k}", width=1440, height=900, css=BASE+css, js=JS+';'+djs, postjs=GOTO_IFVR, clip=dict(x=0, y=0, width=1440, height=900)))
    mob_js = JS + ';' + MOB_JS + ';' + djs + (';' + mjs if mjs else '')
    shots.append(dict(name=f"i11t-mob-{k}", width=390, height=844, dpr=2, css=BASE+MOB_CSS+css, js=mob_js, postjs=GOTO_IFVR+';'+MOB_POST, clip=dict(x=0, y=0, width=390, height=844)))
    shots.append(dict(name=f"i11t-drawer-{k}", width=390, height=844, dpr=2, css=BASE+MOB_CSS+css, js=mob_js, postjs=GOTO_IFVR+';'+MOB_POST+';'+OPEN, clip=dict(x=0, y=0, width=390, height=844)))
json.dump(dict(COMMON, outDir=os.getcwd()+"/shots", shots=shots), open('i11t.json', 'w'))
print(len(shots))
E
FONTCONFIG_FILE=$S/fonts-sc.conf node variants.js i11t.json 2>&1 | grep -v '^shot'; python3 - <<E
from PIL import Image
S="$S"; sheet=Image.new('RGB',(5*400,2*850),'white')
for i,k in enumerate("ABCDE"):
  sheet.paste(Image.open(f"{S}/shots/i11t-side-{k}.png").convert('RGB').resize((390,836)).crop((0,0,390,836)),(i*400,0))
  sheet.paste(Image.open(f"{S}/shots/i11t-mob-{k}.png").convert('RGB').resize((390,844)),(i*400,850))
sheet.save(f"{S}/peek11t.png")
E
```

```bash
S=/tmp/claude-1000/-home-user-hp-workspace-md2doc/cc552bfe-c005-4ece-b528-ad08d7b94e52/scratchpad; cd $S && python3 - <<'E'
import json
d=json.load(open('i11t.json'))
for s in d['shots']:
  j=s['js']; key='const mkBtn='
  first=j.find(key); second=j.find(key, first+1)
  if second>0:
    end=j.find('};', second)+2
    s['js']=j[:second]+j[end:]
json.dump(d,open('i11t.json','w'))
E
FONTCONFIG_FILE=$S/fonts-sc.conf node variants.js i11t.json 'i11t-(mob|drawer)-[BC]' 2>&1 | grep -v '^shot'; python3 - <<E
from PIL import Image
S="$S"; sheet=Image.new('RGB',(5*400,2*850),'white')
for i,k in enumerate("ABCDE"):
  sheet.paste(Image.open(f"{S}/shots/i11t-side-{k}.png").convert('RGB').resize((390,836)),(i*400,0))
  sheet.paste(Image.open(f"{S}/shots/i11t-mob-{k}.png").convert('RGB').resize((390,844)),(i*400,850))
sheet.save(f"{S}/peek11t.png")
E
```

```bash
S=/tmp/claude-1000/-home-user-hp-workspace-md2doc/cc552bfe-c005-4ece-b528-ad08d7b94e52/scratchpad; cd $S && python3 - <<'E'
from PIL import Image
crops={'d-docusaurus':(1000,20,1440,100),'d-mkdocs':(560,30,1000,110),'d-python':(980,30,1440,90),'d-mdbook':(0,0,600,60),'d-vitepress':(1000,0,1440,64),'m-mkdocs':(0,0,780,260)}
for k,b in crops.items():
  Image.open(f'shots/ref11t-{k}.png').crop(b).save(f'shots/ref11t-{k}-c.png')
  print(k, Image.open(f'shots/ref11t-{k}-c.png').size)
E
cat > i11t-item.json <<'E'
{
  "n": "11b", "slug": "i11t", "short": "主題切換位置",
  "title": "深色模式：切換按鈕放哪裡",
  "intro": [
    "第 11 項定案為 C（mermaid 深色、其他圖白底板）。這頁決定使用者在哪裡切換淺色／深色。",
    "參考網站實測（2026-10-01，桌面 1440、手機 390）：<strong>沒有任何一個用懸浮泡泡</strong>，全部放在頁面頂端的列上——Docusaurus 導覽列右側圖示、Material for MkDocs 標題列（搜尋框旁）圖示、Python docs 頂端「Theme: Auto / Light / Dark」選單、mdBook 左上工具列的調色盤圖示、VitePress 頂端 Appearance 開關、MDN 麵包屑列的 Theme 按鈕。手機版則放在頂列，或收進選單抽屜（Docusaurus、Python、VitePress）。GitHub Docs 與 ECMA-262 沒有按鈕，只跟隨系統。",
    "md2doc 桌面版沒有頂端列，最接近「頂端列」的位置是側欄面板最上方。所有選項的預設狀態都是 <strong>Auto（跟隨系統）</strong>，選擇會記在瀏覽器裡。截圖已套用前面所有定案（仍是淺色畫面，按鈕位置才是重點）。"
  ],
  "options": [
    {"key": "A", "label": "不放按鈕，只跟隨系統", "desc": "完全由作業系統的深淺色設定決定。參考：GitHub Docs、ECMA-262。"},
    {"key": "B", "label": "Contents 列的圖示", "rec": true, "desc": "桌面：放在側欄「Contents」那一列，和展開、收合、隱藏側欄三顆圖示同排。手機：頂列右側。點開是 Auto / Light / Dark 小選單。參考：Docusaurus、MkDocs 的頂端列圖示；MDN、Python 的三態選單。"},
    {"key": "C", "label": "搜尋框旁的圖示", "desc": "桌面：搜尋框右邊一顆圖示。手機：頂列右側。參考：Material for MkDocs（切換鈕就在搜尋框旁）。搜尋框會變窄一點。"},
    {"key": "D", "label": "右下角懸浮泡泡", "desc": "桌面、手機都固定在右下角的圓形按鈕。上述參考網站都沒有這樣做。會蓋住右下角的內文，手機上尤其明顯。"},
    {"key": "E", "label": "側欄底部三段切換", "desc": "側欄最底部一排「Auto | Light | Dark」，目前狀態一眼看得到，不用點開選單。手機版在抽屜底部。參考：Python docs 把三種狀態直接寫出來的做法，只是位置改到側欄底部。"}
  ],
  "scenes": [
    {"id": "side", "title": "桌面：側欄", "caption": "B 在 Contents 列；C 在搜尋框右邊；E 在側欄最底部。D 的泡泡不在側欄，看下一個場景。", "w": 840, "h": 1800, "maxw": 420},
    {"id": "page", "title": "桌面：整頁（捲到 IF-VR-01）", "caption": "D 的泡泡在右下角。", "w": 1440, "h": 900},
    {"id": "mob", "title": "手機：閱讀中", "caption": "B、C 在頂列右側；D 的泡泡在右下角，蓋住表格。", "w": 780, "h": 1688, "maxw": 390},
    {"id": "drawer", "title": "手機：打開抽屜", "caption": "E 在抽屜底部；B 的圖示在抽屜的 Contents 列也看得到。", "w": 780, "h": 1688, "maxw": 390}
  ],
  "refs_title": "參考：文件網站的主題切換位置",
  "refs_intro": "2026-10-01 實測，用 aria-label / title 找出主題切換元件後截取所在區域。",
  "refs": [
    {"img": "ref11t-d-docusaurus-c.png", "title": "Docusaurus", "caption": "導覽列右側圖示，三態（tooltip 寫著 currently system mode）。", "w": 440, "h": 80},
    {"img": "ref11t-d-mkdocs-c.png", "title": "Material for MkDocs", "caption": "標題列圖示，就在搜尋框左側。", "w": 440, "h": 80},
    {"img": "ref11t-d-python-c.png", "title": "Python docs", "caption": "頂端「Theme: Auto / Light / Dark」下拉選單，三種狀態直接寫出來。", "w": 460, "h": 60},
    {"img": "ref11t-d-mdbook-c.png", "title": "mdBook（The Rust Book）", "caption": "左上角工具列的調色盤圖示，點開是主題選單。", "w": 600, "h": 60},
    {"img": "ref11t-d-vitepress-c.png", "title": "VitePress", "caption": "頂端導覽列的 Appearance 開關。", "w": 440, "h": 64},
    {"img": "ref11t-m-mkdocs-c.png", "title": "Material for MkDocs（手機）", "caption": "手機頂列裡的圖示。", "w": 390, "h": 130}
  ],
  "recommend": "<p><strong>我推薦 B：Contents 列的圖示。</strong>理由：一、所有參考網站都把主題切換放在頁面最上方、和其他工具圖示並列；md2doc 的 D 側欄裡，Contents 列就是那個位置，而且已經有三顆同樣風格的圖示，B 只是多一顆，不會產生新的視覺元素；手機版放頂列右側，也和 MkDocs、Docusaurus 一致。二、點開後是 Auto / Light / Dark 三態選單（MDN、Python 的做法），預設 Auto 跟隨系統，不會讓只想跟系統走的人多一個步驟。</p><p>D 的懸浮泡泡沒有參考網站這樣做，而且在手機上會直接蓋住表格（看場景 3）。E 把狀態寫得最清楚，如果你希望一眼看到目前是哪個模式，E 是次佳選擇。</p>",
  "notes": ["另外觀察到（不在這項範圍）：手機上介面表的 Description 欄被擠到畫面外，每一列變得很高，要橫向捲動才看得到描述。這是表格在窄螢幕上的版面問題，審查結束時會列入待辦。"]
}
E
python3 build_item.py i11t-item.json
```

```bash
S=/tmp/claude-1000/-home-user-hp-workspace-md2doc/cc552bfe-c005-4ece-b528-ad08d7b94e52/scratchpad; cd $S && python3 - <<'E'
import json
d=json.load(open('i11t-item.json'))
for r in d['refs']:
  if r['img']=='ref11t-d-mkdocs-c.png':
    r['caption']='標題列、搜尋框左側的圖示（title 是「Switch to light mode」）。官網在 Auto 狀態用的是一個連結形狀的圖示，點一下會依序切到淺色、深色。'
  if r['img']=='ref11t-d-docusaurus-c.png':
    r['caption']='導覽列右側、搜尋框左邊的半圓圖示，三態（tooltip：currently system mode）。'
  if r['img']=='ref11t-m-mkdocs-c.png':
    r['caption']='手機頂列裡同一顆圖示。'
json.dump(d,open('i11t-item.json','w'),ensure_ascii=False)
E
python3 build_item.py i11t-item.json >/dev/null; python3 -c "
from PIL import Image; im=Image.open('$S/shots/ref11t-m-mkdocs-c.png'); im.resize((390,130)).save('$S/peekm.png')"
```

```bash
S=/tmp/claude-1000/-home-user-hp-workspace-md2doc/cc552bfe-c005-4ece-b528-ad08d7b94e52/scratchpad; cd $S && python3 - <<'E'
import json
L = {  # Lucide (ISC)
 'sun': '<circle cx="12" cy="12" r="4"/><path d="M12 2v2"/><path d="M12 20v2"/><path d="m4.93 4.93 1.41 1.41"/><path d="m17.66 17.66 1.41 1.41"/><path d="M2 12h2"/><path d="M20 12h2"/><path d="m6.34 17.66-1.41 1.41"/><path d="m19.07 4.93-1.41 1.41"/>',
 'moon': '<path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z"/>',
 'monitor': '<rect width="20" height="14" x="2" y="3" rx="2"/><line x1="8" x2="16" y1="21" y2="21"/><line x1="12" x2="12" y1="17" y2="21"/>',
 'contrast': '<circle cx="12" cy="12" r="10"/><path d="M12 18a6 6 0 0 0 0-12v12z"/>',
 'sunmoon': '<path d="M12 8a2.83 2.83 0 0 0 4 4 4 4 0 1 1-4-4"/><path d="M12 2v2"/><path d="M12 20v2"/><path d="m4.9 4.9 1.4 1.4"/><path d="m17.7 17.7 1.4 1.4"/><path d="M2 12h2"/><path d="M20 12h2"/><path d="m6.3 17.7-1.4 1.4"/><path d="m19.1 4.9-1.4 1.4"/>',
}
def svg(k, size=20): return f'<svg width="{size}" height="{size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">{L[k]}</svg>'
# per option: content for (auto, light, dark)
OPT = {
 'A': [svg('contrast')]*3,
 'B': [svg('monitor'), svg('sun'), svg('moon')],
 'C': [svg('sun'), svg('sun'), svg('moon')],   # auto shows the resolved scheme (system light here)
 'D': [svg('sunmoon')]*3,
 'E': ['Auto', 'Light', 'Dark'],
}
json.dump({'icons': L, 'opt': OPT}, open('bubble_icons.json', 'w'))
css = """
body{margin:0;font-family:"Segoe UI","Microsoft JhengHei",sans-serif}
.row{display:flex;gap:0}
.cell{width:220px;height:150px;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:12px}
.cell.light{background:#ffffff;color:#57606a}.cell.dark{background:#121417;color:#9aa5b1}
.lab{font-size:13px}
.fab{width:44px;height:44px;border-radius:50%;display:grid;place-items:center;box-shadow:0 2px 10px rgba(0,0,0,.18)}
.light .fab{background:#fff;border:1px solid #d0d7de;color:#1f2328}
.dark .fab{background:#22262c;border:1px solid #3a414a;color:#e6edf3;box-shadow:0 2px 10px rgba(0,0,0,.5)}
.fab.text{width:auto;padding:0 16px;border-radius:22px;font-size:14px;font-weight:600}
"""
for k, states in OPT.items():
    cells = ''
    for (st, bg), c in zip([('Auto（系統為淺色）', 'light'), ('Light', 'light'), ('Dark', 'dark')], states):
        cls = 'fab text' if k == 'E' else 'fab'
        cells += f'<div class="cell {bg}"><div class="{cls}">{c}</div><div class="lab">{st}</div></div>'
    open(f'bubble-{k}.html', 'w').write(f'<!doctype html><meta charset="utf-8"><style>{css}</style><div class="row">{cells}</div>')
print('ok')
E
cat > bubble_shot.js <<'E'
const puppeteer = require('/home/user/hp_workspace/md2doc/node_modules/puppeteer');
(async () => {
  const b = await puppeteer.launch({ args: ['--no-sandbox'] }); const p = await b.newPage();
  await p.setViewport({ width: 660, height: 150, deviceScaleFactor: 2 });
  for (const k of 'ABCDE') { await p.goto('file://' + process.argv[2] + '/bubble-' + k + '.html'); await p.screenshot({ path: process.argv[2] + '/shots/i11s-close-' + k + '.png' }); }
  await b.close();
})();
E
FONTCONFIG_FILE=$S/fonts-sc.conf node bubble_shot.js $S && python3 -c "
from PIL import Image
s=Image.new('RGB',(1320,5*300),'white')
for i,k in enumerate('ABCDE'): s.paste(Image.open('$S/shots/i11s-close-'+k+'.png'),(0,i*300))
s.resize((660,750)).save('$S/peek11s.png')"
```

```bash
S=/tmp/claude-1000/-home-user-hp-workspace-md2doc/cc552bfe-c005-4ece-b528-ad08d7b94e52/scratchpad; cd $S && python3 - <<'E'
import json, os, sys; sys.path.insert(0,'.')
from decided import BASE, JS, COMMON, MOB_CSS, MOB_JS, MOB_POST, GOTO_IFVR
B = json.load(open('bubble_icons.json'))
fab_css = ('.md2doc-theme.fab{position:fixed;right:20px;bottom:20px;z-index:101;width:44px;height:44px;border-radius:50%;background:#fff;border:1px solid #d0d7de;'
           'box-shadow:0 2px 10px rgba(0,0,0,.18);color:#1f2328;display:grid;place-items:center;cursor:pointer;font:600 14px "Segoe UI",sans-serif}'
           '.md2doc-theme.fab.text{width:auto;padding:0 16px;border-radius:22px}')
def js(k, i):
    c = B['opt'][k][i]
    return r"""(()=>{const b=document.createElement('button');b.type='button';b.className='md2doc-theme fab%s';b.innerHTML=%s;document.body.appendChild(b);})()""" % (' text' if k == 'E' else '', json.dumps(c))
shots = []
for k in 'ABCDE':
    shots.append(dict(name=f"i11s-page-{k}", width=1440, height=900, css=BASE+fab_css, js=JS+';'+js(k, 0), postjs=GOTO_IFVR, clip=dict(x=0, y=0, width=1440, height=900)))
    shots.append(dict(name=f"i11s-mob-{k}", width=390, height=844, dpr=2, css=BASE+MOB_CSS+fab_css, js=JS+';'+MOB_JS+';'+js(k, 0), postjs=GOTO_IFVR+';'+MOB_POST, clip=dict(x=0, y=0, width=390, height=844)))
    shots.append(dict(name=f"i11s-darkraw-{k}", width=1440, height=900, css=BASE+fab_css, js=JS+';'+js(k, 2), postjs=GOTO_IFVR, clip=dict(x=0, y=0, width=1440, height=900)))
json.dump(dict(COMMON, outDir=os.getcwd()+"/shots", shots=shots), open('i11s.json', 'w'))
E
FONTCONFIG_FILE=$S/fonts-sc.conf node variants.js i11s.json 2>&1 | grep -v '^shot'; python3 - <<'E'
import sys; sys.path.insert(0,'.')
from PIL import Image
from darkify import dark
for k in 'ABCDE':
    dark(Image.open(f'shots/i11s-darkraw-{k}.png')).save(f'shots/i11s-dark-{k}.png')
s=Image.new('RGB',(5*300,300),'white')
for i,k in enumerate('ABCDE'):
    s.paste(Image.open(f'shots/i11s-dark-{k}.png').crop((1240,700,1440,900)).resize((150,150)),(i*300,0))
    s.paste(Image.open(f'shots/i11s-mob-{k}.png').resize((390,844)).crop((240,694,390,844)),(i*300+150,0))
s.save('peek11s2.png')
E
```

```bash
S=/tmp/claude-1000/-home-user-hp-workspace-md2doc/cc552bfe-c005-4ece-b528-ad08d7b94e52/scratchpad; cd $S && python3 - <<'E'
import json, re
d=json.load(open('bubble_icons.json')); L=d['icons']
def svg(k, size=20): return f'<svg width="{size}" height="{size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">{L[k]}</svg>'
d['opt']={'A':[svg('contrast')]*3,'B':[svg('contrast'),svg('sun'),svg('moon')],'C':[svg('monitor'),svg('sun'),svg('moon')],'D':[svg('sunmoon')]*3,'E':['Auto','Light','Dark']}
json.dump(d,open('bubble_icons.json','w'))
# rewrite close-up pages with the new sets
for k in 'BC':
    src=open('bubble-A.html').read()
    head=src.split('<div class="row">')[0]
    cells=''
    for (st,bg),c in zip([('Auto（系統為淺色）','light'),('Light','light'),('Dark','dark')], d['opt'][k]):
        cells+=f'<div class="cell {bg}"><div class="fab">{c}</div><div class="lab">{st}</div></div>'
    open(f'bubble-{k}.html','w').write(head+f'<div class="row">{cells}</div>')
E
FONTCONFIG_FILE=$S/fonts-sc.conf node bubble_shot.js $S && FONTCONFIG_FILE=$S/fonts-sc.conf node variants.js i11s.json 'i11s-.*-[BC]$' 2>&1 | grep -v '^shot'
python3 - <<'E'
import json, os, sys; sys.path.insert(0,'.')
# regenerate i11s.json js for B/C from new icon sets, then re-shoot
from decided import BASE, JS, COMMON, MOB_CSS, MOB_JS, MOB_POST, GOTO_IFVR
B=json.load(open('bubble_icons.json'))
cfg=json.load(open('i11s.json'))
def js(k,i):
    return r"""(()=>{const b=document.createElement('button');b.type='button';b.className='md2doc-theme fab%s';b.innerHTML=%s;document.body.appendChild(b);})()""" % (' text' if k=='E' else '', json.dumps(B['opt'][k][i]))
for s in cfg['shots']:
    k=s['name'][-1]; i=2 if '-darkraw-' in s['name'] else 0
    base_js=JS+(';'+MOB_JS if '-mob-' in s['name'] else '')
    s['js']=base_js+';'+js(k,i)
json.dump(cfg,open('i11s.json','w'))
E
FONTCONFIG_FILE=$S/fonts-sc.conf node variants.js i11s.json 'i11s-.*-[BC]$' 2>&1 | grep -v '^shot'; python3 - <<'E'
from PIL import Image
import importlib.util, sys
spec=importlib.util.spec_from_file_location('dk','darkify.py')
src=open('darkify.py').read().split('for name in')[0]; ns={}; exec(src, ns)
for k in 'BC': ns['dark'](Image.open(f'shots/i11s-darkraw-{k}.png')).save(f'shots/i11s-dark-{k}.png')
s=Image.new('RGB',(1320,600),'white')
for i,k in enumerate('BC'): s.paste(Image.open(f'shots/i11s-close-{k}.png'),(0,i*300))
s.resize((660,300)).save('peek11s3.png')
E
```

```bash
S=/tmp/claude-1000/-home-user-hp-workspace-md2doc/cc552bfe-c005-4ece-b528-ad08d7b94e52/scratchpad; cd $S && cp shots/ref11t-d-python-c.png shots/ref11s-python.png && cat > i11s-item.json <<'E'
{
  "n": "11c", "slug": "i11s", "short": "泡泡符號",
  "title": "深色模式：懸浮泡泡的符號",
  "intro": [
    "切換按鈕定案為右下角懸浮泡泡（11b 的 D）。這頁決定泡泡裡放什麼符號。符號同時負責兩件事：讓人知道「這顆是切換深淺色」，以及顯示<strong>目前是哪個狀態</strong>（Auto 跟隨系統／Light／Dark）。",
    "所有選項的操作方式相同：點一下依序循環 Auto → Light → Dark，滑鼠停留時顯示目前狀態的文字說明，選擇會記在瀏覽器裡。這是 Docusaurus 實測的行為（tooltip 依序是 currently system mode / light mode / dark mode）。",
    "第一個場景是每個方案在三種狀態下的特寫；後面三個是放進整頁的樣子（深色那張是模擬畫面，泡泡顯示 Dark 狀態的符號）。圖示形狀取自 Lucide 圖示庫（ISC 授權）。"
  ],
  "options": [
    {"key": "A", "label": "固定 ◐ 半圓", "desc": "三種狀態都是同一個半圓圖示，只代表「深淺色切換」，看不出目前狀態。Docusaurus 只在 Auto 狀態用這個圖示。"},
    {"key": "B", "label": "◐ / ☀ / ☾ 依狀態變", "rec": true, "desc": "Auto 顯示半圓、Light 顯示太陽、Dark 顯示月亮。參考：Docusaurus（2026-10-01 實測三種狀態的圖示正是這三個）。"},
    {"key": "C", "label": "螢幕 / ☀ / ☾ 依狀態變", "desc": "同 B，但 Auto 用螢幕圖示表示「跟隨系統」。螢幕圖示在作業系統的外觀設定裡常見，但這次實測的文件網站沒有用它。"},
    {"key": "D", "label": "固定 太陽月亮合體", "desc": "三種狀態都是同一個太陽加月亮的圖示，看不出目前狀態。沒有實測到的參考網站使用。20px 下細節偏多。"},
    {"key": "E", "label": "文字膠囊 Auto / Light / Dark", "desc": "泡泡改成膠囊形，直接寫出目前狀態。參考：Python docs 把三種狀態直接寫成文字（下拉選單）。最清楚，但泡泡比較大，也是唯一帶英文字的浮動元素。"}
  ],
  "scenes": [
    {"id": "close", "title": "特寫：三種狀態", "caption": "左：Auto（此時系統為淺色）、中：Light、右：Dark。", "w": 1320, "h": 300, "maxw": 660},
    {"id": "page", "title": "桌面：整頁（Auto 狀態）", "caption": "泡泡在右下角。", "w": 1440, "h": 900},
    {"id": "mob", "title": "手機（Auto 狀態）", "caption": "", "w": 780, "h": 1688, "maxw": 390},
    {"id": "dark", "title": "桌面：深色（Dark 狀態，模擬）", "caption": "深色頁面上泡泡顯示 Dark 狀態的符號。", "w": 1440, "h": 900}
  ],
  "refs_title": "參考",
  "refs_intro": "2026-10-01 實測。",
  "refs": [
    {"img": "ref11s-docu.png", "title": "Docusaurus 切換鈕的三種狀態", "caption": "依序點擊後截圖：Auto（半圓）→ Light（太陽）→ Dark（月亮）。B 完全照這套。", "w": 328, "h": 96},
    {"img": "ref11s-python.png", "title": "Python docs", "caption": "直接用文字「Theme: Auto / Light / Dark」，E 的參考。", "w": 460, "h": 60}
  ],
  "recommend": "<p><strong>我推薦 B：◐ / ☀ / ☾ 依狀態變。</strong>理由：一、它是實測過的現成做法（Docusaurus 三種狀態正是這三個圖示），太陽、月亮幾乎人人看得懂，半圓代表「兩者之間、跟隨系統」；二、泡泡會一直浮在畫面上，B 讓它同時是「目前狀態指示燈」，A、D 的固定圖示做不到這件事，E 雖然最清楚但膠囊比圓形大，佔掉更多右下角的內文。</p>",
  "notes": []
}
E
python3 build_item.py i11s-item.json
```

```bash
S=/tmp/claude-1000/-home-user-hp-workspace-md2doc/cc552bfe-c005-4ece-b528-ad08d7b94e52/scratchpad; cd $S && cat >> decided.py <<'E'

# item 11 = C: dark mode, mermaid re-themed dark, baked SVG (graphviz/draw.io/WaveDrom) on light panels
# item 11b = D: floating bubble bottom-right; item 11c = B: icon by state (Auto = contrast, Light = sun, Dark = moon),
#            click cycles Auto -> Light -> Dark, choice remembered in the browser (Docusaurus behaviour)
E
cat > refs12.js <<'E'
const puppeteer = require('/home/user/hp_workspace/md2doc/node_modules/puppeteer');
(async () => {
  const b = await puppeteer.launch({ args: ['--no-sandbox'] });
  for (const [id, url, h] of [['rfc', 'https://www.rfc-editor.org/rfc/rfc9293.html', 520], ['whatwg', 'https://html.spec.whatwg.org/multipage/', 520], ['ecma', 'https://tc39.es/ecma262/', 420]]) {
    const ctx = await b.createBrowserContext(); const p = await ctx.newPage(); await p.setViewport({ width: 1440, height: 900 });
    await p.goto(url, { waitUntil: 'networkidle2', timeout: 60000 }).catch(e => console.log(id, e.message));
    await new Promise(r => setTimeout(r, 2500));
    await p.screenshot({ path: `${process.argv[2]}/shots/ref12-${id}.png`, clip: { x: 0, y: 0, width: 1440, height: h } });
    await ctx.close();
  }
  await b.close();
})();
E
cd /home/user/hp_workspace/md2doc && FONTCONFIG_FILE=$S/fonts-sc.conf timeout 200 node $S/refs12.js $S && python3 -c "
from PIL import Image
s=Image.new('RGB',(1440,1470),'white'); y=0
for k in ['rfc','whatwg','ecma']:
  im=Image.open('$S/shots/ref12-'+k+'.png'); s.paste(im,(0,y)); y+=im.height+5
s.resize((960,980)).save('$S/peek12r.png')"
```

```bash
S=/tmp/claude-1000/-home-user-hp-workspace-md2doc/cc552bfe-c005-4ece-b528-ad08d7b94e52/scratchpad; cd $S && python3 - <<'E'
import json, os, sys; sys.path.insert(0,'.')
from decided import BASE, JS, COMMON, MOB_CSS, MOB_JS, MOB_POST
detect = r"""const h1=document.querySelector('.content h1');const p=h1&&h1.nextElementSibling;const lines=p&&p.tagName==='P'?p.innerHTML.split('\n').filter(l=>l.trim()):[];const ok=lines.length>1&&lines.every(l=>/^\s*<strong>[^<]+:<\/strong>/.test(l));const rows=ok?lines.map(l=>l.match(/^\s*<strong>([^<]+):<\/strong>\s*([\s\S]*)$/)):[];"""
V = {
 "A": ("", ""),
 "B": ('.md2doc-meta{display:grid;grid-template-columns:max-content 1fr;gap:4px 20px;background:#f6f8fa;border-radius:6px;padding:12px 16px;margin:16px 0 28px;font-size:.92em;line-height:1.55}'
       '.md2doc-meta dt{color:#57606a}.md2doc-meta dd{margin:0}',
       detect + r"""if(ok){const dl=document.createElement('dl');dl.className='md2doc-meta';rows.forEach(m=>{const dt=document.createElement('dt');dt.textContent=m[1];const dd=document.createElement('dd');dd.innerHTML=m[2];dl.append(dt,dd)});p.replaceWith(dl);}"""),
 "C": ("", detect + r"""if(ok){p.innerHTML=lines.join('<br>');}"""),
 "D": ("", detect + r"""if(ok){const t=document.createElement('table');t.innerHTML='<thead><tr><th>Item</th><th>Value</th></tr></thead><tbody>'+rows.map(m=>'<tr><td>'+m[1]+'</td><td>'+m[2]+'</td></tr>').join('')+'</tbody>';p.replaceWith(t);}"""),
}
shots=[]
for k,(css,js) in V.items():
    jj = JS + (';(()=>{' + js + '})()' if js else '')
    shots.append(dict(name=f"i12-desk-{k}", width=1440, height=900, css=BASE+css, js=jj, clip=dict(x=340, y=0, width=1100, height=560)))
    shots.append(dict(name=f"i12-mob-{k}", width=390, height=844, dpr=2, css=BASE+MOB_CSS+css, js=jj+';'+MOB_JS, postjs=MOB_POST, clip=dict(x=0, y=0, width=390, height=844)))
json.dump(dict(COMMON, outDir=os.getcwd()+"/shots", shots=shots), open('i12.json','w'))
E
FONTCONFIG_FILE=$S/fonts-sc.conf node variants.js i12.json 2>&1 | grep -v '^shot'; python3 -c "
from PIL import Image
s=Image.new('RGB',(4*560,2*290),'white')
for i,k in enumerate('ABCD'):
  s.paste(Image.open('$S/shots/i12-desk-'+k+'.png').resize((550,280)),(i*560,0))
  s.paste(Image.open('$S/shots/i12-mob-'+k+'.png').resize((195,422)).crop((0,0,195,280)),(i*560,290))
s.save('$S/peek12.png')"
```

```bash
S=/tmp/claude-1000/-home-user-hp-workspace-md2doc/cc552bfe-c005-4ece-b528-ad08d7b94e52/scratchpad; cd $S && python3 -c "
from PIL import Image
Image.open('shots/ref12-rfc.png').crop((140,0,900,520)).save('shots/ref12-rfc-c.png')
Image.open('shots/ref12-whatwg.png').crop((0,0,1440,180)).save('shots/ref12-whatwg-c.png')
Image.open('shots/ref12-ecma.png').crop((470,0,1440,260)).save('shots/ref12-ecma-c.png')
" && cat > i12-item.json <<'E'
{
  "n": 12, "slug": "i12", "short": "文件資訊區",
  "title": "文件開頭的 metadata",
  "intro": [
    "spec 開頭的 Document Type、Version、Status、Owner、Last Updated、RTL Top Module 六項，在原始檔裡是六行，但 markdown 把連續的行合併成同一段，所以輸出變成一整段擠在一起（A）。mac_top/docs 的 33 份 spec 裡有 24 份用這個寫法，來源是 paperwork 的 ip-spec 樣板。",
    "兩種修法：讓 md2doc 認得這個格式（B），或改原始檔／樣板（C、D）。B 的偵測規則是白名單：只有<strong>緊接在文件標題 H1 之後</strong>、而且<strong>每一行</strong>都以「<code>**欄位:**</code>」開頭的段落才會轉換，只要有一行不符合就完全不動。",
    "截圖已套用前面所有定案。"
  ],
  "options": [
    {"key": "A", "label": "現況：擠成一段", "desc": "六項資訊連成一段文字。"},
    {"key": "B", "label": "md2doc 自動排成兩欄", "rec": true, "desc": "md2doc 偵測到這個格式時，排成淡灰底的兩欄清單，左欄是欄位名、右欄是值。不用改任何原始檔，24 份既有 spec 立刻生效。參考：RFC 9293 開頭的文件資訊區塊。"},
    {"key": "C", "label": "改原始檔：每項一行", "desc": "原始檔每行結尾加反斜線 <code>\\</code>（markdown 的強制換行），md2doc 不改。要改 paperwork 樣板，並重新產生或手動修改既有的 24 份 spec。"},
    {"key": "D", "label": "改原始檔：markdown 表格", "desc": "原始檔改成兩欄表格，會套用第 3 項定案的表格樣式。markdown 表格必須有表頭，所以會多一列「Item / Value」。同樣要改樣板與既有 spec。"}
  ],
  "scenes": [
    {"id": "desk", "title": "桌面：文件開頭", "caption": "", "w": 1100, "h": 560},
    {"id": "mob", "title": "手機：文件開頭", "caption": "", "w": 780, "h": 1688, "maxw": 390}
  ],
  "refs_title": "參考：規格文件怎麼排開頭的文件資訊",
  "refs_intro": "2026-10-01 以 1440 寬開啟。",
  "refs": [
    {"img": "ref12-rfc-c.png", "title": "RFC 9293", "caption": "標題上方淡灰區塊裡，兩欄的「欄位：值」清單（Status、Obsoletes、Category、Published、Author⋯），每項一行。B 的參考。", "w": 760, "h": 520},
    {"img": "ref12-whatwg-c.png", "title": "WHATWG HTML Standard", "caption": "只在標題下放一行副標「Living Standard — Last Updated 日期」。", "w": 1440, "h": 180},
    {"img": "ref12-ecma-c.png", "title": "ECMA-262", "caption": "標題上方一行「Draft ECMA-262 / 日期」。", "w": 970, "h": 260}
  ],
  "recommend": "<p><strong>我推薦 B：md2doc 自動排成兩欄。</strong>理由：一、24 份既有 spec 不用重新產生或手改，下次轉換就生效；C、D 都要改 paperwork 樣板，再回頭處理已經產生的 spec。二、這六項是「欄位：值」的資料，兩欄清單最容易掃讀，和 RFC 的做法一致；D 的表格會多出無意義的「Item / Value」表頭。</p><p>第一輪我說「不在 renderer 修，因為猜格式可能把正常段落拆壞」。這個顧慮用白名單規則解決：必須緊接在 H1 之後、而且每一行都是「<code>**欄位:**</code>」開頭才轉換，誤判的機會很低。</p>",
  "notes": ["B 的偵測只看「H1 之後的第一段」，文件其他地方用同樣寫法的段落不受影響。"]
}
E
python3 build_item.py i12-item.json
```

```bash
S=/tmp/claude-1000/-home-user-hp-workspace-md2doc/cc552bfe-c005-4ece-b528-ad08d7b94e52/scratchpad; cd $S && cat >> decided.py <<'E'

# item 12 = B: metadata paragraph right after H1 (every line "**Key:** value") rendered as a two-column list
META_CSS = ('.md2doc-meta{display:grid;grid-template-columns:max-content 1fr;gap:4px 20px;background:#f6f8fa;border-radius:6px;padding:12px 16px;margin:16px 0 28px;font-size:.92em;line-height:1.55}'
            '.md2doc-meta dt{color:#57606a}.md2doc-meta dd{margin:0}')
META_JS = r"""(()=>{const h1=document.querySelector('.content h1');const p=h1&&h1.nextElementSibling;const lines=p&&p.tagName==='P'?p.innerHTML.split('\n').filter(l=>l.trim()):[];const ok=lines.length>1&&lines.every(l=>/^\s*<strong>[^<]+:<\/strong>/.test(l));if(!ok)return;const dl=document.createElement('dl');dl.className='md2doc-meta';lines.forEach(l=>{const m=l.match(/^\s*<strong>([^<]+):<\/strong>\s*([\s\S]*)$/);const dt=document.createElement('dt');dt.textContent=m[1];const dd=document.createElement('dd');dd.innerHTML=m[2];dl.append(dt,dd)});p.replaceWith(dl);})()"""
# item 11c bubble in its Auto state (contrast icon)
BUBBLE_CSS = ('.md2doc-theme.fab{position:fixed;right:20px;bottom:20px;z-index:101;width:44px;height:44px;border-radius:50%;background:#fff;border:1px solid #d0d7de;'
              'box-shadow:0 2px 10px rgba(0,0,0,.18);color:#1f2328;display:grid;place-items:center;cursor:pointer}')
BUBBLE_JS = r"""(()=>{const b=document.createElement('button');b.type='button';b.className='md2doc-theme fab';b.title='Theme: Auto (follows system)';b.innerHTML='<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M12 18a6 6 0 0 0 0-12v12z"/></svg>';document.body.appendChild(b);})()"""
FINAL_CSS = BASE + META_CSS + BUBBLE_CSS
FINAL_JS = JS + ';' + META_JS + ';' + BUBBLE_JS
E
python3 - <<'E'
import json, os, sys; sys.path.insert(0,'.')
from decided import FINAL_CSS, FINAL_JS, COMMON, SRC_HTML, MOB_CSS, MOB_JS, MOB_POST, GOTO_IFVR
SEARCH = r"""(()=>{const i=document.getElementById('doc-search-input');i.value='preempt';document.getElementById('doc-search-submit').click();})()"""
FSM = r"""(()=>{const m=document.querySelectorAll('.content .mermaid')[1];window.scrollTo(0,m.getBoundingClientRect().top+scrollY-160);})()"""
GV = r"""(()=>{const m=document.querySelectorAll('.content .graphviz')[0];window.scrollTo(0,m.getBoundingClientRect().top+scrollY-120);})()"""
scenes = [("top", None, None, False), ("ifvr", GOTO_IFVR, None, False), ("fsm", FSM, None, False), ("gv", GV, None, False), ("find", None, SEARCH, False), ("mtop", None, None, True), ("mifvr", GOTO_IFVR, None, True)]
shots = []
for k, html, css, js in [("A", SRC_HTML, "", ""), ("B", COMMON['html'], FINAL_CSS, FINAL_JS)]:
    for sid, post, extra, mob in scenes:
        jj = (js + (';' + MOB_JS if mob and js else '')) + (';' + extra if extra else '')
        s = dict(name=f"fin-{sid}-{k}", html=html, css=(css + (MOB_CSS if mob and css else '')), js=jj.strip(';') or None)
        if mob: s.update(width=390, height=844, dpr=2, clip=dict(x=0, y=0, width=390, height=844))
        else: s.update(width=1440, height=900, clip=dict(x=0, y=0, width=1440, height=900))
        pj = ';'.join(x for x in [post, MOB_POST if (mob and k == 'B') else None] if x)
        if pj: s['postjs'] = pj
        if not s['js']: s.pop('js')
        shots.append(s)
json.dump(dict(COMMON, outDir=os.getcwd()+"/shots", shots=shots), open('fin.json', 'w'))
print(len(shots))
E
FONTCONFIG_FILE=$S/fonts-sc.conf node variants.js fin.json 2>&1 | grep -v '^shot'; ls shots | grep -c '^fin-'
```

```bash
S=/tmp/claude-1000/-home-user-hp-workspace-md2doc/cc552bfe-c005-4ece-b528-ad08d7b94e52/scratchpad; cd $S && python3 - <<'E'
import json
d=json.load(open('fin.json'))
moon='<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z"/></svg>'
contrast='<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M12 18a6 6 0 0 0 0-12v12z"/></svg>'
out=[]
for s in d['shots']:
  if s['name'].endswith('-B'):
    t=dict(s); t['name']=s['name'][:-2]+'-Craw'
    t['js']=s['js'].replace(contrast.replace('"','\\"') if False else contrast, moon)
    t['boxes']={"graphviz":".content .graphviz svg"}
    out.append(t)
d['shots']=out; json.dump(d,open('fin-dark.json','w'))
print(sum(1 for s in out if moon in s['js']), len(out))
E
FONTCONFIG_FILE=$S/fonts-sc.conf node variants.js fin-dark.json 2>&1 | grep -v '^shot'; python3 - <<'E'
import json, glob
from PIL import Image
ns={}; exec(open('darkify.py').read().split('for name in')[0], ns)
for f in sorted(glob.glob('shots/fin-*-Craw.png')):
    im=Image.open(f).convert('RGB'); bx=json.load(open(f.replace('.png','.boxes.json')))
    out=ns['dark'](im)
    sc=2 if im.width==780 else 1
    for x,y,w,h in bx.get('graphviz',[]):
        pad=12; box=(max(0,(x-pad)*sc),max(0,(y-pad)*sc),min(im.width,(x+w+pad)*sc),min(im.height,(y+h+pad)*sc))
        out.paste(im.crop(box),box[:2])
    out.save(f.replace('-Craw.png','-C.png'))
print('ok')
E
python3 -c "
from PIL import Image
s=Image.new('RGB',(3*480,2*300),'white')
for i,k in enumerate('ABC'):
  s.paste(Image.open('$S/shots/fin-top-'+k+'.png').convert('RGB').resize((480,300)),(i*480,0))
  s.paste(Image.open('$S/shots/fin-gv-'+k+'.png').convert('RGB').resize((480,300)),(i*480,300))
s.save('$S/peekfin.png')"
```

```bash
S=/tmp/claude-1000/-home-user-hp-workspace-md2doc/cc552bfe-c005-4ece-b528-ad08d7b94e52/scratchpad; cd $S && python3 - <<'E'
import json
U='https://claude.ai/artifact/'
rows=[
 ('1','內文行寬','A 維持現況（不設上限）','—','UYqkAyHA1ENjnh2cX5L6uS'),
 ('2','中文字型','字型堆疊補上正黑體／PingFang TC／Noto Sans TC；<code>lang</code> 依內容偵測＋<code>--lang</code> 覆寫','實測字型後備','TEd7PwCEmJnLgrLJTjLbx5'),
 ('3','表格','靠上對齊＋只留橫線＋無斑馬紋＋等寬數字','datasheet pin table','5UejUcNE6V6h5UxJNucMZp'),
 ('4','標題層級','H3 1.3em／H4 1.1em，上寬下窄間距，章節號同色、號碼後加寬空隙','WHATWG、RFC、ECMA-262','Rje7gKRVnnR8utaUtexWMi'),
 ('5','圖表配色','mermaid 文件藍（base 主題）＋字型一致＋白底標籤；graphviz 預設 Times 換無襯線','Material for MkDocs','KmAbBeQEBgp7wUfcgaXZpy'),
 ('6','手機選單','44px 頂列（☰＋目前章節）；修抽屜陰影外漏；抽屜從頂列下方打開','MkDocs、Docusaurus、MDN、GitHub Docs','55WWLKp7KCbyDTCYfhJ1Ez'),
 ('6b','標題錨點','手機也隱藏 #','MkDocs、Docusaurus','FPvyFpLRtrJ143HfxaEGcV'),
 ('7+8','側欄整體','單一灰色面板＋Contents 標題列＋無框線圖示＋整條路徑加粗取代麵包屑＋單行右緣漸隱；搜尋列全寬；藍＝目前位置、黃＝搜尋命中','ECMA-262','VF4ENYtENEbRtiNjzTgDAq'),
 ('9','訊號名樣式','行內 code 無底色＋橘紅字 <code>#b93a0c</code>','WHATWG','9qJ4u19TMucWLZ7bQdGLc2'),
 ('9b','code 字級','0.92em','Docusaurus（0.90）','4Bhj6czwZbhXyiE61aqii1'),
 ('10','鍵盤焦點','文件藍 2px 焦點框；隱藏的 Search／Clear 移出 Tab 順序','GitHub Docs','GQm2NzT6foxFhU5AQrar3K'),
 ('11','深色模式','跟隨系統；mermaid 深色重畫，graphviz／draw.io／WaveDrom 白底板','Docusaurus','KCoV3NQPuRwKxomDqiS7oB'),
 ('11b','切換位置','右下角懸浮泡泡','（你的選擇，參考網站皆放頂列）','1w2GPRgx83NQx5n1Yk7WTd'),
 ('11c','泡泡符號','◐ Auto／☀ Light／☾ Dark，點一下循環，記在瀏覽器','Docusaurus','ND9jqYygHBFvC2ffsdZrvK'),
 ('12','文件資訊區','H1 後「每行皆 **欄位:**」的段落自動排成兩欄（白名單偵測）','RFC 9293','T64Xjyj9yREFHWGCc7nvm7'),
]
tbl='<div class="cmpwrap"><table class="cmp"><thead><tr><th>#</th><th>項目</th><th>定案</th><th>參考</th><th>比較頁</th></tr></thead><tbody>'+''.join(f'<tr><td>{n}</td><td>{t}</td><td>{d}</td><td>{r}</td><td><a href="{U}{u}">開啟</a></td></tr>' for n,t,d,r,u in rows)+'</tbody></table></div>'
todo=('<div class="col"><h2 style="margin-top:18px">實作時要一併處理</h2><ul class="notes" style="color:inherit">'
 '<li><code>test/md2doc.test.js:209</code> 的斑馬紋 override 斷言要隨第 3 項遷移。</li>'
 '<li>TOC 保留單行，<code>test/reader-panels.test.js:51–52</code> 不用改。</li>'
 '<li>CSS 在 template literal 裡：改完要渲染真實文件確認，並比對反引號數量（CLAUDE.md 的規則）。</li>'
 '<li>深色模式要把 <code>&lt;style&gt;</code> 裡寫死的顏色改成變數，含編輯模式。</li>'
 '<li>搜尋框改用內建 ✕ 清除時，要確認它會一併清掉搜尋結果。</li>'
 '</ul><h2 style="margin-top:18px">新發現、尚未討論</h2><ul class="notes" style="color:inherit">'
 '<li>手機上的介面表：Description 欄被擠到畫面外，每一列變得非常高，要橫向捲動才看得到描述（場景 7 看得到）。</li>'
 '<li>graphviz 的 12. Internal Architecture 圖有多處標籤互相壓到，是 dot 排版造成，和配色無關。</li>'
 '</ul></div>')
item={
 "n":"總覽","slug":"fin","short":"定案總覽","title":"md2doc 版面審查：定案總覽",
 "intro":["12 項全部定案，下表是每一項的決定、依據的參考，以及當時的比較頁。下面的對照截圖把所有決定同時套上去：A 是現況，B 是定案後的淺色，C 是定案後的深色（模擬，泡泡顯示 Dark 狀態）。", tbl, todo],
 "options":[{"key":"A","label":"現況","desc":"v3.7.0 目前的輸出。"},{"key":"B","label":"定案（淺色）","rec":False,"desc":"套用全部 12 項決定，泡泡顯示 Auto 狀態。"},{"key":"C","label":"定案（深色，模擬）","desc":"同 B，以影像處理模擬深色；mermaid 跟著變深，graphviz 保留白底板。實作時會另外設計深色配色。"}],
 "scenes":[
  {"id":"top","title":"文件開頭","caption":"文件資訊區、Revision History、側欄。","w":1440,"h":900},
  {"id":"ifvr","title":"閱讀中：IF-VR-01","caption":"側欄目前位置、表格、訊號名。","w":1440,"h":900},
  {"id":"fsm","title":"mermaid 狀態機","caption":"","w":1440,"h":900},
  {"id":"gv","title":"graphviz 方塊圖","caption":"","w":1440,"h":900},
  {"id":"find","title":"搜尋「preempt」","caption":"","w":1440,"h":900},
  {"id":"mtop","title":"手機：文件開頭","caption":"","w":780,"h":1688,"maxw":390},
  {"id":"mifvr","title":"手機：IF-VR-01","caption":"介面表在手機上的列高問題（見「新發現」）。","w":780,"h":1688,"maxw":390}],
 "recommend":"<p>下一步：把以上決定寫成實作計畫，依影響範圍分批實作（CSS 類 → renderer 輸出類 → 深色模式），每批跑完整測試並渲染真實 spec 確認。</p>",
 "notes":["截圖中的 A 是在 Linux Chromium 裡掛 Windows 字型拍的，中文後備字型是微軟雅黑；你的 Windows Chrome 實際可能是正黑體（見第 2 項）。"]}
json.dump(item,open('fin-item.json','w'),ensure_ascii=False)
E
python3 build_item.py fin-item.json
```

```bash
S=/tmp/claude-1000/-home-user-hp-workspace-md2doc/cc552bfe-c005-4ece-b528-ad08d7b94e52/scratchpad; cd $S && sed -i 's/"short": "定案總覽"/"short": "定案"/' fin-item.json && python3 build_item.py fin-item.json >/dev/null && grep -o '<title>[^<]*' review/fin/fin.html
```

```bash
S=/tmp/claude-1000/-home-user-hp-workspace-md2doc/cc552bfe-c005-4ece-b528-ad08d7b94e52/scratchpad; cat > $S/refs13.js <<'E'
const puppeteer = require('/home/user/hp_workspace/md2doc/node_modules/puppeteer');
const sites = [
  ['ghdocs','https://docs.github.com/en/actions/reference/workflows-and-actions/contexts'],
  ['mdn','https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Elements/input'],
  ['docusaurus','https://docusaurus.io/docs/api/docusaurus-config'],
  ['mkdocs','https://squidfunk.github.io/mkdocs-material/reference/data-tables/'],
  ['github','https://github.com/microsoft/vscode/blob/main/CONTRIBUTING.md'],
];
(async () => {
  const b = await puppeteer.launch({ args: ['--no-sandbox'] });
  for (const [id, url] of sites) {
    const ctx = await b.createBrowserContext(); const p = await ctx.newPage();
    await p.setViewport({ width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
    await p.goto(url, { waitUntil: 'networkidle2', timeout: 60000 }).catch(e => console.log(id, e.message));
    await new Promise(r => setTimeout(r, 2500));
    const r = await p.evaluate(() => {
      const ts = [...document.querySelectorAll('main table, article table, .markdown-body table, table')].filter(t => t.getBoundingClientRect().width > 0 && t.querySelectorAll('tr').length > 2);
      if (!ts.length) return null;
      const t = ts.sort((a, b) => b.scrollWidth - a.scrollWidth)[0];
      t.scrollIntoView({ block: 'start' }); window.scrollBy(0, -60);
      const cs = getComputedStyle(t); let sc = t; while (sc && sc !== document.body && !/(auto|scroll)/.test(getComputedStyle(sc).overflowX)) sc = sc.parentElement;
      const row = t.querySelector('tbody tr') || t.querySelectorAll('tr')[1];
      const tds = [...row.children].map(c => Math.round(c.getBoundingClientRect().width));
      const hs = [...t.querySelectorAll('tbody tr')].slice(0, 6).map(r => Math.round(r.getBoundingClientRect().height));
      return { display: cs.display, width: cs.width, tableW: Math.round(t.getBoundingClientRect().width), contentW: t.scrollWidth, scroller: sc ? sc.tagName + '.' + String(sc.className).slice(0, 30) : '-', colW: tds, rowH: hs, ws: getComputedStyle(row.children[row.children.length - 1]).whiteSpace, minW: getComputedStyle(row.children[row.children.length - 1]).minWidth };
    });
    console.log(id, JSON.stringify(r));
    await new Promise(r => setTimeout(r, 600));
    await p.screenshot({ path: `${process.argv[2]}/shots/ref13-${id}.png` });
    await ctx.close();
  }
  await b.close();
})();
E
cd /home/user/hp_workspace/md2doc && FONTCONFIG_FILE=$S/fonts-sc.conf timeout 400 node $S/refs13.js $S
```

```bash
S=/tmp/claude-1000/-home-user-hp-workspace-md2doc/cc552bfe-c005-4ece-b528-ad08d7b94e52/scratchpad; cd $S && python3 - <<'E'
import json, os, sys; sys.path.insert(0,'.')
from decided import FINAL_CSS, FINAL_JS, COMMON, MOB_CSS, MOB_JS, MOB_POST
M = '@media (max-width:1080px){%s}'
V = {
 "A": ("", ""),
 "B": (M % '.content table td.cell-prose,.content table th.cell-prose{min-width:15em}', ""),
 "C": (M % '.content table td,.content table th,.content table td.cell-narrow,.content table th.cell-narrow{white-space:normal !important}.content table td code,.content table th code{white-space:normal !important;overflow-wrap:anywhere}.content table{overflow-x:visible}', ""),
 "D": (M % ('.content table.md2doc-cards,.md2doc-cards tbody,.md2doc-cards tr,.md2doc-cards td{display:block !important;width:auto !important}'
            '.md2doc-cards thead,.md2doc-cards colgroup{display:none !important}'
            '.md2doc-cards tr{border:1px solid #d8dee4;border-radius:8px;margin:0 0 10px;padding:8px 12px;background:#fff !important}'
            '.md2doc-cards td{border:none !important;padding:2px 0 !important;white-space:normal !important;position:static !important;background:none !important}'
            '.md2doc-cards td::before{content:attr(data-label);display:block;font-size:.76em;color:#6a737d;font-weight:600;margin-top:4px}'),
       r"""(()=>{document.querySelectorAll('.content table').forEach(t=>{const hs=[...t.querySelectorAll('thead th')].map(th=>th.textContent.trim());if(!hs.length)return;t.classList.add('md2doc-cards');t.querySelectorAll('tbody tr').forEach(tr=>[...tr.children].forEach((td,i)=>td.setAttribute('data-label',hs[i]||'')));});})()"""),
}
def go(text, off=70): return r"""(()=>{const h=[...document.querySelectorAll('.content h1,.content h2,.content h3,.content h4')].find(h=>h.textContent.includes(%s));window.scrollTo(0,h.getBoundingClientRect().top+scrollY-%d);})()""" % (json.dumps(text), off)
RIGHT = r"""(()=>{const h=[...document.querySelectorAll('.content h3')].find(h=>h.textContent.includes('IF-VR-01'));let t=h.nextElementSibling;while(t&&t.tagName!=='TABLE')t=t.nextElementSibling;t.scrollLeft=260;})()"""
scenes = [("ifvr", go('IF-VR-01'), None), ("ifvrR", go('IF-VR-01'), RIGHT), ("rev", go('Revision History'), None), ("err", go('Exception and Error Handling'), None)]
shots = []
for k, (css, js) in V.items():
    for sid, g, extra in scenes:
        post = ';'.join(x for x in [g, extra, MOB_POST] if x)
        shots.append(dict(name=f"i13-{sid}-{k}", width=390, height=844, dpr=2, css=FINAL_CSS+MOB_CSS+css, js=FINAL_JS+';'+MOB_JS+(';'+js if js else ''), postjs=post, clip=dict(x=0, y=0, width=390, height=844)))
json.dump(dict(COMMON, outDir=os.getcwd()+"/shots", shots=shots), open('i13.json','w'))
E
FONTCONFIG_FILE=$S/fonts-sc.conf node variants.js i13.json 2>&1 | grep -v '^shot'; python3 -c "
from PIL import Image
s=Image.new('RGB',(4*400,2*850),'white')
for i,k in enumerate('ABCD'):
  s.paste(Image.open('$S/shots/i13-ifvr-'+k+'.png').resize((390,844)),(i*400,0))
  s.paste(Image.open('$S/shots/i13-ifvrR-'+k+'.png').resize((390,844)),(i*400,850))
s.resize((1200,1275)).save('$S/peek13.png')"
```

```bash
S=/tmp/claude-1000/-home-user-hp-workspace-md2doc/cc552bfe-c005-4ece-b528-ad08d7b94e52/scratchpad; cd $S && sed -i 's/getBoundingClientRect().top+scrollY-70);/getBoundingClientRect().top+scrollY-56);/g' i13.json && grep -c 'scrollY-56' i13.json && FONTCONFIG_FILE=$S/fonts-sc.conf node variants.js i13.json 2>&1 | grep -v '^shot'; python3 -c "
from PIL import Image
Image.open('$S/shots/i13-ifvr-B.png').resize((390,844)).crop((0,0,390,120)).save('$S/peek13b.png')"
```

```bash
S=/tmp/claude-1000/-home-user-hp-workspace-md2doc/cc552bfe-c005-4ece-b528-ad08d7b94e52/scratchpad; cd $S && python3 -c "
from PIL import Image
for k in ['ghdocs','mdn','docusaurus']:
  Image.open('shots/ref13-'+k+'.png').crop((0,0,780,1200)).save('shots/ref13-'+k+'-c.png')
" && cat > i13-item.json <<'E'
{
  "n": 13, "slug": "i13", "short": "手機寬表格",
  "title": "手機上的寬表格",
  "intro": [
    "審查中發現的新問題。原因已量測：手機上表格框寬 342px，內容卻要 528px。前四欄（Signal、Dir、Width、Clock）是不換行的窄欄，依最長的內容撐開（Signal 被 <code>rg_verify_status[2:0]</code> 撐到 188px），最後的 Description 只剩 103px，一段描述被折成十幾行，每列 238px 高。現況等於「要橫向捲動」和「說明被壓扁」兩個缺點同時存在。",
    "參考網站（2026-10-01，390 寬手機實測）分兩派：<strong>GitHub Docs</strong> 把表格壓進螢幕寬、全部換行（每列 180–270px 高，不用橫向捲動）；<strong>MDN</strong> 讓表格保持 724px 寬、說明欄 619px，放在可橫向捲動的容器裡；<strong>Docusaurus</strong> 讓每欄依內容展開到 817px，同樣橫向捲動。",
    "只影響 1080px 以下的寬度，桌面版不變。截圖已套用所有定案（含手機頂列、深色模式泡泡的 Auto 狀態）。"
  ],
  "options": [
    {"key": "A", "label": "現況", "desc": "窄欄不換行、說明欄被壓到 103px。"},
    {"key": "B", "label": "說明欄最小 15em＋橫向捲動", "rec": true, "desc": "說明欄至少 15em（約 225px），表格變寬、可橫向捲動，每列只剩 2–4 行。往右捲時，md2doc 既有的 sticky 第一欄讓訊號名固定在左邊。參考：MDN、Docusaurus。"},
    {"key": "C", "label": "全部換行、塞進螢幕寬", "desc": "所有欄都允許換行，表格不超過螢幕寬、不用橫向捲動。參考：GitHub Docs。代價是訊號名會被從中間折斷（<code>rg_ve / rify_ / statu…</code>）。"},
    {"key": "D", "label": "每列變成一張卡片", "desc": "手機上每一列排成一張卡片，欄名當小標。每格都完整可讀，但表格變長約三倍，也無法上下比對同一欄。這次實測的文件網站沒有這樣做。"}
  ],
  "scenes": [
    {"id": "ifvr", "title": "IF-VR-01 介面表", "caption": "", "w": 780, "h": 1688, "maxw": 390},
    {"id": "ifvrR", "title": "同一張表往右捲 260px", "caption": "A、B 的 Signal 欄固定在左邊（sticky），右邊是說明欄。", "w": 780, "h": 1688, "maxw": 390},
    {"id": "rev", "title": "Revision History", "caption": "", "w": 780, "h": 1688, "maxw": 390},
    {"id": "err", "title": "9. Exception and Error Handling（四欄都是長文字）", "caption": "", "w": 780, "h": 1688, "maxw": 390}
  ],
  "refs_title": "參考：手機上的寬表格",
  "refs_intro": "2026-10-01 以 390 寬手機模擬開啟，捲到頁面上最寬的那張表。",
  "refs": [
    {"img": "ref13-mdn-c.png", "title": "MDN", "caption": "表格 724px 寬放在可橫向捲動的容器裡，說明欄 619px，B 的參考。", "w": 390, "h": 600},
    {"img": "ref13-docusaurus-c.png", "title": "Docusaurus", "caption": "表格依內容展開到 817px，橫向捲動。", "w": 390, "h": 600},
    {"img": "ref13-ghdocs-c.png", "title": "GitHub Docs", "caption": "表格壓進 358px、三欄平均、全部換行，C 的參考。", "w": 390, "h": 600}
  ],
  "recommend": "<p><strong>我推薦 B：說明欄最小 15em＋橫向捲動。</strong>理由：一、訊號名是工程師要複製、搜尋的關鍵字，B 保持訊號名完整不折斷，C 會把 <code>rg_verify_status[2:0]</code> 折成四段；二、md2doc 本來就有 sticky 第一欄，往右捲看說明時訊號名一直留在左邊，橫向捲動的代價很低，每列也從十幾行降到 2–4 行。D 雖然每格都完整，但表格長度變三倍，又失去上下比對同一欄的能力，對動輒十幾列的訊號表不划算。</p>",
  "notes": ["B 只是一條 CSS 規則（窄螢幕下 <code>td.cell-prose</code> 加 <code>min-width</code>），不影響 <code>classifyColumns</code> 的欄寬判斷。"]
}
E
python3 build_item.py i13-item.json
```

```bash
S=/tmp/claude-1000/-home-user-hp-workspace-md2doc/cc552bfe-c005-4ece-b528-ad08d7b94e52/scratchpad; cd $S && sed -e "s#t.scrollIntoView({ block: 'start' }); window.scrollBy(0, -60);#document.documentElement.style.scrollBehavior='auto'; window.scrollTo({ top: t.getBoundingClientRect().top + scrollY - 70, behavior: 'instant' });#" -e "s#await new Promise(r => setTimeout(r, 600));#await new Promise(r => setTimeout(r, 2000));#" -e "s#^  \['docusaurus'.*##" -e "s#^  \['mkdocs'.*##" -e "s#^  \['github'.*##" refs13.js > refs13b.js && grep -c "behavior: 'instant'" refs13b.js && cd /home/user/hp_workspace/md2doc && FONTCONFIG_FILE=$S/fonts-sc.conf timeout 300 node $S/refs13b.js $S && cd $S && python3 -c "
from PIL import Image
for k in ['ghdocs','mdn']:
  Image.open('shots/ref13-'+k+'.png').crop((0,0,780,1200)).save('shots/ref13-'+k+'-c.png')
s=Image.new('RGB',(800,600),'white')
for i,k in enumerate(['mdn','ghdocs']): s.paste(Image.open('shots/ref13-'+k+'-c.png').resize((390,600)),(i*400,0))
s.save('peek13r.png')"
```

```bash
S=/tmp/claude-1000/-home-user-hp-workspace-md2doc/cc552bfe-c005-4ece-b528-ad08d7b94e52/scratchpad; cd $S && cat >> decided.py <<'E'

# item 13 = B: on narrow screens the prose column keeps at least 15em and the table scrolls (sticky first column already exists)
NARROW_TABLE_CSS = '@media (max-width:1080px){.content table td.cell-prose,.content table th.cell-prose{min-width:15em}}'
FINAL_CSS = FINAL_CSS + NARROW_TABLE_CSS
E
python3 - <<'E'
import json, sys; sys.path.insert(0,'.')
import importlib, decided
for f in ['fin.json','fin-dark.json']:
    d=json.load(open(f))
    for s in d['shots']:
        if s['name'].startswith(('fin-mtop-','fin-mifvr-')) and not s['name'].endswith('-A') and decided.NARROW_TABLE_CSS not in s['css']:
            s['css']+=decided.NARROW_TABLE_CSS
    json.dump(d,open(f,'w'))
E
FONTCONFIG_FILE=$S/fonts-sc.conf node variants.js fin.json 'fin-m.*-B' 2>&1 | grep -v '^shot'; FONTCONFIG_FILE=$S/fonts-sc.conf node variants.js fin-dark.json 'fin-m' 2>&1 | grep -v '^shot'; python3 - <<'E'
import json, glob
from PIL import Image
ns={}; exec(open('darkify.py').read().split('for name in')[0], ns)
for f in sorted(glob.glob('shots/fin-m*-Craw.png')):
    ns['dark'](Image.open(f)).save(f.replace('-Craw.png','-C.png'))
d=json.load(open('fin-item.json'))
d['intro'][1]=d['intro'][1].replace('</tbody></table></div>','<tr><td>13</td><td>手機寬表格</td><td>窄螢幕下說明欄最小 15em，表格橫向捲動（sticky 第一欄保留訊號名）</td><td>MDN、Docusaurus</td><td><a href="https://claude.ai/artifact/TvTNwcTpi9dyJXL3cvpXS8">開啟</a></td></tr></tbody></table></div>')
d['intro'][2]=d['intro'][2].replace('<li>手機上的介面表：Description 欄被擠到畫面外，每一列變得非常高，要橫向捲動才看得到描述（場景 7 看得到）。</li>','')
d['intro'][0]=d['intro'][0].replace('12 項全部定案','13 項全部定案（第 13 項是審查中新發現的手機寬表格）')
d['title']='md2doc 版面審查：定案總覽'
for sc in d['scenes']:
    if sc['id']=='mifvr': sc['caption']='介面表：B、C 已套用第 13 項（說明欄最小 15em，可橫向捲動）。'
json.dump(d,open('fin-item.json','w'),ensure_ascii=False)
E
python3 build_item.py fin-item.json >/dev/null && grep -c 'TvTNwcTpi9dyJXL3cvpXS8' review/fin/fin.html
```

```bash
S=/tmp/claude-1000/-home-user-hp-workspace-md2doc/cc552bfe-c005-4ece-b528-ad08d7b94e52/scratchpad/cur; mkdir -p $S && cd $S && for f in col_resize hand_grab hand_grabbing zoom_in; do curl -sf "https://chromium.googlesource.com/chromium/src/+/refs/heads/main/ui/resources/cursors/$f.cur?format=TEXT" | base64 -d > $f.cur; done; ls -la; for f in ew move link; do cp /mnt/c/Users/heping.li/AppData/Local/Microsoft/Windows/Cursors/${f}_eoa.cur .; done; python3 -c "
from PIL import Image
import glob
for f in sorted(glob.glob('*.cur')):
    im=Image.open(f); print(f, im.format, im.size, getattr(im,'info',{}).get('sizes'), im.mode)
"
```

```bash
S=/tmp/claude-1000/-home-user-hp-workspace-md2doc/21ed517f-03d4-42bc-9214-e92fa099fdbe/scratchpad/e1; cd /home/user/hp_workspace/md2doc && node bin/md2doc.js --edit --no-open --port 47123 $S/doc/mac-tx-core.md > $S/server.log 2>&1
```

```bash
sleep 4; cat /tmp/claude-1000/-home-user-hp-workspace-md2doc/21ed517f-03d4-42bc-9214-e92fa099fdbe/scratchpad/e1/server.log | head -5; curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:47123/
```

```bash
S=/tmp/claude-1000/-home-user-hp-workspace-md2doc/21ed517f-03d4-42bc-9214-e92fa099fdbe/scratchpad/e1; cd $S && cat > cur.js <<'EOF'
const { chromium } = require('/home/user/hp_workspace/md2doc/node_modules/playwright');
(async () => {
  const b = await chromium.launch(); const errs = [];
  const p = await (await b.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
  p.on('pageerror', (e) => errs.push(e.message));
  await p.goto('http://127.0.0.1:47123/edit/0', { waitUntil: 'load' }); await p.waitForTimeout(3500);
  await p.screenshot({ path: 'cur-rest.png' });
  // a plain paragraph in section 1
  const para = await p.evaluateHandle(() => [...document.querySelectorAll('.ed-block[data-block-type="paragraph"]')].find((b) => b.textContent.length > 120 && b.getBoundingClientRect().top > 200));
  await para.evaluate((e) => e.scrollIntoView({ block: 'center' })); await p.waitForTimeout(300);
  const r = await para.evaluate((e) => { const x = e.getBoundingClientRect(); return { x: x.left + 40, y: x.top + 10 }; });
  await p.mouse.move(r.x, r.y); await p.waitForTimeout(400);
  await p.screenshot({ path: 'cur-hover.png' });
  const h = await para.evaluate((e) => { const k = e.querySelector('.ed-handle'); const x = k.getBoundingClientRect(); return { x: x.left + x.width / 2, y: x.top + x.height / 2 }; });
  await p.mouse.click(h.x, h.y); await p.waitForTimeout(400);
  const conv = await p.$('.ed-handle-menu [data-action="convert"], .ed-handle-menu button');
  if (conv) { await conv.hover(); await p.waitForTimeout(400); }
  await p.screenshot({ path: 'cur-handlemenu.png' });
  await p.keyboard.press('Escape'); await p.waitForTimeout(300);
  await p.mouse.move(r.x, r.y); await p.waitForTimeout(300);
  const ins = await para.evaluate((e) => { const k = e.querySelector('.ed-insert'); if (!k) return null; const x = k.getBoundingClientRect(); return { x: x.left + x.width / 2, y: x.top + x.height / 2 }; });
  if (ins) { await p.mouse.click(ins.x, ins.y); await p.waitForTimeout(400); await p.screenshot({ path: 'cur-insert.png' }); await p.keyboard.press('Escape'); }
  // selection toolbar: double-click a word in the paragraph
  await p.mouse.dblclick(r.x + 60, r.y + 4); await p.waitForTimeout(500);
  await p.screenshot({ path: 'cur-seltb.png' });
  await p.keyboard.press('Escape'); await p.waitForTimeout(300);
  // heading menu on toolbar
  const hb = await p.$('.ed-toolbar [data-ed-tb-action="heading"], .ed-toolbar button[aria-haspopup]');
  if (hb) { await hb.click(); await p.waitForTimeout(400); await p.screenshot({ path: 'cur-toolbarmenu.png', clip: { x: 0, y: 0, width: 1440, height: 360 } }); await p.keyboard.press('Escape'); }
  // table: hover near a row boundary to show grips and insert bubbles
  const t = await p.evaluateHandle(() => [...document.querySelectorAll('.content table')].find((x) => x.rows.length > 3));
  await t.evaluate((e) => e.scrollIntoView({ block: 'center' })); await p.waitForTimeout(300);
  const tr = await t.evaluate((e) => { const c = e.rows[2].cells[1].getBoundingClientRect(); return { x: c.left + 20, y: c.top + c.height / 2, by: c.bottom }; });
  await p.mouse.move(tr.x, tr.y); await p.waitForTimeout(300); await p.mouse.move(tr.x, tr.by - 1); await p.waitForTimeout(500);
  await p.screenshot({ path: 'cur-table.png' });
  // code block raw editor
  const code = await p.evaluateHandle(() => [...document.querySelectorAll('.ed-block')].find((b) => b.querySelector('pre code')));
  if (code) { await code.evaluate((e) => e.scrollIntoView({ block: 'center' })); await p.waitForTimeout(300); await code.click(); await p.waitForTimeout(600); await p.screenshot({ path: 'cur-raw.png' }); await p.keyboard.press('Escape'); }
  console.log('errors', errs.length ? errs : 'none');
  await b.close();
})();
EOF
FONTCONFIG_FILE=$S/fonts.conf node cur.js && ls cur-*.png
```

```bash
S=/tmp/claude-1000/-home-user-hp-workspace-md2doc/21ed517f-03d4-42bc-9214-e92fa099fdbe/scratchpad/e1; cd $S && python3 -c "
from PIL import Image
fs=['cur-rest.png','cur-hover.png','cur-handlemenu.png','cur-insert.png','cur-seltb.png','cur-table.png']
ims=[Image.open(f).convert('RGB').resize((720,450)) for f in fs]
s=Image.new('RGB',(1440,1350),(60,60,60))
for i,im in enumerate(ims): s.paste(im,((i%2)*720,(i//2)*450))
s.save('cur-sheet.png')"
```

```bash
S=/tmp/claude-1000/-home-user-hp-workspace-md2doc/21ed517f-03d4-42bc-9214-e92fa099fdbe/scratchpad/e1; mkdir -p $S/lucide && cd $S/lucide && ok=0; for n in save undo-2 redo-2 heading quote code list list-ordered list-checks bold italic strikethrough underline link indent-decrease indent-increase table arrow-up-to-line arrow-down-to-line minus image panel-left file-code-2 pilcrow heading-1 heading-2 heading-3 grip-vertical plus copy trash-2 file-text repeat check circle-dot cloud-check pencil-line; do curl -sf "https://unpkg.com/lucide-static@0.469.0/icons/$n.svg" -o $n.svg && ok=$((ok+1)) || echo "miss $n"; done; echo "got $ok"; head -c 300 bold.svg
```

```bash
S=/tmp/claude-1000/-home-user-hp-workspace-md2doc/21ed517f-03d4-42bc-9214-e92fa099fdbe/scratchpad/e1; cd $S && cat > directions.js <<'EOF'
// Prototype-only: CSS + icon swaps for E1 directions, injected into the live editor page.
const fs = require('fs');
const ico = (n) => fs.readFileSync(__dirname + '/lucide/' + n + '.svg', 'utf8').replace(/<!--[^>]*-->/, '').trim();
const ICONS = { save: 'save', undo: 'undo-2', redo: 'redo-2', headings: 'heading', quote: 'quote', code: 'code', list: 'list',
  'ordered-list': 'list-ordered', check: 'list-checks', bold: 'bold', italic: 'italic', strike: 'strikethrough', 'inline-code': 'code',
  link: 'link', outdent: 'indent-decrease', indent: 'indent-increase', table: 'table', 'insert-before': 'arrow-up-to-line',
  'insert-after': 'arrow-down-to-line', line: 'minus', image: 'image', outline: 'panel-left', preview: 'file-code-2' };
const svgMap = {}; for (const k in ICONS) svgMap[k] = ico(ICONS[k]);
const extra = { grip: ico('grip-vertical'), plus: ico('plus'), check: ico('check') };
const PAPER = `
:root{--e-surface:#ffffff;--e-ring:0 0 0 1px rgba(31,35,40,.12),0 8px 24px rgba(31,35,40,.10);--e-ink:#1f2328;--e-mut:#57606a;
  --e-hover:#f3f5f7;--e-active-bg:#dbe6f3;--e-active-fg:#0550ae;--e-accent:#0969da;--e-rule:#d8dee4}
.ed-toolbar{background:var(--e-surface)!important;border-bottom:1px solid var(--e-rule)!important;box-shadow:none!important;border-radius:0!important}
.ed-toolbar-btn{background:transparent!important;border:0!important;color:var(--e-mut)!important;width:32px!important;height:32px!important;border-radius:6px!important;display:inline-grid!important;place-items:center!important;padding:0!important}
.ed-toolbar-btn:hover{background:var(--e-hover)!important;color:var(--e-ink)!important}
.ed-toolbar-btn[aria-pressed="true"]{background:var(--e-active-bg)!important;color:var(--e-active-fg)!important}
.ed-toolbar-btn svg{width:18px;height:18px;stroke-width:1.75}
.ed-toolbar-sep{background:var(--e-rule)!important;height:20px!important;width:1px!important;margin:0 8px!important}
.ed-toolbar-status{color:var(--e-mut)!important;background:transparent!important}
.ed-handle-menu,.ed-insert-menu,.ed-seltb,.ed-te-menu,.ed-toolbar-menu{background:var(--e-surface)!important;color:var(--e-ink)!important;box-shadow:var(--e-ring)!important;border:0!important;border-radius:8px!important;backdrop-filter:none!important}
.ed-handle-menu-btn,.ed-insert-menu-btn,.ed-seltb-btn,.ed-toolbar-menu-btn,.ed-te-menu button{background:transparent!important;color:var(--e-ink)!important;border:0!important;border-radius:6px!important}
.ed-handle-menu-btn:hover,.ed-insert-menu-btn:hover,.ed-seltb-btn:hover,.ed-toolbar-menu-btn:hover,.ed-te-menu button:hover{background:var(--e-hover)!important}
.ed-seltb-btn[aria-pressed="true"]{background:var(--e-active-bg)!important;color:var(--e-active-fg)!important}
.ed-handle-menu svg,.ed-insert-menu svg{color:var(--e-mut)!important}
.ed-handle,.ed-insert{background:transparent!important;color:#8c959f!important;border-radius:4px!important}
.ed-handle:hover,.ed-insert:hover{background:#e8edf2!important;color:var(--e-ink)!important}
.ed-block:hover{outline:none!important}
.ed-wys-armed:focus{outline:2px solid var(--e-accent)!important;outline-offset:2px}
.ed-selected{background:rgba(9,105,218,.10)!important}
`;
const IMMERSIVE = PAPER + `
.ed-toolbar{left:auto!important;right:16px!important;top:12px!important;width:auto!important;height:40px!important;border:0!important;border-radius:10px!important;box-shadow:var(--e-ring)!important;padding:0 4px!important}
.ed-toolbar .ed-toolbar-btn:not([data-ed-tb="undo"]):not([data-ed-tb="redo"]):not([data-ed-tb="preview"]):not([data-ed-tb="outline"]){display:none!important}
.ed-toolbar .ed-toolbar-sep{display:none!important}
.ed-toolbar-status{position:static!important}
`;
function apply(dir) {
  return [dir === 'B' ? PAPER : IMMERSIVE, svgMap, extra];
}
module.exports = { apply };
EOF
echo ok
```

```bash
S=/tmp/claude-1000/-home-user-hp-workspace-md2doc/21ed517f-03d4-42bc-9214-e92fa099fdbe/scratchpad/e1; cd /home/user/hp_workspace/md2doc && grep -n "ed-toolbar {\|\.ed-toolbar{\|ed-toolbar-status {\|ed-handle-menu {\|ed-seltb {" lib/md2doc.js | head; grep -a -n "statusEl.textContent\|paintModeStatus" lib/editor/client.js | head -4
```

```bash
S=/tmp/claude-1000/-home-user-hp-workspace-md2doc/21ed517f-03d4-42bc-9214-e92fa099fdbe/scratchpad/e1; cd /home/user/hp_workspace/md2doc && node bin/md2doc.js --edit --no-open --port 47123 $S/doc/mac-tx-core.md > $S/server.log 2>&1
```

```bash
S=/tmp/claude-1000/-home-user-hp-workspace-md2doc/21ed517f-03d4-42bc-9214-e92fa099fdbe/scratchpad/e1; cd $S && cat > dirshots.js <<'EOF'
const { chromium } = require('/home/user/hp_workspace/md2doc/node_modules/playwright');
const { apply } = require('./directions.js');
(async () => {
  const b = await chromium.launch(); const errs = [];
  for (const dir of ['B', 'C']) {
    const [css, svgMap, extra] = apply(dir);
    const p = await (await b.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
    p.on('pageerror', (e) => errs.push(dir + ': ' + e.message));
    await p.goto('http://127.0.0.1:47123/edit/0', { waitUntil: 'load' }); await p.waitForTimeout(3500);
    await p.addStyleTag({ content: css });
    const swap = async () => p.evaluate(([m, x, d]) => {
      document.querySelectorAll('[data-ed-tb]').forEach((btn) => { const k = btn.getAttribute('data-ed-tb'); if (m[k] && !btn.querySelector('svg')) btn.innerHTML = m[k]; });
      document.querySelectorAll('.ed-handle').forEach((h) => { if (!h.querySelector('svg')) h.innerHTML = x.grip; });
      document.querySelectorAll('.ed-insert').forEach((h) => { if (!h.querySelector('svg')) h.innerHTML = x.plus; });
      const st = document.querySelector('.ed-toolbar-status'); if (st && d === 'C' && !st.dataset.proto) { st.dataset.proto = 1; st.textContent = '已儲存'; }
    }, [svgMap, extra, dir]);
    await swap();
    await p.screenshot({ path: dir + '-rest.png' });
    const para = await p.evaluateHandle(() => [...document.querySelectorAll('.ed-block[data-block-type="paragraph"]')].find((b) => b.textContent.length > 120 && b.getBoundingClientRect().top > 200));
    await para.evaluate((e) => e.scrollIntoView({ block: 'center' })); await p.waitForTimeout(300);
    const r = await para.evaluate((e) => { const x = e.getBoundingClientRect(); return { x: x.left + 40, y: x.top + 10 }; });
    await p.mouse.move(r.x, r.y); await p.waitForTimeout(400); await swap();
    await p.screenshot({ path: dir + '-hover.png' });
    const h = await para.evaluate((e) => { const k = e.querySelector('.ed-handle'); const x = k.getBoundingClientRect(); return { x: x.left + x.width / 2, y: x.top + x.height / 2 }; });
    await p.mouse.click(h.x, h.y); await p.waitForTimeout(400);
    const conv = await p.$('.ed-handle-menu button'); if (conv) { await conv.hover(); await p.waitForTimeout(400); }
    await p.screenshot({ path: dir + '-handlemenu.png' });
    await p.keyboard.press('Escape'); await p.waitForTimeout(300);
    await p.mouse.move(r.x, r.y); await p.waitForTimeout(300);
    const ins = await para.evaluate((e) => { const k = e.querySelector('.ed-insert'); if (!k) return null; const x = k.getBoundingClientRect(); return { x: x.left + x.width / 2, y: x.top + x.height / 2 }; });
    if (ins) { await p.mouse.click(ins.x, ins.y); await p.waitForTimeout(400); await p.screenshot({ path: dir + '-insert.png' }); await p.keyboard.press('Escape'); }
    await p.mouse.dblclick(r.x + 60, r.y + 4); await p.waitForTimeout(500);
    await p.screenshot({ path: dir + '-seltb.png' });
    await p.keyboard.press('Escape');
    await p.close();
  }
  console.log('errors', errs.length ? errs : 'none'); await b.close();
})();
EOF
sleep 3; FONTCONFIG_FILE=$S/fonts.conf node dirshots.js && python3 -c "
from PIL import Image
rows=[]
for st in ['rest','handlemenu','seltb']:
  ims=[Image.open('%s-%s.png'%(d,st)).convert('RGB').resize((640,400)) for d in ('cur','B','C')]
  rows.append(ims)
s=Image.new('RGB',(640*3+20,400*3+20),(60,60,60))
for r,row in enumerate(rows):
  for c,im in enumerate(row): s.paste(im,(c*650,r*410))
s.save('dir-sheet.png')"
```

```bash
S=/tmp/claude-1000/-home-user-hp-workspace-md2doc/21ed517f-03d4-42bc-9214-e92fa099fdbe/scratchpad/e1; cd $S && : > empty.md && printf '# 標題\n\n一段文字。\n' > short.md && cat > emptytest.js <<'EOF'
const { chromium } = require('/home/user/hp_workspace/md2doc/node_modules/playwright');
const { spawn } = require('child_process');
(async () => {
  for (const [f, port] of [['empty.md', 47131], ['short.md', 47132]]) {
    const srv = spawn('node', ['/home/user/hp_workspace/md2doc/bin/md2doc.js', '--edit', '--no-open', '--port', String(port), f], { cwd: __dirname });
    await new Promise((r) => setTimeout(r, 2500));
    const b = await chromium.launch(); const p = await (await b.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
    await p.goto(`http://127.0.0.1:${port}/edit/0`); await p.waitForTimeout(2500);
    const before = await p.evaluate(() => ({ blocks: document.querySelectorAll('.ed-block').length, h: document.querySelector('.content').getBoundingClientRect().height }));
    await p.mouse.click(700, 700); await p.waitForTimeout(300);
    await p.keyboard.type('hello'); await p.waitForTimeout(300);
    const after = await p.evaluate(() => ({ blocks: document.querySelectorAll('.ed-block').length, active: document.activeElement.className, text: document.querySelector('.content').innerText.slice(0, 80) }));
    await p.screenshot({ path: f + '.png' });
    console.log(f, JSON.stringify(before), JSON.stringify(after));
    await b.close(); srv.kill();
  }
})();
EOF
FONTCONFIG_FILE=$S/fonts.conf node emptytest.js
```

```bash
S=/tmp/claude-1000/-home-user-hp-workspace-md2doc/21ed517f-03d4-42bc-9214-e92fa099fdbe/scratchpad/e1; cd $S && python3 - <<'EOF'
s=open('directions.js').read()
s=s.replace("function apply(dir) {\n  return [dir === 'B' ? PAPER : IMMERSIVE, svgMap, extra];","""const DARK_ICONS = `
.ed-toolbar-btn{display:inline-grid!important;place-items:center!important;padding:0!important;width:30px!important}
.ed-toolbar-btn svg{width:16px;height:16px;stroke-width:1.75}
.ed-handle,.ed-insert{color:#8c959f!important}
.ed-block:hover{outline:none!important}
`;
function apply(dir) {
  return [dir === 'A' ? DARK_ICONS : dir === 'B' ? PAPER : IMMERSIVE, svgMap, extra];""")
open('directions.js','w').write(s)
d=open('dirshots.js').read()
d=d.replace("for (const dir of ['B', 'C'])","for (const dir of (process.env.DIRS || 'B,C').split(','))")
d=d.replace("await p.goto('http://127.0.0.1:47123/edit/0'","await p.goto('http://127.0.0.1:' + process.env.PORT + '/edit/0'")
open('dirshots.js','w').write(d)
EOF
(node /home/user/hp_workspace/md2doc/bin/md2doc.js --edit --no-open --port 47124 doc/mac-tx-core.md >/dev/null 2>&1 &) ; sleep 3; DIRS=A PORT=47124 FONTCONFIG_FILE=$S/fonts.conf node dirshots.js; ls A-*.png
```

```bash
S=/tmp/claude-1000/-home-user-hp-workspace-md2doc/21ed517f-03d4-42bc-9214-e92fa099fdbe/scratchpad/e1; cd $S && pgrep -fa 'md2doc.js --edit' ; python3 -c "
from PIL import Image
ims=[Image.open(d+'-rest.png').crop((0,0,1440,60)) for d in ('cur','A','B','C')]+[Image.open(d+'-seltb.png').crop((150,520,760,640)) for d in ('cur','A','B','C')]
s=Image.new('RGB',(1440,60*4+120*4+80),(120,120,120)); y=0
for im in ims: s.paste(im,(0,y)); y+=im.height+10
s.save('crop-sheet.png')"
```

```bash
S=/tmp/claude-1000/-home-user-hp-workspace-md2doc/21ed517f-03d4-42bc-9214-e92fa099fdbe/scratchpad/e1; mkdir -p $S/page/img && cd $S && python3 -c "
from PIL import Image
for d in ('cur','A','B','C'):
  for st in ('rest','handlemenu','seltb','insert'):
    Image.open('%s-%s.png'%(d,st)).convert('RGB').save('page/img/%s-%s.jpg'%(d,st),quality=82)
" && du -sh page/img
```

```bash
S=/tmp/claude-1000/-home-user-hp-workspace-md2doc/21ed517f-03d4-42bc-9214-e92fa099fdbe/scratchpad; cd $S && ls refs/*.png | head -20 && python3 -c "
from PIL import Image
for s in ('blocknote','tiptap','lexical','editorjs'):
  for st in ('slash','seltb'):
    im=Image.open('refs/%s-%s.png'%(s,st)).convert('RGB'); print(s,st,im.size); im.save('e1/page/img/ref-%s-%s.jpg'%(s,st),quality=82)
"
```

```bash
S=/tmp/claude-1000/-home-user-hp-workspace-md2doc/21ed517f-03d4-42bc-9214-e92fa099fdbe/scratchpad/e1/page; python3 - "$S/editor-e1.html" <<'EOF'
import sys
p=sys.argv[1]; s=open(p).read()
refs='''<div class="tw"><table>
<thead><tr><th>編輯器</th><th>頂部工具列</th><th>選字工具列</th><th>「/」選單</th><th>把手</th><th>強調色</th></tr></thead>
<tbody>
<tr><td>Tiptap notion-like</td><td>48px 白底，只有復原／重做／主題</td><td>白底，圓角 15px，40px 高，四層柔陰影</td><td>白底 240px，項目 32px，圓角 18px</td><td>＋與⠿，離文字 16px</td><td>紫 <code>#6229ff</code></td></tr>
<tr><td>BlockNote</td><td>無</td><td>白底，圓角 6px，36px 高，有區塊類型下拉</td><td>白底 338px，雙行項目 52px，附快捷鍵</td><td>＋與⠿，極淡灰，貼著文字</td><td>瀏覽器原生藍</td></tr>
<tr><td>Editor.js</td><td>無</td><td>白底，圓角 6px，38px 高，只有 3 個工具</td><td>白底 200px，項目 32px</td><td>＋與⠿，離文字 58px</td><td>淡藍選取 <code>#d4ecff</code></td></tr>
<tr><td>Lexical playground</td><td>有，48px 白底完整格式列</td><td>白底，圓角 8px，43px 高，12 個按鈕</td><td>白底 250px，項目 36px，無分組</td><td>⠿＋，透明度 0.3</td><td>瀏覽器原生藍</td></tr>
</tbody></table></div>
<p class="note">四家的選字工具列與選單全都是白底；沒有一家用深色膠囊。只有 Lexical 留著完整格式工具列，最接近 B；Tiptap 的頂列只剩復原／重做，最接近 C。novel.sh 載入失敗，未列入。</p>
<div class="shots" data-refs="slash"></div>
<div class="shots" data-refs="seltb"></div>'''
s=s.replace('<!--REFS-->',refs)
s=s.replace("  var lb=document.getElementById('lb')","""  var rn=[['tiptap','Tiptap'],['blocknote','BlockNote'],['editorjs','Editor.js'],['lexical','Lexical']];
  document.querySelectorAll('.shots[data-refs]').forEach(function(box){
    var st=box.getAttribute('data-refs'), lab=st==='slash'?'「/」選單':'選字工具列';
    rn.forEach(function(c){
      var f=document.createElement('figure'), b=document.createElement('button'); b.className='shot'; b.type='button';
      b.setAttribute('aria-label','放大：'+c[1]+' '+lab);
      var i=document.createElement('img'); i.src='img/ref-'+c[0]+'-'+st+'.jpg'; i.alt=c[1]+' '+lab; i.loading='lazy'; i.width=1440; i.height=900;
      b.appendChild(i); f.appendChild(b);
      var cap=document.createElement('figcaption'); cap.innerHTML='<b>'+c[1]+'</b> '+lab; f.appendChild(cap); box.appendChild(f);
    });
  });
  var lb=document.getElementById('lb')""")
open(p,'w').write(s)
EOF
ls $S/img | wc -l
```

```bash
cd /tmp/claude-1000/-home-user-hp-workspace-md2doc/21ed517f-03d4-42bc-9214-e92fa099fdbe/scratchpad/e1/page && python3 -c "
import json,os
print(json.dumps({'img/'+f:'img/'+f for f in sorted(os.listdir('img'))}))" > files.json && cat files.json | head -c 200
```

```bash
N=/tmp/claude-1000/-home-user-hp-workspace-md2doc/cc552bfe-c005-4ece-b528-ad08d7b94e52/scratchpad; mkdir -p $N && cp -r /tmp/claude-1000/-home-user-hp-workspace-md2doc/21ed517f-03d4-42bc-9214-e92fa099fdbe/scratchpad/e1/page $N/e1page && ls $N/e1page
```

```bash
S=/tmp/claude-1000/-home-user-hp-workspace-md2doc/21ed517f-03d4-42bc-9214-e92fa099fdbe/scratchpad/e1; cd $S && cat > darkcheck.js <<'EOF'
const { chromium } = require('/home/user/hp_workspace/md2doc/node_modules/playwright');
const { spawn } = require('child_process');
(async () => {
  const srv = spawn('node', ['/home/user/hp_workspace/md2doc/bin/md2doc.js', '--edit', '--no-open', '--port', '47141', 'doc/mac-tx-core.md'], { cwd: __dirname });
  await new Promise((r) => setTimeout(r, 3000));
  const b = await chromium.launch(); const p = await (await b.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
  await p.goto('http://127.0.0.1:47141/edit/0'); await p.waitForTimeout(3500);
  const info = await p.evaluate(() => {
    const t = document.querySelector('.md2doc-theme-toggle, [data-md2doc-theme-toggle], button[aria-label*="深"], button[aria-label*="theme" i]');
    const r = t && t.getBoundingClientRect();
    return { toggle: t ? t.outerHTML.slice(0, 160) : null, visible: !!(r && r.width), rect: r && [r.x, r.y, r.width, r.height], attr: document.documentElement.getAttribute('data-md2doc-theme') };
  });
  console.log(JSON.stringify(info));
  if (info.visible) {
    await p.mouse.click(info.rect[0] + info.rect[2] / 2, info.rect[1] + info.rect[3] / 2); await p.waitForTimeout(800);
  } else {
    await p.evaluate(() => document.documentElement.setAttribute('data-md2doc-theme', 'dark')); await p.waitForTimeout(800);
  }
  console.log('after', await p.evaluate(() => document.documentElement.getAttribute('data-md2doc-theme')));
  await p.screenshot({ path: 'cur-dark-rest.png' });
  const para = await p.evaluateHandle(() => [...document.querySelectorAll('.ed-block[data-block-type="paragraph"]')].find((b) => b.textContent.length > 120 && b.getBoundingClientRect().top > 200));
  await para.evaluate((e) => e.scrollIntoView({ block: 'center' })); await p.waitForTimeout(300);
  const r = await para.evaluate((e) => { const x = e.getBoundingClientRect(); return { x: x.left + 40, y: x.top + 10 }; });
  await p.mouse.dblclick(r.x + 60, r.y + 4); await p.waitForTimeout(500);
  await p.screenshot({ path: 'cur-dark-seltb.png' });
  await b.close(); srv.kill();
})();
EOF
FONTCONFIG_FILE=$S/fonts.conf node darkcheck.js
```

```bash
S=/tmp/claude-1000/-home-user-hp-workspace-md2doc/21ed517f-03d4-42bc-9214-e92fa099fdbe/scratchpad/e1; cd $S/lucide && for n in sun moon; do curl -sf "https://unpkg.com/lucide-static@0.469.0/icons/$n.svg" -o $n.svg && echo ok $n; done; cd $S && grep -n "ed-raw\b\|\.ed-raw {\|\.ed-raw{\|ed-raw-btn\|\.ed-li-check {" /home/user/hp_workspace/md2doc/lib/md2doc.js | head
```

```bash
S=/tmp/claude-1000/-home-user-hp-workspace-md2doc/21ed517f-03d4-42bc-9214-e92fa099fdbe/scratchpad/e1; cd $S && cat > themed.js <<'EOF'
// Prototype: B paper chrome with light + dark tokens, edit page passed through applyReaderTheme.
const fs = require('fs');
const { chromium } = require('/home/user/hp_workspace/md2doc/node_modules/playwright');
const { spawn } = require('child_process');
const { applyReaderTheme } = require('/home/user/hp_workspace/md2doc/lib/theme/tokens.js');
const ico = (n) => fs.readFileSync(__dirname + '/lucide/' + n + '.svg', 'utf8').replace(/<!--[^>]*-->/, '').trim();
const ICONS = { save: 'save', undo: 'undo-2', redo: 'redo-2', headings: 'heading', quote: 'quote', code: 'code', list: 'list',
  'ordered-list': 'list-ordered', check: 'list-checks', bold: 'bold', italic: 'italic', strike: 'strikethrough', 'inline-code': 'code',
  link: 'link', outdent: 'indent-decrease', indent: 'indent-increase', table: 'table', 'insert-before': 'arrow-up-to-line',
  'insert-after': 'arrow-down-to-line', line: 'minus', image: 'image', outline: 'panel-left', preview: 'file-code-2' };
const svgMap = {}; for (const k in ICONS) svgMap[k] = ico(ICONS[k]);
const extra = { grip: ico('grip-vertical'), plus: ico('plus'), sun: ico('sun'), moon: ico('moon') };
const CSS = `
:root{--e-bar:#ffffff;--e-surface:#ffffff;--e-ring:0 0 0 1px rgba(31,35,40,.12),0 8px 24px rgba(31,35,40,.10);--e-ink:#1f2328;--e-mut:#57606a;
  --e-hover:#f3f5f7;--e-active-bg:#dbe6f3;--e-active-fg:#0550ae;--e-accent:#0969da;--e-rule:#d8dee4;--e-sel:rgba(9,105,218,.10);--e-glyph:#8c959f;--e-field:#f6f8fa}
html[data-md2doc-theme="dark"]{--e-bar:#1b1b1d;--e-surface:#2a2a2d;--e-ring:0 0 0 1px rgba(255,255,255,.10),0 8px 24px rgba(0,0,0,.55);--e-ink:#e3e3e3;--e-mut:#a3a6ab;
  --e-hover:#303134;--e-active-bg:#24364f;--e-active-fg:#a5c9f8;--e-accent:#6ea8f5;--e-rule:#38393c;--e-sel:rgba(110,168,245,.16);--e-glyph:#7d8086;--e-field:#232325}
.ed-toolbar{background:var(--e-bar)!important;border-bottom:1px solid var(--e-rule)!important;box-shadow:none!important;border-radius:0!important}
.ed-toolbar-btn{background:transparent!important;border:0!important;color:var(--e-mut)!important;width:32px!important;height:32px!important;border-radius:6px!important;display:inline-grid!important;place-items:center!important;padding:0!important}
.ed-toolbar-btn:hover{background:var(--e-hover)!important;color:var(--e-ink)!important}
.ed-toolbar-btn[aria-pressed="true"]{background:var(--e-active-bg)!important;color:var(--e-active-fg)!important}
.ed-toolbar-btn svg{width:18px;height:18px;stroke-width:1.75}
.ed-toolbar-sep{background:var(--e-rule)!important;height:20px!important;width:1px!important;margin:0 8px!important}
.ed-toolbar-status{color:var(--e-mut)!important;background:transparent!important}
.ed-handle-menu,.ed-insert-menu,.ed-seltb,.ed-te-menu,.ed-toolbar-menu{background:var(--e-surface)!important;color:var(--e-ink)!important;box-shadow:var(--e-ring)!important;border:0!important;border-radius:8px!important;backdrop-filter:none!important}
.ed-handle-menu-btn,.ed-insert-menu-btn,.ed-seltb-btn,.ed-toolbar-menu-btn,.ed-te-menu button{background:transparent!important;color:var(--e-ink)!important;border:0!important;border-radius:6px!important}
.ed-handle-menu-btn:hover,.ed-insert-menu-btn:hover,.ed-seltb-btn:hover,.ed-toolbar-menu-btn:hover,.ed-te-menu button:hover{background:var(--e-hover)!important}
.ed-seltb-btn[aria-pressed="true"]{background:var(--e-active-bg)!important;color:var(--e-active-fg)!important}
.ed-handle-menu svg,.ed-insert-menu svg{color:var(--e-mut)!important}
.ed-handle,.ed-insert{background:transparent!important;color:var(--e-glyph)!important;border-radius:4px!important}
.ed-handle:hover,.ed-insert:hover{background:var(--e-hover)!important;color:var(--e-ink)!important}
.ed-block:hover{outline:none!important}
.ed-wys-armed:focus{outline:2px solid var(--e-accent)!important;outline-offset:2px;caret-color:var(--e-accent)!important}
.ed-selected{background:var(--e-sel)!important}
.e-theme-btn svg{width:18px;height:18px;stroke-width:1.75}
`;
const FIXES = `
.ed-raw,.ed-raw textarea,textarea.ed-source{background:var(--e-field)!important;color:var(--e-ink)!important;border-color:var(--e-rule)!important}
.ed-te-grip-row,.ed-te-grip-col{background:var(--e-surface)!important;box-shadow:var(--e-ring)!important;border:0!important;color:var(--e-glyph)!important}
.ed-tb-insert{background:var(--e-surface)!important;border-color:var(--e-accent)!important;color:var(--e-accent)!important}
.ed-li-check{border-color:var(--e-glyph)!important}
`;
(async () => {
  const port = 47151;
  const srv = spawn('node', ['/home/user/hp_workspace/md2doc/bin/md2doc.js', '--edit', '--no-open', '--port', String(port), 'doc/mac-tx-core.md'], { cwd: __dirname });
  await new Promise((r) => setTimeout(r, 3000));
  const b = await chromium.launch(); const errs = [];
  const runs = [['Bl', 'light', 'tb', false], ['Bd', 'dark', 'tb', false], ['Bdfix', 'dark', 'tb', true], ['Bdbub', 'dark', 'bubble', true]];
  for (const [tag, theme, place, fix] of runs) {
    const ctx = await b.newContext({ viewport: { width: 1440, height: 900 } });
    await ctx.addInitScript((t) => { try { localStorage.setItem('md2doc-theme', t); } catch (e) {} }, theme);
    const p = await ctx.newPage(); p.on('pageerror', (e) => errs.push(tag + ': ' + e.message));
    await p.route('**/edit/0', async (route) => { const r = await route.fetch(); route.fulfill({ response: r, body: applyReaderTheme(await r.text()) }); });
    await p.goto(`http://127.0.0.1:${port}/edit/0`); await p.waitForTimeout(3500);
    await p.addStyleTag({ content: CSS + (fix ? FIXES : '') + (place === 'tb' ? '.md2doc-theme-toggle,[class*="theme-bubble"],[class*="theme-toggle"]:not(.e-theme-btn){display:none!important}' : '') });
    const swap = async () => p.evaluate(([m, x, place]) => {
      document.querySelectorAll('[data-ed-tb]').forEach((btn) => { const k = btn.getAttribute('data-ed-tb'); if (m[k] && !btn.querySelector('svg')) btn.innerHTML = m[k]; });
      document.querySelectorAll('.ed-handle').forEach((h) => { if (!h.querySelector('svg')) h.innerHTML = x.grip; });
      document.querySelectorAll('.ed-insert').forEach((h) => { if (!h.querySelector('svg')) h.innerHTML = x.plus; });
      if (place === 'tb' && !document.querySelector('.e-theme-btn')) {
        const pv = document.querySelector('[data-ed-tb="preview"]'); const btn = document.createElement('button');
        btn.className = 'ed-toolbar-btn e-theme-btn'; btn.title = '切換深色／淺色';
        btn.innerHTML = document.documentElement.getAttribute('data-md2doc-theme') === 'dark' ? x.sun : x.moon; pv.after(btn);
      }
    }, [svgMap, extra, place]);
    await swap();
    const shot = async (st) => { await swap(); await p.screenshot({ path: tag + '-' + st + '.png' }); };
    await shot('rest');
    const para = await p.evaluateHandle(() => [...document.querySelectorAll('.ed-block[data-block-type="paragraph"]')].find((b) => b.textContent.length > 120 && b.getBoundingClientRect().top > 200));
    await para.evaluate((e) => e.scrollIntoView({ block: 'center' })); await p.waitForTimeout(300);
    const r = await para.evaluate((e) => { const x = e.getBoundingClientRect(); return { x: x.left + 40, y: x.top + 10 }; });
    await p.mouse.move(r.x, r.y); await p.waitForTimeout(300);
    const h = await para.evaluate((e) => { const x = e.querySelector('.ed-handle').getBoundingClientRect(); return { x: x.left + x.width / 2, y: x.top + x.height / 2 }; });
    await p.mouse.click(h.x, h.y); await p.waitForTimeout(400);
    const conv = await p.$('.ed-handle-menu button'); if (conv) { await conv.hover(); await p.waitForTimeout(400); }
    await shot('handlemenu'); await p.keyboard.press('Escape'); await p.waitForTimeout(300);
    await p.mouse.move(r.x, r.y); await p.waitForTimeout(300);
    const ins = await para.evaluate((e) => { const x = e.querySelector('.ed-insert').getBoundingClientRect(); return { x: x.left + x.width / 2, y: x.top + x.height / 2 }; });
    await p.mouse.click(ins.x, ins.y); await p.waitForTimeout(400); await shot('insert'); await p.keyboard.press('Escape');
    await p.mouse.dblclick(r.x + 60, r.y + 4); await p.waitForTimeout(500); await shot('seltb'); await p.keyboard.press('Escape');
    const t = await p.evaluateHandle(() => [...document.querySelectorAll('.content table')].find((x) => x.rows.length > 3));
    await t.evaluate((e) => e.scrollIntoView({ block: 'center' })); await p.waitForTimeout(300);
    const tr = await t.evaluate((e) => { const c = e.rows[2].cells[1].getBoundingClientRect(); return { x: c.left + 20, y: c.top + c.height / 2, by: c.bottom }; });
    await p.mouse.move(tr.x, tr.y); await p.waitForTimeout(300); await p.mouse.move(tr.x, tr.by - 1); await p.waitForTimeout(500);
    await shot('table');
    const code = await p.evaluateHandle(() => [...document.querySelectorAll('.ed-block')].find((b) => b.querySelector('pre code')));
    await code.evaluate((e) => e.scrollIntoView({ block: 'center' })); await p.waitForTimeout(300); await code.click(); await p.waitForTimeout(700);
    await shot('raw'); await p.keyboard.press('Escape');
    await ctx.close();
  }
  console.log('errors', errs.length ? errs : 'none'); await b.close(); srv.kill();
})();
EOF
FONTCONFIG_FILE=$S/fonts.conf node themed.js; ls Bd-*.png | wc -l
```

```bash
S=/tmp/claude-1000/-home-user-hp-workspace-md2doc/21ed517f-03d4-42bc-9214-e92fa099fdbe/scratchpad/e1; cd $S && python3 -c "
from PIL import Image
fs=['Bd-rest','Bd-seltb','Bd-table','Bd-raw','Bdfix-table','Bdfix-raw','Bdbub-rest','Bdfix-handlemenu']
ims=[Image.open(f+'.png').convert('RGB').resize((720,450)) for f in fs]
s=Image.new('RGB',(1450,1840),(200,60,60))
for i,im in enumerate(ims): s.paste(im,((i%2)*730,(i//2)*460))
s.save('dark-sheet.png')"
```

```bash
S=/tmp/claude-1000/-home-user-hp-workspace-md2doc/21ed517f-03d4-42bc-9214-e92fa099fdbe/scratchpad/e1; cd $S && python3 -c "
from PIL import Image
a=Image.open('Bdfix-raw.png').crop((300,40,1440,500)); b=Image.open('Bl-raw.png').crop((300,40,1440,500))
s=Image.new('RGB',(1140,930),(200,60,60)); s.paste(a,(0,0)); s.paste(b,(0,470)); s.save('raw-zoom.png')"; cd /home/user/hp_workspace/md2doc && sed -n 3876,3900p lib/md2doc.js
```

```bash
S=/tmp/claude-1000/-home-user-hp-workspace-md2doc/21ed517f-03d4-42bc-9214-e92fa099fdbe/scratchpad/e1; cd $S && python3 -c "
from PIL import Image
parts=[Image.open('Bd-rest.png').crop((0,0,1440,50)),Image.open('Bl-rest.png').crop((0,0,1440,50)),Image.open('Bdfix-handlemenu.png').crop((150,560,800,900)),Image.open('Bd-seltb.png').crop((150,330,900,470)),Image.open('Bdbub-rest.png').crop((1100,700,1440,900))]
H=sum(p.height for p in parts)+50; s=Image.new('RGB',(1440,H),(200,60,60)); y=0
for p in parts: s.paste(p,(0,y)); y+=p.height+10
s.save('dark-zoom.png')"
```

```bash
S=/tmp/claude-1000/-home-user-hp-workspace-md2doc/21ed517f-03d4-42bc-9214-e92fa099fdbe/scratchpad/e1; N=/tmp/claude-1000/-home-user-hp-workspace-md2doc/cc552bfe-c005-4ece-b528-ad08d7b94e52/scratchpad/e1page; cd $S && python3 - "$N" <<'EOF'
import sys
from PIL import Image
N=sys.argv[1]
m={'Bl':'Bl','Bd':'Bdfix'}
for k,src in m.items():
  for st in ('rest','handlemenu','seltb','raw'):
    Image.open('%s-%s.png'%(src if not (k=='Bl') else 'Bl',st)).convert('RGB').save('%s/img/%s-%s.jpg'%(N,k,st),quality=82)
Image.open('Bd-rest.png').crop((0,0,1440,50)).convert('RGB').save(N+'/img/T1-crop.jpg',quality=88)
Image.open('Bdbub-rest.png').crop((900,560,1440,900)).convert('RGB').save(N+'/img/T2-crop.jpg',quality=88)
Image.open('Bd-rest.png').crop((900,560,1440,900)).convert('RGB').save(N+'/img/T1-corner.jpg',quality=88)
p=N+'/editor-e1.html'; s=open(p).read()
sec='''
  <section class="row" aria-labelledby="s7" id="dark"><h2 id="s7">B 的深淺模式</h2>
    <p class="note">v3.9.0 只讓閱讀頁有深色，編輯模式是刻意鎖淺色（<code>lib/md2doc.js:5952</code>），所以目前在編輯模式完全沒有切換鈕。下面是 B 套上閱讀頁同一組深色 token（B Neutral：底 <code>#1b1b1d</code>、強調 <code>#6ea8f5</code>）的原型；編輯器的選單用比底色亮一階的 <code>#2a2a2d</code> 浮起來。偏好沿用同一個 <code>md2doc-theme</code>，閱讀與編輯切過去顏色一致。</p>
    <div class="shots shots2" data-pair="rest"></div>
    <div class="shots shots2" data-pair="handlemenu"></div>
    <div class="shots shots2" data-pair="seltb"></div>
    <div class="shots shots2" data-pair="raw"></div>
  </section>
  <section class="row" aria-labelledby="s8"><h2 id="s8">切換鈕放哪裡</h2>
    <div class="opts">
      <div class="opt rec"><h3>T1 放進工具列 <span class="tag">推薦</span></h3><ul><li>放在檢視群組最右邊（大綱、原始碼旁），☾／☀ 線條圖示</li><li>編輯模式本來就有頂列，跟手機閱讀頁「有頂列就放頂列」同一個邏輯</li><li>不蓋到文件右下角的段落、表格把手</li></ul>
        <figure><button class="shot" type="button" aria-label="放大：T1 工具列"><img src="img/T1-crop.jpg" alt="T1 工具列最右邊的太陽圖示" width="1440" height="50"></button></figure></div>
      <div class="opt"><h3>T2 沿用右下泡泡</h3><ul><li>跟桌面閱讀頁位置相同，肌肉記憶一致</li><li>但壓在正文上方；編輯時游標、選字、表格右緣都可能被它擋住</li></ul>
        <figure><button class="shot" type="button" aria-label="放大：T2 右下泡泡"><img src="img/T2-crop.jpg" alt="T2 右下角泡泡壓在正文上" width="540" height="340"></button></figure></div>
    </div>
  </section>
  <section class="row" aria-labelledby="s9"><h2 id="s9">編輯器專屬、要一起跟深色的元件</h2>
    <div class="tw"><table><thead><tr><th>元件</th><th>目前（寫死的淺色）</th><th>深色處理</th></tr></thead><tbody>
      <tr><td>工具列、⠿／＋ 選單、選字工具列、表格選單</td><td>深色膠囊 <code>rgba(16,18,21,.92)</code></td><td>上圖原型：底 <code>#1b1b1d</code>，選單 <code>#2a2a2d</code>＋亮細環</td></tr>
      <tr><td>區塊編輯框（游標、聚焦外框）</td><td><code>#3b82f6</code></td><td>強調色 token，深色 <code>#6ea8f5</code></td></tr>
      <tr><td>多選底色、表格範圍選取、拖放指示線</td><td><code>rgba(59,130,246,.15/.18)</code>、<code>#3b82f6</code></td><td>同上，深色底透明度略升</td></tr>
      <tr><td>MD 原始碼框、完成／取消鈕</td><td>白底、<code>#808080</code> 框、<code>#0a7a0a</code>／<code>#b00020</code></td><td>欄位底 <code>#232325</code>；字型改成閱讀頁的程式碼字型</td></tr>
      <tr><td>原始碼模式（整份文字框）</td><td>白底</td><td>同上</td></tr>
      <tr><td>待辦核取框、表格把手、表格 ＋ 泡泡</td><td><code>#8a8a8a</code>、<code>#9ca3af</code>、白底藍框</td><td>灰階 token；泡泡底用選單色</td></tr>
      <tr><td>衝突／存檔失敗橫幅</td><td><code>#b00020</code> 白字</td><td>深色維持紅底白字（對比夠），只調亮一階</td></tr>
      <tr><td>波形編輯器（整個彈窗）</td><td>白色面板、<code>#ececec</code> 格線</td><td>也跟深色；面板與畫布的細節放到 E8 一起審</td></tr>
    </tbody></table></div>
  </section>
'''
s=s.replace('  <section class="row" aria-labelledby="s5" id="refs">', sec+'  <section class="row" aria-labelledby="s5" id="refs">')
s=s.replace('<h3>B 淺色紙面工具列 <span class="tag">推薦</span></h3><ul>','<h3>B 淺色紙面工具列 <span class="tag">已選</span></h3><ul><li>淺色與深色兩套（見下方「B 的深淺模式」）</li>')
s=s.replace('.shots{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:10px}','.shots{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:10px}\n.shots.shots2{grid-template-columns:repeat(2,minmax(0,1fr))}\n.opt figure{margin-top:6px}')
s=s.replace('@media (max-width:520px){.shots{grid-template-columns:minmax(0,1fr)}}','@media (max-width:520px){.shots,.shots.shots2{grid-template-columns:minmax(0,1fr)}}')
s=s.replace("  var lb=document.getElementById('lb')","""  var pn={rest:'待命',handlemenu:'⠿ 選單',seltb:'選字工具列',raw:'MD 原始碼框'};
  document.querySelectorAll('.shots[data-pair]').forEach(function(box){
    var st=box.getAttribute('data-pair');
    [['Bl','B 淺色'],['Bd','B 深色']].forEach(function(c){
      var f=document.createElement('figure'), b=document.createElement('button'); b.className='shot'; b.type='button';
      b.setAttribute('aria-label','放大：'+c[1]+' '+pn[st]);
      var i=document.createElement('img'); i.src='img/'+c[0]+'-'+st+'.jpg'; i.alt=c[1]+' '+pn[st]; i.loading='lazy'; i.width=1440; i.height=900;
      b.appendChild(i); f.appendChild(b);
      var cap=document.createElement('figcaption'); cap.innerHTML='<b>'+c[1]+'</b> '+pn[st]; f.appendChild(cap); box.appendChild(f);
    });
  });
  var lb=document.getElementById('lb')""")
open(p,'w').write(s)
EOF
ls $N/img | wc -l; grep -c 'data-pair' $N/editor-e1.html
```

```bash
S=/tmp/claude-1000/-home-user-hp-workspace-md2doc/21ed517f-03d4-42bc-9214-e92fa099fdbe/scratchpad/e1; cd $S && awk '/^const fs = require/{p=1} /^\(async/{p=0} p' themed.js | grep -v "require('/home/user/hp_workspace/md2doc/node_modules/playwright')\|require('child_process')\|applyReaderTheme }" > bcss.js && echo "module.exports = { CSS, FIXES, svgMap, extra };" >> bcss.js && node -e "const m=require('./bcss.js');console.log(Object.keys(m.svgMap).length, m.CSS.length)"
```

```bash
S=/tmp/claude-1000/-home-user-hp-workspace-md2doc/21ed517f-03d4-42bc-9214-e92fa099fdbe/scratchpad/e1; cd $S && for n in check loader-circle circle-alert x info rotate-cw; do curl -sf "https://unpkg.com/lucide-static@0.469.0/icons/$n.svg" -o lucide/$n.svg && echo ok $n; done
cat > e2.js <<'EOF'
const fs = require('fs');
const { chromium } = require('/home/user/hp_workspace/md2doc/node_modules/playwright');
const { spawn } = require('child_process');
const { applyReaderTheme } = require('/home/user/hp_workspace/md2doc/lib/theme/tokens.js');
const { CSS, FIXES, svgMap, extra } = require('./bcss.js');
const ico = (n) => fs.readFileSync(__dirname + '/lucide/' + n + '.svg', 'utf8').replace(/<!--[^>]*-->/, '').trim();
const I = { check: ico('check'), load: ico('loader-circle'), alert: ico('circle-alert'), x: ico('x'), info: ico('info'), retry: ico('rotate-cw') };
const E2CSS = `
:root{--e-err:#cf222e;--e-err-bg:#ffebe9;--e-err-ink:#82071e;--e-ok:#1a7f37;--e-dirty:#9a6700}
html[data-md2doc-theme="dark"]{--e-err:#ff8a8a;--e-err-bg:#3a2224;--e-err-ink:#ffc9c9;--e-ok:#6fdd8b;--e-dirty:#e3b341}
.e-status{display:inline-flex;align-items:center;gap:6px;font-size:13px;color:var(--e-mut)}
.e-status svg{width:15px;height:15px;stroke-width:2}
.e-status.ok svg{color:var(--e-ok)} .e-status.dirty .dot{width:8px;height:8px;border-radius:50%;background:var(--e-dirty)}
.e-status.err{color:var(--e-err)} .e-status.saving svg{color:var(--e-mut)}
.e-status .sep{opacity:.5}
.ed-toolbar-btn.e-save-dirty{color:var(--e-accent)!important;background:var(--e-active-bg)!important}
.e-banner{position:fixed;top:var(--ed-toolbar-h,44px);left:50%;transform:translateX(-50%);margin-top:10px;z-index:999;display:flex;align-items:center;gap:12px;
  max-width:min(760px,calc(100vw - 32px));padding:10px 10px 10px 14px;border-radius:8px;background:var(--e-err-bg);color:var(--e-err-ink);
  box-shadow:inset 3px 0 0 var(--e-err),var(--e-ring);font-size:14px;line-height:1.5}
.e-banner svg{width:18px;height:18px;flex:none;color:var(--e-err)}
.e-banner .msg{flex:1}
.e-banner button{font:inherit;font-size:13px;font-weight:600;border:0;border-radius:6px;padding:4px 12px;cursor:pointer;background:var(--e-err);color:var(--e-surface)}
.e-banner button.x{background:transparent;color:var(--e-err-ink);padding:4px;display:grid;place-items:center}
.e-toast{position:fixed;left:50%;bottom:28px;transform:translateX(-50%);z-index:999;display:flex;align-items:center;gap:8px;padding:8px 14px;border-radius:8px;
  background:var(--e-surface);color:var(--e-ink);box-shadow:var(--e-ring);font-size:14px}
.e-toast svg{width:16px;height:16px;color:var(--e-mut)}
`;
(async () => {
  const port = 47161;
  const srv = spawn('node', ['/home/user/hp_workspace/md2doc/bin/md2doc.js', '--edit', '--no-open', '--port', String(port), 'doc/mac-tx-core.md'], { cwd: __dirname });
  await new Promise((r) => setTimeout(r, 3000));
  const b = await chromium.launch(); const errs = [];
  // current look: one shot of the real red banner for comparison (light, original CSS)
  {
    const p = await (await b.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
    await p.goto(`http://127.0.0.1:${port}/edit/0`); await p.waitForTimeout(3500);
    await p.evaluate(() => { const el = document.createElement('div'); el.className = 'ed-conflict';
      el.innerHTML = '<span>File changed on disk — reload to pick up external edits (your unsaved changes will be lost).</span><button>Reload</button><button aria-label="Dismiss">✕</button>'; document.body.appendChild(el); });
    await p.screenshot({ path: 'e2-cur-banner.png', clip: { x: 0, y: 0, width: 1440, height: 140 } });
    await p.evaluate(() => { document.querySelector('.ed-conflict span').textContent = '選取範圍不連續，無法整批操作'; document.querySelectorAll('.ed-conflict button')[0].remove(); });
    await p.screenshot({ path: 'e2-cur-notice.png', clip: { x: 0, y: 0, width: 1440, height: 140 } });
    await p.context().close();
  }
  for (const theme of ['light', 'dark']) {
    const ctx = await b.newContext({ viewport: { width: 1440, height: 900 } });
    await ctx.addInitScript((t) => { try { localStorage.setItem('md2doc-theme', t); } catch (e) {} }, theme);
    const p = await ctx.newPage(); p.on('pageerror', (e) => errs.push(theme + ': ' + e.message));
    await p.route('**/edit/0', async (route) => { const r = await route.fetch(); route.fulfill({ response: r, body: applyReaderTheme(await r.text()) }); });
    await p.goto(`http://127.0.0.1:${port}/edit/0`); await p.waitForTimeout(3500);
    await p.addStyleTag({ content: CSS + FIXES + E2CSS });
    await p.evaluate(([m, x]) => {
      document.querySelectorAll('[data-ed-tb]').forEach((btn) => { const k = btn.getAttribute('data-ed-tb'); if (m[k]) btn.innerHTML = m[k]; });
      document.querySelectorAll('.ed-handle').forEach((h) => { h.innerHTML = x.grip; });
      document.querySelectorAll('.ed-insert').forEach((h) => { h.innerHTML = x.plus; });
    }, [svgMap, extra]);
    const setStatus = async (html, dirtySave) => p.evaluate(([h, d]) => {
      const st = document.querySelector('.ed-toolbar-status'); st.innerHTML = h;
      document.querySelector('[data-ed-tb="save"]').classList.toggle('e-save-dirty', !!d);
      document.querySelector('[data-ed-tb="save"]').removeAttribute('disabled');
    }, [html, dirtySave]);
    const T = theme === 'light' ? 'l' : 'd';
    const strip = async (name) => p.screenshot({ path: `e2-${T}-${name}.png`, clip: { x: 0, y: 0, width: 1440, height: 48 } });
    // S1 manual
    await setStatus('<span class="e-status dirty"><span class="dot"></span>有未儲存的變更<span class="sep">·</span>Ctrl+S 儲存</span>', true); await strip('s1-dirty');
    await setStatus(`<span class="e-status ok">${I.check}已儲存</span>`, false); await strip('s1-saved');
    // S2 autosave
    await setStatus(`<span class="e-status saving">${I.load}儲存中…</span>`, false); await strip('s2-saving');
    await setStatus(`<span class="e-status ok">${I.check}已儲存</span>`, false); await strip('s2-saved');
    await setStatus(`<span class="e-status err">${I.alert}無法儲存，3 秒後重試</span>`, false); await strip('s2-err');
    // N2 error banner
    await p.evaluate((I) => { const el = document.createElement('div'); el.className = 'e-banner'; el.setAttribute('role', 'alert');
      el.innerHTML = I.alert + '<span class="msg">這個檔案剛在別處被修改。重新載入會帶入新內容，並捨棄你在這裡還沒儲存的變更。</span><button>重新載入</button><button class="x" aria-label="關閉">' + I.x + '</button>';
      document.body.appendChild(el); }, I);
    await p.screenshot({ path: `e2-${T}-banner.png`, clip: { x: 0, y: 0, width: 1440, height: 140 } });
    await p.evaluate(() => document.querySelector('.e-banner').remove());
    await p.evaluate((I) => { const el = document.createElement('div'); el.className = 'e-toast'; el.setAttribute('role', 'status');
      el.innerHTML = I.info + '<span>選取範圍不連續，無法整批操作</span>'; document.body.appendChild(el); }, I);
    await p.screenshot({ path: `e2-${T}-toast.png`, clip: { x: 0, y: 700, width: 1440, height: 200 } });
    await ctx.close();
  }
  console.log('errors', errs.length ? errs : 'none'); await b.close(); srv.kill();
})();
EOF
FONTCONFIG_FILE=$S/fonts.conf node e2.js && ls e2-*.png | wc -l
```

```bash
S=/tmp/claude-1000/-home-user-hp-workspace-md2doc/21ed517f-03d4-42bc-9214-e92fa099fdbe/scratchpad/e1; cd $S && python3 -c "
from PIL import Image
fs=['e2-cur-banner','e2-cur-notice','e2-l-banner','e2-d-banner','e2-l-toast','e2-d-toast']
strips=['e2-l-s1-dirty','e2-l-s2-saving','e2-l-s2-err','e2-d-s1-dirty','e2-d-s2-saved','e2-d-s2-err']
ims=[Image.open(f+'.png').convert('RGB') for f in fs]+[Image.open(f+'.png').convert('RGB').crop((700,0,1440,48)) for f in strips]
H=sum(i.height for i in ims)+10*len(ims); s=Image.new('RGB',(1440,H),(200,60,60)); y=0
for i in ims: s.paste(i,(0,y)); y+=i.height+10
s.save('e2-sheet.png')"
```

```bash
S=/tmp/claude-1000/-home-user-hp-workspace-md2doc/21ed517f-03d4-42bc-9214-e92fa099fdbe/scratchpad/e1; N=/tmp/claude-1000/-home-user-hp-workspace-md2doc/cc552bfe-c005-4ece-b528-ad08d7b94e52/scratchpad/e2page; mkdir -p $N/img && cd $S && python3 -c "
from PIL import Image
import glob,os
for f in glob.glob('e2-*.png'):
  im=Image.open(f).convert('RGB')
  if '-s1-' in f or '-s2-' in f: im=im.crop((640,0,1440,48))
  im.save('$N/img/'+os.path.basename(f)[:-4]+'.png')
" && ls $N/img
```

```bash
S=/tmp/claude-1000/-home-user-hp-workspace-md2doc/21ed517f-03d4-42bc-9214-e92fa099fdbe/scratchpad/e1; cd $S/lucide && for n in type heading-1 heading-2 heading-3 square-check quote square-code sigma workflow git-fork activity pen-tool search; do [ -f $n.svg ] || curl -sf "https://unpkg.com/lucide-static@0.469.0/icons/$n.svg" -o $n.svg || echo miss $n; done; ls | wc -l
```

```bash
S=/tmp/claude-1000/-home-user-hp-workspace-md2doc/21ed517f-03d4-42bc-9214-e92fa099fdbe/scratchpad/e1; cd $S && cat > e3.js <<'EOF'
const fs = require('fs');
const { chromium } = require('/home/user/hp_workspace/md2doc/node_modules/playwright');
const { spawn } = require('child_process');
const { applyReaderTheme } = require('/home/user/hp_workspace/md2doc/lib/theme/tokens.js');
const { CSS, FIXES, svgMap, extra } = require('./bcss.js');
const ico = (n) => fs.readFileSync(__dirname + '/lucide/' + n + '.svg', 'utf8').replace(/<!--[^>]*-->/, '').trim();
const ITEMS = [
  ['基本', [['type', '文字', '一般段落', ''], ['heading-1', '標題 1', '章節大標', '#'], ['heading-2', '標題 2', '小節標題', '##'], ['heading-3', '標題 3', '更小的標題', '###']]],
  ['清單', [['list', '項目符號列表', '不分先後的條列', '-'], ['list-ordered', '編號列表', '有順序的步驟', '1.'], ['square-check', '待辦清單', '可勾選的項目', '[]']]],
  ['區塊', [['quote', '引用', '引述或備註', '>'], ['square-code', '程式碼', '等寬程式碼區塊', '```'], ['minus', '分隔線', '水平分隔', '---'], ['table', '表格', '3 欄 × 2 列', ''], ['image', '圖片', '上傳或貼上圖片', '']]],
  ['圖表', [['workflow', 'Mermaid 圖', '流程圖、時序圖', ''], ['git-fork', 'Graphviz 圖', 'dot 有向圖', ''], ['activity', 'WaveDrom 波形', '時序波形，可視覺編輯', ''], ['sigma', '數學公式', 'KaTeX 區塊公式', '$$']]],
];
const svg = {}; ITEMS.forEach(([, l]) => l.forEach(([i]) => { svg[i] = ico(i); }));
const E3CSS = `
.e-slash{position:absolute;z-index:200;width:280px;max-height:372px;overflow:auto;padding:6px;border-radius:8px;background:var(--e-surface);color:var(--e-ink);box-shadow:var(--e-ring);font-size:14px}
.e-slash .grp{font-size:12px;font-weight:600;color:var(--e-mut);padding:8px 8px 4px}
.e-slash .it{display:flex;align-items:center;gap:10px;height:32px;padding:0 8px;border-radius:6px}
.e-slash .it.on{background:var(--e-hover)}
.e-slash .it svg{width:16px;height:16px;flex:none;color:var(--e-mut);stroke-width:1.75}
.e-slash .it .nm{flex:1}
.e-slash .it kbd{font:12px ui-monospace,Consolas,monospace;color:var(--e-mut)}
.e-slash.m2{width:320px}
.e-slash.m2 .it{height:48px}
.e-slash.m2 .tile{width:32px;height:32px;border-radius:6px;display:grid;place-items:center;box-shadow:0 0 0 1px var(--e-rule);background:var(--e-bar)}
.e-slash.m2 .tx{display:grid;line-height:1.3;flex:1}.e-slash.m2 .ds{font-size:12px;color:var(--e-mut)}
.e-slash .foot{border-top:1px solid var(--e-rule);margin:6px -6px -6px;padding:6px 14px;font-size:12px;color:var(--e-mut)}
.e-ph::before{content:attr(data-ph);color:var(--e-glyph);pointer-events:none}
`;
function menuHtml(kind, filter) {
  let h = '';
  for (const [g, list] of ITEMS) {
    const items = list.filter((x) => !filter || x[1].includes(filter) || x[2].includes(filter));
    if (!items.length) continue;
    h += `<div class="grp">${g}</div>`;
    for (const [i, nm, ds, k] of items) {
      h += kind === 'm1'
        ? `<div class="it">${svg[i]}<span class="nm">${nm}</span><kbd>${k}</kbd></div>`
        : `<div class="it"><span class="tile">${svg[i]}</span><span class="tx"><span>${nm}</span><span class="ds">${ds}</span></span><kbd>${k}</kbd></div>`;
    }
  }
  return h + '<div class="foot">↑↓ 選擇　Enter 插入　Esc 關閉</div>';
}
(async () => {
  const port = 47171;
  const srv = spawn('node', ['/home/user/hp_workspace/md2doc/bin/md2doc.js', '--edit', '--no-open', '--port', String(port), 'doc/mac-tx-core.md', 'empty.md'], { cwd: __dirname });
  await new Promise((r) => setTimeout(r, 3000));
  const b = await chromium.launch(); const errs = [];
  for (const theme of ['light', 'dark']) {
    const T = theme[0];
    const ctx = await b.newContext({ viewport: { width: 1440, height: 900 } });
    await ctx.addInitScript((t) => { try { localStorage.setItem('md2doc-theme', t); } catch (e) {} }, theme);
    const p = await ctx.newPage(); p.on('pageerror', (e) => errs.push(theme + ': ' + e.message));
    await p.route('**/edit/*', async (route) => { const r = await route.fetch(); route.fulfill({ response: r, body: applyReaderTheme(await r.text()) }); });
    const prep = async () => {
      await p.addStyleTag({ content: CSS + FIXES + E3CSS });
      await p.evaluate(([m, x]) => {
        document.querySelectorAll('[data-ed-tb]').forEach((btn) => { const k = btn.getAttribute('data-ed-tb'); if (m[k]) btn.innerHTML = m[k]; });
        document.querySelectorAll('.ed-handle').forEach((h) => { h.innerHTML = x.grip; });
        document.querySelectorAll('.ed-insert').forEach((h) => { h.innerHTML = x.plus; });
      }, [svgMap, extra]);
    };
    await p.goto(`http://127.0.0.1:${port}/edit/0`); await p.waitForTimeout(3500); await prep();
    // a fake new paragraph after the "1 Introduction" body paragraph
    const setup = async (text, ph) => p.evaluate(([text, ph]) => {
      document.querySelectorAll('.e-fake,.e-slash').forEach((e) => e.remove());
      const h = [...document.querySelectorAll('.ed-block')].find((b) => /^1 Introduction/.test(b.textContent.trim()));
      const para = h.nextElementSibling;
      const f = para.cloneNode(true); f.classList.add('e-fake');
      const ed = f.querySelector('[contenteditable]') || f; ed.querySelectorAll('*:not(.ed-handle):not(.ed-insert)').forEach(() => {});
      ed.textContent = text; if (ph) { ed.classList.add('e-ph'); ed.setAttribute('data-ph', ph); }
      para.after(f); f.scrollIntoView({ block: 'center' });
      ed.focus(); const r = document.createRange(); r.selectNodeContents(ed); r.collapse(false); const s = getSelection(); s.removeAllRanges(); s.addRange(r);
      return true;
    }, [text, ph]);
    const menu = async (kind, filter) => p.evaluate(([h, kind]) => {
      const f = document.querySelector('.e-fake'); const r = f.getBoundingClientRect();
      const m = document.createElement('div'); m.className = 'e-slash ' + kind; m.innerHTML = h;
      m.style.left = (r.left + scrollX) + 'px'; m.style.top = (r.bottom + scrollY + 6) + 'px';
      document.body.appendChild(m); m.querySelector('.it').classList.add('on');
    }, [menuHtml(kind, filter), kind]);
    await setup('', '輸入文字，或按「/」選擇區塊'); await p.waitForTimeout(300);
    await p.screenshot({ path: `e3-${T}-ph.png` });
    for (const kind of ['m1', 'm2']) {
      await setup('/', ''); await menu(kind, ''); await p.waitForTimeout(300); await p.screenshot({ path: `e3-${T}-${kind}.png` });
      await setup('/圖', ''); await menu(kind, '圖'); await p.waitForTimeout(300); await p.screenshot({ path: `e3-${T}-${kind}-filter.png` });
    }
    // empty document
    await p.goto(`http://127.0.0.1:${port}/edit/1`); await p.waitForTimeout(3000); await prep();
    await p.screenshot({ path: `e3-${T}-emptycur.png` });
    await p.evaluate(() => {
      const c = document.querySelector('.content');
      const d = document.createElement('div'); d.className = 'ed-block'; d.style.cssText = 'padding:2px 0';
      const e = document.createElement('p'); e.className = 'ed-wys-armed e-ph'; e.setAttribute('data-ph', '從這裡開始輸入，或按「/」選擇區塊'); e.contentEditable = 'true'; e.style.margin = '0';
      d.appendChild(e); c.appendChild(d); e.focus();
    });
    await p.waitForTimeout(300); await p.screenshot({ path: `e3-${T}-empty.png` });
    await ctx.close();
  }
  console.log('errors', errs.length ? errs : 'none'); await b.close(); srv.kill();
})();
EOF
FONTCONFIG_FILE=$S/fonts.conf node e3.js && ls e3-*.png | wc -l
```

```bash
S=/tmp/claude-1000/-home-user-hp-workspace-md2doc/21ed517f-03d4-42bc-9214-e92fa099fdbe/scratchpad/e1; cd $S && python3 -c "
from PIL import Image
fs=['e3-l-m1','e3-d-m1','e3-l-m2','e3-d-m2-filter','e3-l-ph','e3-d-empty']
ims=[Image.open(f+'.png').convert('RGB').resize((720,450)) for f in fs]
s=Image.new('RGB',(1450,1380),(200,60,60))
for i,im in enumerate(ims): s.paste(im,((i%2)*730,(i//2)*460))
s.save('e3-sheet.png')"
```

```bash
S=/tmp/claude-1000/-home-user-hp-workspace-md2doc/21ed517f-03d4-42bc-9214-e92fa099fdbe/scratchpad/e1; cd $S && python3 -c "
from PIL import Image
a=Image.open('e3-l-emptycur.png').resize((720,450)); b=Image.open('e3-l-empty.png').resize((720,450))
s=Image.new('RGB',(1450,450),(200,60,60)); s.paste(a,(0,0)); s.paste(b,(730,0)); s.save('e3-empty-zoom.png')"
```

```bash
S=/tmp/claude-1000/-home-user-hp-workspace-md2doc/21ed517f-03d4-42bc-9214-e92fa099fdbe/scratchpad/e1; cd $S && cat > emptyprobe.js <<'EOF'
const { chromium } = require('/home/user/hp_workspace/md2doc/node_modules/playwright');
const { spawn } = require('child_process');
(async () => {
  const srv = spawn('node', ['/home/user/hp_workspace/md2doc/bin/md2doc.js', '--edit', '--no-open', '--port', '47181', 'empty.md', 'short.md'], { cwd: __dirname });
  await new Promise((r) => setTimeout(r, 2500));
  const b = await chromium.launch(); const p = await (await b.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
  for (const i of [0, 1]) {
    await p.goto('http://127.0.0.1:47181/edit/' + i); await p.waitForTimeout(2500);
    console.log(i, JSON.stringify(await p.evaluate(() => { const r = (s) => { const e = document.querySelector(s); if (!e) return null; const x = e.getBoundingClientRect(); return [Math.round(x.left), Math.round(x.top), Math.round(x.width), Math.round(x.height), getComputedStyle(e).display]; };
      return { content: r('.content'), sidebar: r('.sidebar'), layout: r('.page-layout'), bodyCls: document.body.className }; })));
  }
  await b.close(); srv.kill();
})();
EOF
node emptyprobe.js
```

```bash
S=/tmp/claude-1000/-home-user-hp-workspace-md2doc/21ed517f-03d4-42bc-9214-e92fa099fdbe/scratchpad/e1; cd $S && sed -i "s/para.after(f); f.scrollIntoView({ block: 'center' });/para.after(f); f.scrollIntoView({ block: 'start' }); scrollBy(0, -300);/" e3.js && grep -c "scrollBy(0, -300)" e3.js && FONTCONFIG_FILE=$S/fonts.conf node e3.js && python3 -c "
from PIL import Image
fs=['e3-l-m1','e3-d-m2-filter']
ims=[Image.open(f+'.png').convert('RGB').resize((720,450)) for f in fs]
s=Image.new('RGB',(1450,450),(200,60,60))
for i,im in enumerate(ims): s.paste(im,(i*730,0))
s.save('e3-sheet2.png')"
```

```bash
S=/tmp/claude-1000/-home-user-hp-workspace-md2doc/21ed517f-03d4-42bc-9214-e92fa099fdbe/scratchpad/e1; N=/tmp/claude-1000/-home-user-hp-workspace-md2doc/cc552bfe-c005-4ece-b528-ad08d7b94e52/scratchpad; mkdir -p $N/e3page/img && cd $S && python3 - <<'EOF'
from PIL import Image
import glob,os
N='/tmp/claude-1000/-home-user-hp-workspace-md2doc/cc552bfe-c005-4ece-b528-ad08d7b94e52/scratchpad'
for f in glob.glob('e3-[ld]-*.png'):
  Image.open(f).convert('RGB').save(N+'/e3page/img/'+os.path.basename(f)[:-4]+'.jpg',quality=84)
e1=open(N+'/e1page/editor-e1.html').read()
style=e1[e1.index('<style>'):e1.index('</style>')+8]
def pair(name,cap):
  out=''
  for t,tn in (('l','淺色'),('d','深色')):
    out+='<figure><button class="shot" type="button" aria-label="放大：%s %s"><img src="img/e3-%s-%s.jpg" alt="%s %s" width="1440" height="900" loading="lazy"></button><figcaption><b>%s</b> %s</figcaption></figure>'%(cap,tn,t,name,cap,tn,cap,tn)
  return '<div class="shots shots2">'+out+'</div>'
rows=[('Enter','送出並離開這一段，沒辦法接著寫下一段','在游標處切成兩段，游標跳到新段落開頭；Shift+Enter 仍是段內換行'),
('段首 Backspace','沒有特別處理','跟上一段合併；標題或清單項目在段首先變回一般段落，再按一次才合併'),
('段首打 Markdown 符號','不會轉換，要靠 ⠿ 轉換成或工具列','打 <code># </code> <code>## </code> <code>### </code> <code>- </code> <code>1. </code> <code>[] </code> <code>&gt; </code> <code>```</code> <code>---</code> 立刻轉成對應區塊；馬上 Ctrl+Z 會還原成原本打的字'),
('「/」選單','沒有','空段落或空白後打「/」叫出選單，可用中英文篩選（「表」「圖」「h2」「code」），↑↓ 選、Enter 插入、Esc 關閉'),
('點文件下方空白處','沒反應','在最後新增一個段落並把游標放進去'),
('空白文件','0 個區塊，什麼都不能做（你回報的缺陷）','開啟時就有一個空段落，顯示提示文字'),
('空段落提示','沒有','游標所在的空段落顯示淡灰提示「輸入文字，或按「/」選擇區塊」')]
tbl=''.join('<tr><td>%s</td><td>%s</td><td>%s</td></tr>'%r for r in rows)
body='<title>編輯器 E3 打字手感</title>\n'+style+'''
<main>
  <header>
    <h1>編輯器 E3：打字手感</h1>
    <p class="lede">這一項跟 Notion 差最多。行為部分大多是 Notion 的標準做法，請確認有沒有要改的；外觀要決定的是「/」選單的樣式。原型套在 E1 定案的 B 淺色紙面上，淺色深色各一份。</p>
  </header>
  <section class="row" aria-labelledby="h1"><h2 id="h1">行為改動</h2>
    <div class="tw"><table><thead><tr><th>操作</th><th>目前</th><th>改成</th></tr></thead><tbody>'''+tbl+'''</tbody></table></div>
  </section>
  <section class="row" aria-labelledby="h2"><h2 id="h2">「/」選單樣式</h2>
    <div class="opts">
      <div class="opt rec"><h3>M1 精簡單行 <span class="tag">推薦</span></h3><ul><li>每項 32px：圖示＋名稱＋右側對應的 Markdown 符號</li><li>分組：基本、清單、區塊、圖表；共 15 項</li><li>底部一行按鍵提示</li></ul></div>
      <div class="opt"><h3>M2 雙行附說明</h3><ul><li>每項 48px：圖示方塊＋名稱＋一行說明（BlockNote 的做法）</li><li>新手比較看得懂，但一次只看得到約 7 項</li></ul></div>
    </div>
    <h3 style="font-size:14px;margin:4px 0 0">M1：剛打「/」</h3>'''+pair('m1','M1')+'''
    <h3 style="font-size:14px;margin:4px 0 0">M1：打「/圖」篩選</h3>'''+pair('m1-filter','M1 篩選')+'''
    <h3 style="font-size:14px;margin:4px 0 0">M2：剛打「/」</h3>'''+pair('m2','M2')+'''
    <h3 style="font-size:14px;margin:4px 0 0">M2：打「/圖」篩選</h3>'''+pair('m2-filter','M2 篩選')+'''
    <p class="note">推薦 M1 的理由：一、一次看得到約 10 項，15 項幾乎不用捲；M2 每項高 1.5 倍。二、右側的 <code>#</code> <code>-</code> <code>```</code> 順便教會上面的 Markdown 自動轉換，熟了就不用叫選單。三、跟 E1 的白底選單同一個尺寸與圓角。</p>
  </section>
  <section class="row" aria-labelledby="h3"><h2 id="h3">空段落與空白文件</h2>
    <h3 style="font-size:14px;margin:4px 0 0">段落中新增的空段落</h3>'''+pair('ph','空段落提示')+'''
    <h3 style="font-size:14px;margin:4px 0 0">空白文件：目前（什麼都沒有）</h3>'''+pair('emptycur','空白文件目前')+'''
    <h3 style="font-size:14px;margin:4px 0 0">空白文件：改成開啟就有一個空段落</h3>'''+pair('empty','空白文件改後')+'''
  </section>
</main>
<div id="lb" hidden><img alt=""></div>
<script>
(function(){
  var lb=document.getElementById('lb'), li=lb.querySelector('img');
  document.addEventListener('click',function(e){
    var b=e.target.closest('.shot'); if(b){li.src=b.querySelector('img').src; lb.hidden=false; return;}
    if(!lb.hidden && lb.contains(e.target)) lb.hidden=true;
  });
  document.addEventListener('keydown',function(e){ if(e.key==='Escape') lb.hidden=true; });
})();
</script>
'''
open(N+'/e3page/editor-e3.html','w').write(body)
import json
print(json.dumps({'img/'+f:'img/'+f for f in sorted(os.listdir(N+'/e3page/img'))}))
EOF
```

```bash
S=/tmp/claude-1000/-home-user-hp-workspace-md2doc/21ed517f-03d4-42bc-9214-e92fa099fdbe/scratchpad/e1; cd $S && cat > e4probe.js <<'EOF'
const { chromium } = require('/home/user/hp_workspace/md2doc/node_modules/playwright');
const { spawn } = require('child_process');
(async () => {
  const srv = spawn('node', ['/home/user/hp_workspace/md2doc/bin/md2doc.js', '--edit', '--no-open', '--port', '47191', 'doc/mac-tx-core.md'], { cwd: __dirname });
  await new Promise((r) => setTimeout(r, 3000));
  const b = await chromium.launch(); const p = await (await b.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
  await p.goto('http://127.0.0.1:47191/edit/0'); await p.waitForTimeout(3500);
  console.log(JSON.stringify(await p.evaluate(() => {
    const out = {};
    for (const t of ['paragraph', 'heading', 'li', 'table', 'code']) {
      const bl = [...document.querySelectorAll('.ed-block')].find((b) => (b.getAttribute('data-block-type') || '') === t || (t === 'table' && b.querySelector('table')) || (t === 'code' && b.querySelector('pre')));
      if (!bl) { out[t] = null; continue; }
      const R = (e) => { if (!e) return null; const x = e.getBoundingClientRect(), B = bl.getBoundingClientRect(); return [Math.round(x.left - B.left), Math.round(x.top - B.top), Math.round(x.width), Math.round(x.height)]; };
      const lh = parseFloat(getComputedStyle(bl.querySelector('[contenteditable]') || bl).lineHeight);
      out[t] = { type: bl.getAttribute('data-block-type'), handle: R(bl.querySelector(':scope > .ed-handle, .ed-handle')), insert: R(bl.querySelector('.ed-insert')), lineH: lh, shift: getComputedStyle(bl).getPropertyValue('--ed-gutter-shift') };
    }
    return out;
  })));
  await b.close(); srv.kill();
})();
EOF
node e4probe.js
```

```bash
S=/tmp/claude-1000/-home-user-hp-workspace-md2doc/21ed517f-03d4-42bc-9214-e92fa099fdbe/scratchpad/e1; cd $S && awk '/^const ITEMS = \[/{p=1} /^\(async/{p=0} p' e3.js > slash.js && sed -i '1i const fs = require("fs");\nconst ico = (n) => fs.readFileSync(__dirname + "/lucide/" + n + ".svg", "utf8").replace(/<!--[^>]*-->/, "").trim();' slash.js && echo 'module.exports = { E3CSS, menuHtml };' >> slash.js && node -e "const m=require('./slash.js');console.log(m.menuHtml('m1','').length)"
cat > e4.js <<'EOF'
const { chromium } = require('/home/user/hp_workspace/md2doc/node_modules/playwright');
const { spawn } = require('child_process');
const { applyReaderTheme } = require('/home/user/hp_workspace/md2doc/lib/theme/tokens.js');
const { CSS, FIXES, svgMap, extra } = require('./bcss.js');
const { E3CSS, menuHtml } = require('./slash.js');
const ALIGN = `.ed-handle,.ed-insert{width:24px!important;height:24px!important}.ed-handle svg,.ed-insert svg{width:16px;height:16px}
.ed-insert{left:-58px!important}.ed-handle{left:-34px!important}`;
(async () => {
  const port = 47201;
  const srv = spawn('node', ['/home/user/hp_workspace/md2doc/bin/md2doc.js', '--edit', '--no-open', '--port', String(port), 'doc/mac-tx-core.md'], { cwd: __dirname });
  await new Promise((r) => setTimeout(r, 3000));
  const b = await chromium.launch(); const errs = [];
  for (const theme of ['light', 'dark']) {
    const T = theme[0];
    for (const v of ['cur', 'new']) {
      const ctx = await b.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 });
      await ctx.addInitScript((t) => { try { localStorage.setItem('md2doc-theme', t); } catch (e) {} }, theme);
      const p = await ctx.newPage(); p.on('pageerror', (e) => errs.push(theme + ': ' + e.message));
      await p.route('**/edit/*', async (route) => { const r = await route.fetch(); route.fulfill({ response: r, body: applyReaderTheme(await r.text()) }); });
      await p.goto(`http://127.0.0.1:${port}/edit/0`); await p.waitForTimeout(3500);
      await p.addStyleTag({ content: CSS + FIXES + E3CSS + (v === 'new' ? ALIGN : '') });
      await p.evaluate(([m, x, v]) => {
        document.querySelectorAll('[data-ed-tb]').forEach((btn) => { const k = btn.getAttribute('data-ed-tb'); if (m[k]) btn.innerHTML = m[k]; });
        document.querySelectorAll('.ed-block').forEach((bl) => {
          const h = bl.querySelector('.ed-handle'), i = bl.querySelector('.ed-insert'); if (h) h.innerHTML = x.grip; if (i) i.innerHTML = x.plus;
          if (v === 'new') { const ed = bl.querySelector('[contenteditable], h1,h2,h3,h4,p,li,td') || bl; const lh = parseFloat(getComputedStyle(ed).lineHeight) || 24;
            const off = ed.getBoundingClientRect().top - bl.getBoundingClientRect().top; const top = off + (lh - 24) / 2;
            if (h) h.style.setProperty('top', top + 'px', 'important'); if (i) i.style.setProperty('top', top + 'px', 'important'); }
        });
      }, [svgMap, extra, v]);
      // hover heading "1 Introduction" and the paragraph under it, crop gutter region
      const pos = await p.evaluate(() => { const h = [...document.querySelectorAll('.ed-block')].find((b) => /^1 Introduction/.test(b.textContent.trim())); h.scrollIntoView({ block: 'start' }); scrollBy(0, -200);
        const r = h.getBoundingClientRect(); const pr = h.nextElementSibling.getBoundingClientRect(); return { hx: r.left + 60, hy: r.top + 10, px: pr.left + 60, py: pr.top + 8, left: r.left, top: r.top }; });
      await p.mouse.move(pos.hx, pos.hy); await p.waitForTimeout(300);
      await p.screenshot({ path: `e4-${T}-${v}-hh.png`, clip: { x: pos.left - 90, y: pos.top - 30, width: 560, height: 110 } });
      await p.mouse.move(pos.px, pos.py); await p.waitForTimeout(300);
      await p.screenshot({ path: `e4-${T}-${v}-hp.png`, clip: { x: pos.left - 90, y: pos.top + 30, width: 560, height: 110 } });
      // click + on the paragraph
      const ins = await p.evaluate(() => { const h = [...document.querySelectorAll('.ed-block')].find((b) => /^1 Introduction/.test(b.textContent.trim())); const i = h.nextElementSibling.querySelector('.ed-insert').getBoundingClientRect(); return { x: i.left + i.width / 2, y: i.top + i.height / 2 }; });
      if (v === 'cur') {
        await p.mouse.click(ins.x, ins.y); await p.waitForTimeout(400);
      } else {
        await p.evaluate((h) => {
          const hd = [...document.querySelectorAll('.ed-block')].find((b) => /^1 Introduction/.test(b.textContent.trim())); const para = hd.nextElementSibling;
          const f = para.cloneNode(true); f.classList.add('e-fake'); const ed = f.querySelector('[contenteditable]') || f; ed.textContent = '/'; para.after(f);
          ed.focus(); const r = document.createRange(); r.selectNodeContents(ed); r.collapse(false); getSelection().removeAllRanges(); getSelection().addRange(r);
          const fr = f.getBoundingClientRect(); const m = document.createElement('div'); m.className = 'e-slash m1'; m.innerHTML = h;
          m.style.left = (fr.left + scrollX) + 'px'; m.style.top = (fr.bottom + scrollY + 6) + 'px'; document.body.appendChild(m); m.querySelector('.it').classList.add('on');
        }, menuHtml('m1', '')); await p.waitForTimeout(300);
      }
      await p.screenshot({ path: `e4-${T}-${v}-plus.png` });
      await ctx.close();
    }
  }
  console.log('errors', errs.length ? errs : 'none'); await b.close(); srv.kill();
})();
EOF
FONTCONFIG_FILE=$S/fonts.conf node e4.js && python3 -c "
from PIL import Image
fs=['e4-l-cur-hh','e4-l-new-hh','e4-l-cur-hp','e4-l-new-hp','e4-d-cur-hh','e4-d-new-hh']
ims=[Image.open(f+'.png').convert('RGB') for f in fs]
w,h=ims[0].size; s=Image.new('RGB',(2*w+10,3*h+20),(200,60,60))
for i,im in enumerate(ims): s.paste(im,((i%2)*(w+10),(i//2)*(h+10)))
s.save('e4-sheet.png')"
```

```bash
S=/tmp/claude-1000/-home-user-hp-workspace-md2doc/21ed517f-03d4-42bc-9214-e92fa099fdbe/scratchpad/e1; cd $S && python3 -c "
from PIL import Image
a=Image.open('e4-l-cur-plus.png').convert('RGB').crop((300,100,1700,900)).resize((700,400)); b=Image.open('e4-d-new-plus.png').convert('RGB').crop((300,100,1700,900)).resize((700,400))
s=Image.new('RGB',(1410,400),(200,60,60)); s.paste(a,(0,0)); s.paste(b,(710,0)); s.save('e4-plus-sheet.png')"
```

```bash
S=/tmp/claude-1000/-home-user-hp-workspace-md2doc/21ed517f-03d4-42bc-9214-e92fa099fdbe/scratchpad/e1; cd $S && python3 - <<'EOF'
from PIL import Image
import os,json
N='/tmp/claude-1000/-home-user-hp-workspace-md2doc/cc552bfe-c005-4ece-b528-ad08d7b94e52/scratchpad'
os.makedirs(N+'/e4page/img',exist_ok=True)
for t in 'ld':
  for v in ('cur','new'):
    for k in ('hh','hp'):
      Image.open('e4-%s-%s-%s.png'%(t,v,k)).convert('RGB').save(N+'/e4page/img/e4-%s-%s-%s.png'%(t,v,k))
    Image.open('e4-%s-%s-plus.png'%(t,v)).convert('RGB').resize((1440,900)).save(N+'/e4page/img/e4-%s-%s-plus.jpg'%(t,v),quality=84)
e1=open(N+'/e1page/editor-e1.html').read()
style=e1[e1.index('<style>'):e1.index('</style>')+8]
def fig(src,cap,w,h): return '<figure><button class="shot" type="button" aria-label="放大：%s"><img src="img/%s" alt="%s" width="%d" height="%d" loading="lazy"></button><figcaption>%s</figcaption></figure>'%(cap,src,cap,w,h,cap)
def quad(k,lab):
  return '<div class="shots">'+''.join(fig('e4-%s-%s-%s.png'%(t,v,k),'%s %s %s'%(vn,tn,lab),1120,220) for t,tn in (('l','淺色'),('d','深色')) for v,vn in (('cur','目前'),('new','改後')))+'</div>'
def plus(): return '<div class="shots">'+''.join(fig('e4-%s-%s-plus.jpg'%(t,v),'%s %s'%(vn,tn),1440,900) for t,tn in (('l','淺色'),('d','深色')) for v,vn in (('cur','P1 目前：5 種膠囊'),('new','P2 新段落＋「/」選單')))+'</div>'
body='<title>編輯器 E4 把手與插入</title>\n'+style+'''
<main>
  <header><h1>編輯器 E4：⠿ 把手與 ＋ 插入</h1>
  <p class="lede">滑過區塊時左側出現的 ＋ 與 ⠿。原型套在 B 淺色紙面上，淺色深色各一份；上兩組是 2 倍放大的局部截圖。</p></header>

  <section class="row" aria-labelledby="h1"><h2 id="h1">一、位置與大小（修正）</h2>
    <p class="note">量到的現況：兩顆都貼在區塊頂端（<code>top: 0</code>），按鈕 18×20px。標題第一行高 49.5px，所以 ＋ ⠿ 浮在標題的上緣，跟文字對不齊。改成：置中在第一行文字、點擊範圍 24×24px（參考的四個編輯器是 24×24 到 24×32）、圖示 16px。</p>
    <h3 style="font-size:14px;margin:4px 0 0">滑過標題</h3>'''+quad('hh','標題')+'''
    <h3 style="font-size:14px;margin:4px 0 0">滑過段落</h3>'''+quad('hp','段落')+'''
  </section>

  <section class="row" aria-labelledby="h2"><h2 id="h2">二、點 ＋ 之後</h2>
    <div class="opts">
      <div class="opt"><h3>P1 維持 5 種膠囊</h3><ul><li>段落、標題、清單、表格、程式碼，插在下方</li><li>膠囊會蓋住這一段的文字；沒有引用、分隔線、圖片、圖表</li></ul></div>
      <div class="opt rec"><h3>P2 新增空段落＋開「/」選單 <span class="tag">推薦</span></h3><ul><li>在下方插入空段落，游標放進去，直接打開 E3 的「/」選單（15 項）</li><li>不想選就繼續打字，當一般段落用；Esc 關選單</li><li>按住 Alt 點 ＋ 改插在上方（Notion 的做法）</li></ul></div>
    </div>'''+plus()+'''
    <p class="note">推薦 P2 的理由：一、＋ 和「/」變成同一份清單，不用記兩套，＋ 也一次拿到全部 15 種區塊。二、新段落出現在原文下方、選單往下展開，不再蓋住原本那段文字。</p>
  </section>

  <section class="row" aria-labelledby="h3"><h2 id="h3">三、⠿ 選單內容（不變）</h2>
    <p class="note">轉換成 ›、建立副本、刪除、MD 原始碼四項維持，外觀照 E1 換成白底選單（E1 頁的「⠿ 區塊選單」截圖）。轉換成的子選單沿用「/」選單的圖示，兩邊同一套。</p>
  </section>
</main>
<div id="lb" hidden><img alt=""></div>
<script>
(function(){
  var lb=document.getElementById('lb'), li=lb.querySelector('img');
  document.addEventListener('click',function(e){
    var b=e.target.closest('.shot'); if(b){li.src=b.querySelector('img').src; lb.hidden=false; return;}
    if(!lb.hidden && lb.contains(e.target)) lb.hidden=true;
  });
  document.addEventListener('keydown',function(e){ if(e.key==='Escape') lb.hidden=true; });
})();
</script>
'''
open(N+'/e4page/editor-e4.html','w').write(body)
print(json.dumps({'img/'+f:'img/'+f for f in sorted(os.listdir(N+'/e4page/img'))}))
EOF
```

```bash
p=/home/user/.claude-official/projects/-home-user-hp-workspace-md2doc/memory/editor-review-decisions.md; python3 - "$p" <<'EOF'
import sys;p=sys.argv[1];s=open(p).read()
s=s.replace("\n**Why:**","- E4（https://claude.ai/artifact/JABc8UEdrTDtgNJegGQQEC）：＋ ⠿ 置中在第一行文字、24×24 點擊區、16px 圖示；點 ＋ = 下方插入空段落並開同一份「/」選單（使用者：「＋的行為跟 / 應該一樣的表單，不需要額外設計一種顯示」）；Alt+點插上方；⠿ 選單四項不變。\n\n**Why:**",1)
open(p,'w').write(s)
EOF
S=/tmp/claude-1000/-home-user-hp-workspace-md2doc/21ed517f-03d4-42bc-9214-e92fa099fdbe/scratchpad/e1; cd $S && cat > e5probe.js <<'EOF'
const { chromium } = require('/home/user/hp_workspace/md2doc/node_modules/playwright');
const { spawn } = require('child_process');
(async () => {
  const srv = spawn('node', ['/home/user/hp_workspace/md2doc/bin/md2doc.js', '--edit', '--no-open', '--port', '47211', 'doc/mac-tx-core.md'], { cwd: __dirname });
  await new Promise((r) => setTimeout(r, 3000));
  const b = await chromium.launch(); const p = await (await b.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
  await p.goto('http://127.0.0.1:47211/edit/0'); await p.waitForTimeout(4000);
  console.log(JSON.stringify(await p.evaluate(() => {
    const types = {}; const deg = {}; const why = {};
    document.querySelectorAll('.content .ed-block').forEach((bl) => {
      const t = bl.getAttribute('data-block-type') || '?'; types[t] = (types[t] || 0) + 1;
      if (['paragraph', 'heading', 'li'].includes(t) && !bl.querySelector('.ed-wys-armed')) {
        deg[t] = (deg[t] || 0) + 1;
        const tags = new Set([...bl.querySelectorAll('*')].map((e) => e.tagName.toLowerCase() + (e.className && typeof e.className === 'string' ? '.' + e.className.split(' ')[0] : '')).filter((x) => !/^(button|svg|path|line|circle|rect|polyline|span\.ed-|div\.ed-)/.test(x)));
        tags.forEach((x) => { why[x] = (why[x] || 0) + 1; });
      }
    });
    return { types, deg, why };
  })));
  await b.close(); srv.kill();
})();
EOF
node e5probe.js
```

```bash
S=/tmp/claude-1000/-home-user-hp-workspace-md2doc/21ed517f-03d4-42bc-9214-e92fa099fdbe/scratchpad/e1; cd $S && sed -i "s/return { types, deg, why };/const ex=[...document.querySelectorAll('.content .ed-block[data-block-type=li]')].filter(b=>!b.querySelector('.ed-wys-armed')).slice(0,3).map(b=>b.outerHTML.replace(\/<svg[\\\\s\\\\S]*?<\\\\\/svg>\/g,'').slice(0,500)); return { ex };/" e5probe.js && node e5probe.js | head -c 2000; grep -n '\](#\|^- .*\[' doc/mac-tx-core.md | head -5
```

```bash
S=/tmp/claude-1000/-home-user-hp-workspace-md2doc/21ed517f-03d4-42bc-9214-e92fa099fdbe/scratchpad/e1; cd $S/lucide && for n in external-link pencil unlink corner-down-left; do [ -f $n.svg ] || curl -sf "https://unpkg.com/lucide-static@0.469.0/icons/$n.svg" -o $n.svg || echo miss $n; done; cd /home/user/hp_workspace/md2doc && sed -n 14322,14400p lib/editor/client.js | grep -a -n "className\|textContent\|data-" | head -20
```

```bash
S=/tmp/claude-1000/-home-user-hp-workspace-md2doc/21ed517f-03d4-42bc-9214-e92fa099fdbe/scratchpad/e1; cd $S && cat > e5.js <<'EOF'
const fs = require('fs');
const { chromium } = require('/home/user/hp_workspace/md2doc/node_modules/playwright');
const { spawn } = require('child_process');
const { applyReaderTheme } = require('/home/user/hp_workspace/md2doc/lib/theme/tokens.js');
const { CSS, FIXES, svgMap, extra } = require('./bcss.js');
const ico = (n) => fs.readFileSync(__dirname + '/lucide/' + n + '.svg', 'utf8').replace(/<!--[^>]*-->/, '').trim();
const SEL = ['bold', 'italic', 'strikethrough', 'underline', 'code', 'link'].map(ico);
const I = { link: ico('link'), ext: ico('external-link'), pen: ico('pencil'), unlink: ico('unlink'), enter: ico('corner-down-left') };
const E5CSS = `
.ed-seltb.e-icons .ed-seltb-btn{width:30px!important;height:30px!important;display:inline-grid!important;place-items:center!important;padding:0!important;color:var(--e-mut)!important}
.ed-seltb.e-icons .ed-seltb-btn:hover{color:var(--e-ink)!important}
.ed-seltb.e-icons .ed-seltb-btn svg{width:16px;height:16px;stroke-width:2}
.ed-seltb.e-icons{padding:3px!important;gap:2px!important}
.ed-seltb .e-sep{width:1px;height:18px;background:var(--e-rule);margin:0 3px;align-self:center}
.e-linkbar{position:absolute;z-index:300;display:flex;align-items:center;gap:6px;padding:4px 4px 4px 10px;width:360px;border-radius:8px;background:var(--e-surface);box-shadow:var(--e-ring);color:var(--e-ink)}
.e-linkbar svg{width:16px;height:16px;color:var(--e-mut);flex:none}
.e-linkbar input{flex:1;min-width:0;border:0;outline:0;background:transparent;color:var(--e-ink);font:14px/1.4 inherit;padding:4px 0}
.e-linkbar input::placeholder{color:var(--e-glyph)}
.e-linkbar button{display:inline-flex;align-items:center;gap:4px;border:0;border-radius:6px;padding:5px 10px;font:600 13px inherit;background:var(--e-accent);color:var(--e-surface)}
.e-linkbar button svg{color:inherit;width:14px;height:14px}
.e-linkcard{position:absolute;z-index:300;display:flex;align-items:center;gap:2px;padding:4px 4px 4px 10px;border-radius:8px;background:var(--e-surface);box-shadow:var(--e-ring);color:var(--e-ink);font-size:13px}
.e-linkcard .u{color:var(--e-accent);max-width:260px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;margin-right:6px}
.e-linkcard button{width:28px;height:28px;display:grid;place-items:center;border:0;border-radius:6px;background:transparent;color:var(--e-mut)}
.e-linkcard button:first-of-type{background:var(--e-hover)}
.e-linkcard svg{width:15px;height:15px}
`;
(async () => {
  const port = 47221;
  const srv = spawn('node', ['/home/user/hp_workspace/md2doc/bin/md2doc.js', '--edit', '--no-open', '--port', String(port), 'doc/mac-tx-core.md'], { cwd: __dirname });
  await new Promise((r) => setTimeout(r, 3000));
  const b = await chromium.launch(); const errs = [];
  for (const theme of ['light', 'dark']) {
    const T = theme[0];
    const ctx = await b.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 });
    await ctx.addInitScript((t) => { try { localStorage.setItem('md2doc-theme', t); } catch (e) {} }, theme);
    const p = await ctx.newPage(); p.on('pageerror', (e) => errs.push(theme + ': ' + e.message));
    await p.route('**/edit/*', async (route) => { const r = await route.fetch(); route.fulfill({ response: r, body: applyReaderTheme(await r.text()) }); });
    await p.goto(`http://127.0.0.1:${port}/edit/0`); await p.waitForTimeout(3500);
    await p.addStyleTag({ content: CSS + FIXES + E5CSS });
    await p.evaluate(([m, x]) => {
      document.querySelectorAll('[data-ed-tb]').forEach((btn) => { const k = btn.getAttribute('data-ed-tb'); if (m[k]) btn.innerHTML = m[k]; });
      document.querySelectorAll('.ed-handle').forEach((h) => { h.innerHTML = x.grip; }); document.querySelectorAll('.ed-insert').forEach((h) => { h.innerHTML = x.plus; });
    }, [svgMap, extra]);
    const pos = await p.evaluate(() => { const h = [...document.querySelectorAll('.ed-block')].find((b) => /^1 Introduction/.test(b.textContent.trim())); const para = h.nextElementSibling;
      para.scrollIntoView({ block: 'start' }); scrollBy(0, -250); const ed = para.querySelector('[contenteditable]');
      // select the text "IEEE 802.3-2022"
      const tw = document.createTreeWalker(ed, NodeFilter.SHOW_TEXT); let n; while ((n = tw.nextNode())) { const i = n.data.indexOf('IEEE 802.3'); if (i >= 0) { const r = ed.getBoundingClientRect(); const rr = document.createRange(); rr.setStart(n, i); rr.setEnd(n, i + 15); const q = rr.getBoundingClientRect(); return { x1: q.left + 1, x2: q.right - 1, y: q.top + q.height / 2, L: r.left, T: q.top }; } } });
    await p.mouse.move(pos.x1, pos.y); await p.mouse.down(); await p.mouse.move(pos.x2, pos.y, { steps: 5 }); await p.mouse.up(); await p.waitForTimeout(500);
    const clip = { x: pos.L - 40, y: pos.T - 90, width: 760, height: 170 };
    await p.screenshot({ path: `e5-${T}-cur.png`, clip });
    await p.evaluate((S) => { const tb = document.querySelector('.ed-seltb'); tb.classList.add('e-icons'); const bs = tb.querySelectorAll('.ed-seltb-btn');
      bs.forEach((b, i) => { if (S[i]) b.innerHTML = S[i]; }); const sep = document.createElement('span'); sep.className = 'e-sep'; bs[5] && tb.insertBefore(sep, bs[5]); }, SEL);
    await p.waitForTimeout(200); await p.screenshot({ path: `e5-${T}-icons.png`, clip });
    // link bar replaces the toolbar
    await p.evaluate((I) => { const tb = document.querySelector('.ed-seltb'); const r = tb.getBoundingClientRect(); tb.style.visibility = 'hidden';
      const bar = document.createElement('div'); bar.className = 'e-linkbar'; bar.innerHTML = I.link + '<input value="https://www.ieee802.org/3/" aria-label="網址"><button>' + I.enter + '套用</button>';
      bar.style.left = (r.left + scrollX) + 'px'; bar.style.top = (r.top + scrollY) + 'px'; document.body.appendChild(bar); }, I);
    await p.waitForTimeout(200); await p.screenshot({ path: `e5-${T}-linkbar.png`, clip });
    await p.evaluate(() => { const bar = document.querySelector('.e-linkbar'); bar.querySelector('input').value = ''; bar.querySelector('input').placeholder = '貼上或輸入網址'; });
    await p.screenshot({ path: `e5-${T}-linkbar-empty.png`, clip });
    // link card on an existing link
    await p.evaluate((I) => { document.querySelector('.e-linkbar').remove(); const tb = document.querySelector('.ed-seltb'); tb.style.display = 'none';
      const s = getSelection(); const rg = s.getRangeAt(0); const a = document.createElement('a'); a.href = 'https://www.ieee802.org/3/'; rg.surroundContents(a);
      const r2 = document.createRange(); r2.setStart(a.firstChild, 4); r2.collapse(true); s.removeAllRanges(); s.addRange(r2);
      const q = a.getBoundingClientRect(); const c = document.createElement('div'); c.className = 'e-linkcard';
      c.innerHTML = '<span class="u">www.ieee802.org/3/</span><button aria-label="開啟">' + I.ext + '</button><button aria-label="編輯">' + I.pen + '</button><button aria-label="移除連結">' + I.unlink + '</button>';
      c.style.left = (q.left + scrollX) + 'px'; c.style.top = (q.bottom + scrollY + 6) + 'px'; document.body.appendChild(c); }, I);
    await p.waitForTimeout(200); await p.screenshot({ path: `e5-${T}-card.png`, clip: { x: clip.x, y: clip.y + 40, width: 760, height: 170 } });
    await ctx.close();
  }
  console.log('errors', errs.length ? errs : 'none'); await b.close(); srv.kill();
})();
EOF
FONTCONFIG_FILE=$S/fonts.conf node e5.js && python3 -c "
from PIL import Image
fs=['e5-l-cur','e5-l-icons','e5-l-linkbar-empty','e5-d-linkbar','e5-l-card','e5-d-card']
ims=[Image.open(f+'.png').convert('RGB') for f in fs]
w,h=ims[0].size; s=Image.new('RGB',(2*w+10,3*h+20),(200,60,60))
for i,im in enumerate(ims): s.paste(im,((i%2)*(w+10),(i//2)*(h+10)))
s.resize((s.width//2,s.height//2)).save('e5-sheet.png')"
```

```bash
S=/tmp/claude-1000/-home-user-hp-workspace-md2doc/21ed517f-03d4-42bc-9214-e92fa099fdbe/scratchpad/e1; cd $S && sed -i "s/n.data.indexOf('IEEE 802.3')/n.data.indexOf('功能摘要')/; s/rr.setEnd(n, i + 15)/rr.setEnd(n, i + 4)/; s/r2.setStart(a.firstChild, 4)/r2.setStart(a.firstChild, 2)/; s/width: 760, height: 170/width: 900, height: 170/g; s/const clip = { x: pos.L - 40, y: pos.T - 90, width: 760, height: 170 }/const clip = { x: pos.L - 40, y: pos.T - 90, width: 900, height: 170 }/" e5.js && grep -c "功能摘要" e5.js && FONTCONFIG_FILE=$S/fonts.conf node e5.js && python3 -c "
from PIL import Image
fs=['e5-l-cur','e5-l-icons','e5-l-linkbar-empty','e5-d-linkbar','e5-l-card','e5-d-card']
ims=[Image.open(f+'.png').convert('RGB') for f in fs]
w,h=ims[0].size; s=Image.new('RGB',(2*w+10,3*h+20),(200,60,60))
for i,im in enumerate(ims): s.paste(im,((i%2)*(w+10),(i//2)*(h+10)))
s.resize((s.width//2,s.height//2)).save('e5-sheet.png')"
```

```bash
S=/tmp/claude-1000/-home-user-hp-workspace-md2doc/21ed517f-03d4-42bc-9214-e92fa099fdbe/scratchpad/e1; cd $S && python3 - <<'EOF'
from PIL import Image
import os,json
N='/tmp/claude-1000/-home-user-hp-workspace-md2doc/cc552bfe-c005-4ece-b528-ad08d7b94e52/scratchpad'
os.makedirs(N+'/e5page/img',exist_ok=True)
for t in 'ld':
  for k in ('cur','icons','linkbar-empty','linkbar','card'):
    Image.open('e5-%s-%s.png'%(t,k)).convert('RGB').save(N+'/e5page/img/e5-%s-%s.png'%(t,k))
e1=open(N+'/e1page/editor-e1.html').read()
style=e1[e1.index('<style>'):e1.index('</style>')+8]
def pair(k,cap):
  return '<div class="shots shots2">'+''.join('<figure><button class="shot" type="button" aria-label="放大：%s %s"><img src="img/e5-%s-%s.png" alt="%s %s" width="1800" height="340" loading="lazy"></button><figcaption><b>%s</b> %s</figcaption></figure>'%(cap,tn,t,k,cap,tn,cap,tn) for t,tn in (('l','淺色'),('d','深色')))+'</div>'
body='<title>編輯器 E5 行內格式與連結</title>\n'+style+'''
<main>
  <header><h1>編輯器 E5：行內格式與連結</h1>
  <p class="lede">選字後浮出的工具列，以及連結的輸入與編輯。原型套在 B 淺色紙面上，2 倍放大的局部截圖，淺色深色各一份。</p></header>

  <section class="row" aria-labelledby="h1"><h2 id="h1">一、選字工具列</h2>
    <p class="note">按鈕維持 6 顆：粗體、斜體、刪除線、底線、行內程式碼、連結。字母換成線條圖示，連結前加一道分隔線（前五顆是開關，連結會打開下一步）。不加區塊轉換下拉，那是 ⠿ 選單的事。</p>
    <h3 style="font-size:14px;margin:4px 0 0">目前（E1 白底，字母按鈕）</h3>'''+pair('cur','目前')+'''
    <h3 style="font-size:14px;margin:4px 0 0">改成圖示</h3>'''+pair('icons','圖示')+'''
  </section>

  <section class="row" aria-labelledby="h2"><h2 id="h2">二、加連結</h2>
    <p class="note">目前是瀏覽器的 <code>prompt('連結網址：')</code> 對話框，會擋住整個畫面，也沒有快捷鍵。改成：點 🔗 或按 <b>Ctrl+K</b>，選字工具列原地變成網址欄；Enter 套用、Esc 取消，清空後按 Enter 等於移除連結。另外，選取文字後直接貼上網址，就把那段文字變成連結（Notion 的做法）。</p>
    <h3 style="font-size:14px;margin:4px 0 0">剛打開</h3>'''+pair('linkbar-empty','網址欄')+'''
    <h3 style="font-size:14px;margin:4px 0 0">輸入網址後</h3>'''+pair('linkbar','網址欄已填')+'''
  </section>

  <section class="row" aria-labelledby="h3"><h2 id="h3">三、游標停在既有連結上</h2>
    <p class="note">連結下方出現小卡：網址、開啟（新分頁）、編輯（回到網址欄）、移除連結。目前要改連結只能重新選字再按 🔗。</p>
    '''+pair('card','連結小卡')+'''
  </section>

  <section class="row" aria-labelledby="h4"><h2 id="h4">這一項不處理的</h2>
    <p class="note">行內公式、上下標目前會讓整段改成原始碼編輯。mac-tx-core 裡一個都沒有（實測 284 段、240 個清單項目），先不做。實測真正被降級的是 23 個「鬆散清單」項目（項目間有空行）與 7 個含圖片的段落，分別放到 E6 清單與 E8 圖片處理。</p>
  </section>
</main>
<div id="lb" hidden><img alt=""></div>
<script>
(function(){
  var lb=document.getElementById('lb'), li=lb.querySelector('img');
  document.addEventListener('click',function(e){
    var b=e.target.closest('.shot'); if(b){li.src=b.querySelector('img').src; lb.hidden=false; return;}
    if(!lb.hidden && lb.contains(e.target)) lb.hidden=true;
  });
  document.addEventListener('keydown',function(e){ if(e.key==='Escape') lb.hidden=true; });
})();
</script>
'''
open(N+'/e5page/editor-e5.html','w').write(body)
print(json.dumps({'img/'+f:'img/'+f for f in sorted(os.listdir(N+'/e5page/img'))}))
EOF
```

```bash
S=/tmp/claude-1000/-home-user-hp-workspace-md2doc/21ed517f-03d4-42bc-9214-e92fa099fdbe/scratchpad/e1; cd $S && cat > lists.md <<'EOF'
# 驗證清單

## 巢狀項目

- crc32_engine：CRC-32 計算與前綴 tap
  - 每拍處理 8 octet
    - 第三層：前綴 CRC 在任一 octet 邊界可讀
  - 輸出 `crc32_side` 給 mac_merge_tx
- pad_insert：補 pad 到 60 octet

## 步驟

1. 讀取 slave 端 `tuser`
2. 判斷 `fcs_param_present`
   1. 為 1：只驗證、原樣通過
   2. 為 0：補 pad 並重算 FCS
3. 送到 master 端

## 待辦

- [x] 定義 safe_fault_status 位元
- [x] 補 SVA 覆蓋弱點清單
- [ ] DV 補 no-EOP 情境
- [ ] 確認 Infineon AURIX 參考值

## 鬆散清單（項目之間有空行）

- Simulation model：只交付 ASIC RTL。

- 子模組拆分對應 6 個新增 L2 leaf module。

- 不交付加密或鎖定的 IP。
EOF
grep -n "ul ul\|ul ul ul\|list-style" /home/user/hp_workspace/md2doc/lib/md2doc.js | head -8
```

```bash
S=/tmp/claude-1000/-home-user-hp-workspace-md2doc/21ed517f-03d4-42bc-9214-e92fa099fdbe/scratchpad/e1; cd $S && node /home/user/hp_workspace/md2doc/bin/md2doc.js lists.md --out lists.html >/dev/null && cat > e6.js <<'EOF'
const { chromium } = require('/home/user/hp_workspace/md2doc/node_modules/playwright');
const { spawn } = require('child_process');
const { applyReaderTheme } = require('/home/user/hp_workspace/md2doc/lib/theme/tokens.js');
const { CSS, FIXES, svgMap, extra } = require('./bcss.js');
const fs = require('fs');
const check = fs.readFileSync(__dirname + '/lucide/check.svg', 'utf8').replace(/<!--[^>]*-->/, '').replace(/\n/g, ' ').trim();
const checkUri = 'data:image/svg+xml,' + encodeURIComponent(check.replace('currentColor', '#ffffff').replace('stroke-width="2"', 'stroke-width="3"'));
const E6 = `
.ed-block[data-list-type="ul"][style*="--ed-indent:1"] > .ed-li-marker::before{content:"\\25E6"!important}
.ed-block[data-list-type="ul"][style*="--ed-indent:2"] > .ed-li-marker::before{content:"\\25AA"!important}
.ed-li-marker{color:var(--e-mut)!important}
.ed-li-check{width:16px!important;height:16px!important;border:1.5px solid var(--e-glyph)!important;border-radius:4px!important;background:transparent!important;margin-top:4px}
.ed-li-check[data-checked="1"]{background:var(--e-accent) url("${checkUri}") center/12px no-repeat!important;border-color:var(--e-accent)!important}
`;
const C2 = `.ed-block:has(> .ed-li-check[data-checked="1"]) .ed-li-text{color:var(--e-mut);text-decoration:line-through;text-decoration-color:var(--e-glyph)}`;
(async () => {
  const port = 47231;
  const srv = spawn('node', ['/home/user/hp_workspace/md2doc/bin/md2doc.js', '--edit', '--no-open', '--port', String(port), 'lists.md'], { cwd: __dirname });
  await new Promise((r) => setTimeout(r, 3000));
  const b = await chromium.launch(); const errs = [];
  for (const theme of ['light', 'dark']) {
    const T = theme[0];
    // reader
    {
      const ctx = await b.newContext({ viewport: { width: 1100, height: 1000 } });
      await ctx.addInitScript((t) => { try { localStorage.setItem('md2doc-theme', t); } catch (e) {} }, theme);
      const p = await ctx.newPage(); await p.goto('file://' + __dirname + '/lists.html'); await p.waitForTimeout(1200);
      await p.screenshot({ path: `e6-${T}-reader.png` }); await ctx.close();
    }
    for (const v of ['cur', 'c1', 'c2']) {
      const ctx = await b.newContext({ viewport: { width: 1100, height: 1000 } });
      await ctx.addInitScript((t) => { try { localStorage.setItem('md2doc-theme', t); } catch (e) {} }, theme);
      const p = await ctx.newPage(); p.on('pageerror', (e) => errs.push(e.message));
      await p.route('**/edit/*', async (route) => { const r = await route.fetch(); route.fulfill({ response: r, body: applyReaderTheme(await r.text()) }); });
      await p.goto(`http://127.0.0.1:${port}/edit/0`); await p.waitForTimeout(3000);
      await p.addStyleTag({ content: CSS + FIXES + (v !== 'cur' ? E6 : '') + (v === 'c2' ? C2 : '') });
      await p.evaluate(([m, x]) => { document.querySelectorAll('[data-ed-tb]').forEach((btn) => { const k = btn.getAttribute('data-ed-tb'); if (m[k]) btn.innerHTML = m[k]; });
        document.querySelectorAll('.ed-handle').forEach((h) => { h.innerHTML = x.grip; }); document.querySelectorAll('.ed-insert').forEach((h) => { h.innerHTML = x.plus; }); }, [svgMap, extra]);
      await p.mouse.move(1000, 950);
      await p.screenshot({ path: `e6-${T}-${v}.png` });
      if (v === 'cur') {
        const info = await p.evaluate(() => [...document.querySelectorAll('.ed-block[data-block-type="li"]')].map((b) => (b.querySelector('.ed-wys-armed') ? 'W' : 'R') + b.getAttribute('data-indent')).join(' '));
        console.log(theme, 'li armed/raw + indent:', info);
        const loose = await p.evaluateHandle(() => [...document.querySelectorAll('.ed-block[data-block-type="li"]')].find((b) => /Simulation model/.test(b.textContent)));
        await loose.click(); await p.waitForTimeout(700); await p.screenshot({ path: `e6-${T}-looseclick.png` });
      }
      await ctx.close();
    }
  }
  console.log('errors', errs.length ? errs : 'none'); await b.close(); srv.kill();
})();
EOF
FONTCONFIG_FILE=$S/fonts.conf node e6.js && python3 -c "
from PIL import Image
fs=['e6-l-reader','e6-l-cur','e6-l-c2','e6-l-looseclick']
ims=[Image.open(f+'.png').convert('RGB').resize((550,500)) for f in fs]
s=Image.new('RGB',(4*560,500),(200,60,60))
for i,im in enumerate(ims): s.paste(im,(i*560,0))
s.save('e6-sheet.png')"
```

```bash
S=/tmp/claude-1000/-home-user-hp-workspace-md2doc/21ed517f-03d4-42bc-9214-e92fa099fdbe/scratchpad/e1; cd $S && python3 - <<'EOF'
s=open('e6.js').read()
helper='''
const sec = async (p, from, to) => p.evaluate(([f, t]) => { const hs = [...document.querySelectorAll('h2')]; const a = hs.find((h) => h.textContent.includes(f)); const z = hs.find((h) => h.textContent.includes(t));
  a.scrollIntoView({ block: 'start' }); scrollBy(0, -70); const ra = a.getBoundingClientRect(); const rz = z ? z.getBoundingClientRect() : { top: ra.top + 260 };
  const c = a.closest('.content, main, article, body').getBoundingClientRect(); return { x: Math.max(0, c.left - 70), y: ra.top - 10, width: 620, height: rz.top - ra.top + 4 }; }, [from, to]);
const shots = async (p, tag) => { for (const [n, f, t] of [['nest', '巢狀', '步驟'], ['task', '待辦', '鬆散'], ['loose', '鬆散', 'zzz']]) { const c = await sec(p, f, t); await p.screenshot({ path: tag + '-' + n + '.png', clip: c }); } };
'''
s=s.replace("(async () => {", helper+"(async () => {",1)
s=s.replace("viewport: { width: 1100, height: 1000 } }","viewport: { width: 1100, height: 1000 }, deviceScaleFactor: 2 }")
s=s.replace("await p.screenshot({ path: `e6-${T}-reader.png` });","await shots(p, `e6-${T}-reader`);")
s=s.replace("await p.screenshot({ path: `e6-${T}-${v}.png` });","await shots(p, `e6-${T}-${v}`);")
s=s.replace("await loose.click(); await p.waitForTimeout(700); await p.screenshot({ path: `e6-${T}-looseclick.png` });","await loose.click(); await p.waitForTimeout(700); await shots(p, `e6-${T}-click`);")
open('e6b.js','w').write(s)
EOF
FONTCONFIG_FILE=$S/fonts.conf node e6b.js && python3 -c "
from PIL import Image
fs=['e6-l-reader-task','e6-l-cur-task','e6-l-c2-task','e6-d-c2-task','e6-l-reader-nest','e6-l-c1-nest','e6-l-click-loose']
ims=[Image.open(f+'.png').convert('RGB') for f in fs]
W=max(i.width for i in ims); H=sum(i.height for i in ims)+10*len(ims)
s=Image.new('RGB',(W,H),(200,60,60)); y=0
for i in ims: s.paste(i,(0,y)); y+=i.height+10
s.resize((W//2,H//2)).save('e6-sheet2.png'); print(s.size)"
```

```bash
S=/tmp/claude-1000/-home-user-hp-workspace-md2doc/21ed517f-03d4-42bc-9214-e92fa099fdbe/scratchpad/e1; cd $S && python3 - <<'EOF'
from PIL import Image
import os,json
N='/tmp/claude-1000/-home-user-hp-workspace-md2doc/cc552bfe-c005-4ece-b528-ad08d7b94e52/scratchpad'
os.makedirs(N+'/e6page/img',exist_ok=True)
names=[]
for t in 'ld':
  for v in ('reader','cur','c1','c2','click'):
    for k in ('nest','task','loose'):
      f='e6-%s-%s-%s.png'%(t,v,k)
      if os.path.exists(f):
        im=Image.open(f).convert('RGB'); im.save(N+'/e6page/img/'+f); names.append((f,im.size))
sizes=dict(names)
e1=open(N+'/e1page/editor-e1.html').read()
style=e1[e1.index('<style>'):e1.index('</style>')+8]
def fig(f,cap):
  w,h=sizes[f]; return '<figure><button class="shot" type="button" aria-label="放大：%s"><img src="img/%s" alt="%s" width="%d" height="%d" loading="lazy"></button><figcaption>%s</figcaption></figure>'%(cap,f,cap,w,h,cap)
def row(k,vs):
  out=''
  for t,tn in (('l','淺色'),('d','深色')):
    out+='<div class="shots">'+''.join(fig('e6-%s-%s-%s.png'%(t,v,k),'%s %s'%(vn,tn)) for v,vn in vs)+'</div>'
  return out
body='<title>編輯器 E6 清單與待辦</title>\n'+style+'''
<main>
  <header><h1>編輯器 E6：清單與待辦</h1>
  <p class="lede">用一份涵蓋巢狀、編號、待辦、鬆散清單的測試文件，閱讀頁與編輯器並排（2 倍截圖）。編輯器原型套在 B 淺色紙面上。</p></header>

  <section class="row" aria-labelledby="h1"><h2 id="h1">一、項目符號逐層變化（修正）</h2>
    <p class="note">閱讀頁逐層是 ● ○ ■，編輯器每一層都是 •（<code>lib/md2doc.js</code> 的 <code>content: "\\2022"</code>），同一份文件切進編輯模式符號就變了。改成跟閱讀頁一樣逐層 • ◦ ▪。</p>
    '''+row('nest',[('reader','閱讀頁'),('cur','編輯器目前'),('c1','編輯器改後')])+'''
  </section>

  <section class="row" aria-labelledby="h2"><h2 id="h2">二、待辦清單</h2>
    <p class="note">核取框改成 16px 圓角框，勾選時用強調色＋白色勾號（目前勾選只是一塊藍色方塊，沒有勾號）。另外發現<b>閱讀頁的既有缺陷</b>：待辦項目同時畫出圓點與核取框，雙重符號。</p>
    <div class="opts">
      <div class="opt"><h3>C1 勾選後文字不變</h3><ul><li>只有核取框變化</li></ul></div>
      <div class="opt rec"><h3>C2 勾選後文字變淡＋刪除線 <span class="tag">推薦</span></h3><ul><li>Notion 的做法；完成的項目退到背景，還沒做的一眼看得到</li><li>閱讀頁也一起改成同樣樣式，順便修掉雙重符號</li></ul></div>
    </div>
    '''+row('task',[('reader','閱讀頁目前'),('cur','編輯器目前'),('c1','C1'),('c2','C2')])+'''
    <p class="note">推薦 C2 的理由：一、設計文件裡的待辦多半是追蹤狀態，完成的項目變淡後，剩下要做的一眼就看得到。二、跟 Notion 一致，也是本次改版的目標；閱讀頁同步改，兩邊看起來不會不一樣。</p>
  </section>

  <section class="row" aria-labelledby="h3"><h2 id="h3">三、鬆散清單可以直接編輯（修正）</h2>
    <p class="note">項目之間有空行的清單，目前每個項目都被降級：點下去跳出原始碼框（下圖）。測試文件 17 個清單項目裡鬆散的 3 個全部降級；mac-tx-core 的 240 個清單項目裡有 23 個。改成跟一般清單項目一樣直接打字編輯，存檔時保留項目之間的空行，原檔格式不變。</p>
    <div class="shots shots2">'''+fig('e6-l-click-loose.png','目前：點鬆散項目 淺色')+fig('e6-d-click-loose.png','目前：點鬆散項目 深色')+'''</div>
  </section>
</main>
<div id="lb" hidden><img alt=""></div>
<script>
(function(){
  var lb=document.getElementById('lb'), li=lb.querySelector('img');
  document.addEventListener('click',function(e){
    var b=e.target.closest('.shot'); if(b){li.src=b.querySelector('img').src; lb.hidden=false; return;}
    if(!lb.hidden && lb.contains(e.target)) lb.hidden=true;
  });
  document.addEventListener('keydown',function(e){ if(e.key==='Escape') lb.hidden=true; });
})();
</script>
'''
open(N+'/e6page/editor-e6.html','w').write(body)
print(json.dumps({'img/'+f:'img/'+f for f,_ in names}))
EOF
```

```bash
p=/home/user/.claude-official/projects/-home-user-hp-workspace-md2doc/memory/editor-review-decisions.md; python3 - "$p" <<'EOF'
import sys;p=sys.argv[1];s=open(p).read()
s=s.replace("\n**Why:**","- E6（https://claude.ai/artifact/V3XXcdnArMmWQ7UociY1Ej）：項目符號逐層 • ◦ ▪ 與閱讀頁一致；鬆散清單項目（mac-tx-core 23 個）改為可直接編輯、存檔保留空行；核取框 16px 圓角＋勾號；勾選後 C2 文字變淡＋刪除線，閱讀頁同步並修掉閱讀頁待辦「圓點＋核取框」雙重符號缺陷。\n\n**Why:**",1)
open(p,'w').write(s)
EOF
S=/tmp/claude-1000/-home-user-hp-workspace-md2doc/21ed517f-03d4-42bc-9214-e92fa099fdbe/scratchpad/e1; cd $S && cat > e7cur.js <<'EOF'
const { chromium } = require('/home/user/hp_workspace/md2doc/node_modules/playwright');
const { spawn } = require('child_process');
(async () => {
  const srv = spawn('node', ['/home/user/hp_workspace/md2doc/bin/md2doc.js', '--edit', '--no-open', '--port', '47241', 'doc/mac-tx-core.md'], { cwd: __dirname });
  await new Promise((r) => setTimeout(r, 3000));
  const b = await chromium.launch(); const p = await (await b.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 })).newPage();
  await p.goto('http://127.0.0.1:47241/edit/0'); await p.waitForTimeout(3500);
  const t = await p.evaluateHandle(() => [...document.querySelectorAll('.content table')].find((x) => x.rows.length > 5 && x.rows.length < 20));
  const box = await t.evaluate((e) => { e.scrollIntoView({ block: 'start' }); scrollBy(0, -160); const r = e.getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: Math.min(r.height, 520) }; });
  const clip = { x: box.x - 50, y: box.y - 60, width: Math.min(box.w + 100, 1440 - box.x + 50), height: box.h + 100 };
  const cell = async (r, c) => t.evaluate((e, [r, c]) => { const x = e.rows[r].cells[c].getBoundingClientRect(); return { x: x.left + x.width / 2, y: x.top + x.height / 2, l: x.left, t: x.top, b: x.bottom, r: x.right }; }, [r, c]);
  const c = await cell(2, 1); await p.mouse.move(c.x, c.y); await p.waitForTimeout(500);
  await p.screenshot({ path: 'e7-cur-hover.png', clip });
  const g = await p.evaluate(() => { const r = (s) => { const e = document.querySelector(s); if (!e) return null; const x = e.getBoundingClientRect(); return { x: x.left + x.width / 2, y: x.top + x.height / 2, vis: getComputedStyle(e).display !== 'none' && x.width > 0 }; }; return { row: r('.ed-te-grip-row'), col: r('.ed-te-grip-col') }; });
  console.log(JSON.stringify(g));
  if (g.col && g.col.vis) { await p.mouse.move(g.col.x, g.col.y); await p.mouse.down(); await p.mouse.up(); await p.waitForTimeout(500); await p.screenshot({ path: 'e7-cur-colmenu.png', clip }); await p.keyboard.press('Escape'); await p.waitForTimeout(300); }
  await p.mouse.move(c.x, c.y); await p.waitForTimeout(300);
  const g2 = await p.evaluate(() => { const e = document.querySelector('.ed-te-grip-row'); const x = e.getBoundingClientRect(); return { x: x.left + x.width / 2, y: x.top + x.height / 2 }; });
  await p.mouse.move(g2.x, g2.y); await p.mouse.down(); await p.mouse.up(); await p.waitForTimeout(500); await p.screenshot({ path: 'e7-cur-rowmenu.png', clip }); await p.keyboard.press('Escape'); await p.waitForTimeout(300);
  await p.mouse.move(c.x, c.y); await p.waitForTimeout(200); await p.mouse.move(c.x, c.b - 1); await p.waitForTimeout(600);
  await p.screenshot({ path: 'e7-cur-bubble.png', clip });
  const last = await t.evaluate((e) => { const rr = e.rows[e.rows.length - 1]; const x = rr.cells[rr.cells.length - 1].getBoundingClientRect(); return { x: x.left + 10, y: x.top + x.height / 2 }; });
  console.log(JSON.stringify(await p.evaluate(() => [...document.querySelectorAll('.ed-te-menu button')].map((b) => b.textContent))));
  await b.close(); srv.kill();
})();
EOF
FONTCONFIG_FILE=$S/fonts.conf node e7cur.js && python3 -c "
from PIL import Image
fs=['e7-cur-hover','e7-cur-colmenu','e7-cur-rowmenu','e7-cur-bubble']
ims=[Image.open(f+'.png').convert('RGB') for f in fs]; ims=[i.resize((i.width//2,i.height//2)) for i in ims]
W=max(i.width for i in ims); H=sum(i.height for i in ims)+30
s=Image.new('RGB',(W,H),(200,60,60)); y=0
for i in ims: s.paste(i,(0,y)); y+=i.height+10
s.save('e7-cur-sheet.png'); print(s.size)"
```

```bash
S=/tmp/claude-1000/-home-user-hp-workspace-md2doc/21ed517f-03d4-42bc-9214-e92fa099fdbe/scratchpad/e1; cd $S && sed -i "s/\[...document.querySelectorAll('.content table')\].find((x) => x.rows.length > 5 \&\& x.rows.length < 20)/[...document.querySelectorAll('.content table.ed-wys-table')].find((x) => x.rows.length > 5 \&\& x.rows.length < 14)/" e7cur.js && sed -i "s|  const box = await t.evaluate|  console.log('tables', JSON.stringify(await p.evaluate(() => { const all=[...document.querySelectorAll('.content .ed-block[data-block-type=table]')]; const deg=all.filter(b=>!b.querySelector('table.ed-wys-table')); const why={}; deg.forEach(b=>{ const tags=new Set([...b.querySelectorAll('td *, th *')].map(e=>e.tagName.toLowerCase())); tags.forEach(x=>why[x]=(why[x]\|\|0)+1); if(!tags.size) why['(none)']=(why['(none)']\|\|0)+1; }); return {all:all.length, deg:deg.length, why}; })));\n  const box = await t.evaluate|" e7cur.js && FONTCONFIG_FILE=$S/fonts.conf node e7cur.js && python3 -c "
from PIL import Image
fs=['e7-cur-hover','e7-cur-colmenu','e7-cur-rowmenu','e7-cur-bubble']
ims=[Image.open(f+'.png').convert('RGB') for f in fs]; ims=[i.resize((i.width//2,i.height//2)) for i in ims]
W=max(i.width for i in ims); H=sum(i.height for i in ims)+30
s=Image.new('RGB',(W,H),(200,60,60)); y=0
for i in ims: s.paste(i,(0,y)); y+=i.height+10
s.save('e7-cur-sheet.png'); print(s.size)"
```

```bash
S=/tmp/claude-1000/-home-user-hp-workspace-md2doc/21ed517f-03d4-42bc-9214-e92fa099fdbe/scratchpad/e1; cd $S/lucide && for n in arrow-left-to-line arrow-right-to-line align-left align-center align-right chevron-right; do [ -f $n.svg ] || curl -sf "https://unpkg.com/lucide-static@0.469.0/icons/$n.svg" -o $n.svg || echo miss $n; done; cd $S && cat > e7.js <<'EOF'
const fs = require('fs');
const { chromium } = require('/home/user/hp_workspace/md2doc/node_modules/playwright');
const { spawn } = require('child_process');
const { applyReaderTheme } = require('/home/user/hp_workspace/md2doc/lib/theme/tokens.js');
const { CSS, FIXES, svgMap, extra } = require('./bcss.js');
const ico = (n) => fs.readFileSync(__dirname + '/lucide/' + n + '.svg', 'utf8').replace(/<!--[^>]*-->/, '').trim();
const I = {}; ['arrow-left-to-line', 'arrow-right-to-line', 'arrow-up-to-line', 'arrow-down-to-line', 'align-left', 'align-center', 'align-right', 'chevron-right', 'trash-2', 'plus', 'grip-vertical'].forEach((n) => { I[n] = ico(n); });
const E7 = `
.ed-block:hover{outline:none!important}
.e-tmenu{position:absolute;z-index:300;min-width:168px;padding:4px;border-radius:8px;background:var(--e-surface);box-shadow:var(--e-ring);color:var(--e-ink);font-size:13px}
.e-tmenu .it{display:flex;align-items:center;gap:10px;height:30px;padding:0 8px;border-radius:6px}
.e-tmenu .it.on{background:var(--e-hover)} .e-tmenu .it svg{width:16px;height:16px;color:var(--e-mut)} .e-tmenu .it .nm{flex:1}
.e-tmenu .it.danger{color:var(--e-err,#cf222e)} .e-tmenu .it.danger svg{color:inherit}
.e-tmenu hr{border:0;border-top:1px solid var(--e-rule);margin:4px 0}
.e-tmenu .seg{display:flex;gap:2px;margin-left:auto}.e-tmenu .seg span{width:24px;height:22px;display:grid;place-items:center;border-radius:4px;color:var(--e-mut)}
.e-tmenu .seg span.on{background:var(--e-active-bg);color:var(--e-active-fg)} .e-tmenu .seg svg{width:14px;height:14px;color:inherit}
.e-tbar{position:absolute;z-index:250;display:grid;place-items:center;border-radius:6px;background:var(--e-hover);color:var(--e-mut)}
.e-tbar svg{width:16px;height:16px}
.ed-te-grip-row,.ed-te-grip-col{background:var(--e-surface)!important;box-shadow:var(--e-ring)!important;border:0!important;color:var(--e-mut)!important;border-radius:6px!important}
.ed-te-grip-row.e-on,.ed-te-grip-col.e-on{background:var(--e-accent)!important;color:var(--e-surface)!important}
.ed-te-hl{background:var(--e-sel)!important}
`;
const ERR = `:root{--e-err:#cf222e} html[data-md2doc-theme="dark"]{--e-err:#ff8a8a}`;
(async () => {
  const port = 47251;
  const srv = spawn('node', ['/home/user/hp_workspace/md2doc/bin/md2doc.js', '--edit', '--no-open', '--port', String(port), 'doc/mac-tx-core.md'], { cwd: __dirname });
  await new Promise((r) => setTimeout(r, 3000));
  const b = await chromium.launch(); const errs = [];
  for (const theme of ['light', 'dark']) {
    const T = theme[0];
    const ctx = await b.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 });
    await ctx.addInitScript((t) => { try { localStorage.setItem('md2doc-theme', t); } catch (e) {} }, theme);
    const p = await ctx.newPage(); p.on('pageerror', (e) => errs.push(e.message));
    await p.route('**/edit/*', async (route) => { const r = await route.fetch(); route.fulfill({ response: r, body: applyReaderTheme(await r.text()) }); });
    await p.goto(`http://127.0.0.1:${port}/edit/0`); await p.waitForTimeout(3500);
    await p.addStyleTag({ content: CSS + FIXES + ERR + E7 });
    await p.evaluate(([m, x]) => { document.querySelectorAll('[data-ed-tb]').forEach((btn) => { const k = btn.getAttribute('data-ed-tb'); if (m[k]) btn.innerHTML = m[k]; });
      document.querySelectorAll('.ed-handle').forEach((h) => { h.innerHTML = x.grip; }); document.querySelectorAll('.ed-insert').forEach((h) => { h.innerHTML = x.plus; }); }, [svgMap, extra]);
    const t = await p.evaluateHandle(() => [...document.querySelectorAll('.content table.ed-wys-table')].find((x) => x.rows.length > 5 && x.rows.length < 14));
    const box = await t.evaluate((e) => { e.scrollIntoView({ block: 'start' }); scrollBy(0, -160); const r = e.getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: Math.min(r.height, 520) }; });
    const clip = { x: box.x - 90, y: box.y - 70, width: Math.min(box.w + 150, 1440 - box.x + 90), height: box.h + 130 };
    const c = await t.evaluate((e) => { const x = e.rows[2].cells[1].getBoundingClientRect(); return { x: x.left + x.width / 2, y: x.top + x.height / 2 }; });
    // edge bars on hover
    await p.mouse.move(c.x, c.y); await p.waitForTimeout(400);
    await p.evaluate(([I]) => { const tb = [...document.querySelectorAll('.content table.ed-wys-table')].find((x) => x.rows.length > 5 && x.rows.length < 14); const r = tb.getBoundingClientRect();
      const mk = (l, t, w, h) => { const d = document.createElement('div'); d.className = 'e-tbar'; d.innerHTML = I.plus; Object.assign(d.style, { left: (l + scrollX) + 'px', top: (t + scrollY) + 'px', width: w + 'px', height: h + 'px' }); document.body.appendChild(d); };
      mk(r.left, r.bottom + 4, r.width, 22); mk(r.right + 4, r.top, 22, r.height); }, [I]);
    await p.screenshot({ path: `e7-${T}-bars.png`, clip });
    // column menu
    const g = await p.evaluate(() => { const e = document.querySelector('.ed-te-grip-col'); const x = e.getBoundingClientRect(); return { x: x.left, y: x.top, w: x.width, h: x.height }; });
    await p.evaluate(([I, g]) => { document.querySelectorAll('.e-tbar').forEach((e) => e.remove()); const tb = [...document.querySelectorAll('.content table.ed-wys-table')].find((x) => x.rows.length > 5 && x.rows.length < 14);
      [...tb.rows].forEach((r) => r.cells[1] && r.cells[1].classList.add('ed-te-hl')); document.querySelector('.ed-te-grip-col').classList.add('e-on');
      const m = document.createElement('div'); m.className = 'e-tmenu'; m.innerHTML =
        `<div class="it on">${I['arrow-left-to-line']}<span class="nm">左側插入欄</span></div><div class="it">${I['arrow-right-to-line']}<span class="nm">右側插入欄</span></div>` +
        `<div class="it">${I['align-left']}<span class="nm">對齊</span><span class="seg"><span class="on">${I['align-left']}</span><span>${I['align-center']}</span><span>${I['align-right']}</span></span></div><hr>` +
        `<div class="it danger">${I['trash-2']}<span class="nm">刪除欄</span></div>`;
      m.style.left = (g.x + scrollX) + 'px'; m.style.top = (g.y + g.h + 6 + scrollY) + 'px'; document.body.appendChild(m); }, [I, g]);
    await p.screenshot({ path: `e7-${T}-colmenu.png`, clip });
    // row menu
    await p.evaluate(() => { document.querySelectorAll('.e-tmenu').forEach((e) => e.remove()); document.querySelectorAll('.ed-te-hl').forEach((e) => e.classList.remove('ed-te-hl')); document.querySelector('.ed-te-grip-col').classList.remove('e-on'); });
    const gr = await p.evaluate(() => { const e = document.querySelector('.ed-te-grip-row'); const x = e.getBoundingClientRect(); return { x: x.left, y: x.top, w: x.width, h: x.height }; });
    await p.evaluate(([I, g]) => { const tb = [...document.querySelectorAll('.content table.ed-wys-table')].find((x) => x.rows.length > 5 && x.rows.length < 14);
      [...tb.rows[2].cells].forEach((c) => c.classList.add('ed-te-hl')); document.querySelector('.ed-te-grip-row').classList.add('e-on');
      const m = document.createElement('div'); m.className = 'e-tmenu'; m.innerHTML =
        `<div class="it on">${I['arrow-up-to-line']}<span class="nm">上方插入列</span></div><div class="it">${I['arrow-down-to-line']}<span class="nm">下方插入列</span></div><hr><div class="it danger">${I['trash-2']}<span class="nm">刪除列</span></div>`;
      m.style.left = (g.x + g.w + 6 + scrollX) + 'px'; m.style.top = (g.y + scrollY) + 'px'; document.body.appendChild(m); }, [I, gr]);
    await p.screenshot({ path: `e7-${T}-rowmenu.png`, clip });
    await ctx.close();
  }
  console.log('errors', errs.length ? errs : 'none'); await b.close(); srv.kill();
})();
EOF
FONTCONFIG_FILE=$S/fonts.conf node e7.js && python3 -c "
from PIL import Image
fs=['e7-l-bars','e7-l-colmenu','e7-d-rowmenu']
ims=[Image.open(f+'.png').convert('RGB') for f in fs]; ims=[i.resize((i.width//2,i.height//2)) for i in ims]
W=max(i.width for i in ims); H=sum(i.height for i in ims)+20
s=Image.new('RGB',(W,H),(200,60,60)); y=0
for i in ims: s.paste(i,(0,y)); y+=i.height+10
s.save('e7-sheet.png'); print(s.size)"
```

```bash
S=/tmp/claude-1000/-home-user-hp-workspace-md2doc/21ed517f-03d4-42bc-9214-e92fa099fdbe/scratchpad/e1; cd $S && python3 - <<'EOF'
from PIL import Image
import os,json
N='/tmp/claude-1000/-home-user-hp-workspace-md2doc/cc552bfe-c005-4ece-b528-ad08d7b94e52/scratchpad'
os.makedirs(N+'/e7page/img',exist_ok=True)
sizes={}
for f in ['e7-cur-hover','e7-cur-colmenu','e7-cur-rowmenu']+['e7-%s-%s'%(t,k) for t in 'ld' for k in ('bars','colmenu','rowmenu')]:
  im=Image.open(f+'.png').convert('RGB'); im.save(N+'/e7page/img/'+f+'.jpg',quality=86); sizes[f]=im.size
e1=open(N+'/e1page/editor-e1.html').read()
style=e1[e1.index('<style>'):e1.index('</style>')+8]
def fig(f,cap):
  w,h=sizes[f]; return '<figure><button class="shot" type="button" aria-label="放大：%s"><img src="img/%s.jpg" alt="%s" width="%d" height="%d" loading="lazy"></button><figcaption>%s</figcaption></figure>'%(cap,f,cap,w,h,cap)
def pair(k,cap): return '<div class="shots shots2">'+fig('e7-l-'+k,cap+' 淺色')+fig('e7-d-'+k,cap+' 深色')+'</div>'
body='<title>編輯器 E7 表格</title>\n'+style+'''
<main>
  <header><h1>編輯器 E7：表格</h1>
  <p class="lede">mac-tx-core 的「config reg」對照表（2 倍截圖）。91 張表裡 88 張可以直接編輯，3 張被降級成原始碼，原因在實作時查。拖曳排序、範圍選取、貼上表格維持不變。</p></header>

  <section class="row" aria-labelledby="h0"><h2 id="h0">目前</h2>
    <p class="note">欄把手選單只有「刪除欄／對齊」，列把手選單只有「刪除列」，而且列選單長在表格左外側、蓋到側欄。要插入欄或列，只能把滑鼠停在格線上幾個像素內，等小 ＋ 泡泡出現。最後一格按 Tab 會離開表格，不會新增一列。</p>
    <div class="shots">'''+fig('e7-cur-hover','滑過表格')+fig('e7-cur-colmenu','欄選單')+fig('e7-cur-rowmenu','列選單（左外側）')+'''</div>
  </section>

  <section class="row" aria-labelledby="h1"><h2 id="h1">一、欄／列選單改成直式選單</h2>
    <p class="note">跟 ⠿ 選單同一個樣子：圖示＋文字。欄：左側插入欄、右側插入欄、對齊（同一行三顆，目前的對齊方式亮起）、刪除欄。列：上方插入列、下方插入列、刪除列。刪除放最後、用紅字、上面隔一條線。選單長在把手旁邊、表格內側。</p>
    '''+pair('colmenu','欄選單')+pair('rowmenu','列選單')+'''
  </section>

  <section class="row" aria-labelledby="h2"><h2 id="h2">二、在表格尾端加列、加欄</h2>
    <p class="note">滑過表格時，表格下方與右側出現淡灰色的 ＋ 長條，點一下在最後加一列或一欄（Notion 的做法）。最後一格按 Tab 也會新增一列並把游標移過去。格線上的小 ＋ 泡泡保留，用來插在中間。</p>
    '''+pair('bars','尾端 ＋ 長條')+'''
  </section>
</main>
<div id="lb" hidden><img alt=""></div>
<script>
(function(){
  var lb=document.getElementById('lb'), li=lb.querySelector('img');
  document.addEventListener('click',function(e){
    var b=e.target.closest('.shot'); if(b){li.src=b.querySelector('img').src; lb.hidden=false; return;}
    if(!lb.hidden && lb.contains(e.target)) lb.hidden=true;
  });
  document.addEventListener('keydown',function(e){ if(e.key==='Escape') lb.hidden=true; });
})();
</script>
'''
open(N+'/e7page/editor-e7.html','w').write(body)
print(json.dumps({'img/'+f+'.jpg':'img/'+f+'.jpg' for f in sizes}))
EOF
```

```bash
p=/home/user/.claude-official/projects/-home-user-hp-workspace-md2doc/memory/editor-review-decisions.md; python3 - "$p" <<'EOF'
import sys;p=sys.argv[1];s=open(p).read()
s=s.replace("\n**Why:**","- E7（https://claude.ai/artifact/AW8rGDqTBVeoiUFkd833Se）：欄/列選單改直式（欄：左插/右插/對齊三鍵同行/刪除欄紅字；列：上插/下插/刪除列紅字），開在把手旁表格內側；表格下方與右側 hover 出 ＋ 長條加列/欄；最後一格 Tab 新增列；格線 ＋ 泡泡保留；3/91 張降級表格實作時查原因。\n\n**Why:**",1)
open(p,'w').write(s)
EOF
cd /tmp/claude-1000/-home-user-hp-workspace-md2doc/21ed517f-03d4-42bc-9214-e92fa099fdbe/scratchpad/e1/doc && grep -o '^```[a-zA-Z0-9_-]*' mac-tx-core.md | sort | uniq -c; grep -c '!\[' mac-tx-core.md; ls assets | head; ls assets | sed 's/.*\.//' | sort | uniq -c
```

```bash
S=/tmp/claude-1000/-home-user-hp-workspace-md2doc/21ed517f-03d4-42bc-9214-e92fa099fdbe/scratchpad/e1; cd $S && cat > e8cur.js <<'EOF'
const { chromium } = require('/home/user/hp_workspace/md2doc/node_modules/playwright');
const { spawn } = require('child_process');
(async () => {
  const srv = spawn('node', ['/home/user/hp_workspace/md2doc/bin/md2doc.js', '--edit', '--no-open', '--port', '47261', 'doc/mac-tx-core.md'], { cwd: __dirname });
  await new Promise((r) => setTimeout(r, 3000));
  const b = await chromium.launch(); const p = await (await b.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
  await p.goto('http://127.0.0.1:47261/edit/0'); await p.waitForTimeout(5000);
  const kinds = await p.evaluate(() => {
    const out = {}; document.querySelectorAll('.content .ed-block').forEach((b) => {
      const k = b.querySelector('pre code.language-verilog, pre code[class*=verilog]') ? 'verilog' : b.querySelector('.graphviz, [class*=graphviz], svg.graphviz') ? 'dot' : b.querySelector('.mermaid, [class*=mermaid]') ? 'mermaid' : b.querySelector('.wavedrom, [class*=wave]') ? 'wave' : b.querySelector('img') ? 'img' : null;
      if (k) { out[k] = out[k] || []; out[k].push(b.getAttribute('data-block-id') + ':' + b.getAttribute('data-block-type') + ':' + (b.firstElementChild && b.firstElementChild.className)); } });
    return out; });
  console.log(JSON.stringify(kinds).slice(0, 1500));
  await b.close(); srv.kill();
})();
EOF
node e8cur.js
```

```bash
S=/tmp/claude-1000/-home-user-hp-workspace-md2doc/21ed517f-03d4-42bc-9214-e92fa099fdbe/scratchpad/e1; cd $S/lucide && for n in copy chevron-down replace text-cursor-input; do [ -f $n.svg ] || curl -sf "https://unpkg.com/lucide-static@0.469.0/icons/$n.svg" -o $n.svg || echo miss $n; done; cd $S && cat > e8.js <<'EOF'
const fs = require('fs');
const { chromium } = require('/home/user/hp_workspace/md2doc/node_modules/playwright');
const { spawn } = require('child_process');
const { applyReaderTheme } = require('/home/user/hp_workspace/md2doc/lib/theme/tokens.js');
const { CSS, FIXES, svgMap, extra } = require('./bcss.js');
const ico = (n) => fs.readFileSync(__dirname + '/lucide/' + n + '.svg', 'utf8').replace(/<!--[^>]*-->/, '').trim();
const I = {}; ['copy', 'chevron-down', 'pencil', 'replace', 'text-cursor-input', 'trash-2', 'check'].forEach((n) => { I[n] = ico(n); });
const md = fs.readFileSync(__dirname + '/doc/mac-tx-core.md', 'utf8');
const dot = md.match(/```dot\n([\s\S]*?)```/)[1];
const E8 = `
.e-code{position:relative}
.e-code pre{outline:2px solid var(--e-accent)!important;outline-offset:2px;caret-color:var(--e-accent)}
.e-chipbar{position:absolute;top:6px;right:8px;display:flex;gap:4px;z-index:5}
.e-chip{display:inline-flex;align-items:center;gap:4px;height:24px;padding:0 8px;border-radius:6px;font:12px/1 var(--f-ui,inherit);background:var(--e-surface);color:var(--e-mut);box-shadow:0 0 0 1px var(--e-rule)}
.e-chip svg{width:13px;height:13px}
.e-dg-btn{position:absolute;top:8px;right:8px;z-index:5;display:inline-flex;align-items:center;gap:6px;height:28px;padding:0 10px;border-radius:6px;font-size:13px;background:var(--e-surface);color:var(--e-ink);box-shadow:var(--e-ring)}
.e-dg-btn svg{width:14px;height:14px;color:var(--e-mut)}
.e-split{border-radius:8px;box-shadow:0 0 0 2px var(--e-accent);overflow:hidden;margin:8px 0}
.e-split .hd{display:flex;align-items:center;gap:8px;padding:6px 8px 6px 12px;font-size:12px;color:var(--e-mut);background:var(--e-field);border-bottom:1px solid var(--e-rule)}
.e-split .hd b{color:var(--e-ink);font-weight:600}.e-split .hd .sp{flex:1}
.e-split .hd button{border:0;border-radius:6px;padding:4px 10px;font:600 12px inherit;background:var(--e-accent);color:var(--e-surface)}
.e-split pre.src{margin:0;padding:10px 12px;max-height:220px;overflow:auto;font:12.5px/1.55 "Cascadia Mono",Consolas,ui-monospace,monospace;background:var(--e-field);color:var(--e-ink);border-bottom:1px solid var(--e-rule);white-space:pre}
.e-split .pv{padding:8px;position:relative}.e-split .pv .lb{position:absolute;top:6px;left:10px;font-size:11px;color:var(--e-mut)}
.e-imgbar{position:absolute;z-index:6;display:flex;gap:2px;padding:3px;border-radius:8px;background:var(--e-surface);box-shadow:var(--e-ring)}
.e-imgbar span{display:inline-flex;align-items:center;gap:5px;height:28px;padding:0 8px;border-radius:6px;font-size:13px;color:var(--e-ink)}
.e-imgbar span svg{width:14px;height:14px;color:var(--e-mut)} .e-imgbar span.danger{color:var(--e-err,#cf222e)} .e-imgbar span.danger svg{color:inherit}
:root{--e-err:#cf222e} html[data-md2doc-theme="dark"]{--e-err:#ff8a8a}
`;
(async () => {
  const port = 47271;
  const srv = spawn('node', ['/home/user/hp_workspace/md2doc/bin/md2doc.js', '--edit', '--no-open', '--port', String(port), 'doc/mac-tx-core.md'], { cwd: __dirname });
  await new Promise((r) => setTimeout(r, 3000));
  const b = await chromium.launch(); const errs = [];
  const runs = [['cur', 'light'], ['cur', 'dark'], ['new', 'light'], ['new', 'dark']];
  for (const [v, theme] of runs) {
    const T = theme[0];
    const ctx = await b.newContext({ viewport: { width: 1440, height: 900 } });
    await ctx.addInitScript((t) => { try { localStorage.setItem('md2doc-theme', t); } catch (e) {} }, theme);
    const p = await ctx.newPage(); p.on('pageerror', (e) => errs.push(e.message));
    await p.route('**/edit/*', async (route) => { const r = await route.fetch(); route.fulfill({ response: r, body: applyReaderTheme(await r.text()) }); });
    await p.goto(`http://127.0.0.1:${port}/edit/0`); await p.waitForTimeout(5000);
    await p.addStyleTag({ content: CSS + FIXES + E8 });
    await p.evaluate(([m, x]) => { document.querySelectorAll('[data-ed-tb]').forEach((btn) => { const k = btn.getAttribute('data-ed-tb'); if (m[k]) btn.innerHTML = m[k]; });
      document.querySelectorAll('.ed-handle').forEach((h) => { h.innerHTML = x.grip; }); document.querySelectorAll('.ed-insert').forEach((h) => { h.innerHTML = x.plus; }); }, [svgMap, extra]);
    const blk = async (id) => p.evaluate((id) => { const b = document.querySelector('.ed-block[data-block-id="' + id + '"]'); b.scrollIntoView({ block: 'start' }); scrollBy(0, -120); const r = b.getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height }; }, id);
    // 1. code
    let r = await blk('282');
    if (v === 'cur') { await p.mouse.click(r.x + 100, r.y + 20); await p.waitForTimeout(800); }
    else await p.evaluate(([I]) => { const b = document.querySelector('.ed-block[data-block-id="282"]'); b.classList.add('e-code'); const pre = b.querySelector('pre'); pre.contentEditable = 'true'; pre.focus();
      const bar = document.createElement('div'); bar.className = 'e-chipbar'; bar.innerHTML = '<span class="e-chip">Verilog' + I['chevron-down'] + '</span><span class="e-chip">' + I.copy + '複製</span>'; b.appendChild(bar); }, [I]);
    await p.waitForTimeout(300); await p.screenshot({ path: `e8-${v}-${T}-code.png` });
    await p.keyboard.press('Escape'); await p.waitForTimeout(300);
    // 2. graphviz
    r = await blk('271');
    if (v === 'cur') { await p.mouse.move(r.x + r.w / 2, r.y + 60); await p.waitForTimeout(400); await p.screenshot({ path: `e8-${v}-${T}-dot.png` });
      await p.mouse.click(r.x + r.w / 2, r.y + 60); await p.waitForTimeout(800); await p.screenshot({ path: `e8-${v}-${T}-dotclick.png` }); await p.keyboard.press('Escape'); await p.waitForTimeout(300); }
    else {
      await p.mouse.move(r.x + r.w / 2, r.y + 60); await p.waitForTimeout(300);
      await p.evaluate(([I]) => { const b = document.querySelector('.ed-block[data-block-id="271"]'); b.style.position = 'relative'; const btn = document.createElement('span'); btn.className = 'e-dg-btn e-tmp'; btn.innerHTML = I.pencil + '編輯圖表'; b.appendChild(btn); }, [I]);
      await p.screenshot({ path: `e8-${v}-${T}-dot.png` });
      await p.evaluate(([dot]) => { document.querySelectorAll('.e-tmp').forEach((e) => e.remove()); const b = document.querySelector('.ed-block[data-block-id="271"]'); const g = b.querySelector('.graphviz') || b.firstElementChild;
        const w = document.createElement('div'); w.className = 'e-split'; w.innerHTML = '<div class="hd"><b>Graphviz</b><span>預覽在停止輸入 0.5 秒後更新</span><span class="sp"></span><button>完成</button></div>';
        const src = document.createElement('pre'); src.className = 'src'; src.textContent = dot; src.contentEditable = 'true'; w.appendChild(src);
        const pv = document.createElement('div'); pv.className = 'pv'; pv.innerHTML = '<span class="lb">預覽</span>'; g.parentNode.insertBefore(w, g); pv.appendChild(g); w.appendChild(pv);
        b.scrollIntoView({ block: 'start' }); scrollBy(0, -120); }, [dot]);
      await p.waitForTimeout(300); await p.screenshot({ path: `e8-${v}-${T}-dotclick.png` });
    }
    // 3. image
    r = await blk('53');
    await p.mouse.move(r.x + r.w / 3, r.y + 40); await p.waitForTimeout(300);
    if (v === 'new') await p.evaluate(([I]) => { const b = document.querySelector('.ed-block[data-block-id="53"]'); const im = b.querySelector('img').getBoundingClientRect();
      const bar = document.createElement('div'); bar.className = 'e-imgbar'; bar.innerHTML = '<span>' + I.replace + '替換</span><span>' + I['text-cursor-input'] + '替代文字</span><span class="danger">' + I['trash-2'] + '刪除</span>';
      bar.style.left = (im.left + scrollX + 8) + 'px'; bar.style.top = (im.top + scrollY + 8) + 'px'; document.body.appendChild(bar); }, [I]);
    await p.screenshot({ path: `e8-${v}-${T}-img.png` });
    if (v === 'cur') { await p.mouse.click(r.x + r.w / 3, r.y + 40); await p.waitForTimeout(800); await p.screenshot({ path: `e8-${v}-${T}-imgclick.png` }); await p.keyboard.press('Escape'); }
    // 4. wave editor (current only)
    if (v === 'cur') {
      r = await blk('671'); await p.mouse.move(r.x + r.w / 2, r.y + 40); await p.waitForTimeout(500); await p.screenshot({ path: `e8-${v}-${T}-wave.png` });
      const btn = await p.$('.ed-wave-edit-btn'); if (btn) { await btn.click({ force: true }); await p.waitForTimeout(1500); await p.screenshot({ path: `e8-${v}-${T}-waveed.png` }); }
    }
    await ctx.close();
  }
  console.log('errors', errs.length ? errs : 'none'); await b.close(); srv.kill();
})();
EOF
FONTCONFIG_FILE=$S/fonts.conf node e8.js; ls e8-*.png | wc -l
```

```bash
S=/tmp/claude-1000/-home-user-hp-workspace-md2doc/21ed517f-03d4-42bc-9214-e92fa099fdbe/scratchpad/e1; cd $S && sleep 1; ps -eo pid,args | grep 'md2doc.js --edit' | grep -v grep | awk '{print $1}' | xargs -r kill; python3 - <<'EOF'
s=open('e8.js').read()
s=s.replace("const btn = await p.$('.ed-wave-edit-btn'); if (btn) { await btn.click({ force: true });","const ok = await p.evaluate(() => { const bs = [...document.querySelectorAll('.ed-wave-edit-btn')]; const v = bs.find((b) => { const r = b.getBoundingClientRect(); return r.width > 0 && r.top > 0 && r.top < innerHeight; }) || bs[0]; if (!v) return false; v.click(); return true; }); if (ok) {")
open('e8.js','w').write(s)
EOF
FONTCONFIG_FILE=$S/fonts.conf node e8.js; ls e8-*.png | wc -l; ps -eo pid,args | grep 'md2doc.js --edit' | grep -v grep || echo clean
```

```bash
S=/tmp/claude-1000/-home-user-hp-workspace-md2doc/21ed517f-03d4-42bc-9214-e92fa099fdbe/scratchpad/e1; cd $S && python3 -c "
from PIL import Image
fs=['e8-cur-l-code','e8-new-d-code','e8-cur-l-dotclick','e8-new-l-dotclick','e8-cur-l-imgclick','e8-new-d-img','e8-cur-d-waveed','e8-new-l-dot']
ims=[Image.open(f+'.png').convert('RGB').resize((720,450)) for f in fs]
s=Image.new('RGB',(1450,1840),(200,60,60))
for i,im in enumerate(ims): s.paste(im,((i%2)*730,(i//2)*460))
s.save('e8-sheet.png')"
```

```bash
S=/tmp/claude-1000/-home-user-hp-workspace-md2doc/21ed517f-03d4-42bc-9214-e92fa099fdbe/scratchpad/e1; cd $S && cat > fonts.conf <<EOF
<?xml version="1.0"?><!DOCTYPE fontconfig SYSTEM "fonts.dtd"><fontconfig><dir>$S/fonts</dir><dir>/usr/share/fonts</dir><cachedir>$S/fccache</cachedir>
<alias binding="strong"><family>monospace</family><prefer><family>Consolas</family></prefer></alias>
<alias binding="strong"><family>sans-serif</family><prefer><family>Segoe UI</family><family>Microsoft JhengHei</family></prefer></alias>
</fontconfig>
EOF
python3 - <<'EOF'
s=open('e8.js').read()
s=s.replace(".e-split .pv{padding:8px;position:relative}",".e-split .pv{padding:8px;position:relative;overflow:auto;max-height:420px}")
s=s.replace("""const ok = await p.evaluate(() => { const bs = [...document.querySelectorAll('.ed-wave-edit-btn')]; const v = bs.find((b) => { const r = b.getBoundingClientRect(); return r.width > 0 && r.top > 0 && r.top < innerHeight; }) || bs[0]; if (!v) return false; v.click(); return true; }); if (ok) {""",
"""const bb = await p.evaluate(() => { const bs = [...document.querySelectorAll('.ed-wave-edit-btn')]; const v = bs.find((b) => { const r = b.getBoundingClientRect(); return r.width > 0 && r.top > 0 && r.top < innerHeight; }); if (!v) return null; const r = v.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; }); console.log('wavebtn', JSON.stringify(bb)); if (bb) { await p.mouse.move(bb.x, bb.y); await p.waitForTimeout(200); await p.mouse.down(); await p.mouse.up();""")
open('e8.js','w').write(s)
EOF
FONTCONFIG_FILE=$S/fonts.conf node e8.js; ps -eo pid,args | grep 'md2doc.js --edit' | grep -v grep || echo clean; python3 -c "
from PIL import Image
fs=['e8-cur-l-code','e8-cur-l-wave','e8-cur-d-waveed','e8-new-l-dotclick']
ims=[Image.open(f+'.png').convert('RGB').resize((720,450)) for f in fs]
s=Image.new('RGB',(1450,920),(200,60,60))
for i,im in enumerate(ims): s.paste(im,((i%2)*730,(i//2)*460))
s.save('e8-sheet2.png')"
```

```bash
S=/tmp/claude-1000/-home-user-hp-workspace-md2doc/21ed517f-03d4-42bc-9214-e92fa099fdbe/scratchpad/e1; cd $S && python3 - <<'EOF'
s=open('e8.js').read()
s=s.replace("r = await blk('671'); await p.mouse.move(r.x + r.w / 2, r.y + 40); await p.waitForTimeout(500);",
"r = await blk('671'); const dg = await p.evaluate(() => { const d = document.querySelector('.ed-block[data-block-id=\"671\"] svg'); const x = d.getBoundingClientRect(); return { x: x.left + x.width / 2, y: x.top + x.height / 2 }; }); await p.mouse.move(dg.x - 30, dg.y); await p.mouse.move(dg.x, dg.y, { steps: 4 }); await p.waitForTimeout(500);")
s=s.replace("const runs = [['cur', 'light'], ['cur', 'dark'], ['new', 'light'], ['new', 'dark']];","const runs = (process.env.RUNS || 'cur:light,cur:dark,new:light,new:dark').split(',').map((x) => x.split(':'));")
open('e8.js','w').write(s)
EOF
RUNS=cur:light,cur:dark FONTCONFIG_FILE=$S/fonts.conf node e8.js; ps -eo pid,args | grep 'md2doc.js --edit' | grep -v grep || echo clean; python3 -c "
from PIL import Image
fs=['e8-cur-l-code','e8-cur-l-wave','e8-cur-d-waveed','e8-new-l-dotclick']
ims=[Image.open(f+'.png').convert('RGB').resize((720,450)) for f in fs]
s=Image.new('RGB',(1450,920),(200,60,60))
for i,im in enumerate(ims): s.paste(im,((i%2)*730,(i//2)*460))
s.save('e8-sheet2.png')"
```

```bash
S=/tmp/claude-1000/-home-user-hp-workspace-md2doc/21ed517f-03d4-42bc-9214-e92fa099fdbe/scratchpad/e1; cd $S && cat > wdbg.js <<'EOF'
const { chromium } = require('/home/user/hp_workspace/md2doc/node_modules/playwright');
const { spawn } = require('child_process');
(async () => {
  const srv = spawn('node', ['/home/user/hp_workspace/md2doc/bin/md2doc.js', '--edit', '--no-open', '--port', '47281', 'doc/mac-tx-core.md'], { cwd: __dirname });
  await new Promise((r) => setTimeout(r, 3000));
  const b = await chromium.launch(); const p = await (await b.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
  await p.goto('http://127.0.0.1:47281/edit/0'); await p.waitForTimeout(5000);
  const d = await p.evaluate(() => { const b = document.querySelector('.ed-block[data-block-id="671"]'); b.scrollIntoView({ block: 'center' }); const el = b.querySelector('.wavedrom-diagram, [id^="WaveDrom_Display_"]'); const x = (el || b).getBoundingClientRect(); return { has: !!el, cls: b.firstElementChild.className, x: x.left + x.width / 2, y: x.top + x.height / 2, n: document.querySelectorAll('.ed-wave-edit-btn').length }; });
  console.log(JSON.stringify(d));
  await p.waitForTimeout(300); await p.mouse.move(d.x - 40, d.y); await p.mouse.move(d.x, d.y, { steps: 5 }); await p.waitForTimeout(500);
  console.log(JSON.stringify(await p.evaluate(() => { const e = document.querySelector('.ed-wave-edit-btn'); const r = e.getBoundingClientRect(); const at = document.elementFromPoint(innerWidth / 2, innerHeight / 2); return { hidden: e.hidden, r: [r.left, r.top, r.width], at: at && at.tagName + '.' + at.className.baseVal + at.className }; })));
  await b.close(); srv.kill();
})();
EOF
node wdbg.js
```

```bash
S=/tmp/claude-1000/-home-user-hp-workspace-md2doc/21ed517f-03d4-42bc-9214-e92fa099fdbe/scratchpad/e1; cd $S && python3 - <<'EOF'
s=open('e8.js').read()
s=s.replace("r = await blk('671'); const dg = await p.evaluate(() => { const d = document.querySelector('.ed-block[data-block-id=\"671\"] svg');",
"const dg0 = await p.evaluate(() => { document.querySelector('.ed-block[data-block-id=\"671\"]').scrollIntoView({ block: 'center' }); }); await p.waitForTimeout(500); const dg = await p.evaluate(() => { const d = document.querySelector('.ed-block[data-block-id=\"671\"] .wavedrom-diagram');")
s=s.replace("await p.mouse.move(dg.x - 30, dg.y); await p.mouse.move(dg.x, dg.y, { steps: 4 });","await p.mouse.move(dg.x - 40, dg.y); await p.mouse.move(dg.x, dg.y, { steps: 5 });")
open('e8.js','w').write(s)
EOF
RUNS=cur:light,cur:dark FONTCONFIG_FILE=$S/fonts.conf node e8.js; ps -eo pid,args | grep 'md2doc.js --edit' | grep -v grep || echo clean; python3 -c "
from PIL import Image
fs=['e8-cur-l-code','e8-cur-l-wave','e8-cur-d-waveed','e8-new-l-dotclick']
ims=[Image.open(f+'.png').convert('RGB').resize((720,450)) for f in fs]
s=Image.new('RGB',(1450,920),(200,60,60))
for i,im in enumerate(ims): s.paste(im,((i%2)*730,(i//2)*460))
s.save('e8-sheet2.png')"
```

```bash
S=/tmp/claude-1000/-home-user-hp-workspace-md2doc/21ed517f-03d4-42bc-9214-e92fa099fdbe/scratchpad/e1; cd $S && RUNS=new:light,new:dark FONTCONFIG_FILE=$S/fonts.conf node e8.js; ps -eo pid,args | grep 'md2doc.js --edit' | grep -v grep || echo clean; ls e8-*.png | wc -l
```

```bash
S=/tmp/claude-1000/-home-user-hp-workspace-md2doc/21ed517f-03d4-42bc-9214-e92fa099fdbe/scratchpad/e1; cd $S && python3 - <<'EOF'
from PIL import Image
import os,json
N='/tmp/claude-1000/-home-user-hp-workspace-md2doc/cc552bfe-c005-4ece-b528-ad08d7b94e52/scratchpad'
os.makedirs(N+'/e8page/img',exist_ok=True)
fs=['e8-cur-l-code','e8-new-l-code','e8-new-d-code','e8-cur-l-dot','e8-cur-l-dotclick','e8-new-l-dot','e8-new-d-dot','e8-new-l-dotclick','e8-new-d-dotclick','e8-cur-l-img','e8-cur-l-imgclick','e8-new-l-img','e8-new-d-img','e8-cur-l-wave','e8-cur-l-waveed','e8-cur-d-waveed']
for f in fs: Image.open(f+'.png').convert('RGB').save(N+'/e8page/img/'+f+'.jpg',quality=84)
e1=open(N+'/e1page/editor-e1.html').read()
style=e1[e1.index('<style>'):e1.index('</style>')+8]
def fig(f,cap): return '<figure><button class="shot" type="button" aria-label="放大：%s"><img src="img/%s.jpg" alt="%s" width="1440" height="900" loading="lazy"></button><figcaption>%s</figcaption></figure>'%(cap,f,cap,cap)
def row(*items,n=3): return '<div class="shots%s">'%(' shots2' if n==2 else '')+''.join(fig(f,c) for f,c in items)+'</div>'
body='<title>編輯器 E8 程式碼與圖表</title>\n'+style+'''
<main>
  <header><h1>編輯器 E8：程式碼、圖表與圖片</h1>
  <p class="lede">mac-tx-core 裡有 7 個 Verilog 程式碼區塊、7 張 Graphviz、2 張 Mermaid、4 張 WaveDrom、7 張圖片。原型套在 B 淺色紙面上，淺色深色各一份。</p></header>

  <section class="row" aria-labelledby="h1"><h2 id="h1">一、程式碼區塊：原地編輯</h2>
    <p class="note">目前點程式碼會換成一個原始碼文字框（連 <code>```verilog</code> 圍欄一起），下方 ✓ ✕ 兩顆按鈕。改成：點進去就在原本的程式碼樣式裡直接打字，右上角顯示語言（可點開換語言）與「複製」。圍欄不再露出來；Esc 或點外面就收起。</p>
    '''+row(('e8-cur-l-code','目前：原始碼框'),('e8-new-l-code','改後 淺色'),('e8-new-d-code','改後 深色'))+'''
  </section>

  <section class="row" aria-labelledby="h2"><h2 id="h2">二、Graphviz／Mermaid：原始碼＋即時預覽</h2>
    <p class="note">目前點圖只會放大檢視；要改只能 ⠿ → MD 原始碼，在沒有預覽的文字框裡盲改。改成：滑過圖表時右上角出現「編輯圖表」（跟波形的「編輯波形」同一個位置與樣子），點了在原地展開：上面是原始碼、下面是預覽，停止輸入 0.5 秒後更新，按「完成」收起。點圖本身仍是放大檢視。</p>
    '''+row(('e8-cur-l-dot','目前：滑過'),('e8-new-l-dot','改後：滑過出現「編輯圖表」 淺色'),('e8-new-d-dot','改後：滑過 深色'))+row(('e8-cur-l-dotclick','目前：點圖放大'),('e8-new-l-dotclick','改後：原始碼＋預覽 淺色'),('e8-new-d-dotclick','改後：原始碼＋預覽 深色'))+'''
  </section>

  <section class="row" aria-labelledby="h3"><h2 id="h3">三、圖片：滑過出現小工具列</h2>
    <p class="note">目前圖片所在的段落 7 個全部只能用原始碼改，點圖是放大檢視。改成：滑過圖片時左上角出現「替換／替代文字／刪除」；點圖仍放大檢視。</p>
    '''+row(('e8-cur-l-imgclick','目前：點圖放大'),('e8-new-l-img','改後 淺色'),('e8-new-d-img','改後 深色'))+'''
  </section>

  <section class="row" aria-labelledby="h4"><h2 id="h4">四、波形編輯器：深色一開就壞</h2>
    <p class="note">把編輯模式改成可以切深色後實測：波形編輯器的面板還是白的，但輸入框被閱讀頁的深色規則改成深底，標籤幾乎看不見（右下圖）。所以 E1 的深色一定要把波形編輯器一起換成 B 的 token 與圖示，否則深色模式一打開就有一個壞掉的畫面。編輯器內部的操作（筆刷、關聯線、側欄）目前沒有要改，只換外觀。</p>
    '''+row(('e8-cur-l-wave','滑過波形：「編輯波形」'),('e8-cur-l-waveed','波形編輯器 淺色（目前）'),('e8-cur-d-waveed','波形編輯器 深色（壞掉）'))+'''
  </section>

  <section class="row" aria-labelledby="h5"><h2 id="h5">五、draw.io（不變）</h2>
    <p class="note">draw.io 圖是外部檔案，在 draw.io 裡改、存檔後編輯器每 10 秒偵測並自動重畫。這條流程不變。</p>
  </section>
</main>
<div id="lb" hidden><img alt=""></div>
<script>
(function(){
  var lb=document.getElementById('lb'), li=lb.querySelector('img');
  document.addEventListener('click',function(e){
    var b=e.target.closest('.shot'); if(b){li.src=b.querySelector('img').src; lb.hidden=false; return;}
    if(!lb.hidden && lb.contains(e.target)) lb.hidden=true;
  });
  document.addEventListener('keydown',function(e){ if(e.key==='Escape') lb.hidden=true; });
})();
</script>
'''
open(N+'/e8page/editor-e8.html','w').write(body)
print(json.dumps({'img/'+f+'.jpg':'img/'+f+'.jpg' for f in fs}))
EOF
```

```bash
S=/tmp/claude-1000/-home-user-hp-workspace-md2doc/21ed517f-03d4-42bc-9214-e92fa099fdbe/scratchpad/e1; mkdir -p $S/hl && cd $S/hl && npm init -y >/dev/null 2>&1; npm install highlight.js@11.11.1 --silent 2>&1 | tail -2; node -e "const h=require('highlight.js/lib/core');h.registerLanguage('verilog',require('highlight.js/lib/languages/verilog'));const r=h.highlight('module a #(parameter W=8)(input wire clk); assign x = 1\'b0; // c\nendmodule',{language:'verilog'});console.log(r.value)"; du -sh node_modules/highlight.js/lib/core.js node_modules/highlight.js/lib/languages/verilog.js
```

```bash
S=/tmp/claude-1000/-home-user-hp-workspace-md2doc/21ed517f-03d4-42bc-9214-e92fa099fdbe/scratchpad/e1; cd $S && node /home/user/hp_workspace/md2doc/bin/md2doc.js doc/mac-tx-core.md --out mtc.html >/dev/null 2>&1; ls -la mtc.html | awk '{print $5}'; cat > hlshot.js <<'EOF'
const { chromium } = require('/home/user/hp_workspace/md2doc/node_modules/playwright');
const h = require('./hl/node_modules/highlight.js/lib/core'); h.registerLanguage('verilog', require('./hl/node_modules/highlight.js/lib/languages/verilog'));
const PA = `:root{--hk:#cf222e;--hn:#0550ae;--hc:#6e7781;--hs:#0a3069;--ht:#953800;--hf:#8250df}
html[data-md2doc-theme="dark"]{--hk:#ff7b72;--hn:#79c0ff;--hc:#8b949e;--hs:#a5d6ff;--ht:#ffa657;--hf:#d2a8ff}
.hljs-keyword{color:var(--hk)}.hljs-number{color:var(--hn)}.hljs-comment{color:var(--hc);font-style:italic}.hljs-string{color:var(--hs)}.hljs-type,.hljs-built_in{color:var(--ht)}.hljs-title,.hljs-variable{color:var(--hf)}.hljs-meta{color:var(--ht)}`;
const PB = `:root{--hk:#1f2328;--hn:#0969da;--hc:#6e7781} html[data-md2doc-theme="dark"]{--hk:#f5f6f7;--hn:#6ea8f5;--hc:#8b949e}
.hljs-keyword{color:var(--hk);font-weight:600}.hljs-number{color:var(--hn)}.hljs-comment{color:var(--hc);font-style:italic}.hljs-string{color:var(--hn)}.hljs-meta{color:var(--hc)}`;
(async () => {
  const b = await chromium.launch();
  for (const theme of ['light', 'dark']) for (const [v, css] of [['none', ''], ['pa', PA], ['pb', PB]]) {
    const ctx = await b.newContext({ viewport: { width: 1200, height: 900 }, deviceScaleFactor: 2 });
    await ctx.addInitScript((t) => { try { localStorage.setItem('md2doc-theme', t); } catch (e) {} }, theme);
    const p = await ctx.newPage(); await p.goto('file://' + __dirname + '/mtc.html'); await p.waitForTimeout(1500);
    const srcs = await p.evaluate(() => [...document.querySelectorAll('pre code.language-verilog')].map((c) => c.textContent));
    const hl = srcs.map((s) => h.highlight(s, { language: 'verilog' }).value);
    const clip = await p.evaluate(([hl, css, v]) => { const cs = [...document.querySelectorAll('pre code.language-verilog')]; if (v !== 'none') cs.forEach((c, i) => { c.innerHTML = hl[i]; });
      const st = document.createElement('style'); st.textContent = css; document.head.appendChild(st);
      const pre = cs[3].parentElement; pre.scrollIntoView({ block: 'start' }); scrollBy(0, -20); const r = pre.getBoundingClientRect(); return { x: r.left - 10, y: r.top - 10, width: Math.min(r.width + 20, 700), height: Math.min(r.height + 20, 330) }; }, [hl, css, v]);
    await p.screenshot({ path: `hl-${theme[0]}-${v}.png`, clip }); await ctx.close();
  }
  await b.close();
})();
EOF
FONTCONFIG_FILE=$S/fonts.conf node hlshot.js && python3 -c "
from PIL import Image
fs=['hl-l-none','hl-l-pa','hl-l-pb','hl-d-none','hl-d-pa','hl-d-pb']
ims=[Image.open(f+'.png').convert('RGB') for f in fs]; w,h=ims[0].size
s=Image.new('RGB',(3*w+20,2*h+10),(200,60,60))
for i,im in enumerate(ims): s.paste(im,((i%3)*(w+10),(i//3)*(h+10)))
s.resize((s.width//2,s.height//2)).save('hl-sheet.png')"
```

```bash
S=/tmp/claude-1000/-home-user-hp-workspace-md2doc/21ed517f-03d4-42bc-9214-e92fa099fdbe/scratchpad/e1; cd $S && sed -n 1800,1818p /home/user/hp_workspace/tmp/cpu_tx_pla.v | grep -v 'modified by\|add lpi_tx_req' > rtl-sample.v && cat rtl-sample.v | head -3 && python3 - <<'EOF'
s=open('hlshot.js').read()
s=s.replace("const srcs = await p.evaluate(","const rtl = require('fs').readFileSync(__dirname + '/rtl-sample.v', 'utf8').replace(/\\s+$/, '');\n    await p.evaluate((rtl) => { const pre = document.createElement('pre'); const c = document.createElement('code'); c.className = 'language-verilog'; c.textContent = rtl; pre.appendChild(c); const cs = document.querySelectorAll('pre code.language-verilog'); cs[3].parentElement.after(pre); }, rtl);\n    const srcs = await p.evaluate(")
s=s.replace("const pre = cs[3].parentElement;","const pre = cs[4].parentElement;")
s=s.replace("height: Math.min(r.height + 20, 330)","height: Math.min(r.height + 20, 460)")
s=s.replace("`hl-${theme[0]}-${v}.png`","`hlr-${theme[0]}-${v}.png`")
open('hlshot2.js','w').write(s)
EOF
FONTCONFIG_FILE=$S/fonts.conf node hlshot2.js && python3 -c "
from PIL import Image
fs=['hlr-l-none','hlr-l-pa','hlr-l-pb','hlr-d-none','hlr-d-pa','hlr-d-pb']
ims=[Image.open(f+'.png').convert('RGB') for f in fs]; w,h=ims[0].size
s=Image.new('RGB',(3*w+20,2*h+10),(200,60,60))
for i,im in enumerate(ims): s.paste(im,((i%3)*(w+10),(i//3)*(h+10)))
s.resize((s.width//2,s.height//2)).save('hlr-sheet.png')"
```

```bash
S=/tmp/claude-1000/-home-user-hp-workspace-md2doc/21ed517f-03d4-42bc-9214-e92fa099fdbe/scratchpad/e1; N=/tmp/claude-1000/-home-user-hp-workspace-md2doc/cc552bfe-c005-4ece-b528-ad08d7b94e52/scratchpad/e8page; cd $S && python3 - "$N" <<'EOF'
import sys
from PIL import Image
N=sys.argv[1]
for t in 'ld':
  for v in ('none','pa','pb'):
    Image.open('hlr-%s-%s.png'%(t,v)).convert('RGB').save(N+'/img/hlr-%s-%s.png'%(t,v))
p=N+'/editor-e8.html'; s=open(p).read()
def fig(f,cap): return '<figure><button class="shot" type="button" aria-label="放大：%s"><img src="img/%s.png" alt="%s" width="1310" height="860" loading="lazy"></button><figcaption>%s</figcaption></figure>'%(cap,f,cap,cap)
sec='''
  <section class="row" aria-labelledby="h6"><h2 id="h6">六、語法上色</h2>
    <p class="note">目前閱讀頁與編輯器都<b>完全沒有</b>語法上色：<code>lib/md2doc.js:1036</code> 的註解寫「syntax-highlighted」，實際只做 HTML 跳脫。做得到：用 highlight.js（BSD 授權，內建 verilog，核心＋verilog 約 88KB）在產生 HTML 時就上色，閱讀頁、PDF、編輯器都有，閱讀頁不需要額外的 JS；編輯器原地打字時，停止輸入後重新上色，游標不動。顏色走深淺主題 token。下面用前代 TX PLA（<code>cpu_tx_pla.v</code>）的一段真實 RTL 示範；mac-tx-core 的 7 段 Verilog 都是 instance 範本，上色後只有埠名稱與數字有變化。</p>
    <div class="opts">
      <div class="opt rec"><h3>H1 GitHub 配色 <span class="tag">推薦</span></h3><ul><li>關鍵字紅、數字藍、註解灰斜體、埠名紫</li><li>深色用 GitHub 深色那組</li></ul></div>
      <div class="opt"><h3>H2 低調</h3><ul><li>只有數字（強調色）與註解（灰）上色，其他維持正文色</li></ul></div>
    </div>
    <div class="shots">'''+fig('hlr-l-none','目前 淺色')+fig('hlr-l-pa','H1 淺色')+fig('hlr-l-pb','H2 淺色')+'''</div>
    <div class="shots">'''+fig('hlr-d-none','目前 深色')+fig('hlr-d-pa','H1 深色')+fig('hlr-d-pb','H2 深色')+'''</div>
    <p class="note">推薦 H1 的理由：一、閱讀頁的配色本來就是 GitHub 系（連結 <code>#0969da</code>），H1 直接用同一家的程式碼配色，兩套顏色不會打架，深淺兩組的對比也是現成驗證過的。二、H2 在 RTL 上幾乎看不出 <code>always</code>／<code>begin</code>／<code>end</code> 的結構，失去上色的意義。</p>
  </section>
'''
s=s.replace('  <section class="row" aria-labelledby="h5">',sec+'  <section class="row" aria-labelledby="h5">')
s=s.replace('編輯器內部的操作（筆刷、關聯線、側欄）目前沒有要改，只換外觀。','這一輪先換外觀；編輯器本身的介面（筆刷、關聯線、側欄）重新設計已排入待辦，之後另開一項審查。')
open(p,'w').write(s)
EOF
grep -c 'hlr-' $N/editor-e8.html
```

```bash
p=/home/user/.claude-official/projects/-home-user-hp-workspace-md2doc/memory/editor-review-decisions.md; sed -i 's/配色 H1 GitHub（推薦）vs H2 低調，待使用者選。/配色定案 H1 GitHub（淺：關鍵字 #cf222e 數字 #0550ae 註解 #6e7781 斜體 埠名 #8250df；深：GitHub dark）。/' $p
S=/tmp/claude-1000/-home-user-hp-workspace-md2doc/21ed517f-03d4-42bc-9214-e92fa099fdbe/scratchpad/e1; cd $S && cat > e9cur.js <<'EOF'
const { chromium } = require('/home/user/hp_workspace/md2doc/node_modules/playwright');
const { spawn } = require('child_process');
const { applyReaderTheme } = require('/home/user/hp_workspace/md2doc/lib/theme/tokens.js');
const { CSS, FIXES, svgMap, extra } = require('./bcss.js');
(async () => {
  const srv = spawn('node', ['/home/user/hp_workspace/md2doc/bin/md2doc.js', '--edit', '--no-open', '--port', '47291', 'doc/mac-tx-core.md'], { cwd: __dirname });
  await new Promise((r) => setTimeout(r, 3000));
  const b = await chromium.launch();
  for (const v of ['cur', 'b']) {
    const ctx = await b.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
    const p = await ctx.newPage();
    if (v === 'b') await p.route('**/edit/*', async (route) => { const r = await route.fetch(); route.fulfill({ response: r, body: applyReaderTheme(await r.text()) }); });
    await p.goto('http://127.0.0.1:47291/edit/0'); await p.waitForTimeout(4000);
    if (v === 'b') { await p.addStyleTag({ content: CSS + FIXES }); await p.evaluate(([m, x]) => { document.querySelectorAll('[data-ed-tb]').forEach((btn) => { const k = btn.getAttribute('data-ed-tb'); if (m[k]) btn.innerHTML = m[k]; }); document.querySelectorAll('.ed-handle').forEach((h) => { h.innerHTML = x.grip; }); document.querySelectorAll('.ed-insert').forEach((h) => { h.innerHTML = x.plus; }); }, [svgMap, extra]); }
    const m = await p.evaluate(() => { const tb = document.querySelector('.ed-toolbar'); const r = tb.getBoundingClientRect(); const btns = [...tb.querySelectorAll('[data-ed-tb]')]; const vis = btns.filter((x) => { const q = x.getBoundingClientRect(); return q.right <= innerWidth && q.width > 0; }).length;
      return { tbW: Math.round(r.width), scrollW: tb.scrollWidth, btns: btns.length, visible: vis, docW: document.documentElement.scrollWidth, contentL: Math.round(document.querySelector('.content').getBoundingClientRect().left) }; });
    console.log(v, JSON.stringify(m));
    await p.screenshot({ path: `e9-${v}-rest.png` });
    const para = await p.evaluateHandle(() => [...document.querySelectorAll('.ed-block[data-block-type="paragraph"]')].find((b) => b.textContent.length > 120 && b.getBoundingClientRect().top > 150));
    const r = await para.evaluate((e) => { e.scrollIntoView({ block: 'center' }); const x = e.getBoundingClientRect(); return { x: x.left + 30, y: x.top + 10 }; });
    await p.waitForTimeout(300); await p.touchscreen.tap(r.x, r.y); await p.waitForTimeout(600);
    await p.screenshot({ path: `e9-${v}-tap.png` });
    console.log(v, 'handle visible after tap:', await para.evaluate((e) => getComputedStyle(e.querySelector('.ed-handle')).opacity));
    await ctx.close();
  }
  await b.close(); srv.kill();
})();
EOF
FONTCONFIG_FILE=$S/fonts.conf node e9cur.js && python3 -c "
from PIL import Image
fs=['e9-cur-rest','e9-cur-tap','e9-b-rest','e9-b-tap']
ims=[Image.open(f+'.png').convert('RGB').resize((390,844)) for f in fs]
s=Image.new('RGB',(4*400,844),(200,60,60))
for i,im in enumerate(ims): s.paste(im,(i*400,0))
s.save('e9-sheet.png')"
```

```bash
S=/tmp/claude-1000/-home-user-hp-workspace-md2doc/21ed517f-03d4-42bc-9214-e92fa099fdbe/scratchpad/e1; cd $S/lucide && for n in arrow-up arrow-down list-tree keyboard; do [ -f $n.svg ] || curl -sf "https://unpkg.com/lucide-static@0.469.0/icons/$n.svg" -o $n.svg || echo miss $n; done; cd $S && cat > e9.js <<'EOF'
const fs = require('fs');
const { chromium } = require('/home/user/hp_workspace/md2doc/node_modules/playwright');
const { spawn } = require('child_process');
const { applyReaderTheme } = require('/home/user/hp_workspace/md2doc/lib/theme/tokens.js');
const { CSS, FIXES, svgMap, extra } = require('./bcss.js');
const ico = (n) => fs.readFileSync(__dirname + '/lucide/' + n + '.svg', 'utf8').replace(/<!--[^>]*-->/, '').trim();
const I = {}; ['undo-2', 'redo-2', 'panel-left', 'file-code-2', 'sun', 'moon', 'check', 'plus', 'repeat', 'bold', 'italic', 'strikethrough', 'code', 'link', 'list', 'list-checks', 'indent-decrease', 'indent-increase', 'grip-vertical', 'arrow-up', 'arrow-down', 'copy', 'trash-2', 'keyboard', 'table', 'image'].forEach((n) => { I[n] = ico(n); });
const E9 = `
.ed-toolbar{display:none!important}
.m-top{position:fixed;top:0;left:0;right:0;height:48px;z-index:400;display:flex;align-items:center;gap:2px;padding:0 8px;background:var(--e-bar);border-bottom:1px solid var(--e-rule)}
.m-top .b,.m-bot .b{width:40px;height:40px;display:grid;place-items:center;border-radius:8px;color:var(--e-mut);flex:none}
.m-top svg,.m-bot svg{width:20px;height:20px;stroke-width:1.75}
.m-top .sp{flex:1}.m-top .st{font-size:13px;color:var(--e-mut);display:flex;align-items:center;gap:4px;padding-right:4px}.m-top .st svg{width:15px;height:15px;color:var(--e-ok,#1a7f37)}
.m-top .sep,.m-bot .sep{width:1px;height:22px;background:var(--e-rule);margin:0 4px;flex:none}
.m-kb{position:fixed;left:0;right:0;bottom:0;height:290px;z-index:400;display:grid;place-items:center;background:repeating-linear-gradient(135deg,var(--e-field),var(--e-field) 10px,var(--e-hover) 10px,var(--e-hover) 20px);color:var(--e-mut);font-size:14px;border-top:1px solid var(--e-rule)}
.m-kb span{display:flex;gap:6px;align-items:center;background:var(--e-surface);padding:6px 12px;border-radius:8px;box-shadow:var(--e-ring)} .m-kb svg{width:18px;height:18px}
.m-bot{position:fixed;left:0;right:0;bottom:290px;height:48px;z-index:401;display:flex;align-items:center;gap:2px;padding:0 6px;background:var(--e-bar);border-top:1px solid var(--e-rule);overflow:hidden;
  -webkit-mask-image:linear-gradient(90deg,#000 88%,transparent);mask-image:linear-gradient(90deg,#000 88%,transparent)}
.m-bot .b.acc{color:var(--e-accent)}
.m-sheet-bg{position:fixed;inset:0;z-index:500;background:rgba(0,0,0,.35)}
.m-sheet{position:fixed;left:0;right:0;bottom:0;z-index:501;padding:8px 8px calc(16px + env(safe-area-inset-bottom));border-radius:14px 14px 0 0;background:var(--e-surface);color:var(--e-ink);box-shadow:0 -8px 24px rgba(0,0,0,.18)}
.m-sheet .grab{width:36px;height:4px;border-radius:2px;background:var(--e-rule);margin:2px auto 8px}
.m-sheet .ti{font-size:13px;color:var(--e-mut);padding:4px 12px 8px}
.m-sheet .it{display:flex;align-items:center;gap:14px;height:48px;padding:0 12px;border-radius:8px;font-size:16px}
.m-sheet .it svg{width:20px;height:20px;color:var(--e-mut)} .m-sheet .it .nm{flex:1} .m-sheet .it .ch{color:var(--e-mut);font-size:14px}
.m-sheet .it.danger{color:var(--e-err)} .m-sheet .it.danger svg{color:inherit} .m-sheet hr{border:0;border-top:1px solid var(--e-rule);margin:4px 0}
.page-layout{padding-top:48px!important}
:root{--e-err:#cf222e;--e-ok:#1a7f37} html[data-md2doc-theme="dark"]{--e-err:#ff8a8a;--e-ok:#6fdd8b}
`;
const TOP = (dark) => `<span class="b">${I['undo-2']}</span><span class="b">${I['redo-2']}</span><span class="sep"></span><span class="b">${I['panel-left']}</span><span class="b">${I['file-code-2']}</span><span class="b">${dark ? I.sun : I.moon}</span><span class="sp"></span><span class="st">${I.check}已儲存</span>`;
const BOT = `<span class="b acc">${I.plus}</span><span class="b">${I['grip-vertical']}</span><span class="sep"></span><span class="b">${I.bold}</span><span class="b">${I.italic}</span><span class="b">${I.strikethrough}</span><span class="b">${I.code}</span><span class="b">${I.link}</span><span class="sep"></span><span class="b">${I.list}</span><span class="b">${I['list-checks']}</span><span class="b">${I['indent-decrease']}</span><span class="b">${I['indent-increase']}</span>`;
const SHEET = `<div class="grab"></div><div class="ti">段落 · 改名一律記在本表…</div><div class="it">${I.repeat}<span class="nm">轉換成</span><span class="ch">文字 ›</span></div><div class="it">${I['arrow-up']}<span class="nm">上移</span></div><div class="it">${I['arrow-down']}<span class="nm">下移</span></div><div class="it">${I.copy}<span class="nm">建立副本</span></div><div class="it">${I['file-code-2']}<span class="nm">MD 原始碼</span></div><hr><div class="it danger">${I['trash-2']}<span class="nm">刪除</span></div>`;
(async () => {
  const srv = spawn('node', ['/home/user/hp_workspace/md2doc/bin/md2doc.js', '--edit', '--no-open', '--port', '47301', 'doc/mac-tx-core.md'], { cwd: __dirname });
  await new Promise((r) => setTimeout(r, 3000));
  const b = await chromium.launch(); const errs = [];
  for (const theme of ['light', 'dark']) {
    const T = theme[0];
    const ctx = await b.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
    await ctx.addInitScript((t) => { try { localStorage.setItem('md2doc-theme', t); } catch (e) {} }, theme);
    const p = await ctx.newPage(); p.on('pageerror', (e) => errs.push(e.message));
    await p.route('**/edit/*', async (route) => { const r = await route.fetch(); route.fulfill({ response: r, body: applyReaderTheme(await r.text()) }); });
    await p.goto('http://127.0.0.1:47301/edit/0'); await p.waitForTimeout(4000);
    await p.addStyleTag({ content: CSS + FIXES + E9 });
    await p.evaluate(([top]) => { document.querySelectorAll('.md2doc-theme-toggle,[class*="theme-bubble"],[class*="theme-toggle"]').forEach((e) => { e.style.display = 'none'; });
      const t = document.createElement('div'); t.className = 'm-top'; t.innerHTML = top; document.body.appendChild(t); }, [TOP(theme === 'dark')]);
    await p.screenshot({ path: `e9-${T}-rest.png` });
    const para = await p.evaluateHandle(() => [...document.querySelectorAll('.ed-block[data-block-type="paragraph"]')].find((b) => /改名一律/.test(b.textContent)));
    const r = await para.evaluate((e) => { e.scrollIntoView({ block: 'start' }); scrollBy(0, -80); const x = e.getBoundingClientRect(); return { x: x.left + 30, y: x.top + 10 }; });
    await p.waitForTimeout(300); await p.touchscreen.tap(r.x, r.y); await p.waitForTimeout(500);
    await p.evaluate(([bot, I]) => { const k = document.createElement('div'); k.className = 'm-kb'; k.innerHTML = '<span>' + I.keyboard + '系統鍵盤（示意）</span>'; document.body.appendChild(k);
      const b = document.createElement('div'); b.className = 'm-bot'; b.innerHTML = bot; document.body.appendChild(b); }, [BOT, I]);
    await p.waitForTimeout(200); await p.screenshot({ path: `e9-${T}-edit.png` });
    await p.evaluate((sheet) => { document.querySelectorAll('.m-kb,.m-bot').forEach((e) => e.remove()); document.activeElement && document.activeElement.blur();
      const bg = document.createElement('div'); bg.className = 'm-sheet-bg'; document.body.appendChild(bg); const s = document.createElement('div'); s.className = 'm-sheet'; s.innerHTML = sheet; document.body.appendChild(s); }, SHEET);
    await p.waitForTimeout(200); await p.screenshot({ path: `e9-${T}-sheet.png` });
    await ctx.close();
  }
  console.log('errors', errs.length ? errs : 'none'); await b.close(); srv.kill();
})();
EOF
FONTCONFIG_FILE=$S/fonts.conf node e9.js && python3 -c "
from PIL import Image
fs=['e9-l-rest','e9-l-edit','e9-l-sheet','e9-d-edit']
ims=[Image.open(f+'.png').convert('RGB').resize((390,844)) for f in fs]
s=Image.new('RGB',(4*400,844),(200,60,60))
for i,im in enumerate(ims): s.paste(im,(i*400,0))
s.save('e9-sheet2.png')"
```

```bash
S=/tmp/claude-1000/-home-user-hp-workspace-md2doc/21ed517f-03d4-42bc-9214-e92fa099fdbe/scratchpad/e1; cd $S/lucide && [ -f save.svg ] && cd $S && python3 - <<'EOF'
s=open('e9.js').read()
s=s.replace("['undo-2',","['save', 'heading', 'quote', 'list-ordered', 'minus', 'arrow-up-to-line', 'arrow-down-to-line', 'undo-2',")
s=s.replace("<span class=\"sp\"></span><span class=\"st\">${I.check}已儲存</span>`;","<span class=\"sp\"></span><span class=\"st\"><i class=\"dot\"></i>未儲存</span><span class=\"b acc\">${I.save}</span>`;")
s=s.replace(".m-top .sep,",".m-top .st .dot{width:8px;height:8px;border-radius:50%;background:var(--e-dirty,#9a6700);display:inline-block}\n.m-top .b.acc{color:var(--e-accent);background:var(--e-active-bg)}\n.m-top.scroll{overflow:hidden;-webkit-mask-image:linear-gradient(90deg,#000 85%,transparent);mask-image:linear-gradient(90deg,#000 85%,transparent)}\n.m-top .sep,")
s=s.replace(":root{--e-err:#cf222e;--e-ok:#1a7f37} html[data-md2doc-theme=\"dark\"]{--e-err:#ff8a8a;--e-ok:#6fdd8b}",":root{--e-err:#cf222e;--e-ok:#1a7f37;--e-dirty:#9a6700} html[data-md2doc-theme=\"dark\"]{--e-err:#ff8a8a;--e-ok:#6fdd8b;--e-dirty:#e3b341}")
# P-b variant: full toolbar scrolling in the top bar, no bottom bar
s=s.replace("    await ctx.close();\n  }\n  console.log","""    if (theme === 'light') {
      await p.evaluate((I) => { document.querySelectorAll('.m-sheet,.m-sheet-bg,.m-top').forEach((e) => e.remove());
        const ids = ['save','undo-2','redo-2','|','heading','quote','code','list','list-ordered','list-checks','|','bold','italic','strikethrough','code','link','|','indent-decrease','indent-increase','|','table','arrow-up-to-line','arrow-down-to-line','minus','image','|','panel-left','file-code-2'];
        const t = document.createElement('div'); t.className = 'm-top scroll'; t.innerHTML = ids.map((k) => k === '|' ? '<span class="sep"></span>' : '<span class="b">' + I[k] + '</span>').join(''); document.body.appendChild(t); }, I);
      const r2 = await para.evaluate((e) => { const x = e.getBoundingClientRect(); return { x: x.left + 30, y: x.top + 10 }; });
      await p.touchscreen.tap(r2.x, r2.y); await p.waitForTimeout(400);
      await p.evaluate((I) => { const k = document.createElement('div'); k.className = 'm-kb'; k.innerHTML = '<span>' + I.keyboard + '系統鍵盤（示意）</span>'; document.body.appendChild(k); }, I);
      await p.screenshot({ path: `e9-${T}-pb.png` });
    }
    await ctx.close();
  }
  console.log""")
open('e9.js','w').write(s)
EOF
FONTCONFIG_FILE=$S/fonts.conf node e9.js && python3 -c "
from PIL import Image
fs=['e9-l-rest','e9-l-edit','e9-d-sheet','e9-l-pb']
ims=[Image.open(f+'.png').convert('RGB').resize((390,844)) for f in fs]
s=Image.new('RGB',(4*400,844),(200,60,60))
for i,im in enumerate(ims): s.paste(im,(i*400,0))
s.save('e9-sheet3.png')"; ps -eo pid,args | grep 'md2doc.js --edit' | grep -v grep || echo clean
```

```bash
S=/tmp/claude-1000/-home-user-hp-workspace-md2doc/21ed517f-03d4-42bc-9214-e92fa099fdbe/scratchpad/e1; cd $S && python3 - <<'EOF'
from PIL import Image
import os,json
N='/tmp/claude-1000/-home-user-hp-workspace-md2doc/cc552bfe-c005-4ece-b528-ad08d7b94e52/scratchpad'
os.makedirs(N+'/e9page/img',exist_ok=True)
fs=['e9-cur-rest','e9-cur-tap','e9-l-rest','e9-l-edit','e9-l-sheet','e9-d-rest','e9-d-edit','e9-d-sheet','e9-l-pb']
for f in fs: Image.open(f+'.png').convert('RGB').save(N+'/e9page/img/'+f+'.jpg',quality=84)
e1=open(N+'/e1page/editor-e1.html').read()
style=e1[e1.index('<style>'):e1.index('</style>')+8].replace('</style>','.phones{display:grid;grid-template-columns:repeat(auto-fill,minmax(180px,1fr));gap:12px}\n</style>')
def fig(f,cap): return '<figure><button class="shot" type="button" aria-label="放大：%s"><img src="img/%s.jpg" alt="%s" width="780" height="1688" loading="lazy"></button><figcaption>%s</figcaption></figure>'%(cap,f,cap,cap)
def row(*it): return '<div class="phones">'+''.join(fig(f,c) for f,c in it)+'</div>'
body='<title>編輯器 E9 手機編輯</title>\n'+style+'''
<main>
  <header><h1>編輯器 E9：手機編輯</h1>
  <p class="lede">390×844 觸控模擬（Playwright isMobile），mac-tx-core。鍵盤是示意的斜線區塊，高度 290px。</p></header>

  <section class="row" aria-labelledby="h0"><h2 id="h0">目前（實測）</h2>
    <p class="note">工具列 23 顆只看得到 9–10 顆（工具列實際寬 941px，螢幕 390px），其餘點不到，右邊的「編輯」字樣還疊在按鈕上。⠿ 與 ＋ 只靠滑鼠滑過出現，點段落後透明度仍是 0，所以轉換、插入、刪除、搬移區塊在手機上全部做不到。大綱鈕 ☰ 落在看不到的那段；閱讀頁手機版的深淺鈕放在頂列，但編輯模式把頂列藏掉了，兩個都找不到。</p>
    '''+row(('e9-cur-rest','目前：待命'),('e9-cur-tap','目前：點段落後'))+'''
  </section>

  <section class="row" aria-labelledby="h1"><h2 id="h1">M1 頂列精簡＋鍵盤上方工具列 <span class="tag" style="font-size:12px;font-weight:600;color:var(--pick);background:var(--pick-bg);border-radius:999px;padding:1px 8px">推薦</span></h2>
    <p class="note">頂列只留：復原、重做、大綱、原始碼、深淺、存檔狀態與存檔鈕（E2 手動存檔，有變更時「● 未儲存」＋亮起的存檔鈕）。開始打字時，鍵盤正上方出現工具列：＋（開「/」選單）、⠿（區塊選單）、粗斜刪程式碼連結、清單、待辦、縮排，可左右滑，右緣淡出提示還有。點 ⠿ 從底部滑出區塊選單，手機沒有拖曳，所以多了「上移／下移」。按鈕都是 40×40px。</p>
    '''+row(('e9-l-rest','淺色：待命'),('e9-l-edit','淺色：打字中'),('e9-l-sheet','淺色：區塊選單'),('e9-d-rest','深色：待命'),('e9-d-edit','深色：打字中'),('e9-d-sheet','深色：區塊選單'))+'''
  </section>

  <section class="row" aria-labelledby="h2"><h2 id="h2">M2 全部留在頂列、左右滑動</h2>
    <p class="note">桌面的 23 顆照搬到頂列，加淡出提示讓人知道可以滑。沒有鍵盤上方工具列；區塊選單同 M1。</p>
    '''+row(('e9-l-pb','淺色：打字中'))+'''
  </section>

  <section class="row" aria-labelledby="h3"><h2 id="h3">推薦 M1 的理由</h2>
    <p class="note">一、打字時手指在螢幕下半部，格式鈕就在鍵盤上方伸手可及；M2 要把手移到最上面，再滑兩三次才找得到右邊的按鈕。二、頂列在任何時候都看得到存檔狀態與深淺切換，補上目前手機上找不到的兩個功能，跟閱讀頁手機版「深淺鈕收進頂列」的定案一致。三、Notion、Google 文件手機版都是這個配置，使用者不用重新學。</p>
  </section>
</main>
<div id="lb" hidden><img alt=""></div>
<script>
(function(){
  var lb=document.getElementById('lb'), li=lb.querySelector('img');
  document.addEventListener('click',function(e){
    var b=e.target.closest('.shot'); if(b){li.src=b.querySelector('img').src; lb.hidden=false; return;}
    if(!lb.hidden && lb.contains(e.target)) lb.hidden=true;
  });
  document.addEventListener('keydown',function(e){ if(e.key==='Escape') lb.hidden=true; });
})();
</script>
'''
open(N+'/e9page/editor-e9.html','w').write(body)
print(json.dumps({'img/'+f+'.jpg':'img/'+f+'.jpg' for f in fs}))
EOF
```

```bash
p=/home/user/.claude-official/projects/-home-user-hp-workspace-md2doc/memory/editor-review-decisions.md; python3 - "$p" <<'EOF'
import sys;p=sys.argv[1];s=open(p).read()
s=s.replace("\n**Why:**","- E9（https://claude.ai/artifact/Wuh6s6ANDbKAnhuw7P8tjD）：M1——手機頂列只留復原/重做/大綱/原始碼/深淺/存檔狀態＋存檔鈕（深淺鈕在手機進頂列，桌面才是右下泡泡）；打字時鍵盤上方工具列（＋開「/」、⠿、B I S code link、清單、待辦、縮排，可滑、右緣淡出，40×40）；⠿ 開底部區塊選單（轉換成/上移/下移/建立副本/MD 原始碼/刪除）。\n\n**Why:**",1)
open(p,'w').write(s)
EOF
S=/tmp/claude-1000/-home-user-hp-workspace-md2doc/21ed517f-03d4-42bc-9214-e92fa099fdbe/scratchpad/e1; cd $S && node -e "const h=require('./hl/node_modules/highlight.js/lib/core');h.registerLanguage('markdown',require('./hl/node_modules/highlight.js/lib/languages/markdown'));console.log(h.highlight('## 1.1 Abbr\n\n- \`crc\` **bold** [x](y)\n\`\`\`verilog\nmodule\n\`\`\`',{language:'markdown'}).value)"
```

```bash
S=/tmp/claude-1000/-home-user-hp-workspace-md2doc/21ed517f-03d4-42bc-9214-e92fa099fdbe/scratchpad/e1; cd $S && cat > e10.js <<'EOF'
const { chromium } = require('/home/user/hp_workspace/md2doc/node_modules/playwright');
const { spawn } = require('child_process');
const { applyReaderTheme } = require('/home/user/hp_workspace/md2doc/lib/theme/tokens.js');
const { CSS, FIXES, svgMap, extra } = require('./bcss.js');
const h = require('./hl/node_modules/highlight.js/lib/core'); h.registerLanguage('markdown', require('./hl/node_modules/highlight.js/lib/languages/markdown'));
const R1 = `
textarea.ed-source{font:13px/1.65 "Cascadia Mono",Consolas,ui-monospace,monospace!important;background:var(--e-bar)!important;color:var(--e-ink)!important;border:0!important;outline:0!important;padding:16px 16px 16px 64px!important;tab-size:4}
.e-src-wrap{position:relative}
.e-ln{position:absolute;left:0;top:0;width:48px;padding-top:16px;text-align:right;font:13px/1.65 "Cascadia Mono",Consolas,monospace;color:var(--e-glyph);user-select:none;overflow:hidden;border-right:1px solid var(--e-rule);pointer-events:none}
.e-hl{position:absolute;left:0;right:0;top:0;margin:0;padding:16px 16px 16px 64px;font:13px/1.65 "Cascadia Mono",Consolas,monospace;white-space:pre-wrap;word-wrap:break-word;color:var(--e-ink);pointer-events:none;overflow:hidden}
.e-hl .hljs-section{color:var(--hk);font-weight:700}.e-hl .hljs-bullet{color:var(--ht)}.e-hl .hljs-code{color:var(--hn)}.e-hl .hljs-strong{font-weight:700}.e-hl .hljs-emphasis{font-style:italic}.e-hl .hljs-link{color:var(--hc)}.e-hl .hljs-string{color:var(--hf)}.e-hl .hljs-quote{color:var(--hc)}
:root{--hk:#cf222e;--hn:#0550ae;--hc:#6e7781;--ht:#953800;--hf:#8250df} html[data-md2doc-theme="dark"]{--hk:#ff7b72;--hn:#79c0ff;--hc:#8b949e;--ht:#ffa657;--hf:#d2a8ff}
`;
(async () => {
  const srv = spawn('node', ['/home/user/hp_workspace/md2doc/bin/md2doc.js', '--edit', '--no-open', '--port', '47311', 'doc/mac-tx-core.md'], { cwd: __dirname });
  await new Promise((r) => setTimeout(r, 3000));
  const b = await chromium.launch(); const errs = [];
  for (const [v, theme] of [['cur', 'light'], ['r1', 'light'], ['r1', 'dark'], ['r2', 'light'], ['r2', 'dark']]) {
    const T = theme[0];
    const ctx = await b.newContext({ viewport: { width: 1440, height: 900 } });
    await ctx.addInitScript((t) => { try { localStorage.setItem('md2doc-theme', t); } catch (e) {} }, theme);
    const p = await ctx.newPage(); p.on('pageerror', (e) => errs.push(e.message));
    if (v !== 'cur') await p.route('**/edit/*', async (route) => { const r = await route.fetch(); route.fulfill({ response: r, body: applyReaderTheme(await r.text()) }); });
    await p.goto('http://127.0.0.1:47311/edit/0'); await p.waitForTimeout(4000);
    if (v !== 'cur') { await p.addStyleTag({ content: CSS + FIXES + R1 }); await p.evaluate(([m]) => { document.querySelectorAll('[data-ed-tb]').forEach((btn) => { const k = btn.getAttribute('data-ed-tb'); if (m[k]) btn.innerHTML = m[k]; }); }, [svgMap]); }
    await p.click('[data-ed-tb="preview"]'); await p.waitForTimeout(1500);
    const src = await p.evaluate(() => { const t = document.querySelector('textarea.ed-source'); return t ? t.value : null; });
    if (!src) { console.log('no source textarea'); }
    const first = src.indexOf('## 1 Introduction') >= 0 ? src.indexOf('## 1 Introduction') : src.indexOf('# 1 Introduction');
    const lineNo = src.slice(0, first).split('\n').length;
    if (v !== 'cur') await p.evaluate(([html, lineNo, hl]) => { const t = document.querySelector('textarea.ed-source'); const w = document.createElement('div'); w.className = 'e-src-wrap'; t.parentNode.insertBefore(w, t); w.appendChild(t);
      if (hl) { const pre = document.createElement('pre'); pre.className = 'e-hl'; pre.innerHTML = html; w.insertBefore(pre, t); t.style.setProperty('color', 'transparent', 'important'); t.style.setProperty('caret-color', 'var(--e-ink)', 'important'); t.style.setProperty('background', 'transparent', 'important'); w.style.background = 'var(--e-bar)'; }
      const n = t.value.split('\n').length; const ln = document.createElement('div'); ln.className = 'e-ln'; ln.textContent = Array.from({ length: n }, (_, i) => i + 1).join('\n'); ln.style.whiteSpace = 'pre'; w.appendChild(ln); }, [h.highlight(src, { language: 'markdown' }).value, lineNo, v === 'r2']);
    // scroll so that "1 Introduction" is near top (textarea or page scroll)
    await p.evaluate((first) => { const t = document.querySelector('textarea.ed-source'); t.focus(); t.setSelectionRange(first, first); const lh = parseFloat(getComputedStyle(t).lineHeight) || 20; const ln = t.value.slice(0, first).split('\n').length;
      if (t.scrollHeight > t.clientHeight + 4) { t.scrollTop = (ln - 3) * lh; } else { const r = t.getBoundingClientRect(); scrollTo(0, scrollY + r.top + (ln - 3) * lh - 60); } }, first);
    await p.waitForTimeout(400);
    const m = await p.evaluate(() => { const t = document.querySelector('textarea.ed-source'); const cs = getComputedStyle(t); return { font: cs.fontFamily.slice(0, 40), size: cs.fontSize, h: Math.round(t.getBoundingClientRect().height), scrollH: t.scrollHeight }; });
    console.log(v, theme, JSON.stringify(m));
    await p.screenshot({ path: `e10-${v}-${T}.png` }); await ctx.close();
  }
  console.log('errors', errs.length ? errs : 'none'); await b.close(); srv.kill();
})();
EOF
FONTCONFIG_FILE=$S/fonts.conf node e10.js && python3 -c "
from PIL import Image
fs=['e10-cur-l','e10-r1-l','e10-r2-l','e10-r2-d']
ims=[Image.open(f+'.png').convert('RGB').resize((720,450)) for f in fs]
s=Image.new('RGB',(1450,910),(200,60,60))
for i,im in enumerate(ims): s.paste(im,((i%2)*730,(i//2)*460))
s.save('e10-sheet.png')"; ps -eo pid,args | grep 'md2doc.js --edit' | grep -v grep || echo clean
```

```bash
S=/tmp/claude-1000/-home-user-hp-workspace-md2doc/21ed517f-03d4-42bc-9214-e92fa099fdbe/scratchpad/e1; cd $S && python3 - <<'EOF'
s=open('e10.js').read()
a=s.index('const R1 = `'); b=s.index('`;',a)+2
s=s[:a]+r'''const R1 = `
textarea.ed-source{font:13px/1.65 "Cascadia Mono",Consolas,ui-monospace,monospace!important;background:var(--e-bar)!important;color:var(--e-ink)!important;border:0!important;outline:0!important;
  box-shadow:0 0 0 1px var(--e-rule)!important;border-radius:8px!important;padding:16px 20px!important;width:100%!important;box-sizing:border-box!important;height:calc(100vh - 44px - 32px)!important;resize:none!important;display:block}
body[data-ed-mode="source"] .toc{display:block!important}
.e-src-wrap{position:relative;width:100%}
.e-hl{position:absolute;inset:0;margin:0;padding:16px 20px;font:13px/1.65 "Cascadia Mono",Consolas,monospace;white-space:pre-wrap;overflow-wrap:break-word;word-break:normal;color:var(--e-ink);pointer-events:none;overflow:hidden;box-sizing:border-box;border-radius:8px}
.e-hl .hljs-section{color:var(--hk);font-weight:700}.e-hl .hljs-bullet{color:var(--ht)}.e-hl .hljs-code{color:var(--hn)}.e-hl .hljs-strong{font-weight:700}.e-hl .hljs-emphasis{font-style:italic}.e-hl .hljs-link{color:var(--hc)}.e-hl .hljs-string{color:var(--hf)}.e-hl .hljs-quote{color:var(--hc)}
:root{--hk:#cf222e;--hn:#0550ae;--hc:#6e7781;--ht:#953800;--hf:#8250df} html[data-md2doc-theme="dark"]{--hk:#ff7b72;--hn:#79c0ff;--hc:#8b949e;--ht:#ffa657;--hf:#d2a8ff}
`;'''+s[b:]
# replace overlay injection
a=s.index("    if (v !== 'cur') await p.evaluate(([html, lineNo, hl]) =>"); b=s.index("    // scroll so that")
s=s[:a]+r'''    if (v !== 'cur') await p.evaluate(([html, hl]) => { const t = document.querySelector('textarea.ed-source'); const w = document.createElement('div'); w.className = 'e-src-wrap'; t.parentNode.insertBefore(w, t); w.appendChild(t);
      if (hl) { const pre = document.createElement('pre'); pre.className = 'e-hl'; pre.innerHTML = html + '\n'; w.appendChild(pre); t.style.setProperty('color', 'transparent', 'important'); t.style.setProperty('caret-color', 'var(--e-ink)', 'important');
        t.addEventListener('scroll', () => { pre.scrollTop = t.scrollTop; }); } }, [h.highlight(src, { language: 'markdown' }).value, v === 'r2']);
    await p.evaluate(() => scrollTo(0, 0));
'''+s[b:]
s=s.replace("if (t.scrollHeight > t.clientHeight + 4) { t.scrollTop = (ln - 3) * lh; } else { const r = t.getBoundingClientRect(); scrollTo(0, scrollY + r.top + (ln - 3) * lh - 60); } }, first);",
"const mirror = document.createElement('div'); const cs = getComputedStyle(t); mirror.style.cssText = 'position:absolute;visibility:hidden;white-space:pre-wrap;overflow-wrap:break-word;box-sizing:border-box;width:' + t.clientWidth + 'px;padding:' + cs.padding + ';font:' + cs.font; mirror.textContent = t.value.slice(0, first); document.body.appendChild(mirror); const top = mirror.scrollHeight - 16 - 3 * lh; mirror.remove(); t.scrollTop = Math.max(0, top); t.dispatchEvent(new Event('scroll')); }, first);")
s=s.replace("const first = src.indexOf('## 1 Introduction') >= 0 ? src.indexOf('## 1 Introduction') : src.indexOf('# 1 Introduction');\n    const lineNo = src.slice(0, first).split('\\n').length;","const first = src.indexOf('# 1 Introduction');")
open('e10.js','w').write(s)
EOF
grep -n "lineNo" e10.js | head; FONTCONFIG_FILE=$S/fonts.conf node e10.js && python3 -c "
from PIL import Image
fs=['e10-cur-l','e10-r1-l','e10-r2-l','e10-r2-d']
ims=[Image.open(f+'.png').convert('RGB').resize((720,450)) for f in fs]
s=Image.new('RGB',(1450,910),(200,60,60))
for i,im in enumerate(ims): s.paste(im,((i%2)*730,(i//2)*460))
s.save('e10-sheet.png')"; ps -eo pid,args | grep 'md2doc.js --edit' | grep -v grep || echo clean
```

```bash
S=/tmp/claude-1000/-home-user-hp-workspace-md2doc/21ed517f-03d4-42bc-9214-e92fa099fdbe/scratchpad/e1; cd $S && python3 - <<'EOF'
s=open('e10.js').read()
s=s.replace("mirror.style.cssText = 'position:absolute;visibility:hidden;white-space:pre-wrap;overflow-wrap:break-word;","mirror.style.cssText = 'position:absolute;visibility:hidden;white-space:' + (t.getAttribute('wrap') === 'off' || cs.whiteSpace === 'pre' ? 'pre' : 'pre-wrap') + ';overflow-wrap:break-word;")
s=s.replace("const m = await p.evaluate(() => { const t = document.querySelector('textarea.ed-source'); const cs = getComputedStyle(t); return {","const m = await p.evaluate(() => { const t = document.querySelector('textarea.ed-source'); const cs = getComputedStyle(t); return { wrap: t.getAttribute('wrap'), ws: cs.whiteSpace,")
s=s.replace("t.addEventListener('scroll', () => { pre.scrollTop = t.scrollTop; }); }","const cs = getComputedStyle(t); if (t.getAttribute('wrap') === 'off' || cs.whiteSpace === 'pre') pre.style.whiteSpace = 'pre'; t.addEventListener('scroll', () => { pre.scrollTop = t.scrollTop; pre.scrollLeft = t.scrollLeft; }); }")
open('e10.js','w').write(s)
EOF
FONTCONFIG_FILE=$S/fonts.conf node e10.js && python3 -c "
from PIL import Image
fs=['e10-cur-l','e10-r1-l','e10-r2-l','e10-r1-d']
ims=[Image.open(f+'.png').convert('RGB').resize((720,450)) for f in fs]
s=Image.new('RGB',(1450,910),(200,60,60))
for i,im in enumerate(ims): s.paste(im,((i%2)*730,(i//2)*460))
s.save('e10-sheet.png')"; ps -eo pid,args | grep 'md2doc.js --edit' | grep -v grep || echo clean
```

```bash
S=/tmp/claude-1000/-home-user-hp-workspace-md2doc/21ed517f-03d4-42bc-9214-e92fa099fdbe/scratchpad/e1; cd $S && python3 - <<'EOF'
s=open('e10.js').read()
s=s.replace("for (const [v, theme] of [['cur', 'light'], ['r1', 'light'], ['r1', 'dark'], ['r2', 'light'], ['r2', 'dark']])","for (const [v, theme] of (process.env.RUNS ? process.env.RUNS.split(',').map((x) => x.split(':')) : [['cur', 'light'], ['r1', 'light'], ['r1', 'dark'], ['r2', 'light'], ['r2', 'dark']]))")
s=s.replace("if (v !== 'cur') { await p.addStyleTag({ content: CSS + FIXES + R1 });","if (v !== 'cur') { await p.addStyleTag({ content: CSS + FIXES + R1 + (v === 'r1w' ? 'textarea.ed-source{white-space:pre-wrap!important;overflow-wrap:anywhere!important}' : '') });")
open('e10.js','w').write(s)
EOF
RUNS=r1w:light,r1w:dark FONTCONFIG_FILE=$S/fonts.conf node e10.js; ps -eo pid,args | grep 'md2doc.js --edit' | grep -v grep || echo clean
```

```bash
S=/tmp/claude-1000/-home-user-hp-workspace-md2doc/21ed517f-03d4-42bc-9214-e92fa099fdbe/scratchpad/e1; cd $S && python3 - <<'EOF'
from PIL import Image
import os,json
N='/tmp/claude-1000/-home-user-hp-workspace-md2doc/cc552bfe-c005-4ece-b528-ad08d7b94e52/scratchpad'
os.makedirs(N+'/e10page/img',exist_ok=True)
fs=['e10-cur-l','e10-r1-l','e10-r1-d','e10-r1w-l','e10-r1w-d','e10-r2-l']
for f in fs: Image.open(f+'.png').convert('RGB').save(N+'/e10page/img/'+f+'.jpg',quality=86)
e1=open(N+'/e1page/editor-e1.html').read()
style=e1[e1.index('<style>'):e1.index('</style>')+8]
def fig(f,cap): return '<figure><button class="shot" type="button" aria-label="放大：%s"><img src="img/%s.jpg" alt="%s" width="1440" height="900" loading="lazy"></button><figcaption>%s</figcaption></figure>'%(cap,f,cap,cap)
def row(*it,two=True): return '<div class="shots%s">'%(' shots2' if two else '')+''.join(fig(f,c) for f,c in it)+'</div>'
body='<title>編輯器 E10 原始碼模式</title>\n'+style+'''
<main>
  <header><h1>編輯器 E10：原始碼模式</h1>
  <p class="lede">工具列「原始碼」切換後，整份 Markdown 變成一個文字框。截圖都捲到「## 1 Introduction」附近，mac-tx-core，1440×900。</p></header>

  <section class="row" aria-labelledby="h0"><h2 id="h0">目前（實測）</h2>
    <p class="note">文字框固定 630px 高、裡面自己捲（內容 61063px），下面還空一截，頁面本身另有一條捲軸。左側只剩搜尋框與空的「Contents」，大綱被藏掉了（<code>lib/md2doc.js</code> 的 <code>body[data-ed-mode="source"] .toc</code>）。不換行，mac-tx-core 的段落多是一整行，要左右捲才讀得完。</p>
    '''+row(('e10-cur-l','目前'),two=True)+'''
  </section>

  <section class="row" aria-labelledby="h1"><h2 id="h1">一定要做的（修正）</h2>
    <p class="note">文字框撐滿到視窗底部，只剩一條捲軸；改用程式碼字型與 B 的深淺配色；左側大綱留著，點標題直接跳到原始碼裡那一行。</p>
  </section>

  <section class="row" aria-labelledby="h2"><h2 id="h2">要選的：長行要不要自動換行</h2>
    <div class="opts">
      <div class="opt rec"><h3>W1 自動換行 <span class="tag">推薦</span></h3><ul><li>長段落折到框內，不用左右捲</li><li>表格列太長時也會折行</li></ul></div>
      <div class="opt"><h3>W0 不換行（維持）</h3><ul><li>一行就是原檔一行，表格欄位對齊比較好看</li><li>長段落要左右捲</li></ul></div>
    </div>
    <h3 style="font-size:14px;margin:4px 0 0">W1 自動換行</h3>'''+row(('e10-r1w-l','W1 淺色'),('e10-r1w-d','W1 深色'))+'''
    <h3 style="font-size:14px;margin:4px 0 0">W0 不換行</h3>'''+row(('e10-r1-l','W0 淺色'),('e10-r1-d','W0 深色'))+'''
    <p class="note">推薦 W1 的理由：一、mac-tx-core 的內容主體是長段落，不換行時每段都要左右捲到底才讀得完；表格列折行只是不整齊，內容都看得到。二、進原始碼模式通常是為了大範圍改字，閱讀長段落是主要動作。</p>
  </section>

  <section class="row" aria-labelledby="h3"><h2 id="h3">不建議：原始碼上色</h2>
    <p class="note">試了用 highlight.js 的 markdown 語言替原始碼上色，結果它把 <code>_en</code> 這種 snake_case 裡的底線當成斜體開頭，從那一行之後整片變斜體（下圖）。這份文件滿是 snake_case 訊號名，等於每頁都會壞。要做得改用 md2doc 自己的 Markdown 解析結果來標位置，成本高，這一輪不做。</p>
    '''+row(('e10-r2-l','highlight.js 上色：底線誤判成斜體'),two=True)+'''
  </section>
</main>
<div id="lb" hidden><img alt=""></div>
<script>
(function(){
  var lb=document.getElementById('lb'), li=lb.querySelector('img');
  document.addEventListener('click',function(e){
    var b=e.target.closest('.shot'); if(b){li.src=b.querySelector('img').src; lb.hidden=false; return;}
    if(!lb.hidden && lb.contains(e.target)) lb.hidden=true;
  });
  document.addEventListener('keydown',function(e){ if(e.key==='Escape') lb.hidden=true; });
})();
</script>
'''
open(N+'/e10page/editor-e10.html','w').write(body)
print(json.dumps({'img/'+f+'.jpg':'img/'+f+'.jpg' for f in fs}))
EOF
```

```bash
cd /tmp/claude-1000/-home-user-hp-workspace-md2doc/21ed517f-03d4-42bc-9214-e92fa099fdbe/scratchpad/e1/doc && echo "html comments: $(grep -c '<!--' mac-tx-core.md)"; echo "link refs: $(grep -cE '^\[[^]]+\]:\s' mac-tx-core.md)"; echo "frontmatter: $(head -1 mac-tx-core.md)"; echo "raw html lines: $(grep -cE '^\s*<(div|details|table|span|br|a )' mac-tx-core.md)"; wc -l mac-tx-core.md; cd /home/user/hp_workspace/md2doc && grep -a -n "enterSourceMode\|cycleDocMode" lib/editor/client.js | head; grep -rn "source mode\|原始碼模式\|ed-source" test/*.js | cut -c1-120 | awk -F: '{print $1}' | sort | uniq -c
```

```bash
cd /tmp/claude-1000/-home-user-hp-workspace-md2doc/21ed517f-03d4-42bc-9214-e92fa099fdbe/scratchpad/e1/doc && grep -n '!\[' mac-tx-core.md | cut -c1-140; cd /home/user/hp_workspace/md2doc && sed -n 195,210p lib/editor/list-md.js
```

```bash
cd /tmp/claude-1000/-home-user-hp-workspace-md2doc/21ed517f-03d4-42bc-9214-e92fa099fdbe/scratchpad/e1 && grep -o '<li[^>]*><input[^>]*>' lists.html | head -3; grep -o '<ul[^>]*>' lists.html | sort | uniq -c
```

```bash
S=/tmp/claude-1000/-home-user-hp-workspace-md2doc/21ed517f-03d4-42bc-9214-e92fa099fdbe/scratchpad; ls $S/e1/*.js $S/refs/*.js 2>/dev/null | xargs -n1 basename | tr '\n' ' '; echo; ls $S/e1/lucide | wc -l; du -sh $S/e1/*.js | tail -1; W=/home/user/hp_workspace/md2doc/.superpowers/sdd/2026-10-04-editor-batch1; ls $W
```

```bash
mkdir -p /tmp/claude-1000/handoff/proto && cd /tmp/claude-1000/handoff && cat > extract.py <<'PYEOF'
import json, re, os, subprocess, sys
T='/home/user/.claude-official/projects/-home-user-hp-workspace-md2doc/cc552bfe-c005-4ece-b528-ad08d7b94e52.jsonl'
cmds=[]
with open(T) as f:
    for line in f:
        try: o=json.loads(line)
        except: continue
        m=o.get('message') or {}
        if m.get('role')!='assistant': continue
        for c in m.get('content') or []:
            if isinstance(c,dict) and c.get('type')=='tool_use' and c.get('name')=='Bash':
                cmd=c['input'].get('command','')
                if 'scratchpad/e1' in cmd or 'scratchpad; cd $S && ' in cmd or '/refs' in cmd:
                    cmds.append(cmd)
print(len(cmds),'commands', file=sys.stderr)
open('commands.log.md','w').write('\n\n'.join('```bash\n'+c+'\n```' for c in cmds))
# replay file-writing parts in proto/
os.chdir('proto')
heredoc=re.compile(r"cat > (\S+) <<'(\w+)'\n(.*?)\n\2\n", re.S)
pyblk=re.compile(r"python3 - (?:\"\$\w+\" )?<<'(\w+)'\n(.*?)\n\1\n", re.S)
for cmd in cmds:
    # sequential: process in textual order
    events=[]
    for m in heredoc.finditer(cmd): events.append((m.start(),'cat',m))
    for m in pyblk.finditer(cmd): events.append((m.start(),'py',m))
    for m in re.finditer(r"sed -i (\"[^\"]*\"|'[^']*') ([\w.]+\.js)", cmd): events.append((m.start(),'sed',m))
    for m in re.finditer(r"awk '[^']*' (\w+\.js)[^\n&;]*> (\w+\.js)[^\n]*", cmd): events.append((m.start(),'shell',m))
    for m in re.finditer(r"echo \"module\.exports = \{[^\"]*\};\" >> \w+\.js|echo 'module\.exports = \{[^']*\};' >> \w+\.js", cmd): events.append((m.start(),'shell0',m))
    for pos,kind,m in sorted(events,key=lambda e:e[0]):
        if kind=='cat':
            name=m.group(1)
            if name.endswith(('.js','.conf')) and '/' not in name.replace('$S/',''):
                open(os.path.basename(name),'w').write(m.group(3)+'\n')
        elif kind=='py':
            code=m.group(2)
            if 'PIL' in code or "open('" not in code or not re.search(r"open\('[\w.]+\.js'", code): continue
            subprocess.run(['python3','-'],input=code,text=True,capture_output=True)
        elif kind=='sed':
            if os.path.exists(m.group(2)): subprocess.run('sed -i '+m.group(1)+' '+m.group(2),shell=True)
        elif kind in('shell','shell0'):
            subprocess.run(m.group(0),shell=True)
    # special: slash.js needs header insert done via sed '1i' — handled by sed regex? ensure
print(sorted(os.listdir('.')), file=sys.stderr)
PYEOF
python3 extract.py; cd proto && for f in *.js; do node --check $f 2>/dev/null && echo "ok $f" || echo "FAIL $f"; done
```