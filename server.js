// ══════════════════════════════════════════════
//  AL CINE CON PAPÁ — Servidor Backend
//  Express + WebSocket · Red Local y Render (con MongoDB)
// ══════════════════════════════════════════════

const express = require('express');
const http = require('http');
const { WebSocketServer } = require('ws');
const path = require('path');
const os = require('os');
const mongoose = require('mongoose');
require('dotenv').config();

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

const PORT = process.env.PORT || 3000;
const MONGODB_URI = process.env.MONGODB_URI;

// ── Database Schema ───────────────────────────
const stateSchema = new mongoose.Schema({
  id: { type: String, default: 'main' },
  password: { type: String, default: 'educador2024' },
  config: { type: Object, default: {} },
  boletos: { type: Object, default: {} },
  scans: { type: Array, default: [] },
  admins: { type: Array, default: [] }
}, { minimize: false, strict: false });

const State = mongoose.model('State', stateSchema);

// ── Default state ──────────────────────────────
const DEFAULT_STATE = {
  password: 'educador2024',
  admins: [
    {
      id: 'superadmin',
      username: 'admin',
      password: 'educador',
      nombre: 'Super Administrador',
      rol: 'superadmin',
      sala: null,
      permisos: {
        separarAsientos: true,
        confirmarPagos: true,
        liberarReservas: true,
        verEstadisticas: true,
        configurar: true
      }
    }
  ],
  config: {
    precioGeneral: 12000,
    moneda: 'COP',
    salas: [
      { id: 'sala1', nombre: 'Sala 1', color: '#f5c518', filas: 8, columnas: 10 },
      { id: 'sala2', nombre: 'Sala 2', color: '#ff6b6b', filas: 8, columnas: 10 },
      { id: 'sala3', nombre: 'Sala 3', color: '#82aaff', filas: 8, columnas: 10 }
    ],
    peliculas: [
      { id: 'p1', titulo: 'El León Rey', sala: 'sala1', hora: '10:00' },
      { id: 'p2', titulo: 'Rápidos y Furiosos X', sala: 'sala2', hora: '10:30' },
      { id: 'p3', titulo: 'Spider-Man: Sin Camino a Casa', sala: 'sala3', hora: '11:00' }
    ]
  },
  boletos: {},
  scans: []
};

// Initialize local memory fallback globally
global.localMemoryDB = JSON.parse(JSON.stringify(DEFAULT_STATE));

if (MONGODB_URI) {
  mongoose.connect(MONGODB_URI)
    .then(() => console.log('✅ Conectado a MongoDB'))
    .catch(err => console.error('❌ Error conectando a MongoDB:', err.message));
} else {
  console.log('⚠️ ADVERTENCIA: No se ha configurado MONGODB_URI.');
  console.log('   Si estás probando localmente, los datos se reiniciarán al cerrar el servidor.');
}

// ── DB helpers ────────────────────────────────
async function loadDB() {
  if (!MONGODB_URI || mongoose.connection.readyState !== 1) {
    return global.localMemoryDB || JSON.parse(JSON.stringify(DEFAULT_STATE));
  }

  try {
    let stateDoc = await State.findOne({ id: 'main' });
    if (!stateDoc) {
      stateDoc = new State({ id: 'main', ...DEFAULT_STATE });
      await stateDoc.save();
    }
    const doc = stateDoc.toObject();
    
    // Sincronizar memoria local por si la conexión se cae luego
    global.localMemoryDB = JSON.parse(JSON.stringify(doc));
    return doc;
  } catch (e) {
    console.error('Error loading DB:', e.message);
    return global.localMemoryDB || JSON.parse(JSON.stringify(DEFAULT_STATE));
  }
}

