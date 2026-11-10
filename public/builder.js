export function element(tag, text, attributes = {}) {
  const node = document.createElement(tag)
  if (text !== null && text !== undefined) node.textContent = text
  for (const [key, value] of Object.entries(attributes)) node.setAttribute(key, value)
  return node
}

export function button(text, run, attributes = {}) {
  const node = element('button', text, { type: 'button', ...attributes })
  node.addEventListener('click', run)
  return node
}

export const limits = { cases: 12, steps: 24, suite: 90 }
const actorLabels = { alice: 'Alice', bob: 'Bob', admin: 'Quản trị viên', guest: 'Khách' }
const presetLabels = { standard: 'Mặc định', short: 'Hết hạn sớm', extended: 'Hết hạn muộn' }

function select(options, selected, change, prompt) {
  const input = element('select')
  input.append(element('option', prompt || 'Chọn…', { value: '', disabled: '' }))
  for (const [value, label] of options) input.append(element('option', label, { value }))
  input.value = selected ?? ''
  if (input.selectedIndex === -1) input.selectedIndex = 0
  input.addEventListener('change', () => change(input.value))
  return input
}
function field(label, control) {
  const node = element('label')
  node.append(element('span', label), control)
  return node
}
function typed(spec, value, update) {
  const options = spec.type === 'boolean' ? [['true','Có'],['false','Không']] :
    (spec.values ?? []).map(item => [item, actorLabels[item] ?? item])
  if (options.length) return select(options, value, raw => update(spec.type === 'boolean' ? raw === 'true' : raw))
  const numeric = ['integer','number'].includes(spec.type)
  const input = element('input', null, { type:numeric ? 'number' : 'text', maxlength:'300' })
  if (numeric) input.step = spec.type === 'integer' ? '1' : 'any'
  input.value = value ?? ''
  input.addEventListener('input', () => update(numeric ? (input.value ? input.valueAsNumber : null) : input.value))
  return input
}
export function caseTitle(test, pack, index) {
  const name = test.name?.trim()
  if (name && !/^Tình huống \d+$/.test(name)) return name
  return pack.operations[test.steps.find(step => step.op)?.op]?.label || 'Tình huống ' + (index + 1)
}
function presetHint(pack, value) {
  const data = pack.scenarios[value]
  if (!data) return ''
  return 'Giỏ rỗng. Bob mở khóa ở phút ' + data.bobLockMinute + '. Mã ' + pack.fixture.coupon.code +
    ' hết hạn ở phút ' + data.expiryMinute + ', có ' + data.maxUses + ' lượt dùng.'
}
const refsFor = prior => [...prior].flatMap(([alias, call]) => Object.keys(call.meta.output).map(path =>
  [alias + '.' + path, 'Bước ' + call.number + ' / ' + path]))

