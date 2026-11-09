import {el,node,button} from './ui.js'
import {loadDraft,saveDraft,selectedRound,rememberRound} from './drafts.js'
import {createBuilder} from './builder.js'
import {jobLabel,renderTestOutput,renderRunSummary} from './results.js'

const state={room:null,entrant:null,problems:[],problem:null,doc:'rules',cache:new Map(),
  drafts:new Map(),active:null,history:[],latestScores:[],details:new Map(),viewed:new Map(),roster:[],previewIds:new Map(),
  sending:false,error:null,view:'work',poll:null,selection:0,loadingProblem:false}
const statuses={SETUP:'Chưa mở phòng',OPEN:'Đang nhận bài',CLOSED:'Đã đóng nhận bài'}
const typeLabels={integer:'Số nguyên',number:'Số',string:'Văn bản',boolean:'Có hoặc Không',enum:'Lựa chọn',orderStatus:'Trạng thái đơn'}

async function api(path,{body,key}={}) {
  const response=await fetch(path,{method:body===undefined?'GET':'POST',headers:{
    ...(body===undefined?{}:{'content-type':'application/json'}),...(key?{'idempotency-key':key}:{})
  },body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(10000)})
  const value=await response.json()
  if (!response.ok) throw Object.assign(new Error(value.error || 'Yêu cầu chưa hoàn tất.'),{status:response.status})
  return value
}
function draft() {
  if (!state.problem || !state.entrant) return null
  const id=state.problem.id
  if (!state.drafts.has(id)) state.drafts.set(id,loadDraft(state.entrant,id))
  return state.drafts.get(id)
}
function save() {
  if (state.problem && state.entrant) saveDraft(state.entrant,state.problem.id,draft())
}
function busy() {return state.loadingProblem||state.sending||Boolean(state.active)||state.room?.state!=='OPEN'}
function refreshRoom(room) {
  state.room=room
  el('room-name').textContent=room.label
  el('room-state').textContent=statuses[room.state]
  el('invite-wrap').hidden=!room.inviteRequired
  el('invite').required=Boolean(room.inviteRequired)
  el('join-button').disabled=room.state!=='OPEN'
  el('desk-status').textContent=room.label+' / '+statuses[room.state]
  updateSubmit()
}
function showEntry() {
  state.entrant=null;state.active=null;state.problem=null;state.history=[];state.latestScores=[];state.roster=[];state.error=null
  state.cache.clear();state.drafts.clear();state.details.clear();state.viewed.clear();state.previewIds.clear()
  state.selection++;state.loadingProblem=false
  el('who').textContent='';el('logout').hidden=true;el('desk').hidden=true;el('entry').hidden=false
}
function mine() {return state.roster.find(row=>row.id===state.entrant?.id)}
function renderProblems() {
  const player=mine()
  el('problem-list').replaceChildren(...state.problems.map((problem,index)=>{
    const current=player?.byProblem[problem.id]??0
    const control=button(String(index+1).padStart(2,'0')+' / '+problem.title,()=>openProblem(problem.id))
    control.setAttribute('aria-pressed',String(problem.id===state.problem?.id))
    const passing=current>=problem.minScore
    control.append(node('span',current+' điểm / Ngưỡng '+problem.minScore+' / '+(passing?'Qua vòng':'Chưa qua vòng'),passing?'small good':'muted small'))
    return control
  }))
}
function rememberDetail(job) {
  state.details.delete(job.id)
  state.details.set(job.id,job)
  if (state.details.size>24) state.details.delete(state.details.keys().next().value)
}
async function readDetail(id) {
  if (state.details.has(id)) return state.details.get(id)
  const entrant=state.entrant
  const {job}=await api('/api/jobs/'+id)
  if (entrant===state.entrant && job.state==='DONE') rememberDetail(job)
  return job
}
function chosenRun(mode) {
  const id=state.problem?.id
  if (!id) return null
  const chosen=state.details.get(state.viewed.get(id))
  if (chosen && (!mode || chosen.mode===mode)) return chosen
  if (state.active?.problem===id && (!mode || state.active.mode===mode)) return state.active
  const recent=mode==='SCORE'?null:state.history.find(job=>job.problem===id && job.state==='DONE')
  const summary=recent??state.latestScores.find(job=>job.problem===id)
  return summary?(state.details.get(summary.id)??summary):null
}
async function hydrateRun() {
  const job=chosenRun()
  if (!job || job.state!=='DONE' || state.details.has(job.id)) return
  try {await readDetail(job.id);renderResults()} catch {}
}
async function openProblem(id) {
  const selection=++state.selection
  state.loadingProblem=true;updateSubmit()
  try {
    let problem=state.cache.get(id)
    if (!problem) {problem=await api('/api/problems/'+id);state.cache.set(id,problem)}
    if (state.selection!==selection) return
    state.problem=problem;state.doc='rules';state.error=null;state.loadingProblem=false
    rememberRound(state.entrant,id)
    el('problem-title').textContent=problem.title
    el('round-rule').textContent='Qua vòng từ '+problem.minScore+' điểm. Mỗi mutant mới tính 1 điểm, kể cả sau khi qua vòng.'
    renderProblems();renderDocs();renderComposer();renderResults()
    await hydrateRun()
  } catch(error) {
    if (state.selection!==selection) return
    state.loadingProblem=false;showMessage(error.message,true);updateSubmit()
  }
}
function renderDocs() {
  const problem=state.problem
  if (!problem) return
  const panel=el('docs')
  document.querySelectorAll('[data-doc]').forEach(item=>item.setAttribute('aria-pressed',String(item.dataset.doc===state.doc)))
  panel.replaceChildren()
  if (state.doc==='rules') {
    panel.append(node('p',problem.intro,'muted'))
    const rules=node('ul')
    for (const rule of problem.rules) rules.append(node('li',rule))
    panel.append(rules)
    const fixture=node('details')
    fixture.append(node('summary','Kịch bản và tài khoản fixture'),node('p','Mốc đồng hồ '+problem.fixture.start,'muted small'))
    const accounts=node('ul')
    for (const [name,user] of Object.entries(problem.fixture.accounts)) accounts.append(node('li',name+' / mật khẩu fixture '+user.password))
    fixture.append(accounts)
    const presets=node('ul')
    for (const preset of Object.values(problem.scenarios)) {
      presets.append(node('li',preset.label+' / Bob hết khóa phút '+preset.bobLockMinute+
        ' / LABFIXED hết hạn phút '+preset.expiryMinute+' / Giới hạn '+preset.maxUses+' lượt'))
    }
    fixture.append(presets)
    panel.append(fixture)
  } else if (state.doc==='source' || state.doc==='starter') {
    const files=state.doc==='source'?problem.source:problem.starter
    files.forEach((file,index)=>{
      const item=node('details')
      item.open=index===0
      const code=node('pre',file.text)
      code.tabIndex=0
      item.append(node('summary',file.name),code);panel.append(item)
    })
  } else {
    panel.append(node('p','Các hàm dùng chung cho builder và editor. Kết quả lời gọi có status và body.','muted'))
    for (const [key,op] of Object.entries(problem.operations)) {
      const item=node('details')
      const detail=op.args.map(arg=>arg.label+' ('+(typeLabels[arg.type]||arg.type)+(arg.values?' / '+arg.values.join(', '):'')+')')
      item.append(node('summary',key+' / '+op.label),node('p',detail.join(', ')||'Không có tham số','small'),
        node('p','Kết quả có thể kiểm tra: '+Object.keys(op.output).join(', '),'small muted'))
      panel.append(item)
    }
  }
}
function showMessage(message,isError=false) {
  el('result').replaceChildren(node('p',message,isError?'error':'muted'))
}
function showSubmitError(mode,problemId,previewTest,message) {
  if (state.problem?.id!==problemId) return
  if (mode==='SCORE') {showMessage(message,true);return}
  const data=draft()
  const output=previewTest
    ? !el('builder').hidden && data.builder[data.active]?.id===previewTest.id && el('case-output')
    : !el('code-panel').hidden && el('code-output')
  if (!output) return
  const error=node('p',message,'error')
  error.setAttribute('role','alert')
  output.replaceChildren(node('h4','Kết quả chạy thử'),error)
}
function clearError(id) {
  if (state.error?.id!==id || state.error.testIndex!==draft()?.active) return
  state.error=null
  el(id)?.removeAttribute('aria-invalid')
  el(id)?.removeAttribute('aria-describedby')
  el(id)?.parentElement?.removeAttribute('aria-invalid')
  el(id+'-error')?.remove()
}
function onStructure(id) {
  state.error=null
  save();renderComposer()
  if (id) el(id)?.focus()
}
const builder=createBuilder({getDraft:draft,getProblem:()=>state.problem,onChange:save,onStructure,
  onPreview:test=>submit('PREVIEW',test),onOutput:renderOutputs,getError:()=>state.error,clearError})

