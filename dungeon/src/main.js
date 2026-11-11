import Phaser from 'phaser';
import { BootScene } from './scenes/BootScene.js';
import { SummoningScene } from './scenes/SummoningScene.js';
import { DungeonHallScene } from './scenes/DungeonHallScene.js';
import { BattleScene } from './scenes/BattleScene.js';
import { VictoryScene } from './scenes/VictoryScene.js';
import { GateScene } from './scenes/GateScene.js';
import { bridge } from './utils/ws.js';
import { initKnightSprite } from './knight-sprite.js';
import { initActivityLog, addLog, showLoadingIndicator, hideLoadingIndicator, flushLogQueue } from './activity-log.js';
import { SFX } from './utils/sound-manager.js';
import { getDangerousBypassEnabled, getProfileKey, getSelectedRuntime } from './profile-config.js';

// Minimum 3x render scale ensures crisp text on 4K monitors.
// On a 4K display with 150% scaling (DPR 1.5), the base 800x600 canvas
// would be CSS-upscaled ~4x, making text blurry. At 3x, the canvas is
// 2400x1800, which closely matches the physical pixel count.
window.GAME_DPR = Math.max(window.devicePixelRatio || 1, 3);

let game = null;

// ── Abort & Return to Title ───────────────────
function returnToTitle() {
  bridge.cancelAll();
  if (game) {
    game.destroy(true);
    game = null;
  }
  document.getElementById('game-container').style.display = 'none';
  _fullBlackTransition('Ascending...', () => location.reload());
}

// Expose for Phaser scenes
window.returnToTitle = returnToTitle;

// Dev hook - lets you push a log line from the browser console for
// debugging or linkifier verification. Harmless in production.
window.addLog = addLog;
window.__seoDungeonFlushLogQueue = flushLogQueue;

function refreshGameLayout() {
  if (game?.scale?.refresh) {
    requestAnimationFrame(() => game?.scale?.refresh());
  }
}

function initResponsiveTitleStage() {
  const gameArea = document.getElementById('game-area');
  if (!gameArea) return;

  const updateTitleScale = () => {
    const rect = gameArea.getBoundingClientRect();
    const titleScale = Math.min(rect.width / 960, rect.height / 900);
    const characterScale = Math.min(rect.width / 900, rect.height / 820);
    const clampedTitle = Math.min(Math.max(titleScale, 0.62), 1.08);
    const clampedCharacters = Math.min(Math.max(characterScale, 0.58), 1.34);
    document.body.style.setProperty('--title-scale', clampedTitle.toFixed(3));
    document.body.style.setProperty('--character-scale', clampedCharacters.toFixed(3));
  };

  updateTitleScale();

  if ('ResizeObserver' in window) {
    const observer = new ResizeObserver(updateTitleScale);
    observer.observe(gameArea);
  } else {
    window.addEventListener('resize', updateTitleScale);
  }
}

function initLedgerControls() {
  const panel = document.getElementById('log-panel');
  const resizer = document.getElementById('ledger-resizer');
  const hideBtn = document.getElementById('ledger-toggle');
  const showBtn = document.getElementById('ledger-open-toggle');
  if (!panel || !resizer || !hideBtn || !showBtn) return;

  const WIDTH_KEY = 'seo_dungeon_ledger_width';
  const HIDDEN_KEY = 'seo_dungeon_ledger_hidden';

  const clampWidth = (value) => {
    const viewport = window.innerWidth || 1200;
    const minGameWidth = Math.min(640, Math.max(420, viewport * 0.42));
    const maxWidth = Math.max(280, Math.min(760, viewport - minGameWidth));
    return Math.round(Math.min(Math.max(value, 280), maxWidth));
  };

  let currentWidth = clampWidth(window.innerWidth * 0.3333);

  const applyWidth = (value, persist = true, refresh = true) => {
    const width = clampWidth(value);
    currentWidth = width;
    document.body.style.setProperty('--ledger-width', `${width}px`);
    if (persist) {
      try { localStorage.setItem(WIDTH_KEY, String(width)); } catch (_) {}
    }
    if (refresh) refreshGameLayout();
  };

  const setHidden = (hidden, captureVisibleWidth = true) => {
    if (hidden) {
      if (captureVisibleWidth) {
        const width = panel.getBoundingClientRect().width;
        if (width > 2) currentWidth = clampWidth(width);
      }
      document.body.classList.add('ledger-hidden');
    } else {
      document.body.classList.remove('ledger-hidden');
      applyWidth(currentWidth, false, false);
    }
    hideBtn.setAttribute('aria-expanded', String(!hidden));
    showBtn.setAttribute('aria-expanded', String(!hidden));
    try { localStorage.setItem(HIDDEN_KEY, hidden ? '1' : '0'); } catch (_) {}
    refreshGameLayout();
  };

  try {
    const savedWidth = parseInt(localStorage.getItem(WIDTH_KEY) || '', 10);
    if (Number.isFinite(savedWidth)) currentWidth = clampWidth(savedWidth);
    applyWidth(currentWidth, false, false);
    setHidden(localStorage.getItem(HIDDEN_KEY) === '1', false);
  } catch (_) {
    applyWidth(currentWidth, false, false);
    setHidden(false);
  }

  hideBtn.addEventListener('click', () => setHidden(true));
  showBtn.addEventListener('click', () => setHidden(false));

  let startX = 0;
  let startWidth = 0;
  let activePointerId = null;

  resizer.addEventListener('pointerdown', (event) => {
    if (document.body.classList.contains('ledger-hidden')) return;
    activePointerId = event.pointerId;
    startX = event.clientX;
    startWidth = panel.getBoundingClientRect().width;
    document.body.classList.add('ledger-resizing');
    resizer.setPointerCapture(event.pointerId);
    event.preventDefault();
  });

  resizer.addEventListener('pointermove', (event) => {
    if (activePointerId !== event.pointerId) return;
    applyWidth(startWidth + (startX - event.clientX), false);
  });

  const endResize = (event) => {
    if (activePointerId !== event.pointerId) return;
    activePointerId = null;
    document.body.classList.remove('ledger-resizing');
    try { resizer.releasePointerCapture(event.pointerId); } catch (_) {}
    const finalWidth = panel.getBoundingClientRect().width;
    if (finalWidth > 0) applyWidth(finalWidth, true);
  };

  resizer.addEventListener('pointerup', endResize);
  resizer.addEventListener('pointercancel', endResize);

  window.addEventListener('resize', () => {
    if (document.body.classList.contains('ledger-hidden')) return;
    applyWidth(currentWidth, false, false);
    refreshGameLayout();
  });
}

function initCompactionOverlay() {
  let overlay = document.getElementById('compaction-overlay');
  if (!overlay) {
    overlay = document.createElement('div');
    overlay.id = 'compaction-overlay';
    overlay.className = 'compaction-overlay';
    overlay.setAttribute('aria-hidden', 'true');
    overlay.innerHTML = `
      <div class="compaction-card" role="status" aria-live="polite">
        <div class="compaction-rune" aria-hidden="true">
          <span></span><span></span><span></span>
        </div>
        <div class="compaction-title">Compressing the Scroll</div>
        <div class="compaction-message">Preserving the trail before the hunt continues.</div>
        <div class="compaction-bar" aria-hidden="true"><span></span></div>
      </div>
    `;
    document.body.appendChild(overlay);
  }

  if (!document.getElementById('compaction-overlay-style')) {
    const style = document.createElement('style');
    style.id = 'compaction-overlay-style';
    style.textContent = `
      .compaction-overlay {
        position: fixed;
        inset: 0;
        z-index: 90000;
        display: grid;
        place-items: center;
        pointer-events: none;
        opacity: 0;
        visibility: hidden;
        background: rgba(2, 0, 2, 0.58);
        backdrop-filter: blur(5px) saturate(0.78);
        transition: opacity 180ms ease, visibility 180ms ease;
      }
      .compaction-overlay.open {
        opacity: 1;
        visibility: visible;
      }
      .compaction-card {
        width: min(520px, calc(100vw - 48px));
        border: 1px solid rgba(170, 16, 28, 0.78);
        background:
          radial-gradient(circle at 50% 0%, rgba(180, 0, 28, 0.2), transparent 58%),
          linear-gradient(180deg, rgba(18, 4, 8, 0.98), rgba(5, 3, 7, 0.98));
        box-shadow:
          0 0 54px rgba(130, 0, 22, 0.32),
          inset 0 0 34px rgba(0, 0, 0, 0.7);
        padding: 28px 32px 30px;
        text-align: center;
        font-family: 'JetBrains Mono', monospace;
      }
      .compaction-rune {
        height: 42px;
        display: flex;
        align-items: center;
        justify-content: center;
        gap: 22px;
        margin-bottom: 12px;
      }
      .compaction-rune span {
        width: 13px;
        height: 13px;
        border: 1px solid rgba(255, 45, 56, 0.86);
        transform: rotate(45deg);
        box-shadow: 0 0 14px rgba(255, 25, 45, 0.46);
        animation: compactionRune 1.7s ease-in-out infinite;
      }
      .compaction-rune span:nth-child(2) {
        width: 18px;
        height: 18px;
        border-color: rgba(244, 190, 62, 0.94);
        box-shadow: 0 0 18px rgba(244, 190, 62, 0.5);
        animation-delay: 160ms;
      }
      .compaction-rune span:nth-child(3) { animation-delay: 320ms; }
      .compaction-title {
        color: #f0c040;
        text-transform: uppercase;
        letter-spacing: 7px;
        font-size: 14px;
        font-weight: 800;
        margin-bottom: 13px;
        text-shadow: 0 0 18px rgba(240, 70, 40, 0.3);
      }
      .compaction-message {
        color: #c8bfa8;
        font-size: 13px;
        line-height: 1.55;
      }
      .compaction-bar {
        width: 100%;
        height: 4px;
        margin-top: 22px;
        overflow: hidden;
        background: rgba(255, 255, 255, 0.05);
      }
      .compaction-bar span {
        display: block;
        width: 38%;
        height: 100%;
        background: linear-gradient(90deg, transparent, #ff2b3d, #f0c040, transparent);
        animation: compactionBar 1.8s ease-in-out infinite;
      }
      .compaction-overlay.complete .compaction-card {
        border-color: rgba(212, 175, 55, 0.65);
      }
      @keyframes compactionRune {
        0%, 100% { opacity: 0.35; transform: rotate(45deg) scale(0.78); }
        50% { opacity: 1; transform: rotate(45deg) scale(1.16); }
      }
      @keyframes compactionBar {
        0% { transform: translateX(-115%); opacity: 0.4; }
        50% { opacity: 1; }
        100% { transform: translateX(265%); opacity: 0.4; }
      }
      @media (prefers-reduced-motion: reduce) {
        .compaction-overlay,
        .compaction-rune span,
        .compaction-bar span {
          animation: none !important;
          transition: none !important;
        }
      }
    `;
    document.head.appendChild(style);
  }

  const messageEl = overlay.querySelector('.compaction-message');
  let hideTimer = null;
  let active = false;

  const setMessage = (message) => {
    if (messageEl && message) messageEl.textContent = message;
  };

  const show = (message) => {
    active = true;
    if (hideTimer) clearTimeout(hideTimer);
    overlay.classList.remove('complete');
    setMessage(message || 'Preserving the trail before the hunt continues.');
    overlay.classList.add('open');
    overlay.setAttribute('aria-hidden', 'false');
  };

  const hide = (message) => {
    if (!active) return;
    active = false;
    overlay.classList.add('complete');
    setMessage(message || 'Context compaction complete. The hunt continues.');
    hideTimer = setTimeout(() => {
      overlay.classList.remove('open', 'complete');
      overlay.setAttribute('aria-hidden', 'true');
    }, 850);
  };

  window.addEventListener('seo-dungeon-agent-status', (event) => {
    const detail = event.detail || {};
    if (detail.kind !== 'compaction') return;
    if (detail.phase === 'complete') {
      addLog(detail.message || 'Context compaction complete.', { immediate: true });
      hide(detail.message);
      return;
    }
    addLog(detail.message || 'Compacting context...', { immediate: true });
    show(detail.message);
  });

  window.__seoDungeonCompactionOverlay = { show, hide };
}

