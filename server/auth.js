/**
 * Authentication routes for Caption Clash.
 * Supports local (username/password) and social OAuth (Google, Facebook, Apple).
 * Social providers are enabled when their env vars are configured.
 */
const express = require('express');
const crypto = require('crypto');
const https = require('https');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const db = require('./db');

const router = express.Router();
const JWT_SECRET = process.env.JWT_SECRET || 'caption-clash-change-this-secret';
const BASE_URL = process.env.BASE_URL || 'http://localhost:3000';

// ========================
// Helpers
// ========================

function generateToken(userId) {
  return jwt.sign({ userId }, JWT_SECRET, { expiresIn: '30d' });
}

function verifyToken(token) {
  try {
    return jwt.verify(token, JWT_SECRET);
  } catch {
    return null;
  }
}

function fetchJSON(url, options = {}) {
  return new Promise((resolve, reject) => {
    const urlObj = new URL(url);
    const reqOptions = {
      hostname: urlObj.hostname,
      path: urlObj.pathname + urlObj.search,
      method: options.method || 'GET',
      headers: options.headers || {},
    };
    const req = https.request(reqOptions, (res) => {
      let body = '';
      res.on('data', (chunk) => (body += chunk));
      res.on('end', () => {
        try {
          resolve(JSON.parse(body));
        } catch {
          reject(new Error('Invalid JSON response'));
        }
      });
    });
    req.on('error', reject);
    if (options.body) req.write(options.body);
    req.end();
  });
}

// OAuth state store (in-memory, short-lived)
const oauthStates = new Map();
setInterval(() => {
  const now = Date.now();
  for (const [key, ts] of oauthStates) {
    if (now - ts > 300000) oauthStates.delete(key);
  }
}, 60000);

function createOAuthState() {
  const state = crypto.randomBytes(16).toString('hex');
  oauthStates.set(state, Date.now());
  return state;
}

function validateOAuthState(state) {
  if (!state || !oauthStates.has(state)) return false;
  oauthStates.delete(state);
  return true;
}

function findOrCreateSocialUser(provider, providerId, displayName) {
  let user = db.findByProvider(provider, providerId);
  if (user) return user;

  let base = (displayName || `${provider}-user`).trim().substring(0, 17);
  if (!base) base = `${provider}-user`;
  let username = base;
  let suffix = 1;
  while (db.findByUsername(username)) {
    const maxBase = 17 - String(suffix).length;
    username = base.substring(0, maxBase) + suffix;
    suffix++;
  }
  return db.createUser({ username, provider, providerId });
}

// ========================
// Local Auth
// ========================

router.post('/register', (req, res) => {
  const { username, password } = req.body;

  if (!username || typeof username !== 'string') {
    return res.status(400).json({ error: 'Username is required' });
  }
  const trimmed = username.trim();
  if (trimmed.length === 0 || trimmed.length > 17) {
    return res.status(400).json({ error: 'Username must be 1\u201317 characters' });
  }
  if (!password || typeof password !== 'string' || password.length === 0) {
    return res.status(400).json({ error: 'Password is required' });
  }
  if (db.findByUsername(trimmed)) {
    return res.status(409).json({ error: 'Username already taken' });
  }

  const passwordHash = bcrypt.hashSync(password, 10);
  const user = db.createUser({ username: trimmed, passwordHash });
  const token = generateToken(user.id);
  res.json({ token, user: db.toPublic(user) });
});

router.post('/login', (req, res) => {
  const { username, password } = req.body;

  if (!username || !password) {
    return res.status(400).json({ error: 'Username and password are required' });
  }

  const user = db.findByUsername(username.trim());
  if (!user || user.provider !== 'local') {
    return res.status(401).json({ error: 'Invalid username or password' });
  }
  if (!bcrypt.compareSync(password, user.passwordHash)) {
    return res.status(401).json({ error: 'Invalid username or password' });
  }

  const token = generateToken(user.id);
  res.json({ token, user: db.toPublic(user) });
});

router.get('/me', (req, res) => {
  const auth = req.headers.authorization;
  if (!auth || !auth.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Not authenticated' });
  }
  const decoded = verifyToken(auth.split(' ')[1]);
  if (!decoded) return res.status(401).json({ error: 'Invalid token' });
  const user = db.findById(decoded.userId);
  if (!user) return res.status(401).json({ error: 'User not found' });
  res.json({ user: db.toPublic(user) });
});

// ========================
// Google OAuth
// ========================

if (process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET) {
  router.get('/google', (req, res) => {
    const state = createOAuthState();
    const params = new URLSearchParams({
      client_id: process.env.GOOGLE_CLIENT_ID,
      redirect_uri: `${BASE_URL}/api/auth/google/callback`,
      response_type: 'code',
      scope: 'openid profile',
      state,
    });
    res.redirect(`https://accounts.google.com/o/oauth2/v2/auth?${params}`);
  });

  router.get('/google/callback', async (req, res) => {
    try {
      if (!validateOAuthState(req.query.state)) {
        return res.redirect('/#auth-error=invalid-state');
      }
      if (!req.query.code) return res.redirect('/#auth-error=no-code');

      const tokenData = await fetchJSON('https://oauth2.googleapis.com/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          code: req.query.code,
          client_id: process.env.GOOGLE_CLIENT_ID,
          client_secret: process.env.GOOGLE_CLIENT_SECRET,
          redirect_uri: `${BASE_URL}/api/auth/google/callback`,
          grant_type: 'authorization_code',
        }).toString(),
      });
      if (!tokenData.access_token) return res.redirect('/#auth-error=token-failed');

      const profile = await fetchJSON('https://www.googleapis.com/oauth2/v2/userinfo', {
        headers: { Authorization: `Bearer ${tokenData.access_token}` },
      });
      if (!profile.id) return res.redirect('/#auth-error=profile-failed');

      const user = findOrCreateSocialUser('google', profile.id, profile.name);
      const token = generateToken(user.id);
      res.redirect(`/#auth-token=${token}`);
    } catch (err) {
      console.error('Google OAuth error:', err);
      res.redirect('/#auth-error=google-failed');
    }
  });
}

