import * as THREE from "three";

// ============================================================
// Arena Strike — 3D First-Person Arena FPS
// Controls: Arrow keys move/turn, Space shoots, R reloads, A/D strafe
// ============================================================

// ---- Tunable constants ----
const ARENA = 44;            // half-size of the square arena floor
const WALL_H = 8;
const PLAYER_SPEED = 9;      // units/sec
const TURN_SPEED = 2.4;      // radians/sec
const PLAYER_RADIUS = 1.1;
const ENEMY_RADIUS = 1.2;
const PLAYER_EYE = 2.2;
const BULLET_SPEED = 70;
const BULLET_LIFE = 1.5;     // seconds
const MAG_SIZE = 12;
const RELOAD_TIME = 1.4;     // seconds
const PLAYER_FIRE_COOLDOWN = 0.18;
const PLAYER_DMG = 12;
const ENEMY_DMG = 9;
const ENEMY_FIRE_COOLDOWN = 1.1;
const ENEMY_BULLET_SPEED = 45;
const ENEMY_SPEED = 6.2;
const MAX_HP = 100;

// ---- DOM refs ----
const canvas = document.getElementById("game-canvas");
const hud = document.getElementById("hud");
const overlay = document.getElementById("overlay");
const endOverlay = document.getElementById("end-overlay");
const startBtn = document.getElementById("start-btn");
const restartBtn = document.getElementById("restart-btn");
const playerHealthBar = document.getElementById("player-health");
const enemyHealthBar = document.getElementById("enemy-health");
const scoreEl = document.getElementById("score");
const ammoCountEl = document.getElementById("ammo-count");
const reloadHint = document.getElementById("reload-hint");
const hitFlash = document.getElementById("hit-flash");
const damageFlash = document.getElementById("damage-flash");
const resultTitle = document.getElementById("result-title");
const resultText = document.getElementById("result-text");

// ---- Renderer / scene / camera ----
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x0b0e1a);
scene.fog = new THREE.Fog(0x0b0e1a, 40, 90);

const camera = new THREE.PerspectiveCamera(72, 1, 0.1, 400);

function resize() {
  const w = window.innerWidth, h = window.innerHeight;
  renderer.setSize(w, h);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
}
window.addEventListener("resize", resize);
resize();

// ---- Lighting ----
const hemi = new THREE.HemisphereLight(0x8899ff, 0x222233, 0.7);
scene.add(hemi);

const dir = new THREE.DirectionalLight(0xffffff, 1.1);
dir.position.set(30, 50, 20);
dir.castShadow = true;
dir.shadow.mapSize.set(2048, 2048);
dir.shadow.camera.left = -ARENA;
dir.shadow.camera.right = ARENA;
dir.shadow.camera.top = ARENA;
dir.shadow.camera.bottom = -ARENA;
dir.shadow.camera.near = 1;
dir.shadow.camera.far = 120;
scene.add(dir);

// ---- Arena geometry ----
const obstacles = []; // { mesh, box:THREE.Box3, min/max for circle checks }

function buildArena() {
  // Floor
  const floorGeo = new THREE.PlaneGeometry(ARENA * 2, ARENA * 2, 1, 1);
  const floorMat = new THREE.MeshStandardMaterial({ color: 0x2a2d3a, roughness: 0.95, metalness: 0.05 });
  const floor = new THREE.Mesh(floorGeo, floorMat);
  floor.rotation.x = -Math.PI / 2;
  floor.receiveShadow = true;
  scene.add(floor);

  // Grid overlay
  const grid = new THREE.GridHelper(ARENA * 2, 44, 0x3f4666, 0x2f3350);
  grid.position.y = 0.02;
  scene.add(grid);

  // Boundary walls
  const wallMat = new THREE.MeshStandardMaterial({ color: 0x3a4060, roughness: 0.8, metalness: 0.1 });
  const wallDefs = [
    [0, -ARENA, ARENA * 2, 1],   // z-
    [0, ARENA, ARENA * 2, 1],    // z+
    [-ARENA, 0, 1, ARENA * 2],   // x-
    [ARENA, 0, 1, ARENA * 2],    // x+
  ];
  for (const [x, z, sx, sz] of wallDefs) {
    const geo = new THREE.BoxGeometry(sx, WALL_H, sz);
    const m = new THREE.Mesh(geo, wallMat);
    m.position.set(x, WALL_H / 2, z);
    m.castShadow = true;
    m.receiveShadow = true;
    scene.add(m);
    registerObstacle(m, sx, sz);
  }

  // Cover crates / pillars scattered for tactical play
  const coverMat = new THREE.MeshStandardMaterial({ color: 0x55608a, roughness: 0.7, metalness: 0.2 });
  const covers = [
    [-14, -10, 5, 5, 4],
    [12, 8, 6, 4, 5],
    [0, 0, 7, 7, 3],
    [-18, 16, 4, 8, 5],
    [16, -16, 8, 4, 4],
    [-6, 20, 5, 5, 6],
    [22, 18, 5, 5, 4],
    [-24, -20, 6, 6, 5],
  ];
  for (const [x, z, sx, sz, h] of covers) {
    const geo = new THREE.BoxGeometry(sx, h, sz);
    const m = new THREE.Mesh(geo, coverMat);
    m.position.set(x, h / 2, z);
    m.castShadow = true;
    m.receiveShadow = true;
    scene.add(m);
    registerObstacle(m, sx, sz);
  }
}

