(() => {
  const stage = document.getElementById('bovic-3d-stage');
  if (!stage) return;

  const STAGES = [
    {
      num: '01',
      badge: 'Google Search & Ads',
      title: '1. Find Bovic on Google',
      desc: 'North Atlanta homeowners discover Bovic Premier through local SEO, Google Maps, and tracked Google Ads campaigns with live schema pricing.',
      camAzimuth: -0.95,
      camPolar: 1.02,
      camDist: 14.5,
      focus: [-3.2, 2.2, 1.5],
      accent: 0x4285f4,
    },
    {
      num: '02',
      badge: 'Live Calendar',
      title: '2. Pick Date & Time Slot',
      desc: 'Our live calendar prevents double-booking across Buckhead, Sandy Springs, Roswell, and Alpharetta and reserves your exact arrival window.',
      camAzimuth: -0.2,
      camPolar: 0.98,
      camDist: 14.2,
      focus: [-1.4, 1.6, 2.8],
      accent: 0x0a7158,
    },
    {
      num: '03',
      badge: 'Stripe & PayPal',
      title: '3. Promo & Secure Checkout',
      desc: 'Apply seasonal Black November or Holiday promo codes and check out via Stripe, PayPal, or Pay Later while firing verified conversion events.',
      camAzimuth: 0.72,
      camPolar: 1.0,
      camDist: 14.2,
      focus: [2.2, 1.6, 2.6],
      accent: 0xf1ab21,
    },
    {
      num: '04',
      badge: 'Pro Dispatch',
      title: '4. Reminders & Pro Arrival',
      desc: 'Automatic confirmation emails plus 24-hour and 2-hour alerts go out as our Admin Portal assigns an area-matched cleaner directly to your home.',
      camAzimuth: 1.35,
      camPolar: 1.04,
      camDist: 14.6,
      focus: [1.6, 0.8, 3.2],
      accent: 0x34d399,
    },
    {
      num: '05',
      badge: '48h Guarantee',
      title: '5. Spotless Clean & QA Glow',
      desc: 'Eco-safe deep cleaning transforms kitchens, baths, and living areas—verified with room checklists and our 48-hour satisfaction guarantee.',
      camAzimuth: 0.35,
      camPolar: 0.96,
      camDist: 13.8,
      focus: [0, 1.4, 0],
      accent: 0xf1ab21,
    },
  ];

  let activeIdx = 0;
  let autoPlay = true;
  let stageElapsed = 0;
  const STAGE_DURATION = 5.2;

  const cardsBox = document.getElementById('bovic-flow-steps');
  const toggleBtn = document.getElementById('bovic-flow-toggle');
  const resetBtn = document.getElementById('bovic-flow-reset');
  const hudTitle = document.getElementById('bovic-3d-hud-title');
  const hudBadge = document.getElementById('bovic-3d-hud-badge');

  function renderCards() {
    if (!cardsBox) return;
    cardsBox.innerHTML = '';
    STAGES.forEach((st, idx) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'bovic-flow-step-btn' + (idx === activeIdx ? ' active' : '');
      btn.dataset.idx = String(idx);

      const numEl = document.createElement('span');
      numEl.className = 'bovic-flow-num';
      numEl.textContent = st.num;

      const body = document.createElement('div');
      body.className = 'bovic-flow-step-body';
      const head = document.createElement('div');
      head.className = 'bovic-flow-step-head';
      const ttl = document.createElement('strong');
      ttl.textContent = st.title;
      const bdg = document.createElement('span');
      bdg.className = 'bovic-flow-pill';
      bdg.textContent = st.badge;
      head.appendChild(ttl);
      head.appendChild(bdg);

      const p = document.createElement('p');
      p.textContent = st.desc;

      body.appendChild(head);
      body.appendChild(p);
      btn.appendChild(numEl);
      btn.appendChild(body);
      btn.addEventListener('click', () => {
        setStage(idx);
        stageElapsed = 0;
      });
      cardsBox.appendChild(btn);
    });
  }

  function updateHud() {
    const st = STAGES[activeIdx];
    if (hudTitle) hudTitle.textContent = st.title;
    if (hudBadge) hudBadge.textContent = `Step ${st.num} / 05 · ${st.badge}`;
    if (cardsBox) {
      cardsBox.querySelectorAll('.bovic-flow-step-btn').forEach((el, i) => {
        el.classList.toggle('active', i === activeIdx);
      });
    }
  }

  // Camera spherical orbit target & current state
  const camState = {
    azimuth: STAGES[0].camAzimuth,
    polar: STAGES[0].camPolar,
    dist: STAGES[0].camDist,
    targetAz: STAGES[0].camAzimuth,
    targetPol: STAGES[0].camPolar,
    targetDist: STAGES[0].camDist,
    lookAtX: 0,
    lookAtY: 1.4,
    lookAtZ: 0,
    targetLookX: 0,
    targetLookY: 1.4,
    targetLookZ: 0,
    userDragging: false,
    userOverrideTimer: 0,
  };

  function setStage(idx) {
    activeIdx = ((idx % STAGES.length) + STAGES.length) % STAGES.length;
    const st = STAGES[activeIdx];
    camState.targetAz = st.camAzimuth;
    camState.targetPol = st.camPolar;
    camState.targetDist = st.camDist;
    camState.targetLookX = st.focus[0] * 0.42;
    camState.targetLookY = Math.max(1.1, st.focus[1] * 0.65);
    camState.targetLookZ = st.focus[2] * 0.42;
    updateHud();
  }

  renderCards();
  updateHud();

  if (toggleBtn) {
    toggleBtn.addEventListener('click', () => {
      autoPlay = !autoPlay;
      toggleBtn.textContent = autoPlay ? 'Pause Auto Tour' : 'Resume Auto Tour';
    });
  }
  if (resetBtn) {
    resetBtn.addEventListener('click', () => {
      camState.userOverrideTimer = 0;
      setStage(activeIdx);
    });
  }

  if (typeof window.THREE === 'undefined') {
    const fallback = document.createElement('div');
    fallback.style.cssText = 'color:#fff;padding:48px 24px;text-align:center;';
    fallback.textContent = '3D WebGL engine loading... Click any step on the right to preview the Bovic Premier workflow.';
    stage.appendChild(fallback);
    return;
  }

  const THREE = window.THREE;
  let renderer;
  try {
    renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, powerPreference: 'high-performance' });
  } catch {
    const fallback = document.createElement('div');
    fallback.style.cssText = 'color:#cfe3dd;padding:48px 24px;text-align:center;';
    fallback.textContent = 'Interactive 3D view requires WebGL support. Use the workflow steps on the right to explore our 5-step Google-to-Clean process.';
    stage.appendChild(fallback);
    return;
  }

  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.12;
  renderer.domElement.style.cssText = 'width:100%;height:100%;display:block;cursor:grab;touch-action:none;';
  stage.appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  scene.fog = new THREE.FogExp2(0x071f1c, 0.022);

  const camera = new THREE.PerspectiveCamera(42, stage.clientWidth / Math.max(1, stage.clientHeight), 0.1, 100);

  function handleResize() {
    const w = stage.clientWidth || 640;
    const h = stage.clientHeight || 460;
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    renderer.setSize(w, h, false);
  }
  handleResize();
  window.addEventListener('resize', handleResize);

  // Lighting
  const hemi = new THREE.HemisphereLight(0xdff5ee, 0x0b241f, 0.85);
  scene.add(hemi);

  const sun = new THREE.DirectionalLight(0xfff5e0, 1.45);
  sun.position.set(8, 13, 9);
  sun.castShadow = true;
  sun.shadow.mapSize.set(1024, 1024);
  sun.shadow.camera.near = 2;
  sun.shadow.camera.far = 35;
  sun.shadow.camera.left = -9;
  sun.shadow.camera.right = 9;
  sun.shadow.camera.top = 9;
  sun.shadow.camera.bottom = -9;
  scene.add(sun);

  const rim = new THREE.DirectionalLight(0x38d9a9, 0.65);
  rim.position.set(-9, 6, -7);
  scene.add(rim);

  const warmHouseLight = new THREE.PointLight(0xf1ab21, 1.3, 10);
  warmHouseLight.position.set(0, 2.3, 0.4);
  scene.add(warmHouseLight);

  // Materials
  const matEmerald = new THREE.MeshStandardMaterial({ color: 0x0a7158, roughness: 0.45, metalness: 0.12 });
  const matDarkPine = new THREE.MeshStandardMaterial({ color: 0x0c342f, roughness: 0.55, metalness: 0.18 });
  const matGold = new THREE.MeshStandardMaterial({ color: 0xf1ab21, roughness: 0.28, metalness: 0.62, emissive: 0x3b2400 });
  const matCream = new THREE.MeshStandardMaterial({ color: 0xf4efe8, roughness: 0.68, metalness: 0.04 });
  const matRoof = new THREE.MeshStandardMaterial({ color: 0x1a2625, roughness: 0.52, metalness: 0.25 });
  const matFloorWood = new THREE.MeshStandardMaterial({ color: 0xc8a378, roughness: 0.55 });
  const matGlass = new THREE.MeshStandardMaterial({ color: 0x99f6e4, roughness: 0.1, metalness: 0.1, transparent: true, opacity: 0.65, emissive: 0x0e4f42 });
  const matGoogleBlue = new THREE.MeshStandardMaterial({ color: 0x4285f4, roughness: 0.25, metalness: 0.35, emissive: 0x0e2a5c });
  const matGoogleRed = new THREE.MeshStandardMaterial({ color: 0xea4335, roughness: 0.25, metalness: 0.35, emissive: 0x4a0f0a });
  const matGoogleGreen = new THREE.MeshStandardMaterial({ color: 0x34a853, roughness: 0.25, metalness: 0.35, emissive: 0x0c3b1a });
  const matSlate = new THREE.MeshStandardMaterial({ color: 0x243330, roughness: 0.72 });

  const world = new THREE.Group();
  scene.add(world);

  // Base Island & Outer Gold Ring
  const island = new THREE.Mesh(new THREE.CylinderGeometry(6.6, 7.1, 0.55, 64), matDarkPine);
  island.position.y = -0.28;
  island.receiveShadow = true;
  world.add(island);

  const lawn = new THREE.Mesh(new THREE.CylinderGeometry(6.15, 6.2, 0.12, 64), new THREE.MeshStandardMaterial({ color: 0x115241, roughness: 0.85 }));
  lawn.position.y = 0.04;
  lawn.receiveShadow = true;
  world.add(lawn);

  const outerRing = new THREE.Mesh(new THREE.TorusGeometry(6.45, 0.045, 16, 96), matGold);
  outerRing.rotation.x = Math.PI / 2;
  outerRing.position.y = 0.08;
  world.add(outerRing);

  // Stone Driveway Path
  const driveway = new THREE.Mesh(new THREE.BoxGeometry(2.1, 0.08, 4.4), matSlate);
  driveway.position.set(1.5, 0.09, 3.3);
  driveway.receiveShadow = true;
  world.add(driveway);

  // Central Residence (Cutaway Modern Home)
  const house = new THREE.Group();
  world.add(house);

  const houseFloor = new THREE.Mesh(new THREE.BoxGeometry(4.8, 0.24, 3.9), matFloorWood);
  houseFloor.position.set(-0.3, 0.22, -0.2);
  houseFloor.castShadow = true;
  houseFloor.receiveShadow = true;
  house.add(houseFloor);

  // Back & Left Walls (leaving front-right open as an architectural cutaway!)
  const backWall = new THREE.Mesh(new THREE.BoxGeometry(4.8, 2.5, 0.22), matCream);
  backWall.position.set(-0.3, 1.55, -2.04);
  backWall.castShadow = true;
  backWall.receiveShadow = true;
  house.add(backWall);

  const leftWall = new THREE.Mesh(new THREE.BoxGeometry(0.22, 2.5, 3.9), matCream);
  leftWall.position.set(-2.59, 1.55, -0.2);
  leftWall.castShadow = true;
  leftWall.receiveShadow = true;
  house.add(leftWall);

  // Half front accent pier
  const frontPier = new THREE.Mesh(new THREE.BoxGeometry(1.4, 2.5, 0.22), matCream);
  frontPier.position.set(-1.95, 1.55, 1.64);
  frontPier.castShadow = true;
  house.add(frontPier);

  // Glowing Front Window & Back Picture Window
  const frontWin = new THREE.Mesh(new THREE.BoxGeometry(0.75, 1.1, 0.26), matGlass);
  frontWin.position.set(-1.95, 1.55, 1.65);
  house.add(frontWin);

  const backWin = new THREE.Mesh(new THREE.BoxGeometry(1.6, 1.15, 0.26), matGlass);
  backWin.position.set(0.3, 1.65, -2.04);
  house.add(backWin);

  // Pitched Architectural Roof
  const roofL = new THREE.Mesh(new THREE.BoxGeometry(3.0, 0.2, 4.45), matRoof);
  roofL.position.set(-1.45, 3.25, -0.2);
  roofL.rotation.z = 0.42;
  roofL.castShadow = true;
  house.add(roofL);

  const roofR = new THREE.Mesh(new THREE.BoxGeometry(3.0, 0.2, 4.45), matRoof);
  roofR.position.set(0.92, 3.25, -0.2);
  roofR.rotation.z = -0.42;
  roofR.castShadow = true;
  house.add(roofR);

  const roofTrim = new THREE.Mesh(new THREE.BoxGeometry(0.24, 0.26, 4.5), matGold);
  roofTrim.position.set(-0.26, 3.84, -0.2);
  house.add(roofTrim);

  // Interior Furniture (Living Sofa + Kitchen Island + Rug)
  const rug = new THREE.Mesh(new THREE.BoxGeometry(1.75, 0.04, 1.45), matEmerald);
  rug.position.set(-1.1, 0.36, -0.35);
  house.add(rug);

  const sofaBase = new THREE.Mesh(new THREE.BoxGeometry(1.45, 0.36, 0.68), new THREE.MeshStandardMaterial({ color: 0x0f5143, roughness: 0.7 }));
  sofaBase.position.set(-1.1, 0.56, -1.25);
  sofaBase.castShadow = true;
  house.add(sofaBase);

  const sofaBack = new THREE.Mesh(new THREE.BoxGeometry(1.45, 0.45, 0.18), new THREE.MeshStandardMaterial({ color: 0x0f5143, roughness: 0.7 }));
  sofaBack.position.set(-1.1, 0.85, -1.52);
  house.add(sofaBack);

  const islandBase = new THREE.Mesh(new THREE.BoxGeometry(1.35, 0.72, 0.78), matDarkPine);
  islandBase.position.set(1.05, 0.7, -0.8);
  islandBase.castShadow = true;
  house.add(islandBase);

  const islandTop = new THREE.Mesh(new THREE.BoxGeometry(1.48, 0.1, 0.9), matCream);
  islandTop.position.set(1.05, 1.1, -0.8);
  house.add(islandTop);

  // Decorative Trees / Shrubs around lawn
  [[-4.4, -2.1], [-4.1, -3.4], [3.6, -2.5]].forEach(([tx, tz]) => {
    const trunk = new THREE.Mesh(new THREE.CylinderGeometry(0.1, 0.14, 0.65, 10), new THREE.MeshStandardMaterial({ color: 0x5a3e28 }));
    trunk.position.set(tx, 0.4, tz);
    const crown = new THREE.Mesh(new THREE.ConeGeometry(0.55, 1.35, 12), matEmerald);
    crown.position.set(tx, 1.25, tz);
    crown.castShadow = true;
    world.add(trunk, crown);
  });

  // ------------------------------------------------------------
  // WORKFLOW NODE 1: GOOGLE SEARCH & ADS BEACON (Left Front)
  // ------------------------------------------------------------
  const googleNode = new THREE.Group();
  googleNode.position.set(-3.8, 1.65, 1.8);
  world.add(googleNode);

  const gPillar = new THREE.Mesh(new THREE.CylinderGeometry(0.32, 0.42, 0.9, 24), matDarkPine);
  gPillar.position.y = -1.15;
  googleNode.add(gPillar);

  const gRing = new THREE.Mesh(new THREE.TorusGeometry(0.62, 0.11, 16, 48), matGoogleBlue);
  googleNode.add(gRing);

  const gInnerGold = new THREE.Mesh(new THREE.TorusGeometry(0.41, 0.06, 12, 36), matGold);
  googleNode.add(gInnerGold);

  const gOrbitDot1 = new THREE.Mesh(new THREE.SphereGeometry(0.14, 16, 16), matGoogleRed);
  gOrbitDot1.position.set(0.62, 0, 0);
  const gOrbitDot2 = new THREE.Mesh(new THREE.SphereGeometry(0.14, 16, 16), matGoogleGreen);
  gOrbitDot2.position.set(-0.62, 0, 0);
  gRing.add(gOrbitDot1, gOrbitDot2);

  // Magnifying handle
  const gHandle = new THREE.Mesh(new THREE.CylinderGeometry(0.08, 0.08, 0.68, 12), matGold);
  gHandle.position.set(0.58, -0.58, 0);
  gHandle.rotation.z = 0.78;
  googleNode.add(gHandle);

  // ------------------------------------------------------------
  // WORKFLOW NODE 2: AUTOMATED BOOKING CALENDAR PODIUM
  // ------------------------------------------------------------
  const calNode = new THREE.Group();
  calNode.position.set(-1.6, 1.25, 3.65);
  world.add(calNode);

  const calBoard = new THREE.Mesh(new THREE.BoxGeometry(1.35, 1.05, 0.14), matCream);
  calBoard.castShadow = true;
  calNode.add(calBoard);

  const calHeader = new THREE.Mesh(new THREE.BoxGeometry(1.35, 0.25, 0.16), matEmerald);
  calHeader.position.y = 0.42;
  calNode.add(calHeader);

  const calTiles = [];
  for (let r = 0; r < 2; r++) {
    for (let c = 0; c < 3; c++) {
      const tile = new THREE.Mesh(new THREE.BoxGeometry(0.28, 0.22, 0.08), matDarkPine.clone());
      tile.position.set((c - 1) * 0.36, 0.08 - r * 0.3, 0.08);
      calNode.add(tile);
      calTiles.push(tile);
    }
  }

  // ------------------------------------------------------------
  // WORKFLOW NODE 3: STRIPE / PAYPAL CHECKOUT SHIELD
  // ------------------------------------------------------------
  const payNode = new THREE.Group();
  payNode.position.set(3.45, 1.35, 1.9);
  world.add(payNode);

  const cardMesh = new THREE.Mesh(new THREE.BoxGeometry(1.25, 0.78, 0.1), matDarkPine);
  cardMesh.castShadow = true;
  payNode.add(cardMesh);

  const cardChip = new THREE.Mesh(new THREE.BoxGeometry(0.26, 0.2, 0.12), matGold);
  cardChip.position.set(-0.34, 0.1, 0.01);
  payNode.add(cardChip);

  const cardStripe = new THREE.Mesh(new THREE.BoxGeometry(1.25, 0.16, 0.11), matGold);
  cardStripe.position.set(0, -0.2, 0);
  payNode.add(cardStripe);

  const shieldHalo = new THREE.Mesh(new THREE.TorusGeometry(0.85, 0.04, 12, 48), matGold);
  payNode.add(shieldHalo);

  // ------------------------------------------------------------
  // WORKFLOW NODE 4: ANIMATED BOVIC PRO DISPATCH VAN
  // ------------------------------------------------------------
  const van = new THREE.Group();
  van.position.set(1.5, 0.16, 4.7);
  world.add(van);

  const vanBody = new THREE.Mesh(new THREE.BoxGeometry(0.95, 0.65, 1.65), matEmerald);
  vanBody.position.y = 0.45;
  vanBody.castShadow = true;
  van.add(vanBody);

  const vanCab = new THREE.Mesh(new THREE.BoxGeometry(0.9, 0.42, 0.55), matDarkPine);
  vanCab.position.set(0, 0.34, -0.95);
  vanCab.castShadow = true;
  van.add(vanCab);

  const vanStripe = new THREE.Mesh(new THREE.BoxGeometry(0.98, 0.12, 1.45), matGold);
  vanStripe.position.set(0, 0.42, 0);
  van.add(vanStripe);

  const vanBeacon = new THREE.Mesh(new THREE.SphereGeometry(0.11, 14, 14), matGold);
  vanBeacon.position.set(0, 0.85, -0.5);
  van.add(vanBeacon);

  const wheelGeo = new THREE.CylinderGeometry(0.18, 0.18, 0.12, 16);
  wheelGeo.rotateZ(Math.PI / 2);
  const matTire = new THREE.MeshStandardMaterial({ color: 0x111111, roughness: 0.8 });
  [[-0.48, 0.18, -0.8], [0.48, 0.18, -0.8], [-0.48, 0.18, 0.5], [0.48, 0.18, 0.5]].forEach(([wx, wy, wz]) => {
    const w = new THREE.Mesh(wheelGeo, matTire);
    w.position.set(wx, wy, wz);
    van.add(w);
  });

  // ------------------------------------------------------------
  // ANIMATED GLOWING "GOOGLE FLOW" CURVE & TRAVELING PULSES
  // ------------------------------------------------------------
  const flowCurve = new THREE.CatmullRomCurve3([
    new THREE.Vector3(-3.8, 1.4, 1.8),
    new THREE.Vector3(-1.6, 1.0, 3.65),
    new THREE.Vector3(1.5, 0.7, 3.1),
    new THREE.Vector3(3.45, 1.25, 1.9),
    new THREE.Vector3(1.1, 1.8, -0.4),
    new THREE.Vector3(-0.3, 2.2, -0.2),
  ]);
  const flowTubeGeo = new THREE.TubeGeometry(flowCurve, 80, 0.045, 8, false);
  const flowTubeMat = new THREE.MeshStandardMaterial({
    color: 0x10b981,
    emissive: 0x0a7158,
    roughness: 0.25,
    transparent: true,
    opacity: 0.75,
  });
  world.add(new THREE.Mesh(flowTubeGeo, flowTubeMat));

  const flowPulses = [];
  for (let i = 0; i < 6; i++) {
    const pulse = new THREE.Mesh(new THREE.SphereGeometry(0.11, 12, 12), matGold);
    world.add(pulse);
    flowPulses.push({ mesh: pulse, offset: i / 6 });
  }

  // ------------------------------------------------------------
  // WORKFLOW NODE 5: SPARKLE CLEAN TRANSFORMATION PARTICLES
  // ------------------------------------------------------------
  const sparkles = [];
  const sparkGeo = new THREE.OctahedronGeometry(0.09, 0);
  for (let i = 0; i < 36; i++) {
    const sp = new THREE.Mesh(sparkGeo, i % 3 === 0 ? matGold : matGlass);
    const angle = (i / 36) * Math.PI * 2;
    const rad = 1.2 + (i % 5) * 0.55;
    sp.userData = {
      baseX: Math.cos(angle) * rad,
      baseZ: Math.sin(angle) * rad,
      baseY: 0.7 + (i % 6) * 0.45,
      speed: 0.8 + (i % 4) * 0.35,
      phase: i * 0.65,
    };
    world.add(sp);
    sparkles.push(sp);
  }

  // Pointer & Touch 360° Interactive Orbit Controls
  let lastX = 0;
  let lastY = 0;
  const dom = renderer.domElement;

  dom.addEventListener('pointerdown', (e) => {
    camState.userDragging = true;
    camState.userOverrideTimer = 6.0;
    lastX = e.clientX;
    lastY = e.clientY;
    dom.style.cursor = 'grabbing';
    dom.setPointerCapture(e.pointerId);
  });

  dom.addEventListener('pointermove', (e) => {
    if (!camState.userDragging) return;
    const dx = e.clientX - lastX;
    const dy = e.clientY - lastY;
    lastX = e.clientX;
    lastY = e.clientY;
    camState.targetAz -= dx * 0.008;
    camState.targetPol = Math.max(0.45, Math.min(1.36, camState.targetPol - dy * 0.006));
    camState.userOverrideTimer = 6.0;
  });

  const endDrag = () => {
    camState.userDragging = false;
    dom.style.cursor = 'grab';
  };
  dom.addEventListener('pointerup', endDrag);
  dom.addEventListener('pointercancel', endDrag);

  dom.addEventListener('wheel', (e) => {
    if (!e.ctrlKey && Math.abs(e.deltaY) < 4) return;
    e.preventDefault();
    camState.targetDist = Math.max(9.5, Math.min(19, camState.targetDist + e.deltaY * 0.01));
    camState.userOverrideTimer = 4.0;
  }, { passive: false });

  // Main Animation Loop
  let prevTime = performance.now();
  function animate(now) {
    requestAnimationFrame(animate);
    const dt = Math.min(0.05, (now - prevTime) / 1000);
    prevTime = now;
    const t = now * 0.001;

    if (autoPlay && !camState.userDragging) {
      stageElapsed += dt;
      if (stageElapsed >= STAGE_DURATION) {
        stageElapsed = 0;
        setStage(activeIdx + 1);
      }
    }
    if (camState.userOverrideTimer > 0 && !camState.userDragging) {
      camState.userOverrideTimer = Math.max(0, camState.userOverrideTimer - dt);
    }

    // Subtle idle orbit drift when not dragged
    const drift = (!camState.userDragging && camState.userOverrideTimer <= 0) ? Math.sin(t * 0.35) * 0.18 : 0;

    // Damped spherical camera interpolation
    camState.azimuth += ((camState.targetAz + drift) - camState.azimuth) * Math.min(1, dt * 3.6);
    camState.polar += (camState.targetPol - camState.polar) * Math.min(1, dt * 3.6);
    camState.dist += (camState.targetDist - camState.dist) * Math.min(1, dt * 3.6);
    camState.lookAtX += (camState.targetLookX - camState.lookAtX) * Math.min(1, dt * 3.6);
    camState.lookAtY += (camState.targetLookY - camState.lookAtY) * Math.min(1, dt * 3.6);
    camState.lookAtZ += (camState.targetLookZ - camState.lookAtZ) * Math.min(1, dt * 3.6);

    const sinP = Math.sin(camState.polar);
    camera.position.set(
      camState.lookAtX + camState.dist * sinP * Math.sin(camState.azimuth),
      camState.lookAtY + camState.dist * Math.cos(camState.polar),
      camState.lookAtZ + camState.dist * sinP * Math.cos(camState.azimuth)
    );
    camera.lookAt(camState.lookAtX, camState.lookAtY, camState.lookAtZ);

    // Stage-reactive 3D animations
    gRing.rotation.y = t * 1.1;
    googleNode.position.y = 1.65 + Math.sin(t * 2.1) * 0.14;
    googleNode.scale.setScalar(activeIdx === 0 ? 1.18 + Math.sin(t * 4) * 0.05 : 1.0);

    // Calendar date tiles light up sequentially
    const highlightedTile = Math.floor(t * 2.2) % calTiles.length;
    calTiles.forEach((tile, i) => {
      const hit = i === highlightedTile;
      tile.material.color.setHex(hit ? 0xf1ab21 : (activeIdx === 1 ? 0x0a7158 : 0x0c342f));
      tile.position.z = hit ? 0.12 : 0.08;
    });
    calNode.position.y = 1.25 + Math.sin(t * 1.8 + 1) * 0.09;

    // Stripe/PayPal Checkout spin & glow
    payNode.rotation.y = t * 0.9;
    shieldHalo.rotation.x = t * 1.4;
    payNode.scale.setScalar(activeIdx === 2 ? 1.18 : 1.0);

    // Cleaning Van drives onto the driveway during Stage 3 & 4 (Dispatch & Clean)
    const targetVanZ = (activeIdx === 3 || activeIdx === 4) ? 2.45 : 4.75;
    van.position.z += (targetVanZ - van.position.z) * Math.min(1, dt * 2.6);
    vanBeacon.material.emissiveIntensity = activeIdx === 3 ? 0.8 + Math.sin(t * 7) * 0.4 : 0.25;

    // Pulses streaming continuously along the Google Flow curve
    flowPulses.forEach(p => {
      const prog = (t * 0.22 + p.offset) % 1;
      const pos = flowCurve.getPointAt(prog);
      p.mesh.position.copy(pos);
      const s = 0.8 + Math.sin(t * 6 + p.offset * 10) * 0.25;
      p.mesh.scale.setScalar(s);
    });

    // Stage 5 Clean Transformation Sparkles & Warm Glow
    const cleanBoost = activeIdx === 4 ? 1.35 : 0.65;
    warmHouseLight.intensity = 1.0 + (activeIdx === 4 ? 1.4 + Math.sin(t * 3) * 0.25 : 0.2);
    sparkles.forEach(sp => {
      const d = sp.userData;
      sp.position.set(
        d.baseX * (activeIdx === 4 ? 0.88 : 1.05),
        d.baseY + Math.sin(t * d.speed + d.phase) * 0.35,
        d.baseZ * (activeIdx === 4 ? 0.88 : 1.05)
      );
      sp.rotation.y += dt * 1.8;
      sp.rotation.x += dt * 1.1;
      sp.scale.setScalar(cleanBoost * (0.65 + Math.abs(Math.sin(t * 2 + d.phase)) * 0.6));
    });

    renderer.render(scene, camera);
  }
  requestAnimationFrame(animate);
})();
