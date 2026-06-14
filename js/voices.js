import { S } from './state.js';
import { ITALIENNE_VOICE_ID } from './constants.js';
import { t, TTS_LANGS } from './i18n.js';
import { showToast } from './utils.js';

// ── Voice ID mapping (ElevenLabs account voices) ────────────────────
const ELEVEN_VOICE_IDS={
  // ElevenLabs account voices (user-provided mapping):
  // pBZ… Leonie (soothing, eloquent)
  // kwaj… Dmitry (clear, energetic)
  // qNk… Carter (rich, smooth, rugged)
  // u0T… Ghizlaine (smooth, distinctive, calm)
  // 4J31… Eduardo (Brazilian, clear, pro)
  serena:'pBZVCk298iJlHAcHQwLr',
  daniel:'kwajW3Xh5svCeKU5ky2S',
  rachel:'pBZVCk298iJlHAcHQwLr',
  antoni:'4J31DrhygVjvFsoj7BsM',
  bella:'u0TsaWvt0v8migutHM3M',
  adam:'4J31DrhygVjvFsoj7BsM',
  lily:'u0TsaWvt0v8migutHM3M',
  james:'qNkzaJoHLLdpvgh5tISm',
  charlotte:'pBZVCk298iJlHAcHQwLr',
  george:'kwajW3Xh5svCeKU5ky2S',
  dorothy:'u0TsaWvt0v8migutHM3M',
  glinda:'pBZVCk298iJlHAcHQwLr',
  domi:'u0TsaWvt0v8migutHM3M',
  edward:'goT3UYdM9bhm0n2lmKQx',
  camille_m:'hFgOzpmS0CMtL2to8sAl',
  john_doe:'EiNlNiXeDU1pqqOPrYMO',
  francesca:'LTdCOVuNg0GlsSue75IB',
  leo_kid:'1tDEBGOo8EqEPApM49eJ',
  isa:'h8eW5xfRUGVJrZhAFxqK',
  mitsuki:'gARvXPexe5VF3cKZBian',
  austin:'Bj9UqZbhQsanLzgalpEG',
  eliza:'bICR68fw9p7rUiAEAgn6',
  morgane:'ZYOBieLaunTiQrTrvNQq',
  elen:'TPIitICAZ8CqlGZ81AKm',
  antonio:'j22UF9K5KYGQ9ZWqYCA3',
  eda:'mBUB5zYuPwfVE6DTcEjf',
  ahmet:'ZsYcqahfiS2dy4J6XYC5',
  omar:'xvhpbk8otnNHtT3fjCpr',
  salma:'B5xxC4eQoOFJnY4R5XkI',
  sadie:'bD9maNcCuQQS75DGuteM',
  caty:'54Cze5LrTSyLgbO6Fhlc',
  lucy:'lcMyyd2HUfFzxdCaC4Ta',
  // Library voices (staging test)
  nova_f:'kdmDKE6EkgrWrrykO9Qt',
  nova_m:'mZ8K1MPRiT5wDQaasg3i',
  giulia_v2:'Dzlw1nIlAqiOOW6J7qo1',
};
const VOICE_ALIAS_GENDER={
  serena:'female',
  nova_f:'female',
  nova_m:'male',
  giulia_v2:'female',
  rachel:'female',
  bella:'female',
  lily:'female',
  charlotte:'female',
  dorothy:'female',
  glinda:'female',
  domi:'female',
  daniel:'male',
  antoni:'male',
  adam:'male',
  james:'male',
  george:'male',
  edward:'male',
  mitsuki:'female',
  austin:'male',
  eliza:'female',
  morgane:'female',
  elen:'female',
  antonio:'male',
  eda:'female',
  ahmet:'male',
  omar:'male',
  salma:'female',
  camille_m:'male',
  john_doe:'male',
  francesca:'female',
  leo_kid:'male',
  isa:'female',
  sadie:'female',
  caty:'female',
  lucy:'female',
};
const VOICE_LOCALES=[
  {id:'french',label:'Français 🇫🇷',languageCode:'fr',profiles:[
    {id:'fr-f',voice:'glinda',fallback:['nova_f','charlotte','francesca','eliza','elen'],label:'Léonie',tag:'Standard',gender:'female',languageCode:'fr-fr'},
    {id:'fr-m',voice:'nova_m',fallback:['james','camille_m','john_doe','austin'],label:'Lucas',tag:'Standard',gender:'male',languageCode:'fr-fr'},
    {id:'fr-sadie',voice:'sadie',fallback:['charlotte','francesca','eliza'],label:'Sadie',tag:'Calm & Gritty',gender:'female',languageCode:'fr-fr'},
  ]},
  {id:'english',label:'English 🇺🇸',languageCode:'en',profiles:[
    {id:'en-us-f',voice:'elen',fallback:['isa','francesca','eliza','charlotte'],label:'Taylor',tag:'US',gender:'female',languageCode:'en-us'},
    {id:'en-us-m',voice:'edward',fallback:['john_doe','camille_m','austin','james'],label:'Mason',tag:'US',gender:'male',languageCode:'en-us'},
    {id:'en-gb-m',voice:'austin',fallback:['john_doe','edward','camille_m','james'],label:'Oliver',tag:'UK',gender:'male',languageCode:'en-gb'},
    {id:'en-sadie',voice:'sadie',fallback:['elen','eliza','charlotte'],label:'Sadie',tag:'Calm & Gritty',gender:'female',languageCode:'en-us'},
    {id:'en-isla',voice:'isa',fallback:['eliza','elen','charlotte'],label:'Isla',tag:'Scottish',gender:'female',languageCode:'en-gb'},
    {id:'en-caty',voice:'caty',fallback:['elen','eliza','charlotte'],label:'Caty',tag:'Droll & Dry',gender:'female',languageCode:'en-us'},
    {id:'en-lucy',voice:'lucy',fallback:['elen','eliza','charlotte'],label:'Lucy',tag:'UK - Fresh & Casual',gender:'female',languageCode:'en-us'},
  ]},
  {id:'spanish',label:'Español 🇪🇸',languageCode:'es',profiles:[
    {id:'es-f',voice:'charlotte',fallback:['eliza','salma'],label:'Valentina',tag:'Standard',gender:'female',languageCode:'es-es'},
    {id:'es-m',voice:'antonio',fallback:['austin','james'],label:'Diego',tag:'Standard',gender:'male',languageCode:'es-es'},
  ]},
  {id:'german',label:'Deutsch 🇩🇪',languageCode:'de',profiles:[
    {id:'de-f',voice:'eliza',fallback:['elen','charlotte'],label:'Hannah',tag:'Standard',gender:'female',languageCode:'de-de'},
    {id:'de-m',voice:'edward',fallback:['austin','daniel'],label:'Emil',tag:'Standard',gender:'male',languageCode:'de-de'},
  ]},
  {id:'italian',label:'Italiano 🇮🇹',languageCode:'it',profiles:[
    {id:'it-f',voice:'giulia_v2',fallback:['nova_f','elen','eliza','charlotte'],label:'Giulia',tag:'Standard',gender:'female',languageCode:'it-it'},
    {id:'it-m',voice:'nova_m',fallback:['antoni','antonio','james'],label:'Leonardo',tag:'Standard',gender:'male',languageCode:'it-it'},
  ]},
  {id:'portuguese',label:'Português 🇵🇹',languageCode:'pt',profiles:[
    {id:'pt-f',voice:'eda',fallback:['charlotte','eliza'],label:'Beatriz',tag:'Standard',gender:'female',languageCode:'pt-pt'},
    {id:'pt-m',voice:'antonio',fallback:['austin','edward'],label:'João',tag:'Standard',gender:'male',languageCode:'pt-pt'},
  ]},
  {id:'arabic',label:'Arabic 🇸🇦',languageCode:'ar',profiles:[
    {id:'ar-f',voice:'salma',fallback:['eda','charlotte'],label:'Nour',tag:'Standard',gender:'female',languageCode:'ar'},
    {id:'ar-m',voice:'omar',fallback:['ahmet','austin'],label:'Karim',tag:'Standard',gender:'male',languageCode:'ar'},
  ]},
  {id:'chinese',label:'中文 🇨🇳',languageCode:'zh',profiles:[
    {id:'zh-f',voice:'charlotte',fallback:['elen','eliza'],label:'Mei',tag:'Mandarin',gender:'female',languageCode:'zh-cn'},
    {id:'zh-m',voice:'austin',fallback:['james','antoni'],label:'Wei',tag:'Mandarin',gender:'male',languageCode:'zh-cn'},
  ]},
  {id:'japanese',label:'日本語 🇯🇵',languageCode:'ja',profiles:[
    {id:'ja-f',voice:'mitsuki',fallback:['elen','eliza'],label:'Yui',tag:'Standard',gender:'female',languageCode:'ja-jp'},
    {id:'ja-m',voice:'james',fallback:['edward','austin'],label:'Haruto',tag:'Standard',gender:'male',languageCode:'ja-jp'},
  ]},
  {id:'korean',label:'한국어 🇰🇷',languageCode:'ko',profiles:[
    {id:'ko-f',voice:'charlotte',fallback:['francesca','elen','isa'],label:'Minji',tag:'Standard',gender:'female',languageCode:'ko-kr'},
    {id:'ko-m',voice:'camille_m',fallback:['john_doe','edward','austin'],label:'Junho',tag:'Standard',gender:'male',languageCode:'ko-kr'},
  ]},
  {id:'turkish',label:'Türkçe 🇹🇷',languageCode:'tr',profiles:[
    {id:'tr-f',voice:'eda',fallback:['salma','charlotte'],label:'Defne',tag:'Standard',gender:'female',languageCode:'tr-tr'},
    {id:'tr-m',voice:'ahmet',fallback:['omar','austin'],label:'Emir',tag:'Standard',gender:'male',languageCode:'tr-tr'},
  ]},
  {id:'russian',label:'Русский 🇷🇺',languageCode:'ru',profiles:[
    {id:'ru-f',voice:'elen',fallback:['eliza','charlotte'],label:'Alina',tag:'Standard',gender:'female',languageCode:'ru-ru'},
    {id:'ru-m',voice:'daniel',fallback:['edward','austin'],label:'Nikita',tag:'Standard',gender:'male',languageCode:'ru-ru'},
  ]},
  {id:'hindi',label:'Hindi 🇮🇳',languageCode:'hi',profiles:[
    {id:'hi-f',voice:'salma',fallback:['eda','charlotte'],label:'Ananya',tag:'Standard',gender:'female',languageCode:'hi-in'},
    {id:'hi-m',voice:'antoni',fallback:['omar','austin'],label:'Rohan',tag:'Standard',gender:'male',languageCode:'hi-in'},
  ]},
];

