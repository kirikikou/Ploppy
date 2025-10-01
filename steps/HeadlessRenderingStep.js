const { chromium } = require('playwright');
const cheerio = require('cheerio');
const path = require('path');
const fs = require('fs').promises;
const BaseScraperStep = require('./BaseScraperStep');
const { randomDelay, getRandomUserAgent } = require('../../utils');
const { extractContentFromCheerio } = require('../helpers');
const config = require('../../config');

class HeadlessRenderingStep extends BaseScraperStep {
  constructor() {
    super('headless-rendering', 3);
    this.browser = null;
  }
  
  async initialize() {
    if (!this.browser) {
      this.browser = await chromium.launch({
        headless: true,
        args: config.playwrightArgs
      });
    }
    return this.browser;
  }

  async close() {
    if (this.browser) {
      await this.browser.close();
      this.browser = null;
    }
  }

  async scrape(url, options = {}) {
    config.smartLog('steps', `Starting ${this.name} for ${url}`);
    
    if (options.dictionary) {
      this.setDictionary(options.dictionary);
    }
    
    let result = null;
    let scrapingError = null;
    
    try {
      await this.initialize();
      
      const context = await this.browser.newContext({
        userAgent: getRandomUserAgent(),
        viewport: { width: 1366, height: 768 },
        ignoreHTTPSErrors: true,
        javaScriptEnabled: true
      });
      
      if (!options.specialPlatform) {
        await context.route('**/*.{png,jpg,jpeg,gif,svg,webp,woff,woff2,ttf,eot}', route => {
          route.abort();
        });
      }
      
      const page = await context.newPage();
      
      try {
        let navigationSuccess = false;
        
        try {
          config.smartLog('steps', `Navigating to ${url} with domcontentloaded strategy`);
          await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
          navigationSuccess = true;
        } catch (error) {
          config.smartLog('retry', `domcontentloaded navigation failed: ${error.message}`);
        }
        
        if (!navigationSuccess) {
          try {
            config.smartLog('retry', `Retrying with networkidle strategy`);
            await page.goto(url, { waitUntil: 'networkidle', timeout: 45000 });
            navigationSuccess = true;
          } catch (error) {
            config.smartLog('retry', `networkidle navigation failed: ${error.message}`);
            
            try {
              config.smartLog('retry', `Final attempt with load strategy`);
              await page.goto(url, { waitUntil: 'load', timeout: 60000 });
              navigationSuccess = true;
            } catch (error) {
              config.smartLog('timeout', `All navigation strategies failed, proceeding anyway`);
            }
          }
        }
        
        await randomDelay(2000, 5000);
        
        await this.acceptCookiesIfPresent(page);
        
        await this.handleDynamicContent(page);
        
        const html = await page.content();
        const $ = cheerio.load(html);
        const extracted = extractContentFromCheerio($, url);
        
        result = {
          url,
          title: extracted.title,
          text: extracted.text,
          links: extracted.links,
          scrapedAt: new Date().toISOString(),
          method: this.name
        };
        
        if (config.shouldExportDebug(result, scrapingError, this.name)) {
          const debugPromises = [
            page.screenshot({ fullPage: true }).then(screenshot => 
              fs.writeFile(
                path.join(config.DEBUG_DIR, `${this.name}-FAIL-${new URL(url).hostname}-${Date.now()}.png`), 
                screenshot
              )
            ).catch(() => {}),
            page.content().then(html => 
              fs.writeFile(
                path.join(config.DEBUG_DIR, `${this.name}-FAIL-${new URL(url).hostname}-${Date.now()}.html`), 
                html
              )
            ).catch(() => {})
          ];
          await Promise.all(debugPromises).catch(() => {});
        }
      } catch (error) {
        config.smartLog('fail', `Error in headless rendering: ${error.message}`);
        scrapingError = error;
      } finally {
        await page.close();
        await context.close();
      }
      
      if (this.isResultValid(result)) {
        config.smartLog('win', `Successful rendering for ${url}`);
        return result;
      }
      
      config.smartLog('fail', `Invalid result for ${url}`);
      scrapingError = new Error('Invalid result produced');
      return null;
    } catch (error) {
      config.smartLog('fail', `Error initializing headless browser: ${error.message}`);
      scrapingError = error;
      return null;
    }
  }
  
  async acceptCookiesIfPresent(page) {
    config.smartLog('steps', 'Looking for cookie banners...');
    
    const cookieSelectors = this.getCookieSelectors();
    
    for (const selector of cookieSelectors) {
      try {
        const button = await page.$(selector);
        if (button) {
          const isVisible = await button.isVisible();
          if (isVisible) {
            config.smartLog('steps', `Found cookie banner: ${selector}`);
            await button.click().catch(() => config.smartLog('fail', 'Failed to click cookie button'));
            await randomDelay(1000, 2000);
            return;
          }
        }
      } catch (error) {
      }
    }
    
    config.smartLog('steps', 'No cookie banners found or already accepted');
  }
  