async function saveDB(stateObj) {
  // Always update local memory as a fallback
  global.localMemoryDB = JSON.parse(JSON.stringify(stateObj));

  if (!MONGODB_URI || mongoose.connection.readyState !== 1) {
    return; // Si no hay BD o no está conectada, solo guardamos en memoria local
  }

  try {
    let doc = await State.findOne({ id: 'main' });
    if (!doc) {
      doc = new State({ id: 'main', ...stateObj });
    } else {
      doc.password = stateObj.password;
      doc.config = stateObj.config;
      doc.boletos = stateObj.boletos;
      doc.scans = stateObj.scans;
      doc.admins = stateObj.admins;
      
      // Force Mongoose to recognize changes in nested objects
      doc.markModified('config');
      doc.markModified('boletos');
      doc.markModified('scans');
      doc.markModified('admins');
    }
    await doc.save();
  } catch (e) {
    console.error('Error saving DB:', e.message);
  }
}

// ── WebSocket broadcast ───────────────────────
function broadcast(event, data) {
  const msg = JSON.stringify({ event, data });
  wss.clients.forEach(client => {
    if (client.readyState === 1) { // OPEN
      client.send(msg);
    }
  });
}

wss.on('connection', async (ws) => {
  console.log('📱 Cliente conectado via WebSocket');
  const state = await loadDB();
  ws.send(JSON.stringify({ event: 'init', data: state }));

  ws.on('close', () => console.log('📱 Cliente desconectado'));
  ws.on('error', () => {});
});

// ── Middleware ────────────────────────────────
app.use(express.json());
app.use(express.static(__dirname));

app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Bypass-Tunnel-Reminder, X-Admin-Token');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

// ── Session tokens (in-memory, 8h TTL) ─────────────────
const sessions = new Map(); // token -> { adminId, expires }

function crearToken(adminId) {
  const token = Math.random().toString(36).slice(2) + Date.now().toString(36);
  sessions.set(token, { adminId, expires: Date.now() + 8 * 60 * 60 * 1000 });
  return token;
}

function validarToken(token) {
  const s = sessions.get(token);
  if (!s) return null;
  if (Date.now() > s.expires) { sessions.delete(token); return null; }
  return s.adminId;
}

// Cleanup expiradas cada hora
setInterval(() => {
  for (const [k, v] of sessions) {
    if (Date.now() > v.expires) sessions.delete(k);
  }
}, 60 * 60 * 1000);

async function getAdminFromRequest(req) {
  const token = req.headers['x-admin-token'];
  if (!token) return null;
  const adminId = validarToken(token);
  if (!adminId) return null;
  const state = await loadDB();
  return (state.admins || []).find(a => a.id === adminId) || null;
}

// ── Helpers ───────────────────────────────────
function generarId() {
  return 'B' + Date.now().toString(36).toUpperCase() +
    Math.random().toString(36).slice(2, 5).toUpperCase();
}

function filaLabel(idx) {
  return String.fromCharCode(65 + idx);
}

function seatLabel(asiento) {
  if (!asiento) return '';
  return `Fila ${filaLabel(asiento.fila)} · Asiento ${asiento.col + 1}`;
}

function getSoldSeats(state, salaId) {
  const sold = new Set();
  Object.values(state.boletos).forEach(b => {
    if (b.sala === salaId && b.asiento) {
      sold.add(`${b.asiento.fila}-${b.asiento.col}`);
    }
  });
  return sold;
}

function getNextAvailableSeat(state, salaId) {
  const sala = state.config.salas.find(s => s.id === salaId);
  if (!sala) return null;
  const sold = getSoldSeats(state, salaId);
  for (let f = 0; f < sala.filas; f++) {
    for (let c = 0; c < sala.columnas; c++) {
      if (!sold.has(`${f}-${c}`)) return { fila: f, col: c };
    }
  }
  return null;
}

