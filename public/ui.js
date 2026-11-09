export const el=id=>document.getElementById(id)
export function node(tag,text,style) {
  const item=document.createElement(tag)
  if (text!==undefined) item.textContent=text
  if (style) item.className=style
  return item
}
export function button(text,handler,style) {
  const item=node('button',text,style)
  item.type='button'
  item.addEventListener('click',handler)
  return item
}
export function optionSelect(id,options,value,change) {
  const select=node('select')
  select.id=id
  for (const [key,label] of options) select.add(new Option(label,key))
  select.value=value??''
  select.addEventListener('change',()=>change(select.value))
  return select
}
