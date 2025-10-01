const { chromium } = require('playwright');
const cheerio = require('cheerio');
const path = require('path');
const fs = require('fs').promises;
const config = require('../config');
const { randomDelay, getRandomUserAgent } = require('../utils');
const dictionaries = require('../dictionaries');

class RobustScraper {
  constructor() {
    if (RobustScraper.instance) {
      return RobustScraper.instance;
    }
    
    this.browser = null;
    this.dictionary = null;
    this.initialized = false;
    
    RobustScraper.instance = this;
  }
  
  static getInstance() {
    if (!RobustScraper.instance) {
      RobustScraper.instance = new RobustScraper();
    }
    return RobustScraper.instance;
  }

  async initialize() {
    if (!this.browser) {
      this.browser = await chromium.launch({
        headless: true,
        args: [
          '--disable-blink-features=AutomationControlled',
          '--disable-features=IsolateOrigins,site-per-process',
          '--disable-automation',
          '--disable-dev-shm-usage',
          '--no-sandbox',
          '--disable-setuid-sandbox',
          '--disable-extensions',
          '--disable-component-extensions-with-background-pages',
          '--disable-default-apps',
          '--mute-audio',
          '--disable-notifications',
          '--disable-infobars',
          '--disable-translate'
        ],
        ignoreDefaultArgs: ['--enable-automation']
      });
    }
    return this.browser;
  }

  async initializeDictionary(page) {
    if (!this.dictionary) {
      this.dictionary = await dictionaries.getDictionary(page);
    }
  }

  async close() {
    if (this.browser) {
      await this.browser.close();
      this.browser = null;
    }
  }

  async detectBlockingContent(frame) {
    config.smartLog('scraper', 'Detection of blocking content (CAPTCHA, rate limiting, etc.)...');
    
    const blockingContentSelectors = this.dictionary.getBlockingContentSelectors();
    
    for (const selector of blockingContentSelectors) {
      try {
        const element = await frame.$(selector);
        if (element) {
          const isVisible = await element.isVisible();
          if (isVisible) {
            const text = await element.textContent().catch(() => '');
            config.smartLog('scraper', `Blocking content detected: ${text.substring(0, 100)}...`);
            return true;
          }
        }
      } catch (error) {
        continue;
      }
    }
    
    const pageContent = await frame.content().catch(() => '');
    const blockingKeywords = this.dictionary.getBlockingTextSelectors();
    
    const hasBlockingContent = blockingKeywords.some(keyword => 
      pageContent.toLowerCase().includes(keyword.toLowerCase())
    );
    
    if (hasBlockingContent) {
      config.smartLog('scraper', 'Blocking content detected via text analysis');
      return true;
    }
    
    return false;
  }

  async detectEmptyContent(frame) {
    config.smartLog('scraper', 'Checking for empty job content...');
    
    const emptyContentIndicators = this.dictionary.getEmptyContentIndicators();
    
    for (const selector of emptyContentIndicators) {
      try {
        const element = await frame.$(selector);
        if (element) {
          const isVisible = await element.isVisible();
          if (isVisible) {
            config.smartLog('scraper', 'Empty content indicator found');
            return true;
          }
        }
      } catch (error) {
        continue;
      }
    }
    
    const pageText = await frame.textContent().catch(() => '');
    const emptyPhrases = this.dictionary.getEmptyContentTextSelectors();
    
    const hasEmptyIndicator = emptyPhrases.some(phrase => 
      pageText.toLowerCase().includes(phrase.toLowerCase())
    );
    
    if (hasEmptyIndicator) {
      config.smartLog('scraper', 'Empty content detected via text analysis');
      return true;
    }
    
    return false;
  }

  async waitForDynamicContent(frame) {
    config.smartLog('scraper', 'Waiting for dynamic content to load...');
    
    const dynamicContentIndicators = this.dictionary.getDynamicContentIndicators();
    
    const hasDynamicIndicators = await frame.evaluate((indicators) => {
      return indicators.some(selector => {
        try {
          return document.querySelector(selector) !== null;
        } catch (e) {
          return false;
        }
      });
    }, dynamicContentIndicators);
    
    if (hasDynamicIndicators) {
      config.smartLog('scraper', 'Dynamic content indicators found, waiting longer...');
      await randomDelay(3000, 6000);
      
      await this.waitForLoadingToComplete(frame);
    }
  }

  async waitForLoadingToComplete(frame) {
    config.smartLog('scraper', 'Waiting for loading indicators to disappear...');
    
    const loadingIndicators = this.dictionary.getLoadingIndicators();
    let loadingFound = true;
    let attempts = 0;
    const maxAttempts = 10;
    
    while (loadingFound && attempts < maxAttempts) {
      loadingFound = false;
      
      for (const selector of loadingIndicators) {
        try {
          const element = await frame.$(selector);
          if (element) {
            const isVisible = await element.isVisible();
            if (isVisible) {
              loadingFound = true;
              config.smartLog('scraper', `Loading indicator still visible: ${selector}`);
              break;
            }
          }
        } catch (error) {
          continue;
        }
      }
      
      if (loadingFound) {
        await randomDelay(2000, 3000);
        attempts++;
      }
    }
    
    if (attempts >= maxAttempts) {
      config.smartLog('scraper', 'Loading indicators still present after maximum attempts');
    } else {
      config.smartLog('scraper', 'All loading indicators have disappeared');
    }
  }