function getStats(state) {
  const boletos = Object.values(state.boletos);
  const validos = boletos.filter(b => b.estado !== 'reservado');
  const result = {
    total: boletos.length,
    reservados: boletos.filter(b => b.estado === 'reservado').length,
    pagados: validos.length,
    escaneados: boletos.filter(b => b.escaneado).length,
    ingresoTotal: validos.length * (state.config.precioGeneral || 12000),
    salas: {}
  };

  state.config.salas.forEach(sala => {
    const sb = boletos.filter(b => b.sala === sala.id);
    const sbValidos = sb.filter(b => b.estado !== 'reservado');
    result.salas[sala.id] = {
      nombre: sala.nombre,
      total: sb.length,
      reservados: sb.filter(b => b.estado === 'reservado').length,
      pagados: sbValidos.length,
      escaneados: sb.filter(b => b.escaneado).length,
      ingreso: sbValidos.length * (state.config.precioGeneral || 12000)
    };
  });
  return result;
}

// ── API Routes ────────────────────────────────

app.get('/api/state', async (req, res) => {
  const state = await loadDB();
  res.json(state);
});

app.get('/api/stats', async (req, res) => {
  const state = await loadDB();
  res.json(getStats(state));
});

app.post('/api/boletos', async (req, res) => {
  const { salaId, peliculaId, asientos, estado, estudiante, grado } = req.body;
  if (!salaId || !peliculaId || !asientos || !Array.isArray(asientos) || asientos.length === 0) {
    return res.status(400).json({ error: 'Faltan campos: salaId, peliculaId, o asientos' });
  }
  if (!estudiante) {
    return res.status(400).json({ error: 'Falta el nombre del estudiante' });
  }

  const admin = await getAdminFromRequest(req);
  let estadoBoleto = estado || 'pagado';

  if (!admin) {
    // Padre de familia reserva
    estadoBoleto = 'reservado';
  } else {
    if (admin.rol !== 'superadmin' && !admin.permisos?.separarAsientos) {
      return res.status(403).json({ error: 'Sin permiso para generar boletos' });
    }
    if (admin.rol !== 'superadmin' && admin.sala && admin.sala !== salaId) {
      return res.status(403).json({ error: 'Solo puedes generar boletos para tu sala asignada' });
    }
  }

  const state = await loadDB();
  const created = [];
  const compraId = 'CMP-' + Date.now().toString(36).toUpperCase() + Math.random().toString(36).slice(2, 5).toUpperCase();

  for (const seat of asientos) {
    const id = generarId();
    state.boletos[id] = {
      id, sala: salaId, pelicula: peliculaId,
      asiento: seat,
      estudiante: estudiante.trim(),
      grado: grado ? grado.trim() : '',
      compraId,
      estado: estadoBoleto,
      vendido: true, escaneado: false,
      creadoAt: new Date().toISOString(),
      escaneadoAt: null, escaneadoEn: null
    };
    created.push(state.boletos[id]);
  }

  await saveDB(state);
  broadcast('update', { type: 'boleto_created', boletos: created, stats: getStats(state) });
  res.json({ ok: true, boletos: created, compraId });
});

