const fs = require('fs');
const path = require('path');
const simpleGit = require('simple-git');

// Inject PAT into HTTPS URL: https://github.com/owner/repo.git → https://x-access-token:PAT@github.com/owner/repo.git
function withPat(url, pat) {
  if (!pat) return url;
  try {
    const u = new URL(url);
    if (u.protocol !== 'https:') return url;
    u.username = 'x-access-token';
    u.password = pat;
    return u.toString();
  } catch {
    return url;
  }
}

// Clone the repo into destDir. If branch given, checkout it.
async function cloneRepo({ repoUrl, pat, branch }, destDir, onProgress) {
  fs.mkdirSync(destDir, { recursive: true });
  const url = withPat(repoUrl, pat);
  onProgress?.(`Cloning ${repoUrl}${branch ? ` (branch: ${branch})` : ''}...`);
  const git = simpleGit();
  const args = ['--depth', '1'];
  if (branch) args.push('--branch', branch);
  await git.clone(url, destDir, args);
  onProgress?.('Clone complete');
}

// Push the contents of srcDir to a destination repo.
// If repo has commits we force-push (replace history); destination must already exist (we don't auto-create on GitHub).
async function pushTo({ repoUrl, pat, branch }, srcDir, onProgress) {
  if (!fs.existsSync(srcDir)) throw new Error(`Source dir not found: ${srcDir}`);

  // Initialize a fresh git in the source dir (or reuse existing .git if present)
  const git = simpleGit({ baseDir: srcDir });
  const isRepo = await git.checkIsRepo().catch(() => false);
  if (!isRepo) {
    onProgress?.('Initializing git in extracted code...');
    await git.init();
  }

  // Ensure user is set (some operations need it)
  await git.addConfig('user.email', 'db-migrator@local');
  await git.addConfig('user.name', 'DB Migrator');

  // Stage everything and commit
  await git.add('.');
  const status = await git.status();
  if (status.files.length > 0) {
    onProgress?.(`Committing ${status.files.length} change(s)...`);
    await git.commit('Restored from backup via DB Migrator', { '--allow-empty': null });
  }

  // Set/replace remote
  const url = withPat(repoUrl, pat);
  const remotes = await git.getRemotes();
  if (remotes.find((r) => r.name === 'origin')) {
    await git.removeRemote('origin');
  }
  await git.addRemote('origin', url);

  const targetBranch = branch || 'main';
  // Make sure we're on the desired branch name
  try { await git.branch(['-M', targetBranch]); } catch {}

  onProgress?.(`Pushing to ${repoUrl} (branch ${targetBranch}, force)...`);
  await git.push(['-u', 'origin', targetBranch, '--force']);
  onProgress?.('Push complete');
}

module.exports = { cloneRepo, pushTo };
