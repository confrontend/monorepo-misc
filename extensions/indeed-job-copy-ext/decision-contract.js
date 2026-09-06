(function () {
  'use strict';

  const PLATFORM = 'indeed';
  const DECISIONS_KEY = 'job_copier_decisions_v1';
  const BADGE_ATTR = 'data-job-copier-ai-badge';
  let applyingBadges = false;
  let applyScheduled = false;
  let lastDebugSignature = '';

  const readDecisions = () => {
    try { return JSON.parse(localStorage.getItem(DECISIONS_KEY) || '{}'); }
    catch { return {}; }
  };

  const stableFallbackId = value => {
    let hash = 2166136261;
    for (const char of value) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619);
    return `fallback-${(hash >>> 0).toString(16)}`;
  };

  const storedJob = (value, index) => {
    const raw = String(value);
    const match = raw.match(/\n\nURL: (https?:\/\/\S+)$/);
    const url = match?.[1] || '';
    let id = '';
    try {
      const parsed = new URL(url || location.href);
      id = parsed.searchParams.get('jk') || parsed.searchParams.get('vjk') || '';
    } catch { /* Use a deterministic fallback below. */ }
    return {
      jobId: `${PLATFORM}:${id || stableFallbackId(`${url}|${raw}|${index}`)}`,
      source: PLATFORM,
      title: '',
      company: '',
      location: '',
      url,
      description: match ? raw.slice(0, match.index).trim() : raw,
      collectedAt: new Date().toISOString()
    };
  };

  const enrichFromCard = job => {
    const id = job.jobId.slice(`${PLATFORM}:`.length);
    const link = Array.from(document.querySelectorAll('.jcs-JobTitle[data-jk]')).find(item => item.dataset.jk === id);
    const card = link?.closest('.result, li');
    if (!card) return job;
    job.title = link.innerText.trim();
    job.company = card.querySelector('[data-testid="company-name"]')?.innerText?.trim() || '';
    job.location = card.querySelector('[data-testid="text-location"]')?.innerText?.trim() || '';
    return job;
  };

  const buildExport = entries => JSON.stringify({
    schemaVersion: 1,
    batchId: `${PLATFORM}-${Date.now()}`,
    source: PLATFORM,
    jobs: entries.map(storedJob).map(enrichFromCard)
  }, null, 2);

  const setStatus = message => {
    const status = document.getElementById('jca-status');
    if (status) status.textContent = message;
  };

  const applyBadges = () => {
    if (applyingBadges) return;
    applyingBadges = true;
    setTimeout(() => { applyingBadges = false; }, 0);
    const decisions = readDecisions();
    const debug = { decisions: Object.keys(decisions).length };
    const signature = JSON.stringify(debug);
    if (signature !== lastDebugSignature) { lastDebugSignature = signature; console.debug(`[JobCopier:${PLATFORM}] badge scan`, debug); }
    for (const link of document.querySelectorAll('.jcs-JobTitle[data-jk], .jcs-JobTitle[href]')) {
      const id = link.dataset.jk || new URL(link.href, location.href).searchParams.get('jk');
      const decision = id && decisions[`${PLATFORM}:${id}`];
      const card = link.closest('.result, li');
      if (!card) continue;
      const existing = card.querySelector(`[${BADGE_ATTR}]`);
      if (!decision) { existing?.remove(); continue; }
      if (existing) {
        const label = `${decision.apply ? '✓' : '✕'} ${decision.score}/100`;
        if (existing.textContent !== label) existing.textContent = label;
        if (existing.title !== (decision.reason || '')) existing.title = decision.reason || '';
        existing.style.background = decision.apply ? '#218739' : '#b3261e';
        card.style.outline = `3px solid ${decision.apply ? '#218739' : '#b3261e'}`;
        continue;
      }
      const badge = document.createElement('div');
      badge.setAttribute(BADGE_ATTR, 'true');
      badge.textContent = `${decision.apply ? '✓' : '✕'} ${decision.score}/100`;
      badge.title = decision.reason || '';
      Object.assign(badge.style, { position: 'absolute', top: '8px', left: '8px', zIndex: '5', padding: '4px 7px', borderRadius: '6px', color: '#fff', background: decision.apply ? '#218739' : '#b3261e', font: '700 12px Arial,sans-serif', boxShadow: '0 1px 4px rgba(0,0,0,.25)' });
      if (getComputedStyle(card).position === 'static') card.style.position = 'relative';
      card.style.outline = `3px solid ${decision.apply ? '#218739' : '#b3261e'}`;
      card.insertBefore(badge, card.firstChild);
    }
  };
  const scheduleApplyBadges = () => { if (applyScheduled) return; applyScheduled = true; setTimeout(() => { applyScheduled = false; applyBadges(); }, 0); };

  const showImport = () => {
    if (document.getElementById('jca-import-overlay')) return;
    const overlay = document.createElement('div');
    overlay.id = 'jca-import-overlay';
    Object.assign(overlay.style, { position: 'fixed', inset: '0', zIndex: '2147483647', background: 'rgba(0,0,0,.45)', display: 'grid', placeItems: 'center' });
    overlay.innerHTML = `<div style="width:min(680px,90vw);background:#fff;color:#111;padding:16px;border-radius:10px;font:14px Arial,sans-serif;box-shadow:0 8px 30px rgba(0,0,0,.35)"><strong>Paste ChatGPT decisions JSON</strong><textarea id="jca-input" style="display:block;width:100%;height:260px;margin:12px 0;padding:8px;box-sizing:border-box;font:12px monospace"></textarea><div style="display:flex;gap:8px;justify-content:flex-end"><button id="jca-cancel">Cancel</button><button id="jca-apply">Apply decisions</button></div></div>`;
    document.body.appendChild(overlay);
    overlay.querySelector('#jca-cancel').onclick = () => overlay.remove();
    overlay.querySelector('#jca-apply').onclick = () => {
      try {
        const payload = JSON.parse(overlay.querySelector('#jca-input').value);
        if (payload.schemaVersion !== 1 || (payload.source && payload.source !== PLATFORM) || !Array.isArray(payload.decisions)) throw new Error(`Expected schemaVersion 1 ${PLATFORM} decisions JSON.`);
        const decisions = readDecisions(); let count = 0;
        for (const item of payload.decisions) {
          const score = Number(item?.score);
          if (!item || typeof item.jobId !== 'string' || !item.jobId.startsWith(`${PLATFORM}:`) || typeof item.apply !== 'boolean' || !Number.isFinite(score) || score < 0 || score > 100) continue;
          decisions[item.jobId] = { apply: item.apply, score: Math.round(score), reason: String(item.reason || '') }; count++;
        }
        localStorage.setItem(DECISIONS_KEY, JSON.stringify(decisions));
        overlay.remove(); applyBadges(); setStatus(`Applied ${count} AI decisions.`);
      } catch (error) { alert(error.message || 'Invalid decisions JSON.'); }
    };
  };

  const mountImportControl = () => {
    const panel = document.querySelector('#indeed-copy-panel-v1 #jm-content');
    if (!panel || panel.querySelector('[data-jca-controls]')) return;
    const help = document.createElement('div');
    help.dataset.jcaControls = 'true';
    help.innerHTML = '<div id="jca-status" style="margin-top:10px;color:rgb(180,180,180);font-size:11px;line-height:1.35;">Export &amp; Flush copies JSON with job IDs. Paste ChatGPT decisions to mark this list.</div><button id="jca-import" style="margin-top:8px;padding:8px;border:none;border-radius:6px;background:rgb(117,76,172);color:white;cursor:pointer;font-weight:bold;font-size:12px;width:100%;">Import AI Decisions</button>';
    panel.appendChild(help);
    help.querySelector('#jca-import').onclick = showImport;
  };

  window.JobCopierDecisionContract = { buildExport };
  mountImportControl(); applyBadges();
  new MutationObserver(() => { mountImportControl(); scheduleApplyBadges(); }).observe(document.body, { childList: true, subtree: true });
})();