const EMOTION_PRESETS={
  neutral:{label:'Neutre',pitch:1,rate:1,playbackRate:1},
  excited:{label:'Excité',pitch:1.1,rate:1.08,playbackRate:1.06},
  sad:{label:'Triste',pitch:0.84,rate:0.82,playbackRate:0.82},
  angry:{label:'En colère',pitch:0.94,rate:1.12,playbackRate:1.08},
  whisper:{label:'Chuchoté',pitch:1.28,rate:0.72,playbackRate:0.72},
};
const SPEED_MIN=0;
const SPEED_MAX=7;
const SPEED_DEFAULT=4;
function sliderToElevenLabs(v){return 0.7+(Math.min(7,Math.max(0,v))/7)*0.5;}
const PREVIEW_TEXT_BY_LANG={
  fr:'Bonjour, je suis {name}.',
  en:'Hello, I am {name}.',
  es:'Hola, soy {name}.',
  pt:'Ola, eu sou {name}.',
  it:'Ciao, sono {name}.',
  de:'Hallo, ich bin {name}.',
  ar:'Marhaban, ana {name}.',
  hi:'Namaste, main {name} hoon.',
  zh:'Ni hao, wo shi {name}.',
  ja:'Konnichiwa, watashi wa {name} desu.',
  ko:'Annyeong, jeoneun {name} imnida.',
  tr:'Merhaba, ben {name}.',
  ru:'Privet, ya {name}.',
};

