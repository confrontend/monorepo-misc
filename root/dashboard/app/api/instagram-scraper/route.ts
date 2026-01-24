import { NextRequest, NextResponse } from 'next/server';
import puppeteer from 'puppeteer';

// Helper function to replace deprecated waitForTimeout
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

interface InstagramPost {
  id: string;
  url: string;
  videoUrl?: string;
  thumbnail: string;
  caption: string;
  views: number;
  likes: number;
  topComments: string[];
  timestamp: string;
}

interface ScrapeRequest {
  profileUrl: string;
  minViews: number;
  limit: number;
  pastMonths: number;
}

async function scrapeInstagramProfile(
  profileUrl: string,
  minViews: number,
  limit: number,
  pastMonths: number
): Promise<InstagramPost[]> {
  let browser;

  try {
    // Launch browser
    browser = await puppeteer.launch({
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
      ],
    });

    const page = await browser.newPage();

    // Set viewport and user agent to mimic real browser
    await page.setViewport({ width: 1920, height: 1080 });
    await page.setUserAgent(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
    );

    // Add headers to look more like a real browser
    await page.setExtraHTTPHeaders({
      'Accept-Language': 'en-US,en;q=0.9',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
      'Referer': 'https://www.instagram.com/',
    });

    // Navigate to profile
    console.log(`Navigating to ${profileUrl}`);
    await page.goto(profileUrl, { waitUntil: 'networkidle2', timeout: 30000 });

    // Wait and extract posts - Instagram uses dynamic React classes, so we use multiple strategies
    await delay(2000); // Initial delay for page load

    // Try to find posts by looking for common Instagram post containers
    const posts: InstagramPost[] = [];
    const oneYearAgo = new Date();
    oneYearAgo.setMonth(oneYearAgo.getMonth() - pastMonths);

    // Get all visible posts using a flexible selector strategy
    let previousHeight = 0;
    let scrollAttempts = 0;
    const maxScrolls = 10;

    while (posts.length < limit && scrollAttempts < maxScrolls) {
      // Evaluate page and extract posts
      const newPosts = await page.evaluate(
        ({ minViews, oneYearAgoTimestamp }: { minViews: number; oneYearAgoTimestamp: number }) => {
          const results: InstagramPost[] = [];

          // Strategy 1: Look for article elements (standard HTML)
          let containers = document.querySelectorAll('article');
          
          // Strategy 2: If no articles, look for common post containers
          if (containers.length === 0) {
            // Try finding divs that look like posts (contain images and interaction data)
            containers = document.querySelectorAll('div[role="img"]') as any;
          }

          // Strategy 3: Look for images with specific patterns
          if (containers.length === 0) {
            const images = document.querySelectorAll('img[alt*="carousel"]');
            containers = images.length > 0 
              ? Array.from(images).map(img => img.closest('article') || img.closest('div[role="link"]'))
              : (document.querySelectorAll('div._aay6') as any);
          }

          // Process each container
          Array.from(containers).forEach((container: any) => {
            try {
              if (!container) return;

              // Extract post URL
              let postUrl = '';
              const linkElement = container.querySelector('a[href*="/p/"]') || 
                                container.querySelector('a[href*="/reel/"]') ||
                                container.querySelector('a[href*="/stories/"]');
              
              if (linkElement) {
                const href = linkElement.getAttribute('href');
                if (href) {
                  postUrl = href.startsWith('/')
                    ? `https://www.instagram.com${href}`
                    : href;
                }
              }

              if (!postUrl) return;

              // Extract thumbnail - look for img elements
              let thumbnail = '';
              const imgElement = container.querySelector('img');
              if (imgElement) {
                thumbnail = imgElement.getAttribute('src') || 
                          imgElement.getAttribute('data-src') || '';
              }

              // Extract engagement metrics from text content
              let views = 0, likes = 0, caption = '';
              const textContent = container.textContent || '';

              // Extract views
              const viewsMatch = textContent.match(/(\d+(?:,\d+)*)\s*(?:views?|watched)/i);
              if (viewsMatch) {
                views = parseInt(viewsMatch[1].replace(/,/g, ''));
              }

              // Extract likes
              const likesMatch = textContent.match(/(\d+(?:,\d+)*)\s*(?:likes?|like)/i);
              if (likesMatch) {
                likes = parseInt(likesMatch[1].replace(/,/g, ''));
              }

              // Extract caption - get text before engagement metrics
              const lines = textContent.split('\n').filter((line: string) => line.trim());
              if (lines.length > 0) {
                caption = lines.slice(0, 3).join(' ').substring(0, 200);
              }

              // Only include if meets minimum views requirement
              if (views >= minViews || likes >= minViews) {
                results.push({
                  id: postUrl.split('/').filter(Boolean).pop() || Date.now().toString(),
                  url: postUrl,
                  thumbnail,
                  caption,
                  views,
                  likes,
                  topComments: [],
                  timestamp: new Date().toISOString(),
                });
              }
            } catch (e) {
              // Skip containers that fail to parse
              console.error('Error parsing post container:', e);
            }
          });

          return results;
        },
        { minViews, oneYearAgoTimestamp: oneYearAgo.getTime() }
      );

      // Add new posts (avoid duplicates)
      newPosts.forEach((post) => {
        if (!posts.find((p) => p.id === post.id)) {
          posts.push(post);
        }
      });

      if (posts.length >= limit) break;

      // Scroll down to load more
      const newHeight = await page.evaluate(
        () => document.documentElement.scrollHeight
      );

      if (newHeight === previousHeight) {
        scrollAttempts++;
      } else {
        scrollAttempts = 0;
      }

      previousHeight = newHeight;
      await page.evaluate(() => window.scrollBy(0, window.innerHeight));
      await delay(1500);
    }

    // Sort by views and return top posts
    return posts.sort((a, b) => b.views - a.views).slice(0, limit);
  } catch (error) {
    console.error('Instagram scraping error:', error);
    throw new Error(`Failed to scrape Instagram: ${error instanceof Error ? error.message : 'Unknown error'}`);
  } finally {
    if (browser) {
      await browser.close();
    }
  }
}

export async function POST(request: NextRequest) {
  try {
    const body: ScrapeRequest = await request.json();

    const { profileUrl, minViews, limit, pastMonths } = body;

    if (!profileUrl || !profileUrl.includes('instagram.com')) {
      return NextResponse.json(
        { error: 'Invalid Instagram URL' },
        { status: 400 }
      );
    }

    const posts = await scrapeInstagramProfile(
      profileUrl,
      minViews,
      limit,
      pastMonths
    );

    return NextResponse.json({
      success: true,
      count: posts.length,
      posts,
    });
  } catch (error) {
    console.error('API error:', error);
    return NextResponse.json(
      {
        error:
          error instanceof Error ? error.message : 'Failed to scrape profile',
      },
      { status: 500 }
    );
  }
}