function registerObstacle(mesh, sx, sz) {
  obstacles.push({
    mesh,
    cx: mesh.position.x,
    cz: mesh.position.z,
    hx: sx / 2,
    hz: sz / 2,
  });
}
buildArena();

// ---- Collision helpers ----
// Resolve a circle (radius r) at position p against all AABB obstacles.
// Mutates p (THREE.Vector3, uses x/z). Returns resolved position.
function resolveCollisions(p, r) {
  for (const o of obstacles) {
    const minX = o.cx - o.hx - r;
    const maxX = o.cx + o.hx + r;
    const minZ = o.cz - o.hz - r;
    const maxZ = o.cz + o.hz + r;
    if (p.x > minX && p.x < maxX && p.z > minZ && p.z < maxZ) {
      // Push out along the axis of least penetration
      const penRight = maxX - p.x;
      const penLeft = p.x - minX;
      const penTop = maxZ - p.z;
      const penBottom = p.z - minZ;
      const minPen = Math.min(penRight, penLeft, penTop, penBottom);
      if (minPen === penRight) p.x = maxX;
      else if (minPen === penLeft) p.x = minX;
      else if (minPen === penTop) p.z = maxZ;
      else p.z = minZ;
    }
  }
  // Keep inside arena bounds
  const lim = ARENA - 1 - r;
  p.x = Math.max(-lim, Math.min(lim, p.x));
  p.z = Math.max(-lim, Math.min(lim, p.z));
  return p;
}

// Ray/segment vs obstacle AABB test for line-of-sight and bullet blocking.
// Returns t in [0,1] of first hit along segment a->b, or null.
function segmentHitsObstacles(ax, az, bx, bz, pad = 0) {
  let best = null;
  const dx = bx - ax, dz = bz - az;
  for (const o of obstacles) {
    const minX = o.cx - o.hx - pad, maxX = o.cx + o.hx + pad;
    const minZ = o.cz - o.hz - pad, maxZ = o.cz + o.hz + pad;
    let tmin = 0, tmax = 1;
    // X slab
    if (Math.abs(dx) < 1e-8) {
      if (ax < minX || ax > maxX) continue;
    } else {
      let t1 = (minX - ax) / dx, t2 = (maxX - ax) / dx;
      if (t1 > t2) [t1, t2] = [t2, t1];
      tmin = Math.max(tmin, t1); tmax = Math.min(tmax, t2);
      if (tmin > tmax) continue;
    }
    // Z slab
    if (Math.abs(dz) < 1e-8) {
      if (az < minZ || az > maxZ) continue;
    } else {
      let t1 = (minZ - az) / dz, t2 = (maxZ - az) / dz;
      if (t1 > t2) [t1, t2] = [t2, t1];
      tmin = Math.max(tmin, t1); tmax = Math.min(tmax, t2);
      if (tmin > tmax) continue;
    }
    if (tmax >= tmin && tmin >= 0 && tmin <= 1) {
      if (best === null || tmin < best) best = tmin;
    }
  }
  return best;
}

function hasLineOfSight(ax, az, bx, bz) {
  return segmentHitsObstacles(ax, az, bx, bz, 0.2) === null;
}

