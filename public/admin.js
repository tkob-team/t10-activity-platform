const el = id=>document.getElementById(id)
let key=''
async function api(path,body) {
  const response=await fetch('/api/admin/'+path,{
    method:body?'POST':'GET',
    headers:{authorization:'Bearer '+key,...(body?{'content-type':'application/json'}:{})},
    body:body?JSON.stringify(body):undefined
  })
  const data=await response.json()
  if (!response.ok) throw new Error(data.error)
  return data
}
async function refresh() {
  const data=await api('status')
  const summary=el('summary')
  summary.replaceChildren()
  for (const [label,value] of [['Phòng',data.room.label],['Trạng thái',data.room.state],['Gói đề',data.packVersion],
    ['Ngưỡng qua vòng',data.rounds.map(round=>round.title+' '+round.minScore+'/'+round.total).join(' / ')],
    ['Người chơi',data.entrants],['Đang đợi hoặc chấm',data.pending],['Đã hoàn tất',data.jobs.DONE||0]]) {
    const term=document.createElement('dt'),description=document.createElement('dd')
    term.textContent=label; description.textContent=value; summary.append(term,description)
  }
  const failures=el('recent-failures')
  failures.replaceChildren()
  for (const job of data.failures) {
    const item=document.createElement('li')
    item.textContent=job.name+' / '+job.problem+' / '+job.mode+' / '+job.status
    failures.append(item)
  }
  el('failures-panel').hidden=!data.failures.length
  el('controls').hidden=false
  el('open').disabled=data.room.state!=='SETUP'
  el('close').disabled=data.room.state==='CLOSED'
}
async function action(callback) {
  try { await callback(); el('message').textContent='Đã cập nhật.' }
  catch(error) { el('message').textContent=error.message }
}
el('operator').addEventListener('submit',event=>{
  event.preventDefault()
  key=el('key').value
  el('key').value=''
  void action(refresh)
})
for (const id of ['open','close']) el(id).addEventListener('click',()=>action(async()=>{await api('room',{action:id});await refresh()}))
el('new-room').addEventListener('submit',event=>{
  event.preventDefault()
  void action(async()=>{await api('room',{action:'new',label:el('label').value});el('label').value='';await refresh()})
})
el('export').addEventListener('click',()=>action(async()=>{
  const data=await api('export')
  const href=URL.createObjectURL(new Blob([JSON.stringify(data,null,2)],{type:'application/json'}))
  const link=document.createElement('a')
  link.href=href
  link.download='t10-room-'+data.room.id+'.json'
  link.click()
  setTimeout(()=>URL.revokeObjectURL(href),2000)
}))
setInterval(()=>{if (key && !document.hidden) refresh().catch(error=>{el('message').textContent=error.message})},3500)
