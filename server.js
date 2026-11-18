const express=require('express'),Database=require('better-sqlite3'),path=require('path'),crypto=require('crypto');
const E=process.env,db=new Database(E.DB_FILE||'tiq.db');
db.exec(`create table if not exists jobs(id integer primary key,title text,dept text,location text,open int default 1);
create table if not exists candidates(id integer primary key,name text,email text,job_id int,stage text default 'Shortlisted',created text default current_timestamp);
create table if not exists interviews(id integer primary key,candidate_id int,meeting_url text,scheduled_at text,interviewer text,bot_id text,status text default 'scheduled',transcript text,feedback text,score int,recommendation text,duration_sec int,recording_url text,error text,created text default current_timestamp);`);
const app=express();app.use(express.json({limit:'20mb'}));
const one=(s,...a)=>db.prepare(s).get(...a),all=(s,...a)=>db.prepare(s).all(...a),run=(s,...a)=>db.prepare(s).run(...a);

async function analyze(id){
  try{
    const row=one('select i.transcript,c.name,j.title from interviews i join candidates c on c.id=i.candidate_id left join jobs j on j.id=c.job_id where i.id=?',id);
    if(!row||!(row.transcript||'').trim())throw new Error('Transcript is empty');
    run("update interviews set status='analyzing',error=null where id=?",id);
    const prompt=`You are an expert interview evaluator. Role: ${row.title||'not specified'}. Candidate: ${row.name}. Judge only from the transcript and do not invent evidence. Return JSON with keys: score (0-100 integer), recommendation ("Recommended"|"Maybe"|"Not a fit"), summary (string), strengths (string[]), concerns (string[]), missing_skills (string[] of skills the role needs that the candidate did not show).\n\nTranscript:\n${row.transcript.slice(0,200000)}`;
    const r=await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${E.GEMINI_MODEL||'gemini-2.5-flash'}:generateContent`,{method:'POST',headers:{'x-goog-api-key':E.GEMINI_API_KEY,'Content-Type':'application/json'},body:JSON.stringify({contents:[{parts:[{text:prompt}]}],generationConfig:{responseMimeType:'application/json',temperature:0.2}})});
    const j=await r.json();if(!r.ok)throw new Error(j.error?.message||'Gemini request failed');
    const f=JSON.parse(j.candidates[0].content.parts[0].text);
    run("update interviews set status='done',feedback=?,score=?,recommendation=? where id=?",JSON.stringify(f),Math.max(0,Math.min(100,Math.round(+f.score||0))),f.recommendation,id);
    run("update candidates set stage='Interviewed' where stage in ('Shortlisted','Scheduled') and id=(select candidate_id from interviews where id=?)",id);
  }catch(e){run("update interviews set status='failed',error=? where id=?",e.message,id)}
}

// Meeting BaaS webhook (secret in query string, no basic auth)
app.post('/webhooks/meetingbaas',(req,res)=>{
  if(req.query.secret!==E.WEBHOOK_SECRET)return res.sendStatus(401);
  res.sendStatus(200);
  try{
    const b=req.body||{},d=b.data||b,row=one('select id from interviews where bot_id=?',d.bot_id||b.bot_id);
    if(!row)return;
    if(b.event==='failed')return run("update interviews set status='failed',error=? where id=?",String(d.error||d.message||'Meeting bot failed'),row.id);
    if(b.event!=='complete')return;
    const tr=d.transcript||[],text=tr.map(t=>`${t.speaker}: ${(t.words||[]).map(w=>w.word).join(' ')}`).join('\n');
    const last=tr.at(-1)?.words?.at(-1)?.end||0;
    run('update interviews set transcript=?,recording_url=?,duration_sec=? where id=?',text,d.mp4||d.mp4_url||null,Math.round(last),row.id);
    analyze(row.id);
  }catch(e){console.error(e)}
});

const PW=(E.ADMIN_PASSWORD||'').trim(),TOK=crypto.createHmac('sha256',PW||'unset').update('tiq').digest('hex');
const LOGIN=`<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>TIQ sign in</title><style>body{font:16px system-ui,sans-serif;background:#f2f5fa;display:grid;place-items:center;min-height:100vh;margin:0}form{background:#fff;padding:24px;border-radius:14px;width:min(92vw,360px);box-shadow:0 2px 8px #0002}h1{margin:0 0 12px;font-size:22px}input{width:100%;padding:12px;font-size:16px;border:1px solid #d0d5dd;border-radius:8px;box-sizing:border-box}button{width:100%;margin-top:12px;padding:12px;font-size:16px;background:#1556c9;color:#fff;border:0;border-radius:8px}label{display:block;margin-top:10px;font-size:14px}#e{color:#b42318;margin-top:8px}</style></head><body><form id="f"><h1>TIQ sign in</h1>%%NOPW%%<input id="p" type="password" placeholder="Password" autocomplete="current-password" autocapitalize="off" autocorrect="off" spellcheck="false" aria-label="Password"><label><input id="s" type="checkbox" style="width:auto"> Show password</label><button>Sign in</button><div id="e"></div></form><script>var p=document.getElementById('p'),e=document.getElementById('e');document.getElementById('s').onchange=function(){p.type=this.checked?'text':'password'};document.getElementById('f').onsubmit=function(x){x.preventDefault();fetch('/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({password:p.value})}).then(function(r){if(r.ok)location.href='/';else e.textContent='Wrong password. Check the value in Render and try again.'})}</script></body></html>`;
app.get(['/manifest.json','/sw.js','/icon-192.png','/icon-512.png'],(req,res)=>res.sendFile(path.join(__dirname,req.path.slice(1))));
app.get('/login',(req,res)=>res.type('html').send(LOGIN.replace('%%NOPW%%',PW?'':'<p style="color:#b42318">ADMIN_PASSWORD is not set on the server. Add it in Render, then redeploy.</p>')));
app.post('/login',(req,res)=>{const p=String((req.body||{}).password||'').trim();if(PW&&p===PW){res.set('Set-Cookie','tiq='+TOK+'; Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000'+(req.headers['x-forwarded-proto']==='https'?'; Secure':''));return res.json({ok:1})}res.status(401).json({error:'Wrong password'})});
app.use((req,res,next)=>{const c=(req.headers.cookie||'').split(/;\s*/).find(x=>x.startsWith('tiq='));if(c&&c.slice(4)===TOK)return next();if(req.path.startsWith('/api'))return res.status(401).json({error:'Please sign in'});res.redirect('/login')});

app.get('/api/state',(_,res)=>res.json({jobs:all('select * from jobs'),candidates:all('select * from candidates'),
  interviews:all('select id,candidate_id,meeting_url,scheduled_at,interviewer,bot_id,status,feedback,score,recommendation,duration_sec,recording_url,error,length(transcript) tlen from interviews order by id desc').map(i=>({...i,feedback:i.feedback?JSON.parse(i.feedback):null}))}));
app.get('/api/interviews/:id/transcript',(req,res)=>res.json(one('select transcript from interviews where id=?',req.params.id)||{}));
app.post('/api/jobs',(req,res)=>{const{title,dept,location}=req.body;if(!title)return res.status(400).json({error:'Title required'});run('insert into jobs(title,dept,location) values(?,?,?)',title,dept||'',location||'');res.json({ok:1})});
app.post('/api/jobs/:id/toggle',(req,res)=>{run('update jobs set open=1-open where id=?',req.params.id);res.json({ok:1})});
app.post('/api/candidates',(req,res)=>{const{name,email,job_id}=req.body;if(!name)return res.status(400).json({error:'Name required'});run('insert into candidates(name,email,job_id) values(?,?,?)',name,email||'',job_id||null);res.json({ok:1})});
app.post('/api/candidates/:id/stage',(req,res)=>{run('update candidates set stage=? where id=?',req.body.stage,req.params.id);res.json({ok:1})});
app.post('/api/interviews',(req,res)=>{const b=req.body;if(!b.candidate_id||!/^https?:\/\//.test(b.meeting_url||''))return res.status(400).json({error:'Candidate and a valid meeting URL are required'});run('insert into interviews(candidate_id,meeting_url,scheduled_at,interviewer) values(?,?,?,?)',b.candidate_id,b.meeting_url,b.scheduled_at||null,b.interviewer||'');run("update candidates set stage='Scheduled' where stage='Shortlisted' and id=?",b.candidate_id);res.json({ok:1})});
app.post('/api/interviews/:id/reanalyze',(req,res)=>{analyze(req.params.id);res.json({ok:1})});
app.post('/api/interviews/:id/bot',async(req,res)=>{
  const i=one('select * from interviews where id=?',req.params.id);if(!i)return res.sendStatus(404);
  try{
    const r=await fetch('https://api.meetingbaas.com/bots',{method:'POST',headers:{'x-meeting-baas-api-key':E.MEETING_BAAS_API_KEY,'Content-Type':'application/json'},body:JSON.stringify({meeting_url:i.meeting_url,bot_name:E.BOT_NAME||'TIQ Notetaker',speech_to_text:E.STT_PROVIDER||'Gladia',webhook_url:`${E.PUBLIC_URL||E.RENDER_EXTERNAL_URL}/webhooks/meetingbaas?secret=${E.WEBHOOK_SECRET}`})});
    const j=await r.json();if(!r.ok||!j.bot_id)throw new Error(JSON.stringify(j));
    run("update interviews set bot_id=?,status='bot_sent',error=null where id=?",j.bot_id,i.id);res.json({ok:1});
  }catch(e){run("update interviews set status='failed',error=? where id=?",e.message,i.id);res.status(502).json({error:e.message})}
});
app.get(['/','/index.html'],(req,res)=>res.sendFile(path.join(__dirname,'index.html')));
app.listen(E.PORT||3000,()=>console.log('TIQ running on port '+(E.PORT||3000)));
