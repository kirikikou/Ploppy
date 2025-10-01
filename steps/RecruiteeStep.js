const { chromium } = require('playwright');
const cheerio = require('cheerio');
const path = require('path');
const fs = require('fs').promises;
const BaseScraperStep = require('./BaseScraperStep');
const { randomDelay, getRandomUserAgent } = require('../../utils');
const { extractContentFromCheerio } = require('../helpers');
const config = require('../../config');
const platformDetector = require('../platformDetector');

class RecruiteeStep extends BaseScraperStep {
  constructor() {
    super('recruitee-step', 1);
    this.browser = null;
    this.domObserver = null;
    this.newJobsDetected = 0;
  }

  async isApplicable(url, prevStepResult = {}) {
    const detectedPlatform = platformDetector.detectPlatform(url);
    if (detectedPlatform === 'Recruitee') return true;
    
    return url.includes('recruitee.com') || url.includes('d10zminp1cyta8.cloudfront.net');
  }

  async initialize() {
    if (!this.browser) {
      this.browser = await chromium.launch({
        headless: true,
        args: [
          ...config.playwrightArgs,
          '--disable-blink-features=AutomationControlled',
          '--disable-background-timer-throttling',
          '--disable-backgrounding-occluded-windows',
          '--disable-renderer-backgrounding'
        ]
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
    config.smartLog('steps', `Starting Recruitee-specific scraping for ${url}`);
    
    if (options.dictionary) {
      this.setDictionary(options.dictionary);
    }
    
    const dict = this.getDictionary();
    config.smartLog('langue', `Dictionary language: ${dict.getCurrentLanguage()}`);
    
    const startTime = Date.now();
    const maxExecutionTime = Math.max(options.timeout || 25000, 25000);
    
    config.smartLog('timeout', `Max execution time: ${maxExecutionTime}ms`);

    let result = null;
    let scrapingError = null;

    try {
      await this.initialize();
      
      const context = await this.browser.newContext({
        userAgent: getRandomUserAgent(),
        viewport: { width: 1920, height: 1080 },
        ignoreHTTPSErrors: true,
        javaScriptEnabled: true,
        bypassCSP: true
      });

      await context.addInitScript(() => {
        Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
        window.chrome = { runtime: {} };
      });

      const page = await context.newPage();
      page.setDefaultTimeout(12000);

      try {
        config.smartLog('steps', `Navigating to ${url}`);
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 12000 });

        await this.handleInitialLoad(page, url);
        
        const timeRemaining = maxExecutionTime - (Date.now() - startTime);
        config.smartLog('timeout', `Time remaining for content expansion: ${timeRemaining}ms`);
        
        if (timeRemaining > 6000) {
          await this.handleRecruiteeContent(page, timeRemaining);
        } else {
          config.smartLog('timeout', `Insufficient time remaining, skipping content expansion`);
        }

        config.smartLog('steps', `Total new jobs detected: ${this.newJobsDetected}`);

        const bodyHTML = await page.evaluate(() => {
          const body = document.querySelector('body');
          if (!body) return '';
          
          const clonedBody = body.cloneNode(true);
          const toRemove = clonedBody.querySelectorAll('script, style, noscript, nav, header, footer, aside');
          toRemove.forEach(el => el.remove());
          
          return clonedBody.innerHTML;
        });

        const $ = cheerio.load(`<body>${bodyHTML}</body>`);
        const extracted = extractContentFromCheerio($, url);

        result = {
          url,
          title: extracted.title || await page.title(),
          text: extracted.text,
          links: extracted.links,
          scrapedAt: new Date().toISOString(),
          method: this.name,
          detectedPlatform: 'Recruitee',
          expandedJobs: this.newJobsDetected
        };

        if (config.shouldExportDebug(result, scrapingError, this.name)) {
          const debugPromises = [
            page.screenshot({ fullPage: false }).then(screenshot => 
              fs.writeFile(
                path.join(config.DEBUG_DIR, `${this.name}-FAIL-${new URL(url).hostname}-${Date.now()}.png`), 
                screenshot
              )
            ).catch(() => {}),
            fs.writeFile(
              path.join(config.DEBUG_DIR, `${this.name}-FAIL-${new URL(url).hostname}-${Date.now()}.html`), 
              bodyHTML
            ).catch(() => {})
          ];
          await Promise.all(debugPromises).catch(() => {});
        }

      } catch (error) {
        config.smartLog('fail', `Error during scraping: ${error.message}`);
        scrapingError = error;
      } finally {
        await page.close();
        await context.close();
      }

      if (this.isResultValid(result)) {
        config.smartLog('win', `Successfully scraped ${url} with ${result.links.length} links and ${this.newJobsDetected} expanded jobs`);
        return result;
      }

      config.smartLog('fail', `Invalid result for ${url}`);
      scrapingError = new Error('Invalid result');
      return null;

    } catch (error) {
      config.smartLog('fail', `Critical error: ${error.message}`);
      scrapingError = error;
      return null;
    }
  }

  async handleInitialLoad(page, url) {
    config.smartLog('steps', `Handling initial page load`);
    
    await this.waitForRecruiteeWidget(page, url);
    await this.handleCookies(page);
    await randomDelay(800, 1200);
    
    config.smartLog('steps', `Initial load completed`);
  }

  async waitForRecruiteeWidget(page, url) {
    config.smartLog('platform', `Waiting for Recruitee widget to load`);
    
    const dict = this.getDictionary();
    const recruiteeIndicators = [
      '.RTWidget', '.recruitee-careers-widget', '.recruitee-job-list', 
      '[data-recruitee]', '[data-cy*="job"]', '[data-testid*="job"]'
    ];
    
    try {
      await page.waitForSelector(recruiteeIndicators.join(', '), { timeout: 4000 });
      config.smartLog('platform', `Recruitee widget detected`);
    } catch (error) {
      config.smartLog('platform', `No specific Recruitee widget found, proceeding with general detection`);
    }

    const jobSelectors = this.getJobListingSelectors();
    await page.waitForFunction(({ selectors }) => {
      return document.querySelectorAll(selectors.join(', ')).length > 0;
    }, { selectors: jobSelectors }, { timeout: 3000 }).catch(() => {
      config.smartLog('platform', `No job elements found initially`);
    });
    
    config.smartLog('platform', `Widget loading completed`);
  }

  getJobListingSelectors() {
    const dict = this.getDictionary();
    const platforms = dict.platforms || {};
    const universal = dict.universal || {};
    
    return [
      'a[href*="job"]', 'a[href*="position"]', 'a[href*="career"]',
      'a[href*="emploi"]', 'a[href*="poste"]', 'a[href*="stelle"]',
      '[data-testid*="job"]', '[data-cy*="job"]',
      '.job-item', '.position-item', '.career-item',
      ...(platforms.recruitee?.selectors?.jobListings || []),
      ...(universal.selectors?.jobs || [])
    ];
  }

  getCookieSelectors() {
    const dict = this.getDictionary();
    const universal = dict.universal || {};
    
    return [
      '[data-testid*="accept"]', '[data-testid*="cookie"]',
      '[data-cy*="accept"]', '[data-cy*="cookie"]',
      '#cookie-accept', '.cookie-accept', '.accept-cookies',
      '[aria-label*="accept"]', '[aria-label*="cookie"]',
      ...(universal.selectors?.cookies || [])
    ];
  }

  getCookieTextSelectors() {
    const dict = this.getDictionary();
    const patterns = dict.patterns || {};
    
    return [
      'accept', 'agree', 'ok', 'got it', 'understand',
      'accepter', 'dacord', 'compris', 'ok',
      'akzeptieren', 'verstanden', 'einverstanden',
      ...(patterns.cookies?.accept || [])
    ];
  }

  getShowMoreSelectors() {
    const dict = this.getDictionary();
    const universal = dict.universal || {};
    
    return [
      'button[data-testid*="load"]', 'button[data-testid*="more"]',
      'button[data-cy*="load"]', 'button[data-cy*="more"]',
      '[data-testid*="show-more"]', '[data-cy*="show-more"]',
      '.load-more', '.show-more', '.view-more',
      ...(universal.selectors?.showMore || [])
    ];
  }

  getShowMoreTextSelectors() {
    const dict = this.getDictionary();
    const patterns = dict.patterns || {};
    
    return [
      'show more', 'load more', 'view more', 'see more',
      'voir plus', 'charger plus', 'plus de',
      'mehr anzeigen', 'mehr laden', 'weitere',
      ...(patterns.showMore?.text || [])
    ];
  }

  getButtonPatterns() {
    const dict = this.getDictionary();
    return dict.patterns?.buttons || {
      positive: {
        generic: /show\s*more|load\s*more|view\s*more|voir\s*plus|plus|more/i
      }
    };
  }

  getJobTerms() {
    const dict = this.getDictionary();
    const patterns = dict.patterns || {};
    
    return [
      'job', 'position', 'career', 'vacancy', 'opening',
      'emploi', 'poste', 'carriere', 'offre',
      'stelle', 'position', 'karriere', 'job',
      ...(patterns.jobs?.terms || [])
    ];
  }

  async handleCookies(page) {
    try {
      const cookieSelectors = this.getCookieSelectors().slice(0, 8);
      const cookieTextSelectors = this.getCookieTextSelectors();
      
      const cookieHandled = await page.evaluate(({ selectors, textSelectors }) => {
        for (const selector of selectors) {
          try {
            const elements = document.querySelectorAll(selector);
            for (const element of elements) {
              if (element.offsetWidth > 0 && element.offsetHeight > 0) {
                element.click();
                return true;
              }
            }
          } catch (e) {
            continue;
          }
        }
        
        const acceptButtons = document.querySelectorAll('button, a');
        for (const button of acceptButtons) {
          const text = button.textContent?.toLowerCase() || '';
          if (textSelectors.some(textSel => text.includes(textSel.toLowerCase())) && text.length < 60) {
            button.click();
            return true;
          }
        }
        return false;
      }, { selectors: cookieSelectors, textSelectors: cookieTextSelectors });
      
      if (cookieHandled) {
        await randomDelay(1500, 2000);
        config.smartLog('platform', `Cookie banner handled`);
      }
    } catch (error) {
      config.smartLog('fail', `Cookie handling error: ${error.message}`);
    }
  }

  async handleRecruiteeContent(page, timeRemaining) {
    config.smartLog('steps', `*** STARTING UNIVERSAL CONTENT EXPANSION *** (${timeRemaining}ms remaining)`);
    
    await this.setupDOMObserver(page);
    
    const startTime = Date.now();
    const maxOperations = 12;
    let operationCount = 0;
    let lastJobCount = 0;
    let noChangeCount = 0;
    
    while (operationCount < maxOperations && noChangeCount < 3 && (Date.now() - startTime) < timeRemaining - 4000) {
      const currentJobCount = await this.countVisibleJobs(page);
      
      config.smartLog('steps', `Current job count: ${currentJobCount}`);
      
      if (currentJobCount === lastJobCount) {
        noChangeCount++;
        config.smartLog('retry', `No change count: ${noChangeCount}/3`);
      } else {
        noChangeCount = 0;
        lastJobCount = currentJobCount;
      }
      
      const expansionResult = await this.expandContent(page);
      
      if (!expansionResult.success && noChangeCount >= 2) {
        config.smartLog('steps', `No more changes detected, stopping expansion`);
        break;
      }
      
      operationCount++;
      await randomDelay(1500, 2000);
    }
    
    config.smartLog('steps', `*** CONTENT EXPANSION COMPLETED *** (${operationCount} operations, ${this.newJobsDetected} new jobs)`);
  }

  async setupDOMObserver(page) {
    const jobSelectors = this.getJobListingSelectors();
    
    await page.evaluate(({ selectors }) => {
      if (window.recruiteeObserver) {
        window.recruiteeObserver.disconnect();
      }
      
      window.recruiteeNewJobs = 0;
      
      window.recruiteeObserver = new MutationObserver(function(mutations) {
        mutations.forEach(function(mutation) {
          if (mutation.type === 'childList' && mutation.addedNodes.length > 0) {
            for (const node of mutation.addedNodes) {
              if (node.nodeType === 1) {
                const jobLinks = node.querySelectorAll ? 
                  node.querySelectorAll(selectors.join(', ')) : [];
                if (jobLinks.length > 0 || 
                    (node.tagName === 'A' && selectors.some(sel => node.matches(sel)))) {
                  window.recruiteeNewJobs++;
                }
              }
            }
          }
        });
      });
      
      window.recruiteeObserver.observe(document.body, {
        childList: true,
        subtree: true
      });
    }, { selectors: jobSelectors });
  }

  async countVisibleJobs(page) {
    const jobSelectors = this.getJobListingSelectors();
    
    return await page.evaluate(({ selectors }) => {
      return document.querySelectorAll(selectors.join(', ')).length;
    }, { selectors: jobSelectors });
  }

  async expandContent(page) {
    config.smartLog('steps', `*** UNIVERSAL SHOW MORE EXPANSION ***`);
    
    const initialJobCount = await this.countVisibleJobs(page);
    
    const showMoreSelectors = this.getShowMoreSelectors();
    const showMoreTextSelectors = this.getShowMoreTextSelectors();
    const buttonPatterns = this.getButtonPatterns();
    
    let positivePattern;
    try {
      positivePattern = buttonPatterns?.positive?.generic || 
                       buttonPatterns?.positive?.english || 
                       /show\s*more|load\s*more|view\s*more|voir\s*plus|plus|more/i;
    } catch (e) {
      positivePattern = /show\s*more|load\s*more|view\s*more|voir\s*plus|plus|more/i;
    }
    
    const showMoreButtons = await page.evaluate(({ selectors, textSelectors, pattern }) => {
      const buttons = [];
      
      for (const selector of selectors) {
        try {
          const elements = document.querySelectorAll(selector);
          for (const el of elements) {
            const rect = el.getBoundingClientRect();
            if (rect.width > 0 && rect.height > 0) {
              buttons.push({
                element: el,
                text: (el.textContent || '').trim().substring(0, 50),
                tagName: el.tagName,
                isButton: el.tagName === 'BUTTON',
                method: 'selector'
              });
            }
          }
        } catch (e) {
          continue;
        }
      }
      
      const allElements = document.querySelectorAll('*');
      for (const el of allElements) {
        const text = (el.textContent || '').trim();
        
        const regex = new RegExp(pattern, 'i');
        
        if (textSelectors.some(textSel => text.toLowerCase().includes(textSel.toLowerCase())) ||
            (text.length < 100 && text.length > 2 && regex.test(text.toLowerCase()))) {
          
          let clickableElement = null;
          
          if (el.tagName === 'BUTTON' || el.tagName === 'A' || el.getAttribute('role') === 'button') {
            clickableElement = el;
          } else {
            clickableElement = el.querySelector('button, a[role="button"], [role="button"]') || 
                             el.closest('button, a[role="button"], [role="button"]');
          }
          
          if (clickableElement) {
            const rect = clickableElement.getBoundingClientRect();
            if (rect.width > 0 && rect.height > 0) {
              const alreadyAdded = buttons.some(btn => btn.element === clickableElement);
              if (!alreadyAdded) {
                buttons.push({
                  element: clickableElement,
                  text: text.substring(0, 50),
                  tagName: clickableElement.tagName,
                  isButton: clickableElement.tagName === 'BUTTON',
                  method: 'text'
                });
              }
            }
          }
        }
      }
      
      return buttons.map(btn => ({
        text: btn.text,
        tagName: btn.tagName,
        isButton: btn.isButton,
        method: btn.method,
        xpath: getXPath(btn.element)
      }));
      
      function getXPath(element) {
        if (element.id) return `//*[@id="${element.id}"]`;
        if (element === document.body) return '/html/body';
        
        let ix = 0;
        const siblings = element.parentNode.childNodes;
        for (let i = 0; i < siblings.length; i++) {
          const sibling = siblings[i];
          if (sibling === element) {
            return getXPath(element.parentNode) + '/' + element.tagName.toLowerCase() + '[' + (ix + 1) + ']';
          }
          if (sibling.nodeType === 1 && sibling.tagName === element.tagName) {
            ix++;
          }
        }
      }
    }, { 
      selectors: showMoreSelectors, 
      textSelectors: showMoreTextSelectors, 
      pattern: positivePattern.source || 'show\\s*more|load\\s*more|view\\s*more|voir\\s*plus|plus|more'
    });
    
    config.smartLog('steps', `Found ${showMoreButtons.length} universal show more buttons`);
    
    for (const buttonInfo of showMoreButtons) {
      try {
        config.smartLog('steps', `*** CLICKING: "${buttonInfo.text}" (${buttonInfo.tagName}, ${buttonInfo.method}) ***`);
        
        const beforeCount = await page.evaluate(() => window.recruiteeNewJobs || 0);
        
        await page.evaluate(({ xpath }) => {
          const element = document.evaluate(xpath, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null).singleNodeValue;
          if (element) {
            element.scrollIntoView({ behavior: 'smooth', block: 'center' });
          }
        }, { xpath: buttonInfo.xpath });
        
        await randomDelay(800, 1200);
        
        const clicked = await page.evaluate(({ xpath }) => {
          const element = document.evaluate(xpath, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null).singleNodeValue;
          if (!element) return false;
          
          element.focus();
          
          const events = ['mouseover', 'mousedown', 'mouseup', 'click'];
          for (const eventType of events) {
            const event = new MouseEvent(eventType, { bubbles: true, cancelable: true });
            element.dispatchEvent(event);
          }
          
          if (typeof element.click === 'function') {
            element.click();
          }
          
          return true;
        }, { xpath: buttonInfo.xpath });
        
        if (clicked) {
          config.smartLog('steps', `Click executed, waiting for DOM changes...`);
          
          await page.waitForFunction(({ beforeCount }) => {
            return (window.recruiteeNewJobs || 0) > beforeCount;
          }, { beforeCount }, { timeout: 4000 }).catch(() => false);
          
          await randomDelay(1500, 2000);
          
          const afterCount = await page.evaluate(() => window.recruiteeNewJobs || 0);
          const newJobsThisClick = afterCount - beforeCount;
          
          if (newJobsThisClick > 0) {
            this.newJobsDetected += newJobsThisClick;
            config.smartLog('win', `*** SUCCESS: ${newJobsThisClick} new jobs revealed ***`);
            return { success: true, newJobs: newJobsThisClick };
          }
        }
        
      } catch (error) {
        config.smartLog('fail', `Button click failed: ${error.message}`);
        continue;
      }
    }
    
    const finalJobCount = await this.countVisibleJobs(page);
    if (finalJobCount > initialJobCount) {
      const newJobs = finalJobCount - initialJobCount;
      this.newJobsDetected += newJobs;
      config.smartLog('win', `*** FALLBACK SUCCESS: ${newJobs} jobs appeared ***`);
      return { success: true, newJobs: newJobs };
    }
    
    config.smartLog('fail', `No content expansion achieved`);
    return { success: false, reason: 'No buttons successfully expanded content' };
  }

  isResultValid(result) {
    if (!super.isResultValid(result)) return false;
    
    const textLower = result.text.toLowerCase();
    const jobTerms = this.getJobTerms();
    const hasJobTerms = jobTerms.some(term => textLower.includes(term.toLowerCase()));
    const hasRecruiteeIndicators = textLower.includes('recruitee') ||
                                  textLower.includes('job') ||
                                  textLower.includes('career') ||
                                  textLower.includes('position');
    
    return result.text.length >= 300 && 
           result.links.length >= 5 && 
           (hasJobTerms || hasRecruiteeIndicators);
  }
}

module.exports = RecruiteeStep;