// ========================
// Facebook OAuth
// ========================

if (process.env.FACEBOOK_APP_ID && process.env.FACEBOOK_APP_SECRET) {
  router.get('/facebook', (req, res) => {
    const state = createOAuthState();
    const params = new URLSearchParams({
      client_id: process.env.FACEBOOK_APP_ID,
      redirect_uri: `${BASE_URL}/api/auth/facebook/callback`,
      response_type: 'code',
      scope: 'public_profile',
      state,
    });
    res.redirect(`https://www.facebook.com/v18.0/dialog/oauth?${params}`);
  });

  router.get('/facebook/callback', async (req, res) => {
    try {
      if (!validateOAuthState(req.query.state)) {
        return res.redirect('/#auth-error=invalid-state');
      }
      if (!req.query.code) return res.redirect('/#auth-error=no-code');

      const tokenParams = new URLSearchParams({
        client_id: process.env.FACEBOOK_APP_ID,
        client_secret: process.env.FACEBOOK_APP_SECRET,
        redirect_uri: `${BASE_URL}/api/auth/facebook/callback`,
        code: req.query.code,
      });
      const tokenData = await fetchJSON(
        `https://graph.facebook.com/v18.0/oauth/access_token?${tokenParams}`
      );
      if (!tokenData.access_token) return res.redirect('/#auth-error=token-failed');

      const profile = await fetchJSON(
        `https://graph.facebook.com/v18.0/me?fields=id,name&access_token=${tokenData.access_token}`
      );
      if (!profile.id) return res.redirect('/#auth-error=profile-failed');

      const user = findOrCreateSocialUser('facebook', profile.id, profile.name);
      const token = generateToken(user.id);
      res.redirect(`/#auth-token=${token}`);
    } catch (err) {
      console.error('Facebook OAuth error:', err);
      res.redirect('/#auth-error=facebook-failed');
    }
  });
}

// ========================
// Apple Sign In
// ========================

if (
  process.env.APPLE_SERVICE_ID &&
  process.env.APPLE_TEAM_ID &&
  process.env.APPLE_KEY_ID &&
  process.env.APPLE_PRIVATE_KEY
) {
  router.get('/apple', (req, res) => {
    const state = createOAuthState();
    const params = new URLSearchParams({
      client_id: process.env.APPLE_SERVICE_ID,
      redirect_uri: `${BASE_URL}/api/auth/apple/callback`,
      response_type: 'code id_token',
      response_mode: 'form_post',
      scope: 'name',
      state,
    });
    res.redirect(`https://appleid.apple.com/auth/authorize?${params}`);
  });

  router.post(
    '/apple/callback',
    express.urlencoded({ extended: false }),
    async (req, res) => {
      try {
        if (!validateOAuthState(req.body.state)) {
          return res.redirect('/#auth-error=invalid-state');
        }
        if (!req.body.code) return res.redirect('/#auth-error=no-code');

        // Build Apple client_secret (ES256-signed JWT)
        const privateKey = process.env.APPLE_PRIVATE_KEY.replace(/\\n/g, '\n');
        const clientSecret = jwt.sign({}, privateKey, {
          algorithm: 'ES256',
          expiresIn: '5m',
          audience: 'https://appleid.apple.com',
          issuer: process.env.APPLE_TEAM_ID,
          subject: process.env.APPLE_SERVICE_ID,
          keyid: process.env.APPLE_KEY_ID,
        });

        const tokenData = await fetchJSON('https://appleid.apple.com/auth/token', {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({
            client_id: process.env.APPLE_SERVICE_ID,
            client_secret: clientSecret,
            code: req.body.code,
            grant_type: 'authorization_code',
            redirect_uri: `${BASE_URL}/api/auth/apple/callback`,
          }).toString(),
        });
        if (!tokenData.id_token) return res.redirect('/#auth-error=token-failed');

        const decoded = jwt.decode(tokenData.id_token);
        if (!decoded || !decoded.sub) return res.redirect('/#auth-error=invalid-token');

        // Apple only sends user info on first authorization
        let displayName = 'Apple User';
        if (req.body.user) {
          try {
            const u = JSON.parse(req.body.user);
            displayName =
              [u.name?.firstName, u.name?.lastName].filter(Boolean).join(' ') || 'Apple User';
          } catch {
            /* ignore parse errors */
          }
        }

        const user = findOrCreateSocialUser('apple', decoded.sub, displayName);
        const token = generateToken(user.id);
        res.redirect(`/#auth-token=${token}`);
      } catch (err) {
        console.error('Apple Sign In error:', err);
        res.redirect('/#auth-error=apple-failed');
      }
    }
  );
}

// ========================
// Available providers
// ========================

router.get('/providers', (req, res) => {
  res.json({
    google: !!(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET),
    facebook: !!(process.env.FACEBOOK_APP_ID && process.env.FACEBOOK_APP_SECRET),
    apple: !!(
      process.env.APPLE_SERVICE_ID &&
      process.env.APPLE_TEAM_ID &&
      process.env.APPLE_KEY_ID &&
      process.env.APPLE_PRIVATE_KEY
    ),
  });
});

module.exports = { router, verifyToken };