// ---- Enemy model ----
const enemyGroup = new THREE.Group();
function buildEnemy() {
  const bodyMat = new THREE.MeshStandardMaterial({ color: 0xe03838, roughness: 0.5, metalness: 0.3, emissive: 0x330808 });
  const headMat = new THREE.MeshStandardMaterial({ color: 0xff6a5a, roughness: 0.4, metalness: 0.3 });

  const torso = new THREE.Mesh(new THREE.CapsuleGeometry(0.9, 1.6, 6, 14), bodyMat);
  torso.position.y = 2.0;
  torso.castShadow = true;
  enemyGroup.add(torso);

  const head = new THREE.Mesh(new THREE.SphereGeometry(0.55, 18, 14), headMat);
  head.position.y = 3.5;
  head.castShadow = true;
  enemyGroup.add(head);

  // "eye" to indicate facing direction
  const eye = new THREE.Mesh(
    new THREE.BoxGeometry(0.5, 0.18, 0.1),
    new THREE.MeshStandardMaterial({ color: 0xffff66, emissive: 0xaa8800, emissiveIntensity: 1 })
  );
  eye.position.set(0, 3.55, 0.52);
  enemyGroup.add(eye);

  // gun barrel pointing forward (+z local)
  const gun = new THREE.Mesh(
    new THREE.BoxGeometry(0.22, 0.22, 1.4),
    new THREE.MeshStandardMaterial({ color: 0x222222, metalness: 0.6, roughness: 0.4 })
  );
  gun.position.set(0.55, 2.1, 0.7);
  enemyGroup.add(gun);

  scene.add(enemyGroup);
}
buildEnemy();

// ---- Bullets ----
const bulletGeo = new THREE.SphereGeometry(0.14, 8, 6);
const playerBulletMat = new THREE.MeshStandardMaterial({ color: 0x66ffcc, emissive: 0x33ffaa, emissiveIntensity: 1.4 });
const enemyBulletMat = new THREE.MeshStandardMaterial({ color: 0xffaa33, emissive: 0xff7700, emissiveIntensity: 1.4 });
const bullets = []; // { mesh, vx, vz, x, z, y, life, fromPlayer }

function spawnBullet(x, y, z, dx, dz, speed, fromPlayer) {
  const mesh = new THREE.Mesh(bulletGeo, fromPlayer ? playerBulletMat : enemyBulletMat);
  mesh.position.set(x, y, z);
  scene.add(mesh);
  const len = Math.hypot(dx, dz) || 1;
  bullets.push({
    mesh,
    x, y, z,
    vx: (dx / len) * speed,
    vz: (dz / len) * speed,
    life: BULLET_LIFE,
    fromPlayer,
  });
}

// Muzzle flash light (shared, repositioned on fire)
const muzzleLight = new THREE.PointLight(0xffffaa, 0, 10);
scene.add(muzzleLight);
let muzzleTimer = 0;

// ---- Game state ----
const state = {
  running: false,
  player: { x: 0, z: 0, yaw: 0, hp: MAX_HP, ammo: MAG_SIZE, reloading: false, reloadT: 0, fireT: 0 },
  enemy: { x: 0, z: 0, yaw: 0, hp: MAX_HP, fireT: 0, strafeDir: 1, strafeT: 0, targetX: 0, targetZ: 0, repathT: 0 },
  score: 0,
};

// Use e.code (physical key, layout-independent) so Space/arrows are reliable
// across browsers and keyboard layouts.
const keys = Object.create(null);
const PREVENT = new Set([
  "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Space",
]);

function codeToKey(code) {
  switch (code) {
    case "ArrowUp": return "arrowup";
    case "ArrowDown": return "arrowdown";
    case "ArrowLeft": return "arrowleft";
    case "ArrowRight": return "arrowright";
    case "Space": return "space";
    case "KeyA": return "a";
    case "KeyD": return "d";
    case "KeyR": return "r";
    default: return null;
  }
}

window.addEventListener("keydown", (e) => {
  if (PREVENT.has(e.code)) e.preventDefault();
  const k = codeToKey(e.code);
  if (!k) return;
  const wasDown = keys[k];
  keys[k] = true;
  // Fire a shot immediately on the initial Space press so a quick tap
  // always registers, independent of frame timing.
  if (k === "space" && !wasDown && state.running) playerShoot();
});
window.addEventListener("keyup", (e) => {
  const k = codeToKey(e.code);
  if (k) keys[k] = false;
});