export function createBuilder(container, draft, pack, save, limitLabel, addControl) {
  let active = draft.builder[0]?.id
  const set = (focus) => {
    save()
    render()
    if (focus) container.querySelector(focus)?.focus()
  }
  function controls(test, index) {
    const group = element('div', null, { class:'step-actions' })
    for (const [delta, label, text] of [[-1,'Chuyển bước lên','↑'],[1,'Chuyển bước xuống','↓']]) {
      const control = button(text, () => {
        const next = index + delta
        const moved = test.steps.splice(index,1)[0]
        test.steps.splice(next,0,moved)
        set('#' + test.id + ' [data-step="' + next + '"] select')
      }, { 'aria-label':label, title:label, class:'icon-button' })
      control.disabled = !test.steps[index + delta]
      group.append(control)
    }
    group.append(button('×', () => { test.steps.splice(index,1); set('#case-card-' + test.id) },
      { 'aria-label':'Xóa bước', title:'Xóa bước', class:'icon-button' }))
    return group
  }
  function render() {
    const total = draft.builder.reduce((n,test)=>n+test.steps.length,0)
    limitLabel.textContent = draft.builder.length + '/' + limits.cases + ' tình huống'
    addControl.disabled = draft.builder.length >= limits.cases || total >= limits.suite
    container.replaceChildren()
    if (!draft.builder.length) {
      container.append(element('p','Thêm tình huống rồi chọn hàm đầu tiên.',{class:'empty'}))
      return
    }
    const caseList = element('div', null, { class:'case-grid', role:'group', 'aria-label':'Tình huống' })
    container.append(caseList)
    for (const [caseIndex,test] of draft.builder.entries()) {
      const cardId = 'case-card-' + test.id
      const card = button('', () => {
        if (active === test.id) return
        active = test.id
        render()
        document.getElementById(cardId)?.focus()
      }, { class:'case-card', id:cardId, 'aria-pressed':String(active===test.id) })
      const cardTitle = element('strong',caseTitle(test,pack,caseIndex))
      const description = () => (presetLabels[test.scenario] ?? test.scenario) + ', ' + test.steps.length + ' bước'
      const cardMeta = element('small',description(),{class:'muted'})
      card.append(element('span',String(caseIndex+1).padStart(2,'0'),{class:'case-index'}),cardTitle,cardMeta)
      caseList.append(card)
      if (active !== test.id) continue
      const body = element('section',null,{class:'case-body',id:test.id,'aria-labelledby':cardId})
      const settings = element('div',null,{class:'case-settings'})
      const dataset = select(Object.entries(pack.scenarios).map(([key,data])=>[key,presetLabels[key] ?? data.label]),
        test.scenario,value=>{ test.scenario=value; hint.textContent=presetHint(pack,value); cardMeta.textContent=description(); save() })
      const hint = element('p',presetHint(pack,test.scenario),{class:'field-hint'})
      const dataGroup = element('div')
      dataGroup.append(field('Bộ dữ liệu',dataset),hint)
      const name = element('input',null,{maxlength:'80',placeholder:'Tự đặt tên nếu cần'})
      name.value = /^Tình huống \d+$/.test(test.name) ? '' : test.name
      name.addEventListener('input',()=>{ test.name=name.value; cardTitle.textContent=caseTitle(test,pack,caseIndex); save() })
      settings.append(dataGroup,field('Tên test (tùy chọn)',name))
      body.append(settings)
      const steps = element('ol',null,{class:'step-list'})
      const prior = new Map()
      for (const [index,step] of test.steps.entries()) {
        const item = element('li',null,{class:'step','data-step':String(index)})
        const head = element('div',null,{class:'step-head'})
        head.append(element('span',String(index+1),{class:'step-index'}),element('strong',step.kind==='call'?'Gọi hàm':'Kiểm tra kết quả'),controls(test,index))
        item.append(head)
        const fields = element('div',null,{class:'step-fields'})
        const references = refsFor(prior)
        if (step.kind === 'call') {
          const operation = select(Object.entries(pack.operations).map(([id,meta])=>[id,meta.label+' / '+id+'()']),
            step.op,value=>{
              step.op=value; step.args=pack.operations[value].args.map(()=>null)
              set('#'+test.id+' [data-step="'+index+'"] select')
            },'Chọn hàm cần gọi')
          fields.append(field('Hàm',operation))
          const meta = pack.operations[step.op]
          if (meta) {
            for (const [i,spec] of meta.args.entries()) {
              const current=step.args[i]
              const isRef=current!==null && typeof current==='object'
              const group=element('div',null,{class:'argument'})
              const control=isRef ? select(references,current.ref,value=>{ current.ref=value; save() },'Chọn kết quả bước trước') :
                typed(spec,current,value=>{step.args[i]=value;save()})
              group.append(field(spec.label,control))
              if (references.length || isRef) group.append(button(isRef?'Nhập giá trị':'Dùng kết quả trước',()=>{
                step.args[i]=isRef?null:{ref:''}; set()
              },{class:'text-button'}))
              fields.append(group)
            }
            prior.set(step.as,{meta,number:index+1})
          }
        } else {
          const dot=step.actual.indexOf('.')
          const type=prior.get(step.actual.slice(0,dot))?.meta.output[step.actual.slice(dot+1)]
          fields.append(field('Kết quả cần kiểm tra',select(references,step.actual,value=>{
            step.actual=value; step.matcher='toBe'; step.expected=null
            set('#'+test.id+' [data-step="'+index+'"] label:last-child :is(input,select)')
          },'Chọn kết quả của lời gọi trước')))
          if (type) {
            const comparators=[['toBe','Bằng']]
            if (step.matcher==='toEqual') comparators.push(['toEqual','Bằng theo cấu trúc'])
            if (['integer','number'].includes(type)) comparators.push(['toBeGreaterThan','Lớn hơn'],['toBeLessThan','Nhỏ hơn'])
            if (type==='string') comparators.push(['toContain','Có chứa'])
            fields.append(field('So sánh',select(comparators,step.matcher,value=>{step.matcher=value;save()})))
            fields.append(field('Giá trị mong đợi',typed(pack.enums[type]?{type:'enum',values:pack.enums[type]}:{type},
              step.expected,value=>{step.expected=value;save()})))
          }
        }
        item.append(fields)
        steps.append(item)
      }
      body.append(steps)
      const footer=element('div',null,{class:'case-footer'})
      const add = kind => {
        test.steps.push(kind==='call'?{kind,as:'call'+(++draft.sequence),op:'',args:[]}:
          {kind,actual:'',matcher:'toBe',expected:null})
        set('#'+test.id+' [data-step="'+(test.steps.length-1)+'"] select')
      }
      const call=button('+ Gọi thêm hàm',()=>add('call'),{class:'secondary'})
      const assertion=button('+ Kiểm tra kết quả',()=>add('assert'),{class:'secondary'})
      const full=test.steps.length>=limits.steps || total>=limits.suite
      call.disabled=full
      assertion.disabled=full || !prior.size
      footer.append(call,assertion,element('small',test.steps.length+'/'+limits.steps+' bước',{class:'muted'}))
      if (!prior.size) footer.append(element('small','Chọn hàm trước để có kết quả cần kiểm tra.',{class:'field-hint'}))
      if (total>=limits.suite) footer.append(element('small','Bộ test đã đủ '+limits.suite+' bước.',{class:'field-hint'}))
      footer.append(button('Xóa tình huống',()=>{
        draft.builder.splice(caseIndex,1); active=draft.builder[caseIndex]?.id ?? draft.builder.at(-1)?.id; set(); addControl.focus()
      },{class:'text-button remove-case'}))
      body.append(footer)
      container.append(body)
    }
  }
  addControl.addEventListener('click',()=>{
    const id='case-'+(++draft.sequence)
    draft.builder.push({id,name:'',scenario:'standard',steps:[{kind:'call',as:'call'+(++draft.sequence),op:'',args:[]}]})
    active=id
    set('#'+id+' [data-step="0"] select')
  })
  render()
  return issue => {
    active=issue.id
    render()
    const panel=document.getElementById(issue.id)
    const control=issue.step===undefined?document.getElementById('case-card-'+issue.id):panel?.querySelector('[data-step="'+issue.step+'"] select')
    control?.focus()
  }
}

export function buildSuite(cases, pack) {
  return cases.map((test,index)=>{
    const refs=new Set()
    const error=(text,step)=>Object.assign(new Error('Tình huống '+(index+1)+': '+text),{id:test.id,step})
    for (const [i,step] of test.steps.entries()) {
      const valid=value=>value!==null && value!==undefined && (typeof value!=='object' || refs.has(value.ref))
      if (step.kind==='call') {
        const op=pack.operations[step.op]
        if (!op || step.args.length!==op.args.length || !step.args.every(valid)) throw error('chọn hàm và điền đủ dữ liệu ở bước '+(i+1)+'.',i)
        for (const path of Object.keys(op.output)) refs.add(step.as+'.'+path)
      } else if (!refs.has(step.actual) || !step.matcher || !valid(step.expected)) {
        throw error('chọn kết quả và giá trị mong đợi ở bước '+(i+1)+'.',i)
      }
    }
    if (!test.steps.some(step=>step.kind==='assert')) throw error('thêm ít nhất một bước kiểm tra kết quả.')
    return {...test,name:caseTitle(test,pack,index)}
  })
}
