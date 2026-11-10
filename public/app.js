import { button, createBuilder, element, buildSuite } from './builder.js'
import { showResult, shortTime, labels, waiting } from './results.js'

const byId=id=>document.getElementById(id)
const roomLabels={WAITING:'Chờ mở phòng',OPEN:'Đang nhận bài',PAUSED:'Tạm dừng',CLOSED:'Đã đóng',FINALIZED:'Đã chốt điểm'}
const sectionNames={orders:'Giỏ hàng và đơn hàng',coupons:'Mã giảm giá',auth:'Đăng nhập'}
let pack,draft,storageKey,selected,inFlight=false,openIssue,editorTask,activeJob
let room={state:'WAITING'}

function load(key,fallback) {
  try { return JSON.parse(localStorage.getItem(key)) ?? fallback } catch { return fallback }
}
function save(key,value) {
  try { localStorage.setItem(key,JSON.stringify(value)); return true } catch { return false }
}
function freshId() {
  const bytes=crypto.getRandomValues(new Uint8Array(16))
  bytes[6]=(bytes[6]&15)|64; bytes[8]=(bytes[8]&63)|128
  return Array.from(bytes,b=>b.toString(16).padStart(2,'0')).join('').replace(/^(........)(....)(....)(....)/,'$1-$2-$3-$4-')
}
async function api(path,body,key) {
  const response=await fetch('/api/'+path,body===undefined?{}:{
    method:'POST',headers:{'Content-Type':'application/json',...(key?{'Idempotency-Key':key}:{})},body:JSON.stringify(body)
  })
  const result=await response.json()
  if (!response.ok) throw Object.assign(new Error(result.error || 'Máy chủ chưa phản hồi.'),{status:response.status})
  return result
}
function persist() {
  byId('save-state').textContent=save(storageKey,draft)?'Đã lưu nháp':'Không lưu được nháp'
}
function syncRoom() {
  const state=roomLabels[room.state]
  byId('room-state').textContent=room.state==='OPEN'?room.title:state
  byId('room-name').textContent=room.title ?? 'Chưa mở phòng'
  byId('room-status').textContent=state
  byId('room-status').dataset.state=room.state
  const form=byId('join')
  form.querySelector('button').disabled=room.state!=='OPEN'
  const submit=byId('submit')
  submit.disabled=inFlight || room.state!=='OPEN' || Boolean(activeJob)
  submit.firstChild.textContent=inFlight || activeJob?'Đang chấm ':'Nộp bài '
}
function codeReader(files) {
  if (!files.length) return element('p','Chưa có tệp để hiển thị.',{class:'empty'})
  const reader=element('div',null,{class:'reference-reader'})
  const bar=element('div',null,{class:'reference-file'})
  const code=element('code')
  const pre=element('pre',null,{class:'reference-code',tabindex:'0'})
  pre.append(code)
  const open=file=>{
    code.textContent=file.text
    pre.setAttribute('aria-label','Mã nguồn '+file.name)
    pre.scrollTop=0
    pre.scrollLeft=0
  }
  if (files.length>1) {
    const label=element('label','Tệp')
    const picker=element('select')
    files.forEach((file,index)=>picker.append(element('option',file.name,{value:String(index)})))
    picker.addEventListener('change',()=>open(files[Number(picker.value)]))
    label.append(picker)
    bar.append(label)
  } else {
    bar.append(element('strong',files[0].name))
  }
  open(files[0])
  reader.append(bar,pre)
  return reader
}
function fixtureReference(fixture) {
  const data=element('div',null,{class:'reference-fixtures'})
  const accounts=element('ul')
  for (const [name,account] of Object.entries(fixture.accounts)) {
    const row=element('li',name+' / ')
    row.append(element('code',account.password))
    accounts.append(row)
  }
  const coupon=fixture.coupon
  data.append(element('p','Mật khẩu dùng cho các tài khoản kiểm thử.'),accounts,
    element('p','Mã '+coupon.code+' giảm '+new Intl.NumberFormat('vi-VN').format(coupon.discount)+' đồng.'))
  return data
}
function showFeature(feature) {
  const body=byId('feature-content')
  const list=element('ol',null,{class:'rules'})
  for (const [index,rule] of feature.rules.entries()) {
    const item=element('li')
    item.append(element('span',String(index+1).padStart(2,'0'),{class:'rule-number','aria-hidden':'true'}),element('p',rule))
    list.append(item)
  }
  body.replaceChildren(list)
  const links=element('div',null,{class:'segments rule-references',role:'group','aria-label':'Tài liệu tham khảo'})
  const panel=element('div',null,{id:'reference-content',hidden:''})
  const references=[
    ['Source gốc',()=>codeReader(pack.source)],
    ['Tests có sẵn',()=>codeReader(feature.starters)],
    ['Tài khoản và mã mẫu',()=>fixtureReference(pack.fixture)]
  ]
  for (const [title,render] of references) {
    const choice=button(title,()=>{
      const show=choice.getAttribute('aria-expanded')!=='true'
      for (const item of links.children) item.setAttribute('aria-expanded',String(item===choice && show))
      panel.hidden=!show
      panel.replaceChildren(...(show?[render()]:[]))
    },{'aria-expanded':'false','aria-controls':panel.id})
    links.append(choice)
  }
  body.append(links,panel)
  for (const child of byId('features').children) child.setAttribute('aria-pressed',String(child.dataset.feature===feature.id))
  draft.feature=feature.id
  persist()
}
function showTab(tab) {
  const code=tab==='code'
  byId('builder-pane').hidden=code
  byId('code-pane').hidden=!code
  byId('builder-tab').setAttribute('aria-pressed',String(!code))
  byId('code-tab').setAttribute('aria-pressed',String(code))
  byId('submit-error').textContent=''
  draft.tab=tab
  persist()
  if (code && !editorTask) {
    editorTask=import('./editor.js').then(({mountEditor})=>mountEditor(byId('editor'),draft.code,value=>{draft.code=value;persist()}))
      .catch(()=>{editorTask=undefined;byId('submit-error').textContent='Không tải được trình soạn code. Hãy thử tải lại trang.'})
  }
}
async function enter(entrant) {
  pack=await api('activity')
  storageKey='t10-lab/'+entrant.room+'/'+entrant.id+'/'+pack.packHash
  draft=load(storageKey,{builder:[],code:'',sequence:0,tab:'builder'})
  byId('identity').textContent=entrant.name
  byId('identity').hidden=false
  byId('entry').hidden=true
  byId('lab').hidden=false
  byId('features').replaceChildren(...pack.features.map(feature=>{
    const choice=button(sectionNames[feature.id] ?? feature.title,()=>showFeature(feature))
    choice.dataset.feature=feature.id
    return choice
  }))
  byId('operations').replaceChildren(...Object.entries(pack.operations).map(([name,meta])=>
    element('li',name+'() / '+meta.label+' ('+meta.args.map(arg=>arg.label).join(', ')+')')))
  openIssue=createBuilder(byId('cases'),draft,pack,persist,byId('case-limit'),byId('add-case'))
  showTab(draft.tab)
  showFeature(pack.features.find(feature=>feature.id===draft.feature) ?? pack.features[0])
  await refresh()
}
function display(jobs) {
  activeJob=jobs.find(job=>waiting.has(job.status))
  syncRoom()
  const job=jobs.find(item=>item.id===selected) ?? jobs[0]
  const detail=byId('job-detail')
  if (job && detail.dataset.key!==JSON.stringify(job)) {
    showResult(detail,job)
    detail.dataset.key=JSON.stringify(job)
  }
  const history=byId('history')
  const previous=jobs.filter(item=>item.id!==job?.id)
  byId('history-panel').hidden=previous.length===0
  const key=JSON.stringify(previous.map(({id,status,newPoints})=>[id,status,newPoints]))
  if (history.dataset.key!==key) {
    history.replaceChildren(...previous.slice(0,12).map(item=>button(
      shortTime(item.acceptedAt)+'  '+(item.newPoints?'+'+item.newPoints+' điểm':labels[item.status]),
      ()=>{selected=item.id;display(jobs)},{class:'history-row'})))
    history.dataset.key=key
  }
}
async function refresh() {
  room=await api('room')
  syncRoom()
  if (pack) {
    const [jobs,score]=await Promise.all([api('submissions'),api('score')])
    display(jobs)
    const label=score.points+' / '+score.maxPoints
    const target=byId('player-score')
    if (target.textContent!==label) target.textContent=label
  }
}
async function send() {
  if (inFlight || activeJob || room.state!=='OPEN') return
  byId('submit-error').textContent=''
  try {
    const code=draft.tab==='code'?draft.code:''
    const builder=draft.tab==='code'?[]:buildSuite(draft.builder,pack)
    if (!builder.length && !code.trim()) throw new Error('Thêm test trong tab đang mở rồi nộp bài.')
    const body={builder,code,mode:'SCORE',packHash:pack.packHash}
    const fingerprint=JSON.stringify(body)
    const previous=load(storageKey+'/request',{})
    const key=previous.fingerprint===fingerprint?previous.key:freshId()
    save(storageKey+'/request',{fingerprint,key})
    inFlight=true;syncRoom()
    const receipt=await api('submissions',body,key)
    selected=receipt.id
    activeJob=receipt
    const detail=byId('job-detail')
    showResult(detail,{status:'QUEUED'})
    detail.dataset.key=''
    save(storageKey+'/request',{})
    await refresh()
  } catch (error) {
    if (error.id) openIssue(error)
    byId('submit-error').textContent=error.message
  } finally {inFlight=false;syncRoom()}
}
byId('join').addEventListener('submit',async event=>{
  event.preventDefault()
  try {
    byId('join-error').textContent=''
    await enter(await api('join',Object.fromEntries(new FormData(event.currentTarget))))
  } catch (error) {byId('join-error').textContent=error.message}
})
byId('builder-tab').addEventListener('click',()=>showTab('builder'))
byId('code-tab').addEventListener('click',()=>showTab('code'))
byId('submit').addEventListener('click',send)
const resume=new URLSearchParams(location.hash.slice(1)).get('resume')
if (resume) history.replaceState(null,'',location.pathname+location.search)
const session=resume?api('recover',{recovery:resume}):api('session')
session.then(enter).catch(error=>{if (error.status!==401) byId('join-error').textContent=error.message})
async function tick() {
  try {await refresh()}
  catch (error) {if (pack && error.status===401) location.reload()}
  finally {setTimeout(tick,pack?1100:3000)}
}
tick()