  async detectJobPlatform(url, content) {
    const urlLower = url.toLowerCase();
    const contentLower = content.toLowerCase();
    
    const knownJobPlatforms = this.dictionary.getKnownJobPlatforms();
    
    for (const platform of knownJobPlatforms) {
      const urlMatch = platform.patterns.some(pattern => urlLower.includes(pattern.toLowerCase()));
      const contentMatch = platform.indicators.some(indicator => contentLower.includes(indicator.toLowerCase()));
      
      if (urlMatch || contentMatch) {
        config.smartLog('platform', `Job platform detected: ${platform.name}`);
        return platform;
      }
    }
    
    return null;
  }

  async isComplexDomain(url) {
    try {
      const hostname = new URL(url).hostname.toLowerCase();
      const complexDomains = this.dictionary.getComplexDomains();
      return complexDomains.some(domain => hostname.includes(domain.toLowerCase()));
    } catch (error) {
      return false;
    }
  }

  async handleJobviteIframe(frame) {
    config.smartLog('platform', `Jobvite iframe specific processing: ${frame.url()}`);
    
    try {
      await frame.waitForSelector('.jv-page-body', { timeout: 10000 })
        .catch(() => config.smartLog('platform', '.jv-page-body selector not found in Jobvite'));
        
      await frame.evaluate(() => {
        return new Promise((resolve) => {
          let totalHeight = 0;
          const distance = 300;
          let timer = setInterval(() => {
            window.scrollBy(0, distance);
            totalHeight += distance;
            
            if (totalHeight >= document.body.scrollHeight) {
              clearInterval(timer);
              resolve();
            }
          }, 200);
        });
      });
      
      await randomDelay(2000, 3000);
      
      const jobviteButtons = [
        'button.jv-button-primary', 
        'a.jv-button', 
        'button:has-text("View")',
        'button:has-text("show")',
        'button:has-text("more")',
        'button:has-text("Show All Jobs")',
        'button:has-text("View All Jobs")'
      ];
      
      for (const selector of jobviteButtons) {
        try {
          const buttons = await frame.$$(selector);
          for (const button of buttons) {
            const isVisible = await button.isVisible();
            if (isVisible) {
              const buttonText = await button.textContent().catch(() => selector);
              config.smartLog('platform', `Clicking Jobvite button: ${buttonText}`);
              await button.click().catch(e => config.smartLog('fail', `Click error: ${e.message}`));
              await randomDelay(2000, 4000);
            }
          }
        } catch (error) {
          continue;
        }
      }
      
      const jobLists = [
        '.jv-job-list', 
        '.jv-page .jv-wrapper',
        '.jv-job-list-inner',
        '.jv-job-list-container'
      ];
      
      for (const selector of jobLists) {
        try {
          const isPresent = await frame.$(selector);
          if (isPresent) {
            config.smartLog('platform', `Jobvite job list found: ${selector}`);
            break;
          }
        } catch (error) {
          continue;
        }
      }
      
      const content = await frame.content();
      return content;
    } catch (error) {
      config.smartLog('fail', `Error processing Jobvite iframe: ${error.message}`);
      try {
        return await frame.content();
      } catch (e) {
        config.smartLog('fail', `Unable to extract content: ${e.message}`);
        return null;
      }
    }
  }