// ── Voice helpers ───────────────────────────────────────────────────
function resolveVoiceId(id){
  return ELEVEN_VOICE_IDS[id]||ELEVEN_VOICE_IDS.serena;
}
function getLocaleConfig(localeId){
  return VOICE_LOCALES.find(l=>l.id===localeId)||VOICE_LOCALES[0];
}
function getCurrentLanguageCode(){
  return getLocaleConfig(S.selectedLocale).languageCode||'en';
}
function getPreviewTextForVoice(voice){
  const lang=((voice&&voice.languageCode)||getCurrentLanguageCode()||'en').toLowerCase();
  const base=lang.split('-')[0];
  const tpl=PREVIEW_TEXT_BY_LANG[lang]||PREVIEW_TEXT_BY_LANG[base]||PREVIEW_TEXT_BY_LANG.en;
  return tpl.replace('{name}',voice&&voice.label?voice.label:'voice');
}
function getAliasGender(alias){
  return VOICE_ALIAS_GENDER[String(alias||'').toLowerCase()]||'';
}

// ── Preset builder ──────────────────────────────────────────────────
function buildVoicePresetsFromLocale(localeId){
  const locale=getLocaleConfig(localeId);
  return (locale.profiles||[]).map((p,idx)=>{
    const preferredGender=p.gender||'neutral';
    let primaryAlias=p.voice;
    const primaryAliasGender=getAliasGender(primaryAlias);
    if(preferredGender!=='neutral'&&primaryAliasGender&&primaryAliasGender!==preferredGender){
      const replacement=(p.fallback||[]).find(a=>getAliasGender(a)===preferredGender);
      if(replacement)primaryAlias=replacement;
    }
    const originalFallback=p.fallback||[];
    const genderSafeFallback=originalFallback.filter(a=>{
      const aliasGender=getAliasGender(a);
      if(!aliasGender||preferredGender==='neutral')return true;
      return aliasGender===preferredGender;
    });
    const fallbackAliases=(genderSafeFallback.length?genderSafeFallback:originalFallback).filter(a=>a&&a!==primaryAlias);
    const primaryVoiceId=resolveVoiceId(primaryAlias);
    const fallbackVoiceIds=fallbackAliases
      .map(resolveVoiceId)
      .filter((id,pos,arr)=>id&&id!==primaryVoiceId&&arr.indexOf(id)===pos);
    return{
      id:`${locale.id}-${p.id||idx}`,
      label:p.label,
      tag:p.tag,
      voiceId:primaryVoiceId,
      fallbackVoiceIds,
      modelId:'eleven_multilingual_v2',
      languageCode:p.languageCode||locale.languageCode||'en',
      gender:preferredGender,
      pitch:1,
      rate:1,
    };
  });
}

