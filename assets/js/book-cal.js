(() => {
  // Services and prices mirror the event types at https://cal.com/boviccleaning
  var SERVICES = {
    standard: {
      slug: 'standard-cleaning', name: 'Standard Home Cleaning', from: 'From $150', note: 'Every 2 weeks · 3 hrs',
      desc: 'Regular upkeep: kitchen, bathrooms, bedrooms and living areas wiped, dusted, vacuumed and mopped, with a before/after photo report. Weekly visits save 15%. Tell us your preferred frequency in the notes.',
      prices: [['1–2 bed', '$150'], ['3 bed / 2 bath', '$190'], ['4+ bed', '$240']]
    },
    deep: {
      slug: 'deep-cleaning', name: 'Deep Cleaning', from: 'From $280', note: 'One-time · 5 hrs',
      desc: 'Top-to-bottom reset: baseboards, inside microwave, oven and fridge, range hood, shower glass, tile grout, ceiling fans and everything in a standard clean. Best for a first visit.',
      prices: [['1–2 bed', '$280'], ['3 bed / 2 bath', '$380'], ['4+ bed', '$480']]
    },
    move: {
      slug: 'move-in-move-out', name: 'Move-In / Move-Out', from: 'From $350', note: 'Empty home · 6 hrs',
      desc: 'Empty-home cleaning for renters, landlords and realtors: inside cabinets, closets, fridge and oven, baseboards, bathrooms and floors.',
      prices: [['1–2 bed', '$350'], ['3 bed / 2 bath', '$460'], ['4+ bed', '$580']]
    },
    airbnb: {
      slug: 'airbnb-turnover', name: 'Airbnb Turnover', from: 'From $95', note: 'Between guests · 2 hrs',
      desc: 'Fast reset between guests: fresh linens, bathrooms and kitchen cleaned, trash out, basics restocked, plus a photo report. Add your check-out and check-in times in the notes.',
      prices: [['1–2 bed', '$95'], ['3 bed / 2 bath', '$140'], ['Larger homes', 'Quoted']]
    },
    office: {
      slug: 'free-estimate', name: 'Office, Commercial & Other', from: 'Free estimate', note: '15-min video call',
      desc: 'A free 15-minute video call to quote office, commercial, post-construction, window or floor cleaning, or any job you\'re not sure how to book. Show us the space on your phone and we\'ll send a written quote the same day.',
      prices: null
    }
  };
  var ALIASES = {
    'standard-cleaning': 'standard', 'deep-cleaning': 'deep', 'move-in-move-out': 'move', 'airbnb-turnover': 'airbnb',
    'free-estimate': 'office', commercial: 'office', post_construction: 'office', estimate: 'office'
  };

  var params = new URLSearchParams(location.search);
  var current = params.get('service') || 'standard';
  current = ALIASES[current] || current;
  if (!SERVICES[current]) current = 'standard';

  var grid = document.getElementById('svc-grid');
  Object.keys(SERVICES).forEach(function (key) {
    var s = SERVICES[key];
    var b = document.createElement('button');
    b.type = 'button';
    b.className = 'svc-btn';
    b.dataset.key = key;
    b.innerHTML = '<strong>' + s.name + '</strong><span class="price">' + s.from + '</span><small>' + s.note + '</small>';
    b.addEventListener('click', function () { select(key, true); });
    grid.appendChild(b);
  });

  // Cal.com embed loader (official snippet)
  (function (C, A, L) {
    var p = function (a, ar) { a.q.push(ar); };
    var d = C.document;
    C.Cal = C.Cal || function () {
      var cal = C.Cal;
      var ar = arguments;
      if (!cal.loaded) {
        cal.ns = {};
        cal.q = cal.q || [];
        d.head.appendChild(d.createElement('script')).src = A;
        cal.loaded = true;
      }
      if (ar[0] === L) {
        var api = function () { p(api, arguments); };
        var namespace = ar[1];
        api.q = api.q || [];
        if (typeof namespace === 'string') {
          cal.ns[namespace] = cal.ns[namespace] || api;
          p(cal.ns[namespace], ar);
          p(cal, ['initNamespace', namespace]);
        } else p(cal, ar);
        return;
      }
      p(cal, ar);
    };
  })(window, 'https://app.cal.com/embed/embed.js', 'init');

  var calCount = 0;
  function renderCal(slug) {
    var host = document.getElementById('cal-inline');
    var link = 'boviccleaning/' + slug;
    var direct = document.getElementById('cal-direct');
    if (direct) direct.href = 'https://cal.com/' + link;
    host.innerHTML = '<div class="cal-fallback">Loading the calendar… If it doesn\'t appear, <a href="https://cal.com/' + link + '" target="_blank" rel="noopener">open the booking calendar here</a>.</div>';
    var ns = 'bovic' + (++calCount);
    var el = document.createElement('div');
    el.id = 'cal-' + ns;
    host.appendChild(el);
    Cal('init', ns, { origin: 'https://cal.com' });
    Cal.ns[ns]('inline', { elementOrSelector: '#cal-' + ns, calLink: link, config: { layout: 'month_view', theme: 'light' } });
    Cal.ns[ns]('ui', {
      theme: 'light', hideEventTypeDetails: false, layout: 'month_view',
      cssVarsPerTheme: { light: { 'cal-brand': '#d92f78' }, dark: { 'cal-brand': '#f6cfdd' } }
    });
    Cal.ns[ns]('on', {
      action: 'linkReady',
      callback: function () {
        var fb = host.querySelector('.cal-fallback');
        if (fb) fb.remove();
      }
    });
  }

  function select(key, scroll) {
    current = key;
    var s = SERVICES[key];
    document.querySelectorAll('.svc-btn').forEach(function (b) { b.classList.toggle('active', b.dataset.key === key); });
    var html = '<strong>' + s.name + '</strong> — ' + s.desc;
    if (s.prices) {
      html += '<table>' + s.prices.map(function (r) { return '<tr><td>' + r[0] + '</td><td>' + (r[1].charAt(0) === '$' ? 'From ' : '') + r[1] + '</td></tr>'; }).join('') + '</table>';
    }
    document.getElementById('svc-detail').innerHTML = html;
    renderCal(s.slug);
    var u = new URL(location.href);
    u.searchParams.set('service', key);
    u.searchParams.delete('size');
    u.searchParams.delete('freq');
    history.replaceState(null, '', u.pathname + u.search);
    if (scroll) document.getElementById('svc-detail').scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  select(current, false);
})();
