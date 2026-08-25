/* =========================================================
   EsquizoGames — sistema de anúncios (autorais)
   =========================================================
   Como adicionar mais anúncios:
   - Vídeo do YouTube: { type:'youtube', src:'LINK_OU_ID_DO_VIDEO' }
   - Arquivo de vídeo (.mp4) hospedado no site: { type:'mp4', src:'assets/ads/seu-arquivo.mp4' }
     (coloque o arquivo .mp4 dentro da pasta assets/ads/)
   Campo opcional "durationSeconds": só é usado como um limite de segurança
   para anúncios do YouTube (fecha o anúncio automaticamente após esse tempo,
   caso a detecção de "vídeo terminou" do YouTube não dispare por algum motivo
   no navegador do usuário). Não precisa ser exato.
   ========================================================= */
const ADS_LIST = [
  { type:'youtube', src:'https://youtu.be/pZ0o6Rlm5U4?is=93hyyLzO_ucZPZHF', label:'Anúncio EsquizoGames 1', durationSeconds:180 },
  { type:'youtube', src:'https://youtu.be/JTE6NF3Iszg?is=CASE1SBOvXP7n6Zz', label:'Anúncio EsquizoGames 2', durationSeconds:180 },
  { type:'mp4', src:'assets/ads/vitor_e_thigas_baby_shark.mp4', label:'Vitor e Thiago — Baby Shark' },
];

const AD_SKIP_AFTER_SECONDS = 5;
const AD_BOTTOM_INTERVAL_MS = 5 * 60 * 1000; // 5 minutos

/* ---------- utilidades ---------- */
function adExtractYouTubeId(url){
  const m = String(url).match(/(?:youtu\.be\/|[?&]v=|embed\/)([A-Za-z0-9_-]{6,})/);
  return m ? m[1] : url;
}
function adPickRandom(excludeIndex){
  if(!ADS_LIST.length) return null;
  if(ADS_LIST.length === 1) return { ad: ADS_LIST[0], index: 0 };
  let i;
  do { i = Math.floor(Math.random() * ADS_LIST.length); } while(i === excludeIndex);
  return { ad: ADS_LIST[i], index: i };
}

/* ---------- carregamento preguiçoso da YouTube IFrame API ---------- */
let _ytApiPromise = null;
function loadYouTubeAPI(){
  if(window.YT && window.YT.Player) return Promise.resolve();
  if(_ytApiPromise) return _ytApiPromise;
  _ytApiPromise = new Promise(resolve => {
    const prevCallback = window.onYouTubeIframeAPIReady;
    window.onYouTubeIframeAPIReady = function(){
      if(typeof prevCallback === 'function') prevCallback();
      resolve();
    };
    const tag = document.createElement('script');
    tag.src = 'https://www.youtube.com/iframe_api';
    document.head.appendChild(tag);
  });
  return _ytApiPromise;
}

/* ---------- mensagens de erro do player do YouTube (para log e para o botão de fallback) ----------
   2   = ID de vídeo inválido
   5   = erro do player em HTML5
   100 = vídeo não encontrado (removido ou privado)
   101/150 = o dono do vídeo desativou a reprodução em outros sites (embedding desligado) */
function ytErrorMessage(code){
  if(code === 101 || code === 150) return 'o dono do vídeo desativou a reprodução fora do YouTube (embedding desligado) para este vídeo.';
  if(code === 100) return 'vídeo não encontrado — pode ter sido removido ou estar como privado (precisa ser "não listado" ou "público" pra funcionar como anúncio).';
  if(code === 2) return 'o link/ID do vídeo do anúncio está inválido.';
  return 'erro ao carregar o player do YouTube (código ' + code + ').';
}

/* ---------- renderiza um anúncio dentro de um container e avisa quando termina ---------- */
function renderAdMedia(ad, container, onEnded){
  container.innerHTML = '';
  if(ad.type === 'mp4'){
    const video = document.createElement('video');
    video.src = ad.src;
    video.autoplay = true;
    video.controls = true;
    video.muted = true; // necessário para autoplay confiável nos navegadores
    video.playsInline = true;
    video.addEventListener('ended', onEnded);
    container.appendChild(video);
    return { stop(){ video.pause(); } };
  }
  // youtube
  const videoId = adExtractYouTubeId(ad.src);
  const wrap = document.createElement('div');
  const uid = 'ytad_' + Math.random().toString(36).slice(2);
  wrap.id = uid;
  container.appendChild(wrap);
  let ended = false;
  let fallbackTimer = null;

  function showBrokenAdFallback(reason){
    // se o vídeo não conseguir tocar (embedding desligado, vídeo removido, etc.),
    // mostra um aviso com um link direto pro YouTube em vez de deixar a tela travada/preta
    if(!document.getElementById(uid) && !container.querySelector('.ad-broken')) return;
    console.warn('[EsquizoGames ads] Anúncio do YouTube "' + (ad.label||ad.src) + '" não tocou: ' + reason);
    container.innerHTML = `
      <div class="ad-broken">
        <p>Não foi possível carregar este anúncio.</p>
        <a href="https://www.youtube.com/watch?v=${videoId}" target="_blank" rel="noopener">Assistir no YouTube ›</a>
      </div>`;
    // fecha sozinho depois de um tempinho pra não travar quem tá navegando
    setTimeout(() => { if(!ended){ ended = true; onEnded(); } }, 4000);
  }

  loadYouTubeAPI().then(() => {
    if(!document.getElementById(uid)) return; // já foi fechado
    // o parâmetro "origin" só pode ir quando a página está em http/https — em file://
    // (abrindo o index.html direto, sem servidor) window.location.origin vem como a
    // string "null", que o YouTube rejeita com "Erro 153". Por isso só mandamos quando
    // é uma origem http(s) válida.
    const playerVars = { autoplay:1, mute:1, controls:1, rel:0, modestbranding:1, playsinline:1 };
    if(/^https?:$/.test(window.location.protocol)) playerVars.origin = window.location.origin;
    new YT.Player(uid, {
      videoId,
      host: 'https://www.youtube-nocookie.com', // modo com privacidade reforçada
      playerVars,
      events: {
        onStateChange: (e) => {
          if(e.data === YT.PlayerState.ENDED && !ended){
            ended = true;
            if(fallbackTimer) clearTimeout(fallbackTimer);
            onEnded();
          }
        },
        onError: (e) => {
          if(ended) return;
          showBrokenAdFallback(ytErrorMessage(e.data));
        }
      }
    });
  }).catch(() => showBrokenAdFallback('a API do player do YouTube não carregou (sem internet ou bloqueada pelo navegador).'));

  // rede de segurança: se por algum motivo o evento "terminou" do YouTube não disparar
  // (bloqueadores de terceiros, etc), fecha o anúncio depois de durationSeconds
  if(ad.durationSeconds){
    fallbackTimer = setTimeout(() => { if(!ended){ ended = true; onEnded(); } }, ad.durationSeconds * 1000);
  }
  return { stop(){ ended = true; if(fallbackTimer) clearTimeout(fallbackTimer); } };
}

