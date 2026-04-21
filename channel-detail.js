(function () {
  const DATA_BASE = 'https://raw.githubusercontent.com/whatsonfreetv/whatsonfreetv-data/main';
  const SITE_ROOT = '';

  // Current channel info — set in load(), read by openShowModal
  let _channel = { name: '', logo: '', initial: '', genres: [] };
  let _backdropApplied = false;

  // ---- Helpers ----
  function esc(str) {
    const d = document.createElement('div');
    d.textContent = String(str || '');
    return d.innerHTML;
  }

  function stripHtml(html) {
    if (!html) return '';
    return html.replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').replace(/&#\d+;/g, ' ').trim();
  }

  function isMovieChannel(channelName, genres) {
    if ((genres || []).includes('Movies')) return true;
    const movieWords = ['cinema', 'movie', 'movies', 'film', 'films', 'classics'];
    const nameLower  = (channelName || '').toLowerCase();
    return movieWords.some(w => new RegExp('\\b' + w + '\\b').test(nameLower));
  }

  function titleMatchesQuery(returnedTitle, query) {
    function normalize(s) {
      return (s || '').toLowerCase()
        .replace(/\b(the|a|an)\b\s*/g, '')
        .replace(/[^a-z0-9]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
    }
    const norm = normalize(returnedTitle);
    const q    = normalize(query);
    if (!norm || !q) return false;
    if (norm === q) return true;
    const [shorter, longer] = norm.length <= q.length ? [norm, q] : [q, norm];
    return longer.includes(shorter) && shorter.length / longer.length >= 0.6;
  }

  function attachLogoFallback(img, fallbackEl) {
    if (!img) return;
    img.addEventListener('error', function () {
      this.style.display = 'none';
      if (fallbackEl) fallbackEl.style.display = 'flex';
    });
  }

  function timeRemaining(endTimeStr) {
    const mins = Math.round((new Date(endTimeStr).getTime() - Date.now()) / 60000);
    if (mins <= 0 || mins > 360) return null;
    if (mins < 60) return `ends in ${mins}m`;
    const h = Math.floor(mins / 60), m = mins % 60;
    return `ends in ${h}h${m > 0 ? ' ' + m + 'm' : ''}`;
  }

  function formatTime(dateStr) {
    return new Date(dateStr).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  }

  function formatDate(dateStr) {
    if (!dateStr) return '';
    try { return new Date(dateStr + 'T00:00:00').toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' }); }
    catch (_) { return dateStr; }
  }

  function platformClass(p) {
    const lower = (p || '').toLowerCase();
    if (lower.includes('pluto'))   return 'badge-platform-pluto';
    if (lower.includes('roku'))    return 'badge-platform-roku';
    if (lower.includes('samsung')) return 'badge-platform-samsung';
    if (lower.includes('plex'))    return 'badge-platform-plex';
    if (lower.includes('tubi'))    return 'badge-platform-tubi';
    if (lower.includes('peacock')) return 'badge-platform-peacock';
    if (lower.includes('freevee') || lower.includes('amazon')) return 'badge-platform-freevee';
    return 'badge-platform';
  }

  // ---- Navbar scroll ----
  const nav = document.querySelector('.navbar');
  if (nav) {
    window.addEventListener('scroll', () => {
      nav.classList.toggle('scrolled', window.scrollY > 10);
    }, { passive: true });
  }

  // ---- Back link ----
  function _backParams() {
    const p       = new URLSearchParams(window.location.search);
    const country = p.get('country') || sessionStorage.getItem('woftv_country') || 'US';
    const from    = p.get('from') || '';
    return { country, from };
  }

  function backHref() {
    const { country, from } = _backParams();
    const base = country === 'CA' ? `${SITE_ROOT}ca.html` : `${SITE_ROOT}us.html`;
    return from === 'guide' ? `${base}?view=guide` : base;
  }

  function backLabel() {
    const { country, from } = _backParams();
    if (from === 'guide') return 'Back to Live Guide';
    return country === 'CA' ? '&#127464;&#127462; Back to Canada' : '&#127482;&#127480; Back to US';
  }

  function highlightNav() {
    const { country } = _backParams();
    document.querySelectorAll('.nav-country-link').forEach(l => {
      if ((country === 'US' && l.href.includes('us.html')) ||
          (country === 'CA' && l.href.includes('ca.html'))) {
        l.classList.add('active');
      }
    });
  }
  highlightNav();

  // ---- Channel link helper (works from both root and channel/ subdir) ----
  function channelHref(ch) {
    const urlSlug = ch.url_slug;
    const name    = ch.fields['Channel Name'] || '';
    if (urlSlug) return `${SITE_ROOT}channel.html?slug=${encodeURIComponent(urlSlug)}`;
    return `${SITE_ROOT}channel.html?id=${encodeURIComponent(name)}`;
  }

  // ---- Search modal ----
  function setupSearch() {
    const icon = document.querySelector('.search-icon');
    if (!icon) return;

    let searchChannels = null;

    const modal = document.createElement('div');
    modal.id = 'searchModal';
    modal.className = 'search-modal';
    modal.innerHTML = `
      <div class="search-modal-inner">
        <div class="search-modal-bar">
          <span class="search-modal-icon">🔍</span>
          <input type="search" class="search-modal-input" id="searchModalInput"
            placeholder="Search channels…" autocomplete="off" aria-label="Search channels">
          <button class="search-modal-close" aria-label="Close">&#x2715;</button>
        </div>
        <div class="search-modal-results" id="searchModalResults"></div>
      </div>
    `;
    document.body.appendChild(modal);

    const modalInput = modal.querySelector('#searchModalInput');
    const resultsEl  = modal.querySelector('#searchModalResults');
    const closeBtn   = modal.querySelector('.search-modal-close');

    async function openModal() {
      modal.classList.add('open');
      setTimeout(() => modalInput.focus(), 50);
      if (!searchChannels) {
        resultsEl.innerHTML = '<div class="search-modal-hint">Loading channels…</div>';
        try {
          const country = sessionStorage.getItem('woftv_country') || 'US';
          searchChannels = await fetchChannelsJSON(country);
        } catch (_) {
          resultsEl.innerHTML = '<div class="search-modal-hint">Could not load channels.</div>';
          return;
        }
      }
      renderModalResults(modalInput.value);
    }

    function closeModal() {
      modal.classList.remove('open');
      modalInput.value = '';
      resultsEl.innerHTML = '';
    }

    function renderModalResults(q) {
      if (!searchChannels) return;
      const query = q.toLowerCase().trim();
      if (!query) {
        resultsEl.innerHTML = '<div class="search-modal-hint">Start typing to search channels…</div>';
        return;
      }
      const matches = searchChannels.filter(ch => {
        const f = ch.fields;
        return (f['Channel Name'] || '').toLowerCase().includes(query) ||
               (f['Description']  || '').toLowerCase().includes(query) ||
               (f['Genre']        || []).join(' ').toLowerCase().includes(query);
      }).slice(0, 24);

      if (!matches.length) {
        resultsEl.innerHTML = '<div class="search-modal-hint">No channels found.</div>';
        return;
      }

      resultsEl.innerHTML = '';
      matches.forEach(ch => {
        const name    = ch.fields['Channel Name'] || '';
        const logo    = (ch.fields['Logo URL'] || '').trim();
        const initial = name.trim().charAt(0).toUpperCase();
        const item    = document.createElement('div');
        item.className = 'search-modal-item';
        item.innerHTML = `
          ${logo ? `<img class="search-modal-logo" src="${esc(logo)}" alt="${esc(name)}" loading="lazy">` : ''}
          <div class="search-modal-logo-fallback"${logo ? ' style="display:none"' : ''}>${esc(initial)}</div>
          <span class="search-modal-name">${esc(name)}</span>
        `;
        if (logo) {
          const img = item.querySelector('img');
          const fb  = item.querySelector('.search-modal-logo-fallback');
          img.addEventListener('error', () => { img.style.display = 'none'; fb.style.display = 'flex'; });
        }
        item.addEventListener('click', () => {
          window.location.href = channelHref(ch);
        });
        resultsEl.appendChild(item);
      });
    }

    icon.addEventListener('click', openModal);
    closeBtn.addEventListener('click', closeModal);
    modal.addEventListener('click', e => { if (e.target === modal) closeModal(); });
    document.addEventListener('keydown', e => {
      if (e.key === 'Escape' && modal.classList.contains('open')) closeModal();
    });
    modalInput.addEventListener('input', () => renderModalResults(modalInput.value));
  }
  setupSearch();

  // ---- Data fetching from GitHub JSON ----
  async function fetchChannelsJSON(country) {
    const res = await fetch(`${DATA_BASE}/channels-${country.toLowerCase()}.json`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = await res.json();
    return (json.channels || []).map(ch => ({
      id: ch.slug,
      url_slug: ch.url_slug || '',
      createdTime: ch.createdTime,
      fields: {
        'Channel Name': ch.name        || '',
        'Logo URL':     ch.logo        || '',
        'Description':  ch.description || '',
        'Genre':        ch.genre       || [],
        'Platform':     ch.platform    || [],
        'Country':      [country]
      }
    }));
  }

  const EPG_PLACEHOLDER = 'program information currently unavailable';

  async function fetchEPGForChannel(country, channelName) {
    try {
      const res = await fetch(`${DATA_BASE}/epg-${country.toLowerCase()}.json?t=${new Date().toISOString().slice(0, 13)}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      const lower = channelName.toLowerCase();
      const now   = Date.now();
      return (json.programs || [])
        .filter(p => {
          if ((p.channel || '').toLowerCase() !== lower) return false;
          const end = p.end ? new Date(p.end).getTime() : NaN;
          if (isNaN(end) || end <= now) return false;
          const title = (p.title || '').trim();
          if (!title || title.toLowerCase().startsWith(EPG_PLACEHOLDER)) return false;
          return true;
        })
        .map(p => ({
          fields: {
            'Show Title': p.title    || '',
            'Channel':    p.channel  || '',
            'Start Time': p.start    || '',
            'End Time':   p.end      || '',
            'Platform':   p.platform || ''
          }
        }))
        .sort((a, b) => new Date(a.fields['Start Time']) - new Date(b.fields['Start Time']));
    } catch (err) {
      console.warn('[EPG] fetch failed:', err.message);
      return [];
    }
  }

  function findChannelByName(channels, name) {
    const exact = channels.find(ch => ch.fields['Channel Name'] === name);
    if (exact) return exact;
    const lower = name.toLowerCase();
    return channels.find(ch => (ch.fields['Channel Name'] || '').toLowerCase() === lower) || null;
  }

  function getSimilarChannels(channels, genres, excludeName) {
    if (!genres.length) return [];
    const genreSet     = new Set(genres);
    const excludeLower = excludeName.toLowerCase();
    return channels
      .filter(ch =>
        (ch.fields['Channel Name'] || '').toLowerCase() !== excludeLower &&
        (ch.fields['Genre'] || []).some(g => genreSet.has(g))
      )
      .slice(0, 6);
  }

  // ---- TVmaze API ----
  async function fetchTVmazeShow(title) {
    const key = 'tvmaze_show_' + title.toLowerCase().slice(0, 80);
    const cached = sessionStorage.getItem(key);
    if (cached) { try { return JSON.parse(cached); } catch (_) {} }
    try {
      const res = await fetch(`https://api.tvmaze.com/singlesearch/shows?q=${encodeURIComponent(title)}`);
      if (!res.ok) return null;
      const data = await res.json();
      try { sessionStorage.setItem(key, JSON.stringify(data)); } catch (_) {}
      return data;
    } catch (_) { return null; }
  }

  async function fetchTVmazeBackdrop(showId, fallbackUrl) {
    const key = `tvmaze_bg_${showId}`;
    const cached = sessionStorage.getItem(key);
    if (cached) return cached === 'null' ? null : cached;
    let result = fallbackUrl || null;
    try {
      const res = await fetch(`https://api.tvmaze.com/shows/${showId}/images`);
      if (res.ok) {
        const images = await res.json();
        const bg = images.find(img => img.type === 'background');
        if (bg) result = bg.resolutions?.original?.url || bg.resolutions?.medium?.url || result;
      }
    } catch (_) {}
    try { sessionStorage.setItem(key, result ?? 'null'); } catch (_) {}
    return result;
  }

  function applyHeroBackdrop(imageUrl) {
    if (_backdropApplied || !imageUrl) return;
    _backdropApplied = true;
    const hero = document.getElementById('detailHero');
    if (!hero) return;
    const img = new Image();
    img.onload = () => {
      const backdrop = document.createElement('div');
      backdrop.className = 'detail-hero-backdrop';
      backdrop.style.backgroundImage = `url(${JSON.stringify(imageUrl)})`;
      hero.insertBefore(backdrop, hero.firstChild);
      hero.classList.add('has-backdrop');
      requestAnimationFrame(() => requestAnimationFrame(() => backdrop.classList.add('loaded')));
    };
    img.onerror = () => { _backdropApplied = false; };
    img.src = imageUrl;
  }

  async function fetchTVmazeCast(showId) {
    try {
      const res = await fetch(`https://api.tvmaze.com/shows/${showId}/cast`);
      if (!res.ok) return [];
      return await res.json();
    } catch (_) { return []; }
  }

  async function fetchTVmazeEpisodes(showId) {
    try {
      const res = await fetch(`https://api.tvmaze.com/shows/${showId}/episodes`);
      if (!res.ok) return [];
      return await res.json();
    } catch (_) { return []; }
  }

  // ---- OMDb API ----
  async function fetchOMDbShow(title, type) {
    const apiKey = (typeof CONFIG !== 'undefined' && CONFIG.OMDB_API_KEY) ? CONFIG.OMDB_API_KEY : '';
    if (!apiKey || apiKey === 'YOUR_KEY') return null;
    const typeParam = type ? `&type=${encodeURIComponent(type)}` : '';
    const key = `omdb_show_${type || 'any'}_` + title.toLowerCase().slice(0, 80);
    const cached = sessionStorage.getItem(key);
    if (cached) { try { return JSON.parse(cached); } catch (_) {} }
    try {
      const res = await fetch(`https://www.omdbapi.com/?t=${encodeURIComponent(title)}&apikey=${encodeURIComponent(apiKey)}${typeParam}`);
      if (!res.ok) return null;
      const data = await res.json();
      if (data.Response !== 'True') return null;
      try { sessionStorage.setItem(key, JSON.stringify(data)); } catch (_) {}
      return data;
    } catch (_) { return null; }
  }

  async function fetchShowMetadata(title, channelName, channelGenres) {
    const isMovie  = isMovieChannel(channelName, channelGenres);
    const omdbType = isMovie ? 'movie' : 'series';

    if (!isMovie) {
      const tvmaze = await fetchTVmazeShow(title);
      if (tvmaze) {
        const lang = tvmaze.language || 'English';
        if (lang !== 'English') {
          // Non-English result — discard and fall through to OMDb
        } else if (titleMatchesQuery(tvmaze.name, title)) {
          return { source: 'tvmaze', data: tvmaze };
        }
      }
    }

    const omdb = await fetchOMDbShow(title, omdbType);
    if (omdb && titleMatchesQuery(omdb.Title, title)) {
      return { source: 'omdb', data: omdb };
    }

    return null;
  }

  // ---- Render hero ----
  function renderHero(record) {
    const f         = record.fields;
    const name      = f['Channel Name'] || 'Unnamed Channel';
    const logo      = (f['Logo URL'] || '').trim();
    const desc      = f['Description'] || '';
    const platforms = f['Platform'] || [];
    const genres    = f['Genre'] || [];
    const initial   = name.trim().charAt(0).toUpperCase();

    document.title = `${name} — WhatsOnFreeTV`;
    document.querySelector('meta[name="description"]')
      ?.setAttribute('content', desc.slice(0, 160) || `${name} on WhatsOnFreeTV`);

    const { country: ctxCountry } = _backParams();
    const countryDisplay = ctxCountry === 'CA' ? '&#127464;&#127462; CA' : '&#127482;&#127480; US';

    const hero = document.getElementById('detailHero');
    hero.innerHTML = `
      <div class="detail-logo-wrap">
        ${logo ? `<img src="${esc(logo)}" alt="${esc(name)}" id="detailImg">` : ''}
        <div class="detail-logo-fallback" id="detailFallback" style="${logo ? 'display:none' : ''}">${esc(initial)}</div>
      </div>
      <div class="detail-info">
        <a href="${esc(backHref())}" class="detail-back">&#8592; ${backLabel()}</a>
        ${countryDisplay ? `<div class="detail-country">${countryDisplay}</div>` : ''}
        <h1 class="detail-channel-name">${esc(name)}</h1>
        <p class="detail-description">${esc(desc || `Free 24/7 streaming channel available on ${platforms.length ? platforms.join(', ') : 'free platforms'}.`)}</p>
        ${genres.length ? `
          <div class="detail-section">
            <div class="detail-section-label">Genre</div>
            <div class="badge-row">
              ${genres.map(g => `<a href="${esc(backHref())}?genre=${encodeURIComponent(g)}" class="badge badge-genre" data-genre="${esc(g)}">${esc(g)}</a>`).join('')}
            </div>
          </div>` : ''}
        ${platforms.length ? `
          <div class="detail-section">
            <div class="detail-section-label">Available On</div>
            <div class="badge-row">
              ${platforms.map(p => `<a href="${esc(backHref())}?platform=${encodeURIComponent(p)}" class="badge ${platformClass(p)}">${esc(p)}</a>`).join('')}
            </div>
          </div>` : ''}
      </div>
    `;

    if (logo) {
      attachLogoFallback(hero.querySelector('#detailImg'), hero.querySelector('#detailFallback'));
    }
  }

  // ---- Render On Now ----
  function renderOnNow(programs, body, isClickable, channelName) {
    if (!Array.isArray(programs) || !programs.length) return;
    const now = Date.now();
    const current = programs.find(p => {
      const start = new Date(p.fields['Start Time']).getTime();
      const end   = new Date(p.fields['End Time']).getTime();
      return !isNaN(start) && !isNaN(end) && start <= now && now <= end;
    });
    if (!current) return;
    const showTitle = current.fields['Show Title'];
    if (!showTitle) return;
    const remaining = current.fields['End Time'] ? timeRemaining(current.fields['End Time']) : null;

    const section = document.createElement('div');
    section.className = 'detail-epg-section';
    section.innerHTML = `
      <h2 class="detail-section-title">
        <span class="epg-live-badge">&#9679; On Now</span>
      </h2>
      <div class="on-now-card" id="onNowCard">
        <div class="on-now-info">
          <div class="on-now-show-title">${esc(showTitle)}</div>
          <div class="on-now-meta">
            <span class="on-now-rating" id="onNowRating" style="display:none"></span>
            ${remaining ? `<span class="on-now-time-remaining">${esc(remaining)}</span>` : ''}
          </div>
          ${isClickable ? `<button class="on-now-more-btn" aria-label="More info about ${esc(showTitle)}">More Info &#8594;</button>` : ''}
        </div>
      </div>
    `;

    if (isClickable) {
      section.querySelector('.on-now-more-btn').addEventListener('click', e => {
        e.stopPropagation();
        openShowModal(current, channelName || '', false);
      });
    }

    body.appendChild(section);

    if (isClickable) {
      fetchShowMetadata(showTitle, _channel.name, _channel.genres).then(result => {
        if (!result) return;
        const card     = section.querySelector('#onNowCard');
        const ratingEl = section.querySelector('#onNowRating');
        let poster = null, rating = null;
        if (result.source === 'tvmaze') {
          poster = result.data.image?.medium || result.data.image?.original || null;
          rating = result.data.rating?.average || null;
        } else if (result.source === 'omdb') {
          poster = (result.data.Poster && result.data.Poster !== 'N/A') ? result.data.Poster : null;
          rating = (result.data.imdbRating && result.data.imdbRating !== 'N/A') ? result.data.imdbRating : null;
        }
        if (poster && card) {
          const img = new Image();
          img.alt = showTitle;
          img.onload = () => {
            const wrap = document.createElement('div');
            wrap.className = 'on-now-poster';
            wrap.appendChild(img);
            card.insertBefore(wrap, card.firstChild);
          };
          img.src = poster;
        }
        if (rating && ratingEl) {
          ratingEl.textContent = `⭐ ${rating}/10`;
          ratingEl.style.display = 'inline';
        }
        if (result.source === 'tvmaze' && result.data?.id) {
          fetchTVmazeBackdrop(result.data.id, result.data.image?.original || null)
            .then(applyHeroBackdrop);
        }
      });
    }
  }

  // ---- Render Coming Up Next ----
  function renderUpNext(programs, body, isClickable, channelName) {
    if (!Array.isArray(programs) || !programs.length) return;
    const now = Date.now();

    const FIVE_MIN = 5 * 60 * 1000;
    const seen = new Set();
    const upcoming = programs
      .filter(p => {
        const start = new Date(p.fields['Start Time']).getTime();
        if (isNaN(start) || start <= now) return false;
        const roundedStart = Math.round(start / FIVE_MIN) * FIVE_MIN;
        const title = (p.fields['Show Title'] || '').trim().toLowerCase();
        const key = `${roundedStart}|${title}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      })
      .slice(0, 5);

    if (!upcoming.length) return;

    const section = document.createElement('div');
    section.className = 'detail-epg-section';
    section.innerHTML = `<h2 class="detail-section-title">Coming Up Next</h2><div class="schedule-list"></div>`;
    const list = section.querySelector('.schedule-list');

    upcoming.forEach(p => {
      const title     = p.fields['Show Title'] || 'Unknown Show';
      const startTime = p.fields['Start Time'] ? formatTime(p.fields['Start Time']) : '';
      const item      = document.createElement('div');
      item.className  = 'schedule-item' + (isClickable ? ' clickable' : '');
      item.innerHTML  = `
        <span class="schedule-time">${esc(startTime)}</span>
        <span class="schedule-title">${esc(title)}</span>
      `;
      if (isClickable) {
        item.addEventListener('click', () => openShowModal(p, channelName || '', true));
      }
      list.appendChild(item);
    });

    body.appendChild(section);
  }

  // ---- Render Similar Channels ----
  function renderSimilar(channels, body) {
    if (!channels.length) return;

    const section = document.createElement('div');
    section.className = 'detail-similar-section';
    section.innerHTML = `
      <div class="genre-header">
        <h2 class="genre-title">Similar Channels</h2>
        <span class="genre-count">${channels.length}</span>
      </div>
      <div class="row-container">
        <button class="scroll-btn left" aria-label="Scroll left">&#8249;</button>
        <div class="channels-row"></div>
        <button class="scroll-btn right" aria-label="Scroll right">&#8250;</button>
      </div>
    `;

    const row = section.querySelector('.channels-row');
    channels.forEach(ch => {
      const f       = ch.fields;
      const name    = f['Channel Name'] || 'Unknown';
      const logo    = (f['Logo URL'] || '').trim();
      const initial = name.trim().charAt(0).toUpperCase();

      const card = document.createElement('div');
      card.className = 'channel-card';
      card.setAttribute('role', 'button');
      card.setAttribute('tabindex', '0');
      card.innerHTML = `
        <div class="card-thumb">
          ${logo ? `<img src="${esc(logo)}" alt="${esc(name)}" loading="lazy">` : ''}
          <div class="card-fallback" style="${logo ? '' : 'display:flex'}">${esc(initial)}</div>
        </div>
        <div class="card-footer">
          <div class="card-label">${esc(name)}</div>
        </div>
      `;

      if (logo) attachLogoFallback(card.querySelector('img'), card.querySelector('.card-fallback'));

      const navigate = () => { window.location.href = channelHref(ch); };
      card.addEventListener('click', navigate);
      card.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') navigate(); });
      row.appendChild(card);
    });

    const scrollAmt = 620;
    section.querySelector('.scroll-btn.left').addEventListener('click', () =>
      row.scrollBy({ left: -scrollAmt, behavior: 'smooth' }));
    section.querySelector('.scroll-btn.right').addEventListener('click', () =>
      row.scrollBy({ left: scrollAmt, behavior: 'smooth' }));

    body.appendChild(section);
  }

  // ---- TVmaze: show hero (single-show experience) ----
  function renderShowHero(show, container) {
    const poster  = show.image?.medium || show.image?.original || null;
    const rating  = show.rating?.average;
    const status  = show.status || '';
    const network = show.network?.name || show.webChannel?.name || '';
    const genres  = show.genres || [];
    const statusClass = status.toLowerCase() === 'running' ? 'show-status-running' : 'show-status-ended';

    const el = document.createElement('div');
    el.className = 'detail-epg-section';
    el.innerHTML = `
      <div class="show-hero">
        ${poster ? `<div class="show-poster"><img src="${esc(poster)}" alt="${esc(show.name || '')}" id="tvShowPosterImg"></div>` : ''}
        <div class="show-hero-info">
          <h2 class="show-hero-title">${esc(show.name || '')}</h2>
          ${rating ? `<div class="show-rating">&#11088; ${rating}/10</div>` : ''}
          <div>${status ? `<span class="${statusClass}">${esc(status)}</span>` : ''}</div>
          ${network ? `<div class="show-network">${esc(network)}</div>` : ''}
          ${genres.length ? `<div class="show-genres">${genres.map(g => `<span class="show-genre-pill">${esc(g)}</span>`).join('')}</div>` : ''}
        </div>
      </div>
    `;

    if (poster) {
      attachLogoFallback(el.querySelector('#tvShowPosterImg'), el.querySelector('#tvShowPosterFallback'));
    }
    container.appendChild(el);
  }

  // ---- TVmaze: synopsis ----
  function renderSynopsis(show, container) {
    const summary = show.summary ? stripHtml(show.summary) : '';
    if (!summary) return;
    const el = document.createElement('div');
    el.className = 'detail-epg-section show-synopsis';
    el.innerHTML = `
      <div class="show-synopsis-title">Synopsis</div>
      <div class="show-synopsis-text">${esc(summary)}</div>
    `;
    container.appendChild(el);
  }

  // ---- TVmaze: cast ----
  function renderCast(cast, container) {
    const topCast = cast.slice(0, 8);
    if (!topCast.length) return;
    const el = document.createElement('div');
    el.className = 'detail-epg-section cast-section';

    const cards = topCast.map(member => {
      const actor    = member.person;
      const character = member.character;
      const photo    = actor?.image?.medium || actor?.image?.original || null;
      const actorName = actor?.name || '';
      const charName  = character?.name || '';
      return `
        <div class="cast-card">
          <div class="cast-photo">
            ${photo
              ? `<img src="${esc(photo)}" alt="${esc(actorName)}" loading="lazy" onerror="this.style.display='none';this.nextElementSibling.style.display='flex'">`
              : ''}
            <div class="cast-photo-fallback" style="${photo ? 'display:none' : ''}">&#128100;</div>
          </div>
          <div class="cast-actor-name">${esc(actorName)}</div>
          ${charName ? `<div class="cast-char-name">${esc(charName)}</div>` : ''}
        </div>`;
    }).join('');

    el.innerHTML = `
      <div class="cast-section-title">Cast</div>
      <div class="cast-row">${cards}</div>
    `;
    container.appendChild(el);
  }

  // ---- TVmaze: seasons & episodes ----
  function renderSeasonsEpisodes(episodes, container) {
    if (!episodes.length) return;

    const seasons = {};
    episodes.forEach(ep => {
      const s = ep.season || 1;
      if (!seasons[s]) seasons[s] = [];
      seasons[s].push(ep);
    });
    const seasonNums = Object.keys(seasons).map(Number).sort((a, b) => a - b);

    const el = document.createElement('div');
    el.className = 'detail-epg-section seasons-section';
    el.innerHTML = `<div class="seasons-section-title">Seasons &amp; Episodes</div>`;

    seasonNums.forEach(sNum => {
      const eps    = seasons[sNum];
      const isOpen = false;
      const block  = document.createElement('div');
      block.className = 'season-block';

      const episodeRows = eps.map(ep => {
        const desc = ep.summary ? stripHtml(ep.summary) : '';
        const truncDesc = desc.length > 120 ? desc.slice(0, 120) + '…' : desc;
        return `
          <div class="episode-item">
            <div class="episode-num">E${ep.number}</div>
            <div>
              <div class="episode-title">${esc(ep.name || 'TBA')}</div>
              ${truncDesc ? `<div class="episode-desc">${esc(truncDesc)}</div>` : ''}
            </div>
            <div class="episode-date">${ep.airdate ? formatDate(ep.airdate) : ''}</div>
          </div>`;
      }).join('');

      block.innerHTML = `
        <div class="season-header" role="button" tabindex="0">
          <span class="season-header-label">Season ${sNum}</span>
          <span class="season-header-meta">
            <span class="season-header-count">${eps.length} episode${eps.length !== 1 ? 's' : ''}</span>
            <span class="season-chevron${isOpen ? ' open' : ''}">&#9660;</span>
          </span>
        </div>
        <div class="season-episodes${isOpen ? ' open' : ''}">${episodeRows}</div>
      `;

      const header     = block.querySelector('.season-header');
      const episodesEl = block.querySelector('.season-episodes');
      const chevron    = block.querySelector('.season-chevron');
      const toggle = () => {
        const open = episodesEl.classList.toggle('open');
        chevron.classList.toggle('open', open);
      };
      header.addEventListener('click', toggle);
      header.addEventListener('keydown', e => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(); }
      });
      el.appendChild(block);
    });

    container.appendChild(el);
  }

  // ---- TVmaze: attribution ----
  function renderTVmazeAttribution(container) {
    const el = document.createElement('div');
    el.className = 'detail-epg-section tvmaze-attribution';
    el.innerHTML = `Show data provided by <a href="https://www.tvmaze.com" target="_blank" rel="noopener">TVmaze</a>`;
    container.appendChild(el);
  }

  // ---- Experience 1: single-show channel ----
  async function renderSingleShowExperience(title, programs, container) {
    container.innerHTML = `
      <div class="detail-epg-section">
        <div class="skeleton" style="height:200px;border-radius:8px;"></div>
      </div>`;

    const show = await fetchTVmazeShow(title);
    container.innerHTML = '';

    if (!show) {
      renderOnNow(programs, container);
      renderUpNext(programs, container);
      return;
    }

    fetchTVmazeBackdrop(show.id, show.image?.original || null).then(applyHeroBackdrop);

    const [cast, episodes] = await Promise.all([
      fetchTVmazeCast(show.id),
      fetchTVmazeEpisodes(show.id)
    ]);

    renderOnNow(programs, container);
    renderUpNext(programs, container);
    renderShowHero(show, container);
    renderSynopsis(show, container);
    if (cast.length)    renderCast(cast, container);
    if (episodes.length) renderSeasonsEpisodes(episodes, container);
    renderTVmazeAttribution(container);
  }

  // ---- Experience 2: show detail modal ----
  function openShowModal(program, channelName, isUpcoming) {
    const showTitle = program.fields['Show Title'] || 'Unknown Show';
    const platform  = program.fields['Platform'] || '';
    const startTime = program.fields['Start Time'];
    const endTime   = program.fields['End Time'];

    const backdrop = document.createElement('div');
    backdrop.className = 'show-modal-backdrop';
    backdrop.setAttribute('role', 'dialog');
    backdrop.setAttribute('aria-modal', 'true');
    const logoHtml = _channel.logo
      ? `<img class="show-modal-channel-logo" src="${esc(_channel.logo)}" alt="${esc(_channel.name)}"
              onerror="this.outerHTML='<div class=\\'show-modal-channel-fallback\\'>${esc(_channel.initial)}</div>'">`
      : `<div class="show-modal-channel-fallback">${esc(_channel.initial)}</div>`;

    backdrop.innerHTML = `
      <div class="show-modal">
        <div class="show-modal-channel-header">
          ${logoHtml}
          <span class="show-modal-channel-name">${esc(_channel.name)}</span>
          <button class="show-modal-close" aria-label="Close">&times;</button>
        </div>
        <div class="show-modal-inner">
          <div class="show-modal-spinner"><div class="spinner"></div></div>
        </div>
      </div>
    `;

    const closeModal = () => {
      backdrop.remove();
      document.body.style.overflow = '';
    };
    backdrop.querySelector('.show-modal-close').addEventListener('click', closeModal);
    backdrop.addEventListener('click', e => { if (e.target === backdrop) closeModal(); });
    const escHandler = e => {
      if (e.key === 'Escape') { closeModal(); document.removeEventListener('keydown', escHandler); }
    };
    document.addEventListener('keydown', escHandler);

    document.body.style.overflow = 'hidden';
    document.body.appendChild(backdrop);

    const inner = backdrop.querySelector('.show-modal-inner');

    const timeStr = startTime && endTime
      ? `${formatTime(startTime)} &ndash; ${formatTime(endTime)}`
      : startTime ? formatTime(startTime) : '';
    const platformBadge = platform
      ? ` &middot; <span class="badge ${platformClass(platform)}">${esc(platform)}</span>` : '';
    const airingBlock = channelName ? `
      <div class="show-modal-airing">
        ${isUpcoming
          ? `<div class="show-modal-airing-label">&#9197; Coming up on ${esc(channelName)}</div>`
          : `<div class="show-modal-airing-label">&#9679; Currently airing on ${esc(channelName)}</div>`}
        ${timeStr ? `<div class="show-modal-airing-info">${timeStr}${platformBadge}</div>` : ''}
      </div>` : '';

    fetchShowMetadata(showTitle, _channel.name, _channel.genres).then(result => {
      if (!result) {
        inner.innerHTML = `
          <div class="show-modal-title">${esc(showTitle)}</div>
          ${airingBlock}
          <div style="color:var(--text-dim);font-size:0.82rem;margin-top:12px">Show details not available</div>
        `;
        return;
      }

      if (result.source === 'tvmaze') {
        const show     = result.data;
        const poster   = show.image?.medium || show.image?.original || null;
        const rating   = show.rating?.average;
        const status   = show.status || '';
        const network  = show.network?.name || show.webChannel?.name || '';
        const genres   = show.genres || [];
        const summary  = show.summary ? stripHtml(show.summary) : '';
        const truncSum = summary.length > 300 ? summary.slice(0, 300) + '…' : summary;
        const statusClass = status.toLowerCase() === 'running' ? 'show-status-running' : 'show-status-ended';
        inner.innerHTML = `
          <div class="show-modal-header">
            ${poster ? `<div class="show-modal-poster"><img src="${esc(poster)}" alt="${esc(show.name || showTitle)}"></div>` : ''}
            <div class="show-modal-info">
              <div class="show-modal-title">${esc(show.name || showTitle)}</div>
              ${rating ? `<div class="show-modal-rating">&#11088; ${rating}/10</div>` : ''}
              ${genres.length ? `<div class="show-modal-genres">${genres.map(g => `<span class="show-modal-genre-pill">${esc(g)}</span>`).join('')}</div>` : ''}
              <div class="show-modal-meta">
                ${status ? `<span class="${statusClass}">${esc(status)}</span>` : ''}
                ${network ? `<span>${esc(network)}</span>` : ''}
              </div>
            </div>
          </div>
          ${truncSum ? `<div class="show-modal-summary">${esc(truncSum)}</div>` : ''}
          ${airingBlock}
          <div class="show-modal-attribution">Show data from <a href="https://www.tvmaze.com" target="_blank" rel="noopener">TVmaze</a></div>
        `;
      } else {
        const d        = result.data;
        const poster   = (d.Poster && d.Poster !== 'N/A') ? d.Poster : null;
        const rating   = (d.imdbRating && d.imdbRating !== 'N/A') ? d.imdbRating : null;
        const plot     = (d.Plot && d.Plot !== 'N/A') ? d.Plot : '';
        const director = (d.Director && d.Director !== 'N/A') ? d.Director : '';
        const actors   = (d.Actors && d.Actors !== 'N/A') ? d.Actors : '';
        const genres   = (d.Genre && d.Genre !== 'N/A') ? d.Genre.split(',').map(g => g.trim()) : [];
        const typeLabel = d.Type === 'movie' ? 'MOVIE' : d.Type === 'series' ? 'SERIES' : '';
        const year     = (d.Year && d.Year !== 'N/A') ? d.Year : '';
        inner.innerHTML = `
          <div class="show-modal-header">
            ${poster ? `<div class="show-modal-poster" id="omdbPosterWrap"><img src="${esc(poster)}" alt="${esc(d.Title || showTitle)}" onerror="this.closest('.show-modal-poster').remove()"></div>` : ''}
            <div class="show-modal-info">
              <div class="show-modal-title">${esc(d.Title || showTitle)}</div>
              ${rating ? `<div class="show-modal-rating">&#11088; ${esc(rating)}/10</div>` : ''}
              ${genres.length ? `<div class="show-modal-genres">${genres.map(g => `<span class="show-modal-genre-pill">${esc(g)}</span>`).join('')}</div>` : ''}
              <div class="show-modal-meta">
                ${typeLabel ? `<span class="show-status-ended">${typeLabel}</span>` : ''}
                ${year ? `<span>${esc(year)}</span>` : ''}
              </div>
            </div>
          </div>
          ${plot ? `<div class="show-modal-summary">${esc(plot)}</div>` : ''}
          ${director ? `<div class="show-modal-omdb-meta">Director: ${esc(director)}</div>` : ''}
          ${actors ? `<div class="show-modal-omdb-meta">Cast: ${esc(actors)}</div>` : ''}
          ${airingBlock}
          <div class="show-modal-attribution">Data from <a href="https://www.omdbapi.com" target="_blank" rel="noopener">OMDb</a></div>
        `;
      }
    });
  }

  // ---- Load & render ----
  async function load() {
    const params = new URLSearchParams(window.location.search);

    // ?slug= — lookup by url_slug (used by channel cards and /channel/:slug redirect)
    const slugParam = params.get('slug');

    // ?id= — legacy lookup by channel name
    const rawId = params.get('id');
    const channelName = rawId ? decodeURIComponent(rawId) : null;

    const country = sessionStorage.getItem('woftv_country') || 'US';

    if (!slugParam && !channelName) { showError(); return; }

    let channels;
    try {
      channels = await fetchChannelsJSON(country);
    } catch (err) {
      showError();
      return;
    }

    let record;
    if (slugParam) {
      record = channels.find(ch => ch.url_slug === slugParam) || null;
      // Fallback: if url_slug not yet backfilled, try matching by old slug field
      if (!record) record = channels.find(ch => ch.id === slugParam) || null;
    } else {
      record = findChannelByName(channels, channelName);
    }

    if (!record) { showError(); return; }

    renderHero(record);

    const name   = record.fields['Channel Name'] || '';
    const genres = record.fields['Genre'] || [];
    _channel = {
      name,
      logo:    (record.fields['Logo URL'] || '').trim(),
      initial: name.trim().charAt(0).toUpperCase(),
      genres
    };

    sessionStorage.setItem('woftv_country', country);

    const body = document.getElementById('detailBody');
    body.style.display = 'block';

    const epgContainer = document.createElement('div');
    epgContainer.innerHTML = `
      <div class="detail-epg-section">
        <div class="skeleton skeleton-title" style="width:100px;margin-bottom:12px;"></div>
        <div class="skeleton" style="height:64px;border-radius:8px;"></div>
      </div>
    `;
    body.appendChild(epgContainer);

    renderSimilar(getSimilarChannels(channels, genres, name), body);

    const link = document.createElement('a');
    link.href = `${SITE_ROOT}suggest.html?name=${encodeURIComponent(name)}`;
    link.className = 'detail-suggest-edit';
    link.textContent = 'Suggest an edit to this channel';
    body.appendChild(link);

    fetchEPGForChannel(country, name)
      .then(async programs => {
        epgContainer.innerHTML = '';

        const titles = programs.map(p => p.fields['Show Title']).filter(Boolean);
        const titleCounts = titles.reduce((acc, t) => { acc[t] = (acc[t] || 0) + 1; return acc; }, {});
        const mostCommonEntry = Object.entries(titleCounts).sort((a, b) => b[1] - a[1])[0];
        const isSingleShow = mostCommonEntry && titles.length > 0 &&
          (mostCommonEntry[1] / titles.length) > 0.8;

        if (isSingleShow) {
          await renderSingleShowExperience(mostCommonEntry[0], programs, epgContainer);
        } else {
          renderOnNow(programs, epgContainer, true, name);
          renderUpNext(programs, epgContainer, true, name);
        }
      })
      .catch(() => {
        epgContainer.innerHTML = '';
      });
  }

  function showError() {
    document.getElementById('detailHero').style.display = 'none';
    document.getElementById('errorState').classList.remove('hidden');
  }

  load();
})();