function randomSpawn(awayFromX, awayFromZ, minDist) {
  for (let i = 0; i < 60; i++) {
    const x = (Math.random() * 2 - 1) * (ARENA - 5);
    const z = (Math.random() * 2 - 1) * (ARENA - 5);
    const p = new THREE.Vector3(x, 0, z);
    resolveCollisions(p, ENEMY_RADIUS + 0.5);
    let blocked = false;
    for (const o of obstacles) {
      if (Math.abs(p.x - o.cx) < o.hx + 1.5 && Math.abs(p.z - o.cz) < o.hz + 1.5) { blocked = true; break; }
    }
    if (!blocked && Math.hypot(p.x - awayFromX, p.z - awayFromZ) > minDist) return { x: p.x, z: p.z };
  }
  return { x: awayFromX > 0 ? -20 : 20, z: awayFromZ > 0 ? -20 : 20 };
}

function resetGame() {
  state.player.x = -ARENA + 12;
  state.player.z = -ARENA + 12;
  state.player.yaw = Math.PI * 0.75;
  state.player.hp = MAX_HP;
  state.player.ammo = MAG_SIZE;
  state.player.reloading = false;
  state.player.reloadT = 0;
  state.player.fireT = 0;

  const es = randomSpawn(state.player.x, state.player.z, 30);
  state.enemy.x = es.x;
  state.enemy.z = es.z;
  state.enemy.hp = MAX_HP;
  state.enemy.fireT = 0;
  state.enemy.strafeDir = Math.random() < 0.5 ? 1 : -1;
  state.enemy.strafeT = 0;
  state.enemy.repathT = 0;
  state.enemy.targetX = state.player.x;
  state.enemy.targetZ = state.player.z;

  state.score = 0;

  // remove any leftover bullets
  for (const b of bullets) scene.remove(b.mesh);
  bullets.length = 0;

  updateHUD();
}

// ---- HUD ----
function updateHUD() {
  playerHealthBar.style.width = Math.max(0, state.player.hp) / MAX_HP * 100 + "%";
  enemyHealthBar.style.width = Math.max(0, state.enemy.hp) / MAX_HP * 100 + "%";
  scoreEl.textContent = state.score;
  ammoCountEl.textContent = state.player.reloading ? "--" : state.player.ammo;
  reloadHint.classList.toggle("hidden", !state.player.reloading);
}

function flashHit() {
  hitFlash.classList.remove("show");
  void hitFlash.offsetWidth;
  hitFlash.classList.add("show");
}
function flashDamage() {
  damageFlash.classList.remove("show");
  void damageFlash.offsetWidth;
  damageFlash.classList.add("show");
}

// ---- Player logic ----
function startReload() {
  if (state.player.reloading || state.player.ammo === MAG_SIZE) return;
  state.player.reloading = true;
  state.player.reloadT = RELOAD_TIME;
  updateHUD();
}

function playerShoot() {
  const p = state.player;
  if (p.reloading || p.fireT > 0) return;
  if (p.ammo <= 0) { startReload(); return; }
  p.ammo--;
  p.fireT = PLAYER_FIRE_COOLDOWN;

  // Forward = camera's look direction (-Z rotated by yaw)
  const dx = -Math.sin(p.yaw);
  const dz = -Math.cos(p.yaw);
  const sx = p.x + dx * 1.2;
  const sz = p.z + dz * 1.2;
  spawnBullet(sx, PLAYER_EYE - 0.2, sz, dx, dz, BULLET_SPEED, true);

  muzzleLight.position.set(sx, PLAYER_EYE, sz);
  muzzleLight.intensity = 3;
  muzzleTimer = 0.06;

  if (p.ammo <= 0) startReload();
  updateHUD();
}

