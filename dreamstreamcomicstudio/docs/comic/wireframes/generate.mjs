// Wireframe generator for the Comic Studio redesign.
// Pure SVG -> PNG via sharp (already a dependency). Run from the app root:
//   node docs/comic/wireframes/generate.mjs
// Produces <name>.svg and <name>.png for each screen + a flow map.
// These are LOW-FIDELITY wireframes: layout + interactions, not visual design.

import sharp from 'sharp';
import { writeFileSync, mkdirSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const OUT = dirname(fileURLToPath(import.meta.url));
mkdirSync(OUT, { recursive: true });

const C = {
  bg:'#eef1f4', surface:'#ffffff', ink:'#111827', mut:'#6b7280',
  line:'#111827', soft:'#cbd5e1', ph:'#e7ecf1', phLine:'#9aa7b4',
  yellow:'#f7c948', blue:'#2186eb', red:'#e12d39', green:'#27ab83',
  panel:'#f8fafc', tool:'#1f2933', maskFill:'rgba(225,45,57,0.28)'
};

let _s = '';
let _tagN = 0;
const esc = s => String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');

function rect(x,y,w,h,o={}){const{fill='none',stroke=C.line,sw=2,rx=0,dash=null,op=1}=o;
  _s+=`<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${rx}" fill="${fill}" stroke="${stroke}" stroke-width="${sw}" ${dash?`stroke-dasharray="${dash}"`:''} opacity="${op}"/>`;}
function line(x1,y1,x2,y2,o={}){const{stroke=C.soft,sw=1,dash=null}=o;
  _s+=`<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="${stroke}" stroke-width="${sw}" ${dash?`stroke-dasharray="${dash}"`:''}/>`;}
function txt(x,y,str,o={}){const{size=14,fill=C.ink,w='normal',anchor='start',mono=false}=o;
  _s+=`<text x="${x}" y="${y}" font-size="${size}" fill="${fill}" font-weight="${w}" text-anchor="${anchor}" font-family="${mono?'ui-monospace,monospace':'Segoe UI,Helvetica,Arial,sans-serif'}">${esc(str)}</text>`;}
function circle(cx,cy,r,o={}){const{fill=C.ink,stroke='none',sw=0}=o;_s+=`<circle cx="${cx}" cy="${cy}" r="${r}" fill="${fill}" stroke="${stroke}" stroke-width="${sw}"/>`;}
function btn(x,y,w,h,label,o={}){const{fill=C.yellow,fg=C.ink,size=14,sw=2}=o;
  rect(x,y,w,h,{fill,stroke:C.line,sw,rx:8});txt(x+w/2,y+h/2+5,label,{anchor:'middle',w:'bold',size,fill:fg});}
function chip(x,y,w,h,label,o={}){const{fill=C.panel,fg=C.ink,size=12}=o;
  rect(x,y,w,h,{fill,stroke:C.soft,sw:1.5,rx:h/2});txt(x+w/2,y+h/2+4,label,{anchor:'middle',size,fill:fg});}
function imgPH(x,y,w,h,label='panel art'){rect(x,y,w,h,{fill:C.ph,stroke:C.phLine,sw:1.5,rx:4});
  line(x,y,x+w,y+h,{stroke:C.phLine,sw:1});line(x+w,y,x,y+h,{stroke:C.phLine,sw:1});
  txt(x+w/2,y+h/2+4,label,{anchor:'middle',fill:C.mut,size:12});}
function tag(x,y,n){n=(n==null?++_tagN:n);circle(x,y,12,{fill:C.red});txt(x,y+4,String(n),{anchor:'middle',fill:'#fff',w:'bold',size:13});}
function arrow(x1,y1,x2,y2,o={}){const{stroke=C.ink,sw=2}=o;line(x1,y1,x2,y2,{stroke,sw});
  const a=Math.atan2(y2-y1,x2-x1),L=11;
  line(x2,y2,x2-L*Math.cos(a-0.4),y2-L*Math.sin(a-0.4),{stroke,sw});
  line(x2,y2,x2-L*Math.cos(a+0.4),y2-L*Math.sin(a+0.4),{stroke,sw});}
function wrap(str,n){const words=str.split(' ');const lines=[];let cur='';
  for(const w of words){if((cur+' '+w).trim().length>n){if(cur)lines.push(cur);cur=w;}else cur=(cur+' '+w).trim();}
  if(cur)lines.push(cur);return lines;}

// speech bubble (vector look)
function bubble(x,y,w,h,text,o={}){const{tail='bl',fill='#fff'}=o;
  rect(x,y,w,h,{fill,stroke:C.line,sw:2,rx:14});
  // tail
  let tx=x+18,ty=y+h;if(tail==='br'){tx=x+w-18;}
  _s+=`<path d="M ${tx} ${ty-2} l 10 18 l 8 -16 z" fill="${fill}" stroke="${C.line}" stroke-width="2"/>`;
  txt(x+w/2,y+h/2+4,text,{anchor:'middle',size:12});}

const FRAME = {W:1480,H:960};
function windowFrame(url){
  const x=40,y=100,w=1060,h=820;
  rect(x,y,w,h,{fill:C.surface,stroke:C.line,sw:2,rx:12});
  rect(x,y,w,42,{fill:'#eef2f6',stroke:C.line,sw:2,rx:12});
  ['#ef4444','#f59e0b','#22c55e'].forEach((c,i)=>circle(x+24+i*22,y+21,6,{fill:c}));
  rect(x+120,y+11,w-150,20,{fill:'#fff',stroke:C.soft,sw:1,rx:10});
  txt(x+134,y+25,url,{size:12,fill:C.mut,mono:true});
  return {X:x,Y:y+42,W:w,H:h-42}; // content area
}
function legend(items){
  const x=1140,y=100,w=300,h=820;
  rect(x,y,w,h,{fill:C.surface,stroke:C.line,sw:2,rx:12});
  txt(x+18,y+34,'Notes / interactions',{size:16,w:'bold'});
  line(x+18,y+44,x+w-18,y+44,{stroke:C.soft,sw:1});
  let yy=y+72;
  items.forEach((it,i)=>{
    circle(x+28,yy-4,12,{fill:C.red});txt(x+28,yy,String(i+1),{anchor:'middle',fill:'#fff',w:'bold',size:13});
    const lines=wrap(it,36);lines.forEach((ln,li)=>txt(x+48,yy+li*17-4,ln,{size:12.5,fill:C.ink}));
    yy+=Math.max(28,lines.length*17+10);
  });
}
function header(title,sub){txt(40,52,title,{size:24,w:'bold'});if(sub)txt(40,80,sub,{size:14,fill:C.mut});}
function open(){_s='';_tagN=0;rect(0,0,FRAME.W,FRAME.H,{fill:C.bg,stroke:'none'});}
function emit(){return `<svg xmlns="http://www.w3.org/2000/svg" width="${FRAME.W}" height="${FRAME.H}" viewBox="0 0 ${FRAME.W} ${FRAME.H}">${_s}</svg>`;}

// ---- shared editor shell; returns key regions ----
function editorShell(activeTool){
  const a=windowFrame('dreamstudio.ai/edit/aurora-heist');
  const {X,Y,W}=a; const bottom=a.Y+a.H;
  // topbar
  rect(X,Y,W,46,{fill:'#f8fafc',stroke:C.line,sw:1.5});
  txt(X+16,Y+29,'‹ Back',{size:13,fill:C.mut});
  txt(X+90,Y+29,'Aurora Heist  ·  page 2 / 6',{size:14,w:'bold'});
  chip(X+360,Y+12,52,22,'↶ undo',{});chip(X+418,Y+12,52,22,'↷ redo',{});
  chip(X+486,Y+12,70,22,'100%',{});
  chip(X+W-300,Y+12,120,22,'● render: ready',{fg:C.green});
  btn(X+W-168,Y+10,150,26,'Export ▾',{fill:C.yellow,size:13});
  // tool rail
  const TR=X, trW=58, trY=Y+46;
  rect(TR,trY,trW,bottom-trY,{fill:C.tool,stroke:C.line,sw:1.5});
  const tools=[['V','select'],['B','bubble'],['R','region'],['T','text'],['C','crop'],['H','pan']];
  tools.forEach((t,i)=>{const ty=trY+18+i*64;const on=t[1]===activeTool;
    rect(TR+10,ty,trW-20,46,{fill:on?C.yellow:'#33414e',stroke:on?C.line:'#475569',sw:on?2:1,rx:8});
    txt(TR+trW/2,ty+24,t[0],{anchor:'middle',w:'bold',size:16,fill:on?C.ink:'#cbd5e1'});
    txt(TR+trW/2,ty+40,t[1],{anchor:'middle',size:8.5,fill:on?C.ink:'#94a3b8'});});
  // pages rail
  const PR=TR+trW, prW=120, prY=Y+46;
  rect(PR,prY,prW,bottom-prY,{fill:'#f1f5f9',stroke:C.line,sw:1.5});
  txt(PR+12,prY+22,'PAGES',{size:11,w:'bold',fill:C.mut});
  for(let i=0;i<6;i++){const py=prY+34+i*108;const sel=i===1;
    rect(PR+12,py,prW-24,92,{fill:'#fff',stroke:sel?C.blue:C.soft,sw:sel?3:1.5,rx:4});
    imgPH(PR+18,py+6,prW-36,66,`p${i+1}`);txt(PR+prW/2,py+86,`Page ${i+1}`,{anchor:'middle',size:10,fill:C.mut});}
  // right panel
  const rpW=290, RP=X+W-rpW, rpY=Y+46;
  rect(RP,rpY,rpW,bottom-rpY,{fill:'#f8fafc',stroke:C.line,sw:1.5});
  const inspH=Math.round((bottom-rpY)*0.52);
  rect(RP,rpY,rpW,inspH,{fill:'#fff',stroke:C.line,sw:1});
  txt(RP+16,rpY+26,'INSPECTOR',{size:11,w:'bold',fill:C.mut});
  const layY=rpY+inspH;
  rect(RP,layY,rpW,bottom-layY,{fill:'#fff',stroke:C.line,sw:1});
  txt(RP+16,layY+24,'LAYERS',{size:11,w:'bold',fill:C.mut});
  // artboard
  const abX=PR+prW, abY=Y+46, abW=RP-abX, abH=bottom-abY;
  rect(abX,abY,abW,abH,{fill:'#dfe6ee',stroke:'none'});
  return {X,Y,W,bottom,abX,abY,abW,abH,RP,rpY,rpW,inspH,layY,trY};
}
// a comic page with 2x2 panels inside the artboard
function comicPage(abX,abY,abW,abH,o={}){
  const pw=Math.min(abW-80,520), ph=Math.min(abH-60,640);
  const px=abX+(abW-pw)/2, py=abY+(abH-ph)/2;
  rect(px,py,pw,ph,{fill:'#fff',stroke:C.line,sw:2,rx:4});
  const gx=14, half=(pw-gx*3)/2, hh=(ph-gx*3)/2;
  const slots=[[px+gx,py+gx],[px+gx*2+half,py+gx],[px+gx,py+gx*2+hh],[px+gx*2+half,py+gx*2+hh]];
  slots.forEach((s,i)=>imgPH(s[0],s[1],half,hh,`panel ${i+1}`));
  return {px,py,pw,ph,slots,half,hh};
}

// =================== SCREENS ===================
const screens = [];

// 00 FLOW MAP
function s00(){open();header('Comic Studio — page-by-page flow','Quick path (top) lands you in the Reader. Deep path drops into the Editor. One document underneath.');
  const boxes=[
    ['Connect key','BYOK first-run',120],['Dashboard','your comics',360],['Create','idea + style + format',600],
    ['Generating','story→art→letter',860],['Reader','finished book',1140]];
  boxes.forEach((b,i)=>{const x=b[2],y=180,w=200,h=92;rect(x,y,w,h,{fill:C.surface,stroke:C.line,sw:2,rx:10});
    txt(x+w/2,y+38,b[0],{anchor:'middle',w:'bold',size:16});txt(x+w/2,y+62,b[1],{anchor:'middle',size:12,fill:C.mut});
    if(i<boxes.length-1)arrow(x+w+6,y+h/2,boxes[i+1][2]-6,y+h/2);});
  // deep path
  txt(120,330,'…or dive deeper to edit any page:',{size:14,w:'bold',fill:C.blue});
  const edit=[['Editor shell','layers · tools',360],['Bubbles','drag/resize/restyle',640],['Region edit','circle → re-gen',920],['Regen + variations','seeds',1180]];
  arrow(1240,272,1280,420,{stroke:C.blue});
  edit.forEach((b,i)=>{const x=b[2],y=380,w=220,h=86;rect(x,y,w,h,{fill:'#eaf2fe',stroke:C.blue,sw:2,rx:10});
    txt(x+w/2,y+36,b[0],{anchor:'middle',w:'bold',size:15});txt(x+w/2,y+60,b[1],{anchor:'middle',size:12,fill:C.mut});
    if(i<edit.length-1)arrow(x+w+6,y+h/2,edit[i+1][2]-6,y+h/2,{stroke:C.blue});});
  arrow(360+110,466,360+110,520,{stroke:C.ink});
  const out=[['Export','PDF · webtoon · CBZ',360],['Publish / Share','to gallery',640]];
  out.forEach((b,i)=>{const x=b[2],y=520,w=220,h=80;rect(x,y,w,h,{fill:'#eafaf1',stroke:C.green,sw:2,rx:10});
    txt(x+w/2,y+34,b[0],{anchor:'middle',w:'bold',size:15});txt(x+w/2,y+58,b[1],{anchor:'middle',size:12,fill:C.mut});});
  // legend strip
  rect(120,660,1280,200,{fill:C.surface,stroke:C.line,sw:2,rx:12});
  txt(140,694,'How to read these wireframes',{size:16,w:'bold'});
  const notes=['Yellow buttons = the primary / AI action on a screen.',
    'Red numbered dots = a specific interaction, explained in each screen’s Notes panel.',
    'Hatched boxes = generated images (panel art, covers, reference sheets).',
    'Blue outline = the deep-edit (Editor) path; green = publish/export.',
    'One ComicDoc is the source of truth for every screen below — Reader and Editor read the same data.'];
  notes.forEach((n,i)=>{circle(150,728+i*26,5,{fill:C.ink});txt(166,732+i*26,n,{size:13});});
  screens.push(['00-flow', emit()]);}

// 01 CONNECT KEY
function s01(){open();header('Stage 1 — Connect a key (first run)','BYOK: you bring your own provider key. Shown once, before Create.');
  const a=windowFrame('dreamstudio.ai');const{X,Y,W,H}=a;
  rect(X,Y,W,H,{fill:'#fbfcfd'});
  const cw=560,ch=470,cx=X+(W-cw)/2,cy=Y+90;
  rect(cx,cy,cw,ch,{fill:'#fff',stroke:C.line,sw:2,rx:14});
  txt(cx+cw/2,cy+54,'Connect a key to create',{anchor:'middle',size:22,w:'bold'});
  txt(cx+cw/2,cy+82,'You generate on your own key. We never charge or store spend.',{anchor:'middle',size:13,fill:C.mut});
  // provider tabs
  const tabs=['OpenRouter (recommended)','NVIDIA','Gemini'];let tx=cx+40;
  tabs.forEach((t,i)=>{const w=i===0?210:90;chip(tx,cy+110,w,30,t,{fill:i===0?C.yellow:C.panel});tx+=w+10;});
  txt(cx+40,cy+182,'API key',{size:13,w:'bold'});
  rect(cx+40,cy+192,cw-80,42,{fill:'#fff',stroke:C.soft,sw:1.5,rx:8});txt(cx+54,cy+218,'sk-or-•••••••••••••••••••••',{size:13,fill:C.mut,mono:true});
  txt(cx+40,cy+258,'How to get a free OpenRouter key (30s guide) ↗',{size:12.5,fill:C.blue});
  // free-only toggle
  rect(cx+40,cy+284,46,24,{fill:C.green,stroke:C.line,sw:1.5,rx:12});circle(cx+74,cy+296,9,{fill:'#fff'});
  txt(cx+96,cy+300,'Use free models only (no spend) — on by default',{size:13});
  btn(cx+40,cy+330,cw-80,48,'Continue →',{size:16});
  txt(cx+cw/2,cy+404,'Just want to read? Browse the public gallery — no key needed.',{anchor:'middle',size:12,fill:C.mut});
  tag(cx+250,cy+118);tag(cx+cw-60,cy+213);tag(cx+300,cy+258);tag(cx+63,cy+296);tag(cx+cw-110,cy+354);
  legend(['Provider tabs — OpenRouter is primary (text + image + references in one place).',
    'Paste your key. Stored locally in your browser; sent as a header, never to our DB.',
    'Inline guide to grab a key, including OpenRouter’s free models.',
    'Free-only mode is ON by default: blocks any paid model so you never spend by accident.',
    'Continue gates Create. Reading the gallery needs no key.']);
  screens.push(['01-connect-key', emit()]);}

// 02 DASHBOARD
function s02(){open();header('Stage 2 — Dashboard / Library','One product. Your comics; resume any into the editor, or start new.');
  const a=windowFrame('dreamstudio.ai/library');const{X,Y,W,H}=a;
  rect(X,Y,W,52,{fill:'#fff',stroke:C.line,sw:1.5});
  txt(X+20,Y+33,'◤ DreamStudio',{size:16,w:'bold'});
  ['Library','Create','Gallery','Settings'].forEach((t,i)=>txt(X+200+i*110,Y+33,t,{size:13,fill:i===0?C.ink:C.mut,w:i===0?'bold':'normal'}));
  circle(X+W-40,Y+26,16,{fill:C.panel,stroke:C.line,sw:1.5});txt(X+W-40,Y+31,'A',{anchor:'middle',w:'bold',size:13});
  chip(X+W-280,Y+15,120,24,'$0.42 spent today',{});
  // grid
  const gx=X+30,gy=Y+86,cw=232,ch=210,gap=24;
  // new card
  rect(gx,gy,cw,ch,{fill:'#fffdf3',stroke:C.line,sw:2,rx:12,dash:'8 6'});
  txt(gx+cw/2,gy+96,'＋',{anchor:'middle',size:48,w:'bold',fill:C.yellow});
  txt(gx+cw/2,gy+150,'New comic',{anchor:'middle',size:16,w:'bold'});
  const items=[['Aurora Heist','6 pages · ready','Edit'],['Tea Dragon','12 pages · ready','Edit'],['Untitled','draft · generating…','Open']];
  items.forEach((it,i)=>{const x=gx+(i+1)*(cw+gap),y=gy;rect(x,y,cw,ch,{fill:'#fff',stroke:C.line,sw:2,rx:12});
    imgPH(x+12,y+12,cw-24,120,'cover');txt(x+16,y+158,it[0],{size:15,w:'bold'});txt(x+16,y+180,it[1],{size:12,fill:C.mut});
    chip(x+16,y+190,70,24,it[2],{fill:C.panel});chip(x+92,y+190,54,24,'Read',{fill:C.panel});chip(x+150,y+190,66,24,'⋯ more',{fill:C.panel});});
  tag(gx+cw/2,gy+96);tag(gx+(cw+gap)+cw-20,gy+20);tag(gx+(cw+gap)+50,gy+202);tag(X+W-220,Y+27);
  legend(['Start a new comic → goes to the Create screen (Stage 3).',
    'Each comic is one ComicDoc. Cover thumbnail + status (ready / generating / draft).',
    'Edit opens the layer editor; Read opens the reader; ⋯ = duplicate / publish / delete.',
    'Running spend on your key, always visible (BYOK honesty). No credits, no paywall.']);
  screens.push(['02-dashboard', emit()]);}

// 03 CREATE
function s03(){open();header('Stage 3 — Create (the quick path)','One screen. Enough to make a whole book; depth is optional.');
  const a=windowFrame('dreamstudio.ai/create');const{X,Y,W,H}=a;
  rect(X,Y,W,H,{fill:'#fbfcfd'});
  txt(X+30,Y+44,'New comic',{size:20,w:'bold'});
  // left: story
  const lx=X+30,ly=Y+64,lw=560;
  txt(lx,ly+8,'Your story',{size:14,w:'bold'});txt(lx+110,ly+8,'paste a script, or just an idea — we expand it',{size:12,fill:C.mut});
  rect(lx,ly+18,lw,300,{fill:'#fff',stroke:C.soft,sw:1.5,rx:10});
  txt(lx+16,ly+48,'A cat burglar and a retired android pull one last heist',{size:13,fill:C.ink});
  txt(lx+16,ly+70,'during the aurora festival on a floating city…',{size:13,fill:C.ink});
  txt(lx,ly+352,'Creative direction (optional)',{size:13,w:'bold'});
  rect(lx,ly+362,lw,56,{fill:'#fff',stroke:C.soft,sw:1.5,rx:10});txt(lx+16,ly+394,'noir tone, witty banter, keep it PG',{size:12.5,fill:C.mut});
  // right: controls
  const rx=X+620,rw=410;let yy=Y+72;
  txt(rx,yy,'Style',{size:14,w:'bold'});yy+=14;
  const styles=['Auto','Manga','Ink noir','Flat color','Watercolor','Upload ref'];
  styles.forEach((sname,i)=>{const cxp=rx+(i%3)*138,cyp=yy+Math.floor(i/3)*42;chip(cxp,cyp,128,32,sname,{fill:i===0?C.yellow:C.panel});});
  yy+=104;txt(rx,yy,'Format',{size:14,w:'bold'});yy+=14;
  ['Page','Webtoon','Square'].forEach((f,i)=>chip(rx+i*138,yy,128,34,f,{fill:i===0?C.yellow:C.panel}));
  yy+=64;txt(rx,yy,'Length',{size:14,w:'bold'});txt(rx+360,yy,'6 pages',{size:13,anchor:'end',w:'bold'});yy+=14;
  rect(rx,yy,410,8,{fill:C.soft,rx:4,stroke:'none'});circle(rx+150,yy+4,11,{fill:C.yellow,stroke:C.line,sw:2});
  yy+=44;txt(rx,yy,'Cast (auto-detected)',{size:14,w:'bold'});yy+=14;
  ['Burglar','Android','City'].forEach((cst,i)=>{chip(rx+i*138,yy,128,30,cst,{fill:C.panel});});
  // cost + cta
  const by=Y+H-86;rect(X+30,by,W-60,60,{fill:'#fff',stroke:C.line,sw:2,rx:12});
  txt(X+50,by+38,'Estimated: ≈ 9 image calls  ≈ $0.18 on your key  ·  3 cached/free',{size:14,w:'bold'});
  btn(X+W-260,by+12,210,36,'Create comic ✦',{size:16});
  tag(lx+210,ly+44);tag(rx+118,Y+100);tag(rx+118,Y+196);tag(rx+108,Y+318);tag(X+250,by+30);
  legend(['Idea OR full script — same box. Text gets expanded into outline→script→pages→panels (free models).',
    'Style: pick a preset, "Auto", or upload a reference image to match a look.',
    'Format + length pick the page size and how many pages (drives the layout + cost).',
    'Cast is auto-detected from the story; these become locked character reference sheets.',
    'Cost is previewed BEFORE you spend. Create runs the whole pipeline (Stage 4).']);
  screens.push(['03-create', emit()]);}

// 04 GENERATING
function s04(){open();header('Stage 4 — Generating','Watch the book build. Only the image steps cost; text is free.');
  const a=windowFrame('dreamstudio.ai/create/run');const{X,Y,W,H}=a;
  rect(X,Y,W,H,{fill:'#fbfcfd'});
  // left stepper
  const sx=X+40,sy=Y+50;txt(sx,sy,'Building “Aurora Heist”',{size:18,w:'bold'});
  const steps=[['Aggregate story','script → 6 pages → 18 panels','done'],
    ['Style Bible','1 image · seed locked','done'],
    ['Character sheets','3 images (generate once)','active'],
    ['Render pages','page 2 / 6 · 1 image each','queued'],
    ['Lettering','speech bubbles as editable layers','queued'],
    ['Assemble book','→ open reader','queued']];
  steps.forEach((st,i)=>{const y=sy+44+i*72;
    const col=st[2]==='done'?C.green:st[2]==='active'?C.yellow:'#fff';
    circle(sx+16,y,15,{fill:col,stroke:C.line,sw:2});
    txt(sx+16,y+5,st[2]==='done'?'✓':String(i+1),{anchor:'middle',w:'bold',size:13});
    if(i<steps.length-1)line(sx+16,y+16,sx+16,y+56,{stroke:C.soft,sw:2});
    txt(sx+44,y-2,st[0],{size:15,w:'bold'});txt(sx+44,y+18,st[1],{size:12,fill:C.mut});
    chip(sx+360,y-12,84,24,st[2],{fill:st[2]==='active'?'#fff7e0':C.panel});});
  // right preview
  const rx=X+560,ry=Y+50,rw=460;
  txt(rx,ry,'Live preview',{size:14,w:'bold'});
  imgPH(rx,ry+12,220,150,'Style Bible');txt(rx,ry+182,'Style key-frame (locked)',{size:11,fill:C.mut});
  ['Burglar','Android','City'].forEach((c,i)=>imgPH(rx+240+i*0,ry+12+i*0,0,0)); // noop
  imgPH(rx+250,ry+12,100,72,'Burglar');imgPH(rx+360,ry+12,100,72,'Android');imgPH(rx+250,ry+92,100,72,'City');
  txt(rx+250,ry+182,'Character reference sheets',{size:11,fill:C.mut});
  rect(rx,ry+210,rw,260,{fill:'#fff',stroke:C.line,sw:1.5,rx:8});
  txt(rx+16,ry+236,'Pages',{size:12,w:'bold',fill:C.mut});
  for(let i=0;i<6;i++){const px=rx+16+(i%3)*150,py=ry+250+Math.floor(i/3)*110;
    if(i<1){imgPH(px,py,130,92,`p${i+1} ✓`);} else if(i===1){rect(px,py,130,92,{fill:'#fff7e0',stroke:C.yellow,sw:2,rx:4});txt(px+65,py+50,'rendering…',{anchor:'middle',size:11,fill:C.mut});}
    else{rect(px,py,130,92,{fill:C.panel,stroke:C.soft,sw:1,rx:4});txt(px+65,py+50,`p${i+1}`,{anchor:'middle',size:11,fill:C.mut});}}
  // bottom
  const by=Y+H-70;chip(X+40,by,260,30,'spent so far: $0.06  ·  2 cache hits',{});
  btn(X+W-180,by-4,140,36,'Cancel',{fill:'#fff'});
  tag(sx+402,sy+44+0*72-0);tag(rx+110,ry+90);tag(rx+300,ry+90);tag(X+170,by+15);
  legend(['Stages run top-to-bottom; text stages (aggregate) are free. Done = green, active = yellow.',
    'Style Bible image is generated ONCE and locked with a seed — the visual north star.',
    'Each character gets a reference sheet ONCE; reused on every page for consistency.',
    'Running spend + cache hits shown live; Cancel stops safely (keeps finished pages).']);
  screens.push(['04-generating', emit()]);}

// 05 READER
function s05(){open();header('Stage 5 — Reader','The finished comic book. Read free; Edit to go deep; Publish to share.');
  const a=windowFrame('dreamstudio.ai/read/aurora-heist');const{X,Y,W,H}=a;
  rect(X,Y,W,46,{fill:'#fff',stroke:C.line,sw:1.5});txt(X+18,Y+29,'‹ Library',{size:13,fill:C.mut});
  txt(X+W/2,Y+29,'Aurora Heist',{anchor:'middle',size:16,w:'bold'});
  btn(X+W-300,Y+9,120,28,'✎ Edit',{fill:C.yellow,size:13});btn(X+W-170,Y+9,150,28,'Publish / Share',{fill:'#eafaf1',size:13});
  rect(X,Y+46,W,H-46,{fill:'#2b2f36'});
  // page spread
  const pw=300,ph=440,cx=X+W/2,cy=Y+46+(H-46)/2;
  imgPH(cx-pw-10,cy-ph/2,pw,ph,'page 2');imgPH(cx+10,cy-ph/2,pw,ph,'page 3');
  // arrows
  circle(X+60,cy,22,{fill:'#fff',stroke:C.line,sw:2});txt(X+60,cy+6,'‹',{anchor:'middle',size:22,w:'bold'});
  circle(X+W-60,cy,22,{fill:'#fff',stroke:C.line,sw:2});txt(X+W-60,cy+6,'›',{anchor:'middle',size:22,w:'bold'});
  // thumb strip
  for(let i=0;i<6;i++){const tx=X+W/2-186+i*64;rect(tx,Y+H-78,54,60,{fill:'#fff',stroke:(i===1||i===2)?C.yellow:C.soft,sw:(i===1||i===2)?2:1,rx:3});txt(tx+27,Y+H-44,`${i+1}`,{anchor:'middle',size:11,fill:C.mut});}
  tag(X+W-240,Y+23);tag(X+W-95,Y+23);tag(cx,cy-ph/2-2);tag(X+W/2+150,Y+H-48);
  legend(['Edit jumps straight into the layer editor on this exact book (Stage 6).',
    'Publish/Share pushes to the public gallery / share link (existing system reused).',
    'Page-by-page reading; spread or single/webtoon-scroll depending on the format.',
    'Thumbnail strip to jump pages; current spread highlighted.']);
  screens.push(['05-reader', emit()]);}

// 06 EDITOR SHELL
function s06(){open();header('Stage 6 — Editor (overall shell)','Adobe-style: page = artboard, everything is a layer. No AI yet here — pure manipulation.');
  const e=editorShell('select');
  const p=comicPage(e.abX,e.abY,e.abW,e.abH);
  // a couple bubbles + selected panel
  rect(p.slots[0][0]-3,p.slots[0][1]-3,p.half+6,p.hh+6,{fill:'none',stroke:C.blue,sw:3,rx:4});
  bubble(p.slots[0][0]+14,p.slots[0][1]+12,120,40,'One last job.',{tail:'bl'});
  bubble(p.slots[1][0]+40,p.slots[1][1]+16,110,38,'You’re late.',{tail:'br'});
  // inspector content (panel selected)
  const RP=e.RP,rpY=e.rpY;txt(RP+16,rpY+52,'Selected: Panel 1',{size:13,w:'bold'});
  txt(RP+16,rpY+78,'Brief:',{size:12,fill:C.mut});txt(RP+16,rpY+96,'Burglar perches on the spire',{size:12});
  txt(RP+16,rpY+124,'Model: gemini-image (artist)',{size:12,fill:C.mut});txt(RP+16,rpY+144,'Seed: 48213',{size:12,mono:true,fill:C.mut});
  btn(RP+16,rpY+162,120,30,'↻ Re-roll',{fill:C.yellow,size:12});btn(RP+146,rpY+162,120,30,'Explode ▤',{fill:'#fff',size:12});
  // layers list
  const ly=e.layY+40;const layers=[['Bubble “One last job.”','B'],['Bubble “You’re late.”','B'],['Panel 1 — art (raster)','R'],['Page background','▦']];
  layers.forEach((l,i)=>{const y=ly+i*38;rect(RP+12,y,e.rpW-24,32,{fill:i===2?'#eaf2fe':'#fff',stroke:C.soft,sw:1,rx:5});
    txt(RP+22,y+21,'☰',{size:13,fill:C.mut});txt(RP+44,y+21,l[0],{size:12});txt(RP+e.rpW-58,y+21,'👁',{size:12});txt(RP+e.rpW-34,y+21,'🔒',{size:12});});
  tag(e.X+29, e.Y+118);                      // 1 tool rail
  tag(p.slots[0][0]+10, p.slots[0][1]+10);   // 2 selected panel
  tag(p.slots[0][0]+128, p.slots[0][1]+20);  // 3 a bubble
  tag(RP+28, rpY+52);                        // 4 inspector
  tag(RP+28, e.layY+24);                     // 5 layers
  tag(e.X+58+60, e.Y+70);                    // 6 pages rail
  legend(['Left tool rail: Select(V) Bubble(B) Region(R) Text(T) Crop(C) Pan(H).',
    'Click a panel to select it (blue outline) → its art is a Raster layer you can re-roll.',
    'Speech bubbles are vector layers floating ABOVE the art — drag, resize, restyle freely.',
    'Inspector shows the selection’s props: panel brief, model, seed, Re-roll / Explode-to-panels.',
    'Layers panel: every element ordered bottom→top; toggle visibility/lock, reorder by drag.',
    'Pages rail (far left): switch/add/reorder pages; undo/redo + autosave always on.']);
  screens.push(['06-editor-shell', emit()]);}

// 07 BUBBLES
function s07(){open();header('Stage 6a — Bubble editing','Drag/drop bubbles of many designs, resize, restyle, stack layer-on-layer.');
  const e=editorShell('bubble');
  const p=comicPage(e.abX,e.abY,e.abW,e.abH);
  // bubble palette floating near artboard top
  const palX=e.abX+20,palY=e.abY+10;rect(palX,palY,e.abW-40,56,{fill:'#fff',stroke:C.line,sw:2,rx:10});
  txt(palX+14,palY+22,'BUBBLES',{size:10,w:'bold',fill:C.mut});
  const designs=['speech','thought','shout','whisper','narration','caption','burst','radio','off-pnl'];
  designs.forEach((d,i)=>{const bx=palX+90+i*78;rect(bx,palY+12,68,32,{fill:C.panel,stroke:C.soft,sw:1,rx:8});txt(bx+34,palY+32,d,{anchor:'middle',size:10});});
  // a selected bubble with handles
  const bx=p.slots[1][0]+30,by=p.slots[1][1]+40,bw=150,bh=56;
  bubble(bx,by,bw,bh,'You’re late, tin man.',{tail:'br'});
  rect(bx-4,by-4,bw+8,bh+8,{fill:'none',stroke:C.blue,sw:2,dash:'4 3'});
  [[bx-4,by-4],[bx+bw/2,by-4],[bx+bw+4,by-4],[bx-4,by+bh/2],[bx+bw+4,by+bh/2],[bx-4,by+bh+4],[bx+bw/2,by+bh+4],[bx+bw+4,by+bh+4]].forEach(h=>rect(h[0]-4,h[1]-4,8,8,{fill:'#fff',stroke:C.blue,sw:2}));
  circle(bx+bw-18,by+bh+18,5,{fill:C.blue}); // tail handle
  // other bubbles to show stacking
  bubble(p.slots[0][0]+14,p.slots[0][1]+12,120,40,'One last job.',{});
  // inspector = bubble props
  const RP=e.RP,rpY=e.rpY;txt(RP+16,rpY+52,'Bubble',{size:13,w:'bold'});
  txt(RP+16,rpY+76,'Design',{size:11,fill:C.mut});chip(RP+16,rpY+84,80,26,'speech ▾',{fill:C.panel});
  txt(RP+16,rpY+126,'Text',{size:11,fill:C.mut});rect(RP+16,rpY+134,e.rpW-32,40,{fill:'#fff',stroke:C.soft,sw:1,rx:6});txt(RP+24,rpY+158,'You’re late, tin man.',{size:11});
  txt(RP+16,rpY+192,'Font',{size:11,fill:C.mut});chip(RP+16,rpY+200,110,24,'Comic ▾',{fill:C.panel});chip(RP+132,rpY+200,50,24,'16',{fill:C.panel});chip(RP+188,rpY+200,70,24,'B I ≡',{fill:C.panel});
  txt(RP+16,rpY+240,'Fill / stroke / radius',{size:11,fill:C.mut});chip(RP+16,rpY+248,36,24,'⬜',{});chip(RP+58,rpY+248,36,24,'⬛',{});rect(RP+100,rpY+250,90,8,{fill:C.soft,rx:4,stroke:'none'});
  txt(RP+16,rpY+288,'Speaker',{size:11,fill:C.mut});chip(RP+16,rpY+296,130,26,'Android ▾',{fill:C.panel});
  // layers
  const ly=e.layY+40;['Bubble “You’re late…” ◀','Bubble “One last job.”','Panel — art'].forEach((l,i)=>{const y=ly+i*38;rect(RP+12,y,e.rpW-24,32,{fill:i===0?'#eaf2fe':'#fff',stroke:C.soft,sw:1,rx:5});txt(RP+22,y+21,'☰',{size:13,fill:C.mut});txt(RP+44,y+21,l,{size:11});});
  tag(palX+140,palY+28);tag(bx+bw+4,by-4);tag(bx+bw-18,by+bh+18);tag(RP+90,rpY+97);tag(RP+90,rpY+309);tag(RP+e.rpW/2,e.layY+24);
  legend(['Bubble palette: 9+ designs. Click/drag one onto a panel to drop a new bubble layer.',
    'Eight handles resize (Shift = keep ratio); text auto-fits. Rotate handle on top.',
    'Tail endpoint is draggable — snap it to a character so it re-points if the bubble moves.',
    'Inspector: swap design (keeps text+position), edit text, font/size/style, fill/stroke/radius.',
    'Link a Speaker (character) to auto-color the bubble/tail.',
    'Multiple bubbles per panel stack as layers (layer-on-layer); reorder in the Layers list. Preserved when the art is re-rolled.']);
  screens.push(['07-editor-bubbles', emit()]);}

// 08 REGION EDIT
function s08(){open();header('Stage 6b — Circle / region-to-edit','Mask a spot, describe the change, re-generate ONLY that area (non-destructive).');
  const e=editorShell('region');
  const p=comicPage(e.abX,e.abY,e.abW,e.abH);
  // focus one big panel
  rect(p.slots[0][0]-3,p.slots[0][1]-3,p.half+6,p.hh+6,{fill:'none',stroke:C.blue,sw:3,rx:4});
  // sub-tool bar
  const stX=e.abX+20,stY=e.abY+10;rect(stX,stY,420,48,{fill:'#fff',stroke:C.line,sw:2,rx:10});
  ['Brush','Lasso','Ellipse','Rect','Magic'].forEach((t,i)=>chip(stX+12+i*78,stY+12,70,24,t,{fill:i===0?C.yellow:C.panel}));
  txt(stX+400,stY+30,'size',{size:10,anchor:'end',fill:C.mut});
  // mask blob on panel
  const mx=p.slots[0][0]+90,my=p.slots[0][1]+120;
  _s+=`<ellipse cx="${mx}" cy="${my}" rx="58" ry="42" fill="${C.maskFill}" stroke="${C.red}" stroke-width="2" stroke-dasharray="5 4"/>`;
  txt(mx,my+4,'masked',{anchor:'middle',size:11,fill:C.red,w:'bold'});
  // prompt bar
  const pbX=e.abX+20,pbY=e.abY+e.abH-150,pbW=e.abW-40;
  rect(pbX,pbY,pbW,46,{fill:'#fff',stroke:C.line,sw:2,rx:10});
  txt(pbX+16,pbY+28,'Describe the change in this area:  “fix the left hand — 5 fingers”',{size:13});
  chip(pbX+pbW-260,pbY+10,120,26,'keep style ✓',{fill:'#eafaf1'});btn(pbX+pbW-130,pbY+8,120,30,'Generate ✦',{size:13});
  // variation tray
  const vy=e.abY+e.abH-92;rect(pbX,vy,pbW,80,{fill:'#f8fafc',stroke:C.line,sw:1.5,rx:10});
  txt(pbX+14,vy+22,'Candidates',{size:11,w:'bold',fill:C.mut});
  for(let i=0;i<3;i++){const vx=pbX+110+i*150;imgPH(vx,vy+10,120,58,`var ${i+1}`);}
  btn(pbX+110+3*150+10,vy+22,90,30,'Accept',{fill:C.yellow,size:12});chip(pbX+110+3*150+110,vy+27,70,24,'More',{fill:'#fff'});
  tag(stX+46,stY+24);tag(mx+58,my-42);tag(pbX+260,pbY+22);tag(pbX+pbW-200,pbY+23);tag(pbX+170,vy+39);
  legend(['Region sub-tools: Brush / Lasso / Ellipse / Rect (Magic = click-to-segment, later).',
    'Paint a mask over the messy spot (here, a hand). Alt = erase mask. It’s captured as a PNG mask.',
    'Type the fix. “Keep style” injects the Style Bible so the patch matches.',
    'Generate sends {image + mask + prompt} to an inpaint-capable model (fallback: masked instruct-edit, we re-composite only the masked region).',
    'Pick a candidate → it lands as an InpaintLayer ON TOP of the art (non-destructive; delete to undo). Bubbles untouched.']);
  screens.push(['08-editor-region-edit', emit()]);}

// 09 REGEN + VARIATIONS
function s09(){open();header('Stage 6c — Panel re-roll + variations','Re-generate a whole panel, get N options, pick one. Seeds = control.');
  const e=editorShell('select');
  const p=comicPage(e.abX,e.abY,e.abW,e.abH);
  rect(p.slots[2][0]-3,p.slots[2][1]-3,p.half+6,p.hh+6,{fill:'none',stroke:C.blue,sw:3,rx:4});
  // re-roll popover near panel
  const poX=p.slots[2][0]+p.half+20,poY=p.slots[2][1];
  if(poX+260>e.abX+e.abW){} // ok
  rect(poX,poY,250,150,{fill:'#fff',stroke:C.line,sw:2,rx:10});
  txt(poX+16,poY+26,'Re-roll panel 3',{size:13,w:'bold'});
  rect(poX+16,poY+38,218,40,{fill:'#fff',stroke:C.soft,sw:1,rx:6});txt(poX+24,poY+62,'change: wider shot, rain',{size:11,fill:C.mut});
  txt(poX+16,poY+96,'seed',{size:11,fill:C.mut});chip(poX+54,poY+84,80,22,'48213',{fill:C.panel});chip(poX+140,poY+84,40,22,'🎲',{fill:C.panel});
  txt(poX+16,poY+118,'variations',{size:11,fill:C.mut});chip(poX+96,poY+108,30,20,'3',{fill:C.panel});
  btn(poX+140,poY+108,94,26,'Generate',{size:12});
  // variation tray bottom
  const pbX=e.abX+20,vy=e.abY+e.abH-110,pbW=e.abW-40;
  rect(pbX,vy,pbW,96,{fill:'#f8fafc',stroke:C.line,sw:1.5,rx:10});
  txt(pbX+14,vy+24,'Variations — pick one (bubbles are preserved)',{size:12,w:'bold',fill:C.mut});
  for(let i=0;i<4;i++){const vx=pbX+20+i*150;rect(vx,vy+32,134,52,{fill:'#fff',stroke:i===1?C.yellow:C.soft,sw:i===1?3:1,rx:4});imgPH(vx+4,vy+36,126,44,`option ${i+1}`);}
  chip(pbX+20+4*150,vy+50,90,24,'$0.02 ea',{});
  tag(p.slots[2][0]+8,p.slots[2][1]+8);tag(poX+170,poY+95);tag(poX+200,poY+121);tag(pbX+87,vy+58);
  legend(['Select a panel, choose Re-roll. Add an optional change note (keeps the rest of the page).',
    'Seed is shown + editable (🎲 = randomize). Same seed + tweak = a controlled nudge, not a fresh gamble.',
    'Ask for N variations only when you want them (default 3) — never auto-spent.',
    'Pick a variation → swaps just this panel’s art layer; bubbles/inpaint layers above stay. Cost shown per option; identical = cached/free.']);
  screens.push(['09-editor-regen-variations', emit()]);}

// 10 LAYERS CLOSEUP
function s10(){open();header('Stage 6d — Layers (the “layer on layer” system)','Every element is a non-destructive layer. Reorder, hide, lock, blend, group.');
  const a=windowFrame('dreamstudio.ai/edit/aurora-heist');const{X,Y,W,H}=a;
  rect(X,Y,W,H,{fill:'#dfe6ee'});
  // big panel preview left
  const px=X+40,py=Y+40,pw=560,ph=H-90;rect(px,py,pw,ph,{fill:'#fff',stroke:C.line,sw:2,rx:6});
  imgPH(px+20,py+20,pw-40,ph-120,'panel art (raster)');
  _s+=`<ellipse cx="${px+pw/2-60}" cy="${py+200}" rx="70" ry="48" fill="rgba(39,171,131,0.18)" stroke="${C.green}" stroke-width="2" stroke-dasharray="5 4"/>`;txt(px+pw/2-60,py+200,'inpaint layer',{anchor:'middle',size:11,fill:C.green});
  bubble(px+60,py+60,150,46,'One last job, partner.',{});
  bubble(px+pw-220,py+120,150,46,'Then we vanish.',{tail:'br'});
  // layers panel right (big)
  const LX=X+640,LY=Y+40,LW=W-680,LH=H-90;rect(LX,LY,LW,LH,{fill:'#fff',stroke:C.line,sw:2,rx:10});
  txt(LX+18,LY+30,'LAYERS — Panel 2',{size:14,w:'bold'});
  chip(LX+LW-150,LY+14,130,26,'＋ add · group ⌘G',{fill:C.panel});
  const rows=[['☰ T','SFX “BOOM”','text','100%'],['☰ B','Bubble “Then we vanish.”','bubble','100%'],['☰ B','Bubble “One last job…”','bubble','100%'],['☰ ✦','Inpaint — hand fix','inpaint','100%'],['☰ ▣','Panel art','raster','100%'],['☰ ▦','Page background','raster','100%']];
  rows.forEach((r,i)=>{const y=LY+56+i*64;const sel=i===3;rect(LX+16,y,LW-32,54,{fill:sel?'#eafaf1':'#fff',stroke:sel?C.green:C.soft,sw:sel?2:1.5,rx:8});
    txt(LX+30,y+33,r[0],{size:13,fill:C.mut});txt(LX+78,y+26,r[1],{size:13,w:'bold'});txt(LX+78,y+44,r[2],{size:11,fill:C.mut});
    txt(LX+LW-150,y+33,'opacity',{size:10,fill:C.mut});rect(LX+LW-100,y+26,60,8,{fill:C.soft,rx:4,stroke:'none'});circle(LX+LW-44,y+30,7,{fill:C.ink});
    txt(LX+LW-150,y+50,'👁  🔒',{size:12,fill:C.mut});});
  txt(LX+18,LY+LH-20,'top of list = front.  drag ☰ to reorder.  double-click to rename.',{size:11,fill:C.mut});
  tag(LX+30, LY+56+0*64+27);    // 1 reorder handle (top row)
  tag(LX+LW-70, LY+56+1*64+30); // 2 opacity / blend
  tag(px+pw/2-60, py+200-48);   // 3 inpaint layer on canvas
  tag(LX+LW-138, LY+27);        // 4 group / add
  legend(['Stack order = render order. Bubbles + SFX sit above art; reorder by dragging the ☰ handle.',
    'Per-layer opacity + blend; 👁 hide, 🔒 lock. Non-destructive — nothing is flattened until export.',
    'A region edit is just an InpaintLayer composited over the art — lower its opacity or delete to reveal the original.',
    'Group related layers (⌘G) — e.g. all of one character’s bubbles — to move/lock together.']);
  screens.push(['10-editor-layers', emit()]);}

[s00,s01,s02,s03,s04,s05,s06,s07,s08,s09,s10].forEach(f=>f());

for(const [name,svg] of screens){
  writeFileSync(join(OUT,`${name}.svg`), svg);
  await sharp(Buffer.from(svg)).png().toFile(join(OUT,`${name}.png`));
  console.log('wrote', name);
}
console.log('done:', screens.length, 'screens');
