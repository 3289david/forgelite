'use strict';

// Star button
const starBtn = document.getElementById('star-btn');
if (starBtn) {
  starBtn.addEventListener('click', async () => {
    const owner = starBtn.dataset.owner;
    const repo = starBtn.dataset.repo;
    const starred = starBtn.dataset.starred === '1';
    const method = starred ? 'DELETE' : 'POST';
    try {
      const res = await fetch(`/api/repos/${owner}/${repo}/star`, { method });
      if (res.ok) {
        starBtn.dataset.starred = starred ? '0' : '1';
        document.getElementById('star-label').textContent = starred ? 'Star' : 'Starred';
        const countEl = document.getElementById('star-count');
        if (countEl) countEl.textContent = String(parseInt(countEl.textContent || '0') + (starred ? -1 : 1));
      }
    } catch (e) { console.error(e); }
  });
}

// Follow button (uses JS fetch for profile page)
document.querySelectorAll('[data-follow]').forEach(btn => {
  btn.addEventListener('click', async () => {
    const username = btn.dataset.follow;
    const following = btn.dataset.following === '1';
    const method = following ? 'DELETE' : 'POST';
    try {
      const res = await fetch(`/api/users/${username}/follow`, { method });
      if (res.ok) {
        btn.dataset.following = following ? '0' : '1';
        btn.textContent = following ? 'Follow' : 'Unfollow';
      }
    } catch {}
  });
});

// Relative times — refresh once in a while is not needed (server-rendered)
// but add title attributes for full dates
document.querySelectorAll('[title-date]').forEach(el => {
  const d = new Date(el.getAttribute('title-date') || '');
  if (!isNaN(d.getTime())) el.title = d.toLocaleString();
});

// Auto-resize textareas
document.querySelectorAll('textarea').forEach(ta => {
  ta.addEventListener('input', () => {
    ta.style.height = 'auto';
    ta.style.height = ta.scrollHeight + 'px';
  });
});
