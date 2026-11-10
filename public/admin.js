import { button, element } from './builder.js'
import { failedCases, labels, shortTime } from './results.js'

const byId=id=>document.getElementById(id)
const roomLabels={WAITING:'Chưa mở phòng',OPEN:'Đang nhận bài',PAUSED:'Tạm dừng',CLOSED:'Đã đóng',FINALIZED:'Đã chốt điểm'}
const states={pause:['OPEN'],resume:['PAUSED'],close:['OPEN','PAUSED'],finalize:['CLOSED']}
let key='', manual=false, data, focusTeam, focusSubmission, page=1
let teamKey='', reviewKey='', detailKey='', submissionKey=''
const errorText=error=>{byId(byId('access').hidden?'error':'login-error').textContent=error.message}
async function request(path, body, raw=false) {
  const headers={}
  if (key) headers.Authorization='Bearer '+key
  if (body!==undefined) headers['Content-Type']='application/json'
  const response=await fetch('/api/host'+path,{headers,...(body===undefined?{}:{method:'POST',body:JSON.stringify(body)})})
  if (!response.ok) {
    const error=new Error((await response.json()).error ?? 'Không xử lý được.')
    error.status=response.status
    throw error
  }
  return raw?response.blob():response.json()
}
function handle(action) {
  return async (...args)=>{
    byId('error').textContent='';byId('login-error').textContent=''
    try {await action(...args)} catch (error) {errorText(error)}
  }
}
function form(id,action) {
  byId(id).addEventListener('submit',event=>{
    event.preventDefault()
    handle(action)(Object.fromEntries(new FormData(event.currentTarget)))
  })
}
function cell(text) {return element('td',text)}
function badge(text,tone='') {return element('span',text,{class:'chip '+tone})}
function submissionStage({status,progress}) {
  if (status==='VERIFYING_ORIGINAL') return 'Đang kiểm bản gốc'
  if (status==='EVALUATING') return (progress.total-progress.pending)+'/'+progress.total+' mutant'
  return labels[status] ?? status
}
function stateBadge(team) {
  if (team.flagged) return badge(team.flagged+' cần xử lý','caution')
  if (team.active) return badge(team.active+' đang chấm','pending')
  return badge(team.submissions?'Đã chấm':'Chưa nộp')
}
function emptyRow(cols,text) {
  const row=element('tr');row.append(element('td',text,{colspan:cols,class:'muted'}));return row
}
function teams() {
  const term=byId('team-search').value.trim().toLocaleLowerCase('vi')
  const list=data.teams.filter(team=>team.name.toLocaleLowerCase('vi').includes(term))
  const next=JSON.stringify([list,focusTeam])
  if (next===teamKey) return
  teamKey=next
  byId('team-rows').replaceChildren(...list.map(team=>{
    const row=element('tr',null,{'data-selected':String(focusTeam===team.id)})
    const name=cell()
    name.append(button(team.name,handle(()=>selectTeam(team.id)),{class:'table-link','aria-label':'Xem chi tiết '+team.name}))
    const status=cell();status.append(stateBadge(team))
    row.append(name,cell(team.points),cell(team.submissions),status,cell(team.lastSubmission?shortTime(team.lastSubmission):'—'))
    return row
  }))
  if (!list.length) byId('team-rows').append(emptyRow('5',term?'Không có tên phù hợp.':'Chưa có người tham gia.'))
}
async function selectTeam(id) {
  if (focusTeam!==id) {
    focusTeam=id;focusSubmission=undefined;page=1;detailKey=''
    byId('submission-detail').hidden=true
    byId('recovery-link').replaceChildren()
    byId('recovery-link').hidden=true
  }
  teams()
  await detail()
  byId('team-detail').scrollIntoView({block:'nearest'})
}
async function detail() {
  if (!focusTeam) return
  const id=focusTeam
  const currentPage=page
  const view=await request('/teams/'+id+'?page='+currentPage)
  if (id!==focusTeam || currentPage!==page) return
  const team=data.teams.find(team=>team.id===id)
  if (!focusSubmission && currentPage===1) focusSubmission=view.submissions[0]?.id
  byId('team-detail').hidden=false
  byId('detail-title').textContent=view.team.name
  const next=JSON.stringify([view,team?.points,focusSubmission])
  if (detailKey!==next) {
    detailKey=next
    const target=byId('team-history')
    target.replaceChildren(element('p',(team?.points ?? 0)+' điểm / '+view.total+' lượt nộp',{class:'muted'}))
    if (!view.submissions.length) target.append(element('p','Chưa có bài nộp.',{class:'empty'}))
    for (const row of view.submissions) {
      const item=button('',handle(async ()=>{
        focusSubmission=row.id;await detail()
      }),{class:'submission-row','aria-pressed':String(focusSubmission===row.id)})
      item.append(element('strong',shortTime(row.acceptedAt)),element('span',row.cases+' test'),badge(submissionStage(row)),
        element('span',row.newPoints?'+'+row.newPoints+' điểm':'0 điểm'))
      target.append(item)
    }
    if (view.total>20 || page>1) {
      const pager=element('div',null,{class:'room-actions pager'})
      const previous=button('Trang trước',handle(async()=>{page--;await detail()}),{class:'secondary'})
      const nextPage=button('Trang sau',handle(async()=>{page++;await detail()}),{class:'secondary'})
      previous.disabled=page===1;nextPage.disabled=page*20>=view.total
      pager.append(previous,element('span','Trang '+page),nextPage);target.append(pager)
    }
  }
  if (focusSubmission) await submission()
}
function judgingProgress(job) {
  const section=element('section',null,{class:'judge-progress','aria-label':'Tiến độ chấm'})
  const {total,pending,killed,survived,inconclusive}=job.progress
  if (total) {
    const finished=total-pending
    section.append(element('p','Đã xử lý '+finished+'/'+total+' mutant',{class:'judge-count'}),
      element('progress',null,{max:total,value:finished,'aria-label':'Số mutant đã xử lý'}),
      element('p',killed+' phát hiện, '+survived+' còn sống, '+inconclusive+' cần xử lý',{class:'muted'}))
  }
  section.append(element('h4','Lượt chạy gần đây'))
  if (!job.attempts.length) {
    section.append(element('p','Chưa có lượt chạy.',{class:'muted'}))
    return section
  }
  const log=element('ol',null,{class:'judge-attempts'})
  for (const attempt of job.attempts) {
    const row=element('li')
    const subject=attempt.variant || 'Bản gốc'
    const mutantOutcome=attempt.variant && {ALL_PASS:'Còn sống',ASSERTION_MISMATCH:'Đã phát hiện'}[attempt.outcome]
    const verdict=attempt.finishedAt
      ? (attempt.expired ? 'Hết hạn lượt chạy' : (mutantOutcome || labels[attempt.outcome] || 'Đã chạy'))
      : 'Đang chạy'
    row.append(element('time',shortTime(attempt.startedAt),{datetime:attempt.startedAt}),
      element('strong',subject),badge(verdict,attempt.finishedAt?'':'pending'),
      element('span',attempt.durationMs>0 ? attempt.durationMs+' ms' : '',{class:'muted'}))
    log.append(row)
  }
  section.append(log)
  return section
}
async function submission() {
  const id=focusSubmission
  const job=await request('/submission/'+id)
  if (id!==focusSubmission || JSON.stringify(job)===submissionKey && !byId('submission-detail').hidden) return
  submissionKey=JSON.stringify(job)
  const target=byId('submission-detail')
  const openPanels=new Set(target.dataset.submissionId===id
    ? Array.from(target.querySelectorAll('details[open]'),panel=>panel.dataset.panel) : [])
  target.dataset.submissionId=id
  target.hidden=false
  target.replaceChildren(element('h3','Bài nộp lúc '+shortTime(job.acceptedAt)),badge(submissionStage(job)),judgingProgress(job))
  const failures=failedCases(job.original)
  if (failures.childElementCount) target.append(failures)
  const snapshot=element('details',null,{class:'reference','data-panel':'suite'})
  snapshot.open=openPanels.has('suite')
  snapshot.append(element('summary','Nội dung bộ test'))
  for (const test of job.suite) {
    const part=element('section',null,{class:'snapshot-case'})
    part.append(element('h4',test.name),element('p','Dữ liệu '+test.scenario,{class:'muted'}))
    const steps=element('ol')
    for (const step of test.steps) steps.append(element('li',step.kind==='call'?
      step.op+'('+step.args.map(arg=>typeof arg==='object' && arg?.ref?arg.ref:JSON.stringify(arg)).join(', ')+') → '+step.as:
      step.actual+' '+step.matcher+' '+JSON.stringify(step.expected)))
    part.append(steps);snapshot.append(part)
  }
  target.append(snapshot)
  if (job.variants?.length) {
    const variants=element('details',null,{class:'reference','data-panel':'variants'})
    variants.open=openPanels.has('variants')
    variants.append(element('summary','Chi tiết mutant ('+job.variants.length+')'))
    for (const variant of job.variants) {
      const label={KILLED:'Đã phát hiện',SURVIVED:'Còn sống',INCONCLUSIVE:'Cần xử lý',EXCLUDED:'Đã loại',QUEUED:'Đang đợi',LEASED:'Đang chấm'}[variant.status] ?? variant.status
      const line=element('p',variant.variant+' / '+label+' / '+variant.attempt+' lần chạy')
      if (variant.evidence?.failure) {
        const f=variant.evidence.failure
        line.append(element('small','Bước '+(f.stepIndex+1)+': '+f.actual+' / mong đợi '+f.expected))
      }
      variants.append(line)
    }
    target.append(variants)
  }
}
function review() {
  const next=JSON.stringify(data.review)
  byId('review-count').textContent=data.inconclusive ?? 0
  if (next===reviewKey) return
  reviewKey=next
  const target=byId('review')
  target.replaceChildren()
  if (!data.review.length) target.append(element('p','Không có lượt cần xử lý.',{class:'empty'}))
  for (const task of data.review) {
    const row=element('form',null,{class:'review-row'})
    const info=element('div')
    info.append(element('strong',task.name),element('small',(task.variant || 'Bộ test')+' / '+(labels[task.evidence?.outcome] ?? 'Lỗi thực thi')))
    const input=element('input',null,{required:'',maxlength:'180',placeholder:'Lý do chấm lại','aria-label':'Lý do chấm lại'})
    const team=data.teams.find(item=>item.name===task.name)
    const view=button('Xem bài',handle(async()=>{
      if (!team) return
      await selectTeam(team.id);focusSubmission=task.submissionId;await detail()
    }),{class:'secondary'})
    row.append(info,input,view,element('button','Chấm lại',{class:'secondary'}))
    row.addEventListener('submit',event=>{event.preventDefault();handle(async()=>{
      await request('/retry',{taskId:task.id,reason:input.value});await update()
    })()})
    target.append(row)
  }
}
async function update() {
  const next=await request('')
  const differentRoom=data?.id!==next.id
  data=next
  if (differentRoom && focusTeam) closeDetail()
  byId('access').hidden=true
  byId('control').hidden=false
  byId('connection').textContent='Đã kết nối'
  byId('error').textContent=''
  byId('host-title').textContent=data.title ?? 'Tổng quan'
  byId('state').textContent=roomLabels[data.state]
  byId('state').dataset.state=data.state
  byId('new-room').hidden=!['WAITING','FINALIZED'].includes(data.state)
  byId('exclude-panel').hidden=data.state!=='CLOSED'
  byId('export').hidden=!data.id
  byId('reset').hidden=!data.id
  byId('archive-report').hidden=!data.archive
  byId('projector').href=data.publicOrigin+'/projector'
  for (const control of document.querySelectorAll('[data-action]')) {
    control.hidden=!states[control.dataset.action].includes(data.state)
    control.disabled=control.dataset.action==='finalize' && Boolean(data.pending || data.inconclusive)
  }
  const figures=[
    ['Người tham gia',data.teams.length],
    ['Lượt nộp',data.teams.reduce((sum,team)=>sum+team.submissions,0)],
    ['Đang chấm',data.teams.reduce((sum,team)=>sum+team.active,0)],
    ['Cần xử lý',data.teams.reduce((sum,team)=>sum+team.flagged,0)]
  ]
  byId('overview').replaceChildren(...figures.map(([title,value])=>{
    const tile=element('div');tile.append(element('span',title),element('strong',value));return tile
  }))
  teams();review()
  if (focusTeam) await detail()
}
function closeDetail() {
  focusTeam=undefined;focusSubmission=undefined;detailKey='';submissionKey=''
  byId('team-detail').hidden=true
  byId('recovery-link').replaceChildren()
  teams()
}
form('connect',async({key:entered})=>{
  key=entered
  try {
    await update()
    sessionStorage.setItem('t10-host-key',key)
    byId('connect').reset()
  } catch (error) {
    key=''
    sessionStorage.removeItem('t10-host-key')
    throw error
  }
})
for (const id of ['open','exclude']) form(id,async body=>{
  await request('/'+id,body);await update()
  if (id==='open') byId('host-notice').textContent=''
})
byId('team-search').addEventListener('input',()=>teams())
byId('hide-detail').addEventListener('click',closeDetail)
byId('recovery').addEventListener('click',handle(async()=>{
  const id=focusTeam
  if (!id) return
  const {url,expiresAt}=await request('/teams/'+id+'/recovery',{})
  if (id!==focusTeam) return
  const target=byId('recovery-link')
  const input=element('input',null,{readonly:'','aria-label':'Liên kết vào lại'});input.value=url
  const copy=button('Sao chép',handle(async()=>{
    input.select()
    if (navigator.clipboard) {await navigator.clipboard.writeText(url);copy.textContent='Đã sao chép'}
  }),{class:'secondary'})
  target.replaceChildren(element('p','Gửi riêng liên kết này. Dùng một lần, hết hạn lúc '+shortTime(expiresAt)+'.'),input,copy)
  target.hidden=false
}))
for (const control of document.querySelectorAll('[data-action]')) control.addEventListener('click',handle(async()=>{
  await request('/'+control.dataset.action,{});await update()
}))
async function download(path,filename) {
  const url=URL.createObjectURL(await request(path,undefined,true))
  const link=element('a',null,{href:url,download:filename});link.click()
  setTimeout(()=>URL.revokeObjectURL(url),1000)
}
byId('export').addEventListener('click',handle(()=>download('/report','t10-room-report.json')))
byId('archive-report').addEventListener('click',handle(()=>{
  if (data?.archive) return download('/archives/'+data.archive.id+'/report','t10-archived-room-report.json')
}))
byId('reset').addEventListener('click',handle(async()=>{
  const roomId=data?.id
  if (!roomId || !window.confirm('Dọn phiên này để mở mới? Phiên hiện tại sẽ ngừng chấm. Người chơi phải vào lại và báo cáo phiên cũ được lưu.')) return
  await request('/reset',{roomId})
  await update()
  byId('host-notice').textContent='Đã lưu phiên cũ. Mở phòng mới để bắt đầu lại.'
  byId('new-room').querySelector('input').focus()
}))
async function tick() {
  if (!manual || key) {
    try {
      await update()
      if (!manual) sessionStorage.removeItem('t10-host-key')
    } catch (error) {
      if (error.status===401) {
        if (!manual) key=sessionStorage.getItem('t10-host-key') || ''
        else { key='';sessionStorage.removeItem('t10-host-key') }
        manual=true
        byId('access').hidden=false
        byId('control').hidden=true
        byId('login-status').hidden=true
        byId('connect').hidden=false
      } else {
        byId('connection').textContent='Đang kết nối lại'
        errorText(error)
      }
    }
  }
  setTimeout(tick,2300)
}
tick()
