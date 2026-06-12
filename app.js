// ══════════════════════════════════════════════
//  AL CINE CON PAPÁ — Cliente API (v2)
//  Conecta al servidor Express + WebSocket
//  Todos los dispositivos comparten la misma DB
// ══════════════════════════════════════════════

const AUTH_KEY = 'alcinepapa_admin_token';
const ADMIN_KEY = 'alcinepapa_admin_data';

// ── Auth ──────────────────────────────────────
function getAdminToken() {
  return sessionStorage.getItem(AUTH_KEY);
}

function isLoggedIn() {
  return !!sessionStorage.getItem(AUTH_KEY);
}

function getCurrentAdmin() {
  const raw = sessionStorage.getItem(ADMIN_KEY);
  try { return raw ? JSON.parse(raw) : null; } catch { return null; }
}

function hasPermiso(permiso) {
  const a = getCurrentAdmin();
  if (!a) return false;
  if (a.rol === 'superadmin') return true;
  return a.permisos?.[permiso] === true;
}

function getSalaAdmin() {
  const a = getCurrentAdmin();
  if (!a) return null;
  if (a.rol === 'superadmin') return null; // null = ve todo
  return a.sala || null;
}

async function loginAdmin(username, password) {
  try {
    const r = await fetch(`${API_BASE}/api/admin/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Bypass-Tunnel-Reminder': 'true' },
      body: JSON.stringify({ username, password })
    });
    const data = await r.json();
    if (data.ok) {
      sessionStorage.setItem(AUTH_KEY, data.token);
      sessionStorage.setItem(ADMIN_KEY, JSON.stringify(data.admin));
      return { ok: true, admin: data.admin };
    }
    return { ok: false, error: data.error || 'Credenciales incorrectas' };
  } catch {
    return { ok: false, error: 'Error de conexión' };
  }
}

// Keep old login for backward compat (scanner, etc.)
async function login(pass) {
  try {
    const r = await fetch(`${API_BASE}/api/auth`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Bypass-Tunnel-Reminder': 'true' },
      body: JSON.stringify({ password: pass })
    });
    const data = await r.json();
    if (data.ok) { sessionStorage.setItem(AUTH_KEY, 'legacy'); return true; }
    return false;
  } catch { return false; }
}

async function logoutAdmin() {
  const token = getAdminToken();
  if (token && token !== 'legacy') {
    try {
      await fetch(`${API_BASE}/api/admin/logout`, {
        method: 'POST',
        headers: { 'Bypass-Tunnel-Reminder': 'true', 'X-Admin-Token': token }
      });
    } catch {}
  }
  sessionStorage.removeItem(AUTH_KEY);
  sessionStorage.removeItem(ADMIN_KEY);
}

function logout() {
  sessionStorage.removeItem(AUTH_KEY);
  sessionStorage.removeItem(ADMIN_KEY);
}

// ── Admin API helpers ─────────────────────────
function adminHeaders() {
  const token = getAdminToken();
  return {
    'Content-Type': 'application/json',
    'Bypass-Tunnel-Reminder': 'true',
    ...(token && token !== 'legacy' ? { 'X-Admin-Token': token } : {})
  };
}

async function fetchAdmins() {
  const r = await fetch(`${API_BASE}/api/admins`, {
    headers: adminHeaders()
  });
  return r.json();
}

async function crearAdmin(data) {
  const r = await fetch(`${API_BASE}/api/admins`, {
    method: 'POST',
    headers: adminHeaders(),
    body: JSON.stringify(data)
  });
  return r.json();
}

async function editarAdmin(id, data) {
  const r = await fetch(`${API_BASE}/api/admins/${id}`, {
    method: 'PUT',
    headers: adminHeaders(),
    body: JSON.stringify(data)
  });
  return r.json();
}

async function eliminarAdmin(id) {
  const r = await fetch(`${API_BASE}/api/admins/${id}`, {
    method: 'DELETE',
    headers: { 'Bypass-Tunnel-Reminder': 'true', 'X-Admin-Token': getAdminToken() }
  });
  return r.json();
}



// ── API Base URL ───────────────────────────────
const API_BASE = window.location.origin;

// ── Estado local (caché) ──────────────────────
let _stateCache = null;
let _wsConnected = false;
let _ws = null;

// ── WebSocket ─────────────────────────────────
function connectWS() {
  const wsUrl = API_BASE.replace(/^http/, 'ws');
  try {
    _ws = new WebSocket(wsUrl);

    _ws.onopen = () => {
      _wsConnected = true;
      updateConnectionIndicator(true);
      console.log('🟢 WebSocket conectado');
    };

    _ws.onmessage = (evt) => {
      try {
        const { event, data } = JSON.parse(evt.data);
        if (event === 'init' || event === 'update') {
          if (data && data.boletos !== undefined) {
            // Full state update (init or reset)
            _stateCache = data;
          } else if (data && data.type === 'boleto_created') {
            // Partial update: add new boletos
            if (_stateCache) {
              data.boletos.forEach(b => { _stateCache.boletos[b.id] = b; });
            }
          } else if (data && data.type === 'scan') {
            // Partial update: mark boleto as scanned
            if (_stateCache && data.scan) {
              const s = data.scan;
              if (_stateCache.boletos[s.boletoId]) {
                _stateCache.boletos[s.boletoId].escaneado = true;
                _stateCache.boletos[s.boletoId].escaneadoAt = s.at;
                _stateCache.boletos[s.boletoId].escaneadoEn = s.sala;
              }
              if (!_stateCache.scans) _stateCache.scans = [];
              _stateCache.scans.push(s);
            }
          } else if (data && data.type === 'config') {
            if (_stateCache) _stateCache.config = data.config;
          } else if (data && data.type === 'reset') {
            if (_stateCache) { _stateCache.boletos = {}; _stateCache.scans = []; }
          }
          // Notify page to re-render
          if (typeof onRemoteUpdate === 'function') onRemoteUpdate(event, data);
        }
      } catch (e) {}
    };

    _ws.onclose = () => {
      _wsConnected = false;
      updateConnectionIndicator(false);
      console.log('🔴 WebSocket desconectado — reconectando en 3s...');
      setTimeout(connectWS, 3000);
    };

    _ws.onerror = () => {
      _wsConnected = false;
      updateConnectionIndicator(false);
    };
  } catch (e) {
    console.warn('WebSocket no disponible:', e.message);
  }
}

function updateConnectionIndicator(connected) {
  const el = document.getElementById('conn-indicator');
  if (!el) return;
  el.className = connected ? 'conn-dot connected' : 'conn-dot disconnected';
  el.title = connected ? 'Conectado al servidor' : 'Sin conexión con el servidor';
}

// ── State API ─────────────────────────────────
async function fetchState() {
  try {
    const r = await fetch(`${API_BASE}/api/state`, {
      headers: { 'Bypass-Tunnel-Reminder': 'true' }
    });
    _stateCache = await r.json();
    return _stateCache;
  } catch (e) {
    console.error('Error fetching state:', e);
    if (_stateCache) return _stateCache;
    // Fallback vacío
    return { config: { precioGeneral: 12000, moneda: 'COP', salas: [], peliculas: [] }, boletos: {}, scans: [] };
  }
}

// Sincrónico si hay caché, async si no
function getState() {
  if (_stateCache) return _stateCache;
  // Si no hay caché, retorna vacío temporalmente y dispara fetch
  fetchState().then(() => {
    if (typeof onRemoteUpdate === 'function') onRemoteUpdate('init', _stateCache);
  });
  return { config: { precioGeneral: 12000, moneda: 'COP', salas: [], peliculas: [] }, boletos: {}, scans: [] };
}


// ── Boleto generation ─────────────────────────
// Returns Promise<{ok, boletos, compraId}>
async function crearReserva(estudiante, grado, salaId, peliculaId, asientos, estado = 'pagado') {
  try {
    const r = await fetch(`${API_BASE}/api/boletos`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Bypass-Tunnel-Reminder': 'true', 'X-Admin-Token': localStorage.getItem('adminToken') || '' },
      body: JSON.stringify({ estudiante, grado, salaId, peliculaId, asientos, estado })
    });
    const data = await r.json();
    if (data.ok && data.boletos && _stateCache) {
      data.boletos.forEach(b => { _stateCache.boletos[b.id] = b; });
    }
    return data;
  } catch (e) {
    console.error('Error creando reserva:', e);
    return { ok: false, error: e.message };
  }
}

async function liberarBoleto(id) {
  try {
    const r = await fetch(`${API_BASE}/api/boletos/${id}`, {
      method: 'DELETE',
      headers: adminHeaders()
    });
    const data = await r.json();
    if (data.ok && _stateCache) {
      delete _stateCache.boletos[id];
    }
    return data.ok;
  } catch (e) {
    console.error('Error liberando boleto:', e);
    return false;
  }
}

async function pagarBoleto(id) {
  try {
    const r = await fetch(`${API_BASE}/api/boletos/${id}/pagar`, {
      method: 'PUT',
      headers: adminHeaders()
    });
    const data = await r.json();
    if (data.ok && _stateCache) {
      _stateCache.boletos[id] = data.boleto;
    }
    return data.ok;
  } catch (e) {
    console.error('Error pagando boleto:', e);
    return false;
  }
}

// ── Seat helpers ──────────────────────────────
function filaLabel(idx) {
  return String.fromCharCode(65 + idx);
}

function seatLabel(asiento) {
  if (!asiento) return '';
  return `Fila ${filaLabel(asiento.fila)} · Asiento ${asiento.col + 1}`;
}

function getSoldSeats(salaId) {
  const s = getState();
  const sold = new Set();
  Object.values(s.boletos).forEach(b => {
    if (b.sala === salaId && b.asiento) {
      sold.add(`${b.asiento.fila}-${b.asiento.col}`);
    }
  });
  return sold;
}

function getNextAvailableSeat(salaId) {
  const s = getState();
  const sala = s.config.salas.find(sl => sl.id === salaId);
  if (!sala) return null;
  const sold = getSoldSeats(salaId);
  for (let f = 0; f < sala.filas; f++) {
    for (let c = 0; c < sala.columnas; c++) {
      if (!sold.has(`${f}-${c}`)) return { fila: f, col: c };
    }
  }
  return null;
}

function getSeatMapData(salaId) {
  const s = getState();
  const sala = s.config.salas.find(sl => sl.id === salaId);
  if (!sala) return null;
  const boletos = Object.values(s.boletos).filter(b => b.sala === salaId && b.asiento);
  const map = {};
  boletos.forEach(b => { map[`${b.asiento.fila}-${b.asiento.col}`] = b; });
  return { sala, map };
}

// ── QR Payload ────────────────────────────────
function buildQRPayload(boletoId) {
  return JSON.stringify({ v: 1, id: boletoId, app: 'alcinepapa' });
}

function parseQRPayload(raw) {
  try {
    const obj = JSON.parse(raw);
    if (obj.app === 'alcinepapa' && obj.id) return obj.id;
    return null;
  } catch {
    if (/^B[A-Z0-9]+$/.test(raw.trim())) return raw.trim();
    return null;
  }
}

// ── Scan validation (via API) ─────────────────
// Returns Promise<result>
async function escanearBoleto(rawQR, salaScanId) {
  try {
    const r = await fetch(`${API_BASE}/api/scan`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Bypass-Tunnel-Reminder': 'true' },
      body: JSON.stringify({ qrPayload: rawQR, salaScanId })
    });
    return await r.json();
  } catch (e) {
    return { ok: false, tipo: 'invalid', msg: 'Error de conexión', detail: 'No se pudo conectar al servidor.' };
  }
}

function getSalaNombre(salaId) {
  const s = getState();
  const sala = s.config.salas.find(s => s.id === salaId);
  return sala ? sala.nombre : salaId;
}

// ── Statistics ────────────────────────────────
function getStats() {
  const s = getState();
  const boletos = Object.values(s.boletos);
  const result = {
    total: boletos.length,
    padres: boletos.filter(b => b.tipo === 'padre').length,
    hijos: boletos.filter(b => b.tipo === 'hijo').length,
    escaneados: boletos.filter(b => b.escaneado).length,
    escaneadosPadres: boletos.filter(b => b.tipo === 'padre' && b.escaneado).length,
    escaneadosHijos: boletos.filter(b => b.tipo === 'hijo' && b.escaneado).length,
    ingresoPadres: 0, ingresoHijos: 0, ingresoTotal: 0,
    salas: {}
  };
  result.ingresoPadres = result.padres * s.config.precioPadre;
  result.ingresoHijos = result.hijos * s.config.precioHijo;
  result.ingresoTotal = result.ingresoPadres + result.ingresoHijos;

  s.config.salas.forEach(sala => {
    const sb = boletos.filter(b => b.sala === sala.id);
    result.salas[sala.id] = {
      nombre: sala.nombre,
      total: sb.length,
      padres: sb.filter(b => b.tipo === 'padre').length,
      hijos: sb.filter(b => b.tipo === 'hijo').length,
      escaneados: sb.filter(b => b.escaneado).length,
      escaneadosPadres: sb.filter(b => b.tipo === 'padre' && b.escaneado).length,
      escaneadosHijos: sb.filter(b => b.tipo === 'hijo' && b.escaneado).length,
      ingreso: sb.filter(b => b.tipo === 'padre').length * s.config.precioPadre +
               sb.filter(b => b.tipo === 'hijo').length * s.config.precioHijo
    };
  });
  return result;
}

// ── Config save ───────────────────────────────
async function saveConfig(configData, newPassword) {
  const body = { config: configData };
  if (newPassword) body.password = newPassword;
  try {
    const r = await fetch(`${API_BASE}/api/config`, {
      method: 'PUT',
      headers: adminHeaders(),
      body: JSON.stringify(body)
    });
    const data = await r.json();
    if (data.ok && _stateCache) {
      _stateCache.config = { ..._stateCache.config, ...configData };
      if (newPassword) _stateCache.password = newPassword;
    }
    return data.ok;
  } catch (e) {
    return false;
  }
}

// ── Reset data ────────────────────────────────
async function resetData() {
  if (!confirm('⚠️ ¿Seguro que quieres borrar TODOS los boletos y escaneos? Esta acción no se puede deshacer.')) return;
  try {
    await fetch(`${API_BASE}/api/reset`, { 
      method: 'DELETE',
      headers: adminHeaders()
    });
    if (_stateCache) { _stateCache.boletos = {}; _stateCache.scans = []; }
    showToast('Datos borrados correctamente', 'warn');
    if (typeof renderAll === 'function') renderAll();
  } catch (e) {
    showToast('Error al borrar datos', 'error');
  }
}

// ── Formatters ────────────────────────────────
function fmt(n) {
  const s = getState();
  return new Intl.NumberFormat('es-CO', { style: 'currency', currency: s.config.moneda || 'COP', maximumFractionDigits: 0 }).format(n);
}

function fmtDate(iso) {
  return new Date(iso).toLocaleString('es-CO', { dateStyle: 'short', timeStyle: 'short' });
}

// ── Toast notifications ────────────────────────
function showToast(msg, type = 'info', duration = 3500) {
  const icons = { success: '✅', error: '❌', warn: '⚠️', info: 'ℹ️' };
  const container = document.getElementById('toast-container');
  if (!container) return;
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.innerHTML = `<span>${icons[type]}</span><span>${msg}</span>`;
  container.appendChild(el);
  setTimeout(() => {
    el.style.animation = 'slideOut 0.3s ease forwards';
    setTimeout(() => el.remove(), 300);
  }, duration);
}

// ── Nav active state ──────────────────────────
function setActiveNav() {
  const page = window.location.pathname.split('/').pop() || 'index.html';
  document.querySelectorAll('.nav-links a').forEach(a => {
    const href = a.getAttribute('href');
    a.classList.toggle('active', href === page || (href === 'index.html' && page === ''));
  });
}

// ── Export to Excel ───────────────────────────
function exportarExcel() {
  const s = getState();
  const st = getStats();
  const boletos = Object.values(s.boletos);
  const XLSX = window.XLSX;

  if (!XLSX) { showToast('Librería Excel no cargada', 'error'); return; }

  const detalle = [
    ['ID Boleto', 'Tipo', 'Sala', 'Película', 'Asiento', 'Precio', 'Vendido', 'Escaneado', 'Hora Escaneo']
  ];
  boletos.forEach(b => {
    const sala = s.config.salas.find(sl => sl.id === b.sala);
    const pel = s.config.peliculas.find(p => p.id === b.pelicula);
    detalle.push([
      b.id, b.tipo === 'padre' ? 'Padre' : 'Hijo/a',
      sala ? sala.nombre : b.sala, pel ? pel.titulo : b.pelicula,
      b.asiento ? seatLabel(b.asiento) : 'Sin asiento',
      b.tipo === 'padre' ? s.config.precioPadre : s.config.precioHijo,
      b.vendido ? 'Sí' : 'No', b.escaneado ? 'Sí' : 'No',
      b.escaneadoAt ? fmtDate(b.escaneadoAt) : ''
    ]);
  });

  const resumen = [
    ['Sala', 'Película', 'Boletos Padres', 'Boletos Hijos', 'Total Boletos',
     'Ingresados Padres', 'Ingresados Hijos', 'Ingreso Padres', 'Ingreso Hijos', 'Total Ingreso']
  ];
  s.config.salas.forEach(sala => {
    const st2 = st.salas[sala.id] || {};
    const pel = s.config.peliculas.find(p => p.sala === sala.id);
    resumen.push([
      sala.nombre, pel ? `${pel.titulo} (${pel.hora})` : '',
      st2.padres || 0, st2.hijos || 0, st2.total || 0,
      st2.escaneadosPadres || 0, st2.escaneadosHijos || 0,
      (st2.padres || 0) * s.config.precioPadre,
      (st2.hijos || 0) * s.config.precioHijo,
      st2.ingreso || 0
    ]);
  });

  const totales = [
    ['Concepto', 'Cantidad', 'Precio Unitario', 'Total'],
    ['Boletos Padres Vendidos', st.padres, s.config.precioPadre, st.ingresoPadres],
    ['Boletos Hijos Vendidos', st.hijos, s.config.precioHijo, st.ingresoHijos],
    ['', '', '', ''],
    ['TOTAL GENERAL', st.total, '', st.ingresoTotal],
    ['', '', '', ''],
    ['Padres Ingresados', st.escaneadosPadres, '', ''],
    ['Hijos Ingresados', st.escaneadosHijos, '', ''],
    ['Total Ingresados', st.escaneados, '', ''],
    ['Pendientes de Ingresar', st.total - st.escaneados, '', '']
  ];

  const wb = window.XLSX.utils.book_new();
  const ws1 = XLSX.utils.aoa_to_sheet(detalle);
  const ws2 = XLSX.utils.aoa_to_sheet(resumen);
  const ws3 = XLSX.utils.aoa_to_sheet(totales);
  ws1['!cols'] = [15,10,10,25,18,12,10,10,18].map(w => ({ wch: w }));
  ws2['!cols'] = [12,28,15,15,14,18,18,16,16,16].map(w => ({ wch: w }));
  ws3['!cols'] = [28,12,16,16].map(w => ({ wch: w }));
  XLSX.utils.book_append_sheet(wb, ws1, 'Boletos');
  XLSX.utils.book_append_sheet(wb, ws2, 'Resumen por Sala');
  XLSX.utils.book_append_sheet(wb, ws3, 'Total General');

  const fecha = new Date().toLocaleDateString('es-CO').replace(/\//g, '-');
  XLSX.writeFile(wb, `AlCineConPapa_Reporte_${fecha}.xlsx`);
  showToast('¡Excel descargado exitosamente!', 'success');
}

// ── Update Navbar based on Auth ────────────────
function updateNavbar() {
  const loggedIn = isLoggedIn();
  
  document.querySelectorAll('.nav-links a').forEach(a => {
    const href = a.getAttribute('href');
    if (href === 'scanner.html') {
      a.parentElement.style.display = loggedIn ? '' : 'none';
    } else if (href === 'reporte.html') {
      a.parentElement.style.display = (loggedIn && hasPermiso('verEstadisticas')) ? '' : 'none';
    } else if (href === 'admin.html') {
      const label = a.querySelector('span:last-child');
      if (label) label.textContent = loggedIn ? 'Config' : 'Login';
    }
  });
}

// ── Init: cargar estado y conectar WS ─────────
document.addEventListener('DOMContentLoaded', async () => {
  setActiveNav();
  updateNavbar();
  await fetchState();
  connectWS();
  // Allow page to render after state is loaded
  if (typeof onStateLoaded === 'function') onStateLoaded();
});
