/**
 * Help Me Breathe — the stage.
 *
 * The page with a timer paints the stage's ground from the top of the page to
 * the bottom of the timer section, and three washes of the pattern's colour
 * drift behind the orb. CSS carries both (css/styles.css section 7); this
 * module only measures where the section sits so the ground can end exactly
 * at its bottom edge and the washes can reach up over the header and the
 * page title. Without it the CSS falls back to a one-screen band and washes
 * that start at the section — still correct, just less exact.
 *
 * It never touches the engine: no [data-role] element is read or written.
 */

const root = document.documentElement;

function stageElement() {
  if (document.body.classList.contains('render-body')) return null;
  if (document.querySelector('.timer-pair')) return null;
  return document.querySelector('.breathing-section[data-breathing-app], [data-breathing-app] .breathing-section');
}

function measure(section) {
  const rect = section.getBoundingClientRect();
  const top = Math.max(0, Math.round(rect.top + window.scrollY));
  root.style.setProperty('--stage-above', `${top}px`);
  root.style.setProperty('--stage-h', `${Math.round(top + rect.height)}px`);
}

function mount() {
  const section = stageElement();
  if (!section) {
    root.style.setProperty('--stage-h', '0px');
    return;
  }

  if (!section.querySelector(':scope > .air')) {
    const air = document.createElement('div');
    air.className = 'air';
    air.setAttribute('aria-hidden', 'true');
    air.append(document.createElement('i'), document.createElement('i'), document.createElement('i'));
    section.prepend(air);
  }

  let frame = 0;
  const update = () => {
    if (frame) return;
    frame = window.requestAnimationFrame(() => {
      frame = 0;
      measure(section);
    });
  };

  measure(section);
  window.addEventListener('resize', update);
  window.addEventListener('orientationchange', update);
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(update);
  if ('ResizeObserver' in window) {
    const observer = new ResizeObserver(update);
    observer.observe(document.body);
    observer.observe(section);
  }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', mount, { once: true });
} else {
  mount();
}
