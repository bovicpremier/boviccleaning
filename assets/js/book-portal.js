(() => {
  const state = {
    catalog: null,
    paymentMethods: [],
    demoMode: true,
    service: 'standard',
    size: 'family',
    freq: 'biweekly',
    paymentMethod: '',
    date: '',
    time: '',
    promoCode: '',
    promoInfo: null,
    activePromo: null,
    calDate: (() => { const d = new Date(); d.setDate(1); return d; })(),
    today: '',
    availability: { blockedDates: [], bookedSlots: {}, closedSlots: {}, timeSlots: ['08:00 AM', '10:30 AM', '01:00 PM', '03:30 PM'], maxPerSlot: 2 }
  };

  const params = new URLSearchParams(window.location.search);

  function esc(v) {
    return String(v == null ? '' : v)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function localToday() {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  }

  // Fire an analytics event only once per booking (refreshing the page must not double-count)
  function trackOnce(evName, bookingCode, params) {
    if (typeof window.bovicTrackEvent !== 'function' || !bookingCode) return;
    const key = `bovic_tracked_${evName}_${bookingCode}`;
    try {
      if (localStorage.getItem(key)) return;
      localStorage.setItem(key, '1');
    } catch {}
    window.bovicTrackEvent(evName, params);
  }

  async function handleReturnStatus() {
    const status = params.get('status');
    const sessionId = params.get('session_id');
    if (!status) return false;

    document.getElementById('booking-view').style.display = 'none';
    const box = document.getElementById('status-view');
    box.style.display = 'block';

    if (status === 'cancelled') {
      box.innerHTML = `<div class="status-banner">
        <i class="fas fa-times-circle fa-3x text-warning mb-3"></i>
        <h3>Checkout Cancelled</h3>
        <p class="text-muted">No payment was charged. You can choose another date or try again anytime.</p>
        <a href="book.html" class="btn-pay mt-2" style="max-width:280px;">Return to Calendar</a>
      </div>`;
      return true;
    }

    if (status === 'demo_pay') {
      box.innerHTML = `<div class="status-banner">
        <span class="badge bg-warning text-dark mb-2">Demo Checkout Mode</span>
        <h3 class="fw-bold">Complete Payment — $${esc(params.get('amount') || '0.00')}</h3>
        <p class="text-muted small">Add Stripe keys in <code>backend/.env</code> or paste Stripe / PayPal links in the Staff Portal &rarr; Stripe &amp; PayPal. Click below to simulate a paid checkout and send confirmation emails.</p>
        <button type="button" id="demo-confirm-btn" class="btn-pay mt-3" style="max-width:340px;"><i class="fas fa-check-circle"></i>Confirm Demo Payment</button>
      </div>`;
      document.getElementById('demo-confirm-btn').addEventListener('click', () => confirmAndRender(sessionId));
      return true;
    }

    if (status === 'success' && sessionId) {
      box.innerHTML = `<div class="status-banner"><p>Confirming your Stripe payment and sending your receipt...</p></div>`;
      await confirmAndRender(sessionId);
      return true;
    }
    return false;
  }

  async function confirmAndRender(sessionId) {
    const box = document.getElementById('status-view');
    try {
      const res = await fetch('/api/bookings/confirm-session', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ session_id: sessionId })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Verification failed');
      const b = data.booking;
      if (b.payment_status === 'paid') {
        trackOnce('purchase', b.booking_code, {
          transaction_id: b.booking_code,
          value: Number(((b.price_cents || 0) / 100).toFixed(2)),
          currency: 'USD',
        });
      }
      box.innerHTML = `<div class="status-banner">
        <i class="fas fa-check-circle fa-4x mb-3" style="color:var(--green);"></i>
        <h2 class="fw-bold">Booking Confirmed!</h2>
        <p class="text-muted">We emailed your receipt to <strong>${esc(b.customer_email)}</strong> and scheduled automated 24-hour &amp; 2-hour reminders.</p>
        <div class="text-start bg-light rounded-3 p-3 my-3 small">
          <div><strong>Booking Code:</strong> ${esc(b.booking_code)}</div>
          <div><strong>Service:</strong> ${esc(b.service_type)} (${esc(b.home_size)} &middot; ${esc(b.frequency)})</div>
          <div><strong>Date &amp; Time:</strong> ${esc(b.cleaning_date)} at ${esc(b.time_slot)}</div>
          <div><strong>Address:</strong> ${esc(b.address)} (${esc(b.service_area)})</div>
          <div><strong>Total Paid:</strong> $${(b.price_cents / 100).toFixed(2)}</div>
        </div>
        <div class="d-flex justify-content-center gap-2 flex-wrap">
          <a href="index.html" class="btn btn-dark rounded-pill px-4">Back to Website</a>
          <a href="book.html" class="btn btn-outline-dark rounded-pill px-4">Book Another Cleaning</a>
        </div>
      </div>`;
    } catch (err) {
      box.innerHTML = `<div class="status-banner"><h3 class="text-danger">Error</h3><p>${esc(err.message)}</p><a href="book.html" class="btn btn-dark">Try Again</a></div>`;
    }
  }

  function currentPriceCents() {
    const svc = state.catalog.services[state.service];
    const freqs = Object.keys(svc.prices);
    if (!freqs.includes(state.freq)) state.freq = freqs[0];
    return svc.prices[state.freq][state.size];
  }

  function visiblePaymentMethods() {
    const key = `${state.service}_${state.freq}_${state.size}`;
    const promoActive = Boolean(state.promoInfo && state.promoInfo.valid);
    const list = state.paymentMethods.filter(m => {
      if (m.key === 'stripe_link' || m.key === 'paypal') {
        return m.hasDefault || (m.items && m.items.includes(key));
      }
      return true;
    });
    if (!promoActive) return list;
    // Fixed-price Stripe links can't apply a discount. Hide them while a promo is applied,
    // unless they are the only option (the server then explains the limitation).
    const withoutLinks = list.filter(m => m.key !== 'stripe_link');
    return withoutLinks.length ? withoutLinks : list;
  }

  function renderChoices() {
    const services = state.catalog.services;
    const svcBox = document.getElementById('service-choices');
    svcBox.innerHTML = Object.entries(services).map(([k, s]) => `
      <button type="button" class="choice-btn ${state.service === k ? 'active' : ''}" data-k="${esc(k)}">
        <strong>${esc(s.short)}</strong><small>${esc(s.desc)}</small>
      </button>`).join('');
    svcBox.querySelectorAll('button').forEach(btn => btn.addEventListener('click', () => {
      state.service = btn.dataset.k;
      renderChoices();
    }));

    const svc = services[state.service];
    const freqKeys = Object.keys(svc.prices);
    if (!freqKeys.includes(state.freq)) state.freq = freqKeys[0];

    const sizeBox = document.getElementById('size-choices');
    sizeBox.innerHTML = Object.entries(svc.sizes).map(([k, label]) => {
      const cents = svc.prices[state.freq][k];
      const priceTag = cents == null ? 'Custom quote' : `From $${(cents / 100).toFixed(0)}`;
      const parts = label.split('·');
      return `<button type="button" class="choice-btn ${state.size === k ? 'active' : ''}" data-k="${esc(k)}">
        <strong>${esc(parts[0].trim())} · ${esc(priceTag)}</strong>
        <small>${esc((parts[1] || label).trim())}</small>
      </button>`;
    }).join('');
    sizeBox.querySelectorAll('button').forEach(btn => btn.addEventListener('click', () => {
      state.size = btn.dataset.k;
      renderChoices();
    }));

    const freqWrap = document.getElementById('freq-wrap');
    if (freqKeys.length > 1) {
      freqWrap.style.display = 'block';
      document.getElementById('freq-choices').innerHTML = freqKeys.map(fk => `
        <button type="button" class="choice-btn ${state.freq === fk ? 'active' : ''}" data-k="${esc(fk)}">
          <strong>${esc(state.catalog.freqLabels[fk] || fk)}</strong>
          <small>${fk === 'weekly' ? 'Best value (~15% off)' : 'Standard recurring'}</small>
        </button>`).join('');
      document.querySelectorAll('#freq-choices button').forEach(btn => btn.addEventListener('click', () => {
        state.freq = btn.dataset.k;
        renderChoices();
      }));
    } else {
      freqWrap.style.display = 'none';
    }

    const price = currentPriceCents();
    const isQuote = price == null;
    const payCard = document.getElementById('payment-card');
    const methods = visiblePaymentMethods();
    if (isQuote) {
      payCard.style.display = 'none';
    } else {
      payCard.style.display = 'block';
      if (!methods.some(m => m.key === state.paymentMethod)) {
        state.paymentMethod = methods.length ? methods[0].key : '';
      }
      const payBox = document.getElementById('payment-choices');
      if (!methods.length) {
        payBox.innerHTML = '<div class="small text-muted">Online payment is temporarily unavailable. Please call <a href="tel:+16787994634">678-799-4634</a> to book.</div>';
      } else payBox.innerHTML = methods.map(m => `
        <button type="button" class="pay-btn ${state.paymentMethod === m.key ? 'active' : ''}" data-k="${esc(m.key)}">
          <i class="${esc(m.icon)}"></i>
          <div><strong>${esc(m.label)}</strong><small class="d-block text-muted">${esc(m.desc)}</small></div>
        </button>`).join('');
      payBox.querySelectorAll('button').forEach(btn => btn.addEventListener('click', () => {
        state.paymentMethod = btn.dataset.k;
        renderChoices();
      }));
    }

    updateSummary();
  }

  function renderSummaryPrice(price) {
    const isQuote = price == null;
    const discRow = document.getElementById('sum-discount-row');
    if (!isQuote && state.promoInfo && state.promoInfo.valid) {
      discRow.style.display = 'flex';
      document.getElementById('sum-discount-label').textContent = `Promo (${state.promoInfo.promo_code} · -${state.promoInfo.discount_percent}%)`;
      document.getElementById('sum-discount-val').textContent = `-$${(state.promoInfo.discount_cents / 100).toFixed(2)}`;
      document.getElementById('sum-price').textContent = `$${(state.promoInfo.final_cents / 100).toFixed(2)}`;
    } else {
      discRow.style.display = 'none';
      document.getElementById('sum-price').textContent = isQuote ? 'Custom Quote' : `$${(price / 100).toFixed(2)}`;
    }
  }

  async function validateAppliedPromo(codeStr, silent = false) {
    const wasActive = Boolean(state.promoInfo && state.promoInfo.valid);
    await applyPromo(codeStr, silent);
    // Payment options depend on whether a promo is applied (fixed-price links are hidden)
    if (wasActive !== Boolean(state.promoInfo && state.promoInfo.valid)) renderChoices();
  }

  async function applyPromo(codeStr, silent = false) {
    const code = String(codeStr || '').trim().toUpperCase();
    const st = document.getElementById('promo-status');
    const price = currentPriceCents();
    if (!code || price == null) {
      state.promoCode = '';
      state.promoInfo = null;
      if (st) st.style.display = 'none';
      renderSummaryPrice(price);
      return;
    }
    try {
      const res = await fetch('/api/bookings/promo-check', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          promo_code: code,
          service_key: state.service,
          size_key: state.size,
          frequency_key: state.freq,
        }),
      });
      const data = await res.json();
      if (res.ok && data.valid) {
        state.promoCode = data.promo_code;
        state.promoInfo = data;
        document.getElementById('promo-input').value = data.promo_code;
        st.textContent = `${data.promo_code} applied: ${data.discount_percent}% off (-$${(data.discount_cents / 100).toFixed(2)})`;
        st.style.color = '#86efac';
        st.style.display = 'block';
      } else {
        state.promoCode = '';
        state.promoInfo = null;
        if (!silent) {
          st.textContent = data.error || 'Promo code is invalid or expired.';
          st.style.color = '#fca5a5';
          st.style.display = 'block';
        } else {
          st.style.display = 'none';
        }
      }
    } catch {
      if (!silent) {
        st.textContent = 'Could not verify promo code.';
        st.style.color = '#fca5a5';
        st.style.display = 'block';
      }
    }
    renderSummaryPrice(price);
  }

  function updateSummary() {
    const svc = state.catalog.services[state.service];
    const price = currentPriceCents();
    const isQuote = price == null;
    const methods = visiblePaymentMethods();
    const chosenMethod = methods.find(m => m.key === state.paymentMethod);

    document.getElementById('sum-service').textContent = svc.label;
    document.getElementById('sum-size').textContent = svc.sizes[state.size];
    document.getElementById('sum-freq').textContent = state.catalog.freqLabels[state.freq] || state.freq;
    document.getElementById('sum-date').textContent = state.date || 'Select a date';
    document.getElementById('sum-time').textContent = state.time || 'Select a time';
    document.getElementById('sum-method').textContent = isQuote ? 'Free estimate' : (chosenMethod ? chosenMethod.label : '—');
    renderSummaryPrice(price);
    if (state.promoCode && !isQuote) {
      // Re-price active discount for newly picked package
      clearTimeout(updateSummary._pt);
      updateSummary._pt = setTimeout(() => validateAppliedPromo(state.promoCode, true), 50);
    }

    const btnText = document.querySelector('#checkout-btn span');
    if (isQuote) btnText.textContent = 'Request Free Estimate';
    else if (state.paymentMethod === 'paypal') btnText.textContent = 'Reserve & Pay via PayPal';
    else if (state.paymentMethod === 'later') btnText.textContent = 'Confirm Booking (Pay Later)';
    else if (state.paymentMethod === 'stripe_link') btnText.textContent = 'Reserve & Pay via Stripe Link';
    else btnText.textContent = 'Proceed to Stripe Checkout';
  }

  async function loadCalendar() {
    const y = state.calDate.getFullYear();
    const m = state.calDate.getMonth();
    const ym = `${y}-${String(m + 1).padStart(2, '0')}`;
    document.getElementById('cal-month-label').textContent = state.calDate.toLocaleString('en-US', { month: 'long', year: 'numeric' });

    try {
      const res = await fetch(`/api/availability?month=${ym}`);
      if (res.ok) state.availability = await res.json();
    } catch {}

    const blockedSet = new Set((state.availability.blockedDates || []).map(d => d.date));
    const firstDow = new Date(y, m, 1).getDay();
    const daysInMonth = new Date(y, m + 1, 0).getDate();
    if (state.availability.today) state.today = state.availability.today;
    const todayStr = state.today || localToday();
    const closedFor = iso => (state.availability.closedSlots && state.availability.closedSlots[iso]) || [];

    const grid = document.getElementById('cal-days');
    grid.innerHTML = '';
    for (let i = 0; i < firstDow; i++) grid.appendChild(document.createElement('div'));

    for (let d = 1; d <= daysInMonth; d++) {
      const iso = `${ym}-${String(d).padStart(2, '0')}`;
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'cal-day' + (state.date === iso ? ' selected' : '');
      btn.textContent = d;

      const slotsForDay = state.availability.bookedSlots[iso] || {};
      const allFull = state.availability.timeSlots.every(s => (slotsForDay[s] || 0) >= state.availability.maxPerSlot || closedFor(iso).includes(s));
      if (iso < todayStr || blockedSet.has(iso) || allFull) {
        btn.disabled = true;
      } else {
        btn.addEventListener('click', () => selectDate(iso));
      }
      grid.appendChild(btn);
    }
  }

  function selectDate(iso) {
    state.date = iso;
    state.time = '';
    loadCalendar();

    document.getElementById('slot-section').style.display = 'block';
    document.getElementById('picked-date-label').textContent = iso;
    const sg = document.getElementById('slot-grid');
    sg.innerHTML = '';
    const slotsForDay = state.availability.bookedSlots[iso] || {};

    state.availability.timeSlots.forEach(slot => {
      const cnt = slotsForDay[slot] || 0;
      const closed = ((state.availability.closedSlots && state.availability.closedSlots[iso]) || []).includes(slot);
      const left = closed ? 0 : Math.max(0, state.availability.maxPerSlot - cnt);
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'slot-btn';
      btn.disabled = left === 0;
      btn.innerHTML = `<span>${esc(slot)}</span><small>${closed ? 'Unavailable' : left === 0 ? 'Full' : `${left} spot${left > 1 ? 's' : ''} left`}</small>`;
      btn.addEventListener('click', () => {
        state.time = slot;
        sg.querySelectorAll('.slot-btn').forEach(x => x.classList.toggle('selected', x === btn));
        updateSummary();
      });
      sg.appendChild(btn);
    });
    updateSummary();
  }

  document.getElementById('prev-month').addEventListener('click', () => { state.calDate.setDate(1); state.calDate.setMonth(state.calDate.getMonth() - 1); loadCalendar(); });
  document.getElementById('next-month').addEventListener('click', () => { state.calDate.setDate(1); state.calDate.setMonth(state.calDate.getMonth() + 1); loadCalendar(); });

  document.getElementById('checkout-btn').addEventListener('click', async () => {
    const errEl = document.getElementById('checkout-error');
    errEl.style.display = 'none';
    const payload = {
      customer_name: document.getElementById('c-name').value.trim(),
      customer_email: document.getElementById('c-email').value.trim(),
      customer_phone: document.getElementById('c-phone').value.trim(),
      service_area: document.getElementById('c-area').value,
      address: document.getElementById('c-address').value.trim(),
      notes: document.getElementById('c-notes').value.trim(),
      service_key: state.service,
      size_key: state.size,
      frequency_key: state.freq,
      payment_method: state.paymentMethod,
      cleaning_date: state.date,
      time_slot: state.time,
      promo_code: state.promoCode || ''
    };

    if (!payload.cleaning_date || !payload.time_slot) {
      errEl.textContent = 'Please select a date and arrival window on the calendar.';
      errEl.style.display = 'block';
      return;
    }
    if (!payload.customer_name || !payload.customer_email || !payload.customer_phone || !payload.address) {
      errEl.textContent = 'Please complete your name, email, phone, and address.';
      errEl.style.display = 'block';
      return;
    }
    const termsChk = document.getElementById('c-terms');
    if (termsChk && !termsChk.checked) {
      errEl.textContent = 'Please agree to the Terms, Policies & Risk Disclosure and Privacy Policy to continue.';
      errEl.style.display = 'block';
      return;
    }

    if (typeof window.bovicTrackEvent === 'function') {
      const amtCents = (state.promoInfo && state.promoInfo.valid) ? state.promoInfo.final_cents : currentPriceCents();
      window.bovicTrackEvent('begin_checkout', { value: amtCents ? Number((amtCents / 100).toFixed(2)) : 0, currency: 'USD' });
    }

    const btn = document.getElementById('checkout-btn');
    btn.disabled = true;
    btn.querySelector('span').textContent = 'Reserving your slot...';
    try {
      const res = await fetch('/api/bookings/checkout', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Checkout failed');

      if (data.mode === 'redirect' || data.mode === 'demo') {
        window.location.href = data.checkoutUrl;
        return;
      }

      // Not paid yet (quote, pay-later, or emailed payment link): count as a lead, not a purchase
      trackOnce('generate_lead', data.bookingCode, {
        transaction_id: data.bookingCode || '',
        value: data.amount ? Number(data.amount) : 0,
        currency: 'USD',
        method: data.mode,
      });

      document.getElementById('booking-view').style.display = 'none';
      const box = document.getElementById('status-view');
      box.style.display = 'block';

      if (data.mode === 'external') {
        const label = data.method === 'paypal' ? 'PayPal' : 'Stripe';
        box.innerHTML = `<div class="status-banner">
          <i class="fas fa-calendar-check fa-3x mb-3" style="color:var(--green);"></i>
          <h2 class="fw-bold">Slot Reserved — Complete Payment via ${esc(label)}</h2>
          <p class="text-muted">Booking code: <strong>${esc(data.bookingCode)}</strong>. We also emailed this payment link to <strong>${esc(payload.customer_email)}</strong>.</p>
          <a href="${esc(data.payUrl)}" target="_blank" rel="noopener" class="btn-pay my-3" style="max-width:340px;">
            <i class="fas fa-external-link-alt"></i>Pay $${esc(data.amount)} via ${esc(label)}
          </a>
          <p class="small text-muted mb-3">Once completed, our team will confirm your booking and assign your cleaning pro.</p>
          <a href="index.html" class="btn btn-outline-dark rounded-pill px-4">Back to Website</a>
        </div>`;
      } else if (data.mode === 'quote') {
        box.innerHTML = `<div class="status-banner">
          <i class="fas fa-clipboard-check fa-3x mb-3" style="color:var(--green);"></i>
          <h2 class="fw-bold">Free Estimate Request Received!</h2>
          <p class="text-muted">Booking code: <strong>${esc(data.bookingCode)}</strong> for <strong>${esc(payload.cleaning_date)} at ${esc(payload.time_slot)}</strong>.</p>
          <p class="small text-muted">We've sent a confirmation email to <strong>${esc(payload.customer_email)}</strong> and will reply with your exact custom quote, usually within one business day.</p>
          <a href="index.html" class="btn btn-dark rounded-pill px-4 mt-2">Back to Website</a>
        </div>`;
      } else {
        box.innerHTML = `<div class="status-banner">
          <i class="fas fa-check-circle fa-3x mb-3" style="color:var(--green);"></i>
          <h2 class="fw-bold">Booking Confirmed (Pay Later)!</h2>
          <p class="text-muted">Booking code: <strong>${esc(data.bookingCode)}</strong> for <strong>${esc(payload.cleaning_date)} at ${esc(payload.time_slot)}</strong>.</p>
          <p class="small text-muted">We sent your confirmation email and scheduled 24-hour &amp; 2-hour reminders.</p>
          <a href="index.html" class="btn btn-dark rounded-pill px-4 mt-2">Back to Website</a>
        </div>`;
      }
    } catch (err) {
      errEl.textContent = err.message;
      errEl.style.display = 'block';
      btn.disabled = false;
      updateSummary();
    }
  });

  document.getElementById('apply-promo-btn').addEventListener('click', () => {
    validateAppliedPromo(document.getElementById('promo-input').value, false);
  });
  document.getElementById('promo-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      validateAppliedPromo(e.target.value, false);
    }
  });
  document.getElementById('apply-active-promo-btn').addEventListener('click', () => {
    if (state.activePromo && state.activePromo.promo_code) {
      document.getElementById('promo-input').value = state.activePromo.promo_code;
      validateAppliedPromo(state.activePromo.promo_code, false);
    }
  });

  (async () => {
    const handled = await handleReturnStatus();
    if (handled) return;

    let cfg = null;
    try {
      const res = await fetch('/api/public/config');
      if (res.ok) cfg = await res.json();
    } catch {}

    if (!cfg || !cfg.catalog) {
      // Graceful fallback when opened on static GitHub Pages without the Node backend running
      const m = new Date().getMonth() + 1;
      cfg = {
        timeSlots: ['08:00 AM', '10:30 AM', '01:00 PM', '03:30 PM'],
        maxPerSlot: 2,
        paymentMethods: [{ key: 'later', label: 'Request Booking by Phone / Email', desc: 'Online checkout requires Node server — call 678-799-4634', icon: 'fas fa-phone' }],
        demoMode: false,
        activePromo: m === 11
          ? { key: 'black_november', badge: 'BLACK NOVEMBER SALE', promo_code: 'BLACKNOV20', discount_percent: 20 }
          : (m === 12 ? { key: 'christmas_december', badge: 'CHRISTMAS & HOLIDAY SPECIAL', promo_code: 'XMAS15', discount_percent: 15 } : null),
        catalog: {
          freqLabels: { biweekly: 'Every 2 weeks', weekly: 'Weekly (-15%)', onetime: 'One-Time Clean' },
          services: {
            standard: { label: 'Standard Home Cleaning', short: 'Standard Home', desc: 'Regular upkeep', sizes: { cozy: 'Cozy · Studio–2 bed', family: 'Family · 3 bed / 2 bath', estate: 'Estate · 4+ bed' }, prices: { biweekly: { cozy: 15000, family: 19000, estate: 24000 }, weekly: { cozy: 13000, family: 16000, estate: 20500 } } },
            deep: { label: 'Deep Clean', short: 'Deep Clean', desc: 'Top-to-bottom reset', sizes: { cozy: 'Cozy · Studio–2 bed', family: 'Family · 3 bed / 2 bath', estate: 'Estate · 4+ bed' }, prices: { onetime: { cozy: 25000, family: 32000, estate: 42000 } } },
            move: { label: 'Move-In / Move-Out Cleaning', short: 'Move-In / Move-Out', desc: 'Empty-home turnover clean', sizes: { cozy: 'Cozy · Studio–2 bed', family: 'Family · 3 bed / 2 bath', estate: 'Estate · 4+ bed' }, prices: { onetime: { cozy: 30000, family: 38000, estate: 48000 } } },
            airbnb: { label: 'Airbnb / Short-Term Rental Turnover', short: 'Airbnb Turnover', desc: 'Linen reset & staging', sizes: { cozy: 'Cozy · Studio–2 bed', family: 'Family · 3 bed / 2 bath', estate: 'Estate · 4+ bed' }, prices: { onetime: { cozy: 14000, family: 18000, estate: null } } },
            office: { label: 'Commercial / Office Cleaning', short: 'Office Cleaning', desc: 'Custom workplace care', sizes: { cozy: 'Small Office (<2,000 sq ft)', family: 'Mid Office (2k–5k sq ft)', estate: 'Large Facility (5,000+ sq ft)' }, prices: { onetime: { cozy: null, family: null, estate: null } } },
          },
        },
      };
      const bv = document.getElementById('booking-view');
      if (bv) {
        const note = document.createElement('div');
        note.className = 'col-12';
        note.innerHTML = '<div class="alert alert-warning mb-0 small"><strong>Static Hosting Mode:</strong> Interactive instant checkout &amp; live calendar saving require your Node server (<code>backend/server.js</code>). View instant pricing below or call <a href="tel:+16787994634" class="fw-bold">678-799-4634</a> / email <a href="mailto:booking@boviccleaning.com" class="fw-bold">booking@boviccleaning.com</a> to lock in your date.</div>';
        bv.insertBefore(note, bv.firstChild);
      }
    }

    state.catalog = cfg.catalog;
    state.paymentMethods = cfg.paymentMethods || [];
    state.demoMode = cfg.demoMode;
    state.activePromo = cfg.activePromo || null;
    if (cfg.today) state.today = cfg.today;
    state.availability.timeSlots = cfg.timeSlots;
    state.availability.maxPerSlot = cfg.maxPerSlot;

    if (params.get('service') && state.catalog.services[params.get('service')]) state.service = params.get('service');
    if (params.get('size') && state.catalog.services[state.service].sizes[params.get('size')]) state.size = params.get('size');
    if (params.get('freq') && state.catalog.services[state.service].prices[params.get('freq')]) state.freq = params.get('freq');

    if (state.activePromo && state.activePromo.promo_code) {
      const chip = document.getElementById('active-promo-chip');
      const btn = document.getElementById('apply-active-promo-btn');
      btn.textContent = `${state.activePromo.badge}: Use code ${state.activePromo.promo_code} (${state.activePromo.discount_percent}% OFF${state.activePromo.applies_to_labels ? ` on ${state.activePromo.applies_to_labels}` : ''}) — Click to apply`;
      chip.style.display = 'block';
    }

    renderChoices();
    loadCalendar();
    const urlPromo = params.get('promo');
    if (urlPromo) {
      document.getElementById('promo-input').value = urlPromo;
      await validateAppliedPromo(urlPromo, false);
    }
  })();
})();
