(function () {
  const switcher  = document.getElementById('lang-switcher');
  const toggle    = document.getElementById('lang-toggle');
  const dropdown  = document.getElementById('lang-dropdown');

  if (!switcher) return;

  // Restaurer la position sauvegardée
  const saved = localStorage.getItem('langSwitcherPos');
  if (saved) {
    const { top, left } = JSON.parse(saved);
    switcher.style.top    = top;
    switcher.style.left   = left;
    switcher.style.bottom = 'auto';
    switcher.style.right  = 'auto';
  }

  let isDragging = false;
  let hasMoved   = false;
  let startX, startY, startLeft, startTop;

  toggle.addEventListener('mousedown', (e) => {
    e.preventDefault();
    isDragging = true;
    hasMoved   = false;
    startX     = e.clientX;
    startY     = e.clientY;
    startLeft  = switcher.getBoundingClientRect().left;
    startTop   = switcher.getBoundingClientRect().top;
  });

  document.addEventListener('mousemove', (e) => {
    if (!isDragging) return;
    const dx = e.clientX - startX;
    const dy = e.clientY - startY;
    if (Math.abs(dx) > 4 || Math.abs(dy) > 4) hasMoved = true;

    const newLeft = Math.max(0, Math.min(window.innerWidth  - switcher.offsetWidth,  startLeft + dx));
    const newTop  = Math.max(0, Math.min(window.innerHeight - switcher.offsetHeight, startTop  + dy));

    switcher.style.left   = newLeft + 'px';
    switcher.style.top    = newTop  + 'px';
    switcher.style.bottom = 'auto';
    switcher.style.right  = 'auto';
  });

  document.addEventListener('mouseup', () => {
    if (!isDragging) return;
    isDragging = false;

    if (!hasMoved) {
      dropdown.classList.toggle('visible');
    } else {
      // Sauvegarder la position
      localStorage.setItem('langSwitcherPos', JSON.stringify({
        top:  switcher.style.top,
        left: switcher.style.left
      }));
    }
  });

  // Fermer le dropdown en cliquant ailleurs
  document.addEventListener('click', (e) => {
    if (!switcher.contains(e.target)) {
      dropdown.classList.remove('visible');
    }
  });
})();