// ── Bridge Connection ──────────────────────────
function _createDisconnectBanner() {
  if (document.getElementById('bridge-disconnect-banner')) return;
  const banner = document.createElement('div');
  banner.id = 'bridge-disconnect-banner';
  banner.innerHTML = '&#9888; BRIDGE SERVER DISCONNECTED - Run <code>npm start</code> in the dungeon/ directory';
  banner.style.cssText = `
    position: fixed; top: 0; left: 0; right: 0; z-index: 99999;
    background: linear-gradient(90deg, #8b0000, #cc2200, #8b0000);
    color: #fff; font-family: 'JetBrains Mono', monospace; font-size: 14px;
    font-weight: bold; text-align: center; padding: 10px 20px;
    letter-spacing: 1px; box-shadow: 0 2px 20px rgba(200, 0, 0, 0.6);
    animation: bannerPulse 2s ease-in-out infinite;
  `;
  if (!document.getElementById('banner-pulse-style')) {
    const s = document.createElement('style');
    s.id = 'banner-pulse-style';
    s.textContent = `
      @keyframes bannerPulse { 0%,100% { opacity: 1; } 50% { opacity: 0.8; } }
      #bridge-disconnect-banner code {
        background: rgba(0,0,0,0.3); padding: 2px 6px; border-radius: 3px; font-size: 13px;
      }
    `;
    document.head.appendChild(s);
  }
  document.body.appendChild(banner);
}

function _removeDisconnectBanner() {
  const banner = document.getElementById('bridge-disconnect-banner');
  if (banner) banner.remove();
}

async function connectBridge() {
  const status = document.getElementById('bridge-status');
  let hasObservedInitialStatus = false;

  // Listen for connection state changes globally
  bridge.onStatusChange((connected) => {
    if (!connected && !hasObservedInitialStatus) {
      hasObservedInitialStatus = true;
      return;
    }
    hasObservedInitialStatus = true;

    if (connected) {
      _removeDisconnectBanner();
      // Update title screen status if visible
      if (status) {
        status.textContent = 'Ready.';
        status.className = 'connected';
      }
    } else {
      _createDisconnectBanner();
      addLog('Bridge disconnected!');
      if (status) {
        status.textContent = 'Bridge disconnected - reconnecting...';
        status.className = 'error';
      }
    }
  });

  try {
    await bridge.connect();
    addLog('Ready to kill');
  } catch (err) {
    status.textContent = 'The dungeon is unreachable. Start the server.';
    status.className = 'error';
    addLog('Server offline');
  }
}

// ── Full Black Transition ──────────────────────────────
// True black overlay → label on black → fade out to next state.
// No blue tint, no jump cuts, fully opaque black between states.
function _fullBlackTransition(labelText, onComplete) {
  // Create a true black overlay that covers everything
  let overlay = document.getElementById('transition-overlay');
  if (!overlay) {
    overlay = document.createElement('div');
    overlay.id = 'transition-overlay';
    overlay.style.cssText = `
      position: fixed; inset: 0; z-index: 100000;
      background: #000; display: flex; align-items: center;
      justify-content: center; flex-direction: column; gap: 16px;
      opacity: 0; pointer-events: all;
      transition: opacity 0.6s ease-in-out;
    `;
    document.body.appendChild(overlay);
  }

  if (!document.getElementById('seal-spin-style')) {
    const s = document.createElement('style');
    s.id = 'seal-spin-style';
    s.textContent = '@keyframes sealSpin { to { transform: rotate(360deg); } }';
    document.head.appendChild(s);
  }

  // Phase 1: Fade overlay to black
  overlay.innerHTML = '';
  overlay.style.opacity = '0';
  requestAnimationFrame(() => {
    overlay.style.opacity = '1';
  });

  // Phase 2: Once fully black, show label + spinner
  setTimeout(() => {
    const spinner = document.createElement('div');
    spinner.style.cssText = `
      width: 28px; height: 28px; border-radius: 50%;
      border: 2px solid #1a1a30; border-top-color: #d4af37;
      animation: sealSpin 0.7s linear infinite;
    `;
    const label = document.createElement('div');
    label.textContent = labelText;
    label.style.cssText = `
      font-family: 'JetBrains Mono', monospace;
      font-size: 13px; color: #606078; letter-spacing: 2px;
      opacity: 0; transition: opacity 0.4s ease-out;
    `;
    overlay.appendChild(spinner);
    overlay.appendChild(label);

    // Fade label in gently
    requestAnimationFrame(() => { label.style.opacity = '1'; });

    // Phase 3: Hold, then fire callback behind the black overlay
    setTimeout(() => {
      onComplete();

      // Phase 4: Fade overlay away to reveal new content
      setTimeout(() => {
        overlay.style.opacity = '0';
        setTimeout(() => overlay.remove(), 650);
      }, 300);
    }, 1400);
  }, 650);
}

// ── Seal Your Fate Transition (descend into dungeon) ──
function _sealTransition(onComplete) {
  const titleScreen = document.getElementById('title-screen');

  // 1. Stagger-fade all title screen elements
  const elements = [
    titleScreen.querySelector('.tagline'),
    titleScreen.querySelector('#danger-mode-toggle'),
    titleScreen.querySelector('#descend-btn'),
    titleScreen.querySelector('#bridge-status'),
    ...titleScreen.querySelectorAll('.form-group'),
    titleScreen.querySelector('.subtitle'),
    titleScreen.querySelector('h1'),
  ].filter(Boolean);

  const charOptions = titleScreen.querySelectorAll('.char-option');

  elements.forEach((el, i) => {
    el.style.transition = `opacity 0.25s ease-in ${i * 0.06}s, transform 0.3s ease-in ${i * 0.06}s`;
    el.style.opacity = '0';
    el.style.transform = 'scale(0.95) translateY(8px)';
  });

  charOptions.forEach((el, i) => {
    el.style.transition = `opacity 0.4s ease-in ${0.2 + i * 0.08}s, transform 0.4s ease-in ${0.2 + i * 0.08}s`;
    el.style.opacity = '0';
    el.style.transform = 'scale(0.8)';
  });

  // 2. After elements fade, do the full black transition
  setTimeout(() => {
    _fullBlackTransition('Descending...', onComplete);
  }, 700);
}

// ── Launch Game ────────────────────────────────
function launchGame(domain, projectPath) {
  document.getElementById('title-screen').style.display = 'none';
  document.getElementById('game-container').style.display = 'block';
  document.getElementById('sfx-control').style.display = 'none';

  addLog(`Hunting: ${domain}`);
  addLog(`Source: ${projectPath}`);
  addLog(`CLI: ${getSelectedRuntime().toUpperCase()}`);
  if (getSelectedRuntime() === 'codex') {
    addLog(`Codex mode: ${getDangerousBypassEnabled() ? 'YOLO bypass' : 'standard sandbox'}`);
  }

  const dpr = window.GAME_DPR;
  const config = {
    type: Phaser.AUTO,
    parent: 'game-container',
    width: Math.round(800 * dpr),
    height: Math.round(600 * dpr),
    pixelArt: false,
    roundPixels: false,
    backgroundColor: '#0a0a1a',
    scale: {
      mode: Phaser.Scale.FIT,
      autoCenter: Phaser.Scale.CENTER_BOTH
    },
    scene: [BootScene, GateScene, SummoningScene, DungeonHallScene, BattleScene, VictoryScene]
  };

  game = new Phaser.Game(config);
  window.__seoDungeonGame = game;
  game.dpr = dpr;
  game.domain = domain;
  game.projectPath = projectPath;
  game.characterConfig = window.selectedCharacter
    ? { ...window.selectedCharacter, runtime: getSelectedRuntime(), dangerousBypass: getDangerousBypassEnabled() }
    : null;
  game.addLog = addLog;
  game.showLoading = showLoadingIndicator;
  game.hideLoading = hideLoadingIndicator;
}

// ── Quest timer: visibility-aware pause/resume ─────────────
// When the user Alt-Tabs, minimizes, closes the lid, or switches tabs,
// we stop counting toward "TIME IN THE DARK" on the final ledger.
// Resumes as soon as the tab is visible again. One listener, lives as
// long as the page. DungeonHall stamps the start; Summoning resets on
// a new audit; the final victory sequence reads the accumulated total.
document.addEventListener('visibilitychange', () => {
  if (!game || game._questStartMs == null) return;
  if (document.visibilityState === 'hidden') {
    // Bank the visible session so far
    if (game._questVisibleSince) {
      game._questActiveMs = (game._questActiveMs || 0) + (Date.now() - game._questVisibleSince);
      game._questVisibleSince = null;
    }
  } else if (document.visibilityState === 'visible') {
    // Start a new visible session
    game._questVisibleSince = Date.now();
  }
});

