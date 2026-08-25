
/* ---------- armazenamento (com fallback caso o localStorage esteja bloqueado) ---------- */
const DB = {
  _memory: {},
  _storageOK: (function(){
    try{
      const t = '__esz_test__';
      window.localStorage.setItem(t, '1');
      window.localStorage.removeItem(t);
      return true;
    }catch(e){ return false; }
  })(),
  get(key, fallback){
    try{
      if(DB._storageOK){
        const v = localStorage.getItem(key);
        return v ? JSON.parse(v) : fallback;
      }
      return Object.prototype.hasOwnProperty.call(DB._memory, key) ? JSON.parse(DB._memory[key]) : fallback;
    }catch(e){ return fallback; }
  },
  set(key, val){
    const json = JSON.stringify(val);
    try{
      if(DB._storageOK){ localStorage.setItem(key, json); return; }
    }catch(e){
      DB._storageOK = false; // navegador recusou o localStorage nesta sessão: passa a usar memória
    }
    DB._memory[key] = json; // fallback: guarda em memória para a sessão atual continuar funcionando
  }
};

const USERS_KEY = 'esz_users';
const SESSION_KEY = 'esz_session';
const FAV_PREFIX = 'esz_fav_';
const COMMENTS_PREFIX = 'esz_comments_';
const ENROLL_KEY = 'esz_enrollments';

function simpleHash(str){
  let h = 0;
  for(let i=0;i<str.length;i++){ h = (h*31 + str.charCodeAt(i)) >>> 0; }
  return h.toString(16);
}

/* ---------- hash seguro de senha (SHA-256 + salt único por usuário, via Web Crypto API) ----------
   simpleHash acima é só um checksum simples (herdado de contas antigas) e nunca deveria
   ter sido usado para senha — não tem salt e é fácil de reverter. Todo hash NOVO de senha
   (registro, "esqueci minha senha" e a troca de senha nas configurações) passa a usar isto.
   Contas antigas continuam entrando normalmente: no primeiro login com sucesso, a senha é
   automaticamente migrada para o hash seguro (ver verifyUserPassword). */
function genSalt(){
  const arr = new Uint8Array(16);
  (window.crypto || window.msCrypto).getRandomValues(arr);
  return Array.from(arr).map(b => b.toString(16).padStart(2,'0')).join('');
}
async function hashPasswordSecure(password, saltHex){
  try{
    const enc = new TextEncoder();
    const data = enc.encode(saltHex + ':' + password);
    const digest = await crypto.subtle.digest('SHA-256', data);
    return Array.from(new Uint8Array(digest)).map(b => b.toString(16).padStart(2,'0')).join('');
  }catch(e){
    // navegador sem suporte a crypto.subtle (raríssimo hoje em dia): usa um fallback
    // ainda assim salgado, em vez de deixar o cadastro/troca de senha quebrar.
    console.warn('crypto.subtle indisponível, usando fallback de hash salgado.');
    return simpleHash(saltHex + ':' + password);
  }
}
async function setUserPassword(u, password){
  const salt = genSalt();
  u.passSalt = salt;
  u.passHash = await hashPasswordSecure(password, salt);
}
/* retorna true/false, ou 'legacy-ok' quando a senha bate mas ainda está no hash antigo
   (quem chamar deve, nesse caso, chamar setUserPassword de novo para migrar a conta) */
async function verifyUserPassword(u, password){
  if(u.passSalt){
    const h = await hashPasswordSecure(password, u.passSalt);
    return h === u.passHash;
  }
  if(u.passHash === simpleHash(password)) return 'legacy-ok';
  return false;
}

function getUsers(){ return DB.get(USERS_KEY, {}); }
function saveUsers(u){ DB.set(USERS_KEY, u); }
function currentUsername(){ return DB.get(SESSION_KEY, null); }
function currentUser(){
  const name = currentUsername();
  if(!name) return null;
  const users = getUsers();
  return users[name] ? Object.assign({username:name}, users[name]) : null;
}
function isLoggedIn(){ return !!currentUser(); }

function toast(msg){
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toast._t);
  toast._t = setTimeout(()=>t.classList.remove('show'), 2600);
}

/* ---------- avatar placeholder ---------- */
function avatarFor(user){
  if(user && user.avatar) return user.avatar;
  return 'data:image/svg+xml;utf8,' + encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" width="80" height="80"><rect width="80" height="80" fill="#12233a"/><text x="50%" y="56%" font-family="Arial" font-size="34" fill="#54d6ff" text-anchor="middle">${(user&&user.username?user.username[0]:'?').toUpperCase()}</text></svg>`
  );
}

/* ---------- favoritos ---------- */
function favKey(){ return FAV_PREFIX + (currentUsername()||'guest'); }
function getFavorites(){ return DB.get(favKey(), []); }
function isFavorite(id){ return getFavorites().includes(id); }
function toggleFavorite(id){
  if(!isLoggedIn()){ toast('Crie sua conta para favoritar jogos.'); openAuth('register'); return; }
  let favs = getFavorites();
  if(favs.includes(id)){ favs = favs.filter(x=>x!==id); toast('Removido dos favoritos.'); }
  else { favs.push(id); toast('Adicionado aos favoritos!'); }
  DB.set(favKey(), favs);
  renderAllGameGrids();
  if(document.getElementById('game-modal').classList.contains('open')) updateFavButtonInModal();
  if(document.getElementById('favorites-page')) renderFavoritesPage();
}

/* ---------- comentários / avaliações / respostas ---------- */
function commentsKey(gameId){ return COMMENTS_PREFIX + gameId; }
function genCommentId(){ return 'c'+Date.now().toString(36)+Math.random().toString(36).slice(2,8); }
function getComments(gameId){
  const list = DB.get(commentsKey(gameId), []);
  // migração: garante id e parentId em comentários antigos salvos antes de existirem respostas
  let changed = false;
  list.forEach(c => {
    if(!c.id){ c.id = genCommentId(); changed = true; }
    if(c.parentId === undefined){ c.parentId = null; changed = true; }
  });
  if(changed) DB.set(commentsKey(gameId), list);
  return list;
}
function addComment(gameId, score, text){
  const user = currentUser();
  if(!user) return;
  const list = getComments(gameId);
  // não gravamos o avatar aqui: ele é sempre buscado "ao vivo" do perfil do usuário na hora de exibir,
  // assim, se a foto de perfil mudar depois, as avaliações antigas também atualizam.
  list.unshift({ id: genCommentId(), user: user.username, score, text, date: new Date().toISOString(), parentId: null });
  DB.set(commentsKey(gameId), list);
}
function addReply(gameId, parentId, text){
  const user = currentUser();
  if(!user) return;
  const list = getComments(gameId);
  list.push({ id: genCommentId(), user: user.username, score: null, text, date: new Date().toISOString(), parentId });
  DB.set(commentsKey(gameId), list);
}