  async scrapeCareerPage(url, options = {}) {
    config.smartLog('scraper', `Robust scraping of career page: ${url}`);
    
    const browser = await this.initialize();
    
    const defaultOptions = {
      clickShowMore: true,
      scrollFullPage: true,
      waitForJobListings: true,
      maxScrollAttempts: 15,
      maxClickAttempts: 10,
      timeout: 60000,
      bypassCSP: true,
      checkIframes: true,
      handlePlatformSpecific: true
    };
    
    const mergedOptions = { ...defaultOptions, ...options };
    
    let context;
    let page;
    let frameToUse = null;
    
    try {
      context = await browser.newContext({
        userAgent: getRandomUserAgent(),
        viewport: { width: 1920, height: 1080 },
        ignoreHTTPSErrors: true,
        locale: 'en-US',
        timezoneId: 'Europe/Paris',
        javaScriptEnabled: true,
        bypassCSP: mergedOptions.bypassCSP,
        hasTouch: false,
        permissions: ['geolocation'],
        colorScheme: 'light',
        extraHTTPHeaders: {
          'Accept-Language': 'en-US,en;q=0.9,fr;q=0.8,de;q=0.7,es;q=0.6,pt;q=0.5'
        }
      });
      
      await context.addInitScript(() => {
        Object.defineProperty(navigator, 'webdriver', { get: () => false });
        delete navigator.__proto__.webdriver;
        
        if (window.chrome) {
          window.chrome.runtime = window.chrome.runtime || {};
        }
        
        Object.defineProperty(navigator, 'plugins', {
          get: () => [
            { name: 'Chrome PDF Plugin', filename: 'internal-pdf-viewer' },
            { name: 'Chrome PDF Viewer', filename: 'mhjfbmdgcfjbbpaeojofohoefgiehjai' },
            { name: 'Native Client', filename: 'internal-nacl-plugin' }
          ]
        });
        
        const getParameter = WebGLRenderingContext.prototype.getParameter;
        WebGLRenderingContext.prototype.getParameter = function(parameter) {
          if (parameter === 37445) return 'Intel Inc.';
          if (parameter === 37446) return 'Intel Iris OpenGL Engine';
          return getParameter.apply(this, arguments);
        };
        
        if (window.navigator.permissions) {
          const originalQuery = window.navigator.permissions.query;
          window.navigator.permissions.query = (parameters) => (
            parameters.name === 'notifications' || 
            parameters.name === 'clipboard-read' || 
            parameters.name === 'clipboard-write' ?
            Promise.resolve({ state: 'prompt', onchange: null }) :
            originalQuery(parameters)
          );
        }
        
        Object.defineProperty(navigator, 'hardwareConcurrency', { get: () => 8 });
        Object.defineProperty(navigator, 'deviceMemory', { get: () => 8 });
        
        Object.defineProperty(window.screen, 'width', { get: () => 1920 });
        Object.defineProperty(window.screen, 'height', { get: () => 1080 });
        Object.defineProperty(window.screen, 'availWidth', { get: () => 1920 });
        Object.defineProperty(window.screen, 'availHeight', { get: () => 1040 });
        Object.defineProperty(window.screen, 'colorDepth', { get: () => 24 });
        Object.defineProperty(window.screen, 'pixelDepth', { get: () => 24 });
        
        const originalToDataURL = HTMLCanvasElement.prototype.toDataURL;
        HTMLCanvasElement.prototype.toDataURL = function(type) {
          if (type === 'image/png' && this.width === 16 && this.height === 16) {
            return 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAABmklEQVQ4jY2TP2hTURTGf+e+l/deaNo0xcYkCjFgJjvULlZEHKQdnETBCoKbXQRx7aKTY7GDmbooFJy6KH2gBQWlgloKFrpi0ISCQqza5p97nNonf0z94DDcw3e+73z3HD5+PzJnQ2naSIvJZgRAoC0HBQYEhBAYjsF0DIaEQOAYAYRmAZVOGUUbXQLYZgmk0pMv9Jg9vAMAXuvj7ds0jVQpXpoFrAO8VlUD+ObuG97dfQfA0plFrq1cEwCXZgG1n+vqd9e9PTl7EoB7j+6rX9fY2W7z4+OaunR9+foY4LOA/RcvqxeXV8hn84j/nE4m6XY/sbK6onMnzsWhg9PAHIDVnSV1w1vg+f0XMS6UPsWBbBYArVWCwMNoVIzjjgKhR6Ndl3QPE63XGW3FqVcbcQA6A6A2K1b7/Q2y3W6MkwSBR6PRoNVqxbFLo4DcxatyvVxE9PsY/SFSSpTsIaVHr9cjmUyxsfGW09msujAPHAGsmbm8lS6e1tl8gXTGRUoP3w/odIb4/oB2u82XrS3W1z7oBwsAH34DDFynjXsva0YAAAAASUVORK5CYII=';
          }
          return originalToDataURL.apply(this, arguments);
        };
        
        if (window.self !== window.top) {
          Object.defineProperty(window, 'parent', { get: () => window });
          Object.defineProperty(window, 'top', { get: () => window });
        }
      });
      
      await context.route('**/*.{png,jpg,jpeg,gif,webp,svg,mp4,webm,ogg,mp3,wav,pdf,doc,docx,xls,xlsx}', route => {
        if (Math.random() < 0.1) {
          route.continue();
        } else {
          route.abort();
        }
      });
      
      page = await context.newPage();
      
      await this.initializeDictionary(page);
      
      if (!mergedOptions.jobTerms) {
        mergedOptions.jobTerms = this.dictionary.getJobTerms();
      }
      
      page.setDefaultTimeout(mergedOptions.timeout);
      page.setDefaultNavigationTimeout(mergedOptions.timeout);
      
      page.on('console', msg => {
        if (msg.type() === 'error') {
          config.smartLog('fail', `Page error: ${msg.text()}`);
        }
      });
      
      let navigationSuccess = false;
      
      try {
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
        navigationSuccess = true;
      } catch (error) {
        config.smartLog('scraper', 'First navigation attempt failed, trying with networkidle...');
      }
      
      if (!navigationSuccess) {
        try {
          await page.goto(url, { waitUntil: 'networkidle', timeout: 45000 });
          navigationSuccess = true;
        } catch (error) {
          config.smartLog('scraper', 'Second navigation attempt failed, trying with load...');
        }
      }
      
      if (!navigationSuccess) {
        try {
          await page.goto(url, { waitUntil: 'load', timeout: 60000 });
          navigationSuccess = true;
        } catch (error) {
          config.smartLog('scraper', 'Third navigation attempt failed, last attempt without waiting...');
          await page.goto(url, { timeout: 90000 });
        }
      }
      
      await randomDelay(2000, 5000);
      
      const isBlocked = await this.detectBlockingContent(page);
      if (isBlocked) {
        config.smartLog('scraper', 'Blocking content detected (CAPTCHA, rate limiting, etc.)');
        return {
          url,
          title: 'Blocked Content',
          text: '',
          links: [],
          scrapedAt: new Date().toISOString(),
          method: 'blocked',
          error: 'Content blocked by security measures'
        };
      }
      
      await this.waitForDynamicContent(page);
      
      if (mergedOptions.checkIframes) {
        frameToUse = await this.findRelevantFrame(page, mergedOptions);
      }
      
      if (frameToUse) {
        config.smartLog('scraper', `Using iframe for scraping: ${frameToUse.url()}`);
        
        const frameUrl = frameToUse.url();
        if (frameUrl.includes('jobvite.com')) {
          config.smartLog('platform', 'Jobvite iframe detected, using specific processing');
          
          const jobviteContent = await this.handleJobviteIframe(frameToUse);
          
          if (jobviteContent) {
            const $ = cheerio.load(jobviteContent);
            
            let jobviteText = '';
            
            $('.jv-job-list, .jv-wrapper, .jv-page-body').each((i, el) => {
              jobviteText += $(el).text().replace(/\s+/g, ' ').trim() + ' ';
            });
            
            const jobviteLinks = [];
            $('a.jv-job-list-name, a.jv-button, a[href*="job"], a[href*="apply"]').each((i, el) => {
              const href = $(el).attr('href');
              const text = $(el).text().trim();
              
              if (href && text.length > 0) {
                let fullUrl = href;
                if (href.startsWith('/')) {
                  try {
                    const frameUrlObj = new URL(frameUrl);
                    fullUrl = `${frameUrlObj.protocol}//${frameUrlObj.host}${href}`;
                  } catch (e) {
                    return;
                  }
                } else if (!href.startsWith('http')) {
                  if (href.startsWith('#') || href.startsWith('javascript:')) {
                    return;
                  }
                  try {
                    fullUrl = new URL(href, frameUrl).href;
                  } catch (e) {
                    return;
                  }
                }
                
                jobviteLinks.push({
                  url: fullUrl,
                  text: text.replace(/\s+/g, ' ').trim(),
                  isJobPosting: true
                });
              }
            });
            
            if (jobviteText.length > 100 || jobviteLinks.length > 0) {
              const pageTitle = $('title').text().trim();
              
              const result = {
                url,
                title: pageTitle || 'Jobvite Career Page',
                text: jobviteText,
                links: jobviteLinks,
                scrapedAt: new Date().toISOString(),
                method: 'jobvite-iframe-extraction'
              };
              
              config.smartLog('platform', `Jobvite extraction successful: text=${jobviteText.length} characters, links=${jobviteLinks.length}`);
              return result;
            }
          }
        }
      }
      
      const activeFrame = frameToUse || page;
      
      if (mergedOptions.handlePlatformSpecific) {
        const content = await activeFrame.content();
        const detectedPlatform = await this.detectJobPlatform(url, content);
        
        if (detectedPlatform) {
          config.smartLog('platform', `Detected platform: ${detectedPlatform.name}, applying specific handling`);
          
          if (detectedPlatform.iframeMethod && !frameToUse) {
            config.smartLog('platform', 'Platform requires iframe handling, searching for relevant iframes...');
            frameToUse = await this.findRelevantFrame(page, mergedOptions);
            if (frameToUse) {
              config.smartLog('platform', 'Relevant iframe found for platform-specific processing');
            }
          }
        }
      }
      
      await this.acceptCookiesIfPresent(activeFrame);
      
      await randomDelay(2000, 4000);
      
      await this.exploreJobButtons(activeFrame, mergedOptions);
      
      if (mergedOptions.scrollFullPage) {
        await this.scrollFullPage(activeFrame, mergedOptions);
      }
      
      if (mergedOptions.clickShowMore) {
        await this.clickAllShowMoreButtons(activeFrame, mergedOptions);
      }
      
      if (mergedOptions.waitForJobListings) {
        await this.waitForJobListings(activeFrame, mergedOptions);
      }
      
      await this.clickAllShowMoreButtons(activeFrame, mergedOptions);
      
      await this.scrollFullPage(activeFrame, { maxScrollAttempts: 5 });
      
      const isEmpty = await this.detectEmptyContent(activeFrame);
      if (isEmpty) {
        config.smartLog('scraper', 'Empty content detected - no jobs found');
        return {
          url,
          title: 'No Jobs Found',
          text: 'No job listings were found on this page',
          links: [],
          scrapedAt: new Date().toISOString(),
          method: 'empty-content-detected'
        };
      }
      
      if (config.shouldExportDebug(null, null)) {
        const screenshot = await page.screenshot({ fullPage: true });
        const debugFilename = `debug-${new URL(url).hostname}-${Date.now()}.png`;
        await fs.writeFile(path.join(config.DEBUG_DIR, debugFilename), screenshot);
        
        const html = await page.content();
        await fs.writeFile(
          path.join(config.DEBUG_DIR, `debug-${new URL(url).hostname}-${Date.now()}.html`), 
          html
        );
      }
      
      const content = await activeFrame.content();
      const $ = cheerio.load(content);
      
      const pageTitle = $('title').text().trim();
      
      const pageText = $('body')
        .clone()
        .find('script, style, noscript, iframe, svg')
        .remove()
        .end()
        .text()
        .replace(/\s+/g, ' ')
        .trim();
      
      const links = [];
      
      const jobSections = await this.identifyJobSections($, mergedOptions);
      
      if (jobSections.length > 0) {
        config.smartLog('scraper', `Job sections identified: ${jobSections.length}`);
        
        for (const section of jobSections) {
          $(section).find('a').each((i, el) => {
            const href = $(el).attr('href');
            const text = $(el).text().trim();
            
            if (href && text.length > 0) {
              let fullUrl = href;
              if (href.startsWith('/')) {
                try {
                  const urlObj = new URL(url);
                  fullUrl = `${urlObj.protocol}//${urlObj.host}${href}`;
                } catch (e) {
                  return;
                }
              } else if (!href.startsWith('http')) {
                if (href.startsWith('#') || href.startsWith('javascript:')) {
                  return;
                }
                try {
                  fullUrl = new URL(href, url).href;
                } catch (e) {
                  return;
                }
              }
              
              const isJobPosting = this.isLikelyJobPosting($(el), text, href, mergedOptions);
              
              links.push({
                url: fullUrl,
                text: text.replace(/\s+/g, ' ').trim(),
                isJobPosting
              });
            }
          });
        }
      } else {
        config.smartLog('scraper', "No specific job sections identified, analyzing all links...");
        
        $('a').each((i, el) => {
          const href = $(el).attr('href');
          const text = $(el).text().trim();
          
          if (href && text.length > 0) {
            let fullUrl = href;
            if (href.startsWith('/')) {
              try {
                const urlObj = new URL(url);
                fullUrl = `${urlObj.protocol}//${urlObj.host}${href}`;
              } catch (e) {
                return;
              }
            } else if (!href.startsWith('http')) {
              if (href.startsWith('#') || href.startsWith('javascript:')) {
                return;
              }
              try {
                fullUrl = new URL(href, url).href;
              } catch (e) {
                return;
              }
            }
            
            const isJobPosting = this.isLikelyJobPosting($(el), text, href, mergedOptions);
            
            links.push({
              url: fullUrl,
              text: text.replace(/\s+/g, ' ').trim(),
              isJobPosting
            });
          }
        });
      }
      
      config.smartLog('scraper', `Total ${links.length} links extracted, including ${links.filter(l => l.isJobPosting).length} probable job postings`);
      
      return {
        url,
        title: pageTitle,
        text: pageText,
        links,
        scrapedAt: new Date().toISOString(),
        method: 'robust-scraper'
      };
      
    } catch (error) {
      config.smartLog('fail', `Error during robust scraping of ${url}: ${error.message}`);
      
      if (config.shouldExportDebug(null, error)) {
        try {
          const screenshot = await page.screenshot({ fullPage: true });
          await fs.writeFile(path.join(config.DEBUG_DIR, `error-${new URL(url).hostname}-${Date.now()}.png`), screenshot);
          
          const html = await page.content();
          await fs.writeFile(
            path.join(config.DEBUG_DIR, `error-${new URL(url).hostname}-${Date.now()}.html`), 
            html
          );
        } catch (debugError) {
          config.smartLog('fail', 'Error saving debug information: ' + debugError.message);
        }
      }
      
      return null;
    } finally {
      try {
        if (page) {
          await page.close();
          config.smartLog('scraper', 'Page closed successfully');
        }
      } catch (pageError) {
        config.smartLog('fail', `Error closing page: ${pageError.message}`);
      }
      
      try {
        if (context) {
          await context.close();
          config.smartLog('scraper', 'Context closed successfully');
        }
      } catch (contextError) {
        config.smartLog('fail', `Error closing context: ${contextError.message}`);
      }
      
      if (page && !page.isClosed()) {
        config.smartLog('fail', 'WARNING: Page still open after close attempt');
      }
    }
  }
  
