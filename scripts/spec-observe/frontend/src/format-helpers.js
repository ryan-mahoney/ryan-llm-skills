export const str=v=>v==null?'':typeof v==='string'?v:JSON.stringify(v);
export const esc=v=>str(v).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
export const base=p=>str(p).replace(/\/$/,'').split('/').pop()||'Unknown';
export const time=v=>{const d=new Date(v);return v&&Number.isFinite(d.getTime())?d.toLocaleString():'Unknown'};
/** @type {null|((path:string)=>string|null)} */
let linkResolver=null;
const packageRelativeLink=path=>linkResolver?.(path)??null;
function inlineMarkdown(value, links=true, depth=0){
 const input=str(value);if(depth>3)return esc(input);
 const tokens=/(`+)([^\n]*?)\1|\[([^\]\n]+)\]\(([^\s)]+)\)|\*\*(.+?)\*\*|__(.+?)__|\*([^*\n]+)\*|_([^_\n]+)_/g;
 let html='',offset=0;
 for(const match of input.matchAll(tokens)){
  html+=esc(input.slice(offset,match.index));
  if(match[1])html+=`<code>${esc(match[2])}</code>`;
  else if(match[3]){
   const label=esc(match[3]),url=/^https?:\/\//i.test(match[4])?match[4]:packageRelativeLink(match[4]);
   html+=links&&url?`<a href="${esc(url)}" target="_blank" rel="noopener noreferrer">${label}</a>`:label;
  }else{const strong=match[5]??match[6],text=strong??match[7]??match[8],tag=strong!==undefined?'strong':'em';html+=`<${tag}>${inlineMarkdown(text,links,depth+1)}</${tag}>`;}
  offset=match.index+match[0].length;
 }
 return html+esc(input.slice(offset));
}
function statusMarkdown(value){
 const lines=str(value).replace(/\r\n?/g,'\n').split('\n'),blocks=[];
 let paragraph=[],list=[],listTag=null,code=null,fence=null;
 const flush=()=>{if(paragraph.length){blocks.push(`<p>${inlineMarkdown(paragraph.join('\n')).replace(/\n/g,'<br>')}</p>`);paragraph=[];}if(list.length){blocks.push(`<${listTag}>${list.join('')}</${listTag}>`);list=[];listTag=null;}};
 for(let index=0;index<lines.length;index++){const line=lines[index];
  const fenced=/^\s*(`{3,}|~{3,})/.exec(line);
  if(code!==null){if(fenced&&fenced[1][0]===fence[0]&&fenced[1].length>=fence.length){blocks.push(`<pre><code>${esc(code.join('\n'))}</code></pre>`);code=null;}else code.push(line);continue;}
  if(fenced){flush();code=[];fence=fenced[1];continue;}
  if(!line.trim()){flush();continue;}
  if(line.includes('|')&&index+1<lines.length&&/^\s*\|?\s*:?-{3,}:?\s*(?:\|\s*:?-{3,}:?\s*)+\|?\s*$/.test(lines[index+1])){flush();const cells=v=>v.trim().replace(/^\||\|$/g,'').split('|').map(x=>inlineMarkdown(x.trim()));const headers=cells(line);index++;const body=[];while(index+1<lines.length&&lines[index+1].trim()&&lines[index+1].includes('|'))body.push(cells(lines[++index]));blocks.push(`<div style="overflow:auto"><table class="timing-table"><thead><tr>${headers.map(v=>`<th scope="col">${v}</th>`).join('')}</tr></thead><tbody>${body.map(row=>`<tr>${row.map(v=>`<td>${v}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`);continue;}
  const heading=/^#{1,6}\s+(.+)$/.exec(line),item=/^\s*(?:([-+*])|\d+[.)])\s+(.+)$/.exec(line);
  if(heading){flush();blocks.push(`<p class="status-heading">${inlineMarkdown(heading[1])}</p>`);}
  else if(item){const tag=item[1]?'ul':'ol';if(paragraph.length||listTag&&listTag!==tag)flush();listTag=tag;list.push(`<li>${inlineMarkdown(item[2])}</li>`);}
  else{if(list.length)flush();paragraph.push(line);}
 }
 flush();if(code!==null)blocks.push(`<pre><code>${esc(code.join('\n'))}</code></pre>`);
 return blocks.join('');
}

export {inlineMarkdown};
/** @param {unknown} value @param {null|((path:string)=>string|null)} resolver */
export function renderMarkdown(value, resolver=null){const old=linkResolver;linkResolver=resolver;try{return statusMarkdown(value);}finally{linkResolver=old;}}