/* ---------- @menções ---------- */
function escapeHTML(str){
  return String(str).replace(/[&<>"']/g, m => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m]));
}
function renderMentions(text){
  const escaped = escapeHTML(text);
  const users = getUsers();
  return escaped.replace(/@([A-Za-z0-9_]{2,20})/g, (match, uname) => {
    const real = Object.keys(users).find(u => u.toLowerCase() === uname.toLowerCase());
    return real ? `<span class="mention">@${escapeHTML(real)}</span>` : match;
  });
}
/* ---------- destaque de @menção EM TEMPO REAL, enquanto a pessoa digita ----------
   Um <textarea> puro não permite colorir parte do texto. O truque (usado por
   quase todo app com @menção) é sobrepor uma camada invisível atrás do textarea
   com o mesmo texto, só que com o @nome colorido, e deixar o texto do textarea
   transparente — assim a pessoa só enxerga a camada colorida por baixo, mas
   continua digitando e selecionando normalmente no textarea de verdade. */
function highlightMentionsPlain(text){
  const escaped = escapeHTML(text);
  // aqui destaca qualquer @palavra sendo digitada (feedback imediato), sem
  // precisar já existir aquele usuário — a validação de usuário real só é
  // feita depois, quando o comentário é exibido (renderMentions)
  return escaped.replace(/@([A-Za-z0-9_]{1,20})/g, '<span class="mention">@$1</span>') + '\u200b';
}
function initMentionHighlight(textareaId){
  const ta = document.getElementById(textareaId);
  if(!ta || ta.dataset.mhReady) return;
  ta.dataset.mhReady = '1';

  // guarda o placeholder original e tira o atributo nativo: a partir de agora quem
  // desenha o "placeholder" (e o texto colorido) é a camada por cima, não o textarea
  const placeholderText = ta.getAttribute('placeholder') || '';
  ta.removeAttribute('placeholder');

  const wrap = document.createElement('div');
  wrap.className = 'mention-input-wrap';
  ta.parentNode.insertBefore(wrap, ta);
  wrap.appendChild(ta);

  const overlay = document.createElement('div');
  overlay.className = 'mention-highlight-overlay';
  wrap.appendChild(overlay); // depois do textarea no HTML = desenha por cima dele visualmente

  function syncOverlay(){
    overlay.innerHTML = ta.value
      ? highlightMentionsPlain(ta.value)
      : `<span class="mention-placeholder">${escapeHTML(placeholderText)}</span>`;
    overlay.scrollTop = ta.scrollTop;
  }
  ta.addEventListener('input', syncOverlay);
  ta.addEventListener('scroll', () => { overlay.scrollTop = ta.scrollTop; });
  syncOverlay();
}

function initMentionAutocomplete(textareaId){
  const ta = document.getElementById(textareaId);
  const dropdown = document.getElementById('mention-dropdown');
  if(!ta || !dropdown) return;
  let activeIndex = 0;
  let currentMatches = [];

  function closeDropdown(){ dropdown.style.display='none'; dropdown.innerHTML=''; currentMatches=[]; }
  function updateActive(){ [...dropdown.children].forEach((el,i)=>el.classList.toggle('active', i===activeIndex)); }

  function getMentionQuery(){
    const pos = ta.selectionStart;
    const before = ta.value.slice(0, pos);
    const m = before.match(/(?:^|\s)@([A-Za-z0-9_]{0,20})$/);
    return m ? m[1] : null;
  }
  function selectMention(i){
    const uname = currentMatches[i];
    if(!uname) return;
    const pos = ta.selectionStart;
    const before = ta.value.slice(0,pos);
    const after = ta.value.slice(pos);
    const newBefore = before.replace(/(?:^|\s)@([A-Za-z0-9_]{0,20})$/, (m)=> (m.startsWith(' ')?' ':'') + '@'+uname+' ');
    ta.value = newBefore + after;
    ta.focus();
    ta.selectionStart = ta.selectionEnd = newBefore.length;
    closeDropdown();
  }
  function openDropdown(query){
    const matches = Object.keys(getUsers()).filter(u => u.toLowerCase().startsWith(query.toLowerCase()));
    currentMatches = matches.slice(0,6);
    if(!currentMatches.length){ closeDropdown(); return; }
    activeIndex = 0;
    dropdown.innerHTML = currentMatches.map((u,i)=>`<div data-i="${i}" class="${i===0?'active':''}">@${u}</div>`).join('');
    const rect = ta.getBoundingClientRect();
    dropdown.style.left = rect.left+'px';
    dropdown.style.top = (rect.top - currentMatches.length*34 - 10)+'px';
    dropdown.style.width = Math.max(160, rect.width*0.6)+'px';
    dropdown.style.display='block';
    [...dropdown.children].forEach(el=>{ el.onclick = ()=> selectMention(parseInt(el.dataset.i)); });
  }
  ta.addEventListener('input', ()=>{
    const q = getMentionQuery();
    if(q !== null) openDropdown(q); else closeDropdown();
  });
  ta.addEventListener('keydown', (e)=>{
    if(dropdown.style.display !== 'block') return;
    if(e.key === 'ArrowDown'){ e.preventDefault(); activeIndex=(activeIndex+1)%currentMatches.length; updateActive(); }
    else if(e.key === 'ArrowUp'){ e.preventDefault(); activeIndex=(activeIndex-1+currentMatches.length)%currentMatches.length; updateActive(); }
    else if(e.key === 'Enter' || e.key === 'Tab'){ if(currentMatches.length){ e.preventDefault(); selectMention(activeIndex); } }
    else if(e.key === 'Escape'){ closeDropdown(); }
  });
  ta.addEventListener('blur', ()=> setTimeout(closeDropdown, 150));
}
/* busca o avatar atual do autor do comentário (funciona também para comentários antigos que ainda tinham avatar fixo salvo) */
function avatarForCommentAuthor(username){
  const users = getUsers();
  const u = users[username];
  return avatarFor(u ? Object.assign({ username }, u) : { username });
}
function averageScore(gameId){
  const list = getComments(gameId).filter(c=>!c.parentId && typeof c.score === 'number');
  if(!list.length) return null;
  const sum = list.reduce((a,c)=>a+c.score,0);
  return Math.round((sum/list.length)*10)/10;
}

/* ---------- game lookup ---------- */
function getGame(id){ return GAMES.find(g=>g.id===id); }

/* ---------- render: game grids ---------- */
function coverOrFallback(game){
  if(game.cover){
    return `<div class="cover-wrap"><img src="${game.cover}" alt="${game.title}" loading="lazy"></div>`;
  }
  return `<div class="cover-wrap"><div class="poster-fallback">${game.title}</div></div>`;
}

function gameCardHTML(game){
  const avg = averageScore(game.id);
  const fav = isFavorite(game.id);
  return `
  <div class="game-card" data-id="${game.id}">
    <div onclick="openGameModal('${game.id}')">
      ${coverOrFallback(game)}
      ${game.isNew ? '<span class="new-tag">Novidade</span>' : ''}
      ${avg ? `<span class="score-tag">★ ${avg.toFixed(1)}</span>` : ''}
    </div>
    <div class="card-body">
      <div class="game-meta" onclick="openGameModal('${game.id}')">${game.tags.slice(0,2).join(' · ')}</div>
      <h3 onclick="openGameModal('${game.id}')">${game.title}</h3>
      <p onclick="openGameModal('${game.id}')">${game.summary}</p>
      <div class="card-actions">
        <button class="details-btn" onclick="openGameModal('${game.id}')">Ver detalhes</button>
        <button class="fav-btn ${fav?'active':''}" title="Favoritar" onclick="event.stopPropagation();toggleFavorite('${game.id}')">${fav?'♥':'♡'}</button>
      </div>
    </div>
  </div>`;
}

function renderAllGameGrids(){
  const home = document.getElementById('home-games-grid');
  if(home){
    const featuredIds = ['baldurs','resident-village','arc-raiders','gtavi'];
    home.innerHTML = featuredIds.map(id=>getGame(id)).filter(Boolean).map(gameCardHTML).join('');
  }
  const full = document.getElementById('catalog-grid');
  if(full){
    full.innerHTML = GAMES.map(gameCardHTML).join('');
  }
  const favGrid = document.getElementById('favorites-grid');
  if(favGrid) renderFavoritesPage();
}

function renderFavoritesPage(){
  const el = document.getElementById('favorites-grid');
  const empty = document.getElementById('favorites-empty');
  if(!el) return;
  if(!isLoggedIn()){
    el.innerHTML = '';
    empty.style.display = 'block';
    empty.innerHTML = 'Crie sua conta ou faça login para favoritar e ver seus jogos aqui.';
    return;
  }
  const favs = getFavorites();
  if(!favs.length){
    el.innerHTML = '';
    empty.style.display = 'block';
    empty.innerHTML = 'Você ainda não favoritou nenhum jogo. Clique no ♡ nos cards para adicionar.';
    return;
  }
  empty.style.display = 'none';
  el.innerHTML = favs.map(id=>getGame(id)).filter(Boolean).map(gameCardHTML).join('');
}

/* ---------- gallery photo credit ---------- */
function photoCreditFor(id){
  const gabriel = ["gt7","spiderman","daysgone","battlefield6","flightsim24"];
  const otavio = ["forza"];
  if(gabriel.includes(id)) return "Fotos próprias do autor Gabriel H Garcia";
  if(otavio.includes(id)) return "Fotos próprias do autor Otávio Marconni";
  return "Fotos retiradas da internet";
}

/* ---------- gallery tiles ---------- */
function galleryTileHTML(item){
  if(item.type === 'img'){
    return `<figure><img src="${item.src}" alt="${item.alt||''}" loading="lazy" onclick="openLightbox('${item.src.replace(/'/g,"\\'")}')"></figure>`;
  }
  if(item.type === 'video'){
    if(item.thumb){
      return `<figure><div class="video-tile" onclick="window.open('${item.url}','_blank')"><img src="${item.thumb}" alt="${item.label||'Trailer'}" loading="lazy"><div class="play">▶</div></div></figure>`;
    }
    return `<figure><div class="video-tile" onclick="window.open('${item.url}','_blank')"><div class="poster-fallback" style="height:100%">${item.label||'Trailer'}</div><div class="play">▶</div></div></figure>`;
  }
  // placeholder
  return `<figure><div class="placeholder-tile"><span class="ico">🖼</span><span>Mais imagens em breve</span></div></figure>`;
}

/* ---------- modal do jogo ---------- */
let currentGameId = null;
function openGameModal(id){
  const game = getGame(id);
  if(!game) return;
  currentGameId = id;

  const heroWrap = document.getElementById('gm-hero-wrap');
  if(game.cover){
    heroWrap.innerHTML = `<img src="${game.cover}" alt="${game.title}" class="modal-hero">`;
  } else {
    heroWrap.innerHTML = `<div class="modal-hero-fallback">${game.title}</div>`;
  }

  document.getElementById('gm-title').textContent = game.title;
  document.getElementById('gm-summary').textContent = game.summary;
  document.getElementById('gm-tags').innerHTML = game.tags.map(t=>`<span>${t}</span>`).join('');
  document.getElementById('gm-gallery').innerHTML = game.gallery.map(galleryTileHTML).join('');
  document.getElementById('gm-photo-credit').textContent = photoCreditFor(game.id);

  updateScoreBox();
  updateFavButtonInModal();
  renderComments();
  resetScorePicker();

  document.getElementById('game-modal').classList.add('open');
  document.body.style.overflow = 'hidden';
}
function closeGameModal(){
  document.getElementById('game-modal').classList.remove('open');
  document.body.style.overflow = '';
}
function updateFavButtonInModal(){
  const btn = document.getElementById('gm-fav-btn');
  if(!btn || !currentGameId) return;
  const fav = isFavorite(currentGameId);
  btn.textContent = fav ? '♥ Favoritado' : '♡ Favoritar';
  btn.classList.toggle('active', fav);
}
function updateScoreBox(){
  const avg = averageScore(currentGameId);
  const count = getComments(currentGameId).filter(c=>!c.parentId).length;
  document.getElementById('gm-score-num').textContent = avg ? avg.toFixed(1) : '—';
  document.getElementById('gm-score-count').textContent = count ? `${count} avaliação${count>1?'ões':''}` : 'sem avaliações ainda';
}

function openLightbox(src){
  document.getElementById('lb-img').src = src;
  document.getElementById('lightbox').classList.add('open');
}
function closeLightbox(){ document.getElementById('lightbox').classList.remove('open'); }

/* ---------- avaliações: seletor de nota 0-10 ---------- */
let selectedScore = 0;
function resetScorePicker(){
  selectedScore = 0;
  const picker = document.getElementById('score-picker');
  picker.innerHTML = '';
  for(let i=1;i<=10;i++){
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = i;
    b.onclick = ()=>{ selectedScore = i; [...picker.children].forEach(c=>c.classList.remove('sel')); b.classList.add('sel'); };
    picker.appendChild(b);
  }
  document.getElementById('comment-text').value = '';
  refreshCommentFormLock();
}
function refreshCommentFormLock(){
  const locked = document.getElementById('comment-locked');
  const form = document.getElementById('comment-form');
  if(isLoggedIn()){
    locked.style.display = 'none';
    form.style.display = 'block';
  } else {
    locked.style.display = 'flex';
    form.style.display = 'none';
  }
}
function submitComment(e){
  e.preventDefault();
  if(!isLoggedIn()){ openAuth('login'); return; }
  if(selectedScore < 1){ toast('Escolha uma nota de 1 a 10 antes de publicar.'); return; }
  const text = document.getElementById('comment-text').value.trim();
  if(!text){ toast('Escreva um comentário antes de publicar.'); return; }
  addComment(currentGameId, selectedScore, text);
  toast('Avaliação publicada!');
  updateScoreBox();
  renderComments();
  resetScorePicker();
  renderAllGameGrids();
}

let showingAllComments = false;
/* ids dos comentários cujas respostas estão abertas no momento — igual ao Instagram,
   as respostas começam sempre fechadas e só aparecem quando a pessoa clica em "Ver respostas" */
let openReplyThreads = new Set();

/* formata data + horário, ex.: "24/08/2026 às 14:32" */
function formatCommentDate(iso){
  const d = new Date(iso);
  const date = d.toLocaleDateString('pt-BR');
  const time = d.toLocaleTimeString('pt-BR', { hour:'2-digit', minute:'2-digit' });
  return `${date} às ${time}`;
}

function commentBlockHTML(c, allList){
  const replies = allList.filter(r => r.parentId === c.id);
  const repliesOpen = openReplyThreads.has(c.id);
  return `
  <div class="comment" data-id="${c.id}">
    <img class="avatar" src="${avatarForCommentAuthor(c.user)}" alt="${c.user}">
    <div class="c-body">
      <div class="c-top">
        <span class="c-name">${c.user} <span class="c-score">★ ${c.score}/10</span></span>
        <span class="c-date">${formatCommentDate(c.date)}</span>
      </div>
      <p>${renderMentions(c.text)}</p>
      <div class="comment-actions">
        <button class="reply-btn" onclick="toggleReplyForm('${c.id}')">Responder</button>
      </div>
      ${replies.length ? `
      <button class="view-replies-btn" onclick="toggleRepliesVisibility('${c.id}')">
        <span class="vr-line"></span>${repliesOpen ? 'Ocultar respostas' : `Ver ${replies.length} resposta${replies.length>1?'s':''}`}
      </button>
      <div class="reply-list" style="${repliesOpen ? '' : 'display:none'}">${replies.map(replyItemHTML).join('')}</div>
      ` : ''}
      <div class="reply-form-slot" id="reply-slot-${c.id}"></div>
    </div>
  </div>`;
}
function replyItemHTML(r){
  return `
  <div class="reply-item" data-id="${r.id}">
    <img class="avatar" src="${avatarForCommentAuthor(r.user)}" alt="${r.user}">
    <div class="c-body">
      <div class="c-top">
        <span class="c-name">${r.user}</span>
        <span class="c-date">${formatCommentDate(r.date)}</span>
      </div>
      <p>${renderMentions(r.text)}</p>
      <div class="comment-actions">
        <button class="reply-btn" onclick="toggleReplyForm('${r.parentId}','${r.user.replace(/'/g,"\\'")}')">Responder</button>
      </div>
    </div>
  </div>`;
}
function toggleRepliesVisibility(commentId){
  if(openReplyThreads.has(commentId)) openReplyThreads.delete(commentId);
  else openReplyThreads.add(commentId);
  renderComments();
}
function renderComments(){
  const list = getComments(currentGameId);
  const top = list.filter(c=>!c.parentId);
  const el = document.getElementById('comments-list');
  const toggle = document.getElementById('reviews-toggle');
  const visibleTop = showingAllComments ? top : top.slice(0,3);
  el.innerHTML = visibleTop.map(c=>commentBlockHTML(c, list)).join('') || `<p class="hint">Nenhuma avaliação ainda. Seja o primeiro a avaliar este jogo!</p>`;
  toggle.style.display = top.length > 3 ? 'inline' : 'none';
  toggle.textContent = showingAllComments ? 'Ver menos avaliações' : `Ver todas as ${top.length} avaliações`;
}
function toggleAllComments(){ showingAllComments = !showingAllComments; renderComments(); }

/* ---------- respostas estilo Instagram (com @menção) ---------- */
function toggleReplyForm(topId, mentionUser){
  if(!isLoggedIn()){ openAuth('login'); return; }
  const slot = document.getElementById('reply-slot-'+topId);
  if(!slot) return;
  if(slot.dataset.open === '1' && !mentionUser){
    slot.innerHTML = '';
    slot.dataset.open = '';
    return;
  }
  const prefill = mentionUser ? '@'+mentionUser+' ' : '';
  slot.dataset.open = '1';
  const taId = 'reply-text-'+topId;
  slot.innerHTML = `
    <div class="reply-form">
      <textarea id="${taId}" placeholder="Escreva uma resposta... use @ para marcar alguém">${prefill}</textarea>
      <button class="cta small" onclick="submitReply('${topId}')">Responder</button>
    </div>`;
  initMentionAutocomplete(taId);
  initMentionHighlight(taId);
  const ta = document.getElementById(taId);
  ta.focus();
  ta.selectionStart = ta.selectionEnd = ta.value.length;
}
function submitReply(topId){
  if(!isLoggedIn()){ openAuth('login'); return; }
  const ta = document.getElementById('reply-text-'+topId);
  if(!ta) return;
  const text = ta.value.trim();
  if(!text){ toast('Escreva algo antes de responder.'); return; }
  addReply(currentGameId, topId, text);
  const slot = document.getElementById('reply-slot-'+topId);
  if(slot){ slot.innerHTML=''; slot.dataset.open=''; }
  openReplyThreads.add(topId); // abre a thread automaticamente pra pessoa ver a resposta que acabou de mandar
  renderComments();
  toast('Resposta publicada!');
}

/* ---------- autenticação ---------- */
function openAuth(tab){
  document.getElementById('auth-modal').classList.add('open');
  document.body.style.overflow = 'hidden';
  switchAuthTab(tab || 'login');
}
function closeAuth(){
  document.getElementById('auth-modal').classList.remove('open');
  document.body.style.overflow = '';
}
function switchAuthTab(tab){
  document.getElementById('tab-login').classList.toggle('active', tab==='login');
  document.getElementById('tab-register').classList.toggle('active', tab==='register');
  document.getElementById('login-form').style.display = tab==='login' ? 'flex':'none';
  document.getElementById('register-form').style.display = tab==='register' ? 'flex':'none';
  document.getElementById('forgot-form').style.display = 'none';
  document.getElementById('auth-error').textContent = '';
}
/* ---------- esqueci minha senha ----------
   Site de demonstração sem backend/e-mail: a "recuperação" localiza a conta
   pelo usuário ou e-mail e permite definir uma nova senha diretamente. */
let forgotTargetUsername = null;
function openForgotPassword(){
  document.getElementById('tab-login').classList.remove('active');
  document.getElementById('tab-register').classList.remove('active');
  document.getElementById('login-form').style.display = 'none';
  document.getElementById('register-form').style.display = 'none';
  document.getElementById('forgot-form').style.display = 'flex';
  document.getElementById('forgot-step1').style.display = 'block';
  document.getElementById('forgot-step2').style.display = 'none';
  document.getElementById('forgot-identifier').value = '';
  document.getElementById('auth-error').textContent = '';
  forgotTargetUsername = null;
}
function findUserByIdentifier(identifier){
  const users = getUsers();
  if(users[identifier]) return identifier;
  const found = Object.keys(users).find(u => (users[u].email||'').toLowerCase() === identifier.toLowerCase());
  return found || null;
}
function submitForgotStep1(){
  const identifier = document.getElementById('forgot-identifier').value.trim();
  const err = document.getElementById('auth-error');
  if(!identifier){ err.textContent = 'Digite seu usuário ou e-mail.'; return; }
  const username = findUserByIdentifier(identifier);
  if(!username){ err.textContent = 'Não encontramos nenhuma conta com esse usuário ou e-mail.'; return; }
  forgotTargetUsername = username;
  err.textContent = '';
  document.getElementById('forgot-step1').style.display = 'none';
  document.getElementById('forgot-step2').style.display = 'flex';
}
async function submitForgotStep2(){
  const err = document.getElementById('auth-error');
  const p1 = document.getElementById('forgot-new-password').value;
  const p2 = document.getElementById('forgot-new-password2').value;
  if(!forgotTargetUsername){ err.textContent = 'Sessão de recuperação expirada, tente novamente.'; return; }
  if(p1.length < 6){ err.textContent = 'A nova senha precisa ter 6+ caracteres.'; return; }
  if(p1 !== p2){ err.textContent = 'As senhas não coincidem.'; return; }
  const users = getUsers();
  await setUserPassword(users[forgotTargetUsername], p1);
  saveUsers(users);
  toast('Senha redefinida com sucesso! Faça login com sua nova senha.');
  forgotTargetUsername = null;
  switchAuthTab('login');
}
async function doRegister(e){
  e.preventDefault();
  const username = document.getElementById('reg-username').value.trim();
  const email = document.getElementById('reg-email').value.trim();
  const password = document.getElementById('reg-password').value;
  const platform = document.getElementById('reg-platform').value;
  const err = document.getElementById('auth-error');
  if(!username || !email || password.length < 6){ err.textContent = 'Preencha todos os campos (senha com 6+ caracteres).'; return; }
  const users = getUsers();
  if(users[username]){ err.textContent = 'Esse nome de usuário já existe.'; return; }
  const u = { email, platform, avatar: null, bio: '', createdAt: new Date().toISOString() };
  await setUserPassword(u, password);
  users[username] = u;
  saveUsers(users);
  DB.set(SESSION_KEY, username);
  closeAuth();
  toast(`Bem-vindo(a), ${username}!`);
  refreshAuthUI();
}
async function doLogin(e){
  e.preventDefault();
  const identifier = document.getElementById('login-identifier').value.trim();
  const password = document.getElementById('login-password').value;
  const err = document.getElementById('auth-error');
  const users = getUsers();
  const username = findUserByIdentifier(identifier);
  const u = username ? users[username] : null;
  const result = u ? await verifyUserPassword(u, password) : false;
  if(!result){ err.textContent = 'Usuário/e-mail ou senha incorretos.'; return; }
  if(result === 'legacy-ok'){
    // migração silenciosa: conta antiga passa a usar o hash seguro a partir de agora
    await setUserPassword(u, password);
    users[username] = u;
    saveUsers(users);
  }
  DB.set(SESSION_KEY, username);
  closeAuth();
  toast(`Login realizado! Bem-vindo(a) de volta, ${username}.`);
  refreshAuthUI();
}
function doLogout(){
  localStorage.removeItem(SESSION_KEY);
  toast('Você saiu da sua conta.');
  refreshAuthUI();
  window.location.hash = '#home';
}

function refreshAuthUI(){
  const user = currentUser();
  const pill = document.getElementById('account-pill');
  const loginBtn = document.getElementById('login-btn');
  if(user){
    pill.style.display = 'flex';
    loginBtn.style.display = 'none';
    pill.querySelector('img').src = avatarFor(user);
    pill.querySelector('span').textContent = user.username;
  } else {
    pill.style.display = 'none';
    loginBtn.style.display = 'inline-flex';
  }
  renderAllGameGrids();
  refreshCommentFormLock();
  renderChampionshipsPage();
  renderProfilePage();
}

/* ---------- perfil ---------- */
function renderProfilePage(){
  const wrap = document.getElementById('profile-content');
  if(!wrap) return;
  const user = currentUser();
  if(!user){
    wrap.innerHTML = `<div class="info-card"><h3>Você não está logado</h3><p>Crie sua conta ou entre para editar seu perfil, favoritar jogos e comentar.</p><button class="cta" onclick="openAuth('login')">Entrar / Criar conta</button></div>`;
    return;
  }
  wrap.innerHTML = `
    <div class="info-card">
      <h3>Meu perfil</h3>
      <form class="form-grid" onsubmit="saveProfile(event)">
        <div class="full avatar-upload">
          <img id="profile-avatar-preview" src="${avatarFor(user)}" alt="Avatar">
          <label>Alterar foto<input type="file" accept="image/*" id="profile-avatar-input" onchange="previewAvatar(event)"></label>
        </div>
        <label class="field full">NOME DE USUÁRIO<input value="${user.username}" disabled></label>
        <label class="field">E-MAIL<input id="profile-email" type="email" value="${user.email||''}" required></label>
        <label class="field">PLATAFORMA PRINCIPAL
          <select id="profile-platform">
            <option ${user.platform==='PlayStation'?'selected':''}>PlayStation</option>
            <option ${user.platform==='Xbox'?'selected':''}>Xbox</option>
            <option ${user.platform==='PC'?'selected':''}>PC</option>
          </select>
        </label>
        <label class="field full">BIO<textarea id="profile-bio" placeholder="Fale um pouco sobre você...">${user.bio||''}</textarea></label>
        <button class="cta full">SALVAR ALTERAÇÕES</button>
      </form>
    </div>
    <div class="info-card">
      <h3>Minha conta</h3>
      <p>Membro desde ${new Date(user.createdAt).toLocaleDateString('pt-BR')}.</p>
      <p>Jogos favoritados: ${getFavorites().length}</p>
      <button class="cta ghost full" onclick="doLogout()">SAIR DA CONTA</button>
    </div>
    <div class="info-card full" style="grid-column:1/-1">
      <h3>Alterar senha</h3>
      <form class="form-grid" onsubmit="submitChangePassword(event)">
        <label class="field full">SENHA ATUAL<input id="cp-current" type="password" required autocomplete="current-password"></label>
        <label class="field full">NOVA SENHA<input id="cp-new" type="password" minlength="6" required autocomplete="new-password"><span class="pw-note">Mínimo de 6 caracteres</span></label>
        <label class="field full">CONFIRMAR NOVA SENHA<input id="cp-new2" type="password" minlength="6" required autocomplete="new-password"></label>
        <p class="hint" id="cp-error" style="color:#ff6b6b;display:none"></p>
        <button class="cta full">SALVAR NOVA SENHA</button>
      </form>
    </div>
    <div class="info-card full" style="grid-column:1/-1">
      <div id="profile-enrollments-wrap"></div>
    </div>
  `;
  renderMyEnrollments('profile-enrollments-wrap', true);
}
/* ---------- troca de senha (configurações) ----------
   Pede a senha atual antes de trocar (evita que alguém com a sessão aberta no
   navegador de outra pessoa mude a senha sem saber a atual) e salva a nova
   senha já com o hash seguro (SHA-256 + salt). */
async function submitChangePassword(e){
  e.preventDefault();
  const errEl = document.getElementById('cp-error');
  errEl.style.display = 'none';
  const showErr = (msg) => { errEl.textContent = msg; errEl.style.display = 'block'; };

  const current = document.getElementById('cp-current').value;
  const p1 = document.getElementById('cp-new').value;
  const p2 = document.getElementById('cp-new2').value;

  const users = getUsers();
  const username = currentUsername();
  const u = users[username];
  if(!u) return;

  const ok = await verifyUserPassword(u, current);
  if(!ok){ showErr('Senha atual incorreta.'); return; }
  if(p1.length < 6){ showErr('A nova senha precisa ter 6+ caracteres.'); return; }
  if(p1 !== p2){ showErr('As senhas novas não coincidem.'); return; }
  if(p1 === current){ showErr('A nova senha precisa ser diferente da atual.'); return; }

  await setUserPassword(u, p1);
  users[username] = u;
  saveUsers(users);
  toast('Senha alterada com sucesso!');
  renderProfilePage();
}
let pendingAvatarData = null;
function previewAvatar(e){
  const file = e.target.files[0];
  if(!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    pendingAvatarData = reader.result;
    document.getElementById('profile-avatar-preview').src = pendingAvatarData;
  };
  reader.readAsDataURL(file);
}
function saveProfile(e){
  e.preventDefault();
  const users = getUsers();
  const username = currentUsername();
  const u = users[username];
  u.email = document.getElementById('profile-email').value.trim();
  u.platform = document.getElementById('profile-platform').value;
  u.bio = document.getElementById('profile-bio').value.trim();
  if(pendingAvatarData){ u.avatar = pendingAvatarData; pendingAvatarData = null; }
  users[username] = u;
  saveUsers(users);
  toast('Perfil atualizado!');
  refreshAuthUI();
}

/* ---------- campeonatos ---------- */
/* cada campeonato referencia um jogo (gameId); as plataformas disponíveis para
   inscrição vêm automaticamente de GAMES.find(gameId).platforms — ou seja, um
   jogo exclusivo de uma plataforma só oferece aquela opção no formulário. */
const CAMPEONATOS = [
  { id:'gt7-ferrari', nome:'Campeonato Ferrari Af Course', gameId:'gt7', data:'12 ago 2026 — 12 nov 2026', local:'Online · Finais em Londres',
    categorias:['Gr.1 — Protótipos','Gr.2 — Super GT','Gr.3 — GT3','Gr.4 — GT4','Gr.B — Rally'] },
  { id:'valorant-champ', nome:'Campeonato de Valorant', gameId:null, jogoNome:'Valorant', platformsOverride:['PC (Riot Games)'], data:'27 set 2026', local:'Online · Finais em Tóquio',
    categorias:['Iron — Bronze','Silver — Gold','Platinum — Diamond','Ascendant — Immortal','Radiant (Top)'] },
  { id:'eafc-worldcup', nome:'EA FC World Cup', gameId:null, jogoNome:'EA FC', platformsOverride:['PC (EA App)','PS5','Xbox'], data:'25 jul 2026', local:'Nova York',
    categorias:['Division 10 — 8 (Iniciante)','Division 7 — 5 (Intermediário)','Division 4 — 2 (Avançado)','Division 1 (Elite)'] },
  { id:'bf6-squad', nome:'Battlefield Squad Night', gameId:'battlefield6', data:'Toda sexta, 21h', local:'Online',
    categorias:['Casual','Competitivo','Hardcore'] },
];

function champGameTitle(c){
  if(c.gameId){ const g = getGame(c.gameId); return g ? g.title : c.jogoNome; }
  return c.jogoNome;
}
function champPlatforms(c){
  if(c.platformsOverride) return c.platformsOverride;
  if(c.gameId){ const g = getGame(c.gameId); return g ? g.platforms : []; }
  return [];
}

const PLATFORM_INFO = {
  'PlayStation': { label:'Conectar conta PlayStation Network', desc:'Você será redirecionado para o login da PlayStation Network para verificar sua conta PSN.' },
  'PS5': { label:'Conectar conta PlayStation Network', desc:'Você será redirecionado para o login da PlayStation Network para verificar sua conta PSN.' },
  'PS4': { label:'Conectar conta PlayStation Network', desc:'Você será redirecionado para o login da PlayStation Network para verificar sua conta PSN.' },
  'Xbox': { label:'Conectar conta Xbox / Microsoft', desc:'Você será redirecionado para o login da Microsoft para verificar sua conta Xbox Live.' },
  'PC': { label:'Conectar conta Steam / Epic', desc:'Você será redirecionado para o login da sua launcher de PC para verificar sua conta.' },
  'PC (Riot Games)': { label:'Conectar conta Riot Games', desc:'Você será redirecionado para o login da Riot Games para verificar seu perfil.' },
  'PC (EA App)': { label:'Conectar conta EA', desc:'Você será redirecionado para o login da EA para verificar seu perfil.' },
  'A anunciar': { label:'Plataforma a anunciar', desc:'A plataforma oficial deste jogo ainda não foi revelada pelo estúdio.' },
};

/* PAISES_ESTADOS vem de countries_data.js — lista completa (250 países) com
   seus estados/províncias/regiões, já traduzida para pt-BR. */
function populatePaisSelect(){
  const sel = document.getElementById('f-pais');
  if(!sel || typeof PAISES_ESTADOS === 'undefined') return;
  sel.innerHTML = '<option value="">Selecione...</option>' +
    PAISES_ESTADOS.map(p => `<option value="${p.code}">${p.flag} ${p.name}</option>`).join('');
}
function updateEstados(){
  const pais = document.getElementById('f-pais').value;
  const estadoSel = document.getElementById('f-estado');
  const country = (typeof PAISES_ESTADOS !== 'undefined') ? PAISES_ESTADOS.find(p=>p.code===pais) : null;
  const lista = country ? country.states : [];
  if(!pais){
    estadoSel.innerHTML = '<option value="">Selecione o país</option>';
    estadoSel.disabled = true;
  } else if(lista.length === 0){
    estadoSel.innerHTML = '<option value="">Digite no campo cidade</option>';
    estadoSel.disabled = true;
  } else {
    estadoSel.disabled = false;
    estadoSel.innerHTML = '<option value="">Selecione...</option>' + lista.map(e=>`<option>${e}</option>`).join('');
  }
}

function renderChampionshipsPage(){
  const el = document.getElementById('champ-list');
  if(!el) return;
  renderMyEnrollments('my-enrollments-wrap', true);
  el.innerHTML = CAMPEONATOS.map(c=>`
    <div class="champ-item" onclick="openChampModal('${c.id}')">
      <div class="info">
        <span class="tag-jogo">${champGameTitle(c)}</span>
        <h3>${c.nome}</h3>
        <p>📅 ${c.data} &nbsp;·&nbsp; 📍 ${c.local}</p>
      </div>
      <button class="cta small" style="pointer-events:none">Inscrever-se</button>
    </div>
  `).join('');
}

/* ---------- meus campeonatos (inscrições) ---------- */
function myEnrollmentIds(){
  const user = currentUser();
  if(!user) return [];
  return DB.get(ENROLL_KEY, {})[user.username] || [];
}
function renderMyEnrollments(containerId, withTitle){
  const wrap = document.getElementById(containerId);
  if(!wrap) return;
  const user = currentUser();
  if(!user){
    wrap.innerHTML = '';
    return;
  }
  const ids = myEnrollmentIds();
  const items = ids.map(id => CAMPEONATOS.find(c=>c.id===id)).filter(Boolean);
  let html = withTitle ? `<h3 class="section-sub-title">Meus campeonatos</h3>` : '';
  if(!items.length){
    html += `<div class="my-champs-empty">Você ainda não está inscrito em nenhum campeonato. Escolha um abaixo para participar.</div>`;
  } else {
    html += `<div class="my-champs">` + items.map(c=>`
      <div class="my-champ-card">
        <div class="info">
          <span class="tag-jogo">${champGameTitle(c)}</span>
          <h4>${c.nome}</h4>
          <p>📅 ${c.data} &nbsp;·&nbsp; 📍 ${c.local}</p>
        </div>
        <div style="display:flex;align-items:center;gap:14px">
          <span class="status">✔ Inscrito</span>
          <button class="cta ghost small" onclick="cancelEnrollment('${c.id}')">Cancelar inscrição</button>
        </div>
      </div>
    `).join('') + `</div>`;
  }
  wrap.innerHTML = html;
}
function cancelEnrollment(id){
  const user = currentUser();
  if(!user) return;
  const all = DB.get(ENROLL_KEY, {});
  all[user.username] = (all[user.username]||[]).filter(x=>x!==id);
  DB.set(ENROLL_KEY, all);
  toast('Inscrição cancelada.');
  renderChampionshipsPage();
  renderProfilePage();
}

let currentChamp = null;
let champSelectedPlatform = null;
let champPlatformConnected = false;

function openChampModal(id){
  currentChamp = CAMPEONATOS.find(c=>c.id===id);
  if(!currentChamp) return;
  champSelectedPlatform = null;
  champPlatformConnected = false;
  document.getElementById('champ-modal-title').textContent = 'Inscrição: ' + currentChamp.nome;
  const user = currentUser();
  const body = document.getElementById('champ-modal-body');
  if(!user){
    body.innerHTML = `
      <p class="hint" style="margin-bottom:16px">Para se inscrever em campeonatos você precisa ter uma conta EsquizoGames — usamos os dados do seu perfil do site para não pedir tudo de novo.</p>
      <button class="cta full" onclick="closeChampModal();openAuth('register')">CRIAR CONTA / ENTRAR</button>
    `;
  } else {
    const already = (DB.get(ENROLL_KEY, {})[user.username]||[]).includes(currentChamp.id);
    const plats = champPlatforms(currentChamp);
    body.innerHTML = `
      <div class="info-card" style="padding:14px 16px;margin-bottom:18px">
        <p class="hint" style="margin:0 0 4px">CONTA ESQUIZOGAMES (perfil do site)</p>
        <p style="margin:0;display:flex;align-items:center;gap:10px">
          <img src="${avatarFor(user)}" style="width:30px;height:30px;border-radius:50%;object-fit:cover">
          <span><strong>${user.username}</strong> · ${user.email}</span>
        </p>
      </div>
      <form onsubmit="submitEnroll(event)" class="form-grid" id="champ-form">
        <p class="hint full" style="margin:0">DADOS PESSOAIS</p>
        <label class="field full">NOME COMPLETO<input id="f-nome" required placeholder="Seu nome completo"></label>
        <label class="field">E-MAIL<input id="f-email" type="email" required value="${user.email||''}"></label>
        <label class="field">DATA DE NASCIMENTO<input id="f-nasc" type="date" required></label>
        <label class="field">PAÍS
          <select id="f-pais" onchange="updateEstados()">
            <option value="">Selecione...</option>
          </select>
        </label>
        <label class="field">ESTADO / PROVÍNCIA<select id="f-estado" disabled><option value="">Selecione o país</option></select></label>
        <label class="field full">CIDADE<input id="f-cidade" placeholder="Sua cidade" required></label>

        <p class="hint full" style="margin:14px 0 0">CONTA DE JOGO (in-game)</p>
        <label class="field full">NICKNAME (IN-GAME)<input id="champ-nick" required placeholder="Seu nick no jogo"></label>

        <p class="hint full" style="margin:14px 0 0">PLATAFORMA</p>
        <div class="full">
          <p class="hint" style="margin-bottom:8px">${plats.length>1 ? 'Selecione a plataforma em que você vai competir e conecte sua conta.' : 'Este jogo é exclusivo — a plataforma abaixo é a única disponível.'}</p>
          <div class="platform-options" id="champ-platform-options" style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:10px">
            ${plats.map(p=>`<button type="button" class="cta ghost small" data-plat="${p}" onclick="selectChampPlatform('${p.replace(/'/g,"\\'")}')">${p}</button>`).join('') || '<span class="hint">Nenhuma plataforma definida ainda.</span>'}
          </div>
          <div id="champ-platform-connect" style="display:none" class="locked-note">
            <span id="champ-platform-connect-text"></span>
            <button type="button" class="cta small" onclick="simulateChampConnect()">Conectar conta</button>
          </div>
          <p id="champ-platform-connected" class="hint" style="display:none;color:var(--lime);font-weight:800">✔ Conta conectada</p>
        </div>

        <p class="hint full" style="margin:14px 0 0">CATEGORIA</p>
        <label class="field full"><select id="champ-categoria">${currentChamp.categorias.map(c=>`<option>${c}</option>`).join('')}</select></label>

        <p class="hint full" style="margin:14px 0 0">PERMISSÕES & TERMOS</p>
        <label class="checkline full"><input type="checkbox" id="champ-stream"> Aceito a gravação e/ou transmissão ao vivo (stream) das minhas partidas pela organização do campeonato.</label>
        <label class="checkline full"><input type="checkbox" id="champ-regras" required> Li e aceito as <strong>Regras e Regulamento</strong> do campeonato. <span style="color:var(--danger)">OBRIGATÓRIO</span></label>
        <label class="checkline full"><input type="checkbox" id="champ-termos" required> Li e aceito os <strong>Termos de Uso e Política de Privacidade</strong> da EsquizoGames. <span style="color:var(--danger)">OBRIGATÓRIO</span></label>

        <button class="cta full" id="champ-submit-btn" ${already?'disabled':''}>${already?'INSCRIÇÃO CONFIRMADA ✔':'CONFIRMAR INSCRIÇÃO'}</button>
      </form>
    `;
    if(plats.length === 1) selectChampPlatform(plats[0]);
    populatePaisSelect();
  }
  document.getElementById('champ-modal').classList.add('open');
  document.body.style.overflow = 'hidden';
}
function selectChampPlatform(p){
  champSelectedPlatform = p;
  champPlatformConnected = false;
  document.querySelectorAll('#champ-platform-options button').forEach(b=>b.classList.toggle('active', b.dataset.plat===p));
  const info = PLATFORM_INFO[p] || { label:'Conectar conta', desc:'Você será redirecionado para verificar sua conta.' };
  const box = document.getElementById('champ-platform-connect');
  box.style.display = 'flex';
  document.getElementById('champ-platform-connect-text').textContent = info.label + ' — ' + info.desc;
  document.getElementById('champ-platform-connected').style.display = 'none';
}
function simulateChampConnect(){
  champPlatformConnected = true;
  document.getElementById('champ-platform-connect').style.display = 'none';
  document.getElementById('champ-platform-connected').style.display = 'block';
  toast('Conta de plataforma conectada (simulação).');
}
function closeChampModal(){
  document.getElementById('champ-modal').classList.remove('open');
  document.body.style.overflow = '';
}
function submitEnroll(e){
  e.preventDefault();
  const user = currentUser();
  if(!user || !currentChamp) return;
  if(!champSelectedPlatform){ toast('Selecione uma plataforma.'); return; }
  if(!champPlatformConnected){ toast('Conecte sua conta da plataforma antes de confirmar.'); return; }
  const all = DB.get(ENROLL_KEY, {});
  all[user.username] = all[user.username] || [];
  if(!all[user.username].includes(currentChamp.id)) all[user.username].push(currentChamp.id);
  DB.set(ENROLL_KEY, all);
  toast('Inscrição confirmada! Boa sorte na competição.');
  closeChampModal();
  renderChampionshipsPage();
  renderProfilePage();
}

/* ---------- contato (apenas feedback visual) ---------- */
function submitContact(e){
  e.preventDefault();
  toast('Mensagem enviada! Nossa equipe responde em breve.');
  e.target.reset();
}

/* ---------- inicialização ---------- */
document.addEventListener('DOMContentLoaded', () => {
  renderAllGameGrids();
  refreshAuthUI();
  renderChampionshipsPage();
  initMentionAutocomplete('comment-text');
  initMentionHighlight('comment-text');
  if(typeof initGateAd === 'function') initGateAd();
});
