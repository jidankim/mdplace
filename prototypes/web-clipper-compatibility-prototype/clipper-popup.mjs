import {evaluate} from './cdp.mjs';

const wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

export async function reloadPopup(popup) {
  const generation = `${Date.now()}-${Math.random()}`;
  await evaluate(popup, `window.__mdplaceReloadGeneration=${JSON.stringify(generation)}`);
  await popup.send('Page.reload');
  for (let attempt = 0; attempt < 240; attempt += 1) {
    try {
      const ready = await evaluate(popup, `(()=>{
        if(window.__mdplaceReloadGeneration===${JSON.stringify(generation)})return false;
        const field=document.getElementById('note-content-field');
        const error=document.querySelector('.error-message')?.textContent?.trim();
        return Boolean((field&&field.value)||error);
      })()`);
      if (ready) return;
    } catch (error) {
      if (!/context|navigat/i.test(error.message)) throw error;
    }
    await wait(50);
  }
  throw new Error('Web Clipper popup reload timed out');
}

export async function selectTemplate(popup, name) {
  const expectation = new Map([
    ['mdplace Capture Candidate v1 — URL withheld',{
      captureTemplate:'mdplace-web-clipper-candidate-url-withheld',
      marker:'<!-- mdplace:candidate:source-url:withheld-by-policy -->',
    }],
    ['mdplace Capture Candidate v1 — protected local URL',{
      captureTemplate:'mdplace-web-clipper-candidate-url-retained',
      marker:'<!-- mdplace:candidate:source-url-raw:start -->',
    }],
  ]).get(name);
  if (!expectation) throw new Error(`unknown template: ${name}`);
  await evaluate(popup, `(async()=>{
    const select=document.getElementById('template-select');
    const option=[...select.options].find(candidate=>candidate.textContent===${JSON.stringify(name)});
    if(!option)throw new Error('template not found: '+${JSON.stringify(name)});
    const generation=Date.now()+'-'+Math.random();
    document.querySelectorAll('input[data-type]').forEach(input=>{
      input.dataset.mdplaceRenderGeneration=generation;
    });
    select.value=option.value;
    select.dispatchEvent(new Event('change',{bubbles:true}));
    const deadline=Date.now()+12000;
    while(Date.now()<deadline){
      const field=document.getElementById('note-content-field');
      const error=document.querySelector('.error-message')?.textContent?.trim();
      if(error)throw new Error(error);
      const inputs=[...document.querySelectorAll('input[data-type]')];
      const byId=new Map(inputs.map(input=>[input.id,input]));
      const generationReady=inputs.every(input=>input.dataset.mdplaceRenderGeneration!==generation);
      const expected=[
        ['mdplace_candidate_schema','text','mdplace.capture-candidate/v1'],
        ['capture_source','text','obsidian_web_clipper'],
        ['source_version_claim','text','1.7.0'],
        ['source_version_verified','checkbox',false],
        ['capture_template','text',${JSON.stringify(expectation.captureTemplate)}],
        ['capture_template_version','text','1'],
      ];
      const staticPropertiesReady=expected.every(([id,type,value])=>{
        const input=byId.get(id);
        if(!input||input.dataset.type!==type)return false;
        return type==='checkbox'?input.type==='checkbox'&&input.checked===value:input.value===value;
      });
      const timestamp=byId.get('source_captured_at_claim');
      const timestampReady=timestamp?.dataset.type==='datetime'&&
        /^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{3}(?:Z|[+-]\\d{2}:?\\d{2})$/.test(timestamp.value);
      if(inputs.length===7&&generationReady&&staticPropertiesReady&&timestampReady&&
        select.selectedOptions[0]?.textContent===${JSON.stringify(name)}&&
        field?.value.includes(${JSON.stringify(expectation.marker)}))return true;
      await new Promise(resolve=>setTimeout(resolve,50));
    }
    const snapshot=[...document.querySelectorAll('input[data-type]')].map(input=>({
      checked:input.checked,
      id:input.id,
      type:input.dataset.type,
      value:input.value,
    }));
    throw new Error('template render timed out: '+${JSON.stringify(name)}+' '+JSON.stringify({
      markerPresent:document.getElementById('note-content-field')?.value.includes(${JSON.stringify(expectation.marker)}),
      selectedTemplate:document.getElementById('template-select')?.selectedOptions[0]?.textContent,
      snapshot,
    }));
  })()`);
}

export async function capturePopupState(popup) {
  return evaluate(popup, `(async()=>{
    const error=document.querySelector('.error-message')?.textContent?.trim()||null;
    const note=document.getElementById('note-content-field')?.value||null;
    const noteName=document.getElementById('note-name-field')?.value||null;
    const path=document.getElementById('path-name-field')?.value||null;
    const template=document.getElementById('template-select')?.selectedOptions[0]?.textContent||null;
    const properties=[...document.querySelectorAll('input[data-type]')].map(input=>({
      name:input.id,
      type:input.getAttribute('data-type'),
      value:input.type==='checkbox'?input.checked:input.value,
    }));
    let candidate=null;
    if(note){
      window.__mdplaceCapturedClipboard=null;
      navigator.clipboard.writeText=async text=>{window.__mdplaceCapturedClipboard=text};
      document.getElementById('more-btn').click();
      const copy=[...document.querySelectorAll('.menu-item')].find(item=>item.innerText.includes('Copy to clipboard'));
      if(copy){
        copy.click();
        const deadline=Date.now()+2000;
        while(!window.__mdplaceCapturedClipboard&&Date.now()<deadline){
          await new Promise(resolve=>setTimeout(resolve,20));
        }
        candidate=window.__mdplaceCapturedClipboard;
      }
    }
    return {candidate,error,note,noteName,path,properties,template};
  })()`);
}