  async findRelevantFrame(page, options) {
    const frames = page.frames();
    config.smartLog('scraper', `Checking ${frames.length - 1} potential iframes...`);

    if (frames.length <= 1) {
      return null;
    }
    
    for (const frame of frames.slice(1)) {
      try {
        const frameUrl = frame.url();
        if (!frameUrl || frameUrl === 'about:blank') continue;
        
        config.smartLog('scraper', `Checking iframe: ${frameUrl}`);
        
        const isJobRelatedUrl = options.jobTerms.some(term => frameUrl && frameUrl.toLowerCase().includes(term.toLowerCase()));

        if (isJobRelatedUrl) {
          config.smartLog('scraper', `Relevant iframe found (URL contains job terms): ${frameUrl}`);
          return frame;
        }
        
        const frameContent = await frame.content().catch(() => '');
        const hasJobRelatedContent = options.jobTerms.some(term => 
          frameContent.toLowerCase().includes(term.toLowerCase())
        );
        
        if (hasJobRelatedContent) {
          config.smartLog('scraper', `Relevant iframe found (job-related content): ${frameUrl}`);
          return frame;
        }
        
        const hasJobElements = await frame.$$eval('a, div, li, tr', (elements, terms) => {
          return elements.some(el => {
            const text = el.textContent.toLowerCase();
            return terms.some(term => text.includes(term.toLowerCase()));
          });
        }, options.jobTerms).catch(() => false);
        
        if (hasJobElements) {
          config.smartLog('scraper', `Relevant iframe found (job elements detected): ${frameUrl}`);
          return frame;
        }
      } catch (error) {
        config.smartLog('scraper', `Error analyzing iframe: ${error.message}`);
      }
    }
    
    const knownPlatforms = this.dictionary.getKnownJobPlatforms().map(platform => platform.name.toLowerCase());
    
    for (const frame of frames.slice(1)) {
      try {
        const frameUrl = frame.url();
        if (!frameUrl) continue;
        
        if (knownPlatforms.some(platform => frameUrl.toLowerCase().includes(platform))) {
          config.smartLog('platform', `Known job platform iframe found: ${frameUrl}`);
          return frame;
        }
      } catch (error) {
        continue;
      }
    }
    
    config.smartLog('scraper', "No relevant iframe found, using main page");
    return null;
  }
  
