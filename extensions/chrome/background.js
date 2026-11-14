const HOST = "io.github.hogawish.stickynotes";
let port;
let pending;
let queue = Promise.resolve();
const connected = new Set();
const connectedKeys = new Map();
const session = chrome.storage.session.get("session").then(async ({session}) => {
  if (session) return session;
  const next = crypto.randomUUID(); await chrome.storage.session.set({session:next}); return next;
});
function channel() {
  if (port) return port;
  const current = chrome.runtime.connectNative(HOST); port = current;
  current.onMessage.addListener(reply => {
    if(port!==current)return;
    if(reply.action==="activate"){void activateExistingTab(current,reply);return;}
    if(reply.action==="active-tab" || reply.action==="focused-tab"){void reportActiveTab(current,reply);return;}
    if (!pending) return;
    const {resolve,reject,timer}=pending; pending=null; clearTimeout(timer);
    reply.ok ? resolve(reply) : reject(Error(reply.error || "接続できません"));
  });
  current.onDisconnect.addListener(() => {
    const error=chrome.runtime.lastError?.message || "付箋との接続が切れました";
    if(port!==current)return;
    port=null;connected.clear();connectedKeys.clear();
    if(pending){clearTimeout(pending.timer);pending.reject(Error(error));pending=null;}
    chrome.action.setBadgeText({text:"!"}); chrome.action.setTitle({title:error+"。クリックして再接続"});
  });
  return current;
}
function send(event) {
  return new Promise((resolve,reject)=>{
    const current=channel();
    const timer=setTimeout(()=>{pending=null;current.disconnect();reject(Error("付箋の応答がありません"));},5000);
    pending={resolve,reject,timer};
    try{current.postMessage(event);}catch(error){clearTimeout(timer);pending=null;reject(error);}
  });
}
function enqueue(operation) {
  queue=queue.then(operation).catch(error=>{
    chrome.action.setBadgeText({text:"!"});chrome.action.setTitle({title:String(error.message)});
  });
}
async function event(type,windowId,tab) {
  return {type,session:await session,window:String(windowId),active_tab_query:true,focused_tab_query:true,tab:tab ? {id:String(tab.id),label:tab.title || `Chrome tab ${tab.id}`} : null};
}
export async function connectWindow(tab){
  const reply=await send(await event("pair",tab.windowId,tab)); connected.add(tab.windowId);connectedKeys.set(reply.key,tab.windowId);
  await chrome.action.setBadgeText({text:"✓"}); await chrome.action.setTitle({title:"付箋に接続済み。付箋の🔗でタブへのリンクを保存できます"});
}
chrome.action.onClicked.addListener(tab=>enqueue(()=>connectWindow(tab)));
chrome.tabs.onActivated.addListener(info=>enqueue(async()=>{
  if(!connected.has(info.windowId))return;
  const tab=await chrome.tabs.get(info.tabId);
  await send(await event("active",info.windowId,tab));
}));
chrome.tabs.onUpdated.addListener((id,change,tab)=>{
  if(tab.active && change.title)enqueue(async()=>{
    if(connected.has(tab.windowId))await send(await event("active",tab.windowId,tab));
  });
});
chrome.windows.onRemoved.addListener(windowId=>enqueue(async()=>{
  if(!connected.delete(windowId))return;
  // Existing links use session-scoped tab IDs and may outlive this window.
  await send(await event("close",windowId,null));
}));

async function reportActiveTab(current, command) {
  let result;
  try {
    const windowId = connectedKeys.get(command.key);
    if (windowId === undefined) throw Error("このChromeウィンドウを接続し直してください");
    const focused = command.action === "focused-tab";
    const destination = focused ? await chrome.windows.getLastFocused() : null;
    if (focused && (!destination?.focused || destination.type !== "normal")) {
      throw Error("Chromeの対象ウィンドウを前面にして選び直してください");
    }
    const [tab] = await chrome.tabs.query({windowId: destination?.id ?? windowId, active: true});
    if (!tab || !Number.isSafeInteger(tab.id)) throw Error("選択中のタブが見つかりません");
    result = {ok:true, tab:{id:String(tab.id),label:tab.title || `Chrome tab ${tab.id}`}};
  } catch (error) {
    result = {ok:false,error:String(error.message)};
  }
  if (port === current) current.postMessage({type:"result",request:command.request,...result});
}

async function activateExistingTab(current,command){
  let ok=false,error;
  try{
    if(!connectedKeys.has(command.key))throw Error('接続が変わりました。タブをリンクし直してください');
    const id=Number(command.tab);
    if(!Number.isSafeInteger(id))throw Error('タブのリンクが無効です');
    const tab=await chrome.tabs.get(id);
    await chrome.tabs.update(id,{active:true});
    await chrome.windows.update(tab.windowId,{focused:true});
    ok=true;
  }catch(e){error='リンクしたタブを開けません。閉じた場合はリンクし直してください: '+e.message;}
  if(port===current)current.postMessage({type:'result',request:command.request,ok,error});
}
