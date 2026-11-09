import {parse} from 'acorn'
import {operations,scenarios} from './catalog.mjs'

const namePattern = /^[A-Za-z_$][\w$]{0,31}$/
const banned = new Set(['__proto__','prototype','constructor'])
export const matchers = ['toBe','toEqual','toBeGreaterThan','toBeLessThan']
const allowed = (object,key) => typeof key === 'string' && Object.hasOwn(object,key)
const fail = message => { throw new Error(message) }
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const plain = value => typeof value === 'string' && value.length <= 300
function identifier(value) {
  return plain(value) && namePattern.test(value) && !banned.has(value)
}
export function pathParts(path) {
  if (typeof path !== 'string' || path.length > 128) fail('Đường dẫn kết quả không hợp lệ.')
  const root = /^[A-Za-z_$][\w$]{0,31}/.exec(path)
  if (!root || !identifier(root[0])) fail('Đường dẫn kết quả không hợp lệ.')
  const parts = [root[0]]
  let rest = path.slice(root[0].length)
  while (rest) {
    const segment = /^(?:\.([A-Za-z_$][\w$]{0,31})|\[(0|[1-9]\d{0,2})\])/.exec(rest)
    if (!segment || parts.length > 8 || (segment[1] && banned.has(segment[1]))) fail('Đường dẫn kết quả không hợp lệ.')
    parts.push(segment[1] || segment[2])
    rest = rest.slice(segment[0].length)
  }
  return parts
}
function ref(path, seen) {
  if (!seen.has(pathParts(path)[0])) fail('Tham chiếu phải trỏ đến lời gọi đã có.')
  return {ref:path}
}
function json(value, depth=0) {
  if (depth > 5) fail('Giá trị lồng quá sâu.')
  if (value === null || typeof value === 'boolean' || Number.isFinite(value) || plain(value)) return value
  if (Array.isArray(value) && value.length <= 24) return value.map(item => json(item, depth+1))
  if (object(value) && Object.keys(value).length <= 24) {
    return Object.fromEntries(Object.entries(value).map(([key,item]) => {
      if (!identifier(key)) fail('Tên thuộc tính không hợp lệ.')
      return [key,json(item,depth+1)]
    }))
  }
  fail('Giá trị phải là số, chuỗi, boolean, null, mảng hoặc object nhỏ.')
}
export function validArgument(spec,value) {
  return spec.type === 'integer' ? Number.isSafeInteger(value) && Math.abs(value) <= 1e9
    : spec.type === 'number' ? Number.isFinite(value) && Math.abs(value) <= 1e9
    : spec.type === 'boolean' ? typeof value === 'boolean'
    : spec.type === 'enum' ? spec.values.includes(value) : plain(value)
}
function valueOperand(value,seen) {
  if (object(value) && Object.keys(value).length === 1 && Object.hasOwn(value,'ref')) return ref(value.ref,seen)
  return json(value)
}
function validateCase(input,operationSet,scenarioSet,preview,index) {
  if (!object(input) || !plain(input.name) || !input.name.trim() || input.name.length > 80 ||
      !Array.isArray(input.steps) || !input.steps.length || input.steps.length > 24) fail('Mỗi test cần tên và tối đa 24 bước.')
  const seen = new Set()
  let assertions = 0
  const steps = input.steps.map(step => {
    if (!object(step)) fail('Bước kiểm thử không hợp lệ.')
    if (step.kind === 'call') {
      if (!identifier(step.as) || seen.has(step.as) || !allowed(operationSet,step.op)) fail('Tên lời gọi hoặc hàm không hợp lệ.')
      const params = operationSet[step.op].args
      if (!Array.isArray(step.args) || step.args.length !== params.length) fail('Số tham số không khớp hàm.')
      const args = step.args.map((item,i) => {
        const v = valueOperand(item,seen)
        if (object(v) && Object.hasOwn(v,'ref')) return v
        if (!validArgument(params[i],v)) fail('Kiểu hoặc phạm vi tham số không hợp lệ cho ' + params[i].label + '.')
        return v
      })
      seen.add(step.as)
      return {kind:'call',as:step.as,op:step.op,args}
    }
    if (step.kind !== 'assert' || !matchers.includes(step.matcher)) fail('Kiểm tra kết quả không hợp lệ.')
    assertions++
    return {kind:'assert',actual:ref(step.actual,seen).ref,matcher:step.matcher,expected:valueOperand(step.expected,seen)}
  })
  if (!assertions && !preview) fail('Mỗi test cần ít nhất một assertion trên kết quả SUT.')
  if (!seen.size) fail('Thêm ít nhất một lời gọi SUT.')
  const scenario=input.scenario ?? 'standard'
  if (!allowed(scenarioSet,scenario)) fail('Kịch bản fixture không hợp lệ.')
  const id=input.id ?? 'case-'+(index+1)
  if (typeof id!=='string' || !/^[A-Za-z0-9_-]{1,48}$/.test(id)) fail('ID test không hợp lệ.')
  return {id,name:input.name.trim(),scenario,steps}
}

