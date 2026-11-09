import {el,node,button,optionSelect} from './ui.js'

const comparisons=[['toBe','Bằng'],['toBeGreaterThan','Lớn hơn'],['toBeLessThan','Nhỏ hơn']]
const numberTypes=new Set(['number','integer'])
const outputNames={'status':'Mã HTTP','body.status':'Trạng thái','body.length':'Số mục','body.orderId':'ID đơn mới',
  'body.coupon_id':'ID mã','body.discount_amount':'Số tiền giảm','body.final_amount':'Số tiền sau giảm',
  'body[0].quantity':'Số lượng mục đầu','body[0].price':'Đơn giá mục đầu','body[0].id':'ID mục đầu'}
const missing=value=>value==null || typeof value==='number'&&!Number.isFinite(value) ||
  Boolean(value && typeof value==='object'&&!value.ref)

export function createBuilder({getDraft,getProblem,onChange,onStructure,onPreview,onOutput,getError,clearError}) {
  function mark(group,control,id) {
    const error=getError()
    if (error?.id!==id || error.testIndex!==getDraft().active) return
    const note=node('p',error.message,'error small')
    note.id=id+'-error'
    group.setAttribute('aria-invalid','true')
    control.setAttribute('aria-invalid','true')
    control.setAttribute('aria-describedby',note.id)
    group.append(note)
  }
  function labelled(id,label,control) {
    const group=node('div',undefined,'field')
    const caption=node('label',label)
    caption.htmlFor=id
    control.id=id
    group.append(caption,control)
    mark(group,control,id)
    return group
  }
  function choices(id,label,options,value,change) {
    return labelled(id,label,optionSelect(id,options,value,raw=>{clearError(id);change(raw);onChange()}))
  }
  function typed(id,spec,value,change) {
    const problem=getProblem()
    const type=spec.type
    if (['enum','orderStatus','boolean'].includes(type)) {
      const values=type==='boolean'?[['true','Có'],['false','Không']]:
        (spec.values??problem.enums[type]??[]).map(item=>[item,item])
      return choices(id,spec.label,[['','Chọn giá trị'],...values],value,raw=>change(raw===''?null:type==='boolean'?raw==='true':raw))
    }
    const input=node('input')
    const numeric=numberTypes.has(type)
    input.type=numeric?'number':'text'
    if (numeric) input.step=type==='integer'?'1':'any'
    else input.maxLength=300
    input.value=value??''
    input.addEventListener('input',()=>{
      clearError(id)
      change(numeric?(input.value===''?null:input.valueAsNumber):input.value)
      onChange()
    })
    return labelled(id,spec.label,input)
  }
  function prior(steps,index) {
    const operations=getProblem().operations
    return steps.slice(0,index).flatMap((step,i)=>{
      const op=Object.hasOwn(operations,step.op)?operations[step.op]:null
      if (step.kind!=='call' || !op) return []
      return Object.entries(op.output).map(([path,type])=>({
        ref:step.as+'.'+path,type,label:'Bước '+(i+1)+' / '+op.label+' / '+(outputNames[path]??path)
      }))
    })
  }
  function operand(id,spec,value,outputs,change) {
    const options=outputs.filter(item=>item.type===spec.type ||
      (spec.type==='number' && item.type==='integer') ||
      (spec.type==='string' && ['enum','orderStatus'].includes(item.type)))
    if (value && typeof value==='object') {
      const group=choices(id,spec.label+' từ bước trước',[['','Chọn kết quả'],...options.map(x=>[x.ref,x.label])],
        value.ref,raw=>change({ref:raw}))
      group.append(button('Nhập trực tiếp',()=>{change(null);onStructure(id)},'quiet value-ref'))
      return group
    }
    const group=typed(id,spec,value,change)
    if (options.length) group.append(button('Lấy từ bước trước',()=>{change({ref:''});onStructure(id)},'quiet value-ref'))
    return group
  }
  function addCase() {
    const draft=getDraft()
    if (draft.builder.length>=12) return
    draft.builder.push({id:crypto.randomUUID(),name:'Test '+(draft.builder.length+1),scenario:'standard',steps:[]})
    draft.active=draft.builder.length-1
    draft.includeBuilder=true
    onStructure('test-name')
  }
  function stepCard(test,step,index) {
    const problem=getProblem(),id='step-'+index
    const card=node('section',undefined,'step')
    const head=node('div',undefined,'row split step-head')
    const actions=node('div',undefined,'row')
    for (const [label,move] of [['Lên',-1],['Xuống',1]]) {
      const target=index+move
      const item=button(label,()=>{
        ;[test.steps[index],test.steps[target]]=[test.steps[target],test.steps[index]]
        onStructure('step-'+target+'-'+(step.kind==='call'?'op':'actual'))
      },'quiet')
      item.disabled=target<0 || target>=test.steps.length
      item.setAttribute('aria-label',label+' bước '+(index+1))
      actions.append(item)
    }
    actions.append(button('Xóa bước',()=>{test.steps.splice(index,1);onStructure('add-call')},'quiet'))
    head.append(node('h4','Bước '+(index+1)+(step.kind==='call'?' / Gọi hàm':' / Kiểm tra')),actions)
    card.append(head)
    const outputs=prior(test.steps,index)
    if (step.kind==='call') {
      const methods=Object.entries(problem.operations).map(([key,op])=>[key,op.label+' ('+key+')'])
      card.append(choices(id+'-op','Hàm cần gọi',[['','Chọn một hàm'],...methods],step.op,value=>{
        const previous=step.op
        step.op=value
        if (previous!==value) {
          step.args=value?problem.operations[value].args.map(()=>null):[]
          for (const check of test.steps) {
            if (check.kind==='assert' && check.actual.startsWith(step.as+'.')) {
              check.actual='';check.expected=null;check.matcher='toBe'
            }
          }
        }
        onStructure(id+'-op')
      }))
      if (step.op && Object.hasOwn(problem.operations,step.op)) {
        const args=problem.operations[step.op].args
        if (!args.length) card.append(node('p','Hàm này không có tham số.','muted small'))
        else {
          const fields=node('div',undefined,'fields')
          args.forEach((spec,i)=>fields.append(operand(id+'-arg-'+i,spec,step.args[i],outputs,value=>{step.args[i]=value})))
          card.append(fields)
        }
      }
    } else {
      card.append(choices(id+'-actual','Kết quả cần kiểm tra',[['','Chọn kết quả'],...outputs.map(x=>[x.ref,x.label])],step.actual,value=>{
        step.actual=value;step.expected=null;step.matcher='toBe';onStructure(id+'-actual')
      }))
      const actual=outputs.find(item=>item.ref===step.actual)
      if (actual) {
        const fields=node('div',undefined,'fields')
        if (numberTypes.has(actual.type)) fields.append(choices(id+'-matcher','So sánh',comparisons,step.matcher,value=>{step.matcher=value}))
        fields.append(operand(id+'-expected',{type:actual.type,label:'Kết quả mong đợi'},step.expected,outputs,value=>{step.expected=value}))
        card.append(fields)
      }
    }
    return card
  }
  function render() {
    const draft=getDraft(),panel=el('builder')
    panel.replaceChildren()
    if (!draft.builder.length) {
      const empty=node('div',undefined,'empty')
      empty.append(node('h3','Chưa có test'),node('p','Thêm lời gọi và kiểm tra kết quả theo đặc tả.','muted'))
      panel.append(empty,button('+ Test',addCase,'secondary'))
      return
    }
    const rail=node('div',undefined,'row test-rail')
    draft.builder.forEach((test,index)=>{
      const select=button(test.name || 'Test '+(index+1),()=>{
        draft.active=index
        onStructure('pick-test-'+index)
      })
      select.id='pick-test-'+index
      select.setAttribute('aria-pressed',String(draft.active===index))
      rail.append(select)
    })
    const add=button('+ Test',addCase,'secondary')
    add.disabled=draft.builder.length>=12
    rail.append(add);panel.append(rail)
    const test=draft.builder[draft.active]
    if (!test) return
    const card=node('article',undefined,'case-card')
    const head=node('div',undefined,'row split case-title')
    head.append(node('h3','Test '+(draft.active+1)),button('Xóa test',()=>{
      draft.builder.splice(draft.active,1)
      draft.active=Math.max(0,Math.min(draft.active,draft.builder.length-1))
      onStructure()
    },'quiet'))
    card.append(head)
    const fields=node('div',undefined,'fields case-fields')
    const name=node('input')
    name.type='text';name.maxLength=80;name.value=test.name
    name.addEventListener('input',()=>{clearError('test-name');test.name=name.value;onChange()})
    const scenarios=getProblem().scenarios
    const preset=Object.hasOwn(scenarios,test.scenario)?test.scenario:'standard'
    test.scenario=preset
    fields.append(labelled('test-name','Tên test',name),
      choices('scenario','Dữ liệu ban đầu',Object.entries(scenarios).map(([key,value])=>[key,value.label]),preset,value=>{
        test.scenario=value;onStructure('scenario')
      }))
    card.append(fields)
    const fixture=scenarios[test.scenario]
    card.append(node('p','Bob hết khóa ở phút '+fixture.bobLockMinute+' / Mã LABFIXED hết hạn ở phút '+fixture.expiryMinute+
      ' / Giới hạn '+fixture.maxUses+' lượt','muted small fixture-line'))
    card.append(...test.steps.map((step,index)=>stepCard(test,step,index)))
    let insert=test.steps.length
    const actions=node('div',undefined,'row builder-actions')
    const addStep=kind=>{
      const step=kind==='call'?{kind,as:'r'+draft.nextRef++,op:'',args:[]}:{kind,actual:'',matcher:'toBe',expected:null}
      test.steps.splice(insert,0,step)
      onStructure('step-'+insert+'-'+(kind==='call'?'op':'actual'))
    }
    const addCall=button('+ Lời gọi',()=>addStep('call'))
    const addCheck=button('+ Kiểm tra',()=>addStep('assert'))
    addCall.id='add-call';addCall.disabled=test.steps.length>=24
    function updateCheck() {addCheck.disabled=test.steps.length>=24 || prior(test.steps,insert).length===0}
    updateCheck()
    if (test.steps.length) actions.append(choices('insert-position','Vị trí thêm bước',
      [[String(test.steps.length),'Cuối test'],...test.steps.map((_,i)=>[String(i),'Trước bước '+(i+1)])],
      String(insert),value=>{insert=Number(value);updateCheck()}))
    actions.append(addCall,addCheck)
    mark(actions,addCall,'add-call')
    card.append(actions)
    const output=node('section',undefined,'case-output')
    output.id='case-output'
    const controls=node('div',undefined,'row output-actions')
    const preview=button('Chạy thử test này',()=>onPreview(test),'secondary')
    preview.id='preview-test'
    controls.append(preview,node('span','Chạy trên bản gốc','muted small'))
    card.append(controls,output)
    panel.append(card)
    onOutput()
  }
  function validate(tests,preview=false) {
    const draft=getDraft(),operations=getProblem().operations
    for (const test of tests) {
      const testIndex=draft.builder.indexOf(test)
      const fail=(id,message)=>{throw Object.assign(new Error(message),{field:{id,message,testIndex}})}
      if (!test.name.trim()) fail('test-name','Nhập tên test.')
      if (!test.steps.some(step=>step.kind==='call')) fail('add-call','Thêm ít nhất một lời gọi.')
      if (!preview && !test.steps.some(step=>step.kind==='assert')) fail('add-call','Thêm ít nhất một kiểm tra kết quả.')
      for (const [i,step] of test.steps.entries()) {
        const id='step-'+i,outputs=prior(test.steps,i)
        const validRef=value=>!(value && typeof value==='object') || outputs.some(item=>item.ref===value.ref)
        if (step.kind==='call') {
          const op=Object.hasOwn(operations,step.op)?operations[step.op]:null
          if (!op) fail(id+'-op','Chọn hàm cần gọi.')
          op.args.forEach((arg,index)=>{
            const value=step.args[index]
            if (missing(value) || !validRef(value)) fail(id+'-arg-'+index,'Nhập '+arg.label.toLowerCase()+' hoặc chọn kết quả từ bước trước.')
            if (arg.type==='integer' && typeof value==='number' && !Number.isSafeInteger(value)) fail(id+'-arg-'+index,'Nhập số nguyên.')
          })
        } else {
          if (!outputs.some(item=>item.ref===step.actual)) fail(id+'-actual','Chọn lại kết quả của một lời gọi trước bước này.')
          if (missing(step.expected) || !validRef(step.expected)) fail(id+'-expected','Nhập kết quả mong đợi hoặc chọn giá trị từ bước trước.')
        }
      }
    }
  }
  return {render,validate}
}
