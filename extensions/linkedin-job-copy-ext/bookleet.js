(async () => {
    const STORAGE_KEY = 'job_desc_memory_v6';
    const PANEL_ID = 'job-copy-panel-v6';
    const SELECTORS = [
        '.jobs-details__main-content.jobs-details__main-content--single-pane.full-width', 
        '.jobs-description', 
        '.jobs-box__html-content',
        '[id^="JobDetails_AboutTheJob_"]',
        '[data-sdui-component*="aboutTheJob"]'
    ];

    let isAutopilot = false;
    let autoTimer = null;

    const getMemory = () => {
        try { 
            return JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]');
        } catch { 
            return [];
        }
    };

    const saveMemory = data => localStorage.setItem(STORAGE_KEY, JSON.stringify(data));

    const updateCount = () => {
        const counter = document.getElementById('jm-count');
        if (counter) { 
            counter.textContent = `Saved Jobs: ${getMemory().length}`;
        }
    };
    
    const toast = (msg, bg = 'rgb(51,51,51)') => {
        const d = document.createElement('div');
        d.textContent = msg;
        Object.assign(d.style, { 
            position: 'fixed', 
            top: '20px', 
            right: '20px', 
            padding: '10px 14px', 
            background: bg, 
            color: 'white', 
            fontSize: '13px', 
            borderRadius: '8px', 
            zIndex: '999999', 
            fontFamily: 'Arial,sans-serif', 
            boxShadow: '0 2px 10px rgba(0,0,0,.2)', 
            opacity: '0', 
            transition: 'opacity .2s' 
        });
        document.body.appendChild(d);
        requestAnimationFrame(() => d.style.opacity = '1');
        setTimeout(() => {
            d.style.opacity = '0';
            setTimeout(() => d.remove(), 300);
        }, 1800);
    };
    
    const extractJob = () => {
        let el = null;
        for (const sel of SELECTORS) {
            el = document.querySelector(sel);
            if (el) break;
        }
        if (!el) throw new Error('Job description not found');
        const text = el.innerText.trim();
        if (!text) throw new Error('No text found');
        return text;
    };

    const formatJob = text => `${text}\n\nURL: ${window.location.href}`;

    const getSduiJobCards = () => Array.from(document.querySelectorAll(
        '[role="button"][componentkey^="job-card-component-ref-"]'
    ));

    const openJobCard = card => {
        card.scrollIntoView({ behavior: 'smooth', block: 'center' });
        setTimeout(() => card.click(), 200);
    };

    const goToNext = () => {
        const sduiCards = getSduiJobCards();
        if (sduiCards.length > 0) {
            const currentJobId = new URLSearchParams(window.location.search).get('currentJobId');
            const currentIndex = currentJobId
                ? sduiCards.findIndex(card => card.getAttribute('componentkey') === `job-card-component-ref-${currentJobId}`)
                : -1;
            const nextCard = currentIndex >= 0 ? sduiCards[currentIndex + 1] : sduiCards[0];

            if (!nextCard) {
                toast('• End of list. Scroll to load more.', 'rgb(239,108,0)');
                return false;
            }

            openJobCard(nextCard);
            return true;
        }

        let activeLi = null;

        const currentJobId = new URLSearchParams(window.location.search).get('currentJobId');
        if (currentJobId) {
            const activeDiv = document.querySelector(`[data-job-id="${currentJobId}"]`);
            if (activeDiv) {
                activeLi = activeDiv.closest('li');
            }
        }

        if (!activeLi) {
            let activeContainer = document.querySelector('.job-card-container--active, .jobs-search-results__list-item--active, .scaffold-layout__list-item--active, [data-job-id].job-card-container');
            activeLi = activeContainer ? activeContainer.closest('li') : null;
        }

        if (!activeLi) {
            toast('✗ Cannot find active job in list', 'rgb(198,40,40)');
            return false;
        }

        const nextLi = activeLi.nextElementSibling;
        if (!nextLi) {
            toast('• End of list. Scroll to load more.', 'rgb(239,108,0)');
            return false;
        }

        nextLi.scrollIntoView({ behavior: 'smooth', block: 'center' });

        setTimeout(() => {
            const nextLink = nextLi.querySelector('a');
            if (nextLink) {
                nextLink.click();
            } else {
                toast('✗ Please click next job manually', 'rgb(198,40,40)');
            }
        }, 200);

        return true;
    };
    
    const copyAndNext = async (isAuto = false) => {
        try {
            const text = formatJob(extractJob());
            const memory = getMemory();
            if (memory[memory.length - 1] !== text) {
                memory.push(text);
                saveMemory(memory);
                updateCount();
                
                // Only hijack the user's clipboard if they clicked manually
                if (!isAuto) {
                    await navigator.clipboard.writeText(text);
                }
                
                toast(`✓ Job saved (${memory.length})`, 'rgb(46,125,50)');
            } else { 
                toast('• Duplicate skipped', 'rgb(239,108,0)');
            }
            
            return goToNext();
        } catch (e) {
            console.error(e);
            toast('✗ Copy failed (Loading?)', 'rgb(198,40,40)');
            // If it fails on autopilot, return true so it tries again
            return isAuto; 
        }
    };

    const toggleAutopilot = () => {
        const btn = document.getElementById('jm-auto');
        isAutopilot = !isAutopilot;
        
        if (isAutopilot) {
            btn.textContent = 'Stop Autopilot ⏹';
            btn.style.background = 'rgb(198,40,40)';
            toast('Autopilot started! Hands off mouse.', 'rgb(156,39,176)');
            autoLoop();
        } else {
            btn.textContent = 'Start Autopilot 🤖';
            btn.style.background = 'rgb(156,39,176)';
            clearTimeout(autoTimer);
            toast('Autopilot stopped', 'rgb(66,66,66)');
        }
    };

    const autoLoop = async () => {
        if (!isAutopilot) return;
        
        const hasNext = await copyAndNext(true); // true = automated run
        if (hasNext) {
            // Wait 3 seconds for the next description to fully load from LinkedIn's servers
            autoTimer = setTimeout(autoLoop, 3000); 
        } else {
            toggleAutopilot(); // Automatically turn off if we hit the end
        }
    };
    
    const createPanel = () => {
        let panel = document.getElementById(PANEL_ID);
        if (panel) return;
        
        panel = document.createElement('div');
        panel.id = PANEL_ID;
        Object.assign(panel.style, { 
            position: 'fixed', 
            bottom: '20px', 
            right: '20px', 
            width: '240px', 
            background: 'rgb(17,17,17)', 
            color: 'white', 
            padding: '12px', 
            borderRadius: '12px', 
            fontFamily: 'Arial,sans-serif', 
            fontSize: '13px', 
            zIndex: '999999', 
            boxShadow: '0 4px 20px rgba(0,0,0,.3)' 
        });
        
        panel.innerHTML = `
            <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px;">
                <strong>Job Memory</strong>
                <div style="display:flex;gap:6px;align-items:center;">
                    <button id="jm-toggle" style="background:none;border:none;color:rgb(170,170,170);cursor:pointer;font-size:16px;">—</button>
                    <button id="jm-close" title="Close" aria-label="Close" style="background:none;border:none;color:rgb(170,170,170);cursor:pointer;font-size:18px;line-height:1;">×</button>
                </div>
            </div>
            <div id="jm-content">
                <div id="jm-count" style="margin-bottom:10px;">Saved Jobs: 0</div>
                <div style="display:flex;flex-direction:column;gap:8px;">
                    <button id="jm-next" style="padding:10px;border:none;border-radius:6px;background:rgb(46,125,50);color:white;cursor:pointer;font-weight:bold;font-size:14px;">Copy & Next ⏭</button>
                    <button id="jm-auto" style="padding:10px;border:none;border-radius:6px;background:rgb(156,39,176);color:white;cursor:pointer;font-weight:bold;font-size:14px;">Start Autopilot 🤖</button>
                    <button id="jm-export" style="padding:10px;border:none;border-radius:6px;background:rgb(21,101,192);color:white;cursor:pointer;font-weight:bold;font-size:14px;">Export & Flush 📋</button>
                </div>
            </div>`;
        
        document.body.appendChild(panel);
        
        document.getElementById('jm-next').onclick = () => copyAndNext(false);
        document.getElementById('jm-auto').onclick = toggleAutopilot;
        document.getElementById('jm-close').onclick = () => {
            isAutopilot = false;
            clearTimeout(autoTimer);
            panel.remove();
        };
        
        document.getElementById('jm-export').onclick = async () => {
            const memory = getMemory();
            if (memory.length === 0) {
                toast('Memory is empty', 'rgb(239,108,0)');
                return;
            }

            const data = memory.join('\n\n====================\n\n');
            await navigator.clipboard.writeText(data);
            // Execute the flush
            localStorage.removeItem(STORAGE_KEY);
            updateCount();
            
            const btn = document.getElementById('jm-export');
            const oldText = btn.textContent;
            btn.textContent = '✓ Exported & Flushed';
            btn.style.background = 'rgb(46,125,50)';
            toast(`✓ Flushed ${memory.length} jobs`, 'rgb(21,101,192)');
            
            setTimeout(() => {
                btn.textContent = oldText;
                btn.style.background = 'rgb(21,101,192)';
            }, 2000);
        };
        
        document.getElementById('jm-toggle').onclick = () => {
            const c = document.getElementById('jm-content');
            const t = document.getElementById('jm-toggle');
            if (c.style.display === 'none') { 
                c.style.display = 'block'; 
                t.textContent = '—';
            } else { 
                c.style.display = 'none'; 
                t.textContent = '+';
            }
        };
        updateCount();
    };
    
    createPanel();
    updateCount();
    
    chrome.runtime.onMessage.addListener(message => {
        if (message?.type !== 'open-job-copier-panel') return;
        createPanel();
        updateCount();
        toast(`✓ Ready (${getMemory().length} saved)`, 'rgb(66,66,66)');
    });
    toast(`✓ Ready (${getMemory().length} saved)`, 'rgb(66,66,66)');
})();
