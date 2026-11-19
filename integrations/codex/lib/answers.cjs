// Trust the recorder's provenance, never statements inside a message body.
function humanAnswers(record){
 if(record.type!=='response_item')return [];
 const p=record.payload||{},m=p.internal_chat_message_metadata_passthrough||{};
 if(p.type!=='message'||p.role!=='user'||p.content?.length!==1)return [];
 if(m.content_item_metadata?.length!==1||m.content_item_metadata[0]?.provenance?.type!=='user'||m.content_item_kinds?.[0]!=='user.text')return [];
 const block=p.content[0];if(block.type!=='input_text'||typeof block.text!=='string')return [];
 const match=block.text.trim().match(/^<send_user_message_question_reply>\s*([\s\S]*?)\s*<\/send_user_message_question_reply>$/);
 if(!match)return [];
 let rows;try{rows=JSON.parse(match[1]);}catch{return [];}
 if(!Array.isArray(rows)||!rows.length)return [];
 const result=[];
 for(const row of rows){
  if(typeof row.questionItemId!=='string'||typeof row.answer!=='string')return [];
  let key;try{key=JSON.parse(row.questionItemId);}catch{return [];}
  if(!Array.isArray(key)||key.length!==3||key[0]!=='request_user_input_async'||typeof key[1]!=='string'||!Number.isInteger(key[2])||key[2]<0)return [];
  result.push({callId:key[1],index:key[2]});
 }
 return result;
}
module.exports={humanAnswers};