app.post('/api/scan', async (req, res) => {
  const { qrPayload, salaScanId } = req.body;
  if (!qrPayload) return res.status(400).json({ error: 'qrPayload requerido' });

  let boletoIds = [];
  try {
    const obj = JSON.parse(qrPayload);
    if (obj.app === 'alcinepapa') {
      if (Array.isArray(obj.ids)) boletoIds = obj.ids;
      else if (obj.id) boletoIds = [obj.id];
    }
  } catch {
    if (/^B[A-Z0-9]+$/.test(qrPayload.trim())) boletoIds = [qrPayload.trim()];
  }

  if (boletoIds.length === 0) {
    return res.json({ ok: false, tipo: 'invalid', msg: 'QR no reconocido', detail: 'Este código no pertenece al sistema.' });
  }

  const state = await loadDB();
  
  // Validate all boletos
  const boletosData = [];
  for (const boletoId of boletoIds) {
    const b = state.boletos[boletoId];
    if (!b) return res.json({ ok: false, tipo: 'invalid', msg: 'Boleto no encontrado', detail: `El código ${boletoId} no existe en la BD.` });
    if (b.escaneado) {
      const when = new Date(b.escaneadoAt).toLocaleTimeString('es-CO', { hour: '2-digit', minute: '2-digit' });
      return res.json({ ok: false, tipo: 'warn', msg: '¡Boleto ya usado!', detail: `Al menos un asiento (${seatLabel(b.asiento)}) ingresó a las ${when}` });
    }
    if (salaScanId && b.sala !== salaScanId) {
      const salaName = (state.config.salas.find(s => s.id === b.sala) || {}).nombre || b.sala;
      return res.json({ ok: false, tipo: 'invalid', msg: 'Sala incorrecta', detail: `Los boletos son para ${salaName}` });
    }
    boletosData.push(b);
  }

  // If we reach here, all are valid and not scanned
  const now = new Date().toISOString();
  for (const b of boletosData) {
    b.escaneado = true;
    b.escaneadoAt = now;
    b.escaneadoEn = salaScanId || b.sala;
    state.scans.push({
      boletoId: b.id,
      sala: b.escaneadoEn, pelicula: b.pelicula, asiento: b.asiento, at: now,
      estudiante: b.estudiante, grado: b.grado
    });
  }
  await saveDB(state);

  const estudianteLabel = boletosData[0].estudiante || 'Asistente';
  const gradoLabel = boletosData[0].grado ? ` - ${boletosData[0].grado}` : '';
  const pel = state.config.peliculas.find(p => p.id === boletosData[0].pelicula);
  const asientosStr = boletosData.map(b => seatLabel(b.asiento)).join(', ');

  boletosData.forEach(b => {
    broadcast('update', { type: 'scan', scan: state.scans[state.scans.length - boletosData.length + boletosData.indexOf(b)], stats: getStats(state) });
  });

  res.json({
    ok: true, tipo: 'valid',
    msg: `¡Bienvenido! ${estudianteLabel}${gradoLabel}`,
    detail: `${boletosData.length} asiento(s): ${asientosStr}`,
    boletos: boletosData, pelicula: pel
  });
});

app.put('/api/config', async (req, res) => {
  const admin = await getAdminFromRequest(req);
  if (!admin || (admin.rol !== 'superadmin' && !admin.permisos?.configurar)) {
    return res.status(403).json({ error: 'Sin permiso para cambiar configuración' });
  }
  const { password, config } = req.body;
  const state = await loadDB();
  if (password !== undefined) {
    if (admin.rol !== 'superadmin') return res.status(403).json({ error: 'Solo el Super Administrador puede cambiar la contraseña global' });
    state.password = password;
  }
  if (config !== undefined) state.config = { ...state.config, ...config };
  await saveDB(state);
  broadcast('update', { type: 'config', config: state.config });
  res.json({ ok: true });
});

app.post('/api/auth', async (req, res) => {
  const { password } = req.body;
  const state = await loadDB();
  res.json({ ok: password === state.password });
});

// ── Admin Auth & Management ─────────────────────────
app.post('/api/admin/login', async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ error: 'Faltan credenciales' });
  
  const state = await loadDB();
  const admins = state.admins || [];
  
  // Initialize super admin if not exists
  if (!admins.find(a => a.id === 'superadmin')) {
    admins.push({
      id: 'superadmin', username: 'admin', password: 'educador',
      nombre: 'Super Administrador', rol: 'superadmin', sala: null,
      permisos: { separarAsientos: true, confirmarPagos: true, liberarReservas: true, verEstadisticas: true, configurar: true }
    });
    state.admins = admins;
    await saveDB(state);
  }
  
  const admin = admins.find(a => a.username === username && a.password === password);
  if (!admin) return res.json({ ok: false, error: 'Usuario o contraseña incorrectos' });
  
  const token = crearToken(admin.id);
  const { password: _, ...adminSafe } = admin;
  res.json({ ok: true, token, admin: adminSafe });
});

app.get('/api/admin/me', async (req, res) => {
  const admin = await getAdminFromRequest(req);
  if (!admin) return res.status(401).json({ error: 'No autenticado' });
  const { password: _, ...adminSafe } = admin;
  res.json(adminSafe);
});

