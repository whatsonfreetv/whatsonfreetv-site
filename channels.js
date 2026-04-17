// =============================================
// channels.js — Shared channel rendering logic
// Expects window.SITE_COUNTRY = 'US' | 'CA'
// =============================================

(function () {
  const COUNTRY   = window.SITE_COUNTRY || 'US';
  const CACHE_TTL = 5 * 60 * 1000;
  const ONE_WEEK  = 7 * 24 * 60 * 60 * 1000;

  let allChannels  = [];
  let allPrograms  = [];
  let activePlatform    = '';
  let activeGenre       = '';
  let activeView        = 'browse';
  let epgLoadPromise    = null; // tracks in-flight or completed EPG fetch

  // ============================================================
  // SESSION CACHE
  // ============================================================
  function getCached(key) {
    try {
      const raw = sessionStorage.getItem(key);
      if (!raw) return null;
      const { ts, data } = JSON.parse(raw);
      if (Date.now() - ts > CACHE_TTL) { sessionStorage.removeItem(key); return null; }
      return data;
    } catch { return null; }
  }

  function setCache(key, data) {
    try { sessionStorage.setItem(key, JSON.stringify({ ts: Date.now(), data })); } catch {}
  }

  // ============================================================
  // DATA FETCHING — GitHub static JSON
  // ============================================================
  const DATA_BASE = 'https://raw.githubusercontent.com/whatsonfreetv/whatsonfreetv-data/main';

  async function fetchAllChannels() {
    const key = `woftv_ch_${COUNTRY}`;
    const cached = getCached(key);
    if (cached) return cached;

    const res = await fetch(`${DATA_BASE}/channels-${COUNTRY.toLowerCase()}.json`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = await res.json();

    const records = (json.channels || []).map(ch => ({
      id: ch.slug,
      createdTime: ch.createdTime,
      fields: {
        'Channel Name': ch.name        || '',
        'Logo URL':     ch.logo        || '',
        'Description':  ch.description || '',
        'Genre':        ch.genre       || [],
        'Platform':     ch.platform    || [],
        'Country':      [COUNTRY]
      }
    }));

    setCache(key, records);
    return records;
  }

  // Process a large array in time-sliced batches to keep the main thread free.
  // filterFn(item) → bool, mapFn(item) → transformed item.
  function filterMapAsync(items, batchSize, filterFn, mapFn) {
    return new Promise(resolve => {
      const results = [];
      let i = 0;
      function step() {
        const end = Math.min(i + batchSize, items.length);
        for (; i < end; i++) {
          const item = items[i];
          if (filterFn(item)) results.push(mapFn(item));
        }
        if (i < items.length) {
          setTimeout(step, 0); // yield to browser between batches
        } else {
          resolve(results);
        }
      }
      step();
    });
  }

  async function fetchPrograms() {
    const isMobile = window.innerWidth < 768;
    // Separate cache keys so mobile and desktop don't share a narrowed/full dataset
    const key = `woftv_prog_${COUNTRY}${isMobile ? '_m' : ''}`;
    const cached = getCached(key);
    if (cached) return cached;

    try {
      let records;

      if (isMobile) {
        // ── Mobile: delegate filtering to the Netlify function ──────────────
        // The server fetches the full 48 k-program JSON, filters it to a
        // [-30 min, +6 h] window, and returns only the matching slice.
        // This prevents mobile Safari from freezing on a large parse + filter.
        const res = await fetch(`/.netlify/functions/epg?country=${COUNTRY}&hours=6`);
        if (!res.ok) throw new Error(`EPG function returned HTTP ${res.status}`);
        const json = await res.json();

        // Server already filtered by time and stripped placeholders; just map fields.
        records = (json.programs || []).map(p => ({
          fields: {
            'Show Title': p.title    || '',
            'Channel':    p.channel  || '',
            'Start Time': p.start    || '',
            'End Time':   p.end      || '',
            'Platform':   p.platform || ''
          }
        }));

      } else {
        // ── Desktop: fetch full EPG from GitHub, filter with time-sliced batches ──
        // 12-hour horizon lets the Live Guide scroll well forward.
        const res = await fetch(`${DATA_BASE}/epg-${COUNTRY.toLowerCase()}.json?t=${new Date().toISOString().slice(0, 13)}`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const json = await res.json();

        const now         = Date.now();
        const PLACEHOLDER = 'program information currently unavailable';
        const lookback    = now;
        const horizon     = now + 12 * 60 * 60 * 1000;

        records = await filterMapAsync(
          json.programs || [],
          500, // batch size — yields to browser between every 500 items
          p => {
            const end   = p.end   ? new Date(p.end).getTime()   : NaN;
            const start = p.start ? new Date(p.start).getTime() : NaN;
            if (isNaN(end) || isNaN(start)) return false;
            if (end <= lookback || start >= horizon) return false;
            const title = (p.title || '').trim();
            if (!title || title.toLowerCase().startsWith(PLACEHOLDER)) return false;
            return true;
          },
          p => ({
            fields: {
              'Show Title': p.title    || '',
              'Channel':    p.channel  || '',
              'Start Time': p.start    || '',
              'End Time':   p.end      || '',
              'Platform':   p.platform || ''
            }
          })
        );
      }

      setCache(key, records);
      return records;
    } catch (err) {
      console.warn('[Programs] fetch failed:', err.message);
      return [];
    }
  }

  // Lazy EPG loader — deduplicates concurrent requests, respects sessionStorage cache
  function ensureEPG() {
    if (allPrograms.length) return Promise.resolve(allPrograms);
    if (epgLoadPromise) return epgLoadPromise;
    epgLoadPromise = fetchPrograms()
      .then(programs => { allPrograms = programs; return programs; })
      .catch(err => {
        console.warn('[EPG] load failed:', err.message);
        epgLoadPromise = null; // allow a retry next time
        return [];
      });
    return epgLoadPromise;
  }

  // Platform-filtered programs — in-memory, no extra fetch needed
  function fetchPlatformPrograms(platform) {
    const lower = platform.toLowerCase();
    return Promise.resolve(
      allPrograms.filter(p => (p.fields['Platform'] || '').toLowerCase() === lower)
    );
  }

  // Next program for a channel — in-memory lookup
  function fetchNextProgram(channelName) {
    const now   = Date.now();
    const lower = channelName.toLowerCase();
    const next  = allPrograms
      .filter(p => {
        if ((p.fields['Channel'] || '').toLowerCase() !== lower) return false;
        const start = new Date(p.fields['Start Time']).getTime();
        return !isNaN(start) && start > now;
      })
      .sort((a, b) => new Date(a.fields['Start Time']) - new Date(b.fields['Start Time']))[0] || null;
    return Promise.resolve(next);
  }

  // ============================================================
  // EPG UTILITIES
  // ============================================================
  function getAiring(programs) {
    const now    = Date.now();
    const FIVE_MIN = 5 * 60 * 1000;
    const seen   = new Set();
    return programs.filter(p => {
      const start = new Date(p.fields['Start Time']).getTime();
      const end   = new Date(p.fields['End Time']).getTime();
      if (isNaN(start) || isNaN(end) || !(start <= now && now <= end)) return false;
      const roundedStart = Math.round(start / FIVE_MIN) * FIVE_MIN;
      const title = (p.fields['Show Title'] || '').trim().toLowerCase();
      const key = `${roundedStart}|${title}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }

  // Map: channelNameLower → { current: program|null, next: program|null }
  function buildEPGMap(programs) {
    const now = Date.now();
    const map = new Map();
    programs.forEach(p => {
      const name  = (p.fields['Channel'] || '').toLowerCase().trim();
      if (!name) return;
      const start = new Date(p.fields['Start Time']).getTime();
      const end   = new Date(p.fields['End Time']).getTime();
      if (isNaN(start) || isNaN(end)) return;

      if (!map.has(name)) map.set(name, { current: null, next: null });
      const entry = map.get(name);

      if (start <= now && now <= end) {
        entry.current = p;
      } else if (start > now) {
        const existStart = entry.next
          ? new Date(entry.next.fields['Start Time']).getTime()
          : Infinity;
        if (start < existStart) entry.next = p;
      }
    });
    return map;
  }

  // Map: channelNameLower → channel record
  function buildChannelMap(channels) {
    const map = new Map();
    channels.forEach(ch => {
      map.set((ch.fields['Channel Name'] || '').toLowerCase().trim(), ch);
    });
    return map;
  }

  // ============================================================
  // TIME UTILITIES
  // ============================================================
  function timeRemaining(endTimeStr) {
    const mins = Math.round((new Date(endTimeStr).getTime() - Date.now()) / 60000);
    if (mins <= 0 || mins > 360) return null; // skip bad/stale data > 6 hours
    if (mins < 60) return `ends in ${mins}m`;
    const h = Math.floor(mins / 60), m = mins % 60;
    return `ends in ${h}h${m > 0 ? ' ' + m + 'm' : ''}`;
  }

  function formatTime12hr(dateStr) {
    const d = new Date(dateStr);
    if (isNaN(d.getTime())) return '';
    return d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true });
  }

  function isNewChannel(record) {
    if (!record.createdTime) return false;
    return Date.now() - new Date(record.createdTime).getTime() < ONE_WEEK;
  }

  // ============================================================
  // UTILITIES
  // ============================================================
  function esc(str) {
    const d = document.createElement('div');
    d.textContent = String(str || '');
    return d.innerHTML;
  }

  function debounce(fn, ms) {
    let t;
    return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
  }

  function attachLogoFallback(img, fallbackEl) {
    if (!img) return;
    img.addEventListener('error', function () {
      this.style.display = 'none';
      if (fallbackEl) fallbackEl.style.display = 'flex';
    });
  }

  // ============================================================
  // CHANNEL CARDS
  // ============================================================
  function buildCard(record, epgEntry) {
    const f         = record.fields;
    const name      = f['Channel Name'] || 'Unnamed Channel';
    const logo      = (f['Logo URL'] || '').trim();
    const platforms = (f['Platform'] || []).slice(0, 3);
    const initial   = name.trim().charAt(0).toUpperCase();
    const cardIsNew = isNewChannel(record);

    const nowShow  = epgEntry?.current?.fields?.['Show Title'];
    const nextShow = epgEntry?.next?.fields?.['Show Title'];

    const badgesHTML = platforms
      .map(p => `<span class="card-hover-badge">${esc(p)}</span>`)
      .join('');

    const card = document.createElement('div');
    card.className = 'channel-card';
    card.setAttribute('role', 'button');
    card.setAttribute('tabindex', '0');
    card.setAttribute('aria-label', name);

    card.innerHTML = `
      <div class="card-thumb">
        ${cardIsNew ? '<span class="card-new-badge">NEW</span>' : ''}
        ${logo ? `<img src="${esc(logo)}" alt="${esc(name)}" loading="lazy">` : ''}
        <div class="card-fallback" style="${logo ? '' : 'display:flex'}">${esc(initial)}</div>
        ${platforms.length
          ? `<div class="card-hover-info"><div class="card-hover-platforms">${badgesHTML}</div></div>`
          : ''}
      </div>
      <div class="card-footer">
        <div class="card-label">${esc(name)}</div>
        ${platforms.length ? `<div class="card-mobile-platforms">${platforms.map(p => esc(p)).join(' · ')}</div>` : ''}
        ${nowShow ? `<div class="card-epg-now"><span class="now-dot">&#9654;</span>${esc(nowShow)}</div>` : ''}
      </div>
    `;

    attachLogoFallback(card.querySelector('img'), card.querySelector('.card-fallback'));

    const navigate = () => {
      sessionStorage.setItem('woftv_country', COUNTRY);
      window.location.href = `channel.html?id=${encodeURIComponent(name)}`;
    };
    card.addEventListener('click', navigate);
    card.addEventListener('keydown', e => {
      if (e.key === 'Enter' || e.key === ' ') navigate();
    });

    return card;
  }

  // ============================================================
  // EPG SECTION — What's On Now
  // ============================================================
  function epgPlatformClass(p) {
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

  // ============================================================
  // EPG MODAL
  // ============================================================
  let epgModal = null;

  function ensureModal() {
    if (epgModal) return epgModal;
    const backdrop = document.createElement('div');
    backdrop.className = 'epg-modal-backdrop';
    backdrop.setAttribute('role', 'dialog');
    backdrop.setAttribute('aria-modal', 'true');
    backdrop.innerHTML = `
      <div class="epg-modal">
        <button class="epg-modal-close" aria-label="Close">&#x2715;</button>
        <div class="epg-modal-header">
          <div class="epg-modal-logo-wrap"></div>
          <span class="epg-modal-channel"></span>
        </div>
        <div class="epg-modal-body">
          <div class="epg-modal-show"></div>
          <div class="epg-modal-time"></div>
          <div class="epg-modal-platform"></div>
          <div class="epg-modal-next" style="display:none"></div>
          <div class="epg-modal-actions">
            <a class="epg-modal-btn epg-modal-btn-primary" href="#">View Channel</a>
            <button class="epg-modal-btn epg-modal-btn-secondary epg-modal-close-btn">Close</button>
          </div>
        </div>
      </div>
    `;
    document.body.appendChild(backdrop);
    epgModal = backdrop;

    const close = () => backdrop.classList.remove('open');
    backdrop.querySelector('.epg-modal-close').addEventListener('click', close);
    backdrop.querySelector('.epg-modal-close-btn').addEventListener('click', close);
    backdrop.addEventListener('click', e => { if (e.target === backdrop) close(); });
    document.addEventListener('keydown', e => { if (e.key === 'Escape') close(); });

    return backdrop;
  }

  function openEPGModal(program, channel) {
    const backdrop   = ensureModal();
    const f          = program.fields;
    const channelName = (f['Channel'] || '').trim();
    const showTitle   = f['Show Title'] || 'Unknown Show';
    const remaining   = f['End Time'] ? timeRemaining(f['End Time']) : null;
    const platform    = (f['Platform'] || '').trim();
    const logo        = (channel?.fields['Logo URL'] || '').trim();
    const initial     = (channelName || showTitle).trim().charAt(0).toUpperCase();
    const channelId   = channel?.id;

    const logoWrap = backdrop.querySelector('.epg-modal-logo-wrap');
    logoWrap.innerHTML = logo
      ? `<img class="epg-modal-logo" src="${esc(logo)}" alt="${esc(channelName)}">`
      : `<div class="epg-modal-logo-fallback">${esc(initial)}</div>`;
    if (logo) {
      const img = logoWrap.querySelector('img');
      img.addEventListener('error', () => {
        logoWrap.innerHTML = `<div class="epg-modal-logo-fallback">${esc(initial)}</div>`;
      });
    }

    backdrop.querySelector('.epg-modal-channel').textContent = channelName;
    backdrop.querySelector('.epg-modal-show').textContent    = showTitle;

    const timeEl = backdrop.querySelector('.epg-modal-time');
    timeEl.textContent = remaining || '';
    timeEl.style.display = remaining ? '' : 'none';

    const platEl = backdrop.querySelector('.epg-modal-platform');
    platEl.innerHTML = platform
      ? `<span class="badge ${epgPlatformClass(platform)}">${esc(platform)}</span>`
      : '';

    const nextEl = backdrop.querySelector('.epg-modal-next');
    nextEl.style.display = 'none';
    nextEl.textContent = '';
    fetchNextProgram(channelName).then(next => {
      if (next) {
        const title   = next.fields['Show Title'] || '';
        const timeStr = next.fields['Start Time'] ? formatTime12hr(next.fields['Start Time']) : '';
        nextEl.textContent = `Coming Up: ${title}${timeStr ? ' at ' + timeStr : ''}`;
        nextEl.style.display = '';
      }
    });

    const viewBtn = backdrop.querySelector('.epg-modal-btn-primary');
    if (channelName) {
      viewBtn.href = `channel.html?id=${encodeURIComponent(channelName)}`;
      viewBtn.style.display = '';
    } else {
      viewBtn.style.display = 'none';
    }

    backdrop.classList.add('open');
  }

  function buildEPGCard(program, channelMap) {
    const f           = program.fields;
    const channelName = (f['Channel'] || '').trim();
    const showTitle   = f['Show Title'] || 'Unknown Show';
    const remaining   = f['End Time'] ? timeRemaining(f['End Time']) : null;
    const platform    = (f['Platform'] || '').trim();

    const channel = channelMap.get(channelName.toLowerCase());
    const logo    = (channel?.fields['Logo URL'] || '').trim();
    const initial = (channelName || showTitle).trim().charAt(0).toUpperCase();

    const card = document.createElement('div');
    card.className = 'epg-card';
    card.setAttribute('role', 'button');
    card.setAttribute('tabindex', '0');
    card.setAttribute('aria-label', `${showTitle} on ${channelName}`);

    card.innerHTML = `
      <div class="epg-card-header">
        ${logo ? `<img class="epg-logo" src="${esc(logo)}" alt="${esc(channelName)}" loading="lazy">` : ''}
        <div class="epg-logo-fallback" style="${logo ? 'display:none' : ''}">${esc(initial)}</div>
        <span class="epg-channel-name">${esc(channelName)}</span>
        <span class="epg-live-badge" style="margin-left:auto;flex-shrink:0">&#9679; Live</span>
      </div>
      <div class="epg-card-body">
        <div class="epg-show-title">${esc(showTitle)}</div>
        ${remaining ? `<div class="epg-show-time">${esc(remaining)}</div>` : ''}
        ${platform ? `<div class="epg-card-platform"><span class="badge ${epgPlatformClass(platform)}">${esc(platform)}</span></div>` : ''}
      </div>
    `;

    if (logo) attachLogoFallback(card.querySelector('.epg-logo'), card.querySelector('.epg-logo-fallback'));

    const open = () => openEPGModal(program, channel);
    card.addEventListener('click', open);
    card.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') open(); });

    return card;
  }

  function renderEPG(programs, channelMap) {
    const airing  = getAiring(programs);
    const section = document.getElementById('epgSection');
    if (!section || !airing.length) return;

    const row     = document.getElementById('epgRow');
    const countEl = document.getElementById('epgCount');

    airing.forEach(p => row.appendChild(buildEPGCard(p, channelMap)));
    if (countEl) countEl.textContent = airing.length;

    const scrollAmt = 620;
    section.querySelector('.scroll-btn.left')?.addEventListener('click', () =>
      row.scrollBy({ left: -scrollAmt, behavior: 'smooth' }));
    section.querySelector('.scroll-btn.right')?.addEventListener('click', () =>
      row.scrollBy({ left: scrollAmt, behavior: 'smooth' }));

    section.dataset.hasContent = 'true';
    section.style.display = 'block';
  }

  // ============================================================
  // PLATFORM HERO
  // ============================================================
  function buildFeaturedCard(program, channelMap) {
    const f           = program.fields;
    const channelName = (f['Channel'] || '').trim();
    const showTitle   = f['Show Title'] || 'Unknown Show';
    const remaining   = f['End Time'] ? timeRemaining(f['End Time']) : null;

    const channel = channelMap.get(channelName.toLowerCase());
    const logo    = (channel?.fields['Logo URL'] || '').trim();
    const initial = (channelName || showTitle).trim().charAt(0).toUpperCase();

    const platform = (f['Platform'] || '').trim();

    const card = document.createElement('div');
    card.className = 'featured-epg-card';

    card.innerHTML = `
      <div class="featured-epg-thumb">
        ${logo ? `<img src="${esc(logo)}" alt="${esc(channelName)}" loading="lazy">` : ''}
        <div class="featured-epg-thumb-fallback"${logo ? ' style="display:none"' : ''}>${esc(initial)}</div>
        <span class="epg-live-badge featured-epg-live">&#9679; Live</span>
      </div>
      <div class="featured-epg-body">
        <div class="featured-epg-channel">${esc(channelName)}</div>
        <div class="featured-epg-title">${esc(showTitle)}</div>
        ${remaining ? `<div class="featured-epg-time">${esc(remaining)}</div>` : ''}
        ${platform ? `<div class="featured-epg-platform"><span class="badge ${epgPlatformClass(platform)}">${esc(platform)}</span></div>` : ''}
      </div>
    `;

    if (logo) attachLogoFallback(card.querySelector('img'), card.querySelector('.featured-epg-thumb-fallback'));

    const open = () => openEPGModal(program, channel);
    card.setAttribute('role', 'button');
    card.setAttribute('tabindex', '0');
    card.setAttribute('aria-label', `${f['Show Title'] || 'Unknown Show'} on ${channelName}`);
    card.style.cursor = 'pointer';
    card.addEventListener('click', open);
    card.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') open(); });

    return card;
  }

  async function renderPlatformHero(platform, programs, channelMap) {
    const section = document.getElementById('platformHero');
    if (!section) return;

    // Get the programs pool: platform-specific fetch (500 records) or initial pool (200)
    let pool;
    if (platform) {
      pool = await fetchPlatformPrograms(platform);
    } else {
      pool = programs;
    }

    // Build channel name sets for filtering
    const platformNames = platform ? new Set(
      allChannels
        .filter(ch => (ch.fields['Platform'] || []).includes(platform))
        .map(ch => (ch.fields['Channel Name'] || '').toLowerCase().trim())
    ) : null;

    const genreNames = activeGenre ? new Set(
      allChannels
        .filter(ch => (ch.fields['Genre'] || []).includes(activeGenre))
        .map(ch => (ch.fields['Channel Name'] || '').toLowerCase().trim())
    ) : null;

    const airing = getAiring(pool).filter(p => {
      const name = (p.fields['Channel'] || '').toLowerCase().trim();
      if (platformNames && !platformNames.has(name)) return false;
      if (genreNames   && !genreNames.has(name))    return false;
      return true;
    });

    if (!airing.length) {
      section.style.display = 'none';
      return;
    }

    const titleEl = section.querySelector('.platform-hero-title');
    if (titleEl) titleEl.textContent = platform ? `On ${platform} Now` : "What's On Now";

    // Replace row element to avoid duplicate scroll listeners
    const oldRow = section.querySelector('.featured-epg-row');
    const row = document.createElement('div');
    row.className = 'featured-epg-row';
    oldRow.replaceWith(row);

    airing.slice(0, 20).forEach(p => row.appendChild(buildFeaturedCard(p, channelMap)));

    const scrollAmt = 700;
    section.querySelector('.scroll-btn.left').onclick = () => row.scrollBy({ left: -scrollAmt, behavior: 'smooth' });
    section.querySelector('.scroll-btn.right').onclick = () => row.scrollBy({ left: scrollAmt, behavior: 'smooth' });

    section.style.display = 'block';
  }

  // ============================================================
  // PLATFORM PILLS
  // ============================================================
  function renderPlatformPills(channels) {
    const container = document.getElementById('platformPills');
    if (!container) return;

    const platforms = new Set();
    channels.forEach(ch => (ch.fields['Platform'] || []).forEach(p => platforms.add(p)));

    container.innerHTML = '';

    const allPill = document.createElement('button');
    allPill.className = 'platform-pill active';
    allPill.textContent = 'All Platforms';
    allPill.dataset.platform = '';
    container.appendChild(allPill);

    Array.from(platforms).sort().forEach(p => {
      const pill = document.createElement('button');
      pill.className = 'platform-pill';
      pill.textContent = p;
      pill.dataset.platform = p;
      container.appendChild(pill);
    });

    container.addEventListener('click', e => {
      const pill = e.target.closest('.platform-pill');
      if (!pill) return;
      container.querySelectorAll('.platform-pill').forEach(p => p.classList.remove('active'));
      pill.classList.add('active');
      activePlatform = pill.dataset.platform;
      applyFilters();
    });
  }

  // ============================================================
  // GENRE FILTER PILLS
  // ============================================================
  function setActiveGenre(genre) {
    activeGenre = genre;
    const container = document.getElementById('genrePills');
    if (!container) { applyFilters(); return; }

    // Update visible pill active states
    container.querySelectorAll('.platform-pill[data-genre]').forEach(el => {
      el.classList.toggle('active', el.dataset.genre === genre);
    });

    // Update dropdown item active states
    container.querySelectorAll('.genre-more-item').forEach(el => {
      el.classList.toggle('active', el.dataset.genre === genre);
    });

    // "More ▾" button turns red if selected genre is from the overflow list
    const moreBtn = container.querySelector('.genre-more-btn');
    if (moreBtn) {
      const isExtra = genre && !!Array.from(container.querySelectorAll('.genre-pill-extra'))
        .find(p => p.dataset.genre === genre);
      moreBtn.classList.toggle('active', isExtra);
    }

    applyFilters();
  }

  function renderGenrePills(channels) {
    const container = document.getElementById('genrePills');
    if (!container) return;

    // Count channels per genre
    const counts = {};
    channels.forEach(ch => {
      (ch.fields['Genre'] || []).forEach(g => { counts[g] = (counts[g] || 0) + 1; });
    });

    const sorted   = Object.keys(counts).sort((a, b) => counts[b] - counts[a]);
    const TOP_N    = 10;
    const topGenres  = sorted.slice(0, TOP_N);
    const moreGenres = sorted.slice(TOP_N).sort();

    container.innerHTML = '';

    // "All Genres" pill
    const allPill = document.createElement('button');
    allPill.className = 'platform-pill active';
    allPill.textContent = 'All Genres';
    allPill.dataset.genre = '';
    container.appendChild(allPill);

    // Top genres (always visible)
    topGenres.forEach(g => {
      const pill = document.createElement('button');
      pill.className = 'platform-pill';
      pill.textContent = g;
      pill.dataset.genre = g;
      container.appendChild(pill);
    });

    // Extra genres — visible on mobile (CSS), in dropdown on desktop
    moreGenres.forEach(g => {
      const pill = document.createElement('button');
      pill.className = 'platform-pill genre-pill-extra';
      pill.textContent = g;
      pill.dataset.genre = g;
      container.appendChild(pill);
    });

    // "More ▾" wrap — sits inside the pills row as the last flex item.
    // Dropdown uses position: fixed so it's never clipped by overflow-x: auto.
    if (moreGenres.length) {
      const moreWrap = document.createElement('div');
      moreWrap.className = 'genre-more-wrap';

      const moreBtn = document.createElement('button');
      moreBtn.className = 'platform-pill genre-more-btn';
      moreBtn.innerHTML = 'More &#9660;';

      const dropdown = document.createElement('div');
      dropdown.className = 'genre-more-dropdown';

      moreGenres.forEach(g => {
        const item = document.createElement('button');
        item.className = 'genre-more-item';
        item.textContent = g;
        item.dataset.genre = g;
        dropdown.appendChild(item);
      });

      moreWrap.appendChild(moreBtn);
      moreWrap.appendChild(dropdown);
      container.appendChild(moreWrap); // inside the pills row, last item

      moreBtn.addEventListener('click', e => {
        e.stopPropagation();
        if (dropdown.classList.contains('open')) {
          dropdown.classList.remove('open');
          return;
        }
        // Position below the button using fixed coords (not clipped by any overflow)
        const rect = moreBtn.getBoundingClientRect();
        dropdown.style.top  = (rect.bottom + 6) + 'px';
        dropdown.style.left = rect.left + 'px';
        dropdown.classList.add('open');
      });

      dropdown.addEventListener('click', e => {
        const item = e.target.closest('.genre-more-item');
        if (!item) return;
        setActiveGenre(item.dataset.genre);
        dropdown.classList.remove('open');
      });

      document.addEventListener('click', () => dropdown.classList.remove('open'));
    }

    // Delegated click for visible pills (All Genres + top genres + mobile extras)
    container.addEventListener('click', e => {
      const pill = e.target.closest('.platform-pill[data-genre]');
      if (!pill || pill.classList.contains('genre-more-btn')) return;
      setActiveGenre(pill.dataset.genre);
    });
  }

  // ============================================================
  // GENRE ROWS
  // ============================================================
  function groupByGenre(channels) {
    const groups = {};
    channels.forEach(ch => {
      const genres = ch.fields['Genre'];
      const list = Array.isArray(genres) && genres.length ? genres : ['Uncategorized'];
      list.forEach(g => {
        if (!groups[g]) groups[g] = [];
        groups[g].push(ch);
      });
    });
    return groups;
  }

  function buildGenreSection(genre, channels, epgMap) {
    const section = document.createElement('div');
    section.className = 'genre-section';

    section.innerHTML = `
      <div class="genre-header">
        <h2 class="genre-title">${esc(genre)}</h2>
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
      const name = (ch.fields['Channel Name'] || '').toLowerCase();
      row.appendChild(buildCard(ch, epgMap.get(name)));
    });

    const scrollAmt = 620;
    section.querySelector('.scroll-btn.left').addEventListener('click', () =>
      row.scrollBy({ left: -scrollAmt, behavior: 'smooth' }));
    section.querySelector('.scroll-btn.right').addEventListener('click', () =>
      row.scrollBy({ left: scrollAmt, behavior: 'smooth' }));

    return section;
  }

  function render(channels, epgMap) {
    const content   = document.getElementById('channelContent');
    const noResults = document.getElementById('noResults');
    if (!content) return;

    content.innerHTML = '';

    if (!channels.length) {
      noResults?.classList.remove('hidden');
      return;
    }
    noResults?.classList.add('hidden');

    // New This Week row at top
    const newChannels = channels.filter(isNewChannel);
    if (newChannels.length) {
      content.appendChild(buildGenreSection('🆕 New This Week', newChannels, epgMap));
    }

    const groups = groupByGenre(channels);
    Object.keys(groups).sort().forEach(g =>
      content.appendChild(buildGenreSection(g, groups[g], epgMap))
    );
  }

  // ============================================================
  // STATS
  // ============================================================
  function updateStats(channels) {
    const countEl = document.getElementById('heroChannelCount');
    const genreEl = document.getElementById('heroGenreCount');
    const platEl  = document.getElementById('heroPlatformCount');

    if (countEl) countEl.textContent = channels.length;

    const genres    = new Set();
    const platforms = new Set();
    channels.forEach(ch => {
      (ch.fields['Genre']    || []).forEach(g => genres.add(g));
      (ch.fields['Platform'] || []).forEach(p => platforms.add(p));
    });
    if (genreEl) genreEl.textContent = genres.size;
    if (platEl)  platEl.textContent  = platforms.size;
  }

  // ============================================================
  // VIEW TOGGLE
  // ============================================================
  function renderViewToggle() {
    const bar = document.getElementById('viewToggleBar');
    if (!bar || bar.dataset.rendered) return;
    bar.dataset.rendered = '1';

    const btnBrowse = document.createElement('button');
    btnBrowse.className = 'view-toggle-btn active';
    btnBrowse.textContent = '🔲 Browse';

    const btnGuide = document.createElement('button');
    btnGuide.className = 'view-toggle-btn';
    btnGuide.textContent = '📺 Live Guide';

    btnBrowse.addEventListener('click', () => {
      activeView = 'browse';
      btnBrowse.classList.add('active');
      btnGuide.classList.remove('active');
      applyFilters();
    });

    btnGuide.addEventListener('click', async () => {
      if (activeView === 'guide') return;
      activeView = 'guide';
      btnBrowse.classList.remove('active');
      btnGuide.classList.add('active');

      // If EPG is already cached, render immediately
      if (allPrograms.length) { applyFilters(); return; }

      // Show loading state on button and in the guide section
      btnGuide.disabled = true;
      btnGuide.textContent = '⏳ Loading…';

      const guideSection = document.getElementById('guideSection');
      const content      = document.getElementById('channelContent');
      const heroSection  = document.getElementById('platformHero');
      const epgSection   = document.getElementById('epgSection');
      if (content)      content.style.display      = 'none';
      if (heroSection)  heroSection.style.display  = 'none';
      if (epgSection)   epgSection.style.display   = 'none';
      if (guideSection) {
        guideSection.style.display = 'block';
        const loadingMsg = window.innerWidth < 768
          ? 'Loading live guide…<br><span class="guide-loading-sub">This may take a moment on mobile</span>'
          : 'Loading live guide…';
        guideSection.innerHTML =
          `<div class="guide-loading"><div class="redirect-spinner"></div><p>${loadingMsg}</p></div>`;
      }

      await ensureEPG();

      btnGuide.disabled = false;
      btnGuide.textContent = '📺 Live Guide';
      applyFilters();
    });

    bar.appendChild(btnBrowse);
    bar.appendChild(btnGuide);
  }

  function renderGuide(channels, programs, channelMap) {
    const section = document.getElementById('guideSection');
    if (!section) return;

    const CHAN_W  = 100;   // channel column width
    const ROW_H  = 100;   // row height px
    const PX_MIN = 6;     // pixels per minute (1hr = 360px)

    const now         = Date.now();
    const minStart    = now - 30 * 60 * 1000;
    const viewStartMs = minStart;

    // Determine view width from available data, capped at 12 hours
    let viewEndMs = viewStartMs + 6 * 60 * 60 * 1000; // minimum 6 hours
    programs.forEach(p => {
      const end = new Date(p.fields['End Time']).getTime();
      if (!isNaN(end) && end > viewEndMs) viewEndMs = end;
    });
    viewEndMs = Math.min(viewEndMs, viewStartMs + 12 * 60 * 60 * 1000);
    const VIEW_MINS = Math.ceil((viewEndMs - viewStartMs) / 60000);

    // Now-line position (now is always within the window since we start 30 min ago)
    const nowOffsetPx = Math.round((now - viewStartMs) / 60000 * PX_MIN);

    // Does any loaded program start after this window ends?
    const hasMoreData = programs.some(p => {
      const start = new Date(p.fields['Start Time']).getTime();
      return !isNaN(start) && start >= viewEndMs;
    });

    // Group programs by channelName|platform key within the view window
    const progMap = new Map();
    programs.forEach(p => {
      const name  = (p.fields['Channel']  || '').toLowerCase().trim();
      const plat  = (p.fields['Platform'] || '').toLowerCase().trim();
      const key   = plat ? `${name}|${plat}` : name;
      const start = new Date(p.fields['Start Time']).getTime();
      const end   = new Date(p.fields['End Time']).getTime();
      if (!name || isNaN(start) || isNaN(end)) return;
      if (end <= viewStartMs || start >= viewEndMs) return;
      if (!progMap.has(key)) progMap.set(key, []);
      progMap.get(key).push(p);
    });
    progMap.forEach(progs =>
      progs.sort((a, b) => new Date(a.fields['Start Time']) - new Date(b.fields['Start Time']))
    );

    // Build multi-platform rows: one row per channel × platform combination
    const guideRows = [];
    channels.forEach(ch => {
      const name      = (ch.fields['Channel Name'] || '').trim();
      const nameLower = name.toLowerCase();
      const platforms = ch.fields['Platform'] || [];
      if (!platforms.length) {
        if (progMap.has(nameLower)) guideRows.push({ ch, platform: '', key: nameLower });
      } else {
        platforms.forEach(plat => {
          const key = `${nameLower}|${plat.toLowerCase()}`;
          if (progMap.has(key)) guideRows.push({ ch, platform: plat, key });
        });
      }
    });

    // When a platform pill is active, only show rows for that platform
    const renderedRows = activePlatform
      ? guideRows.filter(r => r.platform.toLowerCase() === activePlatform.toLowerCase())
      : guideRows;

    section.innerHTML = '';

    if (!renderedRows.length) {
      section.innerHTML = `
        <div class="state-box" style="margin:40px auto;max-width:400px">
          <div class="state-icon">📺</div>
          <div class="state-title">${programs.length ? 'No guide data for current filters' : 'Live guide loading\u2026'}</div>
          <div class="state-msg">${programs.length ? 'Try a different filter or check back later.' : 'EPG data is loading in the background.'}</div>
        </div>`;

      return;
    }

    const contentWidth = VIEW_MINS * PX_MIN;
    const totalWidth   = CHAN_W + contentWidth;

    // ---- Outer wrap (relative so nav buttons can be absolute) ----
    const wrap = document.createElement('div');
    wrap.className = 'guide-wrap';

    // ---- Sticky time header (lives OUTSIDE the scroll container so
    //      it can stick to the page viewport, not the scroll box) ----
    const header = document.createElement('div');
    header.className = 'guide-sticky-header';

    const corner = document.createElement('div');
    corner.className = 'guide-corner';
    header.appendChild(corner);

    // Overflow-hidden viewport for time cells (scroll-synced via JS)
    const timeViewport = document.createElement('div');
    timeViewport.className = 'guide-time-viewport';

    const timeCells = document.createElement('div');
    timeCells.className = 'guide-time-cells';
    timeCells.style.width = contentWidth + 'px';

    for (let m = 0; m < VIEW_MINS; m += 60) {
      const label = new Date(viewStartMs + m * 60 * 1000)
        .toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', hour12: true });
      const cell = document.createElement('div');
      cell.className = 'guide-time-cell';
      cell.style.left = (m * PX_MIN) + 'px';
      cell.textContent = label;
      timeCells.appendChild(cell);
    }
    timeViewport.appendChild(timeCells);
    header.appendChild(timeViewport);
    wrap.appendChild(header);

    // ---- Horizontal-scroll body (overflow-x: auto, no height = page scrolls) ----
    const bodyScroll = document.createElement('div');
    bodyScroll.className = 'guide-body-scroll';

    const inner = document.createElement('div');
    inner.className = 'guide-inner';
    inner.style.width = totalWidth + 'px';

    const body = document.createElement('div');
    body.className = 'guide-body';

    renderedRows.forEach(({ ch, platform, key }) => {
      const f       = ch.fields;
      const name    = (f['Channel Name'] || '').trim();
      const logo    = (f['Logo URL'] || '').trim();
      const initial = name.trim().charAt(0).toUpperCase();
      const chProgs = progMap.get(key) || [];

      const row = document.createElement('div');
      row.className = 'guide-row';
      row.style.height = ROW_H + 'px';

      // Channel cell — sticky left, logo-only (Xumo style)
      const chanCell = document.createElement('div');
      chanCell.className = 'guide-channel-cell';
      chanCell.style.width = CHAN_W + 'px';
      chanCell.title = name + (platform ? ` · ${platform}` : '');

      // Logo wrap — relative container so the platform dot can sit in the corner
      const logoWrap = document.createElement('div');
      logoWrap.className = 'guide-logo-wrap';

      if (logo) {
        const img = document.createElement('img');
        img.src = logo; img.alt = name;
        img.className = 'guide-channel-logo';
        const fallback = document.createElement('div');
        fallback.className = 'guide-channel-fallback';
        fallback.textContent = name;
        fallback.style.display = 'none';
        img.addEventListener('error', () => { img.style.display = 'none'; fallback.style.display = 'flex'; });
        logoWrap.appendChild(img);
        logoWrap.appendChild(fallback);
      } else {
        const fallback = document.createElement('div');
        fallback.className = 'guide-channel-fallback';
        fallback.textContent = name;
        logoWrap.appendChild(fallback);
      }

      // Platform dot — overlaid in bottom-right of logo (desktop only via CSS)
      if (platform) {
        const dot = document.createElement('span');
        dot.className = 'guide-platform-dot';
        dot.dataset.platform = platform;
        dot.title = platform;
        logoWrap.appendChild(dot);
      }

      chanCell.appendChild(logoWrap);

      // Platform pill — shown below logo on mobile only via CSS
      if (platform) {
        const platLabel = document.createElement('span');
        platLabel.className = `badge ${epgPlatformClass(platform)} guide-channel-platform`;
        platLabel.textContent = platform;
        chanCell.appendChild(platLabel);
      }

      // Programs cell
      const progsCell = document.createElement('div');
      progsCell.className = 'guide-programs-cell';
      progsCell.style.width = contentWidth + 'px';
      progsCell.style.height = ROW_H + 'px';

      chProgs.forEach(p => {
        const startMs = new Date(p.fields['Start Time']).getTime();
        const endMs   = new Date(p.fields['End Time']).getTime();
        const leftPx  = Math.max(0, (startMs - viewStartMs) / 60000 * PX_MIN);
        const rightPx = Math.min(contentWidth, (endMs - viewStartMs) / 60000 * PX_MIN);
        const widthPx = rightPx - leftPx - 2;
        if (widthPx <= 0) return;

        const isAiring = startMs <= now && now <= endMs;
        const title    = p.fields['Show Title'] || '';

        const block = document.createElement('div');
        block.className = 'guide-program' + (isAiring ? ' guide-program-now' : '');
        block.style.left  = leftPx + 'px';
        block.style.width = widthPx + 'px';
        block.setAttribute('role', 'button');
        block.setAttribute('tabindex', '0');
        block.setAttribute('aria-label', `${title} on ${name}`);

        // Only render text if block is wide enough to show something useful
        if (widthPx >= 60) {
          const inner = document.createElement('div');
          inner.className = 'guide-program-inner';

          const titleEl = document.createElement('span');
          titleEl.className = 'guide-program-title';
          titleEl.textContent = title;
          inner.appendChild(titleEl);

          // Show time range below title (always when block is wide enough to show text)
          const fmt = t => new Date(t).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', hour12: true });
          const timeEl = document.createElement('span');
          timeEl.className = 'guide-program-time';
          timeEl.textContent = `${fmt(startMs)} – ${fmt(endMs)}`;
          inner.appendChild(timeEl);

          block.appendChild(inner);
        }

        block.addEventListener('click', () => openEPGModal(p, ch));
        block.addEventListener('keydown', e => {
          if (e.key === 'Enter' || e.key === ' ') openEPGModal(p, ch);
        });

        progsCell.appendChild(block);
      });

      row.appendChild(chanCell);
      row.appendChild(progsCell);
      body.appendChild(row);
    });

    // End-of-schedule message — only when there's genuinely no more data ahead
    if (!hasMoreData) {
      const endMsg = document.createElement('div');
      endMsg.className = 'guide-end-message';
      endMsg.textContent = 'No more programs. Schedule updates daily — check back tomorrow for full programming.';
      inner.appendChild(endMsg);
    }

    // Red now-line — marks current time
    const nowLine = document.createElement('div');
    nowLine.className = 'guide-now-line';
    nowLine.style.left = (CHAN_W + nowOffsetPx) + 'px';
    body.appendChild(nowLine);

    inner.appendChild(body);
    bodyScroll.appendChild(inner);
    wrap.appendChild(bodyScroll);

    // Sync horizontal scroll → time header
    bodyScroll.addEventListener('scroll', () => {
      timeViewport.scrollLeft = bodyScroll.scrollLeft;
    }, { passive: true });

    section.appendChild(wrap);
  }

  // ============================================================
  // FILTERS
  // ============================================================
  async function applyFilters() {
    const q          = (document.getElementById('searchInput')?.value || '').toLowerCase().trim();
    const epgMap     = buildEPGMap(allPrograms);
    const channelMap = buildChannelMap(allChannels);

    const filtered = allChannels.filter(ch => {
      const f = ch.fields;
      const matchSearch = !q ||
        (f['Channel Name'] || '').toLowerCase().includes(q) ||
        (f['Description']  || '').toLowerCase().includes(q) ||
        (f['Genre']        || []).join(' ').toLowerCase().includes(q);
      const matchPlatform = !activePlatform || (f['Platform'] || []).includes(activePlatform);
      const matchGenre    = !activeGenre    || (f['Genre']    || []).includes(activeGenre);
      return matchSearch && matchPlatform && matchGenre;
    });

    const guideSection = document.getElementById('guideSection');
    const content      = document.getElementById('channelContent');
    const noResults    = document.getElementById('noResults');
    const epgSection   = document.getElementById('epgSection');
    const heroSection  = document.getElementById('platformHero');

    if (activeView === 'guide') {
      if (content)     content.style.display     = 'none';
      if (noResults)   noResults.classList.add('hidden');
      if (epgSection)  epgSection.style.display  = 'none';
      if (heroSection) heroSection.style.display = 'none';
      if (guideSection) {
        guideSection.style.display = 'block';
        renderGuide(filtered, allPrograms, channelMap);
      }
    } else {
      if (guideSection) guideSection.style.display = 'none';
      if (content)      content.style.display = '';

      render(filtered, epgMap);
      // Only render the hero once EPG is available; until then the skeleton stays visible
      if (allPrograms.length) {
        await renderPlatformHero(activePlatform, allPrograms, channelMap);
      }
      if (epgSection) epgSection.style.display = 'none';
    }
  }

  // ============================================================
  // SKELETONS
  // ============================================================
  function showEPGSkeleton() {
    const section = document.getElementById('platformHero');
    if (!section) return;
    const titleEl = section.querySelector('.platform-hero-title');
    if (titleEl) titleEl.textContent = "What's On Now";
    const oldRow = section.querySelector('.featured-epg-row');
    const row = document.createElement('div');
    row.className = 'featured-epg-row';
    oldRow.replaceWith(row);
    row.innerHTML = Array(5).fill(`
      <div class="featured-epg-card" style="pointer-events:none">
        <div class="featured-epg-thumb">
          <div class="skeleton" style="width:100%;height:100%;border-radius:0;"></div>
        </div>
        <div class="featured-epg-body">
          <div class="skeleton skeleton-title" style="width:55%;margin-bottom:8px;"></div>
          <div class="skeleton" style="height:12px;width:75%;border-radius:4px;"></div>
        </div>
      </div>
    `).join('');
    section.style.display = 'block';
  }

  function showSkeletons() {
    const content = document.getElementById('channelContent');
    if (!content) return;

    const cardSkels = Array(7).fill(
      `<div class="skeleton-card">
         <div class="skeleton skeleton-thumb"></div>
         <div class="skeleton skeleton-footer"></div>
       </div>`
    ).join('');

    let html = '';
    for (let i = 0; i < 3; i++) {
      html += `
        <div class="genre-section">
          <div class="genre-header"><div class="skeleton skeleton-title"></div></div>
          <div class="row-container">
            <div class="channels-row" style="pointer-events:none">${cardSkels}</div>
          </div>
        </div>`;
    }
    content.innerHTML = html;
  }

  // ============================================================
  // ERROR
  // ============================================================
  function showError(msg) {
    const content = document.getElementById('channelContent');
    if (!content) return;
    content.innerHTML = `
      <div class="state-box">
        <div class="state-icon">&#9888;&#65039;</div>
        <div class="state-title">Couldn't load channels</div>
        <div class="state-msg">${esc(msg || 'Check your API configuration and try again.')}</div>
        <button class="retry-btn" onclick="location.reload()">Try again</button>
      </div>`;
  }

  // ============================================================
  // NAVBAR SCROLL
  // ============================================================
  // ============================================================
  // MOBILE SEARCH MODAL
  // ============================================================
  function setupMobileSearch() {
    const icon = document.querySelector('.search-icon');
    if (!icon) return;

    // Build the modal DOM once
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

    function openModal() {
      modal.classList.add('open');
      setTimeout(() => modalInput.focus(), 50);
      renderModalResults('');
    }

    function closeModal() {
      modal.classList.remove('open');
      modalInput.value = '';
      resultsEl.innerHTML = '';
    }

    function renderModalResults(q) {
      const query = q.toLowerCase().trim();
      if (!query) {
        resultsEl.innerHTML = '<div class="search-modal-hint">Start typing to search channels…</div>';
        return;
      }
      const matches = allChannels.filter(ch => {
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

        const item = document.createElement('div');
        item.className = 'search-modal-item';
        item.innerHTML = `
          ${logo
            ? `<img class="search-modal-logo" src="${esc(logo)}" alt="${esc(name)}" loading="lazy">`
            : ''}
          <div class="search-modal-logo-fallback"${logo ? ' style="display:none"' : ''}>${esc(initial)}</div>
          <span class="search-modal-name">${esc(name)}</span>
        `;

        if (logo) {
          const img = item.querySelector('img');
          const fb  = item.querySelector('.search-modal-logo-fallback');
          img.addEventListener('error', () => { img.style.display = 'none'; fb.style.display = 'flex'; });
        }

        item.addEventListener('click', () => {
          sessionStorage.setItem('woftv_country', COUNTRY);
          window.location.href = `channel.html?id=${encodeURIComponent(name)}`;
        });
        resultsEl.appendChild(item);
      });
    }

    // Open modal on all screen sizes
    icon.addEventListener('click', openModal);

    closeBtn.addEventListener('click', closeModal);
    modal.addEventListener('click', e => { if (e.target === modal) closeModal(); });
    document.addEventListener('keydown', e => {
      if (e.key === 'Escape' && modal.classList.contains('open')) closeModal();
    });

    // Enter key: apply filter to the main page grid and close the modal
    modalInput.addEventListener('keydown', e => {
      if (e.key === 'Enter') {
        const mainInput = document.getElementById('searchInput');
        if (mainInput) {
          mainInput.value = modalInput.value;
          mainInput.dispatchEvent(new Event('input'));
        }
        closeModal();
      }
    });

    modalInput.addEventListener('input', debounce(() => {
      renderModalResults(modalInput.value);
    }, 200));
  }

  function setupNavScroll() {
    const nav = document.querySelector('.navbar');
    if (!nav) return;
    const onScroll = () => nav.classList.toggle('scrolled', window.scrollY > 10);
    window.addEventListener('scroll', onScroll, { passive: true });
    onScroll();
  }

  // ============================================================
  // INIT
  // ============================================================
  async function init() {
    setupNavScroll();
    setupMobileSearch();
    showSkeletons();

    // Phase 1 — channels only: render the grid immediately
    try {
      allChannels = await fetchAllChannels();
    } catch (err) {
      showError(err.message);
      return;
    }

    updateStats(allChannels);
    renderPlatformPills(allChannels);
    renderGenrePills(allChannels);

    // Activate URL-param filters (e.g. coming from genre/platform badge links on channel detail)
    const urlParams   = new URLSearchParams(window.location.search);
    const urlPlatform = urlParams.get('platform');
    const urlGenre    = urlParams.get('genre');
    if (urlPlatform) {
      activePlatform = urlPlatform;
      const pills = document.getElementById('platformPills');
      pills?.querySelectorAll('.platform-pill').forEach(p =>
        p.classList.toggle('active', p.dataset.platform === urlPlatform));
    }
    if (urlGenre) {
      activeGenre = urlGenre;
      const container = document.getElementById('genrePills');
      if (container) {
        container.querySelectorAll('.platform-pill[data-genre]').forEach(el =>
          el.classList.toggle('active', el.dataset.genre === urlGenre));
        container.querySelectorAll('.genre-more-item').forEach(el =>
          el.classList.toggle('active', el.dataset.genre === urlGenre));
        const moreBtn = container.querySelector('.genre-more-btn');
        if (moreBtn) {
          const isExtra = !!Array.from(container.querySelectorAll('.genre-pill-extra'))
            .find(p => p.dataset.genre === urlGenre);
          moreBtn.classList.toggle('active', isExtra);
        }
      }
    }

    renderViewToggle();
    showEPGSkeleton();
    await applyFilters(); // renders channel grid; hero stays as skeleton

    document.getElementById('searchInput')?.addEventListener('input', debounce(applyFilters, 280));

    // Phase 2a — background EPG pre-warm: kick off the fetch ~1.5 s after the channel grid
    // renders so the Live Guide switch is near-instant instead of waiting 5+ seconds.
    // ensureEPG() deduplicates concurrent calls, so this is safe alongside Phase 2b below.
    setTimeout(() => ensureEPG(), 1500);

    // Phase 2b — lazy EPG: also trigger when "What's On Now" enters the viewport
    // (or immediately if IntersectionObserver isn't supported)
    const heroEl = document.getElementById('platformHero');
    if (heroEl) {
      if ('IntersectionObserver' in window) {
        const io = new IntersectionObserver(entries => {
          if (entries[0].isIntersecting) {
            io.disconnect();
            ensureEPG().then(() => applyFilters());
          }
        }, { rootMargin: '200px' });
        io.observe(heroEl);
      } else {
        ensureEPG().then(() => applyFilters());
      }
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
