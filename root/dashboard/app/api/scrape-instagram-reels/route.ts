import { NextRequest, NextResponse } from 'next/server';
import { chromium, Response } from 'playwright';

// Force Node.js runtime (required for Playwright)
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface ReelData {
  id: string;
  url: string;
  views: number;
  likes: number;
  comments: number;
  caption: string;
  timestamp: number;
}

export async function POST(request: NextRequest) {
  console.log('🔍 Instagram Reels Scraper');
  
  let browser;
  
  try {
    const { username, maxReels = 10 } = await request.json();
    
    if (!username) {
      return NextResponse.json(
        { error: 'Username is required' },
        { status: 400 }
      );
    }

    console.log(`📱 Scraping reels for: ${username}`);
    console.log(`🚀 Launching browser...`);

    try {
      browser = await chromium.launch({ 
        headless: true, // Must be true for server environments
        args: ['--no-sandbox', '--disable-setuid-sandbox']
      });
      console.log(`✅ Browser launched successfully`);
    } catch (launchError: any) {
      console.error(`💥 Browser launch failed:`, launchError.message);
      
      // Check if it's the missing browser executable error
      if (launchError.message.includes('Executable doesn\'t exist') || 
          launchError.message.includes('playwright install')) {
        return NextResponse.json({
          error: 'Playwright browsers not installed',
          details: 'Please run: npx playwright install',
          fullError: launchError.message,
          solution: 'Run "npx playwright install" in the terminal to download browser binaries'
        }, { status: 500 });
      }
      
      throw launchError;
    }
    
    const context = await browser.newContext({
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      viewport: { width: 1920, height: 1080 },
    });
    
    const page = await context.newPage();
    const reelsData: ReelData[] = [];
    const seenIds = new Set<string>();
    let responseCount = 0;
    let relevantResponseCount = 0;

    // Intercept network responses
    page.on('response', async (response: Response) => {
      const url = response.url();
      responseCount++;
      
      // Log all Instagram API calls for debugging
      if (url.includes('instagram.com') && (url.includes('graphql') || url.includes('api/v1/clips') || url.includes('/web'))) {
        console.log(`📡 API: ${url.split('?')[0].substring(0, 100)}...`);
        relevantResponseCount++;
        
        try {
          const contentType = response.headers()['content-type'];
          if (!contentType?.includes('json')) {
            console.log(`   ⚠️ Non-JSON response: ${contentType}`);
            return;
          }

          const json = await response.json();
          
          // 🎯 FIXED: Match 2026 Instagram API structure
          if (url.includes('/api/v1/clips/user/') && json.items) {
            console.log(`   🎯 CLIPS: ${json.items.length} items`);
            
            json.items.forEach((item: any) => {
              const id = item.id;
              const code = item.code || item.id;
              
              if (!id || seenIds.has(id)) return;
              seenIds.add(id);
              
              reelsData.push({
                id,
                url: `https://www.instagram.com/reel/${code}/`,
                views: item.play_count || item.view_count || item.video_view_count || 0,
                likes: item.like_count || 0,
                comments: item.comment_count || 0,
                caption: item.caption_text || item.caption || item.text || '',
                timestamp: item.timestamp || item.taken_at_timestamp || 0,
              });
              
              console.log(`   ✅ Reel ${reelsData.length}: ${code} (${(item.play_count || 0).toLocaleString()} views)`);
            });
            return;  // Stop parsing other paths
          }
          
          // Fallback for legacy GraphQL structures
          if (json?.data?.user?.edge_owner_to_timeline_media?.edges) {
            console.log(`   📊 GraphQL: ${json.data.user.edge_owner_to_timeline_media.edges.length} edges`);
            json.data.user.edge_owner_to_timeline_media.edges.forEach((edge: any) => {
              const node = edge.node;
              const id = node.id;
              const code = node.shortcode;
              
              if (!id || seenIds.has(id)) return;
              seenIds.add(id);
              
              reelsData.push({
                id,
                url: `https://www.instagram.com/reel/${code}/`,
                views: node.video_view_count || 0,
                likes: node.edge_liked_by?.count || 0,
                comments: node.edge_media_to_comment?.count || 0,
                caption: node.edge_media_to_caption?.edges?.[0]?.node?.text || '',
                timestamp: node.taken_at_timestamp || 0,
              });
            });
          }
          
        } catch (e) {
          // Log parsing errors for debugging
          console.log(`   ⚠️ Parse error: ${e instanceof Error ? e.message : 'unknown'}`);
        }
      }
    });

    // Navigate to user's reels page
    console.log(`🌐 Navigating to profile...`);
    await page.goto(`https://www.instagram.com/${username}/reels/`, {
      waitUntil: 'networkidle',
      timeout: 30000
    });
    console.log(`✅ Page loaded`);
    
    // Close the login popup if it appears
    console.log(`🚪 Checking for login popup...`);
    try {
      // Wait for and click the close button (X) on the popup
      const closeButton = page.locator('svg[aria-label="Close"]').first();
      await closeButton.waitFor({ timeout: 5000 });
      await closeButton.click();
      console.log(`✅ Closed login popup`);
      await page.waitForTimeout(1000);
    } catch (e) {
      console.log(`ℹ️ No popup found or already closed`);
    }
    
    // Wait for initial content
    await page.waitForTimeout(3000);
    console.log(`⏳ Initial wait complete, found ${reelsData.length} reels so far`);
    
    // FALLBACK: Parse HTML directly to extract reel URLs
    console.log(`🔍 Extracting reels from HTML...`);
    const htmlReels = await page.$$eval('a[href*="/reel/"]', (links) =>
      links.map((a) => {
        const href = (a as HTMLAnchorElement).href;
        const match = href.match(/\/reel\/([^\/\?]+)/);
        return match ? match[1] : null;
      }).filter(Boolean)
    );
    
    console.log(`📋 Found ${htmlReels.length} reel URLs in HTML`);
    
    // For each reel, try to get view count from its dedicated page
    const maxReelsToCheck = Math.min(htmlReels.length, 15);
    console.log(`🔎 Scraping view counts for ${maxReelsToCheck} reels...`);
    
    for (let i = 0; i < maxReelsToCheck; i++) {
      const code = htmlReels[i];
      if (!code || seenIds.has(code)) continue;
      
      try {
        console.log(`   [${i + 1}/${maxReelsToCheck}] Checking reel: ${code}`);
        const reelPage = await context.newPage();
        await reelPage.goto(`https://www.instagram.com/reel/${code}/`, {
          waitUntil: 'domcontentloaded',
          timeout: 10000
        });
        
        // Extract JSON from page
        const jsonData = await reelPage.evaluate(() => {
          // Try to find embedded JSON data
          const scripts = Array.from(document.querySelectorAll('script[type="application/ld+json"]'));
          for (const script of scripts) {
            try {
              return JSON.parse(script.textContent || '');
            } catch {}
          }
          
          // Try window.__additionalData
          const additionalData = (window as any).__additionalDataLoaded;
          if (additionalData) return additionalData;
          
          // Try to find data in inline scripts
          const allScripts = Array.from(document.querySelectorAll('script:not([src])'));
          for (const script of allScripts) {
            const text = script.textContent || '';
            if (text.includes('video_view_count') || text.includes('play_count')) {
              // Try to extract JSON object containing view count
              const match = text.match(/"video_view_count":(\d+)/);
              if (match) return { viewCount: parseInt(match[1]) };
              const playMatch = text.match(/"play_count":(\d+)/);
              if (playMatch) return { viewCount: parseInt(playMatch[1]) };
            }
          }
          
          return null;
        });
        
        await reelPage.close();
        
        if (jsonData) {
          const viewCount = jsonData.viewCount || jsonData.video_view_count || jsonData.interactionStatistic?.userInteractionCount || 0;
          
          if (viewCount > 0) {
            seenIds.add(code);
            reelsData.push({
              id: code,
              url: `https://www.instagram.com/reel/${code}/`,
              views: viewCount,
              likes: 0, // Not easily extractable without full parsing
              comments: 0,
              caption: jsonData.caption || jsonData.description || '',
              timestamp: Date.now(),
            });
            console.log(`      ✅ ${viewCount.toLocaleString()} views`);
          } else {
            console.log(`      ⚠️ No view count found`);
          }
        } else {
          console.log(`      ⚠️ No JSON data found`);
        }
        
        // Rate limiting
        await page.waitForTimeout(500);
        
      } catch (err) {
        console.log(`      ❌ Failed: ${err instanceof Error ? err.message : 'unknown'}`);
      }
    }
    
    // Scroll to trigger more API calls and load more reels (keep as backup)
    console.log(`📜 Scrolling to load more reels...`);
    for (let i = 0; i < 5; i++) {
      await page.evaluate(() => window.scrollBy(0, 1000));
      await page.waitForTimeout(2000);
      console.log(`   Scroll ${i + 1}/5 - Total reels: ${reelsData.length}`);
      
      // Break if we have enough reels
      if (reelsData.length >= maxReels * 2) {
        console.log(`   ✓ Collected enough reels, stopping scroll`);
        break;
      }
    }

    await browser.close();
    console.log(`🔒 Browser closed`);
    console.log(`📊 Network stats: ${responseCount} total responses, ${relevantResponseCount} Instagram API calls`);

    // Sort by views (descending) and get top reels
    const topReels = reelsData
      .filter(reel => reel.views > 0) // Filter out reels with no views
      .sort((a, b) => b.views - a.views)
      .slice(0, maxReels);

    console.log(`✅ Found ${reelsData.length} reels total, returning top ${topReels.length}`);
    console.log(`📊 Top reel views: ${topReels[0]?.views || 0}, Bottom: ${topReels[topReels.length - 1]?.views || 0}`);

    if (topReels.length === 0) {
      console.log(`⚠️ No reels with view counts found`);
      return NextResponse.json({
        error: 'No reels found. The profile might be private or require login.',
        details: `Scraped ${reelsData.length} total items but none had view counts.`
      }, { status: 404 });
    }

    return NextResponse.json({
      success: true,
      username,
      totalFound: reelsData.length,
      topReels,
      timestamp: new Date().toISOString(),
    });
    
  } catch (error: any) {
    console.error('💥 Scraping error:', error.message);
    console.error('📋 Error stack:', error.stack);
    
    // Clean up browser if it was opened
    if (browser) {
      try {
        await browser.close();
        console.log('🔒 Browser closed after error');
      } catch (closeError) {
        console.error('⚠️ Failed to close browser:', closeError);
      }
    }
    
    return NextResponse.json({ 
      error: 'Scraping failed', 
      details: error.message,
      stack: error.stack?.split('\n').slice(0, 3).join('\n')
    }, { status: 500 });
  }
}