app.post('/api/admin/logout', (req, res) => {
  const token = req.headers['x-admin-token'];
  if (token) sessions.delete(token);
  res.json({ ok: true });
});

app.get('/api/admins', async (req, res) => {
  const admin = await getAdminFromRequest(req);
  if (!admin || admin.rol !== 'superadmin') return res.status(403).json({ error: 'Sin permiso' });
  const state = await loadDB();
  const safeAdmins = (state.admins || []).map(({ password: _, ...a }) => a);
  res.json(safeAdmins);
});

app.get('/api/contacto-salas', async (req, res) => {
  const state = await loadDB();
  const contactos = {};
  (state.admins || []).forEach(a => {
    if (a.sala && a.telefono) {
      contactos[a.sala] = a.telefono;
    }
  });
  res.json(contactos);
});

app.post('/api/admins', async (req, res) => {
  const admin = await getAdminFromRequest(req);
  if (!admin || admin.rol !== 'superadmin') return res.status(403).json({ error: 'Sin permiso' });
  
  const { username, password, nombre, sala, permisos, telefono } = req.body;
  if (!username || !password || !nombre) return res.status(400).json({ error: 'Faltan campos: username, password, nombre' });
  
  const state = await loadDB();
  if (!state.admins) state.admins = [];
  
  if (state.admins.find(a => a.username === username)) {
    return res.status(400).json({ error: 'Ese nombre de usuario ya existe' });
  }
  
  const newAdmin = {
    id: 'adm_' + Date.now().toString(36),
    username, password, nombre, telefono: telefono || '',
    rol: 'admin',
    sala: sala || null,
    permisos: {
      separarAsientos: permisos?.separarAsientos ?? true,
      confirmarPagos: permisos?.confirmarPagos ?? true,
      liberarReservas: permisos?.liberarReservas ?? true,
      verEstadisticas: permisos?.verEstadisticas ?? true,
      configurar: false
    }
  };
  
  state.admins.push(newAdmin);
  await saveDB(state);
  
  const { password: _, ...adminSafe } = newAdmin;
  res.json({ ok: true, admin: adminSafe });
});

