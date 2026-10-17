/**
 * In-memory V4A study adapter, not an exact upstream implementation.
 * Matching/normalisation and source-coordinate chunk traversal adapted from the
 * Apache-2.0 upstream apply-patch implementation, pinned at:
 * https://github.com/openai/codex/tree/ce0323f2f2d3b25e82806cd555237da3db4e1897/codex-rs/apply-patch
 * Sources: seek_sequence.rs, file_update.rs, text_file.rs, streaming_parser.rs.
 * No installed Apache pi-codex-tools adaptation was available; no package dependency.
 *
 * Deliberate differences: refuse multiple matches at the FIRST successful matching
 * tier, including @@ anchors; no silent first-match choice. Strict envelope is exact;
 * lenient-wrapper permits only the wrappers declared below, never prose extraction.
 * Updates retain context bytes, individual LF/CRLF/CR endings and original final-
 * newline presence. Inserted lines use the first source ending (LF if absent).
 * Upstream currently terminates every updated line instead. New files use LF and
 * a final newline when nonempty. Matching never normalises output or gold text.
 * File operations execute sequentially on a private copy, hunks match forward-only
 * against that operation's original source. No filesystem, syntax check or model.
 */
export const PROVENANCE = Object.freeze({
  upstream_revision: 'ce0323f2f2d3b25e82806cd555237da3db4e1897',
  upstream_url: 'https://github.com/openai/codex/tree/ce0323f2f2d3b25e82806cd555237da3db4e1897/codex-rs/apply-patch',
  upstream_license: 'Apache-2.0',
  matching_passes: ['exact', 'trim_end', 'trim', 'unicode'],
  uniqueness: 'All matches at first successful tier within cursor/anchor/EOF scope; refuse more than one.',
  endings: 'Preserve context bytes and individual terminators; first source ending for inserts; preserve update EOF newline presence; adds LF.',
  wrappers: ['outer blank lines', 'one whole ```diff/```patch/unlabelled fence', "one whole optional apply_patch <<'PATCH' or <<'EOF' heredoc"],
});
class PatchError extends Error {
  constructor(code,message,details={}) { super(message); this.code=code; Object.assign(this,details); }
}
const fail=(code,message,details)=>{throw new PatchError(code,message,details);};
const own=(o,k)=>Object.hasOwn(o,k);
function validPath(path) {
  return typeof path==='string' && path.length>0 && !path.includes('\\') && !path.includes('\0') &&
    !path.startsWith('/') && !/^[A-Za-z]:/.test(path) && !path.split('/').some(p=>!p || p==='.' || p==='..' || p==='.git');
}
// Rust str::trim uses Unicode White_Space; JS trim differs on U+0085 and U+FEFF.
const ws='[\\u0009-\\u000d\\u0020\\u0085\\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000]';
const leading=new RegExp('^'+ws+'+'),trailing=new RegExp(ws+'+$');
const trimEnd=s=>s.replace(trailing,''),trim=s=>trimEnd(s.replace(leading,''));
const unicode=s=>trim(s).replace(/[\u2010-\u2015\u2212]/g,'-').replace(/[\u2018-\u201b]/g,"'")
  .replace(/[\u201c-\u201f]/g,'"').replace(/[\u00a0\u2002-\u200a\u202f\u205f\u3000]/g,' ');