  async acceptCookiesIfPresent(frame) {
    config.smartLog('scraper', 'Checking for cookie banners...');
    
    const cookieSelectors = this.dictionary.getCookieSelectors();
    
    for (const selector of cookieSelectors) {
      try {
        const visible = await frame.isVisible(selector, { timeout: 5000 });
        if (visible) {
          config.smartLog('scraper', `Cookie banner found: ${selector}`);
          
          if (selector.startsWith('iframe')) {
            const frames = frame.childFrames();
            for (const childFrame of frames) {
              try {
                const title = await childFrame.title().catch(() => '');
                const url = childFrame.url();
                if (title.toLowerCase().includes('cookie') || 
                    title.toLowerCase().includes('consent') || 
                    url.toLowerCase().includes('cookie') || 
                    url.toLowerCase().includes('consent')) {
                  
                  config.smartLog('scraper', `Attempting cookie management in iframe: ${title || url}`);
                  
                  for (const btnSelector of cookieSelectors.filter(s => !s.startsWith('iframe'))) {
                    try {
                      const btnVisible = await childFrame.isVisible(btnSelector, { timeout: 2000 });
                      if (btnVisible) {
                        await childFrame.click(btnSelector);
                        config.smartLog('scraper', `Cookies accepted in iframe with selector: ${btnSelector}`);
                        await randomDelay(1000, 2000);
                        return;
                      }
                    } catch (e) {
                      continue;
                    }
                  }
                }
              } catch (frameError) {
                continue;
              }
            }
          } else {
            await randomDelay(500, 1500);
            
            try {
              await frame.click(selector, { force: false, timeout: 5000 });
              config.smartLog('scraper', 'Cookies accepted with standard click');
              await randomDelay(1000, 2000);
              return;
            } catch (clickError) {
              config.smartLog('scraper', 'Standard click failed, trying JS: ' + clickError.message);
              
              await frame.evaluate((sel) => {
                const elements = document.querySelectorAll(sel);
                for (const el of elements) {
                  if (el && el.offsetParent !== null) {
                    el.click();
                    return true;
                  }
                }
                return false;
              }, selector);
              
              config.smartLog('scraper', 'JS click attempt made');
              await randomDelay(1000, 2000);
              return;
            }
          }
        }
      } catch (error) {
        continue;
      }
    }
    
    config.smartLog('scraper', 'No cookie banners detected or they were automatically accepted');
  }
  