function updatePlayer(dt) {
  const p = state.player;

  // Turning
  if (keys["arrowleft"]) p.yaw += TURN_SPEED * dt;
  if (keys["arrowright"]) p.yaw -= TURN_SPEED * dt;

  // Camera (rotation yaw about Y) looks down its local -Z, so world forward is:
  const fx = -Math.sin(p.yaw), fz = -Math.cos(p.yaw);
  // Right vector (90° clockwise from forward on the XZ plane)
  const rx = -Math.cos(p.yaw), rz = Math.sin(p.yaw);

  let mx = 0, mz = 0;
  if (keys["arrowup"]) { mx += fx; mz += fz; }
  if (keys["arrowdown"]) { mx -= fx; mz -= fz; }
  if (keys["d"]) { mx += rx; mz += rz; }
  if (keys["a"]) { mx -= rx; mz -= rz; }

  const len = Math.hypot(mx, mz);
  if (len > 0) {
    mx /= len; mz /= len;
    p.x += mx * PLAYER_SPEED * dt;
    p.z += mz * PLAYER_SPEED * dt;
    const resolved = resolveCollisions(new THREE.Vector3(p.x, 0, p.z), PLAYER_RADIUS);
    p.x = resolved.x; p.z = resolved.z;
  }

  // Shooting
  if (keys["space"]) playerShoot();
  if (keys["r"]) startReload();

  // Timers
  if (p.fireT > 0) p.fireT -= dt;
  if (p.reloading) {
    p.reloadT -= dt;
    if (p.reloadT <= 0) {
      p.reloading = false;
      p.ammo = MAG_SIZE;
      updateHUD();
    }
  }

  // Camera follows player head
  camera.position.set(p.x, PLAYER_EYE, p.z);
  camera.rotation.set(0, p.yaw, 0, "YXZ");
  // Slight downward look so the arena floor is visible
  camera.rotation.x = -0.06;
}

// ---- Enemy AI ----
// Behavior: if it has line of sight, face the player, strafe, and shoot.
// If not, move toward the player's last known position to regain sight.
function updateEnemy(dt) {
  const e = state.enemy;
  const p = state.player;

  const toPX = p.x - e.x;
  const toPZ = p.z - e.z;
  const dist = Math.hypot(toPX, toPZ) || 0.0001;
  const los = hasLineOfSight(e.x, e.z, p.x, p.z);

  // Desired facing toward player
  const desiredYaw = Math.atan2(toPX, toPZ);
  // Smoothly rotate yaw toward desired
  let dyaw = desiredYaw - e.yaw;
  while (dyaw > Math.PI) dyaw -= Math.PI * 2;
  while (dyaw < -Math.PI) dyaw += Math.PI * 2;
  e.yaw += Math.max(-3.2 * dt, Math.min(3.2 * dt, dyaw));

  let mx = 0, mz = 0;

  if (los) {
    // Keep a preferred fighting distance; strafe sideways
    const idealDist = 18;
    const dirX = toPX / dist, dirZ = toPZ / dist;

    if (dist > idealDist + 3) { mx += dirX; mz += dirZ; }       // close in
    else if (dist < idealDist - 3) { mx -= dirX; mz -= dirZ; }  // back off

    // Strafe perpendicular
    e.strafeT -= dt;
    if (e.strafeT <= 0) { e.strafeDir *= -1; e.strafeT = 1.2 + Math.random() * 1.5; }
    const perpX = -dirZ * e.strafeDir;
    const perpZ = dirX * e.strafeDir;
    mx += perpX * 0.9; mz += perpZ * 0.9;

    // Shoot when roughly facing the player
    e.fireT -= dt;
    if (Math.abs(dyaw) < 0.25 && e.fireT <= 0) {
      e.fireT = ENEMY_FIRE_COOLDOWN * (0.8 + Math.random() * 0.5);
      // Lead/aim slightly imperfectly for fairness
      const aimErr = (Math.random() - 0.5) * 0.08;
      const aimX = dirX * Math.cos(aimErr) - dirZ * Math.sin(aimErr);
      const aimZ = dirX * Math.sin(aimErr) + dirZ * Math.cos(aimErr);
      const sx = e.x + aimX * 1.4;
      const sz = e.z + aimZ * 1.4;
      spawnBullet(sx, 2.3, sz, aimX, aimZ, ENEMY_BULLET_SPEED, false);
      muzzleLight.position.set(sx, 2.3, sz);
      muzzleLight.intensity = 3;
      muzzleTimer = 0.06;
    }
    e.targetX = p.x; e.targetZ = p.z;
  } else {
    // No sight: navigate toward last known player position
    e.repathT -= dt;
    if (e.repathT <= 0) { e.targetX = p.x; e.targetZ = p.z; e.repathT = 0.5; }
    const tx = e.targetX - e.x, tz = e.targetZ - e.z;
    const tl = Math.hypot(tx, tz) || 1;
    mx += tx / tl; mz += tz / tl;
    // Add a gentle sidestep to avoid getting stuck on cover corners
    mx += -tz / tl * 0.35 * e.strafeDir;
    mz += tx / tl * 0.35 * e.strafeDir;
    e.strafeT -= dt;
    if (e.strafeT <= 0) { e.strafeDir *= -1; e.strafeT = 0.8 + Math.random(); }
  }

  const ml = Math.hypot(mx, mz);
  if (ml > 0) {
    mx /= ml; mz /= ml;
    e.x += mx * ENEMY_SPEED * dt;
    e.z += mz * ENEMY_SPEED * dt;
    const resolved = resolveCollisions(new THREE.Vector3(e.x, 0, e.z), ENEMY_RADIUS);
    e.x = resolved.x; e.z = resolved.z;
  }

  enemyGroup.position.set(e.x, 0, e.z);
  enemyGroup.rotation.y = e.yaw;
}

