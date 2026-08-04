(() => {
  'use strict';

  const BUTTON_ID = 'sa-quant-json-exporter';
  const HISTORY_CARD_SELECTOR = '[data-test-id="card-container-quant-rating-history"]';
  const LOG_PREFIX = '[Seeking Alpha Quant Exporter]';

  const debug = (...values) => console.debug(LOG_PREFIX, ...values);

  const text = (element) => (element?.textContent || '').replace(/\s+/g, ' ').trim();

  const numberOrNull = (value) => {
    const normalized = String(value || '').replace(/[$,%\s,]/g, '');
    const number = Number(normalized);
    return Number.isFinite(number) ? number : null;
  };

  const scoreFromText = (value) => {
    const match = String(value || '').match(/(\d+(?:\.\d+)?)\s*$/);
    return match ? numberOrNull(match[1]) : null;
  };

  const getText = (selector, root = document) => text(root.querySelector(selector));

  const getCurrentRatings = () => {
    const ratings = [...document.querySelectorAll('[data-test-id="card-container-quant-rating"] [data-test-id="card-rating"]')];
    const quantRating = text(ratings[0]) || text(ratings[1]).replace(/Rating:\s*/i, '').replace(/\d+(?:\.\d+)?\s*$/, '').trim() || null;
    const quantScore = scoreFromText(text(ratings[1]));
    return { quantRating, quantScore };
  };

  const getHistoryTable = (card, shouldLog = false) => {
    const candidates = [...(card?.querySelectorAll('table') || [])].map((table, index) => ({
      table,
      index,
      headers: [...table.querySelectorAll('th')].map(text),
      rows: table.querySelectorAll('tr').length,
      dataRows: [...table.querySelectorAll('tr')].filter((row) => row.querySelectorAll('td').length > 0).length,
      cells: table.querySelectorAll('td').length,
      preview: text(table).slice(0, 180),
    }));
    const selected = candidates
      .sort((left, right) => right.cells - left.cells || right.dataRows - left.dataRows || right.index - left.index)[0];
    if (shouldLog) {
      debug('History table candidates', JSON.stringify(candidates.map(({ table, ...details }) => details)));
      debug('Selected history table', selected ? JSON.stringify({ index: selected.index, rows: selected.rows, dataRows: selected.dataRows, cells: selected.cells, headers: selected.headers }) : 'none');
    }
    return selected?.table || null;
  };

  const extractHistory = () => {
    const card = document.querySelector(HISTORY_CARD_SELECTOR);
    const table = getHistoryTable(card);
    if (!table) {
      throw new Error('Quant Rating History table was not found. Select the Quant Rating page first.');
    }

    const headers = [...table.querySelectorAll('thead th')].map(text);
    const rows = [...table.querySelectorAll('tr')].filter((row) => row.querySelectorAll('td').length > 0);
    const records = rows.map((row) => {
      const cells = [...row.querySelectorAll('td')].map(text);
      const values = Object.fromEntries(headers.map((header, index) => [header || `column_${index + 1}`, cells[index] || null]));
      const quantScoreText = values['Quant Score'] || '';
      const scoreMatch = quantScoreText.match(/(\d+(?:\.\d+)?)\s*$/);
      const ratingText = quantScoreText.replace(/Rating:\s*/i, '').replace(/\d+(?:\.\d+)?\s*$/, '').trim();

      return {
        date: values.Date || null,
        price: numberOrNull(values.Price),
        quantRating: values['Quant Rating'] || ratingText || null,
        quantScore: scoreMatch ? numberOrNull(scoreMatch[1]) : null,
        valuation: values.Valuation || null,
        growth: values.Growth || null,
        profitability: values.Profitability || null,
        momentum: values.Momentum || null,
        epsRevisions: values['EPS Rev.'] || null,
        raw: values,
      };
    });

    return {
      headers,
      records,
      rowCount: records.length,
      moreRowsAvailable: Boolean(card.querySelector('[data-test-id="load-more-boundary"]')),
    };
  };

  const waitForHistory = (timeoutMs = 15000) => new Promise((resolve, reject) => {
    const startedAt = Date.now();
    const card = document.querySelector(HISTORY_CARD_SELECTOR);
    let checks = 0;
    card?.scrollIntoView({ block: 'center', behavior: 'auto' });
    debug('Waiting for history rows', {
      readyState: document.readyState,
      cardFound: Boolean(card),
      tableCountInCard: card?.querySelectorAll('table').length || 0,
      cardText: text(card).slice(0, 500),
    });
    getHistoryTable(card, true);
    const check = () => {
      checks += 1;
      try {
        const history = extractHistory();
        if (history.rowCount > 0) {
          debug('History rows found', { checks, rowCount: history.rowCount, headers: history.headers });
          resolve(history);
          return;
        }
      } catch (error) {
        if (Date.now() - startedAt >= timeoutMs) {
          reject(error);
          return;
        }
      }

      if (Date.now() - startedAt >= timeoutMs) {
        const table = getHistoryTable(card, false);
        const rowCount = table?.querySelectorAll('tr').length || 0;
        const cellCount = table?.querySelectorAll('td').length || 0;
        const tableDiagnostics = [...document.querySelectorAll('table')].map((candidate, index) => ({
          index,
          headers: [...candidate.querySelectorAll('th')].map(text),
          rows: candidate.querySelectorAll('tr').length,
          cells: candidate.querySelectorAll('td').length,
          preview: text(candidate).slice(0, 300),
        }));
        const controlDiagnostics = card ? [...card.querySelectorAll('button, a, [role="button"]')].map((control) => ({
          text: text(control).slice(0, 120),
          testId: control.getAttribute('data-test-id'),
          ariaLabel: control.getAttribute('aria-label'),
        })) : [];
        const matchingScripts = [...document.scripts]
          .filter((script) => script.textContent.includes('Quant Rating History'))
          .map((script) => script.textContent.slice(0, 500));
        debug('History extraction diagnostics', {
          checks,
          elapsedMs: Date.now() - startedAt,
          historyCardHtmlPreview: card?.outerHTML.slice(0, 3000),
          tableDiagnostics,
          controlDiagnostics,
          matchingScriptCount: matchingScripts.length,
          matchingScripts,
        });
        reject(new Error(`Quant Rating History table loaded without data rows (tr: ${rowCount}, td: ${cellCount}). Try scrolling the table into view and run the bookmarklet again.`));
        return;
      }

      if (checks === 1 || checks % 10 === 0) {
        const table = getHistoryTable(card, false);
        debug('Still waiting', {
          checks,
          elapsedMs: Date.now() - startedAt,
          rows: table?.querySelectorAll('tr').length || 0,
          cells: table?.querySelectorAll('td').length || 0,
        });
      }
      window.setTimeout(check, 250);
    };

    check();
  });

  const collectSnapshot = async () => {
    const currentRatings = getCurrentRatings();
    const history = await waitForHistory();
    const pathParts = window.location.pathname.split('/').filter(Boolean);
    const ticker = pathParts[0]?.toLowerCase() === 'symbol' ? pathParts[1]?.toUpperCase() : null;

    return {
      schemaVersion: 1,
      capturedAt: new Date().toISOString(),
      source: {
        url: window.location.href,
        pageTitle: document.title,
        ticker: ticker ? decodeURIComponent(ticker) : null,
        companyName: getText('[data-test-id="symbol-full-name"]') || null,
        exchange: getText('[data-test-id="symbol-description"]')?.split('|')[0]?.trim() || null,
        currency: getText('[data-test-id="symbol-description"]')?.split('|')[1]?.trim() || null,
        currentPrice: numberOrNull(getText('[data-test-id="symbol-price"]')),
        currentChange: getText('[data-test-id="symbol-change"]') || null,
        currentPriceTimestamp: getText('[data-test-id="symbol-date"]') || null,
        quantRating: currentRatings.quantRating,
        quantScore: currentRatings.quantScore,
      },
      quantRatingHistory: history,
    };
  };

  const downloadJson = (payload) => {
    const ticker = payload.source.ticker || 'seeking-alpha';
    const date = payload.capturedAt.slice(0, 10);
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `${ticker}-quant-history-${date}.json`;
    anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  const addExportButton = () => {
    if (document.getElementById(BUTTON_ID)) return;

    const button = document.createElement('button');
    button.id = BUTTON_ID;
    button.type = 'button';
    button.textContent = 'Download Quant JSON';
    button.style.cssText = [
      'position:fixed', 'right:18px', 'bottom:18px', 'z-index:2147483647',
      'border:0', 'border-radius:8px', 'padding:12px 16px', 'background:rgb(249,115,22)',
      'color:rgb(255,255,255)', 'font:600 14px system-ui,sans-serif', 'cursor:pointer',
      'box-shadow:0 2px 12px rgba(0,0,0,.25)',
    ].join(';');

    button.addEventListener('click', async () => {
      button.disabled = true;
      button.textContent = 'Waiting for table...';
      try {
        const payload = await collectSnapshot();
        downloadJson(payload);
        button.textContent = `Downloaded ${payload.quantRatingHistory.rowCount} rows`;
      } catch (error) {
        button.textContent = 'Export failed';
        window.setTimeout(() => { button.textContent = 'Download Quant JSON'; }, 2500);
        console.error('[Seeking Alpha Quant Exporter]', error);
      } finally {
        button.disabled = false;
      }
    });

    document.body.appendChild(button);
  };

  if (document.body) addExportButton();
  else window.addEventListener('DOMContentLoaded', addExportButton, { once: true });
})();