// ── Title Screen Events ────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  // Init animated systems
  initResponsiveTitleStage();
  initLedgerControls();
  initCompactionOverlay();
  initActivityLog();
  initKnightSprite();

  addLog('Waiting');

  // ── SFX Volume Control ─────────────────────
  const sfxToggle = document.getElementById('sfx-toggle');
  const sfxVolume = document.getElementById('sfx-volume');
  let sfxMuted = false;
  let sfxPrevVol = SFX.getVolume();

  // Load saved preference
  try {
    const saved = localStorage.getItem('sfx_volume');
    if (saved !== null) {
      const v = parseFloat(saved);
      SFX.setVolume(v);
      sfxVolume.value = Math.round(v * 100);
      if (v === 0) { sfxMuted = true; sfxToggle.classList.add('muted'); sfxToggle.textContent = '\uD83D\uDD07'; }
    }
  } catch (_) {}

  sfxVolume.addEventListener('input', () => {
    const v = parseInt(sfxVolume.value) / 100;
    SFX.setVolume(v);
    sfxMuted = v === 0;
    sfxToggle.classList.toggle('muted', sfxMuted);
    sfxToggle.textContent = sfxMuted ? '\uD83D\uDD07' : '\uD83D\uDD0A';
    sfxPrevVol = v || sfxPrevVol;
    try { localStorage.setItem('sfx_volume', String(v)); } catch (_) {}
  });

  sfxToggle.addEventListener('click', () => {
    sfxMuted = !sfxMuted;
    if (sfxMuted) {
      sfxPrevVol = SFX.getVolume() || sfxPrevVol || 0.35;
      SFX.setVolume(0);
      sfxVolume.value = 0;
      sfxToggle.textContent = '\uD83D\uDD07';
    } else {
      SFX.setVolume(sfxPrevVol);
      sfxVolume.value = Math.round(sfxPrevVol * 100);
      sfxToggle.textContent = '\uD83D\uDD0A';
    }
    sfxToggle.classList.toggle('muted', sfxMuted);
    try { localStorage.setItem('sfx_volume', String(SFX.getVolume())); } catch (_) {}
  });

  const domainInput = document.getElementById('domain-input');
  const pathInput = document.getElementById('path-input');
  const openDomainBtn = document.getElementById('open-domain-btn');
  const openFolderBtn = document.getElementById('open-folder-btn');
  const btn = document.getElementById('descend-btn');
  const errorArea = document.getElementById('validation-errors');

  // Remember the last domain + project folder the user descended with,
  // so they don't have to retype them every launch. Keys are namespaced
  // so they don't collide with the audit cache.
  const LS_DOMAIN_KEY = 'seo_dungeon_last_domain';
  const LS_PATH_KEY = 'seo_dungeon_last_path';
  try {
    const savedDomain = localStorage.getItem(LS_DOMAIN_KEY);
    const savedPath = localStorage.getItem(LS_PATH_KEY);
    if (savedDomain && savedDomain.trim()) domainInput.value = savedDomain;
    if (savedPath && savedPath.trim()) {
      pathInput.value = savedPath;
    }
  } catch (_) { /* localStorage blocked or unavailable - use HTML defaults */ }

  const persistTitleInputs = () => {
    try {
      const domain = domainInput.value.trim();
      const projectPath = pathInput.value.trim();
      if (domain) localStorage.setItem(LS_DOMAIN_KEY, domain);
      else localStorage.removeItem(LS_DOMAIN_KEY);
      if (projectPath) localStorage.setItem(LS_PATH_KEY, projectPath);
      else localStorage.removeItem(LS_PATH_KEY);
    } catch (_) {}
  };

  // ── Validation helpers ──────────────────────
  function cleanDomain(raw) {
    let d = raw.trim();
    d = d.replace(/^https?:\/\//i, '');
    d = d.replace(/\/+$/, '');
    return d;
  }

  function isDomainValid(raw) {
    if (!raw.trim()) return false;
    try {
      normalizeWebsiteUrl(raw);
      return true;
    } catch (_) {
      return false;
    }
  }

  function isPathValid(raw) {
    return raw.trim().length > 0;
  }

  function normalizeWebsiteUrl(raw) {
    const trimmed = raw.trim();
    const withProtocol = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
    const url = new URL(withProtocol);
    if (!/^https?:$/i.test(url.protocol) || !url.hostname.includes('.')) {
      throw new Error('Invalid website URL');
    }
    return url.href;
  }

  function openWebsiteUrl(url) {
    if (!openDomainBtn) return false;
    openDomainBtn.href = url;
    return true;
  }

  function setAnchorButtonDisabled(anchor, disabled) {
    if (!anchor) return;
    anchor.setAttribute('aria-disabled', disabled ? 'true' : 'false');
    anchor.tabIndex = disabled ? -1 : 0;
  }

  function updateButtonState() {
    const domainOk = isDomainValid(domainInput.value);
    const pathOk = isPathValid(pathInput.value);
    const yoloOk = getSelectedRuntime() !== 'codex' || getDangerousBypassEnabled();
    btn.disabled = !(domainOk && pathOk && yoloOk && bridge.connected);
    if (openDomainBtn) {
      setAnchorButtonDisabled(openDomainBtn, !domainOk);
      if (domainOk) {
        try { openDomainBtn.href = normalizeWebsiteUrl(domainInput.value); } catch (_) {}
      } else {
        openDomainBtn.removeAttribute('href');
      }
    }
    if (openFolderBtn) openFolderBtn.disabled = !bridge.connected;
    if (domainOk && pathOk) {
      errorArea.textContent = yoloOk && !bridge.connected ? 'Bridge server not connected' : '';
    }
  }

  // Re-check button state when bridge connection changes
  bridge.onStatusChange(() => updateButtonState());
  window.addEventListener('seo-dungeon-dangerous-bypass-change', () => updateButtonState());
  window.addEventListener('seo-dungeon-runtime-change', () => updateButtonState());

  // ── Live validation on input ────────────────
  domainInput.addEventListener('input', () => {
    const val = domainInput.value.trim();
    if (val.length === 0) {
      domainInput.classList.remove('valid', 'invalid');
    } else if (isDomainValid(val)) {
      domainInput.classList.add('valid');
      domainInput.classList.remove('invalid');
    } else {
      domainInput.classList.add('invalid');
      domainInput.classList.remove('valid');
    }
    persistTitleInputs();
    updateButtonState();
  });

  pathInput.addEventListener('input', () => {
    const val = pathInput.value.trim();
    if (val.length === 0) {
      pathInput.classList.remove('valid', 'invalid');
    } else {
      pathInput.classList.add('valid');
      pathInput.classList.remove('invalid');
    }
    persistTitleInputs();
    updateButtonState();
  });

  openDomainBtn?.addEventListener('click', (event) => {
    const raw = domainInput.value.trim();
    if (!isDomainValid(raw)) {
      event.preventDefault();
      return;
    }
    let url;
    try {
      url = normalizeWebsiteUrl(raw);
    } catch (_) {
      event.preventDefault();
      addLog('Invalid website URL.');
      return;
    }
    persistTitleInputs();
    openWebsiteUrl(url);
    addLog(`Opening website: ${url}`);
  });

  openFolderBtn?.addEventListener('click', async () => {
    const projectPath = pathInput.value.trim();
    persistTitleInputs();
    if (!bridge.connected) {
      addLog('Bridge not connected.');
      return;
    }
    openFolderBtn.disabled = true;
    try {
      addLog(projectPath ? `Opening folder: ${projectPath}` : 'Choosing project folder...');
      const result = await bridge.openFolder(projectPath);
      const folderPath = String(result?.data?.path || projectPath).trim();
      const displayPath = folderPath.replace(/\\/g, '/');
      if (result?.data?.action === 'selected') {
        if (projectPath) addLog('Saved folder was unavailable; chose a new project folder.');
        pathInput.value = folderPath;
        pathInput.classList.add('valid');
        pathInput.classList.remove('invalid');
        persistTitleInputs();
        addLog(`Selected folder: ${displayPath}`);
      } else {
        addLog(`Opened folder: ${displayPath}`);
      }
    } catch (err) {
      addLog(`Could not open folder: ${err.message || 'unknown error'}`);
    } finally {
      updateButtonState();
    }
  });

  // Show red border when user leaves an empty path field
  pathInput.addEventListener('blur', () => {
    if (pathInput.value.trim().length === 0) {
      pathInput.classList.add('invalid');
      pathInput.classList.remove('valid');
    }
  });

  // Show red border when user leaves domain with no dot
  domainInput.addEventListener('blur', () => {
    const val = domainInput.value.trim();
    if (val.length > 0 && !isDomainValid(val)) {
      domainInput.classList.add('invalid');
      domainInput.classList.remove('valid');
    } else if (val.length === 0) {
      domainInput.classList.remove('valid', 'invalid');
    }
  });

  // ── Launch with validation ──────────────────
  const launch = () => {
    const errors = [];
    if (!isDomainValid(domainInput.value)) {
      errors.push('Enter a valid domain');
      domainInput.classList.add('invalid');
      domainInput.classList.remove('valid');
    }
    if (!isPathValid(pathInput.value)) {
      errors.push('Project folder is required');
      pathInput.classList.add('invalid');
      pathInput.classList.remove('valid');
    }
    if (getSelectedRuntime() === 'codex' && !getDangerousBypassEnabled()) {
      errors.push('Arm YOLO Mode');
    }
    if (errors.length > 0) {
      errorArea.textContent = errors.join(' · ');
      return;
    }
    errorArea.textContent = '';
    btn.disabled = true;
    SFX.play('menuConfirm');
    const domain = cleanDomain(domainInput.value);
    const path = pathInput.value.trim();
    // Persist the successful inputs so next launch restores them.
    try {
      localStorage.setItem(LS_DOMAIN_KEY, domain);
      localStorage.setItem(LS_PATH_KEY, path);
    } catch (_) { /* ignore quota or disabled storage */ }
    _sealTransition(() => launchGame(domain, path));
  };

  const remoteCharacterForIntent = (detail = {}) => {
    const requested = String(detail.character || '').trim().toLowerCase();
    if (['warrior', 'samurai', 'knight'].includes(requested)) return requested;
    const profile = getProfileKey(detail.profile || detail.model);
    if (profile === 'deep') return 'warrior';
    if (profile === 'fast') return 'knight';
    return 'samurai';
  };

  const remoteBoolean = (value, fallback = false) => {
    if (value == null) return fallback;
    if (value === true || value === 1) return true;
    if (value === false || value === 0) return false;
    return ['1', 'true', 'yes', 'on', 'yolo', 'danger'].includes(String(value).trim().toLowerCase());
  };

  const applyRemoteTitleSetup = (detail = {}) => {
    const runtime = String(detail.runtime || 'codex').trim().toLowerCase() || 'codex';
    if (runtime !== 'codex') {
      throw new Error('Remote UI intents are Codex-only in this release.');
    }
    const runtimeButton = document.querySelector('.runtime-option[data-runtime="codex"]');
    if (runtimeButton && runtimeButton.getAttribute('aria-pressed') !== 'true') runtimeButton.click();

    if (detail.domain != null) {
      domainInput.value = String(detail.domain || '').trim();
      domainInput.dispatchEvent(new Event('input', { bubbles: true }));
    }
    if (detail.projectPath != null) {
      pathInput.value = String(detail.projectPath || '').trim();
      pathInput.dispatchEvent(new Event('input', { bubbles: true }));
    }

    const characterKey = remoteCharacterForIntent(detail);
    const characterCard = document.querySelector(`.char-option[data-char="${characterKey}"]`);
    if (characterCard && !characterCard.classList.contains('selected')) characterCard.click();

    const wantsDangerousBypass = remoteBoolean(detail.dangerousBypass, true);
    const dangerButton = document.getElementById('danger-mode-toggle');
    if (dangerButton && getDangerousBypassEnabled() !== wantsDangerousBypass) dangerButton.click();

    updateButtonState();
  };

  const remoteMetadataValue = (detail = {}, key, fallback = null) => {
    if (detail[key] != null) return detail[key];
    if (detail.metadata && typeof detail.metadata === 'object' && detail.metadata[key] != null) {
      return detail.metadata[key];
    }
    return fallback;
  };

  const remoteIntentText = (detail = {}) => {
    for (const value of [
      detail.command,
      remoteMetadataValue(detail, 'prompt'),
      remoteMetadataValue(detail, 'text'),
      detail.message,
    ]) {
      const clean = String(value || '').trim();
      if (clean) return clean;
    }
    return '';
  };

  const activeDungeonSceneName = () => {
    if (!game?.scene) return 'title';
    for (const sceneName of ['Battle', 'DungeonHall', 'Gate', 'Summoning', 'Victory', 'Boot']) {
      try {
        if (game.scene.isActive(sceneName)) return sceneName;
      } catch (_) {}
    }
    return 'game';
  };

  const getActiveDungeonScene = (sceneName) => {
    if (!game?.scene) return null;
    try {
      if (!game.scene.isActive(sceneName)) return null;
      return game.scene.getScene(sceneName);
    } catch (_) {
      return null;
    }
  };

  const publishRemoteUiResult = (detail = {}, status = 'complete', message = '', metadataOverrides = {}) => {
    const metadata = {
      ...(detail.metadata && typeof detail.metadata === 'object' ? detail.metadata : {}),
      scene: metadataOverrides.scene || 'title',
      intentSource: detail.source || 'controller',
      requestedAction: detail.action || 'setup',
      ...metadataOverrides,
    };
    const characterConfig = game?.characterConfig || window.selectedCharacter || {};
    bridge.publishSessionEvent({
      kind: 'ui-result',
      source: 'guild-ledger',
      targetId: detail.eventId || detail.commandId || undefined,
      status,
      action: detail.action || 'setup',
      message,
      domain: game?.domain || cleanDomain(domainInput.value || ''),
      projectPath: game?.projectPath || pathInput.value.trim(),
      runtime: characterConfig.runtime || getSelectedRuntime(),
      profile: characterConfig.profile || characterConfig.model || window.selectedCharacter?.profile || window.selectedCharacter?.model,
      character: characterConfig.name || window.selectedCharacter?.name,
      dangerousBypass: characterConfig.dangerousBypass ?? getDangerousBypassEnabled(),
      metadata,
    }).catch(() => {});
  };

  const handleRemoteGateIntent = (detail, action) => {
    const gateScene = getActiveDungeonScene('Gate');
    if (!gateScene) throw new Error('Gate scene is not active.');

    if (['gate-resume', 'resume', 'continue'].includes(action)) {
      gateScene.resumeCachedQuest();
      publishRemoteUiResult(detail, 'complete', 'Remote gate resume intent accepted.', { scene: 'Gate' });
      return true;
    }

    if (['gate-new-audit', 'gate-rerun', 'new-audit', 'rerun'].includes(action)) {
      gateScene.startFreshQuest();
      publishRemoteUiResult(detail, 'complete', 'Remote gate new-audit intent accepted.', { scene: 'Gate' });
      return true;
    }

    if (['gate-title', 'gate-return', 'return-title'].includes(action)) {
      gateScene.returnToTitleScreen();
      publishRemoteUiResult(detail, 'complete', 'Remote gate return intent accepted.', { scene: 'Gate' });
      return true;
    }

    throw new Error(`Unsupported Gate intent action: ${action}`);
  };

  const handleRemoteHallIntent = (detail, action) => {
    const hallScene = getActiveDungeonScene('DungeonHall');
    if (!hallScene) throw new Error('Dungeon Hall scene is not active.');
    if (!['hall-select-issue', 'select-issue', 'hall-battle', 'battle-issue'].includes(action)) {
      throw new Error(`Unsupported Dungeon Hall intent action: ${action}`);
    }

    const issue = hallScene.findIssueForIntent({
      issueId: remoteMetadataValue(detail, 'issueId'),
      issueIndex: remoteMetadataValue(detail, 'issueIndex', remoteMetadataValue(detail, 'index')),
      issueNumber: remoteMetadataValue(detail, 'issueNumber'),
      titleContains: remoteMetadataValue(detail, 'titleContains', remoteMetadataValue(detail, 'title')),
      severity: remoteMetadataValue(detail, 'severity'),
    });
    if (!issue) throw new Error('No matching Dungeon Hall issue was found.');
    const accepted = hallScene.startBattleForIssue(issue);
    if (!accepted) throw new Error('Dungeon Hall is already starting a battle.');
    const issueIndex = Array.isArray(hallScene.issues) ? hallScene.issues.indexOf(issue) : -1;
    publishRemoteUiResult(detail, 'complete', 'Remote Dungeon Hall issue selection accepted.', {
      scene: 'DungeonHall',
      issueId: issue.id,
      issueIndex,
      issueTitle: issue.title,
      severity: issue.severity,
    });
    return true;
  };

  const handleRemoteUiIntent = async (detail = {}) => {
    const action = String(detail.action || 'setup').trim().toLowerCase() || 'setup';
    try {
      if (action.startsWith('gate-') || ['resume', 'continue', 'new-audit', 'rerun', 'return-title'].includes(action)) {
        return handleRemoteGateIntent(detail, action);
      }
      if (action.startsWith('hall-') || ['select-issue', 'battle-issue'].includes(action)) {
        return handleRemoteHallIntent(detail, action);
      }
      if (action.startsWith('battle-')) {
        return handleRemoteBattleIntent(detail, action);
      }
      if (action.startsWith('queue-') || ['agent-stop', 'stop'].includes(action)) {
        return handleRemoteQueueIntent(detail, action);
      }
      if (!['setup', 'configure', 'launch', 'start', 'enter'].includes(action)) {
        throw new Error(`Unsupported UI intent action: ${action}`);
      }
      applyRemoteTitleSetup(detail);
      const isLaunch = ['launch', 'start', 'enter'].includes(action);
      addLog(isLaunch
        ? `Remote ${detail.source || 'controller'}: launching SEO Dungeon`
        : `Remote ${detail.source || 'controller'}: configured title screen`, { immediate: true });
      if (isLaunch) {
        if (btn.disabled) {
          throw new Error(errorArea.textContent || 'Title screen is not ready to launch.');
        }
        btn.click();
      }
      publishRemoteUiResult(detail, 'complete', isLaunch ? 'Remote launch intent accepted.' : 'Remote setup intent applied.', { scene: 'title' });
      return true;
    } catch (err) {
      const message = err.message || 'Remote UI intent failed.';
      addLog(`Remote UI intent failed: ${message}`, { immediate: true });
      publishRemoteUiResult(detail, 'error', message, { scene: activeDungeonSceneName() });
      return false;
    }
  };

  btn.addEventListener('click', launch);
  btn.addEventListener('mouseenter', () => { if (!btn.disabled) SFX.play('menuHover'); });
  domainInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') launch(); });
  pathInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') launch(); });

  // Set initial validation state from pre-filled values
  updateButtonState();
  if (domainInput.value.trim() && isDomainValid(domainInput.value)) {
    domainInput.classList.add('valid');
  }
  if (pathInput.value.trim()) {
    pathInput.classList.add('valid');
  }

  connectBridge();
  setTimeout(() => domainInput.focus(), 300);

  // ── Ledger Terminal (one-shot Codex turns) ─────
  const logInput = document.getElementById('log-input');
  const logInputBar = document.getElementById('log-input-bar');
  const promptQueuePanel = document.getElementById('prompt-queue-panel');
  const promptQueueTitle = document.getElementById('prompt-queue-title');
  const promptQueueList = document.getElementById('prompt-queue-list');
  const logSubmit = document.getElementById('log-submit');
  const logStop = document.getElementById('log-stop');
  const promptQueueSteer = document.getElementById('prompt-queue-steer');
  const promptQueueClear = document.getElementById('prompt-queue-clear');
  const promptEditModal = document.getElementById('prompt-edit-modal');
  const promptEditText = document.getElementById('prompt-edit-text');
  const promptEditSave = document.getElementById('prompt-edit-save');
  const promptEditCancel = document.getElementById('prompt-edit-cancel');
  const promptEditRemove = document.getElementById('prompt-edit-remove');
  const remoteStatus = document.getElementById('ledger-remote-status');
  const remoteStatusLabel = remoteStatus?.querySelector('.ledger-remote-label');
  const remoteStatusIcon = remoteStatus?.querySelector('.ledger-remote-icon');
  let lastEscTime = 0;
  let ledgerRunning = false;
  let promptQueueId = 0;
  let queueDrainTimer = null;
  let queueHold = false;
  const suppressedDrainIds = new Set();
  let selectedPromptId = null;
  let editingPromptId = null;
  let draggedPromptId = null;
  let steeringPromptId = null;
  let remoteStatusTimer = null;
  let lastRemoteCommandId = null;
  const promptQueue = [];
  const handledSessionEventIds = new Set();

  window.__seoDungeonDialogueState = () => ({
    queue: promptQueue.map((item) => ({ id: item.id, text: item.text, source: item.commandOptions?.source || 'guild-ledger' })),
    queueHold,
    hasQueueDrainTimer: Boolean(queueDrainTimer),
    selectedPromptId,
    steeringPromptId,
    ledgerRunning,
    busy: isAgentBusy(),
    remoteStatus: remoteStatus?.hidden ? 'hidden' : remoteStatusLabel?.textContent || 'Remote',
  });

  const setRemoteStatus = (mode = 'idle', label = 'Remote', title = '', icon = '↗') => {
    if (!remoteStatus) return;
    remoteStatus.classList.remove('remote-running', 'remote-queued', 'remote-done', 'remote-error');
    if (mode === 'idle') {
      remoteStatus.hidden = true;
      return;
    }
    remoteStatus.hidden = false;
    remoteStatus.classList.add(mode);
    if (remoteStatusLabel) remoteStatusLabel.textContent = label;
    if (remoteStatusIcon) remoteStatusIcon.textContent = icon;
    const accessible = title || label;
    remoteStatus.title = accessible;
    remoteStatus.setAttribute('aria-label', accessible);
  };

  const settleRemoteStatus = (mode, label, title, delay = 4200, icon = '↗') => {
    setRemoteStatus(mode, label, title, icon);
    if (remoteStatusTimer) clearTimeout(remoteStatusTimer);
    remoteStatusTimer = setTimeout(() => {
      remoteStatusTimer = null;
      setRemoteStatus('idle');
    }, delay);
  };

  const updateRemoteStatusFromSession = (detail = {}) => {
    if (detail.kind === 'remote-command') {
      lastRemoteCommandId = detail.commandId || detail.eventId || lastRemoteCommandId;
      if (remoteStatusTimer) {
        clearTimeout(remoteStatusTimer);
        remoteStatusTimer = null;
      }
      setRemoteStatus('remote-running', 'Remote', `Remote command from ${detail.source || 'controller'}`, '↗');
      return;
    }
    if (detail.kind === 'ledger-command') {
      const source = detail.source || 'guild-ledger';
      if (source === 'guild-ledger') setRemoteStatus('idle');
      return;
    }
    if (detail.kind === 'ledger-result') {
      const isRemote = detail.commandId && detail.commandId === lastRemoteCommandId;
      if (!isRemote && detail.source === 'guild-ledger') return;
      if (detail.status === 'error') {
        settleRemoteStatus('remote-error', 'Remote', detail.message || 'Remote command failed', 4200, '!');
      } else {
        settleRemoteStatus('remote-done', 'Done', detail.message || 'Remote command complete', 2200);
      }
      return;
    }
    if (detail.kind === 'codex-state') {
      const status = String(detail.status || '').toLowerCase();
      if (/error|fail/.test(status)) settleRemoteStatus('remote-error', 'Remote', detail.message || 'Codex state error', 4200, '!');
      else if (/done|complete|idle/.test(status)) settleRemoteStatus('remote-done', 'Done', detail.message || 'Codex state complete', 2200);
      else setRemoteStatus('remote-running', 'Remote', detail.message || 'Codex controller connected', '↗');
    }
  };

  const rememberSessionEvent = (event) => {
    const id = event?.eventId || event?.commandId;
    if (!id) return false;
    if (handledSessionEventIds.has(id)) return true;
    handledSessionEventIds.add(id);
    if (handledSessionEventIds.size > 500) {
      const oldest = handledSessionEventIds.values().next().value;
      handledSessionEventIds.delete(oldest);
    }
    return false;
  };

  const commandHasTerminalResult = (events, commandId) => {
    if (!commandId) return false;
    return events.some((event) =>
      event?.kind === 'ledger-result' &&
      event.commandId === commandId &&
      ['complete', 'completed', 'done', 'error', 'failed', 'cancelled', 'canceled', 'interrupted']
        .includes(String(event.status || '').toLowerCase())
    );
  };

  const handleRemoteCommandEvent = async (detail = {}) => {
    updateRemoteStatusFromSession(detail);
    if (rememberSessionEvent(detail)) return false;
    const text = String(detail.command || '').trim();
    if (!text) return false;
    try {
      const claim = await bridge.claimRemoteCommand(detail.commandId || detail.eventId);
      if (claim?.data?.claimed !== true) return false;
    } catch (err) {
      addLog('Could not claim remote command: ' + (err.message || 'unknown'));
      return false;
    }
    const commandOptions = {
      source: detail.source || 'remote-controller',
      mirror: false,
      commandId: detail.commandId || detail.eventId || null,
      projectPathOverride: detail.projectPath || null,
      profileOverride: detail.profile || null,
      runtimeOverride: detail.runtime || 'codex',
      dangerousBypassOverride: detail.dangerousBypass,
    };
    addLog(`Remote ${detail.source || 'controller'}: ${truncatePrompt(text)}`, { immediate: true });
    if (isAgentBusy()) {
      enqueuePrompt(text, { commandOptions });
      setRemoteStatus('remote-queued', 'Queued', `Remote command queued from ${detail.source || 'controller'}`, '↗');
      return true;
    }
    executeLedgerCommand(text, commandOptions);
    return true;
  };

  const replayRemoteCommandsFromSession = async () => {
    if (!bridge.connected || replayRemoteCommandsFromSession.running) return;
    replayRemoteCommandsFromSession.running = true;
    try {
      const response = await bridge.sessionState();
      const events = Array.isArray(response?.data?.events) ? response.data.events : [];
      const claimed = new Set(response?.data?.claimedCommandIds || []);
      const pending = events
        .filter((event) => event?.kind === 'remote-command')
        .filter((event) => {
          const commandId = event.commandId || event.eventId;
          return commandId &&
            !claimed.has(commandId) &&
            !commandHasTerminalResult(events, commandId);
        })
        .sort((a, b) => (a.sequence || 0) - (b.sequence || 0));
      for (const event of pending) {
        await handleRemoteCommandEvent(event);
      }
    } catch (err) {
      addLog('Could not replay remote session state: ' + (err.message || 'unknown'));
    } finally {
      replayRemoteCommandsFromSession.running = false;
    }
  };

  let interactiveTimeout = null;
  let lastStreamTime = 0;
  const WATCHDOG_MS = Math.max(50, Number(window.__SEO_DUNGEON_WATCHDOG_MS || 30000));

  const resetLoadingState = () => {
    ledgerRunning = false;
    logInputBar.classList.remove('running');
    hideLoadingIndicator();
    if (interactiveTimeout) { clearTimeout(interactiveTimeout); interactiveTimeout = null; }
    renderPromptQueue();
    updatePromptControls();
  };

  const hasActiveBridgeRequest = () => Boolean(
    bridge.activeLedgerId ||
    bridge.activeAuditId ||
    bridge.activeFixId ||
    bridge.activeCommitId
  );

  // Watchdog: if no stream data arrives for 30s, settle only when the bridge
  // no longer owns an active request. Otherwise keep the running affordances
  // visible and check again so the UI never looks idle while prompts still
  // queue or steer against a live turn.
  const startWatchdog = () => {
    if (interactiveTimeout) clearTimeout(interactiveTimeout);
    interactiveTimeout = setTimeout(() => {
      if (ledgerRunning) {
        if (hasActiveBridgeRequest() || isBattleBusy()) {
          logInputBar.classList.add('running');
          showLoadingIndicator();
          updatePromptControls();
          startWatchdog();
          return;
        }
        resetLoadingState();
        scheduleQueueDrain();
      }
    }, WATCHDOG_MS);
  };

  const truncatePrompt = (text, max = 120) => {
    const clean = String(text || '').replace(/\s+/g, ' ').trim();
    return clean.length > max ? `${clean.slice(0, max - 1)}...` : clean;
  };

  const getBattleScene = () => {
    if (!game) return null;
    const battleScene = game.scene.getScene('Battle');
    if (!battleScene || !battleScene.scene?.isActive()) return null;
    return battleScene;
  };

  const isBattleBusy = () => {
    const battleScene = getBattleScene();
    return Boolean(
      battleScene &&
      !battleScene.battleOver &&
      (!battleScene.isPlayerTurn || battleScene._activeRequestId)
    );
  };

  const isAgentBusy = () => Boolean(
    ledgerRunning ||
    hasActiveBridgeRequest() ||
    isBattleBusy()
  );

  const hasSteerableTurn = () => hasActiveBridgeRequest();

  function findPromptIndex(id) {
    return promptQueue.findIndex((entry) => entry.id === id);
  }

  function ensurePromptSelection() {
    if (promptQueue.length === 0) {
      selectedPromptId = null;
      return;
    }
    if (findPromptIndex(selectedPromptId) < 0) {
      selectedPromptId = promptQueue[0].id;
    }
  }

  function removeQueuedPrompt(id) {
    if (id === steeringPromptId) return null;
    const idx = findPromptIndex(id);
    if (idx < 0) return null;
    const [removed] = promptQueue.splice(idx, 1);
    if (selectedPromptId === id) {
      selectedPromptId = promptQueue[idx]?.id || promptQueue[idx - 1]?.id || promptQueue[0]?.id || null;
    }
    renderPromptQueue();
    updatePromptControls();
    return removed;
  }

  function renderPromptQueue() {
    const hasQueue = promptQueue.length > 0;
    const busy = isAgentBusy();
    ensurePromptSelection();
    promptQueuePanel?.classList.toggle('open', hasQueue);
    promptQueuePanel?.classList.toggle('running', busy && hasQueue);
    promptQueuePanel?.classList.toggle('holding', queueHold && hasQueue);
    promptQueuePanel?.classList.toggle('steering', steeringPromptId != null && hasQueue);
    if (promptQueueTitle) {
      promptQueueTitle.textContent = queueHold && hasQueue
        ? 'Held'
        : hasQueue
          ? (hasSteerableTurn() ? 'Ready to steer' : 'Waiting to send')
          : 'Queued';
    }
    logInputBar?.classList.toggle('agent-busy', busy);
    if (!promptQueueList) return;
    promptQueueList.innerHTML = '';

    promptQueue.forEach((item, index) => {
      const isSelected = item.id === selectedPromptId;
      const isSteering = item.id === steeringPromptId;
      const row = document.createElement('div');
      row.className = `prompt-queue-item${isSelected ? ' selected' : ''}${isSteering ? ' steering' : ''}`;
      row.title = isSteering
        ? 'Steering this prompt into the active turn.'
        : 'Click to select. Double-click to edit. Drag to reorder.';
      row.dataset.id = String(item.id);
      row.draggable = !isSteering;
      row.tabIndex = 0;
      row.setAttribute('role', 'button');
      row.setAttribute('aria-selected', isSelected ? 'true' : 'false');
      if (isSteering) row.setAttribute('aria-busy', 'true');

      const rank = document.createElement('span');
      rank.className = 'prompt-queue-rank';
      rank.textContent = String(index + 1).padStart(2, '0');

      const text = document.createElement('span');
      text.className = 'prompt-queue-text';
      text.textContent = truncatePrompt(item.text, 180);

      const actions = document.createElement('span');
      actions.className = 'prompt-queue-row-actions';

      const edit = document.createElement('button');
      edit.type = 'button';
      edit.className = 'prompt-queue-edit';
      edit.textContent = 'Edit';
      edit.title = 'Edit queued prompt';
      edit.disabled = isSteering;
      edit.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        selectedPromptId = item.id;
        renderPromptQueue();
        openPromptEditor(item.id);
      });

      const remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'prompt-queue-remove';
      remove.textContent = '×';
      remove.title = 'Remove queued prompt';
      remove.setAttribute('aria-label', 'Remove queued prompt');
      remove.disabled = isSteering;
      remove.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        removeQueuedPrompt(item.id);
      });

      actions.append(edit, remove);
      row.append(rank, text, actions);
      row.addEventListener('click', () => {
        selectedPromptId = item.id;
        renderPromptQueue();
        updatePromptControls();
      });
      row.addEventListener('dblclick', () => openPromptEditor(item.id));
      row.addEventListener('keydown', (event) => {
        if (isSteering) return;
        if (event.key === 'Enter') {
          event.preventDefault();
          selectedPromptId = item.id;
          steerSelectedPrompt();
        } else if (event.key.toLowerCase() === 'e') {
          event.preventDefault();
          openPromptEditor(item.id);
        } else if (event.key === 'Delete' || event.key === 'Backspace') {
          event.preventDefault();
          removeQueuedPrompt(item.id);
        }
      });
      row.addEventListener('dragstart', (event) => {
        if (isSteering) {
          event.preventDefault();
          return;
        }
        draggedPromptId = item.id;
        selectedPromptId = item.id;
        row.classList.add('dragging');
        event.dataTransfer.effectAllowed = 'move';
        event.dataTransfer.setData('text/plain', String(item.id));
      });
      row.addEventListener('dragover', (event) => {
        event.preventDefault();
        if (draggedPromptId && draggedPromptId !== item.id) row.classList.add('drag-over');
      });
      row.addEventListener('dragleave', () => row.classList.remove('drag-over'));
      row.addEventListener('drop', (event) => {
        event.preventDefault();
        row.classList.remove('drag-over');
        reorderPrompt(draggedPromptId, item.id);
      });
      row.addEventListener('dragend', () => {
        draggedPromptId = null;
        row.classList.remove('dragging', 'drag-over');
      });

      promptQueueList.appendChild(row);
    });
  }

  function updatePromptControls() {
    ensurePromptSelection();
    const busy = isAgentBusy();
    const hasText = Boolean(logInput?.value?.trim());
    logInputBar?.classList.toggle('has-text', hasText);
    if (logSubmit) {
      logSubmit.disabled = !hasText;
      logSubmit.textContent = busy ? '↵' : '↑';
      logSubmit.title = busy ? 'Queue prompt' : 'Send prompt';
      logSubmit.setAttribute('aria-label', busy ? 'Queue prompt' : 'Send prompt');
    }
    if (logStop) logStop.disabled = !busy;
    if (promptQueueSteer) {
      const shouldSteer = hasSteerableTurn();
      const waitingToSend = !shouldSteer && busy;
      const actionLabel = shouldSteer ? 'Steer' : 'Send';
      const steerUnsupported = shouldSteer && bridge.supportsSteer === false;
      promptQueueSteer.disabled = promptQueue.length === 0 ||
        selectedPromptId == null ||
        steeringPromptId != null ||
        steerUnsupported ||
        waitingToSend;
      promptQueueSteer.textContent = actionLabel;
      promptQueueSteer.title = steerUnsupported
        ? 'Restart the Legends SEO Dungeon bridge to enable live steering'
        : waitingToSend
          ? 'Wait for the current turn to settle before sending queued prompt'
          : shouldSteer
            ? 'Steer selected prompt into active turn'
            : 'Send selected queued prompt';
      promptQueueSteer.setAttribute('aria-label', promptQueueSteer.title);
    }
    if (promptQueueClear) promptQueueClear.disabled = promptQueue.length === 0 || steeringPromptId != null;
  }

  function enqueuePrompt(text, { front = false, commandOptions = null } = {}) {
    const clean = String(text || '').trim();
    if (!clean) return;
    if (queueDrainTimer) {
      clearTimeout(queueDrainTimer);
      queueDrainTimer = null;
    }
    const item = { id: ++promptQueueId, text: clean, createdAt: Date.now(), commandOptions };
    if (front) promptQueue.unshift(item);
    else promptQueue.push(item);
    selectedPromptId = item.id;
    renderPromptQueue();
    updatePromptControls();
  }

  function reorderPrompt(draggedId, targetId) {
    if (!draggedId || !targetId || draggedId === targetId) return;
    if (draggedId === steeringPromptId || targetId === steeringPromptId) return;
    const from = findPromptIndex(draggedId);
    const to = findPromptIndex(targetId);
    if (from < 0 || to < 0) return;
    const [item] = promptQueue.splice(from, 1);
    const adjustedTo = from < to ? to - 1 : to;
    promptQueue.splice(adjustedTo, 0, item);
    selectedPromptId = item.id;
    renderPromptQueue();
    updatePromptControls();
  }

  function openPromptEditor(id) {
    const idx = findPromptIndex(id);
    if (idx < 0 || !promptEditModal || !promptEditText) return;
    editingPromptId = id;
    promptEditText.value = promptQueue[idx].text;
    promptEditModal.classList.add('open');
    promptEditModal.setAttribute('aria-hidden', 'false');
    setTimeout(() => {
      promptEditText.focus();
      promptEditText.setSelectionRange(promptEditText.value.length, promptEditText.value.length);
    }, 50);
  }

  function closePromptEditor() {
    editingPromptId = null;
    promptEditModal?.classList.remove('open');
    promptEditModal?.setAttribute('aria-hidden', 'true');
  }

  function savePromptEditor() {
    const idx = findPromptIndex(editingPromptId);
    if (idx < 0 || !promptEditText) {
      closePromptEditor();
      return;
    }
    const clean = promptEditText.value.trim();
    if (!clean) {
      removeQueuedPrompt(editingPromptId);
      closePromptEditor();
      return;
    }
    promptQueue[idx].text = clean;
    selectedPromptId = promptQueue[idx].id;
    closePromptEditor();
    renderPromptQueue();
    updatePromptControls();
  }

  function cancelActiveBridgeRequests() {
    const cancelledIds = [];
    const ids = [
      bridge.activeLedgerId,
      bridge.activeAuditId,
      bridge.activeFixId,
      bridge.activeCommitId,
      bridge.activeNarrationId
    ].filter(Boolean);
    for (const id of ids) {
      bridge.cancel(id);
      cancelledIds.push(id);
    }
    const battleScene = getBattleScene();
    if (battleScene?._activeRequestId) {
      bridge.cancel(battleScene._activeRequestId);
      cancelledIds.push(battleScene._activeRequestId);
    }
    return cancelledIds;
  }

  function stopActiveAgent({ announce = true, holdQueue = true } = {}) {
    const hadBusyState = isAgentBusy();
    queueHold = holdQueue && promptQueue.length > 0;
    if (queueHold && queueDrainTimer) {
      clearTimeout(queueDrainTimer);
      queueDrainTimer = null;
    }
    const cancelledIds = cancelActiveBridgeRequests();
    cancelledIds.forEach((id) => suppressedDrainIds.add(id));
    flushLogQueue();
    if (hadBusyState || cancelledIds.length > 0 || ledgerRunning) {
      resetLoadingState();
      if (announce) addLog(queueHold ? 'Stopped. Queue held.' : 'Stopped.', { immediate: true });
    } else if (announce) {
      addLog('Nothing active to stop.', { immediate: true });
    }
    renderPromptQueue();
    updatePromptControls();
  }

  async function steerSelectedPrompt() {
    if (steeringPromptId != null) return;
    ensurePromptSelection();
    const idx = findPromptIndex(selectedPromptId);
    if (idx < 0) return;
    const selected = promptQueue[idx];
    const wasHeld = queueHold;
    if (hasSteerableTurn()) {
      steeringPromptId = selected.id;
      renderPromptQueue();
      updatePromptControls();
      try {
        await bridge.steer(selected.text);
        const currentIdx = findPromptIndex(selected.id);
        if (currentIdx >= 0) {
          promptQueue.splice(currentIdx, 1);
          selectedPromptId = promptQueue[currentIdx]?.id || promptQueue[currentIdx - 1]?.id || promptQueue[0]?.id || null;
        }
        queueHold = wasHeld && promptQueue.length > 0;
        addLog('> ' + selected.text, { immediate: true });
      } catch (err) {
        const message = String(err.message || 'unknown');
        if (findPromptIndex(selected.id) < 0) {
          promptQueue.splice(Math.min(idx, promptQueue.length), 0, selected);
        }
        selectedPromptId = selected.id;
        queueHold = wasHeld && promptQueue.length > 0;
        addLog('Could not steer active turn: ' + message + '. Prompt kept in queue.');
      } finally {
        steeringPromptId = null;
      }
      renderPromptQueue();
      updatePromptControls();
      return;
    }
    if (isAgentBusy()) {
      renderPromptQueue();
      updatePromptControls();
      return;
    }
    promptQueue.splice(idx, 1);
    queueHold = wasHeld && promptQueue.length > 0;
    selectedPromptId = promptQueue[0]?.id || null;
    renderPromptQueue();
    updatePromptControls();
    executeLedgerCommand(selected.text, {
      ...(selected.commandOptions || {}),
      fromQueue: true,
      preserveQueueHold: queueHold,
    });
  }

  function clearPromptQueue() {
    if (steeringPromptId != null) throw new Error('Cannot clear the queue while a prompt is being steered.');
    const cleared = promptQueue.length;
    promptQueue.splice(0, promptQueue.length);
    selectedPromptId = null;
    queueHold = false;
    renderPromptQueue();
    updatePromptControls();
    return cleared;
  }

  function selectQueuedPromptForIntent(detail = {}) {
    if (!promptQueue.length) return null;
    const promptId = remoteMetadataValue(detail, 'promptId', remoteMetadataValue(detail, 'queueId'));
    if (promptId != null && String(promptId).trim()) {
      const match = promptQueue.find((item) => String(item.id) === String(promptId).trim());
      if (match) {
        selectedPromptId = match.id;
        renderPromptQueue();
        updatePromptControls();
        return match;
      }
    }

    const promptIndex = remoteMetadataValue(detail, 'promptIndex', remoteMetadataValue(detail, 'index'));
    if (promptIndex != null && String(promptIndex).trim() !== '') {
      const index = Number(promptIndex);
      if (Number.isInteger(index) && index >= 0 && index < promptQueue.length) {
        selectedPromptId = promptQueue[index].id;
        renderPromptQueue();
        updatePromptControls();
        return promptQueue[index];
      }
    }

    const promptText = remoteMetadataValue(detail, 'textContains', remoteMetadataValue(detail, 'promptContains'));
    if (promptText != null && String(promptText).trim()) {
      const wanted = String(promptText).trim().toLowerCase();
      const match = promptQueue.find((item) => item.text.toLowerCase().includes(wanted));
      if (match) {
        selectedPromptId = match.id;
        renderPromptQueue();
        updatePromptControls();
        return match;
      }
    }

    ensurePromptSelection();
    return promptQueue[findPromptIndex(selectedPromptId)] || null;
  }

  function queueIntentMetadata(extra = {}) {
    return {
      scene: activeDungeonSceneName(),
      queueLength: promptQueue.length,
      queueHold,
      selectedPromptId: selectedPromptId ?? '',
      busy: isAgentBusy(),
      ...extra,
    };
  }

  function battleIntentMetadata(battleScene, extra = {}) {
    return {
      scene: 'Battle',
      issueId: battleScene?.issue?.id ?? '',
      issueTitle: battleScene?.issue?.title ?? '',
      playerTurn: battleScene?.isPlayerTurn === true,
      battleOver: battleScene?.battleOver === true,
      overlayOpen: Boolean(battleScene?._attackOverlayOpen || document.getElementById('attack-prompt-overlay')),
      ...extra,
    };
  }

  function ensureDungeonHallAfterRemoteVanquish(battleScene) {
    const startHall = () => {
      if (!game?.scene || game.scene.isActive('DungeonHall')) return;
      const data = {
        domain: game.domain,
        projectPath: game.projectPath,
      };
      try {
        game.scene.start('DungeonHall', data);
        if (game.scene.isActive('DungeonHall')) return;
      } catch (_) {}
      try {
        game.scene.launch('DungeonHall', data);
        if (game.scene.isActive('DungeonHall')) return;
      } catch (_) {}
      try { game.scene.run('DungeonHall', data); } catch (_) {}
      try {
        const hall = game.scene.getScene('DungeonHall');
        hall?.scene?.setVisible?.(true);
        hall?.scene?.setActive?.(true);
      } catch (_) {}
    };
    window.setTimeout(() => {
      if (battleScene?.issue?.defeated) startHall();
    }, 1200);
    window.setTimeout(() => {
      if (battleScene?.issue?.defeated) startHall();
    }, 7000);
  }

  function requireRemoteBattleScene() {
    const battleScene = getBattleScene();
    if (!battleScene) throw new Error('Battle scene is not active.');
    if (battleScene.battleOver) throw new Error('Battle is already over.');
    return battleScene;
  }

  function assertBattlePlayerTurn(battleScene) {
    if (!battleScene.isPlayerTurn) throw new Error('Battle is not ready for a player action.');
  }

  function handleRemoteBattleIntent(detail, action) {
    const battleScene = requireRemoteBattleScene();

    if (action === 'battle-open-attack-prompt') {
      assertBattlePlayerTurn(battleScene);
      if (!battleScene._attackOverlayOpen && !document.getElementById('attack-prompt-overlay')) {
        battleScene.showAttackPrompt();
      }
      publishRemoteUiResult(detail, 'complete', 'Remote battle attack prompt intent accepted.', battleIntentMetadata(battleScene));
      return true;
    }

    if (action === 'battle-attack') {
      assertBattlePlayerTurn(battleScene);
      const text = remoteIntentText(detail);
      if (!text) throw new Error('battle-attack requires prompt text in command, message, or metadata.');
      if (battleScene._attackOverlayOpen || document.getElementById('attack-prompt-overlay')) {
        battleScene._removeAttackOverlay?.();
      }
      executeLedgerCommand(text, {
        source: detail.source || 'codex-cli',
        mirror: false,
        commandId: detail.eventId || detail.commandId || null,
        projectPathOverride: detail.projectPath || game?.projectPath || null,
        profileOverride: detail.profile || game?.characterConfig?.profile || game?.characterConfig?.model || null,
        runtimeOverride: detail.runtime || game?.characterConfig?.runtime || 'codex',
        dangerousBypassOverride: detail.dangerousBypass,
      });
      publishRemoteUiResult(detail, 'complete', 'Remote battle attack intent accepted.', battleIntentMetadata(battleScene, {
        promptLength: text.length,
      }));
      return true;
    }

    if (action === 'battle-vanquish') {
      assertBattlePlayerTurn(battleScene);
      if (battleScene._attackOverlayOpen || document.getElementById('attack-prompt-overlay')) {
        battleScene._removeAttackOverlay?.();
      }
      if (typeof battleScene.remoteVanquish === 'function') battleScene.remoteVanquish();
      else battleScene.doVanquish();
      ensureDungeonHallAfterRemoteVanquish(battleScene);
      publishRemoteUiResult(detail, 'complete', 'Remote battle vanquish intent accepted.', battleIntentMetadata(battleScene));
      return true;
    }

    throw new Error(`Unsupported Battle intent action: ${action}`);
  }

  async function handleRemoteQueueIntent(detail, action) {
    if (action === 'queue-add') {
      const text = remoteIntentText(detail);
      if (!text) throw new Error('queue-add requires prompt text in command, message, or metadata.');
      const front = remoteBoolean(remoteMetadataValue(detail, 'front'), false);
      enqueuePrompt(text, {
        front,
        commandOptions: {
          source: detail.source || 'codex-cli',
          mirror: false,
          commandId: detail.eventId || detail.commandId || null,
          projectPathOverride: detail.projectPath || game?.projectPath || null,
          profileOverride: detail.profile || game?.characterConfig?.profile || game?.characterConfig?.model || null,
          runtimeOverride: detail.runtime || game?.characterConfig?.runtime || 'codex',
          dangerousBypassOverride: detail.dangerousBypass,
        },
      });
      if (remoteMetadataValue(detail, 'hold') != null) {
        queueHold = remoteBoolean(remoteMetadataValue(detail, 'hold'), queueHold);
        renderPromptQueue();
        updatePromptControls();
      }
      publishRemoteUiResult(detail, 'complete', 'Remote queue-add intent accepted.', queueIntentMetadata({
        promptLength: text.length,
      }));
      return true;
    }

    if (action === 'queue-steer') {
      const selected = selectQueuedPromptForIntent(detail);
      if (!selected) throw new Error('No queued prompt is available to steer.');
      if (isAgentBusy() && !hasSteerableTurn()) {
        throw new Error('The active turn cannot be steered right now.');
      }
      await steerSelectedPrompt();
      publishRemoteUiResult(detail, 'complete', 'Remote queue-steer intent accepted.', queueIntentMetadata({
        steeredPrompt: selected.text,
      }));
      return true;
    }

    if (action === 'agent-stop' || action === 'stop') {
      stopActiveAgent({
        announce: remoteBoolean(remoteMetadataValue(detail, 'announce'), true),
        holdQueue: remoteBoolean(remoteMetadataValue(detail, 'holdQueue'), true),
      });
      publishRemoteUiResult(detail, 'complete', 'Remote agent-stop intent accepted.', queueIntentMetadata());
      return true;
    }

    if (action === 'queue-clear') {
      const cleared = clearPromptQueue();
      publishRemoteUiResult(detail, 'complete', 'Remote queue-clear intent accepted.', queueIntentMetadata({ cleared }));
      return true;
    }

    throw new Error(`Unsupported queue intent action: ${action}`);
  }

  function scheduleQueueDrain() {
    if (queueDrainTimer) clearTimeout(queueDrainTimer);
    queueDrainTimer = setTimeout(() => {
      queueDrainTimer = null;
      drainPromptQueue();
    }, 900);
  }

  function drainPromptQueue() {
    updatePromptControls();
    if (!promptQueue.length || queueHold || steeringPromptId != null || isAgentBusy() || !bridge.connected) {
      renderPromptQueue();
      return;
    }
    const item = promptQueue.shift();
    if (selectedPromptId === item.id) selectedPromptId = promptQueue[0]?.id || null;
    renderPromptQueue();
    executeLedgerCommand(item.text, {
      ...(item.commandOptions || {}),
      fromQueue: true,
    });
  }

  function clearInput() {
    logInput.value = '';
    logInput.style.height = 'auto';
    logInput.style.overflowY = 'hidden';
    autoResize();
    updatePromptControls();
  }

  const publishLedgerCommand = (payload) => {
    bridge.publishSessionEvent({
      kind: 'ledger-command',
      source: payload.source || 'guild-ledger',
      commandId: payload.commandId || undefined,
      command: payload.text,
      projectPath: payload.projectPath,
      runtime: payload.runtime,
      profile: payload.profile,
      dangerousBypass: payload.dangerousBypass,
    }).catch((err) => {
      addLog('Session mirror unavailable: ' + (err.message || 'unknown'));
    });
  };

  const executeLedgerCommand = (text, {
    fromQueue = false,
    preserveQueueHold = false,
    source = 'guild-ledger',
    mirror = true,
    commandId = null,
    projectPathOverride = null,
    profileOverride = null,
    runtimeOverride = null,
    dangerousBypassOverride = undefined,
  } = {}) => {
    if (!text.trim()) return;
    const commandOptions = {
      source,
      mirror,
      commandId,
      projectPathOverride,
      profileOverride,
      runtimeOverride,
      dangerousBypassOverride,
    };
    if (queueDrainTimer) {
      clearTimeout(queueDrainTimer);
      queueDrainTimer = null;
    }
    if (!bridge.connected) {
      addLog('Bridge not connected. Prompt kept in queue.');
      enqueuePrompt(text, { front: fromQueue, commandOptions });
      return;
    }

    const projectPath = projectPathOverride || document.getElementById('path-input')?.value?.trim() || '.';
    const profile = getProfileKey(profileOverride || window.selectedCharacter?.profile || window.selectedCharacter?.model);
    const runtime = runtimeOverride || window.selectedCharacter?.runtime || getSelectedRuntime();
    const dangerousBypass = dangerousBypassOverride ?? window.selectedCharacter?.dangerousBypass ?? getDangerousBypassEnabled();

    if (mirror) {
      publishLedgerCommand({
        text,
        source,
        commandId,
        projectPath,
        runtime,
        profile,
        dangerousBypass,
      });
    }

    // If we're in a battle, route through doAttack so everything is synchronized
    const battleScene = getBattleScene();
    if (battleScene && battleScene.isPlayerTurn && !battleScene.battleOver) {
      Promise.resolve(battleScene.doAttack(text)).finally(() => {
        updatePromptControls();
        scheduleQueueDrain();
      });
      return;
    }

    // Outside battle - neutral chat. Pass-through to Codex in the user's
    // project dir. No demon anchoring; the user can ask anything.
    if (fromQueue && !preserveQueueHold) queueHold = false;
    logInputBar.classList.add('running');
    showLoadingIndicator();
    addLog('> ' + text, { immediate: true });
    showLoadingIndicator();
    ledgerRunning = true;
    renderPromptQueue();
    updatePromptControls();
    lastStreamTime = Date.now();
    startWatchdog();

    let ledgerRequestId = null;
    let completedNormally = false;

    (async () => {
      try {
        const pendingResult = bridge.chat(text, projectPath, profile, runtime, (chunk) => {
          lastStreamTime = Date.now();
          if (interactiveTimeout) clearTimeout(interactiveTimeout);
          startWatchdog();
          const clean = chunk.replace(/[\n\r]+/g, ' ').trim();
          if (clean.length > 0) addLog(clean);
        }, {
          dangerousBypass,
          commandId,
          source,
        });
        ledgerRequestId = bridge.activeLedgerId;
        const result = await pendingResult;
        completedNormally = true;
        bridge.publishSessionEvent({
          kind: 'ledger-result',
          source,
          commandId: commandId || undefined,
          status: 'complete',
          message: result?.data?.summary || 'Ledger command completed.',
          projectPath,
          runtime,
          profile,
        }).catch(() => {});
        if (result?.data?.summary) addLog(result.data.summary);
      } catch (err) {
        if (err.message !== 'Cancelled by user') {
          bridge.publishSessionEvent({
            kind: 'ledger-result',
            source,
            commandId: commandId || undefined,
            status: 'error',
            message: err.message || 'unknown',
            projectPath,
            runtime,
            profile,
          }).catch(() => {});
          addLog('Error: ' + (err.message || 'unknown'));
          if (fromQueue) enqueuePrompt(text, { front: true, commandOptions });
        }
      } finally {
        flushLogQueue();
        resetLoadingState();
        if (completedNormally && (!promptQueue.length || queueHold)) {
          SFX.play('ledgerReady');
        }
        if (ledgerRequestId && suppressedDrainIds.delete(ledgerRequestId)) {
          renderPromptQueue();
          updatePromptControls();
        } else {
          scheduleQueueDrain();
        }
      }
    })();
  };

  const submitLedgerInput = () => {
    const text = logInput.value.trim();
    if (!text) return;
    clearInput();
    if (isAgentBusy()) {
      enqueuePrompt(text);
      return;
    }
    executeLedgerCommand(text);
  };

  window.addEventListener('seo-dungeon-session-event', async (event) => {
    const detail = event.detail || {};
    if (detail.kind === 'ui-intent') {
      await handleRemoteUiIntent(detail);
      return;
    }
    if (detail.kind === 'remote-command') {
      await handleRemoteCommandEvent(detail);
      return;
    }
    updateRemoteStatusFromSession(detail);
    rememberSessionEvent(detail);
  });

  // Auto-resize textarea as user types - push log content up
  const logContent = document.getElementById('log-content');
  const getMaxLogInputHeight = () => Math.min(400, Math.max(120, Math.floor(window.innerHeight * 0.5) - 28));
  const autoResize = () => {
    const maxInputHeight = getMaxLogInputHeight();
    logInput.style.height = 'auto';
    logInput.style.height = Math.min(logInput.scrollHeight, maxInputHeight) + 'px';
    logInput.style.overflowY = logInput.scrollHeight > maxInputHeight ? 'auto' : 'hidden';
    // Keep log scrolled to bottom as input grows
    if (logContent) logContent.scrollTop = logContent.scrollHeight;
  };
  const syncComposerControls = () => {
    autoResize();
    updatePromptControls();
  };
  const scheduleComposerSync = () => requestAnimationFrame(syncComposerControls);
  ['input', 'change', 'keyup', 'paste', 'compositionend', 'focus'].forEach((eventName) => {
    logInput.addEventListener(eventName, scheduleComposerSync);
  });
  let lastComposerValue = logInput.value;
  setInterval(() => {
    const currentValue = logInput.value;
    const hasText = Boolean(currentValue.trim());
    const classMatches = logInputBar?.classList.contains('has-text') === hasText;
    if (currentValue !== lastComposerValue || !classMatches) {
      lastComposerValue = currentValue;
      syncComposerControls();
    }
  }, 150);
  window.addEventListener('resize', autoResize);
  syncComposerControls();
  renderPromptQueue();
  updatePromptControls();

  logInput.addEventListener('keydown', (e) => {
    if (e.key === 'Tab' && !e.shiftKey && logInput.value.trim() && isAgentBusy()) {
      e.preventDefault();
      submitLedgerInput();
      autoResize();
      return;
    }
    // Enter submits, Shift+Enter adds newline
    if (e.key === 'Enter' && !e.shiftKey && logInput.value.trim()) {
      e.preventDefault();
      submitLedgerInput();
      autoResize();
    }
    if (e.key === 'Escape') {
      e.stopPropagation();
      const now = Date.now();
      if (now - lastEscTime < 500 && isAgentBusy()) {
        stopActiveAgent({ announce: true });
      }
      lastEscTime = now;
    }
  });

  logStop?.addEventListener('click', () => stopActiveAgent());
  logSubmit?.addEventListener('click', () => {
    submitLedgerInput();
    autoResize();
  });
  promptQueueSteer?.addEventListener('click', () => steerSelectedPrompt());
  promptQueueClear?.addEventListener('click', () => {
    if (!promptQueue.length || steeringPromptId != null) return;
    clearPromptQueue();
  });
  promptQueueList?.addEventListener('dragover', (event) => event.preventDefault());
  promptQueueList?.addEventListener('drop', (event) => {
    event.preventDefault();
    if (!draggedPromptId || event.target.closest?.('.prompt-queue-item')) return;
    const from = findPromptIndex(draggedPromptId);
    if (from >= 0) {
      const [item] = promptQueue.splice(from, 1);
      promptQueue.push(item);
      selectedPromptId = item.id;
      renderPromptQueue();
      updatePromptControls();
    }
  });
  promptEditSave?.addEventListener('click', () => savePromptEditor());
  promptEditCancel?.addEventListener('click', () => closePromptEditor());
  promptEditRemove?.addEventListener('click', () => {
    removeQueuedPrompt(editingPromptId);
    closePromptEditor();
  });
  promptEditModal?.querySelector('.prompt-edit-backdrop')?.addEventListener('click', () => closePromptEditor());
  promptEditText?.addEventListener('keydown', (event) => {
    if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
      event.preventDefault();
      savePromptEditor();
    } else if (event.key === 'Escape') {
      event.preventDefault();
      closePromptEditor();
    }
  });
  window.addEventListener('seo-dungeon-agent-settled', () => {
    renderPromptQueue();
    updatePromptControls();
    scheduleQueueDrain();
  });
  window.addEventListener('seo-dungeon-bridge-capabilities', () => {
    renderPromptQueue();
    updatePromptControls();
  });
  bridge.onStatusChange((connected) => {
    renderPromptQueue();
    updatePromptControls();
    if (connected && promptQueue.length && !queueHold) {
      scheduleQueueDrain();
    }
    if (connected) {
      replayRemoteCommandsFromSession();
    }
  });
  window.__seoDungeonDialogueReady = true;
  window.dispatchEvent(new Event('seo-dungeon-dialogue-ready'));

  // Global Escape handler - double-tap cancels any active agent operation
  document.addEventListener('keydown', (e) => {
    if (e.target === logInput || e.target === promptEditText) return;
    if (e.key === 'Escape') {
      const now = Date.now();
      if (now - lastEscTime < 500) {
        stopActiveAgent({ announce: true });
      }
      lastEscTime = now;
    }
  });

  // ── Dev shortcut: ?battle=1 skips to battle with first cached demon ──
  const params = new URLSearchParams(window.location.search);
  if (params.get('battle')) {
    const keys = Object.keys(localStorage).filter(k => k.startsWith('seo_dungeon_audit_'));
    if (keys.length > 0) {
      let cached; try { cached = JSON.parse(localStorage.getItem(keys[0])); } catch (_) {}
      if (cached?.auditData?.issues?.length) {
        const issueIdx = parseInt(params.get('issue') || '0', 10);
        const issue = cached.auditData.issues[issueIdx] || cached.auditData.issues[0];
        addLog(`DEV: jumping to battle - ${issue.title}`);
        document.getElementById('title-screen').style.display = 'none';
        document.getElementById('game-container').style.display = 'block';
        const dpr = window.GAME_DPR;
        game = new Phaser.Game({
          type: Phaser.AUTO,
          parent: 'game-container',
          width: Math.round(800 * dpr), height: Math.round(600 * dpr),
          pixelArt: false, roundPixels: false,
          backgroundColor: '#0a0a1a',
          scale: { mode: Phaser.Scale.FIT, autoCenter: Phaser.Scale.CENTER_BOTH },
          scene: [BootScene, GateScene, SummoningScene, DungeonHallScene, BattleScene, VictoryScene]
        });
        window.__seoDungeonGame = game;
        game.dpr = dpr;
        game.domain = cached.domain;
        game.auditData = cached.auditData;
        game.characterConfig = window.selectedCharacter || {
          profile: getProfileKey(cached.profile || cached.model),
          model: getProfileKey(cached.profile || cached.model),
          runtime: cached.runtime || getSelectedRuntime(),
          dangerousBypass: getDangerousBypassEnabled()
        };
        game.addLog = addLog;
        game.showLoading = showLoadingIndicator;
        game.hideLoading = hideLoadingIndicator;
        // After boot loads the selected character/demon assets, jump straight
        // to the target battle. This uses BootScene's normal re-entry path
        // instead of racing Phaser's scene lifecycle events.
        game.pendingDestination = { scene: 'Battle', data: { issue } };
        game.events.once('ready', () => {
          game.scene.start('Boot');
        });
      }
    }
  }
});