app.put('/api/admins/:id', async (req, res) => {
  const admin = await getAdminFromRequest(req);
  if (!admin || admin.rol !== 'superadmin') return res.status(403).json({ error: 'Sin permiso' });
  
  const state = await loadDB();
  const idx = (state.admins || []).findIndex(a => a.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Admin no encontrado' });
  if (state.admins[idx].id === 'superadmin') return res.status(400).json({ error: 'No puedes editar al Super Admin desde aquí' });
  
  const { username, password, nombre, sala, permisos, telefono } = req.body;
  if (username) state.admins[idx].username = username;
  if (password) state.admins[idx].password = password;
  if (nombre) state.admins[idx].nombre = nombre;
  if (telefono !== undefined) state.admins[idx].telefono = telefono;
  if (sala !== undefined) state.admins[idx].sala = sala;
  if (permisos) state.admins[idx].permisos = { ...state.admins[idx].permisos, ...permisos };
  
  await saveDB(state);
  const { password: _, ...adminSafe } = state.admins[idx];
  res.json({ ok: true, admin: adminSafe });
});

app.delete('/api/admins/:id', async (req, res) => {
  const admin = await getAdminFromRequest(req);
  if (!admin || admin.rol !== 'superadmin') return res.status(403).json({ error: 'Sin permiso' });
  if (req.params.id === 'superadmin') return res.status(400).json({ error: 'No puedes eliminar al Super Admin' });
  
  const state = await loadDB();
  const before = (state.admins || []).length;
  state.admins = (state.admins || []).filter(a => a.id !== req.params.id);
  if (state.admins.length === before) return res.status(404).json({ error: 'Admin no encontrado' });
  
  await saveDB(state);
  res.json({ ok: true });
});

app.delete('/api/reset', async (req, res) => {
  const admin = await getAdminFromRequest(req);
  if (!admin || admin.rol !== 'superadmin') {
    return res.status(403).json({ error: 'Sin permiso para reiniciar la base de datos' });
  }
  const state = await loadDB();
  state.boletos = {};
  state.scans = [];
  await saveDB(state);
  broadcast('update', { type: 'reset' });
  res.json({ ok: true });
});

app.get('/api/boletos/:id', async (req, res) => {
  const state = await loadDB();
  const b = state.boletos[req.params.id];
  if (!b) return res.status(404).json({ error: 'No encontrado' });
  res.json(b);
});

app.delete('/api/boletos/:id', async (req, res) => {
  const admin = await getAdminFromRequest(req);
  if (!admin || (admin.rol !== 'superadmin' && !admin.permisos?.liberarReservas)) {
    return res.status(403).json({ error: 'Sin permiso para liberar reservas' });
  }

  const state = await loadDB();
  const b = state.boletos[req.params.id];
  if (!b) return res.status(404).json({ error: 'No encontrado' });
  
  if (admin.rol !== 'superadmin' && admin.sala && admin.sala !== b.sala) {
    return res.status(403).json({ error: 'Solo puedes liberar reservas de tu sala asignada' });
  }
  
  delete state.boletos[req.params.id];
  await saveDB(state);
  
  broadcast('update', { type: 'boleto_deleted', id: req.params.id, stats: getStats(state) });
  res.json({ ok: true });
});

app.put('/api/boletos/:id/pagar', async (req, res) => {
  const admin = await getAdminFromRequest(req);
  if (!admin || (admin.rol !== 'superadmin' && !admin.permisos?.confirmarPagos)) {
    return res.status(403).json({ error: 'Sin permiso para confirmar pagos' });
  }

  const state = await loadDB();
  const b = state.boletos[req.params.id];
  if (!b) return res.status(404).json({ error: 'No encontrado' });
  
  if (admin.rol !== 'superadmin' && admin.sala && admin.sala !== b.sala) {
    return res.status(403).json({ error: 'Solo puedes confirmar pagos de tu sala asignada' });
  }
  
  b.estado = 'pagado';
  await saveDB(state);
  
  broadcast('update', { type: 'boleto_updated', boleto: b, stats: getStats(state) });
  res.json({ ok: true, boleto: b });
});

// ── Auto-Liberación (1 Hora) ─────────────────
setInterval(async () => {
  const state = await loadDB();
  if (!state.boletos) return;
  
  const now = Date.now();
  let changed = false;
  
  for (const id in state.boletos) {
    const b = state.boletos[id];
    if (b.estado === 'reservado' && b.creadoAt) {
      const createdAt = new Date(b.creadoAt).getTime();
      // Si pasaron más de 60 minutos (3600000 ms)
      if (now - createdAt > 86400000 ) {
        delete state.boletos[id];
        changed = true;
      }
    }
  }
  
  if (changed) {
    await saveDB(state);
    broadcast('update', { type: 'auto_liberacion', stats: getStats(state) });
    console.log('🧹 Se liberaron reservas vencidas (más de 1 hora).');
  }
}, 5 * 60 * 1000); // Revisar cada 5 minutos

// ── Start ─────────────────────────────────────
server.listen(PORT, '0.0.0.0', () => {
  const interfaces = os.networkInterfaces();
  let localIP = 'localhost';
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name]) {
      if (iface.family === 'IPv4' && !iface.internal) {
        localIP = iface.address;
        break;
      }
    }
    if (localIP !== 'localhost') break;
  }

  console.log('\n🎬 ═══════════════════════════════════════');
  console.log('   AL CINE CON PAPÁ — Servidor iniciado');
  console.log('═════════════════════════════════════════');
  console.log(`\n   🖥️  En este PC:     http://localhost:${PORT}`);
  console.log(`   📱  Otros disp.:   http://${localIP}:${PORT}`);
  console.log('\n═════════════════════════════════════════\n');
});
