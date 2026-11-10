import { element } from './builder.js'

export const waiting = new Set(['QUEUED','VERIFYING_ORIGINAL','EVALUATING'])
export const labels = {
  QUEUED:'Đang đợi chấm',VERIFYING_ORIGINAL:'Đang chấm',EVALUATING:'Đang chấm',
  ORIGINAL_FAILED:'Có test chưa đạt',GRADED:'Đã chấm',REVIEW_REQUIRED:'Cần kiểm tra',
  ALL_PASS:'Đạt',ASSERTION_MISMATCH:'Chưa đạt',TIMEOUT:'Hết thời gian chạy',
  INFRA_FAILURE:'Lỗi máy chấm',SUT_RUNTIME_ERROR:'Lỗi khi chạy test'
}
export const shortTime=value=>new Intl.DateTimeFormat('vi-VN',{hour:'2-digit',minute:'2-digit',second:'2-digit'}).format(new Date(value))
const comparators={toBe:'Bằng',toEqual:'Bằng',toBeGreaterThan:'Lớn hơn',toBeLessThan:'Nhỏ hơn',toContain:'Có chứa'}

function banner(tone, title, copy) {
  const item=element('div',null,{class:'result-banner '+tone})
  item.append(element('strong',title))
  if (copy) item.append(element('p',copy))
  return item
}
export function failedCases(original) {
  const list=element('div',null,{class:'failed-list'})
  for (const row of original?.results ?? []) {
    if (row.outcome==='ALL_PASS') continue
    const card=element('article',null,{class:'failed-case'})
    card.append(element('strong',row.name))
    const failures=row.steps.filter(step=>step.pass===false)
    if (!failures.length) card.append(element('p',labels[row.outcome] ?? 'Kiểm tra lại cách gọi hàm.'))
    for (const step of failures) {
      const values=element('dl')
      const matcher=step.matcher ?? (original.failure?.testId===row.id ? original.failure.matcher : undefined)
      for (const [label,value] of [
        [matcher ? 'Mong đợi ('+(comparators[matcher] ?? matcher)+')' : 'Mong đợi',step.expected],
        ['Nhận được',step.actual]
      ]) {
        const dd=element('dd')
        dd.append(element('code',value))
        values.append(element('dt',label),dd)
      }
      card.append(element('p','Bước '+(step.index+1)),values)
    }
    list.append(card)
  }
  return list
}
export function showResult(container, job) {
  if (waiting.has(job.status)) {
    const status=banner('pending','Bot đang chấm bài...','Kết quả sẽ tự cập nhật tại đây.')
    status.prepend(element('span',null,{class:'spinner','aria-hidden':'true'}))
    container.replaceChildren(status)
    return
  }
  const rows=job.original?.results ?? []
  const failed=rows.filter(row=>row.outcome!=='ALL_PASS').length
  const summary=rows.length ? (rows.length-failed)+'/'+rows.length+' test đạt' : ''
  if (job.status==='ORIGINAL_FAILED') {
    container.replaceChildren(banner('negative','Có '+failed+' test chưa đạt',summary),failedCases(job.original))
  } else if (job.status==='REVIEW_REQUIRED') {
    const message=failed ? 'Xem các test gặp lỗi bên dưới.' : 'Điều phối viên có thể xem và chấm lại lượt bị gián đoạn.'
    const points=job.newPoints ? ' Đã ghi nhận +'+job.newPoints+' điểm.' : ''
    container.replaceChildren(banner('caution','Bài cần kiểm tra lại',message+points),failedCases(job.original))
  } else if (job.newPoints) {
    container.replaceChildren(banner('positive','+'+job.newPoints+' điểm','Phát hiện '+job.newPoints+' mutant mới.'),element('p',summary,{class:'result-summary'}))
  } else {
    container.replaceChildren(banner('neutral','Chưa có điểm mới',summary ? summary+'. Lượt này chưa phát hiện thêm mutant.' : 'Lượt chấm đã kết thúc.'))
  }
}
