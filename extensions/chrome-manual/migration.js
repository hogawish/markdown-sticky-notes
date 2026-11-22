const STORE_ID='gmddcmanllooimaoidnndbpblohcopip';
export const STORE_URL='https://chromewebstore.google.com/detail/'+STORE_ID;

export async function migrateToStore(api,{publishedConfirmed=false}={}) {
  if(!publishedConfirmed)throw Error('ストア公開を確認してから切り替えてください。');
  const self=await api.management.getSelf();
  if(self.id!==STORE_ID||self.installType!=='development')throw Error('この手動版だけが切り替え対象です。');
  // Chrome opens this URL after removing this extension. Do not remove another extension.
  await api.runtime.setUninstallURL(STORE_URL);
  try {await api.management.uninstallSelf({showConfirmDialog:true});}
  catch(error){await api.runtime.setUninstallURL('');throw error;}
}

async function init(){
  const $=id=>document.getElementById(id),button=$('migrate');
  $('store-link').href=STORE_URL;
  try{
    const self=await chrome.management.getSelf();
    const manual=self.id===STORE_ID&&self.installType==='development';
    $('edition').textContent=manual?'手動版を利用中です。今はそのまま使えます。':'この手動配布版からの切り替えは不要です。';
    $('manual').hidden=!manual;
    $('published').addEventListener('change',()=>{button.disabled=!$('published').checked;});
    button.addEventListener('click',async()=>{
      button.disabled=true;$('status').textContent='Chromeの確認画面で続けてください。';
      try{await migrateToStore(chrome,{publishedConfirmed:$('published').checked});}
      catch{$('status').textContent='切り替えを完了できませんでした。この手動版はそのまま使えます。';button.disabled=!$('published').checked;}
    });
  }catch{$('edition').textContent='拡張の設定画面から開き直してください。';}
}
if(typeof document!=='undefined')void init();
