const crypto = require('node:crypto');
const { getSetting, setSetting } = require('./db');

const REGISTER_ENDPOINT = 'https://mcp.upwork.com/register';
const AUTHORIZE_ENDPOINT = 'https://www.upwork.com/ab/account-security/oauth2/authorize';
const TOKEN_ENDPOINT = 'https://www.upwork.com/api/v3/oauth2/token';
const MCP_ENDPOINT = 'https://mcp.upwork.com/mcp';

function base64UrlEncode(buffer) {
  return buffer
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

async function getOrRegisterOAuthClient(redirectUri) {
  const cached = getSetting('upwork_oauth_client');
  if (cached && cached.client_id && cached.redirect_uri === redirectUri) {
    return cached;
  }

  const res = await fetch(REGISTER_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_name: 'Upwork Market Intelligence & Ghost Job Radar',
      redirect_uris: [redirectUri],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none'
    })
  });

  if (!res.ok) {
    throw new Error(`Dynamic Client Registration failed: ${res.status} ${await res.text()}`);
  }

  const data = await res.json();
  const clientInfo = {
    client_id: data.client_id,
    redirect_uri: redirectUri,
    registered_at: new Date().toISOString()
  };
  setSetting('upwork_oauth_client', clientInfo);
  return clientInfo;
}

async function createAuthorizationUrl(baseUrl) {
  const redirectUri = `${baseUrl}/auth/upwork/callback`;
  const client = await getOrRegisterOAuthClient(redirectUri);

  const codeVerifier = base64UrlEncode(crypto.randomBytes(32));
  const codeChallenge = base64UrlEncode(crypto.createHash('sha256').update(codeVerifier).digest());
  const state = base64UrlEncode(crypto.randomBytes(16));

  setSetting('upwork_pkce_session', {
    codeVerifier,
    state,
    redirectUri,
    client_id: client.client_id,
    createdAt: Date.now()
  });

  const params = new URLSearchParams({
    response_type: 'code',
    client_id: client.client_id,
    redirect_uri: redirectUri,
    code_challenge: codeChallenge,
    code_challenge_method: 'S256',
    state
  });

  return `${AUTHORIZE_ENDPOINT}?${params.toString()}`;
}

async function exchangeCodeForTokens(code, state) {
  const pkce = getSetting('upwork_pkce_session');
  if (!pkce || pkce.state !== state) {
    throw new Error('Invalid or expired OAuth state');
  }

  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    client_id: pkce.client_id,
    code,
    redirect_uri: pkce.redirectUri,
    code_verifier: pkce.codeVerifier
  });

  const res = await fetch(TOKEN_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString()
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Token exchange failed (${res.status}): ${errText}`);
  }

  const tokens = await res.json();
  const saved = {
    access_token: tokens.access_token,
    refresh_token: tokens.refresh_token,
    expires_at: Date.now() + ((tokens.expires_in || 3600) * 1000),
    client_id: pkce.client_id,
    connected_at: new Date().toISOString()
  };
  setSetting('upwork_tokens', saved);
  return saved;
}

async function getValidAccessToken() {
  if (process.env.UPWORK_ACCESS_TOKEN) {
    return process.env.UPWORK_ACCESS_TOKEN;
  }

  const tokens = getSetting('upwork_tokens');
  if (!tokens || !tokens.access_token) return null;

  // Proactively refresh if expiring within 6 hours (rolling renewal window)
  const sixHoursMs = 6 * 60 * 60 * 1000;
  if (tokens.expires_at && Date.now() > tokens.expires_at - sixHoursMs && tokens.refresh_token) {
    try {
      const body = new URLSearchParams({
        grant_type: 'refresh_token',
        client_id: tokens.client_id,
        refresh_token: tokens.refresh_token
      });
      const res = await fetch(TOKEN_ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: body.toString()
      });
      if (res.ok) {
        const refreshed = await res.json();
        const updated = {
          ...tokens,
          access_token: refreshed.access_token,
          refresh_token: refreshed.refresh_token || tokens.refresh_token,
          expires_at: Date.now() + ((refreshed.expires_in || 86400) * 1000),
          last_refreshed_at: new Date().toISOString()
        };
        setSetting('upwork_tokens', updated);
        console.log('Proactive token refresh successful. New validity: 24h from now.');
        return updated.access_token;
      }
    } catch (e) {
      console.error('Token refresh error:', e.message);
    }
  }

  return tokens.access_token;
}

// Call Official Upwork Remote MCP (https://mcp.upwork.com/mcp) via JSON-RPC Streamable HTTP
async function callOfficialUpworkMcp(method, params = {}, accessToken) {
  const res = await fetch(MCP_ENDPOINT, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Accept': 'application/json, text/event-stream',
      'Authorization': `Bearer ${accessToken}`
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: Date.now(),
      method,
      params
    })
  });

  if (!res.ok) {
    throw new Error(`Upwork MCP HTTP ${res.status}: ${await res.text()}`);
  }

  const contentType = res.headers.get('content-type') || '';
  if (contentType.includes('text/event-stream')) {
    const text = await res.text();
    const dataLine = text.split('\n').find(l => l.startsWith('data: '));
    if (dataLine) return JSON.parse(dataLine.slice(6));
    return { raw: text };
  }

  return await res.json();
}

module.exports = {
  createAuthorizationUrl,
  exchangeCodeForTokens,
  getValidAccessToken,
  callOfficialUpworkMcp
};