  async handleDynamicContent(page) {
    await this.scrollPage(page);
    await this.clickShowMoreButtons(page);
    await this.handlePagination(page);
  }
  
  async scrollPage(page) {
    config.smartLog('steps', 'Scrolling page to load lazy content');
    
    try {
      await page.evaluate(() => {
        return new Promise((resolve) => {
          let totalHeight = 0;
          const distance = 300;
          let timer = setInterval(() => {
            const scrollHeight = document.body.scrollHeight;
            window.scrollBy(0, distance);
            totalHeight += distance;
            
            if (totalHeight >= scrollHeight) {
              clearInterval(timer);
              resolve();
            }
          }, 200);
        });
      });
      
      await randomDelay(1000, 2000);
    } catch (error) {
      config.smartLog('fail', `Error while scrolling: ${error.message}`);
    }
  }
  
  async clickShowMoreButtons(page) {
    config.smartLog('steps', 'Looking for show more buttons');
    
    const maxClicks = 50;
    let clickCount = 0;
    let consecutiveFailures = 0;
    const maxConsecutiveFailures = 3;
    
    const clickedButtons = new Map();
    const maxSameButtonClicks = 2;
    
    const pageStates = new Set();
    
    const getPageState = async () => {
      return page.evaluate(() => {
        return {
          height: document.body.scrollHeight,
          elements: document.querySelectorAll('*').length,
          textLength: document.body.innerText.length,
          jobCount: document.querySelectorAll('[class*="job"], [class*="offer"], [class*="result"], article, .card').length,
          contentDigest: document.body.innerText.substring(0, 1000).replace(/\s+/g, ' ').trim()
        };
      });
    };
    
    const findShowMoreButtons = async () => {
      const candidates = [];
      
      for (const selector of this.getShowMoreSelectors()) {
        try {
          const elements = await page.$$(selector);
          if (elements.length > 0) {
            for (const element of elements) {
              if (await element.isVisible()) {
                candidates.push(element);
              }
            }
          }
        } catch (error) {
        }
      }
      
      const evaluatedButtons = [];
      
      for (const element of candidates) {
        try {
          const buttonInfo = await element.evaluate(el => {
            const getSimpleSelector = (element) => {
              if (element.id) {
                return `#${element.id}`;
              } else if (element.className && typeof element.className === 'string') {
                try {
                  return `${element.tagName.toLowerCase()}.${element.className.replace(/\s+/g, '.')}`;
                } catch (e) {
                  return element.tagName.toLowerCase();
                }
              } else {
                return element.tagName.toLowerCase();
              }
            };
            
            const rect = el.getBoundingClientRect();
            const text = (el.textContent || '').trim().toLowerCase();
            
            const positive = /voir plus|show more|load more|plus de|charger|afficher|next|suivant/i;
            const negative = /cookie|fermer|close|politique|privacy|reset|about|à propos/i;
            
            let score = 0;
            if (positive.test(text)) score += 20;
            if (negative.test(text)) score -= 50;
            if (el.className && typeof el.className === 'string') {
              if (el.className.includes('more') || el.className.includes('plus')) score += 5;
              if (el.className.includes('pagination') || el.className.includes('next')) score += 5;
            }
            if (el.tagName === 'BUTTON') score += 3;
            if (rect.bottom > window.innerHeight * 0.7) score += 5;
            
            return {
              text,
              selector: getSimpleSelector(el),
              x: rect.left + rect.width / 2,
              y: rect.top + rect.height / 2,
              score,
              buttonId: `${text}-${Math.round(rect.x)}-${Math.round(rect.y)}`
            };
          });
          
          if (buttonInfo.score > 0) {
            evaluatedButtons.push(buttonInfo);
          }
        } catch (error) {
        }
      }
      
      return evaluatedButtons.sort((a, b) => b.score - a.score);
    };
    
    const initialState = await getPageState();
    pageStates.add(initialState.contentDigest);
    
    while (clickCount < maxClicks && consecutiveFailures < maxConsecutiveFailures) {
      const beforeState = await getPageState();
      config.smartLog('steps', `Current state: height=${beforeState.height}, elements=${beforeState.elements}, jobs=${beforeState.jobCount}`);
      
      const buttons = await findShowMoreButtons();
      config.smartLog('steps', `Found ${buttons.length} potential buttons`);
      
      if (buttons.length === 0) {
        config.smartLog('steps', 'No buttons found, stopping');
        break;
      }
      
      let button = buttons[0];
      config.smartLog('steps', `Best button: "${button.text}" (score: ${button.score})`);
      
      const buttonClicks = clickedButtons.get(button.buttonId) || 0;
      if (buttonClicks >= maxSameButtonClicks) {
        config.smartLog('steps', `Button "${button.text}" already clicked ${buttonClicks} times without significant changes`);
        
        let foundAlternative = false;
        for (let i = 1; i < buttons.length; i++) {
          const altButtonClicks = clickedButtons.get(buttons[i].buttonId) || 0;
          if (altButtonClicks < maxSameButtonClicks) {
            button = buttons[i];
            config.smartLog('steps', `Trying alternative button: "${button.text}"`);
            foundAlternative = true;
            break;
          }
        }
        
        if (!foundAlternative) {
          config.smartLog('steps', 'No viable alternative buttons found, stopping');
          break;
        }
      }
      
      await page.evaluate(coords => {
        window.scrollTo(0, coords.y - (window.innerHeight / 2));
      }, { y: button.y });
      
      await page.waitForTimeout(1000);
      
      let clicked = false;
      try {
        await page.click(button.selector, { timeout: 5000 });
        clicked = true;
        config.smartLog('steps', `Clicked button via selector: ${button.selector}`);
      } catch (e) {
        config.smartLog('retry', `Selector click failed: ${e.message}`);
      }
      
      if (!clicked) {
        try {
          await page.mouse.click(button.x, button.y);
          clicked = true;
          config.smartLog('steps', `Clicked button via coordinates: (${button.x}, ${button.y})`);
        } catch (e) {
          config.smartLog('retry', `Coordinate click failed: ${e.message}`);
        }
      }
      
      if (!clicked) {
        try {
          await page.evaluate(sel => {
            const el = document.querySelector(sel);
            if (el) el.click();
          }, button.selector);
          clicked = true;
          config.smartLog('steps', `Clicked button via JavaScript`);
        } catch (e) {
          config.smartLog('retry', `JavaScript click failed: ${e.message}`);
        }
      }
      
      if (clicked) {
        clickCount++;
        await page.waitForTimeout(3000);
        
        await this.scrollPage(page);
        
        const afterState = await getPageState();
        config.smartLog('steps', `After click: height=${afterState.height}, elements=${afterState.elements}, jobs=${afterState.jobCount}`);
        
        const heightChanged = Math.abs(afterState.height - beforeState.height) > 20;
        const elementsChanged = Math.abs(afterState.elements - beforeState.elements) > 10;
        const jobsChanged = afterState.jobCount !== beforeState.jobCount;
        
        const contentChanged = heightChanged || elementsChanged || jobsChanged;
        
        const contentIsNew = !pageStates.has(afterState.contentDigest);
        
        if (contentChanged && contentIsNew) {
          config.smartLog('win', 'New content detected!');
          consecutiveFailures = 0;
          
          pageStates.add(afterState.contentDigest);
          
          clickedButtons.set(button.buttonId, 1);
        } else {
          config.smartLog('fail', 'No new content detected');
          consecutiveFailures++;
          
          clickedButtons.set(button.buttonId, (clickedButtons.get(button.buttonId) || 0) + 1);
          
          if (!contentChanged) {
            consecutiveFailures++;
          }
        }
      } else {
        config.smartLog('fail', 'Failed to click button');
        consecutiveFailures++;
      }
    }
    
    config.smartLog('steps', `Clicked ${clickCount} show more buttons`);
  }

