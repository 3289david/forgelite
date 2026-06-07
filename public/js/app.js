'use strict';

// ── Navbar dropdown: open on hover, close 1.5s after mouse leaves ────────────
const userMenu = document.querySelector('.nav-user-menu');
const navDropdown = document.querySelector('.nav-dropdown');
if (userMenu && navDropdown) {
  let hideTimer = null;

  userMenu.addEventListener('mouseenter', () => {
    clearTimeout(hideTimer);
    navDropdown.classList.add('open');
  });

  userMenu.addEventListener('mouseleave', () => {
    hideTimer = setTimeout(() => {
      navDropdown.classList.remove('open');
    }, 1500);
  });

  // Keep open when mouse re-enters dropdown itself
  navDropdown.addEventListener('mouseenter', () => {
    clearTimeout(hideTimer);
    navDropdown.classList.add('open');
  });

  navDropdown.addEventListener('mouseleave', () => {
    hideTimer = setTimeout(() => {
      navDropdown.classList.remove('open');
    }, 1500);
  });

  // Close immediately on click outside
  document.addEventListener('click', (e) => {
    if (!userMenu.contains(e.target)) {
      clearTimeout(hideTimer);
      navDropdown.classList.remove('open');
    }
  });
}

// ── Star button ───────────────────────────────────────────────────────────────
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
        const label = document.getElementById('star-label');
        const count = document.getElementById('star-count');
        if (label) label.textContent = starred ? 'Star' : 'Starred';
        if (count) count.textContent = String(parseInt(count.textContent || '0') + (starred ? -1 : 1));
      }
    } catch (e) { console.error(e); }
  });
}

// ── Auto-resize textareas ────────────────────────────────────────────────────
document.querySelectorAll('textarea').forEach(ta => {
  ta.addEventListener('input', () => {
    ta.style.height = 'auto';
    ta.style.height = ta.scrollHeight + 'px';
  });
});
