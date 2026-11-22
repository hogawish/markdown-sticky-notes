// Small final-answer fallback; no model calls or general semantic parsing.
function finalChatWait(record){
 const p=record.payload||{};
 if(record.type!=='response_item'||p.type!=='message'||p.role!=='assistant'||p.status!=='completed'||p.phase!=='final_answer')return null;
 const id=p.internal_chat_message_metadata_passthrough?.turn_id||p.id;
 if(typeof id!=='string'||!id||id.length>160)return null;
 if(!Array.isArray(p.content)||!p.content.length||p.content.some(c=>c.type!=='output_text'||typeof c.text!=='string'))return null;
 const text=p.content.map(c=>c.text).join('\n');
 let fence=null;const lines=[];
 for(const line of text.split(/\r?\n/)){
  const mark=line.match(/^\s*(`{3,}|~{3,})/);
  if(mark){if(!fence)fence={char:mark[1][0],length:mark[1].length};else if(mark[1][0]===fence.char&&mark[1].length>=fence.length)fence=null;continue;}
  if(fence||/^\s*>/.test(line)||/^(?: {4}|\t)/.test(line))continue;
  const clean=line.replace(/`+[^`]*`+/g,'').replace(/「[^」]*」|『[^』]*』|“[^”]*”|"[^"]*"/g,'').replace(/\[[^\]]*\]\([^)]*\)/g,'').replace(/(?:https?|codex|claude):\/\/\S+/g,'').replace(/^[\s#*_-]+|[\s*_`]+$/g,'').trim();
  if(clean)lines.push({text:clean,option:/^\s*(?:[-+*]|\d+[.)])\s+/.test(line)});
 }
 const last=lines.at(-1)?.text||'';
 const endsInQuestion=line=>/[?？][\s）)\]]*$/.test(line);
 let optionStart=lines.length;
 while(optionStart>0&&lines[optionStart-1].option)optionStart--;
 const lead=lines.length-optionStart>=2?lines[optionStart-1]?.text:'';
 const question=endsInQuestion(last)?last:lead&&endsInQuestion(lead)?lead:null;
 const explicit=/(?:返事|返信|回答|判断|承認)(?:を|の)?(?:お願いします|お願い(?:するね|します)|お待ち(?:しています|してます)|待(?:っています|ってます|ってるよ|っているよ|ってるね|ってる))[^。.!！?？]*[。.!！]?$/u.test(last);
 const awaitingPermission=/(?:このチャットでの)?送信許可を確認中です[。.]?$/u.test(last);
 if(!question&&!explicit&&!awaitingPermission)return null;
 return {key:'chat-'+id,turn:id,reason:(question||last).slice(0,150)};
}
function isHumanChatReply(record){
 if(record.type!=='response_item')return false;
 const p=record.payload||{},m=p.internal_chat_message_metadata_passthrough||{};
 if(p.type!=='message'||p.role!=='user'||!Array.isArray(p.content)||p.content.length!==1)return false;
 if(m.content_item_kinds?.length!==1||m.content_item_kinds[0]!=='user.text'||m.content_item_metadata?.length!==1||m.content_item_metadata[0]?.provenance?.type!=='user')return false;
 const block=p.content[0];
 return block.type==='input_text'&&typeof block.text==='string'&&!!block.text.trim()&&!/^\s*<codex_delegation\b/.test(block.text);
}
module.exports={finalChatWait,isHumanChatReply};
