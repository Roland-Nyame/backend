const http = require('http');
const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

function loadEnvironment(filePath) {
  if (!fs.existsSync(filePath)) return;
  for (const line of fs.readFileSync(filePath, 'utf8').split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (match && !process.env[match[1]]) process.env[match[1]] = match[2].replace(/^['"]|['"]$/g, '');
  }
}

function databasePathFromUrl(url) {
  const match = url.match(/^(?:file|sqlite):(.*)$/);
  if (!match || !match[1]) throw new Error('DATABASE_URL must use file: or sqlite:, for example file:./hostel.db');
  let target = match[1];
  // Collapse file:// or file:/// URL forms down to a single leading slash so
  // absolute paths (e.g. the Render persistent disk mount at /var/data) are
  // preserved as absolute. Relative paths like "./hostel.db" are unaffected
  // and still resolve against __dirname.
  if (/^\/{2,}/.test(target)) target = target.replace(/^\/+/, '/');
  return path.isAbsolute(target) ? target : path.resolve(__dirname, target);
}

loadEnvironment(path.join(__dirname, '.env'));

const PORT = process.env.PORT || 3000;
const DATABASE_URL = process.env.DATABASE_URL || 'file:./hostel.db';
const ADMIN_EMAIL = process.env.ADMIN_EMAIL || 'roland@gmail.com';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'Ohenebaf613';
const floors = ['GF', 'FF', 'SF', 'TF'];
const studentNames = ['Ama Mensah', 'Kwame Asante', 'Esi Boateng', 'Kojo Owusu', 'Adwoa Agyeman', 'Kofi Ofori', 'Akosua Appiah', 'Yaw Antwi', 'Abena Frimpong', 'Nana Boadu'];
const defaultUsers = [
  { email: ADMIN_EMAIL, password: ADMIN_PASSWORD, name: 'Campus Admin', role: 'admin' },
  { indexNumber: '10011507', password: 'student123', name: 'Ama Mensah', role: 'student' },
];
const tokens = new Map();

function makeFloor(prefix) {
  return Array.from({ length: 35 }, (_, index) => {
    const number = index + 1;
    const status = number % 11 === 0 ? 'repair' : number % 5 === 0 ? 'available' : 'occupied';
    return {
      id: `${prefix}-${String(number).padStart(2, '0')}`,
      floor: prefix,
      status,
      occupiedBeds: status === 'occupied' ? 2 + (number % 3) : 0,
      capacity: 4,
      studentNames: status === 'occupied'
        ? Array.from({ length: 2 + (number % 3) }, (_, studentIndex) => studentNames[(index + studentIndex) % studentNames.length])
        : [],
    };
  });
}

const defaultRooms = {
  GF: makeFloor('GF'),
  FF: makeFloor('FF'),
  SF: makeFloor('SF'),
  TF: makeFloor('TF'),
};
const database = new DatabaseSync(databasePathFromUrl(DATABASE_URL));
database.exec('CREATE TABLE IF NOT EXISTS portal_state (id INTEGER PRIMARY KEY CHECK (id = 1), data TEXT NOT NULL)');
const persistedState = database.prepare('SELECT data FROM portal_state WHERE id = 1').get();
const saved = persistedState
  ? JSON.parse(persistedState.data)
  : { users: defaultUsers, rooms: defaultRooms, notifications: [], urgentReports: [] };
let users = saved.users;
let rooms = saved.rooms;
let notifications = saved.notifications || [];
let urgentReports = saved.urgentReports || [];

function persist() {
  const data = JSON.stringify({ users, rooms, notifications, urgentReports });
  database.prepare('INSERT INTO portal_state (id, data) VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET data = excluded.data').run(data);
}

if (!persistedState) persist();

function send(response, code, data) {
  response.writeHead(code, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
  response.end(JSON.stringify(data));
}

function getUser(request) {
  const token = request.headers.authorization?.replace('Bearer ', '');
  return tokens.get(token);
}

function safeUser(user) {
  const safe = { name: user.name, role: user.role };
  if (user.email) safe.email = user.email;
  if (user.indexNumber) safe.indexNumber = user.indexNumber;
  return safe;
}

function isValidIndexNumber(value) {
  return typeof value === 'string' && /^\d{8}$/.test(value);
}

const server = http.createServer((request, response) => {
  const url = new URL(request.url, `http://${request.headers.host}`);

  if (request.method === 'OPTIONS') {
    response.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, PATCH, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    });
    return response.end();
  }

  if (request.method === 'POST' && url.pathname === '/api/login') {
    let body = '';
    request.on('data', (chunk) => { body += chunk; });
    request.on('end', () => {
      try {
        const { email, indexNumber, password } = JSON.parse(body || '{}');
        const account = users.find((item) => {
          if (email) return item.email === email;
          if (indexNumber) return item.indexNumber === indexNumber;
          return false;
        });
        if (!account) return send(response, 401, { error: 'Account not found' });
        if (account.password !== password) return send(response, 401, { error: 'Password is not correct' });
        const token = `nduom-${Date.now()}-${Math.random().toString(36).slice(2)}`;
        const safe = safeUser(account);
        tokens.set(token, safe);
        return send(response, 200, { token, user: safe });
      } catch {
        return send(response, 400, { error: 'Invalid JSON request body' });
      }
    });
    return;
  }

  if (request.method === 'POST' && url.pathname === '/api/register') {
    let body = '';
    request.on('data', (chunk) => { body += chunk; });
    request.on('end', () => {
      try {
        const { name, indexNumber, password } = JSON.parse(body || '{}');
        if (!name?.trim() || !indexNumber || !password) {
          return send(response, 400, { error: 'Name, index number, and password are required' });
        }
        if (!isValidIndexNumber(indexNumber)) {
          return send(response, 400, { error: 'Index number must be exactly 8 digits' });
        }
        if (users.some((item) => item.indexNumber === indexNumber)) {
          return send(response, 409, { error: 'An account with this index number already exists' });
        }
        const user = { name: name.trim(), indexNumber, password, role: 'student' };
        users = [...users, user];
        persist();
        return send(response, 201, { user: safeUser(user) });
      } catch {
        return send(response, 400, { error: 'Invalid JSON request body' });
      }
    });
    return;
  }

  if (request.method === 'GET' && url.pathname === '/api/health') {
    return send(response, 200, { status: 'ok' });
  }

  if (request.method === 'GET' && !url.pathname.startsWith('/api/')) {
    const requested = url.pathname === '/' ? 'index.html' : url.pathname.replace(/^\//, '');
    const frontendPath = path.join(__dirname, '..', 'frontend');
    const filePath = path.join(frontendPath, requested);
    if (filePath.startsWith(frontendPath) && fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
      const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png' };
      response.writeHead(200, { 'Content-Type': types[path.extname(filePath)] || 'application/octet-stream' });
      return fs.createReadStream(filePath).pipe(response);
    }
  }

  const user = getUser(request);
  if (!user) return send(response, 401, { error: 'Please log in first' });

  if (request.method === 'GET' && url.pathname === '/api/rooms') {
    const floor = url.searchParams.get('floor');
    if (floor && floors.includes(floor)) return send(response, 200, rooms[floor]);
    return send(response, 200, rooms);
  }

  if (request.method === 'GET' && url.pathname === '/api/notifications') {
    const sorted = [...notifications].sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
    return send(response, 200, sorted);
  }

  if (request.method === 'POST' && url.pathname === '/api/notifications') {
    if (user.role !== 'admin') return send(response, 403, { error: 'Only Admin users can send notifications' });

    let body = '';
    request.on('data', (chunk) => { body += chunk; });
    request.on('end', () => {
      try {
        const { title, message } = JSON.parse(body || '{}');
        if (!title?.trim() || !message?.trim()) {
          return send(response, 400, { error: 'Title and message are required' });
        }
        const notification = {
          id: `notice-${Date.now()}`,
          title: title.trim(),
          message: message.trim(),
          createdAt: new Date().toISOString(),
          createdBy: user.name,
        };
        notifications = [notification, ...notifications];
        persist();
        return send(response, 201, notification);
      } catch {
        return send(response, 400, { error: 'Invalid JSON request body' });
      }
    });
    return;
  }

  if (request.method === 'GET' && url.pathname === '/api/reports') {
    const reports = user.role === 'admin'
      ? urgentReports
      : urgentReports.filter((item) => item.indexNumber === user.indexNumber);
    const sorted = [...reports].sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
    return send(response, 200, sorted);
  }

  if (request.method === 'POST' && url.pathname === '/api/reports') {
    if (user.role !== 'student') return send(response, 403, { error: 'Only students can submit urgent reports' });

    let body = '';
    request.on('data', (chunk) => { body += chunk; });
    request.on('end', () => {
      try {
        const { title, message, location } = JSON.parse(body || '{}');
        if (!title?.trim() || !message?.trim()) {
          return send(response, 400, { error: 'Title and description are required' });
        }
        const report = {
          id: `report-${Date.now()}`,
          title: title.trim(),
          message: message.trim(),
          location: location?.trim() || '',
          status: 'pending',
          createdAt: new Date().toISOString(),
          reportedBy: user.name,
          indexNumber: user.indexNumber,
        };
        urgentReports = [report, ...urgentReports];
        persist();
        return send(response, 201, report);
      } catch {
        return send(response, 400, { error: 'Invalid JSON request body' });
      }
    });
    return;
  }

  if (request.method === 'PATCH' && url.pathname.startsWith('/api/reports/')) {
    if (user.role !== 'admin') return send(response, 403, { error: 'Only Admin users can update reports' });
    const reportId = decodeURIComponent(url.pathname.split('/').pop());
    const report = urgentReports.find((item) => item.id === reportId);
    if (!report) return send(response, 404, { error: 'Report not found' });

    let body = '';
    request.on('data', (chunk) => { body += chunk; });
    request.on('end', () => {
      try {
        const { status } = JSON.parse(body || '{}');
        if (!['pending', 'resolved'].includes(status)) {
          return send(response, 400, { error: 'Status must be pending or resolved' });
        }
        report.status = status;
        persist();
        return send(response, 200, report);
      } catch {
        return send(response, 400, { error: 'Invalid JSON request body' });
      }
    });
    return;
  }

  if (request.method === 'PATCH' && url.pathname.startsWith('/api/rooms/')) {
    if (user.role !== 'admin') return send(response, 403, { error: 'Only Admin users can update rooms' });
    const roomId = decodeURIComponent(url.pathname.split('/').pop());
    const room = Object.values(rooms).flat().find((item) => item.id === roomId);
    if (!room) return send(response, 404, { error: 'Room not found' });

    let body = '';
    request.on('data', (chunk) => { body += chunk; });
    request.on('end', () => {
      try {
        const update = JSON.parse(body || '{}');
        if (['available', 'occupied', 'repair'].includes(update.status)) room.status = update.status;
        if (Number.isInteger(update.occupiedBeds) && update.occupiedBeds >= 0 && update.occupiedBeds <= room.capacity) room.occupiedBeds = update.occupiedBeds;
        if (Array.isArray(update.studentNames) && update.studentNames.length <= room.capacity && update.studentNames.every((name) => typeof name === 'string')) {
          room.studentNames = update.studentNames.map((name) => name.trim()).filter(Boolean);
        }
        if (room.status !== 'occupied') {
          room.occupiedBeds = 0;
          room.studentNames = [];
        } else if (room.studentNames.length) {
          room.occupiedBeds = room.studentNames.length;
        }
        persist();
        return send(response, 200, room);
      } catch {
        return send(response, 400, { error: 'Invalid JSON request body' });
      }
    });
    return;
  }

  return send(response, 404, { error: 'Route not found' });
});

server.listen(PORT, () => console.log(`Nduom hostel API listening on http://localhost:${PORT}`));