function renderComposer() {
  const data=draft()
  if (!data) return
  for (const mode of ['builder','code']) {
    const active=data.mode===mode
    el(mode+'-tab').setAttribute('aria-selected',String(active))
    el(mode+'-tab').tabIndex=active?0:-1
  }
  el('builder').hidden=data.mode!=='builder'
  el('code-panel').hidden=data.mode!=='code'
  if (data.mode==='builder') builder.render()
  else if (el('code').value!==data.code) el('code').value=data.code
  updateSubmit();renderOutputs()
}
function updateSubmit() {
  const data=draft(),control=el('submit'),include=el('include')
  if (!data) {control.disabled=true;return}
  const hasBuilder=Boolean(data.builder.length),hasCode=Boolean(data.code.trim())
  control.disabled=busy()||!(hasBuilder&&data.includeBuilder||hasCode&&data.includeCode)
  control.textContent=state.sending?'Đang gửi...':state.active?.mode==='SCORE'?jobLabel(state.active):'Nộp bộ test'
  if (el('preview-test')) el('preview-test').disabled=busy()
  el('preview-code').disabled=busy()||!hasCode
  el('builder-tab').textContent=hasBuilder?'Dựng test ('+data.builder.length+')':'Dựng test'
  el('code-tab').textContent=hasCode?'Viết code (bản nháp)':'Viết code'
  const key=String(hasBuilder)+String(hasCode)
  if (include.dataset.parts===key) {
    if (hasBuilder) el('include-builder').checked=data.includeBuilder
    if (hasCode) el('include-code').checked=data.includeCode
    return
  }
  include.dataset.parts=key;include.replaceChildren()
  for (const [id,visible,label,property] of [['builder',hasBuilder,'Test dựng bằng form','includeBuilder'],['code',hasCode,'Code tự viết','includeCode']]) {
    if (!visible) continue
    const field=node('label'),check=node('input')
    check.id='include-'+id;check.type='checkbox';check.checked=data[property]
    check.addEventListener('change',()=>{draft()[property]=check.checked;save();updateSubmit()})
    field.append(check,document.createTextNode(' '+label));include.append(field)
  }
  if (!hasBuilder&&!hasCode) include.append(node('span','Chưa có test','muted small'))
}
function payload(mode,previewTest) {
  const data=draft(),problem=state.problem
  const tests=mode==='PREVIEW'?(previewTest?[previewTest]:[]):data.includeBuilder?data.builder:[]
  const code=mode==='PREVIEW'?(previewTest?'':data.code):data.includeCode?data.code:''
  builder.validate(tests,mode==='PREVIEW')
  return {problem:problem.id,version:problem.version,builder:tests,code,mode}
}
function renderOutputs() {
  const data=draft()
  if (!data) return
  const test=data.builder[data.active]
  const job=chosenRun()
  const outputs=job?.result?.original?.results??[]
  const label=job?.mode==='PREVIEW'?'Chạy thử':'Lượt nộp'
  const active=state.active?.problem===state.problem?.id?state.active:null
  const previewId=state.previewIds.get(active?.id)
  const preview=el('case-output')
  if (preview && !el('builder').hidden && test) {
    const viewed=state.viewed.has(state.problem.id)
    const fallback=viewed?null:[...state.details.values()]
      .filter(run=>run.problem===state.problem.id && run.result?.original?.results?.some(row=>row.id===test.id))
      .sort((a,b)=>b.created-a.created)[0]
    const owner=outputs.some(row=>row.id===test.id)?job:fallback
    const row=owner?.result?.original?.results?.find(item=>item.id===test.id)
    const snapshot=owner?.snapshot?.find(item=>item.id===test.id)
    const changed=snapshot && (snapshot.name!==test.name || snapshot.scenario!==test.scenario ||
      JSON.stringify(snapshot.steps)!==JSON.stringify(test.steps))
    const sourceLabel=owner?.mode==='PREVIEW'?'Chạy thử':'Lượt nộp'
    renderTestOutput(preview,row,{label:sourceLabel+(changed?' / Bản đã chạy trước khi sửa':''),
      loading:previewId===test.id?jobLabel(active):null})
  }
  if (!el('code-panel').hidden) {
    const rows=outputs.filter(row=>/^case-\d+$/.test(row.id??''))
    const panel=el('code-output')
    panel.replaceChildren(node('h3','Output của code'))
    const runningCode=active?.mode==='PREVIEW' && previewId===null
    if (runningCode) panel.append(node('p',jobLabel(active),'muted'))
    else if (!rows.length) panel.append(node('p','Output từng test tự viết xuất hiện sau khi chạy trên bản gốc.','muted'))
    for (const row of rows) {
      const item=node('section',undefined,'case-output')
      renderTestOutput(item,row,{label:row.name+' / '+label})
      panel.append(item)
    }
  }
}
function runSnapshot(job) {
  const item=node('details')
  item.append(node('summary','Xem các test trong lượt này'))
  for (const test of job.snapshot) {
    const box=node('section',undefined,'case-output')
    const row=job.result?.original?.results?.find(result=>result.id===test.id)
    box.append(node('h4',test.name),node('pre',JSON.stringify(test.steps,null,2)))
    const outcome=node('div')
    renderTestOutput(outcome,row,{label:'Bản gốc'})
    box.append(outcome)
    item.append(box)
  }
  return item
}
function renderResults() {
  const active=state.active
  el('active-job').hidden=!active
  if (active) {
    const problem=state.problems.find(row=>row.id===active.problem)?.title??active.problem
    el('active-job').textContent=problem+' / '+jobLabel(active)
  }
  const job=chosenRun('SCORE')
  renderRunSummary(el('result'),job)
  if (job?.id===state.viewed.get(state.problem?.id) && job?.snapshot) {
    el('result').append(runSnapshot(job))
  }
  renderOutputs()
}
function renderHistory() {
  const list=node('div',undefined,'history-list')
  for (const job of state.history) {
    const title=state.problems.find(p=>p.id===job.problem)?.title||job.problem
    const item=node('div',undefined,'row split history-item')
    let previewSnapshot
    item.append(node('span',title+' / '+jobLabel(job)),node('time',new Date(job.created).toLocaleTimeString('vi-VN'),'muted small'))
    if (job.state==='DONE') item.append(button('Xem lượt này',async()=>{
      try {
        const detail=await readDetail(job.id)
        state.viewed.set(job.problem,detail.id)
        if (state.problem?.id!==job.problem) await openProblem(job.problem)
        renderResults()
        if (detail.mode==='SCORE') el('result').focus()
        else {
          previewSnapshot??=runSnapshot(detail)
          previewSnapshot.open=true
          item.after(previewSnapshot)
          previewSnapshot.firstElementChild.focus()
        }
      } catch(error) {showMessage(error.message,true)}
    }))
    list.append(item)
  }
  el('history').replaceChildren(state.history.length?list:node('p','Chưa có lượt nộp.','muted'))
}
async function submit(mode='SCORE',previewTest=null) {
  if (busy()) return
  const problemId=state.problem.id
  let content
  try {content=payload(mode,previewTest);state.error=null}
  catch(error) {
    if (error.field) {
      state.error=error.field
      draft().active=error.field.testIndex;draft().mode='builder'
      renderComposer();el(error.field.id)?.focus()
    }
    showSubmitError(mode,problemId,previewTest,error.message)
    return
  }
  const data=draft(),entrant=state.entrant
  const serialized=JSON.stringify(content)
  if (data.request?.payload!==serialized) data.request={payload:serialized,key:crypto.randomUUID()}
  save();state.sending=true;updateSubmit()
  try {
    const {job}=await api('/api/jobs',{body:content,key:data.request.key})
    if (entrant!==state.entrant) return
    data.request=null
    saveDraft(entrant,content.problem,data)
    state.viewed.delete(content.problem)
    if (job.state==='DONE') await refreshJobs()
    else {
      state.active={...job,problem:content.problem,mode}
      if (mode==='PREVIEW') state.previewIds.set(job.id,previewTest?.id??null)
    }
    renderResults();schedule(100)
  } catch(error) {
    if (error.status===401) showEntry()
    if ([409,429].includes(error.status)) schedule(800)
    showSubmitError(mode,problemId,previewTest,error.message)
  } finally {state.sending=false;updateSubmit()}
}
async function refreshJobs() {
  const entrant=state.entrant,prior=state.active
  const {jobs,latestScores}=await api('/api/jobs')
  if (entrant!==state.entrant) return
  state.history=jobs
  state.latestScores=latestScores
  state.active=jobs.find(job=>job.state!=='DONE')||null
  const finished=prior && jobs.find(job=>job.id===prior.id&&job.state==='DONE')
  if (finished) {
    state.previewIds.delete(finished.id)
    await readDetail(finished.id)
    if (finished.mode==='SCORE') await refreshBoard()
  }
  renderHistory();renderResults();updateSubmit()
  await hydrateRun()
}
async function refreshBoard() {
  const entrant=state.entrant
  const {rows}=await api('/api/leaderboard')
  if (entrant!==state.entrant) return
  state.roster=rows
  renderProblems()
  if (state.view==='board') renderBoard()
}
function renderBoard() {
  const holder=node('div',undefined,'table-wrap'),table=node('table'),head=node('thead'),row=node('tr')
  for (const title of ['Hạng','Tên','Loại',...state.problems.map(p=>p.title),'Tổng điểm']) {
    const header=node('th',title);header.scope='col';row.append(header)
  }
  head.append(row)
  const body=node('tbody')
  for (const entry of state.roster) {
    const line=node('tr',undefined,entry.id===state.entrant?.id?'mine':'')
    for (const value of [entry.rank,entry.name,entry.kind==='team'?'Nhóm':'Cá nhân']) line.append(node('td',value))
    for (const problem of state.problems) {
      const score=entry.byProblem[problem.id]??0
      const passing=score>=problem.minScore
      const cell=node('td')
      cell.append(node('strong',String(score)),node('span',(passing?'Qua vòng':'Chưa qua')+' / ngưỡng '+problem.minScore,passing?'board-note good':'board-note muted'))
      line.append(cell)
    }
    line.append(node('td',entry.score,'board-total'));body.append(line)
  }
  table.append(head,body);holder.append(table);el('rankings').replaceChildren(holder)
}
function schedule(delay=1300) {
  clearTimeout(state.poll);state.poll=setTimeout(tick,delay)
}
async function tick() {
  try {
    const room=await api('/api/room')
    if (state.entrant && state.entrant.room!==room.id) showEntry()
    refreshRoom(room)
    if (state.entrant && !document.hidden) {
      if (state.active||state.sending) await refreshJobs()
      if (state.view==='board') await refreshBoard()
    }
    schedule(document.hidden?9000:state.active?1300:4500)
  } catch(error) {
    if (error.status===401) showEntry()
    schedule(8000)
  }
}
async function enter(entrant) {
  state.entrant=entrant
  el('who').textContent=(entrant.kind==='team'?'Nhóm / ':'Cá nhân / ')+entrant.name
  el('entry').hidden=true;el('desk').hidden=false;el('logout').hidden=false
  state.problems=(await api('/api/problems')).problems
  showView('work')
  const saved=selectedRound(entrant)
  await openProblem(state.problems.some(round=>round.id===saved)?saved:entrant.assigned)
  await refreshJobs();await refreshBoard();schedule()
}
function showView(name) {
  state.view=name
  el('work').hidden=name!=='work';el('board').hidden=name!=='board'
  el('show-work').classList.toggle('selected',name==='work');el('show-board').classList.toggle('selected',name==='board')
  if (name==='board') {
    renderBoard()
    refreshBoard().catch(error=>el('rankings').textContent=error.message)
  }
}
el('join').addEventListener('submit',async event=>{
  event.preventDefault()
  const form=new FormData(event.currentTarget)
  el('entry-error').textContent='';el('join-button').disabled=true
  try {
    const {entrant}=await api('/api/join',{body:{name:form.get('name'),kind:form.get('kind'),invite:form.get('invite')}})
    el('invite').value=''
    await enter(entrant)
  } catch(error) {showEntry();el('entry-error').textContent=error.message}
  finally {el('join-button').disabled=state.room?.state!=='OPEN'}
})
el('logout').addEventListener('click',async()=>{
  try {await api('/api/logout',{body:{}});showEntry();await tick()} catch(error){showMessage(error.message,true)}
})
el('show-work').addEventListener('click',()=>showView('work'))
el('show-board').addEventListener('click',()=>showView('board'))
el('submit').addEventListener('click',()=>submit())
el('preview-code').addEventListener('click',()=>submit('PREVIEW'))
el('code').addEventListener('input',()=>{
  const data=draft()
  if (!data) return
  data.code=el('code').value;save();updateSubmit()
})
document.querySelectorAll('[data-doc]').forEach(control=>control.addEventListener('click',()=>{state.doc=control.dataset.doc;renderDocs()}))
for (const mode of ['builder','code']) {
  const control=el(mode+'-tab')
  const change=next=>{if(draft()){draft().mode=next;save();renderComposer()}}
  control.addEventListener('click',()=>change(mode))
  control.addEventListener('keydown',event=>{
    const next=event.key==='Home'?'builder':event.key==='End'?'code':
      ['ArrowLeft','ArrowRight'].includes(event.key)?(mode==='builder'?'code':'builder'):null
    if (next) {event.preventDefault();change(next);el(next+'-tab').focus()}
  })
}
try {
  refreshRoom(await api('/api/room'))
  try {const {entrant}=await api('/api/me');await enter(entrant)}
  catch(error) {if (error.status!==401) throw error}
} catch(error) {showEntry();el('entry-error').textContent=error.message}
schedule()