// ── Country / locale select ─────────────────────────────────────────
function initVoiceCountrySelect(){
  const select=document.getElementById('voiceCountrySelect');
  if(!select)return;
  select.innerHTML='';
  const pool=S.lockedVoiceLocale?VOICE_LOCALES.filter(l=>l.id===S.lockedVoiceLocale):VOICE_LOCALES.slice();
  const sortedLocales=pool.sort((a,b)=>a.label.localeCompare(b.label,'en',{sensitivity:'base'}));
  sortedLocales.forEach(l=>{
    const opt=document.createElement('option');
    opt.value=l.id;
    opt.textContent=l.label;
    if(l.id===S.selectedLocale)opt.selected=true;
    select.appendChild(opt);
  });
}
function applyLocaleVoices(localeId,silent,preferredVoiceId){
  S.selectedLocale=getLocaleConfig(localeId).id;
  S.VOICE_PRESETS=buildVoicePresetsFromLocale(S.selectedLocale);
  const targetVoiceId=preferredVoiceId||(S.selectedVoice&&S.selectedVoice.id);
  S.selectedVoice=S.VOICE_PRESETS.find(v=>v.id===targetVoiceId)||S.VOICE_PRESETS[0]||null;
  const select=document.getElementById('voiceCountrySelect');
  if(select)select.value=S.selectedLocale;
  initVoiceGrid();
  if(document.getElementById('session').classList.contains('active'))populateSessionVoiceSelect();
  if(!silent)showToast(t('toastAccent')+': '+getLocaleConfig(S.selectedLocale).label);
}
function changeVoiceCountry(localeId){
  applyLocaleVoices(localeId,false);
  window.persistSettings();
}