// ---- Bullet updates & hit detection ----
function updateBullets(dt) {
  const p = state.player;
  const e = state.enemy;

  for (let i = bullets.length - 1; i >= 0; i--) {
    const b = bullets[i];
    const nx = b.x + b.vx * dt;
    const nz = b.z + b.vz * dt;

    // Obstacle / wall block along this step
    const tHit = segmentHitsObstacles(b.x, b.z, nx, nz, 0);
    let consumed = false;

    if (tHit !== null) {
      consumed = true;
    } else {
      // Target hit checks (circle vs segment endpoint proximity)
      if (b.fromPlayer) {
        if (circleSegmentHit(b.x, b.z, nx, nz, e.x, e.z, ENEMY_RADIUS)) {
          e.hp -= PLAYER_DMG;
          state.score += 10;
          flashHit();
          consumed = true;
          if (e.hp <= 0) { endGame(true); return; }
          updateHUD();
        }
      } else {
        if (circleSegmentHit(b.x, b.z, nx, nz, p.x, p.z, PLAYER_RADIUS)) {
          p.hp -= ENEMY_DMG;
          flashDamage();
          consumed = true;
          if (p.hp <= 0) { endGame(false); return; }
          updateHUD();
        }
      }
    }

    b.x = nx; b.z = nz;
    b.mesh.position.set(b.x, b.y, b.z);
    b.life -= dt;

    if (consumed || b.life <= 0) {
      scene.remove(b.mesh);
      bullets.splice(i, 1);
    }
  }
}

// Does segment a->b pass within r of point c? (2D, x/z plane)
function circleSegmentHit(ax, az, bx, bz, cx, cz, r) {
  const dx = bx - ax, dz = bz - az;
  const lenSq = dx * dx + dz * dz;
  let t = lenSq > 0 ? ((cx - ax) * dx + (cz - az) * dz) / lenSq : 0;
  t = Math.max(0, Math.min(1, t));
  const px = ax + dx * t, pz = az + dz * t;
  const distSq = (px - cx) ** 2 + (pz - cz) ** 2;
  return distSq <= r * r;
}

// ---- Game loop ----
let lastT = performance.now();
function loop(now) {
  requestAnimationFrame(loop);
  let dt = (now - lastT) / 1000;
  lastT = now;
  if (dt > 0.05) dt = 0.05; // clamp big frame gaps

  if (state.running) {
    updatePlayer(dt);
    updateEnemy(dt);
    updateBullets(dt);
  }

  // Muzzle flash decay
  if (muzzleTimer > 0) {
    muzzleTimer -= dt;
    if (muzzleTimer <= 0) muzzleLight.intensity = 0;
  }

  renderer.render(scene, camera);
}
requestAnimationFrame(loop);

// ---- Start / end flow ----
function startGame() {
  resetGame();
  state.running = true;
  overlay.classList.add("hidden");
  endOverlay.classList.add("hidden");
  hud.classList.remove("hidden");
  lastT = performance.now();
}

function endGame(won) {
  state.running = false;
  hud.classList.add("hidden");
  endOverlay.classList.remove("hidden");
  if (won) {
    resultTitle.textContent = "VICTORY";
    resultTitle.classList.remove("defeat");
    resultText.textContent = `You eliminated the enemy. Final score: ${state.score}`;
  } else {
    resultTitle.textContent = "DEFEATED";
    resultTitle.classList.add("defeat");
    resultText.textContent = `The enemy got you. Final score: ${state.score}`;
  }
}

startBtn.addEventListener("click", startGame);
restartBtn.addEventListener("click", startGame);

// Position camera at the menu for a nice backdrop
camera.position.set(0, 14, 40);
camera.lookAt(0, 2, 0);
