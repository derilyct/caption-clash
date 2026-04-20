/**
 * Simple JSON-file user database.
 * Stores accounts and persistent win counts.
 */
const fs = require('fs');
const path = require('path');

const DB_PATH = path.join(__dirname, '..', 'data', 'users.json');
const DATA_DIR = path.dirname(DB_PATH);

if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

let users = [];
if (fs.existsSync(DB_PATH)) {
  try {
    users = JSON.parse(fs.readFileSync(DB_PATH, 'utf-8'));
  } catch {
    users = [];
  }
}

function save() {
  fs.writeFileSync(DB_PATH, JSON.stringify(users, null, 2), 'utf-8');
}

function findById(id) {
  return users.find((u) => u.id === id) || null;
}

function findByUsername(username) {
  return users.find((u) => u.username.toLowerCase() === username.toLowerCase()) || null;
}

function findByProvider(provider, providerId) {
  return users.find((u) => u.provider === provider && u.providerId === providerId) || null;
}

function createUser({ username, passwordHash = null, provider = 'local', providerId = null }) {
  const id = users.length > 0 ? Math.max(...users.map((u) => u.id)) + 1 : 1;
  const user = {
    id,
    username,
    passwordHash,
    provider,
    providerId,
    wins: 0,
    createdAt: new Date().toISOString(),
  };
  users.push(user);
  save();
  return user;
}

function incrementWins(userId) {
  const user = findById(userId);
  if (user) {
    user.wins++;
    save();
  }
  return user;
}

function toPublic(user) {
  if (!user) return null;
  return { id: user.id, username: user.username, wins: user.wins, provider: user.provider };
}

module.exports = { findById, findByUsername, findByProvider, createUser, incrementWins, toPublic };