// ── Web Speech API voice matching (fallback) ────────────────────────
function loadVoices(){S.availableVoices=speechSynthesis.getVoices();S.presetVoiceMap={};}
speechSynthesis.onvoiceschanged=loadVoices;

function normalizeLang(code){
  return String(code||'').toLowerCase().replace('_','-');
}
function voiceNameHints(name){
  const n=String(name||'').toLowerCase();
  return{
    female:/female|woman|fem|zira|samantha|victoria|karen|joanna|emma|susan|aria|lily|siri/i.test(n),
    male:/male|man|masc|david|mark|george|james|daniel|alex|thomas|fred|paul/i.test(n),
  };
}
function scoreVoiceForPreset(v,p){
  const vLang=normalizeLang(v.lang);
  const pLang=normalizeLang(p&&p.languageCode);
  const baseLang=pLang.split('-')[0];
  const region=pLang.includes('-')?pLang.split('-')[1]:'';
  let score=0;
  if(baseLang&&vLang.startsWith(baseLang))score+=120;
  if(pLang&&vLang===pLang)score+=60;
  if(region&&vLang.includes('-'+region))score+=30;
  if(v.localService)score+=10;
  const hints=voiceNameHints(v.name||'');
  const wantGender=p&&p.gender;
  if(wantGender==='female'&&hints.female)score+=50;
  if(wantGender==='male'&&hints.male)score+=50;
  if(wantGender==='female'&&hints.male)score-=40;
  if(wantGender==='male'&&hints.female)score-=40;
  return score;
}
function getFilteredVoices(preset){
  if(!S.availableVoices.length)S.availableVoices=speechSynthesis.getVoices();
  const pLang=normalizeLang(preset&&preset.languageCode);
  const baseLang=pLang.split('-')[0];
  let filtered=S.availableVoices.filter(v=>TTS_LANGS.some(code=>(v.lang||'').toLowerCase().startsWith(code)));
  if(baseLang){
    const langOnly=filtered.filter(v=>normalizeLang(v.lang).startsWith(baseLang));
    if(langOnly.length)filtered=langOnly;
  }
  const pool=(filtered.length?filtered:S.availableVoices).slice();
  pool.sort((a,b)=>scoreVoiceForPreset(b,preset)-scoreVoiceForPreset(a,preset)||(a.name||'').localeCompare(b.name||''));
  return pool;
}
function buildVoiceMap(){
  const map={};
  S.VOICE_PRESETS.forEach((p)=>{
    const pool=getFilteredVoices(p);
    const pick=pool[0]||S.availableVoices[0]||null;
    map[p.id]=pick?pick.voiceURI:null;
  });
  S.presetVoiceMap=map;
}
function findVoiceByURI(voiceURI){
  if(!voiceURI)return null;
  if(!S.availableVoices.length)S.availableVoices=speechSynthesis.getVoices();
  return S.availableVoices.find(v=>v.voiceURI===voiceURI)||null;
}
function getBestVoice(p){
  if(!S.availableVoices.length)S.availableVoices=speechSynthesis.getVoices();
  if(!S.presetVoiceMap[p.id])buildVoiceMap();
  const exact=findVoiceByURI(S.presetVoiceMap[p.id]);
  if(exact)return exact;
  return getFilteredVoices(p)[0]||S.availableVoices[0]||null;
}