  async exploreJobButtons(frame, options) {
    config.smartLog('scraper', 'Exploring relevant buttons for job listings...');
    
    const jobNavigationSelectors = this.dictionary.getJobNavigationSelectors();
    
    for (const selector of jobNavigationSelectors) {
      try {
        const elements = await frame.$$(selector);
        
        for (const element of elements) {
          try {
            const isVisible = await element.isVisible();
            if (!isVisible) continue;
            
            config.smartLog('scraper', `Job navigation button found`);
            
            await element.scrollIntoViewIfNeeded();
            await randomDelay(500, 1000);
            
            const href = await element.getAttribute('href');
            
            if (href) {
              if (href.startsWith('#')) {
                config.smartLog('scraper', `Clicking internal anchor`);
                await element.click();
                await randomDelay(2000, 3000);
              } 
              else if (href.startsWith('http') || href.startsWith('/')) {
                try {
                  await element.click();
                  await randomDelay(3000, 5000);
                } catch (clickError) {
                  config.smartLog('scraper', `Click error: ${clickError.message}`);
                }
              }
            } else {
              config.smartLog('scraper', `Clicking navigation button`);
              await element.click();
              await randomDelay(3000, 5000);
            }
          } catch (elementError) {
            config.smartLog('scraper', `Error interacting with element: ${elementError.message}`);
          }
        }
      } catch (selectorError) {
        continue;
      }
    }
    
    config.smartLog('scraper', 'Button exploration completed');
  }
  
  async clickAllShowMoreButtons(frame, options) {
    config.smartLog('scraper', 'Looking for "Show more" buttons...');
    
    const showMoreSelectors = this.dictionary.getShowMoreSelectors();
    const clickedButtons = new Set();
    let clickCount = 0;
    const maxClicks = options.maxClickAttempts || 10;
    
    for (let attempt = 0; attempt < 3; attempt++) {
      let buttonFound = false;
      
      for (const selector of showMoreSelectors) {
        try {
          const elements = await frame.$$(selector);
          
          for (const element of elements) {
            try {
              const isVisible = await element.isVisible();
              if (!isVisible) continue;
              
              const elementText = await element.textContent();
              const lowerText = elementText.toLowerCase().trim();
              
              const isShowMoreButton = this.isShowMoreButton(lowerText);
              
              if (isShowMoreButton) {
                const boundingBox = await element.boundingBox();
                if (!boundingBox) continue;
                
                const elementId = `${lowerText}-${boundingBox.x}-${boundingBox.y}`;
                
                if (clickedButtons.has(elementId)) continue;
                
                config.smartLog('scraper', `"Show more" button found: "${elementText}"`);
                
                await element.scrollIntoViewIfNeeded();
                await randomDelay(500, 1000);
                
                try {
                  await element.click();
                  config.smartLog('scraper', `Successfully clicked "${elementText}"`);
                  clickedButtons.add(elementId);
                  buttonFound = true;
                  clickCount++;
                  await randomDelay(3000, 5000);
                } catch (clickError) {
                  config.smartLog('scraper', `Standard click error: ${clickError.message}`);
                  
                  try {
                    await frame.evaluate(el => {
                      el.click();
                    }, element);
                    
                    config.smartLog('scraper', `JS click successful on "${elementText}"`);
                    clickedButtons.add(elementId);
                    buttonFound = true;
                    clickCount++;
                    await randomDelay(3000, 5000);
                  } catch (jsClickError) {
                    config.smartLog('scraper', `JS click failed: ${jsClickError.message}`);
                  }
                }
                
                if (clickCount >= maxClicks) {
                  config.smartLog('scraper', `Maximum ${maxClicks} clicks reached`);
                  break;
                }
              }
            } catch (elementError) {
              continue;
            }
          }
          
          if (clickCount >= maxClicks) break;
        } catch (selectorError) {
          continue;
        }
      }
      
      if (!buttonFound) {
        await frame.evaluate(() => {
          window.scrollBy(0, 300);
        });
        await randomDelay(2000, 3000);
      } else {
        await randomDelay(2000, 4000);
      }
      
      if (clickCount >= maxClicks) break;
    }
    
    config.smartLog('scraper', `Total ${clickCount} "Show more" buttons clicked`);
  }