/* ================= ANÚNCIO DE ENTRADA (TELA CHEIA) ================= */
let _gateAdHandle = null;
function initGateAd(){
  if(!ADS_LIST.length) { scheduleBottomAd(); return; }
  const picked = adPickRandom();
  const overlay = document.getElementById('ad-gate');
  const mediaWrap = document.getElementById('ad-gate-media');
  const skipBtn = document.getElementById('ad-gate-skip');
  if(!overlay || !mediaWrap || !skipBtn) return;

  overlay.classList.add('open');
  document.body.style.overflow = 'hidden';

  const finish = () => closeGateAd();
  _gateAdHandle = renderAdMedia(picked.ad, mediaWrap, finish);

  let remaining = AD_SKIP_AFTER_SECONDS;
  skipBtn.disabled = true;
  skipBtn.textContent = `Pular em ${remaining}s`;
  const timer = setInterval(() => {
    remaining--;
    if(remaining <= 0){
      clearInterval(timer);
      skipBtn.disabled = false;
      skipBtn.textContent = 'Pular anúncio ›';
    } else {
      skipBtn.textContent = `Pular em ${remaining}s`;
    }
  }, 1000);
  skipBtn.onclick = () => { if(!skipBtn.disabled) finish(); };
}
function closeGateAd(){
  const overlay = document.getElementById('ad-gate');
  if(!overlay) return;
  overlay.classList.remove('open');
  document.getElementById('ad-gate-media').innerHTML = '';
  document.body.style.overflow = '';
  if(_gateAdHandle) { _gateAdHandle.stop(); _gateAdHandle = null; }
  scheduleBottomAd();
}

/* ================= ANÚNCIO ROTATIVO (RODAPÉ) ================= */
let _bottomAdHandle = null;
let _bottomAdTimer = null;
let _bottomAdOpen = false;
let _lastBottomAdIndex = -1;

function scheduleBottomAd(){
  if(_bottomAdTimer) clearTimeout(_bottomAdTimer);
  if(!ADS_LIST.length) return;
  _bottomAdTimer = setTimeout(showBottomAd, AD_BOTTOM_INTERVAL_MS);
}
function showBottomAd(){
  if(_bottomAdOpen){ scheduleBottomAd(); return; } // já tem um aberto, tenta de novo no próximo ciclo
  const gate = document.getElementById('ad-gate');
  if(gate && gate.classList.contains('open')){ scheduleBottomAd(); return; } // não sobrepõe o anúncio de entrada

  const picked = adPickRandom(_lastBottomAdIndex);
  if(!picked) return;
  _lastBottomAdIndex = picked.index;

  const panel = document.getElementById('ad-bottom');
  const mediaWrap = document.getElementById('ad-bottom-media');
  const skipBtn = document.getElementById('ad-bottom-skip');
  const closeBtn = document.getElementById('ad-bottom-close');
  if(!panel || !mediaWrap || !skipBtn) return;

  _bottomAdOpen = true;
  panel.classList.add('open');

  const finish = () => closeBottomAd();
  _bottomAdHandle = renderAdMedia(picked.ad, mediaWrap, finish);
  closeBtn.onclick = finish; // fechar manualmente conta como "pular" após liberado

  let remaining = AD_SKIP_AFTER_SECONDS;
  skipBtn.disabled = true;
  skipBtn.textContent = `Pular em ${remaining}s`;
  const timer = setInterval(() => {
    remaining--;
    if(remaining <= 0){
      clearInterval(timer);
      skipBtn.disabled = false;
      skipBtn.textContent = 'Pular ›';
    } else {
      skipBtn.textContent = `Pular em ${remaining}s`;
    }
  }, 1000);
  skipBtn.onclick = () => { if(!skipBtn.disabled) finish(); };
}
function closeBottomAd(){
  const panel = document.getElementById('ad-bottom');
  if(!panel) return;
  panel.classList.remove('open');
  document.getElementById('ad-bottom-media').innerHTML = '';
  if(_bottomAdHandle) { _bottomAdHandle.stop(); _bottomAdHandle = null; }
  _bottomAdOpen = false;
  scheduleBottomAd();
}