// ── Emotion / speed ─────────────────────────────────────────────────
function getEmotionSettings(){return EMOTION_PRESETS[S.selectedEmotion]||EMOTION_PRESETS.neutral;}
function getCurrentVoiceSpeed(){
  var safe=Math.max(SPEED_MIN,Math.min(SPEED_MAX,Number(S.voiceSpeed)||SPEED_DEFAULT));
  S.voiceSpeed=safe;
  return sliderToElevenLabs(S.voiceSpeed);
}
function getSpeechStyle(v){
  const base=v||S.VOICE_PRESETS[0];
  const emo=getEmotionSettings();
  const speed=getCurrentVoiceSpeed();
  return{
    pitch:(base.pitch||1)*emo.pitch,
    rate:(base.rate||1)*(speed||1),
    playbackRate:(emo.playbackRate||1)*(speed||1),
    volume:S.selectedEmotion==='whisper'?0.58:S.selectedEmotion==='sad'?0.9:1,
  };
}
function setEmotion(key,silent){
  if(!window.hasPaidAccess()&&key!=='neutral'){
    S.selectedEmotion='neutral';
    const emo=document.getElementById('emotionSelect');
    if(emo)emo.value='neutral';
    window.openPaywallModal(t('paywallSub'));
    return;
  }
  S.selectedEmotion=EMOTION_PRESETS[key]?key:'neutral';
  if(!silent)showToast(t('toastEmotion')+': '+EMOTION_PRESETS[S.selectedEmotion].label);
  window.persistSettings();
}
function setVoiceSpeed(value,silent){
  var parsed=Number(value);
  S.voiceSpeed=Math.max(SPEED_MIN,Math.min(SPEED_MAX,Number.isFinite(parsed)?parsed:SPEED_DEFAULT));
  window.persistSettings();
  renderAllSpeedSliders();
}
function internalSpeedToDisplay(v){
  if(v<=4.5)return 0.5+(v/4.5)*0.5;
  return 1.0+((v-4.5)/2.5)*1.0;
}
function formatDisplaySpeed(v){var d=internalSpeedToDisplay(v);return d<1?d.toFixed(1)+'x':d.toFixed(1)+'x'}
function renderSpeedSlider(containerId,compact){
  var g=document.getElementById(containerId);
  if(!g)return;
  g.innerHTML='';
  var slider=document.createElement('input');
  slider.type='range';slider.min='0';slider.max='7';slider.step='0.5';
  slider.value=String(S.voiceSpeed);
  slider.className='speed-slider';
  slider.style.cssText='width:100%;accent-color:#FF3B30;cursor:pointer';
  var val=document.createElement('div');
  val.className='ps-slider-value';
  val.textContent=formatDisplaySpeed(S.voiceSpeed);
  if(compact){val.style.cssText='font-size:.65rem;font-weight:700;color:#C8CED0;text-align:center;margin-top:2px'}
  slider.oninput=function(){var v=parseFloat(this.value);val.textContent=formatDisplaySpeed(v);setVoiceSpeed(v,true)};
  g.appendChild(slider);
  g.appendChild(val);
}
function renderAllSpeedSliders(){
  renderSpeedSlider('speedBtnsSession',true);
  renderSpeedSlider('speedBtnsOverlay',true);
  renderSpeedTriBtns('voiceSpeedTriPause');
  renderSpeedTriBtns('speedTriTake');
}

/** Three-button AI voice speed control: Slow/Normal/Fast → 0.5x/1x/2x.
    The prompter follows the voice, so this is THE speed control —
    line gaps and monologue pacing derive from it automatically. */
function renderSpeedTriBtns(containerId){
  var g=document.getElementById(containerId);
  if(!g)return;
  var opts=[
    {key:0,label:t('paceSlow'),active:S.voiceSpeed<2},
    {key:4.5,label:t('paceNormal'),active:S.voiceSpeed>=2&&S.voiceSpeed<6},
    {key:7,label:t('paceFast'),active:S.voiceSpeed>=6},
  ];
  g.innerHTML='';
  g.classList.add('speed-tri');
  opts.forEach(function(o){
    var b=document.createElement('button');
    b.type='button';
    b.className='speed-tri-btn'+(o.active?' selected':'');
    b.textContent=o.label;
    b.onclick=function(){setVoiceSpeed(o.key,true);};
    g.appendChild(b);
  });
}

