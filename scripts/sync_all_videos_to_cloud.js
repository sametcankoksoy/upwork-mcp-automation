const fs = require('node:fs');
const path = require('node:path');
const { db } = require('../src/db');
const { getShareHash } = require('../src/auto-proposer');
const { uploadJobVideoToCloud, ensureGitHubRelease, getLocalGitHubToken } = require('../src/cloud-video-sync');

const videosDir = path.join(__dirname, '..', 'public', 'videos');
const thumbsDir = path.join(__dirname, '..', 'public', 'thumbnails');

async function main() {
  const token = getLocalGitHubToken();
  if (!token) {
    throw new Error('No GitHub token found via env or git credential fill.');
  }

  // Pre-create release once to avoid race conditions
  const release = await ensureGitHubRelease(token);
  console.log(`Using GitHub Release "${release.tag_name}" (existing assets: ${(release.assets || []).length})`);

  const files = fs.readdirSync(videosDir)
    .filter(f => f.endsWith('.mp4') && !/^(temp_|test_|benchmark_)/i.test(f));

  // Prioritize the 15 submitted proposals first, then remaining job videos
  const submittedSet = new Set(
    db.prepare(`SELECT job_id FROM auto_proposals WHERE status = 'submitted' OR job_id = '2123945236784931271'`)
      .all()
      .map(r => String(r.job_id).replace(/^~?02/, ''))
  );

  files.sort((a, b) => {
    const aSub = submittedSet.has(a.slice(0, -4).replace(/^~?02/, '')) ? 0 : 1;
    const bSub = submittedSet.has(b.slice(0, -4).replace(/^~?02/, '')) ? 0 : 1;
    return aSub - bSub;
  });

  console.log(`Syncing ${files.length} job videos to GitHub Release CDN...`);
  let done = 0;
  let failed = 0;

  for (const file of files) {
    const jobId = file.slice(0, -4);
    const cleanId = jobId.replace(/^~?02/, '');
    const job = db.prepare('SELECT title, client_country FROM jobs WHERE job_id = ? OR job_id = ? OR job_id = ?').get(jobId, cleanId, `02${cleanId}`);
    const prop = db.prepare('SELECT job_title, share_id FROM auto_proposals WHERE job_id = ? OR job_id = ? OR job_id = ?').get(jobId, cleanId, `02${cleanId}`);
    const shareId = prop?.share_id || getShareHash(jobId);
    const title = job?.title || prop?.job_title || 'Quick Video for Your Project';
    const clientCountry = job?.client_country || '';

    try {
      const res = await uploadJobVideoToCloud(jobId, {
        videosDir,
        thumbsDir,
        title,
        clientCountry,
        shareId
      });
      done++;
      console.log(`[${done}/${files.length}] ${jobId} -> share=${shareId} (vid=${res.uploadedVideo}, thumb=${res.uploadedThumb}, meta=${res.uploadedMeta})`);
    } catch (err) {
      failed++;
      console.error(`[FAIL] ${jobId}:`, err.message);
    }
  }

  console.log(`\nSync finished: ${done} succeeded, ${failed} failed.`);
}

main().catch(err => {
  console.error('Fatal sync error:', err);
  process.exit(1);
});
