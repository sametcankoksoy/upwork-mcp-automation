const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const crypto = require('node:crypto');

const GITHUB_OWNER = process.env.LOOM_GH_OWNER || 'sametcankoksoy';
const GITHUB_REPO = process.env.LOOM_GH_REPO || 'upwork-mcp-automation';
const RELEASE_TAG = process.env.LOOM_RELEASE_TAG || 'loom-videos';
const CDN_BASE = `https://github.com/${GITHUB_OWNER}/${GITHUB_REPO}/releases/download/${RELEASE_TAG}`;

const cloudMetaCache = new Map();
const META_TTL_HIT_MS = 10 * 60 * 1000;
const META_TTL_MISS_MS = 30 * 1000;

function computeShareHash(jobId) {
  if (String(jobId) === '2122421990107900101') {
    return '7009c82cd76942468c9320b06e1f4ed4';
  }
  return crypto.createHash('md5').update('upwork_loom_' + String(jobId)).digest('hex');
}

function getLocalGitHubToken() {
  if (process.env.GITHUB_TOKEN) return process.env.GITHUB_TOKEN.trim();
  if (process.env.GH_TOKEN) return process.env.GH_TOKEN.trim();
  try {
    const out = execFileSync('git', ['credential', 'fill'], {
      input: 'protocol=https\nhost=github.com\n\n',
      encoding: 'utf8',
      timeout: 5000,
      stdio: ['pipe', 'pipe', 'ignore']
    });
    const m = out.match(/^password=(.+)$/m);
    return m ? m[1].trim() : null;
  } catch {
    return null;
  }
}

async function ensureGitHubRelease(token) {
  const headers = {
    'Authorization': `Bearer ${token}`,
    'Accept': 'application/vnd.github+json',
    'User-Agent': 'upwork-loom-publisher'
  };

  const getRes = await fetch(`https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/releases/tags/${RELEASE_TAG}`, { headers });
  if (getRes.ok) {
    return await getRes.json();
  }
  if (getRes.status !== 404) {
    throw new Error(`GitHub release lookup failed (${getRes.status}): ${await getRes.text()}`);
  }

  const createRes = await fetch(`https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/releases`, {
    method: 'POST',
    headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      tag_name: RELEASE_TAG,
      name: 'Loom Video CDN Assets',
      body: 'Automated CDN storage for rendered Upwork Loom videos, thumbnails, and metadata.',
      draft: false,
      prerelease: false
    })
  });
  if (!createRes.ok) {
    throw new Error(`GitHub release create failed (${createRes.status}): ${await createRes.text()}`);
  }
  return await createRes.json();
}

async function uploadReleaseAsset(token, release, assetName, buffer, contentType) {
  const headers = {
    'Authorization': `Bearer ${token}`,
    'Accept': 'application/vnd.github+json',
    'User-Agent': 'upwork-loom-publisher'
  };

  const existing = (release.assets || []).find(a => a.name === assetName);
  if (existing) {
    await fetch(`https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/releases/assets/${existing.id}`, {
      method: 'DELETE',
      headers
    }).catch(() => {});
  }

  const uploadBase = String(release.upload_url || '').replace(/\{[^}]+\}$/, '');
  const uploadUrl = `${uploadBase}?name=${encodeURIComponent(assetName)}`;
  const upRes = await fetch(uploadUrl, {
    method: 'POST',
    headers: {
      ...headers,
      'Content-Type': contentType,
      'Content-Length': String(buffer.length)
    },
    body: buffer
  });

  if (!upRes.ok) {
    throw new Error(`Asset upload failed for ${assetName} (${upRes.status}): ${await upRes.text()}`);
  }
  return await upRes.json();
}

