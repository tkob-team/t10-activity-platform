import {node} from './ui.js'

const outcomeLabels={PASS:'Pass',ASSERTION:'Fail assertion',TIMEOUT:'Quá thời gian',RUN_ERROR:'Lỗi chạy'}
export function jobLabel(job) {
  if (!job) return ''
  if (job.state==='QUEUED') return job.mode==='PREVIEW'?'Đang đợi chạy thử':'Đang đợi chấm bài'
  if (job.state==='RUNNING') return job.mode==='PREVIEW'?'Đang chạy thử trên bản gốc...':'Bot đang chấm bài...'
  const result=job.result
  if (result?.status==='PREVIEW') return 'Chạy thử / '+(outcomeLabels[result.original?.status]??'Đã hoàn tất')
  if (result?.status==='GRADED') return (result.passed?'Qua vòng':'Chưa qua vòng')+' / +'+result.newPoints+' điểm'
  return {ORIGINAL_FAILED:'Bản gốc fail',RUN_ERROR:'Lỗi thực thi',TIMEOUT:'Vượt thời gian',SYSTEM_ERROR:'Máy chấm gặp lỗi'}[result?.status] || 'Đã hoàn tất'
}
function detailFailure(failure) {
  return failure.path+' / Mong đợi '+failure.expected+' / Thực tế '+failure.actual
}
export function renderTestOutput(box,row,{label,loading}={}) {
  if (!box) return
  box.replaceChildren(node('h4','Kết quả chạy'))
  if (loading) {box.append(node('p',loading,'muted'));return}
  if (!row) {box.append(node('p','Output trên bản gốc sẽ hiện tại đây sau khi chạy.','muted'));return}
  box.append(node('p',(label?label+' / ':'')+(outcomeLabels[row.status]??row.status),row.status==='PASS'?'good':'error'))
  if (row.failure) box.append(node('p',detailFailure(row.failure),'error small'))
  const outputs=row.outputs??[]
  for (const [index,value] of outputs.entries()) {
    const output=node('details',undefined,'output-row')
    output.open=index===outputs.length-1
    let body=value.body
    try {body=JSON.stringify(JSON.parse(body),null,2)} catch {}
    output.append(node('summary',value.ref+' / '+value.operation+' / HTTP '+value.http),node('pre',body))
    box.append(output)
  }
  if (!row.outputs?.length) box.append(node('p','Không có output từ lời gọi.','muted small'))
}
export function renderRunSummary(box,job) {
  if (!job) {
    box.replaceChildren(node('h3','Kết quả lượt nộp'),node('p','Chưa có lượt nộp cho vòng này.','muted'))
    return
  }
  if (job.state!=='DONE') {
    const status=node('div',undefined,'loading')
    const spinner=node('span',undefined,'spinner')
    spinner.setAttribute('aria-hidden','true')
    status.append(spinner,node('span',jobLabel(job)))
    box.replaceChildren(status)
    return
  }
  const result=job.result
  box.replaceChildren(node('h3',jobLabel(job),result?.status==='GRADED'||result?.original?.status==='PASS'?'good':'error'))
  if (result?.status==='GRADED') {
    const c=result.counts??{}
    box.append(node('p','Bản gốc pass '+result.original.tests+' test. Lượt này phát hiện '+(c.KILLED??0)+
      ' mutant mới, '+(c.SURVIVED??0)+' còn sống, '+(c.TIMEOUT??0)+' timeout, '+(c.RUN_ERROR??0)+' lỗi chạy.'))
    if (result.threshold) box.append(node('p','Điểm vòng '+result.score+' / ngưỡng '+result.threshold+
      '. '+(result.alreadyCredited?'Bỏ qua '+result.alreadyCredited+' mutant đã được ghi điểm.':''),'muted small'))
  }
  if (result?.original?.failure) box.append(node('p',detailFailure(result.original.failure),'error small'))
}
