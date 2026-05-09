javascript:(async () => {
    const STORAGE_KEY = 'job_desc_memory_v5';
    const PANEL_ID = 'job-copy-panel-v5';
    const SELECTORS = [
        '.jobs-details__main-content.jobs-details__main-content--single-pane.full-width', 
        '.jobs-description', 
        '.jobs-box__html-content'
    ];

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

    const goToNext = () => {
        let activeLi = null;

        // 1. Bulletproof method: Find the job matching the ID in the URL
        const currentJobId = new URLSearchParams(window.location.search).get('currentJobId');
        if (currentJobId) {
            const activeDiv = document.querySelector(`[data-job-id="${currentJobId}"]`);
            if (activeDiv) {
                activeLi = activeDiv.closest('li');
            }
        }

        // 2. Fallback method: Look for active classes just in case
        if (!activeLi) {
            let activeContainer = document.querySelector('.job-card-container--active, .jobs-search-results__list-item--active, .scaffold-layout__list-item--active');
            activeLi = activeContainer ? activeContainer.closest('li') : null;
        }

        if (!activeLi) {
            toast('✗ Cannot find active job in list', 'rgb(198,40,40)');
            return;
        }

        const nextLi = activeLi.nextElementSibling;
        if (!nextLi) {
            toast('• End of list. Scroll to load more.', 'rgb(239,108,0)');
            return;
        }

        // Scroll the next item into view FIRST to defeat LinkedIn's virtual scrolling
        nextLi.scrollIntoView({ behavior: 'smooth', block: 'center' });

        // Wait a tiny bit for LinkedIn to inject the HTML into the occluded list item
        setTimeout(() => {
            const nextLink = nextLi.querySelector('a');
            if (nextLink) {
                nextLink.click();
            } else {
                toast('✗ Please click next job manually', 'rgb(198,40,40)');
            }
        }, 200);
    };
    
    const copyAndNext = async () => {
        try {
            const text = extractJob();
            const memory = getMemory();
            if (memory[memory.length - 1] !== text) {
                memory.push(text);
                saveMemory(memory);
                updateCount();
                await navigator.clipboard.writeText(text);
                toast(`✓ Job saved (${memory.length})`, 'rgb(46,125,50)');
            } else { 
                toast('• Duplicate skipped', 'rgb(239,108,0)');
            }
            
            setTimeout(goToNext, 200);

        } catch (e) {
            console.error(e);
            toast('✗ Copy failed', 'rgb(198,40,40)');
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
                <button id="jm-toggle" style="background:none;border:none;color:rgb(170,170,170);cursor:pointer;font-size:16px;">—</button>
            </div>
            <div id="jm-content">
                <div id="jm-count" style="margin-bottom:10px;">Saved Jobs: 0</div>
                <div style="display:flex;flex-direction:column;gap:8px;">
                    <button id="jm-next" style="padding:10px;border:none;border-radius:6px;background:rgb(46,125,50);color:white;cursor:pointer;font-weight:bold;font-size:14px;">Copy & Next ⏭</button>
                    <button id="jm-export" style="padding:8px;border:none;border-radius:6px;background:rgb(21,101,192);color:white;cursor:pointer;">Copy All Saved Jobs</button>
                    <button id="jm-flush" style="padding:8px;border:none;border-radius:6px;background:rgb(198,40,40);color:white;cursor:pointer;transition:all .2s;">Flush Memory</button>
                </div>
            </div>`;
        
        document.body.appendChild(panel);
        
        document.getElementById('jm-next').onclick = copyAndNext;
        
        document.getElementById('jm-export').onclick = async () => {
            const data = getMemory().join('\n\n====================\n\n');
            await navigator.clipboard.writeText(data);
            toast(`✓ Copied ${getMemory().length} jobs`, 'rgb(21,101,192)');
        };
        
        document.getElementById('jm-flush').onclick = () => {
            if (confirm('Clear saved job descriptions?')) {
                localStorage.removeItem(STORAGE_KEY);
                updateCount();
                
                const btn = document.getElementById('jm-flush');
                btn.textContent = '✓ Memory Cleared';
                btn.style.background = 'rgb(142,0,0)';
                setTimeout(() => {
                    btn.textContent = 'Flush Memory';
                    btn.style.background = 'rgb(198,40,40)';
                }, 1500);
            }
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
    toast(`✓ Ready (${getMemory().length} saved)`, 'rgb(66,66,66)');
})();