async function uploadJobVideoToCloud(jobId, { videosDir, thumbsDir, title = '', clientCountry = '', shareId = null, force = false } = {}) {
  const token = getLocalGitHubToken();
  if (!token) {
    return { ok: false, skipped: 'no_github_token' };
  }

  const resolvedShareId = shareId || computeShareHash(jobId);
  const videoPath = path.join(videosDir, `${jobId}.mp4`);
  if (!fs.existsSync(videoPath)) {
    return { ok: false, error: `Video file missing: ${videoPath}` };
  }

  const release = await ensureGitHubRelease(token);
  const existingNames = new Set((release.assets || []).map(a => a.name));

  const videoAsset = `${resolvedShareId}.mp4`;
  const thumbAsset = `${resolvedShareId}.jpg`;
  const metaAsset = `${resolvedShareId}.json`;

  let uploadedVideo = false;
  if (force || !existingNames.has(videoAsset)) {
    const videoBuf = fs.readFileSync(videoPath);
    await uploadReleaseAsset(token, release, videoAsset, videoBuf, 'video/mp4');
    uploadedVideo = true;
  }

  const specificThumb = path.join(thumbsDir, `${jobId}.jpg`);
  const fallbackThumb = path.join(thumbsDir, '2122421990107900101.jpg');
  const thumbPath = fs.existsSync(specificThumb) ? specificThumb : (fs.existsSync(fallbackThumb) ? fallbackThumb : null);
  let uploadedThumb = false;
  if (thumbPath && (force || !existingNames.has(thumbAsset))) {
    const thumbBuf = fs.readFileSync(thumbPath);
    await uploadReleaseAsset(token, release, thumbAsset, thumbBuf, 'image/jpeg');
    uploadedThumb = true;
  }

  let uploadedMeta = false;
  if (force || !existingNames.has(metaAsset)) {
    const metaPayload = {
      job_id: String(jobId),
      share_id: resolvedShareId,
      title: String(title || 'Quick Video for Your Project'),
      client_country: String(clientCountry || ''),
      uploaded_at: new Date().toISOString()
    };
    const metaBuf = Buffer.from(JSON.stringify(metaPayload, null, 2), 'utf8');
    await uploadReleaseAsset(token, release, metaAsset, metaBuf, 'application/json');
    uploadedMeta = true;
  }

  return {
    ok: true,
    job_id: String(jobId),
    share_id: resolvedShareId,
    uploadedVideo,
    uploadedThumb,
    uploadedMeta,
    video_cdn_url: `${CDN_BASE}/${videoAsset}`,
    thumb_cdn_url: `${CDN_BASE}/${thumbAsset}`
  };
}

function normalizeTokenCandidates(idOrToken) {
  const raw = String(idOrToken || '').trim();
  if (!raw || !/^[a-zA-Z0-9_~-]+$/.test(raw)) return [];
  const lower = raw.toLowerCase();
  if (/^[a-f0-9]{32}$/.test(lower)) {
    return [lower];
  }
  const cleanNumeric = raw.replace(/^~?02/, '');
  const set = new Set([computeShareHash(raw), computeShareHash(cleanNumeric), computeShareHash(`02${cleanNumeric}`)]);
  return Array.from(set);
}

async function resolveCloudVideoMeta(idOrToken) {
  const candidates = normalizeTokenCandidates(idOrToken);
  if (candidates.length === 0) return null;

  const now = Date.now();
  for (const shareId of candidates) {
    const cached = cloudMetaCache.get(shareId);
    if (cached && cached.expiresAt > now) {
      if (cached.meta) return cached.meta;
      continue;
    }

    try {
      const resp = await fetch(`${CDN_BASE}/${shareId}.json`, {
        redirect: 'follow',
        signal: AbortSignal.timeout(4000)
      });
      if (resp.ok) {
        const data = await resp.json();
        const meta = {
          job_id: String(data.job_id || shareId),
          share_id: shareId,
          title: String(data.title || 'Quick Video for Your Project'),
          client_country: String(data.client_country || ''),
          video_cdn_url: `${CDN_BASE}/${shareId}.mp4`,
          thumb_cdn_url: `${CDN_BASE}/${shareId}.jpg`,
          from_cloud: true
        };
        cloudMetaCache.set(shareId, { meta, expiresAt: now + META_TTL_HIT_MS });
        return meta;
      }
      cloudMetaCache.set(shareId, { meta: null, expiresAt: now + META_TTL_MISS_MS });
    } catch {
      // Do not cache transient network failures aggressively
    }
  }
  return null;
}

module.exports = {
  CDN_BASE,
  RELEASE_TAG,
  computeShareHash,
  getLocalGitHubToken,
  ensureGitHubRelease,
  uploadJobVideoToCloud,
  resolveCloudVideoMeta
};