// ── Voice grid / session select ─────────────────────────────────────
function initVoiceGrid(){
  const g=document.getElementById('voiceGrid');g.innerHTML='';
  if(!S.selectedVoice)S.selectedVoice=S.VOICE_PRESETS[0]||null;
  const isCine=!!g.closest('.cine-screen');
  S.VOICE_PRESETS.forEach(v=>{
    const el=document.createElement('div');el.className='voice-item'+(S.selectedVoice&&S.selectedVoice.id===v.id?' selected':'');
    if(isCine){
      el.innerHTML=`<div class="voice-wave"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><path d="M4 12h2m3-4v8m3-10v12m3-8v4m3-6v8m2-4h0"/></svg></div><div class="voice-info"><span class="voice-name">${v.label}</span><span class="vtag">${v.tag}</span></div><div class="voice-check"><svg viewBox="0 0 24 24"><path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41L9 16.17z"/></svg></div>`;
    }else{
      el.innerHTML=`${v.label}<span class="vtag">${v.tag}</span>`;
    }
    el.onclick=()=>{S.selectedVoice=v;g.querySelectorAll('.voice-item').forEach(x=>x.classList.remove('selected'));el.classList.add('selected');window.persistSettings();previewVoice(v)};
    g.appendChild(el);
  });
  if(!S.selectedVoice&&S.VOICE_PRESETS.length)S.selectedVoice=S.VOICE_PRESETS[0];
}

function previewVoice(v){
  // demoFree: plays the real ElevenLabs voice for free (server-capped) and
  // bypasses the "no speaking outside an active session" guard so previews
  // work on the voice-setup screen.
  window.aiSpeak(getPreviewTextForVoice(v),null,{speedOverride:sliderToElevenLabs(SPEED_DEFAULT),demoFree:true});
}

function populateSessionVoiceSelect(){
  const s=document.getElementById('sessionVoiceSelect');s.innerHTML='';
  S.VOICE_PRESETS.forEach(v=>{const o=document.createElement('option');o.value=v.id;o.textContent=v.label+' — '+v.tag;if(S.selectedVoice&&v.id===S.selectedVoice.id)o.selected=true;s.appendChild(o)});
}
function changeSessionVoice(){
  S.selectedVoice=S.VOICE_PRESETS.find(v=>v.id===document.getElementById('sessionVoiceSelect').value)||S.VOICE_PRESETS[0]||null;
  if(S.selectedVoice)showToast(t('toastVoice')+': '+S.selectedVoice.label);
  window.persistSettings();
}

// ── Named exports ───────────────────────────────────────────────────
export {
  ELEVEN_VOICE_IDS,
  VOICE_ALIAS_GENDER,
  VOICE_LOCALES,
  EMOTION_PRESETS,
  SPEED_MIN,
  SPEED_MAX,
  SPEED_DEFAULT,
  PREVIEW_TEXT_BY_LANG,
  sliderToElevenLabs,
  resolveVoiceId,
  getLocaleConfig,
  getCurrentLanguageCode,
  getPreviewTextForVoice,
  getAliasGender,
  buildVoicePresetsFromLocale,
  initVoiceCountrySelect,
  applyLocaleVoices,
  changeVoiceCountry,
  loadVoices,
  normalizeLang,
  voiceNameHints,
  scoreVoiceForPreset,
  getFilteredVoices,
  buildVoiceMap,
  findVoiceByURI,
  getBestVoice,
  getEmotionSettings,
  getCurrentVoiceSpeed,
  getSpeechStyle,
  setEmotion,
  setVoiceSpeed,
  internalSpeedToDisplay,
  formatDisplaySpeed,
  renderSpeedSlider,
  renderAllSpeedSliders,
  renderSpeedTriBtns,
  initVoiceGrid,
  previewVoice,
  populateSessionVoiceSelect,
  changeSessionVoice,
};
