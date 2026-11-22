(() => {
  let ME = null;
  let ALL_BOOKINGS = [];
  let ALL_USERS = [];
  let ACTIVE_FILTER = 'all';
  let ACTIVE_THREAD = 'broadcast';
  let ASSIGN_MODAL = null;
  let EDIT_MODAL = null;
  let CURRENT_DRAWER_ID = null;

  const esc = v => String(v == null ? '' : v)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

  const fmtMoney = c => c ? '$' + (c / 100).toFixed(2) : 'Quote';

  function getCookie(name) {
    const m = document.cookie.match(new RegExp('(?:^|;\\s*)' + name + '=([^;]*)'));
    return m ? decodeURIComponent(m[1]) : '';
  }

  function toast(msg) {
    const el = document.getElementById('toast');
    el.textContent = msg;
    el.style.display = 'block';
    clearTimeout(toast._t);
    toast._t = setTimeout(() => { el.style.display = 'none'; }, 3400);
  }

  async function api(path, opts = {}) {
    const method = (opts.method || 'GET').toUpperCase();
    const headers = { 'Content-Type': 'application/json', ...(opts.headers || {}) };
    if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) {
      headers['X-CSRF-Token'] = getCookie('bovic_csrf');
    }
    const res = await fetch(path, { ...opts, credentials: 'same-origin', headers });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      if (data.code === 'PASSWORD_CHANGE_REQUIRED') showForcePasswordView();
      throw new Error(data.error || 'Request failed');
    }
    return data;
  }

  function showLoginView() {
    document.getElementById('login-view').style.display = 'grid';
    document.getElementById('force-pw-view').style.display = 'none';
    document.getElementById('app-view').style.display = 'none';
  }

  function showForcePasswordView() {
    document.getElementById('login-view').style.display = 'none';
    document.getElementById('app-view').style.display = 'none';
    document.getElementById('force-pw-view').style.display = 'grid';
  }

  // Mobile sidebar
  const sidebar = document.getElementById('sidebar');
  const sBackdrop = document.getElementById('sidebar-backdrop');
  document.getElementById('mobile-menu-btn').addEventListener('click', () => {
    sidebar.classList.add('open'); sBackdrop.classList.add('open');
  });
  sBackdrop.addEventListener('click', () => {
    sidebar.classList.remove('open'); sBackdrop.classList.remove('open');
  });
  function closeMobileNav() {
    sidebar.classList.remove('open'); sBackdrop.classList.remove('open');
  }

  // Login
  document.getElementById('login-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const err = document.getElementById('login-err');
    err.style.display = 'none';
    try {
      const data = await api('/api/auth/login', {
        method: 'POST',
        body: JSON.stringify({
          email: document.getElementById('l-email').value,
          password: document.getElementById('l-pass').value,
        }),
      });
      document.getElementById('l-pass').value = '';
      ME = data.user;
      if (ME.must_change_password) {
        showForcePasswordView();
      } else {
        enterApp();
      }
    } catch (ex) {
      err.textContent = ex.message;
      err.style.display = 'block';
    }
  });

  // Forced password update on first login
  document.getElementById('force-pw-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const err = document.getElementById('force-pw-err');
    err.style.display = 'none';
    const cur = document.getElementById('fp-cur').value;
    const n1 = document.getElementById('fp-new').value;
    const n2 = document.getElementById('fp-confirm').value;
    if (n1 !== n2) {
      err.textContent = 'New passwords do not match';
      err.style.display = 'block';
      return;
    }
    try {
      await api('/api/auth/password', {
        method: 'PATCH',
        body: JSON.stringify({ current_password: cur, new_password: n1 }),
      });
      e.target.reset();
      ME.must_change_password = false;
      toast('Password secured! Welcome to Bovic Premier Portal.');
      enterApp();
    } catch (ex) {
      err.textContent = ex.message;
      err.style.display = 'block';
    }
  });

  document.getElementById('force-logout-btn').addEventListener('click', async () => {
    try { await api('/api/auth/logout', { method: 'POST' }); } catch {}
    showLoginView();
  });

  document.getElementById('logout-btn').addEventListener('click', async () => {
    try { await api('/api/auth/logout', { method: 'POST' }); } catch {}
    location.reload();
  });

  function switchTab(tab) {
    document.querySelectorAll('.sidebar .nav-btn[data-tab]').forEach(b => b.classList.toggle('active', b.dataset.tab === tab));
    document.querySelectorAll('.tab-pane-sec').forEach(s => s.classList.toggle('active', s.id === 'tab-' + tab));
    closeMobileNav();
    if (tab === 'messages') loadThreads();
    if (tab === 'payments') loadPaymentSettings();
    if (tab === 'security') loadSecurityAudit();
    if (tab === 'website' || tab === 'policies' || tab === 'plugins' || tab === 'seo') loadSiteCms();
  }

  document.querySelectorAll('.sidebar .nav-btn[data-tab]').forEach(btn => {
    btn.addEventListener('click', () => switchTab(btn.dataset.tab));
  });

  document.getElementById('refresh-all-btn').addEventListener('click', refreshAll);

  async function enterApp() {
    document.getElementById('login-view').style.display = 'none';
    document.getElementById('force-pw-view').style.display = 'none';
    document.getElementById('app-view').style.display = 'block';
    document.getElementById('u-name').textContent = ME.name;
    [document.getElementById('u-role-badge'), document.getElementById('mobile-role-txt')].forEach(b => {
      b.textContent = ME.role.replace('_', ' ');
      b.className = 'badge-role role-' + ME.role;
    });
    document.querySelectorAll('.super-only').forEach(el => { el.style.display = ME.role === 'super_admin' ? '' : 'none'; });
    document.querySelectorAll('.admin-only').forEach(el => { el.style.display = ME.role !== 'worker' ? '' : 'none'; });

    ASSIGN_MODAL = ASSIGN_MODAL || new bootstrap.Modal(document.getElementById('assignModal'));
    EDIT_MODAL = EDIT_MODAL || new bootstrap.Modal(document.getElementById('editUserModal'));
    await refreshAll();
  }

  async function refreshAll() {
    const stats = await api('/api/admin/stats');
    renderKpis(stats);

    const bData = await api('/api/admin/bookings');
    ALL_BOOKINGS = bData.bookings;
    renderBookings();

    if (ME.role !== 'worker') {
      const [uData, blk, em] = await Promise.all([
        api('/api/admin/users'),
        api('/api/admin/blocked-dates'),
        api('/api/admin/email-logs'),
      ]);
      ALL_USERS = uData.users;
      renderUsers();
      renderBlocked(blk.blockedDates);
      renderEmails(em.logs, stats.smtpConfigured);
    }
    if (CURRENT_DRAWER_ID) openDrawer(CURRENT_DRAWER_ID);
  }

  function renderKpis(s) {
    const kpi = document.getElementById('kpi-row');
    const unreadBadge = document.getElementById('badge-unread');
    unreadBadge.textContent = s.unreadMessages || 0;
    unreadBadge.style.display = s.unreadMessages ? 'inline-block' : 'none';

    if (ME.role === 'worker') {
      kpi.innerHTML = `
        <div class="col-6 col-md-3"><div class="kpi-card"><small>My Jobs</small><h2>${s.myJobs}</h2></div></div>
        <div class="col-6 col-md-3"><div class="kpi-card"><small>Today</small><h2>${s.todayJobs}</h2></div></div>
        <div class="col-6 col-md-3"><div class="kpi-card"><small>Upcoming</small><h2>${s.upcoming}</h2></div></div>
        <div class="col-6 col-md-3"><div class="kpi-card"><small>Unread Chat</small><h2 style="color:var(--green);">${s.unreadMessages}</h2></div></div>`;
    } else {
      const unBadge = document.getElementById('badge-unassigned');
      unBadge.textContent = s.needsWorker || 0;
      unBadge.style.display = s.needsWorker ? 'inline-block' : 'none';
      document.getElementById('pill-needs-cnt').textContent = s.needsWorker ? `(${s.needsWorker})` : '';

      kpi.innerHTML = `
        <div class="col-6 col-md-4 col-xl-2"><div class="kpi-card"><small>Paid Revenue</small><h2>$${(s.paidRevenueCents / 100).toFixed(0)}</h2></div></div>
        <div class="col-6 col-md-4 col-xl-2"><div class="kpi-card"><small>Needs Worker</small><h2 class="${s.needsWorker ? 'text-danger' : ''}">${s.needsWorker}</h2></div></div>
        <div class="col-6 col-md-4 col-xl-2"><div class="kpi-card"><small>Today's Jobs</small><h2>${s.todayJobs}</h2></div></div>
        <div class="col-6 col-md-4 col-xl-2"><div class="kpi-card"><small>Unpaid / Quotes</small><h2>${s.unpaid + s.quotes}</h2></div></div>
        <div class="col-6 col-md-4 col-xl-2"><div class="kpi-card"><small>Active Workers</small><h2>${s.activeWorkers}</h2></div></div>
        <div class="col-6 col-md-4 col-xl-2"><div class="kpi-card"><small>Unread Chat</small><h2 style="color:var(--green);">${s.unreadMessages}</h2></div></div>`;
    }
  }

  document.querySelectorAll('.filter-pill').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.filter-pill').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      ACTIVE_FILTER = btn.dataset.filter;
      renderBookings();
    });
  });
  document.getElementById('area-filter').addEventListener('change', renderBookings);
  document.getElementById('booking-search').addEventListener('input', renderBookings);

  function filteredBookings() {
    const q = document.getElementById('booking-search').value.trim().toLowerCase();
    const area = document.getElementById('area-filter').value;
    const today = new Date().toISOString().slice(0, 10);
    return ALL_BOOKINGS.filter(b => {
      if (ACTIVE_FILTER === 'needs_worker' && !(!b.assigned_worker_id && ['pending', 'confirmed'].includes(b.booking_status))) return false;
      if (ACTIVE_FILTER === 'unpaid' && !(b.payment_status === 'pending' && b.booking_status !== 'cancelled')) return false;
      if (ACTIVE_FILTER === 'today' && b.cleaning_date !== today) return false;
      if (ACTIVE_FILTER === 'completed' && b.booking_status !== 'completed') return false;
      if (area && b.service_area !== area) return false;
      if (q) {
        const hay = `${b.booking_code} ${b.customer_name} ${b.customer_email} ${b.customer_phone} ${b.address} ${b.service_type}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  }

  function statusPill(st) {
    const map = { pending: 'bg-secondary', confirmed: 'bg-primary', assigned: 'bg-info text-dark', in_progress: 'bg-warning text-dark', completed: 'bg-success', cancelled: 'bg-danger' };
    return `<span class="badge ${map[st] || 'bg-secondary'}">${esc(st.replace('_', ' '))}</span>`;
  }

  function renderBookings() {
    const list = filteredBookings();
    const tb = document.getElementById('bookings-tbody');
    const mob = document.getElementById('bookings-mobile');

    if (!list.length) {
      tb.innerHTML = '<tr><td colspan="7" class="text-center text-muted py-4">No bookings match this filter.</td></tr>';
      mob.innerHTML = '<div class="text-center text-muted py-4 small">No bookings match this filter.</div>';
      return;
    }

    tb.innerHTML = list.map(b => {
      const workerCell = ME.role === 'worker'
        ? `<span class="badge bg-light text-dark border">${esc(b.worker_name || 'Assigned to you')}</span>`
        : `<button type="button" class="worker-chip ${b.assigned_worker_id ? '' : 'unassigned'}" data-action="assign" data-id="${b.id}">
             <i class="fas ${b.assigned_worker_id ? 'fa-user-check' : 'fa-user-plus'}"></i>
             <span>${esc(b.worker_name || 'Assign Worker')}</span>
           </button>`;

      return `<tr>
        <td><strong>${esc(b.booking_code)}</strong><br><span class="fw-semibold">${esc(b.customer_name)}</span><br><span class="text-muted">${esc(b.customer_phone)}</span></td>
        <td><strong>${esc(b.service_type)}</strong><br><span class="text-muted">${esc(b.home_size)} &middot; ${esc(b.service_area)}</span></td>
        <td><strong>${esc(b.cleaning_date)}</strong><br>${esc(b.time_slot)}</td>
        <td><strong>${fmtMoney(b.price_cents)}</strong><br><span class="badge ${b.payment_status === 'paid' ? 'bg-success' : 'bg-warning text-dark'}">${esc(b.payment_status)}</span></td>
        <td>${statusPill(b.booking_status)}</td>
        <td>${workerCell}</td>
        <td class="text-end"><button type="button" class="btn btn-sm btn-outline-dark" data-action="drawer" data-id="${b.id}"><i class="fas fa-sliders-h me-1"></i>Open</button></td>
      </tr>`;
    }).join('');

    mob.innerHTML = list.map(b => `
      <div class="b-mcard">
        <div class="d-flex justify-content-between align-items-start mb-2">
          <div><strong>${esc(b.booking_code)}</strong> &middot; ${esc(b.customer_name)}<div class="small text-muted">${esc(b.cleaning_date)} at ${esc(b.time_slot)}</div></div>
          ${statusPill(b.booking_status)}
        </div>
        <div class="small mb-2">${esc(b.service_type)} (${esc(b.service_area)}) &middot; <strong>${fmtMoney(b.price_cents)}</strong> <span class="badge ${b.payment_status === 'paid' ? 'bg-success' : 'bg-warning text-dark'}">${esc(b.payment_status)}</span></div>
        <div class="d-flex gap-2 flex-wrap">
          ${ME.role === 'worker' ? '' : `<button type="button" class="worker-chip ${b.assigned_worker_id ? '' : 'unassigned'}" data-action="assign" data-id="${b.id}"><i class="fas fa-user-plus"></i><span>${esc(b.worker_name || 'Assign Worker')}</span></button>`}
          <button type="button" class="btn btn-sm btn-outline-dark ms-auto" data-action="drawer" data-id="${b.id}">Details &amp; Chat</button>
        </div>
      </div>`).join('');
  }

  // Event delegation for bookings table & mobile cards (zero inline onclick XSS risk)
  document.getElementById('tab-bookings').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-action]');
    if (!btn) return;
    const id = Number(btn.dataset.id);
    if (btn.dataset.action === 'assign') openAssignModal(id);
    if (btn.dataset.action === 'drawer') openDrawer(id);
  });

  async function openAssignModal(bookingId) {
    const b = ALL_BOOKINGS.find(x => x.id === bookingId);
    document.getElementById('assign-job-banner').innerHTML = `
      <strong>${esc(b.booking_code)}</strong> &middot; ${esc(b.service_type)} (${esc(b.home_size)})<br>
      <strong>When:</strong> ${esc(b.cleaning_date)} at ${esc(b.time_slot)} &nbsp;|&nbsp; <strong>Area:</strong> ${esc(b.service_area)} (${esc(b.address)})`;
    document.getElementById('assign-note').value = '';
    const candsEl = document.getElementById('assign-candidates');
    candsEl.innerHTML = '<div class="text-muted small">Checking cleaner areas &amp; availability...</div>';
    ASSIGN_MODAL.show();

    const { candidates } = await api(`/api/admin/bookings/${bookingId}/candidates`);
    candsEl.innerHTML = candidates.map(c => `
      <div class="cand-card ${c.current ? 'is-current' : ''} ${c.conflict ? 'has-conflict' : ''}">
        <div>
          <div class="fw-bold">${esc(c.name)} ${c.current ? '<span class="badge bg-success ms-1">Currently Assigned</span>' : ''}</div>
          <div class="small text-muted">${esc(c.service_areas)}</div>
          <div class="d-flex flex-wrap gap-1 mt-1">
            ${c.areaMatch ? `<span class="badge bg-success-subtle text-success border border-success-subtle">Covers ${esc(b.service_area)}</span>` : `<span class="badge bg-light text-muted border">Outside ${esc(b.service_area)}</span>`}
            ${c.conflict ? `<span class="badge bg-danger">Conflict at ${esc(b.time_slot)} (${esc(c.conflict)})</span>` : `<span class="badge bg-info-subtle text-dark border">Free at ${esc(b.time_slot)}</span>`}
            <span class="badge bg-light text-dark border">${c.sameDay} today &middot; ${c.week} this week</span>
          </div>
        </div>
        <div>
          ${c.current
            ? `<button type="button" class="btn btn-sm btn-outline-danger" data-assign-booking="${bookingId}" data-worker-id="">Unassign</button>`
            : `<button type="button" class="btn-emerald btn-sm" data-assign-booking="${bookingId}" data-worker-id="${c.id}">Assign</button>`}
        </div>
      </div>`).join('') || '<div class="text-muted small">No active workers found.</div>';
  }

  document.getElementById('assign-candidates').addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-assign-booking]');
    if (!btn) return;
    const bookingId = Number(btn.dataset.assignBooking);
    const workerId = btn.dataset.workerId ? Number(btn.dataset.workerId) : null;
    await api(`/api/admin/bookings/${bookingId}/assign`, {
      method: 'PATCH',
      body: JSON.stringify({
        worker_id: workerId,
        note: document.getElementById('assign-note').value,
        notify: document.getElementById('assign-notify').checked,
      }),
    });
    ASSIGN_MODAL.hide();
    toast(workerId ? 'Cleaner assigned & notified' : 'Cleaner unassigned');
    await refreshAll();
  });

  // Booking Detail Drawer
  async function openDrawer(id) {
    CURRENT_DRAWER_ID = id;
    document.getElementById('drawer-backdrop').classList.add('open');
    document.getElementById('detail-drawer').classList.add('open');
    const body = document.getElementById('drawer-body');
    body.innerHTML = '<div class="text-muted small">Loading booking details...</div>';

    const [{ booking: b, paymentLinks, emails }, threadData] = await Promise.all([
      api(`/api/admin/bookings/${id}`),
      api(`/api/messages?thread=booking:${id}`).catch(() => ({ messages: [] })),
    ]);

    document.getElementById('dr-code').textContent = `${b.booking_code} · ${b.cleaning_date} at ${b.time_slot}`;
    document.getElementById('dr-title').textContent = b.customer_name;

    const isStaff = ME.role !== 'worker';
    const statusOpts = isStaff ? ['pending', 'confirmed', 'assigned', 'in_progress', 'completed', 'cancelled'] : ['in_progress', 'completed'];

    body.innerHTML = `
      <div class="p-3 rounded mb-3 small" style="background:var(--cream);border:1px solid var(--border);">
        <div><strong>Service:</strong> ${esc(b.service_type)} (${esc(b.home_size)} &middot; ${esc(b.frequency)})</div>
        <div><strong>Location:</strong> ${esc(b.address)} (<strong>${esc(b.service_area)}</strong>)</div>
        <div><strong>Phone:</strong> <a href="tel:${esc(b.customer_phone)}">${esc(b.customer_phone)}</a> &nbsp;|&nbsp; <strong>Email:</strong> <a href="mailto:${esc(b.customer_email)}">${esc(b.customer_email)}</a></div>
        ${b.notes ? `<div class="mt-1"><strong>Notes:</strong> ${esc(b.notes)}</div>` : ''}
      </div>

      <div class="row g-2 mb-3">
        <div class="col-6">
          <label class="small fw-semibold text-muted">Job Status</label>
          <select class="form-select form-select-sm" id="dr-status-select">
            ${statusOpts.map(s => `<option value="${s}" ${b.booking_status === s ? 'selected' : ''}>${s.replace('_', ' ')}</option>`).join('')}
          </select>
        </div>
        <div class="col-6">
          <label class="small fw-semibold text-muted">Assigned Cleaner</label>
          ${isStaff
            ? `<button type="button" id="dr-assign-btn" class="worker-chip w-100 justify-content-center ${b.assigned_worker_id ? '' : 'unassigned'}"><i class="fas fa-user-plus"></i><span>${esc(b.worker_name || 'Assign Worker')}</span></button>`
            : `<div class="form-control form-control-sm bg-light">${esc(b.worker_name || 'You')}</div>`}
        </div>
      </div>

      ${isStaff ? `
      <div class="p-3 rounded mb-3 border">
        <div class="d-flex justify-content-between align-items-center mb-2">
          <h6 class="fw-bold mb-0">Payment &amp; Quote (${fmtMoney(b.price_cents)})</h6>
          <span class="badge ${b.payment_status === 'paid' ? 'bg-success' : 'bg-warning text-dark'}">${esc(b.payment_status)}</span>
        </div>
        ${b.payment_status !== 'paid' ? `
          <div class="input-group input-group-sm mb-2">
            <span class="input-group-text">$</span>
            <input type="number" step="0.01" id="dr-price" class="form-control" value="${b.price_cents ? (b.price_cents / 100).toFixed(2) : ''}" placeholder="Enter quote price">
            <button class="btn btn-outline-dark" type="button" id="dr-save-price-btn">Save Price</button>
          </div>
          <div class="d-flex flex-wrap gap-1 mb-2">
            ${paymentLinks.stripe_api ? `<button type="button" class="btn btn-sm btn-outline-primary dr-payreq-btn" data-method="stripe">Email Stripe Checkout</button>` : ''}
            ${paymentLinks.stripe_link ? `<button type="button" class="btn btn-sm btn-outline-primary dr-payreq-btn" data-method="stripe_link">Email Stripe Link</button>` : ''}
            ${paymentLinks.paypal ? `<button type="button" class="btn btn-sm btn-outline-primary dr-payreq-btn" data-method="paypal">Email PayPal Link</button>` : ''}
          </div>
          <div class="input-group input-group-sm">
            <select id="dr-paid-method" class="form-select">
              <option value="stripe">Stripe</option><option value="paypal">PayPal</option>
              <option value="zelle">Zelle</option><option value="cash">Cash</option><option value="other">Other</option>
            </select>
            <input id="dr-paid-ref" class="form-control" placeholder="Ref / receipt # (optional)">
            <button class="btn-emerald btn-sm" type="button" id="dr-mark-paid-btn">Mark Paid</button>
          </div>
        ` : `<div class="small text-muted">Paid via <strong>${esc(b.payment_method || 'card')}</strong> ${b.paid_at ? 'on ' + esc(b.paid_at) : ''}</div>`}
        <div class="mt-2 pt-2 border-top d-flex justify-content-between align-items-center">
          <small class="text-muted">24h reminder: ${b.reminder_24h_sent ? 'Sent' : 'Scheduled'} &middot; 2h: ${b.reminder_2h_sent ? 'Sent' : 'Scheduled'}</small>
          <button type="button" class="btn btn-sm btn-outline-dark" id="dr-remind-btn"><i class="fas fa-bell me-1"></i>Send Reminder</button>
        </div>
      </div>` : ''}

      <div class="p-3 rounded border mb-3">
        <h6 class="fw-bold mb-2"><i class="fas fa-comments me-1" style="color:var(--green);"></i>Job Communication</h6>
        <div class="d-flex flex-column gap-2 mb-3" style="max-height:240px;overflow-y:auto;">
          ${threadData.messages.length ? threadData.messages.map(m => `
            <div class="p-2 rounded small ${m.audience === 'customer' ? 'bg-warning-subtle border border-warning' : 'bg-light border'}">
              <div class="d-flex justify-content-between" style="font-size:11px;color:var(--muted);">
                <strong>${esc(m.sender_name)} (${esc(m.audience === 'customer' ? 'Emailed Customer' : m.sender_role.replace('_', ' '))})</strong>
                <span>${esc(m.created_at)}</span>
              </div>
              <div>${esc(m.body)}</div>
            </div>`).join('') : '<div class="small text-muted">No messages on this job yet.</div>'}
        </div>
        <form id="dr-msg-form">
          ${isStaff ? `
            <div class="d-flex gap-3 small mb-2">
              <label><input type="radio" name="dr-aud" value="team" checked> Team Note (office &amp; cleaner)</label>
              <label><input type="radio" name="dr-aud" value="customer"> Email Customer</label>
            </div>` : ''}
          <div class="input-group input-group-sm">
            <input id="dr-msg-input" class="form-control" placeholder="Write update or message..." required>
            <button class="btn-gold btn-sm" type="submit">Send</button>
          </div>
        </form>
      </div>

      ${isStaff && emails.length ? `
      <div class="small">
        <strong class="d-block mb-1">Emails Sent for This Booking</strong>
        ${emails.map(e => `<div class="border-bottom py-1 d-flex justify-content-between"><span>${esc(e.email_type)} &rarr; ${esc(e.recipient)}</span><span class="text-muted">${esc(e.status)}</span></div>`).join('')}
      </div>` : ''}
    `;

    // Bind drawer controls safely
    document.getElementById('dr-status-select').addEventListener('change', async (e) => {
      await api(`/api/admin/bookings/${id}/status`, { method: 'PATCH', body: JSON.stringify({ booking_status: e.target.value }) });
      toast('Status updated');
      refreshAll();
    });
    const assignBtn = document.getElementById('dr-assign-btn');
    if (assignBtn) assignBtn.addEventListener('click', () => openAssignModal(id));

    const savePriceBtn = document.getElementById('dr-save-price-btn');
    if (savePriceBtn) savePriceBtn.addEventListener('click', async () => {
      try {
        await api(`/api/admin/bookings/${id}/price`, { method: 'PATCH', body: JSON.stringify({ price: document.getElementById('dr-price').value }) });
        toast('Quote price saved');
        refreshAll();
      } catch (ex) { alert(ex.message); }
    });

    body.querySelectorAll('.dr-payreq-btn').forEach(btn => btn.addEventListener('click', async () => {
      try {
        await api(`/api/admin/bookings/${id}/payment-request`, { method: 'POST', body: JSON.stringify({ method: btn.dataset.method }) });
        toast('Payment link emailed to customer');
        refreshAll();
      } catch (ex) { alert(ex.message); }
    }));

    const markPaidBtn = document.getElementById('dr-mark-paid-btn');
    if (markPaidBtn) markPaidBtn.addEventListener('click', async () => {
      try {
        await api(`/api/admin/bookings/${id}/mark-paid`, {
          method: 'POST',
          body: JSON.stringify({ method: document.getElementById('dr-paid-method').value, reference: document.getElementById('dr-paid-ref').value }),
        });
        toast('Marked as paid & confirmation sent');
        refreshAll();
      } catch (ex) { alert(ex.message); }
    });

    const remindBtn = document.getElementById('dr-remind-btn');
    if (remindBtn) remindBtn.addEventListener('click', async () => {
      await api(`/api/admin/bookings/${id}/remind`, { method: 'POST' });
      toast('Reminder email sent');
      refreshAll();
    });

    document.getElementById('dr-msg-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const inp = document.getElementById('dr-msg-input');
      const audEl = document.querySelector('input[name="dr-aud"]:checked');
      await api('/api/messages', {
        method: 'POST',
        body: JSON.stringify({ thread: `booking:${id}`, body: inp.value, audience: audEl ? audEl.value : 'team' }),
      });
      inp.value = '';
      toast('Message sent');
      refreshAll();
    });
  }

  function closeDrawer() {
    CURRENT_DRAWER_ID = null;
    document.getElementById('drawer-backdrop').classList.remove('open');
    document.getElementById('detail-drawer').classList.remove('open');
  }
  document.getElementById('drawer-backdrop').addEventListener('click', closeDrawer);
  document.getElementById('drawer-close-btn').addEventListener('click', closeDrawer);

  // Messaging Hub
  async function loadThreads() {
    const { threads } = await api('/api/messages/threads');
    const listEl = document.getElementById('chat-threads');
    listEl.innerHTML = threads.map(t => `
      <button type="button" class="chat-thread-item ${ACTIVE_THREAD === t.key ? 'active' : ''}" data-thread-key="${esc(t.key)}" data-thread-title="${esc(t.title)}" data-thread-sub="${esc(t.subtitle)}">
        <div style="min-width:0;">
          <div class="fw-semibold small text-truncate">${t.kind === 'broadcast' ? '<i class="fas fa-bullhorn me-1 text-warning"></i>' : t.kind === 'booking' ? '<i class="fas fa-calendar me-1 text-success"></i>' : '<i class="fas fa-user me-1 text-primary"></i>'}${esc(t.title)}</div>
          <div class="text-muted text-truncate" style="font-size:11.5px;">${t.last ? esc(t.last.sender_name + ': ' + t.last.body) : esc(t.subtitle)}</div>
        </div>
        ${t.unread ? `<span class="nav-pill-cnt">${t.unread}</span>` : ''}
      </button>`).join('');

    if (ACTIVE_THREAD) {
      const t = threads.find(x => x.key === ACTIVE_THREAD) || threads[0];
      if (t) openThread(t.key, t.title, t.subtitle, false);
    }
  }

  document.getElementById('chat-threads').addEventListener('click', (e) => {
    const item = e.target.closest('.chat-thread-item');
    if (!item) return;
    openThread(item.dataset.threadKey, item.dataset.threadTitle, item.dataset.threadSub);
  });

  async function openThread(key, title, subtitle, reloadList = true) {
    ACTIVE_THREAD = key;
    document.getElementById('chat-title').textContent = title;
    document.getElementById('chat-sub').textContent = subtitle;
    const refreshBtn = document.getElementById('chat-refresh-btn');
    refreshBtn.style.display = 'inline-block';
    refreshBtn.onclick = () => openThread(key, title, subtitle);

    const form = document.getElementById('chat-form');
    const isStaff = ME.role !== 'worker';
    if (key === 'broadcast' && !isStaff) {
      form.style.display = 'none';
    } else {
      form.style.display = 'block';
      const opts = document.getElementById('chat-options');
      if (key.startsWith('booking:') && isStaff) {
        opts.innerHTML = `<label><input type="radio" name="c-aud" value="team" checked> Team Note</label>
          <label><input type="radio" name="c-aud" value="customer"> Email Customer</label>
          <label class="ms-auto"><input type="checkbox" id="c-email-staff" checked> Notify cleaner by email</label>`;
      } else if (key === 'broadcast') {
        opts.innerHTML = `<label><input type="checkbox" id="c-email-staff"> Also email all active cleaners</label>`;
      } else {
        opts.innerHTML = `<label><input type="checkbox" id="c-email-staff" checked> Also notify by email</label>`;
      }
    }

    const { messages } = await api(`/api/messages?thread=${encodeURIComponent(key)}`);
    const box = document.getElementById('chat-messages');
    box.innerHTML = messages.length ? messages.map(m => `
      <div class="msg-bubble ${m.sender_id === ME.id ? 'mine' : ''} ${m.audience === 'customer' ? 'customer-out' : ''}">
        <div class="msg-meta">${esc(m.sender_name)} &middot; ${esc(m.created_at)} ${m.audience === 'customer' ? '&middot; Emailed Customer' : ''}</div>
        <div>${esc(m.body)}</div>
      </div>`).join('') : '<div class="text-center text-muted my-auto small">No messages here yet. Start the conversation below!</div>';
    box.scrollTop = box.scrollHeight;
    if (reloadList) loadThreads();
    api('/api/admin/stats').then(renderKpis);
  }

  document.getElementById('chat-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const inp = document.getElementById('chat-input');
    const aud = document.querySelector('input[name="c-aud"]:checked');
    const notifyEl = document.getElementById('c-email-staff');
    await api('/api/messages', {
      method: 'POST',
      body: JSON.stringify({
        thread: ACTIVE_THREAD,
        body: inp.value,
        audience: aud ? aud.value : 'team',
        notify_email: notifyEl ? notifyEl.checked : false,
      }),
    });
    inp.value = '';
    await openThread(ACTIVE_THREAD, document.getElementById('chat-title').textContent, document.getElementById('chat-sub').textContent);
  });

  // Users (Workers & Admins)
  function renderUsers() {
    document.getElementById('workers-tbody').innerHTML = ALL_USERS.filter(u => u.role === 'worker').map(u => `
      <tr>
        <td><strong>${esc(u.name)}</strong><div class="text-muted">${esc(u.email)} &middot; ${esc(u.phone)}</div></td>
        <td>${esc(u.service_areas)}</td>
        <td><span class="badge bg-info text-dark">${u.open_jobs} open</span> <span class="badge bg-light text-dark border">${u.done_jobs} done</span></td>
        <td><span class="badge ${u.active ? 'bg-success' : 'bg-secondary'}">${u.active ? 'Active' : 'Disabled'}</span></td>
        <td class="text-end">
          <button type="button" class="btn btn-sm btn-outline-primary" data-user-act="msg" data-id="${u.id}" title="Message"><i class="fas fa-comment"></i></button>
          <button type="button" class="btn btn-sm btn-outline-dark" data-user-act="edit" data-id="${u.id}" title="Edit"><i class="fas fa-pen"></i></button>
          <button type="button" class="btn btn-sm btn-outline-dark" data-user-act="toggle" data-id="${u.id}">${u.active ? 'Disable' : 'Enable'}</button>
          ${ME.role === 'super_admin' ? `<button type="button" class="btn btn-sm btn-outline-danger" data-user-act="delete" data-id="${u.id}"><i class="fas fa-trash"></i></button>` : ''}
        </td>
      </tr>`).join('');

    if (ME.role === 'super_admin') {
      document.getElementById('admins-tbody').innerHTML = ALL_USERS.filter(u => u.role !== 'worker').map(u => `
        <tr>
          <td><strong>${esc(u.name)}</strong></td><td>${esc(u.email)}</td>
          <td><span class="badge-role role-${u.role}">${esc(u.role.replace('_', ' '))}</span></td>
          <td><span class="badge ${u.active ? 'bg-success' : 'bg-secondary'}">${u.active ? 'Active' : 'Disabled'}</span></td>
          <td class="text-end">${u.role === 'super_admin' ? '<span class="text-muted">Owner</span>' : `
            <button type="button" class="btn btn-sm btn-outline-dark" data-user-act="edit" data-id="${u.id}">Edit</button>
            <button type="button" class="btn btn-sm btn-outline-dark" data-user-act="toggle" data-id="${u.id}">${u.active ? 'Disable' : 'Enable'}</button>
            <button type="button" class="btn btn-sm btn-outline-danger" data-user-act="delete" data-id="${u.id}"><i class="fas fa-trash"></i></button>`}
          </td>
        </tr>`).join('');
    }
  }

  async function handleUserAction(e) {
    const btn = e.target.closest('[data-user-act]');
    if (!btn) return;
    const id = Number(btn.dataset.id);
    const act = btn.dataset.userAct;
    const u = ALL_USERS.find(x => x.id === id);
    if (!u) return;

    if (act === 'msg') {
      switchTab('messages');
      openThread(`worker:${u.id}`, u.name, u.service_areas);
    } else if (act === 'edit') {
      document.getElementById('eu-id').value = u.id;
      document.getElementById('eu-name').value = u.name;
      document.getElementById('eu-phone').value = u.phone;
      document.getElementById('eu-areas').value = u.service_areas;
      document.getElementById('eu-pass').value = '';
      EDIT_MODAL.show();
    } else if (act === 'toggle') {
      await api(`/api/admin/users/${id}/toggle`, { method: 'PATCH' });
      refreshAll();
    } else if (act === 'delete') {
      if (confirm(`Delete ${u.name}?`)) {
        await api(`/api/admin/users/${id}`, { method: 'DELETE' });
        refreshAll();
      }
    }
  }
  document.getElementById('workers-tbody').addEventListener('click', handleUserAction);
  document.getElementById('admins-tbody').addEventListener('click', handleUserAction);

  document.getElementById('edit-user-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const id = document.getElementById('eu-id').value;
    try {
      await api(`/api/admin/users/${id}`, {
        method: 'PATCH',
        body: JSON.stringify({
          name: document.getElementById('eu-name').value,
          phone: document.getElementById('eu-phone').value,
          service_areas: document.getElementById('eu-areas').value,
          password: document.getElementById('eu-pass').value || undefined,
        }),
      });
      EDIT_MODAL.hide();
      toast('Team member updated');
      refreshAll();
    } catch (ex) { alert(ex.message); }
  });

  document.getElementById('add-worker-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = Object.fromEntries(new FormData(e.target));
    f.role = 'worker';
    try { await api('/api/admin/users', { method: 'POST', body: JSON.stringify(f) }); e.target.reset(); toast('Worker created (must set private password on first login)'); refreshAll(); }
    catch (ex) { alert(ex.message); }
  });

  document.getElementById('add-admin-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = Object.fromEntries(new FormData(e.target));
    f.role = 'admin';
    try { await api('/api/admin/users', { method: 'POST', body: JSON.stringify(f) }); e.target.reset(); toast('Admin created (must set private password on first login)'); refreshAll(); }
    catch (ex) { alert(ex.message); }
  });

  // Payments (Stripe & PayPal)
  async function loadPaymentSettings() {
    const data = await api('/api/admin/settings/payments');
    const s = data.settings;
    document.getElementById('p-stripe-api').checked = s.stripe_checkout_enabled;
    document.getElementById('stripe-api-badge').textContent = data.stripeApiConfigured ? 'API Key Ready' : 'Demo Mode (set STRIPE_SECRET_KEY in .env)';
    document.getElementById('stripe-api-badge').className = 'badge ms-1 ' + (data.stripeApiConfigured ? 'bg-success' : 'bg-warning text-dark');
    document.getElementById('webhook-url').textContent = data.webhookUrl;

    document.getElementById('p-stripe-links').checked = s.stripe_links_enabled;
    document.getElementById('p-stripe-default').value = s.stripe_default_link || '';
    document.getElementById('p-paypal-enabled').checked = s.paypal_enabled;
    document.getElementById('p-paypal-link').value = s.paypal_link || '';
    document.getElementById('p-later-enabled').checked = s.pay_later_enabled;
    document.getElementById('p-later-label').value = s.pay_later_label || '';

    const activeList = data.activeMethods.length ? data.activeMethods.join(', ') : 'Demo Checkout Mode (no live payment method enabled yet)';
    document.getElementById('pay-status-banner').innerHTML = `<strong>Active on public checkout right now:</strong> ${esc(activeList)}`;

    document.getElementById('pay-items-tbody').innerHTML = data.items.map(it => `
      <tr>
        <td><strong>${esc(it.service)}</strong></td>
        <td>${esc(it.size)} &middot; <span class="text-muted">${esc(it.freq)}</span></td>
        <td><strong>$${(it.price_cents / 100).toFixed(0)}</strong></td>
        <td><input type="url" class="form-control form-control-sm item-stripe" data-k="${esc(it.key)}" value="${esc((s.stripe_item_links || {})[it.key] || '')}" placeholder="https://buy.stripe.com/..."></td>
        <td><input type="url" class="form-control form-control-sm item-paypal" data-k="${esc(it.key)}" value="${esc((s.paypal_item_links || {})[it.key] || '')}" placeholder="https://paypal.me/... (optional)"></td>
      </tr>`).join('');
  }

  document.getElementById('copy-webhook-btn').addEventListener('click', () => {
    navigator.clipboard.writeText(document.getElementById('webhook-url').textContent);
    toast('Webhook URL copied');
  });

  document.getElementById('payments-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const stripeItems = {};
    document.querySelectorAll('.item-stripe').forEach(el => { if (el.value.trim()) stripeItems[el.dataset.k] = el.value.trim(); });
    const paypalItems = {};
    document.querySelectorAll('.item-paypal').forEach(el => { if (el.value.trim()) paypalItems[el.dataset.k] = el.value.trim(); });

    try {
      await api('/api/admin/settings/payments', {
        method: 'PUT',
        body: JSON.stringify({
          stripe_checkout_enabled: document.getElementById('p-stripe-api').checked,
          stripe_links_enabled: document.getElementById('p-stripe-links').checked,
          stripe_default_link: document.getElementById('p-stripe-default').value.trim(),
          stripe_item_links: stripeItems,
          paypal_enabled: document.getElementById('p-paypal-enabled').checked,
          paypal_link: document.getElementById('p-paypal-link').value.trim(),
          paypal_item_links: paypalItems,
          pay_later_enabled: document.getElementById('p-later-enabled').checked,
          pay_later_label: document.getElementById('p-later-label').value.trim(),
        }),
      });
      toast('Stripe & PayPal settings saved!');
      loadPaymentSettings();
    } catch (ex) { alert(ex.message); }
  });

  // Calendar Blocking
  function renderBlocked(list) {
    document.getElementById('blocked-tbody').innerHTML = list.length ? list.map(d => `
      <tr><td><strong>${esc(d.date)}</strong></td><td>${esc(d.reason)}</td>
      <td class="text-end"><button type="button" class="btn btn-sm btn-outline-danger" data-unblock-id="${d.id}">Unblock</button></td></tr>`).join('')
      : '<tr><td colspan="3" class="text-muted text-center py-3">No blocked dates.</td></tr>';
  }
  document.getElementById('blocked-tbody').addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-unblock-id]');
    if (!btn) return;
    await api(`/api/admin/blocked-dates/${btn.dataset.unblockId}`, { method: 'DELETE' });
    refreshAll();
  });
  document.getElementById('block-date-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    try { await api('/api/admin/blocked-dates', { method: 'POST', body: JSON.stringify(Object.fromEntries(new FormData(e.target))) }); e.target.reset(); toast('Date blocked'); refreshAll(); }
    catch (ex) { alert(ex.message); }
  });

  // Email Logs
  function renderEmails(logs, smtpOn) {
    const pill = document.getElementById('smtp-status-pill');
    pill.textContent = smtpOn ? 'SMTP Live Sending Active' : 'Demo Log Mode (configure SMTP in backend/.env)';
    pill.className = 'badge ' + (smtpOn ? 'bg-success' : 'bg-warning text-dark');
    document.getElementById('emails-tbody').innerHTML = logs.length ? logs.map(l => `
      <tr><td>${esc(l.sent_at)}</td><td><span class="badge bg-info text-dark">${esc(l.email_type)}</span></td>
      <td>${esc(l.recipient)}</td><td>${esc(l.subject)}</td><td><span class="badge bg-secondary">${esc(l.status)}</span></td></tr>`).join('')
      : '<tr><td colspan="5" class="text-muted text-center py-3">No emails sent yet.</td></tr>';
  }

  // Security & Audit Logs (Super Admin)
  async function loadSecurityAudit() {
    const { logs, security } = await api('/api/admin/audit-logs');
    const checks = [
      ['HttpOnly + SameSite=Strict Cookie Auth', security.httpOnlyCookie],
      ['CSRF Token Verification', security.csrfTokenProtection],
      ['Strict CSP (script-src self)', security.cspStrictSelf],
      ['Brute-Force Rate Limit & Account Lockout', true],
      ['Strong Password & First-Login Rotation', true],
      ['HTTPS Transport Active', security.httpsActive],
    ];
    document.getElementById('sec-posture-grid').innerHTML = checks.map(([label, ok]) => `
      <div class="col-md-4 col-sm-6">
        <div class="p-2 rounded border small d-flex align-items-center justify-content-between" style="background:var(--cream);">
          <span>${esc(label)}</span>
          <span class="badge ${ok ? 'bg-success' : 'bg-warning text-dark'}">${ok ? 'Active' : 'Local HTTP'}</span>
        </div>
      </div>`).join('');

    document.getElementById('audit-tbody').innerHTML = logs.length ? logs.map(l => `
      <tr>
        <td>${esc(l.created_at)}</td>
        <td><span class="badge bg-dark">${esc(l.action)}</span></td>
        <td>${esc(l.actor_email || 'anonymous')}</td>
        <td>${esc(l.target)}</td>
        <td>${esc(l.ip)}</td>
        <td class="text-muted">${esc(l.details)}</td>
      </tr>`).join('') : '<tr><td colspan="6" class="text-muted text-center py-3">No audit events yet.</td></tr>';
  }

  document.getElementById('logout-all-btn').addEventListener('click', async () => {
    if (!confirm('Sign out ALL admins and workers across every browser and device?')) return;
    await api('/api/auth/logout-all', { method: 'POST' });
    location.reload();
  });

  document.getElementById('my-pw-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      await api('/api/auth/password', { method: 'PATCH', body: JSON.stringify(Object.fromEntries(new FormData(e.target))) });
      bootstrap.Modal.getInstance(document.getElementById('passwordModal')).hide();
      e.target.reset();
      toast('Password updated & older sessions revoked');
    } catch (ex) { alert(ex.message); }
  });

  // Website CMS, Logos, Live Pricing & Policies
  let SITE_CACHE = null;

  async function loadSiteCms() {
    const data = await api('/api/admin/site');
    const s = data.site;
    SITE_CACHE = s;

    const lv = s.logo_version || Date.now();
    ['logo-1', 'logo-2', 'logo-3'].forEach(v => {
      const img = document.getElementById('prev-' + v);
      if (img) img.src = `assets/images/resources/${v}.png?v=${lv}`;
    });

    document.getElementById('cms-company').value = s.company_name || '';
    document.getElementById('cms-tagline').value = s.tagline || '';
    document.getElementById('cms-phone').value = s.phone || '';
    document.getElementById('cms-hours').value = s.hours || '';
    document.getElementById('cms-bemail').value = s.booking_email || '';
    document.getElementById('cms-iemail').value = s.info_email || '';
    document.getElementById('cms-areas').value = s.service_areas || '';
    document.getElementById('cms-fabout').value = s.footer_about || '';
    document.getElementById('cms-copy').value = s.copyright_text || '';

    document.getElementById('cms-hero-eye').value = (s.hero && s.hero.eyebrow) || '';
    document.getElementById('cms-hero-sub').value = (s.hero && s.hero.subtitle) || '';
    document.getElementById('cms-hero-cta').value = (s.hero && s.hero.cta_text) || '';
    document.getElementById('cms-ab-title').value = (s.about && s.about.title) || '';
    document.getElementById('cms-ab-text').value = (s.about && s.about.text) || '';
    document.getElementById('cms-ab-yrs').value = (s.about && s.about.experience_years) || '';
    document.getElementById('cms-ab-staff').value = (s.about && s.about.active_staff) || '';
    document.getElementById('cms-fb').value = (s.social && s.social.facebook) || '';
    document.getElementById('cms-ig').value = (s.social && s.social.instagram) || '';
    document.getElementById('cms-tw').value = (s.social && s.social.twitter) || '';
    document.getElementById('cms-li').value = (s.social && s.social.linkedin) || '';
    document.getElementById('cms-pin').value = (s.social && s.social.pinterest) || '';
    document.getElementById('cms-tt').value = (s.social && s.social.tiktok) || '';
    document.getElementById('cms-yt').value = (s.social && s.social.youtube) || '';
    document.getElementById('cms-gbp').value = (s.social && s.social.google_business) || '';

    document.getElementById('cms-pricing-tbody').innerHTML = data.pricingItems.map(it => `
      <tr>
        <td><strong>${esc(it.service)}</strong></td>
        <td>${esc(it.size)}</td>
        <td>${esc(it.freq)}</td>
        <td><input type="number" step="1" min="10" class="form-control form-control-sm cms-price-inp" data-k="${esc(it.key)}" value="${Math.round(it.price_cents / 100)}"></td>
      </tr>`).join('');

    const p = s.policies || {};
    document.getElementById('pol-privacy-intro').value = p.privacy_intro || '';
    document.getElementById('pol-privacy-collection').value = p.privacy_collection || '';
    document.getElementById('pol-privacy-photos').value = p.privacy_photos || '';
    document.getElementById('pol-privacy-security').value = p.privacy_security || '';
    document.getElementById('pol-terms-booking').value = p.terms_booking || '';
    document.getElementById('pol-terms-cancellation').value = p.terms_cancellation || '';
    document.getElementById('pol-terms-guarantee').value = p.terms_guarantee || '';
    document.getElementById('pol-terms-payment').value = p.terms_payment || '';
    document.getElementById('pol-terms-exclusions').value = p.terms_exclusions || '';
    document.getElementById('pol-terms-risks').value = p.terms_risks || '';

    // Seasonal Promo Plugins (Black November & Christmas December)
    const plg = s.plugins || {};
    const nov = plg.black_november || {};
    const dec = plg.christmas_december || {};
    document.getElementById('plg-nov-enabled').checked = nov.enabled !== false;
    document.getElementById('plg-nov-mode').value = nov.mode || 'auto';
    document.getElementById('plg-nov-badge').value = nov.badge || '';
    document.getElementById('plg-nov-title').value = nov.title || '';
    document.getElementById('plg-nov-sub').value = nov.subtitle || '';
    document.getElementById('plg-nov-code').value = nov.promo_code || '';
    document.getElementById('plg-nov-pct').value = nov.discount_percent != null ? nov.discount_percent : 20;
    document.getElementById('plg-nov-cta').value = nov.cta_text || '';
    document.getElementById('plg-nov-end').value = nov.end_date || '';

    document.getElementById('plg-dec-enabled').checked = dec.enabled !== false;
    document.getElementById('plg-dec-mode').value = dec.mode || 'auto';
    document.getElementById('plg-dec-badge').value = dec.badge || '';
    document.getElementById('plg-dec-title').value = dec.title || '';
    document.getElementById('plg-dec-sub').value = dec.subtitle || '';
    document.getElementById('plg-dec-code').value = dec.promo_code || '';
    document.getElementById('plg-dec-pct').value = dec.discount_percent != null ? dec.discount_percent : 15;
    document.getElementById('plg-dec-cta').value = dec.cta_text || '';
    document.getElementById('plg-dec-end').value = dec.end_date || '';
    document.getElementById('plg-dec-decor').checked = dec.decorations !== false;

    const livePromo = data.activePromo;
    const statusEl = document.getElementById('plg-live-status');
    statusEl.textContent = livePromo ? `${livePromo.badge} (Code: ${livePromo.promo_code} · ${livePromo.discount_percent}% OFF)` : 'No seasonal banner active right now';
    statusEl.className = livePromo ? 'text-success' : 'text-muted';

    // SEO, Metadata & Google Ads / Analytics
    const seo = s.seo || {};
    const mkt = s.marketing || {};
    document.getElementById('seo-default-title').value = seo.default_title || '';
    document.getElementById('seo-title-suffix').value = seo.site_title_suffix || '';
    document.getElementById('seo-canonical').value = seo.canonical_base || '';
    document.getElementById('seo-meta-desc').value = seo.meta_description || '';
    document.getElementById('seo-keywords').value = seo.meta_keywords || '';
    document.getElementById('seo-og-image').value = seo.og_image || '';
    document.getElementById('seo-price-range').value = seo.schema_price_range || '$$';
    document.getElementById('seo-robots-index').checked = seo.robots_index !== false;

    document.getElementById('mkt-gads-id').value = mkt.google_ads_id || '';
    document.getElementById('mkt-gads-label').value = mkt.google_ads_label || '';
    document.getElementById('mkt-ga4-id').value = mkt.ga4_id || '';
    document.getElementById('mkt-gtm-id').value = mkt.gtm_id || '';
    document.getElementById('mkt-gsc-token').value = mkt.search_console_token || '';
    document.getElementById('mkt-fb-pixel').value = mkt.meta_pixel_id || '';

    const fu = s.followups || {};
    document.getElementById('fu-thanks-on').checked = fu.thanks_enabled !== false;
    document.getElementById('fu-thanks-hours').value = fu.thanks_delay_hours || 3;
    document.getElementById('fu-review-url').value = fu.review_url || '';
    document.getElementById('fu-rebook-on').checked = fu.rebook_enabled !== false;
    document.getElementById('fu-rebook-days').value = fu.rebook_days || 30;
    document.getElementById('fu-rebook-offer').value = fu.rebook_offer || '';
    document.getElementById('fu-provider').textContent = data.emailProvider || 'not set up yet (emails are only logged)';
    updateSerpPreview();
  }

  function updateSerpPreview() {
    const t = document.getElementById('seo-default-title').value || 'Bovic Premier Cleaning Pros LLC';
    const d = document.getElementById('seo-meta-desc').value || '';
    const u = document.getElementById('seo-canonical').value || 'https://boviccleaning.com';
    document.getElementById('seo-serp-title').textContent = t.slice(0, 65);
    document.getElementById('seo-serp-url').textContent = u.replace(/\/+$/, '') + ' › ...';
    document.getElementById('seo-serp-desc').textContent = d.slice(0, 165);
    document.getElementById('seo-desc-count').textContent = `${d.length} / 160`;
  }
  ['seo-default-title', 'seo-meta-desc', 'seo-canonical'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.addEventListener('input', updateSerpPreview);
  });

  document.querySelectorAll('.logo-upload-input').forEach(inp => {
    inp.addEventListener('change', () => {
      const file = inp.files && inp.files[0];
      if (!file) return;
      if (file.size > 2 * 1024 * 1024) {
        alert('Logo must be under 2 MB.');
        inp.value = '';
        return;
      }
      const reader = new FileReader();
      reader.onload = async () => {
        try {
          const res = await api('/api/admin/site/logo', {
            method: 'POST',
            body: JSON.stringify({ variant: inp.dataset.variant, dataUrl: reader.result }),
          });
          document.getElementById('prev-' + inp.dataset.variant).src = res.src;
          inp.value = '';
          toast(`${inp.dataset.variant} updated across website!`);
        } catch (ex) { alert(ex.message); }
      };
      reader.readAsDataURL(file);
    });
  });

  document.querySelectorAll('.logo-reset-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      try {
        const res = await api('/api/admin/site/logo/reset', {
          method: 'POST',
          body: JSON.stringify({ variant: btn.dataset.variant }),
        });
        document.getElementById('prev-' + btn.dataset.variant).src = res.src;
        toast(`${btn.dataset.variant} restored to default`);
      } catch (ex) { alert(ex.message); }
    });
  });

  document.getElementById('site-cms-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const pricingOverrides = {};
    document.querySelectorAll('.cms-price-inp').forEach(inp => {
      pricingOverrides[inp.dataset.k] = Number(inp.value);
    });
    const payload = {
      site: {
        ...(SITE_CACHE || {}),
        company_name: document.getElementById('cms-company').value,
        tagline: document.getElementById('cms-tagline').value,
        phone: document.getElementById('cms-phone').value,
        hours: document.getElementById('cms-hours').value,
        booking_email: document.getElementById('cms-bemail').value,
        info_email: document.getElementById('cms-iemail').value,
        service_areas: document.getElementById('cms-areas').value,
        footer_about: document.getElementById('cms-fabout').value,
        copyright_text: document.getElementById('cms-copy').value,
        hero: {
          eyebrow: document.getElementById('cms-hero-eye').value,
          subtitle: document.getElementById('cms-hero-sub').value,
          cta_text: document.getElementById('cms-hero-cta').value,
        },
        about: {
          title: document.getElementById('cms-ab-title').value,
          text: document.getElementById('cms-ab-text').value,
          experience_years: document.getElementById('cms-ab-yrs').value,
          active_staff: document.getElementById('cms-ab-staff').value,
        },
        social: {
          facebook: document.getElementById('cms-fb').value,
          instagram: document.getElementById('cms-ig').value,
          twitter: document.getElementById('cms-tw').value,
          linkedin: document.getElementById('cms-li').value,
          pinterest: document.getElementById('cms-pin').value,
          tiktok: document.getElementById('cms-tt').value,
          youtube: document.getElementById('cms-yt').value,
          google_business: document.getElementById('cms-gbp').value,
        },
      },
      pricingOverrides,
    };
    try {
      await api('/api/admin/site', { method: 'PUT', body: JSON.stringify(payload) });
      toast('Website content & live prices saved!');
      loadSiteCms();
    } catch (ex) { alert(ex.message); }
  });

  document.getElementById('policies-cms-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const payload = {
      site: {
        ...(SITE_CACHE || {}),
        policies: {
          privacy_intro: document.getElementById('pol-privacy-intro').value,
          privacy_collection: document.getElementById('pol-privacy-collection').value,
          privacy_photos: document.getElementById('pol-privacy-photos').value,
          privacy_security: document.getElementById('pol-privacy-security').value,
          terms_booking: document.getElementById('pol-terms-booking').value,
          terms_cancellation: document.getElementById('pol-terms-cancellation').value,
          terms_guarantee: document.getElementById('pol-terms-guarantee').value,
          terms_payment: document.getElementById('pol-terms-payment').value,
          terms_exclusions: document.getElementById('pol-terms-exclusions').value,
          terms_risks: document.getElementById('pol-terms-risks').value,
        },
      },
    };
    try {
      await api('/api/admin/site', { method: 'PUT', body: JSON.stringify(payload) });
      toast('Policies & risk disclosures saved live!');
      loadSiteCms();
    } catch (ex) { alert(ex.message); }
  });

  document.getElementById('plugins-cms-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const payload = {
      site: {
        ...(SITE_CACHE || {}),
        plugins: {
          black_november: {
            enabled: document.getElementById('plg-nov-enabled').checked,
            mode: document.getElementById('plg-nov-mode').value,
            badge: document.getElementById('plg-nov-badge').value,
            title: document.getElementById('plg-nov-title').value,
            subtitle: document.getElementById('plg-nov-sub').value,
            promo_code: document.getElementById('plg-nov-code').value.toUpperCase(),
            discount_percent: Number(document.getElementById('plg-nov-pct').value || 0),
            cta_text: document.getElementById('plg-nov-cta').value,
            end_date: document.getElementById('plg-nov-end').value,
          },
          christmas_december: {
            enabled: document.getElementById('plg-dec-enabled').checked,
            mode: document.getElementById('plg-dec-mode').value,
            badge: document.getElementById('plg-dec-badge').value,
            title: document.getElementById('plg-dec-title').value,
            subtitle: document.getElementById('plg-dec-sub').value,
            promo_code: document.getElementById('plg-dec-code').value.toUpperCase(),
            discount_percent: Number(document.getElementById('plg-dec-pct').value || 0),
            cta_text: document.getElementById('plg-dec-cta').value,
            end_date: document.getElementById('plg-dec-end').value,
            decorations: document.getElementById('plg-dec-decor').checked,
          },
        },
      },
    };
    try {
      await api('/api/admin/site', { method: 'PUT', body: JSON.stringify(payload) });
      toast('Seasonal promo plugins updated!');
      loadSiteCms();
    } catch (ex) { alert(ex.message); }
  });

  document.getElementById('seo-cms-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const payload = {
      site: {
        ...(SITE_CACHE || {}),
        seo: {
          default_title: document.getElementById('seo-default-title').value,
          site_title_suffix: document.getElementById('seo-title-suffix').value,
          canonical_base: document.getElementById('seo-canonical').value,
          meta_description: document.getElementById('seo-meta-desc').value,
          meta_keywords: document.getElementById('seo-keywords').value,
          og_image: document.getElementById('seo-og-image').value,
          schema_price_range: document.getElementById('seo-price-range').value,
          robots_index: document.getElementById('seo-robots-index').checked,
        },
        marketing: {
          google_ads_id: document.getElementById('mkt-gads-id').value.trim(),
          google_ads_label: document.getElementById('mkt-gads-label').value.trim(),
          ga4_id: document.getElementById('mkt-ga4-id').value.trim(),
          gtm_id: document.getElementById('mkt-gtm-id').value.trim(),
          search_console_token: document.getElementById('mkt-gsc-token').value.trim(),
          meta_pixel_id: document.getElementById('mkt-fb-pixel').value.trim(),
        },
        followups: {
          thanks_enabled: document.getElementById('fu-thanks-on').checked,
          thanks_delay_hours: Number(document.getElementById('fu-thanks-hours').value),
          review_url: document.getElementById('fu-review-url').value.trim(),
          rebook_enabled: document.getElementById('fu-rebook-on').checked,
          rebook_days: Number(document.getElementById('fu-rebook-days').value),
          rebook_offer: document.getElementById('fu-rebook-offer').value.trim(),
        },
      },
    };
    try {
      await api('/api/admin/site', { method: 'PUT', body: JSON.stringify(payload) });
      toast('SEO, tracking & follow-up email settings saved!');
      loadSiteCms();
    } catch (ex) { alert(ex.message); }
  });

  document.getElementById('fu-test-btn').addEventListener('click', async () => {
    const btn = document.getElementById('fu-test-btn');
    const msg = document.getElementById('fu-test-msg');
    btn.disabled = true;
    msg.textContent = 'Sending…';
    try {
      const r = await api('/api/admin/followups/test', { method: 'POST', body: '{}' });
      const st = r.statuses || [];
      msg.textContent = st.every(x => x === 'sent')
        ? `Sent 2 sample emails to ${r.to}. Check your inbox (and spam).`
        : st.every(x => x === 'logged_demo')
          ? 'No email service is set up yet, so the samples were only logged. Add Resend or Zoho in backend/.env.'
          : `Problem sending: ${st.filter(x => x !== 'sent').join('; ')}`;
    } catch (ex) { msg.textContent = ex.message; }
    btn.disabled = false;
  });

  // Boot: check existing HttpOnly session cookie
  (async () => {
    try {
      const data = await api('/api/auth/me');
      ME = data.user;
      if (ME.must_change_password) showForcePasswordView();
      else enterApp();
    } catch {
      showLoginView();
    }
  })();
})();