  isShowMoreButton(text) {
    const buttonPatterns = this.dictionary.getButtonPatterns();
    const patterns = Object.values(buttonPatterns.positive);
    
    for (const patternGroup of patterns) {
      if (Array.isArray(patternGroup)) {
        if (patternGroup.some(pattern => text.includes(pattern))) {
          return true;
        }
      } else if (patternGroup instanceof RegExp) {
        if (patternGroup.test(text)) {
          return true;
        }
      }
    }
    
    const negativePatterns = Object.values(buttonPatterns.negative);
    for (const patternGroup of negativePatterns) {
      if (Array.isArray(patternGroup)) {
        if (patternGroup.some(pattern => text.includes(pattern))) {
          return false;
        }
      } else if (patternGroup instanceof RegExp) {
        if (patternGroup.test(text)) {
          return false;
        }
      }
    }
    
    const showMorePatterns = this.dictionary.getShowMorePatterns();
    return showMorePatterns.regex.test(text);
  }

  async scrollFullPage(frame, options) {
    config.smartLog('scraper', 'Scrolling page to load all content...');
    
    let previousHeight = 0;
    let noChangeCount = 0;
    const maxScrollAttempts = options.maxScrollAttempts;
    
    for (let i = 0; i < maxScrollAttempts; i++) {
      const currentHeight = await frame.evaluate(() => document.body.scrollHeight);
      
      if (currentHeight === previousHeight) {
        noChangeCount++;
        if (noChangeCount >= 3) {
          config.smartLog('scraper', 'Page height no longer changing, ending scroll');
          break;
        }
      } else {
        noChangeCount = 0;
      }
      
      previousHeight = currentHeight;
      
      await frame.evaluate(() => {
        const scrollDistance = 100 + Math.floor(Math.random() * 300);
        const horizontalVariation = Math.random() * 10 - 5;
        window.scrollBy(horizontalVariation, scrollDistance);
      });
      
      await randomDelay(300, 800);
      
      if (Math.random() < 0.2) {
        config.smartLog('scraper', 'Reading pause during scroll...');
        await randomDelay(1500, 3000);
        
        if (Math.random() < 0.3) {
          await frame.evaluate(() => {
            window.scrollBy(0, -50 - Math.random() * 150);
          });
          await randomDelay(500, 1000);
        }
      }
      
      const loadingIndicators = this.dictionary.getLoadingIndicators();
      const hasLoadingIndicator = await frame.evaluate((indicators) => {
        return indicators.some(selector => {
          try {
            const elements = document.querySelectorAll(selector);
            return elements.length > 0;
          } catch (e) {
            return false;
          }
        });
      }, loadingIndicators);
      
      if (hasLoadingIndicator) {
        config.smartLog('scraper', 'Loading indicator detected, additional waiting...');
        await randomDelay(2000, 4000);
      }
    }
    
    await frame.evaluate(() => {
      window.scrollTo({
        top: 0,
        behavior: 'smooth'
      });
    });
    
    config.smartLog('scraper', 'Page scrolling completed');
  }
  
  async waitForJobListings(frame, options) {
    config.smartLog('scraper', 'Waiting for job listings...');
    
    const jobListingSelectors = this.dictionary.getJobListingSelectors();
    
    for (const selector of jobListingSelectors) {
      try {
        const elements = await frame.$$(selector);
        if (elements.length > 0) {
          config.smartLog('scraper', `Found ${elements.length} job listings with selector: ${selector}`);
          
          await randomDelay(2000, 4000);
          return;
        }
      } catch (error) {
        continue;
      }
    }
    
    try {
      const jobLinks = await frame.$$eval('a', (links, jobKeywords) => {
        return links.filter(link => {
          const text = link.textContent.toLowerCase();
          const href = link.href.toLowerCase();
          
          return jobKeywords.some(term => 
            text.includes(term.toLowerCase()) || 
            href.includes(term.toLowerCase())
          );
        }).length;
      }, options.jobTerms);
      
      if (jobLinks > 0) {
        config.smartLog('scraper', `Found ${jobLinks} links possibly related to job postings`);
        return;
      }
    } catch (error) {
      config.smartLog('scraper', 'Error searching for job links: ' + error.message);
    }
    
    config.smartLog('scraper', 'No job listings detected with standard selectors');
    
    await randomDelay(3000, 5000);
  }
  