  async handlePagination(page) {
    config.smartLog('steps', 'Checking for pagination');
    
    const paginationSelectors = this.getPaginationSelectors();
    
    try {
      for (const selector of paginationSelectors) {
        const nextLinks = await page.$$(selector);
        for (const link of nextLinks) {
          const isVisible = await link.isVisible();
          let text = '';
          
          try {
            text = await link.textContent();
          } catch (e) {
            continue;
          }
          
          if (isVisible && (text.includes('Next') || text.includes('next') || /[>»]/.test(text))) {
            config.smartLog('steps', `Clicking pagination: ${text}`);
            try {
              await link.click();
              await page.waitForTimeout(3000);
              
              await this.scrollPage(page);
              await this.clickShowMoreButtons(page);
              
              return;
            } catch (clickError) {
              config.smartLog('retry', `Failed to click pagination: ${clickError.message}`);
              
              try {
                await page.evaluate(el => {
                  el.click();
                }, link);
                
                await page.waitForTimeout(3000);
                await this.scrollPage(page);
                await this.clickShowMoreButtons(page);
                return;
              } catch (jsClickError) {
                config.smartLog('retry', `JS pagination click also failed: ${jsClickError.message}`);
              }
            }
          }
        }
      }
    } catch (error) {
      config.smartLog('fail', `Error handling pagination: ${error.message}`);
    }
  }
  
  isResultValid(result) {
    if (!super.isResultValid(result)) return false;
    
    return (
      result.text.length >= 200 && 
      result.links.length >= 2
    );
  }
}

module.exports = HeadlessRenderingStep;