const tiers=[['exact',s=>s],['trim_end',trimEnd],['trim',trim],['unicode',unicode]];
function envelopeLines(patch,envelope) {
  if(typeof patch!=='string' || !['strict','lenient-wrapper'].includes(envelope)) fail('malformed','Expected text patch and a declared envelope mode');
  let lines=patch.split(/\r\n|\n|\r/);
  if(lines.at(-1)==='') lines.pop(); // one transport terminator, not arbitrary extraction
  if(envelope==='lenient-wrapper') {
    const blanks=()=>{while(lines.length && /^\s*$/.test(lines[0]))lines.shift();while(lines.length && /^\s*$/.test(lines.at(-1)))lines.pop();};
    blanks();
    if(/^```(?:diff|patch)?$/.test(lines[0]??'') && lines.at(-1)==='```') lines=lines.slice(1,-1);
    else {
      const heredoc=/^(?:apply_patch )?<<'(PATCH|EOF)'$/.exec(lines[0]??'');
      if(heredoc && lines.at(-1)===heredoc[1]) lines=lines.slice(1,-1);
    }
    blanks();
  }
  if(lines[0]!=='*** Begin Patch' || lines.at(-1)!=='*** End Patch') fail('malformed','Exact Begin Patch/End Patch envelope required');
  return lines.slice(1,-1);
}
export function parseV4A(patch,{envelope='strict'}={}) {
  const lines=envelopeLines(patch,envelope),operations=[];
  let i=0;
  while(i<lines.length) {
    const header=/^\*\*\* (Add|Delete|Update) File: (.+)$/.exec(lines[i]);
    if(!header) fail('malformed',`Expected file header at patch line ${i+2}`);
    const operation={type:header[1].toLowerCase(),path:header[2],chunks:[]}; i++;
    if(operation.type==='delete') {operations.push(operation);continue;}
    if(operation.type==='add') {
      const added=[];
      while(i<lines.length && lines[i].startsWith('+')) added.push(lines[i++].slice(1));
      operation.content=added.length?added.join('\n')+'\n':'';operations.push(operation);continue;
    }
    if(lines[i]?.startsWith('*** Move to: ')) operation.move=lines[i++].slice('*** Move to: '.length);
    let chunk=null;
    const finish=()=>{if(chunk){if(!chunk.items.length)fail('malformed','Empty update chunk');operation.chunks.push(chunk);chunk=null;}};
    while(i<lines.length && !/^\*\*\* (?:Add|Delete|Update) File: /.test(lines[i])) {
      const line=lines[i++];
      if(line==='@@' || line.startsWith('@@ ')) {finish();chunk={anchor:line==='@@'?null:line.slice(3),items:[],eof:false};continue;}
      if(line==='*** End of File') {
        if(!chunk || !chunk.items.length)fail('malformed','End of File requires a preceding update chunk');
        chunk.eof=true;finish();
        if(i<lines.length && !/^\*\*\* (?:Add|Delete|Update) File: /.test(lines[i]))fail('malformed','End of File must end this file update');
        break;
      }
      if(![' ','+','-'].includes(line[0]))fail('malformed','Update lines must start with space, plus or minus');
      chunk??={anchor:null,items:[],eof:false};chunk.items.push({kind:line[0],text:line.slice(1)});
    }
    finish();if(!operation.chunks.length && !own(operation,'move'))fail('malformed','Update requires a chunk or move');
    operations.push(operation);
  }
  if(!operations.length)fail('malformed','Patch must contain a file operation');
  return operations;
}
function sourceLines(text) {
  const lines=[];let start=0;
  for(const match of text.matchAll(/\r\n|\n|\r/g)) {lines.push({text:text.slice(start,match.index),ending:match[0]});start=match.index+match[0].length;}
  if(start<text.length)lines.push({text:text.slice(start),ending:''});
  return lines;
}
function seek(lines,pattern,start,eof,details,matches) {
  const last=lines.length-pattern.length,begin=eof?Math.max(start,last):start;
  for(const [matchclass,normalise]of tiers) {
    const positions=[];
    for(let i=begin;i<=last;i++)if(pattern.every((p,j)=>normalise(lines[i+j])===normalise(p)))positions.push(i);
    if(!positions.length)continue;
    const record={...details,matchclass,candidates:positions.length,positions,scope:{start:begin,end:last,eof}};matches.push(record);
    if(positions.length>1)fail('ambiguous','Multiple matches within the permitted source scope',record);
    return positions[0];
  }
  return null;
}
function update(text,chunks,path,matches) {
  const original=sourceLines(text),lines=original.map(l=>l.text),replacements=[];
  const ending=original.find(l=>l.ending)?.ending??'\n',finalNewline=original.at(-1)?.ending!=='';
  let cursor=0;
  for(const [hunk,chunk]of chunks.entries()) {
    const details={path,hunk,kind:'chunk'};
    if(chunk.anchor!==null) {
      const anchor=seek(lines,[chunk.anchor],cursor,false,{...details,kind:'anchor'},matches);
      if(anchor===null)fail('context-not-found','Could not locate @@ anchor',{path,hunk});
      cursor=anchor+1;
    }
    let old=[],added=[],context=[];
    for(const item of chunk.items) {
      if(item.kind===' ')context.push([old.length,added.length]);
      if(item.kind!=='+')old.push(item.text);
      if(item.kind!=='-')added.push(item.text);
    }
    if(!old.length) { // Upstream pure-insertion chunks append, even with an @@ skip anchor.
      replacements.push({start:lines.length,count:0,lines:added});
      matches.push({...details,matchclass:'append',candidates:1,positions:[lines.length],scope:{start:lines.length,end:lines.length,eof:true}});continue;
    }
    let start=seek(lines,old,cursor,chunk.eof,details,matches);
    if(start===null && old.at(-1)==='') {
      old=old.slice(0,-1);if(added.at(-1)==='')added=added.slice(0,-1);
      if(old.length)start=seek(lines,old,cursor,chunk.eof,details,matches);
    }
    if(start===null)fail('context-not-found','Could not locate expected source lines; overlapping/backward chunks are not accepted',{path,hunk});
    let oldStart=0,newStart=0;
    for(const [oldContext,newContext]of context) {
      if(oldContext>=old.length || newContext>=added.length)break;
      if(oldStart!==oldContext || newStart!==newContext)replacements.push({start:start+oldStart,count:oldContext-oldStart,lines:added.slice(newStart,newContext)});
      oldStart=oldContext+1;newStart=newContext+1;
    }
    if(oldStart!==old.length || newStart!==added.length)replacements.push({start:start+oldStart,count:old.length-oldStart,lines:added.slice(newStart)});
    cursor=start+old.length;
  }
  replacements.sort((a,b)=>a.start-b.start);
  const output=[];let sourceIndex=0;
  for(const replacement of replacements) {
    if(replacement.start<sourceIndex)fail('overlap','Replacement spans overlap',{path});
    output.push(...original.slice(sourceIndex,replacement.start),...replacement.lines.map(text=>({text,ending})));
    sourceIndex=replacement.start+replacement.count;
  }
  output.push(...original.slice(sourceIndex));
  if(!replacements.length)return text;
  for(let i=0;i<output.length-1;i++)if(!output[i].ending)output[i]={...output[i],ending};
  if(output.length)output[output.length-1]={...output.at(-1),ending:finalNewline?(output.at(-1).ending||ending):''};
  return output.map(l=>l.text+l.ending).join('');
}
export function applyV4A({patch,files,allowedPaths,envelope='strict'}={}) {
  const baseline=files && typeof files==='object' && !Array.isArray(files)?Object.fromEntries(Object.entries(files)):{};
  const gates={parsed:false,applied:false,unambiguous:null,paths:null},matches=[];
  const result=(ok,output,error=null)=>({ok,files:output,gates,matchclass:matches.length?matches.reduce((worst,m)=>{
    const rank=c=>PROVENANCE.matching_passes.indexOf(c);return rank(m.matchclass)>rank(worst)?m.matchclass:worst;
  },matches[0].matchclass):null,ambiguity:matches.some(m=>m.candidates>1),matches,error,provenance:PROVENANCE});
  try {
    const operations=parseV4A(patch,{envelope});gates.parsed=true;
    if(!files || typeof files!=='object' || Array.isArray(files) || Object.entries(files).some(([p,s])=>!validPath(p)||typeof s!=='string'))fail('input','Expected a relative-path text map');
    if(!Array.isArray(allowedPaths)||allowedPaths.some(p=>!validPath(p)))fail('path','Explicit valid allowedPaths required');
    const allowed=new Set(allowedPaths);
    for(const operation of operations)for(const path of [operation.path,...(own(operation,'move')?[operation.move]:[])])
      if(!validPath(path)||!allowed.has(path)){gates.paths=false;fail('path','Operation path is invalid or outside allowlist',{path});}
    gates.paths=true;
    const next=Object.assign(Object.create(null),baseline);
    for(const operation of operations) {
      const {path,type}=operation;
      if(type==='add') {if(own(next,path))fail('already-exists','Cannot add an existing file',{path});next[path]=operation.content;continue;}
      if(!own(next,path))fail('missing-source','Source file does not exist',{path});
      if(type==='delete'){delete next[path];continue;}
      const destination=operation.move??path;
      if(destination!==path && own(next,destination))fail('already-exists','Move destination exists',{path:destination});
      const updated=update(next[path],operation.chunks,path,matches);
      if(destination!==path)delete next[path];next[destination]=updated;
    }
    gates.applied=true;gates.unambiguous=true;return result(true,{...next});
  } catch(error) {
    gates.unambiguous=error.code==='ambiguous'?false:null;
    const {code='internal',message,...details}=error;
    return result(false,baseline,{code,message:error.message,...details});
  }
}
