import { EditorState } from '@codemirror/state'
import { EditorView, drawSelection, highlightActiveLine, keymap, lineNumbers, placeholder } from '@codemirror/view'
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands'
import { bracketMatching, HighlightStyle, syntaxHighlighting } from '@codemirror/language'
import { javascript } from '@codemirror/lang-javascript'
import { tags } from '@lezer/highlight'

const colors=HighlightStyle.define([
  {tag:[tags.keyword,tags.operatorKeyword,tags.controlKeyword],color:'#c586c0'},
  {tag:[tags.string,tags.special(tags.string)],color:'#ce9178'},
  {tag:[tags.number,tags.bool,tags.null],color:'#b5cea8'},
  {tag:[tags.function(tags.variableName),tags.function(tags.propertyName)],color:'#dcdcaa'},
  {tag:[tags.variableName,tags.propertyName],color:'#9cdcfe'},
  {tag:[tags.comment,tags.lineComment],color:'#86aa75'},
  {tag:[tags.operator,tags.punctuation,tags.bracket],color:'#d4d4d4'}
])
const theme=EditorView.theme({
  '&':{backgroundColor:'#1e1e1e',color:'#d4d4d4'},
  '&.cm-focused':{outline:'2px solid #8bb8ff',outlineOffset:'-2px'},
  '.cm-scroller':{fontFamily:'Consolas, ui-monospace, monospace',fontSize:'14px',lineHeight:'1.7',minHeight:'250px',maxHeight:'520px'},
  '.cm-content':{padding:'12px 0',caretColor:'#f4f4f4'},
  '.cm-line':{padding:'0 12px'},
  '.cm-gutters':{backgroundColor:'#1e1e1e',color:'#9b9b9b',border:'none',paddingLeft:'8px'},
  '.cm-activeLine':{backgroundColor:'#292929'},
  '.cm-cursor':{borderLeftColor:'#fff'},
  '.cm-placeholder':{color:'#a9a9a9'},
  '&.cm-focused .cm-selectionBackground, .cm-selectionBackground':{backgroundColor:'#264f78'}
},{dark:true})

export function mountEditor(parent, value, change) {
  const nonce=document.querySelector('meta[name="editor-style-nonce"]')?.content ?? ''
  return new EditorView({parent,state:EditorState.create({doc:value,extensions:[
    lineNumbers(),history(),drawSelection(),highlightActiveLine(),bracketMatching(),javascript(),theme,
    syntaxHighlighting(colors),keymap.of([...defaultKeymap,...historyKeymap]),
    EditorView.cspNonce.of(nonce),
    EditorView.contentAttributes.of({'aria-label':'Mã JavaScript của bộ test',spellcheck:'false'}),
    placeholder("test('Giỏ hàng trống', async () => {\n  const result = await sut.cart('alice');\n  expect(result.body.length).toBe(0);\n});"),
    EditorView.updateListener.of(update=>{
      if (update.docChanged) change(update.state.doc.toString())
    })
  ]})})
}
