(() => {
  if (location.protocol === 'file:') return;

  // ============================================================
  // CHRISTMAS DECORATIONS: twinkling lights, light snowfall, Santa hat on the logo
  // Decorative only: never blocks clicks, honours "reduce motion", lighter on phones.
  // ============================================================
  function addChristmasDecorations() {
    if (document.getElementById('bovic-xmas-css')) return;
    const reduceMotion = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const isPhone = window.matchMedia && window.matchMedia('(max-width: 767px)').matches;

    const css = document.createElement('style');
    css.id = 'bovic-xmas-css';
    css.textContent = `
      @keyframes bovicTwinkle { 0%,100% { opacity: 1; filter: brightness(1.15); } 50% { opacity: .35; filter: brightness(.7); } }
      @keyframes bovicHatSwing { 0%,100% { transform: rotate(-22deg); } 50% { transform: rotate(-10deg) translateY(-1px); } }
      @keyframes bovicPompom { 0%,100% { transform: rotate(0deg); } 50% { transform: rotate(14deg); } }
      @keyframes bovicSparkle { 0%,100% { opacity: 0; transform: scale(.3) rotate(0deg); } 50% { opacity: 1; transform: scale(1) rotate(45deg); } }
      /* Hangs just below the menu bar so it never covers menu or contact text */
      .bovic-xmas-lights { position: absolute; left: 0; right: 0; top: 100%; height: 26px; pointer-events: none; z-index: 60; overflow: hidden; }
      .bovic-xmas-lights svg.wire { position: absolute; left: 0; top: 0; width: 100%; height: 26px; }
      .bovic-xmas-bulb { position: absolute; top: 0; width: 9px; height: 14px; border-radius: 50% 50% 50% 50% / 60% 60% 40% 40%; animation: bovicTwinkle 1.6s ease-in-out infinite; }
      .bovic-xmas-bulb::before { content: ''; position: absolute; left: 2px; top: -3px; width: 5px; height: 4px; background: #3b3b3b; border-radius: 1px; }
      .bovic-xmas-logo { position: relative !important; display: inline-block !important; }
      .bovic-xmas-hat { position: absolute; left: -8px; top: -17px; width: 34px; height: 30px; pointer-events: none; transform-origin: 70% 90%; animation: bovicHatSwing 2.8s ease-in-out infinite; z-index: 2; }
      .bovic-xmas-hat .pom { transform-origin: 6px 5px; animation: bovicPompom 1.4s ease-in-out infinite; }
      .bovic-xmas-spark { position: absolute; width: 10px; height: 10px; pointer-events: none; animation: bovicSparkle 2.2s ease-in-out infinite; z-index: 2; }
      .bovic-xmas-spark::before, .bovic-xmas-spark::after { content: ''; position: absolute; left: 4px; top: 0; width: 2px; height: 10px; background: #fff6d5; border-radius: 2px; box-shadow: 0 0 6px #d92f78; }
      .bovic-xmas-spark::after { transform: rotate(90deg); }
      #bovic-xmas-snow { position: fixed; inset: 0; width: 100%; height: 100%; pointer-events: none; z-index: 9990; }
      @media (prefers-reduced-motion: reduce) {
        .bovic-xmas-bulb, .bovic-xmas-hat, .bovic-xmas-hat .pom, .bovic-xmas-spark { animation: none !important; }
        .bovic-xmas-spark { opacity: .9; }
      }
    `;
    document.head.appendChild(css);

    // 1. String of twinkling lights along the top of the site header(s)
    const BULB_COLORS = ['#e53935', '#d92f78', '#2e7d32', '#1e88e5', '#ffffff'];
    const addLights = (host) => {
      if (!host || host.querySelector(':scope > .bovic-xmas-lights')) return;
      if (getComputedStyle(host).position === 'static') host.style.position = 'relative';
      const strip = document.createElement('div');
      strip.className = 'bovic-xmas-lights';
      strip.setAttribute('aria-hidden', 'true');
      const width = host.clientWidth || window.innerWidth;
      const gap = isPhone ? 30 : 38;
      const count = Math.max(6, Math.floor(width / gap));
      // Sagging wire between hooks
      const svgNS = 'http://www.w3.org/2000/svg';
      const wire = document.createElementNS(svgNS, 'svg');
      wire.setAttribute('class', 'wire');
      wire.setAttribute('viewBox', `0 0 ${count * 100} 26`);
      wire.setAttribute('preserveAspectRatio', 'none');
      const path = document.createElementNS(svgNS, 'path');
      let d = 'M0 2';
      for (let i = 0; i < count; i++) d += ` Q${i * 100 + 50} 14 ${(i + 1) * 100} 2`;
      path.setAttribute('d', d);
      path.setAttribute('fill', 'none');
      path.setAttribute('stroke', '#2b2b2b');
      path.setAttribute('stroke-width', '2');
      path.setAttribute('vector-effect', 'non-scaling-stroke');
      wire.appendChild(path);
      strip.appendChild(wire);
      for (let i = 0; i < count; i++) {
        const bulb = document.createElement('span');
        bulb.className = 'bovic-xmas-bulb';
        const color = BULB_COLORS[i % BULB_COLORS.length];
        bulb.style.left = `calc(${((i + 0.5) / count) * 100}% - 4px)`;
        bulb.style.top = '9px';
        bulb.style.background = color;
        bulb.style.boxShadow = `0 0 8px 2px ${color}`;
        bulb.style.animationDelay = `${(i % 5) * 0.32}s`;
        strip.appendChild(bulb);
      }
      host.appendChild(strip);
    };
    document.querySelectorAll('.main-header, .main-header-two, .main-header-three, .main-header-four, .main-header-five, header.main-header, .stricky-header')
      .forEach(addLights);
    if (!document.querySelector('.bovic-xmas-lights')) addLights(document.querySelector('header'));

    // 2. Santa hat + sparkles on every header / mobile-menu logo (not the footer)
    const svgNS = 'http://www.w3.org/2000/svg';
    const makeHat = () => {
      const svg = document.createElementNS(svgNS, 'svg');
      svg.setAttribute('class', 'bovic-xmas-hat');
      svg.setAttribute('viewBox', '0 0 60 52');
      svg.setAttribute('aria-hidden', 'true');
      const body = document.createElementNS(svgNS, 'path');
      body.setAttribute('d', 'M8 40 C14 22 26 8 44 6 C52 6 56 12 54 18 C50 14 44 14 40 20 C36 26 36 34 38 40 Z');
      body.setAttribute('fill', '#d62828');
      const shade = document.createElementNS(svgNS, 'path');
      shade.setAttribute('d', 'M38 40 C36 34 36 26 40 20 C42 17 45 15.5 48 15.5 C44 20 42 30 44 40 Z');
      shade.setAttribute('fill', '#a61b1b');
      const brim = document.createElementNS(svgNS, 'rect');
      brim.setAttribute('x', '4'); brim.setAttribute('y', '38'); brim.setAttribute('width', '44'); brim.setAttribute('height', '11');
      brim.setAttribute('rx', '5.5'); brim.setAttribute('fill', '#ffffff');
      const pomG = document.createElementNS(svgNS, 'g');
      pomG.setAttribute('class', 'pom');
      pomG.setAttribute('transform', 'translate(50 14)');
      const pom = document.createElementNS(svgNS, 'circle');
      pom.setAttribute('cx', '6'); pom.setAttribute('cy', '5'); pom.setAttribute('r', '6'); pom.setAttribute('fill', '#ffffff');
      pomG.appendChild(pom);
      svg.append(body, shade, brim, pomG);
      return svg;
    };
    document.querySelectorAll('img[src*="assets/images/resources/bovic-logo"]').forEach(img => {
      if (img.closest('footer, .site-footer, .site-footer-two, .site-footer-three, .site-footer-four, [class*="site-footer"]')) return;
      const holder = img.parentElement;
      if (!holder || holder.querySelector(':scope > .bovic-xmas-hat')) return;
      holder.classList.add('bovic-xmas-logo');
      holder.appendChild(makeHat());
      [[-10, 8, 0], [30, -6, 0.7], [img.clientWidth ? img.clientWidth - 6 : 140, 2, 1.4]].forEach(([x, y, delay]) => {
        const sp = document.createElement('span');
        sp.className = 'bovic-xmas-spark';
        sp.setAttribute('aria-hidden', 'true');
        sp.style.left = `${x}px`;
        sp.style.top = `${y}px`;
        sp.style.animationDelay = `${delay}s`;
        holder.appendChild(sp);
      });
    });

    // 3. Light falling snow (canvas, no clicks blocked, paused when tab hidden)
    if (reduceMotion || document.getElementById('bovic-xmas-snow')) return;
    const canvas = document.createElement('canvas');
    canvas.id = 'bovic-xmas-snow';
    canvas.setAttribute('aria-hidden', 'true');
    document.body.appendChild(canvas);
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    let W = 0, H = 0;
    const resize = () => {
      W = window.innerWidth; H = window.innerHeight;
      canvas.width = W * dpr; canvas.height = H * dpr;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    };
    resize();
    window.addEventListener('resize', resize);
    const flakeCount = isPhone ? 38 : 85;
    const flakes = Array.from({ length: flakeCount }, () => ({
      x: Math.random() * W,
      y: Math.random() * H,
      r: 1 + Math.random() * 2.6,
      speed: 0.35 + Math.random() * 0.9,
      drift: Math.random() * Math.PI * 2,
      sway: 0.3 + Math.random() * 0.7,
      alpha: 0.45 + Math.random() * 0.5,
    }));
    let last = performance.now();
    const tick = (now) => {
      const dt = Math.min(48, now - last) / 16.67;
      last = now;
      ctx.clearRect(0, 0, W, H);
      for (const f of flakes) {
        f.drift += 0.012 * dt;
        f.y += f.speed * dt;
        f.x += Math.sin(f.drift) * f.sway * 0.6 * dt;
        if (f.y > H + 5) { f.y = -5; f.x = Math.random() * W; }
        if (f.x > W + 5) f.x = -5; else if (f.x < -5) f.x = W + 5;
        ctx.beginPath();
        ctx.arc(f.x, f.y, f.r, 0, Math.PI * 2);
        ctx.fillStyle = `rgba(255,255,255,${f.alpha})`;
        ctx.shadowColor = 'rgba(255,255,255,.8)';
        ctx.shadowBlur = f.r * 2;
        ctx.fill();
      }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }

  // ============================================================
  // PHONE HEADER: tap-to-call button next to the menu icon (the top bar with the number is hidden on phones)
  // ============================================================
  (function addMobileCallButton() {
    const toggler = document.querySelector('header .mobile-nav__toggler');
    if (!toggler || document.querySelector('.bovic-call-btn')) return;
    const telLink = document.querySelector('a[href^="tel:"]');
    const a = document.createElement('a');
    a.className = 'bovic-call-btn';
    a.href = telLink ? telLink.getAttribute('href') : 'tel:+16787994634';
    a.setAttribute('aria-label', 'Call us');
    a.innerHTML = '<i class="fas fa-phone" aria-hidden="true" style="transform:scaleX(-1)"></i>';
    const st = document.createElement('style');
    st.textContent = `
      .bovic-call-btn{display:none}
      @media (max-width:1199px){
        .bovic-call-btn{display:inline-flex;align-items:center;justify-content:center;width:40px;height:40px;border-radius:50%;
          background:#d92f78;color:#172a54!important;font-size:17px;margin-right:14px;vertical-align:middle;flex:0 0 auto;
          box-shadow:0 4px 12px rgba(0,0,0,.18);animation:bovicRing 4s ease-in-out 2s infinite}
        .bovic-call-btn:hover{color:#172a54}
      }
      @keyframes bovicRing{0%,86%,100%{transform:rotate(0)}88%{transform:rotate(-14deg)}90%{transform:rotate(14deg)}92%{transform:rotate(-10deg)}94%{transform:rotate(8deg)}}
      @media (prefers-reduced-motion:reduce){.bovic-call-btn{animation:none}}`;
    document.head.appendChild(st);
    toggler.parentNode.insertBefore(a, toggler);
  })();

  // ============================================================
  // INSTALLABLE APP ("Add to Home Screen") — no app store needed
  // Android/desktop Chrome & Edge: native install prompt. iPhone/iPad Safari: short how-to.
  // ============================================================
  (function setupInstallableApp() {
    if (!('serviceWorker' in navigator) || /^\/admin/.test(location.pathname)) return;
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('/sw.js').catch(() => { /* not critical */ });
    });

    const standalone = window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
    if (standalone) return; // already opened as the app

    const ua = navigator.userAgent;
    const isIOS = /iPhone|iPad|iPod/.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
    const isIOSSafari = isIOS && /Safari/.test(ua) && !/CriOS|FxiOS|EdgiOS|GSA\//.test(ua);
    const DISMISS_KEY = 'bovic_app_banner_dismissed';
    const store = {
      get() { try { return Number(localStorage.getItem(DISMISS_KEY)) || 0; } catch { return 0; } },
      set() { try { localStorage.setItem(DISMISS_KEY, String(Date.now())); } catch { /* private mode */ } },
    };
    const recentlyDismissed = Date.now() - store.get() < 14 * 86400000;
    const onBookingFlow = /book\.html$/.test(location.pathname) && /status=|session_id=/.test(location.search);
    let deferredPrompt = null;

    const css = document.createElement('style');
    css.textContent = `
      #bovic-app-banner{position:fixed;left:12px;right:12px;bottom:12px;z-index:100000;max-width:440px;margin:0 auto;
        background:#172a54;color:#fff;border-radius:16px;box-shadow:0 12px 34px rgba(0,0,0,.35);padding:14px 14px 14px 12px;
        display:flex;gap:12px;align-items:center;font-family:inherit;transform:translateY(140%);transition:transform .45s ease}
      #bovic-app-banner.show{transform:none}
      #bovic-app-banner img{width:46px;height:46px;border-radius:12px;background:#fff;flex:0 0 auto}
      #bovic-app-banner .t{flex:1;min-width:0;font-size:13.5px;line-height:1.35}
      #bovic-app-banner .t strong{display:block;font-size:15px;color:#d92f78;margin-bottom:2px}
      #bovic-app-banner .go{background:#d92f78;color:#172a54;border:0;border-radius:999px;padding:9px 16px;font-weight:700;font-size:14px;cursor:pointer;flex:0 0 auto}
      #bovic-app-banner .x{background:none;border:0;color:#f6cfdd;font-size:22px;line-height:1;padding:4px 6px;cursor:pointer;flex:0 0 auto}
      #bovic-app-banner .ios{display:none;font-size:13px;margin-top:6px;color:#e8f1ee}
      #bovic-app-banner.ios-help .ios{display:block}
      #bovic-app-banner.ios-help .go{display:none}
      .mobile-nav__contact .bovic-install-li a{cursor:pointer}
      @media (prefers-reduced-motion:reduce){#bovic-app-banner{transition:none}}`;
    document.head.appendChild(css);

    function iosSteps() {
      return 'Tap <b>Share</b> <span aria-hidden="true">⬆︎</span> at the bottom of Safari, then <b>Add to Home Screen</b>.';
    }

    function buildBanner() {
      let el = document.getElementById('bovic-app-banner');
      if (el) return el;
      el = document.createElement('div');
      el.id = 'bovic-app-banner';
      el.setAttribute('role', 'dialog');
      el.setAttribute('aria-label', 'Install the Bovic app');
      el.innerHTML = `<img src="/assets/images/favicons/apple-touch-icon.png" alt="">
        <div class="t"><strong>Get the Bovic app</strong>Book in seconds from your home screen. Free, no app store.
          <div class="ios">${iosSteps()}</div></div>
        <button type="button" class="go">Install</button>
        <button type="button" class="x" aria-label="Close">&times;</button>`;
      document.body.appendChild(el);
      el.querySelector('.x').addEventListener('click', () => { el.classList.remove('show'); store.set(); });
      el.querySelector('.go').addEventListener('click', runInstall);
      return el;
    }

    async function runInstall() {
      const el = buildBanner();
      if (deferredPrompt) {
        deferredPrompt.prompt();
        const choice = await deferredPrompt.userChoice.catch(() => null);
        deferredPrompt = null;
        el.classList.remove('show');
        if (choice && choice.outcome === 'accepted') {
          if (typeof window.gtag === 'function') window.gtag('event', 'app_installed');
        } else store.set();
      } else if (isIOS) {
        el.classList.add('ios-help', 'show');
      }
    }

    function addMenuLink() {
      const list = document.querySelector('.mobile-nav__contact');
      if (!list || list.querySelector('.bovic-install-li')) return;
      const li = document.createElement('li');
      li.className = 'bovic-install-li';
      li.innerHTML = '<i class="fas fa-mobile-alt"></i><a role="button" tabindex="0">Install our app</a>';
      li.querySelector('a').addEventListener('click', e => { e.preventDefault(); runInstall(); });
      list.appendChild(li);
    }

    function showBannerLater() {
      if (recentlyDismissed || onBookingFlow) return;
      setTimeout(() => {
        const el = buildBanner();
        if (isIOS && !deferredPrompt) el.classList.add('ios-help');
        requestAnimationFrame(() => el.classList.add('show'));
      }, 9000);
    }

    window.addEventListener('beforeinstallprompt', e => {
      e.preventDefault(); // show our own banner instead of the browser's mini-bar
      deferredPrompt = e;
      addMenuLink();
      showBannerLater();
    });
    window.addEventListener('appinstalled', () => {
      const el = document.getElementById('bovic-app-banner');
      if (el) el.remove();
      store.set();
    });
    if (isIOSSafari) {
      addMenuLink();
      showBannerLater();
    }
  })();

  function buildStaticFallback() {
    const m = new Date().getMonth() + 1;
    let activePromo = null;
    if (false && m === 11) {
      activePromo = {
        key: 'black_november',
        theme: 'black_november',
        enabled: true,
        badge: 'BLACK NOVEMBER SALE',
        title: '20% OFF Deep Clean & Move-In / Move-Out Cleanings',
        subtitle: 'Limited-time November savings across Buckhead, Sandy Springs, Roswell & Alpharetta.',
        promo_code: 'BLACKNOV20',
        discount_percent: 20,
        cta_text: 'Claim 20% Off',
        end_date: '2026-11-30',
      };
    } else if (false && m === 12) {
      activePromo = {
        key: 'christmas_december',
        theme: 'christmas',
        enabled: true,
        decorations: true,
        badge: 'CHRISTMAS & HOLIDAY SPECIAL',
        title: '15% OFF Holiday & Christmas Guest-Ready Cleaning',
        subtitle: 'Sparkling kitchens, baths & living areas before family and holiday guests arrive.',
        promo_code: 'XMAS15',
        discount_percent: 15,
        cta_text: 'Book Holiday Clean',
        end_date: '2026-12-31',
      };
    }
    return {
      site: {
        company_name: 'Bovic Premier Cleaning Pros LLC',
        tagline: 'Premier Home & Office Cleaning in North Atlanta',
        phone: '678-799-4634',
        booking_email: 'booking@boviccleaning.com',
        info_email: 'info@boviccleaning.com',
        service_areas: 'Buckhead, Sandy Springs, Roswell & Alpharetta, GA',
        social: {},
      },
      catalog: null,
      activePromo,
    };
  }

  fetch('/api/public/site')
    .then(r => (r.ok ? r.json() : buildStaticFallback()))
    .catch(() => buildStaticFallback())
    .then(data => {
      if (!data || !data.site) return;
      const s = data.site;
      const cat = data.catalog;

      // 1. Update logos with cache-busting version
      if (s.logo_version) {
        document.querySelectorAll('img[src*="assets/images/resources/bovic-logo"]').forEach(img => {
          const base = img.getAttribute('src').split('?')[0];
          img.setAttribute('src', `${base}?v=${s.logo_version}`);
        });
      }

      // 2. Phone numbers & tel: links
      if (s.phone) {
        const digits = s.phone.replace(/[^\d+]/g, '');
        const telHref = 'tel:' + (digits.startsWith('+') ? digits : '+1' + digits);
        document.querySelectorAll('a[href^="tel:"]').forEach(a => {
          a.setAttribute('href', telHref);
          if (a.classList.contains('bovic-call-btn')) a.setAttribute('aria-label', 'Call ' + s.phone);
          else a.textContent = s.phone;
        });
      }

      // 3. Booking & info email links
      document.querySelectorAll('a[href^="mailto:"]').forEach(a => {
        const cur = (a.getAttribute('href') || '').toLowerCase();
        const targetEmail = cur.includes('info@') ? (s.info_email || s.booking_email) : (s.booking_email || s.info_email);
        if (targetEmail) {
          a.setAttribute('href', `mailto:${targetEmail}`);
          a.textContent = targetEmail;
        }
      });

      // 4. Service areas, welcome & copyright
      if (s.service_areas) {
        document.querySelectorAll('.main-menu__contact-list .icon-location').forEach(ic => {
          const p = ic.closest('li') && ic.closest('li').querySelector('.text p');
          if (p) p.textContent = `Serving ${s.service_areas}`;
        });
      }
      if (s.company_name && s.tagline) {
        const welcome = document.querySelector('.main-menu__top-welcome-text');
        if (welcome) welcome.textContent = `Welcome to ${s.company_name} · ${s.tagline}`;
      }
      if (s.footer_about) {
        const fa = document.querySelector('.footer-widget__about-text');
        if (fa) fa.textContent = s.footer_about;
      }
      if (s.copyright_text) {
        document.querySelectorAll('.site-footer__copyright-text, .site-footer-two__bottom-text').forEach(el => {
          el.textContent = s.copyright_text;
        });
      }

      // 5. Company social links (scoped to site social bars only; hide unset # links)
      const SOCIAL_META = [
        { key: 'facebook', label: 'Facebook', fa: 'fab fa-facebook-f', match: ['fa-facebook', 'icon-facebook'] },
        { key: 'instagram', label: 'Instagram', fa: 'fab fa-instagram', match: ['fa-instagram', 'icon-instagram'] },
        { key: 'twitter', label: 'Twitter / X', fa: 'fab fa-twitter', match: ['fa-twitter', 'icon-twitter'] },
        { key: 'linkedin', label: 'LinkedIn', fa: 'fab fa-linkedin-in', match: ['fa-linkedin', 'icon-linkedin'] },
        { key: 'pinterest', label: 'Pinterest', fa: 'fab fa-pinterest-p', match: ['fa-pinterest', 'icon-pinterest'] },
        { key: 'tiktok', label: 'TikTok', fa: 'bovic-social-tiktok', match: ['fa-tiktok', 'bovic-social-tiktok'] },
        { key: 'youtube', label: 'YouTube', fa: 'fab fa-youtube', match: ['fa-youtube'] },
        { key: 'google_business', label: 'Google Reviews', fa: 'fab fa-google', match: ['fa-google'] },
      ];
      const SOCIAL_BAR_SELECTORS = [
        '.thm-social-link1 .social-box',
        '.main-menu__social',
        '.main-menu-two__social',
        '.main-menu-three__social',
        '.main-menu-five__social',
        '.main-header-four__top-social',
        '.footer-widget__social-box',
        '.site-footer-two__social',
        '.site-footer-three__social-box',
        '.site-footer-four__social-box',
        '.mobile-nav__social',
        '.contact-one__social-box',
        '.faq-one__social-box',
        '.product-details__social-link',
        '.team-details__social',
      ].join(', ');

      const safeHttpUrl = (u) => {
        const str = String(u || '').trim();
        return /^https?:\/\/.+/i.test(str) ? str : '';
      };

      const makeSocialAnchor = (meta, url, mobileStyle) => {
        const a = document.createElement('a');
        a.setAttribute('href', url);
        a.setAttribute('target', '_blank');
        a.setAttribute('rel', 'noopener noreferrer');
        a.setAttribute('aria-label', meta.label);
        a.setAttribute('title', meta.label);
        if (meta.key === 'tiktok') {
          a.className = meta.fa;
          a.style.display = 'inline-flex';
          a.style.alignItems = 'center';
          a.style.justifyContent = 'center';
          const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
          svg.setAttribute('viewBox', '0 0 24 24');
          svg.setAttribute('width', '14');
          svg.setAttribute('height', '14');
          svg.setAttribute('fill', 'currentColor');
          svg.setAttribute('aria-hidden', 'true');
          const p = document.createElementNS('http://www.w3.org/2000/svg', 'path');
          p.setAttribute('d', 'M19.59 6.69a4.83 4.83 0 0 1-3.77-4.25V2h-3.45v13.67a2.89 2.89 0 0 1-2.88 2.5 2.89 2.89 0 0 1-2.89-2.89 2.89 2.89 0 0 1 2.89-2.89c.34 0 .66.06.96.16V9.02a6.3 6.3 0 0 0-.96-.08A6.33 6.33 0 0 0 3.16 15.27 6.33 6.33 0 0 0 9.49 21.6a6.33 6.33 0 0 0 6.33-6.33V8.78a8.2 8.2 0 0 0 4.77 1.52V6.85a4.8 4.8 0 0 1-1-.16z');
          svg.appendChild(p);
          a.appendChild(svg);
        } else if (mobileStyle) {
          a.className = meta.fa;
        } else {
          const ic = document.createElement('i');
          ic.className = meta.fa;
          ic.setAttribute('aria-hidden', 'true');
          a.appendChild(ic);
        }
        return a;
      };

      const socialCfg = s.social || {};
      document.querySelectorAll(SOCIAL_BAR_SELECTORS).forEach(bar => {
        const isUl = bar.tagName === 'UL';
        const isMobile = bar.classList.contains('mobile-nav__social');
        const seen = new Set();

        bar.querySelectorAll('a').forEach(a => {
          const iconEl = a.querySelector('i, span');
          const cls = `${a.className || ''} ${iconEl ? (iconEl.className || '') : ''}`;
          const matched = SOCIAL_META.find(m => m.match.some(tok => cls.includes(tok)));
          if (!matched) return;
          seen.add(matched.key);
          const url = safeHttpUrl(socialCfg[matched.key]);
          const itemWrap = (isUl && a.parentElement && a.parentElement.tagName === 'LI') ? a.parentElement : a;
          if (url) {
            a.setAttribute('href', url);
            a.setAttribute('target', '_blank');
            a.setAttribute('rel', 'noopener noreferrer');
            a.setAttribute('aria-label', matched.label);
            a.setAttribute('title', matched.label);
            itemWrap.style.display = '';
          } else {
            a.removeAttribute('href');
            itemWrap.style.display = 'none';
          }
        });

        SOCIAL_META.forEach(meta => {
          const url = safeHttpUrl(socialCfg[meta.key]);
          if (!url || seen.has(meta.key)) return;
          const a = makeSocialAnchor(meta, url, isMobile);
          if (isUl) {
            const li = document.createElement('li');
            li.appendChild(a);
            bar.appendChild(li);
          } else {
            bar.appendChild(a);
          }
        });

        const hasVisible = Array.from(bar.querySelectorAll('a')).some(a => {
          const wrap = (isUl && a.parentElement && a.parentElement.tagName === 'LI') ? a.parentElement : a;
          return wrap.style.display !== 'none';
        });
        bar.style.display = hasVisible ? '' : 'none';
        if (bar.previousElementSibling && bar.previousElementSibling.classList.contains('main-menu__social-title')) {
          bar.previousElementSibling.style.display = hasVisible ? '' : 'none';
        }
      });

      // 6. Hero & About edits (index / about pages)
      if (s.hero) {
        const firstSlide = document.querySelector('.main-slider .swiper-slide');
        if (firstSlide) {
          const sub = firstSlide.querySelector('.main-slider__sub-title');
          const txt = firstSlide.querySelector('.main-slider__text');
          const btn = firstSlide.querySelector('.main-slider__btn-box .thm-btn');
          if (sub && s.hero.eyebrow) sub.textContent = s.hero.eyebrow;
          if (txt && s.hero.subtitle) txt.textContent = s.hero.subtitle;
          if (btn && s.hero.cta_text && btn.firstChild && btn.firstChild.nodeType === 3) {
            btn.firstChild.nodeValue = s.hero.cta_text + ' ';
          }
        }
      }
      if (s.about) {
        const abTitle = document.querySelector('.about-one .section-title__title');
        const abText = document.querySelector('.about-one__text');
        const abYears = document.querySelector('.about-one__experience-count .odometer');
        const abStaff = document.querySelector('.about-one__active-staff-count .odometer');
        if (abTitle && s.about.title) abTitle.textContent = s.about.title;
        if (abText && s.about.text) abText.textContent = s.about.text;
        if (abYears && s.about.experience_years) {
          abYears.setAttribute('data-count', s.about.experience_years);
          abYears.textContent = s.about.experience_years;
        }
        if (abStaff && s.about.active_staff) {
          abStaff.setAttribute('data-count', s.about.active_staff);
          abStaff.textContent = s.about.active_staff;
        }
      }

      // 7. Live Pricing cards & One-Time Cleans table sync
      if (cat && cat.services) {
        const std = cat.services.standard;
        const syncTab = (tabId, freqKey) => {
          const tab = document.getElementById(tabId);
          if (!tab || !std || !std.prices[freqKey]) return;
          const cards = tab.querySelectorAll('.pricing-one__single');
          ['cozy', 'family', 'estate'].forEach((sz, i) => {
            const card = cards[i];
            if (!card) return;
            const cents = std.prices[freqKey][sz];
            const box = card.querySelector('.pricing-one__price-box');
            if (box && cents != null) {
              const span = box.querySelector('.validity');
              const valHtml = span ? span.outerHTML : '';
              box.innerHTML = `<span class="dolar">From $</span> ${Math.round(cents / 100)} ${valHtml}`;
            }
          });
        };
        syncTab('monthly', 'biweekly');
        syncTab('yearly', 'weekly');

        const otRows = document.querySelectorAll('.bovic-onetime-pricing tbody tr');
        const rowServices = ['deep', 'move', 'airbnb'];
        rowServices.forEach((sk, idx) => {
          const row = otRows[idx];
          const svc = cat.services[sk];
          if (!row || !svc || !svc.prices.onetime) return;
          const tds = row.querySelectorAll('td');
          ['cozy', 'family', 'estate'].forEach((sz, colIdx) => {
            const c = svc.prices.onetime[sz];
            if (tds[colIdx + 1]) tds[colIdx + 1].textContent = c == null ? 'Custom quote' : `From $${Math.round(c / 100)}`;
          });
        });
      }

      // 8. Policy & Risk Disclosure fields on privacy.html and terms.html
      if (s.policies) {
        document.querySelectorAll('[data-cms-policy]').forEach(el => {
          const key = el.getAttribute('data-cms-policy');
          if (s.policies[key]) el.textContent = s.policies[key];
        });
      }

      // 9. Seasonal Promo Plugin: Top Ribbon + Floating Black Icon Widget & Deal Card
      const promo = data.activePromo;
      const onAdmin = /\/admin\.html$/i.test(location.pathname);
      if (promo && !onAdmin && !document.getElementById('bovic-promo-bar')) {
        const isXmas = promo.theme === 'christmas';
        const dismissKey = `bovic_promo_dismiss_${promo.key}_${promo.promo_code}`;
        let dismissed = false;
        try { dismissed = sessionStorage.getItem(dismissKey) === '1'; } catch {}
        if (!dismissed) {
          const bar = document.createElement('div');
          bar.id = 'bovic-promo-bar';
          bar.style.cssText = isXmas
            ? 'background:linear-gradient(90deg,#172a54 0%,#7a1622 50%,#172a54 100%);color:#fff;padding:10px 14px;border-bottom:2px solid #d92f78;font-family:Poppins,sans-serif;font-size:13px;position:relative;z-index:9998;'
            : 'background:linear-gradient(90deg,#0b0d10 0%,#181c20 55%,#172a54 100%);color:#fff;padding:10px 14px;border-bottom:2px solid #d92f78;font-family:Poppins,sans-serif;font-size:13px;position:relative;z-index:9998;';

          const inner = document.createElement('div');
          inner.style.cssText = 'max-width:1280px;margin:0 auto;display:flex;align-items:center;justify-content:center;flex-wrap:wrap;gap:10px;padding-right:28px;';

          const badge = document.createElement('span');
          badge.style.cssText = isXmas
            ? 'background:#d92f78;color:#172a54;font-weight:700;padding:2px 10px;border-radius:999px;font-size:11px;letter-spacing:.04em;'
            : 'background:#d92f78;color:#0b0d10;font-weight:700;padding:2px 10px;border-radius:999px;font-size:11px;letter-spacing:.04em;';
          badge.textContent = promo.badge || 'SPECIAL OFFER';

          const msg = document.createElement('span');
          msg.style.fontWeight = '500';
          msg.textContent = `${promo.title || ''}${promo.promo_code ? ` · Code: ${promo.promo_code}` : ''}`;

          const cta = document.createElement('a');
          cta.href = promo.promo_code ? `book.html?promo=${encodeURIComponent(promo.promo_code)}` : 'book.html';
          cta.textContent = promo.cta_text || 'Book Now';
          cta.style.cssText = 'background:#d92f78;color:#0b0d10;font-weight:700;padding:4px 12px;border-radius:999px;text-decoration:none;font-size:12px;white-space:nowrap;';

          const closeBtn = document.createElement('button');
          closeBtn.type = 'button';
          closeBtn.setAttribute('aria-label', 'Dismiss promotion banner');
          closeBtn.textContent = '×';
          closeBtn.style.cssText = 'position:absolute;right:10px;top:50%;transform:translateY(-50%);background:transparent;border:0;color:#fff;font-size:20px;line-height:1;cursor:pointer;opacity:.8;';
          closeBtn.addEventListener('click', () => {
            bar.remove();
            try { sessionStorage.setItem(dismissKey, '1'); } catch {}
          });

          inner.appendChild(badge);
          inner.appendChild(msg);
          inner.appendChild(cta);
          bar.appendChild(inner);
          bar.appendChild(closeBtn);
          document.body.insertBefore(bar, document.body.firstChild);
        }

        // Floating Corner Black Icon Widget + Expandable Offer Card
        if (!document.getElementById('bovic-promo-fab')) {
          if (!document.getElementById('bovic-promo-css')) {
            const st = document.createElement('style');
            st.id = 'bovic-promo-css';
            st.textContent = `
              @keyframes bovicBlackGlow {
                0%,100% { box-shadow: 0 8px 24px rgba(0,0,0,.45), 0 0 0 0 rgba(217,47,120,.55); }
                60% { box-shadow: 0 10px 28px rgba(0,0,0,.5), 0 0 0 8px rgba(217,47,120,0); }
              }
              #bovic-promo-fab { animation: bovicBlackGlow 2.6s infinite; transition: transform .18s ease; }
              #bovic-promo-fab:hover { transform: translateY(-2px) scale(1.02); }
              /* Phones: compact gift icon at bottom-right so it never covers the hero buttons */
              @media (max-width: 767px) {
                #bovic-promo-fab { left: auto !important; right: 14px !important; bottom: 128px !important; padding: 5px !important; gap: 0 !important; }
                #bovic-promo-fab .bovic-fab-text { display: none !important; }
                #bovic-promo-popover { left: 12px !important; right: 12px !important; width: auto !important; max-width: none !important; bottom: 186px !important; }
              }
              @media (prefers-reduced-motion: reduce) { #bovic-promo-fab { animation: none; } }
            `;
            document.head.appendChild(st);
          }

          const hasChatBtn = Boolean(document.querySelector('.chat-icon'));
          // Sits on the bottom edge beside the chat bubble (not above it) so it never covers hero buttons
          const fabBottom = hasChatBtn ? 44 : 24;
          const fabLeft = hasChatBtn ? 96 : 24;

          const makeIconSvg = () => {
            const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
            svg.setAttribute('viewBox', '0 0 24 24');
            svg.setAttribute('width', '20');
            svg.setAttribute('height', '20');
            svg.setAttribute('fill', 'none');
            svg.setAttribute('stroke', '#d92f78');
            svg.setAttribute('stroke-width', '2');
            svg.setAttribute('stroke-linecap', 'round');
            svg.setAttribute('stroke-linejoin', 'round');
            svg.setAttribute('aria-hidden', 'true');
            const p = document.createElementNS('http://www.w3.org/2000/svg', 'path');
            if (isXmas) {
              // Festive Gift Box Icon
              p.setAttribute('d', 'M20 12v10H4V12M2 7h20v5H2zM12 22V7M12 7H7.5a2.5 2.5 0 0 1 0-5C11 2 12 7 12 7zM12 7h4.5a2.5 2.5 0 0 0 0-5C13 2 12 7 12 7z');
            } else {
              // Black Friday / Black November Tag Icon
              p.setAttribute('d', 'M20.59 13.41l-7.17 7.17a2 2 0 0 1-2.83 0L2 12V2h10l8.59 8.59a2 2 0 0 1 0 2.82z');
              const dot = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
              dot.setAttribute('cx', '7');
              dot.setAttribute('cy', '7');
              dot.setAttribute('r', '1.6');
              dot.setAttribute('fill', '#d92f78');
              svg.appendChild(dot);
            }
            svg.appendChild(p);
            return svg;
          };

          const fab = document.createElement('button');
          fab.id = 'bovic-promo-fab';
          fab.type = 'button';
          fab.setAttribute('aria-label', `${promo.badge || 'Seasonal Deal'} — ${promo.discount_percent || ''}% Off`);
          fab.style.cssText = [
            'position:fixed',
            `bottom:${fabBottom}px`,
            `left:${fabLeft}px`,
            'z-index:9996',
            'display:inline-flex',
            'align-items:center',
            'gap:9px',
            'padding:9px 14px 9px 10px',
            'border-radius:999px',
            'border:2px solid #d92f78',
            isXmas ? 'background:linear-gradient(135deg,#172a54 0%,#6e1420 100%)' : 'background:linear-gradient(135deg,#090a0c 0%,#1d2126 100%)',
            'color:#ffffff',
            'cursor:pointer',
            'font-family:Poppins,sans-serif',
          ].join(';');

          const iconCircle = document.createElement('span');
          iconCircle.style.cssText = 'width:32px;height:32px;border-radius:50%;background:#000;border:1px solid rgba(217,47,120,.5);display:inline-flex;align-items:center;justify-content:center;flex-shrink:0;';
          iconCircle.appendChild(makeIconSvg());

          const textWrap = document.createElement('span');
          textWrap.className = 'bovic-fab-text';
          textWrap.style.cssText = 'display:flex;flex-direction:column;align-items:flex-start;line-height:1.15;text-align:left;';
          const topLbl = document.createElement('span');
          topLbl.style.cssText = 'font-size:10px;font-weight:700;letter-spacing:.06em;color:#d92f78;text-transform:uppercase;';
          topLbl.textContent = isXmas ? 'Holiday Deal' : 'Black Nov';
          const botLbl = document.createElement('span');
          botLbl.style.cssText = 'font-size:12px;font-weight:700;color:#ffffff;';
          botLbl.textContent = promo.discount_percent ? `${promo.discount_percent}% OFF` : 'Special';
          textWrap.appendChild(topLbl);
          textWrap.appendChild(botLbl);

          fab.appendChild(iconCircle);
          fab.appendChild(textWrap);

          // Interactive Offer Card Popover
          const pop = document.createElement('div');
          pop.id = 'bovic-promo-popover';
          pop.setAttribute('role', 'dialog');
          pop.setAttribute('aria-label', promo.badge || 'Seasonal Promo');
          pop.style.cssText = [
            'display:none',
            'position:fixed',
            `bottom:${fabBottom + 62}px`,
            `left:${fabLeft}px`,
            'width:332px',
            'max-width:calc(100vw - 48px)',
            'z-index:9997',
            'border-radius:16px',
            'overflow:hidden',
            'border:1px solid #d92f78',
            'box-shadow:0 20px 50px rgba(0,0,0,.45)',
            'background:#111418',
            'color:#ffffff',
            'font-family:Poppins,sans-serif',
          ].join(';');

          const popHead = document.createElement('div');
          popHead.style.cssText = [
            'padding:14px 16px',
            'display:flex',
            'align-items:center',
            'justify-content:space-between',
            'gap:8px',
            isXmas ? 'background:linear-gradient(135deg,#172a54,#7a1622)' : 'background:linear-gradient(135deg,#050607,#1b2024)',
            'border-bottom:1px solid rgba(217,47,120,.35)',
          ].join(';');

          const popHeadLeft = document.createElement('div');
          popHeadLeft.style.cssText = 'display:flex;align-items:center;gap:8px;';
          popHeadLeft.appendChild(makeIconSvg());
          const popBadge = document.createElement('span');
          popBadge.style.cssText = 'font-weight:700;font-size:12px;letter-spacing:.05em;color:#d92f78;text-transform:uppercase;';
          popBadge.textContent = promo.badge || 'LIMITED OFFER';
          popHeadLeft.appendChild(popBadge);

          const popClose = document.createElement('button');
          popClose.type = 'button';
          popClose.setAttribute('aria-label', 'Close offer popup');
          popClose.textContent = '×';
          popClose.style.cssText = 'background:transparent;border:0;color:#d0d5dd;font-size:22px;line-height:1;cursor:pointer;padding:0 4px;';
          popClose.addEventListener('click', () => { pop.style.display = 'none'; });

          popHead.appendChild(popHeadLeft);
          popHead.appendChild(popClose);

          const popBody = document.createElement('div');
          popBody.style.cssText = 'padding:16px;';

          if (promo.end_date) {
            const endTs = new Date(`${promo.end_date}T23:59:59`).getTime();
            const daysLeft = Math.ceil((endTs - Date.now()) / 86400000);
            if (daysLeft >= 0) {
              const expPill = document.createElement('div');
              expPill.style.cssText = 'display:inline-block;background:rgba(217,47,120,.14);color:#d92f78;border:1px solid rgba(217,47,120,.35);border-radius:999px;padding:2px 10px;font-size:11px;font-weight:600;margin-bottom:8px;';
              expPill.textContent = daysLeft === 0 ? 'Ends tonight!' : `Ends ${promo.end_date} · ${daysLeft} day${daysLeft === 1 ? '' : 's'} left`;
              popBody.appendChild(expPill);
            }
          }

          const hTitle = document.createElement('h5');
          hTitle.style.cssText = 'margin:0 0 6px;font-size:16px;font-weight:700;color:#ffffff;line-height:1.3;';
          hTitle.textContent = promo.title || '';
          popBody.appendChild(hTitle);

          if (promo.subtitle) {
            const pSub = document.createElement('p');
            pSub.style.cssText = 'margin:0 0 12px;font-size:12.5px;color:#cbd5e1;line-height:1.45;';
            pSub.textContent = promo.subtitle;
            popBody.appendChild(pSub);
          }
          if (promo.applies_to_labels) {
            const pScope = document.createElement('p');
            pScope.style.cssText = 'margin:-6px 0 12px;font-size:11.5px;color:#94a3b8;line-height:1.4;';
            pScope.textContent = `Valid on: ${promo.applies_to_labels}`;
            popBody.appendChild(pScope);
          }

          if (promo.promo_code) {
            const codeRow = document.createElement('div');
            codeRow.style.cssText = 'display:flex;align-items:center;justify-content:space-between;gap:8px;background:#07090b;border:1.5px dashed #d92f78;border-radius:10px;padding:8px 10px;margin-bottom:12px;';
            const codeTxt = document.createElement('strong');
            codeTxt.style.cssText = 'font-family:monospace;font-size:14px;letter-spacing:.08em;color:#d92f78;';
            codeTxt.textContent = promo.promo_code;
            const copyBtn = document.createElement('button');
            copyBtn.type = 'button';
            copyBtn.textContent = 'Copy Code';
            copyBtn.style.cssText = 'background:rgba(255,255,255,.1);color:#fff;border:1px solid rgba(255,255,255,.22);border-radius:6px;padding:3px 9px;font-size:11px;font-weight:600;cursor:pointer;';
            copyBtn.addEventListener('click', () => {
              if (navigator.clipboard && navigator.clipboard.writeText) {
                navigator.clipboard.writeText(promo.promo_code).catch(() => {});
              }
              copyBtn.textContent = 'Copied!';
              setTimeout(() => { copyBtn.textContent = 'Copy Code'; }, 1800);
            });
            codeRow.appendChild(codeTxt);
            codeRow.appendChild(copyBtn);
            popBody.appendChild(codeRow);
          }

          const actionBtn = document.createElement('a');
          actionBtn.href = promo.promo_code ? `book.html?promo=${encodeURIComponent(promo.promo_code)}` : 'book.html';
          actionBtn.textContent = promo.cta_text || 'Claim Offer & Book Now';
          actionBtn.style.cssText = 'display:block;width:100%;text-align:center;background:#d92f78;color:#0b0d10;font-weight:700;font-size:13.5px;padding:10px 14px;border-radius:10px;text-decoration:none;';
          actionBtn.addEventListener('click', (ev) => {
            const promoInput = document.getElementById('promo-input');
            const applyBtn = document.getElementById('apply-promo-btn');
            if (promoInput && applyBtn && promo.promo_code) {
              ev.preventDefault();
              promoInput.value = promo.promo_code;
              applyBtn.click();
              pop.style.display = 'none';
              promoInput.scrollIntoView({ behavior: 'smooth', block: 'center' });
            }
          });
          popBody.appendChild(actionBtn);

          pop.appendChild(popHead);
          pop.appendChild(popBody);

          fab.addEventListener('click', () => {
            pop.style.display = pop.style.display === 'none' ? 'block' : 'none';
          });
          document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape' && pop.style.display === 'block') pop.style.display = 'none';
          });

          document.body.appendChild(fab);
          document.body.appendChild(pop);
        }

        // Christmas lights, falling snow & animated Santa hat on the logo (Admin → Plugins → "Decorations")
        if (isXmas && promo.decorations !== false) addChristmasDecorations();
      }

      // 10. Live SEO Meta Tags, Canonical, Open Graph & LocalBusiness JSON-LD Schema
      const setMeta = (attr, key, val) => {
        if (!val) return;
        let el = document.head.querySelector(`meta[${attr}="${key}"]`);
        if (!el) {
          el = document.createElement('meta');
          el.setAttribute(attr, key);
          document.head.appendChild(el);
        }
        el.setAttribute('content', val);
      };

      const seo = s.seo || {};
      const mkt = s.marketing || {};
      if (!onAdmin) {
        const isHome = /^\/($|index\.html$)/i.test(location.pathname);
        if (isHome && seo.default_title) {
          document.title = seo.default_title;
        } else if (seo.site_title_suffix && document.title.includes('Bovic Premier')) {
          document.title = document.title.replace(/Bovic Premier Cleaning Pros LLC/g, seo.site_title_suffix);
        }

        if (seo.meta_description) {
          setMeta('name', 'description', seo.meta_description);
          setMeta('property', 'og:description', seo.meta_description);
          setMeta('name', 'twitter:description', seo.meta_description);
        }
        if (seo.meta_keywords) setMeta('name', 'keywords', seo.meta_keywords);
        // Theme demo / template pages are never indexed (keep in sync with DEMO_PAGE_RE in backend/server.js)
        const DEMO_PAGE_RE = /^(index\d.*|index-.*|.*one-page.*|profile-.*|my-profile.*|cart|checkout|wishlist|products?|product-details|coming-soon|login|sign-up|404)\.html$/i;
        const pageFile = location.pathname.split('/').pop() || '';
        const noindexPage = DEMO_PAGE_RE.test(pageFile);
        setMeta('name', 'robots', seo.robots_index === false || noindexPage ? 'noindex, nofollow' : 'index, follow');

        if (seo.canonical_base) {
          const baseClean = seo.canonical_base.replace(/\/+$/, '');
          const canonicalHref = baseClean + (isHome ? '/' : location.pathname);
          let canEl = document.head.querySelector('link[rel="canonical"]');
          if (!canEl) {
            canEl = document.createElement('link');
            canEl.setAttribute('rel', 'canonical');
            document.head.appendChild(canEl);
          }
          canEl.setAttribute('href', canonicalHref);
          setMeta('property', 'og:url', canonicalHref);
          if (seo.og_image) {
            const imgUrl = /^https?:\/\//i.test(seo.og_image) ? seo.og_image : `${baseClean}/${seo.og_image.replace(/^\/+/, '')}`;
            setMeta('property', 'og:image', imgUrl);
            setMeta('name', 'twitter:image', imgUrl);
          }
        }
        setMeta('property', 'og:title', document.title);
        setMeta('name', 'twitter:title', document.title);
        if (/^[A-Za-z0-9_-]{10,80}$/.test(mkt.search_console_token || '')) {
          setMeta('name', 'google-site-verification', mkt.search_console_token);
        }

        // Structured Data (CleaningService / LocalBusiness JSON-LD)
        const baseForSchema = (seo.canonical_base || location.origin).replace(/\/+$/, '');
        const sameAs = Object.values(s.social || {}).filter(u => /^https?:\/\//i.test(u));
        const schema = {
          '@context': 'https://schema.org',
          '@type': 'CleaningService',
          name: s.company_name || 'Bovic Premier Cleaning Pros LLC',
          url: baseForSchema,
          telephone: s.phone || '678-799-4634',
          email: s.booking_email || 'booking@boviccleaning.com',
          priceRange: seo.schema_price_range || '$$',
          description: seo.meta_description || s.tagline || '',
          areaServed: String(s.service_areas || 'Buckhead, Sandy Springs, Roswell, Alpharetta, GA')
            .split(/[,&]+/)
            .map(x => x.trim())
            .filter(Boolean)
            .map(city => ({ '@type': 'City', name: city })),
          sameAs,
        };
        let ld = document.getElementById('bovic-jsonld');
        if (!ld) {
          ld = document.createElement('script');
          ld.id = 'bovic-jsonld';
          ld.type = 'application/ld+json';
          document.head.appendChild(ld);
        }
        ld.textContent = JSON.stringify(schema);
      }

      // 11. Google Ads, GA4, GTM & Meta Pixel Loader (strict regex-validated IDs only)
      const gadsId = /^AW-[A-Z0-9]{6,20}$/.test(mkt.google_ads_id || '') ? mkt.google_ads_id : '';
      const gadsLabel = /^[A-Za-z0-9_-]{4,40}$/.test(mkt.google_ads_label || '') ? mkt.google_ads_label : '';
      const ga4Id = /^G-[A-Z0-9]{6,15}$/.test(mkt.ga4_id || '') ? mkt.ga4_id : '';
      const gtmId = /^GTM-[A-Z0-9]{5,12}$/.test(mkt.gtm_id || '') ? mkt.gtm_id : '';
      const fbPixel = /^\d{10,20}$/.test(mkt.meta_pixel_id || '') ? mkt.meta_pixel_id : '';

      if (!onAdmin) {
        const primaryGtag = ga4Id || gadsId;
        if (primaryGtag && !window.__bovicGtagLoaded) {
          window.__bovicGtagLoaded = true;
          window.dataLayer = window.dataLayer || [];
          window.gtag = window.gtag || function () { window.dataLayer.push(arguments); };
          window.gtag('js', new Date());
          if (ga4Id) window.gtag('config', ga4Id);
          if (gadsId) window.gtag('config', gadsId);
          const gs = document.createElement('script');
          gs.async = true;
          gs.src = `https://www.googletagmanager.com/gtag/js?id=${encodeURIComponent(primaryGtag)}`;
          document.head.appendChild(gs);
        }
        if (gtmId && !window.__bovicGtmLoaded) {
          window.__bovicGtmLoaded = true;
          window.dataLayer = window.dataLayer || [];
          window.dataLayer.push({ 'gtm.start': new Date().getTime(), event: 'gtm.js' });
          const gtms = document.createElement('script');
          gtms.async = true;
          gtms.src = `https://www.googletagmanager.com/gtm.js?id=${encodeURIComponent(gtmId)}`;
          document.head.appendChild(gtms);
        }
        if (fbPixel && !window.__bovicFbLoaded) {
          window.__bovicFbLoaded = true;
          const n = window.fbq = function () {
            n.callMethod ? n.callMethod.apply(n, arguments) : n.queue.push(arguments);
          };
          n.push = n;
          n.loaded = true;
          n.version = '2.0';
          n.queue = [];
          const fbs = document.createElement('script');
          fbs.async = true;
          fbs.src = 'https://connect.facebook.net/en_US/fbevents.js';
          document.head.appendChild(fbs);
          window.fbq('init', fbPixel);
          window.fbq('track', 'PageView');
        }

        window.bovicTrackEvent = (evName, params = {}) => {
          try {
            if (typeof window.gtag === 'function') {
              window.gtag('event', evName, params);
              if (evName === 'purchase' && gadsId && gadsLabel) {
                window.gtag('event', 'conversion', {
                  send_to: `${gadsId}/${gadsLabel}`,
                  value: Number(params.value || 0),
                  currency: params.currency || 'USD',
                  transaction_id: params.transaction_id || '',
                });
              }
            }
            if (typeof window.fbq === 'function') {
              if (evName === 'purchase') window.fbq('track', 'Purchase', { value: Number(params.value || 0), currency: 'USD' });
              else if (evName === 'begin_checkout') window.fbq('track', 'InitiateCheckout');
            }
          } catch {}
        };
      }
    })
    .catch(() => {});
})();