function literal(node, depth=0) {
  if (!node || depth > 5) fail('Giá trị JS không được hỗ trợ.')
  if (node.type === 'Literal' && !node.regex && !node.bigint) return json(node.value)
  if (node.type === 'UnaryExpression' && node.operator === '-' && Number.isFinite(node.argument.value)) return -node.argument.value
  if (node.type === 'ArrayExpression') return node.elements.map(x => literal(x,depth+1))
  if (node.type === 'ObjectExpression') return Object.fromEntries(node.properties.map(prop => {
    if (prop.type !== 'Property' || prop.computed || prop.kind !== 'init' || prop.method || prop.shorthand) fail('Object cần cặp tên và giá trị cố định.')
    const key = prop.key.name ?? prop.key.value
    if (!identifier(key)) fail('Tên thuộc tính không hợp lệ.')
    return [key,literal(prop.value,depth+1)]
  }))
  fail('Dùng giá trị cố định hoặc tham chiếu tới kết quả trước.')
}
function jsPath(node) {
  if (node?.type === 'Identifier' && identifier(node.name)) return node.name
  if (node?.type === 'MemberExpression' && !node.optional) {
    if (!node.computed && identifier(node.property.name)) return jsPath(node.object) + '.' + node.property.name
    if (node.computed && Number.isInteger(node.property.value) && node.property.value >= 0 && node.property.value <= 999) {
      return jsPath(node.object) + '[' + node.property.value + ']'
    }
  }
  fail('Dùng tên kết quả, thuộc tính hoặc chỉ số mảng cố định.')
}
function jsValue(node) {
  return ['Identifier','MemberExpression'].includes(node?.type) ? {ref:jsPath(node)} : literal(node)
}
function jsCall(expr,as) {
  const node = expr?.type === 'AwaitExpression' ? expr.argument : expr
  const callee = node?.callee
  if (node?.type !== 'CallExpression' || node.optional || callee?.type !== 'MemberExpression' || callee.computed ||
      callee.optional || callee.object.name !== 'sut' || !identifier(callee.property.name)) fail('Chỉ có thể gọi hàm công khai qua sut.')
  return {kind:'call',as,op:callee.property.name,args:node.arguments.map(jsValue)}
}
function jsAssert(expr,steps) {
  const callee = expr?.callee
  const expect = callee?.object
  if (expr?.type !== 'CallExpression' || expr.optional || callee?.type !== 'MemberExpression' || callee.computed ||
      callee.optional || !matchers.includes(callee.property.name) || expect?.type !== 'CallExpression' ||
      expect.optional || expect.callee.name !== 'expect' || expect.arguments.length !== 1 || expr.arguments.length !== 1) {
    fail('Dùng expect(kết quả).toBe(giá trị) hoặc matcher được công bố.')
  }
  let value = expect.arguments[0]
  if (['AwaitExpression','CallExpression'].includes(value.type)) {
    const as = '$inline' + steps.length
    steps.push(jsCall(value,as))
    value = {type:'Identifier',name:as}
  }
  steps.push({kind:'assert',actual:jsPath(value),matcher:callee.property.name,expected:jsValue(expr.arguments[0])})
}
function compileCode(code) {
  if (typeof code !== 'string' || code.length > 12000) fail('Code vượt giới hạn 12.000 ký tự.')
  let ast
  try { ast = parse(code,{ecmaVersion:2024,sourceType:'script'}) } catch (error) {
    fail('Lỗi cú pháp ở dòng ' + (error.loc?.line ?? '?') + '.')
  }
  return ast.body.map(statement => {
    const call = statement.expression
    const args=call?.arguments || []
    const [name]=args
    const body=args.at(-1)
    const scenario=args.length===3 && args[1]?.type==='Literal' ? args[1].value : 'standard'
    if (statement.type !== 'ExpressionStatement' || call.type !== 'CallExpression' || call.optional ||
        !['test','it'].includes(call.callee.name) || ![2,3].includes(args.length) || (args.length===3 && typeof args[1]?.value!=='string') ||
        name.type !== 'Literal' || !plain(name.value) || !['ArrowFunctionExpression','FunctionExpression'].includes(body.type) ||
        body.params.length || body.generator) fail('Mỗi mục code dùng test hoặc it với tên và callback không tham số.')
    const steps = []
    if (body.body.type !== 'BlockStatement') jsAssert(body.body,steps)
    else for (const line of body.body.body) {
      if (line.type === 'VariableDeclaration' && line.kind === 'const' && line.declarations.length === 1) {
        const decl = line.declarations[0]
        if (decl.id.type !== 'Identifier') fail('Dùng const tên = await sut.hàm(...).')
        steps.push(jsCall(decl.init,decl.id.name))
      } else if (line.type === 'ExpressionStatement') {
        const expr = line.expression
        if (expr.type === 'AwaitExpression' || expr.callee?.object?.name === 'sut') {
          steps.push(jsCall(expr,'$step'+steps.length))
        } else jsAssert(expr,steps)
      } else fail('Trong test, dùng const, lời gọi sut và expect. Vòng lặp, import và truy cập hệ thống không được hỗ trợ.')
    }
    return {name:name.value,scenario,steps}
  })
}
export function prepareSuite(payload,{operationSet=operations,scenarioSet=scenarios,preview=false}={}) {
  if (!object(payload) || !Array.isArray(payload.builder) || typeof payload.code !== 'string' ||
      payload.builder.length > 12) fail('Bộ test không hợp lệ.')
  const raw = [...payload.builder,...(payload.code.trim() ? compileCode(payload.code) : [])]
  if (!raw.length || raw.length > 12) fail('Nộp từ 1 đến 12 test.')
  const suite=raw.map((item,index)=>validateCase(item,operationSet,scenarioSet,preview,index))
  if (new Set(suite.map(test=>test.id)).size!==suite.length) fail('Hai test trùng ID.')
  if (suite.reduce((n,test) => n + test.steps.length,0) > 90) fail('Bộ test vượt 90 bước.')
  return suite
}
export function readResult(results,path) {
  const [root,...keys] = pathParts(path)
  let value = results.get(root)
  for (const key of keys) {
    if (value === null || typeof value !== 'object' || !Object.hasOwn(value,key)) return undefined
    value = value[key]
  }
  return value
}
export function resolveValue(results,value) {
  return object(value) && Object.hasOwn(value,'ref') ? readResult(results,value.ref) : value
}
