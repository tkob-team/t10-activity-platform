const scope=entrant=>entrant.room+'/'+entrant.id
const key=(entrant,id)=>'t10-draft-v1/'+scope(entrant)+'/'+id
const selectedKey=entrant=>'t10-round-v2/'+scope(entrant)
const read=(id)=>{try {return localStorage.getItem(id)} catch {return null}}
const write=(id,value)=>{try {localStorage.setItem(id,value)} catch {}}
export const selectedRound=entrant=>read(selectedKey(entrant))
export const rememberRound=(entrant,id)=>write(selectedKey(entrant),id)
export const saveDraft=(entrant,id,data)=>write(key(entrant,id),JSON.stringify(data))

export function loadDraft(entrant,id) {
  const data={builder:[],code:'',mode:'builder',active:0,nextRef:1,includeBuilder:true,includeCode:true,request:null}
  try {
    const saved=JSON.parse(read(key(entrant,id)))
    if (saved && Array.isArray(saved.builder) && typeof saved.code==='string') Object.assign(data,saved)
  } catch {}
  data.builder=data.builder.filter(test=>test && Array.isArray(test.steps) && typeof test.name==='string')
    .map(test=>({...test,id:/^[\w-]{1,48}$/.test(test.id??'')?test.id:crypto.randomUUID(),scenario:test.scenario??'standard'}))
  data.active=Math.min(data.builder.length-1,Math.max(0,Number.isInteger(data.active)?data.active:0))
  if (!data.builder.length) data.active=0
  if (!['builder','code'].includes(data.mode)) data.mode='builder'
  const last=Math.max(0,...data.builder.flatMap(test=>test.steps.map(step=>Number(step.as?.slice(1))||0)))
  data.nextRef=Math.max(last+1,Number(data.nextRef)||1)
  return data
}