  identifyJobSections($, options) {
    config.smartLog('scraper', 'Identifying sections containing job listings...');
    
    const jobSections = [];
    
    $('[id*="job"], [id*="career"], [id*="vacancy"], [class*="job"], [class*="career"], [class*="vacancy"]').each((i, el) => {
      jobSections.push(el);
    });
    
    $('ul, ol, div, section, table').each((i, el) => {
      const links = $(el).find('a');
      
      if (links.length >= 3) {
        let jobLinkCount = 0;
        
        links.each((j, link) => {
          const text = $(link).text().toLowerCase();
          const href = $(link).attr('href') || '';
          
          const isJobLink = options.jobTerms.some(term => 
            text.includes(term.toLowerCase()) || 
            href.toLowerCase().includes(term.toLowerCase())
          );
          
          if (isJobLink) {
            jobLinkCount++;
          }
        });
        
        if (jobLinkCount >= Math.max(2, links.length * 0.25)) {
          jobSections.push(el);
        }
      }
    });
    
    $('h1, h2, h3, h4, h5, h6').each((i, el) => {
      const headingText = $(el).text().toLowerCase();
      
      const isJobHeading = options.jobTerms.some(term => 
        headingText.includes(term.toLowerCase())
      );
      
      if (isJobHeading) {
        const parent = $(el).parent();
        if (parent.length > 0) {
          jobSections.push(parent[0]);
        }
      }
    });
    
    const uniqueSections = [];
    const isDescendant = (parent, child) => {
      return $(parent).find(child).length > 0;
    };
    
    for (let i = 0; i < jobSections.length; i++) {
      let isChildOfExisting = false;
      
      for (let j = 0; j < uniqueSections.length; j++) {
        if (isDescendant(uniqueSections[j], jobSections[i])) {
          isChildOfExisting = true;
          break;
        }
      }
      
      if (!isChildOfExisting) {
        const childIndices = [];
        
        for (let j = 0; j < uniqueSections.length; j++) {
          if (isDescendant(jobSections[i], uniqueSections[j])) {
            childIndices.push(j);
          }
        }
        
        for (let j = childIndices.length - 1; j >= 0; j--) {
          uniqueSections.splice(childIndices[j], 1);
        }
        
        uniqueSections.push(jobSections[i]);
      }
    }
    
    config.smartLog('scraper', `${uniqueSections.length} job sections identified`);
    return uniqueSections;
  }
  
  isLikelyJobPosting(element, text, href, options) {
    const lowerText = text.toLowerCase();
    if (options.jobTerms.some(keyword => lowerText.includes(keyword.toLowerCase()))) {
      return true;
    }
    
    const lowerHref = href.toLowerCase();
    if (options.jobTerms.some(keyword => lowerHref.includes(keyword.toLowerCase()))) {
      return true;
    }
    
    try {
      const id = element.attr('id') || '';
      const className = element.attr('class') || '';
      
      if (options.jobTerms.some(keyword => 
        id.toLowerCase().includes(keyword.toLowerCase()) || 
        className.toLowerCase().includes(keyword.toLowerCase())
      )) {
        return true;
      }
      
      const dataAttributes = {};
      
      element.each((i, el) => {
        if (el.attribs) {
          Object.keys(el.attribs).forEach(attr => {
            if (attr.startsWith('data-')) {
              dataAttributes[attr] = el.attribs[attr];
            }
          });
        }
      });
      
      for (const [key, value] of Object.entries(dataAttributes)) {
        if (options.jobTerms.some(keyword => 
          key.toLowerCase().includes(keyword.toLowerCase()) || 
          value.toLowerCase().includes(keyword.toLowerCase())
        )) {
          return true;
        }
      }
      
      const ariaLabel = element.attr('aria-label') || '';
      if (options.jobTerms.some(keyword => ariaLabel.toLowerCase().includes(keyword.toLowerCase()))) {
        return true;
      }
      
      const title = element.attr('title') || '';
      if (options.jobTerms.some(keyword => title.toLowerCase().includes(keyword.toLowerCase()))) {
        return true;
      }
      
      const parentText = element.parent().text().toLowerCase() || '';
      if (options.jobTerms.some(keyword => parentText.includes(keyword.toLowerCase()))) {
        return true;
      }
      
      const containsLocationIndicators = element.find('.location, [class*="location"], [data-location]').length > 0;
      const containsDateIndicators = element.find('.date, [class*="date"], [data-date]').length > 0;
      const containsDepartmentIndicators = element.find('.department, [class*="department"], [data-department]').length > 0;
      
      if (containsLocationIndicators || containsDateIndicators || containsDepartmentIndicators) {
        return true;
      }
      
      const nextElement = element.next();
      const prevElement = element.prev();
      
      if (nextElement.length > 0) {
        const nextText = nextElement.text().toLowerCase();
        if (options.jobTerms.some(keyword => nextText.includes(keyword.toLowerCase()))) {
          return true;
        }
      }
      
      if (prevElement.length > 0) {
        const prevText = prevElement.text().toLowerCase();
        if (options.jobTerms.some(keyword => prevText.includes(keyword.toLowerCase()))) {
          return true;
        }
      }
    } catch (error) {
    }
    
    try {
      if (href) {
        const jobURLPatterns = this.dictionary.getJobURLPatterns();
        const jobDetailURLPatterns = this.dictionary.getJobDetailURLPatterns();
        
        if (jobURLPatterns.some(pattern => pattern.test(href))) {
          return true;
        }
        
        if (jobDetailURLPatterns.some(pattern => pattern.test(href))) {
          return true;
        }
        
        const hasJobIDPattern = /\/(job|position|opening|vacancy)\/\d+/i.test(href);
        if (hasJobIDPattern) {
          return true;
        }
      }
    } catch (error) {
    }
    
    return false;
  }
}

RobustScraper.instance = null;

module.exports = RobustScraper;